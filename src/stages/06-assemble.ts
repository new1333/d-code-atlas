// stages/06-assemble.ts：Stage 6 · Assemble（站点组装）。
// 对应 design §4 Stage 6（Assemble）、§11（站点组装与侧边栏算法 ADR-0006）、
// §15（错误处理：失败保留 site/）、硬约束 #5（site 自包含）、硬约束 #3（按 topoOrder 编号）。
//
// 流程：
//   读 outline（含 topoOrder）→ 标 stage running + save →
//   ① 先调 Synthesizer 产全书导读（可选产物：失败不阻断，记 stderr 继续）；
//     成功则原子落盘 work/prologue/draft.md →
//   ② 调 assembler（Assembler 自己落盘 site/：guide/{nn}-{slug}.md、.vitepress/config.ts、
//     index.md、package.json；若 work/prologue/draft.md 存在，额外搬 site/guide/00-prologue.md）→
//   校验 site 结构完整性（缺关键文件 → stage failed，但保留已生成的 site/）→
//   成功 → setStage done + save + return。
//
// 不改章节内容（硬约束 #5 / ADR-0006）：
//   Assembler 已遵守「搬运逐字复制」；stage 不二次修改 draft 内容。
//   stage 只读 site/ 做存在性校验，不重写任何文件。
//
// 校验项（design §11 + ADR-0006）：
//   - site/ 目录存在；
//   - site/guide/ 下有按 topoOrder 编号的文件（每个 slug 对应 {nn}-{slug}.md）；
//   - site/.vitepress/config.ts 存在；
//   - site/index.md 存在；
//   - site/package.json 存在（build stage 依赖）。
//   缺任一关键文件 → stage failed（保留 site/，design §15）。

import { assembler } from "../agents/assembler.ts";
import { synthesizer } from "../agents/synthesizer.ts";
import {
  siteDir,
  outlinePath,
  readJson,
  pathExists,
  joinPath,
  writeText,
  prologuePath,
  ensureDir,
} from "../lib/io.ts";
import { setStageStatus, saveManifest } from "../lib/manifest.ts";
import type { Outline, Chapter } from "../lib/types.ts";
import type { StageContext, StageResult } from "./types.ts";

/**
 * 把 topo 序号（0-based）转成两位补零的文件名前缀（如 0→"01"，11→"12"）。
 * 与 Assembler prompt 约定一致：(i+1).toString().padStart(2,"0")。
 */
function nn(i: number): string {
  return (i + 1).toString().padStart(2, "0");
}

/**
 * 由 outline 的 dependsOn + topoOrder 程序化生成 mermaid 脉络图。
 * 脉络图是依赖图的确定性投影，不需要 LLM 推理——程序化生成保证 100% 忠于 outline，
 * 杜绝 LLM 末尾截断导致空壳（audit 2026-08-04：mitt 曾出现「标题+引言在、图没生成」过闸上线）。
 */
function generateMermaidGraph(outline: Outline): string {
  const bySlug = new Map<string, Chapter>();
  for (const c of outline.chapters) bySlug.set(c.slug, c);
  // mermaid 节点 id 仅允许字母/数字/下划线；slug 含连字符，统一替换。
  const idOf = (slug: string) => slug.replace(/[^a-zA-Z0-9]/g, "_");
  const layerTitle: Record<string, string> = {
    primitive: "原子层 primitive",
    composite: "复合层 composite",
    system: "系统层 system",
  };
  const lines: string[] = ["```mermaid", "graph TD"];
  for (const layer of ["primitive", "composite", "system"]) {
    const inLayer = (outline.topoOrder ?? []).filter(
      (s) => bySlug.get(s)?.layer === layer,
    );
    if (inLayer.length === 0) continue;
    lines.push(`  subgraph ${layerTitle[layer]}`);
    for (const slug of inLayer) {
      const c = bySlug.get(slug);
      if (!c) continue;
      lines.push(`    ${idOf(slug)}["${c.title}"]`);
    }
    lines.push("  end");
  }
  // 依赖边：每章的 dependsOn 指向更底层章（ADR-0003 自底向上）。
  for (const slug of outline.topoOrder ?? []) {
    const c = bySlug.get(slug);
    if (!c) continue;
    for (const dep of c.dependsOn) {
      if (!bySlug.has(dep)) continue; // 悬空依赖跳过（outline stage 本应已校验）
      lines.push(`  ${idOf(dep)} --> ${idOf(slug)}`);
    }
  }
  lines.push("```");
  return lines.join("\n");
}

/**
 * 确保 prologue 含一个有效的脉络图块：若 LLM 未画或只留空壳，用程序化 mermaid 补/换。
 * LLM 已画 mermaid 则尊重其产物；否则程序化生成（始终忠实于 outline.dependsOn）。
 */
function ensurePrologueGraph(prologueMd: string, outline: Outline): string {
  const graph = generateMermaidGraph(outline);
  const headerIdx = prologueMd.search(/##\s*全书脉络图/);
  // 无脉络图标题：补完整块（标题 + 说明 + 图）。
  if (headerIdx < 0) {
    const block =
      "## 全书脉络图\n\n" +
      "下图由 outline 的 `dependsOn` + `topoOrder` 程序化生成，与依赖图完全一致" +
      "（箭头方向：前置 → 后继）。\n\n" +
      `${graph}\n`;
    return prologueMd.replace(/\s+$/, "") + "\n\n" + block;
  }
  // 有标题：检查 Synthesizer 是否已画 mermaid。
  const afterHeader = prologueMd.slice(headerIdx);
  if (/```mermaid/.test(afterHeader)) {
    return prologueMd; // 已有 mermaid（Synthesizer 自画），尊重之。
  }
  // 有标题但无 mermaid：Synthesizer 按新契约只写了引言、没画图。
  // 保留其引言，仅在末尾追加程序化 mermaid（脉络图是第四块即末块，追加在其后自然衔接）。
  const graphNote =
    "下图由 outline 的 `dependsOn` + `topoOrder` 程序化生成（箭头方向：前置 → 后继）：\n\n";
  return prologueMd.replace(/\s+$/, "") + "\n\n" + graphNote + graph + "\n";
}

/**
 * mermaid 渲染主题入口固定模板（vitepress-mermaid-renderer）。
 * Assembler 应已按 prompt 生成同等内容；若 LLM 漏生成，用本模板兜底补写，
 * 保证导读页的全书脉络图能渲染（否则 mermaid 块显示为源码）。
 */
const MERMAID_THEME_TS = `import { h, nextTick, watch } from "vue";
import type { Theme } from "vitepress";
import DefaultTheme from "vitepress/theme";
import { useData } from "vitepress";
import { createMermaidRenderer } from "vitepress-mermaid-renderer";

export default {
  extends: DefaultTheme,
  Layout: () => {
    const { isDark } = useData();

    const initMermaid = () => {
      createMermaidRenderer({
        theme: isDark.value ? "dark" : "default",
      });
    };

    nextTick(() => initMermaid());
    watch(
      () => isDark.value,
      () => initMermaid(),
    );

    return h(DefaultTheme.Layout);
  },
} satisfies Theme;
`;

/**
 * 若 site/.vitepress/theme/index.ts 不存在（Assembler 漏生成），程序化补写一份。
 * 与 ensurePrologueGraph 同思路：双保险，保证不阻断 build。
 */
async function ensureMermaidTheme(site: string): Promise<void> {
  const themeTs = joinPath(site, ".vitepress/theme/index.ts");
  if (await pathExists(themeTs)) return;
  // ensureDir 仅创建 theme 目录；写入固定模板。
  await ensureDir(joinPath(site, ".vitepress/theme/"));
  await writeText(themeTs, MERMAID_THEME_TS);
}

/**
 * Assemble stage：调 Assembler 组装 site/，校验站点结构完整性。
 *
 * @returns 更新后的 manifest（已 saveManifest）。
 *          成功 → stages.assemble.status=done；失败 → failed（保留 site/）。
 */
export async function assemble(ctx: StageContext): Promise<StageResult> {
  const { key, manifest, spawn, model } = ctx;

  // 读 outline（含 topoOrder）——校验 site 文件编号要用。
  let outline: Outline;
  try {
    outline = await readJson<Outline>(outlinePath(key));
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    const failed = setStageStatus(manifest, "assemble", "failed", {
      cmd: `(assemble 读 outline 失败) ${msg}`,
      error: msg,
    });
    await saveManifest(key, failed);
    return failed;
  }

  // 标 stage running + save。
  let m = setStageStatus(manifest, "assemble", "running");
  await saveManifest(key, m);

  // 0) 先调 Synthesizer 产全书导读（可选产物）。
  // 导读是锦上添花——失败不阻断搬运：site 仍可构建（只是缺 00-导读），章节正文才是主体。
  // 成功则原子落盘到 work/prologue/draft.md，供 Assembler 搬运为 site/guide/00-prologue.md。
  let prologueOk = false;
  try {
    const syn = await synthesizer({ key, model, spawn });
    if (syn.ok && syn.prologueMd) {
      // 用程序化 mermaid 兜底脉络图（防 LLM 末尾截断空壳），再落盘。
      const withGraph = ensurePrologueGraph(syn.prologueMd, outline);
      await writeText(prologuePath(key), withGraph);
      prologueOk = true;
    } else {
      // 导读失败：记 stderr 到 manifest（不改 stage status，继续搬运）。
      m = setStageStatus(m, "assemble", "running", {
        cmd: syn.cmd,
        stderr: `(导读生成失败，已跳过) ${syn.stderr || ""}`.slice(0, 500),
      });
      await saveManifest(key, m);
    }
  } catch (err) {
    // synthesizer 异常（非预期）：同样不阻断，记 stderr 继续。
    const msg = (err as Error).message ?? String(err);
    m = setStageStatus(m, "assemble", "running", {
      stderr: `(导读生成异常，已跳过) ${msg}`.slice(0, 500),
    });
    await saveManifest(key, m);
  }

  // 调 Assembler（自己落盘 site/）。
  const outcome = await assembler({ key, model, spawn });

  if (!outcome.ok) {
    // Assembler 失败 → stage failed（保留已生成的 site/，design §15）。
    const failed = setStageStatus(m, "assemble", "failed", {
      cmd: outcome.cmd,
      exitCode: outcome.exitCode,
      stderr: outcome.stderr,
    });
    await saveManifest(key, failed);
    return failed;
  }

  const site = siteDir(key);

  // 兜底：若 Assembler 漏生成 .vitepress/theme/index.ts（启用 mermaid 渲染），程序化补写。
  // （与 ensurePrologueGraph 同思路：双保险，防 LLM 偶发漏文件导致脉络图显示为源码。）
  await ensureMermaidTheme(site);

  // ---- 校验 site 结构完整性 ----
  const errors: string[] = [];

  // 1) site/ 目录存在。
  if (!(await pathExists(site))) {
    errors.push(`site/ 目录不存在: ${site}`);
  } else {
    // 2) 关键脚手架文件存在。
    const configTs = joinPath(site, ".vitepress/config.ts");
    const indexMd = joinPath(site, "index.md");
    const pkgJson = joinPath(site, "package.json");
    const themeTs = joinPath(site, ".vitepress/theme/index.ts");
    if (!(await pathExists(configTs))) errors.push(`缺 ${configTs}`);
    if (!(await pathExists(indexMd))) errors.push(`缺 ${indexMd}`);
    if (!(await pathExists(pkgJson))) errors.push(`缺 ${pkgJson}`);
    // theme/index.ts 启用 mermaid 渲染（全书脉络图依赖）；ensureMermaidTheme 已兜底补写，
    // 此处为不变量断言（兜底写盘异常时能捕获）。
    if (!(await pathExists(themeTs))) errors.push(`缺 ${themeTs}`);

    // 3) guide/ 下按 topoOrder 编号的文件齐全。
    const guideDir = joinPath(site, "guide/");
    const topoOrder = outline.topoOrder ?? [];
    for (let i = 0; i < topoOrder.length; i++) {
      const slug = topoOrder[i];
      const expected = joinPath(guideDir, `${nn(i)}-${slug}.md`);
      if (!(await pathExists(expected))) {
        errors.push(`缺 guide 文件: ${expected}`);
      }
    }

    // 3.5) 若导读生成成功（work/prologue/draft.md 已落盘），校验 00-prologue.md 已搬运。
    if (prologueOk) {
      const expectedPrologue = joinPath(guideDir, "00-prologue.md");
      if (!(await pathExists(expectedPrologue))) {
        errors.push(`缺 guide 文件（导读）: ${expectedPrologue}`);
      }
    }
  }

  if (errors.length > 0) {
    // 校验失败 → stage failed（保留 site/）。
    const joined = errors.join("; ").slice(-500);
    const failed = setStageStatus(m, "assemble", "failed", {
      cmd: `(assemble 结构校验失败) ${joined}`,
      error: joined,
    });
    await saveManifest(key, failed);
    return failed;
  }

  // CAS：site 结构校验通过后才置 done。
  // （site/ 已由 Assembler 落盘，stage 不再写额外产物文件。）
  m = setStageStatus(m, "assemble", "done", {
    cmd: outcome.cmd,
    // 导读缺失属非致命警告（章节正文完整）：显式记到 error，让 atlas show 醒目可见。
    // running 态记的 stderr 因 applyStatus 修复也已保留；此处 error 作为一句话摘要。
    ...(prologueOk
      ? {}
      : {
          error:
            "导读(prologue)未生成——章节正文完整，但缺全书导读入口页；可重跑 assemble 补齐",
        }),
  });
  await saveManifest(key, m);
  return m;
}

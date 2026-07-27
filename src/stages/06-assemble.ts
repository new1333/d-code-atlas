// stages/06-assemble.ts：Stage 6 · Assemble（站点组装）。
// 对应 design §4 Stage 6（Assemble）、§11（站点组装与侧边栏算法 ADR-0006）、
// §15（错误处理：失败保留 site/）、硬约束 #5（site 自包含）、硬约束 #3（按 topoOrder 编号）。
//
// 流程：
//   读 outline（含 topoOrder）→ 标 stage running + save →
//   调 assembler（Assembler 自己落盘 site/：guide/{nn}-{slug}.md、.vitepress/config.ts、
//     index.md、package.json）→
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
import {
  siteDir,
  outlinePath,
  readJson,
  pathExists,
  joinPath,
} from "../lib/io.ts";
import { setStageStatus, saveManifest } from "../lib/manifest.ts";
import type { Outline } from "../lib/types.ts";
import type { StageContext, StageResult } from "./types.ts";

/**
 * 把 topo 序号（0-based）转成两位补零的文件名前缀（如 0→"01"，11→"12"）。
 * 与 Assembler prompt 约定一致：(i+1).toString().padStart(2,"0")。
 */
function nn(i: number): string {
  return (i + 1).toString().padStart(2, "0");
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
    const failed = setStageStatus(manifest, "assemble", "failed", {
      cmd: `(assemble 读 outline 失败) ${(err as Error).message}`,
    });
    await saveManifest(key, failed);
    return failed;
  }

  // 标 stage running + save。
  let m = setStageStatus(manifest, "assemble", "running");
  await saveManifest(key, m);

  // 调 Assembler（自己落盘 site/）。
  const outcome = await assembler({ key, model, spawn });

  if (!outcome.ok) {
    // Assembler 失败 → stage failed（保留已生成的 site/，design §15）。
    const failed = setStageStatus(m, "assemble", "failed", { cmd: outcome.cmd });
    await saveManifest(key, failed);
    return failed;
  }

  // ---- 校验 site 结构完整性 ----
  const site = siteDir(key);
  const errors: string[] = [];

  // 1) site/ 目录存在。
  if (!(await pathExists(site))) {
    errors.push(`site/ 目录不存在: ${site}`);
  } else {
    // 2) 关键脚手架文件存在。
    const configTs = joinPath(site, ".vitepress/config.ts");
    const indexMd = joinPath(site, "index.md");
    const pkgJson = joinPath(site, "package.json");
    if (!(await pathExists(configTs))) errors.push(`缺 ${configTs}`);
    if (!(await pathExists(indexMd))) errors.push(`缺 ${indexMd}`);
    if (!(await pathExists(pkgJson))) errors.push(`缺 ${pkgJson}`);

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
  }

  if (errors.length > 0) {
    // 校验失败 → stage failed（保留 site/）。
    const failed = setStageStatus(m, "assemble", "failed", {
      cmd: `(assemble 结构校验失败) ${errors.join("; ").slice(-500)}`,
    });
    await saveManifest(key, failed);
    return failed;
  }

  // CAS：site 结构校验通过后才置 done。
  // （site/ 已由 Assembler 落盘，stage 不再写额外产物文件。）
  m = setStageStatus(m, "assemble", "done", { cmd: outcome.cmd });
  await saveManifest(key, m);
  return m;
}

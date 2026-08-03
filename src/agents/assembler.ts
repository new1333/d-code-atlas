// agents/assembler.ts：Assembler（站点组装员）的 agent 封装。
// 对应 design §4 Stage 6（Assemble）、§11（站点组装与侧边栏算法）、
// ADR-0006（site 自包含）、FR-7（站点独立部署）、AC-7。
//
// 契约（design §5 / §10 / §11 / AC-7）：
//   - tools = "write"（Read/Glob/Grep + Write/Edit）：Assembler 自己用 Write/Edit 落盘。
//   - **cwd 取舍**：cwd = runDir(key)（`atlas/{key}/`），**不是** siteDir。
//     原因：Assembler 需要跨读 work/outline.json（含 topoOrder）+ 各
//     work/chapters/{slug}/draft.md，还要写 site/。site/ 在 work/ 之外。
//     决策：cwd = runDir，user prompt 用相对路径 `work/outline.json`、
//     `work/chapters/{slug}/draft.md`，写范围 `site/`（明示「只能写 site/，
//     禁止改 work/」）。AC-7 不核验 Assembler 的 cwd，只核验分析类工具集。
//   - **自己落盘** site/（VitePress 工程），Stage 后续校验站点结构 + build。
//
// 关键（ADR-0006 + design §11）：Assembler 严格按 outline 的 **topoOrder** 编号文件、
// 按 layer 分组侧边栏。为避免 Assembler 自行解析 outline 出错，agent 层先
// readJson(outlinePath) 读出 outline，把 {topoOrder, chapters:[{slug,layer,title}]}
// 序列化进 user prompt，让 Assembler 直接用（保证严格遵循 topoOrder）。

import { runClaude } from "../lib/run-claude.ts";
import { runDir, outlinePath, readJson, siteDir, joinPath } from "../lib/io.ts";
import { existsSync } from "node:fs";
import type { Outline } from "../lib/types.ts";
import { promptPath, type AgentOutcome, type AgentCommonOpts } from "./types.ts";

/** Assembler 入参。 */
export interface AssemblerOpts extends AgentCommonOpts {
  /** Run key（决定 runDir）。 */
  key: string;
}

/** Assembler 返回：通用 AgentOutcome（产物在磁盘 site/，无额外字段）。 */
export interface AssemblerOutcome extends AgentOutcome {}

/**
 * 调起 Assembler agent：把各章 draft 搬到 site/，生成 VitePress 工程脚手架。
 *
 * 流程：readJson(outline) 读出 outline → 拼 user prompt（嵌入 topoOrder + 章节
 * slug/layer/title）→ runClaude（write, cwd=runDir）→ 返回通用 outcome。
 * 产物（site/）由 Assembler 自己用 Write/Edit 落盘；Stage 后续校验 + build。
 * 返回 cmd 供 manifest 记录。
 *
 * 若 outline.json 不存在或解析失败，直接返回 ok=false（不调 claude）。
 */
export async function assembler(opts: AssemblerOpts): Promise<AssemblerOutcome> {
  const { key, model, spawn } = opts;

  const cwd = runDir(key);
  const systemPromptPath = promptPath("assembler");

  // 先读 outline.json（含 stage 注入的 topoOrder）。
  // 失败（文件不存在/解析失败）直接返回失败，不调 claude（省钱、可诊断）。
  let outline: Outline;
  try {
    outline = await readJson<Outline>(outlinePath(key));
  } catch (err) {
    return {
      ok: false,
      cmd: "",
      stdout: "",
      stderr: `assembler: 读取 outline.json 失败: ${(err as Error).message}`,
      exitCode: -1,
    };
  }

  // 校验 outline 必要字段：topoOrder 必须存在（stage 已注入）。
  if (!Array.isArray(outline.chapters) || !Array.isArray(outline.topoOrder)) {
    return {
      ok: false,
      cmd: "",
      stdout: "",
      stderr:
        "assembler: outline.json 缺少 chapters[] 或 topoOrder[]（topoOrder 应由 stage 注入）",
      exitCode: -1,
    };
  }

  // 把 Assembler 需要的元数据序列化进 user prompt（slug/layer/title + topoOrder）。
  // 这样 Assembler 不必自己解析 outline，也保证严格用 topoOrder（ADR-0006）。
  const chapterMeta = outline.chapters.map((c) => ({
    slug: c.slug,
    layer: c.layer,
    title: c.title,
  }));
  const outlineDigest = JSON.stringify(
    { topoOrder: outline.topoOrder, chapters: chapterMeta },
    null,
    2,
  );

  const prompt = [
    "你是 Assembler（站点组装员）。请把各章 draft 搬到 site/，生成自包含的 VitePress 工程。",
    "",
    "## ⚠️ 产出方式（最重要，违反则本次作废）",
    "你必须**调用 Write 工具**创建 site/ 下的所有文件（package.json、.vitepress/config.ts、index.md、各章 .md 等）。",
    "**不要把文件内容输出到 stdout/最终回复**——stdout 只用于简短确认（如「site/ 已组装完成」）。",
    "如果你只把内容回复给我而不调用 Write 工具，文件不会被创建，本次任务作废。",
    "",
    "## 本次输入",
    `- Run key: ${key}`,
    `- cwd: ${cwd}（即 atlas/${key}/；下面的相对路径都基于此 cwd）`,
    "",
    "## 读取范围（相对 cwd）",
    "- work/outline.json：含 chapters[] + topoOrder[]（topoOrder 已由 stage 注入，你直接读用）。",
    "- work/chapters/{slug}/draft.md：各章正文（待搬运）。",
    "- work/repo-map.json：站名/简介可参考仓库信息（可选）。",
    "",
    "## 写入范围（严格限定）",
    "**只能写** `site/`（即 atlas/" + key + "/site/ 下一切文件）。",
    "**严禁**改 work/ 下任何文件（draft.md/outline.json/replica 等）、**严禁**写 source/。",
    "搬运 draft → site/guide/{nn}-{slug}.md 时**逐字复制**，不改正文一个字（ADR-0006）。",
    "",
    "## 大纲元数据（已为你预读，**严格按此**组装，不要自行重排）",
    "```json",
    outlineDigest,
    "```",
    "",
    "## 任务",
    "1. 对 topoOrder 中每个 slug：取其 topo 序号 i（从 0 起），nn = (i+1).toString().padStart(2,'0')。",
    "   把 work/chapters/{slug}/draft.md **逐字复制**为 site/guide/{nn}-{slug}.md（可在顶部加 frontmatter）。",
    "2. 生成 site/.vitepress/config.ts：",
    "   a) themeConfig 必须含 `search: { provider: 'local' }`（启用 VitePress 内置本地搜索，",
    "      基于内置 MiniSearch，零外部服务零额外依赖，符合 ADR-0006 自包含）。**缺失 search 则站点无搜索框**。",
    "   b) 侧边栏按 layer 分组（primitive→composite→system，",
    "      分组标题用中文：核心原语/组合机制/应用集成），组内按 topoOrder 顺序；每项",
    "      { text: <title>, link: '/guide/{nn}-{slug}' }。用**字符串模板**生成，数据硬编码",
    "      （不要运行时 import outline.json，保持 site 自包含——ADR-0006）。",
    "3. 生成 site/index.md（首页：站名/简介/快速开始）。",
    "4. 生成 site/package.json：{ \"type\":\"module\", devDependencies pin vitepress，",
    "   scripts 含 docs:dev/docs:build/docs:preview }。",
    "",
    "## 自检（交付前对照 design §11 / ADR-0006）",
    "  ① 搬运完整：topoOrder 每个 slug 都有对应 site/guide/{nn}-{slug}.md，正文逐字一致。",
    "  ② 编号正确：nn 严格等于 (topoIndex+1) 两位补零。",
    "  ③ 侧边栏正确：按 primitive→composite→system 分组（核心原语/组合机制/应用集成），组内按 topoOrder。",
    "  ④ 工程可构建：package.json 含 vitepress + docs:build 脚本，type:module。",
    "     config.ts 的 themeConfig 含 `search: { provider: 'local' }`（本地搜索框）。",
    "  ⑤ 自包含：site/ 不 import 引擎仓库；config.ts 不 import outline.json。",
    "  ⑥ 未越界：未改任何 draft.md 内容、未写 work/、未写 source/。",
  ].join("\n");

  // site/ 关键产物路径（validate 与兜底核验共用）。
  const site = siteDir(key);
  const scaffoldFiles = [
    joinPath(site, "package.json"),
    joinPath(site, "index.md"),
    joinPath(site, ".vitepress/config.ts"),
  ];

  // validate：claude headless「假成功」治理（治本）。
  // Assembler 的产物在磁盘（不是 stdout），Claude 正常退出（exitCode=0）却没调 Write 工具时，
  // site/ 根本不会被创建——这正是 pinia run assemble failed 的根因。
  // 这里在每次 spawn 尝试后**同步检查关键脚手架文件是否落盘**；缺失即让 runClaude 重试，
  // 重试用尽后 runClaude.ok 会因 validated=false 返回 false（而非历史假成功 true）。
  const validateScaffold = (): boolean => {
    for (const f of scaffoldFiles) {
      if (!existsSync(f)) return false;
    }
    return true;
  };

  const result = await runClaude({
    prompt,
    systemPromptPath,
    cwd,
    tools: "write",
    model,
    spawn,
    // assembler 生成整个 site 骨架（VitePress 配置 + 侧边栏 + 首页），耗时较长；给 25 分钟 + 多重试。
    timeoutMs: 25 * 60 * 1000,
    retries: 3,
    // validate：忽略 stdout（site/ 落盘 claude 只回简短确认），只看磁盘关键文件是否齐备。
    validate: () => validateScaffold(),
  });

  // 双保险兜底：即便 runClaude 已用 validate 判过，最终再核验一次磁盘最终态。
  // （理论冗余：runClaude.ok 已含 validated；此处显式再校一遍，让 return 的 ok
  //   完全立足于磁盘真相，并给出精确缺失清单写入 stderr，便于 manifest 诊断。）
  if (result.ok) {
    const missing = scaffoldFiles.filter((f) => !existsSync(f));
    if (missing.length > 0) {
      return {
        ok: false,
        cmd: result.cmd,
        stdout: result.stdout,
        stderr: `assembler: claude 声称完成但 site/ 关键文件缺失: ${missing.join(", ")}`,
        exitCode: result.exitCode,
      };
    }
  }

  return {
    ok: result.ok,
    cmd: result.cmd,
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
  };
}

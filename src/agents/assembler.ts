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
import { runDir, outlinePath, readJson } from "../lib/io.ts";
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
    "2. 生成 site/.vitepress/config.ts：侧边栏按 layer 分组（primitive→composite→system，",
    "   分组标题用中文：原子层/复合层/系统层），组内按 topoOrder 顺序；每项",
    "   { text: <title>, link: '/guide/{nn}-{slug}' }。用**字符串模板**生成，数据硬编码",
    "   （不要运行时 import outline.json，保持 site 自包含——ADR-0006）。",
    "3. 生成 site/index.md（首页：站名/简介/快速开始）。",
    "4. 生成 site/package.json：{ \"type\":\"module\", devDependencies pin vitepress，",
    "   scripts 含 docs:dev/docs:build/docs:preview }。",
    "",
    "## 自检（交付前对照 design §11 / ADR-0006）",
    "  ① 搬运完整：topoOrder 每个 slug 都有对应 site/guide/{nn}-{slug}.md，正文逐字一致。",
    "  ② 编号正确：nn 严格等于 (topoIndex+1) 两位补零。",
    "  ③ 侧边栏正确：按 primitive→composite→system 分组，组内按 topoOrder。",
    "  ④ 工程可构建：package.json 含 vitepress + docs:build 脚本，type:module。",
    "  ⑤ 自包含：site/ 不 import 引擎仓库；config.ts 不 import outline.json。",
    "  ⑥ 未越界：未改任何 draft.md 内容、未写 work/、未写 source/。",
  ].join("\n");

  const result = await runClaude({
    prompt,
    systemPromptPath,
    cwd,
    tools: "write",
    model,
    spawn,
  });

  return {
    ok: result.ok,
    cmd: result.cmd,
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
  };
}

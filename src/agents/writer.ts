// agents/writer.ts：Writer（章节撰写员）的 agent 封装。
// 对应 design §4 Stage 5（Write）、§5（输出要点）、§8.3/§8.4（章节产物）、
// §7/ADR-0003（自底向上）、AC-5（复刻一致）、ADR-0006（replica 可独立运行）。
//
// 契约（design §5 / §10 / AC-7）：
//   - tools = "write"（Read/Glob/Grep + Write/Edit）：Writer 自己用 Write/Edit 落盘。
//   - **cwd 取舍**：cwd = workDir(key)（`atlas/{key}/work/`），**不是** chapterDir。
//     原因：Writer 需要跨读 work/outline.json（取全部章节 + 本章依赖）与
//     work/chapters/{slug}/research.md（Reader 事实摘录），还要写
//     work/chapters/{slug}/draft.md + replica/。若 cwd 限定在 chapterDir，物理上
//     读不到 outline.json（在 chapterDir 之外）。
//     决策：cwd = workDir，user prompt 明确「**只能写** chapters/{slug}/ 下，
//     **禁止**改 outline.json/repo-map.json/其它章节/site/」。写范围靠 prompt 约束 +
//     tools 白名单（AC-7 不核验 Writer 的 cwd，只核验分析类工具集）。
//   - **自己落盘** draft.md + replica/（产物在磁盘），Stage 后续校验存在性。
//
// 注：相对 cwd（work/）的路径用 `chapters/{slug}/...`、`outline.json`。

import { runClaude } from "../lib/run-claude.ts";
import { workDir } from "../lib/io.ts";
import { promptPath, type AgentOutcome, type AgentCommonOpts } from "./types.ts";

/** Writer 入参。 */
export interface WriterOpts extends AgentCommonOpts {
  /** Run key（决定 workDir）。 */
  key: string;
  /** 本章 slug（写作对象）。 */
  slug: string;
}

/** Writer 返回：通用 AgentOutcome（产物在磁盘，无额外字段）。 */
export interface WriterOutcome extends AgentOutcome {}

/**
 * 调起 Writer agent：基于 research.md + outline 写一章 draft.md + replica/。
 *
 * 流程：拼 user prompt → runClaude（write, cwd=workDir）→ 返回通用 outcome。
 * 产物（draft.md/replica/）由 Writer 自己用 Write/Edit 落盘；Stage 后续校验存在性。
 * 返回 cmd 供 manifest 记录。
 */
export async function writer(opts: WriterOpts): Promise<WriterOutcome> {
  const { key, slug, model, spawn } = opts;

  const cwd = workDir(key);
  const systemPromptPath = promptPath("writer");

  const prompt = [
    "你是 Writer（章节撰写员）。请基于 Reader 的事实摘录和 outline 依赖结构，撰写一章中文文档。",
    "",
    "## 本次输入",
    `- Run key: ${key}`,
    `- 本章 slug: ${slug}`,
    `- cwd: ${cwd}（即 atlas/${key}/work/；下面的相对路径都基于此 cwd）`,
    "",
    "## 读取范围（相对 cwd）",
    "- outline.json：含本章 slug/title/summary/layer/dependsOn/sourceFiles，及全部其它章节（供了解前置章节讲了什么）。",
    `- chapters/${slug}/research.md：Reader 的事实摘录，是你写正文的**主要依据**。`,
    "- 源码（核对技术准确性时用）：",
    "  · git 克隆场景：source/（相对 cwd）。",
    "  · 本地源场景：见 repo-map.json 的 root 字段（绝对路径，只读）。",
    "",
    "## 写入范围（严格限定）",
    `**只能写** \`chapters/${slug}/\` 下（即 \`chapters/${slug}/draft.md\` 与 \`chapters/${slug}/replica/*\`）。`,
    "**严禁**改 outline.json / repo-map.json / 其它章节目录 / source/ / site/。",
    "源仓库只读（ADR-0005、NFR-2）。",
    "",
    "## 任务",
    `1. 写 \`chapters/${slug}/draft.md\`：自底向上衔接前文（用到的前置概念必须在 dependsOn 章节已讲过）。`,
    "   - markdown 格式（**不要**用 ```json 包裹正文）。",
    "   - 关键机制配文字流程图（A → B → C）、步骤、输入输出示例，**不写流水账**。",
    `2. 写 \`chapters/${slug}/replica/\`：把 draft 内嵌的复刻代码**逐字同步**存成独立文件，`,
    "   配最小脚手架（package.json 等），使 \`cd replica && bun install && bun run <entry>\` 能直接跑（ADR-0006）。",
    "3. **复刻一致性是硬约束（AC-5）**：draft 内嵌代码块与 replica/ 对应文件**逐字一致**，改一处两边同步。",
    "",
    "## 自检（交付前逐条对照 Critic·Chapter 4 条标准）",
    "  ① 准确：技术陈述与 Source 一致（参考 research.md 的 `源码位置:` 标注）。",
    "  ② 衔接：用到的前置概念确实在 dependsOn 章节已讲解。",
    "  ③ 可运行：内嵌复刻与 replica/ 逐字一致、replica 能独立 bun run。",
    "  ④ 清晰：有图示/步骤/输入输出，不是流水账。",
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

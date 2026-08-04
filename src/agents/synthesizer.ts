// agents/synthesizer.ts：Synthesizer（导读作者）的 agent 封装。
// 对应 design §4 Stage 6（Assemble）前置子流程、ADR-0005（源只读）、AC-7。
//
// 契约（design §5 / AC-7）：
//   - tools = "readonly"（绝不 write）。
//   - cwd = runDir(key)（`atlas/{key}/`）：相对 cwd 读 work/outline.json + work/chapters/*/draft.md。
//   - **不落盘** prologue/draft.md——Synthesizer 把 markdown 内容以 ```markdown fence 作 stdout
//     返回；本 agent 用 extractFence(stdout, "markdown") 提取后 return；
//     由 Stage（06-assemble）原子落盘到 work/prologue/draft.md。
//
// 调用时机：所有章节 Write 完成后、Assembler 搬运之前。Synthesizer 通读全部 draft.md，
// 产出全书级导读（一句话主线 + 两条阅读路线 + 核心原理清单 + 脉络图）。

import { runClaude } from "../lib/run-claude.ts";
import { runDir } from "../lib/io.ts";
import { extractFence } from "../lib/extract.ts";
import { promptPath, type AgentOutcome, type AgentCommonOpts } from "./types.ts";

/** Synthesizer 入参。 */
export interface SynthesizerOpts extends AgentCommonOpts {
  /** Run key（决定 runDir）。 */
  key: string;
}

/** Synthesizer 返回：AgentOutcome + 提取出的 prologueMd（提取失败为 null）。 */
export interface SynthesizerOutcome extends AgentOutcome {
  /**
   * 从 stdout ```markdown fence 提取的 prologue/draft.md 全文。
   * 提取失败为 null（同时 ok=false）。
   */
  prologueMd: string | null;
}

/**
 * 调起 Synthesizer agent：通读全部章节 draft.md，产出全书级导读。
 *
 * 流程：拼 user prompt → runClaude（readonly, cwd=runDir）→ 从 stdout 提取 markdown fence。
 * 不落盘（Stage 负责）。返回 cmd 供 manifest 记录 + AC-7 核验。
 */
export async function synthesizer(opts: SynthesizerOpts): Promise<SynthesizerOutcome> {
  const { key, model, spawn } = opts;

  const cwd = runDir(key);
  const systemPromptPath = promptPath("synthesizer");

  const prompt = [
    "你是 Synthesizer（导读作者）。请通读全部章节 draft.md，产出全书级导读 prologue/draft.md。",
    "",
    "## 本次输入",
    `- Run key: ${key}`,
    `- cwd: ${cwd}（相对 cwd 读 work/... 即 atlas/${key}/work/...）`,
    "",
    "## 读取范围",
    "- work/outline.json：含 chapters[]（slug/title/summary/layer/dependsOn/sourceFiles）与 topoOrder[]。",
    "- work/chapters/{slug}/draft.md：各章正文。**必须逐章通读**，不要只看 outline 的 title/summary。",
    "- work/repo-map.json：站名/简介可参考仓库信息（可选）。",
    "",
    "## 任务",
    "1. **逐章 Read** work/chapters/{slug}/draft.md（每个 slug 一篇），提取每章的核心思想与关键权衡。",
    "2. 提炼全书一句话主线/spine——基于各章的**关键权衡**（原理骨架），不是基于各章**标题**（功能清单）。",
    "   若全书确无单一主线，明示「无单一主线」并按 layer 组织，不要硬编。",
    "3. 产出两条阅读路线：线性路线（按 topoOrder）+ 按主题路线（针对常见阅读目标列章节子序列）。",
    "4. 列出贯穿全书的核心原理（在多章以不同化身现身的底层机制），每条点明在哪几章现身。",
    "5. 为全书脉络图写一段**引言**（图本身由编排层程序化生成，你**不画图**）。引言要点出：", "   图怎么读（箭头=前置→后继）、最显眼的根节点/汇聚点是哪章、有哪些跨 layer 的关键边。",
    "6. 全程**只读**：禁止 Write/Edit；不改任何章节 draft、不改 outline。",
    "",
    "## 产物结构（四块缺一不可）",
    "- 这本书在讲什么：一句话主线（原理骨架，不是功能清单）",
    "- 怎么读这本书：两条阅读路线（线性 + 按主题）",
    "- 贯穿全书的核心原理（跨章复现的底层机制 + 哪几章现身）",
    "- 全书脉络图（**只写引言**；mermaid 依赖图由编排层依据 outline.dependsOn 程序化注入）",
    "",
    "## 输出契约（严格）",
    "你的最终回复**只**包含一个被 fence 包裹的 markdown 文本块（prologue/draft.md 的完整内容）。",
    "fence 外**不写**任何正文/解释。agent 层会从 stdout 提取 fence 内文本后原子落盘。",
    "**外层 fence 用 4 个反引号**（````markdown），以保证内层代码块不会被误判为外层结束。",
  ].join("\n");

  const result = await runClaude({
    prompt,
    systemPromptPath,
    cwd,
    tools: "readonly",
    model,
    spawn,
    // 导读需要通读全部章节 draft（pinia 约 15 章），单次可能较久；给 25 分钟。
    timeoutMs: 25 * 60 * 1000,
    retries: 3,
    // validate：必须产出 ```markdown fence（4 反引号外层），且前三块 H2 齐全。
    // 脉络图（第四块）不强制——06-assemble 会用 outline 程序化生成 mermaid 补上
    // （audit 2026-08-04：杜绝 LLM 末尾截断导致脉络图空壳过闸）。
    validate: (stdout) => {
      const md = extractFence(stdout, "markdown");
      if (!md) return false;
      // startsWith + includes 容错冒号后缀（如 mitt 实际产出「## 这本书在讲什么：一句话主线」）。
      const lines = md.split("\n").map((l) => l.trim());
      const has = (kw: string) =>
        lines.some((l) => l.startsWith("##") && l.includes(kw));
      return (
        has("这本书在讲什么") && has("怎么读这本书") && has("贯穿全书的核心原理")
      );
    },
  });

  // 从 stdout 提取 ```markdown fence 内文本。
  const prologueMd = extractFence(result.stdout, "markdown");

  return {
    ok: result.ok && prologueMd !== null,
    cmd: result.cmd,
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    prologueMd,
  };
}

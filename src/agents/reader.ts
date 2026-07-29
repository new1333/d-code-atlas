// agents/reader.ts：Reader（源码精读员）的 agent 封装。
// 对应 design §4 Stage 4（Research）、§8.3/§8.4（章节产物 research.md）、
// ADR-0005（源只读）、AC-7。
//
// 契约（design §5 / AC-7）：
//   - tools = "readonly"（绝不 write）。
//   - cwd = runDir(key)（`atlas/{key}/`）：相对 cwd 读 work/outline.json + work/source/。
//   - **不落盘** research.md——Reader 把 markdown 内容以 ```markdown fence 作 stdout
//     返回；本 agent 用 extractFence(stdout, "markdown") 提取后 return；
//     由 Stage 原子落盘到 work/chapters/{slug}/research.md。
//
// user prompt 与 prompts/reader.md 的输入占位对齐：读 outline 取本章 sourceFiles、
// 读源码，产出 research.md 内容（markdown fence，标注源码位置）。

import { runClaude } from "../lib/run-claude.ts";
import { runDir } from "../lib/io.ts";
import { extractFence } from "../lib/extract.ts";
import { promptPath, agentAddDirs, type AgentOutcome, type AgentCommonOpts } from "./types.ts";

/** Reader 入参。 */
export interface ReaderOpts extends AgentCommonOpts {
  /** Run key（决定 runDir）。 */
  key: string;
  /** 本章 slug（精读对象）。 */
  slug: string;
}

/** Reader 返回：AgentOutcome + 提取出的 researchMd（提取失败为 null）。 */
export interface ReaderOutcome extends AgentOutcome {
  /**
   * 从 stdout ```markdown fence 提取的 research.md 全文。
   * 提取失败为 null（同时 ok=false）。
   */
  researchMd: string | null;
}

/**
 * 调起 Reader agent：精读本章 sourceFiles，产出 research.md 内容。
 *
 * 流程：拼 user prompt → runClaude（readonly, cwd=runDir）→ 从 stdout 提取 markdown fence。
 * 不落盘（Stage 负责）。返回 cmd 供 manifest 记录 + AC-7 核验。
 */
export async function reader(opts: ReaderOpts): Promise<ReaderOutcome> {
  const { key, slug, model, spawn, sourcePath } = opts;

  const cwd = runDir(key);
  const systemPromptPath = promptPath("reader");

  const prompt = [
    "你是 Reader（源码精读员）。请针对指定章节的 sourceFiles 做精读，产出事实摘录 research.md。",
    "",
    "## 本次输入",
    `- Run key: ${key}`,
    `- 本章 slug: ${slug}`,
    `- cwd: ${cwd}（相对 cwd 读 work/... 即 atlas/${key}/work/...）`,
    "",
    "## 读取范围",
    "- work/outline.json：取出本章（按 slug）的 sourceFiles[]、title/summary、dependsOn。",
    "- 源码（精读对象）：",
    "  · git 克隆场景：源在 work/source/。",
    "  · 本地源场景：见 repo-map.json 的 root 字段（绝对路径，只读）。",
    "",
    "## 任务",
    `1. **必须覆盖** work/outline.json 中本章 sourceFiles[] 的**全部**文件（逐个 Read）。`,
    "2. 事实抽取：源码里**实际有什么**、**怎么连接**、**为什么这么写**（从代码与注释推断，不臆测）。",
    "3. 每条关键论断后标注 `源码位置: <相对路径>:<行号或范围>`（相对 root，POSIX 风格）。",
    "4. 全程**只读**：禁止 Write/Edit；不修改源仓库、不写 draft.md/replica（ADR-0005、AC-7）。",
    "",
    "## 输出契约（严格）",
    "你的最终回复**只**包含一个被 fence 包裹的 markdown 文本块（research.md 的完整内容）。",
    "fence 外**不写**任何正文/解释。agent 层会从 stdout 提取 fence 内文本后原子落盘。",
    "**外层 fence 用 4 个反引号**（````markdown），以保证内层源码片段的 ```ts / ```js 代码块",
    "不会被误判为外层结束（CommonMark 规则：结束 fence 反引号数 ≥ 起始）。",
    "局部贴源码片段时用对应语言 fence 如 ```ts；**不要**用 ```json 包裹整个文档。",
  ].join("\n");

  const result = await runClaude({
    prompt,
    systemPromptPath,
    cwd,
    tools: "readonly",
    model,
    spawn,
    // 本地源在 cwd 之外，必须 --add-dir 声明（否则 claude 读取源码被拦截）。
    addDirs: agentAddDirs(sourcePath),
    // reader 深度精读大仓库源码（如 pinia）单章可能超 15 分钟；给 25 分钟。
    timeoutMs: 25 * 60 * 1000,
    retries: 3,
    // validate：reader 必须产出 ```markdown fence（4 反引号外层）。
    // claude 偶发不加 fence 或用 3 反引号（与内层代码块冲突）→ 触发重试。
    validate: (stdout) => extractFence(stdout, "markdown") !== null,
  });

  // 从 stdout 提取 ```markdown fence 内文本（注意：Reader 不用 JSON，用 markdown fence）。
  const researchMd = extractFence(result.stdout, "markdown");

  return {
    ok: result.ok && researchMd !== null,
    cmd: result.cmd,
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    researchMd,
  };
}

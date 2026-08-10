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
import { TOPIC_READONLY_TOOLS } from "../lib/config.ts";
import { type ChapterContext } from "../lib/chapter-context.ts";
import { promptPath, agentAddDirs, type AgentOutcome, type AgentCommonOpts } from "./types.ts";

/** Reader 入参。 */
export interface ReaderOpts extends AgentCommonOpts {
  /** Run key（决定 runDir）。 */
  key: string;
  /** 本章 slug（精读对象）。 */
  slug: string;
  /**
   * 运行模式（task 13 topic 模式）：
   * - `"repo"`（默认）：读 sourceFiles 精读源码（仓库模式现状）。
   * - `"topic"`：凭知识 + WebSearch 调研（不读 sourceFiles，用 topic-reader.md prompt + WebSearch 白名单）。
   * 非破坏性扩展，默认 `"repo"` 向后兼容。
   */
  mode?: "repo" | "topic";
  /**
   * 章节上下文（可选，research stage 透传）。
   * 含本章在 topoOrder 的位置、前后驱标题、dependsOn 各章的 title/summary。
   * 供 Reader 在 research.md 的「设计动机」钩子里标注「本章哪些机制是前置章核心权衡的复用」，
   * 给下游 Writer 做跨章去重提供信号。stage 算不出时省略，Reader 不受影响。
   *
   * 非破坏性扩展，向后兼容。
   */
  chapterContext?: ChapterContext;
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
 * 校验 research.md 的教学钩子结构（8 子项硬门禁，对应 reader.md §4 + reader.ts user prompt）。
 *
 * 只做**轻量关键词存在性检查**——挡住「LLM 漏填/敷衍整段子项」这类最明显的残缺，
 * 不评内容质量（那是下游 Writer/Critic 的事）。检查项：
 *   1. fence 内第一分区是「## 给 Writer 的教学钩子」（先于任何源码事实分区）；
 *   2. 8 个子项标题关键词全部出现。
 *
 * 检查是「钩子分区在源码事实之前」的弱近似：只要「教学钩子」标题的字符位置先于
 * 「概念要点」等事实分区标题，即视为通过。严格顺序校验交给真实 Critic（若未来引入）。
 *
 * @param md 已从 stdout 提取的 research.md 全文（null 时返回 false）
 * @returns 结构是否合格
 */
function validateHooksStructure(md: string | null): boolean {
  if (!md) return false;
  // 8 个子项的标志性标题词（与 reader.md §4 钩子模板逐一对应）。
  const required = [
    "痛点", // ① 用户痛点/场景
    "核心思想", // ② 一句话核心思想
    "设计动机", // ③ 设计动机
    "关键权衡", // ④ 关键权衡
    "心智模型", // ⑤ 最小心智模型
    "原理演示", // ⑥ 最小原理演示
    "不宜展开", // ⑦ 正文不宜展开的细节
    "执行轨迹", // ⑧ 推荐的一个执行轨迹例子
  ];
  // 第一分区必须是教学钩子：它的标题位置必须先于第一个事实分区标题。
  const hooksIdx = md.search(/##\s*给 Writer 的教学钩子/);
  if (hooksIdx < 0) return false;
  const factsIdx = md.search(/##\s*(概念要点|关键调用链|源码摘录|易混淆)/);
  if (factsIdx >= 0 && factsIdx < hooksIdx) return false; // 事实分区先于钩子 = 顺序错
  // 8 子项关键词必须全部出现（在钩子分区内即可，不强求全文唯一，降低误杀）。
  return required.every((kw) => md.includes(kw));
}

/**
 * 调起 Reader agent：精读本章 sourceFiles，产出 research.md 内容。
 *
 * 流程：拼 user prompt → runClaude（readonly, cwd=runDir）→ 从 stdout 提取 markdown fence。
 * 不落盘（Stage 负责）。返回 cmd 供 manifest 记录 + AC-7 核验。
 */
export async function reader(opts: ReaderOpts): Promise<ReaderOutcome> {
  const { key, slug, model, spawn, sourcePath, chapterContext } = opts;
  const mode = opts.mode ?? "repo";

  const cwd = runDir(key);
  const systemPromptPath = promptPath(mode === "topic" ? "topic-reader" : "reader");

  // 章节上下文块：stage 已算好（位置 + 前后驱 + dependsOn 各章主题），插进 user prompt。
  // 让 Reader 在「设计动机」钩子里标注本章与前置章的复用关系，供 Writer 做跨章去重。
  // 省略时（stage 算不出）不插，Reader 不受影响——向后兼容。
  const contextLines: string[] =
    chapterContext && chapterContext.position >= 0
      ? [
          "5. **标注与前置章的复用关系（跨章去重信号）**：下面「章节上下文」列出了 dependsOn 各章的主题。",
          "   如果本章某个机制已在某前置章的 summary 里作为核心权衡出现，请在「给 Writer 的教学钩子」",
          "   的「设计动机」子项里标注「（已在第 N 章『Y』讲透，本章只看它的新侧面 Z）」，",
          "   提醒 Writer 不要重演同一原理。",
          "",
          "## 章节上下文（stage 已算好）",
          `- 你是全书第 ${chapterContext.position + 1}/${chapterContext.total} 章。`,
          `- 紧邻下一章：${chapterContext.nextTitle ?? "（末章，无后继）"}`,
          "- 本章 dependsOn 的前置章及核心主题：",
          ...(chapterContext.depTitles.length === 0
            ? ["  · （本章无 dependsOn，是全书地基章之一）"]
            : chapterContext.depTitles.map(
                (title, i) => `  · 「${title}」：${chapterContext.depSummaries[i] ?? ""}`,
              )),
          "",
        ]
      : [];

  const prompt =
    mode === "topic"
      ? buildTopicPrompt(key, slug, cwd, contextLines)
      : buildRepoPrompt(key, slug, cwd, contextLines);

  const result = await runClaude({
    prompt,
    systemPromptPath,
    cwd,
    tools: "readonly",
    // topic 模式用 WebSearch 白名单（在只读基础上加 WebSearch 做外部 grounding）。
    ...(mode === "topic" ? { toolsOverride: TOPIC_READONLY_TOOLS } : {}),
    model,
    spawn,
    // 本地源在 cwd 之外，必须 --add-dir 声明（否则 claude 读取源码被拦截）。
    // topic 模式无源码目录，agentAddDirs(undefined) 只返回 promptsDir。
    addDirs: agentAddDirs(sourcePath),
    // reader 深度精读大仓库源码（如 pinia）单章可能超 15 分钟；给 25 分钟。
    timeoutMs: 25 * 60 * 1000,
    retries: 3,
    // validate：reader 必须产出 4 反引号 markdown fence，且 fence 内教学钩子结构合格。
    // 两层校验：① fence 可提取（claude 偶发不加 fence 或用 3 反引号）；② 钩子 8 子项齐全。
    // 任一不过 → run-claude 重试（retries=3），挡住「fence 在但钩子漏填/敷衍」的残缺 research.md。
    validate: (stdout) => {
      const md = extractFence(stdout, "markdown");
      return md !== null && validateHooksStructure(md);
    },
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

// ---------------------------------------------------------------------------
// user prompt 拼接（repo / topic 两套）
// ---------------------------------------------------------------------------

/** repo 模式 user prompt。 */
function buildRepoPrompt(key: string, slug: string, cwd: string, contextLines: string[]): string {
  return [
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
    "## research.md 结构硬门禁（违反即产物不合格，务必遵守）",
    "research.md 的 fence 内有固定分区顺序，第一分区**必须**是「## 给 Writer 的教学钩子」，",
    "且必须**先于**任何源码事实（概念要点/调用链/源码摘录）出现。",
    "教学钩子分区内的 **8 个子项必须全部填齐**（不是敷衍的一句话）：",
    "  ① 用户痛点/场景  ② 一句话核心思想  ③ 设计动机（含与前置章的复用关系标注）",
    "  ④ 关键权衡（机制丰富章 2~4 条，机制稀薄章至少 1 条讲透；每条「选择→换来→代价」三段式）",
    "  ⑤ 最小心智模型（3~7 步）  ⑥ 最小原理演示（应演示/应省略/**演示载体建议**）",
    "  ⑦ 正文不宜展开的细节  ⑧ 推荐的一个执行轨迹例子",
    "钩子里**禁止出现文件名/行号/源码符号名**（如 store.ts、_s.set、:859）——先把机制抽象成原理。",
    "源码引用（带 `源码位置:` 标注）只允许出现在后面的概念要点/调用链/源码摘录分区。",
    "**全文源码摘录累计 ≤ 30 行**，每段摘录必须在钩子里有对应的原理用途说明，否则删掉。",
    "",
    "## 任务",
    `1. **必须覆盖** work/outline.json 中本章 sourceFiles[] 的**全部**文件（逐个 Read）。`,
    "2. 事实抽取：源码里**实际有什么**、**怎么连接**、**为什么这么写**（从代码与注释推断，不臆测）。",
    "3. 每条关键论断后标注 `源码位置: <相对路径>:<行号或范围>`（相对 root，POSIX 风格）。",
    "4. 全程**只读**：禁止 Write/Edit；不修改源仓库、不写 draft.md/replica（ADR-0005、AC-7）。",
    ...contextLines,
    "## 输出契约（严格）",
    "你的最终回复**只**包含一个被 fence 包裹的 markdown 文本块（research.md 的完整内容）。",
    "fence 外**不写**任何正文/解释。agent 层会从 stdout 提取 fence 内文本后原子落盘。",
    "**外层 fence 用 4 个反引号**（````markdown），以保证内层源码片段的 ```ts / ```js 代码块",
    "不会被误判为外层结束（CommonMark 规则：结束 fence 反引号数 ≥ 起始）。",
    "局部贴源码片段时用对应语言 fence 如 ```ts；**不要**用 ```json 包裹整个文档。",
  ].join("\n");
}

/**
 * topic 模式 user prompt。
 * 不读 sourceFiles，凭知识 + WebSearch 产 research.md；依据标注官方文档/规范而非源码位置。
 */
function buildTopicPrompt(key: string, slug: string, cwd: string, contextLines: string[]): string {
  return [
    "你是 Topic Reader（主题精读员）。请针对指定章节的概念，凭知识 + WebSearch 调研，",
    "产出教学原料 research.md。",
    "",
    "## 本次输入",
    `- Run key: ${key}`,
    `- 本章 slug: ${slug}`,
    `- cwd: ${cwd}（topic 模式无 source/，相对 cwd 只有 work/outline.json 可读）`,
    "",
    "## 读取范围",
    "- work/outline.json：取出本章（按 slug）的 title/summary、dependsOn。",
    "  （topic 模式下 sourceFiles 为空数组，**不读**——无源码。）",
    "- **无 source/**（topic 模式无参考仓库）。",
    "- **WebSearch 是你的外部 grounding**：用 WebSearch 查官方文档/规范/权威资料，",
    "  核对关键技术断言的准确性。",
    "",
    "## research.md 结构硬门禁（违反即产物不合格，务必遵守）",
    "research.md 的 fence 内有固定分区顺序，第一分区**必须**是「## 给 Writer 的教学钩子」，",
    "且必须**先于**任何事实（概念要点/关键流程）出现。",
    "教学钩子分区内的 **8 个子项必须全部填齐**（不是敷衍的一句话）：",
    "  ① 用户痛点/场景  ② 一句话核心思想  ③ 设计动机（含与前置章的复用关系标注）",
    "  ④ 关键权衡（机制丰富章 2~4 条，机制稀薄章至少 1 条讲透；每条「选择→换来→代价」三段式）",
    "  ⑤ 最小心智模型（3~7 步）  ⑥ 最小原理演示（应演示/应省略/**演示载体建议**）",
    "  ⑦ 正文不宜展开的细节  ⑧ 推荐的一个执行轨迹例子",
    "钩子里**禁止出现文件名/行号/文档 URL**——先把机制抽象成原理。",
    "依据标注（带 `依据:` 标注）只允许出现在后面的概念要点/关键流程分区。",
    "",
    "## 任务",
    "1. **用 WebSearch 调研**本章概念：官方文档怎么说、规范怎么定义、有哪些已知权衡。",
    "2. 事实抽取：官方文档/规范里**实际是什么**、**怎么用**、**为什么这么设计**（标注来源，不臆测）。",
    "3. 每条关键论断后标注 `依据: <官方文档名/规范段落/知识来源描述>`。",
    "4. 全程**只读**：禁止 Write/Edit。",
    ...contextLines,
    "## 输出契约（严格）",
    "你的最终回复**只**包含一个被 fence 包裹的 markdown 文本块（research.md 的完整内容）。",
    "fence 外**不写**任何正文/解释。agent 层会从 stdout 提取 fence 内文本后原子落盘。",
    "**外层 fence 用 4 个反引号**（````markdown），以保证内层片段的 ```ts / ```js 代码块",
    "不会被误判为外层结束（CommonMark 规则：结束 fence 反引号数 ≥ 起始）。",
    "局部贴代码片段时用对应语言 fence 如 ```ts；**不要**用 ```json 包裹整个文档。",
  ].join("\n");
}

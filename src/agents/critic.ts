// agents/critic.ts：Critic（对抗评审员）的 agent 封装，支持 outline/chapter 双模式。
// 对应 design §5.3/§5.4（验收标准）、§6（对抗评审 ADR-0004）、§7（自底向上 ADR-0003）、
// ADR-0005（源只读）、AC-7。
//
// 契约（design §5 / AC-7）：
//   - tools = "readonly"（绝不 write）：Critic 只评审、不生产。
//   - cwd = runDir(key)（`atlas/{key}/`）。
//   - systemPromptPath 按 mode 选 critic-outline.md / critic-chapter.md。
//   - **不落盘**：Critic 把 {verdict, fixes} 以 ```json fence 作 stdout 返回；
//     本 agent 用 extractCriticVerdict 提取并校验枚举/类型后 return；
//     Stage 据此决定 approve 短路 / reject+fixes 触发 Producer 修订。
//
// 输出契约（critic-*.md §4）：verdict ∈ approve/reject；fixes 为字符串数组。

import { runClaude } from "../lib/run-claude.ts";
import { runDir } from "../lib/io.ts";
import { extractCriticVerdict, type CriticVerdict } from "../lib/extract.ts";
import { promptPath, agentAddDirs, type AgentOutcome, type AgentCommonOpts } from "./types.ts";

/** Critic 评审模式：outline（大纲）/ chapter（单章草稿）。 */
export type CriticMode = "outline" | "chapter";

/** Critic 入参。 */
export interface CriticOpts extends AgentCommonOpts {
  /** Run key（决定 runDir）。 */
  key: string;
  /** 评审模式：outline 评大纲、chapter 评单章草稿。 */
  mode: CriticMode;
  /** chapter 模式下必填：被评审章节的 slug。outline 模式不用。 */
  slug?: string;
}

/** Critic 返回：AgentOutcome + 解析出的 verdict/fixes（解析失败 verdict=null）。 */
export interface CriticOutcome extends AgentOutcome, CriticVerdictPartial {
  /**
   * 评审结论：approve/reject。
   * 解析失败或枚举非法时为 null（同时 ok=false），交 Stage 按失败处理（不误判 approve）。
   */
  verdict: "approve" | "reject" | null;
}

/** CriticVerdict 的可选形态（verdict 为 null 时 fixes 也置空数组）。 */
interface CriticVerdictPartial {
  /** 修改点列表（approve 时为空；reject 时具体可执行；解析失败为空数组）。 */
  fixes: string[];
}

/**
 * 调起 Critic agent：对大纲或单章草稿做对抗评审，返回结构化 {verdict, fixes}。
 *
 * 流程：按 mode 选 system prompt + 拼 user prompt → runClaude（readonly）→
 * extractCriticVerdict 校验枚举/类型 → return。
 *
 * - outline 模式：读 work/outline.json（草稿）+ repo-map + 源码，按 4 条标准评审。
 * - chapter 模式：需 slug；读 work/chapters/{slug}/draft.md + replica/ + research.md +
 *   outline（取 dependsOn），按 4 条标准评审。
 */
export async function critic(opts: CriticOpts): Promise<CriticOutcome> {
  const { key, mode, slug, model, spawn, sourcePath } = opts;

  if (mode === "chapter" && !slug) {
    // chapter 模式缺 slug：直接返回失败（不调 claude，省一次调用）。
    return {
      ok: false,
      cmd: "",
      stdout: "",
      stderr: "critic: chapter 模式必须提供 slug",
      exitCode: -1,
      verdict: null,
      fixes: [],
    };
  }

  const cwd = runDir(key);
  const systemPromptPath = promptPath(
    mode === "outline" ? "critic-outline" : "critic-chapter",
  );

  const prompt =
    mode === "outline"
      ? buildOutlinePrompt(key, cwd)
      : buildChapterPrompt(key, cwd, slug as string);

  const result = await runClaude({
    prompt,
    systemPromptPath,
    cwd,
    tools: "readonly",
    model,
    spawn,
    // 本地源在 cwd 之外，必须 --add-dir 声明（critic 需读源码做准确性抽查）。
    addDirs: agentAddDirs(sourcePath),
    // critic 对「评审」任务高概率产出 markdown 报告而非契约 JSON（实测，模型倾向问题）。
    // 给额外重试机会（3 次 = 共 4 次尝试）；全部失败时 outline stage 会降级接受草稿。
    retries: 3,
    validate: (stdout) => extractCriticVerdict(stdout) !== null,
  });

  // 从 stdout 提取并校验 {verdict, fixes}。
  const v = extractCriticVerdict(result.stdout);

  return {
    ok: result.ok && v !== null,
    cmd: result.cmd,
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    verdict: v?.verdict ?? null,
    fixes: v?.fixes ?? [],
  };
}

// ---------------------------------------------------------------------------
// user prompt 拼接
// ---------------------------------------------------------------------------

/** outline 模式 user prompt。 */
function buildOutlinePrompt(key: string, cwd: string): string {
  return [
    "你是 Critic（对抗评审员）· Outline 模式。请对 Architect 产出的大纲做对抗评审。",
    "",
    "## ⚠️ 输出格式（最重要，违反则本次评审作废）",
    "你的最终回复**必须且只能**是一个 ```json fence 包裹的 JSON 对象，**fence 之外绝不写任何文字**。",
    "不要写 markdown 报告、不要写「评审结论」「总体裁决」之类的标题或正文——那些会让解析失败。",
    "你的所有评审意见都放进 JSON 的 fixes 数组（每条是一个字符串，可长可短）。",
    "正确示例（approve）：",
    "```json",
    '{ "verdict": "approve", "fixes": [] }',
    "```",
    "正确示例（reject）：",
    "```json",
    '{ "verdict": "reject", "fixes": ["章节 X 违反标准②：缺少对 Y 的覆盖，应补充...", "..."] }',
    "```",
    "",
    "## 本次输入",
    `- Run key: ${key}`,
    `- cwd: ${cwd}（相对 cwd 读 work/... 即 atlas/${key}/work/...）`,
    "",
    "## 读取范围",
    "- work/repo-map.json：完整性核对的基准（核心模块/入口/子包是否被覆盖）。",
    "- work/outline.json：被评审的大纲（含 chapters[]；topoOrder 可能尚未注入，你自己用 dependsOn 复算拓扑序做交叉校验）。",
    "- 源码：核对 title/summary 与实际职责是否吻合。",
    "  · git 克隆场景：源在 work/source/。",
    "  · 本地源场景：见 repo-map.json 的 root 字段（绝对路径，只读）。",
    "",
    "## 任务",
    "按 4 条验收标准逐条判定（任一不过即 reject）：",
    "  ① 自底向上可验证（DAG 无环、无自环、无未定义引用、dependsOn 闭包按拓扑序在其之前）。",
    "  ② 完整性（覆盖 repo-map 标记的核心模块/入口/子包）。",
    "  ③ 准确性（title/summary 与 sourceFiles 实际职责吻合，不张冠李戴）。",
    "  ④ 粒度（章数 8~20，无杂物箱章）。",
    "全过 → approve；任一不过 → reject + 具体可执行修改点。",
    "全程**只读**：禁止 Write/Edit；绝不自己生产 outline 内容（只描述「Architect 应该怎么改」）。",
    "",
    "## 再次强调输出格式",
    "**只输出 ```json fence 包裹的 {verdict, fixes} JSON，不写任何 markdown 正文。**",
  ].join("\n");
}

/** chapter 模式 user prompt。 */
function buildChapterPrompt(key: string, cwd: string, slug: string): string {
  return [
    "你是 Critic（对抗评审员）· Chapter 模式。请对 Writer 产出的单章草稿做对抗评审。",
    "",
    "## ⚠️ 输出格式（最重要，违反则本次评审作废）",
    "你的最终回复**必须且只能**是一个 ```json fence 包裹的 JSON 对象，**fence 之外绝不写任何文字**。",
    "不要写 markdown 报告、不要写「评审结论」「总体裁决」之类的标题或正文——那些会让解析失败。",
    "你的所有评审意见都放进 JSON 的 fixes 数组（每条是一个字符串，可长可短）。",
    "正确示例（approve）：",
    "```json",
    '{ "verdict": "approve", "fixes": [] }',
    "```",
    "正确示例（reject）：",
    "```json",
    '{ "verdict": "reject", "fixes": ["draft 第 X 段技术陈述有误：...应改为...", "..."] }',
    "```",
    "",
    "## 本次输入",
    `- Run key: ${key}`,
    `- 本章 slug: ${slug}`,
    `- cwd: ${cwd}（相对 cwd 读 work/... 即 atlas/${key}/work/...）`,
    "",
    "## 读取范围",
    "- work/outline.json：取本章的 dependsOn/sourceFiles/layer/title/summary。",
    `- work/chapters/${slug}/draft.md：被评审的章节草稿（含内嵌演示代码块）。`,
    `- work/chapters/${slug}/replica/：复刻副本（若存在；可读，判断结构合理性与一致性，不强求可运行）。`,
    `- work/chapters/${slug}/research.md：Reader 的事实摘录（交叉核对依据）。`,
    "- 源码：准确性核对基准（抽查关键断言能否在 sourceFiles 找到依据）。",
    "  · git 克隆场景：源在 work/source/。",
    "  · 本地源场景：见 repo-map.json 的 root 字段（绝对路径，只读）。",
    "",
    "## 任务",
    "按 6 条验收标准逐条判定（任一不过即 reject）：",
    "  ① 准确（draft 技术陈述与 Source 行为/语义一致，不误导）。",
    "  ② 衔接（用到的前置概念确实在 dependsOn 章节已讲解，或正文补足）。",
    "  ③ 演示自洽（有从零实现的最小演示演透核心思想；载体按 research.md「演示载体建议」合理选择——",
    "     **优先 TS/JS**：核心功能能用 TS/JS 演透的就用 TS/JS（本 Atlas 产物是 JS 生态站点，对读者最友好）；",
    "     仅当 TS/JS 讲不透（语言特有语义/需原生运行时）才用原仓库语言惯用法；VSCode扩展/插件/需宿主的机制演机制骨架即可；",
    "     不强求 bun run；不与源码逐字重合>50%、不 import 原仓库）。",
    "  ④ 清晰（有动机/核心思想/心智模型/执行轨迹/输入输出之一组，不是流水账）。",
    "  ⑤ 教学·非源码导读（文体硬标准）：叙事主轴不能是文件/函数/行号 walkthrough；",
    "     **正文出现任何源码对照→直接 reject**（`路径:line`/行号/「源码位置」「见 xxx.ts」/「与真源差异·源码对照」小节，一律禁止——源码位置只留 research.md）；",
    "     类型签名/重载罗列篇幅不得超「心智模型+关键权衡+原理演示」合计篇幅。",
    "  ⑥ 原理·关键权衡（产品核心硬标准）：全章必须讲清「为什么这么设计」，有**至少 1 条**高质量的「做了 X 选择→换来 Y→代价 Z」关键权衡，",
    "     且权衡篇幅 ≥ 演示篇幅。机制丰富章通常 2～4 条；机制稀薄章（薄包装/纯配置等）可只 1 条，但该条须真讲透设计动机。",
    "     reject 条件：全章 0 条权衡、或仅有空话（「做了合理权衡」「性能与可读性的平衡」而无具体选择/换来/代价）、或权衡篇幅<演示篇幅。",
    "     **不要因「少于 2 条」就机械 reject 机制稀薄章**——判断这 1 条是否真讲清了「为什么这么设计」。",
    "全过 → approve；任一不过 → reject + 具体可执行修改点（指明 draft 的哪一处 + 违反哪条标准 + 怎么改）。",
    "全程**只读**：禁止 Write/Edit；绝不自己生产 draft/replica 内容（只描述「Writer 应该怎么改」）。",
    "",
    "## 再次强调输出格式",
    "**只输出 ```json fence 包裹的 {verdict, fixes} JSON，不写任何 markdown 正文。**",
  ].join("\n");
}

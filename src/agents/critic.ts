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
import { promptPath, type AgentOutcome, type AgentCommonOpts } from "./types.ts";

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
  const { key, mode, slug, model, spawn } = opts;

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
    "## 输出契约（严格）",
    "你的最终回复**只**包含一个被 ```json fence 包裹的 JSON 对象：",
    '- approve: { "verdict": "approve", "fixes": [] }',
    '- reject:  { "verdict": "reject", "fixes": ["具体修改点1", "..."] }（fixes 至少 1 条）',
    "fence 外不写任何正文。verdict 只能是 approve/reject（小写）。",
  ].join("\n");
}

/** chapter 模式 user prompt。 */
function buildChapterPrompt(key: string, cwd: string, slug: string): string {
  return [
    "你是 Critic（对抗评审员）· Chapter 模式。请对 Writer 产出的单章草稿做对抗评审。",
    "",
    "## 本次输入",
    `- Run key: ${key}`,
    `- 本章 slug: ${slug}`,
    `- cwd: ${cwd}（相对 cwd 读 work/... 即 atlas/${key}/work/...）`,
    "",
    "## 读取范围",
    "- work/outline.json：取本章的 dependsOn/sourceFiles/layer/title/summary。",
    `- work/chapters/${slug}/draft.md：被评审的章节草稿（含内嵌 ts/js 复刻块）。`,
    `- work/chapters/${slug}/replica/：复刻的可运行副本（可读，判断结构合理性与一致性）。`,
    `- work/chapters/${slug}/research.md：Reader 的事实摘录（交叉核对依据）。`,
    "- 源码：准确性核对基准（抽查关键断言能否在 sourceFiles 找到依据）。",
    "  · git 克隆场景：源在 work/source/。",
    "  · 本地源场景：见 repo-map.json 的 root 字段（绝对路径，只读）。",
    "",
    "## 任务",
    "按 4 条验收标准逐条判定（任一不过即 reject）：",
    "  ① 准确（draft 技术陈述与 Source 一致）。",
    "  ② 衔接（用到的前置概念确实在 dependsOn 章节已讲解）。",
    "  ③ 可运行（内嵌复刻与 replica/ 一致且能 bun run）。",
    "  ④ 清晰（有图示/步骤/输入输出，不是流水账）。",
    "全过 → approve；任一不过 → reject + 具体可执行修改点（指明 draft/replica 的哪一处 + 怎么改）。",
    "全程**只读**：禁止 Write/Edit；绝不自己生产 draft/replica 内容（只描述「Writer 应该怎么改」）。",
    "",
    "## 输出契约（严格）",
    "你的最终回复**只**包含一个被 ```json fence 包裹的 JSON 对象：",
    '- approve: { "verdict": "approve", "fixes": [] }',
    '- reject:  { "verdict": "reject", "fixes": ["具体修改点1", "..."] }（fixes 至少 1 条）',
    "fence 外不写任何正文。verdict 只能是 approve/reject（小写）。",
  ].join("\n");
}

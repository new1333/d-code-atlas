// agents/architect.ts：Architect（大纲架构师）的 agent 封装。
// 对应 design §4 Stage 3（Outline）、§5.2（输出要点）、§7（自底向上 ADR-0003）、
// §8.2（outline schema）、ADR-0005（源只读）、AC-7。
//
// 契约（design §5 / AC-7）：
//   - tools = "readonly"（绝不 write）：buildCmd 必然产出 `--allowedTools Read,Glob,Grep`。
//   - cwd = runDir(key)（`atlas/{key}/`）：相对 cwd 读 work/repo-map.json + work/source/。
//   - **不落盘** outline.json；**不注入** topoOrder——Architect 只产 chapters[]，
//     以 ```json fence 作 stdout 返回；本 agent 提取后 return；
//     Stage 用 topo.ts 注入 topoOrder 后原子落盘。
//
// user prompt 与 prompts/architect.md 的输入占位对齐：读 repo-map + 源码，
// 产出 {chapters:[...]}（8~20 章、dependsOn 无环、不含 topoOrder）。

import { runClaude } from "../lib/run-claude.ts";
import { runDir } from "../lib/io.ts";
import { extractJson } from "../lib/extract.ts";
import { TOPIC_READONLY_TOOLS } from "../lib/config.ts";
import type { ArchitectOutput, Chapter } from "../lib/types.ts";
import { promptPath, agentAddDirs, type AgentOutcome, type AgentCommonOpts } from "./types.ts";

/** Architect 入参。 */
export interface ArchitectOpts extends AgentCommonOpts {
  /** Run key（决定 runDir）。 */
  key: string;
  /**
   * 运行模式（task 13 topic 模式）：
   * - `"repo"`（默认）：读 repo-map + 源码拆章（仓库模式现状）。
   * - `"topic"`：凭主题 + WebSearch 拆章（无 repo-map/source，用 topic-architect.md prompt + WebSearch 白名单）。
   * 非破坏性扩展，默认 `"repo"` 向后兼容。
   */
  mode?: "repo" | "topic";
  /**
   * 对抗评审反馈（可选，M09 outline stage 透传）。
   * 上一轮 Critic reject 时给出的 fixes 列表；Architect 据此修订大纲。
   * 首轮调用不提供（undefined）。
   *
   * 这是 M08 的非破坏性扩展（新增可选参数，不改既有签名），由 M09 stage 透传。
   */
  feedback?: string[];
}

/** Architect 返回：AgentOutcome + 解析出的 chapters（解析失败为 null）。 */
export interface ArchitectOutcome extends AgentOutcome {
  /**
   * 从 stdout ```json fence 提取的 chapters 列表。
   * 解析失败为 null（同时 ok=false）；解析成功但章数为空数组也算成功（交 Critic 拦截）。
   */
  chapters: Chapter[] | null;
}

/**
 * 调起 Architect agent：基于 repo-map + 源码拆 8~20 章自底向上大纲。
 *
 * 流程：拼 user prompt → runClaude（readonly, cwd=runDir）→ 从 stdout 提取 chapters。
 * 不落盘、不注入 topoOrder（Stage 负责）。返回 cmd 供 manifest 记录 + AC-7 核验。
 */
export async function architect(opts: ArchitectOpts): Promise<ArchitectOutcome> {
  const { key, model, spawn, feedback, sourcePath } = opts;
  const mode = opts.mode ?? "repo";

  const cwd = runDir(key);
  const systemPromptPath = promptPath(mode === "topic" ? "topic-architect" : "architect");

  // 若 stage 透传了 critic 上一轮的 fixes，拼到 prompt 末尾让 Architect 据反馈修订。
  const feedbackBlock =
    feedback && feedback.length > 0
      ? [
          "",
          "## 上一轮 Critic 反馈（请据此修订大纲）",
          "上一轮 Critic reject 了你的大纲，给出以下修改点。请逐条对照修订，产出新的 chapters：",
          ...feedback.map((f, i) => `${i + 1}. ${f}`),
        ].join("\n")
      : "";

  const prompt =
    (mode === "topic"
      ? buildTopicPrompt(key, cwd)
      : buildRepoPrompt(key, cwd)) + feedbackBlock;

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
    // architect 是整条流水线的骨架，claude 偶发用 markdown 表格而非 JSON fence 输出（实测）。
    // 给额外重试机会（3 次 = 共 4 次尝试），靠 validate 兜底重试到产出合法 JSON。
    retries: 3,
    validate: (stdout) => {
      const p = extractJson<ArchitectOutput>(stdout);
      return p !== null && Array.isArray(p.chapters);
    },
  });

  // 从 stdout 提取 {chapters:[...]}。
  const parsed = extractJson<ArchitectOutput>(result.stdout);
  const chapters = parsed?.chapters ?? null;

  return {
    ok: result.ok && chapters !== null,
    cmd: result.cmd,
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    chapters,
  };
}

// ---------------------------------------------------------------------------
// user prompt 拼接（repo / topic 两套）
// ---------------------------------------------------------------------------

/** repo 模式 user prompt。 */
function buildRepoPrompt(key: string, cwd: string): string {
  return [
    "你是 Architect（大纲架构师）。请基于 repo-map 和源码，把这仓库拆成 8~20 章自底向上的概念大纲。",
    "",
    "## 本次输入",
    `- Run key: ${key}`,
    `- cwd: ${cwd}（相对 cwd 读 work/... 即 atlas/${key}/work/...）`,
    "",
    "## 读取范围",
    "- work/repo-map.json：Surveyor 的结构测绘（入口、清单、子包、语言框架线索）——拆章的主要依据。",
    "- 源码：用 Read/Glob/Grep 核对章节 title/summary 与实际职责吻合。",
    "  · git 克隆场景：源在 work/source/。",
    "  · 本地源场景：见 repo-map.json 的 root 字段（绝对路径，只读）。",
    "",
    "## 任务",
    "1. 高屋建瓴拆概念：每章聚焦**一个可理解概念**（不是按文件/目录分章）。",
    "   （注意：章的 layer/顺序依「读者理解它需要的前置知识」决定，单文件章也可能因概念依赖",
    "   而排在中后段、升层 composite/system，不必然是 primitive 层——别用「单文件=primitive」机械归类。）",
    "2. 自底向上分层：primitive（原子）/ composite（复合）/ system（系统）；dependsOn 必须是更底层的章。",
    "3. dependsOn 形成有向无环图（DAG）：禁止自环、禁止成环、禁止引用未定义 slug。",
    "4. 章数 8~20（绝对上限 24，超量必须合并）；无「杂物箱」章节（如「其它」「杂项」）。",
    "5. 全程**只读**：禁止 Write/Edit；不修改源仓库、不改 repo-map.json（ADR-0005、AC-7）。",
    "",
    "## 输出契约（严格）",
    "你的最终回复**只**包含一个被 ```json fence 包裹的 JSON 对象，形如：",
    '```json',
    "{",
    '  "chapters": [',
    '    { "slug": "...", "title": "...", "layer": "primitive", "dependsOn": [], "sourceFiles": ["..."], "summary": "..." }',
    "  ]",
    "}",
    "```",
    "**不要**写 topoOrder / repo / generatedAt（由 stage 注入）。fence 外不写任何正文。",
  ].join("\n");
}

/**
 * topic 模式 user prompt。
 * 不读 repo-map/source，凭主题 + WebSearch 拆概念大纲；sourceFiles 填空数组。
 */
function buildTopicPrompt(key: string, cwd: string): string {
  return [
    "你是 Topic Architect（主题大纲架构师）。请基于用户给的主题，凭知识 + WebSearch，",
    "把这个主题拆成 8~20 章自底向上的概念大纲。",
    "",
    "## 本次输入",
    `- Run key: ${key}（key 由主题串 slugify 得来，Run key 本身就是主题的提示）`,
    `- cwd: ${cwd}（topic 模式无 repo-map.json、无 source/，相对 cwd 只有 work/outline.json 待你产出）`,
    "- 主题串：见 Run key（key 是主题的 slugify 结果）。如果 key 不足以还原主题，按字面理解它指向的技术主题即可。",
    "",
    "## 读取范围",
    "- **无 repo-map.json、无 source/**（topic 模式跳过了 acquire/survey）。",
    "- **WebSearch 是你的外部 grounding**：用 WebSearch 调研主题的官方文档/规范/权威资料，",
    "  核对子问题结构与关键技术断言，确保拆章覆盖完整且原理准确。",
    "",
    "## 任务",
    "1. 先用 WebSearch 调研这个主题由哪些核心子问题/概念组成（覆盖度判据）。",
    "2. 高屋建瓴拆概念：每章聚焦**一个可理解、可教学的原理/机制**（不是按官方文档目录分章）。",
    "3. 自底向上分层：primitive（基础概念/原语）/ composite（组合机制）/ system（对外 API/集成/应用）；",
    "   dependsOn 必须是更底层的章。",
    "4. dependsOn 形成有向无环图（DAG）：禁止自环、禁止成环、禁止引用未定义 slug。",
    "5. 章数 8~20（绝对上限 24，超量必须合并）；无「杂物箱」章节（如「其它」「杂项」「进阶」）。",
    "6. **sourceFiles 填空数组 `[]`**（topic 模式无源码）。",
    "7. summary 必须点出**设计原理/关键取舍**，不能只是概念名罗列或功能描述。",
    "8. 全程**只读**：禁止 Write/Edit。",
    "",
    "## 输出契约（严格）",
    "你的最终回复**只**包含一个被 ```json fence 包裹的 JSON 对象，形如：",
    '```json',
    "{",
    '  "chapters": [',
    '    { "slug": "...", "title": "...", "layer": "primitive", "dependsOn": [], "sourceFiles": [], "summary": "..." }',
    "  ]",
    "}",
    "```",
    "**不要**写 topoOrder / repo / generatedAt（由 stage 注入）。**sourceFiles 填 `[]`**。fence 外不写任何正文。",
  ].join("\n");
}

// agents/writer.ts：Writer（章节撰写员）的 agent 封装。
// 对应 design §4 Stage 5（Write）、§5（输出要点）、§8.3/§8.4（章节产物）、
// §7/ADR-0003（自底向上）。
//
// 契约（design §5 / §10 / AC-7）：
//   - tools = "readonly"（Read/Glob/Grep）：Writer **不自己落盘**。
//     draft.md 全文以 4 反引号 markdown fence 输出到 stdout，agent 层用 extractFence
//     提取后由 Stage 原子落盘（见下方"设计变更"）。Writer 不调 Write/Edit。
//   - **cwd = chapterDir(key, slug)**（chapters/{slug}/）：research.md 就在当前目录，
//     outline.json/source/ 在 cwd 之外，通过 --add-dir 声明可读（见 addDirs）。
//   - system prompt = writer.md（写作规范的唯一权威）；user prompt 只含运行时变量。
//     与 reader.ts/architect.ts 的架构对齐。
//
// 注：相对 cwd（chapterDir）的路径用 research.md（当前目录）、../outline.json、../../../source/。

import { runClaude } from "../lib/run-claude.ts";
import { workDir, chapterDir, sourceDir } from "../lib/io.ts";
import { extractFence } from "../lib/extract.ts";
import { TOPIC_READONLY_TOOLS } from "../lib/config.ts";
import { type ChapterContext } from "../lib/chapter-context.ts";
import { promptPath, type AgentOutcome, type AgentCommonOpts } from "./types.ts";

/** Writer 入参。 */
export interface WriterOpts extends AgentCommonOpts {
  /** Run key（决定 workDir）。 */
  key: string;
  /** 本章 slug（写作对象）。 */
  slug: string;
  /**
   * 运行模式（task 13 topic 模式）：
   * - `"repo"`（默认）：仓库模式现状（system prompt=writer.md，addDirs 含 sourceDir）。
   * - `"topic"`：topic 模式（system prompt=topic-writer.md，addDirs 去掉 sourceDir，
   *   toolsOverride 加 WebSearch 让 writer 也能查证）。
   * 非破坏性扩展，默认 `"repo"` 向后兼容。
   */
  mode?: "repo" | "topic";
  /**
   * 对抗评审反馈（可选，M09 write stage 透传）。
   * 上一轮 Critic reject 时给出的 fixes 列表；Writer 据此修订 draft/replica。
   * 首轮调用不提供（undefined）。
   *
   * 这是 M08 的非破坏性扩展（新增可选参数，不改既有签名），由 M09 stage 透传。
   */
  feedback?: string[];
  /**
   * 章节上下文（可选，write stage 透传）。
   * 含本章在 topoOrder 的位置、前后驱标题、dependsOn 各章的 title/summary。
   * 供 Writer 做跨章去重（避免重复讲透前置章已讲过的原理）与章末预告对齐
   * （只点名紧邻下一章，而非凭印象罗列）。stage 算不出时省略，Writer 不受影响。
   *
   * 非破坏性扩展（与 feedback 同模式），向后兼容。
   */
  chapterContext?: ChapterContext;
}

/** Writer 返回：AgentOutcome + 从 stdout 提取的 draft.md 全文（提取失败为 null）。 */
export interface WriterOutcome extends AgentOutcome {
  /** 从 stdout 4 反引号 markdown fence 提取的 draft.md 全文；提取失败为 null（同时 ok=false）。 */
  draftMd: string | null;
}

/**
 * 把章节上下文拼成 user prompt 的一节（含前导空行，便于拼到主 prompt 末尾）。
 * 供「跨章去重」「章末预告对齐」两条硬规则消费——让 Writer 知道前置章讲了什么、紧邻下一章是谁。
 *
 * @returns 以 "\n" 起首的字符串块；context 缺失时返回空串（调用方无需判空）。
 */
function buildChapterContextBlock(ctx: ChapterContext): string {
  const lines: string[] = [
    "",
    "## 章节上下文（stage 已算好，请据此做章首承上、跨章去重与章末预告对齐）",
    `- 你是全书第 ${ctx.position + 1}/${ctx.total} 章。`,
    `- 紧邻上一章：${ctx.prevTitle ?? "（首章，无前驱）"}`,
    `- 紧邻下一章：${ctx.nextTitle ?? "（末章，无后继）"}`,
    "- 本章 dependsOn 的前置章及核心主题（写关键权衡前先比对，避免重演前置章已讲透的原理）：",
  ];
  if (ctx.depTitles.length === 0) {
    lines.push("  · （本章无 dependsOn，是全书地基章之一）");
  } else {
    ctx.depTitles.forEach((title, i) => {
      const summary = ctx.depSummaries[i] ?? "";
      lines.push(`  · 「${title}」：${summary}`);
    });
  }
  return lines.join("\n");
}

/**
 * 调起 Writer agent：基于 research.md + outline 写一章 draft.md。
 *
 * 流程：拼 user prompt → runClaude（readonly, cwd=chapterDir, system prompt=writer.md）
 * → 从 stdout 提取 draft.md 内容 → Stage 落盘。
 *
 * **stdout fence 提取（不落盘 replica/）**：Writer 把 draft.md 全文以
 * ````markdown fence（4 反引号外层）输出到 stdout，agent 层用 extractFence 提取后由
 * Stage 原子落盘。这与 Reader 的产物方式一致（design §5）。演示代码内嵌在 draft 里，
 * 不产独立的 replica/ 可运行副本。
 */
export async function writer(opts: WriterOpts): Promise<WriterOutcome> {
  const { key, slug, model, spawn, feedback, chapterContext } = opts;
  const mode = opts.mode ?? "repo";

  // cwd = chapterDir（chapters/{slug}/），让 claude 在自己的章节目录里写 draft.md 最自然。
  // 实测 cwd=workDir 时 claude 对"写 chapters/{slug}/ 子目录"产生权限幻觉（声称被拦但不真尝试）；
  // cwd=chapterDir 时 draft.md 就在当前目录，claude 直接 Write 不产生跨目录写的幻觉。
  // outline.json/research.md 在 workDir（cwd 之外），通过 --add-dir 声明可读。
  const cwd = chapterDir(key, slug);
  const wdir = workDir(key);
  // system prompt 按 mode 选：topic 模式用 topic-writer.md（删改 topic 不适用规则），repo 模式用 writer.md。
  const systemPromptPath = promptPath(mode === "topic" ? "topic-writer" : "writer");

  // 章节上下文块：stage 已算好（位置 + 前后驱 + dependsOn 各章主题），插进 user prompt。
  // 省略时（stage 算不出）不插，Writer 不受影响——向后兼容。
  const contextBlock =
    chapterContext && chapterContext.position >= 0
      ? buildChapterContextBlock(chapterContext)
      : "";

  // 若 stage 透传了 critic 上一轮的 fixes，拼到 prompt 末尾让 Writer 据反馈修订。
  const feedbackBlock =
    feedback && feedback.length > 0
      ? [
          "",
          "## 上一轮 Critic 反馈（请据此修订）",
          "上一轮 Critic reject 了你的章节草稿，给出以下修改点。请逐条对照修订：",
          ...feedback.map((f, i) => `${i + 1}. ${f}`),
        ].join("\n")
      : "";

  const prompt = [
    `你是 Writer（章节撰写员）。本章 slug: ${slug}。`,
    "",
    "## 输入",
    `- cwd: ${cwd}（含 research.md；相对 cwd 读 ../../../outline.json${mode === "topic" ? "" : "、../../../source/"}）`,
    "- 写作规范的完整要求见 system prompt（文风、结构、关键权衡、演示、mermaid 等），这里只给运行时信息。",
    "",
    "## 输出方式（提醒，完整规范见 system prompt）",
    "- 只输出 4 反引号 markdown fence，fence 外不写任何文字。",
    "- fence 内是 draft.md 的完整内容（章节正文 + 内嵌演示代码）。",
  ].join("\n") + contextBlock + feedbackBlock;

  const result = await runClaude({
    prompt,
    // system prompt = writer.md（repo 模式）/ topic-writer.md（topic 模式）：写作规范的单一权威。
    // user prompt 只含运行时变量（slug、cwd、章节上下文、Critic 反馈）。
    systemPromptPath,
    cwd,
    tools: "readonly",
    // topic 模式用 WebSearch 白名单（在只读基础上加 WebSearch，让 writer 也能查证）。
    ...(mode === "topic" ? { toolsOverride: TOPIC_READONLY_TOOLS } : {}),
    model,
    spawn,
    // workDir（outline.json/research.md 在此）+ sourceDir（repo 模式：claude 读源码核对技术准确性）。
    // 实测 claude 的 --add-dir 不递归：只声明 workDir 时，读 work/source/ 下源码会被拦，
    // 导致 writer 卡在"等授权读源码"。必须显式声明 sourceDir。
    // topic 模式无源码目录，去掉 sourceDir（加了反而触发 claude 的「等授权读」幻觉）。
    addDirs: mode === "topic" ? [wdir] : [wdir, sourceDir(key)],
    timeoutMs: 15 * 60 * 1000,
    // retries：claude headless 偶发「声称被拦」/空回复（不产 fence）→ validate 触发重试。
    // 历史为 0（无重试），导致偶发失败直接判 fail（pinia run 的 diagnostics/pinia-instance 两章即如此）。
    // 与其它 agent 对齐给重试机会；validate（fence 提取）保证重试只在产出无效时发生。
    retries: 2,
    // validate：必须产出 4 反引号 markdown fence。
    validate: (stdout) => extractFence(stdout, "markdown") !== null,
  });

  // 从 stdout 提取 draft.md 内容（4 反引号 markdown fence）。
  const draftMd = extractFence(result.stdout, "markdown");

  return {
    ok: result.ok && draftMd !== null,
    cmd: result.cmd,
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    draftMd,
  };
}

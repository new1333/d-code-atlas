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
import { workDir, chapterDir, sourceDir } from "../lib/io.ts";
import { extractFence } from "../lib/extract.ts";
import { type AgentOutcome, type AgentCommonOpts } from "./types.ts";

/** Writer 入参。 */
export interface WriterOpts extends AgentCommonOpts {
  /** Run key（决定 workDir）。 */
  key: string;
  /** 本章 slug（写作对象）。 */
  slug: string;
  /**
   * 对抗评审反馈（可选，M09 write stage 透传）。
   * 上一轮 Critic reject 时给出的 fixes 列表；Writer 据此修订 draft/replica。
   * 首轮调用不提供（undefined）。
   *
   * 这是 M08 的非破坏性扩展（新增可选参数，不改既有签名），由 M09 stage 透传。
   */
  feedback?: string[];
}

/** Writer 返回：AgentOutcome + 从 stdout 提取的 draft.md 全文（提取失败为 null）。 */
export interface WriterOutcome extends AgentOutcome {
  /** 从 stdout 4 反引号 markdown fence 提取的 draft.md 全文；提取失败为 null（同时 ok=false）。 */
  draftMd: string | null;
}

/**
 * 调起 Writer agent：基于 research.md + outline 写一章 draft.md + replica/。
 *
 * 流程：拼 user prompt → runClaude（readonly, cwd=workDir）→ 从 stdout 提取 draft.md 内容 → Stage 落盘。
 *
 * **设计变更（原 Write 工具落盘 → stdout fence 提取）**：
 *   实测 claude headless 即便 --permission-mode bypassPermissions，处理复杂写作任务时
 *   高概率不调 Write 工具（停下来「等授权」或直接分析输出到 stdout）。改为让 Writer
 *   把 draft.md 全文以 ````markdown fence（4 反引号外层）输出到 stdout，agent 层用
 *   extractFence 提取后由 Stage 原子落盘。这与 Reader 的产物方式一致（design §5）。
 *   代价：不产 replica/ 可运行副本（原 ADR-0006）。Critic·Chapter 已降级，不强制可运行。
 */
export async function writer(opts: WriterOpts): Promise<WriterOutcome> {
  const { key, slug, model, spawn, feedback } = opts;

  // cwd = chapterDir（chapters/{slug}/），让 claude 在自己的章节目录里写 draft.md 最自然。
  // 实测 cwd=workDir 时 claude 对"写 chapters/{slug}/ 子目录"产生权限幻觉（声称被拦但不真尝试）；
  // cwd=chapterDir 时 draft.md 就在当前目录，claude 直接 Write 不产生跨目录写的幻觉。
  // outline.json/research.md 在 workDir（cwd 之外），通过 --add-dir 声明可读。
  const cwd = chapterDir(key, slug);
  const wdir = workDir(key);

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
    "你是技术文档撰写员。请基于源码事实摘录，撰写一章自底向上的中文教学文档。",
    "",
    "## ⚠️ 输出方式（最重要，违反则作废）",
    "你的最终回复**必须且只能**是一个被 4 反引号 fence 包裹的 markdown 文本块。",
    "即：以 ` ````markdown ` 开头，以 ` ```` ` 结尾，中间是 draft.md 的完整内容。",
    "**绝对不要**调用 Write/Edit 工具（你没有写权限，调用只会失败）。",
    "**绝对不要**在 fence 外写任何文字（「被拦截」「无法写入」「核查结论」等都会导致解析失败）。",
    "fence 内直接写章节正文（markdown），内嵌的 ```ts 代码块不会被 4 反引号外层误判。",
    "",
    "正确示例（你的整个回复应该长这样）：",
    "````markdown",
    "# 章节标题",
    "正文。内嵌代码：",
    "```ts",
    "const x = 1",
    "```",
    "更多正文...",
    "````",
    "",
    "## 输入",
    "- 你的当前工作目录是本章目录（含 research.md）。",
    "- 读 `research.md`（事实摘录，写正文的主要依据；若内容与标题不符，以源码为准）。",
    "- 读 `../../../outline.json`（取本章 title/summary/layer/dependsOn/sourceFiles）。",
    "- 需要时读 `../../../source/` 核对技术准确性。",
    "",
    "## 正文写作要求",
    "- **markdown 格式**，中文。",
    "- **自底向上**：先讲底层原语，再讲组合机制；前置概念来自 dependsOn 章节。",
    "- 配流程图（文字版 A → B → C）、步骤、输入输出示例。",
    "- 内嵌关键代码片段（```ts 代码块），标注源码位置（如 store.ts:L52）。",
    "- 聚焦一个核心概念，不流水账。篇幅 100-300 行。",
    "- **再次强调：只输出 4 反引号 markdown fence，不要写任何 fence 外的文字。**",
  ].join("\n") + feedbackBlock;

  const result = await runClaude({
    prompt,
    // 不用 system prompt（writer.md 的 Write/replica 指令会让 claude 顽固尝试 Write 工具，
    // 即便 user prompt 说"不要 Write"。实测无 system prompt 时 claude 更可能遵守 stdout 输出）。
    cwd,
    tools: "readonly",
    model,
    spawn,
    // workDir（outline.json/research.md 在此）+ sourceDir（claude 读源码核对技术准确性）。
    // 实测 claude 的 --add-dir 不递归：只声明 workDir 时，读 work/source/ 下源码会被拦，
    // 导致 writer 卡在"等授权读源码"。必须显式声明 sourceDir。
    addDirs: [wdir, sourceDir(key)],
    timeoutMs: 15 * 60 * 1000,
    retries: 0,
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

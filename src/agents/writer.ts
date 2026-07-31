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
//   - **不注入 system prompt**：实测 writer.md 内的 Write/replica 落盘指令会让 claude
//     顽固尝试 Write 工具（即便 user prompt 说"不要 Write"）。故写作要求全部写进下方
//     user prompt（含通俗化文风、关键权衡硬要求等），不读 writer.md。
//     ⇒ 若改 writer.md，必须同步把改动落到本文件的 user prompt，否则不生效。
//
// 注：相对 cwd（chapterDir）的路径用 research.md（当前目录）、../outline.json、../../../source/。

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
    "- **markdown 格式**，中文；代码/标识符/字段名用英文。",
    "",
    "### 文体：通俗、像人说话（最高优先级文风要求）",
    "- **这是教学文，不是论文摘要，不是源码导读。** 读者是「想搞懂原理的人」，不是「想背源码结构的人」。",
    "- **每节正文必须以人话开头**：用一个具体场景、一句读者会说的话、或「想象一下」起手；",
    "  **禁止**用「一句话概括底层原语……」「核心思想可以表述为……」这种定义式开场。",
    "- **禁用生硬抽象词**（出现即换成日常说法或删掉）：原语、载体、归一/归一点、收口、",
    "  载荷、地基层、占位(作动词)、汇成、叠在一起、确立、递送、归一化。",
    "  （例：不写「以 pinia=指针收口」，写「最后都落到读指针」；不写「底层原语」，写「最底层的那块」或直接不提。）",
    "- **抽象概念第一次出现时配一个类比**：全局指针 = 一块谁都能看到的公共留言板；",
    "  依赖注入 = 按地址精准投递。类比只用一次点透，不滥用、不每段都打比方。",
    "- **允许并鼓励过渡人话**：「说人话就是……」「换句话说……」「这个设计说白了是为了……」",
    "  这类句子不算水，是教学必需，每节可有 1～2 句。",
    "- **不要反复念叨同一句抽象概括**：核心思想点透一次即可，其余地方用具体例子或人话重述，",
    "  不要每段都以「核心思想是……」「一句话概括……」起手。",
    "",
    "### 结构：自底向上、原理驱动",
    "- **自底向上**：先讲底层基本件，再讲组合机制；前置概念来自 dependsOn 章节。",
    "- **必须有关键权衡（硬要求）**：**至少 1 条**高质量的「做了 X 选择 → 换来了 Y → 代价是 Z」，且权衡总篇幅 ≥ 演示篇幅。这是「学原理」的核心交付。",
    "  权衡要具体可复述，不要泛泛说「做了合理权衡」「性能与可读性的平衡」。",
    "  机制丰富的章通常有 2～4 条；但**机制稀薄的章（如薄包装、纯配置）可只写 1 条**——前提是这 1 条真讲清了「为什么这么设计」，",
    "  且你须在文中点明「本章机制集中，只展开这 1 条核心权衡」。**宁可 1 条讲透，不要为凑数硬编。**",
    "- 配流程图（文字版 A → B → C）、步骤、输入输出示例。",
    "- 内嵌最小演示代码演透原理——用你**自己写的、从零实现的演示**，**不要**贴大段原仓库源码逐行注释。",
    "  **演示载体按 research.md 教学钩子里的「演示载体建议」选**：被分析仓库是什么语言/类型，就用合理的载体——",
    "  TS/JS 可写成能 `bun run`/`node` 跑的脚本（能跑最好，**非硬要求**）；Go/Rust/Python 用各自惯用法；",
    "  VSCode 扩展/IDE 插件/需要宿主或图形界面的机制，演**机制骨架**（激活时序、消息流转）+ 文字执行轨迹即可，不强求真跑。",
    "  一句话：**载体服务于「演透原理」，不是服务于「能跑」。** 别把 JS 的 bun 工具链套到非 JS 仓库上。",
    "- **正文禁绝任何源码对照**：不写 `文件名:行号`、不写「源码位置」「见 xxx.ts」、不设「与真源差异 / 源码对照」小节。",
    "  这是原理教学文，不是源码导读——读者学的是「为什么这么设计」，不需要被引去翻源码。",
    "- 聚焦一个核心概念，不流水账。篇幅 100-300 行。",
    "",
    "### 再次强调输出方式",
    "- **只输出 4 反引号 markdown fence，不要写任何 fence 外的文字。**",
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

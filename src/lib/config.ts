// 全局配置常量：对应 design §14（配置项）。
// 这些常量是流水线默认行为的真相来源（并发度、评审轮数、章数上限、跳过目录、工具白名单）。
// flag 覆盖在 CLI（M11）与 Orchestrator（M10）层处理，这里只给默认值。
// 允许通过 ATLAS_CLAUDE_BIN 环境变量覆盖 claude 可执行路径，便于测试与冒烟（design §10）。

/** 逐章并发上限（design §14）。 */
export const DEFAULT_CONCURRENCY = 4;

/** 对抗评审轮数上限：Producer ⇄ Critic 循环最多跑这么多轮（ADR-0004）。 */
export const REVIEW_ROUNDS = 2;

/** 章节总数上限：超出则 Architect 必须合并，Critic 拦截（design §14、§15）。 */
export const MAX_CHAPTERS = 24;

/** Surveyor 扫描目录树时跳过的重型/生成物目录（design §14、§5.1）。 */
export const SKIP_HEAVY_DIRS = ["node_modules", ".git", "dist", "build"];

/** 只读角色（Surveyor/Architect/Critic/Reader）允许的工具白名单——无逃生口（ADR-0005、AC-7）。 */
export const READONLY_TOOLS = ["Read", "Glob", "Grep"];

/** 写入角色（Writer/Assembler）允许的工具白名单：在只读基础上加 Write/Edit（ADR-0005）。 */
export const WRITE_TOOLS = ["Read", "Glob", "Grep", "Write", "Edit"];

/**
 * claude CLI 可执行名/路径。
 * 默认 "claude"；可用环境变量 ATLAS_CLAUDE_BIN 覆盖，便于 CI 与单测注入假可执行文件。
 */
export const CLAUDE_BIN = process.env.ATLAS_CLAUDE_BIN ?? "claude";

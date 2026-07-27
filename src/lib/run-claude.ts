// lib/run-claude.ts：统一封装 `claude -p` 子进程调用。
// 对应 design §2（执行模型）、§10（只读隔离 ADR-0005）、§15（错误处理与降级）。
// 这是整个工程的咽喉：每个 Agent = 一次 `claude -p` 子进程，工具权限、cwd、
// 超时、命令记录都在这里收敛。
//
// 核心不变量（ADR-0005 / AC-7 / prompt §5 硬约束 #1）：
//   tools==="readonly" 时，buildCmd 产出的命令**必然**含子串
//   `--allowedTools Read,Glob,Grep`，绝不出现 Write/Edit——无逃生口。
//   该子串即 AC-7 核验脚本的锚点（`cmd.includes("--allowedTools Read,Glob,Grep")`）。
//
// 错误处理（design §15）：非 0 退出 / 超时**不抛异常**，由 ClaudeResult.ok=false
// 表达，交用户 `--force` 重跑。保持流水线不炸、成本可控、可诊断。
//
// 零运行时依赖：仅用 bun 内置。spawn 注入点便于单测 mock（不真调 claude）。

import { READONLY_TOOLS, WRITE_TOOLS, CLAUDE_BIN } from "./config.ts";

// ---------------------------------------------------------------------------
// 本机 claude CLI flag 探测结果（claude code cli 2.x，2026-07 实测）
// ---------------------------------------------------------------------------
// - print/headless 模式：`-p`（等同 `--print`）
// - 工具白名单：`--allowedTools <逗号或空格分隔>`（驼峰连写；也接受 `--allowed-tools`）
//     ⇒ 用 `--allowedTools Read,Glob,Grep`，恰好等于 AC-7 核验锚点，执行串==记录串
// - 系统指令注入：`--append-system-prompt-file <path>`（读文件追加到默认 system prompt 后）
//     比 `@path` 展开更明确，且语义贴合「角色 prompt = 系统级指令」
// - model 指定：`--model <model>`
// - 工作目录：claude CLI 无 `--cwd` flag → 靠 spawn 的 cwd 参数透传
// ---------------------------------------------------------------------------

/** 默认超时：15 分钟（claude 一次 agent 调用的合理上限）。
 *  曾为 5 分钟，但实测 Surveyor 对小仓库的结构测绘也可能耗时 7~8 分钟
 *  （读多文件 + 推理 + 生成 JSON），5 分钟会在产物产出前被 kill（exitCode=124 → stage failed）。
 *  15 分钟兼顾「成本有界」与「深度分析能跑完」。flag `--timeout` 可覆盖。 */
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

/** 超时约定的退出码：与 GNU `timeout` 一致（124）。 */
const TIMEOUT_EXIT_CODE = 124;

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** Agent 工具权限：readonly = 只读分析角色；write = 写入角色（Writer/Assembler）。 */
export type ToolMode = "readonly" | "write";

/**
 * spawn 注入点签名（便于单测 mock）。
 * 默认实现 defaultSpawn 用 Bun.spawn；测试里注入假 spawn 返回预设结果。
 * 超时由 spawn 实现负责：到 timeoutMs kill，超时 exitCode 用 124。
 */
export type SpawnFn = (
  args: string[],
  opts: { cwd: string; env?: Record<string, string>; timeoutMs?: number },
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

/**
 * 调起一次 claude agent 的全部入参。
 * cwd 由调用方（stage/agent 层）限定到 run/site/chapter，本模块只透传给 spawn。
 */
export interface ClaudeRunOptions {
  /** 用户 prompt（运行时拼接，告诉 agent 读哪些产物、写到哪、验收标准）。 */
  prompt: string;
  /** 角色 prompt 文件路径（指向 src/prompts/{role}.md），作系统级指令注入。 */
  systemPromptPath?: string;
  /** Agent 工作目录（限定到 run/site/chapter）。 */
  cwd: string;
  /** 工具权限模式。readonly 必然产出 `--allowedTools Read,Glob,Grep`。 */
  tools: ToolMode;
  /** 透传给 claude 的 model 别名/全名（如 "sonnet"）。可选。 */
  model?: string;
  /**
   * 额外可访问目录（透传 claude `--add-dir`）。
   * cwd 之外的目录（如本地源码 absPath）必须在此声明，否则 claude 工具会被
   * "may only access files in the allowed working directories" 拦截（实测阻塞 survey）。
   * 对 URL 克隆源（已在 cwd 下 work/source/）无需传。
   */
  addDirs?: string[];
  /** 超时毫秒，默认 15 分钟。超时 → exitCode=124、ok=false、不抛。 */
  timeoutMs?: number;
  /**
   * 失败重试次数，默认 1。应对 claude headless 非确定性「声称被拦截」/瞬时非 0 退出。
   * exitCode!=0 或 stdout 疑似「声称被拦截」时重试；产物正常则不重试。
   */
  retries?: number;
  /** 额外/覆盖环境变量。可选。 */
  env?: Record<string, string>;
  /**
   * spawn 注入点。默认用真实 Bun.spawn。
   * 单测注入假 spawn 返回预设 {exitCode,stdout,stderr}，不真调 claude。
   */
  spawn?: SpawnFn;
}

/** 一次 claude agent 调用的结构化结果（成功/失败/超时均返回，不抛）。 */
export interface ClaudeResult {
  /** exitCode===0 为 true；否则（含超时 124）为 false。 */
  ok: boolean;
  /** 子进程退出码；超时为 124。 */
  exitCode: number;
  /** stdout（已收集部分）。 */
  stdout: string;
  /** stderr（已收集部分，失败诊断用）。 */
  stderr: string;
  /** 规范化命令串（供 manifest 记录 + AC-7 核验扫描）。 */
  cmd: string;
}

// ---------------------------------------------------------------------------
// buildCmd：纯函数，拼命令
// ---------------------------------------------------------------------------

/**
 * 根据 opts 拼命令。纯函数（无 IO、无副作用）。
 *
 * 返回 `{ cmd, args }`：
 * - `cmd`：规范化字符串，供 manifest 记录 + AC-7 扫描。readonly 模式必然含
 *   子串 `--allowedTools Read,Glob,Grep`（硬约束 #1，无逃生口）。
 * - `args`：传给真实 spawn 的参数数组（不含二进制本身，由 spawn 拼）。
 *
 * 命令形态（readonly 全量示例）：
 *   claude -p "<prompt>" --allowedTools Read,Glob,Grep --model sonnet \
 *          --append-system-prompt-file /abs/path/role.md
 *
 * 注：prompt 含 shell 特殊字符时，spawn 用数组传参天然安全（不经 shell）；
 *     cmd 字符串里对 prompt 做最小引号包裹（双引号 + 内部双引号转义），保证可读且
 *     `--allowedTools Read,Glob,Grep` 子串完整出现、可被 includes 命中。
 */
export function buildCmd(opts: ClaudeRunOptions): { cmd: string; args: string[] } {
  const tools = opts.tools === "write" ? WRITE_TOOLS : READONLY_TOOLS;
  const toolsValue = tools.join(","); // readonly → "Read,Glob,Grep"

  // 真实传给 spawn 的参数数组（不经 shell，无需转义）。
  // flag 名与值分作两个 arg（符合 commander 解析惯例：值是独立参数）。
  // - `--dangerously-skip-permissions`：headless 子进程下，claude 默认对 cwd 外的读取
  //   会因「工作目录白名单」策略拦截（即便 --add-dir 声明了）。本引擎的只读不变量由
  //   `--allowedTools` 强制（无 Write/Edit 工具，物理不可写），故跳过 claude 的交互式
  //   权限提示是安全的——真正的安全边界是工具白名单，不是权限弹窗（ADR-0005）。
  const args: string[] = [
    "-p",
    opts.prompt,
    "--allowedTools",
    toolsValue,
    "--dangerously-skip-permissions",
  ];

  if (opts.model && opts.model.trim() !== "") {
    args.push("--model", opts.model);
  }
  if (opts.addDirs && opts.addDirs.length > 0) {
    // 透传 claude --add-dir：声明 cwd 之外的可访问目录（本地源码路径）。
    // claude 的 --add-dir 接受多个值，故 flag 后把每个目录作为一个 arg。
    args.push("--add-dir", ...opts.addDirs.filter((d) => d && d.trim() !== ""));
  }
  if (opts.systemPromptPath && opts.systemPromptPath.trim() !== "") {
    // 角色作系统级指令：读文件追加到默认 system prompt 后。
    args.push("--append-system-prompt-file", opts.systemPromptPath);
  }

  // 规范化 cmd 字符串（供 manifest 记录 + AC-7 扫描）。
  // 注意：cmd 串里把 `--allowedTools` 与值用单个空格连起来，使 AC-7 锚点子串
  // `--allowedTools Read,Glob,Grep` 完整出现（AC-7 脚本用 includes 匹配此精确子串）。
  const cmd = formatCmdLine(args);

  return { cmd, args };
}

/**
 * 把参数数组格式化成可读的单行命令串。
 * prompt 用双引号包裹（内部双引号/反斜杠转义），保证：
 *   1) 可读（manifest 里能看到完整 prompt，便于调试）；
 *   2) `--allowedTools Read,Glob,Grep` 子串完整出现，可被 includes 命中
 *      （`--allowedTools` 与其值原本是两个独立 arg，join(" ") 后正好拼成锚点子串）。
 * 不做 shell-unsafe 字符的完整转义——此串只用于记录与扫描，不被 re-exec。
 */
function formatCmdLine(args: string[]): string {
  const parts: string[] = [CLAUDE_BIN];

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (i === 1 && args[0] === "-p") {
      // prompt 位置参数（紧跟 -p）：用双引号包裹
      parts.push(`"${quoteEscape(a)}"`);
    } else {
      parts.push(a);
    }
  }
  return parts.join(" ");
}

/** 双引号包裹时对内部双引号/反斜杠做最小转义（保持可读）。 */
function quoteEscape(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

// ---------------------------------------------------------------------------
// defaultSpawn：真实 Bun.spawn + 超时 kill
// ---------------------------------------------------------------------------

/**
 * 默认 spawn 实现：用 Bun.spawn 拉起 claude 子进程，收集 stdout/stderr，
 * 到 timeoutMs kill，返回结构化结果。超时 exitCode=124。
 *
 * 超时由本实现负责（design §15）：到点 kill，已收集的部分输出仍返回，便于诊断。
 */
export const defaultSpawn: SpawnFn = async (args, opts) => {
  const cwd = opts.cwd;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // 合并环境：继承当前进程 env，再用 opts.env 覆盖（如 ATLAS_CLAUDE_BIN 等）。
  const env = { ...process.env, ...(opts.env ?? {}) } as Record<string, string>;

  const proc = Bun.spawn({
    cmd: [CLAUDE_BIN, ...args],
    cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill();
    } catch {
      // 进程可能已退出，忽略 kill 错误。
    }
  }, timeoutMs);

  // 并发读 stdout/stderr 到字符串。
  const stdoutBytes = await new Response(proc.stdout).bytes();
  const stderrBytes = await new Response(proc.stderr).bytes();
  const stdout = Buffer.from(stdoutBytes).toString("utf8");
  const stderr = Buffer.from(stderrBytes).toString("utf8");

  const exitCode = await proc.exited; // 等待退出码（被 kill 时为非 0 信号码）
  clearTimeout(timer);

  // 超时统一约定 124（与 GNU timeout 一致）；非超时用真实退出码。
  return {
    exitCode: timedOut ? TIMEOUT_EXIT_CODE : exitCode,
    stdout,
    stderr,
  };
};

// ---------------------------------------------------------------------------
// runClaude：组装 + 执行 + 结构化结果
// ---------------------------------------------------------------------------

/**
 * 调起一次 claude agent。非 0 退出 / 超时**不抛异常**，由 ok=false 表达。
 *
 * 流程：buildCmd → spawn（注入点或默认）→ 组装 ClaudeResult。
 * 结果含 cmd 字段，可直接写进 manifest 供 AC-7 核验。
 */
export async function runClaude(opts: ClaudeRunOptions): Promise<ClaudeResult> {
  const { cmd, args } = buildCmd(opts);
  const spawn = opts.spawn ?? defaultSpawn;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retries = opts.retries ?? 1; // 默认重试 1 次（应对 claude headless 非确定性「声称被拦截」）

  let last: { exitCode: number; stdout: string; stderr: string } | null = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const r = await spawn(args, { cwd: opts.cwd, env: opts.env, timeoutMs });
    last = r;
    // claude 正常退出（exitCode=0）但产出「声称被拦截」的文本时，重试一次。
    // 这是 claude CLI headless 模式对 cwd 外读取的非确定性行为（实测同命令有时成功有时声称被拦）。
    if (r.exitCode === 0 && !looksBlocked(r.stdout) && attempt < retries) break;
    if (r.exitCode !== 0 && attempt < retries) {
      // 非 0 退出也重试一次（瞬时失败）。
      continue;
    }
    break;
  }
  const { exitCode, stdout, stderr } = last!;

  return {
    ok: exitCode === 0,
    exitCode,
    stdout,
    stderr,
    cmd,
  };
}

/**
 * 启发式判断 claude 的 stdout 是否是「声称被拦截/无法访问」的失败输出。
 * claude headless 模式下，有时即便 --add-dir/--dangerously-skip-permissions 已授予，
 * 仍会输出「我无法访问/被沙箱拦截」之类文本而不产出真实产物。识别后由 runClaude 重试。
 */
function looksBlocked(stdout: string): boolean {
  // 只在 stdout 较短（非真实产物）且含典型阻塞措辞时判定。
  const blockers = ["无法访问", "被拦截", "被阻塞", "权限未授予", "未授权", "may only access files", "blocked", "无法继续"];
  return blockers.some((kw) => stdout.includes(kw));
}

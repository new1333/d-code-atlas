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

import { existsSync as fsExistsSync, mkdirSync } from "node:fs";
import { READONLY_TOOLS, WRITE_TOOLS, CLAUDE_BIN } from "./config.ts";
// re-export resolveClaudeBin，让测试可断言「claude 被解析到真正可执行文件」的核心修复。
export { resolveClaudeBin } from "./config.ts";

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
  /**
   * 产物校验回调（可选）。exitCode=0 时调用，返回 false 表示产出不符合契约
   * （如 architect 该产 JSON fence 却产了 markdown 表格），触发重试。
   * 这是治本的重试条件：claude headless 偶发不遵守输出格式契约，单次成功退出≠产出可用。
   * 不提供时仅按 exitCode + looksBlocked 判定。
   */
  validate?: (stdout: string) => boolean;
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
  /**
   * **综合成功判定**（不只是 exitCode）：`exitCode===0` **且** 产物校验通过。
   *
   * 治本设计（应对 claude headless「假成功」）：
   *   claude headless 偶发 `exitCode=0` 正常退出，却没真正产出/落盘
   *   （最典型：Assembler 该用 Write 工具落盘 site/ 却「声称完成」一个字没写；
   *   或 Writer 该产 fence 却空回复）。重试用尽后，**退出码=0 不等于成功**。
   *
   * 当调用方提供 `validate` 时，`ok` 还要求最后一次尝试的 `validate(stdout)` 通过；
   * 未提供 `validate` 时退化为 `exitCode===0`（兼容只关心退出码的调用方）。
   *
   * 同时 `validated` 字段暴露最后一次校验是否通过，便于上层精确诊断。
   */
  ok: boolean;
  /** 子进程退出码；超时为 124。 */
  exitCode: number;
  /** stdout（已收集部分）。 */
  stdout: string;
  /** stderr（已收集部分，失败诊断用）。 */
  stderr: string;
  /** 规范化命令串（供 manifest 记录 + AC-7 核验扫描）。 */
  cmd: string;
  /**
   * 最后一次尝试的产物校验结果（`validate(stdout)`）。
   * 未提供 `validate` 时恒为 true。退出码=0 但 validated=false 即「假成功」，
   * 上层可据此把 stderr 补成可诊断信息（而非只剩空 stderr）。
   */
  validated: boolean;
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
  // - `--permission-mode bypassPermissions`：彻底跳过所有权限检查。
  //   安全性由 `--allowedTools` 工具白名单保证（readonly 模式无 Write/Edit，物理不可写）。
  //   注：claude 的启动由 resolveClaudeBin() 解析到真正的 PE 可执行文件（claude.exe），
  //   不再依赖 shell 解析 sh/.cmd 包装脚本——这是 Windows 上 spawn 稳定性的核心保证。
  const args: string[] = [
    "-p",
    opts.prompt,
    "--allowedTools",
    toolsValue,
    "--permission-mode",
    "bypassPermissions",
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

  // Windows 上 Bun.spawn 若 cwd 目录不存在，libuv 会抛极具误导性的
  // `ENOENT ... uv_spawn 'claude'`（错误信息把关联可执行名带出来，看似 claude 没装，
  // 实则是 cwd 缺失）。这里**自动重建**缺失的 cwd（recursive mkdir 幂等），让流水线
  // 在工作区部分丢失的脏状态下也能自愈继续跑，而不是抛误导性错误。
  // 常见触发：resume 场景 manifest 标了 acquire=done 但工作目录被外部清除；
  // 或上游 stage 的 ensureDir 因故未生效。重建空 cwd 后，agent 会因读不到源码而
  // 在产物层失败（ok=false），给出真实诊断，远好于 ENOENT 'claude' 这种假象。
  if (!fsExistsSync(cwd)) {
    try {
      mkdirSync(cwd, { recursive: true });
    } catch {
      // mkdir 失败（权限/磁盘满等）→ 仍让下面的 spawn 去抛，由 try/catch 翻译。
    }
  }

  // spawn 本身可能抛错（Windows 上 libuv 的 ENOENT/EINVAL 等）。用 try/catch 包住，
  // 翻译成结构化 ClaudeResult（ok=false），保持「非 0 退出/超时不抛」契约（design §15）。
  // 否则未捕获异常冒泡到顶层，给出误导信息（如 `uv_spawn 'claude'`）。
  // 注：用 `Bun.Subprocess<"pipe","pipe","pipe">` 精确标注（stdout/stderr = ReadableStream），
  //   而非 `ReturnType<typeof Bun.spawn>`——后者是重载联合，会把 stdout 推为
  //   `number | ReadableStream | undefined`，导致 `new Response(proc.stdout)` 类型不兼容。
  let proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
  try {
    proc = Bun.spawn({
      cmd: [CLAUDE_BIN, ...args],
      cwd,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (spawnErr) {
    const e = spawnErr as NodeJS.ErrnoException;
    return {
      exitCode: 126,
      stdout: "",
      stderr:
        `defaultSpawn: 启动 claude 子进程失败（${e.code ?? "UNKNOWN"}）。\n` +
        `CLAUDE_BIN=${JSON.stringify(CLAUDE_BIN)} cwd=${JSON.stringify(cwd)}\n` +
        `原始错误: ${(e.message ?? String(e)).slice(0, 500)}\n` +
        `排查：① 终端确认 \`claude --version\` 可用；` +
        `② 若 claude 是 npm/pnpm 全局装的 .cmd 包装，设环境变量 ` +
        `\`ATLAS_CLAUDE_BIN\` 指向其绝对路径（如 C:/nvm4w/nodejs/claude.cmd）。`,
    };
  }

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
  // 默认重试 2 次（共 3 次尝试）。应对 claude headless 三类非确定性失败：
  //   ① 瞬时非 0 退出；② 「声称被拦截」文本；③ exitCode=0 但产出不符合格式契约（validate 返回 false）。
  // 实测 architect/critic 偶发用 markdown 表格而非 JSON fence 输出，需要更多重试机会。
  const retries = opts.retries ?? 2;
  const validate = opts.validate;

  let last: { exitCode: number; stdout: string; stderr: string } | null = null;
  // 记最后一次尝试的产物校验结果（validate 是否通过）。
  // ok 判定不仅看退出码，还要看 validate——治本：识破 claude headless
  // 「exitCode=0 但没真正产出/落盘」的假成功（如 Assembler 不调 Write）。
  let lastValidated = true;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const r = await spawn(args, { cwd: opts.cwd, env: opts.env, timeoutMs });
    last = r;
    // 本轮产物校验（未提供 validate 则视为通过）。
    const validated = validate ? validate(r.stdout) : true;
    lastValidated = validated;
    if (attempt >= retries) break; // 已是最后一次，不再判定重试
    // 重试条件（任一满足则 continue 重试）：
    //   ① 非 0 退出（含超时 124）
    //   ② exitCode=0 但 looksBlocked（声称被拦截）
    //   ③ exitCode=0 但 validate 返回 false（产出不符合契约，如该 JSON 却产了 markdown，
    //      或 write 类 agent 该落盘却没落盘——配合调用方在 validate 里检查磁盘产物）
    if (r.exitCode !== 0) continue;
    if (looksBlocked(r.stdout)) continue;
    if (!validated) continue;
    break; // 全部通过 → 产物可用，跳出
  }
  const { exitCode, stdout, stderr } = last!;

  // 假成功兜底：退出码=0 但产物校验失败时，stderr 往往是空的，
  // 上层只靠 stderr 诊断会一脸懵（正是 assemble failed 只剩「site/ 不存在」的根因）。
  // 这里补一条明确诊断，让 manifest 的 stderr 字段直接说明「假成功」。
  const finalStderr = exitCode === 0 && !lastValidated
    ? (stderr && stderr.length > 0
        ? `${stderr}\n[run-claude] claude 以 exitCode=0 退出，但产物校验（validate）失败——疑似未真正产出/落盘。`
        : `[run-claude] claude 以 exitCode=0 退出，但产物校验（validate）失败——疑似未真正产出/落盘（stdout 长度 ${stdout.length}）。`)
    : stderr;

  return {
    // ok = 退出码正常 **且** 产物校验通过。二者缺一即失败，交上层处理。
    ok: exitCode === 0 && lastValidated,
    exitCode,
    stdout,
    stderr: finalStderr,
    cmd,
    validated: lastValidated,
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

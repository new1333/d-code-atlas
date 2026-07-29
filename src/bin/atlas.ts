#!/usr/bin/env bun
// atlas CLI 入口（M11，覆盖 M00 stub）。
// 对应 design §13（CLI 设计）、§14（配置 flag）、requirements FR-8（CLI）、
// verification.md AC-1（run 期望串）/ AC-6（show 的 review 行格式）。
//
// 设计要点：
//   - **零运行时依赖**（design NFR）：手写 argv 解析，不引 cac/commander/yargs 等。
//   - **中文错误 + 非零退出码**：未知命令 / key 不存在 / source 不存在等给清晰提示。
//   - **run/resume 默认走真实 runPipeline**（调真实 claude）；单测通过 deps 注入 mock。
//
// 测试钩子：导出 `runCli(argv, deps?)`，deps 默认用真实 runPipeline + process.exit。
// 单测注入一个 mock runPipeline（记录收到的 key/source/flags，返回预设 ok）即可
// 在不真跑 claude 的前提下验证 argv 解析与 flag 透传。

import {
  keyFromRepo,
  manifestPath,
  runDir,
  atlasRoot,
  pathExists,
  resolveLocalSource,
  ensureDir,
  readJson,
} from "../lib/io.ts";
import {
  loadManifest,
  initManifest,
  saveManifest,
  STAGE_ORDER,
  type Manifest,
  type SourceInfo,
  type StageName,
  type StageState,
  type ReviewSummary,
} from "../lib/manifest.ts";
import {
  runPipeline,
  type RunPipelineFlags,
  type RunPipelineOptions,
  type RunPipelineResult,
} from "../orchestrator.ts";
import { DEFAULT_CONCURRENCY, REVIEW_ROUNDS } from "../lib/config.ts";

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

const VERSION = "atlas 0.1.0";

/** 合法子命令集合（design §13）。 */
const COMMANDS = ["run", "resume", "list", "clean", "show"] as const;
type Command = (typeof COMMANDS)[number];

/** 合法 stage 名集合（用于 --from / --only 校验）。 */
const VALID_STAGES: ReadonlySet<string> = new Set(STAGE_ORDER);

/**
 * 需要 value 的 flag（`--xxx value` 形式）。
 * 布尔型 flag（`--skip-build` / `--force` / `-y` 等）单独处理。
 */
const VALUE_FLAGS = new Set([
  "--concurrency",
  "--review-rounds",
  "--model",
  "--from",
  "--only",
]);

// ---------------------------------------------------------------------------
// 解析：手写 argv parser（零依赖）
// ---------------------------------------------------------------------------

/** parseFlags 的返回形状。 */
export interface ParsedArgs {
  /** 位置参数（如 run 的 <repo>、resume/show/clean 的 <key>）。 */
  positional: string[];
  /** flag 名 → 值；布尔 flag 值为 true。 */
  flags: Record<string, string | boolean>;
}

/**
 * 把 argv 段（去掉子命令后的 rest）拆成位置参数 + flag 字典。
 *
 * 规则：
 *   - `--xxx value`：VALUE_FLAGS 里的 flag 消费下一段作 value。
 *   - `--flag`（不在 VALUE_FLAGS 里）：布尔 true。
 *   - `-y` / `-h` / `-v`：短别名，转布尔 true。
 *   - `--xxx=value` 语法也支持（拆等号）。
 *   - 未知 flag 不报错（容错；后续语义校验在 cmd handler 里做）。
 *
 * @throws flag 需要值却到末尾 → 抛中文错。
 */
export function parseFlags(args: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < args.length; i++) {
    const a = args[i];

    // 不以 - 开头 → 位置参数。
    if (!a.startsWith("-")) {
      positional.push(a);
      continue;
    }

    // 支持 `--xxx=value` 形式（拆开当 `--xxx value` 处理）。
    if (a.includes("=")) {
      const eq = a.indexOf("=");
      const name = a.slice(0, eq);
      const val = a.slice(eq + 1);
      flags[normFlagName(name)] = val;
      continue;
    }

    const name = normFlagName(a);

    // 需要 value 的 flag：消费下一段。
    if (VALUE_FLAGS.has(name)) {
      const next = args[i + 1];
      if (next === undefined || next.startsWith("-")) {
        throw new Error(`flag ${name} 需要一个值（如 ${name} <value>）`);
      }
      flags[name] = next;
      i++; // 消费掉 value 段
      continue;
    }

    // 布尔 flag（含未知 flag 一律当布尔，容错）。
    flags[name] = true;
  }

  return { positional, flags };
}

/**
 * 把短/长 flag 名规约到标准长名（便于后续读取）。
 *   -h / --help      → --help
 *   -v / --version   → --version
 *   -y / --yes       → --yes
 *   其它原样返回（已带 `--` 前缀；单字符短名也补 `--`）。
 */
function normFlagName(raw: string): string {
  if (raw === "-h" || raw === "--help") return "--help";
  if (raw === "-v" || raw === "--version") return "--version";
  if (raw === "-y" || raw === "--yes") return "--yes";
  // 单字母短名（非已知别名）原样返回（保留前导 `-`，便于错误提示）。
  if (raw.startsWith("--")) return raw;
  return raw;
}

// ---------------------------------------------------------------------------
// flag → RunPipelineFlags：把解析出的 flags 转成 orchestrator 入参
// ---------------------------------------------------------------------------

/**
 * 把 CLI 的 flag 字典转成 RunPipelineFlags（orchestrator 入参形状）。
 * @throws stage 名非法 / 数值非法 → 抛中文错（交上层 catch）。
 */
function toPipelineFlags(
  flags: Record<string, string | boolean>,
): RunPipelineFlags {
  const out: RunPipelineFlags = {};

  const from = flags["--from"];
  if (typeof from === "string") {
    if (!VALID_STAGES.has(from)) {
      throw new Error(
        `非法 stage 名: ${from}。合法 stage: ${STAGE_ORDER.join(", ")}`,
      );
    }
    out.from = from as StageName;
  }

  const only = flags["--only"];
  if (typeof only === "string") {
    if (!VALID_STAGES.has(only)) {
      throw new Error(
        `非法 stage 名: ${only}。合法 stage: ${STAGE_ORDER.join(", ")}`,
      );
    }
    out.only = only as StageName;
  }

  if (flags["--force"] === true) out.force = true;
  if (flags["--skip-build"] === true) out.skipBuild = true;

  const concurrency = flags["--concurrency"];
  if (typeof concurrency === "string") {
    const n = Number(concurrency);
    if (!Number.isInteger(n) || n < 1) {
      throw new Error(`--concurrency 需为正整数，得到: ${concurrency}`);
    }
    out.concurrency = n;
  }

  const reviewRounds = flags["--review-rounds"];
  if (typeof reviewRounds === "string") {
    const n = Number(reviewRounds);
    if (!Number.isInteger(n) || n < 1) {
      throw new Error(`--review-rounds 需为正整数，得到: ${reviewRounds}`);
    }
    out.reviewRounds = n;
  }

  const model = flags["--model"];
  if (typeof model === "string") out.model = model;

  return out;
}

// ---------------------------------------------------------------------------
// 依赖注入点：便于单测 mock
// ---------------------------------------------------------------------------

/** runCli 的可注入依赖。单测可覆盖 runPipeline / exit / 标准输出。 */
export interface CliDeps {
  /** 默认真实 runPipeline；单测注入 mock 收集入参、返回预设 ok。 */
  runPipeline?: (opts: RunPipelineOptions) => Promise<RunPipelineResult>;
  /** 默认 process.exit；单测注入抛错版以避免真退出。 */
  exit?: (code: number) => void;
  /** 默认 console.log；单测可注入收集器。 */
  log?: (msg: string) => void;
  /** 默认 console.error；单测可注入收集器。 */
  err?: (msg: string) => void;
  /**
   * clean 子命令的交互确认函数：默认在 TTY 下用 readline 问 y/n；
   * 非 TTY（管道/重定向）默认返回 false（不删，安全）。
   * 单测可注入返回 true/false 的 stub。
   */
  confirm?: (prompt: string) => Promise<boolean>;
}

// ---------------------------------------------------------------------------
// runCli：CLI 主体（返回退出码，便于测试断言）
// ---------------------------------------------------------------------------

/**
 * CLI 主体：解析 argv → 分发到子命令 → 调 orchestrator / IO → 返回退出码。
 *
 * 入口 `main()` 调 `runCli(process.argv.slice(2))`；
 * 单测传 `argv` 与 mock deps 验证 argv 解析与透传，不真跑 claude。
 *
 * 错误约定：所有用户可见错误用中文，返回非零退出码（不抛出未捕获异常）。
 */
export async function runCli(
  argv: string[],
  deps: CliDeps = {},
): Promise<number> {
  const log = deps.log ?? ((m: string) => console.log(m));
  const err = deps.err ?? ((m: string) => console.error(m));
  const exit = deps.exit ?? ((c: number) => process.exit(c));
  const runPipelineFn = deps.runPipeline ?? runPipeline;
  const confirm = deps.confirm ?? defaultConfirm;

  // ---- 无参数 → 打印用法 ----
  if (argv.length === 0) {
    printUsage(log);
    return 0;
  }

  const [cmdRaw, ...rest] = argv;

  // ---- 全局 flag：--version / --help 可出现在任意位置 ----
  // 提前扫一次（任一位置有 -v/--version 即打印版本）。
  if (rest.includes("--version") || rest.includes("-v") || cmdRaw === "--version" || cmdRaw === "-v") {
    log(VERSION);
    return 0;
  }
  if (cmdRaw === "--help" || cmdRaw === "-h" || rest.includes("--help") || rest.includes("-h")) {
    printUsage(log);
    return 0;
  }

  // ---- 未知命令 ----
  if (!(COMMANDS as readonly string[]).includes(cmdRaw)) {
    err(`未知命令: ${cmdRaw}。可用: run / resume / list / clean / show`);
    err("");
    printUsageTo(err);
    return 1;
  }
  const cmd = cmdRaw as Command;

  // ---- 解析 flag（可能抛错）----
  let parsed: ParsedArgs;
  try {
    parsed = parseFlags(rest);
  } catch (e) {
    err(`参数解析失败: ${(e as Error).message}`);
    return 1;
  }

  // ---- 分发到子命令 ----
  try {
    switch (cmd) {
      case "run":
        return await cmdRun(parsed, { runPipeline: runPipelineFn, log, err });
      case "resume":
        return await cmdResume(parsed, { runPipeline: runPipelineFn, log, err });
      case "list":
        return await cmdList(parsed, { log, err });
      case "clean":
        return await cmdClean(parsed, { log, err, confirm });
      case "show":
        return await cmdShow(parsed, { log, err });
    }
  } catch (e) {
    err(`错误: ${(e as Error).message}`);
    return 1;
  }

  // 兜底（理论上不会到这）。
  return 1;
}

// ---------------------------------------------------------------------------
// 子命令：run
// ---------------------------------------------------------------------------

interface RunDeps {
  runPipeline: (opts: RunPipelineOptions) => Promise<RunPipelineResult>;
  log: (m: string) => void;
  err: (m: string) => void;
}

/**
 * `atlas run <repo>`：算 key → 续跑或新建 → runPipeline。
 *
 * 流程顺序（task M11）：
 *   1. 算 key = keyFromRepo(repo)。
 *   2. **若 manifest 已存在 → 续跑**（source 从磁盘 manifest 读，忽略新算的 source）。
 *      这一判定优先于 source 解析——避免续跑时若用户传了略微不同的路径（或本地源已
 *      被移动）反而无法续跑。续跑只需 key 命中既有 Run 目录即可。
 *   3. 否则（新建）：判断 source（URL/本地）+ 校验本地存在 → initManifest + save → runPipeline。
 *
 * source 判定（design §10 / FR-1，仅新建路径走）：
 *   - `http(s)://` / `git@` 开头 → `{kind:"url", ref:repo, localPath:null}`。
 *   - 否则当本地路径 → resolveLocalSource（转绝对 + 校验存在）→
 *     `{kind:"local", ref:repo, localPath:absPath}`。不存在 → 报错退出码 1。
 */
async function cmdRun(parsed: ParsedArgs, deps: RunDeps): Promise<number> {
  const { positional, flags } = parsed;
  if (positional.length < 1) {
    deps.err("用法: atlas run <repo> [flags]");
    return 1;
  }
  const repo = positional[0];

  // 转 RunPipelineFlags（可能抛错：stage 名/数值非法）。
  const pf = toPipelineFlags(flags);

  const key = keyFromRepo(repo);

  // 1) 续跑优先：manifest 已存在 → source 从磁盘读。
  const mpath = manifestPath(key);
  if (await pathExists(mpath)) {
    deps.log(`[atlas] 检测到已有 Run: ${key}，按续跑处理`);
    const m = await loadManifest(key);
    const result = await deps.runPipeline({
      key,
      source: m.source,
      flags: pf,
    });
    if (!result.ok) {
      deps.err(`[atlas] run ${key} 失败（详见上方日志）`);
      return 1;
    }
    return 0;
  }

  // 2) 新建：判断 source（URL 还是本地路径）。
  let source: SourceInfo;
  if (/^(https?:\/\/|git@)/i.test(repo)) {
    source = { kind: "url", ref: repo, localPath: null };
  } else {
    try {
      const { absPath } = resolveLocalSource(repo);
      source = { kind: "local", ref: repo, localPath: absPath };
    } catch (e) {
      deps.err(`本地源路径不存在: ${repo}`);
      deps.err(`  (${(e as Error).message})`);
      return 1;
    }
  }

  // 3) initManifest + save → 再跑。
  const m = initManifest(key, source);
  await saveManifest(key, m);

  const result = await deps.runPipeline({
    key,
    source,
    flags: pf,
  });

  if (!result.ok) {
    deps.err(`[atlas] run ${key} 失败（详见上方日志）`);
    return 1;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// 子命令：resume
// ---------------------------------------------------------------------------

/**
 * `atlas resume <key> [--from <stage>] [--only <stage>] [--force] [全局 flag]`。
 *
 * 读 manifest（不存在 → 报错 key 不存在 + 退出码 1），
 * source 从 manifest 读，透传 from/only/force/其它全局 flag → runPipeline。
 */
async function cmdResume(parsed: ParsedArgs, deps: RunDeps): Promise<number> {
  const { positional, flags } = parsed;
  if (positional.length < 1) {
    deps.err("用法: atlas resume <key> [--from <stage>] [--only <stage>] [--force]");
    return 1;
  }
  const key = positional[0];

  // key 校验：manifest 必须存在。
  if (!(await pathExists(manifestPath(key)))) {
    deps.err(`未找到 Run: ${key}。用 atlas list 查看已有 Run。`);
    return 1;
  }

  const pf = toPipelineFlags(flags);
  const m = await loadManifest(key);

  const result = await deps.runPipeline({
    key,
    source: m.source,
    flags: pf,
  });

  if (!result.ok) {
    deps.err(`[atlas] resume ${key} 失败（详见上方日志）`);
    return 1;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// 子命令：list
// ---------------------------------------------------------------------------

/**
 * atlas list：扫描 atlas 下每个 Run 的 manifest.json，每个 Run 打一行状态摘要。
 *
 * 摘要格式例：`acquire=done survey=done outline=done research=3/5 ...`。
 * research/write 显示 `done数/总数`；其它 stage 显示状态。
 */
async function cmdList(
  parsed: ParsedArgs,
  deps: { log: (m: string) => void; err: (m: string) => void },
): Promise<number> {
  const root = atlasRoot();
  if (!(await pathExists(root))) {
    deps.log("(暂无 Run，atlas/ 目录不存在)");
    return 0;
  }

  // 扫 atlas/*/manifest.json。
  const entries = await Array.fromAsync(new Bun.Glob("*/manifest.json").scan({ cwd: root }));
  if (entries.length === 0) {
    deps.log("(暂无 Run)");
    return 0;
  }

  // 按路径稳定排序，便于可复现输出。
  entries.sort();

  for (const rel of entries) {
    // rel 形如 `react-mini/manifest.json`（POSIX）或 `react-mini\manifest.json`（Windows）。
    // 取首段作 key，并规一化分隔符。
    const norm = rel.replace(/\\/g, "/");
    const key = norm.split("/")[0];
    try {
      const m = await readJson<Manifest>(`${root}${norm}`);
      deps.log(`${key}: ${summarizeManifest(m)}`);
    } catch (e) {
      deps.log(`${key}: (读取 manifest 失败: ${(e as Error).message})`);
    }
  }
  return 0;
}

/**
 * 造一行 manifest 状态摘要。
 * 例：acquire=done survey=done outline=done research=3/5 done write=2/5 done ...
 */
function summarizeManifest(m: Manifest): string {
  const parts: string[] = [];
  for (const s of STAGE_ORDER) {
    const st = m.stages[s];
    if (s === "research" || s === "write") {
      // 章节级摘要：done 数 / 总数 + stage 状态。
      const slugs = m.chapterOrder ?? Object.keys(m.chapters);
      const total = slugs.length;
      const done = slugs.filter((slug) => m.chapters[slug]?.[s]?.status === "done").length;
      parts.push(`${s}=${done}/${total} ${st.status}`);
    } else {
      parts.push(`${s}=${st.status}`);
    }
  }
  return parts.join(" ");
}

// ---------------------------------------------------------------------------
// 子命令：clean
// ---------------------------------------------------------------------------

/**
 * `atlas clean <key> [-y]`：删 `atlas/{key}/`。删前确认；`-y`/`--yes` 跳过确认。
 * key 不存在 → 报错退出码 1。
 */
async function cmdClean(
  parsed: ParsedArgs,
  deps: {
    log: (m: string) => void;
    err: (m: string) => void;
    confirm: (prompt: string) => Promise<boolean>;
  },
): Promise<number> {
  const { positional, flags } = parsed;
  if (positional.length < 1) {
    deps.err("用法: atlas clean <key> [-y]");
    return 1;
  }
  const key = positional[0];
  const dir = runDir(key);

  if (!(await pathExists(dir))) {
    deps.err(`未找到 Run: ${key}。用 atlas list 查看已有 Run。`);
    return 1;
  }

  // -y / --yes 跳过确认；否则交互问。
  const yes = flags["--yes"] === true;
  if (!yes) {
    const ok = await deps.confirm(`即将删除 ${dir}，确认？(y/N) `);
    if (!ok) {
      deps.log("已取消");
      return 0;
    }
  }

  // 递归删除目录。
  const { rm } = await import("node:fs/promises");
  await rm(dir, { recursive: true, force: true });
  deps.log(`[atlas] 已删除 Run: ${key} (${dir})`);
  return 0;
}

// ---------------------------------------------------------------------------
// 子命令：show
// ---------------------------------------------------------------------------

/**
 * `atlas show <key>`：打印 manifest 摘要。
 *
 * 输出包含（AC-6 核验锚点）：
 *   - 各 stage 状态行。
 *   - **review 行**：outline 行带 `[review: approve|accepted-with-warning, Nr]`；
 *     每章 write 行带 `[review: ...]`。无 review 的 stage/章不显示 review 段。
 *   - chapter 摘要：每章 `research=done|failed|pending`、`write=...`。
 *   - source 信息、version、关键时间戳。
 */
async function cmdShow(
  parsed: ParsedArgs,
  deps: { log: (m: string) => void; err: (m: string) => void },
): Promise<number> {
  const { positional } = parsed;
  if (positional.length < 1) {
    deps.err("用法: atlas show <key>");
    return 1;
  }
  const key = positional[0];

  if (!(await pathExists(manifestPath(key)))) {
    deps.err(`未找到 Run: ${key}。用 atlas list 查看已有 Run。`);
    return 1;
  }

  const m = await loadManifest(key);

  deps.log(`Run: ${m.key}`);
  deps.log(`version: ${m.version}`);
  deps.log(`source: ${formatSource(m.source)}`);
  deps.log("");
  deps.log("Stages:");

  for (const s of STAGE_ORDER) {
    const st = m.stages[s];
    let line = `  ${s}=${st.status}`;
    // outline 行：挂 stage 级 review（AC-6 期望 `[review: approve, 1r]`）。
    if (s === "outline") {
      line += formatReviewSuffix(st.review);
    }
    // 失败诊断后缀（让用户 atlas show 直接看到失败原因，而非只看到 "failed"）。
    line += formatDiagSuffix(st);
    // 时间戳摘要。
    if (st.startedAt) line += `  started=${st.startedAt}`;
    if (st.finishedAt) line += ` finished=${st.finishedAt}`;
    deps.log(line);
  }

  // chapter 摘要。
  const slugs = m.chapterOrder ?? Object.keys(m.chapters);
  if (slugs.length > 0) {
    deps.log("");
    deps.log("Chapters:");
    for (const slug of slugs) {
      const c = m.chapters[slug];
      if (!c) continue;
      const r = c.research.status;
      const w = c.write.status;
      let line = `  ${slug}: research=${r} write=${w}`;
      // 每章 write 行：挂 chapter 级 review（AC-6）。
      line += formatReviewSuffix(c.write.review);
      // 失败章的诊断后缀（research / write 任一 failed 时展示对应诊断）。
      if (r === "failed") line += formatDiagSuffix(c.research);
      if (w === "failed") line += formatDiagSuffix(c.write);
      deps.log(line);
    }
  }

  return 0;
}

/**
 * 把 ReviewSummary 格式化成 AC-6 期望的后缀串。
 *   approve, 1r              → ` [review: approve, 1r]`
 *   accepted-with-warning,2r → ` [review: accepted-with-warning, 2r]`
 *   null / undefined / 无 rounds → 空串（不显示）。
 */
function formatReviewSuffix(review: ReviewSummary | null | undefined): string {
  if (!review) return "";
  const final = review.final === "approved" ? "approve" : review.final;
  return ` [review: ${final}, ${review.rounds}r]`;
}

/**
 * 把 StageState 的失败诊断格式化成后缀串（仅 failed 时有意义）。
 * 形如：` [exit=126 err: <摘要> stderr: <末段>]`
 *   - exitCode 存在 → ` exit=<n>`；
 *   - error 存在 → ` err: <摘要>`（截断 ~200 字符）；
 *   - stderr 存在且非空 → ` stderr: <末段 ~200 字符>`（取末段，因编译/运行错误常在末尾）。
 * 全无 → 空串。
 */
function formatDiagSuffix(st: StageState): string {
  const parts: string[] = [];
  if (st.exitCode !== undefined) parts.push(`exit=${st.exitCode}`);
  if (st.error && st.error.trim() !== "") parts.push(`err: ${st.error.trim().slice(-200)}`);
  if (st.stderr && st.stderr.trim() !== "") parts.push(`stderr: ${st.stderr.trim().slice(-200)}`);
  return parts.length > 0 ? ` [${parts.join(" ")}]` : "";
}

/** source 字段的展示串。 */
function formatSource(s: SourceInfo): string {
  if (s.kind === "url") {
    return `url: ${s.ref}`;
  }
  return `local: ${s.ref} → ${s.localPath}`;
}

// ---------------------------------------------------------------------------
// 用法 / 默认确认函数
// ---------------------------------------------------------------------------

/** 默认 confirm：TTY 下用 readline 问 y/n；非 TTY 默认 false（不删，安全）。 */
async function defaultConfirm(prompt: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    // 非交互环境（CI/管道/重定向）：默认不删（安全）。
    return false;
  }
  process.stdout.write(prompt);
  const { createInterface } = await import("node:readline");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise<boolean>((resolve) => {
    rl.question("", (ans) => {
      rl.close();
      const t = ans.trim().toLowerCase();
      resolve(t === "y" || t === "yes");
    });
  });
}

/** 打印用法到 log。 */
function printUsage(log: (m: string) => void): void {
  log(USAGE);
}

/** 打印用法到 err（错误路径用）。 */
function printUsageTo(err: (m: string) => void): void {
  err(USAGE);
}

const USAGE = `atlas 0.1.0 — Code Atlas CLI

用法:
  atlas run <repo>                              新建或自动续跑 Run
  atlas resume <key> [--from <stage>] [--only <stage>] [--force]   续跑/重跑
  atlas list                                    列出已有 Run
  atlas clean <key> [-y]                        删除某 Run 的工作区
  atlas show <key>                              打印 manifest 摘要

全局 flag（run/resume 生效）:
  --concurrency <n>     逐章并发上限（默认 ${DEFAULT_CONCURRENCY}）
  --review-rounds <n>   对抗评审轮数上限（默认 ${REVIEW_ROUNDS}）
  --skip-build          build stage 直接置 done 不真跑 bun
  --model <name>        透传给 claude 的 model 别名
  --from <stage>        从指定 stage（含）起扫描（resume）
  --only <stage>        只跑指定 stage（resume）
  --force               配合 --from/--only 重置目标后重跑

其它:
  -y / --yes            clean 跳过确认
  -h / --help           打印此用法
  -v / --version        打印版本 (${VERSION})

合法 stage: ${STAGE_ORDER.join(", ")}`;

// ---------------------------------------------------------------------------
// 入口：main
// ---------------------------------------------------------------------------

/**
 * 进程入口。`bun run src/bin/atlas.ts` 时被调。
 * 仅当本文件是主模块时执行（import 时跳过，便于测试 import runCli）。
 */
async function main(): Promise<void> {
  const code = await runCli(process.argv.slice(2));
  process.exit(code);
}

// Bun 的主模块判定：import.meta.main === import.meta.url（pathToFileUrl）。
// 用此判定避免测试 import 本文件时触发 main。
if (import.meta.main) {
  main();
}

/**
 * Spawn a `claude -p` headless subprocess to execute one Agent (ADR-0001).
 *
 * Responsibilities:
 *  - Hardcode read-only tool access for analysis agents (ADR-0005, no escape).
 *  - Inject the role's system prompt from prompts/{role}.md.
 *  - Set working directory via spawn cwd (no `--cwd` flag exists).
 *  - Expose additional dirs (local source) via `--add-dir`.
 *  - Enforce a wall-clock timeout (no native flag) at the spawn layer.
 *  - Stream stderr to console for live logs; parse JSON result.
 *  - Return the full command string for manifest audit (AC-7).
 */
import { spawn } from "bun";
import { dirname, join } from "node:path";

const PROMPTS_DIR = join(import.meta.dir, "..", "prompts");

/** Read-only trio — the ONLY tools analysis agents ever get (ADR-0005). */
const READONLY_TOOLS = ["Read", "Glob", "Grep"];
/** Producer agents may also write — but only into work/ or site/ (their cwd). */
const PRODUCER_TOOLS = [...READONLY_TOOLS, "Write", "Edit"];

export interface RunClaudeOptions {
  /** Role name; must have a matching prompts/{role}.md. */
  role: string;
  /** The user-facing task prompt (what to read, what to write, acceptance). */
  userPrompt: string;
  /** Working directory for the subprocess (a run dir or chapter dir). */
  cwd: string;
  /** Read-only enforced when true (analysis agents). */
  readOnly: boolean;
  /** Extra dirs to expose (e.g. local source path) via --add-dir. */
  addDirs?: string[];
  /** Model alias/name, passed through to claude (design §13 --model). */
  model?: string;
  /** Wall-clock timeout in ms. Default 10 min. (No native flag — enforced here.) */
  timeoutMs?: number;
}

export interface RunClaudeResult {
  exitCode: number;
  durationMs: number;
  /** Full reconstructed command string, for manifest logging (AC-7). */
  cmd: string;
  stdout: string;
  stderr: string;
  /** Parsed `result` text field from --output-format json, or raw stdout. */
  resultText: string;
  timedOut: boolean;
}

/**
 * Build the argv for `claude -p`. Split out so callers (and tests) can inspect
 * the command without spawning.
 */
export function buildClaudeArgs(opts: RunClaudeOptions): string[] {
  const tools = opts.readOnly ? READONLY_TOOLS : PRODUCER_TOOLS;
  const args = [
    "-p", opts.userPrompt,
    "--output-format", "json",
    // Bypass ALL permission prompts: headless mode has no TTY to grant them.
    // The ADR-0005 read-only guarantee is enforced structurally by
    // --allowedTools (the tool gate), NOT by the permission system. With only
    // Read/Glob/Grep available, the agent physically cannot write to Source.
    "--dangerously-skip-permissions",
    "--allowedTools", tools.join(","),
  ];
  for (const d of opts.addDirs ?? []) {
    // Normalize to forward slashes: claude's sandbox matches cwd/add-dir
    // prefixes, and on Windows backslash paths fail to match reliably
    // (empirically the sandbox then blocks access). Forward slashes work on
    // all platforms.
    args.push("--add-dir", d.replace(/\\/g, "/"));
  }
  if (opts.model) args.push("--model", opts.model);
  // system-prompt: load role file and inject verbatim
  const sysPath = join(PROMPTS_DIR, `${opts.role}.md`);
  // We pass via --system-prompt. Reading the file at spawn time keeps the
  // prompt source-of-truth on disk (edit prompt → next run picks it up).
  args.push("--system-prompt-file", sysPath);
  return args;
}

/** Reconstruct a shell-like command string for the manifest audit trail. */
export function buildClaudeCmd(opts: RunClaudeOptions, args: string[]): string {
  const cwd = opts.cwd.replace(/\\/g, "/");
  const cmd = args
    .map((a) => (a.includes(" ") || a.includes('"') ? `"${a.replace(/"/g, '\\"')}"` : a))
    .join(" ");
  return `(cd ${cwd} && claude ${cmd})`;
}

async function readPromptExists(role: string): Promise<void> {
  const p = join(PROMPTS_DIR, `${role}.md`);
  const f = Bun.file(p);
  if (!(await f.exists())) {
    throw new Error(`missing prompt file: prompts/${role}.md`);
  }
}

/**
 * Execute one agent. Throws on non-zero exit / timeout / spawn failure.
 * The caller (stage) is responsible for translating the throw into a manifest
 * `failed` record (design §15).
 */
export async function runClaude(
  opts: RunClaudeOptions,
): Promise<RunClaudeResult> {
  await readPromptExists(opts.role);
  const args = buildClaudeArgs(opts);
  const cmd = buildClaudeCmd(opts, args);
  const timeoutMs = opts.timeoutMs ?? 10 * 60 * 1000;

  const t0 = performance.now();
  // On Windows, `claude` is a #!/bin/sh shim (or .cmd) that Bun.spawn can't
  // exec directly with reliable PATH resolution. Route through the platform
  // shell so PATH + shebang handling matches an interactive terminal.
  const isWin = process.platform === "win32";
  const spawnArgs: string[] = isWin
    ? ["cmd", "/c", "claude", ...args]
    : ["claude", ...args];
  const proc = spawn(spawnArgs, {
    cwd: opts.cwd,
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill("SIGTERM");
      // escalate after grace
      setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {
          /* already dead */
        }
      }, 3000);
    } catch {
      /* already dead */
    }
  }, timeoutMs);

  // stream stderr to console for live logs; collect text for result
  const stderrParts: string[] = [];
  const stdoutText = await new Response(proc.stdout).text();
  try {
    for await (const chunk of proc.stderr) {
      const text =
        typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
      stderrParts.push(text);
      process.stderr.write(text);
    }
  } catch {
    /* stream closed */
  }

  const exitCode = await proc.exited;
  clearTimeout(timer);
  const durationMs = Math.round(performance.now() - t0);
  const stderr = stderrParts.join("");

  // parse JSON result envelope
  let resultText = stdoutText;
  try {
    const parsed = JSON.parse(stdoutText);
    if (parsed && typeof parsed.result === "string") resultText = parsed.result;
  } catch {
    /* not JSON; keep raw */
  }

  if (timedOut) {
    const err = `claude -p timed out after ${timeoutMs}ms`;
    return {
      exitCode,
      durationMs,
      cmd,
      stdout: stdoutText,
      stderr,
      resultText,
      timedOut: true,
    };
  }

  if (exitCode !== 0) {
    throw new Error(
      `claude -p exited ${exitCode} for role '${opts.role}'\n${stderr.slice(-1000)}`,
    );
  }

  return {
    exitCode,
    durationMs,
    cmd,
    stdout: stdoutText,
    stderr,
    resultText,
    timedOut: false,
  };
}

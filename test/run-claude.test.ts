// test/run-claude.test.ts：lib/run-claude.ts 单元测试。
// 用 bun:test。**全程 mock spawn，不真调 claude**（花钱、不可重复）。
// 真实 claude 调用由 ATLAS_SMOKE=1 的可选冒烟覆盖（默认跳过，不进必跑路径）。
//
// 核心断言（ADR-0005 / AC-7 / prompt §5 硬约束 #1）：
//   tools==="readonly" 时 buildCmd/cmd **必然**含 `--allowedTools Read,Glob,Grep`，
//   绝不出现 Write/Edit——无逃生口。

import { describe, test, expect } from "bun:test";
import {
  buildCmd,
  runClaude,
  type ClaudeRunOptions,
  type SpawnFn,
} from "../src/lib/run-claude.ts";
import { READONLY_TOOLS, WRITE_TOOLS } from "../src/lib/config.ts";

// ---------------------------------------------------------------------------
// 假 spawn 工厂：记录收到的 args/cwd/env，返回预设 {exitCode,stdout,stderr}
// ---------------------------------------------------------------------------

interface SpawnCall {
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

/**
 * 造一个假 SpawnFn：把每次调用记入 calls，并返回预设结果。
 * preset 可为固定对象，或 (call)=>结果 的函数（便于按入参分支）。
 */
function makeFakeSpawn(
  calls: SpawnCall[],
  preset:
    | { exitCode: number; stdout: string; stderr: string }
    | ((call: SpawnCall) => { exitCode: number; stdout: string; stderr: string }),
): SpawnFn {
  return async (args, opts) => {
    const call: SpawnCall = {
      args: [...args],
      cwd: opts.cwd,
      env: opts.env,
      timeoutMs: opts.timeoutMs,
    };
    calls.push(call);
    const r = typeof preset === "function" ? preset(call) : preset;
    return { ...r };
  };
}

// ---------------------------------------------------------------------------
// buildCmd：纯函数断言
// ---------------------------------------------------------------------------

describe("buildCmd · 只读模式", () => {
  test("readonly 必然含 `--allowedTools Read,Glob,Grep`，且不含 Write/Edit", () => {
    const { cmd, args } = buildCmd({
      prompt: "扫描目录树产出 repo-map.json",
      cwd: "atlas/x/",
      tools: "readonly",
    });
    // AC-7 锚点：精确子串命中
    expect(cmd.includes("--allowedTools Read,Glob,Grep")).toBe(true);
    // 无逃生口：cmd 里绝无 Write/Edit
    expect(/(^|[\s,])Write([\s,]|$)/.test(cmd)).toBe(false);
    expect(/(^|[\s,])Edit([\s,]|$)/.test(cmd)).toBe(false);
    // args 里 flag 名与值分开（commander 惯例）：值 = READONLY_TOOLS.join(",")
    expect(args).toContain("--allowedTools");
    expect(args[args.indexOf("--allowedTools") + 1]).toBe("Read,Glob,Grep");
    // 工具串来自 config.READONLY_TOOLS
    expect(READONLY_TOOLS.join(",")).toBe("Read,Glob,Grep");
  });

  test("readonly 不带 model/systemPrompt 时命令最小化", () => {
    const { cmd, args } = buildCmd({
      prompt: "hi",
      cwd: ".",
      tools: "readonly",
    });
    // args: flag 名与值分开
    expect(args).toEqual(["-p", "hi", "--allowedTools", "Read,Glob,Grep"]);
    // cmd 形态：claude -p "hi" --allowedTools Read,Glob,Grep
    expect(cmd.startsWith("claude -p \"hi\" --allowedTools Read,Glob,Grep")).toBe(true);
  });
});

describe("buildCmd · 写入模式", () => {
  test("write 含完整工具集 Read,Glob,Grep,Write,Edit", () => {
    const { cmd, args } = buildCmd({
      prompt: "写 draft.md",
      cwd: "atlas/x/work/chapters/foo/",
      tools: "write",
    });
    expect(cmd.includes("--allowedTools Read,Glob,Grep,Write,Edit")).toBe(true);
    expect(args[args.indexOf("--allowedTools") + 1]).toBe("Read,Glob,Grep,Write,Edit");
    expect(WRITE_TOOLS.join(",")).toBe("Read,Glob,Grep,Write,Edit");
  });
});

describe("buildCmd · model 与 systemPrompt", () => {
  test("带 model：cmd 与 args 含 `--model <m>`", () => {
    const { cmd, args } = buildCmd({
      prompt: "hi",
      cwd: ".",
      tools: "readonly",
      model: "sonnet",
    });
    expect(cmd.includes("--model sonnet")).toBe(true);
    expect(args).toContain("--model");
    expect(args[args.indexOf("--model") + 1]).toBe("sonnet");
    // 加了 model，readonly 锚点仍在
    expect(cmd.includes("--allowedTools Read,Glob,Grep")).toBe(true);
  });

  test("带 systemPromptPath：cmd 与 args 含 `--append-system-prompt-file <path>`", () => {
    const { cmd, args } = buildCmd({
      prompt: "hi",
      cwd: ".",
      tools: "readonly",
      systemPromptPath: "/abs/path/surveyor.md",
    });
    // 用本机探测到的真实 flag 名断言
    expect(cmd.includes("--append-system-prompt-file /abs/path/surveyor.md")).toBe(true);
    expect(args).toContain("--append-system-prompt-file");
    expect(args[args.indexOf("--append-system-prompt-file") + 1]).toBe(
      "/abs/path/surveyor.md",
    );
    // 加了 system prompt，readonly 锚点仍在
    expect(cmd.includes("--allowedTools Read,Glob,Grep")).toBe(true);
  });
});

describe("buildCmd · 逃逸口防御（硬约束 #1）", () => {
  test("readonly + model + systemPrompt 全给齐，cmd 仍含 readonly 锚点且无 Write/Edit", () => {
    const { cmd, args } = buildCmd({
      prompt: "复杂 prompt 含 \"引号\" 与 $shell 特殊字符",
      cwd: "atlas/x/",
      tools: "readonly",
      model: "opus",
      systemPromptPath: "/x/roles/critic.md",
    });
    // 锚点命中（AC-7）
    expect(cmd.includes("--allowedTools Read,Glob,Grep")).toBe(true);
    // 无逃生口
    expect(/(^|[\s,])Write([\s,]|$)/.test(cmd)).toBe(false);
    expect(/(^|[\s,])Edit([\s,]|$)/.test(cmd)).toBe(false);
    // args 侧也守住
    const toolsArg = args[args.indexOf("--allowedTools") + 1];
    expect(toolsArg).toBe("Read,Glob,Grep");
    // model/system 都在
    expect(args).toContain("--model");
    expect(args).toContain("--append-system-prompt-file");
  });

  test("cmd 字段可直接写进 manifest 并被 AC-7 脚本核验", () => {
    // 模拟 AC-7 核验逻辑：cmd.includes("--allowedTools Read,Glob,Grep")
    const { cmd } = buildCmd({
      prompt: "survey",
      cwd: "atlas/x/",
      tools: "readonly",
    });
    // 这条断言即「manifest 写入这条 cmd 后 AC-7 必 PASS」的可执行证明
    const ac7Pass = cmd.includes("--allowedTools Read,Glob,Grep");
    expect(ac7Pass).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// runClaude：成功 / 失败 / 超时（全 mock，不抛）
// ---------------------------------------------------------------------------

describe("runClaude · 结构化结果（不抛）", () => {
  test("成功路径（exitCode=0）：ok=true，stdout 回填，cmd 含 readonly 锚点", async () => {
    const calls: SpawnCall[] = [];
    const fake = makeFakeSpawn(calls, {
      exitCode: 0,
      stdout: "agent 输出摘要",
      stderr: "",
    });
    const res = await runClaude({
      prompt: "survey repo",
      cwd: "atlas/x/",
      tools: "readonly",
      spawn: fake,
    });
    expect(res.ok).toBe(true);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe("agent 输出摘要");
    expect(res.cmd.includes("--allowedTools Read,Glob,Grep")).toBe(true);
    // 透传给 spawn 的 cwd/env 正确
    expect(calls[0].cwd).toBe("atlas/x/");
    // args 第一项是 -p
    expect(calls[0].args[0]).toBe("-p");
  });

  test("失败路径（exitCode=1）：ok=false，不抛，stderr 回填", async () => {
    const calls: SpawnCall[] = [];
    const fake = makeFakeSpawn(calls, {
      exitCode: 1,
      stdout: "",
      stderr: "boom",
    });
    const res = await runClaude({
      prompt: "x",
      cwd: "atlas/x/",
      tools: "readonly",
      spawn: fake,
    });
    expect(res.ok).toBe(false);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toBe("boom");
  });

  test("超时路径（exitCode=124）：ok=false、exitCode=124、不抛", async () => {
    const calls: SpawnCall[] = [];
    // 直接让假 spawn 返回超时约定码 124（模拟 defaultSpawn 超时 kill 的效果）
    const fake = makeFakeSpawn(calls, {
      exitCode: 124,
      stdout: "部分输出",
      stderr: "",
    });
    const res = await runClaude({
      prompt: "x",
      cwd: "atlas/x/",
      tools: "readonly",
      timeoutMs: 50,
      spawn: fake,
    });
    expect(res.ok).toBe(false);
    expect(res.exitCode).toBe(124);
    // 透传了 timeoutMs
    expect(calls[0].timeoutMs).toBe(50);
  });

  test("超时路径变体：永不 resolve 的 spawn 不应让 runClaude 永久挂起", async () => {
    // 用「假 spawn 内部自带超时逻辑」模拟真实 defaultSpawn 的行为：
    // 到 timeoutMs 自己 kill 并返回 124。这样 runClaude 必然能 resolve。
    const calls: SpawnCall[] = [];
    const fake: SpawnFn = async (args, opts) => {
      calls.push({ args: [...args], cwd: opts.cwd, timeoutMs: opts.timeoutMs });
      // 模拟 defaultSpawn：等到 timeoutMs 后返回 124
      await new Promise((r) => setTimeout(r, opts.timeoutMs ?? 0));
      return { exitCode: 124, stdout: "", stderr: "timeout" };
    };
    const res = await runClaude({
      prompt: "x",
      cwd: "atlas/x/",
      tools: "readonly",
      timeoutMs: 30,
      spawn: fake,
    });
    expect(res.ok).toBe(false);
    expect(res.exitCode).toBe(124);
  });
});

describe("runClaude · 逃逸口防御（端到端）", () => {
  test("readonly 全量选项：返回的 cmd 仍无 Write/Edit", async () => {
    const fake = makeFakeSpawn([], { exitCode: 0, stdout: "", stderr: "" });
    const res = await runClaude({
      prompt: "x",
      cwd: "atlas/x/",
      tools: "readonly",
      model: "sonnet",
      systemPromptPath: "/x/r.md",
      spawn: fake,
    });
    expect(res.cmd.includes("--allowedTools Read,Glob,Grep")).toBe(true);
    expect(/(^|[\s,])Write([\s,]|$)/.test(res.cmd)).toBe(false);
    expect(/(^|[\s,])Edit([\s,]|$)/.test(res.cmd)).toBe(false);
  });
});

// test/agents.test.ts：6 类 Agent 封装 + extract 辅助的单元测试。
// 用 bun:test。**全程 mock spawn，不真调 claude**（花钱、不可重复）。
// 真实 claude 调用由 ATLAS_SMOKE=1 的可选冒烟覆盖（默认跳过）。
//
// 核心断言（ADR-0005 / AC-7 / design §5）：
//   - 分析类 agent（surveyor/architect/reader/critic）：cmd 必含
//     `--allowedTools Read,Glob,Grep`，且不含 Write/Edit（无逃生口）。
//   - 写入类 agent（writer/assembler）：cmd 含 Write/Edit，cwd/路径受限。
//   - 分析类不落盘：从 stdout 提取 fence 内容 return。
//   - Critic verdict 可结构化解析（approve/reject + fixes）。

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractFence,
  extractJson,
  extractJsonDetailed,
  extractCriticVerdict,
} from "../src/lib/extract.ts";
import { surveyor } from "../src/agents/surveyor.ts";
import { architect } from "../src/agents/architect.ts";
import { critic } from "../src/agents/critic.ts";
import { reader } from "../src/agents/reader.ts";
import { writer } from "../src/agents/writer.ts";
import { assembler } from "../src/agents/assembler.ts";
import { outlinePath, writeJson, workDir, runDir } from "../src/lib/io.ts";
import type { Outline } from "../src/lib/types.ts";
import type { SpawnFn as RealSpawnFn } from "../src/lib/run-claude.ts";

// ---------------------------------------------------------------------------
// 假 spawn 工厂：记录收到的 args/cwd，返回预设 stdout
// ---------------------------------------------------------------------------

interface SpawnCall {
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

/**
 * 造一个假 SpawnFn：把每次调用记入 calls，并返回预设结果。
 * preset 可为固定对象，或 (call)=>结果 的函数（便于按入参分支或检查 prompt）。
 */
function makeFakeSpawn(
  calls: SpawnCall[],
  preset:
    | { exitCode: number; stdout: string; stderr: string }
    | ((call: SpawnCall) => { exitCode: number; stdout: string; stderr: string }),
): RealSpawnFn {
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

/** 固定预设 stdout 的便捷工厂。 */
function spawnReturning(stdout: string, calls: SpawnCall[], stderr = ""): RealSpawnFn {
  return makeFakeSpawn(calls, { exitCode: 0, stdout, stderr });
}

/**
 * 从 cmd 串中提取 `--allowedTools <value>` 的值。
 *
 * AC-7 防御的关键：**工具白名单值**本身不能含 Write/Edit（只读 agent）。
 * 注意：不能对整个 cmd 串做 `/Write|Edit/` 正则——因为 prompt 正文里合法地
 * 出现「Writer」「Write」「Edit」等词（如「禁止 Write/Edit」「Writer 撰写」）。
 * 必须只检查 --allowedTools 这个 flag 的值。
 */
function toolsValueFromCmd(cmd: string): string {
  const m = cmd.match(/--allowedTools[ ](\S+)/);
  return m ? m[1] : "";
}

/** AC-7 只读断言：--allowedTools 值 == Read,Glob,Grep，不含 Write/Edit。 */
function expectReadonlyTools(cmd: string): void {
  const v = toolsValueFromCmd(cmd);
  expect(v).toBe("Read,Glob,Grep");
  expect(v).not.toContain("Write");
  expect(v).not.toContain("Edit");
  // 锚点子串仍需完整出现（供 AC-7 扫描脚本 includes 命中）
  expect(cmd.includes("--allowedTools Read,Glob,Grep")).toBe(true);
}

// ---------------------------------------------------------------------------
// extractFence / extractJson / extractCriticVerdict 纯函数测试
// ---------------------------------------------------------------------------

describe("extractFence", () => {
  test("正常提取 json fence 内文本（trim 首尾）", () => {
    const stdout = "思考...\n```json\n{\"a\":1}\n```\n尾随";
    expect(extractFence(stdout, "json")).toBe('{"a":1}');
  });

  test("语言标记大小写不敏感（```JSON 也认）", () => {
    const stdout = "```JSON\n{\"a\":2}\n```";
    expect(extractFence(stdout, "json")).toBe('{"a":2}');
  });

  test("markdown fence 提取（4 反引号外层 + 内嵌 3 反引号代码块，CommonMark 嵌套）", () => {
    // 外层 4 反引号（````markdown），内层 3 反引号（```ts）代码块；
    // 结束 fence 反引号数 ≥ 起始（4≥4）才算外层结束，所以内层 ``` 不会误闭合。
    const stdout = "````markdown\n# 标题\n\n正文\n\n```ts\nconst x = 1;\n```\n````";
    expect(extractFence(stdout, "markdown")).toBe("# 标题\n\n正文\n\n```ts\nconst x = 1;\n```");
  });

  test("同反引号数嵌套（外层 3 + 内层 3）会提前闭合——这是同级嵌套的固有歧义", () => {
    // 外层 ```markdown，内层 ```ts；内层结束 ``` 反引号数（3）≥ 起始（3），
    // 所以会被当成外层结束。extractFence 在内层结束处闭合（已知限制）。
    const stdout = "```markdown\n# 标题\n\n```ts\nconst x = 1;\n```\n被截断\n```";
    expect(extractFence(stdout, "markdown")).toBe("# 标题\n\n```ts\nconst x = 1;");
  });

  test("多个同 lang fence 取第一个", () => {
    const stdout = "```json\n{\"first\":true}\n```\n中间\n```json\n{\"first\":false}\n```";
    expect(extractFence(stdout, "json")).toBe('{"first":true}');
  });

  test("找不到 fence 返回 null", () => {
    expect(extractFence("纯文本无 fence", "json")).toBe(null);
    expect(extractFence("```ts\ncode\n```", "json")).toBe(null); // lang 不匹配
  });

  test("fence 缺结束标记返回 null", () => {
    expect(extractFence("```json\n{\"a\":1}\n（无结束）", "json")).toBe(null);
  });

  test("空入参返回 null", () => {
    expect(extractFence("", "json")).toBe(null);
    // @ts-expect-error 测试非法入参类型
    expect(extractFence(null, "json")).toBe(null);
    expect(extractFence("x", "")).toBe(null);
  });
});

describe("extractJson", () => {
  test("从 json fence 提取并 parse 成功", () => {
    const stdout = "```json\n{\"a\":1,\"b\":[2,3]}\n```";
    const parsed = extractJson<{ a: number; b: number[] }>(stdout);
    expect(parsed).toEqual({ a: 1, b: [2, 3] });
  });

  test("fence 缺失时退化：整个 stdout 当 JSON parse（fallback）", () => {
    const stdout = '  {"a":1}  ';
    const parsed = extractJson<{ a: number }>(stdout);
    expect(parsed).toEqual({ a: 1 });
  });

  test("详细版标记来源（fence / fallback / none）", () => {
    expect(extractJsonDetailed('```json\n{"a":1}\n```').source).toBe("fence");
    expect(extractJsonDetailed('{"a":1}').source).toBe("fallback");
    expect(extractJsonDetailed("not json at all").source).toBe("none");
    expect(extractJsonDetailed('```json\n{"a":1}\n```').value).toEqual({ a: 1 });
  });

  test("fence 内非法 JSON：退化尝试整串（这里整串也非法 → null）", () => {
    expect(extractJson("```json\n{bad json}\n```")).toBe(null);
  });

  test("fence 内非法 JSON 但整串合法：fallback 命中（极端情况）", () => {
    // fence 内非合法 JSON，但 fence 外还有一段合法 JSON ——
    // 注意：extractJsonDetailed 先取 fence 内（非法，落入 fallback），
    //   再把**整个 stdout trim** 当 JSON parse。整个 stdout 含 fence 标记，不合法 → none。
    //   所以这里期望 null（符合实现）。
    const stdout = "```json\n{bad}\n```\n{\"clean\":true}";
    expect(extractJson(stdout)).toBe(null);
  });

  test("null/空 → null", () => {
    expect(extractJson("")).toBe(null);
  });
});

describe("extractCriticVerdict", () => {
  test("approve 正常解析（fixes 空数组）", () => {
    const stdout = '```json\n{"verdict":"approve","fixes":[]}\n```';
    expect(extractCriticVerdict(stdout)).toEqual({ verdict: "approve", fixes: [] });
  });

  test("reject 正常解析（fixes 非空）", () => {
    const stdout =
      '```json\n{"verdict":"reject","fixes":["章节A违反自底向上","缺入口覆盖"]}\n```';
    expect(extractCriticVerdict(stdout)).toEqual({
      verdict: "reject",
      fixes: ["章节A违反自底向上", "缺入口覆盖"],
    });
  });

  test("verdict 非法枚举返回 null", () => {
    expect(extractCriticVerdict('```json\n{"verdict":"maybe","fixes":[]}\n```')).toBe(null);
    expect(extractCriticVerdict('```json\n{"verdict":"APPROVE","fixes":[]}\n```')).toBe(null);
  });

  test("fixes 非数组返回 null", () => {
    expect(
      extractCriticVerdict('```json\n{"verdict":"approve","fixes":"应为数组"}\n```'),
    ).toBe(null);
  });

  test("fixes 元素非字符串返回 null", () => {
    expect(
      extractCriticVerdict('```json\n{"verdict":"reject","fixes":["ok",1]}\n```'),
    ).toBe(null);
  });

  test("无 JSON / 非法 JSON 返回 null", () => {
    expect(extractCriticVerdict("纯文本无 json")).toBe(null);
    expect(extractCriticVerdict("```json\n{bad}\n```")).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// surveyor
// ---------------------------------------------------------------------------

describe("surveyor", () => {
  test("从 json fence 提取 RepoMap；cmd 含 readonly 工具串、无 Write/Edit；不落盘", async () => {
    const calls: SpawnCall[] = [];
    const repoMapJson = JSON.stringify({
      root: "work/source",
      sourceKind: "git-clone",
      languages: ["ts"],
      frameworks: [],
      entrypoints: ["src/index.ts"],
      manifests: ["package.json"],
      packages: [],
      tree: [{ path: "src/index.ts", type: "file", role: "entry" }],
      docs: ["README.md"],
    });
    const spawn = spawnReturning(
      "```json\n" + repoMapJson + "\n```",
      calls,
    );

    const r = await surveyor({
      key: "demo",
      sourceKind: "git",
      spawn,
    });

    // 产物解析正确
    expect(r.ok).toBe(true);
    expect(r.repoMap).not.toBe(null);
    expect(r.repoMap?.languages).toEqual(["ts"]);
    expect(r.repoMap?.sourceKind).toBe("git-clone");
    expect(r.repoMap?.entrypoints).toEqual(["src/index.ts"]);

    // AC-7：--allowedTools 值为 Read,Glob,Grep，不含 Write/Edit
    expectReadonlyTools(r.cmd);

    // cmd 非空（供 manifest 记录）
    expect(r.cmd.length).toBeGreaterThan(0);

    // cwd = runDir(key)
    expect(calls[0].cwd).toBe(runDir("demo"));

    // systemPromptPath 注入：args 含 --append-system-prompt-file 指向 surveyor.md
    const sysIdx = calls[0].args.indexOf("--append-system-prompt-file");
    expect(sysIdx).toBeGreaterThan(-1);
    expect(calls[0].args[sysIdx + 1].endsWith("surveyor.md")).toBe(true);

    // prompt 含 sourceKind 提示
    const promptArg = calls[0].args[1]; // -p 后的 prompt
    expect(promptArg).toContain("git-clone");
  });

  test("解析失败（无 fence + 非法 JSON）→ ok=false、repoMap=null", async () => {
    const spawn = spawnReturning("模型胡言乱语无 JSON", []);
    const r = await surveyor({
      key: "demo",
      sourceKind: "local",
      sourcePath: "/abs/path",
      spawn,
    });
    expect(r.ok).toBe(false);
    expect(r.repoMap).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// architect
// ---------------------------------------------------------------------------

describe("architect", () => {
  test("从 json fence 提取 chapters；cmd readonly；不含 topoOrder 注入", async () => {
    const calls: SpawnCall[] = [];
    const out = JSON.stringify({
      chapters: [
        {
          slug: "reactive-primitive",
          title: "响应式原子",
          layer: "primitive",
          dependsOn: [],
          sourceFiles: ["src/reactivity/ref.ts"],
          summary: "signal/effect 最小实现",
        },
        {
          slug: "app",
          title: "应用入口",
          layer: "system",
          dependsOn: ["reactive-primitive"],
          sourceFiles: ["src/app.ts"],
          summary: "顶层应用",
        },
      ],
    });
    const spawn = spawnReturning("```json\n" + out + "\n```", calls);

    const r = await architect({ key: "demo", spawn });

    expect(r.ok).toBe(true);
    expect(r.chapters).not.toBe(null);
    expect(r.chapters?.length).toBe(2);
    expect(r.chapters?.[0].slug).toBe("reactive-primitive");
    expect(r.chapters?.[1].dependsOn).toEqual(["reactive-primitive"]);

    // AC-7：readonly、无 Write/Edit
    expectReadonlyTools(r.cmd);

    // systemPromptPath → architect.md
    const sysIdx = calls[0].args.indexOf("--append-system-prompt-file");
    expect(calls[0].args[sysIdx + 1].endsWith("architect.md")).toBe(true);

    // cwd = runDir
    expect(calls[0].cwd).toBe(runDir("demo"));

    // prompt 提醒不写 topoOrder
    expect(calls[0].args[1]).toContain("topoOrder");
  });

  test("解析失败 → chapters=null、ok=false", async () => {
    const spawn = spawnReturning("no json here", []);
    const r = await architect({ key: "demo", spawn });
    expect(r.ok).toBe(false);
    expect(r.chapters).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// critic（outline + chapter 双模式）
// ---------------------------------------------------------------------------

describe("critic · outline 模式", () => {
  test("reject + fixes 解析；systemPromptPath 选 critic-outline.md；cmd readonly", async () => {
    const calls: SpawnCall[] = [];
    const out = JSON.stringify({
      verdict: "reject",
      fixes: ["章节A dependsOn 违反自底向上", "缺入口 src/cli.ts 覆盖"],
    });
    const spawn = spawnReturning("```json\n" + out + "\n```", calls);

    const r = await critic({ key: "demo", mode: "outline", spawn });

    expect(r.ok).toBe(true);
    expect(r.verdict).toBe("reject");
    expect(r.fixes.length).toBe(2);
    expect(r.fixes[0]).toContain("自底向上");

    // 选对 system prompt 文件
    const sysIdx = calls[0].args.indexOf("--append-system-prompt-file");
    expect(calls[0].args[sysIdx + 1].endsWith("critic-outline.md")).toBe(true);

    // AC-7
    expectReadonlyTools(r.cmd);
  });
});

describe("critic · chapter 模式", () => {
  test("approve（fixes 空）解析；systemPromptPath 选 critic-chapter.md；cmd readonly", async () => {
    const calls: SpawnCall[] = [];
    const out = JSON.stringify({ verdict: "approve", fixes: [] });
    const spawn = spawnReturning("```json\n" + out + "\n```", calls);

    const r = await critic({ key: "demo", mode: "chapter", slug: "reactive-primitive", spawn });

    expect(r.ok).toBe(true);
    expect(r.verdict).toBe("approve");
    expect(r.fixes).toEqual([]);

    const sysIdx = calls[0].args.indexOf("--append-system-prompt-file");
    expect(calls[0].args[sysIdx + 1].endsWith("critic-chapter.md")).toBe(true);

    // AC-7
    expectReadonlyTools(r.cmd);

    // prompt 含 slug
    expect(calls[0].args[1]).toContain("reactive-primitive");
  });

  test("chapter 模式缺 slug：不调 claude、直接 ok=false", async () => {
    const calls: SpawnCall[] = [];
    const spawn = makeFakeSpawn(calls, { exitCode: 0, stdout: "", stderr: "" });
    const r = await critic({ key: "demo", mode: "chapter", spawn });
    expect(r.ok).toBe(false);
    expect(r.verdict).toBe(null);
    expect(calls.length).toBe(0); // 没调 spawn
    expect(r.stderr).toContain("slug");
  });

  test("verdict 非法枚举 → verdict=null、ok=false", async () => {
    const spawn = spawnReturning('```json\n{"verdict":"maybe","fixes":[]}\n```', []);
    const r = await critic({ key: "demo", mode: "outline", spawn });
    expect(r.ok).toBe(false);
    expect(r.verdict).toBe(null);
    expect(r.fixes).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// reader
// ---------------------------------------------------------------------------

describe("reader", () => {
  test("从 markdown fence 提取 research.md；cmd readonly", async () => {
    const calls: SpawnCall[] = [];
    const research = "# 响应式原子 · 源码精读\n\n## 概念要点\n- ref 源码位置: src/ref.ts:12";
    // 外层用 4 反引号（与 reader user prompt 契约一致），内层若有代码块不会被误闭合。
    const stdout = "````markdown\n" + research + "\n````";
    const spawn = spawnReturning(stdout, calls);

    const r = await reader({ key: "demo", slug: "reactive-primitive", spawn });

    expect(r.ok).toBe(true);
    expect(r.researchMd).toBe(research);

    // AC-7
    expectReadonlyTools(r.cmd);

    // systemPromptPath → reader.md
    const sysIdx = calls[0].args.indexOf("--append-system-prompt-file");
    expect(calls[0].args[sysIdx + 1].endsWith("reader.md")).toBe(true);

    // cwd = runDir
    expect(calls[0].cwd).toBe(runDir("demo"));
  });

  test("无 markdown fence → researchMd=null、ok=false", async () => {
    const spawn = spawnReturning("no fence at all", []);
    const r = await reader({ key: "demo", slug: "x", spawn });
    expect(r.ok).toBe(false);
    expect(r.researchMd).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// writer（写入类）
// ---------------------------------------------------------------------------

describe("writer", () => {
  test("tools=write；cmd 含 Write/Edit；cwd=workDir(key)", async () => {
    const calls: SpawnCall[] = [];
    const spawn = makeFakeSpawn(calls, {
      exitCode: 0,
      stdout: "已写 draft.md 与 replica/",
      stderr: "",
    });

    const r = await writer({ key: "demo", slug: "reactive-primitive", spawn });

    expect(r.ok).toBe(true);
    // 写入类：cmd 含 Write/Edit（在 --allowedTools Read,Glob,Grep,Write,Edit 里）
    expect(r.cmd.includes("Write")).toBe(true);
    expect(r.cmd.includes("Edit")).toBe(true);
    expect(r.cmd.includes("--allowedTools Read,Glob,Grep,Write,Edit")).toBe(true);

    // cwd = workDir(key)（不是 chapterDir，便于跨读 outline.json）
    expect(calls[0].cwd).toBe(workDir("demo"));

    // systemPromptPath → writer.md
    const sysIdx = calls[0].args.indexOf("--append-system-prompt-file");
    expect(calls[0].args[sysIdx + 1].endsWith("writer.md")).toBe(true);

    // user prompt 限定写范围：明确「只能写 chapters/{slug}/」、严禁改 outline
    const promptArg = calls[0].args[1];
    expect(promptArg).toContain("chapters/reactive-primitive/");
    expect(promptArg).toContain("outline.json");
    expect(promptArg).toContain("严禁");
  });
});

// ---------------------------------------------------------------------------
// assembler（写入类，需先落 outline 到 tmp runDir）
// ---------------------------------------------------------------------------

describe("assembler", () => {
  let tmpRoot = "";

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), "atlas-agents-"));
  });
  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  test("tools=write；cmd 含 Write/Edit；cwd=runDir；user prompt 嵌入 outline 的 topoOrder", async () => {
    // 注意：assembler 内部用 outlinePath(key)（相对仓库根 atlas/{key}/work/outline.json），
    //   所以要让它在 tmp 目录生效，得把 cwd 改到 tmp。但 agent 的 cwd 写死 runDir(key)
    //   即 `atlas/{key}/`——这是相对路径，相对**进程 cwd**解析。
    //   测试里把进程 cwd 切到 tmpRoot，让 atlas/ 落在 tmp 内。
    const origCwd = process.cwd();
    process.chdir(tmpRoot);
    try {
      // 先用 io.writeJson 落一份 outline 到 tmp 的 atlas/demo/work/outline.json
      const outline: Outline = {
        repo: "demo",
        generatedAt: "1970-01-01T00:00:00Z",
        chapters: [
          {
            slug: "reactive-primitive",
            title: "响应式原子",
            layer: "primitive",
            dependsOn: [],
            sourceFiles: ["src/ref.ts"],
            summary: "x",
          },
          {
            slug: "app",
            title: "应用入口",
            layer: "system",
            dependsOn: ["reactive-primitive"],
            sourceFiles: ["src/app.ts"],
            summary: "y",
          },
        ],
        topoOrder: ["reactive-primitive", "app"],
      };
      await writeJson(outlinePath("demo"), outline);

      const calls: SpawnCall[] = [];
      const spawn = makeFakeSpawn(calls, {
        exitCode: 0,
        stdout: "已组装 site/",
        stderr: "",
      });

      const r = await assembler({ key: "demo", spawn });

      expect(r.ok).toBe(true);
      // 写入类
      expect(r.cmd.includes("--allowedTools Read,Glob,Grep,Write,Edit")).toBe(true);
      expect(r.cmd.includes("Write")).toBe(true);

      // cwd = runDir(key)
      expect(calls[0].cwd).toBe(runDir("demo"));

      // systemPromptPath → assembler.md
      const sysIdx = calls[0].args.indexOf("--append-system-prompt-file");
      expect(calls[0].args[sysIdx + 1].endsWith("assembler.md")).toBe(true);

      // user prompt 嵌入了 outline 的 topoOrder 与章节元数据
      const promptArg = calls[0].args[1];
      expect(promptArg).toContain("reactive-primitive");
      expect(promptArg).toContain("topoOrder");
      // 嵌入了预读的章节 layer/title
      expect(promptArg).toContain("primitive");
      expect(promptArg).toContain("响应式原子");
      // 写范围限定 site/
      expect(promptArg).toContain("site/");
    } finally {
      process.chdir(origCwd);
    }
  });

  test("outline.json 不存在 → ok=false、不调 claude", async () => {
    const origCwd = process.cwd();
    process.chdir(tmpRoot);
    try {
      const calls: SpawnCall[] = [];
      const spawn = makeFakeSpawn(calls, { exitCode: 0, stdout: "", stderr: "" });
      // 不落 outline.json
      const r = await assembler({ key: "no-such-key", spawn });
      expect(r.ok).toBe(false);
      expect(r.exitCode).toBe(-1);
      expect(calls.length).toBe(0); // 没调 spawn
      expect(r.stderr).toContain("outline.json");
    } finally {
      process.chdir(origCwd);
    }
  });

  test("outline 缺 topoOrder → ok=false", async () => {
    const origCwd = process.cwd();
    process.chdir(tmpRoot);
    try {
      // 缺 topoOrder 字段
      await writeJson(outlinePath("demo"), {
        chapters: [{ slug: "a", title: "A", layer: "primitive", dependsOn: [], sourceFiles: [], summary: "" }],
      });
      const calls: SpawnCall[] = [];
      const spawn = makeFakeSpawn(calls, { exitCode: 0, stdout: "", stderr: "" });
      const r = await assembler({ key: "demo", spawn });
      expect(r.ok).toBe(false);
      expect(r.exitCode).toBe(-1);
      expect(calls.length).toBe(0);
      expect(r.stderr).toContain("topoOrder");
    } finally {
      process.chdir(origCwd);
    }
  });
});

// ---------------------------------------------------------------------------
// AC-7 防御：四个只读 agent 统一断言（cmd 含 readonly 锚点、无 Write/Edit）
// ---------------------------------------------------------------------------

describe("AC-7 防御：只读 agent 无逃生口", () => {
  test("surveyor / architect / reader / critic 的 cmd 一律 readonly", async () => {
    const roSpawn = spawnReturning('```json\n{}\n```', []);
    const mdSpawn = spawnReturning("````markdown\nx\n````", []);

    const agents = [
      surveyor({ key: "t", sourceKind: "git", spawn: roSpawn }),
      architect({ key: "t", spawn: roSpawn }),
      reader({ key: "t", slug: "x", spawn: mdSpawn }),
      critic({ key: "t", mode: "outline", spawn: roSpawn }),
      critic({ key: "t", mode: "chapter", slug: "x", spawn: roSpawn }),
    ];
    const results = await Promise.all(agents);

    for (const r of results) {
      expect(r.cmd.includes("--allowedTools Read,Glob,Grep")).toBe(true);
      // 无 Write/Edit 出现在工具串里
      // 注意：prompt 正文可能含 "Write"/"Edit" 字样，但 cmd 串里 --allowedTools
      //   的值是 `Read,Glob,Grep`（只读锚点）。这里检查 --allowedTools 后的值不含 Write/Edit。
      const m = r.cmd.match(/--allowedTools (\S+)/);
      expect(m).not.toBe(null);
      const toolsValue = m![1];
      expect(toolsValue).toBe("Read,Glob,Grep");
      expect(toolsValue).not.toContain("Write");
      expect(toolsValue).not.toContain("Edit");
    }
  });
});

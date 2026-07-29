// test/cli.test.ts：M11 atlas CLI 的单元测试。
// 用 bun:test。**全程 mock runPipeline（deps 注入）+ 临时 cwd**，
// 不真调 claude/git/build（task M11 单测纪律）。
//
// 核心断言锚点（AC-6 / FR-8 / design §13）：
//   - argv 解析正确：run <url> → source.kind=url；run <localpath> → kind=local。
//   - 全局 flag 透传：--concurrency/--skip-build/--model/--from/--only/--force。
//   - 5 个子命令的 happy path + 主要错误路径（key 不存在 / 未知命令 / 源不存在）。
//   - list / show 输出含期望字段（list 列各 key；show 含 AC-6 review 行）。
//   - clean -y 删目录；clean 默认（confirm stub 返回 false）不删。
//   - --version → atlas 0.1.0；未知命令 → 退出码 1。

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 被测 CLI：runCli 是可注入 deps 的主体。
import { runCli, type CliDeps } from "../src/bin/atlas.ts";
// 上游工具，用于造夹具。
import { manifestPath } from "../src/lib/io.ts";
import {
  initManifest,
  setStageStatus,
  setStageReview,
  setChapterStatus,
  setChapterReview,
  registerChapters,
  type Manifest,
  type SourceInfo,
  type ReviewSummary,
} from "../src/lib/manifest.ts";
import type { RunPipelineOptions, RunPipelineResult } from "../src/orchestrator.ts";

// ---------------------------------------------------------------------------
// 夹具：临时 cwd + 日志/退出/确认收集
// ---------------------------------------------------------------------------

let tmpRoot = "";
let savedCwd = "";

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "atlas-cli-"));
  savedCwd = process.cwd();
  process.chdir(tmpRoot);
});

afterEach(async () => {
  process.chdir(savedCwd);
  await rm(tmpRoot, { recursive: true, force: true });
});

/** 造一个 deps 包：mock runPipeline 收集调用 + 收集 log/err/exit。 */
interface CapturedDeps {
  deps: CliDeps;
  logs: string[];
  errs: string[];
  exitCalls: number[];
  pipelineCalls: RunPipelineOptions[];
  pipelineResult: RunPipelineResult;
  /** 改这个值再跑下一次，控制 mock runPipeline 返回 ok/失败。 */
  setPipelineResult: (r: RunPipelineResult) => void;
  /** confirm 返回值（clean 用）。默认 false。 */
  confirmReturn: boolean;
  confirmCalls: string[];
}

function makeDeps(): CapturedDeps {
  const logs: string[] = [];
  const errs: string[] = [];
  const exitCalls: number[] = [];
  const pipelineCalls: RunPipelineOptions[] = [];
  const confirmCalls: string[] = [];
  const state: { result: RunPipelineResult; confirm: boolean } = {
    result: { ok: true, key: "" },
    confirm: false,
  };

  const deps: CliDeps = {
    runPipeline: async (opts: RunPipelineOptions) => {
      pipelineCalls.push(opts);
      // 同步 mock 返回的 result.key 与传入一致。
      return { ...state.result, key: opts.key };
    },
    exit: (code: number) => {
      exitCalls.push(code);
      // 不真退出（避免 bun test 进程被杀）。
    },
    log: (m: string) => logs.push(m),
    err: (m: string) => errs.push(m),
    confirm: async (prompt: string) => {
      confirmCalls.push(prompt);
      return state.confirm;
    },
  };

  return {
    deps,
    logs,
    errs,
    exitCalls,
    pipelineCalls,
    get pipelineResult() {
      return state.result;
    },
    setPipelineResult: (r: RunPipelineResult) => {
      state.result = r;
    },
    get confirmReturn() {
      return state.confirm;
    },
    set confirmReturn(v: boolean) {
      state.confirm = v;
    },
    confirmCalls,
  };
}

// ---------------------------------------------------------------------------
// 工具：造一个 manifest 文件
// ---------------------------------------------------------------------------

/** 写一个最小 manifest.json（version=1，所有 stage pending）。 */
async function writeManifest(key: string, m: Manifest): Promise<void> {
  const { writeJson } = await import("../src/lib/io.ts");
  await writeJson(manifestPath(key), m);
}

/** 造一个 url source。 */
function urlSource(url = "https://github.com/o/repo.git"): SourceInfo {
  return { kind: "url", ref: url, localPath: null };
}

/** 造一个本地 source。 */
function localSource(absPath: string, ref = absPath): SourceInfo {
  return { kind: "local", ref, localPath: absPath };
}

// ===========================================================================
// run 子命令
// ===========================================================================

describe("atlas run", () => {
  test("run <url>：key=keyFromRepo(url)、source.kind=url、调用 mock runPipeline", async () => {
    const c = makeDeps();
    const code = await runCli(["run", "https://github.com/owner/react-mini.git"], c.deps);

    expect(code).toBe(0);
    expect(c.pipelineCalls.length).toBe(1);
    const call = c.pipelineCalls[0];
    expect(call.key).toBe("react-mini");
    expect(call.source.kind).toBe("url");
    expect(call.source.ref).toBe("https://github.com/owner/react-mini.git");
    expect(call.source.localPath).toBeNull();
    // 续跑日志不应出现（首次新建）。
    expect(c.logs.some((l) => l.includes("续跑"))).toBe(false);
  });

  test("run <localpath>（真实临时目录）：source.kind=local、localPath=absPath", async () => {
    const localDir = join(tmpRoot, "my-repo");
    await mkdir(localDir, { recursive: true });

    const c = makeDeps();
    const code = await runCli(["run", localDir], c.deps);

    expect(code).toBe(0);
    expect(c.pipelineCalls.length).toBe(1);
    const call = c.pipelineCalls[0];
    expect(call.key).toBe("my-repo");
    expect(call.source.kind).toBe("local");
    expect(call.source.localPath).toBe(localDir);
  });

  test("run <localpath 不存在>：报错、退出码 1、不调 runPipeline", async () => {
    const c = makeDeps();
    const code = await runCli(["run", join(tmpRoot, "nope-not-exist")], c.deps);

    expect(code).toBe(1);
    expect(c.pipelineCalls.length).toBe(0);
    expect(c.errs.some((e) => e.includes("本地源路径不存在"))).toBe(true);
  });

  test("run manifest 已存在 → 续跑，source 从磁盘读", async () => {
    const key = "existing-run";
    const src = urlSource("https://github.com/o/existing-run.git");
    // 先落盘一个 manifest（模拟已有 Run）。
    await writeManifest(key, initManifest(key, src));

    const c = makeDeps();
    // 传一个能算出同一 key 的本地路径（basename = existing-run），
    // 但目录不存在——验证「manifest 已存在」优先级高于本地源存在性校验，
    // source 来自磁盘 manifest 而非新算。
    const code = await runCli(["run", join(tmpRoot, "subdir", "existing-run")], c.deps);

    expect(code).toBe(0);
    expect(c.pipelineCalls.length).toBe(1);
    // source 应是磁盘里的 url（不是新算的 local）。
    expect(c.pipelineCalls[0].source.kind).toBe("url");
    expect(c.pipelineCalls[0].source.ref).toBe("https://github.com/o/existing-run.git");
    // 打了续跑提示。
    expect(c.logs.some((l) => l.includes("续跑"))).toBe(true);
  });

  test("run <url> --concurrency 8 --skip-build --model foo：全局 flag 正确透传", async () => {
    const c = makeDeps();
    const code = await runCli(
      ["run", "https://github.com/o/repo.git", "--concurrency", "8", "--skip-build", "--model", "foo"],
      c.deps,
    );

    expect(code).toBe(0);
    expect(c.pipelineCalls.length).toBe(1);
    const flags = c.pipelineCalls[0].flags ?? {};
    expect(flags.concurrency).toBe(8);
    expect(flags.skipBuild).toBe(true);
    expect(flags.model).toBe("foo");
  });

  test("run --review-rounds 3 透传", async () => {
    const c = makeDeps();
    const code = await runCli(["run", "https://github.com/o/r.git", "--review-rounds", "3"], c.deps);

    expect(code).toBe(0);
    expect(c.pipelineCalls[0].flags?.reviewRounds).toBe(3);
  });

  test("run runPipeline 返回 ok:false → 退出码 1 + 失败提示", async () => {
    const c = makeDeps();
    c.setPipelineResult({ ok: false, key: "" });
    const code = await runCli(["run", "https://github.com/o/r.git"], c.deps);

    expect(code).toBe(1);
    expect(c.errs.some((e) => e.includes("失败"))).toBe(true);
  });

  test("run 缺位置参数 → 用法提示 + 退出码 1", async () => {
    const c = makeDeps();
    const code = await runCli(["run"], c.deps);
    expect(code).toBe(1);
    expect(c.errs.some((e) => e.includes("用法"))).toBe(true);
    expect(c.pipelineCalls.length).toBe(0);
  });

  test("run --concurrency 非正整数 → 报错", async () => {
    const c = makeDeps();
    const code = await runCli(["run", "https://github.com/o/r.git", "--concurrency", "0"], c.deps);
    expect(code).toBe(1);
    expect(c.errs.some((e) => e.includes("--concurrency"))).toBe(true);
  });

  test("run --concurrency 无值 → 报错", async () => {
    const c = makeDeps();
    const code = await runCli(["run", "https://github.com/o/r.git", "--concurrency"], c.deps);
    expect(code).toBe(1);
    expect(c.pipelineCalls.length).toBe(0);
  });
});

// ===========================================================================
// resume 子命令
// ===========================================================================

describe("atlas resume", () => {
  test("resume <key> --from research --force：flags 正确透传", async () => {
    const key = "resume-target";
    await writeManifest(key, initManifest(key, urlSource()));

    const c = makeDeps();
    const code = await runCli(["resume", key, "--from", "research", "--force"], c.deps);

    expect(code).toBe(0);
    expect(c.pipelineCalls.length).toBe(1);
    const call = c.pipelineCalls[0];
    expect(call.key).toBe(key);
    expect(call.flags?.from).toBe("research");
    expect(call.flags?.force).toBe(true);
  });

  test("resume <key> --only outline：透传 only", async () => {
    const key = "resume-only";
    await writeManifest(key, initManifest(key, urlSource()));

    const c = makeDeps();
    const code = await runCli(["resume", key, "--only", "outline"], c.deps);

    expect(code).toBe(0);
    expect(c.pipelineCalls[0].flags?.only).toBe("outline");
  });

  test("resume key 不存在 → 报错 + 退出码 1", async () => {
    const c = makeDeps();
    const code = await runCli(["resume", "nonexistent-key"], c.deps);

    expect(code).toBe(1);
    expect(c.pipelineCalls.length).toBe(0);
    expect(c.errs.some((e) => e.includes("未找到 Run"))).toBe(true);
  });

  test("resume --from 非法 stage → 报错", async () => {
    const key = "resume-bad-stage";
    await writeManifest(key, initManifest(key, urlSource()));

    const c = makeDeps();
    const code = await runCli(["resume", key, "--from", "not-a-stage"], c.deps);

    expect(code).toBe(1);
    expect(c.errs.some((e) => e.includes("非法 stage 名"))).toBe(true);
  });
});

// ===========================================================================
// list 子命令
// ===========================================================================

describe("atlas list", () => {
  test("list 无 atlas/ 目录 → 提示暂无 Run", async () => {
    const c = makeDeps();
    const code = await runCli(["list"], c.deps);
    expect(code).toBe(0);
    expect(c.logs.some((l) => l.includes("暂无"))).toBe(true);
  });

  test("list 有几个 Run → 输出含各 key + 状态摘要", async () => {
    const k1 = "react-mini";
    const k2 = "vue-mini";
    const k3 = "svelte-mini";

    let m1 = initManifest(k1, urlSource());
    m1 = setStageStatus(m1, "acquire", "done");
    m1 = setStageStatus(m1, "survey", "done");
    await writeManifest(k1, m1);

    let m2 = initManifest(k2, localSource("/some/path"));
    m2 = setStageStatus(m2, "acquire", "done");
    await writeManifest(k2, m2);

    await writeManifest(k3, initManifest(k3, urlSource()));

    const c = makeDeps();
    const code = await runCli(["list"], c.deps);

    expect(code).toBe(0);
    const joined = c.logs.join("\n");
    expect(joined).toContain("react-mini:");
    expect(joined).toContain("vue-mini:");
    expect(joined).toContain("svelte-mini:");
    // react-mini 的状态摘要格式。
    expect(joined).toContain("acquire=done");
  });
});

// ===========================================================================
// show 子命令（AC-6 核心：review 行格式）
// ===========================================================================

describe("atlas show", () => {
  test("AC-6：outline 行带 [review: approve, Nr]、章 write 行带 [review: ...]", async () => {
    const key = "show-with-review";
    let m = initManifest(key, urlSource());
    m = setStageStatus(m, "acquire", "done");
    m = setStageStatus(m, "survey", "done");

    // outline done + 1 轮 approve review。
    m = setStageStatus(m, "outline", "done");
    const outlineReview: ReviewSummary = {
      rounds: 1,
      final: "approved",
      trace: [{ round: 1, verdict: "approve" }],
    };
    m = setStageReview(m, "outline", outlineReview);

    // 注册两章。
    m = registerChapters(m, ["alpha", "beta"]);
    m = setStageStatus(m, "research", "done");
    m = setChapterStatus(m, "alpha", "research", "done");
    m = setChapterStatus(m, "beta", "research", "done");

    // alpha 写完 + 2 轮 accepted-with-warning。
    m = setChapterStatus(m, "alpha", "write", "done");
    const alphaReview: ReviewSummary = {
      rounds: 2,
      final: "accepted-with-warning",
      trace: [
        { round: 1, verdict: "reject", fixes: ["x"] },
        { round: 2, verdict: "approve" },
      ],
    };
    m = setChapterReview(m, "alpha", alphaReview);

    // beta 还没写。
    await writeManifest(key, m);

    const c = makeDeps();
    const code = await runCli(["show", key], c.deps);

    expect(code).toBe(0);
    const joined = c.logs.join("\n");

    // outline 行带 [review: approve, 1r]（AC-6 期望格式）。
    expect(joined).toContain("outline=done");
    expect(joined).toContain("[review: approve, 1r]");

    // alpha write 行带 [review: accepted-with-warning, 2r]。
    expect(joined).toContain("alpha:");
    expect(joined).toContain("write=done");
    expect(joined).toContain("[review: accepted-with-warning, 2r]");

    // beta write pending，无 review 段。
    expect(joined).toContain("beta:");
    // beta 行不应含 [review:（无 review）。
    const betaLine = c.logs.find((l) => l.includes("beta:"));
    expect(betaLine).toBeDefined();
    expect(betaLine!.includes("[review:")).toBe(false);
  });

  test("show 含 source/version 信息", async () => {
    const key = "show-meta";
    await writeManifest(key, initManifest(key, urlSource("https://github.com/o/r.git")));

    const c = makeDeps();
    const code = await runCli(["show", key], c.deps);

    expect(code).toBe(0);
    const joined = c.logs.join("\n");
    expect(joined).toContain("version:");
    expect(joined).toContain("source:");
    expect(joined).toContain("https://github.com/o/r.git");
    expect(joined).toContain(`Run: ${key}`);
  });

  test("show failed stage 行带诊断后缀（exitCode/error/stderr）", async () => {
    const key = "show-failed";
    let m = initManifest(key, urlSource());
    m = setStageStatus(m, "acquire", "done");
    // survey failed 带诊断（模拟 5ms 启动失败场景落盘的真实诊断）。
    m = setStageStatus(m, "survey", "failed", {
      cmd: "claude -p survey",
      exitCode: 126,
      stderr: "defaultSpawn: 启动 claude 子进程失败",
      error: "启动 claude 子进程失败",
    });
    await writeManifest(key, m);

    const c = makeDeps();
    const code = await runCli(["show", key], c.deps);

    expect(code).toBe(0);
    const surveyLine = c.logs.find((l) => l.includes("survey="));
    expect(surveyLine).toBeDefined();
    expect(surveyLine!.includes("survey=failed")).toBe(true);
    // 诊断后缀：exit/error/stderr 都展示。
    expect(surveyLine!.includes("exit=126")).toBe(true);
    expect(surveyLine!.includes("err:")).toBe(true);
    expect(surveyLine!.includes("stderr:")).toBe(true);
  });

  test("show 非 failed 行不带诊断后缀（成功路径不污染）", async () => {
    const key = "show-clean";
    let m = initManifest(key, urlSource());
    m = setStageStatus(m, "acquire", "done");
    m = setStageStatus(m, "survey", "done", { cmd: "claude -p survey" });
    await writeManifest(key, m);

    const c = makeDeps();
    const code = await runCli(["show", key], c.deps);

    expect(code).toBe(0);
    const surveyLine = c.logs.find((l) => l.includes("survey="));
    expect(surveyLine).toBeDefined();
    expect(surveyLine!.includes("survey=done")).toBe(true);
    // done 行不应有诊断后缀。
    expect(surveyLine!.includes("exit=")).toBe(false);
    expect(surveyLine!.includes("err:")).toBe(false);
  });

  test("show key 不存在 → 报错 + 退出码 1", async () => {
    const c = makeDeps();
    const code = await runCli(["show", "nope"], c.deps);
    expect(code).toBe(1);
    expect(c.errs.some((e) => e.includes("未找到 Run"))).toBe(true);
  });
});

// ===========================================================================
// clean 子命令
// ===========================================================================

describe("atlas clean", () => {
  test("clean <key> -y：删目录 + 日志", async () => {
    const key = "to-clean";
    await writeManifest(key, initManifest(key, urlSource()));
    const { pathExists } = await import("../src/lib/io.ts");
    expect(await pathExists(`atlas/${key}/`)).toBe(true);

    const c = makeDeps();
    const code = await runCli(["clean", key, "-y"], c.deps);

    expect(code).toBe(0);
    expect(c.confirmCalls.length).toBe(0); // -y 跳过确认。
    expect(await pathExists(`atlas/${key}/`)).toBe(false);
    expect(c.logs.some((l) => l.includes("已删除"))).toBe(true);
  });

  test("clean <key> --yes 也跳过确认", async () => {
    const key = "to-clean-long";
    await writeManifest(key, initManifest(key, urlSource()));

    const c = makeDeps();
    const code = await runCli(["clean", key, "--yes"], c.deps);

    expect(code).toBe(0);
    expect(c.confirmCalls.length).toBe(0);
  });

  test("clean <key> 默认（confirm stub 返回 false）→ 不删 + 已取消", async () => {
    const key = "no-delete";
    await writeManifest(key, initManifest(key, urlSource()));

    const c = makeDeps();
    c.confirmReturn = false;
    const code = await runCli(["clean", key], c.deps);

    expect(code).toBe(0);
    expect(c.confirmCalls.length).toBe(1); // 问了一次。
    const { pathExists } = await import("../src/lib/io.ts");
    expect(await pathExists(`atlas/${key}/`)).toBe(true); // 没删。
    expect(c.logs.some((l) => l.includes("已取消"))).toBe(true);
  });

  test("clean <key> confirm 返回 true → 删", async () => {
    const key = "delete-after-confirm";
    await writeManifest(key, initManifest(key, urlSource()));

    const c = makeDeps();
    c.confirmReturn = true;
    const code = await runCli(["clean", key], c.deps);

    expect(code).toBe(0);
    const { pathExists } = await import("../src/lib/io.ts");
    expect(await pathExists(`atlas/${key}/`)).toBe(false);
  });

  test("clean key 不存在 → 报错 + 退出码 1", async () => {
    const c = makeDeps();
    const code = await runCli(["clean", "nonexistent"], c.deps);
    expect(code).toBe(1);
    expect(c.errs.some((e) => e.includes("未找到 Run"))).toBe(true);
  });
});

// ===========================================================================
// 全局 flag / 错误路径
// ===========================================================================

describe("全局 flag / 错误路径", () => {
  test("--version → 打印 atlas 0.1.0", async () => {
    const c = makeDeps();
    const code = await runCli(["--version"], c.deps);
    expect(code).toBe(0);
    expect(c.logs.some((l) => l === "atlas 0.1.0")).toBe(true);
  });

  test("-v → 打印 atlas 0.1.0", async () => {
    const c = makeDeps();
    const code = await runCli(["-v"], c.deps);
    expect(code).toBe(0);
    expect(c.logs.some((l) => l === "atlas 0.1.0")).toBe(true);
  });

  test("--version 在子命令后也能识别", async () => {
    const c = makeDeps();
    const code = await runCli(["run", "--version"], c.deps);
    expect(code).toBe(0);
    expect(c.logs.some((l) => l === "atlas 0.1.0")).toBe(true);
    expect(c.pipelineCalls.length).toBe(0); // 不跑 pipeline。
  });

  test("--help / -h → 打印用法 + 退出码 0", async () => {
    const c = makeDeps();
    const code = await runCli(["--help"], c.deps);
    expect(code).toBe(0);
    expect(c.logs.some((l) => l.includes("用法"))).toBe(true);
    expect(c.logs.some((l) => l.includes("atlas run"))).toBe(true);
  });

  test("无参数 → 打印用法 + 退出码 0", async () => {
    const c = makeDeps();
    const code = await runCli([], c.deps);
    expect(code).toBe(0);
    expect(c.logs.some((l) => l.includes("用法"))).toBe(true);
  });

  test("未知命令 → 报错 + 退出码 1", async () => {
    const c = makeDeps();
    const code = await runCli(["badcmd"], c.deps);
    expect(code).toBe(1);
    expect(c.errs.some((e) => e.includes("未知命令: badcmd"))).toBe(true);
    // 错误信息列出可用命令。
    expect(c.errs.some((e) => e.includes("run / resume / list / clean / show"))).toBe(true);
  });

  test("未知命令后仍打印用法", async () => {
    const c = makeDeps();
    await runCli(["badcmd"], c.deps);
    const joined = c.errs.join("\n");
    expect(joined.includes("atlas run")).toBe(true);
  });
});

// ===========================================================================
// parseFlags 单元（间接通过子命令测，这里再补几个直接 case）
// ===========================================================================

describe("parseFlags 间接覆盖", () => {
  test("--xxx=value 等号语法也能解析", async () => {
    const c = makeDeps();
    const code = await runCli(
      ["run", "https://github.com/o/r.git", "--concurrency=8", "--model=bar"],
      c.deps,
    );
    expect(code).toBe(0);
    expect(c.pipelineCalls[0].flags?.concurrency).toBe(8);
    expect(c.pipelineCalls[0].flags?.model).toBe("bar");
  });

  test("未知 flag 不报错（容错）", async () => {
    const c = makeDeps();
    const code = await runCli(["run", "https://github.com/o/r.git", "--mystery-flag"], c.deps);
    expect(code).toBe(0);
    expect(c.pipelineCalls.length).toBe(1);
  });
});

// test/stages.test.ts：7 个 Stage 的单元测试。
// 用 bun:test。**全程 mock spawn + 临时 runDir（process.chdir 到临时目录）**，
// 不真调 claude/git/build（design §15 / task M09 单测纪律）。
//
// 核心断言锚点（design §9 / AC-1..AC-6 / 硬约束 #2..#5）：
//   - **CAS 写入纪律**（硬约束 #2）：每个 stage「产物文件存在 ⟺ manifest done」。
//   - **对抗评审**（硬约束 #4 / AC-6）：outline/每章 write 有 review trace；
//     首轮 approve 短路 / 到上限 accepted-with-warning / reject→修订 三场景。
//   - **topoOrder 注入**（硬约束 #3）：outline.json 的 topoOrder == topoSort(chapters).order。
//   - **site 结构**（硬约束 #5 / AC-1）：assemble 后 site/guide/{nn}-{slug}.md 齐全、
//     config.ts/index.md/package.json 存在，nn==topo 序号（AC-4）。
//   - **单点失败隔离**（design §15）：research/write 单章失败不炸整 stage。

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";

// 被测 stages
import { acquire } from "../src/stages/01-acquire.ts";
import { survey } from "../src/stages/02-survey.ts";
import { outline } from "../src/stages/03-outline.ts";
import { research } from "../src/stages/04-research.ts";
import { write } from "../src/stages/05-write.ts";
import { assemble } from "../src/stages/06-assemble.ts";
import { build } from "../src/stages/07-build.ts";
import type { StageContext } from "../src/stages/types.ts";

// 上游 lib
import {
  manifestPath,
  repoMapPath,
  outlinePath,
  researchPath,
  draftPath,
  siteDir,
  readJson,
  writeJson,
  writeText,
  ensureDir,
  pathExists,
  sourceDir,
  joinPath,
} from "../src/lib/io.ts";
import {
  initManifest,
  loadManifest,
  setStageStatus,
  registerChapters,
  setChapterStatus,
  setNow,
  resetNow,
  type Manifest,
  type SourceInfo,
} from "../src/lib/manifest.ts";
import { topoSort } from "../src/lib/topo.ts";
import type { SpawnFn } from "../src/lib/run-claude.ts";
import type { RepoMap, Outline, Chapter } from "../src/lib/types.ts";

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

const FIXED_TIME = "2026-07-27T00:00:00.000Z";

let tmpRoot = "";
let savedCwd = "";

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "atlas-stages-"));
  savedCwd = process.cwd();
  process.chdir(tmpRoot);
  setNow(() => FIXED_TIME);
});

afterEach(async () => {
  process.chdir(savedCwd);
  resetNow();
  await rm(tmpRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// mock spawn 工厂
// ---------------------------------------------------------------------------

interface SpawnCall {
  args: string[];
  cwd: string;
}

/** 单次预设：要么是固定结果对象，要么是按调用动态计算的函数。 */
type SpawnPreset =
  | { exitCode: number; stdout: string; stderr: string }
  | ((call: SpawnCall) => { exitCode: number; stdout: string; stderr: string });

/**
 * 造一个按序返回预设的假 SpawnFn。
 * presets 是数组：第 1 次调用返回 presets[0]，第 2 次 presets[1]，...
 * 每项可以是固定 {exitCode,stdout,stderr}，或 (call)=>结果 的函数。
 * 同时把每次调用的 args/cwd 记入 calls（便于断言 prompt 拼接）。
 */
function makeSeqSpawn(calls: SpawnCall[], presets: SpawnPreset[]): SpawnFn {
  let i = 0;
  return async (args, opts) => {
    const call: SpawnCall = { args: [...args], cwd: opts.cwd };
    calls.push(call);
    const preset = presets[i++] ?? { exitCode: 0, stdout: "", stderr: "" };
    const r = typeof preset === "function" ? preset(call) : preset;
    return { ...r };
  };
}

/** 单一固定返回的便捷工厂。 */
function fixedSpawn(
  stdout: string,
  calls: SpawnCall[] = [],
  stderr = "",
  exitCode = 0,
): SpawnFn {
  return makeSeqSpawn(calls, [{ exitCode, stdout, stderr }]);
}

// ---------------------------------------------------------------------------
// 常用产物构造器
// ---------------------------------------------------------------------------

const LOCAL_SOURCE: SourceInfo = {
  kind: "local",
  ref: "/path/to/repo",
  localPath: "/abs/path/to/repo",
};

const URL_SOURCE: SourceInfo = {
  kind: "url",
  ref: "https://github.com/o/r.git",
  localPath: null,
};

/** 造一个最小的 RepoMap（用于 survey 测试的预设 stdout）。 */
function sampleRepoMap(root = "work/source"): RepoMap {
  return {
    root,
    sourceKind: "git-clone",
    languages: ["ts"],
    frameworks: [],
    entrypoints: ["src/index.ts"],
    manifests: ["package.json"],
    packages: [],
    tree: [{ path: "src/index.ts", type: "file", role: "entry" }],
    docs: ["README.md"],
  };
}

/** 把 JSON 对象包成 ```json fence。 */
function jsonFence(obj: unknown): string {
  return "```json\n" + JSON.stringify(obj) + "\n```";
}

/** 把文本包成 ```markdown fence。 */
function mdFence(text: string): string {
  return "````markdown\n" + text + "\n````";
}

/**
 * 造一个 3 章 DAG chapters（用于 architect 预设 stdout）。
 * A ← B（B dependsOn A），C 独立。期望 topoOrder 以 A 开头。
 */
function sampleChapters(): Chapter[] {
  return [
    {
      slug: "alpha",
      title: "原子概念",
      layer: "primitive",
      dependsOn: [],
      sourceFiles: ["src/a.ts"],
      summary: "alpha 总结",
    },
    {
      slug: "beta",
      title: "复合概念",
      layer: "composite",
      dependsOn: ["alpha"],
      sourceFiles: ["src/b.ts"],
      summary: "beta 总结",
    },
    {
      slug: "gamma",
      title: "系统概念",
      layer: "system",
      dependsOn: ["alpha", "beta"],
      sourceFiles: ["src/c.ts"],
      summary: "gamma 总结",
    },
  ];
}

/** 构造一个 StageContext（local source，pending manifest）。 */
function ctxFor(key: string, manifest: Manifest, spawn?: SpawnFn, extra?: Partial<StageContext>): StageContext {
  return { key, manifest, spawn, ...extra };
}

/** 预置 manifest 到「acquire+survey done」状态，方便测下游 stage。 */
async function prepManifestThroughSurvey(
  key: string,
  source: SourceInfo = LOCAL_SOURCE,
): Promise<Manifest> {
  let m = initManifest(key, source);
  m = setStageStatus(m, "acquire", "done", { cmd: "acquire cmd" });
  m = setStageStatus(m, "survey", "done", { cmd: "survey cmd" });
  await writeJson(manifestPath(key), m);
  return m;
}

/** 预置 manifest + outline.json + registerChapters，方便测 research/write。 */
async function prepManifestThroughOutline(
  key: string,
  chapters: Chapter[] = sampleChapters(),
): Promise<Manifest> {
  let m = await prepManifestThroughSurvey(key);
  // 写 outline.json（含 stage 注入的 topoOrder）。
  const topo = topoSort(chapters.map((c) => ({ slug: c.slug, dependsOn: c.dependsOn })));
  const outlineObj: Outline = {
    repo: key,
    generatedAt: FIXED_TIME,
    chapters,
    topoOrder: topo.order,
  };
  await writeJson(outlinePath(key), outlineObj);
  // registerChapters 按 topoOrder。
  m = setStageStatus(m, "outline", "done", { cmd: "outline cmd" });
  m = registerChapters(m, topo.order);
  await writeJson(manifestPath(key), m);
  return m;
}

// ===========================================================================
// 01-acquire
// ===========================================================================

describe("01-acquire", () => {
  test("local 模式：源路径存在 → done；cmd 形如 resolveLocalSource(<abs>)", async () => {
    // 造一个真实存在的本地源目录（在 tmp 下）。
    const localSrc = join(tmpRoot, "my-src");
    await mkdir(localSrc, { recursive: true });
    const source: SourceInfo = { kind: "local", ref: localSrc, localPath: localSrc };
    let m = initManifest("acq-local", source);
    await writeJson(manifestPath("acq-local"), m);

    const next = await acquire(ctxFor("acq-local", m));
    expect(next.stages.acquire.status).toBe("done");
    expect(next.stages.acquire.cmd).toContain("resolveLocalSource(");
    expect(next.stages.acquire.cmd).toContain(localSrc);
    // CAS：manifest 落盘后状态一致。
    const reloaded = await loadManifest("acq-local");
    expect(reloaded.stages.acquire.status).toBe("done");
  });

  test("local 模式：源路径不存在 → failed（不继续）", async () => {
    const missing = join(tmpRoot, "nope-not-exist");
    const source: SourceInfo = { kind: "local", ref: missing, localPath: missing };
    let m = initManifest("acq-fail", source);
    await writeJson(manifestPath("acq-fail"), m);

    const next = await acquire(ctxFor("acq-fail", m));
    expect(next.stages.acquire.status).toBe("failed");
    expect(next.stages.acquire.cmd).toContain("acquire 失败");
  });

  test("url 模式：cloneSource 失败 → failed", async () => {
    // url 模式需真 git；这里用非法 URL 触发 cloneSource 内部协议校验抛错。
    const source: SourceInfo = { kind: "url", ref: "not-a-url", localPath: null };
    let m = initManifest("acq-url-fail", source);
    await writeJson(manifestPath("acq-url-fail"), m);

    const next = await acquire(ctxFor("acq-url-fail", m));
    expect(next.stages.acquire.status).toBe("failed");
    expect(next.stages.acquire.cmd).toContain("acquire 失败");
  });
});

// ===========================================================================
// 02-survey
// ===========================================================================

describe("02-survey", () => {
  test("成功：surveyor 返回 repo-map → 落盘 + done；cmd 含 readonly 工具串（CAS）", async () => {
    const key = "surv-ok";
    let m = initManifest(key, URL_SOURCE);
    m = setStageStatus(m, "acquire", "done", { cmd: "acquire" });
    await writeJson(manifestPath(key), m);

    const calls: SpawnCall[] = [];
    const spawn = fixedSpawn(jsonFence(sampleRepoMap()), calls);

    const next = await survey(ctxFor(key, m, spawn));
    expect(next.stages.survey.status).toBe("done");
    // cmd 含 AC-7 readonly 锚点子串。
    expect(next.stages.survey.cmd).toContain("--allowedTools Read,Glob,Grep");

    // CAS：产物文件存在 ⟺ done。
    expect(await pathExists(repoMapPath(key))).toBe(true);
    const onDisk = await readJson<RepoMap>(repoMapPath(key));
    expect(onDisk.root).toBe("work/source");
    expect(onDisk.languages).toEqual(["ts"]);

    // 调过一次 claude。
    expect(calls.length).toBe(1);
  });

  test("失败：surveyor 返回非 json → failed；不落盘 repo-map.json（CAS）", async () => {
    const key = "surv-fail";
    let m = initManifest(key, URL_SOURCE);
    m = setStageStatus(m, "acquire", "done", { cmd: "acquire" });
    await writeJson(manifestPath(key), m);

    const spawn = fixedSpawn("not json at all");
    const next = await survey(ctxFor(key, m, spawn));
    expect(next.stages.survey.status).toBe("failed");
    // CAS：failed 时产物不应存在。
    expect(await pathExists(repoMapPath(key))).toBe(false);
  });
});

// ===========================================================================
// 03-outline（对抗评审核心）
// ===========================================================================

describe("03-outline · 对抗评审", () => {
  test("首轮 approve 短路：1 轮、final=approved；outline.json 的 topoOrder==topoSort(chapters).order", async () => {
    const key = "out-approve";
    const m = await prepManifestThroughSurvey(key);
    const calls: SpawnCall[] = [];

    const chapters = sampleChapters();
    // 第 1 次：architect 返回 chapters；第 2 次：critic 返回 approve。
    const spawn = makeSeqSpawn(calls, [
      { exitCode: 0, stdout: jsonFence({ chapters }), stderr: "" },
      { exitCode: 0, stdout: jsonFence({ verdict: "approve", fixes: [] }), stderr: "" },
    ]);

    const next = await outline(ctxFor(key, m, spawn));
    expect(next.stages.outline.status).toBe("done");
    expect(next.stages.outline.review).not.toBeNull();
    expect(next.stages.outline.review?.rounds).toBe(1);
    expect(next.stages.outline.review?.final).toBe("approved");
    expect(next.stages.outline.review?.trace).toHaveLength(1);
    expect(next.stages.outline.review?.trace[0].verdict).toBe("approve");

    // 调了 2 次 claude（architect + critic）。
    expect(calls.length).toBe(2);

    // CAS：outline.json 已落盘；topoOrder 由 stage 注入（== topoSort 计算）。
    expect(await pathExists(outlinePath(key))).toBe(true);
    const onDisk = await readJson<Outline>(outlinePath(key));
    const expectedOrder = topoSort(chapters.map((c) => ({ slug: c.slug, dependsOn: c.dependsOn }))).order;
    expect(onDisk.topoOrder).toEqual(expectedOrder);
    expect(onDisk.chapters.map((c) => c.slug)).toEqual(chapters.map((c) => c.slug));

    // registerChapters：manifest.chapters 按 topoOrder 就绪。
    expect(Object.keys(next.chapters).sort()).toEqual([...expectedOrder].sort());
    expect(next.chapterOrder).toEqual(expectedOrder);
  });

  test("到上限未过：rounds==reviewRounds、final=accepted-with-warning；trace 有 N 条", async () => {
    const key = "out-stuck";
    const m = await prepManifestThroughSurvey(key);
    const calls: SpawnCall[] = [];

    const chapters = sampleChapters();
    // reviewRounds=2：architect 2 次 + critic 2 次（全 reject）。
    const spawn = makeSeqSpawn(calls, [
      { exitCode: 0, stdout: jsonFence({ chapters }), stderr: "" },
      { exitCode: 0, stdout: jsonFence({ verdict: "reject", fixes: ["改 A", "改 B"] }), stderr: "" },
      { exitCode: 0, stdout: jsonFence({ chapters }), stderr: "" },
      { exitCode: 0, stdout: jsonFence({ verdict: "reject", fixes: ["再改"] }), stderr: "" },
    ]);

    const next = await outline(ctxFor(key, m, spawn, { reviewRounds: 2 }));
    expect(next.stages.outline.status).toBe("done");
    expect(next.stages.outline.review?.rounds).toBe(2);
    expect(next.stages.outline.review?.final).toBe("accepted-with-warning");
    expect(next.stages.outline.review?.trace).toHaveLength(2);
    expect(next.stages.outline.review?.trace[0].verdict).toBe("reject");
    expect(next.stages.outline.review?.trace[0].fixes).toEqual(["改 A", "改 B"]);
    expect(calls.length).toBe(4);

    // CAS：即便 accepted-with-warning，outline.json 仍落盘（最后版本）。
    expect(await pathExists(outlinePath(key))).toBe(true);
  });

  test("reject→修订：第 1 轮 reject+fixes、第 2 轮 approve → rounds=2、final=approved", async () => {
    const key = "out-revise";
    const m = await prepManifestThroughSurvey(key);
    const calls: SpawnCall[] = [];

    const chaptersV1 = sampleChapters();
    // 第 2 轮 architect 返回稍改的 chapters（仍合法 DAG）。
    const chaptersV2: Chapter[] = chaptersV1.map((c) => ({ ...c, title: c.title + " v2" }));

    const spawn = makeSeqSpawn(calls, [
      // 第 1 轮 architect。
      { exitCode: 0, stdout: jsonFence({ chapters: chaptersV1 }), stderr: "" },
      // 第 1 轮 critic：reject。
      { exitCode: 0, stdout: jsonFence({ verdict: "reject", fixes: ["title 要改"] }), stderr: "" },
      // 第 2 轮 architect（带了 feedback，返回 v2）。
      { exitCode: 0, stdout: jsonFence({ chapters: chaptersV2 }), stderr: "" },
      // 第 2 轮 critic：approve。
      { exitCode: 0, stdout: jsonFence({ verdict: "approve", fixes: [] }), stderr: "" },
    ]);

    const next = await outline(ctxFor(key, m, spawn, { reviewRounds: 2 }));
    expect(next.stages.outline.review?.rounds).toBe(2);
    expect(next.stages.outline.review?.final).toBe("approved");
    expect(next.stages.outline.review?.trace).toHaveLength(2);
    expect(next.stages.outline.review?.trace[0].verdict).toBe("reject");
    expect(next.stages.outline.review?.trace[1].verdict).toBe("approve");

    // 第 2 轮 architect 调用的 prompt 应含上一轮 critic 的 fixes（feedback 透传）。
    // calls[2] 是第 2 次 architect 调用（args[1] 是 -p 的 prompt）。
    const arch2Prompt = calls[2].args[1];
    expect(arch2Prompt).toContain("title 要改");
    expect(arch2Prompt).toContain("Critic 反馈");

    // 落盘的是 v2（最后版本）。
    const onDisk = await readJson<Outline>(outlinePath(key));
    expect(onDisk.chapters[0].title).toContain("v2");
  });

  test("hasCycle：architect 返回成环 dependsOn → stage failed（不走 critic）", async () => {
    const key = "out-cycle";
    const m = await prepManifestThroughSurvey(key);
    const calls: SpawnCall[] = [];

    // A dependsOn B、B dependsOn A → 成环。
    const cyclic: Chapter[] = [
      { slug: "a", title: "A", layer: "primitive", dependsOn: ["b"], sourceFiles: [], summary: "" },
      { slug: "b", title: "B", layer: "primitive", dependsOn: ["a"], sourceFiles: [], summary: "" },
    ];

    const spawn = makeSeqSpawn(calls, [
      { exitCode: 0, stdout: jsonFence({ chapters: cyclic }), stderr: "" },
    ]);

    const next = await outline(ctxFor(key, m, spawn));
    expect(next.stages.outline.status).toBe("failed");
    expect(next.stages.outline.cmd).toContain("拓扑校验失败");
    expect(next.stages.outline.cmd).toContain("环");
    // 没调 critic（只调了 architect）。
    expect(calls.length).toBe(1);
  });

  test("danglingRefs：architect 返回悬空引用 → stage failed", async () => {
    const key = "out-dangle";
    const m = await prepManifestThroughSurvey(key);
    const calls: SpawnCall[] = [];

    const dangling: Chapter[] = [
      { slug: "a", title: "A", layer: "primitive", dependsOn: ["ghost"], sourceFiles: [], summary: "" },
    ];

    const spawn = makeSeqSpawn(calls, [
      { exitCode: 0, stdout: jsonFence({ chapters: dangling }), stderr: "" },
    ]);

    const next = await outline(ctxFor(key, m, spawn));
    expect(next.stages.outline.status).toBe("failed");
    expect(next.stages.outline.cmd).toContain("悬空引用");
    expect(next.stages.outline.cmd).toContain("ghost");
  });

  test("architect 失败（非零退出）→ stage failed，不调 critic", async () => {
    const key = "out-arch-fail";
    const m = await prepManifestThroughSurvey(key);
    const spawn = fixedSpawn("garbage", [], "claude error", 1);
    const next = await outline(ctxFor(key, m, spawn));
    expect(next.stages.outline.status).toBe("failed");
  });
});

// ===========================================================================
// 04-research（并发）
// ===========================================================================

describe("04-research · 并发 + 单点隔离", () => {
  test("成功：每章 research.md 被写、chapters[*].research=done、stage=done（CAS）", async () => {
    const key = "res-ok";
    const chapters = sampleChapters();
    const m = await prepManifestThroughOutline(key, chapters);
    const calls: SpawnCall[] = [];

    // 3 章，每次 reader 返回 markdown fence（内容含 slug 以便区分）。
    const spawn = makeSeqSpawn(calls, [
      (call) => {
        // 从 prompt 里抽出 slug（prompt 含 "本章 slug: xxx"）。
        const slugMatch = call.args[1].match(/本章 slug: ([a-z]+)/);
        const slug = slugMatch ? slugMatch[1] : "x";
        return { exitCode: 0, stdout: mdFence(`# ${slug} 研究\n事实摘录`), stderr: "" };
      },
      (call) => {
        const slugMatch = call.args[1].match(/本章 slug: ([a-z]+)/);
        const slug = slugMatch ? slugMatch[1] : "y";
        return { exitCode: 0, stdout: mdFence(`# ${slug} 研究`), stderr: "" };
      },
      (call) => {
        const slugMatch = call.args[1].match(/本章 slug: ([a-z]+)/);
        const slug = slugMatch ? slugMatch[1] : "z";
        return { exitCode: 0, stdout: mdFence(`# ${slug} 研究`), stderr: "" };
      },
    ]);

    const next = await research(ctxFor(key, m, spawn));
    expect(next.stages.research.status).toBe("done");
    // 每章 done。
    for (const c of chapters) {
      expect(next.chapters[c.slug].research.status).toBe("done");
      // CAS：产物文件存在。
      expect(await pathExists(researchPath(key, c.slug))).toBe(true);
    }
    expect(calls.length).toBe(3);
  });

  test("隔离：一个 reader 失败 → 该章 failed、其它章不受影响（stage 仍 done）", async () => {
    const key = "res-iso";
    const chapters = sampleChapters();
    const m = await prepManifestThroughOutline(key, chapters);

    // beta 章 reader 返回非 markdown（失败）；alpha/gamma 正常。
    const spawn = makeSeqSpawn([], [
      (call) => {
        const slugMatch = call.args[1].match(/本章 slug: ([a-z]+)/);
        const slug = slugMatch ? slugMatch[1] : "";
        if (slug === "beta") {
          return { exitCode: 0, stdout: "not markdown", stderr: "" };
        }
        return { exitCode: 0, stdout: mdFence(`# ${slug} ok`), stderr: "" };
      },
      (call) => {
        const slugMatch = call.args[1].match(/本章 slug: ([a-z]+)/);
        const slug = slugMatch ? slugMatch[1] : "";
        if (slug === "beta") {
          return { exitCode: 0, stdout: "not markdown", stderr: "" };
        }
        return { exitCode: 0, stdout: mdFence(`# ${slug} ok`), stderr: "" };
      },
      (call) => {
        const slugMatch = call.args[1].match(/本章 slug: ([a-z]+)/);
        const slug = slugMatch ? slugMatch[1] : "";
        if (slug === "beta") {
          return { exitCode: 0, stdout: "not markdown", stderr: "" };
        }
        return { exitCode: 0, stdout: mdFence(`# ${slug} ok`), stderr: "" };
      },
    ]);

    const next = await research(ctxFor(key, m, spawn));
    expect(next.stages.research.status).toBe("done");
    expect(next.chapters.beta.research.status).toBe("failed");
    expect(next.chapters.alpha.research.status).toBe("done");
    expect(next.chapters.gamma.research.status).toBe("done");
    // CAS：beta 没产物，alpha/gamma 有。
    expect(await pathExists(researchPath(key, "beta"))).toBe(false);
    expect(await pathExists(researchPath(key, "alpha"))).toBe(true);
  });

  test("outline 缺失 → stage failed", async () => {
    const key = "res-no-outline";
    // 不写 outline.json。
    let m = await prepManifestThroughSurvey(key);
    const next = await research(ctxFor(key, m, fixedSpawn("")));
    expect(next.stages.research.status).toBe("failed");
    expect(next.stages.research.cmd).toContain("读 outline 失败");
  });
});

// ===========================================================================
// 05-write（并发 + 每章对抗评审）
// ===========================================================================

describe("05-write · 并发 + 每章对抗评审", () => {
  /**
   * 造一个「writer 落盘 draft.md」的 mock spawn：调 writer 时写 draft.md，
   * 调 critic 时返回 verdict。
   * 用 presetSeq 控制 critic 每轮 verdict。
   */
  function makeWriterCriticSpawn(
    key: string,
    criticSeq: ("approve" | "reject")[],
    calls: SpawnCall[],
  ): SpawnFn {
    let criticIdx = 0;
    // 用计数器区分 writer / critic 调用：看 prompt 含 "你是 Writer" 还是 "你是 Critic"。
    return async (args, opts) => {
      const call: SpawnCall = { args: [...args], cwd: opts.cwd };
      calls.push(call);
      const prompt = args[1] ?? "";
      if (prompt.includes("你是 Writer")) {
        // 从 prompt 抽 slug，落盘 draft.md（Writer 自己落盘的模拟）。
        const slugMatch = prompt.match(/本章 slug: ([a-z]+)/);
        const slug = slugMatch ? slugMatch[1] : "x";
        await writeText(draftPath(key, slug), `# ${slug} 草稿\n正文`);
        return { exitCode: 0, stdout: "writer done", stderr: "" };
      }
      if (prompt.includes("你是 Critic")) {
        const verdict = criticSeq[criticIdx++] ?? "approve";
        const fixes = verdict === "reject" ? ["改这里"] : [];
        return {
          exitCode: 0,
          stdout: jsonFence({ verdict, fixes }),
          stderr: "",
        };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };
  }

  test("成功（首轮 approve）：每章 draft.md 存在、write=done + review trace", async () => {
    const key = "wr-ok";
    const chapters = sampleChapters();
    let m = await prepManifestThroughOutline(key, chapters);
    // 预置 research.md（write 前置）。
    for (const c of chapters) {
      await writeText(researchPath(key, c.slug), `# ${c.slug} 研究`);
    }
    const calls: SpawnCall[] = [];
    // 3 章 × (writer + critic) = 6 次，全部首轮 approve。
    const criticSeq: ("approve" | "reject")[] = ["approve", "approve", "approve"];
    const spawn = makeWriterCriticSpawn(key, criticSeq, calls);

    const next = await write(ctxFor(key, m, spawn));
    expect(next.stages.write.status).toBe("done");
    for (const c of chapters) {
      expect(next.chapters[c.slug].write.status).toBe("done");
      expect(next.chapters[c.slug].write.review).not.toBeNull();
      expect(next.chapters[c.slug].write.review?.final).toBe("approved");
      expect(next.chapters[c.slug].write.review?.rounds).toBe(1);
      // CAS：draft.md 存在。
      expect(await pathExists(draftPath(key, c.slug))).toBe(true);
    }
    expect(calls.length).toBe(6); // 3 writer + 3 critic
  });

  test("reject→approve：trace 有 2 条（reject+approve），final=approved", async () => {
    const key = "wr-revise";
    const chapters = [sampleChapters()[0]]; // 单章简化
    let m = await prepManifestThroughOutline(key, chapters);
    await writeText(researchPath(key, "alpha"), "# alpha 研究");
    const calls: SpawnCall[] = [];

    // 第 1 轮 critic reject，第 2 轮 approve。
    const spawn = makeWriterCriticSpawn(key, ["reject", "approve"], calls);

    const next = await write(ctxFor(key, m, spawn, { reviewRounds: 2 }));
    expect(next.chapters.alpha.write.status).toBe("done");
    expect(next.chapters.alpha.write.review?.rounds).toBe(2);
    expect(next.chapters.alpha.write.review?.final).toBe("approved");
    expect(next.chapters.alpha.write.review?.trace).toHaveLength(2);
    expect(next.chapters.alpha.write.review?.trace[0].verdict).toBe("reject");
    expect(next.chapters.alpha.write.review?.trace[1].verdict).toBe("approve");

    // 第 2 轮 writer 调用的 prompt 应含上一轮 critic fixes（feedback 透传）。
    // 找第 2 次 writer 调用（第 3 次总调用：writer1, critic1, writer2, critic2）。
    const writer2Prompt = calls[2].args[1];
    expect(writer2Prompt).toContain("改这里");
    expect(writer2Prompt).toContain("Critic 反馈");
  });

  test("到上限未过：final=accepted-with-warning", async () => {
    const key = "wr-stuck";
    const chapters = [sampleChapters()[0]];
    let m = await prepManifestThroughOutline(key, chapters);
    await writeText(researchPath(key, "alpha"), "# alpha 研究");
    const calls: SpawnCall[] = [];

    // 2 轮全 reject。
    const spawn = makeWriterCriticSpawn(key, ["reject", "reject"], calls);
    const next = await write(ctxFor(key, m, spawn, { reviewRounds: 2 }));
    expect(next.chapters.alpha.write.status).toBe("done");
    expect(next.chapters.alpha.write.review?.final).toBe("accepted-with-warning");
    expect(next.chapters.alpha.write.review?.rounds).toBe(2);
  });

  test("缺料：research.md 不存在 → write=failed（不调 writer）", async () => {
    const key = "wr-missing";
    const chapters = [sampleChapters()[0]];
    let m = await prepManifestThroughOutline(key, chapters);
    // 故意不写 research.md。
    const calls: SpawnCall[] = [];
    const spawn = makeWriterCriticSpawn(key, ["approve"], calls);
    const next = await write(ctxFor(key, m, spawn));
    expect(next.chapters.alpha.write.status).toBe("failed");
    expect(next.chapters.alpha.write.cmd).toContain("research.md 缺失");
    // 不调 claude。
    expect(calls.length).toBe(0);
  });
});

// ===========================================================================
// 06-assemble
// ===========================================================================

describe("06-assemble · site 结构校验", () => {
  /**
   * 造一个「assembler 真落盘 site/」的 mock spawn：调 assembler 时按 topoOrder
   * 写 guide/{nn}-{slug}.md + config.ts + index.md + package.json。
   */
  function makeAssemblerSpawn(key: string, calls: SpawnCall[]): SpawnFn {
    return async (args, opts) => {
      const call: SpawnCall = { args: [...args], cwd: opts.cwd };
      calls.push(call);
      const prompt = args[1] ?? "";
      if (prompt.includes("你是 Assembler")) {
        // 从 prompt 嵌入的 outline digest 抽 topoOrder。
        // digest 形如 JSON，含 "topoOrder": [...].
        const topoMatch = prompt.match(/"topoOrder":\s*\[([^\]]*)\]/);
        const topoRaw = topoMatch ? topoMatch[1] : "";
        const topoOrder = topoRaw
          .split(",")
          .map((s) => s.replace(/"/g, "").trim())
          .filter(Boolean);

        const site = siteDir(key);
        // 写 guide/{nn}-{slug}.md。
        await ensureDir(joinPath(site, "guide/"));
        for (let i = 0; i < topoOrder.length; i++) {
          const slug = topoOrder[i];
          const nn = (i + 1).toString().padStart(2, "0");
          await writeText(joinPath(site, `guide/${nn}-${slug}.md`), `# ${slug}`);
        }
        // 写脚手架。
        await ensureDir(joinPath(site, ".vitepress/"));
        await writeText(joinPath(site, ".vitepress/config.ts"), "export default {}");
        await writeText(joinPath(site, "index.md"), "# Home");
        await writeText(joinPath(site, "package.json"), JSON.stringify({ name: "site" }));
        return { exitCode: 0, stdout: "assembled", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };
  }

  test("成功：site 结构完整；guide/{nn}-{slug}.md 齐全；nn==topo 序号（AC-4）", async () => {
    const key = "asm-ok";
    const chapters = sampleChapters();
    let m = await prepManifestThroughOutline(key, chapters);
    // write stage 产物（draft.md）—— assembler 会读，但 mock 不真读，只需 stage 前置 done。
    m = setStageStatus(m, "research", "done");
    m = setStageStatus(m, "write", "done");
    await writeJson(manifestPath(key), m);

    const calls: SpawnCall[] = [];
    const spawn = makeAssemblerSpawn(key, calls);
    const next = await assemble(ctxFor(key, m, spawn));
    expect(next.stages.assemble.status).toBe("done");
    expect(next.stages.assemble.cmd).toContain("Write");

    // site 结构校验。
    const site = siteDir(key);
    expect(await pathExists(joinPath(site, ".vitepress/config.ts"))).toBe(true);
    expect(await pathExists(joinPath(site, "index.md"))).toBe(true);
    expect(await pathExists(joinPath(site, "package.json"))).toBe(true);

    // guide 文件编号 == topo 序号（AC-4）。
    const onDiskOutline = await readJson<Outline>(outlinePath(key));
    const topoOrder = onDiskOutline.topoOrder;
    for (let i = 0; i < topoOrder.length; i++) {
      const slug = topoOrder[i];
      const nn = (i + 1).toString().padStart(2, "0");
      const expected = joinPath(site, `guide/${nn}-${slug}.md`);
      expect(await pathExists(expected)).toBe(true);
    }
    expect(calls.length).toBe(1);
  });

  test("assembler 失败 → stage failed", async () => {
    const key = "asm-fail";
    let m = await prepManifestThroughOutline(key);
    m = setStageStatus(m, "write", "done");
    await writeJson(manifestPath(key), m);

    const spawn = fixedSpawn("", [], "assembler error", 1);
    const next = await assemble(ctxFor(key, m, spawn));
    expect(next.stages.assemble.status).toBe("failed");
  });

  test("结构不全（缺 config.ts）→ stage failed（保留已生成 site/）", async () => {
    const key = "asm-incomplete";
    let m = await prepManifestThroughOutline(key);
    m = setStageStatus(m, "write", "done");
    await writeJson(manifestPath(key), m);

    // mock 只写 index.md，故意漏 config.ts。
    const spawn: SpawnFn = async (args, opts) => {
      const site = siteDir(key);
      await writeText(joinPath(site, "index.md"), "# Home");
      return { exitCode: 0, stdout: "partial", stderr: "" };
    };

    const next = await assemble(ctxFor(key, m, spawn));
    expect(next.stages.assemble.status).toBe("failed");
    expect(next.stages.assemble.cmd).toContain("结构校验失败");
    // 保留已生成的 site/。
    expect(await pathExists(joinPath(siteDir(key), "index.md"))).toBe(true);
  });
});

// ===========================================================================
// 07-build
// ===========================================================================

describe("07-build", () => {
  test("skipBuild=true → done (cmd=(skipped))", async () => {
    const key = "bld-skip";
    let m = initManifest(key, LOCAL_SOURCE);
    m = setStageStatus(m, "acquire", "done");
    m = setStageStatus(m, "assemble", "done");
    await writeJson(manifestPath(key), m);

    const next = await build(ctxFor(key, m, undefined, { skipBuild: true }));
    expect(next.stages.build.status).toBe("done");
    expect(next.stages.build.cmd).toBe("(skipped)");
  });

  test("site/package.json 缺 → failed（不调 bun）", async () => {
    const key = "bld-no-pkg";
    let m = initManifest(key, LOCAL_SOURCE);
    m = setStageStatus(m, "assemble", "done");
    await writeJson(manifestPath(key), m);
    // 故意不造 site/package.json。

    const next = await build(ctxFor(key, m));
    expect(next.stages.build.status).toBe("failed");
    expect(next.stages.build.cmd).toContain("package.json 不存在");
  });
});

// ===========================================================================
// 探针：mini run 目录手测 outline topoOrder 注入
// ===========================================================================

describe("探针 · outline topoOrder 注入（mini run）", () => {
  test("手动构造 outline stage：architect 返回 chapters → stage 注入的 topoOrder 满足 verifyClosure", async () => {
    const key = "probe-topo";
    const m = await prepManifestThroughSurvey(key);

    // 构造一个有依赖的 4 章 DAG。
    const dag: Chapter[] = [
      { slug: "d", title: "D", layer: "primitive", dependsOn: [], sourceFiles: [], summary: "" },
      { slug: "c", title: "C", layer: "primitive", dependsOn: ["d"], sourceFiles: [], summary: "" },
      { slug: "b", title: "B", layer: "composite", dependsOn: ["d"], sourceFiles: [], summary: "" },
      { slug: "a", title: "A", layer: "system", dependsOn: ["b", "c"], sourceFiles: [], summary: "" },
    ];
    // 声明顺序是 d,c,b,a；A 依赖 B,C；B,C 依赖 D。合法 topoOrder 应让 D 在最前。

    const spawn = makeSeqSpawn([], [
      { exitCode: 0, stdout: jsonFence({ chapters: dag }), stderr: "" },
      { exitCode: 0, stdout: jsonFence({ verdict: "approve", fixes: [] }), stderr: "" },
    ]);

    const next = await outline(ctxFor(key, m, spawn));
    expect(next.stages.outline.status).toBe("done");

    const onDisk = await readJson<Outline>(outlinePath(key));
    const { verifyClosure } = await import("../src/lib/topo.ts");
    // stage 注入的 topoOrder 必须满足所有 dependsOn 闭包在前（自底向上不变量）。
    const verify = verifyClosure(
      onDisk.topoOrder,
      dag.map((c) => ({ slug: c.slug, dependsOn: c.dependsOn })),
    );
    expect(verify.ok).toBe(true);
    // D 必须排在最前（被所有人依赖）。
    expect(onDisk.topoOrder[0]).toBe("d");
    // A 必须排在最后（依赖所有人）。
    expect(onDisk.topoOrder[onDisk.topoOrder.length - 1]).toBe("a");
  });
});

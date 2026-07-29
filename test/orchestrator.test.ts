// test/orchestrator.test.ts：M10 顶层无状态循环的单元测试。
// 用 bun:test。**全程 mock spawn + 临时 runDir（process.chdir 到临时目录）**，
// 不真调 claude/git/build（design §15 / task M10 单测纪律）。
//
// 核心断言锚点（AC-1 / AC-3 / design §1 / §9 / §15）：
//   - **AC-1 端到端 mock 跑通**：runPipeline 从空 manifest 跑到 build done，
//     返回 ok:true，关键产物齐全，最后日志含 `[atlas] run {key} complete.`。
//   - **AC-3 续跑**：survey/outline done 后中断，再调 runPipeline 不重跑已 done 的
//     stage/chapter（startedAt 不变、cmd 不变），从中断处继续。
//   - **--from research / --only outline / --force**：覆盖三种范围控制。
//   - **失败终止（design §15）**：某 stage failed → 循环停止、ok:false、下游未执行。
//
// mock 策略：一个「智能 mockSpawn」根据 prompt 内容判断当前角色（Surveyor/Architect/
// Critic/Reader/Writer/Assembler），返回对应预设产物；Writer/Assembler 的 mock 会
// 真的写文件到 runDir，让 stage 的产物校验通过。

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 被测 orchestrator。
import { runPipeline } from "../src/orchestrator.ts";

// 上游 lib。
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
  joinPath,
} from "../src/lib/io.ts";
import {
  loadManifest,
  setStageStatus,
  setChapterStatus,
  type SourceInfo,
} from "../src/lib/manifest.ts";
import { topoSort } from "../src/lib/topo.ts";
import type { SpawnFn } from "../src/lib/run-claude.ts";
import type { RepoMap, Outline, Chapter } from "../src/lib/types.ts";

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

let tmpRoot = "";
let savedCwd = "";

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "atlas-orch-"));
  savedCwd = process.cwd();
  process.chdir(tmpRoot);
});

afterEach(async () => {
  process.chdir(savedCwd);
  await rm(tmpRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// mock spawn：按 prompt 内容判断角色，返回对应预设产物
// ---------------------------------------------------------------------------

interface SpawnCall {
  args: string[];
  cwd: string;
}

/**
 * 造一个 mock spawn 工厂。
 *
 * 根据 prompt 内容（args[1]）判断当前角色，返回对应预设产物：
 *   - "你是 Surveyor" → ```json repo-map
 *   - "你是 Architect" → ```json {chapters}
 *   - "你是 Critic" · Outline/Chapter → ```json {verdict:"approve"}
 *   - "你是 Reader" → ````markdown research.md
 *   - "技术文档撰写员" → 真的写 draft.md 到 runDir，返回成功
 *   - "你是 Assembler" → 真的写 site/ 骨架到 runDir，返回成功
 *
 * chapters 用于 Architect 与 Assembler（取 topoOrder）；criticSeq 可覆盖 critic 返回
 * （默认 approve）；writerDraftFn 可定制 writer 落盘内容（默认 # slug 草稿）。
 * calls 收集每次调用的 args/cwd 便于断言「哪个 stage 跑了几次」。
 */
interface MockSpawnOpts {
  key: string;
  chapters: Chapter[];
  calls: SpawnCall[];
  /** critic 的 verdict 序列（按调用序消费）；默认全部 "approve"。 */
  criticVerdict?: ("approve" | "reject")[];
  /** writer 是否真落盘 draft.md（默认 true）。关掉可测 write stage 失败。 */
  writerWriteDraft?: boolean;
  /** writer 的 exitCode（默认 0）；设非 0 可测 write stage 失败。 */
  writerExit?: number;
  /** architect 的 exitCode（默认 0）；设非 0 可测 outline stage 失败。 */
  architectExit?: number;
}

function jsonFence(obj: unknown): string {
  return "```json\n" + JSON.stringify(obj) + "\n```";
}

function mdFence(text: string): string {
  return "````markdown\n" + text + "\n````";
}

function makeMockSpawn(o: MockSpawnOpts): SpawnFn {
  let criticIdx = 0;
  const criticVerdict = o.criticVerdict ?? [];
  const writerWriteDraft = o.writerWriteDraft ?? true;
  const writerExit = o.writerExit ?? 0;
  const architectExit = o.architectExit ?? 0;

  return async (args, opts) => {
    const call: SpawnCall = { args: [...args], cwd: opts.cwd };
    o.calls.push(call);
    const prompt = args[1] ?? "";

    // Surveyor：返回 repo-map。
    if (prompt.includes("你是 Surveyor")) {
      const repoMap: RepoMap = {
        root: "work/source",
        sourceKind: "git-clone",
        languages: ["ts"],
        frameworks: [],
        entrypoints: ["src/index.ts"],
        manifests: ["package.json"],
        packages: [],
        tree: [{ path: "src/index.ts", type: "file", role: "entry" }],
        docs: ["README.md"],
      };
      return { exitCode: 0, stdout: jsonFence(repoMap), stderr: "" };
    }

    // Architect：返回 chapters。
    if (prompt.includes("你是 Architect")) {
      if (architectExit !== 0) {
        return { exitCode: architectExit, stdout: "", stderr: "architect error" };
      }
      return {
        exitCode: 0,
        stdout: jsonFence({ chapters: o.chapters }),
        stderr: "",
      };
    }

    // Critic（Outline 或 Chapter 都用同一序列）。
    if (prompt.includes("你是 Critic")) {
      const verdict = criticVerdict[criticIdx++] ?? "approve";
      const fixes = verdict === "reject" ? ["改这里"] : [];
      return {
        exitCode: 0,
        stdout: jsonFence({ verdict, fixes }),
        stderr: "",
      };
    }

    // Reader：从 prompt 抽 slug，返回 markdown fence。
    if (prompt.includes("你是 Reader")) {
      const slugMatch = prompt.match(/本章 slug: ([a-z0-9-]+)/);
      const slug = slugMatch ? slugMatch[1] : "x";
      return {
        exitCode: 0,
        stdout: mdFence(`# ${slug} 研究\n事实摘录\n\n源码位置: src/${slug}.ts:1`),
        stderr: "",
      };
    }

    // Writer：返回 markdown fence（stage 提取后落盘 draft.md）。
    if (prompt.includes("技术文档撰写员")) {
      if (writerExit !== 0) {
        return { exitCode: writerExit, stdout: "", stderr: "writer error" };
      }
      // slug 从 cwd（chapterDir）提取。
      const slugMatch = opts.cwd.match(/chapters\/([a-z0-9-]+)\/?$/);
      const slug = slugMatch ? slugMatch[1] : "x";
      return { exitCode: 0, stdout: mdFence(`# ${slug} 草稿\n\n正文。\n`), stderr: "" };
    }

    // Assembler：真落盘 site/ 骨架（让 stage 结构校验通过）。
    if (prompt.includes("你是 Assembler")) {
      // 从嵌入的 outline digest 抽 topoOrder。
      const topoMatch = prompt.match(/"topoOrder":\s*\[([^\]]*)\]/);
      const topoRaw = topoMatch ? topoMatch[1] : "";
      const topoOrder = topoRaw
        .split(",")
        .map((s) => s.replace(/"/g, "").trim())
        .filter(Boolean);

      const site = siteDir(o.key);
      await ensureDir(joinPath(site, "guide/"));
      for (let i = 0; i < topoOrder.length; i++) {
        const slug = topoOrder[i];
        const nn = (i + 1).toString().padStart(2, "0");
        await writeText(joinPath(site, `guide/${nn}-${slug}.md`), `# ${slug}`);
      }
      await ensureDir(joinPath(site, ".vitepress/"));
      await writeText(joinPath(site, ".vitepress/config.ts"), "export default {}");
      await writeText(joinPath(site, "index.md"), "# Home");
      await writeText(joinPath(site, "package.json"), JSON.stringify({ name: "site" }));
      return { exitCode: 0, stdout: "assembled", stderr: "" };
    }

    // 兜底：空成功。
    return { exitCode: 0, stdout: "", stderr: "" };
  };
}

// ---------------------------------------------------------------------------
// 常用产物构造器
// ---------------------------------------------------------------------------

/** 3 章 DAG：A ← B（B dependsOn A），C 独立（无依赖）。 */
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
      dependsOn: [],
      sourceFiles: ["src/c.ts"],
      summary: "gamma 总结",
    },
  ];
}

/** 日志收集器：返回一个数组 + push 回调。 */
function logCollector(): { logs: string[]; onLog: (m: string) => void } {
  const logs: string[] = [];
  return { logs, onLog: (m: string) => logs.push(m) };
}

// ===========================================================================
// AC-1：端到端 mock 跑通（核心）
// ===========================================================================

describe("AC-1 端到端 mock 跑通", () => {
  test("从空 manifest 跑到 build done：ok:true、所有 stage done、关键产物齐全、complete 日志", async () => {
    const key = "e2e-ok";
    const localSrc = join(tmpRoot, "src-repo");
    await mkdir(localSrc, { recursive: true });
    const source: SourceInfo = { kind: "local", ref: localSrc, localPath: localSrc };
    const chapters = sampleChapters();
    const calls: SpawnCall[] = [];
    const { logs, onLog } = logCollector();
    const spawn = makeMockSpawn({ key, chapters, calls });

    const result = await runPipeline({
      key,
      source,
      spawn,
      onLog,
      flags: { skipBuild: true }, // 单测不真跑 bun build。
    });

    // ok:true。
    expect(result.ok).toBe(true);
    expect(result.key).toBe(key);

    // 所有 stage done。
    const m = await loadManifest(key);
    for (const s of ["acquire", "survey", "outline", "research", "write", "assemble", "build"] as const) {
      expect(m.stages[s].status).toBe("done");
    }
    // 每章 research/write done。
    for (const c of chapters) {
      expect(m.chapters[c.slug].research.status).toBe("done");
      expect(m.chapters[c.slug].write.status).toBe("done");
    }

    // 关键产物存在。
    expect(await pathExists(repoMapPath(key))).toBe(true);
    expect(await pathExists(outlinePath(key))).toBe(true);
    for (const c of chapters) {
      expect(await pathExists(researchPath(key, c.slug))).toBe(true);
      expect(await pathExists(draftPath(key, c.slug))).toBe(true);
    }
    // site/guide/{nn}-{slug}.md 齐全。
    const onDiskOutline = await readJson<Outline>(outlinePath(key));
    const site = siteDir(key);
    for (let i = 0; i < onDiskOutline.topoOrder.length; i++) {
      const slug = onDiskOutline.topoOrder[i];
      const nn = (i + 1).toString().padStart(2, "0");
      expect(await pathExists(joinPath(site, `guide/${nn}-${slug}.md`))).toBe(true);
    }
    expect(await pathExists(joinPath(site, "package.json"))).toBe(true);

    // 最后日志含 complete 串（AC-1 / verification.md 第 17 行期望串）。
    expect(logs.some((l) => l === `[atlas] run ${key} complete.`)).toBe(true);
    // 每个 stage 都有开始与 done 日志。
    for (const s of ["acquire", "survey", "outline", "research", "write", "assemble", "build"]) {
      expect(logs.some((l) => l.includes(`[atlas] ${key} ${s} 开始`))).toBe(true);
      expect(logs.some((l) => l.includes(`[atlas] ${key} ${s} done`))).toBe(true);
    }

    // build 跳过：cmd=(skipped)。
    expect(m.stages.build.cmd).toBe("(skipped)");
  });

  test("续跑语义：survey/outline 已 done 时，再调 runPipeline 不重跑（cmd/startedAt 不变）", async () => {
    const key = "e2e-resume-survey";
    const localSrc = join(tmpRoot, "src-repo");
    await mkdir(localSrc, { recursive: true });
    const source: SourceInfo = { kind: "local", ref: localSrc, localPath: localSrc };
    const chapters = sampleChapters();
    const calls1: SpawnCall[] = [];
    const { logs: logs1, onLog: onLog1 } = logCollector();
    const spawn1 = makeMockSpawn({ key, chapters, calls: calls1 });

    // 第一次：跑到 outline done 后「中断」——通过 --only outline 限定范围。
    const r1 = await runPipeline({
      key, source, spawn: spawn1, onLog: onLog1,
      flags: { only: "outline" },
    });
    expect(r1.ok).toBe(true);
    // 但 --only outline 不会跑 acquire/survey（它们不是 outline）。
    // 所以这里需要换一种构造：先预置 acquire+survey done，再 only outline。
    // 简化：直接用第一次完整跑的前两 stage 记录作 baseline。

    // 更直接的构造：预置 acquire+survey+outline done（手动），然后续跑 research/write。
    const key2 = "e2e-resume-hand";
    const localSrc2 = join(tmpRoot, "src-repo2");
    await mkdir(localSrc2, { recursive: true });
    const source2: SourceInfo = { kind: "local", ref: localSrc2, localPath: localSrc2 };

    // 预置 manifest：acquire/survey/outline done + registerChapters（带固定 cmd 便于断言「未重跑」）。
    const topo = topoSort(chapters.map((c) => ({ slug: c.slug, dependsOn: c.dependsOn })));
    const outlineObj: Outline = {
      repo: key2, generatedAt: "2026-01-01T00:00:00.000Z",
      chapters, topoOrder: topo.order,
    };
    const m2 = await presetThroughOutline(key2, source2, chapters, outlineObj);

    // baseline：记录 survey/outline 的 cmd 与 startedAt。
    const surveyCmdBefore = m2.stages.survey.cmd;
    const surveyStartedBefore = m2.stages.survey.startedAt;
    const outlineCmdBefore = m2.stages.outline.cmd;
    const outlineStartedBefore = m2.stages.outline.startedAt;

    // 第二次：续跑（research/write/assemble/build）。
    const calls2: SpawnCall[] = [];
    const { logs: logs2, onLog: onLog2 } = logCollector();
    const spawn2 = makeMockSpawn({ key: key2, chapters, calls: calls2 });
    const r2 = await runPipeline({
      key: key2, source: source2, spawn: spawn2, onLog: onLog2,
      flags: { skipBuild: true },
    });
    expect(r2.ok).toBe(true);

    const m2After = await loadManifest(key2);
    // survey/outline 的 cmd 与 startedAt 不变（未重跑，AC-3 核心）。
    expect(m2After.stages.survey.cmd).toBe(surveyCmdBefore);
    expect(m2After.stages.survey.startedAt).toBe(surveyStartedBefore);
    expect(m2After.stages.outline.cmd).toBe(outlineCmdBefore);
    expect(m2After.stages.outline.startedAt).toBe(outlineStartedBefore);
    // research/write/assemble/build 推进到 done。
    expect(m2After.stages.research.status).toBe("done");
    expect(m2After.stages.write.status).toBe("done");
    expect(m2After.stages.assemble.status).toBe("done");
    expect(m2After.stages.build.status).toBe("done");

    // calls2 里不应有 Surveyor/Architect 调用（survey/outline 未重跑）。
    const surveyorCalls = calls2.filter((c) => c.args[1]?.includes("你是 Surveyor"));
    const architectCalls = calls2.filter((c) => c.args[1]?.includes("你是 Architect"));
    expect(surveyorCalls.length).toBe(0);
    expect(architectCalls.length).toBe(0);
    // 应有 Reader/Writer/Assembler 调用。
    expect(calls2.some((c) => c.args[1]?.includes("你是 Reader"))).toBe(true);
    expect(calls2.some((c) => c.args[1]?.includes("技术文档撰写员"))).toBe(true);
    expect(calls2.some((c) => c.args[1]?.includes("你是 Assembler"))).toBe(true);

    // complete 串。
    expect(logs2.some((l) => l === `[atlas] run ${key2} complete.`)).toBe(true);
  });

  test("AC-3 续跑（stage 级）：survey/outline/research 已 done 后中断，再跑只从 write 起推进", async () => {
    const key = "e2e-resume-stage";
    const localSrc = join(tmpRoot, "src-repo");
    await mkdir(localSrc, { recursive: true });
    const source: SourceInfo = { kind: "local", ref: localSrc, localPath: localSrc };
    const chapters = sampleChapters();
    const topo = topoSort(chapters.map((c) => ({ slug: c.slug, dependsOn: c.dependsOn })));

    // 预置：acquire..research done，write/assemble/build 仍 pending（模拟「research 跑完后被中断」）。
    const outlineObj: Outline = {
      repo: key, generatedAt: "2026-01-01T00:00:00.000Z",
      chapters, topoOrder: topo.order,
    };
    let m = await presetThroughOutline(key, source, chapters, outlineObj);
    const slugs = topo.order;
    m = setStageStatus(m, "research", "done", { cmd: "research-stage-cmd" });
    for (const slug of slugs) {
      m = setChapterStatus(m, slug, "research", "done", { cmd: "research-chapter-cmd" });
      // 写 research.md（write stage 的前置）。
      await writeText(researchPath(key, slug), `# ${slug} 研究`);
    }
    await writeJson(manifestPath(key), m);

    // baseline：record survey/outline/research 的 cmd + startedAt，断言续跑后未变。
    const surveyCmdBefore = m.stages.survey.cmd;
    const outlineCmdBefore = m.stages.outline.cmd;
    const researchStageCmdBefore = m.stages.research.cmd;

    const calls: SpawnCall[] = [];
    const { logs, onLog } = logCollector();
    const spawn = makeMockSpawn({ key, chapters, calls });

    const r = await runPipeline({
      key, source, spawn, onLog,
      flags: { skipBuild: true },
    });
    expect(r.ok).toBe(true);

    const mAfter = await loadManifest(key);
    // 已 done 的 stage cmd/startedAt 不变（未重跑，AC-3 核心）。
    expect(mAfter.stages.survey.cmd).toBe(surveyCmdBefore);
    expect(mAfter.stages.outline.cmd).toBe(outlineCmdBefore);
    expect(mAfter.stages.research.cmd).toBe(researchStageCmdBefore);
    // write/assemble/build 推进到 done。
    expect(mAfter.stages.write.status).toBe("done");
    expect(mAfter.stages.assemble.status).toBe("done");
    expect(mAfter.stages.build.status).toBe("done");

    // 续跑期间未调 Surveyor/Architect/Reader（已 done 的 stage 不重跑）。
    expect(calls.some((c) => c.args[1]?.includes("你是 Surveyor"))).toBe(false);
    expect(calls.some((c) => c.args[1]?.includes("你是 Architect"))).toBe(false);
    expect(calls.some((c) => c.args[1]?.includes("你是 Reader"))).toBe(false);
    // 只调了 Writer + Critic + Assembler。
    expect(calls.some((c) => c.args[1]?.includes("技术文档撰写员"))).toBe(true);
    expect(calls.some((c) => c.args[1]?.includes("你是 Assembler"))).toBe(true);

    // complete 串。
    expect(logs.some((l) => l === `[atlas] run ${key} complete.`)).toBe(true);
  });
});

// ===========================================================================
// --from research：跳过前面 stage，从 research 开始
// ===========================================================================

describe("--from <stage>", () => {
  test("--from research：跳过 acquire/survey/outline，从 research 开始；前面 stage 不被调", async () => {
    const key = "from-research";
    const localSrc = join(tmpRoot, "src-repo");
    await mkdir(localSrc, { recursive: true });
    const source: SourceInfo = { kind: "local", ref: localSrc, localPath: localSrc };
    const chapters = sampleChapters();
    const topo = topoSort(chapters.map((c) => ({ slug: c.slug, dependsOn: c.dependsOn })));
    const outlineObj: Outline = {
      repo: key, generatedAt: "2026-01-01T00:00:00.000Z",
      chapters, topoOrder: topo.order,
    };
    // 预置 acquire..outline done + registerChapters。
    await presetThroughOutline(key, source, chapters, outlineObj);

    const calls: SpawnCall[] = [];
    const { logs, onLog } = logCollector();
    const spawn = makeMockSpawn({ key, chapters, calls });

    const r = await runPipeline({
      key, source, spawn, onLog,
      flags: { from: "research", skipBuild: true },
    });
    expect(r.ok).toBe(true);

    // 前面 stage 不被调（无 Surveyor/Architect）。
    expect(calls.some((c) => c.args[1]?.includes("你是 Surveyor"))).toBe(false);
    expect(calls.some((c) => c.args[1]?.includes("你是 Architect"))).toBe(false);
    // research/write/assemble 被调。
    expect(calls.some((c) => c.args[1]?.includes("你是 Reader"))).toBe(true);
    expect(calls.some((c) => c.args[1]?.includes("技术文档撰写员"))).toBe(true);
    expect(calls.some((c) => c.args[1]?.includes("你是 Assembler"))).toBe(true);

    // 日志不含 acquire/survey/outline 的开始（被跳过）。
    expect(logs.some((l) => l.includes(`[atlas] ${key} acquire 开始`))).toBe(false);
    expect(logs.some((l) => l.includes(`[atlas] ${key} survey 开始`))).toBe(false);
    expect(logs.some((l) => l.includes(`[atlas] ${key} outline 开始`))).toBe(false);
    // 含 research/write/assemble/build 的开始。
    expect(logs.some((l) => l.includes(`[atlas] ${key} research 开始`))).toBe(true);
    expect(logs.some((l) => l.includes(`[atlas] ${key} write 开始`))).toBe(true);
    expect(logs.some((l) => l.includes(`[atlas] ${key} assemble 开始`))).toBe(true);
    // complete 串。
    expect(logs.some((l) => l === `[atlas] run ${key} complete.`)).toBe(true);
  });

  test("--from build：manifest 里 build 已 done 时 → 直接 complete（无 stage 可跑）", async () => {
    const key = "from-build-done";
    const localSrc = join(tmpRoot, "src-repo");
    await mkdir(localSrc, { recursive: true });
    const source: SourceInfo = { kind: "local", ref: localSrc, localPath: localSrc };
    // 预置全部 done。
    let m = await presetFullDone(key, source, sampleChapters());
    await writeJson(manifestPath(key), m);

    const calls: SpawnCall[] = [];
    const { logs, onLog } = logCollector();
    const spawn = makeMockSpawn({ key, chapters: sampleChapters(), calls });

    const r = await runPipeline({
      key, source, spawn, onLog,
      flags: { from: "build" },
    });
    expect(r.ok).toBe(true);
    expect(calls.length).toBe(0); // 无任何 spawn 调用。
    expect(logs.some((l) => l === `[atlas] run ${key} complete.`)).toBe(true);
  });
});

// ===========================================================================
// --only outline：只跑 outline
// ===========================================================================

describe("--only <stage>", () => {
  test("--only outline：只跑 outline，不进 research/write；complete 串仍打印", async () => {
    const key = "only-outline";
    const localSrc = join(tmpRoot, "src-repo");
    await mkdir(localSrc, { recursive: true });
    const source: SourceInfo = { kind: "local", ref: localSrc, localPath: localSrc };
    // 预置 acquire/survey done。
    let m = await presetThroughSurvey(key, source);

    const chapters = sampleChapters();
    const calls: SpawnCall[] = [];
    const { logs, onLog } = logCollector();
    const spawn = makeMockSpawn({ key, chapters, calls });

    const r = await runPipeline({
      key, source, spawn, onLog,
      flags: { only: "outline" },
    });
    expect(r.ok).toBe(true);

    const mAfter = await loadManifest(key);
    expect(mAfter.stages.outline.status).toBe("done");
    // research/write/assemble/build 未被触及（仍 pending）。
    expect(mAfter.stages.research.status).toBe("pending");
    expect(mAfter.stages.write.status).toBe("pending");
    expect(mAfter.stages.assemble.status).toBe("pending");
    expect(mAfter.stages.build.status).toBe("pending");

    // 只调了 Architect + Critic（1 轮 approve）。
    expect(calls.some((c) => c.args[1]?.includes("你是 Architect"))).toBe(true);
    expect(calls.some((c) => c.args[1]?.includes("你是 Critic"))).toBe(true);
    expect(calls.some((c) => c.args[1]?.includes("你是 Reader"))).toBe(false);
    expect(calls.some((c) => c.args[1]?.includes("技术文档撰写员"))).toBe(false);
    expect(calls.some((c) => c.args[1]?.includes("你是 Assembler"))).toBe(false);

    // complete 串（即使只跑一个 stage 也算完成）。
    expect(logs.some((l) => l === `[atlas] run ${key} complete.`)).toBe(true);
  });

  test("--only research：只跑 research（一次处理所有章），不进 write", async () => {
    const key = "only-research";
    const localSrc = join(tmpRoot, "src-repo");
    await mkdir(localSrc, { recursive: true });
    const source: SourceInfo = { kind: "local", ref: localSrc, localPath: localSrc };
    const chapters = sampleChapters();
    const topo = topoSort(chapters.map((c) => ({ slug: c.slug, dependsOn: c.dependsOn })));
    const outlineObj: Outline = {
      repo: key, generatedAt: "2026-01-01T00:00:00.000Z",
      chapters, topoOrder: topo.order,
    };
    await presetThroughOutline(key, source, chapters, outlineObj);

    const calls: SpawnCall[] = [];
    const { logs, onLog } = logCollector();
    const spawn = makeMockSpawn({ key, chapters, calls });

    const r = await runPipeline({
      key, source, spawn, onLog,
      flags: { only: "research" },
    });
    expect(r.ok).toBe(true);

    const mAfter = await loadManifest(key);
    expect(mAfter.stages.research.status).toBe("done");
    // 每章 research done（research stage 一次跑完所有章）。
    for (const c of chapters) {
      expect(mAfter.chapters[c.slug].research.status).toBe("done");
    }
    // write 未被触及。
    expect(mAfter.stages.write.status).toBe("pending");
    for (const c of chapters) {
      expect(mAfter.chapters[c.slug].write.status).toBe("pending");
    }

    // Reader 被调 3 次（每章一次），无 Writer/Assembler。
    const readerCalls = calls.filter((c) => c.args[1]?.includes("你是 Reader"));
    expect(readerCalls.length).toBe(3);
    expect(calls.some((c) => c.args[1]?.includes("技术文档撰写员"))).toBe(false);
    expect(calls.some((c) => c.args[1]?.includes("你是 Assembler"))).toBe(false);

    // complete 串。
    expect(logs.some((l) => l === `[atlas] run ${key} complete.`)).toBe(true);
  });
});

// ===========================================================================
// --force：把 done stage reset 后重跑
// ===========================================================================

describe("--force", () => {
  test("--force 配合 --only survey：reset survey 后重跑（cmd 变化证明重跑）", async () => {
    const key = "force-survey";
    const localSrc = join(tmpRoot, "src-repo");
    await mkdir(localSrc, { recursive: true });
    const source: SourceInfo = { kind: "local", ref: localSrc, localPath: localSrc };
    const chapters = sampleChapters();
    const topo = topoSort(chapters.map((c) => ({ slug: c.slug, dependsOn: c.dependsOn })));
    const outlineObj: Outline = {
      repo: key, generatedAt: "2026-01-01T00:00:00.000Z",
      chapters, topoOrder: topo.order,
    };
    let m = await presetThroughOutline(key, source, chapters, outlineObj);
    // 预置 research/write done（让 manifest 更完整）。
    m = setStageStatus(m, "research", "done");
    m = setStageStatus(m, "write", "done");
    for (const c of chapters) {
      m = setChapterStatus(m, c.slug, "research", "done", { cmd: "old-research" });
      m = setChapterStatus(m, c.slug, "write", "done", { cmd: "old-write" });
    }
    await writeJson(manifestPath(key), m);

    // baseline survey cmd。
    const surveyCmdBefore = m.stages.survey.cmd;
    expect(surveyCmdBefore).toBeDefined();

    const calls: SpawnCall[] = [];
    const { logs, onLog } = logCollector();
    const spawn = makeMockSpawn({ key, chapters, calls });

    const r = await runPipeline({
      key, source, spawn, onLog,
      flags: { only: "survey", force: true },
    });
    expect(r.ok).toBe(true);

    const mAfter = await loadManifest(key);
    expect(mAfter.stages.survey.status).toBe("done");
    // cmd 变化（重跑后是新的 claude 命令，含 readonly 锚点）。
    expect(mAfter.stages.survey.cmd).not.toBe(surveyCmdBefore);
    expect(mAfter.stages.survey.cmd).toContain("--allowedTools Read,Glob,Grep");
    // 其它 stage 状态保持（--only 不推进下游，--force 只重置目标）。
    expect(mAfter.stages.outline.status).toBe("done");
    expect(mAfter.stages.research.status).toBe("done");
  });

  test("--force 配合 --only research：reset research stage + 所有章节 research 子步骤后重跑", async () => {
    const key = "force-research";
    const localSrc = join(tmpRoot, "src-repo");
    await mkdir(localSrc, { recursive: true });
    const source: SourceInfo = { kind: "local", ref: localSrc, localPath: localSrc };
    const chapters = sampleChapters();
    const topo = topoSort(chapters.map((c) => ({ slug: c.slug, dependsOn: c.dependsOn })));
    const outlineObj: Outline = {
      repo: key, generatedAt: "2026-01-01T00:00:00.000Z",
      chapters, topoOrder: topo.order,
    };
    let m = await presetThroughOutline(key, source, chapters, outlineObj);
    // 预置 research 全部 done（带旧 cmd 便于断言重跑）。
    m = setStageStatus(m, "research", "done");
    for (const c of chapters) {
      m = setChapterStatus(m, c.slug, "research", "done", { cmd: "old-research-cmd" });
    }
    await writeJson(manifestPath(key), m);

    const calls: SpawnCall[] = [];
    const { logs, onLog } = logCollector();
    const spawn = makeMockSpawn({ key, chapters, calls });

    const r = await runPipeline({
      key, source, spawn, onLog,
      flags: { only: "research", force: true },
    });
    expect(r.ok).toBe(true);

    const mAfter = await loadManifest(key);
    expect(mAfter.stages.research.status).toBe("done");
    // 每章 research 被重跑（cmd 不再是 old-research-cmd）。
    for (const c of chapters) {
      expect(mAfter.chapters[c.slug].research.cmd).not.toBe("old-research-cmd");
      expect(mAfter.chapters[c.slug].research.cmd).toContain("--allowedTools Read,Glob,Grep");
    }
    // Reader 被调 3 次（所有章都重跑了，证明 applyForceReset 把章节子步骤也 reset 了）。
    const readerCalls = calls.filter((c) => c.args[1]?.includes("你是 Reader"));
    expect(readerCalls.length).toBe(3);
  });

  test("--force 未配合 from/only → 抛带提示的明确错误", async () => {
    const key = "force-bare";
    const localSrc = join(tmpRoot, "src-repo");
    await mkdir(localSrc, { recursive: true });
    const source: SourceInfo = { kind: "local", ref: localSrc, localPath: localSrc };
    // 先建 manifest（让 runPipeline 不走 init 路径）。
    const { initManifest } = await import("../src/lib/manifest.ts");
    await writeJson(manifestPath(key), initManifest(key, source));

    const calls: SpawnCall[] = [];
    const spawn = makeMockSpawn({ key, chapters: sampleChapters(), calls });

    await expect(
      runPipeline({
        key, source, spawn,
        flags: { force: true }, // 无 from/only。
      }),
    ).rejects.toThrow(/--force/);
  });
});

// ===========================================================================
// 失败终止（design §15）
// ===========================================================================

describe("失败终止（design §15）", () => {
  test("outline 失败（architect 非零退出）→ 循环停止、ok:false、下游未执行", async () => {
    const key = "fail-outline";
    const localSrc = join(tmpRoot, "src-repo");
    await mkdir(localSrc, { recursive: true });
    const source: SourceInfo = { kind: "local", ref: localSrc, localPath: localSrc };
    const chapters = sampleChapters();
    const calls: SpawnCall[] = [];
    const { logs, onLog } = logCollector();
    const spawn = makeMockSpawn({
      key, chapters, calls,
      architectExit: 1, // architect 失败 → outline stage failed。
    });

    const r = await runPipeline({
      key, source, spawn, onLog,
      flags: { skipBuild: true },
    });
    expect(r.ok).toBe(false);

    const m = await loadManifest(key);
    expect(m.stages.acquire.status).toBe("done");
    expect(m.stages.survey.status).toBe("done");
    expect(m.stages.outline.status).toBe("failed");
    // 下游 stage 未被执行（仍 pending）。
    expect(m.stages.research.status).toBe("pending");
    expect(m.stages.write.status).toBe("pending");
    expect(m.stages.assemble.status).toBe("pending");
    expect(m.stages.build.status).toBe("pending");

    // 下游 spawn 调用未发生（无 Reader/Writer/Assembler）。
    expect(calls.some((c) => c.args[1]?.includes("你是 Reader"))).toBe(false);
    expect(calls.some((c) => c.args[1]?.includes("技术文档撰写员"))).toBe(false);
    expect(calls.some((c) => c.args[1]?.includes("你是 Assembler"))).toBe(false);

    // 含 halted 摘要日志。
    expect(logs.some((l) => l.includes(`[atlas] ${key} halted: outline failed`))).toBe(true);
    // 不含 complete 串（失败终止）。
    expect(logs.some((l) => l === `[atlas] run ${key} complete.`)).toBe(false);
  });

  test("acquire 失败（本地源路径不存在）→ 循环停止、ok:false、survey 未执行", async () => {
    const key = "fail-acquire";
    const missing = join(tmpRoot, "nope-not-exist");
    const source: SourceInfo = { kind: "local", ref: missing, localPath: missing };
    const chapters = sampleChapters();
    const calls: SpawnCall[] = [];
    const { logs, onLog } = logCollector();
    const spawn = makeMockSpawn({ key, chapters, calls });

    const r = await runPipeline({
      key, source, spawn, onLog,
      flags: { skipBuild: true },
    });
    expect(r.ok).toBe(false);

    const m = await loadManifest(key);
    expect(m.stages.acquire.status).toBe("failed");
    expect(m.stages.survey.status).toBe("pending"); // 未执行。

    // survey 及之后 spawn 调用未发生。
    expect(calls.length).toBe(0);

    expect(logs.some((l) => l.includes(`[atlas] ${key} halted: acquire failed`))).toBe(true);
    expect(logs.some((l) => l === `[atlas] run ${key} complete.`)).toBe(false);
  });

  test("单点隔离：research 某 chapter 失败 → stage 仍 done，流水线推进，complete", async () => {
    const key = "iso-chapter";
    const localSrc = join(tmpRoot, "src-repo");
    await mkdir(localSrc, { recursive: true });
    const source: SourceInfo = { kind: "local", ref: localSrc, localPath: localSrc };
    const chapters = sampleChapters();
    const calls: SpawnCall[] = [];
    const { logs, onLog } = logCollector();
    // 构造一个「beta 章 reader 返回非 markdown」的 mock spawn。
    const isoSpawn: SpawnFn = async (args, opts) => {
      const call: SpawnCall = { args: [...args], cwd: opts.cwd };
      calls.push(call);
      const prompt = args[1] ?? "";
      if (prompt.includes("你是 Surveyor")) {
        const repoMap: RepoMap = {
          root: "work/source", sourceKind: "git-clone", languages: ["ts"],
          frameworks: [], entrypoints: ["src/index.ts"], manifests: ["package.json"],
          packages: [], tree: [{ path: "src/index.ts", type: "file", role: "entry" }],
          docs: ["README.md"],
        };
        return { exitCode: 0, stdout: jsonFence(repoMap), stderr: "" };
      }
      if (prompt.includes("你是 Architect")) {
        return { exitCode: 0, stdout: jsonFence({ chapters }), stderr: "" };
      }
      if (prompt.includes("你是 Critic")) {
        return { exitCode: 0, stdout: jsonFence({ verdict: "approve", fixes: [] }), stderr: "" };
      }
      if (prompt.includes("你是 Reader")) {
        const slugMatch = prompt.match(/本章 slug: ([a-z0-9-]+)/);
        const slug = slugMatch ? slugMatch[1] : "x";
        if (slug === "beta") {
          // 返回非 markdown → reader 解析失败 → 该章 research failed。
          return { exitCode: 0, stdout: "not markdown", stderr: "" };
        }
        return { exitCode: 0, stdout: mdFence(`# ${slug} 研究`), stderr: "" };
      }
      if (prompt.includes("技术文档撰写员")) {
        const slugMatch = opts.cwd.match(/chapters\/([a-z0-9-]+)\/?$/);
        const slug = slugMatch ? slugMatch[1] : "x";
        // beta 章 research.md 缺失 → write 子流程会标 write=failed（缺料）。
        // 其它章正常返回 draft 内容（stage 落盘）。
        return { exitCode: 0, stdout: mdFence(`# ${slug} 草稿\n`), stderr: "" };
      }
      if (prompt.includes("你是 Assembler")) {
        const topoMatch = prompt.match(/"topoOrder":\s*\[([^\]]*)\]/);
        const topoRaw = topoMatch ? topoMatch[1] : "";
        const topoOrder = topoRaw.split(",").map((s) => s.replace(/"/g, "").trim()).filter(Boolean);
        const site = siteDir(key);
        await ensureDir(joinPath(site, "guide/"));
        for (let i = 0; i < topoOrder.length; i++) {
          const slug = topoOrder[i];
          const nn = (i + 1).toString().padStart(2, "0");
          await writeText(joinPath(site, `guide/${nn}-${slug}.md`), `# ${slug}`);
        }
        await ensureDir(joinPath(site, ".vitepress/"));
        await writeText(joinPath(site, ".vitepress/config.ts"), "export default {}");
        await writeText(joinPath(site, "index.md"), "# Home");
        await writeText(joinPath(site, "package.json"), JSON.stringify({ name: "site" }));
        return { exitCode: 0, stdout: "assembled", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const r = await runPipeline({
      key, source, spawn: isoSpawn, onLog,
      flags: { skipBuild: true },
    });
    expect(r.ok).toBe(true); // 单点隔离：流水线仍推进到 complete。

    const m = await loadManifest(key);
    // research stage 整体 done（单点隔离），beta 章 research failed。
    expect(m.stages.research.status).toBe("done");
    expect(m.chapters.beta.research.status).toBe("failed");
    expect(m.chapters.alpha.research.status).toBe("done");
    expect(m.chapters.gamma.research.status).toBe("done");
    // write stage 整体 done；beta 章 write=failed（缺料），其它章 done。
    expect(m.stages.write.status).toBe("done");
    expect(m.chapters.beta.write.status).toBe("failed");
    expect(m.chapters.alpha.write.status).toBe("done");
    expect(m.chapters.gamma.write.status).toBe("done");
    // assemble/build 推进到 done。
    expect(m.stages.assemble.status).toBe("done");
    expect(m.stages.build.status).toBe("done");

    // complete 串（单点隔离下流水线照常完成）。
    expect(logs.some((l) => l === `[atlas] run ${key} complete.`)).toBe(true);
    // 无 halted 日志（research/write stage 级不 failed）。
    expect(logs.some((l) => l.includes("halted"))).toBe(false);
  });
});

// ===========================================================================
// 探针：mini run 端到端打印关键日志
// ===========================================================================

describe("探针 · mini run 关键日志", () => {
  test("跑一次完整 mini run，捕获所有 stage 的开始/done 与 complete 串顺序", async () => {
    const key = "probe-mini";
    const localSrc = join(tmpRoot, "src-repo");
    await mkdir(localSrc, { recursive: true });
    // 造一个真实存在的源文件（让 acquire local 校验通过）。
    await writeFile(join(localSrc, "package.json"), '{"name":"mini"}');
    const source: SourceInfo = { kind: "local", ref: localSrc, localPath: localSrc };
    const chapters: Chapter[] = [
      {
        slug: "hello", title: "你好", layer: "primitive",
        dependsOn: [], sourceFiles: ["index.ts"], summary: "hello 总结",
      },
    ];
    const calls: SpawnCall[] = [];
    const { logs, onLog } = logCollector();
    const spawn = makeMockSpawn({ key, chapters, calls });

    const r = await runPipeline({
      key, source, spawn, onLog,
      flags: { skipBuild: true },
    });
    expect(r.ok).toBe(true);

    // 顺序断言：每个 stage 的「开始」先于其「done」；complete 在最后。
    const expectOrder = ["acquire", "survey", "outline", "research", "write", "assemble", "build"];
    let lastIdx = -1;
    for (const s of expectOrder) {
      const startLine = logs.find((l) => l === `[atlas] ${key} ${s} 开始`);
      const doneLine = logs.find((l) => l === `[atlas] ${key} ${s} done`);
      expect(startLine).toBeDefined();
      expect(doneLine).toBeDefined();
      expect(logs.indexOf(startLine!)).toBeLessThan(logs.indexOf(doneLine!));
      // 下一个 stage 的开始要在上一个 stage 的 done 之后。
      const startIdx = logs.indexOf(startLine!);
      expect(startIdx).toBeGreaterThan(lastIdx);
      lastIdx = logs.indexOf(doneLine!);
    }
    // complete 在最后一个 done 之后。
    const completeIdx = logs.indexOf(`[atlas] run ${key} complete.`);
    expect(completeIdx).toBeGreaterThan(lastIdx);
    expect(completeIdx).toBe(logs.length - 1); // complete 是最后一行。
  });
});

// ===========================================================================
// 预置 helper（共享夹具构造）
// ===========================================================================

/**
 * 预置 manifest 到「acquire+survey done」状态，方便测下游 stage。
 * 不调真实 stage，直接手动 setStageStatus + writeJson。
 */
async function presetThroughSurvey(
  key: string,
  source: SourceInfo,
): Promise<import("../src/lib/manifest.ts").Manifest> {
  const { initManifest } = await import("../src/lib/manifest.ts");
  let m = initManifest(key, source);
  m = setStageStatus(m, "acquire", "done", { cmd: "acquire cmd" });
  m = setStageStatus(m, "survey", "done", { cmd: "survey cmd --allowedTools Read,Glob,Grep" });
  await writeJson(manifestPath(key), m);
  return m;
}

/**
 * 预置 manifest 到「acquire+survey+outline done + registerChapters」状态，并写 outline.json。
 */
async function presetThroughOutline(
  key: string,
  source: SourceInfo,
  chapters: Chapter[],
  outlineObj: Outline,
): Promise<import("../src/lib/manifest.ts").Manifest> {
  const { initManifest, registerChapters } = await import("../src/lib/manifest.ts");
  await ensureDir(joinPath(`atlas/${key}`, "work/"));
  await writeJson(outlinePath(key), outlineObj);
  let m = initManifest(key, source);
  m = setStageStatus(m, "acquire", "done", { cmd: "acquire cmd" });
  m = setStageStatus(m, "survey", "done", { cmd: "survey cmd --allowedTools Read,Glob,Grep" });
  m = setStageStatus(m, "outline", "done", { cmd: "outline cmd" });
  m = registerChapters(m, outlineObj.topoOrder);
  await writeJson(manifestPath(key), m);
  return m;
}

/**
 * 预置 manifest 到「全部 stage done」状态（用于 --from build 已 done 等场景）。
 */
async function presetFullDone(
  key: string,
  source: SourceInfo,
  chapters: Chapter[],
): Promise<import("../src/lib/manifest.ts").Manifest> {
  const { initManifest, registerChapters } = await import("../src/lib/manifest.ts");
  const topo = topoSort(chapters.map((c) => ({ slug: c.slug, dependsOn: c.dependsOn })));
  let m = initManifest(key, source);
  m = setStageStatus(m, "acquire", "done", { cmd: "acquire cmd" });
  m = setStageStatus(m, "survey", "done", { cmd: "survey cmd" });
  m = setStageStatus(m, "outline", "done", { cmd: "outline cmd" });
  m = registerChapters(m, topo.order);
  m = setStageStatus(m, "research", "done", { cmd: "research cmd" });
  for (const c of chapters) {
    m = setChapterStatus(m, c.slug, "research", "done", { cmd: "research cmd" });
    m = setChapterStatus(m, c.slug, "write", "done", { cmd: "write cmd" });
  }
  m = setStageStatus(m, "write", "done", { cmd: "write cmd" });
  m = setStageStatus(m, "assemble", "done", { cmd: "assemble cmd" });
  m = setStageStatus(m, "build", "done", { cmd: "build cmd" });
  return m;
}

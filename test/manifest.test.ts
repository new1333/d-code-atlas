// test/manifest.test.ts：lib/manifest.ts 单元测试。
// 用 bun:test。纯内存更新器测试不碰文件系统；load/save round-trip 用系统临时目录。
//
// 核心断言锚点（design §9 + AC-3）：
//   1) 所有更新器 immutable（原对象不变）；
//   2) findNextPending 对"survey done / outline done / research 半 done"正确返回下一待办章节；
//   3) chapterOrder 作为续跑权威章节顺序，不依赖 Record key 顺序。

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  STAGE_ORDER,
  initManifest,
  loadManifest,
  saveManifest,
  setStageStatus,
  setChapterStatus,
  setStageReview,
  setChapterReview,
  registerChapters,
  findNextPending,
  forceReset,
  nowIso,
  setNow,
  resetNow,
  type Manifest,
  type SourceInfo,
  type ReviewSummary,
} from "../src/lib/manifest.ts";

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

const LOCAL_SOURCE: SourceInfo = {
  kind: "local",
  ref: "/path/to/repo",
  localPath: "/abs/path/to/repo",
};

const URL_SOURCE: SourceInfo = {
  kind: "url",
  ref: "https://github.com/o/r",
  localPath: null,
};

const FIXED_TIME = "2026-07-27T00:00:00.000Z";

beforeEach(() => {
  // 注入固定时钟，使时间戳断言确定性化。
  setNow(() => FIXED_TIME);
});

afterEach(() => {
  resetNow();
});

/** sample review 汇总，用于 review 落位测试。 */
function sampleReview(rounds = 1, final: "approved" | "accepted-with-warning" = "approved"): ReviewSummary {
  return {
    rounds,
    final,
    trace: [
      { round: 1, verdict: "approve" },
    ],
  };
}

// ---------------------------------------------------------------------------
// nowIso 注入点
// ---------------------------------------------------------------------------

describe("nowIso 注入点", () => {
  test("默认返回 ISO 字符串", () => {
    resetNow(); // 临时还原默认
    const ts = nowIso();
    expect(typeof ts).toBe("string");
    // ISO 形状校验
    expect(ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    setNow(() => FIXED_TIME); // 还原为本 describe 的注入
  });

  test("setNow 后返回注入值；resetNow 后还原", () => {
    setNow(() => "T1");
    expect(nowIso()).toBe("T1");
    resetNow();
    const ts = nowIso();
    expect(ts).not.toBe("T1");
    expect(ts).toMatch(/^\d{4}-/);
    setNow(() => FIXED_TIME); // 还原为本测试套件的注入
  });
});

// ---------------------------------------------------------------------------
// initManifest
// ---------------------------------------------------------------------------

describe("initManifest", () => {
  test("所有 stage=pending、chapters={}、version=1、key/source 透传、chapterOrder 空数组", () => {
    const m = initManifest("repo", LOCAL_SOURCE);
    expect(m.key).toBe("repo");
    expect(m.source).toEqual(LOCAL_SOURCE);
    expect(m.version).toBe(1);
    expect(m.chapters).toEqual({});
    expect(m.chapterOrder).toEqual([]);
    for (const s of STAGE_ORDER) {
      expect(m.stages[s]).toEqual({ status: "pending" });
    }
  });

  test("url source 透传：localPath 为 null", () => {
    const m = initManifest("r", URL_SOURCE);
    expect(m.source).toEqual(URL_SOURCE);
    expect(m.source.localPath).toBeNull();
  });

  test("STAGE_ORDER 顺序正确", () => {
    expect(STAGE_ORDER).toEqual([
      "acquire",
      "survey",
      "outline",
      "research",
      "write",
      "assemble",
      "build",
    ]);
  });
});

// ---------------------------------------------------------------------------
// immutable 验证（所有更新器）
// ---------------------------------------------------------------------------

describe("immutable 验证", () => {
  test("setStageStatus 返回新对象，原 manifest 不变", () => {
    const m = initManifest("r", LOCAL_SOURCE);
    const snapshot = JSON.parse(JSON.stringify(m));
    const m2 = setStageStatus(m, "survey", "running");
    // 引用不同
    expect(m2).not.toBe(m);
    expect(m2.stages).not.toBe(m.stages);
    expect(m2.stages.survey).not.toBe(m.stages.survey);
    // 未改动的 stage 引用应保持（浅拷贝共享）——这里只断言原对象完全没变
    expect(JSON.parse(JSON.stringify(m))).toEqual(snapshot);
    // 新对象上 survey 已变
    expect(m2.stages.survey.status).toBe("running");
    expect(m.stages.survey.status).toBe("pending"); // 原 manifest 不变
  });

  test("setChapterStatus 返回新对象，原 manifest 不变", () => {
    const m0 = initManifest("r", LOCAL_SOURCE);
    const m = registerChapters(m0, ["a", "b"]);
    const snapshot = JSON.parse(JSON.stringify(m));
    const m2 = setChapterStatus(m, "a", "research", "running");
    expect(m2).not.toBe(m);
    expect(m2.chapters).not.toBe(m.chapters);
    expect(m2.chapters.a).not.toBe(m.chapters.a);
    expect(JSON.parse(JSON.stringify(m))).toEqual(snapshot);
    expect(m2.chapters.a.research.status).toBe("running");
    expect(m.chapters.a.research.status).toBe("pending");
  });

  test("setStageReview 返回新对象，原 manifest 不变", () => {
    const m = initManifest("r", LOCAL_SOURCE);
    const snapshot = JSON.parse(JSON.stringify(m));
    const review = sampleReview();
    const m2 = setStageReview(m, "outline", review);
    expect(m2).not.toBe(m);
    expect(m2.stages.outline).not.toBe(m.stages.outline);
    expect(JSON.parse(JSON.stringify(m))).toEqual(snapshot);
    expect(m2.stages.outline.review).toEqual(review);
    expect(m.stages.outline.review).toBeUndefined();
  });

  test("setChapterReview 返回新对象，原 manifest 不变", () => {
    const m0 = initManifest("r", LOCAL_SOURCE);
    const m = registerChapters(m0, ["a"]);
    const snapshot = JSON.parse(JSON.stringify(m));
    const review = sampleReview();
    const m2 = setChapterReview(m, "a", review);
    expect(m2).not.toBe(m);
    expect(m2.chapters.a).not.toBe(m.chapters.a);
    expect(m2.chapters.a.write).not.toBe(m.chapters.a.write);
    expect(JSON.parse(JSON.stringify(m))).toEqual(snapshot);
    expect(m2.chapters.a.write.review).toEqual(review);
    expect(m.chapters.a.write.review).toBeNull();
  });

  test("registerChapters 返回新对象，原 manifest 不变", () => {
    const m = initManifest("r", LOCAL_SOURCE);
    const snapshot = JSON.parse(JSON.stringify(m));
    const m2 = registerChapters(m, ["a", "b"]);
    expect(m2).not.toBe(m);
    expect(m2.chapters).not.toBe(m.chapters);
    expect(JSON.parse(JSON.stringify(m))).toEqual(snapshot);
    expect(Object.keys(m2.chapters)).toEqual(["a", "b"]);
    expect(Object.keys(m.chapters)).toEqual([]);
  });

  test("forceReset 返回新对象，原 manifest 不变", () => {
    const m0 = initManifest("r", LOCAL_SOURCE);
    const m = setStageStatus(m0, "survey", "done", { cmd: "claude -p ..." });
    const snapshot = JSON.parse(JSON.stringify(m));
    const m2 = forceReset(m, { type: "stage", stage: "survey" });
    expect(m2).not.toBe(m);
    expect(m2.stages.survey).not.toBe(m.stages.survey);
    expect(JSON.parse(JSON.stringify(m))).toEqual(snapshot);
    expect(m2.stages.survey.status).toBe("pending");
    expect(m.stages.survey.status).toBe("done");
  });
});

// ---------------------------------------------------------------------------
// setStageStatus：时间戳语义
// ---------------------------------------------------------------------------

describe("setStageStatus 时间戳语义", () => {
  test("pending → running：记 startedAt，无 finishedAt", () => {
    const m0 = initManifest("r", LOCAL_SOURCE);
    const m = setStageStatus(m0, "survey", "running");
    expect(m.stages.survey.status).toBe("running");
    expect(m.stages.survey.startedAt).toBe(FIXED_TIME);
    expect(m.stages.survey.finishedAt).toBeUndefined();
  });

  test("running → done：记 finishedAt，cmd 落位", () => {
    let m: Manifest = initManifest("r", LOCAL_SOURCE);
    m = setStageStatus(m, "survey", "running");
    m = setStageStatus(m, "survey", "done", { cmd: "claude -p survey" });
    expect(m.stages.survey.status).toBe("done");
    expect(m.stages.survey.finishedAt).toBe(FIXED_TIME);
    expect(m.stages.survey.cmd).toBe("claude -p survey");
    // startedAt 保留（CAS 式：置 done 不改 startedAt）
    expect(m.stages.survey.startedAt).toBe(FIXED_TIME);
  });

  test("进入 failed 也记 finishedAt", () => {
    const m0 = initManifest("r", LOCAL_SOURCE);
    const m = setStageStatus(m0, "survey", "failed");
    expect(m.stages.survey.status).toBe("failed");
    expect(m.stages.survey.finishedAt).toBe(FIXED_TIME);
  });

  test("awaiting_review 不记 finishedAt（非终态）", () => {
    const m0 = initManifest("r", LOCAL_SOURCE);
    const m = setStageStatus(m0, "outline", "awaiting_review");
    expect(m.stages.outline.status).toBe("awaiting_review");
    expect(m.stages.outline.finishedAt).toBeUndefined();
  });

  test("opts.cmd 不提供时保留原 cmd", () => {
    let m: Manifest = initManifest("r", LOCAL_SOURCE);
    m = setStageStatus(m, "survey", "running", { cmd: "claude -p a" });
    m = setStageStatus(m, "survey", "done"); // 不传 cmd
    expect(m.stages.survey.cmd).toBe("claude -p a");
  });

  test("opts.now 注入时间戳（覆盖默认）", () => {
    const m0 = initManifest("r", LOCAL_SOURCE);
    const m = setStageStatus(m0, "survey", "running", { now: () => "CUSTOM-T" });
    expect(m.stages.survey.startedAt).toBe("CUSTOM-T");
  });
});

// ---------------------------------------------------------------------------
// setStageStatus：失败诊断字段（exitCode/stderr/error）
// ---------------------------------------------------------------------------

describe("setStageStatus 失败诊断字段", () => {
  test("failed 时 exitCode/stderr/error 透传并落位", () => {
    const m0 = initManifest("r", LOCAL_SOURCE);
    const m = setStageStatus(m0, "survey", "failed", {
      cmd: "claude -p survey",
      exitCode: 126,
      stderr: "launch fail",
      error: "启动 claude 子进程失败",
    });
    expect(m.stages.survey.status).toBe("failed");
    expect(m.stages.survey.exitCode).toBe(126);
    expect(m.stages.survey.stderr).toBe("launch fail");
    expect(m.stages.survey.error).toBe("启动 claude 子进程失败");
  });

  test("进入 running 时清掉上一次失败的诊断字段（新一轮尝试不带旧诊断）", () => {
    const m0 = initManifest("r", LOCAL_SOURCE);
    // 先 failed 带诊断。
    let m = setStageStatus(m0, "survey", "failed", {
      exitCode: 126,
      stderr: "boom",
      error: "launch fail",
    });
    expect(m.stages.survey.exitCode).toBe(126);
    // 再 running（重跑）：诊断字段应被清。
    m = setStageStatus(m, "survey", "running");
    expect(m.stages.survey.exitCode).toBeUndefined();
    expect(m.stages.survey.stderr).toBeUndefined();
    expect(m.stages.survey.error).toBeUndefined();
  });

  test("不传诊断字段时，原 manifest 无这些字段（成功路径不污染）", () => {
    const m0 = initManifest("r", LOCAL_SOURCE);
    const m = setStageStatus(m0, "survey", "done", { cmd: "claude -p x" });
    expect(m.stages.survey.exitCode).toBeUndefined();
    expect(m.stages.survey.stderr).toBeUndefined();
    expect(m.stages.survey.error).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// setChapterStatus
// ---------------------------------------------------------------------------

describe("setChapterStatus", () => {
  test("research 与 write 子步骤独立设置", () => {
    const m0 = initManifest("r", LOCAL_SOURCE);
    const m1 = registerChapters(m0, ["a"]);
    const m2 = setChapterStatus(m1, "a", "research", "done", { cmd: "reader a" });
    const m3 = setChapterStatus(m2, "a", "write", "running", { cmd: "writer a" });
    expect(m3.chapters.a.research.status).toBe("done");
    expect(m3.chapters.a.research.cmd).toBe("reader a");
    expect(m3.chapters.a.write.status).toBe("running");
    expect(m3.chapters.a.write.cmd).toBe("writer a");
  });
});

// ---------------------------------------------------------------------------
// registerChapters
// ---------------------------------------------------------------------------

describe("registerChapters", () => {
  test("批量建 ChapterState（research pending、write pending 且 review:null 对齐 design §8.3）", () => {
    const m0 = initManifest("r", LOCAL_SOURCE);
    const m = registerChapters(m0, ["a", "b", "c"]);
    expect(Object.keys(m.chapters).sort()).toEqual(["a", "b", "c"]);
    for (const slug of ["a", "b", "c"]) {
      expect(m.chapters[slug]).toEqual({
        research: { status: "pending" },
        write: { status: "pending", review: null },
      });
    }
  });

  test("幂等：重复调用不重置已存在章节状态", () => {
    const m0 = initManifest("r", LOCAL_SOURCE);
    const m1 = registerChapters(m0, ["a", "b"]);
    // 把 a 的 research 跑完
    const m2 = setChapterStatus(m1, "a", "research", "done");
    // 再次 register（模拟 resume）
    const m3 = registerChapters(m2, ["a", "b"]);
    expect(m3.chapters.a.research.status).toBe("done"); // 未被重置
    expect(m3.chapters.b.research.status).toBe("pending");
  });

  test("幂等：追加新 slug，已有顺序不变", () => {
    const m0 = initManifest("r", LOCAL_SOURCE);
    const m1 = registerChapters(m0, ["a", "b"]);
    expect(m1.chapterOrder).toEqual(["a", "b"]);
    const m2 = registerChapters(m1, ["b", "c", "a"]); // 含重复
    expect(m2.chapterOrder).toEqual(["a", "b", "c"]); // 追加 c，a/b 不重复
  });

  test("chapterOrder 严格按传入 slug 顺序填充", () => {
    const m0 = initManifest("r", LOCAL_SOURCE);
    const m = registerChapters(m0, ["zeta", "alpha", "mid"]);
    expect(m.chapterOrder).toEqual(["zeta", "alpha", "mid"]);
  });
});

// ---------------------------------------------------------------------------
// findNextPending（AC-3 核心）
// ---------------------------------------------------------------------------

describe("findNextPending 核心场景", () => {
  test("空 manifest（全 pending）→ acquire", () => {
    const m = initManifest("r", LOCAL_SOURCE);
    expect(findNextPending(m)).toEqual({ type: "stage", stage: "acquire" });
  });

  test("acquire/survey/outline done、chapters 已注册、research 全 pending → 第一个 research 章节", () => {
    let m = initManifest("r", LOCAL_SOURCE);
    m = setStageStatus(m, "acquire", "done");
    m = setStageStatus(m, "survey", "done");
    m = setStageStatus(m, "outline", "done");
    m = registerChapters(m, ["a", "b", "c"]);
    const next = findNextPending(m);
    expect(next).toEqual({ type: "chapter", stage: "research", slug: "a" });
  });

  test("AC-3 关键：survey/outline done，research 跑了一半，resume → 返回第一个未 done 的 research 章节（survey/outline 不重跑）", () => {
    let m = initManifest("r", LOCAL_SOURCE);
    m = setStageStatus(m, "acquire", "done");
    m = setStageStatus(m, "survey", "done");
    m = setStageStatus(m, "outline", "done");
    m = registerChapters(m, ["a", "b", "c", "d"]);
    // a、b 已 done，c、d pending
    m = setChapterStatus(m, "a", "research", "done");
    m = setChapterStatus(m, "b", "research", "done");
    const next = findNextPending(m);
    // 关键：不重跑 survey/outline；research 从 c 继续
    expect(next).toEqual({ type: "chapter", stage: "research", slug: "c" });
  });

  test("research 全 done、write 部分进行中 → 第一个未 done 的 write 章节", () => {
    let m = initManifest("r", LOCAL_SOURCE);
    m = setStageStatus(m, "acquire", "done");
    m = setStageStatus(m, "survey", "done");
    m = setStageStatus(m, "outline", "done");
    m = registerChapters(m, ["a", "b", "c"]);
    for (const s of ["a", "b", "c"]) {
      m = setChapterStatus(m, s, "research", "done");
    }
    // write: a done, b running, c pending
    m = setChapterStatus(m, "a", "write", "done");
    m = setChapterStatus(m, "b", "write", "running");
    const next = findNextPending(m);
    expect(next).toEqual({ type: "chapter", stage: "write", slug: "b" });
  });

  test("全部 done → null", () => {
    let m = initManifest("r", LOCAL_SOURCE);
    for (const s of STAGE_ORDER) {
      if (s === "research" || s === "write") continue;
      m = setStageStatus(m, s, "done");
    }
    m = registerChapters(m, ["a", "b"]);
    for (const slug of ["a", "b"]) {
      m = setChapterStatus(m, slug, "research", "done");
      m = setChapterStatus(m, slug, "write", "done");
    }
    expect(findNextPending(m)).toBeNull();
  });

  test("无 chapters 的 research/write stage（chapters 空）→ 跳过到下一 stage", () => {
    // 异常态：research/write 顶层标记 done 但 chapters 空。
    let m = initManifest("r", LOCAL_SOURCE);
    m = setStageStatus(m, "acquire", "done");
    m = setStageStatus(m, "survey", "done");
    m = setStageStatus(m, "outline", "done");
    m = setStageStatus(m, "research", "done"); // 顶层标记 done
    m = setStageStatus(m, "write", "done"); // 顶层标记 done
    // 没注册章节 → research/write 下钻无结果 → 跳到 assemble
    const next = findNextPending(m);
    expect(next).toEqual({ type: "stage", stage: "assemble" });
  });
});

describe("findNextPending · opts.from / opts.only", () => {
  test("from:'research' → 只从 research 起扫描", () => {
    let m = initManifest("r", LOCAL_SOURCE);
    // acquire 还 pending，但 from:research 时应跳过它
    m = registerChapters(m, ["a", "b"]);
    const next = findNextPending(m, { from: "research" });
    expect(next).toEqual({ type: "chapter", stage: "research", slug: "a" });
  });

  test("from:'assemble' → 直接命中 assemble（即便前面 pending）", () => {
    const m = initManifest("r", LOCAL_SOURCE);
    const next = findNextPending(m, { from: "assemble" });
    expect(next).toEqual({ type: "stage", stage: "assemble" });
  });

  test("only:'outline' → 只看 outline", () => {
    const m = initManifest("r", LOCAL_SOURCE);
    // outline 还 pending
    expect(findNextPending(m, { only: "outline" })).toEqual({
      type: "stage",
      stage: "outline",
    });
    // outline done 后 only:outline 应返回 null
    const m2 = setStageStatus(m, "outline", "done");
    expect(findNextPending(m2, { only: "outline" })).toBeNull();
  });

  test("only:'research' 下钻章节", () => {
    let m = initManifest("r", LOCAL_SOURCE);
    m = registerChapters(m, ["a", "b"]);
    m = setChapterStatus(m, "a", "research", "done");
    const next = findNextPending(m, { only: "research" });
    expect(next).toEqual({ type: "chapter", stage: "research", slug: "b" });
  });
});

describe("findNextPending · 章节顺序严格按 chapterOrder", () => {
  test("即使 chapters 的 key 插入顺序被打乱，也按 chapterOrder 返回", () => {
    // 构造一个 chapterOrder = [z, a, m]，但 chapters 故意按 [a, m, z] 顺序塞。
    // 先正常 register 出 [z, a, m]，然后手动构造一个 key 顺序不同的等价 manifest。
    let m = initManifest("r", LOCAL_SOURCE);
    m = setStageStatus(m, "acquire", "done");
    m = setStageStatus(m, "survey", "done");
    m = setStageStatus(m, "outline", "done");
    m = registerChapters(m, ["z", "a", "m"]);
    expect(m.chapterOrder).toEqual(["z", "a", "m"]);

    // 手动重排 chapters 的 key 顺序（模拟 JSON 反序列化后 key 顺序与 chapterOrder 不一致）。
    const reordered: Record<string, typeof m.chapters[string]> = {
      a: m.chapters.a,
      m: m.chapters.m,
      z: m.chapters.z,
    };
    const mShuffled: Manifest = { ...m, chapters: reordered };

    // findNextPending 必须按 chapterOrder 返回 z（而非 a）
    const next = findNextPending(mShuffled);
    expect(next).toEqual({ type: "chapter", stage: "research", slug: "z" });
  });

  test("chapterOrder 中部分 done，按顺序返回第一个未 done", () => {
    let m = initManifest("r", LOCAL_SOURCE);
    m = setStageStatus(m, "acquire", "done");
    m = setStageStatus(m, "survey", "done");
    m = setStageStatus(m, "outline", "done");
    m = registerChapters(m, ["first", "second", "third"]);
    // first/third done，second pending → 应返回 second（按 chapterOrder 顺序）
    m = setChapterStatus(m, "first", "research", "done");
    m = setChapterStatus(m, "third", "research", "done");
    const next = findNextPending(m);
    expect(next).toEqual({ type: "chapter", stage: "research", slug: "second" });
  });
});

// ---------------------------------------------------------------------------
// setStageReview / setChapterReview
// ---------------------------------------------------------------------------

describe("setStageReview / setChapterReview", () => {
  test("setStageReview：review 落位到 outline", () => {
    const m0 = initManifest("r", LOCAL_SOURCE);
    const review = sampleReview(2, "accepted-with-warning");
    const m = setStageReview(m0, "outline", review);
    expect(m.stages.outline.review).toEqual(review);
  });

  test("setStageReview：传 null 清空", () => {
    const m0 = initManifest("r", LOCAL_SOURCE);
    const m1 = setStageReview(m0, "outline", sampleReview());
    const m2 = setStageReview(m1, "outline", null);
    expect(m2.stages.outline.review).toBeNull();
  });

  test("setChapterReview：review 落位到 chapters[slug].write.review", () => {
    const m0 = initManifest("r", LOCAL_SOURCE);
    const m1 = registerChapters(m0, ["a"]);
    const review = sampleReview();
    const m = setChapterReview(m1, "a", review);
    expect(m.chapters.a.write.review).toEqual(review);
  });

  test("setChapterReview：传 null 清空", () => {
    const m0 = initManifest("r", LOCAL_SOURCE);
    const m1 = registerChapters(m0, ["a"]);
    const m2 = setChapterReview(m1, "a", sampleReview());
    const m3 = setChapterReview(m2, "a", null);
    expect(m3.chapters.a.write.review).toBeNull();
  });

  test("review 字段形状符合 AC-6 可查（rounds/final/trace 含 verdict）", () => {
    const m0 = initManifest("r", LOCAL_SOURCE);
    const m = setStageReview(m0, "outline", {
      rounds: 2,
      final: "accepted-with-warning",
      trace: [
        { round: 1, verdict: "reject", fixes: ["fix A", "fix B"], cmd: "critic-1" },
        { round: 2, verdict: "approve", cmd: "critic-2" },
      ],
    });
    expect(m.stages.outline.review?.rounds).toBe(2);
    expect(m.stages.outline.review?.final).toBe("accepted-with-warning");
    expect(m.stages.outline.review?.trace[0].fixes).toEqual(["fix A", "fix B"]);
    expect(m.stages.outline.review?.trace[1].verdict).toBe("approve");
  });
});

// ---------------------------------------------------------------------------
// forceReset
// ---------------------------------------------------------------------------

describe("forceReset", () => {
  test("stage 重置：status→pending、清 startedAt/finishedAt、保留 cmd、清 review", () => {
    let m = initManifest("r", LOCAL_SOURCE);
    m = setStageStatus(m, "outline", "running", { cmd: "claude -p outline" });
    m = setStageStatus(m, "outline", "done");
    m = setStageReview(m, "outline", sampleReview());
    expect(m.stages.outline.status).toBe("done");
    expect(m.stages.outline.startedAt).toBe(FIXED_TIME);
    expect(m.stages.outline.review).not.toBeNull();

    const m2 = forceReset(m, { type: "stage", stage: "outline" });
    expect(m2.stages.outline.status).toBe("pending");
    expect(m2.stages.outline.startedAt).toBeUndefined();
    expect(m2.stages.outline.finishedAt).toBeUndefined();
    expect(m2.stages.outline.cmd).toBe("claude -p outline"); // 保留 cmd
    expect(m2.stages.outline.review).toBeUndefined(); // 清掉 review
  });

  test("chapter 子步骤重置：保留 cmd、清时间戳", () => {
    let m = initManifest("r", LOCAL_SOURCE);
    m = registerChapters(m, ["a"]);
    m = setChapterStatus(m, "a", "research", "done", { cmd: "reader a" });
    const m2 = forceReset(m, { type: "chapter", stage: "research", slug: "a" });
    expect(m2.chapters.a.research.status).toBe("pending");
    expect(m2.chapters.a.research.startedAt).toBeUndefined();
    expect(m2.chapters.a.research.finishedAt).toBeUndefined();
    expect(m2.chapters.a.research.cmd).toBe("reader a"); // 保留 cmd
    // research 本无 review 字段
    expect(m2.chapters.a.research.review).toBeUndefined();
    // write 不受影响
    expect(m2.chapters.a.write.status).toBe("pending");
  });

  test("chapter write 重置：review 回到 null（与初始 pendingWriteStage 形态一致）", () => {
    let m = initManifest("r", LOCAL_SOURCE);
    m = registerChapters(m, ["a"]);
    m = setChapterStatus(m, "a", "write", "done", { cmd: "writer a" });
    m = setChapterReview(m, "a", sampleReview());
    expect(m.chapters.a.write.review).not.toBeNull();
    const m2 = forceReset(m, { type: "chapter", stage: "write", slug: "a" });
    expect(m2.chapters.a.write.status).toBe("pending");
    expect(m2.chapters.a.write.cmd).toBe("writer a");
    expect(m2.chapters.a.write.review).toBeNull(); // 重置回 null
  });

  test("reset 后 findNextPending 能再次命中它（AC-3 --force 场景）", () => {
    let m = initManifest("r", LOCAL_SOURCE);
    m = setStageStatus(m, "acquire", "done");
    m = setStageStatus(m, "survey", "done");
    m = setStageStatus(m, "outline", "done");
    m = registerChapters(m, ["a", "b"]);
    m = setChapterStatus(m, "a", "research", "done");
    m = setChapterStatus(m, "b", "research", "done");
    // 此时 research 全 done → findNextPending 应进到 write
    expect(findNextPending(m)).toEqual({ type: "chapter", stage: "write", slug: "a" });

    // --force 重置 a 的 research
    const m2 = forceReset(m, { type: "chapter", stage: "research", slug: "a" });
    // 现在应再次命中 a 的 research
    expect(findNextPending(m2)).toEqual({
      type: "chapter",
      stage: "research",
      slug: "a",
    });
  });

  test("forceReset 一个 stage 后，findNextPending 重新指向它", () => {
    let m = initManifest("r", LOCAL_SOURCE);
    m = setStageStatus(m, "acquire", "done");
    m = setStageStatus(m, "survey", "done");
    // 此时 findNextPending 应是 outline
    expect(findNextPending(m)).toEqual({ type: "stage", stage: "outline" });

    // 把 survey 强制重置
    const m2 = forceReset(m, { type: "stage", stage: "survey" });
    // 现在 findNextPending 应回到 survey
    expect(findNextPending(m2)).toEqual({ type: "stage", stage: "survey" });
  });
});

// ---------------------------------------------------------------------------
// loadManifest / saveManifest round-trip（用 tmp 目录）
// ---------------------------------------------------------------------------

describe("loadManifest / saveManifest round-trip", () => {
  let tmpRoot = "";

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), "atlas-manifest-"));
  });

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  test("round-trip：saveManifest → loadManifest 深相等", async () => {
    // 用 io 层的 manifestPath 不便（它写死 atlas/ 相对路径），这里直接构造路径
    // 测 save/load 的"内容 fidelity"——通过临时绕过 manifestPath 的方式：
    // 我们直接用 writeJson/readJson 等价路径，验证 Manifest 形状 round-trip OK。
    // 注：loadManifest/saveManifest 内部走 manifestPath(key) → "atlas/{key}/manifest.json"，
    // 是相对路径，在真实工程里由 cwd（仓库根）承载。这里切到临时目录跑。
    const cwdSpy = process.cwd();
    process.chdir(tmpRoot);
    try {
      let m = initManifest("repo", URL_SOURCE);
      m = setStageStatus(m, "acquire", "done", { cmd: "git clone --depth 1 ..." });
      m = setStageStatus(m, "survey", "done", { cmd: "claude -p ..." });
      m = setStageStatus(m, "outline", "done");
      m = setStageReview(m, "outline", {
        rounds: 2,
        final: "accepted-with-warning",
        trace: [{ round: 1, verdict: "reject", fixes: ["x"] }],
      });
      m = registerChapters(m, ["reactive-primitive", "computed"]);
      m = setChapterStatus(m, "reactive-primitive", "research", "done");

      await saveManifest("repo", m);
      const back = await loadManifest("repo");
      expect(back).toEqual(m);
      // 关键字段逐条校验
      expect(back.source).toEqual(URL_SOURCE);
      expect(back.stages.acquire.cmd).toBe("git clone --depth 1 ...");
      expect(back.stages.outline.review?.final).toBe("accepted-with-warning");
      expect(back.chapters["reactive-primitive"].research.status).toBe("done");
      expect(back.chapterOrder).toEqual(["reactive-primitive", "computed"]);
    } finally {
      process.chdir(cwdSpy);
    }
  });

  test("loadManifest 文件不存在 → 抛明确错误（io 层带路径信息）", async () => {
    const cwdSpy = process.cwd();
    process.chdir(tmpRoot);
    try {
      expect(loadManifest("nope-missing")).rejects.toThrow(/io\.readJson: 文件不存在/);
    } finally {
      process.chdir(cwdSpy);
    }
  });
});

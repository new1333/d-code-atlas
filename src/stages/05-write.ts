// stages/05-write.ts：Stage 5 · Write（逐章写作 + 每章对抗评审，并发）。
// 对应 design §4 Stage 5（Write）、§5.4（Critic·Chapter 验收标准）、§6（对抗评审 ADR-0004）、
// §7（自底向上）、§8.3/§8.4（章节产物 draft.md + replica/）、§15（单章失败隔离 / 到上限接受）。
//
// 流程（每章 Writer⇄Critic 循环，≤ reviewRounds 轮）：
//   读 outline → 标 stage running + save →
//   mapPool 并发跑「每章 writeChapter 子流程」：
//     确认 research.md 存在（缺料 → write failed + continue）
//     for round in 1..reviewRounds:
//       writer(feedback=上轮 fixes)（Writer 自己落盘 draft.md + replica/）
//         → 失败 → break，本章 write failed
//       critic(mode=chapter, slug)
//         → 失败 → break，本章 write failed
//         → approve → break，final=approved
//         → reject → 记 trace，下轮透传 fixes
//     末轮未 approve → final=accepted-with-warning
//     CAS：校验 draft.md 存在 → setChapterReview + setChapterStatus write done
//   串行 fold manifest（同 research stage 策略）→ stage done + save + return。
//
// writer feedback 透传（task M09 决策）：
//   给 writer 加可选 feedback?: string[] 参数（M08 非破坏性扩展，已落地）。
//   stage 把上一轮 critic 的 fixes 透传给下一轮 writer，让 Producer 据反馈修订。
//
// 并发 manifest fold 策略：同 research stage——mapPool 收集 + 串行 fold。
//   writeChapter 子流程返回 {slug, status, cmd?, review?}，fold 时按结果更新 manifest。

import { writer } from "../agents/writer.ts";
import { critic } from "../agents/critic.ts";
import {
  outlinePath,
  readJson,
  pathExists,
  draftPath,
  researchPath,
} from "../lib/io.ts";
import { mapPool } from "../lib/pool.ts";
import {
  setStageStatus,
  setChapterStatus,
  setChapterReview,
  saveManifest,
  type ReviewSummary,
  type ReviewTrace,
} from "../lib/manifest.ts";
import { DEFAULT_CONCURRENCY, REVIEW_ROUNDS } from "../lib/config.ts";
import type { Outline } from "../lib/types.ts";
import type { StageContext, StageResult } from "./types.ts";

/**
 * 单章 write 子流程的结算结果（供 fold 用）。
 * - status：本章 write 的终态（done / failed）。
 * - cmd：最后一条 claude 命令（writer 或 critic 的，便于审计）。
 * - review：对抗评审汇总（done 时挂；failed 时通常 null）。
 */
interface ChapterWriteResult {
  slug: string;
  status: "done" | "failed";
  cmd?: string;
  review: ReviewSummary | null;
}

/**
 * 单章 Writer⇄Critic 对抗评审子流程。
 *
 * @returns 结算结果（status=done 表示成功，含 review trace；status=failed 表示失败）。
 */
async function writeChapter(
  key: string,
  slug: string,
  spawn: StageContext["spawn"],
  model: string | undefined,
  maxRounds: number,
): Promise<ChapterWriteResult> {
  // 1) 确认 research.md 存在（缺料 → write failed）。
  const hasResearch = await pathExists(researchPath(key, slug));
  if (!hasResearch) {
    return {
      slug,
      status: "failed",
      cmd: `(write 跳过：research.md 缺失)`,
      review: null,
    };
  }

  const trace: ReviewTrace[] = [];
  let lastCmd = "";
  let final: ReviewSummary["final"] = "accepted-with-warning";
  let failed = false;
  let failedCmd = "";

  // 2) Writer⇄Critic 循环。
  for (let round = 1; round <= maxRounds; round++) {
    // 把上一轮 critic 的 fixes 透传给 writer（首轮 undefined）。
    const prevFixes = round === 1 ? undefined : trace[trace.length - 1]?.fixes;

    const writerOutcome = await writer({ key, slug, model, spawn, feedback: prevFixes });
    lastCmd = writerOutcome.cmd;

    if (!writerOutcome.ok) {
      // Writer 失败（claude 非零退出）→ 本章 failed，break。
      failed = true;
      failedCmd = writerOutcome.cmd;
      break;
    }

    const critOutcome = await critic({ key, mode: "chapter", slug, spawn });

    if (!critOutcome.ok || critOutcome.verdict === null) {
      // Critic 自身失败（解析失败等）= 工具异常 → 本章 failed（同 outline stage 取舍）。
      failed = true;
      failedCmd = critOutcome.cmd;
      break;
    }

    trace.push({
      round,
      verdict: critOutcome.verdict,
      ...(critOutcome.fixes.length > 0 ? { fixes: critOutcome.fixes } : {}),
      cmd: critOutcome.cmd,
    });

    if (critOutcome.verdict === "approve") {
      // 首轮 approve 短路。
      final = "approved";
      break;
    }
    // reject：fixes 进 trace，下一轮透传给 writer；末轮循环自然结束。
  }

  if (failed) {
    return { slug, status: "failed", cmd: failedCmd, review: null };
  }

  // 3) CAS：校验 draft.md 存在（Writer 已落盘）→ 构造 review 汇总。
  //    若 draft.md 不存在（Writer 自称 ok 但没写真文件）→ 视为失败。
  const hasDraft = await pathExists(draftPath(key, slug));
  if (!hasDraft) {
    return {
      slug,
      status: "failed",
      cmd: `(write 完成但 draft.md 未找到)`,
      review: null,
    };
  }

  return {
    slug,
    status: "done",
    cmd: lastCmd,
    review: { rounds: trace.length, final, trace },
  };
}

/**
 * Write stage：并发跑「每章 Writer⇄Critic」，落盘 draft.md + replica/，记 review trace。
 *
 * @returns 更新后的 manifest（已 saveManifest）。
 *          stage 级 status=done（即使个别章 failed）；每章 write.status=done|failed + review。
 */
export async function write(ctx: StageContext): Promise<StageResult> {
  const { key, manifest, spawn, model } = ctx;
  const concurrency = ctx.concurrency ?? DEFAULT_CONCURRENCY;
  const maxRounds = ctx.reviewRounds ?? REVIEW_ROUNDS;

  // 读 outline。
  let outline: Outline;
  try {
    outline = await readJson<Outline>(outlinePath(key));
  } catch (err) {
    const failed = setStageStatus(manifest, "write", "failed", {
      cmd: `(write 读 outline 失败) ${(err as Error).message}`,
    });
    await saveManifest(key, failed);
    return failed;
  }

  // 标 stage running + save。
  let m = setStageStatus(manifest, "write", "running");
  await saveManifest(key, m);

  const order =
    outline.topoOrder && outline.topoOrder.length > 0
      ? outline.topoOrder
      : outline.chapters.map((c) => c.slug);
  const knownSlugs = new Set(outline.chapters.map((c) => c.slug));
  const slugs = order.filter((s) => knownSlugs.has(s));

  // 并发跑每章 write 子流程（mapPool：单点失败隔离）。
  const results = await mapPool(
    slugs,
    async (slug) => writeChapter(key, slug, spawn, model, maxRounds),
    concurrency,
  );

  // 串行 fold manifest（单线程，无竞态）。
  for (let i = 0; i < slugs.length; i++) {
    const slug = slugs[i];
    const r = results[i];
    if (!r.ok) {
      // pool 层异常（writeChapter throw）→ 该章 failed。
      const msg = r.error instanceof Error ? r.error.message : String(r.error);
      m = setChapterStatus(m, slug, "write", "failed", {
        cmd: `(write 异常) ${msg.slice(-500)}`,
      });
      continue;
    }
    const res = r.value;
    if (res.status === "failed") {
      m = setChapterStatus(m, slug, "write", "failed", {
        ...(res.cmd !== undefined ? { cmd: res.cmd } : {}),
      });
      continue;
    }
    // CAS：Writer 已落盘 draft.md（子流程已校验）→ 置 review + done。
    m = setChapterReview(m, slug, res.review);
    m = setChapterStatus(m, slug, "write", "done", {
      ...(res.cmd !== undefined ? { cmd: res.cmd } : {}),
    });
  }

  // stage 级 done（即使个别章 failed）。
  m = setStageStatus(m, "write", "done");
  await saveManifest(key, m);
  return m;
}

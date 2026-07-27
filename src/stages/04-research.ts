// stages/04-research.ts：Stage 4 · Research（逐章精读，并发）。
// 对应 design §4 Stage 4（Research）、§8.3/§8.4（章节产物 research.md）、
// §15（错误处理：单章失败隔离，不炸整 stage）、NFR-4（并发有界）。
//
// 流程：
//   读 outline（拿 chapters + topoOrder）→ 标 stage running + save →
//   mapPool 并发跑 reader（concurrency 默认 DEFAULT_CONCURRENCY=4）→
//   串行 fold：每章 reader 成功 → CAS 先 writeText(research.md) 再 setChapterStatus done；
//              失败 → setChapterStatus failed（隔离）→
//   stage 级置 done（即使个别章 failed，流水线不阻塞）+ save + return。
//
// 并发 manifest fold 策略（task M09 推荐方案：mapPool + 串行 fold）：
//   不用 eachPool 的 onSettle 在并发中 fold——而是在 mapPool 返回后串行 fold。
//   理由：
//   1) mapPool 保证结果按原序回填（与完成先后无关），fold 时顺序确定；
//   2) 串行 fold 无竞态（即便 onSettle 在单线程下不会真并发，串行更直白、无 async onSettle 复杂度）；
//   3) 不在并发中频繁 saveManifest（只 stage 结束 save 一次），减少 IO 抖动。
//   缺点：单章 CAS 后若整 stage 崩了，已 done 章的 manifest 未 save——可接受
//   （单章产物已落盘，重跑时 reader 会重新覆盖；findNextPending 会重新识别）。
//
// 单章失败隔离（design §15）：
//   reader 失败的章只标该章 research=failed，其它章照常处理；stage 整体仍标 done。
//   理由：流水线不因一章失败而阻塞其它章；failed 章在 write 阶段会发现 research.md
//   缺失而被标 write=failed（缺料）。stage=done 让 orchestrator 推进到 write，
//   write 阶段自然处理缺料章。

import { reader } from "../agents/reader.ts";
import { outlinePath, readJson, writeText, researchPath } from "../lib/io.ts";
import { mapPool } from "../lib/pool.ts";
import { setStageStatus, setChapterStatus, saveManifest } from "../lib/manifest.ts";
import { DEFAULT_CONCURRENCY } from "../lib/config.ts";
import type { Outline } from "../lib/types.ts";
import type { StageContext, StageResult } from "./types.ts";

/**
 * Research stage：并发调 Reader 精读每章 sourceFiles，落盘 research.md。
 *
 * @returns 更新后的 manifest（已 saveManifest）。
 *          stage 级 status=done（即使个别章 failed）；每章 research.status=done|failed。
 */
export async function research(ctx: StageContext): Promise<StageResult> {
  const { key, manifest, spawn, model } = ctx;
  const concurrency = ctx.concurrency ?? DEFAULT_CONCURRENCY;
  // 本地源绝对路径：透传给 reader 作 --add-dir（cwd 之外的源目录需声明才可读）。
  const sourcePath = manifest.source.kind === "local" ? (manifest.source.localPath ?? manifest.source.ref) : undefined;

  // 读 outline（含 chapters + topoOrder）。
  // 若 outline.json 缺失/解析失败：这是上游异常（outline stage 应已 done），置 failed。
  let outline: Outline;
  try {
    outline = await readJson<Outline>(outlinePath(key));
  } catch (err) {
    const failed = setStageStatus(manifest, "research", "failed", {
      cmd: `(research 读 outline 失败) ${(err as Error).message}`,
    });
    await saveManifest(key, failed);
    return failed;
  }

  // 标 stage running + save（开始标记）。
  let m = setStageStatus(manifest, "research", "running");
  await saveManifest(key, m);

  // 按 topoOrder 取章节顺序（权威顺序，design §7）。
  // 若 outline 无 topoOrder（异常），回退到 chapters 声明序。
  const order =
    outline.topoOrder && outline.topoOrder.length > 0
      ? outline.topoOrder
      : outline.chapters.map((c) => c.slug);
  const knownSlugs = new Set(outline.chapters.map((c) => c.slug));
  // 续跑（AC-3）：跳过 manifest 里 research 已 done 的章节，避免重复 Reader 调用（省钱 + 幂等）。
  // failed / pending 的章节仍会重跑（failed 章给重试机会，符合 design §15 的 --force 重跑语义）。
  const slugs = order.filter((s) => {
    if (!knownSlugs.has(s)) return false;
    return manifest.chapters[s]?.research?.status !== "done";
  });

  // 若全部章已 done（resume 场景），直接置 stage done 返回，不调任何 reader。
  if (slugs.length === 0) {
    m = setStageStatus(m, "research", "done");
    await saveManifest(key, m);
    return m;
  }

  // 并发跑 reader（mapPool：单点失败隔离，结果按原序回填）。
  const results = await mapPool(
    slugs,
    async (slug) => reader({ key, slug, model, spawn, sourcePath }),
    concurrency,
  );

  // 串行 fold manifest（单线程，无竞态）。
  // CAS：每章先 writeText(research.md) 成功后再 setChapterStatus done。
  // 顺序按 slugs 原序（mapPool 保证 results 顺序 == slugs 顺序）。
  for (let i = 0; i < slugs.length; i++) {
    const slug = slugs[i];
    const r = results[i];
    if (!r.ok) {
      // pool 层隔离的异常（reader throw）→ 该章 failed。
      const msg = r.error instanceof Error ? r.error.message : String(r.error);
      m = setChapterStatus(m, slug, "research", "failed", {
        cmd: `(reader 异常) ${msg.slice(-500)}`,
      });
      continue;
    }
    const outcome = r.value;
    if (!outcome.ok || outcome.researchMd === null) {
      // reader 返回失败（claude 非零退出 / researchMd 解析失败）→ 该章 failed。
      m = setChapterStatus(m, slug, "research", "failed", { cmd: outcome.cmd });
      continue;
    }
    // CAS：先原子写 research.md，再置 chapter done。
    await writeText(researchPath(key, slug), outcome.researchMd);
    m = setChapterStatus(m, slug, "research", "done", { cmd: outcome.cmd });
  }

  // stage 级 done（即使个别章 failed——流水线不阻塞，failed 章在 write 阶段被发现缺料）。
  m = setStageStatus(m, "research", "done");
  await saveManifest(key, m);
  return m;
}

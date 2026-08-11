// scripts/rerun-fast.ts · 全量重跑（快速版）：直接调 writer/critic agent，高并发。
//
// 与 rerun-all-writes.ts（走 atlas resume 流水线）的区别：
//   - 直接 import writer/critic agent，不走 atlas CLI / orchestrator / manifest 状态机。
//   - 所有 Run 的所有章节，扁平化进一个 mapPool，全局并发（默认 8）。
//   - 每章写真实 draft.md（让后续 assemble 能搬到 site）。
//   - 不更新 manifest（write stage 仍显示旧状态——但我们之后会重跑 assemble，site/ 会更新）。
//   - Critic 默认关（--review-rounds 0）以提速；可 --review-rounds 1 启用单轮对抗。
//
// 用法：
//   bun run scripts/rerun-fast.ts [--keys k1,k2] [--concurrency 8] [--review-rounds 0]
//
// 长时间运行：8 Run × ~14 章 ≈ 113 章，平均 ~180s/章，concurrency=8 → ~40min。
// 建议后台运行：bun run scripts/rerun-fast.ts > scripts/rerun-fast.log 2>&1 &

import { writer } from "../src/agents/writer.ts";
import { outlinePath, draftPath, sourceDir, readJson, writeText } from "../src/lib/io.ts";
import { buildChapterContext } from "../src/lib/chapter-context.ts";
import { defaultSpawn } from "../src/lib/run-claude.ts";
import type { Outline } from "../src/lib/types.ts";

interface Args {
  keys: string[];
  concurrency: number;
  reviewRounds: number;
}

const ALL_KEYS = [
  "mitt", "node-modules-inspector", "pinia", "router",
  "vue-macro-vscode-10", "vue-macros", "yt-dlp", "zhihu-fisher-vscode",
];

function parseArgs(argv: string[]): Args {
  let keys: string[] | null = null;
  let concurrency = 8;
  let reviewRounds = 0;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--keys") { keys = argv[++i].split(",").map((s) => s.trim()).filter(Boolean); continue; }
    if (a === "--concurrency") { concurrency = parseInt(argv[++i], 10) || 8; continue; }
    if (a === "--review-rounds") { reviewRounds = parseInt(argv[++i], 10) || 0; continue; }
  }
  return { keys: keys ?? ALL_KEYS, concurrency, reviewRounds };
}

interface Job {
  key: string;
  slug: string;
  isTopic: boolean;
  title: string;
}

async function buildJobs(keys: string[]): Promise<Job[]> {
  const jobs: Job[] = [];
  for (const key of keys) {
    let outline: Outline;
    try {
      outline = await readJson<Outline>(outlinePath(key));
    } catch (e) {
      console.log(`[skip] ${key}: 无法读 outline.json`);
      continue;
    }
    const isTopic = !await fileExists(sourceDir(key));
    const order = outline.topoOrder && outline.topoOrder.length > 0
      ? outline.topoOrder
      : outline.chapters.map((c) => c.slug);
    for (const slug of order) {
      const ch = outline.chapters.find((c) => c.slug === slug);
      if (!ch) continue;
      jobs.push({ key, slug, isTopic, title: ch.title });
    }
  }
  return jobs;
}

async function fileExists(p: string): Promise<boolean> {
  try { await Bun.file(p).stat(); return true; } catch { return false; }
}

interface JobResult {
  job: Job;
  ok: boolean;
  duration: number;
  chars: number;
  error?: string;
}

async function runJob(job: Job, reviewRounds: number): Promise<JobResult> {
  const t0 = Date.now();
  try {
    const outline = await readJson<Outline>(outlinePath(job.key));
    const chapterContext = buildChapterContext(outline, job.slug);
    const sourcePath = job.isTopic ? undefined : sourceDir(job.key);
    const spawn = defaultSpawn;

    // 单轮 Writer（reviewRounds=0）；否则 Writer + 可选 Critic 反馈再 Writer。
    let prevFixes: string[] | undefined = undefined;
    let lastDraft = "";
    for (let round = 1; round <= Math.max(1, reviewRounds + 1); round++) {
      const w = await writer({
        key: job.key, slug: job.slug, spawn,
        feedback: prevFixes,
        chapterContext: chapterContext ?? undefined,
        mode: job.isTopic ? "topic" : "repo",
      });
      if (!w.ok || w.draftMd === null) {
        return { job, ok: false, duration: (Date.now() - t0) / 1000, chars: 0, error: `writer round ${round} failed: ${(w.stderr || "").slice(0, 200)}` };
      }
      lastDraft = w.draftMd;
      // 末轮或无 critic：落盘并结束。
      if (round > reviewRounds) break;
      // 启用 critic：读结果，若 reject 则把 fixes 带入下一轮。
      // 落盘 draft 让 critic 读。
      await writeText(draftPath(job.key, job.slug), w.draftMd);
      const { critic } = await import("../src/agents/critic.ts");
      const c = await critic({ key: job.key, mode: "chapter", slug: job.slug, spawn, sourcePath, sourceMode: job.isTopic ? "topic" : "repo" });
      if (!c.ok || c.verdict === null || c.verdict === "approve") break;
      prevFixes = c.fixes;
    }
    // 落盘最终 draft。
    await writeText(draftPath(job.key, job.slug), lastDraft);
    return { job, ok: true, duration: (Date.now() - t0) / 1000, chars: lastDraft.length };
  } catch (e) {
    return { job, ok: false, duration: (Date.now() - t0) / 1000, chars: 0, error: (e as Error).message?.slice(0, 200) };
  }
}

async function mapPool<T, R>(items: T[], fn: (item: T, idx: number) => Promise<R>, concurrency: number): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  let done = 0;
  const total = items.length;
  async function worker() {
    while (true) {
      const idx = cursor++;
      if (idx >= items.length) return;
      results[idx] = await fn(items[idx], idx);
      done++;
      const r = results[idx] as unknown as { ok: boolean; duration: number; job: { key: string; slug: string } };
      if (r && typeof r === "object" && "job" in r) {
        console.log(`[${done}/${total}] ${r.job.key}/${r.job.slug} ${r.ok ? "OK" : "FAIL"} dt=${r.duration.toFixed(0)}s`);
      }
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log(`[rerun-fast] keys=${JSON.stringify(args.keys)} concurrency=${args.concurrency} reviewRounds=${args.reviewRounds}`);
  const jobs = await buildJobs(args.keys);
  console.log(`[rerun-fast] total ${jobs.length} chapters across ${args.keys.length} runs`);

  const t0 = Date.now();
  const results = await mapPool(jobs, (j) => runJob(j, args.reviewRounds), args.concurrency);

  console.log(`\n========== SUMMARY ==========`);
  let ok = 0, fail = 0;
  const byRun: Record<string, { ok: number; fail: number }> = {};
  for (const r of results) {
    if (r.ok) ok++; else fail++;
    byRun[r.job.key] = byRun[r.job.key] ?? { ok: 0, fail: 0 };
    if (r.ok) byRun[r.job.key].ok++; else byRun[r.job.key].fail++;
  }
  for (const [k, v] of Object.entries(byRun)) {
    console.log(`  ${k}: ok=${v.ok} fail=${v.fail}`);
  }
  for (const r of results.filter((r) => !r.ok)) {
    console.log(`  FAIL ${r.job.key}/${r.job.slug}: ${r.error}`);
  }
  console.log(`total dt=${((Date.now() - t0) / 60).toFixed(1)}min | ok=${ok} fail=${fail}`);
}

await main();

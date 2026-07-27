/**
 * Stage 5 · Write (design §4, §5.4). Writer ⇄ Critic per chapter, concurrent.
 *
 * For each chapter:
 *   - Writer drafts draft.md + replica/ files (cwd = chapter dir).
 *   - Critic reviews (≤ reviewRounds), reject → Writer revises.
 * Output: work/chapters/{slug}/draft.md + replica/*.ts|js.
 *
 * Resumable at chapter granularity.
 */
import {
  artifactPaths,
  ensureDir,
  readJson,
  rmrf,
  runDir,
  writeText,
} from "../lib/io.ts";
import {
  markChapterDone,
  markChapterFailed,
  markChapterRunning,
  markStageDone,
  markStageFailed,
  markStageRunning,
  setChapterReview,
  type Manifest,
  type ChapterStageRecord,
} from "../lib/manifest.ts";
import { runWriter, extractReplicas } from "../agents/writer.ts";
import { runCritic } from "../agents/critic.ts";
import { mapPool } from "../lib/pool.ts";
import type { OutlineChapter } from "../agents/architect.ts";

export interface WriteStageOpts {
  concurrency: number;
  reviewRounds: number;
  model?: string;
}

interface OutlineFile {
  chapters: OutlineChapter[];
}

export async function stageWrite(
  m: Manifest,
  opts: WriteStageOpts,
): Promise<void> {
  console.log(`[stage:write] drafting chapters (concurrency ${opts.concurrency}, ${opts.reviewRounds} review rounds each)`);
  const runRoot = runDir(m.key);
  try {
    const outline = await readJson<OutlineFile>(artifactPaths.outline(m.key));
    const chapters = outline.chapters;

    const pending = chapters.filter((c) => {
      const rec: ChapterStageRecord | undefined = m.chapters[c.slug]?.write;
      return !rec || rec.status !== "done";
    });
    if (pending.length === 0) {
      console.log(`[stage:write] all ${chapters.length} chapters already done — skipping`);
      markStageDone(m, "write");
      return;
    }

    markStageRunning(m, "write", `pool(${opts.concurrency}) × ${pending.length} writers`);

    let done = 0;
    const failures: { slug: string; error: string }[] = [];

    await mapPool(
      pending,
      opts.concurrency,
      async (chapter) => {
        const chapterDir = artifactPaths.chapter(m.key, chapter.slug);
        try {
          await ensureDir(chapterDir);
          // clean any prior replica from a failed/partial run
          await rmrf(`${chapterDir}/replica`);

          let latestDraft = "";
          let lastCmd = "";
          const trace: { round: number; verdict: "approve" | "reject"; fixes?: string }[] = [];
          let finalVerdict: "approve" | "accepted-with-warning" = "accepted-with-warning";
          let feedback: string | undefined = undefined;

          for (let round = 1; round <= opts.reviewRounds; round++) {
            const wres = await runWriter({
              cwd: chapterDir,
              chapter,
              feedback,
              model: opts.model,
            });
            lastCmd = wres.cmd;
            latestDraft = wres.draftMd;
            // CAS: write draft + replica files before critic reads them
            await writeText(artifactPaths.draft(m.key, chapter.slug), latestDraft);
            const replicas = extractReplicas(latestDraft);
            if (replicas.length > 0) {
              const replicaDir = artifactPaths.replicaDir(m.key, chapter.slug);
              await ensureDir(replicaDir);
              for (const r of replicas) {
                await writeText(`${replicaDir}/${r.filename}`, r.content);
              }
            }

            const cres = await runCritic({
              mode: "critic-chapter",
              cwd: runRoot,
              target: `work/chapters/${chapter.slug}/draft.md`,
              model: opts.model,
            });
            trace.push({
              round,
              verdict: cres.verdict.verdict === "approve" ? "approve" : "reject",
              fixes: cres.verdict.verdict === "reject" ? cres.verdict.fixesSummary : undefined,
            });
            markChapterRunning(m, chapter.slug, "write", lastCmd);

            if (cres.verdict.verdict === "approve") {
              finalVerdict = "approve";
              console.log(`[stage:write] ${chapter.slug}: APPROVE (round ${round})`);
              break;
            }
            console.log(`[stage:write] ${chapter.slug}: REJECT round ${round} — revising`);
            feedback = cres.verdict.fixesSummary;
          }

          // record review + done
          setChapterReview(m, chapter.slug, {
            rounds: trace.length,
            final: finalVerdict,
            trace,
          });
          markChapterDone(m, chapter.slug, "write");
          done++;
          console.log(`[stage:write] ${done}/${pending.length} done: ${chapter.slug}`);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          markChapterFailed(m, chapter.slug, "write", msg);
          failures.push({ slug: chapter.slug, error: msg });
          console.error(`[stage:write] FAILED ${chapter.slug}: ${msg}`);
        }
      },
    );

    if (failures.length > 0) {
      markStageFailed(
        m,
        "write",
        `${failures.length}/${pending.length} chapters failed: ${failures.map((f) => f.slug).join(", ")}`,
      );
      throw new Error(`write failed for ${failures.length} chapters`);
    }

    markStageDone(m, "write");
    console.log(`[stage:write] done — ${done} chapters drafted`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    markStageFailed(m, "write", msg);
    console.error(`[stage:write] FAILED: ${msg}`);
    throw e;
  }
}

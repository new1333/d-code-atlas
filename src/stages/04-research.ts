/**
 * Stage 4 · Research (design §4). One Reader per chapter, concurrent (pool).
 * Reads outline.json + source; writes work/chapters/{slug}/research.md.
 *
 * Resumable at chapter granularity: chapters already `done` are skipped.
 */
import { artifactPaths, ensureDir, readJson, runDir, writeText } from "../lib/io.ts";
import {
  markChapterDone,
  markChapterFailed,
  markChapterRunning,
  markStageDone,
  markStageFailed,
  markStageRunning,
  type Manifest,
  type ChapterStageRecord,
} from "../lib/manifest.ts";
import { runReader } from "../agents/reader.ts";
import { mapPool } from "../lib/pool.ts";
import type { OutlineChapter } from "../agents/architect.ts";

export interface ResearchStageOpts {
  concurrency: number;
  model?: string;
}

interface OutlineFile {
  chapters: OutlineChapter[];
}

export async function stageResearch(
  m: Manifest,
  opts: ResearchStageOpts,
): Promise<void> {
  console.log(`[stage:research] reading chapters (concurrency ${opts.concurrency})`);
  const cwd = runDir(m.key);
  try {
    const outline = await readJson<OutlineFile>(artifactPaths.outline(m.key));
    const chapters = outline.chapters;

    // only research chapters not already done (resume support)
    const pending = chapters.filter((c) => {
      const rec: ChapterStageRecord | undefined = m.chapters[c.slug]?.research;
      return !rec || rec.status !== "done";
    });
    if (pending.length === 0) {
      console.log(`[stage:research] all ${chapters.length} chapters already done — skipping`);
      markStageDone(m, "research");
      return;
    }

    markStageRunning(m, "research", `pool(${opts.concurrency}) × ${pending.length} readers`);

    let done = 0;
    const failures: { slug: string; error: string }[] = [];
    await mapPool(
      pending,
      opts.concurrency,
      async (chapter) => {
        try {
          // ensure chapter dir exists
          await ensureDir(artifactPaths.chapter(m.key, chapter.slug));
          const res = await runReader({ cwd, chapter, model: opts.model });
          markChapterRunning(m, chapter.slug, "research", res.cmd);
          // CAS: write artifact fully, then mark done
          await writeText(artifactPaths.research(m.key, chapter.slug), res.researchMd);
          markChapterDone(m, chapter.slug, "research");
          done++;
          console.log(`[stage:research] ${done}/${pending.length} done: ${chapter.slug} (${res.durationMs}ms)`);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          markChapterFailed(m, chapter.slug, "research", msg);
          failures.push({ slug: chapter.slug, error: msg });
          console.error(`[stage:research] FAILED ${chapter.slug}: ${msg}`);
          // don't throw — let other chapters finish; we fail the stage after
        }
      },
      (d, total, current) => {
        if (d === 0) console.log(`[stage:research] starting ${current.slug} (${d + 1}/${total})`);
      },
    );

    if (failures.length > 0) {
      markStageFailed(
        m,
        "research",
        `${failures.length}/${pending.length} chapters failed: ${failures.map((f) => f.slug).join(", ")}`,
      );
      throw new Error(`research failed for ${failures.length} chapters`);
    }

    markStageDone(m, "research");
    console.log(`[stage:research] done — ${done} chapters researched`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    markStageFailed(m, "research", msg);
    console.error(`[stage:research] FAILED: ${msg}`);
    throw e;
  }
}

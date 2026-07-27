/**
 * Stage 3 · Outline (design §4, §5.2, §5.3). Architect ⇄ Critic, read-only.
 *
 * Flow:
 *   1. Architect drafts outline.json (chapters + dependsOn DAG).
 *   2. topo.ts computes topoOrder (Kahn + cycle detection).
 *   3. Critic adversarially reviews (≤ reviewRounds).
 *   4. On reject, Architect revises per feedback; loop.
 *   5. Hard validation: cycle / dangling / count → fail stage if unfixable.
 *
 * Output: work/outline.json (with computed topoOrder).
 */
import { artifactPaths, ensureDir, writeJson } from "../lib/io.ts";
import {
  markStageDone,
  markStageFailed,
  markStageRunning,
  setStageReview,
  ensureChapter,
  type Manifest,
} from "../lib/manifest.ts";
import { runArchitect, type Outline, type OutlineChapter } from "../agents/architect.ts";
import { reviewLoop } from "../lib/review.ts";
import { topoSort, verifyClosure } from "../lib/topo.ts";

export interface OutlineStageOpts {
  reviewRounds: number;
  model?: string;
  maxChapters?: number;
}

export async function stageOutline(
  m: Manifest,
  opts: OutlineStageOpts,
): Promise<void> {
  console.log(`[stage:outline] designing chapter DAG (max ${opts.reviewRounds} review rounds)`);
  const { runDir } = await import("../lib/io.ts");
  const agentCwd = runDir(m.key);

  try {
    await ensureDir(`${agentCwd}/work`);
    let latestOutline: Outline | null = null;

    const review = await reviewLoop({
      mode: "critic-outline",
      cwd: agentCwd,
      target: "work/outline.json",
      maxRounds: opts.reviewRounds,
      model: opts.model,
      produce: async (feedback) => {
        const res = await runArchitect({ cwd: agentCwd, feedback, model: opts.model });
        latestOutline = res.outline;
        // CAS: write artifact, then the critic reads it from disk
        await writeJson(artifactPaths.outline(m.key), {
          ...res.outline,
          topoOrder: [], // filled after topo sort below
        });
        markStageRunning(m, "outline", res.cmd);
      },
    });

    if (!latestOutline) {
      throw new Error("architect produced no outline");
    }

    // Hard validation pass (independent of Critic): topo + closure + count
    const validated = validateAndAnnotate(latestOutline, opts.maxChapters ?? 24);

    // Final write WITH topoOrder
    const finalOutline = {
      repo: validated.repo,
      generatedAt: new Date().toISOString(),
      chapters: validated.chapters,
      topoOrder: validated.topoOrder,
    };
    await writeJson(artifactPaths.outline(m.key), finalOutline);

    // pre-register chapters in manifest so later stages find them
    for (const c of validated.chapters) ensureChapter(m, c.slug);

    setStageReview(m, "outline", {
      rounds: review.rounds,
      final: review.final,
      trace: review.trace.map((t) => ({
        round: t.round,
        verdict: t.verdict,
        fixes: t.fixes,
      })),
    });
    markStageDone(m, "outline");
    console.log(
      `[stage:outline] done — ${validated.chapters.length} chapters, topoOrder=[${validated.topoOrder.slice(0, 6).join(", ")}${validated.topoOrder.length > 6 ? ", …" : ""}], review=${review.final} (${review.rounds} rounds)`,
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    markStageFailed(m, "outline", msg);
    console.error(`[stage:outline] FAILED: ${msg}`);
    throw e;
  }
}

interface ValidatedOutline {
  repo: string;
  chapters: OutlineChapter[];
  topoOrder: string[];
}

/**
 * Independently re-derive the topo order (Critic also checks, but this is the
 * authoritative mechanical gate — design §7 校验层). Fails the stage on hard
 * errors: cycles, dangling refs that survived, chapter count out of range.
 */
function validateAndAnnotate(outline: Outline, maxChapters: number): ValidatedOutline {
  const chapters = outline.chapters;
  if (chapters.length < 8) {
    // allow smaller for tiny repos but warn; hard-fail only on >max
    console.warn(`[stage:outline] WARN: only ${chapters.length} chapters (< 8)`);
  }
  if (chapters.length > maxChapters) {
    throw new Error(
      `outline has ${chapters.length} chapters > maxChapters=${maxChapters}; Architect must merge`,
    );
  }

  const topo = topoSort(chapters.map((c) => ({ slug: c.slug, dependsOn: c.dependsOn })));
  if (topo.hasCycle) {
    throw new Error(`dependency cycle detected among chapters: [${topo.cycleNodes.join(", ")}]`);
  }
  if (topo.danglingRefs.length > 0) {
    // architect.normalizer already drops these, but double-check
    throw new Error(`dangling dependsOn refs survived: [${topo.danglingRefs.join(", ")}]`);
  }
  // cross-check closure (Critic's job too — here it's a hard gate)
  const closure = verifyClosure(topo.order, chapters.map((c) => ({ slug: c.slug, dependsOn: c.dependsOn })));
  if (!closure.ok) {
    const detail = closure.violations
      .map((v) => `${v.slug} needs [${v.unmet.join(",")}] before it`)
      .join("; ");
    throw new Error(`topological closure violated: ${detail}`);
  }

  return { repo: outline.repo, chapters, topoOrder: topo.order };
}

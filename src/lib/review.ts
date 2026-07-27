/**
 * Adversarial review loop (design §6, ADR-0004).
 *
 *   Producer drafts → Critic reviews → approve? done
 *                                  → reject+fixes → Producer revises → Critic (≤ maxRounds)
 *                                                  → still reject at cap → accept last + warn
 *
 * Returns the final verdict + a trace for the manifest.
 */
import { runCritic, type CriticVerdict, type CriticMode } from "../agents/critic.ts";

export interface ReviewLoopResult {
  final: "approve" | "accepted-with-warning";
  rounds: number;
  trace: { round: number; verdict: "approve" | "reject"; fixes?: string }[];
  /** Summary of the last fixes applied (for the Producer's final state). */
  lastFeedback?: string;
}

export interface ReviewLoopDeps {
  mode: CriticMode;
  cwd: string;
  target: string;
  maxRounds: number;
  model?: string;
  /**
   * Produce a draft, optionally incorporating prior feedback. Must fully write
   * the artifact to disk before resolving (CAS discipline).
   * Returns true if production succeeded.
   */
  produce: (feedback: string | undefined) => Promise<void>;
}

export async function reviewLoop(deps: ReviewLoopDeps): Promise<ReviewLoopResult> {
  const { mode, cwd, target, maxRounds, model, produce } = deps;
  const trace: ReviewLoopResult["trace"] = [];
  let feedback: string | undefined = undefined;

  for (let round = 1; round <= maxRounds; round++) {
    // 1. produce (round 1 = no feedback; later rounds = revise per feedback)
    await produce(feedback);

    // 2. critic reviews
    const res = await runCritic({ mode, cwd, target, model });
    const v: CriticVerdict = res.verdict;
    trace.push({
      round,
      verdict: v.verdict === "approve" ? "approve" : "reject",
      fixes: v.verdict === "reject" ? v.fixesSummary : undefined,
    });

    if (v.verdict === "approve") {
      console.log(`[review] round ${round}/${maxRounds}: APPROVE`);
      return { final: "approve", rounds: round, trace };
    }
    console.log(`[review] round ${round}/${maxRounds}: REJECT — revise`);
    feedback = v.fixesSummary;
  }

  // exhausted rounds → accept last version with warning (design §15)
  console.log(`[review] rounds exhausted — accepting last version with warning`);
  return { final: "accepted-with-warning", rounds: maxRounds, trace, lastFeedback: feedback };
}

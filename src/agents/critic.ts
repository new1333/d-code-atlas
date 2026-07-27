/**
 * Critic agent (design §5.3, §5.4). Read-only. Never produces content — only
 * returns an approve/reject verdict + concrete fixes. Two modes via `role`:
 *   - "critic-outline"  → reviews work/outline.json
 *   - "critic-chapter"  → reviews a chapter draft
 *
 * The orchestrator drives the adversarial loop (≤ N rounds), passing each
 * round's fixes back to the Producer (design §6).
 */
import { runClaude, type RunClaudeOptions } from "../lib/run-claude.ts";
import { withJsonRetry } from "../lib/retry.ts";

export type CriticMode = "critic-outline" | "critic-chapter";

export type Verdict = "approve" | "reject";

export interface CriticIssue {
  criterion?: string;
  chapter?: string | null;
  problem?: string;
  fix?: string;
  [k: string]: unknown;
}

export interface CriticVerdict {
  verdict: Verdict;
  issues: CriticIssue[];
  /** Raw text of all fixes, for feeding back to the Producer. */
  fixesSummary: string;
}

export interface CriticInput {
  mode: CriticMode;
  cwd: string;
  /** The subject of review: e.g. "outline.json" or "chapters/{slug}/draft.md". */
  target: string;
  model?: string;
}

export interface CriticResult {
  cmd: string;
  durationMs: number;
  verdict: CriticVerdict;
}

export async function runCritic(input: CriticInput): Promise<CriticResult> {
  const userPrompt = [
    `Review \`${input.target}\` per your role's acceptance criteria.`,
    `Read \`work/repo-map.json\`, \`work/outline.json\`, and spot-check \`work/source/\` as needed to verify accuracy.`,
    `Return ONLY the verdict JSON per your role instructions (a \`\`\`json fence with {verdict, issues}).`,
  ].join("\n");

  const opts: RunClaudeOptions = {
    role: input.mode,
    userPrompt,
    cwd: input.cwd,
    readOnly: true,
    model: input.model,
    timeoutMs: 6 * 60 * 1000,
  };

  // Try to get JSON; if the model emits prose instead, parse the verdict from
  // prose (this model frequently writes "裁决:不通过" / "verdict: approve" etc.
  // instead of strict JSON). One attempt is enough — retry rarely helps here.
  let cmd = "";
  let durationMs = 0;
  let verdict: CriticVerdict | null = null;
  try {
    const { value: raw } = await withJsonRetry<unknown>({
      label: input.mode,
      maxAttempts: 2,
      run: async (feedback) => {
        const o = feedback ? { ...opts, userPrompt: `${userPrompt}\n\n${feedback}` } : opts;
        const r = await runClaude(o);
        cmd = r.cmd;
        durationMs = r.durationMs;
        return { resultText: r.resultText, cmd: r.cmd, durationMs: r.durationMs };
      },
    });
    verdict = normalizeVerdict(raw);
  } catch {
    // JSON parsing failed — but we still have the last resultText captured
    // in the retry loop. Re-run once to capture text for prose parsing.
    const r = await runClaude(opts);
    cmd = r.cmd;
    durationMs = r.durationMs;
    verdict = parseProseVerdict(r.resultText);
  }
  return { cmd, durationMs, verdict };
}

function normalizeVerdict(raw: unknown): CriticVerdict {
  if (!raw || typeof raw !== "object") {
    // couldn't parse → treat as reject with a note so the loop continues
    return {
      verdict: "reject",
      issues: [{ problem: "Critic returned unparseable verdict" }],
      fixesSummary: "Critic returned unparseable verdict; re-review.",
    };
  }
  const obj = raw as Record<string, any>;
  const verdict: Verdict = obj.verdict === "approve" ? "approve" : "reject";
  const issues: CriticIssue[] = Array.isArray(obj.issues) ? obj.issues : [];
  const fixesSummary = issues
    .map((i, idx) => {
      const where = i.chapter ? `[${i.chapter}]` : "[outline-wide]";
      const crit = i.criterion ? `(${i.criterion})` : "";
      return `${idx + 1}. ${where} ${crit} ${i.problem || ""} → fix: ${i.fix || ""}`;
    })
    .join("\n");
  return { verdict, issues, fixesSummary };
}

/**
 * Parse a verdict from a free-form prose response when the model refused to
 * emit JSON. Looks for explicit verdict keywords (approve/通过/accept vs
 * reject/驳回/不通过/decline). The whole prose becomes the "fixes" feedback
 * so the Producer still gets actionable critique.
 */
function parseProseVerdict(text: string): CriticVerdict {
  const lower = text.toLowerCase();
  // approve signals
  const approveHit =
    /\bapprove\b|accept(ed)?|通过|采纳|认可|合格|满足/.test(lower) &&
    !/不通过|未通过|驳回|reject|不采纳|不合格|不满足/.test(lower);
  // explicit reject signals take precedence
  const rejectHit =
    /\breject\b|decline|驳回|不通过|未通过|不合格|不采纳|不满足|阻塞|fail/.test(lower);

  const verdict: Verdict = approveHit && !rejectHit ? "approve" : "reject";
  // capture bullet/numbered lines as issue candidates; fall back to whole text
  const issueLines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /^([-*•]|\d+[.、)])\s+\S/.test(l) && l.length > 10)
    .slice(0, 12);
  const issues: CriticIssue[] = (issueLines.length > 0 ? issueLines : [text.slice(0, 800)]).map(
    (line) => ({ problem: line.replace(/^([-*•]|\d+[.、)])\s*/, "") }),
  );
  const fixesSummary =
    (verdict === "approve"
      ? "Critic approved (parsed from prose). "
      : "Critic rejected (parsed from prose). Issues:\n") + issues.map((i, idx) => `${idx + 1}. ${i.problem}`).join("\n");
  console.warn(`[critic] parsed ${verdict} from prose (no JSON emitted)`);
  return { verdict, issues, fixesSummary };
}

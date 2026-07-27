/**
 * Retry an agent call until it returns parseable JSON (with feedback to the
 * agent on parse failure), up to `maxAttempts`.
 *
 * Some models intermittently emit prose instead of the contracted JSON (meta-
 * commentary like "I couldn't access X, so..."). Feeding the parse error back
 * and asking for JSON-only usually fixes it on the second attempt. Cheap and
 * keeps the agent layer robust to instruction-following drift.
 */
import { extractJson } from "./extract.ts";

export interface JsonRetryOpts<T> {
  /** Attempt the agent call; return its result text + any side-effect cmd/duration. */
  run: (feedback: string | undefined) => Promise<{ resultText: string; cmd: string; durationMs: number }>;
  /** User-facing label for logs. */
  label: string;
  maxAttempts?: number;
}

export interface JsonRetryResult<T> {
  value: T;
  cmd: string;
  durationMs: number;
  attempts: number;
}

export async function withJsonRetry<T>(
  opts: JsonRetryOpts<T>,
): Promise<JsonRetryResult<T>> {
  const maxAttempts = opts.maxAttempts ?? 2;
  let feedback: string | undefined = undefined;
  let last: { resultText: string; cmd: string; durationMs: number } | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    last = await opts.run(feedback);
    try {
      const value = extractJson<T>(last.resultText);
      if (attempt > 1) {
        console.log(`[${opts.label}] JSON parsed on attempt ${attempt}`);
      }
      return { value, cmd: last.cmd, durationMs: last.durationMs, attempts: attempt };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[${opts.label}] attempt ${attempt}/${maxAttempts} parse failed: ${msg.slice(0, 150)}`);
      feedback =
        `Your previous response was NOT valid JSON and could not be parsed:\n${msg.slice(0, 300)}\n\n` +
        `Respond AGAIN with ONLY a single \`\`\`json fence containing the JSON object per your role instructions. ` +
        `No prose, no explanations, no tables — just the json fence.`;
    }
  }
  throw new Error(
    `${opts.label}: failed to obtain parseable JSON after ${maxAttempts} attempts. Last response head: ${last?.resultText.slice(0, 300) ?? "<none>"}`,
  );
}

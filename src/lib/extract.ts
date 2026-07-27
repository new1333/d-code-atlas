/**
 * Extract a JSON object from an LLM response that may be wrapped in markdown
 * fences or surrounded by prose. Analysis agents (read-only) return their
 * structured result as their final message; the orchestrator parses + writes
 * the artifact file (ADR-0005: read-only agents can't write their own output).
 *
 * Strategy:
 *  1. Strip markdown code fences, prefer a fenced ```json block.
 *  2. Try direct parse of the whole (fenced) candidate.
 *  3. Find the LARGEST balanced { ... } span (our schemas are always objects,
 *     never bare arrays), parse it. Largest-not-first avoids grabbing a tiny
 *     inline `[]` or `{}` that appears in surrounding prose.
 *  4. Fall back to largest [ ... ] only if no object found.
 *
 * Throws if no valid JSON object can be extracted — callers should treat that
 * as "agent didn't follow the output contract" and surface a clear error.
 */
export function extractJson<T = unknown>(text: string): T {
  const trimmed = text.trim();

  // 1. prefer a ```json fence, else any ``` fence, else the whole text
  const jsonFence = trimmed.match(/```json\s*([\s\S]*?)```/i);
  const anyFence = trimmed.match(/```\s*([\s\S]*?)```/i);
  const candidate = (jsonFence?.[1] || anyFence?.[1] || trimmed).trim();

  // 2. direct parse
  try {
    const v = JSON.parse(candidate);
    return v as T;
  } catch {
    /* fall through */
  }

  // 3. largest balanced object { ... }
  const obj = findLargestBalanced(candidate, "{", "}");
  if (obj !== null) {
    try {
      return JSON.parse(obj) as T;
    } catch {
      /* keep trying */
    }
  }
  // 4. largest balanced array [ ... ] (fallback; rare for our schemas)
  const arr = findLargestBalanced(candidate, "[", "]");
  if (arr !== null) {
    try {
      return JSON.parse(arr) as T;
    } catch {
      /* give up */
    }
  }
  throw new Error(
    `extractJson: no JSON object found in response (len=${text.length}); head=${text.slice(0, 200)}`,
  );
}

/**
 * Find the largest balanced span between `open` and `close` in `s`.
 * "Largest" = the balanced span with the greatest end-start distance, which
 * reliably picks the real payload over stray inline punctuation.
 */
function findLargestBalanced(s: string, open: string, close: string): string | null {
  let best: string | null = null;
  for (let start = 0; start < s.length; start++) {
    if (s[start] !== open) continue;
    let depth = 0;
    let inStr: string | null = null;
    let escape = false;
    for (let i = start; i < s.length; i++) {
      const ch = s[i]!;
      if (inStr) {
        if (escape) escape = false;
        else if (ch === "\\") escape = true;
        else if (ch === inStr) inStr = null;
        continue;
      }
      if (ch === '"' || ch === "'") {
        inStr = ch;
        continue;
      }
      if (ch === open) depth++;
      else if (ch === close) {
        depth--;
        if (depth === 0) {
          const span = s.slice(start, i + 1);
          if (best === null || span.length > best.length) best = span;
          break; // move to next start
        }
      }
    }
  }
  return best;
}

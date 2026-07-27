/**
 * Writer agent (design §5, §8.4). Produces chapter draft + replica files.
 *
 * Read-only (returns chapter Markdown via message, like the Reader). The
 * orchestrator writes draft.md and extracts the embedded replica code block
 * into replica/ files. This sidesteps the model's write-permission reluctance
 * and keeps the producer message-based for reliability.
 */
import { runClaude, type RunClaudeOptions } from "../lib/run-claude.ts";
import type { OutlineChapter } from "./architect.ts";

export interface WriterInput {
  /** cwd = work/chapters/{slug}/ — so the agent can read research.md + ../../source/. */
  cwd: string;
  chapter: OutlineChapter;
  feedback?: string;
  model?: string;
}

export interface WriterResult {
  cmd: string;
  durationMs: number;
  draftMd: string;
}

export async function runWriter(input: WriterInput): Promise<WriterResult> {
  const c = input.chapter;
  const userPrompt = [
    `Write chapter \`${c.slug}\` (${c.title}).`,
    ``,
    `- layer: ${c.layer}`,
    `- summary: ${c.summary}`,
    `- dependsOn (prerequisite chapters already written): ${c.dependsOn.length ? c.dependsOn.join(", ") : "(none — primitive)"}`,
    ``,
    `Read \`research.md\` (in your cwd) and the source under \`../../source/\` as needed.`,
    ``,
    `**Return the FULL chapter Markdown as your response message.** It must include an embedded runnable replica as a fenced \`\`\`ts or \`\`\`js block, marked with \`// replica: entry\` on its first line. Ground exposition in the source (cite 源码位置/source:). Do NOT write files — return the chapter as your message.`,
    input.feedback
      ? `\n## Previous Critic feedback (revise to address ALL of these)\n${input.feedback}`
      : "",
  ].join("\n");

  const opts: RunClaudeOptions = {
    role: "writer",
    userPrompt,
    cwd: input.cwd,
    readOnly: true, // message-based delivery; orchestrator writes draft + replica
    model: input.model,
    timeoutMs: 10 * 60 * 1000,
  };
  const res = await runClaude(opts);
  return {
    cmd: res.cmd,
    durationMs: res.durationMs,
    draftMd: res.resultText || `# ${c.title}\n\n(no content)`,
  };
}

/**
 * Extract fenced ```ts/```js code blocks marked as replicas from the draft.
 * The writer marks the replica with `// replica: entry` (or `// replica:`) on
 * the first line. Returns { filename, content } pairs to write under replica/.
 */
export function extractReplicas(draftMd: string): { filename: string; content: string }[] {
  const out: { filename: string; content: string }[] = [];
  // match fenced code blocks: ```lang\n<content>\n```
  const re = /```(\w+)\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  let idx = 0;
  while ((m = re.exec(draftMd)) !== null) {
    const lang = m[1]!.toLowerCase();
    const body = m[2]!;
    // only treat ts/js blocks marked as replica
    if (!["ts", "js", "typescript", "javascript"].includes(lang)) continue;
    if (!/\/\/\s*replica\s*:/.test(body)) continue;
    const ext = lang.startsWith("ts") ? "ts" : "js";
    const filename = idx === 0 ? `index.${ext}` : `replica-${idx}.${ext}`;
    out.push({ filename, content: body });
    idx++;
  }
  // if no explicitly-marked replica, fall back to the first ts/js block
  if (out.length === 0) {
    re.lastIndex = 0;
    while ((m = re.exec(draftMd)) !== null) {
      const lang = m[1]!.toLowerCase();
      if (!["ts", "js", "typescript", "javascript"].includes(lang)) continue;
      const ext = lang.startsWith("ts") ? "ts" : "js";
      out.push({ filename: `index.${ext}`, content: m[2]! });
      break;
    }
  }
  return out;
}

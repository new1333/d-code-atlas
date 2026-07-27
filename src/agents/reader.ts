/**
 * Reader agent (design §5, §8.3). Read-only. One Reader per chapter reads its
 * sourceFiles[] and returns a research.md note; the orchestrator writes it.
 *
 * Runs concurrently via pool.ts (default 4) in the research stage.
 */
import { runClaude, type RunClaudeOptions } from "../lib/run-claude.ts";
import type { OutlineChapter } from "./architect.ts";

export interface ReaderInput {
  cwd: string;
  chapter: OutlineChapter;
  model?: string;
}

export interface ReaderResult {
  cmd: string;
  durationMs: number;
  researchMd: string;
}

export async function runReader(input: ReaderInput): Promise<ReaderResult> {
  const c = input.chapter;
  const filesList = c.sourceFiles.length > 0
    ? c.sourceFiles.map((f) => `  - work/source/${f}`).join("\n")
    : "  (no sourceFiles declared — discover relevant files yourself under work/source/)";
  const userPrompt = [
    `Research chapter \`${c.slug}\` (${c.title}).`,
    ``,
    `- layer: ${c.layer}`,
    `- summary: ${c.summary}`,
    `- dependsOn: ${c.dependsOn.length ? c.dependsOn.join(", ") : "(none — primitive)"}`,
    ``,
    `Read these source files under work/source/:`,
    filesList,
    ``,
    `Return the Markdown research note per your role instructions. Ground every claim in a 源码位置/source: annotation.`,
  ].join("\n");

  const opts: RunClaudeOptions = {
    role: "reader",
    userPrompt,
    cwd: input.cwd,
    readOnly: true,
    model: input.model,
    timeoutMs: 6 * 60 * 1000,
  };
  const res = await runClaude(opts);
  return {
    cmd: res.cmd,
    durationMs: res.durationMs,
    researchMd: res.resultText || `# Research: ${c.title}\n\n(no content)`,
  };
}

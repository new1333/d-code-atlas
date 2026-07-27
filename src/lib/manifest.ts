/**
 * Manifest state machine (ADR-0002). The single source of truth for run
 * progress. Every stage/chapter status lives here; resume = read manifest,
 * rerun anything not `done`.
 *
 * CAS discipline (design §9): callers must (1) fully write the artifact to
 * disk, THEN (2) call markDone. We never flip to `done` speculatively.
 */
import {
  ensureDir,
  manifestPath,
  readJson,
  writeJson,
  pathExists,
  runDir,
} from "./io.ts";

// ---------------------------------------------------------------------------
// Types (mirror design §8.3)
// ---------------------------------------------------------------------------

export type StageStatus =
  | "pending"
  | "running"
  | "done"
  | "failed"
  | "awaiting_review";

export type ReviewVerdict = "approve" | "reject" | "accepted-with-warning";

export interface ReviewTrace {
  round: number;
  verdict: ReviewVerdict;
  fixes?: string; // critic's requested fixes (reject) or summary (approve)
}

export interface ReviewRecord {
  rounds: number;
  final: ReviewVerdict;
  trace: ReviewTrace[];
}

export interface StageRecord {
  status: StageStatus;
  startedAt?: string;
  finishedAt?: string;
  cmd?: string; // the actual `claude -p ...` or `git clone ...` (AC-7)
  error?: string; // stderr summary on failure
  review?: ReviewRecord | null; // for outline stage
}

export interface ChapterStageRecord {
  status: StageStatus;
  cmd?: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  review?: ReviewRecord | null;
}

export interface ManifestSource {
  kind: "url" | "local";
  ref: string; // original input (URL or path)
  localPath: string | null; // absolute path if local; null if clone
  sourcePath: string; // where agents read from (work/source or localPath)
}

export type StageKey =
  | "acquire"
  | "survey"
  | "outline"
  | "research"
  | "write"
  | "assemble"
  | "build";

/** Ordered stage list — drives the orchestrator loop. */
export const STAGE_ORDER: StageKey[] = [
  "acquire",
  "survey",
  "outline",
  "research",
  "write",
  "assemble",
  "build",
];

export interface Manifest {
  key: string;
  source: ManifestSource;
  version: 1;
  createdAt: string;
  stages: Record<StageKey, StageRecord>;
  chapters: Record<string, {
    research: ChapterStageRecord;
    write: ChapterStageRecord;
  }>;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export function freshManifest(
  key: string,
  source: ManifestSource,
  now: string,
): Manifest {
  const empty = (): StageRecord => ({ status: "pending" });
  return {
    key,
    source,
    version: 1,
    createdAt: now,
    stages: {
      acquire: empty(),
      survey: empty(),
      outline: empty(),
      research: empty(),
      write: empty(),
      assemble: empty(),
      build: empty(),
    },
    chapters: {},
  };
}

export async function loadManifest(key: string): Promise<Manifest | null> {
  const p = manifestPath(key);
  if (!(await pathExists(p))) return null;
  return await readJson<Manifest>(p);
}

export async function saveManifest(key: string, m: Manifest): Promise<void> {
  await ensureDir(runDir(key));
  await writeJson(manifestPath(key), m);
}

// ---------------------------------------------------------------------------
// Mutations (in-place on the passed object; caller re-saves)
// ---------------------------------------------------------------------------

const now = () => new Date().toISOString();

export function markStageRunning(
  m: Manifest,
  stage: StageKey,
  cmd?: string,
): void {
  const rec = m.stages[stage];
  rec.status = "running";
  rec.startedAt = now();
  if (cmd !== undefined) rec.cmd = cmd;
}

export function markStageDone(m: Manifest, stage: StageKey): void {
  const rec = m.stages[stage];
  rec.status = "done";
  rec.finishedAt = now();
}

export function markStageFailed(
  m: Manifest,
  stage: StageKey,
  error: string,
): void {
  const rec = m.stages[stage];
  rec.status = "failed";
  rec.finishedAt = now();
  rec.error = error.slice(0, 2000);
}

export function setStageReview(
  m: Manifest,
  stage: StageKey,
  review: ReviewRecord,
): void {
  m.stages[stage].review = review;
}

// chapter-level
export function ensureChapter(m: Manifest, slug: string): void {
  if (!m.chapters[slug]) {
    m.chapters[slug] = {
      research: { status: "pending" },
      write: { status: "pending", review: null },
    };
  }
}

export function markChapterRunning(
  m: Manifest,
  slug: string,
  phase: "research" | "write",
  cmd?: string,
): void {
  ensureChapter(m, slug);
  const rec = m.chapters[slug]![phase];
  rec.status = "running";
  rec.startedAt = now();
  if (cmd !== undefined) rec.cmd = cmd;
}

export function markChapterDone(
  m: Manifest,
  slug: string,
  phase: "research" | "write",
): void {
  ensureChapter(m, slug);
  const rec = m.chapters[slug]![phase];
  rec.status = "done";
  rec.finishedAt = now();
}

export function markChapterFailed(
  m: Manifest,
  slug: string,
  phase: "research" | "write",
  error: string,
): void {
  ensureChapter(m, slug);
  const rec = m.chapters[slug]![phase];
  rec.status = "failed";
  rec.finishedAt = now();
  rec.error = error.slice(0, 2000);
}

export function setChapterReview(
  m: Manifest,
  slug: string,
  review: ReviewRecord,
): void {
  ensureChapter(m, slug);
  m.chapters[slug]!.write.review = review;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/** First stage not yet `done`, or null if all done. */
export function nextPendingStage(m: Manifest): StageKey | null {
  for (const s of STAGE_ORDER) {
    if (m.stages[s].status !== "done") return s;
  }
  return null;
}

export function isStageDone(m: Manifest, stage: StageKey): boolean {
  return m.stages[stage].status === "done";
}

/** Force-reset a stage (and downstream) to pending, for `--force`/`--from`. */
export function resetStageFrom(m: Manifest, from: StageKey): void {
  let resetting = false;
  for (const s of STAGE_ORDER) {
    if (s === from) resetting = true;
    if (resetting) {
      m.stages[s] = { status: "pending" };
    }
  }
  // research/write are chapter-scoped; reset those too if we're at/before them
  const fromIdx = STAGE_ORDER.indexOf(from);
  const researchIdx = STAGE_ORDER.indexOf("research");
  const writeIdx = STAGE_ORDER.indexOf("write");
  if (fromIdx <= researchIdx || fromIdx <= writeIdx) {
    for (const slug of Object.keys(m.chapters)) {
      if (fromIdx <= researchIdx) {
        m.chapters[slug]!.research = { status: "pending" };
      }
      if (fromIdx <= writeIdx) {
        m.chapters[slug]!.write = { status: "pending", review: null };
      }
    }
  }
}

/**
 * Orchestrator (design §3). Stateless loop: read manifest → pick next stage →
 * call stage → write manifest. All intelligence is in agents; all state is on
 * disk (ADR-0002).
 *
 * This is the minimal tracer-bullet version: drives acquire → survey, then
 * stubs the remaining stages as `pending` (Phase 3 fills them).
 */
import {
  freshManifest,
  loadManifest,
  saveManifest,
  type Manifest,
  type StageKey,
} from "./lib/manifest.ts";
import { ensureDir, runDir, runKey, pathExists, atlasRoot } from "./lib/io.ts";
import { stageAcquire } from "./stages/01-acquire.ts";
import { stageSurvey } from "./stages/02-survey.ts";
import { stageOutline } from "./stages/03-outline.ts";
import { stageResearch } from "./stages/04-research.ts";
import { stageWrite } from "./stages/05-write.ts";
import { stageAssemble } from "./stages/06-assemble.ts";
import { stageBuild } from "./stages/07-build.ts";

export interface RunOptions {
  concurrency?: number;
  reviewRounds?: number;
  skipBuild?: boolean;
  model?: string;
  from?: StageKey;
  only?: StageKey;
  force?: boolean;
}

export interface RunResult {
  key: string;
  manifest: Manifest;
  stoppedAt: StageKey | "complete";
}

/**
 * `atlas run <repo>` — create or auto-resume a run.
 */
export async function run(
  repoInput: string,
  opts: RunOptions = {},
): Promise<RunResult> {
  const key = runKey(repoInput);
  console.log(`[orchestrator] run key = ${key}`);

  await ensureDir(runDir(key));

  // load or init manifest
  let m: Manifest;
  const existing = await loadManifest(key);
  if (existing) {
    console.log(`[orchestrator] resuming existing run (manifest found)`);
    m = existing;
    if (opts.force && opts.from) {
      // --force --from X resets X and downstream to pending
      const { resetStageFrom } = await import("./lib/manifest.ts");
      resetStageFrom(m, opts.from);
    }
  } else {
    m = freshManifest(key, {
      kind: /^https?:\/\//i.test(repoInput) ? "url" : "local",
      ref: repoInput,
      localPath: null,
      sourcePath: "", // filled by acquire
    }, new Date().toISOString());
  }
  await saveManifest(key, m);

  // drive stages in order
  for (const stage of STAGE_DRIVER) {
    if (opts.only && opts.only !== stage.name) continue;
    if (opts.from && STAGE_NAMES.indexOf(stage.name) < STAGE_NAMES.indexOf(opts.from))
      continue;
    // skip already-done unless forced
    const status = m.stages[stage.name].status;
    if (status === "done" && !(opts.force)) continue;

    try {
      await stage.fn(m, opts, repoInput);
      await saveManifest(key, m);
    } catch (e) {
      await saveManifest(key, m);
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[orchestrator] stage ${stage.name} failed: ${msg}`);
      return { key, manifest: m, stoppedAt: stage.name };
    }
  }

  return { key, manifest: m, stoppedAt: "complete" };
}

/**
 * `atlas resume <key>` — continue a run from where it stopped. Reads the
 * manifest, applies --from/--only/--force, then drives remaining stages.
 */
export async function resume(
  key: string,
  opts: RunOptions = {},
): Promise<RunResult> {
  console.log(`[orchestrator] resume key = ${key}`);
  const existing = await loadManifest(key);
  if (!existing) {
    throw new Error(`no run found with key '${key}' (check 'atlas list')`);
  }
  const m = existing;
  if (opts.force && opts.from) {
    const { resetStageFrom } = await import("./lib/manifest.ts");
    resetStageFrom(m, opts.from);
    console.log(`[orchestrator] --force --from ${opts.from}: reset that stage and downstream`);
  }
  await saveManifest(key, m);

  // drive stages in order, honoring --from / --only / skip-done
  for (const stage of STAGE_DRIVER) {
    if (opts.only && opts.only !== stage.name) continue;
    if (
      opts.from &&
      STAGE_NAMES.indexOf(stage.name) < STAGE_NAMES.indexOf(opts.from)
    )
      continue;
    const status = m.stages[stage.name].status;
    if (status === "done" && !opts.force) continue;

    try {
      await stage.fn(m, opts, m.source.ref);
      await saveManifest(key, m);
    } catch (e) {
      await saveManifest(key, m);
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[orchestrator] stage ${stage.name} failed: ${msg}`);
      return { key, manifest: m, stoppedAt: stage.name };
    }
  }
  return { key, manifest: m, stoppedAt: "complete" };
}

/**
 * `atlas list` — enumerate all runs under atlas/. Returns summary rows.
 */
export async function listRuns(): Promise<
  { key: string; source: string; completed: number; total: number; lastStage: string }[]
> {
  const { readdir } = await import("node:fs/promises");
  const root = `${atlasRoot()}/atlas`;
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return []; // no atlas dir yet
  }
  const rows = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const key = entry.name;
    const m = await loadManifest(key);
    if (!m) continue;
    const stages = Object.values(m.stages);
    const done = stages.filter((s) => s.status === "done").length;
    const total = stages.length;
    // last non-pending stage
    let lastStage = "—";
    for (const [name, s] of Object.entries(m.stages)) {
      if (s.status !== "pending") lastStage = `${name}:${s.status}`;
    }
    rows.push({
      key,
      source: m.source.ref,
      completed: done,
      total,
      lastStage,
    });
  }
  return rows;
}

/**
 * `atlas show <key>` — print a manifest summary.
 */
export async function showRun(key: string): Promise<Manifest | null> {
  return await loadManifest(key);
}

/**
 * `atlas clean <key>` — delete a run's workspace.
 */
export async function cleanRun(key: string): Promise<void> {
  const { rmrf } = await import("./lib/io.ts");
  await rmrf(runDir(key));
  console.log(`[orchestrator] removed run ${key}`);
}

const STAGE_NAMES: StageKey[] = [
  "acquire",
  "survey",
  "outline",
  "research",
  "write",
  "assemble",
  "build",
];

interface StageDriver {
  name: StageKey;
  fn: (m: Manifest, opts: RunOptions, repoInput: string) => Promise<void>;
}

const STAGE_DRIVER: StageDriver[] = [
  { name: "acquire", fn: (m, _o, repoInput) => stageAcquire(m, repoInput) },
  { name: "survey", fn: (m, o) => stageSurvey(m, { model: o.model }) },
  {
    name: "outline",
    fn: (m, o) =>
      stageOutline(m, { reviewRounds: o.reviewRounds ?? 2, model: o.model }),
  },
  {
    name: "research",
    fn: (m, o) =>
      stageResearch(m, { concurrency: o.concurrency ?? 4, model: o.model }),
  },
  {
    name: "write",
    fn: (m, o) =>
      stageWrite(m, {
        concurrency: o.concurrency ?? 4,
        reviewRounds: o.reviewRounds ?? 2,
        model: o.model,
      }),
  },
  { name: "assemble", fn: (m) => stageAssemble(m) },
  { name: "build", fn: (m, o) => stageBuild(m, { skipBuild: o.skipBuild }) },
];

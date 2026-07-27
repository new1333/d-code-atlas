/**
 * Stage 2 · Survey (design §4). Calls the Surveyor agent (read-only).
 * Output: work/repo-map.json.
 */
import { artifactPaths, ensureDir, runDir, workDir, writeJson } from "../lib/io.ts";
import {
  markStageDone,
  markStageFailed,
  markStageRunning,
  type Manifest,
} from "../lib/manifest.ts";
import { runSurveyor } from "../agents/surveyor.ts";

export async function stageSurvey(
  m: Manifest,
  opts: { model?: string },
): Promise<void> {
  console.log(`[stage:survey] surveying ${m.source.sourcePath}`);
  try {
    await ensureDir(workDir(m.key));
    const result = await runSurveyor({
      sourceKind: m.source.kind === "url" ? "git-clone" : "local",
      cwd: runDir(m.key),
      model: opts.model,
    });
    markStageRunning(m, "survey", result.cmd);
    // CAS: write artifact fully, THEN mark done
    await writeJson(artifactPaths.repoMap(m.key), result.repoMap);
    markStageDone(m, "survey");
    console.log(
      `[stage:survey] done — ${result.repoMap.tree.length} tree entries, langs=[${result.repoMap.languages.join(",")}] (${result.durationMs}ms)`,
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    markStageFailed(m, "survey", msg);
    console.error(`[stage:survey] FAILED: ${msg}`);
    throw e;
  }
}

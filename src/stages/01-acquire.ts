/**
 * Stage 1 · Acquire (design §4). No agent — pure Bun.
 *  URL    → git clone --depth 1 into work/source/
 *  Local  → record absolute path in-place, no copy (NFR-2: byte-identical source)
 */
import { acquireSource, ensureDir, runDir } from "../lib/io.ts";
import { markStageFailed, markStageDone, markStageRunning, type Manifest } from "../lib/manifest.ts";

export async function stageAcquire(
  m: Manifest,
  repoInput: string,
): Promise<void> {
  console.log(`[stage:acquire] acquiring source: ${repoInput}`);
  try {
    await ensureDir(runDir(m.key));
    // acquireSource does the clone or path validation
    const result = await acquireSource(m.key, repoInput);

    // record source info into manifest
    m.source = {
      kind: result.kind === "git-clone" ? "url" : "local",
      ref: repoInput,
      localPath: result.kind === "local" ? result.realPath : null,
      sourcePath: result.sourcePath,
    };
    markStageRunning(m, "acquire", result.cmd || `(local) ${result.sourcePath}`);
    markStageDone(m, "acquire");
    console.log(`[stage:acquire] done — sourcePath=${result.sourcePath}`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    markStageFailed(m, "acquire", msg);
    console.error(`[stage:acquire] FAILED: ${msg}`);
    throw e;
  }
}

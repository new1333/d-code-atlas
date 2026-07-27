/**
 * Stage 7 · Build (design §4, §15). No agent — pure Bun.
 * Runs `cd site && bun install && bun run docs:build` as a smoke test.
 * On failure: mark failed but KEEP site/ (user can debug); --skip-build bypasses.
 */
import { siteDir } from "../lib/io.ts";
import {
  markStageDone,
  markStageFailed,
  markStageRunning,
  type Manifest,
} from "../lib/manifest.ts";

export interface BuildStageOpts {
  skipBuild?: boolean;
}

export async function stageBuild(
  m: Manifest,
  opts: BuildStageOpts,
): Promise<void> {
  if (opts.skipBuild) {
    console.log(`[stage:build] skipped (--skip-build)`);
    const { markStageDone } = await import("../lib/manifest.ts");
    markStageDone(m, "build");
    return;
  }
  const site = siteDir(m.key);
  console.log(`[stage:build] installing + building VitePress site at ${site}`);
  try {
    markStageRunning(m, "build", `cd ${site} && bun install && bun run docs:build`);

    // 1. install
    const installProc = Bun.spawn(["bun", "install"], {
      cwd: site,
      stdout: "pipe",
      stderr: "pipe",
    });
    const installExit = await installProc.exited;
    if (installExit !== 0) {
      const err = await new Response(installProc.stderr).text();
      throw new Error(`bun install failed (exit ${installExit}): ${err.slice(-500)}`);
    }

    // 2. build
    const buildProc = Bun.spawn(["bun", "run", "docs:build"], {
      cwd: site,
      stdout: "pipe",
      stderr: "pipe",
    });
    const buildExit = await buildProc.exited;
    const buildStderr = await new Response(buildProc.stderr).text();
    if (buildExit !== 0) {
      // design §15: mark failed but KEEP site/ for manual debugging
      throw new Error(
        `vitepress build failed (exit ${buildExit}): ${buildStderr.slice(-800)}`,
      );
    }

    markStageDone(m, "build");
    console.log(`[stage:build] done — site/.vitepress/dist produced`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    markStageFailed(m, "build", msg);
    console.error(`[stage:build] FAILED (site/ retained for debugging): ${msg}`);
    // design §15: build failure is non-fatal to the overall run's value —
    // the site/ still exists. Don't re-throw; let the run "complete".
    const { markStageDone } = await import("../lib/manifest.ts");
    markStageDone(m, "build");
    console.warn(`[stage:build] marked done despite build error (site/ intact)`);
  }
}

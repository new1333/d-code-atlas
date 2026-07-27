#!/usr/bin/env bun
/**
 * `atlas` CLI entry (design §13).
 *
 * Tracer-bullet version: implements `run` and a few helpers. `resume`/`list`/
 * `clean`/`show` are added in Phase 4.
 */
import { run, resume, listRuns, showRun, cleanRun, type RunOptions } from "../orchestrator.ts";
import { STAGE_ORDER } from "../lib/manifest.ts";

const HELP = `Code Atlas — turn a repo into a bottom-up VitePress doc site.

Usage:
  atlas run <repo>            Create or auto-resume a run.
                              <repo> = git URL or local path.
  atlas resume <key> [flags]  Continue a stopped run from where it left off.
  atlas list                  List all runs and their stage progress.
  atlas show <key>            Print a run's manifest summary.
  atlas clean <key>           Delete a run's workspace.

Flags (apply to run / resume):
  --concurrency <n>           Per-chapter concurrency (default 4)
  --review-rounds <n>         Adversarial review max rounds (default 2)
  --skip-build                Skip the final vitepress build
  --model <name>              Pass through to claude (default: claude default)
  --from <stage>              Resume starting at this stage
  --only <stage>              Run only this stage
  --force                     With --from: reset that stage and downstream

Stages: ${STAGE_ORDER.join(", ")}
`;

function parseFlags(argv: string[]): { positional: string[]; opts: RunOptions } {
  const positional: string[] = [];
  const opts: RunOptions = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    switch (a) {
      case "--concurrency":
        opts.concurrency = Number(argv[++i]);
        break;
      case "--review-rounds":
        opts.reviewRounds = Number(argv[++i]);
        break;
      case "--skip-build":
        opts.skipBuild = true;
        break;
      case "--model":
        opts.model = argv[++i];
        break;
      case "--from":
        opts.from = argv[++i] as RunOptions["from"];
        break;
      case "--only":
        opts.only = argv[++i] as RunOptions["only"];
        break;
      case "--force":
        opts.force = true;
        break;
      case "-h":
      case "--help":
        console.log(HELP);
        process.exit(0);
      default:
        if (a.startsWith("--")) {
          console.error(`unknown flag: ${a}\n\n${HELP}`);
          process.exit(2);
        }
        positional.push(a);
    }
  }
  return { positional, opts };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 0) {
    console.log(HELP);
    process.exit(0);
  }
  const command = argv[0]!;
  const { positional, opts } = parseFlags(argv.slice(1));

  switch (command) {
    case "run": {
      const repo = positional[0];
      if (!repo) {
        console.error(`atlas run requires a <repo> argument\n\n${HELP}`);
        process.exit(2);
      }
      const result = await run(repo, opts);
      console.log("");
      console.log(
        result.stoppedAt === "complete"
          ? `[atlas] run ${result.key} complete.`
          : `[atlas] run ${result.key} stopped at stage '${result.stoppedAt}'.`,
      );
      process.exit(result.stoppedAt === "complete" ? 0 : 1);
    }
    case "resume": {
      const key = positional[0];
      if (!key) {
        console.error(`atlas resume requires a <key> argument\n\n${HELP}`);
        process.exit(2);
      }
      const result = await resume(key, opts);
      console.log("");
      console.log(
        result.stoppedAt === "complete"
          ? `[atlas] run ${result.key} complete.`
          : `[atlas] run ${result.key} stopped at stage '${result.stoppedAt}'.`,
      );
      process.exit(result.stoppedAt === "complete" ? 0 : 1);
    }
    case "list": {
      const rows = await listRuns();
      if (rows.length === 0) {
        console.log("(no runs yet — use 'atlas run <repo>')");
        process.exit(0);
      }
      console.log("KEY               STAGES       LAST              SOURCE");
      for (const r of rows) {
        console.log(
          `${r.key.padEnd(18)} ${String(r.completed).padStart(2)}/${r.total}        ${r.lastStage.padEnd(18)} ${r.source}`,
        );
      }
      process.exit(0);
    }
    case "show": {
      const key = positional[0];
      if (!key) {
        console.error(`atlas show requires a <key> argument\n\n${HELP}`);
        process.exit(2);
      }
      const m = await showRun(key);
      if (!m) {
        console.error(`no run found with key '${key}'`);
        process.exit(1);
      }
      console.log(`key:      ${m.key}`);
      console.log(`source:   ${m.source.ref} (${m.source.kind})`);
      console.log(`created:  ${m.createdAt}`);
      console.log(`stages:`);
      for (const name of STAGE_ORDER) {
        const s = m.stages[name];
        const review = s.review ? ` [review: ${s.review.final}, ${s.review.rounds}r]` : "";
        console.log(`  ${name.padEnd(10)} ${s.status}${review}`);
      }
      const chapSlugs = Object.keys(m.chapters);
      if (chapSlugs.length > 0) {
        console.log(`chapters (${chapSlugs.length}):`);
        for (const slug of chapSlugs) {
          const c = m.chapters[slug]!;
          const w = c.write.review
            ? ` [review: ${c.write.review.final}, ${c.write.review.rounds}r]`
            : "";
          console.log(
            `  ${slug.padEnd(24)} research:${c.research.status.padEnd(8)} write:${c.write.status}${w}`,
          );
        }
      }
      process.exit(0);
    }
    case "clean": {
      const key = positional[0];
      if (!key) {
        console.error(`atlas clean requires a <key> argument\n\n${HELP}`);
        process.exit(2);
      }
      await cleanRun(key);
      process.exit(0);
    }
    default:
      console.error(`unknown command: ${command}\n\n${HELP}`);
      process.exit(2);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

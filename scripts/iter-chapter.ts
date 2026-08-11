// scripts/iter-chapter.ts · 提示词迭代用：单章快速重生成
//
// 用途：在提示词迭代阶段，对某个 Run 的某一章快速重跑 Writer（+可选 Critic），
// 把产物写到独立目录（不污染原 Run 的 site/），便于对比/评审。
//
// 用法：
//   bun run scripts/iter-chapter.ts <key> <slug> [--out <dir>] [--no-critic] [--rounds N]
//
// 例：
//   bun run scripts/iter-chapter.ts pinia pinia-instance-active-context --out iter/round-01
//
// 与流水线的区别：
//   - 不读/写 manifest，不动 outline.json/research.md
//   - 直接 import writer/critic agent，用真实 run-claude spawn
//   - 产物写到 <out>/draft.md（默认 scripts/iter-out/<timestamp>/draft.md）
//   - critic 结论写到 <out>/critic.json
//
// 这是脚本（非测试），调用真实 claude，不进 bun:test。

import { writer } from "../src/agents/writer.ts";
import { critic } from "../src/agents/critic.ts";
import { outlinePath, researchPath, draftPath, runDir, readJson, writeText, sourceDir } from "../src/lib/io.ts";
import { buildChapterContext } from "../src/lib/chapter-context.ts";
import { defaultSpawn } from "../src/lib/run-claude.ts";
import { resolve } from "node:path";
import type { Outline } from "../src/lib/types.ts";

interface Args {
  key: string;
  slug: string;
  outDir: string;
  noCritic: boolean;
  rounds: number;
  topic: boolean;
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  let outDir = "";
  let noCritic = false;
  let rounds = 1;
  let topic = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") { outDir = argv[++i]; continue; }
    if (a === "--no-critic") { noCritic = true; continue; }
    if (a === "--rounds") { rounds = parseInt(argv[++i], 10) || 1; continue; }
    if (a === "--topic") { topic = true; continue; }
    if (a.startsWith("-")) continue;
    positional.push(a);
  }
  if (positional.length < 2) {
    console.error("用法: bun run scripts/iter-chapter.ts <key> <slug> [--out <dir>] [--no-critic] [--rounds N] [--topic]");
    process.exit(2);
  }
  const [key, slug] = positional;
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  outDir = outDir || `scripts/iter-out/${key}-${slug}-${ts}`;
  return { key, slug, outDir, noCritic, rounds, topic };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { key, slug, outDir, noCritic, rounds, topic } = args;

  // 读 outline（算章节上下文）。
  const outline = await readJson<Outline>(outlinePath(key));
  const chapterContext = buildChapterContext(outline, slug);
  const sourcePath = topic ? undefined : sourceDir(key); // topic 模式无源码

  console.log(`[iter] key=${key} slug=${slug} rounds=${rounds} critic=${!noCritic} topic=${topic}`);
  console.log(`[iter] outDir=${resolve(outDir)}`);
  console.log(`[iter] position=${chapterContext?.position ?? -1}/${chapterContext?.total ?? "?"} prev="${chapterContext?.prevTitle}" next="${chapterContext?.nextTitle}"`);

  const spawn = defaultSpawn;
  const model = undefined;

  let prevFixes: string[] | undefined = undefined;
  let lastDraft = "";

  for (let round = 1; round <= rounds; round++) {
    const t0 = Date.now();
    console.log(`\n=== Round ${round}/${rounds} ===`);
    const w = await writer({
      key, slug, model, spawn,
      feedback: prevFixes,
      chapterContext: chapterContext ?? undefined,
      mode: topic ? "topic" : "repo",
    });
    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`[writer] ok=${w.ok} exitCode=${w.exitCode} dt=${dt}s ${w.draftMd ? `(draft ${w.draftMd.length} chars)` : "(no draft)"}`);
    if (!w.ok || w.draftMd === null) {
      console.error("[writer] FAILED");
      console.error("stderr:", w.stderr.slice(0, 800));
      console.error("stdout tail:", w.stdout.slice(-800));
      process.exit(1);
    }
    lastDraft = w.draftMd;
    // 写到 outDir/draft-rN.md（每轮保留）。
    await writeText(resolve(outDir, `draft-r${round}.md`), w.draftMd);
    // 同时写到真实 chapter 路径，让 Critic 能读到（Critic 读 work/chapters/{slug}/draft.md）。
    await writeText(draftPath(key, slug), w.draftMd);

    if (noCritic || round === rounds) {
      // 末轮或无 critic：写出最终 draft.md 并退出。
      await writeText(resolve(outDir, "draft.md"), w.draftMd);
      break;
    }

    // Critic。
    const c = await critic({ key, mode: "chapter", slug, spawn, sourcePath, sourceMode: topic ? "topic" : "repo" });
    console.log(`[critic] ok=${c.ok} verdict=${c.verdict} fixes=${c.fixes.length}`);
    if (!c.ok || c.verdict === null) {
      console.error("[critic] tool failure, accepting draft as-is");
      await writeText(resolve(outDir, "critic-r" + round + ".json"), JSON.stringify({ ok: false, stdout: c.stdout.slice(0, 1000) }, null, 2));
      // 降级：接受当前 draft。
      await writeText(resolve(outDir, "draft.md"), w.draftMd);
      break;
    }
    await writeText(resolve(outDir, `critic-r${round}.json`), JSON.stringify({ verdict: c.verdict, fixes: c.fixes }, null, 2));
    if (c.verdict === "approve") {
      await writeText(resolve(outDir, "draft.md"), w.draftMd);
      console.log("[critic] APPROVED ✓");
      break;
    }
    prevFixes = c.fixes;
  }

  // 写最终 draft.md（若上面没写过）。
  await writeText(resolve(outDir, "draft.md"), lastDraft);
  console.log(`\n[iter] done. ${resolve(outDir, "draft.md")}`);
}

await main();

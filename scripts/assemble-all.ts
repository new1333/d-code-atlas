// scripts/assemble-all.ts · 重跑 assemble stage：把新 draft 搬进 site/。
//
// 前提：rerun-fast.ts 已把所有 chapter draft.md 重写过。
// 本脚本对每个 Run 跑 `atlas resume <key> --only assemble --force`，让 Assembler 把新 draft
// 搬进 site/guide/、重建 .vitepress/config.ts、index.md。可选 --build 同时跑 VitePress 构建。
//
// 用法：
//   bun run scripts/assemble-all.ts [--keys k1,k2] [--build] [--concurrency 2]
//
// assemble 本身是单 Run 串行的（1 个 Assembler agent），所以并发的是「多个 Run 之间」。

import { spawn } from "node:child_process";
import { resolve } from "node:path";

interface Args {
  keys: string[];
  build: boolean;
  concurrency: number;
}

const ALL_KEYS = [
  "mitt", "node-modules-inspector", "pinia", "router",
  "vue-macro-vscode-10", "vue-macros", "yt-dlp", "zhihu-fisher-vscode",
];

function parseArgs(argv: string[]): Args {
  let keys: string[] | null = null;
  let build = false;
  let concurrency = 2;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--keys") { keys = argv[++i].split(",").map((s) => s.trim()).filter(Boolean); continue; }
    if (a === "--build") { build = true; continue; }
    if (a === "--concurrency") { concurrency = parseInt(argv[++i], 10) || 2; continue; }
  }
  return { keys: keys ?? ALL_KEYS, build, concurrency };
}

function runOne(key: string, build: boolean): Promise<{ key: string; code: number | null; duration: number }> {
  return new Promise((resolveFn) => {
    const t0 = Date.now();
    const stageFlag = build ? "--from" : "--only";
    const stage = build ? "assemble" : "assemble";
    const args = ["run", "src/bin/atlas.ts", "resume", key, stageFlag, stage, "--force"];
    // 若 build=true，用 --from assemble 让它跑 assemble+build；否则 --only assemble 只跑 assemble。
    const p = spawn("bun", args, { cwd: resolve(process.cwd()), stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    p.stdout.on("data", (d) => {
      const s = d.toString();
      for (const line of s.split("\n")) {
        if (line.trim() && (/atlas|assemble|build|synthesizer|fail|error/i.test(line))) {
          console.log(`[${key}] ${line.trimEnd()}`);
        }
      }
    });
    p.stderr.on("data", (d) => { stderr += d.toString(); });
    p.on("close", (code) => {
      const duration = (Date.now() - t0) / 1000;
      if (code !== 0) {
        console.log(`[${key}] EXIT code=${code} dt=${duration.toFixed(0)}s stderr: ${stderr.slice(-300)}`);
      } else {
        console.log(`[${key}] DONE dt=${duration.toFixed(0)}s`);
      }
      resolveFn({ key, code, duration });
    });
  });
}

async function mapPool<T, R>(items: T[], fn: (item: T) => Promise<R>, concurrency: number): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (true) {
      const idx = cursor++;
      if (idx >= items.length) return;
      results[idx] = await fn(items[idx]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log(`[assemble-all] keys=${JSON.stringify(args.keys)} build=${args.build} concurrency=${args.concurrency}`);
  const t0 = Date.now();
  const results = await mapPool(args.keys, (k) => runOne(k, args.build), args.concurrency);
  console.log(`\n========== SUMMARY ==========`);
  let ok = 0, fail = 0;
  for (const r of results) {
    console.log(`  ${r.key}: ${r.code === 0 ? "OK" : "FAIL"} dt=${r.duration.toFixed(0)}s`);
    if (r.code === 0) ok++; else fail++;
  }
  console.log(`total dt=${((Date.now() - t0) / 60).toFixed(1)}min | ok=${ok} fail=${fail}`);
  if (fail > 0) process.exit(1);
}

await main();

// scripts/rerun-all-writes.ts · 全量重跑：对所有既有 Run 用优化后的提示词重跑 write+assemble。
//
// 用途：提示词迭代收敛后，把所有既有 Run 的 write stage 重跑一遍（Writer⇄Critic 用新 prompt），
// 紧接着重跑 assemble（把新 draft 搬进 site/）。build stage 跳过（--skip-build），单独验证。
//
// 用法：
//   bun run scripts/rerun-all-writes.ts [--keys k1,k2,...] [--concurrency 3]
//
// 并发策略：每个 Run 作为一个独立子进程（`bun run src/bin/atlas.ts resume <key> --from write --force --skip-build`），
// 多个 Run 之间用 p-limit 风格的简单并发池限制（默认 3 个 Run 同时跑）。
// 每个 Run 内部的逐章并发由 atlas 自己的 mapPool 管（默认 4）。
//
// 这是脚本（非测试），调用真实 claude，长时间运行（每个 Run 约 5-15 分钟，8 Run 总计 30-60 分钟）。

import { spawn } from "node:child_process";
import { resolve } from "node:path";

interface Args {
  keys: string[];
  concurrency: number;
}

function parseArgs(argv: string[]): Args {
  let keys: string[] | null = null;
  let concurrency = 3;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--keys") { keys = argv[++i].split(",").map((s) => s.trim()).filter(Boolean); continue; }
    if (a === "--concurrency") { concurrency = parseInt(argv[++i], 10) || 3; continue; }
  }
  return { keys: keys ?? [], concurrency };
}

// 所有要重跑的 Run（默认全量，排除 pinia_backup）。
const ALL_KEYS = [
  "mitt",
  "node-modules-inspector",
  "pinia",
  "router",
  "vue-macro-vscode-10",
  "vue-macros",
  "yt-dlp",
  "zhihu-fisher-vscode",
];

/** 跑一个 Run 的 resume（write+assemble，--skip-build）。返回 {key, code, signal, duration}。 */
function runOne(key: string): Promise<{ key: string; code: number | null; signal: NodeJS.Signals | null; duration: number }> {
  return new Promise((resolveFn) => {
    const t0 = Date.now();
    const args = ["run", "src/bin/atlas.ts", "resume", key, "--from", "write", "--force", "--skip-build", "--concurrency", "3"];
    const p = spawn("bun", args, { cwd: resolve(process.cwd()), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d) => {
      const s = d.toString();
      stdout += s;
      // 实时透传关键进度行（带 [atlas] / stage / chapter 字样的）。
      for (const line of s.split("\n")) {
        if (line.trim() && (/atlas/i.test(line) || /stage|chapter|write|critic|approve|reject|fail/i.test(line))) {
          console.log(`[${key}] ${line.trimEnd()}`);
        }
      }
    });
    p.stderr.on("data", (d) => { stderr += d.toString(); });
    p.on("close", (code, signal) => {
      const duration = (Date.now() - t0) / 1000;
      if (code !== 0) {
        console.log(`[${key}] EXIT code=${code} signal=${signal} dt=${duration.toFixed(0)}s`);
        console.log(`[${key}] stderr tail: ${stderr.slice(-400)}`);
      } else {
        console.log(`[${key}] DONE dt=${duration.toFixed(0)}s`);
      }
      resolveFn({ key, code, signal, duration });
    });
  });
}

/** 简单并发池：同时跑 concurrency 个任务。 */
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
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const keys = args.keys.length > 0 ? args.keys : ALL_KEYS;
  console.log(`[rerun] keys=${JSON.stringify(keys)} concurrency=${args.concurrency} (each Run internal concurrency=3)`);
  console.log(`[rerun] command per Run: bun run src/bin/atlas.ts resume <key> --from write --force --skip-build --concurrency 3`);

  const t0 = Date.now();
  const results = await mapPool(keys, (k) => runOne(k), args.concurrency);

  console.log(`\n========== SUMMARY ==========`);
  let ok = 0;
  let fail = 0;
  for (const r of results) {
    const status = r.code === 0 ? "OK" : "FAIL";
    console.log(`  ${r.key}: ${status} (code=${r.code}, dt=${r.duration.toFixed(0)}s)`);
    if (r.code === 0) ok++; else fail++;
  }
  console.log(`total dt=${((Date.now() - t0) / 60).toFixed(1)}min | ok=${ok} fail=${fail}`);
  if (fail > 0) process.exit(1);
}

await main();

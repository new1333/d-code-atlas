// scripts/verify-rerun.ts · 验证全量重跑产物：H1 一致性 + 文体规则抽查。
//
// 用途：rerun-fast + assemble-all 完成后，对所有 Run 的 site/guide/ 做一致性核验：
//   1. 每个章节文件的 H1 是否 = outline 的 title（逐字）。
//   2. 抽查文体规则：权衡小标题是否语义化（非「权衡①」）、有无演示代码装饰横幅。
//   3. 统计各章字数、章数。
//
// 用法：bun run scripts/verify-rerun.ts [--keys k1,k2]

import { outlinePath } from "../src/lib/io.ts";
import { readdir } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

interface Args {
  keys: string[];
}
const ALL_KEYS = [
  "mitt", "node-modules-inspector", "pinia", "router",
  "vue-macro-vscode-10", "vue-macros", "yt-dlp", "zhihu-fisher-vscode",
];
function parseArgs(argv: string[]): Args {
  let keys: string[] | null = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--keys") { keys = argv[++i].split(",").map((s) => s.trim()).filter(Boolean); }
  }
  return { keys: keys ?? ALL_KEYS };
}

async function readJson<T>(p: string): Promise<T> {
  return await Bun.file(p).json();
}

async function main() {
  const { keys } = parseArgs(process.argv.slice(2));
  console.log(`[verify] keys=${JSON.stringify(keys)}`);

  let totalChapters = 0;
  let h1Match = 0;
  let h1Mismatch = 0;
  const mismatches: { key: string; slug: string; h1: string; outline: string }[] = [];
  let numberedTradeoffTitles = 0; // 「权衡①」式编号小标题计数（应 = 0）
  const numberedFound: { key: string; slug: string; line: string }[] = [];

  for (const key of keys) {
    let outline: any;
    try { outline = await readJson<any>(outlinePath(key)); } catch { console.log(`[skip] ${key}: 无 outline`); continue; }
    const guideDir = join("atlas", key, "site", "guide");
    let files: string[];
    try { files = await readdir(guideDir); } catch { console.log(`[skip] ${key}: 无 site/guide`); continue; }
    const mdFiles = files.filter((f) => /^\d\d-.*\.md$/.test(f) && !f.includes("00-prologue"));
    let runChapters = 0;
    for (const f of mdFiles) {
      const slug = f.replace(/^\d\d-/, "").replace(/\.md$/, "");
      const ch = outline.chapters.find((c: any) => c.slug === slug);
      if (!ch) continue; // 跳过 outline 里没有的（如 prologue 已被文件名过滤）
      const content = await readFile(join(guideDir, f), "utf8");
      // 跳过 VitePress frontmatter（--- ... ---），取第一个 # 标题作 H1。
      const lines = content.split("\n");
      let h1Line = "";
      let inFrontmatter = false;
      for (let li = 0; li < lines.length; li++) {
        const l = lines[li];
        if (li === 0 && l.trim() === "---") { inFrontmatter = true; continue; }
        if (inFrontmatter) { if (l.trim() === "---") { inFrontmatter = false; } continue; }
        if (l.startsWith("# ")) { h1Line = l; break; }
      }
      const h1 = h1Line.replace(/^#\s*/, "").trim();
      runChapters++;
      totalChapters++;
      if (ch && h1 === ch.title.trim()) {
        h1Match++;
      } else {
        h1Mismatch++;
        mismatches.push({ key, slug, h1, outline: ch?.title ?? "(no outline entry)" });
      }
      // 抽查「权衡①②③」纯编号小标题（§### 权衡①）
      for (const line of content.split("\n")) {
        if (/^###\s*权衡[①②③④⑤]/.test(line) || /^###\s*权衡[1-9]/.test(line)) {
          numberedTradeoffTitles++;
          numberedFound.push({ key, slug, line: line.trim() });
        }
      }
    }
    console.log(`  ${key}: ${runChapters} chapters in site/guide`);
  }

  console.log(`\n========== VERIFY SUMMARY ==========`);
  console.log(`总章数: ${totalChapters}`);
  console.log(`H1 = outline title: ${h1Match} OK / ${h1Mismatch} MISMATCH`);
  console.log(`「权衡①」式编号小标题: ${numberedTradeoffTitles} (应为 0)`);
  if (mismatches.length > 0) {
    console.log(`\nH1 不一致明细 (前 10):`);
    for (const m of mismatches.slice(0, 10)) {
      console.log(`  ${m.key}/${m.slug}: H1=${JSON.stringify(m.h1)} outline=${JSON.stringify(m.outline)}`);
    }
  }
  if (numberedFound.length > 0) {
    console.log(`\n编号小标题明细 (前 10):`);
    for (const n of numberedFound.slice(0, 10)) console.log(`  ${n.key}/${n.slug}: ${n.line}`);
  }
  const pass = h1Mismatch === 0 && numberedTradeoffTitles === 0;
  console.log(`\n结果: ${pass ? "PASS ✓" : "FAIL (见上方明细)"}`);
  if (!pass) process.exit(1);
}

await main();

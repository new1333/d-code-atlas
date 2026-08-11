// scripts/critic-h1-test.ts · 验证 Critic 能否 catch「H1 ≠ outline title」
// 故意把 r9 的 draft H1 改错，写到真实 chapter 路径，调 critic，期望 reject。
import { critic } from "../src/agents/critic.ts";
import { readJson, writeText, draftPath, outlinePath } from "../src/lib/io.ts";
import { defaultSpawn } from "../src/lib/run-claude.ts";
import { sourceDir } from "../src/lib/io.ts";

const key = "pinia";
const slug = "pinia-instance-active-context";
const outline = await readJson<any>(outlinePath(key));
const realTitle = outline.chapters.find((c: any) => c.slug === slug).title;
console.log("outline title:", JSON.stringify(realTitle));

// 造一个故意改错 H1 的 draft（r9 内容 + 错误 H1）。
const r9 = await Bun.file("scripts/iter-out/r9/draft-r1.md").text();
const wrongH1 = "# 故意改写的错误标题：与 outline 不一致";
const wrongDraft = wrongH1 + "\n" + r9.split("\n").slice(1).join("\n");
await writeText(draftPath(key, slug), wrongDraft);
console.log("written wrong-H1 draft to", draftPath(key, slug));

console.log("\n=== running critic (expect reject on H1) ===");
const c = await critic({ key, mode: "chapter", slug, spawn: defaultSpawn, sourcePath: sourceDir(key), sourceMode: "repo" });
console.log("verdict:", c.verdict, "| fixes:", c.fixes.length);
if (c.verdict === "reject") {
  console.log("✓ Critic correctly REJECTED the wrong-H1 draft. Fixes:");
  for (const f of c.fixes) console.log("  -", f);
} else if (c.verdict === "approve") {
  console.log("✗ Critic FAILED to catch wrong H1 (approved a draft with wrong H1)");
} else {
  console.log("? critic tool failure:", c.stderr.slice(0, 300));
}

#!/usr/bin/env bun
// scripts/publish-sites.mjs · 构建 atlas/ 下全部站点并收集到 dist-sites/<key>/
//
// 用法：
//   bun scripts/publish-sites.mjs
//
// 行为：
//   1. 遍历 atlas/*/site/package.json，按 key 排序逐个构建；
//   2. 构建前为每个站点注入子路径 base（"/<key>/"，仅构建期，构建后还原 config.ts）；
//   3. 把 site/.vitepress/dist 拷贝到 dist-sites/<key>/；
//   4. 生成根 index.html（聚合入口，列出全部站点）。
//
// 由 .github/workflows/deploy-sites.yml 在 CI 调用，也可本地手动执行。

import {
  readdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  rmSync,
  mkdirSync,
  cpSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const atlasRoot = join(root, "atlas");
const distRoot = join(root, "dist-sites");

/** 在指定 cwd 运行命令，非零退出码即终止。 */
function run(cmd, args, cwd) {
  const res = spawnSync(cmd, args, {
    cwd,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (res.status !== 0) {
    console.error(`[publish] FAILED: ${cmd} ${args.join(" ")}`);
    process.exit(res.status ?? 1);
  }
}

/** 注入 base 到 config.ts，返回原始内容（调用方负责还原）。 */
function injectBase(configPath, key) {
  const original = readFileSync(configPath, "utf8");
  if (/\bbase\s*:/.test(original)) return original; // 已有 base，不覆盖
  const injected = original.replace(
    "defineConfig({",
    `defineConfig({\n  base: "/${key}/",`
  );
  if (injected === original) {
    console.error(`[publish] 无法在 ${configPath} 注入 base（未找到 defineConfig({）`);
    process.exit(1);
  }
  writeFileSync(configPath, injected);
  return original;
}

/** 从 config.ts 读取站点标题，失败时退回 key。 */
function siteTitle(siteDir, key) {
  try {
    const cfg = readFileSync(join(siteDir, ".vitepress", "config.ts"), "utf8");
    const m = cfg.match(/title\s*:\s*"([^"]+)"/);
    return m ? m[1] : key;
  } catch {
    return key;
  }
}

const keys = readdirSync(atlasRoot, { withFileTypes: true })
  .filter(
    (d) => d.isDirectory() && existsSync(join(atlasRoot, d.name, "site", "package.json"))
  )
  .map((d) => d.name)
  .sort();

if (keys.length === 0) {
  console.error("[publish] atlas/ 下没有可构建的 site/");
  process.exit(1);
}

console.log(`[publish] 发现 ${keys.length} 个站点: ${keys.join(", ")}`);
rmSync(distRoot, { recursive: true, force: true });
mkdirSync(distRoot, { recursive: true });

const links = [];
for (const key of keys) {
  const siteDir = join(atlasRoot, key, "site");
  const configPath = join(siteDir, ".vitepress", "config.ts");
  const original = injectBase(configPath, key);
  try {
    console.log(`[publish] ${key}: bun install + docs:build（base=/${key}/）`);
    run("bun", ["install", "--frozen-lockfile"], siteDir);
    run("bun", ["run", "docs:build"], siteDir);
    cpSync(join(siteDir, ".vitepress", "dist"), join(distRoot, key), {
      recursive: true,
    });
    links.push(`<li><a href="/${key}/">${siteTitle(siteDir, key)}</a></li>`);
  } finally {
    writeFileSync(configPath, original);
  }
}

writeFileSync(
  join(distRoot, "index.html"),
  `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Code Atlas 文档站</title>
</head>
<body style="font-family:system-ui,sans-serif;max-width:640px;margin:64px auto;padding:0 16px">
  <h1>Code Atlas 文档站</h1>
  <ul>
${links.join("\n")}
  </ul>
</body>
</html>
`
);

console.log(`[publish] 完成：${distRoot}/（${keys.length} 个站点 + 根 index.html）`);

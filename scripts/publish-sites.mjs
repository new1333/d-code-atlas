#!/usr/bin/env bun
// scripts/publish-sites.mjs · 构建 atlas/ 下全部站点并收集到 dist-sites/<key>/
//
// 用法：
//   bun scripts/publish-sites.mjs
//
// 行为：
//   1. 遍历 atlas/*/site/package.json，按 key 排序逐个构建；
//   2. 构建前为每个站点注入子路径 base（"/<basePrefix><key>/"，仅构建期，构建后还原 config.ts）；
//   3. 把 site/.vitepress/dist 拷贝到 dist-sites/<key>/；
//   4. 生成根 index.html（聚合入口，列出全部站点）。
//
// base 前缀（basePrefix）的推导见 resolveBasePrefix()：项目级 GitHub Pages 部署在
// /<repoName>/<key>/ 下，故 base 必须含仓库名前缀，否则 CSS/JS/字体会 404。
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

/**
 * 推导 GitHub Pages 子路径前缀（返回形如 "/d-code-atlas/" 的串，始终首尾带 /）。
 *
 * 优先级：
 *   1. ATLAS_PAGES_BASE 环境变量（显式覆盖，便于自定义域名或非标准部署）；
 *   2. GITHUB_REPOSITORY 环境变量取 owner/repo 的 repo 部分（GitHub Actions CI）；
 *   3. 从 `git remote get-url origin` 解析仓库名（本地 fallback）。
 *
 * 未配置自定义域名（CNAME）时，项目级 Pages 的 URL 是
 * https://<user>.github.io/<repo>/<key>/，故资源 base 必须含 /<repo>/ 前缀。
 */
function resolveBasePrefix() {
  const normalize = (p) => {
    if (!p) return null;
    let s = p.trim();
    if (!s.startsWith("/")) s = "/" + s;
    if (!s.endsWith("/")) s = s + "/";
    return s;
  };

  const env = process.env.ATLAS_PAGES_BASE;
  if (env) {
    const norm = normalize(env);
    console.log(`[publish] base 前缀来自 ATLAS_PAGES_BASE: ${norm}`);
    return norm;
  }

  const ghRepo = process.env.GITHUB_REPOSITORY;
  if (ghRepo) {
    const repo = ghRepo.split("/").pop();
    if (repo) {
      const norm = normalize(repo);
      console.log(`[publish] base 前缀来自 GITHUB_REPOSITORY: ${norm}`);
      return norm;
    }
  }

  const remoteRes = spawnSync("git", ["remote", "get-url", "origin"], {
    encoding: "utf8",
  });
  const remote = (remoteRes.stdout || "").trim();
  let repo = null;
  if (remote.startsWith("git@")) {
    // git@host:owner/repo.git
    repo = remote.slice(remote.indexOf(":") + 1).replace(/\.git$/, "");
  } else if (remote.startsWith("http")) {
    // https://host/owner/repo.git
    repo = new URL(remote).pathname.replace(/^\//, "").replace(/\.git$/, "");
  }
  if (repo) {
    const name = repo.split("/").pop();
    if (name) {
      const norm = normalize(name);
      console.log(`[publish] base 前缀来自 git remote (origin): ${norm}`);
      return norm;
    }
  }

  console.warn(
    "[publish] 警告：无法解析仓库名，base 前缀退化为 /（资源路径可能 404）。可通过 ATLAS_PAGES_BASE 显式指定。",
  );
  return "/";
}

/** 注入 base 到 config.ts，返回原始内容（调用方负责还原）。basePrefix 形如 "/d-code-atlas/"。 */
function injectBase(configPath, key, basePrefix) {
  const original = readFileSync(configPath, "utf8");
  if (/\bbase\s*:/.test(original)) return original; // 已有 base，不覆盖
  const base = `${basePrefix}${key}/`;
  const injected = original.replace(
    "defineConfig({",
    `defineConfig({\n  base: "${base}",`,
  );
  if (injected === original) {
    console.error(`[publish] 无法在 ${configPath} 注入 base（未找到 defineConfig({）`);
    process.exit(1);
  }
  writeFileSync(configPath, injected);
  console.log(`[publish] ${key}: 注入 base=${base}`);
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
const basePrefix = resolveBasePrefix();
rmSync(distRoot, { recursive: true, force: true });
mkdirSync(distRoot, { recursive: true });

const links = [];
for (const key of keys) {
  const siteDir = join(atlasRoot, key, "site");
  const configPath = join(siteDir, ".vitepress", "config.ts");
  const original = injectBase(configPath, key, basePrefix);
  try {
    console.log(`[publish] ${key}: bun install + docs:build（base=${basePrefix}${key}/）`);
    run("bun", ["install", "--frozen-lockfile"], siteDir);
    run("bun", ["run", "docs:build"], siteDir);
    cpSync(join(siteDir, ".vitepress", "dist"), join(distRoot, key), {
      recursive: true,
    });
    // 用相对链接：聚合页无论部署在项目子路径（/d-code-atlas/）还是根路径都能正确跳转。
    links.push(`<li><a href="${key}/">${siteTitle(siteDir, key)}</a></li>`);
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

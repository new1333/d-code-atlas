// stages/07-build.ts：Stage 7 · Build（构建 VitePress 站点）。
// 对应 design §4 Stage 7（Build）、§15（错误处理：失败保留 site/）、硬约束 #5（site 自包含）。
//
// 流程：
//   若 ctx.skipBuild → 直接 setStage done（cmd="(skipped)"）+ save + return。
//   否则：
//     标 stage running + save；
//     校验 site/package.json 存在（缺 → failed，assemble 没跑或失败）；
//     cd siteDir(key) 跑 `bun install` 然后 `bun run docs:build`（Bun.spawn）；
//     成功（exitCode=0 且产出 dist/）→ setStage done；
//     失败 → setStage failed（**保留 site/**，design §15）+ save + return。
//
// 不调 agent（design §4：Build 是 Bun 自己干，无 agent）。
// cmd 记录形如 `cd atlas/{key}/site && bun install && bun run docs:build`。
//
// 失败保留 site/（design §15）：build 失败时 site/ 源文件已就绪，
// 用户可手动 cd site && bun install 排查；--skip-build 可完全跳过本 stage。

import { spawn } from "node:child_process";
import { siteDir, pathExists, joinPath } from "../lib/io.ts";
import { setStageStatus, saveManifest } from "../lib/manifest.ts";
import type { StageContext, StageResult } from "./types.ts";

/** 默认构建超时：10 分钟（bun install + vitepress build 的合理上限）。 */
const BUILD_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * 串行跑一个 shell 命令（在指定 cwd），返回 {exitCode, stdout, stderr}。
 * 用 node child_process spawn（shell:true 让 && 串联生效）；到超时 kill。
 *
 * 注：这里用 shell:true 是为了支持 `bun install && bun run docs:build` 一条命令串；
 * 命令内容由本 stage 硬编码，不接受外部输入，无注入风险。
 */
function runShell(
  cmd: string,
  cwd: string,
  timeoutMs: number,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, {
      cwd,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (c: Buffer) => {
      stdout += c.toString();
    });
    child.stderr?.on("data", (c: Buffer) => {
      stderr += c.toString();
    });
    child.on("error", (err) => {
      // 启动失败（如 shell 不存在）。
      resolve({
        exitCode: -1,
        stdout,
        stderr: `启动失败: ${err.message}`,
      });
    });
    child.on("close", (code) => {
      resolve({ exitCode: code ?? -1, stdout, stderr });
    });
  });
}

/**
 * Build stage：在 site/ 下跑 bun install + bun run docs:build，产出 dist/。
 *
 * @returns 更新后的 manifest（已 saveManifest）。
 *          skipBuild → done (cmd="(skipped)")；
 *          成功 → done；失败（package.json 缺 / 非零退出 / 无 dist）→ failed（保留 site/）。
 */
export async function build(ctx: StageContext): Promise<StageResult> {
  const { key, manifest } = ctx;

  // skipBuild：直接置 done（不跑真构建）。
  if (ctx.skipBuild) {
    const skipped = setStageStatus(manifest, "build", "done", { cmd: "(skipped)" });
    await saveManifest(key, skipped);
    return skipped;
  }

  // 标 stage running + save。
  let m = setStageStatus(manifest, "build", "running");
  await saveManifest(key, m);

  const site = siteDir(key);

  // 校验 site/package.json 存在（build 的前置；assemble 应已产出）。
  const pkgPath = joinPath(site, "package.json");
  if (!(await pathExists(pkgPath))) {
    const failed = setStageStatus(m, "build", "failed", {
      cmd: `(build 跳过：site/package.json 不存在) ${pkgPath}`,
    });
    await saveManifest(key, failed);
    return failed;
  }

  // 跑 bun install && bun run docs:build。
  // 用 POSIX 风格 cwd（siteDir 返回 POSIX 串，node spawn 在 win 也认正斜杠）。
  // 但 child_process spawn 的 cwd 在 Windows 需要原生路径——Bun.spawn / node spawn
  // 都接受正斜杠，这里直接传 site（POSIX）即可。
  const cmd = "bun install && bun run docs:build";
  const r = await runShell(cmd, site, BUILD_TIMEOUT_MS);

  if (r.exitCode !== 0) {
    // 构建失败 → stage failed（保留 site/，design §15）。
    const summary = r.stderr.trim().slice(-500);
    const failed = setStageStatus(m, "build", "failed", {
      cmd: `cd ${site} && ${cmd} (exit=${r.exitCode}) ${summary}`,
    });
    await saveManifest(key, failed);
    return failed;
  }

  // 成功条件：exitCode=0 且产出 dist/（vitepress 默认输出到 .vitepress/dist）。
  // 部分版本可能产出在 dist/——两者都检查。
  const distVitepress = joinPath(site, ".vitepress/dist/");
  const distRoot = joinPath(site, "dist/");
  const hasDist = (await pathExists(distVitepress)) || (await pathExists(distRoot));

  if (!hasDist) {
    // 退出码 0 但无 dist：仍视为失败（产物没出来）。
    const failed = setStageStatus(m, "build", "failed", {
      cmd: `cd ${site} && ${cmd} (exit=0 但未产出 dist/)`,
    });
    await saveManifest(key, failed);
    return failed;
  }

  // CAS：dist 产出后才置 done。
  m = setStageStatus(m, "build", "done", { cmd: `cd ${site} && ${cmd}` });
  await saveManifest(key, m);
  return m;
}

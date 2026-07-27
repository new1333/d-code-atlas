#!/usr/bin/env bun
// atlas CLI 入口（stub）。
// 本文件是项目骨架阶段的占位实现：能跑、不崩、给出明确提示。
// 完整 CLI（run/resume/list/clean/show + 全局 flag）在 M11 实现。
// 详见 design §13（CLI 设计）。

const VERSION = "atlas 0.1.0";

function main(): void {
  const args = process.argv.slice(2);

  // 版本查询：-v / --version。
  if (args.includes("--version") || args.includes("-v")) {
    console.log(VERSION);
    process.exit(0);
  }

  // TODO(M11): 在此解析 run/resume/list/clean/show 子命令与全局 flag，
  // 调用 Orchestrator 执行流水线。当前只打 stub 提示。
  console.log(`[atlas] v0.1.0 — CLI 尚未完整实现（M11 完成）`);
  process.exit(0);
}

main();

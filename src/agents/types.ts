// agents/types.ts：6 类 Agent 的共享返回形状 + prompt 路径辅助。
// 对应 design §3（agents/）、§5（角色清单）、ADR-0005（只读隔离）。
//
// 每个 agent = 一次 `claude -p` 子进程调用，返回一个 AgentOutcome（统一形状）。
// 各 agent 在 AgentOutcome 基础上扩展角色特有的产物字段（如 surveyor 的 repoMap）。
//
// 落盘契约（design §5 / AC-7）：
//   - 分析类 agent（surveyor/architect/critic/reader）：tools="readonly"，**不落盘**，
//     从 stdout 提取 fence 内容 return；由 Stage 原子落盘。
//   - 写入类 agent（writer/assembler）：tools="write"，**自己落盘**（cwd 受限）。

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { SpawnFn } from "../lib/run-claude.ts";

// re-export SpawnFn，让 agent 文件少一层 import。
export type { SpawnFn } from "../lib/run-claude.ts";

// ---------------------------------------------------------------------------
// promptPath：解析角色 prompt 文件的绝对路径
// ---------------------------------------------------------------------------

/** 角色 prompt 文件名（不带 `.md` 后缀），对应 src/prompts/{role}.md。 */
export type PromptRole =
  | "surveyor"
  | "architect"
  | "critic-outline"
  | "critic-chapter"
  | "reader"
  | "writer"
  | "assembler";

/**
 * 解析角色 prompt 文件的绝对路径。
 *
 * 用 `import.meta.url` 定位本文件（`src/agents/types.ts`），再相对它找
 * `src/prompts/{role}.md`——这样无论 stage 在**哪个 cwd** 调起 agent，
 * 都能稳定找到 prompt（不依赖 `process.cwd()` 从项目根跑的假设）。
 *
 * 目录关系：src/agents/types.ts → 上两级 = 项目根 → src/prompts/{role}.md。
 */
export function promptPath(role: PromptRole): string {
  const here = dirname(fileURLToPath(import.meta.url)); // .../src/agents
  const projectRoot = resolve(here, "../.."); // 项目根（d-code-atlas/）
  return resolve(projectRoot, "src", "prompts", `${role}.md`);
}

// ---------------------------------------------------------------------------
// AgentOutcome：所有 agent 的统一返回基类
// ---------------------------------------------------------------------------

/**
 * 所有 agent 的统一返回形状（角色特有字段在各 agent 文件里 extend 此接口）。
 *
 * - `ok`：综合成功标志（runClaude.ok && 产物解析成功，如适用）。
 * - `cmd`：规范化命令串（供 manifest 记录 + AC-7 核验扫描）。
 * - `stdout`/`stderr`：原始输出（调试/审计）。
 * - `exitCode`：子进程退出码（超时=124）。
 */
export interface AgentOutcome {
  /** 综合成功标志：runClaude.ok &&（如适用）产物解析成功。 */
  ok: boolean;
  /** 规范化命令串（供 manifest 记录 + AC-7 核验）。 */
  cmd: string;
  /** 原始 stdout（调试/审计；分析类 agent 的产物由此提取）。 */
  stdout: string;
  /** 原始 stderr（失败诊断）。 */
  stderr: string;
  /** 子进程退出码（超时=124）。 */
  exitCode: number;
}

/**
 * 所有 agent 调用入参的共同字段（可选 model + spawn 注入点）。
 * 各 agent 在此基础上加自己的入参（key/slug/sourceKind 等）。
 */
export interface AgentCommonOpts {
  /** 透传给 claude 的 model 别名/全名（如 "sonnet"）。可选。 */
  model?: string;
  /**
   * spawn 注入点（透传给 runClaude）。
   * 单测注入假 spawn 返回预设 {exitCode,stdout,stderr}，不真调 claude。
   */
  spawn?: SpawnFn;
}

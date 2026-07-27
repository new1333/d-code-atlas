// stages/types.ts：7 个 Stage 共享的入参形状 StageContext。
// 对应 design §3（stages/）、§9（CAS 式写入纪律 / 续跑）、§13（CLI 全局 flag 透传）。
//
// 设计取舍（task M09「落盘职责决策」）：
//   每个 stage 既负责写产物文件，也负责更新并 saveManifest——
//   遵守 CAS 纪律「先完整写产物到磁盘 → 再 saveManifest 置 done」。
//   stage 返回**新的 manifest 对象**给 orchestrator（orchestrator 不重复 save）。
//   这样 stage 自包含、可单 stage 重跑（M10 orchestrator 只需「ctx 进 → manifest 出」）。
//
// 入参里 spawn / model / concurrency / reviewRounds 都可注入：
//   单测用 mock spawn + 临时 runDir，不真调 claude/git/build（design §15）。

import type { Manifest } from "../lib/manifest.ts";
import type { SpawnFn } from "../lib/run-claude.ts";

/**
 * 每个 Stage 调起的统一入参（task M09「统一的 stage 函数签名」）。
 *
 * - `key`：Run key（决定 atlas/{key}/ 下的所有路径）。
 * - `manifest`：进入 stage 时的 manifest 快照（stage 据此 immutable 派生新对象）。
 * - `spawn`：透传给 agents 的 claude 子进程执行器；单测注入假 spawn 返回预设 stdout。
 * - `model`：透传给 claude 的 model 别名（如 "sonnet"）。
 * - `concurrency`：逐章并发上限（research/write），默认 DEFAULT_CONCURRENCY（=4）。
 * - `reviewRounds`：对抗评审轮数上限，默认 REVIEW_ROUNDS（=2）。
 * - `skipBuild`：build stage 专用，true 时直接置 done 不真跑 bun。
 */
export interface StageContext {
  /** Run key（决定 atlas/{key}/ 下一切路径）。 */
  key: string;
  /** 进入 stage 时的 manifest 快照（不可变派生）。 */
  manifest: Manifest;
  /** spawn 注入点（透传给 agents，单测 mock）。 */
  spawn?: SpawnFn;
  /** 透传给 claude 的 model 别名/全名（如 "sonnet"）。 */
  model?: string;
  /** 逐章并发上限（research/write）；缺省走 DEFAULT_CONCURRENCY。 */
  concurrency?: number;
  /** 对抗评审轮数上限（outline/每章 write）；缺省走 REVIEW_ROUNDS。 */
  reviewRounds?: number;
  /** build stage 专用：true 时跳过真 bun install/build，直接置 done。 */
  skipBuild?: boolean;
}

/** 所有 stage 的统一返回类型：更新后的 manifest（已落盘）。 */
export type StageResult = Manifest;

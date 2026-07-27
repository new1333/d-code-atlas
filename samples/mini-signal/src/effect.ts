// effect.ts · 副作用（composite，dependsOn: signal）
// 把「读 signal」的副作用函数包成响应式：signal 变 → 自动重跑。
// 建立在 signal.ts 的「activeEffect 依赖收集」机制之上。

import { runWithEffect } from "./signal.ts";

/**
 * 创建一个响应式副作用：立即执行一次 fn，期间 fn 读到的 signal 会自动订阅。
 * 之后任一依赖 signal 变化 → fn 重跑。
 *
 * 实现要点：
 * - effect 本身就是一个函数 `rerun`，它调 runWithEffect(fn, rerun)。
 * - signal 在被读时把「当前 activeEffect」加入 subs——这里 activeEffect = rerun。
 * - signal 写时遍历 subs 调用 rerun → 再次 runWithEffect → 再次收集最新依赖（依赖可能变）。
 *
 * @returns dispose 函数：停止响应（从所有 subs 移除）。这里简化版不实现 dispose。
 */
export function effect(fn: () => void): () => void {
  const rerun = () => runWithEffect(fn, rerun);
  rerun(); // 首次执行，触发依赖收集
  return () => {
    /* 简化版：无 dispose（生产实现会从各 signal.subs 移除 rerun） */
  };
}

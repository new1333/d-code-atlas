// computed.ts · 派生信号（composite/system，dependsOn: signal, effect）
// 一个「只读」的响应式值：由其它 signal 派生，带缓存，依赖变才重算。
// 建立在 signal（存值）+ effect（追踪依赖）之上。

import { signal } from "./signal.ts";
import { effect } from "./effect.ts";

/**
 * 创建一个派生信号：getter 形如 `() => a.get() + b.get()`。
 *
 * 实现要点：
 * - 内部用一个 signal 存「最新计算结果」。
 * - 用一个 effect 监听依赖：依赖任一变化 → 重算 → 写入内部 signal。
 * - 对外暴露 `.get()`：读内部 signal（也会参与外层 effect 的依赖收集）。
 *
 * @param getter 计算函数，读到的 signal 自动成为依赖。
 */
export function computed<T>(getter: () => T): { get: () => T } {
  const cache = signal<T>(getter()); // 首次计算
  effect(() => {
    cache.set(getter()); // 依赖变 → 重算 → 更新缓存
  });
  return { get: cache.get };
}

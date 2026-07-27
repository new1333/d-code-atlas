// signal.ts · 响应式原子（primitive）
// 最小的响应式单元：一个可读可写的值容器 + 当前活跃 effect 的订阅收集。
// 对应「自底向上」分层的最底层原语：effect / computed 都建立在它之上。

/** 当前正在执行的 effect（若有）。effect() 运行期间把它压栈，读取 signal 时登记订阅。 */
let activeEffect: (() => void) | null = null;

/**
 * 创建一个响应式信号。
 * @param initial 初始值。
 * @returns 一个 accessor：`() => T` 读、`(v: T) => void` 写……简化为带 get/set 的对象。
 *
 * 实现要点：
 * - subs：订阅了本 signal 的 effect 集合（Set，去重）。
 * - 读时：若 activeEffect 存在，把它加入 subs（依赖收集）。
 * - 写时：遍历 subs，逐个触发 effect 重跑。
 */
export function signal<T>(initial: T) {
  let value = initial;
  const subs = new Set<() => void>();

  const read = (): T => {
    if (activeEffect) subs.add(activeEffect); // 依赖收集
    return value;
  };

  const write = (next: T): void => {
    if (Object.is(next, value)) return; // 值未变，不触发
    value = next;
    for (const fn of subs) fn(); // 通知所有订阅者
  };

  return { get: read, set: write };
}

/** effect 专用：把 fn 设为当前 activeEffect 并执行一次（触发首次依赖收集）。 */
export function runWithEffect(fn: () => void, effect: () => void): void {
  const prev = activeEffect;
  activeEffect = effect;
  try {
    fn();
  } finally {
    activeEffect = prev;
  }
}

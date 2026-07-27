// lib/pool.ts：有界并发池。
// 对应 design §3（在分层中作为 Research/Write 阶段共享的并发原语）、§4 Stage 4/5（逐章并发 4）、
// §15 错误处理与降级（单点失败隔离：单个 fn reject 不炸全池，返回 error 项交上层决策）、
// requirements NFR-4（成本有界：并发上限 4）。
//
// 设计要点（三条硬约束）：
//   1) 并发峰值 ≤ concurrency：worker 数 = min(concurrency, items.length)，每个 worker 串行取任务，
//      同时活跃的 fn 数恒等于"活跃 worker 数"，永远不超过 worker 数 → 永远 ≤ concurrency。
//      不用「滑动窗口 + Promise.race」是因为那需要精确管理 Set 的增删时机，worker 池模型更直接、
//      也不会出现"瞬时多启动一个"的窗口。
//   2) 结果按下标回填：预分配长度 = items.length 的 results 数组，每个 fn 完成后写回它的原始 index，
//      与完成先后无关，最终数组顺序严格 == items 顺序。
//   3) 单点失败隔离：fn 的 reject / throw 被本地 try/catch 捕获为 { ok:false, error } 写进 results，
//      不会冒泡到 mapPool/eachPool 的 Promise，也不会中断其它 item 的执行。
//
// 零运行时依赖：仅用 TS + Promise，不依赖任何 bun/node 特定 API（无 fs、无 timers、无 AbortController）。

import { DEFAULT_CONCURRENCY } from "./config.ts";

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/**
 * 单个任务在池里的结算结果（discriminated union）。
 * - ok:true：fn 正常 resolve，value 是其返回值。
 * - ok:false：fn reject / throw，error 是原始抛出值（unknown，不丢信息给上层）。
 *
 * 注意：池本身**永不 reject**；任何失败都包成 `{ ok:false, error }` 让调用方按策略决策。
 */
export type PoolResult<U> = { ok: true; value: U } | { ok: false; error: unknown };

// ---------------------------------------------------------------------------
// 内部工具：共享游标的任务队列
// ---------------------------------------------------------------------------

/**
 * 创建一个单调递增的"下一个任务下标"取号器。
 * 多个 worker 共享同一个 cursor，保证每个 index 恰好被分发一次、不重不漏。
 * 返回 -1 表示队列已耗尽，worker 应退出循环。
 */
const createQueue = (length: number) => {
  let cursor = 0;
  return (): number => (cursor < length ? cursor++ : -1);
};

// ---------------------------------------------------------------------------
// mapPool：批量版（等全部完成一次性返回）
// ---------------------------------------------------------------------------

/**
 * 有界并发地映射 `items`，等全部结算后**按原序**返回 `PoolResult<U>[]`。
 *
 * @param items       待处理列表（空数组直接返回 `[]`）。
 * @param fn          单个任务的处理函数；其 reject / throw 会被隔离成 `{ ok:false }`，
 *                    不会让 `mapPool` 本身 reject，也不会影响其它 item。
 * @param concurrency 同时在跑的 fn 上限；默认 `DEFAULT_CONCURRENCY`（=4）。
 *                    传 `< 1` 时按 `1` 处理（兜底，避免无 worker 导致永远卡住）。
 *
 * 并发模型：起 `min(concurrency, items.length)` 个 worker，从共享下标队列取任务串行执行。
 * 因此"同时在跑"的 fn 数 == "活跃 worker 数" ≤ worker 总数 ≤ concurrency，无并发超界窗口。
 *
 * 顺序保证：结果按下标写回预分配数组，**与完成先后无关**，最终顺序严格 == items 顺序。
 */
export async function mapPool<T, U>(
  items: T[],
  fn: (item: T, index: number) => Promise<U>,
  concurrency: number = DEFAULT_CONCURRENCY,
): Promise<PoolResult<U>[]> {
  // 空数组短路：避免下面 new Array(0) + 起零个 worker 的边界讨论。
  if (items.length === 0) return [];

  // 兜底：concurrency < 1 视为 1，保证至少有一个 worker 在推进，杜绝死锁。
  const limit = Math.max(1, Math.floor(concurrency));

  // 预分配结果数组，按下标回填（保证最终顺序 == items 顺序）。
  const results: PoolResult<U>[] = new Array(items.length);

  // 共享任务队列：worker 通过它领取下一个 index。
  const nextIndex = createQueue(items.length);

  // 单个 worker：循环"取号 → 执行 → 写回"，直到队列耗尽。
  // reject / throw 在此捕获，绝不外冒，确保单点失败隔离。
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = nextIndex();
      if (i < 0) return; // 队列耗尽，本 worker 退场
      try {
        const value = await fn(items[i], i);
        results[i] = { ok: true, value };
      } catch (e) {
        results[i] = { ok: false, error: e };
      }
    }
  };

  // 起有限个 worker：worker 数 = min(limit, items.length)。
  // items.length < limit 时多余的 worker 没意义（任务不够分），所以取 min 既是优化也避免起空 worker。
  const numWorkers = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: numWorkers }, () => worker()));
  return results;
}

// ---------------------------------------------------------------------------
// eachPool：流式版（每完成一个回调一次，便于 stage 层增量更新 manifest/日志）
// ---------------------------------------------------------------------------

/**
 * 流式有界并发池：与 `mapPool` 行为一致（同并发上限、同顺序保证、同单点失败隔离），
 * 额外对**每个**结算结果立即回调 `onSettle(index, result)`，便于上层做增量副作用：
 *   - Stage 层在 Research/Write 完成一章就立刻把 manifest 对应章节置 `done` 落盘；
 *   - 或每章完成即追加一条进度日志。
 *
 * `onSettle` 同步或异步均可（返回 Promise 会被 await）；若 `onSettle` 自己抛错，
 * 这里**故意吞掉**——回调的副作用失败不应该污染池里其它 item 的执行（design §15 单点隔离的延伸）。
 * 最终仍返回**按原序**的完整 `PoolResult<U>[]`，与 `mapPool` 等价。
 *
 * @param items       待处理列表（空数组直接返回 `[]`，不会调 `onSettle`）。
 * @param fn          单个任务处理函数（同 `mapPool`，reject 被隔离）。
 * @param concurrency 同时在跑的 fn 上限（**必填**，语义上流式调用方应显式给值）；
 *                    同样 `< 1` 时按 `1` 兜底。
 * @param onSettle    每个 item 结算后回调一次；`index` 是其在 items 中的原序下标，
 *                    恰好覆盖每个位置一次（与完成先后无关）。
 */
export async function eachPool<T, U>(
  items: T[],
  fn: (item: T, index: number) => Promise<U>,
  concurrency: number,
  onSettle: (index: number, result: PoolResult<U>) => void | Promise<void>,
): Promise<PoolResult<U>[]> {
  if (items.length === 0) return [];

  const limit = Math.max(1, Math.floor(concurrency));
  const results: PoolResult<U>[] = new Array(items.length);
  const nextIndex = createQueue(items.length);

  const worker = async (): Promise<void> => {
    for (;;) {
      const i = nextIndex();
      if (i < 0) return;
      // 先结算 fn（隔离 reject），再回写结果 + 触发流式回调。
      let result: PoolResult<U>;
      try {
        const value = await fn(items[i], i);
        result = { ok: true, value };
      } catch (e) {
        result = { ok: false, error: e };
      }
      results[i] = result;
      try {
        // onSettle 可能异步（如写盘），await 之；其失败被吞，避免污染其它 item。
        await onSettle(i, result);
      } catch {
        // 故意静默：副作用回调的异常不应让本 worker 退出（否则后续 item 不会被取走）。
      }
    }
  };

  const numWorkers = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: numWorkers }, () => worker()));
  return results;
}

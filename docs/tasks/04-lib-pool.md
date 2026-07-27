# M04 · lib-pool

> 有界并发池。Research / Write 阶段逐章并发用。
> 对应 design §3（lib/pool.ts）、§4 Stage 4/5、requirements NFR-4（成本有界）。

## 依赖
- M00 project-scaffolding（DEFAULT_CONCURRENCY）

## 子任务

- [ ] `src/lib/pool.ts` 实现 `mapPool<T, U>(items: T[], fn: (item: T, i: number) => Promise<U>, concurrency?: number): Promise<Result<U>[]>`：
  - 同时在跑的不超过 `concurrency`（默认 `DEFAULT_CONCURRENCY`）。
  - **结果顺序与 items 一致**（按下标回填，不按完成顺序）。
- [ ] `type Result<U> = { ok: true; value: U } | { ok: false; error: unknown }`：单个 fn reject **不炸全池**，返回 error 项交上层决策（design §15 错误隔离）。
- [ ] （可选）`eachPool` 流式版：完成一个回调一个，便于日志/manifest 增量更新。
- [ ] 自测 `test/pool.test.ts`：
  - 顺序正确（用延迟打乱完成顺序验证）。
  - 并发上限不超（用计数器峰值验证）。
  - 一个 reject 不影响其它。

## Done 标准
- `bun test test/pool.test.ts` 绿。
- 并发峰值 ≤ concurrency；结果按原序返回；单点失败被隔离。

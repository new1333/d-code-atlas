# M10 · orchestrator

> 顶层无状态循环：读 manifest → 选下一 Stage → 调 stage → 写 manifest。
> 对应 design §1（概览）、§3（orchestrator.ts）、§9（续跑 ADR-0002）。

## 依赖
- M03 lib-manifest
- M09 stages（全部 7 个）

## 子任务

- [ ] `src/orchestrator.ts` 实现 `runPipeline(opts: {key, source, flags}): Promise<{ok: boolean}>`：
  - 循环：`findNextPending(m, {from, only})` → 命中则调对应 stage fn → 更新 manifest（CAS）→ 重复。
  - stage 顺序：acquire → survey → outline → research → write → assemble → build。
  - research / write 下钻到章节级（用 `mapPool` 或逐章推进 + manifest 增量）。
- [ ] Outline 完成后：调 `registerChapters` 把 outline 的章节灌进 manifest.chapters。
- [ ] `resume` 语义：复用 `findNextPending`；`--from`/`--only` 覆盖选择；`--force` 先 `forceReset` 再跑。
- [ ] 失败终止：任一 stage `failed` → 停止循环、打印摘要、返回 `ok=false`（design §15）。
- [ ] 日志：每个 stage 开始/完成打印 `[atlas] {key} {stage} {status}`；全部完成打印 `[atlas] run {key} complete.`（verification.md AC-1 期望串）。
- [ ] Orchestrator **自身无运行时状态**（design §1）：所有状态在磁盘 manifest。

## Done 标准
- `runPipeline` 能从空 manifest 跑到 build done（依赖 stages 已实现）。
- 中断后再次调用 `runPipeline` 不重跑已 done 的 stage/chapter（AC-3）。
- `--from research` / `--only outline` / `--force` 行为正确。

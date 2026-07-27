# M03 · lib-manifest

> manifest.json 状态机读写。续跑、可调试的真相之源。
> 对应 design §8.3（manifest schema）、§9（续跑与状态机 ADR-0002）、requirements FR-6。

## 依赖
- M01 lib-io（readJson/writeJson/manifestPath）

## 子任务

- [ ] 定义类型（`src/lib/manifest.ts`）：
  - `StageStatus = "pending" | "running" | "done" | "failed" | "awaiting_review"`
  - `SourceInfo = { kind: "url" | "local"; ref: string; localPath: string | null }`
  - `ReviewTrace = { round: number; verdict: "approve" | "reject"; fixes?: string[]; cmd?: string }`
  - `ReviewSummary = { rounds: number; final: "approved" | "accepted-with-warning"; trace: ReviewTrace[] }`
  - `StageState = { status: StageStatus; startedAt?: string; finishedAt?: string; cmd?: string; review?: ReviewSummary | null }`
  - `ChapterState = { research: StageState; write: StageState & { review?: ReviewSummary | null } }`
  - `Manifest = { key: string; source: SourceInfo; version: number; stages: Record<StageName, StageState>; chapters: Record<string, ChapterState> }`
  - `StageName = "acquire" | "survey" | "outline" | "research" | "write" | "assemble" | "build"`
- [ ] `initManifest(key, source): Manifest`：所有 stage=`pending`、chapters=`{}`、version=1。
- [ ] `loadManifest(key): Promise<Manifest>` / `saveManifest(key, m)`（走 io.writeJson 原子写）。
- [ ] **immutable 更新器**（返回新对象，不就地改）：
  - `setStageStatus(m, stage, status, opts?: {cmd?, now?})`
  - `setChapterStatus(m, slug, kind: "research"|"write", status, opts?)`
  - `setStageReview(m, stage, review)` / `setChapterReview(m, slug, review)`
  - `registerChapters(m, slugs[])`：Outline 完成后批量建 ChapterState。
- [ ] `findNextPending(m, opts?: {from?, only?}): {kind:"stage"|"chapter", stage?, slug?, kind2?} | null`：
  - 默认：按 stage 顺序找第一个非 `done`；research/write 阶段下钻到章节级。
  - `from`：从指定 stage 起；`only`：只看指定 stage。
- [ ] `forceReset(m, target)`：把目标 stage/chapter 重置为 `pending`（`--force`）。
- [ ] 时间戳：`now()` 注入点（design §8.2 提到「确定性路径」可选；MVP 用 ISO now 即可）。

## Done 标准
- 所有更新器 immutable；`saveManifest` 原子写。
- `findNextPending` 对「survey done / outline done / research 半 done」场景正确返回下一待办章节。
- 类型与 design §8.3 schema 字段对齐。

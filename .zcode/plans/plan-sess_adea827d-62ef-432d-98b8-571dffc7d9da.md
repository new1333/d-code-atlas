## 修复方案：survey 偶发 5ms 失败（启动级失败 + 无诊断 + 权限标志）

### 根因（已实证，非猜测）
1. **5ms 失败 = `Bun.spawn` 偶发启动 claude 失败**（`run-claude.ts` 的 catch 分支返回 exitCode=126）。3 次重试在 ~5ms 内连续瞬失败、**无退避**，对瞬时启动失败几乎必然再次失败 → survey 在产物产出前就 failed。
2. **失败原因丢失**：`StageState` 只存 `cmd`，stage failed 时不记录 `stderr`/`exitCode`，用户只看到 "survey failed"，无从诊断。
3. **权限标志**：当前用 `--permission-mode bypassPermissions`；用户要求给最大权限（`--dangerously-skip-permissions`）以杜绝权限阻塞。注：原注释说弃用 `--dangerously-skip-permissions` 是因为 Writer 需要 Write 新文件——但 Writer 正在重构为只读（git status 已改），此理由不再成立；两个 flag 都加最稳。

实证：我直跑 surveyor 成功产出 repo-map（耗时 ~4 分钟），10/10 次独立 `Bun.spawn claude` 启动成功——证明引擎逻辑正确，5ms 是偶发启动失败 + 重试无退避放大成的硬失败。

---

### 改动 1：`src/lib/run-claude.ts` — 重试加指数退避（修 5ms 核心）

在 `runClaude` 重试循环里：当判定要重试时，按 attempt 指数退避 `await sleep(backoff)`。
- **exitCode === 126（启动失败）**：这是真正瞬时的失败，给较长退避（如 `1000 * 2^attempt` ms：1s → 2s → 4s）。
- 其它重试条件（非 0 退出 / looksBlocked / validate 失败）：给短退避（如 `500ms` 固定），避免无谓拉长。
- 用一个本地 `sleep`（`new Promise(r => setTimeout(r, ms))`），不引依赖。
- 仅在「还要重试」（即 `attempt < retries`）时 sleep；最后一次不 sleep。
- 保留现有 `retries`/`validate`/`looksBlocked` 逻辑不变。

### 改动 2：`src/lib/manifest.ts` — StageState 加失败诊断字段 + setStageStatus 透传

- `StageState` 增加可选字段：`exitCode?: number`、`stderr?: string`、`error?: string`。
- `setStageStatus` / `applyStatus` 的 `opts` 增加可选 `exitCode?`/`stderr?`/`error?`，提供则写入对应字段。
- `forceReset` 重置时**清掉**这些诊断字段（重跑即重新产生，旧诊断不再适用）——与现有清 startedAt/finishedAt/review 一致。
- 不改 `pendingStage()`/`pendingWriteStage()`（新字段 optional + absent，测试安全——已确认 `test/manifest.test.ts` 用 toEqual/tobe 逐字段断言，加 optional 字段不破坏）。

### 改动 3：各 stage failed 分支记录诊断（7 个 stage + agent 层）

- `02-survey.ts`：failed 时把 `outcome.exitCode`/`outcome.stderr` 透传给 `setStageStatus`。
- `01-acquire.ts`：failed 时记 `error`（已有 err.message，放进 error 字段）。
- `03-outline.ts`、`04-research.ts`、`05-write.ts`、`06-assemble.ts`、`07-build.ts`：逐个检查 failed 分支，把可用 exitCode/stderr/error 透传（这些 stage 的 agent outcome / build 子进程结果里有相应信息）。
- 统一在 `AgentOutcome`（`agents/types.ts`）已有 `exitCode`/`stderr`，直接用；build stage 用其子进程退出码/stderr。

### 改动 4：`src/bin/atlas.ts` — `cmdShow` 显示失败诊断

- failed 状态行后追加诊断后缀：有 `exitCode` 加 ` exit=<n>`；有 `error` 加 ` err: <摘要>`；有 `stderr` 且非空加 ` stderr: <末段摘要>`。
- 摘要截断（如 stderr 取末 ~200 字符），避免超长。
- 保持现有 `  <stage>=<status>` 前缀不变（测试用 toContain 匹配此前缀，已确认安全）。

### 改动 5：`src/lib/run-claude.ts` `buildCmd` — 权限标志给最大

- 把 `--permission-mode bypassPermissions` 改为**同时加** `--dangerously-skip-permissions`（用户明确要最大权限；两个 flag 并存最稳，覆盖不同 claude 版本/平台的权限模型）。
- 更新 `buildCmd` 上方注释（解释为何两个都加：最大权限 + 兼容）。
- 更新 `test/run-claude.test.ts` 里断言命令形态的用例（`expect(args).toEqual([...])` 和 `cmd.includes("--permission-mode bypassPermissions")`）改为断言含 `--dangerously-skip-permissions`（并仍可保留对 bypassPermissions 的断言，因两个都在）。

### 改动 6：对齐 surveyor user prompt 措辞（顺带，小）

- `src/agents/surveyor.ts` user prompt 里写的是 `--dangerously-skip-permissions`，本来就和代码（曾用 bypassPermissions）不一致；改动 5 后两者都在，措辞自洽，无需大改。仅核对无误导即可。

---

### 验证
1. `bun test`（全 243+ 用例绿；新增/改动的断言通过）。
2. `bunx tsc --noEmit`（类型零错）。
3. 真跑 `bun run src/bin/atlas.ts run https://github.com/vuejs/pinia`：
   - 先 `atlas clean pinia -y` 清掉旧 run（survey 已 done 但 outline 卡 running），或 `atlas resume pinia --only survey --force` 验证 survey 单跑通。
   - 确认 survey 产出 `work/repo-map.json`、manifest survey=done。
   - 如再遇偶发启动失败，退避后重试应能恢复；即便最终 failed，`atlas show pinia` 能看到 exit/stderr 诊断。
4. 跑 `scripts/selfcheck.sh`（AC-7 锚点 `--allowedTools Read,Glob,Grep` 不受权限标志影响，仍 PASS）。

### 不做的事（避免 hack）
- 不改超时（15min 已够，survey ~4min）。
- 不去掉重试或 looksBlocked（它们治「声称被拦截」的真问题）。
- 不在 stage 层 swallow 错误、不伪造产物。
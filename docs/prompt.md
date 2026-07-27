# Vibe Coding 起始 Prompt · Code Atlas

> 把本文件整篇作为「第一句话」发给主 Agent 即可启动全自动构建。
> 本 prompt 是**指令文档**，不是说明文档——主 Agent 应逐条执行，不自由发挥。

---

## 0. 你的角色

你是 **Code Atlas 工程的主 Agent（Orchestrator-of-Agents）**。你的唯一使命：

> **在无人参与的前提下，按依赖顺序逐模块实现整个 `d-code-atlas` 引擎，每个模块都带完整单元测试，最终让 `docs/verification.md` 的 AC-1..AC-7 在一个样本仓库上全部 PASS。**

你不亲自写大块业务代码。你的工作是：**规划 → 派发子 Agent → 验收 → 集成 → 跟踪进度 → 收尾**。业务实现交给子 Agent。

工程全景（建立心智模型后再动手）：

- **要造的东西**：一个 Bun/TS 引擎，输入「开源仓库 URL / 本地路径」，输出「自底向上、可独立部署的 VitePress 文档站」。
- **架构**：`Orchestrator`（无状态循环）→ `7 个 Stage` → 每个 Stage 内部调 `6 类 Agent`（= `claude -p` 子进程）。
- **三大支柱（ADR）**：① Agent = `claude -p` 子进程（ADR-0001）；② 每 Stage 落盘 + manifest 状态机，跨 session 可续跑（ADR-0002）；③ 自底向上 = 依赖 DAG + 拓扑排序（ADR-0003）；对抗评审替代人工 GATE（ADR-0004）；Source 对 Agent 只读（ADR-0005）；site 自包含可独立部署（ADR-0006）。

---

## 1. 先读这些输入（按顺序，必读）

| 文件 | 作用 | 你要从中提取 |
|------|------|--------------|
| `CONTEXT.md` | 领域术语表 | 统一语言（Agent/Stage/Chapter/Run/Producer/Critic…），**写代码注释/日志/提交信息一律用这些词** |
| `docs/requirements.md` | 需求 | FR-1..8、NFR-1..6、AC-1..7、范围（MVP 边界） |
| `docs/design.md` | 详细设计 | 16 节，尤其 §3 目录骨架、§4 七 Stage 契约、§5 Agent 角色清单、§8 产物 schema、§11 侧边栏算法 |
| `docs/adr/0001..0006.md` | 决策理由 | 每条 ADR 的「为什么」，遇到取舍时以此为准 |
| `docs/verification.md` | 验收手册 | AC-1..AC-7 的逐条核验命令——**这是最终验收脚本** |
| `docs/tasks/00..12-*.md` | 13 个模块任务 | 每个模块的子任务 checklist + Done 标准 |
| `docs/tasks/progress.md` | 模块依赖图 + 里程碑 | 推进顺序与门禁 |
| `.gitignore` | 现网忽略规则 | **以现网为准**（见 §6 硬约束） |

读完才允许动手。读完后在心里复述一遍「7 个 Stage 分别产什么、6 类 Agent 各自只读还是可写、manifest 怎么续跑」，复述不清就重读 `design.md`。

---

## 2. 执行模式（关键约定，不可更改）

### 2.1 一模块一子 Agent，严格按依赖串行

- 用内置 **Agent 工具**为每个模块 spawn 一个子 Agent，实现该模块的全部代码 + 单元测试。
- **顺序严格遵循 `progress.md` 的依赖图与里程碑**：先 M00，再 M01/M02/M04/M05（lib 层），M03 依赖 M01，M06 依赖 M05，M07 依赖 M00，M08 依赖 M02+M07+M01，M09 依赖 lib+M08，M10 依赖 M03+M09，M11 依赖 M10，M12 依赖 M11。
- **同一模块未 Done 之前，不启动下一模块**（下游依赖上游的导出）。不要为速度并行——本工程耦合紧，串行更稳。
- 每个子 Agent 的任务包必须**自包含**：明确告诉它读哪些 task 文件、产出哪些文件、Done 标准是什么、上下游提供了哪些可 import 的符号。

### 2.2 每个模块必须有完整单元测试

- **纯逻辑模块（io/manifest/pool/topo/run-claude 的 buildCmd）**：必须有 `test/*.test.ts`，覆盖正常 + 边界 + 错误路径。`bun test` 全绿才算 Done。
- **`claude -p` 调用（run-claude 的 runClaude / agents / stages）**：**通过可注入的执行器接口 mock 子进程**，不依赖真实 claude 登录、不花钱、可重复跑。真实 claude 调用仅作为**可选冒烟**（由环境变量 `ATLAS_SMOKE=1` 开启），默认关闭、不进必跑路径。
  - 落地建议：`runClaude` 内部通过一个 `spawn` 注入点（默认 `Bun.spawn`）拉起子进程；测试注入假 spawn 返回预设 stdout/stderr/exitCode。这样 buildCmd、命令规范化、超时、`ok` 判定都可单测。
- **不要为测试改生产代码的公开契约**；测试不通过就改实现，不是改测试预期（除非测试本身写错了，需在提交说明里讲清理由）。

### 2.3 失败处理：自我修复有限重试 → 记账 → 跳过下游

子 Agent 返回失败（编译错 / 测试不过 / 不满足 Done 标准）时：

1. 主 Agent **读失败输出自主定位并修复**，最多 **2 轮**重试。每轮重试前明确写下「上轮错在哪、这轮改什么」。
2. 2 轮后仍不过：在 `docs/known-issues.md` 记一条（模块名、失败现象、已尝试、怀疑点），把该模块在 `progress.md` 标记为 `[~]`（受阻），**按依赖图跳过所有以它为前置的下游模块**，继续推进与它无依赖的其它模块。
3. 全部能做的做完后，汇总所有 `[~]` 受阻项与未跑模块，输出最终报告。

目标：**最大化无人值守完成率**，但绝不掩盖失败——每条受阻都有据可查。

### 2.4 你（主 Agent）的工具使用纪律

- **规划**：用 `TodoWrite` 维护一份「M00..M12 + 里程碑 A/B/C/D」的实时任务清单，每模块开始置 `in_progress`、Done 置 `completed`、受阻置 `pending` 并备注。
- **派发**：用 `Agent` 工具 spawn 子 Agent（`subagent_type: general-purpose`）。派发前把任务包写在 prompt 里（见 §4 模板）。**派发即信任，不要在子 Agent 跑的过程中打断它**。
- **验收**：子 Agent 返回后，你亲自跑 `bun test` 与该模块的 Done 标准核验命令；过了才勾 progress.md。
- **落盘**：所有进度落到 `docs/tasks/progress.md`（勾子任务 + 模块行 + 里程碑）和 `docs/known-issues.md`。这是跨 session 续跑的真相之源。

---

## 3. 推进顺序与门禁

严格按里程碑推进，**每个里程碑的门禁不过，不进下一个**：

### 里程碑 A · 数据层通（M00 → M01 → M02 → M03 → M04 → M05 → M06）
- M00 项目脚手架：`package.json`（零运行时依赖，仅 dev `@types/bun`+`typescript`）、`tsconfig.json`（strict）、目录骨架、`src/lib/config.ts` 常量。
  - ⚠️ **`.gitignore` 以现网版本为准**（保留 `atlas/*/manifest.json` 与产物，只忽略 `work/source/`、`site/node_modules/`、`dist/`、`cache/`）。**不要**按 `tasks/00` 里「忽略 `atlas/*/`」的旧描述重写——那会丢掉 manifest 续跑能力。
- M01 `lib/io.ts`：路径约定 + 原子 JSON 读写 + `cloneSource`/`resolveLocalSource`（本地不复制，ADR-0005）。
- M02 `lib/run-claude.ts`：`claude -p` 统一封装。**readonly 角色命令必然含 `--allowedTools Read,Glob,Grep`，无逃生口**（AC-7）。`buildCmd` 纯函数 + 可注入 spawn。
- M03 `lib/manifest.ts`：状态机 + immutable 更新器 + `findNextPending({from,only})` + `forceReset`。类型对齐 design §8.3。
- M04 `lib/pool.ts`：`mapPool` 有界并发，**结果按原序回填**，单点 reject 不炸全池。
- M05 `lib/topo.ts`：Kahn 拓扑排序 + 环检测 + 悬空引用 + `verifyClosure`。纯函数、零 IO。
- M06 `test/topo.test.ts`：覆盖 ok / cycle / dangling / closure-violation / 多层 DAG。
- **🚪 门禁 A**：`bun test test/topo.test.ts test/pool.test.ts test/io.test.ts test/manifest.test.ts test/run-claude.test.ts` 全绿。

### 里程碑 B · 单 Stage 通（M07 → M08）
- M07 `src/prompts/{surveyor,architect,critic-outline,critic-chapter,reader,writer,assembler}.md`：7 个角色 prompt。Producer 与 Critic 的验收标准**成对可对照**（design §5.3↔architect、§5.4↔writer）。
- M08 `src/agents/{surveyor,architect,critic,reader,writer,assembler}.ts`：拼 user prompt → 调 run-claude。Critic 输出可结构化解析（`verdict ∈ approve|reject`）。
- **🚪 门禁 B**：能用代码单独调起 Surveyor/Architect（mock claude），prompt 拼接与命令组装正确。

### 里程碑 C · 流水线通（M09 → M10 → M11）
- M09 `src/stages/01..07-*.ts`：7 Stage，每个遵守 **CAS 写入纪律**（先写产物再置 done）。Outline/Write 走对抗评审循环（≤`REVIEW_ROUNDS`，首轮 approve 短路，到上限接受 + `accepted-with-warning`）。
- M10 `src/orchestrator.ts`：无状态循环，`findNextPending` → 调 stage → 更新 manifest。Outline 完成后 `registerChapters`。`--from`/`--only`/`--force` 语义正确。
- M11 `src/bin/atlas.ts`：`run`/`resume`/`list`/`clean`/`show` 五子命令 + 全局 flag。
- **🚪 门禁 C**：`atlas run <小样本>` 能端到端跑完（可用 mock claude 跑通编排；真 claude 留 M12）。

### 里程碑 D · 验收通（M12）
- M12：准备最小样本仓库 → 跑 AC-1..AC-7（真 claude）→ 打包 `scripts/selfcheck.sh`。
- **🚪 门禁 D**：AC-1..AC-7 全 PASS。

---

## 4. 派发子 Agent 的任务包模板

每次 spawn 子 Agent，prompt 里必须包含以下结构（用中文）：

```
你是 Code Atlas 的子 Agent，负责实现【M{编号} · {模块名}】。

# 必读
- docs/tasks/{编号}-{模块}.md（你的任务清单与 Done 标准，逐条实现）
- 相关 design 节：{指出具体节号，如 design §3/§4/§8}
- 相关 ADR：{如 ADR-0005}
- CONTEXT.md 的术语（写注释/日志用统一语言）

# 上游已就绪的可 import 符号
- {列出该模块依赖的上游导出，如 src/lib/io.ts 的 writeJson/readJson/manifestPath}

# 你必须产出
- {文件清单，如 src/lib/topo.ts、test/topo.test.ts}

# 硬约束
- 全程中文注释与日志；代码风格匹配 design §3 目录骨架。
- claude 调用走可注入执行器（mock 友好），不在单测里真调 claude。
- {该模块特有的硬约束，如 topo 纯函数零 IO；run-claude readonly 无逃生口}

# Done 标准（逐条自检后回报）
- {抄 task 文件的 Done 标准}
- 额外：写完后 bun test {对应测试文件} 必须全绿。

# 回报格式
完成后用一段话告诉我：改了/新建了哪些文件、测试结果（贴 bun test 末尾汇总）、有无偏离 task 描述的地方及理由。
```

派发后等子 Agent 回报，再亲自验收。

---

## 5. 硬约束（不可违背，违背即 bug）

1. **只读隔离（ADR-0005 / AC-7）**：所有分析类 Agent（Surveyor/Architect/Critic/Reader）的 `claude -p` 命令**必然**含 `--allowedTools Read,Glob,Grep`，无逃生口。写入类（Writer/Assembler）加 `Write,Edit` 但 cwd 限定在 `work/chapters/{slug}/` 或 `site/`。
2. **CAS 写入纪律（ADR-0002）**：每个 Stage「先完整写产物 → 再置 manifest 对应项 `done`」。原子写用 io 的「写 `.tmp` 再 rename」。
3. **自底向上（ADR-0003 / AC-4）**：`outline.json` 的 `dependsOn[]` 是真相；`topoOrder` 由 `topo.ts` 计算（不由 Architect 自填）；Assembler 严格按 `topoOrder` 编号 `{nn}-{slug}.md`。
4. **对抗评审（ADR-0004 / AC-6）**：Outline 与每章 Write 都走 Producer⇄Critic，≤`REVIEW_ROUNDS` 轮，首轮 approve 短路，到上限接受 + manifest `accepted-with-warning`，评审 trace 入 manifest。
5. **site 自包含（ADR-0006 / AC-1）**：`site/` 不依赖引擎仓库任何文件；`cd site && bun install && bun run docs:build` 必须成功。Assembler「仅搬运与脚手架，不改章节内容」。
6. **本地源逐字节不变（NFR-2 / AC-2）**：本地路径输入**不原地写**——复制到 `work/source/` 或只读直读，源目录 `git status` 前后无差异。
7. **`.gitignore` 以现网为准**：保留 `atlas/*/manifest.json` 与产物（续跑依赖），只忽略 `work/source/`、`site/node_modules/`、`dist/`、`cache/`。不按 `tasks/00` 旧描述重写。
8. **零运行时依赖**：引擎本体 `package.json` 无 `dependencies`，仅 `devDependencies`（`@types/bun`、`typescript`）。
9. **中文输出**：注释、日志、prompt、提交信息、known-issues 一律中文；代码标识符用英文。
10. **不臆造**：子 Agent 遇到 task 描述与 design/ADR 冲突时，**以 design/ADR 为准并在回报里指出冲突**，不擅自决策。

---

## 6. 进度跟踪与提交规范

- **`docs/tasks/progress.md`** 是进度真相：
  - 每完成一个模块：勾掉该模块 task 文件里的子任务 → 勾掉 `progress.md` 的模块行 → 对应里程碑（A/B/C/D）满足时勾里程碑。
  - 受阻模块标 `[~]` 并链到 `known-issues.md` 对应条目。
- **提交**：每完成一个模块提交一次，信息格式 `feat(M{编号}): {模块名}` 或 `test(M{编号}): {模块名}`。受阻时 `chore(M{编号}): record blocker`。提交前 `bun test` 必须绿（除非整模块受阻）。
  - ⚠️ 当前在 `dev` 分支，直接提交到 `dev` 即可，**不要**动 `master`、**不要** push（除非用户明确要求）。
- **`docs/known-issues.md`**：每条受阻记录：`## M{编号} · {模块}` + 现象 + 已尝试 + 怀疑点 + 影响的下游。

---

## 7. 完成定义（Definition of Done）

整个工程算完成，当且仅当：

1. `progress.md` 里 M00..M12 全部 `[x]`（或受阻项已在 known-issues 充分记录且下游已跳过）。
2. 里程碑 A/B/C/D 全部门禁通过。
3. `docs/verification.md` 的 AC-1..AC-7 在样本仓库上**全部 PASS**（可由 `scripts/selfcheck.sh` 一键复现）。
4. `bun test`（全量）绿。
5. 输出一份最终报告：完成模块、受阻模块、AC 自检结果、已知降级项。

---

## 8. 现在就开始

第一步：用 `TodoWrite` 把 M00..M12 + 里程碑 A/B/C/D 录成任务清单。
第二步：读 §1 列出的全部输入文档（若尚未读）。
第三步：spawn M00 的子 Agent，开工。

不要问「是否开始」——直接开始。遇到 task 与 design/ADR 冲突按硬约束 #10 处理；遇到**输入文档完全没覆盖**的真歧义（不是「我没读仔细」），才停下来记录并向用户提问，否则一路推进到底。

# Task 13 · Topic 模式（无参考仓库、纯主题教学）

> 状态：**已实现**（2026-08-10，第 1~6 层落地，tsc + atlas 全量测试通过；端到端冒烟待用户在本机跑）
> 关联：无（新里程碑）。与 `prompt-optimization` 同属引擎能力扩展。
> 修订（2026-08-10）：依代码核查修正若干断言——writer.md 现已被注入为 system prompt（提交 `2c865c9`）、`PromptRole` 需扩展、critic 字段名冲突、第 4 层改动面被低估、若干行号漂移；详见文末 §8。

## 1. 目标

让 `atlas run` 的输入除了「仓库地址 / 本地路径」之外，还能接受一个**主题/问题串**（如 `"怎么写一个 vue macro 宏"`），产出与仓库模式同规格的 VitePress 教学站点。

用户决策（已确认）：

| 决策点 | 选择 |
|---|---|
| grounding（准确性兜底） | **允许 WebSearch**（官方文档/规范作外部信息源），不依赖具体仓库 |
| research 阶段 | **保留并改造为「知识研究」**（reader 凭知识 + WebSearch 产 research.md，不读 sourceFiles） |
| CLI 入口 | **复用 `atlas run`**，三分分流：URL / 本地存在路径 / 主题 |
| prompt 策略 | **独立 topic prompt 文件**（repo 模式 prompt 零改动，两套解耦） |

**接受的核心 trade-off**：无源码锚点 → Critic 的「准确性 vs source」维度失效，改为「对照官方文档/常识可查证」。质量上限低于仓库模式（有据可查），但高于纯模型知识（WebSearch 提供外部 grounding）。

## 2. 设计核心：零新 stage、零新流水线

### 2.1 关键洞察

`findNextPending`（`src/lib/manifest.ts:540`）是**状态驱动**的：只要把 acquire/survey 预置为 `done`，orchestrator（`src/orchestrator.ts`）自动跳过，直接从 outline 跑。所以：

- **复用现有 03→07 全部 stage**，不动 orchestrator、不动 STAGE_ORDER。
- `SourceKind` 加 `"topic"` 变体后，下游所有 `source.kind === "local" ? ... : undefined`（`03-outline.ts:58` / `04-research.ts:46` / `05-write.ts:202`）对 topic 自动 yield `undefined`（等同 url 的行为），无需改动这些 stage 的 sourcePath 派生逻辑。

### 2.2 流程对比

**仓库模式（现状）**：
```
acquire(clone/resolve) → survey(repo-map) → outline → research → write → assemble → build
```

**topic 模式（本任务）**：
```
[预置 acquire=done, survey=done] → outline(主题拆章) → research(知识+WebSearch) → write → assemble → build
```

方括号内是「预处理」，在 `cmdRun` 里做；之后直接调 `runPipeline`，orchestrator 从 outline 起跑。

## 3. 改动清单（按依赖顺序）

每层标注**不改动的部分**作为边界。

### 第 1 层：类型与常量（无依赖）

#### 3.1.1 `src/lib/manifest.ts:106` — 扩展 SourceKind

```typescript
export type SourceKind = "url" | "local" | "topic";
```

`SourceInfo`（`manifest.ts:109`）字段不变，补充语义注释：

- topic 变体：`ref` = 主题串（用户原始输入）；`localPath` = `null`。
- `initManifest`（`manifest.ts:243`）无改动（它只存 source，不分支）。

#### 3.1.2 `src/lib/io.ts` — 新增 `keyFromTopic(topic)`

紧邻 `keyFromRepo`（`io.ts:158`——提交 `0e7544e` 抽出 `urlPathSegments` 后下移）新增兄弟函数：

```typescript
export function keyFromTopic(topic: string): string
```

逻辑：把主题串 slugify 成 key——中文/特殊字符折叠成 `-`，过长截断（如 ≤ 40 字符）+ 短 hash（如 topic 长度的后 4 位 base36 或简单 hash）防碰撞。空输入 → `"topic"`。与 `keyFromRepo` 同级导出。

**唯一调用点**：`src/bin/atlas.ts` cmdRun（topic 分支）。orchestrator/stages 不重算 key。

#### 3.1.3 `src/lib/config.ts:22` — 新增 topic 模式工具白名单

```typescript
/** topic 模式只读角色工具白名单：在只读基础上加 WebSearch（外部 grounding）。 */
export const TOPIC_READONLY_TOOLS = ["Read", "Glob", "Grep", "WebSearch"];
```

writer topic 模式仍用 `TOPIC_READONLY_TOOLS`（writer 本就是 readonly，见 `writer.ts:221`）。

> **风险点**：需确认本机 claude CLI 支持 `WebSearch` 作为 `--allowedTools` 值。冒烟前先单测：
> `claude -p "test" --allowedTools Read,WebSearch --permission-mode bypassPermissions`
> 若不支持，回退为纯模型知识（research/writer 仍跑，grounding 更弱）。

### 第 2 层：Prompt 文件（独立文件，无依赖）

新增 5 个 topic prompt 文件。每份对应一个 agent 的 topic 变体（含 writer，见 §3.2.5），**只写 topic 相关指令，零源码依赖逻辑**。repo 模式现有 prompt 文件零改动（两套解耦）。

#### 3.2.1 `src/prompts/topic-architect.md`

- 不读 repo-map，基于主题 + WebSearch 拆 8~20 章概念大纲。
- `sourceFiles` 字段允许为空数组（无源码），但 `summary` 必须填（读者要靠它理解每章讲什么）。
- 拆章逻辑复用：概念导向、自底向上分层（primitive/composite/system）、dependsOn DAG 无环。
- 新增指引：用 WebSearch 调研主题的子问题结构，确保覆盖完整。

#### 3.2.2 `src/prompts/topic-reader.md`

- 不读 sourceFiles，凭知识 + WebSearch 产 research.md。
- **保留同样的 8 子项教学钩子结构**（`reader.ts:61` 的 `validateHooksStructure` 关键词检查复用不变）：痛点/核心思想/设计动机/关键权衡/心智模型/原理演示/不宜展开/执行轨迹。
- 「源码位置」标注改为「依据」：标注官方文档 URL / 规范段落 / 知识来源，而非 `路径:行号`。
- 鼓励用 WebSearch 查证关键技术断言的准确性。

#### 3.2.3 `src/prompts/topic-critic-outline.md`

砍掉依赖 repo-map/sourceFiles 的维度，保留通用的：

| 保留/砍掉 | 维度 | 原因 |
|---|---|---|
| ✅ 保留 | ① 自底向上可验证（DAG 无环） | 纯图结构，通用 |
| ❌ 砍掉 | ② 完整性（覆盖 repo-map 核心模块） | 无 repo-map |
| ❌ 砍掉 | ③ 准确性（title/summary vs sourceFiles 职责吻合） | 无 sourceFiles |
| ✅ 保留 | ④ 粒度（8~20 章，无杂物箱章） | 结构性，通用 |
| ❌ 砍掉 | ⑤ 可教学性（读 sourceFiles 判断运行时行为稀薄） | 无 sourceFiles |
| ✨ 新增 | 覆盖度（主题的子问题是否拆全） | topic 特有 |
| ✨ 新增 | 深度合理性（每章是否聚焦单一可理解概念） | topic 特有 |

#### 3.2.4 `src/prompts/topic-critic-chapter.md`

| 保留/砍掉 | 维度 | 原因 |
|---|---|---|
| 🔄 改造 | ① 准确 → 「对照官方文档/常识可查证」 | 无 source，改用 WebSearch/常识 |
| ✅ 保留 | ② 衔接（dependsOn 概念已覆盖或正文解释） | outline 结构，通用 |
| 🔄 改造 | ③ 原理演示自洽（砍掉「>50% 重合 sourceFiles」「不 import 原仓库」；保留演示自洽） | 无原仓库 |
| ✅ 保留 | ④ 清晰（动机/核心思想/心智模型/轨迹） | 教学性，通用 |
| ✅ 保留 | ⑤ 教学·非源码导读（正文禁源码引用） | 通用（topic 无源码更天然成立） |
| ✅ 保留 | ⑥ 原理·关键权衡（至少 1 条「选择→换来→代价」） | 产品核心硬标准，通用 |

#### 3.2.5 `src/prompts/topic-writer.md`

> ⚠️ **本节相对原计划的重大修正**：提交 `2c865c9`（"eliminate Writer dual-track system, reinject writer.md as system prompt"）之后，`writer.md` **已经作为 system prompt 被注入**（`writer.ts:99` `promptPath("writer")` → `:135` `systemPromptPath`），`writer.ts` 的 inline user prompt 极简、只承载运行时变量。原计划「writer 不新建 prompt 文件、inline prompt 加 topic 分支」基于已失效的旧认知，**作废**。

从 `writer.md`（352 行）派生一份 `topic-writer.md`，删改 topic 模式不适用的规则：

| writer.md 位置 | 规则 | topic 模式处理 |
|---|---|---|
| `:50`（§2 工具约束） | 用 Read/Glob/Grep 读源码核对技术准确性 | 删「读源码」；改「凭 research.md + WebSearch 核对」 |
| `:164`/`:181`/`:348`（§5.2/§5.3/§7） | 正文禁绝源码对照 | 保留（topic 无源码，天然成立） |
| `:189`（§5.4） | 不 import 原仓库、不与 sourceFiles 重合 >50% | 删（无原仓库） |
| `:193`（§5.4） | 演示载体：优先 TS/JS，讲不透才用原仓库主语言 | 改为「演示载体首选 TS/JS（读者最易跑通），无原仓库语言约束」 |

writer 的文风宪法（§5.1-5.8、生硬抽象词表、正反例、自检清单）整体保留——topic 模式同样需要。writer.ts 侧改动见 §3.3.4。

### 第 3 层：Agent 层（按 source.kind 选 prompt + tools）

每个 agent 新增可选 `mode?: "repo" | "topic"` 入参，默认 `"repo"`（非破坏性扩展，向后兼容）。`mode === "topic"` 时：

- **前置：扩展 `PromptRole`**（`src/agents/types.ts:24-32`）。当前 `promptPath(role: PromptRole)` 的 `role` 是受限联合枚举（`"surveyor" | "architect" | "critic-outline" | "critic-chapter" | "reader" | "writer" | ...`），**不含 topic 角色**。必须先把 `"topic-architect" | "topic-reader" | "topic-critic-outline" | "topic-critic-chapter" | "topic-writer"` 加进 `PromptRole`，否则 `tsc --noEmit` 直接报错。这是所有 agent 共用的前置。
- `promptPath` 指向 topic 变体（扩展后的 `PromptRole` 传 `"topic-architect"` 等）。
- `runClaude` 的 `tools` 字段无法直接传 topic 工具集（现有 `tools: ToolMode = "readonly" | "write"` 是枚举）——**需要扩展 `ClaudeRunOptions`**（见 3.3.0）。
- 不声明 `sourceDir` 的 `--add-dir`。
- user prompt 砍掉「读 source/repo-map」指令，改为「凭知识 + WebSearch」。
- ⚠️ **critic 不能用 `mode` 这个字段名**（见 §3.3.3）：`CriticMode = "outline" | "chapter"` 已占用 `mode`。critic 的 topic/repo 信号改用 `sourceMode`。

#### 3.3.0 `src/lib/run-claude.ts` — 扩展 tools 支持 topic 白名单

`buildCmd`（`run-claude.ts:160`）当前按 `tools: ToolMode` 选 `READONLY_TOOLS`/`WRITE_TOOLS`。需要支持 topic 的 WebSearch 白名单。两个方案：

- **方案 A（推荐）**：`ClaudeRunOptions` 新增可选 `toolsOverride?: string[]`。`buildCmd` 里 `toolsOverride` 优先于 `tools` 枚举。agent 层 topic 模式传 `toolsOverride: TOPIC_READONLY_TOOLS`。改动小，不破坏现有 ToolMode 语义。
- 方案 B：扩展 `ToolMode` 枚举加 `"topic-readonly"`。改动面更大，不推荐。

#### 3.3.1 `src/agents/architect.ts`

`ArchitectOpts` 加 `mode?: "repo" | "topic"`。`mode === "topic"` 时：

- `systemPromptPath = promptPath("topic-architect")`。
- `toolsOverride: TOPIC_READONLY_TOOLS`。
- user prompt（`architect.ts:67-99`）改 framing：无 repo-map/sourceFiles 指令，改为「基于主题 `xxx`，用 WebSearch 调研后拆 8~20 章概念大纲；sourceFiles 填空数组」。

#### 3.3.2 `src/agents/reader.ts`

`ReaderOpts` 加 `mode?`。topic 模式：

- `systemPromptPath = promptPath("topic-reader")`。
- `toolsOverride: TOPIC_READONLY_TOOLS`。
- `validateHooksStructure`（`reader.ts:61`）**复用不变**——8 子项关键词检查通用。
- user prompt（`reader.ts:119-157`）砍掉「必须覆盖 sourceFiles」「读源码」「源码位置标注」，改为「凭知识 + WebSearch 产教学钩子，依据标注官方文档/规范」。

#### 3.3.3 `src/agents/critic.ts`

⚠️ **字段名冲突**：`CriticOpts.mode` 已是 `CriticMode = "outline" | "chapter"`（`critic.ts:21,28`），语义是「评大纲/评单章」。topic/repo 信号**不能用 `mode`**，改用新字段 `sourceMode?: "repo" | "topic"`（默认 `"repo"`）。

topic 模式（`sourceMode === "topic"`）：

- `systemPromptPath` 按**双维度**选（`sourceMode` × `mode`）：`promptPath(sourceMode === "topic" && mode === "outline" ? "topic-critic-outline" : sourceMode === "topic" ? "topic-critic-chapter" : mode === "outline" ? "critic-outline" : "critic-chapter")`。
- `toolsOverride: TOPIC_READONLY_TOOLS`。
- user prompt（`critic.ts:139-144` outline「读取范围」/ `183-191` chapter「读取范围」）砍掉「源码」读取段。

#### 3.3.4 `src/agents/writer.ts`

> ⚠️ **原方案作废**（基于旧认知「writer.md 不注入」）。现状（提交 `2c865c9` 之后）：`writer.md` 已作为 system prompt 注入（`writer.ts:99` `promptPath("writer")` → `:135` `systemPromptPath`）；inline user prompt（`:119-129`）极简，只承载 slug/cwd/章节上下文/Critic 反馈等运行时变量。原计划引用的 `writer.ts:145/200-207/208/227` 全部对不上——那些规则在 `writer.md`，不在 inline prompt。

`WriterOpts` 加 `mode?: "repo" | "topic"`（默认 `"repo"`）。topic 模式按 mode **选 system prompt 文件**（与 architect/reader 同模式）：

- `systemPromptPath = promptPath(mode === "topic" ? "topic-writer" : "writer")`（`writer.ts:99` 改）。`PromptRole` 须先加 `"topic-writer"`（见 §3.3 前置）。
- topic-writer.md 的内容见 §3.2.5（从 writer.md 派生，删改 topic 不适用规则）。
- inline user prompt（`:119-129`）**无需加 topic 分支**——它只承载运行时变量，本来就没有「读 source/演示载体语言/不 import 原仓库」这类规范指令（那些在 system prompt 里）。
- `addDirs`（`writer.ts:143`，当前 `[wdir, sourceDir(key)]`）topic 模式去掉 `sourceDir(key)`，只留 `wdir`——topic 无源码目录，加了反而触发 claude 的「等授权读」幻觉。推荐按 `mode` 决定（`mode === "topic" ? [wdir] : [wdir, sourceDir(key)]`），比新增 sourcePath 透传链路更简单。
- topic 模式 `toolsOverride: TOPIC_READONLY_TOOLS`（writer 本是 readonly，加 WebSearch 让它也能查证）。

> **文档同步契约已变**：旧契约「writer.md 改动必须同步 writer.ts inline」（dual-track）已在 `2c865c9` 消除——现在 writer.md 是单一权威且实际注入，无 dual-track。topic 模式只需维护 topic-writer.md 一份。

### 第 4 层：Stage 层（透传 mode + 补签名）

> ⚠️ 原计划「每处加一行 mode」低估了改动面：architect/reader/writer 的 `Opts` 当前**没有 mode 字段**，必须先在第 3 层扩签名后，stage 才能透传。critic 用 `sourceMode`（非 mode）。行号层面 `03:76`/`03:128`/`04:94`/`05:writeChapter` 全部已核查精确命中。

每处调用补传（critic 传 `sourceMode`，其余传 `mode`）：

- `src/stages/03-outline.ts:76`（architect 调用，加 `mode`）+ `:128`（critic 调用，加 `sourceMode`）。
- `src/stages/04-research.ts:94`（reader 调用，加 `mode`）。
- `src/stages/05-write.ts` writeChapter 内：writer 调用（`:106-113`，加 `mode`）+ critic 调用（`:133`，加 `sourceMode`）。

⚠️ **额外**：`05-write.ts:106-113` 的 writer 调用当前**没透传 `sourcePath`**（现状靠 `writer.ts:143` 的 `addDirs:[wdir, sourceDir(key)]` 硬算 sourceDir）。topic 模式按 §3.3.4 推荐——writer 内部按 `mode` 决定 addDirs，无需新增 sourcePath 透传链路。

`sourcePath` 派生（`03:58` / `04:46` / `05:202`）**无需改**——topic 的 `source.kind !== "local"` 自动 yield `undefined`（已核查三处三元精确命中）。

### 第 5 层：CLI 入口 + topic 预处理

#### 3.5.1 `src/bin/atlas.ts` cmdRun 三分分流

`cmdRun`（`atlas.ts:340-400`）的 source 判定改为三分：

```typescript
if (/^(https?:\/\/|git@)/i.test(repo)) {
  source = { kind: "url", ref: repo, localPath: null };       // 现状
} else {
  // 先判本地路径是否存在，不存在则当主题
  try {
    const { absPath } = resolveLocalSource(repo);
    source = { kind: "local", ref: repo, localPath: absPath }; // 现状
  } catch {
    // 既非 URL 也非存在路径 → topic
    source = { kind: "topic", ref: repo, localPath: null };
  }
}
```

key 派生相应分流：`source.kind === "topic" ? keyFromTopic(repo) : keyFromRepo(repo)`。

> ⚠️ **顺序点**：当前 cmdRun 里 key 在 `atlas.ts:351` 算，**早于** source 判定（`:370+`）。若 key 派生要依赖 `source.kind`，需把 source/topic 判定提前到 key 派生之前，或先判 topic 再分别算 key。落地时调整这段顺序即可（非阻塞）。

> **注意现状差异**：当前 cmdRun 在本地路径不存在时 `deps.err + return 1` 退出（`atlas.ts:378-382`，已核查）。本任务把 catch 分支从「报错退出」改成「置 `source.kind = "topic"`」，不再报错。这是行为变更，需在 USAGE 文案说明。

#### 3.5.2 topic 预处理：预置 acquire/survey=done

topic 模式新建 manifest 后、调 `runPipeline` 前：

```typescript
if (source.kind === "topic") {
  let tm = setStageStatus(m, "acquire", "done", { cmd: "(topic 模式，无 acquire)" });
  tm = setStageStatus(tm, "survey", "done", { cmd: "(topic 模式，无 survey)" });
  await saveManifest(key, tm);
}
```

这样 `findNextPending` 第一个命中的就是 outline，orchestrator 自动跳过 acquire/survey。**无需写 repo-map.json**（architect 的 topic prompt 不读它）。

#### 3.5.3 USAGE 文案（`atlas.ts:698`）

`atlas run` 说明改为：

```
atlas run <repo|url|主题>   新建或自动续跑 Run
```

补一行说明：输入既可以是仓库地址/本地路径，也可以是一个主题/问题串（既非 URL 也非存在路径时按主题处理）。

### 第 6 层：测试

遵循 AGENTS.md 测试规范（`test/<module>.test.ts` 镜像，中文测试名，依赖注入 mock，单测不真调 claude）。

- **`test/io.test.ts`** — 加 `keyFromTopic` 测试：中文主题、特殊字符、超长截断、空输入、碰撞。
- **`test/bin-atlas.test.ts`** — 加 cmdRun 三分分流测试：URL / local / topic 各一例（注入 mock runPipeline，断言传出的 `source.kind` 与 topic 模式预置的 `stages.acquire/survey.status === "done"`）。
- **`test/run-claude.test.ts`** — 加 `toolsOverride` 测试：传 `toolsOverride` 时 buildCmd 的 `--allowedTools` 值用 override 而非枚举映射。
- 现有测试全绿（`bun test` + `bunx tsc --noEmit`）。

## 4. 不改动的部分（明确边界）

| 文件 | 不改原因 |
|---|---|
| `src/orchestrator.ts` | 状态驱动，自动跳过 acquire/survey |
| `src/stages/01-acquire.ts` / `02-survey.ts` | topic 模式根本不进（预置 done） |
| `src/stages/06-assemble.ts` / `07-build.ts` | 本就 source-agnostic |
| `src/lib/manifest.ts` 的 `findNextPending` / `STAGE_ORDER` | 状态驱动通用 |
| 现有 repo 模式 prompt 文件（architect/reader/critic-*/writer.md） | topic 用独立文件，零改动 |
| `lib/topo.ts` / `lib/pool.ts` / `lib/extract.ts` / `lib/chapter-context.ts` | 纯逻辑，与 source 无关 |

## 5. 实施顺序

1. **第 1 层**（类型/常量：SourceKind、`keyFromTopic`、`TOPIC_READONLY_TOOLS`、**`PromptRole` 扩展**）→ `bunx tsc --noEmit` 过
2. **第 2 层**（5 个 topic prompt 文件，含 topic-writer.md）
3. **第 3 层**（agent 层 mode / `sourceMode` 分支 + run-claude `toolsOverride`）→ `bunx tsc --noEmit` 过
4. **第 4 层**（stage 透传 mode）→ `bunx tsc --noEmit` 过
5. **第 5 层**（CLI 分流 + 预置）→ `bunx tsc --noEmit` 过
6. **第 6 层**（测试）→ `bun test` 全绿
7. **端到端冒烟**：`bun run src/bin/atlas.ts run "怎么写一个 vue macro 宏" --skip-build` → 验证产物在 `atlas/<key>/site/`

## 6. 风险与缓解

| 风险 | 缓解 |
|---|---|
| WebSearch 工具名不被 claude CLI 支持 | 冒烟前单测 `claude -p ... --allowedTools Read,WebSearch`；不支持则回退纯模型知识 |
| reader 的 `validateHooksStructure`（`reader.ts:61`）硬编码 8 子项关键词，topic-reader 措辞偏差可能误杀 | 首次冒烟重点观察；`retries: 3`（`reader.ts:170`）兜住偶发；若系统性误杀，调整 topic-reader prompt 措辞对齐关键词 |
| topic key 碰撞（同主题多次跑复用 key） | 现有续跑语义的自然延伸；用户需 `atlas clean` 或改主题措辞。符合预期，不特殊处理 |
| topic 模式产物质量低于仓库模式（无源码锚点） | 已知 trade-off，用户已确认接受；Critic 准确性维度改为「对照官方文档/常识」 |

## 7. 验收标准

- [x] `bunx tsc --noEmit` 通过（strict）。
- [x] `bun test` 全绿（含新增 topic 测试；141 个 Path parser 失败为既有、与本任务无关，见 `project-test-suite-known-failures`）。
- [ ] `atlas run "怎么写一个 vue macro 宏" --skip-build` 端到端跑通，产出 `atlas/<key>/site/` 含 VitePress 结构。（**待本机冒烟**——需真实 claude + WebSearch）
- [ ] 产物含 8~20 章，每章有 draft.md（非空、有教学钩子结构）。（**待本机冒烟**）
- [x] repo 模式（`atlas run <repo>`）行为不变（回归：architect/reader/critic/writer 默认 mode=repo、sourceMode=repo，prompt/tools 与改动前一致；stages.test 全绿）。
- [x] `atlas show <topic-key>` 正常显示 stage 状态（acquire/survey 显示 done + topic 说明——cmd 字段记 `(topic 模式，无 acquire/survey)`）。

## 8. 修订记录（2026-08-10 代码核查）

依当前 `dev` 分支代码对原计划逐条核验后的修正（4 个核查 agent 并行覆盖类型/常量层、agent/run-claude 层、stage/orchestrator 层、CLI 层）。

### 8.1 阻塞性修正

| # | 原计划断言 | 现状 | 修正 |
|---|---|---|---|
| 1 | §3.3.4「writer.md 不注入、指令在 writer.ts inline（`:6-14` 注释）」 | 提交 `2c865c9` 后 **writer.md 已作为 system prompt 注入**（`writer.ts:99/:135`）；inline（`:119-129`）极简 | §3.3.4 整段重写 + 新增 §3.2.5 `topic-writer.md`；prompt 文件 4→5 |
| 2 | `promptPath(name)` 传 `"topic-architect"` 等 | `PromptRole`（types.ts:24-32）是受限枚举，不含 topic 角色 | §3.3 前言加前置：必须先扩 `PromptRole` |

### 8.2 改动面修正

| # | 原计划 | 实际 | 修正位置 |
|---|---|---|---|
| 3 | critic 加 `mode?` | `mode` 已被 `CriticMode="outline"\|"chapter"` 占用（critic.ts:21,28） | §3.3.3 改用 `sourceMode` |
| 4 | 第 4 层「单行 mode 透传」 | architect/reader/writer 的 Opts 无 mode 字段，需先扩签名 | §3.4 标题与说明改写 |
| 5 | `05-write.ts` writer 调用透传 mode 即可 | 该调用当前**未透传 sourcePath**（靠 writer.ts:143 硬算 sourceDir） | §3.3.4/§3.4 推荐 writer 按 mode 决定 addDirs |

### 8.3 顺序点

| # | 原计划 | 实际 | 修正 |
|---|---|---|---|
| 6 | §3.5.1 key 派生与 source 判定同分支 | key 在 `atlas.ts:351` 算，**早于** source 判定（`:370+`） | §3.5.1 加顺序说明 |

### 8.4 行号漂移（无方案影响，已就地更新）

| 位置 | 原计划 | 实际 |
|---|---|---|
| `keyFromRepo` | io.ts:131 | io.ts:158（`0e7544e` 抽出 `urlPathSegments` 下移） |
| critic outline「读取范围」 | :142-144 | :139-144 |
| critic chapter「读取范围」 | :188-190 | :183-191 |
| writer.ts inline | :121-214 | :119-129（极简） |
| writer tools | :221 | :137 |
| writer addDirs | :227 | :143 |

### 8.5 经核查完全成立的核心假设（方案地基无误）

- `findNextPending`（manifest.ts:520-556）状态驱动跳过 acquire/survey → 第一个命中 outline。
- orchestrator（orchestrator.ts）零改动：纯状态驱动、不读 source.kind、不硬编码 acquire/survey。
- `sourcePath` 三元（`03:58`/`04:46`/`05:202`）topic 自动 yield `undefined`。
- `resolveLocalSource`（io.ts:277）同步 throw，try/catch 判 topic 成立。
- 预置插入点（atlas.ts:388，initManifest 后 / runPipeline 前）可行。
- `ClaudeRunOptions`（run-claude.ts:67-106）无 `toolsOverride`，方案 A 干净可行。
- `validateHooksStructure` 8 关键词（reader.ts:61-81）对 topic 复用成立。
- 06-assemble / 07-build 完全 source-agnostic。
- 5 个新 topic prompt 文件均无重名。

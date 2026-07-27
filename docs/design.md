# 设计文档 · Code Atlas

> 需求见 [`requirements.md`](./requirements.md)；术语见 [`CONTEXT.md`](../CONTEXT.md)；每条决策的"为什么"见 [`docs/adr/`](./adr/)。本文写"怎么实现"。

## 1. 概览

```
Repository Source ─▶ Acquire ─▶ Survey ─▶ Outline(⇄Critic) ─▶ Research×N ─▶ Write×N(⇄Critic) ─▶ Assemble ─▶ Build
                       │            │           │                 │              │                │          │
                    source/     repo-map.json  outline.json   research.md     draft.md+replica/   site/    构建日志
                                                                                                  ▲
                                          所有 Stage 状态由 manifest.json 统一记录、可断点续跑
```

Orchestrator（Bun/TS）自身**无运行时状态**：它只是"按 manifest 决定下一步 → 调起对应 `claude -p` agent → 落盘产物 → 更新 manifest"的循环。所有智能工作在 agent 里，所有状态在磁盘上。

## 2. 执行模型（ADR-0001）

每个 Agent = 一次 `claude -p`（headless / print 模式）子进程：
- **角色 prompt**：`prompts/{role}.md` 作为系统级指令（职责、输出格式、约束）。
- **用户 prompt**：运行时拼接（带上读哪些产物文件、写到哪、验收标准）。
- **工具权限**：分析类只读（`--allowedTools Read,Glob,Grep`），写入类放开到 `work/`/`site/`（ADR-0005）。
- **工作目录**：Agent 的 cwd 指向 `atlas/{repo}/`，使其能以相对路径读 `work/`、写 `work/`/`site/`。
- **输出契约**：Agent 把结果直接写成约定路径的文件（而非依赖 stdout 解析），stdout 仅用于流式日志与最终摘要。

封装在 `src/lib/run-claude.ts`，统一记录命令到 manifest。

## 3. 架构分层

```
src/
├── bin/atlas.ts          CLI 入口（解析命令 → 调 Orchestrator）
├── orchestrator.ts       顶层循环：读 manifest → 选下一 Stage → 调 stage → 写 manifest
├── stages/               7 个 Stage：纯函数 (workDir, input) => output，每个内部调 agents
├── agents/               6 类 Agent 的 claude -p 封装（拼 prompt + 调 run-claude）
├── prompts/              *.md 角色 prompt 模板
└── lib/
    ├── run-claude.ts     spawn `claude -p`，统一 --allowedTools、cwd、超时、命令日志
    ├── manifest.ts       状态机读写（CAS 式：先写产物再置 done）
    ├── pool.ts           有界并发池（默认 4）
    ├── topo.ts           dependsOn 拓扑排序 + 环检测
    └── io.ts             路径约定、JSON 读写、source 取得（clone/直读）
```

## 4. 流水线详述

每个 Stage 的契约：**输入产物 → 处理 → 输出产物 → 翻 manifest 状态为 done**。

### Stage 1 · Acquire（Bun，无 agent）
- 输入：URL 或本地路径。
- 处理：URL → `git clone --depth 1 <url> work/source`；本地路径 → 记录绝对路径（原地只读直读，不复制）。
- 输出：`work/source/`（克隆）或 manifest 中记录的 `sourcePath`（本地）。
- 失败：克隆失败 → manifest `failed`，终止并提示。

### Stage 2 · Survey（Surveyor，只读）
- 输入：`work/source/`（或本地 sourcePath）。
- 处理：扫描目录树、识别入口（package.json main/exports/bin、index.*）、构建清单、语言与框架线索、关键文件分组。
- 输出：`work/repo-map.json`（schema 见 §8.1）。

### Stage 3 · Outline（Architect ⇄ Critic，只读，≤2 轮）
- 输入：`repo-map.json` + Source。
- 处理：
  1. Architect 高屋建瓴拆出 8~20 章，每章赋 `slug/title/layer/dependsOn[]/sourceFiles[]/summary`。
  2. Critic 对抗评审（验收标准见 §5.3）。reject 则 Architect 据反馈修订，最多 2 轮。
- 输出：`work/outline.json`（含 `topoOrder[]`，由 `topo.ts` 计算）。

### Stage 4 · Research（Reader ×N，只读，并发 4）
- 输入：`outline.json` + Source。
- 处理：每章一个 Reader，精读 `sourceFiles[]` 与相关代码，产出摘录、关键调用链、概念要点。
- 输出：`work/chapters/{slug}/research.md`。
- 并发：`pool.ts` 有界池。

### Stage 5 · Write（Writer ⇄ Critic ×N，写 work/，并发 4，≤2 轮）
- 输入：`research.md` + `outline.json`。
- 处理：
  1. Writer 写 `draft.md`（讲解 + 内嵌最小可运行 ts/js 复刻），并把复刻存到 `replica/`。
  2. Critic 评审（准确性 vs Source、清晰度、复刻可运行性、自底向上衔接）。reject 则修订，≤2 轮。
- 输出：`work/chapters/{slug}/draft.md` + `replica/*.ts|js`。

### Stage 6 · Assemble（Assembler，写 site/）
- 输入：`outline.json` + 各章 `draft.md`。
- 处理：把 `draft.md` 复制为 `site/guide/{nn}-{slug}.md`（nn = topoOrder 序号）；生成 `config.ts`（侧边栏按 `level` 分组 + topo 顺序，见 §11）、`index.md`（首页）、`package.json`。
- 输出：完整 `site/`。

### Stage 7 · Build（Bun，无 agent）
- 输入：`site/`。
- 处理：`cd site && bun install && bun run docs:build`。
- 输出：`site/.vitepress/dist`（可跳过：`--skip-build`）。

## 5. Agent 角色清单

| 角色 | 工具 | 写入 | 关键 prompt 要点 |
|------|------|------|------------------|
| Surveyor | Read,Glob,Grep | — | 只如实记录结构，不臆测；产出严格符合 repo-map schema |
| Architect | Read,Glob,Grep | — | 高屋建瓴拆概念；每章 dependsOn 必须是更底层的章；DAG 无环 |
| Critic | Read,Glob,Grep | — | 只评审不生产；输出结构化 verdict |
| Reader | Read,Glob,Grep | — | 精读指定文件，摘关键调用链与要点，标注源码位置 |
| Writer | +Write/Edit | work/chapters/{slug}/ | 自底向上衔接前文；内嵌可运行复刻；复刻与 replica 一致 |
| Assembler | +Write/Edit | site/ | 仅搬运与脚手架，不改章节内容；侧边栏严格来自 outline |

### 5.1 Surveyor 输出要点
目录树（过滤 node_modules/.git/dist）、入口文件、清单文件、主要语言/框架、模块/包边界、可读性线索（README/docs）。

### 5.2 Architect 输出要点
- 每章聚焦**一个可理解概念**，slug 用 kebab-case 英文。
- `dependsOn[]` 只引用其它 slug；禁止自环、禁止环。
- `layer` ∈ `primitive|composite|system`（仅作分组）。
- `sourceFiles[]` 指向该章对应源码（Reader 的读取范围）。

### 5.3 Critic 验收标准（Outline）
1. **自底向上可验证**：依赖图无环；每章的 `dependsOn` 闭包在其之前（由 `topo.ts` 复算交叉校验）。
2. **完整性**：覆盖 repo-map 标记的核心模块/入口，无明显遗漏。
3. **准确性**：章节标题/summary 与源码实际职责吻合，不张冠李戴。
4. **粒度**：章数 8~20，每章大小相当；无"杂物箱"章节。

### 5.4 Critic 验收标准（Chapter）
1. **准确**：技术陈述与 Source 一致（抽查关键断言能否在源码找到依据）。
2. **衔接**：用到的前置概念确实在 `dependsOn` 章节中已讲解。
3. **可运行**：内嵌 ts/js 复刻与 `replica/` 一致且能跑（Critic 可读 replica 文件判断结构合理性）。
4. **清晰**：有图示/步骤/输入输出，不是流水账。

## 6. 对抗评审机制（ADR-0004）

```
Producer 出草稿 ─▶ Critic 评审 ─┬─ approve ─▶ 接受
                                └─ reject+fixes ─▶ Producer 修订 ─▶ Critic 再评（≤2 轮）
                                                  └─ 到上限 ─▶ 接受最后版本 + manifest 告警
```
- Critic 首轮 approve 即短路，多数情况只多一次调用。
- 评审记录写入 manifest（round、verdict、fixes 摘要），便于审计。

## 7. 自底向上保证（ADR-0003）

- 数据层：`outline.json` 的 `dependsOn[]` 是真相。
- 计算层：`topo.ts` 做 Kahn 拓扑排序 + 环检测，产出 `topoOrder[]`。
- 校验层：Critic 用同一 `topo.ts` 复算，与 Architect 声称的顺序交叉比对。
- 呈现层：Assembler 严格按 `topoOrder[]` 编号文件、排侧边栏。

## 8. 数据模型（产物 schema）

### 8.1 `work/repo-map.json`
```jsonc
{
  "root": "work/source",            // 或本地 sourcePath
  "sourceKind": "git-clone | local",
  "languages": ["ts", "js"],
  "frameworks": ["react"],          // 线索推断
  "entrypoints": ["src/index.ts"],
  "manifests": ["package.json"],
  "packages": [{ "name": "core", "path": "packages/core" }],  // monorepo 子包
  "tree": [{ "path": "src", "type": "dir" }, { "path": "src/index.ts", "type": "file", "role": "entry" }],
  "docs": ["README.md"]
}
```

### 8.2 `work/outline.json`
```jsonc
{
  "repo": "xxx",
  "generatedAt": "1970-01-01T00:00:00Z",   // 由 Orchestrator 注入（脚本内不取系统时钟于确定性路径）
  "chapters": [
    {
      "slug": "reactive-primitive",
      "title": "响应式原子",
      "layer": "primitive",
      "dependsOn": [],
      "sourceFiles": ["src/reactivity/effect.ts", "src/reactivity/ref.ts"],
      "summary": "signal/effect 的最小实现"
    }
  ],
  "topoOrder": ["reactive-primitive", "computed", "components", "app"]
}
```

### 8.3 `atlas/{repo}/manifest.json`
```jsonc
{
  "key": "xxx",
  "source": { "kind": "url", "ref": "https://github.com/o/r", "localPath": null },
  "version": 1,
  "stages": {
    "acquire":  { "status": "done", "startedAt": "...", "finishedAt": "...", "cmd": "git clone ..." },
    "survey":   { "status": "done", "startedAt": "...", "finishedAt": "...", "cmd": "claude -p ..." },
    "outline":  { "status": "done", "review": { "rounds": 2, "final": "accepted-with-warning", "trace": [] } },
    "research": { "status": "running" },
    "write":    { "status": "pending" },
    "assemble": { "status": "pending" },
    "build":    { "status": "pending" }
  },
  "chapters": {
    "reactive-primitive": {
      "research": { "status": "done", "cmd": "claude -p ..." },
      "write":    { "status": "pending", "review": null }
    }
  }
}
```

### 8.4 章节产物
- `work/chapters/{slug}/research.md`：源码摘录、调用链、要点（带 `源码位置:` 标注）。
- `work/chapters/{slug}/draft.md`：最终章节正文（含内嵌 ```ts```/```js``` 复刻块）。
- `work/chapters/{slug}/replica/*.ts|js`：复刻的可运行副本。

## 9. 续跑与状态机（ADR-0002）

manifest 每个项状态机：`pending → running → done`，或 `→ failed`，或评审相关 `awaiting_*`。

写入纪律（CAS 式，防"半成品被误判完成"）：
1. Agent 先把产物**完整写盘**；
2. 再把 manifest 对应项置 `done`；
3. Orchestrator 选下一 Stage 时只认 `done`。

`resume` 逻辑：读 manifest → 找第一个非 `done` 的 Stage / chapter 子项 → 从那继续。`--from`/`--only` 覆盖选择；`--force` 把目标项重置为 `pending` 强制重跑。

## 10. 取源与只读隔离（ADR-0005）

- URL：`git clone --depth 1` 到 `work/source/`。
- 本地：不复制；manifest 记 `sourcePath`；所有 agent 对该路径用只读工具。
- 强制点：`run-claude.ts` 对分析类角色硬编码 `--allowedTools Read,Glob,Grep`，无逃生口。
- 验证：AC-7 可扫 manifest 中每条 `cmd` 核验。

## 11. 站点组装与侧边栏算法（ADR-0006）

侧边栏从 `outline.json` 生成：
1. 按 `topoOrder` 取顺序；
2. 按 `layer` 分组（primitive → composite → system）作为侧边栏分组标题；
3. 组内保持 topo 顺序；
4. 文件名 `{nn}-{slug}.md`，`nn` 为 topo 序号（两位补零）。

`config.ts` 由 Assembler 用字符串模板生成（不引运行时依赖读 outline，保持 site 自包含）。`package.json` pin `vitepress` 版本，含 `docs:dev` / `docs:build` 脚本。

## 12. 目录结构（引擎 + 工作区同居）

```
d-code-atlas/
├── README.md  CONTEXT.md  package.json
├── docs/  requirements.md  design.md  adr/0001..0006.md
├── src/  bin/ stages/ agents/ prompts/ lib/
└── atlas/{repo}/  manifest.json  work/{source,repo-map.json,outline.json,chapters/}  site/
```

## 13. CLI 设计

```
atlas run <repo>                     # 新建或自动续跑
atlas resume <key> [--from <stage>] [--only <stage>] [--force]
atlas list                           # 列出 atlas/ 下所有 Run 及状态
atlas clean <key>                    # 删除 Run 工作区
atlas show <key>                     # 打印 manifest 摘要
```
全局 flag：`--concurrency <n>`（默认 4）、`--review-rounds <n>`（默认 2）、`--skip-build`、`--model <name>`（透传给 claude）。

## 14. 配置项（常量/flag）

| 项 | 默认 | 说明 |
|----|------|------|
| concurrency | 4 | 逐章并发 |
| reviewRounds | 2 | 对抗评审上限 |
| maxChapters | 24 | 超出则 Architect 需合并（防大仓库失控） |
| skipHeavyDirs | node_modules,.git,dist,build | Survey 跳过 |

## 15. 错误处理与降级

- Agent 调用失败（非 0 退出/超时）→ manifest 置 `failed` + 记 stderr 摘要；Orchestrator 不自动无限重试，交由用户 `--force` 重跑（保持成本可控、可诊断）。
- 章数超 `maxChapters` → Architect 必须合并，Critic 拦截超量大纲。
- 评审到上限未过 → 接受最后版本 + manifest `accepted-with-warning`，不阻塞流程。
- Build 失败 → 标记但保留 `site/`，提示用户手动排查（`--skip-build` 可跳过）。

## 16. ADR 索引

| ADR | 主题 |
|-----|------|
| [0001](./adr/0001-claude-cli-subprocess-for-agent-execution.md) | claude CLI 子进程执行 Agent |
| [0002](./adr/0002-stateless-resumable-stages-via-manifest.md) | 每 Stage 落盘 + manifest 状态机，跨 session 可续跑 |
| [0003](./adr/0003-bottom-up-via-dependency-dag.md) | 自底向上 = 依赖 DAG + 拓扑排序 |
| [0004](./adr/0004-adversarial-review-replaces-human-gate.md) | 对抗评审替代人工 GATE |
| [0005](./adr/0005-source-is-read-only-to-agents.md) | Source 对所有 Agent 只读 |
| [0006](./adr/0006-standalone-deployable-vitepress-site.md) | site/ 完整自包含可独立部署 |

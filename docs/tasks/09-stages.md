# M09 · stages

> 7 个 Stage：`(workDir/key, input) => output`，内部调 agents + lib。
> 对应 design §3（stages/）、§4（流水线详述）、§6（对抗评审）、§11（站点组装）。

## 依赖
- M01 lib-io
- M03 lib-manifest
- M04 lib-pool
- M05 lib-topo
- M08 agents

## 子任务（`src/stages/{nn}-{name}.ts`）

- [ ] `01-acquire.ts`：URL → `cloneSource` 到 `work/source/`；本地 → 记 `sourcePath` 不复制。失败置 manifest failed 并终止。输出 source 就绪。
- [ ] `02-survey.ts`：调 `surveyor`，产出并校验 `work/repo-map.json`（基本 schema 检查）。
- [ ] `03-outline.ts`：
  - 调 `architect` 出 outline 草稿；
  - 调 `topoSort` 注入 `topoOrder`、检测环/悬空；
  - **对抗评审循环**（design §6）：`critic(outline)` ⇄ `architect` 修订，≤ `REVIEW_ROUNDS` 轮；首轮 approve 短路；到上限未过→接受 + `accepted-with-warning`；
  - 写 `work/outline.json`；记 review trace 到 manifest。
- [ ] `04-research.ts`：`mapPool` 并发跑 `reader` × N 章；每章产物 `research.md`；单章失败隔离（design §15）。
- [ ] `05-write.ts`：`mapPool` 并发跑 Writer⇄Critic × N 章，≤2 轮；产出 `draft.md` + `replica/`；记 review trace。
- [ ] `06-assemble.ts`：
  - 按 `topoOrder` 把 `draft.md` 复制为 `site/guide/{nn}-{slug}.md`（nn = topo 序号两位补零）；
  - 生成 `.vitepress/config.ts`（侧边栏按 `layer` 分组 + 组内 topo 顺序，design §11）；
  - 生成 `index.md`（首页）、`package.json`（pin vitepress + `docs:dev`/`docs:build` 脚本）；
  - **不改章节内容**（ADR-0006 自包含）。
- [ ] `07-build.ts`：`cd site && bun install && bun run docs:build`；采集构建日志；`--skip-build` 跳过；失败标记但保留 `site/`（design §15）。
- [ ] 每个 stage 遵守 **CAS 写入纪律**（design §9）：先完整写产物 → 再置 manifest 对应项 `done`。
- [ ] 每个 stage 失败路径：置 `failed` + stderr 摘要，不无限重试。

## Done 标准
- 7 个 stage 可被 orchestrator 顺序调起。
- Outline / Write 走完对抗评审，manifest 有 review trace（AC-6）。
- Assemble 产出的 `site/` 独立可构建（`cd site && bun install && bun run docs:build` 成功，AC-1）。
- 章节 filename 编号 == topo 序号（AC-4）。

# Code Atlas

输入**开源仓库地址 / 本地目录路径**，输出一个**自底向上、可独立部署的 VitePress 文档站**——把一个仓库的核心原理，从原子概念一步步讲到系统全貌，每章配可运行的最小 ts/js 复刻。

## 文档导航

- [需求文档](./docs/requirements.md) —— 做什么、验收标准、MVP 范围。
- [设计文档](./docs/design.md) —— 怎么实现：流水线、6 类 Agent、产物 schema、续跑状态机。
- [术语表](./CONTEXT.md) —— 领域语言（Agent / Stage / Chapter / Critic …）。
- [架构决策（ADR）](./docs/adr/) —— 6 条关键决策的理由。

## 一图概览

```
Source ─▶ Acquire ─▶ Survey ─▶ Outline(⇄Critic) ─▶ Research×N ─▶ Write×N(⇄Critic) ─▶ Assemble ─▶ Build
                                                                           ↓
                                          每 Stage 落盘 + manifest 状态机，可断点续跑
```

## 六条设计不变量

1. **claude -p 子进程**驱动每个 Agent（[ADR-0001](./docs/adr/0001-claude-cli-subprocess-for-agent-execution.md)）
2. **每 Stage 落盘 + manifest 状态机** → 跨 session 断点续跑（[ADR-0002](./docs/adr/0002-stateless-resumable-stages-via-manifest.md)）
3. **自底向上 = dependsOn DAG + 拓扑排序**，Critic 可机械验证（[ADR-0003](./docs/adr/0003-bottom-up-via-dependency-dag.md)）
4. **对抗评审**（Producer⇄Critic，≤2 轮）替代人工关卡（[ADR-0004](./docs/adr/0004-adversarial-review-replaces-human-gate.md)）
5. **Source 对所有 Agent 只读**，不污染原仓库（[ADR-0005](./docs/adr/0005-source-is-read-only-to-agents.md)）
6. **site/ 完整自包含**，可独立部署（[ADR-0006](./docs/adr/0006-standalone-deployable-vitepress-site.md)）

## 目录布局

```
d-code-atlas/
├── README.md  CONTEXT.md  package.json  tsconfig.json
├── docs/        requirements.md · design.md · adr/
├── src/         引擎：bin/ · stages/ · agents/ · prompts/ · lib/
└── atlas/{repo}/   一次 Run：manifest.json · work/(中间产物) · site/(VitePress 工程)
```

## 快速开始

前置：已安装 [Bun](https://bun.sh) ≥ 1.3、[Claude Code CLI](https://docs.claude.com/en/docs/claude-code)（已登录）、git。

```bash
bun install                       # 装引擎依赖

# 分析一个仓库（URL 或本地路径）
bun run src/bin/atlas.ts run https://github.com/owner/repo
bun run src/bin/atlas.ts run ./my-local-project

# 产物在 atlas/{repo}/site/ —— 自包含 VitePress 工程
cd atlas/{repo}/site && bun install && bun run docs:build
```

中断了？任何 Stage 完成后都可续跑：

```bash
bun run src/bin/atlas.ts list                          # 看所有 Run 与进度
bun run src/bin/atlas.ts show <key>                    # 看某 Run 的 manifest 摘要
bun run src/bin/atlas.ts resume <key>                  # 从中断处继续
bun run src/bin/atlas.ts resume <key> --from write     # 从某 Stage 起
bun run src/bin/atlas.ts resume <key> --from write --force   # 强制重跑该 Stage 及之后
bun run src/bin/atlas.ts clean <key>                   # 删除某 Run 工作区
```

全局 flag：`--concurrency <n>`（默认 4）、`--review-rounds <n>`（默认 2）、`--skip-build`、`--model <name>`。

## 状态

✅ v1 (MVP) 已实现：7 Stage 流水线、6 类 Agent、对抗评审、自底向上 DAG、断点续跑、自包含 VitePress 站点。详见 [需求](./docs/requirements.md) FR-1~FR-8 / AC-1~AC-7。


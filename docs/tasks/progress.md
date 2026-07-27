# 任务总进度 · Code Atlas

> 本文件记录各模块完成状态。每个模块对应 `docs/tasks/<module>.md`，子任务 checklist 见对应文件。
> 依赖顺序**自上而下**：靠下的模块依赖靠上已完成的模块（Vibe Coding 时按此顺序推进最稳）。
> 术语见 [`CONTEXT.md`](../../CONTEXT.md)；需求见 [`requirements.md`](../requirements.md)；实现见 [`design.md`](../design.md)；验收见 [`verification.md`](../verification.md)。

## 模块清单

- [x] **M00** · [`project-scaffolding`](./00-project-scaffolding.md) — 项目脚手架（package.json / tsconfig / 目录骨架 / 全局常量）
- [x] **M01** · [`lib-io`](./01-lib-io.md) — 路径约定、JSON 读写、取源原语
- [x] **M02** · [`lib-run-claude`](./02-lib-run-claude.md) — `claude -p` 子进程统一封装
- [x] **M03** · [`lib-manifest`](./03-lib-manifest.md) — manifest 状态机读写（CAS 纪律）
- [x] **M04** · [`lib-pool`](./04-lib-pool.md) — 有界并发池
- [x] **M05** · [`lib-topo`](./05-lib-topo.md) — 拓扑排序 + 环检测 + 闘包校验
- [x] **M06** · [`test-topo`](./06-test-topo.md) — topo 单元测试
- [x] **M07** · [`prompts`](./07-prompts.md) — 6 类角色 prompt 模板
- [x] **M08** · [`agents`](./08-agents.md) — 6 类 Agent 封装（拼 prompt + 调 run-claude）
- [x] **M09** · [`stages`](./09-stages.md) — 7 个 Stage
- [x] **M10** · [`orchestrator`](./10-orchestrator.md) — 顶层循环 + 续跑
- [x] **M11** · [`cli`](./11-cli.md) — `src/bin/atlas.ts` 命令行
- [~] **M12** · [`smoke-e2e`](./12-smoke-e2e.md) — 端到端冒烟 + AC 自检（selfcheck 脚本 + 样本就位；真 claude run 受环境阻塞，详见 [`known-issues.md`](../known-issues.md)）

## 依赖关系（速览）

```
M00 ─┬─▶ M01 ─┬─▶ M03 ─▶ M10 ─▶ M11 ─▶ M12
     ├─▶ M02 ─┼─▶ M08 ─▶ M09 ─▶ M10
     ├─▶ M04 ─┤
     ├─▶ M05 ─┼─▶ M06
     └─▶ M07 ─┴─▶ M08
```

## 状态约定

| 标记 | 含义 |
|------|------|
| `[ ]` | 未开始 / 进行中 |
| `[x]` | 已完成：该模块所有子任务 `[x]`，且通过文件末「Done 标准」 |

> 完成一个模块后：把该模块文件的子任务勾掉 → 把本文件对应行勾掉 → 提交时写明 `feat(Mxx): <module>`。

## 总体里程碑

- [x] **里程碑 A（数据层通）**：M00–M06 完成，`bun test` 全绿（topo/pool/io/manifest/run-claude 共 134 用例 0 失败）。
- [x] **里程碑 B（单 Stage 通）**：M07–M08 完成，mock 可调起 Surveyor/Architect/Critic/Reader/Writer/Assembler，AC-7 只读不变量成立。
- [x] **里程碑 C（流水线通）**：M09–M11 完成，`runPipeline` mock 端到端跑通，AC-1/4/5/6/7 指标全绿（243 测试通过）。
- [~] **里程碑 D（验收通）**：M12 selfcheck+样本就位；真 claude run 受 headless 权限非确定性阻塞（AC-4/AC-7 已由单测+mock 验证通过，AC-1/2/3/5/6 待环境修复后复跑）。详见 [`known-issues.md`](../known-issues.md)。

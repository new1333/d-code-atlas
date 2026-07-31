# 需求文档 · Code Atlas

> 状态：v1（MVP 共识稿）。术语以 [`CONTEXT.md`](../CONTEXT.md) 为准，决策理由见 [`docs/adr/`](./adr/)。

## 1. 背景与目标

把"理解一个开源仓库"这件事**工程化**：输入任意开源仓库地址或本地目录路径，自动产出一套**自底向上、一步步讲清完整原理**的文档站（VitePress），并附带可运行的最小 ts/js 复刻代码。

核心理念：
- **高屋建瓴**：先俯瞰仓库架构，拆出核心概念，而非流水账式罗列文件。
- **自底向上**：章节按"原子概念 → 复合 → 系统"组织，每章的前置知识都已在前文讲过（可机器验证的依赖闭包）。
- **可复刻**：每章配一段最小可运行的 ts/js，把原理落到能跑的代码上。
- **可中断续跑**：每一步产物落盘，中断、换 session、甚至换机器都能接着跑。

## 2. 名词定义

见 [`CONTEXT.md`](../CONTEXT.md)。关键术语：Agent、Orchestrator、Repository Source、Run、Stage、Chapter、Layer、Work Artifact、Producer、Critic、Adversarial Review、Site。

## 3. 输入 / 输出

**输入**（二选一）：
- 开源仓库 URL（如 `https://github.com/owner/repo`）。
- 本地目录绝对/相对路径。

**输出**：`atlas/{repo}/site/` —— 一个**自包含、可独立部署**的 VitePress 文档工程。

## 4. 功能需求（FR）

### FR-1 取源与隔离
- FR-1.1 URL 输入 → `git clone --depth 1` 到 `work/source/`。
- FR-1.2 本地路径输入 → 原地只读直读（不复制）。
- FR-1.3 所有分析类 Agent 以只读工具运行（`--allowedTools Read,Glob,Grep`），**绝不写 Source**；写入仅限 `work/` 与 `site/`。（ADR-0005）

### FR-2 流水线（7 个 Stage）
| Stage | 能力 | 产物 |
|-------|------|------|
| Acquire | 取源 | `work/source/` |
| Survey | 扫描结构、入口、清单 | `work/repo-map.json` |
| Outline | 高屋建瓴拆章节、建依赖 DAG | `work/outline.json` |
| Research | 逐章精读源码 | `work/chapters/{slug}/research.md` |
| Write | 写章节 + 内嵌 ts/js 复刻 | `work/chapters/{slug}/draft.md` + `replica/` |
| Assemble | 组装完整 VitePress 工程 | `site/` |
| Build | 构建冒烟测试 | 构建日志 |

### FR-3 多 Agent 协作（6 类角色）
Surveyor / Architect / Critic / Reader / Writer / Assembler。每个 Agent = 一次带特定角色 prompt 的 `claude -p` 子进程调用。（ADR-0001）

### FR-4 对抗评审（替代人工关卡）
- FR-4.1 Outline 与每章 Write 都走 Producer⇄Critic 对抗评审。
- FR-4.2 Critic 返回 `approve`/`reject`+具体修改点；Producer 据此修订，**最多 2 轮**。
- FR-4.3 到上限仍未通过则接受最后版本并记录告警。（ADR-0004）

### FR-5 自底向上保证
- FR-5.1 每章在 `outline.json` 带 `dependsOn[]`。
- FR-5.2 最终章节顺序 = 对依赖图做拓扑排序。
- FR-5.3 Critic 校验：依赖图无环、且每章的 `dependsOn` 闭包都排在它之前。（ADR-0003）

### FR-6 断点续跑
- FR-6.1 每个 Stage 状态写入 `manifest.json`（`pending`/`running`/`done`/`failed`/`awaiting_*` + 时间戳 + 实际命令）。
- FR-6.2 续跑 = 读 manifest，重跑所有非 `done` 的 Stage。
- FR-6.3 支持 `--from <stage>` / `--only <stage>` / `--force`。（ADR-0002）

### FR-7 站点独立部署
- FR-7.1 `site/` 含 `package.json`（pin vitepress）、`.vitepress/config.ts`、`index.md`、`guide/{nn-slug}.md`。
- FR-7.2 侧边栏按 `level` 分组、章节按拓扑顺序自动排序编号。
- FR-7.3 `cd site && bun install && bun run docs:build` 即可构建部署。（ADR-0006）

### FR-8 CLI
- `atlas run <repo>`：新建或自动续跑 Run。
- `atlas resume <key> [--from <stage>] [--only <stage>] [--force]`：续跑/重跑。
- `atlas list`：列出已有 Run。
- `atlas clean <key>`：删除某 Run 的工作区。

## 5. 非功能需求（NFR）

- **NFR-1 技术栈**：运行时 Bun（1.3+）；引擎用 TypeScript。
- **NFR-2 不污染**：原仓库/本地源目录在分析前后内容**逐字节不变**。
- **NFR-3 可续跑**：任何 Stage 完成后中断，新 session 可无缝续上。
- **NFR-4 成本有界**：并发上限（默认 4）+ 评审轮数上限（2）+ 可配章数上限，避免大仓库失控。
- **NFR-5 可独立部署**：`site/` 不依赖引擎仓库的任何文件。
- **NFR-6 可调试**：任一 Stage 可单独重跑；每个 `claude -p` 的实际命令记入 manifest。

## 6. 范围

**MVP（本期）**：
- 上述 FR-1~FR-8 全部落地。
- 引擎与工作区同居于 `d-code-atlas/`（`src/` + `atlas/`）。
- 单仓库、单次分析为主。

**后续（非本期）**：
- 多仓库并发分析、`owner--repo` 防撞 key、按 commit pin。
- 人工 GATE 可选开关、交互式大纲编辑。
- 成本/Token 预算细粒度控制、增量更新（只重分析变更章节）。
- 部署一键发布（Vercel/Netlify/GitHub Pages 适配）。

## 7. 验收标准（AC）

- **AC-1（端到端·URL）**：给定一个公开 GitHub URL，`atlas run <url>` 完成后 `atlas/{repo}/site/` 存在，且 `cd atlas/{repo}/site && bun install && bun run docs:build` 成功产出 `dist/`。
- **AC-2（端到端·本地）**：给定本地路径，生成同样结构；分析前后对该目录做 `git status`（或哈希）无任何改动。
- **AC-3（续跑）**：在 Research 阶段中断后 `atlas resume <key>`，Survey/Outline 不重跑，从中断处继续。
- **AC-4（自底向上）**：生成的 `guide/` 章节顺序满足 `outline.json` 的 `dependsOn` 拓扑序（脚本可校验：无环、依赖闭包在前）。
- **AC-5（原理演示）**：每章 `draft.md` 含至少一段从零实现的最小演示代码块（载体按仓库主语言/类型选择，TS/JS/Go/Rust/Python 等均可；"能跑"非硬要求，VSCode扩展/插件/需宿主的机制可演机制骨架）；`work/chapters/{slug}/replica/` 若存在则与内嵌一致（stdout 模式下 replica 落盘非硬要求）。
- **AC-6（对抗评审）**：manifest 中 Outline 与每章 Write 的评审记录可查；存在 reject 时 draft 有对应修订。
- **AC-7（只读）**：所有分析 Agent 的 `claude -p` 命令均带 `--allowedTools Read,Glob,Grep`（manifest 可核验）。

## 8. 约束与假设

- 已安装：Bun、Claude Code CLI（已登录）、git。
- 被 `--allowedTools` 限制后，Agent 不会写 Source；该不变量靠工具权限强制，不靠 prompt 自觉。
- `dependsOn` 是**给读者的阅读顺序**，不是 agent 的生成顺序——逐章可并行。
- 章节质量最终取决于 LLM；对抗评审把"明显跑歪"挡住，但不保证学术级正确。

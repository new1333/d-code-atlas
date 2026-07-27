# Code Atlas

一个把"任意开源仓库"变成"自底向上的 VitePress 文档站"的系统：输入仓库地址或本地路径，输出一套可独立部署的文档源码，章节按"原子概念 → 复合 → 系统"自底向上组织。

> 本 `CONTEXT.md` 只记录领域语言（术语表），不写实现细节、不做规格说明。实现决策见 `docs/adr/`。

## Language

**Agent**:
一次带特定角色与职责的 Claude Code CLI 调用，产出一个或多个中间产物文件。不是常驻进程。
_Avoid_: worker, daemon, service

**Orchestrator**:
用 Bun 写的编排程序：负责按流水线顺序调起 Agent、管理文件 IO 与目录、组装最终站点。本身不做"理解源码"的智能工作。
_Avoid_: runner, pipeline engine（pipeline 见下，含义不同）

**Repository Source**:
一次分析的输入——一个 Git 仓库 URL 或一个本地目录路径。
_Avoid_: repo（口语可，术语用全称）, project

**Run**:
针对某一个 Repository Source 的一次完整分析流程，从取源到生成站点。每个 Run 的 key = 仓库目录名（URL 取 repo 段，本地路径取 basename，做安全转义）。同名仓库会共用并覆盖同一个 Run 目录（`atlas/{key}/`）——这是当前取舍：简单优先于防撞。
_Avoid_: job, task

**Stage**:
流水线里的一个步骤（如取源、结构扫描、生成大纲、逐章阅读、逐章写作、组装站点）。每个 Stage 有明确的输入产物和输出产物。
_Avoid_: step（口语可）

**Chapter**:
文档站的一个章节单元，对应仓库里的一个"可理解的概念"。每章带 layer（层级）和 dependsOn（前置章节），用以保证自底向上顺序。
_Avoid_: page, doc

**Layer**:
Chapter 在自底向上的概念层级：primitive（原子）/ composite（复合）/ system（系统）。决定章节排序与依赖。

**Work Artifact**:
某个 Stage 落盘的中间产物（如 `repo-map.json`、`outline.json`、章节草稿）。所有产物持久化，便于单独重跑与续跑。
_Avoid_: cache, temp（这些是可丢弃的；Work Artifact 不丢弃）

**Producer**:
产出某个草稿产物的 Agent（如 Architect 出大纲、Writer 出章节）。与 Critic 成对出现。
_Avoid_: generator

**Critic**:
对 Producer 的草稿做对抗性评审的 Agent：只依据明确的验收标准返回 `approve` / `reject` + 具体修改点，绝不自己生产最终内容。
_Avoid_: reviewer（太泛）, validator

**Adversarial Review**:
"生成 → 评审 → 修订"的循环：Producer 出草稿，Critic 挑战，Producer 据反馈修订，直至 Critic 通过或达到轮数上限。用于替代人工 GATE，在全自动流水线下保证质量。
_Avoid_: review loop（口语可）

**Site**:
最终输出的、可独立部署的 VitePress 文档源码工程。
_Avoid_: docs（与章节混淆）, output

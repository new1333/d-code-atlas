# 使用说明 · Code Atlas

> Code Atlas 是一个把「任意开源仓库」变成「自底向上、可独立部署的 VitePress 文档站」的引擎。
> 输入：仓库 URL 或本地目录路径；输出：`atlas/{key}/site/` 一个完整可构建的 VitePress 工程。
>
> 本文教你**怎么装、怎么跑、怎么看产物、怎么续跑、怎么验收**。术语见 [`CONTEXT.md`](../CONTEXT.md)，
> 设计见 [`design.md`](./design.md)，验收细则见 [`verification.md`](./verification.md)。

---

## 1. 环境准备

### 必装

| 工具 | 版本 | 用途 |
|------|------|------|
| [Bun](https://bun.sh) | ≥ 1.3 | 引擎运行时 + 测试 + 站点构建 |
| [Claude Code CLI](https://docs.claude.com/en/docs/claude-code) | 已登录可用 | 各 Agent 实际执行（`claude -p` 子进程） |
| git | 任意 | URL 取源（`git clone --depth 1`） |

确认：

```bash
bun --version        # 期望 1.3+
claude --version     # 期望有输出（已登录）
git --version
```

### 安装引擎依赖

```bash
cd d-code-atlas
bun install          # 仅装 dev 依赖（@types/bun + typescript），零运行时依赖
```

### 可选环境变量

| 变量 | 默认 | 作用 |
|------|------|------|
| `ATLAS_CLAUDE_BIN` | `claude` | 覆盖 claude 可执行路径（CI / 自定义安装位置） |

---

## 2. 三十秒上手

```bash
# 1) 跑一个公开 GitHub 仓库（推荐，源码会被克隆到 cwd 内，最稳定）
bun run src/bin/atlas.ts run https://github.com/octocat/Hello-World.git

# 2) 或跑本地目录（原地只读，不复制、不改源）
bun run src/bin/atlas.ts run ./samples/mini-signal

# 3) 看进度
bun run src/bin/atlas.ts list
bun run src/bin/atlas.ts show mini-signal

# 4) 跑完后，站点在这里：
cd atlas/mini-signal/site
bun install && bun run docs:build      # 产出 dist/，可部署
```

> ⚠️ 一次完整 run 会调用多次 `claude -p`（survey/outline/research×N/write×N/assemble），
> 耗时与 token 取决于仓库大小与章节数。先用小仓库试。

---

## 3. 命令手册

入口：`bun run src/bin/atlas.ts <命令> [参数] [flag]`
（`package.json` 的 `bin` 也注册了 `atlas`，`bun link` 后可直接 `atlas <命令>`）

### 3.1 `run` — 新建或自动续跑

```bash
atlas run <repo> [flags]
```

- `<repo>`：**GitHub URL**（`https://...` / `git@...`）或**本地目录路径**（相对/绝对）。
- 行为：
  - 先算 `key`（URL 取 repo 段、本地取 basename，转 kebab-case）。
  - **若 `atlas/{key}/manifest.json` 已存在 → 自动续跑**（从上次中断处继续，不重跑已完成的 stage）。
  - 否则新建 Run：URL → `git clone --depth 1`；本地 → 原地只读直读（**不复制、源目录逐字节不变**）。
- 成功退出码 0，失败 1。全部完成时最后打印 `[atlas] run {key} complete.`

**例：**

```bash
atlas run https://github.com/vuejs/core
atlas run ./my-local-project
atlas run ~/code/some-repo --skip-build           # 跳过最后的 vitepress 构建
atlas run ./samples/mini-signal --concurrency 2   # 逐章并发降到 2
```

### 3.2 `resume` — 续跑 / 重跑指定阶段

```bash
atlas resume <key> [--from <stage>] [--only <stage>] [--force]
```

- `<key>`：已存在的 Run 的 key（见 `atlas list`）。
- 默认：从第一个未完成的 stage 继续。
- `--from <stage>`：从指定 stage（含）起开始扫描。
- `--only <stage>`：只跑指定 stage。
- `--force`：把目标 stage（配合 `--from`/`--only`）重置为 pending 后重跑。

**例：**

```bash
atlas resume mini-signal                      # 从中断处继续
atlas resume mini-signal --from research      # 从 research 阶段起
atlas resume mini-signal --only outline       # 只重跑 outline
atlas resume mini-signal --from write --force # 强制重置 write 及之后重跑
```

### 3.3 `list` — 列出所有 Run

```bash
atlas list
```

输出每个 Run 的状态摘要，例：

```
mini-signal: acquire=done survey=done outline=done research=3/5 done write=0/5 pending assemble=pending build=pending
hello-world: acquire=done survey=done outline=done research=5/5 done write=5/5 done assemble=done build=done
```

（`research`/`write` 显示 `已完成章数/总章数`）

### 3.4 `show` — 打印某 Run 的详细状态

```bash
atlas show <key>
```

打印 manifest 摘要：各 stage 状态 + 时间戳、每章 research/write 状态，**以及对抗评审行**（AC-6 核验用）：

```
Run: mini-signal
source: local: ./samples/mini-signal → D:\...\samples\mini-signal

Stages:
  acquire=done   started=... finished=...
  survey=done    ...
  outline=done [review: approve, 1r]     ← 对抗评审：approve，1 轮
  research=done ...
  ...

Chapters:
  signal:  research=done write=done [review: approve, 1r]
  effect:  research=done write=done [review: accepted-with-warning, 2r]
  ...
```

### 3.5 `clean` — 删除某 Run 的工作区

```bash
atlas clean <key> [-y]
```

- 删除 `atlas/{key}/`（含所有中间产物与站点）。
- 默认交互确认（输入 `y`）；`-y`/`--yes` 跳过确认。
- 非 TTY 环境（CI/管道）默认**不删**（安全），需显式 `-y`。

### 3.6 全局 flag（`run`/`resume` 生效）

| flag | 默认 | 说明 |
|------|------|------|
| `--concurrency <n>` | 4 | 逐章并发上限（research/write 阶段） |
| `--review-rounds <n>` | 2 | 对抗评审（Producer⇄Critic）轮数上限 |
| `--skip-build` | 关 | build 阶段直接置 done，不真跑 `bun run docs:build` |
| `--model <name>` | claude 默认 | 透传给 claude 的 model 别名（如 `sonnet`） |
| `--from <stage>` | — | 见 resume |
| `--only <stage>` | — | 见 resume |
| `--force` | — | 见 resume |

其它：`-h`/`--help` 打印用法；`-v`/`--version` 打印 `atlas 0.1.0`。

**合法 stage 名**：`acquire` `survey` `outline` `research` `write` `assemble` `build`

---

## 4. 一次 Run 产生了什么

每个 Run 的工作区在 `atlas/{key}/`，结构如下：

```
atlas/{key}/
├── manifest.json              ← 状态真相源（续跑依据，被 git 跟踪）
├── work/
│   ├── source/                ← URL 克隆的源码（本地源不复制，无此目录）
│   ├── repo-map.json          ← Survey 产物：仓库结构测绘
│   ├── outline.json           ← Outline 产物：章节 + dependsOn + topoOrder
│   └── chapters/{slug}/
│       ├── research.md        ← Reader 产物：源码精读摘录（带「源码位置:」标注）
│       ├── draft.md           ← Writer 产物：章节正文（含内嵌 ts/js 复刻）
│       └── replica/*.ts|js    ← 可运行复刻代码副本
└── site/                      ← Assemble 产物：完整 VitePress 工程（自包含可部署）
    ├── package.json           ← pin vitepress + docs:dev/docs:build 脚本
    ├── index.md               ← 首页
    ├── .vitepress/config.ts   ← 侧边栏按 layer 分组、章节按 topo 序编号
    └── guide/
        ├── 01-{slug}.md       ← 各章（nn = topo 序号两位补零）
        ├── 02-{slug}.md
        └── ...
```

### 7 个 Stage 产出对照

| Stage | 产物 | 说明 |
|-------|------|------|
| acquire | `work/source/`（URL）或 manifest 记 sourcePath（本地） | 取源 |
| survey | `work/repo-map.json` | 结构测绘 |
| outline | `work/outline.json`（含 topoOrder） | 拆章 + 依赖 DAG + 对抗评审 |
| research | `work/chapters/{slug}/research.md` ×N | 逐章精读 |
| write | `work/chapters/{slug}/draft.md` + `replica/` ×N | 逐章写作 + 对抗评审 |
| assemble | `site/` | 组装 VitePress 工程 |
| build | `site/.vitepress/dist/` | 构建冒烟 |

---

## 5. 站点部署

`site/` 是**自包含**的 VitePress 工程，不依赖引擎仓库任何文件：

```bash
cd atlas/{key}/site
bun install            # 装 vitepress
bun run docs:dev       # 本地预览（默认 http://localhost:5173）
bun run docs:build     # 构建到 .vitepress/dist/
```

构建产物 `site/.vitepress/dist/` 可直接部署到 Vercel / Netlify / GitHub Pages 等任意静态托管。

---

## 6. 续跑与中断恢复（核心特性）

引擎**无运行时状态**——所有进度在 `manifest.json`。任何时刻中断（Ctrl-C、关机、换机器），再次 `atlas run <repo>` 或 `atlas resume <key>` 都能无缝续上：

- 已 `done` 的 stage/章节**不重跑**（节省 token 与时间）。
- `failed`/`pending` 的会继续。
- `manifest.json` 被 git 跟踪（`.gitignore` 只忽略 `work/source/`、`site/node_modules/`、`dist/`、`cache/` 这些重物），所以**可以提交 manifest 跨机器协作续跑**。

**典型续跑场景：**

```bash
# 跑到一半 Ctrl-C 中断
atlas run ./big-repo
# (中断)

# 查看断点
atlas show big-repo        # 看到 research 跑了 3/10 章

# 续跑（自动从第 4 章继续，survey/outline 不重跑）
atlas resume big-repo
```

---

## 7. 验收自检（AC-1..AC-7）

跑完一次 run 后，用一键脚本核验全部验收标准：

```bash
bash scripts/selfcheck.sh <key>
# 或跳过 vitepress 构建（只查结构）：
bash scripts/selfcheck.sh <key> --no-build
```

输出逐条 PASS/FAIL 汇总，覆盖：

| AC | 核验内容 |
|----|----------|
| AC-1 | `site/` 结构完整 + `bun run docs:build` 成功产出 `dist/` |
| AC-2 | 本地源只读不变（kind=local + 无克隆副本） |
| AC-3 | done 的 stage 有时间戳（续跑不重置） |
| AC-4 | outline 无环/无悬空/topoOrder 复算一致/依赖闭包满足/文件名编号==topo 序号 |
| AC-5 | 每章 draft 有代码块 + `replica/` 有可运行文件 |
| AC-6 | outline + 每章 write 有对抗评审 trace（rounds/final/trace） |
| AC-7 | 所有分析类 agent 的 cmd 含 `--allowedTools Read,Glob,Grep`（只读无逃生口） |

退出码：全 PASS → 0；任一 FAIL → 1。

---

## 8. 试跑样本仓库

仓库自带一个最小样本 `samples/mini-signal`（手写响应式原语：signal/effect/computed，3 层概念，适合验证自底向上拆章）：

```bash
# 先验证样本本身可跑
cd samples/mini-signal && bun run src/index.ts
# 期望输出：初始 doubled: 2 / effect 观察... / 改 count=5 后 doubled: 10

# 用它跑一次引擎
cd ../..
atlas run ./samples/mini-signal --skip-build
atlas show mini-signal
bash scripts/selfcheck.sh mini-signal --no-build
```

---

## 9. 只读隔离与安全

- **分析类 Agent**（Surveyor/Architect/Critic/Reader）工具集硬编码为 `Read,Glob,Grep`，**物理上无法写源码**（ADR-0005、AC-7）。
- **本地源逐字节不变**：本地路径输入原地只读直读，不复制、不写（NFR-2、AC-2）。
- **写入类 Agent**（Writer/Assembler）虽有 `Write/Edit`，但 cwd 与写范围被限定在 `work/chapters/{slug}/` 或 `site/`，物理上无法触及源码目录。

---

## 10. 常见问题

**Q: `atlas run` 在 survey 阶段失败，claude 说「无法访问源码目录」？**
A: 这是 claude CLI headless（`-p`）模式对 cwd 外目录访问的非确定性行为。引擎已通过 `--add-dir` + `--dangerously-skip-permissions` + 自动重试尽力缓解。**建议优先用 URL 源**（克隆后源在 cwd 内，更稳定）。详见 [`known-issues.md`](./known-issues.md)。

**Q: 想节省 token / 加快试跑？**
A: 用小仓库；加 `--skip-build` 跳过最后的 vitepress 构建；用 `--only <stage>` 单独重跑某阶段而非全跑。

**Q: 中间产物想自己看/改？**
A: 直接看 `atlas/{key}/work/` 下的 `repo-map.json`/`outline.json`/`research.md`/`draft.md`，都是可读 JSON/markdown。改后用 `--force --from <stage>` 重跑该阶段。

**Q: 怎么跑测试 / 检查类型？**
A: `bun test`（243 个单测）；`bunx tsc --noEmit`（类型检查）。

**Q: 怎么换 claude model？**
A: `--model sonnet`（透传给 claude）。

---

## 11. 相关文档

- [`CONTEXT.md`](../CONTEXT.md) — 领域术语表
- [`docs/requirements.md`](./requirements.md) — 需求（FR/NFR/AC）
- [`docs/design.md`](./design.md) — 详细设计（16 节）
- [`docs/adr/`](./adr/) — 6 条架构决策理由
- [`docs/verification.md`](./verification.md) — AC-1..7 逐条核验命令
- [`docs/known-issues.md`](./known-issues.md) — 已知问题与降级项
- [`docs/tasks/progress.md`](./tasks/progress.md) — 模块进度

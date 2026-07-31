# Repository Guidelines

Code Atlas 将任意开源仓库转化为可独立部署的 VitePress 文档站。本文面向引擎本身的贡献者。

## 项目结构与模块组织

- `src/` — 引擎源码：`lib/`（纯逻辑：IO、manifest、拓扑、并发池、Claude 运行封装）、`agents/`、`stages/`、`prompts/`（角色模板）、`bin/atlas.ts`（CLI 入口）。
- `test/` — 单元测试，与 `src/` 模块一一对应（`io.test.ts` 测试 `lib/io.ts`）。
- `docs/` — requirements、design、usage、verification，以及 `adr/` 与 `tasks/`。
- `atlas/<key>/` — 一次 Run 的产物：`manifest.json`、`work/` 中间产物与 `site/`（VitePress 工程）。
- `samples/mini-signal/` — 冒烟测试用的小型样例仓库；`scripts/selfcheck.sh` 按验收标准（AC-1..AC-7）核验产物。

## 构建、测试与开发命令

```bash
bun install                                      # 仅安装 dev 依赖（零运行时依赖）
bun run src/bin/atlas.ts run <repo|url>          # 对仓库执行完整流水线
bun run src/bin/atlas.ts list|show|resume|clean  # 查看或续跑 Run
bun test                                         # 运行全部测试
bunx tsc --noEmit                                # 类型检查（strict，不产出）
bash scripts/selfcheck.sh <key>                  # 按 AC-1..AC-7 核验某个 Run
```

生成的站点：`cd atlas/<key>/site && bun install && bun run docs:dev`（生产构建用 `docs:build`）。

## 编码风格与命名约定

- 严格 TypeScript、ESNext 模块；导入必须带显式 `.ts` 扩展名。
- 两个空格缩进，行尾分号。未配置格式化/lint 工具——与周围代码保持一致，并保证 `tsc --noEmit` 通过。
- 注释与提交信息使用中文；标识符用英文 camelCase。
- 使用 `CONTEXT.md` 中的领域词汇（Run、Stage、Chapter、Layer、Work Artifact、Producer、Critic）；避免 `job`、`task`、`page` 等替代表达。

## 测试指南

- 使用 `bun:test`（`describe`/`test`/`expect`），测试名用中文描述。
- 测试文件镜像模块路径：`test/<module>.test.ts`。
- 通过依赖注入 mock 外部副作用（Claude 子进程、git、构建）；单测中绝不真实调用 Claude，也不写到临时目录之外。
- 目前没有覆盖率门槛，但每个新的 `lib/` 模块与 CLI 行为都必须配套测试。

## 提交与 Pull Request 约定

- 遵循 Conventional Commits，scope 用里程碑编号，如 `feat(M12): ...`、`fix(M02): ...`、`docs(progress): ...`；摘要用中文。
- PR 中说明改了什么、为什么改，关联 `docs/tasks/` 下的任务文档，并确认 `bun test` + `bunx tsc --noEmit` 通过；仅 UI/站点输出变化需要截图。

## 配置与安全要点

- 可用 `ATLAS_CLAUDE_BIN` 环境变量覆盖 claude 可执行文件路径。
- 本地源只读（AC-2）：分析不得改动输入仓库。Agent 按工具白名单运行（见 `docs/adr/0005-source-is-read-only-to-agents.md`）。
- 不要提交 `atlas/*/work/source/`、`site/node_modules/` 与构建产物 `dist/`；`manifest.json` 与 `work/` 产物需入库。

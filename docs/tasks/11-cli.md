# M11 · cli

> `src/bin/atlas.ts` 命令行入口。
> 对应 design §13（CLI 设计）、§14（配置 flag）、requirements FR-8。

## 依赖
- M10 orchestrator
- M01 lib-io（keyFromRepo、runDir）
- M03 lib-manifest（load/show）

## 子任务

- [ ] `src/bin/atlas.ts`：argv 解析（command + 全局 flag），分发到子命令。可手写也可引轻量库（如 `cac`，但引擎追求零运行时依赖，倾向手写）。
- [ ] **子命令**：
  - [ ] `atlas run <repo>`：算 key（`keyFromRepo`）→ 若 manifest 已存在则续跑，否则 initManifest → `runPipeline`。
  - [ ] `atlas resume <key> [--from <stage>] [--only <stage>] [--force]`：读 manifest → 透传 flag → `runPipeline`。
  - [ ] `atlas list`：扫 `atlas/*/manifest.json`，打印 `{key}: {currentStage}` 一览。
  - [ ] `atlas clean <key>`：删除 `atlas/{key}/`（删前确认或加 `-y`）。
  - [ ] `atlas show <key>`：打印 manifest 摘要（各 stage 状态 + review 行，见 AC-6 期望格式）。
- [ ] **全局 flag**：`--concurrency <n>`（默认 4）、`--review-rounds <n>`（默认 2）、`--skip-build`、`--model <name>`（透传给 claude）、`--from`/`--only`/`--force`。
- [ ] 入口 shebang `#!/usr/bin/env bun` + `package.json` bin 字段（可选 `bun link`）。
- [ ] 错误提示：未知命令、key 不存在、source 路径不存在等给清晰文案 + 非零退出码。

## Done 标准
- 5 个子命令均可执行（`bun run src/bin/atlas.ts <cmd>`）。
- `atlas run <url|path>` 端到端能跑（依赖 M10）。
- `atlas show` 输出含 review 行（AC-6 核验用）。
- 全局 flag 正确透传到 orchestrator / run-claude。

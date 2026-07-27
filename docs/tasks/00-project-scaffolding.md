# M00 · project-scaffolding

> 项目脚手架。后续所有模块的地基。
> 对应 design §3（架构分层）、§12（目录结构）、§14（配置项）。

## 依赖
无。

## 子任务

- [ ] 创建 `package.json`：`name: "d-code-atlas"`、`"type": "module"`、`"private": true`；`scripts`：`dev` / `build`（tsc 或 bun build）/ `test`（bun test）；引擎本体**无运行时依赖**（仅 dev：`@types/bun`、`typescript`）。
- [ ] 创建 `tsconfig.json`：`target/module: ESNext`、`moduleResolution: bundler`、`strict: true`、`types: ["bun"]`、`rootDir: src`、`outDir` 视情况。
- [ ] 创建目录骨架：`src/{bin,stages,agents,prompts,lib}`、`docs/tasks/`（已存在）、`atlas/`（含 `.gitkeep`）。
- [ ] 创建 `.gitignore`：`node_modules/`、`atlas/*/`（保留 `atlas/.gitkeep`）、`*.log`、`.DS_Store`。
- [ ] 创建 `src/lib/config.ts`：导出常量
  - `DEFAULT_CONCURRENCY = 4`
  - `REVIEW_ROUNDS = 2`
  - `MAX_CHAPTERS = 24`
  - `SKIP_HEAVY_DIRS = ["node_modules", ".git", "dist", "build"]`
  - `READONLY_TOOLS = ["Read", "Glob", "Grep"]`
  - `WRITE_TOOLS = ["Read", "Glob", "Grep", "Write", "Edit"]`
  - `CLAUDE_BIN = "claude"`（可被 env 覆盖）
- [ ] （可选）`src/index.ts` barrel，留空或导出 config。

## Done 标准
- 目录骨架就位；`bun install` 无错。
- `bun run src/bin/atlas.ts`（即使尚无 CLI 实现，能跑出一个 stub 提示而不崩）。
- `config.ts` 各常量可被 `import` 引用。

# M02 · lib-run-claude

> 统一封装 `claude -p` 子进程调用：工具权限、cwd、超时、命令记录。
> 对应 design §2（执行模型）、§10（只读隔离 ADR-0005）、requirements FR-1.3 / FR-3。

## 依赖
- M00 project-scaffolding（config.READONLY_TOOLS / WRITE_TOOLS）

## 子任务

- [ ] 定义类型 `ClaudeRunOptions`：
  - `prompt: string`（用户 prompt，运行时拼接）
  - `systemPromptPath?: string`（指向 `prompts/{role}.md`，作系统级指令）
  - `cwd: string`（Agent 工作目录，限定到 run/site/chapter）
  - `tools: "readonly" | "write"`
  - `model?: string`、`timeoutMs?: number`、`env?: Record<string,string>`
- [ ] 定义类型 `ClaudeResult`：
  - `ok: boolean`
  - `exitCode: number`
  - `stdout: string`、`stderr: string`
  - `cmd: string`（规范化命令串，供 manifest 记录 + AC-7 核验）
- [ ] `runClaude(opts): Promise<ClaudeResult>`：
  - 根据 `tools` 选 `READONLY_TOOLS` / `WRITE_TOOLS`，组装 `--allowedTools`。
  - 组装命令：`claude -p <prompt> --allowedTools <...> [--model <m>] [--append-system-prompt @path]`（按本机 claude CLI 实际 flag 校准）。
  - `Bun.spawn`，cwd=opts.cwd，捕获 stdout/stderr，超时 kill。
  - 返回结构化结果；**非 0 / 超时不抛**，由 `ok=false` 表达（design §15：交用户重跑）。
- [ ] `buildCmd(opts)`：纯函数，拼命令串，便于单测与日志。
- [ ] cmd 规范化：含 `--allowedTools Read,Glob,Grep` 子串（AC-7 核验点）。
- [ ] 自测：`buildCmd` 对 readonly/write 两种 tools 产出正确串；可选冒烟跑一次 `claude -p "echo hi"`（需本机 claude 已登录）。

## Done 标准
- readonly 角色命令**必然**含 `--allowedTools Read,Glob,Grep`，无逃生口（ADR-0005）。
- `cmd` 字段可直接写进 manifest 并被 AC-7 脚本核验。
- 超时/非0退出返回 `ok=false`，不抛异常中断流水线。

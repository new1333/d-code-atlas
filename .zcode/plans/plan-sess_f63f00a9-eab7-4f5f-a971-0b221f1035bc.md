## 根因诊断（已用实测确认）

报错与 claude **完全无关**。真相是 **acquire 阶段的 `git clone` 失败**，控制台只打印了 `acquire failed` 没打原因，原因藏在 `atlas/pinia/manifest.json`：

```
git clone 失败 (exit=128):
fatal: unable to access 'https://github.com/vuejs/pinia/': schannel: failed to receive handshake, SSL/TLS connection failed
```

实测结论：
- 直连 github.com 被网络层 TLS 拦截（schannel/openssl/ssh 全失败）
- 你本地 **7897 端口**有代理（Clash/Mihomo mixed-port），经它 github 可访问
- 但该代理对 git smart-http 流式响应**不稳定**（实测 3 次 2 失败 1 成功，报 `fetch-pack: invalid index-pack output`）——所以必须加重试

## 修复方案（三层）

### 1. `src/lib/io.ts` — `cloneSource` 支持代理 + 重试 + 清理残留
- **加 proxy 参数**：`cloneSource(url, dest, opts?: { proxy?: string; retries?: number })`。
  - 有 proxy → 给 git 子进程注入 `-c http.proxy=<proxy>` 参数 + 设置 `HTTPS_PROXY`/`HTTP_PROXY` 环境变量（双保险）。
  - 读取优先级：显式 opts.proxy > 环境变量 `ATLAS_PROXY` > `HTTPS_PROXY` > `HTTP_PROXY`（不破坏 git 原生 env 行为）。
- **加重试**：默认重试 3 次（共 4 次尝试）。代理不稳定是这个场景的常态，单次成功≠稳定。
- **失败后清理 dest**：`git clone` 到非空目录会失败。每次尝试前若 dest 已存在则先 `rm -rf`，避免上次半截目录污染下次（这也是当前代码已存在的 bug——即便不走代理，任何一次 clone 失败后都无法直接重跑）。
- 错误信息增强：把重试次数、是否走代理写进错误摘要，便于诊断。

### 2. `src/stages/01-acquire.ts` + `src/stages/types.ts` + `src/orchestrator.ts` + `src/bin/atlas.ts` — 透传 proxy
- `StageContext` 加可选字段 `proxy?: string`。
- `RunPipelineFlags` 加可选字段 `proxy?: string`。
- orchestrator 构造 ctx 时透传 `flags.proxy`。
- CLI 加 flag：`--proxy <url>`（VALUE_FLAGS 注册），`toPipelineFlags` 读取。
- 也支持环境变量 `ATLAS_PROXY`（在 acquire 里 fallback 读取，这样用户不传 flag 设了 env 也能用）。

### 3. `src/bin/atlas.ts` — 失败时打印原因（治标性体验改进）
当前 `acquire failed` 后直接 `halted`，用户看不到原因得去翻 manifest.json。改为：失败终止时（orchestrator 返回 ok=false）打印 manifest 里对应 stage 的 `error` 字段摘要。这样以后任何 stage 失败，用户都能在控制台直接看到原因，不会再误判。

## 用户侧使用方式（修复后）
```bash
# 方式 A：每次显式传代理（推荐，明确）
bun run src/bin/atlas.ts run https://github.com/vuejs/pinia --proxy http://127.0.0.1:7897

# 方式 B：设环境变量（一次配置，所有 run 生效）
export ATLAS_PROXY=http://127.0.0.1:7897
bun run src/bin/atlas.ts run https://github.com/vuejs/pinia
```
重试由代码自动完成（默认 4 次尝试），无需手动反复跑。

## 验证
- 运行既有测试套件确保不破坏：`bun test`（重点 io/stages/cli/orchestrator）。
- `cloneSource` 是 `.todo` 未测的，本次也不引入需要网络的单元测试（遵循原约定「需 git+网络由冒烟覆盖」），但会加一个**不依赖网络**的单测：验证 proxy 传入时 spawn 收到的 args 含 `-c http.proxy=...`、env 含 `HTTPS_PROXY`（用注入的假 spawn 捕获）。
- 最后真跑一次 `bun run src/bin/atlas.ts run https://github.com/vuejs/pinia --proxy http://127.0.0.1:7897` 确认 acquire 通过。

## 不做的事
- 不改全局 git 配置（不污染你其它仓库的 push）。
- 不改 claude 相关代码（与本问题无关）。
- 不改 acquire 之外的 stage。
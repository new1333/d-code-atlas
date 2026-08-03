# CLI 多形态：dev/build/check/report/mcp · 源码精读

## 给 Writer 的教学钩子（必填，8 子项缺一不可）

- **用户痛点 / 场景**：同一个「分析 node_modules」的能力，使用者在五种不同情境下都想用：本地开发要看交互式 UI；CI 要在 PR 上跑「依赖有没有问题」的检查；维护者要在终端敲一行命令得到「哪些依赖该升」的人类可读表；脚本/agent 要拿到机器可读的 JSON；AI 编程助手要通过 MCP 把这些能力当工具调。如果为每种情境写一份独立逻辑，业务规则一改就要五处同步，必然漂移。

- **一句话核心思想**：**把 CLI 当成 RPC handlers 的「又一个传输层 + 渲染器」**——同一份计算结果，按场景选择不同的出口（HTTP / 静态文件 / stdout 表格 / stdout JSON / stdio MCP），而核心计算只写一遍。

- **设计动机（为什么需要它）**：本仓库的 RPC handlers（`getPayload`、`getPackagesNpmMeta`、`getPublint`…）天然是「纯函数 + 异步副作用」的集合。一旦计算核心被写成纯函数，CLI 子命令就只需要做三件事：① 喂参数；② 调函数；③ 把结果渲染成该场景想要的形状。把 CLI 重新定位成「调用方」而不是「并行实现」，从根上消灭了「UI 版本能算的，CI 版本算不出来」这类分叉。

- **关键权衡（本 Atlas 的核心）**：
  1. **「report 命令直接 import 计算函数，绕开 RPC wrapper」** → 换来**零序列化开销、最短调用路径**（CLI 进程内就能调 `computeMaintainerActions`，不必走 valibot 校验和 devframe 路由）→ 代价是**校验逻辑出现两份**：CLI 子命令靠 `cac` 的选项解析兜底，而 RPC wrapper 还各自带一份 valibot schema，规则一改两边都得动。
  2. **「把 root/config/depth 通过 devframe 的 `flags` 通道下沉到 `setup()`」** → 换来 **dev / build / mcp 三种传输共用一份 setup 代码**（`devframe.setup(ctx, { flags })` 是唯一入口）→ 代价是 **MCP 路径没有 flags**（devframe 的 MCP adapter 直接调 `setup()` 不传 flags），必须用 `NMI_CLI_*` 环境变量**搭桥**，CLI 侧的约定和 devframe 框架的约定耦合在一起。
  3. **「report 同一条计算路径同时渲染 ANSI 表 + JSON」** → 换来**「本地开发者看得舒服 + CI 能 grep/jq」双场景**（`--json` 一刀切）→ 代价是**格式化器严格分叉**：表渲染必须自己实现 `visualWidth`/`stripAnsi`/`padRight`（因为带 ANSI 转义的字符串 `String.length` 会对不齐），而 JSON 路径必须先 `toMaintainersGroupDto` 把循环引用 / 函数字段剥成纯数据。
  4. **「`build` 子命令把 RPC 定义里标了 `jsonSerializable: true` 的方法显式收集进静态 dump」** → 换来**静态前端能跳过不可序列化的方法**（如 `openInEditor`）→ 代价是**每加一个 RPC 方法都要手动标 `jsonSerializable`**，漏标则在静态模式下消失，是隐性维护负担。

- **最小心智模型（5 步）**：
  1. 一份 **handlers 工厂**（`createInspectorRpcHandlers`）是所有形态的共同入口；它返回的是「带缓存的 Promise」而不是裸值。
  2. **dev / mcp / build** 三种形态把 handlers 包成 `defineRpcFunction`，由 devframe 路由到不同传输。
  3. **check / report** 形态不需要传输层，直接在进程内调 `handlers.getPayload()`（其中 `mode: 'build'` 触发 publint + npm meta 副作用）。
  4. **report** 拿到 payload 后，按 `type` 调对应 `compute*` 纯函数（maintainers / duplicates / sizes）。
  5. 最后一步分叉：`--json` 走 `JSON.stringify(dto)`，否则走 `format*` 渲染 ANSI 表 → 都写到 `process.stdout`。

- **最小原理演示（替代旧"复刻范围"）**：
  - **应演示**：一个 ~50 行的 Node 脚本，演透「一份计算核心 + 多种渲染出口」这条核心思想。具体：定义一个 `analyze(root)` 异步函数返回假数据（如 `{ duplicates: [...], sizes: [...] }`），然后用 `cac` 注册三个子命令——`check`（只跑分析、不输出细节）、`report <type>`（带 `--json` 分叉）、`mcp-bridge`（演示用环境变量传 flags）。**关键是要在脚本里把「同一个 analyze 被三种命令调用、渲染分叉成 stdout 文本 vs JSON」演出来**——这条就是上面权衡 1 和权衡 3 的最小化身。
  - **应故意省略**：devframe 集成、真实的 npm meta 拉取、valibot schema 校验、HTML 子路径 rewrite、静态 dump 文件生成、ansi 颜色细节——这些都是工程化脚手架，不是原理。
  - **演示载体建议**：TS/JS 仓库，**建议写成能 `node`/`bun` 直接跑的脚本**（main 入口 + 三个子命令）。无需 devframe、无需真网络。一段「假 analyze + cac 三子命令 + 双渲染分支」就够演透原理；不需要真打包成 bin。

- **正文不宜展开的细节**：
  - `cac` 的具体 API（`.option()`、`.action()`、默认值与类型推断）——读者可查 cac 文档。
  - `unconfig` 怎么找配置文件、合并策略细节——属于配置层。
  - `build` 子命令里对 `_nuxt/`、`baseURL:"/"` 的字符串 replace-all —— 是 Nuxt 静态部署的工程化补丁，与原理无关。
  - 各 report 类型的业务语义（迁移比例怎么算、catalog 是什么）—— 这些是 `maintainer-action-cohort` 章的内容。
  - devframe 框架本身的 RPC 注册机制 —— 是 `devframe-rpc` 章的内容。

- **推荐的一个执行轨迹例子**：
  - 输入：`node-modules-inspector report maintainers --json --limit 5`
  - 中间态：`cac` 解析 → `runReport({ type: 'maintainers', json: true, limit: 5 })` → `createInspectorRpcHandlers({ mode: 'build', quiet: true, ... })` → `handlers.getPayload()`（内部跑 `listPackageDependencies`、并发跑 publint + npm meta）→ `computeMaintainerActions({ packages, versions, catalogs })` → `groupMaintainerActions(items, { sort, authorFilter, ... })` → `groups.slice(0, 5)` → `toMaintainersGroupDto` → `JSON.stringify(dto, null, 2)`
  - 输出：stdout 写一段缩进 2 空格的 JSON 数组，结尾带 `\n`

> 以上钩子供 Writer 写「动机→核心思想→心智模型→关键权衡→原理演示」；下面事实部分供核对，不要被 Writer 当目录照抄。

## 概念要点

- **入口非常薄**：`bin.mjs` 只有 shebang + 顶层 `await import('./dist/cli.mjs')`，所有逻辑都在打包后的 `dist/cli.mjs`（即 `src/node/cli.ts` 编译产物）。源码位置: packages/node-modules-inspector/bin.mjs:1-5
- **CLI 框架选 cac**：`cac('node-modules-inspector')` 创建实例，串行注册 5 个子命令（含一个空名命令 = 默认 `dev`），最后 `cli.help()` + `cli.parse()`。源码位置: packages/node-modules-inspector/src/node/cli.ts:23,243-244
- **5 个子命令一一对应 5 种形态**：默认（dev）、`build`（静态产物）、`check`（CI 不启服务）、`report <type>`（人工/机器两读）、`mcp`（stdio MCP server）。源码位置: packages/node-modules-inspector/src/node/cli.ts:25,113,152,180,221
- **`check` 命令的精髓是「跑分析 + 跑 `onPayloadReady` hook」但不启服务器**：直接 `import('./rpc/handlers')`、构造 handlers、`await handlers.getPayload()`，任何错误 `process.exit(1)`，让用户在 `node-modules-inspector.config.ts` 里写 `onPayloadReady` 抛错即可做 CI gate。源码位置: packages/node-modules-inspector/src/node/cli.ts:152-178
- **`report` 与 `check` 都传 `mode: 'build'`**：这是触发 `_getPayload` 内部「publint 并发跑 + npm meta 批量取」的副作用开关；`mode: 'dev'` 则把这些推迟到前端按需触发。源码位置: packages/node-modules-inspector/src/node/cli.ts:165, run-report.ts:55；handlers.ts:155-182
- **`report` 命令绕开 RPC wrapper**：直接 `import { computeDuplicates } from '../../shared/reports/duplicates'`，调纯函数；不像 `rpc/report-duplicates.ts` 那样走 `defineRpcFunction` + valibot schema。源码位置: packages/node-modules-inspector/src/node/cli-report/run-report.ts:5-10, 72-109；对比 packages/node-modules-inspector/src/node/rpc/report-duplicates.ts:17-33
- **`runReport` 是 report 形态的统一调度器**：构造 handlers → `getPayload()` → 按 `type` 分三类（duplicates / sizes / maintainers），每类内部都是「`compute*(payload, opts)` → `--json ? toJson : format*` → `write`」。源码位置: packages/node-modules-inspector/src/node/cli-report/run-report.ts:51-121
- **`--json` 切换的是「DTO + JSON.stringify」 vs 「ANSI 表」**：表渲染分支调 `formatMaintainers(dto)` / `formatDuplicates(data)` / `formatSizes(data)`；JSON 分支调 `toJson(data)` = `JSON.stringify(data, null, 2) + '\n'`。源码位置: packages/node-modules-inspector/src/node/cli-report/run-report.ts:77,86,107,115-117
- **`build` 子命令的静态 dump 机制**：用 `collectStaticRpcDump(ctx.rpc.definitions.values(), ctx)` 把所有标了 `jsonSerializable: true` 的 RPC 方法的结果序列化成文件；同时写 `connection.json` 列出静态后端可用的 `jsonSerializableMethods`，让前端 backend 据此降级。源码位置: packages/node-modules-inspector/src/node/cli.ts:65-89
- **`mcp` 子命令用环境变量搭桥**：因为 devframe 的 MCP adapter 调 `setup(ctx)` 不传 `info.flags`，CLI 必须把 root/config/depth/quiet 写到 `NMI_CLI_CONFIG` / `NMI_CLI_DEPTH` / `NMI_CLI_QUIET` 三个环境变量里，setup 内部回退到环境变量。源码位置: packages/node-modules-inspector/src/node/cli.ts:226-241；packages/node-modules-inspector/src/node/devframe.ts:36-49
- **`defineConfig` 是个 1 行 identity 函数**：仅用于让用户写配置文件时拿到类型推断（`NodeModulesInspectorConfig`），运行期等价于 `config => config`。源码位置: packages/node-modules-inspector/src/node/config.ts:3-5
- **`runReport` 内部维护一份独立的 versions map**：`buildVersionsMap(packages)` 把 `payload.packages` 按 `pkg.name` 重新分桶，供 `computeMaintainerActions` 用——这是因为同一个包名可能因多版本出现多次。源码位置: packages/node-modules-inspector/src/node/cli-report/run-report.ts:38-49, 91-97
- **`limit` 在 maintainers 路径里特殊处理**：先 `groupMaintainerActions` 算全量、再 `groups.slice(0, limit)`、再 `toMaintainersGroupDto`——即 limit 作用于「分组后」而非「原始 item 后」。源码位置: packages/node-modules-inspector/src/node/cli-report/run-report.ts:105-107
- **ANSI 表对齐靠自实现的 `visualWidth`**：因为 `c.bold(...)` 等会插入 `\x1B[1m...\x1B[22m` 转义字符，`String.length` 会偏大；`stripAnsi` 用正则 `/\x1B\[[0-9;]*m/g` 剥离后再 `.length` 才是肉眼宽度。源码位置: packages/node-modules-inspector/src/node/cli-report/format-util.ts:18-27
- **`renderTable` 跳过最后一列的右侧填充**：避免表格右边缘出现无意义的尾随空格（`if (i === lastIndex) return s`）。源码位置: packages/node-modules-inspector/src/node/cli-report/format-util.ts:54-64
- **`formatBytes` 自适应精度**：< 10 用 2 位小数、< 100 用 1 位、否则整数；单位走 B/KB/MB/GB/TB。源码位置: packages/node-modules-inspector/src/node/cli-report/format-util.ts:5-16
- **`formatMaintainers` 在「无作者」时让该行变空字符串**：`authors` 字段用 `filter(Boolean)` 在 join 前过滤，使无作者的 consumer 不会留一行空白。源码位置: packages/node-modules-inspector/src/node/cli-report/format-maintainers.ts:11-14,39
- **`cli.ts` 大量使用动态 `import()`**：`./rpc/handlers`、`./cli-report/run-report`、`devframe/adapters/mcp` 都在 action 内部才加载，让 `--help` 和未选中子命令不付出整棵依赖的解析成本。源码位置: packages/node-modules-inspector/src/node/cli.ts:158-159,199,234
- **`dev` 子命令调 `handlers['nmi:get-payload']?.then(fn => fn?.())` 预热**：服务起来后立刻触发一次 payload 计算（哪怕没人请求），让首个真实请求秒回；注释里写了「rpcGroup.functions is a Proxy returning Promise<handler>」。源码位置: packages/node-modules-inspector/src/node/cli.ts:147-149

## 关键调用链

**report 形态（人工/机器两读）**：
```
cac.parse()
  → run-report.ts:runReport({ type, json, ... })
    → createInspectorRpcHandlers({ mode: 'build', quiet: true, storage* })
    → handlers.getPayload()
      → _getPayload() → listPackageDependencies(...) + publint + npm meta
    → { duplicates: computeDuplicates(packages, opts)
      | sizes:       computeInstallSizes(packages, opts)
      | maintainers: toMaintainersGroupDto(groupMaintainerActions(computeMaintainerActions({packages,versions,catalogs}), opts).slice(0,limit)) }
    → options.json ? JSON.stringify(data, null, 2)
                  : format{Duplicates,Sizes,Maintainers}(data)
    → process.stdout.write(text + '\n')
```
源码位置: packages/node-modules-inspector/src/node/cli.ts:193-219；packages/node-modules-inspector/src/node/cli-report/run-report.ts:51-121

**check 形态（CI 不启服务）**：
```
cac.parse()
  → cli.ts:check action
    → import('./rpc/handlers').createInspectorRpcHandlers({ mode: 'build', ... })
    → handlers.getPayload()   // 触发 onPayloadReady hook；hook 抛错 → process.exit(1)
```
源码位置: packages/node-modules-inspector/src/node/cli.ts:152-178；packages/node-modules-inspector/src/node/rpc/handlers.ts:199-211

**mcp 形态（stdio + 环境变量搭桥）**：
```
cac.parse()
  → cli.ts:mcp action
    → process.env.NMI_CLI_{CONFIG,DEPTH,QUIET} = ...
    → process.chdir(options.root)
    → import('devframe/adapters/mcp').createMcpServer(devframe, { transport: 'stdio' })
      → devframe.setup(ctx)  // 无 flags → 回退到 env
        → createInspectorRpcHandlers({ configFile: env.NMI_CLI_CONFIG, depth: env.NMI_CLI_DEPTH, quiet: true })
        → ctx.rpc.register(reportDuplicatesRpc(handlers)) / reportMaintainersRpc / reportSizesRpc / ...
```
源码位置: packages/node-modules-inspector/src/node/cli.ts:221-241；packages/node-modules-inspector/src/node/devframe.ts:36-60

## 源码摘录（带行号，全文累计 ≤ 30 行）

**cac 注册子命令的典型形态（默认 dev 命令）**：
```ts
// packages/node-modules-inspector/src/node/cli.ts:113-150（节选）
cli
  .command('', 'Start dev inspector')
  .option('--root <root>', 'Root directory', { default: process.cwd() })
  .option('--host <host>', 'Host', { default: process.env.HOST || '127.0.0.1' })
  .option('--port <port>', 'Port', { default: process.env.PORT || 9999 })
  .option('--auth', 'Require the one-time-code auth handshake before RPC calls')
  .action(async (options) => {
    const auth = options.auth ?? (host === '0.0.0.0' || host === '::')
    const server = await createDevServer(devframe, { host, port, flags: { root, config, depth, auth }, openBrowser })
    // Warm the payload; rpcGroup.functions is a Proxy returning Promise<handler>.
    handlers['nmi:get-payload']?.then(fn => fn?.()).catch(() => {})
  })
```

**report 命令分叉 ANSI / JSON 的核心**：
```ts
// packages/node-modules-inspector/src/node/cli-report/run-report.ts:72-107（节选）
if (options.type === 'duplicates') {
  const data = computeDuplicates(payload.packages.values(), { minVersions, limit })
  write(options.json ? toJson(data) : formatDuplicates(data))
}
if (options.type === 'maintainers') {
  // ...
  const dto = limited.map(toMaintainersGroupDto)
  write(options.json ? toJson(dto) : formatMaintainers(dto))
}
function toJson(data: unknown) { return `${JSON.stringify(data, null, 2)}\n` }
```

**MCP 子命令的环境变量搭桥**：
```ts
// packages/node-modules-inspector/src/node/cli.ts:226-240（节选）
if (options.config) process.env.NMI_CLI_CONFIG = options.config
process.env.NMI_CLI_DEPTH = String(Number(options.depth))
process.env.NMI_CLI_QUIET = '1'
if (options.root && options.root !== process.cwd()) process.chdir(options.root)
const { createMcpServer } = await import('devframe/adapters/mcp')
await createMcpServer(devframe, { transport: 'stdio', onReady })
```

**ANSI 表自实现 visualWidth（避开转义干扰对齐）**：
```ts
// packages/node-modules-inspector/src/node/cli-report/format-util.ts:18-31（节选）
const ESC = String.fromCharCode(0x1B)
const ANSI_RE = new RegExp(`${ESC.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\[[0-9;]*m`, 'g')
export function stripAnsi(s: string): string { return s.replace(ANSI_RE, '') }
export function visualWidth(s: string): number { return stripAnsi(s).length }
export function padRight(s: string, width: number): string {
  const diff = width - visualWidth(s)
  return diff > 0 ? s + ' '.repeat(diff) : s
}
```

## 易混淆 / 边界 / 推断

- **事实**：`runReport` 里 `Array.isArray(options.author) ? options.author : options.author ? [options.author] : []` 这一行等价于 `options.author ? [].concat(options.author) : []`——重复分支是 cac `--author` repeatable 选项的两种形态（单值 vs 数组）的归一化，没有副作用。源码位置: packages/node-modules-inspector/src/node/cli.ts:200-204
- **事实**：`report` 子命令的 `--limit` 在 maintainers 路径是「分组后切片」，在 duplicates / sizes 路径是「`compute*` 内部 limit」（语义一致：返回条目数上限），但实现位置不同。源码位置: run-report.ts:73-87 vs 105-107
- **事实**：`build` 子命令里 `baseURL` 的三步归一化（末尾补 `/` / 开头补 `/` / 多斜杠合并）保证了后续 HTML 字符串替换不会重复斜杠。源码位置: packages/node-modules-inspector/src/node/cli.ts:38-43
- **推断**：`mcp` 命令选择 `console.error` 输出 ready 消息（而非 `console.log`）是因为 MCP 协议规定 stdout 是 JSON-RPC 通道，任何人类可读日志必须走 stderr 才不污染协议——这点没有显式注释，但从 MCP 规范 + `NMI_CLI_QUIET=1` 的存在可推断。源码位置: packages/node-modules-inspector/src/node/cli.ts:230,237-239
- **推断**：`createInspectorRpcHandlers` 接受 `quiet?: boolean` 把日志改写到 stderr，就是为了让 `report --json` 的 stdout 严格只输出 JSON（避免日志混进 JSON 解析）；handlers.ts 的注释 `Route progress logs to stderr (keeps stdout clean for JSON/MCP)` 直接证实。源码位置: packages/node-modules-inspector/src/node/rpc/handlers.ts:24-26,38-40；run-report.ts:57
- **事实**：`defineConfig` 完全不在 CLI 子命令里被调用——它是给**用户**在 `node-modules-inspector.config.ts` 里写配置时用的类型 helper；CLI 走 `unconfig` 的 `loadConfig` 找这个文件。源码位置: packages/node-modules-inspector/src/node/config.ts:3-5；packages/node-modules-inspector/src/node/rpc/handlers.ts:53-70
- **边界**：`build` 子命令对 HTML 的字符串替换（`"/_nuxt/"`、`baseURL:"/"`）是 Nuxt 特定补丁，换前端框架就失效；这是工程化细节，不参与「核心原理」。源码位置: packages/node-modules-inspector/src/node/cli.ts:91-107
- **未理解**：`cli.ts:148` 把 `rpcGroup.functions` 强转成 `Record<string, Promise<...>>` 并直接索引 `nmi:get-payload`——这一「Proxy 返回 Promise<handler>」语义来自 devframe 框架的内部约定，没有本仓库源码可佐证其细节；后续读到 `devframe-rpc` 章节时应交叉验证。
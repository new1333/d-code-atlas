# CLI 多形态：dev / build / check / report / mcp

想象你做了个能分析 `node_modules` 的工具，会跑出「哪些依赖重复了、哪些应该升级、安装体积多大」这种结果。然后你发现 5 个完全不同的人都想用它：

- 本地开发的人，想在浏览器里点交互式 UI
- CI 跑 PR 的人，想要一个 exit code——成功 0、失败 1，别的不在乎
- 维护者，想在终端敲一行命令直接看到一张人类可读的表
- 写自动化脚本的人或 AI agent，想拿到 JSON
- AI 编程助手（Cursor、Claude Code 这种），想通过 MCP 把这些能力当工具调

如果你为这 5 种情境各写一份逻辑，「什么算重复」这个判定规则一改，就得在 5 个地方同步改。改着改着，UI 版本算得出来的，CI 版本算不出来——这种事在大型项目里天天发生。

## 这一章要解决的核心问题

把「算依赖分析」这件事想成一家小餐厅的厨房，5 个命令就是 5 个不同的传菜窗口：

- **dev**：菜端进堂食大厅（交互式 UI）
- **build**：菜做成预制菜冷链配送（静态 JSON + HTML，可部署）
- **check**：只在后厨尝一口——咸了就扔、不咸就过，不传给任何人（CI gate）
- **report**：菜做成菜单目录，一张是给人看的（表格），一张是给机器解析的（JSON）
- **mcp**：菜做成外卖供别人点单（stdio 协议给 AI 调用）

5 个窗口，一个厨房。

说人话就是：**CLI 不再「实现」分析能力，而是「调用」分析能力，然后挑个合适的方式把结果端出去。** 同一份计算结果，按场景挑不同的出口。

## 自底向上看：从计算核心到 5 个出口

要理解这套设计，先看最底下那一块——所有命令共用的「计算核心」。

### 第 0 层：一份 handler 工厂，是所有命令的共同入口

整个仓库的分析能力（列依赖、算重复、跑 publint、拉 npm 元信息、判定维护者行动）都被装在一个工厂函数里：

```ts
const handlers = createInspectorRpcHandlers({
  mode: 'build',          // 'dev' 把副作用推迟到前端按需触发, 'build' 立刻跑
  quiet: true,            // 日志走 stderr, 不污染 stdout
  // ...
})

// handlers 里每个方法都是「带缓存的 Promise」, 不是裸值
const payload = await handlers.getPayload()
```

这块函数返回的不是数据，是「承诺未来给你数据的 Promise」——像一张取餐小票：你拿到的时候菜可能还没做好，但你随时可以 `await` 等着。

每个命令的第一步都是把 handlers 构造出来。差别只在：构造完之后，handlers 走哪条出口。

### 第 1 类出口：dev / build / mcp —— 走 devframe 框架路由

这三种命令都需要「传输层」——把 handlers 包装成可以被远端调用的东西。它们用 `defineRpcFunction` 把每个 handler 包成 RPC 方法，扔给 devframe 框架，剩下的就交给框架决定：

- `dev`：走 HTTP / WebSocket，浏览器请求进来 → 框架找到对应 handler → 调它
- `build`：在打包阶段把每个 handler 的结果算出来，序列化成静态 JSON 文件
- `mcp`：走 stdio，按 MCP 协议（JSON-RPC over stdin/stdout）把 handler 暴露给 AI

换句话说，这三种命令其实只是 devframe 框架的三个 adapter，差别全在「传输介质」上，业务代码不变。

### 第 2 类出口：check / report —— 不走传输层，进程内直接调

`check` 是给 CI 用的，要做的事很简单：

1. 调 `handlers.getPayload()` 把所有依赖算一遍
2. 在用户配置文件里允许写一个 `onPayloadReady` hook
3. hook 想抛错就抛（比如「发现高危依赖」），`check` 抓到错误 → `process.exit(1)`

CI 上你只要 exit code，不启服务器、不出 HTML。

`report` 是给人/机器看表的。它跟 `check` 一样，也是进程内调 `handlers.getPayload()` 拿结果，然后再往下走一步：把 payload 喂给纯计算函数（`computeDuplicates` / `computeSizes` / `computeMaintainerActions`），算出具体那张表要展示的数据，最后渲染出去。

一行 `report maintainers --json --limit 5` 大概经过这样的流水线：

```
cac 解析命令行参数
  → runReport({ type: 'maintainers', json: true, limit: 5 })
    → createInspectorRpcHandlers({ mode: 'build' })
    → await handlers.getPayload()         // 这里真跑 publint + npm meta
    → computeMaintainerActions(payload)   // 纯函数, 不再有副作用
    → groupMaintainerActions(...)         // 按 maintainer 分组
    → groups.slice(0, 5)                  // limit 作用在分组后
    → toMaintainersGroupDto(...)          // 把循环引用/函数字段剥成纯数据
    → JSON.stringify(dto, null, 2)
  → process.stdout.write(json + '\n')
```

注意一个细节：`limit` 在 maintainers 路径上是「分组后再切片」，而不是「算之前砍掉一批」——意思是先看清楚全貌，再决定展示多少。这跟「先 limit 再算」是两套语义。

## 最小原理演示：一份 analyze，三种渲染

光看结构图不顶用，我们手搓一个 ~60 行的脚本演透这条核心思想。这段代码不真去分析 node_modules——用一个返回假数据的 `analyze()` 函数代替，但**三个子命令共享同一份 analyze、然后各自挑渲染出口**这件事是真的：

```ts
// demo.ts —— 用 `node demo.ts` 或 `bun demo.ts` 直接跑
import { createRequire } from 'module'
const cac = createRequire(import.meta.url)('cac')

// === 第 0 层: 计算核心 (只写一遍) ===
async function analyze(root: string) {
  // 真仓库这里要跑 pnpm ls、跑 publint、拉 npm 元信息……我们假装一下:
  return {
    duplicates: [
      { name: 'lodash', versions: ['4.17.20', '4.17.21'], consumers: 8 },
      { name: 'tslib',  versions: ['2.4.0', '2.5.0'],      consumers: 12 },
    ],
    sizes: [
      { name: 'lodash', bytes: 1_400_000 },
      { name: 'tslib',  bytes: 12_000 },
    ],
  }
}

// === 第 1 个子命令: check —— 只跑分析, 失败就 exit 1 ===
cac.command('check').action(async () => {
  try {
    const result = await analyze(process.cwd())
    if (result.duplicates.length > 100) {
      throw new Error(`too many duplicates: ${result.duplicates.length}`)
    }
    console.log(`ok, ${result.duplicates.length} duplicates`)
    process.exit(0)
  } catch (e) {
    console.error(String(e))
    process.exit(1)
  }
})

// === 第 2 个子命令: report <type> —— 表格 vs JSON 双分支 ===
function toJson(d: unknown) { return JSON.stringify(d, null, 2) + '\n' }
function formatTable(rows: { name: string; versions: string[]; consumers: number }[]) {
  return rows
    .map(r => `${r.name.padEnd(20)} ${r.versions.join(', ').padEnd(20)} ${r.consumers}`)
    .join('\n') + '\n'
}

cac.command('report <type>')
  .option('--json', 'machine-readable output')
  .action(async (type, opts) => {
    const data = await analyze(process.cwd())
    if (type === 'duplicates') {
      process.stdout.write(opts.json ? toJson(data.duplicates) : formatTable(data.duplicates))
    } else if (type === 'sizes') {
      process.stdout.write(opts.json ? toJson(data.sizes) : formatTable(data.sizes))
    } else {
      console.error(`unknown type: ${type}`)
      process.exit(1)
    }
  })

// === 第 3 个子命令: mcp-bridge —— 用环境变量搭桥 (下面权衡 2 会讲为什么) ===
cac.command('mcp-bridge')
  .option('--root <path>')
  .option('--depth <n>')
  .action((opts) => {
    if (opts.root)  process.env.NMI_DEMO_ROOT  = opts.root
    if (opts.depth) process.env.NMI_DEMO_DEPTH = String(opts.depth)
    console.error('[mcp-bridge] ready, flags flushed to env')  // 注意: 走 stderr
    // 真仓库这里会 `import('devframe/adapters/mcp').createMcpServer(...)`
  })

cac.help()
cac.parse()
```

跑起来效果：

```
$ node demo.ts report duplicates
lodash              4.17.20, 4.17.21     8
tslib               2.4.0, 2.5.0         12

$ node demo.ts report duplicates --json | jq '.[0].name'
"lodash"

$ node demo.ts check
ok, 2 duplicates

$ node demo.ts mcp-bridge --depth 3 --root /tmp/proj
[mcp-bridge] ready, flags flushed to env
```

关键观察：三个命令调的是**同一个 `analyze()`**——这就是「计算核心只写一遍」的体现。`check` 拿到结果直接判 exit code；`report` 拿到结果按 `--json` 切渲染；`mcp-bridge` 因为下面要讲的框架限制，先把 flags 灌到 env 里。

## 关键权衡：为什么这么设计

这一章机制集中，4 条权衡全来自「一份计算 + 多种渲染」这条核心思路在落地时碰到的小裂缝。一条条展开。

### 权衡 1：report 直接 import 计算函数，绕开 RPC wrapper

想象 `report maintainers` 这个命令。它要算出维护者行动列表，有两种实现方式：

- **A 方案**：走 RPC 路径——用 `defineRpcFunction` + valibot schema 注册一个 `nmi:report-maintainers` 的 RPC 方法，CLI 在进程内「假装自己是客户端」调它
- **B 方案**（实际选择）：CLI 直接 `import { computeMaintainerActions } from '../../shared/reports/maintainers'`，跳过 RPC 框架，直接调纯函数

为什么选 B？看两条路径：

```
A 方案:
  CLI 进程 → 模拟 RPC 调用 → valibot schema 校验入参 → 调 compute →
  valibot schema 校验出参 → 序列化 → 反序列化 → 返回

B 方案:
  CLI 进程 → 直接调 compute → 返回
```

B 方案砍掉了两条没必要的弯路。**入参出参的 valibot 校验**——在同一个进程里、参数都是自己构造的，再校验纯属浪费；**序列化-反序列化**——同进程调一个函数，根本不需要把对象变成 JSON 再变回来。

但代价是：**校验逻辑出现两份**。

- RPC wrapper 那边对每个方法都有一份 valibot schema（给浏览器/webcontainer 调用时用）
- CLI 这边靠 cac 的选项解析兜底（`--limit` 是数字、`--author` 是字符串数组）

业务规则一改——比如某天决定 `--limit` 还要支持 `"all"` 这种特殊值——两边都得动。漏一边就是 UI 能调、CLI 不能调（或反过来）的分叉。

### 权衡 2：flags 通过 devframe 下沉到 setup —— 但 MCP 路径要用环境变量搭桥

`dev` / `build` / `mcp` 三个命令都要传一组相同的运行参数：`--root`、`--config`、`--depth`、`--quiet`。如果三个命令各自把这些参数喂给 handlers，代码就要写三遍。

实际选择是把这些参数打包成 `flags` 对象，扔给 devframe 的 `setup(ctx, { flags })` 入口，让框架统一拿：

```ts
// dev / build 的简化路径
const server = await createDevServer(devframe, {
  host, port,
  flags: { root, config, depth, auth }  // ← flags 走这条路
})
```

三个命令共用一份 setup 代码，以后 setup 改了（比如新增 `--no-color`），只动一处。

代价来了：devframe 的 MCP adapter **不接受 `flags` 参数**——它直接 `setup(ctx)` 不传第二参。这是个框架层面的限制，本仓库改不了。

那 MCP 命令怎么办？**用环境变量搭桥**：

```ts
// mcp 子命令的 action 里:
if (options.config) process.env.NMI_CLI_CONFIG = options.config
process.env.NMI_CLI_DEPTH = String(Number(options.depth))
process.env.NMI_CLI_QUIET = '1'
await createMcpServer(devframe, { transport: 'stdio' })

// setup() 内部, 当拿不到 flags 时回退到 env:
function getFlags(ctx) {
  return ctx.info?.flags ?? {
    config: process.env.NMI_CLI_CONFIG,
    depth:  Number(process.env.NMI_CLI_DEPTH),
    quiet:  process.env.NMI_CLI_QUIET === '1',
  }
}
```

说人话就是：**MCP 路径没有正规的 flags 通道，只能绕到环境变量这条野路子**。`NMI_CLI_*` 这套前缀成了 CLI 跟 devframe 之间的私下约定——一边写了不写另一边就读不到。

代价具体长什么样：

- **耦合**：CLI 侧（`NMI_CLI_CONFIG` 的命名）和 setup 侧（读这个名字）是隐性契约，改命名要两边改
- **隐式**：从一个 env 变量推断 CLI flag，比从函数参数推断难得多——env 是进程全局的，任何代码都能改它，调试时还得多绕一圈「是哪个进程改了 env」

好处也实打实：少写一份 MCP 专属的 setup 入口。

### 权衡 3：同一条计算路径，渲染分叉成 ANSI 表 + JSON

`report` 命令同时服务两类用户：

- **维护者在终端敲**：希望看到颜色、对齐的表格
- **CI / 脚本调用**：希望拿到能 `grep`、能 `jq` 的 JSON

如果分两个命令（`report` vs `report-json`），业务逻辑要复制。实际选择是**一个命令、一个 `--json` flag**，在最后一步渲染时一刀切：

```ts
const data = computeDuplicates(payload.packages, opts)
write(opts.json ? toJson(data) : formatDuplicates(data))
```

这条看起来 trivial，但代价藏在两边各自的「形状要求」里。

**JSON 路径的形状要求**：输出必须是纯数据——不能有循环引用、不能有函数字段、不能有 Date 对象（会变成字符串）。所以从 `compute*` 出来的对象要先过一道 `toMaintainersGroupDto`，把那些「业务对象」剥成「数据传输对象（DTO）」：

```ts
// compute 返回的业务对象: 有循环引用、有方法
const items = computeMaintainerActions({ packages, versions, catalogs })

// 剥成 DTO: 纯数据
const dto = groups.map(toMaintainersGroupDto)

// 这才能安全 stringify
JSON.stringify(dto, null, 2)
```

**表格路径的形状要求**完全相反：它要的是带 ANSI 颜色转义的可视字符串，而且得自己算「肉眼宽度」做对齐——因为 `c.bold('lodash')` 返回的字符串里夹了 `\x1B[1m...\x1B[22m` 这种转义字符，`.length` 数出来的会比肉眼看到的字符多：

```ts
// 真仓库里自己实现的 visualWidth
const ESC = String.fromCharCode(0x1B)
const ANSI_RE = new RegExp(`${ESC}\\[[0-9;]*m`, 'g')
function stripAnsi(s: string)   { return s.replace(ANSI_RE, '') }
function visualWidth(s: string) { return stripAnsi(s).length }
function padRight(s: string, width: number) {
  const diff = width - visualWidth(s)
  return diff > 0 ? s + ' '.repeat(diff) : s
}
```

换句话说，**两个渲染器各自要解决的问题根本不一样**。JSON 解决「剥字段」，表格解决「对齐可视宽度」。一条 `--json` 切换让它们看起来像兄弟，其实是两个完全独立的格式化器，各自维护各自的边界条件（JSON 那边要小心循环引用，表格这边要小心最后一列别加多余空格）。

代价具体长什么样：

- 每加一种 `report type`（比如未来想加 `report licenses`），**要写两个 format 函数**（`format*` + DTO 转换），漏一个就有功能 bug
- DTO 的字段集合跟纯函数返回的业务对象的字段集合是**两份**，要保持同步——业务对象加了个字段，DTO 那边忘了加，`--json` 输出就少一项，但表格还能展示；反过来也成立

附带一个细节：`report --json` 走的时候，handlers 里所有进度日志会被改写到 stderr（构造时传 `quiet: true`）。原因就是 stdout 必须严格只输出 JSON，任何「正在拉取 lodash 的 npm 信息……」这种日志混进来都会破坏 JSON 解析。这是个不起眼但很重要的设计——stdout 和 stderr 严格分工，stdout 永远是「数据」。

### 权衡 4：build 命令显式标 `jsonSerializable` 跳过不可序列化的方法

`build` 命令要把所有 RPC 方法的结果算出来，序列化成静态 JSON 文件，供静态部署的前端读。但有些 RPC 方法天生没法序列化——比如 `openInEditor`，它返回的不是数据，是个副作用（打开 VS Code 跳到某行）。

实际选择是在 `defineRpcFunction` 注册时给方法打个标：

```ts
defineRpcFunction({
  name: 'nmi:get-payload',
  jsonSerializable: true,    // ← build 时会被收进静态 dump
  // ...
})

defineRpcFunction({
  name: 'nmi:open-in-editor',
  // jsonSerializable 没写, 默认 false → build 时跳过
  // ...
})
```

`build` 命令在打包阶段遍历所有 RPC 方法定义，只把标了 `jsonSerializable: true` 的方法结果序列化进文件，同时写一份 `connection.json` 告诉前端「静态模式下哪些方法可用」：

```ts
// 伪代码:
const jsonSerializableMethods = []
for (const def of ctx.rpc.definitions.values()) {
  if (def.jsonSerializable) {
    const result = await def.handler(args)
    dumpFile(`data/${def.name}.json`, JSON.stringify(result))
    jsonSerializableMethods.push(def.name)
  }
}
dumpFile('connection.json', JSON.stringify({ methods: jsonSerializableMethods }))
```

代价是：**每加一个 RPC 方法都要手动决定打不打这个标**。漏标了，这个方法在 dev 模式工作得好好的，但 build 出来的静态站点里它就**消失**了——前端不知道有这能力，backend 列表里也没有，UI 对应的按钮在静态模式下不会出现。bug 不会立刻暴露，要等到有人真的部署静态站点、点那个按钮时才发现「咦怎么没了」。

这是隐性维护负担，典型的「配置即文档，文档易腐」——`jsonSerializable` 这条标记应该是 RPC 方法本身的属性，但没人会回头审计所有方法的标记是不是合理。

## 收尾：这一章到底在教什么

回望一下，5 个命令看起来像 5 个独立功能，但拆开看它们共享一套底层——一份计算 handler 工厂。5 个命令各自决定三件事：

1. **要不要传输层**：dev/build/mcp 要（走 devframe），check/report 不要（进程内调）
2. **要不要立刻跑副作用**：check/report 设 `mode: 'build'` 立刻跑 publint + npm meta，dev 设 `mode: 'dev'` 推迟到前端按需触发
3. **怎么渲染**：dev 出 HTML、build 出静态 JSON、check 出 exit code、report 出表格/JSON、mcp 出 MCP 协议

学这一章的核心收获不是「5 个命令怎么用」，而是看懂**「把 CLI 当成 RPC handlers 的又一个传输层」**这个设计姿势——只要计算核心是纯函数，CLI 子命令就只剩「喂参数 + 调函数 + 渲染」三件事。下次你设计一个「同一份业务规则、多个出口」的工具（比如 KPI 看板同时支持 Web / 邮件 / Slack / Excel 导出），这条思路可以直接套：先抽出纯计算函数，再加 N 个薄薄的 renderer。

代价也清楚——校验、序列化、配置标记这些「形状约束」会在每个出口各自出现一份，要靠纪律守住一致性。这是「一份计算 + 多种渲染」必然付出的税，跑不掉，只能透明地记账。
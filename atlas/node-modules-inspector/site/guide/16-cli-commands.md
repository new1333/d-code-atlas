# CLI 多形态：dev/build/check/report/mcp

> 本章属于 system 层。前置：devframe RPC、维护者行动算法。
> 学完你能用一句话讲清：为什么 CLI 子命令不是「五份独立实现」，而是「一份计算核心 + 五个出口选择器」，以及为了这个共用付了什么代价。

上一章把 inspector 搬进了浏览器——WebContainer 让你不用装 Node 也能在网页里 `pnpm install` 然后实时分析。但浏览器只是入口之一。一个真实使用者手上至少还有四种情境想用同一份能力：本地开发要看交互式 UI；CI 要在 PR 上跑「依赖有没有问题」的检查；维护者要在终端敲一行命令拿到「哪些依赖该升」的表；脚本和 AI 编程助手要拿到机器可读的结构化数据。本章就接着这个口子讲：怎么把这同一份计算结果，分发到五种不同形态的出口上。

## 1. 为什么需要它（设计动机）

最朴素的做法是给每种情境各写一份代码：dev 命令拉起 HTTP 服务；check 命令复制粘贴一份分析逻辑；report 命令又写一份；mcp 命令再写一份。这种做法在前几周能跑，但只要业务规则改一次（比如「重复检测的最小版本阈值要不要把 workspace 算进去」），就要去五个文件里同步改五次。改到第三遍你一定会漏掉一个，于是出现一种很尴尬的故障：UI 版本能算出来的报告，CI 跑出来的是另一份。

这个矛盾不是某个仓库的偶然现象，它是所有「同一份核心能力要喂给多种使用情境」的工具都会撞上的问题——核心逻辑天然只有一份，但出口形态是发散的。要么你承认发散、写五份各自漂移；要么你想办法把发散的部分收成一个薄薄的「出口选择器」，让业务规则只活在一个地方。本章讲的机制就是后一种解法。

## 2. 核心思想

把 CLI 当成 RPC handlers 的「又一个传输层 + 渲染器」。同一份计算结果，按场景选择不同的出口——HTTP 服务、静态文件、stdout 表格、stdout JSON、stdio MCP——而核心计算只写一遍。

这句话和「为什么需要它」的角度不太一样：「为什么需要它」讲的是使用者会被五份代码漂移烦到；这一节点透的是：**把「调谁」从显式编排变成隐式的入口选择**。CLI 子命令不参与计算，它只决定「同一个 handler 被调出来之后结果往哪儿送」。

## 3. 心智模型

整个 CLI 内部分两层：

- **共同入口**：一份 handlers 工厂（`createInspectorRpcHandlers`），它接受 `cwd / depth / configFile / mode / storage*` 这些外部依赖，闭包出 6 个方法（`getPayload`、`getPackagesNpmMeta`、`getPublint` 等）。**注意它返回的是「带缓存的 Promise」而不是裸值**——第一次 `await handlers.getPayload()` 会真去读盘 + 拉网络，之后所有调用复用同一份结果。这条「调用即缓存」的契约，是五种形态能共用一份 handler 的物理基础。
- **五个子命令**：每个子命令做三件事——① 用 `cac` 把命令行参数解析成 handler 工厂需要的形态；② 拿到 handlers 之后决定怎么调；③ 把结果按这个命令独有的出口渲染出去。

五个命令按出口形态可以分成两类：

| 形态 | 调用方式 | 出口 |
|---|---|---|
| `dev` | handlers 包成 RPC，devframe 路由 | HTTP + 浏览器 UI |
| `build` | 同上，但收集 `jsonSerializable:true` 方法落盘 | 静态文件目录 |
| `mcp` | 同上，devframe MCP adapter 接管 | stdio JSON-RPC |
| `check` | 进程内直调 `handlers.getPayload()` | exit code |
| `report <type>` | 进程内直调 handler，再调 `compute*` 纯函数 | stdout（表/JSON 二选一） |

前三者（dev/build/mcp）共享 devframe 那套 RPC 路由；后两者（check/report）不走 RPC 包装，直接在 Node 进程里把 handler 当普通异步函数调。这条分叉是全章最关键的一刀，下面的权衡会专门讲。

## 4. 关键权衡

### report 直调纯函数，绕开 RPC wrapper

`report maintainers` 这条命令要拿到的「该升哪些依赖」列表，本质上是 `computeMaintainerActions(payload, ...)` 这个纯函数的输出。这个函数同时存在两套调用入口：前端通过 RPC（`defineRpcFunction` 包过、带 valibot schema 校验、走 devframe 路由），以及本仓库内部直接 import。

report 命令选择了第二条路：直接 `import { computeMaintainerActions } from '../../shared/reports/maintainers'`，在 Node 进程里把它当普通函数调。换来的是**零序列化开销 + 最短调用路径**——不需要把 payload 序列化成 JSON 再走一层 RPC 协议再反序列化回来，结果就在同一个内存里。代价是**校验逻辑出现两份**：CLI 子命令靠 `cac` 的选项解析兜底（`Array.isArray(options.author) ? ... : options.author ? [...] : []` 这种归一化），RPC wrapper 那边还各自带一份 valibot schema。规则一改两边都得动。

这条权衡化解的本质矛盾是「**进程内调用的零成本 vs. 边界处调用的强校验**」——一个函数同时被进程内代码和外部协议调用时，你总得在「内调时跳过校验省一遍开销」和「统一走带校验的入口保证规则只有一份」之间选一个。这个矛盾在所有「同一份核心被多入口调用」的工具里都会出现，认出它就能解释为什么很多 CLI 都有个绕过 RPC 的「直调快车道」。

### 把 root/config/depth 通过 devframe 的 flags 通道下沉到 setup()

dev / build / mcp 三个命令都需要把 `--root / --config / --depth` 这几个 CLI 选项传进 handler 工厂。如果每个命令各自构造一遍，三处构造代码必然漂移。本仓库把这三个值打包成 `flags` 对象，由 `devframe.setup(ctx, { flags })` 这个统一入口接收，setup 内部再展开传给 `createInspectorRpcHandlers`。

换来的是** dev / build / mcp 三种传输共用一份 setup 代码**——三个命令只是把不同 CLI 选项塞进同一个 flags 对象，setup 不关心自己被哪个命令调。代价是 **MCP 路径被排除在这条通道之外**：devframe 的 MCP adapter 调 `setup(ctx)` 时**不传** `info.flags`。为了让 MCP 命令也能拿到 root/config/depth，CLI 必须把它们写到 `NMI_CLI_CONFIG / NMI_CLI_DEPTH / NMI_CLI_QUIET` 三个环境变量里，setup 内部回退到环境变量读取。

这条权衡化解的本质矛盾是「**框架约定的入口 vs. 框架特定 adapter 的盲区**」——当你把参数下沉到一个外部框架的统一入口，就得接受这个框架某些 adapter 不走这个入口的现实，于是需要在两个约定之间架一座桥。环境变量搭桥是一种朴素的兜底：把「当前进程的参数」写成「当前进程的环境」，让任何不传 flags 的 adapter 都能从环境里捞回来。这种桥很丑但很稳，是工程里到处可见的「契约不齐时」的补救模式。

### report 同一条计算路径同时渲染 ANSI 表和 JSON

`report` 命令的卖点是用 `--json` 一刀切：不带 `--json` 给你彩色对齐的 ANSI 表，带上 `--json` 给你机器可读的 JSON 数组。两条路径**共用同一份计算**——`computeMaintainerActions` 只跑一次，结果交给不同的渲染器。

代价是**格式化器必须严格分叉**，两边各自不能将就对方：

- 表渲染必须自己实现 `visualWidth` / `stripAnsi` / `padRight`——因为带 ANSI 转义的字符串 `String.length` 会偏大（`\x1B[1m` 这种 4 字符转义肉眼只占 0 宽度），用 `.length` 对齐表格一定会歪。所以渲染前要先 strip 转义、算真实可见宽度、再按宽度补空格。
- JSON 路径必须先 `toMaintainersGroupDto` 把原始结果剥成纯数据——`computeMaintainerActions` 返回的对象里挂着 `PackageNode` 实例（带循环引用、带函数字段），直接 `JSON.stringify` 会炸。DTO 转换就是把所有非纯数据字段拍平。

这条权衡化解的本质矛盾是「**人类可读 vs. 机器可读**」——前者要排版、对齐、配色、留白；后者要规范、稳定、可 grep、可 `jq`。两种诉求在「同一份输出」里不可兼得，于是认输、分叉、各跑各的渲染器。在所有「既要给开发者看，又要给 CI grep」的 CLI 工具里你都能找到同样的分叉，`--json` 是这种分叉的统一开关。

### build 显式收集 jsonSerializable 方法到静态 dump

`build` 命令的目标是把整套 inspector 打包成静态文件托管。但 handler 工厂里不是所有方法都能序列化成 JSON——`openInEditor` 要 spawn 子进程，根本没法 dump。如果一股脑全 dump，会在序列化阶段直接抛错。

本仓库的做法是给每个 RPC 方法挂一个 `jsonSerializable: true` 的元数据标志。`build` 命令遍历所有 definition，只把带这个标志的方法调一遍、结果落盘，同时写一份 `connection.json` 列出可用的 `jsonSerializableMethods`，让前端 backend 据此降级。

换来的是**静态前端能优雅跳过不可序列化的方法**——前端读 `connection.json` 知道哪些能力在静态模式下不存在，直接隐藏对应 UI（编辑器按钮、finder 按钮等）。代价是**每加一个 RPC 方法都要手动标 `jsonSerializable`**——漏标则在静态模式下整个方法消失，是隐性维护负担，加方法的人不会立刻意识到自己需要在静态模式跑一遍。

这条权衡化解的本质矛盾是「**能力清单是动态的 vs. 序列化边界是静态的**」——你能往 handler 工厂里随便加方法，但「能不能落盘」是每个方法各自的物理属性（有没有副作用、有没有循环引用、有没有不可序列化的字段）。`jsonSerializable` 标志就是把这层物理属性**显式化**，让 build 这条静态通道只挑安全的子集。任何「动态能力池 + 静态导出」的系统（GraphQL persisted queries、tRPC procedures、Electron IPC）都需要类似的「可序列化白名单」。

## 5. 最小原理演示

下面这段 ~60 行的脚本只演透一件事：**一份计算核心 + 多个出口**。三个子命令（`check` / `report` / `mcp-bridge`）共用同一个 `analyze`，渲染分叉成「无输出 + exit code」「ANSI 表 vs JSON」「环境变量搭桥」。devframe、真实 npm meta、valibot schema、HTML rewrite 一律不演。

```ts
import process from 'node:process'

// ---------- 计算核心：唯一的一份业务逻辑 ----------
async function analyze(root: string) {
  // 真仓库里这里是 listPackageDependencies + publint + npm meta
  // 这里用假数据演「带缓存的 Promise」这条契约
  return {
    duplicates: [
      { name: 'lodash', versions: ['4.17.20', '4.17.21'], consumers: 12 },
      { name: 'tslib',  versions: ['2.3.0', '2.5.0'],     consumers: 7  },
    ],
    sizes: [
      { name: 'lodash', bytes: 1_400_000 },
      { name: 'core-js', bytes: 980_000 },
    ],
  }
}

// ---------- 渲染器：两条严格分叉的出口 ----------
function toJson(data: unknown) {
  return JSON.stringify(data, null, 2) + '\n'
}
function formatDuplicatesTable(duplicates: Array<{ name: string; versions: string[]; consumers: number }>) {
  // 演一下「表渲染必须自己算宽度」这件事
  const rows = duplicates.map(d => [d.name, d.versions.join(' / '), String(d.consumers)])
  const w1 = Math.max(4, ...rows.map(r => r[0].length))
  const w2 = Math.max(8, ...rows.map(r => r[1].length))
  const head = `name${' '.repeat(w1 - 4)}  versions${' '.repeat(w2 - 8)}  consumers`
  const body = rows.map(r => `${r[0].padEnd(w1)}  ${r[1].padEnd(w2)}  ${r[2]}`).join('\n')
  return head + '\n' + '-'.repeat(head.length) + '\n' + body + '\n'
}

// ---------- 子命令 1：check —— 直调、不渲染、靠 exit code 通信 ----------
async function runCheck(root: string) {
  try {
    await analyze(root)  // 跑通了就过；任何 throw 都变成 exit 1
    process.stderr.write('ok\n')
  }
  catch (e: any) {
    process.stderr.write(`✖ ${e.message}\n`)
    process.exit(1)
  }
}

// ---------- 子命令 2：report —— 同一计算、--json 一刀切渲染分叉 ----------
async function runReport(root: string, type: 'duplicates' | 'sizes', json: boolean, limit?: number) {
  const payload = await analyze(root)
  const data = type === 'duplicates'
    ? payload.duplicates.slice(0, limit ?? payload.duplicates.length)
    : payload.sizes.slice(0, limit ?? payload.sizes.length)
  // --json 一刀切：表 vs JSON
  const text = json
    ? toJson(data)
    : type === 'duplicates' ? formatDuplicatesTable(data as any) : toJson(data)
  process.stdout.write(text)  // JSON 严格只走 stdout；人类日志走 stderr
}

// ---------- 子命令 3：mcp-bridge —— 演环境变量搭桥 ----------
async function runMcpBridge(root: string, config: string | undefined, depth: number) {
  // devframe 的 MCP adapter 不会把 flags 传进 setup；这里靠环境变量搭桥
  if (config) process.env.NMI_CLI_CONFIG = config
  process.env.NMI_CLI_DEPTH = String(depth)
  process.env.NMI_CLI_QUIET = '1'
  // 真 setup 内部会从 env 兜底回这些值；这里只演「约定不齐时用环境变量搭桥」
  process.stderr.write(`mcp ready (depth=${process.env.NMI_CLI_DEPTH})\n`)
}

// ---------- cac 风格的子命令分派（简化版） ----------
const [, , subcommand, ...rest] = process.argv
if (subcommand === 'check') {
  await runCheck(process.cwd())
}
else if (subcommand === 'report') {
  // report <type> [--json] [--limit <n>]
  const type = rest[0] as 'duplicates' | 'sizes'
  const json = rest.includes('--json')
  const limitIdx = rest.indexOf('--limit')
  const limit = limitIdx >= 0 ? Number(rest[limitIdx + 1]) : undefined
  await runReport(process.cwd(), type, json, limit)
}
else if (subcommand === 'mcp') {
  await runMcpBridge(process.cwd(), undefined, 8)
}
```

三个子命令共享同一个 `analyze`，没人复制业务逻辑；`--json` 决定走哪条渲染器；`mcp-bridge` 演了环境变量搭桥。这就是全章核心思想的最小化身。

## 6. 执行轨迹

拿 `nmi report maintainers --json --limit 5` 走一遍，看一个具体输入怎么穿过上面这套机制：

1. **`cac.parse()` 解析** → `{ type: 'maintainers', json: true, limit: 5, root: cwd, depth: 8, sort: 'depth', authors: [], ... }`，其中 `authors` 经历过「单值/数组归一化」变成 `[]`。
2. **进入 `runReport`** → `createInspectorRpcHandlers({ mode: 'build', quiet: true, storage* })` 构造出 handlers。`mode: 'build'` 这一位是触发副作用的开关——它让 `_getPayload` 内部不仅跑 `listPackageDependencies`，还会**并发跑 publint + 批量拉 npm meta**；`mode: 'dev'` 则把这部分推迟到前端按需触发。`quiet: true` 让所有进度日志改写到 stderr，**stdout 严格只输出 JSON**，否则日志会混进 JSON 解析。
3. **`await handlers.getPayload()`** → 第一次调用真去读盘 + 拉网络；这份 Promise 被缓存住，后面再调同一个 handlers 实例的 `getPayload` 都拿到同一份结果。返回的 payload 里有 `packages`（依赖图）、`versions`（隐式）、`catalogs`（pnpm catalog 表）。
4. **`buildVersionsMap(packages)`** → 按 `pkg.name` 重新分桶，得到 `Map<string, PackageNode[]>`。这一步是 maintainers 路径独有的预处理——同一个包名可能因多版本出现多次。
5. **`computeMaintainerActions({ packages, versions, catalogs })`** → 这就是上一章讲透的「按 depName 聚合 cohort → semver 范围判定 → 按 consumer 分组」算法，返回一份原始 item 列表。
6. **`groupMaintainerActions(items, { sort, authorFilter, ... })`** → 按排序/作者过滤聚合成 group，每个 group 对应一个 depName。
7. **`groups.slice(0, 5)`** → 这一步是 maintainers 路径的特殊点：`limit` 作用于**分组后**而非原始 item 后，所以「limit 5」是「最多 5 个 depName」而不是「最多 5 个 item」。
8. **`limited.map(toMaintainersGroupDto)`** → 把原始 group 对象剥成纯数据 DTO（拍平 `PackageNode` 实例、剥掉函数字段、消解循环引用）。
9. **`JSON.stringify(dto, null, 2) + '\n'`** → 缩进 2 空格的 JSON 数组。
10. **`process.stdout.write(text)`** → stdout 写一段 JSON，结尾带 `\n`。

如果同一个命令去掉 `--json`，第 8 步之后的 DTO 会进入 `formatMaintainers(dto)`：算每列的 `visualWidth`、`padRight` 对齐、给表头加粗（`\x1B[1m...\x1B[22m`），最后输出一段彩色 ANSI 表。同一条计算路径，两种渲染，零重复业务逻辑。

## 7. 教学简化说明

本章演示故意省略了这些工程化脚手架：devframe 的 RPC 注册与传输适配（web socket、静态 dump 文件格式、MCP 协议握手）、真实的 npm registry 拉取与 TTL 缓存、valibot schema 校验、`build` 命令对 Nuxt HTML 里 `"/_nuxt/"`、`baseURL:"/"` 的字符串替换、ANSI 颜色与 `c.dim` 装饰的具体转义、`limit` 在 duplicates / sizes 路径里语义一致但实现位置不同的细节。这些都不参与「一份计算核心 + 多个出口」这条核心原理。

## 8. 小结

这一章只造了「出口选择器」这一个外壳——把同一份 handler 工厂的结果，分别送进 HTTP 服务、静态目录、exit code、stdout 表、stdio MCP 五个喉咙。它本身不参与任何业务计算，只决定「同一个数怎么被包装出去」。下一章会跟着这份 payload 走进它最后一段路：进了浏览器之后，五张图（treemap、sunburst、flamegraph、graph、grid）是怎么从同一份依赖图里长出来的。

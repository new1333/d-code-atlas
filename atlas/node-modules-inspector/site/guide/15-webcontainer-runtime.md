# WebContainer：浏览器里跑真 pnpm

> 本章属于 system 层。前置：devframe RPC、Backend 抽象。
> 学完你能用一句话讲清：为什么 WebContainer 选了一条简陋的 stdout 前缀通道，又为什么这个选择让浏览器侧只能轮询。

## 1. 为什么需要它

上一章留了一个 Backend 接口，让 dev、static、webcontainer 三种形态能在同一份代码里切换；但 webcontainer 这态到底是怎么实现的，浏览器里怎么真跑起 pnpm、装好的包又怎么传回前端，上一章只用一个 `isDynamic` 一笔带过，本章就来填这个坑。

想象你刚看到一个有意思的 npm 包，想知道它依赖了什么、装出来多大、模块格式合不规范。两条老路都不舒服：本地 `pnpm i` 要 Node 环境、要污染磁盘、要等几分钟；上 npmjs 看静态信息，版本号有，但 `workspace:` 协议怎么解析、`overrides` 改了什么、phantom dependency 有没有，统统看不到。这些信息天生要在装好 `node_modules` 之后才能算出来，纯静态分析根本读不到。

可要让任意网页访客都能跑 `pnpm install`，又不能要求他们装本地工具。WebContainer 这个把 Node 跑在浏览器里的运行时正好把"真安装"和"零安装"两个原本矛盾的能力合并了：浏览器里跑的是真 Node，能 `pnpm install` 任意包。剩下的问题只有一个：浏览器里跑的这个进程，分析结果怎么传回来。

## 2. 核心思想

把一个真正能跑 Node 的运行时塞进浏览器，然后用一段魔法前缀把它的 stdout 变成结构化数据通道。

说人话就是：server 进程每次往 stdout 喷东西，都先在前面贴一个固定的小标签；浏览器收到一段 stdout 就先看标签，标签在的，这是给程序读的数据；标签不在的，这是给用户看的日志。

## 3. 心智模型

WebContainer 是 StackBlitz 做的浏览器内 Node 运行时：能在网页里跑真 Node 进程、有虚拟 fs、能 spawn 子进程。浏览器和它跑的进程之间，能直接消费的口子就是进程的 stdout——WebContainer API 把它包成 ReadableStream，前端 `pipeTo` 一个 WritableStream 就能逐 chunk 读到。

标签协议用的固定字符串是 `::node-modules-inspector::`。一条 stdout 行只有两种身份：

- **是数据**：前缀 + JSON，三种 case 之一
  - `{ status: 'heartbeat', heartbeat: <ts> }` —— 心跳，每 100ms 一次
  - `{ status: 'error', error: ... }` —— 报错
  - payload 本身（没有 status 字段）—— 分析结果
- **是日志**：没前缀，pnpm 之类的普通子进程输出，写给用户看

数据从 server 喷出来到浏览器落地，流向是这样：

```
server 进程 console.log(前缀 + JSON)
  → WebContainer 的 process.output pipe
    → 浏览器 WritableStream.write(chunk)
      → onChunk(chunk)
        → 前缀命中 → 剥前缀、parse、按 status 分流到 result / heartbeat / serverError
        → 前缀没命中 → 当日志写给 xterm 终端 UI
```

整套生命周期六步：

1. 用户在落地页输入包名
2. 浏览器惰性 boot WebContainer（一个全局单例 Promise）
3. 在虚拟 fs 上清空 `/app`、写最小 `package.json`、写构建期 inline 好的 `__server.mjs`
4. 顺序 spawn `node --version`（自检）和 `pnpm install <用户输入>`（真装包）
5. 后台 spawn `node __server.mjs`（不阻塞，stdout 持续被 onChunk 消费）
6. 浏览器侧 dispatcher 轮询 stdout 拿 result，返回伪装成 devframe 的 Backend

## 4. 关键权衡

### stdout 前缀当唯一通道，换零协议层

server 进程所有结构化数据都靠 `console.log(PREFIX + stringify(...))` 喷出来，浏览器靠 onChunk 接收。

**换来**：根本不用配 WebSocket、不用 postMessage、不用任何 RPC 框架。server 端就是一个最普通的 Node 脚本，和你本地跑 `node foo.mjs` 没有任何区别。这也是为什么前面 devframe RPC 那套传输适配机制（websocket / 静态 dump / MCP）在 webcontainer 这态完全没出现：传输被压缩到一根 stdout 管子。

**代价**：通道是单向的。浏览器只能等 server 主动喷，没法反向发请求。想做"问答式" RPC，唯一办法是把每次问答压缩成"启动时一次性产出"：server 启动就开始算，算完一次性把 payload 喷出来；浏览器那边轮询 stdout，等到 result 出现就算这次"调用"完成。心跳、错误、单次结果都靠"持续读 stdout"感知，没法做"我现在要查一下 X"这种反向调用。

**化解的本质矛盾**：传输要双向（RPC 的天然需求）vs WebContainer API 只暴露了 stdout 这一根浏览器侧能直接消费的管子。这条权衡把"双向"的需求改造成了"单向 + 一次性产出"，绕开了双向通道的实现成本——本质上是承认"问答"这个抽象在 WebContainer 里不适用，于是把每次问答重写成一次启动。

### 把整个 server bundle 成字符串塞进前端，换运行时只写一个文件

构建期用 rollup 把 `src/node/webcontainer/server.ts` 及它依赖的所有东西（含整个 `node-modules-tools`）inline 成单个 `runtime/webcontainer-server.mjs`；Nuxt 模块再读这个文件，用 `JSON.stringify` 包一层，作为 `WEBCONTAINER_SERVER_CODE` 字符串常量暴露给前端。运行时浏览器只要一行 `wc.fs.writeFile('/app/__server.mjs', CODE_SERVER)` 就把完整分析器放进了虚拟机。

**换来**：运行时启动 server 的逻辑极简。没有 fetch、没有动态 import、没有 require resolver。整个分析器作为字符串跟着前端 JS bundle 一起到了用户浏览器，落盘到虚拟 fs，spawn 一个 `node __server.mjs` 就拉起来了。

**代价**：构建链变复杂。要配 rollup 的 `alias`（把 `node-modules-tools` 指向源码）、`commonjs` + `nodeResolve` + `esbuild`，还要 `inlineDynamicImports: true` 把所有动态 import 拍平。产物体积也不小，整个 server 端代码加依赖都进了前端 bundle。

**本质矛盾**：服务端代码完整度（要带依赖、要能跑）vs 运行时启动的简单度（不能在浏览器里跑 npm install）。这条权衡把"装配"提前到构建期完成，运行时就只剩"落盘 + spawn"两步。也是同一个思路在 Rust / Go 单文件二进制里反复出现：把所有依赖打进一个交付物，换运行时的启动可预测。

### WebContainer 全局只 boot 一次，每次 install 先 rm -rf /app

WebContainer API 一个页面只能 boot 一次，代码层用一个模块级 `_promise` 把 `WebContainer.boot()` 的 Promise 缓存起来，第二次调 `getContainer()` 直接命中缓存。但每次 install 之前，都先 `wc.fs.rm('/app', { recursive: true, force: true })` 再 `mkdir`。

**换来**：SPA 里多次装包不必重启 VM，第二次 install 是秒级而不是首次那种数秒延迟。同时每次 install 都拿到一个干净的 `/app`：上一次的 `node_modules` 不会污染本次分析。

**代价**：WebContainer 实例本身（内置的 Node/pnpm 二进制、网络栈、虚拟 fs 的其它部分）是跨 install 复用的，状态有粘性。`rm /app` 是显式的"应用层重置"，不是 VM 层重置。如果哪天往 `/app` 之外写了东西（比如 `/tmp` 缓存、用户 home 目录配置），那些状态会泄漏到下一次 install。

**本质矛盾**：单例的启动成本（boot 几秒）想被均摊 vs 单例实例的状态在多次操作间会累积。这条权衡划了一条清晰的线：VM 重启的代价大，所以 boot 单例；但应用层状态隔离的代价小，所以每次 install 自己清自己的工作目录。这条线在所有"启动贵、清理便宜"的运行时里都看得到：进程池、数据库连接池、容器编排。

### 假装自己是 devframe Backend，但只实现 3 个方法

WebContainer 里跑的 server 内部其实复用了 devframe RPC 那套 `createInspectorRpcHandlers(...)`，但浏览器侧没有 devframe 的传输层（websocket client / 静态 dump fetcher），所以手写一个 `{ call(method, ...args) }` 对象：`nmi:get-payload` 走上面那条轮询循环；`nmi:get-packages-npm-meta` 和 `nmi:get-packages-npm-meta-latest` 不走 WebContainer，直接走浏览器自己的 IndexedDB。这个 dispatcher 包成 `Backend.functions` 返回给上层。

**换来**：上层 90% 的代码（拿 Backend、调 functions.getPayload、跑 computed payload cascade、渲染依赖图）完全不感知后端形态，和 dev 模式、static 模式用的是同一份代码。

**代价**：webcontainer backend 只实现了 3 个 function，没有 `getPublint`、`openInEditor`、`openInFinder`——这些在 `Backend` 接口里都是可选的。上一章已经讲过 UI 必须按 functions 是否存在来条件渲染，这里我们看到的是具体落点：浏览器里跑的依赖分析，本来就开不了本地编辑器，也跑不了 publint（那是 node 原生模块）。

**本质矛盾**：复用上层抽象 vs 这态后端天生缺能力。Backend 接口的可选 functions 是这条矛盾的产物：不强制要求所有 backend 都实现所有方法，但把"方法不存在时怎么办"的责任甩给 UI。也是同一个矛盾在 React Server Components、Electron 主进程 IPC 里反复出现：抽象层想统一，但具体运行时各有各的"做不到"。

## 5. 最小原理演示

下面这段 TS 演示「前缀协议 + 单例 + 后台进程」三件套如何用最少的代码跑通"宿主调度子进程"模式。不演示真的 WebContainer（要 COOP/COEP header + service worker，太重），用 setTimeout 模拟一台假虚拟机；也不演示 IndexedDB 缓存、终端 UI 渲染、心跳超时数值的精细调优。

```ts
// 假运行时：模拟 WebContainer 那台浏览器里的虚拟机
type FakeContainer = {
  fs: {
    rm: (path: string): void
    writeFile: (path: string, content: string): void
  }
  spawn: (
    cmd: string,
    args: string[],
    onChunk?: (chunk: string) => void | boolean,
  ) => Promise<{ exit: Promise<void> }>
}

// 模块级单例缓存：WebContainer API 一个页面只能 boot 一次
let _boot: Promise<FakeContainer> | null = null
function fakeBoot(): Promise<FakeContainer> {
  if (!_boot) _boot = Promise.resolve(makeFakeContainer())
  return _boot
}

const PREFIX = '::nmi-demo::'

// 宿主侧：浏览器里跑的调度逻辑
async function installInWebContainer(userInput: string) {
  const wc = await fakeBoot()

  // 复用同一个 VM 实例，但工作目录每次都清空——上次装的不该污染这次分析
  wc.fs.rm('/app')
  wc.fs.writeFile('/app/package.json', '{ "name":"demo","private":true }')
  // server 代码构建期已 inline 成字符串常量；运行时只是 writeFile 一次
  wc.fs.writeFile('/app/__server.mjs', SERVER_CODE)

  // 真装包——pnpm 的输出不走前缀，全显示给用户看
  const installer = await wc.spawn('pnpm', ['install', userInput])
  await installer.exit

  // 后台启 server：onChunk 是 stdout 的唯一消费口
  let result: any
  let heartbeat = Date.now()
  let serverError: any

  await wc.spawn('node', ['__server.mjs'], (chunk) => {
    // 前缀命中 → 结构化数据，按 status 分流；前缀没命中 → 当日志写给终端 UI
    if (!chunk.startsWith(PREFIX)) return
    const parsed = JSON.parse(chunk.slice(PREFIX.length))
    if (parsed.status === 'heartbeat') heartbeat = parsed.heartbeat
    else if (parsed.status === 'error') serverError = parsed.error
    else result = parsed
    return false // 已经处理过这块，别再写到终端了
  })

  // 通道是单向的，浏览器没法「请求」server，只能轮询它喷出来的 stdout
  while (!result && !serverError) {
    if (Date.now() - heartbeat > 10_000)
      throw new Error('Server heartbeat timeout')
    await new Promise(r => setTimeout(r, 100))
  }
  if (serverError) throw serverError
  return result
}

// 容器内：跑在虚拟机里的脚本，console.log 全带前缀
const SERVER_CODE = `
const PREFIX = '${PREFIX}'
const heartbeat = setInterval(() => {
  console.log(PREFIX + JSON.stringify({ status: 'heartbeat', heartbeat: Date.now() }))
}, 100)
try {
  // 真实场景下：createInspectorRpcHandlers({ mode:'dev', ... }) + await rpc.getPayload()
  const payload = { packages: ['vue@3.4.0', 'lodash@4.17.21'] }
  console.log(PREFIX + JSON.stringify(payload))
} catch (err) {
  console.log(PREFIX + JSON.stringify({ status: 'error', error: String(err) }))
} finally {
  clearInterval(heartbeat)
}
`

// 假运行时实现（这部分只是测试桩，不演原理）
function makeFakeContainer(): FakeContainer {
  const files = new Map<string, string>()
  return {
    fs: {
      rm: (_p) => {},
      writeFile: (p, c) => { files.set(p, c) },
    },
    async spawn(cmd, args, onChunk) {
      const isServer = cmd === 'node' && args[0] === '__server.mjs'
      if (isServer) {
        const interval = setInterval(() => {
          onChunk?.(PREFIX + JSON.stringify({ status: 'heartbeat', heartbeat: Date.now() }))
        }, 100)
        setTimeout(() => {
          clearInterval(interval)
          onChunk?.(PREFIX + JSON.stringify({ packages: ['vue@3.4.0', 'lodash@4.17.21'] }))
        }, 300)
      }
      return { exit: Promise.resolve() }
    },
  }
}
```

读这段代码时盯紧两件事。第一，server 端没有任何"接收请求"的逻辑：它启动就开始算，算完就喷。第二，宿主侧没有任何"发请求"的逻辑：它启动了 server 之后就在那里轮询 stdout 等 result。这就是把双向 RPC 压成"单向 + 一次性产出"后的具体形状。

## 6. 执行轨迹

输入：用户在落地页输入 `vue@3.4.0 lodash`，按 Enter。

**boot 阶段**。第一次访问，模块级 `_promise` 是 null，`WebContainer.boot()` 触发，几秒延迟后 WebContainer 实例就位，终端 UI 上印一行 `> WebContainer is booted.`。后续若再装包，这个 Promise 直接命中缓存，跳过这段。

**写文件阶段**。浏览器调 `wc.fs.rm('/app', { recursive: true })` 清空工作目录，再 `mkdir('/app')`，然后写两个文件。一个是 `package.json`，只有 `name/private/type:module` 三个字段，本身没有依赖，依赖全靠命令行注入；另一个是 `__server.mjs`，构建期 inline 的那一大坨字符串。

**自检 + 装包阶段**。先 `spawn('node', ['--version'])` 和 `spawn('pnpm', ['--version'])` 把环境信息写进终端。接着 `spawn('pnpm', ['install', 'vue@3.4.0', 'lodash'])` 真装包。这条 spawn 不传 onChunk，所以 pnpm 的所有输出（`Resolving...` / `Packages: +5` / `Done`）原样流到 xterm 终端 UI 给用户看。`await process.exit` 等装完。

**启 server 阶段**。`spawn('node', ['__server.mjs'])` 这次第三个参数 `wait=false`，不阻塞。server 在后台跑，stdout 通过 onChunk 持续被消费。server 进程内部六件事：拉起 devframe RPC handlers（mode 是 `'dev'`，跳过 build 期的 publint + npm-meta 预热）、起一个 100ms 的 `setInterval` 喷心跳、调 `rpc.getPayload()` 开始分析、分析完喷 payload、catch 到错误就喷 error、finally 里清掉心跳定时器。

**stdout 分流阶段**。浏览器这一头的 onChunk 每收到一段就先看前缀。命中前缀的，剥掉、parse、按 status 落到 `heartbeat` / `serverError` / `result` 三个闭包变量之一，`return false` 告诉外层别再写到终端。没命中前缀的，交给 xterm 当日志显示。

**轮询完成阶段**。上层调 `backend.functions.getPayload()`，进 dispatcher 的 `case 'nmi:get-payload'`：先把 `heartbeat` 重置成 now、`serverError` 清空，然后进 while 循环，`!result && !serverError` 期间每 100ms 醒一次，检查心跳是否在 10 秒内。result 一旦被填上就立即跳出，返回给上层。上层拿到 payload 后，`Landing.vue` 把 `backend.value` 和 `rawPayload` 都设上，前端从输入框视图切到 `<MainEntry />` 渲染依赖图。

## 7. 教学简化说明

本章演示故意省略了：真的 WebContainer boot（依赖 SharedArrayBuffer、要 COOP/COEP header、要 service worker）、真的 pnpm install（联网、虚拟 fs 解析）、`structured-clone-es` 这个支持 Map/Set/Date 的 JSON 超集序列化库、IndexedDB 缓存与 TTL（已在 npm 元信息拉取一章展开）、xterm 终端 UI 渲染、心跳间隔（100ms）和超时阈值（10s）的具体调优依据。这些都是工程细节，不是核心原理。原理就是上面那一行：贴前缀、读前缀、轮询。

## 8. 小结

这一章把上一章 Backend 接口里的"webcontainer 形态"展开了：一台浏览器内的虚拟机、一段构建期内联好的 server、一根靠前缀协议分流的 stdout 管子，再加一个伪装成 devframe 的轮询 dispatcher。它的支点就一条：既然只有 stdout 这根管子能用，那就把它当唯一传输通道，把所有"问答式 RPC"都改造成"启动时一次性产出 + 轮询"。代价是双向通道的丧失，红利是协议层的彻底清零。下一章转向另一种复用同一份 RPC handlers 的方式——CLI 的多形态（dev/build/check/report/mcp），那里没有 stdout 协议问题，但要面对 ANSI 表格与 JSON 双输出格式。

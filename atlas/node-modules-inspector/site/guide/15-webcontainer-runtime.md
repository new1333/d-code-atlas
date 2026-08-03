---
title: WebContainer：浏览器里跑真 pnpm
---

# WebContainer：浏览器里跑真 pnpm

## 想象这样一个网页

你点开一个网址，输入 `vue@3.4.0 lodash`，几秒后看到完整的依赖图——每个包的版本、模块类型、安装体积、谁依赖谁、谁该升级。整件事在你浏览器里发生，没装本地 Node、没污染本地磁盘。

要让这件事成立，得有一个能在浏览器里真跑 Node 的运行时——这就是 WebContainer 干的事。它把一个能跑 Node 的虚拟机塞进浏览器（依赖 SharedArrayBuffer，所以页面要带 COOP/COEP 两个 header，这点不展开）。但把 Node 跑起来只是故事的一半，另一半是：**浏览器里跑的 pnpm 进程，怎么把分析结果送回前端？**

这一章讲的不是 WebContainer 自己怎么实现的，而是上层应用怎么用它把"任意访问者输入一个包名就能跑真安装"这件事跑通。前置你已经读过 devframe RPC 和 Backend 抽象两章——本章就站在它们肩膀上。

## 一、最底层：浏览器只能"读"子进程的 stdout

先说一个让人有点意外的事实：WebContainer API 给浏览器暴露的能力里，**最容易拿到的是 stdout**。每次你在 WebContainer 里 spawn 一个进程，它返回一个 `process` 对象，里面有 `process.output` 这个流——浏览器可以把它 pipe 到一个 `WritableStream`，每来一段 stdout 都能立刻拿到。

```ts
const process = await wc.spawn('node', ['__server.mjs'])
process.output.pipeTo(new WritableStream({
  write(chunk) {
    console.log('got chunk:', chunk)
  },
}))
```

反向通道就不一样了。要把数据从浏览器送回 WebContainer 里的进程，要么写 `process.stdin`（要求进程主动读 stdin），要么改虚拟 fs 让进程下一次读文件时拿到新内容——两条路都要 server 端配合，都要持续监听。说人话就是：**stdout 是免费的，反向通信要花钱**。

这一节先记住一句话：在 WebContainer 这个组合里，**stdout 是宿主感知子进程的唯一便宜通道**。后面所有花活，都是怎么把这一条便宜通道榨干。

## 二、协议层：一个魔法前缀，把 stdout 撕成两条流

既然 stdout 是唯一便宜的通道，那 server 端的进度日志和数据 payload 都得从同一条 stdout 出来。问题来了：浏览器怎么知道哪一行是给用户看的进度、哪一行是程序要读的数据？

作者的答案朴素得可爱——**给数据加个前缀**。

整个协议就一个常量：

```ts
export const WEBCONTAINER_STDOUT_PREFIX = '::node-modules-inspector::'
```

server 端只要往 stdout 写"数据"，就先拼这串前缀；写普通日志就不用。浏览器那边拿到一段 chunk，先看它以前缀开头吗——是，就剥掉前缀、解析后用；不是，就当成普通进度，原样写到终端 UI 给用户看。

server 端 `__server.mjs` 实际就喷三种东西：

```ts
// 注意：下面演示用 JSON.stringify 简化。真源用的是 structured-clone-es 的 stringify，
// 那是一个支持 Map/Set/Date 的 JSON 超集——一旦 payload 里有 Map 字段，原生 JSON.stringify
// 会序列化失败（变成 "{}"），真源选这个库就是为了避开这个坑。
const PREFIX = '::node-modules-inspector::'

// 1. 心跳：每 100ms 喷一次，告诉浏览器"我还活着"
setInterval(() => {
  console.log(PREFIX + JSON.stringify({ status: 'heartbeat', heartbeat: Date.now() }))
}, 100)

// 2. 数据：分析完成时喷一次（payload 对象本身，没有 status 字段）
console.log(PREFIX + JSON.stringify(await rpc.getPayload()))

// 3. 错误：抓到异常时喷一次
catch (err) {
  console.log(PREFIX + JSON.stringify({ status: 'error', error: err }))
}
```

浏览器那侧的接收回调只做一件事——**按前缀分流**：

```ts
const onChunk = (chunk: string) => {
  if (chunk.startsWith(PREFIX)) {
    const parsed = JSON.parse(chunk.slice(PREFIX.length))
    if (parsed.status === 'heartbeat') heartbeat = parsed.heartbeat
    else if (parsed.status === 'error') serverError = parsed.error
    else result = parsed               // 没 status 字段 → 就是 payload 本体
    return false                       // 已经处理过了，不要再往终端 UI 写
  }
  // 不以前缀开头 → 返回 undefined，外层把它当日志写到 xterm
}
```

最关键的一行是 `return false`。这是宿主侧的一个约定——回调返回 false 表示"这块我已经吃掉了，别再让用户看见"。正是因为这个返回值，前缀协议能在终端里"隐身"：用户从头到尾看不到一串 `::node-modules-inspector::` 的乱码，只看到 pnpm 的安装进度。

说人话：**前缀 + 返回值，相当于在一条 stdout 里偷偷划了一条暗道**。明面上 pnpm 的进度照常流到终端，暗道里心跳和数据悄悄送到前端的状态机。

## 三、调度层：单例 boot + 清空 + 串行 spawn

跑通协议之后，整个 install 流程的逻辑骨架就清晰了。先说"环境准备"——boot 一次就够。

### 3.1 WebContainer 全局只 boot 一次

WebContainer API 有个硬限制：一个页面只能 boot 一次。第二次调 `WebContainer.boot()` 会报错。代码用一个模块级的 `_promise` 把这件事管起来——第一次调用时发起到 boot 的 Promise 并缓存，之后再调直接拿缓存：

```ts
let _promise: Promise<WebContainer> | null = null

export function getContainer() {
  if (!_promise) {
    _promise = WebContainer.boot()
      .then(wc => { /* log */ return wc })
      .catch(err => { /* log */ throw err })
  }
  return _promise
}
```

把 `_promise` 想成一块**谁都能看到的公共留言板**：第一个发起 boot 的人在板上钉了一张"Promise 在跑"的字条，后面所有调用都看这张字条、不再发起新的 boot。这是单例依赖注入最朴素的形态——按一个公共变量做按地址精准投递。

### 3.2 每次新安装前清空 `/app`

WebContainer 的 fs 是有"记忆"的——你这次安装留下的 `node_modules`，如果不显式删，下次 install 时它还在那儿。这意味着如果用户先装 `vue@2` 再装 `vue@3`，第二次的依赖图里会混着第一次的残留。

所以 install 入口固定干一件事：**先把工作目录 `/app` 整个删掉，再 mkdir 重建**。

```ts
const ROOT = '/app'

await wc.fs.rm(ROOT, { recursive: true, force: true })
await wc.fs.mkdir(ROOT, { recursive: true })
await wc.fs.writeFile(join(ROOT, 'package.json'), CODE_PACKAGE_JSON)
await wc.fs.writeFile(join(ROOT, '__server.mjs'), CODE_SERVER)
```

注意写入的 `package.json` 是**最小骨架**——只有 `name/private/type:module` 三个字段，本身没有任何依赖。所有依赖都靠后面的 `pnpm install <用户输入>` 从命令行注入。这是个有意的小巧思：写文件的成本固定，依赖完全由用户的输入参数决定。

### 3.3 串行 spawn：四步走

环境准备好了，接下来是 spawn 子进程。注意：spawn 之后要么 `await process.exit`（等它跑完），要么不 await（让它在后台跑）。两种用法在本节都会出现。

整个 install 链路里串行 spawn **四次**：

```ts
await exec('node', ['--version'])                                 // ① node 自检
await exec('pnpm', ['--version'])                                 // ② pnpm 自检
await exec('pnpm', ['install', ...args])                          // ③ 真装包（要 await 装完）
const server = exec('node', ['__server.mjs'], false, onChunk)     // ④ 后台 server（不 await）
```

每一步的意图不一样：

- **① node --version**：纯自检。WebContainer 内部带了一份 port 过的 Node，但 boot 完后第一次跑 Node 命令可能要做 JIT 预热；这条命令相当于"先把 Node 拉起来确认能用"。它的 stdout 直接进终端 UI，让用户也看到环境信息。
- **② pnpm --version**：同样是自检。pnpm 是后面真要装包的工具，先确认它的可执行文件能找到、版本号能正常打印——避免到了第③步才发现 pnpm 本身有问题。
- **③ pnpm install**：真正干活的步骤。这一步**必须 await**——不装完，后面 server 就没有 node_modules 可分析。它的 stdout 不走前缀协议，直接显示给用户当作"安装进度条"。
- **④ node __server.mjs**：后台常驻。这一步**故意不 await**——它启动后会一直跑、每 100ms 喷一次心跳。我们用 `wait=false` 让它脱离主调用栈，但通过 `onChunk` 回调持续消费它的 stdout。

③ 和 ④ 的对比最能体现 spawn 的两种用法：**装包是一次性任务，跑完即止；server 是常驻服务，启动后只关心它的输出**。

## 四、问答层：用单向通道伪造"问答"

到这里只剩最后一个难点。前端调 `getPayload()` 想拿分析结果时，它面对的现实是：

- 数据从 server 的 stdout 出来，但 stdout 回调是另一个调用栈——回调里写 `result = parsed`，调用方没办法直接 `await` 这个赋值。
- server 也接收不到前端的"请求"——前面说过反向通道要花钱。

作者的解法很直白：**轮询**。`getPayload` 进入一个 while 循环，每 100ms 醒一次，检查 `result` 是不是已经被 stdout 回调填上了：

```ts
case 'nmi:get-payload': {
  heartbeat = Date.now()        // 进入循环前先重置心跳
  serverError = undefined
  while (!result && !serverError) {
    if (Date.now() - heartbeat > 10000)
      throw new Error('Server heartbeat timeout')
    await new Promise(r => setTimeout(r, 100))
  }
  if (!result) {
    if (serverError) throw serverError
    throw new Error('Failed to get dependencies')
  }
  return result
}
```

这里有个细节：循环条件是 `!result && !serverError`——既检查"出结果了没"，也检查"出错了没"。两个变量都是 stdout 回调那边赋值的。换句话说，**前端不是在等"答"，而是在等"对方任何状态变化"**。

心跳还有第二个用处：**超时检测**。如果 10 秒内没收到新的心跳，说明 server 卡死了，循环主动抛 timeout。心跳间隔 100ms、超时 10s，意味着正常情况前端最多等 0.1s 量级感知到结果，异常情况最多卡 10s 才报错。

为什么不用 Promise + resolve？两个独立调用栈之间要传 Promise，得在外面维护一个 `let resolve; ...; resolve(parsed)`——多一层状态。作者选了更土但更短的轮询写法，反正都要有定时器查 timeout。

## 五、最小演示：一段脚本跑通整个套路

下面这段演示不依赖真的 WebContainer——用一个假运行时把"前缀协议 + 单例 + 后台进程 + 轮询"四件套演透。直接 `node demo.mjs` 或 `bun run demo.mjs` 就能跑（演示用原生 JSON.stringify 简化；真源 server 端用的是 structured-clone-es 的 stringify，那是一个支持 Map/Set/Date 的 JSON 超集——payload 里有 Map 字段时原生 JSON.stringify 会失败，真源选这个库就是为了避开这个坑）。

```js
// demo.mjs —— 用假运行时演透 stdout 前缀协议 + 轮询
const PREFIX = '::node-modules-inspector::'

// 假运行时：能 spawn、能把 stdout 喂给回调；不真的跑 Node，用 setTimeout 模拟
function fakeBoot() {
  return {
    fs: {
      _files: {},
      async rm(root) { delete this._files[root] },
      async mkdir() {},
      async writeFile(path, content) { this._files[path] = content },
    },
    async spawn(cmd, args, { onChunk } = {}) {
      // 假装我们是 __server.mjs：每 50ms 喷一次心跳，60 步后喷 payload 然后退出
      if (cmd === 'node' && args[0] === '__server.mjs') {
        let ticks = 0
        const timer = setInterval(() => {
          if (ticks < 60) {
            onChunk?.(PREFIX + JSON.stringify({ status: 'heartbeat', heartbeat: Date.now() }))
            ticks++
          } else {
            onChunk?.(PREFIX + JSON.stringify({ packages: [{ name: 'vue', version: '3.4.0' }] }))
            onChunk?.('some random log line\n')   // 普通日志，不该被前缀吃掉
            clearInterval(timer)
          }
        }, 50)
        return { exit: Promise.resolve(0) }
      }
      // 其他命令（node --version / pnpm --version / pnpm install）：喷一行普通日志即可
      onChunk?.(`${cmd} ${args.join(' ')}: ok\n`)
      return { exit: Promise.resolve(0) }
    },
  }
}

let _container
function getContainer() {
  if (!_container) _container = fakeBoot()       // 单例：只 boot 一次
  return _container
}

async function install(args) {
  const wc = getContainer()
  await wc.fs.rm('/app')                         // 关键：每次 install 必须清空
  await wc.fs.mkdir('/app')
  await wc.fs.writeFile('/app/package.json', '{"name":"app"}')
  await wc.fs.writeFile('/app/__server.mjs', '/* bundled */')

  let result, heartbeat = Date.now(), serverError
  const onChunk = (chunk) => {
    if (chunk.startsWith(PREFIX)) {
      const parsed = JSON.parse(chunk.slice(PREFIX.length))
      if (parsed.status === 'heartbeat') heartbeat = parsed.heartbeat
      else if (parsed.status === 'error') serverError = parsed.error
      else result = parsed
      return false                               // 已处理，外层别再写到终端
    }
    console.log('[terminal]', chunk.trim())      // 普通日志照常显示
  }

  await wc.spawn('node', ['--version'], { onChunk })           // ① node 自检
  await wc.spawn('pnpm', ['--version'], { onChunk })           // ② pnpm 自检
  await wc.spawn('pnpm', ['install', ...args], { onChunk })    // ③ 真装包
  await wc.spawn('node', ['__server.mjs'], { onChunk })        // ④ 后台 server

  // getPayload：轮询等 result 被填上
  while (!result && !serverError) {
    if (Date.now() - heartbeat > 10000) throw new Error('Server heartbeat timeout')
    await new Promise(r => setTimeout(r, 100))
  }
  if (serverError) throw serverError
  return result
}

const payload = await install(['vue@3.4.0', 'lodash'])
console.log('got payload:', payload)
```

跑一遍的输出大致是这样：

```
[terminal] node --version: ok
[terminal] pnpm --version: ok
[terminal] pnpm install vue@3.4.0 lodash: ok
[terminal] some random log line
got payload: { packages: [ { name: 'vue', version: '3.4.0' } ] }
```

注意：**心跳一行都没出现在终端**——因为它以前缀开头，被回调 `return false` 拦下来了。这就是前缀协议"隐身"的效果。

演示虽然用了假运行时，但它把整个套路的形状演透了：单例 boot → 清空 + 写两个文件 → 四步串行 spawn → 后台 server 喷前缀流 → 轮询等结果。真源把假运行时换成 `WebContainer.boot()`、把假 spawn 换成 `wc.spawn`，骨架完全一样。

## 六、关键权衡

这一章讲的是"宿主怎么调度子进程"这种系统级机制，权衡高度集中在「为什么选 stdout 前缀」这个根选择上。下面 5 条都从这条根选择里生出来——读完会理解整个设计的来龙去脉。

### 权衡 1：选 stdout 前缀做唯一通道 → 换来零协议层 → 代价是双向通信全断

**做了什么**：server 端不挂 WebSocket server、不监听 postMessage、不读 stdin——所有要传给前端的东西，一律 `console.log(PREFIX + stringify(...))`。

**换来什么**：完全没有协议层。不用握手、不用序列化 RPC、不用维护连接状态。浏览器侧的接收逻辑只有十几行（一个 startsWith + 一个 switch）。整个 WebContainer 适配层加起来不到 160 行。

**代价是什么**：浏览器**只能"读"，不能"问"**。前端想要一次新的分析结果怎么办？没法发请求让 server 重算——只能 kill 旧 server、重写 `__server.mjs`、重启。前端的 `getPayload` 是一个"等结果出现"的轮询循环，不是"发起请求"的 RPC 调用。心跳、错误、超时也都靠轮询感知——100ms 一次的检查、10s 才报 timeout，反应速度比真正的双向通信慢一个量级。

### 权衡 2：选"把 server 整段 bundle 内联进前端" → 换来运行时只写一个文件 → 代价是构建变复杂

**做了什么**：构建期用 rollup 把整个 server 入口（包括 `node-modules-tools` 这种重量级依赖）打成一个单文件 `runtime/webcontainer-server.mjs`；Nuxt 模块在构建时读这个文件、用 `JSON.stringify` 把它变成一个 JS 字符串常量 `CODE_SERVER`，挂在前端的 virtual module 上。

**换来什么**：运行时拉起一个完整的分析器只要**一次 `wc.fs.writeFile('__server.mjs', CODE_SERVER)`**。不用从 CDN 拉、不用解压、不用按文件树建目录——一行 writeFile，server 就在那儿了。

**代价是什么**：构建链复杂。rollup 要配 alias 把 `node-modules-tools` 指向源码、配 commonjs + nodeResolve + esbuild、配 `inlineDynamicImports: true`。Nuxt 模块还要给 `_prepare` 阶段开个逃生口（那个阶段 rollup 还没产出，返回空字符串）。构建产物里那个字符串常量可能几十 KB 起。

### 权衡 3：选"全局只 boot 一次" → 换来 SPA 内多次 install 不重启 VM → 代价是状态有粘性

**做了什么**：模块级 `_promise` 缓存 `WebContainer.boot()` 的结果，第二次调 `getContainer()` 直接返回缓存。

**换来什么**：用户在落地页连续装不同包时，WebContainer 实例只 boot 一次——首次有数秒延迟，之后每次 install 只走"清空 + 装包 + 起服务器"流程。虚拟机本身（网络栈、内置的 node/pnpm 二进制）跨多次 install 复用。

**代价是什么**：fs 状态有粘性。上一次的 `node_modules` 不删会污染下一次分析——所以每次 install 入口必须显式 `rm -rf /app` + `mkdir`。这条"必须清空"的约束是单例 boot 的直接后果，没法省。如果哪天有人忘了在 install 开头清空目录，bug 立刻出现：用户先装 vue@2 再装 vue@3，第二次的依赖图里会混着第一次的 vue@2。

### 权衡 4：选"伪装成 devframe Backend，但只实现 3 个方法" → 换来前端 90% 代码不感知后端形态 → 代价是高级能力必须 UI 优雅降级

**做了什么**：手写一个 `{ call(method, ...args) }` 的 dispatcher 对象——按 method 名 switch，把 `nmi:get-payload` 路由到上面的轮询循环、把 `nmi:get-packages-npm-meta` 路由到浏览器 IndexedDB。最后返回的 Backend 对象只声明三个 functions：`getPayload / getPackagesNpmMeta / getPackagesNpmMetaLatest`。

**换来什么**：前端的 90% 代码（payload 级联、过滤器、可视化、状态管理）完全不感知后端是 webcontainer 还是 dev 服务器还是静态 dump——它们都长一个 Backend 形状。

**代价是什么**：webcontainer backend **不支持** `getPublint / openInEditor / openInFinder / getReferencePayload*`——这些方法在这个 backend 里压根不存在。UI 必须按 `functions.xxx` 是否存在来条件渲染：能调 publint 的按钮要隐藏、能"在编辑器打开"的菜单项要 disable。如果前端忘了做这个降级，用户点了按钮就会调到 `undefined`，直接报错。

### 权衡 5：选"npm 元信息走浏览器直连 npm registry" → 换来 WebContainer 内不挂网络、boot 快 → 代价是浏览器自己要管 IndexedDB 缓存与 TTL

**做了什么**：依赖列表来自 WebContainer（pnpm 装出来的真实结果），但每个包的 npm 在线元信息（最新版、发布时间、是否废弃）由前端直接 `fetch` npm registry，结果存浏览器 IndexedDB。

**换来什么**：WebContainer 内部的 server 用的是 `driverMemory()`——进程结束即失，不用管持久化。WebContainer 内的网络访问受限（要经 service worker 代理），不如浏览器原生 fetch 直接。boot 也快——不用预热 npm-meta 缓存。

**代价是什么**：浏览器侧要自己管 IndexedDB（两个 store：`nmi:npm-meta` 和 `nmi:npm-meta-latest`）+ TTL 策略（按发布时长 5h~15d）。这套机制和 `npm-meta-fetch` 那一章重合，这里不展开——只要知道"分工是有意的"就行。

## 七、端到端执行轨迹

把上面所有件拼起来，输入 `vue@3.4.0 lodash` 时整个流程长这样：

```
1. 用户在落地页输入 → 触发 install(['vue@3.4.0', 'lodash'])
2. getContainer() → 首次 boot WebContainer（数秒延迟，后续 install 复用）
3. wc.fs.rm('/app') → mkdir → writeFile(package.json) → writeFile(__server.mjs)
4. spawn node --version       → 自检，stdout 进终端 UI
   spawn pnpm --version       → 自检，stdout 进终端 UI
   spawn pnpm install ...     → 真装包，stdout 进终端 UI（用户看进度）
   spawn node __server.mjs    → 后台启动，stdout 走 onChunk 分流：
       ↳ 每 100ms 喷一行心跳 → 更新 heartbeat 变量
       ↳ 分析完成喷一行 payload → 写入 result 变量
       ↳ 异常喷一行 error    → 写入 serverError 变量
5. dispatcher.call('nmi:get-payload')
   ↳ while(!result && !serverError): 检查心跳、sleep 100ms、循环
   ↳ result 有值 → 返回 payload
6. backend.functions.getPayload() 返回 → fetchData
   → backend.functions.getPackagesNpmMeta(specs) 走浏览器 IndexedDB
7. rawPayload 填上 → Landing.vue 切到 <MainEntry />，渲染依赖图
```

整个过程用户感受到的是：输入包名 → 看几秒安装进度 → 看到依赖图。背后是单例 VM + 一次性 writeFile + 单向 stdout 协议 + 100ms 轮询，把"网页里跑真 pnpm"这件事跑通了。

## 小结

这一章讲的是"宿主怎么用最少的协议把子进程调度起来"。三个关键件：

- **stdout 前缀协议**——把同一条 stdout 撕成"给用户看的日志"和"给程序读的数据"两条流，靠一个魔法字符串和回调的 `return false` 隐身。
- **单例 boot + 清空目录**——一次 WebContainer 实例复用多次 install，代价是每次 install 必须显式清空工作目录。
- **后台 server + 轮询**——用单向通道伪造问答：server 喷数据、浏览器轮询变量，靠心跳同时承担"我还活着"和"卡死检测"两个角色。

四步串行 spawn（node 自检、pnpm 自检、pnpm install、node __server.mjs）把这个套路落到具体命令上。整章的核心选择是"宁可让浏览器轮询，也不在 server 端建反向通道"——这是把 WebContainer 这套机制压在 160 行内的根本原因。

# WebContainer：浏览器里跑真 pnpm · 源码精读

## 给 Writer 的教学钩子（必填，8 子项缺一不可）

- **用户痛点 / 场景**：想知道某个 npm 包长什么样，但你不想在本地 `pnpm i` 污染磁盘、也不想去 npmjs 网站看静态信息——你想"装一下、立刻看到完整的依赖图、模块类型、版本差距"。在没有这个机制时，要么本地手动装（脏、慢、要 Node 环境），要么只能看静态 dump（数据是过期的、没法装任意包）。

- **一句话核心思想**：把一个真正能跑 Node 的运行时塞进浏览器，然后用一段魔法前缀把它的 stdout 变成双向通道。

- **设计动机（为什么需要它）**：依赖分析天然需要在"装好 node_modules 之后"才能做——版本解析、`workspace:` 协议、`overrides`、phantom dependency 全都依赖真实安装结果，纯静态分析做不到。但要让任意网页访问者都能跑 `pnpm install`，又不能让他们装本地工具。WebContainer 这个把 Node 跑在浏览器里的运行时正好把"真安装"和"零安装"两个矛盾的能力合并了——剩下的问题只是"浏览器里跑的进程怎么把分析结果传回前端"。

- **关键权衡（本 Atlas 的核心，共 5 条）**：
  1. **选择「stdout 前缀」做唯一传输通道 → 换来「零协议层」（不用 WebSocket、不用 postMessage）→ 代价是双向通信全断**：浏览器只能"读"WebContainer 的 stdout，不能向它发请求；所以心跳、错误、单次结果全靠"轮询 stdout 输出"感知，无法做 RPC 反向调用。
  2. **选择「把整个 server 端 bundle 成一个字符串塞进前端」 → 换来「运行时只写一个文件就能拉起完整分析器」→ 代价是构建更复杂**：必须用 rollup 把 node 端的所有依赖（包括 `node-modules-tools`）inline 成单个 mjs，再由 Nuxt 模块在构建期把它序列化成 JS 字符串常量。
  3. **选择「WebContainer 全局只 boot 一次」 → 换来「SPA 内多次 install 不重新启动 VM」→ 代价是状态有粘性**：每次新 install 之前必须显式 `rm -rf /app` 才能保证干净，否则上一次的 `node_modules` 会污染下一次分析。
  4. **选择「伪装成 devframe Backend，但只实现 3 个方法」 → 换来「前端 90% 代码不感知后端形态」→ 代价是高级能力（publint/编辑器/Finder）必须 UI 优雅降级**：webcontainer 模式没有 `getPublint`、`openInEditor`、`openInFinder`——这些功能在 UI 上要么不显示、要么 disabled。
  5. **选择「npm 元信息走浏览器直连 npm registry，不经过 WebContainer」 → 换来「WebContainer 内不挂网络、boot 快」→ 代价是浏览器自己要管 IndexedDB 缓存与 TTL」**：依赖列表来自 WebContainer（pnpm 装出来的），但每个包的 npm 在线元信息（最新版、发布时间）由前端直接 fetch + 浏览器侧 IndexedDB 持久化。

- **最小心智模型（6 步）**：
  1. 用户在落地页输入包名 → 触发 install
  2. 浏览器惰性 boot WebContainer（一个全局单例 Promise）
  3. 在 WebContainer 的虚拟 fs 上：清空工作目录 → 写一个最小 `package.json` → 写一个已经 bundle 好的 `__server.mjs`
  4. 顺序 spawn：`node --version`（自检）→ `pnpm install <用户输入>`（真装包）→ `node __server.mjs`（后台常驻）
  5. 后台 server 启动后：每 100ms 通过 stdout 喷一行带前缀的心跳；分析完成后喷一行带前缀的结果；出错则喷一行带前缀的错误
  6. 浏览器侧：每条 stdout chunk 先看前缀——前缀在的就剥掉、解析、按 `status` / 数据分流；前缀不在的当作普通日志显示给终端 UI

- **最小原理演示（替代旧"复刻范围"）**：
  - **应演示**：一段几十行的脚本，演「宿主与子进程之间靠 stdout 前缀双向传消息」这一条核心思想。具体可写两个函数：`fakeBoot()` 返回一个能 `spawn`、能 `onStdout` 的假运行时（不需要真 WebContainer，setTimeout 模拟即可）；`installInFake()` 演示「写文件 → spawn 子任务 → 收集 stdout → 按前缀分流到日志/心跳/结果」。每行都要落到上面"权衡 1（stdout 前缀换零协议层）"和"权衡 3（单例 + 清空目录）"上。
  - **应故意省略**：真的 WebContainer boot（要 COOP/COEP header + service worker，太重）、真的 pnpm install（要联网、要虚拟 fs）、IndexedDB 缓存、terminal UI 渲染、心跳超时机制的具体值、错误反序列化细节。
  - **演示载体建议**：本章主语言是 TS/JS，且机制本身（stdout 流 + 前缀协议）非常适合 Node 演示——建议写成一段能 `bun run` 或 `node` 直接跑的脚本（能跑最好，非硬要求）。**不要套 Vue/Nuxt 工具链**——前端壳子只是消费者，机制本身和 Vue 无关。
  - 这段演示演的是：**「前缀协议 + 单例 + 后台进程」三件套如何用最少的代码跑通"宿主调度子进程"模式**，而不是 WebContainer 本身怎么实现。

- **正文不宜展开的细节**：
  - COOP/COEP header 的具体配置（`nuxt.config.ts` 里的 `Cross-Origin-Embedder-Policy: require-corp` 等）——只需一句话点出"WebContainer 依赖 SharedArrayBuffer 所以需要这两个 header"即可
  - structured-clone-es 这个库的序列化细节（只需说"用一个支持 Map/Set/Date 的 JSON 超集来序列化 payload"）
  - xterm 终端 UI 渲染（与机制无关）
  - IndexedDB 驱动的具体配置（与 npm-meta-fetch 章重合）
  - rollup alias / commonjs / nodeResolve 等打包细节（一句话"把 server.ts bundle 成单文件"即可）

- **推荐的一个执行轨迹例子**：
  - 输入：用户在落地页输入 `vue@3.4.0 lodash`
  - 关键中间态 1：浏览器 boot WebContainer（首次有数秒延迟）
  - 关键中间态 2：`pnpm install vue@3.4.0 lodash` 输出流到终端 UI
  - 关键中间态 3：`node __server.mjs` 后台启动，每 100ms 喷 `::node-modules-inspector::{"status":"heartbeat",...}`
  - 关键中间态 4：分析完成，喷 `::node-modules-inspector::{"packages":..., "hash":...}`（一条长行）
  - 输出：浏览器拿到 payload，前端切到 MainEntry 视图渲染依赖图

> 以上钩子供 Writer 写「动机→核心思想→心智模型→关键权衡→原理演示」；下面事实部分供核对，不要被 Writer 当目录照抄。

## 概念要点

- **WebContainer boot 是惰性单例**：模块级 `_promise` 缓存 `WebContainer.boot()` 的 Promise，第二次调用 `getContainer()` 直接返回缓存值——因为 WebContainer API 一个页面只能 boot 一次。
  源码位置: packages/node-modules-inspector/src/app/webcontainer/container.ts:16-35

- **工作目录是固定的 `/app`**：每次 install 都先 `rm -rf /app` 再 `mkdir -p /app`，避免上次安装残留污染。
  源码位置: packages/node-modules-inspector/src/app/webcontainer/container.ts:17,67-68

- **最小 package.json**：写入的 `package.json` 只有 `name/private/type:module` 三个字段——它本身没有依赖，依赖完全由命令行 `pnpm install <args>` 注入。
  源码位置: packages/node-modules-inspector/src/app/webcontainer/constants.ts:6-10

- **server 代码是构建期内联的字符串**：`CODE_SERVER` 来自 `#build/webcontainer-server-code`，由 Nuxt 模块 `webcontainer.ts` 在构建时读取 `runtime/webcontainer-server.mjs` 文件并以 `JSON.stringify(content)` 内联为常量。
  源码位置: packages/node-modules-inspector/src/app/webcontainer/constants.ts:1-4
  源码位置: packages/node-modules-inspector/src/app/modules/webcontainer.ts:10-24

- **`runtime/webcontainer-server.mjs` 由 rollup 产出**：以 `src/node/webcontainer/server.ts` 为入口，用 alias 把 `node-modules-tools` 指向源码、用 commonjs + nodeResolve + esbuild 打成单文件（`inlineDynamicImports: true`）。
  源码位置: packages/node-modules-inspector/rollup.config.mjs:9-32

- **server.ts 复用 devframe 的 RPC handlers**：在 WebContainer 内部跑的 server 也调 `createInspectorRpcHandlers(...)`，参数里 `mode: 'dev'`、storage 用内存驱动——和 dev 服务器跑同一份逻辑。
  源码位置: packages/node-modules-inspector/src/node/webcontainer/server.ts:17-22

- **server.ts 的 stdout 协议**：三种用途共用一个 `WEBCONTAINER_STDOUT_PREFIX`（`::node-modules-inspector::`）：
  - 心跳：`{ status: 'heartbeat', heartbeat: Date.now() }`，每 100ms 一次
  - 错误：`{ status: 'error', error: ... }`，try/catch 捕获后
  - 数据：`await rpc.getPayload()` 的结果（直接是 payload 对象）
  源码位置: packages/node-modules-inspector/src/node/webcontainer/server.ts:24-39
  源码位置: packages/node-modules-inspector/src/shared/constants.ts:3

- **浏览器侧 chunk 分流**：`install()` 内 `exec('node', ['__server.mjs'], false, onChunk)` 的第四参 onChunk 回调——若 chunk 以前缀开头则解析并按 `status` 分流到心跳/错误/结果；否则返回 `true` 让外层把 chunk 当作日志写到 xterm 终端。
  注意：onChunk 返回 `false` 表示"已处理、不要再写到终端"——这是前缀协议能"隐身"的关键。
  源码位置: packages/node-modules-inspector/src/app/webcontainer/container.ts:81-101

- **dispatcher 伪装成 devframe RPC**：手写一个 `{ call(method, ...args) }` 对象，按 method 名 switch：`nmi:get-payload` 走轮询、`nmi:get-packages-npm-meta` 直接走浏览器 IndexedDB。这个 dispatcher 让 webcontainer backend 的形状与 dev/static backend 一致。
  源码位置: packages/node-modules-inspector/src/app/webcontainer/container.ts:118-145

- **getPayload 的轮询循环**：进入 `while (!result && !serverError)`，每 100ms 醒来一次检查；若 `Date.now() - heartbeat > 10000`（10 秒无心跳）则抛 timeout。心跳由 server.ts 每 100ms 喷一次、并由 stdout 回调写入本地 `heartbeat` 变量。
  源码位置: packages/node-modules-inspector/src/app/webcontainer/container.ts:122-136

- **webcontainer backend 只声明 3 个 functions**：`getPayload / getPackagesNpmMeta / getPackagesNpmMetaLatest`。没有 `getPublint / openInEditor / openInFinder`——这些在 `Backend` 接口里都是可选的。
  源码位置: packages/node-modules-inspector/src/app/webcontainer/container.ts:154-158
  源码位置: packages/node-modules-inspector/src/app/types/backend.ts:12-21

- **npm-meta 走浏览器侧 IndexedDB**：webcontainer 模式下不调 `nmi:get-packages-npm-meta` 让 server 拉，而是直接用 `unstorage/drivers/indexedb` 在浏览器本地建两个 store（`nmi:npm-meta` 和 `nmi:npm-meta-latest`），调 `getPackagesNpmMeta(specs, { storageNpmMeta })`。server.ts 内部 storage 是 `driverMemory()`（进程结束即失）。
  源码位置: packages/node-modules-inspector/src/app/webcontainer/container.ts:104-113,138-140
  源码位置: packages/node-modules-inspector/src/node/webcontainer/server.ts:19-20

- **Landing.vue 的状态切换条件**：`v-if="!backend || !rawPayload"` 时显示输入框；一旦 `backend.value = await install(...)` 且 `fetchData` 把 `rawPayload` 填上，就切到 `<MainEntry />`。
  源码位置: packages/node-modules-inspector/src/app/webcontainer/Landing.vue:34-37,51-102

- **COOP/COEP header 仅在 webcontainer backend 时开启**：`nuxt.config.ts` 通过 `process.env.NMI_BACKEND` 判断，是 webcontainer 时才输出 `Cross-Origin-Embedder-Policy: require-corp` + `Cross-Origin-Opener-Policy: same-origin`——WebContainer 依赖 SharedArrayBuffer，没有这两个 header 浏览器不给。
  源码位置: packages/node-modules-inspector/src/nuxt.config.ts:6-14

- **Nuxt 模块按需注册**：`modules/webcontainer.ts` 只在 `NMI_BACKEND=webcontainer` 时被加入 `nuxt.config.ts` 的 modules 数组——dev/build 模式下不会加载它，避免无谓地内联 server 字符串。
  源码位置: packages/node-modules-inspector/src/nuxt.config.ts:25
  源码位置: packages/node-modules-inspector/src/app/modules/webcontainer.ts:5-26

- **install 入口串行执行**：`pnpm install` `await` 完才启 `node __server.mjs`——保证 server 拿到的是装完的 node_modules。`node __server.mjs` 用 `wait=false`（不阻塞 exec），让 server 在后台跑，stdout 持续被 onChunk 消费。
  源码位置: packages/node-modules-inspector/src/app/webcontainer/container.ts:75-81,42-65

- **install 路径与 query.install URL 参数双向绑定**：`Landing.vue` 把输入框内容写回 `query.install`（空格替换为 `+`），刷新时从 `query.install` 还原——意味着 WebContainer 安装命令可通过 URL 分享。
  源码位置: packages/node-modules-inspector/src/app/webcontainer/Landing.vue:11,33

## 关键调用链

```
[Landing.vue] onMounted / Enter
  → getContainer()                 // 惰性 boot WebContainer（singleton Promise）
  → install(input.split(' '))
      → getContainer()
      → wc.fs.rm('/app') → mkdir → writeFile(package.json) → writeFile(__server.mjs)
      → exec('node', ['--version'])      // 自检
      → exec('pnpm', ['install', ...])   // 真装包（await 完成）
      → exec('node', ['__server.mjs'], wait=false, onChunk)  // 后台 server
             ↳ [__server.mjs in WebContainer]
                  createInspectorRpcHandlers({ mode:'dev', storage:memory })
                  setInterval 每 100ms → console.log(PREFIX + stringify(heartbeat))
                  rpc.getPayload() → console.log(PREFIX + stringify(payload))
                  catch → console.log(PREFIX + stringify({ status:'error', error }))
      → dispatcher.call('nmi:get-payload')
            ↳ while(!result && !serverError):
                  if (10s no heartbeat) throw timeout
                  sleep 100ms
              return result
      → return Backend({ functions: { getPayload, getPackagesNpmMeta, getPackagesNpmMetaLatest } })

  → fetchData(false, true)
      → backend.functions.getPayload()           // 上面 dispatcher
      → backend.functions.getPackagesNpmMeta(specs)  // 浏览器直连 npm registry + IndexedDB
```

源码位置: packages/node-modules-inspector/src/app/webcontainer/container.ts:37-160
源码位置: packages/node-modules-inspector/src/node/webcontainer/server.ts:17-41
源码位置: packages/node-modules-inspector/src/app/state/data.ts:15-76

## 源码摘录（带行号，全文累计 ≤ 30 行）

**stdout 前缀协议——server 端**（核心思想的最短表达）：
```ts
// packages/node-modules-inspector/src/node/webcontainer/server.ts:24-39
const heartbeat = setInterval(() => {
  console.log(WEBCONTAINER_STDOUT_PREFIX + stringify({ status: 'heartbeat', heartbeat: Date.now() }))
}, 100)
try {
  console.log(WEBCONTAINER_STDOUT_PREFIX + stringify(await rpc.getPayload()))
}
catch (err) {
  console.log(WEBCONTAINER_STDOUT_PREFIX + stringify({ status: 'error', error: err }))
}
finally {
  clearInterval(heartbeat)
}
```

**stdout 前缀协议——浏览器端分流**（与上面对应的接收方）：
```ts
// packages/node-modules-inspector/src/app/webcontainer/container.ts:81-101
const _process = exec('node', ['__server.mjs'], false, (chunk) => {
  if (chunk.startsWith(WEBCONTAINER_STDOUT_PREFIX)) {
    const data = chunk.slice(WEBCONTAINER_STDOUT_PREFIX.length)
    const parsed = parse(data) as NodeModulesInspectorLog
    if ('status' in parsed) {
      if (parsed.status === 'heartbeat') heartbeat = parsed.heartbeat
      else if (parsed.status === 'error') serverError = parsed.error
    } else {
      result = parsed
    }
    return false  // 不要再把这块写到终端 UI
  }
})
```

**getPayload 的轮询 + 心跳超时**（轮询通道的代价最直观的一段）：
```ts
// packages/node-modules-inspector/src/app/webcontainer/container.ts:121-136
case 'nmi:get-payload': {
  heartbeat = Date.now()
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

**Nuxt 构建期内联 server 字符串**（"bundle 一次，运行时只 writeFile"的关键）：
```ts
// packages/node-modules-inspector/src/app/modules/webcontainer.ts:10-24
addTemplate({
  filename: 'webcontainer-server-code',
  getContents: async ({ nuxt }) => {
    try {
      const content = await fs.readFile(fileURLToPath(new URL('../../../runtime/webcontainer-server.mjs', import.meta.url)), 'utf-8')
      return `export const WEBCONTAINER_SERVER_CODE = ${JSON.stringify(content)}`
    }
    catch (e) {
      if (nuxt.options._prepare)
        return `export const WEBCONTAINER_SERVER_CODE = ''`
      throw e
    }
  },
})
```

（合计 30 行整。）

## 易混淆 / 边界 / 推断

- **事实**：WebContainer 全局只 boot 一次（API 限制），代码层用模块级 `_promise` 缓存实现这一约束。
  源码位置: packages/node-modules-inspector/src/app/webcontainer/container.ts:16

- **事实**：每次 install 都先 `rm /app`，因此连续两次 install 的 node_modules 不会互相污染——但 WebContainer 实例本身（包括它的网络栈、内置的 node/pnpm 二进制）是同一个。
  源码位置: packages/node-modules-inspector/src/app/webcontainer/container.ts:67-68

- **推断**：`pnpm install` 的输出**没有**走前缀协议，而是直接显示在终端——说明作者把 pnpm 的 stdout 当作"给用户看的进度"，而不是"给程序读的数据"。前缀协议只用在自家的 `__server.mjs` 上。
  支撑: container.ts:54-58（非前缀 chunk 写到 terminal）+ container.ts:75（pnpm install 不传 onChunk）
  标注为推断。

- **事实**：心跳间隔是 100ms，超时阈值是 10s——意味着 server 卡死超过 10s 浏览器才会报错；正常情况下心跳带来的"延迟"在 0.1s 量级，对用户体验可忽略。
  源码位置: packages/node-modules-inspector/src/node/webcontainer/server.ts:26-28
  源码位置: packages/node-modules-inspector/src/app/webcontainer/container.ts:126-127

- **事实**：`getPayload` 内部循环用 `await new Promise(r => setTimeout(r, 100))` 轮询——不是事件驱动，因为 onChunk 回调与 dispatcher.call 是两个独立的调用栈，没法直接 await。
  源码位置: packages/node-modules-inspector/src/app/webcontainer/container.ts:128
  推断：作者考虑过用 Promise + resolve 的方式但选择了更简单的轮询——因为心跳需要定期检查 timeout，反正都要有定时器。

- **事实**：`getPackagesNpmMeta` 在 webcontainer 模式下走的是浏览器侧 `unstorage/drivers/indexedb`，**不**经过 WebContainer——这是有意的分工：依赖图必须由 WebContainer 内的 pnpm 算（真安装结果），但 npm 元信息是纯 HTTP 请求，浏览器直连更快且能持久化。
  源码位置: packages/node-modules-inspector/src/app/webcontainer/container.ts:104-113
  推断：另一好处是 WebContainer 内的网络访问受限（要经 service worker 代理），不如浏览器原生 fetch 直接。

- **事实**：`createInspectorRpcHandlers` 的 `mode: 'dev'` 让 `_getPayload` 不跑 build 期的 publint + npm-meta 预热（这两个分支 `if (options.mode === 'build')` 才进）。
  源码位置: packages/node-modules-inspector/src/node/rpc/handlers.ts:155-183

- **易混淆**：`CODE_SERVER` 在 `_prepare` 阶段返回空字符串——意味着 Nuxt 类型生成阶段不需要 rollup 已经产出。这是个构建顺序的逃生口。
  源码位置: packages/node-modules-inspector/src/app/modules/webcontainer.ts:18-20

- **边界**：webcontainer backend 不支持 `getPublint`、`openInEditor`、`openInFinder`、`getReferencePayload*`——前端 UI 必须按 functions 是否存在来条件渲染，否则会调到 `undefined`。
  源码位置: packages/node-modules-inspector/src/app/webcontainer/container.ts:154-158

- **推断**：为什么不用 WebSocket 双向通信？因为 WebContainer 内跑的进程，其 stdout 是浏览器能直接消费的（WebContainer API 提供 `process.output` pipeTo），但反向通道（浏览器 → WebContainer 内的进程）只能通过 `process.stdin` 或重写 fs——前者要求 server 端持续读 stdin、后者要求每次"问答"都重新 spawn。前缀协议 + 单次结果的模式，把"问答"压缩成"一次性产出"，避开了双向通道的复杂性。
  标注为推断。

- **未理解**：心跳间隔 100ms 是否经过性能调优？在低端设备上每 100ms 一次 `console.log` + `stringify` 是否会拖慢分析本身？未在源码中找到 benchmark 或注释说明。
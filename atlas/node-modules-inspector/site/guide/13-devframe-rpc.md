# devframe RPC：一份 handler，多种传输

> 本章属于 system 层。前置：resolvePackage 把磁盘包变可读节点、维护者行动算法、npm 元信息拉取。
> 学完你能：用一句话讲清「为什么把业务闭包成一份 handler、再让多种传输按名字找它」这套设计的关键取舍——它换来了什么、付出了什么。

## 1. 为什么需要它

上一章把所有筛选/选中状态压进了 `location.hash`，刷新页面 UI 状态能完整复原。可这只解决了「前端状态怎么活下来」。真正吃重的活儿（扫磁盘上的 node_modules、跑 publint、去 npm registry 拉元信息和漏洞数据）还没有落点。本章就接着回答：这些能力写一次要被多少种入口用，又该怎么安排它们的关系。

想象一下，你现在要给 node-modules-inspector 加一个新能力，比如「按包列出安装体积」。这个能力会被五处消费：

- **dev server**：浏览器实时拉，走 WebSocket
- **静态 build**：构建时预计算，结果落到一组 dump 文件
- **CI 检查**（`nmi check`）：命令行里跑一遍，看 config hook 有没有抛错
- **报表**（`nmi report sizes`）：把同一份结果渲染成 ANSI 表格或 JSON
- **MCP 工具**：让 AI agent 通过 stdio JSON-RPC 调用同样的计算

如果按朴素做法，每接一个入口就把「扫盘 + 算体积」的逻辑复制一份，五份代码会各自漂移。缓存策略不一致、配置文件读法不一致、错误处理不一致。改一次逻辑要同步改五处，过半年再看，已经没人能说清哪份是真的了。

这套机制的存在就是为了把这种漂移扼杀在摇篮里：**让业务闭包在一处，让传输细节各自适配**，加新传输不动业务，加新业务不动传输。

## 2. 核心思想

把每个能力注册成一条「名字 → 函数」的记录，传输层按名字找。

说人话就是：业务这边挂个名牌「我提供 `nmi:report-sizes`，给参数我给你结果」；传输层（WebSocket、静态 dump、MCP）谁需要这个能力，就照着名牌喊一声。它们彼此不认识，只认识名牌。

这块「名牌 → 函数」的注册表是整章的灵魂。往下分，是业务怎么打包成闭包；往上分，是各种传输怎么按名牌找过来。两边各自演化，谁也不绑死谁。

## 3. 心智模型

整套机制走下来分五步：

1. **业务闭包工厂** → `createInspectorRpcHandlers({ cwd, depth, storage, mode, quiet })` 一次性把外部依赖闭包进去，返回 7 个方法。外部依赖闭包在里面，缓存变量（`_config` / `_payload`）也闭包在里面。下游拿到的只是一个有方法签名的「黑盒接口」，能调方法，读不到内部缓存。
2. **适配薄片** → 每个 RPC 文件导出一个 `xxxRpc(handlers)` 工厂，把 handlers 的一个方法包装成 `{ name, type, handler }` 元组。handler 主体通常就一行箭头函数，把参数透传给 `handlers.xxx`。薄片自己不存任何状态。
3. **框架注册表** → `setup(ctx)` 里把所有适配薄片逐个 `ctx.rpc.register(...)` 进一张以 `name` 为键的 Map。
4. **传输适配器按 name 找定义**：
   - **dev server** 走 WebSocket，按 name 路由到 handler
   - **静态 dump** 遍历整张表，把每条结果序列化到磁盘
   - **MCP server** 把带 `agent.description` 的条目暴露成 stdio 工具
5. **绕过框架的入口**（CLI check/report、WebContainer）不进注册表，直接 `import { createInspectorRpcHandlers }` 拿原始 handler 调用。它们要的不是「按名字路由」，而是「直接要结果」。

每个 RPC 都带 `nmi:` 前缀（如 `nmi:get-payload` / `nmi:report-sizes`）。原因是 devframe 是多应用共存的框架，不带前缀会在路由表里跟别人撞车。`type: 'query' | 'event'` 区分有返回值还是 fire-and-forget（`openInEditor` 这种纯副作用的就是 event）。

## 4. 关键权衡

这一节是本章重头戏。

### 4.1 业务闭包下沉到工厂、RPC 元组只挂名字

选择：把 `cwd` / `depth` / `storageNpmMeta` / `mode` 这些重依赖全部在 `createInspectorRpcHandlers({...})` 时闭包进去；RPC 适配薄片（`getPayloadRpc(handlers)`）只负责挂个 `name` 和一行透传 handler，**薄片自己不碰外部依赖**。

换来：**业务与传输彻底解耦**。同一个 handler 包可以被五种入口用三种姿势消费。dev server 把它注册进框架、CLI check 直接 import 它、WebContainer 把它的结果序列化到 stdout。薄片里没有任何「业务」内容，所以传输想换什么姿势都行，业务感知不到。

代价：**五种入口里只有三种走框架的 RPC 注册表**，另两种（CLI check/report、WebContainer）绕过 devframe 直接调 handler。这意味着 handler 必须保持「脱离框架也能独立运行」：它不能依赖 `ctx.rpc.register`、不能依赖框架的传输上下文，只接收纯参数。这是一份真实的约束，一旦哪天有人图省事在 handler 里调了框架 API，CLI check 和 WebContainer 就会炸。

**背后化解的本质矛盾**：「业务逻辑要被多种入口复用 vs. 每种入口的调用姿势天然不同」。骨架解是「让业务闭包成一颗无依赖的胶囊，传输在外围适配」。你以后在 N 种场景里遇到这个矛盾（比如同一份算法要给 SDK、CLI、HTTP、gRPC 用），都可以套这个骨架：闭包成胶囊 + 名字路由。

### 4.2 静态 dump 要显式 opt-in `jsonSerializable`

选择：每个 RPC 默认走 `structured-clone` 序列化（保留 Map / Date / undefined）；只有显式标了 `jsonSerializable: true`（如 `nmi:report-sizes`）才会用 `strictJsonStringify` 落成纯 JSON 文件。

换来：**静态产物体积与兼容性可控**。`structured-clone` 的反序列化需要专门的运行时（前端要带一份解码器），而纯 JSON 任何 HTTP 服务器都能直接当静态文件吐，CDN 友好。开发者主动 opt-in 等于在声明「我保证这个 RPC 的返回值类型干净」，前端只需要为这种 RPC 准备一条轻量路径。

代价：**新增 RPC 时开发者要主动想「返回值能不能 JSON 序列化」**。忘标，结果只能走更重的 structured-clone 路径，产物体积变大、前端启动时要多加载一份解码器。更隐蔽的代价是类型系统帮不了你：`jsonSerializable` 是运行时标志位，标错了 TS 不会报错，会在用户第一次访问静态 dump 时才炸。

**背后化解的本质矛盾**：「静态产物要尽量轻、纯 JSON 最好 vs. 真实业务数据天然带 Map / Date 等非 JSON 类型」。通解骨架是「让能干净的主动 opt-in 干净路径，脏的默认走容错路径」。任何「快路径 / 慢路径」分流的设计都长这样。

### 4.3 缓存单位是 Promise 而不是值

选择：handler 内部的 `_payload` / `_config` 类型是 `Promise<T> | null`，**存的是进行中的 Promise，不是已 resolve 的值**。命中缓存时仍然 `return _payload`，让调用方 `await`。

换来：**并发首调用合并**。两个 RPC 几乎同时发起 `getPayload()`，第一个把 `_payload = _getPayload()` 写下后就返回；第二个进来发现 `_payload` 已经非空，直接拿同一份 Promise。两边等到的是同一个完成结果，扫盘只跑一遍。Promise 本身就是一次性的共享 token，这比经典的「先查 cache，没命中就互斥锁再查」优雅得多。

代价：**调用方类型签名永远是 async**。即便缓存命中，你也得 `await handlers.getPayload()`，永远拿不到同步读取。不过对一份「扫盘 + 网络」级别的数据，同步本来就不该期望；这条代价薄到不展开：任何返回大对象的 RPC 都该是 async，与缓存无关。`force` 参数把两个缓存槽都置 `null`，下一次调用重新发起，这是唯一的缓存失效路径。

**背后化解的本质矛盾**：「昂贵的副作用要被多次复用 vs. 多次并发首调用不该重复跑」。通解骨架是「缓存 Promise 单元」。你在 React Query、SWR、Apollo Client 里都能看到同款思路：缓存的不是值，是「这次工作」本身。

### 4.4 MCP 适配器用环境变量桥接 flags

选择：devframe 的 `setup(ctx, info)` 把 `info.flags` 作为唯一参数通道；但 MCP 适配器调用 `setup` 时**不传 flags**（MCP 协议本身没有「CLI flags」这个概念）。本仓库的做法是把 flags 写进环境变量（`NMI_CLI_DEPTH` / `NMI_CLI_CONFIG` / `NMI_CLI_QUIET`），在 setup 里用 `process.env.NMI_CLI_* ?? flags.xxx` 兜底取。

换来：**框架的 setup 签名保持单一**。devframe 不需要为「MCP 这条入口没有 flags」专门设计一套参数，可以维持「一个 setup、一份 info」的简洁 API。

代价：**引入隐式的 env 契约**。写 env 的代码（mcp 子命令）和读 env 的代码（`setup`）必须同步演进。字段名（`NMI_CLI_DEPTH` 等）一边改了另一边没改，运行时静默失配，TS 类型系统查不出来。这是一份典型的「跨进程字符串契约」，比强类型的函数签名脆弱得多。

**背后化解的本质矛盾**：「不同入口的参数通道天然异构（CLI 有 flags、MCP 没有）vs. 框架想要统一的 setup 签名」。通解骨架是「用一个共同的最低共同载体（env vars）做桥」。同样的问题在任何「同一份代码要既被 CLI 调用、又被非 CLI 协议调用」的场景里都会冒出来。

## 5. 最小原理演示

下面这段 ~40 行 TS 脚本演透了「按 name 路由的函数注册表」这一核心思想，并把上面四条权衡怎么落到代码上一起演示：

```ts
// 业务闭包：所有外部依赖闭包进去，对外只暴露方法
function createHandlers(opts: { cwd: string; mode: 'dev' | 'build' }) {
  let _payload: Promise<object> | null = null   // 缓存的是 Promise，不是值
  async function getPayload(force?: boolean) {
    if (force) _payload = null                  // 唯一的缓存失效路径
    if (!_payload) _payload = Promise.resolve({ cwd: opts.cwd, at: Date.now() })
    return _payload                             // 命中也仍 return Promise
  }
  return { getPayload }
}

// 适配薄片：只挂名字 + 一行透传
type RpcDef = {
  name: string
  handler: (...args: any[]) => Promise<any>
  jsonSerializable?: boolean                    // 显式 opt-in 才走纯 JSON 路径
  agent?: { description: string }               // 带描述的会被 MCP 暴露成工具
}
const defineRpcFunction = (def: RpcDef) => def

// 框架注册表：一张以 name 为键的 Map
const registry = new Map<string, RpcDef>()
function register(def: RpcDef) { registry.set(def.name, def) }

// 装配：handlers 是业务胶囊，薄片从里面挑一个方法挂名牌
const handlers = createHandlers({ cwd: '/demo', mode: 'build' })
register(defineRpcFunction({
  name: 'nmi:get-payload',
  handler: (force?: boolean) => handlers.getPayload(force),
}))
register(defineRpcFunction({
  name: 'nmi:report-sizes',
  jsonSerializable: true,                       // 声明返回纯 JSON 类型
  agent: { description: 'List packages by size' },
  handler: async () => (await handlers.getPayload() as any).items ?? [],
}))

// 传输适配器 a：dev server —— 按 name 路由调用
const byDevServer = async (name: string, args: any[]) =>
  registry.get(name)!.handler(...args)

// 传输适配器 b：静态 dump —— 遍历整张表，预计算并按序列化策略分叉落盘
const asStaticDump = async () => {
  const out: Record<string, unknown> = {}
  for (const def of registry.values()) {
    const data = await def.handler()
    out[def.name] = def.jsonSerializable
      ? JSON.stringify(data)
      : '<structured-clone:' + typeof data + '>'
  }
  return out
}

// 传输适配器 c：MCP server —— 把带 description 的当工具列出
const asMcpTools = () =>
  [...registry.values()]
    .filter(d => d.agent?.description)
    .map(d => ({ name: d.name, description: d.agent!.description }))
```

跑一下：`byDevServer('nmi:get-payload', [])` 走 WebSocket 风格的路由；`asStaticDump()` 给你一份 `{ 'nmi:get-payload': '<structured-clone:object>', 'nmi:report-sizes': '[...]' }` 的预计算产物；`asMcpTools()` 给 AI agent 看到的 `[{ name: 'nmi:report-sizes', description: 'List packages by size' }]`。同一份 handler，三种传输，零业务复制。

## 6. 执行轨迹

拿 `nmi build` 走一遍，看一份静态产物是怎么从 setup 走到落盘的。

**起点**：用户在装有 node_modules 的项目根目录敲 `nmi build`。

1. **建 host context**：`createHostContext({ cwd, mode: 'build', host })` 给 build 准备好「运行宿主」，标 `mode: 'build'`。
2. **跑 setup**：`devframe.setup(ctx, { flags })` 被调用。setup 里 `createInspectorRpcHandlers({ cwd, mode: 'build', storageNpmMeta, ... })` 闭包出 handlers。这一刻 `_payload` / `_config` 都是 `null`，handlers 接口只暴露方法。
3. **逐条 register**：`ctx.rpc.register(getPayloadRpc(handlers))` / `reportSizesRpc(handlers)` / ... 一共 9 条进注册表。注册表内部长成 `{ 'nmi:get-payload' => { name, type:'query', snapshot:true, handler }, 'nmi:report-sizes' => { ..., jsonSerializable:true, args, returns, agent }, ... }`。
4. **预扫描 jsonSerializable 清单**：遍历 `ctx.rpc.definitions.values()`，把 `def.jsonSerializable === true` 的 name 收进一个数组，写进 `connection-meta.json`。前端将来读这个文件，就能知道哪些 RPC 的静态 dump 是纯 JSON、可以直接 `fetch().json()`。
5. **collectStaticRpcDump**：框架逐条调 handler（例如 `reportSizesRpc.handler({})` 调到 `handlers.getPayload()`，这次 `_payload` 还是 null，跑 `_getPayload()`；里面 `mode === 'build'` 触发 publint 预热 + npm meta 预热，等所有 buildTasks 跑完），把每条结果记为 `{ data, serialization, fnName }`。
6. **按 serialization 分叉落盘**：每条 dump 文件根据 `serialization === 'structured-clone'` 选 `structuredCloneStringify(data)` 或 `strictJsonStringify(data, fnName)`，写到 `__node-modules-inspector/rpc-dump/` 下。
7. **写 manifest**：把所有 dump 文件的清单（路径 + RPC name 对应关系）落成 `dump-manifest.json`。

**终点**：磁盘上多了一组 dump 文件 + 一份 manifest + 一份 `connection-meta.json`。前端 backend 切到 `static` 模式后，直接 `fetch` 这些文件就能渲染整个 inspector，无需任何运行时 Node 进程。

## 7. 教学简化说明

本章演示故意省略了：真正的 WebSocket / H3 / stdio 服务搭建、JSON-RPC 帧的细节、valibot args/returns schema 的字段约束、auth 握手、unstorage 驱动选型、publint 的 messages 结构、ANSI 染色、base64/baseURL 重写规则、`getPayload` 内部预热的并发细节（pLimit(20) + allSettled）。这些都是工程细节，不是「按名字路由」这一核心思想的组成部分。

## 8. 小结

这一章把「扫盘 + 拉网络 + 跑 lint」这一坨重活儿闭包成了一份无依赖的 handler 包，再让多种传输按 `nmi:` 名字路由过去。业务这边加新能力只动 handlers，传输那边加新入口只动适配器，两边都不用等对方。

但故事只讲了一半：handler 在 Node 这一侧已经就位，可前端那一侧呢？同一份前端代码，怎么既能在 dev server 下跑动态 RPC、又能在静态 dump 下读预计算文件、还能在 WebContainer 里直连浏览器内的 pnpm？下一章就来回答这个问题。

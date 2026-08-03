# devframe RPC：一份 handler，多种传输 · 源码精读

## 给 Writer 的教学钩子（必填，8 子项缺一不可）

- **用户痛点 / 场景**：同一个"读 node_modules + 跑 publint + 拉 npm registry"的能力，要被五种入口消费——浏览器实时 RPC、静态打包预计算、CI 检查、CLI 报表、给 AI agent 用的 MCP 工具。如果每接一个入口都重写一遍业务逻辑，缓存、配置、错误处理就要复制五份，五份都会各自漂移。
- **一句话核心思想**：把每个能力注册成一条「名字 → 函数」，让传输层（websocket / 静态 dump / MCP）按名字调用；业务逻辑闭包在一处，传输细节下沉到框架。
- **设计动机（为什么需要它）**：昂贵的业务操作（读盘 + 网络请求）必须被缓存、被复用、被多种触发器调用；同时不同的传输协议（WS 帧、HTTP 静态文件、stdio JSON-RPC、ANSI 终端）天然不可调和。这套机制存在的意义就是把"业务闭包"和"传输适配器"彻底切开，让增加一个新传输不需要动业务，增加一个新业务不需要动传输。
- **关键权衡**：
  1. **「handler 工厂 + 名字注册」换传输/业务解耦，代价是每个调用方都得自己拼装 handler 闭包**——五种入口里只有三种走框架，另两种直接绕过框架调 handler，意味着 handler 必须保持"无框架状态也可独立运行"。
  2. **「显式标 jsonSerializable 才进静态 dump」换静态产物体积/兼容性可控，代价是开发者每次新增 RPC 都要主动想"返回值能不能 JSON 序列化"**——忘标 = 静态产物里这一项只能走更重的 structured-clone 序列化路径。
  3. **「把 Promise（而非值）作为缓存单位」换并发首调用共享进行中的工作，代价是缓存命中后也必须 `await`**——同步读取永远拿不到，调用方类型签名永远是 async。
  4. **「MCP 适配器不传 flags → 用环境变量做桥」换框架 API 简洁（setup 只接受单一签名），代价是引入隐式的 env 契约**——读 env 的代码必须和写 env 的 CLI 子命令同步演进，否则字段名一改两边静默失配。
- **最小心智模型（3～7 步）**：
  1. 一个工厂创建出"业务 handler 包"，把缓存、配置加载、storage 注入全部闭包进去。
  2. 每个 `xxxRpc(handlers)` 把 handler 包里的一个方法包装成 `{ name, handler }` 元组。
  3. 应用启动时把所有 RPC 元组注册进框架的注册表。
  4. 传输适配器（dev server / 静态 dump / MCP）按 `name` 找到 handler 并用各自的方式调用。
  5. 不走框架的入口（CLI check/report、WebContainer）直接拿原始 handler 调用，省掉 RPC 层开销。
- **最小原理演示（替代旧"复刻范围"）**：
  - **应演示**：一个 ~30 行的 TS 脚本，定义 `defineRpcFunction({name, handler})` 与一个 `Map<name, fn>` 注册表；然后用三种"传输适配器"消费同一个注册表——(a) 直接调用（模拟 dev server）(b) 遍历所有定义并预计算成 `{name: result}` 文件（模拟静态 dump）(c) 列出所有 name 当作"工具清单"返回（模拟 MCP）。每一段对应一条上面的权衡：闭包复用、按 schema 分叉、按需消费。
  - **应故意省略**：真正的 WebSocket / HTTP 服务、真正的 JSON-RPC 帧、valibot schema 校验、错误重试、auth 握手、storage 持久化。
  - **演示载体建议**：本章主语言是 TS，建议写成可 `bun run`/`tsx` 直接跑的脚本（注册表 + 三种假传输几十行就够），不需要真起 devframe。原因是核心抽象（按 name 路由的函数注册表）极薄，跑通比读伪码更有助于体会"一份 handler 多种传输"的分割点。
- **正文不宜展开的细节**：valibot args/returns schema 的具体字段；storage 驱动选型；publint 的 messages 结构；ANSI 染色具体宏；base64/baseURL 重写规则；MCP 协议本身的握手细节；webcontainer-server.mjs 的 rollup 打包配置。
- **推荐的一个执行轨迹例子**：
  - 输入：`nmi build` 静态产物命令
  - 关键中间态：`createHostContext({mode:'build'})` → `devframe.setup()` 注册全部 RPC → `collectStaticRpcDump` 遍历定义，把 `jsonSerializable:true` 的方法用 `strictJsonStringify` 落盘、其余用 `structuredCloneStringify` 落盘 → 同时写一份 `connection-meta.json` 列出哪些方法是 jsonSerializable
  - 输出：磁盘上一组 dump 文件 + 一个 manifest，前端静态 backend 直接读

> 以上钩子供 Writer 写「动机→核心思想→心智模型→关键权衡→原理演示」；下面事实部分供核对，不要被 Writer 当目录照抄。

## 概念要点

- **`createInspectorRpcHandlers` 是业务闭包工厂**：把 cwd/depth/configFile/mode/storageNpmMeta/storageNpmMetaLatest/storagePublint/quiet 等所有外部依赖一次性注入，返回 7 个互相共享缓存（`_config` / `_payload`）的方法（`getPayload` / `getPackagesNpmMeta` / `getPackagesNpmMetaLatest` / `getPublint` / `openInEditor` / `openInFinder`）。源码位置: packages/node-modules-inspector/src/node/rpc/handlers.ts:37-225

- **handler 的对外类型只暴露 7 个方法签名**（不暴露缓存变量）：`InspectorRpcHandlers` 接口里只有方法签名，没有 `_payload` 等内部状态——意味着下游 RPC 文件拿到的 handler 是"黑盒闭包"，只能调方法，不能读缓存。源码位置: packages/node-modules-inspector/src/node/rpc/handlers.ts:28-35

- **每个 RPC 文件都是一个独立的"适配薄片"**：标准模式是导出一个 `xxxRpc(handlers: InspectorRpcHandlers)` 工厂，内部调 `defineRpcFunction({ name: 'nmi:xxx', type, handler })`。`handler` 通常是一行箭头函数，把 args 透传给 `handlers.xxx`。源码位置: packages/node-modules-inspector/src/node/rpc/get-payload.ts:4-11、get-packages-npm-meta.ts:4-10、get-packages-npm-meta-latest.ts:4-10、get-publint.ts:4-10、open-in-editor.ts:4-10

- **RPC 名字带应用命名空间前缀**：所有 RPC name 都以 `nmi:` 开头（`nmi:get-payload` / `nmi:report-sizes` / `nmi:open-in-editor` 等），让 devframe 框架在多应用共存时不会路由冲突。源码位置: packages/node-modules-inspector/src/node/rpc/get-payload.ts:6、report-sizes.ts:25、open-in-editor.ts:6

- **`type: 'query' | 'event'` 区分有返回值与fire-and-forget**：`getPayload` / `getPublint` / `reportSizes` 是 `query`；`openInEditor` 是 `event`（无返回值，副作用型）。源码位置: packages/node-modules-inspector/src/node/rpc/get-payload.ts:7、open-in-editor.ts:7

- **`snapshot: true` 标记（仅 getPayload 用）**：推断为告诉框架此 query 的结果是可缓存快照（payload 含 timestamp/hash），允许静态 dump 模式预计算。getPayload 是唯一标了 `snapshot` 的 RPC。源码位置: packages/node-modules-inspector/src/node/rpc/get-payload.ts:8（推断）

- **`jsonSerializable: true` 是静态 dump 模式的 opt-in 标志**：仅 `nmi:report-sizes` 在本章 sourceFiles 中显式标了它。推断含义：返回值是纯 JSON 兼容类型（无 Map / Date / undefined），静态 build 时可以直接用 `strictJsonStringify` 落盘；其余 RPC（如 getPayload 返回含 Map 的 payload）只能走 structured-clone 序列化。源码位置: packages/node-modules-inspector/src/node/rpc/report-sizes.ts:27、cli.ts:80-83

- **`args` / `returns` valibot schema + `agent.description` 是 MCP 工具暴露契约**：仅 `reportSizesRpc` 在本章文件中带了完整 schema 与 `agent.description`，意味着它会被 MCP 适配器暴露给 AI agent 当工具调用；其余简单 RPC（一行 handler、无 schema）推断只走 websocket / 静态 dump，不暴露给 MCP。源码位置: packages/node-modules-inspector/src/node/rpc/report-sizes.ts:28-32（agent.description 部分推断）

- **Promise 缓存模式**：`_payload` / `_config` 类型是 `Promise<T> | null`，存储的是"进行中的 Promise"而非"已 resolve 的值"——多个并发首调用共享同一份 in-flight 工作；命中缓存时仍需 `await`（但 await 已 resolved 的 Promise 是 microtask 级零成本）。源码位置: packages/node-modules-inspector/src/node/rpc/handlers.ts:42-43、123-131

- **`force` 通过置 null 清缓存**：`getPayload(force)` 把 `_config` 和 `_payload` 都置 null 后再重新发起——这是唯一的缓存失效路径，由调用方（如 RPC `nmi:get-payload` 的入参）显式触发。源码位置: packages/node-modules-inspector/src/node/rpc/handlers.ts:123-127

- **mode='build' 触发 payload 内部的预热任务**：`_getPayload` 在 `mode === 'build'` 时并发跑 publint（pLimit(20)）+ npm meta 拉取（allSettled 容错），把结果 mutate 进 `pkg.resolved`；`mode === 'dev'` 不预热，等前端按需 RPC 拉。源码位置: packages/node-modules-inspector/src/node/rpc/handlers.ts:155-184

- **quiet=true 把日志路由到 stderr**：在 `--json` 报表 / MCP stdio 场景下，stdout 必须只输出 JSON，进度日志（绿色 ✓ / 青色 ✦）改写到 stderr。源码位置: packages/node-modules-inspector/src/node/rpc/handlers.ts:38-40

- **`setup(ctx, info)` 是 devframe 的唯一装配点**：所有 RPC 在此 `ctx.rpc.register(...)` 进框架注册表。setup 同时把 flags 与 ctx 自身合并（如 `flags.root ?? ctx.cwd`），保证从 CLI 来和从 MCP 来（无 flags）都能拿到 cwd。源码位置: packages/node-modules-inspector/src/node/devframe.ts:36-60

- **五种入口里只有三种走 devframe RPC 注册表**：(a) dev server（cli.ts 默认命令）(b) build 静态 dump（cli.ts build）(c) MCP server（cli.ts mcp）。另外两种——`check` / `report` CLI 子命令与 WebContainer runtime——绕过 devframe，直接 `import { createInspectorRpcHandlers }` 调原始 handler。源码位置: packages/node-modules-inspector/src/node/cli.ts:158-169、cli.ts:199、webcontainer/server.ts:15-31

- **WebContainer runtime 把 handler 结果序列化到 stdout**：用 `structured-clone-es` 的 `stringify` 把整个 payload 写到 stdout，并用常量前缀 `WEBCONTAINER_STDOUT_PREFIX` 区分数据行和日志/心跳行——心跳每 100ms 一次。源码位置: packages/node-modules-inspector/src/node/webcontainer/server.ts:17-39

## 关键调用链

**注册阶段**（应用启动时）：
```
defineDevframe({ setup(ctx, info) }) 
  → createInspectorRpcHandlers({...options})   // 业务闭包
  → getPayloadRpc(handlers) / getXxxRpc(handlers) // 每个 RPC 工厂
  → ctx.rpc.register(rpcDef)                    // 进框架注册表
```
源码位置: packages/node-modules-inspector/src/node/devframe.ts:24-61

**dev server 调用阶段**（浏览器 → 框架 → handler）：
```
browser WS/HTTP call("nmi:get-payload", [force])
  → devframe router（按 name 找 handler）
  → handlers.getPayload(force)
  → _getPayload() → listPackageDependencies + publint + npm meta
  → NodeModulesInspectorPayload
```
源码位置: packages/node-modules-inspector/src/node/rpc/handlers.ts:123-211

**静态 build 阶段**（一次性预计算）：
```
cli build 
  → createHostContext({mode:'build'})
  → devframe.setup(ctx, {flags})
  → collectStaticRpcDump(ctx.rpc.definitions.values(), ctx)
  → 按 def.jsonSerializable 选 strictJsonStringify 或 structuredCloneStringify
  → 写 dump 文件 + manifest + connection-meta.json
```
源码位置: packages/node-modules-inspector/src/node/cli.ts:50-89

**handler 直接调用阶段**（CLI check / report / WebContainer，绕过框架）：
```
import { createInspectorRpcHandlers }
  → handlers.getPayload() (直接 await)
  → 渲染成 ANSI 表格 / JSON stdout / structured-clone stdout
```
源码位置: packages/node-modules-inspector/src/node/cli.ts:158-178、webcontainer/server.ts:31

## 源码摘录（带行号，全文累计 ≤ 30 行）

**1. RPC 元组的标准形态**（最简形态，演示"名字 + handler"核心抽象）：
```ts
// get-payload.ts:4-11
export function getPayloadRpc(handlers: InspectorRpcHandlers) {
  return defineRpcFunction({
    name: 'nmi:get-payload',
    type: 'query',
    snapshot: true,
    handler: (force?: boolean) => handlers.getPayload(force),
  })
}
```

**2. Promise 缓存 + force 清缓存**（演示权衡 #3：缓存命中也得 await）：
```ts
// handlers.ts:42-43, 123-131
let _config: Promise<NodeModulesInspectorConfig> | null = null
let _payload: Promise<NodeModulesInspectorPayload> | null = null
// ...
function getPayload(force?: boolean) {
  if (force) { _config = null; _payload = null }
  if (!_payload) _payload = _getPayload()
  return _payload
}
```

**3. 注册点**（演示"按名字注册进框架表"）：
```ts
// devframe.ts:51-59
ctx.rpc.register(getPayloadRpc(handlers))
ctx.rpc.register(getPackagesNpmMetaRpc(handlers))
ctx.rpc.register(getPackagesNpmMetaLatestRpc(handlers))
ctx.rpc.register(getPublintRpc(handlers))
ctx.rpc.register(openInEditorRpc(handlers))
ctx.rpc.register(reportSizesRpc(handlers))
```

**4. jsonSerializable opt-in + MCP 工具描述**（演示权衡 #2：静态 dump 显式 opt-in）：
```ts
// report-sizes.ts:24-32
return defineRpcFunction({
  name: 'nmi:report-sizes',
  type: 'query',
  jsonSerializable: true,
  args: [argsSchema],
  returns: returnsSchema,
  agent: { description: 'List packages sorted by install size...' },
  handler: /* ... */,
})
```

**5. 静态 build 按序列化策略分叉**（演示 jsonSerializable 在 build 端的兑现）：
```ts
// cli.ts:80-83
const text = file.serialization === 'structured-clone'
  ? structuredCloneStringify(file.data)
  : strictJsonStringify(file.data, file.fnName)
```

## 易混淆 / 边界 / 推断

- **事实**：devframe.ts 还 `register` 了 `openInFinderRpc` / `reportDuplicatesRpc` / `reportMaintainersRpc`，但本章 sourceFiles 没列这三个文件——它们是同模式兄弟，Writer 不需要为它们单开章节。源码位置: packages/node-modules-inspector/src/node/devframe.ts:11-13、56-58
- **事实**：`getPayloadRpc` 是唯一标 `snapshot: true` 的 RPC（在本章 sourceFiles 范围内）。源码位置: packages/node-modules-inspector/src/node/rpc/get-payload.ts:8
- **事实**：`reportSizesRpc` 是本章 sourceFiles 内唯一带 `jsonSerializable: true`、唯一带 valibot `args/returns` schema、唯一带 `agent.description` 的 RPC。源码位置: packages/node-modules-inspector/src/node/rpc/report-sizes.ts:25-32
- **事实**：`type: 'event'` 只有 `openInEditorRpc` 用到（在本章文件中），其余全是 `type: 'query'`。源码位置: packages/node-modules-inspector/src/node/rpc/open-in-editor.ts:7
- **推断**：`snapshot: true` 的语义未在 sourceFiles 中显式说明，但结合 getPayload 是唯一可静态预计算的"大型" RPC + 静态 build 走 `collectStaticRpcDump` 的事实，推断它告诉框架"此 query 的结果可在 build 期固化"。
- **推断**：`agent.description` 是 MCP 适配器消费的字段——`cli.ts` 的 `mcp` 子命令把 devframe 传给 `createMcpServer(devframe, ...)`，每个有 `agent.description` 的 RPC 会被暴露成 MCP 工具；没标的 RPC 不暴露。
- **推断**：`mode: 'build'` 不只是"在 build 期跑"，还会触发 `_getPayload` 内部的预热（publint + npm meta），原因是静态产物必须把所有运行时计算都预先做完——dev 模式下前端按需 RPC 即可。
- **未理解**：devframe 框架本身的 `ctx.rpc.register` 内部数据结构（是 Map、还是带版本/带 schema 的 definition 对象）——本章 sourceFiles 不含框架源码，只能从 `ctx.rpc.definitions.values()` 的调用形态（cli.ts:66）推断它至少有一个可迭代的 definitions 集合，每项含 `name`、`jsonSerializable`、`handler` 等字段。
- **未理解**：`strictJsonStringify(file.data, file.fnName)` 的第二参数 `fnName` 用途——可能是用于错误信息或调试标识，框架源码不在范围内。
- **边界**：WebContainer runtime（webcontainer/server.ts）**不**走 devframe RPC 注册表，它直接 `createInspectorRpcHandlers({...})` 然后 `await rpc.getPayload()`——这意味着 devframe 的 `setup` 注册对它无效，handler 闭包的"业务复用"才是真正的复用点。Writer 不应把"五种传输都走框架"当作事实——只有三种走。
- **边界**：`cli check` 和 `cli report` 同样绕过 devframe，直接 import `createInspectorRpcHandlers`——再次说明"handler 闭包"是真正的复用单元，devframe RPC 只是它的一个传输适配器。
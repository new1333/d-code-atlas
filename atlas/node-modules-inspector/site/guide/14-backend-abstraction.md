# Backend 抽象：dev/static/webcontainer 三态前端

> 本章属于 system 层。前置：devframe RPC：一份 handler，多种传输。
> 学完你能用一句话讲清：同一份 UI 怎么跑在三种部署形态上——靠的不是运行时分支，而是把"这个后端有没有这个能力"编码成接口字段是否存在，让 UI 用特征检测自然降级。

## 1. 为什么需要它

上一章把传输层的事摆平了：一份 RPC handler 写好，websocket、静态 dump、MCP 三种传输都能跑，handler 跟传输彻底解耦。但传输只解决了「数据怎么过来」，前端真正要面对的下一层矛盾是：不同部署形态提供的能力压根不对等。

node-modules-inspector 这个工具要部署成三种形态：

- **本地 dev server**：你 `npm` 起个本地服务，带 ws 后端，全功能。
- **静态托管站点**：比如 `everything.antfu.dev`，build 时一次性 dump 成 JSON，只读。
- **WebContainer**：浏览器里现装现跑，下一章细讲。

这三种部署的能力差异不在「快慢」、也不在「缓存策略」，而在「有的有、有的没」：静态 dump 没有"打开编辑器"（没有本地文件系统可开）、没有"实时的 npm 元信息"（dump 时已经拍过照）、没有 publint 实时计算（同上）。

如果每个部署各写一份前端，三套代码维护成本会爆炸，每加一个功能要改三遍。如果用配置标志在运行时分支，能力差异会散布到每个按钮，每个调用点都要写「如果静态模式就别显示这个」。

使用者最直接的痛点是：点了一个按钮，结果后端没这个能力，前端必须能在能力缺失时优雅消失，而不是点了才发现报错。

## 2. 核心思想

把"这个后端有没有这个能力"编码成"Backend 上对应的函数字段是否存在"。UI 不问"你能不能"，只问"你有没有"——前者要靠运行时试探（调了才知道），后者只看字段在不在就完了。

## 3. 心智模型

Backend 这个对象的结构（极简版）长这样：

```ts
interface Backend {
  name: string                          // 'dev' | 'static' | 'webcontainer'
  status: Ref<'idle' | 'connecting' | 'connected' | 'error'>
  connectionError: Ref<unknown | undefined>
  connect: () => Promise<void> | void
  isDynamic?: boolean                   // 粗粒度开关：整体是不是动态
  functions: {
    getPayload: (force?) => Promise<Payload>   // 必填，所有部署都有
    getPackagesNpmMeta?: (...) => ...           // 下面五个全部可选
    getPackagesNpmMetaLatest?: (...) => ...
    getPublint?: (...) => ...
    openInEditor?: (filename: string) => void
    openInFinder?: (filename: string) => void
  }
}
```

整套机制的流程是 A → B → C → D：

- **A 编译期挑 entry**：构建期 `import.meta.env.BACKEND` 这个常量决定打包哪个入口组件（`webcontainer.vue` 还是 `dev.vue`）。dev 和 static 共用一个 entry。
- **B 运行期工厂构造 Backend**：entry 挂载时调工厂（`createDevBackend` 或 WebContainer 的 `install`），工厂内部协商传输层，按协商结果决定每个 function 字段填实际函数还是 `undefined`。
- **C 安装到模块级单例**：`backend.value = b`，整个 app 通过 `import { getBackend } from '../backends'` 都能拿到。
- **D 调用方做特征检测**：`fetchData` 用 `if (backend.functions.getPackagesNpmMeta && ...)` 守卫式拉取；UI 用 `v-if="backend.functions.openInEditor"` 控制按钮显隐。

字段是否可选是这一切的语言基础——`getPayload` 必填表达了"所有部署都至少能给你数据"，其余字段可选表达了"能力是部署相关的"。

## 4. 关键权衡

### 把"能力存在与否"下沉为接口字段是否可选

这是本章灵魂。

**选择**：`BackendCallableFunctions` 里只有 `getPayload` 必填，其余五个（`getPackagesNpmMeta` / `getPackagesNpmMetaLatest` / `getPublint` / `openInEditor` / `openInFinder`）全部标 `?`。工厂在构造 Backend 时，静态模式下直接把这些字段设成 `undefined`，而不是设成「调用就抛错」的占位函数。

**换来**：UI 用 `v-if="backend.functions.openInEditor"` 这种**特征检测**自然降级——按钮根本不渲染，而不是渲染了再 try-catch。同一份 UI 代码跑 dev/static/webcontainer 三种形态零分支。上一章讲过的那条规则（静态 build 时把可序列化方法显式标 `jsonSerializable`）到这里就变现了：被标过的纯函数静态 build 时还在，没标（或不能标）的就根本不进 functions。

**代价**：每个调用方都得写 `if (backend.functions.X)` 守卫，漏一处就 NPE。dev 模式下其实所有函数都"应该"存在，但类型没法表达「按部署形态收紧」，dev 调用方拿到 `getPublint` 仍需 `if` 守卫，写起来啰嗦。

**本质矛盾**：这条权衡化解的是「同一份接口要描述能力不对等的多个实现」与「类型系统没法在编译期知道运行期协商结果」之间的张力。任何「接口 + 多实现 + 能力参差」的场景都会撞上这个矛盾——比如 VS Code 扩展跑在不同 host（web/local）、LSP server 跑在不同语言后端。通解骨架就是「把能力差异编码成字段存在性 + 调用方特征检测」，认出这个骨架就能在别处复用。

### 一个工厂同时造 dev 和 static 两种 Backend

**选择**：`createDevBackend` 一个工厂承担 dev 与 static 两种 Backend 的构造，运行时根据 `connectDevframe` 协商到的传输层（`rpc.connectionMeta.backend === 'websocket'`）决定 `isDynamic`、`name`，再按 `isWebsocket` 条件填充 functions。

**换来**：dev server 与静态 build 共一份入口代码。分支收敛在一处（`isWebsocket` 这个布尔决定一切），而不是「dev 文件 + static 文件 + 共享逻辑」三件套。

**代价**：读者必须理解 `isDynamic` 是**运行时协商结果**、不是编译期常量——同一个工厂在不同部署里产出能力截然不同的实例。这与「工厂方法」这个常见模式的直觉相反（工厂通常产出同质实例）。

**本质矛盾**：「想共用入口代码」与「想保留部署差异」之间的张力。换条路：拆两个工厂能让差异更显式，但入口代码要重复；用一个工厂能共用入口，但差异要靠读工厂内部逻辑才看得见。

### 编译期常量只挑 entry，不挑能力

**选择**：`import.meta.env.BACKEND` 这个编译期常量**只**用来选入口组件（`webcontainer.vue` vs `dev.vue`），**不**用来在运行时分支能力。能力差异完全由运行期 Backend 接口管。

**换来**：webcontainer 与 dev/static 是两个独立 SPA 包，bundle 更瘦（webcontainer 包不需要带 dev 才用的 RPC 客户端代码）。常量与运行期各管一段、互不重叠。

**代价**：同一份 SPA 不能跨形态切换——webcontainer 包临时退不回 dev 模式，要换形态只能重新 build。极少数地方常量也参与了行为默认值（如 `filters.ts` 把 `excludeWorkspace` 默认设为 webcontainer 时为 true），算是这条规则的小尾巴。

### Backend 用模块级 shallowRef 全局单例

**选择**：Backend 不走 provide/inject 透传，而是 `backends/index.ts` 里一个模块级 `shallowRef<Backend>`，配套 `getBackend()` 返回 `backend.value!`（非空断言）。任意模块 `import { getBackend } from '../backends'` 就能拿。

**换来**：调用点极轻，不需要在 Vue 组件树里逐层透传，非组件代码（普通 `.ts` 工具函数）也能拿。

**代价**：模块全局紧耦合——不能并存两个 Backend（WebContainer 切换包时靠重新加载 module 解决）；测试要重置模块状态；`backend.value!` 的非空断言假设调用方只在 entry 挂载后才访问，main.vue 用 `v-if="!backend || !rawPayload"` 守卫住这条假设。这里**必须用 `shallowRef` 而非 `ref`**：Backend 内部含 RPC 闭包与 `Ref` 字段，深响应式化既无意义（没人需要 Backend 整体变成响应式）又有开销（深度代理化闭包是浪费）。

**本质矛盾**：「想要调用点轻（任意模块直接拿）」与「想要可测试性、可并存性」之间的张力。provide/inject 选了后者（多实例友好但调用点要 inject），模块单例选了前者（调用点一行 import 但全局唯一）。这条权衡本质上是在选「服务定位器」还是「依赖注入容器」两种风格之一。

## 5. 最小原理演示

下面这段 ~50 行的脚本只演透**核心思想 + 灵魂权衡**：Backend 接口字段可选、UI 用特征检测降级。故意省略 devframe RPC 协议、WebContainer 启动、Nuxt 打包细节、连接状态机——这些都是真仓库的工程复杂度，跟「能力可选 → 特征检测」这条原理无关。

```ts
// Backend 接口：getPayload 必填，openInEditor 可选
interface Backend {
  name: string
  functions: {
    getPayload: () => Promise<any>
    openInEditor?: (filename: string) => void   // 静态 dump 没有这个能力
  }
}

// 工厂一：动态后端（dev server），所有能力都在
function createDynamicBackend(rpc: {
  call: (m: string, ...a: any[]) => Promise<any>
  callEvent: (m: string, ...a: any[]) => Promise<void>
}): Backend {
  return {
    name: 'dev',
    functions: {
      getPayload: () => rpc.call('nmi:get-payload'),
      // 动态后端：实际绑定到 RPC
      openInEditor: (fn) => { void rpc.callEvent('nmi:open-in-editor', fn) },
    },
  }
}

// 工厂二：静态后端（dump 站点），openInEditor 字段直接不存在
function createStaticBackend(dump: any): Backend {
  return {
    name: 'static',
    functions: {
      getPayload: async () => dump,
      // openInEditor 不写——这就是"能力缺失"在接口上的表达
    },
  }
}

// UI 渲染：永远渲染 payload，但"打开编辑器"按钮靠特征检测决定显隐
function render(payload: any, backend: Backend): string[] {
  const ui: string[] = [
    `[payload] ${payload.packages.length} packages`,
  ]
  // 关键：UI 不问"能不能"，只问"有没有"
  if (backend.functions.openInEditor) {
    ui.push('[button] Open in Editor')
  }
  return ui
}

// 演示：同一份 render 跑两种 backend
const dynamicUI = render(
  { packages: [{ name: 'vue' }] },
  createDynamicBackend({ call: async () => ({}), callEvent: async () => {} }),
)
const staticUI = render(
  { packages: [{ name: 'vue' }] },
  createStaticBackend({ packages: [{ name: 'vue' }] }),
)

console.log('dev:    ', dynamicUI)  // ['[payload] 1 packages', '[button] Open in Editor']
console.log('static: ', staticUI)   // ['[payload] 1 packages']  ← 按钮自然消失
```

跑一下就能看到：dev 模式 UI 多一行「Open in Editor」按钮，static 模式 UI 干干净净没有这个按钮。`render` 函数本身一行没改，差异完全来自 Backend 接口字段是否存在。

## 6. 执行轨迹

拿「用户打开静态托管页 `everything.antfu.dev`」走一遍状态变化：

1. **entry 触发**：浏览器加载 SPA，编译期常量 `import.meta.env.BACKEND` 不是 `'webcontainer'`，于是异步组件加载 `dev.vue`（注意：dev 和 static 共用这个 entry）。
2. **工厂启动**：`dev.vue` 挂载时调 `createDevBackend()`。工厂先 fetch `api/metadata.json`，没有就回退到 `__connection.json` 发现机制。静态站点的服务器返回的 `__connection.json` 里 `backend: 'static'`，没有 websocket 端点。
3. **条件填充**：`connectDevframe` 返回后 `isWebsocket = false`。工厂走静态分支：`getPayload` 绑定到读 dump 的 RPC 调用（静态模式下 RPC 协议读的是 JSON 文件而不是 ws）；`getPackagesNpmMeta` / `getPublint` / `openInEditor` / `openInFinder` 四个字段全部直接赋成 `undefined`。Backend 的 `name` 是 `'static'`、`isDynamic` 是 `false`、`status.value` 是 `'connected'`。
4. **安装单例**：`backend.value = b`，整个 app 通过 `getBackend()` 都能拿到这个 static backend。
5. **fetchData 守卫跳过**：`fetchData()` 拉回 payload（这一步永远能成，因为 `getPayload` 必填）。然后到 `if (backend.functions.getPackagesNpmMeta && npmMetaSpecs.length)` 这行：`getPackagesNpmMeta` 是 `undefined`，守卫不通过，直接跳过 npm 元信息拉取。`getPackagesNpmMetaLatest` 同理跳过。
6. **UI 渲染**：`PackageDetailsInfo.vue` 上「打开编辑器」按钮的 `v-if="backend?.functions.openInEditor && pkg.filepath"`：`openInEditor` 是 `undefined`，按钮不渲染。`Overview.vue` 里调 `backend.functions.openInFinder?.(...)` 也是 undefined，对应按钮也不渲染。

**输出**：用户看到的页面有完整依赖数据，但所有需要动态能力的按钮（编辑器、finder、实时 npm 元信息、publint）全部消失，不是禁用或灰显，是根本不存在。

## 7. 教学简化说明

本章演示故意省略了：devframe RPC 的实际协议细节（上一章已展开）、WebContainer 的 boot 流程（下一章）、Nuxt 打包如何注入 `import.meta.env.BACKEND`、连接状态机的完整 4 态（`idle` / `error` 这两个状态在源码里被读但几乎没观察到被写，是预留扩展）、错误处理细节（`getPayload` try/catch 把错误写到 `backend.connectionError.value`，UI 用这个槽显示错误条）、`ReferencePayloadFunctions` 那组扩展点（目前没有任何调用方消费，是预留接口）。这些都是真仓库的工程复杂度，跟「能力可选 → 特征检测」这条原理无关。

## 8. 小结

这一章把传输层之上的那一层矛盾摆平了：同一份 UI 怎么跑在能力不对等的三种部署上。Backend 接口给"有"和"没有"提供了类型层的语言，UI 只需要问"有没有"，不需要 try-catch 试"能不能"。

至此 dev / static 两种形态已经被同一个 Backend 接口覆盖。但第三种形态 WebContainer 还要面对一个更野的问题：浏览器里根本没有 `node_modules` 可读，得现装现跑。下一章就接这个。

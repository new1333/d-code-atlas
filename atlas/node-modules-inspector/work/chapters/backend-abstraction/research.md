# Backend 抽象：dev/static/webcontainer 三态前端 · 源码精读

## 给 Writer 的教学钩子（必填，8 子项缺一不可）

- **用户痛点 / 场景**：同一份「依赖 Inspector」前端要在三种部署里跑——本地 dev server（带 ws 后端）、静态托管站点（只读 JSON dump）、浏览器 WebContainer（真在浏览器里跑 pnpm）。如果每个部署各写一份前端，维护成本会爆炸；如果用配置标志在运行时分支，能力差异会散布到每个按钮。使用者最直接的痛点是：「点了一个按钮，结果后端没这个能力」——前端必须能优雅降级。

- **一句话核心思想**：**用一个「能力可选」的 Backend 接口做部署适配**——把"这个后端有没有这个能力"编码成"函数字段是否存在"，让 UI 用特征检测自然降级。

- **设计动机（为什么需要它）**：本质上要解决的是「同一份 UI 代码、不同部署形态、不同能力组合」的矛盾。三种部署提供的能力并不对等：dev 全功能、静态 dump 只有 getPayload、WebContainer 又是另一种来源。**Backend 接口**就是这个矛盾的解：它把所有差异都封装在一个对象里，UI 只认接口、不认部署。换来了「部署自由」+「UI 零分支」。

- **关键权衡**（本 Atlas 的核心，4 条）：
  1. **能力下沉为可选函数字段（`functions?: optional`）** → 换来「同一份 UI 代码可跑 dev/static/webcontainer」+「调用点用特征检测决定按钮可见性」 → 代价是「每个调用方都要写 `if (backend.functions.X)` 守卫，漏一处就 NPE」。这是本章灵魂权衡。
  2. **一个工厂 `createDevBackend` 同时承担 dev 与 static 两种 Backend 的构造**（运行时根据 `connectDevframe` 协商到的传输层决定 `isDynamic`） → 换来「dev server 与静态 build 共一份入口代码」+「分支由传输层显式声明而非编译期常量」 → 代价是「读者必须理解 isDynamic 是运行时协商结果，不是编译期常量；同一个工厂在不同部署里产出能力截然不同的实例」。
  3. **编译期常量 `import.meta.env.BACKEND` 仅用于"挑入口组件"，不挑能力** → 换来「webcontainer 与 dev/static 是两个独立 SPA 包，bundle 更瘦」+「能力差异仍由运行时 Backend 接口管，常量只负责选 entry」 → 代价是「同一份 SPA 不能跨形态切换——webcontainer 包不能临时退回 dev 模式」。
  4. **Backend 用模块级 `shallowRef<Backend>` 全局单例**（而非 provide/inject） → 换来「任意模块 `import { getBackend } from '../backends'` 即可拿」+「无需在 Vue 组件树里逐层透传」 → 代价是「模块全局紧耦合、不能并存两个 Backend、测试要重置模块」+「必须用 shallowRef 而非 ref——Backend 内部含 RPC 闭包，深响应式化既无意义又有开销」。

- **最小心智模型（3～7 步）**：
  1. 构建期：`import.meta.env.BACKEND` 决定打包哪个 entry 组件（dev/static 走 `dev.vue`，webcontainer 走 `webcontainer.vue`）。
  2. 运行期 entry 调用工厂：`createDevBackend()`（dev/static）或 `install()`（webcontainer，构造同样满足 Backend 接口的对象）。
  3. 工厂内部协商传输层：`connectDevframe({ baseURL, connectionMeta })` 找到 `__connection.json`，得到传输层是 websocket 还是静态 dump。
  4. 工厂按传输层填 Backend：`name`（'dev'/'static'）、`status: 'connected'`、`isDynamic = (传输 === websocket)`，然后把 RPC 函数按"动态则绑定 / 静态则设 undefined"填进 `functions`。
  5. `backend.value = b`：单例安装，整个 app 都能看到。
  6. `fetchData()` 读 `getPayload()`，再用 `if (backend.functions.getPublint)` 守卫式地并发拉其余元数据。
  7. UI 渲染：每个按钮用 `v-if="backend.functions.openInEditor"` 这类特征检测决定显隐；静态模式下相应按钮自然消失。

- **最小原理演示（替代旧"复刻范围"）**：
  - 应演示：一个 ~50 行的脚本，定义 `Backend` 接口（`getPayload` 必填、`openInEditor?` 可选），写两个工厂 `createStaticBackend(dump)` / `createDynamicBackend(rpc)`，再写一个 `render(payload, backend)` 函数：永远渲染 payload，但仅在 `backend.functions.openInEditor` 存在时渲染"打开编辑器"按钮。然后用同一份 `render` 渲染两种 backend 的产物，肉眼看到静态模式下按钮消失——**演的是权衡 1（可选能力 → UI 特征检测）**。
  - 应故意省略：devframe 实际 RPC 协议、WebContainer 启动流程、Nuxt 打包细节、Vue 响应式系统、连接状态机的全部 4 态、错误处理细节。
  - **演示载体建议**：写一段独立的 TS/JS 脚本，能 `bun run`/`node` 直接跑（不需要真起 devframe 或 WebContainer）；用一个 mock 的 `payload` 字面量 + 一个假的 `rpc.call` 即可。本章机制本质是**类型契约 + 工厂 + 特征检测**，与传输层无关，所以纯脚本演示最清晰——**载体服务于"演透原理"，不是服务于"能跑全栈"**。

- **正文不宜展开的细节**：devframe 框架本身的 RPC 实现（外部包）；WebContainer.boot 内部细节（属下一章）；`__connection.json` 的具体 schema；`useRuntimeConfig` 的 Nuxt 细节；ReferencePayloadFunctions 这一组接口目前**未被任何调用方消费**（推断：预留扩展点）；4 状态机里 `idle` 这个值在源码中未观察到被设置（推断：status 字面量集合里预留的）。

- **推荐的一个执行轨迹例子**：用户打开静态托管页（如 `everything.antfu.dev`）→ entry `dev.vue` 调 `createDevBackend()` → `connectDevframe` 发现 `__connection.json` 声明 `backend: 'static'` → `isWebsocket=false`，工厂把 `getPublint/openInEditor/...` 全设为 `undefined` → `backend.value = b` → `fetchData()` 只调 `getPayload()`，跳过 `getPackagesNpmMeta`（守卫不通过）→ UI 渲染 payload，但 `PackageDetailsInfo` 上的"打开编辑器"按钮因 `openInEditor === undefined` 被 `v-if` 隐藏。**输出：页面有数据、无交互按钮**。

> 以上钩子供 Writer 写「动机→核心思想→心智模型→关键权衡→原理演示」；下面事实部分供核对，不要被 Writer 当目录照抄。

## 概念要点

- **Backend 是一个把"状态 + 能力 + 连接"打包的接口对象**：`name / status / connectionError / connect / isDynamic? / functions`。除 `getPayload` 外所有 `functions` 字段都可选。源码位置: packages/node-modules-inspector/src/app/types/backend.ts:5-30

- **能力差异通过"字段是否存在"而非"字段是否抛错"表达**：`BackendCallableFunctions` 里 `getPayload` 必填、其余 `getPackagesNpmMeta / getPackagesNpmMetaLatest / getPublint / openInEditor / openInFinder` 全部 `?` 可选。源码位置: packages/node-modules-inspector/src/app/types/backend.ts:12-19

- **额外有 `ReferencePayloadFunctions` 一组扩展点**（getReferencePayload/saveReferencePayload/...），目前**没有任何调用方**——是预留接口。源码位置: packages/node-modules-inspector/src/app/types/backend.ts:5-10

- **Backend 是模块级 `shallowRef<Backend>` 全局单例**，配套 `getBackend()` 返回 `backend.value!`（非空断言）。源码位置: packages/node-modules-inspector/src/app/backends/index.ts:4-8

- **`createDevBackend` 一个工厂同时产出 dev 与 static 两种 Backend**：内部根据 `rpc.connectionMeta.backend === 'websocket'` 设 `isDynamic`，决定 `name` 是 'dev' 还是 'static'。源码位置: packages/node-modules-inspector/src/app/backends/dev.ts:39-48

- **工厂对每个动态能力做"是 ws 才绑定 / 否则 undefined"的条件填充**：如 `getPackagesNpmMeta: isWebsocket ? (...) : undefined`。这是把"能力缺失"的决策**前置到工厂**，调用方因此不必关心为什么没有。源码位置: packages/node-modules-inspector/src/app/backends/dev.ts:59-73

- **静态模式发现路径**：`connectDevframe({ baseURL, connectionMeta })` 通过相对 baseURL 找 `__connection.json` 与静态 RPC dump。dev 模式额外先 fetch `/api/metadata.json` 拿 `ConnectionMeta`。源码位置: packages/node-modules-inspector/src/app/backends/dev.ts:23-36

- **baseURL 解析注释里点出一个 ufo 库的坑**：`withBase` 对根路径 "/" 会丢前导斜杠导致相对当前路由（如 `/grid/depth`）而非 origin，所以必须把 baseURL 解析成 origin-rooted 绝对 URL。源码位置: packages/node-modules-inspector/src/app/backends/dev.ts:9-17

- **entry 切换是编译期**：`entries/index.ts` 用 `defineAsyncComponent(() => import.meta.env.BACKEND === 'webcontainer' ? './webcontainer.vue' : './dev.vue')`。源码位置: packages/node-modules-inspector/src/app/entries/index.ts:3-8

- **常量在 nuxt.config.ts 注入**：`'import.meta.env.BACKEND': JSON.stringify(backend)`——`backend` 来自 Nuxt 构建配置。源码位置: packages/node-modules-inspector/src/nuxt.config.ts:115

- **`fetchData` 是能力感知的协调器**：拉 payload 后用 `if (backend.functions.getPackagesNpmMeta && npmMetaSpecs.length)` 守卫式并发拉补全元数据；静态模式下守卫不通过、直接跳过。源码位置: packages/node-modules-inspector/src/app/state/data.ts:30-60

- **payload 拉回后用 `Object.freeze` 冻结**：`Object.freeze(data)` + 逐 pkg `Object.freeze(pkg)`，作为"不可变契约"在响应式消费者间共享。源码位置: packages/node-modules-inspector/src/app/state/data.ts:21-23

- **错误去向后端自己的 connectionError 槽**：`getPayload` try/catch 把 err 写进 `backend.connectionError.value`，main.vue 读这个 ref 显示错误条。错误归属"后端"而非"调用点"。源码位置: packages/node-modules-inspector/src/app/backends/dev.ts:51-58、packages/node-modules-inspector/src/app/entries/main.vue:13-22

- **UI 用 isDynamic 做能力分组**：`Settings.vue` 与 `MaintainerActions.vue` 都用 `v-if="backend.isDynamic"` 决定某些动态专属面板是否渲染——**isDynamic 是粗粒度开关，functions.X 是细粒度开关，二者并存**。源码位置: packages/node-modules-inspector/src/app/components/report/MaintainerActions.vue:184、packages/node-modules-inspector/src/app/components/panel/Settings.vue:61

- **UI 用 `functions.X?` 做按钮级特征检测**：`Overview.vue` 用 `backend.functions.openInFinder?.(...)`、`PackageDetailsInfo.vue` 用 `v-if="backend?.functions.openInEditor && pkg.filepath"` 决定按钮显隐。源码位置: packages/node-modules-inspector/src/app/components/panel/Overview.vue:76、packages/node-modules-inspector/src/app/components/panel/PackageDetailsInfo.vue:139-152

- **`import.meta.env.BACKEND === 'webcontainer'` 还被用来调默认值**：`shared/filters.ts` 把 `excludeWorkspace` 默认设为 webcontainer 时为 true——编译期常量也参与了少量行为默认值的差异化。源码位置: packages/node-modules-inspector/src/shared/filters.ts:53

- **WebContainer 也产 Backend**：`install()` 返回类型是 `Backend`——这是"另一实现"，不是 dev 工厂的分支；WebContainer 同样通过接口契约接入 app。源码位置: packages/node-modules-inspector/src/app/webcontainer/container.ts:37-39

## 关键调用链

**部署时 entry 选择（编译期）**：
`import.meta.env.BACKEND`（nuxt.config.ts:115 注入） → `entries/index.ts` `defineAsyncComponent` → 选择 `dev.vue` 或 `webcontainer.vue`

**运行期 Backend 安装（dev/static 路径）**：
`dev.vue` → `createDevBackend()` → `connectDevframe({ baseURL, connectionMeta })` → 协商传输层 → 构造 Backend 对象（按 `isWebsocket` 条件填充 functions） → `backend.value = b` → `b.connect()` → `fetchData()`
源码位置: packages/node-modules-inspector/src/app/entries/dev.vue:10-20、packages/node-modules-inspector/src/app/backends/dev.ts:36-75

**运行期 Backend 安装（webcontainer 路径）**：
`webcontainer.vue` → `Landing.vue` `install(input.split(' '))` → `WebContainer.boot()` + spawn pnpm install + 启动打包好的 server.mjs → 返回 Backend → `backend.value = b` → `fetchData(false, true)`
源码位置: packages/node-modules-inspector/src/app/webcontainer/Landing.vue:36-37、packages/node-modules-inspector/src/app/webcontainer/container.ts:37-39

**数据获取（能力感知）**：
`fetchData(force)` → `backend.functions.getPayload(force)` → freeze → 守卫式并发 `getPackagesNpmMeta` / `getPackagesNpmMetaLatest` → `Promise.all` → 写入 `rawPayload / rawNpmMeta / rawNpmMetaLatest`
源码位置: packages/node-modules-inspector/src/app/state/data.ts:15-60

**懒拉 publint（按需）**：
`fetchPublintMessages(pkg)` → 命中缓存？→ 守卫 `backend.functions.getPublint` → 调用并写 `rawPublintMessages`
源码位置: packages/node-modules-inspector/src/app/state/data.ts:79-104

## 源码摘录（带行号，全文累计 ≤ 30 行）

**Backend 接口（types/backend.ts）**——本章灵魂定义，必贴：
```ts
// packages/node-modules-inspector/src/app/types/backend.ts:12-30
export interface BackendCallableFunctions {
  getPayload: (force?: boolean) => Promise<NodeModulesInspectorPayload>
  getPackagesNpmMeta?: (specs: string[]) => Promise<Map<string, NpmMeta | null>>
  getPackagesNpmMetaLatest?: (pkgNames: string[]) => Promise<Map<string, NpmMetaLatest | null>>
  getPublint?: (pkg: Pick<PackageNode, 'private' | 'workspace' | 'spec' | 'filepath'>) => Promise<PublintMessage[] | null>
  openInEditor?: (filename: string) => void
  openInFinder?: (filename: string) => void
}

export interface Backend {
  name: string
  status: Ref<'idle' | 'connecting' | 'connected' | 'error'>
  connectionError: Ref<unknown | undefined>
  connect: () => Promise<void> | void
  isDynamic?: boolean
  functions: Functions
}
```

**条件填充 functions（dev.ts）**——"能力下沉为可选字段"的实操，必贴：
```ts
// packages/node-modules-inspector/src/app/backends/dev.ts:39-73
const isWebsocket = rpc.connectionMeta.backend === 'websocket'
return {
  name: isWebsocket ? 'dev' : 'static',
  status, connectionError,
  isDynamic: isWebsocket,
  connect() {},
  functions: {
    getPayload: async (force?: boolean) => { /* call('nmi:get-payload', force) */ },
    getPackagesNpmMeta: isWebsocket ? (specs) => call('nmi:get-packages-npm-meta', specs) : undefined,
    getPublint: isWebsocket ? (pkg) => call('nmi:get-publint', pkg) : undefined,
    openInEditor: isWebsocket ? (fn) => { void callEvent('nmi:open-in-editor', fn) } : undefined,
    openInFinder: isWebsocket ? (fn) => { void callEvent('nmi:open-in-finder', fn) } : undefined,
  },
}
```

**模块级单例 + 非空访问器（backends/index.ts）**——全文件贴完：
```ts
// packages/node-modules-inspector/src/app/backends/index.ts:1-8
import type { Backend } from '../types/backend'
import { shallowRef } from 'vue'

export const backend = shallowRef<Backend>()

export function getBackend() {
  return backend.value!
}
```

**编译期 entry 选择（entries/index.ts）**——全文件贴完：
```ts
// packages/node-modules-inspector/src/app/entries/index.ts:1-8
import { defineAsyncComponent } from 'vue'
export default defineAsyncComponent(() => {
  if (import.meta.env.BACKEND === 'webcontainer')
    return import('./webcontainer.vue')
  else
    return import('./dev.vue')
})
```

## 易混淆 / 边界 / 推断

- **事实**：`status` 字面量集合为 `'idle' | 'connecting' | 'connected' | 'error'`，但本批 sourceFiles 中只观察到 `'connecting'` 与 `'connected'` 被显式赋值；`'idle'` 与 `'error'` 在 main.vue 被读取，但本批文件未观察到写入。源码位置: types/backend.ts:25、dev.ts:33,37、main.vue:13-22

- **推断**：`ReferencePayloadFunctions`（getReferencePayload/saveReferencePayload 等 4 个字段）目前**无任何调用方**，是预留扩展点——可能在 `node/storage.ts`（不在本章 sourceFiles）有相关后端，但前端目前未消费。源码位置: types/backend.ts:5-10

- **推断**：dev/static 共用同一个工厂 `createDevBackend` 而非拆两个，**好处**是分支收敛在一处（`isWebsocket` 决定一切）；**坏处**是类型上 `Backend.functions` 的所有可选字段对 dev 模式而言其实都"应该存在"，但类型无法表达这种"按部署形态收紧"——dev 调用方拿到 `getPublint` 仍需 `if` 守卫。源码位置: dev.ts:36-75

- **事实**：`isDynamic` 与"是否有某函数"是**冗余但并存**的两层开关：`isDynamic` 是粗粒度（整体能力面），`functions.X?` 是细粒度（按钮级）。UI 中两者都用。源码位置: MaintainerActions.vue:184（isDynamic）、PackageDetailsInfo.vue:139（functions.X）

- **事实**：编译期常量 `import.meta.env.BACKEND` 与运行期 `isDynamic` 各管不同的事：前者挑 entry 组件（webcontainer vs dev/static），后者挑 dev/static 内部的动态/静态能力。两者**不重叠**——webcontainer 的 Backend 是 `install()` 构造的，不走 `isDynamic` 这条分支。源码位置: entries/index.ts:4、dev.ts:47

- **事实**：`backend.value!` 的非空断言假设调用方只在 entry 组件已挂载后访问——main.vue 用 `v-if="!backend || !rawPayload"` 守卫未就绪状态，保证 NuxtPage 渲染前 backend 已设。源码位置: backends/index.ts:7、main.vue:22,55

- **未理解**：`status.value = 'connected'` 在 `connectDevframe` 完成后立即设置，但 `connect()` 方法体是空的 `connect() {}`——连接逻辑实际发生在工厂内部，`connect()` 似乎只是接口契约占位（dev.vue 仍显式 `await b.connect()` 但其实没做任何事）。源码位置: dev.ts:36-48

- **事实**：`shallowRef` 而非 `ref` 用于 backend——Backend 内含 RPC 闭包与 `Ref` 字段，深响应式化既浪费又可能引发循环。源码位置: backends/index.ts:4、dev.ts:33-34

- **事实**：baseURL 必须解析为 origin-rooted 绝对 URL，否则 ufo 的 `withBase` 在根 baseURL 下会丢前导斜杠、相对当前路由而非 origin 解析，在 `/grid/depth` 这种子路由上 404。源码位置: dev.ts:9-17
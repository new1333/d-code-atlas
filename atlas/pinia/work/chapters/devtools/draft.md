# Vue Devtools 集成：让 Pinia 运行时变得「可观察」

Pinia 本身是一个「黑盒运行时」：你定义 store、调 action、`$patch` 状态，但状态怎么变、action 何时触发，从外面看不清。本章讲的 `packages/pinia/src/devtools/` 这 5 个文件，就是把 Pinia 接入 **Vue Devtools** 的整套适配层——它在 store 实例化时悄悄装上探针，把内部模型「翻译」成 Devtools 能理解的协议（inspector 树、timeline 时间线、组件面板注入），并处理双向同步（你在面板里改 state、或 action 内的多次变更要分组）。

**前置概念**（来自依赖章节）：Pinia 根实例持有全局状态 `pinia.state.value` 与 store 注册表 `pinia._s: Map`（[[pinia-instance]]）；每个 store 经 `defineStore` 实例化后挂在 `_s` 上，带 `$state`/`$id` 等（[[store-definition]]）；状态变更的语义由 `MutationType` 枚举描述（[[core-types]]）。

本章会反复用到 store 实例上的 5 个运行时方法，它们都定义在 `store.ts`（正式讲解见 [[store-instance-api]]，该章在本章之前）。为自包含阅读，先各给一句前置说明：

- **`$subscribe(cb, opts)`**：订阅 state 变更，每次 `$state` 被改写都触发，回调拿到 `MutationType` 与 Vue 的 `DebuggerEvent`；
- **`$onAction(cb, prepend?)`**：订阅 action 调用，回调内提供 `after`/`onError` 钩子；第二参 `true` 表示前置注册；
- **`$patch(obj | fn)`**：批量变更 state，对象走深合并、函数直接改；
- **`$reset()`**：把 Options store 的 state 重置回初始值（Setup store 没有此方法）；
- **`$dispose()`**：注销 store，停止其全部响应式 effect 与订阅。

本章按**自底向上**展开：先看 3 个最朴素的工具函数，再看「Pinia 模型 ↔ Devtools 协议」的翻译层，再到全局状态导入导出，最后是贯穿一切的装配核心 `plugin.ts`。文末（§八）给出一个**可 `bun run` 的最小复刻**，把前三个零件落成可运行代码。

---

## 一、地基：三个工具函数（`utils.ts`）

整个 devtools 模块反复复用 3 个小函数。下面这块代码**即复刻文件 `replica/entry.ts` 的逐字内容**（对应源 `utils.ts:11-37`）：

```ts
// ── utils.ts:11-37 ──
export function toastMessage(
  message: string,
  type?: 'normal' | 'error' | 'warn'
) {
  const piniaMessage = '🍍 ' + message // 统一加 🍍 前缀，便于在控制台里辨认
  if (type === 'error') console.error(piniaMessage)
  else if (type === 'warn') console.warn(piniaMessage)
  else console.debug(piniaMessage) // 注意：'normal' 也走 debug，不打扰生产控制台
}

export function isPinia(o: any): boolean {
  return '_a' in o && 'install' in o // duck-typing：根实例有 _a(App)+install，普通 store 没有
}

export function isWritableComputed(store: any, key: string): boolean {
  const rawProp = toRaw(store)[key] // 取原始值，绕开响应式代理
  return isRef(rawProp) && !isReadonly(rawProp) // 是 ref 且非只读 → 带 setter 的可写 computed
}
```

`isPinia` 是后文的关键判别器：在 inspector 里，根节点（Pinia 实例）和每个 store 节点共用同一套渲染逻辑，靠它分流；`isWritableComputed` 决定一个 getter 在面板里能否被直接编辑——只有带 setter 的 `computed` 才允许。

---

## 二、翻译层：把 store / 事件格式化成 Devtools 数据结构（`formatting.ts`）

Devtools 定义了一套自己的数据协议（`CustomInspectorNode`、`CustomInspectorState`、timeline event），Pinia 的内部模型（`$state`/`$id`/`DebuggerEvent`）不能直接喂进去。`formatting.ts` 就是这层翻译。它还定义了两个常量（`formatting.ts:94-95`）：`PINIA_ROOT_LABEL = '🍍 Pinia (root)'`、`PINIA_ROOT_ID = '_root'`。

下面这块同样是 `replica/entry.ts` 的逐字内容（对应源 `formatting.ts:86-215`）：

```ts
// ── formatting.ts:86-109, 111-171, 204-215 ──
export function formatDisplay(display: string) {
  return { _custom: { display } } // devtools 只读展示协议
}

export function formatStoreForInspectorTree(store: any) {
  return isPinia(store)
    ? { id: PINIA_ROOT_ID, label: PINIA_ROOT_LABEL } // 根节点固定
    : { id: store.$id, label: store.$id } // 叶子节点 = 各 store
}

export function formatStoreForInspectorState(store: any) {
  if (isPinia(store)) {
    // 根：state 段列出所有已注册 store，getters 段汇总「有 _getters 的 store」
    const storeNames = Array.from(store._s.keys()) as string[]
    const storeMap = store._s
    return {
      state: storeNames.map((id) => ({
        editable: true,
        key: id,
        value: store.state.value[id],
      })),
      getters: storeNames
        .filter((id) => storeMap.get(id)._getters)
        .map((id) => {
          const s = storeMap.get(id)
          return {
            editable: false,
            key: id,
            value: s._getters.reduce(
              (acc: Record<string, any>, k: string) => ((acc[k] = s[k]), acc),
              {}
            ),
          }
        }),
    }
  }
  // 普通 store：state 段 = $state 的每个 key
  const state: Record<string, any> = {
    state: Object.keys(store.$state).map((key) => ({
      editable: true,
      key,
      value: store.$state[key],
    })),
  }
  // getters 段：editable 取 isWritableComputed（带 setter 才可编）
  if (store._getters && store._getters.length) {
    state.getters = store._getters.map((name: string) => ({
      editable: isWritableComputed(store, name),
      key: name,
      value: store[name],
    }))
  }
  // 自定义属性段（Setup store 里手动加入的）
  if (store._customProperties.size) {
    state.customProperties = Array.from(store._customProperties).map((key: string) => ({
      editable: true,
      key,
      value: store[key],
    }))
  }
  return state
}

export function formatMutationType(type: MutationType): string {
  switch (type) {
    case MutationType.direct:
      return 'mutation' // 直接赋值
    case MutationType.patchFunction:
      return '$patch' // store.$patch(state => {...})
    case MutationType.patchObject:
      return '$patch' // store.$patch({...})
    default:
      return 'unknown'
  }
}
```

`formatStoreForInspectorState` 的两条分支正是「根 vs 普通 store」的差异所在：根节点列出所有已注册 store 并汇总 getters；普通 store 列自己的 `$state`，且 getter 是否可编由 `isWritableComputed` 判定。

> ⚠️ 注意 `MutationType` 的**枚举名**是 `direct/patchObject/patchFunction`，但**运行时值**带空格（`'patch object'`、`'patch function'`，见 `types.ts:51-65`）。`formatMutationType` 用枚举成员做 `switch`，匹配的是运行时值；若你在 `$subscribe` 回调里手动判断 `type`，拿到的是带空格的字符串。

---

## 三、全局动作：状态的导入/导出/复制粘贴（`actions.ts`）

文件顶部注释点明：**「these are not Pinia actions」**（`actions.ts:5-7`）——它们不是 store 上的 action，而是 Devtools 面板按钮触发的全局操作。四个对外 action 都围绕剪贴板/文件做 state 的搬运：

```
copy  : JSON.stringify(pinia.state.value) ──► navigator.clipboard.writeText   (L32-45)
paste : navigator.clipboard.readText ──► JSON.parse ──► loadStoresState       (L47-60)
save  : new Blob([JSON.stringify(state)]) ──► saveAs('pinia-state.json')       (L62-77)
open  : getFileOpener() 弹文件框 ──► file.text() ──► JSON.parse ──► loadStoresState (L105-120)
```

两个工程细节值得注意：① 剪贴板在非聚焦页面会抛 `'document is not focused'`，`checkNotFocusedError` 会友好提示去 Rendering 面板开「Emulate a focused page」（`L18-30`）；② 文件输入框用模块级单例 `fileInput` **惰性创建**，首次调用才 `createElement`（`L79-103`）。

最核心的是回灌函数 `loadStoresState`——它必须处理「目标 store 是否已实例化」两种情况。下面这块也是 `replica/entry.ts` 的逐字内容（对应源 `actions.ts:122-133`）：

```ts
// ── actions.ts:122-133 ──
export function loadStoresState(pinia: any, state: Record<string, any>) {
  for (const key in state) {
    const storeState = pinia.state.value[key]
    if (storeState) {
      Object.assign(storeState, state[key]) // 已实例化：patch 进现有 state（不重建 store）
    } else {
      pinia.state.value[key] = state[key] // 未实例化：写初始 state，等实例化时被 hydrate 读取
    }
  }
}
```

这条双分支是导入功能能「先于 store 实例化导入数据」的关键：数据先落进根 state，等对应 store 真正 `defineStore` 实例化时由 hydrate 读取。

---

## 四、装配核心：双层注册（`plugin.ts`）

前三层都是「零件」。`plugin.ts` 是把它们组装起来、并对接 Devtools 运行时的核心。它的灵魂是一个**二元结构**：

```
全局注册一次              每 store 注册一次
registerPiniaDevtools    devtoolsPlugin → addStoreToDevtools
(app, pinia)             (pinia.use(devtoolsPlugin) 后，每个 store 实例化触发)
─────────────────────    ─────────────────────────────────
timeline layer           $onAction（🛫/🛬/💥）
inspector 面板           $subscribe（mutation 事件）
4 全局 actions           _customProperties watch
nodeActions(reset)       _hotUpdate / $dispose 包装
5 个 api.on 钩子          首次刷新 + installed toast
```

两者都调 `setupDevtoolsPlugin`（Vue Devtools 的统一入口），但职责互补：`registerPiniaDevtools` 建「全局设施」（一次），`addStoreToDevtools` 给每个 store 装「事件探针」（多次）。

### 4.1 第一层：`registerPiniaDevtools`（app 安装时一次）

它注释写得很直白——「Add the pinia plugin **without any store**」，目的是即便还没任何 store，也能让 Pinia 面板尽早显示（`plugin.ts:55-62`）。回调里依次：版本守卫（`L74`）→ `addTimelineLayer('pinia:mutations')`（`L80`）→ `addInspector`（带 copy/paste/save/open 4 个全局 action 与 reset 这个 nodeAction，`L86`）→ **5 个 `api.on` 钩子**：`inspectComponent`(`L150`)、`getInspectorTree`(`L205`)、`getInspectorState`(`L229`)、`editInspectorState`(`L251`)、`editComponentState`(`L285`)。其中 inspector 编辑钩子是**防回环**的所在地：

```ts
// 源码节选（plugin.ts:L251-283，闭合变量 api/payload/pinia 来自 setupDevtoolsPlugin 回调）
api.on.editInspectorState((payload) => {
  const inspectedStore = payload.nodeId === PINIA_ROOT_ID ? pinia : pinia._s.get(payload.nodeId)
  const { path } = payload
  if (!isPinia(inspectedStore)) {
    // 普通编辑默认写到 $state 上；除非目标是自定义属性/可写计算属性
    if (path.length !== 1 || (!inspectedStore._customProperties.has(path[0])
        && !isWritableComputed(inspectedStore, path[0])) || path[0] in inspectedStore.$state)
      path.unshift('$state')
  } else {
    path.unshift('state') // 根节点：Devtools API 会自动补 .value
  }
  isTimelineActive = false // ← 关键：暂停时间线
  payload.set(inspectedStore, path, payload.state.value)
  isTimelineActive = true // ← 写完立即恢复
})
```

`globalThis.$pinia = pinia`（`L227`）和选中 store 时的 `globalThis.$store = toRaw(store)`（`L245`）把实例挂到 window，方便你在控制台直接 `$pinia.state.value` 调试。

### 4.2 第二层：`addStoreToDevtools`（每个 store 实例化一次）

这是「事件探针」的密集区（`plugin.ts:313-512`）。它挂上三组监听，把 store 的动态都送进 timeline/inspector：

- **`$onAction(..., true)`**（第三参 `true` = prepend，保证 Pinia 自己的钩子先于用户钩子执行）：用模块级 `runningActionId++` 当 `groupId`，action 开始发 🛫、`after` 发 🛬（带 `result`）、`onError` 发 💥（`logType:'error'`）（`L344-400`）。
- **`$subscribe(..., { detached: true, flush: 'sync' })`**：每次 state 变更刷新 inspector；`isTimelineActive` 时发一条 mutation 事件，标题走 `formatMutationType(type)`，subtitle 按 `patchFunction→⤵️`、`patchObject→🧩` 区分（`L428-471`）。`detached:true` 让订阅不随 effect scope 回收（store 自管生命周期），`flush:'sync'` 保证变更与时间线时序一致。
- **`store._customProperties`** 每个属性挂一个 `watch(..., { deep: true })`，变化即刷新并发一条 `Change` 事件（`L402-426`）。

此外它还**包装**了 `_hotUpdate`（HMR 后发 🔥 + 刷新树/状态，`L473-492`）与 `$dispose`（dispose 后刷新并 toast 🗑，`L494-502`），并在收尾主动 `notifyComponentUpdate` + `sendInspectorTree/State` 触发首次渲染、toast「... store installed 🆕」。

### 4.3 入口 `devtoolsPlugin`：决定每个 store 怎么接入

`pinia.use(devtoolsPlugin)` 注册后，每个 store 实例化都会跑它：

```ts
// 源码节选（plugin.ts:L570-609）
export function devtoolsPlugin({ app, store, options }: PiniaPluginContext) {
  if (store.$id.startsWith('__hot:')) return               // ① HMR 临时 store 不接入
  store._isOptionsAPI = !!options.state                     // ② Options 写法才有 options.state
  if (!store._p._testing) {                                 // ③ @pinia/testing 兼容：别覆盖被 mock 的 action (#2298)
    patchActionForGrouping(store, Object.keys(options.actions), store._isOptionsAPI)
    // 再包一层 _hotUpdate，让 HMR 后的新 actions 也被 patch
  }
  addStoreToDevtools(app, store)                            // ④ 装事件探针
}
```

---

## 五、两个精妙设计

### 5.1 action 分组：把「一次 action 内的多次变更」归到同一条时间线

一个问题：你在 Devtools 时间线里，怎么知道哪几次 state 变更是同一次 action 触发的？答案是两个模块级变量 + 一个 Proxy（`plugin.ts:514-565`）：

```
runningActionId  ：单调递增，每次 action 开始 ++，作 timeline groupId
activeAction     ：action 执行期间被设置，供 $subscribe 的 mutation 事件当 groupId
```

`patchActionForGrouping` 用 Proxy 包装 store 作为 action 的执行上下文，在每次 `get`/`set` 时设 `activeAction = _actionId`，从而把 action 内的 state 变更与该 action 关联：

```ts
// 源码节选（plugin.ts:L537-563）
for (const actionName in actions) {
  store[actionName] = function () {
    const _actionId = runningActionId
    const trackedStore = wrapWithProxy
      ? new Proxy(store, {                       // 只对 Options API store 启用 Proxy
          get(...a) { activeAction = _actionId; return Reflect.get(...a) },
          set(...a) { activeAction = _actionId; return Reflect.set(...a) },
        })
      : store
    activeAction = _actionId
    const ret = actions[actionName].apply(trackedStore, arguments)
    activeAction = undefined // Setup store 异步 action 在外部做的变更更安全
    return ret
  }
}
```

**注意 Proxy 只对 Options API store 启用**（第三参 `wrapWithProxy = store._isOptionsAPI`）。原因：Setup store 的异步 action 在 `await` 之后做的变更，无法被同步 Proxy 捕获——它退化为「调用前设 `activeAction`、调用后立即清空」。源码注释指出真正彻底的方案是 `tc39/proposal-async-context`。

### 5.2 防回环：`isTimelineActive`

`isTimelineActive`（`plugin.ts:29`，默认 `true`）只在两处临时置 `false`：`editInspectorState`（`L279`）与 `editComponentState`（`L304`）。作用是——**当你在 Devtools 面板里手动改 state 时**，`payload.set` 写入会触发 `$subscribe`，但此刻 `isTimelineActive=false`，`$subscribe` 回调里 `if (!isTimelineActive) return`（`L433`）直接跳过，从而**避免「人为编辑」又被记成一条 mutation 时间线事件**。它不是开关 Devtools 本身，只控制是否把变更写进 mutations 时间线。

---

## 六、端到端数据流

把四、五两节连起来，三条主线清晰可辨：

**① 装配链**（启动时）
```
app 安装 pinia ──► registerPiniaDevtools(app, pinia)         （全局设施，一次）
pinia.use(devtoolsPlugin)
  └─ 每个 store 实例化 ──► devtoolsPlugin
       ├─ HMR 临时 store(__hot:)? ──► return
       ├─ _isOptionsAPI = !!options.state
       ├─ [非 _testing] patchActionForGrouping + 包 _hotUpdate
       └─ addStoreToDevtools ──► $onAction / $subscribe / watch / 首次刷新
```

**② timeline 数据流**（运行时）——这条最能体现 action 分组：
```
action 调用
  └─ $onAction(prepend:true)
       ├─ 🛫 事件 (groupId = runningActionId++)
       └─ after: 🛬 (含 result)      onError: 💥 (logType:error)
patchActionForGrouping 的 Proxy 在 action 执行期间设 activeAction
  ↓
state 变更
  └─ $subscribe({detached, flush:'sync'})
       └─ [isTimelineActive] mutation 事件
            ├─ title  = formatMutationType(type)
            ├─ data   = { store, ...formatEventData(events) }
            └─ groupId = activeAction   ← 同一次 action 的多次变更归到同一组
（防回环：面板内编辑时 isTimelineActive=false，此分支被跳过）
```

**③ inspector 数据流**（面板交互）
```
getInspectorTree  ──► formatStoreForInspectorTree    （左侧树）
getInspectorState ──► formatStoreForInspectorState   （右侧 state/getters/customProperties）
editInspectorState──► 路径改写(unshift '$state'/'state') + payload.set（暂停时间线）
inspectComponent  ──► 从 componentInstance.proxy._pStores 注入组件面板
```

---

## 七、小结

Pinia 的 Devtools 集成是一套**「适配器 + 双向桥」**：`formatting.ts` 把内部模型单向翻译成 Devtools 协议（出），`editInspectorState`/`editComponentState` 把面板编辑反向写回 store（入）。围绕它有三道工程巧思——

1. **双层注册**：全局设施注册一次、每 store 探针注册一次，职责正交；
2. **action 分组**：用 `runningActionId`/`activeAction` + Proxy，把分散的 state 变更归因到具体 action（Options/Setup 两种 store 用不同策略）；
3. **防回环**：`isTimelineActive` 让「面板编辑」与「自动记录」互不干扰。

理解了这三点，Devtools 里看到的 🛫/🛬/💥、`pinia:mutations` 时间线分组、可编辑的 state 与 getters，就都有了对应的源码出处。`globalThis.$pinia`/`$store` 则是这套体系留给你的「应急后门」——Devtools 打开时直接在控制台操作原始实例。

---

## 八、可运行复刻（`replica/`）

前三个零件（utils / formatting / actions）不依赖任何 Pinia 内部模块，只用到 `vue` 的几个 API，因此可以独立跑起来。下面给出 `replica/package.json` 与 `replica/entry.ts` 的完整内容——其中 `toastMessage`/`isPinia`/`isWritableComputed`/`format*`/`loadStoresState` 与 §一、§二、§三 的内嵌块**逐字一致**。用 mock 的 inspector 数据结构 + 内存中的 store/pinia 对象，跑通三大核心分支：`formatStoreForInspectorState` 的根/普通两分支、`loadStoresState` 的已实例化/未实例化双分支、`formatMutationType` 的输出。

`replica/package.json`：
```json
{
  "name": "pinia-devtools-replica",
  "private": true,
  "type": "module",
  "dependencies": {
    "vue": "^3.4.0"
  },
  "scripts": {
    "start": "bun run entry.ts"
  }
}
```

`replica/entry.ts`：
```ts
// Pinia devtools 适配层最小可运行复刻。
// 用 mock 的 inspector 数据结构 + 内存中的 store/pinia 对象，
// 跑通 utils.ts / formatting.ts / actions.ts 的核心分支。运行：bun run entry.ts
import { computed, isReadonly, isRef, toRaw } from 'vue'

// 等价于 pinia types.ts 的 MutationType（注意运行时值带空格）
export enum MutationType {
  direct = 'direct',
  patchObject = 'patch object',
  patchFunction = 'patch function',
}

// formatting.ts 常量
export const PINIA_ROOT_LABEL = '🍍 Pinia (root)'
export const PINIA_ROOT_ID = '_root'

// ── utils.ts:11-37 ──
export function toastMessage(
  message: string,
  type?: 'normal' | 'error' | 'warn'
) {
  const piniaMessage = '🍍 ' + message // 统一加 🍍 前缀，便于在控制台里辨认
  if (type === 'error') console.error(piniaMessage)
  else if (type === 'warn') console.warn(piniaMessage)
  else console.debug(piniaMessage) // 注意：'normal' 也走 debug，不打扰生产控制台
}

export function isPinia(o: any): boolean {
  return '_a' in o && 'install' in o // duck-typing：根实例有 _a(App)+install，普通 store 没有
}

export function isWritableComputed(store: any, key: string): boolean {
  const rawProp = toRaw(store)[key] // 取原始值，绕开响应式代理
  return isRef(rawProp) && !isReadonly(rawProp) // 是 ref 且非只读 → 带 setter 的可写 computed
}

// ── formatting.ts:86-109, 111-171, 204-215 ──
export function formatDisplay(display: string) {
  return { _custom: { display } } // devtools 只读展示协议
}

export function formatStoreForInspectorTree(store: any) {
  return isPinia(store)
    ? { id: PINIA_ROOT_ID, label: PINIA_ROOT_LABEL } // 根节点固定
    : { id: store.$id, label: store.$id } // 叶子节点 = 各 store
}

export function formatStoreForInspectorState(store: any) {
  if (isPinia(store)) {
    // 根：state 段列出所有已注册 store，getters 段汇总「有 _getters 的 store」
    const storeNames = Array.from(store._s.keys()) as string[]
    const storeMap = store._s
    return {
      state: storeNames.map((id) => ({
        editable: true,
        key: id,
        value: store.state.value[id],
      })),
      getters: storeNames
        .filter((id) => storeMap.get(id)._getters)
        .map((id) => {
          const s = storeMap.get(id)
          return {
            editable: false,
            key: id,
            value: s._getters.reduce(
              (acc: Record<string, any>, k: string) => ((acc[k] = s[k]), acc),
              {}
            ),
          }
        }),
    }
  }
  // 普通 store：state 段 = $state 的每个 key
  const state: Record<string, any> = {
    state: Object.keys(store.$state).map((key) => ({
      editable: true,
      key,
      value: store.$state[key],
    })),
  }
  // getters 段：editable 取 isWritableComputed（带 setter 才可编）
  if (store._getters && store._getters.length) {
    state.getters = store._getters.map((name: string) => ({
      editable: isWritableComputed(store, name),
      key: name,
      value: store[name],
    }))
  }
  // 自定义属性段（Setup store 里手动加入的）
  if (store._customProperties.size) {
    state.customProperties = Array.from(store._customProperties).map((key: string) => ({
      editable: true,
      key,
      value: store[key],
    }))
  }
  return state
}

export function formatMutationType(type: MutationType): string {
  switch (type) {
    case MutationType.direct:
      return 'mutation' // 直接赋值
    case MutationType.patchFunction:
      return '$patch' // store.$patch(state => {...})
    case MutationType.patchObject:
      return '$patch' // store.$patch({...})
    default:
      return 'unknown'
  }
}

// ── actions.ts:122-133 ──
export function loadStoresState(pinia: any, state: Record<string, any>) {
  for (const key in state) {
    const storeState = pinia.state.value[key]
    if (storeState) {
      Object.assign(storeState, state[key]) // 已实例化：patch 进现有 state（不重建 store）
    } else {
      pinia.state.value[key] = state[key] // 未实例化：写初始 state，等实例化时被 hydrate 读取
    }
  }
}

// ── 验证：mock store + pinia，跑通各分支 ──
function main() {
  // 一个可写 getter（带 setter）+ 一个只读 getter，用来区分 isWritableComputed 两分支
  const writableCount = computed({ get: () => 1, set: () => {} })
  const readonlyDoubled = computed(() => 2)

  const counterStore = {
    $id: 'counter',
    $state: { count: 0 },
    _getters: ['count', 'doubled'],
    _customProperties: new Set(['debugFlag']),
    count: writableCount,
    doubled: readonlyDoubled,
    debugFlag: 42,
  }
  const todoStore = {
    $id: 'todo',
    $state: { items: [] as string[] },
    _getters: undefined,
    _customProperties: new Set<string>(),
  }
  const pinia = {
    _a: {}, // 让 isPinia 判真
    install: () => {},
    _s: new Map([
      ['counter', counterStore],
      ['todo', todoStore],
    ]),
    state: { value: { counter: counterStore.$state, todo: todoStore.$state } },
  }

  // ① 树节点：根 vs 叶子
  console.assert(
    JSON.stringify(formatStoreForInspectorTree(pinia)) ===
      JSON.stringify({ id: '_root', label: '🍍 Pinia (root)' })
  )
  console.assert(
    JSON.stringify(formatStoreForInspectorTree(counterStore)) ===
      JSON.stringify({ id: 'counter', label: 'counter' })
  )

  // ② 普通 store 状态：getter 的 editable 一真（可写）一假（只读）
  const cs = formatStoreForInspectorState(counterStore)
  console.assert(cs.getters.find((g: any) => g.key === 'count').editable === true)
  console.assert(cs.getters.find((g: any) => g.key === 'doubled').editable === false)
  console.assert(cs.customProperties[0].key === 'debugFlag')

  // ③ 根状态：汇总各 store 的 getters（只有 counter 有 _getters）
  const rs = formatStoreForInspectorState(pinia)
  console.assert(rs.state.length === 2)
  console.assert(rs.getters.length === 1)
  console.assert(rs.getters[0].key === 'counter')

  // ④ loadStoresState 已实例化分支（patch，不重建 store）
  loadStoresState(pinia, { counter: { count: 99 } })
  console.assert(pinia.state.value.counter.count === 99)

  // ⑤ loadStoresState 未实例化分支（写初始 state，store 尚未创建）
  loadStoresState(pinia, { brandNew: { x: 1 } })
  console.assert(pinia.state.value.brandNew.x === 1)
  console.assert(!pinia._s.has('brandNew'))

  // ⑥ formatMutationType：三种变更类型 → 时间线标题
  console.assert(formatMutationType(MutationType.direct) === 'mutation')
  console.assert(formatMutationType(MutationType.patchObject) === '$patch')
  console.assert(formatMutationType(MutationType.patchFunction) === '$patch')

  console.log('✅ replica 全部分支验证通过')
}

main()
```

运行方式：在 `replica/` 下 `bun install && bun run entry.ts`（或 `bun run start`），控制台应打印 `✅ replica 全部分支验证通过`——任何一条 `console.assert` 失败都会先打印 `Assertion failed`。
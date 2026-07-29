# Vue Devtools 集成 · 源码精读

> 本章 sourceFiles：`packages/pinia/src/devtools/` 下的 `index.ts`、`utils.ts`、`actions.ts`、`formatting.ts`、`plugin.ts`。
> 相对路径以 repo 根（`work/source`）为基准。`file-saver.ts` 与本目录外的 `types.ts`/`rootStore.ts` 仅作上游连接核对，非本章精读对象，但因其被直接 import，下文标注其事实来源以保持低歧义。

---

## 一、文件分工与总览（5 个文件逐个覆盖）

- **`index.ts`**：barrel 文件，仅 re-export 两个对外 API。
  源码位置: packages/pinia/src/devtools/index.ts:1
  ```ts
  export { devtoolsPlugin, registerPiniaDevtools } from './plugin'
  ```
  对外只暴露 `devtoolsPlugin`（作为 Pinia 插件，每个 store 实例化时执行）与 `registerPiniaDevtools`（app 安装时调用，注册全局 Devtools 面板）。

- **`utils.ts`**：3 个工具函数 —— `toastMessage`、`isPinia`、`isWritableComputed`。
  源码位置: packages/pinia/src/devtools/utils.ts:11-37

- **`actions.ts`**：Devtools 面板按钮触发的「全局状态复制/粘贴/保存/导入」动作；文件顶部注释明确「these are not Pinia actions」（即这些不是 store 上的 action，而是 Devtools UI 的 action）。
  源码位置: packages/pinia/src/devtools/actions.ts:5-7

- **`formatting.ts`**：把 Pinia 的 store / 变更事件格式化成 Vue Devtools API 所需的 inspector 树节点、inspector 状态、时间线事件数据结构。定义了 devtools-api 相关类型与一组 `format*` 函数。
  源码位置: packages/pinia/src/devtools/formatting.ts:1-216

- **`plugin.ts`**：核心。包含对外两个导出 `devtoolsPlugin`（每 store 插件）、`registerPiniaDevtools`（每 pinia 实例），以及内部的 `addStoreToDevtools`、`patchActionForGrouping`、模块级状态。
  源码位置: packages/pinia/src/devtools/plugin.ts:62-620

---

## 二、概念要点（每条带源码位置）

### 2.1 utils.ts

- **`toastMessage(message, type?)`**：统一加 `🍍 ` 前缀；按 `type` 分流到 `console.error` / `console.warn` / 其余走 `console.debug`（即 `normal` 也用 debug 级别，不打扰生产控制台）。
  源码位置: packages/pinia/src/devtools/utils.ts:11-24

- **`isPinia(o): o is Pinia`**：duck-typing 判断，检查对象同时含 `_a`（app）与 `install`（Vue 插件安装函数）。这两个字段对应 `Pinia` 接口的 `_a: App` 与 `install`。
  源码位置: packages/pinia/src/devtools/utils.ts:26-28
  上游定义：`_a: App`、`install` 均为 `Pinia` 接口成员。源码位置: packages/pinia/src/rootStore.ts:63-64,90

- **`isWritableComputed(store, key)`**：判断某 getter 是否「可写计算属性」（有 setter），从而决定它在 inspector 里是否 `editable`。实现用 `toRaw(store)[key]` 取原始值，再判 `isRef(...) && !isReadonly(...)`。
  源码位置: packages/pinia/src/devtools/utils.ts:34-37

### 2.2 actions.ts（全局状态的导入/导出/复制粘贴）

- **剪贴板能力探测 `checkClipboardAccess()`**：`'clipboard' in navigator` 不存在时 toast error 并返回 `true`（用作 early-return 信号）。
  源码位置: packages/pinia/src/devtools/actions.ts:11-16

- **焦点缺失友好提示 `checkNotFocusedError(error)`**：当 `error.message` 含 `'document is not focused'` 时，提示用户去 Rendering 面板打开「Emulate a focused page」。这是剪贴板 API 在非聚焦页面下的典型报错。
  源码位置: packages/pinia/src/devtools/actions.ts:18-30

- **四个对外 action**：
  - `actionGlobalCopyState(pinia)`：`JSON.stringify(pinia.state.value)` → `navigator.clipboard.writeText`。源码位置: packages/pinia/src/devtools/actions.ts:32-45
  - `actionGlobalPasteState(pinia)`：`navigator.clipboard.readText` → `JSON.parse` → `loadStoresState`。源码位置: packages/pinia/src/devtools/actions.ts:47-60
  - `actionGlobalSaveState(pinia)`：用 `saveAs` 把 state 存为 `pinia-state.json`（`text/plain;charset=utf-8` 的 Blob）。源码位置: packages/pinia/src/devtools/actions.ts:62-77
  - `actionGlobalOpenStateFile(pinia)`：通过 `getFileOpener()` 弹文件选择框（`.json`），读 `file.text()` → `JSON.parse` → `loadStoresState`。源码位置: packages/pinia/src/devtools/actions.ts:105-120

- **惰性文件输入框 `getFileOpener()`**：模块级 `fileInput` 单例，首次调用才 `document.createElement('input')`（type=file, accept=.json）；返回 `openFile()`，用 Promise 包装 `onchange`/`oncancel`/`onerror`/`click`。注意 `oncancel` 处有 `@ts-ignore`（注释「changed from 4.3 to 4.4」），是 TS lib 版本差异的权宜。
  源码位置: packages/pinia/src/devtools/actions.ts:79-103

- **回灌核心 `loadStoresState(pinia, state)`**：遍历传入 state 的每个 key：
  - 若该 store **已实例化**（`pinia.state.value[key]` 存在）→ `Object.assign(storeState, state[key])`（patch，不重建 store）；
  - 若**未实例化** → 直接 `pinia.state.value[key] = state[key]`（写入初始 state，等 store 真正实例化时由 hydrate 读取）。
  源码位置: packages/pinia/src/devtools/actions.ts:122-133

### 2.3 formatting.ts（store / 事件 → devtools 数据结构）

- 文件顶部内联了大量 `@vue/devtools-api` 的类型（`StateBase`、`CustomState`、`CustomInspectorNode`、`CustomInspectorState`、`InspectorNodeTag` 等），注释标注「types from devtools-api」。`CustomState._custom` 含 `type/display/tooltip/value/actions/fields/...` 等字段，是 devtools 自定义渲染协议。
  源码位置: packages/pinia/src/devtools/formatting.ts:6-84

- **常量**：`PINIA_ROOT_LABEL = '🍍 Pinia (root)'`、`PINIA_ROOT_ID = '_root'`。
  源码位置: packages/pinia/src/devtools/formatting.ts:94-95

- **`formatDisplay(display)`**：把任意字符串包成 `{ _custom: { display } }`，devtools 用它做只读展示。
  源码位置: packages/pinia/src/devtools/formatting.ts:86-92

- **`formatStoreForInspectorTree(store)`**：构建 inspector 左侧树节点。`isPinia(store)` 为真 → 根节点 `{ id: '_root', label: '🍍 Pinia (root)' }`；否则 → `{ id: store.$id, label: store.$id }`。
  源码位置: packages/pinia/src/devtools/formatting.ts:97-109

- **`formatStoreForInspectorState(store)`**：构建 inspector 右侧状态。两条分支：
  - **Pinia 根**：`state` 段列出所有已注册 store（`Array.from(store._s.keys())`，每项 `editable:true`、`value: store.state.value[storeId]`）；`getters` 段过滤出有 `_getters` 的 store，把每个 store 的 getter 收集成对象（`editable:false`）。
  - **普通 store**：`state` 段 = `Object.keys(store.$state)`（每项 `editable:true`）；`getters` 段（仅当 `_getters.length`）每项 `editable` 取 `isWritableComputed(store, getterName)`；`customProperties` 段（仅当 `store._customProperties.size`）每项 `editable:true`。
  源码位置: packages/pinia/src/devtools/formatting.ts:111-171

- **`formatEventData(events)`**：把 Vue 的 `DebuggerEvent` 转成 devtools 时间线 event.data。
  - 数组（批量变更）→ reduce 成 `{ oldValue, keys, operations, newValue }`；
  - 单个 → `{ operation: formatDisplay(type), key: formatDisplay(key), oldValue, newValue }`。
  源码位置: packages/pinia/src/devtools/formatting.ts:173-202

- **`formatMutationType(type)`**：把 `MutationType` 映射成时间线标题：`direct → 'mutation'`、`patchFunction → '$patch'`、`patchObject → '$patch'`、其余 → `'unknown'`。
  源码位置: packages/pinia/src/devtools/formatting.ts:204-215
  上游枚举值（注意字符串带空格）：`direct = 'direct'`、`patchObject = 'patch object'`、`patchFunction = 'patch function'`。源码位置: packages/pinia/src/types.ts:43-68

### 2.4 plugin.ts（核心装配）

- **模块级状态与常量**：`isTimelineActive = true`（在直接编辑 state 时临时置 false 以暂停时间线）；`componentStateTypes: string[]`（随 store 注册累积，传给 devtools 区分组件 state 类型）；`MUTATIONS_LAYER_ID = 'pinia:mutations'`；`INSPECTOR_ID = 'pinia'`。
  源码位置: packages/pinia/src/devtools/plugin.ts:28-34

- **`getStoreType(id)`**：`'🍍 ' + id`，作为组件面板里该 store state 的分类标签前缀。
  源码位置: packages/pinia/src/devtools/plugin.ts:53

- **`registerPiniaDevtools(app, pinia)`**：注释说明「Add the pinia plugin without any store」——即便还没有任何 store，也能让 Pinia 面板尽早显示。内部 `setupDevtoolsPlugin({ id: 'dev.esm.pinia', label, logo, packageName, homepage, componentStateTypes, app }, (api) => {...})`。源码位置: packages/pinia/src/devtools/plugin.ts:55-311
  在回调中：
  1. **版本守卫**：`typeof api.now !== 'function'` → toast 提示 devtools 版本过旧（疑似还在用 Beta）。源码位置: packages/pinia/src/devtools/plugin.ts:74-78
  2. **`api.addTimelineLayer`**：id=`pinia:mutations`，`color: 0xe5df88`。源码位置: packages/pinia/src/devtools/plugin.ts:80-84
  3. **`api.addInspector`**：id=`pinia`，icon=`storage`，`treeFilterPlaceholder: 'Search stores'`；带 4 个全局 actions（copy/paste/save/open，分别绑定 `actionGlobal*State`）与 1 组 `nodeActions`（`restore` 图标 = `$reset`，对找不到 store 或无 `$reset` 方法的做 toast warn）。源码位置: packages/pinia/src/devtools/plugin.ts:86-148
  4. **`api.on.inspectComponent`**：从 `payload.componentInstance.proxy._pStores` 取组件用到的 store，向 `payload.instanceData.state` 推 state 段与 getters 段。**Options API store** 走 `_custom.value = toRaw(store.$state)` 并附带一个 `restore` action（直接调 `store.$reset()`）；**非 Options（Setup）store** 走 `Object.keys($state).reduce` 解包 refs（代码注释：`NOTE: workaround to unwrap transferred refs`）。getters 段对每个 getter 读取时用 try/catch，出错则把 error 本身塞进去展示。源码位置: packages/pinia/src/devtools/plugin.ts:150-203
  5. **`api.on.getInspectorTree`**：构造 `[pinia, ...pinia._s.values()]`，按 `payload.filter` 过滤（对 store 按 `$id` 小写匹配，对根按 `PINIA_ROOT_LABEL` 匹配），再 `map(formatStoreForInspectorTree)` 赋给 `payload.rootNodes`。源码位置: packages/pinia/src/devtools/plugin.ts:205-224
  6. **`globalThis.$pinia = pinia`**：把 pinia 实例挂到 window，便于控制台调试。源码位置: packages/pinia/src/devtools/plugin.ts:227
  7. **`api.on.getInspectorState`**：按 `nodeId` 选中 `_root`（pinia）或对应 store；选中 store 时 `globalThis.$store = toRaw(store)`；`payload.state = formatStoreForInspectorState(inspectedStore)`。找不到 store 时静默 return（注释：可能是从别的项目恢复的选中项）。源码位置: packages/pinia/src/devtools/plugin.ts:229-249
  8. **`api.on.editInspectorState`**：编辑路径改写逻辑——
     - 非 Pinia（普通 store）：除非 path[0] 是自定义属性或可写计算属性、且不在 `$state` 中，否则 `path.unshift('$state')`（让 devtools 写到 `$state` 上）；
     - Pinia 根：`path.unshift('state')`（注释：devtools API 会自动补 `.value`）。
     然后用 `isTimelineActive = false` 包裹 `payload.set(inspectedStore, path, payload.state.value)` 再置回 true，避免这次编辑被当成 mutation 记进时间线。
     源码位置: packages/pinia/src/devtools/plugin.ts:251-283
  9. **`api.on.editComponentState`**：仅处理 `payload.type` 以 `🍍` 开头者；`storeId = type.replace(/^🍍\s*/, '')`；要求 `path[0] === 'state'`（否则 toast error「Only state can be modified」）；把 `path[0]` 改写为 `$state`，同样用 `isTimelineActive=false` 包裹 `payload.set`。
     源码位置: packages/pinia/src/devtools/plugin.ts:285-308

- **`addStoreToDevtools(app, store)`**：每个 store 实例化时调用，再次 `setupDevtoolsPlugin`（这次带 `settings.logStoreChanges`，类型 boolean、默认 true；注释里还留有被注释掉的 `useEmojis` 配置）。回调内：源码位置: packages/pinia/src/devtools/plugin.ts:313-512
  - `now` = `api.now?.bind(api)` ?? `Date.now`（容错老版 devtools）。源码位置: packages/pinia/src/devtools/plugin.ts:342
  - **`store.$onAction(..., true)`**（第三个参数 `true` = prepend，确保 pinia 自己的 action 钩子最先执行）：用模块级 `runningActionId++` 作 `groupId`，在 action 开始发 `🛫` 事件、`after` 回调发 `🛬`（含 `result`）、`onError` 发 `💥`（`logType:'error'`，含 error）。每个事件的 `data` 含 `store: formatDisplay($id)`、`action: formatDisplay(name)`、`args`。源码位置: packages/pinia/src/devtools/plugin.ts:344-400
  - **自定义属性监听**：`store._customProperties.forEach(name => watch(() => unref(store[name]), ..., { deep: true }))`，变化时 `notifyComponentUpdate()` + `sendInspectorState`，并在 `isTimelineActive` 时发一条标题 `Change`、subtitle=`name` 的时间线事件（`groupId: activeAction`）。
    源码位置: packages/pinia/src/devtools/plugin.ts:402-426
  - **`store.$subscribe(..., { detached: true, flush: 'sync' })`**：每次 state 变更都 `notifyComponentUpdate()` + `sendInspectorState`；若 `isTimelineActive`，构造 mutation 时间线事件：`title = formatMutationType(type)`，subtitle 按类型/事件定（`patchFunction→'⤵️'`、`patchObject→'🧩'`、单个 DebuggerEvent → `events.type`），`data` = `{ store, ...formatEventData(events), 'rawEvent(s)': {_custom:{...}} }`，`groupId: activeAction`。
    源码位置: packages/pinia/src/devtools/plugin.ts:428-471
  - **包装 `store._hotUpdate`**：先调原 `_hotUpdate(newStore)`，再发 `🔥` + subtitle `HMR update` 的时间线事件，并 `sendInspectorTree/State` 刷新。
    源码位置: packages/pinia/src/devtools/plugin.ts:473-492
  - **包装 `store.$dispose`**：先调原 `$dispose()`，再 `notifyComponentUpdate()` + `sendInspectorTree/State`，并在开启 `logStoreChanges` 时 toast `Disposed "..." 🗑`。
    源码位置: packages/pinia/src/devtools/plugin.ts:494-502
  - **收尾**：主动 `notifyComponentUpdate()` + `sendInspectorTree/State` 触发首次刷新；开启 `logStoreChanges` 时 toast `"... store installed 🆕"`。
    源码位置: packages/pinia/src/devtools/plugin.ts:504-509

- **`patchActionForGrouping(store, actionNames, wrapWithProxy)`**：注释说明目的——「用 Proxy 包装 store 作为 action 的 context，在每次访问/赋值时设 `runningAction`，从而把 state 变更关联到正在执行的 action」。步骤：
  1. 用 `toRaw(store)` 取原始 action（注释「use toRaw to avoid tracking #541」）；
  2. 对每个 action，替换为包装函数：进入时记录 `_actionId = runningActionId`；若 `wrapWithProxy` 则包一层 Proxy（`get/set` 都设 `activeAction = _actionId` 并 `Reflect.*`）；执行前 `activeAction = _actionId`、执行后立即 `activeAction = undefined`（注释：Setup Store 的异步 action 在 action 外做的变更更安全）。
  注释还提到 Setup Store 真正需要的是 `tc39/proposal-async-context`。
  源码位置: packages/pinia/src/devtools/plugin.ts:517-565

- **模块级变量 `runningActionId` / `activeAction`**：前者单调递增作 groupId；后者在 action 执行期间被设置，供 `$subscribe` 产生的 mutation 事件做 `groupId` 关联（即把一次 action 内的多次 state 变更归到同一条时间线分组）。
  源码位置: packages/pinia/src/devtools/plugin.ts:514-515

- **对外入口 `devtoolsPlugin({ app, store, options })`**（即 `pinia.use(devtoolsPlugin)`）：
  1. **跳过 HMR 临时 store**：`store.$id.startsWith('__hot:')` 直接 return。源码位置: packages/pinia/src/devtools/plugin.ts:577-579
  2. **判定 Options/Setup**：`store._isOptionsAPI = !!options.state`（options 写法才有 `state`）。源码位置: packages/pinia/src/devtools/plugin.ts:582
  3. **@pinia/testing 兼容守卫**：`!store._p._testing` 时才 patch actions（避免覆盖被 testing 库 mock 的 action，对应 issue #2298）；同时包装 `_hotUpdate` 以便 HMR 后对新 actions 重新 patch。源码位置: packages/pinia/src/devtools/plugin.ts:584-602
  4. 调 `addStoreToDevtools(app, store)`。源码位置: packages/pinia/src/devtools/plugin.ts:604-608

- **全局类型声明 `declare global`**：声明 `var $pinia: Pinia | undefined` 与 `var $store: StoreGeneric | undefined`（运行时在 getInspectorState 处赋值），供控制台直接访问。
  源码位置: packages/pinia/src/devtools/plugin.ts:611-620

---

## 三、关键调用链

### 3.1 插件装配链
```
pinia.use(devtoolsPlugin)
  └─ 每个 store 实例化时执行 devtoolsPlugin({app, store, options})        plugin.ts:570
       ├─ store.$id 以 '__hot:' 开头？→ return（HMR 临时 store 不接入）     plugin.ts:577
       ├─ store._isOptionsAPI = !!options.state                            plugin.ts:582
       ├─ [非 _testing] patchActionForGrouping(store, actions, isOptions)   plugin.ts:585-590
       │     └─ 包装每个 action：Proxy 设 activeAction（Options API 时）    plugin.ts:538-563
       ├─ [非 _testing] 包装 _hotUpdate：HMR 后对新 actions 再 patch        plugin.ts:593-601
       └─ addStoreToDevtools(app, store)                                   plugin.ts:604
            └─ setupDevtoolsPlugin(...) 注册 onAction/subscribe/watch 等    plugin.ts:318
```
`registerPiniaDevtools(app, pinia)` 则在 app 安装侧独立调用一次，注册全局 inspector + timeline layer + 6 个 `api.on` 钩子。源码位置: packages/pinia/src/devtools/plugin.ts:62

### 3.2 时间线（timeline）数据流
```
action 调用
  └─ $onAction(prepend:true)                                              plugin.ts:344
       ├─ start: 🛫 事件 (groupId = runningActionId++)                     plugin.ts:347-360
       ├─ after: 🛬 事件 (含 result)                                       plugin.ts:362-379
       └─ onError: 💥 事件 (logType:error, 含 error)                       plugin.ts:381-399

patchActionForGrouping 的 Proxy 在 action 执行期间设 activeAction           plugin.ts:544-555
  ↓
state 变更
  └─ $subscribe({detached, flush:'sync'})                                 plugin.ts:428-471
       ├─ notifyComponentUpdate + sendInspectorState
       └─ [isTimelineActive] mutation 事件
            ├─ title = formatMutationType(type)                           formatting.ts:204
            ├─ data = { store, ...formatEventData(events), 'rawEvent(s)' } formatting.ts:173
            └─ groupId = activeAction  ←—— 因此同一次 action 内的多个变更被归到同一分组
```
**抑制回环**：`editInspectorState` / `editComponentState` 期间 `isTimelineActive=false`，使「在 devtools 里手改 state」不会反过来再生成 mutation 时间线事件。源码位置: packages/pinia/src/devtools/plugin.ts:279-281,304-306,433

### 3.3 inspector 数据流
```
getInspectorTree  → formatStoreForInspectorTree   (树节点)                formatting.ts:97 / plugin.ts:205
getInspectorState → formatStoreForInspectorState  (右栏 state/getters)    formatting.ts:111 / plugin.ts:229
editInspectorState→ 路径改写(unshift '$state'/'state') + payload.set      plugin.ts:251-283
inspectComponent  → 从 componentInstance.proxy._pStores 注入组件面板       plugin.ts:150-203
editComponentState→ type 去 🍍 前缀取 storeId，path[0] state→$state        plugin.ts:285-308
```

### 3.4 全局状态导入/导出链
```
inspector actions（copy/paste/save/open）                plugin.ts:91-124
  └─ actionGlobalCopyState / PasteState / SaveState / OpenStateFile      actions.ts:32-120
       └─ loadStoresState(pinia, state)                                  actions.ts:122
            ├─ 已实例化 store → Object.assign(patch)                      actions.ts:126-127
            └─ 未实例化    → pinia.state.value[key] = state[key]          actions.ts:129-130
paste/open 完成后由 plugin 侧补发 sendInspectorTree + sendInspectorState   plugin.ts:103-104,119-120
```

---

## 四、源码摘录（带行号，关键片段）

### 4.1 inspector 编辑的「路径改写 + 暂停时间线」(`plugin.ts:251-283`)
```ts
api.on.editInspectorState((payload) => {
  if (payload.app === app && payload.inspectorId === INSPECTOR_ID) {
    const inspectedStore =
      payload.nodeId === PINIA_ROOT_ID ? pinia : pinia._s.get(payload.nodeId)
    if (!inspectedStore) {
      return toastMessage(`store "${payload.nodeId}" not found`, 'error')
    }
    const { path } = payload
    if (!isPinia(inspectedStore)) {
      if (
        path.length !== 1 ||
        (!inspectedStore._customProperties.has(path[0]) &&
          !isWritableComputed(inspectedStore, path[0])) ||
        path[0] in inspectedStore.$state
      ) {
        path.unshift('$state')
      }
    } else {
      path.unshift('state') // devtools API 会自动补 .value
    }
    isTimelineActive = false
    payload.set(inspectedStore, path, payload.state.value)
    isTimelineActive = true
  }
})
```

### 4.2 action 分组的 Proxy 包装 (`plugin.ts:537-563`)
```ts
for (const actionName in actions) {
  store[actionName] = function () {
    const _actionId = runningActionId
    const trackedStore = wrapWithProxy
      ? new Proxy(store, {
          get(...args) { activeAction = _actionId; return Reflect.get(...args) },
          set(...args) { activeAction = _actionId; return Reflect.set(...args) },
        })
      : store
    activeAction = _actionId
    const retValue = actions[actionName].apply(trackedStore, arguments as unknown as any[])
    activeAction = undefined // Setup Store 异步 action 在外部做的变更更安全
    return retValue
  }
}
```

### 4.3 loadStoresState 的双分支回灌 (`actions.ts:122-133`)
```ts
function loadStoresState(pinia: Pinia, state: Record<string, unknown>) {
  for (const key in state) {
    const storeState = pinia.state.value[key]
    if (storeState) {
      Object.assign(storeState, state[key]) // 已实例化：patch
    } else {
      pinia.state.value[key] = state[key] as any // 未实例化：写初始 state
    }
  }
}
```

### 4.4 isWritableComputed / isPinia (`utils.ts:26-37`)
```ts
export function isPinia(o: any): o is Pinia {
  return '_a' in o && 'install' in o
}
export function isWritableComputed(store: StoreGeneric, key: string): boolean {
  const rawProp = toRaw(store)[key]
  return isRef(rawProp) && !isReadonly(rawProp)
}
```

---

## 五、易混淆 / 需 Writer 注意

- **`devtoolsPlugin`（每 store） vs `registerPiniaDevtools`（每 pinia 实例）职责不同**：两者都调 `setupDevtoolsPlugin`，但 `registerPiniaDevtools` 负责「全局」设施——timeline layer、inspector、inspector 的 4 个全局 actions 与 nodeActions(reset)、6 个 `api.on` 钩子；`addStoreToDevtools`（由 `devtoolsPlugin` 触发）负责「每 store」设施——onAction/subscribe/watch、HMR/dispose 包装、首次刷新与 installed toast。Writer 写章节时应讲清这条「全局注册一次 + 每 store 注册一次」的二元结构。源码位置: packages/pinia/src/devtools/plugin.ts:62 与 313

- **`isTimelineActive` 是防回环开关**：在 `editInspectorState`/`editComponentState` 中临时置 false，避免「用户在 devtools 改 state」又触发 `$subscribe` → mutation 时间线事件。注意它**不是**全局开关 devtools，只控制是否把变更写进 mutations 时间线。源码位置: packages/pinia/src/devtools/plugin.ts:28,279-281,304-306,433

- **action 分组的 Proxy 只对 Options API store 启用**：`patchActionForGrouping` 的第三参 `wrapWithProxy = store._isOptionsAPI`；Setup Store 走「直接设 activeAction、调用后立即清空」的方式（注释指向 `tc39/proposal-async-context` 作为更彻底方案）。原因是 Setup store 的异步 action 在 await 之后做的变更无法被同步 Proxy 捕获。源码位置: packages/pinia/src/devtools/plugin.ts:541-562,585-590

- **`$onAction` 用 `prepend:true`、`$subscribe` 用 `{ detached:true, flush:'sync' }`**：prepend 保证 pinia 的 action 钩子先于用户钩子跑；`detached:true` 使订阅不随当前 effect scope 自动回收（store 自管生命周期），`flush:'sync'` 保证变更与时间线事件时序一致。源码位置: packages/pinia/src/devtools/plugin.ts:400,470

- **Options API vs Setup store 在 `inspectComponent` 里展示方式不同**：Options store 用 `_custom.value = toRaw(store.$state)` 且自带 reset action；Setup store 用 `reduce` 解包（注释明确是「workaround to unwrap transferred refs」）。Writer 讲组件面板注入时要点出这个差异。源码位置: packages/pinia/src/devtools/plugin.ts:165-182

- **@pinia/testing 兼容**：`!store._p._testing` 守卫阻止 patchActionForGrouping 覆盖被 mock 的 action（issue #2298）；HMR 的 `_hotUpdate` 包装也只在非 testing 时挂。源码位置: packages/pinia/src/devtools/plugin.ts:584-602

- **`globalThis.$pinia` / `globalThis.$store`**：既有运行时赋值（`$pinia` 在 registerPiniaDevtools 里赋；`$store` 在 getInspectorState 选中某 store 时赋 `toRaw(store)`），又有文件末尾的 `declare global` 类型声明。这是「devtools 打开时方便控制台调试」的便利暴露，非正式 API。源码位置: packages/pinia/src/devtools/plugin.ts:227,244-245,611-620

- **`MutationType` 的字符串值带空格**：枚举名为 `direct/patchObject/patchFunction`，但运行时值是 `'direct'/'patch object'/'patch function'`。`formatMutationType` 用枚举名做 switch（编译期常量），与运行时字符串无关；Writer 若举例 $subscribe 回调拿到的 `type`，应说明实际是带空格的字符串。源码位置: packages/pinia/src/types.ts:51-65 与 packages/pinia/src/devtools/formatting.ts:204-215

- **`file-saver.ts` 不在本章 sourceFiles 内**，但 `actions.ts` 直接 `import { saveAs } from './file-saver'`。`saveAs` 是 `export const saveAs`（基于 `IS_CLIENT` 的条件导出，是 FileSaver.js 的内联实现），供 `actionGlobalSaveState` 落盘 `pinia-state.json`。Writer 若展开「保存到文件」可一句话带过其来源，不必深讲。源码位置: packages/pinia/src/devtools/actions.ts:2 与 packages/pinia/src/devtools/file-saver.ts:110

- **未理解/留白**：`formatting.ts` 顶部那批 devtools-api 类型（`ComponentPropState.meta` 的 Vue 1 `mode`、`CustomState._custom.fields` 等）属 devtools 协议细节，本章只用到其中一小部分（`_custom.display/value/actions/type/tooltip`），其余字段 Pinia 未实际填充，无需展开。
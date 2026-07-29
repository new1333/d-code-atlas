---
title: 模块热更新支持
---

# 模块热更新支持

## 一个核心问题

在 Vite 开发服务器里，改一个普通模块会被「整块替换」——旧模块丢弃，新模块重新执行。但 Pinia 的 store 不能这么做：一个 store 实例里通常已经装着用户操作产生的运行时状态（已登录的用户、已展开的菜单、已填的表单）。如果模块热更新时把 store 推倒重来，这些状态就全没了。

所以 Pinia 的 HMR 要解决的是一个**调和（reconcile）问题**：

> 代码改了，store 的「形状」(state/getters/actions 定义) 变了，但要保留用户已经产生的运行时状态，把新定义「无损地」移植进**同一个现存实例**。

本章自底向上拆解这条链路。它依赖前置三章：[`store-definition`](./05-store-definition) 里的 `defineStore` / `useStore` / `createSetupStore` / `createOptionsStore`，[`pinia-instance`](./04-pinia-instance) 里的 store 注册表 `pinia._s` 与 `hot.data`，以及 [`core-types`](./01-core-types) 里的 `StoreDefinition` 类型与 `isPlainObject`。

---

## 一、底层原语：hmr.ts 的三件套

整条 HMR 链路的「发动机」是一个仅 122 行的文件 `packages/pinia/src/hmr.ts`，它导出三样东西：

| 导出 | 作用 | 是否对外 |
|---|---|---|
| `isUseStore(fn)` | 类型守卫：判定一个值是否为 `StoreDefinition` | 否（内部） |
| `patchObject(newState, oldState)` | 递归深合并，state 调和用 | 否（内部） |
| `acceptHMRUpdate(initialUseStore, hot)` | 唯一的 HMR 公共 API | **是** |

对外公开的只有一条：`packages/pinia/src/index.ts:77` 只 re-export 了 `acceptHMRUpdate``；另外两个是供 `store.ts` 内部调用的符号。我们先看这三个原语本身。

### 1.1 `isUseStore`：从模块导出里认出 store

一个文件里可能同时导出多个东西（多个 store、几个工具函数）。HMR 需要从中挑出「真正需要热替换的 store」。判据是「既是函数、又带字符串 `$id`」：

```ts
// packages/pinia/src/hmr.ts:20-22
export const isUseStore = (fn: any): fn is StoreDefinition => {
  return typeof fn === 'function' && typeof fn.$id === 'string'
}
```

`$id` 是 `defineStore` 返回值上的标记——`useStore.$id = id`（见 `store.ts:951`）。只有 `defineStore` 的产物才会同时满足「是函数」和「带 `$id`」，工具函数不会。

### 1.2 `patchObject`：用「旧 state」填「新结构」

这是最容易读反的一个函数，必须先讲清方向。它的 JSDoc 原文是 *"Mutates in place `newState` with `oldState`"*——**就地修改 `newState`，依据是 `oldState`**。换句话说，遍历的是旧值、写入的是新结构，目的是「把用户已产生的旧值搬进新代码定义的形状里」：

```ts
// packages/pinia/src/hmr.ts:33-62
export function patchObject(newState, oldState): Record<string, any> {
  // no need to go through symbols because they cannot be serialized anyway
  for (const key in oldState) {           // ← 遍历的是 oldState
    const subPatch = oldState[key]
    if (!(key in newState)) {             // 新结构里没有的旧键 → 视为已删除，丢弃
      continue
    }
    const targetValue = newState[key]
    if (
      isPlainObject(targetValue) &&
      isPlainObject(subPatch) &&
      !isRef(subPatch) &&
      !isReactive(subPatch)
    ) {
      newState[key] = patchObject(targetValue, subPatch)  // 双方都是纯对象 → 递归深合并
    } else {
      newState[key] = subPatch            // ref / reactive / 基本类型 → 整体替换
    }
  }
  return newState
}
```

三条规则记牢：

1. **遍历 `oldState`，写入 `newState`**——「旧 → 新」，不是「新覆盖旧」。这点反直觉，是全章最易踩的坑。
2. `for...in` 只走**可枚举字符串键**，注释明说 symbol 不走（symbol 无法序列化）。
3. 三选一策略：双方都是纯对象（且非 ref/reactive）→ 递归；否则整体替换。

其中「纯对象」的判定来自 `types.ts:16-29` 的 `isPlainObject`——真值 + `typeof === 'object'` + `toString === '[object Object]'` + 无 `toJSON` 方法。这意味着 `Map`/`Set`/`Date`/类实例都不会被判为纯对象，会走整体替换分支。

> 注意：`patchObject` 只做「一层结构的递归合并」这一件事。真正决定「该深合并还是整体搬运」的分发逻辑并不在 hmr.ts，而在调用方 `_hotUpdate`（见第四节）。

### 1.3 `acceptHMRUpdate`：唯一对外入口

它本身**不执行任何替换**，而是返回一个回调交给 Vite。入口处第一件事是判 `__DEV__`：

```ts
// packages/pinia/src/hmr.ts:78-87
export function acceptHMRUpdate<...>(initialUseStore, hot) {
  // strip as much as possible from iife.prod
  if (!__DEV__) {
    return () => {}
  }
  // ... 返回真正的回调
}
```

`__DEV__` 是**编译期注入的常量**（`tsdown.config.ts:12`：`const __DEV__ = '(process.env.NODE_ENV !== "production")'`）。生产构建里它被替换成 `'false'`，于是 `if (!__DEV__)` 恒成立，整个 HMR 回调被 tree-shake 掉。这也是 HMR 对线上包体积零负担的原因——相关代码在生产产物里物理消失。

---

## 二、对外契约：acceptHMRUpdate 返回的是「给 Vite 的回调」

用户侧的标准用法（hmr.ts JSDoc 示例）：

```js
const useUser = defineStore('user', { /* ... */ })
if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useUser, import.meta.hot))
}
```

`acceptHMRUpdate(useUser, import.meta.hot)` 立即返回一个 `(newModule) => {...}`。Vite 在模块热更新时调用它，并把**新模块对象**作为 `newModule` 传进来：

```ts
// packages/pinia/src/hmr.ts:88-121
return (newModule: any) => {
  const pinia = hot.data.pinia || initialUseStore._pinia   // ① 取 pinia 实例
  if (!pinia) {
    return                                                  // ② store 从未被 useStore() 过，跳过
  }
  hot.data.pinia = pinia                                    // ③ 跨次加载保留 pinia

  for (const exportName in newModule) {                     // ④ 遍历新模块所有导出
    const useStore = newModule[exportName]
    if (isUseStore(useStore) && pinia._s.has(useStore.$id)) { // ⑤ 是 store 且已实例化过
      const id = useStore.$id
      if (id !== initialUseStore.$id) {                      // ⑥ id 变了
        diagnostics.PINIA_R1005({ from: initialUseStore.$id, to: id })
        return hot.invalidate()                              //   → 放弃 HMR，整页 reload
      }
      const existingStore = pinia._s.get(id)!                 // ⑦ 取现存实例
      useStore(pinia, existingStore)                          // ⑧ 触发替换
    }
  }
}
```

逐段语义：

- **① 取 pinia**：优先用 `hot.data.pinia`（Vite 在多次热更新间持久化的 `hot.data`），回退到 `initialUseStore._pinia`。`_pinia` 是 dev-only 字段，在 store 首次创建时挂到 `useStore` 上（`store.ts:913`，类型定义 `types.ts:517` 标注 *"Dev only pinia for HMR"*）。
- **③ 写回 `hot.data.pinia`**：因为 Vite 的 `hot.data` 在 accept 回调之间被保留，写回去后下一次热更新还能取到同一个 pinia 实例。
- **④⑤ 遍历整个新模块**：注意是对 `newModule` 做 `for...in`，而非只看单个 store。**一个文件里定义多个 store 时，HMR 会逐一替换**——这点常被忽略。
- **⑥ id 一致性校验**：若新 store 的 `$id` 与最初注册的不同，报 `PINIA_R1005`（文案：*The store id changed from "..." to "...", forcing a reload.*，见 `diagnostics.ts:33-37`），并调用 `hot.invalidate()`。invalidate 会让 Vite 放弃 HMR、回退到**整页 reload**——因为 store 的 id 是 `pinia._s` 注册表的 key，改名无法就地完成。
- **⑧ `useStore(pinia, existingStore)`**：这是真正触发替换的一行，详见下一节。

---

## 三、核心机关：`useStore` 的第二个参数 `hot`

这是整套 HMR 设计最巧妙、也最易被忽略的一点。`defineStore` 闭包返回的 `useStore`，签名是：

```ts
// packages/pinia/src/store.ts:883
function useStore(pinia?: Pinia | null, hot?: StoreGeneric): StoreGeneric
```

第二个参数 `hot` 平时（组件里 `useStore()` 调用）永远不会被传。但 `acceptHMRUpdate` 故意把**现存的 store 实例**当作 `hot` 传了进去（`hmr.ts:118`）。于是 `useStore` 内部据此分流：

```ts
// packages/pinia/src/store.ts:902-930
if (!pinia._s.has(id)) {            // 注册表里还没有该 store → 创建并注册
  // createSetupStore(...) / createOptionsStore(...) —— 创建并写入 pinia._s
  if (__DEV__) useStore._pinia = pinia
}
const store = pinia._s.get(id)!      // 拿到现存实例

if (__DEV__ && hot) {                 // hot 传入 → 进入 HMR 分支
  const hotId = '__hot:' + id
  const newStore = isSetupStore
    ? createSetupStore(hotId, setup, options, pinia, true)      // 第 5 个参数 true = HMR 模式
    : createOptionsStore(hotId, assign({}, options), pinia, true)
  hot._hotUpdate(newStore)            // ← 把新 store 灌进现存实例
  delete pinia.state.value[hotId]     // 清理临时态，避免污染注册表
  pinia._s.delete(hotId)
}
```

务必看清第一个 `if` 的条件方向：`!pinia._s.has(id)` 为真，说的是「注册表里**还没有**这个 store」，块内（`store.ts:904-908`）执行的是 `createSetupStore`/`createOptionsStore` 的**创建**逻辑。而在 HMR 路径下，store 早已存在、`has(id)` 为真，**根本不会进入这个创建块**——这恰恰是「跳过创建、复用现有实例」的情形。两种情形千万别搞混。

这段揭示了 Pinia HMR 的设计哲学——**最小入侵**：

1. HMR 路径下 `pinia._s.has(id)` 为真，**不进入**上面的创建块，直接复用现有实例（`store.ts:917` 的 `pinia._s.get(id)`）。
2. `hot` 为真值时，以 `'__hot:' + id` 为**临时 id** 重新跑一遍 `createSetupStore`/`createOptionsStore`（第 5 个参数 `true` 即 HMR 模式标志，对应 `createSetupStore`/`createOptionsStore` 的 `hot?: boolean` 形参）。这一步用**新代码**造出一个全新的「影子 store」`newStore`，它带着新的 state/getters/actions 定义。
3. 调用 `hot._hotUpdate(newStore)`——这里的 `hot` 就是 `existingStore`，即把新 store 的定义**灌进旧实例**。
4. 灌完后删除临时 id 对应的 state 与 `_s` 注册项，避免影子 store 污染。

也就是说，Pinia **没有为 HMR 单独写一套替换引擎**，而是复用了 `useStore(pinia, hot)` 这个本属内部的参数，借 store.ts:919 的 HMR 分支完成替换。这是「最小入侵」的精髓。

---

## 四、逐类调和：`_hotUpdate` 内部

`_hotUpdate` 挂在 store 上（`store.ts:600`，且在插件应用**之前**挂上，以便插件可覆盖）。它对 state、getters、actions 分门别类地调和。新 store 的「热更清单」由一个 `markRaw` 化的 `_hmrPayload` 承载：

```ts
// packages/pinia/src/store.ts:424-429
const _hmrPayload = /*#__PURE__*/ markRaw({
  actions: {} as Record<string, any>,
  getters: {} as Record<string, Ref>,
  state: [] as string[],
  hotState,
})
```

其中 `hotState` 是一个独立的 `ref({})`（`store.ts:280`），专供 HMR 期间 `store.$state` 的读取兜底——`$state` 的 getter 在热更期间会重定向到它（`store.ts:584`：`get: () => (__DEV__ && hot ? hotState.value : pinia.state.value[$id])`）。

### (a) state 调和（store.ts:602-636）

遍历 `newStore._hmrPayload.state`，**按 store 类型二选一**（这是全章的关键差异）：

```ts
// packages/pinia/src/store.ts:602-628
newStore._hmrPayload.state.forEach((stateKey) => {
  if (stateKey in store.$state) {
    const newStateTarget = newStore.$state[stateKey]
    const oldStateSource = store.$state[stateKey]
    if (
      isOptionsStore &&
      typeof newStateTarget === 'object' &&
      isPlainObject(newStateTarget) &&
      isPlainObject(oldStateSource)
    ) {
      patchObject(newStateTarget, oldStateSource)   // option store → 深合并
    } else {
      newStore.$state[stateKey] = oldStateSource    // setup store → 整体搬运
    }
  }
  store[stateKey] = toRef(newStore.$state, stateKey) // 重新挂接，保持 store.x 与 $state.x 同步
})
// 之后：删除新 state 里已不存在的旧键（store.ts:631-636）
```

注意条件里 `typeof newStateTarget === 'object'` 与 `isPlainObject(newStateTarget)` 是**并列两项**：前者先排除 `null`/非对象，后者再用 `toString` 判定纯对象，二者缺一不可。

为什么不能统一用 `patchObject` 深合并？源码注释（store.ts:606-613，对应 issue #2611）解释得很清楚：

- **option store** 在定义时就声明了完整的 state 形状，缺一个 key 意味着开发者有意删除了它，`patchObject` 能把旧值精确调和进新形状。
- **setup store** 的 state 是命令式创建的（如 `ref({})`），运行时可能动态新增属性，深合并会丢失这些动态属性。所以必须**整体搬运**旧值。

这正是第一节里 `patchObject`「只管一层递归合并、不负责分发」的原因——分发逻辑在这里。

### (b) 屏蔽 devtools 误报（store.ts:638-645）

热更期间把 `pinia.state.value[$id]` 重指到 `toRef(newStore._hmrPayload, 'hotState')`，会让 Vue Devtools 把这次状态迁移误记成一次 mutation。为避免噪音，Pinia 临时关掉两个监听标志，**且两个标志的恢复时机并不相同**：

```ts
// packages/pinia/src/store.ts:638-645
isListening = false
isSyncListening = false
pinia.state.value[$id] = toRef(newStore._hmrPayload, 'hotState')
isSyncListening = true                       // 重指之后，同步立即恢复
nextTick().then(() => {
  isListening = true                         // 仅这一个延后到下一 tick
})
```

即：`isSyncListening` 在重指之后**同步**置回 `true`（`store.ts:642`，紧跟 `store.ts:641` 的重指），而 `isListening` 要延后到 `nextTick` 才恢复（`store.ts:643-644`）。于是同步监听能立刻重新生效，异步监听则跳过本次 tick 的瞬时波动。

### (c) actions 替换（store.ts:647-654）

遍历 `newStore._hmrPayload.actions`，用 `action(actionFn, actionName)` 重新包装（重新包上 `$onAction` 钩子）后赋给 `store[actionName]`。

### (d) getters 替换（store.ts:657-671）

```ts
// packages/pinia/src/store.ts:657-671
for (const getterName in newStore._hmrPayload.getters) {
  const getter = newStore._hmrPayload.getters[getterName]
  const getterValue = isOptionsStore
    ? computed(() => { setActivePinia(pinia); return getter.call(store, store) })  // option → computed 包裹
    : getter                                                                        // setup → 直接用
  store[getterName] = getterValue
}
```

option store 的 getter 是「函数」，需要用 `computed` 重新包裹并绑定 `setActivePinia`；setup store 的 getter 本身已经是 computed，直接拿来用。

### (e)(f) 清理与收尾（store.ts:673-692）

删除新代码里已不存在的旧 getters / actions，最后把 `store._hmrPayload`、`store._getters` 指向新 store 的，复位 `store._hotUpdating = false`。

---

## 五、完整调用链（一图流）

```
用户注册：import.meta.hot.accept(acceptHMRUpdate(useUser, import.meta.hot))
   │
   └─ Vite 触发 → (newModule) => {
        pinia = hot.data.pinia || initialUseStore._pinia            // hmr.ts:89
        for (exportName in newModule):
          if isUseStore(useStore) && pinia._s.has($id):             // hmr.ts:103
            if id !== initialUseStore.$id → PINIA_R1005 + hot.invalidate()  // hmr.ts:107
            existingStore = pinia._s.get(id)                        // hmr.ts:113
            useStore(pinia, existingStore)                          // hmr.ts:118 ★
                │
                └─ useStore 内 __DEV__ && hot 分支                   // store.ts:919
                     newStore = createSetupStore('__hot:'+id, …, true)  // store.ts:921
                     existingStore._hotUpdate(newStore)             // store.ts:925 ★★
                        ├─ state: patchObject 深合并(option) / 整体搬运(setup) // 602-628
                        ├─ 屏蔽 devtools mutation 监听             // 638-645
                        ├─ actions: action(…) 重新包装             // 647-654
                        ├─ getters: computed 包裹 / 直用           // 657-671
                        ├─ 删除已移除的 state/getters/actions       // 631-687
                        └─ store._hmrPayload/_getters 指向 newStore // 690-692
                     清理 '__hot:'+id 的 state 与 _s 注册项         // store.ts:928-929
      }
```

---

## 六、为什么叫「无损」

回看全链路，HMR 的「无损」体现在三处设计收敛：

1. **实例不变**：始终是 `existingStore = pinia._s.get(id)` 这个同一个实例，组件里持有的引用不会失效。替换只是把内部 state/getters/actions 换掉。
2. **状态保留**：state 调和时遍历旧值、写进新结构（option store 深合并 / setup store 整体搬运），用户操作产生的运行时状态被搬进新代码定义的形状里。
3. **形状同步**：新结构里删掉的 key 被清理，新增的 key 被挂接，`store.x` 与 `store.$state.x` 通过 `toRef` 保持同步。

而当 store 的 `$id` 变了（结构无法就地迁移），Pinia 也不硬撑，直接 `hot.invalidate()` 让 Vite 整页刷新——这是「宁可刷新也不丢状态一致性」的兜底。

最后再强调一次生产期剥离：`__DEV__` 为假时 `acceptHMRUpdate` 返回 `() => {}`（hmr.ts:85-87），`_hotUpdate`、`_hmrPayload`、`_pinia`、`hotState` 等基础设施全部在 `__DEV__`/`hot` 守卫之后。这些代码在构建期被判定为死代码并 tree-shake，**线上产物里 HMR 既无体积成本，也无运行时成本**——这是一条「只在开发期存在」的能力。

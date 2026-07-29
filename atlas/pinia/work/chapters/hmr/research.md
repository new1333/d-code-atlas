# 模块热更新支持 · 源码精读

> 本章 sourceFiles：`packages/pinia/src/hmr.ts`（122 行，唯一精读对象）。
> 以下涉及 `store.ts`/`diagnostics.ts`/`types.ts`/`tsdown.config.ts`/`index.ts` 的内容，均为 hmr.ts 调用链或语义所需的**关联源**（Grep/Read 追源），非本章 sourceFiles，但 HMR 机制离开它们无法讲清，故纳入。

## 1. 文件总览：hmr.ts 的三个导出

`hmr.ts` 是一个**仅开发期生效**的小模块，导出三样东西：

| 导出 | 作用 | 是否对外公开（index.ts） |
|---|---|---|
| `isUseStore(fn)` | 类型守卫：判定一个值是否为 `StoreDefinition` | 否（内部） |
| `patchObject(newState, oldState)` | 递归深合并，HMR 状态调和用 | 否（内部，仅 store.ts 导入） |
| `acceptHMRUpdate(initialUseStore, hot)` | 唯一对外的 HMR 公共 API，返回 Vite 的 accept 回调 | **是** |

公开导出仅一条：
源码位置: packages/pinia/src/index.ts:77 — `export { acceptHMRUpdate } from './hmr'`
而 `patchObject` 被内部引用：
源码位置: packages/pinia/src/store.ts:51 — `import { patchObject } from './hmr'`

## 2. 概念要点

### 2.1 `__DEV__` 守卫：生产期整体剥离
`acceptHMRUpdate` 第一件事就是判 `__DEV__`，生产构建直接返回空函数，把 HMR 从 iife.prod 里抹掉：

```ts
// packages/pinia/src/hmr.ts:84-87
export function acceptHMRUpdate<...>(initialUseStore, hot) {
  // strip as much as possible from iife.prod
  if (!__DEV__) {
    return () => {}
  }
  ...
}
```

`__DEV__` 是**构建期注入的编译常量**，不是运行时变量：
源码位置: packages/pinia/tsdown.config.ts:12 — `const __DEV__ = \`(process.env.NODE_ENV !== 'production')\``
生产（iife.prod）构建里被替换为 `'false'`（源码位置: tsdown.config.ts:59,95），因此上述 `if (!__DEV__)` 分支恒成立、整个回调被 tree-shake。这也是为什么 HMR 相关代码对线上包体积无负担。

### 2.2 `isUseStore`：区分「defineStore 产物」与「模块其它导出」
源码位置: packages/pinia/src/hmr.ts:20-22

```ts
export const isUseStore = (fn: any): fn is StoreDefinition => {
  return typeof fn === 'function' && typeof fn.$id === 'string'
}
```

一个模块里可能有多个导出；只有「是函数 且 带 `$id` 字符串属性」的导出才是 `defineStore` 的返回值（`useStore.$id = id`，见 store.ts:951）。HMR 用它来**遍历新模块所有导出**，挑出需要热替换的 store。

### 2.3 `patchObject`：用「旧 state」就地打补丁到「新 state」
源码位置: packages/pinia/src/hmr.ts:33-62

```ts
export function patchObject(
  newState: Record<string, any>,
  oldState: Record<string, any>
): Record<string, any> {
  // no need to go through symbols because they cannot be serialized anyway
  for (const key in oldState) {
    const subPatch = oldState[key]
    if (!(key in newState)) {        // 新 shape 里已删除的 key → 整棵子树跳过
      continue
    }
    const targetValue = newState[key]
    if (
      isPlainObject(targetValue) &&
      isPlainObject(subPatch) &&
      !isRef(subPatch) &&
      !isReactive(subPatch)
    ) {
      newState[key] = patchObject(targetValue, subPatch)  // 递归深合并
    } else {
      // refs 或基本类型 → 整体替换
      newState[key] = subPatch
    }
  }
  return newState
}
```

要点（命名极易读反，Writer 须讲清）：
- **遍历的是 `oldState`（旧 state）**，写入的是 `newState`（新 state）——即「把旧值搬进新结构」。JSDoc 原文 "Mutates in place `newState` with `oldState`"（hmr.ts:25-26）。
- `for...in oldState` 只遍历**可枚举字符串键**；注释明说 symbol 不走（无法序列化），见 hmr.ts:37。
- `if (!(key in newState)) continue`：新结构里没有的旧键被**有意丢弃**（视为开发者删除了该字段）。
- 三选一合并策略：双方都是 plain object（且不是 ref/reactive）→ 递归；否则（ref / reactive / 基本类型 / 类实例）→ 整体覆盖。

`isPlainObject` 来自 types.ts，判定为：真值 + `typeof === 'object'` + `toString === '[object Object]'` + 无 `toJSON` 方法：
源码位置: packages/pinia/src/types.ts:16-29

> 注意：`patchObject` 本身**只处理 state 的一层嵌套调和**，真正的「按字段类型分发（option store 深合并 vs setup store 整体搬运）」逻辑在调用方 `store._hotUpdate` 里（见 §3.2）。

## 3. 关键调用链

### 3.1 顶层链路：acceptHMRUpdate 的对外契约
用户侧用法（hmr.ts JSDoc 示例，hmr.ts:68-73）：

```js
const useUser = defineStore(...)
if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useUser, import.meta.hot))
}
```

`acceptHMRUpdate` **不直接执行替换**，它返回一个 `(newModule) => {...}` 回调交给 Vite；Vite 在模块热更新时调用它，传入**新模块对象**。完整返回函数：
源码位置: packages/pinia/src/hmr.ts:88-121

```ts
return (newModule: any) => {
  const pinia: Pinia | undefined = hot.data.pinia || initialUseStore._pinia
  if (!pinia) {
    return                              // store 还没被使用过，跳过
  }
  hot.data.pinia = pinia                // 跨次加载保留 pinia 实例

  for (const exportName in newModule) {
    const useStore = newModule[exportName]
    if (isUseStore(useStore) && pinia._s.has(useStore.$id)) {
      const id = useStore.$id
      if (id !== initialUseStore.$id) {
        diagnostics.PINIA_R1005({ from: initialUseStore.$id, to: id })
        return hot.invalidate()         // id 变了 → 强制整页重载
      }
      const existingStore: StoreGeneric = pinia._s.get(id)!
      if (!existingStore) {
        console.log(`[Pinia]: skipping hmr because store doesn't exist yet`)
        return
      }
      useStore(pinia, existingStore)    // ← 核心触发点
    }
  }
}
```

逐段语义：
1. **取 pinia**（hmr.ts:89）：优先用 `hot.data.pinia`（Vite 在多次热更新间持久化的 `hot.data`），回退到 `initialUseStore._pinia`。
   - `_pinia` 是 dev-only 字段，在 store 首次创建后挂到 `useStore` 上：
     源码位置: packages/pinia/src/store.ts:913 — `useStore._pinia = pinia`
     类型：源码位置: packages/pinia/src/types.ts:517 — `_pinia?: Pinia`（注释 "Dev only pinia for HMR"）
2. **无 pinia 即早退**（hmr.ts:91-94）：store 从未被任何组件 `useStore()` 过，`_s` 里没有实例，无可替换，直接返回。
3. **写回 `hot.data.pinia`**（hmr.ts:97）：把 pinia 实例存进 `hot.data`，下一次热更新还能取到同一个实例（Vite 的 `hot.data` 在 accept 回调之间保留）。
4. **遍历新模块所有导出**（hmr.ts:100），用 `isUseStore` 过滤，并要求 `pinia._s.has(useStore.$id)`——即「该 store 已经实例化过」才热替换。
5. **id 一致性校验**（hmr.ts:107-111）：若新 store 的 `$id` 与最初注册的不同，报 `PINIA_R1005` 并 `hot.invalidate()`——Vite 的 invalidate 会放弃 HMR、触发整页 reload。
   - `PINIA_R1005` 文案：`The store id changed from "${from}" to "${to}", forcing a reload.`（源码位置: packages/pinia/src/diagnostics.ts:34-35，docs 指向 HMR cookbook）。
6. **取现存实例**（hmr.ts:113）：`pinia._s.get(id)`（`_s` 是 Pinia 根实例上的 store 注册表 Map）。
7. **`useStore(pinia, existingStore)`**（hmr.ts:118）：触发实际替换，进入 §3.2。

### 3.2 双参数机关：`useStore(pinia, hot)` 如何变身为热更新入口
这是整套 HMR 最巧妙也最易被忽略的一点。`useStore`（defineStore 闭包返回的函数）签名为：
源码位置: packages/pinia/src/store.ts:883 — `function useStore(pinia?: Pinia | null, hot?: StoreGeneric): StoreGeneric`

`acceptHMRUpdate` 把**现存的 store 实例**当作第二个参数 `hot` 传入。`useStore` 内部据此判断：

```ts
// packages/pinia/src/store.ts:902-915
if (!pinia._s.has(id)) {          // 已存在实例 → 跳过创建
  ...createSetupStore / createOptionsStore...
  if (__DEV__) {
    useStore._pinia = pinia
  }
}
const store: StoreGeneric = pinia._s.get(id)!

// packages/pinia/src/store.ts:919-930
if (__DEV__ && hot) {            // hot 传入 → 进入 HMR 分支
  const hotId = '__hot:' + id
  const newStore = isSetupStore
    ? createSetupStore(hotId, setup, options, pinia, true)
    : createOptionsStore(hotId, assign({}, options) as any, pinia, true)
  hot._hotUpdate(newStore)        // 把新 store 灌进现存 store
  // 清理临时态与缓存
  delete pinia.state.value[hotId]
  pinia._s.delete(hotId)
}
```

要点：
- 因为 `pinia._s.has(id)` 为真，**不会重复创建** store，直接拿到现有实例（store.ts:917）。
- `hot` 真值 → 以 `'__hot:' + id` 为临时 id **新建一个全新 store**（第 5 个参数 `true` 即 HMR 模式标志，见 createSetupStore/createOptionsStore 的 `hot?: boolean` 形参，store.ts:158、227）。
- 调用 `hot._hotUpdate(newStore)`——这里的 `hot` 就是 `existingStore`，即**把新 store 的 state/getter/action 灌进旧实例**（store.ts:925）。
- 灌完后删除临时 id 的 state 与 `_s` 注册项，避免污染（store.ts:928-929）。

### 3.3 `_hotUpdate` 内部：逐类调和 state/getters/actions
源码位置: packages/pinia/src/store.ts:600-693。`_hotUpdate` 在插件应用之前挂上（store.ts:597-600），允许插件覆盖。流程：

**(a) state 调和**（store.ts:602-636）——遍历 `newStore._hmrPayload.state`：
- 仅处理新 state 中存在、旧 `$state` 里也存在的键（store.ts:603）。
- **按 store 类型二选一**（关键，注释点出 issue #2611）：
  - option store 且新旧值都是 plain object → `patchObject(newStateTarget, oldStateSource)`（深合并，store.ts:618）；
  - 否则（setup store，或非 plain）→ 整体搬运 `newStore.$state[stateKey] = oldStateSource`（store.ts:621）。注释说明：setup store 的 state 是命令式创建的（如 `ref({})`），运行时可能新增属性，整体搬运避免丢失（store.ts:606-613）。
- 把 `store[stateKey]` 重新指向 `toRef(newStore.$state, stateKey)`，保证 `store.xxx` 与 `store.$state.xxx` 同步（store.ts:624-627）。
- 删除新 state 里已不存在的旧键（store.ts:631-636）。

**(b) 屏蔽 devtools 误报**（store.ts:638-645）——热更期间临时关掉 `isListening`/`isSyncListening`，避免把状态迁移记成一次 mutation；`pinia.state.value[$id]` 重指到 `toRef(newStore._hmrPayload, 'hotState')`，下一 tick 再恢复监听。

**(c) actions 替换**（store.ts:647-654）——遍历 `newStore._hmrPayload.actions`，用 `action(actionFn, actionName)` 重新包装后赋给 `store[actionName]`。

**(d) getters 替换**（store.ts:657-671）——遍历 `newStore._hmrPayload.getters`：
- option store → 用 `computed(() => { setActivePinia(pinia); return getter.call(store, store) })` 包一层（store.ts:659-664）；
- setup store → 直接用 `getter`（store.ts:665）。
- 赋给 `store[getterName]`（store.ts:668-670）。

**(e) 清理被删除的 getters / actions**（store.ts:673-687）。

**(f) 更新 devtools 用的元数据**（store.ts:690-692）——把 `_hmrPayload`、`_getters` 指向新 store 的，并复位 `store._hotUpdating = false`。

`_hmrPayload` 是 `markRaw` 化的「热更清单」，结构如下：
源码位置: packages/pinia/src/store.ts:424-429
```ts
const _hmrPayload = /*#__PURE__*/ markRaw({
  actions: {} as Record<string, any>,
  getters: {} as Record<string, Ref>,
  state: [] as string[],
  hotState,
})
```
其中 `hotState` 是一个独立的 `ref({})`（store.ts:280），专供 HMR 期间 `store.$state` 的读取兜底（store.ts:584：`get: () => (__DEV__ && hot ? hotState.value : pinia.state.value[$id])`）。

### 3.4 完整调用链（一图流）

```
import.meta.hot.accept(acceptHMRUpdate(useUser, import.meta.hot))      // 用户注册
   │
   └─ Vite 触发 → (newModule) => {
        pinia = hot.data.pinia || initialUseStore._pinia                // hmr.ts:89
        for (exportName in newModule):
          if isUseStore(useStore) && pinia._s.has($id):                 // hmr.ts:103
            if id !== initialUseStore.$id → PINIA_R1005 + hot.invalidate()  // hmr.ts:107-110
            existingStore = pinia._s.get(id)                            // hmr.ts:113
            useStore(pinia, existingStore)                              // hmr.ts:118
                │
                └─ useStore 内: __DEV__ && hot 分支                       // store.ts:919
                     newStore = createSetupStore('__hot:'+id, ..., true)  // store.ts:921-923
                     existingStore._hotUpdate(newStore)                 // store.ts:925
                        │
                        ├─ state: patchObject(深合并) 或 整体搬运(#2611)   // store.ts:618 / 621
                        ├─ 屏蔽 devtools mutation 监听                  // store.ts:638-645
                        ├─ actions: action(...) 重新包装               // store.ts:647-654
                        ├─ getters: computed 包裹(option) / 直用(setup) // store.ts:657-671
                        ├─ 删除已移除的 state/getters/actions           // store.ts:631-687
                        └─ store._hmrPayload/_getters 指向 newStore     // store.ts:690-692
                     清理 '__hot:'+id 的 state 与 _s 注册项             // store.ts:928-929
      }
```

## 4. 源码摘录（带行号）

**acceptHMRUpdate 主体**（packages/pinia/src/hmr.ts:78-122）已在 §3.1 完整引用。

**`_hotUpdate` 的 state 调和分支**（packages/pinia/src/store.ts:600-623）：
```ts
store._hotUpdate = markRaw((newStore) => {
  store._hotUpdating = true
  newStore._hmrPayload.state.forEach((stateKey) => {
    if (stateKey in store.$state) {
      const newStateTarget = newStore.$state[stateKey]
      const oldStateSource = store.$state[stateKey as keyof UnwrapRef<S>]
      if (
        isOptionsStore &&
        typeof newStateTarget === 'object' &&
        isPlainObject(newStateTarget) &&
        isPlainObject(oldStateSource)
      ) {
        patchObject(newStateTarget, oldStateSource)
      } else {
        newStore.$state[stateKey] = oldStateSource
      }
    }
    store[stateKey] = toRef(newStore.$state, stateKey)
  })
  ...
```

**`PINIA_R1005` 定义**（packages/pinia/src/diagnostics.ts:33-37）：
```ts
PINIA_R1005: {
  why: (p: { from: string; to: string }) =>
    `The store id changed from "${p.from}" to "${p.to}", forcing a reload.`,
  docs: 'https://pinia.vuejs.org/cookbook/hot-module-replacement.html#HMR-Hot-Module-Replacement-',
},
```

## 5. 易混淆 / 需 Writer 注意

1. **`patchObject` 的方向反直觉**：参数顺序是 `(newState, oldState)`，但遍历与读取的是 `oldState`，目的是「用旧值填充新结构」。Writer 讲解时务必强调「旧 → 新」，否则读者会误以为是「新覆盖旧」。源码位置: hmr.ts:33-62。

2. **「热替换」实际入口是 `useStore` 的第二个参数 `hot`**：`acceptHMRUpdate` 并没有独立的替换逻辑，而是复用了 `useStore(pinia, hot)` 这个本属内部的参数，把现存 store 实例当 `hot` 传入，借 store.ts:919 的 HMR 分支完成替换。这是 Pinia HMR 设计上「最小入侵」的精髓，值得专讲。源码位置: store.ts:883、919-930；hmr.ts:118。

3. **option store 与 setup store 的 state 调和策略不同**：option store 深合并（`patchObject`），setup store 整体搬运——根因是 setup store 的 state 命令式创建、运行时可增属性（issue #2611）。Writer 写章节时应把这一差异作为「为什么不能统一用 patchObject」的论据。源码位置: store.ts:606-622。

4. **id 变化走的是 `hot.invalidate()`（整页 reload），不是增量替换**：新模块导出的 store 若 `$id` 变了，Pinia 不尝试就地改名，而是放弃 HMR、交回 Vite 做完整刷新。源码位置: hmr.ts:107-111。

5. **生产构建 HMR 完全消失**：`__DEV__` 为假时 `acceptHMRUpdate` 返回 `() => {}`（hmr.ts:85-87），`_hotUpdate`、`_hmrPayload`、`_pinia` 等 HMR 基础设施多处 `__DEV__`/`hot` 守卫，线上无体积与运行时成本。`__DEV__` 是编译期常量（tsdown.config.ts:12）。

6. **对外 API 只暴露 `acceptHMRUpdate`**：`patchObject`、`isUseStore` 虽在 hmr.ts 中导出，但 index.ts 只 re-export `acceptHMRUpdate`（index.ts:77）；另两者为内部符号（store.ts 内部用）。Writer 若举例应只展示 `acceptHMRUpdate`。

7. **「遍历整个新模块所有导出」**：accept 回调对 `newModule` 做 `for...in` 而非只看单个 store，意味着一个文件里定义**多个 store** 时，HMR 能逐一替换（hmr.ts:100-103）。这一点常被读者忽略，可点出。
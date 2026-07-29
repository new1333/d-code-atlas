---
title: store 实例的变更与订阅 API
---

# store 实例的变更与订阅 API：把「一次变更」变成「一次订阅」

> 本章聚焦 `createSetupStore(...)` 闭包里装配的 7 个实例 API：`$patch`、`$reset`、`$dispose`、`$subscribe`、`$onAction`、`$state`，以及它们的内部支撑 `mergeReactiveObjects` 与 `action()` 包装器。
>
> **一句话核心**：所有变更最终都要变成「一次订阅通知」。Pinia 用**两条通道**实现这件事——直接 mutation 走 Vue 的 deep watch，`$patch` 走手动触发；二者用两个 `isListening` 标志协调，保证「一次 `$patch`（哪怕内含多次嵌套写入）= 一次通知」。

前置概念来自两章：
- **subscription-primitive**：`addSubscription` / `triggerSubscriptions` / `noop`（基于 `Set` 的回调集合），是 `$subscribe`/`$onAction`/`$patch` 通知的通用基石。
- **store-definition**：`createSetupStore` 装配管线。本章所有 API 都是该函数体内的**闭包变量**（store.ts:214-781），先收进 `partialStore` 字面量、再 `assign` 到 `reactive(partialStore)` 上得到 `store`（store.ts:431-490、575）。

```
装配位置（store.ts:431-490、575）
partialStore = { $onAction, $patch, $reset, $subscribe, $dispose, _p, $id }
            ↓ reactive(...)
          store = reactive(partialStore)
            ↓ assign(store, setupStore)        ← state/getter/action 落到 store 上
            ↓ Object.defineProperty(store, '$state', …)
最终：option store 与 setup store 共用同一套实现（createOptionsStore 也调 createSetupStore，store.ts:209）；
     唯一差异是 $reset（§6）。
```

---

## 一、地基 A：订阅原语（subscriptions.ts:4-33）

```ts
// subscriptions.ts:4
export const noop = () => {}
// subscriptions.ts:6-24
export function addSubscription<T extends _Method>(
  subscriptions: Set<T>, callback: T, detached?: boolean, onCleanup: () => void = noop
) {
  subscriptions.add(callback)
  const removeSubscription = () => {
    const isDel = subscriptions.delete(callback)
    isDel && onCleanup()                 // 移除时顺带清理副作用（如停 watcher）
  }
  if (!detached && getCurrentScope()) {
    onScopeDispose(removeSubscription)   // 非分离订阅随 effectScope 自动释放
  }
  return removeSubscription
}
// subscriptions.ts:26-33
export function triggerSubscriptions<T extends _Method>(
  subscriptions: Set<T>, ...args: Parameters<T>
) {
  subscriptions.forEach((callback) => { callback(...args) })
}
```

记住三个事实即可：(1) 回调存在 `Set` 里；(2) `removeSubscription` 返回手动取消句柄，移除时调用 `onCleanup`；(3) `triggerSubscriptions` 就是一次 `forEach` 同步派发。本章后面 `$subscribe`/`$onAction`/`$patch` 全是这三者的组合。

---

## 二、地基 B：mergeReactiveObjects（store.ts:79-113）

对象式 `$patch` 的「深合并」全靠它。三条分支语义不同，是高频混淆点：

```ts
function mergeReactiveObjects<T extends Record<any, unknown> | Map<unknown, unknown> | Set<unknown>>(
  target: T, patchToApply: _DeepPartial<T>
): T {
  // Map：按 key 覆盖写入
  if (target instanceof Map && patchToApply instanceof Map) {
    patchToApply.forEach((value, key) => target.set(key, value))   // store.ts:83-84
  } else if (target instanceof Set && patchToApply instanceof Set) {
    // Set：取并集（union），不是替换！
    patchToApply.forEach(target.add, target)                       // store.ts:85-87
  }
  // 普通对象：for…in 遍历，symbol 不处理（不可序列化）
  for (const key in patchToApply) {                                // store.ts:90-92
    if (!Object.hasOwn(patchToApply, key)) continue
    const subPatch = patchToApply[key]
    const targetValue = target[key]
    if (                                                           // store.ts:95-100：五条递归条件
      isPlainObject(targetValue) && isPlainObject(subPatch) &&
      Object.hasOwn(target, key) && !isRef(subPatch) && !isReactive(subPatch)
    ) {
      target[key] = mergeReactiveObjects(targetValue, subPatch)    // 递归深合并
    } else {
      target[key] = subPatch                                        // 否则整体替换
    }
  }
  return target
}
```

**深合并的五个前提**（同时满足才递归）：`targetValue` 与 `subPatch` 都是 plain object、`target` 自身拥有该 key、`subPatch` 既不是 `ref` 也不是 `reactive`。缺一个就是整体替换（数组因此被整体替换，而非按下标合并）。

输入输出示例：

```
state = { user: { name: 'pinia', age: 1 }, tags: Set('a') }
$patch({ user: { age: 2 }, tags: Set('b') })
  → user：plain+plain+hasOwn → 递归深合并 → { name:'pinia', age:2 }   // name 保留
  → tags：Set+Set → forEach(target.add) → Set('a','b')               // 取并集
```

---

## 三、核心：双通道通知模型

变更到达 `$subscribe` 回调有两条路。理解它们与两个监听标志的配合，就抓住了全章。

```
通道 A：直接 mutation（store.x=1 / store.list.push() / store.$state.x=1）
  Vue 对 pinia.state.value[$id] 的 deep watch 捕获（$subscribe 建的 watcher）
  → watch 回调受 (flush==='sync' ? isSyncListening : isListening) 门控
  → 用户 callback 收到 { type: MutationType.direct, … }, state        // store.ts:454-467

通道 B：$patch(...)
  暂停 isListening=isSyncListening=false（堵住通道 A 重复触发）
  → 函数式：直接 mutate state；对象式：mergeReactiveObjects 深合并
  → 手动 triggerSubscriptions(subscriptions, mutation, state) 通知一次
  → isSyncListening 立即恢复=true；isListening 经 nextTick+activeListener 守卫恢复
                                                                       // store.ts:292-327
```

`$patch` 完整实现（store.ts:285-328）：

```ts
function $patch(partialStateOrMutator: _DeepPartial<UnwrapRef<S>> | ((state) => void)): void {
  let subscriptionMutation
  isListening = isSyncListening = false                  // store.ts:293：暂停 watcher
  if (__DEV__) debuggerEvents = []
  if (typeof partialStateOrMutator === 'function') {     // 函数式重载
    partialStateOrMutator(pinia.state.value[$id])
    subscriptionMutation = { type: MutationType.patchFunction, storeId: $id, events: debuggerEvents }
  } else {                                               // 对象式重载
    mergeReactiveObjects(pinia.state.value[$id], partialStateOrMutator)
    subscriptionMutation = { type: MutationType.patchObject, payload: partialStateOrMutator, storeId: $id, events: debuggerEvents }
  }
  const myListenerId = (activeListener = Symbol())       // store.ts:315：唯一 id
  nextTick().then(() => { if (activeListener === myListenerId) isListening = true }) // 只让「最近一次」patch 恢复异步监听
  isSyncListening = true                                  // store.ts:321：同步监听立即恢复
  triggerSubscriptions(subscriptions, subscriptionMutation, pinia.state.value[$id]) // 手动通知
}
```

**为什么要「先暂停 watcher，再手动触发订阅」？** 对象式 patch 会触发一连串 reactive 写入，deep watch 本会对每一次写入各派发一次 `direct` 通知。Pinia 不想要这种「碎通知」——它暂停 watcher（`isListening/isSyncListening=false`），由自己 `triggerSubscriptions` 把整次 patch **归并为一条** `patchObject`/`patchFunction` 通知。两个标志的恢复节奏不同：

- `isSyncListening` 立即恢复：`flush:'sync'` 的订阅在 patch 后的「下一次同步写入」即可恢复直通；
- `isListening` 经 `nextTick` + `activeListener` 守卫恢复：连续多次同步 `$patch` 时，只有**最后一次**的 `nextTick` 会真正把它置回 `true`，从而吞掉中间态触发的 watch。

此外 `isListening`/`isSyncListening` 在 `createSetupStore` **最末尾**才同时置 `true`（store.ts:266-267、778-779）——故构建期（插件注入初值、SSR hydrate 回灌）的 state 变更**不会**误触发 `$subscribe`，订阅通道只在 store「就绪」后才打开。

---

## 四、$subscribe：通道 A 的建立（store.ts:438-474）

```ts
$subscribe(callback, options = {}) {
  if (subscriptions.has(callback)) {           // store.ts:441-446：同一 callback 去重
    if (__DEV__) diagnostics.PINIA_R1007({ id: $id })   // 重复订阅同一函数引用只建一次 watcher
    return noop
  }
  const removeSubscription = addSubscription(subscriptions, callback, options.detached, () => stopWatcher())
  const stopWatcher = scope.run(() =>           // store.ts:454：在 store 的 effectScope 内建 watcher
    watch(
      () => pinia.state.value[$id],             // source：根 state 上的本 store 子树
      (state) => {
        if (options.flush === 'sync' ? isSyncListening : isListening) {  // 门控
          callback({ storeId: $id, type: MutationType.direct, events: debuggerEvents }, state)
        }
      },
      assign({}, $subscribeOptions, options)    // $subscribeOptions = { deep: true }（store.ts:243）
    )
  )!
  return removeSubscription
}
```

要点：(1) **去重**——重复订阅同一函数引用，dev 下报 `PINIA_R1007`；(2) watcher 建在 store 的 `effectScope` 内，`$dispose` 停 scope 时连它一起停；(3) `flush:'sync'` 走 `isSyncListening`，其余（默认 `pre`/`post`）走 `isListening`；(4) 直接 mutation 经 watch 触发时，`type` 恒为 `MutationType.direct`——`patchObject`/`patchFunction` 只由 `$patch` 产生。

---

## 五、$onAction + action()：并列的 action 通知通道

`$subscribe` 监听的是 **state 变更**；`$onAction` 监听的是 **action 调用**，是一条独立通道。它的注册极简：

```ts
$onAction: addSubscription.bind(null, actionSubscriptions)   // store.ts:435
```

即把 `actionSubscriptions` 这个 `Set` 预绑给 `addSubscription`。能派发 `before/after/onError` 钩子，全靠 `action()` 包装器（store.ts:361-422）：setup 返回值里每个 `typeof prop === 'function'` 都被它重新包装（store.ts:540-545）。

```
store.someAction(args)
  → wrappedAction：setActivePinia(pinia)
  → 执行前 triggerSubscriptions(actionSubscriptions, { args, name, store, after, onError })
  → $onAction 订阅者【同步】调用 after(cb)/onError(cb) 注册本次专属钩子
  → fn.apply(this && this.$id===$id ? this : store, args)   // this 绑定：调用方即本 store 则用之，否则用闭包 store
  → 同步成功：triggerSubscriptions(afterCallbackSet, ret)
     同步抛错：triggerSubscriptions(onErrorCallbackSet, error) + rethrow
     返回 Promise：.then(after)/.catch(onError+reject)        // 异步 action 在 resolve/reject 时触发钩子
```

包装器核心（store.ts:368-413，节选）：

```ts
const wrappedAction = function (this: any) {
  setActivePinia(pinia)
  const args = Array.from(arguments)
  const afterCallbackSet = new Set(), onErrorCallbackSet = new Set()
  function after(cb) { afterCallbackSet.add(cb) }
  function onError(cb) { onErrorCallbackSet.add(cb) }
  triggerSubscriptions(actionSubscriptions, { args, name: wrappedAction[ACTION_NAME], store, after, onError }) // 执行前交出钩子
  let ret
  try {
    ret = fn.apply(this && this.$id === $id ? this : store, args)   // store.ts:392
  } catch (error) { triggerSubscriptions(onErrorCallbackSet, error); throw error }
  if (ret instanceof Promise) {
    return ret.then((v) => { triggerSubscriptions(afterCallbackSet, v); return v })
              .catch((e) => { triggerSubscriptions(onErrorCallbackSet, e); return Promise.reject(e) })
  }
  triggerSubscriptions(afterCallbackSet, ret)   // 同步返回值
  return ret
}
```

关键：`after`/`onError` 是**每次调用专属**的——两个 `Set` 在 `wrappedAction` 内部每次调用时新建，订阅者必须在收到 context 时**同步**注册，注册的钩子只对本次 action 调用生效。

---

## 六、复用 $patch 的两个语法糖：$reset 与 $state

二者底层都是「`$patch(s => assign(s, next))`」的**浅合并**，且都会产生一次 `patchFunction` 订阅通知。

**$reset**（store.ts:330-347）：仅 option store 有真实实现；setup store 在 dev 抛 🍍 错、在 prod 退化为 `noop`。

```ts
const $reset = isOptionsStore
  ? function $reset() {
      const { state } = options
      const newState = state ? state() : {}
      this.$patch(($state) => { assign($state, newState) })   // 浅合并：state() 里没有的旧 key 不会被删除
    }
  : __DEV__
    ? () => { throw new Error(`🍍: Store "${$id}" is built using the setup syntax and does not implement $reset().`) }
    : noop
```

**$state**（store.ts:583-595）：用 `Object.defineProperty` 而非 computed setter——注释明示是为了「不把一个 computed 的生命周期绑死到 store 首次创建处」，可在任意位置定义。

```ts
Object.defineProperty(store, '$state', {
  get: () => (__DEV__ && hot ? hotState.value : pinia.state.value[$id]),
  set: (state) => {
    if (__DEV__ && hot) throw new Error('cannot set hotState')
    $patch(($state) => { assign($state, state) })   // 整体赋值 $state 实为一次浅合并 patch
  },
})
```

> 常被误以为「完全重置 / 完全替换」——其实 `Object.assign` 只覆盖/新增顶层 key，**不删**新对象里没有的旧 key。

---

## 七、$dispose：反向拆解，但不删 state（store.ts:349-354）

```ts
function $dispose() {
  scope.stop()                  // 停 effectScope → 连带停 $subscribe 的 deep watcher 与 getter computed
  subscriptions.clear()
  actionSubscriptions.clear()
  pinia._s.delete($id)          // 从注册表移除；注意：不删 pinia.state.value[$id]
}
```

重要边界：`$dispose` **不删** `pinia.state.value[$id]`。而 `createSetupStore` 在初始化时是「读已有、不存在才建」（`const initialState = pinia.state.value[$id]`，store.ts:271-277）。两者合起来意味着：

```
store.$dispose() → pinia._s.delete($id)，但 state 子树仍在
  → 下次 useStore()：注册表里没了 → 走 createSetupStore 重建实例
  → 但 pinia.state.value[$id] 仍存在 → 复用旧 state（不回初值）
```

若要彻底丢弃，需手动 `delete pinia.state.value[store.$id]`。

---

## 八、可运行复刻（replica/）

`replica/` 目录可独立 `bun run`，最小化依赖（仅 `vue` 的 `reactive/watch/effectScope/nextTick`），自建订阅原语，复刻 `createSetupStore` 风格的 7 个 API。

`replica/package.json`：

```json
{
  "name": "store-instance-api-replica",
  "private": true,
  "type": "module",
  "scripts": { "dev": "bun run index.ts" },
  "dependencies": { "vue": "^3.4.0" }
}
```

`replica/index.ts`（与下方逐字一致）：

```ts
// 自底向上复刻 store 实例的「变更 / 订阅」API。运行：bun run index.ts
import { reactive, watch, effectScope, nextTick } from 'vue'

// ---------- 1. 订阅原语（对应 subscriptions.ts:4-33）----------
export const noop = () => {}
export function addSubscription(subscriptions, callback, detached, onCleanup = noop) {
  subscriptions.add(callback)
  const removeSubscription = () => { subscriptions.delete(callback) && onCleanup() }
  return removeSubscription
}
export function triggerSubscriptions(subscriptions, ...args) {
  subscriptions.forEach((cb) => cb(...args))
}

const isPlainObject = (v) =>
  v != null && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype

// ---------- 2. mergeReactiveObjects（对应 store.ts:79-113，省略 isRef/isReactive）----------
function mergeReactiveObjects(target, patchToApply) {
  if (target instanceof Map && patchToApply instanceof Map) {
    patchToApply.forEach((value, key) => target.set(key, value))     // Map：按 key 覆盖
  } else if (target instanceof Set && patchToApply instanceof Set) {
    patchToApply.forEach(target.add, target)                          // Set：取并集
  }
  for (const key in patchToApply) {
    if (!Object.hasOwn(patchToApply, key)) continue
    const subPatch = patchToApply[key]
    const targetValue = target[key]
    if (isPlainObject(targetValue) && isPlainObject(subPatch) && Object.hasOwn(target, key)) {
      target[key] = mergeReactiveObjects(targetValue, subPatch)      // 递归深合并
    } else {
      target[key] = subPatch                                          // 整体替换
    }
  }
  return target
}

const MutationType = { direct: 'direct', patchObject: 'patch object', patchFunction: 'patch function' }

// ---------- 3. createSetupStore（精简，仅装配本章 API）----------
function createSetupStore($id, stateFactory, actionsFactory, pinia) {
  const subscriptions = new Set()
  const actionSubscriptions = new Set()
  const scope = effectScope()
  let isListening, isSyncListening             // 末尾才置 true（store.ts:266-267 / 778-779）
  let activeListener
  let debuggerEvents = []

  if (!pinia.state.value[$id]) {               // 复用已有 state（store.ts:271-277，$dispose 不删 state 的关键）
    pinia.state.value[$id] = reactive(stateFactory())
  }
  const state = pinia.state.value[$id]

  function $patch(partialStateOrMutator) {     // store.ts:285-328
    let mutation
    isListening = isSyncListening = false      // 暂停 watcher，避免重复触发
    debuggerEvents = []
    if (typeof partialStateOrMutator === 'function') {
      partialStateOrMutator(state)
      mutation = { type: MutationType.patchFunction, storeId: $id, events: debuggerEvents }
    } else {
      mergeReactiveObjects(state, partialStateOrMutator)
      mutation = { type: MutationType.patchObject, payload: partialStateOrMutator, storeId: $id, events: debuggerEvents }
    }
    const myListenerId = (activeListener = Symbol())
    nextTick().then(() => { if (activeListener === myListenerId) isListening = true }) // 异步监听经 nextTick 恢复
    isSyncListening = true                      // 同步监听立即恢复
    triggerSubscriptions(subscriptions, mutation, state)                            // 一次 patch = 一次订阅
  }

  function action(fn, name = '') {             // store.ts:361-422
    const wrappedAction = function (...args) {
      const afterCb = new Set(), onErrorCb = new Set()
      const after = (cb) => afterCb.add(cb)
      const onError = (cb) => onErrorCb.add(cb)
      triggerSubscriptions(actionSubscriptions, { args, name, store, after, onError }) // 执行前交出钩子
      let ret
      try { ret = fn.apply(store, args) }      // this 绑定到 store
      catch (e) { triggerSubscriptions(onErrorCb, e); throw e }
      if (ret instanceof Promise) {
        return ret.then((v) => { triggerSubscriptions(afterCb, v); return v })
                  .catch((e) => { triggerSubscriptions(onErrorCb, e); return Promise.reject(e) })
      }
      triggerSubscriptions(afterCb, ret)
      return ret
    }
    return wrappedAction
  }

  function $subscribe(callback, options = {}) {  // store.ts:438-474
    if (subscriptions.has(callback)) return noop   // 同一 callback 去重（PINIA_R1007）
    const remove = addSubscription(subscriptions, callback, options.detached, () => stopWatcher())
    const stopWatcher = scope.run(() =>
      watch(() => state, (s) => {
        if (options.flush === 'sync' ? isSyncListening : isListening) {
          callback({ storeId: $id, type: MutationType.direct, events: debuggerEvents }, s)
        }
      }, { deep: true, ...options })
    )
    return remove
  }

  const $onAction = addSubscription.bind(null, actionSubscriptions)   // store.ts:435
  function $dispose() {                                              // store.ts:349-354
    scope.stop(); subscriptions.clear(); actionSubscriptions.clear(); pinia._s.delete($id)
  }
  const $reset = () => $patch((s) => Object.assign(s, stateFactory())) // option-store 版：浅合并

  const store = state                                // 简化：store 即 state 的 reactive 代理 + 方法
  const wrapped = {}
  for (const k in actionsFactory()) wrapped[k] = action(actionsFactory()[k], k)
  Object.assign(store, { $id, $patch, $reset, $dispose, $subscribe, $onAction, ...wrapped })
  Object.defineProperty(store, '$state', {          // store.ts:583-595
    get: () => pinia.state.value[$id],
    set: (next) => $patch((s) => Object.assign(s, next)),
  })

  isListening = true; isSyncListening = true         // store 就绪后才打开订阅通道
  return store
}

// ---------- 4. 可观察的输入输出示例 ----------
const pinia = { state: reactive({}), _s: new Map() }
const useCounter = () => {
  if (!pinia._s.has('counter')) {
    pinia._s.set('counter', createSetupStore(
      'counter',
      () => ({ count: 0, tags: new Set(['a']), user: { name: 'pinia', age: 1 } }),
      () => ({ inc(n = 1) { this.count += n; return this.count } }),
      pinia,
    ))
  }
  return pinia._s.get('counter')
}

const store = useCounter()
const log = []
store.$subscribe((mutation, state) => log.push(`${mutation.type}: count=${state.count}`))

store.count = 5                                     // 通道 A：直接 mutation → deep watch → direct
await nextTick()
store.$patch({ count: 10, user: { age: 2 } })       // 通道 B：对象式深合并 → patchObject（单次）
await nextTick()
store.$patch((s) => { s.count = 20 })               // 通道 B：函数式 → patchFunction
await nextTick()
console.log('订阅日志 =', log)
// 订阅日志 = [ 'direct: count=5', 'patch object: count=10', 'patch function: count=20' ]
console.log('深合并保留 user.name?', store.user.name, '| user.age =', store.user.age) // pinia | 2

store.$patch({ tags: new Set(['b']) })
console.log('tags 取并集 =', [...store.tags].sort())   // [ 'a', 'b' ]

store.$onAction(({ name, args, after }) => {
  console.log(`[onAction] before ${name}(${args})`)
  after((ret) => console.log(`[onAction] after ${name} => ${ret}`))
})
console.log('inc(3) 返回', store.inc(3))            // before inc(3) → after inc => 3 → 返回 3

store.$reset()                                      // 浅合并回初值
await nextTick()
console.log('reset 后 count =', store.count)        // 0

store.$dispose()                                    // 拆解：停 scope、清订阅、移除注册表
store.count = 999                                   // 不再有 $subscribe 通知
await nextTick()
const store2 = useCounter()
console.log('dispose 后旧 state 复用?', store2.count === 999) // true
```

运行步骤：

```
cd replica
bun install          # 仅装 vue
bun run index.ts     # 或：bun run dev
```

预期输出印证四件事：(1) 三条订阅日志分别对应 `direct` / `patch object` / `patch function`（对象式 patch 只产生一条通知，watcher 被暂停未重复触发）；(2) `user.name` 在深合并中保留；(3) `tags` 取并集；(4) `$dispose` 后无新通知，再次 `useStore()` 复用旧 state（`count === 999`）。

---

## 九、小结：一张总图 + 易混淆点

```
变更源                  内部机制                       订阅通道 / 通知类型
─────────────────────────────────────────────────────────────────────
直接 mutation  ──► deep watch($subscribe 建) ──► isListening 门控 ──► direct
$patch(对象)   ──► mergeReactiveObjects(深合并) ┐
$patch(函数)   ──► 直接 mutate state           ├─ 暂停watcher + 手动trigger ─► patchObject / patchFunction
$reset         ──► $patch(assign) 浅合并       ┤
store.$state=x ──► $patch(assign) 浅合并       ┘
action(args)   ──► action() 包装器            ──► actionSubscriptions ─► $onAction(before/after/onError)
拆解           ──► $dispose                   ──► scope.stop + clear×2 + _s.delete（不删 state）
```

易混淆点速查：

1. **Map vs Set 在对象式 `$patch` 里语义不同**：Map 按 key 覆盖（`target.set`），Set 取并集（`forEach(target.add)`）。别说笼统的「深合并」。
2. **`MutationType` 三态对应不同触发源**：`direct` 只由直接 mutation 经 watch 产生；`patchObject`（带 `payload`）由对象式 `$patch` 产生；`patchFunction` 由函数式 `$patch` 产生。
3. **`$reset` / `$state` 赋值都是浅合并**，不是整体替换：`assign(s, next)` 不删 `next` 里没有的旧 key。
4. **`$dispose` 不删 state**：停 scope、清订阅、移除注册表项，但 `pinia.state.value[$id]` 仍在，再 `useStore()` 复用旧 state。
5. **option store 与 setup store 的差异仅在 `$reset`**：其余 `$patch`/`$subscribe`/`$onAction`/`$state`/`$dispose` 实现完全相同（都在 `createSetupStore` 内）。
6. **`$onAction` 的 `after`/`onError` 是每次调用专属**：须在收到 context 时同步注册，只对本次 action 生效。
7. **`isListening`/`isSyncListening` 末尾才开启**：构建期（插件注入、hydrate）的变更不触发 `$subscribe`，订阅通道只在 store 就绪后打开。

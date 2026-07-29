# 发布-订阅原语 · 源码精读

> 本章 `sourceFiles[]` 仅一个文件：`packages/pinia/src/subscriptions.ts`（34 行）。精读以它为主，并追踪其调用方 `packages/pinia/src/store.ts`、类型 `packages/pinia/src/types.ts`、effectScope 宿主 `packages/pinia/src/createPinia.ts`，以还原「为什么这么写」。

## 概念要点

- **本文件只导出三个符号**：常量 `noop`、函数 `addSubscription`、函数 `triggerSubscriptions`。它是 Pinia 内部最小的通用原语，本身不含任何 Pinia 语义（不知道 store、state、action），只负责「往一个 `Set<回调>` 里增删」和「遍历触发」。
  源码位置: packages/pinia/src/subscriptions.ts:1-4

- **`noop`**：一个空函数 `() => {}`，被复用为「默认 onCleanup」和「无操作时的占位返回值」。`store.ts` 既从本文件 import 它（用于 `$subscribe` 去重时返回占位 remover），也是 `addSubscription` 的 `onCleanup` 默认值。
  源码位置: packages/pinia/src/subscriptions.ts:4；消费方 packages/pinia/src/store.ts:52

- **`addSubscription` 的四参签名**：
  `addSubscription<T extends _Method>(subscriptions: Set<T>, callback: T, detached?: boolean, onCleanup: () => void = noop)`。
  约束 `T extends _Method`，而 `_Method = (...args: any[]) => any`，即「任意可调用、任意参数、任意返回」。这就决定了本原语能服务于状态订阅、action 订阅等**不同签名**的回调集合——泛型 `T` 由调用方传入的 `Set<T>` 推断，保证 `trigger` 时展开的参数与 `add` 时注册的类型一致。
  源码位置: packages/pinia/src/subscriptions.ts:6-11；类型定义 packages/pinia/src/types.ts:414

- **`addSubscription` 的核心流程**：
  1. `subscriptions.add(callback)`——把回调加入集合；
  2. 构造闭包 `removeSubscription`：`() => { const isDel = subscriptions.delete(callback); isDel && onCleanup() }`——删除回调，且**仅当确实删掉**时才执行 `onCleanup`（幂等：重复调用 remover 第二次 `delete` 返回 false，`onCleanup` 不再触发）；
  3. 若 `!detached && getCurrentScope()` 则 `onScopeDispose(removeSubscription)`——**把删除逻辑挂到当前活跃 effectScope 的清理队列**；
  4. `return removeSubscription`——把「手动退订函数」交还给调用方。
  源码位置: packages/pinia/src/subscriptions.ts:12-23

- **`detached`（游离）语义**：当 `detached` 为真，或注册时没有活跃 scope（`getCurrentScope()` 为假）时，**跳过** `onScopeDispose`。这是「订阅不随组件卸载自动清理」的开关——对应 `$subscribe(callback, { detached: true })` 和 `$onAction(cb, true)`。
  源码位置: packages/pinia/src/subscriptions.ts:19-21

- **`triggerSubscriptions` 的签名与实现**：
  `triggerSubscriptions<T extends _Method>(subscriptions: Set<T>, ...args: Parameters<T>)`——用 `Parameters<T>` 从回调类型反推出可变参数元组，再 `subscriptions.forEach((callback) => callback(...args))` 逐一同步调用。**直接遍历活 Set，不做快照拷贝**。
  源码位置: packages/pinia/src/subscriptions.ts:26-33

## 关键调用链

整条「注册 →（某事件发生）→ 触发 → 自动/手动退订」链路在 `store.ts` 的 `createSetupStore` 内被装配出来：

```
注册侧：
  $onAction  = addSubscription.bind(null, actionSubscriptions)      // store.ts:435
  $subscribe(callback, options) {
    去重守卫（同回调已存在则 return noop）                            // store.ts:441-446
    addSubscription(subscriptions, callback, options.detached,
                    () => stopWatcher())                            // store.ts:448-453
      └─ onCleanup = 停掉 watch                                    // store.ts:452
      └─ scope.run(() => watch(state, callback...))               // store.ts:454-471
  }

触发侧（三类事件，都落到 triggerSubscriptions）：
  ① $patch（sync 路径，watcher 被暂停需手动触发）
       triggerSubscriptions(subscriptions, subscriptionMutation, state) // store.ts:323-327
  ② action 调用（包装器 action(fn,name) 内）
       triggerSubscriptions(actionSubscriptions, { args, name, store, after, onError }) // store.ts:382-388
       成功 → triggerSubscriptions(afterCallbackSet, ret|value)    // store.ts:402,412
       失败 → triggerSubscriptions(onErrorCallbackSet, error)      // store.ts:395,406
  ③ 直接 state 变更 → 由 watch 触发（不走 triggerSubscriptions）    // store.ts:454-471

退订侧：
  返回的 removeSubscription（手动退订）
    └─ subscriptions.delete(callback) && onCleanup()
  自动退订：
    onScopeDispose(removeSubscription) → 组件/scope 卸载时触发       // subscriptions.ts:19-21
  整体销毁：
    $dispose() { scope.stop(); subscriptions.clear(); actionSubscriptions.clear(); pinia._s.delete($id) } // store.ts:350-353
```

- **两个回调集合的声明**在 `createSetupStore` 顶部，分别是「state 变更订阅」与「action 订阅」：
  `let subscriptions: Set<SubscriptionCallback<S>> = new Set()`
  `let actionSubscriptions: Set<StoreOnActionListener<Id, S, G, A>> = new Set()`
  源码位置: packages/pinia/src/store.ts:268-269

- **`$onAction` 用偏函数绑定**：`addSubscription.bind(null, actionSubscriptions)`，把第一个参数（目标 Set）固定为 `actionSubscriptions`，于是实例上的 `$onAction(callback, detached?, onCleanup?)` 签名自然成型。
  源码位置: packages/pinia/src/store.ts:435

- **`$subscribe` 的去重守卫**：`if (subscriptions.has(callback))` 为真时（开发期还会 `diagnostics.PINIA_R1007({ id: $id })`）直接 `return noop`——**对同一个回调函数引用只建一个 watcher**，规避 issue #3143 的「同回调被多次注册导致多个 watcher」。注意返回的是占位 `noop`，而非真正的 remover。
  源码位置: packages/pinia/src/store.ts:441-446

- **`$subscribe` 的 `onCleanup` 是「停 watcher」**：`addSubscription(..., () => stopWatcher())`，即退订时把 `watch` 副作用一并停掉；watcher 本身是在 store 的 `scope` 内 `scope.run(() => watch(...))` 建立的。
  源码位置: packages/pinia/src/store.ts:448-471

- **`$patch` 为什么手动触发 `triggerSubscriptions`**：`$patch` 执行期间会先把 `isListening = isSyncListening = false`（暂停 watcher 以免与 patch 合并逻辑打架），patch 完成后 `isSyncListening = true` 再**手动** `triggerSubscriptions(subscriptions, subscriptionMutation, state)`，用携带 `MutationType.patchFunction` / `MutationType.patchObject` 的 mutation 对象通知订阅者。注释原话："because we paused the watcher, we need to manually call the subscriptions"。
  源码位置: packages/pinia/src/store.ts:293-327；暂停/恢复 store.ts:293,318,321

- **action 包装器是 `triggerSubscriptions` 的两级复用**：
  - 第一级：store 级 `actionSubscriptions`，在每次 action 执行**前**触发一次，事件对象含 `{ args, name, store, after, onError }`；
  - 第二级：每个 listener 收到事件后可调 `after(cb)` / `onError(cb)` 把回调塞进**本次调用专属**的 `afterCallbackSet` / `onErrorCallbackSet`（这两个 Set 是 `wrappedAction` 内的局部变量，每次 action 调用新建），action 成功/失败时分别 `triggerSubscriptions(afterCallbackSet, ...)` / `triggerSubscriptions(onErrorCallbackSet, ...)`。
  - 异步 action（`ret instanceof Promise`）在 `.then` 里触发 after、`.catch` 里触发 onError；同步成功在 `try` 后直接触发 after、同步抛错在 `catch` 里触发 onError 后 `throw`。
  源码位置: packages/pinia/src/store.ts:361-422（after/onError 集合 372-379；触发点 382-388、395、401-412）

## 「自动随 effectScope 释放」的实现根因

本章 summary 的核心论断「自动随 effectScope 释放」由三处代码共同支撑：

- **Pinia 根 scope**：`createPinia` 内 `import { effectScope } from 'vue'` 并 `const scope = effectScope(true)`（`true` = detached 根 scope），它就是 Pinia 实例上 `_e` 字段所持的根作用域。
  源码位置: packages/pinia/src/createPinia.ts:2,11

- **store scope 嵌套在根 scope 之下**：`createSetupStore` 里 `pinia._e.run(() => (scope = effectScope()).run(() => setup({ action }))!)`——为每个 store 新建一个子 effectScope，并在 pinia 根 scope 内运行。`$subscribe` 的 watcher、各 `onScopeDispose` 都挂在这个 store scope 上；`$dispose()` 调 `scope.stop()` 即触发其上所有 dispose 回调。
  源码位置: packages/pinia/src/store.ts:501,350

- **原语侧的挂钩点**：`addSubscription` 在「非 detached 且当前有活跃 scope」时调 `onScopeDispose(removeSubscription)`。`getCurrentScope()` 取的是**注册订阅那一刻**调用方的活跃 scope（通常是组件 `setup` 的 scope），所以组件卸载时其 scope dispose 会顺带把该订阅从 store 的 `Set` 里删掉——这就是「自动随 effectScope 释放」。
  源码位置: packages/pinia/src/subscriptions.ts:19-21

> 注：`$dispose` 仍额外显式 `subscriptions.clear()` / `actionSubscriptions.clear()`（store.ts:351-352），属于「整店关张」的彻底清理；而 `onScopeDispose` 链路负责「单个订阅者随自身 scope 退场」。两者并行、互不冲突。

## MutationType（订阅回调会收到的「变更类型」）

`triggerSubscriptions` 在 `$patch` 路径下传入的 mutation 对象的 `type` 字段取自这个枚举，与 `subscriptions.ts` 无直接耦合，但是讲解 `$subscribe` 收到的事件时绕不开：
- `direct = 'direct'`：直接改 state（`store.x = ...`、`store.$state.x = ...`、`store.list.push(...)`）；
- `patchObject = 'patch object'`：`$patch({ ... })`；
- `patchFunction = 'patch function'`：`$patch(state => ...)`。
源码位置: packages/pinia/src/types.ts:43-68

## 源码摘录（带行号）

`packages/pinia/src/subscriptions.ts` 全文（仅 34 行，无删节）：

```ts
1  import { getCurrentScope, onScopeDispose } from 'vue'
2  import { _Method } from './types'
3
4  export const noop = () => {}
5
6  export function addSubscription<T extends _Method>(
7    subscriptions: Set<T>,
8    callback: T,
9    detached?: boolean,
10   onCleanup: () => void = noop
11 ) {
12   subscriptions.add(callback)
13
14   const removeSubscription = () => {
15     const isDel = subscriptions.delete(callback)
16     isDel && onCleanup()
17   }
18
19   if (!detached && getCurrentScope()) {
20     onScopeDispose(removeSubscription)
21   }
22
23   return removeSubscription
24 }
25
26 export function triggerSubscriptions<T extends _Method>(
27   subscriptions: Set<T>,
28   ...args: Parameters<T>
29 ) {
30   subscriptions.forEach((callback) => {
31     callback(...args)
32   })
33 }
```

`packages/pinia/src/store.ts` 中 `$onAction` / `$subscribe` / `$patch` 触发 / action 包装器的关键片段：

```ts
// store.ts:435  —— $onAction 用偏函数绑定 actionSubscriptions
$onAction: addSubscription.bind(null, actionSubscriptions),

// store.ts:438-474  —— $subscribe
$subscribe(callback, options = {}) {
  // avoid setting up multiple watchers for the same callback
  if (subscriptions.has(callback)) {
    if (__DEV__) { diagnostics.PINIA_R1007({ id: $id }) }
    return noop
  }
  const removeSubscription = addSubscription(
    subscriptions,
    callback,
    options.detached,
    () => stopWatcher()            // onCleanup = 停 watch
  )
  const stopWatcher = scope.run(() =>
    watch(() => pinia.state.value[$id], (state) => {
      if (options.flush === 'sync' ? isSyncListening : isListening) {
        callback({ storeId: $id, type: MutationType.direct, events: debuggerEvents }, state)
      }
    }, assign({}, $subscribeOptions, options))
  )!
  return removeSubscription
},

// store.ts:322-327  —— $patch 因暂停 watcher 而手动触发
// because we paused the watcher, we need to manually call the subscriptions
triggerSubscriptions(
  subscriptions,
  subscriptionMutation,
  pinia.state.value[$id] as UnwrapRef<S>
)

// store.ts:368-413  —— action 包装器内的两级触发
const wrappedAction = function (this: any) {
  setActivePinia(pinia)
  const args = Array.from(arguments)
  const afterCallbackSet = new Set()
  const onErrorCallbackSet = new Set()
  function after(callback) { afterCallbackSet.add(callback) }
  function onError(callback) { onErrorCallbackSet.add(callback) }
  // @ts-expect-error
  triggerSubscriptions(actionSubscriptions, { args, name: wrappedAction[ACTION_NAME], store, after, onError })
  let ret
  try {
    ret = fn.apply(this && this.$id === $id ? this : store, args)
  } catch (error) {
    triggerSubscriptions(onErrorCallbackSet, error); throw error
  }
  if (ret instanceof Promise) {
    return ret.then((value) => { triggerSubscriptions(afterCallbackSet, value); return value })
              .catch((error) => { triggerSubscriptions(onErrorCallbackSet, error); return Promise.reject(error) })
  }
  triggerSubscriptions(afterCallbackSet, ret)
  return ret
}
```

## 易混淆 / 需 Writer 注意

- **remover 是幂等的，但 `onCleanup` 只在「真删掉」时跑一次**：`const isDel = subscriptions.delete(callback); isDel && onCleanup()`。所以对同一个 `removeSubscription` 调多次是安全的；但 `$subscribe` 去重命中时返回的是 `noop`（不是真 remover），调它没有任何效果——这点写章节时要讲清，避免读者以为「去重时返回的函数也能退订」。
  源码位置: packages/pinia/src/subscriptions.ts:14-17；store.ts:441-446

- **`triggerSubscriptions` 遍历活 Set，不做快照**：`forEach` 期间若某回调自己 `removeSubscription`（或新 `addSubscription`），按 ES 规范的 Set 迭代语义处理（已删且未访问的不会被访问；新增元素可能被访问也可能不）。Pinia 这里**没有防御性拷贝**。一般业务回调不会在回调内改订阅，但这是潜在的边界行为，Writer 若讲「回调内向集合增删」需如实说明未做隔离。
  源码位置: packages/pinia/src/subscriptions.ts:30-32

- **自动清理依赖「注册时的活跃 scope」，而非回调执行时**：`getCurrentScope()` 在 `addSubscription` 调用瞬间求值。若用户在组件 `setup()` 内注册，拿到的是组件 scope，组件卸载即自动退订；若在无 scope 的环境（如顶层模块、异步回调里、`setTimeout` 里）注册，`getCurrentScope()` 为空，**不会**自动清理，必须手动持有并调用返回的 remover。`detached: true` 也同样关闭自动清理（即便有活跃 scope）。
  源码位置: packages/pinia/src/subscriptions.ts:19-21

- **两类「after/onError 集合」不要混淆**：store 级的 `actionSubscriptions`（store.ts:269，长期存在，每个 action 调用触发一次）与 action 包装器内 `afterCallbackSet`/`onErrorCallbackSet`（store.ts:372-373，**每次 action 调用临时新建**，随该次调用的 after/onError 触发后即丢弃）。两者都靠 `triggerSubscriptions` 驱动，但生命周期完全不同。
  源码位置: packages/pinia/src/store.ts:269 vs 372-373

- **`$patch` 的「手动触发」是补缺，不是额外通知**：`$patch` 期间故意关掉 watcher，因此正常 watch 路径不会触发 `$subscribe` 回调；这里 `triggerSubscriptions` 是**替代**那条被暂停的 watch 路径，而非「额外多通知一次」。Writer 讲 `$subscribe` 时需把「直接改 state（走 watch）」与「`$patch`（走手动 trigger）」两条触发路径并列说清。
  源码位置: packages/pinia/src/store.ts:293,321-327,454-471

- **未理解 / 待确认**：`createPinia.ts` 第 11 行 `effectScope(true)` 的 `true`（detached）参数未在本章 sourceFiles 内展开，仅从 Vue 语义推断为「不受父 scope 影响、需手动 stop」的根 scope；具体到 `_e` 字段如何暴露给 `store.ts`（`pinia._e.run(...)`）的赋值细节，超出本章 sourceFiles 范围，Writer 可在「pinia-instance」章结合 `createPinia.ts` 详述。
  源码位置: packages/pinia/src/createPinia.ts:11；消费 packages/pinia/src/store.ts:501
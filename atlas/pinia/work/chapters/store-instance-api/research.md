# store 实例的变更与订阅 API · 源码精读

> 本章 sourceFiles 唯一文件：`packages/pinia/src/store.ts`（与 `store-definition` 章共用同一文件，本章聚焦**实例上的运行时变更/订阅 API**：`$patch`/`$reset`/`$dispose`/`$subscribe`/`$onAction`/`$state` 及其内部支撑——`mergeReactiveObjects`、`action()` 包装器、`isListening`/`isSyncListening` 协调机制）。这些 API 全部定义在 `createSetupStore(...)` 闭包内部，并被挂到 `partialStore` / `store` 上（无论 option store 还是 setup store 都复用同一套实现，`createOptionsStore` 最终也调用 `createSetupStore`，源码位置: packages/pinia/src/store.ts:209）。

---

## 一、概念要点

### 0. 这些 API 的"装配位置"事实

- 所有实例变更/订阅 API 都定义在 `createSetupStore` 函数体内，是**闭包内变量**（不是从别处 import 的方法）。源码位置: packages/pinia/src/store.ts:214-781
- 它们先被收进 `partialStore` 对象字面量（`$onAction`/`$patch`/`$reset`/`$subscribe`/`$dispose`），再连同 setup 返回值一起 `assign` 到 `reactive(partialStore)` 上得到最终 `store`。源码位置: packages/pinia/src/store.ts:431-476、478-490、575
- 因此 option store 与 setup store 共享**完全相同**的 `$patch`/`$subscribe`/`$onAction`/`$state` 实现；唯一有差异的是 `$reset`（见下）。源码位置: packages/pinia/src/store.ts:209、330-347

### 1. `mergeReactiveObjects` —— `$patch` 对象式合并的核心

- 签名：`mergeReactiveObjects<T>(target: T, patchToApply: _DeepPartial<T>): T`，递归**深合并**到 `target`（原地修改并返回 `target`）。源码位置: packages/pinia/src/store.ts:79-113
- **Map 分支**：`patchToApply.forEach((value, key) => target.set(key, value))`——逐 key **覆盖**写入。源码位置: packages/pinia/src/store.ts:83-84
- **Set 分支**：`patchToApply.forEach(target.add, target)`——把 patch 中每个元素 `add` 进 target，语义是**并集（union）而非替换**。这是一个易混淆点：Map 是按 key 覆盖，Set 是取并集。源码位置: packages/pinia/src/store.ts:85-87
- **普通对象分支**：`for...in` 遍历 `patchToApply`，跳过 symbol（注释说明 symbol 不可序列化，无需处理），并用 `Object.hasOwn` 过滤。源码位置: packages/pinia/src/store.ts:90-92
- **递归条件**（同时满足才深合并）：
  1. `targetValue` 是 `isPlainObject`
  2. `subPatch` 是 `isPlainObject`
  3. `target` 自身拥有该 key（`Object.hasOwn(target, key)`）
  4. `subPatch` 不是 `isRef`
  5. `subPatch` 不是 `isReactive`
  → 满足则 `target[key] = mergeReactiveObjects(targetValue, subPatch)`；否则直接 `target[key] = subPatch`（整体替换）。源码位置: packages/pinia/src/store.ts:95-109
- 注释解释了"为何不做类型不一致告警"：setup store 在 SSR 期间可能把某属性（如 Map）改成 `undefined`，hydrate 时需允许用 `undefined` 覆盖 Map。源码位置: packages/pinia/src/store.ts:102-104
- `_DeepPartial<T>` 类型定义：`{ [K in keyof T]?: _DeepPartial<T[K]> }`（逐层可选）。源码位置: packages/pinia/src/types.ts:36

### 2. `$patch` —— 两种重载，统一的"暂停 watcher + 手动触发订阅"机制

- 两个签名重载：函数式 `$patch(stateMutation: (state) => void)` 与对象式 `$patch(partialState: _DeepPartial<S>)`。源码位置: packages/pinia/src/store.ts:285-286
- 实现入口先**暂停两个监听标志**：`isListening = isSyncListening = false`，并在 dev 重置 `debuggerEvents = []`。源码位置: packages/pinia/src/store.ts:292-298
- **函数式分支**：直接执行 `partialStateOrMutator(pinia.state.value[$id])`（让用户直接 mutate state），构造 mutation `{ type: MutationType.patchFunction, storeId, events }`。源码位置: packages/pinia/src/store.ts:299-305
- **对象式分支**：调用 `mergeReactiveObjects(pinia.state.value[$id], partialStateOrMutator)`，构造 mutation `{ type: MutationType.patchObject, payload, storeId, events }`（多了 `payload`）。源码位置: packages/pinia/src/store.ts:306-314
- **`activeListener` + `nextTick` 协调**：每次 patch 生成唯一 `myListenerId = Symbol()` 并赋给 `activeListener`；`nextTick` 回调里只有当 `activeListener === myListenerId`（即本 patch 是"最近一次"）时才把 `isListening` 恢复为 `true`。作用：连续多次同步 `$patch` 时，只有最后一次 patch 的 nextTick 会真正恢复异步监听，避免中间态触发 watch。源码位置: packages/pinia/src/store.ts:315-320
- 紧接着**立即**恢复 `isSyncListening = true`（同步监听不受 nextTick 延迟影响）。源码位置: packages/pinia/src/store.ts:321
- **手动触发订阅**：因为 watcher 被暂停，必须手动 `triggerSubscriptions(subscriptions, subscriptionMutation, state)` 把这一次 patch 作为**单一 mutation** 通知所有 `$subscribe` 回调。源码位置: packages/pinia/src/store.ts:322-327

### 3. `$reset` —— 仅 option store 可用，内部走 `$patch`

- 通过 `isOptionsStore` 标志二选一定义。option store 提供真实实现；setup store 在 dev 抛错、在 prod 退化为 `noop`。源码位置: packages/pinia/src/store.ts:330-347
- option store 实现：重新调用 `options.state()` 拿到 `newState`（无 state 则 `{}`），然后 `this.$patch(($state) => { assign($state, newState) })`。源码位置: packages/pinia/src/store.ts:331-339
- 关键点：reset **不是整体替换** state，而是用 `Object.assign` 把 `newState` **浅合并**进现有 state。这意味着：`state()` 返回对象里**没有**的 key 在现有 state 中**不会被删除**；reset 只覆盖/新增顶层 key。源码位置: packages/pinia/src/store.ts:336-338
- 用 `$patch` 包裹的目的是让 reset 也产生**一次**订阅通知（归并为单一 mutation）。源码位置: packages/pinia/src/store.ts:334-335（注释 "we use a patch to group all changes into one single subscription"）
- setup store 的 dev 报错文案：`🍍: Store "${$id}" is built using the setup syntax and does not implement $reset().`。源码位置: packages/pinia/src/store.ts:342-346
- `noop` 定义：`export const noop = () => {}`。源码位置: packages/pinia/src/subscriptions.ts:4

### 4. `$dispose` —— 停 scope、清订阅、从注册表移除，但不删 state

- 实现：`scope.stop()` → `subscriptions.clear()` → `actionSubscriptions.clear()` → `pinia._s.delete($id)`。源码位置: packages/pinia/src/store.ts:349-354
- `scope.stop()` 会停止该 store 的 `effectScope`，从而清理其内所有响应式 effect（含 `$subscribe` 建的 deep watcher、getter computed）。源码位置: packages/pinia/src/store.ts:350（scope 创建于 packages/pinia/src/store.ts:501）
- **重要边界**：`$dispose` **不删除** `pinia.state.value[$id]`。类型层注释明确：若不手动 `delete pinia.state.value[store.$id]`，再次使用该 store 时会**复用旧 state**。源码位置: packages/pinia/src/types.ts:398-405、packages/pinia/src/store.ts:349-354

### 5. `action()` 包装器 —— `$onAction` 追踪的基础设施

- 两个内部 symbol：`ACTION_MARKER`（标记"已被包装"）与 `ACTION_NAME`（action 名）。`MarkedAction` 接口在 `_Method` 上扩展这两个属性。源码位置: packages/pinia/src/store.ts:63-77
- `action(fn, name)` 的幂等性：若 `ACTION_MARKER in fn`，说明已包装过，只更新其 `ACTION_NAME` 后原样返回，避免重复包装。源码位置: packages/pinia/src/store.ts:362-366
- 包装函数 `wrappedAction`（普通 function，故可被 `.apply` 绑 this）做的事（按顺序）：
  1. `setActivePinia(pinia)`：设置全局活跃 pinia（保证 action 内调用别的 store 能正确取到上下文）。源码位置: packages/pinia/src/store.ts:369
  2. 创建本次调用专属的 `afterCallbackSet` 与 `onErrorCallbackSet`（两个 Set），并定义 `after(cb)` / `onError(cb)` 注册函数。源码位置: packages/pinia/src/store.ts:372-379
  3. `triggerSubscriptions(actionSubscriptions, { args, name: wrappedAction[ACTION_NAME], store, after, onError })`：在**执行 action 之前**通知所有 `$onAction` 订阅者，把 `after`/`onError` 钩子交给他们注册。源码位置: packages/pinia/src/store.ts:381-388
  4. 执行 `fn.apply(this && this.$id === $id ? this : store, args)`：`this` 绑定——若调用方 `this` 是本 store（`$id` 相同）则用它，否则用闭包里的 `store`。源码位置: packages/pinia/src/store.ts:392
  5. 同步错误：`catch` → `triggerSubscriptions(onErrorCallbackSet, error)` → rethrow。源码位置: packages/pinia/src/store.ts:393-397
  6. 返回 Promise：`.then(value => { triggerSubscriptions(afterCallbackSet, value); return value })` 且 `.catch(error => { triggerSubscriptions(onErrorCallbackSet, error); return Promise.reject(error) })`——即异步 action 的 after/onError 在 Promise resolve/reject 时触发。源码位置: packages/pinia/src/store.ts:399-409
  7. 同步返回值：`triggerSubscriptions(afterCallbackSet, ret)`。源码位置: packages/pinia/src/store.ts:411-413
- 包装后给 `wrappedAction` 打上 `[ACTION_MARKER] = true`、`[ACTION_NAME] = name`。源码位置: packages/pinia/src/store.ts:416-417
- 这些包装发生在 setup 返回值分类循环里：凡是 `typeof prop === 'function'`，都用 `action(prop, key)` 重新包装后写回 `setupStore[key]`（dev 热更新路径除外，直接用原函数）。源码位置: packages/pinia/src/store.ts:540-545

### 6. `$onAction` —— 直接复用 `addSubscription`

- 定义：`$onAction: addSubscription.bind(null, actionSubscriptions)`。即把 `actionSubscriptions` 这个 Set 预绑为 `addSubscription` 的第一个参数。源码位置: packages/pinia/src/store.ts:435
- 因此 `$onAction(callback, detached?)` 的两个参数对应 `addSubscription` 的 `(callback, detached)`，未传 `onCleanup`（用默认 `noop`）。源码位置: packages/pinia/src/subscriptions.ts:6-11
- 回调收到的 context 结构（即 `_StoreOnActionListenerContext`）：`{ name, store, args, after, onError }`。其中 `after(cb)` 注册"action 成功结束"钩子（接收返回值，Promise 会被 await 解包），`onError(cb)` 注册"action 失败"钩子（注释说明返回 `false` 可吞掉错误阻止传播——但这是订阅者回调层面的约定）。源码位置: packages/pinia/src/types.ts:165-202
- `addSubscription` 的自动清理：若非 `detached` 且处于某个 effect scope，则 `onScopeDispose(removeSubscription)`，即订阅随所在组件 scope 自动释放。源码位置: packages/pinia/src/subscriptions.ts:19-21

### 7. `$subscribe` —— 基于 vue deep watch，受 listening 标志门控

- 入口先做**去重**：若 `subscriptions.has(callback)`，dev 触发诊断 `PINIA_R1007` 并返回 `noop`（不重复建 watcher）。对应 issue #3143。源码位置: packages/pinia/src/store.ts:438-446
- 调 `addSubscription(subscriptions, callback, options.detached, () => stopWatcher())`——注意第 4 参数 `onCleanup` 传的是 `stopWatcher`，订阅被移除时自动停掉对应 watcher。源码位置: packages/pinia/src/store.ts:448-453
- `stopWatcher = scope.run(() => watch(...))`：在 store 的 effectScope 内创建 watcher。watch 的 source 是 `() => pinia.state.value[$id]`。源码位置: packages/pinia/src/store.ts:454-456
- watch 回调的门控：`if (options.flush === 'sync' ? isSyncListening : isListening)` 才触发用户 callback——`flush:'sync'` 看 `isSyncListening`，其余（默认 `post`/`pre`）看 `isListening`。源码位置: packages/pinia/src/store.ts:457-467
- 回调里构造的 mutation 类型为 `MutationType.direct`（注意：**直接 mutation 走 watch 时都是 `direct`**，只有 `$patch` 才产生 `patchObject`/`patchFunction`），并附带 `events: debuggerEvents` 与新 `state`。源码位置: packages/pinia/src/store.ts:458-466
- watch options 为 `assign({}, $subscribeOptions, options)`：`$subscribeOptions` 默认 `{ deep: true }`，dev 下还带 `onTrigger`（把 vue 调试事件收进 `debuggerEvents`，供 devtools 时间线用）。源码位置: packages/pinia/src/store.ts:243-263、469
- 返回 `removeSubscription`（供手动取消）。源码位置: packages/pinia/src/store.ts:473

### 8. `$state` 的 getter/setter —— 用 `Object.defineProperty` 而非 computed setter

- 用 `Object.defineProperty(store, '$state', { get, set })` 定义。注释解释动机：这样可在任意位置创建，不必把一个 computed 的生命周期绑死到 store 首次创建处。源码位置: packages/pinia/src/store.ts:580-583、583-595
- **getter**：dev 且热更新（`hot`）时返回 `hotState.value`，否则返回 `pinia.state.value[$id]`。源码位置: packages/pinia/src/store.ts:584
- **setter**：dev 且 hot 时抛错 `cannot set hotState`；否则走 `$patch(($state) => { assign($state, state) })`——即**整体赋值 `$state` 实际是一次浅合并 patch**（同样用 `Object.assign`，不删除新对象里没有的 key）。源码位置: packages/pinia/src/store.ts:585-594

### 9. 监听标志的初始化与"启用时机"

- `isListening` / `isSyncListening` 声明时不赋值（`let isListening: boolean`），直到 `createSetupStore` **最末尾**（所有装配、插件应用、hydrate 之后）才同时置为 `true`。源码位置: packages/pinia/src/store.ts:266-267、778-779
- 这意味着 store 构建期间（含插件注入初值、hydrate 回灌）产生的 state 变更**不会**误触发 `$subscribe`——订阅通道在 store "就绪"后才打开。
- `debuggerEvents` 在 dev 下被 `$subscribeOptions.onTrigger` 持续收集（直接 mutation 场景），并在 `$patch` 开头被重置为 `[]`、patch 结束后随 mutation.events 一并传出。源码位置: packages/pinia/src/store.ts:245-262、296-298

---

## 二、关键调用链

### 变更 → 订阅的两条通道（核心，Writer 必讲）

```
通道 A：直接 mutation（store.x = 1 / store.list.push(...) / store.$state.x = 1）
  → Vue 对 pinia.state.value[$id] 的 deep watch 捕获（$subscribe 建的 watcher）
  → watch 回调受 isListening/isSyncListening 门控
  → 用户 callback 收到 { type: MutationType.direct, events, storeId }, state
  源码位置: packages/pinia/src/store.ts:454-471

通道 B：$patch(...)
  → 暂停 isListening=isSyncListening=false（阻止通道 A 重复触发）
  → 函数式：直接 mutate state；对象式：mergeReactiveObjects 深合并
  → 手动 triggerSubscriptions(subscriptions, mutation, state) 通知一次
  → isSyncListening 立即恢复=true；isListening 经 nextTick(activeListener 守卫)恢复
  源码位置: packages/pinia/src/store.ts:292-327
```

### action 调用 → $onAction 钩子链

```
store.someAction(args)
  → wrappedAction：setActivePinia(pinia)
  → triggerSubscriptions(actionSubscriptions, { args, name, store, after, onError })  // 执行前通知
  → $onAction 订阅者调用 after(cb)/onError(cb) 注册本次调用的钩子
  → fn.apply(...) 执行真实 action
  → 同步成功：triggerSubscriptions(afterCallbackSet, ret)
    同步抛错：triggerSubscriptions(onErrorCallbackSet, error) + rethrow
    返回 Promise：resolve→after 回调；reject→onError 回调 + reject
  源码位置: packages/pinia/src/store.ts:368-413
```

### reset / $state 赋值都复用 $patch

```
$reset()       → this.$patch(($state) => assign($state, state()))   源码位置: store.ts:335-338
store.$state=x → $patch(($state) => assign($state, x))              源码位置: store.ts:590-593
两者都是「浅合并式 patch」，都会产生一次 patchFunction 订阅通知。
```

### $dispose 清理链

```
$dispose() → scope.stop()（停 effectScope，连带停 $subscribe 的 watcher 与 getter computed）
           → subscriptions.clear() / actionSubscriptions.clear()
           → pinia._s.delete($id)（从注册表移除，下次 useStore 会重建 store 实例，但复用旧 state）
  源码位置: packages/pinia/src/store.ts:349-354
```

### 订阅原语依赖（来自 subscription-primitive 章）

```
$onAction  = addSubscription.bind(null, actionSubscriptions)        源码位置: store.ts:435
$subscribe = addSubscription(subscriptions, cb, detached, stopWatcher) + scope.run(watch)  store.ts:448-471
$patch     = triggerSubscriptions(subscriptions, mutation, state)   源码位置: store.ts:323-327
addSubscription   / triggerSubscriptions / noop  源码位置: packages/pinia/src/subscriptions.ts:4-33
```

---

## 三、源码摘录（带行号）

### `mergeReactiveObjects` 全文（store.ts:79-113）

```ts
function mergeReactiveObjects<
  T extends Record<any, unknown> | Map<unknown, unknown> | Set<unknown>,
>(target: T, patchToApply: _DeepPartial<T>): T {
  // Handle Map instances
  if (target instanceof Map && patchToApply instanceof Map) {
    patchToApply.forEach((value, key) => target.set(key, value))
  } else if (target instanceof Set && patchToApply instanceof Set) {
    // Handle Set instances
    patchToApply.forEach(target.add, target)
  }

  // no need to go through symbols because they cannot be serialized anyway
  for (const key in patchToApply) {
    if (!Object.hasOwn(patchToApply, key)) continue
    const subPatch = patchToApply[key]
    const targetValue = target[key]
    if (
      isPlainObject(targetValue) &&
      isPlainObject(subPatch) &&
      Object.hasOwn(target, key) &&
      !isRef(subPatch) &&
      !isReactive(subPatch)
    ) {
      target[key] = mergeReactiveObjects(targetValue, subPatch)
    } else {
      target[key] = subPatch
    }
  }

  return target
}
```

### `$patch` 实现（store.ts:285-328）

```ts
function $patch(stateMutation: (state: UnwrapRef<S>) => void): void
function $patch(partialState: _DeepPartial<UnwrapRef<S>>): void
function $patch(
  partialStateOrMutator:
    | _DeepPartial<UnwrapRef<S>>
    | ((state: UnwrapRef<S>) => void)
): void {
  let subscriptionMutation: SubscriptionCallbackMutation<S>
  isListening = isSyncListening = false
  if (__DEV__) {
    debuggerEvents = []
  }
  if (typeof partialStateOrMutator === 'function') {
    partialStateOrMutator(pinia.state.value[$id] as UnwrapRef<S>)
    subscriptionMutation = {
      type: MutationType.patchFunction,
      storeId: $id,
      events: debuggerEvents as DebuggerEvent[],
    }
  } else {
    mergeReactiveObjects(pinia.state.value[$id], partialStateOrMutator)
    subscriptionMutation = {
      type: MutationType.patchObject,
      payload: partialStateOrMutator,
      storeId: $id,
      events: debuggerEvents as DebuggerEvent[],
    }
  }
  const myListenerId = (activeListener = Symbol())
  nextTick().then(() => {
    if (activeListener === myListenerId) {
      isListening = true
    }
  })
  isSyncListening = true
  triggerSubscriptions(
    subscriptions,
    subscriptionMutation,
    pinia.state.value[$id] as UnwrapRef<S>
  )
}
```

### `$reset`（store.ts:330-347）

```ts
const $reset = isOptionsStore
  ? function $reset(this: _StoreWithState<Id, S, G, A>) {
      const { state } = options as DefineStoreOptions<Id, S, G, A>
      const newState: _DeepPartial<UnwrapRef<S>> = state ? state() : {}
      this.$patch(($state) => {
        assign($state, newState)
      })
    }
  : __DEV__
    ? () => {
        throw new Error(
          `🍍: Store "${$id}" is built using the setup syntax and does not implement $reset().`
        )
      }
    : noop
```

### `$dispose`（store.ts:349-354）

```ts
function $dispose() {
  scope.stop()
  subscriptions.clear()
  actionSubscriptions.clear()
  pinia._s.delete($id)
}
```

### `action()` 包装器（store.ts:361-422，节选核心）

```ts
const action = <Fn extends _Method>(fn: Fn, name: string = ''): Fn => {
  if (ACTION_MARKER in fn) {
    ;(fn as unknown as MarkedAction<Fn>)[ACTION_NAME] = name
    return fn
  }
  const wrappedAction = function (this: any) {
    setActivePinia(pinia)
    const args = Array.from(arguments)
    const afterCallbackSet: Set<(resolvedReturn: any) => any> = new Set()
    const onErrorCallbackSet: Set<(error: unknown) => unknown> = new Set()
    function after(callback: _SetType<typeof afterCallbackSet>) {
      afterCallbackSet.add(callback)
    }
    function onError(callback: _SetType<typeof onErrorCallbackSet>) {
      onErrorCallbackSet.add(callback)
    }
    triggerSubscriptions(actionSubscriptions, {
      args,
      name: wrappedAction[ACTION_NAME],
      store,
      after,
      onError,
    })
    let ret: unknown
    try {
      ret = fn.apply(this && this.$id === $id ? this : store, args)
    } catch (error) {
      triggerSubscriptions(onErrorCallbackSet, error)
      throw error
    }
    if (ret instanceof Promise) {
      return ret
        .then((value) => {
          triggerSubscriptions(afterCallbackSet, value)
          return value
        })
        .catch((error) => {
          triggerSubscriptions(onErrorCallbackSet, error)
          return Promise.reject(error)
        })
    }
    triggerSubscriptions(afterCallbackSet, ret)
    return ret
  } as MarkedAction<Fn>
  wrappedAction[ACTION_MARKER] = true
  wrappedAction[ACTION_NAME] = name
  return wrappedAction
}
```

### `$subscribe`（store.ts:438-474）

```ts
$subscribe(callback, options = {}) {
  if (subscriptions.has(callback)) {
    if (__DEV__) {
      diagnostics.PINIA_R1007({ id: $id })
    }
    return noop
  }
  const removeSubscription = addSubscription(
    subscriptions,
    callback,
    options.detached,
    () => stopWatcher()
  )
  const stopWatcher = scope.run(() =>
    watch(
      () => pinia.state.value[$id] as UnwrapRef<S>,
      (state) => {
        if (options.flush === 'sync' ? isSyncListening : isListening) {
          callback(
            {
              storeId: $id,
              type: MutationType.direct,
              events: debuggerEvents as DebuggerEvent,
            },
            state
          )
        }
      },
      assign({}, $subscribeOptions, options)
    )
  )!
  return removeSubscription
}
```

### `$state` getter/setter（store.ts:583-595）

```ts
Object.defineProperty(store, '$state', {
  get: () => (__DEV__ && hot ? hotState.value : pinia.state.value[$id]),
  set: (state) => {
    if (__DEV__ && hot) {
      throw new Error('cannot set hotState')
    }
    $patch(($state) => {
      assign($state, state)
    })
  },
})
```

### 订阅原语（packages/pinia/src/subscriptions.ts:4-33）

```ts
export const noop = () => {}
export function addSubscription<T extends _Method>(
  subscriptions: Set<T>, callback: T, detached?: boolean, onCleanup: () => void = noop
) {
  subscriptions.add(callback)
  const removeSubscription = () => {
    const isDel = subscriptions.delete(callback)
    isDel && onCleanup()
  }
  if (!detached && getCurrentScope()) {
    onScopeDispose(removeSubscription)
  }
  return removeSubscription
}
export function triggerSubscriptions<T extends _Method>(
  subscriptions: Set<T>, ...args: Parameters<T>
) {
  subscriptions.forEach((callback) => { callback(...args) })
}
```

---

## 四、易混淆 / 需 Writer 注意

1. **Map vs Set 在 `$patch` 对象式合并里语义不同**：Map 按 key 覆盖（`target.set(k,v)`），Set 是取并集（`forEach(target.add, target)`）。Writer 讲 `$patch` 深合并时务必区分，别笼统说"深合并"。源码位置: packages/pinia/src/store.ts:83-87

2. **`MutationType` 三态与触发源对应关系**：`direct`（值 `'direct'`）只由**直接 mutation 经 watch** 产生；`patchObject`（`'patch object'`，带 `payload`）由对象式 `$patch` 产生；`patchFunction`（`'patch function'`）由函数式 `$patch` 产生。源码位置: packages/pinia/src/types.ts:43-68、packages/pinia/src/store.ts:301-313、462

3. **`$reset`/`$state` 赋值都是「浅合并」而非「整体替换」**：底层都是 `$patch(s => assign(s, next))`。新对象里没有的旧 key **不会被删除**。这一点常被误以为是"完全重置/完全替换"。源码位置: packages/pinia/src/store.ts:335-338、590-593

4. **`$patch` 为何要暂停 watcher 再手动触发订阅**：避免 deep watch 因 patch 的 state 写入而重复触发订阅；目的是把一次 patch（哪怕内含多次嵌套写入）**归并为一次**订阅通知。`isSyncListening` 立即恢复、`isListening` 经 `nextTick`+`activeListener` 守卫恢复。Writer 讲订阅机制时这是关键设计点。源码位置: packages/pinia/src/store.ts:292-327

5. **`$subscribe` 对同一 callback 去重**：重复订阅同一函数引用只建一次 watcher，dev 下报 `PINIA_R1007`。源码位置: packages/pinia/src/store.ts:438-446

6. **`$subscribe` 的 flush 与两个 listening 标志的对应**：`flush:'sync'` 走 `isSyncListening`，其余走 `isListening`。配合 `$patch` 的暂停/恢复节奏，决定了"哪些变更能被同步订阅立刻看到"。源码位置: packages/pinia/src/store.ts:457-467、292-321

7. **`$dispose` 不删 state**：停 scope、清订阅、移除注册表项，但 `pinia.state.value[$id]` 仍在，再次 `useStore()` 会复用旧 state。源码位置: packages/pinia/src/store.ts:349-354、packages/pinia/src/types.ts:398-405

8. **`$onAction` 的 `after`/`onError` 是"每次调用专属"的**：它们在 `wrappedAction` 内部每次调用时新建 Set，订阅者必须在收到 context 时**同步**注册 after/onError，注册的钩子只对本次 action 调用生效。源码位置: packages/pinia/src/store.ts:372-388

9. **action 包装的 `this` 绑定**：`fn.apply(this && this.$id === $id ? this : store, args)`——若 action 被 store 以方法形式调用（`this` 是该 store）则保留该 `this`，否则回退到闭包 `store`。这关系到 action 内部 `this` 指向。源码位置: packages/pinia/src/store.ts:392

10. **option store 与 setup store 的差异点仅 `$reset`**：其余 `$patch`/`$subscribe`/`$onAction`/`$state`/`$dispose` 实现完全相同（都在 `createSetupStore` 内，option store 经 `createOptionsStore → createSetupStore(..., isOptionsStore=true)` 复用）。源码位置: packages/pinia/src/store.ts:209、330-347

11. **isListening/isSyncListening 的"末尾开启"语义**：二者在 `createSetupStore` 最末尾才置 true，故**构建期间**（插件注入初值、hydrate 回灌 state）的变更不会触发 `$subscribe`，订阅通道只在 store 就绪后打开。源码位置: packages/pinia/src/store.ts:778-779

12. **`$state` 用 `Object.defineProperty` 而非 computed setter** 的动机（注释明示）：避免把一个 computed 的生命周期绑死到 store 首次创建的位置，使其可在任意位置定义。源码位置: packages/pinia/src/store.ts:580-583
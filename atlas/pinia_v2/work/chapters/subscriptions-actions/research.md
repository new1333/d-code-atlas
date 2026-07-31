# $subscribe 与 $onAction：状态及动作订阅 · 源码精读

## 给 Writer 的教学钩子（必填，8 子项缺一不可）

- **用户痛点 / 场景**：状态被改了，但你想在「组件渲染之外」做反应——把最新状态写进本地存储、上报埋点、触发同步——你没有一个钩子；动作被调了，但你想在它「前后」插逻辑——测耗时、出错时上报、测试里断言参数、在时间线里把多次状态变更归因到这一次调用——你也没有一个拦截点。更麻烦的是：状态可能是「直接赋的」也可能是「合并补丁改的」，动作可能「同步返回」也可能「返回一个异步值」，用户若要自己区分这些，心智负担极重。

- **一句话核心思想**：把「状态变更」和「动作调用」都抽象成可订阅的事件流——状态靠一个深度监听器捕获、动作靠一个套在每次调用外面的前后钩子捕获，二者都复用同一套「回调集合 + 返回卸载函数」的订阅原语。

- **设计动机（为什么需要它）**：外部代码（插件、devtools、测试、应用逻辑）需要在不关心「状态是怎么被改的（直接赋值 vs 合并补丁）」「动作是怎么定义的（options vs setup）」「动作是同步还是异步」的前提下，对变更和调用做出反应。订阅层提供一个统一的事件表面：调用方只管订阅，变更/调用路径自己负责把「类型正确」的事件送进来。

- **关键权衡（2～4 条）**：
  1. **双路径复用、一次补丁一个事件**：把「直接赋值」交给深度监听器抓，把「合并补丁」期间的监听器暂停、改由手动派发 → 换来「无论怎么改状态，订阅者都收到类型正确的事件、且一次补丁恰好只产一个事件（而非逐属性多次）」→ 代价是要维护「异步监听 / 同步监听」两套暂停-恢复标志，恢复时机要精确卡在下一个 tick 之后，时序逻辑微妙、嵌套/连续补丁还要用令牌去重。
  2. **动作包装器是唯一挂载点**：在装配期把每个动作都套一层包装 → 换来「动作前后的钩子、devtools 时间线、测试 spy 都复用这同一个拦截点」→ 代价是哪怕没有任何订阅者，每次动作调用也会分配两个回调集合 + 一个上下文对象，且需要标记位防止对已包装的动作重复包装。
  3. **前后钩子按调用实例化**：每次动作调用都新建一组「完成 / 出错」回调集合，随上下文传给订阅者注册 → 换来「订阅者为『这一次调用』注册的钩子天然隔离、调用一结束就随集合丢弃，无需手动清理 per-call 临时状态」→ 代价是钩子集合的分配与「订阅者是否真注册了钩子」无关。
  4. **去重 + 作用域自动清理**：状态订阅按回调引用去重、所有订阅默认随所在作用域自动卸载、可选脱离 → 换来「同一回调不会被重复监听导致泄漏，组件内订阅随卸载自动回收」→ 代价是「按引用去重」在跨组件复用同一函数时语义反直觉（第二次订阅静默变成空操作），脱离作用域的订阅必须自行管理卸载。

- **最小心智模型（3～7 步）**：
  1. 装配期：遍历 setup 返回值，凡是函数都套一层「动作包装」并替换原属性。
  2. 订阅注册：状态订阅往一个集合里加回调（同回调则跳过）并起一个深度监听；动作订阅往另一个集合里加回调；二者都返回「卸载函数」，默认随作用域自动清理。
  3. 状态被直接改：深度监听触发 → 检查「监听开关」是否打开 → 打开则派发一个「直接变更」事件。
  4. 状态被补丁改：先把监听开关关掉 → 改状态 → 在下一个 tick 之后才把异步开关打开（同步开关立刻开）→ 手动派发一个「补丁变更」事件（带补丁类型与载荷）。
  5. 动作被调用：包装器先把活跃实例指针设好 → 新建本次调用的「完成/出错」集合 → 向所有动作订阅者派发「调用前」事件（订阅者可借此注册完成/出错钩子）→ 真正执行动作。
  6. 动作返回：若同步返回，立刻派发「完成」；若返回异步值，则在它 resolve 时派发「完成」、reject 时派发「出错」；同步抛错则立即派发「出错」并重抛。
  7. 卸载：停掉作用域、清空两个回调集合、从注册表移除。

- **最小原理演示（替代旧"复刻范围"）**：
  - 应演示：一个从零实现的「可订阅动作 + 可订阅状态」，几十行，每一行对应上面某个原理点——重点演「动作包装的前后钩子 + 异步兼容」与「补丁暂停监听、手动派发、tick 后恢复」这两条核心权衡。
  - 应故意省略：Vue 响应式真源、作用域自动清理的真实绑定、深度监听的精确调度队列、devtools/debugger 事件、HMR、options/setup 双形态归一、完整 TS 泛型——这些属其它章或工程化内容。

  ```ts
  // ▸ 动作包装器（演权衡 2「统一拦截点」+ 权衡 3「按调用实例化的前后钩子」）
  function makeAction(fn, name, listeners) {
    return function (...args) {
      const afterCbs = new Set(), errCbs = new Set()        // 本次调用专属
      const ctx = { name, args,
        after: (f) => afterCbs.add(f),
        onError: (f) => errCbs.add(f) }
      listeners.forEach((l) => l(ctx))                      // 派发「调用前」，订阅者在此注册钩子
      let ret
      try { ret = fn.apply(this, args) }
      catch (e) { fire(errCbs, e); throw e }                // 同步出错
      if (ret instanceof Promise)                           // 异步值：then/catch
        return ret.then((v) => (fire(afterCbs, v), v))
                 .catch((e) => (fire(errCbs, e), Promise.reject(e)))
      fire(afterCbs, ret)                                   // 同步完成
      return ret
    }
  }
  const fire = (set, ...a) => set.forEach((f) => f(...a))

  // ▸ 状态订阅 + 补丁暂停（演权衡 1「双路径/一次补丁一个事件」+ 权衡 4「去重」）
  function makeSubscribable() {
    const state = { count: 0 }, subs = new Set()
    let listening = true
    return {
      state,
      subscribe(cb) {
        if (subs.has(cb)) return () => {}                  // 同回调去重
        subs.add(cb); return () => subs.delete(cb)
      },
      set(v) { state.count = v; if (listening) fire(subs, { type: 'direct' }, state) },
      patch(v) {
        listening = false                                  // 暂停，避免补丁被当成 direct
        state.count = v
        Promise.resolve().then(() => (listening = true))   // tick 后才恢复异步监听
        fire(subs, { type: 'patch', payload: v }, state)   // 手动派发：一次补丁 = 一个事件
      },
    }
  }
  ```

- **正文不宜展开的细节**：dev 模式下监听器带 `onTrigger`，把 Vue 的 DebuggerEvent 收集进事件的 `events` 字段供 devtools 显示「具体改了哪个属性」，且补丁开始时重置该数组以按补丁分组（属 devtools 章）；动作包装器里 `this.$id === id ? this : store` 的上下文守卫、HMR 热更新时重新包装动作（属 HMR 章）；options store 与 setup store 的动作如何被遍历到这个包装循环（属 store-assembly 章）；变更类型三态与三种回调形态的类型设计（类型细节，点到为止）；sync 订阅与默认 pre 订阅在「补丁后恢复时机」上的差异（权衡 1 的细节，可一笔带过）。

- **推荐的一个执行轨迹例子**：输入——订阅动作 `({ name, after }) => after(v => log('done', name, v))`，然后调用 `increment(5)`（同步动作，返回 5）。关键中间态：① 包装器被调用 → 设好活跃实例指针；② 新建本次调用的完成/出错集合与上下文；③ 派发「调用前」→ 监听器运行，把 `v => log(...)` 塞进完成集合；④ 执行原 `increment(5)` → 得 5；⑤ 同步返回 → 派发完成集合(5) → 打印 `done increment 5`；⑥ 返回 5。若 `increment` 返回异步值：第④步得到的是 Promise → 走 `then(派发完成)/catch(派发出错并 reject)`，钩子在它真正 settle 时才触发。

> 以上钩子供 Writer 写「动机→核心思想→心智模型→关键权衡→原理演示」；下面事实部分供核对，不要被 Writer 当目录照抄。

## 概念要点
- 要点 1：`$subscribe` 本质是挂在 store 作用域上的一个 `watch(pinia.state.value[$id], { deep: true })`；用户回调由这个 watch 触发，而非由状态变更直接 `triggerSubscriptions`。 源码位置: packages/pinia/src/store.ts:454-471
- 要点 2：同回调去重——`subscriptions.has(callback)` 为真则直接返回 `noop`、不再建第二个 watch（修复重复监听导致的泄漏，issue #3143）。 源码位置: packages/pinia/src/store.ts:441-446
- 要点 3：watch 回调只产生 `MutationType.direct` 事件，并按 `options.flush === 'sync' ? isSyncListening : isListening` 做门控（补丁期间两者被置 false，watch 即便触发也跳过）。 源码位置: packages/pinia/src/store.ts:458-466
- 要点 4：`$patch` 用两套标志暂停 watch——`isListening`（异步/pre 监听）、`isSyncListening`（同步监听）——并手动 `triggerSubscriptions` 派发 `patchObject`/`patchFunction` 事件；异步监听到 `nextTick` 之后才恢复、同步监听立即恢复。 源码位置: packages/pinia/src/store.ts:293,315-321,323-327
- 要点 5：`activeListener` 令牌——嵌套/连续补丁时只有「最后一次」补丁的 nextTick 回调才把 `isListening` 恢复为 true，避免中途某次补丁提前恢复监听。 源码位置: packages/pinia/src/store.ts:315-320
- 要点 6：`$onAction = addSubscription.bind(null, actionSubscriptions)`——直接把监听器加进 `actionSubscriptions` 集合并返回卸载函数，无 watch 参与。 源码位置: packages/pinia/src/store.ts:435
- 要点 7：触发动作订阅发生在 `action()` 包装器内：每次调用先 `setActivePinia(pinia)`、新建本次调用的 `afterCallbackSet`/`onErrorCallbackSet` 与 `after`/`onError` 注册函数、再 `triggerSubscriptions(actionSubscriptions, { args, name, store, after, onError })`，然后才执行原函数。 源码位置: packages/pinia/src/store.ts:368-388
- 要点 8：动作返回 Promise 时走 `.then(派发 after)/.catch(派发 onError 并 reject)`；同步返回则立即派发 after；同步抛错立即派发 onError 并重抛。 源码位置: packages/pinia/src/store.ts:390-413
- 要点 9：装配期遍历 `setupStore`，凡 `typeof prop === 'function'` 都用 `action(prop, key)` 包一层替换；`ACTION_MARKER` 标记位保证已包装的不重复包装、仅更新 `ACTION_NAME`。 源码位置: packages/pinia/src/store.ts:540-545, 362-366
- 要点 10：订阅原语 `addSubscription`：`Set.add` + 返回 `remove`；非 detached 且在作用域内则 `onScopeDispose(remove)` 自动卸载。`triggerSubscriptions` 就是 `forEach` 调用。 源码位置: packages/pinia/src/subscriptions.ts:6-33
- 要点 11：`$dispose`：`scope.stop()` + 清空 `subscriptions`/`actionSubscriptions` + 从 `pinia._s` 删除。 源码位置: packages/pinia/src/store.ts:349-354
- 要点 12：`MutationType` 三态 `direct`/`patchObject`/`patchFunction` 用于在回调里区分变更来源；回调签名是 `(mutation, state)`，`mutation.events`（dev-only）承载 Vue 调试事件。 源码位置: packages/pinia/src/types.ts:43-68, 146-158

## 关键调用链
- 状态订阅 · 直接变更：`store.x = y` → Vue 深度 watch(store.ts:454) → 门控 `isListening`(store.ts:458) → `callback({ type: direct }, state)`(store.ts:459-466)
- 状态订阅 · 补丁：`store.$patch(obj)` → 关 `isListening`/`isSyncListening`(store.ts:293) → `mergeReactiveObjects`(store.ts:307) → 令牌 + nextTick 恢复(store.ts:315-320) → `triggerSubscriptions(subscriptions, { type: patchObject, payload }, state)`(store.ts:323-327)
- 动作订阅：`store.someAction(args)` → `wrappedAction`(store.ts:368) → `setActivePinia`(store.ts:369) → 建 after/onError 集合 + 派发 `actionSubscriptions`(store.ts:372-388) → `fn.apply`(store.ts:392) → 派发 after/onError(store.ts:395 | 402 | 406 | 412)

## 源码摘录（带行号，全文累计 ≤ 30 行）

```ts
// packages/pinia/src/store.ts:293-327  $patch 关监听、手动派发、tick 后恢复（演权衡 1）
isListening = isSyncListening = false
// ... mutate state; build subscriptionMutation with type patchObject/patchFunction ...
const myListenerId = (activeListener = Symbol())
nextTick().then(() => {
  if (activeListener === myListenerId) {
    isListening = true
  }
})
isSyncListening = true
triggerSubscriptions(
  subscriptions, subscriptionMutation, pinia.state.value[$id] as UnwrapRef<S>
)
```

```ts
// packages/pinia/src/store.ts:382-413  动作包装：调用前派发钩子、执行、完成/出错派发、兼容 Promise（演权衡 2、3）
triggerSubscriptions(actionSubscriptions, {
  args, name: wrappedAction[ACTION_NAME], store, after, onError,
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
    .then((value) => { triggerSubscriptions(afterCallbackSet, value); return value })
    .catch((error) => { triggerSubscriptions(onErrorCallbackSet, error); return Promise.reject(error) })
}
triggerSubscriptions(afterCallbackSet, ret)
return ret
```

```ts
// packages/pinia/src/store.ts:441-466  $subscribe 同回调去重 + 监听开关门控（演权衡 1、4）
if (subscriptions.has(callback)) {
  if (__DEV__) { diagnostics.PINIA_R1007({ id: $id }) }
  return noop
}
// ...addSubscription(...) + scope.run(watch(...))...
watch(() => pinia.state.value[$id] as UnwrapRef<S>, (state) => {
  if (options.flush === 'sync' ? isSyncListening : isListening) {
    callback({ storeId: $id, type: MutationType.direct, events: debuggerEvents as DebuggerEvent }, state)
  }
}, assign({}, $subscribeOptions, options))
```

## 易混淆 / 边界 / 推断
- 事实：`$subscribe` 的同一个回调既会被「直接赋值」触发（type=`direct`）、也会被「`$patch`」触发（type=`patchObject`/`patchFunction`），两条路径进同一个回调，仅 type 不同。
- 事实：sync 订阅与默认(pre)订阅在补丁后的恢复时机不同——sync 的 `isSyncListening` 在补丁内同步关、补丁末尾同步开；pre 的 `isListening` 要到 `nextTick` 之后才开。原因：Vue 的 pre-flush watcher 在 nextTick 回调之前执行，必须延迟恢复才能让它在补丁期间看到 false 而跳过，从而避免补丁被误判为 direct 二次触发。
- 事实：即便没有 `$onAction` 监听器，每次动作调用仍会新建 `afterCallbackSet`/`onErrorCallbackSet` 两个集合并执行一次 `triggerSubscriptions`（对空集合是空操作）——这是权衡 2、3 的代价。
- 推断（标注为推断）：`activeListener` 令牌 + nextTick 恢复的组合，主要为了把「同一 tick 内连续多次 `$patch`」合并成「最后一次补丁之后才重新打开监听」，避免中途某次补丁的恢复回调提前打开监听、使后续补丁被误判为 direct。
- 推断（标注为推断）：动作包装器里 `this && this.$id === $id ? this : store` 的守卫，推测是为 HMR 热更新或插件改写动作时保留调用方上下文而设；普通调用 `this` 即 store，两分支无差别。
- 边界：`$subscribe` 按「引用」去重——跨组件复用同一个函数引用订阅时，第二次起静默返回 noop、不注册新监听；若期望每个组件独立监听，需用不同的函数引用（或显式 detached）。
- 未理解：补丁内 `isSyncListening` 已恢复为 true（store.ts:321）之后、`triggerSubscriptions` 之前，若存在 sync 订阅且状态在派发过程中又间接触发写，是否可能产生意外 direct 事件——未构造复现场景，存疑。
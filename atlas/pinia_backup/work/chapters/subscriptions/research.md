# 订阅原语：Set + onScopeDispose 的自动回收 · 源码精读

## 给 Writer 的教学钩子（必填，8 子项缺一不可）

- **用户痛点 / 场景**：在响应式 store 上挂回调（订阅 state 变化、订阅 action 调用）最常见的事故是「忘了取消订阅」——组件销毁后回调还活着，每次 state 变化都触发，引用着旧组件的数据，造成内存泄漏与幽灵更新；手写「在卸载钩子里手动 remove」既啰嗦又易漏。另一面，少数长生命周期订阅（如 devtools、跨作用域监听）又确实需要活得比当前作用域更久——单一生命周期策略无法同时满足两边。

- **一句话核心思想**：**把订阅的生命周期默认绑死在它被注册时的 effect 作用域上**——随作用域一起被回收；脱离作用域是显式 opt-out，调用方自己负责。

- **设计动机（为什么需要它）**：store 的两类事件（state 变化、action 调用）需要一个最小回调容器：能加、能删、能批量触发。但因为这两个事件源天然长在组件树里消费，希望「随组件卸载自动清理」是零成本默认，而不是需要每处都记得写的样板代码；同时又不能把这条策略硬编码死，否则 devtools、跨作用域观察者全部被绑死。于是把「自动回收」做成默认行为、把「脱离作用域」做成显式选项——同一原语同时服务两类消费者。

- **关键权衡（机制丰富章，5 条都讲透）**：
  1. **选集合容器而不是数组** → 换来了「同一回调按引用幂等去重」和「O(1) 增删」→ 代价是「回调按引用相等判定，无法让同函数注册多次（多实例场景需自行包一层）」「无法按索引寻址」。
  2. **默认借作用域的 dispose 钩子自动注销，而不是只返回取消函数让用户自己管** → 换来了「组件里挂的 state/action 订阅几乎不会泄漏」→ 代价是「在作用域外（setup 外、纯工具函数里）调用默认模式等于裸注册、不会被自动回收，必须显式声明 detached 才能跨作用域」，以及「默认行为依赖于注册点恰好有 active scope 的隐式约束」。
  3. **清理钩子作为参数显式传入，而不是原语内部决定要清理什么** → 换来了「订阅原语与『订阅附属资源』彻底解耦——state 订阅自己持有 watcher 的停止函数作为清理钩子，原语完全不知道 watcher 是什么」→ 代价是「调用方必须主动把资源释放函数传进来，少传一个参数就泄漏」。
  4. **取消函数做成幂等的（仅当真的从集合里删成功时才调清理钩子）** → 换来了「同一个取消函数被同时挂到作用域 dispose 队列和组件卸载钩子上也能安全重复调用，不会触发两次附属资源清理」→ 代价是「清理钩子不能假设它会被调多少次——实际是 0 或 1，调用方需自行保证清理本身也是幂等的」。
  5. **触发遍历不包 try/catch** → 换来了「错误直白可见、不吞异常、调用链极简」→ 代价是「一个回调抛错会中断后续回调的执行」，但因为订阅集按插入序顺序触发，这反而符合「让故障尽早暴露」的预期。

- **最小心智模型（5 步）**：
  1. **注册**：把回调塞进一个集合，构造一个对应的「取消闭包」。
  2. **决定生命周期**：若当前在某个 effect 作用域里且未声明 detached，把这个「取消闭包」挂到该作用域的 dispose 队列上。
  3. **触发**：事件发生时，遍历集合按插入序调用每个回调，参数透传。
  4. **单条取消**：调用取消闭包 → 从集合中删除该回调 → 若删成功（之前确实在），调用附属资源清理钩子。
  5. **整体销毁**：作用域 stop 时自动跑 dispose 队列，对每条订阅执行步骤 4；或 store 主动销毁时直接清空两个集合（不走单条路径，因为没有需要触发的附属清理）。

- **最小原理演示（替代旧"复刻范围"）**：
  - **应演示**：一段 ~30 行的 TS，用集合 + 作用域 dispose 钩子复刻「带自动回收 + detached 选项 + 清理钩子」的订阅原语本体；再附一段 ~10 行的使用例：在 effect 作用域内注册 → 作用域 stop 后断言集合已空；以及 detached 注册 → 作用域 stop 不会清空，必须手动调用返回的取消函数。
  - **应故意省略**：精确的泛型签名、与 vue watch 的集成、action 包装的 before/after/onError 三段钩子、批量 patch 期间临时关监听再手动触发的特殊路径——这些是上层组合，不是订阅原语本身。
  - **演示载体建议（Writer 据此执行）**：本章是 TS/JS 仓库的纯函数模块，建议写成能 `node`/`bun` 直接跑的脚本（依赖 vue 的 effectScope/onScopeDispose 即可，无需构建链）。可执行行为 = 「在 effectScope 内 addSubscription(...) 然后 scope.stop()，断言 Set 已空」+「detached 注册后 scope.stop() 不会清空，必须手动 remover()」。一句话原则：载体服务于演透原理，本章用 ~40 行可跑脚本演透「自动回收 vs 手动回收」的取舍，足矣。

- **正文不宜展开的细节**：
  - `_Method` 类型只是 `(...args: any[]) => any` 的占位，用于泛型推导回调签名，无需展开讲。
  - `noop` 单独 export 是为了在「重复注册」等场景返回一个安全的空函数，避免返回 undefined 让链式调用炸掉。
  - state 订阅内部用 `subscriptions.has(callback)` 显式去重并警告——这是 state 订阅自身的策略，**不是**原语强制的；action 订阅反而不去重。两种策略的选择权在调用方。
  - 是否触发自动回收有双 gate：「未声明 detached」**且**「当前有 active 作用域」——少了任一条件都退化为手动管理。

- **推荐的一个执行轨迹例子**：
  - 输入：组件 setup 中调用「订阅 state 变化」（默认非 detached）。
  - 中间态：回调被加进 state 订阅集合；对应的取消闭包被注册到组件 effect 作用域的 dispose 队列；同时一个 watcher 被创建，其 stop 函数作为清理钩子闭包捕获。
  - 触发：store 批量 patch 改了 state → 触发原语 → 回调被同步调用一次（多次 patch 在同一微任务内只通知一次）。
  - 卸载：组件 unmount → 作用域 dispose → 取消闭包执行 → 回调从集合中删除 → 因为删成功，清理钩子触发 → watcher 也被停止。
  - 输出：组件销毁后，store 的订阅集合里不再有该回调，对应 watcher 也已停止，无残留引用。

> 以上钩子供 Writer 写「动机→核心思想→心智模型→关键权衡→原理演示」；下面事实部分供核对，不要被 Writer 当目录照抄。

## 概念要点
- 模块只导出 3 个东西：`noop`、`addSubscription`、`triggerSubscriptions`，零内部状态、纯函数风格。源码位置: packages/pinia/src/subscriptions.ts:4,6,26
- `addSubscription` 接收 4 个参数：`subscriptions: Set<T>`、`callback: T`、`detached?: boolean`、`onCleanup: () => void = noop`，返回 `removeSubscription: () => void`。源码位置: packages/pinia/src/subscriptions.ts:6-24
- `removeSubscription` 内部用 `subscriptions.delete(callback)` 的**返回值**作为「是否真的删了」的判定，仅在删成功时调用 `onCleanup`——这是幂等性的来源。源码位置: packages/pinia/src/subscriptions.ts:14-17
- 自动回收的双 gate：`!detached && getCurrentScope()`——必须**同时**满足「未声明 detached」与「当前有 active effect scope」两个条件才会调 `onScopeDispose(removeSubscription)`。源码位置: packages/pinia/src/subscriptions.ts:19-21
- `triggerSubscriptions` 用 `subscriptions.forEach((cb) => cb(...args))` 顺序触发，无 try/catch；与 JS Set 的插入序保证一致，行为可预测。源码位置: packages/pinia/src/subscriptions.ts:26-33
- `_Method` 类型 = `(...args: any[]) => any`，是 types.ts 里的泛型占位。源码位置: packages/pinia/src/types.ts:414
- 模块只依赖 vue 的 `getCurrentScope` 与 `onScopeDispose` 两个 API；与 effectScope 深度耦合但不依赖 watcher/reactive。源码位置: packages/pinia/src/subscriptions.ts:1

## 关键调用链
- **作为 store 的 `$onAction`**：`partialStore.$onAction = addSubscription.bind(null, actionSubscriptions)` → 调用方 `store.$onAction(cb, detached)` → 等价于 `addSubscription(actionSubscriptions, cb, detached)`（onCleanup 默认 noop）→ action 包装内部用 `triggerSubscriptions(actionSubscriptions, { args, name, store, after, onError })` 通知。源码位置: packages/pinia/src/store.ts:435,382
- **作为 store 的 `$subscribe`**：先 `subscriptions.has(callback)` 去重（重复则 PINIA_R1007 警告并返回 noop）→ `addSubscription(subscriptions, callback, options.detached, () => stopWatcher())` → watcher 在 `scope.run(() => watch(...))` 内创建，stopWatcher 是其回收函数。源码位置: packages/pinia/src/store.ts:441-453
- **`$patch` 期间的手动触发**：因为 `$patch` 期间临时关掉了 `isListening`/`isSyncListening`（让 watch 不通知），需要手动 `triggerSubscriptions(subscriptions, subscriptionMutation, pinia.state.value[$id])` 把多次变更合并成一次通知。源码位置: packages/pinia/src/store.ts:321-327
- **Action 包装的三段触发**：`triggerSubscriptions(actionSubscriptions, {...})`（before）→ 同步执行 fn → catch → `triggerSubscriptions(onErrorCallbackSet, error)`；若 fn 返回 Promise 则 `.then` → `triggerSubscriptions(afterCallbackSet, value)` / `.catch` → `triggerSubscriptions(onErrorCallbackSet, error)`。注意 after/onError 是**每个 action 调用各自新建的局部 Set**，不是全局订阅集。源码位置: packages/pinia/src/store.ts:382-413
- **`$dispose` 的整体清理**：`scope.stop()` + `subscriptions.clear()` + `actionSubscriptions.clear()` + `pinia._s.delete($id)`——直接清空两个 Set，**不走**单条 removeSubscription 路径（因为 scope.stop 会触发所有 effect 的清理，watcher 等附属资源由 scope 负责）。源码位置: packages/pinia/src/store.ts:349-354

## 源码摘录（带行号，全文累计 ≤ 30 行）

```ts
// packages/pinia/src/subscriptions.ts — addSubscription 主体（去 noop 与 import）
export function addSubscription<T extends _Method>(
  subscriptions: Set<T>,
  callback: T,
  detached?: boolean,
  onCleanup: () => void = noop
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

// triggerSubscriptions 全文
export function triggerSubscriptions<T extends _Method>(
  subscriptions: Set<T>,
  ...args: Parameters<T>
) {
  subscriptions.forEach((callback) => {
    callback(...args)
  })
}
```

（以上累计 22 行源码摘录，每行都直接对应钩子里的某条原理点：第 6-12 行 = 注册；第 14-17 行 = 幂等取消+清理钩子；第 19-21 行 = 自动回收双 gate；第 26-33 行 = 顺序触发。）

## 易混淆 / 边界 / 推断
- **事实**：`$subscribe` 内部用 `subscriptions.has(callback)` 显式去重（PINIA_R1007 警告），但 `$onAction` 不去重——这是**调用方策略差异**，不是原语强制的。源码位置: packages/pinia/src/store.ts:441-446 vs 435。
- **事实**：`removeSubscription` 是幂等的——多次调用安全，因为 `Set.delete` 返回 false 后不会再调 `onCleanup`。源码位置: packages/pinia/src/subscriptions.ts:14-17。
- **推断**：`onCleanup` 设计成参数（而非闭包内部捕获）是为了让原语本身不关心「订阅附属的资源是什么」——比如 `$subscribe` 的 onCleanup 是 `() => stopWatcher()`，watcher 的具体形态原语无需感知。这让原语能复用于「无附属资源」（`$onAction`，默认 noop）和「有附属资源」（`$subscribe`，watcher stop）两类场景。
- **推断**：`if (!detached && getCurrentScope())` 中的 `getCurrentScope()` 检查是必要的——若在 effect scope 外调用 `onScopeDispose`，vue 会警告。这个双 gate 让 API 在「不在 scope 内时静默退化为手动管理」也安全。
- **推断**：`$dispose` 直接 `clear()` 两个 Set 而非逐条调 removeSubscription，是因为 `scope.stop()` 已经会通过 onScopeDispose 触发每条订阅的 removeSubscription（如果有附属 onCleanup 也会跑），所以 clear 只是顺手清空容器，避免 stop 后残留引用。源码位置: packages/pinia/src/store.ts:349-354。
- **未理解**：detached 模式下，调用方拿到 remover 但**忘记调用**的泄漏场景是否有 dev 警告——本文件未见相关诊断，store.ts 的 diagnostics 列表里也没找到对应条目；目前依赖文档约定。
# 订阅原语：回调集合与作用域自动清理 · 源码精读

## 给 Writer 的教学钩子（必填，8 子项缺一不可）

- **用户痛点 / 场景**：用 store 的人常需要两类通知——「状态一变就告诉我」（`$subscribe`）和「某个 action 被调用、且能在我里面挂它的成功/失败回调」（`$onAction`）。若没有一套底层原语，每个上层 API 都得各自造一套「回调容器 + 广播 + 卸载」的代码：自己记着在组件卸载时清理、自己处理同一个回调被重复注册、自己在组件外（store 互引、SSR、独立脚本）订阅时纠结「到底什么时候该取消」。啰嗦、重复、且极易内存泄漏。

- **一句话核心思想**：订阅 = 往一个集合里塞回调 + 返回一个「注销闭包」+ 默认把这个闭包绑到当前作用域的销毁时机；上层 API 只需各自补上「清理时要顺带释放什么」这一笔尾巴。

- **设计动机（为什么需要它）**：状态订阅与 action 订阅的「管理集合 / 遍历广播 / 卸载回调」三段骨架完全一致，差异仅仅在「回调的签名」和「卸载时还要不要顺手释放别的资源」。把这套公共骨架抽成一个与业务无关的原语，能消除两处重复实现；同时把「随所在作用域自动清理」设为默认行为，让「在组件里订阅、组件卸载自动取消」变成零样板的常态，直接掐掉最高发的泄漏路径。

- **关键权衡（本 Atlas 的核心，4 条三段式）**：
  1. **把注销实现成一个捕获了回调的闭包、并把它返回出去** → 换来「手动注销、作用域自动注销、额外资源释放」三种卸载语义共用同一个函数体（都走这一个闭包）→ 代价是「每次订阅都多分配一个闭包对象」。
  2. **默认在「非脱离 且 当前正处于某个作用域内」时，把注销闭包注册为该作用域的销毁钩子** → 换来「组件内订阅零样板、自动防泄漏」→ 代价是「想让订阅跨作用域长期存活（如全局监听），必须显式声明脱离，并自行持有注销函数、记得手动调」。
  3. **把「清理时要顺带释放的外部资源」做成一个可选的清理回调参数、缺省为何也不做** → 换来「同一个原语既能服务没有尾巴的 action 订阅（不传该参数），又能服务带尾巴的状态订阅（传『停掉对应侦听器』）」→ 代价是「资源释放职责被劈成两半：集合成员资格归原语管，外部资源释放归调用方通过清理回调表达」。
  4. **广播时按回调自身的签名做可变参数透传** → 换来「一个广播原语同时喂给『双参：变更对象 + 新状态』的状态订阅和『单参：action 事件对象』的 action 订阅」→ 代价是「所有回调须符合统一的可调用类型，集合里元素的回调类型在注册那一刻就固定下来」。

- **最小心智模型（7 步）**：
  1. 上层在装配时各持有一个空集合，作为「某一类回调的容器」（一个店分别有「状态订阅集」和「action 订阅集」两个集合）。
  2. 注册：把回调塞进集合，并立刻造好一个捕获了该回调的注销闭包。
  3. 绑生命周期：若这次注册没声明脱离、且当前正处在某个作用域里，就把注销闭包挂为该作用域的销毁钩子。
  4. 把注销闭包返回给调用方，作为「手动取消」的通道。
  5. 广播：遍历集合，按回调注册时的签名把参数原样透传给每一个回调。
  6. 卸载有三种触发源——调用方手动调返回的注销函数 / 所在作用域被销毁 / 整个 store 被销毁。注销闭包内部只做两件事：从集合删掉该回调；若删除确实成功，再调一次清理回调（释放外部资源）。
  7. （边界）整店销毁时用的是「直接清空集合」，绕过了注销闭包、**不会**触发清理回调；但它紧接着停掉了自己的作用域，作用域销毁仍会逐个触发已挂的注销闭包，从而间接把外部资源也释放掉。

- **最小原理演示（替代旧「复刻范围」）**：
  - 应演示：一个几十行的从零实现，演透四个原理点——**集合持有回调**、**返回注销闭包**、**默认随作用域自动清理**、**清理回调可选注入**。每一行都要能指到上面某条权衡或某个心智步骤。建议结构：一个 `addSubs(set, cb, detached?, onCleanup?)` 把 cb 入集合、造 remove 闭包、条件挂作用域销毁、返回 remove；一个 `triggerSubs(set, ...args)` 遍历调用。演示里用 `getCurrentScope()`/`onScopeDispose()`（Vue 的作用域 API）配合一个手写的 `effectScope` 跑通「注册 → 广播 → 卸载自动清理 → 注入清理回调被触发」这条主线。
  - 应故意省略：完整的 TS 泛型标注（`<T extends _Method>` / `Parameters<T>` 写最简形式即可）、`$subscribe`/`$onAction` 的具体业务包装、同回调去重逻辑、action 包装器的 before/after/onError 三段临时集合花样、flush:sync 分支、debuggerEvents、Promise 兼容。**不追求工程完整、不追求可独立 install**，只演透「集合 + 注销闭包 + 作用域绑定 + 可选清理尾巴」这四个原子。

- **正文不宜展开的细节（供 Writer 裁剪）**：统一的可调用类型 `_Method` 的类型工程与 `Parameters<T>` 的 TS 推断细节；`getCurrentScope`/`onScopeDispose` 作为 Vue effectScope API 的内部实现（那是 Vue 的事，本章只用）；`$subscribe` 的同回调去重（命中后返回空函数）与 `flush:'sync'` 监听开关——属消费方逻辑，留给「状态及动作订阅」章；action 包装器「每次调用新建 after/onError 临时集合、经 before 事件把注册器暴露给订阅者」的精细模式——也留给「状态及动作订阅」章；整店销毁用 `clear()` 清空却不触发清理回调的边界（可放在边界小节一笔带过）。

- **推荐的一个执行轨迹例子**：在组件 setup 里 `const stop = store.$subscribe(cb)` —— cb 进状态订阅集，因当前正处在组件的作用域内，注销闭包被挂到该作用域；组件存活期间，每次状态变更都遍历集合调 cb；组件卸载 → 作用域销毁 → 触发注销闭包 → 从集合删除 cb 成功 → 调清理回调 → 停掉为 cb 创建的侦听器。**对照组**：若写成 `store.$subscribe(cb, { detached: true })`，则不挂作用域，组件卸载后 cb 仍留在集合里持续被广播（泄漏），除非调用方自己保留 `stop` 并在合适时机手动调。

> 以上钩子供 Writer 写「动机 → 核心思想 → 心智模型 → 关键权衡 → 原理演示」；下面事实部分供核对，不要被 Writer 当目录照抄。

## 概念要点

- 原语导出三样：空操作的占位函数 `noop`、注册函数 `addSubscription`、广播函数 `triggerSubscriptions`。源码位置: packages/pinia/src/subscriptions.ts:4,6,26
- `addSubscription` 四参签名：回调集合 `Set<T>`、回调 `callback`、是否脱离 `detached?`、清理回调 `onCleanup = noop`。源码位置: packages/pinia/src/subscriptions.ts:6-11
- 注册即把 callback 加入集合，并立刻构造捕获了 callback 的 `removeSubscription` 闭包。源码位置: packages/pinia/src/subscriptions.ts:12-14
- 注销闭包的语义：`delete` 返回 true（确实删掉了）才调 `onCleanup`——天然幂等，重复调用不会再触发清理。源码位置: packages/pinia/src/subscriptions.ts:14-17
- 自动清理的触发条件是 `!detached && getCurrentScope()`：只有「未声明脱离」且「当前正处在某个 effect scope 内」时，才把注销闭包挂到 `onScopeDispose`。源码位置: packages/pinia/src/subscriptions.ts:19-21
- 注销闭包被 `return` 出去，作为手动取消通道。源码位置: packages/pinia/src/subscriptions.ts:23
- `triggerSubscriptions` 用 `...args: Parameters<T>` 把「注册时的回调签名」透传给「触发时的实参」，遍历集合逐个调用。源码位置: packages/pinia/src/subscriptions.ts:26-33
- 可调用类型约束 `_Method = (...args: any[]) => any`，是回调与 action 的统一类型。源码位置: packages/pinia/src/types.ts:414
- **消费点一（action 订阅）**：`$onAction` 用 `addSubscription.bind(null, actionSubscriptions)` 偏应用，把 action 订阅集合绑死为第一个参数；调用 `$onAction(cb, detached)` 等价于 `addSubscription(actionSubscriptions, cb, detached)`——**注意不传第四个 onCleanup**，故走默认 `noop`，即 action 订阅卸载时没有额外清理（它不持有需释放的资源）。源码位置: packages/pinia/src/store.ts:435
- **消费点二（状态订阅）**：`$subscribe` 调 `addSubscription(subscriptions, callback, options.detached, () => stopWatcher())`——这里第四个清理回调是 `() => stopWatcher()`：订阅被移除时连带停掉为该回调创建的 `watch`。这正是清理回调参数存在的理由。源码位置: packages/pinia/src/store.ts:448-453
- **消费点三（状态广播）**：`$patch` 因暂停了监听 watcher，需手动 `triggerSubscriptions(subscriptions, subscriptionMutation, state)`，保证「一次 patch = 一次状态订阅事件」。源码位置: packages/pinia/src/store.ts:323-327
- **消费点四（action 广播）**：action 包装器内多次广播——before 阶段 `triggerSubscriptions(actionSubscriptions, { args, name, store, after, onError })`（store.ts:382）；同步异常 `triggerSubscriptions(onErrorCallbackSet, error)`（store.ts:395）；Promise 成功 `triggerSubscriptions(afterCallbackSet, value)`（store.ts:402）；Promise 失败 `triggerSubscriptions(onErrorCallbackSet, error)`（store.ts:406）；同步返回 `triggerSubscriptions(afterCallbackSet, ret)`（store.ts:412）。其中 `afterCallbackSet`/`onErrorCallbackSet` 是每次 action 调用临时新建的集合，经 before 事件对象里的 `after(cb)`/`onError(cb)` 注册器暴露给订阅者——即「每次调用一个临时订阅集」。源码位置: packages/pinia/src/store.ts:372-413
- **去重保护（消费方）**：`$subscribe` 注册前先 `subscriptions.has(callback)` 检查，命中则发诊断并 `return noop`（返回一个空函数当「假 remove」，调了也无害），避免同一回调引用注册多次。源码位置: packages/pinia/src/store.ts:441-446
- **整店销毁**：`$dispose` 先 `scope.stop()`，再 `subscriptions.clear()` + `actionSubscriptions.clear()` + `pinia._s.delete($id)`。源码位置: packages/pinia/src/store.ts:349-354

## 关键调用链

- 注册（状态订阅）：`$subscribe(cb, opts)` → `addSubscription(subscriptions, cb, opts.detached, () => stopWatcher())` → 返回 remove（并在有作用域时挂 `onScopeDispose`）。
  源码位置: packages/pinia/src/store.ts:448-453 → packages/pinia/src/subscriptions.ts:6-24
- 注册（action 订阅）：`$onAction(cb, detached)` →（经偏应用）`addSubscription(actionSubscriptions, cb, detached)`。
  源码位置: packages/pinia/src/store.ts:435 → packages/pinia/src/subscriptions.ts:6-24
- 广播（状态）：`$patch` → 暂停 watcher → `triggerSubscriptions(subscriptions, mutation, state)`。
  源码位置: packages/pinia/src/store.ts:322-327 → packages/pinia/src/subscriptions.ts:26-33
- 广播（action）：`action()` 包装 → `triggerSubscriptions(actionSubscriptions, {after, onError, ...})` → 执行 fn → `triggerSubscriptions(afterCallbackSet, ret)` / `(..., onErrorCallbackSet, error)`。
  源码位置: packages/pinia/src/store.ts:382-413 → packages/pinia/src/subscriptions.ts:26-33
- 卸载（自动）：所在 `scope.stop()` → `onScopeDispose` 触发 → `removeSubscription()` → `subscriptions.delete(cb)` 成功 → `onCleanup()` → `stopWatcher()`。
  源码位置: packages/pinia/src/subscriptions.ts:19-23 → packages/pinia/src/store.ts:454-469

## 源码摘录（带行号，全文累计 ≤ 30 行）

注册函数——演「权衡①（注销闭包）+ 权衡②（作用域绑定）+ 权衡③（可选清理回调）」：

```ts
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
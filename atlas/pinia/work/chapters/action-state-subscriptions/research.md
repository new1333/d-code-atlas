# 订阅系统：$onAction 的动作包裹与 $subscribe 的监听协调 · 源码精读

## 给 Writer 的教学钩子（必填，8 子项缺一不可）

- **用户痛点 / 场景**：使用者想要在「每次 action 调用前后」做副作用（打日志、埋点、清理），又想在「状态被以任何方式改动时」收到一条带来源标记的通知。如果只给一个原始的「state 变了」事件，使用者既分不清这次改动是直接赋值、批量打补丁还是 action 内部引起的，也无法在 action 的成功/失败/异步 resolve 三个时机分别挂钩；而 action 内部若直接改 state，又会让「action 通知」与「state 通知」叠加成重复事件。痛点是：**需要一个能把「函数调用」和「状态变更」都重组成可控、不重复、带语义的通知系统**。

- **一句话核心思想**：在共享的「回调集合」原语之上，用**动作包裹器**把每次函数调用重组成一个带 before/after/onError 的生命周期事件，用**两个监听开关 + 手动触发**把任意方式的状态变更收拢成单条、不重复的订阅通知。

- **设计动机（为什么需要它）**：这个机制是为了解决「同一份状态被多种途径改动（直接赋值、批量补丁、action 内部改）时，如何让订阅者既收到**统一且不重复**的通知、又能区分来源」这个矛盾。它换来的能力是：devtools/插件/业务层可以稳定地观察「谁在什么时候以什么方式改了状态」，并能在 action 的成功与失败时机挂钩，且天然支持 async action。
  - **承前（跨章去重信号）**：
    - 「回调集合 + 作用域自动清理」这对**订阅原语**已在第 2 章『订阅原语』讲透，本章**只看它被两类上层订阅（动作订阅 / 状态订阅）如何消费**这个新侧面，不重讲原语本身。
    - 「打补丁期间暂停深度 watcher、再手动统一触发订阅」的**批处理思路**已在第 5 章『状态变更模型』讲透，本章**只看订阅侧（$subscribe 的 watcher）如何用两个开关配合这套暂停-恢复**这个新侧面——即为什么需要「同步开关」和「异步开关」两个而不是一个。
    - 「setup 返回值里的 function 在装配时被包成 action」已在第 4 章『Store 装配』讲透，本章**只看这个包裹器对订阅系统暴露的 after/onError/Promise 生命周期**这个新侧面。

- **关键权衡（本 Atlas 的核心）**：
  1. **用「两个监听开关 + 手动触发」协调 watcher 与补丁** → 换来了「无论直接改 state 还是批量打补丁，订阅者都只收到一条通知、且绝不重复（watcher 的自动通知与手动通知不会叠加）」的能力 → 代价是引入了与 Vue 调度时序强耦合的两个布尔开关、一个 nextTick 延迟恢复、外加一个「最后者胜」的去抖标记，时序极其微妙、几乎无法靠直觉推理。
  2. **用「调用期临时钩子集合」把函数调用重组成可观测生命周期** → 换来了「订阅者一次注册就能拿到 before（context 到达即 before）/after/onError 三个时机、并自动感知 Promise 的 resolve 与 reject」的能力 → 代价是每个 action 都被包一层闭包，且**每次调用**都要新建两个临时集合、触发一次动作订阅，频繁调用的 action 有固定开销。
  3. **让两类订阅共用同一对最小原语** → 换来了「动作订阅与状态订阅的注册、移除、作用域自动清理行为完全一致」的能力 → 代价是动作订阅的回调签名（接收对象）与原语的类型约束（接收函数）不匹配，需用类型逃逸绕过；且状态订阅还要在原语之外额外挂一个 watcher，并把「停 watcher」塞进原语的清理回调里——两条订阅路径的内部复杂度并不对称。
  4. **状态订阅做回调去重，动作订阅不做** → 换来了「同一个回调被多次注册为状态订阅时，不会建出多个 watcher 重复通知」的能力 → 代价是两个订阅 API 在去重策略上不对称（动作订阅同一监听者可被注册多次），是一个需要使用者知晓的边界。

- **最小心智模型（3～7 步）**：
  1. 装配时：每个 function 被包成「带标记的包裹 action」写入 store（标记防止重复包裹）；装配全部完成后才把两个监听开关拨到「开」，让装配期的初始化赋值保持静音。
  2. 注册动作订阅：往「动作回调集合」加一个监听者，默认把它的清理绑到当前作用域。
  3. 调用 action：为**这一次调用**新建一对临时的 after/onError 钩子集合，把「{名字, 参数, store, after, onError}」作为事件发给所有动作监听者——到达 context 即相当于 before 时机。
  4. 监听者在 context 里调 after(cb)/onError(cb)，把自己的钩子登记进**本次调用**的临时集合；随后执行原 action：成功→触发 after；同步抛错→触发 onError 再抛；返回 Promise→resolve 触发 after、reject 触发 onError。
  5. 注册状态订阅：若该回调已注册则直接返回（去重），否则往「状态回调集合」加回调，并在 store 作用域内建一个监听根状态的深度 watcher；订阅被移除（手动或作用域销毁）时连带停掉这个 watcher。
  6. 直接改 state：watcher 被调度/触发，其处理器先查「开关是否开着」——开着才调回调（通知类型标为 direct）。
  7. 走补丁：先把两个开关拨「关」（静音 watcher）→ 改 state → 同步开关立即恢复、异步开关延迟到下一 tick 恢复 → 手动触发一次状态订阅（通知类型标为 patch 对象/函数）；结果：watcher 在此期间被静默丢弃，唯一的通知来自手动触发。

- **最小原理演示（替代旧"复刻范围"）**：
  - 应演示：一个**小到只表达两个核心思想**的从零实现（几十行）：(A) 「暂停开关 + 手动触发」让直接改与补丁都只产生一条通知、互不重复；(B) 「action 包裹器」用调用期临时集合暴露 after/onError 并感知 Promise。每一行都要对应上面某个原理点。
  - 应故意省略：detached/onScopeDispose 的作用域绑定、Map/Set 的深合并、devtools 的 onTrigger 与调试事件收集、HMR、option/setup 分类、$reset、完整泛型与类型推导。
  - **演示载体建议**：本仓库主语言是 TS、深度依赖 Vue 的 reactivity。建议写成一段能 `node`/`bun`（或 vitest）直接跑的 TS 脚本，直接复用 vue 的 `reactive` + `watch` 做「根状态 + 深度 watcher」的最小骨架，能跑最好（非硬要求）。核心是演透两个思想，而非演完整工程：一段执行轨迹应清晰展示「直接改 → 一条 direct」「补丁 → 一条 patch（watcher 被静音）」「同步 action 抛错 → onError 再抛」「async action → resolve 后才 after」。

- **正文不宜展开的细节**：调试事件（DebuggerEvent）如何在 dev 下经 watcher 的 onTrigger 钩子收集、并按 direct（单个）/patch（数组）挂到通知上供 devtools 分组；HMR 热更新复用同一对开关短暂静音再恢复；$dispose 如何靠停作用域连带停掉所有 watcher 与订阅；两个 Symbol（动作标记/动作名）防止 action 被二次包裹的机制；types 层为兼容两种语法而对动作监听者上下文做的条件类型映射。

- **推荐的一个执行轨迹例子**：
  - 输入 `store.count++`（直接改）→ watcher 被调度 → 处理器查开关为「开」→ 回调收到 `{type: 'direct'}`，**一条**。
  - 输入 `store.$patch(s => { s.count++; s.name = 'x' })`（补丁）→ 两开关置「关」→ 改 state（watcher 虽被调度但在 flush 时开关仍关、静默丢弃）→ 同步开关立即恢复、异步开关下一 tick 恢复 → 手动触发 → 回调收到 `{type: 'patch function'}`，**一条**（两条改动合并成一条）。
  - 输入 `await store.asyncInc()`（async action）→ 动作监听者收到 context（before）→ action 执行返回 Promise → resolve → after 钩子被触发；若 reject → onError 钩子被触发且错误继续抛出。

> 以上钩子供 Writer 写「动机→核心思想→心智模型→关键权衡→原理演示」；下面事实部分供核对，不要被 Writer 当目录照抄。

## 概念要点

- **两类订阅共用同一对原语**：动作订阅与状态订阅都落在 `addSubscription`/`triggerSubscriptions` 之上。`$onAction` 直接 `addSubscription.bind(null, actionSubscriptions)`；`$subscribe` 则调用 `addSubscription(subscriptions, callback, options.detached, () => stopWatcher())`，把「停 watcher」塞进原语的清理回调。
  源码位置: packages/pinia/src/store.ts:435, 448-453；packages/pinia/src/subscriptions.ts:6-24

- **两个监听开关是协调的枢纽**：`isListening`（管 pre/post flush 的异步 watcher）与 `isSyncListening`（管 flush:'sync' 的同步 watcher）在装配末尾才被置 true（装配期静音），在补丁开头被置 false，随后分别按「同步立即恢复 / 异步 nextTick 恢复」恢复。
  源码位置: packages/pinia/src/store.ts:266-267, 778-779, 293, 321, 315-320

- **补丁期间「静音 watcher + 手动触发」**：补丁先把两开关关掉再改 state，改完手动 `triggerSubscriptions(subscriptions, subscriptionMutation, state)` 发**一条**；被 Vue 排队的 watcher 在 flush 时因开关为 false 而被处理器丢弃，从而避免与手动触发重复。注释明确指出 flush 选项**不影响**补丁的通知（补丁永远同步手动发一条）。
  源码位置: packages/pinia/src/store.ts:293, 323-327；types 注释 packages/pinia/src/types.ts:349

- **watcher 处理器里的开关判断**：handler 不是无条件调回调，而是 `if (options.flush === 'sync' ? isSyncListening : isListening)` 才调；这正是两个开关分工的落点。
  源码位置: packages/pinia/src/store.ts:457-467

- **并发补丁的「最后者胜」去抖**：用 `activeListener` 符号标记最近一次补丁，只有最后一次补丁的 nextTick 才把异步开关恢复为 true，避免连续多次补丁时前面的恢复过早打开开关。注释引用 issue #1129。
  源码位置: packages/pinia/src/store.ts:284, 315-320

- **action 包裹器：调用期临时钩子集合**：每次调用 action 都新建 `afterCallbackSet`/`onErrorCallbackSet` 与本地 `after`/`onError` 注册器，再把 `{ args, name, store, after, onError }` 作为事件发给动作订阅者。订阅者在 context 里登记的钩子只对**本次调用**生效。
  源码位置: packages/pinia/src/store.ts:368-388

- **同步错误 vs Promise 错误的两路处理**：`try/catch` 捕同步抛错（触发 onError 再 throw）；返回 Promise 时挂 `.then(触发 after)/.catch(触发 onError 且 reject)`；非 Promise 同步结果直接触发 after。
  源码位置: packages/pinia/src/store.ts:390-413

- **防重复包裹**：用两个内部 Symbol（动作标记/动作名）；若函数已带标记则只更新名字并原样返回，不再包一层。装配时每个 function prop 都经 `action(prop, key)` 包裹后写回，并登记进 optionsForPlugin.actions。
  源码位置: packages/pinia/src/store.ts:63-77, 361-366, 416-421, 540-545

- **状态订阅的回调去重**：`subscriptions.has(callback)` 时直接返回 noop、不建 watcher（issue #3143）。注意动作订阅（actionSubscriptions）无对应去重。
  源码位置: packages/pinia/src/store.ts:441-446

- **状态订阅的 watcher 寄生于 store 作用域**：`scope.run(() => watch(...))`，watcher 生命周期随 store 的 effectScope；`$dispose` 调 `scope.stop()` 连带停掉所有 watcher，并 `clear()` 两个集合、从注册表删除。
  源码位置: packages/pinia/src/store.ts:454-471, 349-354

- **通知类型三态**：`direct`（watcher 直接捕获）/`patchObject`（对象补丁）/`patchFunction`（函数补丁），分别由 watcher、对象补丁、函数补丁产出。
  源码位置: packages/pinia/src/types.ts:43-68；产出点 packages/pinia/src/store.ts:462, 309, 302

- **HMR 复用同一对开关**：热更新重写 state 时同样「两开关置 false → 改 → 同步开关 true → nextTick 异步开关 true」，避免热更新赋值被当作 mutation 上报。
  源码位置: packages/pinia/src/store.ts:639-645

## 关键调用链

- **动作通知链**：外部调 `store.someAction(...)` → `wrappedAction(...)`（包裹器）→ 新建临时 after/onError 集合并定义本地注册器 → `triggerSubscriptions(actionSubscriptions, { args, name, store, after, onError })` → 监听者在其 context 里 `after(cb)`/`onError(cb)` 登记进本次集合 → `fn.apply(store, args)` → 成功 `triggerSubscriptions(afterCallbackSet, ret)` / 同步错 `triggerSubscriptions(onErrorCallbackSet, error)` 再 throw / Promise 则 `.then(after).catch(onError)`。
  源码位置: packages/pinia/src/store.ts:368-413

- **状态通知链（直接改）**：外部 `store.x = ...` → Vue 深度 watcher 被调度/触发 → handler 查 `isListening`/`isSyncListening` → 为 true 时 `callback({ storeId, type: direct, events }, state)`。
  源码位置: packages/pinia/src/store.ts:454-471

- **状态通知链（补丁）**：`$patch(...)` → `isListening = isSyncListening = false` → 改 state（mergeReactiveObjects 或函数式）→ `isSyncListening = true` + `nextTick(恢复 isListening)` → `triggerSubscriptions(subscriptions, { type: patchObject|patchFunction, ... }, state)`（唯一一条）。
  源码位置: packages/pinia/src/store.ts:293-327

- **注册/移除链**：`$onAction(cb, detached)` → `addSubscription(actionSubscriptions, cb, detached)` → 返回 removeSubscription（默认绑 onScopeDispose）。`$subscribe(cb, { detached })` → 去重检查 → `addSubscription(subscriptions, cb, detached, () => stopWatcher())` → `scope.run(watch(...))` 建深度 watcher → 返回 removeSubscription（移除时 stopWatcher）。
  源码位置: packages/pinia/src/store.ts:435, 438-474；packages/pinia/src/subscriptions.ts:6-24

## 源码摘录（带行号，全文累计 ≤ 30 行）

补丁期间的「暂停-恢复-手动触发」枢纽：
```ts
isListening = isSyncListening = false          // 静音两类 watcher
// …改 state（函数式直接改 / 对象式深合并）…
const myListenerId = (activeListener = Symbol())
nextTick().then(() => { if (activeListener === myListenerId) isListening = true })
isSyncListening = true
triggerSubscriptions(subscriptions, subscriptionMutation, pinia.state.value[$id] as UnwrapRef<S>)
```
源码位置: packages/pinia/src/store.ts:293, 315-327

状态订阅 watcher 处理器里的开关判断：
```ts
watch(() => pinia.state.value[$id] as UnwrapRef<S>, (state) => {
  if (options.flush === 'sync' ? isSyncListening : isListening) {
    callback({ storeId: $id, type: MutationType.direct, events: debuggerEvents }, state)
  }
}, assign({}, $subscribeOptions, options))
```
源码位置: packages/pinia/src/store.ts:455-470

action 包裹器的「调用期生命周期」分发：
```ts
triggerSubscriptions(actionSubscriptions, { args, name: wrappedAction[ACTION_NAME], store, after, onError })
try {
  ret = fn.apply(this && this.$id === $id ? this : store, args)
} catch (error) { triggerSubscriptions(onErrorCallbackSet, error); throw error }
if (ret instanceof Promise) {
  return ret
    .then((v) => { triggerSubscriptions(afterCallbackSet, v); return v })
    .catch((e) => { triggerSubscriptions(onErrorCallbackSet, e); return Promise.reject(e) })
}
triggerSubscriptions(afterCallbackSet, ret)
return ret
```
源码位置: packages/pinia/src/store.ts:382-413

## 易混淆 / 边界 / 推断

- **事实**：动作订阅的回调签名（收一个 context 对象）与原语类型约束 `T extends _Method`（收函数）不匹配，store.ts 在 `triggerSubscriptions(actionSubscriptions, {...})` 处用 `@ts-expect-error` 绕过；types 层用条件类型把「多个具名 action」映射成各自的 context 联合。
  源码位置: packages/pinia/src/store.ts:381；packages/pinia/src/types.ts:208-237

- **事实**：`after`/`onError` 注册器是**每次调用**新建的局部闭包变量，订阅者登记的钩子只对该次调用生效；不同调用之间钩子互不可见（除非订阅者在自己的闭包里维护状态）。
  源码位置: packages/pinia/src/store.ts:372-388

- **推断（标注为推断）**：之所以用「同步开关」和「异步开关」两个而不是一个，是因为 Vue 的 watcher 有 sync/pre/post 三种 flush——sync watcher 在改 state 时立即触发（需在改之前就关掉、改完立即恢复），而 pre/post watcher 进微任务队列在下一 tick flush（需把恢复推迟到 nextTick 之后，让本次 flush 时开关仍为关）。两类 watcher 的静音窗口落在不同时机，故拆成两个开关分别控制。源码无逐字注释说明此动机，系从时序结构推断。

- **事实**：`$patch` 内 `nextTick().then(恢复 isListening)` 排在「Vue flush 当前队列」之后，因此本次补丁期间被调度的 pre/post watcher 在 flush 时 isListening 仍为 false 而被丢弃；这是「只发一条」能成立的关键时序。
  源码位置: packages/pinia/src/store.ts:316-320, 457-467

- **边界**：动作订阅（actionSubscriptions）不做回调去重，同一监听者可被 `addSubscription` 多次加入集合从而被多次通知；状态订阅（subscriptions）则做去重。两者去重策略不对称，使用者需知晓。
  源码位置: packages/pinia/src/store.ts:441-446（仅状态订阅去重）

- **未理解**：dev 下 watcher 的 `onTrigger` 在「装配期（isListening 为 undefined）」「补丁期（isListening === false）」「正常监听期」三态下对 debuggerEvents 的写入路径略有差异（装配期直接覆盖、补丁期 push 进数组），其与 devtools 分组展示的精确对应关系本章未深入，留待 DevTools 章节核实。
  源码位置: packages/pinia/src/store.ts:246-262
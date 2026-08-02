# Action 包装：before/after/onError 三段拦截 · 源码精读

## 给 Writer 的教学钩子（必填，8 子项缺一不可）

- **用户痛点 / 场景**：store 里有十几个 action——`login`、`fetchUser`、`addToCart`……你想做日志埋点、运行时长上报、权限校验、错误监控、或者一个能在时间线上看到「这个 action 干了啥」的开发者工具。没有统一拦截点时，每加一个关注点都得改一遍所有 action，或者逼调用方手动套 wrapper，工程上几乎不可维护。

- **一句话核心思想**：**用一个包装函数把每个 action 包起来，调用时先广播"我要开始了"并把"事后钩子注册器"塞给订阅者，订阅者借机挂上 `after`/`onError` 回调，然后真正去跑 action，按同步/异步/抛错三种结局分别触发对应回调**。

- **设计动机（为什么需要它）**：把"action 被调用"这件事变成一条**统一的事件流**——所有横切关注点（日志、devtools 时间线、持久化、错误监控）都接到同一个 `store.$onAction(callback)` 上，互不打架，也无需碰 action 自身实现。同时一个 action 又有"开始前/正常结束/抛错"三个时刻，必须用一个机制同时覆盖同步 action 和异步（返回 Promise）action。

- **关键权衡**：
  1. **每次调用都新建两个 Set + 一次广播 → 换来"任意订阅者都能挂 after/onError"的对称 API → 代价是每次 action 调用都有固定开销**（分配 + 函数层级 + Promise 链路），轻量同步 action 场景里这部分开销无法省去。
  2. **用 Symbol 隐式标记做包装幂等 → 换来"用户用 `helpers.action` 显式包一次 + 框架自动再包一次"也不重复拦截 → 代价是包装识别依赖隐式 Symbol 契约**，跨 HMR 重建等场景必须重新标记。
  3. **`after`/`onError` 暴露成"per-call 注册函数"而非回调列表 → 换来订阅者用同一份 API 既能处理同步 action 也能处理异步 action（甚至不用知道是不是 Promise）→ 代价是异步 action 的 after 必须在 Promise resolved 后才触发，调用方拿到的是被链式包过的 Promise，链断了就丢通知**。
  4. **不引入 TC39 Async Context → 换来实现简单、对宿主运行时无强依赖 → 代价是 setup store 的异步 action 在第一个 `await` 之后，已经"丢失"了当前正在执行的 action 上下文**，devtools 想把后续 mutation 关联到这个 action 只能用全局变量 + Proxy 兜底（见 devtools-integration 章）。

- **最小心智模型（3～7 步）**：
  1. 构建期：构建器遍历 `setup()` 返回值，凡见到 function 都喂给 `action(fn, name)`。
  2. `action()` 先看 Symbol 标记——已标过就只补个名字、原样返回；没标过就造一个 `wrappedAction`。
  3. 运行期：用户调 `store.fetchUser(42)`，实际进的是 `wrappedAction`。
  4. `wrappedAction` 先把当前 pinia 设为 active，再为这次调用新建空的 `after`/`onError` 回调 Set。
  5. 广播 `{ name, store, args, after, onError }` 给所有 `$onAction` 订阅者——这相当于"before"，订阅者此时把想要在事后触发的回调塞进 Set。
  6. 真正去调原始 action：同步抛错 → 触发 `onError` Set 后 rethrow；同步正常 → 触发 `after` Set；返回 Promise → 在 `.then`/`.catch` 里触发 `after`/`onError` 后再 resolve/reject。
  7. 标记 + 命名符号挂回 `wrappedAction`，避免后续被重复包装。

- **最小原理演示（替代旧"复刻范围"）**：
  - 应演示：一段约 50～70 行的 TS 脚本，**只演透"包装 + 三段钩子注册"**——一个 `subscriptions: Set<listener>`、一个 `wrapAction(name, fn)` 工厂、一个 `Symbol` 幂等标记、一个同步 action、一个异步 action、一个抛错 action；附一个 listener 调 `after`/`onError` 注册钩子。重点演示广播发生在 `fn` 真正执行**之前**，而 `after`/`onError` 的触发发生在 `fn` 结束**之后**——这条时序差是全章灵魂。
  - 应故意省略：Vue 集成、effectScope、$patch/$subscribe、HMR 重包路径、`helpers.action`、类型推导、devtools Proxy 兜底、`setActivePinia`（用一个全局变量代替即可演示）。
  - **演示载体建议**：本章是纯 TS 逻辑、无 Vue 响应式依赖（包装机制本身只用 `Set` 和 `Promise`），建议写成能 `bun run`/`tsx`/`node` 直接跑的独立 TS 脚本（`pinia/action-wrapping/demo.ts`）——能跑最好，验证三段时序；不强求跑也行，写成"机制骨架 + 文字执行轨迹"同样演得透。**不要**套 Vue 工程链。

- **正文不宜展开的细节**：
  - `optionsForPlugin.actions[key] = prop`：把原始 action 收集给插件用，与 `$onAction` 无直接关系，归插件章。
  - `_hotUpdate` 中按新模块的 `_hmrPayload.actions` 重包一遍：HMR 章的细节。
  - `$dispose` 清空 `actionSubscriptions`：生命周期归 effect-scope-pinia 章。
  - `MarkedAction` 内部类型与 `StoreOnActionListenerContext` 的类型推导迷宫：类型细节，正文应跳过。
  - devtools 真正如何用 `$onAction` + Proxy 关联异步 mutation：归 devtools-integration 章。

- **推荐的一个执行轨迹例子**：
  - 输入：调用 `store.fetchUser(42)`，其中 `fetchUser` 是个 `async` action；事先 `store.$onAction(({ name, args, after, onError }) => { console.log('start', name, args); after(v => console.log('done', v)); onError(e => console.error('err', e)) })`。
  - 中间态：① 进 `wrappedAction`，建空 `afterSet`/`onErrorSet`；② 广播 → listener 立刻打 `start fetchUser [42]`，并把回调塞进 Set；③ 跑原始 `fetchUser`，返回 Promise；④ Promise resolve（假设 `"user-42"`）→ `.then` 触发 `afterSet` → 打 `done user-42` → 返回值继续往外传。
  - 输出：调用方拿到 `"user-42"`；listener 已经观测到完整生命周期。

> 以上钩子供 Writer 写「动机→核心思想→心智模型→关键权衡→原理演示」；下面事实部分供核对，不要被 Writer 当目录照抄。

## 概念要点

- **包装入口与幂等保护**：`action()` helper 接收原始函数和名字；若函数已带 `ACTION_MARKER` 符号属性，**只补 `ACTION_NAME` 后原样返回**，避免二次包装。源码位置: packages/pinia/src/store.ts:361-366
- **ACTION_MARKER / ACTION_NAME 双符号**：一个标记"是否已包装"，一个携带 action 名（可后补，HMR 时重包会改写它）。符号属性不会出现在 `for...in` 枚举里，所以不会污染 store 的可枚举属性。源码位置: packages/pinia/src/store.ts:63-77
- **三段拦截的实现是"广播 + 注册器"**：`wrappedAction` 调用时新建两个空 Set（`afterCallbackSet`、`onErrorCallbackSet`），把 `after`/`onError` **注册函数**连同 `name`/`store`/`args` 一起广播给所有 `$onAction` 订阅者；订阅者此时调 `after(cb)`/`onError(cb)` 把回调塞进 Set。这一次广播既是"before 通知"也是"注册窗口"。源码位置: packages/pinia/src/store.ts:368-388
- **三种结局分发**：① 同步 `try/catch` 捕到的错误 → 触发 `onError` Set 再 rethrow；② 返回值是 Promise → `.then` 触发 `after` Set（resolved 值传给回调）、`.catch` 触发 `onError` Set（reject 透传）；③ 同步正常返回 → 立即触发 `after` Set。源码位置: packages/pinia/src/store.ts:390-413
- **`$onAction` 的实现只是 `addSubscription` 的部分绑定**：`addSubscription.bind(null, actionSubscriptions)` 把订阅 Set 提前钉死——调用 `store.$onAction(callback, detached)` 时，借助 `subscriptions.ts` 的 `onScopeDispose` 自动清理机制（见 subscriptions 章），detached 模式则换回手动管理。源码位置: packages/pinia/src/store.ts:435
- **`this` 的防御性默认**：`fn.apply(this && this.$id === $id ? this : store, args)`——只有调用方传进来的 `this` 确实是本 store 时才尊重它，否则一律 fallback 到闭包里的 `store`。这避免了 action 被解构出去裸调用时（`const f = store.fetchUser; f(42)`）`this` 丢失导致的内部崩溃。源码位置: packages/pinia/src/store.ts:392
- **构建期自动包装**：`createSetupStore` 遍历 `setup()` 返回值，凡 `typeof prop === 'function'` 都喂给 `action(prop, key)`（用 key 当名字），然后把包装结果回写到 `setupStore[key]`——这是用户"什么都不用做就拥有 $onAction 能力"的来源。源码位置: packages/pinia/src/store.ts:540-554
- **`helpers.action` 是"显式包装"逃生口**：`createSetupStore` 调 `setup({ action })` 把这个 helper 传给用户的 setup 函数，用户可在 setup 内主动包一层（注释里点名 Pinia Colada 这种进阶场景）——配合 `ACTION_MARKER` 幂等，框架后续自动包装不会再加一层。源码位置: packages/pinia/src/store.ts:500-502, 810-820
- **`$dispose` 一次性清空订阅**：销毁 store 时 `actionSubscriptions.clear()`，所有 `$onAction` 监听者随 store 一起作废。源码位置: packages/pinia/src/store.ts:349-354
- **HMR 中的重包路径**：热更新时 `_hotUpdate` 用新模块的 actions 字典，对每个 action 重调 `store[name] = action(actionFn, name)`——重新过一遍包装流程，新名字挂到 `ACTION_NAME`。源码位置: packages/pinia/src/store.ts:647-654

## 关键调用链

构建期：
```
createSetupStore
  → setup({ action })                          // 传 helper
  → for key in setupStore: action(prop, key)   // 自动包装
     → 若 ACTION_MARKER in fn：补名字后原样返回
     → 否则：建 wrappedAction，挂 SYMBOL，返回 wrappedAction
  → setupStore[key] = wrappedAction            // 覆盖原函数
```
源码位置: packages/pinia/src/store.ts:500-571

运行期（单次调用 `store.fetchUser(42)`）：
```
wrappedAction(42)
  → setActivePinia(pinia)
  → 新建 afterCallbackSet / onErrorCallbackSet
  → triggerSubscriptions(actionSubscriptions, { name, store, args, after, onError })
       └─ 每个 $onAction listener 此时被调用，借机 after(cb)/onError(cb) 把回调塞进 Set
  → try { ret = fn.apply(this-or-store, [42]) }
     ├─ 同步抛错 → triggerSubscriptions(onErrorCallbackSet, err); throw err
     ├─ ret 是 Promise → ret.then(trigger after).catch(trigger onError); return 链式 promise
     └─ 同步值 → triggerSubscriptions(afterCallbackSet, ret); return ret
```
源码位置: packages/pinia/src/store.ts:368-413

消费侧（devtools）样例：
```
store.$onAction(({ name, args, after, onError }) => {
  api.addTimelineEvent({ ... '🛫 ' + name })   // before
  after(result => api.addTimelineEvent({ ... '✅' }))   // 注册 after
  onError(err => api.addTimelineEvent({ ... '❌' }))    // 注册 onError
})
```
源码位置: packages/pinia/src/devtools/plugin.ts:344-364

## 源码摘录（带行号，全文累计 ≤ 30 行）

```ts
// 两个内部符号 + 已包装函数的形状（节选）
const ACTION_MARKER = Symbol()                            // 标识"已包装"
const ACTION_NAME = Symbol()                              // 携带 action 名（可后补）
interface MarkedAction<Fn extends _Method = _Method> {
  (...args: Parameters<Fn>): ReturnType<Fn>
  [ACTION_MARKER]: boolean
  [ACTION_NAME]: string
}
```
源码位置: packages/pinia/src/store.ts:63-77

```ts
// wrappedAction 核心：广播 → 跑 fn → 按结局分发
const wrappedAction = function (this: any) {
  setActivePinia(pinia)
  const args = Array.from(arguments)
  const afterCallbackSet: Set<(resolvedReturn: any) => any> = new Set()
  const onErrorCallbackSet: Set<(error: unknown) => unknown> = new Set()
  function after(cb: _SetType<typeof afterCallbackSet>) { afterCallbackSet.add(cb) }
  function onError(cb: _SetType<typeof onErrorCallbackSet>) { onErrorCallbackSet.add(cb) }

  // @ts-expect-error
  triggerSubscriptions(actionSubscriptions, { args, name: wrappedAction[ACTION_NAME], store, after, onError })

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
} as MarkedAction<Fn>
wrappedAction[ACTION_MARKER] = true
wrappedAction[ACTION_NAME] = name
```
源码位置: packages/pinia/src/store.ts:368-417（节选，删空白与类型推导注释）

```ts
// 构建期自动包装：setup() 返回值里凡是 function 都过一遍 action()
} else if (typeof prop === 'function') {
  const actionValue = __DEV__ && hot ? prop : action(prop as _Method, key)
  // @ts-expect-error
  setupStore[key] = actionValue
  // @ts-expect-error
  optionsForPlugin.actions[key] = prop          // 顺手收集给插件系统
}
```
源码位置: packages/pinia/src/store.ts:540-554

```ts
// $onAction 只是 addSubscription 的部分绑定
$onAction: addSubscription.bind(null, actionSubscriptions),
```
源码位置: packages/pinia/src/store.ts:435

## 易混淆 / 边界 / 推断

- **事实**：广播 `triggerSubscriptions(actionSubscriptions, ...)` **先于** `fn.apply(...)` 执行——所以 `after`/`onError` 的注册窗口只存在于 fn 跑动之前的那个同步时刻；如果 listener 里设了异步注册（例如 `setTimeout(() => after(cb), 0)`），等注册进去时 Set 已经被消费完，回调永远拿不到。源码位置: packages/pinia/src/store.ts:381-391
- **事实**：异步 action 返回的是**被链式包过的 Promise**——`.then`/`.catch` 内部触发 after/onError 后再 `return value` / `return Promise.reject(error)`，所以调用方拿到的 promise 行为对齐原 promise（resolve/reject 值不变），只是在中间插了一段观测。源码位置: packages/pinia/src/store.ts:399-409
- **事实**：`after` 回调拿的是 **resolved 后的值**而非 Promise（参见 `Awaited<ReturnType<A[ActionName]>>` 类型签名）；这意味着 listener 不需要自己 await。源码位置: packages/pinia/src/types.ts:188-195
- **推断**：`this.$id === $id` 这条防御性判断是为了让 action 被解构裸调时仍能正确运行（this 不再是 store → fallback 到闭包 store），同时也容忍 `store.action.call(store, ...)` 这种显式 bind。源码位置: packages/pinia/src/store.ts:392
- **推断**：用 Symbol 而非普通字符串属性做标记，一是避免与用户属性命名冲突，二是 Symbol 不出现在 `for...in` / `JSON.stringify` 中，不会污染 store 的枚举与序列化视图。源码位置: packages/pinia/src/store.ts:63-77
- **事实**：HMR 期间（`__DEV__ && hot`）跳过自动包装，直接保留原始 `prop`——因为热更新路径会由 `_hotUpdate` 自己调 `action(actionFn, actionName)` 重新包一次，避免双重包装。源码位置: packages/pinia/src/store.ts:541
- **推断（结合本章 summary）**：setup store 异步 action 的"await 后丢失上下文"问题源于——`wrappedAction` 同步返回链式 Promise 后立即让出执行权，没有 TC39 async context 之类的全局栈，devtools 无法在 await 之后追溯"当前 mutation 属于哪个 action"，只能用全局变量 + Proxy 兜底（详见 devtools-integration 章）。这是个**设计权衡**而非 bug，等 TC39 async context 普及可解。
- **未理解**：`afterCallbackSet` 的元素类型写作 `Set<(resolvedReturn: any) => any>`，但 `onErrorCallbackSet` 写作 `Set<(error: unknown) => unknown>`——onError 的返回类型为何是 `unknown` 而非 `void | boolean`？注释里提过 "Return false to catch the error and stop it from propagating"，但当前 wrappedAction 的 `.catch` 实现里只 `triggerSubscriptions + Promise.reject`，似乎并未消费 onError 回调的返回值。这条「onError 返回 false 阻断错误」的语义是否在别处生效、或仅是历史遗留，未在本章源码中得到验证，留给 Critic/Writer 谨慎处理。源码位置: packages/pinia/src/store.ts:373, 405-408 与 types.ts:197-201
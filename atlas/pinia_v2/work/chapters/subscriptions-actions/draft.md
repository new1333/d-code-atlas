# $subscribe 与 $onAction：状态及动作订阅

## 一、动机：组件渲染之外的反应

写 Pinia 时，状态和动作都不缺执行者——状态由响应式系统驱动视图，动作由你直接调用。真正缺的是「**在执行发生时被通知**」的第三方视角：

- **状态被改了**，但你想在「渲染之外」做反应：把最新状态写进本地存储、上报埋点、把变更推给 devtools 的时间线。你没有这个钩子。
- **动作被调了**，但你想在它「前后」插逻辑：测耗时、出错时上报、测试里断言传入的参数、把一次动作内引起的一连串状态变更**归因**到这一次调用。你也没有这个拦截点。

更麻烦的是状态和动作的**形态都不止一种**：状态可能是「直接赋的」（`store.count = 1`），也可能是「合并补丁改的」（`store.$patch({...})`）；动作可能同步返回，也可能返回一个 Promise。外部观察者若要自己逐一区分这些情况再决定怎么反应，心智负担极重。

本章讲的 `$subscribe` 与 `$onAction`，就是给这两类事件一个**统一的事件表面**——调用方只管订阅，至于「状态怎么被改的」「动作是同步还是异步」，由内部路径自己负责把**类型正确**的事件送进来。

## 二、核心思想：把变更和调用都抽象成可订阅的事件流

前置章节（`subscription-primitive`）已经建立了订阅原语：**一个回调集合 + 一个返回的卸载函数**——`addSubscription` 往 `Set` 里加回调并返回 `remove`，`triggerSubscriptions` 就是 `forEach` 调用，默认还随所在作用域自动清理。前置章节（`store-assembly`）也建立了装配期的一个动作：遍历 setup 返回值，**凡是函数都套一层「动作包装」再替换原属性**。

本章把这两件事拼成一句话的核心思想：

> **把「状态变更」和「动作调用」都抽象成可订阅的事件流——状态靠一个深度监听器捕获、动作靠一个套在每次调用外面的前后钩子捕获，二者都复用同一套「回调集合 + 卸载函数」的订阅原语。**

- 状态变更 → 一个深度监听器（`watch(state, { deep })`）盯着整个 state，任何写都变成一个 `{ type, state }` 事件送进状态订阅集合。
- 动作调用 → 那层装配期套上的**动作包装器**，在每次调用「之前」派发一个事件、调用「之后/出错」再派发，送进动作订阅集合。

两条流、两个集合、同一种订阅原语。下文先建立心智模型，再用一段从零实现的几十行代码把这两条流跑起来。

## 三、心智模型与执行轨迹

把两条流的执行轨迹分别画出来：

**状态变更流：**

```
写 state
  ├─ 直接赋值(store.count = 1) ──→ 深度监听器触发 ──→ 监听开关打开? ──→ 派发 { type: direct }
  └─ $patch({...}) ──→ 先关掉监听开关 ──→ 改 state(监听器被跳过) ──→ 手动派发 { type: patch }
                       └─ 下一个 tick 之后才把开关恢复打开
```

**动作调用流：**

```
调用 store.someAction(args)
  → 包装器：设好活跃实例指针
  → 新建本次调用专属的「完成 / 出错」两个回调集合
  → 派发「调用前」事件(订阅者可在此向那两个集合注册钩子)
  → 真正执行原函数
       ├─ 同步返回  ──→ 立刻派发「完成」集合
       ├─ 同步抛错  ──→ 立刻派发「出错」集合并重抛
       └─ 返回 Promise ──→ 在它 resolve 时派发「完成」/ reject 时派发「出错」
```

两个关键设计在轨迹里已经浮现，后面会反复用到：

1. **双路径但同一个回调**：直接写和补丁写最终都进**同一个**状态订阅回调，只靠 `type` 字段区分来源。
2. **钩子按调用实例化**：每次动作调用都新建一组「完成/出错」集合，随上下文对象传给订阅者去注册；调用一结束，集合就随上下文丢弃，订阅者为「这一次调用」注册的钩子天然隔离、无需手动清理。

**一条同步动作的执行轨迹**（订阅了 `({ name, after }) => after(v => log('done', name, v))`，然后调用 `increment(5)`）：

```
① 包装器被调用 → 设好活跃实例指针
② 新建本次调用的「完成 / 出错」集合与上下文 { name, args, after, onError }
③ 派发「调用前」→ 监听器运行，把 v => log(...) 塞进完成集合
④ 执行原 increment(5) → state.count 变成 5，函数返回 5
⑤ 同步返回 → 派发完成集合(5) → 打印 "done increment 5"
⑥ 返回 5 给调用方
```

若是异步动作，第 ④ 步拿到的是一个 Promise，于是走 `then(派发完成) / catch(派发出错并 reject)`，钩子在它**真正 settle 时**才触发——而非调用时。

## 四、最小从零演示

下面是一段**自包含、可直接运行**的最小实现，不依赖 Vue / Pinia。它用 `Proxy` 充当「深度监听器」（任何对 `state` 的直接写都会被它的 `set` 陷阱抓到），用 `makeAction` 把任意函数包成「可订阅动作」。两条核心机制都能在这几十行里看到。

```ts
// 一个从零实现的最小「可订阅状态 + 可订阅动作」
// 演示两条机制：
//   A. 动作包装器——调用前派发钩子、执行、完成/出错派发，兼容异步返回值
//   B. 状态订阅——直接写走监听器、补丁写暂停监听并手动派发、tick 后恢复

function fire(set, ...args) { for (const f of set) f(...args) }

// 订阅原语：回调集合 + 返回卸载函数（同回调引用去重）
function makeSubs() {
  const set = new Set()
  return {
    add(cb) { if (set.has(cb)) return () => {}; set.add(cb); return () => set.delete(cb) },
    run(fn) { set.forEach(fn) },
  }
}

// ── 机制 A：把任意函数包成「可订阅动作」
function makeAction(fn, name, actionSubs) {
  return function (...args) {
    const afterCbs = new Set(), errCbs = new Set()     // 本次调用专属的钩子集合
    const ctx = {
      name, args,
      after: (f) => afterCbs.add(f),
      onError: (f) => errCbs.add(f),
    }
    actionSubs.run((l) => l(ctx))                       // ① 调用前：派发，订阅者在此注册钩子
    let ret
    try { ret = fn(...args) }                           // ② 真正执行
    catch (e) { fire(errCbs, e); throw e }              // 同步抛错 → 立刻派发出错并重抛
    if (ret instanceof Promise)                         // 异步返回值：在 settle 时再派发
      return ret.then((v) => (fire(afterCbs, v), v))
               .catch((e) => (fire(errCbs, e), Promise.reject(e)))
    fire(afterCbs, ret)                                 // 同步完成 → 立刻派发完成
    return ret
  }
}

// ── 机制 B：可订阅状态（Proxy 充当「深度监听器」）
function makeStore() {
  const stateSubs = makeSubs(), actionSubs = makeSubs()
  let listening = true                                  // 监听开关：补丁期间关闭
  const state = new Proxy({ count: 0 }, {
    set(t, k, v) {                                      // ← 等价于 Vue 的深度 watch
      t[k] = v
      if (listening) stateSubs.run((cb) => cb({ type: 'direct' }, state))
      return true
    },
  })
  return {
    state,
    $subscribe: (cb) => stateSubs.add(cb),
    $onAction: (cb) => actionSubs.add(cb),
    $patch: (v) => {
      listening = false                                 // 暂停监听，避免被误判为 direct
      state.count = v                                   // set 陷阱触发，但被开关拦下
      Promise.resolve().then(() => (listening = true))  // 下一个微任务才恢复
      stateSubs.run((cb) => cb({ type: 'patch', payload: v }, state)) // 手动派发：一次补丁=一个事件
    },
    increment: makeAction((n) => (state.count += n, n), 'increment', actionSubs),
    asyncDouble: makeAction(async (n) => { await Promise.resolve(); return n * 2 }, 'asyncDouble', actionSubs),
  }
}
```

**输入与输出轨迹**（运行上面这段，再执行下面的语句）：

```ts
const s = makeStore()

// 状态订阅：直接写与补丁写进同一回调，仅 type 不同
s.$subscribe((m, st) => console.log('[state]', m.type, '=', st.count))

// 动作订阅：在「调用前」注册一个「完成」钩子
s.$onAction((ctx) => {
  console.log('[action start]', ctx.name, ctx.args)
  ctx.after((v) => console.log('[action done]', ctx.name, '=>', v))
})

// ① 同步动作：动作内直接写 state，被监听器抓到；返回后立刻派发完成钩子
s.increment(5)
// [action start] increment [ 5 ]
// [state] direct = 5
// [action done] increment => 5

// ② 异步动作：返回 Promise 时，完成钩子在它 resolve 之后才触发（而非调用时）
const p = s.asyncDouble(5)
console.log('--- 已调用，但钩子尚未触发 ---')
await p
// [action start] asyncDouble [ 5 ]
// --- 已调用，但钩子尚未触发 ---
// [action done] asyncDouble => 10

// ③ 补丁：监听器被暂停、改由手动派发，一次补丁恰好只产一个事件
s.$patch(100)
// [state] patch = 100
```

把轨迹和第三节的心智模型对照着看：`increment` 走的是「同步完成 → 立刻派发」分支；`asyncDouble` 走的是「返回 Promise → then 里派发」分支；`$patch` 走的是「关监听 → 改 → 手动派发 → tick 后恢复」路径。注意 ② 里 `[action done]` 排在「已调用」之后——这正是异步钩子被推迟到 settle 时的体现。

## 五、关键权衡

> 每条权衡按「**选择了什么 → 换来什么 → 付出什么代价**」的结构看。

**权衡 1：双路径复用、一次补丁只产一个事件。**
选择了把「直接赋值」交给深度监听器自动抓、把「合并补丁」期间的监听器**暂停**并改由手动派发。换来的是：**无论状态怎么被改，订阅者都收到类型正确的事件**（`direct` / `patchObject` / `patchFunction`），而且**一次 `$patch` 恰好只产一个事件**——而不是逐属性触发多次、把一次逻辑变更打散成几十个回调。代价是必须维护「异步监听 / 同步监听」**两套**暂停-恢复标志：默认的 pre 监听要等到 `nextTick` 之后才恢复（因为 Vue 的 pre-flush watcher 在 nextTick 回调之前执行，必须延迟恢复才能让它在补丁期间看到 `false` 而跳过），同步监听则补丁末尾立即恢复；嵌套或同一 tick 内连续多次补丁时，还要用一个令牌去重——**只有最后一次补丁的恢复回调才真正把监听重新打开**，避免中途某次补丁提前恢复、使后续补丁被误判为 `direct` 二次触发。这套时序逻辑微妙，是这一层最容易踩坑的地方。

**权衡 2：动作包装器是唯一的挂载点。**
选择了在装配期把**每一个动作**都套一层包装并替换原属性（而非等到有人订阅时才装）。换来的是一个**统一的拦截点**：动作前后的钩子、devtools 的时间线归因、测试里的 spy，全都复用这同一个包装器，不必各自发明一套拦截机制。代价是**哪怕没有任何 `$onAction` 订阅者**，每次动作调用仍会分配两个回调集合、构造一个上下文对象、并对（可能为空的）动作订阅集合跑一次 `forEach`——空集合的 `forEach` 是空操作，但分配本身不可避免。此外还要用一个标记位防止对「已经包装过的动作」重复包装（HMR 热更新重新包装时尤其需要），只更新其内部的名字。

**权衡 3：前后钩子按调用实例化。**
选择了**每次动作调用都新建**一组「完成 / 出错」回调集合，随上下文对象传给订阅者去注册。换来的是：订阅者为「这一次调用」注册的钩子**天然隔离**——调用一结束，集合就随上下文一起丢弃，无需订阅者手动清理 per-call 的临时状态（例如「为这次请求计的时」）。代价是钩子集合的分配与「订阅者是否真的注册了钩子」**无关**——即便所有订阅者都没调 `after`/`onError`，那两个空集合照样每次都被创建。这与权衡 2 的代价同源：拦截点存在性优先于订阅者存在性。

**权衡 4：去重 + 作用域自动清理。**
选择了状态订阅**按回调引用去重**（同一个函数引用第二次订阅直接返回空操作、不重复建监听），以及所有订阅默认**随所在作用域自动卸载**、可用 `detached` 选项脱离。换来的是：同一回调不会被重复监听导致泄漏，组件内的订阅随组件卸载**自动回收**，无需手写 `onUnmounted`。代价是「按引用去重」在**跨组件复用同一个函数引用**时语义反直觉——第二次订阅静默变成空操作、不报错也不注册；若期望每个组件各自独立监听，必须用不同的函数引用（或显式 `detached` 自行管理卸载）。

## 六、与源码对照

上面从零实现的每条机制，都能在源码里找到一一对应（仅在此节给出位置，供需要时核对）：

| 演示里的机制 | 对应源码 |
|---|---|
| 机制 A：动作包装器——派发调用前、执行、完成/出错派发、Promise 的 then/catch | `packages/pinia/src/store.ts:382-413`（`action()` 内的 `triggerSubscriptions(actionSubscriptions, {...})` + `fn.apply` + `ret instanceof Promise ? then/catch : triggerSubscriptions(afterCallbackSet)`） |
| 机制 B：补丁暂停监听、手动派发、tick 后恢复、令牌去重 | `packages/pinia/src/store.ts:293-327`（`isListening = isSyncListening = false` → `activeListener = Symbol()` + `nextTick().then` 恢复 → `triggerSubscriptions(subscriptions, mutation, state)`） |
| 状态订阅的「同回调去重 + 监听开关门控」 | `packages/pinia/src/store.ts:441-466`（`if (subscriptions.has(callback)) return noop`，以及 watch 回调里 `options.flush === 'sync' ? isSyncListening : isListening` 的门控） |
| `$onAction` 直接绑定到动作订阅集合 | `packages/pinia/src/store.ts:435`（`$onAction: addSubscription.bind(null, actionSubscriptions)`，无 watch 参与） |
| 底层订阅原语：`Set.add` + 返回 `remove`、`forEach` 派发、作用域自动清理 | `packages/pinia/src/subscriptions.ts:6-33`（`addSubscription` / `triggerSubscriptions`） |

本章刻意省略的部分属其它章节：dev 模式下监听器带 `onTrigger`、把 Vue 的调试事件收集进 `mutation.events` 供 devtools 显示「改了哪个属性」（devtools 章）；动作包装器里 `this.$id === $id ? this : store` 的上下文守卫与 HMR 重新包装（HMR 章）；options / setup 两种形态的动作如何被遍历进装配循环（store-assembly 章）。它们都建立在「订阅原语 + 动作包装器」这两个本层原语之上。
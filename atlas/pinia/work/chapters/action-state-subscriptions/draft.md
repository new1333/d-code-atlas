# 订阅系统：$onAction 的动作包裹与 $subscribe 的监听协调

> 本章属于 composite 层。前置：Store 装配、状态变更模型、订阅原语。
> 学完你能讲清：Pinia 为什么用「两个监听开关 + 手动触发」协调 $subscribe 的 watcher 与 $patch，以及 $onAction 怎么把一次函数调用撑成一段生命周期事件。

## 1. 为什么需要它

设想你正在给一个 store 写一段旁路逻辑：每次 state 改了就 log 一条 `{storeId, type, payload}`，每次 action 被调了就统计一下耗时、失败时还要上报错误。你大概会伸手要两个钩子：一个「state 变了」、一个「action 调了」。

可真用起来你会发现：调一次 `store.$patch(s => { s.a = 1; s.b = 2 })` 应该只算一次改动，却被原生 watcher 当成多条通知；直接 `store.count++` 和 action 内部改 state 都是 watcher 拍到的、区分不出谁是谁；action 是普通函数，调完就结束、没地方挂钩 before/after/onError，async action 的 resolve/reject 更是没人通知你。

上一章把状态变更收拢到 $patch，用「暂停深度 watcher、改完手动发一条」换来「补丁只产一条通知」；留下的口子是：$subscribe 的 watcher 该怎么配合这套暂停-恢复、又怎么让直接改 state 仍能被正常通知。本章从订阅侧接住这个口子，再补上 action 的「before/after/onError」需求。

## 2. 核心思想

Vue 已经提供两类天然信号：「一次函数调用」（瞬时、调用栈一展开就消失）和「一次响应式变更」（由 watcher 代理、被 Vue 调度好）。订阅系统做的事，是把这两类信号**重新包装成带语义的事件**：函数调用被撑成「before/after/onError 的一段生命周期」，响应式变更被分流成「direct 或 patch 的带类型事件」，再交给同一个回调集合去广播。

落到具体工程上：用一个动作包裹器把每次调用撑成生命周期事件；用两个监听开关让 watcher 在 $patch 期间闭嘴、由 patch 自己手动补一条带类型的事件。两者共用同一对「回调集合」原语（第 2 章已讲透），本章只看它怎么被两类上层订阅消费。

## 3. 心智模型

两个东西同源：动作订阅与状态订阅都建在第 2 章那对最小原语 `addSubscription`/`triggerSubscriptions` 之上——一个往 Set 里加回调、一个对所有回调广播事件。差别只在于「事件从哪儿发出来」。

**动作订阅（$onAction）的链路**：

1. 装配时，setup 返回的每个 function 都被 `action(fn, name)` 包一层（第 4 章已交代），得到一个带 Symbol 标记的包裹函数。
2. 注册 `$onAction(cb, detached)` 就是把 cb 加进 `actionSubscriptions` 集合，按 detached 决定是否绑 effectScope（第 2 章已交代）。
3. 调用 action 时，包裹器为**这一次调用**新建两个临时 Set：`afterCallbackSet`、`onErrorCallbackSet`，把 `{ args, name, store, after, onError }` 作为事件广播给所有监听者——监听者收到 context 即相当于 before 时机。
4. 监听者在 context 里调 `after(cb)` 或 `onError(cb)`，把自己的钩子登记进**本次调用**的那两个 Set。
5. 包裹器随后真正调原 action：同步成功→触发 after；同步抛错→触发 onError 再抛出；返回 Promise→`.then(触发 after).catch(触发 onError)`。

**状态订阅（$subscribe）的链路**：

1. 装配末尾，把两个开关 `isListening`/`isSyncListening` 都置 true——之前的初始化赋值一律静音。
2. 注册 `$subscribe(cb, { detached, flush })` 先做回调去重（已注册过的回调直接返回 noop），再把 cb 加进 `subscriptions` 集合，并在 store 作用域里建一个监听根状态 `pinia.state.value[$id]` 的深度 watcher；订阅被移除时连带 stop 这个 watcher。
3. 改 state 的两条路径：
   - **直接改**（`store.count++`、`store.$state.x = ...`）：watcher 被 Vue 调度；handler 在 `flush:'sync'` 时查 `isSyncListening`，否则查 `isListening`——开着才调回调，事件类型标 `direct`。
   - **走 $patch**：上一章已交代，开头把两个开关置 false 静音 watcher，改完 state 后 `isSyncListening` 立即恢复、`isListening` 延迟到 nextTick 之后恢复；同时**手动**调一次 `triggerSubscriptions(subscriptions, ...)` 发**一条**事件，类型标 `patch object` 或 `patch function`。

两类订阅最后都落在「事件 + 当前 state」的回调签名上，差别只在事件的 type 字段——这让上层（devtools、插件）能区分变更来源。

## 4. 关键权衡

### 协调 watcher 与 $patch：两个开关加手动触发，换来不重复的一条通知

Vue 的 watcher 是「订阅 state 变更」最现成的工具，但它一旦挂上就什么变更都收——包括 $patch 改的。如果让 watcher 老老实实通知，再叠加 $patch 自己手动触发的那一条，订阅者会收到两条。最朴素的想法是在 watcher 里加个标志位「这次是 patch、别通知」，但 Vue 的 watcher 有三种 flush 时机：sync watcher 在改 state 时立即触发、pre/post watcher 把通知推迟到下一 tick 的 flush 队列。两类 watcher 处于完全不同的时间点，单开关盖不住。

Pinia 的选择是**用两个开关分别管两类 watcher**：`isSyncListening` 管 sync watcher、`isListening` 管 pre/post watcher。补丁开头同时关掉两个：sync watcher 在改 state 时立即触发、查开关为关而丢弃；pre/post watcher 进队列、到下一 tick flush 时查开关也为关而丢弃。改完后 `isSyncListening` 立即恢复（sync watcher 接下来该收还得收），`isListening` 推迟到 `nextTick().then()` 之后恢复，因为 pre/post watcher 的 flush 队列此刻还没跑完。这一延迟恢复就是为了让本次 flush 时开关仍为关，watcher 在 flush 时被静默丢弃；同时由 $patch 手动 `triggerSubscriptions` 发**唯一一条**带 `patch` 类型的事件。

**换来**：直接改 state 和打补丁两条路径，订阅者都只收到一条、且绝不重复（watcher 的自动通知与手动通知不会叠加）。

**代价**：引入了与 Vue 调度时序强耦合的两个布尔开关、一个 nextTick 延迟恢复、外加一个「最后者胜」的去抖标记（`activeListener = Symbol()`，防止连续多次补丁里前一次的恢复过早打开开关）。这些时序极其微妙、几乎无法靠直觉推理，issue #1129 就是它踩出来的坑。

**背后化解的本质矛盾**：「响应式系统的通知是 Vue 调度好的、不在你手里」与「批处理路径想要自己掌控通知时机与去重」之间的张力。任何「在框架的响应式通知之上叠加一层批处理」的设计都会撞上这个矛盾——React 的并发模式里批处理与 effect 调度的拉扯、Redux middleware 里 dispatch 拦截与 store subscriber 的协调，本质都一样：自动通知与手动通知要谁让位、要在什么时机让位、让多久。

### 调用期临时钩子集合：把瞬时函数调用撑成可观测的生命周期

action 是普通函数，调用即执行、调完即结束。如果想让外部订阅者在「函数开始前」「函数成功后」「函数抛错时」三个时机挂钩、且还要支持 async action 的 resolve/reject，最朴素的 API 设计是给 action 加三个 callback 参数——但每个 action 调用都得写一遍、订阅者要复用还得自己提。Pinia 的办法是：在包裹器里，为**每次调用**新建两个临时 Set（`afterCallbackSet`、`onErrorCallbackSet`），把它们封进 `after`/`onError` 注册器，连同 args/name/store 一起作为事件发给动作订阅者。订阅者在自己的回调里要不要登记钩子、登记几个，完全自由——「context 到达」本身就等于 before 时机，订阅者想干什么就在那儿干；随后包裹器按结果分派：同步成功触发 after、同步抛错触发 onError 再 throw、返回 Promise 则 `.then(触发 after).catch(触发 onError)`。

**换来**：订阅者一次注册就能拿到 before/after/onError 三个时机、并自动感知 Promise 的 resolve 与 reject。同一份订阅代码对同步 action、抛错 action、async action 都生效，不需要订阅者区分。

**代价**：每个 action 都被包一层闭包，每次调用都要新建两个临时 Set、走一次 `triggerSubscriptions` 派发 context——频繁调用的 action 有固定开销；钩子集合是「调用期」的，不同调用之间互不可见（订阅者要在多次调用间共享状态，得自己在闭包里维护）。

**背后化解的本质矛盾**：「函数调用是瞬时的、调用栈一展开就消失」与「订阅者要在多个时机挂钩、还要支持异步」之间的张力。这类「把瞬态信号重组成结构化事件」的升级别处也有：Promise 把「一次性回调」重组为「可链式调用的异步管线」、RxJS 把「事件流」重组为「可组合的操作符链」。

### 两类订阅共用同一对最小原语：换来对称的注册/移除/作用域清理

动作订阅与状态订阅都落在 `addSubscription`/`triggerSubscriptions` 上——同一个「往 Set 加回调并返回移除函数、默认绑 onScopeDispose」的注册路径，同一个「对集合里所有回调广播事件」的派发路径。这意味着两类订阅的作用域自动清理、detached 退出、回调签名稳定性、移除语义完全一致，使用者的心智模型只需一份。

**换来**：API 行为的对称与可预测，且代码量也省了一份——一套原语支撑两条业务路径。

**代价**：类型层面与内部结构层面都不对称。动作订阅的事件是个对象（`{ args, name, store, after, onError }`），但原语的类型约束是 `T extends _Method`（接收函数），不匹配，store.ts 在派发处用 `@ts-expect-error` 绕过；types 层还要用条件类型把「多个具名 action」映射成各自的 context 联合。状态订阅则更重：除了用原语注册回调，还要**额外**在 store 作用域里挂一个深度 watcher，并把「停 watcher」塞进原语的 `onCleanup` 回调里——两条订阅路径的内部复杂度并不对称。

**背后化解的本质矛盾**：「想用一套原语统一所有订阅形态」与「两类订阅底层信号源完全不同（一个是函数调用、一个是响应式变更）」之间的张力。共用原语换来了 API 层面的统一与代码量的减少，但代价是「内部复杂性」被压进了实现细节里——使用者看到一个对称的 API，但维护者要为这个对称搭一层不对称的桥。

### 状态订阅做回调去重、动作订阅不做：一条不对称的边界

`$subscribe` 在注册前先做 `subscriptions.has(callback)` 检查，同一个回调被多次注册时直接返回 noop、不建 watcher（issue #3143 的修复）。原因是 watcher 是有副作用的资源：多建一个就多一份开销、还会被多次通知，重复注册明显是 bug。`$onAction` 没做这个去重，同一个监听者可以被多次加进 `actionSubscriptions` 集合、被多次通知。

**换来**：状态订阅避免了重复 watcher 的资源浪费与重复通知；动作订阅保留了「同一监听者可在不同地方分别挂钩」的灵活性。

**代价**：两个订阅 API 在去重策略上不对称，使用者需知晓——尤其是写插件时，可能一不小心把同一个动作监听者注册了好几遍。

**背后化解的本质矛盾**：「订阅资源有副作用（建 watcher）」与「订阅资源是纯回调（加进 Set）」之间的张力。前者重复就是 bug、后者重复可能是有意，把这两类统一处理反而会丢失语义。

## 5. 最小原理演示

下面这段几十行的脚本演两件事：第一，「两个开关 + 手动触发」让直接改与补丁都只产生一条通知、互不重复；第二，action 包裹器用调用期临时集合暴露 after/onError 并感知 Promise。每一行都对应上面某个原理点。

```ts
import { reactive, watch, nextTick } from 'vue'

// 共享原语：回调集合
function addSubscription(set, cb, onCleanup = () => {}) {
  set.add(cb)
  return () => { if (set.delete(cb)) onCleanup() }
}
function triggerSubscriptions(set, ...args) {
  set.forEach(cb => cb(...args))
}

function createStore() {
  const state = reactive({ count: 0 })
  const subs = new Set()           // 状态订阅回调集合
  const actionSubs = new Set()     // 动作订阅回调集合
  let isListening = true           // 异步 watcher 的开关
  let isSyncListening = true       // 同步 watcher 的开关
  let activeListener               // 最后者胜的去抖标记

  // 动作包裹器：把每次调用撑成带 before/after/onError 的生命周期
  function wrapAction(fn, name) {
    return function wrapped(...args) {
      const afterSet = new Set()
      const onErrorSet = new Set()
      const after = cb => afterSet.add(cb)
      const onError = cb => onErrorSet.add(cb)
      triggerSubscriptions(actionSubs, { args, name, store, after, onError })
      let ret
      try { ret = fn.apply(store, args) }
      catch (e) {
        triggerSubscriptions(onErrorSet, e); throw e
      }
      if (ret instanceof Promise) {
        return ret
          .then(v => { triggerSubscriptions(afterSet, v); return v })
          .catch(e => { triggerSubscriptions(onErrorSet, e); return Promise.reject(e) })
      }
      triggerSubscriptions(afterSet, ret)
      return ret
    }
  }

  const store = {
    state,
    $onAction(cb) { return addSubscription(actionSubs, cb) },
    $subscribe(cb, opts = {}) {
      if (subs.has(cb)) return () => {}            // 状态订阅做回调去重
      const remove = addSubscription(subs, cb, () => stopWatcher())
      const stopWatcher = watch(
        () => state,
        s => {
          // watcher handler 里的开关判断：开关关着就不通知
          if (opts.flush === 'sync' ? isSyncListening : isListening)
            cb({ type: 'direct' }, s)
        },
        { deep: true, flush: opts.flush || 'pre' }
      )
      return remove
    },
    $patch(mutator) {
      // 关掉两类 watcher，避免与手动触发叠加
      isListening = false
      isSyncListening = false
      mutator(state)
      // 最后者胜的去抖：只有最后一次补丁的 nextTick 才恢复异步开关
      const myId = (activeListener = Symbol())
      nextTick().then(() => {
        if (activeListener === myId) isListening = true
      })
      // 同步开关立即恢复：sync watcher 接下来该收还得收
      isSyncListening = true
      // 手动发唯一一条带类型的事件
      triggerSubscriptions(subs, { type: 'patch function' }, state)
    },
    fail: wrapAction(() => { throw new Error('boom') }, 'fail'),
    asyncInc: wrapAction(() => new Promise(r => setTimeout(() => r(5), 10)), 'asyncInc'),
  }
  return store
}

const store = createStore()
const log = []
const flush = () => new Promise(r => setTimeout(r, 0))

store.$subscribe(e => log.push(`state ${e.type} count=${store.state.count}`))
store.$onAction(ctx => {
  log.push(`before ${ctx.name}`)
  ctx.after(v => log.push(`after ${ctx.name}${v != null ? `=${v}` : ''}`))
  ctx.onError(e => log.push(`error ${ctx.name}: ${e.message}`))
})

store.state.count++            // 直接改：watcher 下一 tick flush 查开关开着 → 一条 direct
await flush()
await store.$patch(s => { s.count++; s.count++ })  // 补丁：两开关置关、手动发一条 patch、watcher flush 时被静默
await flush()
try { store.fail() } catch {}  // 同步抛错：触发 onError、错误继续抛
await store.asyncInc()         // async action：before→resolve 后 after
console.log(log)
// =>
// [ 'state direct count=1',
//   'state patch function count=3',
//   'before fail', 'error fail: boom',
//   'before asyncInc', 'after asyncInc=5' ]
```

## 6. 执行轨迹

拿演示里四种输入当慢动作看一遍：

**输入** `store.state.count++`（直接改）。Vue 立即把深度 watcher 排进 pre flush 队列；下一微任务 flush 时，handler 进入查开关：`opts.flush` 默认 `pre`、查 `isListening`——此刻为 true，回调收到 `{ type: 'direct' }`、state 为 `{ count: 1 }`。**一条**通知。

**输入** `store.$patch(s => { s.count++; s.count++ })`。$patch 进入立刻把两个开关置 false，然后跑 mutator，state.count 被改两次，watcher 在 Vue 内部被调度但还没 flush。$patch 接着记一个 `myId = Symbol()` 作为 `activeListener` 的当前值，把 `isSyncListening` 立即恢复为 true、把 `isListening` 的恢复排到 `nextTick().then()` 里；最后**手动**调 `triggerSubscriptions(subs, { type: 'patch function' }, state)`，订阅者立刻收到**一条** `patch function` 事件、state 已经是 `{ count: 3 }`。等到 Vue 真的 flush 它的 watcher 队列时，handler 进入查 `isListening`，此刻仍是 false（要等 nextTick 之后才恢复），watcher 通知被静默丢弃。结果：**一条**通知，watcher 没叠。

**输入** `await store.asyncInc()`（async action）。包裹器先建临时 Set、广播 context 给动作订阅者：监听者收到 `{ name: 'asyncInc', args: [], after, onError }`、登记一个 after 钩子进临时 Set、顺手 log 下「before」。接着真正调原 action，拿到一个 Promise（10ms 后才 resolve）。包裹器 `.then(触发 after).catch(触发 onError)` 后返回。Promise resolve 时，afterSet 被触发，监听者的钩子被调用、log 下「after」。

**输入** `store.fail()`（同步抛错）。包裹器广播 context（before 已到达），进入 try 跑原 action，立刻抛错。catch 块触发 `onErrorSet`（监听者的 onError 钩子被调用、log 下「error」），然后 `throw error` 把错误继续抛出去，调用方拿到原始错误。

**注意**：action 内部若改了 state，那条改动会走 direct 路径、单独发一条 `direct` 通知——因为 action 包裹器不暂停 watcher、它只负责派发 before/after/onError。这与 $patch「暂停 watcher、手动发一条」是两套机制，刚好对应「直接改 vs 打补丁」两条路径。

## 7. 教学简化说明

本章演示故意省略了：`detached` 与 `onScopeDispose` 的作用域自动清理（第 2 章已展开）、`mergeReactiveObjects` 的对象式补丁深合并（第 5 章已展开）、dev 下 watcher 的 `onTrigger` 钩子收集 `debuggerEvents` 供 devtools 分组展示、HMR 复用同一对开关短暂静音再恢复、`$dispose` 靠停 effectScope 连带停掉所有 watcher 与订阅、两个 Symbol（动作标记 / 动作名）防止 action 被二次包裹的机制、types 层为兼容两种语法对动作监听者 context 做的条件类型映射。这些不影响核心思想，本章只演两件事：把瞬时调用撑成生命周期事件、用两个开关协调 watcher 与 patch。

## 8. 小结

订阅系统暴露的是「信号重组」：把瞬时函数调用撑成生命周期、把响应式变更分流成带来源标记的事件。这种重组的代价是要操心 Vue 调度的每一个微任务边界：两个开关、一个 nextTick 延迟、一个去抖标记，都是为了让 Vue 自动派的通知与 Pinia 自己手动派的通知不打架。下一章换个面向——从作者语法看进来，Options Store 与 Setup Store 看似是两种写法，最后都汇入同一条装配路径。
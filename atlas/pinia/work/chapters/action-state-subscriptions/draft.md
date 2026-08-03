# 订阅系统：$onAction 的动作包裹与 $subscribe 的监听协调

想象你在给一个线上应用做埋点。需求听起来简单：每次用户触发某个动作（加购、下单、登出），你都要在它"开始前"和"结束后"各记一条日志；万一中途抛错，还得单独记一条失败日志。与此同时，你还想盯着整份状态——不管是谁、用什么方式改了它（直接赋值也好、批量更新也好、某个动作内部顺手改的也好），都希望收到一条带着"这次改动是哪种来源"的通知。

真做起来你会发现到处是坑。动作的"前后"要怎么挂钩？异步动作（返回 Promise）的"结束"要等到什么时候？状态被改的方式五花八门，怎么把它们做成"一条不重复的通知"？更烦的是：动作内部如果直接改了状态，那"动作通知"和"状态通知"会不会重复报两次？

这一章就拆解 Pinia 是怎么把这两件事做成一套统一、可控、不重复的通知系统的。底层只有一对最小的工具，往上搭出两类订阅，再靠两个看起来很不起眼的布尔开关，把所有时序矛盾摆平。

## 两类订阅，共用同一对最小工具

先说最底下那块。第 2 章已经把这对工具讲透了（章节「订阅原语」）：一个装回调的集合、一个"加入"函数、一个"逐个触发"函数。订阅就是往集合里塞一个回调、再拿回一个能把自己摘掉的函数；触发就是遍历集合把回调挨个调一遍。生命周期默认跟着当前作用域走，作用域没了订阅自动清掉——这套第 2 章已定，本章不再重演。

这一章要看的新东西是：**这对工具怎么被两类长得完全不一样的上层订阅消费**。

- 一类是**动作订阅**（`$onAction`）：它关心的不是状态，而是"某个函数被调用了"。它直接拿这对工具用——注册即往动作回调集合里加回调，几乎零加工。
- 另一类是**状态订阅**（`$subscribe`）：它关心的是"状态被改了"。它不能光靠这对工具，还得在旁边另挂一只 Vue 的深度 watcher 盯着状态，watcher 一响，再去调集合里的回调。

流程上两类订阅的注册/移除长得几乎一样（都是"加回调 → 返回移除函数 → 作用域自动清理"），但内部干的事完全不同：动作订阅是纯转发，状态订阅是"watcher + 回调集合"的组合体。这个不对称后面会反复出现。

> **关键权衡 · 两类订阅共用同一对工具**
> 选择：动作订阅和状态订阅都建在第 2 章那对"加回调 / 触发"工具之上，注册、移除、作用域自动清理的行为完全一致。
> 换来：两类订阅的用法和生命周期管理高度统一，使用者学一套即可；插件、devtools 也能用同一套方式对待它们。
> 代价：两类订阅的内部其实并不对称——动作订阅是纯转发，状态订阅还得在工具之外额外挂一只深度 watcher、并把"停 watcher"塞进工具的清理回调。这份不对称的复杂度全压在状态订阅一侧。

## 动作订阅：把一次函数调用重组成一个生命周期事件

你想在每次 action 调用前后挂钩，最朴素的办法是让 action 自己在开头和结尾调一下"通知所有人"——但 action 是用户写的业务代码，不能逼用户手写通知。所以 Pinia 在装配时给每个 function 都套了一层**包裹器**（第 4 章讲过装配时怎么包，这里只看它对订阅暴露了什么）。

这个包裹器的妙处在于：它不是给 action 挂一个全局的"前后钩子"，而是**每次调用都临时搭一个一次性舞台**。看这段从零写的最小版：

```ts
function wrap(fn, name) {
  return (...args) => {
    // 每次调用都新建一对临时集合——只对"这一次调用"生效
    const afterSet = new Set(), errSet = new Set()
    trigger(actionSubs, {
      name, args,
      after: (cb) => afterSet.add(cb),      // 监听者用这俩函数登记钩子
      onError: (cb) => errSet.add(cb),
    })                                       // 监听者收到 context = before 时机
    let ret
    try { ret = fn(...args) }
    catch (e) { trigger(errSet, e); throw e } // 同步抛错 → onError，再原样抛出
    if (ret instanceof Promise)
      return ret
        .then((v) => { trigger(afterSet, v); return v })
        .catch((e) => { trigger(errSet, e); throw e }) // Promise reject → onError
    trigger(afterSet, ret)                    // 同步成功 → after
    return ret
  }
}
```

关键看那对 `afterSet` / `errSet`：它们是**这次调用**的局部变量，调用结束就丢。监听者在收到的 context 里调 `ctx.after(cb)` / `ctx.onError(cb)`，等于把自己的钩子登记进这次调用的临时集合。所以"到达 context"天然就是 before 时机；调用成功，临时 after 集合被触发；调用抛错，临时 onError 集合被触发；返回的是 Promise，就等它 resolve 再触发 after、reject 则触发 onError。

把它跑起来：

```ts
$onAction((ctx) => {
  console.log('[action] before', ctx.name)
  ctx.after((v) => console.log('[action] after', ctx.name, v))
  ctx.onError((e) => console.log('[action] onError', ctx.name, e.message))
})

const boom = wrap(() => { throw new Error('boom') }, 'boom')
try { boom() } catch (e) { console.log('[caller] caught', e.message) }
// [action] before boom
// [action] onError boom boom
// [caller] caught boom

const task = wrap(() => new Promise((r) => setTimeout(() => r('ok'), 10)), 'task')
console.log(await task())
// [action] before task
// [action] after task ok
// ok
```

同步抛错走 `try/catch` 那条路：onError 先触发，错误再原样抛给调用方（所以 `[caller] caught`）。异步走 Promise 那条路：before 在调用时立刻发出，after 要等到 resolve 才发。一次注册，三个时机全拿到，还自动适配了 async/await。

> **关键权衡 · 调用期临时钩子集合**
> 选择：每次调用 action 都新建一对临时的 after/onError 集合，而不是用一个全局钩子列表。
> 换来：订阅者注册一次，就能拿到 before / after / onError 三个时机，并自动感知 Promise 的 resolve 与 reject——无需订阅者自己分辨同步还是异步。
> 代价：每个 action 都被套一层闭包，而且**每次调用**都要新建两个集合、触发一次动作订阅。一个被高频调用的 action（比如拖拽里每帧都调）会背上这份固定开销；钩子也只对当次调用可见，跨调用要累积状态得订阅者自己在闭包里维护。

## 状态订阅：一只深度 watcher，加两个监听开关

再看状态订阅。`$subscribe` 想要的是"状态被以任何方式改动，我都收到通知"。这个需求天然适合 Vue 的深度 watcher——对着整份状态 `watch(() => state, cb, { deep: true })`，谁动了都响。

但 Pinia 没有直接把回调塞进 watcher 就完事。它干了一件额外的事：**watcher 的处理器不是无条件调回调，而是先抬头看一眼一个叫"监听开关"的布尔值，开着才通知。**

```ts
function $subscribe(cb, flush = 'pre') {
  if (subs.has(cb)) return () => {}                 // 去重：同一回调只挂一只 watcher
  return watch(
    () => state,
    (s) => {
      if (flush === 'sync' ? isSyncListening : isListening)  // 先看开关
        cb({ type: 'direct' }, s)
    },
    { deep: true, flush },
  )
}
```

为什么 watcher 触发了还要再看一个开关？因为"改状态"在 Pinia 里有两条路（第 5 章讲透了）：直接赋值 `store.count++`，和打补丁 `store.$patch(...)`。第 5 章的关键决定是：打补丁时先把 watcher 静音、改完再手动统一触发一次订阅，把一整批改动收拢成单条通知。这一章要回答的是订阅侧的追问——**watcher 被"静音"到底是怎么静音的？凭什么直接改和打补丁不会重复通知？** 答案就藏在那两个开关里。

## 核心：为什么是两个开关，不是一个

这是本章最该停下来想清楚的地方。

打补丁时要让 watcher 闭嘴，最直白的做法是补丁期间设一个 `paused = true`，处理器里 `if (!paused) 通知`，补丁结束再 `paused = false`。一个开关听起来就够了，为什么 Pinia 用了两个——`isListening` 和 `isSyncListening`？

因为 Vue 的 watcher 是有"脾气"的，分两种触发时机：

- **同步脾气**（`flush: 'sync'`）：状态一被改，处理器**当场、同步**就跑。
- **异步脾气**（`flush: 'pre'`，也是默认）：状态被改后，处理器只被**排队**，等到下一个微任务（`nextTick`）才真正跑。

这两类脾气的"静音窗口"落在完全不同的时间点上：

- 同步 watcher 在补丁**改状态的那一瞬间**就触发。所以你必须在"改之前"关掉开关，**改完立刻**打开——否则紧接着补丁之后的下一次同步改动也会被误伤。
- 异步 watcher 在补丁结束、**下一个 tick 的 flush** 时才触发。所以你必须让开关在"整个本次 flush 期间"都保持关闭，也就是**推迟到 `nextTick` 之后**才能打开——否则本次 flush 跑到处理器时开关已经开了，direct 通知漏出来，跟手动触发的那条 patch 撞成两条。

换句话说，同步开关要快、异步开关要慢，一个开关没法同时又快又慢。于是拆成两个：同步开关管同步 watcher、改完立即恢复；异步开关管异步 watcher、推迟到 `nextTick` 恢复。补丁的完整时序是：

```
$patch 开始
  → isListening = isSyncListening = false       关掉两个开关
  → 改状态（同步 watcher 当场触发，但开关关着 → 丢弃；
            异步 watcher 被排队，但还没 flush）
  → nextTick().then(() => isListening = true)    异步开关：排队等下个 tick 恢复
  → isSyncListening = true                       同步开关：立刻恢复
  → trigger(subs, { type: 'patch' })             手动发一条（唯一的通知）
$patch 结束
……下一个 tick……
  → 异步 watcher 的 flush 跑到处理器，isListening 仍是 false → 丢弃
  → 然后才轮到 nextTick 的回调，把 isListening 恢复成 true
```

注意最后这段顺序的微妙之处：手动触发的那条 patch 在补丁里**同步**就发出去了；而被排队的异步 watcher 要等到 flush，可 flush 跑处理器时异步开关还没恢复（恢复它的 `nextTick().then` 排在 flush **之后**）。所以异步 watcher 这次必然被丢弃——这就是"只发一条"能成立的时序根基。这段几乎没法靠直觉推，得照着微任务调度一步步走。

把它和"直接改"放一起跑，两个开关各被一只脾气的 watcher 实际卡住：

```ts
$subscribe((m) => console.log('[state:async]', m.type))            // 异步脾气
$subscribe((m) => console.log('[state:sync]', m.type), 'sync')     // 同步脾气

// ① 直接改：两个开关都开着，两只 watcher 各发一条 direct
state.count++
await nextTick()
// [state:sync] direct      ← 同步 watcher 改的瞬间当场触发
// [state:async] direct     ← 异步 watcher 下个 tick flush 时触发

// ② 打补丁：两个开关都关，两只 watcher 全被静音，只剩手动触发
$patch((s) => { s.count++; s.name = 'b' })
await nextTick()
// [state:async] patch function   ← 手动触发
// [state:sync]  patch function   ← 手动触发
// （此期间两只 watcher 都被各自开关卡住，零 direct）
```

① 里两条改动（`count++` 和 `name='b'`）被补丁合并成一条 patch，两只 watcher 的 direct 全被吞掉；直接改则各发一条 direct——两类改动互不重复、各走各的通知类型。

> **关键权衡 · 两个监听开关 + 手动触发**（本章核心）
> 选择：用 `isListening` / `isSyncListening` 两个布尔开关分别管住异步、同步两类脾气的 watcher，补丁期间关掉、改完按各自脾气恢复（同步立即、异步推迟到 `nextTick`），再手动触发一次订阅。
> 换来：无论状态是被直接赋值改的、还是被 `$patch` 批量改的，订阅者都只收到**一条**通知，watcher 的自动通知和手动通知**绝不会叠加成两条**；两类脾气的订阅者都被正确照顾到。
> 代价：时序与 Vue 的微任务调度**强耦合**，几乎无法靠直觉推理——得知道 `flushJobs` 跑在 `nextTick().then` 之前，才能解释"为什么异步 watcher 必然被丢"。还要额外引入一个"最后者胜"的去抖记号：连续多次补丁时，只有最后一次补丁的 `nextTick` 才有资格恢复异步开关，避免前面的补丁过早把开关打开。这套机制脆弱但精确，是"通知不重复"这条硬要求的必然代价。

## 三种通知来源，与一个不对称的去重策略

上面已经出现了 `direct` 和 `patch function` 两种通知类型。Pinia 把状态变更的来源标成三类，好让订阅者一眼分清这次改动从哪来：

- `direct`：watcher 直接捕获到的赋值（`store.count++` 这种）——也包括 action 内部直接改 state 的情况，因为那同样没走 `$patch`、不会被静音。
- `patch function`：函数式补丁（`$patch(s => { ... })`）手动触发的。
- `patch object`：对象式补丁（`$patch({ count: 1 })`）手动触发的。

这三类标签让 devtools、插件、业务层都能稳定判断"谁、什么时候、用什么方式改了状态"——正是一开始那个埋点场景最想要的东西。顺带也就回答了开头的悬念：动作通知和状态通知是**两个维度**各报一次（一个是"函数被调了"，一个是"状态被改了"），不算重复；只有当同一个维度里 watcher 和手动触发同时发声时，才需要这两个开关去消掉。

最后还有一个容易被忽略的不对称：**状态订阅会去重，动作订阅不会**。状态订阅注册时先查 `subs.has(cb)`，同一个回调注册第二次直接返回空操作、不建第二只 watcher（否则一只回调被多只 watcher 盯着，一次改动收 N 条）；动作订阅没这道检查，同一个监听者可以被加进集合多次、从而被通知多次。

> **关键权衡 · 去重策略的不对称**
> 选择：状态订阅做回调去重（同一回调只挂一只 watcher），动作订阅不做去重。
> 换来：状态订阅不会因为重复注册而建出多只深度 watcher 重复通知（深度 watcher 建多了是实打实的性能和正确性问题）；动作订阅则保留了"同一监听者多次注册就被多次通知"的简单语义。
> 代价：两个订阅 API 的去重行为不一致，是一个使用者必须知晓的边界——拿同一个回调调两次 `$subscribe` 和调两次 `$onAction`，效果不一样。

## 小结

这一章把"函数调用"和"状态变更"这两种原本各说各话的事，做成了一套统一的通知系统。底层是第 2 章那对最小工具；往上，动作订阅靠一个**每次调用临时搭台**的包裹器，把一次调用重组成 before / after / onError 三个时机并自动适配 Promise；状态订阅靠一只深度 watcher 盯住状态，再用**两个脾气的开关**（同步立即恢复、异步推迟到 `nextTick` 恢复）配合补丁的手动触发，保证直接改和打补丁都只通知一次、绝不重复。最费脑的不是"怎么通知"，而是"凭什么不重复"——那两个开关和一段微妙的微任务时序，是整套设计的命门。

到这里，setup 语法下 store 的状态、动作、订阅三套机制都已就位。下一章会看到，Pinia 的另一种写法——Options Store（`state/getters/actions` 选项式）——并没有另起炉灶，而是把自己拼成一个 setup 函数，转交给本章和前几章铺好的同一条装配路径。
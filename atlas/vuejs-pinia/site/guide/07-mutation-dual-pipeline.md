---
title: 状态变更的双管道：动作拦截与批量合并
---

# 状态变更的双管道：动作拦截与批量合并

> 本章属于 composite 层。前置：Setup Store 的运行时自动分流、随作用域清理的发布订阅。
> 学完你能：用一句话讲清「为什么改状态要分两条管道，每条管道各自做了什么取舍」。

## 1. 为什么需要它

上一章把 Options Store 的 `state/getters/actions` 三分翻译成等价的 setup 返回值，复用同一组装引擎把 store 装了出来。可 store 装好之后，里面的状态到底怎么被改、改了又怎么通知出去，组装引擎并没插手——这正是本章要接的口子。

一个状态库几乎一定会被两种截然不同的方式修改。

第一种是「直接改」：在一个动作函数里逐行写状态，或者干脆从外面 `store.count = 2` 这样赋值。这种写法的诉求是**细粒度**——每一次写都对应一次真实的状态变化，监听者就该被通知一次。

第二种是「成批改」：一次性塞一片对象进来，比如 `$patch({ name: 'b', age: 2, count: 9 })`，三个字段一起更新。这种写法的诉求正好相反，是**粗粒度**——调用者的本意是「这是一次逻辑上的更新」，希望监听者只被打扰一次，而不是连着收到三条通知、还在中间看到 `name` 改了但 `age` 还没改的半截状态。

如果这两种写法都裸交给底层的响应式系统，第二种就会出问题：一次补丁动了三个字段，深度监听器就触发三次，监听者既被反复打扰，又瞥见了中间态。更要紧的是，动作还常常需要被观测「开始 / 成功 / 失败」的整个生命周期——比如打日志、做埋点、出错了回滚——而光盯状态变化是盯不出来的，因为状态变化只能告诉你「值变了」，告诉不了你「这是哪个动作干的、干完了没、有没有抛错」。

于是有了两条管道。

## 2. 核心思想

改状态有两条互不干扰的路。**动作管道**在「改」的前后插桩观测——记录动作的开始、成功、失败，但它不去碰通知的合并，动作里的每一次直接写照样逐次通知。**补丁管道**反其道而行——干脆把自动监听临时关掉，自己把一整批改动揉成一次，最后手动只喊一声。

说得更原理一点：这两条管道的本质，是把「通知的节奏」从响应式系统那种「自动、逐次、即时」的默认行为里**拿回来**，交到调用方手里。你想要逐次、想要观测生命周期，就走动作管道；你想要合并成一次、不想让人看到中间态，就走补丁管道。响应式系统不再独占「怎么通知」的决定权。

## 3. 心智模型

先认下四样东西，它们是两条管道共用的地基。

**两套订阅池**。一个 Set 装状态订阅（`$subscribe` 注册的回调，关心「状态变了」），另一个 Set 装动作订阅（`$onAction` 注册的回调，关心「动作的生命周期」）。两套池子都站在第 1 章搭的那套「Set + 遍历触发 + 作用域自动回收」原语上——注册、触发、随作用域清理的细节第 1 章已经讲透，本章只把它当通知底座用，不再重述。

**两个监听开关**。`isListening` 管「异步档」（默认的、会被 Vue 排到微任务里的那种监听），`isSyncListening` 管「同步档」（写成 `flush: 'sync'`、状态一变立刻触发的那种）。一个挂在集中状态树本分支上的深度监听器（`watch(deep)`）负责捕获所有「直接写」，回调里按订阅者声明的档位挑对应的开关，决定这次要不要真的喊它——类型统一标成 `direct`。

**深合并**。补丁管道收到一片对象后，按 key 逐个落到状态树上：遇到 Map 用 `set`、Set 用 `add`；双方都是普通对象就递归往下合并；一旦补丁值是 ref 或 reactive（或两边类型对不上），就整体替换、不往里钻。

**一个令牌**。一个叫 `activeListener` 的 Symbol 变量，专门用来在同回合多次补丁时保证「只有最后一次才恢复监听」。

有了这四样东西，两条管道的流程就清楚了。

**动作管道**走四步：包裹层先往动作订阅池发一个「前置事件」（带上参数、名字、store，以及两个注册器 `after` / `onError`）；接着执行真正的动作函数，函数体里的每一次直接写都被那个深度监听器捕获，以 `direct` 类型逐次发状态订阅；函数同步返回后发 `after`，同步抛错则发 `onError`；如果返回的是 Promise，就改成 `then` 里发 `after`、`catch` 里发 `onError`。这套前后插桩能成立，前提是第 5 章的组装引擎已经把函数属性识别成动作并交给了这个包裹器——识别与分类第 5 章讲过了，本章只看包裹器在前后做了什么。

**补丁管道**走五步：先把两个监听开关都关掉，让接下来的一连串写全部「静默」；然后做合并（函数式补丁直接对 state 跑函数，对象式补丁走上面的深合并）；合并完，手动往状态订阅池塞一个事件（类型标 `patchObject` 或 `patchFunction`），这是这一整批修改的唯一一次通知；接着用令牌预约「下一个微任务回合才恢复异步监听」，保证同回合里连续多次补丁只恢复一次；同步监听则合并一完就立刻恢复。

## 4. 关键权衡

### 补丁管道：关掉自动监听，合并完手动只喊一声

补丁管道做了一个很果断的选择：**进入补丁时主动关掉深度监听，让这一批写全部静默，合并完再由自己手动补发一次通知。**

换来的是「成批修改只产生一次订阅」。监听者既不会被一补丁里的 N 个字段反复打扰，也看不到中间半截状态，性能也更好——整库重置 `$reset` 内部就是套了这层补丁，把几十个字段的回写归并成一次通知。这条权衡化解的本质矛盾，是**响应式监听的「自动、逐次、即时」与批量修改想要的「手动、合并、延后」天然打架**。响应式系统的默认行为是为「逐次直接写」设计的，你只要写它就喊；可批量场景要的恰恰是「写的时候别喊，等我全写完再一起喊」。补丁管道用「暂停自动 + 手动补一次 + 延后恢复」把这两种节奏缝到了一起。一旦你看懂这个本质矛盾，在任何框架里遇到「要批量改一堆响应式东西又不想被通知轰炸」时，都会认出同一副骨架。

代价是真实的，而且不止一层。第一，你必须自己管控监听开关的关 / 开时机，关早了漏通知、关晚了没效果。第二，异步监听不能合并完立刻恢复——因为默认档的回调是被 Vue 排进微任务队列的，立刻恢复会让本次合并触发的那次排队回调照样冒出来，前功尽弃；所以恢复必须再延后一个微任务。第三，同回合里可能连续好几次补丁，每次都排一个「延后恢复」，必须保证只有最后一次真正生效——这就要靠那个令牌：每次补丁把 `activeListener` 设成一个新的 Symbol，微任务里只有「当前 `activeListener` 仍然等于自己」的那次才恢复监听。这套「关 → 合并 → 手动发 → 微任务令牌恢复」是一份隐晦的时序协议，读代码的人必须理解为什么是微任务恢复、为什么要令牌比较，心智负担不轻。

### 动作管道：把成功 / 失败回调做成注册器，交给监听器自己挂

动作包裹层没有选择「直接调用监听器通知结果」，而是做了一个有点绕的设计：在前置事件里塞进两个**注册器** `after` 和 `onError`，把这两个注册器交到监听器手里，让监听器自己在回调里登记「动作成功时干啥、失败时干啥」，等动作真正跑完，包裹层再统一触发这两个集合。

换来的是「同一套写法就能观测同步动作和异步动作」。不管动作是当场返回一个值，还是返回一个 Promise，监听器都不用区分——成功就走 `after`，抛错或 Promise reject 就走 `onError`，而且能拿到返回值或错误对象。这条权衡化解的本质矛盾，是**「通知时机」和「结果可用时机」的错位**：订阅回调在动作「开始时」就必须被通知（不然来不及埋点），可动作开始时谁也不知道这次是同步还是异步、更拿不到结果。如果包裹层在开始时就把结果硬塞给监听器，异步动作就彻底没法支持了。注册器的巧妙之处，是把「结果交付」这件事从「动作开始时」推迟到「动作结束时」——开始时只交付「登记的入口」，结束时才交付「真正的结果」，于是同步和异步共用同一条通知路径。

代价是 API 形态反直觉：监听器收到的是一个事件对象，要在自己的回调里再去调用 `event.after(...)`、`event.onError(...)` 注册第二层回调，是「在回调里再注册回调」。第一次见到 `$onAction(({ after, onError }) => { after(ret => ...) })` 这种写法的人，多半会愣一下——这是一笔实实在在的学习成本，换来的则是异步动作的可观测性。

## 5. 最小原理演示

下面这段几十行的迷你状态库，把两条管道并排演一遍。它自带一个最小的响应式运行时（用 Proxy 模拟 Vue 的深度监听、用 `Promise.resolve` 模拟 `nextTick`），不依赖真 Vue，也不 import 原仓库。每一行都对应上面某个原理点。

```ts
// ===== 最小响应式运行时（替代 Vue 的 deep watch + nextTick，只为演透双管道）=====
// 深度监听：任意层级的写都触发 notify
function reactive(obj: any, notify: () => void): any {
  return new Proxy(obj, {
    get: (t, k, r) => {
      const v = Reflect.get(t, k, r)
      return v && typeof v === 'object' ? reactive(v, notify) : v
    },
    set: (t, k, v, r) => { const ok = Reflect.set(t, k, v, r); notify(); return ok },
  })
}
const nextTick = (() => {
  const q: (() => void)[] = []
  let scheduled = false
  return (cb: () => void) => {
    q.push(cb)
    if (!scheduled) {
      scheduled = true
      Promise.resolve().then(() => { while (q.length) q.shift()!(); scheduled = false })
    }
  }
})()
const trigger = (pool: Set<Function>, ...a: any[]) => pool.forEach((cb) => cb(...a))
const isPlainObj = (v: any) => v && typeof v === 'object' && v.constructor === Object
const isRef = (v: any) => v && v.__isRef === true // 演示用标记，真 ref 由运行时识别

// ===== 迷你状态库：两条管道 =====
function createStore(id: string, initial: any) {
  let isListening = true // 异步档监听开关：管 direct 类型的状态订阅
  let activeListener: symbol | undefined // 令牌：保证同回合多次补丁只恢复一次
  const subs = new Set<Function>() // 状态订阅池
  const actionSubs = new Set<Function>() // 动作订阅池

  // 深度监听器：state 上任何层级的「直接写」都进这里，类型标 direct
  const state = reactive(initial, () => {
    if (isListening) trigger(subs, { type: 'direct', storeId: id }, state)
  })

  // —— 动作管道：前置事件 + after/onError 注册器 + 同步/异步双路径 ——
  const action = (name: string, fn: Function) =>
    function (this: any, ...args: any[]) {
      const after = new Set<Function>()
      const onError = new Set<Function>()
      // 注册器塞进前置事件：监听器在「动作开始时」自己挂 after/onError 回调
      trigger(actionSubs, {
        args, name,
        after: (cb: Function) => after.add(cb),
        onError: (cb: Function) => onError.add(cb),
      })
      let ret: any
      try {
        ret = fn.apply(this, args)
      } catch (e) {
        trigger(onError, e); throw e // 同步抛错
      }
      if (ret instanceof Promise) // 异步：挂到 Promise 上，落定再通知
        return ret
          .then((v: any) => { trigger(after, v); return v })
          .catch((e: any) => { trigger(onError, e); return Promise.reject(e) })
      trigger(after, ret) // 同步成功
      return ret
    }

  // —— 补丁管道：关监听 → 深合并 → 手动发一次 → 微任务令牌恢复 ——
  const patch = (partial: any) => {
    isListening = false // 关掉自动监听：接下来一连串写都「静默」
    merge(state, partial)
    const myToken = (activeListener = Symbol()) // 唯一令牌
    // 同回合里只有「最后一次补丁」的微任务比较仍为 true，才真正恢复监听
    nextTick(() => { if (activeListener === myToken) isListening = true })
    trigger(subs, { type: 'patchObject', payload: partial, storeId: id }, state) // 手动只喊一声
  }

  // 最小深合并：普通对象递归，ref/reactive 整体替换
  const merge = (target: any, patchObj: any) => {
    for (const key in patchObj) {
      const sub = patchObj[key], cur = target[key]
      if (isPlainObj(cur) && isPlainObj(sub) && !isRef(sub)) target[key] = merge(cur, sub)
      else target[key] = sub
    }
  }

  return {
    state, action, patch,
    subscribe: (cb: Function) => { subs.add(cb); return () => subs.delete(cb) },
    onAction: (cb: Function) => { actionSubs.add(cb); return () => actionSubs.delete(cb) },
  }
}
```

下面这段把两条管道并排跑一遍，对照它们的通知次数：

```ts
const store = createStore('user', { user: { name: 'a', age: 1 }, count: 0 })
let n = 0
store.subscribe(() => n++)

// 动作管道：动作里两次直接改 + 前后插桩
store.onAction(({ name, after, onError }) => {
  console.log('动作开始', name)
  after((ret) => console.log('动作成功', ret))
  onError((e) => console.log('动作出错', e))
})
const setBoth = store.action('setBoth', function (this: any) {
  this.state.user.name = 'b' // 直接写 1
  this.state.user.age = 2 // 直接写 2
})
setBoth()
// 打印「动作开始 setBoth」「动作成功 undefined」
// n 因两次 direct 写而 +2：动作管道不合并，每一次直接写都如实通知

// 补丁管道：一次塞两个字段，只喊一声
n = 0
store.patch({ user: { age: 3 }, count: 9 })
console.log(n) // → 1：一整批改动合并成一次通知，且监听者看不到 age 先变 count 后变的中间态
```

对照一目了然：动作管道让两次直接写产生两次 `direct` 通知（它只负责前后插桩，不碰合并）；补丁管道让两个字段的更新只产生一次 `patchObject` 通知（它主动关掉了监听，自己合并完手动喊了一声）。

## 6. 执行轨迹

拿一个具体输入，放慢动作走一遍补丁管道，看看状态怎么变。

初始状态是 `{ user: { name: 'a', age: 1 }, count: 0 }`，`isListening = true`，`activeListener = undefined`。现在调用 `store.patch({ user: { age: 3 }, count: 9 })`。

第一步，`isListening` 被置为 `false`。从这一刻起，深度监听器即使被触发，回调里的 `if (isListening)` 也过不了，状态订阅池不会被自动喊到。

第二步，进入 `merge`。看 `user` 这个 key：当前值 `{ name: 'a', age: 1 }` 是普通对象，补丁值 `{ age: 3 }` 也是普通对象且不是 ref，于是**递归**进去——再看 `age`，补丁值 `3` 不是对象，整体赋值，`age` 从 `1` 变成 `3`；`name` 不在补丁里，原样保留 `'a'`。再看 `count`：补丁值 `9` 不是对象，整体赋值，`count` 从 `0` 变成 `9`。合并完成，状态现在是 `{ user: { name: 'a', age: 3 }, count: 9 }`。注意这期间发生过多次底层写操作，但因为监听关着，没有一个变成通知。

第三步，`myToken = activeListener = Symbol()`，记下这次补丁的令牌，并排一个微任务去恢复监听。

第四步，手动 `trigger(subs, ...)` 发一次 `patchObject` 通知。监听者此刻收到的是合并后的最终状态，看不到中间态。这就是这一整批修改的唯一一次通知。

第五步，当前同步代码跑完，微任务队列开始执行。微任务里比较 `activeListener === myToken`：如果这中间没有第二次补丁，比较为 `true`，`isListening` 恢复成 `true`，自动监听重新生效。假如紧接着又调了一次 `store.patch({ count: 10 })`，那第二次会把 `activeListener` 换成自己的新 Symbol，于是第一次排的微任务比较出来是 `false`、不恢复；只有第二次的微任务比较为 `true`、恢复一次——同回合多次补丁，监听只恢复一次。

## 7. 教学简化说明

本章演示故意省略了一批东西，只保留演透双管道主线的部分：devtools 的调试事件收集（仅开发构建，留给后面的可观测性接入章）、热更新里复用的同款「关监听 → 微任务恢复」手法、SSR、插件扩展、Map 与 Set 的完整合并语义（演示只演了普通对象递归与整体替换两路）、监听档位 pre/post/sync 的完整组合矩阵（只点出了「同步立即恢复、异步等微任务」）、整库重置的内部实现（它其实就是套了补丁这层，可作为「批量合并换性能」的一个用例）、完整泛型与作用域清理（后者第 1 章已讲透）。

## 8. 小结

两条管道，其实是在回答同一个问题的两个相反诉求——「我想逐次、可观测地改」走动作管道，「我想一次性、不打扰地改」走补丁管道。动作管道用注册器把结果的交付推迟到动作结束，换来同步异步一套写法通吃；补丁管道用「关监听 + 手动补一次 + 微任务令牌恢复」把一整批改动揉成一次通知，换来监听者的清净。代价都落在时序协议的隐晦与 API 形态的曲折上，是两笔明账。

store 到这里已经能被装出来、也能被改、改了能通知。可还有一件最日常的事没碰：在组件里用 `storeToRefs` 解构它、或在 Options API 里用 `mapState` 映射它时，响应性是怎么保住、又怎么和组件的生命周期对齐的——下一章就接这一步。

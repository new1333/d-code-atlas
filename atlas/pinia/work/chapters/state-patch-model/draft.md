# 状态变更模型：$patch 双形态与暂停监听批处理

你在写一个购物车 store 的结账动作，里面要一口气改好几样：商品数量 +1、勾选状态置 true、优惠券塞进列表、总价重算……动作还没写完，你发现旁边那个负责把状态存进 localStorage 的订阅者，已经被触发了七八次——它根本不在乎中间过程，只想在「这批改动全做完」之后拿一次最终快照存盘。

更糟的是，深度监听是异步生效的（Vue 把它排到下一个微任务里再通知），而订阅者期望的「一次快照」和这个时序根本对不齐：要么收到的还是半成品，要么收一堆半成品。

这一章要解决的就是一件事：**怎么把一批改动收拢成「一条订阅事件」**。

## 一句话点透，外加一个类比

做法是：改之前先把监听「按住」，让这期间的改动一个都别通知出去；改完之后，由我们自己手动派发一次订阅通知。

打个比方：订阅者像是门卫，每次有人搬东西进出都要登记一次。`$patch` 就是给门卫塞个耳塞、蒙上眼，让你一次性把这车货全搬进去，搬完再主动给门卫报一次「这车一共这些」——门卫只登记一条，干净利落。

（先把承前的两块点一下，后面就不重复了：要改的「这车货」就是第 4 章那棵单一根状态树里的一个节点；手动派发用的「门卫名单」就是第 2 章那个订阅回调集合——本章只把它当成「手动通知」的执行件复用，不再重讲集合本身怎么增删、怎么随作用域自动回收。）

## 两个入口：函数式与对象式

`$patch` 有两种写法，对应两种改法：

```ts
// 函数式：把整棵状态直接塞给你，你想怎么命令式改就怎么改
store.$patch(state => {
  state.count++
  state.profile.age++
})

// 对象式：给一个「补丁对象」，框架帮你深合并进去
store.$patch({ count: 1, profile: { age: 2 } })
```

**这条设计换来的是什么**：函数式把状态彻底交给你，适合「我要在这里写一段逻辑、顺手改好几处」；对象式适合「我已经有一个算好的补丁对象（比如从接口、从 localStorage 拿来的），直接糊上去」。两条入口共用同一个 `$patch` 函数体，进函数后按参数是不是 function 分叉。

**代价**：对象式那条路得自己处理「怎么把补丁合并进现有状态」，边界一多就容易踩坑——两边都是普通对象才递归往下合，否则整值覆盖；遇到 ref/reactive 这种响应式包装值也要整值覆盖（不能拆开合，否则破坏响应性）；Symbol 键直接跳过（反正序列化不了）。这些规则压在一个叫 `mergeReactiveObjects` 的递归函数里，是对象式入口复杂度的全部来源。

## 暂停 → 改 → 手动触发一次 → 恢复

不管走哪条入口，`$patch` 内部都是同一套六步：

1. **关掉监听**：把两个监听开关同时置 false。这之后哪怕状态在改，深度监听的回调也被门控跳过、不通知。
2. **施加改动**：函数式就把状态交给你的回调改；对象式就递归深合并。
3. **打包事件**：按入口生成一条订阅事件——函数式是 `patchFunction`，对象式是 `patchObject`（顺便把原始补丁对象塞进 `payload`，方便订阅者追溯）。
4. **排定恢复**：同步开关立即恢复；异步开关排进下一个微任务再恢复，并且只让「最近一次补丁」的恢复生效。
5. **手动派发一次**：遍历订阅回调集合，把这一条事件 + 最新状态一次性发出去——刚才被吞掉的那批监听，全靠这一次手动派发补回来。
6. **收尾**：微任务里异步开关恢复，下次直接改状态又能被深度监听正常抓到。

（「这两个开关平时怎么挂到 watcher 上、`$subscribe` 又怎么靠它们和 `$patch` 协调」是紧邻下一章的主题，这里只用它们「被暂停」这一面，不展开协调机制。）

## 原理演示

下面这段是从零写的最小骨架，能 `node`/`bun` 直接跑。它把 Vue 的深度响应式换成了一个极简 Proxy，把 Vue 的调度队列换成了一个手动队列——目的是让你看清「暂停、改、手动触发、恢复」这条主线，而不是陷进 Vue 本身的调度细节。场景代码用了顶层 `await`，存成 `.mjs` 或直接用 bun 跑即可。

```ts
// ① 第 2 章的订阅回调集合，这里复用最简形态
const subscribers = new Set<(e: any, s: any) => void>()
const addSub = (fn: any) => (subscribers.add(fn), () => subscribers.delete(fn))
const triggerSubscriptions = (e: any, s: any) => subscribers.forEach(fn => fn(e, s))

// ② 状态：第 4 章那棵单一根状态树里的一个节点
const raw = { count: 0, profile: { name: 'a', age: 1 } }

// ③ Vue 调度队列的极简替身：先进先出，flush 时一次跑完
const queue: Array<() => void> = []
const flush = async () => { while (queue.length) queue.splice(0).forEach(f => f()) }

// ④ 两个监听开关（本章主角）
let isListening = true        // 异步监听开关（默认 flush 模式）
let isSyncListening = true    // 同步监听开关（flush:'sync' 模式）
let activeListener: symbol | undefined   // 连续补丁的去重令牌

// ⑤ 极简深度响应式：任何一层 set 都向上冒泡成一次「被监听侦测到」
function reactive<T extends object>(o: T): T {
  return new Proxy(o, {
    get(t, k, r) {
      const v = Reflect.get(t, k, r)
      return v && typeof v === 'object' ? reactive(v as any) : v
    },
    set(t, k, v, r) { Reflect.set(t, k, v, r); watchFired(); return true },
  })
}
const state = reactive(raw)

// ⑥ 深度监听回调（真实 Pinia 里这是 watch(state, cb, { deep: true }) 的回调）
function watchFired() {
  if (isSyncListening) triggerSubscriptions({ type: 'direct', via: 'sync' }, state)   // 同步：立即判
  queue.push(() => { if (isListening) triggerSubscriptions({ type: 'direct', via: 'async' }, state) }) // 异步：入队，flush 再判
}

// ⑦ 对象式深合并（简化版：两边都是普通对象才递归，否则整值覆盖）
const isPlain = (o: any) => o && typeof o === 'object' && Object.getPrototypeOf(o) === Object.prototype
function mergeReactiveObjects(target: any, patch: any) {
  for (const key in patch) {
    const sub = patch[key], cur = target[key]
    target[key] = isPlain(cur) && isPlain(sub) ? mergeReactiveObjects(cur, sub) : sub
  }
  return target
}

// ⑧ $patch 本体：暂停 → 双形态分叉 → 恢复 → 手动派发
function patch(input: any) {
  isListening = isSyncListening = false                    // 1. 关掉两个监听开关
  let event: any
  if (typeof input === 'function') {                       // 2a. 函数式：状态直接交给你改
    input(state); event = { type: 'patchFunction' }
  } else {                                                 // 2b. 对象式：递归深合并
    mergeReactiveObjects(state, input); event = { type: 'patchObject', payload: input }
  }
  const myId = (activeListener = Symbol())                 // 3. 异步开关排进微任务恢复，且只留最近一次
  queue.push(() => { if (activeListener === myId) isListening = true })
  isSyncListening = true                                   //    同步开关立即恢复
  triggerSubscriptions(event, state)                        // 4. 手动统一触发一次
}
```

挂一个会数数的订阅者，然后跑两个对照场景：

```ts
let notify = 0
addSub(() => notify++)
```

**场景一：不走 `$patch`，直接改两处。**

```ts
notify = 0
state.count = 1            // watchFired：同步派发 1 次；异步入队
state.profile.age = 2      // watchFired：同步派发 1 次；异步入队
await flush()              // 异步 flush：再派发 2 次
// notify = 4 —— 订阅者被叫了 4 次，正是开头痛点的最小复现
```

**场景二：走 `$patch`（函数式），同样改两处。**

```ts
notify = 0
patch(s => { s.count++; s.profile.age++ })
//   进入即 isListening = isSyncListening = false
//   s.count++        → watchFired：同步判定 false → 吞；异步入队
//   s.profile.age++  → watchFired：同步判定 false → 吞；异步入队
//   手动 triggerSubscriptions(patchFunction) → notify = 1
await flush()
//   在途的异步派发：flush 时 isListening 仍为 false → 全吞
//   本 patch 自己排的恢复回调：令牌命中 → isListening = true
// 结果：notify = 1
```

同样的两处改动，订阅者只被叫了 **1 次**，而且拿到的是改完之后的完整状态。这就是 `$patch` 把一批改动收拢成一条订阅事件的全部魔法——暂停换来了原子批处理，代价是必须手动补那一次通知。

对象式一样，只是改法换成递归合并：

```ts
notify = 0
patch({ count: 5, profile: { age: 3 } })
// mergeReactiveObjects：count 整值覆盖成 5；profile 两边都是普通对象 → 递归，age 改成 3，name 保留
// 结果：notify = 1，state.profile = { name: 'a', age: 3 }
```

## 为什么是两个开关，恢复时机还不一样？

这大概是 `$patch` 里最绕的一处，单独拎出来讲。

订阅者注册监听时可以选两种触发时机：默认的「异步」（Vue 把通知排到微任务里再发）和「同步」（状态一改立刻发）。这两种监听各对应一个开关——`isListening` 管异步的，`isSyncListening` 管同步的。`$patch` 进门就把两个都关掉，所以不管订阅者选了哪种触发时机，补丁期间的改动都别想漏通知出去。

但**两个开关的恢复时机故意不一样**，这是有原因的：

- **同步开关立即恢复**。同步监听是「状态一改当场就触发」，它不排队——补丁里那几次改动，当场就已经触发过了（只是被门控吞掉）。既然没东西排在队列里，补丁一结束马上恢复它就是安全的，后续同步改动能被正常抓到。
- **异步开关要拖到下一个微任务才恢复**。异步监听是「把通知排进队列、等 flush 再发」。补丁里那几次改动排进去的异步通知，此刻还排在队列里没 flush。要是立刻恢复异步开关，等 flush 一跑、这些通知就会真的发出去——和手动那一次重复。所以故意让它晚一个 tick 恢复，让那批在途通知 flush 时撞上「开关还是关的」被吞掉，恢复留到它们之后。

**代价**：两个开关恢复时机不对称，第一眼很难看懂为什么。Pinia 用一句注释点破了用意——「我们主动暂停了 watcher，所以必须手动补一次通知」，而那个不对称的恢复时机，就是为了保证手动这一次和 watcher 那一次不撞车。

**还有一个边角要处理**：连续多次 `$patch`。每次 patch 都会排一个「恢复异步开关」的微任务，要是每次都生效，前几次 patch 的恢复可能会在更后面的 patch 改动还没 flush 完时，就提前把监听打开。所以用一个模块级的 `activeListener`（一个 Symbol）当令牌：每次 patch 把自己的令牌写进去，恢复回调执行时先核对「我还是不是最近这一次 patch」——只有最近一次的恢复才真正把开关打开，中间那些自动作废。下面这段 trace 就是干这个的：

```ts
notify = 0
patch(s => { s.count++ })   // 令牌 id1，排恢复回调 1
patch(s => { s.count++ })   // 令牌 id2，覆盖 activeListener，排恢复回调 2
// 两次手动派发 → notify = 2（两次补丁，理应两次通知）
await flush()
// 恢复回调 1：activeListener === id1？不（已是 id2）→ 作废
// 恢复回调 2：activeListener === id2？是 → isListening = true
// 在途的异步派发全被吞，没有一次重复通知
```

## 重置和整体赋值，其实也走 `$patch`

`$patch` 这套「暂停 → 批 → 单次通知」太好用了，所以 Pinia 把另两个写状态的操作也路由回了它，复用同一套语义：

```ts
// $reset（仅 option store 有）：重建初始 state，再整体合进去
const $reset = function () {
  const newState = state ? state() : {}
  this.$patch($state => { Object.assign($state, newState) })   // 用 patch 把所有改动收成一条订阅
}

// $state 的 setter：整体赋值也走 patch
Object.defineProperty(store, '$state', {
  set: newState => store.$patch($state => { Object.assign($state, newState) }),
})
```

**换来的是**：所有改状态的路都共享同一套批处理，不用为重置/替换另写一套通知逻辑。**代价**是一个容易踩的坑——`$state = newObj` 用的是 `Object.assign`（浅合并），它**只覆盖、不删除**：

```ts
// 假设当前 state = { a: 0, b: 2 }
store.$state = { a: 1 }
// 你以为是替换，实际是合并 → 结果 { a: 1, b: 2 }，b 没被删掉
```

所以 `$state = newObj` 在语义上不是「替换」，是「把 newObj 浅合并进现有状态」。这是「路由回 patch」这个选择必然带上的副作用。

（顺带一提：`$reset` 只有 option store 有，setup store 在 dev 下直接抛错、prod 下是空操作。原因是 option store 的 state 形状已知、能重建；setup store 的 state 是命令式创建的，框架不知道该怎么重建——这条统一装配路径的代价，会在讲 Options Store 的那一章展开。）

## 小结

`$patch` 的本质就一句话：**改之前按住监听，改完手动补一次通知**。函数式和对象式两条入口、两个监听开关、不对称的恢复时机、连续补丁的去重令牌、重置与整体赋值路由回来——这些都是为了把「一批改动」干净地等价为「一条订阅事件」，同时避免 watcher 自动通知和手动通知撞车。

但它只动用了监听开关「被暂停」这一面。那两个开关平时怎么挂到 watcher 上、`$subscribe` 和 `$onAction` 又怎么靠它们跟 `$patch` 配合，做到「直接改 state」和「走 patch」都能被订阅正确抓到、而且只通知一次——这是下一章「订阅系统」要专门拆开讲的事。
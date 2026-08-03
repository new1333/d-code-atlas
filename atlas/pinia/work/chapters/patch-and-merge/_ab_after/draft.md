# $patch 与深度合并：批量变更的统一入口

## 为什么需要 $patch

假设 store 里有三个字段要一起改。最直白的写法是逐条赋值：`store.a = 1; store.b = 2; store.c = 3`。但 Pinia 在每个 store 的 state 上挂了一个深度 watch（deep watch）——它会观测到每一次赋值，并逐次通知所有订阅者（`$subscribe` 的回调、依赖 state 的组件也会跟着重渲染）。三次赋值，订阅者就被打扰三次。

这还只是「通知太吵」。更麻烦的是「怎么改」本身：有时你想用声明式的对象一次性描述新状态（`{ a: 1, b: 2 }`，可序列化、好做时间旅行）；有时你又需要在回调里写命令式逻辑（往数组 `push`、对 `Map` 做 `set`）。如果每种用法各开一个接口、各走一套通知逻辑，API 会碎成一地。

`$patch` 就是把这俩问题一起收口的统一入口。核心思想一句话：**把 patch 窗口内的所有变更「先静默、再一次性通知」，并按数据类型分流处理。**

## 自底向上：先看清观测层

要看懂 $patch 怎么「静默」，得先知道它要静默的是什么。

Pinia 给每个 store 的 state 注册了一个 deep watch。这个 watch 的回调里做了一件关键的事——**检查监听开关**：

- 默认 flush（异步）的订阅，看 `isListening` 这个开关；
- `flush: 'sync'` 的订阅，看 `isSyncListening` 这个开关。

开关打开时，state 一变，watch 就把变更连同新 state，通过上一章讲过的 `triggerSubscriptions`（遍历 Set 逐个调回调）发给订阅者。开关关闭时，watch 回调照样会被 Vue 触发，但第一行 `if` 就把它短路了——订阅者什么也收不到。

这就是 $patch 的操作空间：它不需要去「拦截」Vue 的响应式系统，只需要拨动这两个开关。

> 说人话：watch 永远在岗，但它的「听力」由开关控制。$patch 的全部魔法，就是在改 state 前把开关拨到「聋」，改完再自己当一次广播员。

## 核心机制：暂停 watcher，手动广播一次

把 $patch 的执行流程画出来，就是一条「关麦 → 改 → 广播 → 重新开麦」的流水线：

```
$patch(mutator)
  → isListening = isSyncListening = false    ① 关麦：两个 watch 都短路
  → mutator(state)                             ② 静默改（改多少次都没人收到）
  → isSyncListening = true                     ③ sync 听众立刻恢复听力
  → triggerSubscriptions(...)                  ④ 手动广播一次（整组变更合并成一条通知）
  → nextTick().then(() => isListening = true)  ⑤ async 听众等下一个 microtask 再恢复
```

注意③排在④之前：sync 开关在「手动广播」之前就已经恢复。这是有意为之，后果见下面的权衡一。

下面这段几十行的演示，把这条流水线原样搭出来——只用 `reactive` + `watch` + `nextTick` 三个原语：

```ts
import { reactive, watch, nextTick } from 'vue'

const state = reactive({ a: 0, b: 0, c: 0 })

let isSyncListening = true   // sync 订阅开关
let isListening = true       // async（默认 flush）订阅开关

const subs = new Set<(type: string) => void>()
subs.add((type) => console.log(`订阅收到：${type}  state=${JSON.stringify(state)}`))

// 观测层：两个 deep watch，分别代表两类订阅者
watch(state, () => { if (isListening) subs.forEach((cb) => cb('async-watch')) }, { deep: true })
watch(state, () => { if (isSyncListening) subs.forEach((cb) => cb('sync-watch')) }, { deep: true, flush: 'sync' })

function notify(type: string) { subs.forEach((cb) => cb(type)) }

function $patch(mutator: (s: typeof state) => void) {
  isListening = isSyncListening = false        // ① 关麦
  mutator(state)                                // ② 静默改
  isSyncListening = true                        // ③ sync 立刻恢复
  notify('patch（手动广播一次）')               // ④ 合并成一次通知
  nextTick().then(() => { isListening = true }) // ⑤ async 延迟恢复
}

$patch((s) => { s.a = 1; s.b = 2; s.c = 3 })
// 输出只有一行：
//   订阅收到：patch（手动广播一次）  state={"a":1,"b":2,"c":3}
```

三次赋值，订阅者只被打扰一次——这正是 $patch 存在的理由。

`nextTick` 是 Vue 提供的工具，它把回调推迟到「当前这轮同步代码跑完之后、下一次渲染之前」的那个 microtask 空档里执行（microtask 就是同步代码收尾时、渲染前会优先清空的一队小任务）。至于为什么 async 开关必须推迟到那里才恢复——这正是第一组权衡要讲的事。

## 关键权衡

### 权衡一：暂停 + 手动广播，换来「合并通知」，代价是 async 监听有一段「夹缝聋」

这是 $patch 最核心的设计，值得拆透。

**做了什么**：patch 期间关掉两个监听开关，改完 state 后由 $patch 自己调一次 `triggerSubscriptions`，把「这一整批变更」打包成一条通知发出去。

**换来了**：patch 窗口内无论改几次、改几个字段，外部都只收到一次通知。订阅回调、组件重渲染都只触发一遍——批量更新的性能账，从「N 次」降成了「1 次」。

**代价**：监听恢复的时机，sync 和 async 不对称，而且藏着一个容易踩的坑。

先看为什么 async 不能像 sync 那样「立刻恢复」。Vue 默认 flush 的 watch 不是同步的——它会把 patch 内的多次 state 变化攒着，等下一个 microtask 合并成一次回调再触发。如果 $patch 一返回就把 `isListening` 拨回 true，那么这次「攒着没发」的合并回调跑的时候开关已经开了，它会穿透开关、再通知订阅者一次——合并就白做了。所以 async 的恢复必须排在那次合并回调**之后**，办法就是用 `nextTick` 把恢复也挪进 microtask 队列，确保合并回调跑完、开关才开。（上面的演示里 async-watch 那行最终不打印，正是因为合并回调执行时 `isListening` 仍是 false。）

但这带出一个副作用——**夹缝聋**。从 $patch 返回、到 nextTick 真正执行的这段同步代码里，如果有人直接改了 state（比如另一个同步函数顺手 `store.a = 9`），会发生什么？

- sync 订阅：开关在③就已恢复，这次直改会立刻通知到它；
- async 订阅：开关还关着，这次直改被吞掉，要等下一次 state 变化才可能被「带」出来。

换句话说，patch 之后有一个极短的窗口，async 订阅对直改是「失聪」的。这通常无害（没人会在 patch 紧接着直改 state），但如果你写的是「patch 里改一半、回调里又直改另一半」这种依赖订阅联动的逻辑，async 订阅可能少收到一次事件——订阅窗口的设计必须意识到这个夹缝。

### 权衡二：对象路径用递归合并，而非浅 `assign`

$patch 的另一半是对象式调用：`$patch({ profile: { name: 'A' } })`。这里有个朴素实现陷阱——直接 `Object.assign(state, partial)` 做浅合并，会把 `profile` 整个子树替换掉，原本 `profile.age` 之类的兄弟字段全没了。

**做了什么**：对象路径走一个递归合并函数。它按 key 遍历传入的对象：只有当「目标里的值」和「待合并的值」**都是普通对象**时，才钻进去递归合并；否则直接整值替换。

**换来了**：嵌套的普通对象可以「局部 patch」——`$patch({ profile: { name: 'A' } })` 只动 `name`，`profile.age` 原样保留。声明式、可序列化、还能精确到子树。

**代价**：递归要付出常数开销（小到可忽略）；更要命的是「普通对象」的判定很严格——用 `Object.prototype.toString` 检查是不是 `[object Object]`，还排除了带 `toJSON` 的对象。这意味着**数组、`Date`、`Map`/`Set` 实例一律不算普通对象**，走的是整值替换，不能局部 patch。

实际后果：你想 `$patch({ list: [新元素] })` 给数组追加？做不到，整个数组会被替换。数组的增量操作得走函数路径（`$patch((s) => s.list.push(x))`）。用户必须在脑子里记住这条分流规则：**普通对象用对象路径、集合与数组用函数路径。**

还有个贴心细节：合并条件里额外排除了 `ref` 和 `reactive` 子节点。如果对象路径里塞了一个 ref/reactive，它不会被「解包合并」而是整值替换——这是为了不破坏用户在 setup store 里手动包好的响应式容器。

### 权衡三：Map 走 `set`、Set 走 `add`，换「集合增量更新」，代价是语义被削窄

集合类型（`Map`/`Set`）在合并函数里被单独拎出来：

```
mergeReactiveObjects(target, patch)
  target 是 Map？  → patch.forEach((v, k) => target.set(k, v))   按 key 覆盖值
  target 是 Set？  → patch.forEach(target.add, target)           批量 add
  否则            → for key in patch：两边都普通对象就递归，否则整值替换
```

**做了什么**：Map 按 key `set`，Set 批量 `add`，而不是把整个集合替换掉。

**换来了**：集合的「增量更新」能工作——`$patch({ config: new Map([['k', v]]) })` 只覆盖 `k` 这一个 key，其它 key 不动；Set 可以只加新元素。

**代价**：语义被削窄了。Map 的合并是「按 key 覆盖值」，**不是真正的递归 merge**——如果某个 key 的值本身是对象，它会被整体替换，不会钻进去合并。Set 更受限：**只能 `add`，不能 `delete`**。要删集合里的元素，没有对象路径的写法，只能走函数路径（`$patch((s) => s.tags.delete('x'))`）。

一句话：对象路径的便利，到集合这里就打折了——它们支持「加/改」，不支持「递归合并」和「删」。

## 一个隐藏设计：嵌套 $patch 用 token 锁定「谁能恢复监听」

最后点一个项目独创的小设计。如果在 mutator 里又调了一次 $patch（嵌套 patch），两次都会各自 `nextTick().then(() => isListening = true)` 来恢复 async 监听。问题来了：内层 patch 一进来，外层那个恢复回调还排在队列里——如果它执行了，会在内层 patch 改 state 期间把 async 监听错误地打开，合并就漏了。

解法是一个 `Symbol` token。`Symbol` 是 JS 里的「全局唯一标签」，每次 `Symbol()` 都造出一个谁也无法重复的新值。每次进入 $patch，生成一个新 Symbol 写到模块级的 `activeListener`；自己的 nextTick 回调里先比对：**只有「我的 token 还等于 activeListener」时，才允许我把开关打开**。内层 patch 一进来就把 `activeListener` 换成了自己的 token，于是外层那个回调比对失败、被静默丢弃——最终只有最内层（最后一次）的 patch 拥有恢复监听的权利。

**做了什么**：用一个每次 patch 都刷新的全局 token，把「恢复 async 监听」的权力锁定给最后一次 patch。

**换来了**：嵌套 patch 时监听恢复的时机始终正确——不会因为外层回调抢先执行而让内层 patch 期间 async 监听意外打开、漏掉合并。

**代价**：外层 patch 的恢复回调被无声丢弃，调试时如果不了解这个 token 机制，会困惑「为什么我那个 nextTick 没生效」。这是用一点隐式状态，换嵌套场景的正确性。

## 小结

$patch 的全部精巧，可以压成两条线索：

- **作为「合并通知器」**：靠「关 watch 开关 → 静默改 → 手动 `triggerSubscriptions` 一次 → 延迟恢复开关」，把 N 次赋值压成 1 次外部通知。代价是 async 监听有一段 microtask 级的夹缝失聪。
- **作为「分流合并器」**：函数路径放行命令式自由（push/splice/delete 随意），对象路径用递归合并支持声明式局部 patch，Map/Set 再单独走 set/add。代价是「数组/集合不能局部 patch、Set 不能 delete」这条必须记住的分流规则。

理解了这两条，也就理解了为什么 `$reset`、`$state` 的赋值 setter 都在内部复用 $patch——它们都需要「把一串变更归并成一次通知」这件事，而 $patch 已经把它做对了。
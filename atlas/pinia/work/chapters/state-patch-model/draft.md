# 状态变更模型：$patch 双形态与暂停监听批处理

> 本章属于 composite 层。前置：Store 装配、订阅原语。
> 学完你能用一句话讲清：为什么 Pinia 把"改状态"统一收口到 `$patch`，以及它为了"一批改动只通知一次"做了哪几个不对称的取舍。

## 1. 为什么需要它

上一章把 store 装配出来的产物，是一棵镜像在 `pinia.state.value[id]` 里的根状态树。树长出来了，紧接着的问题就是：**怎么改它、改完怎么通知订阅者**。

设想你在 action 里这样写：

```ts
function increment() {
  store.count++
  store.lastUpdated = Date.now()
  store.history.push(store.count)
}
```

三个字段被改了。如果每个字段变动都顺着响应式系统直接流到订阅者（写 localStorage、上报 devtools、打日志），这一次"逻辑上是一次自增"会被记成三次事件，写盘三次、上报三次。订阅者根本分不清"这三次改动其实是一回事"。

更糟的是，Vue 的深度 watcher 默认是异步 flush 的——它在下一个 tick 才跑。可订阅者通常希望"这次自增给我一个快照就行"，时机和粒度都对不齐。

需要的不是更多 API，而是一个统一入口：进这个入口期间，订阅者的通知被按住，等改动全部完成后，统一发一次。

## 2. 核心思想

**把一批状态改动收拢成一个补丁——补丁期间关掉深度监听、改完手动派发一次订阅通知。**

这句话的灵魂不在"补丁"这个词，而在把"改状态"和"通知订阅者"在时间上脱钩：你拿到一段独占的时间窗，里面改多少次都没人看见；时间窗一关，订阅者只看到最终结果。

## 3. 心智模型

补丁入口内部维护两份东西：

- 一份根状态对象（上一章镜像进来的那棵树）。
- 两个监听开关：`isListening`（异步深度监听）、`isSyncListening`（同步深度监听）。

平时订阅有两条触发路径：

- 路径 A：绕过 `$patch` 直接改 `store.x = ...`。深度 watcher 看到变动，开关为 true 时直接通知订阅者。
- 路径 B：走 `$patch(...)`。开关被关掉，watcher 看见但被门控跳过；改动结束后，由补丁入口手动遍历订阅者集合，发一条通知。

补丁的生命周期长这样：

```
进入：isListening=false, isSyncListening=false
  → 施加改动（函数式 or 对象式）
  → 打包一条 mutation 事件
  → 异步开关排进微任务才恢复（带 Symbol 去重）
  → 同步开关立即恢复
  → 手动遍历订阅者集合，把事件 + 最新状态派发一次
微任务到达：异步开关恢复 true
```

两个形态各擅长一件事：

- **函数式入口**：`$patch(s => { s.count++; s.list.push(1) })`——拿到根状态对象，命令式改写。适合"我不知道哪些字段会变、按业务逻辑跑一遍再说"。
- **对象式入口**：`$patch({ count: 1, profile: { name: 'A' } })`——给一个 patch 对象，框架做递归深合并。适合"我有完整的新状态片段、声明式叠上去"。

订阅者集合本身（addSubscription / triggerSubscriptions 的最小化身）第 2 章已经讲透了，本章只把它当成"派发执行件"复用，不重演回调集合的设计。

## 4. 关键权衡

### 关监听换"一批改动 = 一条订阅"

补丁入口第一件事是把两个监听开关都置 false。Vue 的深度 watcher 没法被关掉、它仍然会察觉状态变动，但它的回调会先看开关，开关为 false 就直接 return——中途的每一次字段改动都被闷在锅里。

换来的是真正的原子批处理：你在补丁里改三个字段，订阅者只收到一条通知，事件类型是 `patch function` 或 `patch object`，事件里附带"这次补丁干了什么"。

代价不是零：既然 watcher 被跳过，框架就必须自己**补一次**——在补丁末尾手动遍历订阅者集合、发一条事件。这一步漏掉，订阅者会彻底错过这次补丁。这等于把"通知订阅者"的责任从响应式系统手里接过来，变成补丁入口自己得扛的事。

这条权衡化解的本质矛盾是：**响应式系统的天然语义是"每次字段变动都通知一次"，但业务语义是"一次逻辑操作可能改多个字段、订阅者只关心这次操作"**——这两个粒度对不齐。任何"批处理"机制都会撞上这个矛盾，解法也都长得像：开个口子让外面说"我现在开始批、先别喊"，结束后再统一喊一次。

### 双形态入口换表达力，代价是合并逻辑复杂

函数式擅长业务流程式地改、对象式擅长声明式地叠。两种形态都必要——只给函数式，没有"我手上有一份完整新片段"的便利；只给对象式，写不出"按当前 list 长度决定怎么改"的逻辑。

代价集中在对象式的合并规则上。一条"深合并"听起来简单，写下来要逐类型分叉：Map 用 `set`、Set 用 `add`（整键覆盖、不递归进元素）；普通对象两边都是才递归；patch 值若是 ref/reactive 包装就整值覆盖（不能拆开，否则破坏响应性）；Symbol 键直接跳过（不可序列化）。每一种集合类型都得专门懂、每一种响应式包装都得专门躲。

这条权衡的本质矛盾是：**声明式合并必须懂每个集合类型的合并语义、又必须保留响应式包装不被拆穿**——一边是"我只想给个对象"，一边是"对象里可能藏着任何东西"。"声明式描述差量"这个需求在所有状态管理库里都会遇到，Redux 的 reducer、Immer 的 recipe 都是这条谱系上的不同取舍。

### 两个开关不对称恢复，换"吞异步 job + 不伤同步监听"

补丁结束后，同步开关立即恢复 true，异步开关却排进 `nextTick` 微任务才恢复。为什么要错开？

Vue 的深度 watcher 默认异步 flush：状态一变，watcher 不立刻跑，而是排进调度队列、下个 tick 统一 flush。补丁期间状态被改了，watcher 的 job 已经排在队列里；如果异步开关在补丁结束时立即恢复 true，这个被排进来的 job flush 时就会发现开关开着、真的通知订阅者一次——和补丁末尾的手动派发**重复**了。

所以异步开关的恢复被推迟到下一个微任务：本 tick 排队的 watcher job flush 时撞上 false 被吞、然后微任务再把开关恢复 true。同步开关不需要这步——同步 watcher 当场跑、补丁内的变动当场就被门控跳过，结束就立刻恢复不会引发重复。

代价是两个开关恢复时机不对称——读代码的人很难一眼看出"为什么要分两步"。补丁入口还用一个模块级的 `activeListener`（Symbol）保证**连续多次补丁只有最后一次的微任务恢复生效**：每次补丁用一个新的 Symbol 给自己编号，微任务回调里检查"我是不是最近一次补丁"，是才恢复。否则连续补丁会排进来好几个恢复回调，中间一个提前把开关打开了，前述的"吞 job"机制就破功。

本质矛盾：**异步调度让"通知"和"改动"在时间上分离，但批处理需要"通知"紧跟"改动"的语义边界**——你只能在调度器的时间窗里做手脚，用"晚一拍恢复"换取"该吞的吞掉"。任何在异步响应式系统上做批处理的库都会撞上这个时间错位。

### `$reset` 与 `$state` setter 都转调 `$patch`，换写路径语义统一

`$reset`（仅 option store）和 `$state = newObj` 都不另起通知逻辑，而是内部直接调 `$patch`：

- `$reset` 调 `$patch(s => assign(s, freshState()))`
- `$state` setter 调 `$patch(s => assign(s, newState))`

换来的是"所有写状态的操作共享同一套批处理与单次通知"——不用为重置/替换各写一套订阅通知逻辑、不用担心"直接改 rootState 会不会被订阅者漏掉"。

代价是一个语义上的不直觉：`store.$state = { a: 1 }` 作用在 `{ a: 0, b: 2 }` 上，结果不是 `{ a: 1 }` 而是 `{ a: 1, b: 2 }`——是**浅合并**而非替换。`Object.assign` 不会删旧键。你以为 setter 是"换一整份新状态"，实际拿到的是"叠一层上去"。

本质矛盾：**"重置/替换"在概念上像是一份全新的状态、理应另起通知路径，但工程上又必须复用 `$patch` 的批处理机制**——解法是承认它们其实就是一种特殊的补丁（覆盖式补丁），代价是命名上叫"替换"语义上却是"合并"。

## 5. 最小原理演示

下面这段几十行的 TS 把上面几条权衡压成一段可读脚本：根状态对象 + 订阅者集合 + 两个监听开关 + 一个补丁函数（双形态 + 不对称恢复 + 手动派发）。被暂停的深度 watcher 属于下一章的另一条订阅路径，这里不演。

```ts
type Listener = (mutation: any, state: any) => void

// 根状态（真实场景被 Vue reactive 包起来；本章只演补丁路径）
const state: any = { count: 0, list: [] as number[] }

// 订阅者集合——第 2 章已讲透的 addSubscription/triggerSubscriptions 最小化身
const subscriptions = new Set<Listener>()

// 两个监听开关：异步 / 同步（默认 true；补丁期间被关）
let isListening = true
let isSyncListening = true

// 连续补丁去重：每次补丁用新 Symbol 编号、只有最近一次的微任务恢复生效
let activeListener: symbol | undefined

// 深合并：两边都是普通对象才递归，否则整值覆盖（含 ref/reactive 包装值）
function deepMerge(target: any, patch: any) {
  for (const key in patch) {
    const sub = patch[key], cur = target[key]
    if (isPlain(cur) && isPlain(sub) && !isRef(sub)) {
      target[key] = deepMerge(cur, sub)
    } else {
      target[key] = sub
    }
  }
  return target
}
const isPlain = (v: any) => v && typeof v === 'object' && !Array.isArray(v)
const isRef = (v: any) => v && v.__isRef

// 双形态补丁入口
function $patch(arg: ((s: any) => void) | object) {
  // 关掉两个监听开关：本批改动期间，被暂停的深度 watcher 即便被触发也被门控跳过
  isListening = isSyncListening = false

  let mutation: any
  if (typeof arg === 'function') {
    arg(state)                                    // 函数式：根状态交给回调命令式改写
    mutation = { type: 'patch function' }
  } else {
    deepMerge(state, arg)                         // 对象式：递归深合并
    mutation = { type: 'patch object', payload: arg }
  }

  // 异步开关排进微任务才恢复——把本 tick 排队的 watcher job 吞掉、避免与手动派发重复
  const myId = (activeListener = Symbol())
  queueMicrotask(() => {
    if (activeListener === myId) isListening = true
  })
  // 同步开关立即恢复——后续同步监听不受影响
  isSyncListening = true

  // 既然 watcher 被暂停了，入口必须自己派发一次订阅
  // 这一步漏掉 → 订阅者彻底错过本次补丁
  subscriptions.forEach(fn => fn(mutation, state))
}

function $subscribe(fn: Listener) {
  subscriptions.add(fn)
  return () => subscriptions.delete(fn)
}

// === 跑一遍 ===
$subscribe((m, s) => console.log(`[订阅] ${m.type} →`, JSON.stringify(s)))

$patch(s => { s.count++; s.list.push(1) })
// 输出：[订阅] patch function → {"count":1,"list":[1]}

$patch({ count: 5 })
// 输出：[订阅] patch object → {"count":5,"list":[1]}
```

第一个补丁里改了两个字段（`count` 与 `list`），订阅者只收到一条通知——这就是"批处理"的落地证据。

## 6. 执行轨迹

拿 `store.$patch(s => { s.count++; s.list.push(1) })` 走一遍，state 初始是 `{ count: 0, list: [] }`：

1. 进入 `$patch`。第一行：`isListening = isSyncListening = false`。两个开关同时置关。
2. 参数是函数，走函数式分叉：把根状态对象交给回调。回调里 `s.count++`（0 → 1）、`s.list.push(1)`（list 从 `[]` 变成 `[1]`）。这两次改动都被 Vue 的响应式系统捕获、watcher job 排进异步 flush 队列——但 job 真跑时撞上 `isListening=false` 被吞。
3. 打包事件：`{ type: 'patch function', storeId, events: [] }`。
4. `const myId = (activeListener = Symbol())`——给本次补丁起一个唯一编号。
5. 把"恢复异步开关"排进 `nextTick` 微任务。这个回调里会检查 `activeListener === myId`：只有我是最近一次补丁才恢复。
6. `isSyncListening = true`——同步开关立即恢复。
7. `triggerSubscriptions(subscriptions, mutation, state)`——遍历订阅者集合，把事件 + 最新状态（`{ count: 1, list: [1] }`）一次性派发。订阅者收到 1 条通知。
8. 微任务时刻：检查通过，`isListening = true`。下一次直接改 `store.x = ...` 又能被深度 watcher 正常捕获。

订阅者从开始到结束只收到 1 条通知，尽管状态实际上变了两次。

## 7. 教学简化说明

本章演示故意省略了一些旁支：Map/Set 的特判合并、devtools 的 `debuggerEvents` 收集、真实 Vue 调度器的异步 flush 细节、`$reset` 与 `$state` setter 转调 `$patch` 的具体路由、`isPlainObject` 的边界判定。省掉这些是为了让"暂停 → 改 → 手动派发 → 不对称恢复"这条主线尽量瘦。

## 8. 小结

补丁入口把"改状态"和"通知订阅者"在时间上拆开——独占一段窗口改个够、然后由入口自己统一喊一次。代价是入口必须接管通知职责、两个开关恢复不对称、对象式合并要做大量边界处理、`$state = newObj` 实际是浅合并而非替换。

下一章会展开两个监听开关的另一面：它们平时怎么与深度 watcher 协作捕获"直接改 state"的场景、补丁路径和直接改路径如何在同一对开关上既不漏通知也不重复通知。
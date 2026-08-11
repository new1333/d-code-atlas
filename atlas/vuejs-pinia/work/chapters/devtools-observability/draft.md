---
title: 开发者工具的可观测性接入
---

# 开发者工具的可观测性接入

> 本章属于 system 层。前置：插件扩展总线、状态变更的双管道。
> 学完你能：讲清 Pinia 怎么把运行时的状态变更变成可观测的时间线事件，以及为什么要用一个 Proxy 在动作执行期间反复刷写"当前动作"指针来给变更归组。

## 1. 为什么需要它

上一章解决了开发期的一个麻烦：你改了源码，store 还能保住身份、不用整个重挂。但开发期还有一个更日常的痛点——store 跑起来之后，你压根看不清它内部在怎么变。

想象一个最常见的调试场景：某个动作里先改了一个字段，又调了另一个动作，回来再改一次。你在 Vue DevTools 里盯着的，是一连串孤立的"count 变了""tag 变了"事件。你知道状态确实变了，但拼不出来"这是哪个动作、第几步、带什么参数引发的"。靠 `console.log` 猜时序，是状态管理调试的常态。

问题不在于"看不见变更"，而在于**变更和引发变更的动作之间断了链**。状态变更是被动的、零散的；动作是主动的、有边界的。调试器需要的是把零散的变更挂回引发它的那个动作上，在时间线上折叠成一组，这件事状态库本身得帮调试器做。

Pinia 没有另起一套探测机制，而是反过来：它本来就有两条变更管道（动作拦截、状态订阅）和一个插件扩展点，这些在第 7 章和第 9 章已经搭好了。可观测性层只做一件事——**把它们接出来，变成调试器能消费的事件**。本章要讲的就是这个"接出来"的过程，以及其中最难的一环：怎么让被动触发的变更，自动认得引发它的那个动作。

## 2. 核心思想

把状态变更和动作调用这两条本就存在的管道，直接接成调试器时间线上的事件；再用一个 Proxy，在动作执行期间不停地把"当前在跑哪个动作"写进一个模块级变量，于是动作体内被被动触发的那一次次状态变更，都会自动贴上同一个分组标签，被调试器折叠进同一个动作。

前半句（接出来）解决"看得见"，后半句（Proxy 刷写）解决"归得拢"。本章的重头戏在后半句。

## 3. 心智模型

整套可观测层只在开发构建里装配（生产构建一个常量为假，整块被摇树裁掉，这点放在权衡里细说）。装配分两步。

**第一步，应用启动时**，devtools 以插件身份挂上 Pinia（复用第 9 章的插件扩展点），向 Vue DevTools 注册一个时间线图层和一个检查器面板。这一步是把调试器那边的展示位准备好。

**第二步，每个 store 组装完成时**，devtools 插件被调用，对这个 store 做两件事：

- **改写它的每个动作**，埋下归组用的标记（细节见下）。
- **登记进检查器面板**，并订阅两条管道：动作生命周期订阅（产出 🛫 start / 🛬 end / 💥 error 三类事件）和状态变更订阅（每次状态改动产出一条事件）。两条订阅都声明脱离组件作用域、随 store 存活（这是第 1 章那个 detached 选项的直接复用），且状态订阅用同步节奏触发，确保事件在变更当下就产生。

**运行时的归组机制**是本章灵魂，靠一个模块级变量和一个 Proxy 配合：

- 模块级有个变量 `activeAction`，记着"当前正在执行哪个动作"（一个动作编号）。谁都不在动作里时，它是空的。
- 改写后的动作包裹层在调用时，把这个编号写进 `activeAction`；动作返回时清空。
- 对 Options API 风格的 store，还会额外用一个 Proxy 套在动作的 `this` 上：动作体内每一次读写状态，这个 Proxy 都会把 `activeAction` **重新刷写**为当前动作的编号。
- 于是，动作体内那些被动触发的状态变更（它们经由状态订阅变成事件），在产生的那一刻读 `activeAction`，读到的正是当前动作的编号，把这个编号当成分组标签贴在事件上，调试器就把它们归到同一个动作名下。

这里有个时序细节容易被想反：不是"开始"事件先分配编号、包裹层再去取；而是**包裹层先读一个全局计数器拿到本次编号、写进 `activeAction`，然后才调用原动作、由订阅回调让计数器自增**。两者都落在计数器还是同一个值的窗口里，所以包裹层拿到的编号、"开始"事件的编号、`activeAction` 三者总是相等。具体怎么走，下一节的执行轨迹会用一次真实调用逐步展开。

## 4. 关键权衡

### 复用既有变更管道，不另起探测

Pinia 本来就有两条管道：调动作时会被包裹层拦截（第 7 章的动作包裹，产出 before/after/onError 回调），改状态时会触发 `$subscribe` 订阅。devtools 没有再造一套"变更探测器"，而是直接把动作订阅和状态订阅各接一份出来，把它们的回调翻译成调试器时间线事件。

换来的是两件实在的好处。其一，核心代码完全不用为调试埋专用钩子，观测层待在核心之外，零侵入。其二，调试器看到的就是生产时真实发生的行为，不会因为"探测机制"本身改了执行路径而失真。

代价是事件粒度被既有管道的规则锁死了。一次 `$patch` 不论改几个字段，在状态订阅那里只算一次变更，时间线上也就只有一条事件；而动作体内直接赋值 `this.x = 1; this.y = 2` 则各算一次、各出一条。你没法在观测层调整这个粒度，因为那是第 7 章定好的合并规则。另外，这两条订阅必须显式声明 `detached`，否则会跟着调用方的作用域（通常是组件）一起被回收，观测就断了。

这条权衡化解的本质矛盾，是**"想看清运行时行为"和"不能让观测污染核心"**之间的拉扯。通解是别在核心里埋探针，而是把核心本就暴露的钩子点接出来：只要一个库提供了订阅、中间件这类扩展点，可观测性就能这样搭便车接入，不必侵入主路径。

### 用 Proxy 反复刷写"当前动作"指针来完成归组

这是本章真正想讲的设计。动作执行期间会发生多次状态变更，有些是动作体直接改的，有些是它调用的内层动作改的。要把它们都正确归到"当时正在跑的那个动作"，需要一个能在整段动作执行期间存活、又能在内层动作返回后自动恢复的"当前动作"标记。

做法是用一个模块级变量 `activeAction` 当这个标记，再在动作体每次读写状态时把它刷新一遍。具体到 Options API 风格的 store：动作体里的状态访问都经 `this`，于是用 Proxy 套在 `this` 上，get 和 set 陷阱里都把 `activeAction` 重写为当前动作的编号。这样一来，哪怕内层动作执行时把 `activeAction` 改成了内层编号、返回时又清空了，外层动作只要再读写一次状态，Proxy 就立刻把 `activeAction` 重新夺回外层编号。状态订阅在产生事件的那一刻读 `activeAction`，读到的永远是"刚刚那次状态访问所属的动作"。下面的演示和执行轨迹会让这个"夺回"看得见摸得着。

换来的是：开发者完全不用改写动作的调用约定，被动触发的变更就自动归了组，连嵌套调用都对。

代价有两面，都是真实的。

第一，Proxy 只拦得住"经 `this` 访问状态"的写法。Options API 的动作用 `this.count` 读写，Proxy 套在 `this` 上正好拦得到；但 Setup Store 的动作是 `() => { count.value++ }`，状态以闭包变量持有，根本不经 `this`，Proxy 套在 `this` 上什么都拦不到。所以 Setup Store 只能退回到"进函数设标记、出函数清标记"的粗粒度归组——动作执行期间的所有变更都算它的，但内层动作返回后的"夺回"就做不到了。这背后的根因不在 Pinia，而在 JavaScript 语言层目前还缺少一种能跨 `await` 自动延续的上下文能力；tc39 的异步上下文提案（AsyncContext）正是冲着这个缺口去的，等它落地，这条局限才有彻底解。

第二，对异步动作，`await` 之后的变更没法归组。改写后的包裹层在原动作**返回的那一刻**就把 `activeAction` 清空了，哪怕原动作返回的是一个 Promise，它也不会等这个 Promise 跑完。注意，这并不是一条独立的"等待策略"，而是上面那套编号机制的直接后果：编号只活在同步的包裹层这一层栈帧里，动作体一返回这层栈帧就没了，编号本身就没有能跨过 `await` 的载体，自然谈不上延续。包裹层选择在返回时立刻清空，是为了避免 `await` 期间发生的、跟这个动作无关的变更被错认到它头上。设计者把这定为宁可漏归、也不误归的取舍——归错比归不上更糟。

这条权衡化解的本质矛盾，是**"想给一段执行过程贴上随它流动的标签"和"语言缺少跨同步边界延续上下文的能力"**之间的落差。同样的墙，在请求级链路追踪、事务标识、日志的 traceId 这些场景里都会撞上。

### 整块观测层只活在开发构建里

归组、Proxy 包裹、detached 订阅，都包在一个构建期常量 `__USE_DEVTOOLS__` 后面。生产构建直接把它置为假，摇树阶段整块观测代码被裁掉。

换来的是生产包零运行时开销、零额外体积。代价是生产环境彻底无可观测性，线上出问题只能靠日志；而且 Proxy 在不在会造成细微的行为差异，dev 里调通的不等于生产行为。这条权衡化解的本质矛盾，是"开发期想看得清楚"和"生产期想跑得轻"之间的不可兼得，通解就是用构建期开关把同一份代码切成两个形态。

## 5. 最小原理演示

下面这段代码只演"归组"这一件事：一个模块级 `activeAction`、一个把状态写字段就推一条事件的假订阅、一个把每个动作改成"设标记 → Proxy 包 this 重刷标记 → 跑原动作 → 清标记"的函数。它能跑出三种结果：经动作改的状态都带分组标签、内层动作返回后外层继续改还能归回外层（Proxy 重刷的威力）、不经动作的裸改落单。

```ts
// 归组机制最小演示：演「Proxy 在每次读写状态时重刷当前动作指针，
// 让被动触发的状态变更自动带上同一个分组标签」

// 模块级隐式上下文：当前正在执行哪个动作（动作编号），不在动作里就是 undefined
let activeAction: number | undefined
// 动作编号计数器：start/end 事件与归组共用同一套编号
let runningActionId = 0

type Event = { kind: string; field?: string; groupId?: number }
const timeline: Event[] = []

// 状态变更订阅：状态一变就推一条事件，归到谁名下全看此刻的 activeAction
function emitMutation(field: string) {
  timeline.push({ kind: 'mutation', field, groupId: activeAction })
}

const stateFields = new Set(['count', 'tag'])

// 假 store：Options API 风格，动作经 this 访问状态
const store: any = {
  count: 0,
  tag: '',
  ping(this: any) {
    this.count++
    this.tag = 'pinged'
  },
  bumpAndPing(this: any) {
    this.count++     // 归到外层
    this.ping()      // 进内层：归到内层；内层返回后 activeAction 已被清空
    this.count++     // 靠 Proxy 重刷，再次归回外层
  },
}

// 状态订阅层：包住 store，写状态字段就推一条变更事件
const observed = new Proxy(store, {
  set(target, key, value) {
    Reflect.set(target, key, value)
    if (stateFields.has(String(key))) emitMutation(String(key))
    return true
  },
})

// 把每个动作改成：设标记 → Proxy 包 this（读写时重刷标记）→ 跑原动作 → 清标记
function patchForGrouping() {
  for (const name of ['ping', 'bumpAndPing']) {
    const original = store[name]
    store[name] = function (this: any, ...args: any[]) {
      const id = runningActionId                   // 包裹层先读计数器拿本次编号
      const trackedThis = new Proxy(observed, {
        get(target, key) {
          activeAction = id                        // 读状态也刷一遍：getter 期间本动作仍在活动
          return Reflect.get(target, key)
        },
        set(target, key, value) {
          activeAction = id                        // 写状态刷一遍：随后触发的变更事件就能贴上本动作编号
          return Reflect.set(target, key, value)
        },
      })
      activeAction = id
      // 模拟源码里「开始」订阅回调的后自增：返回 id，计数器才 +1
      const groupId = runningActionId++
      timeline.push({ kind: 'start', groupId })
      original.apply(trackedThis, args)            // 动作体内每次读写状态，Proxy 都重刷 activeAction
      activeAction = undefined                     // 原动作一返回就清空（连 Promise 也不等）
      timeline.push({ kind: 'end', groupId })
    }
  }
}

patchForGrouping()

store.bumpAndPing()   // 经动作：变更都该带分组标签
observed.count = 99   // 裸改（不经动作）：分组标签为空，落单

console.log(timeline)
```

跑出来的时间线是这样的：

| # | 事件 | groupId | 说明 |
|---|------|---------|------|
| 1 | 🛫 start bumpAndPing | 0 | 外层开始 |
| 2 | mutation count | 0 | 外层第一次 count++ |
| 3 | 🛫 start ping | 1 | 内层开始 |
| 4 | mutation count | 1 | 内层 count++ |
| 5 | mutation tag | 1 | 内层 tag 赋值 |
| 6 | 🛬 end ping | 1 | 内层返回 |
| 7 | mutation count | 0 | 外层第二次 count++，Proxy 重刷回 0 |
| 8 | 🛬 end bumpAndPing | 0 | 外层返回 |
| 9 | mutation count | undefined | 裸改，落单 |

第 7 行是整段演示的灵魂：内层动作返回时 `activeAction` 已经被清空，但外层的下一次 `this.count++` 经由 Proxy 又把它刷回了外层编号 0。要是没有这个重刷，这一行的 groupId 就会是 undefined，和外层断了链。

## 6. 执行轨迹

演示为了紧凑，把"开始"事件合并进了归组包裹层。真实源码里，归组包裹层和触发"开始"事件的动作订阅是分开的两层：第 7 章的核心动作包裹层在内、devtools 的归组包裹层在外。下面按真实源码的两层结构，拿"首次调用 `bumpAndPing`"走一遍编号时序，假设全局计数器 `runningActionId` 从 0 开始。

1. 用户调用 `store.bumpAndPing()`，最先进入的是 devtools 的归组包裹层（它是替换掉原动作的最外层）。
2. 包裹层读计数器：`_actionId = runningActionId`，此刻计数器还是 **0**，所以 `_actionId = 0`。
3. 设 `activeAction = 0`，然后调用被它包在里面的原动作（即第 7 章的核心动作包裹层）。
4. 核心包裹层在跑动作体之前，先触发"开始"订阅回调；回调里 `groupId = runningActionId++`，后自增：返回自增前的值 **0**，计数器这才变成 1。于是 🛫 start 事件的 groupId = 0。此刻三处都是 0：`_actionId`、start 事件的 groupId、`activeAction`。它们相等，是因为包裹层读计数器和"开始"回调自增都发生在计数器还是 0 的同一个窗口里，并不是谁先分配了编号再传给谁。
5. 动作体执行第一个 `this.count++`：经 Proxy 的 set 陷阱，`activeAction` 被重刷为 0，状态变更订阅此刻推一条事件，带上的 groupId = `activeAction` = 0。
6. 动作体调用 `this.ping()`：进入 ping 的归组包裹层。`_actionId = runningActionId`，此刻计数器已是 1，所以 `_actionId = 1`；设 `activeAction = 1`；调用核心包裹层触发"开始"回调，`groupId = runningActionId++` 返回 1，计数器变 2，start 事件 groupId = 1。
7. ping 动作体里 `this.count++`、`this.tag = 'pinged'`：经 Proxy 把 `activeAction` 重刷为 1，两条变更事件 groupId 都是 1。
8. ping 动作体返回，触发"结束"订阅回调推一条 🛬 end（groupId = 1）、并把 `activeAction` 清空。
9. **回到 bumpAndPing 动作体**，执行第二个 `this.count++`：这一步是整条轨迹的关键。此刻 `activeAction` 已被内层清空成 undefined，但这次状态访问走的是**外层** bumpAndPing 的 Proxy（外层包裹层的这层栈帧还活着），set 陷阱把 `activeAction` 重新刷回 0，于是这条变更事件 groupId = 0，正确归回外层。这就是 Proxy 重刷在做的事：动作体自己在栈里还活着，Proxy 就能源源不断地把标记夺回来。
10. bumpAndPing 动作体返回，核心包裹层推 🛬 end（groupId = 0），归组包裹层清空 `activeAction`。

整组结束，调试器拿到的是：1 条 start(0) + 1 条变更(0) + 1 条 start(1) + 2 条变更(1) + 1 条 end(1) + 1 条变更(0) + 1 条 end(0)，按 groupId 折叠成"bumpAndPing 套 ping"的嵌套两组。若用户不调动作、直接 `$patch` 或改 `$state`，状态订阅照常推事件，但 `activeAction` 从头到尾是空的，事件 groupId 全为 undefined，散落在时间线上不归任何动作。

## 7. 教学简化说明

本章演示故意省略了一堆东西，只留"归组"这根主线：真实的 Vue DevTools API、检查器树和面板的格式适配（把 Pinia 内部形状翻译成面板期望的节点和字段）、从面板直接编辑、复制、粘贴、导入导出状态等交互、热更新时补一条事件并刷新面板、store 销毁时刷新面板、可写计算属性在面板里能否被编辑的判定，统统没演。演示里 Proxy 的 set 陷阱身兼"重刷标记"和"推变更事件"两职，真实源码里这两件事是分开的（Proxy 只刷 `activeAction`，变更事件由独立的状态订阅触发），合并只为演示紧凑。

## 8. 小结

可观测性的难处从来不在于"看见变更"，而在于把零散的变更挂回引发它的那个动作。Pinia 的做法是复用本就存在的两条变更管道当事件源，再用一个 Proxy 在动作执行期间反复刷写"当前动作"标记，让被动触发的变更自动贴上分组标签；代价是这套归组只对 Options API 的同步动作有效，且整层只活在开发构建里。下一章换到服务端渲染：状态要从服务端原样搬到客户端，这套只在客户端活着的观测层只是小麻烦，真正棘手的是更早那根全局活跃指针会跨请求串味。
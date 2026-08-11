# DevTools 集成：作为 Pinia 插件的可观测层

> 本章属于 system 层。前置：插件系统、订阅系统、状态变更模型。
> 学完你能用一句话讲清：整套可观测层为什么不侵入核心、靠什么把动作和状态变更缝合成因果、又怎么在生产里整体消失。

## 1. 为什么需要它（设计动机）

上一章把热更新讲完——dev 下 store 怎么就地换实现而不丢状态。可一旦你想在面板里追问「刚才那个 state 是被哪一次调用改的」，热更新帮不上忙。本章接的就是这个问题：调试时怎么把一个 store 在干什么「看见」。

调试一个 store，最容易撞上两个空白。第一，状态被改了，你不知道是哪一次调用改的——`count` 从 1 变成 2，时间线上只有一条孤立事件，没人告诉你它是谁动的。第二，你刚触发了一个动作，紧接着状态变了一片，但这两条流——动作流和状态流——是独立播出的，对不上号；时间线上看像两部不相干的电影。

再加上一个硬约束：核心一直追求「最小可用、可 tree-shake」，调试代码不能焊死进核心。一旦焊死，生产包体被这部分代码永远拖大，运行时也要为每条 mutation 付一次录制的代价——而生产用户根本不需要这套东西。

于是这套设施被做成一个普通插件——和用户自己写的插件走同一条装配通路、无任何特权。它要解决的就是：在「不侵入核心」的前提下，把动作流和状态流缝合回因果链，并且能在生产期被整体剔除。

## 2. 核心思想

DevTools 是核心的**旁观者**：不直接读 store 内部、也不轮询状态，而是复用核心对外的两个订阅频道去听事件，再把事件翻译成时间线。但订阅频道只告诉你「动作发生了」「状态变了」——它不知道两者间的因果。所以可观测层还得再做一件事：在动作执行的那段窗口里给所有冒出来的状态变更事件打上同一个分组号，把原本散落的事件重新缝合成「这次变更由这次动作引起」。

## 3. 心智模型

数据上一共四样东西：
- 一个**时间线层**（mutations layer），每个事件带 `groupId`；
- 一个**检视器**（inspector），展开 store 树、可编辑 state；
- 一个**模块级可变指针** `activeAction`，记录「当前正在跑哪个动作」，没跑就是 `undefined`；
- 一个**录制开关** `isTimelineActive`，告诉订阅回调「现在该不该把事件上时间线」。

装配分两段。第一段在 `app.use(pinia)` 时——此刻还没任何 store，但面板得先存在；于是建好时间线层 + 检视器的空壳、登记复制/粘贴/导入/导出这些全局动作。第二段在每个 store 装配时——插件被装配通路调用，拿到这个新生的 store；这时给它挂上 `$onAction` 和 `$subscribe` 两个 **detached** 订阅（detached 是因为 store 是长生命周期对象，订阅不能被某个临时作用域带走），同时给它的每个 action 套一层代理。

之后流程是：用户调 action → 代理进入、设 `activeAction = n` → action 体改 state → `$subscribe` 频道触发、事件带 `groupId = n` → action 同步返回、`activeAction` 清空。用户在面板里编辑 state 时，编辑入口先把 `isTimelineActive` 关掉再写、写完再开；订阅回调首行 `if (!isTimelineActive) return` 把这次自激回响吞掉。

最后整个注册被一个编译期常量 `__USE_DEVTOOLS__` 门控；生产构建里它是 `false`，整段注册就是死代码，被打包器整体剔除。

## 4. 关键权衡

### 把可观测层做成插件，而不是核心内置

DevTools 想感知状态与动作，但选择**不**在核心里给它开专用接口、**不**让它在装配通路里享有特权——它就是一个普通插件，经 `pinia.use(devtoolsPlugin)` 入队、和用户插件排同一个队列，装配时拿到的就是标准的 `{ app, store, options }` 上下文。

换来两件事：一是核心与可观测彻底解耦——核心代码里看不到一处「为 devtools 留的钩子」，删掉这个插件，核心行为不变；二是整个可观测层可以被生产构建 tree-shake 掉，只要那个编译期常量是 `false`，整套代码就消失。

代价是它想感知什么，只能复用核心**对外的**订阅频道——表达力被频道能提供什么所限。它问不出「这个变更属于哪个 action」，因为订阅频道根本没提供这种信息；这正是为什么下面还要再造一层因果归因。

**本质矛盾**：核心要「干净、最小、可剔除」 vs. 调试要「看穿一切细节」——这两个需求在生命周期上永远打架。把它做成插件、再用编译期门控切成两份代码，是这一族矛盾的通解骨架（React DevTools、Vue DevTools 都是同一招）。

### 给动作套代理，把两条独立流缝合成因果

`$onAction` 告诉你「动作开始了」、`$subscribe` 告诉你「状态变了」，但两边的事件**没有共同键**能把它们关联起来。要让时间线上「increment 起飞」和「count 变更」折叠成一组，得自己造一个共同键。

办法是给每个 action 外层套一层 wrapper（option store 进一步包成 Proxy）：进入时令模块级 `activeAction = n`，状态订阅事件就带 `groupId = n`；动作同步返回时清空 `activeAction`。这样同一个动作引发的所有状态变更事件，都带同一个 `groupId`，时间线就能折叠显示。

代价是这层包裹是**侵入式**的——它替换了用户写的 action、改了 `this` 的指向。对 setup store 更尴尬：它的 action 是闭包、不经 `this` 访问 state，Proxy 拦不到内部访问，所以干脆不套、只直接设 `activeAction`。更尖锐的代价是**异步归因失效**：`await` 之后的 state 变更发生时，`activeAction` 已经被清空——因为包裹器在动作同步返回那一刻就 reset 了它，跨不过微任务边界。源码注释直说，要等 tc39 的 async-context 提案落地才能精确归因。

**本质矛盾**：「想给一次动作调用画边界」 vs. 「动作可能是异步的、边界会延后到 `await` 之后」——这是所有「动作追踪」族问题在 JS 异步模型下的共同限制。

### 编辑状态时暂停录制，避免面板改自己

用户在检视器里改 state，这次写操作会流经 `$subscribe` 频道。如果不处理，会触发一条假的「状态变更」事件：面板刚改完，时间线上立刻多一条「用户改了状态」，让人无法分辨哪些事件是代码触发的、哪些是面板触发的——回环噪音。

办法是编辑入口前后成对切换录制开关：改之前 `isTimelineActive = false`，调 `payload.set` 写状态，改之后 `isTimelineActive = true`。订阅回调首行 `if (!isTimelineActive) return` 把这次回响吞掉。

**本质矛盾**：和第 5 章「打补丁期间暂停 watcher」、第 6 章「补丁期间关掉监听」是**同一族**——「自己内部要触发一次通知」 vs. 「不希望这次通知被订阅者当成外部事件」。「暂停 → 操作 → 恢复」是这一族的通解骨架，本章只看它在可观测侧的镜像，不重讲协调机制本身。

代价薄到一句话点过：每条编辑入口必须成对维护这个开关（漏一处就回环），且要接受「编辑期间的订阅通知被静默丢弃」这一约定——它不是被延迟，是真的丢了。

### 用编译期开关换生产期整体消失

`__USE_DEVTOOLS__` 是个编译期常量，由构建配置定义为 `(__DEV__ || __VUE_PROD_DEVTOOLS__) && !__TEST__`；生产默认 `false`。注册入口写成 `if (__USE_DEVTOOLS__ && IS_CLIENT) pinia.use(devtoolsPlugin)`，整段在 prod 是死代码、被整体剔除。

换来零体积、零运行时开销——生产用户既不为这套代码付包体，也不为它付「每次 mutation 都被录制」的运行时代价。

代价是要在构建配置里维护这个常量的多份目标取值（不同产物给不同值），源码里凡涉及 devtools 的地方都要成对写守卫判断，条件分支的维护成本不低。

**本质矛盾**：「调试期要尽可能多埋观测点」 vs. 「生产期要尽可能干净」——把这两个需求用一个编译期开关切成两份代码，是这类「可观测性」问题的通用骨架。

## 5. 最小原理演示

下面这段几十行的脚本只演透两条核心权衡——**因果缝合指针**与**录制开关防自激**。它故意不接 Vue、不接 devtools-api 宿主，只用普通对象和回调假扮订阅频道，让因果归因和防自激这两件事能直接读出来。复制进 `node`/`bun` 就能跑。

```ts
// 极简 store：state + 两个对外订阅频道（动作 / 状态变更）
function makeStore() {
  let count = 0
  const actionListeners: Array<(e: any) => void> = []
  const stateListeners: Array<(e: any) => void> = []
  return {
    state: { get count() { return count } },
    $onAction(fn: any) { actionListeners.push(fn) },
    $subscribe(fn: any) { stateListeners.push(fn) },
    // 原始 action：它和可观测层没有任何耦合
    increment() {
      actionListeners.forEach(fn => fn({ name: 'increment', phase: 'before' }))
      count++
      stateListeners.forEach(fn => fn({ newValue: count }))
      actionListeners.forEach(fn => fn({ name: 'increment', phase: 'after' }))
    },
    // 直接改 state 的旁路：演「面板编辑入口」时用
    _writeCount(v: number) {
      count = v
      stateListeners.forEach(fn => fn({ newValue: count }))
    },
  }
}

// 因果缝合指针：进入动作时设值，事件带它当 groupId
let runningActionId = 0
let activeAction: number | undefined
// 录制开关：编辑期间关掉，吞掉自激事件
let recording = true

function attachDevtools(store: ReturnType<typeof makeStore>) {
  const timeline: any[] = []

  // 听动作频道：每次调用 ++ 出一个新 id，挂在 runningActionId 上
  store.$onAction(({ name, phase }: any) => {
    if (phase === 'before') {
      runningActionId++
      timeline.push({ kind: 'action start', data: { name }, groupId: runningActionId })
    }
  })

  // 听状态频道：事件带「当前正在跑的动作」当 groupId；编辑期间直接吞掉
  store.$subscribe(({ newValue }: any) => {
    if (!recording) return
    timeline.push({
      kind: 'state change',
      data: { count: newValue },
      groupId: activeAction,
    })
  })

  return timeline
}

// 把 action 替换成 wrapper：把 $onAction 发的号同步到 activeAction 指针，
// 让随后由 state 变更触发的事件能带上同一个 groupId
function patchActionForGrouping(store: any) {
  const original = store.increment
  store.increment = function (...args: any[]) {
    activeAction = runningActionId  // 复用 $onAction 刚 ++ 出来的号
    const ret = original.apply(this, args)
    activeAction = undefined  // 同步返回后清空——这就是「await 之后归因失效」的根源
    return ret
  }
}

// 演示用例
const store = makeStore()
const timeline = attachDevtools(store)
patchActionForGrouping(store)

store.increment()  // 用户调 action
store.increment()
recording = false; store._writeCount(99); recording = true  // 面板编辑入口

console.log(timeline)
// 输出：每条 state change 都和某条 action start 共享同一个 groupId；
//      _writeCount(99) 触发的状态事件被吞，timeline 里没有它。
```

读这段代码时盯住三行：`runningActionId++`（动作频道发号）、`activeAction = runningActionId`（包裹器把号同步到指针）、`if (!recording) return`（开关吞自激）。其他都是为了让这三行能跑而存在的脚手架。

## 6. 执行轨迹

输入：用户在组件里调 `store.increment()`，动作体里 `count++`。

1. **动作频道触发**——核心装配时建的 `$onAction` 包裹器先入，回调里 `runningActionId++`（变成 1），推入「action start」事件，`groupId = 1`。
2. **包裹器进入**——`patchActionForGrouping` 替换后的 `increment` 被调，第一行 `activeAction = runningActionId`——此刻 `runningActionId` 是 1，所以 `activeAction = 1`。
3. **原 action 体执行**——`count++`，store 内部走到 `$subscribe` 触发点。
4. **状态订阅回调被调**——先看录制开关：`recording` 是 `true`，继续；构造事件 `{ kind: 'state change', data: { count: 1 }, groupId: activeAction }`——此刻 `activeAction` 还是 1，所以事件的 `groupId` 就是 1。
5. **事件入时间线**——和第 1 步的「action start」事件并排躺着，**同一个 `groupId = 1`**。
6. **原 action 返回**——包裹器最后一行 `activeAction = undefined`，指针清空。
7. **动作频道的 after 钩子触发**——同样清空 `activeAction`（双保险）。

最终时间线上：「action start (groupId=1)」「state change (groupId=1)」两条事件被同一 `groupId` 折叠成一组，UI 上能看到「increment 起飞 → count 变更」这条因果链。

对比：如果动作里写了 `await delay(); count++`，第 3 步先同步返回（包裹器立刻清空 `activeAction`），后面的 `count++` 发生在微任务里——此刻 `activeAction` 已是 `undefined`，状态变更事件的 `groupId` 也是 `undefined`，归因失效。这就是上面权衡里说的「跨不过 `await`」。

## 7. 教学简化说明

本章演示故意省略了：真实的 Vue 响应式（用普通 getter 替代 ref/reactive）、真实的 devtools-api 宿主对接（用 `console.log` 替代 `api.addTimelineEvent`）、检视器 UI 与状态格式化（`_custom` 包装、option store vs setup store 的 state 展开差异）、复制/粘贴/导入导出（直接读写根状态的实现）、`$onAction` 提供的 `before/after/onError` 三段钩子（演示里只用了 before/after）、Proxy 在 option store 中的额外作用（每次属性访问刷新 `activeAction`）、HMR 与 @pinia/testing 边界处理，以及编译期开关的构建配置。这些都不服务于「演透原理」，裁掉。

## 8. 小结

整套可观测层的灵魂是「旁观而不侵入」：复用对外的订阅频道听事件、用动作包裹把因果缝回去、用录制开关挡住面板自激、用编译期常量让生产里整套消失。任何一个状态库想做可观测层，落到最后都是这四件事的某种变体。

下一章离开 dev 视角、转向另一个「全局性」约束：服务端渲染时，那一个根状态怎么序列化、又怎么在客户端水合回各 store。
# DevTools 集成：作为 Pinia 插件的可观测层

你在 Vue DevTools 里调试一个 store，随手点了一下 `increment`，时间线立刻蹦出一串：`increment 起飞`、`count 从 0 变成 1`、`doubleCount 重新算了`。看着挺全，可你盯着它们会犯嘀咕——后面这几条状态变化，到底是不是前面那个动作引起的？万一是另一个定时器改的呢？动作是一条线，状态变化是另一条线，两条线各跑各的，对不上号。

更要命的是另一头：这套能看见「谁在什么时候改了什么」的调试设施，到了生产环境你一行都不想要。它不能拖大你的包，也不能拖慢运行时。

这两个看似无关的诉求——「调试时把动作和状态对上号」和「生产时整套消失」——Pinia 用同一个设计一起解决了：**DevTools 自己就是一个插件**。

## 核心思想：蹲在频道旁边的偷听者

DevTools 和你在 `pinia.use(myPlugin)` 里写的那些插件没有任何特权区别。它不往核心里塞一行代码，而是蹲在核心对外的两个订阅频道旁边「偷听」：

- 一个频道播报**状态变更**（`$subscribe`，深度监听 state）
- 一个频道播报**动作调用**（`$onAction`，包裹每次 action）

这两个频道是前置章「订阅系统」搭好的，DevTools 只是它们的订阅者，把核心事件翻译成时间线事件。但光偷听还不够——两条频道各播各的，DevTools 真正要做的、也是本章唯一的新活儿，是给每个动作套一层代理，把散落的状态变更重新「缝」回到引发它们的那个动作上，让两条线对上号。

频道本身怎么收发、暂停监听怎么协调，前面章节已讲透，这里不重讲。本章只看：这两条独立流怎么被缝合成因果关系，以及整套偷听设施怎么被一个开关整体抹掉。

## 它怎么活下来：分两段注册

想象一下应用刚装好 Pinia 的那一刻——还没人调用过 `useStore()`，所以一个 store 都不存在。但 DevTools 面板得先在那里（不然用户打开面板看到一片空白，会以为坏了）。这就催生了两段注册：

```
app.use(pinia)                              每个 store 首次 useStore()
     │                                            │
     ▼                                            ▼
registerPiniaDevtools()              addStoreToDevtools(store)
建好空的时间线层 + 检视器空壳         给这个 store 挂上监听
（还没有任何 store，先把位置备好）     （订阅它的两个频道）
```

全局层在「还没有任何 store」时就建好时间线和检视器的空壳，让面板一安装就可见；per-store 层等每个 store 出生时再给它挂监听。

那 DevTools 凭什么能「正好赶上每个 store 的出生」？因为它是个普通插件。前置章「插件系统」讲过：每个 store 装配时，核心会把自己经手的插件挨个跑一遍，把 `{ store, app, pinia, options }` 喂给它们。DevTools 就是利用这个钩子，拿到每一个新生的 store——它走的装配通路和你自己写的插件一模一样，没有任何后门。

## 它怎么旁观：复用两个现成频道

拿到 store 之后，DevTools 不会自己去轮询状态（轮询既慢又抓不到「谁改的」）。它直接订阅核心已经搭好的两个频道：

- `store.$subscribe(cb, { detached: true, flush: 'sync' })`：状态一变就被通知。`detached` 让这个订阅不随组件销毁（store 活得久），`flush: 'sync'` 让变更即时上时间线。
- `store.$onAction(cb)`：每次动作被调就被通知，还附送 before/after/onError 钩子。

说人话就是：核心早就把「状态变了」和「动作被调了」两个广播频道架好了，DevTools 只是按个收音机收听，再把听到的翻译成时间线上的事件。频道怎么收发、订阅怎么自动清理，是前置的「订阅原语」「订阅系统」两章的事，这里不重复。

## 本章的主菜：把两条流缝合成因果

偷听到了两条流，但它们是各跑各的。调一次 `increment()`，动作频道播一条「increment 被调了」，状态频道紧接着播一条「count 变了」——可没有任何东西告诉你，第二条是第一条引起的。如果这一刻还有别的代码也在改 state，你根本分不清哪条状态变化归哪个动作。

DevTools 的解法是给每个动作套一层代理（`patchActionForGrouping`）：

```
动作进入
  │  activeAction = 5   ← 给这次调用盖一个「订单号」
  ▼
动作体执行（改 state）
  │  状态频道触发 → 事件带上 groupId = 5   ← 状态变化盖上同一个号
  ▼
动作同步返回
     activeAction = undefined   ← 订单号清空
```

就像快递分拣：每个动作是一个订单号，动作里改的每个状态都盖同一个号。最后按号分堆，面板就能把「increment 起飞」和「count 变更」折叠进同一组，一眼看出因果关系。

这里有两个不显眼但关键的设计抉择：

**为什么只给 option store 套 `new Proxy`，setup store 不套？** option store 的动作体里写的是 `this.count++`，靠 `this` 访问其他属性；Proxy 能在每次属性访问时顺手刷新一下 `activeAction`，保证标记在动作执行的每一刻都活着。而 setup store 的动作是闭包，根本不经 `this`，Proxy 拦不到内部访问，套了也白套，索性不套（代码注释里写明这要等 TC39 的 async-context 提案才能真正解决）。

**为什么跨不过 `await`？** 动作同步返回的那一刻，`activeAction` 就被清空了。如果动作体里有 `await`，那么 `await` 之后再改 state，标记早就没了，这条状态变化归不到这个动作头上。这是被明明白白接受下来的代价——异步动作的归因不精确。

## 编辑时防自激：录一会儿，停一会儿

还有个绕不开的麻烦：你在面板里直接改了 `count` 的值。这次编辑也会改 state，于是也会流经状态频道——不处理的话，面板自己改的状态又被面板当成一条「变更」事件记下来，形成回环噪音（你改一下，时间线多一条；多这条又像是别人改的）。

解法是前置章「状态变更模型」「订阅系统」已经讲透的那个协调族——「改之前暂停、改完恢复」——在可观测侧的镜像：

```
面板编辑入口：
  isTimelineActive = false       ← 关掉录制
  payload.set(...)               ← 改 state，触发状态频道
  isTimelineActive = true        ← 重新打开

状态频道回调开头：
  if (!isTimelineActive) return  ← 录制关着就把这次通知吞掉
```

「暂停监听、事后再恢复」这套协调思想前面章节已展开，这里不重讲原理；本章只看它在可观测侧的样子：编辑期间暂停时间线录制，让面板自己的编辑不被记成新的变更事件。代价是每条编辑入口前后都要成对维护这个开关，并且要接受「编辑期间的订阅通知被静默丢弃」这个约定。

## 生产时整套消失：一个编译期开关

调试设施再好，生产环境也不该带着跑。Pinia 的做法是用一个编译期常量 `__USE_DEVTOOLS__` 把整段注册门控起来：

```ts
// 不是运行时 if，是编译期常量
if (__USE_DEVTOOLS__ && IS_CLIENT && typeof Proxy !== 'undefined') {
  pinia.use(devtoolsPlugin)
}
```

构建配置里，这个常量被定义为 `(__DEV__ || __VUE_PROD_DEVTOOLS__) && !__TEST__`——开发期是 `true`，生产期默认 `false`。于是在生产构建里，上面这整个 `if` 连同 `devtoolsPlugin` 的全部代码都成了死代码，被打包器整体剔除：零体积、零运行时开销。你想在生产也开 DevTools，就显式把 `__VUE_PROD_DEVTOOLS__` 设成 `true`。

## 原理演示：几十行演透因果缝合与防自激

本章机制依赖 Vue DevTools 宿主，强求真跑扩展不现实。下面这段脚本用普通对象模拟核心的两个频道，**存成 `.js` 用 `node` 跑、或用 `bun` 跑 `.ts` 都行**，专演两件事：代理怎么把动作和状态缝进同一个 `groupId`，开关怎么吞掉自激事件。

```ts
// devtools-mini.ts —— 演透「因果缝合」与「编辑防自激」两条核心权衡
// 不依赖 Vue / devtools-api，bun run devtools-mini.ts 即可

// ============ 核心侧：最小 store（对外暴露两个订阅频道）============
function createStore($id, initial, fns) {
  const state = { ...initial }
  const stateSubs = new Set()    // 频道①：状态变更
  const actionSubs = new Set()   // 频道②：动作调用
  const store = { $id, state }
  store.$subscribe = (cb) => (stateSubs.add(cb), () => stateSubs.delete(cb))
  store.$onAction  = (cb) => (actionSubs.add(cb), () => actionSubs.delete(cb))
  // 核心写 state 的统一入口：写完触发状态频道
  store._write = (key, val) => {
    state[key] = val
    for (const cb of stateSubs) cb({ store: $id, key, val })
  }
  // 装配动作：调用时先触发动作频道
  for (const name of Object.keys(fns)) {
    store[name] = (...args) => {
      for (const cb of actionSubs) cb({ name, args })
      return fns[name].call(store, ...args)
    }
  }
  return store
}

// ============ 可观测侧：DevTools 插件 ============
let activeAction               // ← 当前正在运行的动作 id（缝合用）
let actionSeq = 0              // 动作 id 计数器
let isTimelineActive = true    // ← 录制开关（防自激用）
const timeline = []
let eventSeq = 0
const record = (type, data, groupId) =>
  timeline.push({ type, eventId: ++eventSeq, groupId, data })

function attachDevtools(store) {
  // ① 订阅动作频道：发「动作起飞」事件（groupId 取代理③设好的 activeAction）
  store.$onAction((e) => record('action', { name: e.name }, activeAction))
  // ② 订阅状态频道：每条事件带上当前动作作分组号；录制关着就丢弃
  store.$subscribe((e) => {
    if (!isTimelineActive) return              // ← 吞掉自激事件
    record('mutation', { key: e.key, val: e.val }, activeAction)
  })
  // ③ 代理包裹每个动作：进入时打标记，同步返回时清空
  for (const name of Object.keys(store)) {
    if (name[0] === '$' || name[0] === '_' || typeof store[name] !== 'function') continue
    const raw = store[name]
    store[name] = (...args) => {
      activeAction = ++actionSeq               // ← 进入：盖订单号
      try { return raw(...args) }
      finally { activeAction = undefined }     // ← 返回：清空（await 后归因失效）
    }
  }
}

// ============ 跑起来 ============
const counter = createStore('counter', { count: 0 }, {
  increment() { this._write('count', this.state.count + 1) },
})
attachDevtools(counter)

console.log('场景 A：调 counter.increment()，看因果缝合')
counter.increment()
console.log(timeline)
// 输出：action(eventId=1, groupId=1) + mutation(eventId=2, groupId=1)
// → 动作与它引发的状态变更共享 groupId，面板可折叠显示因果

console.log('\n场景 B：面板直接编辑 count，看防自激')
const before = timeline.length
isTimelineActive = false                        // 编辑前关录制
counter._write('count', 99)                     // 改值，流经状态频道
isTimelineActive = true                         // 编辑后恢复
console.log('编辑期间新增时间线事件（应为 0）：', timeline.length - before)
```

跑一下：场景 A 里你会看到动作事件和它引发的状态变更事件**共享同一个 `groupId`**——这就是因果缝合；场景 B 里编辑期间时间线一条都没长——这就是自激被吞。两段代码加起来不到 50 行，每一行都对应下面某条权衡。

## 关键权衡

本章机制集中在「旁观 + 缝合 + 自抹除」这条链上，逐一展开这 4 条；它们之间互为前提，合起来才回答了开篇那两个诉求。

**1. DevTools 即插件，而非核心内置。** 选择把整套可观测层做成一个普通插件、走与用户插件同一条装配通路 → 换来核心与可观测彻底解耦（核心零侵入：连 `_isOptionsAPI` 这种「我是不是 option store」的标记，都是 DevTools 自己写进 store 的，核心装配逻辑里根本没这个字段）+ 生产期可整体 tree-shake → 代价是它想感知状态与动作时不能直捣核心内部，只能复用核心对外的订阅频道，**表达力被频道能播什么卡死了**：频道没播的，它就看不见；想多看点，就得等核心先把那件事也广播出来。

**2. 用代理包裹动作，重建「动作→变更」因果。** 选择在每个动作外层套一层代理、进入时打一个「当前动作」标记（递增的 `activeAction`）→ 换来时间线里能把一次动作引发的所有状态变更归因、折叠到同一组（靠 `groupId` 缝合，演示的场景 A 就是它）→ 代价有两个：一是对动作做了侵入式代理包裹，要小心绕开响应式追踪的副作用、还要在测试桩（`@pinia/testing`）和热更新边界上各打一个补丁；二是对 setup store 的**异步动作**归因根本不精确——标记在动作同步返回时就被清空，`await` 之后的 state 变更跨不过去，归不到任何动作头上，只能等语言层面的 async-context 提案落地。

**3. 编辑状态时暂停时间线录制，以防自激。** 选择在面板编辑状态期间关掉录制开关、事后再恢复（演示的场景 B 就是它）→ 换来「用户在面板手动改状态」不会被记成一条新的变更事件，避免「我改一下 → 时间线多一条 → 看着像别人改的」这种回环噪音 → 代价是每条编辑入口前后都要成对维护这个开关，漏一处就会漏录或多录，并且要接受一个约定：编辑期间流经状态频道的订阅通知会被静默丢弃——也就是「编辑的那一瞬，别处的订阅者其实没收到通知」。

**4. 编译期开关换取生产期整体剔除。** 选择用一个编译期常量 `__USE_DEVTOOLS__` 门控整段注册 → 换来生产包里完全不包含这套代码（连 `if` 判断本身都被剔除，真正的零体积、零运行时开销）→ 代价是要在构建配置里维护该常量的多份目标取值（dev / test / prod 各一份，prod 还要留一个 `__VUE_PROD_DEVTOOLS__` 给「我就是想在生产开 DevTools」的人），并在源码各处成对写守卫判断，增加条件分支的维护成本——换来的是「默认安全，想开的人显式 opt-in」。

## 小结

DevTools 没有任何特权：它是个普通插件，蹲在核心两个订阅频道旁偷听，再用一层动作代理把两条独立流缝合成「动作→变更」的因果关系。面板自己改 state 时靠录制开关防自激，生产环境靠编译期开关整套抹掉。这四件事合起来，正好回答了开篇那两个诉求——调试时对得上号，生产时整套消失。

值得一提的是，全局的复制 / 粘贴 / 导入 / 导出状态这些操作，全都直接读写那一个 `pinia.state.value`——所有 store 的状态都收在它底下。顺着这条「单一根状态」的线索，下一章《SSR 与状态水合：单一根状态的序列化契约》会讲：服务端怎么把这一个根状态序列化交给客户端，客户端又怎么把它原样灌回每个 store。
# Vue Devtools 集成：把状态变更桥接成时间线，并归因到动作

## 这一章要解决的问题

状态库最难调试的不是「值现在是多少」——控制台随时能看。真正折磨人的是「这个值是怎么变成现在这样的」：你看到 `count` 错了，却不知道是哪个动作、哪次提交、哪条异步链路把它改成了这样。浏览器的调试器只能给你一个静止的快照，给不了变更的**历史**与**归因**。

没有这套机制，开发者只能在每个动作里手动 `console.log`，或在动作体内打断点逆向追踪。Pinia 的解法不是另起一套「偷听状态」的事件源，而是：

> **复用库里已有的两条变更通知通道（`$subscribe` 和 `$onAction`），把它们桥接成外部调试工具能消费的「检查器树刷新 + 时间线事件」；再用一个代理，把每次状态变更归因到触发它的那次动作调用。**

本章就拆解这套桥接是怎么搭起来的，以及它为什么这样设计。

## 自底向上：先把三个零件摆出来

理解整套桥接，先确认三个前置零件（它们来自前面的章节）：

- **`$subscribe(cb, options)`**：状态订阅。store 的 state 一变化，`cb` 就被调用。支持 `{ detached: true }`（脱离当前 effectScope，不随组件销毁）和 `{ flush: 'sync' }`（在变更的同一个同步栈里立即触发）。
- **`$onAction(cb, detached)`**：动作订阅。每次 action 被调用，`cb` 拿到 `{ after, onError, name, args }`；你可以在 `after(result)` 里登记结束回调、在 `onError(err)` 里登记出错回调。
- **插件机制**：`pinia.use(plugin)` 推入的插件，会在**每个 store 装配到末尾**时执行一次，拿到 `{ app, store, options }`。

整套 devtools 桥接的本质，就是把这三样东西拼起来。

## 两条接入通道：全局壳与逐 store 桥接

devtools 分两处接入，时机不同、职责不同：

**全局壳（只跑一次）**：当 pinia 安装到应用时（`install`），若开启了 devtools 且在客户端，调一次 `registerPiniaDevtools`。它建立「一次性设施」——一个「变更」时间线图层、一个检查器（带复制/粘贴/保存/导入四个全局动作，外加「重置某 store」的节点动作），并注册组件检查器钩子（把组件持有的 store 暴露进组件面板）。这套东西跟具体某个 store 无关，建一次够所有 store 用。

**逐 store 桥接（每个 store 各跑一次）**：devtools 自身被写成一个**普通插件** `devtoolsPlugin`，和任何第三方插件走同一条 `pinia.use` 通道。于是它在每个 store 装配末尾自动执行，给那个 store 挂上事件监听。

```
createPinia()
  ├─ pinia.use(devtoolsPlugin)              ← 作为普通插件入队，每个 store 装配时各跑一次
  └─ install(app)
       └─ registerPiniaDevtools(app, pinia) ← 只跑一次：建图层 / 检查器 / 组件钩子

store 装配末尾 → devtoolsPlugin({app, store, options})
  ├─ patchActionForGrouping(...)   ← 代理包动作（为归因做准备）
  └─ addStoreToDevtools(app, store)
       ├─ store.$onAction(...)         ← detached，发 start/end/error 时间线事件
       ├─ watch(自定义属性)            ← 变更 → 刷新 + 时间线事件
       └─ store.$subscribe(...)        ← detached + sync，变更 → 刷新 + 时间线事件
```

**关键权衡**：把整套桥接写成普通插件，换来的是**零侵入核心装配逻辑**、不维护第二套事件源、store 装配到哪它就接到哪。代价是全局壳和逐 store 桥接得分两处写、各自声明一份近乎相同的插件描述，靠共享的「面板标识 / 图层标识」字符串来保持关联。

## 逐 store 桥接：三条监听翻译成两类输出

进入某个 store 时，`addStoreToDevtools` 挂三条监听，每条都把「发生了什么」翻译成**刷新检查器 + 追加时间线事件**：

| 监听 | 触发时机 | 选项 | 产出 |
|---|---|---|---|
| `store.$onAction` | 动作被调用 | `detached: true` | start 🛫 / end 🛬 / error 💥 三个时间线事件 |
| `store.$subscribe` | state 变化 | `detached: true, flush: 'sync'` | 刷新面板 + 一个变更时间线事件 |
| `watch(自定义属性)` | 插件注入的属性变化 | `deep: true` | 刷新面板 + 一个 Change 时间线事件 |

注意动作订阅发的是「调用边界」事件（开始、结束），状态订阅发的才是「真正的字段变化」事件。一个动作往往引发多次字段变化——于是产生多个变更事件，但它们彼此孤立。**怎么知道「这两次字段变化是同一次 `increment` 引起的」？** 这就要靠下一节的归因机制。

## 灵魂：代理归因，把变更串成因果链

这是全章的核心。问题：时间线上，「`increment` 的 🛫」和「`count++` 的变更事件」是两个独立来源分别广播的，devtools 怎么把它们标成同一组？

思路是引入一面**旗子**——一个全局指针 `activeAction`（「当前正在跑哪个动作」）。规则：

1. 动作调用开始时，举起旗子，指向当前动作的序号；
2. 动作体内触发的状态变更，经同步订阅广播成事件时，**事件带上「旗子当前指向的序号」作为 `groupId`**；
3. 动作结束时，降下旗子。

这样，同一个动作的 🛫/🛬 边界事件和它体内触发的所有变更事件，就共享同一个 `groupId`，在时间线上被串成一条因果链。

旗子怎么举？用一个 **Proxy 裹住动作执行期的上下文 `store`**：每当动作体内读写 `this.xxx`（也就是代理的 get/set），代理就把 `activeAction` 重置为当前动作序号。这一步保证了即便发生嵌套调用，旗子也始终指向「最近一次被访问」的动作。

**关键权衡——选项式 vs 组合式的分野**：

- **选项式 store** 的状态变更发生在动作调用栈内、是同步的。用 Proxy 捕获每次 get/set，能精确维持旗子，归因命中（`wrapWithProxy = store._isOptionsAPI` 为真时走这条路径）。
- **组合式 store** 的动作可能返回 Promise，状态变更发生在 `.then` 里，此时动作体早已返回、旗子已被清空、Proxy 也无能为力。于是退化成**粗粒度窗口**：只在「调用前立旗、调用后清旗」的同步区间内有效，异步链路上的变更无法归因。源码注释直接指向「需要语言级异步上下文（async context 提案）」才能彻底解决。

这不是疏漏，而是同步世界观的天然边界——Pinia 选择了「同步窗口内做到精确，异步窗口如实退化」的诚实方案。

## 为什么必须是「同步 + 脱离」订阅

`store.$subscribe` 在这里刻意用了两个选项：`detached: true` 和 `flush: 'sync'`。这不是随手选的，每一个都对应一条权衡：

**`detached: true`（脱离作用域）**：让订阅和整个应用同生命周期，不随某个组件销毁而漏接事件。代价是要自己负责清理（但 devtools 桥接本来就要常驻）。

**`flush: 'sync'`（同步刷新）**：这是**归因能命中的必要条件**。状态变更必须在「旗子还没被清掉」的同一个同步栈里立即触发回调。如果用默认的异步批处理刷新，动作体执行完毕、旗子被清空后回调才跑，`activeAction` 已是 `undefined`，变更事件将失去 `groupId`，归因彻底落空。一句话：**没有同步订阅，代理归因就是空中楼阁。**

> 记住这一点：`flush: 'sync'` + 「旁观所有变更」是归因正确性的前提，但它也直接引出下一个麻烦——回环。

## 防回环：用一个开关挡住「自己的写入」

现在有个新麻烦：devtools 自己也会**写**状态——当用户在调试面板里直接编辑某个字段、或导入一份状态时，devtools 调用 `store.$patch` 写入。这次写入同样会触发 `store.$subscribe`，于是变更又被广播成时间线事件……而它根本不是「外部变更」，是 devtools 自己干的。这就形成了回环。

解法是一个全局开关 `isTimelineActive`，状态订阅回调开头先查它（伪码，只表达拦截思想）：

```ts
store.$subscribe((mutation, state) => {
  refreshInspectorPanel()          // 刷新检查器（这条始终要做）
  if (!isTimelineActive) return    // 开关关着 → 本次不广播时间线事件
  emitTimelineEvent({ groupId: activeAction, /* ... */ })
}, { detached: true, flush: 'sync' })
```

而每次 devtools 主动写状态时，就把开关在「写入前后」短暂切换：

```
处理用户在面板里的编辑：
  isTimelineActive = false        ← 关广播
  write(store, path, value)       ← 写入（会触发 $subscribe，但被开关挡下）
  isTimelineActive = true         ← 恢复
```

**关键权衡**：用一个手动的全局开关换「旁观与编辑不互相干扰」。简单、有效；代价是这个开关是共享可变状态，任何写入路径都得记得切换，漏一处就回环。

## 隐式时序契约：序号自增与读取的耦合

代理归因的正确性，强依赖一处**跨函数的隐式时序**：

- **自增**动作序号 `runningActionId++` 发生在 `$onAction` 的 **before 回调**里（用来产生这次调用的 `groupId`）；
- **读取**同一个序号发生在代理包装的动作体第一行（`_actionId = runningActionId`，让变更事件能对上这个 `groupId`）。

两者通过一个**共享的全局计数器**隐式协同。它要求动作包装严格按这个顺序执行：

```
用户调用 action()
  → pinia 动作包装器先触发 $onAction before 回调
      → runningActionId++   得到 groupId = 1，广播 🛫
  → 再执行「真正的动作」（即 devtools 代理包装后的函数）
      → _actionId = runningActionId（读到刚自增的 1）
      → 立 activeAction = 1 的旗子
      → 执行原始动作体：this.count++ / this.history.push(...)
          → 每次字段写入触发同步 $subscribe
          → 变更事件带 groupId = activeAction = 1
  → 动作体返回
      → 降旗：activeAction = undefined
  → pinia 触发 $onAction after 回调 → 广播 🛬（groupId = 1）
```

**关键权衡**：自增与读取这两个本可独立演化的函数，靠一个全局计数器隐式耦合。源码注释明确写着「序号在 before 钩子里自增」，这是这个契约的唯一凭据。一旦上游调整了动作包装的执行顺序（先跑动作体、再跑 before），归因将整体错位却不会有任何报错——这是这套设计最脆弱的一环。

## 一个完整的执行轨迹

**输入**：用户调用 `store.increment()`，其内部执行 `this.count++` 和 `this.history.push(count)`。

**关键中间态**：
1. `$onAction` before 回调拿到 `groupId = runningActionId++ = 1`，广播 🛫 `increment`（groupId=1）；
2. 代理包装的动作体执行，旗子 `activeAction` 指向 1；
3. `this.count++` 触发同步 `$subscribe`，广播变更事件（groupId=1）；
4. `this.history.push(...)` 再触发一次同步 `$subscribe`，广播变更事件（groupId=1）；
5. 动作体返回，旗子降下；`$onAction` after 回调广播 🛬 `increment`（groupId=1）。

**输出**：时间线上四个事件被同一个 `groupId=1` 串成一条「increment 引发了 count 与 history 两处变更」的因果链。这正是没有这套机制时，你在控制台里永远看不到的东西。

## 从零复刻：用几十行还原「代理归因」

把上面几节的机制剥离一切工程外壳，核心就两样：一面旗子 `activeAction`、一个自增计数器 `runningId`。下面这段演示**只演「为什么必须同步订阅、为什么代理只能在同步窗口内生效」这条权衡**，故意省略检查器渲染、导入导出、组件面板、类型体操等外壳。

```ts
// === 全局旗子与计数器 ===
let runningId = 0
let activeAction: number | undefined

// === 模拟「时间线」：收集所有事件 ===
const timeline: { title: string; groupId?: number }[] = []
const emit = (title: string, groupId?: number) => timeline.push({ title, groupId })

// === 同步状态订阅：在变更的同一同步栈触发，事件归到 activeAction ===
let onMutation: (() => void) | null = null
const subscribeState = (cb: () => void) => { onMutation = cb }

// === 用 Proxy 把每个动作裹起来：get/set 立旗 + 同步通知 ===
function patchActions(store: any, names: string[]) {
  for (const name of names) {
    const original = store[name]
    store[name] = function (this: any, ...args: any[]) {
      const id = runningId                      // 读 before 钩子里自增过的序号
      const tracked = new Proxy(store, {
        get(t, k) { activeAction = id; return Reflect.get(t, k) },
        set(t, k, v) {
          activeAction = id                      // 立旗
          Reflect.set(t, k, v)
          onMutation && onMutation()             // 同步触发订阅（相当于 flush:'sync'）
          return true
        },
      })
      emit(`🛫 ${name}`, id)                      // before：开始事件
      activeAction = id
      original.apply(tracked, args)
      activeAction = undefined                    // 降旗：同步窗口到此结束
      emit(`🛬 ${name}`, id)                      // after：结束事件
    }
  }
}

// 回调里读「旗子当前指向」，而非闭包里的 id —— 这正是同步订阅归因的关键
subscribeState(() => emit('字段变更', activeAction))
```

构造一个会连续改两个字段的动作，跑一遍：

```ts
const store = {
  count: 0,
  history: [] as number[],
  increment() { this.count++; this.history.push(this.count) },
}
patchActions(store, ['increment'])   // 把动作包成可归因的

runningId++                          // 模拟 $onAction before 钩子里的自增
store.increment()
console.log(timeline)
```

输出（四条事件共享同一个 `groupId=1`）：

```text
[ { title: '🛫 increment', groupId: 1 },
  { title: '字段变更',     groupId: 1 },
  { title: '字段变化',     groupId: 1 },
  { title: '🛬 increment', groupId: 1 } ]
```

现在做一个对照实验，验证「同步」为何是命中的必要条件：把 `onMutation` 的触发推迟到动作体返回之后（用 `Promise.resolve().then(onMutation)` 模拟异步刷新）。你会看到两条「字段变更」的 `groupId` 变成了 `undefined`——因为回调跑的时候旗子早已降下。这正是组合式 store 异步动作无法归因的缩影。

> 这段演示不追求贴近真源（真源还处理了 `_isOptionsAPI` 分支、testing 旁路、HMR 升级、错误事件等），它只回答一个问题：**为什么一个 Proxy 加一个同步订阅，就能把离散的变更事件串成因果链。**

## 没有展开的边界细节

以下是工程外壳，与核心原理无关，留作索引：

- **鸭子类型判定根实例**：靠 `_a` + `install` 判断当前是不是根 pinia，决定检查器路径前插 `state` 还是 `$state`。
- **可写计算属性才可编辑**：面板里能编辑的 getter 取决于它是否为「非只读 ref」（即 writable computed），只读 getter 不可编辑。
- **选项式 store 的组件面板特例**：在组件检查器里以 `_custom` 形式展示，附带「重置」按钮。
- **testing 模式旁路**：当 `store._p._testing` 为真时跳过代理包装，避免覆盖 `@pinia/testing` 替换掉的动作。
- **HMR 升级**：`_hotUpdate` 被包一层，热更新后的新动作会再次经过代理包装，保证归因不随热更新失效。
- **导入导出**：复制/粘贴走剪贴板 API、保存/导入走 JSON 文件；恢复时区分「store 已实例化（局部 patch）」与「未实例化（直接写根状态字典）」。
- **全局对象暴露**：把根实例和当前选中 store 挂到 `globalThis`，方便控制台直接调试。

## 源码对照

正文刻意省去了行号，下面给出最关键的几处落点，供按图索骥（前四处在 `packages/pinia/src/devtools/plugin.ts`，第五处在 `createPinia.ts`）：

- `patchActionForGrouping`：代理归因的实现——Proxy 的 get/set 把 `activeAction` 重置为当前 `_actionId`；选项式走代理，组合式退化为立旗/降旗窗口（约 525–565 行）。
- `$onAction` before 回调里的 `groupId = runningActionId++`：序号自增与 🛫/🛬/💥 边界事件（约 344–400 行）。
- `store.$subscribe(cb, { detached: true, flush: 'sync' })`：同步订阅，回调开头 `if (!isTimelineActive) return` 拦截回环（约 428–471 行）。
- `isTimelineActive` 在面板编辑时「写入前关、写入后开」的切换（约 279–281 行）。
- 双入口挂载与三重守卫 `__USE_DEVTOOLS__ && IS_CLIENT && typeof Proxy !== 'undefined'`（约 55–60 行，`pinia.use(devtoolsPlugin)`）。
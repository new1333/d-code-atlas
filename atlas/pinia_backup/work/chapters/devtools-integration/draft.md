# Vue DevTools 集成：让状态库从黑盒变成面板

## 一个真实的痛点

你装好了 Pinia，状态库跑得也正常。某天你看一个组件，发现 `user.profile.name` 莫名变成空字符串了。是哪个 action 改的？是 `$patch` 改的还是直接赋值？这一次 action 调用里到底改了几个字段？没有 DevTools 你基本是两眼一抹黑。

DevTools 集成要做的事就是：把已经在 store 内部跑着的那些信号——action 进出、state 变更、自定义属性变化——拉出来摆到 Vue DevTools 的面板上，让你能看见、能编辑、能导出。说人话就是：**它本身没有新发明什么状态管理机制，它只是把已有的几条订阅通道接到了 Vue DevTools 提供的 API 上**。

## 自底向上：先理清接入路径

DevTools 接入分两条独立路径，搞清谁先跑、跑几次，后面所有事都好理解。

### 路径一：app.use 时跑一次的「应用级注册」

`createPinia()` 一创建，就把一个叫 `devtoolsPlugin` 的特殊插件塞进待安装队列。等到 `app.use(pinia)` 真正跑 install 的时候，先做一件事：调一次 `registerPiniaDevtools(app, pinia)`。这一步跟任何具体 store 都没关系，它只做三件事：

1. 建一个叫 `pinia:mutations` 的时间线层（timeline layer），所有变更事件都往这里发
2. 建一个叫 `pinia` 的检查器（inspector），就是右侧那块展示 state/getters 的面板
3. 注册 4 个全局动作：复制 state、粘贴 state、导出 JSON 文件、从文件导入 state

注意时机——此时一个 store 都还没建。但只要你打开 DevTools，时间线层和检查器的骨架就已经在了，这是为了让你「先看到面板，再建 store」，体验上不卡。

### 路径二：每建一个 store 跑一次的「store 级挂载」

之后你代码里第一次调 `useStore()`，store 才真正被建出来。在它构建链路的最后一段（插件应用阶段），`devtoolsPlugin` 这个函数会被调一次，专门为这个 store 做事：

- 判断它是 options API 还是 setup store
- 把每个 action 包成「打标记 → 跑原 action → 清标记」的 wrapper
- 调 `addStoreToDevtools(app, store)`，给这个 store 挂上订阅

所以会看到：**应用级注册跑 1 次，store 级挂载跑 N 次（N = store 数量）**。两边都是用 Vue DevTools 提供的 `setupDevtoolsPlugin` 接进去的，用的是同一个插件 id（`'dev.esm.pinia'`），Vue DevTools 内部按 id 去重，不会出现两个面板。

## 把订阅原语翻译成时间线事件

这一节是核心。Pinia 内部本来就有三套订阅/拦截机制——上一章讲插件系统时已铺垫过。DevTools 集成做的事，说白了就是给这三套机制各加一个回调，把回调里收到的东西转成「时间线事件」塞给 DevTools。

| 已有原语 | 挂法 | 转成什么事件 |
|---|---|---|
| `store.$onAction` | `detached: true`，跨 scope 存活 | start / end / error 事件 |
| `store.$subscribe` | `detached: true, flush: 'sync'` | mutation 事件 |
| 自定义属性 | 对每个 `_customProperties` 起 `watch(..., { deep: true })` | inspector 刷新 + 时间线事件 |

注意 `$subscribe` 那行的 `flush: 'sync'`——这是关键。它保证 mutation 一发生，回调**立刻**触发，不被 Vue 排到下一个 tick。原因下一节讲。

## 真正的难点：一次 action 和它内部的 N 个 mutation 串起来

光把事件发出去还不够。Vue DevTools 的时间线里事件是可以分组的——同一次 action 调用里产生的所有 mutation 应该归到同一组，前面带一个共同的颜色块。这样你才能一眼看出「这 5 个 mutation 是这一次 `addToCart` 触发的」。

那这个「组」靠什么关联？最直觉的做法是：action 进来时分配一个 id，把这个 id 作为这次调用里所有事件的 `groupId`。问题来了——**action 调用过程中，`$subscribe` 回调被触发时，怎么拿到「当前正在跑的 action 的 id」？**

JS 没有内置的「async context」（这是 Node 才有的实验能力，浏览器里没有），你不能像读 threadLocal 那样从任何位置读到「我当前在哪个 action 里」。Pinia 的解法简单粗暴：**用一个模块级全局变量 `activeAction` 当公共留言板**。

类比一下：这就像一块谁都能看见的办公室白板。action 进来时往白板上写「现在跑的是 id=2」，跑完擦掉。订阅回调被触发时，抬头看一眼白板，就知道现在归到哪一组。

时序大致是这样：

```
用户调 action foo()
  ↓
wrapper（被 patchActionForGrouping 替换过）干三件事：
  1. runningActionId++ → 拿到一个新 id，比如 2
  2. activeAction = 2          ← 往白板上写当前 id
  3. 同步跑原 action.apply(store)
       ↓
       action 函数体里每次 store.x = y 触发响应式
       ↓
       $subscribe 回调同步触发（因为 flush: 'sync'）
       ↓
       回调里 addTimelineEvent({ ..., groupId: activeAction })
                                      ↑ 抬头看白板
  4. action 返回
  5. activeAction = undefined  ← 擦白板
```

整个链路靠的是「严格同步」：从写 id 到擦 id，中间所有 mutation 必须在同一个调用栈里发生，回调才能从白板上读到正确的 id。一旦中间插入任何 `await`，白板上的值就不可信了。

### options store 用 Proxy 兜底

options API store 有个麻烦：action 里通过 `this.count = 5` 改 state。这个 `this` 在 wrapper 里是受控的——所以 Pinia 在调原 action 之前，**把 `this` 换成一个 Proxy 包过的 store**，Proxy 的 get/set 陷阱里顺手把 `activeAction` 重置为当前 id。

为什么需要这个「重置」？因为 `$onAction` 的 before 钩子也会触发 `activeAction` 修改（模块级还有别的订阅器在跑），所以 Proxy 在每次 get/set 上「刷一下」id，确保 action 内部读到的 `activeAction` 永远是当前 action 的 id，不会因为外部订阅器中途插一脚而被改乱。

### setup store 没法用 Proxy——这是软肋

setup store 的 action 是这样写的：

```js
const useStore = defineStore('counter', () => {
  const count = ref(0)
  function inc() { count.value++ }   // 通过闭包 ref 改，不经过 store 对象
  return { count, inc }
})
```

`inc` 改的是闭包里的 `count.value`，根本不碰 store 对象。Proxy 拦的是对 store 的读写，闭包写入 ref 完全绕过去，Proxy 在这里就是个摆设。

所以 setup store 那条路只能靠「写 id → 跑 → 擦 id」三段——**没有 Proxy 兜底**。同步 action 还能凑合用，因为整个 action 体是同步执行的，中间不会有人改 `activeAction`。但 action 里一旦有 `await`：

```js
async function incLater() {
  count.value++              // mutation1：白板上还是 2
  await api.fetch()
  count.value++              // mutation2：白板已经被擦了
}
```

`await` 之后的 mutation 跑的时候，wrapper 早就把 `activeAction` 擦成 `undefined` 了。这个 mutation 在时间线里就成了孤儿，没有 groupId。

源码注释里作者也直说了：要彻底解决这个，得等 [TC39 的 async context 提案](https://github.com/tc39/proposal-async-context) 落地。在那之前，setup store 的异步 action 就是这个软肋。

## 演示：从零搭一个最小可跑的分组机制

空说难懂。下面这段 ~60 行的代码，用一个最简的发布/订阅 store 演透「Proxy + 模块级 running id + 同步顺序」这套机制，不依赖 Vue，可以存成 `demo.mjs` 用 `node demo.mjs` 直接跑：

```js
// demo.mjs
// 一个最小的发布/订阅 store —— 不依赖 vue，只演示「分组机制」本身

const createStore = (obj) => {
  const subs = new Set()
  return {
    get: (k) => obj[k],
    set: (k, v) => { obj[k] = v; subs.forEach((fn) => fn()) },
    subscribe: (fn) => { subs.add(fn) },
  }
}

// 模块级留言板 + 自增 id（activeAction + runningActionId 的最小化版本）
let activeAction
let runningId = 0

// 时间线事件队列
const timeline = []
const emit = (event) => timeline.push(event)

// 把 action 包成「写 id → 跑 → 擦 id」的 wrapper
// isOptionsAPI 决定是否用 Proxy 兜底
function wrapAction(store, name, original, isOptionsAPI) {
  return function (...args) {
    const id = ++runningId
    emit({ kind: 'start', groupId: id, name })

    const trackedStore = isOptionsAPI
      ? new Proxy(store, {
          get: (t, k) => { activeAction = id; return t.get(k) },
          set: (t, k, v) => { activeAction = id; return t.set(k, v) },
        })
      : store

    activeAction = id
    const ret = original.apply(trackedStore, args)
    activeAction = undefined     // 关键：同步窗口结束，擦白板
    if (ret && typeof ret.then === 'function') {
      ret.then(() => emit({ kind: 'end', groupId: id, name }))
    } else {
      emit({ kind: 'end', groupId: id, name })
    }
    return ret
  }
}

// 接订阅 → mutation 事件，groupId 取模块级 activeAction
function wireMutationEvents(store) {
  store.subscribe(() => {
    emit({ kind: 'mutation', groupId: activeAction, count: store.get('count') })
  })
}

// === 场景 1：options store 同步 action 改两次 ===
const optionsStore = createStore({ count: 0 })
wireMutationEvents(optionsStore)
const wrappedIncTwice = wrapAction(
  optionsStore,
  'incTwice',
  function () {
    this.set('count', this.get('count') + 1)
    this.set('count', this.get('count') + 1)
  },
  true,  // isOptionsAPI = true，开 Proxy
)
wrappedIncTwice()
console.log('--- 场景 1：options store 同步 action ---')
console.log(timeline.splice(0))

// === 场景 2：setup store 异步 action，await 之后丢关联 ===
const setupStore = createStore({ count: 0 })
wireMutationEvents(setupStore)
const wrappedIncLater = wrapAction(
  setupStore,
  'incLater',
  async function () {
    this.set('count', this.get('count') + 1)   // 同步段：白板上还有 id
    await Promise.resolve()                     // 让出执行栈
    this.set('count', this.get('count') + 1)   // await 之后：白板已被擦
  },
  false,  // setup store 不开 Proxy
)
await wrappedIncLater()
console.log('--- 场景 2：setup store 异步 action ---')
console.log(timeline.splice(0))
```

跑出来的真实输出（请特别留意场景 2 的顺序，那是本机制最坑的地方）：

```
--- 场景 1：options store 同步 action ---
[
  { kind: 'start',    groupId: 1,         name: 'incTwice' },
  { kind: 'mutation', groupId: 1, count: 1 },
  { kind: 'mutation', groupId: 1, count: 2 },
  { kind: 'end',      groupId: 1,         name: 'incTwice' }
]

--- 场景 2：setup store 异步 action ---
[
  { kind: 'start',    groupId: 2,         name: 'incLater' },
  { kind: 'mutation', groupId: 2,         count: 1 },          // await 之前，白板上还是 2
  { kind: 'mutation', groupId: undefined, count: 2 },          // await 之后，白板被擦了
  { kind: 'end',      groupId: 2,         name: 'incLater' }   // Promise resolve 后才发 end
]
```

场景 1 完美：两条 mutation + start + end 共享同一个 groupId=1，时间线上是一组。场景 2 是软肋的直接体现——第二条 mutation 的 `groupId` 是 `undefined`，因为它跑的时候 `activeAction` 已经被擦掉了。

注意 end 和 mutation2 的先后：end 是在 `ret.then(...)` 里发的，ret 这个 Promise 要等 action 体执行完才 resolve；mutation2 是 action 体里 `await` 恢复之后同步跑的——`await` 恢复在 ret resolve 之前，所以 mutation2 先于 end。如果你之前以为 end 会先出现，那是把 Promise 链的顺序记反了。

这段演示没接真正的 Vue DevTools，没碰 inspector 渲染、没碰文件导入导出——但「为什么必须用 Proxy」「为什么 await 之后丢关联」这两件事，跑完就完全看明白了。

## 关键权衡（这部分比演示还重要）

把演示做漂亮不难，难的是讲清楚「为什么这么设计」。下面四条权衡是这套机制真正的分量。

### 权衡一：把 DevTools 做成插件而不是内建代码路径

**选择**：DevTools 整套逻辑（订阅、Proxy、inspector、文件 IO）都塞在一个独立插件里，通过 `pinia.use(devtoolsPlugin)` 注册。

**换来**：生产构建可以整段 tree-shake。源码里所有 DevTools 相关代码都被 `__USE_DEVTOOLS__ && IS_CLIENT` 这个编译期常量守卫——生产构建里这个常量是 false，打包工具会把整段死代码消掉，运行时零开销。对最终用户来说，DevTools 这套东西就像不存在。

**代价**：action 与 mutation 的「分组关联」不能写到 store 的主构建链路里（那就成内建了），只能在插件激活后**回头给每个 store 重新包一遍 action**——这就是 `patchActionForGrouping` 存在的原因。它本质上是「事后打补丁」，对 setup store 的异步 action 永远无解（见权衡二）。如果 DevTools 是内建的，本可以在 action 主包装链路里直接做关联；选了插件路径，就只能事后兜底。

### 权衡二：用模块级全局变量当 action-mutation 的关联留言板

**选择**：一个模块级的 `let activeAction: number | undefined`，加一个自增的 `runningActionId`，做关联。

**换来**：实现极简。不改 `$subscribe` 的签名，不给订阅回调传额外参数，不给 action 包装器引入新概念——主构建链路完全不动。DevTools 这套关联机制对非 DevTools 用户零感知。

**代价**：靠的是严格同步顺序。从 `activeAction = id` 到 `activeAction = undefined` 之间，所有 mutation 必须在同一个 JS 调用栈里完成。任何 `await`/`setTimeout`/事件回调之后的 mutation，`activeAction` 都已被擦掉，关联丢失。TC39 的 [async context 提案](https://github.com/tc39/proposal-async-context) 真落地之前，setup store 异步 action 永远是软肋——上面演示的场景 2 就是这个问题。

### 权衡三：应用级与 store 级两个入口的分工

**选择**：`registerPiniaDevtools` 在 `app.use(pinia)` 时跑一次，建时间线层和 inspector；`devtoolsPlugin` 在每个 store 创建时跑一次，挂订阅。

**换来**：用户体验顺。app.use 完，DevTools 面板就显示出来了，即使一个 store 都还没建。每建一个 store，对应的时间线订阅才在它出生那一刻挂上——store 销毁了订阅自然也没了，不漏不重。

**代价**：同一个 `setupDevtoolsPlugin` 被 Pinia 调用 N+1 次（1 次应用级 + N 次 store 级）。两边要共享状态（比如 `componentStateTypes` 这个数组，应用级填、store 级读），只能放到模块级——模块级共享状态天然是隐式依赖，单测和并发场景都不好处理。这是为了「面板立即可见 + 订阅按 store 生死」这个体验付的代价。

### 权衡四：inspector 编辑路径的反向污染防护

**选择**：用户在面板里改某个 state 字段时（比如把 `count: 1` 改成 `5`），代码先临时把一个布尔 `isTimelineActive` 关掉，触发响应式写入，再开回来。

**换来**：DevTools 编辑面板和时间线互不打架。不然你改个值，时间线立刻多出一条 mutation 事件——这条事件是你**自己**在面板里改出来的，不是 action 触发的，会污染调试视图。

**代价**：多了一个全局布尔要维护。`isTimelineActive` 是模块级单值，两个并发的 store 编辑理论上会互相干扰；但因为 JS 单线程、`editInspectorState` 是同步路径，实际不会出问题——这个代价基本可以忽略。真正麻烦的是 path 改写那块逻辑（判断用户改的是 state 子字段、自定义属性、还是可写 getter，决定 path 前面要不要加 `$state`），那块条件分支相当绕，但属于实现细节，原理上不展开。

## 一条执行轨迹：你在面板里把 count 改成 5

把权衡四讲透，走一遍「用户在 inspector 里改值」的完整轨迹：

```
用户在 DevTools 面板把 count:1 改成 5
  ↓
Vue DevTools 调用 editInspectorState 回调（path: ['count'], value: 5）
  ↓
回调内部：
  1. 改写 path：判断 path[0]='count' 在 $state 里 → path 变成 ['$state', 'count']
  2. isTimelineActive = false       ← 权衡四的关键一步
  3. 调 payload.set(...)            ← 触发响应式写入
       ↓
       store._state.value.count = 5  ← 实际改值
       ↓
       $subscribe 回调同步触发（flush:'sync'）
       ↓
       回调里 if (!isTimelineActive) return   ← 直接跳过时间线事件
  4. isTimelineActive = true        ← 恢复
  5. sendInspectorState(INSPECTOR_ID) ← 让右侧面板刷新成新值
  ↓
输出：store.count === 5；timeline 没多出任何事件；inspector 显示 5
```

这条轨迹把「编辑面板」和「时间线」这两套本该共享同一份 state 的子系统彻底解耦——你改你的、我不记。否则面板编辑会被误认为业务 mutation，调试就乱了。

## 小结

DevTools 集成这套东西，本质是「把已有信号接到外部面板上」，没有新发明状态管理机制。它的难度全在两个地方：

1. **关联**：把一次 action 调用和它内部产生的所有 mutation 串成一组——靠模块级全局变量 + 严格同步顺序实现，setup store 异步 action 是已知软肋
2. **解耦**：让 DevTools 自身的操作（编辑面板）不要污染 DevTools 的观测面（时间线）——靠一个临时布尔开关实现

整套机制作为插件挂在 Pinia 上，生产构建直接 tree-shake 掉。你生产环境的用户感知不到这套东西的存在，但你开发时它就在那里——是状态库从「能用」变成「好调」的关键一块。
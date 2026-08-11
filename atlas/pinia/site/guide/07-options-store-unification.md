# Options Store：双作者语法统一于单一装配路径

> 本章属于 composite 层。前置：Store 装配、状态变更模型。
> 学完你能讲清：为什么 Pinia 不给两种 store 语法各写一套装配逻辑，以及「setup store 拿不到 `$reset`」这件事背后的根本原因。

上一章把订阅系统的协调讲透了——`$onAction` 包裹动作、`$subscribe` 盯着状态，两个监听开关与 `$patch` 配合，让"直接改 state"和"`$patch` 批改"都能被订阅正确捕获、且只通知一次。但那套协调能成立，建在一个隐含前提之上：不管 store 是用 setup 语法还是 options 语法写的，装配出来后**必须是同一种东西**，订阅系统才能一视同仁。本章就拆给你看：Pinia 是怎么把两种作者语法**翻译**进同一条装配流水线的，以及这条统一路径必然付出的代价——为什么 setup store 拿不到 `$reset`。

## 1. 为什么需要它

Pinia 给了两种写 store 的姿势。一种像 Vuex，声明式：

```ts
const useCart = defineStore('cart', {
  state: () => ({ items: [] }),
  getters: { count: (s) => s.items.length },
  actions: { add(item) { this.items.push(item) } },
})
```

另一种像 Vue 组合式函数：

```ts
const useCart = defineStore('cart', () => {
  const items = ref([])
  const count = computed(() => items.value.length)
  function add(item) { items.value.push(item) }
  return { items, count, add }
})
```

两种语法各有受众。可要是内部各走一套装配逻辑——options store 一套 effectScope、ref/reactive 分类、插件管线、订阅挂载；setup store 又另一套——立刻就出问题：插件作者得搞清楚两种 store 各自怎么挂的、订阅系统的 watcher 协调是不是对两种都成立、SSR 序列化要不要分两套写。更要命的是行为会**分叉**：用 setup 写的 store 在订阅里少触发一次；用 options 写的 store 在 devtools 里看不到某个字段；插件返回的 ref 在两种语法下一个被收进 effectScope、一个没有。一旦分叉，使用者的第一反应是「这是 bug 还是 feature？」，文档答不上来。

最朴素的诉求是：**不管用哪种语法写，装配出来的 store 必须是同一种东西**——上一章那套订阅协调、第 5 章那套 `$patch` 批处理、第 4 章那套 effectScope 托管，全都能直接套上去、行为完全一致。

## 2. 核心思想

把 options 式语法**翻译**成一个 setup 式的 setup 函数，让两种作者语法共用**同一条**内部装配流水线。

这句话的灵魂不在「翻译」二字上，而在「同一条装配路径」上。装配主干（第 4 章那七步：占位注册、跑 setup、给返回值分类、镜像 state、reactive 包装、装订阅、装 `$patch`）一动不动——它就是它的样子，对两种语法都一样。新加的只是一个**翻译器**：把 `{ state, getters, actions }` 这种声明式对象，临时拼成一个 setup 函数，再把这个 setup 函数连同「我来自 options」的一个布尔标志一起，递交给同一条装配函数。

（这里要小心：这个布尔标志不是「开关第二套装配逻辑」，而是「在同一套装配逻辑里挑出三处微小差异」——这三处差异正是后面要展开的核心代价。）

## 3. 心智模型：六步翻译 + 一份主干

装配的实际过程，对 option store 而言可以拆成六步：

```
① defineStore 看 setup 参数是不是函数 → 不是 → 走 options 路径
        ▼
② 确保根状态[id] 存在（不存在就调 state() 写进去）
        ▼
③ 合成一个 setup 函数：返回 { ...根状态[id] 的 toRefs, ...actions, ...每个 getter 包成的 computed }
        ▼
④ 把这个 setup 连同「state 形状已声明」标志交给 createSetupStore —— 后续一切走同一路
        ▼
⑤ 装配函数凭该标志决定三处局部差异（详见 §4.4）：跳过空占位、跳过 ref 迁移、合成 $reset
        ▼
⑥ 装配主干的剩余步骤（reactive 包装、订阅挂载、$patch 装配、插件管线）对两种语法完全一致
```

关键不变量：**根状态[id] 永远是真相之源**。option store 的 state 在 setup 跑之前**就已经**写进根状态了，setup 只是把那块对象的每个 key 用 `toRefs` 镜像成 ref 再返回出去。setup store 走的是相反方向：ref 在 setup 里先被命令式创建，再被装配函数迁移进根状态。但装配结束的那一刻，两种 store 在根状态树里**长得一模一样**——这正是统一路径能成立的关键。

## 4. 关键权衡

### 4.1 翻译而非另起炉灶

**选择**：option store 不写装配逻辑，只合成一个 setup 函数后转交给 `createSetupStore`。
**换来**：所有装配机制——effectScope 托管、订阅挂载、`$patch` 批处理、插件管线、reactive 包装——只有**一份**实现。两种语法的 store 在装配完毕时是同一种东西，订阅、插件、SSR、HMR 都不必区分语法。
**代价**：option store 的每个 getter 都被包成 `markRaw(computed(() => ...))`——多一层闭包、多一次函数调用。更要紧的是，getter 闭包里要先 `setActivePinia(pinia)`、再从注册表 `pinia._s.get(id)` 取 store 实例、再 `getters[name].call(store, store)` 才能调用。这层包装不为好玩，是为让 getter 内部能跨 store 引用——`this.otherGetter`、`this.someAction` 都得拿到完整的 store 实例才走得通。

> **本质矛盾**：「实现统一」与「语法灵活」是一对天生的张力。把两种语法都翻译到同一种中间表示，是把这份张力从「外部行为」前移到「内部实现」里——使用者感觉不到，但实现里多了一层翻译开销。

### 4.2 把根状态当唯一来源

**选择**：option store 在 setup 跑之前就把 `state()` 写进 `pinia.state.value[id]`，setup 内部用 `toRefs(根状态[id])` 把它镜像成 ref；setup store 则反过来，setup 里命令式创建的 ref 在装配时被迁移进 `pinia.state.value[id]`。
**换来**：两种语法装配后**状态存储位置完全一致**——都在那棵根状态树里。插件遍历状态、SSR 序列化、devtools 显示，统统对着根状态工作，对两种语法零差异。
**代价**：option store 的 state 形状必须**静态声明**——你得先把 `{ items: [] }` 写在 `state()` 里，框架才能事先把它落进根状态。这意味着 option store 失去了 setup store 那种「在 setup body 里看情况决定 state 长啥样、什么时候建」的灵活性。你想要 state？请先声明它的形状。

> **本质矛盾**：「统一的状态来源」与「灵活的状态创建方式」是一对对立。把状态收拢到一处意味着插件、序列化、devtools 都能对着同一份工作；但状态怎么被创建就得受约束。Pinia 把这个矛盾在 option store 这侧切成了「形状静态声明」，把命令式自由留给了 setup store。

### 4.3 核心代价：`$reset` 的有无从哪来

这是本章最重要的一条，它解释了 Pinia 里一个最常被问起的「为什么」。

**选择**：装配函数给 option store 合成 `$reset`、给 setup store 不合成（dev 下抛错、prod 下静默空操作）。
**换来**：option store 使用者拿到一个开箱即用的「回到初始状态」按钮——`store.$reset()` 一调，state 全部归零。
**代价**：setup store 使用者**没有**这个按钮，得自己实现。

为什么会这样？这不是 Pinia 偷懒、也不是 setup store 不重要。根本原因是**两种语法对「初始状态」的知情程度根本不同**：

- option store 的 state 是一个**无参工厂** `state: () => ({ items: [] })`。这个工厂函数独立于 setup 之外存在，框架随时可以**重新调用**它，得到一份确定无疑的初始快照。`$reset` 干的事就是：再调一次 `state()`，把结果经一次 `$patch` 灌回当前状态（借第 5 章那套批处理，只发一条订阅）。
- setup store 的 state 是 setup 闭包里命令式创建的 `const items = ref([])`。一旦 setup 跑完，那些 ref 就是框架拿到的成品——框架**看不到**「这玩意儿初始值是啥」的工厂。你让框架怎么重置？再调一次 setup？那会重新建一整套 ref，跟原来那套对不上号；让框架「记住每个 ref 的初始值」？那得在第一次 `ref(...)` 调用上做拦截、对每种 ref（含计算属性、嵌套对象、`ref(fetchSomething())` 这种副作用初始化的）推断初始值——技术上能做、工程上完全不值，语义上也说不清。

所以这条权衡的本质矛盾是：**「想给使用者统一的能力」与「两种语法对初始状态的可观测性根本不对称」**。Pinia 选了「能合成就合成、合成不了就老实告诉使用者」——dev 下抛错让使用者立刻知道、prod 下静默避免运行时崩。这条权衡没法两边都赢，**`$reset` 的有无就是这条统一路径必须付出的代价**。

### 4.4 一个布尔标志把差异压到三处

**选择**：用一个布尔标志 `isOptionsStore`（语义＝「state 形状是否静态声明」）穿透装配函数，只在三处局部点用 `if (!isOptionsStore)` 控制差异：(1) 是否给根状态建空占位 `{}`、(2) 是否把 setup 里的 ref 迁移进根状态、(3) 是否合成 `$reset`。
**换来**：装配主干只有**一份**——第 4 章那七步对两种语法完全一致，差异点高度局部化、三处 `if` 了事。
**代价**：这个布尔在阅读装配逻辑时是个**隐藏分支**。读到 `if (!isOptionsStore) pinia.state.value[$id] = {}` 的人，若不知道「option store 的 state 在 setup 跑之前就已落进根状态」，会想半天为什么这里要跳过。源码里靠注释点明它在哪几处起作用，但终究是多了一份「读时上下文」。

> **本质矛盾**：「一份主干好维护」与「两种语法的行为差异有差异」是一对张力。这份张力通过「布尔标志 + 局部分叉」被压到最小：差异点共有三处，主干一致。

## 5. 最小原理演示

下面这一小段演的是「翻译 + 单一装配路径 + `$reset` 的有无」这三件事。每一行都对应上面某个原理点；为了聚焦，effectScope、reactive 包装、插件、订阅、HMR、SSR 全部故意省略（教学简化）。

```ts
// 极简 Vue mock：足够演透翻译即可
let activePinia
const isRef = (v) => v && v.__isRef
const isComputed = (v) => v && v.__isComputed
const ref = (v) => ({ __isRef: true, value: v })
const computed = (fn) => ({ __isComputed: true, _fn: fn })
const toRefs = (obj) => Object.fromEntries(
  Object.keys(obj).map(k => [k, { __isRef: true, _key: k, _src: obj }])
)
const assign = Object.assign
const mapValues = (obj, fn) => Object.fromEntries(
  Object.entries(obj).map(([k, v]) => [k, fn(v)])
)

// 唯一装配路径（第 4 章已讲透，此处极简版）
function assemble(id, setup, options, { stateShapeDeclared }) {
  // setup store 才需要建空占位；option store 的 state 早已落进根状态
  if (!stateShapeDeclared && !activePinia.state.value[id])
    activePinia.state.value[id] = {}

  const ret = setup()
  for (const k in ret) {
    const v = ret[k]
    if (isRef(v) && !isComputed(v)) {
      // setup store 才需要把 ref 迁进根状态；option store 的 ref 本就是根状态的镜像
      if (!stateShapeDeclared) activePinia.state.value[id][k] = v
    }
    // 函数留作 action，$onAction 包裹器此处略
  }

  // 只有 option store 能合成 $reset：它有可重求值的 state() 工厂
  ret.$reset = stateShapeDeclared
    ? function () {
        // 重新调 state() 拿初始快照，再浅覆盖回根状态。
        // 完整实现里这步会借 $patch 把覆盖包成一条订阅事件（第 5 章）
        const newState = options.state ? options.state() : {}
        assign(activePinia.state.value[id], newState)
      }
    : () => { throw new Error(`setup store "${id}": $reset 不可用`) }

  return ret
}

// options 语法 → 翻译成 setup 函数，再走同一条 assemble
function defineOptionsStore(id, options, pinia) {
  activePinia = pinia
  const { state, getters, actions } = options
  const setup = () => {
    // state 先落根状态，再 toRefs 镜像成 ref
    if (!pinia.state.value[id]) pinia.state.value[id] = state ? state() : {}
    const localState = toRefs(pinia.state.value[id])
    // actions 原样 + 每个 getter 包成 computed（取 store 实例后再调）
    return assign(localState, actions || {},
      mapValues(getters || {}, (g) =>
        computed(() => g.call(pinia._s.get(id), pinia._s.get(id))))
    )
  }
  return assemble(id, setup, options, { stateShapeDeclared: true })
}

// setup 语法 → 直接走同一条 assemble
function defineSetupStore(id, setup, pinia) {
  activePinia = pinia
  return assemble(id, setup, {}, { stateShapeDeclared: false })
}

// 试一下
const pinia = { state: { value: {} }, _s: new Map() }

const opt = defineOptionsStore('cart', {
  state: () => ({ items: 0 }),
  getters: { count: (s) => s.items },
  actions: { add() { this.items++ } },
}, pinia)
console.log(pinia.state.value['cart'])            // { items: 0 } —— option store 的 state 落在根状态
console.log(typeof opt.$reset)                    // 'function' —— option store 自带 $reset

const setupStore = defineSetupStore('cart2', () => ({ items: ref(0) }), pinia)
console.log(isRef(pinia.state.value['cart2'].items))  // true —— setup store 的 ref 被迁进根状态
try { setupStore.$reset() } catch (e) { console.log(e.message) }
// → setup store "cart2": $reset 不可用
```

注意一个边角：`$reset` 里那个 `assign` 是**浅覆盖**——它只覆盖 `newState` 里有的顶层 key，不会删除 `newState` 里没有的顶层 key、也不深合并嵌套对象。这是次要细节，主旨是「能重置」这件事本身。

## 6. 执行轨迹

拿一个具体输入走一遍，看状态怎么变。**输入**：

```ts
defineStore('cart', {
  state: () => ({ items: 0 }),
  getters: { count: (s) => s.items },
  actions: { add() { this.items++ } },
})
```

首次调用 `useCart()`：

| 步骤 | 内部状态 | 关键动作 |
|---|---|---|
| defineStore 入口 | — | `typeof setup === 'function'`？setup 是 options 对象、不是函数 → 判定为 option store |
| 路由 | — | 走 createOptionsStore（而非 createSetupStore 直接路径） |
| 合成 setup 内 | `pinia.state.value['cart'] = { items: 0 }` | `state()` 求值、写进根状态 |
| setup 返回值 | `{ items: <toRef>, count: <computed>, add: <fn> }` | `toRefs` 镜像 + actions 原样 + getter 包 computed |
| 进入装配函数 | 同上 | 拿到 `isOptionsStore = true` 标志 |
| 分类循环 | — | `items` 识别为 ref（非 computed），但因 `isOptionsStore` 为真 → **跳过迁移**（它已在根状态里）；`add` 是函数 → 包成 action |
| 合成 `$reset` | `store.$reset = 闭包` | 因 `isOptionsStore` 为真 → 合成；setup store 这步会装一个抛错的 stub |
| 后续装配步骤 | store 被包成 `reactive()`、订阅挂上、`$patch` 装配、插件跑一遍 | 与 setup store **完全一致**——两种语法汇流 |

**输出**：一个 reactive store，state 是根状态里那块 `{ items: 0 }` 的镜像，getter `count` 是 computed，action `add` 被包过、能被 `$onAction` 拦截，并自带 `$reset()`。

现在调 `store.add()`：`this.items++` → 直接改根状态里那个 `items`（toRefs 镜像保证两边同步）→ 触发 `$subscribe`、`$onAction` 各自的通知（上一章讲过的协调机制）。

再调 `store.$reset()`：

| 步骤 | 内部状态 |
|---|---|
| 入口 | `isOptionsStore = true` 分支 |
| 取初始快照 | `state()` 重新求值 → `{ items: 0 }` |
| 经一次 `$patch` | 进入 `$patch` 函数体（第 5 章）：关监听 → 调 `assign($state, { items: 0 })` 把当前 `items` 浅覆盖回 0 → 手动触发一次订阅 |
| 结果 | 当前 `state.items` 从被改过的值变回 0；只发出**一条**「patch function」订阅事件 |

如果这是 setup store，调 `$reset()` 的轨迹只有一步：直接进抛错分支（dev）或 noop（prod）——没有 `state()` 工厂可调、没有重置可言。

## 7. 教学简化说明

上面这一整套，故意省略了不少东西：

- **响应式与 effectScope**：演示里的 `computed`、`ref`、`reactive` 都是 mock，不做真实依赖追踪与缓存；effectScope 托管、`markRaw` 包装等细节也全部略去。第 4 章已讲透。
- **`$patch` 批处理**：演示里 `$reset` 直接 `assign` 完事；真正路径是把 `assign` 裹进 `$patch`，借第 5 章那套批处理把所有变更压成一条订阅事件。
- **HMR 分支**：option store 热更新时会走一条专门路径重建 localState，属第 11 章 HMR。
- **hydrate 钩子**：option store 专用的 SSR 水合钩子，属第 13 章 SSR。
- **action 包裹器与订阅挂载**：第 4 章和第 6 章已讲透，演示里直接保留原函数。
- **getter 的 `this` 与首参都是 store**：这让 getter 内既能 `this.otherGetter`、又能用首参（如 `(state) => state.items`）；本章点过即可。

抓主线：**翻译 + 单一装配路径 + `$reset` 的有无**——其余都是围绕这条主线的实现细节。

## 8. 小结

两种作者语法、一条装配路径——option store 把 state/getters/actions 临时拼成一个 setup 函数，再交还给第 4 章那套装配流水线；差异被压成「一个布尔标志 + 三处局部 if」。

但这条统一路径不是免费的：option store 因为 state 形状静态声明、有可重求值的 `state()` 工厂，故能合成 `$reset`；setup store 的 state 是闭包里命令式创建的 ref，框架没有工厂可调——`$reset` 的有无不是设计偏心，而是「能否重建初始状态」这一对根本不对称的能力差异的必然外化。同样的不对称还会在下一章再次现身：当 setup store 把 state ref、computed getter 和 action 函数全混在一个 reactive 对象里返回时，`storeToRefs` 想要从中**定向**只提取响应式部分，就再也不能用 Vue 自带的 `toRefs` 一把梭了。

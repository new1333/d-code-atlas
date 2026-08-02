# Options Store 适配：声明式选项翻译成 setup

如果你是从 Vuex 迁过来的，第一次看到 Pinia 的 setup store 写法可能会有点懵：

```ts
// 你以为 store 应该这么写
export const useCounter = defineStore('counter', {
  state: () => ({ count: 0 }),
  getters: { double: (s) => s.count * 2 },
  actions: { inc() { this.count++ } },
})

// 实际上 Pinia 还允许这么写
export const useCounter = defineStore('counter', () => {
  const count = ref(0)
  const double = computed(() => count.value * 2)
  function inc() { count.value++ }
  return { count, double, inc }
})
```

第二种「setup 写法」更灵活，能直接用 `vue` 的组合式 API；第一种「option 写法」更接近 Vuex 习惯，做配置型 store 时更顺手。问题来了：**Pinia 总不能为这两套语法各写一套构建管线吧？**

本章就讲清楚：option store 并没有自己造一条构建链，而是先把声明式选项**翻译成一个 setup 函数**，再丢给 setup store 构建器（上一章讲过的 `createSetupStore`）走完剩下的流程。说人话就是——**option store 是 setup store 的一种语法糖**。

## 一、翻译前要想清楚的三件事

在动手之前，得先想清楚三个具体问题：

1. **state 怎么落到 `pinia.state.value[id]`**？setup store 是构建器在 setup 跑完后，把返回的 ref 一个一个搬过去的；option store 直接有一个 `state()` 工厂，能不能一开始就写到对的位置？
2. **getter 里的 `this` 指向谁**？用户写 `(state) => state.count * 2`，但 store 在被构建时还没造完——getter 被定义时拿不到「半成品 store」。
3. **action 怎么处理**？action 在 option 写法里就是普通函数，能不能直接用？

这三件事凑在一起，决定了「翻译」不是简单的语法糖转换，而要在三个具体地方做选择。下面先看心智模型，再展开每条权衡。

## 二、自底向上的执行轨迹

先把整条翻译流程走一遍，对应到具体的输入输出。

**输入**：用户调

```ts
defineStore('counter', {
  state: () => ({ count: 0 }),
  getters: { double: (s) => s.count * 2 },
  actions: { inc() { this.count++ } },
})
```

**过程**：

```
defineStore(id, options)
  → typeof setup !== 'function' 判定为 option store
  → 首次 useCounter() 未命中 _s 缓存
    → createOptionsStore(id, options, pinia)        // 不构建，只合成 setup
      → setup() 合成：
          a. pinia.state.value[id] = state()
          b. toRefs 拆出 localState
          c. 每个 getter 包 markRaw(computed(...))
          d. actions 原样保留
      → createSetupStore(id, setup, ..., isOptionsStore=true)  // 复用上一章的构建链
        → 跑合成的 setup，分类返回值装进 reactive store
        → 看到 isOptionsStore=true → 安装 $reset、跳过 setup store 的 ref 搬运
    → pinia._s.set(id, store)
  → 返回 store
```

**输出**：
- `store.count === 0`、`store.double === 0`；
- 调 `inc()` 后 `store.count === 1`、`store.double === 2`；
- 调 `store.$reset()` 后 `store.count === 0`（注意：setup store 在 dev 下调 `$reset` 会抛错）。

## 三、最小演示：把翻译演给你看

下面这段 ~50 行脚本从零实现「option → setup 翻译」的最小骨架，每一步都对应一条权衡。可以存成 `demo.ts`，用 `bun run demo.ts` 或 `npx tsx demo.ts` 直接跑：

```ts
import { reactive, computed, toRefs, effectScope } from 'vue'

// 1. 极简 pinia 骨架（上一章讲过的全局状态对象）
const pinia = {
  state: { value: {} as Record<string, any> },   // 集中 state
  _s: new Map<string, any>(),                    // store 注册表
  _e: effectScope(),                             // 全局 effect 持有
}

// 2. 共享的 setup 构建器（上一章的核心机制）
function buildStore(
  id: string,
  setup: () => any,
  isOptions = false,
  stateFactory?: () => any,
) {
  const store = reactive({}) as any
  pinia._s.set(id, store)                        // 先注册半成品
  const ret = pinia._e.run(() => setup())
  Object.assign(store, ret)                      // 把 setup 返回值装进 reactive store

  // $reset：仅 option store 实现
  if (isOptions && stateFactory) {
    store.$reset = () => Object.assign(pinia.state.value[id], stateFactory())
  } else {
    store.$reset = () => { throw new Error('🍍 setup store 不支持 $reset') }
  }
  return store
}

// 3. option → setup 的翻译器（本章核心）
function defineOptionStore(
  id: string,
  options: {
    state?: () => any
    getters?: Record<string, (s: any) => any>
    actions?: Record<string, Function>
  },
) {
  const { state, getters = {}, actions = {} } = options

  function setup() {
    // (a) state() 直接落到 pinia.state.value[id]，再 toRefs 出来
    pinia.state.value[id] = state ? state() : {}
    const localState = toRefs(pinia.state.value[id])

    // (b) 每个 getter 包成 computed，内部用 _s.get(id) 取 store（而非 this）
    const computedGetters: Record<string, any> = {}
    for (const name in getters) {
      computedGetters[name] = computed(() => {
        const store = pinia._s.get(id)!            // ← 延迟到求值时取 store
        return getters[name](store, store)
      })
    }

    // (c) actions 原样保留
    return { ...localState, ...computedGetters, ...actions }
  }

  return buildStore(id, setup, /* isOptions */ true, state)
}

// 4. 跑一遍
const useCounter = () => defineOptionStore('counter', {
  state: () => ({ count: 0 }),
  getters: { double: (s) => s.count * 2 },
  actions: {
    inc(this: any) { this.count++ },
  },
})

const store = useCounter()
console.log(store.count, store.double)             // 0 0
store.inc()
console.log(store.count, store.double)             // 1 2
console.log(pinia.state.value['counter'])          // { count: 1 } —— state 集中化成立
store.$reset()
console.log(store.count, store.double)             // 0 0
```

跑完应该输出 `0 0`、`1 2`、`{ count: 1 }`、`0 0`。下面把每一处选择拆开讲。

## 四、关键权衡

本章机制丰富，展开 4 条核心权衡。它们共同回答一个问题：**为了把 option 写法塞进同一条构建链，Pinia 在哪些地方付出了什么样的代价？**

### 权衡 1：两条语法共享同一条 setup 构建路径

**做了什么**：`createOptionsStore` 函数体里没有任何 reactive、effectScope 调用，它唯一做的事就是「合成 setup 函数，丢给 `createSetupStore`」。换句话说，option store 自己**不构建 store**。

**换来什么**：
- 两条语法产出的 store 行为**完全一致**：`$patch`、`$onAction`、`$subscribe`、plugin 注入、HMR 全走同一条路径，bug 修一处即可；
- 代码量减半，构建器不需要为 option store 单独写一份「装 reactive、装 effectScope、装 plugin」的逻辑。

**代价**：构建器内部多出来一堆 `isOptionsStore` 条件分支——
- state 搬运（option store 不用搬，因为 `state()` 直接写到对的位置）；
- `$reset` 是否可用；
- HMR 时 getter 要不要重新包一层 computed；
- SSR 时是否调用 option store 专属的 `hydrate` 钩子。

构建器因此不再「单一职责」，读源码时需要同时记住两种 store 的差异。

**说人话**：这个选择本质上是「让构建器变复杂，换取上层 API 简单」。反过来——两条语法各写一套构建链——构建器会清爽一点，但任何行为对齐（比如保证两种 store 都支持 plugin）都要改两处，漏一处就是 bug。Pinia 选了前者，从结果看是对的：用户没人在乎构建器内部有多绕，但很在乎「我换种写法行为是不是一样」。

### 权衡 2：getter 不用 `this`，而是用 `pinia._s.get(id)` 延迟取 store

**做了什么**：合成 setup 时，每个 getter 被包成：

```ts
computed(() => {
  const store = pinia._s.get(id)!   // ← 每次求值时去注册表拿 store
  return getters[name].call(store, store)
})
```

而不是想当然的 `computed(() => getters[name].call(this, this))`。

**换来什么**：绕开了「定义时的循环依赖」。要知道，合成的 setup 在 `createSetupStore` 里被运行时，store 还是个空 reactive 对象——`_s.set(id, store)` 已经发生（这是为了允许 store 之间互相引用），但 `Object.assign(store, ret)` 还没执行。如果 getter 在「定义时」就要拿到完整 store，就会读到空对象；而 `pinia._s.get(id)` 把「拿 store」推迟到 getter **第一次被求值**的时刻，那时 store 早已被 `assign` 填满。

**代价**：
- 每次 getter 求值都要付一次 `Map.get(id)` 的查找开销（实际开销极小，但确实是一次额外的属性访问）；
- 阅读源码时，这条「getter 内部用 `_s.get(id)` 而非 `this`」的隐式约定需要专门解释，否则会以为「为什么不用 this」。

**类比**：想象 getter 是一张「现在先写好、晚点再问问题」的便条。如果便条写的时候就跑去问 store，store 还在更衣室里没出来；如果便条上写「需要时去注册表查一下」，等便条真被翻开时 store 早就就位了。

### 权衡 3：option store 的 `state()` 在合成 setup 内直接写入 `pinia.state.value[id]`

**做了什么**：合成 setup 第一步就是 `pinia.state.value[id] = state ? state() : {}`，再 `toRefs` 出 localState。换句话说，**option store 的 state 集中化在 setup 跑的第一步就完成了**，而不是构建器事后做。

**换来什么**：
- **state 集中化「一开始就完成」**：不需要等 setup 跑完、构建器再搬运；
- **`$reset` 自然成立**：重置只要把 `state()` 重跑一次、用 `$patch` 把结果盖回去就行，因为初始 state 永远等价于「再调一次 `state()`」。

**代价**：setup store 必须在 setup 返回后把 ref 一个个搬运到 `pinia.state.value[$id][key]`（构建器因此多出一段 `if (!isOptionsStore)` 的分支）。setup store 没有「state 工厂」这个概念，ref 是用户在 setup 内自己 `ref()` 出来的，只能事后搬运。

**为什么 setup store 不能这么做**：因为 setup store 的 ref 是用户在 setup 函数内手动 `ref()` 创建的，这些 ref 在 setup 跑完之前根本不存在；构建器只能等 setup 返回值出来，再分类哪些是 state、哪些是 getter、哪些是 action，搬运到对的位置。option store 的 `state()` 是预先声明的，所以能在 setup 跑第一步就完成 state 集中化——这是 option 写法在「集中化时机」上的天然优势。

### 权衡 4：`$reset` 只对 option store 实现，setup store 在 dev 下直接抛错

**做了什么**：构建器内：

```ts
const $reset = isOptionsStore
  ? function() {
      const newState = options.state ? options.state() : {}
      this.$patch(($state) => { Object.assign($state, newState) })
    }
  : __DEV__
    ? () => { throw new Error(`🍍: Store "${$id}" is built using the setup syntax...`) }
    : noop
```

**换来什么**：「诚实语义」——option store 有 `state()` 工厂，所以「重置」语义明确（重跑 `state()`）；setup store 的初始状态是用户在 setup 里手写的 `ref(0)`、`ref('')`，构建器没有「初始状态」的概念，硬要支持 `$reset` 只能瞎猜，索性不支持。

**代价**：setup store 用户必须自己实现 `$reset`（一般写成 `function $reset() { count.value = 0; name.value = '' }`），或者改用 `$patch({ count: 0, name: '' })` 重置。

**为什么 dev 抛错、prod 是 noop**：dev 下抛错是为了在开发阶段就提醒「这个 store 不支持 reset」；prod 下抛错会让线上应用崩，改成 `noop` 让它「静默失败」，至少不会让用户的应用挂掉。这个「dev 严格、prod 宽容」的策略，本质上是把「这是用户代码问题」的判定权交还给开发者，而不是用 prod 崩溃惩罚最终用户。

## 五、为什么不直接砍掉 option 写法

读完上面四条权衡，你可能会问：**option store 给构建器添了这么多分支，为什么不直接砍掉，强制所有人用 setup 写法？**

答案是**人的迁移成本**。Pinia 出现的时候，整个 Vue 生态都还是 Vuex 习惯——`state`、`getters`、`actions` 三段式声明、mutation/action 分离、modules 嵌套。如果 Pinia 一上来只支持 setup 写法，迁移门槛会高到劝退绝大多数 Vuex 用户。

option 写法本质上是**一张「欢迎迁移者」的接待牌**——同样的心智模型、同样的代码组织方式，迁移成本几乎为零；同时项目里两种写法共存（option store 做配置型 store、setup store 做需要组合式 API 的 store）也很自然，构建链共享保证两者行为一致。

而本章讲清楚的所有「奇怪分支」，本质都是这张接待牌的代价：构建器要为 option store 多处理 state 集中化时机、`$reset` 可用性、HMR getter 重包、hydrate 钩子。这些分支都不是「不可或缺」的——它们存在的唯一理由，是让 option store 在共享 setup 构建路径的同时，还能保留它独有的便利（state 工厂、`$reset`、SSR hydrate）。

## 六、小结

- option store 不自己造构建链，是被翻译成 setup 函数交给 `createSetupStore` 处理；
- 翻译过程做了三件事：`state()` 写到 `pinia.state.value[id]` 再 `toRefs`、getter 包 computed（内部用 `_s.get(id)` 取 store 绕开循环）、actions 原样保留；
- `isOptionsStore` 标志让构建器对两种 store 做差异化处理：跳过 state 搬运、安装 `$reset`、HMR 重包 getter、调用 hydrate 钩子；
- 这套设计换来「两条语法行为完全一致 + option store 保留 Vuex 风格便利」，代价是构建器多了若干条件分支。

下一章讲 state 集中化与 SSR hydration——会看到 setup store 那段「事后搬运 ref」的代价具体是怎么付的，以及为什么 option store 天然避开了这个麻烦。
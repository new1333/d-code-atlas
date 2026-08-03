# mapHelpers：组合式 store 到 Options API 的适配层

## 这一章要解决的别扭

想象你接手一个老项目，组件还在用 Options API 写：状态放 `data`，方法放 `methods`，计算放 `computed`。你照着 Pinia 官方示例想用 store，结果发现一个尴尬事——文档里的 store 永远是在 `setup()` 里 `useXxxStore()` 取出来的。可你这个组件根本没有 `setup()`，那 store 该从哪儿冒出来？

更别扭的是，如果为了照顾 Options API 单独给 store 造一套「在 `data` 里实例化」的专用路径，那同一个 store 就有了两种诞生方式，行为迟早分叉。你真正想要的其实很朴素：在 `computed: { ... }` 和 `methods: { ... }` 里展开几下，就能像访问本地数据一样用 store，而且行为和 `setup()` 里一模一样。

`mapHelpers` 就是来解决这个别扭的。它提供的四个函数（`mapState`、`mapWritableState`、`mapActions`、`mapStores`）干的事可以用一句话讲完：**不取值、不建 store，只造一批「被读到那一刻才去解析 store」的访问器壳**，把实例化推迟到 Vue 真正求值的时候。

说人话就是：它是个**适配层**，把组合式的 store 翻译成 Options API 能消化的 `computed`/`methods` 形态，但底下走的还是 `setup()` 那同一条实例化路径。

## 核心思想：发券不发货

这里有个关键抽象要先点透：**访问器壳**。

打个比方。`mapHelpers` 发出来的不是货物，而是一张**提货券**。发券（也就是你调 `mapState(...)`）的那一刻，货物——也就是 store 实例——压根还没生产出来。券上不写货，只写一句**取货指令**：「拿着这张券、到 `this.$pinia` 这个窗口、去提 `useCounter` 这件货」。

等到你真去兑换（Vue 渲染时求值这个 `computed`）的那一刻，工厂才开工，把 store 做出来。而且取货指令里写死了「走 `this.$pinia`」——也就是当前组件实例上注入的那个 pinia，不是去翻全局找个随便哪个活跃的 pinia。这一点后面讲权衡时会反复用到。

所以 `mapHelpers` 的函数体里，你看不到任何「创建 store」的动作，它只是用 `reduce` 把一批取货指令攒成一个对象。store 永远在求值时才诞生。

## 时序全景：map 调用时什么都没发生

把整条链路摊开看，最直观的是「谁先动、谁后动」：

```
你写组件定义                          Vue 挂载组件
     │                                     │
     ▼                                     ▼
调 mapState(useCounter, ['count'])    首次求值 this.count（渲染需要）
     │                                     │
     ▼                                     ▼
reduce 出 getter 壳 { count: fn }      触发 fn 执行，此时 this = 组件实例
     │                                     │
     ▼                                     ▼
store 此时【不存在】                   fn 里读 this.$pinia，传给 useCounter
                                           │
                                           ▼
                                     首次调用 → 创建 store 并缓存进注册表
                                           │
                                           ▼
                                     返回 store.count
```

几个关键节点连起来读：

1. **写定义时**：调 `mapState(...)` 只 `reduce` 出一批壳（函数或 `{get,set}` 对），组件还没挂载，store 还没创建。
2. **挂载求值时**：Vue 渲染需要 `this.count`，于是调用对应的壳函数，`this` 指向组件实例。
3. **壳执行时**：壳函数体读 `this.$pinia`（组件实例上注入的 pinia），把它当参数传给 `useCounter` 这个解析闭包。
4. **解析闭包**：首次调用就创建 store 并缓存进注册表，之后命中缓存——这条解析闭包的逻辑第 3 章已展开，本章只看它「被壳包了一层、在求值时触发」这个新侧面。
5. **取值/转发**：壳从拿到的 store 上读属性、写属性，或把方法调用转发给 action。

因为「取 store」永远发生在求值时、永远经注入的 `this.$pinia` 解析，Options API 和 `setup()` 走的是同一条实例化路径，行为天然一致——这正是适配层的意义。

## 三种壳，各吃 store 的哪一块

`mapHelpers` 一共发三种形状的券，分别对应 store 上三类东西（store 的 state/getter/action 三分结构第 4 章已讲透，这里只是它的消费者）：

| 来源类型 | 用哪个函数 | 壳的形状 | 放进组件的哪个字段 |
|---|---|---|---|
| 只读来源（state、getter） | `mapState` | 一个 getter 函数 `() => store[key]` | `computed` |
| 可写来源（state） | `mapWritableState` | 一个 `{ get, set }` 对 | `computed` |
| 动作（action） | `mapActions` | 一个转发参数的函数 `(...args) => store[key](...args)` | `methods` |

外加一个特例：`mapStores` 不映射某个属性，而是把**整个 store 实例**当成一个 getter 暴露出来，键名直接拿 store 的 `id` 加个后缀拼出来（比如 `counter` → `counterStore`），这样你在 Options API 里写 `this.counterStore` 就能拿到完整实例。

这三种壳长得不一样，但内核完全相同——函数体里都是那句 `useStore(this.$pinia)`。差别只在「拿到 store 之后读什么」：getter 壳读属性、方法壳转发调用、get-set 壳多了个 set。

## 原理演示：手写一个求值器，看壳何时才执行

下面这段脚本不依赖真实 Vue——正因为本章机制不靠响应式系统，用一个「手写求值器」模拟 Vue 求值 `computed` 的瞬间，反而最能看清「壳在被读时才执行」这个时序（真实 Vue 会把时序藏在响应式里，反而不直观）。

```js
// ===== 极简解析闭包：第 3 章讲的 useStore，这里只要它「首次创建并缓存」这一面 =====
const _s = new Map() // 注册表（对应 pinia._s）

function defineStore(id, makeState) {
  // 返回的是「解析闭包」：被调用时才创建 store
  return function useStore(pinia) {
    if (_s.has(id)) return _s.get(id)            // 命中缓存直接返回
    console.log(`    [首次创建] 实例化 store "${id}"`)
    const store = makeState()
    _s.set(id, store)                              // 缓存进注册表
    return store
  }
}

const useCounter = defineStore('counter', () => ({
  count: 1,                       // 可写来源（state）
  double: 2,                      // 只读来源（伪 getter，演示足够）
  inc(n = 1) { this.count += n }, // 动作
}))

// ===== 模拟「组件实例 + 注入的 pinia」（第 1 章：app.use(pinia) 时注入到每个组件）=====
function makeComponent() {
  return { $pinia: '本组件注入的 pinia 句柄' }
}

// ===== 三个映射函数：只 reduce 出壳，全程【不碰 store】=====
function mapState(useStore, keys) {
  return keys.reduce((out, key) => {
    out[key] = function () { return useStore(this.$pinia)[key] } // ① getter 壳
    return out
  }, {})
}
function mapWritable(useStore, keys) {
  return keys.reduce((out, key) => {
    out[key] = {                                                 // ② get/set 壳
      get() { return useStore(this.$pinia)[key] },
      set(v) { useStore(this.$pinia)[key] = v },
    }
    return out
  }, {})
}
function mapActions(useStore, keys) {
  return keys.reduce((out, key) => {
    out[key] = function (...args) { return useStore(this.$pinia)[key](...args) } // ③ 方法壳
    return out
  }, {})
}

// ===== 把壳展开进组件（模拟展开进 computed / methods）=====
const vm = makeComponent()
Object.assign(vm,
  mapState(useCounter, ['double']),
  mapWritable(useCounter, ['count']),
  mapActions(useCounter, ['inc']),
)
// 注意：到这里 store 仍未创建，只是多了几个壳

// ===== 手写求值器：模拟 Vue 渲染时读字段、触发对应壳 =====
console.log('① 读 vm.double —— 这一刻 store 才被创建：')
console.log('   =', vm.double.call(vm))      // getter 壳：当函数调

console.log('② 读 vm.count —— 命中缓存，不再创建：')
console.log('   =', vm.count.get.call(vm))   // get/set 壳：调 .get

console.log('③ 调 vm.inc(10) —— 转发到 action：')
vm.inc.call(vm, 10)                           // 方法壳：当函数调，转发参数
console.log('   再读 vm.count =', vm.count.get.call(vm))

console.log('④ 给 vm.count 赋值 99 —— 触发 set：')
vm.count.set.call(vm, 99)
console.log('   再读 vm.count =', vm.count.get.call(vm))
```

跑出来的轨迹会把「延迟求值」讲得很清楚：

```
① 读 vm.double —— 这一刻 store 才被创建：
    [首次创建] 实例化 store "counter"      ← store 在这里才诞生
   = 2
② 读 vm.count —— 命中缓存，不再创建：      ← 注意没有「首次创建」那行
   = 1
③ 调 vm.inc(10) —— 转发到 action：
   再读 vm.count = 11
④ 给 vm.count 赋值 99 —— 触发 set：
   再读 vm.count = 99
```

关键就看 ①和②的对比：发券（map）和展开（Object.assign）时控制台静悄悄，直到 ① 真去读 `vm.double`，那行「首次创建」才打印出来；到 ② 已经命中缓存，再不创建。store 从头到尾只诞生一次，而且诞生时机完全由「求值」决定。

## 关键权衡

这四个映射函数看着简单，每个选择背后都有一笔明确的账。

**权衡一：返回「延迟求值的访问器壳」，而不是「store 的值」。**
这是最核心的一笔。`mapState` 大可以直接在 reduce 里就 `useStore()` 把实例取出来、把属性值摆好。但它偏不——它返回的是壳，求值时才解析。换来的是什么？是和「惰性解析闭包」「按调用选 pinia」完全对齐：在 map 调用的那一刻，store 根本不存在（定义是零副作用、可 tree-shake 的），就算想取值也无处可取。壳这个形态正好接住了「延迟」这件事。代价是：每次 Vue 求值 `computed` 都要重新走一次解析（拿到 `this.$pinia`、调 `useStore`）。好在解析本身命中缓存、开销极小，但概念上确实是「每次访问都解析」而不是「map 时绑定一次」。

**权衡二：靠「组件实例上注入的 `$pinia`」显式传给解析闭包，而不是省掉参数去吃模块级全局活跃 pinia。**
你大概注意到了，所有壳体里统一写的是 `useStore(this.$pinia)`，而不是图省事写 `useStore()`。后者也能跑——解析闭包在拿不到显式参数时会回落到注入、再到全局活跃 pinia 兜底（这条解析顺序第 3 章、注入机制第 1 章都讲过）。但 `mapHelpers` 偏要每次显式传 `this.$pinia`，目的是让每个组件实例都用**自己 app 注入的 pinia**：多 app 场景下各自正确，SSR 下也更安全（不会因为全局串态而把 A 请求的状态漏给 B 请求）。代价是这套适配层**强依赖宿主框架把 pinia 注入到每个组件实例**——要是忘了 `app.use(pinia)`，`this.$pinia` 就是 `undefined`，求值时直接抛「没有活跃 Pinia」。换句话说，这些映射函数没法脱离 Vue 组件上下文独立工作。

**权衡三：把「只读来源」和「可写来源」拆成两个映射函数，而不是用一个带标志位的函数。**
`mapState` 返回 getter 函数，`mapWritableState` 返回 `{get, set}` 对。为什么不合并？因为 Vue 的 `computed` 字面就有两种形态：一种是纯 getter 函数（只读），一种是 `{get, set}` 对（可写）。store 上的 getter 本身是只读的计算属性，根本没法 set；只有 state 这种可写来源才配得上 set。所以干脆**按可写性分函数**最自然，`mapWritableState` 也只接受可写的来源。换来的能力是 `v-model` 双向绑定——没有 set，可写来源就没法双向。代价是用户得自己判断：要 `v-model` 的用 `mapWritableState`，只展示的用 `mapState`，两套函数得维护、得记。

顺带一提，`mapWritableState` 的 set 是**直接给 store 属性赋值**（`store[key] = value`），不走 `$patch` 那条批处理主路径。变更之所以还能被 `$subscribe` 捕获，靠的是 store state 的深度监听——这点和第 5 章的状态变更模型正好成对照，这里不展开。

**权衡四：把「整个 store 实例」也当成一个 computed 暴露，键名用 id 自动拼后缀。**
`mapStores` 不需要你写任何别名，传几个 `useStore` 进去，它就按 `id + 后缀` 自动生成键名（`useCounter` → `counterStore`），你在 Options API 里 `this.counterStore` 直接拿到完整实例。换来的是**零配置的自动命名**，省掉手写一长串别名。代价有两层：一是命名完全由 store 的 `id` 决定，两个 store 的 id 撞了，键名就撞了；二是这个后缀本身是个模块级可变全局（默认 `'Store'`，能改、能置空），改了之后类型侧还得手动扩展声明才能拿到准确类型提示。另外 `mapStores` 收到数组（误用，比如把几个 store 塞数组里传进来）时，dev 下会弹一条诊断提示，叫你把 store 展开传参——因为这种写法在 prod 会直接失败。

这四笔账合在一起，就是「适配层」的全部代价：为了让 Options API 用上组合式的 store，`mapHelpers` 选择只造壳、永远经注入的 `this.$pinia` 解析、按可写性分函数、自动拼名——既不另起一条实例化路径，也不依赖全局兜底，代价是它彻底依附于「Vue 组件实例」这个运行环境。

## 小结

一句话收束：`mapHelpers` 是组合式 store 到 Options API 的一层翻译，它自己**不创造任何实例化逻辑**，只发一批「被读时才解析」的访问器壳。这些壳统一靠组件实例上注入的 `this.$pinia` 取货，于是同一个 store 在两种作者语法下走的是完全相同的诞生路径，行为天然一致——这就是它「只是适配层、不是第二条路径」的本质。

写完本章，你已经知道 store 在求值时如何被解析出来、`$pinia` 怎么喂给解析闭包。下一章我们换一个角度：当开发模式下一份 store 的源码被热替换，**已经创建好的、带着运行时状态的 store 该如何就地更新而不丢状态**——那就是 HMR 要解决的问题。
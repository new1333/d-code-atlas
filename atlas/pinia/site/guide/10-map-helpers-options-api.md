# mapHelpers：组合式 store 到 Options API 的适配层

> 本章属于 composite 层。前置：defineStore、Store 装配、Pinia 实例。
> 学完你能：用一句话讲清「为什么这层适配器把组合式 store 翻译成 Options API 能消费的形态，又没有另起一套实例化路径」。

## 1. 为什么需要它（设计动机）

上一章讲了插件如何用上下文注入增强 store，那条路走的是 setup 装配。可是在 Options API 风格的组件里（`data/methods/computed` 那种写法），根本没有 `setup()`，这条路接不上。

矛盾具体长这样：你有一份 store，按惯例要用 `useXxxStore()` 才能拿到实例，而它只能在 `setup()` 里调。项目里又有一批老组件是 Options API 写的，没有 setup。三种解法各有问题：

- 单给 Options API 造一条实例化路径，同一份 store 两套行为，维护和心智都翻倍。
- 强制把项目全改成 setup，不现实。
- 让 store 同时挂两套，装配复杂度爆炸。

mapHelpers 解掉这个矛盾的方式很轻：它**不参与 store 装配、不创建 store**，只是产出一批「延迟求值的访问器壳」，把这些壳展开进 Options API 组件的 `computed` 或 `methods` 字段。Vue 在求值那一刻才走回那条已经在第 3、4 章建好的组合式实例化路径。

这一层适配换来「同一份 store、同一条实例化路径、在两种作者语法下行为完全一致」。

## 2. 核心思想

把「找 store」这件事，从写代码那一刻推迟到 Vue 自己求值那一刻。

mapHelpers 不是新机制，是借了 Vue 自己的求值时机来承载解析。壳子本身什么也不做，只是一个待执行的闭包；等 Vue 渲染要它了，它才用组件实例上注入的 pinia，调一次解析闭包。换句话说，mapHelpers 把「什么时候解析 store」这件事，外包给了 Vue 的 computed/method 求值钩子。

## 3. 心智模型

数据结构上有三种壳：

- **getter 壳**：一个普通函数，被 Vue 当作只读 computed 求值。`mapState` 和 `mapStores` 产这种。
- **可写壳**：一个 `{get, set}` 对，Vue 当作可写 computed 求值。`mapWritableState` 产这种。
- **方法壳**：一个转发参数的普通函数，放进 `methods` 字段。`mapActions` 产这种。

所有壳都以组件实例为 `this`，因为 Vue 求值 computed 时就是这么调的。壳函数体里固定有一句 `useStore(this.$pinia)`，把注入的 pinia 作为显式参数传给解析闭包。

不变量：调映射函数时 store **尚未创建**；壳被求值时才创建。同一个 store 无论被多少个壳消费，注册表里只有一份实例（解析闭包的缓存语义保证）。

A → B → C 流程：

1. 你写 `computed: { ...mapState(useCounterStore, ['count']) }`。
2. `mapState` 此时只是 reduce 出一个 `{ count: ƒ }`，啥也没解析。
3. 组件挂载，Vue 渲染时求值 `this.count`，于是壳函数被调，`this` 是组件实例。
4. 壳内 `useStore(this.$pinia)` 被调，注入的 pinia 显式传入。
5. 解析闭包首次创建 counter store、塞进注册表、`setActivePinia` 设为当前活跃。
6. 壳从 store 上读 `count`，返回给 Vue。
7. 下一次求值时，注册表命中缓存，直接返回同一个 store。

## 4. 关键权衡

### 壳被读时才求值，而非映射时一次性绑定

选择：让每个壳的函数体每次被 Vue 求值时都重新走一次 `useStore(this.$pinia)`，而不是在 mapHelpers 调用时一次性把 store 取出来、闭包到壳里。

换来：与「惰性创建 + 按调用选 pinia」完全对齐。mapHelpers 被调用那一刻 store 压根还没创建，只有壳被求值那一刻才存在解析的可能。整条链路从定义到求值，时机统一。

代价：每次 Vue 求值都要重新解析一次。解析本身命中注册表缓存、开销极小，但概念上是「每次访问都解析」而非「映射时绑定一次」。

本质矛盾：早期绑定更省更快，但要复制一份解析逻辑、跨时机共享 store，等于打开「两套实例化时机、两套行为」的口子。Pinia 选了「与已有解析时机的一致性」，宁可每次求值多一次缓存命中。

### 靠注入的 $pinia 显式传参，而不是依赖模块级 activePinia 兜底

选择：壳体内固定写 `useStore(this.$pinia)`，把当前组件实例上注入的 pinia 作为显式参数传给解析闭包；解析闭包的解析顺序也是「传入参数优先」。

换来：每个组件实例用各自 app 注入的 pinia。多 app 场景下各走各的，SSR 下也不会跨请求串态。

代价：壳强依赖宿主框架把 `$pinia` 注入到每个组件实例。没 `app.use(pinia)` 的话，求值时拿不到 pinia，dev 下直接报错。这层适配器没法脱离 Vue 组件上下文独立工作，它是一个必须插在 Options API 插座上的「翻译插头」。

本质矛盾：精确性（按 app、按请求隔离）与通用性（脱离框架也能用）打架。Pinia 选了精确——第 1 章讲过模块级 `activePinia` 兜底的 SSR 串态风险，这里既然能精准就精准。

### 只读来源与可写来源拆成两套映射

选择：`mapState` 返回 getter 函数（Vue 只读 computed 字面形态），`mapWritableState` 返回 `{get, set}` 对（Vue 可写 computed 字面形态）。两个独立函数，不靠标志位区分。

换来：可写映射支持 `v-model` 双向绑定。getter 是只读计算属性，本就不能写；只有 state 才能写。两个函数的「可写性」边界对作者一目了然。

代价：维护两个函数，作者要自己区分何时用哪个。可写映射只接受 state（getter 永远只读）。还有一条隐含代价：`mapWritableState` 的 set 是直接给 store 属性赋值，不经 `$patch` 那条批处理主路径。这种赋值仍能被 `$subscribe` 捕获，靠的是 store state 的深度监听，那是第 6 章主题。

本质矛盾：API 简洁（一个函数 + 标志位）与对齐 Vue computed 的两种字面形态（getter 函数 vs. `{get,set}` 对）。Vue 自己就用两种字面形态区分只读/可写 computed，mapHelpers 顺着分，作者在两边写法上得到的体验就和 Vue 原生 computed 一致。

### 整个 store 实例也作 computed 暴露，键名用 id 自动拼后缀

选择：`mapStores` 把整个 store 实例包成一个 computed，键名 = `useStore.$id + mapStoreSuffix`（默认后缀是 `'Store'`）。所以 `useCounterStore` 的实例在组件里通过 `this.counterStore` 就能拿到。

换来：零配置自动命名。作者不必手写别名，直接展开就能在 `this` 上拿到实例。

代价：命名由 store 的 id 决定，存在跨 store 撞名风险；后缀本身是模块级可变全局（可被 `setMapStoreSuffix` 改、也可置空），TS 下要拿到准确类型还得手动扩展 `MapStoresCustomization` 接口。

本质矛盾：零配置便利与命名空间控制。这是 Options API 整套设计的取舍：它假设作者会自己避免撞名，换取少写代码的便利。

## 5. 最小原理演示

下面这段从零搭一个最小可跑的演示，演透三件事：**壳被读时才求值、经注入的 pinia 解析、get/set 分离**。模拟 Vue 求值 computed 用一个手写的 `壳.call(组件实例)`，反而比真跑 Vue 更能看清「壳在被读那一刻才执行」这个时序。

```ts
// 解析闭包：接收 pinia 参数、首次创建并缓存 store（极简形态详见第 3 章）
type StoreCtor = (pinia: any) => any
const registry = new Map<string, any>()

function defineStore(id: string, setup: () => any): StoreCtor & { $id: string } {
  const useStore = function (pinia: any) {
    if (!pinia) throw new Error('没有 pinia，请检查 app.use(pinia)')
    if (registry.has(id)) return registry.get(id)
    const store = setup()
    registry.set(id, store)
    return store
  } as StoreCtor & { $id: string }
  useStore.$id = id
  return useStore
}

// 一个示例 store：state/getter/action 三分（详见第 4 章）
const useCounterStore = defineStore('counter', () => {
  let count = 0
  return {
    get count() { return count },
    set count(v: number) { count = v },
    double() { return count * 2 },
    inc(n = 1) { count += n },
  }
})

// getter 壳：被读时才解析 store
function mapState(useStore: StoreCtor, keys: string[]) {
  return keys.reduce((acc: Record<string, () => any>, key) => {
    acc[key] = function (this: any) {
      return useStore(this.$pinia)[key]
    }
    return acc
  }, {})
}

// 可写壳：get/set 分离，set 直接给 store 属性赋值（不经 $patch）
function mapWritableState(useStore: StoreCtor, keys: string[]) {
  return keys.reduce((acc: Record<string, any>, key) => {
    acc[key] = {
      get(this: any) { return useStore(this.$pinia)[key] },
      set(this: any, v: any) { useStore(this.$pinia)[key] = v },
    }
    return acc
  }, {})
}

// 方法壳：转发参数到 store 的 action
function mapActions(useStore: StoreCtor, keys: string[]) {
  return keys.reduce((acc: Record<string, (...a: any[]) => any>, key) => {
    acc[key] = function (this: any, ...args: any[]) {
      return useStore(this.$pinia)[key](...args)
    }
    return acc
  }, {})
}

// 整个实例作为一个 getter 壳，键名 = id + 'Store'
function mapStores(useStore: StoreCtor & { $id: string }) {
  return {
    [useStore.$id + 'Store']: function (this: any) {
      return useStore(this.$pinia)
    },
  }
}

// 极简组件实例：$pinia 是 app.use(pinia) 注入的，其余字段就是 Options API 写法
const component: any = {
  $pinia: { /* 模拟注入的 pinia */ },
  computed: {
    ...mapState(useCounterStore, ['count']),
    ...mapWritableState(useCounterStore, ['count']),
    ...mapStores(useCounterStore),
  },
  methods: {
    ...mapActions(useCounterStore, ['inc']),
  },
}

// Vue 求值 this.xxx 时，相当于调 component.computed.xxx.call(component)
console.log(component.computed.count.call(component))   // 0：首次解析、创建并缓存 counter store
component.methods.inc.call(component, 2)                // 转发为 store.inc(2)
console.log(component.computed.count.call(component))   // 2：方法壳转发成功
component.computed.count.set.call(component, 10)        // 可写壳的 set，直接赋值给 store.count
console.log(component.computed.count.call(component))   // 10
console.log(component.computed.counterStore.call(component) === component.computed.counterStore.call(component))
// true：两次求值命中同一个缓存的 store 实例
```

## 6. 执行轨迹

输入：一个 Options API 组件，computed 和 methods 字段里展开映射。

- `computed: { ...mapState(useCounterStore, ['count']), ...mapStores(useCounterStore) }`
- `methods: { ...mapActions(useCounterStore, ['inc']) }`

时序：

1. 模块加载时调 mapHelpers，reduce 出壳对象。**此时注册表里没有 counter store**，`pinia._s` 是空的。
2. 组件挂载、Vue 渲染要算 `this.count`，触发 `component.computed.count.call(component)`。
3. 壳函数体执行：读 `this.$pinia`，把它传给 `useCounterStore(this.$pinia)`。
4. 解析闭包「传入参数优先」拿到 pinia；查 `pinia._s` 没命中，调 setup 创建 counter store，缓存进注册表。
5. 壳从 store 上读 `count`（值 0），返回给 Vue。
6. 用户点按钮触发 `this.inc(2)`：方法壳把参数转发为 `store.inc(2)`，store 内部 state 变为 2。
7. 下次渲染求 `this.count`，壳再次执行，`useStore` 命中注册表缓存，直接返回同一个 store，读到 2。
8. 模板里用 `this.counterStore`：触发 `mapStores` 包出来的那个壳，同样经解析拿到整个 store 实例。

输出：`this.count` 始终等于 `store.count`，响应式跟随；`this.counterStore === store`，是同一个实例；`this.inc(2)` 转发为 `store.inc(2)`；可写映射的 set 直接给 store 属性赋值。

## 7. 教学简化说明

演示故意省略：对象形态的 key 映射（值可以是字符串或自定义函数，自定义函数以组件实例为 `this` 调用）、后缀可配置（`setMapStoreSuffix`）、误用诊断告警（`PINIA_R1001`）、完整 TS 重载与 `_StoreObject/_Spread/_MapStateReturn` 等映射类型推导链。

## 8. 小结

这一层不发明新机制，是已有机制的「翻译插头」：把组合式 store 的解析时机，挂到 Vue 求值 computed 的钩子上。读者写 `...mapState(...)` 时，背后只是注册了一批待执行的闭包，等 Vue 来敲门那一刻才走回那条已经在第 3、4 章建好的实例化路径。正因为它只是个适配层，它消费 store 的 state/getter/action 三分结构、消费注入的 `$pinia`，而不是另起一套。

下一章 HMR：保留状态的就地热更新，会看 store 在不重建身份的前提下，怎么把新版 state/getter/action 原地搬进既有实例。

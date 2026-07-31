# mapHelpers：Options API 适配

## 当组件根本没有 setup()

一个项目里，总有大量用「选项式」写的组件——它们声明 `data`、`computed`、`methods` 对象，却没有 `setup()` 函数。如果状态库只能在 `setup()` 里被调用，这些老组件就得**全部改写成组合式**才能用上 store。使用者真正想要的，是像展开一个普通对象那样，把 store 里的状态、计算属性、动作直接「铺」进组件**已有的** `computed` / `methods` 字段：

```js
// 一个选项式组件，全程不写 setup()
export default {
  computed: {
    ...mapState(useCounterStore, ['count', 'double']), // 只读派生值
    ...mapStores(useUserStore, useCartStore),          // 整个 store
    ...mapWritableState(useCounterStore, ['count']),   // 可双向绑定
  },
  methods: {
    ...mapActions(useCounterStore, ['increment']),     // 动作
  },
}
```

四个映射函数（`mapStores` / `mapState` / `mapActions` / `mapWritableState`）就是为这个场景而生。它们全部来自同一个文件 `mapHelpers.ts`，是 Pinia 的「system」层适配器——站在 `defineStore` 章节讲过的 `useStore` 工厂之上，专门服务不用 Composition API 的人。

## 核心思想：映射即惰性取用器

**一句话：映射即惰性取用器——注册时只把一个「未执行的函数」放进结果对象，等组件真正访问该属性、`this` 已经是组件实例时，才去「取 store、取属性」。**

这是全章灵魂句。为什么必须「推迟取用」？因为**取 store 这件事依赖运行时上下文**：取一个 store，需要先拿到「当前应用挂的那个 Pinia 实例」，而该实例要到 `app.use(pinia)` 之后才存在。在组件被定义（也就是写 `computed: { ...mapState(...) }`）的那一刻，这个上下文还没准备好。

于是 mapHelpers 的解法是：**别在定义时取，把「取用」写成一个普通函数塞进结果对象**。这个函数被展开进 `computed` / `methods` 后，由 Vue 框架在合适的时机、带着正确的 `this` 去调用。如此一来，既绕开了「必须有 setup」，又等到了上下文齐备的那一刻才真正求值。

## 地基：`this.$pinia` 从哪来

「惰性取用器」要在被调用时拿到 Pinia 实例，靠的是组件实例上的一个全局属性 `$pinia`。它的来历要回到 `createPinia` 章节：Pinia 实例本身是一个 Vue 插件，在 `app.use(pinia)` 的安装阶段，它把自己挂到了应用的**全局属性**上。

```
app.use(pinia)
  → 触发 install(app)
  → app.config.globalProperties.$pinia = pinia   # 挂到全局属性
```

挂上去之后，**任何选项式组件的 `this.$pinia` 都能取到这同一个 Pinia 实例**。类型层面，Pinia 通过向 Vue 的 `ComponentCustomProperties` 接口做「声明合并」，让 `this.$pinia` 不只是运行时存在、还能被 TypeScript 正确识别。这条链路是整章机制的地基——四个映射函数的每个取用器，体里都写着同一句 `useStore(this.$pinia)`。

> 前置概念来自 `define-store`（`useStore` 工厂的懒实例化与单例缓存）与 `pinia-instance`（`app.use` 的安装契约）两章。

## 四个函数，同一颗种子

尽管有四个函数，它们生成的每个产物本质都是**同一个东西的变体**：一个「在组件实例上下文里执行的函数」，函数体里都出现同一表达式——用 `this.$pinia` 调用 `useStore`、再按下标取属性。区别只在最后一步对返回值怎么处理：

| 函数 | 产物形态 | 展开进 | 语义 |
|------|---------|--------|------|
| `mapStores` | `() => store` | `computed` | 把「整个 store」当一个只读属性 |
| `mapState` | `() => 值` | `computed` | 只读取值（state / getter） |
| `mapActions` | `(...args) => 结果` | `methods` | 动作转发 |
| `mapWritableState` | `{ get, set }` | `computed` | 可写取值，喂给 `v-model` |

关键时机只有两个，务必分清：

```
定义组件时（mapXxx 执行）            访问属性时（取用器执行）
  ├ 遍历每个键                        ├ this 已是组件实例
  ├ 为每键生成「未执行」函数          ├ 读 this.$pinia 拿到 Pinia 实例
  └ 展开进 computed/methods           └ useStore(pinia)[key] 才真正求值
     （函数此刻一行都没跑）
```

下面自底向上，逐个看这颗种子长出的四种形态。为突出思想，下面给出的都是改写后的最小示意，并非逐字源码。

## mapStores：把整个 store 当成一个属性

`mapStores` 接收一串 `useStore` 工厂，为每个工厂生成一个**返回整个 store** 的取用器。它要解决一个独有问题：键名怎么定？答案是「工厂的标识符 + 一个全局后缀」。

```ts
// 最小示意（非逐字源码）：mapStores 的取用器长什么样
function mapStores(...stores) {
  return stores.reduce((out, useStore) => {
    // 键名 = 工厂的 $id + 全局后缀；$id 是 defineStore 给工厂挂上的标识符
    out[useStore.$id + mapStoreSuffix] = function () {
      return useStore(this.$pinia)   // 返回整个 store 实例
    }
    return out
  }, {})
}
```

默认后缀是字符串 `"Store"`，所以工厂 id 为 `user` 时，访问器名就是 `userStore`；id 为 `cart` 时是 `cartStore`。注意 `useStore.$id` 这个标识符不是凭空来的——它由 `defineStore` 在返回工厂闭包时附加到工厂函数上。后缀之所以能一行改全局，是因为它是一个**模块级可变变量**（默认 `"Store"`），配合一个 `setMapStoreSuffix()` 的 setter：调用一次 `setMapStoreSuffix('')` 就能让所有 `mapStores` 产物去掉后缀。代价是引入了非局部的可变状态——改一处影响全局，且类型层面要靠一处声明合并接口配合，改后缀后类型才跟着对上。

> 小贴士：若误把一串工厂塞进数组再传（`mapStores([...])`），开发模式下会触发一条诊断警告（提示生产环境会失败）并自动展开该数组让它继续跑通。

## mapState：只读取值

`mapState` 的每个产物是一个**只取值、不带 setter** 的函数，展开进 `computed` 即成为只读计算属性。它同时接受数组与对象两种入参：

```ts
// 最小示意（非逐字源码）：只读取值器
function mapState(useStore, keysOrMapper) {
  if (Array.isArray(keysOrMapper)) {
    // 数组形态：键同名铺开
    return keysOrMapper.reduce((out, key) => {
      out[key] = function () {
        return useStore(this.$pinia)[key]
      }
      return out
    }, {})
  }
  // 对象形态：可重命名，值还可换成「接收 store 的自定义函数」
  return Object.keys(keysOrMapper).reduce((out, key) => {
    const src = keysOrMapper[key]
    out[key] = function () {
      const store = useStore(this.$pinia)
      return typeof src === 'function' ? src.call(this, store) : store[src]
    }
    return out
  }, {})
}
```

数组形态最常见：`mapState(useCounterStore, ['count'])` 直接把 store 的 `count` 同名铺开。对象形态更灵活：键是结果名、值是来源键名（可重命名，如 `{ n: 'count' }`）；值还能是一个**接收 store 的函数**（如 `{ triple: s => s.n * 3 }`），该函数被调用时 `this` 会绑定到组件实例——但官方文档也提醒：这层 `this` 不会被类型推导识别（typed 但不静态校验）。

> `mapGetters` 只是 `mapState` 的一个废弃别名（`export const mapGetters = mapState`）。原因：在本库里 getter 与 state 都是 store 上的普通属性，无需区分，故统一用 `mapState`。

## mapActions：动作转发

`mapActions` 的产物是「带剩余参数转发的函数」，调用时先取 store，再把参数原样转发给对应动作。它展开进 `methods`：

```ts
// 最小示意（非逐字源码）：动作转发器
function mapActions(useStore, keysOrMapper) {
  return Object.keys(keysOrMapper).reduce((out, key) => {
    const src = keysOrMapper[key]
    out[key] = function (...args) {
      return useStore(this.$pinia)[src](...args)  // 剩余参数原样转发
    }
    return out
  }, {})
}
```

与 `mapState` 的一个差别在于：对象形态里，`mapActions` 的值**只能是字符串键名**（指向某个动作），不像 `mapState` 那样支持自定义函数。这是合理的——动作需要的是「被调用 + 转发参数」，自定义函数在这个场景没有意义。

## mapWritableState：可写的 get/set

这是与 `mapState` 的关键分野。`mapState` 只读，派生值（getter）本就不该被写；但当你要把某个**原始 state** 接到 `v-model` 上做双向绑定时，就需要一个能写回 store 的产物。`mapWritableState` 返回的每个值是 `{ get, set }` 对：

```ts
// 最小示意（非逐字源码）：可写取值器，set 把值写回 store
function mapWritableState(useStore, keys) {
  return keys.reduce((out, key) => {
    out[key] = {
      get() { return useStore(this.$pinia)[key] },
      set(v) { useStore(this.$pinia)[key] = v },   // 写回 store，触发响应式
    }
    return out
  }, {})
}
```

框架把 `{ get, set }` 包成**可写计算属性**，于是它能喂给双向绑定。文档明确指出它「只能加 state 属性」——因为这面向的是可写语义，对一个只读 getter 去 set 没有意义。这就是「只读访问」与「可写访问」必须拆成两套 API 的原因：让使用者**主动选对**，避免误把只读派生值当成可写状态去绑定。

## 数组还是对象：一次 `Array.isArray` 分流

`mapState`、`mapActions`、`mapWritableState` 三个函数都支持数组与对象两种入参。它们对外各自暴露了「数组」「对象」两套重载签名，内部则共用**一个实现重载**：开头用一次 `Array.isArray` 把入参分流——是数组就走「键同名铺开」，是对象就走「可重命名」分支。

这套「一个实现伺候两套签名」换来了灵活（既能同名铺开、又能重命名/派生），代价是每个函数要维护多个重载签名，实现里也出现了若干被 `FIXME` 标注的类型断言抑制注释——这是已知的类型推导短板，仅影响静态校验，不影响运行时行为。

## 一次完整执行轨迹

把上面拼起来，追踪 `computed: { ...mapState(useCounterStore, ['count']) }` 随后访问 `this.count` 的全过程（下列源码位置可对照查阅）：

```
组件访问 this.count
  → 取用器函数被框架调用（this = 组件实例）
  → 读 this.$pinia          # createPinia.ts:29 的 install 把它挂到全局属性
  → useStore(pinia)         # store.ts:883 的工厂：取已注册单例，首次则懒创建并登记
  → store[key]              # 取值；store.ts:951 处 useStore.$id 提供命名用的标识符
```

- `this.$pinia` 的来源在 `createPinia.ts:29`：安装阶段 `app.config.globalProperties.$pinia = pinia`；其类型经 `globalExtensions.ts:8-12` 的声明合并补上。
- 取用器的统一形态——那句 `useStore(this.$pinia)`——在 `mapHelpers.ts:114`（取整个 store）、对象/数组取值、动作转发、可写 get/set 处反复出现；其中可写的 get/set 写回逻辑见 `mapHelpers.ts:521-531`。
- `useStore.$id` 由 `store.ts:951` 附加到工厂，是 `mapStores` 拼键（`$id + 后缀`）的依据。

**输入**：组件声明 `...mapState(useCounterStore, ['count'])`，随后访问 `this.count`。
**输出**：`this.count` 返回 `store.count` 的当前值，并建立响应式依赖（store 里 `count` 一变，该计算属性就重算）。

## 从零实现：把「惰性取用器」演透

抛开泛型、多重载、诊断与 devtools，仅用几十行从零演示「映射产物是个被推迟执行的取用器」。这段只演两条核心权衡：**① 惰性取用换零 setup；② 只读 vs 可写显式区分。**

```ts
// ① 伪造的状态库工厂：带可用作命名的 $id，并缓存单例
function defineFakeStore(id, state, actions) {
  function useStore(pinia) {
    if (!pinia._cache[id]) pinia._cache[id] = { ...state, ...actions }
    return pinia._cache[id]
  }
  useStore.$id = id // 这正是 mapStores 拼键用的标识符
  return useStore
}

// ② 只读映射：产物是「未执行」的取值函数
function mapState(useStore, keys) {
  return keys.reduce((out, key) => {
    out[key] = function () {            // return 的是函数本身，此刻没求值
      return useStore(this.$pinia)[key] // this 要等被调用时才落地
    }
    return out
  }, {})
}

// ③ 可写映射：产物是 { get, set }，set 把值写回 store
function mapWritableState(useStore, keys) {
  return keys.reduce((out, key) => {
    out[key] = {
      get() { return useStore(this.$pinia)[key] },
      set(v) { useStore(this.$pinia)[key] = v },
    }
    return out
  }, {})
}
```

用一个挂好 `$pinia` 的伪造组件实例当 `this` 去跑，就能亲眼看到三件事：

```ts
const pinia = { _cache: {} }                       // 假装 app.use(pinia) 已挂载
const useCounter = defineFakeStore('counter', { count: 1 }, { inc() { this.count++ } })
const component = { $pinia: pinia }                // 任何选项式组件的 this 都有它

// 定义期：函数只是被登记，并未取值
const computed = { ...mapState(useCounter, ['count']) }
const methods  = { ...mapWritableState(useCounter, ['count']) }

// 访问期：this 此刻才落地，才真正去「取 store、取值」
computed.count.call(component)   // → 1   （惰性：调用才求值）
methods.count.call(component)    // 取 getter → 1
methods.count.call(component)    // 注意 set 语义：下面演示写回
// 演示写回：拿到 set，把值写回 store
Object.getOwnPropertyDescriptor(methods, 'count').set.call(component, 9)
computed.count.call(component)   // → 9   （set 已写回，响应式依赖随之更新）
```

跑完这段，就理解了整章：**映射产物不是值、不是 store，而是一个「被推迟执行的取用器」**；读访问和写访问之所以是两个函数，是因为它们的产物形态（取值函数 vs `{ get, set }`）从根本上不同。

## 四条权衡，一句话回顾

1. **把每个映射写成「带 this 的函数」而非立即求值的值** → 换来可直接展开进选项式、用户零 setup 改造；代价是每次属性访问都要重走「取实例 → 取单例 store」的调用链（store 虽是缓存单例，但取用器调用本身不省）。
2. **只读与可写拆成两套 API**（`mapState` 返回取值函数、`mapWritableState` 返回 `{ get, set }`）→ 换来精确表达「只读派生值不可写、原始 state 可双向绑定」；代价是使用者须主动选对，且可写那套只接受原始 state 键名。
3. **同一函数兼收数组与对象、内部用 `Array.isArray` 分流** → 换来「同名铺开」与「重命名/派生」兼顾；代价是多重载签名与若干类型断言抑制。
4. **命名后缀用「模块级可变变量 + setter」**而非配置对象 → 换来一行调用全局改后缀；代价是非局部可变状态（改一处影响全局），并需声明合并接口配合类型。

掌握「惰性取用器」这一颗种子，四个函数就不再是四个 API，而是同一思想的四种包装。
# Options API 映射辅助

> 本章源文件：`packages/pinia/src/mapHelpers.ts`（555 行）。它依赖且仅依赖 `store-definition`——只要手里有 `defineStore` 返回的 `StoreDefinition`，本模块就能工作。

## 这一章解决什么问题

在 Composition API（`setup()`）里用 store，直接 `const counter = useCounterStore()` 即可，写法与响应式天然契合。但很多项目仍在用 **Options API**——即 `export default { computed: {...}, methods: {...} }` 这种声明式写法。在这种组件里，没有一个地方可以「先拿到 store，再把它拆成 computed / methods」。

`mapHelpers.ts` 就是这座桥。它提供五个 map 函数（`mapState` / `mapWritableState` / `mapActions` / `mapStores`，以及作为别名的 `mapGetters`），让 Options API 组件像下面这样「展开使用」store：

```ts
export default {
  computed: {
    ...mapState(useCounterStore, ['count', 'double']),
  },
  methods: {
    ...mapActions(useCounterStore, ['increment']),
  },
}
```

理解了本章，你就理解了「为什么 map 函数能这样 `...` 展开」。

## 核心原语：返回「惰性取值函数」，而不是值

这是整个模块最关键、也最反直觉的设计：**所有 map 函数都不在调用时求值，而是返回一个「键 → 取值函数」的普通对象。**

以 `mapState` 的数组形态为例，每个键的值都是一个 **函数**，函数体里才真正去读 store：

```ts
reduced[key] = function (this: ComponentPublicInstance) {
  // @ts-expect-error: FIXME: should work?
  return useStore(this.$pinia)[key]
} as () => any
```
*源码位置：`mapHelpers.ts:262-265`*

为什么这么设计？因为 Vue 的 Options API 字段有严格的运行时约定：

- `computed` 字段期望的是 **「取值函数」**（一个 `() => value`）；
- `methods` 字段期望的是 **「方法函数」**（一个 `(...args) => result`）；
- 带 setter 的 computed 期望的是 **`{ get, set }` 对象**。

map 函数返回的「键 → 函数」对象，恰好能被 `...` 直接展开进对应字段——`computed` 里的函数会被 Vue 当成 getter，`methods` 里的函数会被当成方法。**函数即字段值，这是 map 能用展开运算符工作的根本原因。**

> 💡 关键推论：正因为返回的是函数而非值，**store 的取值被推迟到了「组件渲染求值的那一刻」**，而不是「map 调用的那一刻」。这一点我们马上会看到它为什么重要。

## 与组件世界的唯一连接点：`this.$pinia`

注意上面那段代码用普通 `function`（而非箭头函数）声明，并标注了 `this: ComponentPublicInstance`。这是故意的：map 函数返回的取值函数，需要在被 Vue 调用时拿到 **当前组件实例**，进而读取注入到每个组件上的 `$pinia`。

`$pinia` 是 Pinia 通过 Vue 的模块声明增强挂到所有组件上的全局属性：

```ts
declare module 'vue' {
  interface ComponentCustomProperties {
    /** Access to the application's Pinia */
    $pinia: Pinia
    _pStores?: Record<string, StoreGeneric>
  }
}
```
*源码位置：`globalExtensions.ts:8-21`*

拿到 `$pinia` 后，再 `useStore(this.$pinia)` 取回该 pinia 上的 store 实例（`useStore` 就是 `defineStore` 返回的 `StoreDefinition`，详见 store-definition 章）。

这条链路是「跨组件实例、跨请求」正确取 store 的关键。考虑这样的调用链：

```
组件 computed 求值（运行时）
  → map 函数返回的 function(this)
    → this.$pinia                     // 取当前组件注入的 Pinia 实例
      → useStore(this.$pinia)         // 取该 pinia 上的 store 实例
        → store[key]                  // 真正读取 state 属性或 getter
```

因为 store 是在求值时按 `this.$pinia` **现取** 的，而不是在 map 调用时缓存的，所以即便发生 **HMR 热替换、SSR 多实例隔离、测试里替换 store**，每次访问也都能拿到「当前正确的实例」。如果 map 函数在调用时就求值并缓存了 store，热替换后就会读到旧 store——这正是惰性设计要规避的陷阱。

## 统一骨架：数组 / 对象双形态 + reduce 拼接

`mapState`、`mapActions`、`mapWritableState` 三个函数的实现高度同构，都遵循同一个三段式骨架：

1. 用 `Array.isArray(keysOrMapper)` 判断传入的是数组还是对象，分流；
2. 用 `reduce` 把目标对象逐键拼出来；
3. 数组形态：键名 = store 上的属性名，直接取；对象形态：键名 = 自定义别名，值是「属性名字符串」或「自定义函数」。

```ts
return Array.isArray(keysOrMapper)
  ? keysOrMapper.reduce(/* 数组分支：键 = 属性名 */)
  : Object.keys(keysOrMapper).reduce(/* 对象分支：键 = 别名 */)
```
*源码位置：`mapHelpers.ts:259`、`:397`、`:518`（三者都是同一个分流结构）*

有了「惰性函数 + `this.$pinia` + 双形态 reduce」这三个底层原语，剩下的四个 map 函数就是它们的组合变体。下面自底向上逐个看。

## 变体一：`mapState` —— 把 state / getter 映射成 computed getter

数组形态最简单，每个键直接读 `store[key]`：

```
组件读取 this.count
  → function(this) 求值
    → useStore(this.$pinia)[key]
```

对象形态多一层：值可以是 **属性名字符串**，也可以是 **自定义 mapper 函数**。当它是函数时，会通过 `.call(this, store)` 调用，因此 mapper 内部能用 `this` 访问组件实例：

```ts
const store = useStore(this.$pinia)
const storeKey = keysOrMapper[key]
return typeof storeKey === 'function'
  ? (storeKey as (store: Store<Id, S, G, A>) => any).call(this, store)
  : store[storeKey]
```
*源码位置：`mapHelpers.ts:273-285`*

输入输出示例：

```ts
computed: {
  ...mapState(useCounterStore, {
    n: 'count',                              // 字符串：别名 = store.count
    triple: store => store.n * 3,            // 函数：自定义计算
    custom(store) {                          // 普通函数：可用 this 访问组件
      return this.someComponentValue + store.n
    },
  })
}
```

> ⚠️ 对象形态的 mapper 虽然能通过 `this` 读组件实例，但 JSDoc 明确说明 **「it won't be typed」**（TS 不会为它标注 `this` 类型），用的时候要自己小心（`mapHelpers.ts:163-166`）。

## 变体二：`mapActions` —— 把 action 映射成 methods

与 `mapState` 几乎一致，唯一差异是函数签名多了 `...args` 并透传给 action——因为 action 是方法、需要接受参数：

```ts
reduced[key] = function (this: ComponentPublicInstance, ...args: any[]) {
  return useStore(this.$pinia)[key](...args)
}
```
*源码位置：`mapHelpers.ts:400-406`（数组分支）、`:412-418`（对象分支）*

```
组件触发 this.increment(2)
  → function(this, 2) 求值
    → useStore(this.$pinia)['increment'](2)   // 取 action 并透传参数
```

## 变体三：`mapWritableState` —— 带 setter 的可写 computed

前两个变体返回的都是「函数」。而这个变体返回的是 **`{ get, set }` 对象**，对应 Vue 里「带 setter 的 computed」，让组件能直接对映射出的属性赋值：

```ts
reduced[key] = {
  get(this: ComponentPublicInstance) {
    return useStore(this.$pinia)[key]
  },
  set(this: ComponentPublicInstance, value) {
    return (useStore(this.$pinia)[key] = value)   // 直接对 store 属性赋值
  },
}
```
*源码位置：`mapHelpers.ts:521-531`（数组分支）、`:538-549`（对象分支）*

注意 `set` 是 **直接对 store 属性赋值**（`store[key] = value`）。这一行决定了一个重要限制：

> ⚠️ `mapWritableState` **只能映射 state 属性，不能映射 getter**。getter 是只读计算属性，对它 `store[key] = value` 会失败。JSDoc 已明确「only `state` properties can be added」（`mapHelpers.ts:460-464`）。这是它与 `mapState`（state + getter 都能映射）最实质的差异。

## 变体四：`mapStores` —— 把整个 store 实例映射成 computed

前三个变体都映射 store 的「成员」（state / getter / action）。`mapStores` 不同，它把 **整个 store 实例** 交给组件。它的取值函数连 `[key]` 都省了，直接返回 `useStore(this.$pinia)`：

```ts
return stores.reduce((reduced, useStore) => {
  reduced[useStore.$id + mapStoreSuffix] = function (this: ComponentPublicInstance) {
    return useStore(this.$pinia)
  }
  return reduced
}, {} as _Spread<Stores>)
```
*源码位置：`mapHelpers.ts:109-117`*

两个关键点：

1. **参数形态不同**：前三个 map 函数第一个参数是「单个 store 定义」，而 `mapStores` 接收 **多个 store 定义的剩余参数**（`...stores`），因为它的目的就是一次性映射多个 store。
2. **键名 = `$id + mapStoreSuffix`**：映射出的属性名是「store 的 `$id` + 全局后缀」，**与 `defineStore` 的函数名无关**，只取决于 store 的 id（`mapHelpers.ts:111`）。例如 id 为 `"user"` 的 store，默认会映射成 `this.userStore`。

```ts
computed: {
  ...mapStores(useUserStore, useCartStore)
}
created() {
  this.userStore  // id "user" + "Store"
  this.cartStore  // id "cart" + "Store"
}
```

### `mapStores` 独有的 dev-only 误用兜底

`mapStores` 开头有一段其它三个 map 函数都没有的保护，处理「把 store 数组当成单个参数误传」的常见错误：

```ts
if (__DEV__ && Array.isArray(stores[0])) {
  diagnostics.PINIA_R1001()
  stores = stores[0]
}
```
*源码位置：`mapHelpers.ts:104-107`*

- **触发条件**：写成 `mapStores([useAuthStore, useCartStore])`（错误地把数组整体当一个参数）。
- **dev 行为**：调用诊断 `PINIA_R1001()` 报告，并把 `stores` 修正为内层数组继续运行。
- **生产环境**：`__DEV__` 是编译期常量，生产构建会把整段判断 tree-shake 掉——所以这段代码 **只在开发期救命，生产环境会直接失败**。

诊断文案写得很直白：

```ts
PINIA_R1001: {
  why: 'Directly pass all stores to "mapStores()" without putting them in an array. This will fail in production.',
  fix: 'Replace mapStores([useAuthStore, useCartStore]) with mapStores(useAuthStore, useCartStore).',
}
```
*源码位置：`diagnostics.ts:11-15`*

这也是本模块与 `diagnostics` 模块的**唯一**连接点。

## 后缀定制：`mapStoreSuffix` 与 `setMapStoreSuffix`

`mapStores` 拼键名用的 `mapStoreSuffix` 是一个 **模块级 `let` 可变变量**，默认 `'Store'`：

```ts
export let mapStoreSuffix = 'Store'
```
*源码位置：`mapHelpers.ts:62`*

`setMapStoreSuffix(suffix)` 直接覆写这个全局变量（可设为空串）：

```ts
export function setMapStoreSuffix(suffix: ...): void {
  mapStoreSuffix = suffix
}
```
*源码位置：`mapHelpers.ts:71-77`*

> ⚠️ **易混淆点**：后缀是 **运行时全局可变状态**（`let`），`setMapStoreSuffix` 产生全局副作用，改了会影响所有后续 `mapStores` 调用。而 TypeScript 类型侧能正确推导键名（如推断出 `userStore` 而非 `user`），依赖用户 **手动声明式合并** 一个空接口：

```ts
// 用户侧需要这样写，TS 才能推出正确的键名
declare module 'pinia' {
  interface MapStoresCustomization {
    suffix: 'MySuffix'
  }
}
```
*接口定义：`mapHelpers.ts:17-21`；类型消费：`:26-53`*

**两者必须同步**：运行时改了后缀，类型接口也要扩展，否则运行时键名与类型推导会对不上。

## 别名：`mapGetters`

```ts
export const mapGetters = mapState
```
*源码位置：`mapHelpers.ts:296`*

仅为兼容旧版 API 的别名，标注了 `@deprecated use mapState() instead`，无任何独立实现，与 `mapState` 完全等价。

## 类型工具：为运行时结构服务

文件里散布着一批以 `_` 开头、标注「For internal use **only**」的类型（如 `_StoreObject`、`_MapStateReturn`、`_MapWritableStateReturn` 等）。它们的作用是给运行时函数标注返回类型，让组件 `...` 展开后能获得正确的类型推导——例如让 `this.count` 推断成 `number` 而非 `any`。

值得注意的是，实现中大量出现 `// @ts-expect-error` 与 `// FIXME: should work?` 注释（如 `:263`、`:283`、`:404`、`:416`）。这并非 bug，而是因为这些类型是 **手工对齐 Vue Options API 运行时约定**（computed 期望函数、methods 期望函数、可写 computed 期望 `{get,set}`）的拼接产物，存在已知的类型摩擦点。一句话总结：**这里的类型为运行时结构服务，而非反过来。**

三个 map 函数（`mapState` / `mapActions` / `mapWritableState`）也都采用 TS 重载的标准写法——**「对象重载 + 数组重载 + 宽泛实现签名」三段式**：调用点匹配到窄重载获得精确类型，运行时统一进实现签名按 `Array.isArray` 分流（`mapHelpers.ts:250`、`:387`、`:504`）。

## 小结：一张图理清四个变体

```
                底层原语
        ┌──────────────────────────┐
        │ 返回「键 → 惰性取值函数」  │  ← 用 ... 展开进 computed/methods
        │ 靠 this.$pinia 现取 store  │  ← 跨实例/HMR/SSR 始终拿对的 store
        │ 数组/对象双形态 + reduce   │  ← 统一骨架
        └─────────────┬────────────┘
                      │ 组合
   ┌──────────┬───────┴────────┬──────────────┐
   ▼          ▼                ▼              ▼
 mapState  mapActions   mapWritableState   mapStores
 读成员    调成员         读写成员           映射整个 store
 →函数     →函数(+args)   →{get,set}        →函数
 进computed 进methods     进可写computed     进computed
 (state+   (action)       只能是 state      键名=id+后缀
  getter)                                      dev 兜底
```

四个易混淆点，记住就够用：

1. **`mapWritableState` 只能映射 state，不能映射 getter**——因为 setter 直接 `store[key] = value` 写属性，getter 只读会失败。
2. **`mapGetters === mapState`**，deprecated 别名，无独立逻辑。
3. **`mapStores` 的键名由 `$id + mapStoreSuffix` 决定**，与 `defineStore` 的函数名无关。
4. **`mapStoreSuffix` 是全局可变 `let`**，运行时改后缀要同步扩展 `MapStoresCustomization` 接口，否则类型对不上。

最后，本模块 **零写入、零订阅**：不碰 `$patch` / `$subscribe` / `$onAction`，只读或只调 store。它的依赖图只有 `store-definition` 一个——这也是它能在 Options API 与 Composition API 之外、作为一层薄桥接独立存在的底气。
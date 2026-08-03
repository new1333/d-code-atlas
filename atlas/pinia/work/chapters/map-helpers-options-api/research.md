# mapHelpers：组合式 store 到 Options API 的适配层 · 源码精读

## 给 Writer 的教学钩子（必填，8 子项缺一不可）

- **用户痛点 / 场景**：Pinia 的 store 是「组合式」的——按惯例要在 `setup()` 里调 `useXxxStore()` 才能拿到实例。但很多项目还在用 Options API（`data/methods/computed` 那种写法），如果 store 只能在 setup 里用，Options API 的组件就没法优雅地接 store；而如果给 store 单独造一套 Options 专用的实例化路径，又会和 setup 路径分叉，同一份 store 两套行为。使用者要的是：在 Options API 的 `computed: {...}`、`methods: {...}` 里展开几下就能用 store，且行为和 setup 完全一致。

- **一句话核心思想**：映射辅助函数不取值、不建 store，只造一批「被读时才去解析 store」的访问器壳，把实例化推迟到 Vue 求值那一刻。

- **设计动机（为什么需要它）**：这个机制是为了解决「组合式 store 如何接入 Options API」这个矛盾而生的——它换来的能力是「同一份 store、同一条实例化路径，在两种作者语法下行为完全一致」。其中承前关系如下，供 Writer 跨章去重：
  - store 的「惰性创建 + 按调用解析 pinia」**（已在第 3 章『defineStore』讲透，本章只看它的新侧面：这个解析闭包被 Vue 的 computed getter / method 包裹后，如何服务 Options API，而不是在 setup 里直调）**。
  - 「组件实例上注入的 pinia 全局属性」**（已在第 1 章『Pinia 实例』讲透其注入与全局兜底，本章只看它的新侧面：作为访问器壳里『解析 store』时的显式入口参数，而非依赖模块级全局兜底）**。
  - store 的 state/getter/action 三分结构**（已在第 4 章『Store 装配』讲透，本章只是这三类的消费者：只读来源映射给 getter 壳、可写来源映射给 get-set 壳、动作映射给方法壳）**。

- **关键权衡（核心原料）**：
  1. **返回「延迟求值的访问器壳」而非「store 的值」** → 换来与「惰性解析闭包」「按调用选 pinia」完全对齐（store 在 map 调用时压根不存在）→ 代价是每次 Vue 求值 computed 都要重新走一次解析（解析本身命中缓存、开销极小，但概念上是「每次访问都解析」而非「map 时绑定一次」）。
  2. **靠「组件实例上注入的 pinia」显式传入解析闭包，而非依赖模块级全局活跃 pinia** → 换来 Options API 下也能精准拿到当前 app 的 pinia（多 app 各自正确、SSR 更安全）→ 代价是这些辅助函数强依赖宿主框架把 pinia 注入到每个组件实例（缺了它就直接报错），适配层无法脱离 Vue 组件上下文独立工作。
  3. **把「只读来源」与「可写来源」拆成两套映射（前者返回 getter 函数，后者返回 get/set 对）** → 换来 `v-model` 双向绑定能力（可写来源需要 set）→ 代价是必须维护两个函数，且可写映射只接受可写的来源（getter 是只读计算属性、不可写），用户需自行区分何时用哪个。
  4. **把「整个 store 实例」也作为一个 computed 暴露，键名用 store 的 id 自动拼后缀** → 换来零配置的自动命名（无需手写别名即可在 `this.xxxStore` 拿到实例）→ 代价是命名由 id 决定、存在跨 store 撞名风险，且后缀是一个模块级可变全局、类型侧还需手动扩展声明才能得到准确类型。

- **最小心智模型（3～7 步）**：
  1. 调用映射辅助函数时，完全不碰 store，只 `reduce` 出一批「访问器壳」（getter 函数 / get-set 对 / 方法函数）。
  2. 这些壳被展开进组件的 `computed` 或 `methods` 字段——此时组件尚未挂载、store 尚未创建。
  3. 组件挂载后，Vue 首次求值某个 computed（或某 method 被调用）时，对应壳的函数体才首次执行。
  4. 壳函数体读取「组件实例上注入的 pinia」（`this` 指向组件实例），把它作为参数传给「解析闭包」。
  5. 解析闭包按「显式传参优先」拿到 pinia，首次调用则创建 store 并缓存进注册表，之后命中缓存。
  6. 壳从拿到的 store 上读取/写入对应属性，或把方法调用转发到 store 的 action。
  7. 因为「取 store」永远发生在求值时、永远经注入的 pinia 解析，Options API 与 setup() 走的是同一条实例化路径，行为天然一致。

- **最小原理演示（替代旧"复刻范围"）**：
  - 应演示：一个**小到只表达「延迟求值 + 经注入 pinia 解析 + get/set 分离」**的从零实现（几十行）。要点：① 一个极简「解析闭包」（接收 pinia 参数、首次创建并缓存 store）；② 一个极简「组件实例」带注入的 pinia 字段；③ 三个映射函数，分别产出「getter 壳」「get-set 壳」「方法壳」；④ 一个极简的「computed 字段求值器」模拟 Vue 在渲染时调用这些壳。**这段演示演的是权衡 1（延迟求值）+ 权衡 3（get/set 分离）+ 核心思想（被读时才解析）。**
  - 应故意省略：数组和对象两种 key 形态的完整分支（演示一种即可）、自定义映射函数的 `this` 绑定、后缀可配置、诊断告警、完整泛型与 TypeScript 重载、devtools 集成。
  - **演示载体建议**：本仓库主语言是 TS/JS，建议写成一段能 `node`/`bun` 直接跑的独立脚本——因为本章机制不依赖真实 Vue 渲染，用一个「手写求值器」模拟 Vue 求值 computed getter 的时刻，反而最能演透「壳在被读时才执行」这个时序（真实 Vue 会把时序藏在响应式系统里，反而不直观）。不强求真跑 Vue 组件。

- **正文不宜展开的细节**：
  - `mapGetters` 只是 `mapState` 的 deprecated 别名（一行赋值）。
  - 后缀是模块级可变全局；TS 下要准确类型须手动扩展 `MapStoresCustomization` 接口。
  - `mapStores` 收到数组（误用）时触发一条诊断告警，提示应展开传参。
  - 可写映射的 set 是**直接给 store 属性赋值**（不走 `$patch` 那条批处理主路径），靠响应式 state 的深度监听触发订阅——这点与第 5 章『状态变更模型』形成对照，但不宜在本章展开。
  - 对象形态的映射值若是函数，会以组件实例为 `this` 调用（故不能用箭头函数）；类型推断极复杂、源码里大量 `@ts-expect-error`，属类型工程、非原理主线。
  - 类型侧另有一批 `_StoreObject`/`_Spread` 映射类型用于推导 `mapStores` 的返回键名，纯类型体操，不展开。

- **推荐的一个执行轨迹例子**：
  - 输入：组件定义 `computed: { ...映射(useCounterStore, ['count']), ...映射整个实例(useCounterStore) }`、`methods: { ...映射动作(useCounterStore, ['inc']) }`，另有一个可写来源映射。
  - 关键中间态：映射函数调用时只 `reduce` 出壳函数对象，**store 此时未创建**；组件挂载、Vue 渲染求值 `this.count` → 触发对应壳 → 用组件实例注入的 pinia 调解析闭包 → 首次创建 counter store 并缓存进注册表 → 返回 `store.count`。
  - 输出：`this.count === store.count`（响应式）；`this.counterStore === store`；`this.inc(2)` 转发为 `store.inc(2)`；给可写来源赋值触发其 set，直接写入 store 对应属性。

> 以上钩子供 Writer 写「动机→核心思想→心智模型→关键权衡→原理演示」；下面事实部分供核对，不要被 Writer 当目录照抄。

## 概念要点
- 映射辅助函数**不参与 store 装配、不创建 store**：四个导出（mapState/mapWritableState/mapActions/mapStores）函数体只是 `Array.reduce` / `Object.keys().reduce()` 生成一个「键 → 访问器壳」的对象，全程不调用解析闭包取实例。源码位置: packages/pinia/src/mapHelpers.ts:259-290（mapState）、397-423（mapActions）、504-554（mapWritableState）、109-117（mapStores）。
- 访问器壳的统一形态是「以组件实例为 `this` 的函数」，函数体内 `useStore(this.$pinia)` 在被求值时取 store。`this.$pinia` 的类型来源是 globalExtensions 对 Vue 组件实例属性的声明增强。源码位置: packages/pinia/src/globalExtensions.ts:8-21。
- `this.$pinia` 这个属性的运行时来源：createPinia 安装时同时走 `app.provide(piniaSymbol, pinia)`（inject 路径）与 `app.config.globalProperties.$pinia = pinia`（globalProperties 路径）。源码位置: packages/pinia/src/createPinia.ts:28-29。
- mapHelpers 把 `this.$pinia` 作为**显式参数**传给解析闭包；解析闭包的 pinia 解析顺序是「（测试模式忽略）|| 传入参数 || 注入（有注入上下文时）」，传入参数优先，解析到后 `setActivePinia` 设为活跃。源码位置: packages/pinia/src/store.ts:883-890。
- mapState 同时映射 state 与 getter（两者在 store 上都是「只读来源」），故共用一套「getter 函数」壳；对象形态的值可为字符串（取 store 同名属性）或函数（自定义映射，以组件实例为 this 调用）。源码位置: packages/pinia/src/mapHelpers.ts:270-285。
- mapWritableState 与 mapState 的根本区别：返回 `{ get, set }` 对（Vue 可写 computed 形态）而非 getter 函数；set 直接给 store 属性赋值，不经 `$patch`。源码位置: packages/pinia/src/mapHelpers.ts:518-553。
- mapActions 返回「转发参数的方法函数」：`function(...args){ return useStore(this.$pinia)[key](...args) }`，放 methods 字段。源码位置: packages/pinia/src/mapHelpers.ts:397-408。
- mapStores 暴露「整个 store 实例」为一个 computed，键名 = `useStore.$id + mapStoreSuffix`（后缀默认 'Store'，可经 setMapStoreSuffix 改、可置空）；`useStore.$id` 由 defineStore 挂上。源码位置: packages/pinia/src/mapHelpers.ts:62、71-77、109-117；useStore.$id 挂载 源码位置: packages/pinia/src/store.ts:951。
- mapStores 对「误传数组」做 dev 诊断（PINIA_R1001：应展开传参，否则 prod 会失败）。源码位置: packages/pinia/src/mapHelpers.ts:104-107；诊断文案 源码位置: packages/pinia/src/diagnostics.ts:11-12。

## 关键调用链
组件 `computed`/`methods` 字段求值 → 访问器壳执行（`this` = 组件实例）→ `useStore(this.$pinia)`（显式传注入的 pinia）→ store.ts:useStore 解析 pinia（传入参数优先）→ `pinia._s.has(id)` 命中缓存或首次创建 → 壳从 store 读属性 / 写属性 / 转发 action 调用。
源码位置: 求值入口 packages/pinia/src/mapHelpers.ts:262-264；解析 packages/pinia/src/store.ts:883-902。

## 源码摘录（带行号，全文累计 ≤ 30 行）

mapStores——最简洁地体现「getter 壳 + 经注入 pinia 解析」（演示核心思想 + 权衡 1）：
```ts
// mapHelpers.ts:109-117
return stores.reduce((reduced, useStore) => {
  // @ts-expect-error: $id is added by defineStore
  reduced[useStore.$id + mapStoreSuffix] = function (
    this: ComponentPublicInstance
  ) {
    return useStore(this.$pinia)
  }
  return reduced
}, {} as _Spread<Stores>)
```

mapState 数组形态——体现「延迟求值的 getter 壳」（演示核心思想）：
```ts
// mapHelpers.ts:261-265
reduced[key] = function (this: ComponentPublicInstance) {
  // @ts-expect-error: FIXME: should work?
  return useStore(this.$pinia)[key]
} as () => any
```

mapActions——体现「方法壳转发参数」（演示 action 三分消费）：
```ts
// mapHelpers.ts:400-405
reduced[key] = function (this: ComponentPublicInstance, ...args: any[]) {
  // @ts-expect-error: FIXME: should work?
  return useStore(this.$pinia)[key](...args)
}
```

mapWritableState——体现「get/set 分离」（演示权衡 3，set 直接赋值不经 patch）：
```ts
// mapHelpers.ts:521-530
reduced[key] = {
  get(this: ComponentPublicInstance) {
    return useStore(this.$pinia)[key] as (S & G)[typeof key]
  },
  set(
    this: ComponentPublicInstance,
    value: Store<Id, S, G, A>[typeof key]
  ) {
    return (useStore(this.$pinia)[key] = value)
  },
}
```

globalExtensions——`this.$pinia` 的类型来源（演示权衡 2 的强依赖）：
```ts
// globalExtensions.ts:8-12
interface ComponentCustomProperties {
  $pinia: Pinia
  _pStores?: Record<string, StoreGeneric>
}
```

## 易混淆 / 边界 / 推断
- **事实**：四个映射函数全部依赖 `this.$pinia`；若组件实例上没有注入的 pinia（没 `app.use(pinia)`），求值时解析闭包拿不到 pinia，dev 下直接抛「没有活跃 Pinia」错误。源码位置: packages/pinia/src/store.ts:892-898。
- **事实**：mapState 对象形态中，值若是函数，会 `.call(this, store)` 调用——`this` 是组件实例，故自定义映射可访问组件其它值，但作者必须用普通函数而非箭头函数。源码位置: packages/pinia/src/mapHelpers.ts:278-282。
- **事实**：mapWritableState 的 set 直接赋值 `store[key] = value`，不经 `$patch`；变更仍能被 `$subscribe` 捕获，靠的是 store state 的深度 watcher（第 6 章主题），而非 `$patch` 的批处理路径。
- **推断（标注为推断）**：mapHelpers 刻意把 `this.$pinia` 显式传给解析闭包、而非省略参数让其走模块级全局 activePinia 兜底——目的是在多 app 与 SSR 下，每个组件实例用各自 app 注入的 pinia，避免全局串态。源码依据：所有壳体内统一写 `useStore(this.$pinia)` 而非 `useStore()`（mapHelpers.ts:114/264/274/405/417/523/529/540/547），与 store.ts:888「传入参数优先」的解析顺序配合。
- **推断（标注为推断）**：mapState 与 mapWritableState 之所以是两个函数而非一个带标志位的函数，根因是 Vue computed 有「getter 函数（只读）」与「{get,set}（可写）」两种字面形态——只读来源（含 getter）只能走前者，可写来源（state）才能走后者，故按「可写性」分函数最自然。
- **未理解**：无。类型侧 `_StoreObject`/`_Spread`/`_MapStateReturn` 等映射类型的完整推导链较为复杂，但属类型工程、不影响运行原理，已归入「正文不宜展开的细节」，未深读。
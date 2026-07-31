# 插件系统：store 扩展点与混入 · 源码精读

## 给 Writer 的教学钩子（必填，8 子项缺一不可）

- **用户痛点 / 场景**：库作者或应用开发者想给「每一个 store」统一加点东西——调试钩子、测试替身、自动持久化、路由实例注入——但不想 fork 整个状态库去改内部装配流程。没有插件系统就只能靠继承或猴子补丁，既脆弱又难和官方更新兼容。用户真正要的是：「在我建好一个 store 之后、交给业务用之前，给我一个介入点。」

- **一句话核心思想**：在每个 store 装配到尾声时，把所有登记过的「扩展函数」挨个跑一遍，它们返回什么对象，就把这个对象原样贴到 store 上——一个统一钩子，养活 devtools、testing、用户自定义三类消费者。

- **设计动机（为什么需要它）**：devtools 要桥接每个 store 的变更、testing 要替换每个 store 的动作、用户要给每个 store 注入领域辅助方法。如果为每类需求开一套专用接口，装配代码会变成一长串 if-else，且新增需求必须改核心。于是留一个最小契约：函数拿到「正在建的 store + 上下文」，返回若干键值，核心负责贴上去。需求增减都不碰装配主线。

- **关键权衡（4 条三段式，本 Atlas 的核心）**：
  - **统一扩展点（装配末尾跑、返回值浅合并）** → 换来 devtools/testing/用户共用同一条介入路径、store 可获得任意注入能力，且扩展可以覆盖前面装配出的同名属性 → 代价是插件返回的「普通对象」会假装长在响应式 store 上却丢响应性，必须靠运行时警告 + 类型空接口双管齐下约束用户意图。
  - **插件在该 store 自己的副作用作用域内执行** → 换来插件返回的响应式引用/计算值自动挂在该 store 作用域下，store 销毁时随之一并回收，插件无需自己管生命周期 → 代价是插件若需要「跨多个 store 存活」的副作用，必须自行开独立作用域隔离，否则会随某个 store 提前销毁。
  - **先暂存再统一入队、严格按登记顺序执行** → 换来「扩展生效顺序 = 登记顺序」的确定性（测试替身正是靠排在最后才能覆盖掉真实动作），且与「应用何时挂载」这一时机解耦 → 代价是插件真正生效要等到应用挂载那一刻之后，在那之前只能排队等候。
  - **在合并进 store 之前检查插件的原始返回值** → 换来能分辨「插件给的是普通对象还是响应式值/显式跳过值」——一旦合并进响应式 store，响应式值会被解包，从此和普通对象再无法区分 → 代价是这项检查只在开发构建里跑，生产构建被裁掉。

- **最小心智模型（7 步）**：
  1. 创建实例时，内置的调试扩展先被登记；用户登记的扩展先进一个「等候队列」。
  2. 应用挂载那一刻，等候队列里的扩展被统一搬进「正式扩展列表」，顺序即登记顺序。
  3. 任意一个 store 被装配时，先把它的 state/getter/action 分类归位，并把自己注册进实例表，供别的 store 互引。
  4. 装配接近尾声，遍历正式扩展列表，每个扩展在该 store 自己的副作用作用域内执行，拿到「store + 应用 + 实例 + 定义选项」四样上下文。
  5. 扩展返回一个对象，核心把这个对象浅合并进 store——这些属性表现得就像原生长在 store 上。
  6. 合并前先扫一遍返回值：凡是「普通对象」（既不是响应式引用、不是响应式对象、也没被显式标记跳过）就发警告，提醒它解构后会丢响应性。
  7. 类型层面预留两个「空接口」，让用户用声明合并给这些注入属性补上类型签名，使 `store.自定义属性` 在编辑器里有提示。

- **最小原理演示（替代旧"复刻范围"）**：
  - 应演示：一个几十行的「伪装配尾巴」——维护一个扩展数组、一个 `登记(扩展)` 方法、一个 `建store()`；建 store 时遍历扩展数组、在「该 store 的作用域」里执行每个扩展、把返回对象合并进 store、合并前对每个值做「是否普通对象」的检查并警告。这段演示演的是「**统一钩子 + 作用域隔离 + 顺序确定 + 合并前检查**」这条权衡链，每一行都要能指回上面某条原理。
  - 应故意省略：真实的响应式系统与作用域实现、SSR/序列化、devtools 集成细节、完整泛型、Vue 应用挂载的真实流程。**不追求工程完整、不追求可独立安装**，只追求「演透一个钩子如何被四类消费者复用」。

- **正文不宜展开的细节**：devtools 用来列举「扩展加进来哪些属性」的那个内部集合；给 Vue 组件实例补 `$pinia` 类型的那个全局声明合并文件（它扩展的是组件实例属性，不是 store 属性，别和 store 的空接口搞混）；非响应式检查里 `null` 也被算作对象这一边界；等候队列与挂载时机的实现细节属另一章，本章只需点到「顺序即登记顺序」。

- **推荐的一个执行轨迹例子**：输入 = 一个返回 `{ 计数: ref(0), 重置: () => {} }` 的扩展 + 一个刚装配好的空 store → 关键中间态：在 store 作用域内跑扩展拿到返回对象、检查时「计数」是响应式引用故跳过、「重置」是函数故跳过、检查全过 → 输出：`store.计数` 现在是响应式值、`store.重置` 是方法，且二者都挂在该 store 作用域下、随 store 销毁自动回收。

> 以上钩子供 Writer 写「动机→核心思想→心智模型→关键权衡→原理演示」；下面事实部分供核对，不要被 Writer 当目录照抄。

## 概念要点

- **插件契约（PiniaPlugin）**：一个函数，入参是上下文 `{ pinia, app, store, options }`，返回「一个对象或 void」。返回的对象会被合并进 store。这是 devtools/testing/用户三方共用的唯一扩展点。源码位置: packages/pinia/src/rootStore.ts:159-172
- **插件上下文（PiniaPluginContext）**：四字段——`pinia`（实例）、`app`（Vue 应用）、`store`（正被扩展的 store）、`options`（该 store 的定义选项，已带上 actions 清单）。源码位置: packages/pinia/src/rootStore.ts:129-157
- **实例上的扩展槽（Pinia 接口里的 use / _p）**：`use(plugin): Pinia` 用于登记插件并返回 this（可链式）；`_p: PiniaPlugin[]` 是「已安装插件」数组，装配时按其顺序遍历。注意接口在此声明、实现在 createPinia。源码位置: packages/pinia/src/rootStore.ts:63-112（use 在 :76-77、_p 在 :83）
- **传给插件的 options 是一份拷贝**：装配时先 `assign({ actions: {} }, options)` 造出 optionsForPlugin，再在分类循环里把 actions 逐个填进 optionsForPlugin.actions——这样插件能拿到「整理过的 actions 清单」。源码位置: packages/pinia/src/store.ts:232-235 与 :552-554
- **执行时机：装配末尾**：插件遍历发生在 hotUpdate 定义、属性合并之后、hydrate 之前。注释明确「把热更新方法放在插件之前，是为了让插件能覆盖它」——即插件可覆盖前面装配出的任意同名属性（含内部方法）。源码位置: packages/pinia/src/store.ts:597-598 与 :716
- **插件在 store 自己的 effectScope 内跑**：`scope.run(() => extender(...))` 中的 scope 就是该 store 创建的 effectScope（store 作用域）。插件返回的 ref/computed 因此被该 scope 追踪，store `$dispose`（scope.stop）时一并回收。源码位置: packages/pinia/src/store.ts:500-502 与 :718-725
- **合并前响应式检查（PINIA_R1006）**：对「assign 之前」的原始返回值逐键检查——`typeof === 'object'` 且非 ref、非 reactive、无 `__v_skip` 标记者，判为「会丢响应性的普通对象」并报警。注释说明：必须在 assign 前检查，因为合并进 reactive store 后响应式值会被解包、与普通对象不可区分。源码位置: packages/pinia/src/store.ts:734-751
- **markRaw 的逃生口**：被 markRaw 处理过的值带 `__v_skip`，检查时被跳过——这就是「注入 router 实例等不应响应式的对象」的正解（让用户明确表达「我不要它响应式」）。源码位置: packages/pinia/src/store.ts:746
- **混入动作**：`assign(store, extensions)` 把插件返回对象浅合并进响应式 store。源码位置: packages/pinia/src/store.ts:753
- **入队时机（关联上下文，实现在 createPinia）**：`_p` 初始为空数组；`use(plugin)` 在应用未挂载（`!this._a`）时进 `toBeInstalled` 暂存，已挂载时直接 `_p.push`；应用挂载（install）那一刻才把 `toBeInstalled` 统一搬进 `_p`。内置 devtools 扩展在 createPinia 末尾经 `pinia.use(devtoolsPlugin)` 登记。源码位置: packages/pinia/src/createPinia.ts:18-20、:34、:39-43、:59
- **类型扩展点：两个空接口**：`PiniaCustomProperties`（插件加到 store 上的属性类型）与 `PiniaCustomStateProperties`（加到 `$state` 上的属性类型）都是空接口，注释标注「由用户扩展」。Store 类型通过 `& PiniaCustomProperties<...> & PiniaCustomStateProperties<S>` 组合它们——用户用 `declare module 'pinia'` 声明合并即可让所有 store 拿到自定义属性类型。源码位置: packages/pinia/src/types.ts:520-528、:530-533、:475-476
- **globalExtensions 的真实职责**：本章列出的 globalExtensions.ts 用 `declare module 'vue'` 扩展的是 **Vue 组件实例属性**（`$pinia`、devtools 用的 `_pStores`），不是 store 插件属性。它和上面的空接口是两套不同的「声明合并」手法，别混为一谈。源码位置: packages/pinia/src/globalExtensions.ts:4-22

## 关键调用链

- 装配侧（本章主角）：`useStore()` → `createSetupStore()` → 分类归位 state/getter/action → `pinia._p.forEach(extender => scope.run(extender(ctx)))` → 合并前响应式检查 → `assign(store, extensions)`
  源码位置: packages/pinia/src/store.ts:716-754（其中 scope 创建在 :501，分类循环填 actions 在 :552-554）
- 注册侧（关联）：`createPinia().use(plugin)` →（未挂载）`toBeInstalled.push` /（已挂载）`_p.push` → `install(app)` 时 `toBeInstalled` 全部搬进 `_p`
  源码位置: packages/pinia/src/createPinia.ts:18-44

## 源码摘录（带行号，全文累计 ≤ 30 行）

```ts
// packages/pinia/src/store.ts —— 装配末尾：跑插件、合并前检查、混入（本章灵魂）
pinia._p.forEach((extender) => {                         // :717
  const extensions = scope.run(() =>                     // :718 在 store 自己的 effectScope 内执行
    extender({ store, app: pinia._a, pinia, options: optionsForPlugin }) // :719-724 四字段上下文
  )!
  if (__DEV__) {                                         // :737 合并前检查原始返回值
    for (const key in extensions) {
      const value = (extensions as any)[key]
      if (typeof value === 'object' && !isRef(value) && !isReactive(value) && !value?.__v_skip) // :742-747
        diagnostics.PINIA_R1006({ key, id: $id })        // :748
    }
  }
  assign(store, extensions)                              // :753 浅合并进 store
})
```

```ts
// packages/pinia/src/createPinia.ts —— 入队时机：暂存→挂载时统一入列（关联上下文）
let _p: Pinia['_p'] = []                  // :18 正式插件列表
let toBeInstalled: PiniaPlugin[] = []     // :20 install 前暂存
// install(app) 内：                       // :34 挂载时统一入队，顺序即登记顺序
  toBeInstalled.forEach((plugin) => _p.push(plugin)); toBeInstalled = []
// use(plugin)：                           // :39-43
  if (!this._a) toBeInstalled.push(plugin)  // 未挂载→排队
  else _p.push(plugin)                       // 已挂载→直接入列
```

```ts
// packages/pinia/src/globalExtensions.ts —— 用声明合并给 Vue 组件实例补 $pinia 类型（非 store 属性）
declare module 'vue' {                     // :4
  interface ComponentCustomProperties {
    $pinia: Pinia                           // :12 组件内 this.$pinia 有类型
    _pStores?: Record<string, StoreGeneric> // :20 devtools 列举 store 用
  }
}
```

## 易混淆 / 边界 / 推断

- **事实**：PINIA_R1006 检查里 `typeof value === 'object'` 会把 `null` 也算进去（typeof null === 'object'），所以插件返回 `{ x: null }` 也会触发警告——这是边界，注释 :740 明确写了「null is included」。源码位置: packages/pinia/src/store.ts:740-748
- **事实**：检查只看「值」，且只对 object 报警；function、原始类型（number/string/boolean）、ref、reactive、markRaw 值均不报。源码位置: packages/pinia/src/store.ts:742-747
- **推断**：把热更新方法放在插件之前（:597 注释），加上 assign 是「后写覆盖先写」的浅合并，意味着插件拥有「覆盖 store 任何既有属性（含内部方法）」的能力——这是有意留出的覆盖口，testing 替身、用户重写动作都依赖它。
- **推断**：用 `scope.run`（store 作用域）而非实例级作用域跑插件，是为了让插件返回的响应式值「随 store 生灭」——这决定了「跨 store 长效副作用须自行开作用域」这一使用约束。
- **易混淆**：summary 把 globalExtensions 与「声明合并扩展 PiniaCustomProperties」并提，但二者是两套独立机制——globalExtensions 扩展 Vue 组件属性（$pinia），store 插件属性的类型扩展点在 types.ts 的空接口。Writer 切勿在正文把两者写成同一回事。
- **未理解**：`__USE_DEVTOOLS__ && IS_CLIENT` 分支里 `store._customProperties.add(key)` 的集合，下游 devtools 具体如何消费（属 devtools 章），本章未深入追踪。
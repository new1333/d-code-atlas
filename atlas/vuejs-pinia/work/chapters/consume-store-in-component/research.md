# 在组件中消费 Store：解构与映射 · 源码精读

## 给 Writer 的教学钩子（必填，8 子项缺一不可）

- **用户痛点 / 场景**：
  使用者拿到一个 store 后，最自然的写法是把它「解构」进组件，按字段直接用。但 store 是一个被响应式代理包裹的整体对象，直接解构会把字段「拷」成普通值，响应性当场丢失——改了状态，界面不动。另一类痛点来自 Options 风格组件：它没有 setup 这一时机去调用工厂函数拿 store，开发者需要一种「声明式铺开」的写法，把状态、计算属性、动作像 Vuex 时代那样映射进 computed 与 methods。本章讲的两个消费入口，就是为这两类痛点而生：一个解决「解构不丢响应性」，一个解决「无 setup 时机也能用 store」。

- **一句话核心思想**：
  **按成员的响应式特征重新分类，只把会变的成员重新打包成引用，把不会变的动作直接丢弃或转发**。

- **设计动机（为什么需要它）**：
  store 在内部是一个统一的响应式代理对象，state、计算属性、动作这三类成员被「摊平」挂在同一个对象上（这套三分结构的**建立**已在第 5 章『Setup Store 的运行时自动分流』讲透——前置章负责「按特征把属性分类并挂上 store」，本章是它的**消费侧镜像**：按同一套特征再探测一次，把已经混在一起的三类成员**还原**成「可安全解构的引用集合」与「可声明式铺开的闭包集合」）。之所以需要「再探测一次」，是因为组件侧拿到的 store 是组装完成的成品，已经看不出哪个字段原本是 state、哪个是计算属性；消费入口必须在运行时自己再跑一遍特征识别。此外，Options 风格组件的映射入口与 store 的定义风格（Options/Setup）**正交**——它服务的是「组件的写法」，不是「store 的写法」（声明式三分的定义本身已在第 6 章『Options Store：声明式三分与统一组装』讲透，本章不再重述）。

- **关键权衡（选择 → 换来 → 代价）**：
  1. **用「身上是否挂着副作用标记」来反认计算属性，而非整段复制其值** → 换来解构后每个字段仍是独立引用、计算属性的惰性求值与缓存得以保留、且状态字段与计算字段走同一条「转发回原对象」的单一数据源 → 代价是必须依赖框架内部「计算属性身上挂了副作用」这一实现细节（当时没有官方判定 API），多包了一层间接。
  2. **解构助手主动跳过动作，只返回响应式成员** → 换来「解构出来的全是会变的引用」这一干净心智，与「解构状态」的直觉对齐 → 代价是动作必须另从原对象取，不能与状态一起解构。
  3. **映射入口把每个字段都做成一个「延迟到渲染期才调用工厂」的闭包，而非在 setup 期一次性拿到 store** → 换来 Options 风格组件无需 setup 时机也能用 store、store 真正被首次访问（渲染期）才创建、且天然绑定到当前组件实例所属的 Pinia → 代价是每次读取属性都要重新走一遍工厂调用（工厂内部对已建 store 是查表，开销可接受）。
  4. **映射入口全部用普通函数（而非箭头函数）+ 从组件实例上读 Pinia** → 换来「不依赖任何全局单例变量」，支持多实例（测试、SSR 同构多请求）→ 代价是函数写法受限、且依赖「Pinia 被挂成了组件实例的全局属性」这一注入约定。

- **最小心智模型（6 步）**：
  1. store 成品是一个被响应式代理包裹的整体对象，三类成员（状态/计算属性/动作）已被摊平挂在其上。
  2. 消费侧无法凭形状区分这三类，必须在运行时对每个字段做特征探测。
  3. 解构路径：先穿透代理拿到原始对象再遍历——「带副作用标记」的归为计算属性，「是引用或是嵌套响应式对象」的归为状态，其余（动作、插件加的非响应式字段）丢弃。
  4. 解构路径把计算属性与状态都**转发回原代理对象**重新打包成引用（计算属性新建一层转发壳，状态用属性引用），动作不进结果。
  5. 映射路径：为每个被映射的字段生成一个普通函数闭包，函数体在渲染期执行：先从组件实例拿到 Pinia，再调用工厂取 store，再读对应字段。
  6. 状态/计算属性走「计算属性位」（读字段时建立响应式依赖），动作走「方法位」（转发调用与参数），可写状态额外提供写回入口。

- **最小原理演示（替代旧"复刻范围"）**：
  - **应演示**：一个从零实现的「解构助手」（约二三十行），核心三步——穿透代理取原始对象遍历；用「值身上是否挂着副作用标记」识别计算属性并新建一层转发壳；用「是否为引用或嵌套响应式对象」识别状态并用属性引用包装；动作直接跳过。**这一段演的是权衡 1+2**：靠特征探测 + 转发，换来「解构不丢响应性、且只返回会变的成员」。再补一个极简的「映射助手」：给定键名列表，reduce 出一个「函数当取值器」的对象，函数体里 `取当前实例的Pinia → 调工厂 → 读字段`，**演的是权衡 3+4**：延迟到渲染期 + 从实例拿 Pinia。
  - **应故意省略**：类型体操（只读/可写计算属性的精细类型推导、多 store 展开类型）、后缀定制、可写映射的 set 细节、对象形式映射里自定义函数的 this 绑定分支、开发期的参数诊断、与框架 Options 接缝的具体注册细节。不追求工程完整，只追求「演透特征探测 + 转发 + 延迟求值」三条原理。
  - **演示载体建议**：**首选 TS/JS**。本章核心是「运行时特征探测分类」与「生成转发闭包」，纯 TS/JS 配合框架响应式包（ref/reactive/computed 及原始对象穿透）即可忠实演透，无需宿主组件环境——解构助手可直接对构造出的响应式对象跑；映射助手可用一个 `{ 当前Pinia }` 的 mock 上下文手动调用其取值器来演「延迟求值」，不必真起一个组件。本章无任何「TS/JS 讲不透」的语言特有语义，故不退回原仓库语言。

- **正文不宜展开的细节**：
  解构助手的精细类型推导（如何用条件类型区分只读计算属性与可写计算属性、如何对 state 引用做类型解包）；映射助手的多 store 展开类型与后缀定制（全局可改名后缀）；可写状态映射对象形式的 set 写回分支；对象形式映射中「值是函数时绑定组件实例」的 this 用法与「不能用箭头函数」的约束；数组首参误传数组的开发期诊断。这些是工程与类型完备性内容，供抽查核对，不宜进原理正文。

- **推荐的一个执行轨迹例子**：
  输入一个成品 store，其上挂着：一个数值状态 `count`、一个由 `count` 派生的计算属性 `double`、一个动作 `inc`。
  - 解构路径：穿透代理遍历 → `count` 命中「是引用」分支 → 包成跟随原对象的引用；`double` 命中「带副作用标记」分支 → 新建一个转发壳（取值时回原对象读 `double`）；`inc` 既非引用也无副作用标记 → 丢弃。输出 `{ count: 引用, double: 计算引用 }`，对其解构后改 `count`，界面仍更新。
  - 映射路径：把 `['count']` 铺进计算属性位 → 生成 `{ count: ƒ() }` → 渲染期 Vue 调该函数 → 从组件实例拿 Pinia → 调工厂取 store → 读 `store.count` 建立依赖；`inc` 走方法位，调用时转发参数。

> 以上钩子供 Writer 写「动机→核心思想→心智模型→关键权衡→原理演示」；下面事实部分供核对，不要被 Writer 当目录照抄。

## 概念要点

- **store 成品是「被代理的统一对象」**：state、计算属性、动作三类成员在组装完成后被 `assign` 摊平挂到同一个 store 上，且**同时挂到代理对象与穿透代理后的原始对象两份**——注释明确说明这是为了让解构助手能正确工作（issue #799）。源码位置: packages/pinia/src/store.ts:575-578
- **三类成员在消费侧的运行时特征**：状态 = 「是 ref（且不带副作用标记）或 reactive」；计算属性 = 「是 ref 且身上挂着 effect」；动作 = 「typeof function」。这套特征判定由 store.ts 内自定义的 `isComputed` 承担。源码位置: packages/pinia/src/store.ts:143-146, 508, 540, 557
- **解构助手靠「副作用标记」反认计算属性**：因框架当时无官方 `isComputed`，用 `value?.effect` 探测；这与 store.ts 自定义的 `isComputed`（`isRef(o) && o.effect`）**本质同一判断**，只是一个内联、一个提取为函数。代码注释引用了框架对应的 PR。源码位置: packages/pinia/src/storeToRefs.ts:95-97
- **解构助手三分支**：① 带副作用标记 → 新建一个计算属性，getter/setter 都转发回**代理对象**的同名属性（保持单一数据源）；② 是 ref 或 reactive → 用 `toRef(store, key)` 在代理对象上建属性引用；③ 其余（动作、插件加的非响应式字段）跳过。源码位置: packages/pinia/src/storeToRefs.ts:90-116
- **解构助手为什么先 `toRaw` 再遍历**：直接在响应式代理上遍历会把每个嵌套对象都判成 reactive，无法区分「原本就是 reactive 子对象」与「被代理传染」；先穿透到原始对象，特征探测才准确。配合 store.ts:578 把成员也挂到原始对象，遍历才看得到。源码位置: packages/pinia/src/storeToRefs.ts:90, packages/pinia/src/store.ts:576-578
- **映射入口的统一形态**：所有映射函数为每个键生成一个**普通 function（非箭头）**，函数体内 `useStore(this.$pinia)`——靠 `this` 拿到组件实例，再从实例的 `$pinia` 全局属性取得 Pinia。源码位置: packages/pinia/src/mapHelpers.ts:109-117, 259-290, 397-423
- **`$pinia` 的注入来源**：Pinia 作为 Vue 插件安装时，`app.provide(piniaSymbol, pinia)` 注入给组合式 inject，同时 `app.config.globalProperties.$pinia = pinia` 挂成全局属性——后者正是映射函数里 `this.$pinia` 能取到值的根因。源码位置: packages/pinia/src/createPinia.ts:28-29
- **四个映射函数的职责切分**：`mapStores`（多整店铺开成计算属性）、`mapState`（状态+计算属性铺开成计算属性 getter）、`mapActions`（动作铺开成方法，转发参数）、`mapWritableState`（仅状态，额外提供 set 写回）。前两者返回函数当 getter，第三者返回函数当方法，第四者返回 `{get,set}` 对象。源码位置: packages/pinia/src/mapHelpers.ts:101-118, 194-290, 337-423, 468-554
- **mapState 对象形式支持自定义映射函数**：当 mapper 的值是函数时，用 `.call(this, store)` 调用——既拿到 store 又能访问组件实例 `this`（注释提示此处不能用箭头函数，否则丢 this）。源码位置: packages/pinia/src/mapHelpers.ts:278-284
- **mapStores 的命名后缀可全局定制**：键名 = `$id + mapStoreSuffix`，默认后缀 `'Store'`，可由 `setMapStoreSuffix` 改（含空串）。源码位置: packages/pinia/src/mapHelpers.ts:62, 71-77, 109-117

## 关键调用链

**解构路径（Composition 风格组件里一次性调用）**：
`storeToRefs(store)` → `toRaw(store)` 穿透代理 → `for (key in rawStore)` 遍历 → 分支判定（`value.effect` / `isRef||isReactive` / 其它）→ 计算属性走「新建 computed 转发回 store」、状态走「`toRef(store,key)`」、动作丢弃 → 返回扁平引用对象。
源码位置: packages/pinia/src/storeToRefs.ts:87-116

**映射路径（Options 风格组件铺开到 computed/methods）**：
组件渲染期 Vue 调用某映射函数生成的取值器 → `this.$pinia`（来自 install 注入的全局属性）→ `useStore(pinia)` 取得 store（已建则查表返回）→ 读 `store[key]`（建立响应式依赖）→ 返回值。动作路径多一步转发 `(...args)`。
源码位置: packages/pinia/src/mapHelpers.ts:262-265, 400-406; packages/pinia/src/createPinia.ts:28-29

## 源码摘录（带行号，全文累计 ≤ 30 行）

解构助手的三分支核心（穿透代理 + 特征探测 + 转发回代理）：
```ts
// storeToRefs.ts:90-113
const rawStore = toRaw(store)
const refs = {} as StoreToRefs<SS>
for (const key in rawStore) {
  const value = rawStore[key]
  // There is no native method to check for a computed
  if (value?.effect) {
    refs[key] = computed({
      get: () => store[key],
      set(value) { store[key] = value },
    })
  } else if (isRef(value) || isReactive(value)) {
    refs[key] = toRef(store, key)
  }
}
```

store.ts 自定义的计算属性判定（与上面 `value?.effect` 同源）：
```ts
// store.ts:143-146
function isComputed<T>(value: ComputedRef<T> | unknown): value is ComputedRef<T>
function isComputed(o: any): o is ComputedRef {
  return !!(isRef(o) && (o as any).effect)
}
```

store.ts 双 assign（代理对象 + 原始对象都挂，专为解构助手）：
```ts
// store.ts:575-578
assign(store, setupStore)
// allows retrieving reactive objects with `storeToRefs()`. Must be called after assigning to the reactive object.
// Make `storeToRefs()` work with `reactive()` #799
assign(toRaw(store), setupStore)
```

`$pinia` 注入（映射函数能取到 Pinia 的根因）：
```ts
// createPinia.ts:28-29
app.provide(piniaSymbol, pinia)
app.config.globalProperties.$pinia = pinia
```

映射函数的统一形态（数组形式 mapState：生成闭包取值器）：
```ts
// mapHelpers.ts:261-266
reduced[key] = function (this: ComponentPublicInstance) {
  // @ts-expect-error: FIXME: should work?
  return useStore(this.$pinia)[key]
} as () => any
```

## 易混淆 / 边界 / 推断

- **事实**：解构助手对「带副作用标记」的成员（计算属性/getter）**新建一层 computed 转发壳**，而非直接返回 store 上原有的那个 computed 引用。
- **推断（标注为推断）**：之所以新建壳而非复用原 computed，推断是为了让 getter/setter 都统一从代理对象 `store[key]` 读写，保持单一数据源、并把可写计算属性的写回也接管进来；类型层用 `_IsReadonly` 区分只读与可写两种计算属性以对应不同导出类型。
- **事实**：`mapWritableState` 只允许映射 state（不允许 getter），因为 getter 是只读计算属性，无法写回；其返回 `{get, set}` 对象，set 时 `useStore(this.$pinia)[key] = value`。源码位置: packages/pinia/src/mapHelpers.ts:468-554
- **事实**：`mapStores` 在开发期会检测「首参误传成数组」并触发诊断告警（PINIA_R1001），然后按数组继续处理——属容错，与核心原理无关。源码位置: packages/pinia/src/mapHelpers.ts:104-107
- **事实**：解构助手与映射入口对 store 的定义风格都不挑——它们消费的是组装完成的成品 store，与该 store 是 Options 还是 Setup 风格定义无关。
- **事实**：映射入口里 `useStore(this.$pinia)` 每次访问都重新调用工厂；工厂内部对已创建的 store 走注册表查表直接返回，不会重复装配，故开销恒定。
- **推断（标注为推断）**：解构助手与 store.ts 的 `isComputed` 没有共用同一个函数（一个内联 `value?.effect`、一个提取为本地 `isComputed`），推断为历史遗留——解构助手代码注释与引用的框架 PR 表明其写于该判定尚未被提取复用的时期，后续未统一重构。
- **未理解**：无实质性未理解点；mapHelpers 的大量映射类型（`_Spread`/`_MapStateReturn`/`_MapWritableStateObjectReturn` 等）纯粹服务 Options API 的类型推导，与运行时原理无关，已归入「正文不宜展开」。
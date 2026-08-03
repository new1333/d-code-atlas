# mapHelpers：Options API 兼容垫片 · 源码精读

## 给 Writer 的教学钩子（必填，8 子项缺一不可）

- **用户痛点 / 场景**：Pinia 的官方接入路径是 setup() 里调 useStore —— 一个 composable。但很多项目（尤其中大型 Vue 2 升级项目、用 Element/Ant 等 UI 库的项目）还在 Options API 风格（`computed: {}`、`methods: {}`）下写组件，没法在选项字段里调 composable。如果硬要写，用户得自己手搓一堆 `count() { return useStore().count }` 的样板，且要保证 this 与生命周期不出错。mapHelpers 就是这套「把 composable 翻译成 Options API 字段」的预制样板工厂。

- **一句话核心思想**：把每个被映射的字段，都包成一个「等组件渲染时、再借由当前实例拿 store」的小函数 —— 借力 Vue 已有的 this 绑定，而不是另起一套缓存。

- **设计动机（为什么需要它）**：Pinia 的核心 API 是 composition 风格，但 Vue 生态大量 Options API 用户需要一个零摩擦的适配层。直接的想法是「在调用 mapHelper 时就把 store 取出来塞到字段上」—— 但 store 的获取需要 pinia 实例，而 mapHelper 是在组件定义时（而非实例化时）被调用的，那时还没有 pinia。所以必须把取 store 的动作延后到「组件实例已存在」的时刻。Vue 的 Options API 恰好有个性质：computed/methods 中定义的函数被调用时，this 一定绑定到组件实例。把这两个事实拼起来，就有了「函数体里 this.$pinia → useStore」这一招。

- **关键权衡（4 条）**：
  - 「每个 key 都包成一个延迟函数，函数体内才调 composable」→ 换来了完全契合 Options API（Vue 自动给 computed/methods 绑定 this 为组件实例，实例上一定有注入的 pinia）→ 代价是 TS 类型只能用 reduce 拼装近似推导（无法静态映射返回类型），且与 setup() 不同 —— setup 里 ref 会自动解包，这里不会。
  - 「每次访问都重新走 useStore(this.$pinia) 而不在 mapHelpers 内做缓存」→ 换来了零额外缓存状态、store 注册表是唯一真源（HMR、disposePinia、测试 reset 之后下次访问自动得到最新 store）→ 代价是每次 computed 求值多一次注册表查询（命中缓存为 O(1)，但仍有函数调用与 this 解析开销）。
  - 「array 与 object 两种入参签名共享同一份 reduce 实现并支持函数式 mapper」→ 换来了 API 简洁：用户既能用数组保留原名，又能用对象重命名或传 `(store) => any` 自定义 getter（甚至借 this 读组件状态）→ 代价是函数体必须 `Array.isArray` 二分、TS 需要写 3 个 overload 签名，错误位置不够直观。
  - 「mapWritableState 返回 `{get, set}` 对象而非函数，且只允许 state 不允许 getter」→ 换来了支持 `v-model` 等场景的双向绑定（computed 字段接受 `{get,set}` 形态）→ 代价是与 mapState 的函数形态分裂、用户要记哪种场景用哪个；同时 set 直接写 store 字段绕过 $patch，无法被订阅/$patch 拦截到（这正是和直接修改 state 一致的行为）。

- **最小心智模型（5 步）**：
  1. 组件在定义时调用 `mapState(useCounterStore, ['count'])`，立即 reduce 出一个对象 `{ count: function() { ... } }`，函数体此刻不被执行。
  2. 这个对象被 spread 进组件的 `computed` 字段。
  3. Vue 实例化组件并触发首次渲染时，逐个调用 computed 函数，此时 `this` 一定是组件实例。
  4. 函数体内 `this.$pinia` 拿到注入的 pinia 实例（来自 `app.use(pinia)` 时挂的全局属性）。
  5. `useStore(pinia)` 走注册表查找 —— 命中缓存则直接返回，未命中则触发 store 构建；最后从 store 上取字段，state 经 reactive proxy 自动解包，getter 直接是计算后的值。

- **最小原理演示**：
  - 应演示：一个 ~25 行的从零实现，演透「延迟求值 + 委托注册表缓存」这条核心权衡。把 defineStore（伪造一个返回 useStore 的工厂）、mapState（数组版 reduce）、mapWritableState（{get,set} 版）各写一遍，再用一段 mock 把 computed 函数绑定到一个伪造的组件 this 上跑通。
  - 应故意省略：array/object 双签名（演示里只保留数组版足够）、mapStores 的后缀拼接、setMapStoreSuffix 全局可变状态、TS 类型推导（演示里用 plain JS）、__DEV__ 下误用数组的告警、mapActions（机制同 mapState，不值得占篇幅）。
  - **演示载体建议**：写成 `bun run`/`node` 可直接跑的 TypeScript/JS 脚本。mapHelpers 没有真正的 Vue 运行时依赖 —— 核心机制是「函数延迟求值 + 借用缓存」，可用 mock 的 fake component（普通对象，手动把 computed 函数 `.call(mockThis)`）演透原理，能跑通即可，不需要 Vue 或打包器。这是本章机制类型（纯 JS 数据流 + 调用时机）决定的：载体服务于演透原理，不是服务于跑在真 Vue 里。

- **正文不宜展开的细节**：
  - `_Spread<A>`、`_MapStateReturn`、`_MapWritableStateKeys` 等 internal mapped types 的模板字面量魔法（提一句「靠 reduce + mapped type 拼出近似类型」即可，不要逐字解释）。
  - `mapStoreSuffix` + `setMapStoreSuffix` 的全局 mutable 状态（一句话提一下「全局可变、需谨慎」）。
  - `mapGetters = mapState` 别名（已 deprecated，一句话过）。
  - `__DEV__` 下检测误传数组的告警（提一句「防呆」即可）。
  - 大量 `@ts-expect-error` 注释的存在（说明 TS 推导跟不上设计，不要逐个解释）。

- **推荐的一个执行轨迹例子**：
  - 输入：组件里写 `computed: { ...mapState(useCounterStore, ['count']) }`。
  - 关键中间态：mapState 立即返回 `{ count: function() { return useStore(this.$pinia).count } }`；Vue 把它合并到组件 computed。
  - 渲染时：Vue 调用 `computed.count.call(componentInstance)` → `this.$pinia` 解析为应用注入的 pinia → `useStore(pinia)` 查注册表（首次未命中 → 走 createSetupStore 并把半成品塞进 _s；之后命中直接返回）→ 拿到 reactive store → `store.count` 经 proxy 解包返回数值（假设是 42）。
  - 输出：组件中 `this.count === 42`。

> 以上钩子供 Writer 写「动机 → 核心思想 → 心智模型 → 关键权衡 → 原理演示」；下面事实部分供核对，不要被 Writer 当目录照抄。

## 概念要点

- **mapStoreSuffix 是一个模块级 mutable 变量**，默认 `'Store'`，可被 `setMapStoreSuffix` 改写（甚至空串）；mapStores 拼属性名时实时读取。源码位置: packages/pinia/src/mapHelpers.ts:62,71-77
- **mapStores 的 reduce 工厂模式**：对每个 useStore 函数，把 `${useStore.$id}${mapStoreSuffix}` 作为 key、一个返回 store 实例的 getter 函数作为 value，攒成一个对象 spread 进组件 computed。源码位置: packages/pinia/src/mapHelpers.ts:109-117
- **mapStores 在 dev 下检测误传数组**：`Array.isArray(stores[0])` 命中则调 PINIA_R1001 提示并降级处理（生产模式下数组会被当成单个 store 直接拼错名）。源码位置: packages/pinia/src/mapHelpers.ts:104-107；告警文案见 源码位置: packages/pinia/src/diagnostics.ts:11-15
- **mapState 有 3 个 TS 重载**：数组形式（保留原名）、对象形式（重命名 / 函数式 mapper）、统一实现签名。最终实现用 `Array.isArray(keysOrMapper)` 分支。源码位置: packages/pinia/src/mapHelpers.ts:194-206,231-240,250-290
- **mapState 数组形式只读、对象形式支持自定义函数**：数组版 `reduced[key] = function() { return useStore(this.$pinia)[key] }`，纯 getter；对象版额外允许 `storeKey` 是 `(store) => any`，并通过 `.call(this, store)` 让用户函数也能拿到组件实例。源码位置: packages/pinia/src/mapHelpers.ts:259-289
- **mapGetters 是 mapState 的别名**（已废弃，保留向后兼容）。源码位置: packages/pinia/src/mapHelpers.ts:296
- **mapActions 的结构与 mapState 同构**，差别在于「methods 字段要求函数」、且要把调用参数透传：`function(...args) { return useStore(this.$pinia)[key](...args) }`。源码位置: packages/pinia/src/mapHelpers.ts:387-423
- **mapWritableState 与 mapState 形态分裂**：返回 `{ get, set }` 对象而非函数，以便对接 v-model 等场景；set 直接 `useStore(this.$pinia)[key] = value` 写入 store 字段（等价于直接 mutation，绕过 $patch）。源码位置: packages/pinia/src/mapHelpers.ts:504-553
- **mapWritableState 的 key 类型被限制为 state（UnwrapRef<S>）**，不允许 getter —— 因为 getter 通常是 computed，写它会破坏计算语义。源码位置: packages/pinia/src/mapHelpers.ts:428-444
- **TS 类型大量 `@ts-expect-error`**：mapped types 跟不上 reduce 的运行时构造，开发团队选择「运行时正确、类型近似」的折中。源码位置: packages/pinia/src/mapHelpers.ts:110,263,272,283,399,404,411,416
- **`this.$pinia` 是 Vue 全局扩展注入的属性**，由 globalExtensions 声明到 ComponentPublicInstance 类型上，运行时由 `app.use(pinia)` 时挂载。源码位置: packages/pinia/src/globalExtensions.ts:9-13
- **useStore 接受可选 pinia 参数**：内部 `pinia || activePinia || inject(piniaSymbol)` 三级回退；mapHelpers 走的是「显式传 pinia」路径，避免依赖 inject context（Options API 的 computed 字段在 Vue 内部并不是 setup 上下文）。源码位置: packages/pinia/src/store.ts:883-888

## 关键调用链

组件渲染 → Vue 调用 `computed[key](this)` → 函数体内 `this.$pinia` 拿到注入的 pinia 实例 → `useStore(this.$pinia)` 查 `pinia._s` 注册表（首次未命中走 createSetupStore 并 set 进 _s）→ 返回 reactive store 实例 → `store[key]` 经 reactive proxy 自动解包（state 解包 ref，getter 取 computed.value）→ 返回最终值给组件。

源码位置: packages/pinia/src/mapHelpers.ts:261-267（函数体）+ packages/pinia/src/store.ts:883-888（useStore 入参）+ packages/pinia/src/globalExtensions.ts:9-13（this.$pinia 来源）

## 源码摘录（带行号，全文累计 ≤ 30 行）

`mapStores` 的 reduce 工厂 —— 拼属性名 + 生成延迟函数：

```ts
// packages/pinia/src/mapHelpers.ts:109-117
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

`mapState` 数组形式的 reduce —— 最小可读核心：

```ts
// packages/pinia/src/mapHelpers.ts:259-269
return Array.isArray(keysOrMapper)
  ? keysOrMapper.reduce(
      (reduced, key) => {
        reduced[key] = function (this: ComponentPublicInstance) {
          // @ts-expect-error: FIXME: should work?
          return useStore(this.$pinia)[key]
        } as () => any
        return reduced
      },
      {} as _MapStateReturn<S, G>
    )
```

`mapWritableState` 的 set 分支 —— 与 mapState 的关键区别（写而非读）：

```ts
// packages/pinia/src/mapHelpers.ts:525-530
set(
  this: ComponentPublicInstance,
  value: Store<Id, S, G, A>[typeof key]
) {
  return (useStore(this.$pinia)[key] = value)
},
```

## 易混淆 / 边界 / 推断

- **事实**：mapHelpers 不持有任何缓存，每次 getter 调用都会走一遍 useStore；store 实例缓存完全由 `pinia._s` 负责。源码位置: packages/pinia/src/mapHelpers.ts:114,264,274,405,417,523,529,540,547
- **事实**：mapState 的对象形式允许 mapper 函数使用 `this`（用 `function` 而非箭头函数时）；JSDoc 明确警告「arrow function won't have this」。源码位置: packages/pinia/src/mapHelpers.ts:175-180,278-282
- **事实**：mapWritableState 的 setter 直接赋值 store 字段，不会触发 $patch 路径 —— 因此 $subscribe 监听器仍会收到 mutation 事件，但 patch 专用的临时静默逻辑不会介入（与直接 `store.x = y` 行为一致）。源码位置: packages/pinia/src/mapHelpers.ts:529,547
- **推断（标注为推断）**：把 `mapState` 与 `mapWritableState` 设计成两套 API 而非合一，是为了让 read-only 路径保持「函数即值」的简单形态（Vue computed 字段接受函数时直接当 getter），写路径才退化为 `{get,set}`。这一不对称换取了 90% 常见场景（只读访问）的最简心智。源码依据: 源码位置: packages/pinia/src/mapHelpers.ts:259-269 vs 518-535
- **推断（标注为推断）**：mapHelpers 不调 `getCurrentInstance` 而坚持用 `this.$pinia`，是为了让函数能在「非 setup 上下文」（如 Options API 的 computed 字段被 Vue 内部调度时）安全工作 —— 那时 active instance 可能已切换。`this.$pinia` 总是稳定的，因为 Vue 渲染时 this 一定是组件实例。源码位置: packages/pinia/src/mapHelpers.ts:111-115,262-264
- **未理解**：`setMapStoreSuffix` 的全局可变状态在多个 pinia 实例并存时（如 micro-frontend）是否会互相污染；代码无任何隔离机制（mapStoreSuffix 是模块顶级 `let`），推测依赖「应用启动时一次性设置」的约定，但无强制约束。源码位置: packages/pinia/src/mapHelpers.ts:62
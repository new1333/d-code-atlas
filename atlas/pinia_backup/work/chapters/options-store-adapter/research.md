# Options Store 适配：声明式选项翻译成 setup · 源码精读

## 给 Writer 的教学钩子（必填，8 子项缺一不可）

- **用户痛点 / 场景**：从 Vuex 迁移过来的人天然习惯 `{ state, getters, actions }` 三段式声明，而不是写一个返回 refs/functions 的 setup 函数；同时项目里两套语法共存（option 写法做配置型 store、setup 写法做需要组合式 API 的 store）很常见。如果没有适配层，要么强制所有人改用 setup 写法，要么维护两套完全独立的构建管线。
- **一句话核心思想**：**声明式选项并不自己造一套构建链，而是被「编译」成一个 setup 函数，再交给 setup store 构建器统一处理。** Option store 本质是 setup store 的一种语法糖。
- **设计动机（为什么需要它）**：以最小代码量同时支持两种语法、并保证两者产出的 store 行为一致（同样的 `$patch`、`$onAction`、`$subscribe`、plugin 注入、HMR）；同时利用 option 写法天然有 `state()` 工厂这一特性，让 option store 的状态从一开始就落在集中化的 `pinia.state.value[id]`，免去 setup store 必须事后「搬运 ref」的步骤。
- **关键权衡（直接供 Writer 复述）**：
  1. **两条语法共享同一条 setup 构建路径** → 换来了行为统一、代码量减半、bug 修复只改一处 → 代价是构建器内部散落多个 `isOptionsStore` 条件分支（state 是否搬运、`$reset` 是否可用、HMR 时 getter 是否重包 computed、`hydrate` 钩子是否调用），构建器不再「单一职责」。
  2. **option store 的 getter 不用 `this`，而是 `pinia._s.get(id)` 延迟取 store** → 换来了 getter 在 store 尚未构建完成时就能被定义、不会形成「定义时引用半成品 store」的循环 → 代价是每次 getter 求值都要付一次 `Map.get(id)` 查找，且阅读源码时这条「`this` 不指向 store」的隐式约定需要解释。
  3. **option store 的 `state()` 工厂在 setup 内被直接写入 `pinia.state.value[id]`** → 换来了状态集中化「一开始就完成」、`$reset` 只需重跑 `state()` 即可重建 → 代价是 setup store 必须在 setup 返回后把 ref 逐个搬运到同一个位置（构建器因此多出一段分支逻辑）。
  4. **`$reset` 只对 option store 实现、setup store 在 dev 下直接抛错** → 换来了「没有可重建初始状态的 store 不假装支持 reset」的诚实语义 → 代价是 setup store 用户必须自行实现 `$reset` 或转用 `$patch` 重置。
- **最小心智模型（3～7 步）**：
  1. 用户调 `defineStore(id, { state, getters, actions })`（option 写法）。
  2. `defineStore` 检测到第二个参数不是函数 → 标记为 option store、`useStore` 内首次调用走 option 分支。
  3. `createOptionsStore` 不直接构建 store，而是**先合成一个 setup 函数**：
     a. `state()` 调用结果写入 `pinia.state.value[id]`，再用 `toRefs` 拆成可解构的 ref；
     b. 每个 getter 包成 `markRaw(computed(...))`，computed 内部用 `pinia._s.get(id)` 拿到「刚刚注册的半成品 store」作为 `this` 与首参；
     c. actions 原样保留。
  4. 合成的 setup 交给 `createSetupStore(..., isOptionsStore=true)`，复用整条构建链。
  5. 构建器看到 `isOptionsStore=true`，**跳过 setup store 特有的 ref 搬运步骤**（state 已经在正确位置）、并安装可用的 `$reset`。
  6. 最终产出与 setup store 同构的 reactive store。
- **最小原理演示（替代旧「复刻范围」）**：
  - **应演示**：一个仅 ~40 行的 TS 脚本，演透「option → setup 翻译」这一核心思想。建议结构：
    1. 一个极简 `pinia = { state: { value: {} }, _s: new Map(), _e: effectScope() }`；
    2. 一个共享 `buildStore(id, setup, isOptions)`，它跑 setup、把返回值装进 reactive、塞进 `_s`；
    3. 一个 `defineOptionStore(id, { state, getters, actions })`，内部合成 setup：`state()` 写到 `state.value[id]`、`toRefs` 出来、getter 包 `computed(() => getter(_s.get(id), _s.get(id)))`、actions 原样；
    4. `useStore()` 走 `_s.get(id)` 缓存命中或构建。
    这段每一行都对应上面某条权衡——`state.value[id]` 对应权衡 3，`_s.get(id)` 对应权衡 2，`buildStore` 复用对应权衡 1。
  - **应故意省略**：完整 TS 泛型家族、`markRaw`、plugin/HMR/devtools/diagnostics、`$patch` 的深度合并、effectScope 持有、SSR hydration。
  - **演示载体建议（Writer 据此执行）**：本仓库主语言是 TS，**建议写成可 `bun run`/`tsx`/`node` 直接跑的脚本**（能跑最好，非硬要求）。要点：`computed`/`reactive`/`ref`/`toRefs` 可以直接从 `vue` 借，但为减少依赖也可手写最简化的 `reactive`/`computed`/`ref` 骨架——只要能演示「getter 通过 `_s.get(id)` 拿到 store」即可。**不建议**写成需要 Vite/Vue 组件宿主的形式，因为本章机制是纯数据层，与组件树无关。
- **正文不宜展开的细节**：
  - `DefineStoreOptions`/`DefineStoreOptionsInPlugin`/`_GettersTree`/`_ActionsTree` 这一长串 TS 类型家族（仅供类型推导，与原理无关）。
  - `PINIA_R1002`（getter 与 state 同名警告）、`PINIA_R1003` 等诊断细节。
  - `__DEV__ && hot` 分支用 `ref(state ? state() : {}).value` 重建 localState（HMR 专用的状态镜像，供 `_hotUpdate` 对比）。
  - `options.hydrate` 钩子（仅 option store + initialState 时调用的 SSR 自定义 hydration 入口）。
  - `_hmrPayload.getters[key]` 在 option store 下存原始 `options.getters[key]`（而非 computed 实例），是为了热更时能重新包一层 computed。
- **推荐的一个执行轨迹例子**：
  - **输入**：`defineStore('counter', { state: () => ({ count: 0 }), getters: { double: (s) => s.count * 2 }, actions: { inc() { this.count++ } } })`，然后 `useCounter().inc()`。
  - **关键中间态**：
    1. `pinia.state.value['counter'] = { count: 0 }`（在合成 setup 内执行）；
    2. setup 返回 `{ count: ref, double: computed, inc: fn }`；
    3. `_s.set('counter', reactiveStore)`（构建器内，先注册后填充）；
    4. `inc()` 执行时被构建器内 `action()` 包装，触发 `$onAction` 钩子。
  - **输出**：`store.count === 0`、`store.double === 0`；调 `inc()` 后 `store.count === 1`、`store.double === 2`；调 `store.$reset()` 后 `store.count === 0`。

> 以上钩子供 Writer 写「动机→核心思想→心智模型→关键权衡→原理演示」；下面事实部分供核对，不要被 Writer 当目录照抄。

## 概念要点

- **`createOptionsStore` 不构建 store，只合成 setup**：函数体里没有任何 reactive/effectScope 调用，唯一目的是产出 setup 函数并交给 `createSetupStore`。源码位置: packages/pinia/src/store.ts:149-212
- **state 的归宿是 `pinia.state.value[id]`**：合成 setup 的第一步就是 `pinia.state.value[id] = state ? state() : {}`，再 `toRefs` 出 localState。这与 setup store（在构建器里事后搬运 ref）形成鲜明对比。源码位置: packages/pinia/src/store.ts:167-177
- **getter 用 `pinia._s.get(id)!` 取 store 而非 `this`**：computed 内部 `setActivePinia(pinia)` 后再从注册表拿刚注册的 store，把 store 作为 `this` 和首参调用原始 getter。这是为绕开「store 还在构建中、`this` 无所指」的循环依赖。源码位置: packages/pinia/src/store.ts:188-200
- **`markRaw(computed(...))` 防止被外层 `reactive()` 二次代理**：store 自身是 `reactive(partialStore)`，computed 实例若不 markRaw，会被 reactive 包一层代理，破坏 `ComputedRef` 的 lazy/缓存语义。源码位置: packages/pinia/src/store.ts:188-201
- **HMR 期间不复用 `pinia.state.value[id]`**：`__DEV__ && hot` 分支改用 `toRefs(ref(state ? state() : {}).value)`，目的是产生一个临时镜像，让 `_hotUpdate` 能对比新旧 state、保留用户已修改的值。源码位置: packages/pinia/src/store.ts:173-176
- **`$reset` 仅对 option store 启用**：构建器内 `const $reset = isOptionsStore ? function() {...} : __DEV__ ? throwErr : noop`。option store 走 `$patch` 把 `state()` 重跑后覆盖回 `$state`，setup store 在 dev 下直接抛 `🍍: Store "${$id}" is built using the setup syntax...`。源码位置: packages/pinia/src/store.ts:330-347
- **构建器内对 `isOptionsStore` 的分支**：(a) 跳过 `{}` 占位 state 写入（option store 已在 setup 内写过真实 state）；(b) 跳过 setup store 特有的 ref 搬运到 `pinia.state.value[$id][key]`；(c) HMR `_hmrPayload.getters[key]` 对 option store 存 `options.getters[key]` 而非 computed 实例。源码位置: packages/pinia/src/store.ts:275、514-533、558-561
- **`_hotUpdate` 中 option store 的 getter 必须重新包 computed**：因为热更拿到的是原始 getter 函数，需要再次走「computed + `_s.get(id)`」的包装流程；setup store 的 getter 本来就是 computed，直接转移即可。源码位置: packages/pinia/src/store.ts:657-671
- **option store 专属的 `hydrate` 钩子**：构建器末尾 `if (initialState && isOptionsStore && options.hydrate)` 才调用，允许 option store 自定义 SSR hydration 行为；setup store 没有这个钩子（用 `skipHydrate` Symbol 替代）。源码位置: packages/pinia/src/store.ts:766-776
- **`defineStore` 的分发逻辑**：`isSetupStore = typeof setup === 'function'`；非 setup 即 option，`useStore` 内首次构建时分别走 `createSetupStore` 或 `createOptionsStore`。源码位置: packages/pinia/src/store.ts:879-908
- **`createOptionsStore` 与 `defineStore` 三种重载的对应**：第二个参数为对象时是 option 写法（第三种重载），传给 `createOptionsStore` 的 `options` 就是用户原样选项。源码位置: packages/pinia/src/store.ts:859-881

## 关键调用链

```
defineStore(id, { state, getters, actions })    // option 写法，typeof setup !== 'function'
  → useStore(pinia?)                              // 首次调用，未命中 _s 缓存
    → createOptionsStore(id, options, pinia)      // 不构建，只合成 setup
      → setup() 合成（内部：state()→pinia.state.value[id]→toRefs；getter→markRaw(computed)；actions 原样）
      → createSetupStore(id, setup, options, pinia, hot, isOptionsStore=true)   // 复用构建链
        → pinia._e.run(() => effectScope().run(() => setup({action})))          // 跑合成的 setup
        → 分类 setupStore 返回值（isRef&&!isComputed → state；function → action；isComputed → getter）
        → assign(store, setupStore)；assign(toRaw(store), setupStore)
        → 安装 $reset（因 isOptionsStore=true）
        → 跳过 setup store 的 ref 搬运（因 isOptionsStore=true）
    → pinia._s.set(id, store)                     // 先注册半成品（在 setup 跑之前）
  → 返回 store
```

源码位置: packages/pinia/src/store.ts:149-212（合成 setup）、214-228（构建器签名）、902-908（分发）

## 源码摘录（带行号，全文累计 ≤ 30 行）

合成 setup 的核心（createOptionsStore 内部）：

```ts
// packages/pinia/src/store.ts:166-207（节选关键 14 行）
function setup() {
  if (!initialState && (!__DEV__ || !hot)) {
    pinia.state.value[id] = state ? state() : {}        // ← state 集中化的关键
  }
  const localState = __DEV__ && hot
    ? toRefs(ref(state ? state() : {}).value)
    : toRefs(pinia.state.value[id])
  return assign(
    localState,
    actions,                                            // ← actions 原样保留
    Object.keys(getters || {}).reduce((cg, name) => {
      if (__DEV__ && name in localState) diagnostics.PINIA_R1002({ name, id })
      cg[name] = markRaw(computed(() => {                // ← markRaw 防 reactive 二次代理
        setActivePinia(pinia)
        const store = pinia._s.get(id)!                  // ← 延迟取 store，绕开 this 循环
        return getters![name].call(store, store)
      }))
      return cg
    }, {} as Record<string, ComputedRef>)
  )
}
store = createSetupStore(id, setup, options, pinia, hot, true)  // ← 复用构建链，标记 isOptionsStore
```

`$reset` 的分支（构建器内）：

```ts
// packages/pinia/src/store.ts:330-347（节选 6 行）
const $reset = isOptionsStore
  ? function $reset(this: _StoreWithState<...>) {
      const { state } = options as DefineStoreOptions<...>
      const newState = state ? state() : {}
      this.$patch(($state) => { assign($state, newState) })   // ← 用 $patch 把重置聚合成一次通知
    }
  : __DEV__ ? () => { throw new Error(`🍍: Store "${$id}" is built using the setup syntax...`) }
    : noop
```

构建器内对 option store 的 state 搬运跳过：

```ts
// packages/pinia/src/store.ts:514-533（节选 4 行）
} else if (!isOptionsStore) {
  // setup store 才需要把 ref 搬到 pinia.state.value[$id][key]
  // option store 的 state 已在合成 setup 内直接落到此处
  pinia.state.value[$id][key] = prop
}
```

`defineStore` 的分发：

```ts
// packages/pinia/src/store.ts:879、902-908（节选 5 行）
const isSetupStore = typeof setup === 'function'
...
if (!pinia._s.has(id)) {
  if (isSetupStore) createSetupStore(id, setup, options, pinia)
  else createOptionsStore(id, options as any, pinia)
}
```

## 易混淆 / 边界 / 推断

- **事实**：`createOptionsStore` 的 `initialState` 取的是 `pinia.state.value[id]`（函数顶部 `const initialState = pinia.state.value[id]`），用于 SSR/热更时判定是否已有现存 state，决定是否调 `state()`。源码位置: packages/pinia/src/store.ts:162
- **事实**：option store 的 getter 在合成 setup 内被一次性创建；若 getter 名与 state 名冲突，dev 下抛 `PINIA_R1002`。源码位置: packages/pinia/src/store.ts:184-186
- **推断（标注为推断）**：getter 内部 `setActivePinia(pinia)` 的存在，是因为 getter 求值可能发生在组件 setup 之外（例如别的 store 的 getter 里、devtools 里、`computed` 触发的 watcher 里），需要保证 `activePinia` 正确指向当前 pinia，否则 getter 内若调用了别的 `useStore()` 会拿到错的 pinia 实例。源码注释 `// allow cross using stores` 也支持这一推断。源码位置: packages/pinia/src/store.ts:190、194
- **推断（标注为推断）**：option store 没有「setup store 的 ref 搬运」步骤，是因为 option store 的 state 在合成 setup 内通过 `toRefs(pinia.state.value[id])` 已经直接绑定到集中 state 的引用上——`toRefs` 产出的 ref 与 `pinia.state.value[id][key]` 是同一份响应式数据的视图，无需搬运。
- **易混淆点**：`createOptionsStore` 的 `hot` 参数与 `createSetupStore` 的 `hot` 是同一个值（透传）；但合成 setup 内 `__DEV__ && hot` 分支产生的 localState 与正常分支不同——正常分支是 `toRefs(pinia.state.value[id])`，热更分支是 `toRefs(ref(state()).value)`，**热更分支故意不读 `pinia.state.value[id]`**，这样 HMR 才能对比新旧 state 而不污染现行状态。
- **边界**：`$reset` 用 `$patch`（而非直接赋值）是为了「把重置聚合成一次 subscription 通知」，与 `$patch` 的设计契约保持一致——任何状态变更都应该走一次统一的 subscription 路径。源码位置: packages/pinia/src/store.ts:330-339
- **未理解**：`createSetupStore` 第 558-561 行 `_hmrPayload.getters[key] = isOptionsStore ? options.getters[key] : prop`——为何 option store 要存「原始 getter 函数」而非 computed 实例？目前最合理的解释是「热更时需要重新包一层 computed（见 659-665 行）」，但这意味着 `_hmrPayload.getters` 里存的是「原料」而非「成品」，与 `actions` 字段（也存原始函数）的语义一致；这个推断尚未在注释中明确确认。
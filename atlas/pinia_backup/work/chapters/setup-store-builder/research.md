# Setup Store 构建器：分类 setup 返回值为 state/getter/action · 源码精读

## 给 Writer 的教学钩子（必填，8 子项缺一不可）

- **用户痛点 / 场景**：
  用户用「setup 风格」定义 store 时，把 state、getter、action 全揉在一个函数的返回对象里——没有任何声明式的 `state/getters/actions` 字段。Pinia 怎么知道哪个 `ref` 是状态、哪个 `computed` 是 getter、哪个函数是 action？更要命的是：用户常在两个 store 里互相 `useOtherStore()`，构建期间一不留神就死循环。

- **一句话核心思想**：
  运行时按"值的长相"三分式分流（普通 ref → state、带 effect 的 ref → getter、function → action），并且**先把半成品 store 注册进表里、再去跑 setup**，让循环引用天然安全。

- **设计动机（为什么需要它）**：
  Setup 风格想跟 Vue Composition API 的肌肉记忆完全一致——用户在函数体里随手 `ref() / computed() / function` 然后 return，框架自己想办法分类。这意味着分类只能靠**运行时探测**（看 ref 上有没有 `effect` 字段、看 `typeof` 是否 `'function'`），不能用静态类型。同时 setup store 之间互相引用是高频用法，构建器必须保证「A 在建时引用 B、B 在建时引用 A」不会无限递归。

- **关键权衡（核心原料）**：
  1. **先 `_s.set(id, 半成品 store)` 再跑 setup** → 换来 store 之间互相 `useStore` 不会死循环（递归到对方时命中缓存立即返回）→ 代价是 setup 内部若拿到 self store，它是个**还不完整**的对象（getter/action 未挂），任何想立即读 self 的代码都得延迟到首次求值（getter 用 computed 天然满足）。
  2. **三分式运行时分流（`isRef && !isComputed` / `typeof === 'function'` / `isComputed`）** → 换来用户零标注、写法与 Composition API 完全一致 → 代价是类型层只能靠 TS 条件类型反推（`_ExtractStateFromSetupStore` 等），偶尔有边角类型推断不准。
  3. **`assign(store, setupStore)` 之后再来一次 `assign(toRaw(store), setupStore)`** → 换来 `storeToRefs` 能在 raw 层取到原始 ref/computed（避免 reactive 代理层把 ref 二次包装）→ 代价是每个属性多写一次、且必须按"先 reactive 后 raw"的顺序。
  4. **`$state` 用 `Object.defineProperty` 做 get/set 代理到 `pinia.state.value[$id]`** → 换来 `$state` 不被 reactive 包装（避免被 effect 误跟踪），且 set 时统一走 `$patch` 形成单次订阅通知 → 代价是 `$state` 不可枚举、HMR 路径必须特判。
  5. **setup() 嵌套跑在 `pinia._e.run(() => (scope = effectScope()).run(...))` 里** → 换来 `$dispose` 时一次 `scope.stop()` 把该 store 创建的所有 watch / computed / 订阅全清掉 → 代价是 setup 内创建的 effect 必须落在那条 scope，跨 scope 创建的清理责任就在调用方。

- **最小心智模型（3～7 步）**：
  1. 用户调 `useStore()`，`pinia._s` 未命中 → 进 `createSetupStore`。
  2. 拼一个 `partialStore`（含 `$id / $patch / $subscribe / $onAction / $dispose / $reset(抛错)`），用 `reactive()` 包成 `store`。
  3. **立刻** `_s.set($id, store)` 占座——此刻 store 还没 state/getter/action，是个壳。
  4. 在全局 scope 下 `new effectScope()`，再在该 scope 里跑 `setup({ action })`，拿到返回对象 `setupStore`。
  5. 遍历 `setupStore` 每个 key：普通 ref（或 reactive 对象）→ state，搬到 `pinia.state.value[$id][key]`；function → 用 `action()` 包一层（拦截 + $onAction 通知）后写回；带 effect 的 ref（computed）→ 留作 getter（dev 下额外登记给 devtools）。
  6. `assign(store, setupStore)` + `assign(toRaw(store), setupStore)`：让 reactive 视图与 raw 视图都看到这些字段。
  7. `Object.defineProperty(store, '$state', …)` 代理到 `pinia.state.value[$id]`，跑插件、恢复监听、return store。

- **最小原理演示（替代旧"复刻范围"）**：
  - **应演示**：一个**几十行的 mock createSetupStore**，演透两件事——(a) 「先占座再 setup」让 setup 内 `useOtherStore()` 命中缓存不死循环；(b) 三分式分流让同一个返回对象自然落到 state / getter / action 三槽。每一段对应上面某条权衡，不要写功能完整的 store。
  - **应故意省略**：`$patch` 真实合并逻辑、`$onAction` 的 before/after/onError 包装细节、插件系统、HMR `_hotUpdate`、devtools 钩子、SSR hydration、完整 TS 泛型（保留最简类型即可）。
  - **演示载体建议**：本仓库主语言是 TS，建议写成一段能 `bun run`/`tsx run` 直接跑的脚本：`import { ref, computed, reactive, effectScope, toRaw } from 'vue'`，自造一个 `mockPinia = { state: { value: {} }, _s: new Map(), _e: effectScope() }`，调用 mock 出的 `setupStore('cart', () => { … })`，并在每步打印 `_s` 内容、`state.value` 内容、`store` 上的 key 类型，让读者用「眼见为实」看清分类时机。重点在「演透原理」，不在「跑得完整」。

- **正文不宜展开的细节**：
  `_hmrPayload` / `_hotUpdate` 的整套热更逻辑（属于 HMR 章）；`optionsForPlugin.actions` 给插件用（属于插件章）；`isOptionsStore` 分支与 options store 的特殊 hydration（属于 options-store-adapter 章）；`$subscribe / $onAction` 内部实现（属于 subscriptions / patch-and-merge 章）；`isListening / isSyncListening / debuggerEvents` 的 watch 暂停窗口细节（属于 patch-and-merge 章）；devtools 的 `_customProperties` / `_getters`（属于 devtools 章）。

- **推荐的一个执行轨迹例子**：
  输入：`defineStore('cart', () => { const items = ref(0); const total = computed(() => items.value * 10); function add(){ items.value++ } return { items, total, add } })` → `useCart(pinia)`。
  关键中间态：(1) `pinia._s.set('cart', reactive(partialStore))` 占座；(2) `scope.run(setup)` 返回 `{ items: Ref, total: ComputedRef, add: fn }`；(3) 遍历后 `pinia.state.value.cart.items = items`（state 搬运）、`setupStore.add = action(add, 'add')`（包装）、`total` 原地保留（getter）；(4) `assign(cart, setupStore)` + `assign(toRaw(cart), setupStore)`；(5) `defineProperty(cart, '$state', …)`。
  输出：`cart.items === 0`（reactive 自动解包 ref）、`cart.total === 0`（computed 懒求值）、`cart.add()` 后 `cart.$state === { items: 1 }`。

> 以上钩子供 Writer 写「动机 → 核心思想 → 心智模型 → 关键权衡 → 原理演示」；下面事实部分供核对，不要被 Writer 当目录照抄。

## 概念要点

- **三分式分类的判据**：`isRef(prop) && !isComputed(prop)` → state；`typeof prop === 'function'` → action；`isComputed(prop)`（即 `isRef(o) && !!(o as any).effect`）→ getter。源码位置: packages/pinia/src/store.ts:505-571、144-147。
- **「先占座后填充」**：`pinia._s.set($id, store)` 发生在跑 `setup()` **之前**，注释原话："store the partial store now so the setup of stores can instantiate each other before they are finished without creating infinite loops."。源码位置: packages/pinia/src/store.ts:493-502。
- **state 搬运**：setup store 创建的 ref/reactive 不是放在 `pinia.state.value`，而是 setup 返回**之后**才被搬到 `pinia.state.value[$id][key]`，使 `pinia.state` 成为跨 store 的统一序列化源（也是 `$state` getter 的真正后端）。源码位置: packages/pinia/src/store.ts:514-533。
- **action 包装**：分流时 `setupStore[key] = action(prop, key)` 直接覆盖原函数；`action()` 内部用 `ACTION_MARKER` Symbol 标记防重复包装，并通知 `actionSubscriptions`（before/after/onError）。源码位置: packages/pinia/src/store.ts:540-554、361-422。
- **getter 路径在 DEV 才登记**：分流第三支只在 `__DEV__` 分支处理 computed（登记进 `_hmrPayload.getters` 与 `setupStore._getters`）；生产构建里 computed 直接保留不动。源码位置: packages/pinia/src/store.ts:555-570。
- **双 assign**：先 `assign(store, setupStore)`（写进 reactive 代理），再 `assign(toRaw(store), setupStore)`（写进底层 raw 对象）。注释：allows retrieving reactive objects with `storeToRefs()` #799。源码位置: packages/pinia/src/store.ts:575-578。
- **$state 代理**：`Object.defineProperty(store, '$state', { get, set })`。get 直接返回 `pinia.state.value[$id]`（HMR 时返回 `hotState.value`）；set 通过 `$patch(($state) => assign($state, state))` 走，使整体替换被视为单次 patch 通知。源码位置: packages/pinia/src/store.ts:583-595、330-328。
- **setup 跑在嵌套 effectScope**：`runWithContext(() => pinia._e.run(() => (scope = effectScope()).run(() => setup({ action }))!))`——先借 app 的 runWithContext（保留 inject 上下文），再进 pinia 全局 scope `_e`，最后在子 scope 里跑 setup。子 scope 被 `scope.stop()` 即可清理该 store 全部 effect。源码位置: packages/pinia/src/store.ts:496-502。
- **partialStore 的最小骨架**：含 `_p / $id / $onAction / $patch / $reset / $subscribe / $dispose`；其中 `$onAction = addSubscription.bind(null, actionSubscriptions)`——直接绑定订阅集合返回 remover。源码位置: packages/pinia/src/store.ts:431-476。
- **setup store 的 $reset 默认抛错**：`__DEV__` 下抛 "🍍: Store ... is built using the setup syntax and does not implement $reset()."；生产环境是 `noop`。源码位置: packages/pinia/src/store.ts:330-347。
- **isComputed 的实现技巧**：`isRef(o) && !!(o as any).effect`——computed 内部就是一个带 `effect` 字段的 ref。源码位置: packages/pinia/src/store.ts:144-147。
- **isReactive(prop) 也走 state 分支**：分支条件是 `(isRef(prop) && !isComputed(prop)) || isReactive(prop)`，所以 setup 里 `reactive({...})` 返回的对象也会被当 state，并在 hydration 时走 `mergeReactiveObjects`（先 clear Map/Set 再合并）。源码位置: packages/pinia/src/store.ts:508、519-529。
- **setup 入参带 helpers**：`setup({ action })` 给 setup 函数注入一个 `action` 包装器（极少数高级用法如 Pinia Colada 才需要在 store 内部主动包 action）。源码位置: packages/pinia/src/store.ts:500-502、810-820。

## 关键调用链

```
defineStore(id, setup, options) → useStore(pinia?)
  └─ 首次：createSetupStore($id, setup, options, pinia)
       1. 拼 partialStore ($id/$patch/$subscribe/$onAction/$reset/$dispose)
       2. store = reactive(partialStore)
       3. pinia._s.set($id, store)             ← 占座（关键）
       4. runWithContext → pinia._e.run → effectScope().run(setup({ action }))
            └─ setup() 内若 useOtherStore() 命中 _s 缓存，递归终止
       5. for key in setupStore:
            ref(非computed) | reactive → 搬到 pinia.state.value[$id][key]
            function                    → action(prop, key) 包装后写回
            computed                    → 原地保留（DEV 登记 devtools）
       6. assign(store, setupStore); assign(toRaw(store), setupStore)
       7. Object.defineProperty(store, '$state', { get/set })
       8. store._hotUpdate (DEV)、defineProperty 内部字段（DEVTOOLS）
       9. pinia._p.forEach(extender => assign(store, extender(ctx)))  ← 插件
      10. isListening = isSyncListening = true; return store
```

源码位置: packages/pinia/src/store.ts:859-953（defineStore）、214-781（createSetupStore）、478-595（store 组装）、716-754（插件循环）。

## 源码摘录（带行号，全文累计 ≤ 30 行）

三分式分流主循环（state / action / getter 落点）：

```ts
// packages/pinia/src/store.ts:505-571（节选）
for (const key in setupStore) {
  const prop = setupStore[key]
  if ((isRef(prop) && !isComputed(prop)) || isReactive(prop)) {
    // state 分支
    if (!isOptionsStore) {
      if (initialState && shouldHydrate(prop)) { /* hydration 分支 */ }
      pinia.state.value[$id][key] = prop       // 搬到集中 state
    }
  } else if (typeof prop === 'function') {
    // action 分支：包一层，写回 setupStore 与 optionsForPlugin
    setupStore[key] = action(prop as _Method, key)
    optionsForPlugin.actions[key] = prop
  } else if (__DEV__) {
    if (isComputed(prop)) {
      _hmrPayload.getters[key] = isOptionsStore ? options.getters[key] : prop
      /* 登记 _getters 给 devtools */
    }
  }
}
```

占座 + 双 assign + $state 代理（构建器的"组装后半段"）：

```ts
// packages/pinia/src/store.ts:493-502、575-595（节选）
pinia._s.set($id, store as Store)  // 先注册半成品，防循环
const setupStore = runWithContext(() =>
  pinia._e.run(() => (scope = effectScope()).run(() => setup({ action })))!
)!
// …三分式分流后…
assign(store, setupStore)
assign(toRaw(store), setupStore)              // 让 storeToRefs 拿到 raw 值
Object.defineProperty(store, '$state', {
  get: () => pinia.state.value[$id],
  set: (state) => $patch(($state) => { assign($state, state) }),
})
```

isComputed 的判定（getter 与 state 的分水岭）：

```ts
// packages/pinia/src/store.ts:144-147
function isComputed(o: any): o is ComputedRef {
  return !!(isRef(o) && (o as any).effect)
}
```

## 易混淆 / 边界 / 推断

- **事实**：`createSetupStore` 既被 setup store 直接调用（`defineStore` 里 `isSetupStore=true` 路径），也被 options store 复用（`createOptionsStore` 内部以 `isOptionsStore=true` 调进来）。源码位置: packages/pinia/src/store.ts:209、905-907。
- **事实**：state 分支只在 `!isOptionsStore` 时才搬运——因为 options store 的 state 在 `createOptionsStore` 的 `setup()` 里就已经写到 `pinia.state.value[id]` 并 `toRefs` 出来了，不需要在分流阶段二次搬运。源码位置: packages/pinia/src/store.ts:514、166-177。
- **事实**：getter 分支在生产构建里**没有副作用**（`__DEV__` 才进入），但 computed 本身仍会被 `assign(store, setupStore)` 直接挂到 store 上——所以生产环境的 getter 是「自动靠 reactive 代理暴露」，DEV 才多走一步登记给 devtools。源码位置: packages/pinia/src/store.ts:555-570、575。
- **推断**：「先占座再 setup」与 `isComputed` 的懒求值是配套设计——占座使 setup 内能拿到 self（哪怕不完整），而 computed 的懒求值让 getter 内访问 self 的不完整字段不会立即爆错。源码里没有显式注释佐证"配套"，但 setup 里能取到的 self 必然是 partial 形态（因为 setup 是同步跑的，跑完才会 assign setupStore），所以 getter 必须 lazy 是必然结论。
- **推断**：双 assign 的顺序（先 reactive 后 raw）是刻意的——若先 raw 后 reactive，reactive 代理会把自己当作新值再写一次 raw，可能造成代理与原始对象引用不一致。源码注释只说"必须在 assign 到 reactive 之后调用"，未细说原因，此为推断。
- **边界**：setup 返回值里如果某个 ref 同时被标记了 `effect`（即用户手动构造的带 effect 的 ref），会被识别为 getter 而非 state——这是 `isComputed` 仅靠 `effect` 字段判定的副作用，**用户基本不会撞上**，但若用 vue 内部 API 自造 ref 需注意。
- **未理解**：`runWithContext` 这层在 Pinia 文档里没解释为何需要 app 级 runWithContext（保留 inject 上下文是 Vue 3.3+ 的能力），猜测是为「setup 内用 inject 拿东西」提供支持，但 store setup 内部似乎并不直接依赖 inject。属于推断，未在源码中找到直接证据。
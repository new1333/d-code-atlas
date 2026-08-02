# State 集中化与 SSR hydration · 源码精读

## 给 Writer 的教学钩子（必填，8 子项缺一不可）

- **用户痛点 / 场景**：
  没有「state 集中化」机制时，setup store 的状态是用户在自己写的 setup 函数里 `ref(0)` 创建的，pinia 完全不知道哪些 ref 是 state、哪些 ref 是 getter、哪些函数是 action，更没法把它们打包。SSR 服务端跑完应用后，需要把所有 store 的当前状态序列化进 HTML 再由客户端恢复；如果状态散落在每个 setup store 内部的闭包 ref 里、且 ref 和 getter 混在一起，就没有一个统一的「窗口」可以一把抓出全部 state。Devtools 想给你展示「整个 pinia 的 state 树」也面临同样问题。

- **一句话核心思想**：
  把 setup 函数返回的 ref/reactive 对象，从 store **搬运**到 pinia 实例持有的一个中心状态桶里——store 自己只保留**访问入口**，序列化和恢复都从中心桶进、出。

- **设计动机（为什么需要它）**：
  中心化换来一个统一的序列化窗口：SSR、devtools、持久化插件都通过 pinia 实例上同一个 state 对象读写 store 状态，不需要知道 store 内部如何组织 ref。但只有 state 需要被序列化，getter（计算属性）和 action（函数）不参与序列化，所以它们仍然分散挂在 store 上——这就是「state 集中、行为分散」的拆分。

- **关键权衡**：
  - **「中心化 state、行为分散在 store」选择 → 换来一个统一的序列化入口（SSR / devtools / 持久化插件共享同一份 state 镜像） → 代价是 setup store 的状态结构在运行时才确定，hydration 必须按值类型分支处理（ref / reactive 对象 / Map / Set 各有专门路径）**。
  - **「灌进已有 ref」而非「用新 ref 替换」选择 → 换来 store 中已绑定到该 ref 的 getter、computed 依赖保持引用稳定（不破坏响应式拓扑） → 代价是带默认值的 Map/Set 必须先 clear 再 merge，否则默认值会污染 hydration 数据**。
  - **「skipHydrate 用 Symbol 标记对象」选择 → 换来 setup store 里返回 router、第三方类实例等「有状态但非 store state」对象时优雅 opt-out → 代价是 Symbol 无法跨序列化保留，这只解决内存层 hydration 的 opt-out，跨网络的 opt-out 需要在序列化层另配**。
  - **「$state 用 defineProperty 代理到中心桶的对应 slot」选择 → 换来 `store.$state = {...}` 赋值会自动走 $patch 通道，所有变更汇聚成一次订阅事件 → 代价是不能直接整体替换 state 对象（赋值会变成 shallow assign，丢失嵌套 ref 包装）**。

- **最小心智模型（3～7 步）**：
  1. 创建 pinia 实例时，中心桶（一个 ref 包着的对象）出现，初始为空。
  2. 首次 useStore 触发 store 构建；option store 在跑 setup 前就把 state 写进中心桶对应 slot。
  3. setup store 不同：先在中心桶占位一个空对象（如果中心桶没有外部预填的 initialState）。
  4. 跑 setup() 拿到一堆 ref / computed / function 返回值。
  5. 遍历返回值，按类型分流：ref(非 computed) / reactive 对象 → state，function → action，computed → getter。
  6. 对每个 state 字段：如果中心桶已有同名 hydration 数据且没被 skipHydrate 标记，就把值灌进已有 ref（Map/Set 还要先 clear）；这一步**不动 ref 引用**，只动 ref 内部的 value。
  7. 不管有没有 hydrate，都把这个 ref/reactive 对象本身塞进中心桶对应 slot——这一刻起，store 字段和中心桶字段指向同一个 ref；`store.$state` 通过 defineProperty 反向代理到中心桶 slot。

- **最小原理演示**：
  - 应演示：一个 ~50 行的最小骨架，演**「创建中心桶 → setup 跑完 → 按类型分流 → 灌值 + 搬运 ref → $state 代理」**的时序；每一步对应上面心智模型的一条。把 initialState 故意设为 `{ count: 42 }`，让演示能看到 `ref(0)` 被「灌」成 42 的瞬间。
  - 应故意省略：递归合并函数的完整实现、Map/Set/clear 分支（属 patch 章）、option store 的 toRefs 路径、HMR 的 hotState、插件系统、SSR payload 传输；不追求工程完整，只演透「搬运 + 灌值 + 代理」三件事。
  - **演示载体建议**：本章源码是 TS + Vue 生态，建议直接 `import { ref, reactive, isRef, isReactive, effectScope } from 'vue'`，写一个能被 `node --experimental-vm-modules`、`tsx` 或 `bun run` 直接跑的脚本（< 60 行）。重点在打印每一步的中心桶内容、store 字段值、以及「store.$state 引用等同于中心桶对应 slot」的引用一致性。不需要起 Vue app、不需要挂组件——这是纯状态层机制。

- **正文不宜展开的细节**：
  - 递归合并函数对 Map.set / Set.add / 嵌套 reactive 子节点的具体处理（属 patch-and-merge 章）。
  - HMR 期间的 hotState 替代路径与 `__DEV__ && hot` 分支（属 hmr 章）。
  - option store 自定义 `hydrate()` hook（罕见用法，几行带过即可）。
  - 关于 `$state.constructor` 的 dev 警告诊断码。
  - _StoreWithState / DefineStoreOptionsInPlugin 等 TS 类型层级。

- **推荐的一个执行轨迹例子**：
  - 输入：用户写 `defineStore('counter', () => { const count = ref(0); const inc = () => count.value++; return { count, inc } })`；同时 SSR 已预先把中心桶的 counter slot 设为 `{ count: 42 }`。
  - 关键中间态：
    1. 占位空对象的步骤被跳过（中心桶已有数据）。
    2. setup() 返回 `{ count: ref(0), inc: fn }`。
    3. 遍历到 count：isRef 且非 computed → 进 state 分支。
    4. 中心桶有 hydration 数据且未 opt-out → `count.value = 42`（ref 引用没变，只是 .value 从 0 变 42）。
    5. 中心桶对应 slot 的 count 字段被赋值为这个 ref 本身——中心桶和 store.count 此时指向同一个 ref。
  - 输出：`store.count === 42`；`store.$state` 引用等同于中心桶 counter slot；后续调 `store.inc()` 会通过共享 ref 双向同步两边。

> 以上钩子供 Writer 写「动机→核心思想→心智模型→关键权衡→原理演示」；下面事实部分供核对，不要被 Writer 当目录照抄。

## 概念要点

- **中心桶是单一序列化窗口**：pinia 实例创建时即 `state = scope.run(() => ref<Record<string, StateTree>>({}))`，所有 store 的 state 最终都汇聚到这个 ref 的 value 中。源码位置: packages/pinia/src/createPinia.ts:14-16
- **option store 在 setup 跑之前就把 state 写进中心桶**：先快照 `initialState = pinia.state.value[id]`，setup 内若无 initialState 则 `pinia.state.value[id] = state ? state() : {}`，再 `toRefs(pinia.state.value[id])`。所以 option store 的 state 从一开始就住在中心桶，不需要「搬运」。源码位置: packages/pinia/src/store.ts:162-177
- **setup store 先占位再填充**：在跑 setup 前若中心桶没数据，先 `pinia.state.value[$id] = {}` 占位（仅当 `!isOptionsStore && !initialState && (!__DEV__ || !hot)`）。源码位置: packages/pinia/src/store.ts:271-278
- **状态搬运循环（本章核心）**：遍历 setup 返回值，用 `isRef && !isComputed || isReactive` 判定 state，`typeof === 'function'` 判定 action，`isComputed` 判定 getter。源码位置: packages/pinia/src/store.ts:505-571
- **hydration 三分支**：对 setup store 的 state 字段，若已存在外部 initialState 且未 skipHydrate：① ref → `prop.value = initialState[key]`（仅赋值，不动引用）；② Map/Set → 先 `prop.clear()` 再 `mergeReactiveObjects`（防止默认值混入 hydration 数据）；③ 其他 reactive 对象 → 直接 `mergeReactiveObjects(prop, initialState[key])`。源码位置: packages/pinia/src/store.ts:514-533
- **搬运是赋值 ref 本身**：`pinia.state.value[$id][key] = prop`——中心桶存的是同一个 ref/reactive 引用，所以响应式拓扑在 store 字段和中心桶字段间共享。源码位置: packages/pinia/src/store.ts:532
- **skipHydrate 是 Symbol 标记**：通过 `Object.defineProperty(obj, skipHydrateSymbol, {})` 给对象打标；shouldHydrate 反查该 Symbol 决定是否 opt-out。典型场景：setup store 里返回 router 实例等「有状态但非 store state」对象。源码位置: packages/pinia/src/store.ts:115-140
- **$state 用 defineProperty 代理到中心桶 slot**：get 直接返回 `pinia.state.value[$id]`（dev/hot 路径返回 hotState.value）；set 通过 `$patch + assign` 走 patch 通道，保证只触发一次订阅事件。源码位置: packages/pinia/src/store.ts:583-595
- **option store 的自定义 hydrate hook**：在 createSetupStore 末尾，若 `initialState && isOptionsStore && options.hydrate`，调用用户提供的 `hydrate!(store.$state, initialState)`——默认 toRefs 路径不够用时（如需 hydration 后副作用）的扩展点。源码位置: packages/pinia/src/store.ts:766-776
- **mergeReactiveObjects 同时服务 patch 和 hydration**：递归合并两个 reactive 对象，对 Map 走 `target.set(key, value)`、Set 走 `target.add(value)`、plain object 子节点递归；跳过 ref/reactive 子节点避免破坏响应式包装。源码位置: packages/pinia/src/store.ts:79-113

## 关键调用链

```
createPinia()
  └─ scope.run(() => ref({}))                       ← 中心桶诞生
                                                      源码位置: createPinia.ts:14-16

useStore(pinia) → createSetupStore(id, setup, opts, pinia)
  ├─ initialState = pinia.state.value[$id]           ← 快照（可能为 undefined）
  │                                                    源码位置: store.ts:271
  ├─ if (!isOptionsStore && !initialState) pinia.state.value[$id] = {}  ← 占位
  │                                                    源码位置: store.ts:275-278
  ├─ scope.run(() => setup({ action }))              ← 用户 setup，返回 ref/computed/fn
  │                                                    源码位置: store.ts:500-502
  └─ for (key in setupStore)                         ← 状态搬运循环
       ├─ isRef && !isComputed || isReactive → STATE
       │    ├─ if (initialState && shouldHydrate(prop))
       │    │    ├─ isRef    → prop.value = initialState[key]
       │    │    ├─ Set/Map  → prop.clear(); mergeReactiveObjects(...)
       │    │    └─ reactive → mergeReactiveObjects(...)
       │    └─ pinia.state.value[$id][key] = prop    ← 搬运 ref 本身
       ├─ typeof === 'function' → ACTION (包一层)
       └─ isComputed           → GETTER
                                                      源码位置: store.ts:505-571

Object.defineProperty(store, '$state', { get/set })  ← $state 代理到中心桶
                                                      源码位置: store.ts:583-595

// option store 末尾自定义 hydrate hook
if (initialState && isOptionsStore && options.hydrate)
  options.hydrate(store.$state, initialState)
                                                      源码位置: store.ts:766-776
```

## 源码摘录（带行号，全文累计 ≤ 30 行）

状态搬运循环（核心，setup store 的 state 分支；已省略 HMR/devtools 分支以聚焦原理）：

```ts
// packages/pinia/src/store.ts:505-533（节选）
for (const key in setupStore) {
  const prop = setupStore[key]
  if ((isRef(prop) && !isComputed(prop)) || isReactive(prop)) {
    if (!isOptionsStore) {
      if (initialState && shouldHydrate(prop)) {
        if (isRef(prop)) {
          prop.value = initialState[key]
        } else {
          if (prop instanceof Set || prop instanceof Map) prop.clear()
          mergeReactiveObjects(prop, initialState[key])
        }
      }
      pinia.state.value[$id][key] = prop
    }
  }
}
```

skipHydrate / shouldHydrate（Symbol opt-out 机制）：

```ts
// packages/pinia/src/store.ts:115-140
const skipHydrateSymbol = __DEV__ ? Symbol('pinia:skipHydration') : Symbol()
export function skipHydrate<T = any>(obj: T): T {
  return Object.defineProperty(obj, skipHydrateSymbol, {})
}
export function shouldHydrate(obj: any) {
  return !obj || typeof obj !== 'object' || !Object.hasOwn(obj, skipHydrateSymbol)
}
```

$state 代理到中心桶 slot：

```ts
// packages/pinia/src/store.ts:583-595
Object.defineProperty(store, '$state', {
  get: () => (__DEV__ && hot ? hotState.value : pinia.state.value[$id]),
  set: (state) => {
    $patch(($state) => { assign($state, state) })
  },
})
```

## 易混淆 / 边界 / 推断

- **事实**：`initialState` 是 createSetupStore 入口处的快照（store.ts:271），不是 live 引用。即便 line 277 把中心桶 slot 占位成 `{}`，本地 `initialState` 变量仍为 undefined，循环里 `initialState && shouldHydrate(...)` 判定为 false，跳过 hydration——这正是首次创建（非 SSR）时的预期行为。
- **事实**：option store 不走「搬运循环」的 hydration 分支，因为它的 state 一开始就住在中心桶（store.ts:167-170），setup() 只是 `toRefs()` 出来用；搬运循环里 `!isOptionsStore` 的判断（store.ts:514）显式跳过它。但 option store 仍可在末尾走自定义 `options.hydrate()` 钩子（store.ts:766-776）。
- **事实**：setup store 的「占位空对象」（store.ts:275-278）只在 `!initialState` 时执行——如果中心桶已有 SSR 预填的数据，就**保留数据不动**，让后续搬运循环靠 `initialState` 快照来触发 hydration。
- **推断**：Map/Set 在 hydration 时「先 clear 再 merge」而非「直接 merge」的原因是：setup store 的 ref 可能初始化时就有默认值（如 `ref(new Set([1,2]))`），如果直接 merge，默认值会和 hydration 数据并存——clear 强制把状态完全替换为 hydration 数据。这一点由源码注释（store.ts:521-523）和 mergeReactiveObjects 内部对 Map 的 `.set(key, value)` 语义（覆盖现有 key 但不删额外 key）共同佐证，可视为推断。
- **推断**：Symbol-based skipHydrate 无法跨网络序列化保留——SSR payload 传到客户端后 Symbol 属性会丢。这与 nuxt 模块用 `definePayloadReducer/Reviver` 配合 `shouldHydrate` 在序列化层 opt-out（属 nuxt-module 章）相互印证：跨网络 opt-out 走 payload 序列化层，内存层（HMR、热重载）走 Symbol。这是基于代码注释（store.ts:119-122「useful in setup stores」）+ nuxt 模块设计的推断。
- **推断**：「灌进已有 ref」而非「替换 ref」的选择，是为了保护响应式拓扑——getter/computed 在 setup 闭包里捕获了对原 ref 的引用，如果 hydration 时新建 ref 替换，那些闭包会指向旧 ref，状态分裂。源码注释（store.ts:531「transfer the ref to the pinia state to keep everything in sync」）支持此推断。
- **未理解**：option store 的自定义 `hydrate()` hook（store.ts:766-776）实际使用场景——源码里没找到默认用法或文档示例，可能是给特殊插件（如 SSR 自定义反序列化、持久化插件）预留的扩展点。Writer 不必展开。
- **未理解**：HMR 路径下 `hotState.value[key] = toRef(setupStore, key)`（store.ts:511）为何用 `toRef` 而非直接赋值——可能与 HMR 的响应式追踪粒度有关，属 hmr 章范畴。
# store 的定义与实例化 · 源码精读

> 本章 sourceFiles：`packages/pinia/src/store.ts`（全文 970 行）。
> 范围严格限定于 **defineStore 三种重载 + createOptionsStore/createSetupStore 装配管线**（自动归类 state/getter/action、reactive 化、应用插件、SSR hydrate、_hotUpdate）。
> 物理上同处 `createSetupStore` 内的 `$patch/$reset/$dispose/$subscribe/$onAction/$state` 实现行为详见 **store-instance-api** 章节；`mergeReactiveObjects`/`patchObject` 的深合并算法详见 **store-instance-api** / **hmr** 章节——本章仅标注其「在此定义/挂载」，不展开行为。

---

## 一、概念要点

### 1. defineStore 是「工厂的工厂」：返回 useStore 闭包，store 懒创建

- `defineStore` 对外暴露 3 个重载签名 + 1 个实现，标记 `#__NO_SIDE_EFFECTS__` 以便未被引用的 store 可被 tree-shake。
  - 源码位置: `packages/pinia/src/store.ts:857-859`
- **重载 1（Options Store）**：`defineStore(id, options: Omit<DefineStoreOptions,'id'>)`。options 即 `{ state?, getters?, actions?, hydrate? }`。
  - 源码位置: `packages/pinia/src/store.ts:828-837`；类型契约 `packages/pinia/src/types.ts:613-674`（`DefineStoreOptions`）
- **重载 2（Setup Store）**：`defineStore(id, storeSetup, options?)`。`storeSetup: (helpers: SetupStoreHelpers) => SS`。
  - 源码位置: `packages/pinia/src/store.ts:846-855`；`SetupStoreHelpers` 见 `packages/pinia/src/store.ts:810-820`
- **实现**用「第二个参数是否为函数」区分两种 store：
  - `const isSetupStore = typeof setup === 'function'`
  - `options = isSetupStore ? setupOptions : setup`（options store 的配置在第二参，setup store 的配置在第三参）
  - 源码位置: `packages/pinia/src/store.ts:879-881`
- 返回 `useStore` 闭包，并挂 `useStore.$id = id`（map helpers 用）。
  - 源码位置: `packages/pinia/src/store.ts:883,951-953`
- **懒创建**：`useStore()` 内 `if (!pinia._s.has(id))` 时才实例化，并注册进 `pinia._s`（store 注册表）。setup store 调 `createSetupStore`，options store 调 `createOptionsStore`。
  - 源码位置: `packages/pinia/src/store.ts:902-909`
- 取 pinia 的优先级：显式参数 → 注入 `inject(piniaSymbol)` → `activePinia`。测试模式（`activePinia._testing`）跳过显式参数，强制用全局。
  - 源码位置: `packages/pinia/src/store.ts:884-890`
- HMR 分支（`__DEV__ && hot`）：用一个 `__hot:` + id 的临时 store 调 `hot._hotUpdate(newStore)`，再清理临时 state 与 cache。
  - 源码位置: `packages/pinia/src/store.ts:919-930`
- 组件实例缓存：`__DEV__ && IS_CLIENT` 时把 store 存入 `currentInstance.proxy._pStores[id]`，供 devtools。
  - 源码位置: `packages/pinia/src/store.ts:932-945`

### 2. createOptionsStore：把 options 翻译成 setup，再复用 createSetupStore

**核心洞察**：options store 不是独立实现，而是一个「适配器」——`createOptionsStore` 构造一个内部 `setup()`，把 `{state, getters, actions}` 翻译成 setup store 的返回形态，然后交给 `createSetupStore`，并传第六参 `isOptionsStore = true` 作为唯一区分标志。
- 源码位置: `packages/pinia/src/store.ts:149-212`

内部 `setup()` 做了三件事：
- **state 提升到根**：`if (!initialState && !hot) pinia.state.value[id] = state ? state() : {}`。options store 的 state 整体放进 `pinia.state.value[id]`。
  - 源码位置: `packages/pinia/src/store.ts:167-170`
- **state 转 ref**：`localState = toRefs(pinia.state.value[id])`（hot 模式走 `toRefs(ref(state?()...).value)`）。
  - 源码位置: `packages/pinia/src/store.ts:173-177`
- **getter 包装为 computed**：逐个 getter 包成 `computed(() => { setActivePinia(pinia); const store = pinia._s.get(id)!; return getters![name].call(store, store) })`，并用 `markRaw` 包裹 computed（避免被外层 reactive 二次代理）。getter 与 state 同名时报 `PINIA_R1002`。
  - 源码位置: `packages/pinia/src/store.ts:182-205`
- 最后 `assign(localState, actions, computedGetters)` 作为 setup 返回值。
  - 源码位置: `packages/pinia/src/store.ts:179-206`
- 落地：`createSetupStore(id, setup, options, pinia, hot, true)`。
  - 源码位置: `packages/pinia/src/store.ts:209`

### 3. createSetupStore：装配管线（14 步骨架）

函数签名 `(id, setup, options, pinia, hot?, isOptionsStore?)`，返回 `Store`。
- 源码位置: `packages/pinia/src/store.ts:214-229`

**3.1 选项准备 + Pinia 存活校验**
- `optionsForPlugin = assign({ actions: {} }, options)`：保证 `actions` 字段存在（`DefineStoreOptionsInPlugin` 要求 actions 必有）。类型 `packages/pinia/src/types.ts:698-710`。
- `__DEV__ && !pinia._e.active` 抛 `'Pinia destroyed'`。
- 源码位置: `packages/pinia/src/store.ts:232-240`

**3.2 内部状态**：`subscriptions`/`actionSubscriptions`（Set）、`isListening`/`isSyncListening`（末尾置 true）、`debuggerEvents`、`initialState = pinia.state.value[$id]`。
- 源码位置: `packages/pinia/src/store.ts:266-271`

**3.3 setup store 的 state 占位**：`if (!isOptionsStore && !initialState && !hot) pinia.state.value[$id] = {}`。setup store 先在根占位 `{}`，真实 ref 在 3.7 分类循环里逐 key 回填。
- 源码位置: `packages/pinia/src/store.ts:275-278`
- HMR 专用快照 `hotState = ref({})`：`packages/pinia/src/store.ts:280`

**3.4 实例 API 在此定义（行为详见 store-instance-api）**：`$patch`(285-328)、`$reset`(330-347，仅 options store 有实现，setup store 在 DEV 抛错/prod noop)、`$dispose`(349-354)、`action` 包装器(361-422)、`partialStore`(431-476，含 `$onAction/$patch/$reset/$subscribe/$dispose`)。
- 源码位置: `packages/pinia/src/store.ts:285-476`

**3.5 reactive 化 store**：`const store = reactive(...)`。开发/devtools 模式额外注入 `_hmrPayload` 与 `_customProperties: markRaw(new Set())`；生产模式直接 reactive(partialStore)。
- 源码位置: `packages/pinia/src/store.ts:478-490`；`_hmrPayload` 结构 `packages/pinia/src/store.ts:424-429`

**3.6 先注册 _s，再跑 setup（支持循环依赖）**
- `pinia._s.set($id, store)`——**在跑 setup 之前**先把 partial store 注册。注释明示：这使 store 之间可在 setup 中相互实例化而不产生无限循环。options store 的 getter 内 `pinia._s.get(id)!`（行 192）正依赖此点。
- 三层 scope 嵌套执行 setup：`runWithContext(() => pinia._e.run(() => (scope = effectScope()).run(() => setup({action}))))`。即 app context → pinia 的 effectScope → store 专属 effectScope。
- 源码位置: `packages/pinia/src/store.ts:492-502`；`runWithContext` 回退 `packages/pinia/src/store.ts:55,496-497`

**3.7 自动归类 state / getter / action（装配最关键）**：`for (const key in setupStore)`，按类型分流：
- **state**：判定 `(isRef(prop) && !isComputed(prop)) || isReactive(prop)`。
  - DEV/hot：`hotState.value[key] = toRef(setupStore, key)`。
  - setup store（非 options）：若有 `initialState && shouldHydrate(prop)`，则回灌——ref 设 `.value`；reactive 的 Set/Map 先 `clear()` 再 `mergeReactiveObjects` 回灌（注释：保持 $patch 合并语义）。
  - setup store：把 ref 转移到 `pinia.state.value[$id][key] = prop`（与根 state 同步）。
  - DEV：`_hmrPayload.state.push(key)`。
  - 源码位置: `packages/pinia/src/store.ts:508-538`
- **action**：判定 `typeof prop === 'function'`。`actionValue = (DEV && hot) ? prop : action(prop, key)`（用 `action` 包装器包一层以支持 `$onAction`），覆盖 `setupStore[key]`；DEV 记录 `_hmrPayload.actions[key]`；并把原函数写回 `optionsForPlugin.actions[key]` 供插件。
  - 源码位置: `packages/pinia/src/store.ts:540-554`
- **getter**（仅 DEV）：判定 `isComputed(prop)`。记录 `_hmrPayload.getters[key]`（options store 取 `options.getters[key]`，setup store 取 `prop` 本身）；IS_CLIENT 时收集到 `setupStore._getters` 供 devtools。
  - 源码位置: `packages/pinia/src/store.ts:555-569`

**3.8 合并到 store**：`assign(store, setupStore)`；再 `assign(toRaw(store), setupStore)`（注释：让 `storeToRefs()` 能取回 reactive 对象，#799）。
- 源码位置: `packages/pinia/src/store.ts:573-578`

**3.9 `$state` 访问器**：`Object.defineProperty(store, '$state', { get, set })`。get：`DEV && hot ? hotState.value : pinia.state.value[$id]`；set：走 `$patch(($state) => assign($state, state))` 以触发订阅。注释：不用「带 setter 的 computed」，是为了不把 computed 生命周期绑定到首次创建处。
- 源码位置: `packages/pinia/src/store.ts:580-595`

**3.10 `_hotUpdate`（仅 DEV）**：`store._hotUpdate = markRaw((newStore) => {...})`。设 `_hotUpdating=true` 后：同步 state（options store 用 `patchObject` 深合并，setup store 直接转移 ref——注释区分两者差异，#2611）、补 `toRef` 直达属性、删被移除的 state key、暂停/恢复监听、更新 actions（重新 `action()` 包装）、getters（options store 重新包 `computed`）、删除旧 getters/actions、更新 `_hmrPayload`/`_getters`、置 `_hotUpdating=false`。
- 源码位置: `packages/pinia/src/store.ts:597-694`（行为详见 hmr 章节）

**3.11 devtools 属性隐藏**：`__USE_DEVTOOLS__ && IS_CLIENT` 时把 `_p/_hmrPayload/_getters/_customProperties` 重定义为 `enumerable: false`，避免在 devtools 中列出。
- 源码位置: `packages/pinia/src/store.ts:696-714`

**3.12 应用插件**：`pinia._p.forEach((extender) => {...})`。每个插件在 `scope.run` 内拿到 `PiniaPluginContext({ store, app: pinia._a, pinia, options: optionsForPlugin })`；返回的属性先经检查（非响应式且未 markRaw 的对象属性报 `PINIA_R1006`），再 `assign(store, extensions)` 合并进 store。DEV/devtools 时把扩展 key 加入 `_customProperties`。
- 源码位置: `packages/pinia/src/store.ts:716-754`；`PiniaPluginContext` `packages/pinia/src/rootStore.ts:132-172`

**3.13 R1003 校验**：若 `store.$state` 的 constructor 是普通函数且非 native code（典型：`state: () => new MyClass()`），报 `PINIA_R1003`。
- 源码位置: `packages/pinia/src/store.ts:756-764`

**3.14 SSR hydrate 钩子**：`if (initialState && isOptionsStore && options.hydrate)` 调 `options.hydrate(store.$state, initialState)`。**仅 options store + 有初始 state + 定义了 hydrate 时触发**；setup store 的回灌在 3.7 分类循环里完成。
- 源码位置: `packages/pinia/src/store.ts:766-776`；hydrate 签名 `packages/pinia/src/types.ts:649-673`

**3.15 开启监听**：`isListening = true; isSyncListening = true`，装配完成返回 store。
- 源码位置: `packages/pinia/src/store.ts:778-780`

### 4. 辅助与导出（定义/实例化相关）

- `isComputed(o)`：`isRef(o) && (o as any).effect`——用「effect 属性存在」区分 computed 与普通 ref。
  - 源码位置: `packages/pinia/src/store.ts:144-147`
- `skipHydrate` / `shouldHydrate`：setup store 返回「有状态但非状态对象」（如 router 实例）时，用 `skipHydrate` 标记后 `shouldHydrate` 返回 false，避免被回灌。基于 `skipHydrateSymbol`。
  - 源码位置: `packages/pinia/src/store.ts:115-140`
- `ACTION_MARKER` / `ACTION_NAME` / `MarkedAction`：action 包装器的内部标记符号，使同一函数不重复包装。
  - 源码位置: `packages/pinia/src/store.ts:63-77`
- `action` 包装器（内部函数）：既是分类循环自动包装 options/setup store action 的工具，也作为 `SetupStoreHelpers.action` 暴露给 setup store 用户，使其**在 store 内部主动调用**的 action 也能被 `$onAction` 捕获（注释：rarely needed，Pinia Colada 等高级场景）。
  - 源码位置: `packages/pinia/src/store.ts:361-422`；暴露点 `packages/pinia/src/store.ts:501,819`
- 类型导出：`StoreActions`/`StoreGetters`/`StoreState`（按 store 类型推断三要素）、`SetupStoreDefinition`。
  - 源码位置: `packages/pinia/src/store.ts:787-808,962-970`

---

## 二、关键调用链

### 整体定义→实例化链
```
defineStore(id, ...) ──返回──> useStore 闭包（懒工厂）
  store.ts:859,951
useStore()
  ├─ pinia._s.has(id)?  否 ─> createSetupStore / createOptionsStore   store.ts:902-908
  └─ pinia._s.get(id)   返回已注册实例                                  store.ts:917

createOptionsStore(id, options, pinia)
  ├─ setup(): state 提升到根 + toRefs + getters→computed(markRaw)      store.ts:166-207
  └─ createSetupStore(id, setup, options, pinia, hot, isOptionsStore=true)  store.ts:209
        （options store 复用 setup 装配管线，仅靠 isOptionsStore 区分）

createSetupStore($id, setup, options, pinia, hot, isOptionsStore)  store.ts:214-781
  1. optionsForPlugin = { actions, ...options }            store.ts:232
  2. pinia._s.set($id, store)  先注册（支持循环依赖）       store.ts:494
  3. runWithContext → pinia._e.run → effectScope().run(setup)  跑 setup  store.ts:500-502
  4. for...in 分类 state/getter/action                     store.ts:505-571
  5. reactive(store) + assign(toRaw(store), setupStore)    store.ts:478,575-578
  6. defineProperty $state                                 store.ts:583
  7. _hotUpdate (DEV)                                      store.ts:600
  8. devtools 属性 enumerable:false                         store.ts:696-714
  9. pinia._p.forEach 应用插件                              store.ts:717-754
 10. options.hydrate (SSR, options store)                  store.ts:767
 11. isListening/isSyncListening = true                    store.ts:778
```

### state 双重存储链
```
options store: createOptionsStore.setup() ─> pinia.state.value[id] = state()          store.ts:169
setup store:   createSetupStore 分类循环 ─> pinia.state.value[$id][key] = ref          store.ts:532
store 读取:    store（reactive 后解包）  <── assign(toRaw(store), setupStore)          store.ts:578
$state 访问:   store.$state ─> pinia.state.value[$id]                                  store.ts:584
```

### getter 跨引用链（依赖「先注册 _s」）
```
computed 求值(懒) ─> setActivePinia(pinia) ─> store = pinia._s.get(id)! ─> getters[name].call(store, store)
  store.ts:189-200  （store 已在 setup 跑之前注册于 store.ts:494）
```

### 响应式作用域归属
```
store 专属 effectScope = effectScope()，在 pinia._e 内创建           store.ts:501
所有 setup 副作用挂在该 scope；$dispose() 调 scope.stop() 释放        store.ts:349-354
```

---

## 三、源码摘录（带行号）

### defineStore 实现核心：懒创建 + 注册
```ts
// packages/pinia/src/store.ts:857-908
/*! #__NO_SIDE_EFFECTS__ */
export function defineStore(/* 实现签名 */ id: any, setup?: any, setupOptions?: any): StoreDefinition {
  let options: /* DefineStoreOptions | DefineSetupStoreOptions */ any
  const isSetupStore = typeof setup === 'function'
  options = isSetupStore ? setupOptions : setup

  function useStore(pinia?: Pinia | null, hot?: StoreGeneric): StoreGeneric {
    const hasContext = hasInjectionContext()
    pinia =
      (__TEST__ && activePinia && activePinia._testing ? null : pinia) ||
      (hasContext ? inject(piniaSymbol, null) : null)
    if (pinia) setActivePinia(pinia)
    // ...无 activePinia 抛错...
    pinia = activePinia!

    if (!pinia._s.has(id)) {
      // creating the store registers it in `pinia._s`
      if (isSetupStore) {
        createSetupStore(id, setup, options, pinia)
      } else {
        createOptionsStore(id, options as any, pinia)
      }
    }
    const store: StoreGeneric = pinia._s.get(id)!
    // ...HMR、devtools 缓存...
    return store as any
  }
  useStore.$id = id
  return useStore
}
```

### createOptionsStore：options → setup 适配
```ts
// packages/pinia/src/store.ts:166-207（setup 内部）
function setup() {
  if (!initialState && (!__DEV__ || !hot)) {
    pinia.state.value[id] = state ? state() : {}            // state 提升到根
  }
  const localState =
    __DEV__ && hot ? toRefs(ref(state ? state() : {}).value) : toRefs(pinia.state.value[id])

  return assign(
    localState,
    actions,
    Object.keys(getters || {}).reduce((computedGetters, name) => {
      if (__DEV__ && name in localState) diagnostics.PINIA_R1002({ name, id })
      computedGetters[name] = markRaw(
        computed(() => {
          setActivePinia(pinia)
          const store = pinia._s.get(id)!                   // 懒取已注册实例，支持跨 getter 引用
          return getters![name].call(store, store)
        })
      )
      return computedGetters
    }, {} as Record<string, ComputedRef>)
  )
}
store = createSetupStore(id, setup, options, pinia, hot, true)  // isOptionsStore=true
```

### createSetupStore：先注册 + 三层 scope 跑 setup
```ts
// packages/pinia/src/store.ts:478-502
const store: Store<Id, S, G, A> = reactive(
  __DEV__ || (__USE_DEVTOOLS__ && IS_CLIENT)
    ? assign({ _hmrPayload, _customProperties: markRaw(new Set<string>()) }, partialStore)
    : partialStore
) as unknown as Store<Id, S, G, A>

// store the partial store now so the setup of stores can instantiate each other
// before they are finished without creating infinite loops.
pinia._s.set($id, store as Store)

const runWithContext = (pinia._a && pinia._a.runWithContext) || fallbackRunWithContext
const setupStore = runWithContext(() =>
  pinia._e.run(() => (scope = effectScope()).run(() => setup({ action }))!)
)!
```

### 自动分类循环（装配核心）
```ts
// packages/pinia/src/store.ts:505-571
for (const key in setupStore) {
  const prop = setupStore[key]

  if ((isRef(prop) && !isComputed(prop)) || isReactive(prop)) {        // ── state
    if (__DEV__ && hot) {
      hotState.value[key] = toRef(setupStore, key)
    } else if (!isOptionsStore) {                                       // setup store 回灌+提升
      if (initialState && shouldHydrate(prop)) {
        if (isRef(prop)) prop.value = initialState[key]
        else { if (prop instanceof Set || prop instanceof Map) prop.clear(); mergeReactiveObjects(prop, initialState[key]) }
      }
      pinia.state.value[$id][key] = prop
    }
    if (__DEV__) _hmrPayload.state.push(key)

  } else if (typeof prop === 'function') {                              // ── action
    const actionValue = __DEV__ && hot ? prop : action(prop as _Method, key)
    setupStore[key] = actionValue
    if (__DEV__) _hmrPayload.actions[key] = prop
    optionsForPlugin.actions[key] = prop                                // 供插件

  } else if (__DEV__) {                                                 // ── getter(仅 DEV 记录)
    if (isComputed(prop)) {
      _hmrPayload.getters[key] = isOptionsStore ? options.getters[key] : prop
      if (IS_CLIENT) { /* 收集到 setupStore._getters 供 devtools */ }
    }
  }
}
```

### 应用插件
```ts
// packages/pinia/src/store.ts:717-754
pinia._p.forEach((extender) => {
  const extensions = scope.run(() =>
    extender({ store: store as Store, app: pinia._a, pinia, options: optionsForPlugin })
  )!
  if (__USE_DEVTOOLS__ && IS_CLIENT) {
    Object.keys(extensions || {}).forEach((key) => store._customProperties.add(key))
  }
  if (__DEV__) {
    for (const key in extensions) {                 // 检查插件返回的「非响应式对象」属性
      const value = (extensions as any)[key]
      if (typeof value === 'object' && !isRef(value) && !isReactive(value) && !value?.__v_skip) {
        diagnostics.PINIA_R1006({ key, id: $id })
      }
    }
  }
  assign(store, extensions)
})
```

### SSR hydrate 钩子
```ts
// packages/pinia/src/store.ts:766-776
if (initialState && isOptionsStore && (options as DefineStoreOptions<Id, S, G, A>).hydrate) {
  ;(options as DefineStoreOptions<Id, S, G, A>).hydrate!(store.$state, initialState)
}
```

---

## 四、易混淆 / 需 Writer 注意

1. **options store 与 setup store 同源**：options store 并非独立实现，而是 `createOptionsStore` 构造 `setup()` 再走 `createSetupStore`。`isOptionsStore`（第六参，仅 options store 传 `true`）是**唯一**运行时区分标志，它在 4 处产生行为分叉：(a) state 提升方式（options 在 setup 内整体设值；setup 在分类循环逐 key 回填）；(b) `$reset` 是否可用（仅 options store 有真实实现）；(c) SSR hydrate 钩子是否触发（仅 options store）；(d) `_hotUpdate` 中 state 合并策略（options 用 `patchObject` 深合并；setup 直接转移 ref，见 #2611）。
   - 源码位置: `packages/pinia/src/store.ts:209,275-278,330-347,607-622,766-776`
2. **「先注册 _s 再跑 setup」是循环依赖支持的关键时序**：getter 的 computed 内 `pinia._s.get(id)!` 依赖 store 已注册。Writer 讲装配顺序时务必强调这点，否则「store 互相引用」讲不通。
   - 源码位置: `packages/pinia/src/store.ts:492-502`
3. **store 是 `reactive()`，但内部用 `markRaw` 抵御二次代理**：`_hmrPayload`、`_customProperties`、options store 的 getter computed 都 `markRaw`。
   - 源码位置: `packages/pinia/src/store.ts:424,483,188`
4. **三层 effectScope 嵌套**：`app.runWithContext → pinia._e.run → effectScope().run`。setup 的响应式副作用挂载在 store 专属 scope（局部变量 `scope`），`$dispose()` 调 `scope.stop()` 才能释放。这是「pinia 持有根 scope、每个 store 持有子 scope」的层级关系。
   - 源码位置: `packages/pinia/src/store.ts:496-502,349-354`
5. **state 的双重存储**：state 同时存在于 `pinia.state.value[$id]`（根，用于序列化/SSR/devtools）和 store 内（reactive 解包后的 ref）。两者靠 `toRefs`/`toRef`/`assign(toRaw(store),...)` 同步。`$state` 访问器指向根。
   - 源码位置: `packages/pinia/src/store.ts:169,177,532,578,583-584`
6. **action 包装的双重入口**：分类循环自动为所有 action 调 `action()` 包装（options/setup 通用）；setup store 用户还可主动用 `SetupStoreHelpers.action` 包装 store **内部**调用的 action（否则内部调用不触发 `$onAction`）。注释称后者「rarely needed」。
   - 源码位置: `packages/pinia/src/store.ts:541,501,810-820`
7. **装配阶段的质量门诊断**：`PINIA_R1002`（getter 与 state 同名，在 createOptionsStore.setup 内）、`PINIA_R1003`（state 非 plain object，在 createSetupStore 末尾）、`PINIA_R1006`（插件返回非响应式对象，在应用插件时）都在装配管线中触发，全部 dev-only、可 tree-shake。
   - 源码位置: `packages/pinia/src/store.ts:184-186,737-751,756-764`；诊断语义 `packages/pinia/src/diagnostics.ts:16-49`
8. **本章与相邻章节的边界**（避免内容同质化）：
   - `$patch`/`$reset`/`$dispose`/`$subscribe`/`$onAction`/`$state` setter 的**实现行为** → store-instance-api（本章只标注其在此定义并挂到 partialStore）。
   - `mergeReactiveObjects` 的深合并算法（Map/Set/对象）→ store-instance-api（主要服务 `$patch`）/ hmr。
   - `_hotUpdate` 内 `patchObject` 的深合并与 `acceptHMRUpdate` 触发链 → hmr。
   - `MutationType` 枚举语义 → store-instance-api（定义于 `packages/pinia/src/types.ts:43`）。
   - 本章不展开上述行为的算法细节，仅说明它们「作为装配产物/钩子挂载在 createSetupStore 内」。
# 插件系统：扩展每一个 store · 源码精读

## 给 Writer 的教学钩子（必填，8 子项缺一不可）

- **用户痛点 / 场景**：状态库自带的 API 不够用时，使用者希望在不 fork 源码的前提下，给每一个 store 注入新能力——日志、权限校验、持久化、与 DevTools 联动、测试桩——而且这些注入要「写一次，所有 store 都生效」。没有这个机制，每写一个 store 就要手动 mixin 一遍，或者把扩展逻辑塞进 useStore 包装函数里、和库本体耦合死。

- **一句话核心思想**：把扩展点设计成「构造每个 store 时回调一次、把返回的属性焊到 store 上」。一次注册、终身生效。

- **设计动机（为什么需要它）**：Pinia 的 store 是 reactive 对象，不是 class，没法靠继承扩展；如果把所有功能内置，包体会爆炸且无法 tree-shake。插件机制把「能力」从「核心」里剥离：核心只管「在哪里调用插件、怎么把插件返回的东西焊进 store」，能力本身留给生态（devtools、testing、持久化等）按需挂载。这换来了「核心极小 + 生态无限」的张力。

- **关键权衡（本 Atlas 的核心）**：
  - **做了「在 store 自身的 effect scope 里运行插件」的选择 → 换来了插件返回的 ref/computed 自动随 store 一起销毁、无需插件作者自己管生命周期 → 代价是插件返回的「非响应式 plain object」会触发开发期警告，必须手动 markRaw（提示它不是状态、不会被解构取用），否则会被误判为「忘了包 ref 的状态」**。
  - **做了「插件用 (context) => extensions 形态、而不是 mutation 风格」的选择 → 换来了插件无副作用地声明自己要加什么属性，pinia 来 assign → 代价是执行顺序敏感：后注册的插件返回同名 key 会覆盖前一个，用户必须自己排顺序（测试桩就靠这个覆盖 action）**。
  - **做了「app.use(pinia) 之前的插件先排到 toBeInstalled 队列、install 时再 flush 进真正的插件表」的选择 → 换来了「无论用户在 app.use 之前还是之后调 use(plugin)，所有 store 创建时都能均匀命中」→ 代价是多一条队列、多一次 flush，但语义统一，没有「太晚注册就漏」的坑**。
  - **做了「插件接收 options（含 actions 列表）作为只读上下文」的选择 → 换来了插件能按需读取/遍历 action 名（如 testing 拿来逐个桩化）→ 代价是 options 必须先被 augment 成插件友好版（补上 actions 字段），用户原始选项的形状不能直接给插件**。

- **最小心智模型（3～7 步）**：
  1. 用户调 `pinia.use(plugin)`：当前 pinia 还没被 app install → 推进待装队列；已被 install → 直接进插件表。
  2. `app.use(pinia)` 触发 install：把待装队列里所有插件一次性灌进插件表，队列清空。
  3. 组件里第一次 `useStore()` → pinia 命中缓存未果 → 进入 store 构建器。
  4. store 构建到尾声：state/getter/action 都已分类完毕、reactive 包装也做好了。
  5. 遍历插件表，**在 store 自身的 effect scope 里**逐个调用 `plugin({ store, app, pinia, options })`。
  6. 把每个插件返回的对象 `assign` 到 store 上——这一刻插件返回的 ref/computed 自动落进 store 的 scope、随 store 销毁。
  7. dev 模式下逐字段体检：返回的不是 ref/reactive、也不是 markRaw 过的 → 提示「该 ref 的请 ref、不该响应式的请 markRaw」。

- **最小原理演示（替代旧"复刻范围"）**：
  - **应演示**：一个 ~40 行的「mini pinia 插件系统骨架」——只有 `pinia._p` 数组、`pinia.use` 注册函数、`createStore` 末尾遍历 `_p` 并 `assign` 返回值。重点演透两条原理：**(a) 双阶段注册（待装队列 + 真表）；(b) 在 store scope 内调用插件，让返回的响应式对象自动回收**。可用一个 fake `effectScope`（带 stop 回收钩子）演示「scope.stop() 后插件返回的 ref 也跟着失效」。
  - **应故意省略**：完整的 reactive 实现、options/setup store 分流、$patch/$reset、devtools 集成、HMR、PINIA_R1006 dev 警告、actions/options 上下文细节。这些是其他章节的血肉，不是本章原理。
  - **演示载体建议**：写成能 `node`/`bun` 直接跑的 TS 脚本（核心机制是纯数据结构与函数调用，不依赖 Vue 渲染）。一个 `miniPinia.ts` + 一个 demo：注册一个「日志插件」（给 store 加 `$log`）和一个「计数插件」（给 store 加 `ref(0)` 计数器），观察两插件 assign 后 store 上同时有这两组属性、并演示 stop pinia 后计数 ref 失效。**载体服务于"演透原理"，不强求接 Vue**。

- **正文不宜展开的细节**：
  - devtools 不可枚举化的内部属性（`_p`、`_hmrPayload`、`_customProperties` 等）——只是为了让 devtools 面板不刷出内部字段。
  - dev 模式对 `extensions[key]` 做的 `PINIA_R1006` 警告具体分支（null 也算 object、`__v_skip` 跳过等）——属于「体检细节」。
  - `disposePinia` 里的 `_p.splice(0)`——一行清理，不是原理。
  - `PiniaCustomProperties` / `PiniaCustomStateProperties` 的 TS 声明合并用法——类型工程、非机制原理，可作脚注。
  - `_testing` 标志（testing pinia 注入用来 bypass useStore(pinia) 参数）——和测试桩章相关，非本章主角。

- **推荐的一个执行轨迹例子**：
  - 输入：用户 `const pinia = createPinia(); pinia.use(loggingPlugin); app.use(pinia)`，之后组件里 `useUserStore()`。
  - 关键中间态：loggingPlugin 暂存待装队列 → install 触发 flush → 队列清空、插件入正表 → useUserStore 创建 store → 在该 store 的 scope 里跑 loggingPlugin → 返回 `{ $log }` → assign 到 store。
  - 输出：`useUserStore().$log(...)` 可用，且 store 调 `$dispose()` 时 loggingPlugin 返回的任何 ref 自动失效。

> 以上钩子供 Writer 写「动机→核心思想→心智模型→关键权衡→原理演示」；下面事实部分供核对，不要被 Writer 当目录照抄。

## 概念要点
- 插件本质是一个普通函数 `(context) => extensions | void`，context 含 `{ pinia, app, store, options }`，返回值会被 `assign` 进 store。源码位置: packages/pinia/src/rootStore.ts:162-172
- `pinia._p: PiniaPlugin[]` 是真正的插件表，是 Pinia 实例的字段；`pinia.use(plugin)` 是公开注册入口。源码位置: packages/pinia/src/rootStore.ts:76,83
- 注册分两阶段：未 install 时 push 到局部 `toBeInstalled` 队列；install 时遍历 `toBeInstalled` 一次性灌进 `_p`、清空队列；install 之后 `use` 直接 `_p.push`。源码位置: packages/pinia/src/createPinia.ts:18-45
- 插件被调用的时机：`createSetupStore` 末尾，store 已 reactive 化、state/getter/action 已分类 assign 完毕、`$state` getter/setter 已 defineProperty 完毕、`_hotUpdate` 已挂好之后。源码位置: packages/pinia/src/store.ts:716-754
- 调用插件用 `scope.run(() => extender(...))`，`scope` 就是该 store 在 setup 阶段创建的 `effectScope()`——这让插件返回的 ref/computed 落在 store 自身 scope 里、随 `$dispose()` 一起回收。源码位置: packages/pinia/src/store.ts:500-502, 717-725
- 调用插件时把用户传的 options 复制并 augment 出 `optionsForPlugin`，强制带 `actions: {}` 兜底，让插件能拿到完整 actions 列表。源码位置: packages/pinia/src/store.ts:232-235, 723
- devtools 模式下，插件返回的每个 key 都被加进 `store._customProperties`（一个 `markRaw(new Set<string>())`），供 devtools 识别「哪些属性是用户/插件加的、非 pinia 内置」。源码位置: packages/pinia/src/store.ts:728-732
- dev 模式体检：对插件返回值里每个字段，若它是 object（含 null）、又不是 ref/reactive、又没有 `__v_skip` 标记（markRaw 设置），就触发 `PINIA_R1006`——`storeToRefs()` 会忽略它，提示要么 ref/reactive 化、要么 markRaw。源码位置: packages/pinia/src/store.ts:737-751；诊断文案: packages/pinia/src/diagnostics.ts:38-41
- devtools 自身也是被注册成插件挂载的：createPinia 末尾若 `__USE_DEVTOOLS__ && IS_CLIENT && typeof Proxy !== 'undefined'`，就 `pinia.use(devtoolsPlugin)`——这让生产构建可整段 tree-shake devtools。源码位置: packages/pinia/src/createPinia.ts:56-60
- `disposePinia` 通过 `_p.splice(0)` 清空插件表（与 `_e.stop()`、`_s.clear()`、`state.value = {}` 一起），此后 pinia 不可再用。源码位置: packages/pinia/src/createPinia.ts:72-79
- 类型扩展点：`PiniaCustomProperties` 与 `PiniaCustomStateProperties` 是为 `declare module 'pinia'` 声明合并预留的空 interface，让用户能给「所有 store」加类型化的自定义属性。源码位置: packages/pinia/src/types.ts:521-533
- `_customProperties` 等 4 个内部字段在 devtools 构建下用 `Object.defineProperty` 设为 `enumerable: false`，避免在 devtools 里被当成 store 数据展示。源码位置: packages/pinia/src/store.ts:696-714

## 关键调用链

注册阶段：
```
pinia.use(plugin)
  └─ pinia._a 未设？ → toBeInstalled.push(plugin)
                            （等 app.use(pinia) 时 flush）
     已设？       → _p.push(plugin)
```
源码位置: packages/pinia/src/createPinia.ts:38-45

flush 时机（install 内）：
```
app.use(pinia)
  └─ install(app): setActivePinia + pinia._a = app
                  + provide(piniaSymbol, pinia)
                  + toBeInstalled.forEach(p => _p.push(p))
                  + toBeInstalled = []
```
源码位置: packages/pinia/src/createPinia.ts:22-36

执行阶段（每个 store 构建末尾）：
```
createSetupStore(...)
  ├─ scope = effectScope()           (在 pinia._e 内嵌套)
  ├─ setupStore = pinia._e.run(() => scope.run(() => setup(helpers)))
  ├─ 分类 state/getter/action → assign 到 reactive(partialStore)
  ├─ Object.defineProperty(store, '$state', ...)
  └─ pinia._p.forEach(extender => {
        const extensions = scope.run(() => extender({ store, app, pinia, options }))
        if (__USE_DEVTOOLS__) Object.keys(extensions||{}).forEach(k => store._customProperties.add(k))
        if (__DEV__) 体检 extensions 各字段（非响应式警告）
        assign(store, extensions)
     })
```
源码位置: packages/pinia/src/store.ts:500-502, 716-754

## 源码摘录（带行号，全文累计 ≤ 30 行）

注册与 flush（`createPinia.ts`）：

```ts
22	    install(app: App) {
23	      setActivePinia(pinia)
24	      pinia._a = app
25	      app.provide(piniaSymbol, pinia)
26	      app.config.globalProperties.$pinia = pinia
27	      if (__USE_DEVTOOLS__ && IS_CLIENT) {
28	        registerPiniaDevtools(app, pinia)
29	      }
30	      toBeInstalled.forEach((plugin) => _p.push(plugin))
31	      toBeInstalled = []
32	    },
33	    use(plugin) {
34	      if (!this._a) {
35	        toBeInstalled.push(plugin)
36	      } else {
37	        _p.push(plugin)
38	      }
39	      return this
40	    },
```

store 内调用 + 体检 + assign（`store.ts`）：

```ts
716	  // apply all plugins
717	  pinia._p.forEach((extender) => {
718	    const extensions = scope.run(() =>
719	      extender({
720	        store: store as Store,
721	        app: pinia._a,
722	        pinia,
723	        options: optionsForPlugin,
724	        })
725	    )!
726	    /* istanbul ignore else */
727	    if (__USE_DEVTOOLS__ && IS_CLIENT) {
728	      Object.keys(extensions || {}).forEach((key) =>
729	        store._customProperties.add(key)
730	      )
731	    }
732	    if (__DEV__) {
733	      for (const key in extensions) {
734	        const value = (extensions as any)[key]
735	        if (
736	          typeof value === 'object' &&
737	          !isRef(value) &&
738	          !isReactive(value) &&
739	          !value?.__v_skip
740	        ) {
741	          diagnostics.PINIA_R1006({ key, id: $id })
742	        }
743	      }
744	    }
745	    assign(store, extensions)
746	  })
```

插件签名（`rootStore.ts`）：

```ts
162	  export interface PiniaPlugin {
163	    (
164	      context: PiniaPluginContext
165	    ): Partial<PiniaCustomProperties & PiniaCustomStateProperties> | void
166	  }
```

## 易混淆 / 边界 / 推断
- **事实**：`_p` 是 pinia 实例上的数组、不是 Map，所以同名插件理论上可注册多次；pinia 不去重。源码位置: packages/pinia/src/rootStore.ts:83
- **事实**：调用顺序 = 数组下标顺序 = 注册顺序。后注册的插件返回值会 `assign` 覆盖前一个的同名属性（`Object.assign` 语义）。源码位置: packages/pinia/src/store.ts:717,745
- **推断**：`@pinia/testing` 直接 `_p.push(...)` 而不是 `pinia.use(...)`，正是利用「注册顺序决定覆盖」——push 到数组末尾、确保 stub 插件在最后执行、能覆盖前面所有插件返回的 action。这与「绕开 toBeInstalled 队列」一脉相承。
- **事实**：devtools 插件 `pinia.use(devtoolsPlugin)` 在 `createPinia()` 末尾就被注册，但此时 `_a` 未设、走 `toBeInstalled` 分支；待 `app.use(pinia)` 时与其他待装插件一起 flush。源码位置: packages/pinia/src/createPinia.ts:56-60, 33-35
- **事实**：插件返回值里的 ref/computed 落在 store 的 scope 里——这意味着 `$dispose()`（即 `scope.stop()`）会回收它们；而 markRaw 过的 plain object 不被 scope 跟踪，但仍被 `assign` 到 store 上、随 store 对象本身一起存活。源码位置: packages/pinia/src/store.ts:349-354, 718
- **事实**：插件体检只对 `typeof value === 'object'` 触发——`null` 也命中（`typeof null === 'object'`），但因为是 null、不会触发任何警告分支以外的副作用；函数、原始值（string/number/boolean）不体检、不警告。源码位置: packages/pinia/src/store.ts:737-742
- **事实**：插件 context 里的 `app` 取自 `pinia._a`——如果 useStore 在 install 之外被调用（理论只在 SSR/测试才会），`app` 可能未设；常规场景下 app 一定就绪。源码位置: packages/pinia/src/store.ts:721
- **推断**：`assign` 同时被 reactive 包装的 store 与 toRaw(store) 接收（参见 setup-store-builder 章），但插件返回值的 assign 只对 reactive(store) 一次——结合 `assign(toRaw(store), setupStore)` 的位置（store.ts:578）发生在插件调用之前，可推断插件返回的属性在 toRaw 层面不会被同步——这意味着 storeToRefs 取插件返回的 ref 时，依赖 store 本身 reactive 的字段访问代理，而非 raw 值。这一点需要 Writer 在讲 storeToRefs 章时一并核对。
- **未理解**：体检分支里 `value?.__v_skip` 的语义在源码注释中只写「markRaw 设置」——`__v_skip` 是 vue 内部的「reactive 跳过标记」，由 markRaw 添加；若用户手工给 plain object 加同名 symbol 字段是否会被误判为「已 markRaw」？未在本章源码范围内验证。
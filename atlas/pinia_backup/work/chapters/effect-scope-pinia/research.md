# Pinia 实例：用 effectScope 持有全局状态 · 源码精读

## 给 Writer 的教学钩子（必填，8 子项缺一不可）

- **用户痛点 / 场景**：在组件外管理一堆跨组件长存的响应式状态（典型如全局 store）时，会撞上两个硬问题——这些 ref/computed/watch 的"副作用"归谁所有？当一个 SPA 切到下一个 SSR 请求、或测试结束想清场时，怎么把它们**一次性**释放干净，而不是挨个 unwatch？没有 effectScope 这个容器，只能手动记账、或者重启整个 app。

- **一句话核心思想**：用一个**可整体 stop 的作用域**当所有 store 响应式的"业主"，把挂载、回收、组件外访问全收束到一个 pinia 实例上。

- **设计动机（为什么需要它）**：Vue 的响应式默认是"谁创建谁负责"，组件 scope 自动回收自己的 effect。但 Pinia 的 store **不是组件**——它要 (1) 跨组件长存、(2) 可整体销毁以便测试和多实例应用、(3) 在 setup 之外被普通 JS 模块调用、(4) 通过 `app.use()` 接入 Vue 应用上下文。effectScope + 单例 `activePinia` 这对组合就是为了**一次性满足这四点**而设计的承载层。

- **关键权衡（5 条）**：
  1. **detached effectScope 当根业主**：`effectScope(true)` 创建脱离任何组件 scope 的根作用域作为 `_e` → 换来了 store 的响应式效果不被任何组件拥有、能在组件销毁后继续存活、且 `disposePinia` 时一次 `_e.stop()` 释放全部 → 代价是 Pinia 必须**自己**管理生命周期，使用者忘记 dispose 就会泄漏（多 pinia 实例的测试场景常见）。
  2. **模块级单例 `activePinia` 兜底**：用一个 `let activePinia` 全局变量 → 换来了"组件外/普通 JS 模块里 useStore()"无需 inject 也能拿到当前实例，让 SSR 的 `fetch`、router guard、axios 拦截器等场景写起来极简 → 代价是**服务端多请求并发会共享同一个全局**，必须每请求开始 `setActivePinia(本请求的 pinia)`、结束后 `setActivePinia(undefined)`，否则就是跨请求数据污染——这正是 PINIA_R1004 警告的根因。
  3. **inject 与 activePinia 双轨查找**：`getActivePinia` 优先 `inject(piniaSymbol)`、inject 落空才 fallback 到 `activePinia` → 换来了"组件内能拿到准确的本 app pinia"+"组件外仍有全局兜底" → 代价是 prod 模式下若 inject 落空会**无声**回退到全局，可能拿到错的实例（dev 才会显式 R1004 报错提醒）。
  4. **markRaw(pinia 实例) + state 是 ref 但实例本身不是 reactive** → 换来了 pinia 实例不会被任何外层 reactive 系统重新代理、避免循环依赖和额外开销 → 代价是 devtools 等工具想观察 pinia 自身时需要走 `_a`、`state.value` 等内部字段，而非直接观察实例。
  5. **`toBeInstalled` 队列 + `use(plugin)` 时序分流**：插件在 `app.use(pinia)` 之前调 `pinia.use` 进队列、install 时统一 drain 进 `_p`；install 之后则直接 push `_p` → 换来了"插件可在 createPinia 之后、app.use 之前任意时刻注册"的灵活时序 → 代价是多一份队列状态、且 install 那一刻必须立刻 flush（否则 devtools 等迟到插件就漏挂了）。

- **最小心智模型（7 步）**：
  1. `createPinia()` → 创建一个 detached effectScope（即 `_e`）。
  2. 在 `_e.run(...)` 内部创建一个空 root state 的 `ref({})` → 这个 ref 的响应式效果归属 `_e`。
  3. 把 `_e` / `state` / `_s`(store 注册表 Map) / `_p`(插件数组) 塞进一个 markRaw 的对象 → 这就是 Pinia 实例。
  4. `app.use(pinia)` 触发 `install`：`setActivePinia(pinia)` + `app.provide(piniaSymbol, pinia)` + 把 `toBeInstalled` 推进 `_p`。
  5. 后续每个 store 在自己的子 effectScope 里跑 setup，而那个子 scope 创建于 `pinia._e.run(...)` 之内 → 自动成为 `_e` 的子节点（父子 scope 关系由 Vue 内部维护）。
  6. 组件外 `useStore()` 调用 → `getActivePinia()` 先试 inject、否则用全局 `activePinia` 兜底。
  7. `disposePinia(pinia)` → `_e.stop()` 一刀切，所有 store 的 ref/computed/watch 全部释放，再清 `_s`/`_p`/state。

- **最小原理演示**：
  - **应演示**：一个 ~40 行的从零脚本，演"effectScope 当 store 容器 + 模块级单例 activeStore + dispose 释放"——这是本章核心思想的最纯表达。每一行都要对应上面某条权衡：detached scope（→权衡 1）、模块级单例（→权衡 2）、stop 一刀切（→权衡 1）。
  - **应故意省略**：插件 `_p` / `toBeInstalled` 队列（→权衡 5 略复杂、可在正文文字补充即可）、devtools、真实 Vue provide/inject（演示里用全局单例足够说明问题）、Map 注册表（属下一章）。
  - **演示载体建议**：TS/JS 脚本，可 `bun run` 或 `node` 直接跑（借 vue 的 `effectScope`/`ref`/`computed`）。本章机制完全可独立运行、不依赖组件树，是最适合"能跑的极简脚本"的章节之一。
  - 演示骨架（Writer 据此扩写）：
    ```js
    import { effectScope, ref, computed } from 'vue'
    let activeStore
    const setActiveStore = (s) => (activeStore = s)
    function createStore(setup) {
      const scope = effectScope(true)         // detached
      const api = scope.run(() => setup())    // ref/computed 全归 scope
      api._scope = scope
      setActiveStore(api)
      return api
    }
    const counter = createStore(() => {
      const count = ref(0)
      const double = computed(() => count.value * 2)
      return { count, double, inc() { count.value++ } }
    })
    counter.inc(); console.log(counter.double.value) // 2
    counter._scope.stop()                              // 一刀释放
    ```

- **正文不宜展开的细节**：`markRaw` 防重代理的具体机制、`__USE_DEVTOOLS__` 条件编译开关、`diagnostics`/nostics 的诊断框架、`app.config.globalProperties.$pinia` 的 Options API 接入路径、`Symbol('pinia')`（dev 带描述）与 `Symbol()`（prod 无描述）的差异、`hasInjectionContext` 的 Vue 版本兼容意义。

- **推荐的一个执行轨迹例子**：
  - 输入：`const pinia = createPinia()` → `app.use(pinia)` → 某模块顶层 `useCounterStore()`
  - 关键中间态：
    - createPinia 后：`_e` 是 active detached scope、`state.value === {}`、`activePinia === undefined`、`_a === null`。
    - install 后：`pinia._a === app`、`app._context.provides[piniaSymbol] === pinia`、`activePinia === pinia`、`toBeInstalled === []`、`_p` 含 devtoolsPlugin（仅 dev+client）。
    - useCounterStore()：getActivePinia() 命中 activePinia → 在 `pinia._e.run` 内创建子 scope 跑 setup，store 注册进 `_s`。
  - 输出：store 实例；调用 `disposePinia(pinia)` 时 `_e.stop()` 释放所有 store 响应式开销。

> 以上钩子供 Writer 写「动机 → 核心思想 → 心智模型 → 关键权衡 → 原理演示」；下面事实部分供核对，不要被 Writer 当目录照抄。

## 概念要点

- **detached effectScope 作为 pinia 的"业主"**：`createPinia` 第一行就用 `effectScope(true)` 创建一个**显式脱离组件树**的 scope，所有 store 的响应式效果（ref/computed/watch）都归属于它，从而可以被一次性 `stop()`。源码位置: packages/pinia/src/createPinia.ts:11
- **root state 在 scope 内创建**：`ref({})` 不是直接声明，而是用 `scope.run(() => ref(...))` 包起来——这一步把 state 的响应式记账到 `_e` 上，与 scope 绑定。源码位置: packages/pinia/src/createPinia.ts:14-16
- **pinia 实例本身用 markRaw 包裹**：整个 `{ install, use, _p, _a, _e, _s, state }` 对象被 `markRaw`，避免被外层 reactive 系统二次代理。源码位置: packages/pinia/src/createPinia.ts:22
- **install 的四件事**：set activePinia、记 app、provide、注入 `$pinia` 全局属性；之后才 flush `toBeInstalled`。源码位置: packages/pinia/src/createPinia.ts:23-36
- **`use` 的时序分流**：install 前 push 到 `toBeInstalled` 队列、install 后直接 push `_p`；这条分支决定了插件注册顺序与可见性。源码位置: packages/pinia/src/createPinia.ts:38-45
- **dev+client 自动挂 devtoolsPlugin**：`createPinia` 末尾的 `pinia.use(devtoolsPlugin)` 让 devtools 复用插件机制，prod 自动 tree-shake。源码位置: packages/pinia/src/createPinia.ts:58-60
- **disposePinia 一刀切**：`_e.stop()` → `_s.clear()` → `_p.splice(0)` → `state.value = {}` → `_a = null`。`_e.stop()` 会递归停掉所有子 scope（即每个 store 的 scope）。源码位置: packages/pinia/src/createPinia.ts:72-79
- **`activePinia` 是模块级 let 变量**：单例、跨整个 pinia 模块共享；`setActivePinia` 只是赋值。源码位置: packages/pinia/src/rootStore.ts:27-36
- **双轨 getActivePinia**：dev 路径优先 `hasInjectionContext() && inject(piniaSymbol)`、若两路都失败且非客户端则报 PINIA_R1004；prod 路径去掉诊断，纯逻辑或。源码位置: packages/pinia/src/rootStore.ts:47-58
- **`piniaSymbol` 是 InjectionKey**：dev 用 `Symbol('pinia')` 带描述、prod 用 `Symbol()` 省字节。源码位置: packages/pinia/src/rootStore.ts:125-127
- **Pinia 接口的内部字段**：`_p`(插件)、`_a`(关联 app)、`_e`(effectScope)、`_s`(store 注册表 Map)、`state`(根 ref)；这些下划线字段就是 chapter 后续（store 注册表、插件系统）的承载点。源码位置: packages/pinia/src/rootStore.ts:63-112
- **store 的子 scope 在 `_e` 内创建（佐证父子关系）**：`pinia._e.run(() => (scope = effectScope()).run(() => setup(...)))` —— store 自己的 scope 是 `_e.run` 闭包里诞生的，自然成为 `_e` 的子 scope；这就是 `_e.stop()` 能级联释放所有 store 的根因。源码位置: packages/pinia/src/store.ts:501

## 关键调用链

createPinia() → effectScope(true) → scope.run(() => ref({})) → markRaw({install, use, _e, _s, _p, state})

app.use(pinia) → pinia.install(app) → setActivePinia(pinia) + app.provide(piniaSymbol) + globalProperties.$pinia = pinia + flush toBeInstalled → _p

组件外 useStore() → getActivePinia() → hasInjectionContext ? inject(piniaSymbol) : activePinia → pinia._e.run(() => effectScope().run(setup)) → store 注册进 _s

disposePinia(pinia) → pinia._e.stop()（级联停掉所有 store 子 scope） → _s.clear() → _p.splice(0) → state.value = {} → _a = null

源码位置: packages/pinia/src/createPinia.ts:10-16, 22-45, 72-79；packages/pinia/src/rootStore.ts:27-58；packages/pinia/src/store.ts:501

## 源码摘录（带行号，全文累计 ≤ 30 行）

createPinia 的核心（创建 detached scope、把 state 装进去、组装实例）：
```ts
// packages/pinia/src/createPinia.ts:10-22
export function createPinia(): Pinia {
  const scope = effectScope(true)
  const state = scope.run<Ref<Record<string, StateTree>>>(() =>
    ref<Record<string, StateTree>>({})
  )!
  let _p: Pinia['_p'] = []
  let toBeInstalled: PiniaPlugin[] = []
  const pinia: Pinia = markRaw({
    install(app: App) {
      setActivePinia(pinia)
      pinia._a = app
      app.provide(piniaSymbol, pinia)
      app.config.globalProperties.$pinia = pinia
```

disposePinia 的释放顺序（先停 scope 再清表）：
```ts
// packages/pinia/src/createPinia.ts:72-79
export function disposePinia(pinia: Pinia) {
  pinia._e.stop()
  pinia._s.clear()
  pinia._p.splice(0)
  pinia.state.value = {}
  // @ts-expect-error: non valid
  pinia._a = null
}
```

getActivePinia 的双轨查找与 SSR 警告：
```ts
// packages/pinia/src/rootStore.ts:47-58
export const getActivePinia = __DEV__
  ? (): Pinia | undefined => {
      const pinia = hasInjectionContext() && inject(piniaSymbol)
      if (!pinia && !IS_CLIENT) {
        diagnostics.PINIA_R1004({}, { method: 'error' })
      }
      return pinia || activePinia
    }
  : (): Pinia | undefined =>
      (hasInjectionContext() && inject(piniaSymbol)) || activePinia
```

## 易混淆 / 边界 / 推断

- **事实**：`effectScope(true)` 的 `true` 表示 detached（脱离当前父作用域捕获）。源码位置: packages/pinia/src/createPinia.ts:11
- **事实**：`state` 用 `scope.run<...>(() => ref<...>({}))!` 创建——非空断言是因为 `scope.run` 的返回类型不保证非空。源码位置: packages/pinia/src/createPinia.ts:14-16
- **事实**：`_a: null` 字段在 `markRaw({...})` 内是 `@ts-expect-error`，因为类型上 `_a: App` 不能为 null，但运行时初始化阶段确实未定。源码位置: packages/pinia/src/createPinia.ts:48-50
- **推断**：`toBeInstalled` 队列存在的原因是——插件可能在 `createPinia` 之后立即注册（此时 `app.use` 尚未调用、`_a` 为 null），所以先暂存；install 时统一灌进 `_p` 让 store 创建时能遍历到全部插件。源码位置: packages/pinia/src/createPinia.ts:20, 34-35, 38-45
- **推断**：dev 路径下 `getActivePinia` 在 SSR（`!IS_CLIENT`）且 inject 落空时主动报 R1004，是为了在用户写出"组件外 useStore 但忘了 setActivePinia"时立刻炸出来，避免后续 store 写到上一个请求的 pinia 上造成跨请求污染。源码位置: packages/pinia/src/rootStore.ts:51-53；packages/pinia/src/diagnostics.ts:28-32
- **推断（标注为推断）**：`Symbol('pinia')` vs `Symbol()` 在 dev/prod 的差异，主要是 prod 省描述字符串以减小体积、并避免泄漏内部命名；同时也是内部 API（`@internal` 注释、issue #870/#2973 提到 storybook 等边界场景才会用到）。源码位置: packages/pinia/src/rootStore.ts:114-127
- **未理解**：`getActivePinia` 在 dev 路径下若 inject 落空但 IS_CLIENT 为 true，**不**报 R1004 而是直接 fallback 到 `activePinia`——猜测原因是 SPA 客户端单例 activePinia 通常就是正确实例、报错噪音大于收益；但若客户端有多 pinia 实例（如测试），fallback 到全局可能拿到错的实例（这一边界本章源码未直接覆盖，需结合 store.ts 的 useStore 实现进一步确认）。
# Pinia 根实例与活跃上下文 · 源码精读

> 本章 sourceFiles：`packages/pinia/src/createPinia.ts`、`packages/pinia/src/rootStore.ts`（root = `work/source`）。
> 依赖章 `core-types`：大量类型（`Pinia`/`PiniaPlugin`/`StateTree`/`StoreGeneric` 等）来自 `./types`。

## 概念要点

### 1. `createPinia()` 的产物结构：一个被 markRaw 包裹的字面量对象
`createPinia()` 返回的 `Pinia` 实例**不是 class 实例**，而是一个用 `markRaw({...})` 包裹的对象字面量。`markRaw` 标记该对象「永不响应式化」——避免 pinia 实例本身被 Vue 追踪（否则 store 互相引用 pinia 时会形成不必要的响应式依赖图）。
源码位置: packages/pinia/src/createPinia.ts:22

实例装配了以下字段，与 `Pinia` 接口一一对应：
- `install(app)`：Vue 插件安装钩子（line 23-36）
- `use(plugin)`：注册插件，返回 `this` 以支持链式（line 38-45）
- `_p`：已安装插件数组 `PiniaPlugin[]`（line 47）
- `_a`：关联的 Vue `App`，初始为 `null`（line 49-50，`@ts-expect-error` 因为类型声明非空但此处占位为 null）
- `_e`：挂载的 `EffectScope`（line 51）
- `_s`：store 注册表 `new Map<string, StoreGeneric>()`（line 52）
- `state`：根 state，`Ref<Record<string, StateTree>>`（line 53）

源码位置: packages/pinia/src/createPinia.ts:22-54

### 2. 根 state 由 detached effectScope 持有
`createPinia` 第一步创建 `scope = effectScope(true)`。参数 `true` 表示这是一个 **detached（脱离）** 的 effectScope——它不会跟随任何父 scope 自动释放，必须显式 `.stop()`（这正是 `disposePinia` 的职责）。

根 `state` 在该 scope 内创建：`scope.run<Ref<...>>(() => ref<Record<string, StateTree>>({}))`，末尾的 `!` 断言返回非空。这样根 state 及其后续派生的所有响应式 effect 都归属该 scope，便于一次性统一回收。
源码位置: packages/pinia/src/createPinia.ts:11-16

紧随其后有一段设计意图注释（代码字面保留）：
```ts
// NOTE: here we could check the window object for a state and directly set it
// if there is anything like it with Vue 3 SSR
```
表明作者预留了「从 window 读取 SSR 注入的 state 直接回灌」的思路（推断：属设计备忘，当前未实现具体逻辑）。
源码位置: packages/pinia/src/createPinia.ts:12-13

### 3. 插件双队列：`_p`（已安装）与 `toBeInstalled`（暂存）
这是 plugin 注册时序的关键设计。存在两个数组：
- `_p: Pinia['_p'] = []`：真正「已安装」的插件，会在每次创建 store 时被遍历应用。
- `toBeInstalled: PiniaPlugin[] = []`：在 `app.use(pinia)` **之前**通过 `pinia.use(plugin)` 注册的插件的暂存区。

`use(plugin)` 的分支逻辑：
```ts
use(plugin) {
  if (!this._a) {        // 还没 install（_a 仍为 null）
    toBeInstalled.push(plugin)
  } else {               // 已 install
    _p.push(plugin)
  }
  return this
}
```
源码位置: packages/pinia/src/createPinia.ts:18-20, 38-45

在 `install(app)` 执行时（即 `app.use(pinia)` 被调用），会把暂存队列 flush 进 `_p`：
```ts
toBeInstalled.forEach((plugin) => _p.push(plugin))
toBeInstalled = []
```
源码位置: packages/pinia/src/createPinia.ts:34-35

**易混淆点（Writer 需讲清）**：为何要双队列？因为 `createPinia` 末尾会自动 `pinia.use(devtoolsPlugin)`（见要点 4），此刻 `app.use(pinia)` 尚未发生、`_a` 为 null，devtoolsPlugin 必须先进 `toBeInstalled`；等真正 install 时再统一进入 `_p`，保证「所有插件在首个 store 创建前都已就位」。

### 4. devtools 的双重接入点
devtools 通过两条路径接入，条件均为 `__USE_DEVTOOLS__ && IS_CLIENT`：
1. **install 内**：`registerPiniaDevtools(app, pinia)`——注册 devtools 的时间线/inspector（随 app 安装触发）。
   源码位置: packages/pinia/src/createPinia.ts:30-33
2. **createPinia 末尾**：`pinia.use(devtoolsPlugin)`——把 devtools 作为**普通 Pinia 插件**注册，使其在每个 store 创建时收到 `PiniaPluginContext`。额外条件 `typeof Proxy !== 'undefined'`（注释说明 devtools 依赖 dev 版 Vue 特性，且避免 IE11 等无 Proxy 的旧浏览器）。
   源码位置: packages/pinia/src/createPinia.ts:56-60

### 5. `install(app)`：插件安装钩子的副作用
`install` 是 Vue 插件协议要求的方法，`app.use(pinia)` 时被调用，依次完成：
```ts
setActivePinia(pinia)                      // 1. 设为全局活跃实例
pinia._a = app                             // 2. 关联 app
app.provide(piniaSymbol, pinia)            // 3. 注入符号提供 pinia
app.config.globalProperties.$pinia = pinia // 4. Options API 全局属性 $pinia
if (__USE_DEVTOOLS__ && IS_CLIENT) registerPiniaDevtools(app, pinia) // 5. devtools
toBeInstalled.forEach((p) => _p.push(p)); toBeInstalled = []         // 6. flush 插件
```
注释指出：步骤 1 的 `setActivePinia` 使「在 install 之后、组件 setup 之外」也能调用 `useStore()`。
源码位置: packages/pinia/src/createPinia.ts:23-36

### 6. `disposePinia(pinia)`：一次性销毁
显式释放 pinia 持有的全部资源（注释：主要用于测试、多 pinia 实例应用；dispose 后实例不可再用）：
```ts
pinia._e.stop()        // 停止 effectScope → 释放所有 store 的响应式 effect
pinia._s.clear()       // 清空 store 注册表
pinia._p.splice(0)     // 清空插件数组
pinia.state.value = {} // 重置根 state
pinia._a = null        // 解除 app 关联（@ts-expect-error）
```
源码位置: packages/pinia/src/createPinia.ts:65-79

### 7. `Pinia` 接口（rootStore.ts 中定义）
`Pinia` 接口是对上述实例的契约声明，关键字段含义：
- `state: Ref<Record<string, StateTree>>`——根 state，key 为 store id。
- `use(plugin): Pinia`——注册插件，返回自身以链式。
- `_p: PiniaPlugin[]` / `_a: App` / `_e: EffectScope` / `_s: Map<string, StoreGeneric>`——均标注 `@internal`，是 createPinia 内部状态的对外暴露，供 store 装配管线（store-definition 章）读取。
- `_testing?: boolean`——注释明确：由 `createTestingPinia()` 添加，用于 **bypass `useStore(pinia)`**（关联 testing 章）。

源码位置: packages/pinia/src/rootStore.ts:60-112

### 8. 全局活跃实例：`activePinia` + `setActivePinia`
`activePinia` 是一个**模块级**可变变量 `export let activePinia: Pinia | undefined`。`setActivePinia` 仅做赋值 `activePinia = pinia`，通过重载类型 `_SetActivePinia` 约束返回值（传 `Pinia` 返 `Pinia`，传 `undefined` 返 `undefined`）。

注释强调：`setActivePinia` 必须在 SSR 顶部函数（`fetch`/`setup`/`serverPrefetch` 等）中调用以处理 SSR。
源码位置: packages/pinia/src/rootStore.ts:23-42

### 9. `getActivePinia`：注入优先、全局兜底（SSR 安全核心）
这是本章对 SSR 隔离最关键的 API，分 dev/prod 两套实现：

**dev 版**：
```ts
(): Pinia | undefined => {
  const pinia = hasInjectionContext() && inject(piniaSymbol)
  if (!pinia && !IS_CLIENT) {
    diagnostics.PINIA_R1004({}, { method: 'error' })  // SSR 下报错
  }
  return pinia || activePinia
}
```
**prod 版**（无诊断，更精简）：
```ts
(): Pinia | undefined =>
  (hasInjectionContext() && inject(piniaSymbol)) || activePinia
```
源码位置: packages/pinia/src/rootStore.ts:44-58

要点：
- **优先**通过 `hasInjectionContext()` 判定是否处于组件注入上下文，是则 `inject(piniaSymbol)` 拿请求级 pinia；**兜底**才用模块级 `activePinia`。
- 在 SSR（`!IS_CLIENT`）且注入上下文取不到 pinia 时，dev 版触发 `PINIA_R1004` 诊断（method 为 `'error'`）。该诊断的 `why` 字面为：「Pinia instance not found in context. This falls back to the global activePinia, which exposes you to **cross-request pollution** on the server.」——即警告：回退到全局单例会在服务端造成**跨请求污染**。
  源码位置: packages/pinia/src/diagnostics.ts:28-31（属关联引用，非本章 sourceFile）

**设计意图（推断，供 Writer 参考）**：`inject` 走的是「当前 app/请求」的注入上下文，天然请求隔离；而模块级 `activePinia` 是单例，多请求并发时不安全。所以 getActivePinia 刻意「inject 优先」来降低 SSR 误用风险，并在 dev 下主动告警。

### 10. `piniaSymbol`：provide/inject 的注入键
```ts
export const piniaSymbol = (
  __DEV__ ? Symbol('pinia') : Symbol()
) as InjectionKey<Pinia>
```
- dev 下用 `Symbol('pinia')`（带描述便于调试），prod 下用匿名 `Symbol()`。
- 类型断言为 `InjectionKey<Pinia>`，使 `provide`/`inject` 类型安全。
- 注释标注 `@internal`，并警示「minor 版本可能 break，USE AT YOUR OWN RISK」，给出 issue #870 与 PR #2973 上下文链接，说明它仅供内部、测试与 storybook 等边缘场景。

源码位置: packages/pinia/src/rootStore.ts:114-127

### 11. `PiniaPluginContext` 与 `PiniaPlugin`：插件契约
- `PiniaPluginContext<Id, S, G, A>`：传给插件的上下文，含 `pinia`、`app`、`store`、`options: DefineStoreOptionsInPlugin<...>`。这是 store 装配时（store-definition 章）调用每个 `_p` 插件时传入的参数结构。
  源码位置: packages/pinia/src/rootStore.ts:129-157
- `PiniaPlugin`：函数类型 `(context) => Partial<PiniaCustomProperties & PiniaCustomStateProperties> | void`——插件可返回一个对象来扩展 store 的属性与 state（返回值会被合并进 store）。
  源码位置: packages/pinia/src/rootStore.ts:159-172

## 关键调用链

**实例创建与安装**
```
createPinia()
  → effectScope(true)                         // detached scope（detached：需显式 stop）
  → scope.run(() => ref<Record<string,StateTree>>({}))  // 根 state 归属 scope
  → markRaw({ install, use, _p, _a, _e, _s, state })    // 组装实例
  → pinia.use(devtoolsPlugin)                 // 进 toBeInstalled（_a 仍为 null）

app.use(pinia) → install(app)
  → setActivePinia(pinia)                     // 设全局活跃
  → app.provide(piniaSymbol, pinia)           // 注入键
  → app.config.globalProperties.$pinia = pinia
  → registerPiniaDevtools(app, pinia)         // devtools 时间线（dev+client）
  → toBeInstalled → _p（flush）               // 含 devtoolsPlugin 在内的暂存插件就位
```
源码位置: packages/pinia/src/createPinia.ts:10-62

**取活跃实例（SSR 关键）**
```
getActivePinia()
  → hasInjectionContext() ? inject(piniaSymbol) : false   // 请求级优先
  → 命中则返回注入的 pinia
  → 否则（dev + SSR）触发 PINIA_R1004，返回模块级 activePinia   // 兜底（不安全）
```
源码位置: packages/pinia/src/rootStore.ts:47-58

**销毁**
```
disposePinia(pinia) → _e.stop() → _s.clear() → _p.splice(0) → state.value={} → _a=null
```
源码位置: packages/pinia/src/createPinia.ts:72-79

## 源码摘录（带行号）

createPinia.ts 核心（实例装配）：
```ts
// packages/pinia/src/createPinia.ts:10-63
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
      if (__USE_DEVTOOLS__ && IS_CLIENT) {
        registerPiniaDevtools(app, pinia)
      }
      toBeInstalled.forEach((plugin) => _p.push(plugin))
      toBeInstalled = []
    },
    use(plugin) {
      if (!this._a) toBeInstalled.push(plugin)
      else _p.push(plugin)
      return this
    },
    _p,
    _a: null,
    _e: scope,
    _s: new Map<string, StoreGeneric>(),
    state,
  })

  if (__USE_DEVTOOLS__ && IS_CLIENT && typeof Proxy !== 'undefined') {
    pinia.use(devtoolsPlugin)
  }
  return pinia
}
```

rootStore.ts 核心（活跃上下文与 Pinia 接口）：
```ts
// packages/pinia/src/rootStore.ts:27-58
export let activePinia: Pinia | undefined

// @ts-expect-error: cannot constrain the type of the return
export const setActivePinia: _SetActivePinia = (pinia) => (activePinia = pinia)

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

## 易混淆 / 需 Writer 注意

1. **`_p` vs `toBeInstalled` 双队列**：务必讲清「install 前 use 的插件先进暂存区，install 时才 flush 进 `_p`」的时序，这是 devtoolsPlugin 能在 `createPinia` 末尾就 `use`、却仍晚于 `app.use(pinia)` 生效的原因。源码位置: createPinia.ts:18-20,38-45,56-60。

2. **`effectScope(true)` 的 detached 含义**：`true` = detached，不会被父 scope 自动回收；这是「pinia 的响应式可被 `disposePinia` 一次性 `.stop()` 回收」的前提。Writer 讲 disposePinia 时必须关联此处。源码位置: createPinia.ts:11,73。

3. **`getActivePinia` 的 inject 优先策略是 SSR 隔离的核心**：不要写成「就是返回全局 activePinia」。它在组件注入上下文内优先 `inject(piniaSymbol)`（请求级隔离），仅在拿不到时才回退模块级 `activePinia`（单例，SSR 不安全），并在 dev+SSR 主动报 PINIA_R1004。源码位置: rootStore.ts:47-58；诊断文案: diagnostics.ts:28-31。

4. **`markRaw` 不可省略**：pinia 实例本身被 markRaw，避免被响应式追踪；否则 store 间引用 pinia 会污染响应图。源码位置: createPinia.ts:22。

5. **`_a` 初始为 null 但接口声明为 `App`**：故用 `@ts-expect-error` 占位（line 49）。`use(plugin)` 正是用 `!this._a` 判断「是否已 install」来路由插件队列，这是一个把「app 是否已绑定」当安装状态标志的惯用法。源码位置: createPinia.ts:39,49-50。

6. **`_testing` 字段的下游用途**：本文件只声明，注释说明由 `createTestingPinia()` 设置以 bypass 显式 `useStore(pinia)`；具体行为在 testing 章（store 创建管线读取它）。本章点到为止即可。源码位置: rootStore.ts:106-111。

7. **`piniaSymbol` 的稳定性承诺**：标 `@internal` 且「minor 可能 break」，Writer 若提及用户直接 inject piniaSymbol（如 storybook）应提示风险。源码位置: rootStore.ts:114-127。

8. 未理解 / 需后续章节印证：`install` 中注释提到「可检查 window 的 state 直接回灌 SSR」（createPinia.ts:12-13）仅为 NOTE，当前 `createPinia` 未实现该逻辑；实际 SSR state 回灌发生在 nuxt 运行时插件（见 nuxt-module 章），本章不应断言此处已实现。
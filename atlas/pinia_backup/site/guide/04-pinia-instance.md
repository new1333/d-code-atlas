---
title: Pinia 根实例与活跃上下文
---

# Pinia 根实例与活跃上下文

> **本章定位**：`composite` 层，依赖前置章 [[core-types]]（`StateTree`/`StoreGeneric`/`PiniaPlugin` 等类型契约）。
> **源码**：`packages/pinia/src/createPinia.ts`、`packages/pinia/src/rootStore.ts`。
> **被依赖**：`store-definition`（store 装配管线要读取根实例的 `_s`/`_p`/`_a`/`_e`）、`hmr`、`devtools`、`nuxt-module`、`testing` 都从这里开始。

源码里有一句注释定下了本章基调：

```
// rootStore.ts:60-61
// Every application must own its own pinia to be able to create stores
```

每个 Vue 应用都要「拥有」一个属于自己的 pinia 实例。本章只回答两个问题：

1. **这个实例长什么样？它把哪些资源「攥」在自己手里？**
2. **store 创建时，怎么拿到「当前活跃」的那个实例——并且在 SSR 下做到请求隔离？**

下面自底向上：先看实例怎么造出来、攥住什么，再看它怎么被安装与发现，最后给一份可亲手运行的最小复刻。

---

## 一、实例不是 class，是一个被 `markRaw` 包裹的字面量

`createPinia()` 返回的不是一个 `new` 出来的对象，而是一个**对象字面量**，外面套了一层 `markRaw`：

```ts
// createPinia.ts:22-54
const pinia: Pinia = markRaw({
  install(app: App) { /* …见第三节… */ },
  use(plugin) { /* …见第四节… */ },
  _p,                                  // 已安装插件数组
  // @ts-expect-error
  _a: null,                            // 关联的 Vue App（此刻占位为 null）
  _e: scope,                           // effectScope
  _s: new Map<string, StoreGeneric>(), // store 注册表
  state,                               // 根 state
})
```

`markRaw` 给这个对象打上「永不响应式化」的标记。为什么要这么做？因为 store 内部会反过来引用 pinia 实例；若 pinia 本身是响应式的，store 之间经由 pinia 互相引用时，就会在 Vue 的依赖图里织出一张本不该存在的响应式网。`markRaw` 从根上掐断了这条路径。

> **易混淆点**：被 `markRaw` 的只是 pinia 实例本身；它持有的 `state`（根 state）和各个 store 仍是正常的响应式数据。响应式发生在「内容」上，不在「容器」上。

实例上共 7 个字段，与 `Pinia` 接口（rootStore.ts:63-112）一一对应：

| 字段 | 类型 | 含义 |
|------|------|------|
| `install(app)` | 方法 | Vue 插件安装钩子（`app.use(pinia)` 时触发） |
| `use(plugin)` | 方法 | 注册插件，返回 `this` 支持链式 |
| `_p` | `PiniaPlugin[]` | **已安装**插件，创建 store 时逐个应用 |
| `_a` | `App` | 关联的 Vue `App`（初始 `null`） |
| `_e` | `EffectScope` | 持有响应式资源的 scope |
| `_s` | `Map<string, StoreGeneric>` | store 注册表（key = store id） |
| `state` | `Ref<Record<string, StateTree>>` | 根 state（key = store id） |

其中 `_p/_a/_e/_s` 在接口里都标了 `@internal`——它们纯粹为了让 `store-definition` 那条装配管线能读得到。`_p` 里装的是 `PiniaPlugin`：一个**可返回对象的函数** `(context: PiniaPluginContext) => Partial<...> | void`，返回值会被合并进 store（rootStore.ts:129-172）。具体「逐个应用插件」的循环在 [[store-definition]] 章，本章只确立形状。

---

## 二、资源持有的根基：一个 detached 的 effectScope

7 个字段里，最关键的设计藏在 `state` 是怎么来的。`createPinia` 第一件事不是组装对象，而是先开一个 scope：

```ts
// createPinia.ts:11-16
const scope = effectScope(true)   // true = detached（脱离）
// NOTE: here we could check the window object for a state and directly set it
// if there is anything like it with Vue 3 SSR
const state = scope.run<Ref<Record<string, StateTree>>>(() =>
  ref<Record<string, StateTree>>({})
)!
```

两个细节决定了整个生命周期的形状：

**① `effectScope(true)` 的 `true` 表示 detached（脱离）。** 普通 scope 会挂在「当前父 scope」上随父 scope 一起被回收；detached scope 不跟随任何父级，**必须由你显式 `.stop()` 才会释放**。这正是后面 `disposePinia` 能「一键回收全部响应式资源」的前提。

**② 根 `state` 在该 scope 内创建。** `scope.run(() => ref(...))` 把 `ref` 的创建放进 scope，于是根 state 及其后续派生的所有响应式 effect（每个 store 的 computed、watch 等）全都归属这个 scope。一个 scope = 一份可整体回收的响应式资源包。

> 那两行 `NOTE`（createPinia.ts:12-13）只是作者的设计备忘——「SSR 时也许可以从 `window` 直接回灌 state」。当前 `createPinia` 并未实现这套逻辑，真正的 SSR state 序列化/回灌发生在 nuxt 运行时（见 [[nuxt-module]] 章）。

`scope` 随后赋给 `_e`，`state` 赋给 `state` 字段。至此实例已「攥住」两样核心资源：**一个可整体回收的 effectScope，和挂在它下面的根 state。**

---

## 三、安装时序：`install(app)` 的 6 步副作用链

光造出实例还不够——此刻 `_a` 还是 `null`、还没和任何 Vue 应用绑定。真正的「接线」发生在 `app.use(pinia)` 时，Vue 会调用 `pinia.install(app)`：

```ts
// createPinia.ts:23-36
install(app: App) {
  setActivePinia(pinia)                                    // 1️⃣ 设为全局活跃实例
  pinia._a = app                                           // 2️⃣ 关联 app（_a: null → app）
  app.provide(piniaSymbol, pinia)                          // 3️⃣ 注入符号：provide pinia
  app.config.globalProperties.$pinia = pinia               // 4️⃣ Options API 全局属性
  /* istanbul ignore else */
  if (__USE_DEVTOOLS__ && IS_CLIENT) {                     // 5️⃣ devtools（dev + client 才接）
    registerPiniaDevtools(app, pinia)
  }
  toBeInstalled.forEach((plugin) => _p.push(plugin))       // 6️⃣ flush 暂存插件进 _p
  toBeInstalled = []
},
```

步骤 1 的注释点明意图：「this allows calling `useStore()` outside of a component setup after installing pinia's plugin」。步骤 3 的 `provide(piniaSymbol, ...)` 则为后面「inject 优先」的发现机制铺好了路（见第五节）。

把前几节串起来，实例从创建到可用的完整链路是：

```
createPinia()
  → effectScope(true)                          // detached scope
  → scope.run(() => ref({}))                   // 根 state 归属 scope
  → markRaw({ install, use, _p, _a, _e, _s, state })  // 组装实例
  → pinia.use(devtoolsPlugin)                  // _a 仍为 null → 进 toBeInstalled

app.use(pinia) → install(app)
  → setActivePinia(pinia)                      // 全局活跃
  → provide(piniaSymbol, pinia)                // 注入键（发现机制的地基）
  → registerPiniaDevtools(app, pinia)          // devtools 时间线
  → toBeInstalled → _p（flush）                // 暂存插件就位
```
源码：createPinia.ts:10-62。

---

## 四、插件双队列：`_p` 与 `toBeInstalled`

这是本章最容易看走眼的一处设计。注册插件时其实有**两个**数组：

- `_p`：真正「已安装」的插件，每次创建 store 时被遍历应用。
- `toBeInstalled`：在 `app.use(pinia)` **之前**通过 `pinia.use(plugin)` 注册的插件的**暂存区**（createPinia.ts:18-20）。

路由逻辑只用「`_a` 是否已绑定 app」这一条信号来判断走哪个队列：

```ts
// createPinia.ts:38-45
use(plugin) {
  if (!this._a) {        // 还没 install（_a 仍为 null）
    toBeInstalled.push(plugin)
  } else {               // 已 install
    _p.push(plugin)
  }
  return this            // 链式
},
```

`install(app)` 末尾那两行（第三节步骤 6）就是把暂存队列 flush 进 `_p` 的动作。**为什么非要双队列？** 看一眼 `createPinia` 的末尾：

```ts
// createPinia.ts:56-60
if (__USE_DEVTOOLS__ && IS_CLIENT && typeof Proxy !== 'undefined') {
  pinia.use(devtoolsPlugin)   // 此刻 _a 还是 null！
}
```

`createPinia()` 自己在结尾就 `pinia.use(devtoolsPlugin)`，可此时 `app.use(pinia)` 还没发生、`_a` 为 `null`。没有 `toBeInstalled` 缓冲，devtools 插件会被直接推进 `_p`——但 app 都还没绑定，语义上「已安装」就不成立。双队列保证了：

> **所有插件（含自动注册的 devtools）都会在首个 store 创建前，统一就位于 `_p`。** 用户在 `app.use(pinia)` 前注册的、`createPinia` 内部注册的，殊途同归。

> **记忆抓手**：把「`_a` 是否为 null」当成「是否已安装」的状态标志，是这里最值得学的惯用法。`_a` 一身二任：既是 app 引用，又是安装状态指示灯。

---

## 五、活跃上下文：怎么拿到「当前」的实例

前四节都在讲「实例是什么、怎么装」。现在回答第二个核心问题：**store 被定义时，怎么找到当前该用的那个 pinia？** 这就是「活跃上下文」机制，全部在 `rootStore.ts` 顶部，由三个原语 + 一个键组成。

### 原语 1：注入键 `piniaSymbol`

```ts
// rootStore.ts:125-127
export const piniaSymbol = (
  __DEV__ ? Symbol('pinia') : /* istanbul ignore next */ Symbol()
) as InjectionKey<Pinia>
```

dev 下用带描述的 `Symbol('pinia')`（调试友好），prod 下用匿名 `Symbol()`。注释标了 `@internal` 且「minor 版本可能 break，USE AT YOUR OWN RISK」——用户直接 `inject(piniaSymbol)`（如 storybook 边缘场景）是有风险的，应优先用官方 API。

### 原语 2：模块级 `activePinia` 与 `setActivePinia`

```ts
// rootStore.ts:27-42
export let activePinia: Pinia | undefined

// @ts-expect-error: cannot constrain the type of the return
export const setActivePinia: _SetActivePinia = (pinia) => (activePinia = pinia)
```

`activePinia` 是一个**模块级**可变变量——整个模块只有一份，是个**单例**。`setActivePinia` 啥也不干，就给它赋值。注释强调：SSR 下必须在 `fetch`/`setup`/`serverPrefetch` 等顶层函数里手动 `setActivePinia(...)`。

### 原语 3：`getActivePinia`——inject 优先，全局兜底

这才是活跃上下文的「查询入口」，也是 **SSR 隔离最关键的 API**。分 dev/prod 两套：

```ts
// rootStore.ts:47-58
export const getActivePinia = __DEV__
  ? (): Pinia | undefined => {
      const pinia = hasInjectionContext() && inject(piniaSymbol)
      if (!pinia && !IS_CLIENT) {
        diagnostics.PINIA_R1004({}, { method: 'error' })  // SSR 下报错
      }
      return pinia || activePinia
    }
  : (): Pinia | undefined =>
      (hasInjectionContext() && inject(piniaSymbol)) || activePinia
```

逻辑只有一条主线：**先试 inject，拿不到才回退模块级 `activePinia`。**

```
getActivePinia()
  → hasInjectionContext() ?                 // 当前在组件注入上下文里吗？
      inject(piniaSymbol)                    // ✅ 是：取「当前 app/请求」的 pinia（请求级隔离）
    : false
  → 命中 inject → 返回它
  → 未命中 → （dev + SSR）触发 PINIA_R1004，返回模块级 activePinia（兜底，不安全）
```

**为什么 inject 优先是 SSR 隔离的核心？** 因为两条路径的隔离粒度天差地别：

- `inject(piniaSymbol)` 走的是 Vue 的**注入上下文**，天然绑定到「当前这次请求 / 当前这个 app 实例」——并发请求时互不干扰。
- 模块级 `activePinia` 是**单例**，所有请求共享同一份。多请求并发时，A 请求刚 `setActivePinia(piniaA)`，B 请求立刻覆盖之，A 读到的就是 B 的实例——这就是经典的**跨请求污染（cross-request pollution）**。

`PINIA_R1004` 的诊断文案把后果说得很直白（diagnostics.ts:28-31）：

> Pinia instance not found in context. This falls back to the global activePinia, which exposes you to **cross-request pollution** on the server.

prod 版去掉了诊断（可 tree-shake），但 `inject 优先 || activePinia 兜底` 的语义完全一致。

> **一句话**：`install` 里的 `provide(piniaSymbol, pinia)`（第三节步骤 3）和这里的 `inject(piniaSymbol)` 是一对——前者播种，后者收割。`activePinia` 只是兜底的安全网，不该是主路径。

---

## 六、销毁：`disposePinia` 闭环回到 effectScope

第二节埋下的伏笔——detached scope 必须显式 `.stop()`——在 `disposePinia` 收口：

```ts
// createPinia.ts:72-79
export function disposePinia(pinia: Pinia) {
  pinia._e.stop()       // 1️⃣ 停止 effectScope → 释放所有 store 的响应式 effect
  pinia._s.clear()      // 2️⃣ 清空 store 注册表
  pinia._p.splice(0)    // 3️⃣ 清空插件数组
  pinia.state.value = {}// 4️⃣ 重置根 state
  // @ts-expect-error: non valid
  pinia._a = null       // 5️⃣ 解除 app 关联（_a 回到 null）
}
```

注释点明用途：主要用于测试、多 pinia 实例的应用；**dispose 后实例不可再用**。第 1 步 `_e.stop()` 正是回收 detached scope——所有 store 的响应式 effect 都挂在 `_e` 下，`.stop()` 一次性释放，这正是第二节「把根 state 放进 scope」设计的回报。第 5 步把 `_a` 重新置回 `null`，恰好和第四节「`!this._a` = 未安装」对上：dispose 后这个实例在 `use()` 眼里又变回了「未安装」。

```
createPinia …→ … install …→ 使用 …→ disposePinia
   effectScope(true) ───────────────► _e.stop()    （detached scope 终于被显式回收）
   _a: null ──install──► _a: app ──dispose──► _a: null   （状态指示灯闭环）
```

---

## 七、亲手跑一遍：最小可运行复刻

前面六节全是「带 `file:line` 的源码摘录」，引用了 `__DEV__`/`__USE_DEVTOOLS__`/`diagnostics`/`registerPiniaDevtools` 等本文件外的符号，无法直接运行。下面给一份**自包含**的最小复刻：仅 `import ... from 'vue'`，不碰任何编译期全局，用 `effectScope(true)`/`markRaw`/`ref` 复刻 `createPinia` 的字面量对象、`install` 六步、`use` 双队列，以及 `getActivePinia` 的「inject 优先、`activePinia` 兜底」与 `disposePinia` 的 `_e.stop()`。

> 将下列三段**分别**保存为 `replica/package.json`、`replica/pinia.ts`、`replica/index.ts`，在 `replica/` 下 `bun install && bun run index.ts` 即可。`@vue/server-renderer` 的 `renderToString` 用于在 Node/Bun 下进入组件 `setup`（建立注入上下文），从而观察 `inject(piniaSymbol)` 命中。

`replica/package.json`：

```json
{
  "name": "pinia-instance-replica",
  "private": true,
  "type": "module",
  "scripts": {
    "start": "bun run index.ts"
  },
  "dependencies": {
    "vue": "^3.4.0",
    "@vue/server-renderer": "^3.4.0"
  }
}
```

`replica/pinia.ts`——`createPinia.ts` + `rootStore.ts` 顶部的最小复刻：

```ts
import {
  effectScope, markRaw, ref, inject, hasInjectionContext,
  type App, type EffectScope, type InjectionKey, type Ref,
} from 'vue'

// —— 活跃上下文（对应 rootStore.ts:27-58）——
export let activePinia: Pinia | undefined
export const setActivePinia = (pinia: Pinia | undefined) => (activePinia = pinia)

export const piniaSymbol = Symbol('pinia') as InjectionKey<Pinia>

// getActivePinia：inject 优先，模块级 activePinia 兜底（SSR 隔离核心）
export const getActivePinia = (): Pinia | undefined => {
  const pinia = hasInjectionContext() && inject(piniaSymbol)
  return (pinia as Pinia | false | undefined) || activePinia
}

// —— Pinia 实例的最小契约（对应 rootStore.ts:63-112）——
export interface Pinia {
  install: (app: App) => void
  use(plugin: (ctx: unknown) => void): Pinia
  _p: Array<(ctx: unknown) => void>
  _a: App | null
  _e: EffectScope
  _s: Map<string, unknown>
  state: Ref<Record<string, unknown>>
}

// —— createPinia（对应 createPinia.ts:10-63）——
export function createPinia(): Pinia {
  const scope = effectScope(true) // true = detached：必须显式 .stop() 才回收
  const state = scope.run<Ref<Record<string, unknown>>>(() =>
    ref<Record<string, unknown>>({})
  )!

  let _p: Pinia['_p'] = []
  let toBeInstalled: Pinia['_p'] = [] // install 前 use 的插件暂存区

  const pinia: Pinia = markRaw({
    install(app: App) {
      setActivePinia(pinia)                              // 1. 全局活跃
      pinia._a = app                                     // 2. 关联 app（null → app）
      app.provide(piniaSymbol, pinia)                    // 3. 注入键（inject 优先的地基）
      app.config.globalProperties.$pinia = pinia         // 4. Options API 全局属性
      // 5. devtools：复刻不接，略
      toBeInstalled.forEach((plugin) => _p.push(plugin)) // 6. flush 暂存 → _p
      toBeInstalled = []
    },
    use(plugin) {
      if (!this._a) toBeInstalled.push(plugin) // install 前 → 暂存
      else _p.push(plugin)                     // install 后 → 直接进 _p
      return this
    },
    _p,
    _a: null,
    _e: scope,
    _s: new Map<string, unknown>(),
    state,
  })

  return pinia
}

// —— disposePinia（对应 createPinia.ts:72-79）——
export function disposePinia(pinia: Pinia) {
  pinia._e.stop()        // 回收 detached scope → 释放其下所有响应式 effect
  pinia._s.clear()
  pinia._p.splice(0)
  pinia.state.value = {}
  pinia._a = null        // app → null（"是否已安装"指示灯回到未安装）
}
```

`replica/index.ts`——跑出可观察的输入输出：

```ts
import { createApp, h, watchEffect } from 'vue'
import { renderToString } from '@vue/server-renderer'
import { createPinia, disposePinia, getActivePinia, setActivePinia, type Pinia } from './pinia'

const log = console.log
const fake = () => ({}) as unknown as Pinia

async function main() {
  // [1] 创建实例：_a 为 null（尚未安装）
  const pinia = createPinia()
  log('[1] createPinia()        _a =', pinia._a)               // null

  // [2] install 前 use → 进暂存区，_p 仍空
  pinia.use((_ctx) => {})
  log('[2] install 前 use()     _p.length =', pinia._p.length) // 0（还在暂存）

  // 在 detached scope 内挂一个 effect，稍后验证 _e.stop() 的回收效果
  let runs = 0
  pinia._e.run(() => watchEffect(() => { runs++; void pinia.state.value }))

  // [3] 安装：app.use(pinia) → install 6 步副作用
  const app = createApp({
    setup() {
      // [4] 注入上下文内：inject 命中，优先于 activePinia 兜底
      setActivePinia(fake())                                  // 临时把全局兜底设成 fake
      const got = getActivePinia()
      log('[4] setup 内 inject 命中 =', got === pinia)        // true → inject 优先
      setActivePinia(pinia)
      return () => h('div', 'replica')
    },
  })
  app.use(pinia)
  log('[3] app.use(pinia)       _a 已绑定 =', pinia._a === app) // true
  log('    flush 后             _p.length =', pinia._p.length)  // 1（暂存已 flush）
  await renderToString(app)                                    // 触发 setup → [4]

  // [5] 注入上下文外：回退模块级 activePinia
  setActivePinia(fake())
  log('[5] setup 外 回退兜底    =', getActivePinia() !== pinia) // true → 走 activePinia，非 inject
  setActivePinia(pinia)

  // [6] install 后再 use → 直接进 _p（不经暂存）
  pinia.use((_ctx) => {})
  log('[6] install 后 use()     _p.length =', pinia._p.length) // 2

  // [7] dispose：detached scope 显式回收，_a 回 null
  const runsBefore = runs
  disposePinia(pinia)
  pinia.state.value = { z: 1 }                                 // 变更本应触发 effect
  log('[7] disposePinia()       _a =', pinia._a)               // null
  log('    effect 回收(runs不变) =', runs === runsBefore)       // true → _e.stop() 生效
}

main().catch((e) => { console.error(e); process.exit(1) })
```

预期输出（逐行印证前面六节的断言）：

```
[1] createPinia()        _a = null
[2] install 前 use()     _p.length = 0
[3] app.use(pinia)       _a 已绑定 = true
    flush 后             _p.length = 1
[4] setup 内 inject 命中 = true
[5] setup 外 回退兜底    = true
[6] install 后 use()     _p.length = 2
[7] disposePinia()       _a = null
    effect 回收(runs不变) = true
```

读法：`[1]→[3]` 是 `_a: null → app` 的安装状态灯；`[2]` vs `[6]` 是双队列分流（install 前 0、install 后直接 +1）；`[4]` 在把 `activePinia` 临时换成 `fake` 后仍拿到 `pinia`，证明 `inject` 优先于兜底；`[5]` 在 setup 外拿到 `fake`，证明脱离注入上下文就回退 `activePinia`；`[7]` 的 `runs` 在 `disposePinia` 后不再增长，正是 `_e.stop()` 把 detached scope 连同其下 effect 一次性回收的实证。

---

## 小结

本章把 pinia 根实例拆成两层来理解：

- **所有权容器**：`createPinia` 产出一个 `markRaw` 字面量对象，用**一个 detached effectScope** 把根 state 和所有派生响应式 effect「攥」在一起，配合 `_s`（store 注册表）、`_p`（插件管线）、`_a`（app 引用兼安装状态灯）。`install` 完成接线（provide/全局属性/devtools/flush 插件），`disposePinia` 用 `_e.stop()` 一键回收，闭环回到 detached scope。
- **活跃上下文**：`getActivePinia` 以「**inject 优先、模块级 `activePinia` 兜底**」的策略定位当前实例——inject 走请求级隔离（安全），`activePinia` 是单例（SSR 不安全、会跨请求污染），dev 下还会用 `PINIA_R1004` 主动告警。`provide(piniaSymbol, ...)` 与 `inject(piniaSymbol)` 是这对「播种/收割」的两端。

到这里，「实例如何存在、如何被发现」就齐了。下一章 [[store-definition]] 将基于 `_s`/`_p`/`_a`/`_e` 这套内部状态，展开 `defineStore` 的装配管线：自动归类 state/getter/action、reactive 化、应用 `_p` 插件、SSR hydrate。那条管线的「根」，正是本章这个被 `markRaw` 包着的字面量对象。

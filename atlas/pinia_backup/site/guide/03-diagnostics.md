---
title: 运行时诊断与错误码体系
---

# 运行时诊断与错误码体系

`diagnostics.ts` 全文只有 52 行，做的事却贯穿了整个 Pinia。它定义了一张「错误码目录」`PINIA_R1001` ~ `PINIA_R1007`，但目录本身只是一张静态表格——真正让这张表「活起来」的，是散布在 `store.ts`、`rootStore.ts`、`mapHelpers.ts`、`hmr.ts` 四个文件里的 **7 个调用点**。这些调用点在用户踩坑时触发，把诊断信息打到控制台；而在生产构建里，它们又被完整地 tree-shake 掉。

本章自底向上拆解这套体系：从最底层的外部依赖 `nostics`，到目录的组装，再到调用点的触发条件，最后讲清它为什么能在生产环境「消失」。

> 本章 `dependsOn: []`，是 primitive 层的基础章节。文中涉及 `__DEV__`、`IS_CLIENT` 等编译期常量与 `inject`、`reactive`、`markRaw` 等 Vue 能力，此处按需引用，不展开。

## 1. 最底层原语：nostics

`diagnostics.ts` 的第一行就把「动力来源」交代清楚了（`diagnostics.ts:1`）：

```ts
import { createConsoleReporter, defineDiagnostics } from 'nostics'
```

`nostics` 是 Pinia **唯一的运行时依赖**——`packages/pinia/package.json` 的 `dependencies` 只有一项 `"nostics": "^1.1.4"`。它还有一个特殊身份：**内联依赖**（`"inlinedDependencies": { "nostics": "1.1.4" }`）。这意味着构建工具（`tsdown`）在打包阶段会把 nostics 的源码直接打进 Pinia 的产物里，用户 `npm install pinia` 后不会在 `node_modules` 里单独引用 nostics 的入口。

> ⚠️ nostics 的源码不在本章可达的源码树内。下文对 nostics API 契约的描述，**均从 Pinia 的使用方式推断**，而非 nostics 自身的源码事实。

从这两个导入名能推断出它们的角色：

| API | 推断的职责 |
|-----|-----------|
| `createConsoleReporter()` | 返回一个往 `console` 输出的「报告器」（reporter） |
| `defineDiagnostics(config)` | 接收一份「报告器列表 + 错误码目录」，返回一个 `diagnostics` 单例对象 |

二者配合的直觉是：**报告器决定「往哪儿写」，错误码目录决定「写什么」，`defineDiagnostics` 把两者粘合成一个可调用的句柄集合**。

## 2. 组装目录：defineDiagnostics 的结构

`diagnostics.ts:8-10` 把上面的推断坐实：

```ts
// diagnostics.ts:8
export const diagnostics = /*#__PURE__*/ defineDiagnostics({
  reporters: [/*#__PURE__*/ createConsoleReporter()],
  codes: {
    // PINIA_R1001 ~ PINIA_R1007
  },
})
```

配置对象有两块：

- **`reporters`**：一个数组，这里只放了一个 `createConsoleReporter()`。也就是说，目前 Pinia 的诊断只会写到控制台。
- **`codes`**：错误码目录，每个 key 是一个错误码字符串，value 是一条诊断定义。

### 2.1 一条诊断定义长什么样

每个码的定义含三类字段（以 `PINIA_R1002` 为例，`diagnostics.ts:16-21`）：

```ts
PINIA_R1002: {
  why: (p: { name: string; id: string }) =>
    `A getter cannot have the same name as another state property. Found "${p.name}" in store "${p.id}".`,
  fix: 'Rename either the getter or the state property.',
  docs: 'https://pinia.vuejs.org/core-concepts/getters.html#Accessing-other-getters',
}
```

- **`why`**：为什么出错。有两种形态——**字符串**（如 R1001、R1004，内容固定）或**参数化函数**（如 R1002，接收参数对象拼出动态文案）。
- **`fix`**：怎么修。**可选字段**——并非每个码都有。
- **`docs`**：文档链接，指回官方文档对应章节。

### 2.2 错误码命名约定

所有码形如 `PINIA_R` + 4 位数字（`R1`xxx）。`R` 据命名推测指 **R**untime（运行时），编号从 1001 起，连续 7 个。下表给出全景：

| 码 | `why` 形态 | 有 `fix`? | 触发模块 |
|----|-----------|-----------|---------|
| R1001 | 字符串 | ✅ | mapHelpers.ts |
| R1002 | 函数 | ✅ | store.ts |
| R1003 | 函数 | ✅ | store.ts |
| R1004 | 字符串 | ✅ | rootStore.ts |
| R1005 | 函数 | ❌ | hmr.ts |
| R1006 | 函数 | ✅ | store.ts |
| R1007 | 函数 | ✅ | store.ts |

两个要点先记住，后文会用到：**R1005 是唯一没有 `fix` 的码**；7 个码里 **4 个集中在 `store.ts`**（store 装配是误用高发区）。

## 3. 一条诊断的运行时流转

`diagnostics` 对象上，每个错误码名都是一个**可调用句柄**。文件头注释点明了关键机制（`diagnostics.ts:3-7`）：

> Each handle builds a diagnostic and runs the reporters.

即「每个句柄被调用时，会构造一条诊断，并依次跑所有 reporter」。从使用方式推断出的完整流转如下：

```
调用点
  diagnostics.PINIA_R1002({ name, id })        ← 第 1 参数：模板参数对象
        │
        ▼
句柄内部：用 {name,id} 渲染 why/fix/docs       ← why 是函数时消费参数
        │
        ▼
依次跑 reporters（此处 = createConsoleReporter） ← method 决定 console 级别
        │
        ▼
控制台输出（默认 warn；R1004 用 error）
```

句柄的**两个参数**都有讲究：

- **第 1 参数（模板参数）**：喂给 `why` 函数渲染文案。形状必须与该码 `why` 函数的参数匹配。例如 R1002 要 `{ name, id }`、R1003 只要 `{ id }`、R1005 要 `{ from, to }`。`why` 是字符串的码（R1001/R1004）不消费参数，调用时传空（`PINIA_R1001()` 或 `PINIA_R1004({}, ...)`）。
- **第 2 参数（可选，控制选项）**：目前只见 `{ method }` 一种用法。**R1004 是唯一传 `{ method: 'error' }` 的码**，使其以 `console.error` 级别报告（其余码默认级别，推测为 `warn`）。

> `method` 除 `'error'` 外还有哪些取值、reporter 如何格式化输出，nostics 源码不可达，均未在可读源码中证实。

## 4. 调用点全景：7 处误用收集，散布 4 个文件

`diagnostics` 是 `./diagnostics.ts` 的命名导出，被 4 个文件以完全相同的写法引入：

```
store.ts:53        ┐
rootStore.ts:21    ├── 全部：import { diagnostics } from './diagnostics'
mapHelpers.ts:9    ┘
hmr.ts:12
```

也就是说，**全库共享同一个 `diagnostics` 单例**（同一份 reporter、同一份 codes）。各调用点在这个单例上挑对应的句柄触发。下面按「触发后系统如何处置」分类讲解——这比按编号罗列更能讲清设计意图。

### 4.1 容错回退型：R1001

`mapStores` 本应把多个 store 直接作为参数传入。用户若误写成 `mapStores([useAuth, useCart])`（塞进数组），`mapHelpers.ts:104-107` 会先报告，再做容错回退：

```ts
// mapHelpers.ts:104
if (__DEV__ && Array.isArray(stores[0])) {
  diagnostics.PINIA_R1001()   // 报告：这在生产里会失败
  stores = stores[0]          // 回退：解包数组，继续 reduce
}
```

报告后**不中断**，解包数组继续工作。`why` 是字符串，故调用时不传参数。

### 4.2 容错去重型：R1007

同一个回调被多次传给 `$subscribe` 时，`store.ts:438-446` 报告后直接返回 `noop`，跳过重复订阅：

```ts
// store.ts:438
$subscribe(callback, options = {}) {
  // avoid setting up multiple watchers for the same callback
  // https://github.com/vuejs/pinia/issues/3143
  if (subscriptions.has(callback)) {
    if (__DEV__) {
      diagnostics.PINIA_R1007({ id: $id })
    }
    return noop   // 返回空函数，不重复注册
  }
  // ...正常建立订阅
}
```

这是「报告 + 静默去重」：用户代码不会崩，只是第二次订阅被忽略。

### 4.3 报告 + 强制重载型：R1005

HMR 热替换时，若新模块导出的 store `$id` 与原来不一致（`hmr.ts:107-111`），无法热替换，只能整页重载：

```ts
// hmr.ts:107
if (id !== initialUseStore.$id) {
  diagnostics.PINIA_R1005({ from: initialUseStore.$id, to: id })
  return hot.invalidate()   // 强制整页重载
}
```

这也解释了 R1005 为什么**没有 `fix` 字段**：这种情况由 HMR 自动 `hot.invalidate()` 处理，用户无需手动修复。注意此调用点**没有显式 `__DEV__` 守卫**——整个 `hmr.ts` 只在开发期 HMR 下被加载，天然 dev-only，这正对应目录注释里的「`__DEV__` guarded **or HMR**」分支。

### 4.4 装配期校验型：R1002 / R1003 / R1006

这三个都发生在 `createSetupStore` 的装配阶段，且只报告、不中断装配。

**R1002——getter 与 state 同名**（`store.ts:182-186`，装配 getters 的 reduce 内）：

```ts
// store.ts:184
if (__DEV__ && name in localState) {
  diagnostics.PINIA_R1002({ name, id })  // getter 名撞上 state 属性
}
```

**R1003——state 必须是 plain object**（`store.ts:756-764`，应用插件后校验 `$state`）：

```ts
// store.ts:756
if (
  __DEV__ &&
  store.$state &&
  typeof store.$state === 'object' &&
  typeof store.$state.constructor === 'function' &&
  !store.$state.constructor.toString().includes('[native code]')
) {
  diagnostics.PINIA_R1003({ id: store.$id })
}
```

这里的探测手法值得细看：它不是在检测「严格意义上的 plain object」，而是用字符串探测判断「`constructor` 是否原生」。plain object 的 constructor 是 `Object`（原生，`toString()` 含 `[native code]`）→ 被跳过；而 `new MyClass()` 这类自定义类实例的 constructor 不含 `[native code]` → 命中。**它区分的是「原生 Object vs 自定义类」，而非严格的 plainness**（如 `Object.create(null)` 这类无 prototype 对象属边界，源码未显式处理）。

**R1006——插件附加属性非响应式**（`store.ts:737-751`，遍历插件返回的 `extensions`）：

```ts
// store.ts:737
if (__DEV__) {
  for (const key in extensions) {
    const value = (extensions as any)[key]
    if (
      typeof value === 'object' &&
      !isRef(value) &&
      !isReactive(value) &&
      !value?.__v_skip          // markRaw() 打的标记
    ) {
      diagnostics.PINIA_R1006({ key, id: $id })
    }
  }
}
```

两个细节：

1. **检查时机很讲究**。注释（`store.ts:734-741`）解释：必须在赋值给 store 之前检查——一旦赋值，`reactive()` 值会被解包，与 plain object 无法区分。所以这里检查的是「插件原始返回值」。
2. **`__v_skip` 与 `markRaw` 的闭环**。`__v_skip` 是 Vue `markRaw()` 打的标记。R1006 的 `fix` 建议「不想响应式就 `markRaw()` 包一下」——markRaw 后 `!value?.__v_skip` 为假，本条件跳过，不再触发 R1006。目录的 `fix` 与调用点的判断条件**互相咬合**。

### 4.5 唯一的 error 级：R1004

`getActivePinia` 取不到 pinia 实例、且处于非浏览器环境（SSR）时触发（`rootStore.ts:51-53`）：

```ts
// rootStore.ts:51
if (!pinia && !IS_CLIENT) {
  diagnostics.PINIA_R1004({}, { method: 'error' })
}
```

为什么只有它用 `error` 级别？因为它的危害最隐蔽：找不到注入的 pinia 时会 **fallback 到全局 `activePinia`**，在 SSR 多请求并发下会**跨请求污染状态**。这是真正可能导致线上数据串号的隐患，值得最高级别提醒。注意第 1 参数是空对象 `{}`——因为 `why` 是字符串，不消费参数。

### 4.6 调用点分布小结

```
PINIA_R1001 ─→ mapHelpers.ts   （mapStores 参数校验）
PINIA_R1002 ─→ store.ts        （装配 getters）
PINIA_R1003 ─→ store.ts        （装配后校验 $state）  ┐ 相邻
PINIA_R1006 ─→ store.ts        （遍历插件 extensions）┘ 同属装配期
PINIA_R1007 ─→ store.ts        （$subscribe 去重）
PINIA_R1004 ─→ rootStore.ts    （getActivePinia，SSR）
PINIA_R1005 ─→ hmr.ts          （acceptHMRUpdate）
```

可见目录文件本身不触发任何东西——**真正的「误用收集」全在这 7 个调用点的触发条件里**。这也是为什么只读 `diagnostics.ts` 会严重低估本章的范围。

## 5. 关键边界：诊断不是抛异常

最容易误解的一点：**这些诊断全部是「控制台报告」，不是抛异常**。多数码是「报告后继续」，按处置方式分三类：

- **容错回退/去重**：R1001（解包数组）、R1007（返回 `noop`）——用户代码正常往下走。
- **报告 + 重载**：R1005（`hot.invalidate()`）——仅 HMR 自动处理。
- **纯报告**：R1002 / R1003 / R1006 ——装配照常完成，只是打了警告。
- **报告 + 隐患提示**：R1004 ——仍会 fallback 到 `activePinia`，只是用 `error` 级别警示风险。

换言之，诊断的定位是**开发期可观测性**，而非运行期护栏。它帮你早发现误用，但不会替你拦下错误。

## 6. 为什么生产环境看不见：tree-shake 三件套

目录注释点明了整套体系的设计目标（`diagnostics.ts:3-7`）：

> All call sites are dev-only (`__DEV__` guarded or HMR), so production builds drop the calls and tree-shake this catalog.

生产构建消除诊断代码，依赖**三个相互独立、缺一不可**的事实：

**① `package.json` 声明无副作用**（`"sideEffects": false`）
允许打包器激进删除未被引用的导出。

**② 纯调用注解 `/*#__PURE__*/`**（`diagnostics.ts:8-9`）
`defineDiagnostics(...)` 和 `createConsoleReporter()` 都标注为「纯调用」，未引用时可整段删除：

```ts
// diagnostics.ts:8
export const diagnostics = /*#__PURE__*/ defineDiagnostics({
  reporters: [/*#__PURE__*/ createConsoleReporter()],
```

**③ `__DEV__` 守卫**
`__DEV__` 是 Vue 生态的**编译期常量**，生产构建被替换为 `false` 后，调用语句变 dead code 被消除，连带整个 diagnostics 目录一起 tree-shake。守卫的位置因码而异，但效果一致：

| 码 | `__DEV__` 守卫位置 |
|----|------------------|
| R1001 / R1002 / R1003 / R1006 / R1007 | 调用点各自有 `if (__DEV__)` |
| R1004 | 在外层 `getActivePinia` 三元（函数级分叉） |
| R1005 | **无** `__DEV__`（依赖 hmr 模块本身 dev-only） |

R1004 的 dev/prod 双实现是最直观的代码证据（`rootStore.ts:47-58`）：

```ts
// rootStore.ts:47
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

整个带诊断的函数体只存在于 `__DEV__` 分支；生产分支是单行简化版，既不触达 diagnostics，连 `hasInjectionContext`/`inject` 的额外开销也一并省掉。编译期 `__DEV__` 被求值为常量后，三元被折叠成生产那一支，dev 分支整段消失。

## 7. 小结

把这套体系抽象成一条设计主线：

```
nostics（外部原语：reporter + defineDiagnostics）
        │ defineDiagnostics 组装
        ▼
diagnostics 单例（reporters + codes 目录，全库共享）
        │ import 进 4 个核心文件
        ▼
7 个调用点（在用户误用路径上触发，多数容错继续）
        │ __DEV__ / HMR / /*#__PURE__* / sideEffects:false
        ▼
开发期：控制台可观测报告    生产期：整段被 tree-shake 消除
```

三个要点收束全章：

1. **目录文件 ≠ 全部事实**。`diagnostics.ts` 只是一张静态表；真正的「误用收集」体现在散布四处的 7 个调用点，理解触发条件比背诵表格重要。
2. **诊断 ≠ 抛异常**。它们是开发期控制台报告（多数 `warn`、R1004 用 `error`），报告后系统通常继续运行甚至容错，不构成运行期护栏。
3. **dev-only 三件套**。`sideEffects:false` + `/*#__PURE__*/` + `__DEV__` 守卫共同保证：开发期充分可观测，生产期零成本。

这套「目录 + 调用点 + 三件套」的组合，是 Pinia 在「易用性（少抛错、多容错）」与「可观测性（开发期把误用讲清楚）」之间取得平衡的关键设计。

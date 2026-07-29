# 运行时诊断与错误码体系 · 源码精读

> 章节定位：`diagnostics`（primitive 层，`dependsOn: []`）。本章 sourceFiles 仅一个：`packages/pinia/src/diagnostics.ts`。但该文件只是「错误码目录 + reporter 注册」，真正的「在各核心模块收集用户误用」体现在**散布于 5 个文件的 7 个调用点**上——精读必须覆盖这些调用点，否则目录只是一张静态表格。

## 0. 文件全景：diagnostics.ts 是什么

`packages/pinia/src/diagnostics.ts` 全文仅 52 行，做三件事：
1. 从外部库 `nostics` 导入 `createConsoleReporter` 与 `defineDiagnostics`（源码位置: `packages/pinia/src/diagnostics.ts:1`）。
2. 调用 `defineDiagnostics({...})` 生成一个 `diagnostics` 对象（导出为命名导出 `export const diagnostics`，源码位置: `packages/pinia/src/diagnostics.ts:8`）。
3. 在 `codes:` 下集中定义 7 个错误码 `PINIA_R1001` ~ `PINIA_R1007`，每个码含 `why` / `fix?` / `docs` 三个字段（源码位置: `packages/pinia/src/diagnostics.ts:10-50`）。

文件头注释明确点出其 dev-only / tree-shake 定位（源码位置: `packages/pinia/src/diagnostics.ts:3-7`）：
```ts
/**
 * Catalog of user-facing Pinia diagnostics. Each handle builds a diagnostic
 * and runs the reporters. All call sites are dev-only (`__DEV__` guarded or
 * HMR), so production builds drop the calls and tree-shake this catalog.
 */
```
关键短语：「each handle builds a diagnostic and runs the reporters」——说明每个错误码「句柄」被调用时，会构造一条诊断并通过 reporters（这里是 console reporter）输出。

## 1. 概念要点

- **nostics 是 pinia 唯一的运行时依赖**：`packages/pinia/package.json` 的 `dependencies` 只有一项 `"nostics": "^1.1.4"`（源码位置: `packages/pinia/package.json:57-59`）。pinia 版本为 `4.0.2`（源码位置: `packages/pinia/package.json:3`）。
- **nostics 在构建期被内联进 pinia dist，用户无需单独安装**：package.json 有 `"inlinedDependencies": { "nostics": "1.1.4" }`（源码位置: `packages/pinia/package.json:78-79`）。这与克隆树中找不到 nostics 源码一致——它是 npm 包，由构建工具（`tsdown`，源码位置: `packages/pinia/package.json:52`）在打包阶段内联。注意：nostics 的源码**不在本次精读可达的源码树内**（`work/source` 下无 `nostics` 包），下文关于 nostics API 的描述均**从 pinia 的使用方式推断**，非直接源码事实（见「未理解」一节）。
- **tree-shake 三件套**（生产构建消除诊断代码的依据）：
  1. `package.json:43` `"sideEffects": false` —— 声明模块无副作用，允许打包器激进删除未用导出（源码位置: `packages/pinia/package.json:42-43`）。
  2. `defineDiagnostics` 与 `createConsoleReporter` 调用处均带 `/*#__PURE__*/` 注解（源码位置: `packages/pinia/src/diagnostics.ts:8-9`），标记为「纯调用」，未引用时可整段删除。
  3. 全部调用点被 `__DEV__` 守卫（详见第 4 节）；`__DEV__` 是 Vue 生态的编译期常量，生产构建替换为 `false` 后，调用语句变 dead code 被消除，连带 diagnostics.ts 整个目录一起 tree-shake 掉。
- **错误码命名约定**：`PINIA_R` + 4 位数字。`R` 据命名推测指 Runtime（运行时）；编号从 1001 起。summary 中「PINIA_R1xxx」即此。
- **defineDiagnostics 的 API 契约（从使用推断）**：
  - 入参对象形如 `{ reporters: Reporter[], codes: Record<string, DiagnosticDef> }`（源码位置: `packages/pinia/src/diagnostics.ts:9-10`）。
  - `DiagnosticDef` 字段：`why`（字符串，或接收参数对象返回字符串的函数）、`fix`（可选字符串，修复建议）、`docs`（字符串，文档链接）（源码位置: `packages/pinia/src/diagnostics.ts:11-49`）。
  - 返回值 `diagnostics` 上，每个 code 名是一个**可调用句柄**：`diagnostics.PINIA_R1002({ name, id })`（源码位置: `packages/pinia/src/store.ts:185`）；句柄第一参数是模板参数对象（喂给 `why` 函数），第二参数（可选）可含 `{ method }` 控制报告级别，例如 `diagnostics.PINIA_R1004({}, { method: 'error' })`（源码位置: `packages/pinia/src/rootStore.ts:52`）。
  - `createConsoleReporter()` 返回一个往 `console` 输出的 reporter，被放入 `reporters` 数组（源码位置: `packages/pinia/src/diagnostics.ts:9`）。

## 2. 错误码目录逐条（定义 + 触发条件 + 调用点）

下面 7 条按定义顺序（diagnostics.ts:11-49）逐条给出「目录里写了什么」+「在哪个模块、什么条件下被触发」。

### PINIA_R1001 —— `mapStores` 误用数组
- 目录定义（源码位置: `packages/pinia/src/diagnostics.ts:11-15`）：`why` 为字符串（直接点明生产会失败）、有 `fix`、有 `docs`。
- 调用点（源码位置: `packages/pinia/src/mapHelpers.ts:104-107`）：
  ```ts
  if (__DEV__ && Array.isArray(stores[0])) {
    diagnostics.PINIA_R1001()
    stores = stores[0]
  }
  ```
- 触发条件：用户把多个 store 放进数组传入 `mapStores([useAuthStore, useCartStore])`（`stores[0]` 是数组）。
- 行为：**容错回退型**——报告诊断后仍执行 `stores = stores[0]`，继续往下 reduce，不中断。调用时不传参数（`why` 是字符串，无需参数）。

### PINIA_R1002 —— getter 与 state 同名
- 目录定义（源码位置: `packages/pinia/src/diagnostics.ts:16-21`）：`why` 是函数 `(p: { name: string; id: string }) => string`、有 `fix`、有 `docs`。
- 调用点（源码位置: `packages/pinia/src/store.ts:182-186`），位于 `createSetupStore` 装配 getters 的 `reduce` 内：
  ```ts
  if (__DEV__ && name in localState) {
    diagnostics.PINIA_R1002({ name, id })
  }
  ```
- 触发条件：某个 getter 的 `name` 已经存在于 `localState`（即与 state 属性同名）。`id` 是 store 的 `$id`。

### PINIA_R1003 —— state 必须是 plain object
- 目录定义（源码位置: `packages/pinia/src/diagnostics.ts:22-27`）：`why` 函数 `(p: { id: string }) => string`、有 `fix`、有 `docs`。
- 调用点（源码位置: `packages/pinia/src/store.ts:756-764`），位于应用插件 extensions 之后：
  ```ts
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
- 触发条件：`store.$state` 是对象、其 `constructor` 是 function、且 constructor 的 `toString()` **不含** `[native code]`。plain object 的 constructor 是 `Object`（原生，含 `[native code]`）；自定义类实例的 constructor（如 `new MyClass()`）不含 `[native code]`，故被命中。**这是一种靠「constructor 是否原生」区分 plain object 与类实例的字符串探测手法**。

### PINIA_R1004 —— 找不到 pinia 实例（SSR 跨请求污染风险）
- 目录定义（源码位置: `packages/pinia/src/diagnostics.ts:28-32`）：`why` 为字符串（解释会 fallback 到全局 activePinia、暴露跨请求污染）、有 `fix`、有 `docs`。
- 调用点（源码位置: `packages/pinia/src/rootStore.ts:51-53`），位于 `getActivePinia` 内：
  ```ts
  if (!pinia && !IS_CLIENT) {
    diagnostics.PINIA_R1004({}, { method: 'error' })
  }
  ```
- 触发条件：`inject(piniaSymbol)` 取不到 pinia **且** `!IS_CLIENT`（即 SSR / 非浏览器环境）。
- 两个特殊点：(1) **唯一一个用 `{ method: 'error' }` 第二参数的诊断**——即以 `console.error` 级别报告（其余默认级别，推测为 warn）；(2) 第一参数传空对象 `{}`，因为 `why` 是字符串不消费参数。

### PINIA_R1005 —— HMR 中 store id 变化
- 目录定义（源码位置: `packages/pinia/src/diagnostics.ts:33-37`）：`why` 函数 `(p: { from: string; to: string }) => string`、**只有 `docs`，无 `fix` 字段**——7 个码中唯一没有 `fix` 的。
- 调用点（源码位置: `packages/pinia/src/hmr.ts:107-111`），位于 `acceptHMRUpdate`：
  ```ts
  if (id !== initialUseStore.$id) {
    diagnostics.PINIA_R1005({ from: initialUseStore.$id, to: id })
    // return import.meta.hot.invalidate()
    return hot.invalidate()
  }
  ```
- 触发条件：HMR 热替换时新模块导出的 store `$id` 与原 `$id` 不一致。
- 行为：报告后调用 `hot.invalidate()` **强制整页重载**（无法热替换）。无 `fix` 是因为这种情况由 HMR 自动处理、用户无需手动修复。**注意此调用点没有显式 `__DEV__` 守卫**——因为整个 hmr.ts 模块只在 HMR（开发期）下被加载，天然 dev-only，符合 diagnostics.ts 注释里「`__DEV__` guarded or HMR」的「HMR」分支。

### PINIA_R1006 —— storeToRefs 忽略的非响应式属性
- 目录定义（源码位置: `packages/pinia/src/diagnostics.ts:38-43`）：`why` 函数 `(p: { key: string; id: string }) => string`、有 `fix`、有 `docs`。`fix` 提示可用 `ref()`/`reactive()`/`shallowRef()` 包裹，或用 `markRaw()` 显式标记为非响应式。
- 调用点（源码位置: `packages/pinia/src/store.ts:737-751`），位于遍历插件 `extensions`（插件返回的附加属性）的循环内：
  ```ts
  if (__DEV__) {
    for (const key in extensions) {
      const value = (extensions as any)[key]
      if (
        typeof value === 'object' &&
        !isRef(value) &&
        !isReactive(value) &&
        !value?.__v_skip
      ) {
        diagnostics.PINIA_R1006({ key, id: $id })
      }
    }
  }
  ```
- 触发条件：插件附加属性的 `value` 是对象、非 `ref`、非 `reactive`、且无 `__v_skip` 标记。注释（源码位置: `packages/pinia/src/store.ts:734-741`）说明：一旦赋给 store，`reactive()` 值会被解包、与 plain object 无法区分，所以必须在赋值前（即插件原始返回值上）检查。
- 关键关联：`!value?.__v_skip` 中的 `__v_skip` 是 Vue 的 `markRaw()` 标记（带 `__v_skip` 的对象即被 markRaw）；这与目录 `fix` 里「wrap it with markRaw()」对应——markRaw 后的值会被这个条件跳过，不再触发 R1006。

### PINIA_R1007 —— `$subscribe` 重复回调
- 目录定义（源码位置: `packages/pinia/src/diagnostics.ts:44-49`）：`why` 函数 `(p: { id: string }) => string`、有 `fix`、有 `docs`。
- 调用点（源码位置: `packages/pinia/src/store.ts:438-446`），位于 `$subscribe` 方法实现内：
  ```ts
  $subscribe(callback, options = {}) {
    // avoid setting up multiple watchers for the same callback
    // https://github.com/vuejs/pinia/issues/3143
    if (subscriptions.has(callback)) {
      if (__DEV__) {
        diagnostics.PINIA_R1007({ id: $id })
      }
      return noop
    }
    ...
  }
  ```
- 触发条件：同一个 `callback` 被多次传给 `$subscribe`（`subscriptions.has(callback)` 为真）。注释引用 issue #3143，目的「避免为同一回调重复建 watcher」。
- 行为：**容错去重型**——报告后 `return noop`（返回空函数），跳过本次订阅，不重复注册。

## 3. 关键调用链

### 3.1 import 链（diagnostics 单例如何被各模块引入）
`diagnostics` 是 `./diagnostics.ts` 的命名导出，被 4 个核心文件以完全相同的 `import { diagnostics } from './diagnostics'` 引入（来源：grep 结果）：
- `packages/pinia/src/store.ts:53`
- `packages/pinia/src/rootStore.ts:21`
- `packages/pinia/src/mapHelpers.ts:9`
- `packages/pinia/src/hmr.ts:12`

即全库共享同一个 `diagnostics` 对象（同一份 reporter、同一份 codes 目录）。

### 3.2 错误码 → 调用模块的分布
- `PINIA_R1001` → mapHelpers.ts:105（mapStores 参数校验）
- `PINIA_R1002` → store.ts:185（createSetupStore 装配 getters）
- `PINIA_R1003` → store.ts:763（createSetupStore 应用插件后校验 $state）
- `PINIA_R1004` → rootStore.ts:52（getActivePinia，SSR 路径）
- `PINIA_R1005` → hmr.ts:108（acceptHMRUpdate）
- `PINIA_R1006` → store.ts:748（createSetupStore 遍历插件 extensions）
- `PINIA_R1007` → store.ts:443（$subscribe 去重）

可见 7 个码中 4 个集中在 `store.ts`（store 装配 / 实例 API 是误用高发区），R1003 与 R1006 还恰好相邻（store.ts:737-764，都属于「装配阶段属性检查」）。

### 3.3 一条诊断的运行时流转（从目录注释推断）
`调用点 diagnostics.PINIA_Rxxxx(params)` →（句柄内部用 params 渲染 `why`/`fix`/`docs`）→ 依次跑 `reporters`（这里是 `createConsoleReporter()`）→ 输出到 console。这条流转的「内部」细节属于 nostics 实现，不在可达源码内（见未理解）。

## 4. 源码摘录（带行号）

### 4.1 目录核心结构（diagnostics.ts:8-15）
```ts
export const diagnostics = /*#__PURE__*/ defineDiagnostics({
  reporters: [/*#__PURE__*/ createConsoleReporter()],
  codes: {
    PINIA_R1001: {
      why: 'Directly pass all stores to "mapStores()" without putting them in an array. This will fail in production.',
      fix: 'Replace mapStores([useAuthStore, useCartStore]) with mapStores(useAuthStore, useCartStore).',
      docs: 'https://pinia.vuejs.org/cookbook/options-api.html#Giving-access-to-the-whole-store',
    },
    ...
```

### 4.2 R1004 的 dev/prod 双实现（rootStore.ts:47-58）
```ts
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
要点：整个带诊断的函数体只在 `__DEV__` 分支存在；生产分支是单行简化版，既不调 `hasInjectionContext`/`inject`（注释暗示这部分开销），也不触达 diagnostics。这是「dev-only / tree-shake」最直观的代码证据。

### 4.3 R1003 的 native-code 探测（store.ts:756-764）
（见第 2 节 PINIA_R1003 摘录）

## 5. 易混淆 / 需 Writer 注意

- **目录文件 ≠ 全部事实**：若只读 `diagnostics.ts` 会以为本章只是「一张错误码表」。真正体现「在各核心模块收集用户误用」的是 7 个散布调用点（store.ts / rootStore.ts / mapHelpers.ts / hmr.ts）。Writer 写正文必须覆盖调用点的触发条件，不能只罗列表格。
- **诊断 ≠ 硬报错**：多数码是「报告后继续」。其中 R1001（回退 `stores[0]`）与 R1007（返回 `noop` 跳过订阅）是**容错型**；R1005 是「报告 + `hot.invalidate()` 整页重载」。只有 R1004 用了 `{ method: 'error' }` 级别。Writer 讲「错误码体系」时应区分「这只是控制台报告，不是抛异常」。
- **`fix` 字段并非每个码都有**：R1005 缺 `fix`（因 HMR 自动处理）。讲目录结构时别声称「每条都有 why/fix/docs 三段」。
- **`why` 有两种形态**：字符串（R1001、R1004）或参数化函数（其余 5 个）。函数形态的码，调用时必须传匹配形状的参数对象，否则 `why` 模板渲染会出问题——这是 nostics 的隐式契约。
- **R1003 的探测手法易被误读**：`!constructor.toString().includes('[native code]')` 不是检测「是否 plain object」的标准方式，而是「constructor 是否原生」。Writer 应讲清它区分的是「原生 Object vs 自定义类」，而非严格 plainness（例如通过 `Object.create(null)` 构造的无 prototype 对象会另有行为，源码未显式处理，属边界）。
- **`__DEV__` 守卫的位置不一致**：R1001/R1002/R1003/R1006/R1007 调用点各自有 `if (__DEV__)`；R1004 的 `__DEV__` 守卫在**外层 `getActivePinia` 三元**（函数级分叉）；R1005 **无** `__DEV__`（依赖 hmr 模块本身 dev-only）。Writer 讲 tree-shake 时要点明「守卫位置各异，但效果一致：生产构建全部消除」。
- **tree-shake 依赖三个独立事实，缺一不可**：`sideEffects:false`（package.json）+ `/*#__PURE__*/`（diagnostics.ts）+ `__DEV__` 守卫（调用点）。讲「可 tree-shake」时三者都要提到，否则逻辑链不完整。
- **nostics 是内联依赖**：用户安装 pinia 后**不会**在 node_modules 里看到独立的 nostics 入口被引用（已被打进 pinia dist）。Writer 若讲「依赖关系」要说明 nostics 经 `inlinedDependencies` 内联，避免误导读者以为它是普通传递依赖。

## 6. 未理解（须如实标注）

- **nostics 源码不可达**：`work/source` 树内无 `nostics` 包，第 1 节关于 `defineDiagnostics`/`createConsoleReporter` 的 API 描述（入参形状、句柄签名、`{method}` 选项语义、reporter 调用时机）均为**从 diagnostics.ts 定义与各调用点的使用方式推断**，非直接源码事实。`why` 函数的参数解构、reporter 如何格式化输出、`method` 除 `'error'` 外还有哪些取值，均未在可达源码中证实。Writer 引用 nostics 行为时应措辞为「据 pinia 用法，nostics 的……」而非断言。
- **`__DEV__` 与 `IS_CLIENT` 的定义**：两者分别属编译期常量与运行时环境探测，定义在 `env.ts` / 构建配置中，属 `core-types` 章节范围，本章未深入核对其定义处（仅作为 R1004 条件引用）。
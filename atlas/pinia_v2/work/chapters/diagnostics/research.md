# 诊断目录：dev-only 可索引警告系统 · 源码精读

## 给 Writer 的教学钩子（必填，8 子项缺一不可）

- **用户痛点 / 场景**：库弹出的警告散落在各处、措辞随意、没有稳定标识。结果就是：用户在控制台看到一行红字，却不知道「这是什么问题、怎么修、去哪查」；自动化工具（IDE、agent、文档检索）也无法把这行报错可靠地对应到某段文档。更糟的是，这些「开发期才需要」的提醒还会被原样打进生产包，白白增加体积。

- **一句话核心思想**：把「面向用户的警告」当成**数据**集中成一个带编号、带原因/修法/文档锚点的目录，调用点只报编号、文案集中维护、输出交给可插拔的报告器，并用一个构建期开关把整套能力挡在生产构建之外。

- **设计动机（为什么需要它）**：警告本质是「给人和给机器看的错误说明」。把它从「散落的打印语句」升级为「可索引的目录条目」，是为了同时服务两类读者——人能照着「原因 + 修法 + 文档」自助修复，机器能凭稳定编号把报错映射到文档/规则。同时，诊断只在开发期有意义，必须能在生产构建里被无成本地剔除。

- **关键权衡（3 条三段式，本 Atlas 的核心）**：
  - **集中目录 + 三段式条目（编号 / 原因 / 修法 / 文档锚点）** → 换来了「稳定编号可被文档、IDE、agent 索引」「调用点只写一行、文案单点维护」 → 代价是引入一个外部诊断库作为运行时依赖，且所有警告必须遵守目录契约，不能再随手打印。
  - **全部调用点都包 dev 开关 + 构建期把该开关替换为「假」+ 依赖打包器摇树** → 换来了「诊断只在开发期存在，生产零体积、零运行开销」 → 代价是「零成本」并非语言层面的保证，而是一份需共同维护的契约：每个调用点都得守纪律地包开关、构建配置也得配合做替换与裁剪，漏一处就会泄漏到生产。
  - **诊断与输出解耦（报告器可插拔；同一个诊断句柄既能当软警告经报告器打印、又能被抛出当硬错误）** → 换来了「同一套诊断定义既能支撑提醒式警告，也能支撑中断式错误」 → 代价是诊断句柄兼具「触发报告」与「返回可抛对象」两副面孔，走抛错路径时必须刻意不挂报告器，否则同一条消息会被打印两次。

- **最小心智模型（3～7 步）**：
  1. 在目录里声明一个诊断码，附上「为什么触发 / 怎么修 / 去哪看文档」三段信息。
  2. 初始化目录时挂上一组报告器（默认是控制台报告器）。
  3. 框架把每个码编译成一个**可调用的诊断句柄**。
  4. 业务代码在 dev 开关的保护下，按编号调用句柄，并传入当下场景的参数。
  5. 句柄用参数填充「原因」文案，组装成完整诊断，再依次喂给报告器输出。
  6. 生产构建时，dev 开关被替换为「假」，所有调用退化为死代码，整个诊断目录连同其依赖被摇树移除。

- **最小原理演示（替代旧"复刻范围"）**：
  - 应演示：一个几十行的从零实现——一个把「码定义」编译成「可调用句柄」的函数；句柄被调用时拼装出 `{ 编号, 原因, 修法, 文档 }` 并依次喂给报告器列表；一个默认控制台报告器，按级别选择「警告」或「错误」打印；最后演示同一个句柄「作为语句触发报告」与「被 throw 当成错误」两种用法。这段演示演的是**权衡 3（诊断与输出解耦）** 与**心智模型第 1～5 步**。
  - 应故意省略：七个真实码的具体文案、HMR 调用点、测试包的细节、构建矩阵（多目标产物）、文档锚点 URL 的解析、订阅去重等业务逻辑、生产裁剪的构建配置实现（只在概念上提及「开关替换 + 摇树」即可）。

- **正文不宜展开的细节**：外部诊断库的内部实现（源码未随仓库提供，只能从用法推断）；构建矩阵各产物的开关取值差异；测试包自带的那套诊断码（只在「对比抛错用法」时点到为止）；七个码各自触发的完整业务场景（留给对应机制章，本章只举一个跨请求污染的例子）。

- **推荐的一个执行轨迹例子**：输入——用户在组件之外（没有注入上下文）、且运行在服务端时去取用一个 store；关键中间态——取用函数的开发分支命中「实例缺失且不是浏览器」这一条件；输出——按编号触发诊断，报告器以「错误」级别打印「原因 + 修法 + 文档」，而函数本身并不中断、回退去返回全局实例。这条轨迹演的是核心思想：诊断是「可索引、带修法、不阻断运行」的副作用，并且这条路径在生产构建里根本不存在。

> 以上钩子供 Writer 写「动机→核心思想→心智模型→关键权衡→原理演示」；下面事实部分供核对，不要被 Writer 当目录照抄。

## 概念要点

- 全章机制集中在**一个文件**：定义了 7 个面向用户的诊断码（编号 `PINIA_R1001`～`PINIA_R1007`），每条由 `why`（原因）/`fix`（修法）/`docs`（官方文档锚点 URL）三键组成。源码位置: packages/pinia/src/diagnostics.ts:8-51
- 目录经 `defineDiagnostics({ reporters, codes })` 构建，默认挂一个 `createConsoleReporter()` 作为报告器。源码位置: packages/pinia/src/diagnostics.ts:1,8-10
- `why` 有两种形态：无场景参数的码用**常量字符串**（如 R1001、R1004）；需要插值的码用 **`(params) => string` 函数**（如 R1002 带 `name/id`、R1005 带 `from/to`、R1006 带 `key/id`），按需求值。源码位置: packages/pinia/src/diagnostics.ts:11-15,28-32,16-21,33-43
- 调用点统一写成 `diagnostics.PINIA_Rxxx(params[, options])`，把「文案维护」与「触发」彻底解耦。调用点分布在 rootStore(R1004)、mapHelpers(R1001)、store(R1002/R1003/R1006/R1007)、hmr(R1005)。源码位置: packages/pinia/src/rootStore.ts:52；packages/pinia/src/mapHelpers.ts:105；packages/pinia/src/store.ts:185,443,748,763；packages/pinia/src/hmr.ts:108
- 第二参 `options` 可改输出级别：R1004 用 `{ method: 'error' }` 升级为 `console.error`（其余默认 warn 级），因为 SSR 跨请求污染是真正会致错的严重问题。源码位置: packages/pinia/src/rootStore.ts:52
- 外部诊断库是**运行时 `dependencies`**（`^1.1.4`，非 devDependency），且被声明为需内联打包的依赖。这意味着 prod 裁剪必须靠摇树达成，而非「根本不依赖」。源码位置: packages/pinia/package.json:57-59,78-80
- `sideEffects: false` 是摇树的前提——打包器据此敢于删除「未被引用」的诊断模块。源码位置: packages/pinia/package.json:43
- Pinia 4 明确用该诊断库重构了「错误与开发期警告」，CHANGELOG 原文称其让问题「easier to fix, both by humans and by agents」（更易被人与 agent 修复）——印证「可索引编号」的动机。源码位置: packages/pinia/CHANGELOG.md:13,30

## 关键调用链

诊断触发链（「调用点 → 目录句柄 → 报告器」）：
```
业务点 diagnostics.PINIA_Rxxx(params, options?)
  → 句柄用 params 填充 why 文案
  → 组装诊断（编号 + 原因 + 修法 + 文档）
  → 依次喂 reporters[]（默认 createConsoleReporter → console.warn；options.method==='error' 时切 console.error）
```
源码位置: 句柄定义 packages/pinia/src/diagnostics.ts:8-10；典型调用点 packages/pinia/src/rootStore.ts:52

生产裁剪链（「调用点 guard → 构建期开关替换 → 死代码消除 → 模块摇树」）：
```
调用点 dev 开关保护（三种形态）
  → 构建期 define 把 __DEV__ 替换为字面量 false（prod 产物）
  → if(__DEV__){...} 与 __DEV__ ? A : B 退化为死代码 / 常量分支
  → import './diagnostics' 成为无人引用 → 整个诊断目录连同外部诊断库被 tree-shake
```
源码位置: 调用点 guard 见下「dev-only 保障」；构建替换 packages/pinia/tsdown.config.ts:58-61,94-97；裁剪注释 packages/pinia/tsdown.config.ts:50-53,85-88

## dev-only 保障（调用点 guard 的三种形态）

- **三元二选一**（最彻底）：`getActivePinia` 在 dev 版函数体里含 R1004，prod 版函数体是精简回退——构建期直接二选一，prod 连诊断分支都不存在。源码位置: packages/pinia/src/rootStore.ts:47-58
- **显式 `if (__DEV__)` 包裹**：R1001、R1002、R1003、R1006、R1007 均如此。注意 R1006 虽在「插件扩展遍历」里，但整个遍历块外层就有 `if (__DEV__)` 把守。源码位置: packages/pinia/src/mapHelpers.ts:104-106；packages/pinia/src/store.ts:184-186,737-751,756-764,441-446
- **隐式 dev-only（HMR）**：R1005 处于热更新入口，HMR 代码本身只在开发期启用，prod 打包天然不含。源码位置: packages/pinia/src/hmr.ts:100-111
- 构建期 `__DEV__` 的取值由打包配置 `define` 注入：dev/浏览器产物为 `true`，prod 产物（`esm-browser-prod`、`iife-prod`）为 `false`；prod 产物还在 deps 配置里清空 `onlyBundle` 并注释「nostics should be stripped in prod」，dev 的 iife 产物则相反地 `onlyBundle: ['nostics']` 强制打包。源码位置: packages/pinia/tsdown.config.ts:12,40-44,58-61,66-69,77-81,84-98

## 源码摘录（带行号，全文累计 ≤ 30 行）

目录定义骨架（reporters + 三段式条目）：
```ts
// packages/pinia/src/diagnostics.ts
export const diagnostics = /*#__PURE__*/ defineDiagnostics({
  reporters: [/*#__PURE__*/ createConsoleReporter()],
  codes: {
    PINIA_R1001: {
      why: 'Directly pass all stores to "mapStores()" without ... This will fail in production.',
      fix: 'Replace mapStores([useAuthStore, useCartStore]) with mapStores(...).',
      docs: 'https://pinia.vuejs.org/cookbook/options-api.html#...',
    },
    // ...R1002~R1007 同构，why 为字符串或 (params)=>string
```

dev 三元：整段取用函数在构建期二选一（prod 取下方的精简分支）：
```ts
// packages/pinia/src/rootStore.ts
export const getActivePinia = __DEV__
  ? (): Pinia | undefined => {
      const pinia = hasInjectionContext() && inject(piniaSymbol)
      if (!pinia && !IS_CLIENT) {
        diagnostics.PINIA_R1004({}, { method: 'error' }) // 升级为 console.error
      }
      return pinia || activePinia
    }
  : (): Pinia | undefined => (hasInjectionContext() && inject(piniaSymbol)) || activePinia
```

prod 产物把开关 define 为 false 并裁剪依赖：
```ts
// packages/pinia/tsdown.config.ts
const iifeProd = mergeConfig(iife, {
  deps: { /* nostics should be stripped in prod */ onlyBundle: [] },
  // ...
  define: { __DEV__: 'false', __USE_DEVTOOLS__: 'false' },
})
```

## 易混淆 / 边界 / 推断

- **事实**：`getActivePinia` 触发 R1004 后并不抛错或中止，仍 `return pinia || activePinia` 回退到全局实例——诊断是「提醒」而非「拦截」。源码位置: packages/pinia/src/rootStore.ts:52-55
- **事实**：测试包自带一套独立诊断码（`PINIA_TESTING_C0001/C0002`），同样用 `defineDiagnostics`，但**不挂 reporters**，且在调用处用 `throw diagnostics.PINIA_TESTING_C0001()` 抛出。源码位置: packages/testing/src/diagnostics.ts:9-21；packages/testing/src/testing.ts:135,142
- **推断（标注为推断）**：外部诊断库的句柄**兼具「触发 reporters」与「返回可抛对象」两种行为**。依据是测试包「不挂 reporter + throw 句柄返回值」的用法，以及其源码注释明言「attaching a console reporter would print the same message twice」（挂控制台报告器会把同一消息打印两次）。该库实现**未随仓库源码提供**（`node_modules` 未包含），故属推断，非字面事实。源码位置: packages/testing/src/diagnostics.ts:3-8
- **推断（标注为推断）**：基于上一条，`defineDiagnostics` 不传 `reporters` 时，句柄应**不主动输出**、仅返回诊断对象供调用方 throw 或编程读取；传了 reporter 才会经其副作用打印。
- **事实**：`/*#__PURE__*/` 纯函数注解出现在 `defineDiagnostics(...)` 与 `createConsoleReporter()` 之前，配合 `sideEffects:false`，是让 prod 下「未被引用的诊断模块」可被整块摇树删除的辅助标记。源码位置: packages/pinia/src/diagnostics.ts:8-9；packages/pinia/package.json:43
- **未理解**：外部诊断库的内部 reporter 协议、是否有去重/节流、句柄返回值的确切类型（Error 子类？）、`options.method` 支持的全部取值——因库源码未随仓库提供，无法从字面确证，仅能从调用点用法推断。Writer 若需展开实现细节，应显式标注为推断或查阅该库官方文档。
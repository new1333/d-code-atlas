# 诊断目录：dev-only 可索引警告系统

## 1. 动机：为什么警告不该只是「一行 console」

用一个状态库时，你大概见过这样的控制台红字：「Store "x" is not defined」「state must be a plain object」……它们散落在源码各处，措辞随意、没有稳定标识。对**人**来说，看到一行红字却不知道「这是什么问题、怎么修、去哪查」；对**机器**来说（IDE 诊断、文档检索、AI agent），更是无法把这一行报错可靠地对应到某段说明文档——因为文案会随版本变动，没有任何稳定的「钥匙」可供索引。

更隐蔽的代价是**体积**：这些提醒只在开发期有意义，但只要写成普通的 `console.warn(...)`，就会连同其依赖一起被打进生产包，白白增加每一个线上用户的下载量。

本章要讲的，就是 Pinia 4 如何把「面向用户的警告」从「散落的打印语句」重构成一个**可索引的诊断目录**，并让整套能力在生产构建里被无成本剔除。

## 2. 核心思想：把警告当成「数据」

一句话：**把警告当成数据，而不是行为。**

具体来说，把每一条警告抽象成一个带编号的「诊断码」目录条目，每个条目携带四样东西：

- **编号**（如 `PINIA_R1004`）——稳定不变的索引钥匙；
- **原因 why**——为什么会触发；
- **修法 fix**——该怎么改；
- **文档锚点 docs**——去哪个 URL 看完整说明。

调用点（业务代码里真正需要警告的地方）**只报编号**，不再自己拼文案；文案集中维护在目录里；输出交给**可插拔的报告器**（reporter）——默认是一个控制台报告器，但理论上可以换成任何东西。最后，用一个构建期开关 `__DEV__` 把所有调用点挡在生产构建之外。

这样，同一份「错误说明」就能同时服务两类读者：人照着「原因 + 修法 + 文档」自助修复，机器凭稳定编号把报错映射到文档与规则。

## 3. 原语一：诊断码条目（why / fix / docs）

最底层的原语是一个**目录条目**。它有三个固定键：

```ts
// 诊断码条目：三段式结构
const entry = {
  why: 'getter 不能与同名的 state 属性重名，这会在生产环境失败。',
  fix: '重命名 getter 或对应的 state 属性。',
  docs: 'https://pinia.vuejs.org/core-concepts/getters.html#Accessing-other-getters',
}
```

关键细节在 `why` 这一个键上——它有**两种形态**，按是否需要「当下场景的参数」来区分：

```ts
// 形态 A：常量字符串——无需插值
const r1001 = { why: '不要把所有 store 装进数组传给 mapStores()。', fix: '...', docs: '...' }

// 形态 B：函数 (params) => string——需要把场景信息插进文案
const r1002 = {
  why: (p: { name: string; id: string }) =>
    `getter 不能与同名 state 冲突："${p.name}" 出现在 store "${p.id}" 中。`,
  fix: '重命名 getter 或 state 属性。',
  docs: '...',
}
```

无需场景信息的码（如「别把 store 装进数组」）用常量字符串；需要把当前 store 名、属性名、旧值/新值插进文案的码，就用函数、调用时才求值。这把「文案该不该随场景变化」这件事，直接编码进了条目的数据结构。

## 4. 原语二：可插拔的报告器

第二个原语是**报告器**：它接收一个组装好的诊断对象，决定**怎么输出、输出到哪**。诊断的「内容」与「输出」由此彻底解耦。

默认挂的是控制台报告器，它按诊断的**级别**选择 `console` 方法：

```ts
// 报告器：按级别选择 console 方法
function createConsoleReporter() {
  return (diagnostic) => {
    const { code, why, fix, docs, method } = diagnostic
    const log = method === 'error' ? console.error : console.warn
    log(`[${code}] ${why}\n  → ${fix}\n  📖 ${docs}`)
  }
}
```

绝大多数码是软警告，默认走 `console.warn`；但有少数码代表「真正会致错的严重问题」——例如 SSR 下跨请求污染，这类码在调用时显式带上 `{ method: 'error' }`，报告器就会改用 `console.error`。级别不是写死在条目里，而是由调用点按场景决定，这让同一个报告器既能输出「提醒」也能输出「警报」。

## 5. 组合机制：从「码定义」编译成「可调用句柄」

有了条目和报告器两个原语，组合机制要做的是：**把「静态的码定义」编译成「可调用的句柄」**。这一步由 `defineDiagnostics({ reporters, codes })` 完成——它遍历目录里的每个码，为每个码生成一个同名的可调用函数。

调用点因此写得极简，只报编号和当下参数：

```ts
// 调用点：只关心「报哪个码、带什么参数」
diagnostics.PINIA_R1002({ name, id })
diagnostics.PINIA_R1004({}, { method: 'error' })
```

一次调用的内部流转是一条固定的触发链：

```
调用点 diagnostics.PINIA_Rxxxx(params, options?)
  → 句柄用 params 填充 why 文案（函数则求值、常量则直取）
  → 组装诊断 { 编号, 原因, 修法, 文档, 级别 }
  → 依次喂 reporters[]（默认控制台报告器按级别 warn / error）
```

这里有一个值得专门建立的心智模型——**句柄的「两副面孔」**。一个诊断句柄被调用时，同时做两件事：

1. **作为语句**：触发副作用，把诊断依次喂给报告器去打印；
2. **作为表达式**：返回一个结构化的诊断对象，调用方可以拿到它、也可以 `throw` 它。

证据来自测试包的用法：测试包定义了自己的一套诊断码，但**不挂任何报告器**，而是在调用处用 `throw diagnostics.PINIA_TESTING_C0001()` 抛出。其源码注释明言——若再挂一个控制台报告器，同一条消息会被打印两次。由此可以推断：句柄始终会返回一个可抛的对象；当挂了报告器时，打印是它的副作用，当不挂报告器时，它就退化成「只组装、不打印、供调用方自行 throw 或读取」的纯函数。

> 说明：外部诊断库 `nostics` 的内部实现未随仓库源码提供（`node_modules` 未包含），故「句柄返回值的精确类型、是否为 Error 子类、是否有去重/节流」均属**推断**，依据仅是上述调用点用法与注释，非字面事实。

理解了这套「码 → 句柄 → 报告器」的管道，下面两节进入源码对照。

## 6. 源码对照（上）：目录骨架与一条触发轨迹

整章机制集中在一个文件里——7 个面向用户的诊断码（`PINIA_R1001`～`PINIA_R1007`），每条都是上一节讲的三段式条目，`why` 取常量或函数两种形态：

```ts
// diagnostics.ts（节选）
export const diagnostics = /*#__PURE__*/ defineDiagnostics({
  reporters: [/*#__PURE__*/ createConsoleReporter()],
  codes: {
    PINIA_R1001: { why: '...', fix: '...', docs: '...' },
    PINIA_R1002: { why: (p: { name: string; id: string }) => `...`, fix: '...', docs: '...' },
    PINIA_R1004: {
      why: '在上下文中找不到 Pinia 实例，将回退到全局 activePinia，这在服务端会让你暴露于跨请求污染。',
      fix: '把 useStore() 当作普通 composable，在 setup() 顶部调用，或在组件外显式传入 pinia 实例。',
      docs: 'https://pinia.vuejs.org/ssr/#Using-the-store-outside-of-setup-',
    },
    // ...R1003/R1005/R1006/R1007 同构
  },
})
```

注意 `defineDiagnostics(...)` 与 `createConsoleReporter()` 前面都标了 `/*#__PURE__*/`——配合包的 `sideEffects: false`，这是告诉打包器「这两个调用无副作用、未被引用即可整块删除」的关键标记，下一节讲生产裁剪时会用到。

挑 `R1004` 走一遍完整轨迹，最能体现「诊断是可索引、带修法、且**不阻断运行**的副作用」。`R1004` 出现在「取用当前活跃 Pinia」的函数里——这个函数在开发构建和生产构建里是**两副不同的函数体**（dev 版带诊断、prod 版是精简回退，二者在构建期二选一，见 `rootStore.ts:47-58`）：

```ts
// rootStore.ts — getActivePinia 的 dev 分支（prod 产物取不到这副函数体）
export const getActivePinia = __DEV__
  ? (): Pinia | undefined => {
      const pinia = hasInjectionContext() && inject(piniaSymbol)
      if (!pinia && !IS_CLIENT) {
        diagnostics.PINIA_R1004({}, { method: 'error' }) // 升级为 console.error
      }
      return pinia || activePinia // 诊断后照常回退，不抛错、不中止
    }
  : (): Pinia | undefined =>
      (hasInjectionContext() && inject(piniaSymbol)) || activePinia
```

**轨迹**：用户在组件之外（无注入上下文）、且运行在服务端时去取用一个 store → `getActivePinia` 的 dev 分支命中「实例缺失且不是浏览器」→ 调用 `R1004` 并带上 `{ method: 'error' }` → 报告器以 `console.error` 打印「原因 + 修法 + 文档」→ 但函数**并不中断**，继续 `return pinia || activePinia` 回退到全局实例。诊断在这里是「提醒」，不是「拦截」——而这条带诊断的整条路径，在生产构建里根本不存在。

## 7. 源码对照（下）：dev-only 三种守护与生产裁剪

「开发期才需要的诊断，怎么保证不漏进生产？」答案是靠调用点的 **dev 开关守护**，加上构建期的**开关替换与摇树**。守护有三种形态：

- **三元二选一（最彻底）**：整个函数体在构建期 `__DEV__ ? dev版 : prod版` 二选一，prod 连诊断分支都不存在。上节的 `getActivePinia` 即此形态。
- **显式 `if (__DEV__)` 包裹**：`R1001`、`R1002`、`R1003`、`R1006`、`R1007` 均如此，调用点外层就用 `if (__DEV__)` 把守。
- **隐式 dev-only**：`R1005` 处于热更新入口，而该入口函数在非 dev 时**直接提前返回空函数**——连后面的代码都执行不到，prod 天然不含。

有了守护，生产裁剪链就成立了：

```
调用点 dev 开关保护（上述三种形态）
  → 构建期 define 把 __DEV__ 替换为字面量 false（prod 产物）
  → if(__DEV__){...} 与 __DEV__ ? A : B 退化为死代码 / 常量分支
  → import './diagnostics' 成为无人引用 → 整个诊断目录连同 nostics 库被 tree-shake
```

构建期 `__DEV__` 的取值由打包配置的 `define` 注入——prod 产物把它定义成 `'false'`（见 `tsdown.config.ts:58-61`），于是所有 `__DEV__` 守护瞬间坍缩为常量分支被消除；同时 prod 产物在依赖配置里把 `nostics` 从「需内联打包」清单里清空（见 `tsdown.config.ts:50-53`，注释直书「nostics should be stripped in prod」）。两步合起来，整个诊断模块就成了无人引用的死代码，连它依赖的外部库一起被摇树移除。

值得强调的是：`nostics` 在 `package.json` 里是**运行时 `dependencies`**（非 devDependency），并声明为需内联打包的依赖。这意味着「生产零体积」**不是语言层面的保证**，而是一份需共同维护的契约——每个调用点都得守纪律地包 dev 开关、构建配置也得配合做替换与裁剪，漏一处就会泄漏到生产。

## 8. 关键权衡

**① 集中目录 + 三段式条目**，换来「稳定编号可被文档/IDE/agent 索引」「调用点只写一行、文案单点维护」；代价是引入一个外部诊断库作为运行时依赖，且所有警告必须遵守目录契约，不能再随手 `console.warn`。

**② 全部调用点包 dev 开关 + 构建期把开关替换为「假」+ 依赖打包器摇树**，换来「诊断只在开发期存在，生产零体积、零运行开销」；代价是「零成本」靠的是一份纪律契约：每个调用点都得包开关、构建配置也得配合裁剪，漏一处就泄漏。

**③ 诊断与输出解耦（报告器可插拔；同一句柄既能当软警告打印、又能被 throw 当硬错误）**，换来「同一套诊断定义既支撑提醒式警告，也支撑中断式错误」；代价是句柄兼具「触发报告」与「返回可抛对象」两副面孔，走抛错路径时必须刻意不挂报告器，否则同一条消息会被打印两次。

## 9. 最小原理演示

下面用几十行从零实现这套管道，演示**权衡 ③（诊断与输出解耦）** 与**心智模型的第 1～5 步**：一个把码定义编译成句柄的 `defineDiagnostics`、句柄被调用时把诊断喂给报告器列表、一个按级别选择 warn/error 的默认报告器，以及同一句柄「作为语句触发报告」与「被 throw 当成错误」两种用法。

```ts
// 1. 默认控制台报告器：按级别选择 console 方法
function createConsoleReporter() {
  return (d: Diagnostic) => {
    const log = d.method === 'error' ? console.error : console.warn
    log(`[${d.code}] ${d.why}\n  → ${d.fix ?? '(无修法)'}\n  📖 ${d.docs}`)
  }
}

// 2. 编译器：把「码定义」编译成「可调用句柄」
function defineDiagnostics({ reporters = [], codes }: Options) {
  const handles = {} as Record<string, Handle>
  for (const [code, def] of Object.entries(codes)) {
    handles[code] = (params = {}, options = {}) => {
      // 用 params 填充 why（函数则求值、常量则直取）
      const why = typeof def.why === 'function' ? def.why(params) : def.why
      const diagnostic: Diagnostic = { code, why, fix: def.fix, docs: def.docs, ...options }
      // 副作用：依次喂给报告器（挂了 reporter 才打印）
      reporters.forEach((r) => r(diagnostic))
      // 同时返回结构化对象——调用方可忽略、也可 throw
      return diagnostic
    }
  }
  return handles
}

// 3. 声明目录，挂一个控制台报告器
const diagnostics = defineDiagnostics({
  reporters: [createConsoleReporter()],
  codes: {
    APP_E001: { why: (p: { id: string }) => `配置项 "${p.id}" 缺失。`, fix: '补上该配置项。', docs: '...' },
  },
})

// 用法 A：作为语句——触发报告器打印（软警告）
diagnostics.APP_E001({ id: 'token' })
// 控制台输出：[APP_E001] 配置项 "token" 缺失。 → 补上该配置项。 📖 ...

// 用法 B：被 throw——不挂报告器时，同一句柄退化成「只组装、供抛出」
const strict = defineDiagnostics({
  reporters: [], // 不打印，避免「打印一次 + throw 再打印一次」
  codes: { APP_E002: { why: '创建 spy 失败。', fix: '传入 vi.fn 本身，而非 vi.fn()。', docs: '...' } },
})
throw strict.APP_E002() // 抛出的错误自带结构化消息
```

这段演示故意省略了真实七码的具体文案、HMR 调用点、测试包细节、构建矩阵各产物的差异、文档锚点 URL 的解析，以及生产裁剪的构建配置实现——后两者本章只在概念上提了「开关替换 + 摇树」。

## 10. 源码出处

- `packages/pinia/src/diagnostics.ts` — 目录定义：7 个码（`PINIA_R1001`～`R1007`）、默认控制台报告器、`/*#__PURE__*/` 纯函数注解。
- `packages/pinia/src/rootStore.ts` — `getActivePinia` 的 dev/prod 三元函数体与 `R1004` 调用（`{ method: 'error' }` 升级、`pinia || activePinia` 非阻断回退）。
- `packages/pinia/src/store.ts` — `R1002`/`R1003`/`R1006`/`R1007` 调用点，均位于 `__DEV__` 守护块内。
- `packages/pinia/src/mapHelpers.ts` — `R1001` 调用点（`if (__DEV__ && Array.isArray(...))`）。
- `packages/pinia/src/hmr.ts` — `R1005` 调用点；`acceptHMRUpdate` 在非 dev 时提前返回空函数。
- `packages/pinia/tsdown.config.ts` — 构建矩阵与 prod 产物配置（`define: { __DEV__: 'false' }`、`onlyBundle: []` 裁剪 `nostics`）。
- `packages/pinia/package.json` — `sideEffects: false`、`nostics` 列为运行时 `dependencies` 并声明 `inlinedDependencies`。
- `packages/testing/src/diagnostics.ts` — 独立测试码（`C0001`/`C0002`），**不挂报告器**、以 `throw` 上报；注释印证「挂报告器会重复打印」。
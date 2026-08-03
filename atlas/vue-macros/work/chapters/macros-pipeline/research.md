# 主聚合插件与转换管道顺序编排 · 源码精读

## 给 Writer 的教学钩子（必填，8 子项缺一不可）

- **用户痛点 / 场景**：一个 Vue 项目同时想用二十多个语法糖宏（defineModels、shortEmits、betterDefine、setupComponent…）。如果让用户自己在 vite/webpack 配置里逐个注册、自己排先后，几乎一定排错：比如「先把类型降级成运行时校验」跑在「合成 model 的 props」之前，校验就丢了字段；又如「改写内联子组件」的后期步骤跑在 Vue 编译器之前，就根本看不到编译产物。用户要的不是「一堆插件」，而是「一个能自动把它们按正确顺序串起来的总入口」。

- **一句话核心思想**：**顺序即语义**——管道里每个宏的位置就是它的语义边界，那张写死的插件数组既是装配清单，也是一张隐式依赖图。

- **设计动机（为什么需要它）**：这个编排层为了解决一个矛盾——宏之间有**隐式数据依赖**（后一个要看到前一个改写后的代码），但每个宏又想保持独立、可单测、可单独关闭。解法是把「注册顺序」这件事从用户手里收走，固化成一份集中编排的静态数组，让依赖关系由位置隐式表达。
  - 承前（跨章去重）：「宏用工厂包裹纯转换函数、按构建器分发到六套 bundler」——（已在第 2 章『unplugin-multi-bundler』讲透，本章只看它的**组合层**新侧面：用 combine 工厂把所有宏收进单一实例，只做一次 framework 探测、共享单一插件名与 include/HMR 注入点）。
  - 承前：「按 Vue 版本号给特性默认开关」——（已在第 13 章『config-version-aware』讲透，本章只看它的产物被当作「启用/禁用」开关传进编排：解析为 false 的特性直接不进管道）。
  - 承前：「内联子组件 / 命名模板各有前后两阶段改写」——（已在第 8 章『sfc-structure-extensions』与第 10 章『template-and-render-redirect』讲透，本章只看编排层新侧面：同一特性的两个插件实例必须被分别插到 Vue 编译器的前后）。
  - 承前：「把类型降级为运行时校验」——（已在第 6 章『better-define』讲透，本章只看它的**插队位置**：必须排在 props/emits/models 合成之后、单字段 prop 之前）。

- **关键权衡（核心原料）**：
  1. **把管道顺序硬编码成一份写死的静态数组** → 换来宏之间隐式数据依赖的确定、可读（类型降级宏一定能看到已被合成/重写的 props）→ 代价是新增宏必须由维护者人工找准插队位置，错位即语义错乱且不易察觉（产物能跑但行为悄悄变了）。
  2. **用 combine 工厂把全部宏收进一个组合实例，而非让用户各注册各的** → 换来一次 framework 探测、单一插件名、所有宏共享同一套 include/HMR 注入点、用户只装一个插件 → 代价是全部宏被绑死在同一数组里，灵活性让位给编排确定性；禁用某个宏只能靠配置里把它置 false，而不是「不装那个包」。
  3. **让同一特性拆成「前置/后置」两个插件实例，分别插在 Vue 编译器的前后** → 换来「前置阶段改写源码形态、后置阶段改写 Vue 编译产物（如默认导出的组件对象、createVNode 调用）」的两次介入能力 → 代价是这类特性的工厂返回的是数组，编排层必须记得把它的第 0 项放前面、第 1 项放到 Vue 插件之后，漏放任一项特性就「半残」。
  4. **把官方 Vue/JSX 编译插件作为「中段」由编排层注入**（排在所有类型/结构改写之后、渲染相关宏之前）→ 换来用户无需自己注册官方插件，且全局保证「宏先改写源码、Vue 后编译 SFC」的顺序 → 代价是 Vue 插件实例须由用户在配置里传入（编排层不替你创建），形成耦合点。

- **最小心智模型（管道组装，6 步）**：
  1. 用户调用总入口（并选 .vite()/.webpack() 等），触发 combine 工厂；工厂拿到一个「当前是哪个构建器」的标记。
  2. 异步解析配置：加载配置文件 + 探测 Vue 版本，把每个特性解析成「实际选项」或「false（不启用）」。
  3. 工厂返回 { 名字, plugins: 一份按固定顺序排好的插件数组 }；顺序为：结构扩展 → props → emits → props&emits 合成 → 类型降级 → 单字段 prop → 其它改写 → 官方 vue/jsx → 渲染/后置阶段 → devtools。
  4. 逐项实例化：该项是 false 就直接返回 undefined（该宏不进链）；否则按当前构建器取出对应插件；前置/后置类特性返回的是含两个插件的数组。
  5. 数组末尾过滤掉所有 undefined（被禁用、或不支持当前构建器的项），得到最终扁平插件链。
  6. 组合层把这条链按数组顺序交给构建器；同一特性的两项因分别排在 Vue 编译器前后，而实现「前后两阶段」介入。

- **最小原理演示（替代旧"复刻范围"）**：
  - **应演示**：一个极简「管道组装器」。定义每个宏是一个纯函数 `run(code) => code`，外加 `{ phase: 'pre' | 'normal' | 'post', enabled }` 元数据；组装器按 [所有 pre] → [normal 按依赖序] → [官方编译这一步] → [所有 post] 输出管道函数。然后用两段 mock 演示核心思想：(a) 「类型降级」宏排在「合成 model」之后 → 运行时校验里能看到 model 字段；(b) 故意把「类型降级」提前 → 校验丢字段，结果错误。这段演示演的是**权衡 1（顺序即语义）**和**权衡 3（前后两阶段拆分）**。
  - **应故意省略**：真实的 unplugin/babel/SFC 解析、各宏内部真正的改写逻辑、构建器分发细节、HMR、sourcemap。不追求工程完整，只追求「演透顺序如何决定结果」。
  - **演示载体建议**：本章主语言是 TS/JS，建议写成一段能被 `node`/`bun run` 直接跑的独立脚本（几十行）。宏就用 `(code) => code` 的字符串变换模拟（如 defineModels 往 code 里塞一段 props、betterDefine 扫描 props 生成校验对象）；不需要真的接 unplugin 或 Vue 编译器——载体服务于「演透原理」，不是「能跑 Vue」。

- **正文不宜展开的细节**：插件名由一个构建期宏在打包时生成（见源码里 `with { type: 'macro' }` 的 import）——属工程脚手架，一笔带过；为兼容 dev 预构建而把自身某个子路径排除出依赖优化的补丁——dev 期兼容细节；某些语法糖「尚不是标准 unplugin」、只在部分构建器启用——历史过渡；另有给 IDE/volar 用的「宏类型聚合声明」（把多个同名宏的类型做交集合并）——属第 15 章 IDE 镜像，本章不展开；配置解析的异步化——第 13 章已讲。

- **推荐的一个执行轨迹例子**：
  - 输入：一个用 defineModels + 旧式 shortEmits 的 `.vue`，构建器=vite，Vue 3.2（故 shortEmits、defineOptions 默认开，booleanProp/setupSFC 默认关）。
  - 关键中间态：combine 工厂被 `.vite()` 触发 → 配置解析把 booleanProp/setupSFC 标为 false → 组装出插件数组 → false 项实例化时返回 undefined、被过滤掉 → 链里保留 [SetupComponent 前置, …, ShortEmits, DefineModels, BetterDefine, …, vue, vueJsx, …, SetupComponent 后置, Devtools]。
  - 输出：一条按序执行的链——DefineModels 先把 model 注入 props/emits 类型 → BetterDefine 随后看到完整类型并降级为运行时校验对象 → vue 编译 SFC → SetupComponent 后置改写编译产物里的组件默认导出。最终得到带运行时校验 + 双向绑定的可运行组件代码。
  - 反例（演核心思想）：若 BetterDefine 被错排到 DefineModels 之前，它看不到 model 注入的 props，运行时校验缺字段——这就是「顺序错位 = 语义错乱」。

> 以上钩子供 Writer 写「动机→核心思想→心智模型→关键权衡→原理演示」；下面事实部分供核对，不要被 Writer 当目录照抄。

## 概念要点

- 主入口用 combine 工厂创建一个「组合插件实例」：它本身带有 `.vite`/`.webpack`/`.rollup`/`.esbuild`/`.rspack`/`.rolldown` 等属性，各框架入口文件（vite.ts 等）只是 `export default unplugin.vite`——即组合实例天然支持按构建器分发，与前置章「单宏用 createUnplugin 分发」是同一思想在**聚合层**的复用。源码位置: packages/macros/src/index.ts:52-54, packages/macros/src/vite.ts:1-3, packages/macros/src/esbuild.ts:1-3

- 工厂函数体内是一个**异步 IIFE** 先 `await resolveOptions(userOptions)`，再用得到的 `options` 与 `meta.framework` 组装插件数组。异步是为了支持「加载配置文件 + 探测 Vue 版本」（第 13 章）。源码位置: packages/macros/src/index.ts:57-60

- 插件数组是**手工排序的静态清单**，顺序即语义，分组清晰：结构扩展段（setupSfc/setupComponent[0]/setupBlock/scriptLang/vueRouter/namedTemplate[0]）→ props（chainCall/defineProps/definePropsRefs/exportProps）→ emits（defineEmit/shortEmits）→ props&emits 合成（defineModels）→ 类型降级为运行时（betterDefine）→ 单字段 runtime prop（defineProp）→ 其它改写（slots/stylex/exportRender/exportExpose/jsxDirective/reactivityTransform/hoistStatic/defineOptions）→ 框架限定的语法糖 → 官方 vue/vueJsx → 渲染与后置（defineRender/setupComponent[1]/namedTemplate[1]）→ devtools/预构建排除。源码位置: packages/macros/src/index.ts:72-146

- 「类型降级（betterDefine）必须排在 props/emits/models 之后」是全链最关键的依赖：betterDefine 要把已重写、已合成的 props 类型降级成运行时校验对象，故紧跟 defineModels 之后、defineProp 之前。源码位置: packages/macros/src/index.ts:90-97

- 「同一特性拆前后两插件」的证据：setupComponent 与 namedTemplate 的工厂返回**数组**（`UnpluginInstance<..., true>`），第 0 项是前置插件（enforce:'pre'，改写源码/抽取），第 1 项是后置插件（enforce:'post'，改写 Vue 编译产物）。编排层据此把 `?.[0]` 放结构扩展段、`?.[1]` 放 vue 插件之后。源码位置: packages/macros/src/index.ts:74,78,140,141；packages/macros/src/index.ts 复用 packages/setup-component/src/index.ts:132-138 与 packages/named-template/src/index.ts:116-122

- `resolvePlugin` 是「可选实例化 + 按构建器分发」的中枢：`options` 为 false 时直接 return（该宏不进链），否则 `return unplugin[framework](options)` 取出当前构建器的插件。其 TS 重载用第二泛型 `true`/`false` 区分「返回数组（多实例）」还是「返回单个」。源码位置: packages/macros/src/core/plugin.ts:5-24

- 「禁用」与「不支持当前构建器」统一收敛为数组里的 undefined，最后 `.filter(Boolean)` 一次性抹平——所以数组里大量占位 undefined 是无害设计，换来「配置即开关」的统一表达。源码位置: packages/macros/src/index.ts:146

- 官方 vue/vueJsx 插件由用户在配置 `plugins.vue`/`plugins.vueJsx` 传入，编排层把它们注入到管道中段（所有类型/结构宏之后、渲染宏之前），保证「宏先改写、Vue 后编译」。源码位置: packages/macros/src/index.ts:137-138；options.plugins 类型见 packages/macros/.../config: packages/config/src/options.ts:50-61

- `excludeDepOptimize` 是仅 vite 的兼容补丁：返回一个 vite 插件，把 `'vue-macros/macros'` 加入 `optimizeDeps.exclude`，避免 dev 预构建（esbuild 扫描）处理不了主包里那个带 `with { type: 'macro' }` 的 import attribute。源码位置: packages/macros/src/core/exclude-macros.ts:3-14，被用于 packages/macros/src/index.ts:145

- devtools 面板仅 vite 注入；booleanProp/shortBind/shortVmodel「尚不是 unplugin」（源码注释明说 `as any`）且仅在 vite/rollup/rolldown 启用——按能力可用性裁剪。源码位置: packages/macros/src/index.ts:112-135,142-145

## 关键调用链

用户调用总入口 → combine 工厂 `(userOptions, meta) => { name, plugins }`
→ `await resolveOptions(userOptions)`（加载配置+探测版本，第 13 章）
→ 对每个特性 `resolvePlugin(Unplugin, meta.framework, options.xxx)`
  ├─ options.xxx === false → return undefined
  └─ else → `unplugin[framework](options)` → 该构建器插件（前置/后置类返回 [Pre,Post]）
→ 组装为按固定顺序的 `OptionsPlugin[]` → `.filter(Boolean)` → 扁平插件链
→ combine 按数组顺序交给 bundler；同一特性的 [0]/[1] 因分置 vue 前后而实现两阶段介入

源码位置: packages/macros/src/index.ts:54-151，辅助 packages/macros/src/core/plugin.ts:17-24

## 源码摘录（带行号，全文累计 ≤ 30 行）

顺序即语义的核心证据——类型降级必须紧跟 props/emits/models 合成之后（packages/macros/src/index.ts:90-97）：
```ts
90│          // both props & emits
91│          resolvePlugin(VueDefineModels, framework, options.defineModels),
92│ 
93│          // convert to runtime props & emits
94│          resolvePlugin(VueBetterDefine, framework, options.betterDefine),
95│ 
96│          // runtime props
97│          resolvePlugin(VueDefineProp, framework, options.defineProp),
```

同一特性拆前后两段、分置 vue 编译器前后（packages/macros/src/index.ts:73-78 与 139-141）：
```ts
73│          resolvePlugin(VueSetupSFC, framework, options.setupSFC),
74│          setupComponentPlugins?.[0],
75│          resolvePlugin(VueSetupBlock, framework, options.setupBlock),
76│          resolvePlugin(VueScriptLang, framework, options.scriptLang),
77│          options.plugins.vueRouter,
78│          namedTemplatePlugins?.[0],
```
```ts
139│          resolvePlugin(VueDefineRender, framework, options.defineRender),
140│          setupComponentPlugins?.[1],
141│          namedTemplatePlugins?.[1],
```

resolvePlugin：false 即短路、否则按 framework 分发（packages/macros/src/core/plugin.ts:22-23）：
```ts
22│   if (!options) return
23│   return unplugin[framework](options)
```

为何 setupComponent 返回数组——它同时注册前置与后置两个插件（packages/setup-component/src/index.ts:132-136）：
```ts
132│ const plugin: UnpluginInstance<Options | undefined, true> = createUnplugin(
133│   (options = {}, meta) => {
134│     return [PrePlugin.raw(options, meta), PostPlugin.raw(options, meta)]
135│   },
136│ )
```

## 易混淆 / 边界 / 推断

- **事实**：combine 工厂返回的对象类型为 `UnpluginCombineInstance`，其上的 `.vite/.webpack/...` 由 unplugin-combine 提供；work/source 是纯 git 克隆不含 node_modules，故该类型定义未在源码内直接读到，其行为由本文件用法推断。
- **推断（标注为推断）**：`import { generatePluginName } from '#macros' with { type: 'macro' }` 中的 `#macros`（Node subpath import）与 `with { type: 'macro' }`（import attributes）大概率由根 devDep `unplugin-macros` 在构建期解析——把 `generatePluginName()` 替换成基于包名的字符串（如各包里 `const name = generatePluginName()`）。source 内未见 `#macros` 的 imports 映射定义（构建期/工具链处理），故标为推断；它属工程脚手架，不影响管道语义。
- **推断（标注为推断）**：`excludeDepOptimize` 排除 `'vue-macros/macros'` 的直接动机推断为——主包自身用了上述 macro import，vite 的 dep 预扫描（esbuild）无法处理该 attribute，故排除之让其在 dev 走插件链而非预打包。源码注释未直接说明，标为推断。
- **事实**：setupComponent 的 PostPlugin 与 namedTemplate 的 PostPlugin 都额外声明了 `rollup.transform.order:'post'`，因为 rollup 不认 vite 的 `enforce`，需显式指定后置顺序——这是「同一特性跨构建器表现一致」的工程补丁。源码位置: packages/setup-component/src/index.ts:119-127, packages/named-template/src/index.ts:104-113
- **事实**：`macros.d.ts` / `macros-global.d.ts` 是给 IDE/volar 用的「宏类型聚合声明」（re-export 各包的 /macros 类型，并用 UnionToIntersection 把 chain-call 的 defineProps、definePropsRefs 的 withDefaults 等同名宏类型做交集合并），不属于转换管道本身——属第 15 章 IDE 镜像范畴。源码位置: packages/macros/macros.d.ts:1-32, packages/macros/macros-global.d.ts:1-14
- **未理解**：`options.plugins.vueRouter` 在管道结构扩展段被注入（index.ts:77），但 vue-router 插件实例如何与宏协作（是否有顺序依赖）在 sourceFiles 范围内未见依据，留给后续章或 Architect 判断。
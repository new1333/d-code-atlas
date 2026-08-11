# 主聚合插件与转换管道顺序编排

> 本章属于 system 层。前置：「统一配置体系与版本感知默认值」等几乎所有宏相关章节。
> 学完你能：用一句话说清为什么 vue-macros 把二十多个宏按一张写死的数组串成管道、而不是让用户各注册各的——以及这张数组的位置编号就是宏之间的隐式依赖图。

## 1. 为什么需要它（设计动机）

上一章把三十多个特性收敛成了一张带版本条件的开关表，每个特性都能被解析成「实际选项」或「false（不启用）」。但这只回答了「开关在哪」——还有另一件事没回答：**开关打开之后，宏之间到底按什么顺序跑？**

想象一个用户同时用着 `shortEmits`（旧式缩写 emit 类型）、`defineModels`（双向绑定）、`betterDefine`（把类型降级成运行时校验）。这三件事彼此有依赖：`shortEmits` 先把 `{ click: void }` 改写成 `{ click: [] }` 这种标准 emit 类型 → `defineModels` 把 model 字段同时注入到 props 和 emits 的类型交集里 → `betterDefine` 才能扫到完整的 props/emits 类型，把它降级成 `{ type, required, default }` 的运行时对象。如果你让用户自己在 vite 配置里写 `plugins: [shortEmits(), defineModels(), betterDefine()]`，他大概率会写错顺序——而且写错之后产物照样能跑，只是运行时校验**悄悄**缺了 model 字段，调试半天才意识到。

这种问题不能靠「让用户自己负责」。它要求有一个总入口替用户把所有宏按正确顺序串起来、把依赖关系隐藏在位置编号里——这就是 vue-macros 的主聚合插件 `vue-macros/macros`。

## 2. 核心思想

**顺序即语义**——管道里每个宏的位置就是它的语义边界，那张写死的插件数组既是装配清单，也是一张隐式依赖图。

换句话说：位置编号本身就是依赖关系。

## 3. 心智模型

主入口是一个**组合插件工厂**——一个普通函数 `(userOptions, meta) => { name, plugins }`，它干六件事：

1. **触发分发**：用户调用总入口的 `.vite()` / `.webpack()` / `.rollup()` 之一，工厂据此拿到「当前是哪个构建器」的标记。
2. **解析配置**：异步 `await resolveOptions(userOptions)`——加载配置文件 + 探测 Vue 版本（上一章已讲），把每个特性解析成「实际选项」或「false」。
3. **按固定顺序列出插件数组**：工厂返回的 `plugins` 是一份手工排好的静态清单，分组大致是：结构扩展（setup-sfc / setup-component 前置 / setup-block / named-template 前置）→ props（defineProps / chainCall / exportProps）→ emits（defineEmit / shortEmits）→ props&emits 合成（defineModels）→ 类型降级（betterDefine）→ 单字段 prop（defineProp）→ 其它改写（slots / jsx / reactivity / hoist / defineOptions）→ 官方 `vue` / `vueJsx` → 渲染与后置（defineRender / setup-component 后置 / named-template 后置）→ devtools。
4. **可选实例化**：数组每一项跑一次 `resolvePlugin(unplugin, framework, options.xxx)`——`options.xxx === false` 直接返回 `undefined`（该宏不进链）；否则 `unplugin[framework](options)` 取出当前构建器对应插件。前置/后置类特性（setup-component、named-template）的工厂返回的是**数组**——第 0 项是前置插件、第 1 项是后置插件。
5. **过滤掉所有 `undefined`**：被禁用或不支持当前构建器的项被一次性抹平。
6. **链交给构建器**：组合层把这条扁平链按数组顺序交出去；同一特性的前置/后置因分别排在 vue 编译器前后而实现两阶段介入。

一句话：用户只装一个插件，背后是一条替他排好序、替他裁掉禁用项、替他把双阶段特性分置编译器前后的流水线。

## 4. 关键权衡（本章重头戏）

### 把管道顺序硬编码成一份写死的静态数组

`packages/macros/src/index.ts` 里的 `plugins: [...]` 是**手工排好的静态清单**——`shortEmits` 永远在 `defineModels` 之前，`betterDefine` 永远紧跟 `defineModels` 之后。

这个选择换来的是宏之间**隐式数据依赖**的确定与可读：类型降级宏（betterDefine）跑的时候一定能看到已被 shortEmits 重写、被 defineModels 注入字段的 props 类型——无须任何显式依赖声明。

代价是**新增宏必须由维护者人工找准插队位置**——错位即语义错乱，且产物**能跑**只是行为悄悄变了，CI 不会红。这里化解的本质矛盾是：**「依赖关系的确定表达」与「依赖关系的隐式表达」之间的取舍**。显式 DAG（声明依赖、运行时拓扑排序）更安全但更重，对一个二十几项、相对稳定的宏集合是过度工程；静态数组让依赖变成「读代码就能看见」的常识，代价是把维护责任压在了维护者身上。

### 用 combine 工厂把全部宏收进一个组合实例

为什么不发 20 个独立插件、让用户在 vite 里 `plugins: [...]` 各注册各的？因为 combine 工厂一次性换来几件事：**一次 framework 探测**（不用每个宏各自调一次 `meta.framework`）、**单一插件名**（devtools 里只看到一个 `vue-macros`）、**所有宏共享同一套 include/HMR 注入点**、**用户只装一个插件**。

代价是**全部宏被绑死在同一数组里**——灵活性让位给编排确定性。你不能再「只装 defineModels、不要 shortEmits」这种轻量组合；想关掉某个宏只能靠配置里 `defineModels: false`（上一章那张开关表派上了用场），而不是「不装那个包」。这里化解的本质矛盾是：**「集中编排带来的可预测性」与「按需装配带来的灵活性」之间的取舍**。一个面向全社区的库选了前者——大多数用户其实只想「装一次就能用全部」，并不想自己拼装。

### 让同一特性拆成前置/后置两个插件实例

`setup-component` 和 `named-template` 的工厂返回**数组**——前者要先把内联子组件的函数体抽成虚拟 `.vue` 子模块（前置、改写源码形态），后者要等 Vue 编译器跑完之后再去改写编译产物里的 `_createVNode` 调用（后置）。两次介入靠的是把这两项**分别插到 vue 编译器的前和后**。

换来的是「前置阶段改写源码、后置阶段改写 Vue 编译产物」的两次介入能力——同一个宏能在生命周期两个时机干两件不同的事。

代价是这类特性的工厂返回的是**含两个插件的数组**，编排层必须记得把 `?.[0]` 放前面、`?.[1]` 放到 Vue 插件之后，**漏放任一项特性就「半残」**——比如只放了前置、漏了后置，setup-component 抽出的子模块永远没人改写回来，编译报错且定位困难。这里化解的本质矛盾是：**「单插件单职责」与「单特性跨编译阶段」之间的取舍**。拆两半是为了让一个能力（内联子组件）在源码层和编译产物层各干一件事，但它强迫编排层承担「正确分置两项」的责任。

### 把官方 vue/vueJsx 编译插件作为管道「中段」由编排层注入

宏在源码层改写完后，最终要交给 Vue 官方编译器（编译 SFC、JSX）。vue-macros 没让用户自己注册 vue 插件——而是把用户**已经创建好的** vue 插件实例（`options.plugins.vue` / `options.plugins.vueJsx`）插到管道中段：所有类型/结构宏之后、渲染相关宏之前。

换来的是**全局保证「宏先改写源码、Vue 后编译 SFC」的顺序**——用户无须自己排这个顺序，也不会因为忘了装 vue 插件导致整条链失效。

代价是 Vue 插件实例须**由用户在配置里传入**——编排层不替你创建，因为 vue 插件实例往往带有用户自定义选项（template 编译选项、jsx 选项等），编排放进来是耦合点。这里化解的本质矛盾是：**「管道要保证完整语义」与「vue 插件实例归用户所有」之间的取舍**。编排层选了「我只编排、不替你创建」，把 vue 插件的所有权留在用户手上，但用它在中段的位置来保证整条链的语义完整。

## 5. 最小原理演示

下面这段脚本演透两件事：**(a) 顺序即语义**——同一组宏按不同顺序跑出不同结果；**(b) 同一特性可拆前后两阶段**——分别插在「编译器」前后。宏用 `(code) => code` 的字符串变换模拟，不接真实 unplugin，不接 Vue 编译器。

```ts
type Phase = 'pre' | 'normal' | 'post'
type Macro = {
  name: string
  phase: Phase
  enabled: boolean
  run: (code: string) => string
}

// 每个宏就是一个对 code 做字符串变换的纯函数
const shortEmits: Macro = {
  name: 'shortEmits',
  phase: 'normal',
  enabled: true,
  run: (code) => code.replace('emits: { click: void }', "emits: { click: [] }"),
}

const defineModels: Macro = {
  name: 'defineModels',
  phase: 'normal',
  enabled: true,
  run: (code) => code.replace('emits: {', "emits: { 'update:title': [], ").replace('props: {', "props: { title: String, "),
}

// betterDefine 扫描此刻 props/emits 字段、生成运行时校验对象
const betterDefine: Macro = {
  name: 'betterDefine',
  phase: 'normal',
  enabled: true,
  run: (code) => {
    const propsFields = (code.match(/props:\s*\{([^}]*)\}/)?.[1] ?? '').trim()
    const emitsFields = (code.match(/emits:\s*\{([^}]*)\}/)?.[1] ?? '').trim()
    return code + `\n// runtime: { props: {${propsFields}}, emits: {${emitsFields}} }`
  },
}

// 模拟官方 Vue 编译器：源码改写完，统一编译成渲染产物
const vueCompiler: Macro = {
  name: 'vue',
  phase: 'normal',
  enabled: true,
  run: (code) => `/* Vue compiled */\n${code}`,
}

// 一个想拆前后两阶段的特性：前置抽源码、后置改编译产物
const setupComponentPre: Macro = {
  name: 'setupComponent[0]',
  phase: 'pre',
  enabled: true,
  run: (code) => code.replace('inline-component:', 'inline-component-from-submodule:'),
}
const setupComponentPost: Macro = {
  name: 'setupComponent[1]',
  phase: 'post',
  enabled: true,
  run: (code) => code.replace('/* Vue compiled */', '/* Vue compiled, post-rewritten */'),
}

// 组装器：按 [所有 pre] → [normal 按给定顺序] → [vue 编译] → [所有 post] 拼管道
function assemble(macros: Macro[]): (code: string) => string {
  const pre = macros.filter((m) => m.enabled && m.phase === 'pre')
  const normal = macros.filter((m) => m.enabled && m.phase === 'normal')
  const post = macros.filter((m) => m.enabled && m.phase === 'post')
  return (code) =>
    [...pre, ...normal, ...post].reduce((acc, m) => m.run(acc), code)
}

const source = `inline-component: X\nemits: { click: void }\nprops: {}`

// 场景 A：正确顺序——shortEmits → defineModels → betterDefine → vue
const pipelineA = assemble([
  setupComponentPre,
  shortEmits,
  defineModels,
  betterDefine,
  vueCompiler,
  setupComponentPost,
])
console.log(pipelineA(source))
// 校验对象里同时包含 click、update:title、title 三个字段——全链生效

// 场景 B：故意把 betterDefine 提到 defineModels 之前
const pipelineB = assemble([
  setupComponentPre,
  shortEmits,
  betterDefine, // 错位
  defineModels,
  vueCompiler,
  setupComponentPost,
])
console.log(pipelineB(source))
// 校验对象里缺 title / update:title——产物照样能跑，但运行时校验悄悄缺字段
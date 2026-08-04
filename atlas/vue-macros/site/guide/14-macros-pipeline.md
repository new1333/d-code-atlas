---
title: "主聚合插件与转换管道顺序编排"
---

# 主聚合插件与转换管道顺序编排

想象你接手一个 Vue 项目，要同时上 defineModels、shortEmits、betterDefine、setupComponent、namedTemplate……二十多个宏。你最不希望做的事，是去 vite 配置里把这二十多个插件按手写顺序排好——一定排错。比如把「类型降级」排到「合成 model」之前，运行时校验就丢字段；又比如把「内联子组件」的后置改写排到 Vue 编译之前，它根本看不到编译产物。

这一章要讲的就是：vue-macros 主入口怎么把这件事从用户手里接过来，固化成一份写死的静态清单——你只装一个包，它替你按正确顺序串好。

## 核心思想：顺序即语义

这条管道的精髓就一句话：**插件在数组里的位置，就是它的语义边界**。那张手工排好的数组既是装配清单，也是一张隐式依赖图——只不过这张图没有边、没有箭头，全靠位置前后表达「谁要先跑」。位置在前意味着「我要先改写源码，后面的人才能看到改完的样子」；位置在后意味着「我前面那些改写都已经发生过了」。

为什么必须写死、不让用户自己排？因为这些宏之间有**隐式数据依赖**——后一个要看前一个改写后的代码。这种依赖没法靠类型系统或运行时检查兜底：你排错了，代码照样能跑，但行为悄悄变了（比如校验少检查一个字段，没人会立刻发现）。所以最稳的办法就是：依赖关系由位置隐式表达，用户碰不到。

## 自底向上：先把每个宏变成「可选插件」

整条管道最底层是一个小函数 `resolvePlugin`：

```ts
function resolvePlugin(unplugin, framework, options) {
  if (!options) return                  // 配置里置 false → 直接 undefined
  return unplugin[framework](options)   // 否则按构建器取出 vite/webpack/... 版本
}
```

它做两件事：

- **配置即开关**：用户在某宏的配置里写 `false`，这个函数返回 `undefined`，该宏不进链。
- **按构建器分发**：传 `framework='vite'`，就调用 `unplugin.vite(options)` 取出 vite 版插件；传 `'webpack'` 就是 webpack 版。「单宏用工厂包裹纯转换函数、按构建器分发到六套 bundler」这件事第 2 章已展开，本章只看它在聚合层怎么被消费。

返回 `undefined` 而不是「跳过」，是为了让最末尾一个 `.filter(Boolean)` 就能把所有「被禁用」「不支持当前构建器」的项一次性抹平。所以数组里出现几个 `undefined` 是无害设计——它换来「配置即开关」的统一表达，外加配置加载层（第 13 章已讲的版本感知默认值）只需要把不达门槛的特性置 `false`，下游编排就能透明地剔除它。

## 静态数组：一张隐式依赖图

把所有 `resolvePlugin(...)` 调用按写死的顺序排成一排，整张图大概长这样：

```
结构扩展            →   props              →   emits           →   props&emits 合成  →  类型降级
setupSfc                chainCall              defineEmit           defineModels         betterDefine
setupComponent[0]       defineProps            shortEmits
setupBlock              exportProps
namedTemplate[0]
vueRouter

→   单字段 prop        →   其它改写           →   官方 vue/vueJsx  →   渲染与后置
    defineProp             slots                  (用户传入)            defineRender
                           jsxDirective                                setupComponent[1]
                           reactivityTransform                         namedTemplate[1]
                           hoistStatic

→   devtools
```

分组很清晰，可以记成五个阶段：

1. **结构扩展**：先改文件形态——整文件即 setup、加 setup 块、内联子组件前置抽取、命名模板前置。
2. **类型与声明展开**：props、emits、models、类型降级、单字段 prop 依次落定。
3. **其它改写**：JSX 指令、响应式语法糖、静态提升等。
4. **官方编译**：vue 与 vueJsx 插件由编排层在这一步注入。
5. **后置与渲染**：内联子组件后置、命名模板后置、defineRender、devtools。

注意中间的「官方 vue/vueJsx」是一道分水岭。它**之前**所有宏看到的是「Vue 编译之前的源码」（SFC 文本、script setup 块），它**之后**所有宏看到的是「Vue 编译之后的产物」（渲染函数、createVNode 调用）。同一特性如果两阶段都要介入，就得拆成两个插件实例，分别插在分水岭前后。

## 最关键的依赖：类型降级必须排在中段

整条管道里最容易踩错、也最值得单独点名的一条依赖：

> **betterDefine（类型降级）必须紧跟在 defineModels 之后。**

为什么？因为 defineModels 会把 model 字段同时注入到 props 与 emits 的类型交集里，betterDefine 的活儿就是把这些类型降级成 `{ type, required, default }` 的运行时校验对象。如果 betterDefine 跑在 defineModels 之前，它根本看不到 model 注入的 props，运行时校验就会少检查一个字段——代码能跑，但悄悄丢了一个字段的类型保护。「类型降级」这件事本身的原理第 6 章已展开，本章只看它的**插队位置**为什么不能动。

源码里它俩就紧挨着排：

```ts
// props & emits 合成
resolvePlugin(VueDefineModels, framework, options.defineModels),
// 紧接着把类型降级成运行时校验
resolvePlugin(VueBetterDefine, framework, options.betterDefine),
// 然后才是单字段 prop
resolvePlugin(VueDefineProp, framework, options.defineProp),
```

新加一个宏，维护者要人工想清楚「我必须看到谁的改写结果」「谁又必须看到我的」——然后把自己插到对应位置。这是个维护成本，但换来了「读者扫一眼数组就知道依赖关系」的强可读性。

## 同一特性拆前后两阶段

有些特性它要干预两次：一次在 Vue 编译之前（改源码形态、抽取片段），一次在 Vue 编译之后（改编译产物）。setupComponent 与 namedTemplate 就是典型。

它们的工厂函数返回的是**数组**而不是单个插件：

```ts
const plugin = createUnplugin((options, meta) => {
  return [PrePlugin.raw(options, meta), PostPlugin.raw(options, meta)]
})
```

第 0 项是前置（改源码），第 1 项是后置（改编译产物）。编排层拿到这个数组后，要分别把 `?.[0]` 放到结构扩展段（在 vue 之前），把 `?.[1]` 放到渲染后置段（在 vue 之后）：

```ts
// 结构扩展段（vue 之前）
setupComponentPlugins?.[0],
namedTemplatePlugins?.[0],

// ... 中间一大段 ...

// 渲染与后置段（vue 之后）
setupComponentPlugins?.[1],
namedTemplatePlugins?.[1],
```

漏放任何一项，特性就「半残」——比如只放了 setupComponent 的前置，那它能在源码里抽出子组件，但后置改不了 Vue 编译产物里的组件默认导出，整条链对不上。「内联子组件 / 命名模板各有前后两阶段改写」本身的原理（虚拟 SFC + 作用域注入 / 编译后改写 createVNode）第 8、10 章已展开，本章只看编排层新侧面：**前置/后置必须分置 vue 编译器前后**，所以工厂返回数组、编排层手动拆开放。

## 官方 vue/jsx：中段注入的分水岭

vue 与 vueJsx 这两个官方插件，不是 vue-macros 自己创建的——用户在配置的 `plugins.vue` / `plugins.vueJsx` 里把自己创建的实例传进来，编排层把它们注入到管道中段：

- 排在所有类型/结构改写之后——保证宏先改写源码，Vue 才编译 SFC。
- 排在所有渲染相关宏之前——保证渲染宏看到的是已编译产物。

这换来用户**无需自己额外注册官方插件**（少配一行），又保住了 vue 插件的用户配置能力（JSX 选项、模板编译选项都还在用户手里）；同时全局保证「宏先改、Vue 后编」的顺序。代价是形成耦合点：vue 插件实例必须由用户传入，编排层不会替你建一个——这是合理的，因为 Vue 插件有用户自己的配置，由编排层替你建反而剥夺了配置能力。

## 原理演示：顺序即语义

下面这段演示把上面抽象的东西落到一段能 `node`/`bun run` 跑的脚本上。我们不接真的 unplugin 或 Vue 编译器——宏就用 `(code) => code` 的字符串变换模拟。演示只演一件事：**类型降级排在合成 model 之后能正确捕获字段，提前就丢字段**。

```ts
// 每个宏都是一个把代码字符串变成新字符串的纯函数
type Transform = (code: string) => string

const defineModels: Transform = (code) =>
  code + '\n// [defineModels] props += { model: string }'

const betterDefine: Transform = (code) =>
  code.includes('model')
    ? code + '\n// [betterDefine] runtime validate: { model }'
    : code + '\n// [betterDefine] runtime validate: {}'  // 没看到 model

const vueCompiler: Transform = (code) =>
  code + '\n// [vue] compiled SFC -> render fn'

// 组装器：把宏按数组顺序串成一个 pipeline 函数
function assemble(order: Transform[]) {
  return (source: string) => order.reduce((c, fn) => fn(c), source)
}

// —— 场景 A：正确顺序（defineModels → betterDefine → vue）——
const right = assemble([defineModels, betterDefine, vueCompiler])
console.log('A. 正确顺序：')
console.log(right('// source.vue'))
// 输出含：props += { model } / runtime validate: { model } / compiled SFC

// —— 场景 B：错误顺序（betterDefine 提前 → 错过 model 注入）——
const wrong = assemble([betterDefine, defineModels, vueCompiler])
console.log('\nB. 错误顺序：')
console.log(wrong('// source.vue'))
// 输出含：runtime validate: {} —— 校验丢字段，但代码照样跑
```

跑一下你会看到：A 的运行时校验里有 `model`，B 的没有——但两段代码都能继续被 Vue 编译，最终产物都能跑。这就是「顺序错位 = 语义错乱」的可怕之处：没有报错，没有警告，只有悄悄丢掉的字段保护。

如果想演前后两阶段拆分，再加一段：

```ts
// setupComponent 拆两个插件：前置抽取子组件、后置改编译产物
const setupCompPre: Transform = (code) =>
  code.replace('<CompA inline>', '<!-- extracted CompA -->')
const setupCompPost: Transform = (code) =>
  code + '\n// [setupComp post] rewrite default export of CompA'

const pipelineWithSplit = assemble([
  setupCompPre,             // 在 vue 之前
  defineModels,
  betterDefine,
  vueCompiler,              // 分水岭
  setupCompPost,            // 在 vue 之后
])
```

注意 `setupCompPre` 必须出现在 `vueCompiler` 之前、`setupCompPost` 必须出现在它之后——这就是编排层手动拆开放两段的本质：工厂返回数组，编排层把第 0 项放到分水岭前、第 1 项放到分水岭后。

## 关键权衡

本章机制集中（一张写死的数组、一个 combine 工厂、一个 `resolvePlugin` 中枢），核心展开下面这条；其余三条点透但不再展开演示。

### 权衡 1（核心）：把管道顺序硬编码成一份静态数组

> **选择**：所有宏的执行顺序由维护者手工写死在一份数组里，不让用户自己排。
> **换来**：宏之间隐式数据依赖变得确定、可读——读者扫一眼数组就知道「类型降级一定能看到已被合成的 props」「结构扩展一定跑在所有依赖 setup 的宏之前」。新宏上线时，作者必须想清楚自己的插队位置，这个动作本身就是把依赖关系固化进代码的一次拷问。
> **代价**：新增宏必须由维护者人工找准插队位置，错位不会报错，只会让产物在运行时悄悄丢字段、丢校验、丢改写。被这种错位咬到时几乎不会立刻发现——典型表现是「测试都过了，线上某个交互失效」，排查成本极高。

说人话就是：**用一份写死的顺序，换「能跑 vs 跑对了」之间的确定性**。换成依赖图引擎、自动拓扑排序行不行？理论上行，但宏之间的依赖关系很难用类型或注解精确表达（很多依赖是「我要看到你改完的源码」这种隐式的），写死的数组反而是最便宜、最可读的解法。

### 权衡 2：用 combine 工厂把全部宏收进单一实例

> **选择**：用 unplugin-combine 的 `createCombinePlugin` 把三十多个宏收进一个组合插件实例，对外只暴露 `.vite()` / `.webpack()` 等入口。
> **换来**：用户只装一个包、只调一次 `VueMacros().vite()`；framework 探测只做一次；所有宏共享同一套 include 规则、HMR 注入点、插件名前缀——配置一致性显著上升。
> **代价**：全部宏被绑死在同一份数组里，无法像传统 unplugin 那样「想用哪个装哪个包」；想关掉某个宏只能靠配置里把它置 `false`，而不是「不装那个包」——禁用粒度从「包级」退回到「配置项级」。

### 权衡 3：同一特性拆「前置/后置」两个插件实例

> **选择**：像 setupComponent、namedTemplate 这类需要两次介入的特性，工厂返回数组，编排层手动把第 0 项放结构扩展段、第 1 项放 vue 之后。
> **换来**：前置阶段能改写源码形态、后置阶段能改 Vue 编译产物——一次注册拿到两次介入的机会，覆盖了「改源」与「改产物」两类需求。
> **代价**：编排层必须记得把这两项分别放对位置；漏放任一项，特性就「半残」（前置抽得出、后置改不动）。这个责任完全压在维护者身上，没有任何机制兜底——比如有人重排数组时手抖删掉 `setupComponentPlugins?.[1]`，整条链不会报错，只是某些场景下子组件改写不生效。

### 权衡 4：官方 vue/vueJsx 由用户传入、编排层中段注入

> **选择**：vue 与 vueJsx 插件不由编排层创建，而是用户在配置 `plugins.vue` / `plugins.vueJsx` 里传入实例，编排层把它们插到管道中段。
> **换来**：用户无需自己额外注册官方插件（少配一行），又保住了 vue 插件的用户配置能力（JSX 选项、模板编译选项都还在用户手里）；同时全局保证「宏先改写源码、Vue 后编译 SFC」的顺序。
> **代价**：形成耦合点——用户的 vue 插件实例必须由自己传入，编排层不会自动建一个。忘记传，所有依赖「Vue 已编译产物」的后置宏都拿不到东西；这个错误同样不一定立刻报错，可能表现为某些后置改写静默不生效。

## 小结

这一章讲的是 vue-macros 的总装配线：把三十多个独立的宏按写死的顺序串成一条管道，每个宏的位置就是它能看到什么代码的边界。最底层是 `resolvePlugin` 这个「配置即开关 + 按构建器分发」的中枢；中间是一张手工排序的静态数组，按结构扩展 → 类型展开 → 官方编译 → 后置渲染的顺序排好；上层是 combine 工厂，把所有这些收进单一插件实例。

记住三件事就够了：

- **顺序即语义**——betterDefine 必须在 defineModels 之后，否则运行时校验丢字段。
- **同一特性拆前后两段**——分置 Vue 编译器前后，分别改源码与改产物。
- **配置即开关**——某宏配置置 `false`，`resolvePlugin` 直接返回 `undefined`，最后 `.filter(Boolean)` 抹平。

下一章会切到 IDE 视角：volar 怎么把这套编译期能力镜像到编辑器里，让你写宏的时候有类型提示与跳转——同一份宏的语义，编译期是一面，IDE 是另一面。

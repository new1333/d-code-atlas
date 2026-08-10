# SFC 编译管线与宏的注入时机 · 主题精读

## 给 Writer 的教学钩子（必填，8 子项缺一不可）

- **用户痛点 / 场景**：用户写一个 `.vue` 文件，里面同时有 `<template>`、`<script setup>`、`<style>` 三种异构内容，它们各自需要完全不同的处理（JS 要被 babel 解析、模板要变成 render 函数、CSS 要走 scoped/postcss）。如果试图用「一个正则/一次遍历」把整份 `.vue` 啃下来，要么误伤，要么每种语言的能力都用不全。更麻烦的是：用户在 `<script setup>` 里写了 `defineProps(...)`，期待它「凭空」变成组件的 props——这个魔法到底在管线的哪一步发生？为什么不能在解析字符串时就替换掉？这就是本章要讲清的「注入时机」问题。

- **一句话核心思想**：**SFC 编译是一条分阶段流水线（解析成描述对象 → 按块拆分编译 → facade 拼回），而宏的去糖变换只能挂在「script 块编译」内部、拿到 AST 之后的那次节点遍历上——因为只有那一刻才能精确识别宏调用。**

- **设计动机（为什么需要它）**：这条管线存在，是为了让三种异构语言块各走各的最优工具链、又能被同一套打包器（Vite/webpack）以统一方式编排。而「宏的注入时机」之所以是个值得单独讲的问题，是因为它回答了「编译期的魔法究竟发生在哪一秒」：宏既不是字符串预处理，也不是运行时函数，而是 `compileScript` 内部、babel 解析出 AST 之后、遍历节点的那一个子阶段。（**承前/跨章去重**：第 2 章『`<script setup>` 与内置宏的设计动机』已讲透「宏=编译期去糖、语义由编译器硬编码、可扩展性受限」——那是「宏是什么、为什么」。本章**不重演**这个本质，只看它的新侧面：**这条去糖发生在管线的哪个具体阶段、为什么必须是 AST 遍历子阶段、以及当编译器把宏硬编码后、第三方（Vue Macros）如何从外部再插入一层去糖**。至于「为什么用 AST 而非正则」的健壮性论证，留给下一章。）

- **关键权衡（本章核心原料，3 条三段式）**：
  1. **【架构层】分块编译 + facade 自引用，而非单遍整体编译** → 选择：先用 `parse` 把 `.vue` 切成描述对象（含 template/script/style 三块），再用「同一个 `.vue` 文件通过查询参数反复请求自己」的 facade 把每块隔离成独立编译子请求 → 换来：每块走最合适的工具链（script 走 babel、template 走模板编译器、style 走 CSS 处理器）、块级缓存与细粒度 HMR、compiler-sfc 与打包器彻底解耦 → 代价：引入 facade/自引用这层间接性，且**跨块的信息流动变得困难**——典型表现是 script 编译反过来需要 template 的「binding 使用情况」，导致 `compileScript` 必须接收整个描述对象并对 template 做一次预扫描。
  2. **【挂载点层】宏变换挂在 `compileScript` 的「AST 遍历」子阶段，而非字符串/正则阶段**（这是本章灵魂）→ 选择：在 script 块编译内部，先 babel 解析出 AST，遍历节点时精确匹配 `defineProps`/`defineEmits` 等宏调用节点，再用基于原始 offset 的就地改写工具擦除并注入等价代码 → 换来：健壮（不会误匹配注释/字符串里的同名标识符）、能拿到调用参数与作用域上下文、改写位置精确到字符 offset → 代价：每个 SFC 都要付一次完整 babel 解析成本；源码格式敏感性丢失，报错定位需 sourcemap 才能还原回用户写法（这正是后续 magic-string 与 AST 两章的伏笔）。
  3. **【接入层】第三方宏从构建工具 transform 层「前置」挂载，而非侵入/fork 官方编译器** → 选择：Vue Macros 不去改 `compiler-sfc` 内部，而是在 `compileScript` 之前、构建工具的文件变换层插入自己的一套「parse → AST 遍历 → 就地改写」，先把自定义宏去糖，再把产物交给官方 `compileScript` → 换来：与官方编译器解耦、能跟随官方升级、同一份变换逻辑借 unplugin 跨 Vite/Rollup/webpack 复用 → 代价：这一前置阶段**拿不到 `compileScript` 内部对 template binding 的分析结果**，自定义宏的上下文感知能力弱于内置宏；且必须保证「去糖后的产物仍能被官方 `compileScript` 正确接受」，否则两层管线会冲突。

- **最小心智模型（6 步）**：
  1. `.vue` 不是一次性编译的。第一步 `parse` 把整份源码切成一个**描述对象**，分别记录 template / script / scriptSetup / styles 各块的起止位置、语言、属性与原文内容。
  2. 打包器为这个 `.vue` 生成一个**facade 中间模块**——它用「自引用 + 查询参数」（形如 `App.vue?type=script`、`App.vue?type=template`）把 `.vue` 拆成多个虚拟子请求，让每块成为一次独立的编译单元。
  3. **script 子请求**走 `compileScript`：内部先用 babel 把 script 源码解析成 AST，再遍历节点，命中宏调用节点后用就地改写工具在原始 offset 上擦除/注入——**宏的去糖只发生在这一刻**。
  4. **template 子请求**走 `compileTemplate`（由模板编译器把模板编译成 render 函数）；**style 子请求**走 `compileStyle`（处理 scoped / 预处理器）。
  5. 阶段顺序是硬约束：`compileScript` 虽然只产 script，但它要接收**整个描述对象**——它需要对未编译的 template 做一次预扫描，收集「哪些顶层 binding 被模板用到」，才能决定 `<script setup>` 的顶层变量如何暴露给模板。
  6. 第三方宏（Vue Macros）改不了 `compileScript` 内部，于是**抢在第 3 步之前**插入自己的「parse→AST 遍历→就地改写」，先去糖再交给官方 `compileScript`；变换发生在哪一阶段，它就只能感知该阶段及之前可得的上下文。

- **最小原理演示（替代旧"复刻范围"）**：
  - **应演示**：一个几十行的最小 SFC 管线，演透两件事——(a) 分阶段：`parse` → 对 script 块单独编译 → 拼回 facade 产物；(b) 宏挂载点：在 script 块编译内部，**先解析 AST、再遍历节点命中宏、再用 offset 改写**，而不是在原始字符串上动手。每一行都要对应上面某个原理点（分阶段 / 描述对象 / AST 遍历挂载点 / offset 改写 / facade 拼回）。
  - **应故意省略**：完整的 HTML/template → render 编译细节（不是本章重点）；sourcemap 生成细节（magic-string 章）；正则 vs AST 的健壮性对照论证（ast-traversal 章）；facade 自引用查询参数在 webpack vs vite 的差异（unplugin 章）；compileScript 预扫描 template binding 的具体算法（过深）。**不追求工程完整，只追求"演透注入时机"**。
  - **演示载体建议（Writer 据此执行）**：topic 模式首选 **TS/JS**（本 Atlas 产物是 JS 生态 VitePress 站点，TS/JS 对读者最友好）。建议用 `@vue/compiler-sfc` 的 `parse` 做真实的第 1 步（让读者看到真实的描述对象长什么样），再用 `@babel/parser` + `magic-string` 手写一个极简的「第 3 步 script 编译」演透挂载点，最后手写一个 facade 拼回演示第 4 步。无原仓库语言约束。

- **正文不宜展开的细节**：
  - 模板编译器（compiler-dom）把 template 变成 render 函数的内部 AST 与优化（静态提升、patchFlag）——这是模板编译的主题，本章只需点到「template 走另一条子管线」。
  - 「为什么 AST 比正则健壮」的逐案例论证（注释里的同名标识符、字符串字面量、嵌套作用域）——这是下一章『靠 AST 而非正则识别宏调用节点』的主角，本章只断言结论、把论证留给下章。
  - `magic-string` 如何在 offset 上记录操作并最终 `generateMap` 还原 sourcemap——magic-string 章主角。
  - facade 自引用查询参数机制在 webpack（pitching loader）与 vite（transform hook + 描述对象缓存）里的不同实现——unplugin 章主角。
  - `<script>` 与 `<script setup>` 双块合并（`__default__` 导出处理）的边角规则——工程细节，点到即可。

- **推荐的一个执行轨迹例子**：输入一个含 `const props = defineProps({ count: Number })` 的 `.vue` 片段 → ①`parse` 产出描述对象 `{ scriptSetup: { content: '...defineProps...' }, template: {...} }` → ②script 块进入 `compileScript`，babel 解析出 AST，遍历到一个 `CallExpression`，其 callee 名为 `defineProps` → **命中**，读取它的参数节点 `{ count: Number }` → ③用就地改写工具在该节点 offset 上把它替换成 `__props`，并在块顶部注入 `const __props = defineComponentProps({ count: Number })`（或等价的 props 选项注入）→ ④输出编译后的 script，宏调用已从源码中**消失**，变成等价的普通 JS；template 子请求另走一条独立编译。这条轨迹演透「宏只在第 ③ 步、只在拿到 AST 之后的那次遍历里发生」。

> 以上钩子供 Writer 写「动机 → 核心思想 → 心智模型 → 关键权衡 → 原理演示」；下面事实部分供核对，不要被 Writer 当目录照抄。

## 概念要点

- **SFC 描述对象（SFCDescriptor）是管线的中央中间表示**：`@vue/compiler-sfc` 的 `parse(source, { filename })` 把一份 `.vue` 源码解析为一个对象，其中包含 `template`、`script`、`scriptSetup`、`styles`、`customBlocks` 等字段，每个字段记录该块的原文内容、语言（`lang`）、属性（`attrs`）与在源文件中的起止位置（用于 sourcemap）。后续所有编译步骤都消费这个描述对象。依据: `@vue/compiler-sfc` npm README「Low-level utilities」与 parse/compileScript API 说明；DeepWiki「SFC Processing Pipeline」（指出初始 parse 用模板编译器的 parse 并做 SFC 专属调整来产出 descriptor）。

- **管线的三个核心编译 API 各管一块**：`compileScript(descriptor, options)` 把 `<script setup>`/`<script>` 编译成标准 JS 模块代码（在此处理 defineProps/defineEmits 等宏）；`compileTemplate(options)` 把 `<template>` 编译成 render 函数代码；`compileStyle(options)` 处理单个 `<style>` 块（scoped、CSS modules、预处理器）。依据: `@vue/compiler-sfc` npm README「In script transform, use compileScript... In template transform, use compileTemplate... In style transform, use compileStyle...」。

- **facade 模块 + 自引用是编排的核心模式**：官方 README 明确——「总体思路是生成一个 facade 模块来导入组件的各个块；**诀窍在于这个模块用不同的查询字符串『导入它自己』**，从而隔离每个块」。即同一个 `.vue` 文件被以 `?vue&type=script`、`?vue&type=template`、`?vue&type=style` 等查询参数反复请求，每次只返回对应块的编译产物，最后在 facade 里拼回 `export default { ...script, render }`。依据: `@vue/compiler-sfc` npm README「Facade Transform / The trick is the module imports itself」。

- **compileScript 内部用 babel 解析 + magic-string 改写 + AST 遍历**：源码显示 `compileScript` 的标准流程是——用 `@babel/parser` 的 `parse`（即 `babelParse`）把 script 源码转成 AST；用 `new MagicString(input)` 创建可就地编辑的源码副本；用 `walkIdentifiers`/`walk` 遍历 AST 收集 import、处理 export，并识别/改写 `defineProps`/`defineEmits` 等宏调用；最后 `s.toString()` 产出编译后的 JS。依据: vuejs/core 仓库 `packages/compiler-sfc/src/compileScript.ts` 及 `script/context.ts`（ScriptCompileContext 集成 babelParse 与 MagicString）；知乎专栏「compiler-sfc 源码分析 part2」对「调 babel 转 AST → magic-string → walk AST 收集 import/处理 export/变换 defineProps」流程的逐步确认。

- **compileScript 必须接收整个 descriptor（而非只接 script 块）**：官方源码注释明确写道——「它需要整个 SFC descriptor，因为我们要处理和合并……这需要一个 SETUP_LET binding」。根本原因是 `<script setup>` 的顶层 binding 需要根据「模板里实际用到了哪些」来决定如何暴露给渲染上下文，所以 script 编译**反向依赖** template 的 binding 使用情况；为此 compileScript 会先对 template 做一次预扫描收集 binding 集合。依据: vuejs/core `compileScript.ts` 源码注释；jsDocs.io `@vue/compiler-sfc` 类型文档同此说明；`<script setup>` 官方文档「compile-time syntactic sugar，顶层 binding 自动暴露给模板」。实践后果：单独传 script 块给 compileScript 会报错（StackOverflow 实测案例）。

- **打包器的职责是编排，编译能力来自 compiler-sfc**：vue-loader（webpack）用 pitching loader 机制——pitch 阶段拦截 `.vue`、解析成 descriptor、生成 facade，再让带查询参数的子请求回到 loader，按 type 路由到对应块并过对应子 loader（script 过 babel-loader、style 过 css-loader）；`@vitejs/plugin-vue`（vite）用 transform hook 做同样的事，并额外缓存 descriptor 以支持细粒度 HMR（仅 template 变化时只重渲染、保留组件状态）。两者都用同一套 facade 自引用模式。依据: vuejs/vue-loader 仓库 README（pitching loader + SFC 拆分）；vite-plugin-vue `template.ts`/`script.ts`（transform hook 内按查询参数选块并调 compileTemplate/compileScript）。

- **第三方宏（Vue Macros）从 transform 层前置挂载**：Vue Macros 不能修改官方 `compileScript` 内部硬编码的宏语义，于是以一组 unplugin 形式注册到构建工具，在 `@vitejs/plugin-vue`/vue-loader 处理 `.vue` 之前拦截源码，先用自己的 babel parse + AST 遍历 + magic-string 把自定义宏（如 defineModels、shortEmits、响应式 Props 解构等）去糖，再把产物交给官方 `compileScript`。这本质上是**在管线外部、compileScript 之前再叠一层同构的「AST 变换」**。依据: vue-macros 官方站点（描述其为「为 Vue 2.7/3 扩展宏与语法糖、带 TS/Volar 支持」的 unplugin 集合）；vue-loader issue #2039「Any loader hook provided before compile?」（在 vue-loader 主编译前插入变换的讨论）；vue-macros issue #298（讨论变换如何刻意避免产生多个 script 块，即保证产物可被 compileScript 接受）。标注为**推断**：第三方变换相对 compileScript 的确切排序属实现细节，公开文档未完整披露，以仓库源码为准（待 Writer 不必深入）。

## 关键流程

**SFC 编译管线主干（一个 `.vue` 的完整旅程）**：
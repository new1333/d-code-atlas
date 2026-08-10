# Volar 的虚拟代码生成与位置回映 · 主题精读

## 给 Writer 的教学钩子（必填，8 子项缺一不可）

- **用户痛点 / 场景**：用户在一个 `.vue` 文件里写 `<script setup>`、`<template>`、`<style>` 三种语言交织的代码，期望编辑器能像对待普通 `.ts` 那样给出补全、类型报错、跳转定义。但 TypeScript 服务只认识它认识的扩展名、只懂单一语言——它根本不会去读一个 `.vue`，更不会理解里面哪段是 TS、哪段是 HTML。没有中间层，整个 SFC 在 IDE 里就是一片「黑盒」，所有智能提示都得自己从零造。

- **一句话核心思想**：把一个多语言混合的源文件「翻译」成一棵由若干单语言虚拟文件组成的树，让现成的语言服务各自只读自己那一份虚拟文件，再用一张位置映射表把诊断与交互坐标双向翻译回原始源文件。

- **设计动机（为什么需要它）**：这个机制是为了解决「成熟语言服务（TS/CSS/HTML）非常强大，但它们的设计假设是『一个文件 = 一种语言』」这个根本矛盾而生的。它换来的能力是：不必重新实现一个『懂 Vue 的 TypeScript』，而是直接复用 tsserver 的全部能力，只是喂给它一份伪装成 `.ts` 的虚拟代码。**承前关系**：第 2 章『<script setup> 与内置宏』已讲透「宏是编译期去糖、把声明式语法编译成等价 setup() 返回值」——那是**构建期**的变换。本章退一层看一个更底层的地基问题：IDE 在用户**还没构建**时就要理解 SFC（含其中的宏），可 TS 服务压根读不懂 `.vue`。本章就是这块地基——虚拟代码 + 位置映射。它和第 2 章是同一原理的两侧：编译器去糖给运行时，Volar 虚拟代码去糖给类型检查器。（已在第 2 章『<script setup> 与内置宏』讲透『去糖』的本质，本章只看『去糖』在 IDE 侧如何以虚拟代码的形式重演，且只聚焦虚拟代码 + 位置映射这个底层机制本身，宏的具体去糖不重演。）

- **关键权衡（本 Atlas 的核心，4 条）**：
  1. **选择「翻译成虚拟代码复用现成语言服务」而非「为 Vue 重写一个语言服务」 → 换来了免费获得 TS/CSS/HTML 全部智能能力 → 代价是多出一个映射层，每一次诊断、补全、跳转的位置都要在虚拟坐标系与源坐标系之间双向翻译，既增加延迟，也引入「翻译出错则提示错位」的保真风险。**
  2. **选择「严格按 offset 逐字符对齐」而非「宽松/粗粒度映射」 → 换来了红波浪线、跳转定义能精确落到用户写的那个字符上 → 代价是生成虚拟代码时必须对每个字符负责：凡是凭空插入、并非来自源码的内容（典型是 template 编译生成的类型辅助代码），必须显式标记为「不可映射」或回挂到 template 整体，否则会把虚假报错泄漏进源文件视图。**
  3. **选择「通用 embedded-language 框架」而非「Vue 专用实现」 → 换来了 Svelte/Astro/Angular 等任何『单文件嵌多语言』格式都能共享同一套机制 → 代价是抽象层更厚，Vue 特有的优化空间被框架约束压缩，调试时还要穿透更多抽象层。**
  4. **选择「基于 snapshot 增量更新虚拟代码」而非「每次编辑全量重生成」 → 换来了编辑时近乎实时的响应速度（直接复用 TS 的增量编译管线） → 代价是增量逻辑极其复杂，`updateVirtualCode` 必须正确判断『哪些块变了、哪些映射可复用』，一旦处理错就会产生 stale 报错（删掉的错误不消失、或位置追不上光标）。**

- **最小心智模型（6 步）**：
  1. 源文件（`.vue`）随一次编辑产生新的快照（snapshot），进入虚拟代码生成器。
  2. 生成器按语言块（script/template/style）把源文件拆开，为每个块产出一段单语言的虚拟代码，并把它们组织成一棵 VirtualCode 树（根虚拟代码 + 若干 embedded 虚拟代码，template 内部还可再嵌 inline-ts）。
  3. 生成每段虚拟代码的同时，逐段记录 Mapping：源文件里的某段 offset/长度 ↔ 虚拟代码里的某段 offset/长度，外加元数据（这段是否真正可映射、属于哪个源文件）。
  4. 下游语言服务（如 tsserver）**只**在虚拟代码上工作，产出的诊断/补全/hover 位置都在「虚拟坐标系」。
  5. Volar 拿到这些结果后，用 Mapping 把每个虚拟 offset 翻译回源文件 offset（generated → source）。
  6. 编辑器最终在原始 `.vue` 的正确位置上画红波浪线、弹补全、执行跳转——用户感知不到中间有虚拟代码存在。

- **最小原理演示（替代旧「复刻范围」）**：
  - **应演示**：一个几十行的「迷你 SFC → 虚拟代码 + 双向映射」演示器。输入是一段含 `<script>` 与 `<template>` 的仿 `.vue` 文本；程序解析出两个块，拼出一段虚拟 `.ts`（script 原样透传 + template 包裹成一个占位 render 函数），同时为 script 块记录一段「源 offset ↔ 虚拟 offset」的 1:1 偏移映射；最后演示「虚拟代码里第 N 列触发一个报错 → 通过映射查回源 `.vue` 的对应列」。这一条流程要严格对应上面心智模型的 2/3/4/5 步。
  - **应故意省略**：template→render 的真实编译、类型层虚拟代码生成、CSS/HTML 块、snapshot 增量 diff、多语言服务调度、编辑器集成。**不追求工程完整**，只演透「翻译 + 双向映射」这一个核心思想。
  - **演示载体建议**：topic 模式首选 **TS/JS**。本 Atlas 产物是 JS 生态 VitePress 站点，用 TS 写这个演示器对读者最直观——`ts.IScriptSnapshot` 可用普通字符串快照模拟，VirtualCode/Mapping 用纯对象表达即可，无需任何 Vue 运行时依赖。

- **正文不宜展开的细节**：Mapping 元组里 `data` 字段携带的可映射性标志（哪些区段真正对应源码、哪些是生成噪声）；多语言服务（CSS/HTML）各自的映射细节；snapshot 增量 diff 的精确算法；虚拟代码树深度嵌套（template 内 inline-ts 再嵌 embedded code）时的层级映射合并；旧版 Volar（v1 的「virtual script / SourceFile」）与新版（language-core 的 VirtualCode）的 API 演进史。这些供 Writer 裁剪或放「延伸阅读」，正文点到为止。

- **推荐的一个执行轨迹例子**：输入——用户在 `.vue` 的 `<script setup>` 中写了 `const props = defineProps(...)`，但 `defineProps` 的类型标注有误；中间态——Volar 生成虚拟 `.ts`，该行被映射到虚拟代码的某个 offset X，tsserver 在虚拟 offset X 报「类型不匹配」；位置回映——Mapping 把虚拟 offset X 翻译回源 `.vue` 中该行的字符位置；输出——编辑器在原 `.vue` 的 `defineProps(...)` 正下方画出红波浪线。注意：用户全程看不到任何 `.ts` 文件，只看到 `.vue` 里准确的红线。

---

## 概念要点

- **VirtualCode 是 Volar 的核心数据结构**：一个虚拟代码对象持有 `id`（标识，如 root/script/template/style）、`languageId`（它伪装成哪种语言，如 `typescript`/`html`/`css`）、`mappings`（位置映射数组）、`snapshot`（`ts.IScriptSnapshot`，即该虚拟文件的文本内容）、`embeddedCodes`（嵌套的子虚拟代码数组）。语言服务永远拿到的是 VirtualCode，不是源文件。依据: Volar.js 官方文档「Languages」参考页（volarjs.dev/reference/languages），其中给出 `VirtualCode` 接口含 `id` / `languageId` / `mappings` / `snapshot` / `embeddedCodes` 字段，并以 class 形式示范实现。
- **VirtualCode 是树状的，不是平铺的**：根虚拟代码代表整个源文件，其 `embeddedCodes` 数组里挂着 script/template/style 各自的子虚拟代码；template 这种子虚拟代码内部还可再嵌（如模板里插值表达式中的 inline-ts）。这种树状结构让「混合语言」被递归地拆成「单语言叶子」。依据: Volar.js 官方文档「Languages」参考页——「如果您的语言支持 embedded languages，VirtualCode 实例应包含 `embeddedCodes` 属性，是一个 embedded code 块的数组」。
- **LanguagePlugin 是虚拟代码生成的入口接口**：它定义 `createVirtualCode(fileId, languageId, snapshot)`（首次为某文件创建虚拟代码）、`updateVirtualCode(fileId, virtualCode, snapshot)`（文件变更时增量更新虚拟代码）、以及 dispose 方法。一个 LanguagePlugin 就是一套「如何把某种源文件格式翻译成虚拟代码树」的规则。依据: Volar.js 官方文档「Languages」参考页，给出 `createVirtualCode` / `updateVirtualCode` 方法签名与 `LanguagePlugin` 类型。
- **Mapping 是「源 offset ↔ 虚拟 offset」的对照记录**：每条 Mapping 是一个结构，含 `source`（指向哪个源文件）、`sourceOffsets`（源文件中的起始 offset 数组）、`generatedOffsets`（虚拟代码中的起始 offset 数组）、`lengths`（每段长度）、`data`（元数据，例如这段是否真正可映射、是否属于某个 embedded 语言）。生成虚拟代码时，Volar 一边写虚拟文本一边记 Mapping，保证虚拟文本里「凡来自源码的字符」都能查回源位置。依据: npm 包 `@volar/source-map` 的 README——「Mapping 是一个表示源映射中单条映射的结构，由 source / sourceOffsets / generatedOffsets / lengths / data 等元素组成」。
- **位置映射是双向的**：SourceMap 提供「给定虚拟代码的 start/end offset，返回对应的源 start/end offset」的查询，也提供反向查询。诊断/补全的方向是 generated→source（把语言服务在虚拟代码上的结论翻译回源），而「用户光标位置→该给什么补全」的方向是 source→generated（把用户在源文件里的光标翻译到虚拟代码里去问语言服务）。依据: npm 包 `@volar/source-map` README——明确提供「为给定的 generated offset 返回所有 source offset」及反向方法。
- **Vue 的虚拟代码生成由专门模块完成**：`@vue/language-core` 把 `.vue` 编译成虚拟 TypeScript，其中 `vue-tsx` 负责「从 SFC 生成 TypeScript 虚拟代码」（含 script 与 template 的类型化产物），`vue-template-html` 负责「编译 HTML 模板」，`vue-template-inline-ts` 负责「处理模板里插值中的 TypeScript 表达式」。这说明 Vue 侧的虚拟代码不是简单文本搬运，而是带有类型层代码生成的「翻译」。依据: npm/yarn 包 `@vue/language-core` 说明，列出 vue-tsx / vue-template-html / vue-template-inline-ts 三个代码生成器模块。
- **设计哲学：通用 embedded-language 框架**：Volar.js 被明确定位为「为任意含 embedded language 的文件格式构建语言服务的框架」，Vue SFC 只是其一，Svelte、Astro、Angular 模板、含代码块的 Markdown 都是同一机制的使用者。这个定位解释了为何虚拟代码 + 双向映射被设计成与具体文件格式解耦的通用层。依据: Vue 官方博客「Volar: a New Beginning」——明确把 Volar.js 定位为面向任意 embedded-language 文件格式的语言服务框架；Volar.js 文档「Embedded Languages」概念页列举 Vue SFC、Svelte、Astro、Markdown 为同类场景。

## 关键流程

源文件 → LanguagePlugin.createVirtualCode / updateVirtualCode → 生成 VirtualCode 树（根 + embedded script/template/style，template 内再嵌 inline-ts）→ 各虚拟代码携带自己的 mappings（源 offset ↔ 虚拟 offset）→ tsserver / CSS LS / HTML LS **只在虚拟代码上运行** → 产出诊断/补全/hover（位置在虚拟坐标系）→ SourceMap 双向查询把虚拟 offset 翻译回源 offset（或反向把光标翻译进去）→ 编辑器在原 `.vue` 上渲染结果。

依据: Volar.js 文档「Embedded Languages」概念页（架构「编辑体验 = 源文件，语言分析 = 生成虚拟代码，位置映射桥接两者」）+ 「Languages」参考页（VirtualCode / LanguagePlugin 接口）+ npm `@volar/source-map`（双向 Mapping 查询）。

## 易混淆 / 边界 / 推断

- **事实**：VirtualCode 树中，每一层（根、每个 embedded）都有自己独立的 `mappings`，映射是「子虚拟代码 ↔ 它的直接父」的局部关系，跨层级位置回映需要逐层累加。依据: Volar.js「Languages」参考页中每个 embedded code 对象自带 `mappings` 字段。
- **事实**：虚拟代码里并非所有字符都能映射回源——template 被 `vue-tsx` 编译出的类型辅助代码（如 `__VLS_` 前缀的内部类型声明）属于「凭空生成」，这类区段在 Mapping 里要么不记、要么标记为不可映射，以避免它们产生的（通常无意义的）报错污染源文件视图。依据: 推断自 `@vue/language-core` 的 vue-tsx 模块「生成 TypeScript 虚拟代码」这一描述 + Volar Mapping 携带 `data` 元数据的机制（`data` 正是用来区分可映射性）。标注：具体 `__VLS_` 内部前缀属 Vue 实现细节，本调研未在官方文档逐字确认，建议 Writer 不在正文强写该前缀，只讲「template 类型化产物需要显式标为不可映射」这一原理。
- **推断（标注为推断）**：选择「复用 tsserver」而非「自研 Vue-TS」的根本经济动机是——TS 语言服务的复杂度（类型系统、控制流分析、跨文件解析）极高，任何框架重新实现都不现实；虚拟代码 + 映射的额外开销，远小于重建一个 TS。这与「magic-string 用 offset 级操作换 sourcemap 可回溯」（见 magic-string 章）是同一类「为可回溯性接受额外簿记成本」的设计权衡。
- **未理解 / 待查证**：snapshot 增量更新时，`updateVirtualCode` 如何精确判断「只有 template 变了、script 块的映射可整段复用」以最小化重算——这块属于性能优化细节，官方公开文档未详述，主要散落在 vuejs/language-tools 源码与 Johnson Chu 的 ViteConf 2024 演讲「How Volar.js Works」中。若 Writer 需展开增量机制，建议以该演讲为补充来源（youtube.com/watch?v=f7fTutifipI），正文不必深究。
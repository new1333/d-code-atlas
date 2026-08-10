# Vue Language Plugin 接口与 SFC 解析扩展点 · 主题精读

## 给 Writer 的教学钩子（必填，8 子项缺一不可）

- **用户痛点 / 场景**：Vue 官方语言工具能理解 `<script setup>` 里的 `defineProps` 这类**内置**宏，是因为官方编译器亲自把它们的语义写死在「虚拟代码生成」里。但当你写了一个**自定义宏**（比如 `defineProp`、`definePropsRefs`、或把整个 `.setup.tsx` 当组件用），编辑器立刻抓瞎：宏下方爆红线「找不到该函数」，宏推断出的 props 类型也喂不进模板。用户的感觉是「明明 vite 能编译、能跑，VS Code 却一路报错」。这个缺口不是 TS 不够聪明，而是**没人告诉语言工具这套新语法的虚拟代码该怎么生成**。

- **一句话核心思想**：把「SFC 怎么被解析、虚拟代码怎么被生成」这件事，从官方编译器的私有逻辑里**抽成一组可插拔的钩子接口**（VueLanguagePlugin），让第三方在不改官方源码的前提下，往虚拟代码生成管线的每个阶段挂载自己的变换。

- **设计动机（为什么需要它）**：上一章已经建立了「虚拟代码 + 双向位置映射」这套让任意语言服务能处理 SFC 的机制。但那套机制的**映射规则是写死的**——`defineProps` 能被理解，是因为官方的虚拟代码生成器硬编码了它。（**已在第 9 章『Volar 的虚拟代码生成与位置回映』讲透虚拟代码 + 位置映射本身，本章只看它的新侧面：这套映射的生成规则被做成了可插拔的插件接口**）。一旦把规则做成接口，自定义宏、非 `.vue` 文件（如 `.setup.tsx`、Pug 模板）、新 DSL 就都能以「插件」身份接入同一条管线，复用全部的位置回映与 TS 桥接能力——而不是各自另起炉灶。

- **关键权衡（机制丰富章，4 条三段式）**：
  1. **寄生式脚本变换（锚点注入）** → 选择「不重新生成虚拟代码，而是在官方生成的虚拟代码骨架（一系列固定的内部标识符锚点）上 splice/replace 注入宏的类型声明」 → 换来了**实现极简**（一个宏常常只需几十行、改一两个锚点位置） → 代价是**与官方虚拟代码生成器的内部实现强耦合**：锚点标识符一旦改名、或 Vue 大版本切换了锚点形态，所有寄生宏会同时失效，版本兼容成本全部压在插件作者身上。
  2. **解析扩展点必须自行修正位置偏移** → 选择「在解析钩子里把非 `.vue` 文件（如 `.setup.tsx`）人为包装成 `<script setup>` 再喂给官方解析器」 → 换来了**任意文件格式都能伪装成 SFC 接入管线** → 代价是**包装引入的前缀长度必须由插件手动从所有位置信息里减回去**，否则诊断与补全坐标整体错位（这正是上一章「保真风险」在插件层的直接兑现，offset 责任被下放给了插件）。
  3. **必须同时产出「类型层」虚拟代码** → 选择「插件不光识别宏调用，还要往虚拟代码里注入等价的全局类型声明（`declare function`）与 props/emits 类型」 → 换来了 **TS 把自定义宏当成合法全局符号，进而给出悬停、补全、检查** → 代价是这套「类型层」虚拟代码的语义**必须与构建期真实变换后的产物严格对齐**，任何一侧先行或滞后都会导致「IDE 能提示但 CLI 报错」或「能跑但满屏红线」的割裂（此权衡是下一章『双轨制』的引子）。
  4. **两种钩子调度语义共存** → 选择「解析/发现类钩子用『首个返回非空者胜出』，代码生成类钩子用『所有插件依次叠加累积』，并用 `order` 控制先后、用 `version` 做兼容门禁」 → 换来了**多插件可组合、互不阻塞**（一个插件声明虚拟文件、另一个再往里塞内容） → 代价是解析类冲突**只能靠隐式 `order` 裁决，没有显式报错**，排错时难以一眼看出哪个插件覆盖了哪个。

- **最小心智模型（7 步）**：
  1. 用户在 `tsconfig.json` 的 `vueCompilerOptions.plugins` 里登记插件包名。
  2. 语言工具启动时把内置插件（约十数个）排在前、用户插件排在后，按 `order` 排序、按 `version` 过滤掉不兼容者，展平成一条插件实例链。
  3. 每个插件就是一个函数：接收上下文（含 TS 实例、编译器选项、官方编译器模块），返回一个带若干可选钩子的对象（或一组对象）。
  4. 处理一个 `.vue` 时，管线按阶段依次询问插件链：**发现**（文件认领）→ **解析**（产出 SFC 描述符，首个胜出）→ **IR 编译**（脚本/模板/样式各产出结构化中间表示）→ **嵌入式虚拟代码**（声明有哪些虚拟文件、再逐个填充内容，全部累积）。
  5. 官方插件先产出一套带固定内部标识符锚点的虚拟代码骨架（含 props/emits/组件定义等占位）。
  6. 用户插件的「填充虚拟代码」钩子被调用，在官方骨架上做 splice/replace，注入自定义宏对应的类型声明与全局符号。
  7. 下游 TS 服务消费最终虚拟代码；其诊断/补全经 sourceMap 回映到原 `.vue`，用户看到的就是「自定义宏也被理解了」。

- **最小原理演示（替代旧"复刻范围"）**：
  - 应演示：一个**小到只表达两类扩展点**的最小插件（合计约 30 行 TS）。一段演示「脚本层寄生注入」——在「填充虚拟代码」钩子里往虚拟代码末尾 push 一条 `declare function myMacro<T>(...): T` 全局声明，让 TS 把 `myMacro` 当合法符号；一段演示「解析层伪装」——在「解析 SFC」钩子里把 `.setup.tsx` 内容包进 `<script setup lang="tsx">…</script>`，并手动减去前缀长度修正偏移。每一行都要对应上面某个原理点（钩子签名 / 寄生注入 / offset 修正）。
  - 应故意省略：多宏的批量展平调度、`order`/`version` 的完整校验逻辑、sourceMap 段（`Code[]` 元组）细节、Vue 大版本的锚点分支、ts-macro 的 `replace`/`replaceAll` 实现、`computed` 响应式缓存。**不追求工程完整，只追求演透"扩展点长什么样、挂在管线哪一步"**。
  - **演示载体建议**：首选 **TS**。本章接口本身是 TS 类型契约（`VueLanguagePlugin` 是函数类型），用 TS 能同时展示「钩子的类型形状」和「实现」，对本 Atlas 的 JS 生态读者最友好；无原仓库语言约束。

- **正文不宜展开的细节**：`version` 字段的具体合法取值集合与历史演进、`computed` 响应式图如何做增量解析（`updateSFC`/`updateSFCTemplate` 的失效粒度）、嵌入式代码树的多层嵌套与 `forEachEmbeddedCode` 遍历、Vue 3.5 前后 props/emits 虚拟代码锚点的差异、`ts-macro` 的 `Code` 段与 `ts.getText` 工具、自定义块（`<docs>` 等）的处理、Pug 等第三方模板插件的全貌。这些供 Writer 裁剪，不进主线。

- **推荐的一个执行轨迹例子**（演核心思想，不演全量）：
  - **输入**：`.vue` 的 `<script setup>` 里写 `const count = defineProp<number>('count', true)`（`defineProp` 是 Vue Macros 的自定义宏，官方不认识）。
  - **中间态①**：官方脚本插件先产出虚拟代码骨架，含空的公共 props 类型与一个 `defineComponent({...})` 占位。
  - **中间态②**：`vue-macros-define-prop` 插件的「填充虚拟代码」钩子触发，遍历脚本 AST 识别出 `defineProp` 调用，提取出「名字=count、类型=number、required=true」。
  - **中间态③**：插件在骨架的公共 props 锚点处 splice 进 `count: number`，在组件定义处补上 props 字段，并在虚拟代码末尾 push 一条 `declare function defineProp<T>(name: string, options: {required: true}): ComputedRef<T>` 全局声明。
  - **输出**：下游 TS 看到 `count` 是 `number` 类型、`defineProp` 是合法全局函数 → 悬停、补全、类型检查全绿，与构建期真实编译产物语义一致。

> 以上钩子供 Writer 写「动机 → 核心思想 → 心智模型 → 关键权衡 → 原理演示」；下面事实部分供核对，不要被 Writer 当目录照抄。

## 概念要点

- **VueLanguagePlugin 的本质契约**：它是一个函数 `(ctx) => VueLanguagePluginReturn | VueLanguagePluginReturn[]`。`ctx` 提供三大件：`modules`（注入 `@vue/compiler-dom`、`@vue/language-core`、`typescript` 的实际实例，使插件与宿主同版本 TS）、`compilerOptions`（tsconfig）、`vueCompilerOptions`（含 `vueCompilerOptions.plugins` 自身）。返回对象带一组**全可选**的钩子，插件按需实现。
  依据: vuejs/language-tools 源码 `packages/language-core/lib/languagePlugin.ts`、`types.ts`；DeepWiki「Architecture Overview」「SFC 解析与 IR 模型」归纳。

- **钩子按管线阶段分类**（四阶段）：
  - 发现阶段：`getLanguageId`（文件名→语言 ID）、`isValidFile`（认领文件）。
  - 解析阶段：`parseSFC(content)` / `parseSFC2(fileName, languageId, content)`（产出 SFC 描述符）、`updateSFC(oldResult, textChange)`（增量重解析优化）。
  - IR 阶段：`resolveTemplateCompilerOptions`、`compileSFCScript`（脚本块→`ts.SourceFile`）、`compileSFCTemplate`（模板编译覆盖）、`compileSFCStyle`。
  - 嵌入式代码阶段：`getEmbeddedCodes(fileName, sfc)`（声明虚拟文件）、`resolveEmbeddedCode(fileName, sfc, embeddedFile)`（填充虚拟文件内容）。
  依据: DeepWiki「SFC Processing Pipeline」「SFC 解析与 IR 模型」「自定义语言插件开发」；vuejs/language-tools 源码 `virtualCode.ts`/`plugins/*`。

- **两条调度语义（核心机制）**：
  - 「首个非空胜出」（first-wins）：`getLanguageId`、`parseSFC`/`parseSFC2`——管线顺序询问，第一个返回非 `undefined` 的插件结果被采用。
  - 「全部累积」（accumulate）：`getEmbeddedCodes`、`resolveEmbeddedCode`——每个插件的贡献依次叠加到同一份虚拟代码上。
  依据: DeepWiki「Embedded Code System」（getEmbeddedCodes/resolveEmbeddedCode 的 sequenceDiagram 展示多插件依次 resolveEmbeddedCode）；vuejs/language-tools 源码 `languagePlugin.ts` 中 `getLanguageId` 的 `for...of` 首个返回即 break、`isValidFile` 用 `some`。

- **插件链的装配规则**：内置插件先列、用户插件（`vueCompilerOptions.plugins`）排在末尾；每个插件函数的返回先 `flatMap` 展平（一个插件可返回多个实例），再按 `order`（数字，默认 0）升序排序，最后用 `version`（API 版本，如 `2.1`）做兼容门禁——不匹配 `validVersions` 者被过滤并告警。
  依据: vuejs/language-tools 源码 `packages/language-core/lib/plugins.ts` 的 `createPlugins`。

- **@vue-macros/volar 的入口形态**：它是单个 `VueLanguagePlugin`，内部把约 20 个特性宏（defineOptions/defineModels/defineProps/definePropsRefs/shortBind/shortVmodel/defineSlots/jsxDirective/booleanProp/exportRender/exportProps/exportExpose/defineProp/defineEmit/defineGeneric/setupJsdoc/setupSFC/scriptSFC/scriptLang/jsxRef）各实现为一个子插件，用 `Object.entries(...).flatMap(...)` 展平成一组返回；并把解析出的选项写回 `ctx.vueCompilerOptions.vueMacros`。导出形如 `export { plugin as 'module.exports' }`，以便 `tsconfig` 用字符串 `"vue-macros/volar"` 直接 require。
  依据: vue-macros/vue-macros 源码 `packages/volar/src/index.ts`。

- **脚本层变换的三种手法（@vue-macros/volar 实证）**：
  1. **别名复用**：往 `ctx.vueCompilerOptions.macros.defineProps.push('definePropsRefs')` 加别名，让官方脚本插件把该宏当 `defineProps` 自动处理（definePropsRefs 即如此，插件体仅两行）。
  2. **锚点注入（寄生）**：在 `resolveEmbeddedCode` 钩子里拿到 `embeddedFile.content`（`Code[]`），通过工具函数在官方虚拟代码的固定锚点（公共 props 类型、组件定义的 props/emits 字段）处 `splice`/`replace`，注入宏对应的类型；并 `push` 一段 `declare function defineProp<T>(...)` 全局声明，让 TS 把宏当合法全局符号。
  3. **解析改写（伪装）**：实现 `parseSFC2`，把非 `.vue` 文件（`.setup.tsx`）包进 `<script setup lang="…">…</script>` 调用官方 `parse()`，再调用 `patchSFC` 把块的位置信息减去前缀长度，修正偏移；用 `order: -1` 抢在官方插件之前。
  依据: vue-macros/vue-macros 源码 `packages/volar/src/define-props-refs.ts`、`define-prop.ts`、`common.ts`（`addProps`/`addEmits`）、`setup-sfc.ts`（`parseSFC2`+`patchSFC`+`order:-1`）。

- **「类型层虚拟代码」的职责**：脚本层插件不仅识别宏调用，还必须**生成等价的类型信息**——既包括往 props/emits 锚点注入推断出的类型（让模板能消费），也包括注入全局 `declare function`（让宏调用本身不报「找不到符号」）。这是「编辑器假装宏已被编译」的实现手段。
  依据: vue-macros/vue-macros 源码 `define-prop.ts` 中 `transformDefineProp` 同时做 `addProps(...)` 与 `codes.push('declare function defineProp...')`；vue-macros 官方文档「Configuring TypeScript Support」「Volar Plugin Configuration and Type Checking」。

- **配置入口**：用户在 `tsconfig.json` 的 `vueCompilerOptions.plugins` 加入 `"vue-macros/volar"`；该同一套虚拟代码生成逻辑既服务 IDE（语言服务器），也服务 CLI（`vue-tsc`），保证两侧一致。
  依据: vue-macros 官方文档「Configuring TypeScript Support」「Framework Integration」；zread「Volar Plugin Configuration and Type Checking」「Custom Type Definitions and Macros Global Types」。

## 关键流程

```
tsconfig.vueCompilerOptions.plugins: ["vue-macros/volar"]
        │
        ▼
createPlugins(ctx):  [内置14插件..., 用户插件]  ──flatMap展平──►  sort by order  ──►  filter by version
        │                                                                                            (插件实例链)
        ▼
处理一个 .vue：
  ① 发现     getLanguageId / isValidFile          (首胜 / some)
  ② 解析     parseSFC / parseSFC2 / updateSFC     (首胜)  ──►  SFC 描述符
  ③ IR       compileSFCScript / compileSFCTemplate / compileSFCStyle   ──►  结构化中间表示
  ④ 嵌入代码 getEmbeddedCodes (声明)  ──►  resolveEmbeddedCode (填充，全部累积)
                    │
                    ▼  其中官方 vue-tsx 先产出 __VLS_* 虚拟代码骨架
                       用户插件(如 vue-macros-define-prop)的 resolveEmbeddedCode
                       在骨架锚点 splice 类型 + push declare function
                    │
                    ▼
        最终虚拟代码  ──►  下游 TS 服务(诊断/补全/跳转)  ──sourceMap回映──►  原 .vue
```
依据: vuejs/language-tools 源码 `languagePlugin.ts`（getLanguageId 首胜、createVirtualCode→VueVirtualCode）、`plugins.ts`（createPlugins 装配）；DeepWiki「SFC Processing Pipeline」「Embedded Code System」「Virtual Code Generation」。

## 易混淆 / 边界 / 推断

- **事实**：`parseSFC` 与 `parseSFC2` 的区别在于后者多接收 `languageId`，使插件能按语言 ID 区分处理（如 `.setup.tsx` 走 TS/TSX 路径而非默认 `.vue`）。两者都属「首胜」语义。
  依据: DeepWiki「SFC 解析与 IR 模型」（parseSFC2 接收 content + languageId，首个返回非 undefined 胜出）。

- **事实**：`order` 默认为 0，数值越小越先执行；`vue-macros-setup-sfc` 用 `order: -1` 确保它的 `parseSFC2` 早于官方 `file-vue` 之类的认领逻辑被询问。
  依据: vuejs/language-tools 源码 `plugins.ts`（`a.order ?? 0 - b.order ?? 0` 升序）；vue-macros 源码 `setup-sfc.ts`（`order: -1`）。

- **事实**：脚本层「锚点注入」依赖的是官方 `vue-tsx` 插件产出的固定标识符（公共 props 类型名、组件定义处的 props/emits 字段位置）；这些锚点在 Vue 3.5 前后有形态差异（如 3.5 用 `__typeProps`/`__typeEmits`，旧版用 `props`/`emits` 配合归一化类型），插件需按 `target` 版本分支处理。
  依据: vue-macros 源码 `common.ts`（`addProps`/`addEmits` 内 `version >= 3.5 ? ... : ...` 分支与锚点正则）。

- **推断（标注为推断）**：把虚拟代码生成做成「官方骨架 + 用户寄生注入」的双层结构，是一种**有意留出的扩展点设计**——官方没有把变换逻辑封闭，而是暴露稳定的锚点供第三方挂载。代价（强耦合锚点）是该设计的固有风险，而非偶发缺陷。

- **边界**：`resolveEmbeddedCode` 是「全部累积」，但多个插件若改写同一锚点的同一处，后执行者会覆盖前者；累积是「依次叠加」而非「合并冲突」，因此宏之间的变换顺序仍需作者用 `order` 协调。
  依据: DeepWiki「Embedded Code System」的累积语义描述（推断其覆盖行为）。

- **与下一章的衔接（供 Writer 预埋）**：本章展示的「类型层虚拟代码必须与编译产物对齐」正是第 11 章『双轨制：编译变换与 IDE 类型支持为何必须并存』的直接动因——构建期由 unplugin 真改代码、IDE 期由 language plugin 假装改代码，两侧语义对齐是整个 Vue Macros 工程的核心约束。
  依据: 本章 outline.summary；第 11 章 outline.summary。

- **未理解 / 待查证**：`updateSFC`/`updateSFCTemplate` 增量重解析的具体失效边界与性能收益量化、嵌入式代码多层嵌套时 `forEachEmbeddedCode` 的 sourceMap 合并细节、`config`（`__moduleConfig`）在字符串 require 路径下如何注入模块配置——这些在本章不展开，Writer 可略过或单列「进阶」。
# Vue Language Plugin 接口与 SFC 解析扩展点

> 本章属于 composite 层。前置：Volar 的虚拟代码生成与位置回映。
> 学完你能：用一句话讲清「为什么 Volar 把 SFC→虚拟代码的映射规则做成可插拔接口、这换来了什么、代价是什么」。

## 1. 为什么需要它

上一章讲了 Volar 用「虚拟代码 + 双向位置映射」把 `.vue` 翻译成下游 TS 服务能消化的虚拟 `.ts`，再把诊断坐标映射回原文件。映射这件事办成了，但映射的**规则**是写死的。

`defineProps` 能被理解，是因为官方虚拟代码生成器把它的语义硬编码进了生成逻辑——看到 `defineProps<{count: number}>()`，就编译成等价的 props 类型注入到组件定义里。但当你写了一个官方没预置的宏（比如 Vue Macros 的 `defineProp`、`definePropsRefs`，或者干脆把 `.setup.tsx` 当组件用），编辑器立刻抓瞎：宏下方爆红线「找不到该函数」，宏推断出的 props 类型也喂不进模板。

用户的直观感受是「明明 vite 能编译、能跑，VS Code 却一路报错」。这个缺口不是 TS 不够聪明，而是**没人告诉语言工具这套新语法的虚拟代码该怎么生成**。每个新宏都得各自另起炉灶、复制一遍整套位置回映与 TS 桥接——显然不现实。

把生成规则做成可插拔接口，第三方就能以「插件」身份接入同一条管线，复用全部已有能力，只在需要变换的那一步注入自己的逻辑。

## 2. 核心思想

把「SFC→虚拟代码」这条管线**按阶段切片、每段留一个钩子**。插件只在它关心的那一段注入变换，其余阶段继续由官方实现兜底——这就是 `VueLanguagePlugin` 的本质形状。

## 3. 心智模型

一个语言插件就是一个函数。它接收一个上下文 `ctx`（里头有 `typescript` 实例、`@vue/compiler-dom` 实例、tsconfig 的 `vueCompilerOptions`，保证插件与宿主用的是同一份 TS），返回一个带若干可选钩子的对象。

钩子按管线阶段分四组：

- **发现**：`getLanguageId`、`isValidFile`——决定文件该不该被这条管线认领。
- **解析**：`parseSFC` / `parseSFC2`——把原始内容解析成 SFC 描述符（script/template/style 各块的元信息）。
- **IR 编译**：`compileSFCScript`、`compileSFCTemplate`、`compileSFCStyle`——把每块编译成结构化中间表示。
- **嵌入式代码**：`getEmbeddedCodes`（声明有哪些虚拟文件）+ `resolveEmbeddedCode`（逐个填充内容）。

装配规则：内置插件先列、用户插件排在后；先 `flatMap` 展平（一个插件可以返回多个实例），再按 `order`（数字，默认 0）升序排序，最后用 `version` 做兼容门禁过滤掉不兼容者。

调度有两种语义并存：

- 解析/发现类用「**首个返回非空者胜出**」（first-wins）：管线顺序询问，第一个返回非 `undefined` 的结果被采用。
- 代码生成类用「**全部累积**」（accumulate）：每个插件的贡献依次叠加到同一份虚拟代码上。

## 4. 关键权衡

### 在官方骨架上寄生注入，换实现极简，代价是锚点耦合

脚本层最常见的变换手法不是「自己生成虚拟代码」，而是「在官方生成的骨架上动手脚」。官方 `vue-tsx` 插件会先产出一份带固定内部标识符锚点的虚拟代码骨架——公共 props 类型名、组件定义处的 props/emits 字段位置。宏插件只要在 `resolveEmbeddedCode` 钩子里拿到这份骨架，往锚点处 splice 几行、再 push 一条 `declare function defineProp<T>(...)` 的全局声明，就能让 TS 把自定义宏当合法符号。

换来的是实现极简：一个宏插件常常只要几十行、改一两个位置。比起另起炉灶生成一份完整虚拟代码，工作量被压到了最小。

代价是这条路线与官方虚拟代码生成器的**内部实现强耦合**。锚点标识符是私有约定，不是公开 API。一旦 Vue 大版本切换锚点形态（比如 3.5 前后 props 虚拟代码从 `props` 字段改成 `__typeProps`），所有寄生宏会同时失效。版本兼容成本全部压在插件作者身上，得在每个插件里按 `target` 版本分支处理。

化解的本质矛盾是「**留出扩展点**」与「**保持骨架演进自由**」之间的张力——这是「开放-封闭」原则的固有代价：留口子就意味着承诺一个稳定形状，否则骨架就成了封闭的私有实现。

### 解析层伪装换任意文件格式接入，代价是偏移修正责任下放

把 `.setup.tsx` 当 SFC 用看起来不可能——它根本不是 `.vue`。但 `parseSFC2` 钩子让你可以把它的内容包进一段 `<script setup lang="tsx">…</script>` 前缀/后缀，再喂给官方解析器，让它产出一份合法的 SFC 描述符。

换来的是任意文件格式都能伪装成 SFC 接入同一条管线，复用全套位置回映与 TS 桥接能力。`setup-sfc`、`script-sfc` 这类 Vue Macros 特性都是这么挂上来的。

代价是包装引入的前缀长度必须由插件**手动从所有位置信息里减回去**。官方解析器算出来的所有 offset 都基于「包装后」的内容，如果不减回去，诊断坐标和补全位置就会整体前移几十字节——光标在 `count` 上、报错却点在 `count` 前面。这正是上一章「保真风险」在插件层的直接兑现：位置映射的保真责任被下放给了每个解析类插件。

本质矛盾是「**管线只懂一种输入格式**」与「**支持任意用户自定义文件后缀**」之间的张力。伪装没有消解这个矛盾，只是把它转嫁给了插件——管线保持纯粹，插件替管线承担格式适配的复杂度。

### 同时产出类型层虚拟代码，换编辑器智能，代价是双轨必须对齐

一个宏插件如果只识别宏调用、不生成类型信息，TS 会看到 `defineProp(...)` 但不知道它返回什么类型，也不知道该往组件 props 上塞什么字段。所以插件必须做两件事：往 props/emits 锚点注入推断出的类型（让模板能消费），同时 push 一段 `declare function` 全局声明（让宏调用本身不报「找不到符号」）。

换来的是 TS 把自定义宏当成合法全局符号，给出悬停、补全、检查，也就是用户体感上的「编辑器懂我的宏」。

代价是这套「类型层」虚拟代码的语义**必须与构建期真实变换后的产物严格对齐**。构建期 unplugin 真的把宏调用改写成 `setup() { return { count } }`，IDE 期插件假装改写了，两侧推出的类型必须一致。任何一侧先行或滞后，都会出现「IDE 能提示但 CLI 报错」或「能跑但满屏红线」的割裂。

本质矛盾是「**IDE 假装变换已发生**」与「**构建期真做变换**」是两套独立实现，二者必须在语义上对齐。这正是下一章『双轨制』的直接动因：这两个实现不可能合并，因为它们服务的场景根本不同（一个要求实时响应、一个要求确定性输出）。

### 双调度语义换可组合性，代价是解析冲突不透明

为什么 `parseSFC` 是首胜、`resolveEmbeddedCode` 却是累积？因为这两类钩子回答的问题根本不同。解析回答的是「这个文件该被怎么解析」，这是一个互斥决策，只能有一个答案。代码生成回答的是「虚拟代码里该有什么」，这是一个开放贡献，每个插件都可以塞自己的内容。

换来的是多插件可组合、互不阻塞：一个插件声明「这里有一个虚拟文件」、另一个插件再往里塞类型声明、第三个插件再往末尾追加全局声明，三者并存于同一条管线。

代价是解析类冲突**只能靠隐式 `order` 裁决，没有显式报错**。如果两个插件都试图认领 `.setup.tsx`，先执行的赢，后执行的贡献被静默丢弃。排错时难以一眼看出哪个插件覆盖了哪个——你看到的是「我的 `parseSFC2` 没生效」，而不是「插件 A 用 `order: -2` 抢在了你前面」。

本质矛盾是「**同一管线既要支持互斥决策，又要支持累积贡献**」之间的张力。两种调度语义共存才能同时容纳这两类需求，但代价是互斥那一侧的冲突失去了显式的错误反馈通道。

## 5. 最小原理演示

下面是一个最小语言插件，演示「解析层伪装」与「脚本层寄生注入」两类扩展点。每一行都对应上面某个原理点，不演示原理的工程细节一律省略。

```ts
import type { VueLanguagePlugin } from '@vue/language-core'

// 一个语言插件就是一个函数：接收 ctx，返回一组可选钩子
const miniPlugin: VueLanguagePlugin = (ctx) => ({
  // 解析类钩子是「首个非空胜出」，order:-1 抢在官方认领逻辑之前
  order: -1,

  // 解析层伪装：让 .setup.tsx 也能接入 SFC 管线
  parseSFC2(fileName, _languageId, content) {
    if (!fileName.endsWith('.setup.tsx')) return  // 不认领就返回 undefined，让下一个插件有机会
    const prefix = '<script setup lang="tsx">\n'
    // 人为把内容包进 <script setup>，让官方解析器把它当 SFC 处理
    const wrapped = prefix + content + '\n</script>'
    const sfc = ctx.modules.vue.parse(wrapped)
    // 偏移修正：官方解析器算出的 offset 都基于包装后内容
    // 必须把前缀长度从每块的位置信息里减回去，否则诊断坐标整体前移
    for (const block of [sfc.script, sfc.scriptSetup].filter(Boolean)) {
      block.loc.start.offset -= prefix.length
      block.loc.end.offset -= prefix.length
    }
    return sfc
  },

  // 脚本层寄生注入：在官方骨架末尾塞一条全局类型声明
  // 代码生成类钩子是「全部累积」：所有插件的贡献依次 push 到同一份虚拟代码
  resolveEmbeddedCode(_fileName, _sfc, embeddedFile) {
    // 让 TS 把 myMacro 当合法全局符号，这就是「假装宏已被编译」的实现手段
    embeddedFile.content.push(
      'declare function myMacro<T>(name: string, opts: { required: true }): T\n'
    )
  },
})

export default miniPlugin
```

短短 30 行就覆盖了两类扩展点：`parseSFC2` 演示「解析层伪装 + 偏移修正」，`resolveEmbeddedCode` 演示「脚本层寄生注入」。锚点 splice、AST 遍历、`Code[]` 元组这些工程细节都不重要，重要的是看出扩展点长什么样、挂在管线哪一步。

## 6. 执行轨迹

拿一个具体输入走一遍：用户在 `.vue` 的 `<script setup>` 里写 `const count = defineProp<number>('count', true)`（`defineProp` 是 Vue Macros 的自定义宏，官方不认识）。

**① 官方骨架生成**：官方 `vue-tsx` 插件先产出虚拟代码骨架，里头有一个空的公共 props 类型 `__VLS_TypeProps = {}`、一个 `defineComponent({...})` 占位（暂时没有 props 字段）。

**② 钩子触发，AST 识别**：`vue-macros-define-prop` 插件的 `resolveEmbeddedCode` 钩子被调用。它遍历脚本 AST，命中 `defineProp` 调用节点，提取出三元组「名字=count、类型参数=number、required=true」。

**③ 寄生注入三处**：

- 在公共 props 锚点 `__VLS_TypeProps = {}` 处 splice，把 `{}` 改成 `{ count: number }`。
- 在组件定义处的 props 字段补上 `count: { type: Number, required: true }`。
- 在虚拟代码末尾 push 一条 `declare function defineProp<T>(name: string, options: { required: true }): ComputedRef<T>` 全局声明。

**④ 下游消费**：TS 服务拿到最终虚拟代码，看到 `count` 是 `number`、`defineProp` 是合法全局函数。于是悬停显示签名、补全能展开、类型检查全绿。坐标经 sourceMap 回映到原 `.vue`，用户体感就是「编辑器懂我的宏」。

整条轨迹的妙处在于：官方插件完全不知道 `defineProp` 存在，它只产出了一个稳定的骨架；`vue-macros-define-prop` 只做了「往骨架上 splice 三处」这一件事，就让官方语言服务理解了一个全新的语法。

## 7. 教学简化说明

本章演示故意省略了：多宏批量展平调度（`flatMap` 链）、`order` / `version` 的完整校验逻辑、`Code[]` 元组的 sourceMap 段细节、Vue 3.5 前后锚点形态的分支、`ts-macro` 的 `replace` / `replaceAll` 实现、嵌入式代码的多层嵌套遍历、`updateSFC` 增量重解析的失效粒度。这些都不影响理解扩展点的形状。

## 8. 小结

插件接口把「SFC 怎么被解析、虚拟代码怎么生成」从官方私有逻辑变成了公共扩展点，这是 Vue Macros 的自定义宏能被 TS 理解的前提。但插件注入的「类型层虚拟代码」是一份**假装变换已发生**的产物，它必须与构建期 unplugin 真改的代码语义对齐，否则 IDE 与 CLI 就会撕裂。下一章就讲这个『双轨制』。
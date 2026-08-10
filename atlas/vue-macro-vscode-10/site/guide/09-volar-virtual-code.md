# 虚拟代码与位置回映：给只懂一种语言的服务，看懂多语言文件

> 本章属于 composite 层。前置：`<script setup>` 与内置宏的设计动机。
> 学完你能：用一句话讲清 Volar 为什么靠「虚拟代码 + 双向位置映射」让 tsserver 理解 `.vue`，以及它为此付出的代价。

## 1. 为什么需要它

上一章的 unplugin 把**构建期**那条路铺平了：一份宏变换逻辑能同时挂在 Vite、Rollup、webpack 上跑。但构建发生在用户写完代码、准备打包的那一刻；IDE 要在用户敲键盘的每一瞬就理解一个 SFC，包括里面的 `<script setup>` 宏，而它赖以提供类型能力的 tsserver，压根不肯去读一个 `.vue`。

这就撞上了一个根本矛盾：成熟的 TypeScript 语言服务极其强大（类型推导、控制流分析、跨文件解析一应俱全），但它的设计假设是「一个文件 = 一种语言」。它只认 `.ts`/`.tsx` 这类扩展名，只会把整个文件当成一门语言来解析。一个 `.vue` 里同时住着 TS、HTML、CSS 三种语言，tsserver 既不会去读它，更不知道哪一段该按 TS 解析、哪一段该按 HTML 解析。

第 2 章讲过，内置宏是**编译期去糖**——编译器替运行时把声明式语法还原成 `setup()`。IDE 侧面对的是同一个手势的另一半：把 SFC「去糖」成 TS 服务吃得下的形态。但那只是一句回指，本章不重演宏的去糖；本章要拆的是一个更底层的地基问题——**怎么把一个多语言文件翻译成单语言文件、再把位置准确翻译回来**。

## 2. 核心思想

把一个多语言混排的源文件，**翻译成一棵由若干「单语言虚拟文件」组成的树**；现成的语言服务各读各的那份虚拟文件，再用一张位置映射表，把诊断和交互的坐标在「虚拟坐标系」与「源坐标系」之间双向翻译。

这句话是全章的灵魂，后面每一节都在呼应它。

## 3. 心智模型

想象你有一份中英混排的稿子，要请一位只懂英文的审稿人把关。你会怎么做？把英文部分誊抄到一张新纸上交给他，他批注「第 5 行第 3 个字有问题」，你再查自己留的对照表，把这个位置翻回原稿。Volar 干的就是这件事，只不过「誊抄」是按语言块拆出虚拟文件、「对照表」是位置映射、而整个过程用户一无所知。

整个流程可以拆成六步：

1. **快照入场**：用户每改一次 `.vue`，产生一份新的源文件快照（snapshot），交给虚拟代码生成器。
2. **按块拆解**：生成器按 `<script>`/`<template>`/`<style>` 把源文件切开，为每块产出一段单语言的虚拟代码，组成一棵 VirtualCode 树（根 + 若干 embedded 子节点，template 内部还能再嵌 inline-ts）。
3. **边写边记映射**：生成每段虚拟代码的同时，逐段记下 Mapping——源文件某段 offset/长度 ↔ 虚拟代码某段 offset/长度，外加「这段是否真正可映射」的标记。
4. **下游只在虚拟代码上工作**：tsserver 拿到的是伪装成 `.ts` 的虚拟代码，它产出的诊断、补全、hover，坐标全在虚拟坐标系。
5. **位置回映**：Volar 用 Mapping 把每个虚拟 offset 翻译回源 offset。
6. **落到编辑器**：红波浪线、补全弹窗、跳转定义都画在原始 `.vue` 上。

映射是**双向**的，方向取决于谁在问：诊断/跳转是 `generated → source`（把语言服务在虚拟代码上的结论翻回源）；「光标停在这里该给什么补全」是 `source → generated`（把用户在源文件里的光标翻进虚拟代码去问语言服务）。一条映射表，两个查询方向。

## 4. 关键权衡（本章重头戏）

Volar 的设计几乎全是用权衡堆出来的。下面四条，前两条是命门。

| # | 选择 | 换来了 | 代价是 | 化解的本质矛盾 |
|---|------|--------|--------|----------------|
| 1 | 把 `.vue` 翻译成虚拟 `.ts` 喂给现成 tsserver | 免费拿到 TS 全部能力 | 多一层映射，延迟 + 保真风险 | 「TS 能力强」与「TS 假设一文件一语言」 |
| 2 | 虚拟代码与源严格按 offset 逐字符对齐 | 红波浪线精确落到字符 | 凭空生成的内容必须标「不可映射」 | 「想精确回映」与「虚拟代码必然含辅助代码」 |
| 3 | 做成通用 embedded-language 框架 | Svelte/Astro/Angular 共享一套 | 抽象更厚，Vue 特有优化被压缩 | 「想覆盖所有多语言格式」与「每种格式有独特优化」 |
| 4 | 基于 snapshot 增量更新虚拟代码 | 编辑近实时响应 | 增量逻辑极复杂，易出 stale 报错 | 「要快」与「全量重算最简单可靠」 |

**权衡 1：复用现成语言服务，而不是为 Vue 重写一个。** 这是最根本的经济账。TS 语言服务的复杂度（类型系统、跨文件解析、控制流分析）高到任何框架重新实现都不现实；与其造一个永远追不上 tsc 的「Vue 版 TS」，不如直接把 SFC 伪装成 `.ts` 喂给真正的 tsc。换来的能力是白嫖 TS 的全部智能。代价是凭空多出一层映射：每一次诊断、补全、跳转的位置都要在虚拟坐标系与源坐标系之间双向翻译，既增加延迟，也引入「翻译出错则提示错位」的保真风险。说人话就是——你不重写 TS 的钱，是用一层翻译的复杂度和延迟付的。

**权衡 2：严格逐字符对齐，而不是粗粒度映射。** 既然要翻译， mappings 的颗粒度可以粗（按行、按块）也可以细（按字符）。Volar 选了最细的那一档：虚拟代码里的每一个字符，都要能查回源文件里的对应字符。换来的是红波浪线、跳转定义能精确落到用户写的那个字符上，而不是歪到行首或整块。代价是生成虚拟代码时必须对每个字符负责：凡是凭空插入、并非来自源码的内容（典型是 template 被编译成的类型辅助代码），必须显式标记为「不可映射」，否则这些代码产生的虚假报错会顺着映射泄漏进源文件视图。回到那个誊抄的类比：你顺手在誊抄稿上加了一些注释，这些注释不对应原稿任何字；审稿人若在注释上挑错，你不能算到原稿头上，所以得标清楚「这段是我加的，不算」。

权衡 3、4 各用一句话点透：**通用框架**让 Volar.js 不绑定 Vue，Svelte、Astro、带代码块的 Markdown 都是同一机制的使用者，代价是 Vue 特有的优化空间被框架约束压缩、调试要穿透更多抽象层；**增量更新**让编辑器近乎实时响应（直接复用 TS 的增量编译管线），代价是 `updateVirtualCode` 必须精确判断「哪些块变了、哪些映射可复用」，一旦判错就会出现删掉的错误不消失、或位置追不上光标的 stale 报错。

这四条权衡带走的是同一个通解骨架：**当一个强大的现成工具不肯直接吃你的输入时，别重写它，给它喂一份伪装的输入再加一层双向翻译**——但你要为这层翻译的延迟和保真风险买单，并为「伪装输入里那些不对应原文的部分」准备好泄压阀。

## 5. 最小原理演示

下面这段几十行的演示器，只演透「翻译 + 双向映射 + 不可映射区段」这一件事。它解析一段仿 `.vue`，拼出一段虚拟 `.ts`，记下映射，再演示「虚拟代码里报错 → 查回源 `.vue`」。

```ts
// 虚拟代码生成与位置回映 —— 最小原理演示

// 用普通字符串模拟 ts.IScriptSnapshot（源文件某一刻的快照）
type Snapshot = string

// 一段虚拟代码：伪装成某种语言的文本 + 到父级的位置映射
interface VirtualCode {
  id: string
  languageId: string          // 喂给下游语言服务时假装的语言
  content: string             // 虚拟文本本体
  mappings: Mapping[]         // 源 offset ↔ 虚拟 offset
  embedded: VirtualCode[]     // 嵌套子虚拟代码（组成树）
}

// 一条映射：源里的一段 ↔ 虚拟里的一段（两侧等长，便于 1:1 透传）
interface Mapping {
  sourceOffset: number
  generatedOffset: number
  length: number
}

// LanguagePlugin 的核心职责：把 .vue 翻译成一棵 VirtualCode
function createVirtualCode(source: Snapshot): VirtualCode {
  // 步骤 2：粗略切出 <script setup> 与 <template> 两块（教学用，跳过真实解析）
  const sOpen = source.indexOf('<script setup>') + '<script setup>'.length
  const sClose = source.indexOf('</script>')
  const scriptBody = source.slice(sOpen, sClose)
  const tOpen = source.indexOf('<template>') + '<template>'.length
  const tClose = source.indexOf('</template>')
  const tplBody = source.slice(tOpen, tClose)

  // 拼虚拟 .ts：script 原样透传 + template 包成一个占位 render 函数
  const generated =
    scriptBody + `\nfunction __render() { return ${JSON.stringify(tplBody)} }`

  // 步骤 3：只为「来自源码」的 script 块记映射；
  // render 壳是凭空生成的辅助代码 → 不记映射 → 不可映射（对应权衡 2 的泄压阀）
  const mappings: Mapping[] = [
    { sourceOffset: sOpen, generatedOffset: 0, length: scriptBody.length },
  ]

  return { id: 'root', languageId: 'typescript', content: generated, mappings, embedded: [] }
}

// 步骤 5 的 generated → source 方向：把虚拟 offset 翻译回源 offset
function toSource(vc: VirtualCode, genOffset: number): number | null {
  for (const m of vc.mappings) {
    if (genOffset >= m.generatedOffset && genOffset < m.generatedOffset + m.length) {
      return m.sourceOffset + (genOffset - m.generatedOffset)
    }
  }
  return null // 落在不可映射区段（如 render 壳），查不回去
}

// --- 走一遍完整流程 ---
const vue = `<template><div>{{ msg }}</div></template>
<script setup>
const props = defineProps<{ msg: string }>()
</script>`

const vc = createVirtualCode(vue)
console.log('生成的虚拟 .ts:\n' + vc.content)

// 假装 tsserver 在虚拟代码第 20 个字符处报「类型不匹配」
const errAt = 20
const src = toSource(vc, errAt)
console.log(`虚拟 offset ${errAt} → 源 offset ${src}`)
console.log('源 .vue 该处字符:', src !== null ? JSON.stringify(vue[src]) : 'null（不可映射）')
```

运行后，虚拟 `.ts` 里 offset 20 正好落在 `defineProps` 的某个字母上；`toSource` 查回源 `.vue` 中同一个字母，于是红波浪线能精确画到那个字。而 render 壳那一段因为没进 mappings，tsserver 就算在它身上挑错，也查不回源、不会污染源视图。每一行都对应上面心智模型的一步或权衡里的一条。

## 6. 执行轨迹

拿一个具体场景走一遍。用户在 `.vue` 的 `<script setup>` 里写了：

```ts
const props = defineProps<{ msg: string }>()
```

但把类型标注写错了（比如拼成了一个不存在的类型）。整个回映过程是：

1. **快照入场**：这次编辑产生新快照，进入 `createVirtualCode`。
2. **拆块 + 拼虚拟代码**：script 块被原样透传进虚拟 `.ts`，`defineProps` 那一行在虚拟代码里对应某个 offset X。
3. **记映射**：这一行的每个字符都通过 mapping 挂回源 `.vue` 的对应字符。
4. **tsserver 报错**：tsserver 在虚拟 `.ts` 的 offset X 处报「类型不匹配」，它完全不知道有 `.vue` 存在。
5. **位置回映**：`toSource(vc, X)` 把虚拟 offset X 翻译回源 `.vue` 中该行的字符位置。
6. **画红线**：编辑器在原 `.vue` 的 `defineProps(...)` 正下方画出红波浪线。

用户全程看不到任何 `.ts` 文件，只看到 `.vue` 里一条准确的红线。这就是虚拟代码 + 位置映射想达成的效果：**复杂性全部藏在中间层，两头（用户、语言服务）都只做自己擅长的事**。

## 7. 教学简化说明

本章演示故意省略了许多工程必要、但不影响理解核心原理的部分：template 到 render 函数的真实编译、template 类型化产物（那些带内部前缀的辅助类型声明）、CSS/HTML 块的虚拟代码、snapshot 增量 diff 的精确算法、多个语言服务（TS/CSS/HTML）的调度、虚拟代码树深度嵌套（template 内 inline-ts 再嵌一层）时的层级映射合并，以及最终到编辑器的集成层。这些都不影响「翻译 + 双向映射」这条主线。

## 8. 小结

一句话复述 Volar 为什么这么设计：它不愿、也无法重写一个「懂 Vue 的 TypeScript」，于是把 SFC 翻译成单语言虚拟文件喂给现成 tsserver，再用一张双向映射表把结果翻回源文件；这笔交易换来了 TS 的全部能力，代价是一层映射的延迟、保真风险，以及对「凭空生成的辅助代码」必须严防死守。

本章讲清了虚拟代码**怎么生成、位置怎么回映**，但「如何解析 SFC、如何生成虚拟代码」这套规则本身并不是写死的。下一章《Vue Language Plugin 接口与 SFC 解析扩展点》就接着这里讲：这套规则被做成了可插拔的接口，`@vue-macros/volar` 正是借此让自定义宏也被 TS 理解。
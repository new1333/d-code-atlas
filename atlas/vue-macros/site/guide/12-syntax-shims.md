# 为旧版本补齐与简化样板的语法垫片

> 本章属于 composite 层。前置：「SFC 解析与增量 AST 编辑」。
> 学完你能：看到一个语法糖时立刻判断它属于「模板语义」还是「脚本文本」，并说清为什么前者必须借 Vue 编译器、后者只能走字符串编辑。

上一章把 `<script setup>` 内语句的语义按需重排——静态的提升、`export` 改写成 `defineExpose`——动作发生在「setup 内语句」这一层。但还有一类差异不在语句语义，而在更微观的地方：写法太啰嗦、或旧版本 Vue 根本不认这种写法。本章就讲这一类「语法垫片」如何补齐。

## 1. 为什么需要它

设想你在写一个表单组件，想这样用：

```vue
<Checkbox disabled />
<MyInput :value />
<Comp $count="x" />
```

三种写法都更顺：第一种把无值的 `disabled` 当布尔属性；第二种省掉 `="value"` 的重复；第三种用 `$` 简写 `v-model:count`。可它们各自有麻烦——`disabled` 在 Vue 模板里默认被当成空字符串、不是 `true`；`:value` 省值写法是 Vue 3.4+ 才原生支持；`$count` 简写则从来不是合法语法。

脚本侧也有类似的不顺：

```ts
// Vue 3.3 前，withDefaults 是宏，不能链式调用
const props = defineProps().withDefaults({ count: 0 })
```

3.3 之前的 Vue 把 `withDefaults` 当宏、必须独立调用，链式写法直接编译报错。可链式写法读起来更顺，旧版本凭什么卡住写法？

这类需求的共同目标是「把差异和样板抹平在编译期、运行时零成本」。但稍微细看这 5 个宏（`boolean-prop` / `short-bind` / `short-vmodel` / `chain-call` / `script-lang`），会发现它们其实根本不在同一层工作：前三个改的是模板属性怎么被理解，后两个改的是脚本里某段文本长什么样。同叫「语法垫片」，却要分两条路走。

## 2. 核心思想

**语法垫片要在它语义所属的那一层改写——模板语法糖借用 Vue 自己的编译器，脚本改写用增量字符串编辑。**

模板属性最终长成什么样，由 Vue 模板编译器说了算。你想让 `<Comp foo>` 等价 `:foo="foo"`，唯一可靠的做法是挤进编译器的节点变换队列、让它替你改属性节点，而不是在外面动字符串。脚本片段则相反，它就是普通的 JS/TS 文本，跟你贴在 REPL 里的一段代码没区别，直接按偏移改就行。同一章里 5 个宏因为「改哪层」不同，分成两条互不重叠的轨道。

## 3. 心智模型

一个语法糖进来，第一步不是「怎么改」，而是「**它改的是模板语义还是脚本文本**」，这一问决定走哪条路。

**模板语义这条路**（`boolean-prop` / `short-bind` / `short-vmodel`）：

1. 在构建开始时，从 Vue 官方插件（`vite:vue` 或 `unplugin-vue`）暴露的 `.api` 上取到 `api.options.template.compilerOptions.nodeTransforms`。
2. 把自己的节点变换函数 `push` 进这个数组，这一步叫「**挂号**」。挂号之后什么都不做，等 Vue 编译器跑模板时回调你。
3. Vue 编译器遍历模板 AST 时调用你的变换函数，你在函数里就地改属性节点（比如把 `ATTRIBUTE` 类型改成 `DIRECTIVE`、塞上 `exp`），编译器照常生成渲染函数。
4. 产物里只剩标准渲染函数，没有任何运行时 helper、没有任何宏痕迹。

**脚本文本这条路**（`chain-call` / `script-lang`）：

1. 用 `parseSFC` 拿到 `<script setup>` 块（这块能力第 1 章讲过，本章直接复用，不重讲增量编辑原理）。
2. 用 `magic-string-ast` 按偏移改源码，比如把 `defineProps().withDefaults(x)` 整段覆写成 `withDefaults(defineProps(), x)`。
3. 输出改写后的 SFC，下游编译器看到的就已经是标准写法。

两条路殊途同归：最终产物里都不留任何宏痕迹、运行时零成本，差异只在「谁动手改」——是 Vue 编译器自己改，还是你在它之前先把字符串改好。

## 4. 关键权衡

### 借编译器换零运行时开销，代价是构建器范围被绑死

三个模板简写都选择挂靠 Vue 官方插件的节点变换队列，而不是自己在 SFC 字符串层动刀。赢的是**运行时绝对零成本**——变换函数在编译期就把属性节点改成了标准绑定指令，Vue 编译器随后生成的渲染函数里没有任何多余的 helper，跟用户手写 `:foo="foo"` 一模一样；同时还赚到了**语义永远正确**：属性节点由 Vue 自己解析，不用担心你的字符串改写跟编译器理解不一致。

代价是**强依赖 Vue 官方插件暴露 `.api`**（要求 plugin-vue > 4.3.4），这套暴露只在 `vite` / `rollup` / `rolldown` 系存在。所以这三个宏的 plugin 对象只有三个入口，没有 `webpack` / `esbuild` / `rspack`，因为拿到那套构建器根本够不到 Vue 插件的 `.api`。这条取舍说穿了就是「做最薄的改写、要最深的钩子」：你想用编译器内部的节点变换队列省掉所有运行时开销，就得接受只能挂在愿意把这个队列暴露出来的构建器上。

### 独立字符串编辑换六套构建器全通用，代价是只能改脚本文本

脚本侧的两个宏做了相反的选择，它们不去找 Vue 编译器的钩子，直接走 `createUnplugin` 的 `transform` 钩子做纯函数改写。拿到的是**六套构建器全通用**（vite / rollup / webpack / esbuild / rspack / rolldown），还能跟其它宏的字符串改写叠加着跑；代价是它**只能改 JS/TS 文本、碰不到模板语义**：`chain-call` 没办法让 `<Comp foo>` 变布尔，那不是它的领地。这条选择落在「通用 vs 入戏」上：字符串层人人都能插手，但你只能改表象；想改 Vue 怎么理解一个属性，必须进到 Vue 编译器内部。

### 版本号即正则开关，换来新旧自适应，代价是同前缀跨版本语义不同

`short-bind` 在变换函数内部用 `version < 3.4` 切换前缀正则：

```ts
const reg = new RegExp(`^(::${version < 3.4 ? '?' : ''}|\\$|\\*)(?=[A-Z_])`, 'i')
```

旧版 Vue 没有原生 v-bind 简写，所以 `:foo`（单冒号）和 `::foo`（双冒号）都可以由宏接管；可 3.4 原生引入了 `::foo` 简写、语义跟宏的设想不同，于是宏在 3.4+ 收紧正则、只认双冒号，把单冒号让回给原生。得到的是**同一份代码在新旧 Vue 下行为自适应**；代价是用户必须知道这道版本门槛——同一段 `:foo` 写法，在 3.3 由宏解释成「绑定到 foo 变量」，在 3.4 由 Vue 原生解释成「简写到 foo 变量」，结果一致但路径完全不同；如果用户在 3.4 还期望宏接管单冒号，会困惑为什么「不生效」。说到底是在两件事之间画线：旧版本要先享受语法糖，新版本的原生实现要优先生效，用版本号划线是唯一不冲突的解法。

### 挂号兜底换宽松加载顺序，代价是配错静默不生效

借编译器的宏必须等「配置已解析、Vue 插件已就绪」之后才能挂号。但插件加载顺序不是宏能控的：可能在 `configResolved` 钩子里 Vue 插件还没就位、可能在 `buildStart` 才就位。这三个宏于是先在 `configResolved` 试一次，拿不到 API 就在 `buildStart` 再试一次，两次都拿不到就 `this.warn` 后 return，**静默放弃而不抛错**。

赚的是**对插件加载顺序极其宽松的兼容**：不管 Vue 插件什么时候就位，总有一次兜底能挂上；代价是用户配错（比如把宏写在了 Vue 插件之前的某个位置，两次兜底都没就位）时**没有任何报错提示**，宏悄悄就不生效了，调试时只能盯着产物看为什么 `<Comp foo>` 还是被当成空字符串。这条权衡真正在掂量的是「严格报错换早暴露」 vs「宽松兼容换少打扰」，这里选了后者，因为这些宏本来就是「锦上添花」的语法糖，宁可不生效也不能阻断构建。

## 5. 最小原理演示

下面两段演示对照着看——同章两类垫片、两条路。

**演示一：布尔属性 → 标准绑定的节点变换**（演「借编译器」这条路）。逻辑：自定义一个节点变换函数，遍历元素节点的 `props`，把无值的 `ATTRIBUTE` 节点就地改成 `bind` 指令、表达式设为字面量 `true`；然后调官方 `compile` 跑一遍，证明产物里只剩标准 `props: { foo: true }`。

```ts
import { compile, NodeTypes } from '@vue/compiler-core'

// 布尔属性的节点变换：把无值的 ATTRIBUTE 改写成 bind 指令
function booleanPropTransform(node) {
  if (node.type !== NodeTypes.ELEMENT) return
  for (let i = 0; i < node.props.length; i++) {
    const prop = node.props[i]
    if (prop.type !== NodeTypes.ATTRIBUTE) continue
    // 就地把节点替换成 bind 指令，表达式为字面量 true
    node.props[i] = {
      type: NodeTypes.DIRECTIVE,
      name: 'bind',
      arg: { type: NodeTypes.SIMPLE_EXPRESSION, content: prop.name, isStatic: true },
      exp: { type: NodeTypes.SIMPLE_EXPRESSION, content: 'true', isStatic: false },
      modifiers: [],
    }
  }
}

// 挂号进 nodeTransforms，剩下交给 Vue 编译器
const { code } = compile('<Comp foo/>', {
  nodeTransforms: [booleanPropTransform],
})
console.log(code)
// 产物里 foo 已经是标准 :foo="true"，没有任何宏残留、没有任何运行时 helper
```

挂号一次、Vue 编译器替你改、产物纯净，这就是「借编译器换零运行时开销」的全部逻辑。

**演示二：链式调用重排的字符串编辑**（演「独立字符串编辑」这条反向路）。逻辑：拿源码字符串，用 babel parser 找到 `defineProps().withDefaults(x)` 的节点偏移，用 `magic-string` 按偏移整段覆写成 `withDefaults(defineProps(), x)`。

```ts
import { parse } from '@babel/parser'
import MagicString from 'magic-string'

function transformChainCall(code: string): string {
  const s = new MagicString(code)
  const ast = parse(code, { sourceType: 'module', plugins: ['typescript'] })
  ast.program.body.forEach((stmt) => {
    // 识别谓词：声明的 init 是 CallExpression，callee 是
    // defineProps().withDefaults —— 此处略去识别细节
    const target = stmt as any
    const definePropsString = 'defineProps()'
    const withDefaultString = '{ count: 0 }'
    // 按节点偏移整段覆写
    s.overwrite(
      target.start,
      target.end,
      `const props = withDefaults(${definePropsString}, ${withDefaultString})`,
    )
  })
  return s.toString()
}

console.log(transformChainCall(`const props = defineProps().withDefaults({ count: 0 })`))
// 输出：const props = withDefaults(defineProps(), { count: 0 })
```

这一类完全不需要 Vue 编译器、纯字符串偏移编辑就够。它跟模板语义无关、跟构建器也无关，所以能跑在六套构建器上。

## 6. 执行轨迹

拿 `<Comp :foo>` 这个输入走一遍（演版本感知 + 借编译器两条权衡）。

**前提**：用户用的是 Vue 3.3，宏 `short-bind` 已通过 `buildStart` 兜底挂进了 Vue 插件的 `nodeTransforms`。

1. **构建器开始编译 `<MyComponent.vue>`**：Vue 插件接管这个文件，先用 `@vue/compiler-sfc` 拆出 `<template>` 块，把模板字符串交给 `@vue/compiler-dom` 编译。
2. **Vue 编译器 parse 模板**得到一棵 AST。`<Comp>` 元素节点的 `props` 里有一个 ATTRIBUTE 类型的 `:foo`——因为单冒号在 3.3 还不是原生简写，编译器初判它就是普通属性。
3. **Vue 编译器进入 `nodeTransforms` 阶段**，依次调用每个挂号过的变换函数，其中一个是 `short-bind` 的变换。
4. **`short-bind` 变换被调用**：它在内部用 `version < 3.4` 算出当前可匹配的前缀正则（3.3 允许 `:` / `::` / `$` / `*`）。它扫描元素节点的 `props`，发现 `:foo` 命中正则，把它就地改写成 `bind` 指令：`arg.content = 'foo'`、`exp.content = 'foo'`、`name = 'bind'`、`type = DIRECTIVE`。
5. **Vue 编译器继续跑完所有变换和代码生成**：它看到的已经是一棵「标准绑定指令」的 AST，生成的渲染函数里就是 `_createVNode(Comp, { foo })`，跟用户手写 `:foo="foo"` 的产物一模一样。
6. **产物落盘**：运行时拿到的就是标准渲染函数，没有任何 `short-bind` 宏的痕迹、没有任何运行时 helper。

**版本切换**：如果用户升到 Vue 3.4，第 4 步的正则就收紧为只匹配 `::`。此时单冒号 `:foo` 不再被宏接管，而是由 Vue 3.4 原生的 v-bind 简写解释，结果仍是 `{ foo }`，但路径变成了原生而非宏。同一段输入、同一份产物，靠版本号在两条解释路径之间切换。

## 7. 教学简化说明

本章演示故意省略了几样东西：六套构建器入口的重复脚手架（每个宏都长得几乎一样）、HMR 与版本探测的工程化包装、Volar 侧的 IDE 语法支持、`short-vmodel` 的 `$`/`*` 前缀与 `::` 前缀走两条子路径的细节、链式调用里顺手清理宏 import 语句的逻辑。这些都不影响「按层分两条路」的核心原理，但都是真实工程里不可少的部分。

## 8. 小结

同叫语法垫片，模板糖和脚本糖各归其位：前者挂号进 Vue 编译器、产物纯净；后者独立做字符串编辑、构建器全通用。**改哪层，就在哪层动手**——这是全章唯一要带走的方法；版本号则是那条隐形的开关线，决定哪些前缀归宏、哪些让回原生。本章反复提到的「默认开或关」「按版本号条件启用」的真正收敛点不在每个宏里，而在更上一层。下一章就讲这套统一配置体系。
# SFC 编译管线与宏的注入时机

> 本章属于 primitive 层。前置：`<script setup>` 与内置宏的设计动机。
> 学完你能：用一句话讲清「SFC 编译为何必须分阶段、宏的去糖为何只能挂在 `compileScript` 内部的 AST 遍历子阶段、第三方宏为何要抢在这步之前插入」。

## 1. 为什么需要它（设计动机）

第 2 章我们看清了：`<script setup>` 里的 `defineProps` 这类内置宏，本质是「编译期去糖」——编译器把声明式写法翻译成等价的 `setup()` 返回值，宏语义被官方编译器硬编码。但那章留了个口子：这个去糖动作到底发生在编译的哪一秒？为什么不能在第一次读到 `.vue` 字符串时就顺手把它替换掉？第三方能不能往这套去糖里塞自己的宏？这一章就接住这个口子。

先看 `.vue` 文件长什么样。你打开一个典型 SFC，里面同时塞着三段异构内容：`<template>` 是一段类 HTML 的模板 DSL，`<script setup>` 是 TS/JS，`<style scoped>` 是 CSS。这三块各自需要完全不同的工具链：JS 要 babel 解析、模板要走模板编译器变成 render 函数、CSS 要走 scoped 注入和 postcss。

如果有人试图用一个正则、一次遍历把整份 `.vue` 啃下来，会撞上两堵墙：要么误伤（在 CSS 里命中 JS 标识符、在模板字符串里命中 CSS 选择器）；要么每种语言的能力都用不全（模板编译器要做的静态提升、patchFlag 优化，正则根本做不到）。

更要命的是宏的「魔法时刻」：用户在 `<script setup>` 里写下一行 `const props = defineProps({ count: Number })`，期待它「凭空」变成组件的 props。这一步到底发生在管线的哪一秒？这就是本章要讲清的「注入时机」问题。

## 2. 核心思想

SFC 编译是一条分阶段流水线：先把 `.vue` 整体解析成一个描述对象、再按块拆分各自编译、最后用 facade 把每块的产物拼回一个完整模块。在这条流水线上，宏的去糖变换只能挂在「script 块编译」内部，具体说是拿到 babel AST 之后、遍历节点匹配宏调用名的那一个子阶段。因为只有那一刻，编译器既能精确识别宏调用、又能在原始 offset 上就地改写。

## 3. 心智模型

把这条流水线想成一家加工厂，原料是一份 `.vue` 文本，产物是一份打包器能直接吃的 JS 模块。整条线有六个工位：

1. **解析（parse）**：`parse(source)` 把整份 `.vue` 切成一个**描述对象**，里面记录 template / script / scriptSetup / styles 各块的原文内容、起止 offset、`lang` 属性。这是后续所有工位的中央数据。
2. **facade 自引用**：打包器为这个 `.vue` 生成一个中间模块（facade），它通过 `App.vue?type=script`、`App.vue?type=template` 这种查询参数反复请求自己，把每一块拆成一次独立的编译子请求。
3. **script 子请求进 `compileScript`**：内部先用 `@babel/parser` 把源码解析成 AST，再遍历节点，命中 `defineProps` 等宏调用节点后用 magic-string 在原始 offset 上擦除/注入。**宏的去糖只发生在这一刻**。
4. **template 子请求进 `compileTemplate`**：模板走另一条子管线，编译成 render 函数代码。
5. **style 子请求进 `compileStyle`**：每段 `<style>` 走 scoped / postcss 单独处理。
6. **拼回**：facade 把 script、render、style 的产物拼成一个完整的 ES 模块，导出 `export default { ...script, render }`。

一个常被忽视的细节：`compileScript` 虽然只产出 script，但它**接收的是整个描述对象**——因为它需要对未编译的 template 做一次预扫描，收集「哪些顶层 binding 被模板用到了」，才能决定 `<script setup>` 的顶层变量如何暴露给模板。换句话说，script 编译反向依赖 template 的使用情况，阶段顺序不是单向的。

## 4. 关键权衡

### 分块编译 + facade 自引用，换工具链最优与块级 HMR，代价是跨块信息流动困难

第一个选择是**整体单遍 vs. 分块隔离编译**。Vue 选了后者：先 `parse` 出描述对象，再用 facade 自引用查询参数把每块拆成独立编译子请求。

换来的是每块都能走自己最合适的工具链（script 过 babel、template 过模板编译器、style 过 CSS 处理器）；块级缓存与细粒度 HMR 自然落地（只 template 改了就只重渲染、组件状态保留）；`compiler-sfc` 自己完全不感知打包器是 vite 还是 webpack。

代价是引入了 facade 自引用这层间接性，**跨块的信息流动变得麻烦**——典型症状就是上面提到的：script 编译反过来需要 template 的 binding 使用情况，于是 `compileScript` 必须对 template 做一次预扫描。本质矛盾是「块间隔离带来的工具链最优」与「块间共享上下文的需求」在打架。

### 宏变换挂在 compileScript 的 AST 遍历子阶段，换精确识别，代价是每次都要付 babel 解析成本

第二个选择，也是本章灵魂：**字符串/正则阶段 vs. AST 遍历阶段**。Vue 把宏的去糖挂在 `compileScript` 内部的 AST 遍历子阶段，而不是在原始字符串上动手。具体顺序是：babel 解析出 AST → walk 整棵树 → 命中 callee 名为 `defineProps` 的 `CallExpression` → 读取它的参数节点 → 用 magic-string 在该节点的 offset 上就地改写。

换来的是精确健壮（不会误匹配注释里、字符串字面量里、嵌套作用域里的同名标识符）；能拿到完整的调用参数和作用域上下文；改写位置精确到字符 offset，sourcemap 可还原。

代价是每个 SFC 都要付一次完整的 babel 解析成本；源码格式敏感性丢失（缩进、空行、注释位置不保留），用户源码的报错回指必须依赖 sourcemap。本质矛盾是「语法精确性」与「解析开销/格式保真」在打架。（「为什么 AST 比正则健壮」的逐案例论证，下一章会专门展开。）

### 第三方宏从 transform 层前置挂载，换与官方编译器解耦，代价是上下文感知弱于内置宏

第三个选择是 **fork 官方编译器 vs. 构建工具 transform 层前置**。Vue Macros 选了后者：不去改 `compiler-sfc` 内部，而是在 `compileScript` 之前、构建工具的文件变换层插入自己的一套「parse → AST 遍历 → 就地改写」，先把自定义宏（`defineModels`、`shortEmits`、响应式 Props 解构等）去糖，再把产物交给官方 `compileScript`。

换来的是与官方编译器彻底解耦，能跟随官方升级；同一份变换逻辑借 unplugin 跨 Vite/Rollup/webpack 复用；自定义宏可以热插拔。

代价是这一前置阶段**拿不到 `compileScript` 内部对 template binding 的分析结果**，自定义宏能感知的上下文弱于内置宏；而且必须保证去糖后的产物仍能被官方 `compileScript` 正确接受（比如不能产生多个 script 块），否则两层管线会冲突。本质矛盾是「外部接入的低耦合」与「内部上下文的可见性」在打架，你站在门外，就看不见门里 template 的 binding 分析。

## 5. 最小原理演示

下面这段几十行的 TS 演示演透两件事：分阶段流水线（parse → 单独编译 script → 拼回 facade 产物），以及宏挂载点（在 script 块编译内部、先解析 AST、再遍历节点命中宏、再 offset 改写）。

```ts
import { parse } from '@vue/compiler-sfc'
import { parse as babelParse } from '@babel/parser'
import MagicString from 'magic-string'

// 第一步：parse 把整份 .vue 切成描述对象
const source = `
<template>{{ count }}</template>
<script setup lang="ts">
const props = defineProps({ count: Number })
</script>
`
const { descriptor } = parse(source, { filename: 'App.vue' })
// descriptor.scriptSetup.content === 'const props = defineProps({ count: Number })'
// descriptor.template.content === '{{ count }}'

// 第二步：script 子请求进 compileScript（这里手写一个极简版，演透挂载点）
function compileScriptMini(scriptSrc: string): string {
  // 挂载点内部第一动：babel 解析出 AST
  const ast = babelParse(scriptSrc, {
    sourceType: 'module',
    plugins: ['typescript'],
  })
  // 挂载点内部第二动：用 magic-string 包一层原始源码，准备 offset 级改写
  const s = new MagicString(scriptSrc)

  // 挂载点内部第三动：遍历 AST，按节点类型 + callee 名精确命中宏调用
  function walk(node: any) {
    if (
      node?.type === 'CallExpression' &&
      node.callee?.type === 'Identifier' &&
      node.callee.name === 'defineProps'
    ) {
      // 命中宏调用：在该节点原始 offset 上就地改写
      const { start, end } = node
      s.overwrite(start!, end!, '__defineComponentProps({ count: Number })')
      return
    }
    for (const key of Object.keys(node)) {
      const child = node[key]
      if (Array.isArray(child)) child.forEach(walk)
      else if (child && typeof child.type === 'string') walk(child)
    }
  }
  for (const node of ast.program.body) walk(node)

  return s.toString()
}

const compiledScript = compileScriptMini(descriptor.scriptSetup!.content)
// compiledScript 里 defineProps 已经消失，变成了 __defineComponentProps(...)

// 第三步：template / style 各自走另一条子管线，这里点到不展开

// 第四步：facade 拼回，同一个 .vue 文件靠自引用查询参数把每块串起来
const facade = `
import script from './App.vue?vue&type=script&lang.ts'
import { render } from './App.vue?vue&type=template'
script.render = render
export default script
`
```

每一行都对应上面某个原理点：`parse` 对应「解析成描述对象」；`babelParse` + `MagicString` + `walk` 对应「宏挂载在 AST 遍历子阶段」；`s.overwrite(start, end, ...)` 对应「原始 offset 上就地改写」；最后的 facade 字符串对应「自引用查询参数拼回」。

## 6. 执行轨迹

拿一个具体输入走一遍，看每一步内部状态怎么变。

输入：一份含 `const props = defineProps({ count: Number })` 的 `.vue` 片段。

① `parse(source)` 产出描述对象 `{ scriptSetup: { content: 'const props = defineProps({ count: Number })' }, template: { content: '{{ count }}' } }`。此时宏调用还在 content 里，原封不动。

② script 子请求进入 `compileScript`：内部 `babelParse` 把这一行解析成 AST，结构大致是 `VariableDeclaration → VariableDeclarator → init: CallExpression(callee: Identifier(name: 'defineProps'))`。

③ 遍历到这个 `CallExpression`，**命中**：读取它的参数节点 `{ count: Number }`，用 magic-string 在该节点的 offset 上把 `defineProps({ count: Number })` 改写成 `__defineComponentProps({ count: Number })`。

④ `s.toString()` 输出编译后的 script，宏调用 `defineProps` 已经从源码里**消失**，变成了等价的普通 JS 调用。template 子请求另走一条独立编译，互不干扰。

⑤ facade 拼回：最终打包器看到的模块是 `import script from './App.vue?type=script'; import { render } from './App.vue?type=template'; script.render = render; export default script`。

这条轨迹演透一件事：宏只在第 ③ 步、只在拿到 babel AST 之后的那次节点遍历里发生。在那之前（字符串阶段）它什么都不是，在那之后（已编译 JS）它已经不存在。

## 7. 教学简化说明

本章演示故意省略了几样东西：完整的 HTML/template → render 编译细节（属于模板编译主题）；sourcemap 生成的具体机制（magic-string 章主角）；「AST 比正则健壮」的逐案例论证（ast-traversal 章主角）；facade 自引用查询参数在 webpack vs vite 里的不同实现（unplugin 章主角）；`compileScript` 预扫描 template binding 的具体算法（过深）；以及 `compileScript` 真实做法里把 `<script setup>` 包成 `setup(__props)` 函数、把 props 选项注入组件 options 等步骤——演示只把宏名替换成等价运行时函数名，只求演透「注入时机」这一个原理点。

## 8. 小结

整条 SFC 管线把 `.vue` 拆成描述对象、按块各自编译、再用 facade 拼回；宏的去糖被精确钉死在 `compileScript` 内部的 AST 遍历子阶段，早一秒不行（没有 AST），晚一秒也不行（已经是普通 JS）。第三方宏想加自己的去糖，只能从构建工具 transform 层抢在这一步之前插队。下一章我们把镜头切到这个 AST 遍历子阶段内部，看它为什么必须靠 AST、不能靠正则。
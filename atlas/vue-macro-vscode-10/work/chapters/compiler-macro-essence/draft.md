# 编译期宏的本质：运行时不存在的「变换提示」

> 本章属于 primitive 层。无前置依赖（全书地基章）。
> 学完你能：用一句话讲清"为什么宏要既像函数又不是函数"——它是一种写给编译器看的变换锚点，编译期改写、运行时擦除。

## 1. 为什么需要它（设计动机）

全书为什么从这一章开始？本书 14 章都在讲 Vue Macros 这套社区库如何"在 Vue 官方编译器之外又加一层编译期变换"。但在讲它怎么做之前，必须先把"宏到底是什么"这件事钉死——后面 13 章的编译管线、AST 识别、sourcemap、双轨制、生态演进，全都建立在"宏是运行时不存在的伪函数"这个公理之上。

回到 Vue 使用者最朴素的写法。在 `<script setup>` 出现之前，要让一个组件声明"我接收哪些 props、触发哪些事件、暴露哪些方法"，得写完整的选项对象，或者写一个 `setup(props, { emit }) { ... return { ... } }` 函数，把模板用到的每个变量都手动 return 出来。

```js
export default {
  props: { label: String },
  emits: ['click'],
  setup(props) {
    return { onClick() { /* ... */ } }
  }
}
```

写多了你会发现一件别扭的事：**这些"组件接收什么、抛什么、暴露什么"的信息，其实是静态的**。组件 `MyButton` 接收 `label: string`、emit 一个 `click` 事件——这些事实从你写完代码那一刻就定了，每次渲染都是同一份。但你却不得不在运行时反复地用对象字面量告诉 Vue 这件事，每次组件加载 Vue 都要花一次解析成本去理解它。

这是矛盾的本质：**信息在编译期就能确定，却被迫推迟到运行时去表达**。能不能反过来——既然编译期就知道，那让编译器替我把这份约定写成运行时代码，我自己只写一行声明？宏就是这条思路的产物。

## 2. 核心思想

你写下 `defineProps(['foo'])`，看起来是调一个函数。但它其实**不是函数**——它是写给编译器看的「变换提示」：编译器在这个位置把声明式写法原地改写成等价的运行时代码，然后把这个"函数"自己从产物里抹掉。

关键只有一点：宏是给编译器看的一个标记。它在源码里长得像函数，是为了让调用处语法自然；但运行时根本没有任何函数实体对应它。

## 3. 心智模型

打个比方：宏像**施工图纸上的批注**——"这里装一扇窗"。图纸阶段标注完，工人按批注把窗装好；最后交付的建筑里，你找不到"批注"这个东西，只能看到那扇窗。

把这个比喻拆成六步：

1. **用户写下宏调用**：有名字、有参数，长得和普通函数调用一模一样。
2. **这个名字运行时根本不存在**：没 import，也不指向任何函数实体——你在产物里 grep 不到。
3. **编译期识别**：编译器把源码解析成 AST，按"调用名 + 出现位置"找出哪些节点是宏。
4. **原地改写**：对每个命中的宏调用节点，编译器用一段等价的、能独立运行的代码把它替换掉。
5. **痕迹消失**：替换后，原宏调用从 AST 里移除，"函数名"在产物里彻底不见。
6. **零开销交付**：最终运行时代码里只有改写后的等价物，运行时没有任何对应的"宏调用"成本。

判据只有一条，但够你用整本书：**源码里有宏名，产物里没有宏名**。这是验证某个东西"是不是真宏"的最直接办法。

## 4. 关键权衡

### 伪装成函数换来语法自然与零运行时开销，代价是没有真实函数语义

宏选择"长得像函数调用"这种语法形态，换来三件好事：调用处语法和普通函数一样自然、用户无需 import、运行时彻底没有调用开销。但代价是这个"假函数"背负了普通函数不该有的限制：**不能赋值给变量、不能嵌套、不能放进条件分支或回调里，必须在 `<script setup>` 顶层静态地写**。

听起来很奇怪，但本质矛盾其实在两个对立需求之间打架：**用户要的是"我像调函数一样写一行"，编译器要的是"我能在编译期就定位到你这一行"**。一旦允许把宏放进条件或回调，调用是不是真的执行就成了运行时才能回答的问题，编译器就无法静态识别。所以这条限制不是设计疏忽，而是宏这一族机制的内在约束。

### 编译期完全定型换来运行时产物干净，代价是普通 JS 工具链不认识它

宏选择"在编译期把组件结构彻底改写完"，换来运行时产物干净、性能可预测、组件每次都以同一种结构加载。但代价是普通 JS 工具链默认不认识这个"全局幽灵函数"：ESLint 会报 `defineProps is not defined`、纯 TypeScript 编译器也无法把这些全局宏识别成真正的函数，必须额外靠 Volar 这类语言服务层"假装"宏有类型。

本质矛盾：**编译期视角（这些宏是已知变换）vs 工具的运行时视角（我没找到这个函数的定义）**。同一个标识符，编译器认识，工具链不认识——这个割裂正是后续"双轨制"主题的伏笔。

### 运行时彻底擦除换来不增包体积与调用栈，代价是可调试性受损

宏选择"在产物里完全消失"，换来了不增加包体积、不增加调用栈层级，这跟普通函数（会被打包保留、调用时进栈）形成鲜明对比。但代价是**可调试性受损**：运行时断点、调用堆栈、报错位置都指向编译产物而非用户写的源码。如果没 sourcemap 还原，你在 DevTools 里看到的代码和你写的代码完全不是一回事。

本质矛盾：**性能（不背包袱）vs 体验（能跟源码对得上）**。这个矛盾的"解药"，即 sourcemap，会成为第 5 章的独立主题，可见它的分量。

## 5. 最小原理演示

下面用 `@babel/parser` 写一个最小的宏擦除演示。玩具宏叫 `defineConstant('KEY', value)`：调用处长得像函数，编译期被改写为 `const KEY = value`，宏名从产物里彻底消失。

```ts
import { parse } from '@babel/parser'
import _traverse from '@babel/traverse'
import _generate from '@babel/generator'

// CJS 默认导出的兼容取法（演示用，不展开）
const traverse = (_traverse as any).default ?? _traverse
const generate = (_generate as any).default ?? _generate

// 宏清单：宏名 → 该宏的编译期变换函数
// 变换器接收原始"宏调用节点"，返回一段等价运行时代码
const macros: Record<string, (call: any) => any> = {
  defineConstant(call) {
    // 把宏的两个参数取出来：常量名（字符串字面量）+ 常量值（任意表达式）
    const name = call.arguments[0].value
    const valueNode = call.arguments[1]
    // 拼出等价的 const 声明，作为替换节点
    return {
      type: 'VariableDeclaration',
      kind: 'const',
      declarations: [{
        type: 'VariableDeclarator',
        id: { type: 'Identifier', name },
        init: valueNode,
      }],
    }
  },
}

function compile(src: string): string {
  // 第一步：把源码解析成 AST，编译期开始
  const ast = parse(src, { sourceType: 'module' })

  // 第二步：遍历 AST，按"调用名 + 节点类型"识别宏
  traverse(ast, {
    CallExpression(path) {
      const callee = path.node.callee
      // 命中条件：调用目标是标识符 + 名字在宏清单里
      if (callee.type === 'Identifier' && macros[callee.name]) {
        // 第三步：用等价代码替换掉这条调用所在的整条语句
        const replacement = macros[callee.name](path.node)
        path.parentPath.replaceWith(replacement)
        // 替换完，"defineConstant" 这个名字在 AST 里已不存在
      }
    },
  })

  // 第四步：把 AST 重新拼回字符串，宏函数名彻底消失
  return generate(ast).code
}

const src = `
  defineConstant('MSG', 'hello')
  defineConstant('COUNT', 42)
`

console.log(compile(src))
// 输出：
// const MSG = "hello";
// const COUNT = 42;
// 产物里 grep 'defineConstant'，一处都找不到
```

每一步都对应第 3 节心智模型里的一个原理点：解析得到 AST（识别前提）→ 按名字+节点类型识别宏（命中伪装调用）→ 用等价代码替换（原地改写）→ generate 出干净产物（运行时擦除）。

## 6. 执行轨迹

拿一个具体输入走一遍。源码：

```js
defineConstant('MSG', 'hello')
```

**编译期**：

1. `parse(src)` 把这一行解析成一棵小 AST：

```
Program
└─ ExpressionStatement
   └─ CallExpression
      ├─ callee: Identifier { name: "defineConstant" }
      └─ arguments: [
           StringLiteral { value: "MSG" },
           StringLiteral { value: "hello" }
         ]
```

2. `traverse` 走到 `CallExpression`，看 `callee.name === "defineConstant"`，查宏清单命中。

3. 变换器从 `call.arguments` 取出 `"MSG"` 和 `"hello"`，构造一个新节点：

```
VariableDeclaration { kind: "const" }
└─ declarations[0]
   ├─ id: Identifier { name: "MSG" }
   └─ init: StringLiteral { value: "hello" }
```

4. `path.parentPath.replaceWith(...)` 把外层的 `ExpressionStatement` 整个换成这个 `VariableDeclaration`。原 `CallExpression` 节点（连同 callee 名字 `defineConstant`）从树上脱落。

**产物期**：

5. `generate(ast).code` 输出 `const MSG = "hello";`。

**验证**：

6. 在产物里搜 `defineConstant`——一处都没有。源码里的"函数调用"在运行时彻底不存在了，组件加载时既不会查找它的定义、也不产生调用栈帧。

## 7. 教学简化说明

本章演示故意省略了若干工程必要环节：完整的 SFC 解析（拆 `<template>` / `<script>` / `<style>` 块）、AST 识别的健壮性论证（为什么不用正则）、sourcemap 生成（让产物报错能映射回源码）、多个宏同时改写一个节点的顺序冲突、具体 Vue 内置宏的去糖细节、类型推导的双轨制。这些都会在后续章节各自展开。本章只演透一件事：**伪函数被编译期识别 + 原地改写 + 运行时擦除**。

## 8. 小结

宏牺牲了真实函数语义、工具链原生理解和可调试性，换来零运行时开销与更声明式的语法。这是后续 13 章所有讨论的共同前提。下一章就把这套原理落到具体的内置宏身上，看 `<script setup>` 里的 `defineProps` / `defineEmits` 怎么用这一招替你生成 setup 样板。
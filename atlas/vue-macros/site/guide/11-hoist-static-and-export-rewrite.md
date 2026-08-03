---
title: "静态提升与 export 语义重写"
---

# 静态提升与 export 语义重写

想象你在 `<script setup>` 里写了这么一行：`const TITLE = '订单详情'`。这个标题字符串，从组件第一次渲染到第一万次渲染，值都不会变。可它现在被关在 `setup()` 函数体里——每实例化一次组件，就得重新分配这行内存、重新求一次值，算出来的结果还一模一样。纯属白干。

与此同时你可能还有另一个本能：既然要对外暴露点东西，那就用 JS 里最熟的 `export const x`。可惜 `<script setup>` 不认 `export`，写下去直接报错。

这一章讲的就是一个编译期的"搬运工"。它干两件事：把那些永远不变的常量从"每次都跑"的 setup 搬到"只跑一次"的模块顶层；把 `export` 这个 ES 模块的语法，翻译成 Vue 自己的 `defineExpose` / `defineProps`。搬完、翻完，运行时一行新代码都不用加——全在编译期搞定。

## 一、setup 函数体里混进了两类"走错地方"的语句

要理解这一章，先得看清楚 Vue 的 `<script setup>` 编译后长什么样。

普通 `<script>` 是模块顶层，模块加载时执行一次，之后所有组件实例共享同一段内存。而 `<script setup>` 编译后是一个 `setup()` 函数，**每次实例化组件都会从头到尾跑一遍**。同一个文件里，这两块代码的执行次数差着好几个数量级。

于是痛点就清楚了：常量（标题文案、枚举值、配色表、不变的配置）天然属于"算一次就够"的模块顶层，却常常被随手写进了 setup 里。这意味着：

- 每次渲染都重新求一次值（哪怕结果恒定不变）；
- 每次都重新分配一块内存（上一次的那块随实例销毁）。

另一类痛点是 `export`。开发者太习惯用 `export` 来表达"这个模块要对外暴露什么"了，可 `<script setup>` 偏偏把这件事独占了——对外暴露只能走 Vue 的宏（`defineExpose` 暴露给父组件、`defineProps` 声明入参）。写 `export` 是非法语法。

说人话就是：setup 函数体里混进了两类**本该属于别处**的语句——一类该去模块顶层（静态常量），一类该被翻译成 Vue 宏（export）。这一章就是那个在编译期把它们各归其位的搬运工。

> 这套"看 AST、改源码"的底座——懒解析、基于偏移的 `sliceNode`/`removeNode`、magic-string 维护 sourcemap——第 1 章已展开。本章只盯着一件新事：**怎么把语句从一个块整体搬到另一个块，以及搬之前凭什么判定它该不该搬。**

## 二、最底层的那块：凭什么说一个表达式"静态"

搬运之前，得先回答一个问题：哪些 `const` 能安全搬走？

这个判定是整个机制的命门。搬错了，程序行为就变了——比如把一个"每次执行都产生新副作用的表达式"误当成静态提升到模块顶层，它就只会执行一次，副作用丢了，bug 就来了。

所以这个判定函数（源码里叫 `isStaticExpression`）的脾气是：**极其保守**。你可以把它想象成一个只认"白名单"的安检员——不在名单上的，一律不放行，宁可漏放也不误放。

它的白名单核心是**字面量**（数字、字符串、布尔、null）——这是判定的地基。在这个地基上，它递归地放宽了几种组合：二元运算（`1 + 2`）、三元（`a ? 1 : 2`）、逻辑组合（`x || y`）、模板串、一元（`!true`）、以及一层 TS 的类型包装（`x as number`、`x!`、`x satisfies T`）。

关键来了：**对象字面量、数组字面量、正则字面量、函数、函数调用——默认统统不认。**

这点反直觉。你可能觉得 `const config = { theme: 'dark' }` 多静态啊，怎么不提升？答案是：保守。一个对象字面量里可能藏着 getter、可能展开了一个有副作用的 spread，编译器没法静态证明它"绝对纯净"，那就当它不静态。要让它通过，用户得手动开选项，或者更直接——加一句魔法注释 `/* hoist-static */` 强制提升。

我们用一段最小演示把这个保守安检员演透。这段脚本零依赖，`node` 直接能跑：

```ts
// 极简节点：只覆盖演示需要的几种表达式类型
type Node =
  | { type: 'Literal' }
  | { type: 'Template'; exprs: Node[] }        // `a${b}c`
  | { type: 'Binary'; left: Node; right: Node } // 1 + 2
  | { type: 'Unary'; arg: Node }               // !true
  | { type: 'Object'; props: Node[] }          // { k: v }
  | { type: 'Array'; elements: Node[] }        // [a, b]
  | { type: 'Regex' }                          // /abc/
  | { type: 'Call' }                           // Symbol()

// 保守判定：默认只放行字面量与几种纯组合
function isStatic(node: Node, opts: {
  unary?: boolean
  object?: boolean
  array?: boolean
  regex?: boolean
} = {}): boolean {
  switch (node.type) {
    case 'Literal':
      return true
    case 'Binary':
      return isStatic(node.left, opts) && isStatic(node.right, opts)
    case 'Unary':
      return !!opts.unary && isStatic(node.arg, opts)
    case 'Template':
      return node.exprs.every((e) => isStatic(e, opts))
    case 'Object':
      return !!opts.object && node.props.every((p) => isStatic(p, opts))
    case 'Array':
      return !!opts.array && node.elements.every((e) => isStatic(e, opts))
    case 'Regex':
      return !!opts.regex
    case 'Call':
      return false // 函数调用一律不放行，哪怕 Symbol() 看着无害
  }
}

// 真实宏调用时只开了 unary，没开 object/array/regex
const OPTS = { unary: true }

const stmts: { name: string; init: Node; src: string }[] = [
  { name: 'TITLE',  init: { type: 'Literal' },                       src: "const TITLE = '订单详情'" },
  { name: 'LIMIT',  init: { type: 'Binary', left: { type: 'Literal' }, right: { type: 'Literal' } }, src: 'const LIMIT = 10 * 1000' },
  { name: 'ENABLE', init: { type: 'Unary', arg: { type: 'Literal' } }, src: 'const ENABLE = !false' },
  { name: 'cfg',    init: { type: 'Object', props: [{ type: 'Literal' }] }, src: "const cfg = { theme: 'dark' }" },
  { name: 'tags',   init: { type: 'Array', elements: [{ type: 'Literal' }] }, src: "const tags = ['a','b']" },
  { name: 're',     init: { type: 'Regex' },                         src: 'const re = /abc/' },
  { name: 'uid',    init: { type: 'Call' },                          src: 'const uid = Symbol()' },
]

console.log('—— 判定结果 ——')
for (const s of stmts) {
  console.log(`${isStatic(s.init, OPTS) ? '提升' : '保留'}  ${s.src}`)
}
```

跑出来的结果一目了然：

```
—— 判定结果 ——
提升  const TITLE = '订单详情'
提升  const LIMIT = 10 * 1000
提升  const ENABLE = !false
保留  const cfg = { theme: 'dark' }
保留  const tags = ['a','b']
保留  const re = /abc/
保留  const uid = Symbol()
```

前三个能提升：字面量、纯字面量的二元、开了 `unary` 的一元。后四个全部保留在 setup：对象、数组、正则因为对应选项没开而被拦下，`Symbol()` 是函数调用，直接 false。这就是"保守"的样子——明明 `cfg` 看着无害，照样不放行。

## 三、搬到哪里去：用到时才生成一个普通 script 块

判定通过之后，语句要搬去哪儿？答案是一个普通 `<script>` 块——它天然是模块顶层、只执行一次。

但麻烦来了：很多 SFC 根本没有普通 `<script>` 块，只有 `<script setup>`。那就得**凭空生成一个**。生成的方式很巧妙，全靠一个共用的小 helper（源码里叫 `addNormalScript`）：

- 如果文件本来就有 `<script>` 块——直接把它的结尾偏移当作追加点，语句往它尾巴上贴；
- 如果没有——在源码**偏移 0** 处插一个开标签 `<script>`，把追加点记成 0。

为什么都锚定偏移 0？因为 magic-string 这个编辑器有个特性：**同一位置插入的内容，会按插入顺序排在一起**。所以在偏移 0 先贴开标签、最后贴闭标签，两端一夹，中间塞进搬来的语句，一个完整的 script 块就立住了，顺序不会乱。

还有个细节值得说：这个 script 块是**惰性**的——一开始偏移量是 `undefined`，只有当真有一条语句要搬、第一次调用 `start()` 时，才会去插开标签。如果整个文件扫下来一条都该搬走，那就根本不生成这个块，连闭标签都不贴。能用就不浪费。

## 四、主机制：一个保守搬运工的完整流程

把判定、造块、搬迁拼起来，就是 hoist-static 的完整流程。下面这段演示在上一段基础上加上"跨区搬迁"，演透整个机制：

```ts
// 搬运：把判定为静态的语句贴到 script 区，从 setup 区删掉
function hoist(setupBody: typeof stmts) {
  const scriptLines: string[] = [] // 模块顶层（只执行一次）
  const setupLines: string[] = []  // setup 函数体（每次执行）
  let blockCreated = false         // 惰性造块标志

  for (const s of setupBody) {
    if (isStatic(s.init, OPTS)) {
      if (!blockCreated) {           // 第一次提升才生成 script 块
        blockCreated = true
        scriptLines.push('<script>') // 相当于在偏移0贴开标签
      }
      scriptLines.push('  ' + s.src) // appendRight 到 script 区
      // 原 setup 位置的这条语句被删掉（演示里直接不进 setupLines）
    } else {
      setupLines.push('  ' + s.src)
    }
  }
  if (blockCreated) scriptLines.push('</script>') // 贴闭标签
  return { scriptLines, setupLines }
}

const { scriptLines, setupLines } = hoist(stmts)

console.log('\n—— 改写结果 ——')
console.log(scriptLines.join('\n'))
console.log('<script setup>')
console.log(setupLines.join('\n') || '  /* hoist static placeholder */')
console.log('</script>')
```

输出：

```
—— 改写结果 ——
<script>
  const TITLE = '订单详情'
  const LIMIT = 10 * 1000
  const ENABLE = !false
</script>
<script setup>
  const cfg = { theme: 'dark' }
  const tags = ['a','b']
  const re = /abc/
  const uid = Symbol()
</script>
```

注意两个真实机制在演示里的对应：搬走的语句在原 setup 位置要被**删除**（源码里走 `removeNode`，演示里直接不写回 setup 区）；如果 setup 被搬得一条不剩，源码会插一句 `/* hoist static placeholder */` 兜底，避免出现一个空 setup 块让下游编译器懵掉（演示里 `||` 那行就是这个兜底）。

模板里写的 `{{ TITLE }}` 仍然合法——因为 setup 顶层能访问同一文件里普通 `<script>` 块的绑定。这正是"搬到模块顶层"能成立的根基。

这条搬运流水线用文字画出来就是：

```
setup 顶层语句
   │
   ├─ const，且 isStaticExpression(init) 通过？
   │      是 → 搬到 script 区，原位删除
   │      否 → 留在 setup
   ├─ TS enum，且每个成员 initializer 都静态？
   │      是 → 整条搬到 script 区
   │      否 → 留在 setup
   └─ 其它语句（响应式逻辑等）→ 原样留在 setup
   │
扫完 → setup 被搬空？插占位注释 → 有提升过？贴 script 闭标签
```

## 五、export 的语义翻译：让 setup 像普通模块一样写 export

前四节讲的是"搬出去"，这节讲另一条线："翻译"。`export` 在 `<script setup>` 里是非法的，但人就是想用它。那就让编译器在编译期把它翻译成 Vue 原生的宏，运行时谁也不认识 `export`。

**export-expose：把 `export` 翻译成 `defineExpose`。**

思路很直：扫一遍 setup 顶层，把每条 `export` 的导出名收集起来，最后拼一个 `defineExpose({ a, b, c })` 塞到 setup 末尾。具体三种形态各有各的擦法：

```ts
export const count = 0   // 带声明：只删掉 "export " 这 6 个字符，声明本体留下
export const fn = () => {}
export { foo }            // 纯 specifier：整条删掉
export { bar } from './x' // re-export：把 export 改写成 import，再把 local 名改掉防冲突
```

第三种最绕。`export { bar } from './x'` 本质是从别处引进来再暴露，编译器把它改成 `import { bar as __MACROS_expose_0 } from './x'`——给那个 local 名套个前缀，免得它和 setup 里同名的变量撞车。最后这个改名后的名，照样进 `defineExpose`。

有两个写法直接抛错、不支持：`export * from './x'` 和 `export default`。这是有意的硬限制——这俩没法干净地映射到 `defineExpose` 的语义，与其支持一半埋雷，不如一开始就拒绝。

**export-props：用声明关键字区分 prop 和 model。**

这个更巧妙。它让开发者这样写：

```ts
export const title = '默认标题'  // 单向 prop（父传子）
export let open = false           // 双向 model（v-model:open）
```

关键在它怎么区分这两种：**看声明关键字**。`const` → 当成普通 prop，生成 `defineProps<{ title: string }>()` 的解构；`let`/`var` → 当成双向 model，生成 `let open = $(defineModel('open'))`（这里的 `$()` 是响应式语法糖宏，让赋值能自动触发 emit，那套机制属于另一章，这里只点一句：它复用了"响应式语法糖"章）。

借 `const` 还是 `let` 来区分 prop/model，是个很轻的设计——零新语法、零新 API。但它的代价摆在明面上：声明关键字的本职是表示"可变性"，这里被借去当"分类标记"了。读者看到 `export let x` 得反应过来"这不是普通 let，是 model"，语义被叠加了一层。

本章一共四个宏，第四个 define-stylex 走的是同一条"提升"老路：它把 `defineStyleX(...)` 调用整条提升到普通 script（把调用名改写成 `_stylex_create`），同时去模板里把 `v-stylex` 指令改写成 `v-bind`——脚本侧搬迁、模板侧翻译，两套手法前面都见过，这里不展开。四个宏合起来就一句话：**全是编译期的语义重排，不引入任何新运行时能力。**

## 六、关键权衡

这一章的设计，每一处"这么干"背后都对应着"换来什么、亏在哪"。挑四条讲透。

**1. 静态判定默认极度保守 → 换来"提升后绝不改变行为"的安全性 → 代价是错失大量合法优化。**

这是整章最核心的一条。判定函数把对象、数组、正则、函数调用默认全部当"不静态"，等于在说：我宁可漏掉一个本可提升的对象字面量，也绝不能误把一个藏着副作用的表达式提升成"只跑一次"——后者会让程序行为悄悄变化，是比性能损失严重得多的 bug。

换来的是铁一般的安全性：凡是被它放行的，提升上去保证语义不变。代价同样真实：`const cfg = { theme: 'dark' }` 这种肉眼无害的常量被留在 setup 里每次重算，用户想要它就得自己负责——要么开选项，要么加 `/* hoist-static */` 魔法注释强制提升。而魔法注释一旦用错（给真有副作用的表达式加了注释），保守防线就被绕过，行为就变了。**安全性是靠"把判断责任推回给用户"换来的。**

**2. 借普通 `<script>` 的模块级语义当提升目标 → 换来常量只算一次的性能 + 更瘦的 setup 函数体 → 代价是得凭空生成一个原本不存在的 script 块。**

提升这件事之所以能成立，是因为 Vue 的 SFC 同时支持两种执行语义：普通 `<script>` 跑一次、`<script setup>` 每次跑。把常量从后者挪到前者，性能收益是白捡的——同一段内存、同一次求值，所有实例共享。

代价是要处理"目标块不存在"的情况：得在偏移 0 插开标签、末尾插闭标签，靠 magic-string 同位置按序排列的特性把块夹出来；还要兜底"setup 被搬空"的退化（插占位注释），以及"全程一条没搬"的退化（压根不生成块）。**免费的性能，是用一堆边界处理换的。**

**3. 把 `export` 重写成 Vue 原生宏（defineExpose / defineProps）→ 换来"setup 像 ES 模块一样写 export"的可读性 + 零新运行时 API → 代价是只支持 `export` 的一个子集。**

开发者对 `export` 太熟了，能用它写 setup，心智负担显著降低。而且翻译后的产物全是 Vue 原生宏，运行时不需要认任何新东西。

代价是子集限制：`export * from` 和 `export default` 直接抛错不支持；`export { x } from './y'` 这种 re-export 还得给 local 名套前缀防冲突。**用熟悉的语法换可读性，代价是这个语法只有一部分能用，且边界 case 需要额外翻译逻辑。**

**4. 用声明关键字（const vs let/var）区分 prop 与 model → 换来零新语法、零新 API 的区分手段 → 代价是语义超载。**

export-props 不发明任何新关键字，纯靠已有的 `const`/`let` 把两种语义分开。这让它接入门极低。

代价是声明关键字被"超载"了：它本来只表达可变性，现在多扛了一层"我是 prop 还是 model"的分类职责。一个不熟悉约定的读者，很难从 `export let open` 看出这是个双向 model。**零成本的区分，靠的是约定，而约定需要被学到。**

## 七、小结

这一章的四个宏，做的事可以压缩成一句：**在编译期，给 setup 里的语句重新归类——静态的搬到只跑一次的模块顶层，export 的翻译成 Vue 原生宏。** 搬运用到的 AST 编辑底座是第 1 章的那套，本章新增的全部是"搬去哪、凭什么搬、怎么翻译"的判断逻辑。其中最要紧的是那个保守的静态判定——它决定了整个提升机制敢不敢放手干，而它选择"宁可漏放不可误放"，把安全性置于优化覆盖率之上。

下一章会看到另一类编译期改写：那些不为提升性能、也不为语义翻译，纯粹是为了**抹平不同 Vue 版本之间的语法差异**（比如新版才有的简写、旧版没有的布尔 prop 语法）而存在的语法垫片。同样是在编译期动手脚，但动机从"归类"变成了"兼容"。

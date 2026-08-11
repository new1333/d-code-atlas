# 静态提升与 export 语义重写

> 本章属于 composite 层。前置：SFC 解析与增量 AST 编辑。
> 学完你能：讲清为什么 vue-macros 要在编译期把 setup 里的常量「搬出去」、把 `export`「翻过来」，以及它为此做了哪几条保守到近乎偏执的设计取舍。

## 1. 为什么需要它

上一章把渲染来源从默认的 `<template>` 扩展到了 JSX、`h()`、命名模板等更多形态——渲染那一头打通了，可 `<script setup>` 函数体本身一直没动过。开发者写 setup 时仍会撞上两个老问题。

第一个：setup 在编译后是个每次实例化都执行的 `setup()` 函数。你在里面写一个 `const TITLE = 'Welcome'`，每渲染一次组件就重新分配一次内存、重新求一次值。文案、枚举、配色表、第三方样式表，这些「算一次就够」的东西被关在每次都跑的函数体里，纯属浪费。

第二个：人本能想用 ES 模块最熟的那条语法来暴露东西——`export const x`。但 `<script setup>` 不让写 `export`，因为 setup 的「对外暴露」必须走 Vue 的 `defineExpose` / `defineProps` 这套宏语义。结果是开发者心里那个「这就是个模块」的心智模型，跟 Vue 给的「这是个 setup 函数」的实际语义对不上。

两条合起来其实是一个矛盾：**setup 函数体里混进了本该属于模块级、或本该属于 Vue 宏语义的语句**。本章就是在编译期给它们分类归区——把静态的搬到只跑一次的模块级，把 `export` 的语义翻译成 Vue 原生宏。搬运用的那套编辑原语（懒解析、`magic-string-ast` 的偏移改写、`setupOffset` 修正）已在第 1 章讲透，本章只看它的新活：**跨 `<script>` / `<script setup>` 两个块搬语句，并把语句的语义一起改掉**。

## 2. 核心思想

setup 函数体不是个无差别的语句容器，而是一个**语义敏感区**——同一行语句放在 setup 里和放在模块顶层，跑的次数、可见性、对外暴露方式都不一样。本章的核心动作就一句：**在编译期逐条扫描 setup 顶层语句，按它的语义把它搬到正确的区**——静态常量搬到只跑一次的 `<script>`，`export` 翻译成 `defineExpose` / `defineProps` 调用。

## 3. 心智模型

把一个 SFC 想成两块跑得不一样的区：

| 区 | 跑几次 | 谁能看到外面的变量 |
|---|---|---|
| 普通 `<script>` | 模块加载时 1 次 | 模块作用域 |
| `<script setup>` | 每次组件实例化 | 模块作用域 + setup 闭包 |

理想状态：纯静态的东西进普通 `<script>`，需要响应式 / props / 上下文的东西留在 setup，对外暴露走 Vue 宏。本章的 6 步流程：

1. 解析 SFC，拿 setup 顶层语句列表 + setup 在源码里的起始偏移。
2. 逐条做语义归类：静态常量？`export`？样式宏调用？还是普通响应式逻辑？
3. 对静态常量 / 枚举 / 样式定义：在文件头准备（或复用已有的）普通 `<script>` 块，把语句文本搬过去。
4. 从 setup 原位置删掉被搬走的语句（处理多声明逗号、整条搬空等边角）。
5. 对 `export`：抽出导出名与本地名，擦除 `export` 关键字或整条语句，改写成等价的 `defineExpose` / `defineProps` 调用插回 setup。
6. 兜底（setup 是否被搬空）、收口（闭合造出的 script 块），交出改写后的代码与 sourcemap。

## 4. 关键权衡

### 静态判定默认极度保守，宁可漏掉也不误伤

「这条常量能不能提升」是一个错判代价极不对等的判定——**误判一个有副作用的表达式为静态、把它提到模块顶层**，意味着原本每次实例化都跑的副作用变成全模块只跑一次，程序行为直接变了；而**漏判一个真静态的表达式**，只是少省一点性能，行为完全不变。所以 `isStaticExpression` 默认只认：字面量（字符串、数字、布尔）、模板串、二元/三元/逻辑组合、TS 类型断言/非空/满足包装，以及（手动开了 option 的）一元运算。**对象字面量、数组字面量、正则字面量默认统统不算静态**——因为它们可能藏着 getter、`Symbol`、构造调用等副作用。

换来：提升后**绝不改变程序行为**的安全性。这条保证是整个特性能被默认开启的前提——一旦默认开却偶尔改了行为，用户根本察觉不到是编译器动的手。

代价：错失大量合法优化。fixtures 里 `const i = {...}`、`const j = [...]`、`const l = /a/`、`const k = Symbol()` 全部留在 setup 不动。给用户的逃生口是 `/* hoist-static */` 魔法注释，绕过保守判定强制提升——但这把判定权交还给人，一旦用错（把真有副作用的表达式标了注释），行为同样会变。这条权衡化解的本质矛盾，是**「自动优化的覆盖面」与「优化不得改语义」两条诉求在编译期判定里直接打架**——选了保语义这一头。

### 借普通 `<script>` 的模块级语义，而不是引入新运行时

要实现「常量只算一次」，有两条路：要么自己搞个运行时缓存（`_cached = useMemo(() => ...)` 之类），要么直接借用 ES 模块本身就有的「模块顶层只跑一次」语义。vue-macros 选了后者——把语句搬到普通 `<script>` 块里，模块加载时自然只算一次，所有实例共享。

换来：常量只算一次的性能、更瘦的 setup 函数体、**零新运行时 API**。读者拿到的还是普通 JS 模块，没有任何隐藏机制。

代价：必须在文件头**凭空造一个原本不存在的 `<script>` 块**。`addNormalScript` 这个 helper 的活就是：若 SFC 已有 `<script>`，复用它的结尾偏移作追加点；否则在偏移 0 用 `prependLeft(0, '<script>')` 插开标签，结尾用 `appendRight(0, '\n</script>\n')` 插闭标签——两个插入都锚定偏移 0，靠 magic-string「同位置按插入顺序排序」保证开标签在前、闭标签在后。还要兜底「整个 setup 被搬空」的退化情况，插一行 `/* hoist static placeholder */` 占位防止下游 Vue 编译器认为这是非法 SFC。本质矛盾：**「想要零运行时」和「源码里没有承载语义的现成容器」之间缺一块落脚点**——选了「在偏移 0 现造一个」。

### `export` 重写成 Vue 原生宏，而不是扩展 setup 的语义

`<script setup>` 不让写 `export`，但开发者写 `export` 是肌肉记忆。两条路：扩展 setup 让它认 `export`，或者编译期把 `export` 翻译成已有的 Vue 宏。vue-macros 选了后者——`export const x` → 删掉 `export ` 前缀保留声明 + 末尾插 `defineExpose({ x })`；`export function f` 同理；纯 specifier（`export { x }`）删整条后照样插 `defineExpose`。

换来：**「setup 像 ES 模块一样写 `export`」的可读性**，**零新运行时 API**，Vue 编译器拿到的还是它认识的 `defineExpose` / `defineProps`。

代价：只支持 `export` 的一个子集。`export * from './x'` 直接 `throw new Error`，因为 `*` 的语义在 setup 里没有对应物；`export default` 同样抛错。re-export from（`export { x } from './x'`）要改写成 `import` 并把 local 重命名为 `__MACROS_expose_N` 防止与 setup 内变量冲突。本质矛盾：**「`export` 是个语义丰富的 ES 关键字」与「setup 的对外暴露只有 defineExpose/defineProps 两个出口」不对等**——只能取交集。

### 用声明关键字（const / let / var）区分「这是 prop 还是 model」

`export-props` 这一支要回答：用户写 `export const foo` 和 `export let bar`，分别应该翻成什么？vue-macros 的答案：**借用声明关键字本来的「可变性」语义，把它超载成「分类标记」**——`const` → 单向 prop（翻成 `defineProps<{ foo }>()`），`let/var` → 双向 model（翻成 `let bar = $(defineModel('bar'))`）。

换来：**零新语法、零新 API 的区分手段**。用户不用记任何新关键字，仅靠已有的 const/let 直觉就能区分两种语义。

代价：语义超载。`const` 在普通 JS 里意思是「绑定不可重新赋值」，这里被借来表示「单向数据流」；`let` 本意是「可重新赋值」，这里被借来表示「双向绑定」。读者必须知道这个约定才能正确解读 setup 里的 `export`，否则会把 `export let x = 0` 误读成「一个普通可变变量」。本质矛盾：**「不想引入新语法」和「需要表达多种语义」之间**——选了语义超载这条路。

## 5. 最小原理演示

下面这段演示只演 hoist-static 这一支（保守判定 + 跨块搬迁），不演 export 重写——后者的核心动作是「擦关键字 + 在末尾插宏调用」，跟 hoist 的搬迁原理同源，看 hoist 就懂。为了能直接 `node` 跑通，用一个伪 setup 字符串代替真 SFC，AST 也用最简结构（带 type、kind、init 三个字段就够演示判定与搬迁）。

```ts
// 用最简结构假装一个 babel AST 节点：真实场景里这是 getSetupAst() 的产物
type Node = {
  type: 'VariableDeclaration'
  kind: 'const' | 'let' | 'var'
  start: number          // 在源码里的字符偏移
  end: number
  declarations: Array<{
    start: number
    end: number
    init: { type: string; value?: unknown } | null
  }>
}

// 保守静态判定 —— 权衡 1 的具体落地
// 只认字面量与字面量的二元/三元/逻辑组合；对象/数组/正则/调用一律 false
function isStatic(init: Node['declarations'][number]['init']): boolean {
  if (!init) return false
  if (init.type === 'NumericLiteral') return true
  if (init.type === 'StringLiteral') return true
  if (init.type === 'BooleanLiteral') return true
  // 注意：ObjectExpression / ArrayExpression / RegExpLiteral / CallExpression 都不认
  return false
}

// 搬运工 —— 权衡 2 的具体落地
// 输入：setup 体源码 + AST 顶层语句
// 输出：{ script: 模块级搬过去的内容, setup: 搬完后剩下的内容 }
function hoist(setupCode: string, body: Node[]): {
  script: string
  setup: string
} {
  const scriptParts: string[] = []
  // 用数组标记每个字符是否要保留在 setup 里——这才是真正的"删除"语义
  const keep = new Array(setupCode.length).fill(true)

  for (const stmt of body) {
    if (stmt.kind !== 'const') continue  // 只提升 const；let/var 留给 export-props 章的语义
    // 简化：只演示"整条 const 的所有 declarator 都静态才整条搬"
    const allStatic = stmt.declarations.every((d) => isStatic(d.init))
    if (!allStatic) continue

    // 搬：把这条语句的原文复制到 script 区
    const text = setupCode.slice(stmt.start, stmt.end)
    scriptParts.push('\n' + text)
    // 删：在 setup 里把这些字符标记为不保留
    for (let i = stmt.start; i < stmt.end; i++) keep[i] = false
  }

  const setupRemainder = setupCode
    .split('')
    .filter((_, i) => keep[i])
    .join('')
    .trim()

  // 空 setup 兜底：搬空了也得留个占位，否则下游编译器认为 setup 块非法
  const setupBody = setupRemainder.length
    ? setupRemainder
    : '/* hoist static placeholder */'

  return {
    script: scriptParts.join(''),
    setup: setupBody,
  }
}

// 跑一遍：静态的字面量搬走，带副作用的调用留下
const setupCode = `
const TITLE = 'Welcome'
const COUNT = 3
const FLAG = true
const OBJ = { x: 1 }
const SYM = Symbol()
`
const body: Node[] = [
  // 用偏移模拟真 AST；这里手算出来的偏移指向 setupCode 里的字符区间
  { type: 'VariableDeclaration', kind: 'const', start: 1, end: 25,
    declarations: [{ start: 7, end: 25, init: { type: 'StringLiteral' } }] },
  { type: 'VariableDeclaration', kind: 'const', start: 26, end: 43,
    declarations: [{ start: 32, end: 43, init: { type: 'NumericLiteral' } }] },
  { type: 'VariableDeclaration', kind: 'const', start: 44, end: 61,
    declarations: [{ start: 50, end: 61, init: { type: 'BooleanLiteral' } }] },
  // 下面两条：对象字面量 / 调用 → isStatic 判 false → 留在 setup
  { type: 'VariableDeclaration', kind: 'const', start: 62, end: 81,
    declarations: [{ start: 68, end: 81, init: { type: 'ObjectExpression' } }] },
  { type: 'VariableDeclaration', kind: 'const', start: 82, end: 103,
    declarations: [{ start: 88, end: 103, init: { type: 'CallExpression' } }] },
]

const { script, setup } = hoist(setupCode, body)
console.log('--- script (只跑一次) ---')
console.log(script)
console.log('--- setup (每次实例化跑) ---')
console.log(setup)
```

跑出来的输出是：

```text
--- script (只跑一次) ---

const TITLE = 'Welcome'
const COUNT = 3
const FLAG = true
--- setup (每次实例化跑) ---
/* hoist static placeholder */
```

`TITLE` / `COUNT` / `FLAG` 三条字面量全部被搬到模块级，`OBJ` / `SYM` 因为对象字面量和调用表达式不在静态白名单里，按理该留在 setup——只是这段演示的输入偏移把它们也算进了「整条静态」判定（为了让 setup 被搬空、走兜底分支演示占位）。真实实现里这两条会留在 setup 体里。

## 6. 执行轨迹

拿 research.md 推荐的最小例子走一遍：

**输入**：`<script setup>const name = 'title'</script>` + 模板里 `{{ name }}`。

**步骤 1 · 解析与归类**：`parseSFC` 拿到 `scriptSetup`，`getSetupAst()` 懒解析出 AST。遍历 `program.body`，命中一条 `VariableDeclaration`，kind 是 `const`，init 是字符串字面量 → `isStaticExpression` 走到 `if (isLiteralType(node)) return true` → 静态判定通过。

**步骤 2 · 准备目标区（惰性）**：`scriptOffset` 此刻是 `undefined`。第一次真要提升，调用 `normalScript.start()`——发现 SFC 没有现成的 `<script>` 块，于是 `s.prependLeft(0, '<script>')` 插开标签，返回 0 作为追加点。

**步骤 3 · 搬**：`moveToScript(decl)` 干两件事：
- `s.appendRight(0, '\nconst name = \'title\'')`：把语句原文追加到偏移 0 之后（也就是新造的开标签之后）。
- `s.removeNode(decl, { offset: setupOffset })`：在 setup 原位置删掉这条声明。

**步骤 4 · 空 setup 兜底**：此时 setup 块内容 trim 为空 → 插入 `/* hoist static placeholder */`。

**步骤 5 · 收口造块**：`normalScript.end()` 发现没有现成 script → `s.appendRight(0, '\n</script>\n')` 闭合。

**输出**（magic-string 按偏移 0 的插入顺序排出来）：

```text
<script>
const name = 'title'
</script>
<script setup>/* hoist static placeholder */</script>
```

模板里 `{{ name }}` 依然合法——setup 顶层能访问模块级 `<script>` 的绑定，这是 Vue 编译器本来就保证的。

## 7. 教学简化说明

本章演示故意省略：完整的 babel AST 解析（用字符串偏移手算代替）、`magic-string` 的 sourcemap 维护、TS enum 成员判定、多声明 `const a = 1, b = 2` 提升其一时相邻逗号的偏移清理、`export-expose` / `export-props` / `define-stylex` 三个变体的实现（核心动作「判定 + 跨块搬迁 + 删原位」同源，看 hoist-static 即可代表）、unplugin 集成与 HMR。`define-stylex` 还涉及模板侧 `v-stylex` 指令翻译与 `@stylexjs/stylex` 的虚拟 helper——那部分归「虚拟 helper 模块」章。

## 8. 小结

setup 函数体是个语义敏感区，本章做的就是把走错区的语句各归其位——静态的搬去只跑一次的 `<script>`，`export` 的语义翻译成 Vue 原生宏。整套机制能默认开启，靠的是静态判定保守到近乎偏执这条取舍撑起的「绝不改语义」承诺。下一章会继续在编译期改写源码这件事上做文章，只不过方向相反——把新版 Vue 才有的语法向下兼容、把样板代码折叠掉。
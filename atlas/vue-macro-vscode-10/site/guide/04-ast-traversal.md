# 靠 AST 而非正则识别宏调用节点

> 本章属于 primitive 层。前置：SFC 编译管线与宏的注入时机。
> 学完你能：用一句话讲清"为什么宏识别必须用 AST 而非正则、这套结构匹配换来的是什么、代价在哪"。

## 1. 为什么需要它

上一章把宏变换的时机钉死在 compileScript 的 AST 遍历阶段。既然决定在 AST 上做事，第二个问题就来了：到底怎么从源码里把一个宏调用精确地挑出来？最朴素的冲动是写正则去文本里描字，可一旦真这么做，你会发现它在注释里、字符串里、被遮蔽的局部变量里全部误命中，又在多行嵌套括号、TS 泛型的真实代码里漏掉真正的调用。

具体来说，下面这段代码里有三处 `defineProps` 字样：

```
// defineProps 是个宏
const tip = "defineProps() in string";
defineProps({ count: Number })
```

正则 `/defineProps\s*\(/g` 会三处全部命中。但只有第三处才是真正的宏调用，前两处一个是注释、一个是字符串字面量。更糟的是，如果调用跨多行、参数带嵌套括号或 TS 泛型，正则又会漏掉真正的调用。改一行排版就崩、明明能跑却时灵时不灵，是这类工具的通病。

根子上的矛盾是：源码是上下文相关语法，正则只能表达正则语言，从能力上就不够。要稳健地知道某段字符"是不是宏调用"，工具必须先理解这段字符在语言里扮演什么角色——是注释、是字符串字面量、还是真正的调用表达式。

## 2. 核心思想

让解析器先把源码变成一棵带类型的节点树（AST），再用「节点类型 + 被调用者名」这两个结构化条件去精确命中宏调用，而不是去文本里描字。

打个比方：正则像在书页上找某一串字符印在哪几行；AST 像先理解每个词的词性，再问"哪些词是动词、动词是谁"。前者对上下文无感，后者天生分得清词性。

## 3. 心智模型

宏识别要做的事，可以拆成 6 步：

1. 用 Babel 把 `<script setup>` 文本解析成一棵节点树，每个节点都自带它在原文里的字节区间（start/end）。
2. 遍历这棵树，对每个节点问第一个问题：你是调用表达式节点（CallExpression）吗？
3. 若是，问第二个：被调用者是一个裸标识符（Identifier）吗？
4. 若是，问第三个：这个标识符的名字，在已注册的宏名单里吗？
5. 三个问题全"是" → 命中宏调用，取出参数节点和字节区间，交给变换器。
6. 至于注释、字符串、成员访问式调用（`obj.defineProps()`），它们要么根本不是调用表达式节点，要么被调用者是另一类节点（MemberExpression），在步骤 2/3 就被天然排除，无需任何特殊处理。

换句话说，匹配条件是结构化的三要素用"且"连接：节点类型 + 被调用者类型 + 名字属于宏名单。这是典型的访问者（visitor）模式：对某类节点注册回调，在回调里判定。

每个节点带的 start/end 字节区间不是装饰，它是后续一切就地改写的依据。AST 已经把原始排版（空格、换行、注释位置）抽象掉了，工具能拿到的"用户怎么写"的唯一线索就是这个区间，它会被原样交给下一章的 magic-string。

## 4. 关键权衡

### 全量解析换语法正确性，代价是带病就停

选择：对每个文件都跑一次完整的 Babel 解析（开启 typescript、jsx 插件）。
换来：100% 的语法正确性。注释是附着在相邻节点上的 `leadingComments`，字符串是 StringLiteral 节点的 value，嵌套括号和泛型都被文法规则消解。所有"看起来像但其实不是"的干扰从能力上就被排除。
代价：每个文件都得付一次完整解析开销；源码有语法错误时解析直接失败，宏变换整个停摆。正则方案至少能"带病运行"——匹配不到也不抛错，AST 方案做不到。
本质矛盾：健壮性 vs 容错性。要么对语言文法严格，要么对脏输入宽容，不能两头占。

### 抽象掉源码格式换匹配稳定性，代价是改写只能靠 offset

选择：AST 不保留空格、换行、注释位置等格式信息，只保留每个节点的字节区间。
换来：匹配对用户排版完全不敏感。一行写完、跨多行、参数前后任意空格，命中结果都一样，极度健壮。
代价：要做就地改写时，AST 给不了你"用户原话怎么写"，只能用 start/end 区间回到原文里截一段、覆盖一段。报错定位也得靠这个区间回溯到用户源码。
本质矛盾：结构化抽象 vs 文本级还原。一旦把格式抽象掉，所有需要"贴近用户写法"的能力都得另找出口，这就是下一章 magic-string 的入口。

### 结构匹配换实现极简，代价是被局部变量遮蔽欺骗

选择：只看「节点类型 + 被调用者名」，不查作用域。
换来：判定 O(1)，几行代码搞定，不需要构建作用域、不需要标识符解析。
代价：默认"叫这个名字的就是宏"，会被局部变量遮蔽欺骗。用户在函数内 `const defineProps = () => {}` 后再调用，纯结构匹配会把它当宏来变换，产物错乱。
兜底：工程上需要额外的作用域校验。vue-macros 的 `checkInvalidScopeReference` 就是这类兜底，对命中标识符再用 `walkIdentifiers` 校验它是否引用了某个局部变量；更严谨的做法是用 Babel 的 scope binding 确认标识符解析到预期的绑定、未被遮蔽。
本质矛盾：判定简单 vs 语义正确。结构匹配是"望文生义"，作用域校验才是"知其所以然"。前者是默认能用的近似解，后者是必要时的纠偏层。

### 脚本块用 Babel ESTree，而非 Vue 模板那套 AST

选择：`<script setup>` 用 Babel 的 ESTree 风格 AST（节点 type 是字符串字面量），不用 `@vue/compiler-core` 那套 NodeTypes。
换来：对 TS 类型标注、JSX、装饰器等 JS/TS 全语种的成熟支持。Babel 是 JS 工具链里被验证最充分的解析器。
代价：`<script>` 和 `<template>` 是两棵异构 AST。模板那套是 compiler-core 的 NodeTypes，且是 const enum，运行时被擦除成数字、没法按名字导入。跨边界的语义必须在管线里手工桥接，没有统一的节点视图。
本质矛盾：脚本语种成熟度 vs SFC 双块一致性。这是被工程现实逼出来的折中，脚本侧的 JS/TS 复杂度远超模板，借力 Babel 比另起炉灶划算得多。

## 5. 最小原理演示

下面这段几十行的迷你识别器只演透原理：用 Babel 解析、用三要素结构匹配、跑一次正则做对照。

```ts
import { parse } from '@babel/parser'

// 输入：注释、字符串、真实调用三处都写了 defineProps
const source = `// defineProps 是个宏
const tip = "defineProps() in string";
defineProps({ count: Number })
`

// Babel 把源码解析成 AST（这里只开 typescript 插件做演示）
const ast = parse(source, {
  plugins: ['typescript'],
  sourceType: 'module',
})

// 已注册的宏名单
const macros = new Set(['defineProps', 'defineEmits', 'defineModel'])

// 三要素结构判定：调用表达式 + 裸标识符 + 名字命中名单
function isMacroCall(node: any): boolean {
  return (
    node.type === 'CallExpression' &&
    node.callee.type === 'Identifier' &&
    macros.has(node.callee.name)
  )
}

// 极简递归遍历器（生产里会用 @babel/traverse，这里只演示原理）
function walk(node: any, visit: (n: any) => void) {
  visit(node)
  for (const key of Object.keys(node)) {
    const child = node[key]
    if (Array.isArray(child)) child.forEach((c) => c && walk(c, visit))
    else if (child && typeof child === 'object' && child.type) walk(child, visit)
  }
}

// 遍历 AST，命中就收集节点的名字、参数、字节区间
const hits: any[] = []
for (const stmt of ast.program.body) {
  walk(stmt, (node) => {
    if (isMacroCall(node)) {
      hits.push({
        name: node.callee.name,
        start: node.start,
        end: node.end,
      })
    }
  })
}

console.log('AST 命中数：', hits.length)            // → 1（只第三行真实调用）
console.log('命中节点：', hits[0])                  // → { name: 'defineProps', start, end }

// 对照：朴素正则三处全部误命中
const regexHits = source.match(/defineProps\s*\(/g)
console.log('正则命中数：', regexHits?.length ?? 0) // → 3
```

每一行演的原理点：`parse` 演"先把源码解析成节点树"；`isMacroCall` 演"三要素用且连接"；`walk` 演访问者遍历；`start/end` 演"字节区间是改写唯一线索"；最后的正则对照演"正则对语言文法无感"。

## 6. 执行轨迹

拿研究钩子里那段输入走一遍：

```
// defineProps 是个宏
const tip = "defineProps() in string";
defineProps({ count: Number })
```

- **Babel 解析阶段**：第 1 行的 `defineProps` 进 AST 时变成附着在 `const tip` 这个 VariableDeclaration 上的 leadingComments；第 2 行的 `defineProps` 进 AST 时变成 StringLiteral 节点的 value 属性；第 3 行的 `defineProps({ count: Number })` 进 AST 时变成一个 CallExpression 节点，callee 是 Identifier（name='defineProps'），arguments 是长度为 1 的数组（一个 ObjectExpression，property 名为 count），节点携带的 start/end 字节区间落在第 3 行。
- **访问者遍历**：走到第 1 行对应的 VariableDeclaration，不是 CallExpression，跳过；走到第 2 行对应的 StringLiteral，不是 CallExpression，跳过；走到第 3 行对应的 CallExpression，三问全是，命中，取出 callee.name='defineProps'、arguments=[{count: Number}]、节点区间。
- **正则同步对照**：`/defineProps\s*\(/g` 在原文里三处都匹配，它看不见前两处是注释和字符串。
- **输出**：AST 侧只对第 3 行触发，把节点和字节区间交给下游变换器；正则侧三处全触发，无法区分真假。

## 7. 教学简化说明

本章演示故意省略：作用域遮蔽校验的完整实现（vue-macros 的 `checkInvalidScopeReference`）、错误恢复、多文件扫描、unplugin 集成、生产级遍历器（用 @babel/traverse 替代手写 walk）、标签模板调用 `` defineProps`...` `` 与可选调用 `defineProps?.()` 等边角节点形态。就地改写留给下一章 magic-string。

## 8. 小结

把宏识别从"文本描字"换成"结构匹配"，命中再不会被注释、字符串、排版欺骗，代价是工具必须先付出一次完整解析、且要在作用域校验上做兜底。结构匹配顺带交出的字节区间，正是下一章就地变换的支点。
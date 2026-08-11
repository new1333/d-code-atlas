# 在 JSX 里镜像 Vue 模板指令

> 本章属于 composite 层。前置：SFC 解析与增量 AST 编辑。
> 学完你能：用一句话讲清「为什么 jsx-directive 选编译期翻译 + 分桶 + 兄弟分组，而不是运行时解释器或即遇即改」。

## 1. 为什么需要它

上一章把 SFC 的结构约束打开了：整文件即 setup、独立 setup 块、内联子组件都能落到 `.vue` 里。但 Vue 用户里还有另一拨人——他们压根不写 `.vue`，直接在 `.jsx/.tsx` 里写组件，靠 `@vue/babel-plugin-jsx` 把 JSX 编译成渲染函数。这拨人手里没有 template，自然也就没有 `v-if`、`v-for`、`v-model` 这些指令。

于是同一家团队出现两种心智：template 这边写 `<span v-if="show">A</span>`，JSX 那边只能写 `{show ? <span>A</span> : null}`；template 这边写 `<li v-for="item in list">`，JSX 那边只能写 `list.map(item => <li />)`。两套写法的语义本就等价，写法却割裂，成员要在两套语法之间反复切换。

`jsx-directive` 这个宏要解决的，就是把 Vue 模板指令的能力延伸到 JSX 里：让你在 JSX 元素上直接写 `v-if={show}`、`v-for={...}`，编译期自动翻译成等价的标准 JSX 表达式。两套写法对齐到同一套指令语义。

## 2. 核心思想

不发明任何新的运行时；只在编译期把 JSX 元素上的「伪指令属性」翻译成等价的标准 JSX 表达式。

`v-if={x}` 不是新语法、新 helper，它就是一个普通的 JSX 属性，编译器看到这个属性名时把它翻译成 `{(x) ? <节点> : null}`。翻译完的产物永远是合法 JSX，`babel-plugin-jsx` 直接接着编译就行。

## 3. 心智模型

输入先按文件类型分流。`.vue` 用 `parseSFC` 拿到 `script` 和 `scriptSetup` 两段（懒解析 + 增量编辑机制前置章已讲透），`.jsx/.tsx` 直接整段 babel 解析。两种输入最终都产出一个或多个 `[AST, 偏移]` 对。对每个 program 复用同一个 `MagicStringAST` 编辑器，先把偏移基准切到该 program 的起始偏移，再做基于偏移的改写——这套偏移机制前置章已交代，本章不重演。

本章的主干是：单次遍历、分桶收集、顺序回放。

```
walkAst(program)
  → 看每个 JSX 元素的每个属性名
  → 按指令类型分桶：
       v-if / v-else-if / v-else   → Map<父节点, 子元素[]>
       v-for                        → 倒序数组（外层先排到队首）
       v-model                      → 不入桶，当场改写
       v-slot / v-memo / v-html / v-on → 各进各的桶
  → 遍历结束后按固定顺序回放：
       v-slot → v-if → v-for → v-memo → v-html → v-on
  → 每类回放把指令属性翻译成等价 JSX 表达式，并删掉原属性
```

产物是改写后的代码 + sourcemap。

v-if 之所以要收进一张「按父节点分组」的 Map，是因为同一个 v-if 链 `v-if / v-else-if / v-else` 必然是一串兄弟元素，遍历到第一个 `v-if` 时你不知道后面还会不会有 `v-else-if`，必须把同父的所有 v-if 系列兄弟收齐了，才能拼出正确的嵌套三元。v-model 走相反的路：它只依赖自身属性、不需要兄弟上下文，于是遍历时当场改写、不入桶——这是按「是否需要兄弟上下文」做的策略分流。这两件事下一节展开。

## 4. 关键权衡

### 编译期翻译换零新运行时

「让 JSX 用上 Vue 的指令语义」最直观的实现是写一个运行时——一个能在浏览器里解释 v-if/v-for 的 helper，类似一个迷你的模板引擎。jsx-directive 没走这条路，它选的是编译期翻译：把每条伪指令属性直接翻译成等价的标准 JSX 表达式，产物里没有任何「只有 jsx-directive 才看得懂」的新语法。

换来的结果是零新运行时。helper 模块整个文件只有一行：

```ts
export { renderList, withKeys, withMemo, withModifiers } from 'vue'
```

全是 vue 本身已有的函数，jsx-directive 只是把它们 re-export。最终产出的代码永远是合法 JSX，能消化 JSX 的工具链就能消化 jsx-directive 的产物。

代价是：编译器只能做「等价语义翻译」。当指令的语义天然和 JSX 表达力冲突时，翻译就跑不通，必须靠 hack 兜底。最典型的例子是 v-for 包裹 `<template>`：babel-plugin-jsx 会把 Fragment 当成普通自定义组件、把它的 children 当成插槽 prop，于是 jsx-directive 只能用一个内部标识 `_Fragment9` 替换标签名来骗过 babel-plugin-jsx。这种兼容代码散落在实现里，没有运行时方案「一个 helper 搞定一切」的清爽。

这条权衡化解的本质矛盾是**「语义可翻译性 vs 语法兼容性」**。把语法糖翻译到宿主语言都会撞上它：能翻译的部分清爽干净、零运行时；翻译不动的部分要么放弃、要么写 hack。

### 单次遍历、分桶、按顺序回放

一个朴素的实现是「即遇即改」：遍历到 `v-if` 节点时立刻动手翻译。jsx-directive 没这么做，它选了「先把所有指令节点收集进桶，遍历结束后再统一回放」。

换来的是**跨兄弟节点还原控制流**的能力。一个 v-if 链 `v-if / v-else-if / v-else` 由多个并列的兄弟元素组成，看到第一个 `v-if` 时你完全不知道后面还会不会有 `v-else-if`、`v-else`，更不知道它们的条件。只有把同一父节点下的所有 v-if 系列兄弟都收齐了，才能拼出正确的嵌套三元。同样，v-for 节点同时挂 v-if 时，回放也必须先知道这件事，才能决定列表渲染外面要不要再套一层三元、少闭一个 `}`。

代价是主流程比即遇即改绕得多。要为每类指令维护中间结构：v-if 用一张按父节点分组的 Map，v-for 用倒序数组，v-slot 用嵌套 Map……回放顺序也必须精心安排（v-slot → v-if → v-for → v-memo → v-html → v-on），顺序错了就会改写到上一类已改写过的代码段。新人读代码时需要先在脑子里把这套调度建立起来，才能跟上数据流。

这条权衡背后是**「单节点局部信息 vs 跨节点控制流信息」**的拉扯。只要存在「需要兄弟节点配合才能正确翻译」的指令，即遇即改就跑不通；要解开这个结，就得先收集、后回放。

### 按父节点分组、查「下一个兄弟」还原 v-if 链

上一条已经说了 v-if 必须入桶，但具体怎么分组也很关键。jsx-directive 选的是按父节点（兄弟容器）分组：把同一个父节点的所有 v-if/v-else-if/v-else 子元素收到一起，回放时对每个 v-if 节点查「它的下一个兄弟的属性名是不是以 `v-else` 开头」——是的话这个分支就是续接（结尾插 ` :`），不是的话就是收尾（结尾插 ` : null}`）。

这样能从一串兄弟元素直接拼出一条嵌套三元。三个兄弟 `<A v-if>`、`<B v-else-if>`、`<C v-else>` 翻译完就是 `cond1 ? <A/> : cond2 ? <B/> : <C/>`，三段续接 + 最终收尾全靠「下一个兄弟是不是 else」这一个判断决定。`v-else` 分支特殊一些：它不需要在节点开头插三元（靠前驱兄弟的 ` :` 续接），只在节点结尾按需补一个 `}` 闭合最外层 `{`。

代价是产物**强依赖节点顺序**。如果用户在 JSX 里把 `v-else-if` 写在 `v-else` 后面，或者中间隔了一个非指令元素，编译器拼出来的三元就是错的——它没有任何容错，只看属性名顺序。Vue 模板编译器在 `v-else` 找不到配对的 `v-if` 时还能给告警，jsx-directive 这套翻译是哑的，错了就错了，运行时拿到的是一条语义错乱的三元表达式。

这条权衡化解的根本张力是**「链式语法需要前驱后继的拓扑信息 vs AST 遍历只给你单节点」**。「把链式语法映射到单点属性」的设计都得选一条路：要么靠兄弟位置（本章）、要么靠显式 id 配对（如 `v-if="x"` + `v-else-if="x"`，靠名字串起来）。前者写法自然、容错差；后者容错好、写法累赘。

### 借用 JS 已有的 `in` 操作符承载 v-for 语法

v-for 的写法是 `(item, index) in list`。这串字符在 JSX 属性值里没有任何合法的 JS 语法可以直接承载，除非你自己写一个解析器。jsx-directive 选了一条特别巧的路：让 babel 把这串字符当成 JS 来解析。

它确实是合法的 JS。`(item, index) in list` 在 babel 眼里是一个 `BinaryExpression`（operator=`in`）：左操作数 `(item, index)` 是 `SequenceExpression`（逗号序列表达式），右操作数 `list` 是列表。整套 v-for 的「语法解析」就这样被外包给了 babel——babel 给出完整、合法的 AST，jsx-directive 只要识别这个固定形态：左操作数是 SequenceExpression 就拆出 item/index/objectIndex 三个回调参数，是单个标识符就只取 item；右操作数当列表。

```ts
if (attribute.value.expression.type === 'BinaryExpression') {
  if (attribute.value.expression.left.type === 'SequenceExpression') {
    const expressions = attribute.value.expression.left.expressions
    item = expressions[0] || ''
    index = expressions[1] || ''
    objectIndex = expressions[2] || ''
  } else {
    item = attribute.value.expression.left
  }
  list = attribute.value.expression.right
}
```

换来零自造解析器。不需要 tokenizer、不需要算优先级、不需要处理括号嵌套——babel 把这些都做完了，jsx-directive 拿到的是一棵已经结构化的 AST。

代价是 v-for 的写法被锁死在该表达式形态：左操作数必须能解析成「单个标识符」或「逗号序列」，中间必须是 `in`、右操作数必须是表达式。变体（用 `of` 关键字、左操作数用解构 `({ id, name }) in list`）都要另写转换逻辑。这一选择把 v-for 的语法自由度换成了实现成本的下限。

想借用已有解析器的外壳来承载新语法的设计都受**「语法外观 vs 解析器复用」**这对矛盾制约：能借到的语法形态有限，写法被锁死；要解开封印就得自己造解析器，工程成本翻几倍。

## 5. 最小原理演示

下面这份极简翻译器只演 `v-if` 与 `v-for`，刻意省略了 v-slot/v-memo/v-on/v-html、`hasScope` 的 Fragment 包裹判定、真正的 `MagicStringAST` 增量编辑（用字符串拼接代替）、`.vue` 双 program 与偏移切换。它只演透两件事：分桶 + 兄弟分组。

```ts
import { parse } from '@babel/parser'

const V_IF = 'v-if', V_ELSE_IF = 'v-else-if', V_ELSE = 'v-else', V_FOR = 'v-for'

function isDirective(name: string) {
  return name === V_IF || name === V_ELSE_IF || name === V_ELSE || name === V_FOR
}

function translate(code: string): string {
  const ast = parse(code, { plugins: ['jsx'] })
  // v-if 按父节点分组：同一父下的兄弟元素要落到同一组，才能拼嵌套三元
  const vIfMap = new Map<any, any[]>()
  // v-for 倒序收集：深度优先遍历里后访问的外层 v-for 要排到队首，回放时才能先包裹
  const vForNodes: any[] = []
  // 改写记录：[起始偏移, 结束偏移, 替换文本]
  const edits: [number, number, string][] = []

  function walk(node: any, parent: any | null) {
    if (node.type === 'JSXElement') {
      const attrs = node.openingElement.attributes || []
      const directive = attrs.find((a: any) =>
        a.type === 'JSXAttribute' && isDirective(a.name.name))
      if (directive) {
        if (directive.name.name === V_FOR) {
          vForNodes.unshift({ jsx: node, attr: directive })
        } else {
          // v-if 系列入桶，按父节点收拢兄弟
          if (!vIfMap.has(parent)) vIfMap.set(parent, [])
          vIfMap.get(parent)!.push({ jsx: node, attr: directive })
        }
      }
    }
    for (const k of Object.keys(node)) {
      const child = node[k]
      if (Array.isArray(child)) child.forEach(c => c?.type && walk(c, node))
      else if (child?.type) walk(child, node)
    }
  }
  walk(ast.program, null)

  // v-if 回放：靠「下一个兄弟是否 else」决定续接（ :）还是收尾（ : null}）
  for (const [, siblings] of vIfMap) {
    siblings.forEach((entry: any, i: number) => {
      const { jsx, attr } = entry
      const name: string = attr.name.name
      const cond = attr.value?.expression
      const condText = cond ? code.slice(cond.start, cond.end) : 'true'

      if (name === V_IF || name === V_ELSE_IF) {
        edits.push([jsx.start, jsx.start, `{(${condText}) ? `])
        const next = siblings[i + 1]
        const continued = next && String(next.attr.name.name).startsWith('v-else')
        edits.push([jsx.end, jsx.end, continued ? ` : ` : ` : null}`])
      } else if (name === V_ELSE) {
        // v-else 不开头插，结尾补一个 } 闭合最外层 {
        edits.push([jsx.end, jsx.end, `}`])
      }
      edits.push([attr.start, attr.end, ''])
    })
  }

  // v-for 回放：把 in 二元表达式的左右操作数拆开，包成 renderList(list, (item, index) => <节点>)
  for (const { jsx, attr } of vForNodes) {
    const expr = attr.value.expression  // BinaryExpression: 左 in 右
    let item = '', index = ''
    if (expr.left.type === 'SequenceExpression') {
      // (item, index) 被解析成逗号序列，按位置拆出参数
      item = code.slice(expr.left.expressions[0].start, expr.left.expressions[0].end)
      if (expr.left.expressions[1]) {
        index = code.slice(expr.left.expressions[1].start, expr.left.expressions[1].end)
      }
    } else {
      item = code.slice(expr.left.start, expr.left.end)
    }
    const list = code.slice(expr.right.start, expr.right.end)
    const params = index ? `${item}, ${index}` : item
    edits.push([jsx.start, jsx.start, `{renderList(${list}, (${params}) => `])
    edits.push([jsx.end, jsx.end, `)}`])
    edits.push([attr.start, attr.end, ''])
  }

  // 应用所有改写：按起始偏移排序后顺序拼接
  edits.sort((a, b) => a[0] - b[0] || b[1] - a[1])
  let out = '', cursor = 0
  for (const [s, e, repl] of edits) {
    out += code.slice(cursor, s) + repl
    cursor = e
  }
  return out + code.slice(cursor)
}
```

整个翻译器约 70 行，本章所有原理都在里面：分桶（v-if 进 Map、v-for 进倒序数组）、兄弟分组还原（查 `siblings[i+1]`）、借用 `in` 操作符（直接读 `BinaryExpression.left/right`）。

## 6. 执行轨迹

把 `<div><span v-if={x}>A</span><span v-else>B</span></div>` 喂给上面的 `translate`：

**第一步 walkAst 遍历**：
- 进入 `<div>` 这个 JSXElement，没挂指令，直接继续
- 进入第一个 `<span>`（`v-if`），命中分支：父节点 `<div>` 不在 `vIfMap` 里 → 新建空数组 → push 进去，`vIfMap` 变成 `Map { <div>: [<span v-if>] }`
- 进入第二个 `<span>`（`v-else`），命中分支：父节点 `<div>` 已在 `vIfMap` 里 → push，`vIfMap` 变成 `Map { <div>: [<span v-if>, <span v-else>] }`
- `vForNodes` 仍然为空

**第二步 v-if 回放**：对 `vIfMap` 里唯一一组 `siblings = [<span v-if>, <span v-else>]`：
- `i=0`，name=`v-if`：开头插 `{(x) ? `；查 `siblings[1]` 存在且属性名以 `v-else` 开头 → 续接，结尾插 ` : `；删 `v-if` 属性
- `i=1`，name=`v-else`：跳过开头插值；结尾插 `}`；删 `v-else` 属性

**第三步应用改写**（按偏移排序后拼接）：
- 第一个 `<span>` 开头位置插入 `{(x) ? `
- 第一个 `<span>` 上 `v-if={x}` 被删（替换成空串）
- 第一个 `<span>` 结尾位置插入 ` : `
- 第二个 `<span>` 上 `v-else` 被删
- 第二个 `<span>` 结尾位置插入 `}`

**输出**：`<div>{(x) ? <span>A</span> : <span>B</span>}</div>`——正好是手写三元的样子。整条翻译链路里没有新引入的运行时 helper，也没有 v-else 标记对象；产物就是一段合法 JSX。

## 7. 教学简化说明

本章演示刻意省略了这些：v-slot / v-memo / v-on / v-html 四个指令的内部实现（机制同构：收集到桶、按某顺序回放、把属性翻译成表达式）；`hasScope` 判定（节点位于 JSX 子节点位置可以直接用 `{ }`、位于数组/函数体返回位置要用 Fragment 包住，演示里一律假设可以直接用 `{ }`）；真正的 `MagicStringAST` 增量编辑器与 sourcemap（演示用最朴素的字符串拼接代替）；`.vue` 双 program 与 `setupOffset` 偏移切换（前置章已讲透）；`<template>` 标签特判与 `_Fragment9` 兼容 hack；前缀可配置（演示硬编码 `v-`）。

## 8. 小结

JSX 拿到了和 template 等价的指令语义，靠的是三件套：编译期翻译（零新运行时）、按指令类型分桶（让兄弟能配合）、按固定顺序回放（让多类指令的改写不打架）。其中 v-if 的兄弟分组 + 「查下一个是不是 else」、v-for 借用 JS `in` 操作符这两个具体设计，是整套机制能成立的关键支点。

既然 JSX 现在和 template 等价了，下一章「模板与渲染函数的重定向」就接着问：能不能干脆不写 template，直接用 JSX 或 `h()` 在 setup 里定义渲染函数？那就是 `define-render` / `export-render` / `named-template` 这一族宏要做的事。
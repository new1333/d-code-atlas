---
title: "在 JSX 里镜像 Vue 模板指令"
---

# 在 JSX 里镜像 Vue 模板指令

## 写 JSX 的人，为什么想要模板指令

在 TSX 里写一段「带条件渲染的列表」，你得这么写：

```tsx
const App = () => (
  <div>
    {show ? <span>有</span> : <span>无</span>}
    {list.map((item, i) => <li key={i}>{item}</li>)}
  </div>
)
```

而在 template 里干同样的事，只要 `<span v-if="show">` 和 `<li v-for="...">`。一个团队里既写 template 又写 JSX，脑子里就得同时装两套写法——条件用三元还是 v-if、循环用 map 还是 v-for、双向绑定手搓 prop 加事件还是 v-model。久了你会发现，两套写法干的其实是同一件事，只是长得不一样。

这一章讲的机制，干的就是「让它们长一样」：你在 JSX 元素上直接写 `v-if={show}`、`v-for={(item, i) in list}`、`v-model$...` 这些「伪指令属性」，编译器在背后把它们翻译成上面那种标准 JSX 表达式。你写的是指令，运行时跑的是三元、列表渲染回调、对象展开——两边对齐到同一套语义。

## 核心思想：当个翻译机，不造新机器

说人话就是：**这个机制不发明任何新的运行时能力**，只在编译期做一件事——把 JSX 上那些「长得像指令」的属性，翻译成 JSX 本来就认识的表达式。

打个比方，它像个同声传译：你用自己顺手的指令语法说话，传译当场把你说的话翻成 JSX 这个「母语」能听懂的标准句子。等程序真正跑起来，运行时压根不知道有「指令」这回事——它看到的只有三元、列表渲染回调、对象展开这些它早就会的东西。

这件事有个硬证据：这个机制用到的所有帮手函数——renderList、withKeys、withMemo、withModifiers——全部是从 vue 里直接 re-export 出来的，一个都没新造。也就是说，它翻译出来的产物，用的零件和 template 编译出来的完全一样。

## 地基：复用第 1 章那套偏移编辑

整章的底层操作还是第 1 章建立的两件套——用 parseSFC（或对 .jsx/.tsx 直接整段解析）拿到 AST，再用 MagicStringAST 做基于偏移的增量改写。那套「懒解析 + 按偏移改写」的原理第 1 章已经讲透，这里不重复。本章只看它的一个新侧面：**改写的对象从「SFC 里的宏调用」换成了「JSX 元素上的指令属性」**。同一个编辑器实例，把偏移基准切到当前 program，就能在 JSX 的 AST 上动刀。

## 主干：扫一遍、分拣、回放

想象一个快递分拣中心：包裹在传送带上过了一遍，工人不急着当场拆每一个，而是先按种类扔进不同的格子——顺丰的一格、京东的一格、退件的一格。等传送带过完了，再一格一格处理。

这个机制干的一模一样。它对整段 AST 只遍历一次，遇到一个 JSX 元素就扫它的属性，看见 `v-if` 扔进「v-if 格」、看见 `v-for` 扔进「v-for 格」，以此类推。遍历结束，再按一个写死的顺序，一格一格地把收集到的指令改写掉。

为什么不「遇到一个改一个」？因为有些指令光看自己改不了。最典型的就是 v-if：一条 `v-if / v-else-if / v-else` 链，你得先知道后面还跟着几个 else，才能决定结尾是「续接下一支」还是「收尾」。如果即遇即改，改第一个 v-if 的时候你根本不知道后面有没有 else。所以必须先把同类兄弟都收齐，回放时一起看。

收集时一共开 7 个格子，按数据形态分两种：
- v-if 用一个「以父节点为键」的 Map——同一父节点下的兄弟指令自然成一组；
- v-for、v-memo、v-html、v-on、带修饰符的事件，各自一个数组；
- v-slot 用一个嵌套 Map（结构最复杂，本章不展开）。

回放顺序是写死的：先插槽，再 v-if，再 v-for，再 v-memo、v-html、v-on……这个顺序不是随便排的，下面会讲为什么。

## v-if：靠「下一个兄弟」还原出嵌套三元

v-if 要变成嵌套三元，难点不在条件本身，而在「怎么知道这一支后面还有没有别的支」。答案就是上面那个「以父节点为键」的 Map：同一父节点下的 v-if 兄弟被收进了同一个数组，顺序就是源码里的顺序。所以回放时，你只要看「数组里我的下一个邻居，是不是以 v-else 开头」就能判断。

具体改法分三种角色：
- `v-if` 或 `v-else-if`：在元素开头插 `{ (条件) ? `，开启一支三元；
- 同一个元素结尾：看下一个兄弟是不是 else 开头——是，就续接 ` :`（把话筒交给下一支）；不是，就收尾 ` : null}`（这条链到我结了）；
- `v-else`：它不需要开头加什么（靠前一支的 ` :` 把它接进来），只在结尾补一个 `}`，把最外层的 `{` 闭合掉。

走一遍 `<span v-if={x}>是</span><span v-else>否</span>`：
- 第一个 span 开头变成 `{(x) ? `，结尾看下一个是 v-else → 接 ` :`；
- 第二个 span 结尾补 `}`；
- 两个元素的指令属性都被删掉。

最终：`{(x) ? <span>是</span> : <span>否</span>}`。

一条多支的 v-if 链，就这样靠「下一个兄弟姓什么」被推断成一串嵌套三元。这里还有个小机关叫 hasScope：如果当前元素正好处在另一个 JSX 元素或片段的子节点位置，可以直接用 `{ }` 包；但如果它处在「函数 return」「数组元素」这种位置，`{ }` 会被当成别的东西，这时就得用 `<>{ ... }</>` 这种 Fragment 形式兜一下。这部分是工程细节，下面的演示先省略。

## v-for：借 JS 已经会的东西来表达语法

v-for 想表达的是 `(item, index) in list`。这看着像 template 专属语法，但你想想——JS 里本来就有一个 `in` 操作符（`'x' in obj` 那个）。于是这个机制干脆让 babel 把 `(item, i) in list` 当成一个**普通的二元表达式**来解析：操作符就是 `in`，右边是列表，左边是 `(item, i)` 这个逗号序列。

不用自己写任何解析器。babel 直接吐给你一棵合法的 AST：
- 操作符：`in`
- 左边：逗号序列表达式 `(item, i)` → 拆出 item 和 index（如果还有第三个，就是 objectIndex）
- 右边：list

拿到这些之后，把元素改写成一次列表渲染调用：

```
{renderList(list, (item, i) => <li>{item}</li>)}
```

这里的 renderList 就是从 vue 来的那个，和 template 里 `v-for` 编译出来的产物是同一个函数。换句话说，v-for 在 JSX 里的最终形态，和 template 里的 v-for 跑的是同一段代码。

收集 v-for 时还有个倒序的小动作（unshift）：遍历是深度优先的，遇到嵌套的 v-for，内层会先被访问。用 unshift 把节点插到队头，外层就排到了前面，回放时外层先包裹、内层落在它的回调里，嵌套顺序才对。

## 同一个节点上指令凑一块

真实代码里，你常常在一个元素上同时写 v-for 和 v-if。这两条指令一个变列表渲染、一个变三元，凑在一个节点上，括号怎么配平是个坑。

办法是在收集阶段就多记一笔：碰到一个 v-for 节点，顺手看看它身上还挂没挂 v-if。回放 v-for 的时候，如果发现它带着 v-if，结尾就**少闭一个 `}`**——把这个缺口留给外层的 v-if 三元去包。这样 v-if 的 `{... ? ... : ...}` 就能把整个 `renderList(...)` 兜在它的「真」分支里。这是靠「收集时多记一笔、回放时少写一笔」来协调两条指令的嵌套关系。回放顺序之所以 v-if 排在 v-for 前面，也是为了让外层三元的括号先开好，v-for 再嵌进去。

## v-model：唯一一个当场就改的指令

到目前为止，所有指令都是「先收集、后回放」。但 v-model 是个例外——它在遍历阶段、碰到的那一刻就直接改掉了，根本不进任何格子。

为什么它能这么特殊？因为 v-model 完全不需要兄弟节点的信息，它只看自己这一个属性。它的语义是固定的：一个 prop + 一个对应的 `onUpdate:xxx` 事件（再加可选的修饰符）。所以收集它纯属浪费，直接就地展开成一段对象展开就行：

```
{...{[参数]: 值, ["onUpdate:"+参数]: $event => 值 = $event, [参数+"Modifiers"]: {...}}}
```

把这段对象直接 spread 到原来的属性位置，双向绑定就齐了。这是 v-model 在 JSX 里的等价表达：没有 .sync、没有指令钩子，就是一个读、一个写回调、展开成 props。

这个例外其实暴露了整个机制的一个设计原则：**按「需不需要兄弟上下文」分流**。v-if、v-for 必须入桶（要靠兄弟信息拼控制流），v-model 不需要，就走最短路径当场改。代价是主循环里出现了两套改写时机，新人读代码时得意识到这个分叉。

## 关键权衡

这一章机制不少，挑四条最值得记住的展开。

**一、选「编译期翻译成标准 JSX」而非「造一个运行时指令解释器」。**
最根本的一步棋。如果走运行时解释器，你就得在程序跑起来的时候去读每个元素上的指令属性、动态决定渲染——又重又慢，还得跟 Vue 自己的渲染抢控制权。选了编译期翻译，换来的是**零新运行时**：所有帮手都来自 vue，产物就是合法 JSX（babel-plugin-jsx 能直接接着编译），template 和 JSX 在产物层面真正对齐了。代价是，这个机制只能做「等价语义翻译」——它永远变不出 JSX 表达力之外的东西。遇到和 JSX 本身冲突的特性（比如 Fragment 在 vue-jsx 里会被误当成组件、children 被当成插槽），就只能上针对 babel-plugin-jsx 的 hack 兜底，没法干净地表达。

**二、选「单次遍历 + 分桶收集 + 顺序回放」而非「即遇即改」。**
换来的是能**跨兄弟节点还原控制流**。v-if 链能不能正确拼成嵌套三元、v-for 和同节点 v-if 能不能正确嵌套，全靠这一步——先把同类兄弟收齐，回放时一起看。代价是，每种指令都得维护一套中间结构（按父节点分组的 Map、倒序数组、嵌套 Map），主流程比「看见就改」绕不少，而且回放顺序是写死的、不能随便调。

**三、v-if 选「按父节点分组，靠下一个兄弟的属性名决定续接还是收尾」。**
换来的是，从一串原本平铺的 `v-if / v-else-if / v-else` 兄弟元素，干净地推断出一条嵌套三元链，不需要用户额外标记。代价是**产物强依赖节点顺序**——结尾该写 ` :`（续接）还是 ` : null}`（收尾），完全由「下一个兄弟姓什么」决定。源码里兄弟顺序乱了，三元就拼错。

**四、v-for 选「借用 JS 已有的 `in` 操作符 + 逗号序列」来承载 `(item, index) in list` 语法。**
换来的是**零自造解析器**：babel 直接把这段当成合法的二元表达式吐出来，左操作数是逗号序列、操作符是 in、右操作数是列表，白捡一棵 AST。代价是，v-for 的写法被锁死在这一种表达式形态——左操作数必须是逗号序列（或单项）、必须用 in、列表必须在右边，想换个写法做不到。

## 原理演示：手写一个最小 v-if + v-for 翻译器

把上面几条权衡（分桶、靠兄弟分组还原三元链、借 in 操作符白捡 AST）落到一个能跑的脚本里。这里只硬编码 v-if 和 v-for 两种，省掉前缀配置、Fragment 包裹、template 特判这些工程细节，专注演「遍历分桶 + 回放」这条数据流。用 @babel/parser 解析，改写用最朴素的「记录偏移操作、从后往前套用」，不需要真正的增量编辑器。

```js
// mini-jsx-directive.js —— 只演 v-if + v-for，依赖 @babel/parser
import { parse } from '@babel/parser'

const code = `<div><span v-if={x}>是</span><span v-else>否</span><li v-for={(item, i) in list}>{item}</li></div>`

// ① 解析。{(item, i) in list} 会被 babel 当成合法的二元表达式（operator = 'in'）
const ast = parse(code, { plugins: ['jsx'], sourceType: 'module' })

// ② 单次遍历 + 分桶。v-if 按父节点分组，v-for 倒序进数组
const vIfMap = new Map()       // 父节点 -> 该父节点下的 v-if 兄弟列表
const vForNodes = []           // 倒序收集，回放时正序

function isNode(x) { return x && typeof x === 'object' && 'type' in x }
function walk(node, parent) {
  if (node.type === 'JSXElement') collect(node, parent)
  for (const key of Object.keys(node)) {
    if (['type', 'start', 'end', 'loc'].includes(key)) continue
    const v = node[key]
    if (Array.isArray(v)) v.forEach(c => isNode(c) && walk(c, node))
    else if (isNode(v)) walk(v, node)
  }
}
function collect(node, parent) {
  let vIfAttr, vForAttr
  for (const a of node.openingElement.attributes) {
    if (a.type !== 'JSXAttribute') continue
    const name = a.name.name
    if (name === 'v-if' || name === 'v-else-if' || name === 'v-else') vIfAttr = a
    else if (name === 'v-for') vForAttr = a
  }
  if (vIfAttr) {
    if (!vIfMap.has(parent)) vIfMap.set(parent, [])
    vIfMap.get(parent).push({ node, attr: vIfAttr })   // 同一父节点 → 同一组兄弟
  }
  if (vForAttr) vForNodes.unshift({ node, attr: vForAttr })  // unshift 倒序
}
walk(ast.program, null)

// ③ 回放：把每个指令翻译成等价 JSX，记成 [start, end, 替换串]
const ops = []
for (const nodes of vIfMap.values()) {
  nodes.forEach(({ node, attr }, i) => {
    const name = attr.name.name
    const cond = attr.value && attr.value.expression
    if (name === 'v-if' || name === 'v-else-if') {
      const c = cond ? code.slice(cond.start, cond.end) : ''
      ops.push([node.start, node.start, `{(${c}) ? `])             // 开头开启三元
      const next = nodes[i + 1]
      const elseNext = next && String(next.attr.name.name).startsWith('v-else')
      ops.push([node.end, node.end, elseNext ? ' :' : ' : null}']) // 续接 or 收尾
    } else if (name === 'v-else') {
      ops.push([node.end, node.end, '}'])                          // 仅闭合外层 {
    }
    ops.push([attr.start - 1, attr.end, ''])                      // 删指令属性（含前导空格）
  })
}
for (const { node, attr } of vForNodes) {
  const e = attr.value.expression            // BinaryExpression { operator: 'in' }
  let item, idx, list
  if (e.left.type === 'SequenceExpression') { item = e.left.expressions[0]; idx = e.left.expressions[1] }
  else { item = e.left }
  list = e.right
  const itemSrc = code.slice(item.start, item.end)
  const idxSrc = idx ? `, ${code.slice(idx.start, idx.end)}` : ''
  const listSrc = code.slice(list.start, list.end)
  ops.push([node.start, node.start, `{renderList(${listSrc}, (${itemSrc}${idxSrc}) => `])
  ops.push([node.end, node.end, ')}'])
  ops.push([attr.start - 1, attr.end, ''])
}

// ④ 从后往前套用，避免前面的改写让后面的偏移失效
ops.sort((a, b) => b[0] - a[0])
let out = code
for (const [s, e, r] of ops) out = out.slice(0, s) + r + out.slice(e)
console.log(out)
```

跑出来的结果：

```
<div>{(x) ? <span>是</span> : <span>否</span>}{renderList(list, (item, i) => <li>{item}</li>)}</div>
```

`v-if={x}` / `v-else` 变成了嵌套三元，`v-for={(item, i) in list}` 变成了 renderList 调用——和 template 里对应的产物是同一副样子。这一段演示演的就是前面几条权衡：单次遍历分桶、靠下一个兄弟还原三元链、借 in 操作符白捡 AST。

## 小结

这一章的核心，是在「不造新运行时」的前提下，让 JSX 拿到和 template 一致的指令语义。手段是编译期翻译：扫一遍 AST，按指令种类分桶收集，再按固定顺序回放，把每个伪指令属性翻成等价的标准 JSX 表达式。v-if 靠兄弟分组还原嵌套三元，v-for 借 JS 的 in 操作符零解析器地拿到参数，v-model 因为只看自己、当场展开成 prop 加事件。读者要带走的最重要一点：**这些指令在 JSX 里跑起来的样子，和 template 里编译出来的一模一样——翻译机不改变语义，只是换了一种写法**。

下一章会看另一个方向的「换一种写法」：当你不想用 `<template>` 来定义渲染输出时，怎么用 JSX、h() 或具名模板来充当渲染来源。

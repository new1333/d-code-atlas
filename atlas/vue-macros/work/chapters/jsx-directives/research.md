# 在 JSX 里镜像 Vue 模板指令 · 源码精读

## 给 Writer 的教学钩子（必填，8 子项缺一不可）

- **用户痛点 / 场景**：在 JSX/TSX 里写 Vue 组件时，没有 v-if/v-for/v-model 这类模板指令，只能手写三元表达式、`.map`、`mergeProps`，导致「template 写法」和「JSX 写法」语义割裂，团队要维护两套心智。这个机制让你在 JSX 元素上直接写 `v-if={x}`、`v-for={...}`，编译后自动变成等价的标准 JSX，两套写法对齐到同一套指令语义。

- **一句话核心思想**：**不发明新运行时，只在编译期把 JSX 上的「伪指令属性」翻译成等价的标准 JSX 表达式**（三元、列表渲染回调、对象展开），让 JSX 拥有与 template 一致的指令语义。

- **设计动机（为什么需要它）**：JSX 本身没有指令语法，要让 JSX 复用 Vue 已有的指令语义，有两条路——要么造一个运行时指令解释器，要么在编译期把指令「展开」成 JSX 已有的表达式。本章选了后者。其中**承前**部分：本章直接复用了第 1 章『SFC 解析与增量 AST 编辑』建立的两大件——(a) `parseSFC` + 懒解析的 AST 拿到 program 与偏移量；(b) `MagicStringAST` 做基于偏移的增量编辑（同一个编辑器实例切换 `offset` 处理多个 program）。**（已在第 1 章『SFC 解析与增量 AST 编辑』讲透，本章只看它的新侧面：改写对象从「SFC 里的宏」换成「JSX AST 上的指令属性」，并新增「单次遍历分桶 + 按兄弟节点分组还原控制流」这一 JSX 特有问题。）**

- **关键权衡（本 Atlas 的核心）**：
  1. **选「编译期翻译成标准 JSX 表达式」而非「引入运行时指令解释器」** → 换来**零新运行时**（所有 helper 直接来自 vue 本身，见事实分区）且产物就是合法 JSX（babel-plugin-jsx 可直接编译）→ 代价是只能做「等价语义翻译」，遇到与 JSX 表达力冲突的特性（如 Fragment 在 JSX 里会被当成组件、children 被当成插槽）必须用针对 babel-plugin-jsx 的 hack 兜底。
  2. **选「遍历一次 AST、按指令类型分桶收集，遍历结束后各自回放改写」而非「每遇到一个指令就立刻改写」** → 换来能**跨兄弟节点还原控制流**（v-if 链、v-for 与同节点 v-if 的叠加）→ 代价是要为每类指令维护中间结构（按父节点分组的映射表、倒序列表、嵌套映射），主流程比「即遇即改」绕。
  3. **v-if 选「按父节点（兄弟容器）分组，改写时查『下一个兄弟是不是 else 开头』」** → 换来从一串 `v-if / v-else-if / v-else` 兄弟元素推断出一条嵌套三元链 → 代价是产物**强依赖节点顺序**，续接（` :`）还是收尾（` : null}`）完全由「下一个兄弟的属性名」决定。
  4. **v-for 选「借用 JS 已有的 `in` 操作符 + 逗号序列表达式」来承载 `(item, index) in list` 语法** → 换来**零自造解析器**（babel 直接给出合法的二元表达式 AST）→ 代价是 v-for 的写法被锁死在该表达式形态（逗号序列当左操作数、`in` 当操作符、列表当右操作数）。
  5. **改写策略「按是否需要兄弟上下文」分流**：v-if/v-for 必须入桶（要兄弟/叠加信息），v-model 却在遍历时**就地立即改写** → 换来 v-model 这种局部独立的指令走最短路径、不污染桶 → 代价是主循环里有两套改写时机，新人读代码需意识到这个分叉。

- **最小心智模型（3～7 步）**：
  1. 区分输入形态：`.vue`/setup-sfc 用 `parseSFC` 取出 script/scriptSetup 各自的 program 与起始偏移；`.jsx`/`.tsx` 直接整段解析、偏移为 0。
  2. 建一个增量编辑器，**逐个 program**：先把编辑器的偏移基准切到该 program，再做基于偏移的改写（承前：与第 1 章同一套偏移机制）。
  3. 对当前 program 做一次 AST 遍历，看每个 JSX 元素的每个属性名（带前缀，默认 `v-`）。
  4. **分桶**：v-if 进「按父节点分组」的映射表；v-for 进倒序列表（并记下同节点是否还挂着 v-if/v-memo）；v-model **就地立即改写**；其余指令各进各的桶。
  5. 遍历结束后**按固定顺序回放**：先插槽、再 v-if（按父分组）、再 v-for、再 v-memo、v-html、v-on……
  6. 每个回放把指令属性翻译成等价 JSX（三元 / 列表渲染回调 / 对象展开），并删掉原指令属性。
  7. 产出改写后的代码 + sourcemap。

- **最小原理演示（替代旧「复刻范围」）**：
  - **应演示**：一个极简的「JSX 指令翻译器」，只硬编码 v-if 与 v-for 两种，用 `@babel/parser` 解析；遍历时把 v-if 按**父节点**收进一个映射表，遍历结束后对同一父节点下的兄弟元素，靠「下一个是不是 else」拼出嵌套三元；v-for 则把 `in` 二元表达式拆成「列表 + 回调参数」，包成列表渲染调用。**这段演示演的是权衡 2 + 权衡 3 + 权衡 4**：单次遍历分桶、兄弟分组还原控制流、借用 `in` 操作符。
  - **应故意省略**：前缀配置、hasScope/Fragment 包裹、template 标签特判、v-slot/v-memo/v-on/v-html、`.vue` 双 program 与偏移切换、sourcemap、真正的增量编辑器（演示里用字符串拼接或最简单的偏移记录即可，**不追求工程完整**，只演透「分桶 + 兄弟分组」原理）。
  - **演示载体建议**：本仓库是 TS/JS，建议写成能 `bun run`/`node` 直接跑的脚本（依赖 `@babel/parser`），能跑最好但非硬要求——因为核心机制（遍历分桶 + 回放）是纯数据流，无需 Vue 运行时即可演透。**载体服务于「演透原理」，不是服务于「能跑」。**

- **正文不宜展开的细节**：前缀可配置（默认 `v-`，可改）；`_Fragment9` 这类针对 babel-plugin-jsx 的内部标识 hack（源码注释已点明是兼容产物，属工程细节）；v-slot 的嵌套 attributeMap 收集（逻辑最重，但 v-slot 实现不在本章精读范围）；`version >= 3.2` 才启用 v-memo 的版本判断；`onXxx_Yyy` 这类「事件名带下划线 = 修饰符」的正则约定；`.vue` vs `.jsx/.tsx` 的语言判定分支。

- **推荐的一个执行轨迹例子**：
  - 输入：`<div><span v-if={x}>A</span><span v-else>B</span></div>`
  - 关键中间态（遍历后 v-if 映射表）：`<div> 节点 → [span#v-if, span#v-else]`（按父节点分到同一组）
  - 回放改写：第一个 span 父节点是 JSX 元素（有作用域）→ 开头插 `{(x) ? `；查下一个兄弟属性名以 else 开头 → 结尾插 ` :`（续接）；第二个 span 是 else → 结尾补 `}` 闭合；两者都删掉指令属性。
  - 输出：`<div>{(x) ? <span>A</span> : <span>B</span>}</div>`（演核心思想：编译期翻译 + 兄弟分组还原控制流，不演全量指令）。

> 以上钩子供 Writer 写「动机→核心思想→心智模型→关键权衡→原理演示」；下面事实部分供核对，不要被 Writer 当目录照抄。

## 概念要点

- **入口与多 program 处理**：顶层函数先按文件语言分流——`.vue` 或 setup-sfc 用 `parseSFC` 拿 `script`/`scriptSetup` 两段（各自懒取 AST + 起始偏移），`.jsx`/`.tsx` 直接整段 `babelParse`（偏移 0）。随后对每个 `[ast, offset]` 把同一个 `MagicStringAST` 的偏移基准切到 `offset` 再改写。这是第 1 章偏移机制的直接复用。源码位置: packages/jsx-directive/src/core/index.ts:37-62

- **单次遍历 + 分桶收集 + 顺序回放（全章机制主干）**：遍历前声明 7 个容器（v-if 用「按父节点分组的 Map」，v-for/v-memo/v-html/v-on/带修饰符事件用数组，v-slot 用嵌套 Map）；遍历时按属性名把节点丢进对应桶；遍历后按固定顺序回放。v-model 是唯一例外——遍历时就地改写，不入桶。源码位置: packages/jsx-directive/src/core/index.ts:71-77, 213-219, 126-131

- **属性名形态识别**：同一条 `v-slot` 既可能是 `JSXIdentifier`（`v-slot`）也可能是 `JSXNamespacedName`（`v-slot:xxx`）；`v-model` 也走命名空间形态（`v-model$xxx`）。遍历里对两种属性名类型分别判断，决定取 `name` 还是 `namespace`。源码位置: packages/jsx-directive/src/core/index.ts:109-131

- **v-if = 翻译成嵌套三元表达式**：`v-if`/`v-else-if` 在节点**开头**插入 `(cond) ? `；在节点**结尾**查「下一个兄弟的属性名是否以 else 开头」——是则续接 ` :`（交给下一分支），否则收尾 ` : null`（并按是否需要 Fragment 闭合外层）。「是否处于 JSX 子节点位置（hasScope）」决定要不要用 `<>{...}</>` 包裹：在 JSX 元素/片段内可直接用 `{ }` 表达式；在函数体返回、数组元素等位置必须用 Fragment 包住。源码位置: packages/jsx-directive/src/core/v-if.ts:11-40

- **v-else 的极简闭合**：v-else 分支不需要在节点前加三元（它靠前驱兄弟的 ` :` 续接），只在节点结尾按 hasScope 补一个 `}` 闭合最外层 `{`。源码位置: packages/jsx-directive/src/core/v-if.ts:41-43

- **v-for 借用 JS `in` 操作符承载语法**：`(item, index) in list` 在 JSX 属性值里被 babel 解析为合法的 `BinaryExpression`（operator=`in`，right=列表），其左操作数若是 `SequenceExpression`（逗号序列）就拆出 item/index/objectIndex 三个回调参数。零自造解析器。源码位置: packages/jsx-directive/src/core/v-for.ts:17-32

- **v-for 包装成列表渲染回调**：解析出参数与列表后，引入 `renderList` helper，把节点改写成 `renderList(list, (item, index) => <节点>)` 形态；同样用 hasScope 决定 `{ }` 还是 `<></>` 包裹。源码位置: packages/jsx-directive/src/core/v-for.ts:39-76

- **v-for 与 v-if/v-memo 的指令叠加**：收集 v-for 时同时记下该节点是否挂了 v-if/v-memo 属性，回放时据此决定要不要少闭一个 `}`（让外层 v-if 的三元能包住 v-for 的列表渲染）。源码位置: packages/jsx-directive/src/core/index.ts:144-152, packages/jsx-directive/src/core/v-for.ts:67-76

- **v-for 的 template 标签 → 内部 Fragment 标识**：当被 v-for 包裹的是 `<template>`，源码用 babel-plugin-jsx 的内部标识 `_Fragment9` 替换标签名。源码注释明确解释：vue-jsx 把自定义 Fragment 标签当组件、children 当插槽，所以必须换成内部标识绕开。源码位置: packages/jsx-directive/src/core/v-for.ts:80-97

- **v-for 用 unshift 倒序收集**（推断）：遍历是深度优先，嵌套 v-for 时内层先被访问；用 `unshift` 把外层排到队首，使回放时外层 v-for 先包裹、内层落在其回调里。标注为推断。源码位置: packages/jsx-directive/src/core/index.ts:144-145

- **v-model = 一个 prop + 一个 update 事件（+ 可选 modifiers），翻译成对象展开**：命名空间形式 `v-model$参数_修饰符` 中，参数里的 `_` 转成 `.`；改写成 `{...{ [参数]: 值, ["onUpdate:"+参数]: $event => 值 = $event, [参数+"Modifiers"]: {...} }}` 的对象展开，直接 spread 到 JSX 属性位置。这是 v-model 双向绑定语义在 JSX 里的等价表达。源码位置: packages/jsx-directive/src/core/v-model.ts:4-33

- **不发明新运行时（物证）**：helper 模块仅 re-export vue 自身的 `renderList/withKeys/withMemo/withModifiers`；引入 helper 时优先从 `vue` 取，仅在无 vue 环境时才从 `@vue-macros/jsx-directive/helpers` 取（后者只是同一批函数的导出垫片）。源码位置: packages/jsx-directive/src/helpers.ts:1, packages/jsx-directive/src/core/v-for.ts:39-45

## 关键调用链

`transformJsxDirective(code, id, options)`
 → `parseSFC(...)`（.vue/setup-sfc）或 `babelParse(...)`（.jsx/.tsx）取出 `[program, offset][]`
 → `new MagicStringAST(code)`
 → 对每个 program：`s.offset = offset` → `transform(s, program, options)`
    → `walkAST` 单次遍历，按属性名**分桶**（v-if→Map[parent]、v-for→倒序数组、v-model→就地改写、其余→数组）
    → 顺序回放：`transformVSlot` → `vIfMap.forEach(transformVIf)` → `transformVFor` → `transformVMemo`（仅 ≥3.2）→ `transformVHtml` → `transformVOn` → `transformOnWithModifiers`
 → `generateTransform(s, id)` 产出 code + sourcemap

源码位置: packages/jsx-directive/src/core/index.ts:32-63, 65-220

## 源码摘录（带行号，全文累计 ≤ 30 行）

**不发明新运行时** —— helper 全部来自 vue：源码位置 packages/jsx-directive/src/helpers.ts:1
```ts
export { renderList, withKeys, withMemo, withModifiers } from 'vue'
```

**单次遍历的 7 个分桶**（节选代表项，其余同构）：源码位置 packages/jsx-directive/src/core/index.ts:71-77
```ts
const vIfMap = new Map<Node | null | undefined, JsxDirective[]>()
const vForNodes: JsxDirective[] = []
const vMemoNodes: JsxDirective[] = []
// vHtmlNodes / vSlotMap / vOnNodes / onWithModifiers 同构（数组/嵌套 Map）
```

**v-if：开头插三元、结尾靠「下一个兄弟是否 else」决定续接/收尾**（hasScope 决定是否 Fragment 包裹）：源码位置 packages/jsx-directive/src/core/v-if.ts:22-40
```ts
// 节点开头
s.replaceRange(node.start!, node.start!,
  hasScope ? '' : '<>{',
  attribute.name.name === `${prefix}if` && hasScope ? '{' : '',
  '(', attribute.value.expression, ') ? ')
// 节点结尾：查下一个兄弟属性名是否以 else 开头
s.replaceRange(node.end!, node.end!,
  String(nodes[index + 1]?.attribute.name.name).startsWith(`${prefix}else`)
    ? ' :' : ` : null${hasScope ? '}' : '}</>'}`)
```

**v-for：借用 JS `in` 二元操作符 + 逗号序列承载语法**（零自造解析器）：源码位置 packages/jsx-directive/src/core/v-for.ts:18-32
```ts
if (attribute.value.expression.type === 'BinaryExpression') {
  if (attribute.value.expression.left.type === 'SequenceExpression') {
    const expressions = attribute.value.expression.left.expressions
    item = expressions[0] || ''; index = expressions[1] || ''; objectIndex = expressions[2] || ''
  } else { item = attribute.value.expression.left }
  list = attribute.value.expression.right
}
```

**v-model：翻译成「prop + onUpdate 事件 + modifiers」的对象展开**：源码位置 packages/jsx-directive/src/core/v-model.ts:24-32
```ts
s.replaceRange(attribute.start!, attribute.end!,
  `{...{[${argument}]: `, attribute.value.expression,
  `, ["onUpdate:" + ${argument}]: $event => `,
  s.sliceNode(attribute.value.expression), ` = $event${modifiers}}}`)
```

## 易混淆 / 边界 / 推断

- **事实**：v-model 是唯一在遍历阶段「就地立即改写」的指令（不入桶），因为它只依赖自身属性、不需要兄弟节点上下文；这与 v-if/v-for 必须入桶形成对照，体现了权衡 5 的「按是否需要兄弟上下文分流」。源码位置: packages/jsx-directive/src/core/index.ts:126-131
- **事实**：v-for 收集时用 `unshift`（倒序）；回放时 `forEach` 正序处理 → 最终仍是正序。源码位置: packages/jsx-directive/src/core/index.ts:145, packages/jsx-directive/src/core/v-for.ts:63
- **推断**：`unshift` 倒序收集的目的，是让深度优先遍历中「后访问的外层 v-for」排到队首、回放时先包裹，从而使嵌套 v-for 的包裹顺序正确。源码无显式注释，标注为推断。源码位置: packages/jsx-directive/src/core/index.ts:144-145
- **事实**：v-memo 仅当 `version` 未指定或 `>= 3.2` 时才回放（受 Vue 版本能力约束）。源码位置: packages/jsx-directive/src/core/index.ts:216
- **事实**：`_Fragment9` 是针对 babel-plugin-jsx 的兼容 hack——源码注释明示「Fragment 在 vue-jsx 里会被当组件、children 被当插槽」，故须用内部标识。属工程兼容细节，建议正文不展开。源码位置: packages/jsx-directive/src/core/v-for.ts:85-96
- **事实**：`onXxx_Yyy` 形式（事件名含下划线）被当作「带修饰符的事件」单独入桶处理（正则 `/^on[A-Z]\S*_\S+/`）。源码位置: packages/jsx-directive/src/core/index.ts:30, 121-125
- **覆盖说明**：`index.ts` 还调度了 `transformVSlot`/`transformVOn`/`transformVHtml`/`transformVMemo`，但这四个实现文件**不在本章 sourceFiles** 内，故本章未深入其内部机制；index.ts 中 v-slot 的嵌套 attributeMap 收集逻辑（约 164-209 行）较重，亦不在精读范围内。
- **未理解**：v-slot 的「默认插槽回填」（遍历 parent.children 把非模板子节点塞进 `attributeMap.get(null)`）的完整边界条件未在本章 sourceFiles 内验证，建议 Writer 涉及插槽章节时另查 v-slot.ts。
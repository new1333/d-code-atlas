# 模板与渲染函数的重定向 · 源码精读

## 给 Writer 的教学钩子（必填，8 子项缺一不可）

- **用户痛点 / 场景**：Vue 的渲染输出来源默认只有一种——`<template>`，或 setup 里 `return` 一个渲染函数。但现实里用户常常想要别的形态：用 JSX/h() 写渲染逻辑（比 template 更适合动态分支）、沿用 React 习惯把 `export default` 当渲染入口、给插槽声明精确类型却不想引入任何运行时代码、或者在同一个 SFC 里定义一段可命名复用的模板片段而不必抽成独立子组件。这些诉求在原生 Vue 里要么写法割裂、要么做不到，本章四个宏就是把这四种"非默认渲染来源"在编译期统一重定向成 Vue 认得的形态。

- **一句话核心思想**：**渲染输出来源不止 template 一种——用编译期重写把渲染来源从"唯一的声明式 template"扩展到"setup 内命令式表达式、纯类型插槽声明、可命名复用的模板片段"四种新形态，运行时仍然只跑 Vue 原生渲染。**

- **设计动机（为什么需要它）**：这四个宏共同回答一个问题——"渲染从哪来"。其中两种是"改写 setup 体的表达式语义"：把一行函数调用变成 setup 的返回值（渲染函数）、把模块导出当成渲染入口；一种是"反向擦除"——只服务于类型、运行时整段抹掉；最复杂的一种是"模板片段的命名复用"——把内联模板提升为可被反复引用的独立渲染单元。承前关系：四个宏全部复用前置章建立的「懒解析 + 增量编辑」地基（已在第 1 章『SFC 解析与增量 AST 编辑』讲透，本章只看它的新应用：在 setup 函数体里移动表达式、追加 return、擦除语句、在外层 SFC 末尾拼接代码）；命名模板的虚拟模板加载复用了前置章的「虚拟模块三件套」（已在第 3 章『编译期注入虚拟 helper 模块』讲透 helper 模块，本章只看它的变体：用同样的 load 机制装载 SFC 模板片段而非运行时 helper）。

- **关键权衡（核心原料，4 条）**：
  1. **把"渲染函数声明"从函数尾部的 return 降级为 setup 体里任意位置的一行调用** → 做了"找到那行调用，把它的实参搬到所在函数块的 return 后面"这个选择 → 换来了用户可在 setup 任意位置用一行声明渲染来源（不必非写在最后 return），且 JSX、h() 返回值、已存在的渲染函数引用都能直接喂进去（非函数实参会被自动包一层惰性函数）→ 代价是该宏必须在「Vue 把 `<script setup>` 编译成 setup() 函数体之后」才能介入（时序晚于大多数宏），且要小心处理"setup 里本就有 return 语句"的情况——必须先把旧 return 删掉，否则会出现两个 return。
  2. **命名模板必须分两阶段：源层占位 + 编译产物改写** → 做了"定义阶段在 SFC 源层操作模板 AST（把命名模板内容外置、给引用处插占位），引用处的真正改写推迟到 Vue 编译完之后的 JS 产物层"这个选择 → 换来了能完整复用 Vue 自己的"模板→render"编译管线（命名模板自动享有 v-if/v-for 等全部指令能力，不用自己造模板编译器），且引用占位走 Vue 正常的动态组件解析路径 → 代价是后一阶段必须识别 Vue 编译器吐出的内部产物函数（创建节点的调用、解析动态组件的调用、Fragment 等）——这些是不稳定的内部 API，编译策略或版本一变就可能失效；而且同一个占位在不同位置会被编译成两种形态（普通创建节点 vs 作为 block 根的 Fragment 包裹），必须分两条改写路径。
  3. **命名模板内容外置成虚拟模板模块** → 做了"把命名模板的 HTML 存进插件内存字典，再用虚拟模块加载机制把它像独立模板一样返回、交给 Vue 编译"这个选择 → 换来了命名模板享有与主模板完全相同的编译能力（一段 HTML 被当作正经模板编译成 render），且能被任意多处 import 复用 → 代价是必须在很早的源阶段就把模板文本暂存、跨到加载阶段才取出（跨阶段状态共享），还要把主模板也用外置 src 指向虚拟模板，避免命名模板与主模板共存于同一个 SFC 时互相干扰。
  4. **纯类型宏走"擦除"而非"注入"** → 做了"把整个插槽类型声明调用替换成一条注释"这个选择 → 换来了零运行时开销（不像双向绑定宏那样注入运行时 helper），类型信息只留在编译期供 IDE 使用 → 代价是它必须在 Vue 编译擦除 setup 之前就介入（否则 Vue 不认这个未知函数会报错），且它本身不产生任何运行时行为，纯粹是类型层工具——这恰好与前一章「编译期注入」形成镜像对照：一个是往源码加东西，一个是把源码抹掉。

- **最小心智模型（以命名模板为例，它最能串起全章，7 步）**：
  1. 用户在 SFC 里写多个 template：带 name 的是"命名模板"，不带的是"主模板"，主模板里用 `<template is="X">` 引用命名模板。
  2. 插件在源阶段解析 template 结构：命名模板的 HTML 存进内存字典并就地隐藏；引用 `<template is="X">` 改写成动态组件占位；主模板内容外置成虚拟 src。
  3. 当别处 import 命名模板虚拟模块时，加载器返回一段"render 委托"代码，指向真正的模板资源。
  4. Vue 自己的编译器跑完，把占位编译成创建节点 + 解析动态组件的调用。
  5. 插件在编译产物（JS）里遍历找到这些调用，改写成对命名模板 render 的调用，并补上对应 import。
  6. 主模板的 render 参数被改成可变参数转发，使命名模板能接住主模板透传的数据。
  7. 运行时：引用处实际调用命名模板的 render()，渲染出复用的模板片段。

- **最小原理演示（替代旧"复刻范围"）**：
  - 应演示：一个**小到只表达核心思想**的从零脚本，演两条原理——(a) "渲染来源重定向"：在一个 setup 函数体里找到 `defineRender(X)`，把它原地改写成 `return X`（含"先删旧 return"）；(b) "命名模板两阶段占位+产物改写"：源阶段把引用 `<template is="card">` 占位化为 `<component is="named-template-card">`，再在一段"假装是 Vue 编译产物"的字符串里把对应的创建节点调用替换成 `block_card.render()`。每一行都对应上面某条权衡。
  - 应故意省略：真正的 Vue 模板编译器调用、虚拟模块的真实 load 钩子接线、JSX/h() 的真实求值、Fragment 完整语义、vapor 分支、HMR、escapeTemplateName 的转义工程。
  - 演示载体建议：本仓库是 TS/JS，写成能 `bun run`/`node` 直接跑的独立脚本（用字符串替换 + 简易 AST 遍历模拟即可，不必真接 Vue 编译器）——载体服务于"演透原理"而非"能跑通完整 Vue"。命名模板的两阶段用"源字符串 → 占位字符串 → 模拟产物字符串 → 改写后字符串"四个快照表达，最能讲清"为什么要两阶段"。

- **正文不宜展开的细节**：vapor 选项（无虚拟 DOM 实验特性，渲染函数不包惰性层）；模板名转义（把 `-` 换成占位符以合成合法标识符）；rollup 下显式 `order: 'post'` 的兼容处理；虚拟请求解析函数完整复制自官方 Vue 插件；子节点偏移区间的计算；命名模板主模板用 Symbol 作 key 的类型技巧。

- **推荐的一个执行轨迹例子（命名模板）**：
  输入：SFC 含 `<template name="card">…</template>` 且主模板里有 `<template is="card"/>`
  → 源阶段：内存字典记下 card 的 HTML；主模板的 `<template is="card"/>` 变成 `<component is="named-template-card"/>`；主模板内容外置
  → Vue 编译主模板，占位变成 `创建节点(解析动态组件("named-template-card"))`
  → 产物阶段：识别出该调用，改写成 `块_card.render(...args)`，并在顶部 import 命名模板模块
  → 命名模板虚拟模块被加载 → render 委托代码 → card 的 HTML 被编译成真实 render
  → 输出：引用处实际渲染出 card 模板片段

> 以上钩子供 Writer 写「动机→核心思想→心智模型→关键权衡→原理演示」；下面事实部分供核对，不要被 Writer 当目录照抄。

## 概念要点

### define-render：把 setup 内一行调用改写成 return
- 识别条件：表达式语句 + 该调用名是 defineRender（值为 `'defineRender'`）+ 父节点是块语句（确保它在 setup 函数体里）。源码位置: packages/define-render/src/core/index.ts:31-46；常量定义源码位置: packages/common/src/constants.ts:12
- 核心改写：若所在块已有 return 语句则先删除；在 return 位置（或块末尾）插入 `return`，把实参 move 到 return 之后；删掉 `defineRender(` 和 `)`。源码位置: packages/define-render/src/core/index.ts:51-68
- 惰性包裹：当非 vapor、且实参既不是函数类型也不是标识符时，包成 `return () => (实参)`，让 JSX/h() 这种"求值即 vnode"的表达式也能当渲染函数（渲染函数需要的是函数而非值）。源码位置: packages/define-render/src/core/index.ts:59-63
- vapor 分支：vapor 模式下不包惰性函数，直接 `return 实参`（推断：Vapor 渲染函数语义不同，源码无注释）。源码位置: packages/define-render/src/core/index.ts:23,59-60
- enforce 语义：define-render 插件用 `enforce: 'post'`，因为它要操作"已被 Vue 编译成 setup() 函数体"的代码。源码位置: packages/define-render/src/index.ts:39

### export-render：把 export default 当渲染入口（define-render 的前置适配器）
- 找到 setup 里的 `export default <声明>`（且是值导出），把声明的文本切片取出、删除原语句。源码位置: packages/export-render/src/core/index.ts:20-28
- 把取出的声明包成 `defineRender(...)`，追加到 scriptSetup 末尾——即把 export default 改写成一次 defineRender 调用，后续交给 define-render 插件兜底。源码位置: packages/export-render/src/core/index.ts:30-34
- enforce:'pre'：操作源码层，早于 Vue 编译。源码位置: packages/export-render/src/index.ts:45
- 依赖 parseSFC + getSetupAst + sliceNode/removeNode 的 setupOffset 偏移处理（复用前置章地基）。源码位置: packages/export-render/src/core/index.ts:12-17,25-26

### define-slots：纯类型宏的运行时擦除
- 找到 setup 里的 `defineSlots(...)` 调用（值为 `'defineSlots'`），整条语句覆写成注释 `/*defineSlots*/`，运行时零残留。源码位置: packages/define-slots/src/core/index.ts:21-29；常量定义源码位置: packages/common/src/constants.ts:13
- enforce:'pre'：必须在 Vue 编译擦除 setup 之前介入。源码位置: packages/define-slots/src/index.ts:45
- 与第 3 章「注入虚拟 helper」形成镜像：一个是编译期加代码，一个是编译期抹代码。

### named-template：命名模板的两阶段 + 虚拟模块 + 编译产物改写
- 源阶段（preTransform）：用 @vue/compiler-dom 的 parse 把 SFC 当模板解析成 RootNode；顶层 template 元素 ≤1 个时直接跳过（无命名模板需求）。源码位置: packages/named-template/src/core/index.ts:57-68
- 命名模板（带 name）：把子内容文本存进 `templateContent[id][name]`，并用 `<named-template name="X">…</named-template>` 包裹原节点（隐藏+标记）。源码位置: packages/named-template/src/core/index.ts:83-95
- 引用占位（transformTemplateIs）：主模板里的 `<template is="X">` 被改写成 `<component is="named-template-X" />`。源码位置: packages/named-template/src/core/index.ts:34-55
- 主模板外置：主模板内容存进 `templateContent[id][MAIN_TEMPLATE]`、清空本体，并给 `<template>` 加 `src="…?vue&type=template&namedTemplate&mainTemplate"` 指向虚拟模板，避免与命名模板共存干扰。源码位置: packages/named-template/src/core/index.ts:120-129；常量源码位置: packages/named-template/src/core/constants.ts:1-5
- 虚拟模块加载（PrePlugin.load/loadInclude）：拦截带 `type=template&namedTemplate` 的 id，从 templateContent 取出之前存的 HTML 返回——这是第 3 章虚拟模块机制的变体（装载模板片段而非 helper）。源码位置: packages/named-template/src/index.ts:47-58
- 命名模板虚拟模块代码（PrePlugin.transform）：当 import 命名模板虚拟 id 时，返回一段"render 委托"——`import { render } from "<真正模板资源 id>"; export default { render: (...args) => { const r = render(...args); return typeof r === 'string' ? createTextVNode(r) : r } }`，即把命名模板包装成"有 render 方法的对象"，字符串结果包成文本 vnode。源码位置: packages/named-template/src/index.ts:64-76
- 产物阶段（postTransform）：在 Vue 编译后的 JS 上 babelParse，分两条路径——(a) 普通 SFC 产物（非 mainTemplate id）走 postTransformMainEntry：扫描 import 里带命名模板 query 的语句，登记 `customBlocks[id][name] = 模块 source`，供后续改写查名字→模块映射；源码位置: packages/named-template/src/core/index.ts:223-238 (b) mainTemplate id 走主改写逻辑。源码位置: packages/named-template/src/core/index.ts:140-143
- render 参数转发改写：把 `export function render(a,b,c)` 改成 `export function render(...args) { let [a,b,c] = args; … }`，使命名模板 render 能接住动态透传参数。源码位置: packages/named-template/src/core/index.ts:153-171
- 识别编译器产物：walkAST 找「创建节点调用（_createVNode 或 _createBlock）」+ 其首参是「解析动态组件调用（_resolveDynamicComponent）」+ 字符串实参以 `named-template-` 开头，登记为待改写的子模板。源码位置: packages/named-template/src/core/index.ts:173-192
- 两种改写路径：`_createVNode` 形态（普通位置）直接整节点覆写成 `块_X.render(...args)`；`_createBlock` 形态（动态组件作为 block 根）把首参覆写成 Fragment、并追加 children 数组 `[块_X.render(...args)]`。源码位置: packages/named-template/src/core/index.ts:196-210
- 补 import：对每个用到的命名模板在顶部 prepend `import 块_X from "<source>"`。源码位置: packages/named-template/src/core/index.ts:212-218
- 双插件实例：必须拆成 PrePlugin（enforce:'pre'，处理 SFC 源 + 虚拟模块加载）和 PostPlugin（enforce:'post' + rollup `order:'post'`，处理编译产物），因为源层与产物层是两种代码形态、单一 enforce 无法兼顾。源码位置: packages/named-template/src/index.ts:36-114

## 关键调用链

- export-render → define-render（跨宏协作）：
  `parseSFC → getSetupAst → 找 export default → sliceNode+removeNode → prependLeft defineRender(codegen)` 源码位置: packages/export-render/src/core/index.ts:12-34
  → 产物交给 define-render 插件 → `walkAST 找 defineRender() → 删旧 return → moveNode 实参到 return 后 → 删 defineRender( 和 )` 源码位置: packages/define-render/src/core/index.ts:31-68

- named-template（单宏内两阶段）：
  pre: `parse(SFC code) → 顶层 template 分桶(有 name=命名模板 / 无 name=主模板) → 命名模板存 templateContent+包裹标签；主模板 is→component 占位 + 内容外置 src` 源码位置: packages/named-template/src/core/index.ts:57-129
  → [Vue 编译主模板]
  post: `babelParse(产物) → 找 创建节点(解析动态组件("named-template-X")) → 改写为 块_X.render(...args) + prepend import` 源码位置: packages/named-template/src/core/index.ts:131-220
  load: `[虚拟模板 id] → 从 templateContent 取 HTML → Vue 编译成 render → 命名模板模块的 render 委托` 源码位置: packages/named-template/src/index.ts:47-76

## 源码摘录（带行号，全文累计 ≤ 30 行）

define-render 核心——把实参搬到 return 后、删旧 return、惰性包裹（演权衡 1「渲染来源重定向」）：
```ts
// packages/define-render/src/core/index.ts:51-68
const returnStmt = parent.body.find((n) => n.type === 'ReturnStatement')
if (returnStmt) s.removeNode(returnStmt)
const index = returnStmt ? returnStmt.start! : parent.end! - 1
const shouldAddFn = !vapor && !isFunctionType(arg) && arg.type !== 'Identifier'
s.appendLeft(index, `return ${shouldAddFn ? '() => (' : ''}`)
s.moveNode(arg, index)
if (shouldAddFn) s.appendRight(index, `)`)
s.remove(node.start!, arg.start!)   // removes `defineRender(`
s.remove(arg.end!, node.end!)       // removes `)`
```

export-render 核心——export default 切片删除、拼 defineRender 追加末尾（演"语法别名重定向"）：
```ts
// packages/export-render/src/core/index.ts:20-34
codegen = s.sliceNode(stmt.declaration, { offset })
s.removeNode(stmt, { offset })
// ...
codegen = `defineRender(${codegen})`
s.prependLeft(scriptSetup.loc.end.offset, `${codegen}\n`)
```

named-template 产物阶段——识别编译器内部产物（演权衡 2「必须识别不稳定内部 API」）：
```ts
// packages/named-template/src/core/index.ts:175-180
isCallOf(node, ['_createVNode', '_createBlock']) &&
isCallOf(node.arguments[0], '_resolveDynamicComponent') &&
node.arguments[0].arguments[0].type === 'StringLiteral' &&
node.arguments[0].arguments[0].value.startsWith('named-template-')
```

named-template——_createVNode 与 _createBlock 两种改写路径（演权衡 2 的代价「分两条路径」）：
```ts
// packages/named-template/src/core/index.ts:203-209
if (fnName === '_createVNode') {
  s.overwriteNode(vnode, render)
} else if (fnName === '_createBlock') {
  s.overwriteNode(component, importHelperFn(s, 0, 'Fragment'))
  const text = `${vnode.arguments[1] ? '' : ', null'}, [${render}]`
  s.appendLeft((vnode.arguments[1] || vnode.arguments[0]).end!, text)
}
```

define-slots——整调用擦成注释（演权衡 4「反向擦除」）：
```ts
// packages/define-slots/src/core/index.ts:26-29
s.overwriteNode(stmt, '/*defineSlots*/', {
  offset: scriptSetup.loc.start.offset,
})
```

## 易混淆 / 边界 / 推断

- **事实**：export-render 只产出 `defineRender(...)` 字面代码，真正的 return 注入由 define-render 插件（enforce:'post'）完成。**推断**：二者必须在主聚合管道里成对存在、且 export-render（pre）先于 define-render（post）执行，否则 `export default` 不会被处理——具体顺序需在「主聚合插件与转换管道顺序编排」章确认。
- **事实**：四个宏的 enforce 不一致——export-render/define-slots 是 'pre'，define-render 是 'post'，named-template 同时有 pre 和 post 两个插件实例。**推断**：enforce 差异源于它们操作的代码形态不同——pre 宏操作 SFC 源码（export default / defineSlots 调用 / template 结构），post 宏操作「Vue 编译后」的产物（setup() 函数体 / render JS）。
- **事实**：postTransform 识别的 `_createVNode`/`_createBlock`/`_resolveDynamicComponent` 是 @vue/compiler-dom 的内部产物函数名。**推断（源码无注释）**：这些是编译器内部 API，Vue 版本或编译策略变化可能导致名字改变，是 named-template 的主要脆弱点；这也是为什么该改写只能放在 post 阶段——必须等编译器真正产出这些调用后才能识别。
- **事实**：命名模板主模板也外置（src 指向 mainTemplate 虚拟 id）。**推断**：当 SFC 同时含命名模板与主模板时，若不外置主模板，主模板内容与命名模板共存于同一 SFC 会让 Vue 编译困惑；外置让主模板走和命名模板对称的独立编译路径。
- **事实**：named-template 必须拆 PrePlugin + PostPlugin 两个 createUnplugin 实例，PostPlugin 还对 rollup 显式设 `transform.order: 'post'`。源码位置: packages/named-template/src/index.ts:104-112。**推断**：这是为了在 rollup 下强制 post 顺序（不同 bundler 对 enforce 的尊重程度不同）。
- **未理解**：define-render 的 vapor 分支具体语义——Vapor 是 Vue 无虚拟 DOM 的实验特性，为何 vapor 时渲染函数不包惰性 `() =>` 层（源码仅一行条件、无注释）。标注为未完全理解，建议正文不展开。
- **事实**：named-template 的 templateContent 与 customBlocks 是两个跨阶段共享的内存字典（分别在 PrePlugin、PostPlugin 闭包内），靠虚拟 id 的 filename 关联。这是跨阶段状态传递的关键，也是潜在复杂度来源。源码位置: packages/named-template/src/index.ts:41,89
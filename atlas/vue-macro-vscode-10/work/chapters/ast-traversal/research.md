# 靠 AST 而非正则识别宏调用节点 · 主题精读

## 给 Writer 的教学钩子（必填，8 子项缺一不可）

- **用户痛点 / 场景**：当你想给 `defineProps(...)` 这类「写在代码里、长得像函数调用」的宏做编译期变换时，最朴素的冲动是写个正则去文本里捞 `defineProps(`。但这会在注释 `// defineProps 是宏`、字符串 `"defineProps()"`、甚至被遮蔽的局部变量里全部误命中；反过来，多行、嵌套括号、TS 泛型又能让正则漏掉真正的调用。使用者撞上的不是「偶尔不准」，而是「明明能跑却时灵时不灵、改一行排版就崩」的工具。

- **一句话核心思想**：先让解析器把源码变成一棵带类型的节点树，再用「节点类型 + 被调用者名」这两个**结构化条件**去精确命中宏调用，而不是去文本里描字。

- **设计动机（为什么需要它）**：源码是上下文相关语法，正则只能表达正则语言，从能力上就不够；只有结构化的 AST 才能让工具「知道」某段字符是注释、是字符串字面量、还是真正的调用表达式。这个机制换来的能力是**匹配的健壮性**——用户的代码怎么排版、怎么起名、注释里写什么，都不会让宏识别误判。其中若有「承前」部分：**（已在第 3 章『SFC 编译管线与宏的注入时机』讲透『宏变换必须挂在 compileScript 的 AST 遍历阶段而非字符串阶段』这一时序决策，本章只看它的新侧面——既然已经决定在 AST 上做，那么「如何把一个宏调用节点精确地挑出来」「这种结构化识别相比正则到底健壮在哪、代价是什么」就是本章要拆的事）**，供 Writer 做跨章去重。

- **关键权衡（本 Atlas 的核心，4 条）**：
  1. **选择「全量 Babel 解析（带 typescript + jsx 插件）」→ 换来 100% 的语法正确性（注释/字符串/嵌套/泛型全部正确归类）→ 代价是要为每个文件付出一次完整解析开销，且源码有语法错误时解析失败会直接阻塞宏变换**（正则方案至少能「带病运行」，AST 方案不行）。
  2. **选择「抽象掉源码格式（空格/换行/注释位置）」→ 换来匹配对用户写法完全不敏感、极度健壮 → 代价是 AST 节点里看不到原始文本排版，要做就地改写只能依赖节点携带的字节区间（offset），报错定位也必须靠这个区间回溯到用户源码**（这正是下一章 magic-string 的入口）。
  3. **选择「按节点类型 + 被调用者名做结构匹配」→ 换来实现极简、判定 O(1)、不需要理解作用域 → 代价是它默认「叫这个名字的就是宏」，会被用户的局部变量遮蔽欺骗（比如有人在函数内 `const defineProps = ...`），需要额外的作用域校验来兜底**。
  4. **选择「脚本块用 Babel 的 ESTree 风格 AST，而非 Vue 模板的那套 AST」→ 换来对 TS 类型标注 / JSX / 装饰器等 JS/TS 全语种的成熟支持 → 代价是 `<script>` 与 `<template>` 是两棵异构 AST，跨边界的语义必须在管线里手工桥接**。

- **最小心智模型（6 步）**：
  1. 用成熟的 JS/TS 解析器把 `<script setup>` 文本解析成一棵节点树（每个节点都自带它在原文里的字节区间）。
  2. 遍历这棵树，对每个节点问第一个问题：「你是调用表达式节点吗？」
  3. 若是，再问第二个问题：「被调用者是一个裸标识符吗？」
  4. 若是，问第三个问题：「这个标识符的名字，在已注册的宏名单里吗？」
  5. 三个问题全「是」→ 命中宏调用，取出它的参数节点和字节区间，交给变换器。
  6. 至于注释、字符串、成员访问式调用（`obj.defineProps()`）——它们要么根本不是调用表达式节点，要么被调用者是另一类节点，在步骤 2/3 就被天然排除，无需任何特殊处理。

- **最小原理演示（替代旧"复刻范围"）**：
  - **应演示**：一个几十行的「迷你宏识别器」。输入是一段故意在**注释里**和**字符串里**都写了 `defineProps` 字样的代码；先用 `@babel/parser` 解析，再写一个只认「调用表达式 + 裸标识符 + 名字命中名单」的访问者，最后打印命中节点。同时跑一个朴素正则 `/defineProps\s*\(/g` 做对照——正则命中 3 处（注释、字符串、真实调用各一），AST 只命中 1 处（真实调用）。每一行都要对应上面某个原理点：解析→步骤1、访问者→步骤2、结构条件→步骤3-4、天然排除→步骤5-6、字节区间→权衡2 的 offset。
  - **应故意省略**：真正的就地改写（留给下一章 magic-string）；宏的完整变换语义（如 props 类型推导，属后续章节）；作用域遮蔽校验的完整实现（点到为止即可）；多文件过滤、unplugin 集成、错误恢复等工程脚手架。**不追求工程完整，只追求"演透原理"**。
  - **演示载体建议（Writer 据此执行）**：topic 模式**首选 TS/JS**——本 Atlas 产物是 JS 生态 VitePress 站点，且 `@babel/parser` 本身就是 JS 库，TS/JS 对读者最友好、可直接在浏览器/Node 跑。无原仓库语言约束。

- **正文不宜展开的细节**：Babel 解析器的内部 token 化与文法推导细节；TS 泛型与 JSX 尖括号冲突时解析器如何消歧；成员表达式/可选调用/标签模板调用等边角节点形态的穷举；模板 AST（JS_CALL_EXPRESSION）与脚本 AST 的节点类型对照表；Vue 2.7 与 Vue 3 在解析路径上的差异。这些供 Writer 裁剪，不在主线展开。

- **推荐的一个执行轨迹例子**：
  输入文本（含干扰）：
  ```
  // defineProps 是个宏
  const tip = "defineProps() in string";
  defineProps({ count: Number })
  ```
  - 关键中间态：解析后，前两行的 `defineProps` 分别成为「注释附件」和「字符串字面量的内容」，**不是**调用表达式节点；只有第三行成为「调用表达式节点，被调用者是名为 `defineProps` 的裸标识符，带 1 个对象字面量参数、字节区间 = 第三行」。
  - 输出：访问者只对第三行触发，拿到参数与字节区间；正则则对三行全部触发（演示 false positive）。

> 以上钩子供 Writer 写「动机→核心思想→心智模型→关键权衡→原理演示」；下面事实部分供核对，不要被 Writer 当目录照抄。

## 概念要点

- **脚本块用 JS/TS 解析器（Babel）解析，而非 Vue 的模板解析器**：`<script setup>` 里是 JS/TS 代码，`@vue/compiler-sfc` 的 `compileScript` 内部用 `@babel/parser`（开启 `typescript` 与 `jsx` 插件）把它解析成 ESTree 风格 AST。Vue 的 `@vue/compiler-core` 那套节点类型（ROOT/ELEMENT/JS_CALL_EXPRESSION 等）是给 HTML 模板用的，不是给脚本用的。
  依据: vuejs/core 仓库 `packages/compiler-sfc/src/compileScript.ts` 源码；Babel 官方文档 babel-parser（支持 JSX/Flow/TypeScript 插件）。

- **一个宏调用在 AST 里就是一个调用表达式节点**：`defineProps({ count: Number })` 的 AST 形如 `{ type: "CallExpression", callee: { type: "Identifier", name: "defineProps" }, arguments: [ { type: "ObjectExpression", ... } ], start, end }`。识别它看的是 `type` 字段，而不是看原文里有没有 `defineProps(` 这串字符。
  依据: Babel 官方文档 babel-types 对 `CallExpression` 节点形状的定义（`callee`、`arguments`）；vuejs/core `compileScript.ts` 中对 defineProps/defineEmits 正是作为 CallExpression 检测并就地变换。

- **匹配的三要素是结构化的**：① 节点类型是调用表达式；② 被调用者是裸标识符（而非成员表达式等）；③ 该标识符名字属于已注册的宏名单。三者用「且」连接，缺一不可。这是典型的访问者（visitor）模式：对某类节点注册一个回调，在回调里判定。
  依据: Babel 官方插件教程（visitor 模式 + `isIdentifier` 判定）；Stack Overflow「traverse 时如何判断 Identifier 是被调用者」。

- **AST 天然区分代码 / 注释 / 字符串**：在 ESTree 里，注释不是独立节点，而是挂在相关节点的 `leadingComments` / `trailingComments` 属性上；字符串字面量是 `StringLiteral` 节点，其内容只是一个值。因此「注释里或字符串里出现的 `defineProps`」根本不会成为调用表达式节点，无需任何额外规则就被排除。这正是正则做不到的：正则对语言文法无感知，无法区分「分隔符在字符串内」还是「真正的注释」。
  依据: Nirjas 项目 issue（正则解析注释提取器的 false positive：正则无法区分字符串内的注释分隔符）；Thoughtbot 文章（正则极易引入意外 false positive）；Hacker News 讨论（正则无法匹配嵌套结构，AST 才是稳健替代）。

- **成员访问式调用天然不被误命中**：`obj.defineProps()` 的被调用者是 `MemberExpression` 而非 `Identifier`，在「② 被调用者是裸标识符」这一步就被排除。这是结构匹配相对于文本匹配的额外免费红利。
  依据: Babel 官方文档 babel-types（`MemberExpression` 与 `Identifier` 是不同节点类型）；Babel 插件教程。

- **纯名字匹配不查作用域 → 可能被局部变量遮蔽欺骗**：只判「名字叫 defineProps」并不验证这个名字是否指向「真正的宏」而非某个局部变量。若用户在函数内部 `const defineProps = () => {}` 后再调用，纯结构匹配会误判。工程上需要一类作用域校验辅助（如 vue-macros 的 `checkInvalidScopeReference`）或「官方宏不可被遮蔽」的约定来兜底；更严谨的做法是用解析器的作用域绑定（scope binding）确认标识符解析到预期的绑定、未被遮蔽。
  依据: vue-macros 官方仓库 `packages/common/src/ast.ts` 中 `checkInvalidScopeReference` 实现（对命中标识符用 `walkIdentifiers` 校验是否引用了局部变量）；Babel scope binding 相关讨论（`path.scope.getBinding(name)` 用于判定遮蔽）。

- **vue-macros 复用官方的标识符遍历器**：`@vue-macros/common` 直接从 `@vue/compiler-sfc` 导入 `walkIdentifiers`，而不是另起炉灶写一遍遍历——因为脚本块的标识符遍历逻辑官方已经实现且经过充分测试，复用既保证与官方编译器语义一致，又减少维护面。
  依据: vue-macros 官方仓库 `packages/common/src/ast.ts` 顶部 `import { walkIdentifiers } from '@vue/compiler-sfc'`。

## 关键流程

源码文本（脚本块）
→ `@babel/parser`（开启 typescript + jsx 插件）解析
→ Babel AST（File → Program → 各语句节点）
→ 访问者遍历每个节点
→ 判定：`节点类型 === 调用表达式 && 被调用者类型 === 裸标识符 && 宏名单.has(标识符名)`
→ 命中宏调用节点（携带参数节点 + start/end 字节区间）
→（可选）作用域校验，排除被局部变量遮蔽的情况
→ 把节点交给变换器（连同字节区间，供下一章 magic-string 做就地改写）

依据: Babel 官方访问者模式文档；vuejs/core `compileScript.ts` 的 defineProps 检测与变换路径；vue-macros 官方仓库 `ast.ts` 的 `checkInvalidScopeReference` 流程。

## 易混淆 / 边界 / 推断

- **事实**：注释里的 `defineProps` 在 Babel AST 里以 `leadingComments` 形式附着在相邻节点上，不会被解析成调用表达式节点，因此不会被误命中。
  依据: ESTree 规范对注释附件的处理；Babel 解析器行为。

- **事实**：模板里的 `{{ defineProps() }}`（如果出现）走的是 `@vue/compiler-core` 的**模板 AST**（节点类型为 `JS_CALL_EXPRESSION` 等），与脚本块的 Babel AST **不是同一棵树**。本章讨论的「按节点类型识别宏」只针对脚本块；模板侧的宏/指令识别是另一套机制。
  依据: `@vue/compiler-core` 类型定义（NodeTypes 枚举，`JS_CALL_EXPRESSION`）；社区对 Vue 编译器模板 AST 的解析（Reading vuejs/core-vapor）。

- **事实 / 注意点**：`@vue/compiler-core` 的 `NodeTypes` 是 TypeScript `const enum`，在产物里会被擦除成数字字面量，运行时无法从编译产物里按名字导入该枚举——这也是脚本侧改用 Babel AST（其 `type` 是字符串字面量、运行时可见）的一个现实理由。
  依据: Vitest issue #1650（NodeTypes 是 const enum、运行时被擦除）；`@vue/compiler-core` 类型声明。

- **边界**：标签模板调用 `` defineProps`...` ``、可选调用 `defineProps?.()`、带类型参数的调用 `defineProps<T>()` 等边角形态，其节点主体仍是调用表达式（或需特别处理 TS 类型参数），Writer 主线只需强调「调用表达式 + 裸标识符」主干，不必穷举边角。
  依据: Babel types 对调用相关节点族的定义；推断（边角形态的具体处理因工具而异）。

- **推断（标注为推断）**：vue-macros 在各特性包内可能各自实现「判定某个调用是否为目标宏」的轻量逻辑，而非全部走 common 层的统一函数——因为 `@vue-macros/common` 的 `ast.ts` 中未见名为 `detectMacro` 的统一导出，更常见的是各宏包在访问者里直接判 callee 名。这点待查证，Writer 不宜写成「有一个统一的 detectMacro 函数」。
  依据: vue-macros 官方仓库 `packages/common/src/ast.ts` 未导出 `detectMacro`；推断。

- **未理解 / 待查证**：vue-macros 对「同一节点可能被多个宏同时关心」时的遍历调度细节（一次遍历多 visitor，还是多次遍历）属于后续 composite 章「宏变换流水线」的范畴，本章不展开；此处仅确认「识别」这一步是按节点结构精确匹配的。
  依据: 推断；待与第 6 章『Vue Macros 的宏变换流水线』对齐。
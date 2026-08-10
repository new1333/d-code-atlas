# Vue Macros 的宏变换流水线 · 主题精读

## 给 Writer 的教学钩子（必填，8 子项缺一不可）

- **用户痛点 / 场景**：假设你想给 Vue 加两个新宏——一个 `defineEmit`（声明单个事件）和一个批量 `defineModels`。如果没有一条统一的变换流水线，每个宏都要自己从头写"解析 SFC → 找宏调用 → 改代码 → 生成 sourcemap → 挂到 Vite/webpack/esbuild"，写十几个宏就是十套重复脚手架；更要命的是它们还会互相踩脚——好几个宏都要改写 `defineProps` 调用，谁先改、谁后改、改完对方还能不能认出来？痛点是：**没有一条可插拔的变换流水线，宏的开发成本极高、且宏与宏之间的冲突无处解决。**

- **一句话核心思想**：把"一个编译期特性"抽象成"**一个独立的 transform 函数（AST visitor + 就地改写）+ 一个特性开关**"，再用一条**固定顺序的插件链**把它们串起来——**加一个宏 = 写一个函数 + 在链上插一个位置**。

- **设计动机（为什么需要它）**：这条流水线是为了解决"宏要被**规模化地、互相不冲突地、跨构建工具地**生产"这个矛盾而生的，它换来的是"新宏零脚手架、可独立开关、可单独发布、可跨工具分发"的能力。**承前标注**：本章是把两个前置 primitive 串成工程化流水线——『识别宏调用节点』（`isCallOf`）已在第 4 章『靠 AST 而非正则识别宏调用节点』讲透，本章只看它作为流水线"**命中**"一环的复用，不重讲其健壮性；『magic-string 的 offset 级就地变换 + sourcemap 还原』已在第 5 章『magic-string：sourcemap 友好的源码就地变换』讲透，本章只看 `overwrite`/`generateTransform` 作为流水线"**注入**"一环的复用，不重讲 sourcemap。本章的新侧面是：**注册（特性开关）、调度（顺序链）、冲突（顺序接力 vs 多阶段拆分）、性能（短路 + 缓存解析）、降级（收敛到官方原语）**。

- **关键权衡（机制丰富章，3 条）**：
  - **【拆分粒度】选择把每个特性做成独立的可装配单元（各自独立遍历 AST）→ 换来了特性可独立开关（开关为假即整条跳过）、可单独发布为独立包、可跨 Vite/webpack/esbuild 分发、新宏零脚手架 → 代价是同一份源码会被解析 + 遍历 N 次（N = 启用的宏数），必须靠"源码不含宏名就短路返回"和"解析结果缓存"来补救性能。**
  - **【用顺序解决冲突】选择用一条固定顺序的插件链、串行传递代码（前一插件的输出即后一插件的输入）来解决"多个宏想改写同一节点"的冲突 → 换来了简单且确定，顺序本身就能表达宏之间的依赖（先把各种 `defineProps` 写法统一成标准形态，再做类型展开）→ 代价是顺序被硬编码在聚合包的列表里、新增特性必须手工找准插入位置，且每个特性各自遍历、无法在一次遍历中共享上下文。**
  - **【前置降级到官方原语】选择让所有宏插件在 Vue 官方编译器**之前**运行，把自定义宏"自降级"为官方原语（如单个 `defineEmit` → 标准的 `defineEmits`，链式 `defineProps().withDefaults()` → `withDefaults(defineProps())`）→ 换来了与官方编译器彻底解耦、几乎与 Vue 版本无关 → 代价是宏的语义被锁死在"能否用 `defineProps`/`defineEmits`/`withDefaults` 等少数官方原语还原"这条边界上，能引入的全新语义有限。**

- **最小心智模型（7 步）**：
  1. **过滤**：文件请求进入，用特性开关生成的 include 规则过滤，非目标文件直接放行。
  2. **短路**：源码字符串里不含本宏名 → 立即返回"无需变换"，根本不解析 AST。
  3. **解析**：把 SFC 拆出 `<script setup>`，惰性地产出其 AST（结果缓存，供后续宏复用）。
  4. **命中**：遍历 AST，用"节点类型 + 调用名"精确匹配宏调用节点。
  5. **就地改写**：在一份"原始 offset 记录器"上登记 `overwrite`/`appendLeft`/`prependLeft`（不破坏原始 offset，保 sourcemap）。
  6. **收尾**：一次性产出 `{ 改写后代码, sourcemap }`，交还构建工具。
  7. **接力**：构建工具把这份改写后的代码喂给链上的下一个宏插件，重复 2~6，直到链尾，再交给 Vue 官方编译器。

- **最小原理演示（替代旧"复刻范围"）**：
  - **应演示**：用约 50 行 JS 实现一个"**两特性流水线**"——特性 A 把 `foo()` 改写成 `bar(foo())`，特性 B 把 `double(x)` 改写成 `x*2`；二者都是 `(code, id) => 变换结果 | undefined` 形态的独立函数，再写一个 `pipeline([A, B])` 按数组顺序串行调用、把前者的输出喂给后者。重点演透：**短路、独立遍历、顺序接力、统一收尾**，每一行都要对应上面某个原理点。可手写一个迷你 `MagicString`（在原始 offset 上记录 overwrite、最终 `toString` 输出）和一个迷你 `walkAST + isCallOf`，避免引入重依赖。
  - **应故意省略**：真实的 SFC 分块解析（演示直接吃整段代码即可）、跨构建工具的 unplugin 适配（第 8 章会讲）、IDE/Volar 类型侧（第 9 章以后）、特性开关的配置 schema、解析缓存的真实实现。
  - **演示载体建议**：topic 模式首选 TS/JS（本 Atlas 产物是 JS 生态 VitePress 站点）。本演示纯 JS 即可讲透——核心机制（offset 记录 + 顺序接力）与 Vue 无关，无需引入 Vue 特有语义。建议手写迷你 `MagicString`/`walkAST` mock 来演"原理"而非演"工程"。
  - 示意骨架（Writer 据此扩写，注意每段对应一个原理点）：
    ```js
    // —— 原理点⑤：offset 级就地变换的迷你实现 ——
    class MagicString {
      constructor(src) { this.src = src; this.ops = []; }     // 只记录，不改原文
      overwrite(start, end, str) { this.ops.push(['ow', start, end, str]); return this; }
      appendLeft(at, str) { this.ops.push(['al', at, str]); return this; }
      toString() { /* 按 offset 排序后把 ops 叠加到 src 上输出 */ }
    }
    // —— 原理点④：命中 ——
    function isCallOf(node, name) { return node?.type === 'Call' && node.callee === name; }
    function walkAST(ast, { enter }) { /* 深度优先，对每个节点调 enter */ }
    // —— 原理点①：每个特性是独立 transform 函数 ——
    function chainWrap(code) {
      if (!code.includes('foo(')) return;                      // 原理点②：短路
      const s = new MagicString(code), ast = parse(code);
      walkAST(ast, { enter(n) { if (isCallOf(n, 'foo')) s.overwrite(n.start, n.end, `bar(${code.slice(n.start, n.end)})`); } });
      return s.toString();                                      // 原理点⑥：统一收尾
    }
    function doubleInline(code) { /* 同形：命中 double(x) → x*2 */ }
    // —— 原理③：固定顺序的插件链，串行接力 ——
    const pipeline = (features) => (code) => features.reduce((c, f) => f(c) ?? c, code);
    const transform = pipeline([chainWrap, doubleInline]);      // 顺序即依赖
    ```

- **正文不宜展开的细节**：跨工具统一插件抽象（`createUnplugin`/`createCombinePlugin` 的内部，留第 8 章）；`@vue-macros/volar` 如何让 IDE 理解这些宏（第 9 章以后）；各宏按"设计原型"如何分类（第 7 章）；少数特性为何拆成"前置 + 后置"两个阶段插件（多阶段拆分细节）；解析缓存的缓存键实现；webpack/rspack 为何要用与 Vite 不同的 include 正则（构建工具差异，第 8 章）。

- **推荐的一个执行轨迹例子**：
  - **输入**：一段含 `defineEmit('open')` 与 `defineProps().withDefaults({ count: 0 })` 的 SFC。
  - **特性 `defineEmit` 命中**：遍历找到 `defineEmit('open')` 调用 → 就地改写成 `(...args) => __MACROS_emit('open', ...args)` → 并在块首插入一行 `const __MACROS_emit = defineEmits(['open'])`。
  - **特性 `chainCall` 接力（拿到上一步改写后的代码）**：遍历命中 `defineProps().withDefaults({...})` → 改写成 `withDefaults(defineProps(), { count: 0 })`。
  - **输出**：链尾交给 Vue 官方编译器——此时它看到的已全是它认识的 `defineEmits` / `withDefaults` / `defineProps`。
  - **关键中间态**：每个特性产出的都是"对原始 offset 的增量记录"，串行接力时每步都重新解析同一份代码（但解析缓存命中，开销可控）。

> 以上钩子供 Writer 写「动机 → 核心思想 → 心智模型 → 关键权衡 → 原理演示」；下面事实部分供核对，不要被 Writer 当目录照抄。

## 概念要点
- 要点 1（单宏的标准形态）：一个宏的核心是一个 `transform(code, id): CodeTransform | undefined` 函数——返回 `{ code, map }` 表示需变换、返回 `undefined` 表示不感兴趣。依据: vue-macros 仓库 `packages/define-emit/src/core/index.ts` 的 `transformDefineEmit`、`packages/chain-call/src/core/index.ts` 的 `transformChainCall`；`CodeTransform` 类型来自 `magic-string-ast`，经 `@vue-macros/common` 重导出（`packages/common/src/index.ts` 中 `export * from 'magic-string-ast'`）。
- 要点 2（宏 → 可装配单元的包装）：每个 transform 被包成一个 unplugin 实例，固定形态为 `{ name, enforce: 'pre', transformInclude: filter, transform: transformXxx }`——`enforce:'pre'` 确保它跑在 Vue 官方编译器之前。依据: `packages/define-emit/src/index.ts`（`createUnplugin(...)` 返回 `{ name, enforce: 'pre', transformInclude: filter, transform: transformDefineEmit }`）。
- 要点 3（特性开关驱动装配）：聚合包用 `resolvePlugin(unplugin, framework, options.特性名)` 把每个特性适配成当前框架的插件；当 `options.特性名 === false` 时 `resolvePlugin` 返回 `undefined`，最终被 `filter(Boolean)` 剔除——这就是"特性开关 = 流水线条目"的机制。依据: `packages/macros/src/index.ts` 与 `packages/macros/src/core/plugin.ts`（`resolvePlugin` 在 options 为假时 `return`，即返回 undefined）。
- 要点 4（顺序是硬编码的插件链）：聚合包用 `createCombinePlugin` 返回一条**固定顺序、带语义分组注释**的 plugins 数组（注释如 `// props` / `// emits` / `// both props & emits` / `// convert to runtime props & emits`），构建工具按数组顺序串行调用，前一个的输出是后一个的输入。依据: `packages/macros/src/index.ts` 的 `plugins: [...]` 数组及其分组注释。
- 要点 5（惰性 + 缓存的 AST 解析）：`parseSFC` 用 `@vue/compiler-sfc` 拆出 descriptor，并挂上 `getSetupAst()`/`getScriptAst()` 两个**惰性**方法（按需才解析），且底层 `babelParse` 带 `cache: true`——这是"N 个宏各自解析同一份 SFC"的性能补救。依据: `packages/common/src/vue.ts`（`parseSFC` 返回含 `getSetupAst`/`getScriptAst` 的对象，二者调用 `babelParse(..., { cache: true })`）。
- 要点 6（短路优化）：每个 transform 函数体第一行几乎都是 `if (!code.includes(宏名常量)) return`——在解析 AST 之前先做一次廉价字符串包含检查，不含本宏就立刻退出。依据: `packages/define-emit/src/core/index.ts` 与 `packages/chain-call/src/core/index.ts` 开头的 `if (!code.includes(...)) return`。
- 要点 7（跨构建工具的文件过滤）：用 `FilterFileType` 枚举（VUE_SFC / VUE_SFC_WITH_SETUP / SETUP_SFC / SRC_FILE）+ `getFilterPattern(types, framework)` 生成 include 规则，且对 webpack/rspack 等类 webpack 工具使用与 Vite/Rollup **不同**的正则。依据: `packages/common/src/unplugin.ts`（`FilterFileType` 枚举与 `getFilterPattern`，其中 `isWebpackLike` 分支选不同正则）。
- 要点 8（helper import 去重）：`importHelperFn` 用一个以 `MagicString` 实例为键的 `WeakMap<MagicString, Set<string>>` 记录"本实例已注入过哪些 helper"，保证同一次变换内同一个 helper（如 `ref`）只被 import 一次。依据: `packages/common/src/ast.ts`（`const importedMap = new WeakMap<MagicString, Set<string>>()` 及 `importHelperFn` 的查重逻辑）。
- 要点 9（宏降级为官方原语）：自定义宏最终都收敛到 Vue 官方宏——`defineEmit` 生成一个调用官方 `defineEmits([...])` 的局部变量；链式 `defineProps().withDefaults()` 被改写为官方 `withDefaults(defineProps(), ...)`。这是"前置降级"权衡的直接证据。依据: `packages/define-emit/src/core/index.ts`（`EMIT_VARIABLE_NAME = __MACROS_emit` + `const ${EMIT_VARIABLE_NAME} = defineEmits(...)`）与 `packages/chain-call/src/core/index.ts`（`isChainCall` 命中后 `s.overwriteNode(node, \`${WITH_DEFAULTS}(${definePropsString}, ${withDefaultString})\`)`）。
- 要点 10（宏导入的擦除）：用 `import ... with { type: 'macro' }` 语法显式声明宏导入，变换时由 `removeMacroImport` 整行删除——保证宏在运行时不存在。依据: `packages/common/src/vue.ts`（`removeMacroImport` 检查 `ImportDeclaration` 的 `attributes` 是否含 `type:'macro'`，命中则 `s.removeNode`）。

## 关键流程
单次构建工具 transform 钩子内，一个特性的执行流：

```
请求文件 id
  → transformInclude(filter) 用 FilterFileType 生成的规则过滤  [要点7]
  → [进入聚合包的固定顺序插件链]  [要点4]
     对链中每个特性（按顺序，前者的 code 作为后者的 original code）:
        transformXxx(code, id):
          ① if (!code.includes(宏名)) return undefined;     [要点6, 短路]
          ② parseSFC → getSetupAst() (惰性+缓存)            [要点5]
          ③ new MagicStringAST(code)                        [要点1]
          ④ walkAST(ast, enter(n) => if (isCallOf(n, 宏名)) ... )
          ⑤ s.overwriteNode / appendLeft / prependLeft      [就地改写, 保 offset]
          ⑥ return generateTransform(s, id)  → { code, map } [要点1, 收尾]
        下一特性接力（拿上一步的 code）                       [要点4, 顺序解决冲突]
  → 链尾 → 交给 Vue 官方编译器（此时只剩官方原语）            [要点9, 前置降级]
```
依据: 各 `core/index.ts` 的函数体（①~⑥ 顺序）、`packages/define-emit/src/index.ts`（`transform: transformDefineEmit` 直接挂为钩子）、`packages/macros/src/index.ts`（plugins 数组定义串行顺序与接力关系）。

## 易混淆 / 边界 / 推断
- **事实（对 Writer 的重要纠偏）**：大纲 summary 中的"**统一 walk 调度**"，在源码里的精确实现是"**固定顺序的 plugins 数组 + 串行 transform 传递**"——每个特性在**自己的** `walkAST` 里独立遍历，**不存在**"把多个 visitor 合并到一次遍历"的设施。依据: `packages/macros/src/index.ts`（plugins 数组）+ 各 `core/index.ts`（各自 `walkAST`）。**建议 Writer 把"调度"画成"串行插件链"，而非"一次 walk 多 visitor"，否则会失真。**
- **事实**：每个特性都 `new MagicStringAST(code)` 新建自己的变换实例；串行接力时，上一步 `toString()` 出来的字符串就是下一步的原始代码（offset 在每步重新计算）。依据: 各 `core/index.ts` 中 `const s = new MagicStringAST(code)`。
- **事实**：少数特性返回**两个**插件（一个前置、一个后置），分别插在链的不同位置——说明"一个特性 = 一个插件"只是简化模型，实际可拆成多阶段。依据: `packages/macros/src/index.ts` 中 `setupComponentPlugins?.[0]` 与 `?.[1]` 被分别插入到链的不同位置；`resolvePlugin` 对该特性的 unplugin 返回 `Plugin[]`。
- **推断（标注为推断）**：类型展开类宏（如 `betterDefine`，注释标为 "convert to runtime props & emits"）必须排在 `defineProps`/`chainCall`/`defineModels` 等"先统一写法"的宏**之后**，因为它依赖前面已把各种 props 写法归一为标准 `defineProps`。依据: `packages/macros/src/index.ts` 中该注释紧随 props/emits 分组之后；未深读 `better-define` 源码逐行佐证，故标推断。
- **边界**：`VueBooleanProp` / `VueShortBind` / `VueShortVmodel` 在源码注释中被标记为 "not an unplugin, by now"，且仅在 Vite/Rollup/Rolldown 下启用——说明并非所有特性都已统一为 unplugin 形态，跨工具覆盖是不均匀的。依据: `packages/macros/src/index.ts` 的条件分支与内联注释。
- **未理解 / 待查证**：`excludeDepOptimize()`、`Devtools(...)` 在链尾的具体职责未深读（非本章重点，留待后续章节）；`babelParse` 的 `cache: true` 其缓存键粒度（按代码内容？按文件 id？）未在所读文件中完全确认。
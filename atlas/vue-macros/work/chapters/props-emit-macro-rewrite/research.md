# props/emit 宏的编译期重写与类型转换 · 源码精读

## 给 Writer 的教学钩子（必填，8 子项缺一不可）

- **用户痛点 / 场景**：Vue 原生的 `defineProps` / `defineEmits` 是「一次性、集中声明」——所有 props 或所有 emits 挤在一个调用里；而且早期版本里 props 名字要与变量名一致、emit 要手写一长串类型签名，写起来啰嗦。用户想要的是：能**逐个**声明一个 prop/emit（像普通变量那样）、能用更短的事件类型写法、能沿用旧版的 `$` 前缀习惯。但这些「顺手写法」Vue 运行时并不认识。

- **一句话核心思想**：**在编译期把顺手写法重写成原生宏认得的形态，运行时零新增能力**——这些宏本质都是「源码改写器」，不引入任何运行时语义。

- **设计动机（为什么需要它）**：Vue 的宏只在编译期存在（运行时被编译器接管），所以「换个更顺手的写法」最自然的实现就是：在交给 Vue 编译器之前，先把源码文本改写成 Vue 已经认识的标准形态。这样宏的实现方**无需理解 Vue 运行时**，只需做文本/AST 改写；用户拿到的语义与原生宏**完全一致**，无学习负担。
  - 承前关系：这套改写全部跑在第 1 章『SFC 解析与增量 AST 编辑』建立的地基上——`parseSFC` 拿 scriptSetup、`getSetupAst()` 懒解析、`MagicStringAST` 做基于偏移的增量改写、`walkAST`+`isCallOf` 找调用点。本章**不重讲地基**，只看「重写器类宏如何复用它」：四个宏都重复同一句式——「算 setupOffset → walkAST 找调用点 → 抽信息 → `overwriteNode` 就地改 → 必要时 `prependLeft` 补一个集中的原生宏调用」。其中「类型降级到运行时」（`resolveTSReferencedType`+`inferRuntimeType`）会在第 6 章『better-define』讲透，本章 `defineProp` 只是借用，不展开。

- **关键权衡（4 条）**：
  1. **语法糖留编译期、运行时只认原生宏** → 换来用户语义与原生 `defineProps`/`defineEmits` 完全一致、无新运行时概念 → 代价是这些宏只是重写器、不引入任何新运行时能力（这是全章总纲）。
  2. **就地的 AST 增量改写，而非把整段代码 parse 后重新生成**（用 `overwriteNode`/`sliceNode`/`prependLeft` 只动必要片段） → 换来未触碰代码的 sourcemap 原样保留、多道宏转换可层层叠加 → 代价是每次改写都要手算 `setupOffset` 偏移、并自行保证拼接片段语法正确（承前：第 1 章的「懒解析+增量编辑」权衡的直接兑现）。
  3. **用「字符串拼接」合成运行时声明对象，而不是构造 babel AST 节点**（`sliceNode` 把源码片段当字符串抠出来，再拼成 `{ name: { ... } }`/`[name, ...]`） → 换来实现极简、几十行就能写完一个宏、产物可直接读 → 代价是产物正确性靠约定（无类型保证），且「全无选项的简写数组」与「带选项的对象」要分两条路径生成。
  4. **「逐个声明 + 代理到集中原生宏」模式**（多个 `defineProp` 合并成一个 `defineProps`，每个调用点改写成读 `__props` 的代理；多个 `defineEmit` 合并成一个 `defineEmits`，每个调用点改写成转发函数） → 换来用户能逐个声明并各自拿到独立 ref/emit 函数、又最终落到 Vue 认识的单个原生宏上 → 代价是要维护集中的 `__MACROS_props`/`__MACROS_emit` 调用点，并额外处理「与已存在的 `defineProps` 合并参数」「与 `defineProps<T>()` 泛型形式互斥报错」等边界。

- **最小心智模型（3～7 步）**：
  1. `parseSFC` 拿到 `scriptSetup` 与它的起始偏移 `setupOffset`；`getSetupAst()` 按需解析出 setup 的 babel AST（承前）。
  2. `walkAST` 遍历，用 `isCallOf(node, 宏名)` 识别目标调用点。
  3. 对每个调用点：抽取关键信息（prop/emit 名字、选项参数、类型参数），收集进数组；名字可来自显式字符串参数，也可从父级 `VariableDeclarator` 的变量名**反推**。
  4. 用 `MagicStringAST` **就地改写**调用点本身——三种手法：重命名 callee（`$defineProps`→`defineProps`）、展开类型签名（ShortEmits→标准 call signatures）、整体替换成代理表达式（`defineProp('x')`→`toRef(__props,"x")`）。
  5. 若是「逐个声明」类宏：把收集到的信息合成一段运行时声明字符串，`prependLeft` 在 setup 开头补一个集中的原生宏调用。
  6. 若与已有原生宏相遇：合并参数（`defineProp` 遇 `defineProps()`）或抛互斥错（遇 `defineProps<T>()`）。
  7. `generateTransform` 输出改写后的代码 + sourcemap，交给管道里的下一个宏。

- **最小原理演示（替代旧"复刻范围"）**：
  - 应演示：一个**小到只表达「收集 + 就地改写 + 合成集中声明」三件套**的从零实现（约 40 行）。演 `defineProp` 这一类最有代表性——遍历找 `def('foo', opts)` 调用、收集 `{name, opts}`、把调用点改写成 `proxy(__props,"foo")`、最后在顶部 `prepend` 一个集中的 `defineProps({...})`。每一行对应上面「权衡 4 / 步骤 3-5」。
  - 应故意省略：真实 SFC 解析（直接喂一段 setup 字符串）、babel 的偏移修正（用简化坐标）、类型降级（直接把 opts 当字符串拼）、kevin/johnson 两种 edition 的差异、`$()` 响应式变换分支、与已有 `defineProps` 合并的 `normalizePropsOrEmits` helper、错误边界。**不追求工程完整，只演透「重写器」这一核心思想**。
  - 演示载体建议：本仓库是 TS，建议写成一段能 `node`/`bun` 直接跑的脚本（用 `@babel/parser` 解析 + 一个极简的「按区间改字符串」的小工具模拟 magic-string）。能跑最好，非硬要求——核心是让读者看到「输入源码 → 收集中间态 → 改写后源码」这条轨迹。

- **正文不宜展开的细节**：kevinEdition vs johnsonEdition 的参数位差异（`defineProp(name, definition)` vs `defineProp(value, required, rest)`，仅作一句话带过即可）；`$(defineProp(...))` / `$defineProp(...)` 两种响应式变换写法的判定细节（属第 7 章『响应式语法糖』交叉点）；`normalizePropsOrEmits` 把数组归一化为对象的实现；`resolveObjectKey` 对非字面量 key 的处理；各宏的 bundler 入口（`vite.ts`/`rollup.ts` 等高度重复的脚手架）。

- **推荐的一个执行轨迹例子**（演核心思想，演 `defineProp` 这一类）：
  - 输入：`const count = defProp('count', { default: 0 })`（演示中用 `defProp` 模拟宏名）
  - 关键中间态：walkAST 收集到 `[{ name:'count', opts:'{ default: 0 }' }]`；调用点被就地改写
  - 输出：顶部补 `const __props = defineProps({ count: { default: 0 } });` + 调用点变成 `const count = toRef(__props, "count")`——**最终只剩 Vue 认识的原生宏，自定义宏已消失**。

> 以上钩子供 Writer 写「动机→核心思想→心智模型→关键权衡→原理演示」；下面事实部分供核对，不要被 Writer 当目录照抄。

## 概念要点

- 四个宏都是**纯编译期重写器**：输入 `code, id`，输出 `CodeTransform`（改写后代码 + sourcemap）或 `undefined`（不命中则早返回）。每个都以「字符串包含性检查」做第一道早返回（如 `if (!code.includes(DEFINE_PROP)) return`），避免无谓解析。
  源码位置: packages/define-props/src/core/index.ts:17、packages/define-emit/src/core/index.ts:25、packages/define-prop/src/core/index.ts:33

- **define-props（最简重写器）**：把 `$defineProps` 的 callee 整体替换为 ` defineProps`（注意前面**故意加一个空格**，注释写明 `add space for fixing mapping`——为了修正 sourcemap 映射）。这是「重命名式」重写的极致样本。
  源码位置: packages/define-props/src/core/index.ts:26-37

- **short-emits（类型签名展开器）**：识别 `defineEmits<SE<{...}>>(...)` 或 `defineEmits<ShortEmits<{...}>>(...)`。两步：(1) 用两次 `s.remove` 把外层 `SE<`/`>` 或 `ShortEmits<`/`>` 包装**剥掉**，露出 inner 类型；(2) 遍历 inner 的 `TSTypeLiteral` 成员，把三种简写成员改写成 Vue 3.3+ 原生 defineEmits 要求的 **call signature** 形式 `(evt: "key", ...args): void`。
  源码位置: packages/short-emits/src/core/index.ts:31-101

- short-emits 处理的三种成员形态：`TSPropertySignature` 配 `TSTupleType`（`click: [id]`→`...args: [id]`）、`TSPropertySignature` 配 `TSFunctionType`（`change: (v)=>void`→展开参数）、`TSMethodSignature`（`hover(): void`→取其 parameters）。统一用 `s.sliceNode` 把参数片段当字符串抠出再拼接。
  源码位置: packages/short-emits/src/core/index.ts:64-101

- **define-emit（单个 emit 代理器）**：每个 `defineEmit('click', validator?)` 被整体替换成转发函数 `(...args) => __MACROS_emit("click", ...args)`；并在 setup 顶部 `prependLeft` 一个集中的 `const __MACROS_emit = defineEmits(...)`。emit 名字可来自字符串参数，也可从父级 `VariableDeclarator` 的变量名**反推**（无参数时）。
  源码位置: packages/define-emit/src/core/index.ts:35-79

- define-emit 的集中声明分两种形态：所有 emit 都无 validator → 数组 `[name1, name2]`；任一带 validator → 对象 `{ name: validator }`。这是「权衡 3：全无选项走简写数组、带选项走对象」的同一套取舍在 emit 侧的复现。
  源码位置: packages/define-emit/src/core/index.ts:83-97

- **define-prop（最复杂的逐个声明 + 合并器）**：每个 `defineProp(...)` 被替换成 `toRef(__props, "propName")`（`toRef` 由 `importHelperFn` 注入）；收集的 props 合成 `runtimeProps`，再决定如何落定。
  源码位置: packages/define-prop/src/core/index.ts:57-113

- define-prop 落定 runtimeProps 的两条路径：(a) 若组件里**已有** `defineProps(...)` 运行时参数 → 用 `normalizePropsOrEmits` helper 把新旧两份都归一化后**合并**进原参数位（`{ ...norm(old), ...norm(new) }`）；(b) 若没有 → 在顶部 `prependLeft` 一个独立的 `const __MACROS_props = defineProps(runtimeProps)`。若已有 `defineProps<T>()` 泛型形式则**抛互斥错**（defineProp 不能与泛型 defineProps 共存）。
  源码位置: packages/define-prop/src/core/index.ts:86-113

- define-prop 的两种 edition 由同一份 `Impl` 接口约束（`walkCall` 收集 + `genRuntimeProps` 合成），区别只在参数位语义：kevinEdition = `defineProp(name, definition)`（name 可省略、从变量名推）；johnsonEdition = `defineProp(value, required, rest)`（强制赋值给变量、从变量名推 name）。两者都在「全无选项」时退化为简写数组、否则拼对象，复用 `genRuntimePropDefinition`（来自 @vue-macros/api）。
  源码位置: packages/define-prop/src/core/utils.ts:4-15、packages/define-prop/src/core/kevin-edition.ts:16-79、packages/define-prop/src/core/johnson-edition.ts:18-75

- define-prop 还兼顾响应式变换：检测 `$(defineProp('x'))` 或 `$defineProp('x')` 两种写法，命中时用 `$(` `)` 把代理表达式包起来（与第 7 章『响应式语法糖』的接管机制衔接）。
  源码位置: packages/define-prop/src/core/index.ts:59-79

## 关键调用链

define-prop（最完整的一条）：
`parseSFC` → `getSetupAst()` → `walkAST`(收集 defineProp 调用 + 记 parentMap) → `edition.walkCall`(抽 name/选项/类型参数) → 逐调用点 `overwriteNode` 成 `toRef(__props,"name")` → `edition.genRuntimeProps`(异步，可能调 `resolveTSType`→`resolveTSReferencedType`→`inferRuntimeType`) → 命中已有 `defineProps()` 则合并其参数 / 否则 `prependLeft` 新建 `const __MACROS_props = defineProps(...)` → `generateTransform`。
源码位置: packages/define-prop/src/core/index.ts:35-115

define-emit：
`parseSFC` → `getSetupAst()` → `walkAST`(找 defineEmit) → 逐点改写成 `(...args)=>__MACROS_emit(name,...args)` → `prependLeft const __MACROS_emit = defineEmits(mountEmits())` → `generateTransform`。
源码位置: packages/define-emit/src/core/index.ts:27-81

short-emits：
`parseSFC` → `getSetupAst()` → `walkAST`(收集带类型参数的 defineEmits) → 剥 `SE<`/`ShortEmits<` 包装 → 遍历 `TSTypeLiteral` 成员逐一 `overwriteNode` 成 call signature → `generateTransform`。
源码位置: packages/short-emits/src/core/index.ts:19-105

define-props：
`parseSFC` → `getSetupAst()` → `walkAST`(找 `$defineProps`) → `overwriteNode(callee, ' defineProps')` → `generateTransform`。
源码位置: packages/define-props/src/core/index.ts:19-39

## 源码摘录（带行号，全文累计 ≤ 30 行）

short-emits：剥 SE 包装（两次 remove 夹击内层）+ 把成员改写成 call signature：
```ts
// 剥外层 SE<...> / ShortEmits<...> 包装，露出 inner
s.remove(offset + param.start!, offset + inner.start!)
s.remove(offset + inner.end!, offset + param.end!)
// 每个 member → (evt: "key", ...args): void
s.overwriteNode(
  member,
  `(evt: ${key}${params ? `, ${params}` : ''}): void`,
  { offset },
)
```
源码位置: packages/short-emits/src/core/index.ts:43-44, 97-101

define-props：callee 重命名（故意加空格修 sourcemap）：
```ts
if (isCallOf(node, DEFINE_PROPS_DOLLAR)) {
  s.overwriteNode(
    node.callee,
    ` ${DEFINE_PROPS}`,  // add space for fixing mapping
    { offset },
  )
}
```
源码位置: packages/define-props/src/core/index.ts:28-35

define-emit：调用点改写为代理 + 顶部补集中原生宏：
```ts
s.overwriteNode(
  node,
  `(...args) => ${EMIT_VARIABLE_NAME}(${JSON.stringify(emitName)}, ...args)`,
  { offset },
)
// ...
s.prependLeft(
  offset!,
  `\nconst ${EMIT_VARIABLE_NAME} = defineEmits(${mountEmits()})\n`,
)
```
源码位置: packages/define-emit/src/core/index.ts:64-78

define-prop：调用点改写为 toRef 代理（含响应式变换包裹）：
```ts
s.overwriteNode(
  isCallOfDollar ? parent : node,
  `${isReactiveTransform ? '$(' : ''}${importHelperFn(s, offset, 'toRef')}(__props, ${JSON.stringify(propName)})${isReactiveTransform ? ')' : ''}`,
  { offset },
)
```
源码位置: packages/define-prop/src/core/index.ts:69-79

## 易混淆 / 边界 / 推断

- 事实：`EMIT_VARIABLE_NAME`/`PROPS_VARIABLE_NAME` 均以 `HELPER_PREFIX`（`__MACROS_`）开头，刻意用非法标识符前缀避免与用户变量冲突。
  源码位置: packages/define-emit/src/core/index.ts:14、packages/define-prop/src/core/index.ts:24

- 事实：四个宏对 setup AST 节点位置的引用**一律加 `offset`**（scriptSetup 起始偏移），因为 babel 解析的是 setup 片段、而 magic-string 操作的是整份 SFC 文本——这正是「权衡 2：手算 setupOffset 偏移」的代价体现。
  源码位置: packages/short-emits/src/core/index.ts:23,43-44、packages/define-prop/src/core/index.ts:40 等

- 推断：short-emits 的 `resolveObjectKey(member, true)` 第二参数 `true` 推测为「只接受静态字面量 key」（key 必须是字符串字面量，否则无法生成 `"evt"` 字符串）——若用户写 computed/数字 key 应当不被支持，但源码未显式抛错，建议 Writer 此处保守表述或略过。

- 推断：short-emits 不处理「defineEmits 既带 SE 类型又带运行时参数」的组合（它只动类型签名区，运行时参数原样保留），推断这是有意为之——SE 只是类型糖、与运行时声明正交。

- 事实：define-prop 是本章唯一**异步**的宏（`async function`），因 `genRuntimeProps` 可能要走类型降级 `resolveTSReferencedType`（跨文件、异步）；short-emits/define-emit/define-props 都是同步。这条异步链路属第 6 章『better-define』范畴，本章不展开。
  源码位置: packages/define-prop/src/core/index.ts:27,83,117-132

- 事实：define-prop 的 `normalizePropsOrEmits` helper 通过虚拟模块 `helperId`（`/vue-macros/define-prop/helper`）以 `?raw` 形式注入——这套「虚拟 helper 模块」机制属第 3 章，本章只把它当一个可调用的工具。
  源码位置: packages/define-prop/src/core/helper/index.ts:3-4、packages/define-prop/src/core/helper/code.ts:8-17

- 未理解：`isCallOf(node, '$')` 中 `$` 是否在 common 有专门常量定义未确认（define-prop 用它判定 `$()` 响应式变换），属 reactivity-transform 交叉点，不影响本章主线理解。
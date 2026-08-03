# 静态提升与 export 语义重写 · 源码精读

## 给 Writer 的教学钩子（必填，8 子项缺一不可）

- **用户痛点 / 场景**：在 `<script setup>` 里写组件时，开发者会写两类东西：一类是「每次组件实例化都要重新算一遍」的响应式状态，另一类其实是「永远不变、算一次就够」的常量（标题文案、枚举、配色表、第三方样式表）。后者被关在每次都执行的 setup 函数体里纯属浪费；同时，人本能地想用 ES 模块最熟悉的 `export const x` 来声明「这个组件要对外暴露什么」，但 `<script setup>` 里写 `export` 是非法的。两类痛点合起来就是：**setup 函数体里混进了本该属于模块级、或本该属于 Vue 宏语义的语句**，需要一个编译期搬运工把它们各归其位。

- **一句话核心思想**：**在编译期给 setup 里的语句重新分类归区——把静态的搬到只执行一次的模块级，把 export 的语义翻译成 Vue 原生宏**。

- **设计动机（为什么需要它）**：Vue 的 `<script setup>` 在编译后是一个每次实例化都执行的 `setup()` 函数；而普通 `<script>` 是模块顶层、只执行一次。一个不随实例变化的常量放在 setup 里，意味着每次渲染组件都重新分配一次内存、重新求一次值，纯属浪费。提升到普通 `<script>` 即可让它「模块加载时算一次、所有实例共享」。同理，`export` 是 ES 模块的暴露语义，但 `<script setup>` 不允许它存在——因为 setup 的「对外暴露」必须走 Vue 的 `defineExpose` / `defineProps`。所以这一章的本质是**借普通 script 的模块级语义来换性能，借 export 的熟悉语法来换可读性，代价是要在编译期把语义精准地翻译过去**。
  - **承前关系**：本章搬运语句所用的全部编辑原语——懒解析 AST、基于偏移的 `sliceNode` / `removeNode` / `appendRight` / `prependLeft`、`setupOffset` 偏移修正、`generateTransform` 收尾——**（已在第 1 章『SFC 解析与增量 AST 编辑』讲透，本章只看它的新侧面：用同一套增量编辑原语做「跨 `<script>` / `<script setup>` 两个块的语句搬迁与语义重写」）**。Writer 不必重讲偏移与 magic-string，重点放在「搬到哪里、为什么搬、判定标准是什么」。

- **关键权衡**（本 Atlas 核心，4 条）：
  1. **静态判定默认极度保守** → 换来「提升后绝不改变程序行为」的安全性（绝不会把带副作用的表达式误提升成只跑一次） → 代价是错失大量合法优化：纯对象字面量、数组字面量、正则字面量默认**都不**被认作静态而被留在 setup，用户必须用 `/* hoist-static */` 魔法注释手动强制提升（而魔法注释一旦用错、把真有副作用的表达式提升上去，就会改变行为）。
  2. **借普通 `<script>` 的模块级语义做提升目标** → 换来常量只算一次的性能与更瘦的 setup 函数体 → 代价是必须在文件头凭空「造」一个原本不存在的 `<script>` 块（用一对锚定在偏移 0 的开/闭标签插入），并要兜底「整个 setup 被搬空」的退化情况。
  3. **把 `export` 重写成 Vue 原生宏（defineExpose / defineProps）** → 换来「setup 像 ES 模块一样写 export」的可读性、零新运行时 API → 代价是只支持 `export` 的一个子集：`export * from` 和 `export default` 直接抛错不支持，re-export from 别的模块还要重命名 local 标识符以防与 setup 内变量冲突。
  4. **用声明关键字（const vs let/var）来区分「这是 prop 还是 model」** → 换来零新语法、零新 API 的区分手段（`export const`→普通 prop，`export let/var`→双向 model） → 代价是语义超载：声明关键字的本意是「可变性」，这里被借用来当「分类标记」，读者需知这个约定。

- **最小心智模型（6 步）**：
  1. 解析 SFC，拿到 setup 的顶层语句列表与 setup 在源码中的起始偏移。
  2. 逐条语句做「语义归类」判定：它是静态常量？是 export？是第三方样式宏调用？还是普通的响应式逻辑？
  3. 对静态常量/枚举/样式定义：在文件头准备（或复用已有的）普通 `<script>` 块，把语句文本搬到那里。
  4. 从 setup 原位置删除被搬走的语句（处理多声明逗号、整条搬空等边角）。
  5. 对 export：抽出导出名与本地名，擦除 `export` 关键字或整条语句，改写成等价的 defineExpose / defineProps 调用插回 setup。
  6. 兜底检查（setup 是否被搬空）、收口（闭合造出的 script 块），交出改写后的代码与 sourcemap。

- **最小原理演示（替代旧"复刻范围"）**：
  - **应演示**：一个极简的「静态提升搬运工」骨架（约 40～60 行）——给定一段伪 setup 顶层语句，遍历每条 `const`，用一个**保守的静态判定函数**决定它是否可提升；可提升者拼接到文件头的「普通 script 区」并从原位删除。**这段演示演的是权衡 1（保守判定）+ 权衡 2（跨块搬迁造块）**，每一行都对应上述原理点。
  - **应故意省略**：完整的 babel AST 解析（可直接给一个手写的语句数组）、magic-string 的 sourcemap 维护、TS enum 成员判定、多声明逗号的精细偏移清理、export-expose/export-props/define-stylex 三个变体（只演 hoist-static 这一个主机制即可代表全章思想）、HMR、unplugin 集成。
  - **演示载体建议**：本仓库是 TS/JS，**建议写成一段能 `node`/`bun` 直接跑的独立脚本**（不依赖真 SFC，用普通字符串模拟 setup 体即可），核心是一个 `isStatic(node)` 判定函数 + 一个 `hoist(setupCode)` 搬运函数。能跑最好，关键是用输入/中间态/输出三栏演透「保守判定 + 跨区搬迁」。**不要**去搭真 Vue 编译环境——载体服务于演透原理，不是服务于能跑扩展。

- **正文不宜展开的细节**（供 Writer 裁剪）：
  - 多声明 `const a=1, b=2` 提升其一时的逗号偏移清理规则（实现细节，原理上只须说「要善后逗号」）。
  - export-expose 对 re-export from 的 local 重命名（`__MACROS_expose_N` 前缀）与 namespace export 的处理。
  - define-stylex 模板侧 `v-stylex` 翻译时对表达式是否已带括号的补全（`hasColon` 判定）。
  - stylex-attrs 虚拟 helper 的运行时实现（把 React 的 className/style 翻成 Vue 的 class/style 字符串）——属虚拟模块章范畴。
  - define-stylex 把「同一声明语句里非样式宏的兄弟变量」留在 setup 的偏移魔法（`node.start + setupOffset - 1`）。
  - `addNormalScript` 复用已有 `<script>` 块尾作为追加点的分支。

- **推荐的一个执行轨迹例子**：
  - 输入：`<script setup>const name = 'title'</script>` + 模板里 `{{ name }}`。
  - 判定：`'title'` 是字符串字面量 → 静态判定为 true。
  - 搬迁：在偏移 0 插入 `<script>`，把 `\nconst name = 'title'` 追加到该块；从 setup 删除原声明。
  - 兜底：setup 此时被搬空 → 插入 `/* hoist static placeholder */` 占位。
  - 收口：在偏移 0 插入 `\n</script>\n` 闭合造出的块。
  - 输出：`<script>\nconst name = 'title'\n</script>\n<script setup>/* hoist static placeholder */</script>`，模板里 `{{ name }}` 仍合法（setup 顶层可访问模块级 script 的绑定）。

> 以上钩子供 Writer 写「动机→核心思想→心智模型→关键权衡→原理演示」；下面事实部分供核对，不要被 Writer 当目录照抄。

## 概念要点

- **全章统一范式**：4 个宏都是「纯编译期重排 setup 内语句的语义归属」，不引入新运行时能力。hoist-static 与 define-stylex 负责把语句**搬出** setup（到普通 script）；export-expose 与 export-props 负责把 setup 里的 `export` **翻译**成 Vue 宏。源码位置: packages/hoist-static/src/core/index.ts:13-88, packages/export-expose/src/core/index.ts:12-119, packages/export-props/src/core/index.ts:12-96, packages/define-stylex/src/core/index.ts:70-125

- **addNormalScript（造普通 script 块的灵魂 helper）**：若 SFC 已有 `<script>`，`start()` 返回其结尾偏移作追加点；否则在偏移 0 用 `prependLeft(0, '<script lang=...>')` 插开标签并返回 0，`end()` 用 `appendRight(0, '\n</script>\n')` 插闭标签。两个插入都锚定偏移 0，靠 magic-string「同位置按插入顺序排序」保证开标签在前、闭标签在后。源码位置: packages/common/src/vue.ts:91-105

- **isStaticExpression（保守静态判定）**：递归判定表达式是否纯静态。默认只认字面量（`isLiteralType`）、模板串、二元/三元/逻辑组合、TS 类型断言/非空/满足包装；对象/数组/正则/函数/一元默认**不认**，需显式传 option 才纳入。hoist-static 调用时**只**开了 `unary: true`，未开 `object/array/regex`。源码位置: packages/common/src/ast.ts:22-113

- **魔法注释逃生口**：`/* hoist-static */`（trim 后精确匹配常量 `MAGIC_COMMENT`）可强制把任意表达式视为静态、绕过保守判定——这是给用户的手动覆盖阀，也是误用风险源。源码位置: packages/common/src/ast.ts:36-43, packages/hoist-static/src/core/index.ts:11,44-48

- **hoist-static 处理两类语句**：(a) `const` 声明中 init 静态的 declarator 逐个提升；(b) `TSEnumDeclaration` 若所有成员 initializer 都静态则整体提升。整条 `const` 的所有 declarator 都被提升时才 removeNode 整条，否则保留剩余部分（并清理被提升 declarator 相邻的逗号）。源码位置: packages/hoist-static/src/core/index.ts:38-78

- **惰性造块**：`scriptOffset` 初始为 undefined，只有第一次真要提升时才调用 `normalScript.start()` 触发造块；若全程无提升，则不造 `<script>` 块、也不调 `normalScript.end()` 闭合。源码位置: packages/hoist-static/src/core/index.ts:17-18,36,85

- **空 setup 兜底**：提升后若 setup 剩余内容 trim 为空，插入 `/* hoist static placeholder */` 占位。源码位置: packages/hoist-static/src/core/index.ts:80-83

- **export-expose 收集与重写**：遍历 setup 顶层，把所有 `ExportNamedDeclaration`（value 类型）的导出名收入 `exposed` 表。带声明的（const/function/class/enum）仅删掉 `export ` 前缀（remove 6 字符）、保留声明；纯 specifier 形式删整条；re-export from（`export {} from './x'`）改写成 `import` 并把 local 重命名为 `__MACROS_expose_N` 防冲突。最后拼 `defineExpose({...})` 插到 setup 末尾。`export * from` 与 `export default` 抛错不支持。源码位置: packages/export-expose/src/core/index.ts:26-118

- **export-props 用声明关键字区分 prop/model**：`export const` → 普通 prop（生成 `defineProps<{...}>()` 解构）；`export let/var` → 双向 model（生成 `let x = $(defineModel(...))`，依赖响应式语法糖的 `$()` 宏）。id 必须是 Identifier（解构抛错）；与已有 `defineProps`/`withDefaults` 冲突抛错。源码位置: packages/export-props/src/core/index.ts:54-95

- **define-stylex 双侧改写**：script 侧把 `defineStyleX(...)` 调用的 callee 改名 `_stylex_create`、整条声明提升到普通 script（同语句里非样式宏的兄弟变量则留在 setup 原位）；模板侧用 Vue 编译器的 `traverseNode` + 自定义 NodeTransform 把 `v-stylex` 指令改写成 `v-bind="__MACROS_stylex_attrs(_stylex_props(...))"`。末尾注入 `@stylexjs/stylex` 的 create/props import。源码位置: packages/define-stylex/src/core/index.ts:29-67,87-124

## 关键调用链

**hoist-static（提升主链）**：
`transformHoistStatic` → `parseSFC` 取 `scriptSetup` + `getSetupAst()` → 遍历 `program.body` → `isStaticExpression(decl.init, {unary, magicComment})` 判定 → `moveToScript(decl)` → `addNormalScript().start()` 取/造 script 区偏移 → `s.appendRight(scriptOffset, text)` 追加 + `s.removeNode(decl)` 删原位 → 空 setup 兜底 → `normalScript.end()` 闭合 → `generateTransform`。
源码位置: packages/hoist-static/src/core/index.ts:26-87, packages/common/src/vue.ts:91-105

**export-expose（export→defineExpose）**：
`transformExportExpose` → 遍历 setup body → 命中 `ExportNamedDeclaration` → 收入 `exposed` 表（带声明删前缀 / specifier 删整条 / re-export-from 改 import 重命名）→ 拼 `defineExpose({...})` → `s.prependLeft(setupEnd)`。
源码位置: packages/export-expose/src/core/index.ts:20-118

**define-stylex（样式定义提升 + 模板指令翻译）**：
`transformDefineStyleX` → 早退检查（代码含 `defineStyleX`）→ `walkAST` 找含调用的 `VariableDeclaration` → callee 改名 + 提升到 script / 兄弟变量留 setup → `traverseNode` 遍历模板改写 `v-stylex` → 注入 stylex import。
源码位置: packages/define-stylex/src/core/index.ts:74-124

## 源码摘录（带行号，全文累计 ≤ 30 行）

造普通 script 块的核心 helper（跨 hoist-static / define-stylex 共用）：
```ts
export function addNormalScript({ script, lang }: SFC, s: MagicString) {
  return {
    start(): number {
      if (script) return script.loc.end.offset
      const attrs = lang ? ` lang="${lang}"` : ''
      s.prependLeft(0, `<script${attrs}>`)
      return 0
    },
    end(): void {
      if (!script) s.appendRight(0, `\n</script>\n`)
    },
  }
}
```
源码位置: packages/common/src/vue.ts:91-105

魔法注释逃生口——保守判定的唯一手动覆盖阀：
```ts
  if (
    magicComment &&
    node.leadingComments?.some(
      (comment) => comment.value.trim() === magicComment,
    )
  )
    return true
```
源码位置: packages/common/src/ast.ts:36-43

hoist-static 的搬迁原语（搬文本到 script 区 + 删原位）：
```ts
  function moveToScript(decl: Node, prefix: 'const ' | '' = '') {
    if (scriptOffset === undefined) scriptOffset = normalScript.start()
    const text = `\n${prefix}${s.sliceNode(decl, { offset: setupOffset })}`
    s.appendRight(scriptOffset, text)
    s.removeNode(decl, { offset: setupOffset })
  }
```
源码位置: packages/hoist-static/src/core/index.ts:17-24

## 易混淆 / 边界 / 推断

- **事实**：hoist-static 调用 `isStaticExpression` 时只开 `{ unary: true }`，未开 `object/array/regex/fn`。因此 fixtures 里 `const i = {...}`、`const j = [...]`、`const l = /a/`、`const k = Symbol()` 均**不**被提升（对象/数组/正则未开 option，Symbol() 是 CallExpression）。源码位置: packages/hoist-static/src/core/index.ts:43-50, fixtures/basic.vue:10-15
- **事实**：`isStaticExpression` 的最终兜底是 `if (isLiteralType(node)) return true; return false`——字面量是保守判定的基底。源码位置: packages/common/src/ast.ts:111-112
- **事实**：common 还导出 `checkInvalidScopeReference`（检查被提升表达式是否引用了 setup 局部变量，引用则抛错），但本章 4 个宏**均未调用**它——即 hoist-static 不主动阻止静态表达式引用 setup 变量（静态判定本身已几乎排除含标识符引用的非字面量表达式）。源码位置: packages/common/src/ast.ts:6-20
- **推断（标注为推断）**：空 setup 兜底注释 `/* hoist static placeholder */` 的意图未在源码注释中说明；推断为防止「setup 块全空」导致下游 Vue 编译器或后续宏处理异常（如 setup 块缺失被认为是非法 SFC）。源码位置: packages/hoist-static/src/core/index.ts:80-83
- **事实**：export-expose 对 `export * from` 与 `export default` 直接 `throw new Error`，属硬性不支持子集。源码位置: packages/export-expose/src/core/index.ts:93-104
- **事实**：export-props 生成 model 时用 `$()` 包裹 `defineModel`，依赖响应式语法糖宏；若该宏未在管道中启用，生成的代码将含未解析的 `$()`。源码未对此做守卫。源码位置: packages/export-props/src/core/index.ts:56
- **未理解**：define-stylex 把同语句中「非 defineStyleX 的兄弟变量」留在 setup 时用的偏移 `node.start! + setupOffset - 1`（`-1` 的语义未完全确认，推断为定位到声明语句起始的某个锚点字符）。源码位置: packages/define-stylex/src/core/index.ts:103-106
- **跨章复用提示（给 Writer）**：本章编辑原语（parseSFC 懒解析、MagicStringAST 偏移操作、generateTransform）全部复用第 1 章；define-stylex 的虚拟 helper 模块（styleXAttrsId）复用「虚拟 helper 模块」章；export-props 的 `$()`/defineModel 复用「响应式语法糖」与「defineModels」章——讲 define-stylex/export-props 时点到「这里复用了 X 章」即可，不展开。
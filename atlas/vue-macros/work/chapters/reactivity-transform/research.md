# 响应式语法糖：赋值即 .value · 源码精读

## 给 Writer 的教学钩子（必填，8 子项缺一不可）

- **用户痛点 / 场景**：写 Composition API 时，每个响应式变量都得 `.value` 才能读写——`count.value++`、`user.value.name`。样板冗余、容易忘、模板字符串里尤其啰嗦。用户想要的是「声明成响应式之后，就当普通变量用」。

- **一句话核心思想**：**编译期记账，引用处补 .value**——先把「谁是响应式变量」登记成册，再把源码里对它的每一处读 / 写，就地改写成 `.value` 访问。

- **设计动机（为什么需要它）**：解决「ref 的 `.value` 累赘」与「想要普通变量书写体验」之间的矛盾。它的运行时语义完全等价于手写 `ref().value`，不发明任何新运行时能力，只是把 `.value` 的填写工作搬到编译期。**承前**：拆 SFC 成 script / scriptSetup、按需懒解析 AST、用增量字符串编辑器改写并保留 sourcemap、自行处理 setup 块偏移——这套「解析 + 懒解析 + 增量编辑 + 偏移」的底座**（已在第 1 章『SFC 解析与增量 AST 编辑』讲透，本章只看它的新侧面：用这套底座做「标识符引用层面的语义改写」，即不新增解析 / 编辑基础设施，而是在它之上做一次针对标识符读写的定向重写）**。此外，props 解构的 rest 代理通过编译期注入一个虚拟 helper 模块提供运行时实现，该「虚拟模块桥接编译期与运行时」机制**（已在第 3 章『编译期注入虚拟 helper 模块』讲透，本章只看它被复用来承载 `createPropsRestProxy`）**。

- **关键权衡**（本 Atlas 核心）：
  1. **静态文本改写换取无 .value 体验**：选择「编译期把 `x` 改写成 `x.value`」而非「运行时用 Proxy 自动解包」→ 换来零额外运行时开销、与原生 ref 完全兼容、类型推导不受影响 → 代价是**失去语法透明性**（看源码看不出哪些变量被宏接管）、且为避免误改必须做大量保守的静态判定（作用域分析、排除声明位标识符、跳过类型节点等）。
  2. **两遍遍历（先登记、后改写）换取引用正确性**：选择「先全量扫描所有声明建绑定表，再遍历引用查表改写」而非「单遍边走边改」→ 换来「引用可以出现在声明之前 / 任意嵌套位置都能被正确识别」→ 代价是两趟遍历 + 必须手工维护一个词法作用域栈（函数体 / 块 / catch 各开一层）。
  3. **解构用「临时变量 + 逐字段取值」拆解换取解构语法可用**：选择把 `const { x } = $(useFoo())` 改写成「先整体赋给一个临时变量，再逐个字段包成响应式」而非「直接禁止解构」→ 换来响应式解构的完整语法（含默认值、嵌套、重命名）→ 代价是生成临时变量、且嵌套路径要靠一段路径拼字符串逻辑还原。
  4. **正则预筛换取跳过无关文件**：选择「先用一条正则快速判断源码是否含 `$` 糖，无糖直接原样返回」而非「对所有文件都做完整解析 + 双遍遍历」→ 换来绝大多数无糖文件零成本跳过 → 代价是正则存在边界误判风险（因此只是「是否进入转换」的粗筛，最终正确性仍由 AST 判定保证）。

- **最小心智模型（7 步）**：
  1. 正则粗筛：源码里没有 `$ref` / `$()` / `$computed` / `$$()` 之类痕迹，直接原样返回，不做任何解析。
  2. 第一遍「登记」：扫描全部声明（变量、函数、类、for-in/of、export、labeled），凡是形如 `const x = $ref(...)` / `const x = $(...)` 的，把 `x` 登记为「响应式绑定」，记下是否 const、是否来自 props 解构；其余普通声明也登记（占位，避免被误当响应式）。函数体 / 块 / catch 各自压入一层新作用域。
  3. 第二遍「改写」：遍历每一处标识符**引用**，从最内层作用域向外逐层查绑定表。
  4. 命中响应式绑定：普通引用在其后插入 `.value`；对象简写 `{ foo }` 补成 `{ foo: foo.value }`；若该绑定是 `const` 却出现在赋值 / 自增左侧，直接报错。
  5. 命中 props 绑定：改写成对 `__props` 的属性访问（`__props.foo`）。
  6. 遇到解构声明：把被 `$()` 包裹的解构模式整体替换成一个临时变量，再在后面追加「逐字段取值并包成响应式」的语句。
  7. 遇到 `$$()`：把它标记成「转义区域」，区域内对响应式变量的引用**不加** `.value`（即取原始 ref 对象本身），并删掉 `$$` 符号；最后把用到的运行时 helper（`ref` / `computed` / `toRef` …）统一注入到顶部。

- **最小原理演示（替代旧"复刻范围"）**：
  - **应演示**：一个只表达「两遍遍历 + 作用域绑定表 + 引用处补 .value」核心的小脚本（约 40 行）。它用 babel 解析源码、用增量字符串编辑器改写：第一遍扫描 `const x = $ref(...)` / `$(...)` 登记 `x`；第二遍遍历标识符引用，命中则在后面 appendLeft `.value`；并演示 `$$()` 转义（区域内的引用不改写）。每一行都要对应上面某条原理（登记 / 作用域查表 / `.value` 注入 / 转义）。**这段演示演的是「权衡 1 + 权衡 2」**：静态改写换无 `.value` 体验、两遍遍历换引用正确性。
  - **应故意省略**：解构拆解（临时变量 + 路径拼字符串）、props 解构 polyfill（withDefaults / mergeDefaults / rest 代理）、TS 类型节点跳过、`const` 赋值报错、跨 script / scriptSetup 块的作用域穿透、helper import 注入的细节——这些是工程完整度，不演透原理。
  - **演示载体建议**：本仓库主语言是 TS，建议写成一段能 `bun run` / `node` 直接跑的独立脚本（用 `@babel/parser` + `magic-string` 两个真实依赖，能跑最好但非硬要求）。不需要 SFC 宿主、不需要构建器——纯粹是一段「字符串进、字符串出」的转换函数，最适合用脚本演透。

- **正文不宜展开的细节**：解构的嵌套 `pathToString` 路径拼接（ObjectPattern / ArrayPattern 递归 + 默认值短路）；props 解构 polyfill 的三条分支（类型走 withDefaults、运行时对象走 mergeDefaults、rest 走 createPropsRestProxy 虚拟模块）；跳过 TS 类型节点的判定；`$$()` 作为表达式语句时向前补分号避免被当成上一行函数调用的边界处理；正则 `transformCheckRE` 各分支的精确含义。

- **推荐的一个执行轨迹例子**：
  - 输入（一段 setup 代码）：
    `const count = $ref(0); const double = $computed(() => count * 2); function inc() { count++; log($$(count)) }`
  - 第一遍登记：`count`、`double` 进响应式绑定表。
  - 第二遍改写：`count * 2` → `count.value * 2`；`count++` → `count.value++`；`$$(count)` 是转义区，内部 `count` 不加 `.value`、`$$` 被删除。
  - 输出（顶部已注入 helper）：
    `import { ref as _ref, computed as _computed } from 'vue'; const count = _ref(0); const double = _computed(() => count.value * 2); function inc() { count.value++; log(count) }`

> 以上钩子供 Writer 写「动机→核心思想→心智模型→关键权衡→原理演示」；下面事实部分供核对，不要被 Writer 当目录照抄。

## 概念要点

- **核心是「转换函数 + AST 改写」两个文件 + 一个聚合导出**：`transform.ts` 提供与 SFC 无关的通用转换（`shouldTransform` / `transform` / `transformAST`），`sfc.ts` 提供 Vue SFC 专用入口（`transformVueSFC`，额外处理 props 解构 polyfill 与跨块作用域），`index.ts` 仅 `export *` 聚合两者。源码位置: packages/reactivity-transform/src/core/index.ts:1-2

- **正则预筛 `shouldTransform`**：用单条正则判断源码是否含 `$` / `$$` / `$ref` / `$computed` / `$shallowRef` / `$toRef` / `$customRef` 后跟 `(` / `<` / `as` 的痕迹；无则整个转换被跳过。这是「权衡 4」的直接实现。源码位置: packages/reactivity-transform/src/core/transform.ts:48-53

- **合法的响应式糖来源被收敛成一张白名单**：宏 import 只接受三个来源（`vue/macros`、`@vue-macros/reactivity-transform/macros`、`vue-macros/macros`），且这些 import 语句会被整体删除（运行时不需要它们）。`$`（转换符号）与 `$$`（转义符号）允许用户重命名 import，但 ref 创建方法（ref/computed/…）禁止别名。源码位置: packages/reactivity-transform/src/core/transform.ts:36-47, 154-179, 206-211

- **绑定表 + 作用域栈是改写的依据**：`Scope = Record<string, Binding | false>`，`Binding` 带 `isConst`（const ref 禁止赋值）和 `isProp`（来自 props 解构）；`scopeStack` 底层是 rootScope，函数体 / catch / 非函数块各压一层。标识符引用从内到外逐层查表决定是否改写。源码位置: packages/reactivity-transform/src/core/transform.ts:55-59, 182-188

- **两遍遍历**：先 `walkScope(ast, true)` 扫描全部声明注册绑定（含识别 ref 创建调用 → `registerRefBinding`），再 `walkAST` 遍历引用查表改写。这是「权衡 2」的实现。源码位置: packages/reactivity-transform/src/core/transform.ts:710-711, 288-316

- **ref 创建调用的识别 `isRefCreationCall`**：分两类——通用转换符 `$()`（convertSymbol），和简写 `$ref` / `$computed` / `$shallowRef` / `$toRef` / `$customRef`（shorthands 集合）。一个关键守卫：若当前作用域里已存在与 `$` 同名的局部变量（被遮蔽），则不再把它当转换符——避免误伤用户自己的 `$` 变量。源码位置: packages/reactivity-transform/src/core/transform.ts:229-240, 41-47

- **声明处理 `processRefDeclaration` 的两条分支**：
  - `$()` 模式：删除 `$` 符号，按 id 形态分发——单个标识符直接登记；ObjectPattern / ArrayPattern 走解构拆解。运行时 `$()` 调用本身保留（它返回的已是 ref）。
  - 简写模式（`$ref` 等）：仅支持单个标识符（解构直接报错），登记绑定并把调用名改写成运行时 helper（`$ref` → `_ref`）。
  源码位置: packages/reactivity-transform/src/core/transform.ts:353-398

- **解构拆解 = 临时变量 + 逐字段 toRef**：`const { x } = $(useFoo())` 被改写成「先把整个解构模式替换成临时变量 `const __$temp_1 = useFoo()`，再在其后追加 `x = _toRef(__$temp_1, 'x')`」。嵌套解构靠 `path`（路径段数组）+ `pathToString` 还原取值路径；rest 元素（`...foo`）明确不支持并报错。这是「权衡 3」的实现。源码位置: packages/reactivity-transform/src/core/transform.ts:400-522, 524-590, 598-619

- **引用改写 `rewriteId` 的三种产物**：命中普通 ref 绑定 → 标识符后追加 `.value`；对象简写 `{ foo }` → 补成 `{ foo: foo.value }`；命中 props 绑定 → 改成 `__props.xxx`（用 `genPropsAccessExp` 生成安全的属性访问表达式）。const ref 出现在赋值 / UpdateExpression 左侧 → 抛「Assignment to constant variable」。这是「权衡 1」的实现。源码位置: packages/reactivity-transform/src/core/transform.ts:621-693

- **`$$()` 转义作用域**：进入 `$$()` 时把该 CallExpression 记为 `escapeScope`、删掉 `$$` 符号；遍历时只要处于 escapeScope 内，普通 ref 引用就**跳过** `.value` 改写（取原始 ref 对象），唯独 props 绑定例外（仍改写成 `__props_x`，并注入一条 `const __props_x = _toRef(__props, 'x')` 顶部声明）。边界：`$$()` 作为表达式语句时，向前回溯到换行处补一个分号，防止被解析成上一行的函数调用。源码位置: packages/reactivity-transform/src/core/transform.ts:782-811, 751-767, 695-707

- **大量「别误改」的保守判定**：`excludedIds`（WeakSet）排除声明位的标识符自身、解构简写的 value 标识符、defineProps 解构的标识符；`isReferencedIdentifier`（来自 @vue/compiler-core）排除类型位置 / 属性键等非引用位置；TS 类型节点整体 `skip()`。这些是「权衡 1」代价（失去透明性、需大量静态判定）的具体体现。源码位置: packages/reactivity-transform/src/core/transform.ts:186, 257-260, 344, 742-749, 756

- **helper 统一注入**：转换中用到的运行时方法（ref/computed/toRef/mergeDefaults…）记入 `importedHelpers`，最后在顶部 `prepend` 一条 `import { ref as _ref, … } from 'vue'`（源可配 `importHelpersFrom`，默认 vue）。源码位置: packages/reactivity-transform/src/core/transform.ts:181, 248-251, 108-115

- **SFC 入口 `transformVueSFC` 复用前置章底座**：调用 `parseSFC(code, id)` 拿到 `script` / `scriptSetup` / `getScriptAst` / `getSetupAst`（懒解析），用 MagicStringAST 增量改写，把各自块的 `loc.start.offset` 作为偏移传给 `transformAST`。这是与第 1 章的直接承前。源码位置: packages/reactivity-transform/src/core/sfc.ts:18-23, 29-34, 39-58

- **跨块作用域穿透（SFC 独有）**：先转换 `<script>` 块得到的 `rootRefs`，作为 `knownRefs` 传给 `<script setup>` 的 `transformAST`——这样 setup 里引用 script 块声明的 ref 也会被正确 `.value` 改写。源码位置: packages/reactivity-transform/src/core/sfc.ts:25, 30-36, 50-56, 190-194

- **props 解构 polyfill `processDefineProps`（SFC 独有，vue 3.5 reactive props destructure 的向下兼容）**：识别 `const { foo = 1, bar } = defineProps<…>()`，按声明形态分三条改写：
  - 有类型参数 + 默认值 → `withDefaults(defineProps<…>(), { foo: 1 })`；
  - 有运行时对象参数 + 默认值 → `defineProps(mergeDefaults({...}, { foo: 1 }))`；
  - 重命名 `{ foo: renamedFoo }` → 额外注入 `const renamedFoo = _toRef(__props, 'foo')`；
  - rest `{ ...rest }` → 注入虚拟模块的 `createPropsRestProxy(__props, [...已知key])`。
  收集到的 `propsDestructuredBindings` 作为 `knownProps` 传给 `transformAST`，使这些变量在引用处被改写成 `__props.xxx`。源码位置: packages/reactivity-transform/src/core/sfc.ts:63-185, 79, 103-105, 119, 132-142, 144-153

- **rest 代理的运行时实现走虚拟模块**：`createPropsRestProxy` 用 `Object.defineProperty` 为每个未被解构的 prop 建 getter 代理（排除已解构的 key），其源码经 `?raw` 作为 helper 虚拟模块代码注入（`helperId` = `__VUE_MACROS__/reactivity-transform/helper`）。这与第 3 章「虚拟 helper 模块」是同一机制。源码位置: packages/reactivity-transform/src/core/helper/code.ts:1-16, packages/reactivity-transform/src/core/helper/index.ts:3-4

## 关键调用链

- **通用转换（非 SFC）**：
  `shouldTransform(src)`（正则预筛）→ `transform(src)` → `@babel/parser parse` → `new MagicStringAST` → `transformAST(program, s, 0)`【内含：`walkScope` 登记绑定 → `walkAST` 改写引用（`rewriteId` 注入 `.value` / 处理 escapeScope）】→ 顶部 `prepend` helper import → 返回 `{ code, map, rootRefs, importedHelpers }`。
  源码位置: packages/reactivity-transform/src/core/transform.ts:82-128, 130-146, 710-828

- **SFC 转换**：
  `transformVueSFC(code, id)` → `parseSFC` →【script 块：`shouldTransform`? → `transformAST(getScriptAst(), s, scriptOffset)` → 得 `rootRefs`】→【scriptSetup 块：遍历 body 调 `processDefineProps` 收集 `propsDestructuredBindings` → 若有 props 解构 / 有 rootRefs / `shouldTransform` 则 `transformAST(getSetupAst(), s, setupOffset, rootRefs, propsDestructuredBindings)`】→ `importHelpers` → `generateTransform(s, id)`。
  源码位置: packages/reactivity-transform/src/core/sfc.ts:18-62

- **解构拆解内部链**：
  `processRefDeclaration`（命中 `$()` + ObjectPattern/ArrayPattern）→ `processRefObjectPattern` / `processRefArrayPattern`（生成临时变量、递归处理嵌套、收集 nameId）→ `pathToString` 拼取值路径 → `s.appendLeft` 注入 `nameId = _toRef(source, key[, default])`。
  源码位置: packages/reactivity-transform/src/core/transform.ts:330-335, 372-381, 400-522, 598-609

## 源码摘录（带行号，全文累计 ≤ 30 行）

正则预筛（「权衡 4」）：

```ts
const transformCheckRE =
  /\W\$(?:\$|ref|computed|shallowRef|toRef|customRef)?\s*(?:[(<]|as)/

export function shouldTransform(src: string): boolean {
  return transformCheckRE.test(src)
}
```
源码位置: packages/reactivity-transform/src/core/transform.ts:48-53

ref 创建识别（含「被局部变量遮蔽则不当转换符」守卫）：

```ts
function isRefCreationCall(callee: string): string | false {
  if (!convertSymbol || getCurrentScope()[convertSymbol] !== undefined) {
    return false
  }
  if (callee === convertSymbol) return convertSymbol
  if (callee[0] === '$' && shorthands.has(callee.slice(1))) return callee
  return false
}
```
源码位置: packages/reactivity-transform/src/core/transform.ts:229-240

引用改写核心：普通 ref → `.value`（「权衡 1」）：

```ts
} else {
  // x --> x.value
  s.appendLeft(id.end! + offset, '.value')
}
```
源码位置: packages/reactivity-transform/src/core/transform.ts:685-688

解构拆解：临时变量替换模式（「权衡 3」）：

```ts
if (!tempVar) {
  tempVar = genTempVar()
  // const { x } = $(useFoo()) --> const __$temp_1 = useFoo()
  s.overwrite(pattern.start! + offset, pattern.end! + offset, tempVar)
}
```
源码位置: packages/reactivity-transform/src/core/transform.ts:407-411

`$$()` 转义作用域进入：

```ts
if (escapeSymbol && getCurrentScope()[escapeSymbol] === undefined &&
    callee === escapeSymbol) {
  escapeScope = node
  s.remove(node.callee.start! + offset, node.callee.end! + offset)
  removeTrailingComma(s, node, offset)
}
```
源码位置: packages/reactivity-transform/src/core/transform.ts:782-789

（以上累计约 26 行。）

## 易混淆 / 边界 / 推断

- **事实**：`$()` 与简写（`$ref` 等）在声明处理上走不同分支——`$()` 支持解构（因它包裹的是任意返回值，靠 toRef 拆），简写不支持解构（因它们本身就是 ref 工厂，解构一个 ref 无意义）。源码位置: packages/reactivity-transform/src/core/transform.ts:361-397

- **事实**：`rewriteId` 只处理「命中绑定且 binding 为真」的情况；`binding === false`（普通声明占位）不触发任何改写，但会 `return true` 阻止继续向外层查表——这是「同名变量在内层被声明为非 ref 时，遮蔽外层 ref」的正确行为。源码位置: packages/reactivity-transform/src/core/transform.ts:627-692

- **事实**：`getCurrentScope()`（用于遮蔽判定）是把整条作用域栈 reduce 合并成一个新对象，每次 ref 创建识别都调用一次——这是为正确性付出的性能代价（推断：在超大文件 / 极多作用域时可能有开销，但正确性优先）。源码位置: packages/reactivity-transform/src/core/transform.ts:229-240, 253-255

- **事实**：props 绑定在 `$$()` 内的行为与普通 ref 不同——普通 ref 在 `$$()` 内不加 `.value`（取原始 ref），但 props 绑定在 `$$()` 内会被改成 `__props_x` 并注入一条 `const __props_x = _toRef(__props, 'x')`，即「把 prop 也变成一个可脱离 `.value` 使用的 ref」。源码位置: packages/reactivity-transform/src/core/transform.ts:668-684, 695-707

- **推断**：sfc.ts 里 `processDefineProps` 对默认值是否包成工厂函数的判定（`withFactory`）注释自承「Not very accurate, but should work in most cases. Bad design of Vue...」——说明这是为兼容 Vue 运行时对 default 的处理约定（对象 / 数组类型 default 须返回工厂）而做的近似启发式，非精确类型推导。源码位置: packages/reactivity-transform/src/core/sfc.ts:109-117

- **事实**：`shouldTransform` 仅作为「是否进入转换」的粗筛；即便通过，最终是否真有可改写的糖仍由 AST 判定决定——因此正则的边界误判只影响「是否多跑一次解析」，不影响输出正确性。源码位置: packages/reactivity-transform/src/core/transform.ts:51-53, 329

- **未理解 / 待查**：`walkScope` 对 `LabeledStatement`（标签语句）下的 VariableDeclaration 也走 `walkVariableDeclaration(stmt.body, isRoot)`（源码位置: packages/reactivity-transform/src/core/transform.ts:309-314）——推测是为兼容某种 `label:` 风格的声明语法，但未在 sourceFiles 范围内找到对应使用场景，无法确认其具体动机，留给后续核对。
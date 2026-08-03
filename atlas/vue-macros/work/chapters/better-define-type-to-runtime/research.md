# better-define：把 TS 类型降级为运行时校验 · 源码精读

## 给 Writer 的教学钩子（必填，8 子项缺一不可）

- **用户痛点 / 场景**：用原生带泛型的 `defineProps<T>()` 时，类型参数只在编译期被擦除——Vue 只从中抽取「字段名 + 是否可选」生成 props 选项，运行时拿不到任何类型信息（`type` 字段缺失），于是传错类型的 prop 在运行时静默通过，开发期也只有 Vue 自己那点基于「字段名」的薄弱提示。使用者想要的是「我写了一份类型，它就真的在运行时校验我」，而不是「类型只活在编辑器里」。

- **一句话核心思想**：在编译期把类型表达式完整求值一遍，把它「编译」成 Vue 运行时认识的 `{ type, required, default }` 对象——**让类型成为运行时校验的唯一真相来源**。

- **设计动机（为什么需要它）**：原生宏的类型参数是纯编译期产物，运行时被完全擦除；这个机制存在的目的就是填上「类型擦除后运行时失忆」这道鸿沟，换来的能力是「改一处类型，编译期自动派生出对应的运行时校验，永不漂移」。其中「承前」部分：本章面对的已经是被前置章重写干净的标准 `defineProps<T>()` / `withDefaults(defineProps<T>(), {...})`（**已在第 4 章『props/emit 宏的编译期重写与类型转换』讲透「语法糖在编译期重写成原生宏、运行时只认原生宏」，本章只看它的下一个动作：把原生宏的类型参数进一步降级成运行时选项**）。Writer 注意去重：第 4 章讲的是「写法→原生宏」的重写，本章讲的是「类型→运行时对象」的求值，方向不同，不要混讲。

- **关键权衡（本 Atlas 的核心）**：
  1. **让类型成为运行时校验的唯一真相来源（而非让用户双写类型 + 运行时选项）** → 换来「改类型即改校验、两侧永不漂移」 → 代价是必须在编译期自实现一个迷你的、能跨文件的类型求值器（递归展开类型别名、interface 继承、`Partial<>` 等组合），复杂度极高、且必须异步。
  2. **「尽力而为、失败即降级」换可用性** → 类型求值任何一步失败（遇到不支持的语法、解析不到的 import、互相递归的类型）就整体短路返回错误，在插件层被吞成一条 `warn`，**原 `defineProps` 原封不动保留** → 代价是用户无法保证「我的 props 一定被运行时校验了」（可能静默退化为无校验），warn 是否被看到全靠用户自觉。
  3. **跨文件递归求值 + 栈式环检测** → 换来支持 `import type` 跨文件取类型、命名空间下钻、`A extends B`、`Partial/Required/Readonly` 等任意组合 → 代价是磁盘读 + 递归 parse 的开销巨大，必须叠三层缓存（已解析文件缓存、import 路径解析缓存、调用栈环检测）外加一张「被引用文件 → 引用者」反向表来支撑 HMR，否则增量成本不可接受。
  4. **生产环境几乎擦除运行时类型校验（只保留 Boolean / Function）** → 换来生产包零校验开销（String/Number 等校验对业务无实质保护、徒增成本） → 代价是这个机制的运行时校验**主要只服务开发期**，生产环境基本退化为「只保留语义相关的 Boolean（影响 v-model/未传参默认值）和 Function（影响事件绑定）」。

- **最小心智模型（3～7 步）**：
  1. 在编译期拦下「带类型参数」的 `defineProps<T>()`（无类型参数的不处理，留给 Vue）。
  2. 把 `T` 当成一个**需要被求值的类型表达式**（而不是要被擦除的标注）。
  3. 遇到类型名字 → 查当前文件的「导入/声明表」；若名字来自别的文件 → 读盘解析那个文件、递归求值（带着一个调用栈做环检测，防止 `A=B; B=A` 死循环）。
  4. 把展开后的「字段集合」逐字段映射成 Vue 运行时构造器名（`String`/`Number`/`Boolean`/`Object`…），`optional` 翻译成 `required: false`。
  5. 拼成 `{ 字段: { type, required, default } }` 对象，整体覆盖回 `defineProps(...)`。
  6. 任何一步失败 → 求值短路抛错 → 插件降级为 warn，原 `defineProps` 一字不改。

- **最小原理演示（替代旧"复刻范围"）**：
  - 应演示：一个几十行的从零脚本，演**第 1 条权衡（类型即唯一真相来源）+ 第 2 条权衡（失败即降级）**。核心两段——(a) 输入 `defineProps<{ foo: string; bar?: number }>()` 的字符串，parse 出类型字面量的 members，把每个成员按一张极简映射表（字符串关键字→`'String'`、数字关键字→`'Number'`、`optional`→`required:false`）拼成 `defineProps({ foo: { type: String, required: true }, bar: { type: Number, required: false } })` 并覆盖原文；(b) 再喂一个含「无法识别的类型」的输入，演示求值短路返回错误、调用方把它降级为 warn 并保留原文。每一行都要对应上面某个原理点。
  - 应故意省略：跨文件 import 解析、环检测、union/intersection/interface extends、`Partial<>` 等内建工具类型、生产环境 type 擦除优化、emits 降级、HMR——这些是把原理撑大的工程化部分，演示只演「类型 AST → 运行时对象」这条主干 + 失败降级。
  - 演示载体建议：本仓库主语言是 TS，建议写成能 `bun run`/`node` 直接跑的独立脚本（能跑最好，非硬要求），用 `@babel/parser` 解析一段 setup 字符串即可，**不要**引入真的 oxc-resolver / 读盘——演示只为演透「类型求值 + 降级」思想，载体服务于演透原理、不服务于工程完整。

- **正文不宜展开的细节**（供 Writer 裁剪）：内建工具类型 handler 表（`Partial/Required/Readonly` 的可选位翻转、`Pick/Omit` 尚未实现）、mapped type 与 indexed access type 的展开、`TSIndexSignature` 不支持、union 类型合并时「同名字段不同种类报错」的边界、`withDefaults` 静态默认值 vs 动态默认值（动态走 `mergeDefaults` 包裹）的分支、HMR 反向依赖表的递归失效算法、生产环境 type 过滤里「Boolean 必留、伴随 String 必留、Function 必留」的具体规则。这些都属于「事实库」，正文点到「存在这些边界」即可，不必逐条展开。

- **推荐的一个执行轨迹例子**：
  - 输入：`const props = defineProps<{ foo: string; bar?: number }>()`
  - 关键中间态：识别出带类型参数的 defineProps → 类型字面量被求值成字段集合 `{foo:{字符串,必填}, bar:{数字,可选}}` → 每字段映射成构造器名
  - 输出：原语句被改写为 `const props = defineProps({ foo: { type: String, required: true }, bar: { type: Number, required: false } })`（开发期）；若类型里混入解析不了的符号，则输出 = 输入（原样保留）+ 一条 warn。

> 以上钩子供 Writer 写「动机→核心思想→心智模型→关键权衡→原理演示」；下面事实部分供核对，不要被 Writer 当目录照抄。

## 概念要点

- better-define 的转换入口把整段逻辑包在一个 `safeTry(async function*(){...})` 里——这是「可短路、可携带错误类型」的异步链：任何一步 `yield*` 失败都会立刻向外抛出，外层插件据此降级。源码位置: `packages/better-define/src/core/index.ts:24-38`
- 拿到运行时定义后，它把每个字段拼成 `{ type, required, default }`，整体包回 `defineProps(...)`，再用 magic-string 的 `overwriteNode` 覆盖掉原来的 `defineProps` 或 `withDefaults` 蜕。`required` 字段**仅在非生产环境**输出。源码位置: `packages/better-define/src/core/index.ts:44-77`
- 动态默认值分支：当 `withDefaults` 存在但其第二参无法被静态分析（`props.defaults` 为空）时，改用注入 helper `mergeDefaults(运行时对象, 动态默认值表达式)` 包裹——静态能拆就拆进每个字段、静态拆不动就整体合并。源码位置: `packages/better-define/src/core/index.ts:62-72`
- emits 的降级是**有损**的：只取事件名拼成字符串数组 `defineEmits(["evt1","evt2"])`，完全丢弃 payload 类型——因为 Vue 运行时本就不校验 emit 参数类型。源码位置: `packages/better-define/src/core/index.ts:83-92`
- `analyzeSFC` 是分析层入口：parse 出 scriptSetup body，构造根 `TSFile` 作用域（携带文件路径、内容、AST），遍历语句识别 `defineProps/withDefaults/defineEmits`，只处理「带类型参数」的那些（无类型参数的标 `// TODO: runtime` 直接跳过，留给 Vue 自己）。源码位置: `packages/api/src/vue/analyze.ts:55-105`
- 跨文件递归求值的核心是「引用解析器」：先做**栈式环检测**（同一 {作用域,类型} 二次命中即原样返回，防互递归类型死循环），再分类型处理——类型别名/括号类型递归剥内层、索引访问类型走专门分支、`Identifier/TSTypeReference` 走「名字解析」。源码位置: `packages/api/src/ts/resolve-reference.ts:55-105`
- 「名字解析」的本质是查作用域里的 `declarations` 表：先把当前作用域的 import/export/本地声明登记进表（`resolveTSNamespace`），再 `resolveTSScope(scope).declarations` 按名字逐段下钻（支持 `A.B` 命名空间）。查到的是另一个已解析类型，于是递归继续。源码位置: `packages/api/src/ts/resolve-reference.ts:86-105`
- 跨文件 import 的物理实现：`resolveTSNamespace` 遇到 `ImportDeclaration` → 用 `resolveDts` 把 import 字符串解析成磁盘真实路径 → `getTSFile` 读盘+parse+缓存 → 递归填好目标文件的 exports → 把导入符号登记进当前作用域的 declarations。源码位置: `packages/api/src/ts/namespace.ts:138-183`
- `resolveDts` 用 oxc-resolver，配置 `extensions: ['.d.ts', '.ts']`、`mainFields: ['types']`——即优先找类型声明文件；带两层缓存（路径解析缓存 + 文件缓存），并维护一张「被引用文件 → 引用者」反向表供 HMR 用。源码位置: `packages/api/src/ts/resolve-file.ts:24-53`
- 「TS 类型 → Vue 运行时构造器名」是一张映射表：字符串/数字/布尔关键字直映 `'String'/'Number'/'Boolean'`，字面量类型按其字面量种类映、命名引用（`Array/Function/Date/Promise…`）映其自身名、对象/接口映 `'Object'`（或叠加 `'Function'`）、union 各分支递归后去重、**未识别映 `'Unknown'`**。源码位置: `packages/api/src/vue/utils.ts:15-150`
- 运行时 prop 定义生成器在**生产环境或含 Unknown 时**只保留 `Boolean`（及伴随的 `String`）和 `Function` 的 type，其余 type 被擦除——即生产环境几乎无运行时校验；`skipCheck` 仅在「开发期 + 含 Unknown + 仍剩 Boolean/Function」时输出。源码位置: `packages/api/src/vue/utils.ts:157-189`
- 错误类型被收敛成一组字面量联合（`ErrorResolveTS/ErrorWithDefaults/ErrorUnknownNode`），`ResultAsync<T>` 即 `ResultAsync<T, Error>`——所有求值失败都是这组可枚举错误之一，最终在插件 `transform` 里 `.match(res => res, error => this.warn(error))` 被吞成 warn。源码位置: `packages/api/src/error.ts:1-18`、`packages/better-define/src/index.ts:54-62`
- 插件层 `enforce: 'pre'`，HMR 复用 `resolveDtsHMR`：改一个被 import 的类型文件 → 沿反向表递归找出所有引用它的 SFC 模块一并失效。源码位置: `packages/better-define/src/index.ts:50-70`、`packages/api/src/ts/resolve-file.ts:55-80`

## 关键调用链

```
transformBetterDefine(code,id)
  └─ analyzeSFC(s,sfc)                          // 识别宏 + 建根作用域
       ├─ handleTSPropsDefinition               // props: 带 addProp/setProp/removeProp/getRuntimeDefinitions
       │    └─ resolveDefinitions
       │         └─ resolveTSReferencedType     // ★ 跨文件递归求值 + 环检测
       │              ├─ resolveTSNamespace      //   解析 import/export，填 declarations 表
       │              │    └─ resolveDts(getTSFile) // 读盘定位 .d.ts/.ts
       │              ├─ resolveTSIndexedAccessType
       │              └─ (名字命中) → 递归回 resolveTSReferencedType
       │         └─ resolveTSProperties          // interface(含extends)/literal/intersection/mapped → 字段集合
       │              └─ resolveTypeElements
       └─ handleTSEmitsDefinition                // emits: 只取事件名，丢 payload
  └─ processProps: props.getRuntimeDefinitions()
       └─ inferRuntimeType                       // TS 类型 AST → ['String','Number',...]
       → genRuntimePropDefinition                // 拼成 {type,required,default}，生产环境擦除
       → s.overwriteNode(defineProps/withDefaults, 'defineProps({...})')
```
源码位置: `packages/better-define/src/core/index.ts:24-92`、`packages/api/src/vue/analyze.ts:43-225`

## 源码摘录（带行号，全文累计 ≤ 30 行）

拼装运行时对象并覆盖回 `defineProps`（演第 1 条权衡：类型降级为运行时选项）：

```ts
// packages/better-define/src/core/index.ts:44-59, 73-77
const runtimeDecls = `{\n  ${Object.entries(runtimeDefs)
  .map(([key, { type, required, default: defaultDecl }]) => {
    let defaultString = ''
    if (defaultDecl) defaultString = defaultDecl('default')
    const properties: string[] = []
    if (!isProduction) properties.push(`required: ${required}`)
    if (defaultString) properties.push(defaultString)
    return `${escapeKey(key)}: ${genRuntimePropDefinition(type, isProduction, properties)}`
  }).join(',\n  ')}\n}`
// ...
decl = `defineProps(${decl})`
s.overwriteNode(props.withDefaultsAst || props.definePropsAst, decl, { offset })
```

引用解析器的环检测 + 类型别名递归 + 名字解析（演第 3 条权衡：跨文件递归求值）：

```ts
// packages/api/src/ts/resolve-reference.ts:55-68, 86-105
const { scope, type } = ref
if (stacks.some((stack) => stack.scope === scope && stack.type === type)) {
  return ok(ref as any)            // ★ 环检测：互递归类型在此终止
}
stacks.push(ref)
switch (type.type) {
  case 'TSTypeAliasDeclaration':
  case 'TSParenthesizedType':
    return resolveTSReferencedType({ scope, type: type.typeAnnotation }, stacks) // 递归剥内层
// ...
// 名字解析：查 declarations 表逐段下钻
yield* resolveTSNamespace(scope)
const refNames = resolveIdentifier(/* TSTypeReference.typeName | Identifier */)
let resolved = resolveTSScope(scope).declarations!
for (const name of refNames) {
  if (isTSNamespace(resolved) && resolved[name]) resolved = resolved[name]
  else if (type.type === 'TSTypeReference') return ok({ type, scope })
}
return ok(resolved)
```

TS 关键字 → Vue 构造器名映射（演「类型求值的末端：类型→运行时名」）：

```ts
// packages/api/src/vue/utils.ts:21-29, 125-138
case 'TSStringKeyword':  return ok(['String'])
case 'TSNumberKeyword':  return ok(['Number'])
case 'TSBooleanKeyword': return ok(['Boolean'])
// ...
case 'TSUnionType': {                          // union: 各分支递归后去重
  const types: string[] = []
  for (const subType of node.type.types) {
    const resolved = yield* resolveTSReferencedType({ scope: node.scope, type: subType })
    types.push(...(resolved && !isTSNamespace(resolved) ? yield* inferRuntimeType(resolved) : ['null']))
  }
  return ok([...new Set(types)])
}
```

生产环境 type 擦除（演第 4 条权衡：生产期只留 Boolean/Function）：

```ts
// packages/api/src/vue/utils.ts:165-181
if (isProduction || hasUnknown) {
  types = types.filter((t) =>
    t === 'Boolean' || (hasBoolean && t === 'String') || t === 'Function')
  skipCheck = !isProduction && hasUnknown && types.length > 0
}
if (types.length > 0) type = types.length > 1 ? `[${types.join(', ')}]` : types[0]
```

## 易混淆 / 边界 / 推断

- **事实**：emits 降级是单向有损的——只生成事件名数组，payload 类型被完全丢弃；这与 props「完整求值」形成对比。源码位置: `packages/better-define/src/core/index.ts:83-92`、`packages/api/src/vue/emits.ts:188-193`
- **事实**：`Partial/Required/Readonly` 有内建 handler（翻转 `optional` 位），但 `Pick/Omit` 在代码里标注 `// TODO` 未实现；`TSIndexSignature`（索引签名）同样标注不支持。源码位置: `packages/api/src/vue/props.ts:56-85`、`packages/api/src/ts/resolve.ts:174-176`
- **事实**：union 类型合并时，若同名字段在不同分支里一个是 method、一个是 property，直接报错 `Union type contains different types of results`。源码位置: `packages/api/src/vue/props.ts:385-391`
- **事实**：`withDefaults` 默认值分两种——静态对象被拆成每字段 AST 内联进 `{ default }`；非静态（动态）则整体用注入的 `mergeDefaults` helper 包裹。源码位置: `packages/better-define/src/core/index.ts:62-72`、`packages/api/src/vue/props.ts:552-566`
- **推断（标注为推断）**：`required` 仅在非生产环境输出，推断动机是 `required:false` 主要服务于 Vue 开发期的「缺失必填 prop」warn，生产环境无意义、徒增体积；这与「生产环境擦除 type 校验」是同一思想的两面。
- **推断（标注为推断）**：`getRuntimeDefinitions` 被设计成「返回带闭包的操作对象（addProp/setProp/removeProp）」而非纯数据，推断是为了让 defineModels 等下游宏能复用同一份类型分析结果、往里追加 model 字段后再统一降级——这是 API 层被单独抽成 `@vue-macros/api` 的动机。
- **事实**：HMR 是跨文件类型解析的难点，靠 `referencedFiles` 反向表 + `resolveDtsHMR` 递归扩散失效模块解决；改一个 `.d.ts` 会让所有传递引用它的 SFC 重新转换。源码位置: `packages/api/src/ts/resolve-file.ts:8-17, 55-80`
- **未理解 / 边界**：`resolveTSNamespace` 对 `ExportAllDeclaration`（`export * from`）用 `Object.assign(exports, sourceScope.exports)`——若多个 re-export 存在同名符号，后者覆盖前者，未做冲突检测；这是否会引发静默的类型解析错误，未在测试中确认。
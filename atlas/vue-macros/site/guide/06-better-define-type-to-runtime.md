# better-define：把 TS 类型降级为运行时校验

> 本章属于 composite 层。前置：props/emit 宏的编译期重写与类型转换。
> 学完你能：讲清为什么 vue-macros 要在编译期自实现一个迷你类型求值器、把 TS 类型翻译成 Vue 运行时校验对象，以及它为此付出的几笔代价。

## 1. 为什么需要它

上一章讲 `defineModels`，让一个泛型字段同时落到 props 与 emits，把双向绑定收成一行 `defineModels<{...}>()` 写完。可无论是 `defineModels` 还是更基础的 `defineProps<T>()`，落到 Vue 编译器手里都有一个共同动作：**T 被擦掉**。

具体说，`defineProps<{ foo: string; bar?: number }>()` 在 Vue 编译期只剩两件事可做——抽出字段名 `foo`/`bar`、判断 `bar` 是不是可选；至于 `string` / `number` 这两个类型本身，编译完就没了。运行时拿到的 props 选项里压根没有 `type` 字段。

于是会出现这种尴尬：父组件传 `:foo="42"`，类型上当然报错；可如果你绕过去（动态拼 props、第三方组件包了一层、写测试时图省事），运行时**静默通过**，没有任何提醒。类型只活在编辑器里，运行时一无所知。

你想要的是反过来的承诺：**我写了一份类型，它就真的在运行时校验我**——改一处类型、运行时校验自动跟着变，不会两边漂移。`better-define` 就是来填这道鸿沟的。

> 跨章去重：第 4 章『props/emit 宏的编译期重写与类型转换』讲的是「把各种写法重写成原生宏」——`$defineProps` 改名、`ShortEmits` 展开，方向是「写法 → 原生宏」；本章讲的是「类型 → 运行时对象」，方向不同，别混。

## 2. 核心思想

把类型表达式**在编译期完整求值一遍**，把它「编译」成 Vue 运行时认识的 `{ type, required, default }` 对象，再整个塞回 `defineProps(...)` 的参数位置。类型由此成为运行时校验的**唯一真相来源**，而不是和运行时选项并列、要靠人手维护的第二份资料。

## 3. 心智模型

把 `defineProps<{ ... }>()` 的类型参数 T，从「要被擦除的标注」当成「要被求值的表达式」：

1. 在编译期拦下**带类型参数**的 `defineProps<T>()`（没有 T 的不处理，留给 Vue 自己）。
2. 把 T 当成一个需要展开的类型表达式，开始求值。
3. 遇到类型名字 → 先查当前文件的导入/声明表；名字来自别的文件 → 读盘解析那个文件、递归求值；带一张调用栈做环检测，防止 `A=B; B=A` 死循环。
4. 展开后的「字段集合」逐字段映射成 Vue 运行时构造器名（`String`/`Number`/`Boolean`/`Object`…），`optional` 翻成 `required: false`。
5. 拼成 `{ 字段: { type, required, default } }` 整体，覆盖回 `defineProps(...)`。
6. 任何一步失败 → 短路抛错 → 插件层降级为 warn，原 `defineProps` 一字不改。

step 3 的「读盘」是这件事最难的地方——一个看起来人畜无害的 `import type { User } from './user'` 就触发了一次磁盘读、一次递归 parse、一次对 `User` 的求值；如果 `User` 又 import 了别的，递归还会继续下去。

## 4. 关键权衡

### 类型当唯一真相来源，换来永不漂移的代价是自实现类型求值器

最大的取舍是**不让用户双写「类型 + 运行时选项」**。原生 Vue 里你只能要么写运行时选项 `defineProps({ foo: { type: String, required: true } })`、要么写纯类型 `defineProps<{ foo: string }>()`——前者运行时校验齐全但类型不漂亮，后者类型漂亮但运行时失忆。`better-define` 选第三条路：你只写类型，运行时选项由它**自动派生**。

换来的是「改类型即改校验」，两侧永远不可能漂移；代价是它必须在编译期**自己实现一个迷你的、能跨文件的类型求值器**——递归展开类型别名、interface 继承、`Partial<>` 等组合，复杂度极高、且必须异步。

本质矛盾是「**单一真相 vs 实现成本**」：要消灭双写，就得有东西替你把类型翻译成运行时；这个翻译器不可能依赖 tsc 暴露的 API（tsc 不提供这种半截求值），只能自己写一份。这是同一类问题的通解骨架——所有「让声明成为唯一真相」的设计（GraphQL schema → 类型、SQL schema → ORM 实体）都要跨过同一道坎。

### 失败即降级，换来「不挡路」的代价是可能静默退化

第二条取舍是当类型求值遇到任何一步失败——遇到不支持的语法、解析不到的 import、互相递归的类型——它**整体短路**返回错误，插件层把错误吞成一条 `warn`，**原 `defineProps` 原封不动保留**。

换来的是「绝不挡路」：你工程里塞了个 weird 的边缘类型，better-define 不会让你的构建挂掉，只是这一处 props 退化为无运行时校验；代价是用户**无法保证「我的 props 一定被运行时校验了」**——它可能静默退化为无校验，warn 是否被看到全靠自觉。本质矛盾是「**严格性 vs 可用性**」，所有「尽力而为」型静态分析工具（ESLint autofix、Prettier 容错）都站在同一侧。

### 跨文件递归求值换类型系统的真覆盖，代价是三层缓存外加反向表

第三条取舍是支持**跨文件**递归求值——`import type` 拉到的类型也要展开、命名空间要下钻、`A extends B` 要追到 B、`Partial/Required/Readonly` 要按可选位翻转。

换来的是真正覆盖 TS 类型系统的常见组合，而不只是「同一个文件里的对象字面量」；代价是磁盘读 + 递归 parse 的开销巨大，**必须叠三层缓存**（已解析文件缓存、import 路径解析缓存、调用栈环检测），外加一张「被引用文件 → 引用者」反向表来支撑 HMR——改一个 `.d.ts`，要能顺着反向表找出所有传递引用它的 SFC 全部失效，否则增量成本不可接受。

本质矛盾是「**类型系统的覆盖度 vs 工程成本**」：覆盖越真，越要在编译期重做 TS 编译器的一部分工作，越要担心缓存失效与 HMR 一致性。这也是为什么 `better-define` 的实现大量被抽到独立的 `@vue-macros/api` 包——这些缓存、求值、反向表都是可被多个宏复用的基础设施。

### 生产环境几乎擦除运行时校验，换来零开销代价是它主要只服务开发期

第四条取舍有点反直觉：尽管 `better-define` 辛辛苦苦把类型降级成了运行时校验，**到了生产环境它几乎把 `type` 字段全擦掉了**——只保留 `Boolean`（影响 v-model 与未传参默认值）和 `Function`（影响事件绑定），其余 `String/Number/Object` 一律不留。

换来的是生产包零校验开销——`String` 校验对业务无实质保护（你不会真靠它 catch bug，那是测试的工作），徒增体积；代价是这个机制的运行时校验**主要只服务开发期**，生产环境基本退化。本质矛盾是「**校验的真正价值在哪里**」——它不在生产（生产要快、要小），而在开发期的「早点看到错误」。这条与上一条权衡站在同一侧：better-define 是开发期的护栏，不是生产的防线。

## 5. 最小原理演示

下面这段几十行的脚本，演两件事：**把类型字面量翻译成运行时对象**、**求值失败时短路返回错误让调用方降级**。每一行都对应上面某个原理点；不演示原理的实现细节（跨文件 import、环检测、生产期 type 擦除）一律略去。

```ts
import { parse } from '@babel/parser'

// 极简映射表：TS 类型关键字 → Vue 运行时构造器名
const KEYWORD_TO_CTOR: Record<string, string> = {
  TSStringKeyword: 'String',
  TSNumberKeyword: 'Number',
  TSBooleanKeyword: 'Boolean',
}

// 把一个 TSTypeLiteral 拆成字段集合；遇到不支持的节点就抛错，
// 让上层调用方决定怎么降级
function resolveTypeLiteral(node: any) {
  if (node.type !== 'TSTypeLiteral') {
    throw new Error(`unsupported type node: ${node.type}`)
  }
  const fields: Record<string, { type: string; required: boolean }> = {}
  for (const member of node.members) {
    // optional 标记挂在成员上（对应 foo? 的 questionToken）
    const required = !member.optional
    const keyword = member.typeAnnotation.typeAnnotation.type
    const ctor = KEYWORD_TO_CTOR[keyword]
    if (!ctor) {
      throw new Error(`unsupported keyword: ${keyword}`)
    }
    fields[member.key.name] = { type: ctor, required }
  }
  return fields
}

function genRuntimeObject(fields: Record<string, any>) {
  const inner = Object.entries(fields)
    .map(([k, v]) => `  ${k}: { type: ${v.type}, required: ${v.required} }`)
    .join(',\n')
  return `{\n${inner}\n}`
}

// 主入口：求值成功返回改写后的代码；失败返回 null，由调用方决定降级
function tryCompileBetterDefine(code: string): string | null {
  const ast = parse(code, { plugins: ['typescript'] })
  for (const stmt of ast.program.body) {
    // 只识别 `const xxx = defineProps<{...}>()` 这一种形态
    if (stmt.type !== 'VariableDeclaration') continue
    const decl = stmt.declarations[0]
    if (!decl || decl.init?.type !== 'CallExpression') continue
    const call = decl.init
    if (call.callee.type !== 'Identifier' || call.callee.name !== 'defineProps') continue
    const typeParam = call.typeParameters?.params[0]
    if (!typeParam) continue  // 无类型参数的不处理，留给 Vue 自己

    try {
      // 把类型参数当成「要被求值的表达式」，而不是要被擦除的标注
      const fields = resolveTypeLiteral(typeParam)
      const runtimeObj = genRuntimeObject(fields)
      const propsName = decl.id.name
      return `const ${propsName} = defineProps(${runtimeObj})`
    } catch (e) {
      // 失败即降级：调用方拿到 null，决定 warn + 原样保留
      console.warn(`[better-define] ${(e as Error).message}, fallback to original`)
      return null
    }
  }
  return null
}

// 成功路径：类型字面量被完整求值成运行时对象
console.log(tryCompileBetterDefine(
  `const props = defineProps<{ foo: string; bar?: number }>()`
))
// const props = defineProps({
//   foo: { type: String, required: true },
//   bar: { type: Number, required: false }
// })

// 失败降级路径：含未识别的 TSTypeReference（SomeThing），求值短路
const r = tryCompileBetterDefine(
  `const props = defineProps<{ foo: SomeThing }>()`
)
console.log(r)  // null，并打印一条 warn
```

这段脚本和真实 `better-define` 的距离在于：真实版本会用 `safeTry + ResultAsync` 把「失败即降级」做成异步短路链、用 `@vue-macros/api` 的 `resolveTSReferencedType` 做跨文件递归求值、用三层缓存支撑增量构建、在生产环境还会进一步擦除 `type` 字段。上面这段只演透主干——「**类型 AST → 运行时对象 + 失败降级**」。

## 6. 执行轨迹

输入字符串：`const props = defineProps<{ foo: string; bar?: number }>()`

走读一遍：

1. **拦截**：parser 把字符串切成 AST，遍历顶层语句命中一条 `VariableDeclaration`，其 init 是 `CallExpression`、callee 是 `defineProps`、`typeParameters.params[0]` 存在——这是个「带类型参数的 defineProps」，进入处理。
2. **求值类型**：`typeParameters.params[0]` 是个 `TSTypeLiteral`，遍历它的 `members`：
   - `foo: string` → `optional: false`、关键字 `TSStringKeyword` 映射到 `'String'`、`required: true`
   - `bar?: number` → `optional: true`、关键字 `TSNumberKeyword` 映射到 `'Number'`、`required: false`
3. **拼装**：字段集合 `{ foo: { type: 'String', required: true }, bar: { type: 'Number', required: false } }` 被序列化成运行时对象字面量。
4. **覆盖**：原 `defineProps<{...}>()` 被改写为 `defineProps({ foo: {...}, bar: {...} })`，用 magic-string 的 `overwriteNode` 整段盖回去。

输出字符串：

```ts
const props = defineProps({
  foo: { type: String, required: true },
  bar: { type: Number, required: false },
})
```

如果输入里混进解析不了的符号（比如 `foo: SomeThing`），step 2 求值到 `TSTypeReference` 时分支不匹配，立即抛 `unsupported type node: TSTypeReference`；上层 catch 后打印 warn 并返回 `null`，最终输出 = 输入原样保留。

## 7. 教学简化说明

本章演示故意省略了：跨文件 import 解析（`@vue-macros/api` 的 `resolveTSNamespace` + `resolveDts`）、栈式环检测、union/intersection/interface extends、`Partial<>` 等内建工具类型的 handler、`withDefaults` 静态/动态默认值的分支、生产环境 `type` 字段擦除（只留 `Boolean/Function`）、emits 降级（有损、只取事件名）、HMR 反向依赖表的递归失效——这些是把原理撑大的工程化部分，主干只演「类型 AST → 运行时对象 + 失败降级」。

## 8. 小结

`better-define` 把「类型只活在编辑器里」这件事翻过来了：编译期替你把类型表达式求值一遍、降级成 Vue 运行时认识的 `{ type, required, default }` 对象，让类型成为运行时校验的唯一真相来源。这套机制的本质是**自实现一个迷你类型求值器**——失败即降级、跨文件递归、生产期擦除 type，都是为了在「单一真相」的承诺下控制成本与开销。

但有些场景你要的不仅是「类型校验在运行时也生效」，还想要「写赋值语句时不用每次都 `.value`」——下一章就接着讲怎么把 `.value` 在编译期偷偷塞回去。
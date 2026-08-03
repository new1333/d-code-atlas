# better-define：把 TS 类型降级为运行时校验

你在 Vue 里大概写过这样的代码：

```ts
const props = defineProps<{ foo: string; bar?: number }>()
```

某天，父组件手滑传了个 `:foo="123"`——一个数字。你满心以为 Vue 会在控制台甩你一脸红色警告，结果什么都没发生：组件照常渲染，`props.foo` 老老实实接住了 `123`，那个 `string` 类型就像没写过一样。

为什么会这样？因为原生 `defineProps` 的类型参数 `<T>` 是一份**纯编译期产物**。TypeScript 编译完，它就被擦掉了，运行时根本看不到。Vue 自己能从这份类型里抽出来的，只有「有哪些字段名」「哪个是可选的」这点信息，拼成一个最小化的 props 选项——注意，里面**没有 `type` 字段**。没有 `type`，运行时就失去了校验依据，传错类型只能装没看见。

better-define 要补的就是这道缺口：在编译期把整份类型**完整求值一遍**，翻成 Vue 运行时认识的 `{ type, required, default }` 对象，再覆盖回去。一句话——**让类型成为运行时校验的唯一真相来源**。

> 顺带交代一句来路：到本章这一步，各种顺手的写法（比如 `$defineProps`、`ShortEmits` 那一族）已经在前一章被统一改写成标准的 `defineProps<T>()` 了。那是「写法 → 原生宏」的重写，已经讲过。本章不碰写法重写，只做写法重写之后的下一个动作：**把 `<T>` 本身降级成运行时对象**。

## 最末端的一步：TS 关键字到 Vue 构造器的翻译表

先从最小的一块讲起。不管类型有多复杂，求值到最后，每个字段都会落在一个具体的「类型节点」上。比如 `foo: string` 里的 `string`，在 TS 的语法树里是一个 `TSStringKeyword` 节点。better-define 做的最末端的事，就是拿着一张**翻译表**，把这种 TS 关键字翻译成 Vue 运行时认得的构造器名：

```
TSStringKeyword   → 'String'
TSNumberKeyword   → 'Number'
TSBooleanKeyword  → 'Boolean'
字面量类型        → 按字面量种类映
Array/Function/Date/Promise 等命名引用 → 映自身名字
对象/接口         → 'Object'（若是可调用对象再叠一个 'Function'）
……实在认不出来   → 'Unknown'
```

这张表是整个机制的「出口」。前面所有复杂的求值，都是为了把字段推到能查这张表的程度。`optional`（`bar?: number` 里那个问号）则单独翻译成 `required: false`。拿到了 `{ type, required }`，一个字段的运行时定义就齐了。

## 把类型当成「表达式」来求值

但真实的类型很少乖乖躺在原地等你翻译。你写的往往是这些：

```ts
type Props = { foo: string; bar?: number }
const props = defineProps<Props>()

// 或者跨文件
import type { SharedProps } from './types'
const props = defineProps<SharedProps & { extra: boolean }>()
```

`Props`、`SharedProps` 都只是名字，光看名字你翻译不出任何东西。所以求值器不能把类型当成「标注」扫一眼就过，得把它当成一个**需要被求值的表达式**：看到名字就去查它的定义，查到的如果是另一个名字，就继续追下去，直到追到能上翻译表的具体关键字为止。

这个「顺着名字一路追」的过程，分几种情况：

- **类型别名 / 括号类型**：`type A = B`、`type A = (B)`——直接剥掉外壳，对内层重新求值。像拆套娃，拆到最里面那层为止。
- **`A extends B`、`Partial<>` 等组合**：要把父类型、被修饰的类型先求值出来，再做合并或翻转（`Partial` 干的事就是把所有字段翻成可选）。
- **跨文件的 `import type`**：看到名字来自别的文件，就得去磁盘上把那个文件找出来、解析它、在它的导出里找到这个名字的定义，再带回来继续求值。

类比一下：这套机制就像一个会顺藤摸瓜的侦探。看到一个不在本地的名字，就跑去别的文件档案柜里翻；翻到的资料里如果又指向另一个名字，就接着追。一直追到「现场实物」（能上翻译表的关键字）为止。

### 绕圈怎么办：栈式环检测

侦探最怕遇到死循环：`type A = B; type B = A`，追着追着又回到原点，永远停不下来。better-define 的做法很朴素——**走迷宫时沿路撒面包屑**：维护一个调用栈，每追一层就把「当前作用域 + 当前类型」记下来；一旦发现自己又要处理一个已经记过的组合，就立刻返回、不再往下追。互递归的类型就在这里被掐断，不会把构建卡死。

跨文件追类型还有个现实难题：每次都要读盘 + 重新 parse 一个文件，开销不小。所以这套求值叠了三层缓存——「文件解析过的就不再 parse」「import 路径解析过的就不再算」「调用栈本身就兼任环检测」——还额外维护一张「被引用的文件 → 哪些 SFC 引用了它」的反向表，专门给 HMR 用：你改了一个被到处 `import type` 的 `.d.ts`，构建器要顺着这张表把所有受牵连的组件都标成「需要重新转换」。

## 拼装运行时对象，覆盖回去

字段都求值完了，接下来就是拼装。把每个字段拼成 `{ type: String, required: true }` 这样的片段，整体包成一个大对象，再用字符串 `defineProps({...})` 裹起来。最后一步，是用增量编辑工具把这个新串覆盖掉源码里原来的 `defineProps<T>()` 那一段——原文长什么样不重要，重要的是偏移位置准、sourcemap 不丢。

整个转换在流程上是这样走的：

```
defineProps<{ foo: string; bar?: number }>()
   │
   ├─ 识别「带类型参数」的 defineProps（没类型参数的不管，留给 Vue 自己）
   ├─ 把类型参数当表达式求值（递归展开别名/extends/跨文件 import + 环检测）
   │     → 得到字段集合 { foo:{字符串,必填}, bar:{数字,可选} }
   ├─ 逐字段查翻译表 → { type:'String', required:true } / { type:'Number', required:false }
   ├─ 拼成 defineProps({ foo:{...}, bar:{...} })
   └─ 覆盖原文
```

有个小细节值得注意：`required` 字段**只在非生产环境输出**。生产包里它会被省掉。道理很简单——`required: false` 主要是为了让 Vue 在开发期对你喊一句「这个必填 prop 你忘传了」，线上没人看这警告，留着纯属多余体积。

## 失败即降级：求值任何一步崩了，就当没这回事

到这里你可能已经咂摸出问题来了：上面这套求值，又是跨文件读盘、又是递归展开、又要处理各种 TS 怪语法——哪一步出了岔子怎么办？比如用户类型里塞了个 `Partial<Omit<X, 'a'>>`，而 `Omit` 这套工具类型还**没实现**，求值器追到这里就只能干瞪眼。

better-define 的选择非常明确：**整体包在一个「可短路」的异步链里**。任何一步 `yield` 出错，立刻向外抛，整条求值链瞬间作废。外层插件接到这个错误，不抛异常、不停构建，而是把它收敛成一条 `warn` 打到控制台，然后——**原来的 `defineProps<T>()` 一个字都不改地保留**。

类比一下，这就像电路里的保险丝：任何一处短路，整条链立刻断电，绝不让一个坏掉的部分把整栋楼（整个构建）拖垮。求值失败 = 类型降级失败 = 这一行的宏原样留着 = 退回「Vue 原生的、不校验类型的」行为。

## 关键权衡

这一节是本章真正想交付的东西。better-define 看似只是「把类型翻成对象」，背后却有四条很实的设计取舍。

**一、让类型成为运行时校验的唯一真相来源。** 旧办法是双写：写一遍类型、再写一遍运行时选项（`defineProps({ foo: { type: String, required: true } })`），靠人去对齐。better-define 选了另一条路——**只认类型这一处**，运行时校验完全从类型派生出来。

- **换来**：改一处类型，编译期自动重新派生出对应的运行时校验，两侧永不漂移。就像一份菜谱既是备料清单、又是成品验收单，改了菜谱两边自动跟着变，省掉了一份对账表。
- **代价**：你必须在编译期自己实现一个**迷你的类型求值器**——能递归展开别名、处理 interface 继承、`Partial/Required/Readonly` 这些组合、还能跨文件追 `import type`。这是相当高的一坨复杂度，而且因为要读盘，**整个过程必须是异步的**。代价全砸在了「编译期要重造半个类型系统」上。

**二、尽力而为、失败即降级。** 求值器遇到任何不支持的语法、解析不到的 import、互相递归的类型，就整体短路、原 `defineProps` 一字不动，插件层把错误吞成一条 `warn`。

- **换来**：插件的健壮性。用户的类型里混了再怪的写法，构建也绝不会因此炸掉，最坏不过「这行宏没生效」。
- **代价**：用户**没法保证**「我写的 props 一定被运行时校验了」。可能某天你引入了一个它解析不了的类型组合，校验就悄悄退化成「无校验」，而那条 warn 你不主动看控制台就根本不知道。安全网有，但不是兜底的——它默认你是会看 warn 的人。

**三、跨文件递归求值 + 栈式环检测。** 选择支持 `import type` 跨文件取类型、命名空间下钻（`A.B.C`）、`extends`、`Partial/Required/Readonly` 的任意嵌套组合。

- **换来**：类型可以像正常写 TS 一样拆到别的文件、按命名空间组织，better-define 照样追得到，不逼你把所有类型堆进单文件。
- **代价**：磁盘读 + 递归 parse 的开销巨大，必须**叠三层缓存**（已解析文件缓存、import 路径解析缓存、调用栈环检测），再外加一张「被引用文件 → 引用者」的反向表来支撑 HMR。少任何一层，增量构建的成本都会不可接受——改一个类型文件就要全量重算。复杂度的大头都花在了「让跨文件这件事在工程上可用」。

**四、生产环境几乎擦除运行时类型校验。** 到了生产包，除了 `Boolean`（及它常伴随的 `String`）和 `Function` 之外，其余 `type` 字段几乎全被删掉。

- **换来**：生产包零校验开销。`String`/`Number` 这类校验对线上业务没有实质保护——真能传错类型的 bug 在开发期早该被它揪出来了，到生产还留着只会徒增体积和一点点 CPU。
- **代价**：这套机制的运行时校验**主要只服务开发期**，生产环境基本退化成「只保留和语义强相关的最小集合」。`Boolean` 之所以必留，是因为它直接影响 `v-model` 和「未传参时的默认值」行为；`Function` 必留是因为它影响事件绑定的判定。剩下的，生产环境一律不信任。

## 原理演示

下面这段脚本从零演示主干：输入一段含 `defineProps<T>()` 的 setup 字符串，把内联类型字面量求值成运行时对象并覆盖原文；遇到认不出的类型，求值短路、外层降级为 warn 并保留原文。它只演「类型 AST → 运行时对象」这条主干 + 失败降级，刻意省略了跨文件 import、环检测、`Partial<>`、生产期擦除这些工程化部分——载体服务于演透原理，不服务于工程完整。

```ts
import { parse } from '@babel/parser'

// 翻译表：TS 关键字节点 → Vue 运行时构造器名
const TYPE_MAP: Record<string, string> = {
  TSStringKeyword: 'String',
  TSNumberKeyword: 'Number',
  TSBooleanKeyword: 'Boolean',
}

// 求值一个「类型字面量」节点，返回字段集合；遇到不认识的类型直接抛错（短路点）
function evalTypeLiteral(node: any) {
  const fields: Array<{ name: string; ctor: string; optional: boolean }> = []
  for (const member of node.members) {
    const keyNode = member.key
    const name = keyNode.type === 'Identifier' ? keyNode.name : keyNode.value
    const kind = member.typeAnnotation.typeAnnotation.type
    const ctor = TYPE_MAP[kind]
    if (!ctor) throw new Error(`unsupported type node: ${kind}`) // ★ 短路
    fields.push({ name, ctor, optional: !!member.optional })
  }
  return fields
}

// 字段集合 → 运行时对象字符串
function genRuntimeProps(fields: any[]) {
  const body = fields
    .map(f => `  ${f.name}: { type: ${f.ctor}, required: ${!f.optional} }`)
    .join(',\n')
  return `defineProps({\n${body}\n})`
}

// 转换器：拦下「带类型参数」的 defineProps，求值→覆盖；失败则降级为 warn + 保留原文
function transformBetterDefine(code: string): string {
  const ast = parse(code, { plugins: ['typescript'], sourceType: 'module' })
  for (const stmt of ast.program.body) {
    if (stmt.type !== 'VariableDeclaration') continue
    for (const decl of stmt.declarations) {
      const init = decl.init
      if (
        init?.type === 'CallExpression' &&
        init.callee.type === 'Identifier' &&
        init.callee.name === 'defineProps' &&
        init.typeParameters?.params[0] &&
        init.typeParameters.params[0].type === 'TSTypeLiteral'
      ) {
        try {
          const fields = evalTypeLiteral(init.typeParameters.params[0])
          const runtime = genRuntimeProps(fields)
          return code.slice(0, init.start!) + runtime + code.slice(init.end!)
        } catch (e) {
          console.warn(`[better-define] ${(e as Error).message}, 保留原文`)
          return code
        }
      }
    }
  }
  return code
}

// —— 演示 1：正常降级 ——
console.log(transformBetterDefine(
  `const props = defineProps<{ foo: string; bar?: number }>()`
))
// 输出：
// const props = defineProps({
//   foo: { type: String, required: true },
//   bar: { type: Number, required: false }
// })

// —— 演示 2：遇到认不出的类型（一个外部引用），失败降级 ——
console.log(transformBetterDefine(
  `const props = defineProps<{ foo: SomeImportedThing }>()`
))
// 输出：
// [better-define] unsupported type node: TSTypeReference, 保留原文
// const props = defineProps<{ foo: SomeImportedThing }>()
```

第一段演示对应权衡一：类型被完整翻译成了运行时对象，`optional` 变成了 `required: false`，原文被覆盖。第二段演示对应权衡二：`SomeImportedThing` 是一个 `TSTypeReference`，不在翻译表里，求值在 `evalTypeLiteral` 里抛错短路，外层 `catch` 把它降级成 warn，原代码原封不动地留了下来。真仓库里这一步短路是异步链里的 `yield`，外层插件把它收敛成 warn——结构完全一致，只是真仓库还要处理异步和跨文件。

## 小结

better-define 解决的是「类型活在编辑器里、运行时失忆」这道鸿沟。它的全部工作可以压缩成一句：**在编译期把类型表达式求值一遍，翻成 Vue 运行时认得的对象，覆盖回去**。围绕这一句，它做了四条取舍——用「类型作为唯一真相来源」换永不漂移、用「尽力而为 + 失败降级」换构建健壮性、用「跨文件递归 + 三层缓存 + 环检测」换类型可以正常拆文件、用「生产期擦除校验」换零体积开销。每一条都是「选了 A、换来 B、付出 C」。

记住它的边界：这套运行时校验**主要服务开发期**，而且**不是兜底的**——类型一旦复杂到求值器追不动，它会悄悄退回无校验，只在控制台留一条 warn。用它的前提，是你愿意偶尔看一眼那条 warn。

讲到这里，我们一直在解决「声明出来的东西，怎么落到运行时」。下一章《响应式语法糖：赋值即 `.value`》会换个方向——它要解决的是「声明出来的响应式变量，怎么写起来不像响应式」：让你对 `$ref` 声明的变量直接赋值，编译期悄悄把这个赋值改写成 `.value` 访问，从而丢掉那满屏的 `.value`。
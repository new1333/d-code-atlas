# `<script setup>` 与内置宏：编译器替你写完那套样板

> 本章属于 primitive 层。前置：编译期宏的本质。
> 学完你能用一句话讲清：Vue 为什么把那组 `define*` 宏硬编码进官方编译器、它们去糖成什么形状，以及这个决定为什么反过来逼出了一个叫 Vue Macros 的项目。

## 1. 为什么需要它：接线样板拖累了 Composition API

上一章讲了「编译期宏」这个概念——它是只在编译期存在、运行时被擦得干干净净的伪函数，用编译期变换换来了零运行时开销和更声明式的写法。但那个回答留下了一个具体的口子：Vue 官方到底内置了哪几个宏？它们把用户写的代码变成什么形状？又为什么非得「内置」、没法让用户自己加？这一章就接这个口子。

回到还没有 `<script setup>` 的年代。用 Composition API 写一个组件，你得套三层跟业务无关的壳：

```js
export default defineComponent({
  props: { msg: String },           // 声明①：props 单独写在选项里
  emits: ['update'],                // 声明②：emits 也单独写
  setup(props, { emit }) {
    const count = ref(0)            // 业务逻辑
    function inc() { count.value++ }
    return { count, inc }           // 声明③：模板要用什么，逐个塞进 return
  }
})
```

每个组件都得写 `setup` 包装函数、把模板要用的变量逐个塞进 `return`、再把 props 和 emits 单独声明到选项里。组件一多，这套跟业务无关的「接线」重复得让人发麻，Composition API 本该有的简洁被这层脚手架抵消了大半。`<script setup>` 就是为消灭这三件接线样板而生的。

## 2. 核心思想：把声明式语法「去糖」成等价的 setup()

`<script setup>` 解决接线样板的方式不是给你一套更短的 API，而是让编译器替你把样板写完。你写的声明式代码，会被逐行「去糖（desugar）」成等价的 `setup() { return {...} }` 加上组件 options。你只声明「想要什么」，编译器生成「怎么接进 Vue 运行时」的全部接线。

去糖这个词，可以想象成把一块压缩毛巾泡进水里：它本是紧凑的一小块（声明式源码），泡开后展开成完整的一大块（运行时实际需要的形态）。形状、功能都没变，只是从紧凑写法展开成了运行时要的样子。

## 3. 心智模型：一张绑定表撑起整个去糖

去糖的过程可以拆成几步，核心是编译器在内存里维护的一张「绑定表」：

1. 你在 `<script setup>` 顶层写普通的 JS/TS（变量、函数、import）。
2. 编译器遍历这段顶层代码，把所有顶层绑定登记进一张表，记下名字和种类（普通常量、ref、函数）。
3. 命中 `define*` 宏调用时，按这个宏的硬编码规则改写：props 类宏抽成选项层的声明；expose 类宏抽成 setup 返回的 exposed 对象；model 类宏同时生成选项层声明和一个本地代理 ref。
4. 把绑定表里的顶层绑定自动塞进生成的 `setup()` 返回对象，模板就能看见它们了。
5. 模板被编译成 render 函数，直接内联进 `setup()` 的闭包，复用同一批绑定。
6. 宏调用本身在最终产物里被删得干干净净，它们从头到尾只是给编译器看的变换提示。

整条流程的灵魂就是那张绑定表：它让「顶层写什么」和「模板能用什么」自动对齐，不用你手写 `return` 去维护这层对应关系。

## 4. 关键权衡（本章重头戏）

这套机制看着顺手，背后是几个有得有失的决定。

### 4.1 硬编码固定宏：开箱即用，但别想自己加

Vue 选择把 `defineProps`、`defineEmits`、`defineModel` 这一组宏直接硬编码在官方编译器里，而不是做成可扩展的插件。

- **选择**：固定一组宏、行为写死在编译器里。
- **换来**：零运行时开销（宏都被擦了）、零配置（不用 import）、跨所有 Vue 项目行为完全统一。
- **代价**：宏的语义彻底由官方说了算，用户既不能加新宏，也不能改现有宏的行为。官方在 issue 里明确表态过，自定义宏的实现复杂度目前太高，暂不提供公开 API。

**本质矛盾**：是「开箱即用的统一性」和「可扩展性」在打架。选了前者，就得接受后者被锁死。而这个被锁死的口子，正是本书主角 Vue Macros 之所以存在的原因——既然官方编译器不让你加宏，那就绕到编译管线外面自己加。

### 4.2 顶层自动暴露给模板：方便了模板，就关紧了后门

编译器选择把 `<script setup>` 的顶层绑定自动塞进 `return`，让模板直接能用。

- **选择**：顶层绑定自动暴露给自身模板。
- **换来**：彻底消灭手写 `return { ... }`。
- **代价**：组件实例对父组件改成默认关闭。父组件通过 template ref 或 `$parent` 拿到的实例，看不见任何内部绑定，必须用 `defineExpose` 显式点名才能暴露。

这里有个反直觉的对称设计：「暴露给模板」和「暴露给父组件 ref」这两条通道，默认值正好相反，模板全开、父组件全关。

**本质矛盾**：是「便利」和「封装」在打架。模板要看见内部状态才方便渲染，这是组件自己的事，全开无妨；但父组件能不能戳到内部，是封装边界问题，默认关紧才能防止组件实现被外部耦合。一条通道管「对内自洽」，另一条管「对外有界」，所以默认值才得反过来。

### 4.3 长得像函数，却没有函数的本事

宏调用在写法上跟普通函数一模一样（`defineProps(['msg'])`），但上一章讲过，它根本没有函数语义，运行时不存在这次调用。本章只补一个新侧面：这个决定直接限制了宏能怎么用。

- **选择**：让宏调用在写法上像函数。
- **换来**：最小的学习成本，照着函数写就行，不用学新语法。
- **代价**：宏不能放进 `if` 里按分支调用，不能搬进 composable 函数里复用，也不能被普通 JS 工具当函数来分析。它只活在 `<script setup>` 这个被编译器识别的上下文里，脱离这个上下文就退化成一个未定义的标识符。

**本质矛盾**：是「借函数的写法降低学习门槛」和「保住函数的组合复用能力」在打架。借了写法的壳，就丢了函数能被自由组合的魂。这也是为什么 Vue Macros 后来要专门下功夫做宏的组合化：内置宏的这套约束，恰恰是工程上最疼的地方。

### 4.4 defineModel：一个宏顶三件套，代价是去糖变重

双向绑定过去要手写三件套：一个 prop 声明、一个 emit 声明、一个本地 ref（读时取 prop、写时 emit）。`defineModel()` 把这三件缩成一行。

- **选择**：用一个宏同时声明 prop + emit + 本地代理 ref。
- **换来**：双向绑定从三件套缩成一行，心智负担大幅下降。
- **代价**：这个宏的去糖规则明显比 `defineProps` 重，它要生成一个带 `get`/`set` 的代理 ref：`get` 时读 prop 值，`set` 时触发 emit。展开逻辑非平凡，反过来也抬高了「用户想自造一个类似宏」的门槛。

**本质矛盾**：是「源码尽可能简洁」和「去糖规则尽可能简单」在打架。宏能承载的模式越重，源码就越短，但去糖器的实现、以及用户模仿它的成本就越高。这条权衡恰好说明，去糖不只是机械替换文本，它能承载真正非平凡的语义改写。

## 5. 最小原理演示：40 行去糖器

下面这段代码不追求复刻官方编译器，只演透「去糖」这一个动作：它把声明式的顶层语句，变成等价的 `setup()` 返回结构加选项层声明。三个带圈序号分别对应上面心智模型的第 2、3、4 步。

```ts
// 简化的「<script setup> 去糖器」
// 输入：顶层语句列表，每条用最小节点描述（名字 + 种类 + 可选的宏信息）
// 输出：等价的 setup() 返回结构 + 选项层声明

type BindingKind = 'const' | 'ref' | 'fn'
type MacroKind = 'props' | 'emit' | 'expose'

interface TopStatement {
  name: string
  kind: BindingKind
  macro?: MacroKind        // 命中宏调用时填，如 props 宏
  macroArg?: string[]      // 宏的参数，如 defineProps(['msg']) 的 ['msg']
}

interface DesugarResult {
  options: Record<string, string[]>   // 选项层声明（props / emits）
  setupReturn: string[]               // setup() 返回的绑定名
  exposed: string[]                   // defineExpose 暴露给父组件的
}

function desugarScriptSetup(stmts: TopStatement[]): DesugarResult {
  const bindings: Record<string, BindingKind> = {}   // ① 绑定表
  const options: Record<string, string[]> = {}
  const exposed: string[] = []

  for (const s of stmts) {
    if (s.macro) {                                   // ② 命中宏调用，按硬编码规则改写
      if (s.macro === 'props')  options.props  = s.macroArg ?? []
      if (s.macro === 'emit')   options.emits = s.macroArg ?? []
      if (s.macro === 'expose') exposed.push(...(s.macroArg ?? []))
      continue                                       // 宏产物归选项层/exposed，调用节点删掉
    }
    bindings[s.name] = s.kind
  }

  const setupReturn = Object.keys(bindings)          // ③ 用绑定表生成 return
  return { options, setupReturn, exposed }
}
```

三步一一对应：第 ① 步建绑定表，第 ② 步识别宏调用并改写成选项层或 exposed，第 ③ 步用绑定表生成 return。宏调用在循环里走的是 `continue` 分支，等于在最终产物里被删掉——这就是「运行时不存在」在代码里的落点。

## 6. 执行轨迹：拿一段真实写法走一遍

输入是这段声明式源码：

```js
// <script setup>
const props = defineProps(['msg'])
const count = ref(0)
function inc() { count.value++ }
```

去糖器把它表达成这样一个语句列表（伪节点）：

```
[ {name:'props', kind:'const', macro:'props', macroArg:['msg']},
  {name:'count', kind:'ref'},
  {name:'inc',   kind:'fn'} ]
```

跑一遍 `desugarScriptSetup`，中间态和产物如下：

| 步骤 | 状态 |
|------|------|
| 遍历完 props 语句 | 选项层 `{ props: ['msg'] }`，绑定表 `{}` |
| 遍历完 count | 绑定表 `{ count: 'ref' }` |
| 遍历完 inc | 绑定表 `{ count: 'ref', inc: 'fn' }` |
| 生成 return | `setupReturn: ['count', 'inc']` |

注意 props 这条：它走的是宏分支，产物归选项层，自己不进绑定表，所以也不出现在 return 里——这对应一个细节，props 在模板里本就经由 props 机制可见，不需要再被 setup 返回一次。最终输出的等价形态（简化后）长这样：

```js
function setup(__props) {
  const props = __props         // props 宏的产物：拿到入参
  const count = ref(0)
  const inc = () => { count.value++ }
  return { count, inc }         // 顶层绑定自动暴露给模板
}
// 选项层：{ props: ['msg'] }
```

`defineProps(['msg'])` 这行调用在产物里已经不存在了，它只留下两样东西：选项层的一条 `props` 声明，和 setup 里的 `const props = __props`。这就是去糖的全貌：声明式输入，机械展开成 setup() 返回值加选项层。

## 7. 教学简化说明

这段演示故意省略了不少东西：完整的 SFC 解析（template / style / 自定义块）、TypeScript 类型到运行时声明的完整推导、sourcemap、`defineModel` 那个带 get/set 的代理 ref 包装细节、import 解构里「值 import 还是类型 import」的区分，还有普通 `<script>` 与 `<script setup>` 共存的合并规则。这些都是真实编译器要处理的工程细节，但不影响你看清「去糖」这个核心动作。另外，去糖时维护一张「绑定表」是这个演示对实现机制的还原：你能观察到「顶层绑定自动暴露给模板」这个行为，官方编译器内部确实靠类似方式登记顶层绑定，但具体数据结构文档没有明说，这里按最直观的形态来表达。

## 8. 小结

说到底，`<script setup>` 和它那组 `define*` 宏，就是编译器替你写掉了 Composition API 的接线样板：用一次去糖换来了声明式的写法，代价是这组宏被硬编码、没法扩展。而这个「不能扩展」，正是 Vue Macros 被逼出来的原因。

但这些宏到底是在编译管线的哪一步、用什么方式被识别和改写的？为什么必须靠 AST 而不是正则去抓它们？下一章「SFC 编译管线与宏的注入时机」就接着拆这条管线。
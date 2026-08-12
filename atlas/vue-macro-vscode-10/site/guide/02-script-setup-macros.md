# `<script setup>` 与内置宏的设计动机

> 本章属于 primitive 层。前置：编译期宏的本质。
> 学完你能讲清：内置宏到底把声明式 `<script setup>` 去糖成了什么形状，以及为什么这套宏被硬编码进官方编译器——这正是 Vue Macros 之所以存在的痛点。

上一章把宏的存在方式说清楚了：编译期是「变换提示」、运行时被彻底擦除。Vue 用户其实很少需要自己造宏，因为官方编译器里早就内置了一组——`defineProps`、`defineEmits`、`defineModel`、`defineExpose`、`defineOptions` 那一串。这一章就看这些内置宏具体把用户的声明式写法「去糖」成了什么，以及为什么这套宏被焊死在编译器里。

## 1. 为什么需要它：三层接线样板

回到 `<script setup>` 出现之前。用 Composition API 写一个组件，你得这么开头：

```js
export default defineComponent({
  props: { msg: String },        // ① props 在外面单独声明
  emits: ['update'],             // ② emits 也在外面单独声明
  setup(props, { emit }) {       // ③ 套一层 setup 包装函数
    const count = ref(0)
    function inc() { count.value++ }
    return { count, inc }        // ④ 模板要用的，逐个手写 return
  }
})
```

四件与业务无关的事每写一个组件就得重做一遍：套 `setup` 包装、把模板要用的所有变量塞进 `return`、props 和 emits 在外面再声明一次、`defineComponent` 包一层。组件越多，这层接线重复得越让人麻木，Composition API 本来该有的简洁被这层脚手架抵消了大半。

更要命的是 props 的类型：在 `<script setup>` 之前，props 的 TS 类型与运行时声明各写一遍，类型推导跟运行时校验是脱节的。`defineProps<T>()` 这种写法出来之后，类型与运行时声明第一次合到了一处——这件事也只有编译期能做，普通 JS 工具拦不住。

## 2. 核心思想：糖在写法，运行时什么都没变

一句话：**编译器把声明式 `<script setup>` 逐行机械去糖成等价的 `setup() + options`**。用户只声明「我要什么」（顶层变量、几个宏调用），编译器替他补出「怎么接进 Vue 运行时」的全部接线。

这句话的关键不在「补接线」，而在「**等价**」二字——`<script setup>` 没引入任何新的运行时模型。它编译出来的产物，仍然是 Vue 一直就认的那套 options + setup() 函数。糖的甜味全在写法那一侧，运行时一侧什么都没变。

这一点也解释了为什么宏必须擦除：既然运行时模型没变，那宏本身就不该在产物里出现——它只是给编译器看的「请帮我补出 X」的指令。

## 3. 心智模型：一张绑定表加几次改写

把去糖的内部状态想成三个东西在变：

1. **绑定表（binding table）**：编译器扫一遍 `<script setup>` 顶层，把每个名字连同它的种类登记进去（普通常量、`ref` 包装、函数、可能从 import 来的）。这张表后面要做两件事——决定哪些东西自动 `return` 给模板、模板里见到这个变量要不要 `.value` 解包。
2. **宏改写**：命中一个 `define*` 调用，就按这条宏硬编码的规则把它搬到该去的地方：
   - `defineProps` → 搬到 options 的 `props` 字段
   - `defineEmits` → 搬到 options 的 `emits` 字段
   - `defineExpose` → 搬到 setup 返回值之外的「显式暴露通道」
   - `defineModel` → 同时生成 `props` 声明、`emits` 声明、再加一个本地代理 ref
3. **自动 return**：绑定表里所有顶层绑定（无论种类），自动塞进生成的 `setup()` 返回对象。模板里就能直接用。

最后，模板被编译成 render 函数，内联进 setup() 闭包，与用户写的顶层绑定共享同一个作用域；而那些 `define*` 调用本身，在最终产物里**一行不剩**。

```
<script setup> 顶层
   │
   ├── 顶层声明 ──► 绑定表 ──► setup() 的 return 对象（模板可见）
   │
   └── define* 调用 ──► 按规则改写 ──► options.{props, emits, expose}
                                     └─► (defineModel) 本地代理 ref

   宏调用节点本身：编译完删除
```

## 4. 关键权衡

> 这是本章重头戏。这四条权衡解释了内置宏为什么长成今天这样——尤其是「为什么用户没法扩展它」这一条，直接接通了全书主角 Vue Macros 的存在理由。

### 硬编码一组宏换零运行时零配置，代价是用户不可扩展

官方编译器（`@vue/compiler-sfc` 的 `compileScript`）里直接写死了一组宏的识别与展开规则：`defineProps`、`defineEmits`、`defineExpose`、`defineModel`、`defineOptions`、`defineSlots`、`withDefaults`、`useSlots`、`useAttrs`。用户在 `<script setup>` 里写它们，既不用 `import`，也不会在产物里留下调用痕迹。

这个选择换来了三样好处：零运行时开销（宏是编译期伪函数）、用户零配置（写出来就能用，不用注册）、跨项目行为完全统一（任何 Vue 3 项目都认同一组宏）。

代价是把扩展权完全收走了。用户既不能加新宏，也不能改写现有宏的展开规则。Vue 维护者曾在 issue #6392 里明确表态：自定义宏的复杂度目前太高，官方暂不提供公开 API。这不是文档没写，是设计上故意关上的门。

**它化解的本质矛盾**：「宏必须由编译器认识才能正确展开」与「用户想要官方没提供的、更激进的语法糖」之间的矛盾。Vue 官方把这矛盾往「保守、可控」一侧压到底；这恰恰是 Vue Macros 整个项目存在的理由——它在官方编译器之外另开一条管线，专门补这一刀。这个矛盾会在第 7 章（宏的设计原型）和第 11 章（双轨制）继续展开。

### 模板默认全开、父组件默认全关：同一条绑定两个相反默认值

顶层绑定自动塞进 `setup()` 的返回对象，意味着模板对它们是「默认开放」的——你写了什么，模板里就能直接用。但对父组件而言，组件实例是「默认关闭」（closed by default）的：通过 template ref 或 `$parent` 拿到的实例，访问不到任何内部绑定，必须显式 `defineExpose([...])` 才把指定项暴露给父组件。

这个选择换来了「消灭手写 `return`」与「不破坏组件封装」两件事的同时成立。代价是心智不对称——同一条 `count` 绑定，自己的模板看得见、父组件 ref 拿不到，初学者常常在 `parentRef.value.count` 是 `undefined` 上卡很久。

**它化解的本质矛盾**：「消灭样板要求默认开放」与「组件封装要求默认关闭」之间的矛盾。Vue 把这条线划在了「模板 / 父组件」这条边界上：向自己的模板全开，向父组件全关。两侧的默认值相反，但各自的理由都站得住。

### 宏长得像函数，但没有任何函数语义

宏的写法就是函数调用的样子：`defineProps([...])`、`defineModel()`。用户照普通函数写就行，几乎零学习成本。

代价在第 1 章已经点过，这里换一个角度强调它对**组合性**的限制。宏不能放在 `if` 里按分支条件调用，也不能搬进一个 composable 函数里复用，更不能被普通的 JS 工具（打包器、tree-shaker、ESLint 规则）当成函数来分析。原因不神秘：宏依赖编译器在 `<script setup>` 上下文里按调用名识别，一旦搬出这个上下文，它就只是个普通标识符——而运行时根本不存在对应的函数。

**它化解的本质矛盾**：「写法要像普通 JS 才好上手」与「语义必须特殊才能触发编译期变换」之间的矛盾。Vue 选了「看起来像、其实不是」这条路，把语义特殊性藏在编译器里，换取最低的写法门槛。

### defineModel 一个宏打包双向绑定的三件套

`const m = defineModel()` 一行写完，背后同时生成了三样东西：一个 `modelValue` prop 声明、一个 `update:modelValue` emit 声明、一个本地可读写的代理 ref（读等于取 prop 值，写等于 emit 更新事件）。

这一选择换来了双向绑定从「手写三件套」缩成一行，对常用模式是个明显的减负。代价是该宏的展开规则比其它宏重得多——它要生成一个带 `get`/`set` 的代理对象，把读写翻译成两条不同的运行时通道。这反过来证明「去糖」能承载非平凡的模式，但也意味着用户想自己造一个类似的宏（比如「带校验的双向绑定宏」），需要复刻一整套等价的运行时产物——这正是上一条权衡说的「扩展权被收走」的具体落地。

**它化解的本质矛盾**：「想让常用模式一行写完」与「模式越复杂、编译器展开规则越重」之间的矛盾。

## 5. 最小原理演示：一个去糖器

下面是一个极简的去糖器——输入顶层语句的结构化描述，输出等价的 `setup()` + 选项。代码只演示「登记绑定 → 命中宏改写 → 擦除宏调用」这三步，每一步对应上面心智模型里的一个原理点。不演示真实的 AST 解析、TS 类型推导、sourcemap、defineModel 的代理 ref 包装。

```ts
// 简化的 <script setup> 去糖器
// 输入：顶层语句的极简结构化描述（真实编译器走的是 AST，这里用结构化数据替代以聚焦去糖动作）
// 输出：等价的 setup() 函数体 + 组件 options

type Stmt =
  | { kind: 'macro'; name: 'defineProps' | 'defineEmits' | 'defineExpose' | 'defineModel'; arg?: any }
  | { kind: 'const'; name: string; isRef?: boolean }   // isRef: true 表示被 ref(...) 包装
  | { kind: 'fn'; name: string }

type Binding = { name: string; unwrapInTemplate: boolean }

function desugar(stmts: Stmt[]) {
  const options: Record<string, any> = {}
  const bindings: Binding[] = []

  // 扫一遍顶层：命中 define* 就按硬编码规则搬到 options；普通声明登记进绑定表，
  // 顺便记下模板里要不要 .value 解包
  for (const s of stmts) {
    if (s.kind === 'macro') {
      if (s.name === 'defineProps') options.props = s.arg
      else if (s.name === 'defineEmits') options.emits = s.arg
      else if (s.name === 'defineExpose') options.expose = s.arg
      else if (s.name === 'defineModel') {
        options.props = ['modelValue']
        options.emits = ['update:modelValue']
      }
      continue   // 宏调用不进绑定表——它的产物只落到 options 层
    }
    bindings.push({
      name: s.name,
      unwrapInTemplate: s.kind === 'const' && !!s.isRef,
    })
  }

  // 绑定表里的所有顶层绑定自动塞进 setup() 的 return（模板可见 = 默认开放）
  const returned = bindings.map(b => b.name).join(', ')

  // 宏调用本身从产物里彻底删除——它们从头到尾只是给编译器看的指令
  options.setup = `(__props) => {
  /* 用户原顶层代码（宏调用已被擦除；defineProps 的左值会被替换成取 __props） */
  return { ${returned} }
}`

  return options
}
```

骨架就这三步。真实编译器要复杂得多——它要在真正的 AST 上走、要处理 TS 类型推导、要生成 defineModel 那种带 `get`/`set` 的代理 ref、还要保留 sourcemap 让产物能回溯到用户源码。但去糖这个动作的核心——「扫一遍 → 命中改写 → 自动 return + 删除宏」——就是上面这点东西。

## 6. 执行轨迹：一行具体输入走完三步

输入（声明式 `<script setup>`）：

```js
const props = defineProps(['msg'])
const count = ref(0)
function inc() { count.value++ }
```

**第一遍扫描**——逐行处理：

| 源码 | 处理 | 状态变化 |
|---|---|---|
| `const props = defineProps(['msg'])` | 命中 `defineProps`，宏改写 | `options.props = ['msg']`；调用节点删除，左值 `props` 改为取 `__props` |
| `const count = ref(0)` | 普通常量声明，进绑定表 | `bindings = [{ name: 'count', unwrapInTemplate: true }]` |
| `function inc() {...}` | 普通函数声明，进绑定表 | `bindings += [{ name: 'inc', unwrapInTemplate: false }]` |

**生成 return 对象**——绑定表里所有名字自动暴露给模板：`return { count, inc }`。注意 `props` 不在里头，因为它已经被抽到 `options.props` 去了，模板里要用直接写 `{{ msg }}` 而不是 `{{ props.msg }}`。

**最终产物**（去糖后的等价形态，已简化）：

```js
export default {
  props: ['msg'],          // defineProps 改写到选项层
  setup(__props) {
    const props = __props  // 宏调用擦除后，左值变成取 setup 入参
    const count = ref(0)
    function inc() { count.value++ }
    return { count, inc }  // 顶层绑定自动暴露给模板
  }
}
```

宏在产物里一行不剩。读这段产物，就像读一个普通手写的 options + setup() 组件——这正是「去糖」想要的效果。

## 7. 教学简化说明

本章演示故意省略：完整 SFC 解析（template / style / 自定义块的处理）、TS 泛型 props 到运行时声明的完整推导、sourcemap 生成、`defineModel` 的代理 ref 包装细节、import 解构里「值 import vs 类型 import」的边界区分、`<script>` 与 `<script setup>` 共存时的合并规则、`withDefaults` 给仅类型 props 生成默认值的具体步骤。这些会在后续章节随用随补，本章只演透「去糖」这一个动作。

## 8. 小结

`<script setup>` 没有发明新的运行时模型，它只是把用户写的声明式顶层代码机械展开成 Vue 一直就认的 `setup() + options` 形态——宏是这套展开规则的指令。这套机制把扩展权彻底收走，正是 Vue Macros 要补的缺口。下一章我们跟进编译管线，看 `compileScript` 在哪个阶段识别宏调用、为什么必须挂在那一步。
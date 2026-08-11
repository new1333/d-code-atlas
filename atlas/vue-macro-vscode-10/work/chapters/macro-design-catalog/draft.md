# 宏的设计原型：把什么前移到编译期

> 本章属于 composite 层。前置：『Vue Macros 的宏变换流水线』。
> 学完你能：用一句话讲清『Vue Macros 这一摞特性不是一锅杂烩，背后只有三类可还原判据，激进程度依次递增』。

## 1. 为什么需要它

上一章把『宏变换流水线怎么跑』讲透了——注册宏 → 遍历 AST → 命中调用 → magic-string 注入 → 链尾交棒。但这条流水线只回答了『一条管线怎么跑』，没回答另一个更本质的问题——

**这条管线上跑的『变换内容』本身，有什么共性？**

Vue Macros 的特性目录铺开来有二三十个：defineModels、definePropsReactive、defineEmit、shortBind、chainCall、setupSFC、defineRender、jsxDirective、namedTemplate、booleanProp……看上去琳琅满目，但如果没有一种归纳，每个特性都成了『独立的临时扩张』，谁也不知道下一个新特性该怎么写、写得过激还是太保守。

更现实的痛点来自用户侧。没有这套宏之前，Vue 开发者每天在手写三类本可自动生成的东西：

- 写一个组件 `v-model` 要手动凑齐『一个 prop + 一个 emit + 一个带 get/set 的 computed』三件套；
- props 一旦解构就丢响应性，被迫满文件写 `props.foo` 而不敢用解构；
- 想用 JSX / render 函数就得整体退出 `<script setup>`、退回老式 `setup()` 函数。

这些都不是『逻辑难』，而是『样板在手写、约定靠人记』。Vue Macros 追问的是：这些手写样板里，哪些是编译器能**确定性地**替你推导出来的？能推导出来的，就不该再让人写。

矛盾很清楚：用户需要少写、官方编译器又不能无限制地吸收社区糖；中间这块『官方还没做、但完全能做』的空地，需要一个收编门槛——什么进、什么不进。本章就是给这块空地划线的。

## 2. 核心思想

判断一个特性该不该做成宏的唯一判据是——**它能否被一段确定性的编译期变换，从用户写的简写形式唯一地还原成等价的标准 Vue 代码**；能就是宏，需要运行期信息或外部状态的就不是。

## 3. 心智模型

收编门槛一旦立起来，整张宏目录就能按『还原方式』归到三类原型上：

| 原型 | 它在还原什么 | 代表宏 | 产物是什么 |
|------|-------------|--------|------------|
| 一·补全能力 | 标准代码本就能手写的样板 | defineModels | 一段标准 Vue 代码 |
| 二·运行期约定编译期化 | 改写用户对已有数据的访问路径，绕开运行期约束 | 响应式 Props 解构 | 标准 Vue 代码 + 改写过的访问路径 |
| 三·全新 DSL | Vue 本来根本没有的写法 | defineRender / setupSFC / jsxDirective | 引入一条新的表达通道 |

判断流程是这样的——拿到一个候选特性，依次问：

1. 它的产物，是不是一段标准 Vue 本来就能手写出来的等价代码？是 → **原型一**。
2. 它是不是在『改写你对已有数据的访问路径』，从而绕开一个纯运行期的约束？是 → **原型二**。
3. 它是不是引入了一种 Vue 本来根本没有的写法 / 语法通道？是 → **原型三**。
4. 三个都否 → 它不该做成宏（该做运行时工具或组合式函数）。

要特别强调一点：原型之间**不互斥**。同一特性可能横跨两类，比如著名的 reactivity transform 兼具二与三，这正是它最终只被部分保留下来的原因。

而且这三类原型在『偏离标准 Vue 心智模型』这条轴上是**单调上升**的——原型一几乎无偏，原型二动了一下访问语义，原型三直接换了写法本身。下面所有权衡都基于这条单调轴。

## 4. 关键权衡

### 「确定性可还原」当收编门槛，换来语义安全

宏的收编门槛放在哪儿，决定了整个生态位的形状。Vue Macros 选择只收编那些**能被编译期唯一还原成标准代码**的特性。

换来的是语义安全。原型一的产物等于用户手写的那套三件套，原型二的产物等价于在源码里所有地方老老实实写 `props.count`，原型三虽然换了通道，但每条通道都能写出『等价于什么标准代码』的对应关系。换句话说：宏不会引入『用户写一套、运行时跑另一套』的隐藏语义。

代价是这条门槛把很多东西挡在了门外。凡是需要运行期才能确定的信息——比如『props 类型在运行时从对象里读出某些字段』『同一个值在运行时被多次 mutate』——都做不成纯编译期宏。这是宏的能力上限：它只能搬、不能想；需要运行期思考的，仍要留给组合式函数。

本质矛盾是『用户想要更多糖』与『编译器必须保证生成代码可预测』之间的拉扯——『确定性可还原』这条线刚好把这两个需求隔开，能还原的进、不能的不进。

### 激进程度与心智偏离成正比，换极致简洁

三类原型按偏离标准心智的程度排序：原型一几乎无偏，原型二动访问路径，原型三换表达通道。Vue Macros 同时收这三档、且让用户自己选开几档——这是它『可调激进程度』的设计。

换来的是用户可以按场景选档。一个只想省样板、不介意贴着手写样子长的团队，开原型一档就够了；一个追求极致简洁、能接受偏离的团队，可以开到原型三，把整个 SFC 变成纯 script、用 JSX 写指令。

代价随档位上涨：

- 原型一档：迁移与理解成本接近零，新人打开产物一眼能懂。
- 原型二档：新人需要在脑子里建立『解构出的 `count` 其实是 `props.count` 的别名』这层映射；调试时也得记得堆栈里的 `props.count` 就是源码里的 `count`。
- 原型三档：新人根本不一定看得懂产物——`setupSFC` 把整个 SFC 变成纯 script，IDE 和工具链要额外做支持才能让写法可用。

本质矛盾是『简洁』与『可读可调』这两个永恒的对手——三档原型就是这两个对手在不同比例下妥协出来的三个稳定点。

### 补全会被官方吸收，发明不会

把这条轴往时间维度上一摊，就能看到一个有意思的生命周期：原型一/二往往最终被官方上游吸收，原型三几乎不会。

`defineModel` 进官方、响应式 Props 解构也进官方——这不是巧合，而是**正好证明**了它们是『官方迟早会做的缺口』。Vue Macros 把缺口先临时填上，等官方填了，宏就退场。`defineModels`（带 s，批量声明）就是典型例子：它先把这个能力撑起来，等官方用『多次 `defineModel` 调用』解决同一问题，这个宏就完成使命了。这就是宏作者的宿命：做的是编译器能力的**临时扩张**，不是永久领地。

原型三的命运完全相反。`setupSFC`、`jsxDirective` 改的是写法偏好、不是能力缺口——官方不打算让 SFC 变成纯 script，也不打算让 JSX 长出 `v-if`。这类宏会长期留在 Vue Macros 里，永远不会被吸收。

代价是宏作者要接受双轨生命周期：原型一/二的宏随时准备被官方接管、自己被废弃；原型三的宏要长期自维护、得不到官方支援。本质矛盾是『社区等不及官方』与『官方需要克制收敛』之间的时差——原型一/二恰好落在两边都能认领的交集，原型三落在只社区认领的偏远处。

### 语法糖单向可逆，换写法极致简洁

编译期变换是单向的——源码 → 产物，再回不去。原型三用得越深，这条单向性越痛。

换来的是写法上的极致简洁。`setupSFC` 让你不再写 `defineComponent`、不再写 `setup()`，整段就是 script；`defineRender` 让你在 `<script setup>` 里一行声明 render 函数，不必退到老式 `setup()`。

代价有两层：

- 调试时堆栈和报错指向**编译产物**，不是用户写的简写——这正好接回第 5 章对 sourcemap 的依赖，没有 sourcemap 这条路就完全黑了。
- 一旦哪天想脱离这个宏，没有自动反向变换可用，得整段重写。

本质矛盾是『人想要的写法』与『机器能反馈的位置』不在同一个抽象层——单向变换把这两层永久隔开，人写在一层、机器在另一层报错，sourcemap 只是把这两层勉强缝起来的一根线。

## 5. 最小原理演示

下面用三段十几行的玩具函数，把三类原型的『还原方式差别』演透——它们共用同一个『输入元信息 → 标准代码字符串』骨架，重点在还原方式的**对照**，不在工程精度。

```ts
// 假设：拿到的是已经识别出来的『宏调用节点 + 它附带的元信息』。
// 三段都只关心"怎么把元信息还原成等价标准代码"，不关心 AST 解析本身——
// 那是第 4 章 AST 识别的事。

// ── 原型一：defineModels 风格 ──────────────────────────
// 输入：用户想声明的 model 列表；输出：标准 Vue 代码里等价的多次 defineModel。
type ModelDecl = { name: string; type: string }

function expandDefineModels(models: ModelDecl[]): string {
  // 纯样板展开——产物完全等价于用户手写多次 defineModel
  return models
    .map((m) => `const ${m.name} = defineModel<${m.type}>()`)
    .join('\n')
}

// ── 原型二：响应式 Props 解构 ──────────────────────────
// 输入：解构出的标识符名列表、setup body 源码；
// 输出：把所有裸读 count 改成 props.count 的版本。
function rewriteDestructuredReads(
  destructured: string[],
  body: string,
): string {
  // 不改语义，只改访问路径——这正是编译期约定化的核心动作
  let out = body
  for (const name of destructured) {
    out = out.replace(new RegExp(`\\b${name}\\b`, 'g'), `props.${name}`)
  }
  return out
}

// ── 原型三：defineRender ───────────────────────────────
// 输入：用户写的 JSX/render 表达式；输出：注入一条 setup 返回 render 的通道。
function expandDefineRender(jsxExpr: string): string {
  // 引入官方 SFC 里本不存在的"在 setup 顶层声明 render"通道
  return [
    'import { defineComponent } from "vue"',
    'export default defineComponent({',
    '  setup() {',
    `    return () => ${jsxExpr}`,
    '  }',
    '})',
  ].join('\n')
}
```

三段并排看就明白了：原型一**全等价展开**，原型二**改访问路径不动语义**，原型三**注入新通道**——它们的差异不在工程精度，而在『还原动作本身是什么形状』。

## 6. 执行轨迹

把三类原型放在同一个 SFC 里跑一遍，看它们各自被确定性还原、互不干扰。

输入（用户简写，三类原型共存）：

```ts
// SFC <script setup> 里
const { count = 0 } = defineProps<{ count?: number }>()            // 候选·原型二
const models = defineModels<{ open: boolean }>()                   // 候选·原型一
defineRender(() => <div>{count}{models.open.value}</div>)          // 候选·原型三
```

第 1 步·原型二（响应式 Props 解构）介入：

```ts
const { count = 0 } = defineProps<{ count?: number }>()
const models = defineModels<{ open: boolean }>()
defineRender(() => <div>{props.count}{models.open.value}</div>)
//                            ^^^^^^^^^^ 这里被改写
```

`count` 这一个裸标识符被精确地改成 `props.count`——注意 `defineProps` 那一行解构模式里的 `count` 不动，因为它不是属性访问。

第 2 步·原型一（defineModels）介入：

```ts
const { count = 0 } = defineProps<{ count?: number }>()
const open = defineModel<boolean>('open')                          // 展开defineRender(() => <div>{props.count}{open.value}</div>())
//                                                ^^^^^^^^ models.open 也被替换
```

`defineModels<{ open }>()` 这一句被展开成等价的标准 `defineModel` 调用，用户写的 `models.open` 访问也同步被替换成裸 `open`。

第 3 步·原型三（defineRender）介入：

```ts
import { defineComponent, defineModel, defineProps } from 'vue'

defineProps<{ count?: number }>()
const { count = 0 } = /* 同上 */
const open = defineModel<boolean>('open')

export default defineComponent({
  setup() {
    return () => <div>{props.count}{open.value}</div>
  }
})
```

`defineRender` 把整个文件重新组织成『导出一个 `defineComponent`，setup 返回那个 render 函数』——这是 `<script setup>` 顶层原本**做不到**的事。

三个原型同台演出、互不冲突，靠的是上一章流水线保证的『串行接力 + 各自重解析』。每个原型只关心自己那段还原，整份 SFC 的最终形态由链的累积结果决定。

## 7. 教学简化说明

本章的演示故意省略了：

- 真实的 Babel AST 解析与遍历（第 4 章已展开）；
- magic-string 的 sourcemap 生成（第 5 章已展开）；
- 真正的 `defineModels` 完整展开规则（包括 `models` 对象上的属性描述符）、`defineRender` 对 JSX 内 `v-if` 等指令的下钻；
- 每个宏的完整选项、Vue 2.7 vs 3 的兼容分支、Volar 类型层；
- 特性开关配置——那是第 13 章『配置系统』的内容；
- reactivity transform 被废弃的完整时间线——第 14 章『根本权衡』会讲。

字符串替换只为演『确定性还原』这个判据，工程精度上不要拿去和真实宏对齐。

## 8. 小结

Vue Macros 的宏目录是按『还原方式』划线的三类原型：**补全能力、运行期约定编译期化、全新 DSL**，偏离标准心智的程度一条比一条深。这条单调轴能解释宏生态里几乎所有现象——为什么有的宏会被官方接管、有的永远不会；为什么有的几乎零迁移成本、有的让产物看不懂。下一章暂时离开宏本体，去看另一个横切问题：这堆宏写好之后，怎么让一份代码同时跑在 Vite、Rollup、webpack 上。
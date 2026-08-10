# `<script setup>` 与内置宏的设计动机 · 主题精读

## 给 Writer 的教学钩子（必填，8 子项缺一不可）

- **用户痛点 / 场景**：在没有 `<script setup>` 的年代，用 Composition API 写一个组件要套三层样板——`defineComponent({ setup(props, { emit }) { /* 业务 */ return { 模板要用的所有东西 } } })`。每个组件都要手写 `setup` 包装函数、把模板需要的变量逐个塞进 `return`、再把 props/emits 单独声明在选项里。组件越多，这套与业务无关的「接线」重复越多，Composition API 的简洁被这层脚手架抵消了大半。

- **一句话核心思想**：编译器把用户写的声明式 `<script setup>` 逐行「去糖（desugar）」成等价的 `setup() { return {...} }` 与组件 options——用户只声明「想要什么」，编译器替他生成「怎么接进 Vue 运行时」的全部样板。

- **设计动机（为什么需要它）**：这套机制是为消灭 Composition API 的「接线样板」而生——把 `setup` 包装函数、手写 `return`、props/emits 选项声明这三件重复劳动，交给编译器在编译期机械生成，换来了「写法像写普通 JS、行为却是完整组件」的声明式体验，同时让 props/emits 能直接用 TypeScript 泛型声明并自动推导类型。**承前去重**：宏=「编译期擦除的伪函数」这一本质（已在第 1 章『编译期宏的本质』讲透），本章只看它的新侧面——内置宏具体「去糖」成什么形状的等价代码，以及为什么这套宏被硬编码进官方编译器而无法被用户扩展（这正是本书主角 Vue Macros 要补的缺口）。

- **关键权衡**：
  1. 选择「在官方编译器里硬编码一组固定宏」→ 换来了零运行时开销 + 用户零配置（无需 import）+ 跨项目行为完全统一 → 代价是宏的语义彻底由官方编译器决定，用户既不能自定义新宏、也不能改写现有宏的行为（官方明确表示暂不提供自定义宏的公开 API）——**这正是 Vue Macros 之所以存在的痛点**。
  2. 选择「顶层绑定自动暴露给自身模板」→ 换来了彻底消灭手写 `return { ... }` → 代价是组件实例对父组件改为「默认关闭」（需 `defineExpose` 才显式暴露），因为「全暴露」会破坏封装；于是「暴露给模板」与「暴露给父组件 ref」两条通道被故意设计成相反的默认值。
  3. 选择「宏调用长得像函数、但其实没有函数语义」→ 换来了最小的心智负担（照着函数写就行）→ 代价是宏不能条件调用、不能被普通 JS 工具当函数分析、不能搬进 composable 复用——它只活在 `<script setup>` 这个被编译器识别的上下文里（这一点与第 1 章呼应，但本章强调它如何直接限制了宏的组合性与复用性）。
  4. 选择「用一个宏同时声明 prop + emit + 本地 ref」（`defineModel`）→ 换来了双向绑定从「手写三件套」缩成一行 → 代价是该宏的展开规则更重（要生成一个带 get/set 的代理 ref），这反过来证明「去糖」能承载非平凡的模式，也进一步抬高了用户自造宏的门槛。

- **最小心智模型（3～7 步）**：
  1. 用户在 `<script setup>` 顶层写普通 JS/TS（变量、函数、import）。
  2. 编译器遍历这段顶层代码，把所有顶层绑定登记进一张「绑定表」（记录名字与种类）。
  3. 命中 `define*` 宏调用节点时，按该宏的硬编码规则改写：props 类宏 → 抽取成选项层的声明；expose 类宏 → 抽取成 setup 返回的 exposed 对象；model 类宏 → 同时生成选项层声明 + 一个本地代理 ref。
  4. 把绑定表里的顶层绑定自动塞进生成的 `setup()` 返回对象（模板即可见）。
  5. 模板被编译成 render 函数，直接内联进 `setup()` 的闭包，复用同一批绑定。
  6. 宏调用本身在最终产物里被彻底删除——它们从头到尾只是给编译器看的「变换提示」。

- **最小原理演示（替代旧"复刻范围"）**：
  - **应演示**：一个极简的「`<script setup>` 去糖器」——输入一段伪 `<script setup>` 顶层代码（含一个 props 宏调用 + 几个顶层变量 + 一个函数），输出等价的 `setup() { return {...} }` 形态与选项层声明。演示必须覆盖三步且每一步对应上面的一个原理点：① 收集顶层绑定进绑定表；② 识别宏调用并改写为选项/exposed；③ 删除宏调用、用绑定表生成 `return`。
  - **应故意省略**：完整的 SFC 解析（template/style/自定义块）、TypeScript 类型到运行时声明的完整推导、sourcemap、model 宏的代理 ref 包装细节、import 解构与「值 import vs 类型 import」的边界区分、`<script>` 与 `<script setup>` 共存的合并规则。**不追求工程完整**，只追求「演透去糖这一动作」。
  - **演示载体建议**：topic 模式首选 **TS/JS**（本 Atlas 产物是 JS 生态 VitePress 站点，对读者最友好）。可用一个约 40 行的函数实现：接收「顶层语句列表 + 简化节点描述」，输出一个表示 `setup()` 返回结构的对象/字符串。无需接入真实解析器，用简化数据结构表达「收集绑定」「识别宏调用名」即可——目的是让读者看清去糖的输入/状态变化/输出，而不是复刻官方编译器。

- **正文不宜展开的细节**：各宏的完整签名与 TS 泛型用法（如 `defineProps<T>()`、`withDefaults`）、`defineOptions`/`defineSlots` 的逐项行为、命名 model（`defineModel('title')`）与多 v-model、TS 仅类型 import 被擦除的具体规则、宏在普通 `setup()` 函数体（非 `<script setup>`）里不可用的限制细节。供 Writer 裁剪，不要在正文铺开。

- **推荐的一个执行轨迹例子**：
  - 输入（声明式）：
    ```js
    // <script setup>
    const props = defineProps(['msg'])
    const count = ref(0)
    function inc() { count.value++ }
    ```
  - 关键中间态：绑定表 `{ props: props-常量, count: setup-ref, inc: setup-常 }`；宏改写——把 `defineProps(['msg'])` 抽出为选项层 `props` 声明，原调用节点删除。
  - 输出（去糖后的等价形态，已简化）：
    ```js
    function setup(__props) {
      const props = __props        // props 宏的产物：拿到入参
      const count = ref(0)
      const inc = () => { count.value++ }
      return { count, inc }        // 顶层绑定自动暴露给模板
    }
    // 选项层：{ props: ['msg'] }
    ```
  - 这个轨迹演的是核心思想「声明式输入 → 机械展开成 setup() 返回值 + 选项」，不演模板→render 的全量编译。

> 以上钩子供 Writer 写「动机→核心思想→心智模型→关键权衡→原理演示」；下面事实部分供核对，不要被 Writer 当目录照抄。

## 概念要点
- `<script setup>` 是 Composition API 在 SFC 中的**编译期语法糖**（compile-time syntactic sugar），是推荐写法。依据: Vue 官方文档「<script setup>」首段。
- 内置宏 `defineProps` / `defineEmits` / `defineExpose` / `defineModel` / `defineOptions` / `defineSlots` / `withDefaults` / `useSlots` / `useAttrs` 全部是**编译器宏**：只能在 `<script setup>` 内使用、无需 import、编译后被擦除。依据: Vue 官方文档「<script setup>」中「compiler macros only usable inside `<script setup>`」与「无需 import」条目。
- 顶层绑定**自动暴露给自身模板**用于渲染；但对父组件**默认关闭**（"closed by default"），通过 template ref 或 `$parent` 取到的实例不暴露任何内部绑定，必须用 `defineExpose` 显式暴露。依据: Vue 官方文档「<script setup>」「Components using `<script setup>` are closed by default」段，以及「Template Refs」章节。
- `defineModel()` 一行同时生成：① 一个 `modelValue`（或具名）prop 声明、② 一个 `update:modelValue`（或具名）emit 声明、③ 一个可读写的本地代理 ref（读=取 prop 值，写=emit 更新事件），即「双向绑定三件套」。依据: Vue 官方文档「Component v-model」+ RFC 讨论中关于 defineModel 的设计说明。
- 内置宏被**硬编码**在官方 SFC 编译器的 `compileScript` 实现中；官方目前**不提供**自定义宏的公开 API，理由是「实现自定义宏的复杂度目前太高」。依据: vuejs/core issue #6392「Supports for define custom macros」中维护者的明确表态。
- `<script setup>` 的核心收益是「更少样板 + 更好性能（模板被编译内联进 setup 闭包）+ IDE 类型推导」。依据: Vue 官方文档「<script setup>」「Advantages over normal `<script>`」段。

## 关键流程
`<script setup>` 源码 → 编译器遍历顶层 AST → 收集顶层绑定进绑定表 → 命中 `define*` 调用节点、按硬编码规则改写为选项层声明/setup 返回值/exposed → 模板编译为 render 函数并内联进 `setup()` 闭包 → 输出「`setup()` 函数 + 组件选项」的等价产物。

依据: `@vue/compiler-sfc` 的 `compileScript` 实现位于 vuejs/core 仓库 `packages/compiler-sfc/src/compileScript.ts`；官方文档「<script setup>」描述了顶层绑定自动暴露与宏被编译擦除的行为；可在 Vue SFC Playground 观察任意 `<script setup>` 片段的编译产物以核对。

## 易混淆 / 边界 / 推断
- **事实**：宏不能条件调用（不能放在 `if` 里按分支执行），也不能搬进 composable 函数复用——因为它们依赖编译器在 `<script setup>` 上下文里按调用名识别，脱离该上下文就只是普通标识符。依据: Vue 官方文档对宏使用约束的说明 + Vue Vine 文档对宏上下文边界的描述。
- **推断（标注为推断）**：「顶层绑定自动 return」很可能依赖编译器维护一张带种类标记的绑定表（区分普通常量 / ref / 可能的 ref 等），供模板编译时决定是否需要对 ref 自动 `.value` 解包。这是基于「Vue 模板对顶层 ref 自动解包」这一可观察行为反推的推断，**未在官方文档中找到对内部绑定表数据结构的明确定义**，Writer 引用时宜作为「实现机制推断」而非既定事实。
- **边界**：`<script setup>` 可与普通 `<script>` 共存，后者用于命名导出、`inheritAttrs` 等不参与去糖的副作用；此处不展开合并细节。
- **未理解 / 待查证**：`withDefaults` 配合「TS 仅类型声明（无运行时对象）的 props」时，编译器具体如何生成等价的运行时 default 值——文档只说「编译器会生成等价的运行时声明」，但具体的 AST 改写步骤未深挖，Writer 若要展开需另行查证。
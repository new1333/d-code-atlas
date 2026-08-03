# 为旧版本补齐与简化样板的语法垫片 · 源码精读

## 给 Writer 的教学钩子（必填，8 子项缺一不可）

- **用户痛点 / 场景**：开发者想要更顺手的写法——`<Comp foo>` 直接当布尔属性、`<Comp :foo>` 省掉 `="foo"` 的重复、`<Comp $count="x">` 简写 `v-model`、`defineProps().withDefaults(...)` 串着写；可这些写法有的旧版 Vue 不认、有的根本不是合法语法。没有这套机制，用户要么手写冗长的样板、要么被 Vue 版本绑死。

- **一句话核心思想**：**语法垫片要在它语义所属的那一层改写——模板语法糖借用 Vue 自己的编译器，脚本改写用增量字符串编辑。** 这是全章灵魂句。

- **设计动机（为什么需要它）**：这类宏的共同目标是「把差异和样板抹平在编译期、运行时零成本」。但本章最关键的认识是：**这 5 个宏根本不在同一层工作**。
  - 三个模板简写（布尔属性、属性前缀简写、v-model 前缀简写）改的是「Vue 如何理解一个模板属性」的语义——这种改写**只能发生在 Vue 模板编译器内部**，因为模板属性最终长成什么样由 Vue 编译器说了算，在外层字符串上动刀根本碰不到这层语义。于是它们选择「**不打补丁、只挂号**」：找到构建器里 Vue 官方插件暴露的编译器选项，把自己追加进它的节点变换队列，让 Vue 自己的编译器在跑模板 AST 时顺带完成改写，产出的就是标准渲染函数。
  - 两个脚本层改写（链式调用重排、注入语言标记）改的是 `<script setup>` 里的普通 JS/TS 文本，跟模板语义无关——这类就走「**独立增量改写**」：在 SFC 源码上做偏移编辑，可叠加、六套构建器通用。
  - **承前关系（供跨章去重）**：脚本层那两个宏复用了第 1 章『SFC 解析与增量 AST 编辑』的 parseSFC + 增量字符串编辑能力（依赖 setupOffset 偏移那套），是它的直接复用，本章不重讲增量编辑原理；但三个模板简写走的是**另一条轨道**——不经过 parseSFC、不碰字符串编辑，而是注入 Vue 编译器，这是本章独有的新侧面，务必让读者看到「同叫语法垫片、却走两条路」。

- **关键权衡（本章核心，4 条）**：
  1. **借编译器 vs 独立改写**：模板简写选择「挂靠 Vue 编译器的节点变换队列」→ 换来运行时绝对零成本（输出即标准渲染函数，无任何运行时 helper）+ 语义永远正确（由 Vue 自己解析）→ 代价是强依赖 Vue 官方插件暴露编译器选项 API，且只支持 vite/rollup/rolldown 三套构建器（webpack/esbuild/rspack 拿不到这个钩子）。
  2. **独立增量改写 vs 借编译器**（脚本层的反向选择）：链式调用、注入语言标记选择走字符串层改写 → 换来六套构建器全通用 + 可与其它宏叠加 → 代价是只能改 JS/TS 文本、碰不到模板语义，且每个宏都要自己处理 setup 偏移。
  3. **版本号即语法开关**（属性前缀简写）：用检测到的 Vue 版本号决定简写前缀的正则——旧版（无原生 v-bind 简写）允许单冒号、新版（已原生支持双冒号简写）只认双冒号，避免与原生语法冲突 → 换来新旧 Vue 行为自适应 → 代价是用户须理解版本门槛、同一前缀在不同版本语义不同。
  4. **挂号时序的脆弱性**：借编译器的宏必须在「配置已解析、Vue 插件已就绪」之后才能挂号，且要先尝试两个时机（配置解析钩子、构建开始钩子）兜底；拿不到 API 时**静默放弃**而非报错 → 换来宽松的插件加载顺序兼容 → 代价是用户配错时无提示、宏可能悄悄不生效。

- **最小心智模型（4 步，以「两类垫片如何各归其位」为主线）**：
  1. 一个语法糖进来，先判它改的是**模板语义**还是**脚本文本**——这决定走哪条路。
  2. 若是模板语义：在构建开始时，从 Vue 官方插件的 API 里取出编译器选项，把自己的节点变换函数追加进节点变换队列（挂号），之后由 Vue 编译器在遍历模板 AST 时调用它、就地把属性节点改写成标准绑定指令。
  3. 若是脚本文本：用 SFC 解析拿到 setup 块、用增量字符串编辑按偏移改写源码，输出改写后的 SFC。
  4. 两条路殊途同归：最终产物里都不留任何宏痕迹、运行时零成本，差异只在「谁动手改」。

- **最小原理演示（替代旧"复刻范围"）**：
  - 应演示：**一个极简的「布尔属性 → 标准绑定」节点变换**（演权衡 1：借编译器）。用 Vue 官方编译器包，写一个节点变换函数：遍历元素节点的属性列表，把「无值属性」改写成「绑定指令 + 字面量 true」（约二十行）。再调一次官方 compile 跑一遍，证明产物里只剩标准 `props: { foo: true }`、宏痕迹消失。**这段演示演的是「挂号进编译器 → 编译器替你改 → 产物纯净」这条核心思想，不是演完整工程。**
  - 对照演示（演权衡 1 的反面、为何脚本层另走一路）：再用增量字符串编辑把一段脚本里的 `defineProps().withDefaults(x)` 重排成 `withDefaults(defineProps(), x)`（十几行），让读者看到「这一类不需要 Vue 编译器、纯文本偏移编辑就够」。两段并排，把「同章两类垫片、两条路」演透。
  - 应故意省略：六套构建器入口的重复脚手架、过滤器/HMR/版本探测的工程化包装、Volar/IDE 侧的语法支持、负向前缀与前缀可配置等边角分支、类型推导。
  - **演示载体建议（Writer 据此执行）**：本仓库是 TS + Vue 生态。建议写成**能 `tsx`/`node` 直接跑的脚本**：直接 import 官方 `@vue/compiler-dom`（或 compiler-core）的 compile + 自定义节点变换，把 `compile('<Comp foo/>', { nodeTransforms: [我的变换] })` 的输出打印出来，读者一看就懂「挂个号、编译器替我改」。第二段对照脚本用增量字符串编辑库改一段 setup 代码即可。**载体服务于演透原理**，不强求接入真实构建器。

- **正文不宜展开的细节**：前缀可配置（v-model 简写支持 `::`/`$`/`*` 三种前缀、布尔属性支持 `!` 负向前缀）；节点 loc 偏移被设为无穷大以「标记删除」原节点的技巧；节点变换里 `processExpression` 的常量类型标记；链式调用同时清理宏 import 语句；注入语言标记对 `<script>`/`<script setup>` 双块的处理；这些宏在主聚合插件里的注册顺序与版本默认值（归下一章『统一配置体系』，本章只点明「版本号决定默认开关」即可）。

- **推荐的一个执行轨迹例子**（演权衡 1+3）：
  - 输入：`<Comp :foo>`（无值属性，旧版 Vue 不认 v-bind 简写）
  - 关键中间态：节点变换函数被 Vue 编译器调用，识别前缀正则匹配、把该属性节点就地改写成「绑定指令、表达式为标识符 `foo`」
  - 输出：编译产物的渲染函数里等价于 `:foo="foo"`，运行时零新增开销。版本切换到 3.4+ 时正则收紧为只认双冒号，避开原生简写冲突。

> 以上钩子供 Writer 写「动机→核心思想→心智模型→关键权衡→原理演示」；下面事实部分供核对，不要被 Writer 当目录照抄。

## 概念要点

- 本章 5 个宏按「改写发生在哪一层」严格分两类（**最高优先级事实**）：
  - **A 类·模板语义层（3 个）**：布尔属性、属性前缀简写、v-model 前缀简写——三者都返回官方编译器的 `NodeTransform`，改写发生在 Vue 模板编译器遍历模板 AST 时。
    源码位置: packages/short-bind/src/core/transformer.ts:13-77、packages/short-vmodel/src/core/transformer.ts:28-125、packages/boolean-prop/src/core/transformer.ts:14-60
  - **B 类·脚本字符串层（2 个）**：链式调用重排、注入语言标记——二者返回 `CodeTransform`，用增量字符串编辑改 SFC 源码。
    源码位置: packages/chain-call/src/core/index.ts:15-52、packages/script-lang/src/core/index.ts:9-33

- A 类的集成方式完全不同于本 Atlas 其它宏：**不是** `createUnplugin` 的 transform 钩子，而是「向 Vue 官方插件挂号」。它通过 `getVuePluginApi` 在构建器插件列表里找到名为 `vite:vue`/`unplugin-vue` 的插件，取其 `.api`（要求 plugin-vue > 4.3.4），再在 `buildStart` 时把自己的变换函数 push 进 `api.options.template.compilerOptions.nodeTransforms`。
  源码位置: packages/short-bind/src/index.ts:10-41、packages/boolean-prop/src/index.ts:11-41、packages/short-vmodel/src/index.ts:10-40；底层 getVuePluginApi 见 packages/common/src/unplugin.ts:28-52

- A 类的产物纯净：变换函数直接修改编译器内存中的属性节点（把 `ATTRIBUTE` 改写成 `DIRECTIVE`、设置 `arg`/`exp`），Vue 编译器随后照常生成渲染函数，**不引入任何运行时 helper**。
  源码位置: packages/boolean-prop/src/core/transformer.ts:31-57（无值属性 → `name:'bind'` directive + `exp` 字面量）

- A 类**只暴露 vite/rollup/rolldown 三个入口**（plugin 对象只有这三个 key），没有 webpack/esbuild/rspack——因为挂号依赖 Vue 官方插件的 API，这套机制只在 vite/rollup 系存在。
  源码位置: packages/short-bind/src/index.ts:43-52、packages/boolean-prop/src/index.ts:43-52、packages/short-vmodel/src/index.ts:42-51

- 挂号时序有两次兜底尝试：先在 `configResolved`（传 config.plugins）取 API，若为 `undefined` 再在 `buildStart`（传 rollupOpts.plugins）重试；取不到则 `this.warn` 后 return，**静默放弃不抛错**。
  源码位置: packages/short-bind/src/index.ts:16-30

- B 类走标准 `createUnplugin`（`transform` 直接用纯函数），与第 2 章『一次编写多套构建器』模式一致，六套构建器通用。链式调用还用了 `removeMacroImport` 在遍历 AST 时顺手清理宏 import。
  源码位置: packages/chain-call/src/index.ts:38-50、packages/chain-call/src/core/index.ts:27-32

- **版本感知**是本章 summary 的主线，实际分布如下：
  - 属性前缀简写：在**变换函数内部**用 `version < 3.4` 切换正则——旧版匹配单/双冒号（兼容无原生 v-bind 简写），3.4+ 只匹配双冒号（避开 3.4 原生引入的 `::` 简写冲突）。`$`/`*` 前缀不受版本影响。
    源码位置: packages/short-bind/src/core/transformer.ts:13-18
  - 链式调用、注入语言标记：在 **plugin 层**调 `detectVueVersion()`（默认 3.5）解析版本号，但变换本身不依赖版本——它们是纯样板消除/旧语法重排。
    源码位置: packages/chain-call/src/index.ts:20-34、packages/script-lang/src/index.ts:21-28、detectVueVersion 见 packages/common/src/dep.ts:20-26
  - 布尔属性、v-model 前缀简写：**无版本探测**，变换函数不接收 version。
  - 真正的「版本号决定默认开关」收敛在 config 层（下一章）：shortBind 默认 3.4、booleanProp 默认关、scriptLang 默认关、chainCall/shortVmodel 默认开。
    源码位置: packages/config/src/options.ts:252,272,278-280

- 链式调用是典型的「旧版本语法垫片」：`defineProps().withDefaults(...)` 在 Vue 3.3 前 `withDefaults` 是宏不能链式调用，本宏把它**重排**为 `withDefaults(defineProps(...), ...)`；无参数的链式调用则直接退化成 `defineProps()`。
  源码位置: packages/chain-call/src/core/index.ts:34-49、识别谓词 isChainCall 见 :54-62

- 注入语言标记是典型的「样板消除」：给未声明 `lang` 的 `<script>`/`<script setup>` 标签注入 `lang="ts"`（可配），靠在标签起始偏移前 `appendLeft` 实现。
  源码位置: packages/script-lang/src/core/index.ts:14-30

## 关键调用链

**A 类（模板简写，挂号路径）**：
配置解析/构建开始 → getVuePluginApi(plugins) 取 Vue 插件 .api → api.options.template.compilerOptions.nodeTransforms.push(我的变换) → Vue 编译器编译模板时回调我的变换 → 就地改写属性节点 → 标准渲染函数产出。
源码位置: packages/short-bind/src/index.ts:16-39

**B 类（脚本改写，链式调用）**：
transformChainCall(code,id) → parseSFC 取 scriptSetup + getSetupAst → walkAST → 命中 isChainCall → overwriteNode 重排成 withDefaults(defineProps(), x) → generateTransform。
源码位置: packages/chain-call/src/core/index.ts:21-51

## 源码摘录（带行号，全文累计 ≤ 30 行）

**摘录 1：A 类「挂号」的核心（演权衡 1——借编译器而非独立改写）**，short-bind/src/index.ts:30-39：
```ts
      if (!api) return

      api.options.template ||= {}
      api.options.template.compilerOptions ||= {}
      api.options.template.compilerOptions.nodeTransforms ||= []

      api.options.template.compilerOptions.nodeTransforms.push(
        transformShortBind(options),
      )
```

**摘录 2：版本号切换正则（演权衡 3）**，short-bind/src/core/transformer.ts:13-18：
```ts
export function transformShortBind(options: Options = {}): NodeTransform {
  const version = options.version || 3.3
  const reg = new RegExp(
    `^(::${version < 3.4 ? '?' : ''}|\\$|\\*)(?=[A-Z_])`,
    'i',
  )
```

**摘录 3：布尔属性把无值 ATTRIBUTE 改写成 bind 指令（演「产物纯净、运行时零成本」）**，boolean-prop/src/core/transformer.ts:31-57：
```ts
      const isNegative = prop.name[0] === negativePrefix
      const propName = isNegative ? prop.name.slice(1) : prop.name
      const value = String(!isNegative)
      node.props[i] = {
        type: 7 satisfies NodeTypes.DIRECTIVE,
        name: 'bind',
        arg: { type: 4, constType: 3, content: propName, isStatic: true, loc: prop.loc },
        exp: { type: 4, constType, content: value, isStatic: false, loc: { /* ... */ } },
        loc: prop.loc, modifiers: [],
      }
```

**摘录 4：B 类链式调用重排（演权衡 2——独立字符串改写、与 A 类反向）**，chain-call/src/core/index.ts:42-48：
```ts
    s.overwriteNode(
      node,
      withDefaultString
        ? `${WITH_DEFAULTS}(${definePropsString}, ${withDefaultString})`
        : definePropsString,
      { offset },
    )
```

（以上 4 段累计约 24 行。）

## 易混淆 / 边界 / 推断

- **事实**：A 类三个宏的 core/index.ts 都只是一行 `export * from './transformer'`——真正的变换函数在 `transformer.ts`。读源码时不要被 index.ts 误导以为空。
  源码位置: packages/short-bind/src/core/index.ts:1、packages/short-vmodel/src/core/index.ts:1、packages/boolean-prop/src/core/index.ts:1

- **事实**：A 类改写节点时，多处用「把 loc.start.offset 设为 `Number.POSITIVE_INFINITY`」来让 Vue 编译器在代码生成阶段跳过/作废原节点位置（一种「标记删除」），这与 B 类用字符串 overwrite 是两套截然不同的修改媒介。
  源码位置: packages/short-bind/src/core/transformer.ts:46、:70；packages/short-vmodel/src/core/transformer.ts:48

- **事实**：short-vmodel 的 `::` 前缀走 `processDirective`（处理已被编译器识别为指令、arg 以 `:` 开头的情形，即 `::foo`），`$`/`*` 前缀走 `processAttribute`（处理还是普通属性的情形）；两条子路径因前缀字符在模板里被编译器初判的类型不同而分开。
  源码位置: packages/short-vmodel/src/core/transformer.ts:31-35、:38-60、:62-124

- **推断**：A 类只支持 vite/rollup/rolldown（不含 webpack/esbuild/rspack），根本原因是挂号依赖 Vue 官方插件的 `api` 暴露，而这套暴露仅在 vite/rollup 系插件上存在；这与 B 类（createUnplugin 全六套）形成可用性差距，但换来运行时零成本。标注为推断（依据：plugin 对象 key 集合 + getVuePluginApi 只找 vite:vue/unplugin-vue）。
  源码位置: packages/short-bind/src/index.ts:43-51、packages/common/src/unplugin.ts:33-38

- **推断**：summary 称本章为「按 Vue 版本号条件启用」，但实际只有 short-bind 在变换内部真正用版本号改变语法行为；boolean-prop/scriptLang 的「版本条件」其实是 config 层的默认开关（默认关），chainCall/shortVmodel 默认开且不依赖版本。Writer 宜把「版本感知」聚焦在 short-bind 的正则切换上，其余讲成「默认开关收敛在配置层（下章详述）」。
  源码位置: packages/config/src/options.ts:252,272,278-280

- **未理解**：short-bind 正则的 `(?=[A-Z_])` 前瞻断言（要求前缀后紧跟大写字母或下划线）的具体动机未在源码注释中说明——推断是为避免误匹配小写开头的内置属性，但不完全确定边界，Writer 慎用此细节。
  源码位置: packages/short-bind/src/core/transformer.ts:16
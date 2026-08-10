# 配置系统：一份配置驱动两条管线 · 主题精读

## 给 Writer 的教学钩子（必填，8 子项缺一不可）

- **用户痛点 / 场景**：你在打包器配置里启用了一个宏（比如带某个子选项），构建一切正常，可一回到编辑器，对应代码全是红线——因为 IDE 那条管线根本不知道你开了这个宏。反过来也一样：IDE 能给你类型提示，CI 一跑却报错。痛点不是「某个宏不会用」，而是「我明明只配置了一次，为什么构建和编辑器像是两个世界」。

- **一句话核心思想**：把一份声明式配置（一堆特性开关 + 每个宏的选项）当成两条独立管线（构建期变换、IDE 类型）的**唯一真相源**，让两侧从同一份 schema 派生各自的注册表，从而「编译器做什么」与「IDE 懂什么」在构造层面就不可能分裂。

- **设计动机（为什么需要它）**：双轨架构让「真改代码」和「假装改代码给类型看」分成两条管线，但两条管线都得回答同一个问题——「哪些宏开着、用什么参数」。如果各读各的临时配置，漂移是必然的。所以配置系统本质是**绑定两条管线的契约**。它换来的能力是：用户只表达一次意图，两条管线就自动对齐。
  - **承前关系（跨章去重）**：（已在第 12 章『双轨制：编译变换与 IDE 类型支持为何必须并存』讲透了两条管线**为何**必须并存、语义为何必须对齐，本章只看它的新侧面——**用什么机制让两条管线读取同一份决策**，即「配置即契约」。Writer 不要再重复「双轨为何必要」，直接从「契约怎么落地」切入。）

- **关键权衡（本 Atlas 的核心）**：
  1. **同一 schema、却落到两个物理副本** → 换来两条管线各自独立运行（IDE 的语言服务进程不必拉起打包器、打包器也不必依赖 TS 服务器）→ 代价是两份配置必须靠工具或纪律同步，否则出现「开关漂移」。这正是后续「unify 两侧配置」那次重构要解决的核心矛盾：理想是一份真相源，现实是两个运行时天然读不到同一个上下文。
  2. **特性开关同时门控两侧注册**（开一个 flag ＝ 同时注册构建期的 AST visitor 和 IDE 期的虚拟代码生成器）→ 换来「开关与实现 1:1」的强一致 → 代价是任一侧新增一个宏，必须双侧同时实现，否则该 flag 在缺实现的一侧沦为「哑开关」（用户以为开了，实则无声失效）。
  3. **默认全开（opt-out）而非默认全关（opt-in）** → 换来零配置即用、最大化降低采用门槛 → 代价是用户可能无意中启用了不想要的激进语法变换，且「默认集合」本身会随官方编译器演进而变动（默认并非稳定契约）。
  4. **版本感知默认值**（检测到新版官方编译器已原生支持某宏，就把该宏默认关掉）→ 换来「宏自动让位于官方能力」的优雅收敛 → 代价是默认行为依赖版本探测、对用户不透明：同一份配置文件在不同框架版本下行为不同，排查时极易困惑。

- **最小心智模型（3～7 步）**：
  1. 用户写一份 Options 对象——一堆「宏名 → 开关或带子选项的对象」。
  2. 这份对象有两个**物理落点**：一个在打包器配置里驱动构建插件，一个在 IDE 的语言服务配置里驱动类型插件。
  3. 每条管线启动时，用**同一个 schema** 解析这份 Options，算出「每个宏开没开、用什么参数」的解析结果。
  4. 解析时叠加**默认层**：未显式写的宏按默认策略取值，再叠加版本感知默认（新框架已原生支持的宏被自动关闭）。
  5. 解析结果驱动**注册表**：开着的宏 → 在构建侧注册对应的 AST 变换器；在 IDE 侧注册对应的虚拟代码生成器。
  6. 运行时两条管线各自按注册表工作，**互不通信、互不知道对方存在**。
  7. 一致性不是靠运行时同步保证的，而是靠「同一 schema + 同一默认逻辑」在构造期静态对齐——一旦两侧 schema 或默认逻辑不一致，漂移就发生。

- **最小原理演示（替代旧"复刻范围"）**：
  - **应演示**：一个几十行的「配置 → 双侧注册」最小骨架。先定义一个共享的 Options schema（哪些特性、默认值、版本感知默认）；再写一个 `resolveOptions(options, frameworkVersion)` 把用户输入与默认合并，产出 `{ 宏名: { enabled, ...子选项 } }` 的解析结果；最后写两个 consumer——`registerBuildPipeline(resolved)` 与 `registerIdePipeline(resolved)`——都从**同一个 resolved 对象**派生各自的注册表。演示的高潮是**故意制造漂移**：让两个 consumer 读不同的 options，观察「构建通过但 IDE 报错」或反之。每一行都要对应上面某个原理点（schema=契约、resolveOptions=默认层、双 consumer=双侧门控、漂移演示=权衡代价）。
  - **应故意省略**：真实的 AST 变换实现、真实的虚拟代码生成、打包器工厂适配、tsconfig 解析细节、include/exclude 的 glob 匹配引擎、版本探测的真实实现。**不追求工程完整**，只追求演透「一份配置如何门控两条管线、漂移为何必然、unify 如何缓解」。
  - **演示载体建议**：topic 模式**首选 TS**。本 Atlas 产物是 JS 生态站点，且本概念的核心是「schema/类型契约 + 版本感知默认 + 双 consumer 派生」，用 TS 的类型能最直观地表达「同一份 Options 类型被两个 consumer 各自 import」这一契约关系，JS 反而弱化了「schema 即契约」的要点。

- **正文不宜展开的细节**：每个具体宏的子选项清单（那是「宏的设计原型」章的事）；include/exclude glob 冲突隔离的完整语义（如三个 export 系宏需 scope 才能并存）；打包器工厂如何把 transform 适配到各工具（「unplugin 抽象」章已讲）；tsconfig 里 `vueCompilerOptions` 的全量键（属 language-tools 范畴）；虚拟代码生成器的内部机制（「Volar 虚拟代码」章已讲）。

- **推荐的一个执行轨迹例子**：输入——用户在打包器配置里写 `{ 宏A: { 某选项: true }, 宏B: true }`，框架版本为旧版 → 关键中间态 1：`resolveOptions` 合并默认 + 版本感知，产出解析结果（宏 A/B 开着、被新框架原生支持的宏 C 被自动关闭）→ 关键中间态 2：构建侧注册宏 A/B 的变换器；若 IDE 侧配置**已同步**，则注册同名虚拟代码生成器 → 输出：构建正确变换且 IDE 给出对应类型提示（双侧一致）。再演漂移：若 IDE 侧漏配宏 A → IDE 不认该宏、红线出现，而构建照常通过——一句话点透「契约破裂」。

> 以上钩子供 Writer 写「动机 → 核心思想 → 心智模型 → 关键权衡 → 原理演示」；下面事实部分供核对，不要被 Writer 当目录照抄。

## 概念要点

- **Options 的形状**：是一个以「宏名」为键的对象，值要么是 `boolean`（纯开关），要么是 `object`（开关 + 该宏的子选项）。这是「特性开关」的最小原语。依据: Vue Macros 官方文档「Configurations」页的 `defineConfig` 示例与 per-macro 说明。
- **默认策略是 opt-out（默认全开）**：官方原文「All features are enabled by default except the following」，即除少数宏外，其余默认全部启用。换来的就是「装上即用、零配置」。依据: Vue Macros 官方文档「Configurations · Disabled by Default」段落。
- **默认关闭的宏**：`exportExpose`、`exportProps`、`exportRender`、`setupSFC`、`booleanProp`、`shortBind`、`defineStyleX` 等。它们要么行为激进、要么与标准心智偏离大，故不默认开。依据: Vue Macros 官方文档「Disabled by Default」清单。
- **版本感知默认（关键设计）**：当检测到 Vue ≥ 3.3 时，`defineOptions`、`defineSlots`、`hoistStatic`、`shortEmits` 等**默认关闭**——因为这些能力已被官方编译器原生支持，宏不再需要补位。这是「宏作为编译器能力的临时扩张，随官方收敛而退场」这一生态演进原则在配置层的直接体现（呼应紧邻下一章的根本权衡）。依据: Vue Macros 官方文档「Disabled by Default when Vue >= 3.3」段落。
- **配置的两个物理落点**：① 打包器侧——通过 `VueMacros({...})`（基于 unplugin）注入 Vite/Rollup/webpack 等；② IDE/类型侧——在 `tsconfig.json` 的 `vueCompilerOptions.vueMacros: {...}` 块里，并需把 `@vue-macros/volar`（或粒度化的 `@vue-macros/volar/<macro>`）加入 `vueCompilerOptions.plugins`。依据: Vue Macros 官方文档「Bundler Integration」页 + 「scriptSFC · Volar Configuration」页的 tsconfig 示例。
- **两侧为何要分开落点（根因）**：Volar 语言服务运行在 TS 服务器 / IDE 进程里，与打包器进程相互隔离，天然读不到打包器配置文件的上下文；因此配置必须有一个「IDE 侧的副本」。依据: 推断，基于 Volar.js / Vue Language Tools 的进程模型常识（语言服务是独立长驻进程）；亦由下条「unify」PR 的存在反证——若两侧本就同源，便无需 unify。
- **「unify bundler & volar config」是对漂移的直接补救**：官方 changelog 有 `feat: unify bundler & volar config (#750)`（由 @sxzz 与 @zhiyuanzmj 贡献），目标是让两侧从同一份配置派生，消除手工双写。这正是本章「一份配置驱动两条管线」原理在工程上的落地动作。依据: GitHub「vue-macros/vue-macros · Releases」changelog PR #750。
- **粒度化类型插件**：IDE 侧可按需只加载单个宏的 volar 插件（如 `@vue-macros/volar/define-options`），只引入需要的类型支持。依据: Vue Macros 官方文档 defineOptions 的 Volar 用法 + 「Bundler Integration」scoped plugin 说明。
- **冲突宏需 scope 隔离**：`exportExpose`、`exportProps`、`exportRender` 这类会改写同一 SFC 导出语义的宏「不能同时使用，除非提供 scope」——通过 `include`/`exclude` glob 把不同宏限定到不同文件目录来化解冲突。依据: Vue Macros 官方文档「Bundler Integration」关于这三个宏 scope 的说明。

## 关键流程

```
用户写一份 Options（特性开关 + 每宏选项）
        │
        ├──物理落点 1──▶ 打包器配置 ──▶ unplugin 插件读取
        │                                   │
        └──物理落点 2──▶ tsconfig.vueMacros ─▶ @vue-macros/volar 读取
                                            │
        ┌───────────────────────────────────┘
        ▼
各侧用同一 schema 做 resolveOptions(用户输入, 框架版本)
        │  叠加默认层（opt-out 默认 + 版本感知默认）
        ▼
解析结果 { 宏名: { enabled, ...子选项 } }
        │
        ├──▶ 构建侧 registerBuildPipeline(resolved) ──▶ 注册对应 AST visitor
        └──▶ IDE 侧  registerIdePipeline(resolved)   ──▶ 注册对应虚拟代码生成器
        │
        ▼
两条管线各自按注册表工作，运行时互不通信
一致性靠「同一 schema + 同一默认逻辑」静态对齐，而非运行时同步
```
依据: 由 Vue Macros 官方文档「Configurations」「Bundler Integration」「Volar Configuration」三页的配置流拼合而得；resolveOptions 的「默认层 + 版本感知」依据同上「Disabled by Default」段落。

## 易混淆 / 边界 / 推断

- **事实**：特性开关不是「文档里的可选说明」，而是**门控两侧注册**的硬开关——一个 flag 决定构建侧是否注册变换器、IDE 侧是否注册虚拟代码生成器。依据: 官方文档 per-macro 的「plugin options」与「Volar Configuration」总是成对出现。
- **推断（标注为推断）**：「unify」的落地机制，可能是让 IDE 侧通过约定路径回读打包器配置、或生成中间产物，使两侧共享同一真相源。同一作者（zhiyuanzmj）的 TS Macro 工具在 marketplace 描述中明确提到「自动从 vite.config 加载并派生 volar 配置、把 userOptions 共享给 vite 插件」，可佐证这种模式的存在；但 vue-macros 自身的精确实现路径（回读 vs 生成 vs 仅共享 schema）**待查证源码**。依据: VS Code Marketplace「TS Macro」条目描述 + GitHub Releases changelog #750（机制为推断）。
- **推断（标注为推断）**：IDE 侧的版本感知默认所需的「框架版本」信息，可能从项目 `package.json` 解析得到（打包器侧同理），而非用户手填；官方文档的 `version` 字段标注「optional, detecting automatically」支持这一推断。依据: Vue Macros 官方文档「Configurations」`version` 字段注释。
- **易混淆点**：「默认全开」不等于「稳定契约」。默认集合会随官方编译器演进而收缩（如 3.3 后若干宏默认关闭），因此**显式写明开关比依赖默认更可靠**——尤其在团队多成员、多版本环境下。依据: 由「Disabled by Default when Vue >= 3.3」段落合理推得。
- **未理解 / 待查证**：PR #750 之后，`tsconfig.vueMacros` 块究竟是被废弃、退化为纯覆盖通道、还是仍为必须项——现有官方文档示例仍同时出现两处配置，未能从文档层面确认 unify 后的最终形态，需查源码或 release notes 细节确认。
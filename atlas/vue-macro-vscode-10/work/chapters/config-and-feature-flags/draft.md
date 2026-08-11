# 配置系统：一份配置驱动两条管线

> 本章属于 system 层。前置：双轨制（编译变换与 IDE 类型支持为何必须并存）。
> 学完你能：用一句话讲清「为什么一份配置必须同时驱动构建期变换和 IDE 类型——以及为什么这件事比看起来难」。

## 1. 为什么需要它（设计动机）

上一章我们把 vue-tsc 这条线捋顺了：同一套 Volar 虚拟代码逻辑既能喂给 IDE 给你智能提示，也能在命令行做 CI 门禁。看起来「一份虚拟代码逻辑服务多个出口」已经够整齐了。可还留着一个口子：用户到底怎么告诉两条管线「我要开哪些宏、每个宏用什么参数」？

想象你刚装上 vue-macros，在 vite.config 里写了 `VueMacros({ defineModels: true })`，build 一下，defineModels 生成的类型长得挺好。回到 VSCode 一打开 .vue 文件——defineModels 调用下面全是红线，TS 不认识这个名字。你以为是插件没装对，重装、重启、清缓存，红线依然在。

痛点不是「某个宏不会用」，而是：**我明明只配置了一次，为什么构建和编辑器像是两个世界**。

两条管线天然跑在不同进程里。打包器在你 build 时拉起，跑完就退；IDE 语言服务在 VSCode 里长驻。两者谁也读不到对方的配置上下文——打包器看不见 tsconfig 里那块 `vueCompilerOptions`，语言服务也不解析 vite.config。如果两条管线各读各的临时配置，漂移是必然的。这就需要一份**双方都认的配置契约**：把用户意图落到一个 schema 里，让两侧从同一份 schema 派生各自的注册表。

## 2. 核心思想

把一份声明式配置（一堆特性开关 + 每个宏的选项）当成两条独立管线的**唯一真相源**。构建侧和 IDE 侧各自跑一遍 `resolveOptions(用户输入, 框架版本)`，用同一个 schema、同一份默认逻辑，算出同一个解析结果，然后各派生各的注册表。

换句话说，**一致性不在运行时维护，而在构造期静态对齐**。只要两侧 schema 不变、默认逻辑不变，两条管线在数学上就不可能分裂。

## 3. 心智模型

配置系统其实是 5 个东西在协作：

- **Options**：用户写的那份对象。形状是「宏名 → 开关或带子选项的对象」，比如 `{ defineModels: true, setupSFC: { include: ['**/*.setup.vue'] } }`。这是用户唯一表达意图的地方。
- **Schema**：定义「合法的 Options 长什么样、每个宏的子选项是什么类型」。schema 是**契约**——两侧 consumer 必须共享同一份 schema 类型，否则谈不上对齐。
- **resolveOptions**：一个纯函数。吃 `(用户输入, 框架版本)`，吐「每个宏开没开、用什么参数」的解析结果。它做两件事：把用户没显式写的宏按默认策略补齐，再叠加一层版本感知默认。
- **两个 consumer**：`registerBuildPipeline(resolved)` 和 `registerIdePipeline(resolved)`，各自从 resolved 派生注册表。构建侧注册 AST 变换器，IDE 侧注册虚拟代码生成器。
- **两个物理落点**：用户的 Options 必须放在两个地方——打包器配置里（`VueMacros({...})`）和 tsconfig 里（`vueCompilerOptions.vueMacros: {...}`）。因为两条管线在不同进程里，谁也读不到对方的配置文件。

整条链路长这样：

```
用户 Options
   ├── 落点1：打包器配置 ──▶ unplugin 读取
   └── 落点2：tsconfig     ──▶ @vue-macros/volar 读取
                              │
                              ▼
       各侧跑 resolveOptions(用户输入, 框架版本)
                              │  叠默认层 + 版本感知默认
                              ▼
                    resolved { 宏: { enabled, ...opts } }
                              │
       ┌──────────────────────┴──────────────────────┐
       ▼                                             ▼
构建侧 registerBuildPipeline(resolved)     IDE 侧 registerIdePipeline(resolved)
注册 AST visitor                           注册虚拟代码生成器
```

关键不变量：**两条管线运行时不通信**。一致性完全靠「同一 schema + 同一默认逻辑」在构造期对齐。

## 4. 关键权衡

### 一份 schema、两个物理副本——换取两侧进程隔离

把 Options 同时放进打包器配置和 tsconfig，看起来很冗余。为什么不放一个中心位置让两边都来读？

因为放不下去。打包器在 build 时才启动、跑完就退；IDE 语言服务在 VSCode 里长驻。前者拿不到后者的 tsconfig 上下文（IDE 进程对构建工具不可见），后者也读不到前者的 vite.config（语言服务不解析构建配置）。把配置落到两个地方，换来的是两条管线**互不依赖、各自独立启动**——IDE 不必为了类型提示拉起打包器，打包器也不必依赖 TS 服务器。

化解的本质矛盾：**一份真相源的理想** 对 **两个进程天然读不到对方上下文的现实**。代价是两份配置必须靠工具或纪律同步，否则出现「开关漂移」——这正是后续「unify bundler & volar config」（PR #750）要解决的核心：让两侧从同一份用户输入派生，消除手工双写。

### 特性开关同时门控两侧注册——换取「开关与实现 1:1」

一个特性开关（比如 `defineModels: true`）不是「文档里的可选说明」，而是**同时**门控两侧的硬开关：构建侧注册对应的 AST 变换器，IDE 侧注册对应的虚拟代码生成器。开一个 flag，等于在两条管线里同时挂载对应的实现。

换来的是「开关与实现 1:1」的强一致——只要两侧 schema 同步，你不会出现「构建认、IDE 不认」的逻辑悖论。

代价是任一侧新增一个宏，必须双侧同时实现，否则该 flag 在缺实现的一侧沦为**哑开关**——用户以为开了，实则无声失效。化解的本质矛盾：**用户心智上的「一个特性」** 对 **工程上的「两个独立实现」**。开关给了用户统一的认知入口，工程的对称性要靠开发者纪律维护。

### 默认全开（opt-out）——换取零配置即用

官方策略是「All features are enabled by default except the following」——除少数行为激进的宏（setupSFC、exportProps、booleanProp 等），其余默认全开。换来的是「装上即用、零配置」——用户不用读完整本配置文档就能上手。

代价有两层：用户可能无意中启用了不想要的激进语法变换，打包产物里出现意料之外的代码；更隐蔽的是，**「默认集合」本身不是稳定契约**——它会随官方编译器演进而收缩（这条引出下一条权衡）。

化解的本质矛盾：**降低采用门槛** 对 **默认行为的可控性**。对工具型库来说，opt-out 几乎总是赢，但默认集合的不稳定是它必须接受的副作用。

### 版本感知默认——换取宏对官方能力的优雅让位

当检测到 Vue ≥ 3.3 时，`defineOptions`、`defineSlots` 等宏**默认关闭**——因为这些能力已被官方编译器原生支持，宏不再需要补位。换来的是「宏随官方收敛而自动退场」的优雅迁移：用户升 Vue 版本，宏自动让位于官方能力，不需要手动改配置。

代价是**默认行为依赖版本探测、对用户不透明**——同一份配置文件，在 Vue 3.2 项目里开着 defineOptions，在 Vue 3.3 项目里却悄悄关掉了。排查时极易困惑（「我明明没改配置，宏怎么不工作了」）。

化解的本质矛盾：**短期可用性**（宏作为编译器能力的补位）对 **长期收敛性**（宏应该随官方演进而退场）。版本感知默认把「宏是临时扩张」这一长期信号编码进了默认值——这正是下一章「根本权衡」会从更高视角展开的伏笔。

## 5. 最小原理演示

下面这段代码只演示「一份配置如何门控两条管线、漂移为何必然」。不演示真实的 AST 变换、虚拟代码生成、打包器适配。

```ts
// 共享 schema：契约本体。两个 consumer 必须共享同一份类型。
type MacroName = 'defineModels' | 'defineOptions' | 'setupSFC' | 'booleanProp'
type Options = Partial<
  Record<MacroName, boolean | { enabled?: boolean; [k: string]: unknown }>
>

// 版本感知默认：Vue ≥ 3.3 时，defineOptions 被官方原生支持，宏自动让位
const versionAwareDefaults: Record<MacroName, (vue: string) => boolean> = {
  defineModels: () => true,
  defineOptions: (vue) => compareVue(vue, '3.3') < 0,
  setupSFC: () => false,      // 行为激进，按反例默认关
  booleanProp: () => false,
}

function compareVue(a: string, b: string) {
  return a.localeCompare(b, undefined, { numeric: true })
}

// resolveOptions：纯函数。两侧 consumer 必须调用同一个函数，
// 保证「默认层 + 版本感知」这套逻辑只有一份实现。
function resolveOptions(input: Options, vueVersion: string) {
  const resolved = {} as Record<MacroName, { enabled: boolean; opts: Record<string, unknown> }>
  for (const name of Object.keys(versionAwareDefaults) as MacroName[]) {
    const userVal = input[name]
    const enabled =
      userVal === undefined
        ? versionAwareDefaults[name](vueVersion)   // 用户没写 → 走默认
        : typeof userVal === 'boolean'
          ? userVal                                 // 用户写了布尔 → 直接用
          : userVal.enabled ?? true                 // 用户写了对象 → 看 enabled
    resolved[name] = {
      enabled,
      opts: typeof userVal === 'object' ? userVal : {},
    }
  }
  return resolved
}

// 构建侧 consumer：从 resolved 派生 AST 变换器注册表。
function registerBuildPipeline(resolved: ReturnType<typeof resolveOptions>) {
  for (const [name, cfg] of Object.entries(resolved)) {
    if (cfg.enabled) console.log(`[build] register AST visitor for ${name}`)
  }
}

// IDE 侧 consumer：从 resolved 派生虚拟代码生成器注册表。
function registerIdePipeline(resolved: ReturnType<typeof resolveOptions>) {
  for (const [name, cfg] of Object.entries(resolved)) {
    if (cfg.enabled) console.log(`[ide] register virtual code generator for ${name}`)
  }
}

// 正常路径：用户只显式开 defineModels，项目是 Vue 3.2。
const r32 = resolveOptions({ defineModels: true }, '3.2')
registerBuildPipeline(r32)
registerIdePipeline(r32)
// [build] register AST visitor for defineModels
// [build] register AST visitor for defineOptions   ← 3.2 下版本感知默认开
// [ide]   register virtual code generator for defineModels
// [ide]   register virtual code generator for defineOptions

// 同一份用户 Options 换到 Vue 3.3 项目：defineOptions 默认关闭。
const r33 = resolveOptions({ defineModels: true }, '3.3')
registerBuildPipeline(r33)
// [build] register AST visitor for defineModels    ← 只剩用户显式开的
// defineOptions 不再注册：官方 3.3 已原生支持，宏自动让位。

// 漂移演示：用户在打包器配置里开了 setupSFC，tsconfig 里漏配。
const buildResolved = resolveOptions({ setupSFC: true }, '3.2')
const ideResolved   = resolveOptions({},             '3.2')
registerBuildPipeline(buildResolved)
registerIdePipeline(ideResolved)
// [build] register AST visitor for setupSFC        ← 用户显式开
// [ide]   ……setupSFC 没出现                         ← 用户没写，默认关
// 结果：build 会展开 setupSFC 文件，IDE 却全红线。契约破裂。
```

漂移的根因不是「谁有 bug」，而是**两侧 resolveOptions 的输入不同**——用户 Options 不同、或探测到的框架版本不同。运行时没有任何同步机制能救——契约必须在构造期就保证对齐。

## 6. 执行轨迹

输入：用户在 vite.config 里写 `{ defineModels: { namedcasts: true }, setupSFC: true }`，项目 Vue 版本 3.2。

步骤 1（物理落点）：用户必须把同一份意图也写到 tsconfig 的 `vueCompilerOptions.vueMacros` 里。假设两侧都写了同样的 Options（暂未漂移）。

步骤 2（解析）：两条管线各自调用 `resolveOptions({ defineModels: { namedcasts: true }, setupSFC: true }, '3.2')`：
- defineModels：用户写了对象 → enabled = true，opts = { namedcasts: true }
- setupSFC：用户写了 true → enabled = true
- defineOptions：用户没写 → 走版本感知默认，3.2 < 3.3 → 默认开
- booleanProp：默认关

两侧算出的 resolved 完全一致。

步骤 3（注册）：
- 构建侧为 defineModels、setupSFC、defineOptions 注册 AST visitor。build 时这三个宏的调用会被真实改写。
- IDE 侧为同名宏注册虚拟代码生成器。打开 .vue 文件时，defineModels 的调用会被翻译成对应的类型声明，喂给 TS 服务。

输出：构建产物正确、IDE 给出对应类型提示——双侧一致。

再演漂移：用户在打包器配置里写了 `setupSFC: true`，但 tsconfig.vueMacros 里漏配。
- 构建侧：`resolveOptions({ setupSFC: true }, '3.2')` → setupSFC.enabled = true → 注册变换器 → build 产物里 setupSFC 文件被展开成等价 SFC。
- IDE 侧：`resolveOptions({}, '3.2')` → setupSFC 走默认关 → 不注册虚拟代码生成器。
- 结果：build 通过，但 setupSFC 文件在 IDE 里全是红线——契约破裂。

一句话点透：**漂移不是运行时 bug，是构造期 schema 没对齐的必然后果**。

## 7. 教学简化说明

本章演示故意省略：真实的 AST 变换实现、真实的虚拟代码生成、打包器工厂对 Vite/Rollup/webpack 的 hook 适配、tsconfig 解析细节、include/exclude 的 glob 匹配引擎、版本探测从 `package.json` 解析的具体实现，以及「unify 两侧配置」的精确落地路径（PR #750 究竟是回读打包器配置、生成中间产物，还是仅共享 schema，待查源码）。这些都不演示原理，留给后续章节或实际工程。

## 8. 小结

契约已经落地：用户写一次 Options，两条管线各跑一次 resolveOptions，对称的注册表自然就长出来。换来的核心收益不是「省了一次配置」，而是**把一致性从运行时同步降级为构造期静态对齐**——只要 schema 不变，两侧在数学上不可能分裂。

可「数学上不可能」的前提是两侧 schema 真的同步——这恰恰是「unify」要补的洞。下一章「根本权衡：零运行时 vs 可调试性，以及宏的生态演进」会从更高的视角看：宏这种用编译期复杂度换运行时零开销的选择，长期代价究竟在哪、宏的生态如何随官方编译器演进而收敛退场。
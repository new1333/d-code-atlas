# volar：编译期能力的 IDE 镜像 · 源码精读

## 给 Writer 的教学钩子（必填，8 子项缺一不可）
- **用户痛点 / 场景**：你用了 defineModels、shortEmits、JSX 指令这些自定义宏，构建能过、页面能跑——但一打开编辑器满屏红线：类型检查器报「找不到 defineModels」「$defineProps 不存在」。原因很简单：宏只在编译期被改写器擦除/替换，而编辑器的类型服务根本不跑那套改写，它看到的是原始源码。没有一层 IDE 侧的补丁，宏的开发体验（补全、跳转、类型提示）就彻底废了。
- **一句话核心思想**：给每个宏造一个「只产类型、不产运行时」的影子实现，让编辑器读到的虚拟类型代码，与编译器改写后真正运行的代码语义对齐。
- **设计动机（为什么需要它）**：同一份源码有两个互不知情的消费者——构建期的运行时引擎、编辑期的类型检查器。改写器（transform）只服务前者：它把 defineModels 拆成 defineProps + defineEmits + 一个双向绑定 helper，产物是能跑的代码。但类型检查器看的是另一条管线（语言服务把 SFC 编译成一段合成的虚拟 TS 代码再喂给 TS），它从不见改写后的代码，所以必须在语言服务这一层再注入一次 props/emits 的类型。于是同一个宏有了两份实现，各自对准各自消费者的天然表达。**（承前去重）**：defineModels、shortEmits、JSX 指令、export-expose 等宏的「编译期改写原理」已在各自前置章讲透，本章**只看它们在 IDE 这一侧的新侧面**——同样的字段拆分、同样的指令识别，但落在虚拟类型代码上、完全不碰运行时 helper。Writer 切勿把前置章讲过的 transform 逻辑在本章重演，本章的主角是「为什么要再写一遍、以及这一遍有何不同」。
- **关键权衡（本 Atlas 的核心）**：
  1. **两套实现并存 → 换来运行时与类型服务各得其所（一个产出能跑的代码、一个产出能通过检查的类型）→ 代价是同一段字段拆分/指令识别逻辑要手写两遍，且必须人工保持同步；每新增一个宏都要在两边同时维护**。这是全章灵魂权衡。
  2. **IDE 影子只产出类型声明、不注入任何运行时 helper → 换来影子实现远比 transform 简单（不用管双向绑定 helper、赋值表达式改写、解构别名）→ 代价是它只保证「类型对」，不保证「运行时行为对」**——影子能让补全通过，但运行时正确性仍由 transform 兜底。
  3. **影子寄生在语言服务合成的虚拟代码结构上（靠正则锚点定位合成选项对象、并随框架大版本切换注入点）→ 换来不必重写整套 SFC→TS 管线，只做局部插入 → 代价是强耦合语言服务的内部约定，框架或语言服务升级时注入点要跟着改**。
  4. **能白嫖语言服务内置能力的就白嫖（别名类宏只往原生宏注册表塞一个名字，零逻辑）→ 换来这类宏几乎免费获得原生补全 → 代价是只有「换名字」级别的宏能这样做，凡是真正改写语义的宏（如合成 props+emits 的）都必须自己实现影子**。
- **最小心智模型（3～7 步）**：
  1. 编辑器打开一个 .vue，语言服务先把它编译成一段合成的虚拟 TS 代码（一堆带内部前缀的合成类型 + 一个合成的组件选项对象）。
  2. 在虚拟代码定稿前，语言服务依次调用所有已注册插件的「内嵌代码钩子」，给每个插件改写这段虚拟代码的机会。
  3. defineModels 的影子插件被调用：它回到**原始** script setup 的语法树，重新定位 `defineModels<T>()` 这个调用（注意——它不从 transform 产物读，而是从源码重新读）。
  4. 把类型参数 T 的每个字段拆成两份：一份进 props 类型、一份进 `update:字段` 事件类型。
  5. 用正则锚点把这两份类型插进虚拟代码的 props 类型别名与合成选项对象里。
  6. 类型检查器最终拿到的虚拟代码已含 props/emits 类型 → 补全 `v-model:字段`、检查事件载荷全部通过。
  7. 与此**并行**，构建期的改写器对同一份源码做运行时改写产出能跑的代码；两条路独立、消费者不同、互不通信。
- **最小原理演示（替代旧"复刻范围"）**：
  - **应演示**：一个迷你「双路改写器」。输入一段含伪宏的源码 `magic<{ a: string; b?: number }>()`，用两个纯函数分别产出：(A) `transformForRuntime` —— 改写成原生宏调用 + 注入一个双向绑定 helper（模拟运行时路径）；(B) `transformForIDE` —— 只往一段模拟的「合成虚拟代码」里插入 props/emits 的**类型声明**，零 helper、零赋值改写（模拟 IDE 影子路径）。把两条输出并排打印，直观看到「同一份源、两套实现、两个消费者、影子明显更瘦」。每一步都要对应上面某条权衡：A 的「重」对应权衡 2 中 transform 要管的事，B 的「瘦」对应影子省掉的事；两函数里重复出现的「字段拆分」对应权衡 1 的同步代价；B 里用正则往合成选项里塞类型对应权衡 3 的寄生。
  - **应故意省略**：语言服务真实的虚拟代码全貌、框架大版本分支的完整差异、HMR、二十个子插件的完整装配表、JSX 指令的完整分桶遍历（已在 JSX 指令前置章讲透）。
  - **演示载体建议**：本仓库是 TS 仓库，写成能 `node`/`bun` 直接跑的独立脚本即可，**不必真接语言服务**——用一段带注释的占位字符串模拟「合成虚拟代码」和「合成选项对象锚点」，两个纯函数对它做字符串/数组插入就够演透原理。载体服务于「演透两套实现」，不服务于「能跑真插件」。
- **正文不宜展开的细节**：虚拟代码协议版本号（2.1）的来历、语言服务插件类型签名的完整定义；框架 3.5 前后 `__typeProps`/`__typeEmits` 与旧式 `props`/`emits` 降级 helper 的完整对照（点到「注入点随版本切换」即可）；二十个子插件逐个清单（举 defineModels、JSX 指令、别名委托三类代表即可）；SFC block 偏移修补、往 setup 内插代码等边角工具的次要用途。
- **推荐的一个执行轨迹例子**：
  - 输入：`defineModels<{ msg: string; count?: number }>()`
  - IDE 影子侧中间态：拆字段 → props=`["msg: string", "count?: number"]`、emits=`["'update:msg': [msg: string]", "'update:count': [count?: number]"]`
  - 注入后：虚拟代码里出现 `msg: string; count?: number` 的 props 类型、对应两个 update 事件的 emits 类型
  - 输出（IDE 侧）：编辑器对 `<Comp v-model:msg="..." />` 给出正确补全、对 `@update:count` 校验载荷类型 —— 全程没有任何运行时 helper 介入
  - 对照（transform 侧，并行）：额外注入双向绑定 helper、把对 model 变量的赋值改写成触发 emit —— 这一整套影子侧完全没有

> 以上钩子供 Writer 写「动机→核心思想→心智模型→关键权衡→原理演示」；下面事实部分供核对，不要被 Writer 当目录照抄。

## 概念要点
- volar 包是一个独立的语言服务插件（`@vue/language-core` 的 `VueLanguagePlugin`），**不是** unplugin transform；主聚合包只是 re-export 它作为独立入口。源码位置: packages/macros/src/volar.ts:1-4、packages/volar/src/index.ts:22
- 主入口把 20 个子插件（每个宏一个）组成一张表，用 `flatMap` 逐个实例化；通过 `getVolarOptions(ctx, name)` 读取该宏的配置项，为 falsy 则跳过（即该宏未启用）。源码位置: packages/volar/src/index.ts:24-54
- 实例化时还会把每项配置回写到 `ctx.vueCompilerOptions.vueMacros`，使下游子插件（如 jsx-directive）能从 `vueCompilerOptions.vueMacros.jsxDirective` 读到默认值，而不必重复解析。源码位置: packages/volar/src/index.ts:51-52、packages/volar/src/jsx-directive.ts:10
- `getVolarOptions` 按 `configFilePath` 所在目录做 key、用 `Map` 缓存 `resolveOptions` 的结果，避免 20 个子插件各调一次配置解析。源码位置: packages/volar/src/common.ts:124-140
- **两个钩子的分工**（核心事实）：
  - `resolveEmbeddedCode(fileName, sfc, embeddedFile)` 服务于 .vue 内嵌的宏（defineModels/defineOptions/defineSlots/export-*/defineProp/defineEmit/defineGeneric/setup-jsdoc 等几乎全部 SFC 宏）——即改写语言服务为 script setup 生成的内嵌虚拟代码。源码位置: packages/volar/src/define-models.ts:78
  - `resolveVirtualCode({ filePath, ast, codes, lang })` 仅服务于独立的 .tsx/.jsx 文件宏（jsx-directive、jsx-ref），改写的是独立虚拟文件而非 .vue 内嵌块。源码位置: packages/volar/src/jsx-directive.ts:19
  - 全包 Grep 证实：除 jsx 两兄弟外，其余子插件全部走 resolveEmbeddedCode。源码位置: packages/volar/src/ 下 version:2.1 与两个钩子的分布（见 jsx-directive.ts:19 为唯一 resolveVirtualCode 入口之一）
- `common.ts` 的 `addProps`/`addEmits` 是所有 SFC 类型注入类宏共享的工具，它们**寄生**在语言服务合成的虚拟代码结构上：用正则锚点 `REGEX_DEFINE_COMPONENT` 定位合成的 `defineComponent({...})` 选项对象，再往里塞 props/emits 字段。源码位置: packages/volar/src/common.ts:12-13、15-108
- **版本分支**（框架 3.5 前后注入点不同）：>=3.5 直接用 `__typeProps: {} as __VLS_PublicProps` / `__typeEmits: {} as __VLS_Emit`；<3.5 则需降级 helper 类型 `__VLS_TypePropsToOption` / `__VLS_NormalizeEmits` 把类型转成运行时 props 选项形态。源码位置: packages/volar/src/common.ts:29-49、91-105
- **define-models 影子**：从原始 scriptSetup 的语法树重新定位 `defineModels<T>()` 或 `$defineModels<T>()` 调用、取出类型参数 T，遍历 T 的每个属性签名，拆成 `name?: type`（props）与 `'update:name': [name: type]`（emits）两份字符串，再调 addProps/addEmits 注入。源码位置: packages/volar/src/define-models.ts:23-37、39-64
- **与 transform 端的对照**（坐实「两套实现」）：transform 端（packages/define-models/src/core/index.ts）做同样字段拆分，但落在**真实源码**上、用 babel AST，且额外处理 runtime/reactivity-transform 双模式、解构别名、对 model 变量赋值表达式的 walkAST 改写、运行时 helper 注入；影子端用 typescript AST、落在虚拟代码上、只产类型、完全没有这些运行时逻辑。两边的「字段拆分」表达式几乎逐行对应却各自独立存在。源码位置: packages/define-models/src/core/index.ts:144-197、199-311；packages/volar/src/define-models.ts:23-37
- **别名委托策略**：define-props 影子几乎不实现任何逻辑，只把 `$defineProps` 这个名字 push 进语言服务的原生宏注册表 `ctx.vueCompilerOptions.macros.defineProps`，让语言服务内置的 defineProps 处理逻辑顺便认得这个别名——这是「能白嫖就白嫖」的典型，对应权衡 4。源码位置: packages/volar/src/define-props.ts:3-12
- **jsx-directive 影子**：用 `ts-macro` 的 `createPlugin` 包装，钩子 resolveVirtualCode 调 `transformJsxDirective`；其 `walkJsxDirective` 遍历 AST 按指令类型分桶收集（v-if/v-for/v-model/v-slot/v-on/v-bind/ref/v-slots/自定义指令）后各自改写——与 transform 端（packages/jsx-directive/src/core）是**各写一份**的平行实现。源码位置: packages/volar/src/jsx-directive.ts:6-30、packages/volar/src/jsx-directive/index.ts:27-235

## 关键调用链
IDE 侧 defineModels 注入链：
index.ts 主插件(ctx) → flatMap 对每个子插件调 getVolarOptions(ctx,name) 取配置 → 命中则 调 defineModels(ctx,options) → 返回 {resolveEmbeddedCode} → 语言服务生成内嵌虚拟代码时回调 resolveEmbeddedCode(fileName,sfc,embeddedFile) → getTypeArg(ts,sfc) 在原始 scriptSetup AST 里找 defineModels<T> → transformDefineModels 拆字段 → addProps/addEmits → 用 REGEX_DEFINE_COMPONENT 正则改写 embeddedFile.content（__VLS_PublicProps 类型别名 + 合成 defineComponent 选项）→ TS 语言服务消费最终虚拟代码
源码位置: packages/volar/src/index.ts:47-54、packages/volar/src/common.ts:126-140、packages/volar/src/define-models.ts:75-97、packages/volar/src/common.ts:15-108

JSX 指令影子链（独立 tsx 路径，对比用）：
jsx-directive(ctx,options) → createPlugin → resolveVirtualCode({filePath,ast,codes,lang}) → transformJsxDirective → walkJsxDirective 分桶 → 各 transformV*  改写 codes
源码位置: packages/volar/src/jsx-directive.ts:17-29、packages/volar/src/jsx-directive/index.ts:27-235

## 源码摘录（带行号，全文累计 ≤ 30 行）
主入口：按配置逐个实例化子插件（装配 + 跳过未启用）：
```ts
// packages/volar/src/index.ts:47-54
const plugin: VueLanguagePlugin = (ctx) =>
  Object.entries(plugins).flatMap(([name, plugin]) => {
    const options = getVolarOptions(ctx, name as keyof typeof plugins)
    if (!options) return []
    ;(ctx.vueCompilerOptions.vueMacros ??= {})[name as keyof typeof plugins] ??=
      options as any
    return plugin(ctx, options as any) as ReturnType<VueLanguagePlugin>
  })
```

define-models 影子的字段拆分（与 transform 端逐行对应、却只产类型字符串，坐实权衡 1+2）：
```ts
// packages/volar/src/define-models.ts:26-36
        const type = getText(member.type, ast, ts)
        const name = getText(member.name, ast, ts)
        emitStrings.push(`'update:${name}': [${name}: ${type}]`)
        propStrings.push(`${name}${member.questionToken ? '?' : ''}: ${type}`)
  addProps(codes, propStrings, version)
  addEmits(codes, emitStrings, version)
```

合成选项对象的正则锚点（寄生在语言服务虚拟代码结构上，权衡 3）：
```ts
// packages/volar/src/common.ts:12-13
export const REGEX_DEFINE_COMPONENT: RegExp =
  /(?<=(?:__VLS_|\(await import\(\S+\)\)\.)defineComponent\(\{\n)/g
```

addProps 的版本分支注入点（框架 3.5 前后不同，权衡 3 的代价）：
```ts
// packages/volar/src/common.ts:36-42
    replaceAll(
      codes,
      REGEX_DEFINE_COMPONENT,
      version >= 3.5
        ? '__typeProps: {} as __VLS_PublicProps,\n'
        : 'props: {} as __VLS_TypePropsToOption<__VLS_PublicProps>,\n',
    )
```

别名委托：define-props 影子只塞一个名字、零逻辑（权衡 4）：
```ts
// packages/volar/src/define-props.ts:6-11
  ctx.vueCompilerOptions.macros.defineProps.push('$defineProps')
  return {
    name: 'vue-macros-define-props',
    version: 2.1,
  }
```

JSX 指令走的是另一类钩子（独立 tsx/jsx，非 .vue 内嵌）：
```ts
// packages/volar/src/jsx-directive.ts:19-21
        resolveVirtualCode({ filePath, ast, codes, lang }) {
          if (!filter(filePath) || !['jsx', 'tsx'].includes(lang)) return
```

## 易混淆 / 边界 / 推断
- **事实**：影子插件从**原始 scriptSetup AST** 重新定位宏调用（如 getTypeArg 重新找 defineModels），并不读取 transform 的产物——两条管线输入相同（源码）、输出不同（运行时代码 vs 虚拟类型代码）、互不通信。源码位置: packages/volar/src/define-models.ts:39-64
- **事实**：所有子插件统一声明 `version: 2.1`（虚拟代码协议 v2.1）；addProps/addEmits 内部用 `codes.toString()` 做幂等判断（已注入过就不再注入），支持多个宏叠加改写同一段虚拟代码。源码位置: packages/volar/src/common.ts:20、29-35
- **推断（标注为推断）**：把配置回写到 `vueCompilerOptions.vueMacros`（index.ts:51-52）是为了让 jsx-directive 这类用 `createPlugin` 包装、且需要读「是否启用」默认值的子插件能拿到统一配置——即主入口承担了「配置分发」职责，子插件不必各自再解析。
- **推断（标注为推断）**：影子端对框架 3.5 切换注入点（`__typeProps`/`__typeEmits` 取代旧式降级 helper），是因为 3.5 原生支持基于类型的 props/emits、语言服务不再生成需要降级的运行时选项形态；影子必须紧跟语言服务的这一内部约定，这正是权衡 3「强耦合内部约定」的具体表现。
- **未理解**：`patchSFC`（common.ts:142-151）调整 SFC block 的 loc 偏移的具体使用场景未在 4 个 sourceFiles 内见到调用方，推断用于某些需要在语言服务阶段重定位源码区间的子插件（如 setup-sfc/script-sfc 类结构扩展宏），但本章 sourceFiles 未覆盖其调用，留待 Writer 谨慎处理或核实。
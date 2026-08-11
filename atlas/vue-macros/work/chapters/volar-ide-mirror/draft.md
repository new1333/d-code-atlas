# volar：编译期能力的 IDE 镜像

> 本章属于 system 层。前置：props/emit 宏的编译期重写与类型转换、defineModels：从类型合成 props/emits 双向绑定、better-define：把 TS 类型降级为运行时校验、突破单 script setup 的 SFC 结构扩展、在 JSX 里镜像 Vue 模板指令、静态提升与 export 语义重写、为旧版本补齐与简化样板的语法垫片。
> 学完你能：用一句话说清「为什么同一个宏要写两份实现、一份给构建器一份给 IDE，以及为什么这两份不会合成一份」。

## 1. 为什么需要它（设计动机）

上一章把所有宏按精心设计的顺序串成了一条 transform 管道——它把源码从「带自定义宏的写法」一步步改写成「只剩原生 Vue 宏的能跑代码」，服务的是**构建期**。但这条管道留下的一个口子正是本章的入口：构建期能跑、不等于编辑器里不报红。

想象一下你写了这么一行：

```vue
<script setup lang="ts">
const models = defineModels<{ msg: string; count?: number }>()
</script>
```

构建时 `defineModels` 被 transform 拆成 `defineProps` + `defineEmits` + 一个 `useVModel` helper，能跑。但你一打开 VSCode，IDE 在 `defineModels` 下面画一条红波浪线：「找不到名称 defineModels」。`v-model:msg` 的补全也不出来，因为 IDE 觉得这个组件根本没声明 `msg` 这根 prop。

矛盾在哪？同一份源码有两个消费者，它们看的是**两条互不知情的管线**：

- **构建期引擎**：跑 transform，看的是源码改写后的产物
- **编辑期类型服务**（Volar 把 .vue 编译成一段合成的虚拟 TS 代码喂给 tsserver），**完全不跑 transform**，看的是原始源码

transform 只服务第一个消费者。第二个消费者看到的源码里 `defineModels` 还在原地——它当然不知道这名字是干嘛的。要补上这一侧，只能在语言服务的虚拟代码生成阶段，再注入一次 props/emits 的类型。同一段字段拆分逻辑，必须**在两个地方各写一遍**，每遍对准各自消费者的天然表达。

## 2. 核心思想

**给每个自定义宏造一个"只产类型、不产运行时"的影子实现，让 IDE 读到的虚拟类型代码，与编译器改写后真正运行的代码语义对齐。**

影子不是 transform 的复用、也不是它的派生——它是一条**独立的第二条实现**，输入都是源码、输出形态完全不同：transform 输出能跑的 JS 代码，影子输出能通过类型检查的类型声明。两条路并行、各自服务各自主子、互不通信。

## 3. 心智模型

编辑器打开一个 .vue 文件时，背后发生的事分成两条平行轨道：

**轨道 A：构建期 transform（前置章已讲透）**

源码 → unplugin transform 链 → `defineModels` 被改写成 `defineProps` + `defineEmits` + `useVModel` 调用 → 产物给 bundler → 浏览器跑

**轨道 B：编辑期语言服务（本章主角）**

源码 → Volar 的 `@vue/language-core` 把 SFC 编译成一段合成的虚拟 TS 代码（一堆带 `__VLS_` 前缀的内部类型 + 一个合成的 `defineComponent({...})` 选项对象）→ 在虚拟代码定稿前，语言服务依次调用所有已注册插件的「内嵌代码钩子」（`resolveEmbeddedCode`）→ 影子插件拿到钩子机会，回到**原始** scriptSetup 的语法树，重新找一次 `defineModels<T>()` 调用 → 把类型参数 T 每个字段拆成两份：一份塞进虚拟代码的 props 类型别名、一份塞进 emits 类型 → tsserver 拿到的虚拟代码已经含完整 props/emits 类型 → 补全 `v-model:msg`、检查 `@update:count` 载荷全部通过。

注意第 4 步那个"重新找一次"——影子插件**不从 transform 产物读**，它从原始源码自己重新解析一遍 `defineModels<T>`。两条轨道输入相同（同一份源码），输出完全不同，互不通信。

## 4. 关键权衡

### 4.1 同一段逻辑写两遍，换运行时与类型服务各得其所

这是全章的灵魂权衡。字段拆分这件事——`{ msg: string; count?: number }` 拆成 props 数组和 emits 数组——在 transform 端写过一次（前置章 defineModels 的 `packages/define-models/src/core/index.ts`），在 volar 端**几乎逐行对应地又写了一次**（`packages/volar/src/define-models.ts`）：

```ts
// volar 影子端的拆分（packages/volar/src/define-models.ts:26-36）
const type = getText(member.type, ast, ts)
const name = getText(member.name, ast, ts)
emitStrings.push(`'update:${name}': [${name}: ${type}]`)
propStrings.push(`${name}${member.questionToken ? '?' : ''}: ${type}`)
```

对比 transform 端的同一段——它做同样的事，但落在真实源码上、用 babel AST、还要追加 runtime/reactivity-transform 双模式分支、解构别名、对 model 变量赋值表达式的 walkAST 改写、运行时 helper 注入。**字段拆分**这一行两边几乎可以并排对照读，但周边的"重活"只在 transform 端存在。

**换来**：每个消费者拿到的都是它最自然能消费的形态——bundler 拿到能跑的 JS、tsserver 拿到能类型检查的合成类型代码。没有任何一方被迫做它不擅长的事。

**代价**：每新增一个宏都要在两边同时维护，且两边必须**人工保持语义同步**。哪天 transform 端把字段拆分规则改了（比如支持只读 model），影子端必须跟着改，否则 IDE 提示会和实际运行行为分叉——这是没有任何编译期或测试自动化能兜底的，完全靠流程纪律。

### 4.2 影子只产类型不产 helper，换实现远比 transform 简单

回看轨道 B 第 5-6 步：影子只往虚拟代码里插**类型声明**——`msg: string` 这样的类型别名、`'update:msg': [msg: string]` 这样的事件签名。它**完全不碰**这些 transform 必须管的事：

- 双向绑定 helper 的 import 和调用（`useVModel(props, emit)`）
- 对 model 变量赋值表达式的 walkAST 改写（`models.msg = x` → `models.msg.value = x` 或触发 emit）
- 解构别名（`const { msg: text } = models`）
- runtime 模式返回 ref、reactivity-transform 模式赋值即触发 emit 的双模式分支

**换来**：影子实现能瘦到几十行。一个宏在 transform 端要 300 行的逻辑，影子端常常只要 60 行就够——因为它只需要保证"类型对"，不需要保证"运行时行为对"。

**代价**：影子只能让补全和类型检查通过，**运行时正确性仍由 transform 兜底**。换句话说，如果哪天影子端有 bug 把类型拆错了，IDE 不会报错（甚至给出错误的补全），但页面跑起来会出问题——这种"类型对、行为错"的失败模式比"类型错、IDE 报红"更难发现。影子的简化是一种**不对称的责任分配**：它把难的那一半责任（保证运行时正确）全部留给 transform，自己只挑简单的那一半。

### 4.3 寄生在语言服务合成的虚拟代码结构上，换不重写整套管线

影子要往虚拟代码里插 props 类型，但虚拟代码是 Volar 的语言服务**自己合成**的——长什么样、用什么前缀、什么结构，都是语言服务的内部约定。影子选择**不做任何重写**，而是用一个正则锚点定位语言服务已经合成出来的 `defineComponent({...})` 选项对象，再往里面塞字段：

```ts
// packages/volar/src/common.ts:12-13
export const REGEX_DEFINE_COMPONENT: RegExp =
  /(?<=(?:__VLS_|\(await import\(\S+\)\)\.)defineComponent\(\{\n)/g
```

这个正则在说："找到 `__VLS_defineComponent({` 后面那个换行符的位置，从这个位置往后插入"。`addProps` 就用 `replaceAll` 把一行 `__typeProps: {} as __VLS_PublicProps,\n` 插进这个锚点。

**换来**：影子完全不必重写「SFC → 虚拟 TS 代码」这套庞大管线（Volar 内部数千行），它只需要在管线产出物的特定位置做**局部字符串插入**。这是为什么 20 个子插件能用不到一千行 common 代码支撑起来——它们都是同一种"在合成选项对象里塞一行"的模式。

**代价**：强耦合语言服务的内部约定。Vue 3.5 之前，语言服务用降级 helper `__VLS_TypePropsToOption` 把类型转成运行时 props 选项形态；3.5 开始直接用 `__typeProps` / `__typeEmits` 形态——注入点必须跟着切换：

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

这是寄生关系的必然代价——宿主（语言服务）的内部约定一变，寄生物（影子）的注入点就要跟着改。这个分支版本号写死在 common 里，没有任何抽象能消除。

### 4.4 能白嫖语言服务内置能力的就白嫖，换零逻辑获得原生补全

并非所有宏的影子都得自己实现字段拆分。`$defineProps` 这种「只是 defineProps 的别名」的宏，影子做了一件极简的事——把名字塞进语言服务**已有的**原生宏注册表：

```ts
// packages/volar/src/define-props.ts:6-11
ctx.vueCompilerOptions.macros.defineProps.push('$defineProps')
return {
  name: 'vue-macros-define-props',
  version: 2.1,
}
```

注意这个 `return` 里**只有 name 和 version，没有任何钩子**——这个影子插件不做任何代码改写。语言服务内置的 `defineProps` 处理逻辑顺便就认得了 `$defineProps` 这个名字，所有原生补全、类型推断白送。

**换来**：这类"换名字"级别的宏几乎**免费**获得 IDE 体验，零字段拆分、零注入、零维护成本。

**代价**：只有"换名字"级别的宏能这样做。凡是真正**改写语义**的宏——比如 `defineModels` 同时合成 props 和 emits——就没法白嫖，因为语言服务内置逻辑里压根没有「同时合成两份」的概念，必须自己实现影子。所以 volar 包里 20 个子插件实际分成两类：极少数白嫖派（define-props 一个），绝大多数自实现派（define-models、jsx-directive、short-emits 等）。这种二八分布本身就在告诉你：「白嫖」是少数幸运情况，多数时候"两套实现"的硬代价是逃不掉的。

## 5. 最小原理演示

下面这段脚本不接真语言服务、不接真 Volar，只用两个纯函数演透「同一份源、两套实现、两个消费者、影子明显更瘦」。把「合成虚拟代码」用一段带注释的占位字符串模拟，注入操作就是字符串拼接。

```ts
type FieldDef = Record<string, { optional: boolean; type: string }>

// 输入：源码里一段伪宏调用（模拟 defineModels<{ msg: string; count?: number }>()）
const sourceMagicCall: FieldDef = {
  msg:   { optional: false, type: 'string' },
  count: { optional: true,  type: 'number' },
}

// ──────────────────────────────────────────────
// 轨道 A：transform 端 —— 产出能跑的代码
// ──────────────────────────────────────────────
function transformForRuntime(fields: FieldDef): string {
  // 字段拆分：两边都做这件事
  const propNames = Object.entries(fields).map(
    ([n, f]) => `${n}${f.optional ? '?' : ''}: ${f.type}`,
  )
  const emitNames = Object.entries(fields).map(
    ([n, f]) => `'update:${n}': [${n}: ${f.type}]`,
  )

  // transform 独有的活：注入双向绑定 helper（影子侧完全没有）
  const helperImport = `import { useVModel } from 'vue-macros/runtime'`

  // transform 独有的活：把 model 变量的赋值改写成触发 emit
  // （这里用 setter 模拟，真实实现是 walkAST 改写赋值表达式）
  const refBindings = Object.keys(fields)
    .map(n => `  get ${n}() { return __v.${n} }, set ${n}(v) { __emit('update:${n}', v) }`)
    .join('\n')

  return `${helperImport}
export const __props = defineProps<{ ${propNames.join('; ')} }>()
export const __emit = defineEmits<{ ${emitNames.join('; ')} }>()
export const __v = useVModel(__props, __emit)
export const models = {
${refBindings}
}`
}

// ──────────────────────────────────────────────
// 轨道 B：volar 影子端 —— 只产出类型声明，插进合成虚拟代码
// ──────────────────────────────────────────────
function transformForIDE(fields: FieldDef): string {
  // 字段拆分：和 transform 端逐行对应——这是「两套实现」最直观的证据
  const propNames = Object.entries(fields).map(
    ([n, f]) => `${n}${f.optional ? '?' : ''}: ${f.type}`,
  )
  const emitNames = Object.entries(fields).map(
    ([n, f]) => `'update:${n}': [${n}: ${f.type}]`,
  )

  // 影子独有的"寄生"动作：往语言服务合成的 defineComponent 选项里插一行类型
  // 真实实现用 REGEX_DEFINE_COMPONENT 正则定位锚点，这里用字符串替换模拟
  const syntheticVirtualCode = [
    '/* 由 Volar 合成的虚拟代码起点 */',
    'const __VLS_Component = (await import("vue")).defineComponent({',
  ].join('\n')

  const injected = syntheticVirtualCode.replace(
    /(defineComponent\(\{\n)/,
    `$1  __typeProps: {} as { ${propNames.join('; ')} },\n` +
      `  __typeEmits: {} as { ${emitNames.join('; ')} },\n`,
  )

  // 注意：没有 helper import、没有 ref setter、没有 walkAST 改写
  return injected
}

// ──────────────────────────────────────────────
// 把两条轨道的输出并排打出来
// ──────────────────────────────────────────────
console.log('=== 轨道 A：transform 产物（给 bundler）===')
console.log(transformForRuntime(sourceMagicCall))
console.log()
console.log('=== 轨道 B：影子产物（给 tsserver）===')
console.log(transformForIDE(sourceMagicCall))
```

跑一遍就能直观看到：transform 端的产物有 import、有 setter、有 useVModel、有 emit 调用，密密麻麻二十多行；影子端的产物只有一行类型声明、两行注入、总共不到十行。**两边共同的部分是「字段拆分」那两行**——那正是同步维护代价的具象化。

## 6. 执行轨迹

拿一个具体输入走一遍 IDE 轨道，看每一步内部状态怎么变。

**输入源码**（用户在 .vue 文件里写）：

```vue
<script setup lang="ts">
const models = defineModels<{ msg: string; count?: number }>()
</script>
```

**步骤 1**：用户在 VSCode 里打开这个 .vue。Volar 语言服务把 SFC 编译成虚拟 TS 代码（节选关键部分）：

```ts
// 合成虚拟代码（注入前）
const __VLS_Component = (await import("vue")).defineComponent({
  // 这里原本是空的
})
```

**步骤 2**：虚拟代码定稿前，语言服务回调所有插件的 `resolveEmbeddedCode` 钩子。define-models 影子插件被调用。

**步骤 3**：影子在**原始 scriptSetup 的 AST**里搜 `defineModels<T>()` 这个调用，拿到类型参数 T = `{ msg: string; count?: number }`。中间态：

```
propStrings  = ["msg: string", "count?: number"]
emitStrings  = ["'update:msg': [msg: string]", "'update:count': [count?: number]"]
```

**步骤 4**：`addProps(codes, propStrings, version)` 用 `REGEX_DEFINE_COMPONENT` 正则定位合成选项对象的注入点，把 `__typeProps: {} as { msg: string; count?: number }` 塞进去。`addEmits` 同理塞 emits。

**步骤 5**：注入后的合成虚拟代码：

```ts
const __VLS_Component = (await import("vue")).defineComponent({
  __typeProps: {} as { msg: string; count?: number },
  __typeEmits: {} as { 'update:msg': [msg: string]; 'update:count': [count?: number] },
})
```

**步骤 6**：tsserver 消费这段虚拟代码。用户在 template 里写 `<Comp v-model:msg=... />`，IDE 知道这个组件有 `msg` 这根 prop 和 `update:msg` 这个事件——补全弹出、类型检查通过。

**对照（并行轨道 A）**：在用户按下保存的同一时刻，构建器的 unplugin transform 链也在跑，对**同一份源码**做完全不同的事——它注入 `useVModel` helper、把对 `models.msg` 的赋值改写成触发 `emit('update:msg', v)`。影子侧完全没有这一整套。两条轨道并行、互不通信、各自交付给各自的消费者。

## 7. 教学简化说明

本章演示故意省略了这些：

- **真实虚拟代码全貌**：Volar 合成的虚拟代码有数千行（含 `__VLS_PublicProps`、`__VLS_TypePropsToOption` 等几十个内部类型），演示只用 2 行占位字符串模拟，足够演透「插入」这个动作。
- **框架 3.5 前后降级 helper 的完整对照**：3.5 之前 `props: {} as __VLS_TypePropsToOption<__VLS_PublicProps>`、3.5 及之后 `__typeProps: {} as __VLS_PublicProps`，演示只用了后者一种形态。
- **20 个子插件的完整装配表**：演示只演 defineModels 一类（自实现派），正文里举了 define-props（白嫖派）作为对照。
- **JSX 指令的完整分桶遍历**：jsx-directive 影子走的是 `resolveVirtualCode` 钩子（服务独立 .tsx/.jsx 文件，不是 .vue 内嵌块），其分桶遍历逻辑已在 JSX 指令前置章讲透，本章不重演。
- **HMR、`patchSFC` 偏移修补等边角工具**：与「两套实现」主线无关，本章不展开。

## 8. 小结

宏的双轨制不是设计冗余，是消费者的天然分工逼出来的——tsserver 永远不会跑 transform，所以要么放弃 IDE 体验、要么在语言服务这一层再写一遍。影子挑了"只产类型、不产 helper"那条最瘦的路径，并寄生在语言服务合成的虚拟代码结构上换最小代码量。代价是同步维护——每新增一个宏，先在 transform 端写完字段拆分，再到 volar 端把同样的拆分用类型字符串重写一遍。

下一章会把这套宏体系带出 vue-macros 自身的工程范围——看它怎么被装配进 Nuxt 模块、Astro Islands、独立 DevTools 面板这些更高层的框架上下文。
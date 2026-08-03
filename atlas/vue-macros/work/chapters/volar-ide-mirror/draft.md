# 第十五章 volar：编译期能力的 IDE 镜像

## 15.1 一个让人困惑的场景：构建通过、编辑器全红

你写了：

```vue
<script setup lang="ts">
const models = defineModels<{
  msg: string
  count?: number
}>()
</script>
```

dev server 重启、HMR 一切正常、`<ChildComp v-model:msg="x" v-model:count="n" />` 双向绑定工作得很好。你回到编辑器，准备再加一个字段——结果 `defineModels` 这五个字下面是红色波浪线：「Cannot find name 'defineModels'.」

构建器和编辑器好像活在两个宇宙。同一份代码、同一个文件，构建器说它没问题，编辑器说它根本不认识这个函数。

这不是 bug，是设计上的必然。**宏只在编译期被改写器擦掉**——前几章你已经看过 defineModels 在 transform 端被拆成 defineProps + defineEmits + 一个双向绑定 helper，真正跑的代码是改写之后的形态。但**编辑器里的类型检查器压根不跑这套改写**。它读到的就是源码里那行 `defineModels<{...}>()`，对这个函数名一无所知。

要让编辑器也认得这些宏，必须在编辑器侧再补一层。这一层就是 volar 包——它给每个自定义宏再造一份"只产类型、不产运行时"的影子实现，让编辑器读到的虚拟类型代码，与编译器改写后真正运行的代码，在类型层面语义对齐。

## 15.2 同一份源、两个互不知情的消费者

理解 volar 的关键，是先认清楚：**一份 .vue 源码有两个独立的消费者**。

第一个消费者是**构建期的运行时引擎**。它走的是 unplugin transform 那条线（前面章节讲过的所有改写器），输入是源码、产物是能跑的 JavaScript。defineModels 在它手里被拆开、注入 helper、改写赋值。

第二个消费者是**编辑期的类型检查器**。它走的是一条完全独立的语言服务管线：语言服务先把 .vue 编译成一段**合成的虚拟 TypeScript 代码**——一堆带 `__VLS_` 前缀的内部类型，加上一个合成的 `defineComponent({...})` 选项对象——再把这段虚拟代码喂给 TypeScript，由后者提供补全、跳转、报错。

> 说人话就是：构建器和编辑器各自看一份"翻译稿"。构建器看的是 transform 改写后的运行时稿，编辑器看的是语言服务合成的虚拟类型稿。两条路独立、互不通气。

transform 改写器只服务前者。它产出的代码、编辑器根本看不到。所以**你前面学过的那些宏的改写逻辑，编辑器全不知道**——它只会问：源码里这个 `defineModels` 是什么？

volar 包干的事，就是在第二条管线上再注入一次：**为每个宏写一份专门给类型检查器看的影子实现**。

## 15.3 一个核心动作：再造一份"只产类型"的影子

这里要做一个区分，否则容易和前面章节的内容重复。defineModels 在 transform 端如何拆字段、如何注入 helper、如何处理赋值——这些在「defineModels：从类型合成 props/emits 双向绑定」一章已经讲透。shortEmits 的展开、JSX 指令的分桶遍历、export-expose 的重写，也都各自在前置章讲过。

本章不重演这些 transform 逻辑。本章只看 **IDE 侧这层新影子**：为什么要再写一遍、这一遍有何不同。

先看一遍影子插件的"生命线"，心里有个轮廓：

```
.vue 源码
  ↓ 语言服务先把它编译成一段合成的虚拟 TS 代码
  ↓ （含 __VLS_ 内部类型 + 一个合成的 defineComponent({...}) 选项对象）
  ↓ 在虚拟代码定稿前，依次调用所有已注册插件的"内嵌代码钩子"
  ↓ defineModels 影子被调用：
  ↓   ① 回到【原始】script setup 的 AST，重新定位 defineModels<T>() 调用
  ↓   ② 把类型参数 T 的每个字段拆成两份（props 一份、update:事件 一份）
  ↓   ③ 用正则锚点找到虚拟代码里那个 defineComponent({...})，把类型塞进去
  ↓ 类型检查器最终拿到的虚拟代码已含 props/emits 类型
  ↓ 补全 v-model:字段、校验事件载荷 → 全过
```

注意第 ① 步——影子**从源码重新读**，不是从 transform 产物读。两条管线的输入相同（同一份源码），输出却各自不同（一个产出能跑的代码、一个产出能通过类型检查的虚拟代码），且互不通信。这点是后面好几条权衡的源头。

## 15.4 心智模型：IDE 影子注入的六个步骤

把上面的生命线展开成六步，作为下面阅读演示时的参照：

1. **触发**：编辑器打开一个 .vue 文件，语言服务开始合成虚拟 TS 代码。
2. **钩入**：在虚拟代码定稿前，语言服务回调所有已注册插件的"内嵌代码钩子"。
3. **重读源**：defineModels 影子被调用，回到原始 script setup 的 AST 重新定位 `defineModels<T>()`（注意：**重新**解析，不复用 transform 的产物）。
4. **拆字段**：把类型参数 T 的每个字段拆成两份字符串——props 一份、`update:字段` 事件一份。
5. **塞类型**：用一段正则锚点定位虚拟代码里合成的 `defineComponent({...})`，把两份类型字符串塞进去。
6. **收尾**：类型检查器拿到含 props/emits 类型的虚拟代码，补全和校验全部通过。

与之并行，构建期的 transform 对同一份源做完全不同的改写、产出能跑的代码。两条路、两套实现、两个消费者。

## 15.5 最小演示：双路改写器

下面这段脚本是教学骨架——**不接真语言服务**，只用一段模拟字符串代表"合成的虚拟代码"，把同一份源喂给两个纯函数，看它们各自产出什么。重点不是这脚本能跑多远，而是**对比 A 和 B 输出的差异**，那正是 volar 影子的本质。

```ts
// min-demo.ts —— 用 node/bun 直接跑，演透"同一份源、两套实现、两个消费者"

// ---------- 输入：模拟源码里的伪宏调用 ----------
const source = `defineModels<{ msg: string; count?: number }>()`

// ---------- 公共：把伪宏里的类型参数解析成字段表 ----------
type Field = { name: string; type: string; optional: boolean }

function parseTypeParam(src: string): Field[] {
  // 教学骨架：用最小字符串处理代替真 TS 解析
  const inside = src.match(/<\s*\{([^}]*)\}\s*>/)![1]
  return inside
    .split(';')
    .map(s => s.trim())
    .filter(Boolean)
    .map(part => {
      const m = part.match(/^(\w+)(\?)?:\s*(.+)$/)!
      return { name: m[1], optional: !!m[2], type: m[3].trim() }
    })
}

// ---------- 公共：字段拆分（两套实现都要调它一次） ----------
function splitFields(fields: Field[]) {
  const propStrings = fields.map(f => `${f.name}${f.optional ? '?' : ''}: ${f.type}`)
  const emitStrings = fields.map(f => `'update:${f.name}': [${f.name}: ${f.type}]`)
  return { propStrings, emitStrings }
}

// ---------- 模拟"语言服务合成的虚拟代码" ----------
// 关键标志：__VLS_PublicProps、__VLS_Emits、合成的 defineComponent({...})
const fakeVirtualCode = `
type __VLS_PublicProps = {}
type __VLS_Emits = {}
;(await import('vue')).defineComponent({
  __typeProps: {} as __VLS_PublicProps,
  __typeEmits: {} as __VLS_Emits,
})
`

// ---------- A 路径：transformForRuntime（重） ----------
// 模拟前面章节讲过的 transform 改写器：产出能跑的代码
function transformForRuntime(src: string): string {
  const fields = parseTypeParam(src)
  const { propStrings, emitStrings } = splitFields(fields)
  return [
    `// ===== transform 改写后真正运行的代码 =====`,
    `defineProps<{ ${propStrings.join('; ')} }>()`,
    `defineEmits<{ ${emitStrings.join('; ')} }>()`,
    `import { useVModel } from 'vue-macros/runtime'        // 注入双向绑定 helper`,
    `const models = useVModel(props, emit)                 // 把 props 和 emits 粘成可写 ref`,
    `// walkAST：把对 models.msg = x 的赋值改写为 emit('update:msg', x)`,
  ].join('\n')
}

// ---------- B 路径：transformForIDE（瘦） ----------
// 模拟 volar 影子：只往虚拟代码里塞类型、零 helper、零赋值改写
function transformForIDE(src: string, virtualCode: string): string {
  const fields = parseTypeParam(src)
  const { propStrings, emitStrings } = splitFields(fields)
  // 唯一动作：用"正则锚点"定位合成选项对象里的类型空位，把字段塞进去
  return virtualCode
    .replace('__VLS_PublicProps = {}', `__VLS_PublicProps = { ${propStrings.join('; ')} }`)
    .replace('__VLS_Emits = {}',       `__VLS_Emits = { ${emitStrings.join('; ')} }`)
}

// ---------- 跑一遍，并排打印 ----------
console.log(transformForRuntime(source))
console.log('\n---------------- vs ----------------\n')
console.log(transformForIDE(source, fakeVirtualCode))
```

跑出来的对照大致是这样：

```
// ===== transform 改写后真正运行的代码 =====
defineProps<{ msg: string; count?: number }>()
defineEmits<{ 'update:msg': [msg: string]; 'update:count': [count?: number] }>()
import { useVModel } from 'vue-macros/runtime'
const models = useVModel(props, emit)
// walkAST：把对 models.msg = x 的赋值改写为 emit('update:msg', x)

---------------- vs ----------------

type __VLS_PublicProps = { msg: string; count?: number }
type __VLS_Emits = { 'update:msg': [msg: string]; 'update:count': [count?: number] }
;(await import('vue')).defineComponent({
  __typeProps: {} as __VLS_PublicProps,
  __typeEmits: {} as __VLS_Emits,
})
```

把这两段并排看，差异很刺眼：

- **A（transform）那一侧**：要做的事多到一屏装不下——注入 helper、粘合 props 和 emits、改写赋值表达式，每一件都是前面章节展开过的"真活儿"。
- **B（IDE 影子）那一侧**：只干了两件事——拆字段、把字段塞进合成选项对象的两个类型别名里。完全没有 helper、没有赋值改写、没有解构别名处理。

而两边的"字段拆分"那几行代码，是几乎逐行对应的。这就是 volar 影子的全貌：**一份源、两套实现、两个消费者、影子明显更瘦**。

## 15.6 影子的三类典型：defineModels / 别名委托 / JSX

下面看真实 volar 包里那二十来个子插件，按"影子做什么"分成三类。

**第一类：完整影子——拆字段、塞类型**。代表是 defineModels。它从原始 script setup 的 AST 重新找到 `defineModels<T>()`，遍历 T 的每个属性签名，把每个字段拆成 `name?: type`（给 props）和 `'update:name': [name: type]`（给 emits）两份字符串，再调公共工具 `addProps`/`addEmits` 把这两份类型塞进合成虚拟代码里。shortEmits、JSX 指令里的 SFC 内嵌宏也属于这一类——它们各自重做一遍前置章讲过的字段展开/指令识别，但落在虚拟类型代码上、完全不碰运行时。

**第二类：别名委托——只塞一个名字、零逻辑**。代表是 defineProps 影子（处理 `$defineProps` 这个别名）。它的影子实现几乎没有任何代码，只做一件事：把 `$defineProps` 这个名字塞进语言服务自带的"原生宏注册表"——`ctx.vueCompilerOptions.macros.defineProps.push('$defineProps')`。语言服务本来就认识 `defineProps`，现在多认一个别名，几乎免费就拿到了补全。这种"白嫖"策略的前提是：这个宏真的只是换名字、不改语义。凡是真正改写语义的宏（如 defineModels 那种 props+emits 合成），就没法白嫖，必须自己实现影子。

**第三类：走另一个钩子——独立 tsx/jsx**。前两类改写的都是 .vue 文件**内嵌**的虚拟代码（语言服务为 script setup 合成的那段），用的是 `resolveEmbeddedCode` 钩子。但 JSX 指令宏可以独立出现在 .tsx/.jsx 文件里——这种文件在语言服务里被当成独立的虚拟文件，不走 .vue 内嵌那条路。所以 jsx-directive 影子用的是另一个钩子 `resolveVirtualCode`，签名的入参是 `{ filePath, ast, codes, lang }`，lang 必须是 jsx/tsx 才进入。它的内核（按指令类型分桶收集、各自改写）与 transform 端是各写一份的平行实现——具体原理在「在 JSX 里镜像 Vue 模板指令」一章已讲透，这里不重演，只强调"影子端的遍历改写落在虚拟代码上、不产出任何运行时"。

## 15.7 关键权衡

**权衡 1（全章灵魂）：两套实现并存，换来运行时与类型服务各得其所。**
- **选择**：对同一个宏，transform 端写一份改写器（产出能跑的代码），volar 端再写一份影子（产出能通过类型检查的虚拟代码）。
- **换来**：每个消费者拿到它最自然的输入——运行时引擎拿到的是无宏的原生 Vue 代码、类型检查器拿到的是含完整类型的虚拟代码。两边都不用为对方妥协。
- **代价**：同一段字段拆分/指令识别逻辑，要手写两遍，且必须人工保持同步。每新增一个宏、每改一次拆分规则，都要在两边同时动。这是 volar 影子最沉重的负担——它的存在本身就是为了消解"两个消费者不通气"，消解的方式就是付出双倍实现。

**权衡 2：影子只产类型、不注入任何运行时 helper，换来影子远比 transform 简单。**
- **选择**：影子里完全不出现 useVModel、不出现赋值改写、不出现解构别名处理。它只往虚拟代码里塞类型字符串。
- **换来**：影子实现可以非常薄——上面演示里 B 路径就那么几行。复杂的运行时机制（双向绑定、响应式赋值）影子一概不管。
- **代价**：影子只保证"类型对"，**不保证"运行时行为对"**。它能让你编辑器不报错、补全能出现，但 defineModels 真正的双向绑定语义仍由 transform 兜底——如果 transform 那边出了 bug，影子是发现不了的。换言之，影子和 transform 之间没有共同的真相来源、没有测试互相校对，唯一约束它们的是开发者手写时的注意力。

**权衡 3：影子寄生在语言服务合成的虚拟代码结构上，换来不必重写整套管线。**
- **选择**：用一段正则锚点（`REGEX_DEFINE_COMPONENT`）定位语言服务自己合成的 `defineComponent({...})` 选项对象，然后往里塞 props/emits 字段。同时影子还要按 Vue 框架大版本切换注入点：3.5 及以上直接用 `__typeProps: {} as __VLS_PublicProps` 这种新形态；3.5 以下则要降级用 `__VLS_TypePropsToOption`、`__VLS_NormalizeEmits` 这些 helper 类型，把类型转成运行时 props 选项的旧形态。
- **换来**：volar 不必自己实现"从 SFC 到虚拟 TS 代码"的整套编译管线——它假定语言服务已经合成好了大部分，自己只在最后一公里做局部插入。这是它能用相对少的代码支持二十多个宏的关键。
- **代价**：强耦合语言服务的内部约定。`__VLS_PublicProps`、`defineComponent({...})` 的合成形态、3.5 前后的注入点切换——这些都是语言服务的"内部接口"，没有任何稳定性承诺。语言服务升级、合成形态变了、版本边界挪了，影子的锚点和分支都要跟着改。这种耦合的痛苦，是寄生策略与生俱来的代价。

**权衡 4：能白嫖语言服务内置能力的就白嫖，换来这类宏几乎免费获得原生补全。**
- **选择**：像 `$defineProps` 这种"纯换名字"的别名宏，影子端不实现任何拆分逻辑，只往原生宏注册表里 push 一个名字。
- **换来**：零逻辑、零维护成本，原生 defineProps 怎么补全，这个别名就怎么补全。
- **代价**：只有"换名字级别"的宏能这样做。一旦宏真正改写语义（如 defineModels 把一个类型拆成 props+emits），白嫖就失效——语言服务没有内置逻辑能凭空帮你拆类型，影子必须自己写。所以你会发现 volar 里影子的"厚度"差异极大：从一行 push 到几百行 AST 遍历都有，厚度由"宏在多大程度上偏离原生语义"决定。

## 15.8 小结

把全章收敛成一张图：

```
                ┌─── transform 改写器 ───→ 能跑的运行时代码 ───→ 浏览器
.vue 源码 ──────┤
                └─── 语言服务 ───→ 合成虚拟 TS 代码
                                       ↑
                                       │（影子插件在虚拟代码定稿前钩入）
                                       │
                                  volar 影子
                                       │
                                       ↓
                                 含类型的虚拟代码 ───→ 类型检查器 ───→ 编辑器
```

volar 干的事，是在第二条管线最后一公里做局部插入，让编辑器读到的虚拟类型代码，与 transform 改写后真正运行的代码，在类型层面对齐。它不发明新运行时、不与 transform 通信、不共享真相来源——它只是**为同一个宏、再写一份只服务类型检查器的实现**。这份实现可以很薄（因为只产类型、不产 helper），但必须存在（因为编辑器是另一个消费者、它看不到 transform 的产物）。

下一章会离开宏本身，去看 vue-macros 怎么在更高层的框架里被装配——Nuxt 模块、Astro Islands、DevTools 可视化面板：框架特定的装配上下文由集成层注入、转换内核保持不变。
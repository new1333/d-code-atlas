---
title: "为旧版本补齐与简化样板的语法垫片"
---

# 为旧版本补齐与简化样板的语法垫片

写 Vue 时你可能有过这些念头：「`<Comp foo>` 直接当布尔属性多干脆」「`<Comp :foo>` 干嘛非得写 `="foo"`，同名省掉不行吗」「`v-model` 写多了想简写成 `$count="x"`」「`defineProps().withDefaults(...)` 这样链着写挺顺的」。

这些写法有的旧版 Vue 不认，有的根本不是合法语法。本章讲的五个宏就是为这种「想要更顺手」的场景而存在——它们在编译期把差异和样板抹平，运行时零成本。

但有个一开始就要钉死的认识：**这五个宏看似都在做语法垫片，可它们工作的那一层根本不一样**。三个改的是「Vue 怎么理解一个模板属性」，两个改的是 `<script setup>` 里普通 JS/TS 文本。前者必须借 Vue 自己的编译器动手，后者只能在外层字符串上改。理解了这一层差别，整章就好读了。

## 五个宏的归属：一眼看穿两条路

先看一张表，把五个宏按「改写发生在哪一层」归位：

| 宏 | 改什么 | 走哪条路 |
|---|---|---|
| boolean-prop | `<Comp foo>` → `:foo="true"` | 借 Vue 编译器 |
| short-bind | `<Comp :foo>` → `:foo="foo"` | 借 Vue 编译器 |
| short-vmodel | `<Comp $count="x">` → `v-model:modelValue` 类 | 借 Vue 编译器 |
| chain-call | `defineProps().withDefaults(x)` → `withDefaults(defineProps(), x)` | 独立字符串编辑 |
| script-lang | 给 `<script setup>` 注 `lang="ts"` | 独立字符串编辑 |

前三者叫 A 类，后两者叫 B 类。两类长得很像，但内里走的轨道完全不同：A 类不碰字符串、不读 SFC 源码，只把自己挂进 Vue 编译器的节点变换队列；B 类完全不碰 Vue 编译器，纯靠第 1 章那套 `parseSFC` + 增量字符串编辑干活。

> 第 1 章已经把「懒解析 + 增量编辑」的原理展开过了——`getSetupAst` 按需 babelParse、`magic-string-ast` 按偏移改写、每个宏自己处理 setupOffset。本章 B 类两个宏就是这套能力的直接复用，不再重讲；下面把篇幅留给 A 类那条全新的轨道。

## A 类：借 Vue 编译器挂号

### 为什么必须借编译器

想象一下，你想让 `<Comp foo>` 在最终渲染函数里等价于 `<Comp :foo="true">`。如果你不进 Vue 编译器内部，只能在 SFC 字符串上做正则替换：把 `<Comp foo>` 改成 `<Comp :foo="true">`。这条路听起来对，其实脆——模板里可以有 `v-bind`、可以有 JSX、可以有 `v-on`，正则一不留神就误伤；更糟的是，模板属性最终长成什么样子由 Vue 编译器说了算，你在字符串层动刀根本碰不到这层语义。

说人话就是：**改模板语义，必须进到 Vue 编译器的脑袋里改**。

A 类三个宏就是这么干的。它们不打补丁、只挂号——找到构建器里 Vue 官方插件（`vite:vue` / `unplugin-vue`）暴露的 `.api`，把自己的节点变换函数追加进 `api.options.template.compilerOptions.nodeTransforms` 数组。之后 Vue 编译器在跑模板 AST 时会回调你的函数，你就有了直接修改属性节点的权限。

### 挂号后的产物纯净度

挂号进队列以后，Vue 编译器在遍历模板 AST 时就会调你的变换函数。函数里你可以直接改属性节点的字段——比如布尔属性就是把 `type: 6`（ATTRIBUTE）的节点改写成 `type: 7`（DIRECTIVE）+ `name: 'bind'` + `arg` + `exp`：

```ts
// 极简演示：A 类节点变换的「形」（仅展示改节点的样子）
function booleanPropTransform(node) {
  if (node.type !== 1) return  // 不是元素节点
  for (let i = 0; i < node.props.length; i++) {
    const prop = node.props[i]
    if (prop.type === 6 && !prop.value) {  // 无值的普通属性
      node.props[i] = {
        type: 7,            // DIRECTIVE
        name: 'bind',
        arg: { type: 4, content: prop.name, isStatic: true },
        exp: { type: 4, content: 'true', isStatic: false },
        modifiers: [],
      }
    }
  }
}
```

Vue 编译器拿到这个被改过的 AST，照常生成渲染函数——产出的就是标准的 `props: { foo: true }`，**没有任何运行时 helper、没有任何运行时开销**。这是 A 类最大的好处：你的语法糖在编译期就被蒸发了。

### 演示：挂号进编译器，看产物纯净

下面这段脚本用官方 `@vue/compiler-core` 直接演示「挂号 → 编译器替你改 → 产物纯净」全流程：

```ts
// shims-boolean-prop-demo.ts —— 直接 tsx/node 跑
import { baseCompile, ElementNode, NodeTransform } from '@vue/compiler-core'

// 我自己写一个极简的布尔属性变换
const booleanProp: NodeTransform = (node) => {
  if (node.type !== 1) return  // 只处理元素节点
  const el = node as ElementNode
  for (let i = 0; i < el.props.length; i++) {
    const p = el.props[i] as any
    if (p.type === 6 && !p.value) {  // 无值的 ATTRIBUTE
      el.props[i] = {
        type: 7, name: 'bind',
        arg: { type: 4, content: p.name, isStatic: true, loc: p.loc },
        exp: { type: 4, content: 'true', isStatic: false, loc: p.loc },
        loc: p.loc, modifiers: [],
      } as any
    }
  }
}

// 挂号进编译器的 nodeTransforms 队列
const { code } = baseCompile('<Comp foo />', {
  nodeTransforms: [booleanProp],
})

console.log(code)
```

跑出来的渲染函数代码里，`foo` 已经是标准的 `_normalizeProps({ foo: true })`（或直接 `{ foo: true }`），找不到任何布尔属性宏留下的痕迹。这就是「借编译器」换来的产物纯净度。

## B 类：独立增量改写

现在反过来看。chain-call 这个宏要处理的是 `<script setup>` 里的纯 JS 代码：

```ts
// 用户写的（Vue 3.3 前 withDefaults 不能链式调用）
const props = defineProps().withDefaults({ count: 0 })

// 宏改完之后（标准写法）
const props = withDefaults(defineProps(), { count: 0 })
```

这种改写跟模板语义一毛钱关系都没有——它就是普通 JS 文本里两段函数调用的位置换一下。所以走 A 类的「借编译器」根本用不上：Vue 编译器管的是模板，碰不到 script setup 里的纯 JS 表达式。

这类就用第 1 章那套：`parseSFC` 拿到 script setup 块、`getSetupAst` babelParse 成 AST、`walkAST` 找到 `defineProps().withDefaults(...)` 这种调用模式、`magic-string-ast` 的 `overwriteNode` 按偏移重排成 `withDefaults(defineProps(), ...)`。

```ts
// shims-chain-call-demo.ts —— 对照演示：脚本层用字符串编辑
import { parseSFC, getSetupAst } from 'vue-macros/common'  // 第 1 章的能力
import MagicString from 'magic-string'

function transformChainCall(code: string, id: string): { code: string } | undefined {
  const sfc = parseSFC(code, id)
  if (!sfc.scriptSetup) return
  const setup = sfc.scriptSetup
  const offset = setup.loc.start.offset  // 关键：所有偏移都要加这个
  const ast = getSetupAst(sfc)             // 懒解析、缓存
  const s = new MagicString(code)

  // 简化版：只识别 defineProps().withDefaults(arg) 这种链式调用
  walkAst(ast, {
    CallExpression(path) {
      const callee = path.node.callee
      if (callee.type !== 'MemberExpression') return
      if (callee.property.name !== 'withDefaults') return
      const obj = callee.object
      if (obj.type !== 'CallExpression' || obj.callee.name !== 'defineProps') return

      const definePropsText = s.sliceNode(obj, { offset })
      const argText = s.sliceNode(path.node.arguments[0], { offset })
      s.overwriteNode(path.node, `withDefaults(${definePropsText}, ${argText})`, { offset })
    },
  })

  return { code: s.toString() }
}
```

> 上面这段是骨架演示，省略了 `removeMacroImport` 顺手清理宏 import、`isChainCall` 谓词等工程细节。原理是清楚的：**碰模板语义去借编译器，碰脚本文本就用字符串编辑**。

两段演示并排看，读者就能抓住本章灵魂：**语法垫片要在它语义所属的那一层改写——模板语法糖借用 Vue 自己的编译器，脚本改写用增量字符串编辑。**

## 版本号即语法开关

short-bind 是五个宏里唯一一个真正用「Vue 版本号」改变语法行为的——而且是在变换函数内部、不是配置层。

故事是这样的：Vue 3.4 之前，模板里没有原生的 v-bind 简写；3.4 起 Vue 原生引入了 `::foo` 这种双冒号简写。short-bind 在两种版本下要表现不一样：

```ts
export function transformShortBind(options: Options = {}): NodeTransform {
  const version = options.version || 3.3
  const reg = new RegExp(
    `^(::${version < 3.4 ? '?' : ''}|\\$|\\*)(?=[A-Z_])`,
    'i',
  )
  // ...
}
```

注意那个 `version < 3.4 ? '?' : ''`——旧版允许 `:foo`（单冒号）也允许 `::foo`（双冒号，正则里 `?` 让第二个冒号可选）；新版**只**认 `::foo`，把单冒号让给原生 v-bind，避免冲突。

`$foo` / `*foo` 这两种前缀不受版本影响，因为它们从来不会和 Vue 原生语法撞车。

> 这是本章「版本感知」的真正所在地。其它宏——chain-call、script-lang 在 plugin 层调 `detectVueVersion()`，但变换本身不依赖版本号；boolean-prop、short-vmodel 干脆不接收 version 参数；至于「这个宏在新旧 Vue 下默认开还是关」的另一层版本感知，那归配置层管，是下一章的事，这里不展开。

## 挂号时序的脆弱性

A 类还有个值得点一句的细节：挂号时机。

Vue 官方插件的 `.api` 不是构建器一启动就立刻可用——得等配置解析完、Vue 插件实例化之后。所以 A 类宏会**两次尝试**：

1. `configResolved` 钩子里：从传入的 `config.plugins` 里找 Vue 插件、取 `.api`；
2. 如果上一步拿到的是 `undefined`，到 `buildStart` 钩子里再从 rollup 的 `options.plugins` 里重试一次；
3. 还拿不到？调 `this.warn` 提醒一下，然后 `return`——**不抛错**。

为什么选「静默放弃」而不是「报错拉响警报」？因为构建器插件加载顺序千差万别：vite 插件可能懒加载、rolldown 实例化时机又不一样。一旦报错，用户配错顺序就构建直接挂，体验极差；静默放弃换来的是「插件加载顺序随便排，能挂就挂、挂不上算了」的宽松度。代价也明显：用户配错时没有清晰提示，宏可能悄悄不生效，排查得自己查。

## 关键权衡

### 权衡 1：模板简写为什么必须「借编译器」

**选择**：A 类三个宏选择挂靠 Vue 编译器的 `nodeTransforms` 队列、由 Vue 自己改 AST，**不**在外层字符串上动刀。

**换来**：
- **运行时绝对零成本**——产物就是标准渲染函数，不引入任何 helper；
- **语义永远正确**——改写发生在 Vue 自己解析模板的过程中，绝不会被任何边角模板语法（v-bind、JSX、v-on）误伤；
- **与 Vue 编译器同寿**——Vue 编译器升级了，你的变换自然享受新优化。

**代价**：
- **强依赖 Vue 官方插件暴露 `.api`**（要求 plugin-vue > 4.3.4）；
- **只支持 vite/rollup/rolldown 三套构建器**——webpack/esbuild/rspack 拿不到这个钩子（plugin 对象只有这三个 key）。这是 A 类可用性的硬边界。

### 权衡 2：脚本层为什么反而选「独立改写」

**选择**：chain-call、script-lang 选择走字符串层改写，**不**借 Vue 编译器。

**换来**：
- **六套构建器全通用**（vite/rollup/webpack/esbuild/rspack/rolldown）——和第 2 章『一次编写多套构建器』对齐；
- **可与其它宏叠加**——基于偏移的增量编辑天然支持多道转换串行；
- **不依赖任何 Vue 插件暴露**，可用性边界比 A 类宽。

**代价**：
- **只能改 JS/TS 文本**，碰不到模板语义——你想用它做布尔属性？做不到；
- **每个宏都要自己处理 setupOffset 偏移**——这是第 1 章『懒解析 + 增量编辑』选择的连带代价，本章不重复展开。

两条路一对照，就能看出：**借编译器换来纯净但窄，独立改写换来通用但浅**。设计者没有试图统一它们，而是让每个宏按自己的语义层归位。

### 权衡 3：版本号即语法开关

**选择**：short-bind 在变换函数内部用 `version < 3.4` 切换前缀正则。

**换来**：新旧 Vue 行为自适应——同一份 short-bind 宏，挂在 3.3 项目上认单冒号、挂在 3.4+ 项目上只认双冒号，**避开 3.4 原生 `::` 简写的冲突**。

**代价**：
- 用户得理解「版本门槛」这件事——同一前缀 `:foo` 在不同 Vue 版本下语义不同；
- 版本号怎么传进来、默认值是几（默认 3.3），这是个配置问题，本章先点到「变换内部用版本号切正则」为止，下一章统一展开。

### 权衡 4：挂号时序的脆弱性

**选择**：A 类在 `configResolved` 和 `buildStart` 两次兜底尝试取 Vue 插件 `.api`，拿不到就 `this.warn` 后 return，**静默放弃不抛错**。

**换来**：宽松的插件加载顺序兼容——vite/rollup/rolldown 三套构建器实例化 Vue 插件的时机不一致，两次兜底 + 不报错让宏在各种顺序下都不至于把构建拉挂。

**代价**：用户配错时**无清晰提示**——宏可能悄悄不生效，要排查得自己手动看构建日志里那条 `warn`。

## 心智模型总结

把全章压成四步：

1. 一个语法糖进来，**先判它改的是模板语义还是脚本文本**——这决定走哪条路；
2. 模板语义：在 `buildStart` 时找到 Vue 官方插件的 `.api`，把自己的 `NodeTransform` push 进 `nodeTransforms` 数组（挂号），之后由 Vue 编译器在遍历模板 AST 时调用、就地把属性节点改写成标准绑定指令；
3. 脚本文本：用 `parseSFC` 拿 setup 块、用增量字符串编辑按偏移改写源码；
4. 两条路殊途同归：最终产物里都不留任何宏痕迹、运行时零成本，差异只在「谁动手改」。

一句话收束：**好的语法垫片不发明新机制，只把差异和样板在编译期蒸发掉**——而蒸发它的工作必须在它语义所属的那一层完成。

---

下一章会从「单个宏怎么管自己的版本号」抬到「整个插件如何统一管三十多个特性的版本条件」——也就是统一配置体系与版本感知默认值。short-bind 这里 `version || 3.3` 这种散落在各宏里的版本判断，到那里会被收敛成一张全局开关表。

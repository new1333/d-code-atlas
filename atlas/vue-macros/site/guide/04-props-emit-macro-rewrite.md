---
title: "props/emit 宏的编译期重写与类型转换"
---

# props/emit 宏的编译期重写

写过一阵 Vue 组件，你大概嘀咕过这么一句：**声明三个 prop，非得把三行信息全塞进一个 `defineProps({...})` 的大对象里，能不能一个一个来？** Vue 原生的 `defineProps` / `defineEmits` 是「一次性、集中声明」——所有 prop 挤一个调用里，所有事件也挤一个调用里。早期版本还更啰嗦：prop 名要和变量名对齐，事件类型要手写一长串签名。用户想要的是更顺手的写法：能逐个声明、能用更短的事件类型、能沿用旧版的 `$` 前缀。

可这些「顺手写法」Vue 运行时一个都不认识。本章就讲 vue-macros 怎么把它们救活。

## 核心思想：编译期当翻译官，运行时一行不改

打个比方：你只会说方言，Vue 编译器只听得懂普通话。这套宏扮演的角色就是一个**翻译官**——在你把代码交给 Vue 编译器**之前**，它先把方言翻成普通话。翻译只在编译期发生；等代码真跑起来，里面一个自定义宏都不剩，全是 Vue 早就认识的原生 `defineProps` / `defineEmits`。

说人话就是：**这些宏不引入任何新的运行时能力，它们只是源码改写器。** 用户拿到手的语义，和直接写原生宏一模一样，没有任何额外的学习负担——这是全章的总纲，后面所有设计都服从它。

## 四个宏共用同一套流程（地基是第 1 章搭好的）

这四个宏（`define-props`、`short-emits`、`define-emit`、`define-prop`）长得不一样，但干活的姿势几乎一模一样，都重复这一句式：

> 算出 `setupOffset` → 用 `walkAST` + `isCallOf` 找调用点 → 抽信息 → 用 `overwriteNode` 就地把调用点改掉 → 必要时用 `prependLeft` 在顶部补一个集中的原生宏调用。

这套 `parseSFC` / `getSetupAst()` 懒解析 / `MagicStringAST` 增量改写 / `walkAST` 找调用点的机制，是第 1 章「SFC 解析与增量 AST 编辑」搭好的地基，本章不重讲。这里只看一件事：**每个宏怎么复用这块地基，把顺手写法翻成原生形态。** （顺带一提，你会看到每个改写操作后面都跟一个 `{ offset }`——babel 解析的是 setup 片段、而改写操作针对的是整份 SFC 文本，所以位置一律要加上 `setupOffset`。这个偏移代价第 1 章已说过，这里只认它的存在。）

下面自底向上，从最简单的「改名」一路看到最复杂的「逐个声明 + 合并」。

## define-props：最没存在感的「改名」重写器

先看最没存在感的一个。有人怀念旧版 `$defineProps` 的写法，想接着用。怎么实现？**把 `$` 删掉就行。**

```ts
// 改写前
const props = $defineProps({ count: Number })

// 改写后
const props =  defineProps({ count: Number })
```

注意改写后 `defineProps` 前面**多了一个空格**——这是故意的。源码注释写得很直白：`add space for fixing mapping`。直接把 `$` 这一个字符删掉，会让这处改写的 sourcemap 映射对不齐；保留一个等长的空格占住原来 `$` 的位置，映射就干净了。一个字符的细节，体现了「增量改写」的脾气：**只动必要的字符，连长度都尽量保持。** 这就是「重命名式」重写的极致样本——整个宏的核心逻辑就这一句 `overwriteNode`。

## short-emits：把简写类型签名「展开」

如果你写过 Vue 3.3 之前的组件，多半嫌过 `defineEmits` 的类型签名太啰嗦。vue-macros 提供了一种简写：用 `SE<{...}>` 或 `ShortEmits<{...}>` 包一下，成员写得更短。运行时不认这层包装，所以编译期要把它**剥掉、再展开**成 Vue 3.3+ 原生要求的「call signature」形态。

剥包装用两刀夹击——一刀删掉外层 `SE<`，一刀删掉配对的 `>`，中间的类型就露出来了：

```
defineEmits<SE<{ click: [id: number] }>>(...)
           ^^ 删                      ^ 删
        → defineEmits<{ click: [id: number] }>(...)
```

露出内层后，遍历它的每个成员，把三种简写形态统一改成 `(evt: "key", ...args): void`：

| 简写形态 | 改写后 |
|---|---|
| `click: [id: number]`（元组） | `(evt: "click", ...args: [id: number]): void` |
| `change: (v: string) => void`（函数） | `(evt: "change", v: string): void` |
| `hover(): void`（方法） | `(evt: "hover"): void` |

关键手法还是 `sliceNode`——**把源码里的参数片段当字符串原样抠出来，再拼进新的签名**。short-emits 只动类型签名区，运行时参数原样保留。说人话就是：`SE` 这层糖纯粹是类型层面的方便，跟运行时声明井水不犯河水，各管各的。

## define-emit：一个事件一个声明，最后汇总

想象你在写一个组件，有好几个事件要往外抛。原生 `defineEmits` 要你一次性列全；你更想一个事件写一行，各拿各的发射函数。`defineEmit` 就是干这个的。它有三种写法：

```ts
const click = defineEmit('click')                    // 名字直接写在字符串里
const change = defineEmit()                          // 不传参 → 名字从变量名 change 反推
const input = defineEmit('input', inputValidator)    // 第二参带个校验器
```

这里有个硬规矩：**第一参要么是字符串字面量、要么干脆不传。** 不传时，宏会从接收返回值的变量名（上文的 `change`）把名字反推出来。但你要是图省事传个变量名进去（比如 `defineEmit(changeValidator)`），它不会反推，而是直接抛错——「第一参必须是字符串字面量」。因为这种写法把校验器塞到了「名字位」上，宏分不清你到底想传名字还是别的，索性报错拉倒。

每个 `defineEmit(...)` 调用点，都被就地改成一个**转发函数**：

```ts
// 改写前
const click = defineEmit('click')
// 改写后
const click = (...args) => __MACROS_emit("click", ...args)
```

而所有收集到的事件，最后在 setup 顶部汇总成一个 Vue 认识的集中声明：

```ts
const __MACROS_emit = defineEmits(["click", "change", "input"])   // 全无校验器 → 数组
// 或（任一带了校验器）→ 对象
const __MACROS_emit = defineEmits({ click: null, input: inputValidator })
```

这里出现了一个反复出现的套路：**用一个带保留风格、用户不会自起的变量名 `__MACROS_emit`，来兜住汇总结果，避免和用户自己起的变量撞名。** （顺带澄清：`__MACROS_emit` 是个完全合法的 JS 标识符，下划线开头没问题；它靠「用户不会自己起这种名字」的约定来防冲突，不是靠什么非法性。）改写完之后，每个 `defineEmit` 都变成了读 `__MACROS_emit` 的小转发函数，自定义宏消失，只剩原生 `defineEmits`。

## define-prop：逐个声明，还要和已有的 props 合并

`defineProp` 是这几个里最花心思的，因为它在 `defineEmit` 那套「逐个声明 + 汇总」的基础上，还多了一层麻烦：**组件里可能本来就已经有一个 `defineProps(...)` 了，新的逐个声明得想办法和它合到一起。**

每个 `defineProp(...)` 调用点，被就地改成一个读 `__props` 的代理：

```ts
// 改写前
const count = defineProp('count', { default: 0 })
// 改写后（toRef 由编译期自动注入）
const count = toRef(__props, "count")
```

收集到的 props 怎么落定，分三种情况，这是 define-prop 的核心逻辑：

```
组件里已有 defineProps 吗？
├─ 没有 → 顶部 prepend 一个新的 const __MACROS_props = defineProps({...})
├─ 有，且带运行时参数 → 把新旧两份整理成同一种形态，合并进原参数位
│                       { ...旧, ...新 }
└─ 有，但是泛型形式 defineProps<T>() → 直接抛互斥错
                                       （defineProp 不能和泛型 defineProps 共存）
```

第三种值得多说一句：泛型形式的 `defineProps<T>()` 本身就是「靠类型生成 props」，再叠一个 `defineProp` 会两套来源打架，干脆禁止。这种「能合并就合并、合不了就报错」的处理，正是逐个声明模式要付出的边界代价。

（define-prop 还顺手照顾了响应式语法糖：检测 `$(defineProp('x'))` 或 `$defineProp('x')` 两种写法，命中时用 `$(` `)` 把代理表达式包起来。这条线连到第 7 章「响应式语法糖」，本章不展开。另外它也是这四个里唯一**异步**的宏，因为合成 props 时可能要走 TS 类型降级——那是第 6 章「better-define」的地盘，本章只把它当一个借用来的工具。）

## 关键权衡

这一节是本章的主菜。本章机制集中，核心就这 3 条权衡，逐条讲透。

**权衡一（总纲）：把语法糖全留在编译期，运行时只认原生宏。**
- **选择**：所有顺手写法（`$defineProps`、`SE<...>`、单个 `defineProp`/`defineEmit`）一律在编译期改写成原生 `defineProps`/`defineEmits`，运行时不增加任何新概念。
- **换来**：用户拿到的语义和原生宏**完全一致**，没有新运行时行为要学、要记、要调试；宏的实现方也**无需理解 Vue 运行时**，只管做文本/AST 改写。这两头都省事，是这套设计最值钱的地方。
- **代价**：这些宏注定只是「重写器」，没法引入任何原生宏没有的新运行时能力——想做点 Vue 运行时根本不支持的事，这条路走不通。

**权衡二：用字符串拼接合成运行时声明，而不是去构造 babel AST 节点。**
- **选择**：抽信息时用 `sliceNode` 把源码片段当**字符串**原样抠出来，再拼成 `{ name: { ... } }` 或 `[name, ...]` 这种声明对象。
- **换来**：实现极简，几十行就能写完一个宏；产出的代码人能直接读；也不用操心「构造的 AST 节点在 babel 各版本里字段名对不对」。
- **代价**：产物的正确性靠**约定**保证（没有类型层面把关，拼错了字符串运行时才暴露）；而且「全无选项的简写数组」和「带选项的对象」必须分两条路径生成代码（还记得 define-emit 里 `mountEmits` 的两形态、define-prop 的两路径吗？那就是这条代价的直接体现）。

**权衡三：逐个声明 + 代理到集中原生宏。**
- **选择**：多个 `defineProp` 合并成一个 `defineProps`，每个调用点改成读 `__props` 的代理；多个 `defineEmit` 合并成一个 `defineEmits`，每个调用点改成转发函数。
- **换来**：用户能**像写普通变量一样逐个声明**，还能各自拿到独立的 ref / emit 函数；而这些声明最终又规规矩矩地落回 Vue 认识的单个原生宏上，两全其美。
- **代价**：要维护一个集中的 `__MACROS_props` / `__MACROS_emit` 调用点，并额外处理一堆边界——「和已存在的 `defineProps` 合并参数」「和 `defineProps<T>()` 泛型形式互斥报错」「名字从变量名反推时要校验调用点确实赋值给了变量」。这些边界 case 就是「逐个」换来的复杂度。

（还有一条「就地增量改写而非 parse 后重新生成」的权衡——换来未触碰代码的 sourcemap 原样保留、多道宏转换可层层叠加——这条第 1 章已展开，这里不重复，只看它在本章的具体兑现：每个改写操作都得手算 `setupOffset` 偏移。）

## 原理演示：一个 40 行的从零重写器

光说不够，来看一个能跑的最小实现。它演示「收集 + 就地改写 + 合成集中声明」这三件套——用 `defineProp` 这一类最有代表性（演示里宏名写成 `defProp`，避免和真宏混）。读这段代码时，把每一行对应回上面的权衡和步骤。

```js
// 演示「重写器」三件套：收集 → 就地改写 → 合成集中声明
// 用 @babel/parser 解析；用一个极简的「按区间改字符串」小工具模拟 magic-string
const { parse } = require('@babel/parser')

class MiniString {                       // 极简增量改写器
  constructor(src) { this.src = src; this.ops = [] }
  overwrite(start, end, repl) { this.ops.push({ start, end, repl }) }
  prepend(text) { this.ops.push({ start: -1, repl: text }) }
  toString() {
    // 倒序应用 overwrite（先改的不会把后面偏移顶歪），最后再 prepend
    const ovs = this.ops.filter(o => o.start !== -1).sort((a, b) => b.start - a.start)
    const pres = this.ops.filter(o => o.start === -1)
    let out = this.src
    for (const o of ovs) out = out.slice(0, o.start) + o.repl + out.slice(o.end)
    for (const p of pres) out = p.repl + out
    return out
  }
}

const MACRO = 'defProp'

function transform(setupCode) {
  const ast = parse(setupCode, { plugins: ['typescript'] })
  const s = new MiniString(setupCode)
  const collected = []

  walk(ast, (node) => {                  // ① walkAST 找调用点
    if (!isCallOf(node, MACRO)) return
    const [nameArg, optsArg] = node.arguments
    const name = nameArg.value                       // ② 抽信息：名字来自字符串
    const opts = optsArg ? setupCode.slice(optsArg.start, optsArg.end) : undefined
    collected.push({ name, opts })
    s.overwrite(node.start, node.end,                // ③ 就地改写成读 __props 的代理
      `toRef(__props, ${JSON.stringify(name)})`)
  })

  if (!collected.length) return s.toString()

  // ④ 合成集中声明：全无选项走数组，否则走对象（对应权衡二的「两条路径」）
  const allBare = collected.every(p => !p.opts)
  const runtime = allBare
    ? `[${collected.map(p => JSON.stringify(p.name)).join(', ')}]`
    : `{ ${collected.map(p => `${p.name}: ${p.opts || 'null'}`).join(', ')} }`

  s.prepend(`const __props = defineProps(${runtime});\n`)   // ⑤ 顶部补集中的原生宏
  return s.toString()
}

// —— 极简 walk / isCallOf（真身在 @vue-macros/common 的 walkAST / isCallOf）——
function walk(node, cb, parent = null) {
  cb(node, parent)
  for (const k of Object.keys(node)) {
    const v = node[k]
    if (Array.isArray(v)) v.forEach(c => c?.type && walk(c, cb, node))
    else if (v?.type) walk(v, cb, node)
  }
}
function isCallOf(node, name) {
  return node?.type === 'CallExpression' &&
    node.callee.type === 'Identifier' && node.callee.name === name
}

console.log(transform(
  `const count = defProp('count', { default: 0 })\nconst open = defProp('open')`
))
```

跑出来的轨迹，正好是「输入源码 → 收集中间态 → 改写后源码」一条线：

```
输入:  const count = defProp('count', { default: 0 })
       const open = defProp('open')
中间态: collected = [{ name:'count', opts:'{ default: 0 }' }, { name:'open', opts:undefined }]
输出:  const __props = defineProps({ count: { default: 0 }, open: null });
       const count = toRef(__props, "count")
       const open = toRef(__props, "open")
```

盯住输出最后两行——**自定义宏 `defProp` 已经一个不剩，全变成了 Vue 认识的 `defineProps` 加 `toRef` 代理。** 这就是「翻译官」干完活的样子。演示里那个「倒序应用 overwrite」的小细节，正是为了让先改的片段不去顶歪后面片段的偏移——这和真 magic-string 保住 sourcemap 是同一个道理（第 1 章已展开，这里不重复）。

## 小结

四个宏，一个灵魂：**编译期把顺手写法重写成原生宏认得的形态，运行时零新增。** 从最简单的「改名」（define-props），到「展开类型签名」（short-emits），再到「逐个声明 + 代理到集中原生宏」（define-emit、define-prop），复杂度在涨，但内核始终是「收集 → 就地改写 → 合成集中声明」这三件套，全部跑在第 1 章那套懒解析 + 增量编辑的地基上。

下一章会把这套重写思路再往前推一步：`defineModels` 让一个 model **既是一根 prop，又是对应的 `update:` 事件**——从泛型类型里把每个字段抠出来，编译期同时塞进 `defineProps` 和 `defineEmits`，运行时再用 `useVModel` 把两者粘成一根可写的 ref。到那里你会看到，「重写成原生宏」的同一套手艺，怎么撑起双向绑定。

# 模板与渲染函数的重定向

> 本章属于 composite 层。前置：SFC 解析与增量 AST 编辑、编译期注入虚拟 helper 模块。
> 学完你能：用一句话讲清「Vue 默认渲染来源只有 template 一种、vue-macros 怎么在不改 Vue 的前提下把它扩展到四种新形态、代价是什么」。

## 1. 为什么需要它

上一章把 v-if/v-for 等模板指令翻译成 JSX 表达式，让 JSX 也能享有指令语义。但那章藏了一个前提——你得先选了 JSX。Vue 默认只认两种渲染来源：声明式的 `<template>` 块，或 `setup()` 函数末尾 `return` 一个渲染函数。

可现实里写代码的人常常撞到这道墙：用 JSX 或 `h()` 写完渲染逻辑，还得自己手动把它包成 `return () => (...)`；习惯 React 的人下意识写 `export default <div/>`，Vue 编译器直接不认；只想给插槽声明精确类型、不想为类型多塞一行运行时代码，原生没这个能力；想在同一个 SFC 里复用一段模板、又懒得抽成独立子组件——只能复制粘贴。

本章四个宏就是把这些「非默认渲染来源」在编译期重定向成 Vue 认得的形态。define-render 把 setup 里任意一行调用变成渲染函数 return；export-render 把 export default 当渲染入口；define-slots 把纯类型插槽声明整段抹掉；named-template 把可命名复用的模板片段拉成虚拟模板模块。

## 2. 核心思想

**渲染来源是一个可重定向的编译期接口，不是 Vue 的硬性约束**——只要在编译期能把「一段表达式」摆到 setup 末尾的 return 后、或者把整条语句抹成注释、或者把它引到一个虚拟模板模块，运行时根本不需要 Vue 知道有这么个机制存在。换句话说，「渲染入口唯一」是语法层的现象，不是语义层的硬约束。

## 3. 心智模型（以 named-template 为例）

四个宏里 named-template 最复杂，把它讲清就能串全章。它的转换横跨三阶段、四类对象：

```
源 SFC
  ├─ <template> 主模板：含 <template is="card"/>
  └─ <template name="card"> 命名模板（用户定义的复用片段）
        │
        ▼  [preTransform · 源阶段]
源 SFC 改写后
  ├─ 主模板：引用处 <template is="card"/> → <component is="named-template-card"/>（动态组件占位）
  ├─ 主模板内容外置到虚拟模块（避免和命名模板互相干扰）
  └─ 命名模板：HTML 存进内存字典 templateContent[filename][name]、原节点就地隐藏
        │
        ▼  [Vue 自己的模板编译器跑一遍]
编译产物 JS
  └─ 占位被编译成 _createVNode(_resolveDynamicComponent('named-template-card'))
        │
        ▼  [postTransform · 产物阶段]
最终 JS
  ├─ 顶部补 import block_card from "<命名模板虚拟模块>"
  ├─ 主模板 render 改成可变参数 (...args)
  └─ 占位调用改写成 block_card.render(...args)
```

四个角色：源 SFC（用户写的）、内存字典 templateContent（跨阶段共享状态）、虚拟模块（运行时由 load 钩子返回 render 委托）、编译产物 JS（Vue 编译器吐出的、含可识别的内部函数调用）。define-render 与 export-render 只在源/产物一端操作、define-slots 只在源端擦除，没有 named-template 这么多阶段。

## 4. 关键权衡

### 渲染来源下沉到 setup 任意位置

**选择**：define-render 找到 setup 函数体里的 `defineRender(arg)` 调用、把它的实参搬到所在块的 `return` 后面、删掉调用本身。

**换来**：用户可在 setup 任意位置用一行声明渲染来源，不必非写在最后 `return`；JSX、`h()` 返回值、已有渲染函数引用都能直接喂进去；非函数实参（如 JSX 求值结果）自动包一层惰性 `() =>` 函数。

**代价**：这个宏必须在「Vue 把 `<script setup>` 编译成 setup() 函数体之后」才能介入（时序晚于大多数宏，`enforce: 'post'`），且要小心处理「setup 里本就有 return」的情况——必须先把旧 return 删掉，否则会出现两个 return。

这里有两个对立的需求在打架：`<script setup>` 想保持「setup 体写啥就是 setup 函数体内容」的简洁，而用户想「渲染来源只是 setup 里的一行普通语句、不是末尾的 return」。Vue 选了前者（return 必须在最后），define-render 把 return 从语法结构降级成「一行调用就能触发的副作用」。

### 命名模板分两阶段：源层占位 + 编译产物改写

**选择**：定义阶段在 SFC 源层操作模板 AST（把命名模板内容外置、给引用处插占位 `<component is="named-template-X"/>`），等 Vue 自己编译完后，在 JS 产物层再识别占位、改写成命名模板 render 调用。

**换来**：能完整复用 Vue 自己的「模板→render」编译管线，命名模板自动享有 v-if/v-for 等全部指令能力，插件不用自己造模板编译器；引用占位走 Vue 正常的动态组件解析路径（`<component is>`），不引入新概念。

**代价**：后一阶段（postTransform）必须识别 Vue 编译器吐出的内部产物函数（`_createVNode` / `_createBlock` / `_resolveDynamicComponent`）——这些是不稳定的内部 API，编译策略或 Vue 版本一变就可能失效；而且同一个占位在不同位置会被编译成两种形态（普通创建节点 `_createVNode` vs 作为 block 根的 `_createBlock`+Fragment 包裹），必须分两条改写路径。

打架的双方是「想直接复用 Vue 编译器、不重造模板编译轮子」和「Vue 编译器只认它自己的产物函数、不会替插件留稳定接口」。named-template 的解法是绕到编译器身后、在产物里做改写，承担 Vue 内部 API 变动的风险。

### 命名模板内容外置成虚拟模板模块

**选择**：把命名模板的 HTML 存进插件内存字典 `templateContent[filename][name]`，用虚拟模块加载机制（复用前置章「虚拟 helper 模块」的三件套）把它像独立模板一样返回、交给 Vue 编译；当别处 import 这个虚拟模块时，返回一段 render 委托代码（指向真正的模板资源）。

**换来**：命名模板享有与主模板完全相同的编译能力，一段 HTML 被当作正经模板编译成 render；且能被任意多处 import 复用，同一份编译逻辑既服务主模板也服务命名模板。

**代价**：必须在很早的源阶段就把模板文本暂存、跨到加载阶段才取出（跨阶段状态共享，靠虚拟 id 里的 filename 关联）；还要把主模板也用外置 src 指向虚拟模板，避免命名模板与主模板共存于同一个 SFC 时让 Vue 编译困惑——这一步看起来多余，其实是为了让命名模板与主模板走对称的独立编译路径。

一边是「想让命名模板是真正的模板、享有 v-if/v-for 等完整编译能力」，另一边是「Vue 编译器一次只编一个 SFC 的一个 template」。named-template 把每个命名模板都「骗」成独立的虚拟模板文件，让 Vue 编译器以为自己在编第四个、第五个 SFC。

### 纯类型宏走「擦除」而非「注入」

**选择**：define-slots 找到 setup 里的 `defineSlots(...)` 调用，整条语句覆写成注释 `/*defineSlots*/`，运行时零残留。

**换来**：零运行时开销（不像双向绑定宏那样注入运行时 helper），类型信息只留在编译期供 IDE 与类型检查使用——插槽签名是纯类型层契约。

**代价**：必须在 Vue 编译擦除 setup 之前就介入（`enforce: 'pre'`），否则 Vue 编译器看到未知函数会报错；它本身不产生任何运行时行为，纯粹是类型层工具。

一边是「想给插槽声明精确类型」，另一边是「不想引入任何运行时代码」。define-slots 的解法与前一章「编译期注入 helper」恰好相反：一个往源码加东西（运行时桥接），一个把源码抹掉（纯类型擦除），两者都是用编译期改写换不同诉求。

## 5. 最小原理演示

```ts
// 演示 defineRender：把 setup 体内一行 defineRender(arg) 改写成块末尾的 return arg
// 含两个细节：先删旧 return（否则会有两个 return）；非函数实参包一层惰性 () => 让 JSX/h() 求值结果能当渲染函数
const setupBefore = `
function setup() {
  const count = ref(0)
  defineRender(h('div', count.value))
  return someOldReturn
}`

function redirectRender(code: string): string {
  const callMatch = code.match(/defineRender\((.+)\)/)
  if (!callMatch) return code
  const arg = callMatch[1]
  // 删旧 return，否则 setup 会出现两个 return
  let out = code.replace(/  return someOldReturn\n/, '')
  // 删 defineRender 调用本身
  out = out.replace(/  defineRender\(.+\)\n/, '')
  // 实参是 h(...) 表达式（非函数、非标识符），包惰性函数；插入到块末尾 return
  out = out.replace(/\}/, `  return () => (${arg})\n}`)
  return out
}

console.log(redirectRender(setupBefore))
// function setup() {
//   const count = ref(0)
//   return () => (h('div', count.value))
// }
```

```ts
// 演示命名模板两阶段：源层把命名模板 HTML 暂存 + 引用占位；产物层识别 Vue 内部调用并改写

// 输入：用户写的 SFC（含命名模板 card、主模板里用 is="card" 引用）
const sfc = `
<template>
  <h1>Main</h1>
  <template is="card"/>
</template>
<template name="card"><div class="card">hi</div></template>
`

// 跨阶段共享的内存字典（源阶段存、加载阶段取）
const templateContent = new Map<string, string>()

// 阶段 1：preTransform —— 在 SFC 源层操作
function preTransform(sfc: string): string {
  // 取出命名模板 HTML、暂存到内存字典（外置成虚拟模板模块）
  const namedMatch = sfc.match(/<template name="(\w+)">([\s\S]+?)<\/template>/)
  if (namedMatch) templateContent.set(namedMatch[1], namedMatch[2])
  // 删除命名模板原节点
  let out = sfc.replace(/<template name="\w+">[\s\S]+?<\/template>\n/, '')
  // 引用 <template is="X"/> → 动态组件占位 <component is="named-template-X"/>
  out = out.replace(/<template is="(\w+)"\/>/g, (_, n) =>
    `<component is="named-template-${n}"/>`)
  return out
}

const afterPre = preTransform(sfc)
// <template>
//   <h1>Main</h1>
//   <component is="named-template-card"/>
// </template>

// 假装 Vue 编译器跑完主模板，吐出 JS 产物
// 占位被编译成 _createVNode(_resolveDynamicComponent('named-template-card'))
const compiled = `
import { _createVNode, _resolveDynamicComponent, h as _h } from 'vue'
export function render() {
  return _createVNode('div', null, [
    _h('h1', null, 'Main'),
    _createVNode(_resolveDynamicComponent('named-template-card'))
  ])
}`

// 阶段 2：postTransform —— 在 Vue 编译产物（JS）里改写
function postTransform(code: string): string {
  // 识别 Vue 内部产物调用、改写成命名模板 render 调用
  const re = /_createVNode\(_resolveDynamicComponent\('named-template-(\w+)'\)\)/g
  const names = new Set<string>()
  const rewritten = code.replace(re, (_, name) => {
    names.add(name)
    return `block_${name}.render(...args)`
  })
  // 主模板 render 改成可变参数转发，让命名模板接住动态透传的数据
  const withArgs = rewritten.replace(/export function render\(\)/,
    'export function render(...args)')
  // 顶部补 import 命名模板虚拟模块
  const imports = [...names].map(n =>
    `import block_${n} from 'named-template:${n}'`).join('\n')
  return `${imports}\n${withArgs}`
}

console.log(postTransform(compiled))
// import block_card from 'named-template:card'
// import { _createVNode, _resolveDynamicComponent, h as _h } from 'vue'
// export function render(...args) {
//   return _createVNode('div', null, [
//     _h('h1', null, 'Main'),
//     block_card.render(...args)
//   ])
// }
```

## 6. 执行轨迹

输入 SFC（含 `<template name="card">…</template>` 且主模板里有 `<template is="card"/>`）：

```
[源 SFC]
  <template> <h1>Main</h1> <template is="card"/> </template>
  <template name="card"><div class="card">hi</div></template>
        │ preTransform 阶段
        ▼
  templateContent["card"] = "<div class=\"card\">hi</div>"   ← 内存字典记下
  主模板里 <template is="card"/> → <component is="named-template-card"/>
  命名模板节点：就地隐藏
        │ Vue 自己的编译器跑一遍主模板
        ▼
[编译产物 JS]
  _createVNode(_resolveDynamicComponent('named-template-card'))   ← 占位被编译成这样
        │ postTransform 阶段
        ▼
  识别为「命名模板引用」 → 改写为 block_card.render(...args)
  顶部补 import block_card from "named-template:card"
  render 改成 (...args) 可变参数
        │ 加载阶段（运行时）
        ▼
  import 触发 → load 钩子拦截虚拟 id → 返回 render 委托代码
  → card 的 HTML 被作为独立模板编译成真实 render 函数
        │ 渲染
        ▼
[运行时输出]
  引用处实际调用 block_card.render() → 渲染出 <div class="card">hi</div>
```

四类对象的最终命运：用户的命名模板 HTML 被复制到内存字典、经虚拟模块加载、编译成真实 render、在引用处被执行。

## 7. 教学简化说明

本章演示故意省略了：真正的 Vue 模板编译器调用（演示 b 用字符串拼接模拟）、虚拟模块的真实 `resolveId`/`load`/`loadInclude` 接线、JSX/h() 的真实求值、`_createBlock` + Fragment 那条改写路径（只演示了 `_createVNode` 路径）、vapor 分支、模板名转义工程、HMR、rollup `order: 'post'` 的兼容处理。

## 8. 小结

四个宏共享同一个底层动作：「编译期重写渲染来源」，但落点各异：define-render 移动 setup 体内的一行调用、named-template 跨源层与产物层两阶段改写、export-render 把 export default 翻译成 defineRender 调用、define-slots 干脆把整条语句抹成注释。代价集中在「必须紧贴 Vue 编译器、依赖其内部 API 与执行时序」。下一章继续重写 setup 内语句，但落点不是渲染来源——是把 setup 里某些语句「提升」到只跑一次的普通 script、把 export 翻译成 expose/props。
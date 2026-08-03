# 模板与渲染函数的重定向

想象你写 Vue 写熟了，某天突然有几个"别扭"的需求冒出来：这一段渲染逻辑分支太多，写在 `<template>` 里全是嵌套三元，想换成 JSX；你从 React 过来，习惯性地敲了 `export default` 想直接当渲染入口；你给插槽声明了精确的类型，却发现引入了没用的运行时代码；你想在同一个文件里复用一小段模板，又懒得为它单独抽一个子组件。

原生 Vue 对这些诉求要么做不到，要么写法割裂。本章要讲的四个宏，就是把这四种"非默认的渲染来源"在编译期统一重定向成 Vue 认得的形态。重定向完，运行时跑的还是 Vue 那套原生渲染——宏只在编译期干活。

## 一个共同的问题：渲染从哪来

可以把渲染来源想象成水龙头接的水源。Vue 默认只给你接了一根叫 `<template>` 的水管，偶尔允许你在 setup 里 `return` 一个渲染函数当备用。本章四个宏做的事，是给四条新水管装上转接头，让它们也能接到 Vue 的渲染出口上：

| 宏 | 你写的样子 | Vue 最终认的样子 | 本质 |
|---|---|---|---|
| define-slots | `defineSlots<T>()` | `/*defineSlots*/` | 整段抹掉，只留类型 |
| define-render | `defineRender(jsx 或 h())` | `return jsx 或 h()` | 表达式搬进 return |
| export-render | `export default h()` | `defineRender(h())` | 把 export 翻译成 defineRender |
| named-template | `<template is="x"/>` | 调用 `块_x.render()` | 模板片段提升为可复用渲染单元 |

下面从最简单的那个讲起，一步步走到最复杂的 named-template。

## 最简单的那个：define-slots，把类型声明整个擦掉

你给一个组件的插槽写了精确的类型，纯粹是给 IDE 和队友看的，运行时完全不需要它存在。

define-slots 做的事直接得让人意外：找到 setup 里的 `defineSlots(...)` 调用，把整条语句覆写成一条注释，运行时零残留。

```ts
// 你写的
defineSlots<{
  default: (props: { item: Item }) => any
}>()

// 编译期被改成
/*defineSlots*/
```

为什么覆写成注释而不是直接删？因为这样那行代码在编辑链里原地"蒸发"，不改变周围代码的位置（基于偏移的增量编辑是第 1 章讲透的地基，这里只是它最朴素的应用）。

这里出现本章第一组核心权衡。

**权衡一（擦除而非注入）**：define-slots 选择把整条调用替换成注释，换来零运行时开销——不像双向绑定宏那样注入运行时 helper，类型信息只活在编译期供 IDE 使用。代价是它必须卡在 Vue 编译擦除 setup 之前介入（插件用 `enforce: 'pre'`，抢在 Vue 前面），否则 Vue 看到一个不认识的 `defineSlots` 函数会直接报错；而且它自己不产生任何运行时行为，纯粹是个类型层工具。这个设计恰好和第 3 章「编译期注入虚拟 helper 模块」形成一组镜像对照：第 3 章是往源码里加东西（注入），这一节是把源码里的东西抹掉（擦除）。

## define-render：在 setup 任意位置用一行声明渲染来源

你想用 JSX 或者 `h()` 写渲染逻辑，因为这一段动态分支太多，写模板反而绕。

最直观的写法本来是 setup 函数末尾 `return` 一个渲染函数。但 define-render 让你不用非得写在最后——你在 setup 体的任意位置写一行 `defineRender(渲染来源)`，它会帮你把这一行变成函数的 return。

具体怎么变？先看看这个函数块里有没有已经存在的 return，有的话先删掉（否则会冒出两个 return）；接着在 return 的位置（或块末尾）插入 `return`，把你传给 defineRender 的实参搬到 return 后面；最后把 `defineRender(` 和配对的 `)` 这两个壳删掉。说人话就是：**把你那一行调用拆开，留下它的实参，再把实参挂到一个新建的 return 上。**

这里有个讨巧的细节。渲染函数要求的是"函数"，而你传进来的可能是个"值"——比如 `<h1>hi</h1>` 这种 JSX、或者 `h('div')` 这种 `h()` 调用，它们一求值就是个 vnode 对象，不是函数。define-render 检测到这种情况，会自动给你包一层惰性函数：`return () => (<h1>hi</h1>)`。但如果你传的是已经写好的渲染函数引用（一个标识符），或是个箭头函数，它就老老实实 `return`，不再多包。

下面这段最小演示，用一组语句对象模拟 setup 函数体，演透这套搬运动作：

```ts
// 用语句对象模拟 setup 函数体（真实插件里是基于偏移操作源码，第 1 章已展开）
type Stmt =
  | { type: 'expr'; name: string; arg: string; raw: string }
  | { type: 'return'; raw: string }
  | { type: 'other'; raw: string }

function defineRenderRewrite(body: Stmt[]): Stmt[] {
  // 1) 先删掉已有的 return —— 避免出现两个 return
  body = body.filter(s => s.type !== 'return')

  // 找到 defineRender 那一行
  const idx = body.findIndex(s => s.type === 'expr' && s.name === 'defineRender')
  if (idx === -1) return body
  const call = body[idx] as Extract<Stmt, { type: 'expr' }>

  // 2) 判定实参是不是"函数或标识符"：是则原样，否则要惰性包裹
  const arg = call.arg.trim()
  const isFnOrId = /=>/.test(arg) || /^function/.test(arg) || /^[a-zA-Z_$]\w*$/.test(arg)
  const returned = isFnOrId ? arg : `() => (${arg})`

  // 3) 把 defineRender(arg) 这一整行，原地改写成 return
  body[idx] = { type: 'return', raw: `return ${returned}` }
  return body
}

const print = (body: Stmt[]) => body.map(s => s.raw).join('\n')

// 场景 A：setup 末尾本来 return 了别的东西，现在改用 JSX
console.log(print(defineRenderRewrite([
  { type: 'other', raw: 'const state = ref(0)' },
  { type: 'return', raw: 'return { }' },
  { type: 'expr', name: 'defineRender', arg: '<h1>{state.value}</h1>', raw: 'defineRender(<h1>{state.value}</h1>)' },
])))
// 输出：
// const state = ref(0)
// return () => (<h1>{state.value}</h1>)      ← 旧 return 被删，JSX 被惰性包裹

// 场景 B：传的是已经写好的渲染函数引用
console.log(print(defineRenderRewrite([
  { type: 'other', raw: 'const myRender = () => h("div")' },
  { type: 'expr', name: 'defineRender', arg: 'myRender', raw: 'defineRender(myRender)' },
])))
// 输出：
// const myRender = () => h("div")
// return myRender                             ← 标识符，不包裹
```

注意 define-render 的插件用的是 `enforce: 'post'`——它必须等 Vue 把 `<script setup>` 编译成真正的 `setup()` 函数体之后才动手。因为你要操作的"函数块"和"return 语句"，是 Vue 编译产物里才成型的结构，源码层的 `<script setup>` 还没有函数体的概念。

**权衡二（把渲染函数声明降级为任意位置的一行调用）**：define-render 选择"找到那行调用，把实参搬到所在函数块的 return 后面"，换来你能在 setup 任意位置用一行声明渲染来源，不必非写在最后；而且 JSX、h() 返回值、已有的渲染函数引用都能直接喂进去（值类型自动包惰性函数）。代价是它必须晚于大多数宏介入（post 时序），且要小心处理 setup 里本就有 return 的情况——先删旧 return 是硬规矩，漏了就会出现两个 return。

### export-render：define-render 的前置适配器

如果你是从 React 过来的，可能更习惯 `export default` 当渲染入口。export-render 就是给你这个习惯补的适配器：它在源码层（`enforce: 'pre'`）找到 setup 里的 `export default <声明>`，把声明的文本切出来、删掉原语句，包成 `defineRender(...)` 追加到 `<script setup>` 末尾。

```ts
// 你写的
export default () => h('div', count.value)

// export-render 改写成
defineRender(() => h('div', count.value))
```

改写完，剩下的活它就不操心了——交给上面的 define-render 插件兜底，把 `defineRender(...)` 变成 `return`。所以 export-render 自己不碰 return，它只负责把 `export default` 这个语法翻译成 define-render 认识的 `defineRender()` 调用。两个宏一前一后（export-render 是 pre，define-render 是 post），接力完成"用 export 写渲染"这件事。

## named-template：把内联模板提升为可复用的渲染单元

你在一个 SFC 里反复用到一小段相同的模板结构，抽成独立子组件太重，内联复制又难维护。命名模板让你给一段模板起个名字，在主模板里随时引用。

这是本章最复杂的宏，它最能串起"重定向"这个主题。先建立一个简化的执行轨迹，看一遍它到底经历了什么：

```
你写的 SFC
  └─ ① 源阶段(插件 pre)：命名模板的 HTML 存进内存字典；引用处 <template is="card"/> 变成 <component is="named-template-card"/> 占位符；主模板内容外置
      └─ ② Vue 自己编译主模板：占位被编译成 _createVNode(_resolveDynamicComponent("named-template-card"))
          └─ ③ 产物阶段(插件 post)：识别出上面那个调用，改写成 block_card.render(...args)，顶部补 import
              └─ ④ 命名模板虚拟模块被加载：card 的 HTML 被当作正经模板编译成 render
                  └─ ⑤ 运行时：引用处实际调用 block_card.render()，渲染出复用的片段
```

为什么要拆成"源阶段"和"产物阶段"两步、中间还插一个 Vue 自己的编译？这是本章最关键的设计决策，留到下面权衡里展开。先看两段最小演示把这条轨迹走一遍。

第一段演示源阶段的占位改写：

```ts
// 跨阶段共享的内存字典：真实插件里靠虚拟 id 的 filename 关联 pre 和 post 两个插件闭包
const store: Record<string, any> = { templateContent: {} }

// === 源阶段（preTransform）===
function preTransform(src: string): string {
  // 1) 命名模板内容存字典、就地隐藏
  const named = src.match(/<template name="(\w+)">([\s\S]*?)<\/template>/)
  if (named) store.templateContent['App.vue'] = { [named[1]]: named[2] }

  // 2) 主模板里 <template is="X"/> 改写成动态组件占位符
  let main = src.replace(
    /<template is="(\w+)"\s*\/>/g,
    (_, n) => `<component is="named-template-${n}"/>`,
  )
  // 3) 删掉命名模板的定义本身
  return main.replace(/<template name=\w+>[\s\S]*?<\/template>/, '')
}

const sfcSource = `
<template><main><template is="card"/></main></template>
<template name="card"><div class="card">card body</div></template>
`
console.log(preTransform(sfcSource))
// 输出：
// <template><main><component is="named-template-card"/></main></template>
//                                              ↑ 占位符：交给 Vue 当动态组件处理
console.log(store.templateContent)
// { 'App.vue': { card: '<div class="card">card body</div>' } }
//                                              ↑ HTML 暂存，等加载阶段取
```

源阶段干完，Vue 接手编译主模板。它会把 `<component is="named-template-card"/>` 这个动态组件编译成一行创建节点的调用。我们把 Vue 吐出来的产物"假装"成下面这样（真实产物里 `_createVNode`/`_resolveDynamicComponent` 是 Vue 编译器内部的产物函数名）：

```ts
const vueCompiled = `
import { _createVNode, _resolveDynamicComponent } from 'vue'
export function render() {
  return _createVNode('main', [
    _createVNode(_resolveDynamicComponent("named-template-card"))
  ])
}`
```

第二段演示在产物上做的改写：

```ts
// === 产物阶段（postTransform）===
function postTransform(code: string): string {
  // 1) 识别"创建节点(解析动态组件("named-template-X"))"这种 Vue 编译器产物
  const re = /_createVNode\(_resolveDynamicComponent\("named-template-(\w+)"\)\)/g
  const imports = new Set<string>()
  const out = code.replace(re, (_, name) => {
    imports.add(name)
    return `block_${name}.render(...args)`   // 改写成命名模板的 render 调用
  })
  // 2) 顶部补 import：每个用到的命名模板引一个虚拟模块
  const importLines = [...imports]
    .map(n => `import block_${n} from "App.vue?type=template&namedTemplate&name=${n}"`)
    .join('\n')
  // 3) render 参数改成可变转发，让命名模板能接住主模板透传的数据
  const withArgs = out.replace(/export function render\(\)/, 'export function render(...args)')
  return importLines + '\n' + withArgs
}

console.log(postTransform(vueCompiled))
// 输出：
// import block_card from "App.vue?type=template&namedTemplate&name=card"
// import { _createVNode, _resolveDynamicComponent } from 'vue'
// export function render(...args) {
//   return _createVNode('main', [
//     block_card.render(...args)
//   ])
// }
```

改写完，引用处就变成了对 `block_card.render(...args)` 的真实调用。那 `block_card` 这个虚拟模块里的 render 从哪来？这正是第 3 章那套虚拟模块加载机制的变体——第 3 章用它装载运行时 helper，这里只是把装载内容换成了模板片段：当别的代码 import `App.vue?...&name=card` 这个虚拟 id 时，加载器从内存字典里取出之前存的 card 的 HTML，把它当作一段正经模板交给 Vue 编译成 render，再包成一个"有 render 方法的对象"返回。机制本身第 3 章已展开，这里不重复。

现在可以把 named-template 的两组核心权衡讲清楚了。

**权衡三（命名模板必须分两阶段：源层插占位符 + 编译产物改写）**：named-template 选择"在源层先给引用处插占位符（变成 Vue 认识的动态组件），真正的改写推迟到 Vue 编译完之后的 JS 产物层"，换来能完整复用 Vue 自己的"模板→render"编译管线——命名模板自动享有 `v-if`/`v-for` 等全部指令能力，不用自己造一个模板编译器；占位走的也是 Vue 正常的动态组件解析路径。代价是产物阶段必须去识别 Vue 编译器吐出的内部函数（`_createVNode`、`_createBlock`、`_resolveDynamicComponent`），而这些是不稳定的内部 API，编译策略或 Vue 版本一变就可能换名失效。更麻烦的是，同一个占位在不同位置会被编译成两种形态：普通位置是 `_createVNode(...)`，作为 block 根的时候会被包成 `_createBlock(_Fragment, [...])`。插件必须为这两种形态各写一条改写路径——前者直接整节点覆写成 `block_X.render(...args)`，后者要把首参换成 Fragment、再把 render 调用塞进 children 数组。这也解释了为什么 named-template 必须拆成 pre 和 post 两个插件实例：源层和产物层是两种完全不同的代码形态，单一 enforce 管不过来。

**权衡四（命名模板内容外置成虚拟模板模块）**：named-template 选择"把命名模板的 HTML 存进插件内存字典，再用虚拟模块加载机制把它像独立模板一样返回、交给 Vue 编译"，换来命名模板享有和主模板完全相同的编译能力（一段 HTML 被当成正经模板编成 render），且能被任意多处 import 复用。代价是它必须跨阶段共享状态：源阶段就得把模板文本暂存、一直存到加载阶段才取出来用（靠虚拟 id 的 filename 在 pre/post 两个闭包间关联）。还有一个不那么显然的连带代价——当 SFC 同时含命名模板和主模板时，为了让两者不互相干扰，主模板的内容也得外置（给它加个 `src` 指向另一个虚拟模板），让主模板走和命名模板对称的独立编译路径。

## 把四种重定向放在一起看

回头看那张表，四个宏其实是同一个原理的四种应用：渲染输出来源不止 `<template>` 一种，用编译期重写把它扩展到 setup 内的命令式表达式、纯类型的插槽声明、可命名复用的模板片段。运行时仍然只跑 Vue 那套原生渲染，宏只在编译期把"非默认形态"翻译成"Vue 认得的形态"。

四组权衡也对应着这条原理的四个侧面：
- define-slots：擦除而非注入，换零运行时开销，代价是必须抢在 Vue 之前介入。
- define-render：把渲染声明降级为任意位置的一行，换书写自由，代价是 post 时序和删旧 return 的硬规矩。
- named-template（两阶段）：源层插占位符 + 产物改写，换复用 Vue 模板编译管线，代价是依赖不稳定的编译器内部 API、还得为两种编译形态各写一条改写路径。
- named-template（虚拟模块）：内容外置换对称的完整编译能力，代价是跨阶段状态共享和主模板被迫一起外置。

下一章《静态提升与 export 语义重写》会换一个角度处理 setup 内的语句：不再改"渲染从哪来"，而是改"哪些语句只该执行一次"——把静态常量从 `<script setup>` 提升到普通 `<script>`，再把 `export` 重写成 `defineExpose`/`defineProps`，让 setup 像普通模块那样用 export 暴露。
# 突破单 script setup 的 SFC 结构扩展

> 本章属于 composite 层。前置：SFC 解析与增量 AST 编辑、编译期注入虚拟 helper 模块。
> 学完你能：用一句话讲清「为什么 setup-component 要把内联函数抽成虚拟 `.vue` 再 import 回来、为什么注入要用延迟闭包而不是立即快照」。

## 1. 为什么需要它

上一章把 `$ref/$()` 标记的变量读写静默改写成 `.value` 访问。那个改写始终局限在一个 `<script setup>` 内部、在表达式层面打转。Vue 还有另一条更隐形的铁律：一个 `.vue` 文件恰好等于一个 `<script setup>` 块。本章要撬开的就是这条文件级的形状约束。

这条规则平时没什么不便，但有两个场景会卡住。

场景一：想在父组件里**内联**定义一个一次性子组件。某个对话框只在 `Dashboard.vue` 里用一次，按惯例得另起一个 `DashboardDialog.vue`，再把父组件想用的状态用 props/emits 一份份搬过去。组合粒度被文件边界卡死——你想就近写，规则却逼着你拆。

场景二：有些脚本天然就只是一段 setup。比如纯渲染脚本，整个文件就是一段 `export default () => <JSX />`，却被 `<template>/<script>` 双块结构绑架，明明没有模板，还得写一堆样板标签才能让它跑起来。

根上的问题是同一个：SFC 的形状被钉死了。vue-macros 的 setup-block / setup-sfc / setup-component 三个宏，分别从轻到重地松动这条规则。前两个只是文本层面的改名和包裹，真正的难题在第三个：怎么让"在父组件里写一个内联子组件"这件事跑通。

## 2. 核心思想

把"一个函数体"在编译期升级成"一个完整的虚拟 `.vue` 文件"，让它走一遍 Vue 编译流水线（props/emits/HMR/类型工具/JSX 全套能力都拿到），再用一枚**延迟求值的闭包**当子弹，把外层作用域里的变量射穿 ES module 的 import 边界、注射进这个虚拟文件。

换句话说：把组合的边界从「文件」退回到「函数」。文件是死的、不能跨边界共享局部变量；函数是活的、自然带闭包。让一个内联组件既能享受正经 SFC 的全部待遇，又能像普通函数那样直接用父作用域里的变量。

## 3. 心智模型

三个宏按侵入度递增构成一条谱系：

| 宏 | 干什么 | 是否跨文件 | 是否需要闭包子弹 |
|---|---|---|---|
| setup-block | 把 `<setup>` 标签改写成 `<script setup>` | 否 | 否 |
| setup-sfc | 把整份 `.setup.[tj]sx` 文件用一个 `<script setup>` 包起来 | 否 | 否 |
| setup-component | 把内联组件函数体抽成虚拟 `.vue` 子模块再 import 回来 | 是 | 是 |

前两个是 setup-component 的退化子集：setup-block 只做标签的文本替换（用 `@vue/compiler-dom` 的 parse + magic-string 偏移改写，把 `<setup>` 和 `</setup>` 改成 `<script setup>` 和 `</script>`）；setup-sfc 只做单文件包裹（找到 `export default <expr>`，追加 `defineRender(<expr>)` 并删除原 export，然后把全文包进 `<script setup lang="...">`）。

setup-component 才是这章的硬骨头，六步流转：

1. **扫描**：在源文件里找出所有内联组件函数体（按 `defineSetupComponent(...)` 调用或 `: SetupFC` 类型注解识别），同时沿作用域链上溯收集每个调用点此刻**全部可见**的变量名。
2. **改写调用点**：函数体擦除，换成 `导入名(() => ({ 可见变量 }))`，一枚返回变量快照的延迟闭包；文件顶部追加一行 import，指向一个不存在的虚拟 `.vue` 路径。
3. **拦截虚拟模块**：打包器来加载这个虚拟文件时，load 钩子现场合成内容：把原函数体用 `<script setup>` 包起来，并在顶部插一行 `const { 外层变量 } = ctx()` 把闭包解包成本地变量。
4. **渲染接管**：把函数体里的 `return <JSX>` 改写成 `defineRender(...)`，渲染语义由下游的 define-render 宏消费。
5. **Vue 二次编译**：合成的 SFC 字符串流回 Vue 编译器，被正常编成 `export default 组件工厂`。
6. **编译后穿针**：Post 钩子在 Vue 产物上把 `export default 工厂` 改成 `(ctx) => 工厂`，于是步骤 2 传进来的那枚延迟闭包，在这里经工厂调用接到了 setup 内部。父作用域的变量穿过 import 边界，注入完成。

setup-block 和 setup-sfc 是这条链的子集：前者停在第 1 步的标签文本替换，后者停在第 3 步的单文件包裹，它们都不跨文件、不需要闭包子弹。

## 4. 关键权衡

### 把函数体抽成虚拟 `.vue` 子模块，而不是直接编译成内联渲染函数

选择：把内联组件函数体抽成一个虚拟 `.vue` 子模块，靠 `import` 拉回来。
换来：子组件走完整 Vue 编译流水线，被工具链识别为正经组件，props/emits/JSX/HMR/Volar 类型提示全套能力都拿得到。
代价：必须用 `scan / transform / load / postTransform` 四个阶段跨 Pre 与 Post 两个 enforce 钩子协调，每个组件还要伪造一个唯一虚拟路径 `<原id>-setup-component-<i>.vue`。

背后化解的本质矛盾是：组件作者想要"一次性、就近写"的轻量，工具链又要求正经组件必须经过 Vue 编译器的完整流水线。抽虚拟子模块把这对矛盾外包给打包器的 resolveId/load：你写一个普通函数，宏在打包器眼里伪造一个 SFC 文件，Vue 编译器甘心情愿地接管它。

### 用延迟求值闭包，而不是立即拷一份值

选择：注入的是 `() => ({ a, b, c })` 这种延迟求值的闭包，而不是 `{ a, b, c }` 立即快照。
换来：能捕获**尚未初始化**的变量。最典型的两种是 `var baz`（提升但还没赋值）和自引用的导出名 `App`（在调用求值时压根还没绑定）。换成立即快照，前者读到 `undefined`、后者直接抛 `ReferenceError`；换成延迟闭包，等 setup 真正运行时再读，外层的真值已就绪。
代价：注入的是一个"现读现取"的快照函数，外层重赋值会渗透进子组件——读者看到一行 `ctx()` 调用，没法一眼推出里面是什么、会不会变。

背后化解的本质矛盾是：编译期就要决定注入什么变量，但有些变量到运行时才有真值。延迟闭包把"决定注入谁"和"实际取值"拆开：前者编译期写死在变量列表里，后者推迟到 setup 真正运行的那一刻。

### 调用点自动收集全部可见声明，而不是让用户手写依赖列表

选择：在调用点沿作用域链自动上溯收集全部可见声明，load 时再扣掉子组件自身声明的变量。
换来：用户写起来和普通函数一样自然，不用像 React 的 `useCallback([deps])` 那样手列依赖。
代价：会把**用不上的变量**也打进闭包；依赖作用域分析正确识别块作用域（块作用域里的 `let/const` 不能被错误提升进闭包列表）。

背后化解的本质矛盾是：手写依赖太啰嗦容易漏，自动收集又必然过度。过度（多打几个用不上的变量）远比遗漏（漏一个就 bug）安全。这条权衡在所有"自动依赖收集"机制里都看得到，从 Vue 的 `computed` 自动追踪到 React 早期的 `useEffect` 手列之争，本质都是同一个天平。

### 把作用域参数注入拆进 Post 钩子，而不是一次 transform 到底

选择：作用域参数注入（把 `export default 工厂` 改成 `(ctx) => 工厂`）拆到 Post 插件，而不是和调用点改写一起在 Pre 完成。
换来：注入能精确发生在"Vue 把 setup 编成组件工厂之后"——此时 Vue 产物的 `export default _export_sfc(_sfc_main, [...])` 这种结构化形态刚好可以挂钩，那枚延迟闭包经 `_sfc_main(ctx)` 调用一路接到 setup 内部。
代价：一个宏被迫占据 Pre 和 Post 两个 enforce 槽位；Post 还得同时处理两种产物 id——主入口 `.vue` 用 `(ctx)` 包 `_sfc_main`，`?vue&type=script` 脚本子块用 `(__MACROS_ctx)` 包 `defineComponent`，两层参数名不一致是 Vite 拆分 SFC 产生的历史演进，但传递的是同一枚闭包。

背后化解的本质矛盾是：调用点改写必须**先于** Vue 编译（不先擦掉函数体，Vue 编译器看到的就不是合法 SFC）；作用域参数注入又必须**后于** Vue 编译（拿不到 `export default 工厂` 这种结构化产物就无处可挂）。一个宏因此被 Vue 编译这道流水线切成两半：Pre 阶段改源码、Post 阶段改产物。

## 5. 最小原理演示

下面这段演示只演 setup-component 的核心思想：调用点覆写 + load 合成 + Post 穿针，跑通「外层变量穿过 import 边界」这件事。**不演示**多组件索引、HMR、真 Vue 编译、Post 的双分支差异、resolveId 的子模块相对 import 处理。

```ts
// 演透「虚拟 SFC + 闭包子弹」：调用点覆写 → load 合成 → Post 穿针
// 输入：内联组件函数体、调用点沿作用域链收集的可见变量、子组件自身声明的局部变量

function transformInlineComponent(
  body: string,
  visible: string[],
  rootVars: string[],
) {
  const importName = '__MACROS_setupComponent_0'

  // Pre·transform：调用点覆写成「导入名(() => ({ 可见变量 }))」
  // 用延迟闭包而非立即快照，让 var 提升 / 自引用导出也能在 setup 运行时取到真值
  const callSite = `${importName}(() => ({ ${visible.join(', ')} }))`

  // Pre·load：现场合成虚拟 SFC，把函数体包进 <script setup>，顶部插 ctx() 解包
  // 扣掉子组件自身声明的变量，避免覆盖局部变量
  const injected = visible.filter((n) => !rootVars.includes(n))
  const virtualSfc = [
    '<script setup>',
    `const { ${injected.join(', ')} } = __MACROS_ctx();`,
    body,
    '</script>',
  ].join('\n')

  // 模拟 Vue 编译 + Post 穿针：
  // 工厂被包成 (ctx) => defineComponent(...)，setup 内的 ctx() 解包出外层变量
  // 调用点那枚 () => ({...}) 闭包经工厂调用传入，外层变量穿透 import 边界
  const finalFactory = `export default (__MACROS_ctx) => defineComponent({
  setup() {
    const { ${injected.join(', ')} } = __MACROS_ctx();
    ${body}
  }
})`

  return { callSite, virtualSfc, finalFactory }
}

// 跑一遍：验证外层 foo / baz / App 都穿过了 import 边界
const r = transformInlineComponent(
  'console.log(foo, baz, App)',
  ['foo', 'baz', 'App'],  // 调用点沿作用域链收集
  [],                     // 子组件没有自身局部变量
)
console.log('【调用点覆写】\n' + r.callSite)
console.log('\n【load 合成的虚拟 SFC】\n' + r.virtualSfc)
console.log('\n【二次编译 + Post 穿针】\n' + r.finalFactory)
```

跑出来的三段产物连起来读：调用点那枚 `() => ({ foo, baz, App })` 是一颗延迟闭包，先被打包器视作「对虚拟 `.vue` 文件的 import」路由到 load 钩子；load 现场拼出一份带 `ctx()` 解包语句的合法 SFC；Vue 编译器接过这份 SFC 编成组件工厂；最后 Post 把工厂包成 `(ctx) => 工厂`——闭包在这里真正求值，setup 内的 `ctx()` 拿到的就是父作用域此刻的真值。

## 6. 执行轨迹

拿一段具体输入走一遍。源码：

```ts
const foo = 'foo'
var baz
export const App = defineSetupComponent(() => {
  console.log(foo, baz, App)
})
```

注意 `baz` 是 `var`（提升但调用时尚未赋值）、`App` 是组件自身导出（求值时还没绑定），这两个引用是延迟闭包价值的试金石。

**步骤 1（扫描）**：识别 `defineSetupComponent(...)` 调用，沿作用域链收集可见声明，结果是 `{foo, baz, App}`。

**步骤 2（Pre·transform）**：调用点覆写为：

```ts
import __MACROS_setupComponent_0 from 'app.tsx-setup-component-0.vue'

const foo = 'foo'
var baz
export const App = __MACROS_setupComponent_0(() => ({ foo, baz, App }))
```

此时 `() => ({ foo, baz, App })` 这枚闭包**没有立即求值**，所以 `baz` 的"未赋值"和 `App` 的"未绑定"都不构成问题，引用本身活着。

**步骤 3（Pre·load）**：打包器要加载 `app.tsx-setup-component-0.vue`，load 钩子现场合成：

```vue
<script setup>
const { foo, baz, App } = __MACROS_ctx();
console.log(foo, baz, App)
</script>
```

**步骤 4–5（Vue 二次编译）**：合成 SFC 流回 Vue 编译器，编出 `export default defineComponent({ setup() {...} })`。

**步骤 6（Post·穿针）**：Post 钩子把工厂包成接收 `ctx` 的箭头函数：

```ts
export default (__MACROS_ctx) => defineComponent({
  setup() {
    const { foo, baz, App } = __MACROS_ctx();
    console.log(foo, baz, App)
  }
})
```

回到调用点：`__MACROS_setupComponent_0(() => ({ foo, baz, App }))` 现在调用的是一个 `(ctx) => 工厂` 的箭头函数，那枚延迟闭包作为 `ctx` 传进去。setup 内的 `__MACROS_ctx()` 现读现取：此刻外层的 `foo === 'foo'`、`baz` 已经赋过值、`App` 也已绑定到工厂产物，三个值全部正确穿过 import 边界。

## 7. 教学简化说明

本章演示故意省略：多组件索引（一个文件里多个内联组件各自下标）、HMR（`hotUpdate` 递归收集子模块做失效）、作用域链上溯的完整实现（依赖 rollup 的 `attachScopes`）、真 props/JSX 编译（Vue 编译器如何处理合成 SFC 内的 JSX）、Post 的主入口 `.vue` 与 `?vue&type=script` 脚本子块两种产物 id 的参数名分支、resolveId 里 rollup/vite 专属的「子模块相对 import 回主模块 resolve」逻辑。这些都是工程必要但与核心思想无关的实现细节。

## 8. 小结

这一章把「一个组件 = 一个 `.vue` 文件」撬开了三种松紧不同的口子。最重的 setup-component 用「虚拟子模块 + 延迟闭包」把组合边界从文件退回到函数，代价是一个宏横跨 Pre/Post 两阶段、四步骤协调，闭包的"现读现取"语义也让读者看 `ctx()` 时要多想一层。

下一章换条路继续松动 SFC 的形状约束：在 JSX 里镜像 Vue 模板指令，把 `v-if/v-for/v-model` 这些原本只在 `<template>` 里有效的能力，原样搬进 JSX 写法。
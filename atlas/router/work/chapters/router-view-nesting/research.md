# RouterView 嵌套渲染 · 源码精读

## 给 Writer 的教学钩子（必填，8 子项缺一不可）

- **用户痛点 / 场景**：几乎每个非平凡应用都有嵌套路由（如 `/users/:id/profile` 的详情页要渲染在 `UserLayout` 内部的某个"出口"里）。如果没有自动嵌套机制，使用者就得手动把"当前 URL 拆出的每一级路由记录"逐一对应到模板里嵌套的若干出口组件，并自己维护"第几层渲染谁"——路由层级一变，模板就得跟着改。需要的是：在任意层级写一次出口组件，就能自动对齐到正确的路由层。

- **一句话核心思想**：把"该渲染第几层路由"这件事，变成一个沿组件树向下传递的整数 depth，每个出口凭 depth 从 matched 链里取出对应那一级。

- **设计动机（为什么需要它）**：本章解决"嵌套出口如何零配置对齐路由层级"这个矛盾，换来任意深的嵌套视图无需任何接线即可工作。其中两处"承前"请 Writer 做跨章去重：① currentRoute 这个驱动源——它如何被浅响应只在最外层替换以驱动视图——**已在「Router 核心与导航主循环」讲透**，本章只看 currentRoute 被 RouterView 消费的新侧面：作为 matched 链的来源、按 depth 做下标选取；② matched 链如何从 parent 链反推出来**已在「路由匹配表」讲透**，本章只看 matched 作为有序数组被 depth 下标消费这一面，不重演其构造。

- **关键权衡（本 Atlas 核心；机制丰富章，4 条）**：
  1. **用隐式的依赖注入向下传 depth（而非显式 props 链）** → 换来零配置嵌套：使用者在任意子组件模板里写一个出口就自动接上正确层级，路由层级变了模板不用改 → 代价是 matched 数组的父子顺序成了承重的隐式契约（顺序错乱会静默渲染错组件），且 depth 是个看不见的隐式依赖，调试时必须额外靠 devtools 暴露。
  2. **取 depth 时用 while 循环跳过"无组件"的路由记录（passthrough）** → 换来"只为复用 path 前缀、自身不渲染组件"的中间路由能透明工作，使用者无需为它们配假组件 → 代价是 depth 变成"有效下标"而非注入进来的原始值，matched 的数组下标与 depth 不再一一对应，概念上多了一层。
  3. **把要渲染的组件作为 vnode 交给作用域插槽（slot）交还使用者，而不是在库内部包过渡/缓存组件** → 换来使用者完全掌控组合（自己决定要不要过渡、要不要缓存，库不绑定会随 Vue 版本变动的控制流组件）→ 代价是旧的"直接用过渡组件包住出口"的写法失效（函数式组件在 Vue 3 不再 eager 求值），必须改写成 slot 形式，库还得专门发一条诊断码来警告这个迁移。
  4. **把已挂载的组件实例登记回路由记录上，并在实例复用、记录变更时迁移守卫** → 换来导航守卫（更新/离开）和"进入守卫的 next 回调"能按命名视图找到当前实例、被复用的实例其守卫跨路由变更不丢失 → 代价是要维护一个 post-flush 时机（DOM 挂载后）的 watch 做登记、卸载时手动把实例置空防止泄漏、以及"实例复用但路由记录换了"时把守卫从旧记录搬到新记录这类边界处理。

- **最小心智模型（3～7 步）**：
  1. 根应用在安装时把"当前路由"（一个响应式 ref）注入全局，供所有出口共用。
  2. 最外层出口注入它，并注入一个默认 depth = 0。
  3. 该出口用 depth 在 matched 链里取第 depth 项；若这一项没有组件（passthrough 记录），就让 depth 自增继续往后找，得到"有效 depth"。
  4. 取 `matched[有效depth]` 上对应出口名（默认 default）的组件作为要渲染的目标。
  5. 把 `有效depth + 1` 重新注入给后代——于是这个组件模板里若再写一个出口，它会自动取 matched 的下一项。
  6. 渲染时把目标组件包成 vnode 交给作用域插槽；若使用者没提供 slot，则直接渲染该 vnode。
  7. 组件挂载后，把它的实例写回 `matched[有效depth].instances[出口名]` 供守卫查找；卸载时把该位置空。

- **最小原理演示（替代旧"复刻范围"）**：
  - 应演示：用极简的 Vue 复刻"depth 经依赖注入向下传 + matched[depth] 选取 + 跳过无组件记录 + 作用域插槽交出组件"，几十行即可；每一行都要对应上面某条权衡——注入/提供 depth 演权衡①，while 跳过 passthrough 演权衡②，slot 交出 vnode 演权衡③，把实例写回记录演权衡④。
  - 应故意省略：routeProps 的三态派发、命名视图多 name 分支、devtools 上下文戳记、守卫迁移 watch 的全部细节、attrs 手动继承、诊断码与弃用警告、RouteMap 泛型。不追求工程完整，只追求演透原理。
  - 演示载体建议：**首选 TS/JS**。本章核心是 Vue 的依赖注入 + 渲染组合模式，属于"设计模式 / 数据流"范畴，TS/JS（配真实 Vue 的 h / provide / inject / defineComponent）能忠实演透，且本 Atlas 本身就是 JS 生态的 VitePress 站，TS/JS 演示对读者最友好、能直接跑出一个嵌套渲染轨迹。无需退回原仓库语言（本就是 TS）。

- **正文不宜展开的细节**：routePropsOption 的 true / 函数 / 对象三态派发（用于把路由参数或函数结果作为 props 注入子组件）；inheritAttrs:false 下的手动 attrs 转发；命名视图（一个出口配 name 渲染多个具名组件）；devtools 把 depth/name/path/meta 戳记到实例上；compatConfig MODE:3 兼容；useRoute 的 RouteMap 泛型与按名收窄。

- **推荐的一个执行轨迹例子**：路由 `/admin/users/42`，matched 链 = [AdminLayout(有组件), AdminSection(无组件·passthrough), UserDetail(有组件)]。根出口 depth=0 → matched[0]=AdminLayout 有组件 → 渲染 AdminLayout，并对后代注入 depth=1。AdminLayout 模板里再写一个出口 → 注入得到 depth=1 → matched[1]=AdminSection 无组件 → while 自增到 depth=2 → matched[2]=UserDetail 有组件 → 渲染 UserDetail。结果：两层出口分别对齐到 AdminLayout 与 UserDetail，中间的 passthrough 被透明跳过。

> 以上钩子供 Writer 写「动机→核心思想→心智模型→关键权衡→原理演示」；下面事实部分供核对，不要被 Writer 当目录照抄。

## 概念要点

- **出口的消费契约：注入 currentRoute + 默认 depth**。RouterView 在 setup 里 `inject(routerViewLocationKey)`（即根应用提供的 currentRoute），并 `inject(viewDepthKey, 0)` 取得父级给的 depth（无父级时为 0）；`routeToDisplay` 优先用 props.route 覆盖，否则用注入的 currentRoute。源码位置: packages/router/src/RouterView.ts:68-72

- **有效 depth：跳过 passthrough 记录**。`depth` 是个 computed：从注入的初始 depth 起，只要 `matched[initialDepth]` 没有 `components`（即该路由记录只用于复用 path、自身不渲染），就 initialDepth++ 继续往后找，直到命中一个有组件的记录。这就是"无组件的中间路由被透明跳过"的实现。源码位置: packages/router/src/RouterView.ts:73-86

- **凭 depth 取要渲染的记录与组件**。`matchedRouteRef = matched[depth]`；render 时 `ViewComponent = matchedRoute.components[currentName]`（currentName 默认 'default'，对应命名视图）。源码位置: packages/router/src/RouterView.ts:87-89, 147-149

- **向后代注入 depth+1（嵌套自动对齐的关键）**。setup 里 `provide(viewDepthKey, computed(() => depth.value + 1))`，并把当前 matchedRouteRef、routeToDisplay 一并提供。于是子模板里再写的出口会拿到 depth+1，自动取 matched 的下一项——零配置嵌套就靠这一行。源码位置: packages/router/src/RouterView.ts:91-96

- **作用域插槽交出 vnode**。render 返回 `normalizeSlot(slots.default, { Component, route }) || component`：把"要渲染的组件 vnode"交给使用者的 slot，由使用者决定是否包过渡/缓存；无 slot 时兜底直接渲染该 vnode。`normalizeSlot` 把单元素 slot 内容解包成裸 vnode。源码位置: packages/router/src/RouterView.ts:203-217

- **routeProps 三态派发**。从 matched record 取 `props[currentName]`：为 true 时把整份 route.params 作为 props；为函数时调用 `fn(route)` 取返回值；为对象时直接用该对象。结果与 attrs 合并后透传给子组件。源码位置: packages/router/src/RouterView.ts:156-163, 172-178

- **实例登记回路由记录**。用一个 `flush:'post'` 的 watch 监听 `[viewRef.value, matchedRouteRef.value, props.name]`：组件挂载/复用时把实例写入 `to.instances[name]`；当"实例复用但记录从 from 变 to"时，把 from 的 leaveGuards/updateGuards 迁移到 to（防守卫丢失）；并触发该命名视图的 beforeRouteEnter next 回调。源码位置: packages/router/src/RouterView.ts:98-140

- **卸载时清引用防泄漏**。给 h 出来的 vnode 挂 `onVnodeUnmounted`：当该 vnode 真正卸载时，把 `matchedRoute.instances[currentName]` 置 null，避免记录上残留失效实例引用。源码位置: packages/router/src/RouterView.ts:165-170

- **devtools 暴露 depth（补偿隐式依赖的可观测性）**。dev/prod-devtools 下，把 `{depth, name, path, meta}` 戳记到所渲染组件实例的 `__vrv_devtools` 上——因为 depth 是隐式注入、不可见，必须靠 devtools 让使用者看到"这个实例对应 matched 的第几层"。源码位置: packages/router/src/RouterView.ts:180-201

- **弃用用法警告**：检测到 RouterView 被 `<keep-alive>` 或 `<transition>` 直接包裹（旧用法）时，通过 `diagnostics.VUE_ROUTER_R0060` 报警——因为函数式组件在 Vue 3 不再 eager，旧包裹写法失效，须改用 slot 组合。源码位置: packages/router/src/RouterView.ts:245-259

- **注入符号：类型化的内部 DI 接缝**。injectionSymbols 定义 5 个 `Symbol(...) as InjectionKey<T>`：`viewDepthKey`(depth)、`matchedRouteKey`(当前出口渲染的记录，供 onBeforeRouteUpdate/Leave 用)、`routerViewLocationKey`(出口用的当前路由 ref)、`routerKey`(router 实例)、`routeLocationKey`(useRoute 用的当前路由)。均为 `@internal`，`__DEV__` 时带可读描述串、生产环境为空串。源码位置: packages/router/src/injectionSymbols.ts:13-53

- **useRouter/useRoute 是 inject 的薄封装**。`useRouter() = inject(routerKey)!`；`useRoute() = inject(routeLocationKey)`（带 RouteMap 泛型按名收窄）。组合式 API 入口只是把模板里的 $router/$route 换成 inject 调用。源码位置: packages/router/src/useApi.ts:11-25

- **根应用的 provide 起点（外部接续点）**。router 的 install 里 `provide(routerKey, router)`、`provide(routeLocationKey, shallowReactive(reactiveRoute))`、`provide(routerViewLocationKey, currentRoute)`——这是上面所有 inject 的源头，把核心导航产物接到 RouterView 与 useApi。源码位置: packages/router/src/router.ts:1054-1056

- **matched 是有序数组（外部接续点）**。`RouteLocationMatched extends RouteRecordNormalized`，其 `components` 是 `Record<string, RouteComponent>`（非懒）；加载态路由的 `matched: RouteRecord[]` 是从父到子的有序数组——这正是"按 depth 下标"能成立的前提。源码位置: packages/router/src/types/index.ts:148-151, 435；记录上的 `components/props/leaveGuards/updateGuards/enterCallbacks/instances` 字段见 源码位置: packages/router/src/matcher/types.ts:33,52,62,68,74,84

## 关键调用链

安装期（一次）:
router.install → provide(routerKey) / provide(routeLocationKey) / provide(routerViewLocationKey=currentRoute)
源码位置: packages/router/src/router.ts:1054-1056

每个 RouterView 实例（setup）:
inject(routerViewLocationKey)=currentRoute → routeToDisplay
→ inject(viewDepthKey, 0)=初始depth
→ depth computed：while matched[initialDepth] 无 components 则 initialDepth++（跳 passthrough）
→ matchedRouteRef = matched[depth]
→ provide(viewDepthKey, depth+1) + provide(matchedRouteKey) + provide(routerViewLocationKey=routeToDisplay)
源码位置: packages/router/src/RouterView.ts:68-96

渲染（render）:
matchedRoute.components[name] = ViewComponent
→ routeProps 三态派发(params/fn/对象)
→ h(ViewComponent, assign(routeProps, attrs, {onVnodeUnmounted, ref:viewRef}))
→ normalizeSlot(slots.default, {Component, route}) || component
源码位置: packages/router/src/RouterView.ts:147-208

挂载/卸载副作用（post-flush watch + onVnodeUnmounted）:
watch([viewRef, matchedRouteRef, name]) → to.instances[name]=instance（复用时迁移 leaveGuards/updateGuards、触发 enterCallbacks）
onVnodeUnmounted → 卸载时 matchedRoute.instances[name]=null
源码位置: packages/router/src/RouterView.ts:98-140, 165-170

useApi:
useRouter → inject(routerKey)；useRoute → inject(routeLocationKey)
源码位置: packages/router/src/useApi.ts:11-25

## 源码摘录（带行号，全文累计 ≤ 30 行）

depth 计算（跳过 passthrough 记录，演权衡②）:
```ts
// RouterView.ts:75-86
const depth = computed<number>(() => {
  let initialDepth = unref(injectedDepth)
  const { matched } = routeToDisplay.value
  let matchedRoute: RouteLocationMatched | undefined
  while (
    (matchedRoute = matched[initialDepth]) &&
    !matchedRoute.components
  ) {
    initialDepth++
  }
  return initialDepth
})
```

向后代注入 depth+1 并暴露当前记录（演权衡①：嵌套自动对齐靠这一行）:
```ts
// RouterView.ts:91-96
provide(
  viewDepthKey,
  computed(() => depth.value + 1)
)
provide(matchedRouteKey, matchedRouteRef)
provide(routerViewLocationKey, routeToDisplay)
```

把组件作为 vnode 交给 scoped slot（演权衡③：交出而非内置控制流）:
```ts
// RouterView.ts:203-208
return (
  // pass the vnode to the slot as a prop.
  // h and <component :is="..."> both accept vnodes
  normalizeSlot(slots.default, { Component: component, route }) ||
  component
)
```

## 易混淆 / 边界 / 推断

- **事实**：`depth`（computed 的有效值）与 `injectedDepth`（父级 provide 的原始值）不一定相等——passthrough 跳过后 depth ≥ injectedDepth。子出口拿到的 provide 值是 `depth.value + 1`（基于有效 depth），不是 `injectedDepth + 1`，因此连续多层 passthrough 会被一次跳过且不破坏后代对齐。源码位置: packages/router/src/RouterView.ts:75-94

- **事实**：props.route 覆盖会连带影响整个子树——当传入 route prop 时，`routeToDisplay` 用它，且被重新 `provide(routerViewLocationKey, routeToDisplay)`，于是该出口的所有后代出口也渲染这条覆盖路由（而非全局 currentRoute）。这是测试/预览任意路由的入口。源码位置: packages/router/src/RouterView.ts:69-71, 96

- **事实**：实例登记用的是 `flush:'post'` watch，确保 DOM 挂载后才拿到 viewRef.value；守卫迁移的触发条件是 `from && from !== to && instance && instance === oldInstance`（记录变了但实例是同一个被复用的）。源码位置: packages/router/src/RouterView.ts:104-123, 139

- **推断**：把 instances/守卫挂在"路由记录"而非"出口组件实例"上，是为了让多 app 共用同一 matcher 表时守卫能按记录聚合（注释 matcher/types.ts:76-83 说明此意）；代价是同一命名视图的实例槽位是单数，多 app 渲染同一具名视图会互相覆盖实例引用。源码位置: packages/router/src/matcher/types.ts:76-84

- **推断**：scoped slot 交出 vnode 的设计（而非库内置 `<transition>`/`<keep-alive>`），本质是把"组件实例的控制流组合权"让渡给使用者——这与弃用警告（旧包裹写法失效）是同一决策的两面：库主动放弃对控制流组件的所有权。源码位置: packages/router/src/RouterView.ts:203-208, 245-259

- **未理解**：`compatConfig: { MODE: 3 }`（#1315 兼容 @vue/compat）的具体行为细节未深入，仅知是为 compat 用户做的兼容配置，不影响核心嵌套原理。源码位置: packages/router/src/RouterView.ts:63
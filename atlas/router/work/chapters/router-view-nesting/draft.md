# RouterView 嵌套渲染

> 本章属于 composite 层。前置：Router 核心与导航主循环、路由匹配表。
> 学完你能用一句话讲清：嵌套视图为什么能"零配置对齐路由层级"——以及这套设计押在了哪几个隐式契约上。

## 1. 为什么需要它

上一章把 `currentRoute` 用 `shallowRef` 在最外层替换驱动视图这件事讲完了——导航一旦落定，那根响应式 ref 就是"现在该走哪条 matched 链"。但它只告诉应用"该走哪条链"，没告诉应用"这条链上每一级路由记录分别该渲染到模板的哪个槽位"。本章就接这个口子讲：链有了，怎么把它落到屏幕上。

设想一个常见的后台界面：访问 `/users/42/profile`，希望 `UserLayout` 占住外层（侧边栏 + 顶栏），里面某个 `<main>` 区域再渲染 `UserProfile`。这种"路由嵌套、视图也嵌套"的需求几乎在每个非平凡应用里都会出现。

如果没有自动嵌套机制，使用者得自己干两件事：

- 把"当前 URL 解析出的每一级路由记录"逐一对应到模板里嵌套的若干出口组件上；
- 自己维护"第几层渲染谁"，路由配置一改层级，模板就得跟着改。

这是把"路由表的结构信息"硬抄一份到模板里，抄一份就得维护一份。我们真正想要的是：在任意子组件模板里写一个出口组件，它就自动对齐到正确的路由层——不用接线，路由层级变了模板也不动。

## 2. 核心思想

把"该渲染第几层路由"这件事，变成一个沿组件树向下传递的整数 `depth`；每个出口凭 `depth` 从 matched 链里取出对应那一级的组件。

`depth` 是这套设计的承重墙：它在组件树里隐式流动，把"路由表的层级结构"和"模板的嵌套结构"对齐起来。

## 3. 心智模型

整个机制只在干一件事：让 `depth` 在组件树里正确流动，并让每个出口用 `depth` 选出该渲染的组件。具体走 7 步：

1. **起点（外部接续点）**：根应用 install 时把 `currentRoute`（一个响应式 ref）provide 到全局——这是「Router 核心与导航主循环」的产物，本章只消费它的一个新侧面：把它当作 matched 链的来源。
2. **取 depth**：最外层出口 inject 它，并 inject 一个默认 `depth = 0`（无父级时）。
3. **算有效 depth**：从初始 `depth` 起，只要 `matched[depth]` 没有 `components` 字段（即这条记录只用于复用 path 前缀、自身不渲染），就让 `depth` 自增继续往后找，直到命中一条有组件的记录。这一步得到的是"有效 depth"。
4. **选组件**：取 `matched[有效depth].components[出口名]`（出口名默认 `'default'`），这就是要渲染的目标。
5. **向后代注入 depth+1**：把"有效 depth + 1"重新 provide 给后代——于是这个组件模板里若再写一个出口，它会自动取 matched 的下一项。零配置嵌套就靠这一行。
6. **交出 vnode**：渲染时把目标组件包成 vnode 交给作用域插槽；使用者没提供 slot 时，兜底直接渲染该 vnode。
7. **登记实例**：组件挂载后，把实例写回 `matched[有效depth].instances[出口名]` 供导航守卫查找；卸载时把这个位置空。

这套模型成立的前提只有一条：**matched 是从父到子的有序数组**（这是「路由匹配表」一章的产物，本章只是这条不变量的消费者）。

## 4. 关键权衡

「靠 inject 把 depth 往下传」是这套设计的灵魂，但它押上的几个隐式契约才是真正值得看清的地方。下面四条都是"选了什么 → 换来什么 → 付了什么代价"。

### 隐式 inject 换零配置嵌套

选择用 `provide/inject` 把 depth 往下传，而不是让使用者在每个出口上显式 `:depth="n"` 传 props。

换来的是**真正的零配置**：在任意子组件模板里写一个 `<RouterView>`，就自动接上正确层级；使用者完全不用知道当前在第几层，路由层级变了模板也不用动。这是嵌套视图"开箱即用"的来源。

代价是 depth 成了**看不见的隐式依赖**——你读模板时不知道这个出口对应 matched 的第几项，要查 inject 链才能定位。更承重的是 matched 数组的父子顺序：它从"路由表内部的一个排布细节"上升为"模板必须信赖的隐式契约"。一旦顺序被某种方式打乱（自定义 matcher、记录变形），出口会**静默渲染错组件**，不报错。库为此额外做的事是：在 devtools 下把 `{depth, name, path, meta}` 戳记到所渲染组件实例上——隐式依赖必须靠可观测性补回来。

化解的本质矛盾是：**"使用上零配置的便利"** 和 **"数据流显式可追溯"** 之间的取舍。前者赢，后者靠 devtools 找补。

### while 跳过 passthrough 记录换"只为前缀的中间层"透明工作

选择在算 depth 时用 while 循环跳过没有 `components` 的中间路由记录，而不是要求每条路由记录都必须挂一个组件。

换来的是**只为复用 path 前缀、自身不渲染东西**的中间路由能透明工作。比如 `/admin` 下挂 `/admin/users`、`/admin/settings`，使用者只为 `admin` 这条记录配 layout、不为"只是为了把 `admin/` 前缀聚拢"的抽象层配假组件——这一切照常工作。

代价是 **depth 不再是注入进来的那个原始值**，而是"有效下标"：matched 数组下标和 depth 之间多了一层"跳过几个 passthrough"的换算。子出口拿到的 provide 值是基于"有效 depth + 1"，而不是"注入 depth + 1"——这一点不读源码很难想到。换句话说，一个数值有了两层含义（"在数组里的位置" vs "在第几层出口"），调试时容易混淆。

化解的本质矛盾是：**"路径层级的完整性"**（matched 要忠实地反映 URL 的所有路由段）和 **"渲染层级的稀疏性"**（中间段未必都要画东西）之间的不对齐。库选择把"对齐"的责任放在出口里，而不是让使用者补假组件。

### scoped slot 交出 vnode 换组合权让渡

选择把目标组件作为 vnode 交给使用者的作用域插槽（`v-slot="{ Component }"`），而不是在 RouterView 内部直接内置 `<transition>` / `<keep-alive>`。

换来的是**组合权完全交到使用者手里**：要不要过渡、要不要缓存、要不要配 `<suspense>`，都由使用者在 slot 里自己决定；库不再绑定那些会随 Vue 版本变动的控制流组件——库的升级路径因此清爽很多。

代价是**旧的"直接用 `<transition>` 包住出口"的写法失效**。原因不是库刻意刁难：Vue 3 里函数式组件不再 eager 求值，包在外层的 `<transition>` 抓不到内层组件的真实生命周期，过渡根本不触发。库为此专门发了一条诊断码（`VUE_ROUTER_R0060`），检测到旧包裹写法就报警，提醒迁移到 slot 形式。这是个真实的迁移成本——本来"加个过渡"是一行模板的事，现在要重写成 `v-slot` 形式。

化解的本质矛盾是：**"组合能力的开放"**（让使用者自由组合控制流）和 **"API 的向后稳定性"**（内置控制流能让使用者的代码不跟着 Vue 变动）之间的取舍。库选了前者，承担了发诊断码 + 教育使用者的成本。

### 实例登记回记录换守卫按命名视图找得到

选择把已挂载的组件实例登记回 `matched[depth].instances[出口名]`，并在"实例复用但路由记录变了"时把守卫从旧记录迁移到新记录。

换来的是**导航守卫（update/leave）和"beforeRouteEnter 的 next 回调"能按命名视图找到当前实例**——而不管这个实例是新建的还是复用的。被复用的实例其 `leaveGuards` / `updateGuards` 不会因为路由记录从 A 换到 B 就丢掉，守卫的归属跟着实例走。

代价是要维护一组**多重副作用**：

- 登记时机必须是 `flush: 'post'` 的 watch——DOM 挂载后才能拿到组件实例 ref；
- 卸载时要手动把 `instances[name]` 置 null，否则记录上残留失效实例引用，下次守卫查到一个已经卸载的实例；
- 实例被复用但 matched 记录变了时，要把守卫从旧记录搬到新记录，否则守卫挂在已经不再渲染的记录上、永远不被触发。

这三条都是边界处理，不是核心算法，但少任何一条都会出现难定位的"守卫偶尔失效"。

化解的本质矛盾是：**组件实例的生命周期**（被 Vue 的渲染器管）和 **路由记录的生命周期**（被导航管线管）天然不一致——实例可以跨多次记录变更被复用，记录也可以在实例还活着的时候被替换。库选择让"守卫归属"跟着实例走、让"实例登记"落在记录上，于是要手动维护两者的一致性。

## 5. 最小原理演示

下面这段 TS 用 Vue 真实的 `h` / `provide` / `inject` / `defineComponent` 演透上面四条权衡的核心闭环。它故意不追求工程完整：不处理 attrs 转发、不做命名视图多分支、不实现守卫迁移的全部细节——只演"depth 流动 + 跳过 passthrough + slot 交出 vnode + 实例登记回记录"。

```ts
import {
  computed, h, inject, provide, defineComponent,
  type InjectionKey, type Ref, type Component,
} from 'vue'

type MatchedRecord = {
  components?: Record<string, Component>
  instances?: Record<string, Component | null>
}
type RouteRef = Ref<{ matched: MatchedRecord[] }>

// 类型化的 Symbol 当 DI 接缝——depth 是隐式依赖，至少让类型层能看见它
const routeKey: InjectionKey<RouteRef> = Symbol('currentRoute')
const depthKey: InjectionKey<Ref<number>> = Symbol('viewDepth')

export const MiniRouterView = defineComponent({
  name: 'RouterView',
  props: { name: { type: String, default: 'default' } },
  setup(props, { slots }) {
    const route = inject(routeKey)!
    const injectedDepth = inject(depthKey, () => 0)

    // 跳过没有 components 的 passthrough 记录：
    // depth 是"有效下标"，可能比注入进来的原始值大
    const depth = computed(() => {
      let d = injectedDepth.value
      const { matched } = route.value
      while (matched[d] && !matched[d].components) d++
      return d
    })

    const matchedRoute = computed(() => route.value.matched[depth.value])

    // 把"有效 depth + 1"注入后代：
    // 子模板里再写一个出口就自动取 matched 的下一项——零配置嵌套就靠这一行
    provide(depthKey, computed(() => depth.value + 1))

    return () => {
      const record = matchedRoute.value
      const component = record?.components?.[props.name]
      if (!component) return null

      const vnode = h(component, {
        // 卸载时把实例引用置 null，防记录残留失效实例
        onVnodeUnmounted: () => {
          if (record.instances) record.instances[props.name] = null
        },
      })

      // 把 vnode 交给 scoped slot，由使用者决定要不要包过渡/缓存；
      // 没提供 slot 就兜底直接渲染
      const slot = slots.default?.({ Component: vnode })
      return slot && slot.length ? slot : vnode
    }
  },
})

// 真实库还维护一个 flush:'post' 的 watch：实例挂载后写回 record.instances，
// 并在记录变更时把守卫从旧记录迁移到新记录——这里省略以保持演示聚焦。
```

## 6. 执行轨迹

把路由配成三层：

```
/admin/users/42 → matched = [
  { components: { default: AdminLayout } },     // 有组件
  { /* 无 components，passthrough */ },
  { components: { default: UserDetail } },      // 有组件
]
```

第一步：根模板里的出口拿到 `injectedDepth = 0`（没有父出口，inject 的默认值）。`matched[0]` 有 components → 不进 while 循环 → 有效 depth = 0 → 取 `matched[0].components.default` = `AdminLayout` → 渲染。同时 `provide(depthKey, 0 + 1 = 1)` 给后代。

第二步：`AdminLayout` 模板里又写了一个出口。这个出口 `inject(depthKey)` 拿到 1。`matched[1]` 没有 components → while 循环自增 → depth = 2 → `matched[2].components.default` = `UserDetail` → 渲染。同时 `provide(depthKey, 2 + 1 = 3)` 给后代（若有）。

结果：两层出口分别对齐到 `AdminLayout` 与 `UserDetail`，中间那条只为聚合 `/admin/` 前缀的 passthrough 记录被透明跳过——使用者既没给它配假组件，也没在模板里多写任何东西。整条链路靠 depth 在 inject 里的流动 + while 跳过两个动作就完成了。

## 7. 教学简化说明

本章演示故意省略：`routeProps`（true / 函数 / 对象三态派发，把 params 作为 props 注入子组件）、命名视图多 name 分支、devtools 把 `{depth, name, path, meta}` 戳记到实例、`flush:'post'` watch 的全部守卫迁移细节、`inheritAttrs: false` 下的手动 attrs 转发、`compatConfig` 兼容、`RouteMap` 泛型按名收窄。这些都是工程细节，演透原理用不到。

## 8. 小结

嵌套视图能零配置对齐路由层级，靠的是把"第几层"抽成一个隐式 inject 下去的整数 depth——出口们各凭下标在 matched 链里取自己那一级，跳过只为前缀的中间层。这条优雅换来了四个隐式契约：matched 顺序承重、depth 与数组下标不再一一对应、旧包裹写法失效、实例与记录生命周期要手动同步。下一章会继续沿着 matched 链走——不过这次不是"渲染谁"，而是"判定一个链接是否指向当前路由"。
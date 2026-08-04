# RouterView 嵌套渲染

## 一个后台，三层套娃

想象你在做一个后台管理系统。地址是 `/admin/users/42`，页面的"形状"长这样：最外面一层是 `AdminLayout`（带侧边栏和顶栏），它肚子里要装东西；而 `UserDetail` 这个详情页，又该渲染在 `AdminLayout` 内部某个"留好的坑"里。

URL 一变，坑里渲染的东西得自动跟着变；而且坑里还能再挖坑——列表页里点一行，详情页又渲染在更里面一层。这种"一层套一层、每层对应路由的一级"的需求，几乎每个非平凡应用都有。

如果没有自动机制，使用者就得自己干一件很烦的事：把当前 URL 拆出来的每一级路由记录，逐一对应到模板里嵌套的若干个出口，还得自己维护"第几个出口该渲染第几层"。路由层级一调整，整套模板跟着改。

我们需要的是：**在任意层级随手写一个出口，它就能自动对齐到正确的路由层**，使用者完全不用关心自己嵌在第几层。

## 把"我在第几层"变成一个往下传的整数

这块的核心想法，说人话就是：**给每一个出口编个楼层号**。

路由匹配完成后，会产出一条 `matched` 链——一个从外到内排好序的数组：`matched[0]` 是最外层那条路由记录，`matched[1]` 是它里面那层，依此类推。这条链是怎么从用户的父子路由配置编译出来的，是「路由匹配表」那一章的内容，这里只把它当成一个**已经排好序的数组**来用，不重演它的构造。

> 类比一下：`matched` 链就像一排从外到内套在一起的俄罗斯套娃，最外面那个是 0 号。每个出口只要知道"我是第几号娃娃"，就能从这排里精准拿到自己该渲染的那一个。

那"我是第几号"这个信息从哪来？答案是**靠依赖注入往下传**。最外层的出口默认是 0 号；它渲染完之后，会把"1 号"这个消息悄悄递给它肚子里的子组件树；子组件树里若再写一个出口，一伸手就能拿到"1 号"，于是自动渲染 `matched[1]`；这个出口再往下递"2 号"……

> 依赖注入你可以理解成"按地址精准投递"：出口不用通过 props 一层层显式地传楼层号，而是把号写在一张沿组件树向下传递的公共留言板上（`provide`），后代里的任何一个出口只要去读这块板（`inject`）就能拿到自己的号。

于是零配置嵌套就成立了：使用者在任意子组件里随手写一个出口，它就自动接上了正确的楼层，路由层级怎么变都不用改模板。这一章要回答的，就是这个"楼层号往下传 + 凭号取娃娃"的机制到底怎么实现，以及它为这个极简 API 付了哪些代价。

## 心智模型：七步看懂一次嵌套渲染

把整个机制拆成七步，从应用到最里层的出口：

1. **注入驱动源**：根应用安装时，把"当前路由"（一个响应式 ref）放到留言板上，所有出口共用这一个源。（这个源是怎么用一个 `shallowRef` 只在最外层替换来驱动视图的，是「Router 核心与导航主循环」的内容，这里只把它当成 matched 链的来源，不重演。）
2. **最外层出口报到**：它 inject 到当前路由，并 inject 到一个楼层号——没有父级时默认是 `0`。
3. **算有效楼层**：它用这个号去 `matched` 里取；但取到的记录可能是个"空壳"（只为复用路径前缀、自己不渲染组件），那就让号自增，继续往后找，直到命中一个真有组件的记录。
4. **取出要渲染的组件**：`matched[有效楼层]` 上对应出口名（默认 `default`）的那个组件，就是渲染目标。
5. **往下传下一层**：把"有效楼层 + 1"重新写到留言板上。于是这个组件模板里若再写一个出口，它一读就拿到下一层。
6. **交出渲染权**：把目标组件包成一个 vnode，交给使用者的作用域插槽；使用者没提供插槽就兜底直接渲染。
7. **登记实例**：组件挂载后，把它的实例写回 `matched[有效楼层]` 这条记录上，供导航守卫查找；卸载时把这个位置清空。

第 3、5 两步是嵌套能"自动对齐"的关键。下面用一个能跑的演示把第 1～5 步演透，第 6、7 步因为更贴近 Vue 的组件组合，用代码片段配文字轨迹说明。

## 原理演示：跑一遍 `/admin/users/42` 的嵌套轨迹

这份演示剥离掉 Vue 的响应式和真实 DOM，只用一个"provide 栈"模拟依赖注入沿组件树向下传的过程，把 **depth 传递 + matched 下标 + 跳过空壳** 这三件事演透。存成 `nesting-trace.ts`，用 `bun run nesting-trace.ts` 或 `npx tsx nesting-trace.ts` 就能跑：

```ts
// nesting-trace.ts
type RouteRecord = {
  path: string
  component?: string            // 缺失 = passthrough，只为复用路径前缀
}

// ---- 微型 provide/inject：每个出口 setup 时压一个栈帧 ----
const stack: Map<symbol, any>[] = [new Map()]
const provide = (k: symbol, v: any) => stack.at(-1)!.set(k, v)
const inject = <T>(k: symbol, fallback: T): T => {
  for (let i = stack.length - 1; i >= 0; i--)
    if (stack[i].has(k)) return stack[i].get(k) as T
  return fallback
}

const ROUTE = Symbol()          // matched 数组的来源（= 当前路由）
const DEPTH = Symbol()          // 当前出口的楼层号

// ---- 教学版出口 ----
function routerView(indent = '') {
  const matched: RouteRecord[] = inject(ROUTE, null).matched
  const injectedDepth = inject(DEPTH, 0)            // 从父级留言板读楼层号

  // 跳过没有 component 的 passthrough 记录，算出"有效楼层"
  let depth = injectedDepth
  while (matched[depth] && !matched[depth].component) depth++

  const record = matched[depth]
  console.log(
    `${indent}出口拿到 injectedDepth=${injectedDepth} → 有效 depth=${depth} → 渲染 ${record.component}`
  )

  // 把"下一层"写回留言板，供肚子里的子出口读取
  provide(DEPTH, depth + 1)

  // 模拟"在 record.component 模板里又写了一个出口"：压栈渲染子出口
  if (matched[depth + 1]) {
    stack.push(new Map())
    routerView(indent + '  ')
    stack.pop()
  }
}

// ---- 执行轨迹：访问 /admin/users/42 ----
const route = {
  matched: [
    { path: '/admin',           component: 'AdminLayout' },
    { path: '/admin/users',     component: undefined },   // passthrough
    { path: '/admin/users/:id', component: 'UserDetail' },
  ],
}

stack.push(new Map())
provide(ROUTE, route)
provide(DEPTH, 0)
routerView()
stack.pop()
```

跑出来的轨迹只有两行，但信息量很大：

```
出口拿到 injectedDepth=0 → 有效 depth=0 → 渲染 AdminLayout
  出口拿到 injectedDepth=1 → 有效 depth=2 → 渲染 UserDetail
```

逐行拆开看：

- **第一层出口**：`injectedDepth=0`（最外层没有父级，默认 0），`matched[0]` 是 `AdminLayout`，有组件，`while` 不进入，有效 `depth=0`，渲染 `AdminLayout`。然后它把 `depth+1=1` 写回留言板。
- **第二层出口**（写在 `AdminLayout` 模板里的那个）：从留言板读到 `injectedDepth=1`。注意——它读到的不是 `2`，而是 `1`，因为父级传的是"自己的有效 depth + 1"。它拿 `matched[1]` 一看，是 `AdminSection`，**没有 component**，于是 `while` 把 `depth` 自增到 `2`；`matched[2]` 是 `UserDetail`，有组件，停手，渲染它。

这正是设计上最妙的一点：中间那个只为复用 `/admin/users` 路径前缀、自己不画任何东西的 `AdminSection`，被两层出口**透明地跳过**了。使用者根本不需要为它配一个假组件，也不用知道它存在。两层出口稳稳对齐到 `AdminLayout` 和 `UserDetail`。

把这套数据流画成一张图，就是：

```
根 provide(ROUTE) ──┐
                    ▼
        最外层出口 inject(DEPTH=0)
                    │  while 跳空壳 → 有效 depth=0
                    │  matched[0] = AdminLayout  → 渲染
                    │  provide(DEPTH=1)
                    ▼
        内层出口 inject(DEPTH=1)
                    │  while 跳空壳 → 有效 depth=2
                    │  matched[2] = UserDetail   → 渲染
                    │  provide(DEPTH=3)
                    ▼
               （matched[3] 不存在，停止）
```

## 第 6、7 步：把组件交出去，把实例登记回来

前五步解决了"对齐到哪一层"。剩下两步发生在真正的 Vue 组件里。

**第 6 步——把组件作为 vnode 交给作用域插槽**，render 时是这样：

```ts
return () => {
  const component = h(ViewComponent, { ref: instanceRef })
  // 把 vnode 交给使用者的作用域插槽；没插槽就兜底直接渲染
  return slots.default?.({ Component: component }) ?? component
}
```

注意它**没有**在库内部把组件包进 `<Transition>` 或 `<KeepAlive>`，而是把做好的 vnode 原样递给使用者。于是组合权完全在使用者手里：

```vue
<!-- 想要过渡：自己包，库完全不插手 -->
<RouterView v-slot="{ Component }">
  <Transition mode="out-in">
    <component :is="Component" />
  </Transition>
</RouterView>

<!-- 不需要过渡：什么都不写，出口兜底直接渲染 -->
<RouterView />
```

**第 7 步——实例登记回路由记录**，靠一个 `flush: 'post'` 的 watch（DOM 挂载后才能拿到实例）：

```ts
const instanceRef = ref()
watch(
  [instanceRef, matchedRouteRef, () => props.name],
  ([inst, to, name], [oldInst, from]) => {
    if (!to) return
    to.instances[name] = inst                  // 挂载后登记，供守卫按命名视图查找
    // 实例被复用、但路由记录换了：把守卫从旧记录搬到新记录，防守卫丢失
    if (from && from !== to && inst && inst === oldInst) {
      to.leaveGuards  = from.leaveGuards
      to.updateGuards = from.updateGuards
    }
  },
  { flush: 'post' }
)
```

挂载时把实例写进 `to.instances[name]`；如果同一个实例被复用、但它对应的路由记录从 `from` 变成了 `to`，就把离开/更新守卫从旧记录搬到新记录上。卸载时则把 `instances[name]` 置 `null`，防止记录上残留失效引用。

## 关键权衡：极简 API 背后的四个代价

这套机制换来的是"任意层级写一个出口就自动接上"的极简体验。但每一个选择都有代价，下面四条是这一章真正想交付给你的"为什么"。

**① 用隐式的依赖注入向下传 depth，而不是显式的 props 链。** 选择依赖注入，换来的是零配置嵌套：使用者在任意子组件模板里写一个出口就自动接上正确层级，路由层级变了模板一行都不用改。代价有两层。其一，`matched` 数组的"父子顺序"成了一份**承重的隐式契约**——只要这张表从外到内的顺序错了，或者哪里多塞了一层，所有出口会静默地渲染错组件，而且不会报错。其二，depth 是个**看不见的隐式依赖**：一个出口到底在第几层，从它的模板和 props 里完全看不出来，调试时必须额外靠 devtools 把 `{depth, name, path, meta}` 戳到组件实例上，使用者才能看见"这个实例对应 matched 的第几层"。换句话说，这个 API 之所以能简到只有一个标签，是因为把复杂性藏进了注入链和数组顺序里。

**② 取 depth 时用 while 循环跳过"无组件"的路由记录。** 选择跳过，换来的是"只为复用 path 前缀、自身不渲染组件"的中间路由能**透明工作**——演示里的 `AdminSection` 就是这种，使用者无需为它配一个空壳组件，路由层级怎么组织都不影响出口对齐。代价是 depth 的语义变厚了一层：它不再等于"父级注入进来的那个原始值"，而是"从原始值开始、跳过若干空壳后的**有效下标**"。演示里第二层出口 `injectedDepth=1` 但有效 `depth=2` 就是这个差距。所以 `matched` 的数组下标和 depth 不再一一对应，理解这套机制时脑子里得多绕一个弯：传给后代的是"有效 depth + 1"，不是"原始值 + 1"。

**③ 把要渲染的组件作为 vnode 交给作用域插槽，而不是在库内部包过渡/缓存组件。** 选择交出去，换来的是使用者**完全掌控组合**——要不要过渡、要不要缓存、用哪个版本的控制流组件，全由使用者决定，库不绑定任何会随 Vue 版本变动的内置组件。代价是旧写法直接失效：以前那种用 `<transition>` 或 `<keep-alive>` 直接包住 `<router-view>` 的用法（Vue 2 时代的习惯）在 Vue 3 行不通了，因为函数式组件不再 eager 求值，外层包裹拿不到正确的组件实例。库不得不专门发一条诊断码来警告这个迁移，使用者必须改写成上面那种 `v-slot` 形式。这是同一个决策的两面：库主动放弃了对控制流组件的所有权，灵活性和迁移成本是绑在一起的。

**④ 把已挂载的组件实例登记回路由记录，并在实例复用、记录变更时迁移守卫。** 选择挂在"路由记录"上而不是"出口组件实例"上，换来的是导航守卫（更新/离开）和"进入守卫的 next 回调"能**按命名视图找到当前实例**，而且被复用的实例其守卫在跨路由变更时不会丢失——多个 app 共用同一张匹配表时，守卫还能按记录聚合。代价是一串边界处理：得维护一个 `flush: 'post'` 的 watch 确保 DOM 挂载后才登记实例；卸载时要手动把实例置 `null` 防止泄漏；最棘手的是"实例复用但路由记录换了"这种情形，得把 `leaveGuards`/`updateGuards` 从旧记录搬到新记录，否则守卫就跟着旧记录一起失踪了。可见，把可观测性和守卫存活绑在路由记录上，是拿一个简洁的查找模型换来的。

## 小结

这一章只讲了一件事：**把"该渲染第几层路由"变成一个沿组件树向下传递的整数 depth**。最外层出口默认是 0，每个出口凭 depth 从 matched 链里取出对应那一级，再把"有效 depth + 1"递给后代——于是任意深的嵌套视图无需任何接线就能自动对齐，中间那些只为复用路径前缀的空壳路由也被透明跳过。围绕这条主线，库用依赖注入换来了零配置 API，用作用域插槽换来了组合自由，用实例登记换来了守卫的可靠存活，每一项都附带了顺序敏感、隐式依赖、迁移成本这些具体代价。

下一章我们会看 `<RouterLink>`：它把一个路由位置 resolve 成 href，并基于"matched 链包含 + params 子集"来判定链接的激活态——你会发现，那里对 matched 链的用法，和这里的"按 depth 下标"是同一条链的另一种消费方式。
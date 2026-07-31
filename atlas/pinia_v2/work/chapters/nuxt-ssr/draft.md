# Nuxt SSR：payload 序列化与自动导入

## 一、问题：状态如何跨过一次网络请求

服务端渲染（SSR）场景下，一次用户请求的剧情大致是：

```
A 进程拿到请求 → 在内存里渲染组件树 → 组件树里的 store 被读写 → 产出 HTML
   → 进程把 HTML 扔给浏览器 → 这次请求动过的内存（含 store 状态）随请求结束而丢弃
```

麻烦在浏览器那一侧：它拿到 HTML 重新挂载应用时，内存里一片空白。如果不去「对齐」服务端渲染时用过的状态，首屏就会闪烁——服务端按 `count = 5` 画的界面，客户端重新挂载后 `count` 又从 0 开始，用户先看到 5 再看到 0。

更麻烦的是：这个「对齐」若让框架自己造轮子，就得给每个 store 写一对「序列化 / 反序列化」胶水。store 一多，既啰嗦又容易漏。

本章讲 Pinia + Nuxt 如何把这个难题「几乎免费」解决——它没有发明新的序列化层，而是榨干了既有数据结构的一个副产物。

## 二、地基：扁平字典本来就可序列化

要理解这套方案的优雅，得先回到 [[pinia-instance]] 章的一个结论：

Pinia 实例的状态根，是一个被 `effectScope(true)` 包起来的扁平字典——

```ts
// pinia.state.value 的形状
{
  counter: { count: 5, name: 'abc' },
  cart:    { items: [...] },
}
```

每个 store 的状态，都被迁进了这个字典里以 store id 为键的一格（见 [[store-assembly]] 章「把 ref 迁入 pinia.state.value」）。这个结构本来是为「统一寻址」和 `$patch` 的深度合并服务的（见 [[state-patch]]），但它顺带有一个极其有用的性质：

**它就是一个普通的、可序列化的 JavaScript 对象。**

没有循环引用、没有响应式代理外露、没有函数。于是「状态如何跨网络传递」这个问题，几乎不需要专门的序列化层——直接把这坨字典原样搬进 Nuxt 的请求载荷（payload）即可。这就是整章的地基，下面所有机制都在「榨干这个副产物」。

## 三、服务端：渲染完，把字典塞进载荷，再抹掉指针

Nuxt 侧的运行时插件，在 `setup` 里做三件事：建状态根、装进 Vue 应用、设为全局活跃实例（呼应 [[active-pinia]] 章的 `setActivePinia`）。真正巧妙的是渲染完成后的那个钩子：

```ts
hooks: {
  'app:rendered'() {
    const nuxtApp = useNuxtApp()
    nuxtApp.payload.pinia = toRaw(nuxtApp.$pinia as Pinia).state.value
    // clear up the reference to pinia on server to avoid holding onto the variable
    setActivePinia(undefined)
  },
},
```

两件事，一件「搬」，一件「抹」：

- **搬**：用 `toRaw` 取出状态根背后那个原始（去代理）的字典，原样塞进 `nuxtApp.payload.pinia`。`toRaw` 很关键——状态字典本身是响应式代理，直接序列化会把代理一并搬过去；`toRaw` 保证搬过去的是那坨干净的普通对象。
- **抹**：紧接着 `setActivePinia(undefined)`，把全局活跃指针清空。

为什么要「抹」？因为服务端是个长生命周期进程，会接连处理成百上千个请求。若全局活跃指针在请求结束后还指着上一次请求的 pinia，下一次请求里、组件注入上下文之外去取 store 的代码，就可能误拿到「上一次请求残留的实例」，造成跨请求串污染。这正是 [[active-pinia]] 章那个「服务端多请求须显式防串污染」权衡在此处的落地——渲染一结束就主动抹掉指针。

于是服务端用两行赋值完成了「序列化」：没有遍历、没有逐 store 处理。

```
组件树渲染（状态写入扁平字典）
        │
        ▼
  app:rendered 钩子
        │
        ├─ payload.pinia = toRaw(state.value)   ← 整坨搬过去
        └─ setActivePinia(undefined)            ← 抹掉指针防串污染
```

## 四、序列化层：把「不该过网」的值折叠掉

整体搬字典很省事，但有一个新问题：字典里有些值**根本不该**跨网络传到浏览器。

典型例子是路由实例。一个 setup store 可能这样写——

```ts
return { count, router: skipHydrate(useRouter()) }
```

这里的 `router` 是客户端运行时的产物，服务端那份对浏览器毫无意义，传过去既占带宽，还会在浏览器恢复时把客户端自己刚建好的路由对象冲掉。

`skipHydrate()` 就是用来标记「这个值不参与注水」的。它的实现极简——在被标记对象上定义一个不可枚举的 Symbol 属性：

```ts
const skipHydrateSymbol = Symbol('pinia:skipHydration')

export function skipHydrate<T = any>(obj: T): T {
  return Object.defineProperty(obj, skipHydrateSymbol, {})
}

export function shouldHydrate(obj: any) {
  return (
    !obj || typeof obj !== 'object' || !Object.hasOwn(obj, skipHydrateSymbol)
  )
}
```

`shouldHydrate` 的判定是：空值或非对象 → 视为应当注水（按普通值处理）；否则检查对象身上有没有那个隐藏的 Symbol 标记——有标记，就是「不注水」。

但「标记」本身不会自动让值从载荷里消失。真正在传输时剔除它的，是 Nuxt 载荷层注册的一对 reducer/reviver：

```ts
definePayloadReducer(
  'skipHydrate',
  // We need to return something truthy to be treated as a match
  (data: unknown) => !shouldHydrate(data) && 1
)
definePayloadReviver('skipHydrate', (_data: 1) => undefined)
```

Nuxt 序列化 payload 时，会对每个值挨个问已注册的 reducer：「这个值你认不认？」reducer 返回 truthy 就算「认领」，该值会被折叠成一种带类型标记的占位形态；到了浏览器，对应的 reviver 再把它还原。

于是被 `skipHydrate` 标记的路由实例，传输时被折叠成一个极小的占位符，到浏览器又被 reviver 还原成 `undefined`——既不占带宽，也不污染客户端状态。

> 小注：reducer 里那个 `&& 1` 看起来怪异——它只是「返回一个 truthy 值表示命中」的短路写法，`1` 本身没有语义，纯粹是个占位的 truthy 值；reviver 形参写作 `_data: 1`（下划线前缀表「未使用」）正是和它对应。

## 五、客户端：整体倒回，装配时逐项把关

浏览器一侧的 `setup` 和服务端几乎一样——同样建状态根、装进应用、设为活跃实例。多出来的只有一步：若 payload 里带了状态，就**整体赋回**状态根：

```ts
const pinia = createPinia()
nuxtApp.vueApp.use(pinia)
setActivePinia(pinia)

if (nuxtApp.payload && nuxtApp.payload.pinia) {
  pinia.state.value = nuxtApp.payload.pinia as any
}
```

注意这是「整体替换 `state.value`」，不是逐个 store 合并。一句赋值，整坨字典倒回来——这正是「扁平字典天然可序列化」红利的兑现。被折叠的路由项，此刻已被 reviver 还原成 `undefined`。

但「整体替换」会引出一个新担忧：客户端在「倒回字典」之后，还会去**装配**各个 store（首次 `useStore()` 时）。装配会重新跑用户的 setup、新建一堆 ref。若装配时无脑用字典里的值覆盖，会不会把客户端刚建好的对象（比如那个本该跳过注水的路由）冲掉？

不会。因为装配机器在迁移每个 state 项时，会先过一道闸：

```ts
if (initialState && shouldHydrate(prop)) {
  if (isRef(prop)) {
    prop.value = initialState[key]
  } else {
    if (prop instanceof Set || prop instanceof Map) {
      prop.clear()
    }
    mergeReactiveObjects(prop, initialState[key])
  }
}
```

只有当 `shouldHydrate(prop)` 为真（这个项**该**参与注水）时，才用载荷值覆盖：ref 就写它的 `.value`，Map/Set 先 `clear()` 再深度合并（复用 [[state-patch]] 章的 `mergeReactiveObjects`，避免把客户端默认值与服务端值错误拼接）。而那些带「不注水」标记的项——`shouldHydrate` 返回 false——直接跳过覆盖，保留客户端自己刚建的对象。

这就是「整体替换字典」之所以安全的最后一道保险：**搬是整体的，但落地到每个 store 内部时，是逐项判断的。**

## 六、一次完整往返：最小演示

把上面三节捏成一个最小闭环。服务端持有一个扁平字典，其中 `counter` 是普通状态、`route` 是被标记不注水的对象：

```ts
// ===== 底层原语：标记与判定 =====
const SKIP = Symbol('skip')
const skipHydrate = (o) => (Object.defineProperty(o, SKIP, {}), o)
const shouldHydrate = (o) => !o || typeof o !== 'object' || !Object.hasOwn(o, SKIP)

// ===== 服务端 =====
function server() {
  const state = { counter: { count: 5 }, route: skipHydrate({ path: '/x' }) }
  // 渲染后：把字典整体塞进载荷；标记项（!shouldHydrate）经 reducer 折叠后不参与传输
  const payload = Object.fromEntries(
    Object.entries(state).filter(([, v]) => shouldHydrate(v))
  )
  setActivePinia(undefined) // 抹掉指针，防下一请求串污染
  return payload // → { counter: { count: 5 } }，route 已折叠消失
}

// ===== 客户端 =====
function client(payload) {
  const piniaState = payload // 整体倒回（一句赋值）

  const counter = { count: 0 } // 客户端自建
  if (shouldHydrate(counter)) counter.count = piniaState.counter.count // 该注水→覆盖

  const route = skipHydrate({ path: '/' }) // 客户端自建
  if (shouldHydrate(route)) { /* 不进：带标记→跳过覆盖 */ }

  console.log(counter) // { count: 5 }  ← 服务端值恢复
  console.log(route)   // { path: '/' } ← 客户端自建保留
}
```

这一段同时演了三个权衡：整体替换的便利（`piniaState = payload` 一行）、序列化层折叠的精妙（标记项过网即消失）、清指针的防污染（服务端抹掉活跃指针）。把它当作一张「往返票据」：服务端贴好标记寄出、传输途中等价物被折叠、客户端整体签收、装配时逐件核对。

## 七、构建期接线与开发期自动注入热更新

前面六节都是运行时的事，但那些运行时插件并非凭空出现——它们是 `@pinia/nuxt` 这个 Nuxt 模块在**构建期**接线挂上去的。模块的 `setup` 大致做四件事：

```
模块 setup
   ├─ transpile runtime 目录
   ├─ 把 pinia 加入 vite.optimizeDeps.exclude  ← 防预打包出多份实例
   ├─ modules:done 钩子里注册两个运行时插件      ← 第三、四节的 plugin + payload-plugin
   ├─ 注册自动导入（defineStore / usePinia / storeToRefs …）+ 扫描 stores 目录
   └─ 仅 dev 模式：挂一个 Vite 源码改写插件      ← 下面这条线
```

最后那条线与 SSR 无关，但同属这个模块，值得单独看：**开发时改 store 文件的热更新，被做到了零样板。**

通常用 Vite 做 HMR，每个 store 文件末尾都得手写一段接收代码：

```ts
if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useStore, import.meta.hot))
}
```

`@pinia/nuxt` 的做法是在**编译期**用一个 Vite 插件，扫每个含 `defineStore` 的源文件，自动把这段代码补上去。工作流程是：

```
transform 拿到一个文件
   ├─ 是虚拟模块（\x00 前缀）？ → 跳过，别动构建产物
   ├─ 不在项目根目录？         → 跳过，别动依赖
   ├─ 不含 defineStore？       → 跳过
   ├─ 已含 acceptHMRUpdate？   → 跳过，用户自己写过了
   ▼
解析 AST，在顶层声明里找「变量 = defineStore(...)」
   └─ 取出变量名，在文件首尾注入 import 和热更新接收代码
```

判定「这是不是一个 store 声明」靠的是一个很具体的 AST 形态匹配——它只认 `callee` 是名为 `defineStore` 的**标识符**的直接调用：

```ts
return nodes?.find(
  (x) =>
    x.init?.type === 'CallExpression' &&
    x.init.callee.type === 'Identifier' &&
    x.init.callee.name === 'defineStore'
)
```

注入结果把原代码夹在中间：

```ts
import { acceptHMRUpdate } from 'pinia'   // ← 插件加在最前
/* …用户原本的 store 文件… */
if (import.meta.hot) {                     // ← 插件加在最尾
  import.meta.hot.accept(acceptHMRUpdate(useCounter, import.meta.hot))
}
```

import 放最前、接收代码放最后（声明之后），是为了保证接收代码能引用到已经声明好的 store 变量。这条线只在 `dev` 模式启用，生产构建完全不参与。

## 八、关键权衡

把这章四条核心权衡摆在一起，看它们各自用什么代价换什么便利：

1. **整体替换字典而非逐 store 合并**。换来「序列化、传输、恢复各只需一句赋值」的极致简单；代价是客户端装配时必须逐项判断「这个值是否参与注水」，否则会把客户端刚建好的对象冲掉——这道闸就是装配机器里的 `if (initialState && shouldHydrate(prop))`（`packages/pinia/src/store.ts:516`）。

2. **渲染完成后立即清空全局活跃指针**。换来服务端长生命周期进程下「多请求不会因残留指针互相串污染状态」（呼应 [[active-pinia]]，对应 `packages/nuxt/src/runtime/plugin.ts:29` 的 `setActivePinia(undefined)`）；代价是渲染钩子之后、组件注入上下文之外再取 store，必须重新指明活跃实例，否则拿到的是空。

3. **在载荷序列化层用 reducer 折叠掉标记为「不注水」的值**。换来不该过网的值（路由实例等）既不占带宽也不污染浏览器（折叠逻辑在 `packages/nuxt/src/runtime/payload-plugin.ts:17` 的 `!shouldHydrate(data) && 1`）；代价是判定靠一个隐藏 Symbol 标记，对 Map/Set 等非普通对象曾因属性判定方式出过边界 bug（历史上从 `hasOwnProperty` 改为 `Object.hasOwn`）。

4. **编译期扫源码自动注入热更新接收代码**。换来「写 store 文件零样板、改完即热替换」；代价是它只认「变量名 = defineStore()」这种直接声明的固定形态——别名导入（`import { defineStore as ds }`）或属性访问（`pinia.defineStore`）都识别不到，自动注入会悄悄失效。

四条权衡的共同基调是：Pinia 宁可复用一个已存在的数据结构（扁平字典）和一套已存在的机制（Nuxt payload 的 reducer/reviver、Vite 的 transform），也不为 SSR 专门造一套传输层。这套设计的「廉价感」恰恰来自前几章打好的地基。
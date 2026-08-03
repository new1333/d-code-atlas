# Pinia 实例：用 effectScope 持有全局状态

## 一、问题：一堆响应式，归谁管？

写 Vue 写多了，你大概有过这样的瞬间：在一个 `setup()` 里随手 `ref()`、`computed()`、`watch()`——它们什么时候被销毁？答案是"组件卸载时，Vue 帮你一起 stop 掉"。这套规则很省心，但**只在组件里成立**。

现在你要写一个全局 store。它不属于任何组件，要活到整个应用结束，还要被 router guard、axios 拦截器、`App.vue` 之外的某个普通 `.js` 文件用——这个时候谁来当它的"业主"？

更头疼的是 SSR 来了。每个 HTTP 请求都得是干净的、独立的，你不能让 A 用户的状态漏到 B 用户那里。所以"全部 store 的响应式效果"必须能**一次性打包销毁**——一个 `stop()` 走天下，而不是挨个 unwatch。

这就是 Pinia 的 effectScope 要解决的"地基"问题：先给所有 store 找一个能整体 stop 的家。

## 二、底座：effectScope(true) 当所有 store 的业主

`createPinia` 的第一行就埋下了这个家：

```ts
const scope = effectScope(true)
const state = scope.run(() => ref({}))
```

两个细节值得停下来：

- `effectScope(true)` 里的 `true` 是 "detached" 的意思——它**不挂在**任何父作用域上（尤其不是当前组件）。说人话就是：这个 scope 不归任何组件管，它自己就是 root。
- `scope.run(() => ref({}))` 把 `ref` 的"我属于哪个作用域"的登记，记到了这个 scope 头上。Vue 的响应式有个记账机制：effect 创建时会自动归到"当前 active scope"。所以 state 这个 effect 归 `_e` 管。

后续每个 store 在自己的子 scope 里跑 setup，而那个子 scope 又是在 `pinia._e.run(...)` 之内创建的——子 scope 自动成为 `_e` 的孩子。父 scope 一旦 stop，所有子 scope 跟着完蛋。这就是后面 `disposePinia` 一刀切的根基。

类比一下：`_e` 是一张大写字台的桌面，每个 store 是桌上的一只小盒子；桌面被掀翻，所有盒子里的东西一起掉下去——你不用一只只翻盒子。

## 三、装配：把一切收拢成一个 markRaw 实例

接下来 Pinia 把这些东西塞进一个对象，就是后来 `app.use(pinia)` 接到的那个东西：

```ts
const pinia: Pinia = markRaw({
  install(app) { ... },
  use(plugin) { ... },
  _p: [],          // 插件数组
  _a: null,        // 关联的 app，install 之后才填
  _e: scope,       // 那张大桌面
  _s: new Map(),   // store 注册表（下一章重点）
  state,           // 上面的 ref({})
})
```

这里 `markRaw` 是一个有意为之的细节：把整个 pinia 实例从 Vue 的响应式系统里**剔除**。否则如果哪天有人把它装到某个 `reactive` 里、或者 devtools 把它包一层，就会触发不必要的代理、循环引用、性能开销。pinia 自己内部已经有自己的响应式（`_e` + `state`），不需要外层替它再操心。

## 四、install 的四件事：把自己挂到 app 上

`app.use(pinia)` 触发 `install`，它依次干四件事：

```ts
install(app) {
  setActivePinia(pinia)                          // ① 全局 activePinia 指向自己
  pinia._a = app                                 // ② 反向记住 app
  app.provide(piniaSymbol, pinia)                // ③ 注入到 app 的 provide 树
  app.config.globalProperties.$pinia = pinia     // ④ Options API 也认得
  // 之后才 flush toBeInstalled 队列到 _p
}
```

第①②步给"组件外 useStore"打基础；第③步给"组件内 useStore"打基础；第④步是给 Vue 2 风格 `this.$pinia` 的兼容垫片。

## 五、双轨查找：组件内 vs 组件外

store 被用到的时候，要从某处拿到当前的 pinia 实例。这里有个分叉：

- **组件内**（在 `setup` 调用栈里）：可以 `inject(piniaSymbol)` 拿到当前 app 的 pinia——这是 Vue 的标准依赖注入，**精准投递**到那个 app。
- **组件外**（router guard、axios 拦截器、顶层模块）：拿不到 inject，得有个**全局兜底**——这就是 `activePinia` 这个模块级 `let` 变量的作用。

把它想象成一块谁都能看到的公共留言板：组件外的代码自己没地址（拿不到 inject），但都能看到这块留言板，去上面读"当前活跃的 pinia"。

`getActivePinia` 把两条路并起来：优先 inject、落空 fallback 到全局 `activePinia`。

## 六、最小演示：从零搭一个 store 容器

为了把核心思想演透，下面是一段剥离了所有 Pinia 噪音的演示脚本。机制只留三个：detached scope、模块级单例、stop 一刀切。

```js
import { effectScope, ref, computed } from 'vue'

// 模块级单例：组件外的"公共留言板"
let activeStore
const setActiveStore = (s) => (activeStore = s)

function createStore(setup) {
  const scope = effectScope(true)         // ① detached，不归任何组件
  const api = scope.run(() => setup())    // ② ref/computed 全部记到 scope 头上
  api._scope = scope
  setActiveStore(api)                     // ③ 让组件外也能拿到
  return api
}

const counter = createStore(() => {
  const count = ref(0)
  const double = computed(() => count.value * 2)
  return { count, double, inc() { count.value++ } }
})

counter.inc()
console.log(counter.double.value)   // 2

counter._scope.stop()               // 一刀切：count、double 的 effect 全部释放
```

直接 `bun run demo.js` 或 `node demo.js` 就能跑通、打出 `2`。把 `stop()` 那行注释掉再放开，可以观察 effect 释放前后的差异。

注意这个演示故意没做"双轨查找"——只用了全局单例已经能讲清核心。真实 Pinia 多出来的 inject 通道，是为了让**多 pinia 实例**（测试、SSR、微前端、Storybook）能精准隔离。这条通道的具体权衡，下面展开。

## 七、关键权衡

### 权衡 1：detached scope 换"store 不归组件管、能整体释放"

**做了什么**：用 `effectScope(true)` 当根业主，store 自己的 scope 在 `_e.run` 内诞生、成为 `_e` 的孩子。

**换来**：store 不被任何组件拥有、组件销毁后 store 仍然存活（这正是"全局"该有的样子）；`disposePinia` 时一次 `_e.stop()` 把所有 store 的 ref/computed/watch 全部释放——SSR 每请求一清、测试结束一清。

**代价**：Pinia 必须自己管生命周期，使用者忘了 `disposePinia` 就会泄漏。这在"单测试用例创建一个 pinia 但不 dispose"的场景里非常常见——测试跑了 50 个 case，控制台没报错，内存里却堆了 50 份 pinia 的 effect。换句话说，Vue 组件那套"组件销毁自动回收"的省心在 store 这边没了：要么靠 `app.runWithContext` / 自动卸载包装、要么手动 dispose。

### 权衡 2：模块级单例 activePinia 换"组件外 useStore 写起来极简"

**做了什么**：用一个模块级 `let activePinia`，每次 `setActivePinia` 改值；组件外代码 `useStore()` 时通过 `getActivePinia()` 读它。

**换来**：SSR 的 `fetch` 钩子、router guard、axios 拦截器、`.ts` 顶层模块都能写 `useUserStore()` 直接拿实例，不用层层传参。这是 Pinia 区别于 Vuex 的体验提升之一——Vuex 在组件外也得手动 `import store`，Pinia 让你"像读全局变量一样"用 store。

**代价**：服务端多请求**并发共享**同一个 Node 模块。如果不在每个请求开始 `setActivePinia(本请求的 pinia)`、结束 `setActivePinia(undefined)`，A 用户的状态就会漏到 B 用户那里——这是经典的 SSR 全局单例陷阱。Pinia 的 Nuxt 模块、官方 SSR 文档都在反复强调这条铁律。

### 权衡 3：inject 与 activePinia 双轨换"组件内精准 + 组件外兜底"

**做了什么**：`getActivePinia` 优先 `inject(piniaSymbol)`（精准投递到当前 app），落空才 fallback 到全局 `activePinia`。

**换来**：组件内能拿到本 app 的 pinia（多 pinia 应用、嵌套 app 也能正确隔离）；组件外仍有全局兜底，不需要传参。

**代价**：fallback 路径无声无息，且这里有个**容易踩的坑**——很多人以为 dev 模式会兜底报错提醒，**其实不会**。`PINIA_R1004` 的门控是 `if (!pinia && !IS_CLIENT)`，**仅 SSR/服务端路径在 dev 下会主动报 PINIA_R1004**；客户端（包括多 pinia 应用、Storybook、微前端这类本节正在讨论的场景）即便在 dev 模式下 inject 落空，也**没有 R1004 兜底**，会**静默 fallback 到全局 activePinia**，可能拿到错的实例。生产构建下连诊断都没了，纯逻辑 `||`。所以多 pinia 应用在客户端出问题时，devtools 通常只是显示数据对不上、而不会有任何告警——你必须主动检查每个 `useStore` 调用栈里 inject 是否真的命中了。

### 权衡 4：markRaw(pinia 实例) 换"不被外层响应式二次代理"

**做了什么**：整个 pinia 对象 `markRaw(...)`。

**换来**：pinia 实例不会被任何外层 `reactive` 重新代理，避免循环依赖和不必要的 effect 记账。pinia 自己内部已经有 `_e` + `state.value` 这套响应式，不需要外层插手。

**代价**：devtools 等工具想观察 pinia 自身时，得走 `_a`、`state.value`、`_s` 这些**内部字段**去读，而不能把整个 pinia 当 reactive 对象直接看。这是"框架自身性能优先于工具直接观察"的取舍——好在 devtools 知道这些字段，体验上无感知。

### 权衡 5：toBeInstalled 队列换"插件可任意时序注册"

**做了什么**：`pinia.use(plugin)` 在 `app.use(pinia)` 之前调，进 `toBeInstalled` 队列；install 时统一 flush 到 `_p`。install 之后调 `use` 则直接 push `_p`。

**换来**：插件可以在 `createPinia()` 之后、`app.use()` 之前的任意时刻注册——这恰好是大多数初始化代码的窗口（创建 pinia → 注册持久化插件 → 挂到 app）。

**代价**：多一份队列状态，且 install 那一刻必须立刻 flush，否则迟到注册的插件（如 devtools）就漏挂到了已经创建的 store 上。这个分支虽小，但决定了"先 createPinia 再 use 插件再 app.use"这条标准初始化顺序的可行性。

## 八、回头看心智模型

把上面的机制拼起来，Pinia 实例的本质就是一条链：

```
createPinia()
  → effectScope(true) 当根业主（_e）
    → scope.run(() => ref({})) 把 state 记账到 _e
  → markRaw({_e, state, _s, _p, _a, install, use}) 装成实例

app.use(pinia)
  → install(app)
    → setActivePinia(pinia)             给组件外留路
    → app.provide(piniaSymbol, pinia)   给组件内留路
    → flush toBeInstalled → _p

useStore()
  → getActivePinia() → inject 或 activePinia
  → pinia._e.run(() => effectScope().run(setup))   子 scope 自动归 _e

disposePinia(pinia)
  → _e.stop()        级联停掉所有 store 子 scope
  → _s.clear() / _p.splice(0) / state.value = {} / _a = null
```

一句话：**用一块可整体停掉的"大桌面"装所有 store 的响应式，用一块公共留言板让组件外代码也能找到桌面**。后面所有的章节（store 注册表、插件系统、SSR hydration）都是建立在这套地基之上的延伸。
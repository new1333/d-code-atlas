# Pinia 实例：根状态、注册表与全局活跃上下文

> 本章属于 primitive 层。前置：（首章无）。学完你能用一句话讲清：Pinia 为什么用「单例容器 + 全局活跃指针 + 脱离组件树的作用域」这三步，把整个状态库的运行地基搭起来。

## 1. 为什么需要它：状态库要零参数、又要可销毁

全书为什么从这一章开始？因为后续章节里几乎每个机制都站在同一个东西上面：一个由 `createPinia` 造出来的单例容器。store 怎么注册、订阅怎么清理、插件怎么注入、SSR 怎么序列化，全都得先有这个容器。它是什么、怎么被「找到」、生命周期怎么过，是后续所有花活的隐含前提。先把它本身讲透，后续章节才能放心复用它。

想象你在写一个 Vue 应用，你大概会希望状态用起来很省事：

- 任意一个组件的 setup 里写一行 `useUserStore()`，就能拿到 store——不想把状态库当参数一层层传；
- 在路由守卫、axios 拦截器、工具函数这些组件外面的地方，也能拿到 store；
- user store 在自己的 action 里调用 `useCartStore()` 时，不会陷入循环依赖；
- 测试结束或应用卸载时，能用一行代码把所有响应式开销（state、getter、订阅）一次性清掉。

这四件事如果靠用户自己实现，每一条都得显式接线：自己写单例、自己维护引用、自己处理组件外的取用、自己一个一个注销 effect。`createPinia` 这套「单例实例 + 全局活跃指针 + 脱离作用域」的机制，就是把这四件事打包进一个工厂函数。

它要调和的不是「怎么存数据」（一个 `reactive` 对象就够了），而是两个看似打架的需求：**人体工学上的零参数调用**，和 **生命周期的可控 + 状态的可序列化根**。

## 2. 核心思想

把「找谁要状态」从一处显式参数，变成一份隐式上下文。

状态库这个对象只造一次、只挂一次。之后任何地方想找它，要么从所在组件树的依赖注入里拿，要么回退到一根全局指针。两条解析路径殊途同归，调用者从不需要写 `useStore(pinia)`，参数被默认了。

## 3. 心智模型：一个 Pinia 实例长什么样

一个 `createPinia()` 造出来的实例，本质是这样一团东西（字段名按源码内部约定）：

| 字段 | 角色 |
|------|------|
| `state` | 根状态盒子，一个 `ref({})`；所有 store 的 state 都会镜像进这里 |
| `_s` | store 注册表，一张 `Map`，key 是 store id，value 是 store 实例 |
| `_e` | 一根脱离组件树的 `effectScope`，托管本库全部响应式 effect |
| `_p` | 已装插件数组 |
| `_a` | 关联的 Vue 应用 |
| `use` | 登记插件的方法 |
| `install` | Vue 插件安装函数（`app.use(pinia)` 时被调用） |

它身上发生六件事，构成实例的整个生命周期：

1. **创建**：开一个 detached（脱离父作用域）的 `effectScope`，在里面放一个空的 `ref({})` 当根状态盒子；同时开一张空的 `Map` 当注册表。这时光杆一个实例就造好了，跟任何 Vue 应用都没绑。
2. **挂载**：`app.use(pinia)` 触发 `install`——把实例本身设为「当前活跃」、记录关联应用、通过依赖注入把它 `provide` 进应用、挂到全局属性 `$pinia` 上供 Options API 取用。
3. **取用**：任何地方想拿这个实例，优先从依赖注入里找；找不到才回退到那根全局活跃指针。
4. **注册**：第一次用到某 store 时，才真正创建它并塞进 `_s`；之后每次都从注册表取同一个实例。
5. **归属**：每个 store 装配时，会把自己的 state 镜像进那个根状态盒子，形成一棵统一的、可整体序列化的状态树。
6. **销毁**：调一次 `disposePinia`，停掉那根 detached 作用域，所有 store 的全部响应式（state/getter/订阅）一次性清空，注册表、插件列表、根状态、应用引用一并复位。

第 1、2、3、6 步是本章要讲透的；第 4、5 步涉及 store 注册时机和状态镜像，是后续「defineStore 闭包」「store 装配」两章的重头戏，本章只点到为止。

## 4. 关键权衡

### 根状态住进脱离组件树的作用域

把根状态盒子（以及后续每个 store 的 effect）都放进一个 `effectScope(true)` 里——传 `true` 表示这个作用域「脱离」父作用域，不挂到任何组件身上。

**换来**：调一次 `scope.stop()` 就能一次性销毁所有 store 的全部响应式——state、getter、订阅全在一起，没有漏网的 effect。这一条直接决定了「测试结束、多实例应用卸载」能不能干净收尾。

**代价**：这个作用域的生命周期独立于组件树，组件卸载时它不会自动跟着回收。测试或多实例场景必须显式调 `disposePinia` 才能释放，否则就泄漏。

**本质矛盾**：响应式资源要能随某个生命周期「集体回收」，但它又不能被组件树的卸载误伤——一个 store 通常应该比某个组件活得久。detached 作用域就是 Vue 给的、用来把「响应式的集体性」与「组件树的局部性」切开的那把刀。一旦看懂这是「集体回收 vs 局部生命周期」的对立，在 React 的 `useEffect` cleanup、任何框架的资源管理里都能认出同一道题。

### 引入一根全局可变的活跃指针

在模块顶层用 `let activePinia` 维护一根可变指针，`install` 时把它指向当前实例；任何地方拿不到注入时，就回退到这根指针。

**换来**：调用 `useStore()` 时完全不必显式传 pinia；组件外（路由守卫、工具函数、store 互引）也能凭这根指针找到同一个实例。整套 API 的人体工学全靠它。

**代价**：这根指针是模块级单例，服务端渲染下被并发请求共享。请求 A 在它的 `setup` 顶部设了活跃指针，请求 B 进来时如果没重新设，就会错拿到 A 的库，造成跨请求串态。

**缓解**：取用走「注入优先、全局兜底」。`getActivePinia()` 先看依赖注入里有没有自己的库（每个请求的 app 有自己的注入上下文），没有才退到全局指针；开发期还会在「SSR 下兜底命中」这一危险情形主动抛错级告警，把串态风险挡在 dev 阶段。

**本质矛盾**：「全局可访问的便利」与「请求/会话级隔离」是一对天敌。只要你想让用户「不用每次传上下文」，就必然引入某种隐式上下文；只要这隐式上下文是单例，就必然在多请求/多实例下串态。Pinia 的取舍是：便利全给，但把隔离的兜底责任留给 `inject`，再用告警把「漏了注入」的高危情形显式化。这是「隐式上下文 + 多实例安全」这类问题的通解骨架——在后端框架的请求级 AsyncLocalStorage、前端的状态库设计里反复出现。

### 把库实例本身标为非响应式

实例对象在创建后立即 `markRaw`，告诉 Vue「别把我包成响应式」。

**换来**：实例被任何地方引用（被 store 持有、被插件上下文传来传去）时，不会被 Vue 的响应式系统递归代理一遍。

**代价**：实例自身字段不响应式。容器本就不是数据源（根状态盒子才是），用户从来不会去监听实例字段的变化，这条代价不落在任何用法上。

## 5. 最小原理演示：从零造一个状态库的地基

下面这段几十行的代码，只演透两件事：detached 作用域如何让「一键销毁」成立；全局活跃指针如何让「无参调用」成立、又如何埋下「SSR 串态」的种子。每一行都对应上面某个原理点。

```ts
import { effectScope, ref, markRaw } from 'vue'

const PINIA_KEY = Symbol('pinia')           // 依赖注入键
const isClient = typeof window !== 'undefined'

// 制造一个状态库：脱离作用域 + 根状态 + 注册表
function createPinia() {
  // 脱离父作用域托管响应式：stop() 一次清空所有 effect
  const scope = effectScope(true)
  const state = scope.run(() => ref({}))    // 根状态盒子，所有 store 的 state 镜像进这里
  return markRaw({
    scope,
    state,
    _s: new Map(),                          // store 注册表
    _a: null,                               // 关联的 Vue 应用
    install(app) {
      setActivePinia(this)                  // 设全局活跃指针
      this._a = app
      app.provide(PINIA_KEY, this)          // 注入到应用范围
    },
  })
}

// 全局活跃指针：模块级、可变，是「组件外无参取用」的关键
let activePinia
const setActivePinia = (p) => (activePinia = p)

// 取用：注入优先，全局兜底（SSR 下兜底是危险信号）
function getActivePinia(injected) {
  if (injected) return injected
  if (!activePinia && !isClient) {
    console.error('[pinia] 服务端取不到注入，回退全局指针会跨请求串态')
  }
  return activePinia
}

// 一键销毁：stop() 把整库的 effect 全清掉
createPinia().scope.stop()

// 无参便利 vs SSR 串态：单例指针的代价
setActivePinia(createPinia())         // 请求 A 设活跃库
const forB = getActivePinia(null)     // 请求 B 没注入 → 错拿到 A 的库
```

最后两行是理解「全局活跃指针」那条权衡的关键：单看「请求 A 设指针、请求 B 取指针」，串态似乎无解。解法不在指针本身，而在用 `inject` 把每个请求的库精准隔离——请求 B 在自己的组件树里走 `inject(PINIA_KEY)` 拿到自己的库，全局指针只是兜底，正常运行时根本不该被命中。开发期的告警，就是把「兜底被命中于服务端」这个本该是异常的情形显式化。

## 6. 执行轨迹：一次 `app.use(pinia)` 走到底

把上面六个心智模型步骤慢动作走一遍，看每一步数据长什么样。

**起点**：用户代码 `const pinia = createPinia()`。这时实例已经造好，但 `_a` 是 `null`、`_s` 是空 Map、`state.value` 是 `{}`，全局指针 `activePinia` 也还没指向它。

**第 1 步：`app.use(pinia)` 触发 `install`**。

- `setActivePinia(pinia)` —— 全局指针现在指向这个实例。
- `pinia._a = app` —— 实例记下自己归哪个应用。
- `app.provide(PINIA_KEY, pinia)` —— 应用范围内，谁 `inject(PINIA_KEY)` 都能拿到这个实例。这就是「注入优先」的源头。
- `app.config.globalProperties.$pinia = pinia` —— Options API 模板里写 `this.$pinia` 也能拿到。

**第 2 步：组件里写 `useUserStore()`**。

- 内部先 `inject(PINIA_KEY)` —— 命中（因为 install 时 provide 过）。
- 命中后顺手 `setActivePinia(pinia)`。这一步看似冗余，其实关键：它把「最近一次解析到的实例」同步给全局指针，让后续 store 互引时也能无参取到。
- 查 `_s.has('user')` —— 没有。这次返回前会先创建 user store、塞进 `_s`，再返回。注册表的 set/get 时机属于后续章，这里只看主线。

**第 3 步：user store 的某个 action 里写 `useCartStore()`**。

- 这时已经不在任何组件 setup 里了，`hasInjectionContext()` 可能是 false。
- 但全局指针 `activePinia` 在第 2 步被设过了，回退到它——拿到同一个实例。
- 查 `_s.has('cart')`。是 → 直接返回缓存的实例；否 → 创建并登记。

**第 4 步：测试结束，`disposePinia(pinia)`**。

- `pinia._e.stop()` —— 所有挂在 `_e` 下的 effect（每个 store 的 state ref、getter computed、watch 订阅）全部停掉。
- `pinia._s.clear()` —— 注册表清空。
- `pinia._p.splice(0)` —— 插件数组清空。
- `pinia.state.value = {}` —— 根状态盒子置空。
- `pinia._a = null` —— 应用引用置空。

整条轨迹里最值得记住的，是「第 2 步那次冗余的 `setActivePinia`」。它是 store 之间能无参互引的运行时闭环：每次从注入里解析到 pinia，就顺手把它写回全局指针；这样即使后面脱离了组件上下文（比如钻进另一个 store 的 action），全局指针仍然指向正确的实例。

## 7. 教学简化说明

本章演示故意省略了：插件入队的双阶段（`toBeInstalled` → `_p`）、devtools 注册、注入键的开发/生产差异、`_testing` 测试专用绕过标志、Options API 全局属性的类型扩展、Pinia 接口的完整类型签名。这些是工程边角，不服务于本章三个核心原理，留到各自专门的章节再展开。

## 8. 小结

这一章只造了容器本身，后面所有花活都是往这个容器里装东西。三个不起眼的选择合在一起，撑起了整套 Pinia 的运行地基：根状态进脱离作用域，所以能一键销毁；引入一根全局指针，所以调用处不必每次传 pinia；实例标成非响应式，避免被 Vue 包一层。

下一章会讲另一种更小的原语——订阅用到的回调集合，以及它如何借作用域自动清理自己。那个机制同样靠作用域托管生命周期，但承担的是完全不同的职责。
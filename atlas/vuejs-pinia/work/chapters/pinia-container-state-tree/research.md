# Pinia 容器与集中式状态树 · 源码精读

## 给 Writer 的教学钩子（必填，8 子项缺一不可）

- **用户痛点 / 场景**：
  没有这个中央容器之前，每个 store 各自管理状态与响应式副作用、散落各处。于是几件事都无从下手：想把整个应用的状态一次性序列化（服务端渲染要把状态塞进 payload 传给客户端）、想统一监听所有变更（开发者工具时间线）、想在测试或多应用场景里干净地拆掉全部 store。使用者需要一个「中央容器」把分散的状态、副作用、注册表都聚合到一处。

- **一句话核心思想**：
  用一个中央容器把「全部副作用作用域 + 一棵集中状态树 + store 注册表」三件套托管起来，再借宿主框架的插件机制注入应用。

- **设计动机（为什么需要它；含与前置章的复用关系标注）**：
  状态管理库必须回答三个问题——状态住在哪里、副作用由谁管、应用怎么拿到它。本章是全书地基章（无前置依赖），选择把这三件事捆在一个容器对象上：状态聚成一棵树、副作用归进一个作用域、容器借插件安装进应用。
  承前/启后标注：容器里有一个「当前活跃实例」字段，在本章只作为插件安装时的一个动作出现（容器一被安装就把自己设为默认实例），让组件外的代码也能定位到容器。这个指针机制的完整原理（模块级全局变量 + 注入回退、SSR 后必须清空）已在第 3 章『活跃实例指针』讲透，本章只看它作为容器副产物的新侧面——「容器一旦安装就自动成为默认实例」，不重演其寻址回退链。

- **关键权衡（本 Atlas 的核心）**：
  1. **选择用「脱离父级的独立副作用作用域」托管所有 store 的响应式副作用** → 换来一行指令就能整体拆掉全部 store 的计算属性与监听（测试、多实例、应用卸载都受益）→ 代价是这个作用域不会随任何组件生命周期自动回收，必须显式停止，否则常驻内存。
  2. **选择把所有 store 的状态聚成「单棵按 id 分桶的状态树」**（一棵顶层响应式引用，每个 store 占一个字符串 key）→ 换来整树可一次性序列化（服务端→客户端状态传递）、可整体监听、可在工具里统一巡视 → 代价是状态命名空间靠 id 字符串隔离（靠约定而非类型约束），且树形是「id→状态」而非业务领域的自然结构。
  3. **选择把整个容器对象标记为「不响应式」** → 换来容器内部持有的应用引用、作用域、注册表都不被深代理（避免应用↔容器互相深拷贝形成性能黑洞与循环引用）→ 代价是容器字段的变更不被响应式追踪（但这些多是初始化期写一次的低频字段，可接受）。
  4. **选择借宿主框架的「插件安装 + 依赖注入」暴露容器** → 换来组件树内靠注入即可定位容器，无需全局单例，天然支持多应用隔离 → 代价是组件外的代码（动作、普通函数）没有注入上下文，必须再靠一个全局指针兜底（直接催生了下一章的活跃指针机制）。

- **最小心智模型（3～7 步）**：
  1. 创建容器时，先开一个独立的（脱离父级的）副作用作用域
  2. 在该作用域内建一棵空的「集中状态树」（一个顶层响应式引用）
  3. 把作用域、状态树、空的 store 注册表、插件清单都装进一个容器对象，并把这个对象整体标记为不响应式
  4. 宿主应用挂载容器（走插件安装钩子）：容器把自己登记为「当前活跃实例」、记住所属应用、用注入把容器暴露给整棵组件树
  5. 此后每个 store 被创建时，把自己的状态挂到集中状态树里属于自己的那个 id 桶下
  6. 销毁时：停掉作用域（全部副作用随之失效）、清空状态树与注册表

- **最小原理演示（替代旧"复刻范围"）**：
  - 应演示：「容器三件套」最小骨架——一个副作用作用域、一棵集中状态树、一个标记为不响应式的容器对象；再演示两个核心收益：(a) 多个 store 把状态挂上后整树可序列化、(b) 停掉作用域后副作用整体失效。每一行都要对应「作用域托管副作用」「集中状态树按 id 聚合」「防深响应标记」「注入暴露容器」这几条原理。
  - 应故意省略：插件系统、开发者工具、活跃指针的注入回退、完整类型泛型、多应用隔离的边界测试。
  - **演示载体建议：首选 TS/JS**。本章核心是数据结构组织 + 设计模式（容器聚合、作用域托管副作用、防深响应），TS/JS 可忠实演透，配最小 `package.json` 即可 `node`/`bun` 跑。无需退回原仓库语言——本仓库本身就用 TS 写，且机制纯属运行时数据组织，不依赖任何语言特有语义。可用一个 mock 版的「副作用作用域」（用集合记录副作用回调、停止时统一清空）来模拟宿主框架的作用域原语，避免引入完整运行时，从而把「作用域=副作用的回收单元」这一原理讲透。

- **正文不宜展开的细节**：
  容器的测试标志字段（属测试替身章）；插件清单的「先暂存、安装时统一搬入」逻辑（属插件扩展总线章）；开发者工具在客户端+开发构建下的自动注册（属开发者工具章）；活跃指针的注入上下文回退与 SSR 诊断报错（属活跃实例指针章）；插件上下文/插件回调的完整类型签名（属插件扩展总线章）。

- **推荐的一个执行轨迹例子**：
  创建容器（状态树为空 `{}`）→ 宿主应用挂载容器（注入暴露、容器成为活跃实例）→ 某 store 被首次使用，组装时把初始状态写入状态树的 `'counter'` 桶 → 状态树变为 `{ counter: { count: 0 } }` → 此刻整树可被 `JSON.stringify` 序列化（用于服务端→客户端传递）→ 销毁：停作用域，该 store 的所有计算属性/监听瞬时失效、状态树与注册表清空。

> 以上钩子供 Writer 写「动机→核心思想→心智模型→关键权衡→原理演示」；下面事实部分供核对，不要被 Writer 当目录照抄。

## 概念要点

- **容器在创建期就开一个「脱离父级」的副作用作用域**：传入 `true`（即 detached），使该作用域不随创建它的父作用域自动回收，必须显式停止。所有 store 后续在该作用域内建立的计算属性与监听都可被统一停掉。源码位置: packages/pinia/src/createPinia.ts:11
- **集中状态树在该作用域内创建**：一个 `ref<Record<string, StateTree>>`，初始为空对象；每个 store 按 id 为 key 把自己的状态挂上来，从而聚成单棵顶层树。源码位置: packages/pinia/src/createPinia.ts:14-16
- **整个容器对象被标记为不响应式**：用 `markRaw` 包裹字面量对象，使容器自身（含持有的 app 引用、作用域、注册表）不被深响应式代理。源码位置: packages/pinia/src/createPinia.ts:22
- **容器的形状由 `Pinia` 接口固定**：`install`（插件钩子）、`state`（集中状态树）、`use`（注册插件）、`_p`（插件数组）、`_a`（关联应用）、`_e`（副作用作用域）、`_s`（store 注册表 Map）。源码位置: packages/pinia/src/rootStore.ts:63-112
- **install 是宿主框架的插件安装钩子**：安装时依次——把容器设为活跃实例、记录所属应用、用 `provide(symbol)` 把容器注入组件树、挂到全局属性上、最后把「安装前预先注册的插件」搬入正式插件数组。源码位置: packages/pinia/src/createPinia.ts:23-36
- **`use` 的双路分发**：若容器尚未安装（`_a` 为空），插件先进暂存队列；否则直接进入正式插件数组。安装时再把暂存队列统一搬入。源码位置: packages/pinia/src/createPinia.ts:38-45
- **store 注册表是一个按 id 索引的 Map**：容器持有 `_s: new Map<string, StoreGeneric>()`，后续每个 useStore 把实例存入此表。源码位置: packages/pinia/src/createPinia.ts:52
- **整体销毁是「停作用域 + 清三样」**：停作用域（副作用全失效）、清 store 注册表、清空插件数组、重置状态树为空对象、断开 app 引用。源码位置: packages/pinia/src/createPinia.ts:72-79
- **注入 key 是一个 Symbol**：dev 下带描述字符串；作为 `provide`/`inject` 的键，供组件树内定位容器。源码位置: packages/pinia/src/rootStore.ts:125-127
- **（启后，详在第 3 章）活跃指针机制也定义在容器文件里**：一个模块级变量记住「当前活跃容器」，`getActivePinia` 优先走依赖注入、回退到该全局变量。本章只关注「install 时调用 setActivePinia 把容器登记为活跃」这一个动作。源码位置: packages/pinia/src/rootStore.ts:27-58

## 关键调用链

安装期：
`app.use(pinia)` → `pinia.install(app)` → `setActivePinia(pinia)` / `pinia._a = app` / `app.provide(piniaSymbol, pinia)` / `app.config.globalProperties.$pinia = pinia` / `toBeInstalled → _p`
源码位置: packages/pinia/src/createPinia.ts:23-36

销毁期：
`disposePinia(pinia)` → `pinia._e.stop()` / `pinia._s.clear()` / `pinia._p.splice(0)` / `pinia.state.value = {}` / `pinia._a = null`
源码位置: packages/pinia/src/createPinia.ts:72-79

## 源码摘录（带行号，全文累计 ≤ 30 行）

容器三件套的创建与安装（演「作用域托管 + 集中状态树 + 防深响应 + 注入暴露」）：

```ts
// createPinia.ts:10-54（节选关键行）
const scope = effectScope(true)                                   // 11
const state = scope.run<Ref<Record<string, StateTree>>>(() =>     // 14
  ref<Record<string, StateTree>>({})                              // 15
)!                                                                 // 16

const pinia: Pinia = markRaw({                                     // 22
  install(app: App) {
    setActivePinia(pinia)                                          // 26
    pinia._a = app                                                 // 27
    app.provide(piniaSymbol, pinia)                                // 28
    app.config.globalProperties.$pinia = pinia                     // 29
    // ...
    toBeInstalled.forEach((plugin) => _p.push(plugin))             // 34
  },
  // ...
  _e: scope,                                                       // 51
  _s: new Map<string, StoreGeneric>(),                             // 52
  state,                                                           // 53
})
```

整体销毁（演「一键回收副作用」这条权衡）：

```ts
// createPinia.ts:72-79
export function disposePinia(pinia: Pinia) {
  pinia._e.stop()        // 停作用域 → 全部 store 副作用失效
  pinia._s.clear()       // 清 store 注册表
  pinia._p.splice(0)     // 清插件数组
  pinia.state.value = {} // 清集中状态树
  pinia._a = null        // 断开 app 引用
}
```

活跃指针回退链（仅点出，详归第 3 章；演「组件外无注入上下文时靠全局指针兜底」）：

```ts
// rootStore.ts:47-58
export const getActivePinia = __DEV__
  ? (): Pinia | undefined => { /* 注入 + 诊断 */ return pinia || activePinia }
  : (): Pinia | undefined =>
      (hasInjectionContext() && inject(piniaSymbol)) || activePinia
```

## 易混淆 / 边界 / 推断

- **事实**：集中状态树（`state` ref）特意在 `scope.run(...)` 内创建，使其依赖追踪绑定到该作用域。源码位置: packages/pinia/src/createPinia.ts:14-16
- **事实**：`effectScope(true)` 的 `true` 即 detached 语义，作用域脱离父级、不自动回收。源码位置: packages/pinia/src/createPinia.ts:11
- **推断（标注为推断）**：`markRaw` 的主要动机是避免 `_a`（宿主 app 引用）触发深响应式化——app 对象庞大且与容器互相引用，深代理会带来可观开销与潜在循环；源码注释未点明，但从字段构成可强推断。源码位置: packages/pinia/src/createPinia.ts:22, 50
- **边界（属第 3 章，本章点到）**：`getActivePinia` 在 SSR 且无注入上下文时会触发诊断报错；其全局指针在服务端渲染后须主动清空以防跨请求污染——这部分由第 3 章展开。源码位置: packages/pinia/src/rootStore.ts:47-58
- **未理解**：无。两个文件机制清晰，容器字段语义、安装/销毁时序均无歧义。
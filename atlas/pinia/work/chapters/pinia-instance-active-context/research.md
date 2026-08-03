# Pinia 实例：根状态、注册表与全局活跃上下文 · 源码精读

## 给 Writer 的教学钩子（必填，8 子项缺一不可）

- **用户痛点 / 场景**：在一个 Vue 应用里管理状态，用户希望：(1) 在任意组件里写一行 `useXxxStore()` 就能拿到 store，不用每次手动把『状态库』当参数传进来；(2) 在组件之外（如路由守卫、工具函数）也能拿到 store；(3) 多个 store 之间能互相引用而不陷入循环依赖；(4) 测试或卸载时能一次性把所有 store 的响应式开销清掉。没有本章这套机制，以上每一件都得用户自己显式接线——传参、手动注销、自己管缓存。

- **一句话核心思想**：状态库不靠参数传递，而靠一根全局『当前活跃』指针隐式解析；所有状态收进一个脱离组件树的作用域，便于一键销毁。

- **设计动机（为什么需要它）**：这套机制是为了调和两个矛盾而生——『人体工学上的零参数调用』与『单一可序列化状态源 + 可控生命周期』。它换来的是：调用处无需传状态库、store 间可无参互引、整库响应式可一次性回收、状态有一个统一的序列化根。本章是全书地基章（无前置依赖），它建立的『单例实例 + 活跃指针』是后续所有章节的共同前提——后续章节里的『定义即闭包、调用才装配』『store 间互引不死循环』『SSR 单一序列化契约』都建立在本章给出的这个单例容器之上；本章只讲容器本身怎么造、怎么挂、怎么被『找到』，不展开装配/订阅/序列化的细节（那些是后续章的核心权衡）。

- **关键权衡（核心原料）**：
  1. **选择用一个脱离组件树的作用域（detached）来托管根状态 → 换来对它调一次停止就能一次性销毁所有 store 的全部响应式（state/getter/订阅）→ 代价是这个状态库的生命周期独立于组件树，不会随组件自动回收，测试与多实例场景必须显式销毁。**
  2. **选择引入一根模块级、可变的全局『当前活跃实例』指针 → 换来调用 store 时不必显式传状态库、组件外也能用的人体工学 → 代价是服务端渲染下，这根全局单例指针会被并发请求共享、造成跨请求串态；缓解办法是『解析时注入优先、全局只兜底』，并在开发期对『兜底命中于服务端』这一危险情形主动告警。**
  3. **选择把状态库实例本身标记为非响应式 → 换来它被随处引用时不触发无意义的响应式代理/递归包裹 → 代价是实例自身的字段变化不会有响应式（但它本就不是数据源，根状态盒子才是，所以这个代价无实质损失）。**

- **最小心智模型（3～7 步）**：
  1. **创建**：开一个脱离组件树的作用域，在里面造一个空的根状态盒子和一个空的 store 注册表（一张映射表）。
  2. **挂载**：应用启动时，把状态库通过依赖注入 provide 进应用、把它设为『当前活跃』、并把它挂到全局属性上供 Options API 取用；同时把应用启动前就登记的插件灌入正式插件列表。
  3. **取用**：调用某 store 时，优先看依赖注入里有没有这个库；没有的话再用那根全局活跃指针兜底。
  4. **注册**：首次用到某 store 时才创建它并塞进注册表；之后每次都直接从注册表取同一个实例。
  5. **归属**：每个 store 的状态都镜像进那个根状态盒子，形成一个统一的、可整体序列化的状态树。
  6. **销毁**：停掉那个脱离作用域，所有 store 的全部响应式一次性清空，并把注册表、插件列表、根状态、应用引用一并复位。

- **最小原理演示（替代旧"复刻范围"）**：
  - **应演示**：一个几十行的从零实现，演透权衡①（脱离作用域的可一键销毁）和权衡②（全局活跃指针的无参便利 + 它带来的串态风险）。每一行对应一个原理点。
  - **应故意省略**：插件队列、devtools 集成、实例的非响应式标记、注入键的开发/生产差异、完整类型系统、测试专用绕过钩子、Options API 全局属性——这些是工程边角，不服务于本章核心原理。
  - **演示载体建议**：本仓库是 TS/Vue 仓库，建议写成一段能被 `bun run`/`node`（装 `vue` 依赖）直接跑的脚本；不强求跑通，演机制骨架即可。骨架草稿（演权衡①+②）：
    ```ts
    import { effectScope, ref } from 'vue'
    // 权衡①：detached 作用域，stop() 一次清空所有响应式
    function createDB() {
      const scope = effectScope(true)        // true = 脱离父作用域
      const state = scope.run(() => ref({})) // 根状态盒子
      return { scope, state, _s: new Map() } // _s = store 注册表
    }
    // 权衡②：模块级活跃指针 → 免传参，代价是单例串态
    let activeDB
    const setActive = (db) => (activeDB = db)
    function getActive(injected) { return injected || activeDB } // 注入优先，全局兜底

    // 演串态：两个请求共享同一根指针
    setActive(createDB())          // 请求 A 设了活跃库
    const forB = getActive(null)   // 请求 B 没注入 → 错拿到 A 的库！
    // 缓解：组件内永远走 inject 拿到自己的库；activeDB 仅在无注入时兜底，
    //       且开发期对『服务端兜底命中』发警告（对应正文权衡②的代价面）

    forB.scope.stop()              // 权衡①：整库响应式一次性销毁
    ```

- **正文不宜展开的细节**：实例被标为非响应式的原因（避免被响应式系统包裹）；注入键在开发态带描述字符串、生产态剥除以省字节；测试专用的绕过标志（属测试章）；devtools 的三重门注册条件（属 devtools 章）；应用挂载前的插件入队与挂载时灌入（属插件章）；disposePinia 的逐字段复位（测试/多实例才用）；Pinia 接口字段的完整类型签名。

- **推荐的一个执行轨迹例子**：
  输入 `app.use(pinia)` → 触发 install：把该库设为活跃、provide 进应用、挂到全局属性 → 用户在组件 setup 里写 `useUserStore()` → 解析时 inject 命中（拿到该库）→ 把它设为活跃 → 查注册表发现没有该 store → 创建并登记进注册表 → 从注册表取出返回 → 此后即便在某个 action 内部再调用别的 `useOtherStore()`，靠那根活跃指针也能无参解析到同一个库。

> 以上钩子供 Writer 写「动机→核心思想→心智模型→关键权衡→原理演示」；下面事实部分供核对，不要被 Writer 当目录照抄。

## 概念要点

- **createPinia 造出的单例对象**包含六个字段：install（Vue 插件安装函数）、state（根状态盒子）、use（登记插件）、`_p`（已装插件数组）、`_a`（关联应用）、`_e`（脱离作用域）、`_s`（store 注册表 Map）。源码位置: packages/pinia/src/createPinia.ts:22-54

- **根状态盒子在一个 detached 作用域里创建**：`effectScope(true)` 传入 `true` 表示该作用域『脱离』父作用域、不被自动回收，必须手动停止；根状态 `ref({})` 就在这个作用域内 run 出来。源码位置: packages/pinia/src/createPinia.ts:11-16。注释明示这里将来可用于 SSR 从 window 直接回填状态。源码位置: packages/pinia/src/createPinia.ts:12-13

- **整个实例经 markRaw 处理**：状态库实例本身被标为非响应式，避免它被任何响应式系统包裹。源码位置: packages/pinia/src/createPinia.ts:22

- **install 做四件事**：把该库设为活跃、记录关联应用、provide 注入键、挂全局属性 `$pinia`；客户端+开启 devtools 时还会注册 devtools。源码位置: packages/pinia/src/createPinia.ts:23-36

- **插件双阶段入列**：应用挂载前调 `use(plugin)` 会先进 `toBeInstalled` 中转队列；install 时再把队列灌进正式的 `_p`；挂载后再 `use` 则直接进 `_p`。源码位置: packages/pinia/src/createPinia.ts:18-20, 34-35, 38-45

- **store 注册表就是一张 Map**：`_s: new Map<string, StoreGeneric>()`，store 实例按 id 缓存。源码位置: packages/pinia/src/createPinia.ts:52

- **disposePinia 一键复位**：停作用域 → 清注册表 → 清空插件数组 → 根状态置空 → 应用引用置空，注释指出主要用于测试和多实例应用，销毁后实例不可再用。源码位置: packages/pinia/src/createPinia.ts:66-79

- **模块级可变全局 `activePinia`**：用 `export let` 声明的模块级变量，是『当前活跃实例』指针本身——本章权衡②的核心。源码位置: packages/pinia/src/rootStore.ts:27。其注释点明：setActivePinia 用于 SSR，在 fetch/setup/serverPrefetch 等函数顶部调用。源码位置: packages/pinia/src/rootStore.ts:23-26

- **setActivePinia 极简实现**：赋值即返回（`(pinia) => (activePinia = pinia)`），带重载类型以兼容传入 undefined。源码位置: packages/pinia/src/rootStore.ts:35-42

- **getActivePinia 有开发/生产两版，且都是『注入优先、全局兜底』**：开发版先 `hasInjectionContext() && inject(piniaSymbol)`，若没取到且非客户端（即 SSR）→ 触发 PINIA_R1004 错误级诊断，最后返回 `pinia || activePinia`；生产版去掉告警、纯逻辑 `(hasInjectionContext() && inject(piniaSymbol)) || activePinia`。源码位置: packages/pinia/src/rootStore.ts:47-58

- **PINIA_R1004 文案直接点明权衡②的代价**：『Pinia instance not found in context. This falls back to the global activePinia, which exposes you to cross-request pollution on the server.』修复建议是『在 setup 顶部调用或显式传状态库』。源码位置: packages/pinia/src/diagnostics.ts:28-32

- **piniaSymbol 的开发/生产差异**：开发态用 `Symbol('pinia')`（带描述，便于调试），生产态用 `Symbol()`（无描述，省字节），并 as 为注入键类型。源码位置: packages/pinia/src/rootStore.ts:125-127

- **Pinia 接口**：显式声明 install/state/use 及内部字段 `_p/_a/_e/_s`，外加可选 `_testing`（测试库用来绕过显式传参）。源码位置: packages/pinia/src/rootStore.ts:63-112

- **IS_CLIENT 判定**：`typeof window !== 'undefined'`，用于区分 SSR/客户端环境（getActivePinia 告警门控、devtools 注册门控都依赖它）。源码位置: packages/pinia/src/env.ts:1

- **$pinia 全局属性经模块扩展声明**：通过 `declare module 'vue'` 给 `ComponentCustomProperties` 加 `$pinia` 与内部 `_pStores`。源码位置: packages/pinia/src/globalExtensions.ts:4-22

- **编译期常量**：`__DEV__`/`__TEST__`/`__USE_DEVTOOLS__`/`__VUE_DEVTOOLS_TOAST__` 是全局编译期常量，用于开发态分支与生产态 tree-shake。源码位置: packages/pinia/src/global.d.ts:1-8

- **诊断目录全 dev-only**：diagnostics 经 nostics 的 defineDiagnostics 定义，所有调用点都在 `__DEV__` 守卫或 HMR 内，生产构建会 tree-shake 掉整个目录。源码位置: packages/pinia/src/diagnostics.ts:1-8

## 关键调用链

- **安装链**：`app.use(pinia)` → `pinia.install(app)` → `setActivePinia(pinia)` → `pinia._a = app` → `app.provide(piniaSymbol, pinia)` → `app.config.globalProperties.$pinia = pinia` → 灌入 `toBeInstalled` → `_p`。
  源码位置: packages/pinia/src/createPinia.ts:23-36

- **解析链（useStore，跨文件佐证，落地于 store.ts）**：`useStore(pinia?)` → 优先 `inject(piniaSymbol)`（注入命中则 `setActivePinia`）→ 否则依赖全局 `activePinia` 兜底 → 若仍无活跃实例则开发期抛错 → `pinia = activePinia` → 查 `_s.has(id)`，没有则创建并登记 → `_s.get(id)` 返回。
  源码位置: packages/pinia/src/store.ts:883-917（getActivePinia 的抽象定义在 packages/pinia/src/rootStore.ts:47-58）

- **作用域内重设活跃指针（跨文件佐证）**：store 的 getter computed 内、action 执行前都会再次 `setActivePinia(pinia)`——这就是 store 之间能无参互引的运行时闭环。
  源码位置: packages/pinia/src/store.ts:190, 369, 662

- **销毁链**：`disposePinia(pinia)` → `pinia._e.stop()` → `pinia._s.clear()` → `pinia._p.splice(0)` → `pinia.state.value = {}` → `pinia._a = null`。
  源码位置: packages/pinia/src/createPinia.ts:72-79

## 源码摘录（带行号，全文累计 ≤ 30 行）

createPinia.ts — 脱离作用域托管根状态（权衡①的销毁面来源）：
```ts
// packages/pinia/src/createPinia.ts:11-16
const scope = effectScope(true)
// NOTE: here we could check the window object for a state and directly set it
// if there is anything like it with Vue 3 SSR
const state = scope.run<Ref<Record<string, StateTree>>>(() =>
  ref<Record<string, StateTree>>({})
)!
```

createPinia.ts — install 主体（活跃指针 + 注入 + 全局属性）：
```ts
// packages/pinia/src/createPinia.ts:23-29
    install(app: App) {
      // this allows calling useStore() outside of a component setup after
      // installing pinia's plugin
      setActivePinia(pinia)
      pinia._a = app
      app.provide(piniaSymbol, pinia)
      app.config.globalProperties.$pinia = pinia
```

createPinia.ts — disposePinia 开头（权衡①的『一键销毁』兑现）：
```ts
// packages/pinia/src/createPinia.ts:72-74
export function disposePinia(pinia: Pinia) {
  pinia._e.stop()
  pinia._s.clear()
```

rootStore.ts — 模块级活跃指针与其赋值器（权衡②的核心）：
```ts
// packages/pinia/src/rootStore.ts:27
export let activePinia: Pinia | undefined
// packages/pinia/src/rootStore.ts:36
export const setActivePinia: _SetActivePinia = (pinia) => (activePinia = pinia)
```

rootStore.ts — getActivePinia 开发/生产双版（注入优先 + SSR 告警）：
```ts
// packages/pinia/src/rootStore.ts:47-58
export const getActivePinia = __DEV__
  ? (): Pinia | undefined => {
      const pinia = hasInjectionContext() && inject(piniaSymbol)
      if (!pinia && !IS_CLIENT) {
        diagnostics.PINIA_R1004({}, { method: 'error' })
      }
      return pinia || activePinia
    }
  : (): Pinia | undefined =>
      (hasInjectionContext() && inject(piniaSymbol)) || activePinia
```

## 易混淆 / 边界 / 推断

- **事实**：`effectScope(true)` 的 `true` 即 Vue 的 `detached` 参数；detached 作用域不挂到父作用域，须手动 `stop()`，这正是 disposePinia 调 `_e.stop()` 能一次性收掉全部 store 响应式的前提（每个 store 装配时会在 `_e` 下开子作用域——该细节属 store-assembly 章）。
- **推断（标注为推断）**：根状态 `ref({})` 本身不产生需要被作用域追踪的响应式 effect（ref 是独立可变盒子），因此把它放在 `scope.run(...)` 内创建，对它的响应式无实质影响；此处更像是『语义归属』——表达根状态属于该实例的作用域。注释中提到『SSR 可从 window 检查并直接设置 state』暗示这个盒子主要承担 SSR 序列化容器的角色。Writer 可作为设计意图陈述，但不宜断言『run 对 ref 有技术必要性』。
- **事实**：getActivePinia 开发版比生产版多了 SSR 告警分支，生产版把 `pinia || activePinia` 简化为 `|| activePinia`——两者解析优先级一致（注入优先、全局兜底），区别只在告警。
- **事实**：useStore 内部并未直接调用 getActivePinia，而是内联了同款逻辑（inject 优先 + activePinia 兜底），并额外支持测试模式绕过与显式传参；这是 getActivePinia 抽象的『重型消费者』。源码位置: packages/pinia/src/store.ts:883-900。
- **事实**：活跃指针并非『设一次就完』——install 时设一次，每次 useStore 解析到 pinia 时再设一次，store 内部跑 getter/action 前还会再设一次；这样保证『最近一次显式/注入解析到的实例』始终是活跃的，从而让 store 间互引无参化。
- **边界**：本章只讲单例容器的构造、挂载、解析与销毁；`_s` 注册表的 set/get 时机、effectScope 子作用域如何托管每个 store 的 getter/action、useStore 闭包的惰性创建——分别属 define-store-hook 与 store-assembly 章，Writer 勿在此展开。
- **未理解**：`scope.run(() => ref({}))` 中 run 对纯 ref 的技术必要性存疑（见上方推断），源码未给出解释性注释；建议 Writer 以『语义归属 + SSR 容器』陈述，不要过度断言。
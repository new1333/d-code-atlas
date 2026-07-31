# defineStore：useStore 工厂与懒实例化 · 源码精读

## 给 Writer 的教学钩子（必填，8 子项缺一不可）

- **用户痛点 / 场景**：用户在多个组件里都要用同一份状态。如果每次「定义」一个状态库就立刻把它建出来，那么没被任何组件用到的库也会被强行实例化（浪费）；而且「定义」和「取用」混在一起，用户没法做到「先统一注册定义、再在需要的地方按需取实例」。使用者真正想要的是：写一行定义，之后在任何地方调一下就能拿到「全应用唯一、且只在该用到时才被建出来」的那份状态。

- **一句话核心思想**：定义时不建任何东西，只造一个「取用入口」；真到被调用时，才按 id 去注册表里查——没有就现场装配一个并缓存，有就直接返回缓存，于是天然得到「懒创建 + 全应用单例」。

- **设计动机（为什么需要它）**：把「定义状态库」和「实例化状态库」彻底解耦——定义只登记入口与 id，实例化推迟到首次取用。这一刀切下去同时换来三件事：未被取用的库对打包器而言无副作用、可被摇树优化删除；同一份库在全应用只有一个实例（跨组件共享天然成立）；取用入口可以在「有组件注入上下文」和「无上下文（如 SSR、store 互引）」两种场景下都工作。

- **关键权衡（4 条三段式）**：
  1. **「定义期零副作用 + 显式无副作用标注」** → 换来「未被调用的库会被打包器摇树删除，bundle 不会无谓膨胀」→ 代价是用户每次取用都要先调一次取用入口（多一层函数调用，且取用入口本身是个闭包）。
  2. **「用一张以 id 为键的注册表做单例缓存」** → 换来「同一 id 全应用单例、不同组件多次取用拿到同一个实例」→ 代价是实例的生命周期挂在「状态根」上而非组件上——组件卸载不会销毁库，需手动释放，否则常驻。
  3. **「两种定义形态（配置式 / 函数式）在入口处用一个类型判定分流，共用同一条取用路径」** → 换来「用户爱用哪种写法都行，取用方式完全一致」→ 代价是配置式形态内部还得再套一层适配器，才能归一到唯一的装配机器（归下一章）。
  4. **「状态根实例的解析有隐式优先级：显式传参 → 组件注入 → 兜底；且测试模式下强制忽略显式传参」** → 换来「组件内自动取、组件外可手传或靠全局指针、测试时测试替身能整体接管」→ 代价是这套优先级是隐式的，新手不易理解「为什么无参取用也能工作」。

- **最小心智模型（6 步）**：
  1. 定义阶段：整理参数（判定是配置式还是函数式）、把 id 绑进闭包，返回「取用入口」——不创建任何实例。
  2. 取用阶段：先解析「状态根」实例（显式传参优先，否则从组件注入取，否则为空）。
  3. 拿到实例后立即把它设为「当前活跃指针」，确保后续装配期间内部代码能取到正确实例。
  4. 拿这张实例的注册表（以 id 为键的 Map）去查当前 id。
  5. 命中 → 直接返回缓存实例（单例）；未命中 → 现场装配一个（装配过程内部会顺手把它写进注册表）。
  6. 无论走哪条路，最终都从注册表取出实例返回——保证「永远返回缓存里的那一个」。

- **最小原理演示（替代旧"复刻范围"）**：
  - 应演示：一个几十行的「工厂的工厂 + 注册表单例缓存」从零实现。它演的是**核心思想**（定义期不建、首次调用才建并缓存、之后永远命中）+ **权衡 2**（以 id 为键的注册表换单例）。每一行都对应上面某个原理点。
  ```js
  // 每张状态根自带一张「id -> 实例」注册表
  function makePinia() { return { _s: new Map() } }

  function defineStore(id, setup) {
    // 【对应权衡1/核心思想】定义期零副作用：不建实例，只返回取用入口
    function useStore(pinia) {
      // 【对应步骤3前置】没有活跃指针就先记住当前状态根
      // 【对应步骤4-5】注册表里有就直接拿；没有才现场装配并缓存
      if (!pinia._s.has(id)) pinia._s.set(id, setup())
      // 【对应步骤6】永远返回缓存里的那一个 → 单例
      return pinia._s.get(id)
    }
    useStore.$id = id          // 暴露 id 给映射辅助函数
    return useStore            // 取用入口本身是闭包，绑定了 id
  }
  ```
  - 应故意省略：状态根实例的解析优先级与测试旁路、配置式/函数式双形态分流、HMR 热更新分支、devtools 实例缓存、effectScope 装配、插件混入——这些都不为「演透懒单例原理」服务，交给各自章节。

- **正文不宜展开的细节**：函数式定义的返回类型如何从 setup 返回值自动推断出 state/getter/action 三类（纯类型体操，非本章机制）；HMR 的 hot 分支与 `_pinia` 缓存（归 HMR 章）；把实例缓存到当前组件实例供 devtools 读取（归 devtools 章）；配置式内部那个把 state/getter/actions 拼成 setup 的适配器（归装配章）。

- **推荐的一个执行轨迹例子**：
  - 输入：定义 `const useCounter = defineStore('counter', () => ref(0))`。
  - 中间态 1：立刻拿到 `useCounter` 闭包，`useCounter.$id === 'counter'`，但**此刻尚未创建任何实例**，注册表里也没有 'counter'。
  - 输入：`const a = useCounter(pinia)` → 解析到 pinia → 注册表无 'counter' → 现场装配 → 写入注册表 → 返回该实例。
  - 中间态 2：注册表里现在有 'counter'。
  - 输入：`const b = useCounter(pinia)` → 注册表已命中 → **跳过装配** → `a === b`（单例成立）。

> 以上钩子供 Writer 写「动机→核心思想→心智模型→关键权衡→原理演示」；下面事实部分供核对，不要被 Writer 当目录照抄。

## 概念要点

- **三个签名重载 + 一个实现**：配置式 `defineStore(id, options)`、函数式 `defineStore(id, storeSetup, options?)`、实现签名 `defineStore(id, setup?, setupOptions?)`。前两个重载只为类型推断服务，运行时进入实现签名。源码位置: packages/pinia/src/store.ts:828-864

- **工厂模式 = 定义期零副作用**：`defineStore` 只整理参数后返回 `useStore` 闭包，**不创建 store**；上方注释「allows unused stores to be tree shaken」与 `/*! #__NO_SIDE_EFFECTS__ */` 标注共同保证未调用的定义会被打包器删除。源码位置: packages/pinia/src/store.ts:857-859, 951-953

- **形态判定**：`const isSetupStore = typeof setup === 'function'`；函数式的 options 取自第 3 参 `setupOptions`，配置式的 options 取自第 2 参 `setup`。两种形态在入口分流，但共用同一条取用路径。源码位置: packages/pinia/src/store.ts:879-881

- **状态根实例的解析（取用入口内部）**：`const hasContext = hasInjectionContext()` 先探有无注入上下文；解析优先级 = 显式传参 → `inject(piniaSymbol)`（仅当 hasContext）→ null。拿到后 `if (pinia) setActivePinia(pinia)` 把它设为活跃指针。源码位置: packages/pinia/src/store.ts:884-890

- **测试旁路**：`(__TEST__ && activePinia && activePinia._testing ? null : pinia)` —— 测试模式下若当前活跃的是 testing pinia（带 `_testing` 标志），则**显式传入的 pinia 参数被强制置 null**，从而落到 inject/activePinia 路径，让 testing pinia 的全局指针接管。注释明示「in test mode, ignore the argument provided」。源码位置: packages/pinia/src/store.ts:886-888；`_testing` 标志定义于 packages/pinia/src/rootStore.ts:106-111

- **DEV 无活跃指针时友好报错**：DEV 下若 `!activePinia` 抛错并指引「先 `app.use(pinia)`」；随后无条件 `pinia = activePinia!`。生产构建该检查被 tree-shake。源码位置: packages/pinia/src/store.ts:892-900

- **懒创建 + 单例缓存**：核心判定 `if (!pinia._s.has(id))`——仅当注册表无此 id 才装配：函数式走 `createSetupStore(id, setup, options, pinia)`，配置式走 `createOptionsStore(id, options, pinia)`。注释点明「creating the store registers it in `pinia._s`」（装配内部会自行 `pinia._s.set`）。源码位置: packages/pinia/src/store.ts:902-908（注册点 packages/pinia/src/store.ts:494）

- **恒从缓存取值**：装配与否都执行 `const store = pinia._s.get(id)!` 再 `return store`，确保「永远返回注册表里那一个」。源码位置: packages/pinia/src/store.ts:917, 948

- **注册表与活跃指针的定义**：`_s: Map<string, StoreGeneric>` 是挂在每个 Pinia 实例上的 store 注册表（以 id 为键）；`activePinia` 是模块级可变指针；`setActivePinia` 直接赋值；`piniaSymbol` 是 provide/inject 的 InjectionKey。源码位置: packages/pinia/src/rootStore.ts:27, 36, 104, 125-127

- **暴露 id 供映射辅助**：`useStore.$id = id` 在返回前挂上，供 Options API 的 map helpers 取用。源码位置: packages/pinia/src/store.ts:951

## 关键调用链

```
defineStore(id, setup?, options?)            [定义期：零副作用]
  → 判定 isSetupStore、整理 options
  → return useStore（闭包，绑定 id；挂 useStore.$id）

useStore(pinia?, hot?)                       [取用期：每次调用]
  → hasInjectionContext() ? inject(piniaSymbol) : null   （或用显式传参；__TEST__ 下传参被旁路）
  → setActivePinia(pinia)
  → pinia._s.has(id)?
       是 → （跳过装配）
       否 → createSetupStore(id,…,pinia) / createOptionsStore(id,…,pinia)
              └─ 内部 pinia._s.set(id, store)   [store.ts:494]
  → const store = pinia._s.get(id)!
  → return store
```
源码位置: packages/pinia/src/store.ts:883-917（取用主链）, 494（装配内注册点）, 828-953（工厂整体）

## 源码摘录（带行号，全文累计 ≤ 30 行）

定义期零副作用 + 形态判定（packages/pinia/src/store.ts:857-859, 879-881）：
```ts
// allows unused stores to be tree shaken
/*! #__NO_SIDE_EFFECTS__ */
export function defineStore(id: any, setup?: any, setupOptions?: any): StoreDefinition {
  ...
  const isSetupStore = typeof setup === 'function'
  options = isSetupStore ? setupOptions : setup
```

取用入口：pinia 解析 + 测试旁路 + 懒单例（packages/pinia/src/store.ts:885-908, 917, 948）：
```ts
    pinia =
      (__TEST__ && activePinia && activePinia._testing ? null : pinia) ||
      (hasContext ? inject(piniaSymbol, null) : null)
    if (pinia) setActivePinia(pinia)
    ...
    pinia = activePinia!

    if (!pinia._s.has(id)) {
      // creating the store registers in `pinia._s`
      if (isSetupStore) createSetupStore(id, setup, options, pinia)
      else createOptionsStore(id, options as any, pinia)
    }

    const store: StoreGeneric = pinia._s.get(id)!
    ...
    return store as any
```

注册表类型（packages/pinia/src/rootStore.ts:104）：
```ts
  _s: Map<string, StoreGeneric>
```

## 易混淆 / 边界 / 推断

- **事实（单例键是 id，但注册表挂在具体 Pinia 上）**：单例作用域 = 「某个 Pinia 实例 + 某个 id」。不同 Pinia 实例下同一 id 是不同的 store，这正是 SSR 多请求隔离的基础（每个请求各建一个 Pinia，各自 `_s` 互不干扰）。源码位置: packages/pinia/src/rootStore.ts:104, packages/pinia/src/store.ts:902

- **事实（显式传参可能被无视）**：即便调用时显式传了 pinia，只要处于 `__TEST__` 且当前活跃 pinia 带 `_testing`，该参数会被置 null。这是为 testing pinia 的「全局指针接管」专门开的口子，普通运行时不会触发。源码位置: packages/pinia/src/store.ts:888

- **推断（为何装配前要先 setActivePinia）**：取用入口在拿到 pinia 后、进入装配前就调用 `setActivePinia(pinia)`，推断其目的是让装配机器内部 getter/action 里再次调用 `setActivePinia(pinia)` 时能取到正确实例（store.ts:890 与装配内的 store.ts:190、369 相呼应）。标注为推断。

- **事实（生产模式无友好报错）**：DEV 的「无活跃 pinia」抛错在 `__DEV__` 内，生产被 tree-shake；生产下会直接走到 `pinia = activePinia!`（可能为 undefined）而在后续 `_s` 访问处抛原生异常。源码位置: packages/pinia/src/store.ts:892-900

- **事实（useStore 本身是闭包，状态最小）**：`useStore` 只通过闭包捕获 `id / isSetupStore / setup / options`，本身不持有 store；store 只存在于 `pinia._s`，所以「同一个 useStore 在不同 pinia 下取到不同实例」是设计内行为。源码位置: packages/pinia/src/store.ts:883, 917

- **未理解**：无重大未理解点；HMR 的 `hot` 分支与 DEV 的 `useStore._pinia = pinia` 赋值（store.ts:911-914）仅作缓存用途，详细机制归 HMR 章，本章不展开。
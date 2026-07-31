# 全局活跃指针与 Pinia 实例契约 · 源码精读

## 给 Writer 的教学钩子（必填，8 子项缺一不可）

- **用户痛点 / 场景**：在组件的 `setup()` 内部，取用一个 store 时可以靠 Vue 的依赖注入拿到 pinia 实例；可一旦脱离了组件上下文——例如在一个 store 的派生值里去取用另一个 store（跨 store 互引）、在服务端渲染的 `fetch` / `setup` / `serverPrefetch` 里、或干脆在模块顶层——注入上下文不存在，注入取用就会落空。如果没有别的方式把「当前该用哪个 pinia」传递过去，这些场景全部失效。

- **一句话核心思想**：用一个模块级的全局指针记住「此刻正在被使用的那个 pinia」，组件内走注入、组件外走指针，两条路最终汇成一个统一的取用入口。

- **设计动机（为什么需要它）**：pinia 实例需要穿越「没有注入上下文」的边界。矛盾在于：注入是「按组件作用域精确」的，但它只在组件内可用；全局指针是「无视边界」的，但它不精确。这个机制把两者叠在一起——安装时既建立注入路径、又建立全局指针路径，并在每次装配 store、求值派生值、执行动作之前把指针刷新为「当前这个 store 所属的 pinia」，从而使嵌套的取用总能拿到正确的实例。

- **关键权衡（本 Atlas 的核心）**：
  1. **用一个可变的全局模块指针，换来「无需层层把 pinia 当参数传」的便利** → 代价是：服务端多个并发请求共享同一份模块状态，指针会被互相覆盖造成跨请求串污染，用户必须在每个请求入口显式重置指针（或把 pinia 显式传给取用调用）来隔离。
  2. **取用函数优先尝试注入、取不到再回退全局指针** → 换来「组件内用最精确的注入、组件外用兜底指针」的兼容 → 代价是：组件外场景拿到的是「最后一次被设置的那个指针」，调用时序一旦不对就会取到错误的实例（所以开发构建会在服务端注入落空时报错级别警告，提醒用户这条时序风险）。
  3. **生产构建把开发版里的诊断检查整段 tree-shake 掉** → 换来生产包更小、取用路径更短更快 → 代价是：生产环境里取用失败时静默兜底，不再有任何报错提示，调试更难。
  4. **把「设置指针」做成「赋值即返回」的链式形态（带三个重载签名）** → 换来它能在赋值表达式里被直接当作值使用、类型推导顺滑 → 代价是核心状态是一个隐式可变的模块级变量，封装性弱、可被任何处改写。

- **最小心智模型（5 步）**：
  1. `app.use(pinia)` 触发安装钩子，**同一刻**做两件事：把全局指针指向自己、同时把自己 provide 进应用注入上下文——两条取用路径同时建立。
  2. 在组件 `setup()` 内取用 store：注入命中 → 顺带把指针刷新一遍。
  3. 在组件外取用 store（跨 store 互引 / SSR）：注入落空 → 回退读全局指针。
  4. 每次装配 store、每次求值派生值、每次执行动作之前：先把指针刷成「当前 store 所属的 pinia」，于是其中嵌套的二次取用能拿到正确实例。
  5. 对外暴露的取用函数 =「能注入就注入，否则读指针」——双路径归一的用户面入口。

- **最小原理演示（替代旧"复刻范围"）**：
  - 应演示：一个几十行的从零实现，只表达「全局指针 + 注入回退」这一个核心思想。要素：模块级 `let active`；一个安装函数（同时 `active = inst` 与 `app.provide(KEY, inst)`）；一个设置函数（`return active = inst`，赋值即返回）；一个取用函数（`return (有注入上下文 && inject(KEY)) || active`）。**这段演示演的是权衡 1（全局指针换便利，代价 SSR 串污染）+ 取用函数的双路径回退**——每一行都要对应到上面某个原理点。
  - 应故意省略：派生值/动作执行前的指针刷新（属装配章）、生产/开发双版本差异、测试旁路、插件扩展点契约、Symbol 的调试差异、effectScope 与状态字典（属实例章）。不追求工程完整，只演透「双路径取用 + 全局指针」。

- **正文不宜展开的细节**：设置函数的三重重载类型签名（`(Pinia)=>Pinia`/`(undefined)=>undefined`/联合）只是 TypeScript 技巧；注入用 Symbol 在开发/生产构建下的差异及其背后的多 app 场景 issue 故事；测试模式下「忽略传入 pinia、改走指针」的旁路；`Pinia` 接口的其余字段（插件数组、app、effectScope、store 注册表、测试标志）分属各自章节，本章只把它们当作「pinia 实例长什么样」的背景一笔带过。

- **推荐的一个执行轨迹例子**：SSR 两个并发请求——请求 A 设置指针为 piniaA 后 `await` 让出；请求 B 把指针覆盖为 piniaB；请求 A 恢复执行时读到的已是 piniaB → 状态串污染。正解：每个请求入口显式重置指针为本请求的 pinia（或把 pinia 显式传进取用调用），从而把「全局指针」这条不精确路径重新收窄回本请求。

> 以上钩子供 Writer 写「动机 → 核心思想 → 心智模型 → 关键权衡 → 原理演示」；下面事实部分供核对，不要被 Writer 当目录照抄。

## 概念要点

- **核心状态是一个模块级可变变量**：`export let activePinia: Pinia | undefined`，初始为 `undefined`，被「设置函数」改写、被「取用函数」及装配链读取。它是整条组件外取用路径的唯一载体。源码位置: packages/pinia/src/rootStore.ts:27
- **设置函数 = 一行赋值即返回**：`(pinia) => (activePinia = pinia)`，注释明确其用途是「SSR，以及内部调用 actions/getters 时」。源码位置: packages/pinia/src/rootStore.ts:23-36
- **设置函数的类型是三重重载** `_SetActivePinia`：分别接受实例/undefined/联合，返回对应类型——让「赋值即返回」在表达式里有正确类型。源码位置: packages/pinia/src/rootStore.ts:38-42
- **取用函数有开发/生产两版**：开发版先 `hasInjectionContext() && inject(piniaSymbol)`，若取不到且非客户端（即 SSR）则报诊断 `PINIA_R1004`（error 级），再返回 `pinia || activePinia`；生产版无诊断、直接 `(hasInjectionContext() && inject(piniaSymbol)) || activePinia`。这是「注入优先、指针回退」双路径的字面实现，也是权衡 3（生产 tree-shake 掉检查）的落点。源码位置: packages/pinia/src/rootStore.ts:47-58
- **`Pinia` 接口契约**：`install`（Vue 插件钩子）+ `state`（根状态 Ref）+ `use`（加插件）+ `_p`（插件数组）+ `_a`（所属 app）+ `_e`（effectScope）+ `_s`（store 注册表 Map）+ `_testing`（测试旁路标志）。本章只关心「pinia 实例是这样一个可被注入/指针化的对象」，其余字段归各专题章。源码位置: packages/pinia/src/rootStore.ts:63-112
- **注入用的 Symbol 也是开发/生产双形态**：开发用 `Symbol('pinia')`（带描述、可调试），生产用 `Symbol()`（更小）；标注为 `@internal`、`USE AT YOUR OWN RISK`，并附 issue 870 / PR 2973 链接（storybook 等多 app 场景需手动 inject）。源码位置: packages/pinia/src/rootStore.ts:114-127
- **`PiniaPluginContext` / `PiniaPlugin`** 定义了插件扩展点的入参契约（pinia/app/store/options）与返回类型——属插件系统章，本章仅作为「Pinia 实例契约的一部分」收录。源码位置: packages/pinia/src/rootStore.ts:129-172

## 关键调用链

- **建立双路径（安装时）**：`createPinia().install(app)` → `setActivePinia(pinia)`（建指针路径）+ `app.provide(piniaSymbol, pinia)`（建注入路径）。同一刻两件事，是双路径取用的源头。源码位置: packages/pinia/src/createPinia.ts:23-36（设置:26、provide:28，注释 24-25）
- **组件内取用**：`useStore()` → `hasContext ? inject(piniaSymbol, null) : null` → `if (pinia) setActivePinia(pinia)` → `pinia = activePinia!`。注入命中后顺带刷新指针，最终统一从指针读。源码位置: packages/pinia/src/store.ts:883-900
- **组件外取用（回退）**：同一段，当 `inject` 落空（无注入上下文）时，`pinia` 为 null 不刷新，直接走 `activePinia!`。源码位置: packages/pinia/src/store.ts:884-900
- **嵌套互引的支撑**：派生值求值前 `setActivePinia(pinia)`（注释 `// allow cross using stores`）、动作执行前 `setActivePinia(pinia)`、HMR 派生值求值前同样刷新——保证 store A 内部二次取用 store B 时，指针指向正确的 pinia。源码位置: packages/pinia/src/store.ts:188-200（设置:190、互引注释:194）、packages/pinia/src/store.ts:368-369、packages/pinia/src/store.ts:661-664
- **用户面入口**：`getActivePinia()`（自 rootStore 经 index 导出）= 注入优先 || 指针回退；注意 `useStore` 内部**不**调用它，而是直接读 `activePinia` 变量。源码位置: packages/pinia/src/index.ts:4、packages/pinia/src/store.ts:49（import 行，未含 getActivePinia）

## 源码摘录（带行号，全文累计 ≤ 30 行）

设置函数（赋值即返回）：

```ts
// packages/pinia/src/rootStore.ts
export const setActivePinia: _SetActivePinia = (pinia) => (activePinia = pinia)
```

取用函数开发/生产双版本（注入优先、指针回退；开发版含 SSR 诊断）：

```ts
// packages/pinia/src/rootStore.ts
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

安装时同时建立两条路径（注释点明「组件外取用」动机）：

```ts
// packages/pinia/src/createPinia.ts
    install(app: App) {
      // this allows calling useStore() outside of a component setup after
      // installing pinia's plugin
      setActivePinia(pinia)
      pinia._a = app
      app.provide(piniaSymbol, pinia)
```

取用 store 时的优先级与指针刷新（注入 → 回退 → 统一读指针）：

```ts
// packages/pinia/src/store.ts
    const hasContext = hasInjectionContext()
    pinia =
      (__TEST__ && activePinia && activePinia._testing ? null : pinia) ||
      (hasContext ? inject(piniaSymbol, null) : null)
    if (pinia) setActivePinia(pinia)
```

（以上 4 段合计 26 行，每段分别服务于：权衡 4「赋值即返回」、权衡 2/3「双路径 + 生产裁剪」、心智模型步骤 1「安装建立双路径」、心智模型步骤 2/3「取用优先级与回退」。）

## 易混淆 / 边界 / 推断

- **事实**：`getActivePinia` 是对外暴露的用户面 API（经 `index.ts` 导出，SSR 测试 `ssr.spec.ts`、`lifespan.spec.ts` 等使用）；而 `useStore()` 内部装配链**直接读取 `activePinia` 变量**，并不调用 `getActivePinia` 函数（store.ts 的 import 行未引入它，命中处为注释）。两者逻辑等价但实现分离。源码位置: packages/pinia/src/store.ts:49、packages/pinia/src/store.ts:887（注释）
- **事实**：开发版取用函数在 SSR（`!IS_CLIENT`）且注入落空时上报 `PINIA_R1004` 且级别为 `error`；生产版无任何检查、静默回退。源码位置: packages/pinia/src/rootStore.ts:51-53
- **事实**：取用 store 时，只有「注入/显式传入取到了 pinia」才会刷新指针（`if (pinia) setActivePinia(pinia)`）；若已靠指针兜底（pinia 为 null），则不刷新——指针维持上一次的值。源码位置: packages/pinia/src/store.ts:890
- **推断（标注为推断）**：设置函数被设计成「赋值即返回」并配三重重载，推测是为了让它在赋值表达式中可被当作值使用、并获得顺滑类型；但现有调用点（装配/getter/action/取用链）多只取其副作用、未用返回值，故其返回值更像「类型完备性 + 潜在链式场景」的设计，而非当前热点。
- **推断（标注为推断）**：模块级 `let activePinia` 是隐式可变全局状态，是 SSR 跨请求串污染的根因；开发构建用 `PINIA_R1004`（error 级）提示用户「在 SSR 顶层函数显式重置指针」，正是为这条代价兜底。
- **未理解**：`piniaSymbol` 标注 `@internal` 却仍导出，issue 870 / PR 2973 涉及 storybook 等多 app 场景下手动 inject 的具体 API 演进细节未深入追溯，仅作背景记录。
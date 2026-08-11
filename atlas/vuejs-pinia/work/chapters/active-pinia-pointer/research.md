# 活跃实例指针：在任意上下文找回 Pinia · 源码精读

## 给 Writer 的教学钩子（必填，8 子项缺一不可）

- **用户痛点 / 场景**：在一个动作里要调用另一个 store、在 getter 里要访问别的 store、在路由守卫或 API 层这种「组件之外」要用 store——这些位置都没有组件实例，框架常规的依赖注入拿不到「这个应用用的是哪个 Pinia」。没有本章机制的话，使用者只能把 Pinia 实例一层层手动传参，或全程把自己绑死在组件 setup 里，跨 store 组合与组件外调用几乎写不下去。

- **一句话核心思想**：用一个模块级变量记住「此刻正在用的那个 Pinia」，让任何上下文都能零参数找回它。

- **设计动机（为什么需要它）**：Pinia 的容器在第 2 章已经建好并通过插件安装时的依赖注入暴露给了应用；但依赖注入只在组件 setup 期间有效，一旦离开组件（动作执行期、getter 求值期、纯模块层、路由守卫），注入就失效。本章就是这个容器机制的下一个动作：在「注入够不到的地方」补一条全局回退寻址路径。（已在第 2 章『Pinia 容器与集中式状态树』讲透容器实例化与依赖注入暴露，本章只看它的新侧面：注入上下文之外如何靠一个全局指针找回实例、以及谁在何时写入这个指针。）

- **关键权衡（选择 → 换来 → 代价）**：
  1. **用进程级单变量当指针，换来零参数跨上下文寻址，代价是服务端跨请求污染**：选择用一个模块级可变变量记住当前 Pinia → 换来动作 / getter / 组件外代码无需任何参数就能定位到所属实例（`useStore()` 可以无参调用）→ 代价是 Node 服务端是单进程多请求共享这个变量，请求 A 写入的指针若不及时清空，请求 B 会读到 A 的 Pinia，造成跨请求数据串扰。因此服务端每次渲染后必须主动把指针清空。
  2. **读取走「注入优先 + 全局回退」双源，换来多应用安全 + 组件外兜底，代价是语义分叉要靠告警兜底**：选择读取时先尝试依赖注入、失败再读全局 → 换来组件内拿到精确归属于当前应用的实例（多 app 不串）、组件外仍有兜底 → 代价是两条路径语义不同，开发期必须在「回退到全局」时弹告警，提示用户这条路径在服务端有污染风险、应改成显式传实例或回到 setup 顶层。
  3. **在动作和 getter 的包裹层里主动刷新指针，换来用户无感，代价是每次调用都重写一次全局**：选择在动作被调用、getter 被求值之前各塞一行「把指针设回本 store 所属 Pinia」→ 换来动作内部再去取别的 store 时，全局指针已正确指向当前上下文，用户完全不用手动设置 → 代价是每次动作调用 / getter 求值都多一次全局写入，且指针语义是「最近一次活跃者」，并发异步场景下仍需小心。

- **最小心智模型（6 步）**：
  1. 模块加载时，全局指针为空。
  2. 应用安装容器：把容器注入应用（供组件内取用），同时把全局指针指向这个容器。
  3. 组件 setup 内取 store：读取器优先走注入拿到正确的容器，并顺手把全局指针同步成它。
  4. 组件外 / 动作 / getter 内取 store：注入不可用，读取器回退读全局指针（此时指针由第 2 步或第 5 步写入）。
  5. 动作包裹器、getter 求值器在跑用户代码之前，各自先把全局指针刷新为当前容器。
  6. 服务端每次请求渲染完毕，主动把全局指针清空，阻断跨请求串扰。

- **最小原理演示（替代旧"复刻范围"）**：
  - **应演示**：一个几十行的从零模型，演透四件事——① 一个模块级变量当指针；② 设置器是纯赋值；③ 读取器「注入优先、全局回退」的双源（注入用一个布尔标志模拟"是否在组件 setup 内"）；④ 三个写入时机（安装时、动作包裹器进入时、服务端渲染后清空）。最后用一个「两个伪请求并发共享同一全局指针、互相覆盖」的小剧本，演第 1 条权衡里「跨请求污染」为何必须清空。
  - **应故意省略**：Vue 真实的 inject/provide 运行时、effectScope、响应式、容器里的状态树与副作用回收（这些是第 2 章与后续章的内容）、测试模式特殊分支、HMR 迁移时的指针写入、devtools 注册、函数重载类型签名。
  - **演示载体建议**：**首选 TS/JS**。本章机制本质是「模块级单例 + 纯赋值设置器 + 双源读取 + 函数包裹器刷新」，纯语言层面即可演透，完全不需要 Vue 运行时；注入上下文用一个 `inSetup` 布尔标志模拟即可。配最小 `package.json` 让 `bun run`/`node` 能跑。**不选原仓库语言**的理由：本章不涉及任何 Vue 特有语义（响应式、作用域、组件生命周期都不是主角），TS/JS 讲得最透、读者最易复刻。

- **正文不宜展开的细节**：设置器的函数重载类型签名；测试模式下「忽略参数、强制走全局」的特殊分支（属于测试替身章）；热更新迁移 getter 时的指针写入（属于热更新章）；开发者工具注册；注入键在开发/生产环境下用具名还是匿名 Symbol 的差异；除 R1004 外的其他诊断码。

- **推荐的一个执行轨迹例子（服务端单请求）**：请求 A 到来 → 建容器 → 安装时注入容器并设全局指针=A → 渲染组件树 → setup 内取 store，注入拿到 A、回写全局仍=A → 动作被调用，包裹器先把全局刷新为 A，动作内取另一个 store 时回退读全局拿到 A → 渲染完成 → 钩子把全局指针清空 → 请求 B 到来时不会读到 A 的容器。

> 以上钩子供 Writer 写「动机 → 核心思想 → 心智模型 → 关键权衡 → 原理演示」；下面事实部分供核对，不要被 Writer 当目录照抄。

## 概念要点
- 全局活跃指针是一个模块级 `let` 变量，整个进程单例，初值为 `undefined`。源码位置: packages/pinia/src/rootStore.ts:27
- 设置器是一行纯赋值：把传入实例（或 `undefined`）写到全局变量上并返回，无任何副作用。源码位置: packages/pinia/src/rootStore.ts:36
- 读取器采用双源策略：**先**尝试「存在注入上下文时从注入取」，**再**回退到全局变量；开发构建额外返回前判断「注入没拿到且非客户端」即触发告警。源码位置: packages/pinia/src/rootStore.ts:47-58
- 该告警（R1004）的措辞直接点明设计意图：「回退到全局 activePinia 会让你在服务端暴露于跨请求污染」，并给出修复建议（在 setup 顶层调用或显式传实例）。源码位置: packages/pinia/src/diagnostics.ts:28-32
- 注入键是一个 Symbol；开发环境用具名 Symbol、生产环境用匿名 Symbol，作为 `provide`/`inject` 的 key，也对外暴露给 storybook 等边缘场景。源码位置: packages/pinia/src/rootStore.ts:125-127
- 容器安装（`install`）是全局指针的第一个写入点：在 `app.provide` 把容器注入应用的同时，调用设置器把全局指针指向自己，使「组件外调用 store」在安装后即成为可能。源码位置: packages/pinia/src/createPinia.ts:23-29
- 取 store 的工厂（`useStore`）是读取器的主要消费方：先判有无注入上下文，能注入则注入取（取到后顺手把全局指针同步成它）；取不到则继续往下走，最终落到「读全局指针」。全局指针为空时开发期抛错、生产期抛错。源码位置: packages/pinia/src/store.ts:883-900
- 动作包裹器在调用用户动作**之前**先把全局指针设回当前容器——这就是注释所说「调用动作和 getter 时内部自动设置」的真正含义，使动作体内再取别的 store 时无需用户手动设置。源码位置: packages/pinia/src/store.ts:361-369
- Options Store 的 getter 在 `computed` 求值回调**内部**同样先设全局指针，再调用用户 getter（允许 getter 内跨 store 访问）。源码位置: packages/pinia/src/store.ts:188-190
- Nuxt 运行时插件在服务端 `setup` 里设全局指针；在 `app:rendered` 钩子里把整棵状态树序列化进 payload 后，**主动 `setActivePinia(undefined)` 清空**，注释明言「避免在服务端持有该变量」。源码位置: packages/nuxt/src/runtime/plugin.ts:8-30

## 关键调用链
- **注册侧（写入点 1，安装时）**：`createPinia()` 返回的容器 → 应用 `app.use(pinia)` 触发 `install` → `app.provide(piniaSymbol, pinia)` + `setActivePinia(pinia)`。源码位置: packages/pinia/src/createPinia.ts:23-29
- **读取侧（组件内）**：`useStore()` → `hasInjectionContext()` 为真 → `inject(piniaSymbol)` → `setActivePinia(pinia)`（同步到全局）→ 后续用 `activePinia`。源码位置: packages/pinia/src/store.ts:884-900
- **读取侧（组件外 / 动作 / getter 内）**：`useStore()` → 无注入上下文 → `inject` 取不到 → 回退读 `activePinia`（此前由安装时、或动作包裹器、或 getter 求值器写入）。源码位置: packages/pinia/src/store.ts:884-900、packages/pinia/src/store.ts:368-369、packages/pinia/src/store.ts:189-190
- **运行期刷新（写入点 2/3）**：动作包裹器进入 → `setActivePinia(pinia)`；getter `computed` 求值 → `setActivePinia(pinia)`。源码位置: packages/pinia/src/store.ts:368-369、packages/pinia/src/store.ts:189-190
- **SSR 清理（写入点 4，清空）**：`app:rendered` 钩子 → 序列化状态进 payload → `setActivePinia(undefined)`。源码位置: packages/nuxt/src/runtime/plugin.ts:25-30

## 源码摘录（带行号，全文累计 ≤ 30 行）

全局指针三件套（指针 + 设置器 + 双源读取器，本章灵魂）：

```ts
// packages/pinia/src/rootStore.ts
27| export let activePinia: Pinia | undefined
36| export const setActivePinia: _SetActivePinia = (pinia) => (activePinia = pinia)
47| export const getActivePinia = __DEV__
48|   ? (): Pinia | undefined => {
49|       const pinia = hasInjectionContext() && inject(piniaSymbol)
51|       if (!pinia && !IS_CLIENT) {
52|         diagnostics.PINIA_R1004({}, { method: 'error' })
53|       }
55|       return pinia || activePinia
56|     }
57|   : (): Pinia | undefined =>
58|       (hasInjectionContext() && inject(piniaSymbol)) || activePinia
```

安装时写入全局指针（写入点 1）：

```ts
// packages/pinia/src/createPinia.ts
26|       setActivePinia(pinia)
27|       pinia._a = app
28|       app.provide(piniaSymbol, pinia)
29|       app.config.globalProperties.$pinia = pinia
```

动作包裹器进入时刷新（写入点 2）：

```ts
// packages/pinia/src/store.ts
368|     const wrappedAction = function (this: any) {
369|       setActivePinia(pinia)
```

Options Store getter 求值时刷新（写入点 3）：

```ts
// packages/pinia/src/store.ts
188|           computedGetters[name] = markRaw(
189|             computed(() => {
190|               setActivePinia(pinia)
```

取 store 工厂的读取流程（读取器主消费方）：

```ts
// packages/pinia/src/store.ts
884|     const hasContext = hasInjectionContext()
888|       (__TEST__ && activePinia && activePinia._testing ? null : pinia) ||
889|       (hasContext ? inject(piniaSymbol, null) : null)
890|     if (pinia) setActivePinia(pinia)
900|     pinia = activePinia!
```

SSR 渲染后清空（写入点 4，阻断跨请求污染）：

```ts
// packages/nuxt/src/runtime/plugin.ts
29|       setActivePinia(undefined)
```

## 易混淆 / 边界 / 推断
- **事实**：设置器对 `undefined` 也合法（类型重载显式列出 `(pinia: undefined): undefined`），这正是 SSR 清空复用的同一条路径——「清空」并非另一套机制，就是用设置器写入 `undefined`。源码位置: packages/pinia/src/rootStore.ts:38-42
- **事实**：`useStore` 工厂里，测试模式下若全局指针存在且带测试标记，会**故意忽略**调用方传入的 pinia 参数、强制走全局——这是测试替身的入口，本章不展开。源码位置: packages/pinia/src/store.ts:888
- **推断**：读取器之所以「注入优先」而非「直接读全局」，是为了在**多 app 同存**的场景下让组件内拿到精确归属于自身应用的实例；若直接读全局，多 app 下会拿到「最近一次安装的那个」，这是潜在的设计动机（源码未直接注释，标注为推断）。
- **推断**：动作/getter 包裹层「每次进入都重写全局」并非冗余，而是为了应对「同一进程内多个 Pinia 实例交错使用」时指针被别处改写的情况——确保当前动作体内取到的总是本 store 所属实例（推断，源码无显式注释）。
- **边界**：在并发/异步 SSR（同一进程同时处理多个请求）下，单个全局指针天然不够用——这被认为是 Nuxt 之外的使用者需自行规避的边界，框架仅以「渲染后清空 + R1004 告警」兜底，未提供 per-request 隔离的指针。
- **未理解**：暂无。
# Router 核心与导航主循环 · 源码精读

## 给 Writer 的教学钩子（必填，8 子项缺一不可）

- **用户痛点 / 场景**：导航本质是异步的——守卫可能 `return fetch(...)`、组件可能是 `() => import()` 的懒 chunk，都需要 await。但在 await 让出执行权的这段空窗里，用户完全可以再点一次链接、再触发一次导航。如果没有专门机制，那条还在 await 的旧导航会在恢复后继续往下走，最终把旧页面的 URL、滚动、组件错误地覆盖到新页面上，出现「幽灵导航」。同样地，守卫返回的重定向、被守卫中止、重复点同一个链接，都需要被主循环统一调度而不是各自为政。

- **一句话核心思想**：**用一个可变的「在途位置」令牌，在异步守卫链的每两个阶段之间插一次引用比较——只要令牌已被新导航改写，当前链立刻短路作废，从而把一整条不可预测的异步守卫链变成「随时可被新导航取消」的状态机。**

- **设计动机（为什么需要它）**：前置章已经把导航的「零件」分别造好了——守卫如何串成 promise 链、失败如何用位标志分类、URL 如何抽象成可导航可监听接口、滚动如何与导航生命周期绑定、位置如何解析与判等。但「零件」本身不回答：**谁来按顺序调用它们？谁在异步空窗里判定一条导航已经过期？谁在一切就绪后把结果落到 URL、状态与视图上？** 本章就是这台「总装」机器：它不重新发明任何零件，只负责把零件编排成一条可取消的主循环，并补上「零件之间」的取消检查点与最终收尾。
  - 承前去重提示（供 Writer 裁剪）：
    - **（已在「导航守卫管线」章讲透，本章只看它的新侧面）** 单条守卫如何 `guardToPromiseFn` promise 化、如何按 leave→beforeEach→update→beforeEnter→enter→beforeResolve 顺序串成队列——本章**不重讲**串链细节，只看这条队列在主循环里**被谁调度**、**取消检查点如何插在每两段之间**。
    - **（已在「导航失败的语义化分类」章讲透，本章只看它的新侧面）** 位标志 + Symbol 鸭子判定的建模——本章**不重讲**建模，只看主循环如何**消费**这些失败类型做分支（重定向要递归、取消要短路、重复要特殊处理但仍滚锚点）。
    - **（已在「History 抽象」章讲透，本章只看它的新侧面）** history 的 push/replace/go/listen/createHref 接口——本章只看**编程导航入口**与**浏览器前进后退的 listen 回调**两端如何接到同一个主循环上。
    - **（已在「滚动位置恢复」「路由位置与 URL 解析」章讲透，本章只看调用时机）** handleScroll 与 isSameRouteLocation/START_LOCATION——本章只看它们在收尾与重复短路里的**两个调用时机**，不重讲实现。

- **关键权衡（本 Atlas 的核心，本章 4 条）**：
  1. **选「单一可变变量做在途令牌 + 手动散布检查点」→ 换来「无需 AbortController/取消 token，一次引用比较即可作废整条 promise 链，且天然兼容旧式 next 回调 promise 化的链」→ 代价是「检查点是手动塞进每个阶段之间的，漏掉一个阶段就会产生幽灵导航；且令牌是闭包里的可变变量，跨实例/跨 realm 无法外部强制取消」**。这是全章灵魂权衡。
  2. **选「用浅响应引用承载当前路由、只在最外层整体替换」→ 换来「matched 数组里的组件实例、params 对象的内部变更不会触发深响应重渲染，视图只在整个路由切换时更新」→ 代价是「消费者不能直接 mutate 当前路由内部字段（不会触发更新），必须整体替换引用；Options API 还需要一层代理对象把每个字段重新指向最新引用」**。
  3. **选「把历史监听器的挂载推迟到首次导航成功之后（与就绪协议绑定）」→ 换来「初始导航不会被监听器二次触发、多个 app 共用一个 router 时不会重复 push」→ 代价是「就绪之前浏览器的前进/后退不会被捕获——但这本就是不该发生的窗口期，且用就绪 promise 给了上层一个明确的『可交互』时间点」**。
  4. **选「诊断信息用稳定码目录 + why/fix 严格分离 + 裸表达式调用点」→ 换来『why 只讲问题、fix 只讲补救、二者互补不重复，且调用点写成裸表达式语句后可被生产构建 tree-shake 掉、码号永久稳定可被测试断言』→ 代价是「每条诊断必须维护码号 + 双字段 + 文档链接，调用语法被约束成不能有返回值依赖」**。

- **最小心智模型（7 步）**：
  1. 创建 router 时，在途令牌初始化为「起始哨兵」，当前路由也是同一个哨兵，标记「还没发生过导航」。
  2. 一次 `push` 进入带重定向的递归入口：先把目标 resolve 成完整位置，**顺手把在途令牌改写为这个目标**（宣告「现在在途的是我」）。
  3. 若末尾匹配记录带 redirect，或在守卫里被重定向——递归回到第 2 步，并携带「重定向来源」链；递归超过阈值（30 次）即判定死循环并拒绝。
  4. 若与当前位置判等且未强制——直接构造「重复」失败短路，但**仍触发一次滚动**（同锚点跳转）。
  5. 进入守卫队列：每跑完一个阶段（离开/全局前置/更新/进入前/进入/解析前），**都在下一段之前插一次取消检查**——令牌变了就立即抛「取消」失败，整条链短路。
  6. 全部守卫通过 → 收尾：**最后再查一次取消**，然后改写 URL、整体替换当前路由引用、处理滚动、宣告就绪（首次就绪时才挂载历史监听器）。
  7. 历史监听器把浏览器前进/后退也转进同一个收尾入口（标记为非 push）；失败时按方向信息回退栈（`go(-delta)`）。

- **最小原理演示（替代旧"复刻范围"）**：
  - **应演示**：一个几十行的「可取消异步导航状态机」——只表达「在途令牌 + 阶段间检查点 → 任何阶段可作废」这一核心思想。**这段演示演的是权衡 1**（单令牌 + 手动散布检查点的选择、换来、代价）。
  - **应故意省略**：真实的守卫 arity 切换、重定向递归、滚动、URL 编解码、Vue 响应式集成、history 的三实现、devtools——这些都是旁路与工程化，不是「取消」原理本身。
  - **演示载体建议**：**首选 TS/JS**（配最小 `package.json` 用 `node`/`bun` 跑）。理由：本章核心是「异步状态机 + promise 链 + 闭包可变令牌」，是纯粹的异步控制流，**无任何宿主/原生运行时依赖**，TS/JS 能忠实演透且对读者最友好（本 Atlas 本身就是 JS 生态的 VitePress 站点）。无需退回原仓库语言。演示骨架（Writer 据此扩写）：
    ```ts
    // 演透：单一可变令牌 + 阶段间检查点 = 可取消的异步导航
    // 演的是权衡1：选「闭包可变令牌 + 手动插桩」→ 换「无需 AbortController 即可作废整条链」→ 代价「漏一个检查点就有幽灵」
    let pending: string | null = null                       // 唯一的「在途导航」令牌
    const assertStillCurrent = (to: string) => {
      if (pending !== to) throw Error(`CANCELLED: ${to} 被 ${pending} 取代`)
    }
    async function runPhases(to: string, phases: (() => Promise<void>)[]) {
      for (const p of phases) { await p(); assertStillCurrent(to) } // 每段之间手动插检查点
    }
    async function navigate(to: string, phases: (() => Promise<void>)[]) {
      pending = to                                          // 占位：宣告「现在在途的是 to」
      try { await runPhases(to, phases); assertStillCurrent(to); console.log(`✅ commit ${to}`) }
      catch (e) { console.log(`⚠️ ${e.message}`) }
    }
    const slow = () => new Promise<void>(r => setTimeout(r, 50))
    navigate('/a', [slow, slow])                            // A 启动，守卫很慢
    setTimeout(() => navigate('/b', [slow]), 10)            // 10ms 后 B 抢占 → 改写令牌
    // 期望：⚠️ CANCELLED: /a 被 /b 取代  /  ✅ commit /b
    ```

- **正文不宜展开的细节（供 Writer 裁剪）**：
  - `resolve()` 内 path 分支与 name 分支的「encode 喂匹配器 → 再 decode 回来」的编码往返——属匹配器/编码章。
  - redirect 三种形态（字符串/对象/函数）与「有 path 时清空 params、否则透传 params」的细节规则。
  - hash history 下手工改 URL（#916）导致方向信息缺失时的 `go(-1)` 回退分支。
  - devtools 挂在 record/meta 上的脏标记（`__vd_id`/`__navigationId`/`__vd_active` 等）。
  - diagnostics 里 R0020~R0121 各码逐条文案——属各 owner 文件，本章只讲目录的组织原则。
  - 多 app 共享 router 时的 `installedApps` Set 与卸载时整组重置。

- **推荐的一个执行轨迹例子**：用户在 `/a` 页快速连点 → `push('/b')`（B 的进入守卫需 await 拉取懒 chunk）→ 50ms 内又 `push('/c')`。**中间态**：B 的守卫队列进入 await 让出执行权；此时在途令牌被 C 改写成 `/c`。**B 恢复后**：在「进入守卫」与「解析前守卫」之间的取消检查发现令牌已变 → 抛「取消」失败 → B 的 promise 链短路、不再收尾。**C 走完全部守卫** → 收尾时最后再查一次取消（通过）→ 改写 URL、整体替换当前路由为 `/c`、视图渲染 `/c`。**输出**：视图停在 `/c`，B 的 chunk 虽已加载却被丢弃，无幽灵、无旧滚动误投。

> 以上钩子供 Writer 写「动机→核心思想→心智模型→关键权衡→原理演示」；下面事实部分供核对，不要被 Writer 当目录照抄。

## 概念要点

- **在途位置令牌是取消的唯一判据**：一个闭包级可变变量承载「当前在途的目标位置」，`pushWithRedirect` 入口处 `pendingLocation = resolve(to)` 即宣告占有；任何阶段的取消检查都是一次 `pendingLocation !== to` 的引用比较，不等即构造「取消」失败。源码位置: packages/router/src/router.ts:166, 427, 355-368

- **取消检查点是手动散布的**：守卫执行函数把 `checkCanceledNavigationAndReject` 绑定后 `push` 进队列，且在**离开、全局前置、更新、进入前、进入、解析前**六个阶段**每段之后都各 push 一次**；收尾函数开头还再查一次。这正是权衡 1「代价」的物证。源码位置: packages/router/src/router.ts:603-609, 620, 638, 657, 676, 687, 725-726

- **导航主循环四段式**：`push`（薄封装）→ `pushWithRedirect`（递归处理重定向 + 重复短路 + 调度守卫 + 收尾 + afterEach）→ `navigate`（串守卫队列）→ `finalizeNavigation`（改 URL + 替换状态 + 滚动 + 就绪）。`replace` 也走 `push`，靠 `{ replace: true }` 标记。源码位置: packages/router/src/router.ts:370-376, 423-554, 579-698, 717-755

- **重定向 = 递归回 pushWithRedirect**：末尾匹配记录带 `redirect` 时由 `handleRedirectRecord` 算出新目标并递归；守卫返回重定向（`NAVIGATION_GUARD_REDIRECT` 失败）时在 `.then` 里也递归回 `pushWithRedirect`，并保留 `redirectedFrom` 链。源码位置: packages/router/src/router.ts:378-421, 434-448, 487-536

- **死循环保护**：递归重定向时在 dev 下给 `redirectedFrom._count` 计数，超过 30 即报诊断码并 `reject`「无限重定向」。源码位置: packages/router/src/router.ts:500-515

- **重复导航短路但保留锚点滚动**：`!force && isSameRouteLocation(...)` 时直接构造 `NAVIGATION_DUPLICATED` 失败，但**仍调用 `handleScroll(from, from, true, false)`**——同 URL 点击也能滚到同锚点。源码位置: packages/router/src/router.ts:456-475

- **就绪协议 + 历史监听器延迟挂载**：`ready` 初始未置；`markAsReady` 在首次导航收尾或失败时被调用一次，它做三件事——置 `ready`、调用 `setupListeners()`（首次挂载 `routerHistory.listen`）、resolve/reset 所有 `isReady` promise。`setupListeners` 头部用 `removeHistoryListener` 守卫防止重复挂载。源码位置: packages/router/src/router.ts:892-952, 757-762, 926-932

- **收尾函数的职责组合**：先查取消 → 判首次导航 → 按 push/replace 调 `routerHistory.push/replace` → `currentRoute.value = toLocation` → `handleScroll` → `markAsReady`。这是「零件总装」的落点。源码位置: packages/router/src/router.ts:717-755

- **编程导航 vs 浏览器导航两端接线**：`push/replace` 是编程入口（收尾 `isPush=true`）；`setupListeners` 内的 `routerHistory.listen` 回调处理浏览器前进/后退（收尾 `isPush=false`），并在失败时按 `info.delta` 用 `routerHistory.go(-info.delta, false)` 回退栈、在守卫重定向时以 `force:true` 重新 push。源码位置: packages/router/src/router.ts:757-891

- **浅响应承载当前路由**：`currentRoute = shallowRef(START_LOCATION_NORMALIZED)`，收尾时 `currentRoute.value = toLocation` 整体替换——避免对 matched/params 深响应。源码位置: packages/router/src/router.ts:163-165, 751

- **install 的插件接入**：注册 `RouterLink`/`RouterView` 全局组件；`$router` 挂到 `globalProperties`；`$route` 用 `Object.defineProperty` 的 getter 返回 `unref(currentRoute)`（只读代理）；客户端首次（`!started` 且当前仍是哨兵）触发初始 `push(routerHistory.location)`；三处 `provide`（router / 路由位置 / routerView 位置）；覆写 `app.unmount` 在最后一个 app 卸载时整组重置（含令牌、监听器、`currentRoute.value`、`started`、`ready`）。源码位置: packages/router/src/router.ts:1017-1083

- **$route 的 shallowReactive 代理对象**：为 Options API 构造一个空对象，对其每个字段定义 getter 指向 `currentRoute.value[key]`，再 `provide(routeLocationKey, shallowReactive(reactiveRoute))`——既保持响应式、又跟随 `currentRoute` 的浅替换。源码位置: packages/router/src/router.ts:1046-1056

- **守卫队列用可重置回调列表承载**：`beforeGuards`/`beforeResolveGuards`/`afterGuards` 由 `useCallbacks` 创建（`add` 返回注销函数、`list` 返回副本、`reset` 清空）；`router.beforeEach/beforeResolve/afterEach` 即它们的 `add`。源码位置: packages/router/src/utils/callbacks.ts:4-24, packages/router/src/router.ts:160-162, 1010-1012

- **守卫串行执行器**：`runGuardQueue` 用 `reduce` 把守卫数组串成 `promise.then(() => runWithContext(guard))` 链，且每个守卫都包裹进 `runWithContext`（借用 Vue app 上下文，支持 `<3.3` 回退）。源码位置: packages/router/src/router.ts:1087-1092, 569-575

- **诊断目录的组织原则**：所有运行时警告集中在 `defineDiagnostics({ codes })` 目录，每码：稳定 `VUE_ROUTER_R####`（R0### 核心、R1### 实验数据加载器）+ `why`（只讲问题，不提补救）+ `fix`（只讲补救，不重复问题）+ 可选 `docs`；调用点全是 `diagnostics.X({...})` 裸表达式、置于 `__DEV__` 守卫后以 tree-shake 出生产包。源码位置: packages/router/src/diagnostics.ts:9-23, 24-347

- **诊断调用点的分布**：router.ts 内的调用覆盖「父路由找不到/删不存在路由/resolve 出多斜杠或无匹配/非法 location/path 带 params/hash 缺#/非法 redirect/无限重定向/未捕获错误/初始启动错误」（R0001~R0011）。源码位置: packages/router/src/router.ts:191, 206, 240, 243, 256, 271, 297, 315, 319, 404, 508, 918, 1042; 对应定义 packages/router/src/diagnostics.ts:29-90

- **devtools 适配的接入点**：`addDevtools` 在 install 末尾（dev 或 prod-devtools 特性、浏览器、未 strip 时）调用一次，用 `__hasDevtools` 标记防重复，`routerId++` 支持多实例。源码位置: packages/router/src/devtools.ts:60-69, packages/router/src/router.ts:1076-1082

- **devtools 把导航映射成 timeline**：借 `router.beforeEach`（Start）、`router.afterEach`（End，含 ✅/❌ 与 failure 详情）、`router.onError`（Error 事件）三钩子发 timeline event；用挂在 `to.meta.__navigationId` 上的递增 id 作为 `groupId` 把一次导航的 Start/End/Error 分到同组。源码位置: packages/router/src/devtools.ts:149-246, 179-179

- **devtools 的路由树 inspector + 激活态标注**：注册 `Routes` inspector；`refreshRoutesView` 从 matcher 取记录、按过滤词（把记录正则去尾 `$` 后 test 过滤词）匹配、用 `isSameRouteRecord` 标注 active/exact（matched 末位=exact，matched 包含=active）；`watch(router.currentRoute)` 触发刷新 + `notifyComponentUpdate`。源码位置: packages/router/src/devtools.ts:141-147, 254-291, 506-529

## 关键调用链

编程导航主链：
```
push(to)                                                              // router.ts:370
  → pushWithRedirect(to)                                              // 423
    → pendingLocation = resolve(to)            // 占有在途令牌         // 427
    → handleRedirectRecord(to, from)           // 带重定向则递归回本函数 // 434
    → isSameRouteLocation(...)? → NAVIGATION_DUPLICATED + handleScroll // 456-475
    → navigate(toLocation, from)                                       // 477
        ├─ extractChangingRecords → leaving/updating/entering          // 585-586
        ├─ runGuardQueue(leave + beforeRouteLeave)  + checkCancel      // 588-613
        ├─ runGuardQueue(beforeEach 全局)            + checkCancel      // 616-623
        ├─ runGuardQueue(beforeRouteUpdate + updateGuards) + checkCancel // 624-642
        ├─ runGuardQueue(beforeEnter)                + checkCancel      // 643-661
        ├─ runGuardQueue(beforeRouteEnter)           + checkCancel      // 662-680
        └─ runGuardQueue(beforeResolve 全局)         + checkCancel      // 681-690
    → finalizeNavigation(toLocation, from, isPush=true)               // 539-545
        ├─ checkCanceledNavigation            // 收尾前最后一次检查     // 725
        ├─ routerHistory.push/replace(fullPath, data)                  // 734-748
        ├─ currentRoute.value = toLocation    // 浅替换驱动视图        // 751
        ├─ handleScroll(...)                                          // 752
        └─ markAsReady() → setupListeners()     // 首次才挂 listen     // 754, 942-946
    → triggerAfterEach(toLocation, from, failure)                     // 547-551
```

浏览器导航链（前进/后退）：
```
routerHistory.listen((to, _from, info) =>)                           // 762
  → resolve(to) → handleRedirectRecord?                               // 765-780
  → pendingLocation = toLocation; saveScrollPosition(key, cur)        // 782-791
  → navigate(toLocation, from)                                        // 793
  → finalizeNavigation(isPush=false)                                  // 850-858
  → 失败且有 info.delta → routerHistory.go(-info.delta, false) // 回退 // 844-846, 861-880
```

install 接线链：
```
app.use(router) → router.install(app)                                // 1017
  → app.component(RouterLink / RouterView)                            // 1018-1019
  → globalProperties.$router / $route(getter→unref(currentRoute))     // 1023-1027
  → 首次(isBrowser && !started && 当前为哨兵): push(routerHistory.location) // 1032-1044
  → provide(routerKey / routeLocationKey(shallowReactive代理) / routerViewLocationKey) // 1054-1056
  → 覆写 app.unmount（末 app 卸载时整组重置）                         // 1058-1073
  → addDevtools(app, router, matcher)                                 // 1081
```

## 源码摘录（带行号，全文累计 ≤ 30 行）

取消令牌 + 取消检查（演权衡 1）：
```ts
// packages/router/src/router.ts
let pendingLocation: RouteLocation = START_LOCATION_NORMALIZED          // 166
function checkCanceledNavigation(to, from): NavigationFailure | void {
  if (pendingLocation !== to) {                                         // 359
    return createRouterError<NavigationFailure>(ErrorTypes.NAVIGATION_CANCELLED, { from, to })
  }
}
const canceledNavigationCheck = checkCanceledNavigationAndReject.bind(null, to, from) // 603
guards.push(canceledNavigationCheck)            // 每个守卫阶段之后都 push 一次 // 609
```

收尾：最后一次取消检查 + 浅替换 + 就绪（演权衡 1/2/3）：
```ts
// packages/router/src/router.ts
const error = checkCanceledNavigation(toLocation, from)                 // 725
if (error) return error                                                 // 726
if (isPush) { /* routerHistory.push/replace */ }                        // 734-748
currentRoute.value = toLocation                                         // 751
handleScroll(toLocation, from, isPush, isFirstNavigation); markAsReady()// 752,754
```

就绪协议触发监听器延迟挂载（演权衡 3）：
```ts
// packages/router/src/router.ts
function markAsReady<E = any>(err?: E): E | void {
  if (!ready) { ready = !err; setupListeners()                          // 942-945
    readyHandlers.list().forEach(([resolve, reject]) => (err ? reject(err) : resolve()))
    readyHandlers.reset()
  }
  return err
}
```

install：$route getter + 三处 provide（演权衡 2 + 接线）：
```ts
// packages/router/src/router.ts
Object.defineProperty(app.config.globalProperties, '$route', {          // 1024
  enumerable: true, get: () => unref(currentRoute),                     // 1025-1027
})
app.provide(routerKey, router as Router)                                // 1054
app.provide(routeLocationKey, shallowReactive(reactiveRoute))           // 1055
app.provide(routerViewLocationKey, currentRoute)                        // 1056
```

## 易混淆 / 边界 / 推断

- **事实**：`replace(to)` 实现为 `push(assign(locationAsObject(to), { replace: true }))`——replace 不是独立路径，复用 push 主循环，靠 options 标记区分。源码位置: packages/router/src/router.ts:374-376
- **事实**：`isReady()` 在已就绪且当前路由非哨兵时立即 resolve；否则把 `[resolve, reject]` 入队，由 `markAsReady(err)` 统一结算（有错则 reject）。即「首次导航失败也会让 isReady 落定（rejected）」。源码位置: packages/router/src/router.ts:926-932, 946-949
- **事实**：初始导航只在客户端、且 `!started`、且 `currentRoute.value === START_LOCATION_NORMALIZED` 时触发一次（`started` 防多 app 重复 push）。源码位置: packages/router/src/router.ts:1032-1044
- **推断**：把 `setupListeners` 放进 `markAsReady` 而非构造期，是为了让「初始导航的 URL 落定」先于「监听器开始监听」——否则初始 push 可能被自己挂的 listen 回调当成浏览器导航再处理一次。代码注释「avoid setting up listeners twice due to an invalid first navigation」佐证此意图（标注为推断）。源码位置: packages/router/src/router.ts:760-762
- **推断**：`navigate` 里六个 `guards.push(canceledNavigationCheck)` 是「手动散布」的体现——它没有被抽象成高阶包裹（如 `withCancel(guard)`），而是每段显式插入；这换取了「检查点位置完全显式、可读、不吞守卫异常」的清晰度，代价是维护者新增一个阶段时必须记得补一次检查（标注为推断）。源码位置: packages/router/src/router.ts:609,620,638,657,676,687
- **事实/边界**：devtools 的时间线分组依赖 `Object.defineProperty(to.meta, '__navigationId', ...)`——即把分组 id 作为不可枚举属性挂在路由 meta 上；这是 devtools 与运行时共享 meta 通道的约定。源码位置: packages/router/src/devtools.ts:191-194
- **事实/边界**：`finalizeNavigation` 对「首次导航」特殊处理——`isFirstNavigation = from === START_LOCATION_NORMALIZED`，首次强制走 `replace` 且尝试从 history.state 恢复滚动。源码位置: packages/router/src/router.ts:729-746
- **未理解**：`setupListeners` 内对 hash history #916 的 `info.type === NavigationType.pop && !info.delta` 分支回退 `routerHistory.go(-1, false)` 的精确触发条件组合，仅从注释推断是「手工改 hash 导致 URL 未变但栈已动」的补偿，未在源码内找到对应测试断言验证（如实标注）。
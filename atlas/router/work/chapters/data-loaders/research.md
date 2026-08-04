# 导航期数据加载器 · 源码精读

## 给 Writer 的教学钩子（必填，8 子项缺一不可）

- **用户痛点 / 场景**：路由跳转后，页面里的数据请求通常挂在组件挂载之后才发出——于是用户先看到「新页面骨架 + 转圈」，数据到了再跳一下；更糟的是多个组件各自请求、各自到达，画面会闪好几下。如果用户连点导航（A 还没回来就跳 B），A 的慢请求晚到时还会把旧数据盖回已经显示的 B 上。使用者真正想要的是：**跳转完成的那一刻，本页所有数据已就绪、且原子地一起出现，中途不闪烁、不被作废的旧请求回滚**。

- **一句话核心思想**：把数据获取从组件树挪到导航管线里，用「**先暂存、等导航确认后统一提交**」把数据的可见性与导航的生命周期绑死。

- **设计动机（为什么需要它）**：数据请求的本质是「为这次导航服务」，但传统写法把它绑在了「组件挂载」这个错误的生命周期上——组件挂载晚于导航、且各组件各自为政，于是可见性散乱。本机制把加载时机前移到「导航解析阶段」（所有守卫通过、组件可解析之时），让数据在组件挂载前就并行跑起来；并用导航确认的那一刻作为统一提交点。它**刻意绕开 Suspense**：Suspense 把异步绑到组件树的渲染上、没有跨多个加载器的统一提交点、也无法在组件挂载前就并行启动——换不来「导航即数据就绪」的语义。
  - 承前去重信号：**导航守卫管线的串联顺序与 promise 化**（导航开始→解析前→导航后的严格时序、任一环节 reject 即短路）**已在第 7 章『导航守卫管线』讲透**，本章只看它的新侧面——把「解析前 → 导航确认后」这道天然接缝，当成「并行加载 → 统一提交」的挂载点。
  - 承前去重信号：**可取消的异步导航状态机**（用待定位置在各阶段做取消检查、任何阶段都能被新导航作废）**已在第 9 章『Router 核心与导航主循环』讲透**，本章只看它的新侧面——把取消语义延伸到数据获取：给每次导航配一个中止信号传进加载器，并用「暂存 + 身份校验」防止被作废的慢请求回滚已显示的新数据。

- **关键权衡（核心原料，可被读者复述）**：
  1. **把加载挂到导航守卫、而非组件树/Suspense** → 换来「数据在导航期就并行加载、组件挂载时数据已就绪、多个加载器有统一提交点」→ 代价是「必须自己接管暂存/提交/取消/父子同步的整套生命周期，放弃了 Suspense 声明式 async 组件的简洁，且加载器与路由强耦合（插件必须装在路由上）」。
  2. **暂存→提交两阶段 + 「我这次导航是否仍是最新」的身份校验** → 换来「并行加载器的数据原子可见 + 被新导航作废的慢请求即便之后完成也不会回滚已显示的新数据」→ 代价是「每个缓存条目多一对暂存字段与待定导航槽位、提交时机分散在『立即 / 加载后』两条分支，状态机变复杂」。
  3. **『对象即 Promise』的双面 API**（把结果对象的字段直接拍到一个 promise 上返回）→ 换来「同一个返回值在组件 setup 里能解构出响应式字段、在另一个加载器体里又能 `await` 取到原始数据，从而天然支持『加载器依赖另一个加载器』」→ 代价是「类型层得发明『既是对象又是 Promise』的交叉类型，且错误处理要在嵌套与非嵌套两种调用方式间分流（嵌套才向上抛、顶层吞掉以免未捕获拒绝）」。
  4. **用一条模块级全局的『当前父子上下文』隐式传递依赖关系** → 换来「加载器作者只需在函数体里直接 `await 另一个加载器()` 就自动建立父子依赖、API 零侵入」→ 代价是「这是一份隐式的全局可变状态，跨每个 `await` 都得手动保存/恢复，时序极微妙、调试困难」。
  5. **（仅高阶实现）用代理拦截『加载器实际读了路由的哪些字段』来决定是否重取** → 换来「按需重取：只读了参数 id 就只在 id 变化时重取，query 变了但加载器没读 query 就不重取」→ 代价是「引入读取追踪代理 + 已读字段比对 + 与外部查询缓存机制强耦合，复杂度显著上升」。

- **最小心智模型（7 步）**：
  1. 装载：在路由上挂三个钩子（导航开始时 / 解析前 / 导航确认后），并为每个加载器建一个跨导航复用的缓存条目。
  2. 导航开始：为这次导航建一个中止信号，并宣告「当前待定导航」= 这次；旧待定导航的中止信号随即触发。
  3. 解析前：收集本次路由涉及的全部加载器（来自路由元信息与组件导出），把中止信号交给它们并行启动；非懒的会阻塞导航，懒的不阻塞。
  4. 每个加载器把结果写入条目的「暂存」字段（组件此时看不到），并用「我这次导航是否仍是最新」做身份校验，过气即丢弃。
  5. 所有非懒加载器完成 → 导航放行。
  6. 导航确认后：每个加载器把暂存「提交」进可见的数据字段；因提交统一发生，组件看到的是所有加载器的新数据同时到位。
  7. 若导航被作废/失败：中止信号触发，慢请求之后再完成，也因身份校验失败而不会回滚已显示的新数据。

- **最小原理演示（替代旧"复刻范围"）**：
  - 应演示：一个几十行的从零实现，演透权衡 #1、#2——**暂存隔离可见性 + 身份校验防回滚 + 并行启动 + 统一提交**。
  - 应故意省略：错误分类、嵌套加载器的父子同步、中止信号传入用户函数、SSR 初始数据注入、类型层、高阶实现的路由读取追踪。
  - 演示载体建议：**首选 TS/JS**。本章核心机制（两阶段暂存、身份校验、并行、提交时机）完全是语言无关的状态/时序问题，TS/JS 能忠实演透，且本 Atlas 产物本身是 JS 生态站点，读者最易 `bun run`/`node` 跑通。无需退回原仓库语言。
  - 演示代码（每行对应上方某个原理点）：
  ```ts
  // 演透：暂存→提交两阶段 + 「仅最新导航的数据可见」防回滚
  function makeEntry() {
    return { data: undefined, staged: null, hasStaged: false, pendingNav: null }
  }                          // ↑ 可见数据      ↑ 暂存(对组件不可见)   ↑ 在飞的导航id

  // 导航开始 → 解析前 → 确认后 的极简三段
  async function navigate(navId, entries, fetch) {
    for (const e of entries) e.pendingNav = navId            // ① 抢占：旧导航即被作废
    await Promise.all(entries.map(async e => {               // ② 解析前：并行启动
      const d = await fetch(navId)                           //    慢请求；期间可能已被新导航取代
      if (e.pendingNav !== navId) return                     //    ⭐ 我已过气→丢弃，不回滚（权衡2）
      e.staged = d; e.hasStaged = true                       //    只写暂存，不动 data（权衡1）
    }))
    for (const e of entries) if (e.hasStaged) {              // ③ 确认后：统一提交
      e.data = e.staged; e.hasStaged = false                 //    data 一次性更新→组件无闪烁
    }
  }
  // 连点演示：A 慢、B 快
  navigate('A', [a, b], slowFetch)                            // 不 await，让它自己在飞
  await navigate('B', [a, b], fastFetch)
  // 即便 A 的 slowFetch 晚到，pendingNav 已是 'B' → A 的结果被丢弃，data 仍是 B
  ```

- **正文不宜展开的细节**（供 Writer 裁剪）：本地 vs 全局的「期望错误」判定与 `errors` 选项三态；`reroute()`/导航结果如何作为「非数据错误的控制流哨兵」改变导航；SSR 下用初始数据键做首屏同步注入、以及「懒在服务端被忽略」的服务端全等待；高阶实现里把查询状态桥接进条目时的「仅在非导航期」监听约束；诊断码集合；加载器可由组件具名导出自动收集的约定。

- **推荐的一个执行轨迹例子**：输入——从首页跳到 `/users/1`，页面有两个并行、互不依赖的加载器（用户信息、用户文章）。中间态——导航开始建中止信号；解析前两个加载器并行请求、各自把结果写进暂存（此时组件仍显示首页旧数据）；二者都完成后导航放行。输出——导航确认后统一提交，组件读到的「用户信息」与「文章」两个数据字段同时更新为新值，无中间闪烁。附带——若用户连点到 `/users/2`，第一次的慢请求晚到时因「待定导航」已是第二次，其暂存被丢弃，不会把 `/users/1` 的旧数据盖到已显示的 `/users/2` 上。

> 以上钩子供 Writer 写「动机→核心思想→心智模型→关键权衡→原理演示」；下面事实部分供核对，不要被 Writer 当目录照抄。

## 概念要点
- 插件装载：创建一个独立 effect scope，调用安装函数把守卫挂到路由上，并在应用卸载时停止 scope、移除守卫；重复安装会被诊断码拦截。源码位置: packages/router/src/experimental/data-loaders/navigation-guard.ts:385-392,54-60
- 三个守卫 + 一个错误钩子是整套机制的宿主：导航开始时（建中止信号与空加载器集合）、解析前（收集并并行跑加载器）、导航确认后（统一提交 / 失败时中止与重置待定）、错误时（中止信号）。源码位置: packages/router/src/experimental/data-loaders/navigation-guard.ts:81,104,230,275
- 条目缓存以「加载器函数对象本身」为键挂在路由上（WeakMap），所以同一定义函数跨多次导航复用同一个条目——导航往返不重复建状态。源码位置: packages/router/src/experimental/data-loaders/navigation-guard.ts:68; packages/router/src/experimental/data-loaders/defineLoader.ts:130-158,417
- 每次导航新建一个中止控制器，其信号被传入加载器函数，供用户在请求里取消；新导航开始时会先中止上一条待定导航的信号。源码位置: packages/router/src/experimental/data-loaders/navigation-guard.ts:96,83-87,209
- 可见性隔离：加载器把结果写进条目的 `staged`/`stagedError` 暂存字段，绝不直接写可见的 `data`/`error`；`STAGED_NO_VALUE` 哨兵区分「暂存了 undefined」与「根本没暂存」。源码位置: packages/router/src/experimental/data-loaders/createDataLoader.ts:58-67; packages/router/src/experimental/data-loaders/symbols.ts:30; packages/router/src/experimental/data-loaders/defineLoader.ts:203-205,227
- 提交时机两态：`'after-load'`（默认）——所有非懒加载器完成后、在导航确认钩子里统一提交；`'immediate'`——本加载器一完成就在自己的 finally 里提交；非导航期（手动 reload）也走立即提交。源码位置: packages/router/src/experimental/data-loaders/createDataLoader.ts:176-179; packages/router/src/experimental/data-loaders/defineLoader.ts:262-268; packages/router/src/experimental/data-loaders/navigation-guard.ts:250-264
- 身份校验防陈旧：加载器完成时比对 `pendingLoad === currentLoad`、提交时比对 `pendingTo === to`，二者任一不成立即判定「我已被新导航取代」，结果丢弃、不提交。源码位置: packages/router/src/experimental/data-loaders/defineLoader.ts:161-164,217,291
- 双面 API：组合式返回值是「把结果字段拍到一个 promise 上」的对象——可解构（组件 setup）也可 `await`（嵌套加载器取父数据）；类型用 `_PromiseMerged = RawType & Promise<T>` 描述。源码位置: packages/router/src/experimental/data-loaders/defineLoader.ts:391-405; packages/router/src/experimental/data-loaders/utils.ts:60-61; packages/router/src/experimental/data-loaders/createDataLoader.ts:226-234
- 嵌套加载器靠模块级全局上下文：调用加载器前置入「当前条目+路由」，加载器体内 `await` 另一个加载器时，后者读到前者作为父、把自己加入父的 `children` 集合；父提交时递归提交子。上下文跨 await 用 finally 保存/恢复。源码位置: packages/router/src/experimental/data-loaders/utils.ts:19-54; packages/router/src/experimental/data-loaders/defineLoader.ts:202,314-317,369-376
- 懒加载器不阻塞导航（其 promise 在并行聚合里返回 undefined），但在服务端忽略懒、一律等待；由 `server`/`lazy` 两选项组合控制。源码位置: packages/router/src/experimental/data-loaders/navigation-guard.ts:156-160,170-172
- 期望错误：本地 `errors` 选项与全局插件 `errors` 配合，命中即不中止导航（仅对非懒加载器）；嵌套加载器的错误无法在守卫层处理、须在加载器层传播。源码位置: packages/router/src/experimental/data-loaders/navigation-guard.ts:173-194; packages/router/src/experimental/data-loaders/defineLoader.ts:247-249
- 加载器可用 `reroute()` 抛出/返回一个导航结果来改变导航（重定向/取消）；该结果被当作「非数据错误的控制流哨兵」，在守卫的 catch 里转成导航返回值，而非当作数据错误。源码位置: packages/router/src/experimental/data-loaders/navigation-guard.ts:347-368,207-219
- 加载器收集：除路由元信息显式声明的加载器外，还会扫描匹配记录的组件模块导出，凭 Symbol 鸭子判定（`isDataLoader`）自动收集。源码位置: packages/router/src/experimental/data-loaders/utils.ts:12-14; packages/router/src/experimental/data-loaders/symbols.ts:18; packages/router/src/experimental/data-loaders/navigation-guard.ts:119-130
- 高阶实现（接外部查询缓存）：把加载委托给外部 `useQuery`，用代理追踪加载器实际读了路由的哪些字段（参数/查询/hash），只在已读字段变化时才重取（`hasRouteChanged` + `isSubsetOf`）；并在「非导航期」才把外部查询状态 watch 进条目，以免破坏暂存→提交。源码位置: packages/router/src/experimental/data-loaders/defineColadaLoader.ts:111-149,454-471,733-743; packages/router/src/experimental/data-loaders/utils.ts:70-107,116-139
- SSR 首屏：服务端序列化的初始数据按键名匹配，在首次客户端渲染时同步写入可见数据并让本次 load 短路成已完成的 promise，保证组件挂载前就有数据。源码位置: packages/router/src/experimental/data-loaders/defineLoader.ts:169-184

## 关键调用链
导航触发的主链：
router.push → 导航开始钩子（建中止信号 + 空加载器集合 + 置待定导航，并中止上一条待定）→ 解析前钩子（从 matched 记录的 meta + 组件导出收集加载器，`isDataLoader` 判定）→ `Promise.all(loader._.load(...))` 并行 → 加载器写 `entry.staged` → 导航确认钩子：`loader._.getEntry().commit(to)` → `entry.data.value = staged` → 组件读 data 字段
源码位置: packages/router/src/experimental/data-loaders/navigation-guard.ts:81-102,104-226; packages/router/src/experimental/data-loaders/defineLoader.ts:208-231,287-319

嵌套加载器链：
加载器 A 体 → `await useLoaderB()` → 读模块级上下文见 A 的条目 → B.load → B 把自己加入 A.children → A.commit 递归调 childEntry.commit
源码位置: packages/router/src/experimental/data-loaders/defineLoader.ts:325-376,314-317; packages/router/src/experimental/data-loaders/utils.ts:28-54

双面 API 返回链：
`useDataLoader()` → 取条目 → `entry.pendingLoad.then(返回 staged 或 data)` → `.catch(仅嵌套时 reject)` → `Object.assign(promise, {data,error,isLoading,reload})`
源码位置: packages/router/src/experimental/data-loaders/defineLoader.ts:391-405

## 源码摘录（带行号，全文累计 ≤ 30 行）
```ts
// navigation-guard.ts:83-96  —— 每次导航抢占待定导航 + 建中止信号（演权衡#1 取消延伸）
if (router[PENDING_LOCATION_KEY]) {
  router[PENDING_LOCATION_KEY].meta[ABORT_CONTROLLER_KEY]?.abort()
}
router[PENDING_LOCATION_KEY] = to as RouteLocationNormalizedLoaded
to.meta[ABORT_CONTROLLER_KEY] = new AbortController()
```
```ts
// navigation-guard.ts:154-172  —— 解析前并行跑加载器，懒的不阻塞（演权衡#1 导航期并行）
return Promise.all(loaders.map(loader => {
  const { server, lazy, errors } = loader._.options
  if (!server && isSSR) return
  const ret = scope.run(() => app.runWithContext(() => loader._.load(to, router, from)))!
  return !isSSR && toLazyValue(lazy, to, from) ? undefined : ret.catch(/* errors 分流 */)
}))
```
```ts
// defineLoader.ts:217-228  —— 身份校验 + 只写暂存（演权衡#2 防回滚 + 隔离可见性）
if (entry.pendingLoad === currentLoad) {
  if (d instanceof NavigationResult) { entry.pendingTo = null; throw d }
  else { entry.staged = d; entry.stagedError = null }
}
```
```ts
// defineLoader.ts:262-268 + 291-304  —— 提交时机 + 仅当仍是最新导航才把暂存写进可见数据
if (options.commit === 'immediate' || !router[PENDING_LOCATION_KEY]) { entry.commit(to) }   // finally 内
// commit 内：
if (this.pendingTo === to) {
  if (this.staged !== STAGED_NO_VALUE) { this.data.value = this.staged }
  this.error.value = this.stagedError
}
```
```ts
// defineLoader.ts:391-405  —— 对象即 Promise 的双面 API（演权衡#3）
const promise = entry.pendingLoad!.then(() =>
  entry.staged === STAGED_NO_VALUE ? data.value : entry.staged
).catch((e: unknown) => (parentEntry ? Promise.reject(e) : null))   // 仅嵌套才抛
return Object.assign(promise, useDataLoaderResult)
```
```ts
// utils.ts:95-107  —— 用代理追踪加载器读了路由的哪些字段（演权衡#5 按需重取）
function trackObjectReads<T extends Record<string, unknown>>(obj: T) {
  const reads: Partial<T> = {}
  return [new Proxy(obj, {
    get(target, p, receiver) { const value = Reflect.get(target, p, receiver); reads[p] = value; return value },
  }), reads] as const
}
```

## 易混淆 / 边界 / 推断
- 事实：`STAGED_NO_VALUE` 是 Symbol 哨兵，专门区分「暂存值就是 undefined」与「尚未暂存任何东西」——直接用 `=== undefined` 无法区分二者。源码位置: packages/router/src/experimental/data-loaders/symbols.ts:30; packages/router/src/experimental/data-loaders/defineLoader.ts:153,300
- 事实：条目 WeakMap 的键是「加载器函数对象本身」（不是路由、不是名字），所以同一 loader 定义跨 A→B→A 复用同一份缓存与 in-flight 状态；这也让条目随加载器函数被 GC 而自动回收。源码位置: packages/router/src/experimental/data-loaders/defineLoader.ts:130,137; packages/router/src/experimental/data-loaders/createDataLoader.ts:17-25
- 事实：错误处理在两种调用路径上分流——嵌套（有父条目）时 promise 才 reject 以便父加载器感知；顶层组件 setup 调用时吞掉错误（错误已进 `error` 字段，避免未捕获的 promise 拒绝）。源码位置: packages/router/src/experimental/data-loaders/defineLoader.ts:398-399
- 事实：导航被中止时，若加载器内部用了 `signal.throwIfAborted()` 抛出，守卫的 catch 会识别 `signal.aborted && error === signal.reason` 并返回 false（静默取消），不会上报为错误。源码位置: packages/router/src/experimental/data-loaders/navigation-guard.ts:211-218
- 推断（标注为推断）：刻意绕开 Suspense 的根因——Suspense 把异步绑定到组件树渲染、缺少跨多个加载器的统一提交点、也无法在组件挂载前并行启动，无法兑现「导航即数据就绪」与「原子可见」。源码中无直述，系从「挂守卫 + 暂存/提交 + 并行聚合」整套设计反推。
- 推断（标注为推断）：采用模块级全局上下文而非显式参数传父子关系，是为了让加载器作者写 `await useB()` 即自动登记依赖、API 表面零侵入；代价是跨 await 的 save/restore（finally 里反复 `setCurrentContext`）。源码位置: packages/router/src/experimental/data-loaders/utils.ts:41-54; packages/router/src/experimental/data-loaders/defineLoader.ts:253,278,402
- 边界：高阶实现里 `useQueryCache().get(...).deps.delete(effectScope)` 的意图是让外部查询在导航离开后可被标记为 inactive 进而 GC，但其 deps 机制属于外部库内部，本章不展开。源码位置: packages/router/src/experimental/data-loaders/defineColadaLoader.ts:213-217,446-450
- 边界：两个加载器实现共享同一套契约（条目形状、双面 API、`_` 内部接口、IS_USE_DATA_LOADER_KEY 标记），故可在同一导航中混用；高阶实现额外持有 `route`(响应式)、`tracked`(Map)、`ext`(外部查询返回) 三字段。源码位置: packages/router/src/experimental/data-loaders/createDataLoader.ts:247-275; packages/router/src/experimental/data-loaders/defineColadaLoader.ts:705-724
- 未理解：高阶实现中「初次渲染时若外部查询已有数据则同步写入并短路本次 load」与「refetch vs refresh 由路由是否变化决定」的若干边界（如 `tracked.ready` 在 commit 时才置真）未完全追清交互细节。源码位置: packages/router/src/experimental/data-loaders/defineColadaLoader.ts:230-253,369
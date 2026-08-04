# 导航守卫管线 · 源码精读

## 给 Writer 的教学钩子（必填，8 子项缺一不可）

- **用户痛点 / 场景**：没有这套机制时，「这次跳转该不该放行」会散得到处都是——组件里手写离开判断、全局手写拦截、还要各自支持异步鉴权、跳到一半被更新的跳转作废、未登录就重定向到登录页。使用者还需要在「离开前 / 进入前 / 已确认」三个不同时机插钩子，而同一套钩子又要同时容忍两种社区写法（回调式继续、返回值式继续）。结果是：异步、可取消、可重定向、多时机、双 API 五件事缺一个都拼不成可用守卫。

- **一句话核心思想**：把每一个风格各异的导航钩子，统一适配成「一个返回 Promise 的函数」，再用一条顺序串起来的 Promise 链跑它们——钩子的「放行 / 拒绝 / 重定向」三种意图，分别对应这个 Promise 的「正常 resolve / 带特定种类地 reject / 带另一种特定种类地 reject」。

- **设计动机（为什么需要它）**：
  - 守卫必须支持异步（鉴权、预拉数据），所以执行单元天然是 Promise；钩子的三种意图要能被上层精确区分，于是直接复用前置章已经建好的「失败语义化分类」机制来承载 reject——**（已在第 4 章『导航失败的语义化分类』讲透，本章只看它的新侧面：守卫这一侧如何把使用者的 `false` / 目标地址 / Error 三种意图，投递成对应种类的失败值，好让上层一个 catch 就能区分）**。
  - 「该跑哪些离开/更新/进入钩子」的判定要建立在「当前与目标两条匹配记录链」之上——**（匹配记录链的构建已在第 6 章『路由匹配表：从配置到 matched 链』讲透，本章只把它当输入：凭记录的引用相等，把两条链切成离开/更新/进入三组）**。
  - 同一套执行管线要无缝兼容新旧两套用户 API（回调式 vs 返回值式），于是靠「函数声明的形参数量」在运行时自动识别走哪条分支。
  - 还要在导航进行中顺便把懒加载组件 chunk 拉下来，避免等到渲染再等网络。

- **关键权衡（核心原料）**：
  1. **形参数量判 API**：选择用「函数声明的形参数量是否小于 3」来判定使用者写的是返回值式新 API 还是回调式旧 API → 换来两套 API 共用同一条执行管线、对使用者零迁移成本 → 代价是判定依赖 `length` 这个隐式契约（默认参数、剩余参数、解构都会扰动 length），且旧 API 那条带继续回调的分支更绕。
  2. **三意图统一编码为 resolve / 带种类的 reject**：选择把「放行/拒绝/重定向」都收编进同一个 Promise——放行是 resolve，拒绝与重定向是「带不同失败种类的 reject」 → 换来上层只需一个 catch 就拿到结构化失败原因，且与「顺序链」天然契合（一个 reject 立刻短路整条链） → 代价是「重定向」这种本质是「转去启动新导航」的正常控制流也得借 reject 来表达，必须为它单设一种失败种类，免得和真报错混在一起。
  3. **导航期提前拉懒加载 chunk 并原地替换记录**：选择在抽取组件守卫这一步、对工厂函数式组件立即调用工厂触发 chunk 请求，解析后把组件**原地写回**它所属的记录 → 换来导航走完时组件已就绪、渲染零额外等待，且首次解析后后续导航直接命中已替换的对象（全生命周期只请求一次） → 代价是导航管线与模块加载耦合，加载失败要被翻译成可读错误，且记录在导航期会被 mutating。
  4. **组合式守卫与组件生命周期绑定 + 注入所属记录**：选择让「在任意组件里注册离开/更新守卫」的组合式 API 注入「当前所属的匹配记录」，并把守卫的注册/注销绑到组件的挂载、卸载、keep-alive 激活/停用 → 换来不限路由组件、任意组件都能挂守卫且随组件存活自动清理 → 代价是必须专门处理「keep-alive 把同一组件实例复用到不同路由」的边界：重新激活时必须重新核对它现在到底属于哪条记录。

- **最小心智模型（3～7 步）**：
  1. 导航开始，先把「从哪来 / 去哪」的两条匹配记录链按「记录引用相等」切成离开、更新、进入三组。
  2. 按固定顺序（离开 → 全局前置 → 更新 → 路由级进入前 → 组件进入 → 全局解析前）把每组里的钩子收成一个「待执行函数数组」，每个函数都返回 Promise。
  3. 核心适配：把任意风格的钩子包成「调一次钩子、把它的返回值或那个继续回调的结果，翻译成 resolve 或带种类的 reject」的 Promise 工厂；按形参数量决定「自动把返回值喂给继续回调」还是「等使用者自己调继续回调」。
  4. 用 reduce 把这个数组串成一条顺序 Promise 链——前一个 resolve 才跑下一个。
  5. 任一钩子 reject（含 `false` 拒绝、目标地址重定向）立刻短路整条链，导航以对应失败种类终止。
  6. 若钩子属于懒加载组件：先立即触发 chunk 请求，解析后把组件原地写回记录，再抽取它的守卫入队。
  7. 组件进入钩子因组件尚未创建、拿不到实例，使用者借「继续回调」注册的「组件就绪回调」被收集暂存，等组件挂载后回放。

- **最小原理演示（替代旧"复刻范围"）**：
  - **应演示**：一个仅几十行的 `guardToPromise(guard, to, from)` 适配器，演透三件事——① 形参数量切换两套 API、②「继续回调」的三种入参分别映到 resolve / 拒绝种类的 reject / 重定向种类的 reject、③ 把一组这样的 Promise 工厂 reduce 成顺序链、任一 reject 短路。每一段都要对应上面某条权衡。
  - **应故意省略**：懒加载 chunk 拉取与原地替换、keep-alive 重激活、DEV 弃用/重复调用警告、组件就绪回调的收集与回放、effect scope 上下文透传、完整泛型与五守卫全排序（全排序是下一章 `navigate()` 的事）。
  - **演示载体建议**：**首选 TS/JS**。本章核心（适配器 + 形参数判别 + Promise 顺序链 + 意图到失败种类的映射）完全是通用异步控制流，TS/JS 能忠实演透，配最小 `package.json` 即可 `bun run`/`node` 跑，且本 Atlas 产物本身就是 JS 生态站点，对读者最友好。无需原仓库语言特有语义，不退回 TS/JS 之外的载体。

- **正文不宜展开的细节**：一堆 DEV-only 诊断码（弃用警告、继续回调被调两次、组件不是合法组件对象、误把 `import()` 当成 `() => import()` 等）；vue-class-component 的选项兼容、`defineAsyncComponent` 的异步加载器兼容；组件就绪回调「按名收集 + 陈旧导航门禁」的实现细节（点到即可）；把记录预载入到可作 prop 的辅助函数（与懒加载替换同模式，一句带过）；类型层「已解析守卫」与 Typed 三态（属类型安全路由章）。

- **推荐的一个执行轨迹例子**：输入「从 /users/123（匹配链 = [用户列表, 用户详情]）跳 /login（匹配链 = [登录]）」，且用户详情上有一个离开钩子返回 `false`。中间态：切分得「离开=[列表,详情]、更新=[]、进入=[登录]」，离开组逆序成「[详情,列表]」（子先于父离开），详情的离开钩子被收进队列。跑队列：详情离开钩子返回 `false` → 继续回调走拒绝分支 → reject（中止种类的失败）→ 链短路。输出：导航以「被守卫中止」失败终止，根本走不到全局前置那一段。

> 以上钩子供 Writer 写「动机→核心思想→心智模型→关键权衡→原理演示」；下面事实部分供核对，不要被 Writer 当目录照抄。

## 概念要点

- **`guardToPromiseFn` 是全章枢纽**：把任一守卫包成 `() => Promise<void>`。内部 `new Promise`，那个「继续回调」按入参分支翻译意图：`false`→reject(NAVIGATION_ABORTED)、`Error`→reject(error)、路由位置→reject(NAVIGATION_GUARD_REDIRECT)、否则 resolve（若是函数则顺手收为「组件就绪回调」）。源码位置: packages/router/src/navigationGuards.ts:138-175
- **双 API 自动切换的判据是 `guard.length < 3`**：守卫声明形参 < 3（即返回值式新 API）时，把返回值 `.then(next)` 自动喂给继续回调；≥ 3（旧回调式，签名固定 `(to, from, next)`）时不自动调，由使用者在函数体内自调。源码位置: packages/router/src/navigationGuards.ts:188-190
- **组件就绪回调的「陈旧导航」门禁**：先捕获当前 `enterCallbackArray` 引用，push 前校验 `record.enterCallbacks[name] === enterCallbackArray`——若期间发生了新导航（回调表被清空/重建），就不再 push，避免把回调投给一个已经作废的导航。源码位置: packages/router/src/navigationGuards.ts:131-135, 166-168
- **`runWithContext` 包裹守卫调用**：为 Vue 3.5+ 的 effect scope 上下文服务，使异步守卫内部仍可用 `inject` 等；默认实现是直通 `fn => fn()`。源码位置: packages/router/src/navigationGuards.ts:127-129, 178
- **`extractComponentsGuards` 区分「已解析组件」与「懒加载工厂」**：是组件对象则直接读其上的守卫选项（兼容 `__vccOpts`）；是工厂函数则**立即调用**触发 chunk 请求。源码位置: packages/router/src/navigationGuards.ts:307-316
- **update/leave 守卫在组件未挂载时跳过**：`guardType !== 'beforeRouteEnter' && !record.instances[name]` 即 continue——离开/更新守卫依赖活的组件实例（`this`），没挂载就没意义；进入守卫不受此限（它本就发生在挂载前）。源码位置: packages/router/src/navigationGuards.ts:303-305
- **懒加载解析后原地替换 + 落盘 mods**：`isESModule` 取 `default`，写入 `record.mods[name]`（供 data-loaders 等插件取整模块），并把 `record.components[name]` 原地替换为解析后的组件——下次导航命中的是已替换对象，全生命周期只请求一次 chunk。源码位置: packages/router/src/navigationGuards.ts:327-352
- **`extractChangingRecords` 凭引用相等切三组**：以 `Math.max(from, to matched 长度)` 遍历，用 `isSameRouteRecord`（`(a.aliasOf || a) === (b.aliasOf || b)`，比的是原始记录对象引用、别名归一）分入 updating（双方都有）/ leaving（from 独有）/ entering（to 独有）。源码位置: packages/router/src/navigationGuards.ts:420-450；isSameRouteRecord: packages/router/src/location.ts:198-203
- **组合式守卫的注册/注销绑生命周期**：`onBeforeRouteLeave`/`onBeforeRouteUpdate` 经 `inject(matchedRouteKey)` 取「当前所属记录」，把守卫加入该记录的 `leaveGuards`/`updateGuards` Set；`onUnmounted`+`onDeactivated` 移除，`onActivated` 重新加入——**且重激活时重新读 `activeRecordRef.value`**，以处理 keep-alive 把同一组件实例复用到不同路由的情况。源码位置: packages/router/src/navigationGuards.ts:25-64, 73-108
- **DEV-only 守护**：`canOnlyBeCalledOnce`（继续回调只生效首次调用）+ `withDeprecationWarning`（对旧回调式发弃用警告）；`__DEV__` 为 false 时是死代码、被打包摇除。源码位置: packages/router/src/navigationGuards.ts:222-248
- **`loadRouteLocation` 与懒加载同模式**：把 `route.matched` 里所有工厂式组件全部解析 + 原地替换（区别：不抽守卫，纯预载），全部 matched 都是 redirect 时拒绝；供 RouterView 在把 route 作 prop 传之前预载入。源码位置: packages/router/src/navigationGuards.ts:364-411

## 关键调用链

- **守卫管线的顺序由调用方 `router.ts` 的 `navigate()` 组装（属下一章 router-core-navigation）**，本章函数是其零件。完整顺序：
  `leavingRecords.reverse()` 的 beforeRouteLeave → 各记录 `leaveGuards` → 〔取消检查〕→ 全局 beforeEach → 〔取消检查〕→ `updatingRecords` 的 beforeRouteUpdate → 各记录 `updateGuards` → 〔取消检查〕→ `enteringRecords` 的 beforeEnter → 〔取消检查〕→ `enteringRecords` 的 beforeRouteEnter → 〔取消检查〕→ 全局 beforeResolve → 〔取消检查〕
  源码位置: packages/router/src/router.ts:585-690
- **每段经 `runGuardQueue` 串成顺序链**：`guards.reduce((p, g) => p.then(() => runWithContext(g)), Promise.resolve())`，前一个 resolve 才跑下一个，任一 reject 短路；末尾 `.catch` 吞掉 NAVIGATION_CANCELLED（被新导航取消属正常）。源码位置: packages/router/src/router.ts:1087-1092, 692-696
- **单个守卫的内部调用链**：`runWithContext(guard.call(instance, to, from, next))` → `Promise.resolve(返回值)` →（`length<3` 时）`.then(next)` → `.catch(reject)`。源码位置: packages/router/src/navigationGuards.ts:178-211
- **组件守卫抽取链**：`extractComponentsGuards` →（懒加载时）`factory()` 立即触发 chunk → 解析 → 写 mods + 原地替换 components → `guardToPromiseFn(guard)` 入队。源码位置: packages/router/src/navigationGuards.ts:307-352

## 源码摘录（带行号，全文累计 ≤ 30 行）

「继续回调」把守卫意图翻译为 resolve / 带种类的 reject（核心）：
```ts
// navigationGuards.ts:139-175（精简）
const next = (valid?: boolean | RouteLocationRaw | ((vm: any) => unknown) | Error) => {
  if (valid === false)
    reject(createRouterError(ErrorTypes.NAVIGATION_ABORTED, { from, to }))
  else if (valid instanceof Error) reject(valid)
  else if (isRouteLocation(valid))
    reject(createRouterError(ErrorTypes.NAVIGATION_GUARD_REDIRECT, { from: to, to: valid }))
  else { /* true/undefined/函数：若是函数收为组件就绪回调，然后 */ resolve() }
}
```

形参数量切换两套 API：
```ts
// navigationGuards.ts:188-190
let guardCall = Promise.resolve(guardReturn)
if (guard.length < 3) guardCall = guardCall.then(next) // 返回值式：把返回值喂给 next
```

凭引用相等切分离开/更新/进入：
```ts
// navigationGuards.ts:432-447（精简）
const len = Math.max(from.matched.length, to.matched.length)
for (let i = 0; i < len; i++) {
  const rFrom = from.matched[i]
  if (rFrom)
    to.matched.find(r => isSameRouteRecord(r, rFrom)) ? updatingRecords.push(rFrom) : leavingRecords.push(rFrom)
  const rTo = to.matched[i]
  if (rTo && !from.matched.find(r => isSameRouteRecord(r, rTo))) enteringRecords.push(rTo)
}
```

懒加载解析后原地替换（演「导航期拉 chunk + 只解析一次」权衡）：
```ts
// navigationGuards.ts:327-340（精简）
guards.push(() => componentPromise.then(resolved => {
  const resolvedComponent = isESModule(resolved) ? resolved.default : resolved
  record.mods[name] = resolved               // 供 data-loaders 等插件取整模块
  record.components![name] = resolvedComponent // 原地替换：后续导航直接命中
  const guard = (resolvedComponent.__vccOpts || resolvedComponent)[guardType]
  return guard && guardToPromiseFn(guard, to, from, record, name, runWithContext)()
}))
```

## 易混淆 / 边界 / 推断

- **事实**：`beforeRouteEnter` 不能用 `this`（组件尚未创建），故使用者借「继续回调」注册 `(vm) => {...}`；这些回调在 `record.enterCallbacks[name]` 按名收集，等组件挂载后由 RouterView 侧回放（**回放代码不在本章 sourceFiles**，本章只负责「按名收集 + 陈旧门禁」）。源码位置: packages/router/src/navigationGuards.ts:131-135, 166-172
- **事实**：`leavingRecords` 在抽取 beforeRouteLeave 前被 `.reverse()`——子路由先于父路由离开（与挂载顺序相反）；这是离开/进入的不对称之处。源码位置: packages/router/src/router.ts:589-594
- **事实**：beforeResolve 段前有一句 NOTE「此时 `to.matched` 已规范化、不再含 `() => Promise<Component>`」——即懒加载在 beforeEnter 阶段已全部解析完毕，beforeResolve 及之后看到的都是已解析组件。源码位置: packages/router/src/router.ts:663
- **推断（标注为推断）**：用 `guard.length < 3` 判 API，依据是旧回调式签名固定三参 `(to, from, next)`、返回值式只用 `(to, from)`，`Function.length` 正好反映「声明形参数量（不含默认/剩余）」。其已知脆弱点正是默认参数/剩余参数会令 length 失真——这是该方案为「零迁移兼容两套 API」付出的代价。
- **推断（标注为推断）**：`next(目标地址)` 借 reject（而非 resolve）传重定向意图，是为了让「要重定向」也走与「要拒绝」相同的短路路径，再由最外层凭 NAVIGATION_GUARD_REDIRECT 种类识别并启动新导航——把「中止/取消/重定向」统一收进同一条 reject 控制流。
- **未理解**：组件就绪回调被收集之后，究竟由谁、在组件挂载的哪个确切时机回放，无法仅从本章源码确认（需对照 RouterView / 组件挂载侧，属 router-view-nesting 章范围）。
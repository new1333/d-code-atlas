# History 抽象：URL 模型的可导航可监听接口 · 源码精读

## 给 Writer 的教学钩子（必填，8 子项缺一不可）

- **用户痛点 / 场景**：路由器要驱动「守卫 → 视图 → 滚动恢复」，必须知道这次导航是前进还是后退、从哪来、到哪去、上一次滚到哪。但浏览器自带的历史 API 把这一切都藏在一条不可见的栈里——状态是不透明黑盒、栈长度只给总数、相邻条目无法读取、更没有「方向」概念。直接用这套原语，上层就得反复猜。于是需要一个中间层，把这套低级又不可靠的原语包成一块「自己重新记账」的深模块。

- **一句话核心思想**：在不可靠的浏览器历史原语之上，自己重新记一本带方向与位置序号的账本，对外只露出一个可换实现的窄接口。

- **设计动机（为什么需要它）**：这个机制是为了解决「浏览器历史 API 状态隐式、无方向、不可信任」与「上层路由需要确定的方向/位置/滚动语义」之间的矛盾而生的；它换来的是「上层完全不碰 DOM、三套底层策略透明可换」。其中承前部分有两条去重信号：
  - 本章底层吐出的是一段「完整路径字符串」，router 收到后才把它 resolve 成路由位置、并用 matched 链引用相等判定是否「同一位置」而短路——这个「字符串→路由位置 + 同位置短路」**已在第 4 章『路由位置与 URL 解析』讲透，本章只看这段字符串是怎么被产出并附带方向语义的**，不重讲 resolve。
  - 内存实现用一个空串哨兵标识「尚无位置」，与第 4 章的起点哨兵同构；**本章只看它在历史栈里的角色，不重讲「首次导航」语义**。

- **关键权衡（核心原料）**：
  1. **选「把方向/位置/滚动自己塞进那条不透明状态里重新记账」→ 换来「能精确知道方向、绝对位置序号、上次滚动，从而支持滚动恢复与重复短路」→ 代价「那条状态变成双方共写的共享内存，外部一旦自行改写就会错乱，且当前位置只能用相邻两条状态的序号差间接推出来」**。这是全章灵魂权衡。
  2. **选「哈希模式不另写一套，只把基准前缀标准化成井号形态后直接复用 HTML5 那套实现」→ 换来「零成本复用整套状态机与监听器，三套策略收敛为两份代码」→ 代价「HTML5 实现内部被迫长出『含井号的基准』与『普通基准』两条分支，分支膨胀」**。
  3. **选「无 DOM 环境用一个数组 + 指针自造一截历史栈」→ 换来「SSR 与测试环境没有浏览器也能跑同一套路由、三实现同构」→ 代价「刷新即丢、起点必须由用户显式设置、移动指针不产生真正的 URL 副作用」**。
  4. **选「监听回调统一吐出『类型 + 方向 + 步数差』三元组」→ 换来「上层只注册一个回调即可同时响应浏览器前进后退按钮、代码主动推送、代码跳转三类来源」→ 代价「HTML5 实现必须在事件里用序号差推方向、还得用暂停位吞掉自己主动触发的回声事件，状态机变微妙」**。

- **最小心智模型（3～7 步）**：
  1. 上层调 `push(目标)`。
  2. 实现先给「当前这一格」补上「下一站 = 目标」和「当前滚动位置」，原地改写它。
  3. 再追加一格新条目（含上一站/当前/下一站/位置序号/滚动），序号 +1。
  4. 内部「当前位置」指针指向目标。
  5. 用户点浏览器后退 → 触发回声事件，handler 读出事件携带的那格状态。
  6. 方向 = 新格序号 − 旧格序号（负 = 后退，正 = 前进）。
  7. 逐个通知监听者（目标, 来源, {类型:pop, 方向, 步数差}）。

- **最小原理演示（替代旧"复刻范围"）**：
  - 应演示：一个约 50 行的 TS 迷你——定义一个窄接口（push/replace/go/listen + location/state 两个 getter），再写两个实现：一个是「数组 + 指针」的内存版（演权衡 3 + 4：截断前进条目、方向由步数差正负推、回调统一），一个是「在不透明状态上叠一层带方向/位置/滚动的账本」的最小浏览器版（演权衡 1：push 先补旧格再追加新格、回声事件算步数差）。两实现共享同一接口，上层代码不变。
  - 应故意省略：暂停监听位、页面隐藏时的滚动持久化、特定浏览器高频调用抛错的兜底降级、状态可结构化克隆的类型限制、`<base>` 标签与 file:// 的基准归一化、href 生成正则、测试专用钩子、诊断码。
  - 演示载体建议：**首选 TS/JS**（配最小 package.json，`bun run`/`node` 可跑）。理由：核心是「窄接口 + 内存栈 + 事件监听 + 方向推导」，纯属数据结构与状态机，TS/JS 可忠实演透；且本 Atlas 产物本身是 VitePress 站点，TS/JS 对读者最易跑通。无需退回原仓库语言。

- **正文不宜展开的细节**：状态值的结构化克隆限制（不接受 Symbol/函数）；基准归一化对 `<base>` 标签、file://、URL origin 的兼容处理；href 生成的井号正则；iOS Safari 不触发 beforeunload 而改用 pagehide+visibilitychange；各诊断告警码。

- **推荐的一个执行轨迹例子**：输入用户在 `/a` 调 `push('/b')` → 中间态先把 `/a` 那格改写成 {当前:/a, 下一站:/b, 滚动:{0,200}, 序号:5}，再追加新格 {上一站:/a, 当前:/b, 下一站:null, 序号:6, 滚动:null} → 用户按后退，事件带回 /a 那格 {序号:5}，方向 = 5−6 = 后退 → 输出回调('/a','/b',{pop, 后退, −1})，上层据步数差用 /b 的路径当 key 取回 {0,200} 恢复滚动并导航到 /a。

> 以上钩子供 Writer 写「动机→核心思想→心智模型→关键权衡→原理演示」；下面事实部分供核对，不要被 Writer 当目录照抄。

## 概念要点

- **窄接口 = 深模块**：`RouterHistory` 只对外暴露 `base`/`location`/`state`（只读 getter）+ `push`/`replace`/`go`/`listen`/`createHref`/`destroy` 六个方法。上层 router 拿到的就是 `options.history`（router.ts:153），完全不直接碰 `window.history`。源码位置: common.ts:74-148；被消费于 router.ts:153, 762。

- **方向账本 StateEntry**：浏览器 `history.state` 本是不透明黑盒，这里给它规定了结构 `{back, current, forward, position, replaced, scroll}`——把「上一站/当前/下一站/栈内绝对序号/是否替换/滚动位置」全部显式化。这是权衡 1 的落点。源码位置: html5.ts:24-31。

- **位置序号 position 的来源与局限**：`buildState` 用 `window.history.length` 作 position（html5.ts:178）。但 `history.length` 只是总条目数、并非当前位置，所以监听器里要用「新 state.position − 旧 state.position」间接算出 delta（html5.ts:89）。这正是「位置只能间接推」这一代价的体现。源码位置: html5.ts:89, 178。

- **push 的两段式改写**：`push(to)` 不是简单 `pushState`，而是先 `replaceState` 把「当前条目」补上 `forward: to` 与 `scroll: computeScrollPosition()`（保存旧位置滚动），再 `pushState` 一个新条目 `{back: 旧位置, current: to, forward: null, position: 旧+1}`（html5.ts:269-296）。这两段式是「自管账本」的核心动作。

- **replace 保持位置**：`replace(to)` 只改 `current`，保留 back/forward，并把 `position` 钉回原值（html5.ts:247-264）。与 push 的「序号+1」形成对照。

- **首次导航补建状态**：若 `history.state` 为空（页面是全新打开的），`useHistoryStateNavigation` 主动 `changeLocation` 用 `{position: history.length-1, replaced:true, scroll:null}` 补一条当前条目（html5.ts:192-208）。注释明确「length 差一，要减一」。

- **changeLocation 的浏览器兜底**：`pushState/replaceState` 包在 try/catch 里——Safari 在 30 秒内调用 100 次会抛 SecurityError（html5.ts:233 注释），catch 后退化成 `location.assign/replace(url)` 强制导航（会重置调用计数）。这是对「浏览器原语不可靠」的工程兜底。源码位置: html5.ts:231-244。

- **popstate 监听与方向推导**：`useHistoryListeners` 注册 `popstate`，handler 读 `event.state`，用 position 差算 delta，再映射成 `forward/back/unknown` 方向，最后 `listeners.forEach` 广播 `{type: pop, direction, delta}`（html5.ts:70-110）。这就是权衡 4「回调统一吐三元组」的 HTML5 落点。

- **pauseState 吞回声**：`go(delta, false)` 会先 `pauseListeners()` 把暂停位记成当前位置；随后浏览器触发的 popstate 里若 `pauseState === from` 就直接 return，吞掉这次回声（html5.ts:68, 85-88, 112-114, 323-326）。用于「移动历史但不触发自家导航」的场景（如重定向回滚）。

- **滚动持久化挂在生命周期上**：`beforeUnloadListener` 在 `pagehide` 与 `visibilitychange`（注释指出 iOS Safari 不触发 beforeunload）触发，当 `visibilityState==='hidden'` 时把当前滚动 `replaceState` 进 `history.state`（html5.ts:129-138, 150-154）。这把滚动可见性与历史条目绑定，为后置的滚动恢复章铺路。

- **hash 零成本复用**：`createWebHashHistory` 仅把 base 标准化成「以 `#` 结尾」的形态（无 host 时 base 置空以适配 file://），然后 `return createWebHistory(base)`（hash.ts:33-43）。权衡 2 的落点——不写第二套状态机。代价体现在 html5 内的两条分支：`createCurrentLocation` 的 `hashPos` 分支（html5.ts:44-53）与 `changeLocation` 的 `hashIndex` 分支（html5.ts:224-230）。

- **base 归一化**：`normalizeBase` 读取 `<base>` 标签、剥离 URL origin、补前导斜杠、去尾斜杠，使后续「base + fullPath」拼接一致（common.ts:158-179）。`stripBase`（location.ts:157-162）做反向剥离，供 `createCurrentLocation` 从 `window.location.pathname` 还原出当前 HistoryLocation。

- **createHref**：`base.replace(/^[^#]+#/, '#') + location`——把含 origin 的 base 折成纯 `#` 前缀再拼路径，供 `<a href>` 使用（common.ts:182-185）。

- **memory 内存栈**：`queue: [url, state][]` + `position` 指针（memory.ts:25-26）。`setLocation` 先 `position++`，若处于栈中（`position !== queue.length`）则 `queue.splice(position)` 截断所有「前进」条目再追加（memory.ts:29-36）——忠实模拟浏览器「中途导航会丢弃前进历史」的行为。`go` 用 `Math.max/Math.min` 把指针钳制在 `[0, queue.length-1]`（memory.ts:91）。权衡 3 的落点。

- **memory 的方向判定差异**：`go` 里 `delta < 0 ? back : forward`，注释明确把 `delta===0` 当前进处理——因为内存模式没有「刷新页面」语义（memory.ts:86-90）。

- **location/state 的动态 getter**：三种实现都用 `Object.defineProperty` 把 `routerHistory.location`/`state` 定义成 enumerable getter，分别指向 `currentLocation.value` / `queue[position]`（html5.ts:341-349；memory.ts:101-109）。换来「外部读永远最新」，代价是「不能用普通赋值」（故源码有 "rewritten by Object.defineProperty" / "it's overridden right after" 注释）。

- **统一回调契约**：`NavigationCallback(to, from, {type, direction, delta})` 与 `NavigationType{pop,push}`/`NavigationDirection{back,forward,unknown}`/`NavigationInformation` 共同构成三实现共用的监听契约（common.ts:36-59）。router 在 `setupListeners` 里一次性注册（router.ts:759-762），回调内用 `info.delta` 作滚动 key（router.ts:786-791）。

- **START 哨兵**：`START = ''`（common.ts:64），memory 队列初始化为 `[[START, {}]]`（memory.ts:25）。与第 4 章 START_LOCATION 同构——标识「尚无位置」。

## 关键调用链

创建与组装：
`createWebHistory(base)` → `normalizeBase` → `useHistoryStateNavigation(base)`（产出 push/replace/location/state）+ `useHistoryListeners(base, state, location, replace)`（产出 listen/pauseListeners/destroy）→ `assign` 合并 → `Object.defineProperty` 重定义 location/state getter → 返回 RouterHistory
源码位置: html5.ts:313-352

push 主线：
`routerHistory.push(to)` → 给当前条目补 `{forward:to, scroll}` 并 `replaceState` → `buildState` 造新条目 `{position+1}` → `pushState` → `currentLocation.value = to`
源码位置: html5.ts:266-297

外部导航（浏览器后退）：
浏览器 popstate → `popStateHandler` → `createCurrentLocation` 还原 to → `delta = state.position − fromState.position` → 广播 `listeners(to, from, {pop, direction, delta})` → router `setupListeners` 回调 → `saveScrollPosition(key=from.fullPath+delta)` → `navigate(to, from)`
源码位置: html5.ts:70-110；router.ts:762-793

hash 复用：
`createWebHashHistory(base)` → base 标准化为 `#` 形态 → `createWebHistory(base)`（其余完全复用）
源码位置: hash.ts:33-43

## 源码摘录（带行号，全文累计 ≤ 30 行）

方向账本——在不透明 history.state 上叠加结构化方向/位置/滚动（权衡 1）：
```ts
// html5.ts:24-31
interface StateEntry extends HistoryState {
  back: HistoryLocation | null
  current: HistoryLocation
  forward: HistoryLocation | null
  position: number
  replaced: boolean
  scroll: _ScrollPositionNormalized | null | false
}
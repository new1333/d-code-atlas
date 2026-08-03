# URL ↔ 状态双向绑定 · 源码精读

## 给 Writer 的教学钩子（必填，8 子项缺一不可）

- **用户痛点 / 场景**：用户在依赖分析器里调了一组筛选、点开某个包、展开了一个维护者操作清单——此时他刷新页面、或者把链接发给同事，希望对方看到**一模一样**的视图。如果没有这套机制，刷新即丢失所有上下文；分享只能截图。

- **一句话核心思想**：把整个 UI 状态对象当成 `location.hash` 的"内存镜像"，用两条方向相反的监听把双方锁死——任意一边变了，另一边就跟上。

- **设计动机（为什么需要它）**：状态来源必须**单一**才不会自相矛盾。如果"内存状态"和"URL"是两份独立数据，刷新/分享/后退任何一项都会让它们错位。把这个矛盾交给"URL 即唯一真源"——内存对象只是它的一份易用副本，所有读写最终都收敛到 URL 上。

- **关键权衡（本 Atlas 的核心）**：
  - **双向同步必然震荡，必须给每条边装"消音器"**：选「在自身触发的回写里包一层忽略器，让反方向监听暂时失忆」→ 换来「状态→URL→状态」不形成无限回环 → 代价是开发时调试困难（日志看不到完整因果链，因为部分更新被静默吞掉）。
  - **「选中哪个节点」也序列化进 URL，而不仅筛选条件**：选「让选中节点用包规格字符串（`name@version`）承载」→ 换来"我点了哪个包"也能成为可分享链接 → 代价是反向解析时要拿规格去载荷表里查节点，且若该包不在当前数据集中（版本漂移、卸载）就查不到，链接会"半失效"（不报错，但选中态变空）。
  - **导航语义二分：push vs replace**：选「"切换选中节点"走路由 push（产生可前进/后退的历史条目），而"调筛选条件"走原地替换（不污染历史）」→ 换来浏览器后退键的语义符合直觉（后退 = 回到刚才看的那一项，而不是回退某次复选框点击）→ 代价是开发者必须显式区分"哪种状态变化算导航"——这里靠监听列表里把"选中项"单列出来对比新旧值实现。
  - **筛选→URL 用防抖、URL→筛选立即**：选「筛选状态变化后等 200ms 才回写 URL」→ 换来用户连续勾选/拖滑块时不会每次都触发 `history.replaceState`（避免性能浪费与抖动）→ 代价是 URL 短暂滞后于内存状态（最多 200ms），其间复制链接可能拿到旧 URL。
  - **默认值不写入 URL**：选「值等于默认值时序列化为 `undefined`（即省略键）」→ 换来 URL 短小、可读、对比友好 → 代价是默认值一旦在配置里改了，旧链接的语义会跟着"漂"（因为没显式记录原默认）。

- **最小心智模型（3～7 步）**：
  1. 启动时从 `location.hash` 反序列化出状态对象（kebab→camel 还原键名）。
  2. 把这份状态应用到内存中的筛选器集合（拆分逗号/加号成数组、字符串 `'true'` 还原为布尔等）。
  3. 装两条监听：状态→URL（写）、URL→状态（读）。
  4. 状态→URL 那条在写之前对比新旧"选中项"，决定调用路由 push 还是历史 replace。
  5. URL→状态 那条用"忽略器"包住赋值，让反向监听在本轮静默。
  6. 筛选器集合→状态对象 再加一条**防抖**通道（200ms 聚合），让筛选层高频变化不会打爆历史栈。
  7. 任何一端变化最终都收敛到 URL 这唯一真源；内存对象只是它的易用副本。

- **最小原理演示（替代旧"复刻范围"）**：
  - **应演示**：一段几十行的最小双向绑定骨架——一个普通对象（含一个字符串字段代表"选中"、一个布尔字段代表"筛选开关"）、一条 `状态→URL` 监听（用对比新旧"选中"决定 push 或 replace）、一条 `URL→状态` 监听（在"忽略器"里赋值防循环）。这段演示演的是**权衡 1（消音器）+ 权衡 3（push/replace 二分）**这两条原理——它们是整套机制最容易写错的地方。
  - **应故意省略**：kebab/camel 案式互转（属于字符层细节）、类型守卫与 schema 驱动的字段迭代（实际工程里的 `FILTERS_SCHEMA` 机制）、防抖（演示里可省略以突出主线）、选中规格反查节点对象（只是消费侧，与绑定机制本身无关）。
  - **演示载体建议**：本章仓库是 TS + Vue，但演示**不必依赖 Vue**——核心机制（hash 反序列化 + 双向 watch + push/replace 区分）用一段独立 TS/JS 脚本（可在 `node` 或浏览器 console 跑）就能演透。建议用浏览器 console 直接跑：定义状态对象、`hashchange` 监听、一个手写的"忽略器"闭包（设个 `isInternalUpdate` 布尔标志即可，等价于 `ignorableWatch` 的本质），手动改 `location.hash` 触发各种分支。**一句话原则**：载体服务于"演透原理"，不必复刻 Vue 工具链。

- **正文不宜展开的细节**：
  - kebab↔camel 的两行正则（实现细节，原理价值低）。
  - URLSearchParams 把 `null` 当 `'true'` 的兜底分支（实际是死代码，URLSearchParams 不返回 null）。
  - 设置类偏好（侧栏折叠、配色、徽章开关等）**故意不走 URL**，而走 `localStorage`——这是另一条独立的"长期偏好通道"，与本章主旨（可分享链接）正交。
  - `~settings`/`~filters` 这种"魔法字符串"复用选中字段来表达"面板打开"——属于工程化的小机巧，可以一句话带过，不宜展开。

- **推荐的一个执行轨迹例子**：
  - **输入**：用户在筛选面板里勾选了 `license:MIT`（一个筛选维度变化）。
  - **中间态**：内存筛选器对象更新 → 防抖定时器启动 → 200ms 后触发回写 → 序列化（默认值省略，非默认项以 kebab-case 写入）→ 因为"选中项"未变，走 `history.replaceState` → URL 静默替换。
  - **输入 2**：用户紧接着点击某个包节点。
  - **中间态 2**：`selected` 字段被赋值为该包的规格字符串 → 监听器检测到 `selected` 新旧不同 → 走 `router.push` 产生一条历史条目。
  - **输出**：用户按浏览器后退 → 回到"还没点这个包"的视图（筛选条件仍在）；再后退一次 → 回到"还没勾 license:MIT"的视图。整套语义符合直觉。

> 以上钩子供 Writer 写「动机→核心思想→心智模型→关键权衡→原理演示」；下面事实部分供核对，不要被 Writer 当目录照抄。

## 概念要点

- **状态对象是一个 plain reactive 容器**，承载 8 个固定键：选中节点规格、安装输入、维护者操作面板的一组开关（全选、排序、是否含 publint、是否只看最新）、维护者作者筛选、当前激活的 action。这些键全部是字符串（数组也压成逗号串），刻意"扁平化"以便 URL 友好。
  源码位置: packages/node-modules-inspector/src/app/state/query.ts:8-28

- **键名转换**：内存里用 camelCase（`selectedAction`），URL 里用 kebab-case（`selected-action`）；两条小正则互相镜像。这个对称性是数据双向流动的基础。
  源码位置: packages/node-modules-inspector/src/app/state/query.ts:30-36

- **数组序列化策略**：写时用 `+` 连接（`a+b`），读时用 `[,+]` 同时切分——支持两种分隔符。这是因为 URLSearchParams 的值不允许空格，`+` 在 URL 里是空格的标准编码，能同时满足"人眼可读"与"不破坏 URL 语义"。
  源码位置: packages/node-modules-inspector/src/app/state/query.ts:38-44, 66-69

- **筛选层 ↔ URL 的转换是 schema 驱动的**：遍历一份字段元数据（每个字段标注 `type: Array | Boolean | String`），按类型分别走 split/`=== 'true'`/原值的还原分支；反向同理（join/`'true'`/原值）。这意味着新增一个筛选维度时，URL 序列化是自动的，无需改绑定代码。
  源码位置: packages/node-modules-inspector/src/app/state/query.ts:60-91

- **默认值省略**：序列化时若值等于默认（用 `isDeepEqual` 浅比较数组的逐元素相等），则写 `undefined`——`stringifyQuery` 的 filter 会把假值过滤掉，URL 里就不出现这个键。这保证 URL 不会塞满默认项。
  源码位置: packages/node-modules-inspector/src/app/state/query.ts:77-91

- **启动守卫**：模块级 `_isQuerySetup` 标志保证 `setupQuery()` 在 Vue 应用热重载或多次挂载时只绑定一次监听——否则重复 watch 会让回环数量翻倍。
  源码位置: packages/node-modules-inspector/src/app/state/query.ts:93-99

- **push vs replace 的判定逻辑**：监听源是 `() => [query, query.selected]`（一个二元组），回调里对比 `n[1] !== o[1]`——只有"选中项"变化才算"导航事件"，走 `router.push` 产生历史条目；否则（纯筛选/开关变化）走 `history.replaceState` 原地替换。这是权衡 3 的代码落点。
  源码位置: packages/node-modules-inspector/src/app/state/query.ts:105-115

- **反向防震**：另一条 `watch(route.hash)` 在浏览器前进/后退触发时，**用 `ignoreUpdates` 闭包**把 hash 解析回 query——这一步是权衡 1 的代码落点。如果不忽略，反向赋值会立刻触发"query→hash"那条 watch 再写一次 hash，形成死循环。
  源码位置: packages/node-modules-inspector/src/app/state/query.ts:117-124

- **筛选→URL 用 200ms 防抖**：`debouncedWatch` 让连续的筛选状态变化只产生一次 URL 写入。
  源码位置: packages/node-modules-inspector/src/app/state/query.ts:126-132

- **`current.ts` 的职责**：把"选中项的规格字符串"与"节点对象"互转——读时用规格去主载荷 Map 查节点，写时取节点规格赋给 URL。这是"选中节点也走 URL"权衡的对应消费方。
  源码位置: packages/node-modules-inspector/src/app/state/current.ts:6-22

- **`ui.ts` 复用 `selected` 字段表达面板状态**：用 `~settings` 和 `~filters` 两个"伪规格"表示"设置面板打开"、"筛选面板打开"——避免再增加独立的 URL 键，复用既有通道。这是一种工程层面的"字段重载"。
  源码位置: packages/node-modules-inspector/src/app/state/ui.ts:5-26

- **`isSidepanelCollapsed` 是只读派生**：从 setting（localStorage）+ 两个面板开关计算，**不参与 URL 绑定**——因为侧栏折叠属于"个人长期偏好"，不属于"可分享视图"。
  源码位置: packages/node-modules-inspector/src/app/state/ui.ts:28-30

- **维护者操作面板的一组字段直接读写 `query`**：`actionSort`、`actionAll`、`actionIncludePublint`、`actionLatestOnly`、`selectedAuthors` 等都通过 `computed({get, set})` 把 URL 字段映射成强类型值（boolean / 具体枚举）。值得注意的是**默认值规则不统一**：`actionIncludePublint` 默认是 `true`（字符串 `'false'` 才表示关闭），即"未出现该键 = 开启"——这是为了让默认 URL 更短。
  源码位置: packages/node-modules-inspector/src/app/state/maintainer-actions.ts:47-94

## 关键调用链

启动期（一次性）：
```
app.vue setup → setupQuery() → parseQuery(location.hash)
             → queryToFilters() → 写入 filters.state
             → 绑定 3 条 watch（query→hash、route.hash→query、filters→query）
```
源码位置: packages/node-modules-inspector/src/app/app.vue:14, packages/node-modules-inspector/src/app/state/query.ts:95-133

运行期——状态→URL：
```
用户改 filters.state（勾选/搜索）
  → debouncedWatch(200ms) → filtersToQuery() → 写 query.*
  → ignorableWatch 触发 → stringifyQuery() → history.replaceState
```
源码位置: packages/node-modules-inspector/src/app/state/query.ts:105-132

运行期——URL→状态（浏览器后退/前进、外部链接）：
```
hashchange → route.hash 变 → watch 触发
  → ignoreUpdates(() => Object.assign(query, parseQuery(hash)))
  → 静默赋值（不触发 query→hash 那条 watch）
  → queryToFilters() 不在此分支调用；filters 由 debouncedWatch 反向同步至 query，
    但因 query 已是正确的"目标态"，需另外的链路把 query→filters 落地。
```
注：代码里 `route.hash` → `query` 这条链并未显式把变化下沉到 `filters.state`——**这是潜在的不对称**：前进/后退触发的 URL→query 不会自动应用到 filters 对象。推测是依赖 Vue 的 reactive 传播（query→filters 的某种下游 computed 触发），或仅限于"selected/action 系列"这类**只在 query 上消费**的字段（这些字段通过 `current.ts`/`maintainer-actions.ts` 的 computed 直接读 query，不经过 filters 中转）。filters 类字段（如 `excludes`、`modules`）的 URL→filters 反向传播链在代码中**未显式闭合**，可能是一个未理解点（见末节）。

源码位置: packages/node-modules-inspector/src/app/state/query.ts:117-124

## 源码摘录（带行号，全文累计 ≤ 30 行）

摘录 1：序列化（kebab 转换 + 数组连接 + 默认值省略）
```ts
// query.ts:34-44
function kebabCase(str: string) {
  return str.replace(/([a-z])([A-Z])/g, (_, a, b) => `${a}-${b.toLowerCase()}`)
}
function stringifyQuery(object: QueryOptions): string {
  const entries = Object.entries(object)
    .map(i => [kebabCase(i[0]), Array.isArray(i[1]) ? i[1].join('+') : i[1]])
    .filter(x => !!x[1]) as [string, string][]
  const query = new URLSearchParams(entries)
  return query.toString()
}
```

摘录 2：双向 watch 的核心（push/replace 二分 + 防循环忽略器）
```ts
// query.ts:105-124
const { ignoreUpdates } = ignorableWatch(
  () => [query, query.selected],
  (n, o) => {
    const hash = `#${decodeURIComponent(stringifyQuery(query)).replace(/^\?/g, '')}`
    if (n[1] !== o[1])
      router.push({ path: route.path, hash })
    else
      history.replaceState(history.state, '', hash)
  },
  { deep: true, flush: 'post' },
)
watch(
  () => route.hash,
  () => {
    ignoreUpdates(() => {
      Object.assign(query, parseQuery(location.hash.replace(/^#/, '')))
    })
  },
)
```

## 易混淆 / 边界 / 推断

- **事实**：`parseQuery` 第 51-55 行的 `value === null ? 'true' : ...` 分支是**死代码**——`URLSearchParams.entries()` 返回值类型是 `[string, string]`，永不为 null。可能是从某个旧 API 迁移时残留的防御代码。
  源码位置: packages/node-modules-inspector/src/app/state/query.ts:46-58

- **事实**：`flush: 'post'` 让 query→hash 的写延迟到 DOM 更新之后——避免同步写 hash 触发的浏览器额外 reflow 与 Vue 渲染抢同一帧。
  源码位置: packages/node-modules-inspector/src/app/state/query.ts:114

- **事实**：`history.replaceState(history.state, '', hash)` 显式传入 `history.state`——保留当前历史条目的状态对象（Vue Router 用来记 scroll position 等），不擦除。这是个容易被忽略的细节，写错了会丢失"后退后的滚动位置"。

- **事实**：`isDeepEqual` 只做"数组逐元素严格相等"的浅比较，不支持对象/嵌套。这与筛选值的实际类型集合（string | string[] | boolean）刚好匹配——是一个**最小够用**的相等判定，不是通用 deep equal。
  源码位置: packages/node-modules-inspector/src/app/state/filters.ts:150-159

- **事实**：维护者操作面板的几个布尔字段（`actionIncludePublint`、`actionLatestOnly`）默认是 `true`——即"URL 中不出现该键 = 开启"。这是一种**反向编码**：把默认行为映射到"键缺席"，非默认行为映射到"键存在且值为 `'false'`"。导致读取逻辑是 `query.x !== 'false'`（看起来反直觉）。
  源码位置: packages/node-modules-inspector/src/app/state/maintainer-actions.ts:82-94

- **推断**：`route.hash` → `query` 的反向链**只覆盖 query 自身字段**；若 URL 里包含 `?excludes=foo`（一个 filter 类字段），用户从外部链接进入时，启动期的 `queryToFilters()`（query.ts:100）会把 filters 初始化正确，但**运行中**用户如果手动改 URL（前进/后退到含不同 filters 的状态），代码不会再次调用 `queryToFilters`——可能造成 filters 与 URL 临时不同步。这或许是有意为之（认为运行时不会出现"URL 中 filters 字段变化但 query 不变"的场景），也可能是边界 bug。**标注为推断，未验证**。

- **未理解**：`stringifyQuery` 的返回值有时以 `?` 开头（URLSearchParams 默认），代码用 `.replace(/^\?/g, '')` 去掉——为何不直接构造 hash 字符串、而要走 URLSearchParams 再修剪？推测是为了**免费复用 URLSearchParams 的 `+`/`%` 编码**（保证特殊字符安全），但收益与可读性代价之间的权衡并不显然。
  源码位置: packages/node-modules-inspector/src/app/state/query.ts:108

- **事实**：`install` 字段用于 WebContainer 落地页：把"用户想安装的包名列表"用 `+` 连接进 URL（如 `?install=foo+bar`），让用户能分享"在浏览器里跑装这两个包"的链接。`+` 在落地页里被还原为空格。
  源码位置: packages/node-modules-inspector/src/app/webcontainer/Landing.vue:11,33
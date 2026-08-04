# 路由位置与 URL 解析 · 源码精读

## 给 Writer 的教学钩子（必填，8 子项缺一不可）

- **用户痛点 / 场景**：用户连点同一个链接、或代码里重复 `push` 同一个路由，如果没有「我要去的地方就是我现在待的地方」这层判定，每次都会重走整套导航（守卫询问、组件拉取、滚动计算），既慢又会触发守卫里的副作用（如发请求）。更隐蔽的是：同一个位置可能有许多种 URL 写法（别名、重定向、`/a/1` 写成 `/a/01`），靠比 URL 字符串根本认不出「其实是同一处」。此外应用刚启动时还没有「上一个路由」，守卫里的 `from` 该是什么、又怎么识别「这是首次进入」？

- **一句话核心思想**：把「同一个路由位置」定义成「匹配到同一条路由记录 + 参数 / 查询 / 锚点全等」，而不是「URL 字符串相等」，并据此短路重复导航、用一个固定单例对象标识首次导航。

- **设计动机（为什么需要它）**：路由器每次导航都要回答两件事——(a) 目标位置是不是就是当前位置？(b) 这是不是首次导航？回答 (a) 才能短路（省掉守卫 / 组件 / 滚动整套流程，仅保留滚动到同锚点的副作用），回答 (b) 守卫才能给出合理的 `from`。要回答 (a) 就不能比字符串，必须比「路由语义」。**编码 / 查询串怎么解析的原理（已在第 1 章『URL 分段编码与查询串』讲透，本章只看它的新侧面：解析层不自己编码，而是把「查询序列化 / 反序列化」函数作为参数注入进来，location 层只负责三段切分与路由级相等语义——这是把编码责任彻底倒置出去的依赖注入。）**

- **关键权衡（本 Atlas 核心；本章机制丰富，列 4 条）**：
  1. **手工 `indexOf` 切分 URL，不用浏览器内置的 `URL` / `URLSearchParams` → 换来约 2～5 倍的解析速度（导航是热路径，每次 push/replace 都要跑）→ 代价是要亲手处理 `#` 与 `?` 的先后边界**：当 `?` 出现在 `#` 之后，那个 `?` 属于 hash 片段、不是查询串（如 `/foo#hash?x=1` 没有 query）。
  2. **「同一位置」用末端 matched record 的引用相等判定，而非路径 / 名字字符串 → 换来别名、重定向、各种 URL 写法都能被正确识别为「同一处」→ 代价是必须保证 matched 链由匹配表按确定方式构建（祖先链），且两端 matched 长度相等时才去比末端那条 record**。
  3. **查询串的相等委托给「序列化后再比字符串」，不手写查询对象的深比较 → 换来 `{a:'1'}` 与 `{a:['1']}` 这种「单值 ≡ 单元素数组」自然等价（复用了第 1 章的序列化语义），也免去维护一套深比较 → 代价是每次比较都要跑一次序列化（开销可忽略，且本就在导航热路径之外的关键判定上）。**
  4. **首次导航用一个固定的「初始位置」单例对象当哨兵，靠引用相等识别 → 换来守卫里一行 `from === START_LOCATION` 就能判断首次进入、且天然可跨 realm → 代价是该对象必须作为全局唯一单例导出（任何地方比较的都是同一个引用）。**

- **最小心智模型（3～7 步）**：
  - **URL 字符串 → 路由位置（拆解）**：
    1. 先定位 `#`，再定位 `?`；
    2. 若 `?` 落在 `#` 之后，判定它属于 hash、视作没有查询段；
    3. 按 `?` / `#` 把字符串切成三段：路径、含 `?` 的查询段、含 `#` 的锚段；
    4. 把查询段（去掉前导 `?`）交给注入的查询解析函数——本层不碰编码；
    5. 把路径里的 `.` / `..` 解析成绝对路径（双指针：在「当前路径」段数组上退格、在「目标」段数组上前进，遇普通段即停）；
    6. 拼回完整路径 = 路径 + 查询段 + 锚段。
  - **两个路由位置 → 是否同一处（语义相等）**：两端 matched 链等长 → 比末端 record 的引用（别名归一到原始 record）→ 比 params 结构（单值 ≡ 单元素数组）→ 比查询串序列化后的字符串 → 比锚段字符串，**五关全过**才算「同一处」。

- **最小原理演示（替代旧「复刻范围」）**：
  - **应演示**：一个**小到只表达核心思想**的从零实现（几十行 TS 即可），分两幕——
    第一幕演「拆解」：实现手工三段切分，**故意构造 `?` 在 `#` 之后的输入**，证明朴素切分会误把 hash 里的 `?` 当 query、而边界判定不会；再把查询解析做成**注入参数**（演示依赖倒置：换个解析函数，切分逻辑不变）。
    第二幕演「语义相等」：构造两个 **URL 字符串不同、但路由语义相同**的位置（同一末端 record、params 一个写成标量一个写成单元素数组、query 顺序不同），证明 `isSameRouteLocation` 返回 true，而朴素字符串比较返回 false——**这一行演示的就是「权衡 2 + 3」**。
    每一行都要对应上面某个原理点（切分边界 / 注入 / 引用相等 / 单值≡数组 / 序列化比 query）。
  - **应故意省略**：完整 `RouteRecord` / matched 祖先链是怎么由匹配表构建的（那是匹配表章）、真正的分段编码与 null/undefined 语义（第 1 章已讲）、`stripBase` 的 base 剥离（history 章衔接，一句带过）、`NEW_stringifyURL` 的模板字面量类型重载、devtools / 类型泛型。
  - **演示载体建议**：**首选 TS/JS**。本章核心（字符串手工切分、相对路径双指针、语义相等判定）全是纯算法 / 数据结构，TS/JS 能忠实演透，配最小 `package.json` 即可 `node`/`bun` 跑通；本 Atlas 产物本身是 JS 生态的 VitePress 站点，TS/JS 演示对读者最友好。**无需 Vue 运行时**——matched record 在演示里用一个普通对象占位即可，不依赖响应式或组件树。一句话：载体服务于「演透原理」，本章没有任何 TS/JS 讲不透的机制，坚决用 TS/JS。

- **正文不宜展开的细节**：`NEW_stringifyURL` 的 `` `/${string}` `` 模板字面量类型重载（属类型安全路由演进，可裁剪）；`for (var key in a)` 的旧写法与 `// TODO: update to ?.valueOf()` 等待 ES2020 的注释；`query = {}` 处 `// TODO: next major, use Object.create(null)` 的原型链优化方向；`stripBase` 大小写不敏感剥离（属 history 接入细节）；`__DEV__` 下的诊断码告警（`diagnostics.VUE_ROUTER_R0070`）。

- **推荐的一个执行轨迹例子**：
  - 拆解：输入 `/foo#hash?x=1`、当前位置 `/` → `?` 在 `#` 后 → 查询段为空 → 路径 `/foo`、锚 `#hash?x=1`、完整路径 `/foo#hash?x=1`。
  - 相等短路：`from`（当前在 `/users`、末端 record R、params `{id:'1'}`）与 `target`（`/users`、同一 R、params `{id:['1']}`、query 顺序不同）→ 序列化后查询串相同、单值≡单元素数组 → `isSameRouteLocation` 返回 true → 触发 `NAVIGATION_DUPLICATED`，跳过整套导航、仅保留滚动。

> 以上钩子供 Writer 写「动机 → 核心思想 → 心智模型 → 关键权衡 → 原理演示」；下面事实部分供核对，不要被 Writer 当目录照抄。

## 概念要点

- **拆解产物结构**：`parseURL` 返回 `{ fullPath, path, query, hash }` 四字段，其中 `hash` 已 `decode`、`query` 由注入的 `parseQuery` 产出、`fullPath = path + searchString + hash`。`fullPath` 不能直接用入参字符串，因为入参可能是相对路径、需先解析成绝对路径。源码位置: packages/router/src/location.ts:16-21, 97-104
- **`?` 在 `#` 之后的边界修正**：先取两处下标，若 `searchPos > hashPos` 则把 `searchPos` 置 -1，确保 hash 片段里的 `?` 不被当成查询串起点（`/foo#hash?query` 无 query）。源码位置: packages/router/src/location.ts:59-64
- **查询解析是注入参数（依赖倒置）**：`parseURL` 不自己解析查询串，签名是 `parseURL(parseQuery, location, currentLocation)`，把编码 / 查询语义整个委托给外部函数——这就是「编码原理留给第 1 章、本层只切分」的代码体现。源码位置: packages/router/src/location.ts:47-48, 75-78
- **空路径的相对解析**：当入参是 `?foo=f` 或 `#thing`（无 path 段），`path` 为 `undefined`，`resolveRelativePath` 拿到的 `to` 是空串或纯查询 / 锚，此时 `path ||= location.slice(0, hashPos)` 兜底，再相对 `currentLocation` 解析。源码位置: packages/router/src/location.ts:81-95
- **路由级相等的五个合取条件**：`isSameRouteLocation` 用 `&&` 串起「a 有 matched → 两端 matched 等长 → 末端 record 相等 → params 结构相等 → query 序列化串相等 → hash 相等」。任一不满足即判「不同位置」。源码位置: packages/router/src/location.ts:178-188
- **只比末端 record 的前提**：比较 `matched[aLastIndex]` 与 `matched[bLastIndex]` 两个末端，之所以不逐条比祖先，是因为 matched 是从根到叶的祖先链、且已先判定「两端等长」——等长 + 末端同源隐含祖先同源。源码位置: packages/router/src/location.ts:178-184
- **别名归一到原始 record**：`isSameRouteRecord` 用 `(a.aliasOf || a) === (b.aliasOf || b)`。原始 record 的 `aliasOf` 为 undefined、所有别名的 `aliasOf` 都指向同一原始 record，故两端都规约到原始 record 再比引用。源码位置: packages/router/src/location.ts:198-203
- **params 的「单值 ≡ 单元素数组」等价**：`isSameRouteLocationParamsValue` 处理 array/scalar 的对称比较，`isEquivalentArray` 在「数组 vs 标量」时判定 `a.length === 1 && a[0] === b`——这是路由参数里 `:id=1` 可被表达成 `'1'` 或 `['1']` 的等价基础。比较用 `valueOf()` 以兼容字符串/数字包装。源码位置: packages/router/src/location.ts:218-241
- **相对路径双指针**：`resolveRelativePath` 用 `position`（在 from 段数组上退格，下限为 1 不退到根之上）与 `toPosition`（在 to 段数组上前进）双指针；遇 `.` 跳过、`..` 退格、遇普通段即 `break`，最后 `fromSegments.slice(0,position) + '/' + toSegments.slice(toPosition)` 拼接。源码位置: packages/router/src/location.ts:269-292
- **末尾 `.`/`..` 补空串对齐 `new URL()`**：若 `to` 末段是 `..` 或 `.`，向 `toSegments` push 一个空串，使 `../` 与 `..` 行为一致（保留尾斜杠），注释明说「same behavior as new URL()」。源码位置: packages/router/src/location.ts:263-267
- **首次导航哨兵**：`START_LOCATION_NORMALIZED` 是一个导出的固定对象字面量（path `/`、name undefined、matched `[]`…），靠引用相等识别首次导航；`router.ts` 里 `pendingLocation` 初值即它，`isFirstNavigation = from === START_LOCATION_NORMALIZED`。注释提到未来可能改用 Symbol。源码位置: packages/router/src/location.ts:310-321；用途: packages/router/src/router.ts:164-166, 729
- **`stringifyURL` 的条件拼接**：`path + (query && '?') + query + (hash || '')`——仅当 query 非空才补 `?`，hash 为空则省略，避免产出 `/foo?` 或 `/foo#`。源码位置: packages/router/src/location.ts:143-149

## 关键调用链

URL 入参 → `parseURL(parseQuery, location, currentRoute.value.path)` → `{ path, query, hash, fullPath }` → 进入匹配表 resolve → 得到带 `matched`/`params` 的 `RouteLocation`。
导航主循环 → `isSameRouteLocation(stringifyQuery, from, targetLocation)` → 若 true → 产出 `NAVIGATION_DUPLICATED` 失败、跳过 `navigate()`、仅 `handleScroll`。
首次识别 → `from === START_LOCATION_NORMALIZED`。
源码位置: packages/router/src/location.ts:47,173；调用方: packages/router/src/router.ts:227,274,351（parseURL）, 304（stringifyURL）, 456 与 495（isSameRouteLocation 重复短路 / 重定向死循环检测）, 729（首次导航判定）

## 源码摘录（带行号，全文累计 ≤ 30 行）

切分边界（演「权衡 1」），location.ts:59-78：
```ts
const hashPos = location.indexOf('#')
let searchPos = location.indexOf('?')
// e.g. /foo#hash?query -> has no query
searchPos = hashPos >= 0 && searchPos > hashPos ? -1 : searchPos
if (searchPos >= 0) {
  path = location.slice(0, searchPos)
  searchString = location.slice(searchPos, hashPos > 0 ? hashPos : location.length)
  query = parseQuery(searchString.slice(1)) // 注入：本层不编码
}
```

路由级相等五条件（演「权衡 2+3」），location.ts:178-188：
```ts
const aLastIndex = a.matched.length - 1
const bLastIndex = b.matched.length - 1
return (
  aLastIndex > -1 &&
  aLastIndex === bLastIndex &&
  isSameRouteRecord(a.matched[aLastIndex], b.matched[bLastIndex]) &&
  isSameRouteLocationParams(a.params, b.params) &&
  stringifyQuery(a.query) === stringifyQuery(b.query) &&
  a.hash === b.hash
)
```

别名归一 + 单值≡数组（演「权衡 2 的别名 / params 等价」），location.ts:202 与 237-241：
```ts
return (a.aliasOf || a) === (b.aliasOf || b)            // 别名归一到原始 record
// ---
function isEquivalentArray<T>(a: readonly T[], b: readonly T[] | T): boolean {
  return isArray(b)
    ? a.length === b.length && a.every((v, i) => v === b[i])
    : a.length === 1 && a[0] === b                       // [x] ≡ x
}
```

相对路径双指针（演「心智模型第 5 步」），location.ts:269-292 节选：
```ts
let position = fromSegments.length - 1
for (toPosition = 0; toPosition < toSegments.length; toPosition++) {
  segment = toSegments[toSegments[toPosition]] /* = toSegments[toPosition] */
  if (segment === '.') continue
  if (segment === '..') { if (position > 1) position-- }
  else break
}
return fromSegments.slice(0, position).join('/') + '/' + toSegments.slice(toPosition).join('/')
```

## 易混淆 / 边界 / 推断

- **事实**：`parseURL` 内 `query` 初值为普通对象 `{}`，注释 `// TODO: in next major, use Object.create(null)` 指明未来改用无原型对象以避免键名撞到原型属性。源码位置: packages/router/src/location.ts:53-54
- **事实**：`parseURL` 对 hash 做 `decode`（返回的 `hash` 已解码），而 `stringifyURL` 侧（`NEW_stringifyURL`）对 hash 做 `encodeHash`——解码在解析端、编码在序列化端，两边对称。源码位置: packages/router/src/location.ts:102, 134
- **事实**：`stripBase` 大小写不敏感剥前缀，且剥光后返回 `'/'` 而非空串（`pathname.slice(base.length) || '/'`），属 history 接入衔接。源码位置: packages/router/src/location.ts:157-162
- **事实**：`isSameRouteLocation` 要求 `aLastIndex > -1`，即 `a` 必须有 matched；`START_LOCATION_NORMALIZED` 的 `matched` 为 `[]`，故与任何真实位置都不相等——这正合「首次导航不应被短路」的语义。源码位置: packages/router/src/location.ts:182, 318
- **推断（标注为推断）**：文件中并存 `stringifyURL` 与带 `NEW_` 前缀、且对 path 做 `` `/${string}` `` 模板字面量类型重载的 `NEW_stringifyURL`；结合 `experimental/location.ts`、`experimental_parseURL` 的存在（见 experimental/location.spec.ts），推断这是为「类型安全路由 / 新一代解析器」准备的更类型安全演进版，但本章主线（router.ts）仍用旧版 `stringifyURL`/`parseURL`。Writer 不必展开 NEW_ 版本。
- **未理解**：`NEW_stringifyURL` 是否会在后续 major 完全取代旧版、以及它与 experimental resolver 的具体衔接时间线，源码无明确说明，留待对应章节。
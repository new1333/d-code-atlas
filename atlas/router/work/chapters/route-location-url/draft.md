# 路由位置与 URL 解析

你在 `/users/1` 这个页面，手一抖又点了一次指向 `/users/1` 的链接。按直觉，什么也不该发生——你就在这儿。可路由器怎么知道「就在这儿」？

最直白的办法是比 URL 字符串：`/users/1 === /users/1`，相等就跳过。但这层判定稍一放松，一堆麻烦就冒出来：同一个用户页可以写成 `/users/1`，也能走别名 `/u/1`；参数既能写成 `id=1` 也能写成 `id=01`；查询串 `?a=1&b=2` 和 `?b=2&a=1` 明明是同一份。靠比字符串，这些「其实是同一处」的情况一个都认不出来。

所以路由器每次导航前要先回答两个问题：

- **(a) 目标位置是不是就是我现在待的地方？** 回答了才能短路——省掉守卫询问、组件拉取、滚动计算那一整套，只在确有同锚点时滚一下。
- **(b) 这是不是应用启动以来的第一次导航？** 回答了，守卫里的 `from`（「我从哪来」）才有个合理的值，否则应用刚启动时根本没有「上一个路由」。

本章就讲清这两件事背后的那块代码：怎么把一个 URL 字符串拆成路由能用的结构，又怎么判定两个结构是不是「同一处」。

---

## 底层基本件 ①：手工把 URL 切成三段

先看最底层的一块：拿到一个 URL 字符串，要产出 `{ path, query, hash, fullPath }` 四个字段。

浏览器其实白送了 `URL` 和 `URLSearchParams` 两个类干这事。为什么不直接用？因为导航是一条热路径——每次 `push` / `replace` 都要跑一遍解析。那两个通用类内部要做规范化、要分配一堆对象，对手头这个「只切三段」的小活来说太重了。

自己用 `indexOf` 切，几行就够：

```ts
const hashPos = location.indexOf('#')
let searchPos = location.indexOf('?')
// e.g. /foo#hash?query -> has no query
searchPos = hashPos >= 0 && searchPos > hashPos ? -1 : searchPos
```

注意第二行那个看似多余的条件——它是这层的命门。看 `/foo#hash?x=1` 这个串：`?` 在 `#` **后面**。这时那个 `?x=1` 属于 hash 片段，根本不是查询串。如果不做这个边界判定，朴素切分会把 hash 里的 `?x=1` 误当成 query。

> **权衡 1**：选了手工 `indexOf` 切分、不用浏览器内置的 `URL` / `URLSearchParams` → 换来约 2～5 倍的解析速度（导航是热路径，每次 push/replace 都跑）→ 代价是 `#` 与 `?` 谁先谁后的边界得自己亲手处理，`?` 在 `#` 之后时要把它视作没有查询段。这个代价不大，但漏掉就是 bug。

切完三段，`fullPath` 由 `path + searchString + hash` 拼成。这里有个细节：`fullPath` 不能直接拿入参字符串顶上，因为入参可能是相对路径（`./bar`），得先解析成绝对路径再拼。

---

## 底层基本件 ②：查询串的解析，是「外包」出去的

这里要看一个和编码有关的新侧面。编码本身——哪段 URL 保留哪些字符、`null` / `undefined` 怎么区分 `?key`（无等号）和完全省略——是第 1 章的核心，这里不重复。本章只看它带来的一个设计后果：**location 这层干脆不碰编码。**

`parseURL` 的签名长这样：`parseURL(parseQuery, location, currentLocation)`。注意 `parseQuery` 是**参数**——查询串怎么解析、怎么解码，整个交给了外面塞进来的函数。本层只管把字符串切成段落，至于每段怎么翻译，由外部决定。

打个比方：这层像个只负责「断句」的编辑，至于每句用什么词典翻译，他不管，翻译员是甲方（调用方）派来的。换个翻译员，断句逻辑一行都不用改。

这就是把编码责任整个倒置出去的写法。好处很实际：同一套切分逻辑，既能配「严格按 RFC 解码」的 `parseQuery`，也能配「对齐浏览器实际行为」的版本（第 1 章那套分段编码），切分代码完全不变。

---

## 底层基本件 ③：相对路径 `./` `../` 的双指针

如果入参是个相对路径，比如 `../bar`，就得拿「我现在在哪」当基准，把它折算成绝对路径。这一步用的是一个挺干净的双指针算法。

想象 `from = /a/b/c`，要解析 `to = ../d`。先把两端按 `/` 切成段数组：`fromSegments = ['', 'a', 'b', 'c']`、`toSegments = ['..', 'd']`。然后两个指针同时走：

- `position` 指针在 `fromSegments` 上**退格**，初值是末段下标（先把末段当成「文件名」丢掉）；
- `toPosition` 指针在 `toSegments` 上**前进**，遇到 `.` 跳过、遇到 `..` 就让 `position` 退一格、遇到普通段就 `break`。

```ts
let position = fromSegments.length - 1
let toPosition = 0
for (; toPosition < toSegments.length; toPosition++) {
  const seg = toSegments[toPosition]
  if (seg === '.') continue
  if (seg === '..') { if (position > 1) position-- }   // 不退到根之上
  else break
}
return fromSegments.slice(0, position).join('/') + '/' + toSegments.slice(toPosition).join('/')
```

走一遍 `/a/b/c` + `../d`：`position` 从 3 出发，遇到 `..` 退到 2，遇到 `d` 这个普通段 break。最后 `slice(0, 2)` = `/a`，拼上 `/d`，得到 `/a/d`。（对，不是 `/a/b/d`——因为基准 `/a/b/c` 的末段 `c` 先被当文件名丢掉了，这跟 `new URL('../d', '/a/b/c')` 的行为一致。）

那个 `position > 1` 的下限，是为了不让你退到根之上：`/a` + `../../d` 只会退到根，结果是 `/d`，不会变成乱码。

---

## 组合机制：两个位置，「同一处」怎么判

底层三块拼完了，现在看它们怎么组合出「同一位置」的判定——这是回答问题 (a)、决定要不要短路的关键。

难点在于：同一个地方，URL 写法千变万化。所以判定不能比字符串，得比**路由语义**。具体怎么比？先看一段被 `&&` 串起来的判定，它一眼就能看出整个思路：

```ts
const aLastIndex = a.matched.length - 1
const bLastIndex = b.matched.length - 1
return (
  aLastIndex > -1 &&                                              // 前置条件
  aLastIndex === bLastIndex &&                                    // 关卡 ①
  isSameRouteRecord(a.matched[aLastIndex], b.matched[bLastIndex]) && // 关卡 ②
  isSameRouteLocationParams(a.params, b.params) &&                // 关卡 ③
  stringifyQuery(a.query) === stringifyQuery(b.query) &&          // 关卡 ④
  a.hash === b.hash                                               // 关卡 ⑤
)
```

这里要先分清一个**前置条件**和**五道关卡**。`aLastIndex > -1`（a 自己得有 matched）是前置条件——没有 matched 的位置根本不参与「同一处」的比较。真正逐一比较的是后面五道关卡，全过才算同一处：

```
前置：a.matched 非空（aLastIndex > -1）？   否 ──▶ 判「不同位置」
                  │ 是
                  ▼
关卡① 两端 matched 链等长？               否 ──▶ 不同位置
                  │ 是
                  ▼
关卡② 末端 record 同源（别名都指回原始 record）？ 否 ──▶ 不同位置
                  │ 是
                  ▼
关卡③ params 结构相等（单值 ≡ 单元素数组）？ 否 ──▶ 不同位置
                  │ 是
                  ▼
关卡④ 查询串序列化后字符串相等？           否 ──▶ 不同位置
                  │ 是
                  ▼
关卡⑤ hash 字符串相等？                   否 ──▶ 不同位置
                  │ 是
                  ▼
              同一位置 ──▶ 短路导航（跳过守卫/组件/滚动，仅保留同锚点滚动）
```

逐条说一下为什么这么设计。

**关卡 ① + ② 比的是「匹配到哪条路由」，不是「URL 长什么样」。** `matched` 是从根到叶的一条祖先链（这条链怎么由匹配表构建，是后面匹配表章的事，这里不展开）。比较时只看链的**末端那条 record**——前提是关卡 ① 已经保证了两端等长。等长 + 末端同源，祖先自然同源，所以不必逐条比祖先。至于「同源」怎么判：

```ts
return (a.aliasOf || a) === (b.aliasOf || b)   // 别名都还原到原始 record 再比引用
```

原始 record 的 `aliasOf` 是 `undefined`，所有别名的 `aliasOf` 都指向同一条原始 record。两端各走一步 `aliasOf || a`，就都还原到原始 record，再比引用相等。这样一来，`/users/1` 和它的别名 `/u/1`，只要末端 record 同源，就被认成同一处。

> **权衡 2**：判定「同一处」用末端 matched record 的**引用相等**，而不是比路径或名字字符串 → 换来别名、重定向、各种 URL 写法都能被正确认成「同一处」→ 代价是 matched 链必须由匹配表按确定方式（祖先链）构建，且要先把「两端等长」这个前提判过，才去比末端那一条。

**关卡 ③ 比的是 params 的结构，而且容忍「单值 ≡ 单元素数组」。** 路由参数 `:id=1` 在内部既可以存成标量 `'1'`，也可以存成单元素数组 `['1']`，这俩语义上是一回事。所以比较时不是简单 `===`：

```ts
function isEquivalentArray(a, b) {
  return Array.isArray(b)
    ? a.length === b.length && a.every((v, i) => v === b[i])
    : a.length === 1 && a[0] === b                       // [x] ≡ x
}
```

**关卡 ④ 比的是查询串，但做法很巧：不手写 query 对象的深比较，而是各自序列化成字符串再比。** 这一招直接复用了第 1 章那套序列化语义——序列化时本就把 `{a:'1'}` 和 `{a:['1']}` 视作等价，所以「单值 ≡ 单元素数组」的等价在这里天然成立，`?a=1&b=2` 和 `?b=2&a=1` 序列化后（键排序）也自然相同。

> **权衡 3**：查询串的相等**委托给「序列化后再比字符串」**，不手写 query 对象的深比较 → 换来 `{a:'1'}` 与 `{a:['1']}` 这种「单值 ≡ 单元素数组」自然等价（白捡了第 1 章的序列化语义），也省得维护一套深比较 → 代价是每次比较都要跑一次序列化。但这点开销可以忽略——它只跑在「判定要不要短路」这一处，不在每帧都跑的热路径上。

这五道关卡全过，路由器就认定「我要去的地方就是我待的地方」，产出一次 `NAVIGATION_DUPLICATED`（重复导航），跳过整套 navigate 流程，只保留「滚动到同锚点」这一点副作用。

---

## 首次导航：一个固定对象当哨兵

最后看问题 (b)：应用刚启动，还没有「上一个路由」，守卫里的 `from` 该是什么？又怎么识别「这是第一次导航」？

答案是一个叫 `START_LOCATION` 的固定对象，全局只导出一份。有意思的是，它**不是**一个光秃秃的标记值，而是一个**完整的路由对象**——`path: '/'`、`params: {}`、`matched: []`、`query: {}`、`hash: ''`、`fullPath: '/'`、`meta: {}`，该有的字段都有。

为什么得是个完整对象？因为它一身二任：

- **首先**，它是 `currentRoute` / `pendingLocation` 的初值。应用一启动，路由器就处在这个合法的路由位置上，而不是 `null`——下游所有读 `currentRoute` 的代码都不用判空。
- **其次**，它顺手当首次导航的哨兵：守卫里一行 `from === START_LOCATION`（引用相等）就认出「这是开场第一幕」。

正因为首要职责是「当 currentRoute 的初值」，它才必须承载那些路由字段；一个光秃秃的 `Symbol` 承载不了 `path` / `params` / `matched` 这些，所以这里没有用 Symbol。

可以把它想成一枚盖了章的固定信物：全局就这一枚，谁拿出来对照的都是同一枚，一比对就知道是不是「开场第一幕」。

还有个精妙的连带效果：`START_LOCATION` 的 `matched` 是空数组 `[]`，所以回头看上面那个前置条件 `aLastIndex > -1`——它根本不满足。意思是 `START_LOCATION` 永远不会等于任何真实位置，**首次导航绝不会被误判成「重复」而短路**。这正是我们想要的语义。

> **权衡 4**：选一个**全局唯一的完整路由对象**当哨兵，而不是随便挑个标记值 → 换来它一身二任：既作 `currentRoute` / `pendingLocation` 的初值（应用一启动就处在合法路由上、无需判空），又让守卫一行 `from === START_LOCATION` 靠引用相等就认出首次导航 → 代价是它必须作为全局单例导出，任何地方的比较都得拿到**同一个引用**才有效。

---

## 把原理跑给你看

下面这份演示从零实现，两幕：第一幕演「拆解」（边界修正 + 查询解析外包 + 相对路径双指针），第二幕演「语义相等」（别名同源 + 单值≡数组 + 序列化比 query）。每行都对应上面某个原理点。

`package.json`（用 `npx tsx demo.ts` 或 `bun run demo.ts` 跑）：

```json
{
  "name": "route-location-url-demo",
  "private": true,
  "scripts": { "demo": "tsx demo.ts" },
  "devDependencies": { "tsx": "^4.0.0" }
}
```

`demo.ts`：

```ts
// ===================== 第一幕：把 URL 拆成 path / query / hash =====================

// 一个会出错的朴素切分：认定 ? 之后全是查询串、# 之后全是 hash，互不干扰
function naiveSplit(location: string) {
  const q = location.indexOf('?')
  const h = location.indexOf('#')
  const path = location.slice(0, q >= 0 ? q : h >= 0 ? h : location.length)
  return {
    path,
    searchString: q >= 0 ? location.slice(q) : '',   // 从 ? 一路切到底
    hash: h >= 0 ? location.slice(h) : '',
  }
}

// 正确切分：parseQuery 是「注入」进来的——本层只切分段落，不碰编码
function parseURL(parseQuery: (s: string) => Record<string, any>, location: string) {
  const hashPos = location.indexOf('#')
  let searchPos = location.indexOf('?')
  if (hashPos >= 0 && searchPos > hashPos) searchPos = -1   // ? 在 # 之后 → 属于 hash
  let path = '', searchString = '', hash = ''
  let query: Record<string, any> = {}
  if (searchPos >= 0) {
    path = location.slice(0, searchPos)
    searchString = location.slice(searchPos, hashPos > 0 ? hashPos : location.length)
    query = parseQuery(searchString.slice(1))              // 注入：编码语义全在外部
  } else if (hashPos >= 0) {
    path = location.slice(0, hashPos)
  } else {
    path = location
  }
  if (hashPos >= 0) hash = location.slice(hashPos)
  return { path, query, hash, fullPath: path + searchString + hash }
}

// 两个可替换的查询解析函数：切分逻辑不变，只换塞进来的「翻译员」
const parseQueryPairs = (s: string) => Object.fromEntries(new URLSearchParams(s))
const parseQueryRaw = (s: string) => ({ _raw: s })

// 相对路径 ./ ../ 的双指针
function resolveRelativePath(to: string, from: string) {
  const fromSegments = from.split('/')
  const toSegments = to.split('/')
  let position = fromSegments.length - 1, toPosition = 0
  for (; toPosition < toSegments.length; toPosition++) {
    const seg = toSegments[toPosition]
    if (seg === '.') continue
    if (seg === '..') { if (position > 1) position-- }
    else break
  }
  return fromSegments.slice(0, position).join('/') + '/' + toSegments.slice(toPosition).join('/')
}

// ===================== 第二幕：「同一位置」的语义相等判定 =====================

const R = { path: '/users/:id' } as any              // 用普通对象充当 record（不依赖 Vue / 匹配表）
const R_alias = { aliasOf: R } as any                // 别名，指回原始 record

function isSameRouteRecord(a: any, b: any) {
  return (a.aliasOf || a) === (b.aliasOf || b)       // 两端都还原到原始 record 再比引用
}
function sameParamValue(a: any, b: any) {
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((v, i) => v === b[i])
  if (Array.isArray(a)) return a.length === 1 && a[0] == b   // [x] ≡ x
  if (Array.isArray(b)) return b.length === 1 && b[0] == a   // x ≡ [x]
  return a == b
}
function isSameParams(a: Record<string, any>, b: Record<string, any>) {
  const ak = Object.keys(a), bk = Object.keys(b)
  if (ak.length !== bk.length) return false
  return ak.every((k) => k in b && sameParamValue(a[k], b[k]))
}
function stringifyQuery(q: Record<string, any>) {    // 极简序列化，只为「比字符串」服务
  return Object.keys(q).sort().map((k) => `${k}=${q[k]}`).join('&')
}
function isSameRouteLocation(a: any, b: any) {
  const aLast = a.matched.length - 1, bLast = b.matched.length - 1
  return (
    aLast > -1 &&                                            // 前置：a 必须有 matched
    aLast === bLast &&                                       // 关卡① 等长
    isSameRouteRecord(a.matched[aLast], b.matched[bLast]) && // 关卡② 末端 record 同源
    isSameParams(a.params, b.params) &&                      // 关卡③ params
    stringifyQuery(a.query) === stringifyQuery(b.query) &&   // 关卡④ 查询串
    a.hash === b.hash                                        // 关卡⑤ hash
  )
}

// 首次导航哨兵：一个完整的固定单例对象
const START_LOCATION = { path: '/', params: {}, matched: [], query: {}, hash: '', fullPath: '/', meta: {} }
const isFirstNavigation = (from: any) => from === START_LOCATION

// ===================== 跑起来看 =====================
console.log('--- 切分边界：? 在 # 之后 ---')
const tricky = '/foo#hash?x=1'
console.log('朴素切分误判 query:', naiveSplit(tricky).searchString)          // '?x=1' —— 错
console.log('正确切分:        ', parseURL(parseQueryPairs, tricky))          // query 为空

console.log('\n--- 切分不变，只换注入的解析函数 ---')
console.log(parseURL(parseQueryPairs, '/a?b=2&c=3').query)                   // { b:'2', c:'3' }
console.log(parseURL(parseQueryRaw,   '/a?b=2&c=3').query)                   // { _raw:'b=2&c=3' }

console.log('\n--- 相对路径双指针 ---')
console.log('/a/b/c + ./d     =>', resolveRelativePath('./d', '/a/b/c'))     // /a/b/d
console.log('/a/b/c + ../d    =>', resolveRelativePath('../d', '/a/b/c'))    // /a/d
console.log('/a    + ../../d  =>', resolveRelativePath('../../d', '/a'))     // /d（不退到根之上）

console.log('\n--- URL 不同、路由语义相同 ---')
const from = { matched: [R], params: { id: '1' }, query: { a: '1', b: '2' }, hash: '' }
const target = {
  matched: [R_alias],         // 走了别名 → URL 可能写成 /u/1
  params: { id: ['1'] },      // 单元素数组 ≡ 标量
  query: { b: '2', a: '1' },  // 顺序不同
  hash: '',
}
console.log('朴素比字符串:  ', '/users/1' === '/u/1')                        // false
console.log('语义相等判定:  ', isSameRouteLocation(from, target))            // true  → 触发短路

console.log('\n--- 首次导航不会被误短路 ---')
const firstTarget = { matched: [R], params: { id: '1' }, query: {}, hash: '' }
console.log('START_LOCATION 与任意位置:', isSameRouteLocation(START_LOCATION, firstTarget)) // false
console.log('靠引用相等识别首次:      ', isFirstNavigation(START_LOCATION))                 // true
```

执行轨迹正是开篇设想的那一幕：`target` 的 URL 字符串和 `from` 不同（朴素比较 `false`），但语义相等判定返回 `true`，于是这次「重复」导航被短路掉；而 `START_LOCATION` 因为 `matched` 为空，过不了前置条件，首次导航照常进行。

---

## 回顾：四条权衡一览

| # | 选择 | 换来 | 代价 |
|---|------|------|------|
| 1 | 手工 `indexOf` 切分，不用 `URL` / `URLSearchParams` | 2～5 倍解析速度（热路径） | 自己处理 `#` / `?` 谁先谁后的边界 |
| 2 | 「同一处」用末端 matched record 的引用相等判定 | 别名、重定向、各种 URL 写法都认成同一处 | matched 链须由匹配表确定构建，且先判两端等长 |
| 3 | 查询串相等委托给「序列化后比字符串」 | 单值≡单元素数组自然等价、免写深比较 | 每次比较跑一次序列化（开销可忽略） |
| 4 | 用全局唯一的完整路由对象当首次导航哨兵 | 一身二任：currentRoute 初值 + 一行 `from === START_LOCATION` | 必须全局单例导出，比较须同一引用 |

四条合起来，回答了开篇那两个问题：(a) 比「路由语义」而非字符串，才能短路重复导航；(b) 一个固定单例对象，既撑起初值又当哨兵，才让首次导航有个合理的 `from`。

---

本章判定「同一处」靠的是末端 record 的引用相等——但这条 record 是怎么从你写的路径模式（`:param`、`*` 通配、自定义正则）编译出来的？多条模式撞车时，又凭什么判定谁优先？这正是下一章「路径模式编译与优先级评分」要拆开讲的。
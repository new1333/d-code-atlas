---
title: 路由位置与 URL 解析
---

# 路由位置与 URL 解析

> 本章属于 primitive 层。前置：URL 分段编码与查询串。
> 学完你能：用一句话讲清「为什么路由器要把"同一个位置"定义成 matched record 引用相等 + params 结构 + 序列化后的 query/hash，而不是 URL 字符串相等」。

## 1. 为什么需要它

上一章把 URL 的编码原理讲透——按段细分保留字符集、用类型区分 `?key` 与完全省略，并把「查询串怎么序列化 / 反序列化」做成了独立函数。本章接过接力棒：location 层不再自己编码，而是把 `parseQuery` / `stringifyQuery` 作为参数注入进来，自己只负责三段切分与路由级相等语义。

具体场景：用户连点同一个链接、或代码里重复 `router.push('/users/1')`。如果没有「我要去的就是我现在的位置」这层判定，每次都会重走整套导航——守卫询问、组件拉取、滚动计算，既慢又会触发守卫里的副作用（发请求、埋点）。

更隐蔽的是同一个位置有许多种 URL 写法：别名 `/profile` 与 `/me`、重定向、`/a/1` 写成 `/a/01`、`?a=1&b=2` 与 `?b=2&a=1`、params 写成标量 `'1'` 或单元素数组 `['1']`——比 URL 字符串根本认不出「其实是同一处」。

此外应用刚启动时还没有「上一个路由」，守卫里的 `from` 该是什么？又怎么识别「这是首次进入」？

回答这两个问题就是 location 层的全部职责：把 URL 字符串拆成 path / query / hash 三段；给出「两个位置是否同一处」的语义；给首次导航一个固定身份。

## 2. 核心思想

把「同一个路由位置」定义成「匹配到同一条原始路由记录 + 参数 / 查询 / 锚点全等」，而非 URL 字符串相等；首次导航用一个固定单例对象当哨兵。

## 3. 心智模型

URL 字符串进到路由器时要走两步：先切分，再判定相等。

### 3.1 URL 字符串 → 路由位置

```
1. 定位 # 的位置 hashPos
2. 定位 ? 的位置 searchPos
3. 若 ? 落在 # 之后 → 那个 ? 属于 hash 片段 → 把 searchPos 置 -1
4. 按 ? / # 切三段：path / search / hash
5. 把 search 段（去掉前导 ?）交给注入的 parseQuery —— 本层不碰编码
6. 把路径里的 . / .. 用双指针解析成绝对路径
7. fullPath = path + (query 非空时补 ?) + query 序列化 + hash
```

第 3 步是边界修正：URL 规范里 hash 后面的所有字符都是 hash 片段，包括看起来像查询串的 `?x=1`——`/foo#hash?x=1` 没有 query。浏览器内置的 `URL` 已经替你处理了这条规则，但手工 `indexOf` 没有。

第 5 步是依赖倒置：本层不解析查询串，只把 `parseQuery` 函数当作参数吃进来。换个 parseQuery，切分逻辑不变——上一章的编码原理就以此方式被彻底倒置出去。

### 3.2 两个路由位置 → 是否同一处

```
两端 matched 链等长
→ 比末端 record 的引用（别名归一到原始 record）
→ 比 params 结构（单值 ≡ 单元素数组）
→ 比查询串序列化后的字符串
→ 比锚段字符串
```

五关全过才算「同一处」。每一关都对应一类「URL 字符串不同但语义相同」的情形：末端 record 相等覆盖别名与重定向；params 结构相等覆盖 `'1'` 与 `['1']`；query 序列化串相等覆盖 `?a=1&b=2` 与 `?b=2&a=1`；hash 字符串相等直白，但要让上面所有相等都通过后才有意义。

## 4. 关键权衡

### 用手工 indexOf 切分换解析性能，代价是亲手处理 # 与 ? 的先后

导航是热路径——每次 push / replace 都要跑一次 parseURL。浏览器内置的 `URL` / `URLSearchParams` 内部要做完整的 RFC 解析、规范化、URL 类实例化，开销在每次导航上叠加。手工 `indexOf('#')` 再 `indexOf('?')` 切三段，能拿到约 2～5 倍的速度提升。

代价是必须亲手处理一个边界：当 `?` 出现在 `#` 之后，那个 `?` 属于 hash 片段、不是查询串。`/foo#hash?x=1` 的 query 应为空。手工代码靠一行 `searchPos = hashPos >= 0 && searchPos > hashPos ? -1 : searchPos` 修正这条边界——浏览器内置 `URL` 默认就这么做，而你用 `indexOf` 切分时这条规则不会自动生效。

**本质矛盾**：性能 vs 正确性的全面性。手工快但只覆盖你自己想到的边界，内置覆盖全但慢。热路径上选前者，但要为每条规则亲手负责。

### 用末端 matched record 引用相等判定"同一处"，换来别名与重定向的语义统一

如果比 URL 字符串，别名 `/profile` 与 `/me` 永远不会被识别为同一处；比路径也不行，重定向会把 `/old` 变成 `/new` 但其实是同一个组件页；比路由名？别名有自己的 name。

用「末端 matched record 的引用相等」就能让所有别名都归一到原始 record：`(a.aliasOf || a) === (b.aliasOf || b)`。原始 record 的 aliasOf 为 undefined，所有别名都指向同一原始 record，两端归一再比引用，所有别名形式自然等同。

代价是必须保证 matched 链由匹配表按确定方式构建——祖先链稳定、末端 record 不变。这一前置条件本章不解决，是后面匹配表章的事。本章只要求两端 matched 链等长时才去比末端那条 record：等长 + 末端同源隐含祖先同源。

**本质矛盾**：同一性应建立在语义层（路由记录）还是字面层（字符串）。路由器的全部合理性来自前者——这正是它能跨「同一处的无数 URL 写法」成立的关键。

### 把查询串的相等委托给序列化后再比字符串

比两个 query 对象的「结构相等」有两种实现：手写深比较 vs 序列化后比字符串。

手写深比较要处理 `a.length === b.length && a.every(...)`、键顺序、单值与数组互转……相当于把第 1 章的查询语义复刻一遍。

序列化后比字符串把所有这些交给 `stringifyQuery`：单值与单元素数组的等价、键值编码、键顺序问题，全在序列化函数里解决。`{a:'1'}` 与 `{a:['1']}` 在 stringifyQuery 看来都是 `a=1`；`{a:1,b:2}` 与 `{b:2,a:1}` 在「按 key 排序」的 stringifyQuery 看来都是 `a=1&b=2`。

代价是每次比较都要跑一次 stringifyQuery。但这步发生在「重复导航短路」之前——一旦短路成功就省掉了整套守卫与组件开销，序列化这点开销远小于换来。

**本质矛盾**：结构比较 vs 规范化串比较。当规范化规则已被序列化函数封装好时，复用它比复刻一套深比较更不容易出错。

### 用固定单例对象标识首次导航

应用刚启动、第一次导航时，没有「上一个路由」。守卫里的 `from` 该是什么？null？一个空对象 `{}`？

用一个导出的固定对象字面量 `START_LOCATION_NORMALIZED`（path: `'/'`、name: undefined、matched: `[]`），所有地方比较的都是这同一个引用。守卫里一行 `from === START_LOCATION_NORMALIZED` 即可识别首次进入，且天然可跨 realm（不同 iframe / worker 也能识别同一引用）。

代价是该对象必须作为全局唯一单例导出——任何模块拿到的都得是同一个引用，不能有「另一个等价的初始位置」。

配合上面的五条件相等判定，`START_LOCATION` 的 matched 为 `[]`，永远不与任何真实位置相等（aLastIndex 永远是 -1），这正合「首次导航不应被短路」的语义。

**本质矛盾**：识别"空"该用特殊值（哨兵）还是用空状态（如 null）。哨兵换来可携带语义（path / '/'、matched []、跨 realm），null 只代表"什么都没有"。

## 5. 最小原理演示

下面一段几十行的 TS 演透上面四个原理点：手工切分 + 边界修正 + 注入 parseQuery + 引用相等 + 序列化比 query + 单值≡数组 + 哨兵。

```ts
type RouteRecord = { name: string; aliasOf?: RouteRecord }
type RouteLocation = {
  path: string
  query: Record<string, string | string[]>
  hash: string
  params: Record<string, string | string[]>
  matched: RouteRecord[]
}

// 第一幕：手工切分。parseQuery 作为参数注入——本层不碰编码细节
function parseURL(
  parseQuery: (s: string) => Record<string, string | string[]>,
  location: string
): { path: string; query: Record<string, string | string[]>; hash: string } {
  const hashPos = location.indexOf('#')
  let searchPos = location.indexOf('?')
  // 边界修正：? 落在 # 之后，那个 ? 属于 hash、不是 query
  if (hashPos >= 0 && searchPos > hashPos) searchPos = -1

  let path = ''
  let query: Record<string, string | string[]> = {}
  let hash = ''

  if (searchPos >= 0) {
    path = location.slice(0, searchPos)
    const searchEnd = hashPos > 0 ? hashPos : location.length
    query = parseQuery(location.slice(searchPos + 1, searchEnd))
  } else if (hashPos >= 0) {
    path = location.slice(0, hashPos)
  } else {
    path = location
  }
  if (hashPos >= 0) hash = location.slice(hashPos)
  return { path, query, hash }
}

// 第二幕：路由级相等。matched 末端引用 + 序列化比 query + 单值≡数组
function isSameRouteRecord(a: RouteRecord, b: RouteRecord): boolean {
  return (a.aliasOf || a) === (b.aliasOf || b) // 别名归一到原始 record
}

function isEquivalentArray(a: readonly string[], b: string | string[]): boolean {
  return Array.isArray(b)
    ? a.length === b.length && a.every((v, i) => v === b[i])
    : a.length === 1 && a[0] === b // ['1'] ≡ '1'
}

function isSameParams(
  a: Record<string, string | string[]>,
  b: Record<string, string | string[]>
): boolean {
  const aKeys = Object.keys(a)
  const bKeys = Object.keys(b)
  if (aKeys.length !== bKeys.length) return false
  return aKeys.every(k => {
    const av = a[k], bv = b[k]
    return Array.isArray(av)
      ? isEquivalentArray(av, bv)
      : Array.isArray(bv)
      ? isEquivalentArray(bv, av)
      : av === bv
  })
}

function isSameRouteLocation(
  stringifyQuery: (q: Record<string, string | string[]>) => string,
  a: RouteLocation,
  b: RouteLocation
): boolean {
  const aLast = a.matched.length - 1
  const bLast = b.matched.length - 1
  return (
    aLast > -1 &&
    aLast === bLast &&
    isSameRouteRecord(a.matched[aLast], b.matched[bLast]) &&
    isSameParams(a.params, b.params) &&
    stringifyQuery(a.query) === stringifyQuery(b.query) &&
    a.hash === b.hash
  )
}

// 哨兵：全局唯一单例标识首次导航
const START_LOCATION: RouteLocation = {
  path: '/', query: {}, hash: '', params: {}, matched: [],
}

// —— 验证：边界修正 ——
// 朴素 indexOf('?') 会把 ?x=1 当 query；边界判定认出它在 # 之后
const r1 = parseURL(() => ({ wouldBe: 'wrong' }), '/foo#hash?x=1')
console.log(r1.path, r1.hash) // /foo  #hash?x=1   ← query 仍为 {}

// —— 验证：parseQuery 是注入参数，换个解析函数、切分逻辑不变 ——
const r2 = parseURL(
  s => Object.fromEntries(new URLSearchParams(s)),
  '/foo?a=1&b=2#h'
)
console.log(r2.query) // { a: '1', b: '2' }

// —— 验证：URL 字符串不同、路由语义相同 ——
const Home: RouteRecord = { name: 'home' }
const HomeAlias: RouteRecord = { name: 'home-alias', aliasOf: Home }
const stableStringify = (q: Record<string, string | string[]>) =>
  Object.keys(q).sort().map(k => `${k}=${q[k]}`).join('&')

const from: RouteLocation = {
  path: '/users', params: { id: '1' },
  query: { a: '1', b: '2' }, hash: '', matched: [Home],
}
const target: RouteLocation = {
  path: '/u', params: { id: ['1'] },          // 单元素数组
  query: { b: '2', a: '1' },                  // 顺序不同
  hash: '', matched: [HomeAlias],             // 别名 record
}
console.log(isSameRouteLocation(stableStringify, from, target)) // true
// 朴素字符串比较 '/users?a=1&b=2' === '/u?b=2&a=1' 会判 false

// —— 验证：哨兵不与任何真实位置相等 ——
console.log(isSameRouteLocation(stableStringify, from, START_LOCATION as any))
// false —— aLast=0、bLast=-1 不等长 → 首次导航不被短路
```

## 6. 执行轨迹

**拆解轨迹**——输入 `/foo#hash?x=1`：

1. `hashPos = location.indexOf('#')` → 4
2. `searchPos = location.indexOf('?')` → 9
3. `searchPos > hashPos`（9 > 4）→ 命中边界修正，searchPos 置 -1
4. 进入 hash 分支：path = `/foo`、query 保持 `{}`、hash = `#hash?x=1`
5. fullPath 拼回 = `/foo` + `` + `#hash?x=1` = `/foo#hash?x=1`

朴素 `indexOf('?')` 会拿到 9、从 9 切到末尾当成 query 解析 `x=1`——错把 hash 里的查询串当真查询。一行边界判定挡住这类错误。

**相等短路轨迹**——`from`（在 `/users`，末端 record R、params `{id:'1'}`、query `{a:'1',b:'2'}`）vs `target`（在 `/u`，R 的别名 RA、params `{id:['1']}`、query `{b:'2',a:'1'}`）：

1. 两端 matched 都长 1 → 等长过关
2. 末端 record 比对：`(RA.aliasOf || RA) === (R.aliasOf || R)` → `R === R`（别名归一）→ 过关
3. params 比对：`'1'` vs `['1']` → isEquivalentArray → `a.length === 1 && a[0] === '1'`（单值≡数组）→ 过关
4. query 比对：序列化两端 → `a=1&b=2` === `a=1&b=2`（按 key 排序）→ 过关
5. hash 比对：`''` === `''` → 过关
6. 五关全过 → `isSameRouteLocation` 返回 true → 触发 `NAVIGATION_DUPLICATED`，跳过整套导航、仅触发滚动到同锚点的副作用

URL 字符串 `/users?a=1&b=2` vs `/u?b=2&a=1`——朴素字符串比较会判「不同」，重新跑一遍导航。

**首次识别轨迹**——应用启动后第一次 push：守卫收到 `from === START_LOCATION_NORMALIZED` → true → 进入「首次导航」分支，不做重复短路。

## 7. 教学简化说明

本章演示故意省略了：完整 `RouteRecord` / matched 祖先链是怎么由匹配表构建的（属后续匹配表章）；真正的分段编码与 null/undefined 语义（第 1 章已讲，本章 parseQuery 是注入占位）；`stripBase` 的 base 剥离（属 history 章衔接）；相对路径 `./` `../` 的双指针解析（心智模型已点，不在演示里铺开）；devtools 诊断码与类型泛型。

## 8. 小结

URL 字符串是不可信的同一性证据——同一处可以有无数种写法。location 层把它降到「路由记录引用 + 参数结构 + 序列化后的查询与锚点」这一层语义上，再以一个全局单例对象给首次导航一个固定身份。手工切分换来的速度，是这套语义判定能在每次导航热路径上跑得起的代价。

下一章接过 path 段——把 `/users/:id` 这样的模式编译成正则与 parse/stringify 双向函数，并从模式本身派生具体性评分消解多路由歧义。

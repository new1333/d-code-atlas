# 新一代路由解析器 · 源码精读

## 给 Writer 的教学钩子（必填，8 子项缺一不可）

- **用户痛点 / 场景**：用文件路由（file-based routing）时，路由表是构建期由扫描目录 + 代码生成出来的静态清单，运行时根本不会增删；可旧解析器却背着一套为「运行时动态增删」准备的复杂评分排序系统。更痛的是：路径参数 `:id` 拿到手永远是字符串，要在组件里自己 `Number()`、自己校验；查不到记录时也只是返回一个 null，调用方分不清是「路径没匹配」还是「参数不合法」。使用者被迫在匹配层之外再叠一层类型转换与校验。

- **一句话核心思想**：把「不匹配」做成一个可抛出的异常，让参数的类型校验失败等价于「这条路由落选」——匹配的过程本身就是筛选的过程。

- **设计动机（为什么需要它）**：这个机制是为调和「路由表已静态化、但参数语义却越来越丰富（带类型、带校验）」这对矛盾而生的。它换来的能力是：参数在匹配阶段就被解析成正确类型并完成校验，`route.params` 直接拿到 `number` 而非 `"42"`，且校验不过的路由会「自然落选」而非抛错给上层。承前关系——「沿父链反推 matched 链」这一核心思想（已在第 6 章『路由匹配表』讲透，本章复用同一思想，只看它如何配合 query 的非排他合并这个新上下文）；「按 URL 段细分的编码」直接被匹配器的序列化方向消费（已在第 1 章『URL 分段编码与查询串』讲透，本章只看它新出现的一个侧面：动态段内部用子段编码、整段用路径编码，两种编码在同一条路径上协作）。

- **关键权衡（本 Atlas 的核心）**：
  - **异常即不匹配**：做了「匹配不上就抛一个专用异常，循环里 try/catch 试下一条」的选择 → 换来了「参数类型校验失败、必填 query 缺失、静态段大小写不符……全部用同一套 try/catch 自然落选，类型校验即匹配筛选，逻辑高度统一」→ 代价是「每次落选都要构造一个异常对象（带栈），高频匹配路径有性能开销；异常控制流对不熟悉的调试者不直观」。这是全章灵魂。
  - **固定有序表 + 顺序试错，而非评分排序树**：做了「构建期收下一张有序清单、运行时顺序遍历首个全程不抛的即命中」的选择 → 换来了「彻底放弃评分系统与二分插入、记录可直接用父指针表达嵌套、与代码生成天然契合」→ 代价是「放弃运行时增删路由的能力（动态性被推到构建期），命中优先级隐式依赖数组顺序，匹配是 O(n) 而非 O(log n)」。这是与第 6 章评分排序树最直接的对照。
  - **path 排他、query 非排他合并**：做了「路径段排他决定选哪条记录，但查询段沿 matched 链把所有祖先记录的查询匹配结果合并」的选择 → 换来了「能把分页/筛选这类『分组级查询参数』抽成无路径的分组记录，跨多条路径记录复用、各自独立声明类型」→ 代价是「path 与 query 的匹配语义不对称（一个排他一个合并），心智模型略复杂；多出『只能匹配 query 的分组记录』这一概念」。
  - **类型转换下沉到匹配层 + 标准校验协议**：做了「在匹配阶段就用参数解析器把字符串转成目标类型并校验，任何校验库只要实现标准协议即可即插即用」的选择 → 换来了「`route.params` 直出强类型、校验失败即落选无需组件层再校验、zod/valibot 等校验库零适配接入」→ 代价是「匹配路径承担了类型转换职责（关注点增多）、解析器的错误必须走『未命中』语义而非普通异常、且显式拒绝异步校验」。

- **最小心智模型（3～7 步）**：
  1. 构建期：代码生成产出一组静态记录，每条记录各自携带路径/查询/哈希三段匹配器与参数解析器；固定解析器收下清单，另建一张「名字→记录」的快查表（别名记录不入表）。
  2. 解析一个位置时，先把 URL 拆成 path / query / hash 三段。
  3. 顺序遍历记录：让当前记录的路径匹配器去匹配 path 段——不命中就在内部抛「未命中」异常。
  4. 路径命中后，哈希匹配器再匹配哈希段（只看最深的子记录）。
  5. 沿父链反推出 matched 链，再把链上所有记录的查询匹配器结果合并进参数（查询非排他）。
  6. 各匹配器内的参数解析器把捕获到的字符串转成目标类型并校验；任何一处校验失败同样抛「未命中」，导致整条记录落选，回到第 3 步试下一条。
  7. 首个全程不抛的记录即为命中；若全部落选，返回一个「无匹配」哨兵位置。

- **最小原理演示（替代旧"复刻范围"）**：
  - 应演示：一个只表达「异常即不匹配 + 类型校验即筛选 + 固定表顺序试错」三件事的从零实现（约 40 行）。每行对应一个原理点，见注释。
  - 应故意省略：哈希段、别名、分组记录的 query 合并、相对路径解析、编码细节、正则编译、可重复/可选参数、HMR、与历史/守卫的集成。
  - 演示载体建议：**首选 TS/JS**。本章核心是「数据结构 + 控制流」（一张表 + try/catch 顺序试错 + 异常作为落选信号），TS/JS 能忠实演透，且本生态本身就是 JS 的 VitePress 站点，读者 `node` 即可跑通，无需任何宿主环境。无需退回原仓库语言。
  - 演示骨架（Writer 据此执行，演的是「异常即不匹配」「类型校验即筛选」两条权衡）：

  ```ts
  // 原理点①：未命中是一个可抛异常；不匹配、参数非法都抛它
  class MatchMiss extends Error {}
  const miss = () => { throw new MatchMiss() }

  // 原理点④：参数解析器把「字符串→强类型+校验」下沉到匹配层
  const numberParser = {
    get: (v: string | null) => {
      if (v == null) miss()
      const n = Number(v)
      if (Number.isNaN(n)) miss()      // 非法 → 当作不匹配
      return n
    },
    set: (n: number) => String(n),
  }

  // 一条记录：路径段匹配 + 携带参数解析器
  function defineRoute(re: RegExp, parsers: Record<string, { get: (v: string | null) => any }>) {
    return {
      match(path: string) {
        const m = path.match(re)
        if (!m) miss()                 // 原理点①：路径不匹配 → 抛
        const params: any = {}
        let i = 0
        for (const k of Object.keys(parsers)) params[k] = parsers[k].get(m[++i])
        return params                  // 直出强类型
      },
    }
  }

  // 原理点②：构建期固定的清单，顺序试错，首个不抛即命中
  function createFixedResolver(records: ReturnType<typeof defineRoute>[]) {
    return {
      resolve(path: string) {
        for (const r of records) {
          try { return { path, params: r.match(path), ok: true } }   // 原理点①：miss 被 catch
          catch { /* 试下一条 */ }
        }
        return { path, params: {}, ok: false }   // 全落选 → 无匹配哨兵
      },
    }
  }

  const r = createFixedResolver([defineRoute(/^\/users\/([^/]+)$/, { id: numberParser })])
  console.log(r.resolve('/users/42'))   // { params: { id: 42 }, ok: true }  ← 直出 number
  console.log(r.resolve('/users/abc'))  // { params: {}, ok: false }          ← 校验失败自然落选
  ```

- **正文不宜展开的细节**：相对路径（`./`、`../`、`?page=2`）的解析与 currentLocation 复用；可重复/可选参数、子段（sub-segment）的 round-trip；trailingSlash 的三种态（真/假/不关心，后者用于尾部通配）；别名记录（aliasOf）如何从名字表排除并解析回原记录；dev-only 的告警与 HMR 替换解析器；解析器与历史、守卫、滚动恢复的集成——这些都属于集成/工程化脚手架，不是本章原理主角，Writer 应裁剪。

- **推荐的一个执行轨迹例子**：输入 URL `/users/42?page=3`，路由表含一条 `{ name: 'users', path: '/users/:id', id 参数解析器=number }`。轨迹：拆段得 `{ path: '/users/42', query: { page: '3' } }` → 试该记录，路径正则命中并捕获 `'42'` → 参数解析器把 `'42'` 转成数字 `42`（若捕获到 `'abc'` 则解析器抛未命中，该记录落选）→ 输出 `{ name: 'users', params: { id: 42 } }`，`id` 直出 `number`。这条轨迹同时演透了「类型校验即筛选」与「直出强类型」两点。

> 以上钩子供 Writer 写「动机→核心思想→心智模型→关键权衡→原理演示」；下面事实部分供核对，不要被 Writer 当目录照抄。

## 概念要点

- **解析器抽象**：定义了一个「解析器」接口，只暴露 `resolve`（多种重载：绝对路径串/相对路径串/具名对象/相对对象）、`getRoutes`、`getRoute(name)`。`resolve` 的返回类型 `ResolverLocationResolved` 含 `name / params / matched[]`，其中 `params` 已是「解码并格式化后」的强类型对象。源码位置: packages/router/src/experimental/route-resolver/resolver-abstract.ts:19-90, 107-124

- **无匹配哨兵**：`NO_MATCH_LOCATION` 用一个 Symbol 作 name、空 params、空 matched，作为「全部记录落选」的统一返回，保证「同一个 name」语义的同时允许 path/query/hash 变化。源码位置: packages/router/src/experimental/route-resolver/resolver-abstract.ts:130-134

- **「未命中」异常与 miss 助手**：`MatchMiss extends Error`（name='MatchMiss'），`miss()` 助手函数返回类型 `never`，是整个解析器「不匹配」的统一控制流原语。源码位置: packages/router/src/experimental/route-resolver/matchers/errors.ts:6-25

- **固定解析器**：`createFixedResolver(records)` 构建期接收有序数组，仅建一个 `Map<RecordName, TRecord>`（别名记录被排除，使按名查找总是落到原记录）。源码位置: packages/router/src/experimental/route-resolver/resolver-fixed.ts:141-151

- **记录的三段匹配器结构**：每条记录可独立携带 `path / query[] / hash` 三类匹配器；另有 `parent`（嵌套）与 `aliasOf`（别名）。分组记录（Group）无 name、无 path、无 hash，**只能匹配 query**——这是 query 非排他合并的载体。源码位置: packages/router/src/experimental/route-resolver/resolver-fixed.ts:34-101

- **matched 链沿父链反推**：`buildMatched(record)` 用 `while(node){ matched.unshift(node); node = node.parent }` 从当前记录向根反推。此思想与第 6 章一致。源码位置: packages/router/src/experimental/route-resolver/resolver-fixed.ts:121-131

- **validateMatch：三段分别匹配 + query 非排他合并**：先 `record.path.match(url.path)`（不匹配内部抛），再 `record.hash?.match(url.hash)`，再 `buildMatched(record)` 后 `Object.assign({}, ...matched.flatMap(r => r.query?.map(q => q.match(url.query))))` 把链上所有记录的 query 结果合并。源码位置: packages/router/src/experimental/route-resolver/resolver-fixed.ts:181-202

- **resolve 的两条分支**：(a) 具名/相对对象（`to.name` 真或 `to.path == null`）→ 从 recordMap 查记录 → build 路径 → 再 validateMatch 复算；(b) 字符串/路径对象 → parseURL 拆段 → 顺序遍历 records，try/catch 调 validateMatch，首个不抛即 break，全抛则返回无匹配哨兵。源码位置: packages/router/src/experimental/route-resolver/resolver-fixed.ts:204-351（循环 317-330）

- **匹配器模式接口（match/build 双向）**：`MatcherPattern<TIn, TParams, TParamsRaw>` 的 `match` 抛 MatchMiss 表示不匹配，`build` 把参数序列化（路径/哈希要编码、query 不编码）。三类实现：`MatcherPatternPathStatic`（静态、大小写不敏感）、`MatcherPatternPathDynamic`（正则+参数解析器，处理可重复/可选/子段/trailingSlash）、`MatcherPatternPathStar`（静态前缀+通配 `pathMatch`）。源码位置: packages/router/src/experimental/route-resolver/matchers/matcher-pattern.ts:23-46, 69-90, 156-297；matcher-pattern-path-star.ts:18-38

- **动态路径匹配器对参数解析器的调用**：`match` 中 `params[paramName] = (parser?.get || identityFn)(value)`，把捕获的（已 decode 的）字符串交给解析器转类型；`build` 中 `(parser?.set || identityFn)` 反向序列化，并区分 `encodeParam`（子段，不编码 `/`）与 `encodePath`（整段）。源码位置: packages/router/src/experimental/route-resolver/matchers/matcher-pattern.ts:201-214, 240-262

- **query 匹配器的「必填/默认/可选」三态**：`MatcherPatternQueryParam.match` 先按 `format: 'value'|'array'` 规范化，再调解析器；解析抛错时**仅当「必填且无默认」才向上抛**（让记录落选），否则回落到默认或 undefined。最终若 value 仍 undefined：有默认用默认、必填无默认则 miss()、可选则保留 undefined。源码位置: packages/router/src/experimental/route-resolver/matchers/matcher-pattern-query.ts:36-112

- **ParamParser 接口**：`{ get?: (url值) => TParam; set?: (TParamRaw) => url值 }`，是「URL 字符串值 ↔ 强类型参数」的双向转换抽象。源码位置: packages/router/src/experimental/route-resolver/matchers/param-parsers/types.ts:25-35

- **两档定义器**：`defineParamParserRaw` 要求用户自行处理 nullish/数组（全控制）；`defineParamParser` 包装单值解析器，自动把 optional 映射为 null、把 repeatable 映射为数组并滤除 nullish。源码位置: packages/router/src/experimental/route-resolver/matchers/param-parsers/define-param-parser.ts:73-148

- **Standard Schema 适配**：`normalizeParamParser` 用 `'~standard' in parser` 鸭子判定，把任意符合 Standard Schema 的校验器（zod/valibot 等）适配成 ParamParser.get——validate 有 issues 即 `miss()`，使「校验失败 = 路由落选」对第三方校验库零成本成立。异步校验被显式拒绝（同步匹配前提）。源码位置: packages/router/src/experimental/route-resolver/matchers/param-parsers/standard-schema.ts:14-41

- **Router 注入式集成**：`experimental_createRouter({ resolver, history, ... })` 把解析器作为依赖注入，`router.resolve` 委托给 `resolver.resolve`。**没有 addRoute/removeRoute**（文档明确），专配 file-based routing 的代码生成；dev 下提供 `_hmrReplaceResolver` 支持不刷新页面的解析器热替换。源码位置: packages/router/src/experimental/router.ts:402-409, 609-628, 676-710, 1417-1421

## 关键调用链

- 解析（字符串/路径对象）主链：
  `resolve(to, currentLocation)` → `parseURL(parseQuery, to, currentLocation?.path)` 拆段 → `for (record of records) { try { validateMatch(record, url); break } catch {} }` → 命中返回 `{ ...url, name, params, matched }`；全落选返回 `{ ...url, ...NO_MATCH_LOCATION }`。
  源码位置: packages/router/src/experimental/route-resolver/resolver-fixed.ts:295-351

- 解析（具名对象）主链：
  `resolve({name, params})` → `recordMap.get(name)` → `record.path.build(params)` + `record.hash?.build` → 拼 query（含链上各记录 `query[].build`）→ `validateMatch(record, url)` 复算修正 params → 返回。
  源码位置: packages/router/src/experimental/route-resolver/resolver-fixed.ts:208-293

- validateMatch 内部：
  `record.path.match(url.path)` → `record.hash?.match(url.hash)` → `buildMatched(record)` → `Object.assign({}, ...matched.flatMap(r => r.query?.map(q => q.match(url.query))))` → 返回 `[matched, { ...pathParams, ...queryParams, ...hashParams }]`。
  源码位置: packages/router/src/experimental/route-resolver/resolver-fixed.ts:181-202

- 参数类型下沉链（以动态路径段为例）：
  `MatcherPatternPathDynamic.match` 正则捕获 → `decode` → `(parser.get || identityFn)(value)` → 其中 parser 可来自 `defineParamParser` 包装或 `normalizeParamParser(standardSchema)`，校验失败 `miss()`。
  源码位置: packages/router/src/experimental/route-resolver/matchers/matcher-pattern.ts:196-214；standard-schema.ts:23-40

## 源码摘录（带行号，全文累计 ≤ 30 行）

未命中异常与 miss 助手（异常即不匹配的控制流原语）：
```ts
// errors.ts:6-25
export class MatchMiss extends Error { name = 'MatchMiss' }
export const miss: (...args: ConstructorParameters<typeof MatchMiss>) => never =
  (...args) => { throw new MatchMiss(...args) }
```

固定解析器建名表（构建期固定 + 别名排除）：
```ts
// resolver-fixed.ts:146-151
const recordMap = new Map<RecordName, TRecord>()
for (const record of records) {
  if (!record.aliasOf) recordMap.set(record.name, record)
}
```

validateMatch：三段分别匹配 + query 沿链合并（非排他）：
```ts
// resolver-fixed.ts:186-201
const pathParams = record.path.match(url.path)        // 不匹配则内部 miss
const hashParams = record.hash?.match(url.hash)
const matched = buildMatched(record)
const queryParams: MatcherQueryParams = Object.assign({}, ...matched.flatMap(r =>
  r.query?.map(q => q.match(url.query))))             // query 沿 matched 链合并
return [matched, { ...pathParams, ...queryParams, ...hashParams }] as const
```

resolve 的顺序 try/catch（首个全程不抛即命中）：
```ts
// resolver-fixed.ts:317-330
for (record of records) {
  try {
    ;[matched, parsedParams] = validateMatch(record, url)
    break                  // 不抛 = 命中
  } catch {
    // 试下一个 record
  }
}
if (!parsedParams || !matched) return { ...url, ...NO_MATCH_LOCATION }
```

Standard Schema 校验失败即 miss（类型校验 = 落选）：
```ts
// standard-schema.ts:34-37
if (result.issues) { miss(result.issues.map(issue => issue.message).join(', ')) }
return result.value
```

## 易混淆 / 边界 / 推断

- **事实**：path 是排他的（决定选哪条记录），query 是非排他的（沿 matched 链合并所有祖先记录的 query 结果）；hash 只匹配最深子记录。三者语义不对称，是本章最易混淆点。源码位置: resolver-fixed.ts:186-201
- **事实**：`miss()` 在多处触发——静态段大小写不符、trailingSlash 不符、正则不匹配、必填 query 缺值、参数解析/Standard Schema 校验失败、build 时非可选可重复参数为空。它们都走同一个 try/catch 落选通道。源码位置: matcher-pattern.ts:81-84, 189-199；matcher-pattern-query.ts:97-106
- **事实**：具名解析分支会先用参数 build 出 URL，再调 validateMatch 复算修正 params——目的是消除 query 与 hash 来源的 params 不一致。源码位置: resolver-fixed.ts:284-285
- **推断**：固定数组 + O(n) 顺序试错是对「file-based routing 路由表通常不大、且构建期已知」的刻意取舍；解析器注释里「TODO: test performance」与保留的循环合并写法暗示作者知道这里有性能边界但选择了简单性。源码位置: resolver-fixed.ts:195-198
- **推断**：把「校验失败」并入「未命中」语义，本质是把类型系统的判断提前到匹配阶段——这让 `route.params` 的类型与「能否匹配」耦合，副作用是同一条路径会因为参数值不同而命中或落选（如 `/users/abc` 不命中 number 参数路由）。这是「类型校验即筛选」的直接推论，需 Writer 向读者点明。源码位置: matcher-pattern.ts:213；standard-schema.ts:34-37
- **未理解**：`MatcherPatternPathDynamic.build` 中 trailingSlash==null（尾部通配）分支的 path 末尾 `/` 补全逻辑（`path + (!value && path.at(-1) !== '/' ? '/' : '')`）在「尾部通配值为空」与「round-trip 一致性」之间的精确交互，仅从代码难以完全确定其全部边界情形，建议 Writer 不深入。源码位置: matcher-pattern.ts:287-296
# 路由匹配表：从配置到 matched 链 · 源码精读

## 给 Writer 的教学钩子（必填，8 子项缺一不可）

- **用户痛点 / 场景**：用户用一棵嵌套的配置树描述路由（带子路由、别名、重定向、单组件/多命名视图多种形态）。可运行期每次导航，拿到的是一个导航目标（可能是路由名、可能是完整路径、也可能是相对当前位置的偏移），必须立刻回答两件事：该渲染哪几个组件（含祖先链）、参数是什么。如果每次都重新遍历配置树逐条比对，既慢，又无法处理"同一路径被多条模式命中时该选谁"的歧义。

- **一句话核心思想**：把配置树在**注册期**一次性预编译成一张按具体性评分排序的扁平匹配表，运行期解析只剩"一次正则命中 + 沿父指针反推组件链"。

- **设计动机（为什么需要它）**：这个机制要解决的核心矛盾是——**配置的形状是树（嵌套 + 别名），但匹配的形状是线（一个 URL 对一条记录）**。所以需要一座桥：把树展平进一张可线性扫描的有序表，同时又不能丢失父子关系（否则无法还原"该渲染祖先组件"）。它换来的能力是：运行期解析路径时无需递归（线性找到第一个正则命中的表项即可），而组件链的还原只需沿预置的父指针一路回溯。其中评分排序这一侧（**已在前置章『路径模式编译与优先级评分』讲透**——如何从模式本身派生具体性分数）本章只看它的**新侧面：分数如何被消费来维持一张始终有序、可二分插入的运行期表**。另外，找不到匹配时抛出的语义化错误（**已在前置章『导航失败的语义化分类』讲透**）本章只把它当作解析失败时的出口，不再展开。

- **关键权衡（本 Atlas 的核心）**：
  1. **注册期预编译，换运行期极简解析 → 代价是表可变、需维护多重索引**：选择在添加路由时就把每条路径编译成正则 + 解析/反解函数 + 分数（编译细节承前章）→ 换来运行期按路径解析时只剩"线性找第一个正则通过的表项 + 一次 parse"、按名解析时是一次哈希表查表 → 代价是添加/删除路由开销大，且必须同步维护三套结构（有序数组、名字→表项的映射、别名反向引用），任一处不一致表就坏了。
  2. **树展平 + 双向指针，换匹配无需递归 → 代价是父子路径与同分排序要手工处理**：选择把嵌套配置递归拍平进一个扁平数组，但每个表项同时携带"父指针 / 子列表"，从而既享受线性扫描的简单、又能在命中后沿父指针反推出完整组件链 → 代价是父子路径必须在注册期手工拼接（处理尾斜杠分隔符），且当父子分数相同时必须额外保证"后代排在祖先之前"（否则命中祖先会提前短路，漏掉更具体的后代）。
  3. **别名共享同一份记录，换一处定义多处生效 → 代价是别名参数必须与原路径一致**：选择为每个别名单独建一个表项（各自有自己的正则/分数/路径），但所有别名表项的"记录归属"都指向同一个原始记录（组件、守卫、已挂载实例缓存全部共享）→ 换来同一段组件/守卫逻辑被多条路径复用、删除原记录能级联清掉所有别名 → 代价是别名路径必须拥有与原路径相同的必要参数，否则解析出来的参数对不上（注册期有校验告警）。
  4. **判别联合用互斥标记精确描述五种变体，换编译期拒绝非法配置 → 代价是类型定义繁复**：选择用"互斥的 never 字段"把用户配置拆成五个精确变体（单组件 / 单组件带子路由 / 多命名视图 / 多命名视图带子路由 / 纯重定向），让"同时写了组件又写了重定向"这种非法组合在编译期就被 TypeScript 拒绝 → 换来规范化逻辑能放心用属性存在性分支判断、且错误配置在写代码时就报红 → 代价是五个接口定义较长、用户需理解互斥规则。

- **最小心智模型（3～7 步）**：
  1. 添加一条路由：先把用户记录**规范化**（把单组件统一成多视图对象、补齐运行期才需要的空守卫集合/实例缓存等字段）。
  2. **展开别名**：原路径 + 每个别名各产生一条规范记录，别名之间共享同一份组件定义。
  3. 对每条规范记录：若是相对子路径，**拼上父路径**（处理中间斜杠）；编译出"正则 + 分数 + 参数键 + 解析/反解函数"，并挂上父指针。
  4. **可匹配性过滤**：既无组件、又无名、又无重定向的纯分组路由不进表（它只用来组织子路由，本身不可达）。
  5. **按分数二分插入**有序数组（同分时后代排在祖先前）；有名且非别名的表项同时登记进名字映射。
  6. 递归对每个子路由重复上述过程，建出完整的父/子指针树。
  7. 解析时：按名查映射 / 按路径线性找第一个正则命中 / 按相对位置基于当前位置反推；命中后解析出参数，再**沿父指针一路回溯、逆序填进组件链**（祖先在前），合并各层 meta，返回完整位置。

- **最小原理演示（替代旧"复刻范围"）**：
  - 应演示：一个**只表达核心思想**的从零实现（几十行 TS）。重点演三件事——(a) 递归把配置树拍平成"带父指针的扁平表项数组"；(b) 按分数排序插入（分数可极度简化为"静态段优先于动态段"的两档）；(c) 解析时"找到第一个正则命中的表项，沿父指针 unshift 出组件链"。再演一条**别名**：两个路径指向同一个记录对象，删原记录时别名一并消失。每一段都要对应上面某条权衡（拍平+指针 ↔ 权衡 2；别名共享记录 ↔ 权衡 3；预编译正则 ↔ 权衡 1）。
  - 应故意省略：真实的字符级评分算法（承前章已演）、参数键的可选/可重复细节、props 规范化、守卫集合实例化、所有开发期校验告警、query/hash/编码、重定向记录的单独处理。
  - **演示载体建议：首选 TS/JS**。本章核心是"数据结构组织（扁平有序表 + 父指针）+ 算法（二分插入、线性命中、沿指针反推）+ 别名共享记录"——纯算法/数据结构/设计模式类，TS 完全能忠实演透，无需依赖任何运行时特有语义。且本 Atlas 产物本身就是 JS 生态的 VitePress 站，TS 演示配最小 `package.json` 即可 `bun run`/`node` 跑，对读者最友好。**无需退回原仓库语言。**

- **正文不宜展开的细节**：开发期注册校验/告警（同名参数、别名参数不一致、绝对子路径缺参数、子路径空且父有名未命名、与祖先同名）；props 的 boolean/object 规范化；全局选项与记录选项的深合并；data-loaders 专用的不可枚举 `mods` 属性与 meta 里的 loader/signal 键；诊断码编号；重定向记录永不渲染的语义；类型层 Generic/Typed 三态（属类型安全章）。

- **推荐的一个执行轨迹例子**：
  配置 `{ path: '/users', component: Users, alias: '/u', children: [{ path: ':id', component: UserDetail }] }`。
  添加阶段：规范化出 `/users` 表项（静态、高分）；递归子路由，相对路径 `:id` 拼成 `/users/:id`（动态段、低分），父指针指向 `/users`；别名 `/u` 生成共享同一记录的表项，其子别名 `/u/:id` 同理。四条表项按分数插入有序数组。
  解析 `/users/42`：线性扫描找第一个正则命中的是 `/users/:id` 表项 → 解析得 `{ id: '42' }` → 沿父指针回溯：`/users/:id` → `/users`，逆序填进组件链得 `[Users, UserDetail]` → 合并 meta → 返回。一次正则命中 + 一次指针回溯，全程零递归遍历配置树。

> 以上钩子供 Writer 写「动机→核心思想→心智模型→关键权衡→原理演示」；下面事实部分供核对，不要被 Writer 当目录照抄。

## 概念要点
- 匹配器对外只暴露 6 个方法（增/删/清/列表/按名查/解析），是一个窄接口深模块：源码位置: packages/router/src/matcher/index.ts:33-53
- 内部维护**两套并行结构**：`matchers` 有序数组（按分数排序，路径解析的扫描源）+ `matcherMap`（名字→表项，按名解析的 O(1) 索引）：源码位置: packages/router/src/matcher/index.ts:67-71
- `addRoute` 是递归函数，第三参 `originalRecord` 用于在别名子树中把子别名挂到原始子记录上，使别名层级与原层级一一对应：源码位置: packages/router/src/matcher/index.ts:81-85
- 别名处理：把原记录与每个别名都 push 进 `normalizedRecords` 数组统一循环；别名记录的 `aliasOf` 指向原始记录、`components` 直接复用原始记录的组件定义（保证异步组件缓存挂在原记录上）：源码位置: packages/router/src/matcher/index.ts:96-122
- 父子路径拼接规则：子路径首字符非 `/` 时才算相对路径；分隔符 `/` 仅在"父路径不以 `/` 结尾且子路径非空"时补上——这是手工处理树→串的关键：源码位置: packages/router/src/matcher/index.ts:132-138
- "先创建表项对象、再递归子路由"——对象必须先建好才能作为 parent 传给子调用，是递归建树得以成立的前序：源码位置: packages/router/src/matcher/index.ts:148, 181-190
- 同名重注册：仅顶层添加（`isRootAdd`）且非别名且有名时，先 removeRoute 旧同名记录再插入新的（实现"后定义覆盖先定义"）：源码位置: packages/router/src/matcher/index.ts:160-173
- `isMatchable` 过滤：无组件、无名、无重定向的纯分组路由不入表（避免被命中后无物可渲染），但仍可作为父：源码位置: packages/router/src/matcher/index.ts:177-179, 652-658
- `insertMatcher`：二分定位后 splice 插入；**仅原记录（非别名）入 name 映射**，别名靠原记录的 alias 列表间接可达：源码位置: packages/router/src/matcher/index.ts:236-242
- 解析按 **name** 分支：查映射 → 按 `matcher.keys` 过滤参数（必选参数从当前位置继承 + 可选参数从父继承，确保激活态判定正确）→ `stringify` 反解出路径（找不到名抛 MATCHER_NOT_FOUND）：源码位置: packages/router/src/matcher/index.ts:253-306
- 解析按 **path** 分支：`matchers.find(m => m.re.test(path))` 线性找第一个正则命中的表项 → `parse` 出参数 → 清掉值为假的可选参数键：源码位置: packages/router/src/matcher/index.ts:307-331
- 解析**相对位置**分支：无 name 无 path 时，基于 currentLocation 的 name/path 先定位当前 matcher，再合并传入参数反解路径：源码位置: packages/router/src/matcher/index.ts:333-348
- **matched 链反推**：命中后 `while (parentMatcher) { matched.unshift(...); parentMatcher = parentMatcher.parent }`——逆序插入使祖先在前：源码位置: packages/router/src/matcher/index.ts:350-357
- `mergeMetaFields` 把组件链上各记录的 meta 逐层 assign 合并：源码位置: packages/router/src/matcher/index.ts:364, 486-491
- `normalizeRouteRecord`：统一 `component`→`components.default`、把 `children`/`meta` 等补成始终存在的形态、初始化运行期空字段（leaveGuards/updateGuards/enterCallbacks/instances），并用 `Object.defineProperty` 把 `mods` 设为不可枚举：源码位置: packages/router/src/matcher/index.ts:411-443
- `removeRoute` 级联：删 matchers 数组项 + name 映射项，并对 `children` 和 `alias` 递归删除（别名与子树随原记录一起消失）：源码位置: packages/router/src/matcher/index.ts:210-230
- `isAliasRecord` 沿 parent 链向上查 `aliasOf`，用于决定是否登记进 name 映射：源码位置: packages/router/src/matcher/index.ts:472-479
- **表项对象的数据结构**：每个 RouteRecordMatcher 同时是路径解析器（re/score/keys/parse/stringify，承前章产物）又携带 `record`/`parent`/`children`/`alias` 四个指针字段——这就是"展平进数组但用指针重建树"的载体：源码位置: packages/router/src/matcher/pathMatcher.ts:8-14, 33-39
- 建子表项时把 matcher 推进 `parent.children`，但前提是"双方要么都是别名、要么都不是别名"（避免别名子树混入原父子树污染 originalRecord 传递顺序）：源码位置: packages/router/src/matcher/pathMatcher.ts:41-47
- **二分插入的两阶段**：先按 `comparePathParserScore` 二分定位分数位置；再调 `getInsertionAncestor` 找是否有同分的祖先表项，若有则把插入点挪到该祖先之前（保证同分时后代先于祖先被扫描命中）：源码位置: packages/router/src/matcher/index.ts:593-628
- 分数比较本身（承前章）：逐段比较分数数组，短的纯静态段排前——本章只消费其返回值的正负：源码位置: packages/router/src/matcher/pathParserRanker.ts:305-327, 337-358
- **规范记录类型** RouteRecordNormalized：把用户配置的多种形态统一成"所有字段恒在"的运行期形态，并预置守卫集合/实例缓存等运行期才填充的字段：源码位置: packages/router/src/matcher/types.ts:17-91
- **用户配置判别联合** RouteRecordRaw = 五个变体之或，每个变体用 `component?: never`/`components?: never`/`redirect?: never`/`children?: never` 互斥标记，使五种形态在类型层互斥：源码位置: packages/router/src/types/index.ts:297-388
- 公共基类 `_RouteRecordBase` 提供所有变体共享的字段（path/redirect/alias/name/beforeEnter/meta/children/props），并扩展路径解析选项：源码位置: packages/router/src/types/index.ts:195-245
- **解析输入** MatcherLocationRaw = 三变体之或（path / name / 相对），resolve 用 `'name' in location`、`location.path != null` 做运行期判别：源码位置: packages/router/src/types/index.ts:67-94, 401-404
- **解析输出** MatcherLocation：含 name/path/params/meta 与 `matched` 记录链数组（不关心 query/hash，那是上层职责）：源码位置: packages/router/src/types/index.ts:409-436
- 两个类型守卫：`isRouteName`（string|symbol 即路由名）、`isRouteLocation`（string 或对象即合法位置），用于 removeRoute 等处的运行期类型收窄：源码位置: packages/router/src/types/typeGuards.ts:3-11

## 关键调用链
建表：
`createRouterMatcher(routes)` → `routes.forEach(addRoute)` → `normalizeRouteRecord`（统一组件/补空字段）→ 展开别名数组 →（相对路径时）父子路径拼接 → `createRouteRecordMatcher`（承前：tokenize→tokensToParser 产出 re/score/keys/parse/stringify）→ `isMatchable?` → `insertMatcher`(`findInsertionIndex` 二分 + 祖先调整) → 递归 `addRoute(children, matcher, ...)` 建父子指针。

解析：
`resolve(location, currentLocation)` → 三分支择一：
· name：`matcherMap.get` → `pickParams`(按 keys 过滤) → `matcher.stringify`
· path：`matchers.find(m => m.re.test(path))` → `matcher.parse` → 清可选空参
· 相对：基于 currentLocation 定位 matcher → `assign(params)` → `stringify`
→ `while(parent) matched.unshift(record)` → `mergeMetaFields` → 返回 MatcherLocation。

## 源码摘录（带行号，全文累计 ≤ 30 行）

父子路径拼接（演权衡 2：手工处理树→串）：
源码位置: packages/router/src/matcher/index.ts:132-138
```ts
if (parent && path[0] !== '/') {
  const parentPath = parent.record.path
  const connectingSlash =
    parentPath[parentPath.length - 1] === '/' ? '' : '/'
  normalizedRecord.path =
    parent.record.path + (path && connectingSlash + path)
}
```

解析 path 分支核心（演权衡 1：运行期只剩一次正则命中 + 一次 parse）：
源码位置: packages/router/src/matcher/index.ts:316-331
```ts
matcher = matchers.find(m => m.re.test(path))
if (matcher) {
  params = matcher.parse(path)!
  name = matcher.record.name
  matcher.keys.forEach(key => {
    if (key.optional && !params[key.name]) {
      delete params[key.name]
    }
  })
}
```

matched 链沿父指针反推（演核心思想：无递归还原组件链）：
源码位置: packages/router/src/matcher/index.ts:350-357
```ts
const matched: MatcherLocation['matched'] = []
let parentMatcher: RouteRecordMatcher | undefined = matcher
while (parentMatcher) {
  // reversed order so parents are at the beginning
  matched.unshift(parentMatcher.record)
  parentMatcher = parentMatcher.parent
}
```

判别联合五种互斥变体（演权衡 4：never 字段锁死非法组合）：
源码位置: packages/router/src/types/index.ts:383-388
```ts
export type RouteRecordRaw =
  | RouteRecordSingleView
  | RouteRecordSingleViewWithChildren
  | RouteRecordMultipleViews
  | RouteRecordMultipleViewsWithChildren
  | RouteRecordRedirect
```

## 易混淆 / 边界 / 推断
- **事实**：别名表项与原表项是 `matchers` 数组中各自独立的项（各有独立正则/分数），共享的只是 `record`（组件/守卫/实例缓存）。因此同一段组件逻辑可被多条路径命中，且 `instances` 缓存多路径共享。
- **事实**：name 映射里只登记原记录（`!isAliasRecord(matcher)`）。别名解析时仍可命中（因为别名表项在 matchers 数组里、其 record.name 沿 aliasOf 指向原名），但靠原记录登记——这避免了同名重复登记。
- **事实**：`getInsertionAncestor` 只对"同分父子"做调整；分数不同的父子本来就由分数决定先后。这条规则解决的是"父子同分时祖先不能挡住后代"的边界（推断：典型场景是父 `/a` 与子 `/a` 空路径拼接后分数接近）。
- **推断**：解析按 path 分支用 `find`（线性，返回首个命中），之所以可接受 O(n)，正是因为表已按分数降序排序——首个命中即最高分（最具体）匹配，结果确定且自明，无需回溯比较多个候选。这是承前章评分体系的直接受益点。
- **易混淆**：`isMatchable` 过滤掉的纯分组路由（无组件/无名/无重定向）**不进 matchers 数组**，但它创建的 matcher 仍作为 children 的 parent 存在——因此 matched 链反推时，如果祖先不可匹配会怎样？推断：被过滤的分组路由不会出现在 matched 链里（因为它从没进表，也就不会被 resolve 命中并沿指针回溯经过——回溯是从命中表项开始沿 parent 走，会经过未入表的 parent）。需注意：matched 链会包含未入表的分组祖先记录（因为 parent 指针仍指向它）。这一点供 Critic/Writer 核对源码意图时留意。
- **事实**：resolve 按 name 分支时，参数过滤策略是"必选键从当前位置继承 + 父的可选键继承 + 本记录所有键从 location.params 取"——这是为了让 RouterLink 的激活态判定（params 子集匹配）正确工作（注释引用 #1497）。
- **未理解**：`findInsertionIndex` 第二阶段用 `matchers.lastIndexOf(insertionAncestor, upper - 1)` 定位祖先在数组中的位置作为新插入点——为何是"祖先所在位置"而非"祖先之后"？推断意图是把后代插到祖先前面（同分后代优先），但 `lastIndexOf` 返回的是祖先自身下标，splice 在该下标插入即把后代放到祖先正前方，与"后代在祖先之前"一致。该细节建议 Writer 谨慎处理或略过。
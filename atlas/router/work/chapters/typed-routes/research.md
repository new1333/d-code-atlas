# 类型安全路由的编译期推导 · 源码精读

## 给 Writer 的教学钩子（必填，8 子项缺一不可）

- **用户痛点 / 场景**：用户写 `router.push({ name: 'usr', params: { id: 123 } })` 时，路由名拼错、参数漏传、参数类型不对，运行时才会以「404 / undefined」形式爆出来——错误离根因太远。理想是：这些错误在写代码/编译期就被编辑器和 tsc 拦下，且路由名能自动补全。但路由表是用户自己声明的、甚至由构建工具扫描文件生成的，库发布时根本不知道有哪些路由——怎么让「库的类型」在「不知道用户路由表」的前提下，还能精确到每条路由的名字和参数？

- **一句话核心思想**：**留一个空接口当「类型插槽」，让外部用模块增强把路由表「插」进来；每条公开类型都用一个条件判断自动在「没插→宽松兜底」和「插了→按名精确」之间切换。** 这是全章灵魂句。

- **设计动机（为什么需要它）**：库内部代码不能依赖用户的路由表（否则开箱即编译失败），但对外 API 又想做到「你接了类型生成就全链路精确、没接就退化为宽松 string」。于是把「是否启用类型推导」本身做成一个**可选的、纯类型层面的注入**：库定义一个空接口，谁需要可配置的类型，就从里面「试着推断」自己那个具名插槽，推断不到就用宽松默认。换来的能力是：库零配置可用 + 外部无侵入增强 + 编译期防拼写/防参数错。
  - 承前去重（**重要**）：「路由记录在**运行期**的五种互斥变体结构」已在第 6 章『路由匹配表』讲透，本章**不看运行期记录**，只看为类型推导服务的「**编译期每路由描述符**」（名字/路径/参数类型）。「守卫的执行管线（leave→…→beforeResolve 串成 promise 链、next 回调 promise 化）」已在第 7 章『导航守卫管线』讲透，本章**不看守卫执行**，只看守卫签名里的 `to/from` 参数类型如何搭乘同一套类型注入。「可取消异步导航状态机」已在第 9 章『Router 核心与导航主循环』讲透，本章不看主循环。
  - **向前引用（去重信号）**：把空插槽「插满」的那个路由名表（`RouteNamedMap`）是**构建工具生成**的——它的**生成过程**属于第 16 章『文件路由：类型生成与构建期集成』；本章**只讲消费侧的注入与切换机制**，不讲生成。Writer 切勿在本章展开 codegen。

- **关键权衡（本章核心，4 条）**：
  1. **空接口作全库统一的「类型插槽注册表」**：选择用**一个空接口**承载所有可配置类型，每个消费者用 `接口 extends Record<'我的插槽名', infer T> ? T : 默认值` 来取值。→ 换来：库发布即开箱可用（插槽空时全走宽松默认）；外部用一条 `declare module` 就能把精确类型无侵入「插」进来；**多个互不相关的特性（类型化路由、实验性 Router、数据加载器的错误类型、参数解析器类型）共用同一套注入基础设施**，不必各造各的开关。→ 代价：每条公开类型都得写一遍条件类型样板；条件类型求值对编译器有真实开销；路由表一大就类型膨胀、编译变慢。
  2. **用「宽松表是否仍兼容当前表」当开关，而非布尔标志**：选择不维护任何「是否启用」的运行时/类型标志，而是用**一个条件判断反推**——「默认的宽松表，是不是仍然赋值兼容于当前的表？」若是（= 没人注入过），走宽松分支；若否（= 已被外部精确表替换），走按名精确分支。→ 换来：零运行时、零额外状态，纯类型层完成「有生成→精确、没生成→宽松」的自动切换，且切换点集中在一处、下游统一引用。→ 代价：语义反直觉（要用「子类型关系」表达「是否启用」，读者需理解类型别名间的 `extends` 判定）；隐含脆弱契约——「宽松表必须是精确表的超集」一旦被破坏，开关就静默失效。
  3. **每类公开类型维护 Generic / Typed / TypedList 三态**：选择把每个对外类型都拆三份——**Generic**（不带路由表参数、全用宽松默认，**库内部一律用这版**，绝不耦合用户配置）、**Typed<表, 名字>**（携带路由表、按名精确）、**TypedList<表>**（`{ [按名]: Typed<名> }` 用一次映射类型把「按名查表」物化）；再用权衡 2 的开关对外暴露单一类型名。→ 换来：库内部代码不被类型注入污染（永远用 Generic），对外却能凭一个路由名一路索引到精确的参数/路径；「按名查表」只需一次 mapped type，下游全是查表。→ 代价：每个公开类型三份样板、重复度高；当名字参数缺省（= 所有路由的并集）时，TypedList[名字] 退化成超大联合类型。
  4. **读/写两套参数类型分离（decoded vs raw）**：选择让每条路由同时携带「读出的参数（严格 string，已解码）」与「写入时可传的原始参数（允许 number、可空、可重复的元组形态）」，并用**一个「是否原始」的布尔类型参数**驱动同一套工具类型在两态间分支。→ 换来：「从当前路由读 params」与「传给 push 的 params」语义精确分离——读侧永远 string，写侧允许便利的 number 和 `:id*` 的元组；同一份工具类型复用，不必写两遍。→ 代价：参数类型维度 ×2，类型层稍复杂；布尔类型参数驱动条件分支的写法对不熟者偏 trick。

- **最小心智模型（3～7 步）**：
  1. 库定义一个**空接口**，作为「类型插槽」总入口。
  2. 每个需要可配置类型的消费者，从该接口里**试着推断**自己那个具名插槽；推断不到就用宽松默认。
  3. 路由表对应的插槽叫「路由名表」：由构建工具生成，再用**模块增强**把它「插」进空接口。
  4. **插入前**：整条公开类型链退化为宽松——路由名/参数全是 string，拼错也不报错。
  5. **插入后**：「当前表」从宽松变成精确，开关条件翻向「按名查表」分支。
  6. 每个公开类型靠「按名索引路由表」拿到该路由**精确**的名字/参数/路径。
  7. 于是用户拼错路由名、漏传/错传参数，在编译期即被 tsc/编辑器拦下。

- **最小原理演示（替代旧"复刻范围"）**：
  - **演示载体建议**：首选 **TS**。本章是**纯类型层机制**（条件类型分发、接口声明合并/模块增强、映射类型），JS 表达不了「类型插槽」与「条件开关」，没有任何其它语言比 TS 更贴切——这是少数「非 TS 讲不透」的章节，无需退回原仓库语言。运行方式：`npx tsc --noEmit demo.ts`（类型无运行时，**编译器即执行器**；tsc 通过 = 机制按预期分发）。配最小 `package.json` 使其能跑。
  - **应演示**：一个只演「权衡 1/2/3」核心思想的从零实现（约 25 行）。**演的是**：①空插槽注入点；②try-infer 否则宽松；③条件开关自动切换；④插入后同一类型从「宽松」变「按名精确」。用类型级断言 + 故意拼错的名字（注释掉的报错行）作为「可执行证据」。
  - **应故意省略**：读/写参数双套（权衡 4，可单独补一个 5 行小片段演 `isRaw`）、`asPath`/`asRelative`/`asResolved` 的多变体并集、`_LiteralUnion` 自动补全技巧、Vue 全局增强（`$route` 等）、库内部三态的全部样板、codegen 的生成逻辑（属第 16 章）。
  - **演示骨架（Writer 据此执行，名字已概念化以聚焦原理；与源码符号的对应见下方「概念要点」）**：

    ```ts
    // 演权衡 1/2/3：空插槽注入点 + try-infer + 条件开关 + 三态
    // 运行：npx tsc --noEmit   （编译器通过 = 机制成立）
    interface TypeSlots {}                       // ① 注入点：发布时空空如也

    interface RouteInfo<N extends string = string, P = Record<string, string>> {
      name: N; params: P
    }
    type TableLoose = Record<string, RouteInfo>  // 宽松表（所有字段的最大上界）

    // ② 灵魂：试着从插槽推断「路由名表」，拿不到就退宽松
    type Table = TypeSlots extends Record<'RouteNameMap', infer R> ? R : TableLoose

    // ③ 三态：Typed(按名) + TypedList(查表)
    interface LocTyped<T, K extends keyof T> { name: K; params: T[K]['params'] }
    type LocTypedList<T> = { [K in keyof T]: LocTyped<T, K> }

    // ③ 开关：宽松表还兼容当前表吗？是→宽松兜底；否→按名精确
    type Loc<K extends keyof Table = keyof Table> =
      TableLoose extends Table ? { name?: string; params?: Record<string, string> }
                              : LocTypedList<Table>[K]

    // 场景 A：未增强 —— 一切退 string
    type A = Loc<'home'>   // { name?: string; params?: Record<string, string> }

    // ② 模拟 codegen：declare module 增强（同文件内等价于接口合并）
    interface TypeSlots {
      RouteNameMap: {
        home: RouteInfo<'home', {}>
        user: RouteInfo<'user', { id: string }>
      }
    }
    // 场景 B：增强后，同一类型自动精确
    type B = Loc<'user'>   // { name: 'user'; params: { id: string } }
    // type Typo = Loc<'usr'>  // ❌ 编译期报错：'"usr"' 不在 'home'|'user' 中

    // 类型级断言（tsc 通过即证明分发正确）
    type Eq<X, Y> = [X] extends [Y] ? ([Y] extends [X] ? true : false) : false
    declare const a: Eq<A, { name?: string; params?: Record<string, string> }>
    declare const b: Eq<B, { name: 'user'; params: { id: string } }>
    export {}
    ```

- **正文不宜展开的细节**：`_LiteralUnion`（`字面量 | (string & {})` 保自动补全又允许任意串）、`Extract<Name, string|symbol>`（滤掉 keyof 产生的 number）、`asPath`/`asRelative`/`asString`/`asResolved` 各自的三态样板、Vue 全局增强里 `$route`/`$router`/`RouterView`/`RouterLink`/`beforeRoute*` 这些**同模式但非路由表**的插槽（一句话带过即可）、`ChildrenNames` 类型参数的历史兼容 wart、实验性 `_ParamParsers`/`_RouteFileInfoMap` 插槽。供 Writer 裁剪。

- **推荐的一个执行轨迹例子**：
  - 输入：用户**没接**类型生成 → 插槽为空。
  - 中间态：`Table` = 宽松表；`push({ name: 'usr' })` 类型层**不报错**（名字退化为 string）。
  - 接入类型生成后：生成的 `.d.ts` 用 `declare module` 把 `RouteNameMap` 插入插槽。
  - 输出：`Table` = 精确表 `{ home, user:{id} }`；`push({ name: 'usr' })` **报错**「'usr' 不在 'home'|'user' 中」；`push({ name:'user', params:{ id: 123 } })` 通过（走 raw 侧，id 允许 number）；`route.params.id` 推断为 `string`（走 decoded 侧）。

> 以上钩子供 Writer 写「动机→核心思想→心智模型→关键权衡→原理演示」；下面事实部分供核对，不要被 Writer 当目录照抄。

## 概念要点

> 演示概念名 ↔ 源码符号映射：`TypeSlots`=`TypesConfig`；`RouteInfo`=`RouteRecordInfo`；`TableLoose`=`RouteMapGeneric`；`Table`=`RouteMap`；`Loc/LocTyped/LocTypedList`=`RouteLocation`/`RouteLocationTyped`/`RouteLocationTypedList`；`RouteNameMap` 插槽=`RouteNamedMap`。

- **注入点本身就是一个空接口**（全章起点）：库只声明 `export interface TypesConfig {}`，无任何字段、标记为 `@internal`、注释列出可被替换的全部条目。源码位置: packages/router/src/config.ts:1-15
- **核心：从注入点 try-infer 路由名表**：`RouteMap = TypesConfig extends Record<'RouteNamedMap', infer R> ? R : RouteMapGeneric`。注入点空时 `extends Record<'RouteNamedMap', infer R>` 判定为假，退回 `RouteMapGeneric`；被增强后判定为真，取增强进来的精确表。源码位置: packages/router/src/typed-routes/route-map.ts:44-47
- **每条路由的编译期描述符**：`RouteRecordInfo<Name, Path, ParamsRaw, Params, ChildrenNames>`，五个类型参数都有「宽松」默认值（Name=string、Path=string、Params*=泛型参数表、ChildrenNames=never）。codegen 为每条路由填入精确值。源码位置: packages/router/src/typed-routes/route-map.ts:8-29
- **三态样板（以 RouteLocation 为例）**：`RouteLocationGeneric`（无表参数，库内部默认）、`RouteLocationTyped<RouteMap, Name>`（按名精确，`params: RouteMap[Name]['params']`）、`RouteLocationTypedList<RouteMap> = { [N in keyof RouteMap]: RouteLocationTyped<RouteMap, N> }`（按名查表）。源码位置: packages/router/src/typed-routes/route-location.ts:21-52
- **条件开关（每个公开类型都重复一次）**：`RouteLocation<Name> = RouteMapGeneric extends RouteMap ? RouteLocationGeneric : RouteLocationTypedList<RouteMap>[Name]`。`asPath/asRelative/asNormalized/asResolved/asString` 与 `RouteLocationRaw` 全部沿用同一开关；typed 分支里 `RouteLocationAsString` 还套一层 `_LiteralUnion` 保字面量自动补全。源码位置: packages/router/src/typed-routes/route-location.ts:262-335, 309-313
- **同一注入机制被全库复用（关键泛化）**：下列公开类型全部走 `TypesConfig extends Record<'插槽', infer T> ? T : 默认` 的**同一**模式，证明空接口是「全库类型插件注册表」而非 typed-routes 专属：`Router`（实验性 Router 替换，router.ts:141-142）、`$route`/`$router`/`RouterView`/`RouterLink`/`beforeRouteEnter`/`beforeRouteUpdate`/`beforeRouteLeave`（Vue 全局增强，index.ts:184-234）、`_ParamParsers`/`_RouteFileInfoMap`（实验性解析器，experimental/runtime.ts:34, 131-132）、`Error`（数据加载器错误类型，experimental/data-loaders/types-config.ts:20-21）。源码位置: packages/router/src/index.ts:170-237, packages/router/src/router.ts:126-142
- **读/写参数双态由布尔类型参数驱动**：`ParamValue<isRaw>` 用 `true extends isRaw ? string|number : string` 分支；`ParamValueZeroOrOne`（`:id?`）、`ParamValueZeroOrMore`（`:id*`）、`ParamValueOneOrMore`（`:id+`）同理。raw 侧允许 number/可空/元组，decoded 侧统一 string。`RouteParams<Name>` 与 `RouteParamsRaw<Name>` 分别取描述符的 `params`/`paramsRaw`。源码位置: packages/router/src/typed-routes/params.ts:7-53
- **守卫签名也搭乘类型注入**：`NavigationGuard.to: RouteLocationNormalized`、`from: RouteLocationNormalizedLoaded`、`NavigationGuardReturn = void|Error|boolean|RouteLocationRaw`——这些类型本身已在上游被开关切换，守卫签名无需自己处理 generic/typed。源码位置: packages/router/src/typed-routes/navigation-guards.ts:15-66
- **自动补全技巧 `_LiteralUnion`**：`LiteralType | (BaseType & Record<never, never>)`——`Record<never, never>` 即 `{}`，`string & {}` 既可赋值任意串、又让 TS 在补全里优先展示字面量成员。源码位置: packages/router/src/types/utils.ts:5-7
- **聚合出口**：`typed-routes/index.ts` 仅 `export type *` 汇出 params/route-map/route-location/route-records/navigation-guards 五个子模块（纯类型，无运行时）。源码位置: packages/router/src/typed-routes/index.ts:1-6

## 关键调用链

类型推导链（纯类型层，无运行时调用）：

```
codegen 生成 RouteNamedMap
  → declare module 'vue-router' { interface TypesConfig { RouteNamedMap: ... } }   (外部增强)
  → RouteMap = TypesConfig extends Record<'RouteNamedMap',infer R> ? R : RouteMapGeneric   (try-infer)
  → RouteLocation<Name> = RouteMapGeneric extends RouteMap ? Generic : RouteLocationTypedList<RouteMap>[Name]   (开关)
  → RouteLocationTypedList<RouteMap>[Name] → RouteLocationTyped<RouteMap,Name> → params: RouteMap[Name]['params']   (按名索引到精确参数)
```

外部增强入口（codegen 侧，属第 16 章，此处只标契约）：`declare module 'vue-router' { interface TypesConfig { RouteNamedMap: import('vue-router/auto-routes').RouteNamedMap; _RouteFileInfoMap: ...; _ParamParsers: ... } }`。源码位置: packages/router/src/unplugin/codegen/generateDTS.ts:60-72

## 源码摘录（带行号，全文累计 ≤ 30 行）

注入点（全章起点，空接口）：
```ts
// packages/router/src/config.ts:15
export interface TypesConfig {}
```

try-infer（灵魂：拿不到路由名表就退宽松）：
```ts
// packages/router/src/typed-routes/route-map.ts:44-47
export type RouteMap =
  TypesConfig extends Record<'RouteNamedMap', infer RouteNamedMap>
    ? RouteNamedMap
    : RouteMapGeneric
```

条件开关（每个公开类型都重复一次）：
```ts
// packages/router/src/typed-routes/route-location.ts:262-265
export type RouteLocation<Name extends keyof RouteMap = keyof RouteMap> =
  RouteMapGeneric extends RouteMap
    ? RouteLocationGeneric
    : RouteLocationTypedList<RouteMap>[Name]
```

编译期每路由描述符（codegen 为每条路由填精确值）：
```ts
// packages/router/src/typed-routes/route-map.ts:8-26
export interface RouteRecordInfo<
  Name extends string | symbol = string,
  Path extends string = string,
  ParamsRaw extends RouteParamsRawGeneric = RouteParamsRawGeneric,
  Params extends RouteParamsGeneric = RouteParamsGeneric,
  ChildrenNames extends string | symbol = never,
> {
  name: Name; path: Path; paramsRaw: ParamsRaw; params: Params; childrenNames: ChildrenNames
}
```

读/写参数双态由布尔类型参数驱动：
```ts
// packages/router/src/typed-routes/params.ts:32-34
export type ParamValue<isRaw extends boolean> = true extends isRaw
  ? string | number
  : string
```

外部增强入口（codegen 把路由名表「插」进空接口；生成细节属第 16 章）：
```ts
// packages/router/src/unplugin/codegen/generateDTS.ts:60-71
declare module 'vue-router' {
  interface TypesConfig {
    _ParamParsers: { /* …自定义参数解析器… */ }
    RouteNamedMap: import('${routesModule}').RouteNamedMap
    _RouteFileInfoMap: import('${routesModule}')._RouteFileInfoMap
  }
}
```

（以上 6 段共约 24 行。）

## 易混淆 / 边界 / 推断

- **事实（注入点的可达性约束）**：codegen 必须把 `RouteNamedMap` 接在用户**总会引入**的模块（`vue-router`）上，而不是接在虚拟模块（`vue-router/auto-routes`）上——否则用户没 import 那个虚拟模块时增强不生效。源码注释明言「typed routes must work when the user never imports `vue-router/auto-routes`」。源码位置: packages/router/src/unplugin/codegen/generateDTS.spec.ts:79-83
- **推断（开关的隐式契约）**：`RouteMapGeneric extends RouteMap` 这个开关之所以成立，依赖「宽松表是任何精确表的超集」这一**隐式不变量**。若有人绕过 try-infer 直接把 `RouteMap` 设成精确表，`RouteMapGeneric extends RouteMap` 仍可能为真而误走宽松分支——所以 try-infer 必须是 `RouteMap` 的**唯一**定义来源。源码位置: packages/router/src/typed-routes/route-map.ts:44-47
- **事实（取所有路由名的正确姿势）**：`RouteRecordName` 类型「评估过早」，常退化为 generic 版；要拿所有路由名的精确联合，应用 `keyof RouteMap` 而非 `RouteRecordName`。源码位置: packages/router/src/typed-routes/route-records.ts:26-31
- **事实（keyof 的 number 陷阱）**：三态里 `name: Extract<Name, string | symbol>` 的 `Extract` 不是多余的——`keyof` 在某些索引签名下会产生 `number`，需滤掉。源码位置: packages/router/src/typed-routes/route-location.ts:38-39
- **事实（作者自承的 wart）**：`RouteRecordInfo` 的 `ChildrenNames` 默认值取 `never` 是为不破坏兼容，作者注释坦言「it should be the generic version by default instead (string | symbol)」。源码位置: packages/router/src/typed-routes/route-map.ts:15-18
- **边界（不展开）**：实验性特性（data-loaders 的 `Error`、resolver 的 `_ParamParsers`/`_RouteFileInfoMap`）的插槽增强挂在 `vue-router` 还是 `vue-router/experimental` 模块上，codegen 注释提到 v6 计划合并归属——属实验性边界，本章不展开。源码位置: packages/router/src/unplugin/codegen/generateDTS.spec.ts:79-84
- **未理解**：`RouteLocationAsPathTyped` 里被注释掉的 `[key: string]: unknown`（route-location.ts:186-187）——疑似曾尝试让 `.path` 与其他属性共存再做校验，已弃用，原因未在注释说明，留给后续。
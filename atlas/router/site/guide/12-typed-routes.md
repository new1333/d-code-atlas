# 类型安全路由的编译期推导

你大概写过这样的代码：

```ts
router.push({ name: 'usr', params: { id: 123 } })
```

把 `user` 拼成了 `usr`，编辑器一声不吭；等你跑到浏览器，页面白屏，控制台甩出一个 `No match found for location with name "usr"`。你得一路往回翻，才发现是名字少了一个字母。参数漏传、类型不对，也都是同样的剧情——错误离根因太远了。

理想的样子是：路由名能自动补全，拼错、漏参、类型不对，在你敲键盘或跑 `tsc` 的时候就被拦下。本章要讲的就是 vue-router 怎么做到这件事的——而且是在一个看起来不可能的前提下做到的。

## 问题：库根本不认识你的路由表

这里的别扭在于：路由表是你自己声明的，甚至是一堆 `.vue` 文件被构建工具扫出来的。vue-router 作为一个库，发布的时候根本不知道你的项目里有哪些路由、每条路由叫什么、带哪些参数。

可它又想做到「你接了类型生成就全链路精确，没接就退化为宽松的 `string`」。这两件事怎么同时成立？答案是：**把「是否启用类型推导」本身做成一个可选的、纯类型层面的注入**。库不主动知道你的路由表，但它留个口子，等你把表「插」进来。

## 第一步：留一块空的「类型公告板」

整个机制的起点，是一个空接口：

```ts
export interface TypesConfig {}
```

就这一行。没有字段，没有任何标记，注释里标着「仅供内部使用」，还顺手列了一串「以后可以被替换的条目」。

把它想象成挂在公共走廊的一块公告板。库发布的时候，这块板是空的——谁都能往上贴便条，但默认啥也没有。这就是全章的地基：一个什么都不说的接口，却成了所有可配置类型的总入口。

## 第二步：试着从公告板上抄，抄不到就退宽松

光有空公告板没用，还得有人去读它。读法是 TypeScript 的条件类型推断：

```ts
export type RouteMap =
  TypesConfig extends Record<'RouteNamedMap', infer RouteNamedMap>
    ? RouteNamedMap
    : RouteMapGeneric
```

说人话就是：**公告板上贴没贴名为 `RouteNamedMap` 的便条？贴了，就照抄那张便条的内容；没贴，就用 `RouteMapGeneric` 这个宽松兜底。**

`RouteMapGeneric` 长这样——把所有字段都放到最宽的上界：

```ts
export type RouteMapGeneric = Record<string | symbol, RouteRecordInfoGeneric>
```

换句话说，「没接类型生成」时，`RouteMap` 就是一张「键是任意字符串、每条路由的参数都是任意键值对」的万能表。这正是开箱即用的状态：不报错，但也不精确。

## 第三步：用一个「子类型关系」当开关，而不是一个布尔标志

现在有意思的地方来了。下游每一条对外类型（比如「一个路由位置」），都得在「没人注入过 → 宽松」和「有人注入过 → 按名精确」之间二选一。

直觉上你会想加个布尔标志：「是否启用了类型推导？」但 vue-router 没这么做。它连一个标志都不维护，而是用一个条件判断反推：

```ts
export type RouteLocation<Name extends keyof RouteMap = keyof RouteMap> =
  RouteMapGeneric extends RouteMap
    ? RouteLocationGeneric
    : RouteLocationTypedList<RouteMap>[Name]
```

注意那个条件：`RouteMapGeneric extends RouteMap`——「**那张宽松表，是不是仍然能赋值给当前的 `RouteMap`？**」

- 没人注入时，`RouteMap` 就是 `RouteMapGeneric` 自己，`RouteMapGeneric extends RouteMapGeneric` 成立，走宽松分支。
- 有人注入后，`RouteMap` 变成了精确表 `{ home, user: { id } }`，而一个带索引签名的 `RouteMapGeneric` **不能**赋值给只有具体键的精确表——条件翻转，走按名精确分支。

换来的好处很实在：**零运行时、零额外状态**，纯类型层就把「有生成 → 精确、没生成 → 宽松」的自动切换做完了，而且切换点集中在这一个判断上，下游全部引用它。

代价是语义有点反直觉——你得习惯「用子类型关系来表达是否启用」。它还藏着一个**隐含的脆弱契约**：这个开关之所以成立，全靠「宽松表是任何精确表的超集」这条不变量。所以「试着抄公告板」的 `try-infer` 必须是 `RouteMap` 的**唯一**定义来源。要是有人绕过它，直接把 `RouteMap` 塞成一张精确表，`RouteMapGeneric extends RouteMap` 在某些情况下仍可能为真，开关就会静默地走错分支、退回宽松——而你还浑然不觉。

## 第四步：三态样板，让库内部和对外各取所需

为了配合上面那个开关，每个对外类型都被拆成了三份。拿 `RouteLocation` 举例：

```ts
// ① Generic：不带路由表参数，全用宽松默认。库内部一律用这版
interface RouteLocationGeneric extends _RouteLocationBase, RouteLocationOptions {
  matched: RouteRecord[]
}

// ② Typed：携带路由表、按名精确
interface RouteLocationTyped<RouteMap, Name extends keyof RouteMap>
  extends RouteLocationGeneric {
  name: Extract<Name, string | symbol>
  params: RouteMap[Name]['params']
}

// ③ TypedList：用一次映射类型，把「按名查表」物化成一张大表
type RouteLocationTypedList<RouteMap> = {
  [N in keyof RouteMap]: RouteLocationTyped<RouteMap, N>
}
```

`Extract<Name, string | symbol>` 不是多余的——`keyof` 在某些索引签名下会蹭出一个 `number`，得滤掉。

> 和第 6 章的关系：那章讲的是**运行期**路由记录的五种互斥变体（带不带组件、是不是 redirect……）。本章完全不看运行期结构，只看为类型推导服务的**编译期描述符**——它只关心每条路由的 `name`、`path`、`params` 的类型，长这样：

```ts
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

五个类型参数都有宽松默认值。谁需要精确？由构建工具为每条路由填上具体值，再喂进 `RouteNamedMap`。

三态换来的核心能力：**库内部代码永远用 Generic，绝不被用户的类型注入污染**（否则库自己都编译不过）；对外却能凭一个路由名，一路索引到精确的参数和路径。代价是每个对外类型都得抄三份样板，重复度不低；而且当名字参数缺省（也就是「所有路由的并集」）时，`TypedList[名字]` 会退化成一个超大联合类型，编译器看着就头大。

## 把链路串起来：从 codegen 到编译期报错

整条推导链是纯类型层的，没有任何运行时调用：

```
构建工具扫描路由 → 生成 RouteNamedMap
  → declare module 把它「贴」进 TypesConfig（模块增强）
  → RouteMap：试着从公告板抄，抄到精确表
  → RouteLocation<名字>：开关判定「宽松表还是超集吗？」→ 否 → 按名查表
  → params: RouteMap[名字]['params']   ← 这就是精确参数的来源
  → 用户拼错名字 / 漏传参数 → tsc 编译期报错
```

那张把公告板「贴满」的 `RouteNamedMap`，是构建工具生成的。**它的生成过程是另一章的事**（属于文件路由的类型生成那一篇），本章只讲消费侧——注入与切换的机制，不碰生成。

## 演示：用 TypeScript 把开关跑给你看

这一章是少数「非 TypeScript 讲不透」的内容：条件类型分发、接口声明合并、映射类型，这些在 JS 里根本没有对应物，编译器本身就是执行器。存成 `demo.ts`，跑 `npx tsc --noEmit demo.ts`——`tsc` 不报错，就证明分发按预期工作了。

```ts
// demo.ts —— 空插槽 + try-infer + 条件开关 + 三态
// 运行：npx tsc --noEmit demo.ts   （没有运行时；编译器即执行器）

// ① 注入点：库发布时这块公告板是空的
interface TypesConfig {}

interface RouteRecordInfo<N extends string = string, P = Record<string, string>> {
  name: N
  params: P
}
// 宽松表：所有字段取最宽上界，任何精确表都是它的子类型
type RouteMapGeneric = Record<string | symbol, RouteRecordInfo>

// ② 灵魂一句：公告板上贴没贴 'RouteNamedMap'？贴了照抄，没贴退宽松
type RouteMap =
  TypesConfig extends Record<'RouteNamedMap', infer R> ? R : RouteMapGeneric

// ③ 三态之二：按名精确
interface RouteLocationTyped<T, K extends keyof T> {
  name: K
  params: T[K]['params']
}
// ③ 三态之三：把「按名查表」物化成一张大表
type RouteLocationTypedList<T> = { [K in keyof T]: RouteLocationTyped<T, K> }

// ③ 开关：宽松表还是当前表的超集吗？是→宽松兜底，否→按名查表
type RouteLocation<K extends keyof RouteMap = keyof RouteMap> =
  RouteMapGeneric extends RouteMap
    ? { name: string; params: Record<string, string> }
    : RouteLocationTypedList<RouteMap>[K]

// ═══ 世界一：没接类型生成（公告板为空）═══
// 此时 RouteMap 退成 RouteMapGeneric，开关走宽松分支：
type LooseName = RouteLocation<'随便写啥都行'>['name']   // string
type LooseParams = RouteLocation<'user'>['params']       // Record<string, string>
// 拼错名字也不报错——这正是我们要消灭的痛点

// 类型级断言：tsc 通过 = 世界一的分发正确
type Eq<X, Y> = [X] extends [Y] ? ([Y] extends [X] ? true : false) : false
declare const a: Eq<LooseName, string>
declare const b: Eq<LooseParams, Record<string, string>>

// ═══ 世界二：模拟构建工具用模块增强「插」进精确表 ═══
// ↓↓ 把下面整段取消注释，再跑一次 tsc，世界就翻到「精确」↓↓
//
// interface TypesConfig {
//   RouteNamedMap: {
//     home: RouteRecordInfo<'home', {}>
//     user: RouteRecordInfo<'user', { id: string }>
//   }
// }
//
// type PreciseParams = RouteLocation<'user'>['params']   // { id: string }
// type Typo = RouteLocation<'usr'>['name']
// ❌ 报错：'"usr"' 不在 '"home" | "user"' 之中 —— 编译期拦下，无需运行

export {}
```

这里有个值得点破的细节：**同一份 `RouteLocation` 类型别名，求值结果会随公告板有没有被贴满而改变。** 在同一个文件里，接口声明合并是「最终态」的——所以两个世界不能同时通过 `tsc`：世界一默认通过；取消注释那块增强后，世界一的断言会反过来失败、世界二的精确值才生效。这恰恰是「同一份库代码，有没有注入决定了两种求值结果」的真实写照。现实里这两个世界本来就活在不同的编译单元——库带着空公告板发布，你的项目用 `declare module` 把便条贴上去。

再补一个 5 行小片段，演第四条权衡——读/写两套参数怎么靠一个布尔类型参数切换：

```ts
// 读/写两套参数：一个 isRaw 布尔类型参数，驱动同一套工具类型分两态
type ParamValue<isRaw extends boolean> = true extends isRaw ? string | number : string
type ReadId  = ParamValue<false>   // string        —— 从当前路由读出的 id 永远是 string
type WriteId = ParamValue<true>    // string|number —— 传给 push 的 id 可以直接写 123
// 同一份 ParamValue，靠 isRaw 在「严格解码值」和「便利原始值」间切换
```

## 关键权衡

这一章机制集中，下面把四条核心权衡一次讲透。

**1. 用一个空接口，当全库统一的「类型插槽注册表」。**
选择：所有可配置类型都塞进同一个空 `TypesConfig`，每个消费者用 `TypesConfig extends Record<'我的插槽', infer T> ? T : 默认值` 来取值。换来：库发布即开箱可用（插槽空时全走宽松默认）；外部一条 `declare module` 就能把精确类型无侵入地「插」进来；**多个互不相关的特性——类型化路由、实验性 Router、数据加载器的 `Error` 类型、参数解析器——共用同一套注入基础设施**，不必各造各的开关。代价：每条公开类型都得抄一遍条件类型样板；条件类型求值对编译器有真实开销；路由表一大就类型膨胀、编译变慢。

**2. 用「宽松表是否仍兼容当前表」当开关，而非布尔标志。**
选择：不维护任何「是否启用」的运行时或类型标志，而是用 `RouteMapGeneric extends RouteMap` 这一个子类型判断反推状态。换来：零运行时、零额外状态，纯类型层完成自动切换，且切换点集中一处、下游统一引用。代价：语义反直觉（要用子类型关系表达「是否启用」）；以及前面提过的隐含脆弱契约——「宽松表必须是精确表的超集」一旦被破坏，开关静默失效，`try-infer` 必须独占 `RouteMap` 的定义权。

**3. 每类公开类型都维护 Generic / Typed / TypedList 三态。**
选择：把每个对外类型拆三份——Generic 不带表参数、库内部专用；Typed 携带路由表、按名精确；TypedList 用一次映射类型把「按名查表」物化成大表——再用权衡 2 的开关对外暴露单一类型名。换来：库内部代码不被注入污染（永远用 Generic），对外却能凭一个路由名一路索引到精确的参数/路径；「按名查表」只需一次 mapped type，下游全是查表，不再重复条件判断。代价：每个公开类型三份样板、重复度高；名字参数缺省时，TypedList 的那一格退化成超大联合类型。

**4. 读/写两套参数类型分离（decoded vs raw）。**
选择：每条路由同时携带「读出的参数（严格 `string`，已解码）」和「写入时可传的原始参数（允许 `number`、可空、`:id*` 的元组形态）」，并用一个 `isRaw` 布尔类型参数驱动同一套工具类型在两态间分支。换来：「从当前路由读 `params`」与「传给 `push` 的 `params`」语义精确分离——读侧永远是 `string`，写侧允许便利的 `number` 和元组；同一份工具类型复用，不必写两遍。代价：参数类型维度直接 ×2，类型层稍复杂；布尔类型参数驱动条件分支的写法，对不熟的人偏 trick。

## 这套注入不只服务路由表

`TypesConfig` 这块公告板，是「全库类型插件注册表」，不是 typed-routes 的私产。同一个 `extends Record<'插槽', infer T> ? T : 默认` 的套路，被反复用在毫不相干的地方：`Router`（换成实验性 Router 的类型）、`$route` / `$router`（Vue 全局增强）、`RouterView` / `RouterLink`、组件内的 `beforeRouteEnter` / `Update` / `Leave`、实验性的 `_ParamParsers` / `_RouteFileInfoMap`，甚至数据加载器的 `Error` 类型。它们都搭同一辆车：没人增强就走默认，有人增强就替换。

> 和第 7、第 9 章的关系：守卫怎么串成 promise 链、怎么把 `next` 回调 promise 化，第 7 章已展开，这里不重复；本章只补一句——守卫签名里的 `to: RouteLocationNormalized`、`from: RouteLocationNormalizedLoaded`、返回值里的 `RouteLocationRaw`，**这些类型本身就已经是被上面那套开关切换好的产物**，守卫自己完全不用处理 generic/typed。第 9 章讲的 `$router` / `$route` 在运行期怎么 `provide` 进组件树，是运行时接线；本章讲的是这些全局标识符的**类型**怎么被同一套公告板替换——一个管跑起来，一个管类型对不对。

## 小结

回头看，整套机制就一句话：**留一个空接口当类型插槽，让外部用模块增强把路由表插进来；每条公开类型都用一个条件判断，自动在「没插 → 宽松兜底」和「插了 → 按名精确」之间切换。**

于是用户拼错路由名、漏传或错传参数，在编译期就被 `tsc` 和编辑器拦下，而不是等到运行时白屏。代价也清晰：三态样板、条件类型求值开销、大路由表的类型膨胀，以及那条需要小心守护的「宽松表是超集」隐含契约。

不过这一章只讲了消费侧——公告板怎么读、开关怎么翻。那张精确的 `RouteNamedMap` 到底从哪来、构建工具怎么扫描文件生成它，是下一章「文件路由：约定与前缀树」要拆开讲的事：它先把散落的路由文件整理成一棵表达父子拓扑的树，那张表就是从这棵树上长出来的。
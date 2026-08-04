# 文件路由：类型生成与构建期集成

你刚在 `pages/users/[id].vue` 里写好一个用户详情页。你希望接下来发生几件事：敲 `router.push({ name: '...' })` 时编辑器能自动补全路由名，写 `params` 时能检查字段对不对，改了这个文件不用整页刷新——最好连 dev server 都不用重启。

但问题马上就来了：**路由表是从磁盘文件扫出来的、要等构建期才存在的数据**。你写代码的时候，编辑器看不见它；程序跑起来的时候，它才被组装出来。这就尴尬了——信息产生在构建期，类型检查发生在编码期，路由消费又发生在运行期，三个时间点完全错位。

如果不解决这个错位，用户要么手写一份和文件重复的路由声明（改一处得改两处），要么干脆放弃类型安全，外加每次改文件都手动重启。

核心思想一句话：**把构建期扫出来的那棵路由树当成唯一事实源，一次性投影成三种产物——运行时能跑的路由数组、编辑器能查的类型表、（实验性的）固定匹配器——再用一个"虚拟模块"当作这三者进运行时的入口。** 同一棵树，三张面孔，不会互相打架。

打个比方：虚拟模块就像一个"不存在的文件"。你的代码里写 `import routes from 'vue-router/auto-routes'`，但磁盘上根本没有这个文件——它是打包器在加载阶段当场编出来的。而那棵路由树就是唯一的"真身"，三种产物都从它拓印下来。

下面自底向上拆。

## 一、契约边界：那个不存在的文件

最底层的机制件，是**虚拟模块**。

说人话就是：约定几个"假的模块名"，用户像 import 普通模块一样 import 它们，但这些模块磁盘上根本不存在——是打包器在加载阶段拦截、现场编出来的。

这里约定了两个（还有一个专门用来把 `<route>` 块 stub 掉）：

- `vue-router/auto-routes` → 当场生成运行时路由数组
- `vue-router/auto-resolver` → 当场生成实验性固定匹配器

打包器处理它是两步走：`resolveId` 先把这个裸模块名认领下来（标记"这归我管"），`load` 再按具体是哪个名字，分发到不同的生成函数：

```
import 'vue-router/auto-routes'
        │
        ▼
  resolveId 认领 → 加上虚拟前缀 (\0)
        │
        ▼
  load 按名字分发：
        ├─ 'vue-router/auto-routes'   → 生成运行时路由数组
        ├─ 'vue-router/auto-resolver' → 生成固定匹配器
        └─ 路由块 id                  → 返回空对象（内容已消费，stub 掉）
```

有两个细节特别能说明"为什么这么设计"：

1. **为什么是连字符 `auto-routes`，而不是更自然的斜杠 `auto/routes`？** 因为斜杠形式和 TypeScript 配合不好——TS 看到带斜杠的模块名会按真实路径去磁盘找，找不到就报错。连字符对 TS 来说只是一个普通的裸模块名，它会乖乖等打包器编内容。
2. **TS 不认虚拟模块。** 你 `import` 一个磁盘上不存在的模块，TS 直接报"找不到模块"。所以光有虚拟模块还不够——还得额外生成一份**真实落在磁盘上的类型声明文件**（`typed-router.d.ts`）兜底，让 TS 能读到里面的类型。这个文件顶部特意标了 `@ts-nocheck`（它本身不需要被类型检查，它只是个产物），并提示用户把它提交进仓库、写进 tsconfig。

这就是第一层权衡（文末展开）。一句话：**用虚拟模块换来了"用户像 import 普通模块一样拿路由表"，代价是得绕两道弯——加前缀绕打包器，再生成实体 .d.ts 绕 TS。**

## 二、单源多投影：一棵树，三张面孔

契约边界定好了，剩下的核心动作就一个：**遍历那棵树，投影出三种产物。**

同一个 load 钩子被触发时，会根据虚拟模块名，对同一棵树跑不同的遍历函数：

```
        构建期的路由树（唯一事实源）
                    │
        ┌───────────┼───────────┐
        ▼           ▼           ▼
     投影①       投影②       投影③
   嵌套         扁平         扁平 + 排序
  children    路由名表     匹配记录数组
        │           │           │
        ▼           ▼           ▼
  运行时        类型声明     固定匹配器
  路由数组       .d.ts        (实验)
```

- 投影①（给运行时数组）：遍历树，产出**嵌套的 `children` 结构**，每条记录带 `path / name / component`，组件是 `() => import('...')` 懒加载。
- 投影②（给类型声明）：遍历树，产出**扁平的路由名映射表**——每个路由名一条记录，记下它的完整路径和参数类型。
- 投影③（给固定匹配器）：遍历树，产出**扁平且按优先级排好序**的匹配记录数组。

三张面孔从同一棵树拓印，所以**永远一致、不会漂移**——你绝不会遇到"运行时认得这个路由、类型表里却没有"的鬼故事。

下面用一段极简 TS 演透投影①和投影②（投影③是第 15 章的主角，这里略过）：

```ts
// ===== 唯一事实源：构建期扫出来的那棵树（前置章产物）=====
type RouteNode = { name: string; path: string; file: string }
const tree: RouteNode[] = [
  { name: '/',          path: '/',          file: 'pages/index.vue' },
  { name: '/users/:id', path: '/users/:id', file: 'pages/users/[id].vue' },
]

// ===== 投影①：树 → 运行时路由数组字符串 =====
function genRoutes(tree: RouteNode[]): string {
  const items = tree.map(n =>
    `  { path: ${JSON.stringify(n.path)}, name: ${JSON.stringify(n.name)},`
    + ` component: () => import(${JSON.stringify('/src/' + n.file)}) },`
  ).join('\n')
  return `export const routes = [\n${items}\n]\n`
}

// ===== 投影②：树 → 类型声明字符串（含"模块增强"）=====
function genDTS(tree: RouteNode[]): string {
  const entries = tree.map(n => {
    const params = extractParamTypes(n.path)            // ':id' → { id: string }
    const paramsTS = Object.keys(params).length
      ? `{ ${Object.entries(params).map(([k, v]) => `${k}: ${v}`).join('; ')} }`
      : 'Record<never, never>'
    return `  ${JSON.stringify(n.name)}: RouteRecordInfo<${JSON.stringify(n.name)}, ${JSON.stringify(n.path)}, ${paramsTS}>`
  }).join('\n')
  return `declare module 'vue-router/auto-routes' {
  export interface RouteNamedMap {
${entries}
  }
}
declare module 'vue-router' {
  export interface TypesConfig {
    RouteNamedMap: import('vue-router/auto-routes').RouteNamedMap
  }
}
`
}

// 从路径模式静态派生参数类型：'users/:id' → { id: 'string' }
// （真实实现还要处理 ? * + 修饰符，这里只演示最简单的 :param）
function extractParamTypes(path: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const seg of path.split('/')) {
    const m = seg.match(/^:([^?*+]+)/)
    if (m) out[m[1]] = 'string'
  }
  return out
}

console.log(genRoutes(tree))
console.log('---')
console.log(genDTS(tree))
```

跑一下，你能肉眼看到**同一棵树投影出两种截然不同的文本**——一种是 JS 运行时数组，一种是 TS 类型声明。这就是"单源多投影"的全部魔法。类型声明那段产物长这样：

```ts
declare module 'vue-router/auto-routes' {
  export interface RouteNamedMap {
    "/": RouteRecordInfo<"/", "/", Record<never, never>>
    "/users/:id": RouteRecordInfo<"/users/:id", "/users/:id", { id: string }>
  }
}
declare module 'vue-router' {
  export interface TypesConfig {
    RouteNamedMap: import('vue-router/auto-routes').RouteNamedMap
  }
}
```

注意最后那个 `declare module 'vue-router' { interface TypesConfig {...} }`——这是整章的点睛之笔，下一节展开。

## 三、把路由表"反向注入"库的类型配置

这一节是承前的。**"空接口 + 条件类型当可选注入点"这个设计本身，第 13 章已经讲透**——那里解释了为什么 vue-router 内部要留一个空的 `TypesConfig` 接口、为什么所有对外类型都用条件类型去"读"它、为什么要维护 Generic / Typed / TypedList 三态。**本章只看这个注入点的"填充侧"：谁来填、用什么填、在构建期何时填。**

谁来填？就是上节那段 `genDTS` 生成的代码。它做的事可以叫"**反向注入**"：通常你是 `import` 库的类型来用，这里反过来，是构建期生成的产物去**修改库内部的类型**——往那个空的 `TypesConfig` 接口里塞进真实的 `RouteNamedMap`。

再打个比方：`TypesConfig` 就像一块挂在公共墙上的留言板，库里所有条件类型都盯着这块板子决定自己该长什么样。codegen 之前板子是空的，条件类型全都退回默认值（路由名 = `string`）；codegen 之后板子上写满了真实路由名，条件类型瞬间收窄成精确的字面量联合。

下面这段演示能让你**当场看到注入前后的差异**。我们用同名的 `interface` 合并来模拟 `declare module` 的效果（TS 里同名 interface 会自动合并，这正是模块增强的底层机制）：

```ts
// 极简的库类型（真实库里 RouteRecordInfo 有 5 个类型参数，这里只用 3 个演示）
interface RouteRecordInfo<Name, Path, Params> { name: Name; path: Path; params: Params }

// ===== 库内部（vue-router 源码侧）：一个空接口 + 一个盯着它的条件类型 =====
interface TypesConfig {}
type RouteName<C = TypesConfig> =
  C extends { RouteNamedMap: infer M } ? keyof M : string

type Before = RouteName        // => string  （注入前）

// ===== 模拟 codegen 生成的"模块增强"：往留言板上写字 =====
interface TypesConfig {
  RouteNamedMap: {
    '/':          RouteRecordInfo<'/', '/'>
    '/users/:id': RouteRecordInfo<'/users/:id', '/users/:id', { id: string }>
  }
}

type After = RouteName         // => '/' | '/users/:id'  （注入后，收窄！）
```

`Before` 是 `string`，`After` 是 `'/' | '/users/:id'`——**同一行类型定义 `RouteName` 一字未改，仅仅因为 `TypesConfig` 被填了内容，结果就从"任意字符串"收窄成了"只有这两个字面量"。**

这就是为什么你在组件里写 `router.push({ name: '/users/:id', params: { id: 123 } })` 时，编辑器能检查路由名对不对、`id` 字段在不在——这些信息不是 vue-router 自带的，是构建期从你的文件树扫出来、再反向注入回去的。

## 四、逃逸舱的构建期处理：definePage 宏的双面变换

前一章讲过文件路由"约定优先 + 多层逃逸舱"的设计——文件名约定不够用时，可以用 `<route>` 块、`definePage()` 宏、`extendRoute` 钩子来覆盖。**多来源深合并这个机制本身第 14 章已展开**，这里只看：`definePage` 这个宏在 codegen 阶段被怎么处理。

`definePage()` 长得像个运行时函数调用：

```vue
<script setup>
definePage({
  name: 'user-detail',                    // 能影响路由树拓扑
  path: '/u/:id',                         // 能影响拓扑
  alias: ['/user/:id'],                   // 能影响拓扑
  meta: { requiresAuth: role.isAdmin },   // 可引用组件内变量
})
</script>
```

但**它其实是个编译期宏**——运行时组件里不该残留它。codegen 对它做的是"双面变换"，关键判据是：**这条属性，能不能在不碰组件作用域的前提下得到值？**

- 能影响路由树拓扑的属性（`name / path / alias / params`）**必须是字面量**。这些在树构建期被**静态抽取**出来，直接进类型推导和路由树。正因为必须是字面量，抽取时一旦撞上非字面量就会报错。
- 其余属性（如 `meta`）**允许引用组件里 import 进来的东西**（比如 `role.isAdmin`）。这些没法静态抽取——它们走另一条路：**整个 `definePage` 对象被提取成一个独立的模块**（`export default {...}`），在运行时和按约定生成的记录做深合并。

为什么要拆成两条路？因为前者要进类型（类型必须编译期已知），后者要引用运行时变量（变量编译期还不存在）。说人话就是：**能进类型的进类型，能引用变量的留到运行时——同一份配置，按"能不能在编译期确定"被劈成两半，各走各的。**

代价随之而来：被整体提取成独立模块的那部分，**不能再引用组件 `setup` 作用域里的局部变量**——一旦跨了模块边界，那些变量就找不到了，引用会断裂。所以 codegen 会专门做一道作用域校验：发现 `definePage` 引用了 setup 里的局部变量，就报错并把它的运行时部分降级成空对象。这是第三层权衡（文末展开）。

## 五、固定匹配器的构建期物化（简述）

第 15 章是"新一代路由解析器"的主场——它讲透了**为什么要把路由表做成构建期固定、无运行时增删，为什么用 path / query / hash 三段分别匹配，为什么用抛异常当"不匹配"的统一控制流**。**本章只看一个新侧面：这张固定表是怎么在 codegen 阶段从树物化出来的。**

物化时有一个细节特别能说明问题：**路由的匹配优先级排序，被从运行时匹配器"移植"了一份到 codegen。** 实现里的注释直接写着"移植自 pathParserRanker"。这么做是为了让生成的匹配表一出来就排好序——运行时拿到的是一张静态有序的数组，匹配时零排序开销。这是第四层权衡（文末展开）：换来运行时零开销，代价是同一套排序语义存在两份实现，有双重维护、二者偏离的风险。

## 六、不刷新页面的路由热替换

最后一块拼图：你改了一个 `.vue`，怎么做到不刷新整页就更新路由？

```
磁盘文件改动
    │
    ▼
监听器：重写类型声明文件（只有内容真变了才写盘）
    │
    ▼
让打包器重载那个虚拟模块
    │
    ▼
虚拟模块内部的 import.meta.hot.accept 回调触发：
    1. 从 import.meta.hot.data 取出之前存的路由器实例（跨重执行边界）
    2. router.clearRoutes()                       // 清空旧表
    3. for (route of 新表) router.addRoute(route)  // 逐条加新的
    4. router.replace({ ...当前路由, force: true }) // 强制重匹配当前路由
    │
    ▼
页面不刷新，路由表已热替换
```

两个关键设计：

1. **只在声明内容真变了才写盘 + 重载**——你只改了组件 `<template>`、路由声明没动，就不会触发路由重载，避免"随便改个样式也重载路由"的浪费。
2. **路由器实例靠 `import.meta.hot.data` 跨边界存活**——虚拟模块每次重载都是一次全新执行，普通变量会丢；`hot.data` 是打包器专门留的"跨执行持久化口袋"，用来存那个已经挂载好的路由器实例。

> 一个诚实的小盲点：这个机制里有个 `ROUTES_LAST_LOAD_TIME`（上次加载时间戳），每次 load 虚拟模块都会 `.update()` 它，但在本次精读的文件范围内没找到谁在读它的 `.value`——推测是供外部（类型插件或 HMR 辅助）判断新鲜度用的，留待后续核对。

## 关键权衡

这一章机制密集，挑四条最能说明"为什么这么设计"的展开。前三条是主线。

**权衡一：单一事实源（那棵路由树）→ 一次性多目标投影**

- **选择**：路由定义只在文件系统里维护一处，构建期把同一棵树投影成运行时数组、类型表、匹配器三种产物。
- **换来**：三者天然永远一致，不会漂移——你绝不会遇到"运行时认得这个路由、类型表却查不到"。改文件一处，三张面孔同步更新。
- **代价**：构建期要对同一棵树遍历多次、生成大量字符串代码；路由一多，类型声明文件会膨胀到很大、拖慢 TS 编译（类型膨胀的代价第 13 章已建立，这里复用）。
- **一句话**：用"构建期多干点活"换"运行时启动快、编码期不出错"。一处的活，换三处的省心。

**权衡二：用虚拟模块当入口，而不是手写 routes / 生成实体 .ts**

- **选择**：约定几个不存在的"假模块名"（`vue-router/auto-routes` 等），让用户像 import 普通模块一样拿到路由表。
- **换来**：用户享受打包器的一切好处——tree-shaking（没用的路由不进 bundle）、类型推导、HMR；而且磁盘上不产生需要用户手动维护的中间文件。
- **代价**：必须处理虚拟模块在"各类打包器"和"TS"两套体系下的解析差异——打包器侧要加 `\0` 前缀认领，TS 侧干脆不认虚拟模块，只好再额外生成一份实体 `.d.ts` 兜底。同一个"拿路由表"的需求，绕了两道弯。
- **一句话**：换来"像用普通模块一样用路由"，代价是"底层得伺候两套解析器"。

**权衡三：definePage 宏的双面变换**

- **选择**：宏里能影响拓扑的字面量属性（name/path/alias/params）在构建期静态抽取进类型；其余属性整体提取成独立模块、运行时深合并。
- **换来**：路由名、路径、参数这些"决定树结构"的东西在构建期就生效、直接进类型推导；而 `meta` 这类需要引用组件变量的属性，仍能在运行时和按约定生成的记录合并——两边都不委屈。
- **代价**：同一份配置要走两条代码路径；而且被提取成独立模块的那部分，**禁止引用组件 `setup` 作用域的局部变量**（跨模块后引用断裂），需要专门一道作用域校验，违反就报错降级。
- **一句话**：用"配置劈成两半各走各的"换"类型能精确、变量能引用"，代价是"两条路径 + 作用域校验"。

**权衡四：把匹配优先级排序从运行时移植到 codegen**

- **选择**：把运行时匹配器那套"按二维 score 排序"的逻辑，照搬一份到构建期 codegen，让生成的固定匹配表一出来就是有序的。
- **换来**：运行时拿到的是静态有序数组，匹配时零排序开销——和第 15 章"构建期固定路由表"的目标严丝合缝。
- **代价**：同一套排序语义现在有两份实现（运行时 ranker + codegen 比较函数），双重维护，存在二者偏离的风险——代码里那几处 TODO/FIXME 暗示作者自己也清楚这点。

## 小结

这一章把第 14 章扫出来的那棵路由树，变成了三种能用的东西。整条链路收束成一句话：**路由信息本质是构建期才知道的数据，但只要把它当成唯一事实源、一次性投影到运行时 / 编码期 / 匹配器三个时间点，三个时间点就不再错位。**

你在这章看到的几个反复出现的设计取向，其实是同一个哲学的不同侧面：**把能在构建期确定的事，都尽量推到构建期**——路由表构建期固定、参数类型构建期推导、排序构建期物化、类型注入构建期填充。动态性被一步步从运行时往前挪，换来的全是"启动更快、编码更安全"。代价也很统一：构建期更重、生成的产物更大、同一套语义有时得维护两份。

这是全书最后一章。回看整条线：从最底层的一段 URL 编码、一条路径模式的优先级评分，一路搭到导航状态机、嵌套视图、类型推导，最后落到这章——文件系统里的一个个 `.vue`，怎么自动变成一套类型安全、热更新、零配置启动的路由。路由此处闭环。
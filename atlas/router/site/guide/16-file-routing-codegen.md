---
title: 文件路由：类型生成与构建期集成
---

# 文件路由：类型生成与构建期集成

> 本章属于 system 层。前置：「文件路由：约定与前缀树」「类型安全路由的编译期推导」「新一代路由解析器」。
> 学完你能：讲清为什么文件路由要做成构建期三产物投影，并用一个虚拟模块当运行时与构建期之间的契约边界。

## 1. 为什么需要它（设计动机）

上一章讲了「新一代路由解析器」，把路由表「构建期固定、无运行时增删」，让 path/query/hash 三段在匹配层各自负责——但它留下的口子是：那张「构建期固定」的表，到底是哪一步生成的、从什么东西变出来的？本章接着这个口子讲。

回到用户的真实场景：用户写完一个 `pages/users/[id].vue` 文件，期待三件事同时成立——`router.push({ name: '/users/:id', params: { id: 123 } })` 的参数能被编辑器检查；不需要再手写一份 routes 数组跟这个文件重复维护；改了文件不刷新页面、路由能直接热替换。

但这三件事分别发生在三个时间点：

- 编辑器检查发生在**编码期**（写代码时）；
- 路由消费发生在**运行期**（用户访问页面时）；
- 路由信息本身——磁盘上有哪些文件、文件名长什么样——是**构建期**才知道的数据。

三条时间线对不上：编辑器在写代码时看不到运行时才存在的路由表，运行时拿不到「文件系统扫描出来的那一刻」之外的状态。如果按传统做法，要么用户手写一份 routes 声明跟文件一一维护（双份维护、容易漂移），要么放弃类型安全。

这个机制就是来解决这条错位的：用一个**虚拟模块**当作「构建期产物」的投递口，再额外生成一份磁盘上的**类型声明文件**，让同一棵路由树同时投递到运行时、编辑器和固定匹配器三个时间点。

## 2. 核心思想

**把从文件系统扫描出的那棵路由树当成唯一事实源；在构建期把它同时投影成「运行时路由数组」「编辑器类型表」「固定匹配器」三种产物；用一个虚拟模块当作三者与运行时之间的契约边界。**

一句话：一棵树、三次投影、三个时间点对齐。

## 3. 心智模型

数据流大概是这样：

1. 文件系统被扫描成一棵带属性的路由树（前置「文件路由：约定与前缀树」已讲过）。
2. 打包器加载阶段拦下一个约定的虚拟模块名，现场调用生成函数。
3. 同一棵树被遍历若干次，分别投影出三份字符串：
   - 运行时路由数组（嵌套 children 结构）
   - 类型声明文件（扁平的路由名映射 + 文件→路由名映射 + 参数类型）
   - 排好序的固定匹配表（扁平、按 score 排序的记录数组）
4. 页面内的路由配置宏（`definePage()`）与 `<route>` 自定义块这两种「逃逸舱」，在树构建期被静态抽取出能影响拓扑的字面量；其运行时部分（如 meta）被变换成一个独立模块，在路由数组里与按约定生成的记录做深合并（多来源深合并机制见前置章）。
5. 类型声明文件通过「模块增强」把路由名映射反向注入库的类型配置接口，库内部的条件类型由此自动从 `string` 收窄为精确字面量联合（注入点本身的设计见前置类型章，这里只看填充侧）。
6. 文件一改动，监听器重写类型声明文件、让打包器重载那个虚拟模块；虚拟模块内部的热更新回调把新路由表热替换进当前路由器实例。

关键的契约点是：那三个虚拟模块名（连字符形式 `vue-router/auto-routes`，不是斜杠 `auto/routes`——源码注释里明说斜杠在 TS 下解析不顺），是构建期与运行时之间的**伪模块**。打包器的 `resolveId` 把这个裸名映射成带虚拟前缀的 id，`load` 钩子按 id 分发到三个生成入口；TS 不认虚拟模块，所以又得额外生成一份磁盘上的 `.d.ts` 兜底。虚拟模块是给打包器看的，磁盘 dts 是给 TS 看的，两份文本同步从同一棵树投影出来。

## 4. 关键权衡

### 单源多投影：用一棵树换三种产物的天然一致

这个机制选择把那棵路由树当**唯一事实源**——只维护这一处，运行时数组、编辑器类型表、固定匹配器都从它投影出来。

换来的是「三者天然永远一致、不会漂移」：用户改了文件名，三份产物都从下一次扫描里重新生成，不存在「routes 数组改了但类型表没改」这种双份维护漂移。

代价是构建期要对同一棵树遍历多次、生成大量字符串代码，类型声明文件可能极大、拖慢编译。大路由表的类型膨胀与编译开销这个代价在前置类型章里已经讲透，本章直接复用。

本质矛盾是「**用户想要单一来源、但三个时间点各需要不同形状的数据**」——单源多投影是用构建期做这个形状转换，让用户感知不到三份产物的存在。

### 虚拟模块当投递口：让构建产物像普通 import 一样被消费

第二层选择是用**虚拟模块**（一个约定的伪模块名）当作路由表的投递口，而不是让用户手写 `routes` 数组、也不是生成一个实体 `.ts` 路由文件给用户维护。

换来的是「用户像 import 普通模块一样拿到路由表」：享受 tree-shaking、类型推导、HMR，并且磁盘上不产生需要用户维护的中间文件——用户改完文件直接生效，没有「中间产物没同步」的中间状态。

代价是必须处理虚拟模块在各类打包器/TS 下的解析差异。打包器那侧靠约定前缀（`\0` 之类）区分虚拟模块；TS 那侧不认虚拟模块，必须额外生成一份磁盘上的实体类型声明文件兜底，顶部带 `@ts-nocheck`，因为它是产物、自己不需要被类型检查。换句话说，运行时模块保住了纯净，但类型那一侧必须有磁盘兜底。

本质矛盾是「**编辑器想要零中间文件、但 TS 必须吃磁盘文件**」——虚拟模块把这个矛盾在运行时和类型侧分别处理：运行时走虚拟模块，类型侧走磁盘 dts。

### 配置宏的双面变换：拓扑属性前移，运行时属性后置

第三层选择针对页面内路由配置宏（`definePage()`）：让它做**双面变换**。

宏在源码里出现，但运行时组件不应残留——它是一个编译期宏，不是运行时函数。变换函数有两种模式，由模块 id 是否带 `?definePage` 查询串区分：

- **静态抽取**：在树构建期，从宏的对象参数里读出 `name`/`path`/`alias`/`params` 这些**字面量**——能影响路由树拓扑与类型的属性，必须能在不引用组件作用域变量的前提下求值（非字面量就发诊断码降级）。这部分进路由树、参与类型推导。
- **整体提取**：宏的整个对象参数被提取成一个独立的「路由配置模块」（`export default {...}`），保留对 import 的引用；运行时与按约定生成的记录做深合并。这一侧装的是 meta 等可引用组件内 import 的属性。

换来的是「**决定树结构的属性在构建期就生效、能直接进入类型推导；而 meta 等可引用组件内变量的属性仍能在运行时合并**」。同一份配置被切到两个时间点：拓扑属性前移到构建期，运行时属性保留在运行时。

代价是同一份配置要走两条代码路径，而且提取模式下必须禁止它引用组件 setup 作用域里的变量——跨模块提取后引用会断裂，需要专门的作用域校验。

本质矛盾是「**用户想要在组件里就近写路由配置（包括 meta），但影响路由拓扑的属性又必须在构建期就有值**」——双面变换是把这个矛盾的字面量侧与运行时侧拆开处理。

### 匹配器排序的构建期移植：换零运行时排序开销

第四层选择来自前置「新一代路由解析器」章留下的口子：那张固定匹配器表，是在 codegen 阶段被排好序物化的。

具体做法是把运行时匹配器那套 `compareScoreArray`/`compareRouteScore` 比较**移植**到 codegen——源码里直接注释标了「移植自 pathParserRanker」。在构建期就把可匹配记录按二维 score 排好，生成静态有序数组；相同 score 时再按路径深度兜底排序保证一致顺序。

换来的是「生成的固定匹配器在运行时零排序开销、表是静态有序的」——这正是前置解析器章「构建期固定、无运行时增删」目标的最终落地。

代价是同一套排序语义存在两份实现：运行时一份、codegen 一份。源码里多处 TODO/FIXME 也暗示作者意识到偏离风险。

本质矛盾是「**运行时匹配器仍要支持动态 `addRoute`，所以排序不能删；但固定匹配器又要在构建期就排好——只能两份并存**」。

## 5. 最小原理演示

下面这段演示只演透两件事：同一棵树如何投影成运行时数组字符串；同一棵树如何投影成 `declare module` 类型注入字符串，并在编码期把库的某个条件类型从 `string` 收窄为字面量联合。前置章的注入点机制本身（空接口 + 条件类型的三态设计）不重演。第三个产物（固定匹配器）的投影原理同构，省略以保持聚焦。

```ts
// 极简路由树：根下挂一个子节点
type RouteNode = {
  name: string
  path: string
  component: string  // 组件文件路径（占位）
  children?: RouteNode[]
}

const tree: RouteNode = {
  name: '',
  path: '/',
  component: 'pages/index.vue',
  children: [
    { name: '/users/:id', path: '/users/:id', component: 'pages/users/[id].vue' },
  ],
}

// 把树投影成「运行时路由数组」字符串
function genRoutes(node: RouteNode, depth = 0): string {
  const indent = '  '.repeat(depth)
  const children = node.children?.map(c => genRoutes(c, depth + 1)).join(',\n') ?? ''
  const childrenLine = children ? `,\n${indent}  children: [\n${children}\n${indent}  ]` : ''
  return `${indent}{
${indent}  path: '${node.path}',
${indent}  name: '${node.name}',
${indent}  component: () => import('${node.component}'),${childrenLine}
${indent}}`
}

console.log('export const routes = [\n' + genRoutes(tree) + '\n]')

// 把树投影成「类型声明」字符串——同一棵树再遍历一次，扁平化成路由名映射
function collectNamed(node: RouteNode, out: RouteNode[] = []): RouteNode[] {
  if (node.name) out.push(node)
  node.children?.forEach(c => collectNamed(c, out))
  return out
}

function genDTS(node: RouteNode): string {
  const named = collectNamed(node)
  // RouteRecordInfo 是库内已定义的类型；演示只示意它的调用形状
  const mapLines = named
    .map(n => `      '${n.name}': RouteRecordInfo<'${n.name}', '${n.path}'>`)
    .join('\n')
  // 关键：用 declare module 把这张表反向注入库的 TypesConfig 接口
  return `// typed-router.d.ts（生成产物，顶部带 @ts-nocheck）
declare module 'vue-router' {
  interface TypesConfig {
    RouteNamedMap: {
${mapLines}
    }
  }
}`
}

console.log(genDTS(tree))
```

把生成的 dts 内容粘进项目、纳入 tsconfig 后，前置类型章留下的「空 `TypesConfig` 接口」就被填上了 `RouteNamedMap`——库内部的条件类型（`TypesConfig extends { RouteNamedMap: ... } ? 精确 : string`）自动从 `string` 收窄为 `'/' | '/users/:id'` 字面量联合。

再附一个极简的「虚拟模块 load 钩子按 id 分发」骨架，演契约边界：

```ts
// 极简 unplugin load 钩子（演示用，省略前缀处理）
function load(id: string): string | undefined {
  // 同一棵树背后，按 virtual id 分发到不同生成函数
  if (id === 'vue-router/auto-routes')   return 'export const routes = [\n' + genRoutes(tree) + '\n]'
  if (id === 'vue-router/auto-resolver') return 'export const resolver = createFixedResolver([...])'
  return undefined
}
```

虚拟模块作为契约边界的「形状」就在这几行：用户写 `import { routes } from 'vue-router/auto-routes'`，打包器拦下、按 id 现场生成、把字符串当模块源码返回。

## 6. 执行轨迹

输入：磁盘上原本只有 `pages/index.vue`；用户新增了 `pages/users/[id].vue`。

1. **构建期建树**：扫描 `pages` 目录，得到一棵树——根 `/`（index）下挂一个 `/users/:id`（users）。
2. **load 虚拟模块**：打包器看到代码里有 `import { routes } from 'vue-router/auto-routes'`，触发 `load('vue-router/auto-routes')`，分发到 `generateRoutes()`，遍历树产出：
   ```js
   export const routes = [
     { path: '/', name: '/', component: () => import('/page/index.vue'), children: [
       { path: '/users/:id', name: '/users/:id', component: () => import('/page/users/[id].vue') }
     ]}
   ]
   ```
3. **同时写类型声明文件**：另一个生成入口 `generateDTS()` 遍历同一棵树产出一份扁平的 `typed-router.d.ts`——里面用 `declare module 'vue-router'` 把 `RouteNamedMap` 注入 `TypesConfig`，并对 `/users/:id` 这一行派生出参数类型 `id: string`。
4. **编码期效果**：用户在某个组件里写 `router.push({ name: '/users/:id', params: { id: 123 } })`，TS 据注入的类型表校验 name 必须是字面量联合、`params.id` 必须是 string。
5. **文件改动（拓扑未动）**：用户编辑 `pages/users/[id].vue` 的 template，监听器先节流地重算 dts 文本——发现内容没变，不写盘、不重载虚拟模块，纯组件体改动只走组件自己的 HMR。
6. **拓扑改动**：用户新增 `pages/users/[id]/settings.vue`，监听器重算 dts 文本——内容变了，写盘 + 重载虚拟模块。虚拟模块的 `import.meta.hot.accept` 回调通过 `import.meta.hot.data.router` 跨重执行边界拿到当前路由器实例，执行 `clearRoutes()` + 逐条 `addRoute(新表)` + `force` 重匹配当前路由，页面不刷新、路由表已热替换。

## 7. 教学简化说明

本章演示故意省略了：虚拟模块前缀（`\0`）的处理细节、`definePage` 宏的 AST 抽取与作用域校验算法、`<route>` 自定义块的三种语言（json5/json/yaml）解析、HMR 跨边界存实例的 `import.meta.hot.data` 完整协议、参数解析器的 raw 检测、固定匹配器三段匹配（path/query/hash）的细节、alias 在 codegen 里新建临时树重新解析、命名视图的多组件 import 生成、写盘节流参数。这些都是工程脚手架与旁路，原理上不增加新思想。

## 8. 小结

到这一步，前置章留下的几个口子都被合流掉了：空接口注入点被填上了 `RouteNamedMap`、固定匹配器的表从树物化出来、多来源深合并落到了 codegen 里与按约定生成的记录做。文件系统不再是路由表的「输入参数」，而是它的**唯一事实源**——所有运行时与编码期需要的数据都从这棵树投影出来。本章是全书的末章：从 URL 编码一路到文件路由的整套机制拼图，到这里就完整了。

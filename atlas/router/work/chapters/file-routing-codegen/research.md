# 文件路由：类型生成与构建期集成 · 源码精读

## 给 Writer 的教学钩子（必填，8 子项缺一不可）

- **用户痛点 / 场景**：文件路由的用户写完一个 `.vue` 页面文件后，希望「路由名能自动补全、`router.push()` 的参数能被编辑器检查、改了文件不用整页刷新」——但路由表是从文件系统扫描出来的、运行时才存在的数据，编辑器和编译器在写代码时根本看不见它。如果没有构建期集成，用户要么手写一份与文件重复的路由声明（双份维护），要么放弃类型安全，且每次改文件都得手动重启 dev server。

- **一句话核心思想**：**把从文件系统扫描出的那棵路由树，当成唯一事实源，在构建期把它同时投影成「运行时路由数组」「编辑器类型表」「固定匹配器」三种产物，并用一个虚拟模块当作这三者与运行时之间的契约边界。**

- **设计动机（为什么需要它）**：前一 章（『文件路由：约定与前缀树』）解决的是「如何把文件系统变成一棵带属性的路由树」；本章解决的是「这棵树如何变成运行时能跑、编辑器能查、改动能热替换的东西」。它的核心矛盾是：路由信息本质是**构建期才知道的数据**（取决于磁盘上有哪些文件），但类型检查和编辑器补全发生在**编码期**，路由消费又发生在**运行期**——三者时间线错位。本章用一个虚拟模块作为「构建期产物」的投递口，并额外生成一份可被编译器读取的类型声明文件，把同一棵树投影到三个时间点。其中「用模块增强把路由名映射反向注入库的类型配置接口」这一招，是前置类型章（『类型安全路由的编译期推导』）建立的「可选类型注入点」机制的**填充侧**——（已在第 13 章『类型安全路由的编译期推导』讲透注入点本身的三态设计，本章只看它的新侧面：**谁来填这个注入点、用什么数据填、在构建期何时填**）。而「构建期就把匹配器记录按优先级排好序、物化成固定匹配表」则是前置解析器章（『新一代路由解析器』）的**生产侧**——（已在第 15 章『新一代路由解析器』讲透固定路由表与三段匹配，本章只看它的新侧面：**这张固定表是如何在 codegen 阶段从树物化出来的**）。

- **关键权衡（本 Atlas 的核心）**：
  1. **单一事实源（那棵路由树）→ 多目标一次性投影** → 换来了「路由定义只维护一处（文件系统），运行时数组、编辑器类型表、匹配器三者天然永远一致、不会漂移」 → 代价是「构建期要对同一棵树遍历多次、生成大量字符串代码，类型声明文件可能极大、拖慢编译」（类型膨胀的代价已在第 13 章建立，此处复用）。
  2. **用一个虚拟模块当作路由表的投递口（而非让用户手写 `routes` 数组、也非生成一个实体 `.ts` 路由文件）** → 换来了「用户像 import 普通模块一样拿到路由表，享受 tree-shaking、类型推导、HMR，且磁盘上不产生需要用户维护的中间文件」 → 代价是「必须处理虚拟模块在各类打包器/TS 下的解析差异（加专门前缀、TS 不认虚拟模块所以还得另生成一份实体类型声明文件兜底）」。
  3. **页面内路由配置宏做「双面变换」：能影响路径拓扑的少量属性在构建期静态抽取，其余属性整体提取成一个独立模块在运行时合并** → 换来了「路由名/路径/参数这些决定树结构的属性在构建期就生效、能直接进入类型推导；而 meta 等可引用组件内变量的属性仍能在运行时合并」 → 代价是「同一份配置要走两条代码路径，且提取模式下必须禁止它引用组件 setup 作用域里的变量（否则跨模块提取后引用断裂），需要专门的作用域校验」。
  4. **把匹配优先级的排序逻辑从运行时匹配器「移植」一份到构建期 codegen** → 换来了「生成的固定匹配器在运行时零排序开销、表是静态有序的」 → 代价是「同一套排序语义存在两份实现（运行时一份、codegen 一份），存在双重维护、二者偏离的风险」。

- **最小心智模型（3～7 步）**：
  1. 文件系统被扫描成一棵带属性的路由树（前置章已完成）。
  2. 打包器加载阶段拦截那个约定的虚拟模块名，现场调用生成函数。
  3. 同一棵树被遍历若干次，分别投影出：运行时路由数组、一份类型声明文件（含路由名映射表、文件→路由名映射、参数解析器类型）、（若开启实验特性）一张排好序的固定匹配表。
  4. 页面内的路由配置宏与自定义代码块这两种「逃逸舱」，在树构建期被静态抽取出能影响拓扑的字面量；其运行时部分（如 meta）被变换成一个独立模块，在路由数组里与按约定生成的记录做深合并。
  5. 类型声明文件通过「模块增强」把路由名映射反向注入库的类型配置接口，库内部的条件类型由此自动从宽泛收窄为精确。
  6. 文件一改动，监听器重写类型声明文件、并让打包器重载那个虚拟模块；虚拟模块内部的热更新回调把新路由表/匹配器热替换进当前路由器实例，不刷新页面。

- **最小原理演示（替代旧"复刻范围"）**：
  - 应演示：一个**小到只表达「一棵树 → 多产物投影 + 类型注入点被填」**的从零实现（几十行 TS）。具体演三件事：(a) 一棵极简路由树（两三个节点）；(b) 一个 `genRoutes(tree)` 把树投影成运行时数组字符串；(c) 一个 `genDTS(tree)` 把树投影成「`declare module` 注入库类型配置接口」的字符串，并**当场用 `import`/`interface 合并` 演示注入后某个条件类型从 `string` 收窄为字面量联合**。这段演示演的是权衡 #1（单源多投影）+ 权衡 #2 的类型侧（注入点被填）。可再附一个极简的「虚拟模块 load 钩子按 id 分发到不同生成函数」骨架，演契约边界。
  - 应故意省略：完整的虚拟模块前缀/`\0` 处理、definePage 宏的 AST 抽取与作用域校验、`<route>` 块的三种语言解析、HMR 的 `import.meta.hot.data` 跨边界存实例、参数解析器的 raw 检测、固定匹配器的三段匹配细节、alias 临时树——这些都是旁路与工程化脚手架，演示不追求工程完整。
  - **演示载体建议：首选 TS/JS**。本章核心是「字符串拼接式代码生成 + `declare module` 类型注入点 + 虚拟模块/HMR 骨架」，全部是 TS/JS 惯用法，TS/JS 能忠实演透（且本 Atlas 本身就是 JS 生态的 VitePress 站点，TS/JS 演示对读者最友好，配最小 `package.json` 即可用 `tsx`/`bun` 跑）。**无需退回原仓库语言**——原仓库本身就是 TS，TS 演示即原仓库语言，不存在「TS/JS 讲不透」的语义。唯一可读性补强：演示里可以用 `console.log` 打印生成的代码字符串，让读者肉眼看到「同一棵树投影出两种截然不同的文本」。

- **正文不宜展开的细节**：参数解析器的 raw/非 raw 在类型联合里的 `| null`/`| undefined` 精细规则（`exactOptionalPropertyTypes` 兼容）；query 参数 `format: 'value'|'array'` 与 raw parser 冲突时的告警码；alias 在固定匹配器里如何新建临时树重新解析；命名视图（named views）多组件的 import 生成；Volar 插件如何消费「文件→路由名映射」（属编辑器插件话题，非本章）；debounce/throttle 的写盘节流参数。

- **推荐的一个执行轨迹例子**：
  - 输入：磁盘上新增 `pages/users/[id].vue`，已有 `pages/index.vue`。
  - 构建期树：根 → `/`(index), `/users/:id`(users)。
  - load 虚拟模块 → 投影出运行时数组 `[{path:'/',name:'/',component:()=>import(...)}, {path:'/users/:id',name:'/users/:id',component:()=>import(...)}]`。
  - 同时投影出类型声明：路由名映射里 `/users/:id` 对应一条记录信息，其参数类型由 `:id` 静态派生为字符串；再用 `declare module` 把整张表注入库类型配置接口。
  - 编码期效果：用户写 `router.push({name:'/users/:id', params:{id:123}})` 时，编辑器据注入的类型表校验 `id`。
  - 改动：用户编辑该文件 → 监听器重写类型声明（内容变了才写）+ 重载虚拟模块 → 虚拟模块热更新回调把新数组热替换进路由器、并 `force` 重匹配当前路由 → 页面不刷新。

> 以上钩子供 Writer 写「动机→核心思想→心智模型→关键权衡→原理演示」；下面事实部分供核对，不要被 Writer 当目录照抄。

## 概念要点

- **三个虚拟模块名是构建期与运行时的契约边界**：约定两个「伪模块名」分别承载运行时路由数组与实验固定匹配器；一个额外的「路由块」伪模块用于把自定义块 stub 掉。注释明确「更自然的斜杠路径形式因 TS 解析问题被弃用、改用连字符形式」。源码位置: packages/router/src/unplugin/core/moduleConstants.ts:1-3,21-24
- **resolveId 把裸模块名映射成带虚拟前缀的 id，load 按虚拟 id 分发到三个生成入口**：`vue-router/auto-routes` → 生成运行时数组；`vue-router/auto-resolver` → 生成实验匹配器；路由块 id → 返回空对象 stub（内容已被解析消费，不再让打包器处理）。源码位置: packages/router/src/unplugin/index.ts:73-95,118-157
- **同一棵树被三处分别遍历投影**：运行时数组生成函数遍历树产出嵌套的 `children` 结构；类型声明生成函数遍历树产出扁平的路由名映射；固定匹配器生成函数遍历树产出扁平、排好序的记录数组。三者入口都从 `getChildrenSorted()` 开始。源码位置: packages/router/src/unplugin/core/context.ts:271-276,343-347,404-413
- **类型声明文件是「实体兜底」**：虚拟模块 TS 无法直接解析，故额外生成一份磁盘上的类型声明文件，用户需把它纳入 tsconfig。文件顶部带 `@ts-nocheck` 与「请提交此文件」注释。源码位置: packages/router/src/unplugin/codegen/generateDTS.ts:31-39
- **用 `declare module` 双向注入**：类型声明里有两处模块增强——向库本身注入「路由名映射、参数解析器类型表、文件信息映射」到库的类型配置接口；向那个虚拟路由模块注入 `RouteNamedMap`/`_RouteFileInfoMap` 的实际类型（使其从「空接口」变「有内容」）。这是前置类型章「空接口 + 条件类型」注入点的实际填充动作。源码位置: packages/router/src/unplugin/codegen/generateDTS.ts:60-102
- **每条命名路由的类型记录有 5 个类型参数**：名字字面量、完整路径字面量、Params（push 时较宽松）、ParamsRaw（route.params 较严格）、所有后代命名路由名联合。参数类型由路径模式静态派生（修饰符决定 `ParamValue`/`OneOrMore`/`ZeroOrMore`/`ZeroOrOne`），或由参数解析器派生。源码位置: packages/router/src/unplugin/codegen/generateRouteMap.ts:42-92；参数类型派生见 packages/router/src/unplugin/codegen/generateRouteParams.ts:11-41
- **实验参数路径带参数解析器时走增强版类型派生**：支持 path 与 query 参数；对每个参数据是否 raw parser、是否 repeatable、是否 optional、是否有 default 决定 `|null`/`|undefined` 的精细联合（兼容 `exactOptionalPropertyTypes`）。源码位置: packages/router/src/unplugin/codegen/generateRouteParams.ts:56-124
- **页面内路由配置宏是「编译期宏」而非运行时函数**：它在源码里出现，但运行时组件中不应残留。变换函数有两种模式，由模块 id 是否带 `?definePage` 查询串区分。源码位置: packages/router/src/unplugin/core/definePage.ts:26-27,62-76
- **宏的「提取模式」**：当 id 带 `?definePage` 时，把宏的对象参数提取成 `export default {...}`，成为一个独立「路由配置模块」；同时遍历 AST 只保留对象内真正引用到的 import（过滤掉 `console.log` 的 `log` 这类成员访问、对象字面量键名等），并校验对象未引用 setup 作用域变量（否则报错并降级为空对象）。源码位置: packages/router/src/unplugin/core/definePage.ts:112-205
- **宏的「删除模式」**：当 id 不带 `?definePage`（即组件本体）时，从组件源码删掉所有宏调用，避免它泄漏到运行时组件。源码位置: packages/router/src/unplugin/core/definePage.ts:206-217
- **宏的「静态抽取」**：在树构建期，另一个函数静态读出宏对象里的 name/path/alias/params 等字面量（不提取整个对象），用于影响路由树拓扑与类型；其余属性（如 meta）设一个 `hasRemainingProperties` 标记。源码位置: packages/router/src/unplugin/core/definePage.ts:238-317
- **运行时深合并**：若节点标记需要引入宏数据，生成的运行时记录会被包进一个合并调用 `_mergeRouteRecord(record, 宏提取模块默认导出, ...)`，把「按约定生成的记录」与「宏声明的运行时部分」深合并（复用前置章「多来源深合并」机制）。固定匹配器侧同样有对应的合并包裹。源码位置: packages/router/src/unplugin/codegen/generateRouteRecords.ts:39-57,108-116；匹配器侧 packages/router/src/unplugin/codegen/generateRouteResolver.ts:162-177,216-231,436-459
- **`<route>` 自定义块是第三种配置来源**：支持 json5/json/yaml 三种语言解析；解析失败或语言不支持时发诊断码。整个块在 load 阶段被 stub 成空模块（因其内容已被解析消费）。源码位置: packages/router/src/unplugin/core/customBlock.ts:10-19,54-93；stub 见 packages/router/src/unplugin/index.ts:132-137
- **匹配优先级排序被「移植」到 codegen**：固定匹配器生成时，`compareScoreArray`/`compareRouteScore` 两个比较函数注释明确标注「移植自 pathParserRanker」，在构建期就把可匹配记录按二维 score 排好，生成固定有序数组；相同 score 时再按路径深度兜底排序保证一致顺序。源码位置: packages/router/src/unplugin/codegen/generateRouteResolver.ts:15-63,115-129
- **固定匹配器把 parent 链与三段匹配模式物化**：每个记录带 `parent` 指针；path 段视有无动态参数生成「静态模式」或「动态模式（正则+参数选项+各段信息）」；query 段按需生成查询参数匹配器（含 format/default/required）；index 页可复用父 path 模式（`record.path === record.parent.path`）以支持激活态判定。源码位置: packages/router/src/unplugin/codegen/generateRouteResolver.ts:190-214,292-365,370-431
- **alias 在 codegen 里新建临时树重解析**：每个别名路径新建一棵临时树、插入解析、生成独立记录（`...原记录, path:别名模式, aliasOf:原记录`），并入可匹配记录数组参与排序。源码位置: packages/router/src/unplugin/codegen/generateRouteResolver.ts:234-266
- **参数解析器「类型 + 运行时」双产物**：扫描指定目录下的 parser 文件；类型侧生成 `type Param_xxx = _ExtractParamParserType<typeof import('...').parser>` 并汇入类型配置接口；运行时侧生成 `const _normalized_PARAM_PARSER__xxx = _normalizeParamParser(parser)` 供匹配器使用。源码位置: packages/router/src/unplugin/codegen/generateParamParsers.ts:298-313,356-371,379-387
- **raw parser 的静态检测**：用 babel 解析 parser 源码，追踪 `defineParamParserRaw` 的别名 import、收集其本地变量绑定、再判断 `parser` 导出是否最终源自它（支持内联与间接 `export { p as parser }` 两种形式）；re-export 形式无法本地解析时发告警。源码位置: packages/router/src/unplugin/codegen/generateParamParsers.ts:50-185
- **parser 的 tree-shaking**：固定匹配器生成时先收集树中实际引用到的 parser 名集合，只把被引用的 parser 纳入 import 与声明，避免未用 parser 进 bundle。源码位置: packages/router/src/unplugin/codegen/generateRouteResolver.ts:82-87；收集函数 packages/router/src/unplugin/codegen/generateParamParsers.ts:265-275
- **「文件→路由名」映射服务编辑器**：生成 `_RouteFileInfoMap`，key 是组件文件相对路径，value 是「该文件可能出现的路由名联合 + 后代命名视图名 + 自身 path 参数名」。供 Volar 插件在 SFC 内把 `useRoute()` 泛型自动收窄到当前文件可能的路由。同一文件可被多路由复用，故按文件聚合。源码位置: packages/router/src/unplugin/codegen/generateRouteFileInfoMap.ts:5-67,94-122
- **同步/异步组件导入**：页面组件可按 `importMode`（函数或字面量）生成异步 `() => import(...)` 或同步具名 import（具名时去重复用已登记的默认导入别名）。源码位置: packages/router/src/unplugin/codegen/generateRouteRecords.ts:150-171
- **路由 HMR：不刷新页面替换路由表**：运行时数组模块内嵌 `import.meta.hot.accept`，通过 `import.meta.hot.data.router` 跨模块重执行边界保存路由器实例，热更新时 `clearRoutes()` + 逐条 `addRoute(新表)` + `force` 重匹配当前路由；无活跃实例时降级为整页 invalidate。匹配器侧对称地走「替换匹配器」接口。源码位置: packages/router/src/unplugin/core/context.ts:349-382（数组）,306-332（匹配器）
- **写盘节流 + 仅在 dts 变化时重载**：监听文件 change/add/unlink 后，先节流地重写类型声明文件，且只有当声明内容真的变化才写盘并触发虚拟模块重载（避免仅组件体改动也重载路由）。源码位置: packages/router/src/unplugin/core/context.ts:421-445,447-449
- **Vite 侧上下文封装 4 个动作**：`invalidate`（按 id 重载模块）、`invalidatePage`（按文件重载其所有关联模块）、`updateRoutes`（并行重载两个虚拟模块）、`reload`（整页 ws full-reload）。源码位置: packages/router/src/unplugin/core/vite/index.ts:9-60

## 关键调用链

构建期总调度（在前置章的 context.ts 内，本章所有生成器从此处被调用）：

```
buildStart → scanPages（建树，前置章）
  ↓
load 钩子拦截虚拟 id（index.ts）
  ├─ vue-router/auto-routes  → generateRoutes() → generateRouteRecords(tree)            [运行时数组]
  │                                                              + definePage 提取模块 + _mergeRouteRecord
  ├─ vue-router/auto-resolver → generateResolver() → generateRouteResolver(tree)         [固定匹配器]
  │                                                              + score 排序 + parser tree-shaking
  └─ route-block id          → export default {}（stub）

写盘（监听文件变动 / buildStart）：
  generateDTS()
    ├─ generateRouteNamedMap(tree)      → RouteNamedMap（每条 = RouteRecordInfo<名,路径,Params,ParamsRaw,子名联合>）
    ├─ generateRouteFileInfoMap(tree)   → _RouteFileInfoMap（文件→路由名/视图/参数名）
    ├─ generateParamParsersTypesDeclarations → Param_xxx 类型
    └─ 组装 → typed-router.d.ts（declare module 'vue-router' 注入 TypesConfig；
                                declare module 'vue-router/auto-routes' 注入接口内容）

组件 transform（index.ts transform 钩子，按 id filter）：
  definePage_transform(code, id)
    ├─ id 含 ?definePage → 提取对象为 export default（独立路由配置模块）
    └─ id 不含          → 从组件删除 definePage() 调用
  extractDefinePageInfo（建树期）→ 静态抽 name/path/alias/params 影响拓扑

HMR：
  文件变动 → writeConfigFiles（dts 变才写 + updateRoutes）
          → Vite reloadModule(虚拟模块)
          → 虚拟模块 import.meta.hot.accept → router.clearRoutes + addRoute(新表) + replace(force)
```

源码位置: packages/router/src/unplugin/index.ts:97-165；packages/router/src/unplugin/core/context.ts:268-445

## 源码摘录（带行号，全文累计 ≤ 30 行）

类型声明如何用「模块增强」把路由表注入库类型配置接口（演权衡 #1 的类型侧 + 承前第 13 章注入点的填充）：

```ts
// generateDTS.ts:60-72
declare module 'vue-router' {
  interface TypesConfig {
    _ParamParsers: ${...}
    RouteNamedMap: import('${routesModule}').RouteNamedMap
    _RouteFileInfoMap: import('${routesModule}')._RouteFileInfoMap
  }
}

declare module '${routesModule}' {
${normalizeLines(routeNamedMap)}        // RouteNamedMap 接口的实际内容
${normalizeLines(routeFileInfoMap)}     // _RouteFileInfoMap 接口的实际内容
}
```

load 钩子按虚拟 id 分发到三个生成入口（演权衡 #2 虚拟模块契约边界）：

```ts
// index.ts:141-156
const resolvedId = getVirtualId(id)
if (resolvedId === MODULE_ROUTES_PATH) {
  ROUTES_LAST_LOAD_TIME.update()
  return ctx.generateRoutes()
}
if (resolvedId === MODULE_RESOLVER_PATH) {
  ROUTES_LAST_LOAD_TIME.update()
  return ctx.generateResolver()
}
```

页面内路由配置宏的「双面变换」判定（演权衡 #3）：

```ts
// definePage.ts:70-76
const isExtractingDefinePage = MACRO_DEFINE_PAGE_QUERY.test(id)
if (!code.includes(MACRO_DEFINE_PAGE)) {
  // 提取模式下若无宏，返回合法空模块；组件模式下返回 undefined（不处理）
  return isExtractingDefinePage ? 'export default {}' : undefined
}
```

固定匹配器构建期排序物化（演权衡 #4，注释明示「移植」）：

```ts
// generateRouteResolver.ts:115-129
export const resolver = createFixedResolver([
${state.matchableRecords
  .sort((a, b) => compareRouteScore(a.score, b.score) || /*路径深度兜底*/ ...)
  .map(({ varName, path }) => `  ${varName},  // ${path}`)
  .join('\n')}
])
```

路由 HMR 热替换（演心智模型第 6 步）：

```ts
// context.ts:358-380（运行时数组侧，节选）
import.meta.hot.accept((mod) => {
  const router = import.meta.hot.data.router          // 跨重执行边界取实例
  if (!router) { import.meta.hot.invalidate(...); return }
  router.clearRoutes()
  for (const route of mod.routes) router.addRoute(route)
  router.replace({ ...route, name: undefined, matched: undefined, force: true })
})
```

## 易混淆 / 边界 / 推断

- **事实**：`vue-router/auto-routes`（连字符）而非 `auto/routes`（斜杠）是刻意选择——注释明示斜杠形式「与 TS 配合不好」。源码位置: moduleConstants.ts:1-2
- **事实**：类型声明文件带 `@ts-nocheck`（它本身不需被类型检查，只是产物），并提示用户提交且纳入 tsconfig。源码位置: generateDTS.ts:34-39
- **推断**：宏走「静态抽取」与「整体提取」两条路径的判据是——能否在不引用组件作用域变量的前提下得到值：name/path/alias/params 必须是字面量（静态抽取，影响拓扑/类型），故抽取时对非字面量发诊断码；其余属性允许引用 import，走整体提取。证据：`checkInvalidScopeReference` 仅在提取模式触发，静态抽取分支对每类属性都校验 `StringLiteral`/`BooleanLiteral`。源码位置: definePage.ts:130,289-313
- **推断**：固定匹配器把 score 比较从运行时匹配器「移植」到 codegen，是为了让运行时匹配表「构建期固定、静态有序」——这与第 15 章固定路由表的设计目标一致；但代价是排序语义双份维护（运行时 ranker + codegen 比较函数），文件里多处 TODO/FIXME 暗示作者意识到偏离风险。源码位置: generateRouteResolver.ts:15-17,28-33
- **事实/边界**：raw 参数解析器会绕过自动 array/null 类型提升、并强制 query 的 `format:'array'`；若用户同时显式写了 `format:'value'`，生成代码里插入 `console.warn` 告警（不报错）。源码位置: generateRouteResolver.ts:396-405
- **事实**：index 页可在固定匹配器里复用父 path 模式（二者 regexp 相同时直接 `path: parent.path`），目的是让路由器凭 `record.path === record.parent.path` 识别 index 页以支持激活态匹配。源码位置: generateRouteResolver.ts:355-362
- **未理解**：`ROUTES_LAST_LOAD_TIME` 这个「上次加载时间戳」除了 `.update()` 被调用外，其 `.value` 在可见范围内未被这些 sourceFiles 读取——推测供外部（如 dts/类型插件或 HMR 辅助）判断新鲜度，但未在本次精读范围内找到消费点，留给后续核对。源码位置: moduleConstants.ts:5-17；index.ts:145,151
# 文件路由：约定与前缀树 · 源码精读

## 给 Writer 的教学钩子（必填，8 子项缺一不可）

- **用户痛点 / 场景**：当路由上百、嵌套很深时，手写一份 `routes` 配置会变成维护噩梦——加一个页面要同时改配置、改嵌套、同步 name/meta/alias。文件路由能让"新建文件即新增路由"，但纯约定式（只认文件名）一旦遇到"我要改这条路由的 path / 加个别名 / 设个 meta / 条件性删掉"就力不从心，逼用户把整套方案 eject 掉重写。

- **一句话核心思想**：用前缀树还原文件夹的父子拓扑，再用一张"按来源分桶、按固定优先级深合并"的属性表，让文件名约定、`<route>` 路由块、`definePage` 编译宏、构建期扩展钩子四个来源共存互补，而非互相覆盖。

- **设计动机（为什么需要它）**：这个机制是为了解决"零配置的便利"与"复杂场景的可定制"之间的矛盾——既不让用户为每个路由写配置，又不让约定成为天花板。它换来的能力是：从"丢个文件进来就生效"到"我要精细控制这一条路由"之间，存在一条不必 eject 的平滑梯度。（已在第 6 章『路由匹配表』讲透"把路由配置递归编译成 matcher 树、别名展开、父子路径拼接、按 score 排序"——本章是它的**上游**：本章把**文件系统**编译成那份路由配置数组，再喂给匹配表；本章只看"如何从文件拓扑 + 多来源元数据生成那份配置"这个新侧面。另：本章复用了第 3 章『路径模式编译与优先级评分』的"静态>动态>通配"评分观，但只用于实验解析器，**不重讲**评分推导。）

- **关键权衡（选择 → 换来 → 代价）**：
  1. **用前缀树而非扁平数组承载路由** → 换来了"嵌套路由、parent 链、参数沿父链自然累积、group 文件夹自动折叠路径"全部免费成立 → 代价是插入/删除要按 `/` 递归切分、删空节点要向上回溯清理、遍历要走 DFS/BFS 而非直接 for。
  2. **每个来源独立存一份覆盖、读取时按固定优先级（文件名约定 < 各文件字典序 < 用户扩展钩子）排序后逐层深合并** → 换来了四来源可同时向同一条路由贡献不同字段、互不抹掉，且用户钩子永远是最终逃生舱 → 代价是每次读属性都要重排序 + 深合并（源码留有性能 TODO），且"合并"必须按字段逐一定义语义（别名拼接、meta 深合并、其它后者胜）。
  3. **用字符级状态机把文件名段直接解析成路由形态** → 换来了 `[id]`/`[[id]]`（可选）/`[id=parser]`（带类型）/`[...path]`（通配）/`[x+HH]`（hex 转义）/`.`（点即嵌套）一套文法统一表达，文件名本身即声明 → 代价是状态机分支多、边界细（如可选参数前的斜杠要移入非捕获组）。
  4. **约定优先 + 多层逃逸舱（`<route>` 块 → `definePage` 宏 → 扩展钩子 → 写前钩子）** → 换来了"简单场景零配置、复杂场景逐级定制、全程不必 eject"的渐进式复杂度 → 代价是同一条路由的元数据可能散落在四处，必须配套冲突检测与优先级规则。

- **最小心智模型（7 步）**：
  1. 构建启动，扫描页面目录，每个文件算出"路由路径"（剥掉页面根前缀、去扩展名、加可选 path 前缀）。
  2. 按 `/` 把路由路径递归切分，逐段插入前缀树：每段一个节点，叶子挂组件文件。
  3. 文件名段经状态机解析，决定该段的"路径形态 + 参数 + 子段"（如 `[id]` → 动态段、可选、带类型）。
  4. 读文件内容，抽出其中的路由块和编译宏，作为一份"覆盖"按来源挂到对应节点。
  5. 生成时对每个节点把所有来源按固定优先级排序、深合并出最终的 path/name/meta/alias/params。
  6. 遍历树，对每条路由调用户的扩展钩子（钩子写的字段优先级最高），再把整棵树序列化成 `routes` 数组。
  7. 文件增删改时对应增删改节点，节流后重生成，借一个虚拟模块把新数组热替换进运行中的路由器。

- **最小原理演示（替代旧"复刻范围"）**：
  - **应演示**：一个最小前缀树（按 `/` 递归建树、叶子挂组件）+ 每个节点一张"按来源分桶的属性表" + 读取时按优先级深合并。演的是权衡 1（树承载拓扑）与权衡 2（多来源深合并而非互斥）。输入是一组文件路径 + 多来源覆盖，输出是合并后的路由表（能看到别名拼接、meta 合并、钩子覆盖生效）。
  - **应故意省略**：文件名状态机的全部边界（只演 `[id]`/`index` 一两种约定）、命名视图、HMR 细节、dts/codegen、watcher、score 二维结构、resolver 正则、paramParsers 扫描。
  - **演示载体建议**：**首选 TS/JS**——前缀树 + Map 分桶 + 优先级深合并是纯数据结构与合并逻辑，TS/JS 完全能忠实演透，配最小 `package.json` 可 `node` 直跑，对本 Atlas（JS 生态 VitePress 站点）的读者最友好。无需退回原仓库语言。

- **正文不宜展开的细节**：命名视图（`@view` 与 components 多映射）、`_parent` 与 `index` 同目录的冲突及重复路由警告、`[x+HH]` hex 转义、可选参数前斜杠移入非捕获组的正则微调、节流(debounce 100ms + throttle 500ms)的 HMR 参数、实验 resolver 的二维 score 与节点正则生成、paramParsers 目录扫描——这些供 Writer 裁剪，不进主线。

- **推荐的一个执行轨迹例子**：输入 `pages/users/index.vue`（约定→`users/`）、`pages/users/[id].vue`（约定→`:id`，文件内 `definePage` 设 `meta:{auth:true}`）、扩展钩子给 `[id]` 加别名 `/u/:id`。中间态：树有 `users` 节点，下挂 `index` 子节点（挂组件）与 `[id]` 子节点；`[id]` 节点的属性桶里分三份——约定来源（段形态 `:id`）、文件来源（meta.auth）、钩子来源（alias）。输出：合并后得到 `users/:id` 路由，`meta.auth===true`、`alias==['/u/:id']`、`name` 由文件路径拼成。

> 以上钩子供 Writer 写「动机→核心思想→心智模型→关键权衡→原理演示」；下面事实部分供核对，不要被 Writer 当目录照抄。

## 概念要点

- **前缀树是路由父子拓扑的载体**：每个节点持有一个 `children: Map<string, TreeNode>`，`insert` 按 `/` 递归切分路径逐段下沉，叶子节点挂组件文件。源码位置: packages/router/src/unplugin/core/tree.ts:118-143
- **根节点额外维护一张 filePath→node 的反查表**（`PrefixTree.map`），让按文件路径 O(1) 查/删成为可能（watcher 更新要用）。源码位置: packages/router/src/unplugin/core/tree.ts:578-630
- **文件名段解析成三态值**：`createTreeNodeValue` 工厂根据段内容分发为 static / group（括号折叠）/ param（方括号动态）三类节点值。源码位置: packages/router/src/unplugin/core/treeNodeValue.ts:541-595
- **一套文件名文法**：`index`→空段（映射父路径）、`(group)`→group 节点（`pathSegment=''` 不贡献路径，仅组织）、`[param]`→`:param`、`[[param]]`→可选、`[param=parser]`→带类型、`[...param]`→通配 `(.*)`、`.`→`/`（dotNesting）。源码位置: packages/router/src/unplugin/core/treeNodeValue.ts:546-576, 629-801
- **多来源属性表是核心数据结构**：每个节点值内部用 `_overrides = Map<来源标识, 覆盖块>`，各来源（约定、各文件、用户钩子）各占一桶，互不覆盖地并存。源码位置: packages/router/src/unplugin/core/treeNodeValue.ts:54
- **读取时按固定优先级排序后逐层深合并**：约定标识永远最前、用户钩子标识永远最后、其余按字典序；reduce 时从低到高合并，故"钩子写的字段优先级最高，约定是地基"。源码位置: packages/router/src/unplugin/core/treeNodeValue.ts:24-26, 177-192
- **合并语义按字段分策略**：`alias` 数组拼接、`meta` 深合并、`params` 的 path/query 分组合并、其它字段"后者胜但 falsy 不覆盖"（`b[key] ?? a[key]`）。源码位置: packages/router/src/unplugin/core/utils.ts:181-217
- **四来源如何各入其桶**：①文件名约定（如 `_parent`）写入"约定"桶并设 `name:false`；②`<route>` 路由块与 `definePage` 宏抽取后合并写入以 filePath 为 key 的桶；③构建期扩展钩子经可编辑节点写入"钩子"桶。源码位置: packages/router/src/unplugin/core/tree.ts:122-129, packages/router/src/unplugin/core/context.ts:173-192, packages/router/src/unplugin/core/extendRoutes.ts:99-101, 123-126, 147-157
- **`_parent` 约定**：`nested/_parent.vue` 表示"`nested" 这个节点本身的布局组件"，挂到当前节点而非新建子节点，并设 `name:false` 使其不单独参与匹配（避免与 `nested/index` 冲突）。源码位置: packages/router/src/unplugin/core/tree.ts:122-129
- **命名视图**：`splitFilePath` 按 `@` 拆出 viewName（如 `index@aux.vue`→viewName `aux`），组件存为 `Map<viewName, filePath>`，故同一节点可挂多视图。源码位置: packages/router/src/unplugin/core/tree.ts:61, 698-718
- **可匹配判定**：节点"有组件且 name 不为 false"才算可匹配路由，否则只是组织用（pass-through）。源码位置: packages/router/src/unplugin/core/tree.ts:521-525
- **扫描建树主流程**：`scanPages` 用 glob 列出各 folder 文件 → `addPage({filePath, routePath})` → `routeTree.insert` → `writeRouteInfoToNode`（读文件内容，抽 definePage 与 route block，挂到节点）。源码位置: packages/router/src/unplugin/core/context.ts:65-171, 194-207
- **生成产物走虚拟模块**：`vue-router/auto-routes` 是契约边界——插件的 `load` 钩子拦截它，调 `generateRoutes()` 把树序列化成 `routes` 数组（这正是前置章"路由匹配表"的输入）。源码位置: packages/router/src/unplugin/index.ts:118-157, packages/router/src/unplugin/core/context.ts:340-397
- **两个用户钩子的层次**：`extendRoute` 对每条路由调一次（写字段入"钩子"桶），`beforeWriteFiles` 在写文件前对根调一次（整树最终改）。源码位置: packages/router/src/unplugin/options.ts:170-183, packages/router/src/unplugin/core/context.ts:165-167, 422-450
- **文件监听驱动增删改**：chokidar 的 add/change/unlink → 对应增/改/删树节点 → 通知 server 重生成 routes。源码位置: packages/router/src/unplugin/core/RoutesFolderWatcher.ts:15-87, packages/router/src/unplugin/core/context.ts:209-266
- **可编辑节点是钩子的操作面**：`EditableTreeNode` 包装内部节点，其 setter（name/path/meta/alias）全部落到"钩子"桶，使用户钩子的修改走与文件来源相同的合并通道。源码位置: packages/router/src/unplugin/core/extendRoutes.ts:17-242
- **路由名生成**：默认按文件原始段拼路径式名（`getFileBasedRouteName`），亦可换 PascalCase（`getPascalCaseRouteName`）；名可被 `name:false`/覆盖改写。源码位置: packages/router/src/unplugin/core/utils.ts:140-179
- **filePath→routePath 换算**：`asRoutePath` = 剥掉页面根 src 前缀 + 加 folder 的 `path` 前缀 + `trimExtension` 去扩展名。源码位置: packages/router/src/unplugin/core/utils.ts:250-267
- **folder 级"可覆盖选项"**：`_OverridableOption<T>` 允许 folder 级配置传值（替换）或传函数 `(existing)=>T`（在全局值基础上扩展），统一了"覆盖 vs 扩展"两种意图。源码位置: packages/router/src/unplugin/options.ts:93-114, packages/router/src/unplugin/core/RoutesFolderWatcher.ts:96-140
- **两种解析格式**：`format:'file'`（默认，解析文件名约定）vs `format:'path'`（解析 `:id` 这类 router 路径，供 `insertParsedPath`/扩展钩子的 `insert` 用）。源码位置: packages/router/src/unplugin/core/treeNodeValue.ts:507-516, packages/router/src/unplugin/core/tree.ts:152-176

## 关键调用链

**扫描建树**：`scanPages()` → `glob(folder.pattern)` → `addPage({filePath, routePath})` → `routeTree.insert(routePath, filePath)` → `splitFilePath`（递归按 `/` 切 + 拆 `@` viewName）→ `createTreeNodeValue`（段解析成三态）→ `writeRouteInfoToNode` → `extractDefinePageInfo` + `getRouteBlock` → `node.setCustomRouteBlock`（合并入 `_overrides[filePath]` 桶）。
源码位置: packages/router/src/unplugin/core/context.ts:65-207, packages/router/src/unplugin/core/tree.ts:118-143

**生成配置数组**：插件 `load(vue-router/auto-routes)` → `ctx.generateRoutes()` → `generateRouteRecords(routeTree)` → 遍历树、读每节点 `overrides`/`components`/`params`（沿 parent 链累积）→ 输出 `routes` 数组 + HMR accept 代码。
源码位置: packages/router/src/unplugin/index.ts:118-157, packages/router/src/unplugin/core/context.ts:340-397

**多来源合并**：`node.value.overrides`（getter）→ 取 `_overrides.entries()` → 按"约定<字典序<钩子"排序 → `reduce` 调 `mergeRouteRecordOverride` 逐层合并。
源码位置: packages/router/src/unplugin/core/treeNodeValue.ts:177-192, packages/router/src/unplugin/core/utils.ts:181-217

## 源码摘录（带行号，全文累计 ≤ 30 行）

多来源覆盖的优先级排序 + 逐层深合并（核心机制）：
```ts
// treeNodeValue.ts:177-192
get overrides() {
  return [...this._overrides.entries()]
    // CONVENTION 最前、EDITS 最后，中间字典序
    .sort(([a], [b]) =>
      a === CONVENTION_OVERRIDE_NAME ||
      (a !== EDITS_OVERRIDE_NAME && (a < b || b === EDITS_OVERRIDE_NAME))
        ? -1 : 1)
    .reduce((acc, [, block]) => mergeRouteRecordOverride(acc, block),
      {} as RouteRecordOverride)
}
```

合并语义按字段分策略（alias 拼接 / meta 深合并 / 其它后者胜）：
```ts
// utils.ts:193-213
if (key === 'alias') merged[key] = [].concat(a.alias || [], b.alias || [])
else if (key === 'meta') merged[key] = mergeDeep(a[key] || {}, b[key] || {})
else if (key === 'params') merged[key] = { path: { ...a[key]?.path, ...b[key]?.path }, query: { ...a[key]?.query, ...b[key]?.query } }
else merged[key] = b[key] ?? a[key] // 后者胜，但 falsy 不覆盖
```

`_parent` 约定：父布局挂当前节点 + 设 name:false 不单独匹配：
```ts
// tree.ts:122-129
if (segment === '_parent' && !tail) {
  this.value.setOverride(CONVENTION_OVERRIDE_NAME, { name: false })
  this.value.components.set(viewName, filePath)
  return this
}
```

按 `/` 递归建树、叶子挂组件：
```ts
// tree.ts:131-142
if (!this.children.has(segment)) {
  this.children.set(segment, new TreeNode(this.options, segment, this))
}
const child = this.children.get(segment)!
if (!tail) {
  child.value.components.set(viewName, filePath) // 叶子挂组件
} else {
  return child.insert(tail, filePath)            // 递归下一段
}
```

## 易混淆 / 边界 / 推断

- **事实**：`generateRoutes()` 产出的 `routes` 数组才是真正喂给 `createRouter` 的输入——即前置章"路由匹配表"的处理对象；虚拟模块 `vue-router/auto-routes` 是"构建期 ↔ 运行时"的契约边界（生成与类型分属下一章 codegen）。
- **事实**：同名视图不是冲突（`index.vue` + `index@header.vue` 共存合法），只有"同一 viewName 被多文件覆盖"才是冲突，由 `collectDuplicatedRouteNodes` 检测并告警。源码位置: packages/router/src/unplugin/core/tree.ts:651-690
- **推断（标注为推断）**：覆盖用 `Map` 而非对象、且采用"读时合并"而非"写时合并"，是为了让各来源能独立增删互不影响（watcher 改文件时只动自己那一桶）；源码注释里的 perf TODO 暗示读时合并确有开销，未来可能加缓存。
- **推断**：扩展钩子用专属标识、且排序永远最后（优先级最高），是刻意设计——让用户钩子成为"无论如何约定/文件怎么设，钩子总能兜底"的最终逃生舱，呼应"渐进式复杂度"主线。
- **边界/未理解**：实验 resolver 路径（`generateResolver` + 节点二维 `score` + 节点 `regexp` 生成）与 `route-resolver` 章耦合更深，本章只点到"它复用了静态>动态>通配的评分观、且把动态性进一步推到构建期"，二维 score 的具体比较与正则拼接细节不在此展开。
# 可视化层：treemap/sunburst/flamegraph/graph/grid · 源码精读

## 给 Writer 的教学钩子

- **用户痛点 / 场景**：装完一个 monorepo，`node_modules` 里堆了上千个包。用户的问题不是「列出来」（一眼看不完），而是「**最大的几个是谁**」「**谁依赖谁**」「**同一个包被装了几个版本**」——三种问题对应三种完全不同的视觉编码，但底层数据是同一张依赖图。如果每种视角都从零写一份渲染逻辑，代码会爆炸且容易不一致。

- **一句话核心思想**：**同一份图、五种投影**——把 `PackageNode[]` 先转成一种「中间数据结构」，再交给现成的布局引擎（d3-hierarchy / nanovis）去画。

- **设计动机（为什么需要它）**：图表的视觉差异（矩形面积 vs 极坐标扇区 vs 节点-连线 vs 平铺分组）本质是「数据结构 + 布局算法」的差异，不是「业务逻辑」的差异。把"包图 → 中间结构 → 布局引擎"这条流水线显式化后，新增一种图表只需换最末端的渲染器，前面的图→树/组转换可复用。

- **关键权衡**：
  1. **shallowestDependent 分桶**（chart 系）：把"被多个父节点依赖的包"**只挂在它最浅的那个父节点下** → 换来了 treemap/sunburst 里 **体积不重复累计**（同一份字节只算一次）→ 代价是**跨树的父子关系在视觉上被隐藏**（这个包在其他父节点下不出现，需要 graph 视图的 `additionalLinks` 兜底）。
  2. **DAG → 树，靠 `seen` 去重 + 假根 `~root`**（graph）：依赖图本质是有向有环图（多根、多继承），但 d3 的 tree 布局只吃树 → 选择"先到先得的 `seen` 集合 + 拼一个虚拟根"把 DAG 拍扁成树 → 换来直接复用 d3-hierarchy 的 Reingold-Tilford 算法 → 代价是被多次依赖的包会被复制到多处（或反过来，丢失跨树边）。
  3. **延迟任务队列做 BFS 风格的子树展开**（chart）：不直接递归 `pkgToNode`，而是把"展开某节点的子节点"压成 closure 推进队列再 FIFO 执行 → 换来**同层节点聚集成连续的视觉块**（treemap 的色块更整齐）→ 代价是控制流不直观，需要 `runTasks` 自递归清空队列。
  4. **静态/活动双层 SVG**（graph Canvas）：所有边画一遍灰色，再单独把"选中节点相关的边"用主色画在另一层 SVG 上 → 换来**高亮逻辑完全脱离基础渲染**（不需要给 path 加 reactive class）→ 代价是两套 SVG 元素 + 重复的 path 数据。

- **最小心智模型（5 步）**：
  1. 从 `payloads.filtered` 拿到当前的扁平 `PackageNode[]`（已是过滤器收窄后的子集）。
  2. 选定视角，构造**中间结构**：chart 是 `ChartNode` 树，graph 是 `HierarchyNode<PackageNode>`，grid 是 `Group[]`。
  3. 在构造过程中处理"DAG → 树"的歧义（用 shallowestDependent / seen / orphan 检测三种不同策略）。
  4. 把中间结构交给**布局引擎**：d3-hierarchy 算 x/y，nanovis 算矩形/扇区坐标。
  5. 把布局结果**物化到 DOM/SVG**，再绑交互（hover/select/zoom）；数据变了就 dispose 旧的、重建新的。

- **最小原理演示**：
  - **应演示**："把一个 4 包 DAG 转成 treemap 树"——核心是 `shallowestDependent` 分桶 + 体积回填。一段 ~40 行 TS 即可：定义 `Node { id, sizeSelf, size, children }`，写一个 `buildTree(pkgs)`，关键行就是 `partition(children, c => c.shallowestDependent.has(parent.spec))`，然后两段递归（先 BFS 挂 shallowest，再回填 `size = sizeSelf + sum(children.size)`）。
  - **应故意省略**：nanovis 的实际渲染、Vue 的响应式、颜色 palette、self-placeholder、`-self` 节点、screenshot、zoom/drag——这些都是工程化包装，不表达核心思想。
  - **演示载体建议**：**TS 脚本可直接 `bun run` / `ts-node`**（仓库主语言就是 TS，无 IDE 宿主依赖）。不必真的画 treemap——`console.log` 出每个节点的 `{id, size, children: [...]}` 树形 JSON 即可证明"分桶 + 体积不重复"这一原理。**演的权衡是 #1（shallowestDependent 分桶换体积不重复）。**

- **正文不宜展开的细节**：
  - nanovis 库本身的内部实现（它是外部依赖，本章不负责教）；只需点明它提供 `Treemap/Sunburst/Flamegraph` 三个类，每个吃 `root + options` 输出一个 `.el` DOM 节点。
  - d3 的 `linkHorizontal`/`linkVertical` 路径生成器几何细节。
  - modern-screenshot 截图功能、Ctrl+滚轮 zoom、drag-to-scroll、`useMagicKeys` 快捷键。
  - `OptionSelectGroup`/`DisplayModuleType`/`DisplayAuthors` 等 UI 子组件的样式细节。
  - Vue 路由 `[...chart]` / `[...grid]` catch-all 的 Nuxt 路由约定。

- **推荐的一个执行轨迹例子**（演权衡 #1）：
  输入：4 个包 — `app`（workspace，0 字节，依赖 `lodash@4` 和 `react@18`）、`lib`（workspace，0 字节，依赖 `lodash@4`）、`lodash@4`（10 KB，`shallowestDependent={app,lib}` 取最浅=app）、`react@18`（50 KB，`shallowestDependent={app}`）。
  1. `tree` computed 拿到 `[app, lib, lodash, react]`。
  2. `pkgToNode(app)`：children = `[lodash, react]`。partition 后两个都属于 `shallowest`（app 是它们的最浅 dependent），都 push 到 app 下。
  3. `pkgToNode(lib)`：children = `[lodash]`，但 `map.has(lodash)` 已为 true → 返回 undefined → lib.children 为空。
  4. macrosTasks 回填：app.size = 0+10+50 = 60 KB，lib.size = 0，root.size = 60 KB。
  5. Treemap 渲染：root 总面积 60，react 占 50/60≈83%，lodash 占 17%，lib 占 0%（**不可见**）。
  输出：用户看到 app 子树占满全屏，react 主导，lodash 一小块；lib 完全消失——这正是"分桶避免重复"的代价。

> 以上钩子供 Writer 写「动机→核心思想→心智模型→关键权衡→原理演示」；下面事实部分供核对，不要被 Writer 当目录照抄。

## 概念要点

- **五种视角 = 三种中间结构**：chart（treemap/sunburst/flamegraph 共用一种 `ChartNode` 树）、graph（d3 的 `HierarchyNode`）、grid（`Group[]`）。前三种图表**共享同一棵树**，仅末端渲染器不同。源码位置: `packages/node-modules-inspector/src/app/pages/chart/[...chart].vue:25-139`, `packages/node-modules-inspector/src/app/pages/graph.vue:1-60`, `packages/node-modules-inspector/src/app/pages/grid/[...grid].vue:25-149`
- **`ChartNode` 是 nanovis 的 `TreeNode<PackageNode | undefined>` 别名**——把"业务节点"包成"视觉节点"，业务实体挂在 `meta` 字段上，视觉字段（size/text/subtext/children/parent）独立。源码位置: `packages/node-modules-inspector/src/app/types/chart.ts:1-4`
- **`shallowestDependent` 是图物化阶段预先算好的字段**：每个包被多少父节点依赖，其中**深度最浅**的那个父的 spec 进这个 Set。它不是可视化层算的，而是 `dep-graph-materialize` 章的产物。chart 视图只是消费它做分桶。源码位置: `packages/node-modules-tools/src/types/node.ts:43-44`, `packages/node-modules-tools/src/agent-entry/list.ts:76-80`
- **chart 的"延迟任务队列"**：`pkgToNode` 不直接递归，而是把"挂 shallowest 子节点"和"挂 others 子节点"分别 `unshift`/`push` 到 `tasks` 数组，然后 `runTasks()` 自递归清空队列——这是手动模拟 BFS。源码位置: `packages/node-modules-inspector/src/app/pages/chart/[...chart].vue:41-131`
- **"10% 自占阈值"**：若一个节点自身的字节占它子树总量的 >10%，会**额外造一个 `${id}-self` 子节点**——否则 treemap 只画叶子，父节点自身的体积会被吞掉看不见。源码位置: `packages/node-modules-inspector/src/app/pages/chart/[...chart].vue:99-110`
- **graph 的"虚拟根 + seen 去重 + 孤儿回收"**：合成一个 `{ name: '~root' }` 做根；用 `seen: Set` 让同一包只出现一次；对于从根遍历不到的"孤儿包"，先按深度排序进 `orphan` Set，再用不动点迭代把"被其他孤儿依赖的孤儿"踢出（保留最浅的那个做根）。源码位置: `packages/node-modules-inspector/src/app/pages/graph.vue:20-54`, `packages/node-modules-inspector/src/app/components/graph/Canvas.vue:76-90`
- **graph 的"旋转 trick"**：d3 `tree()` 默认输出 top-down（x=横向，y=纵向），代码在布局完成后直接 `[node.x, node.y] = [node.y - SPACING.width, node.x]` 把图旋转 90° 成 left-right。源码位置: `packages/node-modules-inspector/src/app/components/graph/Canvas.vue:97-115`
- **graph 的"两套 link 池"**：主 `links.value` 是树内的所有边；`additionalLinks.value` 是**选中节点**的 dependencies/dependents 里那些不在主树中的边（即被去重丢掉的多重父子关系）——只对当前选中节点临时补回，避免一次性把整张图画乱。源码位置: `packages/node-modules-inspector/src/app/components/graph/Canvas.vue:135-149`, `203-229`
- **grid 是"按字段分桶"**：6 个 tab（depth/clusters/module-type/authors/licenses/provenance）共用同一个 `Map<key, PackageNode[]>` 模式，只是 key 提取方式不同；模板里用 `Group.cluster/module/author/license/provenance` 几个可选字段决定 badge 渲染。源码位置: `packages/node-modules-inspector/src/app/pages/grid/[...grid].vue:25-149`
- **nanovis 与 d3 的分工**：chart 用 nanovis（自带 canvas/SVG 渲染 + 颜色 palette + 选中态动画）；graph 用 d3-hierarchy（只算坐标）+ 手写 SVG（完全控制路径/分层/交互）。两种图表**用了完全不同的渲染哲学**。
- **chart 的 dispose-rebuild 模式**：每次 `chart.value | tree.value | options.value` 变化都 dispose 旧的 nanovis 实例（释放 DOM/事件）再 new 一个新的——选择"全量重建"而非"增量更新"，因为 nanovis 内部状态对增量不友好。源码位置: `packages/node-modules-inspector/src/app/pages/chart/[...chart].vue:212-247`

## 关键调用链

**chart 路径**：
`payloads.filtered.packages` → `tree` computed (`pkgToNode` + `tasks/macrosTasks` 队列) → `ChartNode` 根 → `new Treemap|Sunburst|Flamegraph(root, options)` → `graph.el` (DOM) → `<ChartTreemap>` 等 wrapper 的 `watchEffect` 把 `el` append 进容器。
源码位置: `packages/node-modules-inspector/src/app/pages/chart/[...chart].vue:25-139, 212-247`；wrapper: `packages/node-modules-inspector/src/app/components/chart/Treemap.vue:12-17`

**graph 路径**：
`payloads.filtered` + `rootPackages` computed（focus/workspace/孤儿回收）→ `<GraphCanvas>` props → `calculateGraph()` → `hierarchy<PackageNode>(~root, childrenAccessor)` → `tree().nodeSize([...])` 算坐标 → 旋转 x/y → 渲染 `<svg>` + `<GraphNode>`/`<GraphDot>` 绝对定位。
源码位置: `packages/node-modules-inspector/src/app/pages/graph.vue:10-55`；Canvas: `packages/node-modules-inspector/src/app/components/graph/Canvas.vue:71-162`

**grid 路径**：
`payloads.filtered.packages` → `groups` computed 按 tab 分支构造 `Map<key, PackageNode[]>` → 转 `Group[]` → `<GridExpand>` 渲染。
源码位置: `packages/node-modules-inspector/src/app/pages/grid/[...grid].vue:25-149`

## 源码摘录（带行号，全文累计 ≤ 30 行）

chart 的分桶 + 延迟任务（核心权衡 #1）：
```ts
// packages/node-modules-inspector/src/app/pages/chart/[...chart].vue:70-91
const [shallowest, others] = partition(validChildren,
  i => i.shallowestDependent?.has(pkg.spec))
tasks.unshift(() => {
  node.children.push(...shallowest.map(p => pkgToNode(p, node, depth+1)).filter(x => !!x))
})
tasks.push(() => {
  node.children.push(...others.map(p => pkgToNode(p, node, depth+1)).filter(x => !!x))
})
```

graph 的孤儿回收（核心权衡 #2 的兜底）：
```ts
// packages/node-modules-inspector/src/app/pages/graph.vue:36-47
const orphan = new Set(payload.packages.filter(x => !seen.has(x)).sort((a,b) => a.depth - b.depth))
let changed = true
while (changed) {
  changed = false
  for (const pkg of orphan)
    if (payload.dependents(pkg).some(x => orphan.has(x))) { orphan.delete(pkg); changed = true }
}
```

Canvas 的"旋转 trick"（核心权衡 #4 的几何准备）：
```ts
// packages/node-modules-inspector/src/app/components/graph/Canvas.vue:98-101
const _nodes = root.descendants()
for (const node of _nodes)
  [node.x, node.y] = [node.y! - SPACING.width, node.x!]
```

Canvas 的"选中节点跨树补边"（权衡 #2 的副作用补偿）：
```ts
// packages/node-modules-inspector/src/app/components/graph/Canvas.vue:211-218
for (const dep of selected.data.dependencies) {
  const id = `${selected.data.spec}|${dep}`
  if (linksMap.has(id)) continue
  const target = nodesMap.get(dep)
  if (target) links.push({ id, source: selected, target })
}
```

## 易混淆 / 边界 / 推断

- **事实**：`partition` 来自 `@antfu/utils`，行为是 `[匹配的, 不匹配的]` 两数组——所以"shallowest"是"当前 pkg 是这些 children 的最浅 dependent"。源码位置: `packages/node-modules-inspector/src/app/pages/chart/[...chart].vue:5, 70-73`
- **事实**：graph 的 `~root` 是一个合成节点（`{ name: '~root', spec: '~root' } as any`），用 `as any` 绕过类型——因为 PackageNode 不允许这种占位实体。源码位置: `packages/node-modules-inspector/src/app/components/graph/Canvas.vue:78`
- **事实**：chart 与 graph 的"去重策略不同"——chart 用 `map.has(pkg)` 判断（已造过 ChartNode 就跳过），graph 用 `seen.has(x)` 判断（已访问过 PackageNode 就跳过）；前者丢失"重复边"，后者丢失"重复节点"。源码位置: chart `:51-52`, Canvas `:85`
- **推断**：`tasks.unshift(...shallowest)` + `tasks.push(...others)` 这种 unshift/push 混用是为了让队列整体表现为"先把所有节点的 shallowest 子节点处理完（BFS 一层），再回头处理 others"——这是为了让兄弟节点在视觉上相邻，**未在注释中明确说明，从代码模式推断**。
- **推断**：graph 的"旋转 trick"而不是直接用 d3 的 `tree().separation()` + 自定义 orient，可能是因为 d3-hierarchy 的 `tree()` 只支持 top-down——换 orient 需要自己镜像坐标，作者选择了更短的"事后 swap x/y"。**未在注释中说明，从代码推断**。
- **边界**：grid 的 `MAX_DEPTH = 5` 是硬编码——超过 5 层的包都被合并进"Depth 5"桶。源码位置: `packages/node-modules-inspector/src/app/pages/grid/[...grid].vue:14, 133-135`
- **边界**：chart 的 `~root` 节点不参与 nanovis 的交互（`onClick` 把 `node.meta` 写进 `selectedNode`，但 root 的 `meta` 是 undefined）；graph 的 `~root` 在渲染时被 `node.data.spec !== '~root'` 显式过滤掉。源码位置: chart `:32-38, 145-149`；Canvas `:360`
- **未理解**：`getCompareHighlight` 在 graph 的 link 染色逻辑里出现的 'a'/'b'/'both' 三态——这是与"对比模式（compareA/compareB）"联动的染色，但本章 sourceFiles 没覆盖对比模式的完整链路，**留给依赖章节解释**。源码位置: `packages/node-modules-inspector/src/app/components/graph/Canvas.vue:280-295`
- **事实**：nanovis 是外部库（`nanovis@1.0.0`，`catalog:frontend`），不在 sourceFiles 内——本章只讲"如何用它"，不讲"它内部怎么画"。源码位置: `packages/node-modules-inspector/package.json`（catalog 引用）, `pnpm-lock.yaml:5552`
# 可视化层：treemap/sunburst/flamegraph/graph/grid

> 本章属于 system 层。前置：响应式 payload 级联。
> 学完你能用一句话讲清：为什么五种视角能共用同一份依赖图，以及把 DAG 折叠成树时各视角做了什么不同的取舍。

## 1. 为什么需要它

上一章把「同一份 RPC handlers 适配成 dev / build / check / report / mcp 五种 CLI 子命令」讲完——业务逻辑写一遍，外壳按场景换。这一章把同一招再玩一次，场景换到 UI：依赖图只有一份，但用户想在屏幕上看到的形状有五种。

装完一个 monorepo，`node_modules` 里堆上千个包。用户的问题不是「列出来」（一眼看不完），而是几种具体问法：

- 最大的几个包是谁？
- 谁依赖谁？
- 同一个包被装了几个版本？

三种问法对应三种几乎不重叠的视觉编码。「最大几个」按面积比例排矩形，是 treemap；「谁依赖谁」画节点和连线，看钻石 / 链式 / 星形，是 graph；「装了几版」按 spec 平铺分组，是 grid。三种图表的几何 / 拓扑差异是真实的，但底层数据是同一张 `PackageNode[]`。

如果每种视角都从零写一份渲染逻辑：依赖图到形状的转换会重复写五次，过滤口径会漂移，加一种图表就要把转换、过滤、交互各重做一遍。本章这一层存在的意义，就是把这条「图 → 形状」的转换显式化、共用化。

## 2. 核心思想

加一层中间数据结构。

在「扁平依赖图」和「具体几何坐标」之间塞一段**中间结构**：treemap / sunburst / flamegraph 共用一种 `ChartNode` 树；graph 用 d3 的 `HierarchyNode`；grid 用一个 `Group[]`。中间结构是契约，前端可以换渲染器、后端可以换过滤策略，互不惊动。

这是一个典型「加层就解耦」的设计——但本章真正要讲的不在这里，而在那个加层过程中绕不开的一道老问题：**依赖图本质是 DAG（甚至带环），而主流布局算法只吃树**。同一个包被多个父依赖时，要不要在树里复制？答案决定每种图表的性格。本章 §4 的四条权衡都是围绕这个根本矛盾的四种解。

## 3. 心智模型

整条流水线五步：

1. 从 `payloads.filtered.packages` 拿到过滤后的扁平 `PackageNode[]`（怎么收窄到这一步是前置章的事，本章直接消费）。
2. 按视角构造中间结构：chart 是 `ChartNode` 树、graph 是 `HierarchyNode`、grid 是 `Group[]`。
3. 构造过程中处理 DAG → 树的歧义，三种视角各用不同策略。
4. 把中间结构交给布局引擎：d3-hierarchy 算 x/y，nanovis 算矩形或扇形坐标。
5. 物化到 DOM/SVG，绑交互；数据变了就 dispose 旧实例、重建新的。

分叉点在第 2 步——选哪种中间结构，决定后面整套渲染哲学。chart 系（treemap/sunburst/flamegraph）三图共用同一棵 `ChartNode` 树，只是末端的 nanovis 渲染器换一个类；graph 用 d3-hierarchy 算坐标、自己手画 SVG；grid 完全不算几何，按字段分桶后丢给普通列表组件。

## 4. 关键权衡

### 用 shallowestDependent 分桶，换 treemap 体积不重复累计

treemap 用面积表示字节数。同一个 `lodash@4` 被 `app` 和 `lib` 同时依赖——它在依赖图里是同一个节点，磁盘上只有一份字节。如果 treemap 把它同时在 `app` 子树和 `lib` 子树下各画一块，体积会被算两遍，「最大的包是谁」立刻失真。

机制：依赖图物化阶段（前置章）每个包已经预算好 `shallowestDependent`——所有依赖它的父节点里最浅的那个 spec。构造 chart 时，`pkgToNode(pkg)` 把 `pkg` 的 children 按 `child.shallowestDependent.has(pkg.spec)` 分两组：属于自己最浅父身份的，挂进 children；不属于的，跳过——这个包的 ChartNode 由那个最浅父负责挂，自己不重复。

代价：在 treemap 里，`lib`（依赖 lodash 但不是它的最浅父）会「看起来什么都没装」，体积显示为 0。跨树父子关系在视觉上彻底被隐藏。要看 lib→lodash 这条边，得切到 graph 视图，选中 lib，靠下一节会讲到的 `additionalLinks` 临时补画。

本质矛盾：treemap 这种「父矩形被子矩形无缝填满」的视觉契约，要求每个字节有且只有一个归属父——可依赖图里同一个包是多对一的。shallowestDependent 是个**仲裁规则**，把「多对一」硬折叠成「一对一」，付的是丢失真实归属关系。grid 选择完全绕开（按字段重新分桶，没有父子结构），graph 选择「拍扁 + 临时补丁」（下一节展开）——三种视角各自给同一个矛盾不同的解。

### 用 `seen` + 假根 `~root` 把 DAG 拍扁成树，换 d3-tree 算法直接可用

graph 视图用 d3-hierarchy 的 `tree()`——它只吃树。但依赖图多根（workspace 内的几个包都是根）、多对一（同一个工具包被多个父依赖）。

机制：合成一个 `{ name: '~root', spec: '~root' }` 占位根把多根接成单根；构造 children 时维护一个 `seen: Set`，遍历到任何包都先标记，重复依赖直接 filter 掉——先到先得。

代价：被多次依赖的包在图里只出现在它**第一次被访问到的那条路径**下，其他父指向它的边直接消失。graph 既不是依赖树也不是依赖图，而是一棵「依访问顺序拼出来的树」。

为了把丢失的边找回来一点，graph 还做了「孤儿回收」和「按需补边」两件事。从根遍历完之后，对那些从根走不到的「孤儿包」，先按深度排序进 `orphan` Set，再跑一轮不动点迭代：如果某个孤儿被另一个孤儿依赖，就把被依赖的那个踢出 orphan（保留更浅的那个做根）。这是为了让每个孤儿都尽量挂在最像它归属的位置上。再上一层，当用户选中某个节点时，`additionalLinks` 会临时把这个节点在主树之外的 dependencies / dependents 边补画出来，离开选中态又消失——平时图保持清爽，需要看跨树关系时局部补回。

本质矛盾：树布局算法的强约束（每个节点只有一个父）与依赖图的真实拓扑（多对一）之间的冲突。graph 彻底倒向「算法可用」这边——它要的是节点位置和层级感的几何美感，不是边的完备性。这种取舍在所有用树布局画 DAG 的场景里都会复现：要么复制节点（图爆炸）、要么丢边（信息不全）、要么按需补边（行为复杂）。graph 选了第三条。

### 用延迟任务队列做 BFS 风格的子树展开，换同层节点视觉相邻

`pkgToNode` 如果直接递归：访问 app → 进入 app 的 children → 先访问 lodash → 进入 lodash 的 children……这是深度优先。结果是兄弟节点 `react` 会被 lodash 的整个子树「隔开」——treemap 切矩形时，相邻的子矩形如果是来自不同分支的，色块会显得散乱。

机制：构造 ChartNode 时**不立即递归**子节点，而是把「挂 shallowest 子节点」和「挂 others 子节点」两个动作各包成 closure，分别 `unshift` 和 `push` 进 `tasks` 队列；`runTasks()` 一边执行队列一边把新压入的任务再清空，整体行为是手动模拟 BFS——同层节点的「挂 children」动作聚到队列相邻位置，渲染时它们在视觉上就相邻。

代价：读代码的人看到 `tasks.unshift(...); tasks.push(...)` 时很难一眼明白为什么不直接递归；`runTasks` 还得自递归清空队列，控制流绕，新加一类「挂子节点」的逻辑要先理解队列语义。

本质矛盾：函数调用栈天然是深度优先的，但视觉聚合要求宽度优先。延迟任务队列是手动把调用栈「展平」成一个可控的队列，把「什么时候访问子」这件事从运行时拿回到作者手里。同样的取舍在所有「递归算法天然深度优先，但需求要宽度优先」的场景里都会冒出来：编译器 AST 遍历、文件系统扫描、消息广播——只要顺序敏感，都会有「递归 vs 队列」这一选。

### 用静态 / 活动双层 SVG，换高亮逻辑脱离基础渲染

graph 的边可能有上千条。如果给每条 path 加一个 reactive class，选中节点切换时 Vue 要遍历所有边算响应式更新——会卡。

机制：所有边画一遍灰色在一个 SVG（z 低）；选中节点的相关边用主色再画一遍在另一个 SVG（z 高）。后者只是按选中态过滤一份小数组，前者从不重渲染。

代价：选中节点的相关边其实画了两遍（灰底一遍 + 主色一遍）。两套 SVG 元素，path 数据结构相同，DOM 体积翻倍。这条权衡的代价面较薄，主要是 DOM 内存与重复 path 计算——但 graph 边上千条时，重叠那一份会肉眼可见。

本质矛盾：基础渲染希望「画一次再也不动」（稳），高亮希望「瞬时切换」（快）。两个 SVG 把这两件事解耦：稳的归稳，快的归快，重叠一遍 path 是付的「租金」。同样的取舍在所有「静态背景 + 动态前景」的可视化里都通用：地图底图 + 路线高亮、表格 + 选中行、IDE 代码 + 高亮 token。

## 5. 最小原理演示

只演第一条权衡：shallowestDependent 分桶 + 体积回填。其它三条在本章演示里都故省略。不到 50 行 TS，`bun run` / `ts-node` 跑通，`console.log` 出树形 JSON 即可验证「同一份字节只在一个父下被累计」这一原理。

```ts
type Node = {
  id: string
  sizeSelf: number
  size: number
  children: Node[]
}

type Package = {
  spec: string
  depth: number
  bytes: number
  dependencies: string[]
  shallowestDependent: Set<string>
}

function buildTree(pkgs: Package[]): Node {
  const bySpec = new Map(pkgs.map(p => [p.spec, p]))
  const placed = new Set<string>()
  const tasks: (() => void)[] = []

  const root: Node = { id: '~root', sizeSelf: 0, size: 0, children: [] }

  function pkgToNode(pkg: Package, parent: Node): Node | undefined {
    // 已经被更浅的父挂走了：这正是「分桶换体积不重复」的代价面
    if (placed.has(pkg.spec))
      return undefined
    placed.add(pkg.spec)

    const node: Node = { id: pkg.spec, sizeSelf: pkg.bytes, size: pkg.bytes, children: [] }
    parent.children.push(node)

    const deps = pkg.dependencies
      .map(d => bySpec.get(d)!)
      .filter(d => d && !placed.has(d.spec))

    for (const dep of deps) {
      const iAmItsShallowest = dep.shallowestDependent.has(pkg.spec)
      if (iAmItsShallowest) {
        // 自己是最浅父，优先挂——同层兄弟在视觉上聚成连续色块
        tasks.unshift(() => pkgToNode(dep, node))
      } else {
        // 留给那个最浅父去挂；本分支不挂，体积不重复累计
        tasks.push(() => pkgToNode(dep, node))
      }
    }
    return node
  }

  const rootDepth = Math.min(...pkgs.map(p => p.depth))
  for (const pkg of pkgs.filter(p => p.depth === rootDepth))
    pkgToNode(pkg, root)

  // 自递归清空队列，整体表现为 BFS
  const run = () => {
    const batch = [...tasks]
    tasks.length = 0
    batch.forEach(fn => fn())
    if (tasks.length) run()
  }
  run()

  // 自底向上回填每个父节点的 size = 自身 + 所有子树
  const backfill = (n: Node): number => {
    if (n.children.length === 0) return n.sizeSelf
    n.size = n.sizeSelf + n.children.reduce((s, c) => s + backfill(c), 0)
    return n.size
  }
  backfill(root)

  return root
}
```

整段演示的核心是中间那个 `for` 循环：每个子节点根据 `shallowestDependent.has(pkg.spec)` 决定是 unshift 还是 push、或者干脆不被挂——决定了它要不要计入这个父的体积。`backfill` 那段只是把决定的结果累加回父节点。

## 6. 执行轨迹

输入 4 个包：

| spec | depth | bytes | dependencies | shallowestDependent |
|---|---|---|---|---|
| `app` | 0 | 0 | `lodash@4`, `react@18` | `{}` |
| `lib` | 0 | 0 | `lodash@4` | `{}` |
| `lodash@4` | 1 | 10 | （无） | `{app}` |
| `react@18` | 1 | 50 | （无） | `{app}` |

`app` 和 `lib` 都依赖 lodash，但 lodash 的 `shallowestDependent` 只含 `app`。

走一遍 `buildTree`：

1. `rootDepth = 0`，入口循环对 `app`、`lib` 顺序调用 `pkgToNode`。
2. `pkgToNode(app, root)`：创建 app 节点，push 进 root.children。app 的 deps = `[lodash, react]`。两者都没被 placed。
   - lodash：`shallowestDependent.has('app')` = true → `tasks.unshift(挂 lodash 到 app)`
   - react：同上 → `tasks.unshift(挂 react 到 app)`
   - 此时 tasks = `[挂 react, 挂 lodash]`（unshift 把后入的放前）
3. `pkgToNode(lib, root)`：创建 lib 节点，push 进 root.children。lib 的 deps = `[lodash]`。lodash 此刻仍未 placed（队列还没执行）。
   - lodash：`shallowestDependent.has('lib')` = **false** → `tasks.push(挂 lodash 到 lib)`
   - 此时 tasks = `[挂 react→app, 挂 lodash→app, 挂 lodash→lib]`
4. `run()` 取 batch = 整个 tasks，tasks 清空。按顺序执行：
   - `挂 react→app`：`pkgToNode(react, app)` 创建 react 节点（sizeSelf=50）push 进 app.children。react 无依赖。tasks 空。
   - `挂 lodash→app`：`pkgToNode(lodash, app)` 创建 lodash 节点（sizeSelf=10）push 进 app.children。tasks 空。
   - `挂 lodash→lib`：进入 `pkgToNode` 第一行 `placed.has('lodash@4')` = true → **直接 return undefined**。lib.children 不变。
5. tasks 已空，run() 退出。
6. `backfill(root)` 自底向上：
   - react.size = 50；lodash.size = 10
   - app.size = 0 + 50 + 10 = **60**
   - lib.size = 0 + 0 = **0**（无 children）
   - root.size = 60 + 0 = 60
7. Treemap 渲染：root 总面积 60 KB。app 子树占满全屏——react ≈ 83%（50/60），lodash ≈ 17%（10/60），app 自身占 0%。lib 子树占 0%，**在 treemap 里完全看不见**。

用户最后看到的画面：app 一片主导，react 是绝对主力，lodash 是 app 下的一小块。lib 那一格因为体积是 0，连一条缝都看不到——可它真实依赖 lodash，关系并未消失，只是被 treemap 的仲裁规则判给了 app。要看 lib→lodash 这条边，得换 graph 视图，选中 lib，让 `additionalLinks` 把这条跨树边临时画回来。

## 7. 教学简化说明

本章演示故意省略：

- nanovis 库的内部渲染（canvas/SVG 怎么算矩形坐标、palette 怎么取色）——它是外部依赖，本章只讲「如何喂它一棵树」。
- d3 `linkHorizontal` / `linkVertical` 的路径几何、graph 的旋转 + margin 偏移技巧。
- 10% 自占阈值（节点自身字节占子树 10% 以上时，额外造一个 `-self` 子节点防止自身体积被吞）。
- Vue 响应式的 dispose-rebuild 模式（chart 每次 computed 变化都 dispose 旧 nanovis 实例、new 一个新的）。
- 颜色 spectrum / module-type 双模式、截图、Ctrl+滚轮 zoom、拖拽平移、快捷键。

这些是工程化包装，不表达「同一份图、五种投影」这条主线。

## 8. 小结

可视化层把同一张依赖图按用户当下的问题形状（最大几个、谁依赖谁、谁重复装）投影成完全不同的视觉编码，关键不在画工而在中间结构这一层：把 DAG 折叠成树的决定权，从布局算法手里拿回到自己手里——四种折法换来四种性格，代价也都是真实存在的。回看全书，从 JSON 流式解析、包管理器归一、依赖图物化、过滤器级联、到这一章，每一步都在把「原始数据 → 可消费形状」的转换显式化；中间结构是这条链上最显眼的一份契约。
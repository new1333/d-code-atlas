# 可视化层：一张依赖图，五种视角

## 你打开了一个 monorepo，看见 1200 个包

刚 `pnpm install` 完，`node_modules` 里堆了一千多个包。你心里其实只有三个问题：

1. **最大的几个是谁**——哪些包吃掉了大部分磁盘？
2. **谁依赖谁**——升级 `lodash@4` 会牵动哪些下游？
3. **同一个包被装了几个版本**——重复的 `react` 到底散落在哪里？

这三个问题对应三种完全不同的画法。问"最大"要画面积图（treemap）；问"关系"要画节点-连线图（graph）；问"重复"要按字段分组列表（grid）。再加 sunburst 和 flamegraph，凑成五种视角。

如果每种视角都从零写一份渲染逻辑——读图、过滤、算坐标、画 DOM——代码会爆炸，而且每种视角对"依赖关系"的理解一旦不一致，结果就互相打架。

这一章讲的是：**怎么把同一份依赖图，变成五种视角**。

## 心智模型：五种视角 = 三种中间结构

想象流水线上有三个工位：

- **第一工位（数据）**：扁平的 `PackageNode[]`。所有包的元数据已经在前几章算完，每个包身上挂着 `dependencies`/`dependents`/`depth`/`shallowestDependent` 这些字段，可以直接查。
- **第二工位（中间结构）**：把扁平数组转成**布局引擎吃得下去的形状**，共三种：
  - chart 系列（treemap/sunburst/flamegraph）共用一种 **`ChartNode` 树**；
  - graph 视图用 **d3 的 `HierarchyNode`**（也是树，但坐标系不同）；
  - grid 视图用 **`Group[]`**（按字段分桶的列表）。
- **第三工位（布局引擎）**：中间结构进来，DOM 出去——chart 系列交给 nanovis（外部库，自带画布和动画），graph 交给 d3-hierarchy（只算坐标，DOM 自己画）。

换句话说：**视角差异本质是数据结构 + 布局算法的差异**，不是业务逻辑的差异。把"图 → 中间结构 → 布局引擎"这条流水线显式化后，新增一种图表只需要换最末端的渲染器。

下面先从最复杂的 chart 系列讲起（它是这一章的核心机制所在），最后用 graph 和 grid 收尾。

## chart 系列：从 DAG 拍出一棵树

### 为什么是树，不是图

依赖图本质是**有向有环图**——一个包可能被多个父依赖，循环依赖也会出现。但 treemap 这种视觉编码要的是**树**：每个矩形要么是叶子，要么被子矩形完全切分。说人话就是：**同一份体积只能算在一个父节点名下**。

所以 chart 系列的核心动作是：**从扁平 `PackageNode[]`，挑出"最应该当根"的那些包，递归地把它们的子依赖挂上来，遇到一个包被多个父依赖时，只挂在其中一个父名下**。

### 用 shallowestDependent 决定"挂在谁下面"

每个 `PackageNode` 身上有个字段叫 `shallowestDependent`，是图物化阶段预先算好的——意思是"**依赖我的那些包里，深度最浅的那一层父**"。注意，是"最浅那一层"，不是"所有父"。

举个例子：

- `app` 在深度 0，`lib` 也在深度 0，它们都依赖 `lodash`；
- 因为两个父都在最浅的同一层，`lodash.shallowestDependent = { app, lib }`——两个都装；
- 假如 `lib` 在深度 1（比 `app` 深），那 `lodash.shallowestDependent = { app }`——只装最浅那层，`lib` 不出现。

（不要把这个字段和 `dependents` 混淆——后者装的是**所有**直接依赖者，不分深度。两个 Set 在源里是分开的。）

chart 视图拿到这个字段后，干的事情是：**对当前 pkg 的所有子依赖做 partition**——

- `shallowest` 桶：子依赖的 `shallowestDependent` 包含当前 pkg，意思是"当前 pkg 是它最浅的依赖者之一，应该挂在我下面"；
- `others` 桶：当前 pkg 不是它最浅的依赖者，应该挂到别的父下面去。

这是 chart 系列的核心机制——下面用一段最小代码演透它。

## 最小演示：4 包 DAG 转成 treemap 树

输入是 4 个包。`app` 和 `lib` 都是 workspace、都在深度 0；它们都依赖 `lodash`：

```ts
type Pkg = {
  spec: string
  name: string
  sizeSelf: number                 // 自身字节数
  depth: number
  dependencies: string[]
  // 严格遵循真源语义：只装"最浅那一层"的父
  shallowestDependent: Set<string>
}

const packages: Pkg[] = [
  { spec: 'app',      name: 'app',    sizeSelf: 0,      depth: 0,
    dependencies: ['lodash@4', 'react@18'], shallowestDependent: new Set() },
  { spec: 'lib',      name: 'lib',    sizeSelf: 0,      depth: 0,
    dependencies: ['lodash@4'],             shallowestDependent: new Set() },
  // 两个父 app、lib 都在最浅深度 0，所以都进 shallowestDependent
  { spec: 'lodash@4', name: 'lodash', sizeSelf: 10_000, depth: 1,
    dependencies: [], shallowestDependent: new Set(['app', 'lib']) },
  { spec: 'react@18', name: 'react',  sizeSelf: 50_000, depth: 1,
    dependencies: [], shallowestDependent: new Set(['app']) },
]
```

下面这段从零实现，演示"partition 分桶 + 体积回填"两个动作：

```ts
type TreeNode = {
  id: string
  sizeSelf: number
  size: number            // 子树总体积，回填阶段算
  children: TreeNode[]
}

const built = new Map<Pkg, TreeNode>()

function buildTree(pkg: Pkg): TreeNode | undefined {
  // 关键 1：已被别的父造过 → 直接返回 undefined
  if (built.has(pkg)) return undefined

  const node: TreeNode = {
    id: pkg.spec, sizeSelf: pkg.sizeSelf, size: pkg.sizeSelf, children: [],
  }
  built.set(pkg, node)

  // 找出所有还没被造过的子依赖
  const validChildren = pkg.dependencies
    .map(spec => packages.find(p => p.spec === spec)!)
    .filter(child => !built.has(child))

  // 关键 2：partition —— 当前 pkg 是不是这个子依赖的最浅依赖者？
  const [shallowest, others] = partition(validChildren,
    child => child.shallowestDependent.has(pkg.spec))

  // 两个桶都尝试挂：挂载动作会调 buildTree，已被造过的会返回 undefined 被 filter 掉
  for (const child of [...shallowest, ...others]) {
    const childNode = buildTree(child)
    if (childNode) node.children.push(childNode)
  }

  // 关键 3：体积回填 —— 子树体积 = 自己 + 所有子
  node.size = node.sizeSelf + node.children.reduce((s, c) => s + c.size, 0)
  return node
}

function partition<T>(arr: T[], pred: (x: T) => boolean): [T[], T[]] {
  const yes: T[] = []; const no: T[] = []
  for (const x of arr) (pred(x) ? yes : no).push(x)
  return [yes, no]
}

// 从 depth=0 的根开始（即 app 和 lib）
const roots = packages
  .filter(p => p.depth === 0)
  .map(buildTree)
  .filter(x => x)

console.log(JSON.stringify(roots, null, 2))
```

跑一遍这段代码，执行轨迹长这样：

1. `buildTree(app)`：`validChildren = [lodash, react]`。partition 时，`app` 是 `lodash` 的最浅依赖者之一（在它的 `shallowestDependent` 里）→ 进 `shallowest` 桶；同理 `react` → `shallowest` 桶。两个都递归挂到 `app.children`。`built` 现在包含 `app, lodash, react`。
2. `buildTree(lib)`：`lib.dependencies = ['lodash@4']`，但 `lodash` 已经在 `built` 里——所以 `validChildren` 经过预过滤后变空。`lib.children` 保持空。
3. 体积回填：`app.size = 0 + 10_000 + 50_000 = 60_000`；`lib.size = 0`；`lodash.size = 10_000`；`react.size = 50_000`。

最终树形：

```
app (size=60000)
├── lodash (size=10000)    占 ~17%
└── react (size=50000)     占 ~83%
lib (size=0)               完全没有子节点 —— treemap 里看不见
```

treemap 把 `app` 子树铺满整个画布：`react` 占 83%，`lodash` 占 17%，`lib` 是个 0 字节的空矩形。**这就是"分桶避免体积重复"的代价**：`lib` 在视觉上消失了——尽管它真的依赖了 `lodash`。

### 故意省略的部分

为了讲清核心，上面的演示和真源有几处刻意不同，必须说明白：

1. **只演示了同步递归（深度优先）**：真源不直接递归，而是把"挂子节点"压成 closure 推进 `tasks` 数组，再用 `runTasks()` 自递归清空队列——这是手动模拟 BFS，让同层节点聚集成连续视觉块。演示用了普通 for 循环，结果是深度优先，没有"同层聚集"效果，但 partition 和体积回填的逻辑一致。
2. **真源对两个桶分别用 `unshift` / `push`，演示合并成了一个循环**：真源对 `shallowest` 桶用 `tasks.unshift(...)`（推到队头，优先执行），对 `others` 桶用 `tasks.push(...)`（推到队尾，最后执行）。**两个桶都 push 了挂载任务**——`others` 桶通常挂不上节点，不是因为它没被尝试，而是因为 `pkgToNode` 顶部的 `if (map.has(pkg)) return undefined` 让 BFS 跑完 `shallowest` 后，`others` 调用 `pkgToNode` 全都拿到 `undefined` 被 `filter` 掉了。演示版本把两个桶合并成一个 for 循环直接调 `buildTree`，省略了 BFS 调度，但**去重效果一样**——只要 `lodash` 已经被 `app` 挂过，`lib` 即使想挂也会拿到 undefined。
3. **省略了"10% 自占阈值"的 `${id}-self` 节点**：真源里如果一个节点自身字节占它子树总量的 >10%，会额外造一个虚叶子，否则 treemap 只画叶子、父节点自身的体积会被吞掉看不见。演示不画 treemap，不需要这个补偿。
4. **省略了 nanovis 实例化、Vue 响应式、dispose-rebuild 模式**：这些是工程包装，不表达核心思想，留到本章末尾再说。

## 关键权衡 1：体积不重复 vs 跨树父子关系被藏起来

这是 chart 系列的核心权衡，单独讲透。

**做了的选择**：用 `shallowestDependent` 做分桶，让被多个父依赖的包**只挂在它最浅的那一层父下面**（`shallowest` 桶）。其他父的 `others` 桶虽然也尝试挂，但被 `map.has` 去重滤掉。

**换来了什么**：treemap/sunburst/flamegraph 里**体积不重复累计**。如果 `lodash` 同时挂在 `app` 和 `lib` 下面，它那 10KB 会被算两次——总画布的"100%"就名不副实，面积的相对比例失真。`shallowestDependent` 分桶保证同一份字节只算一次，谁大谁小一目了然。

**代价是什么**：跨树的父子关系在视觉上被藏起来了。`lib` 真的依赖了 `lodash`，但在 treemap 里你看不到这条边——`lib` 是个 0 字节的空矩形，里面没有 `lodash`。要看这种"同一个包被多处复用"的关系，必须切换到 **graph 视图**——那里专门用 `additionalLinks` 把这些被去重丢掉的边临时补回来（见权衡 2）。

换句话说：**chart 系列擅长回答"谁占空间大"，不擅长回答"谁被多处复用"**。问题不同，工具不同。

## 关键权衡 2：graph 也把 DAG 拍成树，但选了完全不同的策略

graph 视图面对同一个"DAG 不是树"的问题，但走了另一条路。

graph 用 d3-hierarchy 的 `tree()` 算法算坐标——这个算法也只吃树。怎么把多根、多继承的 DAG 拍成树？

- **虚拟根**：合成一个 `{ spec: '~root' }` 节点当总根，所有顶层包挂在它下面；这样 d3 只需要一个根入口。
- **`seen` 集合去重**：从根遍历时，访问过的包放进 `Set`，下次再遇到直接跳过——结果是**每个包只出现一次**，挂在第一个发现它的父下面。

**换来了什么**：直接复用 d3-hierarchy 的 Reingold-Tilford 算法（紧凑、对齐、美观），不用自己写层次布局。

**代价是什么**：被多个父依赖的包会被"砍断"——只挂在第一个发现它的父下面，其他父到这个包的边**丢失**。graph 的补救是 `additionalLinks`：当用户选中某个节点时，临时把它的 dependencies/dependents 里那些不在主树中的边补画出来——只对当前选中节点生效，避免一次性把整张图画乱。

对比一下 chart 和 graph 两种"砍重复边"的策略：

- **chart** 用 `shallowestDependent` 选最浅的父——**深度优先挂**，语义上"最像根"的父拿到孩子；
- **graph** 用 `seen` 选第一个访问到的父——**遍历顺序优先挂**，算法上"先到先得"的父拿到孩子。

两种策略本质都是"砍掉重复边让 DAG 变成树"，但判断标准不同：chart 关心"语义合理"，graph 关心"算法方便"。

## 关键权衡 3：延迟任务队列模拟 BFS

回到 chart 系列。为什么真源不直接递归 `pkgToNode`，而是把挂载任务压进队列？

```ts
// 大致结构（伪码）
const tasks: (() => void)[] = []
function pkgToNode(pkg, parent, depth) {
  // ...partition 拿到 shallowest / others...
  tasks.unshift(() => node.children.push(...shallowest.map(...)))  // 推到队头
  tasks.push(()    (() => node.children.push(...others.map(...))))  // 推到队尾
}
function runTasks() {
  const clone = [...tasks]; tasks.length = 0
  clone.forEach(fn => fn())
  if (tasks.length) runTasks()  // 自递归清空
}
```

`unshift` 把当前层所有 `shallowest` 任务推到队头，`push` 把 `others` 推到队尾——结果是**所有节点的 shallowest 子节点先全部挂完一轮**，再回头处理 others。这是手动 BFS。

**换来了什么**：treemap 的色块更整齐——同层节点在视觉上聚集成连续块，不会出现"父节点先把深层孙子画完，再回头画兄弟"的混乱布局。颜色 palette 也是按"同层连续"设计的，BFS 让相邻节点拿到相近色。

**代价是什么**：控制流不直观。读代码的人会问：为什么不直接递归？为什么要 `runTasks` 自递归？因为直接递归是深度优先，跑完一个子树再跑兄弟——兄弟之间不相邻，色块就乱了。这个权衡把"代码可读性"换成了"视觉整齐性"。

## 关键权衡 4：静态/活动双层 SVG（graph）

graph 的边有几十上百条，选中一个节点时只想高亮它相关的几条。怎么做最简单？

graph Canvas 的做法是**画两层 SVG**：

- **底层**：所有边画一遍灰色（静态，渲染一次后不动）；
- **顶层**：只画选中节点相关的边，主色高亮（随选中变化重绘）。

**换来了什么**：高亮逻辑完全脱离基础渲染——不需要给每个 `<path>` 加 reactive class、不用 Vue diff 整张 SVG。底层只渲染一次，顶层只有几条边，重绘成本极低，选中切换很丝滑。

**代价是什么**：两套 SVG 元素 + 重复的 path 数据。底层那条边和顶层那条边是同一个坐标算出来的，画了两遍；如果选中态消失，顶层那一层就空着。

## 收尾：grid 的"按字段分桶"

grid 视图最简单——它不画图，只是**把包按某个字段分桶列出来**。6 个 tab 共用同一个 `Map<key, PackageNode[]>` 模式：

- depth tab：按 `pkg.depth` 分桶（最深 5，超过的合并）；
- clusters tab：按依赖类型/catalog 标签分桶；
- module-type tab：按 cjs/esm/dual/faux 分桶；
- authors / licenses / provenance tab：同理，只是 key 提取方式不同。

**没有"DAG → 树"的转换**，没有布局算法，没有去重——直接列。grid 视图存在的意义是：当 chart 和 graph 都回答不了"按字段看分布"时（比如"哪些包是 MIT 协议"、"哪些包没有 repository 字段"），grid 给你一个俯瞰视角。

## 运行时模式：dispose-rebuild

最后说一个工程层的取舍。chart 视图每次 `tree.value` 或 `options.value` 变化时，nanovis 实例不增量更新，而是**全量重建**：

1. `dispose()` 旧的实例（释放 DOM 和事件监听）；
2. `new Treemap(root, options)` 创建新实例；
3. 把新的 `.el` DOM 节点 append 进容器。

**换来了什么**：状态管理简单——不用追踪"哪些子树变了、要怎么 patch nanovis 内部状态"。每次都是一个干净的开始，bug 不会因为"上一次的状态没清干净"而复现。

**代价是什么**：DOM 抖动——每次状态变化都重建整张图，过渡动画要自己额外做。对 treemap 这种 canvas 渲染的图，重建成本可接受；对 DOM 节点很多的 graph，就**不能**用这种模式（graph 选择增量更新 `<GraphNode>` 组件，每个节点是个独立的 Vue 组件，靠响应式驱动位置）。

同一个项目里，chart 用 dispose-rebuild，graph 用增量更新——**不是作者风格分裂，是渲染载体不同**。nanovis 是黑盒 canvas，增量不友好；d3 + SVG 是白盒 DOM，增量天然支持。

## 小结

- **同一份依赖图、五种视角**，但只有三种中间结构：`ChartNode` 树（treemap/sunburst/flamegraph 共享）、`HierarchyNode`（graph）、`Group[]`（grid）。
- **chart 系列的核心是 `shallowestDependent` 分桶**：让被多处依赖的包只挂一次，体积不重复累计，代价是跨树父子关系被藏起来。
- **graph 选择 `seen` 去重 + 虚拟根**：复用 d3-hierarchy，代价是被多处依赖的包只挂在第一个发现它的父下面；选中时用 `additionalLinks` 临时补回丢失的边。
- **延迟任务队列**手动模拟 BFS，让同层节点视觉聚集、配色连续。
- **静态/活动双层 SVG** 让高亮逻辑脱离基础渲染，代价是 path 数据重复。
- **dispose-rebuild** 用全量重建换状态简单，只适合 canvas 类渲染；DOM 类渲染走增量更新。

每种视角都面对同一个根本张力——**DAG 不是树，但视觉编码要树**——chart、graph、grid 给出了三种不同的拆解策略，对应三种不同的代价。选哪个，取决于你愿意付哪种代价。
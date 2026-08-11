# 依赖图物化：flatDeps/dependents/depth 一次算清

> 本章属于 primitive 层。前置：「包管理器策略：pnpm/npm/bun 三态归一」。
> 学完你能：用一句话讲清「为什么把整张依赖图的闭包/深度/反向依赖在装载期一次性算清写到节点上」——以及那个让前向 DFS 与反向 DFS 时序隔开的 postTasks 延迟回填。

## 1. 为什么需要它（设计动机）

上一章把 pnpm/npm/bun 三种包管理器的清单差异封装到了 agent 内部，上层只拿到一份统一的、只有前向 `dependencies` 边的 `PackageNodeRaw` 流。但读者如果真的拿这张「裸图」去回答前端最常被问的几个问题——「这个包被哪些包传递使用」「它处在依赖链第几层」「为什么装了它」——会发现每点一次都要在图上跑一次 BFS/DFS，前端每筛一次、排一次、点一次都得重算，UI 直接卡死。

依赖图有个根本不对称：**查询频率远远大于改动频率**。`pnpm install` 装出来的图几小时不变，但前端要按体积、层级、被引用次数、为什么引入等几十种维度反复查。若每次查询都现算闭包，单次就是 O(V+E)，几十种维度乘以几万节点，根本撑不住。

物化的动机就是把昂贵的图遍历从查询期整体挪到装载期：装载时算一次，把所有闭包/深度/反向依赖写成节点上的普通字段；查询期只剩「读字段」，O(1)。

## 2. 核心思想

物化的本质是把图查询的**时间和空间对调**——查询期省下来的时间，转成节点上多出来的几个 Set 字段。

更具体一点：图本身的边只在装载期走一遍，走完后每个节点都自带「我的全部传递依赖」「我的全部传递被依赖」「我离最近 workspace 多远」「谁是最浅的依赖者」这些**预先算好的字段**。前端不再碰图结构——它看到的就是一张被「摊平」成字段表的图。

这个「摊平」还顺带把每个节点的**深度**（距最近 workspace 的最短步数）和**最浅依赖者集合**（多条等长最短路径并存时的集合）算了进去。这两个量在装载期靠双 DFS 比较出，查询期直接读。

## 3. 心智模型

数据结构上，每个节点在 `PackageNodeRaw`（只有 `dependencies` 这一边集合）的基础上，物化阶段会渐增加 6 个字段：

- `dependents`：直接反向邻接（谁直接依赖我）
- `flatDependencies`：我的全部传递依赖（下游闭包）
- `flatDependents`：我的全部传递被依赖（上游闭包）
- `depth`：我离最近 workspace 的最短步数
- `shallowestDependent`：距离最短的那一层依赖者集合（可能多条等长最短路径并存，所以是 Set 而非单值）
- `flatClusters`：继承自上游非 workspace 祖先的集群标签

物化分三步：

1. **初始化**：给每个节点挂上空的 Set；workspace 节点 `depth=0`、其他 `depth=Infinity`（用 `Infinity` 而不是 `-1`，是为了让「`depNode.depth > level`」在首次触达时一定成立、自然完成首次赋值，省掉 if/else）。
2. **填反向边**：扫一遍前向边，把对应的 `dependents`（直接反向邻接）填上。
3. **双 DFS**：对每个节点各跑一次「前向 DFS（沿 dependencies 边收所有传递依赖）+ 反向 DFS（沿 dependents 边收所有传递被依赖）」。

关键时序细节：DFS 过程中发现的「互反关系」（A 在 B 的 flatDependencies 里 ⇔ B 在 A 的 flatDependents 里）**不立即写**，而是先 push 进一个 `postTasks` 队列；等这个节点的两个方向 DFS 都跑完，再统一 flush。这是为了让 traverse 期和 flush 期时序分离——下面权衡 3 会展开。

## 4. 关键权衡

### 装载期跑全图双 DFS，把闭包预算到字段上

选择：在装载期对每个节点都跑一次全图双 DFS，把 `flatDependencies`/`flatDependents`/`depth`/`shallowestDependent` 全部预先填好。

换来：查询期纯读字段——前端筛选、排序、「为什么引入」点击展开都是 O(1)，UI 永远不卡。

代价：图任何一条边改动（增删依赖）就要重算所有闭包，没有增量更新能力。这条权衡主要是换来，代价薄到不展开：依赖图来自 `pnpm install`/`npm install` 的输出，一次 install 后图就基本冻结，重算等于「重新跑一次装载」，频率极低。

**本质矛盾**：这是「查询昂贵 vs 改动稀有」这对立需求的经典化解——只要改动频率比查询频率低几个数量级，预算闭包就是划算的；反之若图频繁变动（比如做实时编辑依赖图预览），这套设计就要重做。

### mutate-in-place，不重建对象

选择：用 `Object.assign(pkg, { dependents: ..., flatDependencies: ..., ... })` 直接在原节点对象上添加字段，不重建 Map、不复制对象。

换来：零拷贝、对节点的引用在管线不同阶段保持稳定——上游 agent 创建的对象、物化阶段的对象、后续 resolve 出来的对象，是同一个。上层可以用 `Map<string, PackageNode>` 直接索引，不需要在阶段之间重新映射。

代价：同一个对象在管线不同阶段字段集不同——刚从 agent 出来时只有 raw 字段，物化后多了 6 个闭包字段，resolve 后又会多 `resolved` 子对象。调用方必须知道当前在哪一阶段，不能假设字段已就绪。

**本质矛盾**：这是「对象身份稳定 vs 字段分阶段揭示」的对立——重建对象能保证阶段隔离清晰，但会切断引用链、迫使上层到处用 ID 间接寻址；mutate 保留了引用直接性，代价是把阶段判断的责任交给调用方。整个 node-modules-tools 管线统一选了 mutate，阶段只有「raw / base / resolved」三个明确节点，调用方负担可控。

### 双 DFS 各跑各的，互反字段延迟到 flush 才写

选择：前向 DFS 和反向 DFS 在同一个节点的 `resolveFlatDependencies` 里**串行各跑一遍**，互反字段（前向 DFS 要写的 `depNode.flatDependents`、反向 DFS 要写的 `parentNode.flatDependencies`）**不立即写**，而是 push 进 `postTasks` 队列；两个 DFS 都跑完才批量 flush。

换来：traverse 期和 flush 期彻底分开——traverse 期只读图结构（dependencies/dependents 边）和字段初始状态、决定要写什么；flush 期才批量执行写入。反向 DFS 直接拿 `pkg.flatDependents.has(dep)` 兼做 visited 标记，省一个独立 seen Set；前向 DFS 累积的写入被挡在 traverse 期之外，不会和反向 DFS 的读交织在一起。更关键的是，跨多次 `resolveFlatDependencies` 调用时，前一次 flush 留下的 flatDependents 已经是终态、会影响下一次反向 DFS 的 visited 判定——把「本次内的写」隔在 traverse 之后，至少保证同一次调用内不自我干扰。

代价：阅读代码时必须分清「traverse 期」与「flush 期」两个时序——看到 `postTasks.push` 不能假定它已经执行；它要等到这一轮双 DFS 跑完才落盘。第一次读这段代码的人容易觉得「为什么要绕一圈、不能直接写」。

**本质矛盾**：这是「字段当 visited 标记（省一个 Set）vs 字段同时被多方读写（时序难管）」的对立——多带一个独立 seen Set 能彻底绕开，但代码选择复用 flatDependents 字段做 visited、用 postTasks 隔离写时机，换来少一个数据结构。读者一旦抓住「traverse 期只读、flush 期才写」这个时序分离，整个 postTasks 设计就豁然开朗——任何「同一组字段既是状态又是工作集」的场合都会撞到同样的延迟写入需求。

### workspace 是深度零点，也是 cluster 传播的终点

选择：workspace 节点 `depth=0`，且 cluster 标签**不**从 workspace 向下游传递（算法里 `if (!node.workspace)` 才把父节点的 flatClusters 合并进子节点）。

换来：「depth = 距最近 workspace 的步数」和「cluster 标签只挂在 workspace 自身」这两个语义都简洁——workspace 是图的根，根的标签是「项目对它的直接分类」（dev/prod/catalog），不应传染给传递依赖。

代价：跨 workspace 共享的依赖不会合并来自不同 workspace 的 cluster 标签——比如 monorepo 里两个 workspace 都依赖同一个 lodash，lodash 的 `flatClusters` 不会同时带「app1 的 dev」和「app2 的 prod」两个标签，只会保留离它最近的那一层 workspace 的标签。

**本质矛盾**：这是「标签语义精确（标签忠实表达最近来源）vs 标签信息完整（标签累积所有来源）」的对立——选了精确就丢累积，选了累积就模糊了「这个依赖为什么被引入」的回答。node-modules-inspector 选精确，是因为前端「为什么装了它」更需要清晰的「最近一层 workspace 怎么标记它」，而不是一份大杂烩。

## 5. 最小原理演示

下面这段 30 多行的 TS 脚本，把物化算法从零写一遍：构造一个含「跨层直连边」和「环」的 4 节点小图，跑 init → 反向边 → 双 DFS + postTasks flush，末尾打印每个节点的关键字段。

它**演示的是上面「双 DFS + postTasks 延迟回填」这条权衡怎么用代码落实**——重点是 traverse 期和 flush 期的时序分离，以及为什么必须分离。顺带也演了「workspace 作为深度零点」（`app.workspace` → `depth=0`）和「depth 更新放在 seen 判定之前」（让 DFS 给出 BFS 式最短距离）。

```ts
// 4 个节点的小图（含环 + 跨层直连）：
//   app(workspace) → B, C
//   B → D
//   C → D
//   D → B  （环）

type Node = {
  spec: string
  dependencies: Set<string>
  workspace?: boolean
  // 物化阶段渐增的字段：
  dependents: Set<string>
  flatDependencies: Set<string>
  flatDependents: Set<string>
  depth: number
  shallowestDependent?: Set<string>
}

function materialize(packages: Map<string, Node>) {
  // 阶段一：初始化空字段。workspace 设 depth=0，其他设 Infinity
  // Infinity 让「depNode.depth > level」首次触达时一定成立，省掉 if/else
  for (const pkg of packages.values()) {
    pkg.dependents = new Set()
    pkg.flatDependencies = new Set()
    pkg.flatDependents = new Set()
    pkg.depth = pkg.workspace ? 0 : Infinity
  }

  // 阶段二：扫前向边，填反向邻接 dependents
  for (const pkg of packages.values()) {
    for (const dep of pkg.dependencies) {
      packages.get(dep)?.dependents.add(pkg.spec)
    }
  }

  // 阶段三：每个节点各跑一次「前向 DFS + 反向 DFS」，最后统一 flush
  for (const pkg of packages.values()) {
    const postTasks: (() => void)[] = []

    // 前向 DFS：沿 dependencies 边收 flatDependencies
    // seen 只在本次闭包内有效，防环；不防跨 pkg 重复计算（跨 pkg 重算是必要的）
    const traverseDeps = (node: Node, seen: Set<Node>) => {
      for (const dep of node.dependencies) {
        const depNode = packages.get(dep)
        if (!depNode) continue
        const level = node.depth + 1
        // depth 取最小：发现更短路径就清空 shallowestDependent 重置
        // 这一步在 seen 判定之前，所以即便 depNode 已 seen、本次发现的新路径仍参与 depth 比较
        if (depNode.depth > level) {
          depNode.depth = level
          depNode.shallowestDependent?.clear()
        }
        if (depNode.depth === level) {
          depNode.shallowestDependent ||= new Set()
          depNode.shallowestDependent.add(node.spec)
        }
        if (seen.has(depNode)) continue
        pkg.flatDependencies.add(dep)
        seen.add(depNode)
        // 互反字段不立即写：traverse 期只读不写互反字段
        // 写入延迟到 flush，避免与反向 DFS 的 visited 判定（pkg.flatDependents.has）交织
        postTasks.push(() => {
          depNode.flatDependents.add(pkg.spec)
        })
        traverseDeps(depNode, seen)
      }
    }

    // 反向 DFS：沿 dependents 边收 flatDependents
    // 注意它直接拿 pkg.flatDependents 当 visited 标记——这正是 postTasks 必须延迟的根因
    const traverseDependents = (node: Node) => {
      for (const dep of node.dependents) {
        if (pkg.flatDependents.has(dep)) continue
        pkg.flatDependents.add(dep)
        const parentNode = packages.get(dep)!
        postTasks.push(() => {
          parentNode.flatDependencies.add(pkg.spec)
        })
        traverseDependents(parentNode)
      }
    }

    traverseDeps(pkg, new Set())
    traverseDependents(pkg)

    // flush：traverse 期累积的互反字段这时才批量写入
    for (const task of postTasks) task()
  }
}

// 构造小图
const packages = new Map<string, Node>()
const make = (spec: string, deps: string[], workspace = false): Node => ({
  spec,
  dependencies: new Set(deps),
  workspace,
  dependents: new Set(),
  flatDependencies: new Set(),
  flatDependents: new Set(),
  depth: Infinity,
})
packages.set('app', make('app', ['B', 'C'], true))
packages.set('B', make('B', ['D']))
packages.set('C', make('C', ['D']))
packages.set('D', make('D', ['B'])) // 环边

materialize(packages)

for (const pkg of packages.values()) {
  console.log(pkg.spec, {
    depth: pkg.depth,
    shallowestDependent: [...(pkg.shallowestDependent ?? [])],
    flatDependencies: [...pkg.flatDependencies],
    flatDependents: [...pkg.flatDependents],
  })
}
```

跑完后你会看到：`app` 的 `flatDependencies = {B, C, D}`、`depth = 0`；`D` 的 `depth = 2`、`shallowestDependent = {B, C}`（两条等长最短路径并存）；`B` 的 `flatDependents` 含 `app` 和 `D`（互反关系在 flush 后才落定）。注：环上的节点会出现在自己的 `flatDependencies` 里——这是有环图传递闭包的固有特性，前端处理时已知。

## 6. 执行轨迹

拿演示里那个 4 节点小图，慢动作走一遍 `resolveFlatDependencies(app)` 这一次调用内发生了什么。

**进入 `traverseDeps(app)`（前向 DFS）**：`app.depth = 0`，seen = {}。

- 边 `app → B`：`level = 0 + 1 = 1`。`B.depth` 从 `Infinity` 降到 `1`，`B.shallowestDependent = {app}`。seen 里没 B → `app.flatDependencies` 加入 `B`、seen 加入 `B`、postTasks 推「`B.flatDependents.add('app')`」。递归进 B。
  - 边 `B → D`：`level = 1 + 1 = 2`。`D.depth` 从 `Infinity` 降到 `2`，`D.shallowestDependent = {B}`。seen 里没 D → `app.flatDependencies` 加入 `D`、postTasks 推「`D.flatDependents.add('app')`」。递归进 D。
    - 边 `D → B`：`level = 2 + 1 = 3`。`B.depth = 1` 已经小于 `3`，不更新。seen 里有 B → continue（环切断，但 depth 比较已做完）。
- 边 `app → C`：`level = 1`。`C.depth` 从 `Infinity` 降到 `1`，`C.shallowestDependent = {app}`。seen 里没 C → `app.flatDependencies` 加入 `C`、postTasks 推「`C.flatDependents.add('app')`」。递归进 C。
  - 边 `C → D`：`level = 2`。`D.depth = 2`，等于 `level` → `D.shallowestDependent` **不清空**、追加 `C`，变成 `{B, C}`。seen 里有 D → continue（不再递归，但 depth 比较和 shallowestDependent 追加已经做完——这是 depth 更新放在 seen 判定之前的妙处）。

前向 DFS 结束时：`app.flatDependencies = {B, C, D}`；postTasks 队列里有三项（给 `B/C/D` 各加 `app` 到 flatDependents），但**还没执行**。

**进入 `traverseDependents(app)`（反向 DFS）**：`app` 是 workspace，没人依赖它，`app.dependents = {}` → 立即返回。

**flush postTasks**：依次执行 `B.flatDependents.add('app')`、`D.flatDependents.add('app')`、`C.flatDependents.add('app')`——三个互反字段这时才落定。

走完这一次 `resolveFlatDependencies(app)`，`app.flatDependencies` 是终态、`B/C/D` 的 `flatDependents` 也各加了 `app`。接着外层 for-of 会继续跑 `resolveFlatDependencies(B)`、`(C)`、`(D)`，每次都新建 postTasks、跑双 DFS、末尾 flush。整个图跑完后，每个节点的 `flatDependencies`/`flatDependents`/`depth`/`shallowestDependent` 都是终态，查询期直接读字段即可。

`D.shallowestDependent = {B, C}`（两条等长最短路径并存）这个结果，靠的是「depth 更新放在 seen 判定之前」+「`depth === level` 时不清空只追加」两条规则的配合——DFS 本来不是最短路算法，但通过这两条规则，它能给出 BFS 式的最短距离和「最浅依赖者集合」。

## 7. 教学简化说明

本章演示故意省略了几样东西：

- **`flatClusters` 的传播逻辑**：演示里完全没画 cluster 字段，因为它的业务含义（`dep:dev` / `dep:prod` / `catalog:default`）来自上游 agent，本章只关心传播机制——「非 workspace 节点会把自身 cluster 合并进下游」。原理上和 depth 传播是同一类「沿前向边下推」的逻辑。
- **`shallowestDependent` 类型的 `undefined` 初值**：源码里它在类型层表达「raw 阶段尚不存在」，物化完成后等价于「depth 最小时的依赖者集合」。演示里省掉了一层 undefined 判断的讨论。
- **跨 pkg 的闭包复用**：算法没有「如果 pkg 已经被别的 pkg 的闭包算过就复用」的优化——对每个节点都独立跑一次全图 DFS，复杂度 O(N·(V+E))。演示忠实反映了这一点（没有记忆化）。
- **`PackageNodeRaw` → `PackageNodeBase` → `PackageNode` 的类型分层**：本章只覆盖前两层。`PackageNode` 的 `resolved` 子对象（module type、install size、npm meta 等）是后面 resolve-package-pipeline 章的话题。

## 8. 小结

依赖图的查询频率远远高于改动频率，所以这一章把所有闭包、深度、反向依赖在装载期一次性算清、写成节点上的普通字段——查询期只剩读字段。两个方向的 DFS 各跑各的、互反字段延迟到 flush 才写，是为了让 traverse 期只读、flush 期才写，让反向 DFS 能直接拿 `flatDependents` 字段兼做 visited 标记——任何「同一组字段既是状态又是工作集」的场合都会撞到同样的延迟写入需求。

物化完的节点长出了一身闭包字段，但它还缺一份「人类可读」的展示信息——模块类型、体积、license、作者、npm 元信息。下一章「静态推断模块类型 cjs/esm/dual/faux/dts」就从这份裸字段开始，给每个节点补上第一块可读标签。
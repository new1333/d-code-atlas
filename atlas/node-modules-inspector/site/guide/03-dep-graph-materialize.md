---
title: 依赖图物化：flatDeps/dependents/depth 一次算清
---

# 依赖图物化：flatDeps/dependents/depth 一次算清

## 一句话场景：你点了一下「按层级排序」

想象一个 monorepo 装了两千多个包。你在前端面板上点了「按层级排序」按钮——这一下后台要做的事是：把每个包按它「距离最近 workspace 有几步」排出来。如果图只存了「A 直接依赖 B」这种边，这次排序就得在整张图上跑一遍 BFS。再点一下「为什么装了它」，又跑一遍。再筛一下「只看被引用 ≥ 10 次的包」，又跑一遍。前端卡死。

这个章要讲的就是怎么把这种「卡死」从根上避免掉。思路朴素到近乎粗暴：**装载期就把整张图所有可能的闭包查询结果，预先写成节点上的普通字段**。前端再查的时候，不再是「跑一次图遍历」，而是「读一个字段」。说人话就是：把昂贵的图遍历从查询期整体挪到装载期。

上一章我们拿到的是一份只有「前向边」的节点列表（pnpm/npm/bun 三种来源已经被抹平）。这份原始列表只能回答「A 直接依赖了谁」；本章要把它扩展成能回答几乎所有依赖相关问题的「物化图」。

## 底层基本件：raw 节点长什么样

装载期一开始，每个节点只知道两件事：

```ts
// raw 阶段的节点形状（agent 直接吐出来的）
interface PackageNodeRaw {
  spec: string                 // 比如 "lodash@^4.17.21"
  workspace?: boolean          // 是不是 monorepo 的 workspace 根
  clusters: Set<string>        // 上游 agent 写的分类标签
  dependencies: Set<string>    // 直接前向依赖的 spec 集合
}
```

注意这里**只有一个方向**：dependencies。也就是「我依赖谁」。另一面——「谁依赖我」——完全没有字段存。要回答「谁在用 lodash」这种问题，就只能扫整张图。

为什么 raw 阶段不直接把反向边也存了？因为反向边可以**从前向边推出来**：如果 A.dependencies 里有 B，那就等价于「B 有个 dependent 叫 A」。agent 在解析 lockfile 的时候，没必要为同一个事实存两遍。

所以物化的第一件事就是把这个「省下来的另一面」补回去。

## 阶段一·init：给每个节点贴上空的闭包字段

物化入口拿到 raw 结果后，第一件事是给每个节点 `Object.assign` 一批空字段上去：

```ts
for (const [spec, pkg] of input.packages) {
  const node = Object.assign(pkg, {
    dependents: new Set(),         // 直接反向邻接（阶段二补）
    flatDependencies: new Set(),   // 传递依赖闭包（阶段三补）
    flatDependents: new Set(),     // 传递被依赖闭包（阶段三补）
    flatClusters: new Set(),       // 从上游继承的分类标签（阶段三传播）
    depth: pkg.workspace ? 0 : Infinity,
  })
  for (const cluster of pkg.clusters)
    node.flatClusters.add(cluster)
  result.packages.set(spec, node)
}
```

这里有个细节值得停下来想一下：**为什么 `depth` 用 `Infinity` 不用 `-1` 或 `0`？**

答案藏在后面更新 depth 的那句判断里：`if (depNode.depth > level)`。如果初值是 `Infinity`，那么「第一次被任何路径触达」时，`Infinity > level` 一定为真，自然完成首次赋值——一个 if/else 都不用写。这是一种「选个让比较天然成立的初值」的小技巧。

还有个更隐蔽的细节：`Object.assign(pkg, {...})` 是**原地改**原对象，不是新建一个。也就是说，调用方传进来的 raw 对象本身被改写了。这看起来很危险（外部状态被污染），但下一节会讲清楚为什么这么做。

## 阶段二·反向边：扫一遍前向边就能补

补 dependents 很直白：扫一遍所有节点的前向边，反过来登记一次。

```ts
for (const pkg of result.packages.values()) {
  for (const dep of pkg.dependencies) {
    result.packages.get(dep)?.dependents.add(pkg.spec)
  }
}
```

跑完这一遍，每个节点的 dependents 集合就是「直接依赖我的那些 spec」。注意它**还不是传递闭包**——只是直接反向邻接。传递版本的「谁在间接用我」要等阶段三。

到这里，每个节点的字段形状从 raw 升级到了 base：多了 5 个空集合 + 1 个 depth。这就是类型上的 `PackageNodeRaw → PackageNodeBase`。

## 阶段三·双 DFS：核心机制

这是整章最需要看仔细的部分。

我们要对**每个**节点跑一次下面这个函数。它做三件事：前向 DFS 收所有传递依赖、反向 DFS 收所有传递被依赖、最后统一 flush。

```ts
function resolveFlatDependencies(pkg) {
  const postTasks: (() => void)[] = []

  function traverseDependencies(node, seen = new Set()) {
    for (const dep of node.dependencies) {
      const level = node.depth + 1
      const depNode = result.packages.get(dep)
      if (!depNode) continue

      // depth 取最小：发现更短路径就重置 shallowestDependent
      if (depNode.depth > level) {
        depNode.depth = level
        depNode.shallowestDependent?.clear()
      }
      if (depNode.depth === level) {
        depNode.shallowestDependent ||= new Set()
        depNode.shallowestDependent.add(node.spec)
      }

      if (seen.has(depNode)) continue   // 防环：已访问过的不再递归

      pkg.flatDependencies.add(dep)
      seen.add(depNode)
      // 关键：互反字段不立即写，先存进队列
      postTasks.push(() => {
        depNode.flatDependents.add(pkg.spec)
      })
      traverseDependencies(depNode, seen)
    }
  }

  function traverseDependents(node) {
    for (const dep of node.dependents) {
      if (pkg.flatDependents.has(dep)) continue   // 用 flatDependents 当 visited
      pkg.flatDependents.add(dep)
      const parentNode = result.packages.get(dep)!
      postTasks.push(() => {
        parentNode.flatDependencies.add(pkg.spec)
      })
      traverseDependents(parentNode)
    }
  }

  traverseDependencies(pkg)
  traverseDependents(pkg)

  for (const task of postTasks) task()   // flush：这里才真正写互反字段
}
```

### 为什么互反字段必须延迟到 flush 才写

这是整章的命门，慢慢看。

「互反字段」是说 `A.flatDependencies ∋ B` 和 `B.flatDependents ∋ A` 是同一件事的两面。前向 DFS 算 A 的 flatDependencies 时，**逻辑上**也可以顺手把 A 写进 B.flatDependents。

但这里有个陷阱：反向 DFS `traverseDependents` 把 `pkg.flatDependents.has(dep)` 当作「我访问过没」的判据（注意是 `pkg` 的，不是某个独立 visited 集合）。如果前向 DFS 在跑的过程中已经往 `pkg.flatDependents` 里写过东西，反向 DFS 就会以为「这条边我已经走过了」然后跳过——但其实它根本没走过，是前向 DFS 帮它「提前盖了章」。

结果就是反向闭包不完整。

解决办法就是把所有「写 pkg.flatDependents」的动作从「边发现时」推迟到「整段反向 DFS 跑完后」——这就是 `postTasks` 队列的用处。每一项是个 thunk（延迟执行的无参函数），存进去时不执行，等 `traverseDependencies` 和 `traverseDependents` 都跑完了，循环执行队列才真正落盘。

换句话说，前向 DFS 期间只「记账」，反向 DFS 跑完后再「结算」。这样反向 DFS 的 visited 判据就不会被前向 DFS 污染。

### depth 在 seen 检查**之前**更新

再看一眼上面 `traverseDependencies` 的顺序：

1. 先比较/更新 depth + shallowestDependent
2. 再判 `seen.has(depNode)`，若已 seen 就 `continue`（不再递归）

这个顺序不是随便写的。DFS 不是最短路算法——同一条路径可能从不同分支到达同一节点，且**步数不同**。如果把 depth 更新放在 seen 检查之后，那么节点第一次被 seen 之后，再发现新的更短路径就不会更新 depth 了——depth 就会偏高。

把 depth 更新放在 seen 检查之前，意味着**即便节点已经被 seen、不会再递归进去，本次发现的新路径仍会参与 depth 比较**。这是 DFS 给出 BFS 式最短距离的关键技巧。

`shallowestDependent` 同理——它是「距离最短的依赖者集合」，发现更短路径时整个清空重置、发现等长路径时累加。所以它是个 Set 而不是单个 spec。

## 端到端演示：一个 5 节点的有环小图

下面这段代码从零实现了一遍物化的核心三阶段。它故意造了一条环（B ↔ D）和一条跨层直连，用来演两件事：postTasks 的延迟回填、环里起点会出现在自己的闭包里。

```ts
// demo.ts —— 用 npx tsx demo.ts 或 bun run demo.ts 跑
type Node = {
  spec: string
  workspace?: boolean
  clusters: Set<string>
  dependencies: Set<string>
  // 物化阶段补的字段
  dependents: Set<string>
  flatDependencies: Set<string>
  flatDependents: Set<string>
  flatClusters: Set<string>
  depth: number
  shallowestDependent?: Set<string>
}

function buildGraph(): Map<string, Node> {
  const mk = (spec: string, deps: string[] = [], workspace = false): Node => ({
    spec, workspace, clusters: new Set(), dependencies: new Set(deps),
    dependents: new Set(), flatDependencies: new Set(),
    flatDependents: new Set(), flatClusters: new Set(),
    depth: workspace ? 0 : Infinity,
  })
  const app = mk('app', ['B', 'C'], true)
  const B = mk('B', ['D'])
  const C = mk('C', ['D'])
  const D = mk('D', ['B'])           // 环：D 依赖 B
  return new Map([['app', app], ['B', B], ['C', C], ['D', D]])
}

function materialize(input: Map<string, Node>) {
  // 阶段二·反向边
  for (const pkg of input.values())
    for (const dep of pkg.dependencies)
      input.get(dep)?.dependents.add(pkg.spec)

  // 阶段三·对每个节点跑双 DFS
  for (const pkg of input.values()) {
    const postTasks: (() => void)[] = []

    const forward = (node: Node, seen = new Set<Node>()) => {
      for (const dep of node.dependencies) {
        const level = node.depth + 1
        const depNode = input.get(dep)!
        if (depNode.depth > level) {
          depNode.depth = level
          depNode.shallowestDependent?.clear()
        }
        if (depNode.depth === level) {
          depNode.shallowestDependent ??= new Set()
          depNode.shallowestDependent.add(node.spec)
        }
        if (seen.has(depNode)) continue
        pkg.flatDependencies.add(dep)
        seen.add(depNode)
        postTasks.push(() => depNode.flatDependents.add(pkg.spec))
        forward(depNode, seen)
      }
    }
    const reverse = (node: Node) => {
      for (const dep of node.dependents) {
        if (pkg.flatDependents.has(dep)) continue
        pkg.flatDependents.add(dep)
        const parentNode = input.get(dep)!
        postTasks.push(() => parentNode.flatDependencies.add(pkg.spec))
        reverse(parentNode)
      }
    }

    forward(pkg)
    reverse(pkg)
    for (const t of postTasks) t()    // flush
  }
}

const g = buildGraph()
materialize(g)
for (const n of g.values()) {
  console.log(n.spec, {
    depth: n.depth,
    flatDeps: [...n.flatDependencies],
    flatDependents: [...n.flatDependents],
    shallowest: n.shallowestDependent ? [...n.shallowestDependent] : undefined,
  })
}
```

跑一下，输出大致是：

```
app  { depth: 0, flatDeps: [B, D, C],     flatDependents: [],         shallowest: undefined }
B    { depth: 1, flatDeps: [D, B],         flatDependents: [app, D, B, C], shallow: [app] }
C    { depth: 1, flatDeps: [D, B],         flatDependents: [app],      shallow: [app] }
D    { depth: 2, flatDeps: [B, D],         flatDependents: [B, C, D],  shallow: [B, C] }
```

注意几个细节，它们都是源码真实的行为：

- **`B.flatDeps` 里包含 `B` 自己**。因为 B → D → B 是个环，前向 DFS 跑到 D 时会沿 `D.dependencies={B}` 回到 B，把 `B` 加进 `pkg.flatDependencies`。换句话说，源码不做「起点自过滤」——起点在环里就会出现在自己的闭包里。
- **`B.flatDependents` 也包含 `B` 自己**。同理，反向 DFS 跑到 D 时会沿 `D.dependents={B,C}` 回到 B。
- **`app.flatDependents` 是空集**。app 是 workspace 根，没有任何节点依赖它。
- **`D.shallowestDependent = [B, C]`**。从 app 出发到 D 有两条等长路径（app→B→D、app→C→D），都给 depth=2，所以 shallowestDependent 是个集合，同时收 B 和 C。

### 执行轨迹：跑一次 `resolveFlatDependencies(B)`

为了看清楚 postTasks 怎么工作，单独跟踪一下跑 `resolveFlatDependencies(B)` 时的关键步骤（假设 phase 二已补完 dependents：`B.dependents = {app, D}`、`D.dependents = {B, C}`）：

```
forward(pkg=B), seen = {}
  ├─ dep=D, level=2, D.depth: ∞ → 2, D.shallowest={B}
  │   pkg.flatDeps += D,  seen={D}
  │   postTasks += [ () => D.flatDependents += B ]
  │   forward(D, seen={D})
  │     ├─ dep=B, level=3, B.depth(1) > 3? 否，跳过更新
  │     │   seen.has(B)? 否
  │     │   pkg.flatDeps += B  ← B 被加进自己的 flatDeps
  │     │   seen={D, B}
  │     │   postTasks += [ () => B.flatDependents += B ]
  │     │   forward(B, seen={D,B})
  │     │     └─ dep=D, seen.has(D)? 是 → continue（防环）
reverse(pkg=B), pkg.flatDependents = {}
  ├─ dep=app, app 不在 B.flatDependents
  │   B.flatDependents += app
  │   postTasks += [ () => app.flatDependencies += B ]
  │   reverse(app) → app.dependents={} 空
  ├─ dep=D, D 不在 B.flatDependents
  │   B.flatDependents += D, B.flatDependents={app, D}
  │   postTasks += [ () => D.flatDependencies += B ]
  │   reverse(D), D.dependents={B, C}
  │     ├─ dep=B, B 不在 B.flatDependents
  │     │   B.flatDependents += B  ← B 出现在自己的 flatDependents
  │     │   postTasks += [ () => B.flatDependencies += B ]
  │     │   reverse(B), B.dependents={app, D}
  │     │     ├─ app 在 B.flatDependents? 是 → continue
  │     │     └─ D  在 B.flatDependents? 是 → continue
  │     └─ dep=C, C 不在 B.flatDependents
  │         B.flatDependents += C, ={app, D, B, C}
  │         postTasks += [ () => C.flatDependencies += B ]
  │         reverse(C), C.dependents={app} → app 已在集合 → continue
flush postTasks（顺序执行）
  → D.flatDependents += B
  → B.flatDependents += B
  → app.flatDependencies += B
  → D.flatDependencies += B
  → B.flatDependencies += B
  → C.flatDependencies += B
```

跑完之后 `B.flatDeps = {D, B}`、`B.flatDependents = {app, D, B, C}`，跟前面输出表对得上。

**关键看 reverse 阶段开头**：`pkg.flatDependents` 起始是空集（**没被 forward 污染**）。如果 forward 期间就直接写 `depNode.flatDependents.add(pkg.spec)`，那么 `B.flatDependents` 在进入 reverse 时就会**已经有 B 自己**（来自 forward 里的 `() => B.flatDependents += B`），反向 DFS 一进来就误判「B 已访问」直接跳过——结果 B 不会被发现是自己的 dependent，反向闭包就漏了。这就是 postTasks 必须延迟的根因。

## 关键权衡

这一章机制集中，权衡就集中在「物化换查询」这条主轴上，外加两个支撑性选择。

### 权衡一（核心）：预算闭包换查询期 O(1)

**做了什么**：装载期对每个节点都跑一次双 DFS，把 flatDependencies / flatDependents / depth / shallowestDependent 全部预填好。
**换来什么**：前端 15+ 处消费方（按层级排序、按被引用次数筛、点开「为什么装了它」、按 cluster 分桶……）全部变成「读字段」，不再跑图遍历。一次点击从「跑一次全图 BFS」变成一次字典查找。
**代价**：图只要改一条边就要重算所有闭包——没有增量更新。对 npm/pnpm 这种「装完几小时不变」的场景没问题；但如果你想做的是「实时编辑 package.json 看图变化」，这套就咬不住——每次改动都得重新跑一次全图物化。
**复杂度提醒**：算法字面上是 `O(N · (V+E))`，对每个节点跑一次全图 DFS。几万节点的真实 monorepo 是 `O(N²)` 级。代码里没有「如果某 pkg 的闭包已被别的 pkg 顺路算过就复用」的记忆化——这是有意省略（用空间换时间的另一种代价是逻辑复杂度上升，作者选择了简单）。

### 权衡二：mutate-in-place 换零拷贝

**做了什么**：阶段一用 `Object.assign(pkg, {...})` 直接在原节点对象上挂新字段，不新建对象。
**换来什么**：零拷贝、不需要重建 Map、外部持有的引用继续有效。
**代价**：同一个对象在管线不同阶段字段集不同（raw → base → resolved）。调用方必须清楚当前在哪一阶段：在 raw 阶段读 `dependents` 是 `undefined`，在 base 阶段读 `resolved` 也是 `undefined`。这是个隐式契约——一旦调用顺序搞错（比如在物化完成前读了 `flatDependencies`），拿到的就是空集而不是预期的闭包。类型分层（`PackageNodeRaw` → `PackageNodeBase` → `PackageNode`）能在编译期挡住一部分，但跨函数边界传递时仍需约定。

### 权衡三：双 DFS + 延迟回填换 visited 互不污染

**做了什么**：前向 DFS 与反向 DFS 各自独立跑；前向 DFS 发现的「反向闭包成员」不立即写入，而是塞进 `postTasks` 队列，等反向 DFS 也跑完再统一 flush。
**换来什么**：两个方向的 visited 集合互不污染。关键在反向 DFS 把 `pkg.flatDependents.has(dep)` 当 visited 判据——如果前向 DFS 提前往里写了，反向 DFS 就会被骗。
**代价**：阅读者必须分清「traverse 期」与「flush 期」两个时序。光看代码会觉得「为什么要先 push 一个 thunk 再批量执行，不直接写？」——没有 postTasks 这层延迟，逻辑反而更直白。但这层延迟是正确性的硬要求，不是性能优化。读这章代码时如果跳过 `postTasks` 这一层，会完全看不懂为什么反向 DFS 的 visited 判据长那样。

### 权衡四：workspace 作为深度零点 + 集群标签的 sink

**做了什么**：workspace 节点 `depth=0`（其他 `Infinity`）；cluster 标签传播时只在「父节点不是 workspace」时才下推到子节点。
**换来什么**：`depth` 的语义干净——「距离最近 workspace 的步数」；workspace 自身的 clusters（dev/prod/catalog 之类的根分类）只挂在它自己身上，不向传递依赖传染。
**代价**：跨 workspace 共享的依赖不会合并来自不同 workspace 的 cluster 标签。比如 monorepo 里两个 workspace 都依赖了 lodash，且分别打了 `dep:dev` 和 `dep:prod`——lodash 的 `flatClusters` 只会保留最后一条传播路径写入的标签，不会 union。这是「workspace 是 sink 不是 source」的直接后果。

## 这一章的边界

本章只覆盖了 raw → base 这一层。每个节点最后还有一个 `resolved` 子对象（包名、版本、license、author、模块类型、安装体积、repository……），那是下一章 `resolve-package-pipeline` 的内容——它做的事是「读 package.json → 并发跑若干 normalize → mutate 进 `pkg.resolved`」，跟本章的双 DFS 是两套独立机制。

另外，cluster 标签的具体业务值（`dep:dev` / `dep:prod` / `catalog:default`）来自上游 agent 的 catalog 解析，本章只讲传播机制、不讲业务含义。

下一章会把 base 节点继续扩展成可展示的 `PackageNode`——你会看到同一个对象上又长出 `resolved` 字段，依旧 mutate-in-place。本章学到的「同一对象在不同阶段字段集不同」的心智模型会继续用上。

# 依赖图物化：flatDeps/dependents/depth 一次算清 · 源码精读

## 给 Writer 的教学钩子（必填，8 子项缺一不可）

- **用户痛点 / 场景**：依赖分析工具里几类问题高频出现——「这个包被哪些包传递使用」「它处在依赖链第几层」「为什么装了它」。如果只存「直接依赖」边，每次查询都得在图上跑一次 BFS/DFS，前端每筛一次/排一次/点一次都重算，UI 直接卡死。
- **一句话核心思想**：把整张图所有闭包一次性算清、写成节点上的普通字段，查询期只剩「读字段」。
- **设计动机（为什么需要它）**：依赖图存在「查询频率 ≫ 改动频率」的根本不对称——npm/pnpm 装出来的图几小时不变，但前端要按体积/层级/被引用次数/为什么引入等几十种维度反复查。本机制把昂贵的图遍历从查询期整体挪到装载期，换「查询期 O(1)」。
- **关键权衡（核心原料）**：
  1. **预算闭包 vs. 查询期再算**：选择「装载期跑全图双 DFS 把 flatDeps/flatDependents/depth 全预填」→ 换来查询期 O(1) 读字段、前端筛选/排序/why 瞬时响应 → 代价是图任何边改动就要重算所有闭包（无增量更新）。
  2. **mutate-in-place vs. 重建对象**：选择「直接在原节点对象上 Object.assign 新字段」→ 换来零拷贝、无需重建 Map、引用稳定 → 代价是同一对象在管线不同阶段字段集不同（raw → base → resolved），调用方必须知道当前在哪一阶段、不能假设字段已就绪。
  3. **双 DFS + 延迟回填（postTasks）vs. 单遍互写**：选择「前向 DFS 与反向 DFS 各自跑、互反字段延迟到 flush 期才写」→ 换来两个方向的 visited 集合互不污染（关键：反向 DFS 把 flatDependents 当 visited 标记，若前向 DFS 提前写入就会骗过反向 DFS 的去重）→ 代价是阅读者必须分清「traverse 期」与「flush 期」两个时序，否则会觉得逻辑绕。
  4. **workspace 作为深度零点 + 集群传播终点**：选择「workspace 节点 depth=0、且不向其依赖传递 cluster 标签」→ 换来「depth = 距最近 workspace 的步数」与「catalog/dev/prod 这类标签只挂在 workspace 自身」的简洁语义 → 代价是跨 workspace 共享的依赖不会合并来自不同 workspace 的 cluster 标签。
- **最小心智模型（3～7 步）**：
  1. 输入：一张只有「前向边」的节点 Map（每个节点只有 dependencies 这一边集合）。
  2. 阶段一·初始化：给每个节点挂上空的 dependents/flatDeps/flatDependents/flatClusters；workspace 的 depth=0、其他=∞。
  3. 阶段二·反向边：扫一遍所有前向边，把对应的 dependents（直接反邻接）填上。
  4. 阶段三·双 DFS：对每个节点各跑一次「前向 DFS（收所有传递依赖）+ 反向 DFS（收所有传递被依赖）」。
  5. DFS 内：用 seen 集合防环；每发现一条更短路径就更新该节点 depth、并清空+重置 shallowestDependent。
  6. 互反字段（「你在我的 flatDeps 里」↔「我在你的 flatDependents 里」）**不立即写**，先 push 进 postTasks 队列。
  7. 该节点的两个方向 DFS 都跑完后，flush postTasks——这时才批量写反方向字段，避免污染反向 DFS 的 visited 判定。
- **最小原理演示（替代旧"复刻范围"）**：
  - **应演示**：一个 30～40 行的纯 TS 脚本——构造 4～5 个节点的有环小图（含一条「跨层直连」边和一条环边），把 `populateRawResult` 的核心（init → 反向边 → 双 DFS + postTasks flush）从零写一遍；末尾打印每个节点的 flatDeps/flatDependents/depth/shallowestDependent。**这段演示演的是上面权衡 3（postTasks 延迟回填）+ 权衡 4（workspace 作为深度零点）——把"为什么不能一边 DFS 一边写互反字段"演透**。
  - **应故意省略**：clusters/catalogs 的业务语义、agent 分发、package.json 解析、resolved 子对象（那是下一章）。
  - **演示载体建议**：纯 TS 脚本（`bun run demo.ts` 或 `npx tsx demo.ts`）。理由：本仓库主语言是 TS、本机制是纯图算法、无任何宿主依赖（不是 Vue/VSCode/WebContainer 那种需要宿主的机制）；用最小脚本最能演透算法本身的两个时序（traverse 期 vs flush 期）。
- **正文不宜展开的细节**：cluster 标签的具体业务值（`dep:dev`/`dep:prod`/`catalog:default`）的来源——它们由上游 agent 写入，本章只讲传播机制不讲业务含义；`ListPackageDependenciesOptions` 的 5 个过滤回调（属于上一章 package-manager-strategy 的清单过滤）；`PackageNode.resolved` 子对象的 9 个字段（属于 resolve-package-pipeline 章）。
- **推荐的一个执行轨迹例子**：
  - 输入图（spec）：workspace `app` → deps `{ B, C }`；`B` → deps `{ D }`；`C` → deps `{ D }`；`D` → deps `{ B }`（环）。
  - 阶段一后：`app.depth=0`；`B/C/D.depth=∞`；四节点的 flatDeps/flatDependents 均为空集。
  - 阶段二后：`B.dependents={app,D}`、`C.dependents={app}`、`D.dependents={B,C}`。
  - 跑 `resolveFlatDependencies(app)`：前向 DFS 把 `{B,C,D}` 都加进 `app.flatDependencies`；途中 D 的 depth 被两条路径比较——`app→B→D` 给 depth=2，`app→C→D` 也给 depth=2，于是 shallowestDependent 同时收 `B` 和 `C`。
  - postTasks flush 后：`B.flatDependents` 含 `app` 和 `D`（互反来自前向）。
  - 接着跑 `resolveFlatDependencies(B)` 时：前向 DFS 从 B 出发，但 `app.flatDependents` 此时已是终态——因为 postTasks 在每次 resolveFlatDependencies 末尾就 flush 了，不会跨 pkg 残留。

> 以上钩子供 Writer 写「动机→核心思想→心智模型→关键权衡→原理演示」；下面事实部分供核对，不要被 Writer 当目录照抄。

## 概念要点

- 本章核心入口是 `listPackageDependenciesRaw(manager, options)`：动态 import 对应包管理器的 agent，拿到「只有前向 dependencies 边」的 raw 结果，再交给 `populateRawResult` 物化成带闭包的 base 结果。源码位置: packages/node-modules-tools/src/agent-entry/list.ts:9-24
- 物化分**三个阶段**且全部同步完成（无 await）：① 给每节点初始化空闭包字段 + workspace 设 depth=0；② 反扫前向边填 `dependents`；③ 对每节点跑一次双 DFS。源码位置: packages/node-modules-tools/src/agent-entry/list.ts:27-118
- **类型分层是物化阶段的镜像**：`PackageNodeRaw`（agent 输出，只有前向边）→ `PackageNodeBase`（物化后，多了 6 个闭包字段）→ `PackageNode`（后续 resolve 后，多 `resolved` 子对象）。本章只覆盖前两层。源码位置: packages/node-modules-tools/src/types/node.ts:11-73
- `PackageNodeBase` 在 `PackageNodeRaw` 基础上多了：`dependents`（直接反向邻接）、`depth`（距最近 workspace 的最短步数）、`shallowestDependent`（距离最短的直接/传递依赖者集合）、`flatDependencies`/`flatDependents`（传递闭包）、`flatClusters`（继承自非 workspace 祖先的集群标签）。源码位置: packages/node-modules-tools/src/types/node.ts:38-51
- `shallowestDependent` 用 `Set<string> | undefined` 表达「可能尚未计算」——但实际算法里它**只要被前向 DFS 触达就会被初始化**，因此该字段在物化完成后等价于「`depth` 最小时的依赖者集合」；用 undefined 仅是为了在类型层表达「raw 阶段尚不存在」。源码位置: packages/node-modules-tools/src/types/node.ts:44
- `depth` 初值用 `Infinity` 而非 `-1` 或 `0`，是为了让「`depNode.depth > level`」在首次触达时一定成立、自然完成首次赋值，省掉 if/else 分支。源码位置: packages/node-modules-tools/src/agent-entry/list.ts:40
- 物化期 `Object.assign(pkg, {...})` **直接改原对象**——返回的 `result.packages` 里的 value 与 `input.packages` 里的 value 是同一引用，调用方传入的 raw 对象也被改写。源码位置: packages/node-modules-tools/src/agent-entry/list.ts:35-41
- `traverseDependencies` 内部的 `seen` 集合**只在本次 `pkg` 的闭包计算内有效**——每调用一次 `resolveFlatDependencies(pkg)` 都新建一个 seen；它防的是「同一 pkg 的闭包内成环」，不防「跨 pkg 重复计算」（跨 pkg 重算是允许的、且是必要的，因为每个 pkg 都要算自己的闭包）。源码位置: packages/node-modules-tools/src/agent-entry/list.ts:60-63
- **depth 更新发生在 seen 检查之前**（先更新 depth 再判 seen）：即便 depNode 已经被 seen、不会再递归进去，本次发现的新路径仍会参与 depth 比较和 shallowestDependent 更新——这是 DFS（非最短路算法）仍能给出 BFS 式最短距离的关键技巧。源码位置: packages/node-modules-tools/src/agent-entry/list.ts:74-92
- **cluster 传播的"非 workspace 才下推"规则**：`if (!node.workspace)` 才把父节点的 flatClusters 合并进子节点。推断：workspaces 是图根（root 节点的 dev/prod/catalog 标签是「根节点对它的直接分类」），不应传染到传递依赖；只有非 workspace 的中间节点（其自身 clusters 来自上游 agent 的 catalog 解析）才向下游传播。**此语义为推断**——代码无对应注释。源码位置: packages/node-modules-tools/src/agent-entry/list.ts:69-73
- 上游调用方：`list.ts:11`（`node-modules-tools/src/list.ts`）以 `as ListPackageDependenciesResult` 强转 base 结果为含 `resolved` 的最终结果——这种"先用 base 物化、再让 resolve 阶段补 resolved 字段"的渐进扩展是 Atlas 后续 resolve-package-pipeline 章的入口。源码位置: packages/node-modules-tools/src/list.ts:11
- 下游消费者（前端 `state/payload.ts`、`state/filters.ts`、`pages/graph.vue`、`components/report/UsedBy.vue` 等 15 处）**全部直接读 flatDeps/flatDependents/shallowestDependent 字段、不再跑图遍历**——这是「物化换查询 O(1)」权衡的证据。源码位置: （消费者列表见 Grep 结果，典型如 packages/node-modules-inspector/src/app/components/report/UsedBy.vue）

## 关键调用链

```
listPackageDependenciesRaw(manager, options)               // agent-entry/list.ts:9
  → import('../agents/{pnpm|npm|bun}').listPackageDependencies(options)
                                                            // agent-entry/list.ts:14-21
  → populateRawResult(rawResult)                            // agent-entry/list.ts:23, 27
      ├─ phase 1: init closure fields + workspace depth=0   // :34-46
      ├─ phase 2: backfill dependents (reverse adjacency)   // :49-55
      └─ phase 3: resolveFlatDependencies(pkg) per pkg      // :57-116
            ├─ traverseDependencies(pkg)                    // :60-93 (前向 DFS)
            │     - 沿 dependencies 边递归
            │     - 用 seen 防环
            │     - 比较/更新 depth + shallowestDependent
            │     - 把 pkg.spec 加进 pkg.flatDependencies
            │     - postTasks.push(写 depNode.flatDependents)
            ├─ traverseDependents(pkg)                      // :95-106 (反向 DFS)
            │     - 沿 dependents 边递归（依赖 phase 2 的结果）
            │     - 用 pkg.flatDependents 当 visited 标记
            │     - postTasks.push(写 parentNode.flatDependencies)
            └─ flush postTasks                              // :111-113
```

互反关系：`A.flatDependencies ∋ B` ⇔（postTasks flush 后）`B.flatDependents ∋ A`。延迟到 flush 是为了避免前向 DFS 写入的 `flatDependents` 被反向 DFS 当 visited 误读。

## 源码摘录（带行号，全文累计 ≤ 30 行）

阶段一·init（13 行，演 workspace-as-depth-0 + 字段形状 + Object.assign mutate-in-place）：

```ts
// list.ts:34-46
for (const [spec, pkg] of input.packages) {
  const node = Object.assign(pkg, {
    dependents: new Set(),
    flatDependencies: new Set(),
    flatDependents: new Set(),
    flatClusters: new Set(),
    depth: pkg.workspace ? 0 : Infinity,
  }) as PackageNodeBase
  for (const cluster of pkg.clusters) {
    node.flatClusters.add(cluster)
  }
  result.packages.set(spec, node)
}
```

阶段三·前向 DFS 核心（17 行，演 depth 取最小 + seen 防环 + postTasks 延迟回填）：

```ts
// list.ts:74-90
if (depNode.depth > level) {
  depNode.depth = level
  depNode.shallowestDependent?.clear()
}
if (depNode.depth === level) {
  depNode.shallowestDependent ||= new Set()
  depNode.shallowestDependent.add(node.spec)
}

if (seen.has(depNode))
  continue

pkg.flatDependencies.add(dep)
seen.add(depNode)
postTasks.push(() => {
  depNode.flatDependents.add(pkg.spec)
})
traverseDependencies(depNode, seen)
```

## 易混淆 / 边界 / 推断

- **事实**：`traverseDependents` 用 `pkg.flatDependents.has(dep)` 判 visited（list.ts:98），而 `traverseDependencies` 会通过 postTasks 写 `depNode.flatDependents`——如果 postTasks 不延迟到 flush，前向 DFS 写入的 flatDependents 就会被反向 DFS 误判为「已访问」从而跳过该分支，导致 `flatDependencies` 反向闭包不完整。这正是 postTasks 必须延迟的根因。
- **事实**：`depth` 的「取最小」语义靠 `depNode.depth > level` 时清空 shallowestDependent 重置、`=== level` 时累加（list.ts:74-81）——这处理了「多条等长最短路径同时存在」的场景，shallowestDependent 是个**集合**而非单值。
- **推断**：算法复杂度约为 O(N · (V+E))——对每个节点跑一次全图 DFS。对几万节点的真实 monorepo 这是 O(N²) 级，可观察到代码未做记忆化（没有"如果 pkg 已被别的 pkg 的闭包算过就复用"的优化）。**此为推断**，需对照 benchmark 验证；但从代码字面看确实没有缓存。
- **推断**：`if (!node.workspace)` 的 cluster 传播分支意味着 workspaces 是「集群标签的 sink」而非 source——workspace 自身的 clusters 只挂在它自己身上、不向依赖传播。**此为推断**，代码无注释，需对照 pnpm agent 的 clusters 写入逻辑确认。
- **未理解**：`traverseDependents` 内部 `parentNode = result.packages.get(dep)!` 用非空断言（list.ts:100）——若 dep 的 spec 不在 map 里（数据异常）会抛 TypeError；不清楚上游 agent 是否保证 dependents 引用的 spec 全部存在。建议对照 pnpm/npm/bun 三个 agent 的输出验证。
- **边界**：函数依赖 raw 阶段 `pkg.dependencies` 与 `pkg.spec` 字段已就绪（PackageNodeRaw 接口要求）；若 agent 输出的 spec 与 dependencies 内的 spec 格式不一致（如 `name@^1.0.0` vs `name@1.0.0`），dependents 反查会失败——本章代码不含归一化，归一化责任在 agent 内部。
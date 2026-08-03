# 响应式 payload 级联：main→excluded→available→filtered · 源码精读

## 给 Writer 的教学钩子（必填，8 子项缺一不可）

- **用户痛点 / 场景**：用户在依赖面板里勾掉「排除 dev 依赖」「排除 .dts」之后，期望整页只剩「真正还想看」的包。但依赖图是 DAG——直接被规则命中的包排掉以后，它们的间接子节点常常只剩"已不存在的父"作为唯一入边，于是变成幽灵节点还挂在列表上，让用户误以为这包还在生产依赖里。痛点是：**过滤本应是图语义，但用户脑子里只想"勾一下就看不见"**。

- **一句话核心思想**：把过滤拆成一条瀑布（main → excluded → available → filtered），每一层只做一件事，让响应式系统替你算缓存；而"过滤传播"靠**不动点迭代**——只要一个包的全部父都被排除，它也得走。

- **设计动机（为什么需要它）**：依赖图本质是 DAG。用户对"是否还想看这个包"有两个独立判断维度：(a) 包自身被排除规则命中（如 dev / .dts / private）；(b) 包的全部父都已被排除（间接孤儿）。只做 (a) 不做 (b)，前端会残留一堆"看似还在依赖里"但其实无人引用的幽灵节点。把整体可见集合切成几个清晰的中间产物（被排除的、可用的、最终过滤的）还有一个动机：**每层中间产物都能被不同 UI/report 复用**（按维护者聚合、按体积求和、A/B 对比各取所需），而不是把所有规则揉进一个巨型派生值。

- **关键权衡（核心，3 条）**：
  1. **不动点传播孤儿**：选择「重复扫描直到没有新包被排除」→ 换来「available 集合保持图语义（一个包当且仅当至少一条入边来自未被排除的父时才可见）」→ 代价「最坏情况每轮排除一批、需多轮才收敛，理论 O(N²)；为压住代价必须把整层结果整体缓存、且只在过滤器变化时才重算，否则前端每次重渲都跑一遍图」。
  2. **多层 computed + 手动清缓存**：选择「跨包的列表查询（直接依赖、传递依赖、cluster 闭包）在响应式容器外另开一份 Map 缓存，由一个顶层 watch 在节点集合变化时主动 clear」→ 换来「查询期 O(1) 读、视图层只重算实际依赖的字段，graph/chart 拖动时不会触发全图重算」→ 代价「缓存一致性靠开发者自觉：每加一类派生数据，必须记得在同一条 watch 里加一行 clear，否则会脏读」。
  3. **过滤状态外置 + 谓词注入**：选择「过滤规则与状态由独立模块维护，本层只调用其暴露的谓词函数（不自己判断 dev / dts / workspace），让响应式系统通过调用栈自动追踪依赖」→ 换来「过滤逻辑集中、新规则只需在过滤模块里加一个分支，瀑布层零改动」→ 代价「跨模块耦合：本层依赖图被过滤模块反过来读取（cluster 闭包来自节点对象），必须分层清晰否则两模块互引成环」。

- **最小心智模型（5 步）**：
  1. 数据加载完成，原始节点列表进入 main 层（全量）。
  2. excluded 层做两件事：先按谓词直接命中排除；再做不动点——任何"全部父都在 excluded"的节点也加入 excluded，重复到收敛。
  3. available 层 = main − excluded（差集，按 spec 哈希 O(1) 判定）。
  4. filtered 层在 available 之上叠加选择谓词（focus / why / depth / 搜索串等）。
  5. 任一层输入变化，下游自动失效；跨包的列表缓存由顶层 watch 集体清空，下次访问时按需重建。

- **最小原理演示**：
  - 应演示：一个约 40 行的「raw → excluded(不动点) → available → filtered」四层瀑布，重点把 excluded 层的 `while (changed)` 循环写出来；用纯 JS 数组与 getter 函数即可，**不依赖 Vue**，让读者看清"为什么需要不动点"。
  - 应故意省略：响应式包装、A/B 对比、reference 层、npm 元信息旁路、cluster 闭包缓存——这些是工程化包装，与核心思想无关。
  - 演示载体建议：**TS/JS 单文件可 `node` 直接跑**。打印每轮 excluded 集合大小，让读者肉眼看到"第一轮命中直接孤儿、第二轮传递排除、第三轮收敛"的过程。本章属于"算法即机制"——能在终端跑出收敛轨迹比任何图示都直观。

- **正文不宜展开的细节**：A/B 对比如何用传递闭包扩展选择集；reference 层（用于对比某次旧 dump 的同结构数据）；按发布时间取最新元信息；工作区总体积求和；cluster 闭包的合并细节——这些都是消费 payload 的旁支，主线讲完瀑布即可。

- **推荐的一个执行轨迹例子**：构造一棵 A(prod) → B(dev) → C(非dev) → D(非dev) 的链。用户勾选「排除 dev 依赖」。
  - 第一轮：B 直接被谓词命中。
  - 第二轮：C 的父只有 B、B 已排除 → C 也排除；D 的父只有 C、C 刚被排除 → D 也排除。
  - 第三轮：无新增，收敛。
  - 最终 available 只剩 A。**整条 dev 链路被全部剪除**，没有幽灵节点残留。
  - 反向对照组：A(prod) → B(非dev) → C(dev)。第一轮 C 直接命中；但 B 的父 A 仍在，B 留下；available = {A, B}。这演示了"非 dev 包即使依赖了 dev 包也不会被牵连"——排除只看自身匹配 + 全父状态，不传递"被排除性"。

> 以上钩子供 Writer 写「动机 → 核心思想 → 心智模型 → 关键权衡 → 原理演示」；下面事实部分供核对，不要被 Writer 当目录照抄。

## 概念要点

- **工厂模式构造每一层**：单一工厂函数接收一个 getter，返回一个响应式容器，内部派生 map / versions / clusters / 各种跨包列表访问器；8 个具名 payload 都由这个工厂产出，共享同一套基础设施。源码位置: packages/node-modules-inspector/src/app/state/payload.ts:10-120
- **8 个 payload 实例**：main（全量）、excluded（被排除集）、workspace（用户自己的包）、available（main − excluded）、filtered（available 上叠加选择谓词）、compareA/compareB（A/B 对比的传递闭包）、reference（旧 dump 用于对比）。源码位置: packages/node-modules-inspector/src/app/state/payload.ts:194-205
- **跨包列表缓存**：用 4 个 Map（dependencies/dependents/flatDependencies/flatDependents）按 spec 缓存查询结果；外加一个 flatClusters 缓存。源码位置: packages/node-modules-inspector/src/app/state/payload.ts:46-53
- **顶层 watch 清缓存**：packages 引用变化时一次性 clear 全部缓存。源码位置: packages/node-modules-inspector/src/app/state/payload.ts:55-61
- **flatClusters 含义**：把"依赖该包的所有上层父的 cluster 标签"取并集——所以 isInDepCluster 实际判的是"有没有任何路径把这条边归类为 prod/dev/optional"。源码位置: packages/node-modules-inspector/src/app/state/payload.ts:79-101
- **不动点迭代的核心循环**：`let changed = true; while (changed) { changed = false; ... 改动后 changed = true }`，每轮扫一遍 main 全量，若某节点的所有 dependents 都在 excluded 里则也排除。源码位置: packages/node-modules-inspector/src/app/state/payload.ts:128-147
- **workspace 二次扫描**：不动点收敛后，若用户开了排除 workspace 选项，再把所有 workspace 包补进 excluded——这是独立于不动点的旁路规则。源码位置: packages/node-modules-inspector/src/app/state/payload.ts:149-154
- **available 用差集**：`_main.packages.filter(pkg => !_excluded.map.has(pkg.spec))`，按 spec 在 excluded 的 map 里 O(1) 判定。源码位置: packages/node-modules-inspector/src/app/state/payload.ts:164-167
- **filtered 用选择谓词**：在 available 之上应用 filterSelectPredicate（来自 filters 模块）。源码位置: packages/node-modules-inspector/src/app/state/payload.ts:169-172
- **compareA/B 用传递依赖闭包**：把用户选的入口节点及其全部 flatDependencies 合并成 Set。源码位置: packages/node-modules-inspector/src/app/state/payload.ts:174-192
- **highlight 单一职责**：仅查 compareA/compareB 的归属，给节点标 'a'/'b'/'both'/'none'。源码位置: packages/node-modules-inspector/src/app/state/highlight.ts:6-16
- **get/getList 按当前层语义查找**：`_available.get(spec)` 只在节点仍在 available 集合时返回，否则 undefined——即"查找"自带"过滤"语义。源码位置: packages/node-modules-inspector/src/app/state/payload.ts:24-44
- **rawPayload 是 shallowRef**：上游数据容器用 shallowRef（不做深层响应式），每层数据通过 Object.freeze 防改。源码位置: packages/node-modules-inspector/src/app/state/data.ts:9, 21-23

## 关键调用链

```
fetchData() (data.ts)
  → Object.freeze(data) → rawPayload.value = data (shallowRef 触发)
    → main getter 重算 → packages 变化
      ├─ watch(packages) 清掉所有跨包列表缓存
      ├─ excluded getter 重算（不动点迭代）
      │    ├─ 读 filtersExcludePredicate（来自 filters.ts）
      │    └─ 读 _main.map（父节点查询）
      ├─ available getter 重算（main − excluded）
      └─ filtered getter 重算
           └─ 读 filterSelectPredicate（来自 filters.ts，含 focus/why/depth/search）

下游消费者（graph.vue / grid.vue / chart.vue / report/* 等 32 个文件）
  → 订阅 payloads.{filtered|available|excluded|compareA|...}
  → 任一层失效时自动重渲
```

## 源码摘录（带行号，全文累计 ≤ 30 行）

清缓存 watch（演示权衡 2：手动清缓存）：

```ts
// packages/node-modules-inspector/src/app/state/payload.ts:55-61
  watch(packages, () => {
    _cacheList.dependencies.clear()
    _cacheList.dependents.clear()
    _cacheList.flatDependencies.clear()
    _cacheList.flatDependents.clear()
    _cacheFlatClusters.clear()
  })
```

不动点迭代（演示权衡 1：图语义传播孤儿）：

```ts
// packages/node-modules-inspector/src/app/state/payload.ts:128-147
  let changed = true
  while (changed) {
    changed = false
    for (const pkg of _main.packages) {
      if (excluded.has(pkg) || !pkg.dependents.size)
        continue
      let shouldExclude = true
      for (const parentSpec of pkg.dependents) {
        const parent = _main.map.get(parentSpec)
        if (!parent || !excluded.has(parent)) {
          shouldExclude = false
          break
        }
      }
      if (!shouldExclude)
        continue
      excluded.add(pkg)
      changed = true
    }
  }
```

## 易混淆 / 边界 / 推断

- **事实**：excluded 的不动点判定里"全部父都在 excluded"用的是 `_main.map.get(parentSpec)`——这里查的是 main 全量的 map，不是 excluded 自身的 map。所以"父不存在"（`!parent`）时当作"未被排除"处理（`shouldExclude = false`），这是安全侧：宁可保留也不误删。源码位置: packages/node-modules-inspector/src/app/state/payload.ts:135-141
- **事实**：workspace 包的排除是单独的 if 分支，在不动点循环之外执行，且不要求父链全部排除——只要 flag 开着就直接全砍。源码位置: packages/node-modules-inspector/src/app/state/payload.ts:149-154
- **事实**：excluded 用 `_main.packages.filter(filtersExcludePredicate)` 作为种子集——谓词只判"自身是否命中排除规则"，传递性由后面的不动点负责。源码位置: packages/node-modules-inspector/src/app/state/payload.ts:126
- **推断**：清缓存用 `watch(packages, ...)` 而非 `watchEffect`，是因为只需要在 packages 引用本身变化（数据重载）时清一次；单包字段变化（如某包的 clusters 字段被外部 mutate）不会触发清缓存——可能存在轻微脏读风险，但配合上游 Object.freeze 应被压到极低。源码位置: packages/node-modules-inspector/src/app/state/payload.ts:55, 21-23
- **推断**：available 用差集而非"重新跑一遍排除谓词"，是为了**让 filtered 层只需要再叠加选择谓词**，避免在每一层都重算全部规则——这是瀑布分层带来的实际收益。源码位置: packages/node-modules-inspector/src/app/state/payload.ts:164-172
- **事实**：getNpmMetaLatest 在 `pkg.resolved.npmMetaLatest` 与 rawNpmMetaLatest[name] 两个来源里按 `fetchedAt` 取较新者——这个时间戳字段名拼写为 `fetechedAt`（源码笔误但已成既定字段，下游必须跟着错拼）。源码位置: packages/node-modules-inspector/src/app/state/payload.ts:218-220
- **推断**：highlight 单独成文件、仅依赖 payloads.compareA/B，是为了让"高亮模式"可被任何 UI 组件复用而不必各自重算集合——典型的视图派生状态。源码位置: packages/node-modules-inspector/src/app/state/highlight.ts:1-16
- **未理解**：filtersExcludePredicate 里 `excludeDev` 判定是「clusters 含 dev 且不含 prod」——即"只在 dev 路径出现的包"才排除；如果一个包同时被 dev 和 prod 引用，它不会被排除。这是合理的图语义，但是否符合用户勾选"排除 dev 依赖"的直觉预期，可能存在 UI 文案与底层语义的偏差，需要 Writer 在正文里向读者点破。源码位置: packages/node-modules-inspector/src/app/state/filters.ts:45
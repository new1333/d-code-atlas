# 响应式 payload 级联：main → excluded → available → filtered

想象一下：你在依赖面板里勾掉了「排除 dev 依赖」，期望页面立刻清爽——结果列表里还杵着一堆你听都没听过的包，它们的名字既不像 dev 工具，也不在你写的 import 里。你忍不住嘀咕：「这玩意儿不是该没了吗？」

这一章要解决的就是这种「幽灵节点」：它们没被任何排除规则直接命中，但唯一指向它们的父节点早就被排掉了，事实上已经死了，只是列表还没埋。要弄明白为什么需要一套专门的瀑布式响应式数据流来收拾这个局面，我们得从依赖图本身的形状说起。

## 为什么「勾一下就消失」这么难

依赖关系不是一张表，是一张**有向无环图（DAG）**。一个包能不能被算作「还在依赖里」，其实有两个互相独立的判断维度：

1. **自身是否被规则命中**——比如类型是 `.dts`、是 dev 引入、是 private 包。
2. **是否还有活的引用**——即它至少有一条入边来自一个没被排除的父节点。

只做第 1 步、不做第 2 步，就会出现开头那一幕：规则没直接点名，但唯一指向它的父已经不在了。把这两件事拆成两步、并让前一步的产物作为后一步的输入，就得到了这一章的核心结构——**四层瀑布**。

## 自底向上看这四层

整条流水线一共四个 payload（payload 在这里就是个英文标识符，可以理解成「带缓存、能被响应式系统追踪的派生数据集合」），从下往上依次缩小：

```
rawPayload（原始数据）
      │
      ▼
   main         ← 全量节点
      │
      ▼
  excluded      ← 谓词命中 + 不动点传播孤儿
      │
      ▼
 available      ← main − excluded（差集）
      │
      ▼
  filtered      ← available 上叠加选择谓词（focus / why / depth / 搜索）
```

每一层都由同一个工厂函数产出——喂进去的 getter 不同，吐出来的 payload 就干不同的活。**8 个具名 payload 共享同一套基础设施**（map / versions / clusters 字段、跨包列表缓存、清缓存的 watch），区别只在「喂什么数据进来」。除了主线的四个，还有 compareA / compareB（A/B 对比的传递闭包）、reference（对比旧 dump）、workspace（用户自己的包）——它们消费同一套机制，主线讲完瀑布之后自然能举一反三。

下面把跟主题最相关的四层挨个拆开。

### main：全量入口

最底层。把上游加载完的原始节点列表原样吐出来，什么规则都不应用，就是「全部都在这」。它存在的意义是给后面三层提供一个稳定的「全集」基准——任何一层想做差集、想查父节点是不是存在，都回到 main 这里查。

### excluded：核心难点，不动点传播

这一层干两件事，先后顺序很关键：

**第一步**，跑一遍排除谓词，把直接命中的包挑出来当种子。谓词只判「自身是否匹配」——比如「类型是 dts 吗」「是 private 吗」「按某个名字模式匹配吗」。它**不看**父节点状态。

**第二步**，进入一个循环：扫描全量，只要发现某个包的全部父都已经在 excluded 里，就把它也加进 excluded；如此反复，直到一轮下来没有任何新增，循环退出。这就是**不动点迭代**——「不动点」是个数学行话，说人话就是「再算一遍也不会变了的状态」。

为什么需要这一步？因为只靠直接命中的种子集，会漏掉所有「孤儿」——那些自身没匹配规则、但唯一引用它们的父已经消失的包。

### available：一个差集

到了这一步就轻松了：available = main − excluded。代码层面就是过滤一遍 main，挑出那些 spec（包名@版本）不在 excluded 的 map 里的包。spec 是节点的唯一标识字符串，用它做 Map 的 key 可以 O(1) 判断在不在。

这一步**故意不再跑一遍排除谓词**——否则就浪费了 excluded 已经做的工作。瀑布分层的好处正在这里：每一层只做一件事，下游直接吃上游的产出。

### filtered：叠加「我还想看哪些」

available 是「没被排除的」，但用户可能还想知道「在这一堆里，再按 focus / why / 深度 / 搜索框筛选一下」。这就是 filtered 的活——在 available 之上再叠一层选择谓词。

注意「排除」和「选择」是两个概念：排除是从全集里拿掉（决定「不存在」），选择是在剩下的里面挑（决定「高亮 / 聚焦」）。前者改 available，后者只改 filtered。两条线分开，是因为它们语义独立——你可以排除 dev 同时 focus 在某个入口包上。

## 不动点迭代：演透机制

光说不练假把式。下面这个 30 来行的脚本演示完整四层瀑布，重点把 excluded 层的 `while (changed)` 循环写出来。可以存成 `cascade.mjs` 用 `node cascade.mjs` 直接跑，肉眼看每轮 excluded 集合怎么长。

> **关于谓词的诚实说明**：真实代码里 `excludeDev` 的判定要看 `pkg.flatClusters`——也就是「自己 + 所有传递父」的 cluster 标签**并集**。这导致一个反直觉的后果：如果一个包被 dev 路径引用、但同时被某个 prod 父间接引用，它的 flatClusters 会同时含 dev 和 prod，**不会**被排除。这个语义对演示「不动点机制」来说太纠缠（谓词内部本身已经依赖图结构），所以我们这里换成一个干净的抽象谓词：`kind === 'mock'`，与图结构完全无关。**机制本身（谓词命中种子 + 不动点传播孤儿）和真实代码完全一致**，只是种子的判定方式被简化，目的是让你看清「为什么需要不动点」这件事，而不是去抠 dev 排除的具体规则。

```ts
// cascade.mjs —— 演示 raw → excluded(不动点) → available → filtered

type Pkg = { name: string; kind: 'app' | 'lib' | 'mock'; dependents: string[] }

// 一棵依赖链：app → ui-lib → ui-mock → theme → icons
// 故意按「子在前、父在后」的顺序排列，让多轮迭代的效果肉眼可见
const packages: Pkg[] = [
  { name: 'icons',   kind: 'lib',  dependents: ['theme']   },
  { name: 'theme',   kind: 'lib',  dependents: ['ui-mock'] },
  { name: 'ui-mock', kind: 'mock', dependents: ['ui-lib'] },
  { name: 'ui-lib',  kind: 'lib',  dependents: ['app']     },
  { name: 'app',     kind: 'app',  dependents: []          },
]

// 第 1 层：main = 全量
const main = packages
const byName = new Map(main.map(p => [p.name, p]))

// 抽象排除谓词（真实代码里会查 flatClusters / module === 'dts' / private 等）
const directExclude = (pkg: Pkg) => pkg.kind === 'mock'

// 第 2 层：excluded = 谓词命中种子 + 不动点传播
function computeExcluded(main: Pkg[]) {
  const excluded = new Set(main.filter(directExclude))

  let round = 0
  let changed = true
  while (changed) {
    changed = false
    round++
    for (const pkg of main) {
      // 已经在 excluded 里、或者根本没入边（根节点）——跳过
      if (excluded.has(pkg) || pkg.dependents.length === 0)
        continue

      // 关键判定：所有父是否都已在 excluded 里？
      const allParentsExcluded = pkg.dependents.every((name) => {
        const parent = byName.get(name)
        // 父不存在时也当作「未排除」处理（安全侧：宁可保留也不误删）
        return parent && excluded.has(parent)
      })

      if (allParentsExcluded) {
        excluded.add(pkg)
        changed = true
      }
    }
    console.log(`round ${round}: excluded = { ${[...excluded].map(p => p.name).join(', ')} }`)
  }
  return excluded
}

const excluded = computeExcluded(main)

// 第 3 层：available = main − excluded
const available = main.filter(pkg => !excluded.has(pkg))

// 第 4 层：filtered = available 上叠加选择谓词（这里以「kind === 'lib'」为例）
const selectPredicate = (pkg: Pkg) => pkg.kind === 'lib'
const filtered = available.filter(selectPredicate)

console.log('available :', available.map(p => p.name))
console.log('filtered  :', filtered.map(p => p.name))
```

跑一下，输出大概长这样：

```
round 1: excluded = { ui-mock, theme }
round 2: excluded = { ui-mock, theme, icons }
round 3: excluded = { ui-mock, theme, icons }
available : [ 'ui-lib', 'app' ]
filtered  : [ 'ui-lib' ]
```

逐轮看发生了什么：

- **种子**：`ui-mock` 因 `kind === 'mock'` 直接被命中，进入 excluded。
- **第 1 轮**：扫描时遇到 `theme`，它的唯一父是 `ui-mock`（已排除）→ 加入 excluded。但 `icons` 排在 `theme` **之前**，本轮扫到 `icons` 时 `theme` 还没被加进去，所以 `icons` 这一轮没动。
- **第 2 轮**：再扫一遍，`icons` 的父 `theme` 现在已经在 excluded 里了 → 加入。
- **第 3 轮**：没有任何新增，`changed` 保持 `false`，循环退出。

这就是为什么需要「不动点」而不是「扫一遍」——扫一遍会漏，因为同一轮里靠后位置发生的变更，对靠前位置的判定是不可见的。**只有重复到不再变化，才能保证收敛到真正的图语义。** 第 3 轮虽然没加任何东西，但仍然要跑——这是算法验证「我真的收敛了」的唯一方式。

### 反向对照：父还在的链不会被牵连

把样本稍微改一下，让 `ui-lib` 同时依赖 `ui-mock` 和 `theme`：

```
app → ui-lib → ui-mock (mock，直接命中)
            ↘ theme → icons
```

也就是说 `theme` 的父是 `ui-lib`（不是 `ui-mock`）。这种情况下：

- 第 1 轮：`ui-mock` 直接命中。
- 后续轮：`theme` 的父 `ui-lib` 没被排除 → `theme` 不会被牵连；`icons` 同理。
- 收敛后 excluded 只有 `{ui-mock}`，available 还有 `{app, ui-lib, theme, icons}`。

这演示了一条关键性质：**排除不传递「被排除性」**。一个包被排除，不会让它的兄弟或父也被排除——只会让它那些「只剩它这一条入边」的子节点被牵连。判定永远是「**这个包的全部父**是否都在 excluded」，不是「这个包是否有任何一个父在 excluded」。

### 一个执行轨迹的两种解读

回头看最初那个 `app → ui-lib → ui-mock → theme → icons` 的链。用户的本意可能是「我不关心 mock，藏起来」。系统给出的结果是：连同 `theme` 和 `icons` 也一起藏了。

这是不是「正确」？取决于你怎么定义「正确」：

- **图语义视角**：`theme` 和 `icons` 唯一的活引用是经由 `ui-mock` 的，`ui-mock` 没了，它们事实上也不在依赖链里了。藏掉是对的。
- **规则字面视角**：用户只说了「排除 mock」，没说「排除 theme」。自动牵连是不是「越权」？

真实代码选择的是图语义视角，理由是：依赖图本来就是用来回答「这包到底还在不在依赖链里」的工具，如果保留幽灵节点，用户会被误导以为这些包还在用。这是一个有意识的权衡——下一节展开。

## 三条关键权衡

下面三条是这一层设计上真正值得复述的取舍。

### 权衡 1：不动点迭代换图语义正确，代价是 O(N²) 最坏复杂度

**做了什么选择**：用「重复扫描直到收敛」的循环，而不是「扫一遍拉倒」。循环结构很简单——维护一个 `changed` 标志，每轮扫一遍全量，只要这一轮里加入了任何新包就把 `changed` 重置为 `true`，进入下一轮；直到某一轮没有任何新增，循环退出。

**换来了什么**：available 集合保持图语义正确——一个包当且仅当「至少有一条入边来自未排除的父」时才可见。开头的「幽灵节点」痛点被根治。

举个具体场景：一个 5000 包的 monorepo，假设用户排除了根入口包 `app`。如果只扫一遍，最多排除掉 `app` 的直接子节点；但 `app` 的孙节点、曾孙节点都还挂着，因为它们各自的父（`app` 的子节点）当时还没被排除。结果列表里会留下一大串「事实上不存在」的包。不动点迭代保证这些孙、曾孙节点在后续轮里被陆续发现并排除。

**代价**：最坏情况下每轮只排除一个包。比如节点按反向拓扑序排（最深的叶子排最前），第一轮扫到最深的 `leaf_N` 时它的父 `leaf_{N-1}` 还没排除；要等到第二轮 `leaf_{N-1}` 才被排除（因为这时它的父 `leaf_{N-2}` 还没排除……如此往复）。每轮 O(N) 工作量，N 轮才收敛，总计 O(N²)。5000 包的极端情况理论上要 5000 轮、约 2500 万次操作。

**怎么压住代价**：把整层 excluded 包成 `computed`——只在它依赖的 rawPayload 或 filters 变化时才重算；视图层订阅的是这个 computed，组件重渲不会触发重算。换句话说，O(N²) 只发生在过滤器真正变化时（用户勾选项、改搜索词），不是每次拖动 graph 或滑 chart。算法本身在最坏情况下不快，但响应式缓存让它的触发频率被压到极低，且每次触发都是用户主动行为，几百毫秒延迟可以接受。

**为什么不用更聪明的算法**：可以先用拓扑排序把 DAG 线性化，再按拓扑序一遍扫完，理论 O(N + E)。但代价是：要先实现拓扑排序、要先检测环（虽然依赖图理论上是 DAG，但实际数据可能有脏边）、要维护一个额外的拓扑序缓存。对于一个「过滤改动」这种低频操作，多写 50 行代码换几十毫秒的优化不划算。**这是典型的「算法复杂度换工程简单度」**——选简单的 O(N²) 配响应式缓存，而不是复杂的 O(N) 不带缓存。

### 权衡 2：多层 computed + 手动清缓存，换来查询期 O(1)，代价是一致性靠开发者自觉

**做了什么选择**：跨包的列表查询（直接依赖、直接被依赖、传递依赖、传递被依赖、cluster 闭包）不在响应式容器内每次重算，而是在外层另开 5 个 `Map` 缓存，由一个顶层 `watch(packages, ...)` 在节点集合变化时一次性 `clear()` 全部缓存。结构大致是：

```ts
const _cacheList = {
  dependencies: new Map<string, Pkg[]>(),
  dependents: new Map<string, Pkg[]>(),
  flatDependencies: new Map<string, Pkg[]>(),
  flatDependents: new Map<string, Pkg[]>(),
}
const _cacheFlatClusters = new Map<string, Set<string>>()

watch(packages, () => {
  _cacheList.dependencies.clear()
  _cacheList.dependents.clear()
  _cacheList.flatDependencies.clear()
  _cacheList.flatDependents.clear()
  _cacheFlatClusters.clear()
})
```

**换来了什么**：查询期 O(1) 读。视图层拖动 graph、滑 chart、敲搜索框时，`flatDependents(pkg)`、`flatClusters(pkg)` 这些高频操作直接命中缓存。视图重渲只会重算实际依赖字段，不会触发全图重算。

举个具体场景：treemap 可视化每次重绘要遍历几百个节点，每个节点都要查 `flatDependents` 来算 cluster 标签并集。如果不缓存，每次重绘就是几百次图遍历，每次 O(N + E)，加起来上百万次操作，帧率立刻掉到个位数。缓存后变成几百次 Map 查找，<1ms 完成。

**代价**：缓存一致性靠开发者自觉。每加一类派生数据，必须记得在那个顶层 watch 里加一行 `clear()`，否则会产生脏读。比如未来要加一个 `flatVersions` 缓存（按 major version 聚合），开发者忘了加 `_cacheFlatVersions.clear()`，数据重载后第一批查询会返回旧版本号。

**这是不是一个好交易**：是。理由有三：

1. **集中**：清缓存的 watch 是一个点状的、可命名的、可在 review 时肉眼审计的位置——一个文件里、几行代码、所有缓存清空操作集中在一起。集中意味着容易测、容易审。
2. **失败模式可观察**：脏读的后果是「列表里多/少了几个包」或「某个聚合数字不对」，用户立刻就能看到不对劲，不是「某天线上炸了才发现」的隐性故障。
3. **Vue 的响应式系统对深层 Map 不友好**：把 `Map<spec, PackageNode[]>` 直接塞进 reactive 会触发深层 proxy 包装，每次读写都走代理，性能急剧下降。用 shallow Map + 手动清缓存绕开了这个坑——既享受了「packages 变化时自动失效」的响应式便利，又保住了 Map 操作的原生速度。

代价确实存在，但被控制在一个可观察、可审计的范围内。

### 权衡 3：过滤状态外置 + 谓词注入，换来规则可扩展，代价是跨模块耦合

**做了什么选择**：过滤规则和状态全部由独立的 filters 模块维护，瀑布层只调用它暴露的两个谓词函数：

- `filtersExcludePredicate(pkg)`：用于 excluded 层，决定包是否被直接排除
- `filterSelectPredicate(pkg)`：用于 filtered 层，决定包是否被选中

本层不自己判断「这个包是 dev 吗」「这个包是 private 吗」「这个包是 .dts 吗」。

**换来了什么**：过滤逻辑集中。新规则只需在 filters 模块里加一个分支，瀑布层零改动。比如未来要加「排除未填 license 的包」，只需在 `filtersExcludePredicate` 里加一段：

```ts
if (state.excludeUnlicensed && !pkg.resolved.license)
  return true
```

瀑布层一行都不用动。规则的演进被隔离在一个文件里，不会污染数据流。

**代价**：跨模块耦合反过来——filters 模块的 `filtersExcludePredicate` 内部要读 `pkg.flatClusters`（用来判 dev / prod），而 `flatClusters` 是瀑布层提供的派生数据（因为它需要遍历传递父，依赖跨包列表缓存）。换句话说，filters 依赖瀑布层的派生能力，瀑布层又依赖 filters 的谓词。如果分层不清晰，两个模块会互引成环。

**这套设计怎么解这个结**：把 `flatClusters` 实现成「接收一个 pkg、内部按需查 main 层的缓存」的函数——它读的是 main（全集层），不是 excluded 或 filtered。这样 filters 实际依赖的是 main 这一层，而 main 又不依赖 filters（main 的 getter 只是 `() => Array.from(rawPayload.value?.packages.values())`，不读任何过滤器）。环被切断，模块依赖图本身也变成了一个 DAG。

**这个权衡的本质**：「规则」和「数据流」分离是有代价的——它迫使你为「规则需要用到的派生数据」单独建模一个稳定的来源（这里是 main 层的 flatClusters 缓存）。代价不小，但收益（规则可扩展、瀑布层零改动）更大。

**对比另一种设计**：把过滤规则直接写在瀑布层里，每次 excluded 重算时内联判断。优点是没有跨模块耦合；缺点是每加一条规则都要改瀑布层，而且规则测试要构造完整的 payload 上下文。把规则外置后，filters 模块可以独立单测——构造一个假 pkg 对象，喂给谓词，看返回值。测试粒度从「集成」降到「单元」，可维护性大幅提升。

## 一句话回到主线

整条瀑布的设计可以浓缩成一句：**让每一层只做一件事，让响应式系统替你管缓存，让不动点算法替你管图语义。** 用户的痛点（「勾了一下还有幽灵」）不是某一行代码能修的，它需要一个**层级清晰的数据流**——main 兜底、excluded 算图语义、available 做差集、filtered 叠选择。每一层都是上一层的简单变换，组合起来却解决了「在 DAG 上做规则过滤」这个本质上不平凡的问题。

下一章会讲这套响应式状态怎么和 URL 双向绑定——同样的「主层 + 派生」思路会再次出现。
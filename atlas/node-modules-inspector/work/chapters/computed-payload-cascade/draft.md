# 响应式 payload 级联：main→excluded→available→filtered

> 本章属于 composite 层。前置：过滤器与搜索。
> 学完你能：讲清"为什么过滤要拆四层、不动点为什么要跑、缓存为什么靠开发者手动清"。

## 1. 为什么需要它

上一章解决了「怎么把外部 registry 的版本、漏洞、废弃信息填进每个包」。可一旦用户在依赖面板里勾掉「排除 dev 依赖」，所有这些刚刚填好的数据得按图语义收缩，只留下"还在生产依赖里"的那些包。

这个收缩比看上去难。依赖图是 DAG，你直接把命中的 dev 包从列表里删掉，它们的间接子节点会瞬间变成"父都没了"的孤儿，却仍然挂在面板上，让人误以为这包还在生产依赖里。

用户的脑子里只想"勾一下就看不见"，但过滤其实是图语义。要让他看到的结果符合直觉，你得替他算两件独立的事：

- **包自身被规则命中**：勾了「排除 dev」就删 dev 包、勾了「排除 .dts」就删类型包；
- **包的全部父都已被排除**：即便它本身不是 dev，只要没人能从生产路径走到它，它对用户就是噪音。

只做第一件不做第二件，面板就会残留一堆"看似还在依赖里"但其实无人引用的幽灵节点。

还有个工程动机：把"全量""被排除""可用""最终过滤"切成几个清晰的中间产物，**每层都能被不同 UI 复用**——按维护者聚合的报告读 available、A/B 对比读 compareA/B、按体积求和读 available，各取所需，而不是把所有规则揉进一个巨型派生值。

## 2. 核心思想

把"过滤一个 DAG"拆成两个独立问题：**每层负责什么（层级）**，以及**层与层之间怎么传播（算法）**。前者是一组职责单一的派生集合；后者是一个不动点循环——只要一个包的全部父都被排除，它就得走。

用工程的话说：你写的是几个声明式的 `computed`，但其中一层内部藏着一个 `while(changed)` 的迭代。声明式壳、命令式芯，这是图算法在响应式框架里的标准姿势。

## 3. 心智模型

### 数据结构

每一层都是一个 reactive 容器，内部包含：

- `packages`：这一层的节点数组（响应式）
- `map`：`spec → node`，O(1) 查表
- `versions` / `clusters`：按版本、按 cluster 标签的反向索引
- 一组带参访问器：`dependencies(pkg)`、`flatDependents(pkg)` 等（§4 会讲为什么单独缓存）

层与层之间靠 `computed` 串起来——`excluded` 只读 `main`、`available` 只读 `main` 和 `excluded`、`filtered` 只读 `available`。Vue 的依赖追踪沿调用栈自动接线，你不需要手写"A 变了通知 B"。

### 瀑布五步

1. 数据加载完成，原始节点列表进入 **main**（全量）。
2. **excluded** 做两件事：先用谓词直接命中；再跑不动点——任何"全部父都在 excluded"的节点也加入，重复到收敛。
3. **available** = main − excluded（差集，按 spec O(1) 判定）。
4. **filtered** 在 available 之上叠加选择谓词（focus / why / depth / 搜索串等）。
5. 任一层输入变化，下游自动失效；跨包的列表缓存由顶层 watch 集体清空，下次访问时按需重建。

## 4. 关键权衡

### 用不动点迭代传播图上的"孤儿"

**选择**：在 excluded 层里写一个 `while(changed)` 循环，每轮扫一遍 main，只要某节点的所有父都已进入 excluded，就把它也加进去，直到一轮下来没有新增。

**换来**：available 集合保持图语义——一个包当且仅当至少一条入边来自未被排除的父时，才会出现在 available 里。用户看到的面板不再有"父都没了却还挂着"的幽灵节点。

**代价**：理论上是 O(N²)，每一轮可能只排除一批，需要多轮才收敛。实际项目靠响应式缓存兜住：computed 默认会追踪依赖，过滤器不变就不重算，所以这份 O(N²) 只在过滤器真的变了的那一次跑，而不是每次组件重渲都跑。

**背后的本质矛盾**：这是"算得快 vs 算得对"在 DAG 上的天然冲突。只看一跳是 O(N) 但留幽灵，看全图就要不动点。这不是本仓库的特殊问题：拓扑排序、垃圾回收的可达性分析、控制流分析的固定点，都是同一族骨架——给一张图和一个单调收缩的集合，反复传播到收敛。读者一旦认出这个骨架，在任何语言的图算法里都能复用。

### 跨包列表查询外挂一份 Map 缓存，由顶层 watch 主动清

**选择**：像 `dependencies(pkg)`、`flatDependents(pkg)` 这种"给一个包返回一组包"的查询，在 reactive 容器之外另开一份 `Map<spec, PackageNode[]>`，由一个顶层 `watch(packages, ...)` 在节点集合变化时一次性 clear 全部。

**换来**：查询期 O(1) 读，视图层只重算实际依赖的字段。graph/chart 拖动、grid 滚动这类高频交互不会触发全图重算。

**代价**：缓存一致性靠开发者自觉。每加一类派生数据，必须记得在同一条 watch 里加一行 clear，否则会脏读到旧集合。这不是一次性代价，是持续性的"修护栏"负担——加新功能时最容易漏的就是清缓存。

**背后的本质矛盾**：这是响应式系统在"带参查询"面前的天然短板。Vue 的 computed 自动追踪依赖，但只对它**自己内部读过的响应式数据**生效；`dependencies(pkg)` 这种带参函数，入参 pkg 不是响应式 key，无法被 computed 自动追踪。要么给每个 pkg 都做一个 computed（数据爆炸），要么外挂一份 Map 手动管（代码自觉）。任何响应式框架都会撞上这道墙——React 的 useMemo、Svelte 的 derived 都有类似的"参数化派生"难题。本项目选外挂缓存，是因为查询的输入集合有限（只有当前 main 里的包），Map 不会无限膨胀。

### 让响应式系统沿调用栈自动追踪跨模块依赖

**选择**：瀑布层不自己判断 dev / dts / workspace，而是直接调用过滤模块暴露的 `filtersExcludePredicate.value`，让 Vue 通过调用栈自动建立依赖。过滤器一变，excluded 自动重算，瀑布层完全不感知规则长什么样。

**换来**：过滤逻辑集中在一处，加新规则只在过滤模块加分支，瀑布层零改动。前一章讲过的"声明式 schema + 构造式谓词"在这里被原样复用，本章不重复造轮子。

**代价**：跨模块耦合。本层依赖图会被过滤模块反过来读取（cluster 闭包来自节点对象，而节点对象来自瀑布层）。必须分层清晰，否则两个模块互引成环。

**背后的本质矛盾**：这是"模块边界"和"响应式追踪"的隐性对抗。响应式系统的依赖追踪是**沿调用栈穿透**的：只要你在 computed 里读了一个 ref，你就建立了依赖，跟这个 ref 在哪个模块无关。这让代码"看起来高内聚"，瀑布层不需要知道规则长什么样，只调一个函数，响应式系统自动接好线。但运行时它变成了一张共享图：读 `filtersExcludePredicate.value` 时，过滤模块的状态成了瀑布层的隐式输入。代价就是模块依赖图可能反向，要靠开发者显式管边界。

## 5. 最小原理演示

下面这段是瀑布的核心，故意不接 Vue，纯 JS 跑。重点演透两件事：**四层是几个职责单一的纯函数**，**excluded 里那个 `while(changed)` 真的会多轮收敛**。

```js
// 最小 DAG 节点：name + 入边（谁依赖我）+ 是否只在 dev 路径
function pkg(name, { parents = [], devOnly = false } = {}) {
  return { spec: name, dependents: new Set(parents), devOnly }
}

// 第 1 层 main：全量 + spec→node 的 O(1) 查表
const main = { packages: [], map: new Map() }
function setMain(pkgs) {
  main.packages = pkgs.slice()
  main.map = new Map(pkgs.map(p => [p.spec, p]))
}

// 第 2 层 excluded：谓词命中种子 + 不动点传播孤儿
function computeExcluded(shouldExclude) {
  const excluded = new Set(main.packages.filter(shouldExclude))

  let changed = true
  while (changed) {
    changed = false
    for (const p of main.packages) {
      if (excluded.has(p) || p.dependents.size === 0)
        continue
      // 找到一个还在的父（在 main 中且不在 excluded）→ 这个包还有入边，跳过
      let allParentsGone = true
      for (const parentSpec of p.dependents) {
        const parent = main.map.get(parentSpec)
        // 父不在 main 当作"未排除"（安全侧），父在 main 但不在 excluded 也算未排除
        if (!parent || !excluded.has(parent)) {
          allParentsGone = false
          break
        }
      }
      if (allParentsGone) {
        excluded.add(p)
        changed = true
      }
    }
  }
  return excluded
}

// 第 3 层 available：main − excluded（spec O(1) 判定）
function computeAvailable(excluded) {
  const ex = new Set([...excluded].map(p => p.spec))
  return main.packages.filter(p => !ex.has(p.spec))
}

// 第 4 层 filtered：available 上叠加选择谓词
function computeFiltered(available, selectPredicate) {
  return available.filter(selectPredicate)
}
```

四层之间的衔接是几个 `computed`——本演示省略了响应式包装，因为核心思想（层级 + 不动点）不依赖它。换成 Vue，就是把每个 `computeXxx` 包成 `computed(() => ...)`，让响应式系统在输入变化时自动重新调用。

注意 `excluded` 里有一处反直觉但重要的细节：判定"父是否被排除"时，查的是 `main.map`（全量），不是 `excluded` 自身的 map。父不存在（`!parent`）时按"未被排除"处理，这是**安全侧**：宁可保留也不误删。

## 6. 执行轨迹

构造一条 A → B → C → D，其中 B 是 dev-only（`dependents` 是父，所以 A 是 B 的父、B 是 C 的父、C 是 D 的父）：

```js
const A = pkg('A')                                     // 根
const B = pkg('B', { parents: ['A'], devOnly: true })  // dev-only
const C = pkg('C', { parents: ['B'] })
const D = pkg('D', { parents: ['C'] })
setMain([A, B, C, D])

const excluded  = computeExcluded(p => p.devOnly)
const available = computeAvailable(excluded)
```

用户勾「排除 dev 依赖」，谓词是 `p.devOnly`。瀑布跑起来：

- **种子（进入循环前）**：扫一遍 main，B 是 dev-only，直接命中。`excluded = {B}`。
- **第 1 轮**：A 没父跳过；B 已在 excluded 跳过；C 的父是 B、B 已在 excluded → C 加入；D 的父是 C、C 此刻还不在 excluded（本轮刚加）→ 跳过。`changed = true`，`excluded = {B, C}`。
- **第 2 轮**：D 的父是 C、C 现在在 excluded → D 加入。`changed = true`，`excluded = {B, C, D}`。
- **第 3 轮**：无新增，`changed = false`，循环退出。

最终 `available = {A}`。整条 dev 链路被全部剪除，没有幽灵节点残留。

### 反向对照：dev 包在叶子，不动点不传播"被排除性"

换一棵 A → B → C(dev-only)，C 是叶子：

```js
const A2 = pkg('A')
const B2 = pkg('B', { parents: ['A'] })
const C2 = pkg('C', { parents: ['B'], devOnly: true })
setMain([A2, B2, C2])

const excluded2 = computeExcluded(p => p.devOnly)
// 种子：{C}。
// 第 1 轮：B 的父 A 还在，跳过；A 没父不参与。changed=false，退出。
// excluded = {C}，available = {A, B}
```

**非 dev 包即使依赖了 dev 包也不会被牵连**，只要它还有任何一条入边来自非 dev 路径，它就活着。不动点判的是"全父状态"，不是"被排除性"的传递。这一点对用户是否符合直觉可能存疑（他可能以为"依赖了 dev 包的包也该被砍"），但符合图语义：dev-only 是路径标签，不是污染标签。

## 7. 教学简化说明

本章演示故意省略了几样东西，它们是工程化包装，与核心思想无关：

- **响应式包装**（`computed` / `reactive` / `watch`）：演示用纯函数，核心思想（层级 + 不动点）不依赖 Vue。
- **跨包列表缓存**（`dependencies` / `flatDependents` 的 Map 缓存）：它是工程权衡 2 的产物，但不是瀑布本身的核心；演透层级与不动点之后再读源码，缓存就是一层薄包装。
- **compareA / compareB 的传递闭包、reference 层、cluster 闭包、npm 元信息旁路**：都是消费 payload 的旁支，主线讲完瀑布即可。

## 8. 小结

这一章把"过滤"写成了几条瀑布加一次不动点迭代——瀑布管职责边界，不动点管传递性。**任何 DAG 上的"可见性判定"几乎都需要这两个独立部件**：一组单调收缩的集合，加一个反复传播到收敛的循环。垃圾回收、拓扑排序、控制流分析都是这一族骨架的近亲。

到此为止，所有状态都活在内存里，刷新就丢了。下一章会把过滤器、瀑布结果、选中节点塞进 `location.hash`，让别人能通过一个链接看到和你一样的视图。
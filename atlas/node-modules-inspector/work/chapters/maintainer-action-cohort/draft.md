# 维护者行动算法：迁移比例与 catalog 解析

## 这一章在解决什么问题

想象你刚接手一个老 monorepo，跑一次依赖分析，屏幕上跳出两千多个包。你面前是一份实实在在的「现场清单」，但维护者真正想问的不是「谁重复了」——重复的可以另开一篇——而是这三个问题：

- 我这个仓库里，**还有哪些依赖停在旧版**？谁该优先升？
- 哪些声明已经**跟上了最高稳定版**，可以暂时放心？
- monorepo 内部那堆 `@scope/a` 依赖 `@scope/b` 的 alias，**别给我误报成迁移机会**。

光靠眼睛翻每个 `package.json` 是不现实的——一份声明的版本可能写在 `dependencies`，可能写在 `peerDependencies`，可能根本就是一个 `catalog:deps` 引用指向别处。本章讲的那块代码，就是把这堆纷乱的输入自动变成一张「按消费方分组的升级待办表」。

它做的不是「找出重复」，而是回答一个**主观的优先级问题**——「该先动谁」。把这个主观问题**变成一个数值排序问题**，靠的就是两件可静态计算的事：迁移比例 `migrated / total`，和 semver 范围判定。这两件事都不需要联网、不需要发请求，本地就能跑完。

## 一句话核心思想

> 先按依赖名把已装版本聚成一个 cohort 拿到「最高稳定版」基线；再用每条声明的 semver 范围去判它属于「已迁」还是「落后」；最后按消费方重组，就得到一张可行动的升级待办表。

打个比方：cohort 就像一块**公共留言板**——所有装在项目里的、名字相同的包版本都贴在同一块板上；这块板上写着「目前最高稳定版是 18.2.0」。然后每条 `dependencies` 里的声明就像一张张**便签**，写着「我能接受的最低范围是 `^17`」——把它跟留言板上的最高版对一下，就知道这张便签要不要被排进升级清单。

## 自底向上：从一块「cohort 留言板」开始

### 第 0 层：cohort 基线 = stable 最高版

第一个要做的事是把全场已装包**按依赖名**收拢。比如项目里同时存在 `react@17.0.0` 和 `react@18.2.0`，它们都属于同一个 cohort：`react`。

但是 cohort 的「最高版」**不是简单取末位**——先要做两步过滤：

1. **过滤掉 prerelease**。`18.0.0-alpha.3` 不能算最高版，否则下一步算迁移建议时会引导用户升到 alpha。
2. **如果全是 prerelease，整条依赖作废**。这条依赖的统计记为 `null`，被静默跳过。

为什么这么严？因为这份表是给维护者做**决策**用的，一个不小心推到 alpha，事后排查「为什么 CI 全挂了」就是几小时的事。

### 第 1 层：声明范围要过两道关

光有 cohort 基线还不够——你的 `package.json` 里写的版本范围五花八门，得先**规整**。

**第一道关：catalog 解析。**

`pnpm` 的 `catalog:` 机制允许你把所有版本集中到一个文件里管，写法是：

```json
{
  "dependencies": {
    "react": "catalog:deps"
  }
}
```

这里的字符串 `"catalog:deps"` **本身不是一个 semver 范围**。直接喂给 `satisfies()` 一定会炸。所以第一步必须把 `catalog:deps` 解析回真实的 `^18.2.0`：

```ts
function resolveCatalogRange(range, depName, catalogs) {
  if (!range.startsWith('catalog:')) return range        // 普通范围，原样返回
  if (!catalogs) return undefined                       // 没传 catalog 表 → 作废
  const name = range.slice('catalog:'.length) || 'default'
  return catalogs[name]?.[depName]                      // 查不到也作废
}
```

**第二道关：纯 semver 范围判定。**

解析完之后还得过滤——只有「纯 semver 写法」才进入判定。下面这些直接排除：

- `*`、`latest`、`x`（太宽泛，等于没说）
- `workspace:*`、`link:../foo`、`file:./pkg`、`npm:foo@1.0.0`（本地或别名引用）
- `git+https://...`、`http://...`、`github:owner/repo`（非 registry 来源）

为什么要排掉 `*`？因为它**永远满足**任何版本——把它算进 `migrated` 会让比例虚高，对决策没有意义。

### 第 2 层：三态判定

现在有了 cohort 基线（最高稳定版 `highestVersion`），也有了规整后的声明范围 `range`，可以做判定了：

| 情况 | 含义 | 计入 |
|---|---|---|
| `satisfies(highestVersion, range)` 为真 | 声明接受最高版，**已迁移** | `migrated++` |
| `isGreaterThanRange(highestVersion, range)` 为真 | 最高版超出声明范围，**落后** | `behind++` |
| 都不命中 | 声明比最高版还高（罕见） | **忽略**，不计入任何分母 |

第三种「忽略」最容易被忽略——它意味着这条声明**不属于这个 cohort 的统计口径**。比如某个 patch-only 的内部补丁版本被锁死在比 npm 公开版本更高的号段上。如果把这类也算进 `total`，迁移比例的分母会被噪声污染。

> 两个 semver 调用都包了 `try/catch`，库抛错时返回 `null` 视作不命中。这是一道保险——某些畸形范围（比如空字符串、奇怪的组合）会让 semver 库炸掉，不能让一条坏声明把整张表算崩。

### 第 3 层：为什么要扫两遍

这是全章最关键的机制点。说人话就是：

> **第一遍扫，是为了让计数稳定下来；第二遍扫，才能用稳定的计数生成可读的待办项。**

为什么要这么麻烦？因为单条声明的「迁移比例」**不是它自己的事**，而是整个 cohort 的事。

考虑这个场景：cohort `react` 装了 17 和 18 两个版本，三条声明里：

- `app` 声明 `^17`（落后）
- `lib-a` 声明 `^17`（也落后）
- `lib-b` 声明 `^18.0.0`（已迁）

最终的 `migrationRatio` 应该是 `1/3 ≈ 0.33`。这个分母 3，**必须等所有声明都过完一遍**才能确定。

如果你一边扫一边生成 item，会出问题：

- 扫到 `app` 时，stats 还只有 `behind=1`，这时生成的 item `totalCount=1, migrationRatio=0`。
- 等扫到 `lib-b` 时，分母才变成 3。

每条 item 拿到的 `totalCount` 不一致，UI 上一会儿显示 0%、一会儿显示 33%，就乱了。

所以代码把这件事**硬拆成两遍**：

```ts
// 第一遍：只累加 stats，不生成 item
for (const consumer of packages) {
  for (const [depName, rawRange] of entries(consumer.deps)) {
    const range = resolveCatalogRange(rawRange, depName, catalogs)
    if (!isPlainSemverRange(range)) continue
    const entry = getStats(depName)
    if (!entry) continue
    if (safeSatisfies(entry.highestVersion, range)) entry.migrated++
    else if (safeGtr(entry.highestVersion, range)) entry.behind++
  }
}

// 第二遍：基于已稳定的 stats，生成 item
for (const consumer of packages) {
  for (const [depName, rawRange] of entries(consumer.deps)) {
    // ...同样的过滤...
    if (safeGtr(entry.highestVersion, declaredRange) !== true) continue
    // 只有「落后」的声明才会变成可执行 item
    items.push({ /* ...migrationRatio: entry.migrated / total */ })
  }
}
```

注意第二遍里的 `if (safeGtr(...) !== true) continue`——它意味着「已迁」的声明**不会变成 item**，但它在第一遍里贡献的 `migrated++` 仍然保留在分母里。这就是「参与计数但不产生待办」的语义。

### 第 4 层：兄弟跳过

到这一步 item 已经能生成了，但有个反直觉的情况：monorepo 内部，`@scope/lib-a` 的 peer 声明里写了 `@scope/lib-b: workspace:^1.0.0`（解析出来就是某个 semver 范围），而 lib-a 和 lib-b 都锁在比 npm 公开发布版本更低的号段上——按理说会命中 gtr、生成一条「升级 `@scope/lib-b`」的待办。

但这条待办是**假的**：lib-a 和 lib-b 是同一家仓库的兄弟包，它们的版本号节奏是仓库内部的事，跟「该不该升 npm 上公开发布的版本」完全是两个问题。

守卫条件很简单：

```ts
const consumerRepo = consumer.resolved.repository?.url
const depRepo = entry.highestPkg.resolved.repository?.url
if (consumerRepo && depRepo && consumerRepo === depRepo) continue
```

注意是**两边都为真且相等**才跳过——只要有一边没填 `repository` 字段，跳过逻辑就不生效，落回正常判定。这条守卫只对「已经走到 gtr 命中之后」才生效——也就是说它**只在第二遍出现**，第一遍累加 stats 时不查 repo。

### 第 5 层：按消费方重组

最后一层把扁平的 items 数组按 `consumer.spec` 分桶，每个桶叫一个 `MaintainerActionGroup`。分组时还会算两个聚合字段：

- `maxMigrationRatio`：这个消费方所有 item 里最高的迁移比例。
- `latestReleasedAt`：消费方自己的发布时间，用于「按最新发布排序」模式。

消重逻辑也藏在这里：先按 `spec`（带版本号）分桶，再按 `name` 二次去重——同名只保留版本号最高的那个。这样 `app@1.0.0` 和 `app@1.1.0` 不会同时出现在表里。

三种排序模式，主键不同，二级三级 tie-breaker 也不完全一样：

- `depth`（默认）：主键 `depth` 升序 → 二级 `maxMigrationRatio` 降序 → 三级 `name` 字典序。
- `migration`：主键 `maxMigrationRatio` 降序 → 二级 `depth` 升序 → 三级 `name` 字典序（提示「这个包大部分人都升上去了，就你还卡着」）。
- `latest`：主键 `latestReleasedAt` 降序 → 二级 `depth` 升序 → 三级 `name` 字典序（提示「这个包刚发版，可能值得跟进」）。

注意默认 `depth` 模式跟另外两个的二级 key 不一样——它把 `maxMigrationRatio` 挪到二级，相当于「在浅层里再按迁移比例排一下」。

## 最小原理演示

下面这段脚本演透三件事：**为什么必须先全员累计、再二次扫**；**为什么 catalog 必须先解析**；**为什么 repository URL 相同要跳**。

载体选 TypeScript——本仓库主语言就是 TS，跑一下能直接看到 cohort 的两个阶段是怎么分离的。能跑最好，跑不通也不影响理解。

```ts
import { satisfies, isGreaterThanRange as gtr } from 'verkit'

// --- 演示数据：3 个消费方 + react 的两个已装版本 ---
type Pkg = {
  name: string
  version: string
  spec: string
  depth: number
  repo?: string
  deps: Record<string, string>     // depName → raw range
}

// react 的「仓库 URL」（伪造：假设所有 react 版本都来自 github:foo/bar）
const REACT_REPO = 'github:foo/bar'

const packages: Pkg[] = [
  {
    name: 'app', version: '1.0.0', spec: 'app@1.0.0', depth: 0,
    deps: { react: '^17.0.0' },                       // → 落后于 18.2.0
    // app 自己没填 repo → 兄弟跳过守卫不成立
  },
  {
    name: '@scope/lib-a', version: '1.0.0', spec: '@scope/lib-a@1.0.0', depth: 1,
    repo: REACT_REPO,                                  // 跟 react 共享同一仓库 URL（伪造 monorepo 兄弟）
    deps: { react: '^17.0.0' },                       // → 命中 gtr，但被兄弟跳过
  },
  {
    name: 'lib-b', version: '2.0.0', spec: 'lib-b@2.0.0', depth: 1,
    deps: { react: 'catalog:deps' },                  // → 解析回 ^18.0.0，satisfies 命中
  },
]

// cohort 基线：模拟「已安装」的 react 版本
const installed: Record<string, string[]> = {
  react: ['17.0.0', '18.2.0'],
}

// catalog 表：catalog:deps 里的 react 解析为 ^18.0.0
const catalogs: Record<string, Record<string, string>> = {
  deps: { react: '^18.0.0' },
}

// --- cohort 统计 ---
type Stats = { highest: string; migrated: number; behind: number }
const stats = new Map<string, Stats | null>()

function getStats(depName: string): Stats | null {
  if (stats.has(depName)) return stats.get(depName)!
  const versions = installed[depName]
  if (!versions?.length) { stats.set(depName, null); return null }
  // 这里简化：假设都是 stable。真代码会 filter prerelease。
  const highest = versions.slice().sort()[versions.length - 1]
  const entry = { highest, migrated: 0, behind: 0 }
  stats.set(depName, entry)
  return entry
}

const NON_SEMVER_PREFIX = ['workspace:', 'link:', 'file:', 'npm:', 'git+', 'git:', 'http:', 'https:', 'github:']
function isPlainSemverRange(r?: string): r is string {
  if (!r || r === '*' || r === 'latest' || r === 'x') return false
  return !NON_SEMVER_PREFIX.some(p => r.startsWith(p))
}

function resolveCatalogRange(range: string, depName: string): string | undefined {
  if (!range.startsWith('catalog:')) return range
  const name = range.slice('catalog:'.length) || 'default'
  return catalogs[name]?.[depName]
}

// --- 第一遍：只累加 stats ---
console.log('--- 第一遍：累加 stats ---')
for (const c of packages) {
  for (const [depName, rawRange] of Object.entries(c.deps)) {
    const range = resolveCatalogRange(rawRange, depName)
    if (!isPlainSemverRange(range)) {
      console.log(`[skip  ] ${c.spec} → ${depName}@${rawRange} (非纯 semver)`)
      continue
    }
    const entry = getStats(depName)!
    const note = rawRange !== range ? ` (解析自 ${rawRange})` : ''
    if (satisfies(entry.highest, range)) {
      entry.migrated++
      console.log(`[migr  ] ${c.spec} → ${depName}@${range}${note} 满足最高版 ${entry.highest}`)
    }
    else if (gtr(entry.highest, range)) {
      entry.behind++
      console.log(`[behind] ${c.spec} → ${depName}@${range}${note} 落后于最高版 ${entry.highest}`)
    }
  }
}

// --- 第二遍：基于稳定的 stats 生成 item ---
console.log('\n--- 第二遍：生成 item ---')
for (const c of packages) {
  for (const [depName, rawRange] of Object.entries(c.deps)) {
    const range = resolveCatalogRange(rawRange, depName)
    if (!isPlainSemverRange(range)) continue
    const entry = stats.get(depName)!
    if (gtr(entry.highest, range) !== true) {
      console.log(`[pass  ] ${c.spec} → ${depName} 不命中 gtr，不生成 item`)
      continue
    }
    // 兄弟跳过守卫：两边都有 repo 且相等
    const consumerRepo = c.repo
    const depRepo = REACT_REPO // 真代码里取 highestPkg.resolved.repository?.url
    if (consumerRepo && depRepo && consumerRepo === depRepo) {
      console.log(`[skip  ] ${c.spec} → ${depName} (兄弟包，同仓库 ${consumerRepo})`)
      continue
    }
    const total = entry.migrated + entry.behind
    const ratio = total ? entry.migrated / total : 0
    console.log(`[ITEM  ] consumer=${c.spec} dep=${depName} range=${range} highest=${entry.highest} migrated=${entry.migrated}/${total} ratio=${ratio.toFixed(2)}`)
  }
}
```

跑出来的执行轨迹大概是这样：

```
--- 第一遍：累加 stats ---
[behind] app@1.0.0 → react@^17.0.0 落后于最高版 18.2.0
[behind] @scope/lib-a@1.0.0 → react@^17.0.0 落后于最高版 18.2.0
[migr  ] lib-b@2.0.0 → react@^18.0.0 (解析自 catalog:deps) 满足最高版 18.2.0

--- 第二遍：生成 item ---
[ITEM  ] consumer=app@1.0.0 dep=react range=^17.0.0 highest=18.2.0 migrated=1/3 ratio=0.33
[skip  ] @scope/lib-a@1.0.0 → react (兄弟包，同仓库 github:foo/bar)
[pass  ] lib-b@2.0.0 → react 不命中 gtr，不生成 item
```

注意三件事：

1. **lib-b 的 `catalog:deps` 必须先解析回 `^18.0.0`** 才能进入判定——如果跳过 `resolveCatalogRange`，`catalog:` 前缀会被 `isPlainSemverRange` 排除，整条声明根本不参与计数。
2. **lib-a 在第一遍贡献了 `behind++`**——分母 3 里有它一份；但它在第二遍被兄弟跳过守卫拦住，不会变成 item。
3. **app 这条 item 的 ratio=1/3**——分母 3 是「cohort 内所有有效声明的总和」（migrated + behind），而不是「最终生成 item 的声明数」。这就是「全局口径」的来源。

把这三件事串起来：第一遍累加让分母稳定，第二遍才有「生成 item 还是跳过」的分叉——**计数和生成 item 是分离的，参与计数不等于必须出现在最终清单里**。

## 关键权衡

这一章机制丰富，有 4 条值得复述的权衡。

### 权衡 1：跳过同仓库兄弟，代价是「没填 repository 的包失去这层保护」

**做了什么选择**：消费方和候选包的 `repository.url` 相等时，直接跳过、不生成迁移 item。

**换来了什么**：monorepo 内部 alias（`@scope/a` peer 依赖 `@scope/b` 实为兄弟包）不会被误报成迁移机会。这条非常重要——monorepo 大量用 workspace alias，如果每条都报「该升级 @scope/b」，待办表会被噪声淹没，维护者很快就会对整张表失去信任。

**代价**：`repository` 字段不是 npm 强制要求的。一个包如果没在 `package.json` 里写 `repository.url`，跳过逻辑的双 truthy 守卫就不成立——它会被当作普通第三方包参与判定。结果是**本应被屏蔽的「假迁移机会」会出现在清单上**。

这是一个**信任 npm 元数据完整性的选择**：你赌大多数活跃维护的包都会填 repository（事实上确实如此），冷门或老包可能漏掉，但那部分本来也是噪声较大的部分。

### 权衡 2：只信 stable 版本做基线，代价是「全 prerelease 的依赖被静默跳过」

**做了什么选择**：算 cohort 最高版前先 `filter(p => isStable(p.version))`，把所有 prerelease（alpha/beta/rc）扔掉，只对 stable 排序取末位。

**换来了什么**：迁移建议**永远不会指向一个 alpha/beta**。维护者看到「该升到 18.2.0」时，可以相信 18.2.0 是稳定版，不会一脚踩进不稳版的坑里。这跟第一章定调「主观问题变成数值排序」一脉相承——决策建议必须落在「安全区」。

**代价**：某些前沿依赖（特别是新的 web 框架、新工具链）早期**全是 prerelease**，根本没有 stable 版本。这种依赖整条 `stats.set(depName, null)`、被**静默跳过**——`stats` 里这条记为 null，外部看不到任何提示。

更隐蔽的是：用户看不到「这条依赖被跳过了」，他只会觉得「咦，这个包明明装了，怎么待办表里没出现？」。如果想做对，应当在 UI 层单独展示「全 prerelease 跳过」的清单，但本机制本身没有这个出口。

### 权衡 3：catalog 引用先解析、原始值附带保留，代价是「两条信息必须成对出现」

**做了什么选择**：声明形如 `catalog:foo` 时，先用 `catalogs` 字典查回真实 semver（比如 `^18.2.0`）再走判定；但 item 里同时塞了 `rawRange`（原始的 `catalog:foo`）和 `catalogName`（解析出的 catalog 名）。

**换来了什么**：上层 UI 既能用解析后的 `declaredRange` 做精确的迁移计算，又能给用户显示「这条声明来自 `catalog:deps`，去改 catalog 文件就能改」，而不用逼着维护者去脑补「`^18.2.0` 是从哪来的」。

**代价**：item 现在同时带着 `declaredRange` 和 `rawRange`——两者**必须成对出现**，且只有 `rawRange !== declaredRange` 时 `rawRange` 才有值。任何调用方混淆这两个字段就会算错：比如把 `rawRange`（可能是 `catalog:foo`）当 semver 喂给 `satisfies`，立刻炸。

这种「字段冗余但语义重叠」的设计是一种**接口上的负债**——它把「catalog 机制存在」这个事实信息留在每一个 item 上。如果有更优雅的做法，可能是把 catalog 解析做成一个独立预处理阶段，让 item 永远只看到最终 semver——但那样 UI 就丢失了「这条来自 catalog」的提示能力。

### 权衡 4：两阶段扫包换稳定口径，代价是「双倍扫描成本」

**做了什么选择**：第一轮把每个 depName 的 migrated/behind 计数累加进共享 stats；第二轮再用累计好的 stats 生成可执行 item。

**换来了什么**：每条 item 的 `totalCount` 是**全局口径**而非「自己看到的口径」——前面演示里 lib-a 在第一遍贡献了 behind，lib-b 在第一遍贡献了 migrated，最终 app 的 item 拿到的分母是正确的 3，而不是只看到自己一次。这让迁移比例的语义稳定、可解释：同一 cohort 下所有 item 共享同一个分母。

**代价**：必须遍历**两次** packages。对几百个包的项目无所谓；对超大依赖图（万级节点）来说是双倍扫描成本。

为什么没用「一遍扫、第二遍只补 totalCount」之类的优化？因为「补 totalCount」意味着把已生成的 item 再遍历一遍去回填——本质上还是两遍。不如第一遍纯累加（O(N)、常数小）、第二遍纯生成（O(N)、可以同时做兄弟跳过和 item 构造），逻辑分得清、好测试。

> **本章机制集中**：除了这 4 条核心权衡，DTO 层的「字段重命名 + 引用剥离」、`publint` 作为旁路 action 的并存、分组时的 `latestOnly` 过滤等都是工程化细节，原理上没有新东西，不展开。

## 一条完整的执行轨迹

把演示里的数据再用一张表过一遍，让两条扫描的语义更清楚。

**输入**：3 个消费方 + react 的两个已装版本（`17.0.0`、`18.2.0`），catalog 表 `{ deps: { react: '^18.0.0' } }`。

**第一遍扫描**（累加 stats）：

| 消费方 | raw range | 解析后 | 处理 | 累计结果 |
|---|---|---|---|---|
| app | `^17.0.0` | `^17.0.0` | plain semver，进入判定，gtr 命中 | `behind = 1` |
| @scope/lib-a | `^17.0.0` | `^17.0.0` | plain semver，进入判定，gtr 命中（不查 repo） | `behind = 2` |
| lib-b | `catalog:deps` | `^18.0.0` | 解析后 plain semver，进入判定，satisfies 命中 | `migrated = 1` |

第一遍结束：cohort `react` 的 `highestVersion=18.2.0`、`migrated=1`、`behind=2`、`total=3`。

**第二遍扫描**（生成 item）：

| 消费方 | gtr 命中？ | repo 比较 | 结果 |
|---|---|---|---|
| app | 是 | app 无 repo，守卫不成立 | 生成 item：`migrated=1/3, ratio=0.33` |
| @scope/lib-a | 是 | 两边都 `github:foo/bar`，相等 | **兄弟跳过**，不生成 item |
| lib-b | 否（satisfies 命中） | — | `gtr !== true`，直接 continue |

**最终输出**：一条 dep-upgrade item（consumer=app）。按 consumer 分组后 `app` 这一组的 `maxMigrationRatio=0.33`。

注意 lib-a 和 lib-b 都**没出现在 item 清单里**，但它们对分母的贡献（各 +1）仍然体现在 app 那条 item 的 `totalCount=3` 上。这正是「全局口径」的语义：分母代表整个 cohort，分子代表已经迁过去的部分。

## 同级产物

跟 `computeMaintainerActions` 平级的还有两个兄弟函数，都被 CLI 的 `report` 命令平行调用，但**不属于本机制的原理链条**：

- **重复检测**：按 name 聚合 → 比 `minVersions`（默认 2）→ 按版本数降序。纯计数，不涉及 semver 判定。
- **安装体积测算**：按 bytes 降序 → limit（默认 50）截断 → 默认排除 workspace 包。

三者各自独立、互不依赖，共享的只是「输入一份 packages、输出一份可读报告」这个外部形态。

## 小结

这一章要带走的三件事：

1. **两阶段扫描是迁移比例语义稳定的核心**——第一遍累加、第二遍生成，让分母永远是全局口径。
2. **catalog 解析必须前置**——否则 `catalog:foo` 会被当作非 semver 直接排除，整条依赖消失。
3. **兄弟跳过用两边都为真且相等的守卫**——只在两边都填了 repository 且相等时跳过，赌大多数活跃包都会填这个字段。

这三件事凑在一起，把「该先升哪些依赖」这个主观问题，变成了一个**可批量重跑、不依赖网络、按比例排好的数值表**——维护者只需要看表，不需要再翻 `package.json`。
# 维护者行动算法：迁移比例与 catalog 解析

> 本章属于 composite 层。前置：resolvePackage：把磁盘包变可读节点。
> 学完你能讲清：为什么"该先升谁"这个主观问题被一套 cohort + semver 判定降维成了按比例排序的数值问题，以及为了让这套比例稳定且不引偏，做了哪几个不那么显然的取舍。

## 1. 为什么需要它

上一章给了用户一张能筛能搜的全依赖表——按 license、author、size 任何字段都能挑出关心的子集。可维护者打开这张表时，问的从来不是"挑出哪些"，而是"我该先动哪些"。一个真实工程里几百上千个依赖、每个又拖出一长串传递依赖，同一个 `lodash` 可能并存 4 个版本。维护者真想问的是：哪些已经追上主流、哪些还卡在旧线、按什么顺序处理最划算。

筛和搜答不了这个问题。筛能告诉你"哪些包安装了多个版本"，但说不出"哪条具体声明该改"；搜能定位到一个包名，但定位不到"哪个消费者的哪条依赖声明落后了"。维护者只能挨个翻 `package.json`，肉眼比版本号——这件人肉做的事，就是本章要替他做的事。

这套机制要产出的是一份**按消费方分组的待办清单**：每条记录说"某个消费者、某条依赖声明、目前装的最高版是 X、你声明的是 ^Y、迁移比例是 N%"。维护者按比例从低到高过一遍，就把"该先升谁"答完了。

## 2. 核心思想

把"这条声明该不该升"这个**主观判断**，替换成"在所有同名依赖的最高稳定版基线下，这条声明的范围是被满足还是被超越"——一个**二值判定**。再把成百上千条二值判定按 `depName` 累计，得到 `migrated / total` 这个 0~1 之间的数字。最后维护者不用读 `package.json`，只看一张按这个数字排好的表。

说白了就是换坐标系。原本要回答"值不值得升"——产品决策、技术债权衡、人员偏好混在一起的主观题。改回答"在当前装的所有版本里，这条声明是已经追上最高稳定版、还是落后"：semver 库一行函数能给出的客观题。把主观题投影到客观题，是这套机制唯一的智力内核；后面所有取舍都是为了让这个投影既稳定、又不引偏。

## 3. 心智模型

整套计算围着四张表打转：

- **`versions`**：外部传入的 `Map<depName, PackageNode[]>`——"当前装了哪些包"的全集，同名包会落在同一个数组里。
- **`stats`**：内部维护的 `Map<depName, DepStats | null>`，给每个 depName 算出"最高稳定版"基线，外加 migrated/behind 两个计数器。
- **`items`**：扁平数组，每条是一个待办（`dep-upgrade` 或 `publint`）。
- **`byConsumer`**：分组阶段才有，按消费者的 spec 把 items 重新装进桶。

每个 depName 的 cohort（同声调）基线只算一次：第一次查到这个 depName 时，过滤 prerelease、取 stable 列表的末位作 `highestPkg`；如果一个 stable 版本都没有，stats 直接记 `null`、之后永远跳过。

算法流程大致是五步：

1. 拿到所有已装包，按 `depName` 收拢，过滤 prerelease，取 stable 里版本号最大的那个当 `highestPkg`。
2. 第一遍扫包：对每个消费者的 `dependencies` 和 `peerDependencies`，每条声明先用 catalog 字典（如果传了）解析回真实 semver。解析后是非纯 semver 写法（`*`/`latest`/`workspace:`/`git:` 等）的直接跳。
3. 拿解析后的范围去和 cohort 的 highest 比：能 satisfy 就 `migrated++`，被 highest 超越就 `behind++`，声明比最高版还高的不计入。**这一遍只累加 stats，不生成 item**。
4. 第二遍扫包：同样的遍历，但只用 `isGreaterThanRange` 命中的（即"落后"的）生成 item，每条 item 都带上从 stats 里读出的 `migratedCount`/`totalCount`。这里多一道兄弟跳过：consumer 和 highestPkg 的 `repository.url` 都有值且相等，整条声明静默 continue。
5. 把扁平 items 按 `consumer.spec` 重新分组，每组算 `maxMigrationRatio` 和 `latestReleasedAt`，按 depth / migration / latest 三种模式之一排序输出。

第三步和第四步看起来在做同一件事，但它们必须分开——这是本章最重要、也最不显然的取舍，下面单独展开。

## 4. 关键权衡

### 用「repository URL 相等」当兄弟探测仪，避免 monorepo alias 被误报

pnpm 的 monorepo 里，`@scope/app-a` 依赖 `@scope/lib-b` 是常见写法。`lib-b` 既可能是发布到 npm 的独立包，也可能是 monorepo 内部的 alias（指向 `workspace:*` 或某个固定版本）。如果它们恰好都装在同一份 `node_modules` 里、且 `lib-b` 又同时存在两个版本——单看名字和版本，算法会把它当成"一个真实的迁移机会"，但其实这只是 monorepo 兄弟互相引用，根本不算技术债。

选择是：**只要 consumer 和 candidate 的 `resolved.repository.url` 都有值且相等，就跳过这条 item**。换来的是 monorepo 内部引用永远不会被推到升级清单上——这正是维护者想看到的。代价是 `repository` 是 `package.json` 的可选字段，没填的包拿不到这层保护，会产生一些本应被屏蔽的"假迁移机会"。注意这里用的是"双 truthy 守卫"：必须两边都有 URL、且相等才跳过；只要一边缺，就老老实实落回判定。

这条化解的本质矛盾是：**"两包同源" vs "两包同名同版本差"**——单看包名和版本号区分不了兄弟和真实版本差，必须靠 `repository.url` 这个外部归属信号做交叉验证。读者一旦抓住这个矛盾，在 npm/yarn/pnpm 之外的任何"按 name 比对版本"的场景（Python 的 `pkg-resources`、Go 的 `go.mod` replace 指令、Rust crate 的 path dependencies）都能套用同一个解法——找一个外部归属字段做交叉验证。

### 只用 stable 版本做"最高版"基线，永远不把用户引向 prerelease

最高版基线决定了"落后"的判定阈值。如果直接取所有版本里 semver 最大的——很多流行库的"最新版"会是 `4.0.0-alpha.3`。算法会建议所有写 `^3` 的消费者"升到 4"，但实际上 4 还没发稳定版，照着改的人会一头撞进"上游其实还没稳定"的坑。

选择是：**先 filter 掉 prerelease，再取 stable 列表的末位作为 highestPkg**。换来的是迁移建议永远不会指向一个 alpha/beta/rc。代价是某个依赖"全是 prerelease"（早期项目、固定 tag 发布）时，整个 depName 的 stats 记为 `null`、被静默跳过——维护者在清单里完全看不到它的存在，既不知道它落后、也不知道它存在。

本质上化解的矛盾是：**"该用最新版做基线（语义最准）" vs "最新版可能不稳（误导用户）"**。权衡偏向保守——宁可漏报，不可误推。这个矛盾在所有"自动建议升级"的系统里都会出现：Dependabot、Renovate、IDE 的依赖提示——它们各自用"白名单 major"、"等待 X 天"、"用户配置"等不同方式回答同一个问题，但底层矛盾只有一个：**新 ≠ 稳**。

### catalog 引用先解析回真实 semver，原始值仅作附带信息保留

pnpm 9 引入了 `catalog:` 协议：monorepo 里所有子包写 `react: "catalog:react-18"`，真实的 `^18.2.0` 只在根 `pnpm-workspace.yaml` 里维护一份。这对工程是好事（单点改），但对算法是麻烦——`catalog:react-18` 不是合法 semver 范围，直接拿去 `satisfies` 必抛错。

选择是：**每条声明先用 `catalogs` 字典解析回真实 semver 再走判定，但 `rawRange` 和 `catalogName` 字段仍然随 item 返回**。换来的是上层 UI 既能拿解析后的 `declaredRange` 做数学计算，又能给用户显示"这条声明来自 `catalog:react-18`"——用户改的时候知道去根目录改、不是去子包改。代价是同一条记录上始终并存着两份信息（`declaredRange` vs `rawRange`），调用方混淆就会算错——比如有人误以为 `declaredRange` 是 raw、用错字段去做 `satisfies`，结果就是 catalog 路径完全失效。

本质矛盾：**"工程层用语义引用（catalog:foo）" vs "判定层只认字面量（^18.2.0）"**——两个抽象层各自合理，但跨层时必须做一次翻译，并且翻译痕迹要在结果里留痕，否则 UI 无法回溯。这条矛盾在所有"声明性引用 + 字面量判定"的系统里都存在：kustomize 的 `nameReference`、Helm 的 `values.yaml` 引用、Terraform 的 module output——它们都要在某个点上把语义引用解析回字面量，又都要在结果里同时保留两者。

### 两阶段扫包：先全员累计 stats，再二次扫生成 item

这是整套机制最不显然的取舍。第一遍扫包时，每条 dep 声明在 cohort 里的判定是独立的——理论上可以一边判定、一边直接生成 item。源码却偏要分两轮：第一轮只把 migrated/behind 累加进 stats，第二轮才基于稳定的 stats 生成 item。

选择是：**强制两阶段**，第二轮生成 item 时，每条 item 上的 `totalCount = migrated + behind` 必须是**全局口径**——即"整个项目里、这个 depName 一共有多少条声明参与了判定"，而不是"我这条 item 自己看到的局部口径"。换来的是迁移比例的语义稳定：50% 就是 50%，无论这条 item 在数组的哪个位置、无论消费者遍历顺序怎么变。如果只扫一遍，每条 item 的 totalCount 只能基于"截至当前已扫到的部分"，比例会随扫包顺序漂移——同一份输入因为消费者顺序不同给出不同比例，这是不可接受的。

代价是对超大依赖图来说是双倍扫描成本（两次完整遍历 `dependencies` 和 `peerDependencies`）。本质矛盾：**"判定是逐条独立的（一遍即可）" vs "比例是全局口径的（必须先累计再生成）"**——单条判定的正确性一遍就能得到，但"比例"这个聚合量的正确性需要全局视野。这条矛盾在所有"既要单点判定、又要全局聚合"的系统里都出现：SQL 的 window function、流处理的 two-pass aggregate、编译器的符号解析——它们都分两遍走，原因都一样：**聚合量的正确性，要求它必须在数据齐备时才被计算**。

## 5. 最小原理演示

下面这段约 50 行的脚本只演透三件事：**为什么必须两阶段**（item 的 totalCount 才稳定）、**为什么必须先 catalog 解析**（否则 `catalog:foo` 会被当作非纯 semver 直接排除）、**为什么 repository URL 相同要跳**（避免 monorepo 兄弟被误报）。能直接 `node --experimental-strip-types` 跑。

```ts
import { satisfies, isGreaterThanRange, compare } from 'verkit'

interface Pkg {
  name: string
  version: string
  spec: string
  repoUrl?: string
  deps: Record<string, string>     // dependencies + peerDependencies 合并演示
}

// 演示用：粗略判 prerelease（真实实现用 verkit.getPrerelease === null）
const isStable = (v: string) => !/-/.test(v)

// 第一阶段：按 depName 聚 cohort，过滤 prerelease 取最高 stable
function buildStats(packages: Pkg[]) {
  const byName = new Map<string, Pkg[]>()
  for (const p of packages) {
    if (!byName.has(p.name)) byName.set(p.name, [])
    byName.get(p.name)!.push(p)
  }
  const stats = new Map<string, { highest: Pkg, migrated: number, behind: number } | null>()
  for (const [name, list] of byName) {
    const stable = list.filter(p => isStable(p.version))
    if (!stable.length) { stats.set(name, null); continue }
    stable.sort((a, b) => compare(a.version, b.version))
    stats.set(name, { highest: stable.at(-1)!, migrated: 0, behind: 0 })
  }
  return stats
}

// catalog 解析：catalog:foo → 真实 semver；否则原样返回
function resolveCatalog(
  range: string,
  depName: string,
  catalogs?: Record<string, Record<string, string>>,
): string | undefined {
  if (!range.startsWith('catalog:')) return range
  const name = range.slice('catalog:'.length) || 'default'
  return catalogs?.[name]?.[depName]
}

// isPlainRange：排除 *、latest、各种协议前缀
function isPlainRange(r?: string): r is string {
  if (!r || r === '*' || r === 'latest') return false
  return !['workspace:', 'link:', 'file:', 'npm:', 'git+', 'git:', 'http:', 'https:', 'github:']
    .some(p => r.startsWith(p))
}

// 两阶段主算法
function computeActions(packages: Pkg[], catalogs?: Record<string, Record<string, string>>) {
  const stats = buildStats(packages)

  // 第一阶段：全员累计，不生成 item
  for (const c of packages) {
    for (const [depName, rawRange] of Object.entries(c.deps)) {
      const range = resolveCatalog(rawRange, depName, catalogs)
      if (!isPlainRange(range)) continue
      const s = stats.get(depName)
      if (!s) continue
      if (satisfies(s.highest.version, range)) s.migrated++
      else if (isGreaterThanRange(s.highest.version, range)) s.behind++
    }
  }

  // 第二阶段：基于稳定 stats 生成 item，totalCount 是全局口径
  const items = []
  for (const c of packages) {
    for (const [depName, rawRange] of Object.entries(c.deps)) {
      const range = resolveCatalog(rawRange, depName, catalogs)
      if (!isPlainRange(range)) continue
      const s = stats.get(depName)
      if (!s || isGreaterThanRange(s.highest.version, range) !== true) continue
      // 兄弟跳过的双 truthy 守卫：两边 repository URL 都得有、且相等
      if (c.repoUrl && s.highest.repoUrl && c.repoUrl === s.highest.repoUrl) continue
      const total = s.migrated + s.behind
      items.push({
        consumer: c.spec,
        depName,
        declaredRange: range,
        rawRange: rawRange === range ? undefined : rawRange,
        installedHighest: s.highest.version,
        migratedCount: s.migrated,
        totalCount: total,
        migrationRatio: total ? s.migrated / total : 0,
      })
    }
  }
  return items
}
```

跑下面这段，三种结局各演一次：被收编进 cohort / 因兄弟同仓库被跳 / 因非纯 semver 被排除。

```ts
const pkgs: Pkg[] = [
  { name: 'app', version: '1.0.0', spec: 'app@1.0.0',
    deps: { react: '^17.0.0' } },
  { name: 'react', version: '17.0.0', spec: 'react@17.0.0',
    repoUrl: 'github:facebook/react', deps: {} },
  { name: 'react', version: '18.2.0', spec: 'react@18.2.0',
    repoUrl: 'github:facebook/react', deps: {} },
  // @fb/lib-a 与 react 共享 repoUrl，是 monorepo 兄弟。它也声明 ^17.0.0、
  // 也会在第一遍被 gtr 命中——但它在第二遍的 item 会被兄弟跳过。
  // 注意：第一遍的 behind 计数仍然算上它（这就是全局口径的来源）。
  { name: '@fb/lib-a', version: '1.0.0', spec: '@fb/lib-a@1.0.0',
    repoUrl: 'github:facebook/react', deps: { react: '^17.0.0' } },
  // lib-b 声明 *，被 isPlainRange 直接排除
  { name: 'lib-b', version: '2.0.0', spec: 'lib-b@2.0.0',
    deps: { react: '*' } },
]

console.log(computeActions(pkgs))
// 唯一输出：
// { consumer: 'app@1.0.0', depName: 'react', declaredRange: '^17.0.0',
//   installedHighest: '18.2.0', migratedCount: 0, totalCount: 2, migrationRatio: 0 }
// 注意 totalCount=2：lib-a 的 behind 在第一遍被算进去了，
// 但 lib-a 自己的 item 在第二遍被兄弟跳过——总数和 item 数对不上的"矛盾"，
// 正是两阶段扫包换来的"全局口径稳定"。
```

## 6. 执行轨迹

把上面的演示数据走一遍，看每一步内部状态怎么变。

**初始**：5 个 Pkg 进 `buildStats`。`byName` 收拢出 4 个桶：`app`、`react`（2 个版本）、`@fb/lib-a`、`lib-b`。stable 过滤后都通过（没有 prerelease）。`stats` 此时长这样：

```
stats = {
  app:       { highest: app@1.0.0,       migrated: 0, behind: 0 },
  react:     { highest: react@18.2.0,    migrated: 0, behind: 0 },
  @fb/lib-a: { highest: @fb/lib-a@1.0.0, migrated: 0, behind: 0 },
  lib-b:     { highest: lib-b@2.0.0,     migrated: 0, behind: 0 },
}
```

`react` 桶有两个版本，按 semver 排序后 `[17.0.0, 18.2.0]`，取末位 `18.2.0` 作 highest。

**第一遍扫包**（按数组顺序：app → react@17 → react@18.2 → lib-a → lib-b）：

- `app.deps.react = '^17.0.0'` → isPlainRange 通过 → stats.react 存在 → `satisfies('18.2.0', '^17.0.0')` 返回 false → `isGreaterThanRange('18.2.0', '^17.0.0')` 返回 true → `behind++`。stats.react 变成 `{ migrated: 0, behind: 1 }`。
- `react@17.deps = {}`、`react@18.2.deps = {}` → 都没贡献。
- `@fb/lib-a.deps.react = '^17.0.0'` → isPlainRange 通过 → `satisfies` false → `isGreaterThanRange` true → `behind++`。stats.react 变成 `{ migrated: 0, behind: 2 }`。注意这里**没有任何 sibling 检查**——第一遍只管累加。
- `lib-b.deps.react = '*'` → isPlainRange false → 跳。

**第一遍结束**时 stats.react = `{ highest: 18.2.0, migrated: 0, behind: 2 }`，totalCount 在此时已经定下来是 2。第一遍**没有**生成任何 item。

**第二遍扫包**（同样的遍历）：

- `app.deps.react = '^17.0.0'` → isGreaterThanRange 命中（true）→ 检查 repository URL：`app.repoUrl` 是 undefined，双 truthy 守卫不成立 → 不跳 → push item。从 stats 读出 `totalCount = 0+2 = 2`、`migratedCount = 0`、`migrationRatio = 0/2 = 0`。
- `@fb/lib-a.deps.react = '^17.0.0'` → isGreaterThanRange 命中（true）→ 检查 repository URL：`lib-a.repoUrl = 'github:facebook/react'`、`stats.react.highest.repoUrl = 'github:facebook/react'`，两边都有值且相等 → **跳过**，不 push item。
- `lib-b.deps.react = '*'` → isPlainRange false → 跳。

**输出**：一条 item，`migrationRatio = 0`、`totalCount = 2`。

如果只扫一遍，`app` 在前会得到 `totalCount=1`（只算到 app 自己），`lib-a` 在后会得到 `totalCount=2`（算到了 app 和 lib-a）——同一条 react 的迁移比例会因为扫到的时间点不同而漂移。两阶段扫包消除了这个漂移：每条 item 看到的 totalCount 都是稳定的全局值。

这里有个微妙之处值得点一下：lib-a 的 behind 计数被算进了 stats，但 lib-a 自己的 item 被兄弟跳过——所以**总 item 数（1）和 totalCount（2）对不上**。这不是 bug，是全局口径的代价：cohort 统计和 item 生成是两套独立的判定，第一遍不挑食、第二遍才筛。维护者在 UI 上看到 totalCount=2 时，要理解这个"2"是"全项目范围内 react 的 dep 声明数"，而不是"会被推荐的待办数"。

## 7. 教学简化说明

本章演示故意省略了：publint 作为另一种 action 类型（与 dep-upgrade 并存于同一 items 数组，是"顺路打包送给 UI"的旁路）；DTO 层（把 Group 内部的 PackageNode 引用展平成字符串，仅为跨 RPC 序列化）；三种排序模式切换、authors 聚合、`latestOnly` 过滤、limit 截断等工程化逻辑。这些都不影响 cohort + 判定 + 兄弟跳过这条原理主线。

## 8. 小结

这一章算的全是"已经装在本地的版本之间的相对关系"——cohort 的 highest 来自本地 `node_modules`，迁移比例来自本地 `package.json` 声明，全程没碰一次网络。它回答了"基于现状，我该先动哪些"，但回答不了"上游是否已经发得更高、是否已被爆漏洞"。下一章就把这两个外部维度补上——按 batch 拉 npm registry、按包年龄算 TTL 缓存、顺手把漏洞数据并进来——让维护者的清单从"装了的相对位置"扩展到"上游和安全的绝对信号"。
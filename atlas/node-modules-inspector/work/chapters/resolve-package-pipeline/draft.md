# resolvePackage：把磁盘包变可读节点

## 起点：刚物化完的节点是个干骨架

想象你刚把一个项目的依赖图跑通：你拿到了 lodash@4.17.21、express@4.18.2、react@18.3.1 ……几万个节点，每个节点都知道自己叫啥、版本号、磁盘在哪儿、依赖谁、被谁依赖。这套字段可以拿来做依赖树画图、做依赖闭包查询，已经够好用了。

但只要你想在前端给用户多展示一点点东西——「这包是 CommonJS 还是 ESM？」「作者是谁？」「仓库地址给个链接」「安装体积多大」「协议是 MIT 还是 GPL」——你就会发现眼前这个节点啥都答不上来。

干骨架缺的是给**人**看的富信息。

富信息不会从天上掉下来——它在磁盘上每个包目录里的 `package.json` 里躺着。把这块从磁盘里捞出来、规整成统一形态，再挂回到原来那个骨架上——这就是 `resolvePackage` 这道工序干的活。

注意「挂回」这两个字。本章最大的设计选择就在这里：**不重建对象，直接在原对象上贴字段**。

## 类型分三层：身份、闭包、富信息

你已经拿到一个有骨架+闭包字段的节点，下一步要给它长出富信息。但这个「长出」不是凭空发生——节点对象从无到有走了三道工序，每道工序加一类字段。类型上对应三层 extends：

```ts
// 第一层：身份。这是「谁」
interface PackageNodeRaw {
  name: string
  version: string
  spec: string          // 形如 lodash@4.17.21
  filepath: string      // 磁盘绝对路径
}

// 第二层：闭包。这是「依赖关系」
interface PackageNodeBase extends PackageNodeRaw {
  dependencies: Set<PackageNodeBase>     // 我直接依赖谁
  flatDependencies: Set<PackageNodeBase> // 我的全部子孙（递归）
  dependents: Set<PackageNodeBase>       // 谁直接依赖我
  flatDependents: Set<PackageNodeBase>   // 我的全部祖先
  depth: number
}

// 第三层：富信息。这是「给展示用的」
interface PackageNode extends PackageNodeBase {
  resolved: {
    module: 'cjs' | 'esm' | 'dual' | 'faux' | 'dts' | 'unknown'
    packageJson: object
    installSize?: { bytes: number; categories: Record<string, number> }
    authors?: Author[]
    repository?: { url: string }
    license?: string
    fundings?: { url: string; type?: string }[]
    // 下面这三个字段本章不填，留给后续阶段
    npmMeta?: NpmMeta
    npmMetaLatest?: NpmMetaLatest
    publint?: PublintMessage[]
  }
}
```

说人话就是：身份层只够回答「这是谁」；闭包层多了「依赖关系」；只有富信息层出现 `resolved`——里面才装着前端要展示的东西。

注意 `resolved` 上面那一堆可选字段（`installSize?`、`npmMeta?`、`publint?`）——这是「按需慢慢挂」的留口。本章只负责填前面 7 个，后面那 3 个留给后续阶段（npm registry 拉取、publint 检查）补。

类型上分三层有个直接好处：下游函数可以按需 narrow。做依赖图遍历的代码，参数声明成 `PackageNodeBase` 就行——它根本不需要知道 `resolved` 存不存在；只有做展示的代码才声明成 `PackageNode`。类型即文档。

代价是？代价是每道工序都得告诉编译器「我下一步要给这对象升格」，下一节就看到这点。

## resolvePackage 干的事

先把骨架函数放出来，再逐句解释：

```ts
async function resolvePackage(
  pkg: PackageNodeBase,
): Promise<PackageNode> {
  // 第 1 步：把类型从 Base 升格到 Node——打欠条
  const _pkg = pkg as unknown as PackageNode

  // 第 2 步：幂等守门
  if (_pkg.resolved) return _pkg

  // 第 3 步：定位 package.json
  const path = join(pkg.filepath, 'package.json')

  // 第 4 步：文件不存在 → 静默降级
  if (!existsSync(path)) {
    _pkg.filepath = ''
    _pkg.resolved = { module: 'unknown', packageJson: {} }
    return _pkg
  }

  // 第 5 步：读文件，剥 BOM，解析 JSON
  const content = await readFile(path, 'utf-8')
  const json = JSON.parse(stripBomTag(content))

  // 第 6 步：算 7 个字段，全部挂到 resolved
  _pkg.resolved = {
    module:      analyzeModuleType(json),
    packageJson: pickAllowedKeys(json),
    installSize: await measureInstallSize(_pkg),
    authors:     parseAuthors(json),
    repository:  parseRepository(json),
    license:     parseLicense(json),
    fundings:    parseFundings(json),
  }

  return _pkg
}
```

### 双重断言：把 Base 升格成 Node 的「欠条」

函数签名收的是 `PackageNodeBase`，返回的是 `PackageNode`。中间的类型转换不能靠 `as PackageNode`——TS 会拒绝，因为 `PackageNode` 的 `resolved` 字段是必填的，而 `Base` 上根本没有。所以走的是 `as unknown as PackageNode` 这条更暴力的通道：先把类型擦到 `unknown`，再断言成目标。

这条 `as unknown as` 在告诉编译器：「我承诺在返回之前，一定会把 `resolved` 字段填好。」所以叫**打欠条**。

欠条好不好兑现，TS 不再检查——全靠你函数体里自己保证。如果你写了 `_pkg.resolved = {...}` 之后再访问 `_pkg.resolved.module`，没事；但如果你不小心在赋值之前先访问了 `_pkg.resolved.foo`，运行时崩，TS 静默放行。这是 mutate + 类型演化这套设计的内生代价——编译器放手，运行时兜底。

### 幂等守门：同一个包可以重复 resolve

第一行 `if (_pkg.resolved) return _pkg`。意思很直白：如果这个包之前已经被 resolve 过（`resolved` 已挂），直接返回，不重复读磁盘。

这在生产里很重要。`node_modules` 里同一个对象会被 storage 层缓存、可能被多次重新触发解析、可能在「先 list 再补 npmMeta」的多阶段流水线里来回穿过。幂等守门让流水线对重复调用是安全的——成本只有一次属性读取。

幂等隐含了一个契约：你不能绕过守门然后重新调。比如有人手贱在已经 resolve 过的对象上把 `_pkg.resolved = undefined` 删掉再调一次，函数会重新读磁盘；如果 `_pkg.filepath` 之前被静默降级清空过，再调一次 `join('', 'package.json')` 会拼成相对路径 `package.json`，去读 cwd 下的同名文件——这是未定义行为。**幂等是契约的一部分**，别绕过它。

### 静默降级：optional 包没装上不抛错

optional dependencies 是 npm/pnpm 里的一种「装不上就算了」的依赖——典型的比如平台专用的 native 包（fsevents on macOS、某 windows-something on win）。这些包在 Linux 上不会装，磁盘上根本没目录，但仍然会出现在依赖图里。

如果遇到这种情况直接 `throw new Error(...)`，整个流水线就废了——本来该装上的都装了，就因为一个 optional 没装上，整个分析退场，太脆。

所以代码走的是不抛、不退场的分支：

```ts
if (!existsSync(path)) {
  _pkg.filepath = ''
  _pkg.resolved = { module: 'unknown', packageJson: {} }
  return _pkg
}
```

代价是下游必须显式处理 `'unknown'` 这个状态分支：模块类型筛选、目录计算、展示，都要为 `'unknown'` 留一个独立分支。`filepath` 被清空成空字符串也是一个全栈都要感知的哨兵值——「这个节点磁盘上没有，是幽灵」。

### 7 个字段挂载，其中 1 个是异步

文件读到、JSON 解析完，下一步就是把这 7 个字段塞到 `_pkg.resolved`：

| 字段 | 怎么算 | 是否异步 |
|------|--------|----------|
| `module` | 看 `exports`/`module`/`type` 等字段推断 | 同步纯函数 |
| `packageJson` | 白名单裁剪约 25 个允许字段 | 同步 |
| `installSize` | 递归遍历目录按后缀分类累加字节 | **异步（fs I/O）** |
| `authors` | 解析 `author`/`authors` 字段 | 同步 |
| `repository` | 解析 `repository` 字段 | 同步 |
| `license` | 解析 `license` 字段 | 同步 |
| `fundings` | 解析 `funding`/`fundings` 字段 | 同步 |

注意这 7 步在代码里是**顺序执行**的，没 `Promise.all`。直觉上「7 步互不依赖，应该并行」——但实际不需要：6 步是纯同步操作，微秒级；唯一异步的是 `installSize`，那个真要扫目录，会做 fs I/O。把它们 `Promise.all` 起来反而引入 microtask 调度开销，得不偿失。

真正的并发应该发生在**包与包之间**——见下一节。

## 外层并发，内层串行

光看单个 `resolvePackage` 不够，还要看它在 orchestrator 里怎么被批量调用：

```ts
async function listPackageDependencies(options) {
  const pm = await getPackageManager(options)
  // ↓ 又一处「先转后填」的欠条
  const result = await listPackageDependenciesRaw(pm, options)
    as ListPackageDependenciesResult

  const limit = pLimit(10)
  await Promise.all(
    Array.from(result.packages.values())
      .map(pkg => limit(() => resolvePackage(pkg)))
  )
  return result
}
```

`pLimit(10)` 是个并发限流器——最多 10 个 `resolvePackage` 同时在跑。10 是个经验值，刚好压满磁盘 I/O 而不爆事件循环。

注意这里又出现一处 `as ListPackageDependenciesResult` 的强转——它发生在 `await Promise.all` **之前**。在那一刻，`result` 里每个 Map 值的实际类型还是 `PackageNodeBase`（只有骨架+闭包字段），但代码已经把它当 `PackageNode` 用了。

这种「先转后填」的写法是 mutate 哲学的直接体现：类型表达的是「这一刻我想象它已经是的样子」，运行时再去兑现。兑现的动作就是下一行的 `Promise.all(...resolvePackage...)`——跑完之后，每个值都真的有 `resolved` 字段了。

## 关键权衡（本章核心）

这一节是本章最该读的地方。前面所有机制都是为这几条权衡服务的。

### 权衡 1（核心）：mutate 而非重建，换零拷贝

**做了什么**：直接在传入的 `PackageNodeBase` 对象上挂 `resolved` 字段，返回同一引用。不新建对象、不复制原对象。

**换来什么**：对几万节点的依赖图来说，零拷贝意味着内存峰值不翻倍。前端用 Vue/Pinia 这种 reactive 系统时，对象引用稳定意味着不会因为 resolve 触发整树重渲——幂等守门 + 同一引用 = 重复调用一次啥都不发生。

**代价**：调用方必须接受「同一对象在不同阶段字段会变」这个事实。今天拿到的是骨架，明天再读发现 `resolved` 长出来了。更要命的是，为了在 TS 里描述这种「承诺稍后填齐」的暂时性不一致，函数必须用 `as unknown as PackageNode` 这条暴力通道，编译器对中间代码不再做检查——欠条要你自己兑现。

### 权衡 2：类型分三层，换每道工序的清晰边界

**做了什么**：`PackageNodeRaw`（身份）→ `PackageNodeBase extends Raw`（+ 闭包）→ `PackageNode extends Base`（+ `resolved`），三层各自对应一道工序。

**换来什么**：每道工序的输入输出类型边界清晰。依赖图遍历的代码声明参数为 `PackageNodeBase`，展示代码声明为 `PackageNode`，工具提示精确。下游函数一眼能看出「这函数需要 resolve 完才能调」。类型即文档。

**代价**：流水线节点函数必须用双重断言（`as unknown as`）先把自己升格成最终类型，本质上是在向编译器「打欠条」——欠条的正确性由运行时的字段填充逻辑保证，TS 不再帮你查。

### 权衡 3：外层并发 10、内层串行，换 fs I/O 的合理扇出

**做了什么**：`pLimit(10)` 在 orchestrator 层限流，单个 `resolvePackage` 内部 7 步顺序跑。

**换来什么**：把宝贵的并发额度花在真正的瓶颈（fs I/O 的目录递归）上，而不是浪费在微秒级的同步操作上。10 个目录同时递归刚好压满磁盘而不爆事件循环——再高就会让其他 RPC 请求等不到 CPU。

**代价**：单个包的总耗时 = 7 步之和（其中 6 步微秒级，1 步是 fs I/O）。整体流水线的吞吐瓶颈永远是 fs I/O，不是 CPU——这意味着 SSD vs HDD 的差距在这套设计上会被放大。

### 权衡 4：静默降级而非抛错，换 optional 包的容错

**做了什么**：optional 依赖没装上时，不抛、不退场，把 `filepath` 清空、`module` 标 `'unknown'`、`packageJson` 设空对象。

**换来什么**：流水线对 optional / 缺失包完全容错。一个 macOS 专用包在 Linux 项目里被列为 optional，没装上，依赖图照样跑得通——前端会看到一个 module 为 `'unknown'` 的幽灵节点，用户可以选择忽略或筛选掉。

**代价**：下游必须显式处理 `'unknown'` 这个状态分支。模块类型筛选、目录计算、UI 展示，都要为它留分支。`filepath = ''` 这个哨兵值也要全栈感知——任何用 `filepath` 去做 fs 操作的代码都得先判空。

## 原理演示：跑通整个流程

下面这段是一个能直接用 `bun run demo.ts` 或 `npx tsx demo.ts` 跑起来的最小骨架。它故意把所有「真实」的东西（7 个字段解析函数、目录递归、BOM 处理）都换成占位实现——目的是让你看清**类型演化、双重断言、mutate、幂等、静默降级**这套机制，而不是被具体业务逻辑分心。

```ts
// demo.ts —— resolvePackage 流水线最小骨架
// 跑法：bun run demo.ts  或  npx tsx demo.ts

// ─── 类型分层：身份 → 闭包 → 富信息 ──────────────
interface PackageNodeRaw {
  name: string
  version: string
  filepath: string
}

interface PackageNodeBase extends PackageNodeRaw {
  dependencies: Set<PackageNodeBase>
  depth: number
}

interface PackageNode extends PackageNodeBase {
  resolved: {
    module: 'cjs' | 'esm' | 'unknown'
    packageJson: Record<string, unknown>
    installSize?: number
  }
}

// ─── 假装做字段解析的 stub（真实代码里是 analyzeModuleType 等） ──
function fakeAnalyzeModuleType(_json: Record<string, unknown>) {
  return Math.random() > 0.5 ? 'esm' as const : 'cjs' as const
}
function fakeMeasureSize(_path: string) {
  return Promise.resolve(Math.floor(Math.random() * 100000))
}

// ─── 核心工序：把 Base 升格为 Node ───────────────
async function resolvePackage(pkg: PackageNodeBase): Promise<PackageNode> {
  // 双重断言：先承诺「我会填好 resolved」
  const _pkg = pkg as unknown as PackageNode

  // 幂等守门
  if (_pkg.resolved) return _pkg

  // 静默降级：filepath 空就走幽灵分支
  if (!pkg.filepath) {
    _pkg.resolved = { module: 'unknown', packageJson: {} }
    return _pkg
  }

  // 正常分支：模拟读 + 解析 + 挂字段
  const json = { name: pkg.name, type: 'module', author: 'someone' }
  _pkg.resolved = {
    module: fakeAnalyzeModuleType(json),
    packageJson: json,
    installSize: await fakeMeasureSize(pkg.filepath),
  }
  return _pkg
}

// ─── orchestrator：外层并发（这里用 Promise.all 简化） ──
async function resolveAll(pkgs: PackageNodeBase[]) {
  await Promise.all(pkgs.map(p => resolvePackage(p)))
}

// ─── 跑一下，看 mutate 的效果 ─────────────────
async function main() {
  const before: PackageNodeBase = {
    name: 'lodash',
    version: '4.17.21',
    filepath: '/abs/node_modules/lodash',
    dependencies: new Set(),
    depth: 1,
  }
  const refBefore = before

  await resolvePackage(before)

  console.log('after resolve, before.resolved =', before.resolved)
  console.log('Object.is(before, refBefore) =', Object.is(before, refBefore))   // true
  console.log('Object.is(before, await resolvePackage(before)) =',
    Object.is(before, await resolvePackage(before)))                            // true（幂等）

  // 静默降级：filepath 为空
  const ghost: PackageNodeBase = {
    name: 'fsevents',
    version: '2.3.0',
    filepath: '',
    dependencies: new Set(),
    depth: 2,
  }
  await resolvePackage(ghost)
  console.log('ghost.module =', ghost.resolved.module)                          // 'unknown'

  // 顺便跑一下批量
  await resolveAll([before, ghost])
}

main()
```

跑完你会看到三件事，每一件都对应本章一个原理点：

1. `Object.is(before, refBefore) === true` —— 返回的是同一引用，没新建对象。这就是 mutate 契约最直接的证据。
2. 第二次调 `resolvePackage(before)`，函数体第一行就 return，不重读磁盘——幂等守门在工作。
3. `ghost.resolved.module === 'unknown'` —— 文件不存在分支走的是静默降级，不抛错。

如果你想感受 mutate 的力量，把 `await resolvePackage(before)` 改成 `const after = await resolvePackage(before); console.log(Object.is(before, after))`——结果还是 `true`。这正是整套工具能扛几万节点不爆内存的关键。

## 收束：mutate 是流水线的底色

整个章节其实只讲了一件事：**对象不重建，按工序渐进挂字段**。

这一句话撑起了所有机制：类型为什么要分三层（每道工序对应一层）、为什么要双重断言（描述「承诺稍后填齐」的暂时性不一致）、为什么要幂等守门（mutate 不能重复执行有副作用的步骤）、为什么要静默降级（mutate 不能让一个失败拖垮全图）、为什么外层并发内层串行（mutate 的瓶颈是 fs I/O 不是 CPU）。

`resolved` 上的字段是「部分填充」——本章填 7 个，后面还有 npm registry 拉取填 3 个。渐进挂载、部分填充——这就是把 mutate 哲学推到底后的自然产物。

理解了这套机制，再看下游的过滤器、action 算法、可视化，你会发现一件有趣的事：**所有下游消费者拿到的都是同一个对象引用**，只不过在不同的执行阶段，对象上的字段数量不一样。这种「字段会随时间生长」的对象，是这套工具全栈能跑得动的隐含契约。
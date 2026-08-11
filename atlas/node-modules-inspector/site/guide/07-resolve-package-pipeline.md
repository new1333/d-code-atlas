# resolvePackage：把磁盘包变可读节点

> 本章属于 composite 层。前置：包管理器策略、依赖图物化、静态推断模块类型、安装体积测算、package.json 字段规范化。
> 学完你能用一句话讲清：为什么这条流水线选择"同一对象渐进喂字段"而不是"每道工序新建一份"，以及换来什么、付出什么。

## 1. 为什么需要它

上一章我们写完了 `normalizePkgAuthors`、`normalizePkgRepository` 这一组归一化函数——它们各自能从一份 `package.json` 里抽出干净整齐的作者/仓库/协议/赞助。但归一化函数本身只是被动的："你给我 JSON，我给你结果"。没有人主动调它们。

更关键的是，前面几章走完后，依赖图长这样：每个节点只有 `name`、`version`、`spec`、`filepath`、`dependencies` 这套骨架字段（外加第 3 章物化阶段补上的 `flatDependencies`/`depth`/`shallowestDependent` 这套闭包字段）。一个节点拿在手里，你只知道它叫 lodash 4.17.21、住在磁盘哪个目录、依赖谁——但它到底是 cjs 还是 esm？谁写的？多大？什么协议？有没有官方仓库链接？一无所知。前端拿到这种节点什么都展示不出来。

需要一个工序把这些"给人看的信息"从磁盘上的 `package.json` 里抽出来、规整成统一形态，挂回到同一个节点对象上。这就是 `resolvePackage` 干的事。

这件事听起来不难：读个 JSON、调一组函数、挂结果，写完不就完了？难就难在量大、且不能重建对象。一个大型 monorepo 的依赖图动辄几万个节点，每个节点都已经被前端 reactive 系统引用着（地图上每个色块都指着它）。如果你每解析一个就 new 一个新对象返回，整个图都要重渲一遍。所以这条流水线做了一个看似奇怪的决定：**永远不返回新对象，所有字段直接 mutate 到入参上**。

## 2. 核心思想

把整条流水线想成一条传送带：节点从一头进来，沿途经过几个工位，每个工位给它加一点东西，但节点本身（那个对象引用）从头到尾没换过。前几章的工位给它身份字段和依赖闭包；本章这个工位给它富信息（也就是 `resolved` 子对象）；后续章节的工位（npm 元信息拉取、publint 检查）会再往 `resolved` 里补字段。

**同一对象，渐进喂字段**——这条原则贯穿全章。调用方拿到的永远是同一个对象引用，可以放心塞进 Map、塞进 reactive state。"这个字段还没有"是用类型层的 `?:` 和运行时的 `undefined` 共同表达的，节点一直在那里，只是有些字段还在路上。

## 3. 心智模型

整个流水线对一个节点干 7 件事：

1. **进来一个"骨架+闭包层"节点**：身份字段、依赖闭包字段都在，磁盘路径 `filepath` 也已知，但 `resolved` 字段还不存在。
2. **幂等守门**：检查 `resolved` 是不是已经有值——有就直接返回。这一行让"storage 层失效后重跑"完全安全。
3. **双重断言升格类型**：把入参的类型从 `PackageNodeBase` 升格成 `PackageNode`，相当于向编译器打一张欠条："我承诺在 return 之前会把 `resolved` 填上"。
4. **定位文件**：拼 `join(filepath, 'package.json')`。
5. **文件不存在 → 静默降级**：清空 `filepath`、`resolved` 设成 `{ module: 'unknown', packageJson: {} }`。这层兜底专为 optional dependencies 没装上的场景准备。
6. **文件存在 → 解析**：剥 BOM → `JSON.parse` → 跑一组分析函数（模块类型推断、白名单字段裁剪、目录递归测体积、4 个 normalize 函数）。
7. **挂回 `resolved`**：把全部产物一次性挂到 `_pkg.resolved` 上，return 那个"已经被改了"的入参。

这套流程的不变量是：**对象引用从头到尾不变**。幂等性、副作用、类型演化都围绕这个不变量展开。

类型上，节点经过三道工序，每道工序对应一层 interface：

- `PackageNodeRaw`：身份层——名字、版本、磁盘路径、直接依赖
- `PackageNodeBase extends Raw`：闭包层——加上 `flatDependencies`/`depth` 等依赖图闭包字段
- `PackageNode extends Base`：富信息层——加上非可选的 `resolved` 子对象

本章做的就是 `Base → Node` 的跨越。

## 4. 关键权衡

### mutate 入参而不是新建对象

这条流水线最显眼的决定：函数签名声明返回 `PackageNode`，但函数体从来不 `return { ...pkg, resolved: ... }`——它直接 `_pkg.resolved = {...}`，最后 `return _pkg`（就是入参本身）。

换来的是**零拷贝**。对一个几万节点的依赖图，这意味着内存峰值不会因为这道工序翻倍；前端 reactive 系统对节点的引用全部保持有效，不会因为 resolve 触发整树重渲。这是这个工具能撑住大型 monorepo 的根本原因之一。

代价是**调用方必须接受副作用契约**：同一个对象在流水线不同阶段字段会变——今天你拿到时还是骨架，明天同一引用上就长出了 `resolved`。这种"承诺稍后填齐"的暂时性类型不一致，类型系统没法精确描述，只能用双重断言绕过结构检查（见下一条权衡）。

背后化解的本质矛盾是：富信息获取代价高（多次 fs I/O + 多种归一化），但调用方又需要一个稳定的对象引用以便塞进 Map / reactive state。这两个需求在"返回新对象"的常规写法里没法同时满足。本章选了"先在前置工序建好骨架对象（稳定引用），再在本章把富信息喂上去（高代价获取）"这条路。任何"渐进富化 + 稳定身份"的场景（ORM 实体懒加载、Vue reactive 字段补充、IDE LSP 增量补全）都会撞到同一个矛盾、做出同样的取舍。

### 类型按工序分三层 extends

类型设计上，节点演化被切成三层 `interface extends`：身份层、闭包层、富信息层。每层只关心本工序的字段，下游函数按需 narrow——骨架阶段不会误读到富信息字段、富信息阶段也不会缺骨架。

换来的是**每道工序有清晰类型边界**：函数签名精确表达"我接受什么、我返回什么"，工具提示精确，类型即文档。

代价是**流水线节点函数必须用双重断言先把自己升格成最终类型**：入参声明为 `PackageNodeBase`，函数内立刻 `const _pkg = pkg as unknown as PackageNode`。这本质上是向编译器打欠条——"我承诺在 return 前填齐 `resolved`，但填齐之前的中间代码里访问 `_pkg.resolved.xxx` 你必须放行"。这张欠条靠运行时字段填充逻辑保证正确，TS 不再帮你查。如果哪天有人重写函数、忘了填 `resolved` 就 return，TS 不会报错，bug 会延后到运行时才暴露。

背后化解的本质矛盾是：你想用类型精确描述"对象的字段集会随时间扩大"，但 TS 的类型系统是结构化的、静态的，没法表达"同一个对象在 t0 和 t1 类型不同"。三层 extends + 双重断言是个折中：用 extends 描述"工序之间的类型差异"，用断言跨过"同一对象在函数前后类型不同"这道结构检查的坎。这是所有"类型演化 + 同一对象"场景（Builder 模式的链式 builder、状态机迁移）的共同痛点。

### 并发在包之间、串行在包内

外层 `listPackageDependencies` 用 `pLimit(10)` 同时跑 10 个 `resolvePackage`；单个包内的 7 个字段挂载却是顺序的（没用 `Promise.all`，尽管只有 `installSize` 一步是 async）。

换来的是**对文件系统 I/O 的合理扇出**：体积测算要递归遍历目录，是真正的 fs I/O；10 个目录并发刚好能压满磁盘吞吐而不爆事件循环。而单个包内其余 6 步都是微秒级同步操作（`JSON.parse` 完直接调函数），`Promise.all` 反而引入微任务调度开销。

代价是**单个包的总耗时 = 串行 N 步之和**，且整个流水线的吞吐瓶颈永远是 fs I/O 而不是 CPU——如果以后 CPU 步骤变多（比如加新的归一化函数），不会显著变慢；但如果 fs 变慢（比如 webcontainer 里的虚拟 fs），整体会跟着慢。

背后化解的本质矛盾是：fs I/O 是异步的、要并发扇出才能压满吞吐；CPU 归一化是同步的、并发反而引入调度开销。两者节奏完全不同。把扇出边界划在"包"这一层（fs I/O 的天然单位）既能让 I/O 并发，又避免 CPU 步骤的微任务调度浪费。任何"异步重 I/O + 同步轻 CPU"混合的流水线（编译器多文件并行解析、ORM 多实体并行 hydrate）都适用这个划界思路。

### 文件缺失走静默降级而不是抛错

optional dependencies 没装上时，磁盘上根本没有这个包的目录——`existsSync(filepath)` 返回 false。此时不抛错、不退场，而是清空 `filepath`、模块类型标 `'unknown'`、`packageJson` 设空对象，让节点继续在图里存在。

换来的是**对 optional/缺失包的容错**：依赖图保持完整、调用方不需要 try/catch、前端可以正常显示"这个 optional 没装"。

代价是**下游必须显式处理 `'unknown'` 这个状态分支**（筛选、统计、分类都要单独考虑这种情况），并且 `filepath === ''` 这个哨兵值需要全栈感知——任何用 `filepath` 拼路径的代码都得先判空字符串。

背后化解的本质矛盾是：optional dependencies 在"声明层"是依赖图的一部分（要显示在图里），但在"安装层"可能根本不存在（没装就没目录）。走抛错的话，调用方要为"没装"这种正常情况写一堆 try/catch；走跳过的话，依赖图就缺了节点、断了拓扑。静默降级让节点"在但残缺"——既保留拓扑完整性，又用 `'unknown'` 这个显式状态标记残缺，把"如何处理残缺节点"的决定权交给下游。任何"声明与实现可能脱节"的场景（懒加载失败、可选插件未启用）都适用这个"占位 + 显式 unknown"的解法。

## 5. 最小原理演示

下面这段 40 来行的脚本只演核心思想——同一对象渐进喂字段、双重断言打欠条、幂等守门、静默降级、外层并发。真实的 7 个归一化函数用 provider stub 代替，文件读取抽象成可注入的回调，避免演示依赖真实磁盘。把这段粘到 `bun run` 或 `tsx` 里能直接跑出文末那两行注释。

```ts
// 类型按工序分三层 extends：身份层 → 闭包层 → 富信息层
interface NodeRaw { name: string; version: string; filepath: string; dependencies: Set<string> }
interface NodeBase extends NodeRaw { depth: number }
interface NodeFinal extends NodeBase {
  resolved: {
    module: 'cjs' | 'esm' | 'unknown'
    packageJson: Record<string, unknown>
    installSize?: number
  }
}

// 真实环境里这一步是 readFile + JSON.parse + 7 个归一化函数。演示里用 provider stub 代替
type ResolveFn = (filepath: string) =>
  Promise<{ module: 'cjs' | 'esm'; packageJson: Record<string, unknown>; installSize: number } | null>

const stubResolve: ResolveFn = async (filepath) =>
  filepath
    ? { module: 'esm', packageJson: { name: 'lodash' }, installSize: 42 }
    : null

// 本章主角：把骨架+闭包节点升格为富信息节点，永远 mutate 入参
async function resolvePackage(pkg: NodeBase, resolve: ResolveFn = stubResolve): Promise<NodeFinal> {
  // 双重断言：把 Base 升格为 Final，承诺在 return 前填好 resolved
  const _pkg = pkg as unknown as NodeFinal

  if (_pkg.resolved) return _pkg // 幂等守门：已 resolve 过就直接返回

  const result = await resolve(pkg.filepath)
  if (result) {
    _pkg.resolved = result // 同一对象被喂字段；不返回新对象
  }
  else {
    _pkg.filepath = '' // 静默降级：清空磁盘路径作哨兵
    _pkg.resolved = { module: 'unknown', packageJson: {} }
  }
  return _pkg // 返回的就是入参本身
}

// 外层 orchestrator 的并发限流器简化版（真实代码用 p-limit 库）
function pLimit(n: number) {
  let active = 0
  const queue: (() => void)[] = []
  return <T>(fn: () => Promise<T>) => new Promise<T>((res, rej) => {
    const run = () => {
      active++
      fn().then(res, rej).finally(() => { active--; queue.shift()?.() })
    }
    if (active < n) run()
    else queue.push(run)
  })
}

async function resolveAll(packages: NodeBase[]) {
  const limit = pLimit(10)
  return Promise.all(packages.map(p => limit(() => resolvePackage(p))))
}

// 演示 mutate 契约
const node: NodeBase = {
  name: 'lodash',
  version: '4.17.21',
  filepath: '/nm/lodash',
  dependencies: new Set(),
  depth: 0,
}
const same = await resolvePackage(node)
console.log(Object.is(node, same), node.resolved.module)
// true 'esm' —— 同一对象，被喂了字段

// 演示静默降级分支
const missing: NodeBase = {
  name: 'opt',
  version: '1.0.0',
  filepath: '',
  dependencies: new Set(),
  depth: 1,
}
const degraded = await resolvePackage(missing)
console.log(degraded.resolved.module, degraded.filepath)
// 'unknown' '' —— 节点残缺但还在图里
```

`Object.is(node, same) === true` 是 mutate 契约最直接的证据：返回的不是新对象，是入参本身。`before.resolved` 跟着 `after.resolved` 一起出现，纯粹是因为它们是同一个对象。

## 6. 执行轨迹

把 lodash 这个具体节点送进 `resolvePackage`，看它内部状态怎么一步步变。

**进入前**：节点是 `{ name: 'lodash', version: '4.17.21', filepath: '/abs/node_modules/lodash', dependencies: Set(), depth: 0 }`，`resolved` 字段不存在。

**幂等检查**：读到 `_pkg.resolved` 是 undefined，不返回，继续往下走。

**双重断言**：运行时无操作，只是让 TS 放行后续对 `_pkg.resolved.xxx` 的访问。`_pkg` 和 `pkg` 指向内存里同一个对象。

**路径拼接 + 存在性检查**：`join('/abs/node_modules/lodash', 'package.json')` 得到 `/abs/node_modules/lodash/package.json`，`existsSync` 返回 true。

**读取并解析**：`readFile` 拿到字符串，`stripBomTag` 检查首字符不是 BOM 原样返回，`JSON.parse` 得到 `{ name: 'lodash', main: 'lodash.js', license: 'MIT', ... }`。

**字段挂载**：一次性给 `_pkg.resolved` 赋值 7 个字段——

- `module: 'cjs'`（lodash 4 实际是 cjs）
- `packageJson: { name, main, license, ... }`（白名单裁剪后的 25 字段子集）
- `installSize: { bytes: 1_200_000, categories: {...} }`（递归遍历得到的，这一步唯一 await 的）
- `authors: [{ name: 'John-David Dalton', github: 'jdalton' }]`
- `repository: { type: 'git', url: 'https://github.com/lodash/lodash.git', github: 'lodash/lodash' }`
- `license: 'MIT'`
- `fundings: []`

**返回**：`return _pkg`，还是原来那个 lodash 节点对象。

**进入后**：调用方手里那个 `before` 变量现在多了一个 `resolved` 字段。因为它和 `after` 是同一个对象，`before.resolved.module` 也是 `'cjs'`。这就是 mutate 契约的全部效果：调用方什么都没做，节点自己"长好了"。

## 7. 教学简化说明

本章演示故意省略了：7 个归一化函数的内部实现（各自有专门章节）；BOM 处理的具体逻辑（一句"检查首字符是不是 0xFEFF"够了）；npm registry 元信息和 publint 报告——它们也挂在 `resolved` 上，但由后续阶段填充，不在本章流水线内；`@keep-sorted` / `@keep-unique` 这些 lint 宏的工作机制；真实 fs 目录递归（用 provider stub 代替）。

## 8. 小结

这一章自己几乎不"造"东西——它把前面五章的产物（依赖图骨架、模块类型推断、体积测算、字段归一化）用一条流水线串了起来。真正属于本章的只有两个决定：永远 mutate 同一个对象、类型按工序分三层 extends。前者换来零拷贝与稳定引用，后者换来类型边界清晰，代价是调用方要接受"同对象字段会变"的副作用契约、编译器要被双重断言放行。

下一章会把这些富信息节点交给前端：把它们塞进一个声明式的筛选 schema，按字段组合出 `license:MIT and not author:foo` 这样的查询。

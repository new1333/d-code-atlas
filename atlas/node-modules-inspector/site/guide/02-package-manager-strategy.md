# 包管理器策略：pnpm/npm/bun 三态归一

> 本章属于 primitive 层。前置：流式 JSON 解析。
> 学完你能：用一句话讲清"为什么要把 pnpm/npm/bun 三家清单压成同一份节点表"，以及为此做了哪几个关键权衡。

## 1. 为什么需要它

上一章把"读一根 stdout 字节流"拆成 tokenizer + assembler，解决了"超大 JSON 怎么吃"。但它只处理了"一家包管理器、一根 stdout"这种情况。现实里你的工具必须同时面对 pnpm、npm、bun 三家，而且它们拿清单的姿势完全不一样。

想象你在写"统计重复依赖"这个功能。第一版只支持 pnpm，跑 `pnpm ls --json` 拿到一棵树，递归遍历就完事了。第二周用户问"npm 行不行"，你回去看：npm 没有 `ls --json` 这种东西，得跑 5 个 `npm query` 选择器（`.dev` / `.prod` / `.optional` / `.workspace` / `:root`），靠 `from` / `to` 数组重建边。代码整个重写一遍。再过一周 bun 用户来了，bun 你压根不想 spawn 子进程，直接读 `bun.lock` 文件最快——又一种全新格式。

如果上层每个能力（过滤、搜索、统计、可视化）都得为每家写一份分支，三份代码会迅速漂移：修一个 bug 改了 pnpm 分支，npm 分支照样坏着。更糟的是，每接入第四种包管理器（yarn？），整个上层都得重写一遍。

但仔细看三家吐出来的东西，会发现一个不对称：**输入侧完全不可调和（CLI 树 / 选择器查询 / lockfile 文件），输出语义却高度同构**（都是一个包有名字、版本、文件路径，连着若干条到其它包的依赖边）。一个 pnpm 节点和一个 npm 节点，剥掉外壳后长得几乎一样。

这个不对称——拿清单的姿势千差万别，但拿出来的东西大同小异——就是这一层要解决的问题。

## 2. 核心思想

针对这种不对称，思路是在两者之间塞一层适配器：把"怎么拿清单"这件事关进独立的适配器模块，每家想怎么拿就怎么拿；所有适配器对上吐同一份 schema（spec → 节点映射）；上层消费代码完全不需要知道当前是哪家。

说人话：派发器看一眼项目根的 lockfile 是哪种，动态加载对应适配器，适配器内部各显神通把清单变成统一格式吐出来。从上层看，整条链路就是一根黑盒管道，进口是 lockfile，出口是统一的依赖节点 Map。

这是把"适配器模式"用在"压平异构数据源"这个老问题上。骨架不新，但落点很关键——它把"包管理器种类"这个维度从上层彻底拿掉了。

## 3. 心智模型

整条流水线长这样：

```
探测 → 派发 → 适配 → 归一化 → 上层消费
```

- **探测**：调用方传入项目根目录，用一个 lockfile 探测库查文件名。有 `pnpm-lock.yaml` 就是 pnpm，有 `package-lock.json` 就是 npm，有 `bun.lock` 就是 bun。不做命令行试探，探测失败直接抛错。
- **派发**：拿到种类后，用一个 `if/else if` 链加 `await import()` 动态加载对应适配器模块。种类是 `'pnpm'` 就 `import('../agents/pnpm')` 调它的 `listPackageDependencies(options)`，另外两家的代码完全不进运行时。
- **适配**：每家适配器用自家途径拿原始清单。pnpm 跑 `pnpm ls --json` 喂给上一章的流式解析器；npm 用 `Promise.all` 并发跑 5 个 `npm query` 选择器规避 CLI 冷启动；bun 直接 `fs.readFile('bun.lock')` 当文本读，正则剥掉 JSON 不允许但 bun 接受的尾逗号后 `JSON.parse`。
- **归一化**：每家适配器内部递归遍历自家结构（pnpm 是层级树、npm 是带 from/to 的平面查询结果、bun 是元组字典），沿途把异构节点压成同一种「`spec`（name@version）→ `{ spec, name, version, filepath, dependencies: Set<spec>, clusters: Set<string> }`」映射表。遍历同时给节点打集群标签（prod / dev / optional），并让标签沿依赖边向下继承。
- **上层消费**：派发器拿到 raw 结果后调一个 `populateRawResult`，给每个节点补反向引用、闭包、深度等图属性（这部分是下一章的事）。上层从此只看到 `Map<spec, PackageNodeBase>`，再也不用关心当前是哪种包管理器。

整条流水线的精髓在第二步——**动态 `import()`**：被加载的适配器代码只有真正用到的那个进了运行时，另外两家的代码（连同它们引入的子进程依赖、流式解析器等）都被摇掉。

## 4. 关键权衡

讲清了原理，把做过的选择摊开看，每条都换来什么、又付了什么代价。

### 用动态 import 换 bundle 隔离，付注册表维护负担

选了 `await import('../agents/pnpm')` 这种动态加载而不是顶部一次性 import 所有适配器，换来了被摇树优化的运行时。前端 bundle 或 webcontainer 场景下，用户项目只用 pnpm，npm 和 bun 适配器的代码（连同 npm 适配器拉进来的 tinyexec、bun 适配器拉进来的 fs 调用）就完全不进 bundle。

代价是新增一种包管理器必须同时做两件事：写一个适配器模块，并在派发器的 `if/else if` 链里加一行。漏一行，调用方传进来就 `throw 'Package manager X is not yet supported'`。这是"开闭原则不彻底"——加新种类不改原文件做不到。

背后化解的本质矛盾是 **bundle 体积（懒加载受益）vs 注册表的中央维护负担（懒加载必须显式登记）**。任何"按需加载 + 多种实现"的系统都会撞上它——VSCode 的内置扩展、Vite 的插件、Electron 的 IPC handler 都是这个骨架的不同化身。

### 靠 lockfile 文件名探测，付"无 lockfile 即抛错"

选了只看 lockfile 文件名而不是命令行 `which pnpm` 那种试探，换来了零配置（用户什么都不用填）和零子进程开销（探测阶段不 spawn 任何东西）。探测库看一眼目录里有没有 `pnpm-lock.yaml` 等文件就完了。

代价是用户的项目根必须先有某家 lockfile。刚 `git clone` 下来还没装过依赖的项目会直接抛 `Cannot detect package manager in the current path`。这个机制不试图自愈：它不猜"既然有 package.json 就默认 npm"，而是把决策权踢回给用户——你得先 `pnpm install` 留下 lockfile 才能用这个工具。

背后化解的本质矛盾是 **探测的可靠性 vs 用户的配置成本**。靠命令行试探（`which` 跑一遍）可以零配置，但用户机器上同时装了 pnpm/npm/bun 时根本判断不了这个项目用哪家；靠 lockfile 文件名判断是确定性映射，但要求项目已经走过一次 install。这个工具选了后者，因为后者不会撒谎。

### bun 直接读 lockfile 文本，付自己写解析的工程负担

选了 bun 适配器不调 `bun` CLI、直接 `fs.readFile('bun.lock')` 当文本读，换来了无子进程——更快，且能在没装 bun 的静态环境里跑（比如打包后的 webcontainer 镜像）。

代价有两层。第一层，bun 的 lockfile 格式虽然长得像 JSON，但允许尾逗号——标准 `JSON.parse` 拒收，必须先正则 `/,(\s*[}\]])/g` 把尾逗号剥掉再 parse。第二层，bun 的二进制老格式 `bun.lockb` 直接被这个适配器拒绝，要求用户先迁移到新格式 `bun.lock`，否则抛错指向 bun 官方迁移文档。

背后化解的本质矛盾是 **避免运行时依赖（不依赖宿主装了 bun CLI）vs 自己重实现解析（要管文本格式所有的怪癖）**。这个矛盾在"读 vs 跑"的所有场景里都会出现：能用文本读就别跑进程，但你得接住格式所有的边界 case。

### 三家共用同一份 schema，付特有能力降级为可选字段

选了所有适配器都返回同一份 `Map<spec, PackageNodeRaw>`——节点字段是 `spec` / `name` / `version` / `filepath` / `dependencies: Set<spec>` / `clusters: Set<string>`，外加几个可选字段（`workspace?` / `private?`）。换来了上层一份代码处理三家，过滤、搜索、统计、可视化的逻辑完全不知道当前是哪家。

代价是某家特有的能力只能挂可选字段，上层用之前得判空。最典型是 pnpm 的 catalog（monorepo 里集中管理依赖版本的命名清单）——这个概念 npm/bun 都没有，只能作为最外层的可选 `catalogs` 字段挂在结果对象上，节点上的 catalog 标签则编码进 `clusters: Set<string>` 当作普通集群处理。上层想知道"哪些包是 catalog 引入的"得自己从 clusters 里筛 `catalog:` 前缀。

背后化解的本质矛盾是 **接口统一（上层一份代码）vs 能力差异（各家有独门特性）**。任何多后端抽象（SQL 方言、ORM、云存储 SDK）都会撞上它——通解骨架是"基础 schema 共享 + 特性降为可选/扩展字段 + 让上层显式 opt-in"。

> 还有两条偏 npm 单家机制的取舍——"5 个 query 并发跑换规避 CLI 冷启动"、"dev/prod/optional 三个查询要求 node_modules 已装"——更属于 npm 适配器内部的实现细节，不展开成独立权衡。它们的位置是上面"适配"那一步的具体执行。

## 5. 最小原理演示

下面这段脚本演的是**动态派发 + 统一 schema** 两条权衡。三个最小适配器各自返回一份写死的「`spec` → `{ dependencies: Set<spec> }`」映射，分别模拟 pnpm 的层级树、npm 的平面查询结果、bun 的 lockfile 元组字典——但都被各自的适配器内部压平成同一份 schema。派发器按种类动态 `import()`，主流程用同一份循环遍历打印依赖数，证明三家走同一份消费代码。

为了忠实复刻"动态加载"这条权衡，三个适配器各自独立成模块：

```ts
// agents/pnpm.ts —— 模拟 pnpm：源数据是层级树，递归 DFS 压平
export async function listPackageDependencies() {
  // 假装这是 pnpm ls --json 流式吃出来的层级树
  const tree = [
    { name: 'app@1.0.0', dependencies: [
      { name: 'lodash@4.17.21', dependencies: [] },
      { name: 'axios@1.0.0', dependencies: [] },
    ]},
  ]

  const packages = new Map<string, { spec: string, dependencies: Set<string> }>()

  function walk(raw: { name: string, dependencies: any[] }) {
    if (packages.has(raw.name)) return
    packages.set(raw.name, { spec: raw.name, dependencies: new Set() })
    for (const child of raw.dependencies) {
      packages.get(raw.name)!.dependencies.add(child.name)
      walk(child)
    }
  }
  tree.forEach(walk)
  return { packageManager: 'pnpm' as const, packages }
}
```

```ts
// agents/npm.ts —— 模拟 npm：源数据是带 from/to 的平面查询结果，靠 to[] 重建边
export async function listPackageDependencies() {
  // 假装这是 5 个 npm query 并发跑完拼出来的平面结果
  const flat: { name: string, to: string[] }[] = [
    { name: 'app@1.0.0', to: ['lodash@4.17.21', 'axios@1.0.0'] },
    { name: 'lodash@4.17.21', to: [] },
    { name: 'axios@1.0.0', to: [] },
  ]

  const packages = new Map<string, { spec: string, dependencies: Set<string> }>()
  for (const item of flat) {
    packages.set(item.name, { spec: item.name, dependencies: new Set(item.to) })
  }
  return { packageManager: 'npm' as const, packages }
}
```

```ts
// agents/bun.ts —— 模拟 bun：源数据是 lockfile 元组字典，按 key 路径解析父子
export async function listPackageDependencies() {
  // 假装这是 readFile('bun.lock')、剥尾逗号、JSON.parse 出来的
  const lockfile: Record<string, [string, string]> = {
    'app@1.0.0': ['', ''],
    'app@1.0.0/lodash@4.17.21': ['', ''],
    'app@1.0.0/axios@1.0.0': ['', ''],
  }

  const packages = new Map<string, { spec: string, dependencies: Set<string> }>()
  for (const key of Object.keys(lockfile)) {
    const parts = key.split('/')
    const parentSpec = parts.length > 1 ? parts.slice(0, -1).join('/') : null
    const ownSpec = parts[parts.length - 1]
    if (!packages.has(ownSpec)) {
      packages.set(ownSpec, { spec: ownSpec, dependencies: new Set() })
    }
    if (parentSpec) {
      const parentNode = packages.get(parentSpec)
      if (parentNode) parentNode.dependencies.add(ownSpec)
    }
  }
  return { packageManager: 'bun' as const, packages }
}
```

```ts
// dispatcher.ts —— 派发器：动态 import 加载对应适配器
type AgentName = 'pnpm' | 'npm' | 'bun'

export async function listPackageDependenciesRaw(manager: AgentName) {
  if (manager === 'pnpm')
    return await import('./agents/pnpm').then(r => r.listPackageDependencies())
  if (manager === 'npm')
    return await import('./agents/npm').then(r => r.listPackageDependencies())
  if (manager === 'bun')
    return await import('./agents/bun').then(r => r.listPackageDependencies())
  throw new Error(`Package manager ${manager} is not yet supported`)
}
```

```ts
// main.ts —— 上层消费：循环里没有任何"这是哪种包管理器"的分支
import { listPackageDependenciesRaw } from './dispatcher'

for (const manager of ['pnpm', 'npm', 'bun'] as AgentName[]) {
  const { packageManager, packages } = await listPackageDependenciesRaw(manager)
  console.log(`\n[${packageManager}]`)
  for (const [spec, node] of packages) {
    console.log(`  ${spec} → ${node.dependencies.size} 个直接依赖`)
  }
}
```

期望输出（三家完全一致——这就是"归一化"的力量）：

```
[pnpm]
  app@1.0.0 → 2 个直接依赖
  lodash@4.17.21 → 0 个直接依赖
  axios@1.0.0 → 0 个直接依赖

[npm]
  app@1.0.0 → 2 个直接依赖
  lodash@4.17.21 → 0 个直接依赖
  axios@1.0.0 → 0 个直接依赖

[bun]
  app@1.0.0 → 2 个直接依赖
  lodash@4.17.21 → 0 个直接依赖
  axios@1.0.0 → 0 个直接依赖
```

`main.ts` 里没有任何关于"这是哪种包管理器"的分支，就是一份循环。三种适配器内部走了完全不同的路（递归树 / 平面重建 / 字典拼装），但它们吐出来的 schema 完全一致，所以上层代码完全无感。这就是适配器模式 + 统一 schema 的实际效果。

## 6. 执行轨迹

拿一个具体输入走一遍：在一个装了 pnpm 的 monorepo 项目里，调用 `listPackageDependenciesRaw('pnpm', { cwd: '/repo', depth: 5, monorepo: true })`。

1. **派发器收到 manager='pnpm'**，进入 `if (manager === 'pnpm')` 分支，`await import('../agents/pnpm')` 动态加载 pnpm 适配器模块。npm/bun 适配器代码不进运行时。
2. **pnpm 适配器先跑 `pnpm root -w`** 拿 workspace 根目录（比如 `/repo`），失败则回退到不带 `-w` 的 `pnpm root`。
3. **接着跑 `pnpm ls --json --depth 5 --recursive`**（monorepo 模式加 `--recursive`）。stdout 是上一章讲过的"多个 JSON 数组首尾相连"格式，喂给 `parseJsonStreamWithConcatArrays` 流式装配出层级树数组——每个 workspace 一棵树。
4. **适配器为每个 workspace 根建节点**，spec 是 `${name}@${version}`，标 `workspace: true`。
5. **DFS 递归遍历每棵树**。对每个 raw 节点用 WeakMap memo 化（同一节点不建两次），生成 PackageNodeRaw 入表。level===1 时给直接依赖打 `dep:prod`（或 `dep:dev` / `dep:optional`）集群标签；同时查 catalogs 表，给在 catalog 里登记的包追加 `catalog:default` 标签。用 `packages.has(spec)` 短路已访问节点处理 DAG。
6. **适配器返回**：`{ root: '/repo', packageManager: 'pnpm', packageManagerVersion: '9.x', packages: Map<spec, PackageNodeRaw>, catalogs: { default: { ... } } }`。
7. **派发器拿到 raw 结果**，调 `populateRawResult` 给每个节点补反向引用、闭包、深度等图查询属性——但这是下一章的事，本章到此打住。

走完之后，上层拿到的是一个 `Map<spec, PackageNodeBase>`，里面每个节点的 `dependencies` 是 spec 字符串的 Set、`clusters` 是从父节点继承并叠加自己标签后的并集。后续不管上层要做过滤、搜索、统计还是可视化，都从这一份表出发，再也不会碰"这是 pnpm 还是 npm"的问题。

## 7. 教学简化说明

本章演示故意省略了：真正的子进程调用（用 `tinyexec` 跑 `pnpm` / `npm` / `bun` 命令）；流式 JSON 解析的内部机制（上一章已展开）；cluster 标签的具体生成与沿依赖边继承的算法；pnpm catalog 的 YAML 解析；bun lockfile 尾逗号清洗正则的边界 case；workspace 节点命名兜底（路径转下划线截前 20 字符）。这些都不影响演"归一化"这个核心思想，只是工程细节。

## 8. 小结

把"拿清单"这件事拆成「探测 + 派发 + 适配 + 归一化」四步，三种包管理器的不可调和差异被关进各自适配器，对上吐同一份节点 Map。后面所有花活——过滤、统计、图查询——都建立在"已经拿到一份 spec → PackageNodeBase 的 Map"这个前提之上。但这份 Map 现在还是一张只有直接依赖边的图，想瞬答"这个包被谁依赖"、"最浅的调用者是谁"，还得再算一遍。下一章就接着这个口子讲。

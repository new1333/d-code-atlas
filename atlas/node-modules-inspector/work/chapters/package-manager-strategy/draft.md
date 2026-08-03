# 包管理器策略：让 pnpm/npm/bun 在上层看起来一个样

## 一个工具想画"依赖全景"，先得回答：依赖从哪来

想象你在写一个能可视化项目依赖的工具。前端要画一棵树、画个 treemap、做搜索、做过滤——这些都是上层能力，但所有上层能力都绕不开同一个底层问题：**这个项目到底装了哪些包？包之间的依赖边长什么样？**

听起来像一句话能解决的问题。但真到落地你会发现：用户用的包管理器不一样，"装了哪些包"这个问题的答案长得完全不一样。

- 用 **pnpm** 的项目，你得跑 `pnpm ls --json`，它会吐出一棵**嵌套的 JSON 树**。
- 用 **npm** 的项目，你得跑 `npm query --json :root .workspace .dev ...`，它给你的是一组**平面查询结果**，依赖边靠 `from` / `to` 数组重建。
- 用 **bun** 的项目，最方便的办法是不调 bun，**直接读 `bun.lock` 文件**——它本质是一个像 JSON 但带尾逗号的文本，得手动洗一遍才能 `JSON.parse`。

如果上层每个能力（过滤、搜索、统计、画图）都得为每家写一份 `if/else`，三份代码会迅速漂移；更要命的是，**每接入一种新包管理器，整个上层都要被翻一遍**。

这一章讲的就是怎么把这三家差异关进笼子，让上层只看到一份统一的依赖节点流。

## 探测 → 派发 → 压平：把差异关进笼子的三步

整个机制拆开就三步，**像请了个翻译官处理三个外国客户**：先搞清对方说哪种语言（探测），再临时把对应的翻译叫来（派发），最后让翻译把对方的话翻成统一格式（压平）。

### 第一步：探测——靠 lockfile 文件名，不靠命令行试探

最简单的办法就是看项目根目录有哪个 lockfile：

- 有 `pnpm-lock.yaml` → pnpm
- 有 `package-lock.json` → npm
- 有 `bun.lock` 或 `bun.lockb` → bun

为什么不直接去 `pnpm --version` 试一下？因为**起子进程很贵**——每次 spawn 都要冷启动一次 Node、加载一遍模块、再走一遍 IPC。探测这一步完全可以靠文件名零成本完成，没必要花在子进程上。

如果三家 lockfile 一个都没有，那这个项目还没装过依赖，直接抛错让用户先 `install`。

### 第二步：派发——用动态 `import()` 临时叫翻译

知道是哪家之后，按名字动态加载对应的适配器模块：

```ts
async function listPackageDependenciesRaw(manager, options) {
  if (manager === 'pnpm') {
    return (await import('./agents/pnpm/list')).listPackageDependencies(options)
  } else if (manager === 'npm') {
    return (await import('./agents/npm/list')).listPackageDependencies(options)
  } else if (manager === 'bun') {
    return (await import('./agents/bun/list')).listPackageDependencies(options)
  }
  throw new Error(`Unsupported package manager: ${manager}`)
}
```

这里**用 `import()` 而不是顶部的 `import` 语句**是有讲究的——顶部的静态 import 会把所有适配器都打进 bundle，哪怕用户只用 pnpm，npm 和 bun 的代码也会被一起打包进去。在前端 / WebContainer 这种对 bundle 体积敏感的场景，这是不可接受的。动态 import 让没装的那家代码压根不进 bundle。

### 第三步：压平——递归遍历，把异构结构变成 `{spec → 节点}` 表

每家适配器拿到原始清单后，都得在内部做一次递归遍历：

- pnpm 拿到的是**嵌套树**，递归 DFS 一路向下，把每个节点塞进 Map；
- npm 拿到的是**平面查询结果**，先按 location 入表，再遍历 `to[]` 数组补依赖边；
- bun 拿到的是 **lockfile 元组字典**（`Record<key, [spec, tarball, ...]>`），递归解析 key 串。

三种结构天差地别，但**遍历完之后都产出同一份 schema**：一张 `Map<spec, PackageNodeRaw>`，每个节点有 `name`、`version`、`filepath`、`dependencies: Set<spec>`、`clusters: Set<string>`。说人话就是：不管原来是树、平面表还是元组字典，最后都变成"一张节点表 + 每个节点指向谁的边集合"。

### 集群标签：依赖边上的"颜色"

光有节点和边还不够——上层还得知道某个包是 **prod 依赖**还是 **dev 依赖**、是不是只在 optional 里出现。这个信息通过 `clusters: Set<string>` 字段传上去。

打标签的规则很自然：**在根的直接依赖这一层打上 `dep:prod` / `dep:dev` / `dep:optional`，然后让标签沿着依赖边向下继承**。比如 `react` 是 prod 依赖、`react` 又依赖 `loose-envify`，那 `loose-envify` 的 clusters 就会包含 `dep:prod`——因为它"被 prod 依赖传递引用到了"。

这样上层如果想筛"所有 dev 依赖的传递闭包"，就是一句 `clusters.has('dep:dev')`，不用再走一遍图。

## 最小演示：三家适配器走同一份消费代码

光说不练假把式。下面这个演示完全从零搭一个派发器配三个最小适配器，每个适配器返回一份**写死的、形状各异**的原始数据——一个伪树（模拟 pnpm）、一个伪平面查询（模拟 npm）、一个伪 lockfile 字典（模拟 bun）。最后用**同一份循环**打印三家结果，证明上层无关包管理器种类。

四个文件，按 `bun run demo.ts` 跑：

```ts
// types.ts —— 统一 schema
export interface PackageNodeRaw {
  spec: string                  // 'name@version'
  name: string
  version: string
  dependencies: Set<string>     // spec 字符串的集合
  clusters: Set<string>         // 'dep:prod' / 'dep:dev' / ...
}

export interface RawResult {
  manager: 'pnpm' | 'npm' | 'bun'
  packages: Map<string, PackageNodeRaw>
}

export interface AdapterOptions {
  root: string
  depth?: number
}
```

```ts
// agents/pnpm.ts —— 模拟 pnpm：原始数据是嵌套树
import type { RawResult, AdapterOptions } from '../types'

// 模拟 pnpm ls --json 的输出形状（嵌套 dependencies）
const fakeTree = {
  spec: 'my-app@1.0.0', name: 'my-app', version: '1.0.0',
  dependencies: {
    'react': {
      spec: 'react@18.2.0', name: 'react', version: '18.2.0',
      dependencies: {
        'loose-envify': {
          spec: 'loose-envify@1.4.0', name: 'loose-envify', version: '1.4.0',
          dependencies: {},
        },
      },
    },
    'vite': {
      spec: 'vite@5.0.0', name: 'vite', version: '5.0.0',
      dependencies: {
        'esbuild': {
          spec: 'esbuild@0.19.0', name: 'esbuild', version: '0.19.0',
          dependencies: {},
        },
      },
    },
  },
}

export async function listPackageDependencies(_opts: AdapterOptions): Promise<RawResult> {
  const packages = new Map<string, PackageNodeRaw>()

  function walk(node: typeof fakeTree, cluster: string) {
    // DAG 短路：同一个包可能被多条路径引用到，已访问过就只补集群标签
    if (packages.has(node.spec)) {
      packages.get(node.spec)!.clusters.add(cluster)
      return
    }
    packages.set(node.spec, {
      spec: node.spec, name: node.name, version: node.version,
      dependencies: new Set(Object.keys(node.dependencies)),
      clusters: new Set([cluster]),
    })
    for (const dep of Object.values(node.dependencies)) walk(dep, cluster)
  }

  // 顶层一律标 prod（演示用，简化了 prod/dev 区分）
  walk(fakeTree, 'dep:prod')
  return { manager: 'pnpm', packages }
}
```

```ts
// agents/npm.ts —— 模拟 npm：原始数据是平面查询结果 + from/to 边
import type { RawResult, AdapterOptions } from '../types'

// 模拟 npm query 的平面输出：每个节点独立，靠 to[] 数组连边
const fakeQueryResult = {
  nodes: [
    { spec: 'react@18.2.0', name: 'react', version: '18.2.0', to: ['loose-envify@1.4.0'] },
    { spec: 'loose-envify@1.4.0', name: 'loose-envify', version: '1.4.0', to: [] },
    { spec: 'vite@5.0.0', name: 'vite', version: '5.0.0', to: ['esbuild@0.19.0'] },
    { spec: 'esbuild@0.19.0', name: 'esbuild', version: '0.19.0', to: [] },
  ],
  roots: ['react@18.2.0', 'vite@5.0.0'],
}

export async function listPackageDependencies(_opts: AdapterOptions): Promise<RawResult> {
  const packages = new Map<string, PackageNodeRaw>()
  const rootSet = new Set(fakeQueryResult.roots)

  // 阶段一：每个节点入表
  for (const n of fakeQueryResult.nodes) {
    packages.set(n.spec, {
      spec: n.spec, name: n.name, version: n.version,
      dependencies: new Set(n.to),
      clusters: new Set(rootSet.has(n.spec) ? ['dep:prod'] : []),
    })
  }
  // 阶段二：让父节点的集群标签沿着 to[] 边向下继承
  for (const n of fakeQueryResult.nodes) {
    if (!packages.get(n.spec)!.clusters.has('dep:prod')) continue
    for (const depSpec of n.to) {
      packages.get(depSpec)?.clusters.add('dep:prod')
    }
  }
  return { manager: 'npm', packages }
}
```

```ts
// agents/bun.ts —— 模拟 bun：原始数据是 lockfile 元组字典
import type { RawResult, AdapterOptions } from '../types'

// 模拟 bun.lock 解析后的 packages 字段：
// key 形如 'name@version' 或 'name@version/nested@version'
// value 是元组 [spec, tarball]
const fakeLockfile = {
  packages: {
    'react@18.2.0':                  ['react@18.2.0',      'https://.../react-18.2.0.tgz'],
    'react@18.2.0/loose-envify@1.4.0': ['loose-envify@1.4.0', 'https://.../loose-envify-1.4.0.tgz'],
    'vite@5.0.0':                    ['vite@5.0.0',        'https://.../vite-5.0.0.tgz'],
    'vite@5.0.0/esbuild@0.19.0':     ['esbuild@0.19.0',    'https://.../esbuild-0.19.0.tgz'],
  } as Record<string, [string, string]>,
  rootDeps: ['react@18.2.0', 'vite@5.0.0'],
}

export async function listPackageDependencies(_opts: AdapterOptions): Promise<RawResult> {
  const packages = new Map<string, PackageNodeRaw>()
  const rootSet = new Set(fakeLockfile.rootDeps)

  for (const [key, tuple] of Object.entries(fakeLockfile.packages)) {
    const spec = tuple[0]
    // 嵌套依赖：key 里 / 后面的部分就是父作用域下的子依赖
    const parentSpec = key.includes('/')
      ? fakeLockfile.packages[key.split('/').slice(0, -1).join('/')][0]
      : null

    if (!packages.has(spec)) {
      const [name, version] = spec.split('@')
      packages.set(spec, {
        spec, name, version,
        dependencies: new Set<string>(),
        clusters: new Set(rootSet.has(spec) ? ['dep:prod'] : []),
      })
    }
    // 补边：父 → 当前
    if (parentSpec && packages.has(parentSpec)) {
      packages.get(parentSpec)!.dependencies.add(spec)
      if (packages.get(parentSpec)!.clusters.has('dep:prod')) {
        packages.get(spec)!.clusters.add('dep:prod')
      }
    }
  }
  return { manager: 'bun', packages }
}
```

```ts
// demo.ts —— 派发器 + 同一份消费代码
import type { RawResult, AdapterOptions } from './types'

// 派发：动态 import，模拟"按需加载适配器"
async function dispatch(manager: 'pnpm' | 'npm' | 'bun', opts: AdapterOptions): Promise<RawResult> {
  if (manager === 'pnpm') return (await import('./agents/pnpm')).listPackageDependencies(opts)
  if (manager === 'npm')  return (await import('./agents/npm')).listPackageDependencies(opts)
  if (manager === 'bun')  return (await import('./agents/bun')).listPackageDependencies(opts)
  throw new Error(`Unsupported: ${manager}`)
}

// 上层消费：完全无关包管理器种类，只看 Map
function summarize(result: RawResult) {
  console.log(`\n=== ${result.manager}（${result.packages.size} 个包）===`)
  for (const [, node] of result.packages) {
    const deps = node.dependencies.size
    const tags = [...node.clusters].join(',') || '-'
    console.log(`  ${node.spec}  依赖数=${deps}  集群=[${tags}]`)
  }
}

// 跑一遍三家
for (const m of ['pnpm', 'npm', 'bun'] as const) {
  summarize(await dispatch(m, { root: '/fake', depth: 5 }))
}
```

跑完会看到三段几乎一样的输出——这就是**统一 schema 的威力**：上层 `summarize` 函数完全不知道也不关心当前是哪家包管理器，它只看一张 `Map<spec, node>`。

故意没演的：真正的子进程调用、流式 JSON 解析（属于上一章）、闭包 / 深度计算（属于下一章）。这段演示只演**派发 + 压平**这一层。

## 关键权衡：六条具体的设计决策

下面六条权衡是这一层机制的全部精华。每一条都是「**做了 X 选择 → 换来了 Y → 代价是 Z**」的三角，看懂这六条，这一层就通了。

### 权衡 1：动态 `import()` 而不是静态 `import`

**做了什么**：派发器用 `await import('./agents/pnpm/list')` 而不是顶部 `import { listPackageDependencies } from './agents/pnpm/list'`。

**换来了什么**：**没装的那家适配器代码不进 bundle**。这对前端 / WebContainer 这种把整个工具打进浏览器 bundle 的场景是刚需——一个只用 pnpm 的用户，没理由让他的浏览器下载 npm 和 bun 的适配器代码。

**代价是什么**：**新增包管理器必须同时改两处**——加一个适配器模块，再在派发器里登记一行 `if (manager === 'xxx')`。忘一个就完全找不到，而且派发器在编译期看不到适配器类型，纯靠约定保持一致。如果你只是写个后端 CLI、根本不在乎 bundle 体积，这个权衡其实是亏的——动态 import 反而让代码跳转、类型推断都变难。

### 权衡 2：靠 lockfile 文件名探测，不调命令行试探

**做了什么**：探测层只看项目根的 lockfile 文件名——`pnpm-lock.yaml` / `package-lock.json` / `bun.lock`。

**换来了什么**：**零配置自动识别 + 零子进程开销**。用户什么都不用填，工具自己就知道该用哪家；也不会因为探测这一步多 spawn 一次 Node。

**代价是什么**：**项目根必须先有 lockfile，否则直接抛错**。一个刚 `git clone` 还没 `install` 的项目、或者一个手动写 `package.json` 但还没装依赖的项目，会在这里挂掉。换来的是简单——否则你得写"先试 `pnpm --version`、失败再试 `npm --version`、再失败试 `bun --version`"的回退链，每一步都要 spawn、超时、判定，复杂度陡增。

### 权衡 3：npm 适配器并发跑 5 个 query 选择器

**做了什么**：npm 适配器用 `Promise.all` 同时跑 `:root`、`.workspace`、`.dev`、`.prod`、`.optional` 五个查询，而不是串行。

**换来了什么**：**规避 npm CLI 的单次冷启动开销**。每次 spawn `npm` 都要冷启动一次 Node、加载 npm 自己的代码——串行跑 5 次就是 5 倍冷启动时间。并发放下去，总耗时基本等于最慢的那一个。

**代价是什么**：**5 个查询里只有 2 个支持 lockfile-only 模式**。`:root` 和 `.workspace` 可以传 `--package-lock-only`，不需要 `node_modules` 真存在；但 `.dev` / `.prod` / `.optional` 这三个 query selector 是 npm 自己的限制——**必须 `node_modules` 已经装好**才能查。说人话：**npm 项目必须先 `npm install`，才能拿到完整依赖**。pnpm 和 bun 没这个要求，因为它们走 lockfile、不依赖 `node_modules`。

### 权衡 4：bun 适配器不调 bun，直接读 lockfile 文本

**做了什么**：bun 适配器不走 `bun pm ls` 之类的 CLI，而是直接 `fs.promises.readFile('bun.lock', 'utf-8')`，然后 `JSON.parse`。

**换来了什么**：**无子进程 + 可在静态环境运行 + 速度最快**。bun CLI 启动虽然比 npm 快，但还是比"读个文件"慢一个数量级；更重要的是，**静态 dump 场景（CI、build）也能用**——根本不需要装 bun。

**代价是什么**：**得手动洗尾逗号**。`bun.lock` 是 JSON-like 的——bun 接受尾逗号（`{"a": 1,}`），但 `JSON.parse` 不接受。所以读进来后必须先跑一个正则 `/,(\s*[}\]])/g` 把尾逗号剥掉再 parse。这个正则的边界 case（比如字符串里恰好有 `,}` 的）理论上可能误伤，但实际上 lockfile 是机器生成的，不会出这种情况。

**还有一个明确取舍**：**老的二进制 `bun.lockb` 不支持**。如果项目里只有 `bun.lockb`（不是新的文本 `bun.lock`），直接抛错并指向 bun 官方迁移文档。维护两套解析器（一个文本 + 一个二进制）的复杂度不值得，老用户迁一下就好。

### 权衡 5：pnpm 适配器用流式解析器吃 stdout

**做了什么**：pnpm 适配器跑 `pnpm ls --json --depth N`， stdout 不走 `JSON.parse`，而是喂给流式 JSON 解析器（上一章讲过的流式装配器）。

**换来了什么**：**对超大 monorepo 的容错**。pnpm 的 `--recursive` 模式会把整个 workspace 所有包的依赖树拼到一个 stdout 里——大型 monorepo 的输出可以**超过 V8 字符串上限**（约 512MB），`JSON.parse` 直接抛 `"Invalid string length"`。流式解析器边读边装配，根本不需要把整个 stdout 塞进一个字符串。

**代价是什么**：**输出超长时只能降级重试**。如果连流式解析都顶不住（极端情况），适配器会捕获这个特定错误，提示用户用 `--depth=ceil(depth * 2 / 3)` 重试——把深度砍掉 1/3，让输出体积降到 V8 上限以内。换句话说，**这一层承诺"尽力而为"，但不保证任何 monorepo 都能一次跑通**。这是个合理的工程取舍：99% 的项目不需要降级，剩下 1% 给一个明确的逃生通道。

### 权衡 6：三家适配器都产出同一份 schema

**做了什么**：不管原来是树（pnpm）、平面查询（npm）、还是元组字典（bun），最后都压成 `Map<spec, PackageNodeRaw>`，节点结构完全相同：`spec` / `name` / `version` / `filepath` / `dependencies: Set<spec>` / `clusters: Set<string>`。

**换来了什么**：**上层一份代码处理三家**。过滤、搜索、画 treemap、做统计、算闭包——这些上层能力全部只看 `PackageNodeRaw`，根本不知道也不关心当前是哪家包管理器。新接入一种包管理器，**上层 0 改动**。

**代价是什么**：**某家特有能力必须挂在可选字段上，上层用之前得判空**。最典型的就是 pnpm 的 **catalog**（pnpm-workspace.yaml 里集中声明版本的功能）——npm 和 bun 没这个概念，所以 catalog 信息挂在 raw 结果顶层的可选字段 `catalogs?: Record<string, ...>` 上，节点上的 `catalog:X` 集群标签也是 pnpm 独有。上层如果想用 catalog，必须先判 `if (result.catalogs)`，否则会在 npm / bun 项目里直接拿到 `undefined`。

## 这一层的边界：raw 表只是起点

到这里，三种包管理器的差异已经被关进了适配器的笼子里，上层拿到的是一份统一的节点表。但要注意：**这张表里只有"直接依赖边"**——`node.dependencies` 装的是直接子节点，**没有传递闭包、没有反向引用、没有深度信息**。

比如想知道"哪些包依赖了 `react`"、"这个包被传递引用的总深度是多少"——光看 `dependencies` 是算不出来的，得另跑一次全图遍历。这件事属于**依赖图物化**章的主题，是这一层的直接下游。本层的全部职责就是：**把异构清单压平成统一表，把更进一步的图查询留给下一层**。
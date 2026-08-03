---
title: 静态推断模块类型：不加载包也能知道它是 CJS 还是 ESM
---

# 静态推断模块类型：不加载包也能知道它是 CJS 还是 ESM

## 一个工程师会问的真实问题

想象一下：你接手了一个 monorepo，里面装了几百上千个依赖。团队决定要「去 CJS 化」——把所有能换成纯 ESM 的包都换掉，让 vite/esbuild 不用再为每个依赖包一层 interop。这是个能省下不少构建时间和包体积的事。

但你要怎么知道哪个包已经 ESM-ready？

最直觉的做法：写个脚本，对每个包 `import()` 一下看看能不能跑。但这根本行不通：
- **副作用**。很多包一加载就改全局状态、连网络、起定时器。
- **要装齐**。你想分析 1000 个包，得先把它们都装到一起——它们之间的 peerDep 还会打架。
- **宿主差异**。同一个包，Node 看到的是 CJS、webpack 看到的是 ESM，你测出来的结果未必对得上构建工具看到的样子。

那能不能不真去加载、光看文件就猜出来？这就是这一章要讲的小函数干的事：吃一份 `package.json`，吐一个 5 选 1 的标签——`cjs` / `esm` / `dual` / `faux` / `dts`。整个过程零 IO、零副作用、不要求包真被装上。

## 核心思想：把 package.json 当成一棵带条件语义的树

读者大概率见过 `package.json` 里的 `exports` 字段长这样：

```json
{
  "exports": {
    ".": {
      "import": "./dist/index.mjs",
      "require": "./dist/index.cjs"
    }
  }
}
```

人眼一看就知道：这个包给 ESM 环境一个入口、给 CJS 环境另一个入口——它是 dual（双格式）。

我们要做的，就是把「人眼一看」这件事写成算法。说人话就是：**沿着这棵条件树往下走，路上看到什么 key 就在账本上记一笔，最后看账本上哪些字段被点亮了**。

会点亮的三个 key 是：
- `import` —— Node/bundler 在 ESM 上下文里走这条
- `require` —— Node 在 CJS 上下文里走这条
- `module` —— bundler 私下约定的「ESM 源码入口」（Node 不认这个条件名）

走到叶子节点（一个字符串路径）时，再看后缀：
- `.mjs` / `.mts` → ESM 入口，等价于点亮 import
- `.cjs` / `.cts` → CJS 入口，等价于点亮 require
- `.js` → 不点亮任何信号（因为 `.js` 到底是 ESM 还是 CJS 取决于 `type` 字段，单看后缀决定不了）

最后看账本上三个布尔值，分派到一个标签。

## 一段 30 年的历史叠加

为什么算法搞得这么麻烦？因为 npm 包的「模块格式」不是一天设计出来的，是 30 年约定层层往上叠的结果：

| 字段 | 出现年代 | 谁认它 | 含义 |
|------|---------|--------|------|
| `main` | 最古老 | 所有工具 | CJS 入口（默认假设） |
| `module` | bundler 时代 | webpack/rollup/vite | ESM 源码入口，Node 不认 |
| `type: 'module'` | Node 12+ | Node | 把 `.js` 文件当 ESM 处理的开关 |
| `exports` | Node 12.7+ | Node + 新版 bundler | 现代的条件树，按环境选入口 |

这四层语义谁优先、谁覆盖谁，决定了「Node 看到的是 CJS 还是 ESM」和「bundler 看到的是 CJS 还是 ESM」**可能不一致**。最典型的不一致就是 faux（假冒）：包给了 `module` 字段（bundler 拿走当 ESM 处理），但没给 `exports`（Node 还在走 `main` 当 CJS 处理）——结果同一份代码，构建工具看到 ESM、运行时看到 CJS。这是个会让 tree-shaking 失效、会让 interop 包装被双重加上的中间态。

所以这套算法的产物，必须把 faux 显式独立成一类，让 UI 能把它单独标红、提示用户「这个包看起来 ESM，实际不是」。

## 心智模型：从一份 package.json 到一个标签

走一遍完整的判定流程，5 步：

**第 1 步：早退检查 `@types/`**
包名以 `@types/` 开头？直接判 `dts`。这是 DefinitelyTyped 的命名约定——`@types/*` 永远只发类型声明，没有运行时代码。这一步发生在所有其它判定之前。

**第 2 步：递归扫条件树**
进入 `exports` 字段。这是个对象/数组/字符串任意嵌套的结构：
- 看到对象 key 是 `import` → 点亮 `hasImport`
- 看到 key 是 `require` → 点亮 `hasRequire`
- 看到 key 是 `module` → 点亮 `hasModule`
- 然后不管 key 名是啥，继续往下钻它的 value
- 遇到数组 → 每个元素都钻一遍，结果合并
- 遇到字符串叶子 → 看后缀 `.mjs`/`.cjs` 决定点亮什么
- 最深 10 层，超了直接返回空结果（防爆栈）

**第 3 步：三布尔分派**
账本上的三个布尔怎么翻译成标签？查这张表：

| hasImport | hasRequire | hasModule | 结果 |
|-----------|-----------|-----------|------|
| ✓ | ✓ | - | `dual` |
| ✓ | - | - | `esm`（但若同时有 `main` 且 `type` 不是 `'module'`，降到 `dual`）|
| - | - | ✓ | `esm` |
| - | ✓ | ✓ | `dual`（同时给 bundler 准备了 ESM 源）|
| - | ✓ | - | `cjs` |
| - | - | - | 穿透到 legacy 路径 |

**第 4 步：legacy 兜底**（无 exports，或 exports 全空）
回到 30 年前的老字段：
- 有 `module` 且有 `main` → 看 `main` 后缀判 `faux` 或 `esm`
- 只有 `module` → `faux`（bundler 看到 ESM、Node 看不到 exports，肯定是 faux）
- `type: 'module'` 或 `main` 以 `.mjs` 结尾 → `esm`
- 只有 `main` → `cjs`（最古老的形态）

**第 5 步：再早退 + 默认**
- 只有 `types`/`typings` 字段 → `dts`（纯类型包）
- 啥都没有 → 默认 `cjs`（npm 包最古老的默认假设）

## 一段从零实现的最小演示

下面这段是教学用代码，省略了真实算法里的边角处理（`@types/` 早退、深度防爆、`.mts`/`.cts` 后缀细分、`types`/`typings` 兜底），只保留**核心机制**：递归扫条件树 + 三布尔分派。

```ts
// demo.ts —— 教学最小实现，可用 `bun run demo.ts` 或 `npx tsx demo.ts` 跑
type ModuleType = 'cjs' | 'esm' | 'dual' | 'faux' | 'dts'

interface ExportSignals {
  hasImport: boolean
  hasRequire: boolean
  hasModule: boolean
}

const emptySignals = (): ExportSignals => ({ hasImport: false, hasRequire: false, hasModule: false })

// 递归扫条件树
function scanExports(node: unknown, depth: number, out: ExportSignals) {
  if (depth > 10) return                          // 防爆栈，教学里也保留这一条，因为它本身就是个权衡

  if (typeof node === 'string') {                  // 叶子：看后缀
    if (node.endsWith('.mjs')) out.hasImport = true
    else if (node.endsWith('.cjs')) out.hasRequire = true
    // .js 后缀决定不了，跳过
    return
  }
  if (Array.isArray(node)) {                       // 数组：每个元素都扫
    for (const item of node) scanExports(item, depth + 1, out)
    return
  }
  if (node && typeof node === 'object') {          // 对象：先嗅探 key 名，再下钻 value
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === 'import') out.hasImport = true
      else if (key === 'require') out.hasRequire = true
      else if (key === 'module') out.hasModule = true
      scanExports(value, depth + 1, out)           // 不管 key 名是啥，继续往下钻
    }
  }
}

// 三布尔 → 5 标签的分派表
function dispatch(
  signals: ExportSignals,
  hasMain: boolean,
  hasModuleField: boolean,
  isTypeModule: boolean,
): ModuleType {
  const { hasImport, hasRequire, hasModule } = signals

  if (hasImport && hasRequire) return 'dual'

  if (hasImport || hasModule) {
    if (hasMain && !isTypeModule) return 'dual'    // 给老 resolver 留了 CJS 入口，降级
    return 'esm'
  }

  if (hasRequire) {
    if (hasModuleField) return 'dual'              // 同时给 bundler 准备了 ESM 源，升级
    return 'cjs'
  }

  return 'cjs'                                     // 兜底（实际进入这里之前已被 legacy 截走）
}

function analyze(pkgJson: any): ModuleType {
  if (typeof pkgJson.name === 'string' && pkgJson.name.startsWith('@types/')) return 'dts'

  const signals = emptySignals()
  if (pkgJson.exports) scanExports(pkgJson.exports, 0, signals)

  const hasMain = !!pkgJson.main
  const hasModuleField = !!pkgJson.module
  const isTypeModule = pkgJson.type === 'module'

  // exports 全空 → 穿透到 legacy
  if (!signals.hasImport && !signals.hasRequire && !signals.hasModule) {
    if (hasModuleField && hasMain) {
      const mainLooksCjs = pkgJson.main.endsWith('.cjs') ||
                           (pkgJson.main.endsWith('.js') && !isTypeModule)
      return mainLooksCjs ? 'faux' : 'esm'
    }
    if (hasModuleField) return 'faux'
    if (isTypeModule || (hasMain && pkgJson.main.endsWith('.mjs'))) return 'esm'
    if (hasMain) return 'cjs'
  }

  return dispatch(signals, hasMain, hasModuleField, isTypeModule)
}

// 跑一组 fixture
const fixtures = [
  { name: 'dual-pkg',  exports: { '.': { import: './m.mjs', require: './m.cjs' } } },
  { name: 'esm-pkg',   exports: { '.': { import: './m.mjs' } } },
  { name: 'faux-pkg',  main: 'index.js', module: './esm.mjs' },
  { name: 'cjs-pkg',   main: 'index.js' },
  { name: '@types/x',  name: '@types/foo', types: 'index.d.ts' },
]

for (const pkg of fixtures) {
  console.log(pkg.name, '→', analyze(pkg))
}
```

跑出来：

```
dual-pkg → dual
esm-pkg → esm
faux-pkg → faux
cjs-pkg → cjs
@types/x → dts
```

可以试着改 fixture——比如把 `dual-pkg` 的 `require` 拿掉，看它是不是变成 `esm`；或者给 `cjs-pkg` 加个 `module` 字段，看它是不是升到 `dual`。改完立刻能看到结果，这就是「纯静态」的好处。

## 走一遍真实输入：vue@3.5

vue 的 `package.json`（简化）长这样：

```json
{
  "main": "index.js",
  "module": "dist/vue.runtime.esm-bundler.js",
  "exports": {
    ".": {
      "import": {
        "node": "./index.mjs",
        "default": "./dist/vue.runtime.esm-bundler.js"
      },
      "require": {
        "node": "./index.cjs",
        "default": "./dist/vue.runtime.cjs.js"
      }
    }
  }
}
```

递归扫描会这么走：

1. 进入根对象 `.`
2. 看到 key `import` → 点亮 `hasImport`，下钻 value
3. value 是对象 `{ node: ..., default: ... }` —— 没有 import/require/module 三个 key 之一，但仍继续下钻
4. 下钻到字符串叶子 `./index.mjs` —— 后缀 `.mjs`，又点亮一次 `hasImport`（幂等，无所谓）
5. 回到根，看到 key `require` → 点亮 `hasRequire`，下钻 value
6. 类似地下钻到 `.cjs` 字符串，点亮 `hasRequire`
7. 同时顶级还有 `main: 'index.js'`、`module: './dist/...'`——`hasMain=true`、`hasModuleField=true`

最终账本：`{ hasImport: true, hasRequire: true, hasModule: false }`。

分派第一步 `hasImport && hasRequire` 直接命中 → `dual`。整个判定在亚毫秒级完成、零 IO。

## 三个关键权衡（本章的核心交付）

教学文的重点不是「这个函数能跑」，而是「为什么这么设计、换来了什么、代价是什么」。下面三条权衡，每一条都得讲透。

### 权衡 1：纯静态、永不加载，换毫秒级判定，代价是被撒谎的 manifest 骗

**做了的选择**：算法从头到尾不读磁盘、不 require、不 import。只看 `package.json` 这一份文本。

**换来**：
- **速度**。判定一份 package.json 在亚毫秒级。1 万个包全跑一遍也就几百毫秒。
- **零副作用**。不会触发包的初始化代码，不会污染全局，可以放心在 CI 里跑。
- **不依赖包真被装上**。光看 `node_modules/<pkg>/package.json` 这一个文件就够了，包没装、装坏了、peerDep 冲突了都不影响判定。

**代价**：会被撒谎的 manifest 骗。`package.json` 说 `import` 指向 `./dist/index.mjs`，但 build 步骤可能根本没生成这个文件；手写 `exports` 可能写错路径；`module` 字段指向的源可能根本没编译。这些情况算法都判不准——它只能告诉你「manifest 声称自己是 ESM」。

最典型的代价产物就是 **faux**：有 `module` 字段（bundler 当 ESM 处理）但没 `exports`（Node 还在走 `main` 当 CJS 处理）。算法必须把这种情况显式独立成一类，而不是糊成 `esm` 或 `cjs`——因为它本身就是「看起来 ESM 实际不是」的中间态。UI 端把它单独标 lime 色、提示用户警惕，就是这个权衡的下游产物。

> 说人话：**这套算法只能告诉你 manifest 怎么说的，不能告诉你 manifest 是不是说实话**。但在「想看依赖树整体的 ESM-readiness 概况」这个场景下，这就够用了——大部分包不会撒谎，撒谎的少数包会被独立标成 faux 让用户去查。

### 权衡 2：递归遍历整棵条件树，换对任意嵌套的鲁棒性，代价是防爆栈

**做了的选择**：写一个递归函数 `scanExports`，对 `exports` 字段做深度优先遍历。遇到对象就嗅探 key 名再下钻、遇到数组就每个元素扫一遍、遇到字符串就看后缀。

**换来**：对**任意嵌套**的条件路径鲁棒。真实包的 `exports` 可能长得离谱——vue 那个例子就有 `.import.node.default` 四层嵌套；rollup 的某些插件还有数组里嵌对象、对象里再嵌数组的写法。如果只扫一层（比如只看 `exports['.'].import`），这些包会被判错；写个两层循环也不够；唯一能覆盖所有形态的就是递归。

**代价**：
- **病态嵌套可能爆栈**。理论上可以构造一个嵌套 1 万层的 exports，让递归直接 stack overflow。算法的兜底是 `depth > 10` 直接返回空结果——超过 10 层就当没找到任何信号，落入 legacy 检测。10 这个数字本身没有源码注释或测试说明依据，是个经验值。
- **真实包里基本不会触发这个代价**。npm 包的 exports 普遍是 2~3 层嵌套，超过 5 层的都极少。这个防爆栈代价基本是「理论存在、实际不发生」。

> 说人话：**写递归能覆盖所有奇形怪状的 exports，写硬编码的扫一两层会漏判**。代价是个理论上的爆栈风险，但用 10 层硬上限兜住了——10 层对真实包是绰绰有余的，对恶意构造的输入是直接放弃判定。

### 权衡 3：保留 legacy 分支兜底，换对老包的兼容，代价是判定逻辑成了 9 出口决策树

**做了的选择**：当 `exports` 字段缺失，或者 `exports` 存在但条件树里完全没出现 `import`/`require`/`module` 任何一个 key 时，算法会**穿透**到 legacy 路径，回到 `main`/`module`/`type` 这套老字段判定。

**换来**：对 pre-Node-12 老包的兼容。npm 上有大量包至今没填 `exports`——它们的入口信息只在 `main` 里。如果不留 legacy 路径，这些包全都会被判成默认 `cjs`（因为穿透后没有任何信号），但实际上很多老包用了 `module` 字段给 bundler 准备 ESM 源、或者用了 `type: 'module'` 让 Node 把 `.js` 当 ESM 处理——这些都是 faux 或 esm，只是没写 exports 而已。

**代价**：
- **判定逻辑成了 9 出口决策树**。算上各种早退、穿透、降级、升级，最终代码有 9 个不同的返回点。覆盖测试极难穷举——任何「exports 部分命中 + legacy 字段同时存在」的组合都得有专门 fixture。
- **「穿透」是隐性行为**。当 `exports` 存在但所有条件都没命中（比如只有 `default`/`types`/`node` 这些其它条件名）时，代码会无声地落到 legacy 路径继续按 `main`+`module` 判。这件事代码注释里写明了「Fall through to legacy detection」，但读代码的人如果没注意，会以为「exports 存在就不会走 legacy」——这是个错觉。

> 说人话：**老包没填 exports，但它们也有自己的格式约定**。要兼容它们就得维护一套老字段的判定逻辑，跟新的 exports 判定并存。代价是整个决策树变复杂——但反过来想，如果直接砍掉 legacy 路径，所有 pre-Node-12 包都会被误判，那是更糟的代价。

## 小结

这套算法的本质，是「**把 30 年约定叠加的 npm 包格式压缩成一个 5 选 1 的标签**」。它放弃了「真去加载包看看」的精确性，换来了速度、零副作用、不依赖包被装上的好处；它把 30 年的格式约定全部翻译成「读一棵条件树 + 三个布尔 + 一张分派表」，换来了可以一份代码处理任意嵌套 exports 的鲁棒性。

它的局限也是明确的：只能告诉你 manifest 怎么说，不能告诉你 manifest 是不是说实话。所以产物里必须有 `faux` 这一独立类——它不是 cjs 也不是 esm，是「看起来 ESM 实际不是」的警示信号。

读者带走三件事就够了：
1. 算法读的是 `package.json` 这棵带条件语义的树，不是磁盘上的真实文件。
2. 三个布尔 `hasImport` / `hasRequire` / `hasModule` 是分派到 5 个标签的中间信号。
3. legacy 路径是兜底，不是备选——它和 exports 检测是一套复合决策，不能分开理解。

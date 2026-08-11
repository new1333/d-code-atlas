# 静态推断模块类型 cjs/esm/dual/faux/dts

> 本章属于 primitive 层。前置：无（全书地基章之一）。
> 学完你能：用一句话讲清「为什么判定一个 npm 包是 CJS 还是 ESM 不能真去加载它，而要靠查 package.json——以及这套静态判定为什么会划出 faux 这样一类『看起来 ESM 实际不是』的中间态」。

## 1. 为什么需要它（设计动机）

上一章把依赖图物化算清了，你能瞬时查 flatDeps、dependents、depth。但图里每个节点目前还只是一个"边"——知道它依赖谁，却不知道它**是**什么：是 CJS 还是 ESM？这恰恰是迁移决策最关心的属性。

一个 monorepo 装了几百上千个包，开发者常问的问题是：我的依赖树是不是已经 ESM-ready，能不能去掉 CJS 兼容层？这个问题的答案藏在一个很底层的事实里——包的**模块格式**决定了 esbuild/vite 要不要给它套 interop 包装、能不能对它做 tree-shake。

最直接的判法是 `require()` 或 `import()` 每个包试一下。但这条路根本走不通：触发副作用、需要装齐、跟宿主版本打架。分析期你不能真去加载，又必须给出答案，这就是矛盾。

本章要做的，就是用一份 package.json 把这套矛盾压成一个 5 选 1 的标签（cjs / esm / dual / faux / dts），不打开任何文件、不跑任何代码。

## 2. 核心思想

把 `package.json` 当成一棵**带条件语义的树**来读。

`exports` 字段下每一个 key 都不是一个普通属性名，而是一个"在什么环境下选谁"的判断：`import` 表示"用 import 引入时走这条"，`require` 表示"用 require 引入时走那条"，`node` 表示"Node 环境选这棵子树"，`default` 表示"前面都没中就这个"。整棵树的**叶子节点**是文件路径字符串，扩展名（`.mjs`/`.cjs`）是运行时形态的硬证据。

判定模块格式，本质上是**沿着条件名走、把沿途看到的指示合起来**：看见 `import` 这个 key 就标记"有 ESM 入口"，看见 `require` 就标记"有 CJS 入口"，走到叶子再看后缀给一个补充信号。最后三个布尔合起来——既看见 import 又看见 require 就是 dual；只看见 require 就是 cjs；只看见 import 就是 esm。

## 3. 心智模型

判定的产物是 5 个标签之一：

| 标签 | 含义 |
|------|------|
| `cjs` | 只有 CommonJS 入口 |
| `esm` | 只有 ESM 入口 |
| `dual` | 同时提供 CJS 和 ESM 入口 |
| `faux` | "看起来 ESM 实际不是"——bundler 当 ESM 处理、Node 当 CJS 处理 |
| `dts` | 纯类型包（无运行时代码） |

中间态由三个布尔驱动：`hasImport`、`hasRequire`、`hasModule`。前两个对应 `exports` 树里出现的 `import:`/`require:` 条件名；第三个对应 `module:` 这个**非官方但事实存在**的条件名（一些老包把它当 exports 子键用）。

判定流程是一条带两处早退、一处兜底的链：

1. **@types/ 早退**：包名以 `@types/` 开头 → `dts`（DefinitelyTyped 约定，永远只有类型）。
2. **扫 exports 树**：递归进入 `exports`，沿途看到 `import`/`require`/`module` 三个 key 之一就把对应布尔置真；遇到字符串叶子看后缀（`.mjs` → import，`.cjs` → require）；遇到数组/对象继续下钻。最终合出三个布尔。
3. **三布尔分派**：
   - import ∧ require → `dual`
   - import ∨ module → 默认 `esm`，但如果同时有 `main` 且没标 `type:'module'`，降到 `dual`（这个包给老 resolver 留了 CJS 入口）
   - require 独占 → 默认 `cjs`，但如果同时有顶级 `module` 字段，升到 `dual`（这个包给 bundler 准备了 ESM 源）
4. **Legacy 分支**：`exports` 不存在，或扫完没有任何信号，回到 `main` + `module` + `type` 三个老字段上做判断。faux 就诞生在这里：包声明了 `module`（让 bundler 当 ESM 处理），但 `main` 仍是 `.cjs`/`.js`（让 Node 当 CJS 处理）。
5. **types 早退 + 默认**：只有 `types`/`typings` 字段 → `dts`；什么都没有 → 默认 `cjs`。

## 4. 关键权衡

### 永不加载，只读 manifest

选择：判定全程只读 `package.json`，不 `import`、不 `require`、不读目标文件的内容。

换来：判定在毫秒内完成、对宿主环境零依赖、不需要包真的被装上（lockfile 上有 package.json 快照就够）。整个 npm 生态的几十万包可以离线、批量地全扫一遍。

代价：会被撒谎的 manifest 骗。手写 `exports` 写错路径、build 步骤把源文件替换掉、`module` 字段指向根本不存在的文件，这些情况下判定结果与运行时实际不符。**faux 这一类标签就是这套代价的产物**：包声明了 `module`（让 bundler 当 ESM 处理）却没有 `exports`（Node 还在按 `main` 当 CJS 处理），结果就是"看起来 ESM、实际不是"，必须把它单独立成一类，让 UI 能把它标红、让用户警惕。

这其实是所有静态分析的通病：你拿到的是声明，不是事实。想拿到真实运行时形态就得真去加载，而分析期偏偏不能。lint、类型检查、依赖审计都栽在同一个矛盾上，常见做法是接受以声明为依据、把不可信的中间态显式独立成一类，让下游决定怎么处理。

### 把 exports 当成一棵递归树来走，而不是当成一张字段表

选择：`exports` 不按"几个已知字段查表"处理，而是递归遍历任意嵌套的对象/数组结构，沿途嗅探 key 名。

换来：对任意嵌套的条件路径都鲁棒。真实的 exports 可能长这样：`{ '.': { import: { node: { default: './dist/index.mjs' } } } }`——只要树里某条路径上有 `import:` 这个 key，就会被嗅探到，不管它嵌多深。一套递归吃下所有合法形态，不用为每种结构写专门代码。

代价：递归无自然终止条件，遇到病态嵌套（比如 adversarial manifest）会爆栈。源码硬编码 `depth > 10` 就停下、返回空结果，这是个经验值（无注释、无文档说明依据）。空结果等同于"没找到任何指示"，会落入 legacy 分支继续判。

这里其实是在调和「exports 语法允许任意嵌套」和「实现必须可终止」这两个对立需求。同样的张力在 JSON Schema、AST、配置文件解析里都出现：递归换表达力，深度上限换终止保证，两者必须配套。

### 在 exports 之下保留 legacy 路径

选择：`exports` 字段不是"用了就完全说了算"。如果 `exports` 存在但扫完一棵条件树没出现任何 import/require/module 信号，代码会**穿透**回 legacy 路径，按 `main`/`module`/`type` 三个老字段重新判一遍。

换来：对 pre-Node-12 老包的兼容。大量包的 `exports` 字段只写了 `default` 或 `types` 这种"非模块格式"的条件名；还有大量包干脆没有 `exports`、只填了 `main`。两种情况下都能给出合理答案。

代价：判定逻辑成了 9 出口的决策树，覆盖测试极难穷举；尤其"穿透"是个隐性行为，从代码看像 `exports` 走完了，但实际它会继续走 legacy 分支。这种边界需要专门测试覆盖，否则容易判出意外结果。

根子上的矛盾是：npm 的入口约定是 30 年层叠的结果（main → module → type → exports），但判定函数必须给出一个 5 选 1 的确定答案。要给确定答案，就不能在新约定下完全切断老约定，否则 pre-Node-12 的包全会被推到默认 cjs，与实际不符。这种「层层向下兼容」的写法是兼容性问题的常见解，代价是分支爆炸。

## 5. 最小原理演示

下面这段只演示**两件事**：递归扫条件树收集三个布尔；三布尔 → 标签的分派表。省略了 `@types/` 早退、`depth > 10` 防爆栈、`.mts`/`.cts` 后缀细分、`types`/`typings` 兜底 dts、完整的 `main` + `module` + `type` legacy 决策树——这些是补丁，不是原理。

```ts
type Tag = 'cjs' | 'esm' | 'dual' | 'faux' | 'dts'

// 三个布尔：exports 树里是否出现过 import / require / module 三个条件名
type Signs = { import: boolean; require: boolean; module: boolean }

// 把 exports 当树走：沿途嗅探 key 名，叶子看后缀，结果合进 sig
function scan(tree: unknown, sig: Signs): void {
  if (typeof tree === 'string') {
    if (tree.endsWith('.mjs')) sig.import = true
    else if (tree.endsWith('.cjs')) sig.require = true
    return
  }
  if (Array.isArray(tree)) {
    tree.forEach(t => scan(t, sig))
    return
  }
  if (tree && typeof tree === 'object') {
    for (const [k, v] of Object.entries(tree as Record<string, unknown>)) {
      if (k === 'import') sig.import = true
      else if (k === 'require') sig.require = true
      else if (k === 'module') sig.module = true
      scan(v, sig)
    }
  }
}

// 三布尔 → 5 标签的分派（演示仅覆盖 exports 主分支；faux 来自 legacy 兜底，dts 来自早退）
function classify(pkg: {
  exports?: unknown
  main?: string
  module?: string
  type?: string
}): Tag {
  if (!pkg.exports) return 'cjs' // 真实代码这里走 legacy 决策树，演示省略
  const sig: Signs = { import: false, require: false, module: false }
  scan(pkg.exports, sig)

  if (sig.import && sig.require) return 'dual'
  if (sig.import || sig.module) {
    // 同时给老 resolver 留了 main 且没声明 type:module → 降为 dual
    return pkg.main && pkg.type !== 'module' ? 'dual' : 'esm'
  }
  if (sig.require) {
    // 只有 require 但顶级还挂了 module 字段 → 升为 dual
    return pkg.module ? 'dual' : 'cjs'
  }
  return 'cjs' // exports 写了但没出现 import/require/module 任何 key → 真实代码穿透回 legacy，演示省略
}
```

你可以拿几个 minimal fixture 喂给这段代码立刻看到结果：同时挂 `import` 和 `require` 的判 dual；只有 `import` 的判 esm；只有 `require` 的判 cjs；把 `exports` 整段删掉、只留 `module` + `main` 的会落入演示省略的 legacy 分支（真实代码会判 faux）。

## 6. 执行轨迹

拿 `vue@3.5` 的 package.json 走一遍。它的关键字段长这样：

```jsonc
{
  "main": "index.js",
  "module": "dist/vue.runtime.esm-bundler.js",
  "exports": {
    ".": {
      "import": { "node": { "default": "./index.mjs" } },
      "require": { "node": { "default": "./index.cjs" } }
    }
  }
}
```

1. 包名不是 `@types/` 开头，跳过早退 1。
2. `pkg.exports` 存在，进入 `analyzeExports` 走 `.` 这个 key。
3. `.` 的值是一个对象，遍历它的 entries：
   - 看到 key `import`，置 `hasImport = true`；继续下钻到 `{ node: { default: './index.mjs' } }`，最终叶子 `'./index.mjs'` 后缀 `.mjs`，再次置 `hasImport = true`（合并后仍是 true）。
   - 看到 key `require`，置 `hasRequire = true`；继续下钻到 `{ node: { default: './index.cjs' } }`，叶子 `'./index.cjs'` 后缀 `.cjs`，再次置 `hasRequire = true`。
4. 三布尔合出来：`{ hasImport: true, hasRequire: true, hasModule: false }`。
5. 分派第一步 `hasImport && hasRequire` 直接命中，返回 `'dual'`。

整个过程没读任何文件、没跑任何代码，纯靠遍历 `package.json` 的对象结构，< 1ms、零 IO。这个包同时还填了 `main: 'index.js'`、`module: 'dist/...'`，但在 dual 这个分支里它们完全没用上，判定先于它们给出答案。

## 7. 教学简化说明

本章演示故意省略了：`@types/` 早退、`depth > 10` 防爆栈、`.mts`/`.cts` 后缀细分、`types`/`typings` 兜底 dts、以及完整的 `main` + `module` + `type` legacy 决策树。这些都是边界补丁，不影响核心理路。真实代码还有一处"穿透"行为——`exports` 存在但没出现 import/require/module 任何 key 时，会回到 legacy 路径再判一遍——演示也省略了。

## 8. 小结

这一章把"一个包是 CJS 还是 ESM"这件事，从"打开看一眼、跑一下试试"压缩成"查一份 manifest 就够"。一整套 30 年层叠的入口约定（main、module、type、exports）被压成一个 5 选 1 标签，零 IO、毫秒级。代价是会撒谎的 manifest 会骗你，所以特意留出一类 faux 把不可信的中间态显式标出来。下一章会用同样的"目录递归 + 启发式"思路去测算每个包的安装体积、把字节拆进 test/js/dts/wasm 这些桶。

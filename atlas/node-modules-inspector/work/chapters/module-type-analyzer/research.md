# 静态推断模块类型 cjs/esm/dual/faux/dts · 源码精读

## 给 Writer 的教学钩子（必填，8 子项缺一不可）

- **用户痛点 / 场景**：一个 monorepo 装了几百上千个包，开发者想知道「我的依赖树是不是已经 ESM-ready，能不能去掉 CJS 兼容层」。但真去 `require()`/`import()` 每个包去探会引发副作用、要装齐、会和宿主版本打架——根本不可行。痛点是：**模块格式决定了 import 会不会触发 esbuild/vite 的 interop 包装、能不能 tree-shake**，而你又不能真去加载它。

- **一句话核心思想**：**把 `package.json` 当成一棵带条件语义的树来读——叶子节点的扩展名告诉你运行时形态，路径上的条件名（import/require/module）告诉你目标环境**。整套算法纯靠查表，零运行时加载。

- **设计动机（为什么需要它）**：npm 包的「模块格式」是 30 年约定叠加的结果——`main`（最古老，CJS 入口）、`module`（bundler 时代约定的 ESM 源入口）、`type:'module'`（Node 12+ 的 ESM 开关）、`exports`（Node 12.7+ 的现代条件树）。这四层语义谁优先、谁覆盖谁，决定了「Node 看到的是 CJS 还是 ESM」和「bundler 看到的是 CJS 还是 ESM」可能不一致。这个机制要做的就是把这套历史层叠**压缩成一个 5 选 1 标签**，让 UI 能按「该升哪些、该迁哪些」给用户排序。

- **关键权衡（3 条三段式）**：
  1. **纯静态、永不加载** → 换来了**毫秒级判定 + 零副作用 + 不依赖包真被装上** → 代价是**会被撒谎的 manifest 骗**：手写 `exports` 写错、build 步骤把源替换掉、`module` 字段指向根本不存在的文件——都判不准。最典型的代价产物就是 **faux**：有 `module` 字段（bundler 会当 ESM 处理）但没 `exports`（Node 还在走 `main` 当 CJS 处理）——「看起来 ESM 实际不是」，必须显式独立成一类，让 UI 能把它标红。
  2. **递归遍历整棵 `exports` 条件树** → 换来了**对任意嵌套条件路径（`.import.node.default`、数组套对象）的鲁棒性** → 代价是**深递归或病态嵌套可能爆栈**，因此硬编码 `depth > 10` 停下（深于此返回空结果，等同于「没找到任何指示」，落入 legacy 检测）。
  3. **保留 legacy 分支（`main`/`module`/`type`）兜底在 `exports` 检测之下** → 换来了**对 pre-Node-12 老包的兼容**（不少包至今没填 `exports`）→ 代价是**判定逻辑成了 9 出口的决策树**，覆盖测试极难穷举；且当 `exports` 存在但所有条件都没命中 import/require/module 时，会**穿透到 legacy 路径**继续按 `main`+`module` 判，这种「穿透」是隐性行为，需要测试专门覆盖。

- **最小心智模型（3～7 步）**：
  1. **早退 1**：包名以 `@types/` 开头 → 直接判 **dts**（类型包永远不含可执行代码）。
  2. **递归扫描 exports**：进入条件树，沿途看到 `import`/`require`/`module` 三个 key 之一就把对应布尔置真；遇到字符串叶子看后缀（`.mjs`/`.mts` → import；`.cjs`/`.cts` → require）；遇到数组/对象继续往下钻，最深 10 层。
  3. **三布尔分派**：import 与 require 同存 → **dual**；只有 import 或 module → **esm**（但若同时有 `main` 且没 `type:'module'` → 降到 **dual**，因为这个包给老 resolver 留了 CJS 入口）；只有 require → **cjs**（但若同时有 `module` 字段 → 升到 **dual**，因为这个包同时给 bundler 准备了 ESM 源）。
  4. **Legacy 兜底**（无 exports 或 exports 没结论）：有 `module` + `main` → 看 main 后缀判 **faux** 或 **esm**；只有 `module` → **faux**；`type:'module'` 或 `main` 以 `.mjs` 结尾 → **esm**；只有 `main` → **cjs**。
  5. **早退 2 + 默认**：只有 `types`/`typings` → **dts**；啥都没有 → 默认 **cjs**。

- **最小原理演示（替代旧「复刻范围」）**：
  - **应演示**：一个 30~50 行的从零实现，演**两件事**——(a) 递归扫条件树收集三个布尔（演权衡 2：递归换鲁棒性）；(b) 三布尔 → 5 标签的分派表（演权衡 1：纯静态换速度，以及 faux 这一类的存在意义）。每一段都要对应上面某个原理点。
  - **应故意省略**：`@types/` 早退、`depth > 10` 防爆栈、`.mts`/`.cts` 后缀细分、`types`/`typings` 兜底 dts、legacy `main`+`module`+`type` 决策树——这些是「补丁」，不是原理。
  - **演示载体建议**：本仓库主语言是 TS，写成一段 `bun run`/`tsx` 可直接跑的脚本最合适——构造 4~5 个 minimal package.json fixture（dual、纯 ESM、faux、纯 CJS、dts），打印每个的判定结果。能跑最好（让读者能改 fixture 立刻看到结果变化），但**不追求工程完整**——重点是让读者看清「树形扫描 → 三布尔 → 标签」这条链路，不是复刻生产代码的全部边角。

- **正文不宜展开的细节**：
  - `depth > 10` 这个具体数字的来历（无注释、无测试覆盖说明其选择依据——大概是个经验值）。
  - `.mts`/`.cts`/`.cjs`/`.mjs` 这套后缀体系本身（属于 Node 解析规范，引用 Node 文档链接即可，不在本章教学范围）。
  - `pkg-types` 的 `PackageJson` 类型定义（外部依赖，引用即可）。
  - UI 侧 `treatFauxAsESM` / `moduleTypeSimple` 这两个设置（属于展示层降级策略，本章只供应类型枚举本身）。
  - `'unknown'` 这个枚举值的产生路径——它**不**由本函数产生，本函数总能给出 5 个之一；`unknown` 是上游「package.json 文件不存在」时由调用方填入的兜底（见概念要点）。

- **推荐的一个执行轨迹例子**：
  - **输入**：`vue@3.5` 的 package.json，`exports['.']` 下同时挂了 `import:`（其下还有 `node:`/`default:`）和 `require:`（其下嵌套了 `node.default`），还有顶级 `main: 'index.js'` 与 `module: 'dist/vue.runtime.esm-bundler.js'`。
  - **关键中间态**：递归扫到 `.` 时进入对象 → 看到 key `import` 置 hasImport=true，看到 key `require` 置 hasRequire=true，再继续往下钻两步遇到字符串叶子（无新指示）→ 最终三布尔 = {import:true, require:true, module:false}。
  - **输出**：分派第一步 `hasImport && hasRequire` 命中 → 直接判 `'dual'`。整个判定 < 1ms、零 IO。

> 以上钩子供 Writer 写「动机→核心思想→心智模型→关键权衡→原理演示」；下面事实部分供核对，不要被 Writer 当目录照抄。

## 概念要点

- **入口签名**：`analyzePackageModuleType(pkgJson: PackageJson): PackageModuleType`——纯函数，入参一份 `package.json` 对象，返回 5 选 1 的字符串标签。无 IO、无异步、无缓存。
  源码位置: packages/node-modules-tools/src/analyze-esm.ts:65

- **返回类型枚举（含 `'unknown'`，但本函数永不出 unknown）**：`'cjs' | 'esm' | 'dual' | 'faux' | 'dts' | 'unknown'`。`unknown` 由调用方在 package.json 文件不存在时填入，本函数只覆盖前 5 个。
  源码位置: packages/node-modules-tools/src/types/node.ts:9
  源码位置: packages/node-modules-tools/src/resolve.ts:74-78（unknown 的产生处，在调用方）

- **算法来源注释**：文件头注明移植自 `wooorm/npm-esm-vs-cjs` 与 `npmx-dev/npmx.dev` 两个上游项目的 crawl/analysis 脚本。这意味着本章教学的事实基础是「社区共识的启发式」，不是 Node 规范的官方实现。
  源码位置: packages/node-modules-tools/src/analyze-esm.ts:1-3

- **早退 1：`@types/` 前缀 → dts**。在所有其它判定之前。理由：`@types/*` 是 DefinitelyTyped 约定，永远只发类型声明，没有运行时代码。
  源码位置: packages/node-modules-tools/src/analyze-esm.ts:67-68

- **三个布尔信号**：`hasImport`/`hasRequire`/`hasModule`——前两个对应 `exports` 条件树里的 `import`/`require` 条件名（Node 的 conditional exports），第三个对应 `module` 这个**非标准但事实存在**的条件名（部分老包用 `module` 当 exports 子键）。
  源码位置: packages/node-modules-tools/src/analyze-esm.ts:8-12

- **递归遍历 `analyzeExports`**：3 个分支——字符串叶子（看后缀）、数组（合并所有元素）、对象（既看 key 名又递归 value）。每个分支都会调用 `mergeAnalysis` 把子结果合并回父。
  源码位置: packages/node-modules-tools/src/analyze-esm.ts:17-57

- **深度防爆**：`depth > 10` 直接返回空结果，不再继续递归。这是病态嵌套的兜底——但 10 这个数字本身无注释说明，是个经验值。
  源码位置: packages/node-modules-tools/src/analyze-esm.ts:24-25

- **字符串叶子的扩展名表**：`.mjs`/`.mts` → import；`.cjs`/`.cts` → require；其它后缀（含 `.js`）**不置任何信号**——因为 `.js` 的解释依赖 `type` 字段，不能从后缀单独决定。
  源码位置: packages/node-modules-tools/src/analyze-esm.ts:29-35

- **三布尔分派顺序（exports 存在时）**：① import∧require → dual；② import∨module → 默认 esm，但若 hasMain ∧ ¬isTypeModule 则降为 dual；③ require 独占 → 默认 cjs，但若 hasModule 则升为 dual；④ 都没命中 → **穿透到 legacy 路径**（不是直接判 cjs）。
  源码位置: packages/node-modules-tools/src/analyze-esm.ts:79-96

- **Legacy 决策树（exports 缺失或穿透时）**：① module ∧ main → main 后缀 `.cjs` 或（`.js` ∧ ¬isTypeModule）→ faux，否则 esm；② module 独占 → faux；③ isTypeModule ∨ main 后缀 `.mjs` → esm；④ main 独占 → cjs。
  源码位置: packages/node-modules-tools/src/analyze-esm.ts:99-112

- **早退 2 + 默认**：① `pkgJson.types || pkgJson.typings` → dts（纯类型包）；② 都没有 → 兜底 cjs。
  源码位置: packages/node-modules-tools/src/analyze-esm.ts:115-118

- **公开导出与常量**：函数从包入口 re-export；常量 `PackageModuleTypes` 是 `Object.freeze(['cjs','esm','dual','faux','dts'])`——**注意：这个常量不含 `'unknown'`**，与类型 union 不一致，UI 端的展示循环用的是这个 frozen 数组而非 union。
  源码位置: packages/node-modules-tools/src/index.ts:2
  源码位置: packages/node-modules-tools/src/constants.ts:3

- **调用点**：上游 `resolvePackage` 读到 package.json 后立即调用本函数，结果写入 `pkg.resolved.module`，是整个 resolve 流水线里最早完成的字段之一（无 IO、可与 normalizeAuthors 等并发前的同步部分）。
  源码位置: packages/node-modules-tools/src/resolve.ts:64

- **UI 侧标签与颜色**：5 个枚举对应 UI 名（`ESM`/`DUAL`/`CJS`/`FAUX`/`DTS`/`?`）和 badge 色。`faux` 单独标 lime 色（视觉上区别于 esm 的 green）——这是 faux 这一独立类存在的「产品意图」证据：**它不是 cjs，也不是 esm，是一种需要用户警惕的中间态**。
  源码位置: packages/node-modules-inspector/src/app/utils/module-type.ts:9-25

- **faux 在 UI 端可被「软化」**：`settings.treatFauxAsESM` 开关会把 faux 显示成 esm。说明 faux 的边界本身就是「模糊灰区」，作者把它做成可配置。
  源码位置: packages/node-modules-inspector/src/app/utils/module-type.ts:30-31

## 关键调用链

```
resolvePackage()                    [resolve.ts:48]
  └─ readFile(package.json)
  └─ analyzePackageModuleType(json) [analyze-esm.ts:65]   ← 本章主角
       └─ analyzeExports(exports)   [analyze-esm.ts:17]   ← 递归遍历
            └─ mergeAnalysis(...)    [analyze-esm.ts:59]   ← 三布尔合并
  └─ pkg.resolved.module = <标签>   [resolve.ts:64]

UI 端消费：
  getModuleType(node)               [module-type.ts:27]
    → 读 node.resolved.module → 应用 treatFauxAsESM / moduleTypeSimple 软化
```

## 源码摘录（带行号，全文累计 26 行）

**递归遍历对象分支——key 名嗅探 + 继续下钻（核心机制）**：
```ts
// packages/node-modules-tools/src/analyze-esm.ts:43-54
  if (typeof exports === 'object') {
    for (const [key, value] of Object.entries(exports as Record<string, unknown>)) {
      if (key === 'import')
        result.hasImport = true
      else if (key === 'require')
        result.hasRequire = true
      else if (key === 'module')
        result.hasModule = true

      mergeAnalysis(result, analyzeExports(value, depth + 1))
    }
  }
```

**exports 存在时的三布尔分派（dual / esm / dual-via-main / cjs / dual-via-module）**：
```ts
// packages/node-modules-tools/src/analyze-esm.ts:79-92
    if (exportInfo.hasImport && exportInfo.hasRequire)
      return 'dual'

    if (exportInfo.hasImport || exportInfo.hasModule) {
      if (hasMain && !isTypeModule)
        return 'dual'
      return 'esm'
    }

    if (exportInfo.hasRequire) {
      if (hasModule)
        return 'dual'
      return 'cjs'
    }
```

## 易混淆 / 边界 / 推断

- **事实**：本函数**永远**返回 `'cjs' | 'esm' | 'dual' | 'faux' | 'dts'` 五者之一，从不返回 `'unknown'`。`'unknown'` 是调用方 `resolvePackage` 在 package.json 文件**不存在**于磁盘时填入的（例如 optionalDependencies 没装上的情况）。
  源码位置: packages/node-modules-tools/src/resolve.ts:73-79

- **事实**：`'dts'` 有两条产生路径——(a) 包名以 `@types/` 开头（早退 1，第 67-68 行）；(b) 无 exports/main/module/type 但有 `types`/`typings` 字段（早退 2，第 115-116 行）。前者是「命名约定判定」，后者是「字段存在判定」，两者机制完全不同但都映射到同一标签。

- **事实**：当 `exports` 字段存在但条件树里**完全没出现** import/require/module 任何一个 key 时（例如只有 `default`/`types`/`node` 等其它条件），代码会**穿透**到 legacy 路径继续按 main/module/type 判——这是非直觉的隐性行为。源码注释里写明：「exports exists but no clear import/require/module conditions → Fall through to legacy detection」。
  源码位置: packages/node-modules-tools/src/analyze-esm.ts:94-96

- **推断（标注为推断）**：第 24 行的 `depth > 10` 是个防病态嵌套的兜底，但 **10 这个数字**没有源码注释或测试说明其依据——很可能是经验值。配套测试用 `nestExports(11, './index.mjs')` 验证「11 层嵌套 .mjs 字符串」会被截断成默认 cjs（因为深度截断后三布尔全空，落入 legacy 又无 main/module → 默认 cjs）。
  源码位置: packages/node-modules-tools/src/analyze-esm.test.ts:24-28

- **推断（标注为推断）**：`hasModule` 信号同时承担两个语义——(a) `exports` 条件树里出现 `module:` 子条件（这是 webpack/rollup 等打包器约定的非官方条件名）；(b) 是后面 `pkgJson.module` 字段判定的中间变量名复用。从代码看 (a) 才是 `analyzeExports` 内 `hasModule` 的真实含义；而 `pkgJson.module` 的存在性由 `analyzePackageModuleType` 局部变量 `hasModule`（第 71 行）单独承载——**两个 `hasModule` 是不同作用域的不同变量**，初读时极易混淆。
  源码位置: packages/node-modules-tools/src/analyze-esm.ts:49-50（exports 内的 module 信号）
  源码位置: packages/node-modules-tools/src/analyze-esm.ts:71（外层的 pkgJson.module 探测）
  源码位置: packages/node-modules-tools/src/analyze-esm.ts:82, 89, 105（外层 hasModule 的三处使用点）

- **事实**：fixture 测试覆盖了 8 个真实包快照——包括 dual（vue、rollup-plugin-esbuild）、esm（p-limit、@octokit/core、@octokit/rest）、cjs（debug、lodash）、dts（type-fest），但**没有 faux 的快照**——faux 路径目前只有逻辑覆盖、没有真实包回归。
  源码位置: packages/node-modules-tools/test/fixtures/package-json-snapshots.ts:9-115

- **事实**：`PackageModuleTypes` 这个 frozen 数组（用于 UI 遍历）刻意**省略了 `'unknown'`**——与类型 union 不一致。说明作者把 unknown 视为「不应出现在 UI 选项里」的兜底态。
  源码位置: packages/node-modules-tools/src/constants.ts:3

- **未理解**：在 `exports` 既无 import 又无 require 但有 `module` 的极端情况下（即 `analyzeExports` 只置了 hasModule=true），代码会进入 `hasImport || hasModule` 分支返回 esm——但这种 exports 写法在真实包里是否存在、是否有意为之，本仓库无对应 fixture 验证。

- **未理解**：legacy 路径里 `module + main` 同时存在且 main 以 `.mjs` 结尾时返回 `'esm'`（第 102 行）——这是「bundler 拿 module、Node 拿 .mjs main，两边都是 ESM」的语义；但理论上 bundler 也可能 prefer `module` 字段（依工具而异），此处的判定是否与所有主流 bundler 一致，需对照 webpack/rollup/vite 的实际解析行为才能确认。
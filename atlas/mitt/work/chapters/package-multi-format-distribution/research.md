# 一源多格式通吃所有 JS 运行时 · 源码精读

## 给 Writer 的教学钩子（必填，8 子项缺一不可）

- **用户痛点 / 场景**：你写好一个 TS 库发布到包仓库，结果四种消费者各报各的错——有人用 `require` 引不到入口、有人用打包器 tree-shaking 失效（吃到了 CommonJS 而非 ES 模块）、有人想直接用 `<script>` 引入却发现没有全局变量、有人在类型检查器里 import 报「找不到类型声明」。一份源码，四种期待，怎么让所有人无摩擦地用上同一个函数？这就是「多格式分发」要解决的问题。

- **一句话核心思想**：一次编译出三套模块外壳（ESM / CJS / UMD），再靠包清单里的**条件映射**，让每个运行时敲门时自动领走它认的那一份。

- **设计动机（为什么需要它）**：JS 生态从来没有一个统一的「库如何被消费」标准——ES 模块、CommonJS、UMD、类型声明各自为政，且不同年代的工具读不同的字段。一个库要成为「生态公民」被所有运行时无摩擦消费，就必须在发布层加一道**纯运行时之外的适配层**，把同一个导出包装成三套模块外壳、再给每种消费者标好它该走哪个入口。本章正是这道适配层。
  - **承前关系（供 Writer 跨章去重）**：
    - 第 2 章『函数工厂与无 this 的方法』已讲透 `mitt()` 是一个「靠闭包、不靠 this」的 default export 工厂——**本章只看这个 default export 被三种模块系统分别套上外壳后如何递交**：运行时形态完全不变，变的只是「外层模块包装」。不要在本章重讲函数式方法原理。
    - 第 7 章『一张 Events 映射派生全 API 类型』已讲透类型如何从一张映射反向推导——**本章只看这套派生好的类型如何作为「类型声明产物」被类型检查器解析到**：类型推导原理不复述，只看「类型声明作为发布物如何分发」。

- **关键权衡（本 Atlas 的核心）**：
  1. 选择**同时保留一套现代条件映射字段和一套旧的扁平入口字段** → 换来「新工具按条件精确匹配、旧工具/旧运行时按扁平字段兜底，新旧生态都能无摩擦消费」 → 代价是「两套字段必须**手工保持指向一致**（指向 ES 模块产物的有三处、指向 CommonJS 产物的有两处），任一处错位就会在某些工具下静默解析到错误产物且无报错」。
  2. 选择**用一条多格式打包命令从单一源文件一次产出 ESM/CJS/UMD 三套外壳** → 换来「单一真源、消费端零配置适配、三产物行为天然一致」 → 代价是「构建工具链变厚（多格式打包器隐式拉起转译 + 压缩 + 模块封装链路），三产物的体积与语义一致性完全依赖打包工具而非人工校验」。
  3. 选择**把类型声明当作构建产物（而非版本控制里手工长期维护的源文件）** → 换来「源码仓库纯净、类型声明自动随构建刷新、发布白名单只需声明产物名」 → 代价是「类型与实现的对齐质量完全交给打包工具的类型生成；若生成有偏差，类型与真实行为会静默漂移」。（**注意：本章核实到的事实与原始章节摘要里「手工对齐的类型声明」措辞相反**——该声明文件实际被版本控制忽略、由构建生成，详见下方「易混淆/边界/推断」分区，请 Writer 据实修正。）
  4. 选择**在条件映射里把类型条件置于所有其他条件之前** → 换来「类型检查器按顺序匹配时最先命中类型声明」 → 代价是「该顺序是**隐性硬约束**（官方规定类型条件必须先于导入/要求条件），违反则类型声明被静默忽略且无报错」。

- **最小心智模型（条件映射如何路由，6 步）**：
  1. 消费者带着「我是什么环境」的条件来敲门（导入 / 要求 / 求类型 / 或什么条件都不带）。
  2. 工具读取包清单里的「条件映射」对象。
  3. **按条件键书写的先后顺序逐个匹配**（这是有序匹配，不是「谁优先级最高」）。
  4. 命中第一个满足的条件，返回它指向的物理产物文件。
  5. 若消费者是旧工具、不认条件映射，则退回去读那套扁平入口字段（主入口 / 模块入口 / 类型入口等）做兜底。
  6. 各格式产物本身，已在构建阶段被预先按 ESM / CJS / UMD 三套模块语义包装好——路由只是「选哪份已包装好的文件」，包装发生在更早的构建步。

- **最小原理演示（替代旧"复刻范围"）**：
  - **应演示**：一个极简的「条件路由解析器」纯函数——输入「消费者带来的条件」+「条件映射对象」，输出命中的产物文件；再加三份各一行的 mock 产物（ESM 写 `export default`、CJS 写 `module.exports=`、UMD 写挂全局），演透「**同一逻辑入口、按条件分流到不同物理文件**」这一核心思想。每一段都要对应上面某条权衡（解析器演「有序匹配」、三份 mock 演「一次产出三外壳」）。
  - **应故意省略**：真正的打包工具链（无需真的去跑多格式打包器）、ESM/CJS/UMD 之间深层的运行时互操作陷阱、IE9 兼容所需的 polyfill 细节、CDN 版本与缓存语义、`files` 白名单与 `.npmignore` 的发布机制。
  - **演示载体建议（Writer 据此执行）**：**首选 TS/JS**，配最小 `package.json` 用 `node` 直接跑。理由——「条件映射路由」本质上是一个**有序键匹配的纯逻辑**，与任何打包工具无关，TS/JS 能最忠实地演透，且本 Atlas 产物本身就是 JS 生态站点、TS/JS 演示对读者最友好。**无需退回原仓库的工具链**——多格式打包器只是「生产这些产物的手段」，不是本章要教的原理。

- **正文不宜展开的细节**：`jsnext:main` 这一字段的 rollup 历史渊源（已被 `module` 取代、保留仅为兼容）；本库未使用的 `browser` 字段；多格式打包器内部如何调度转译/压缩；`.npmignore` 与 `files` 的发布白名单关系；ESM/CJS dual-package hazard（本库因纯函数无副作用、影响极小，可一笔带过）；`jsnext:main` 与 `module` 指向同一文件造成的字段重复。

- **推荐的一个执行轨迹例子**：四种消费者分别敲门——
  - 「`require`」敲门 → 条件映射命中**要求**条件 → 拿到 CommonJS 产物（`module.exports = mitt`）；
  - 「打包器 `import`」敲门 → 命中**导入/模块**条件 → 拿到 ES 模块产物（`export default mitt`）；
  - 「浏览器 `<script>`」敲门（无模块系统）→ 拿到 UMD 产物 → UMD 自适配探测全局，挂到 `window.mitt`；
  - 「类型检查器」敲门 → 命中位于首位的**类型**条件 → 拿到类型声明产物。
  （演的是「同一次敲门、四个出口」，不是演打包过程。）

> 以上钩子供 Writer 写「动机→核心思想→心智模型→关键权衡→原理演示」；下面事实部分供核对，不要被 Writer 当目录照抄。

## 概念要点

- **三套模块外壳来自同一条构建命令**：构建脚本用一条多格式打包命令 `microbundle -f es,cjs,umd` 从单一源 `src/index.ts` 一次产出 ESM/CJS/UMD 三份产物。源码位置: package.json:24。`-f es,cjs,umd` 即 formats 列表。源码位置: package.json:24
- **产物文件名遵循打包器的命名约定**：三份产物分别是 `dist/mitt.mjs`（ES 模块）、`dist/mitt.js`（CommonJS）、`dist/mitt.umd.js`（UMD）——名字由包名 `mitt` + 格式后缀拼出，被多个入口字段引用。源码位置: package.json:5-8
- **条件映射 `exports` 是核心路由表**：它把「消费者条件」映射到「产物文件」，且**类型条件 `types` 必须排在第一位**（类型检查器按顺序匹配，类型须先于其他条件，这是隐性硬约束）。源码位置: package.json:11-17
- **条件映射里同一份产物被多个条件指向**：ES 产物 `dist/mitt.mjs` 被 `module`、`import`、`default` 三个条件同时指向；CommonJS 产物 `dist/mitt.js` 被 `require` 指向。源码位置: package.json:13-16
- **扁平入口字段是给「不认条件映射的旧工具」的兜底**：`main`（CommonJS 兜底）、`module`（ES 模块，给打包器）、`typings`（类型，旧字段名）、`jsnext:main`（早期 rollup 的 ES 模块约定，现已被 `module` 取代但保留兼容）、`umd:main`（打包器专用的 UMD 入口标记）、`source`（打包器专用的「源入口」标记）。源码位置: package.json:5-10
- **类型声明是构建产物、非版本控制内的源文件**：`index.d.ts` 被 `.gitignore` 忽略、`git ls-files` 确认未被跟踪；项目 `tsconfig.json` 设 `noEmit:true`（tsc 不产出任何文件）；scripts 里没有任何「生成类型声明」的独立命令。结合构建命令存在，**推断**该声明由多格式打包器在构建时从 `src/index.ts` 生成。源码位置: .gitignore:1,5；tsconfig.json:5-6；package.json:24
- **发布白名单只含两样**：`files` 字段限定发布到包仓库的只有 `dist`（三份产物）和 `index.d.ts`（类型声明），源码与测试都不发布。源码位置: package.json:42-45
- **README 给出的兼容宣称与消费矩阵**：宣称「为浏览器而生、但在任何 JS 运行时可用、零依赖、支持 IE9+」；并示范三种消费方式——打包器 `import`、CommonJS `require`、UMD `<script>`（挂到 `window.mitt`）。源码位置: README.md:19, 40-54
- **被分发的是唯一一个 default export**：源码只导出一个 `export default function mitt`，三套外壳包装的都是这一个函数——「分发」不改变运行时形态，只改变模块外壳。源码位置: src/index.ts:46

## 关键调用链

**构建链（一次产三壳 + 类型）**：
`src/index.ts`（单一源）→ `microbundle -f es,cjs,umd`（package.json:24）→ `dist/mitt.mjs` + `dist/mitt.js` + `dist/mitt.umd.js` + `index.d.ts`
源码位置: package.json:9,24；.gitignore:1,5（dist 与 d.ts 均为产物、不入版本控制）

**分发链（四消费者各走一条出口）**：
- 现代打包器 / Node ESM（`import`）→ `exports` 命中 `import`/`module` → `dist/mitt.mjs`（`export default mitt`）。源码位置: package.json:13-14
- Node `require` → `exports` 命中 `require`（旧 Node 退回读 `main`）→ `dist/mitt.js`（`module.exports = mitt`）。源码位置: package.json:6,15
- 浏览器 `<script>`（无模块系统）→ UMD 自适配探测全局 → `dist/mitt.umd.js` → `window.mitt`。源码位置: package.json:8；README.md:48-54
- 类型检查器 → `exports` 命中**首位** `types`（旧工具退回读 `typings`）→ `index.d.ts`。源码位置: package.json:10,12

## 源码摘录（带行号，全文累计 ≤ 30 行）

**摘录 1 — 入口字段 + 条件映射路由表（核心，演「权衡 1/4」）**：package.json:5-17
```json
  "module": "dist/mitt.mjs",
  "main": "dist/mitt.js",
  "jsnext:main": "dist/mitt.mjs",
  "umd:main": "dist/mitt.umd.js",
  "source": "src/index.ts",
  "typings": "index.d.ts",
  "exports": {
    "types": "./index.d.ts",
    "module": "./dist/mitt.mjs",
    "import": "./dist/mitt.mjs",
    "require": "./dist/mitt.js",
    "default": "./dist/mitt.mjs"
  },
```

**摘录 2 — 一命令出三格式（演「权衡 2」）**：package.json:24
```json
    "bundle": "microbundle -f es,cjs,umd",
```

**摘录 3 — 发布白名单只含产物（演「类型声明是产物」）**：package.json:42-45
```json
  "files": [
    "dist",
    "index.d.ts"
  ],
```

**摘录 4 — README 的兼容宣称（演「通吃所有运行时」的动机）**：README.md:19
```
Mitt was made for the browser, but works in any JavaScript runtime. It has no dependencies and supports IE9+.
```

**摘录 5 — UMD 消费方式（演「浏览器这条出口」）**：README.md:48-54
```html
The UMD build is also available on unpkg:

<script src="https://unpkg.com/mitt/dist/mitt.umd.js"></script>

You can find the library on `window.mitt`.
```

## 易混淆 / 边界 / 推断

- **事实**：`index.d.ts` 是构建产物，非手工维护的源文件。证据三连——(a) `.gitignore:5` 显式忽略 `/index.d.ts`；(b) `git ls-files` 确认它未被版本控制跟踪；(c) `tsconfig.json` 设 `noEmit:true` 使项目 tsc 不产出任何文件，且 scripts 中无生成类型声明的独立命令。
- **推断（标注为推断）**：`index.d.ts` 由 `microbundle -f es,cjs,umd` 在构建时从 `src/index.ts` 自动生成（多格式打包器默认具备从 TS 源生成类型声明的能力，且构建命令存在、无其他类型生成途径）。**请 Writer / Critic 注意**：原始章节摘要（outline.json 本章 summary）称「一份需手工对齐的 index.d.ts」，与上述事实**不符**——应是构建自动生成、而非手工对齐；Writer 正文请据实表述为「类型声明作为构建产物自动生成」，权衡的代价应表述为「类型对齐质量依赖打包工具的生成正确性」而非「手工同步」。
- **推断（标注为推断）**：三份产物文件名（`mitt.mjs`/`mitt.js`/`mitt.umd.js`）遵循 microbundle 的「包名 + 格式后缀」命名约定（`es→.mjs`、`cjs→.js`、`umd→.umd.js`）。依据是字段指向与产物后缀的对应关系；本仓库未含 `dist/`（构建产物、`.gitignore:1` 忽略），故无法直接读取产物内容做实证。
- **事实**：`exports` 内 `types` 条件位于首位（package.json:12），这是 TypeScript 解析 `exports` 时的强制要求——`types` 必须先于 `import`/`require` 出现，否则类型解析静默失败。该约束在 `package.json` 本身无任何注释提示，属隐性约定。
- **事实**：`jsnext:main` 与 `module` 指向同一文件 `dist/mitt.mjs`（package.json:5,7），属字段冗余——`jsnext:main` 是 rollup 早期推广 ES 模块的约定，现已被行业标准 `module` 取代，保留仅为兼容极旧打包器。
- **事实**：`umd:main` 与 `source` 是**打包器（microbundle）私有的约定字段**，非 npm/Node 公认字段——它们不出现在 `exports` 里，仅供打包器读取以定位「UMD 入口」与「源入口」。读者需区分「npm 公约字段（main/module/exports/typings）」与「工具私有字段（source/umd:main/jsnext:main）」。
- **边界**：本章 sourceFiles 为 `package.json` 与 `README.md`，均为**配置/文档**而非运行时代码；本章原理集中在「发布层的适配策略」，无运行时算法。`dist/` 产物不在源仓库（被 `.gitignore` 忽略），故无法读取产物实证其模块外壳语句（如 `export default` / `module.exports`），相关表述为基于打包器约定与字段指向的推断。
- **未理解**：`tsconfig.json` 同时设 `noEmit:true` 与 `declaration:true`（tsconfig.json:5-6）看似矛盾（声明开启却不产出）——其作用大概率仅服务于编辑器/类型检查（`npm run typecheck` 即 `tsc --noEmit`），实际类型声明产出完全由打包器接管；此为推断，未在仓库中找到直接说明。
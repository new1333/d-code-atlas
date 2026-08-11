# 一源多格式通吃所有 JS 运行时

> 本章属于 system 层。前置：函数工厂与无 this 的方法、一张 Events 映射派生全 API 类型。
> 学完你能：用一句话讲清「为什么一份 TS 源码要让四种消费者各拿各的产物，以及靠条件映射做路由时付出的是什么代价」。

## 1. 为什么需要它（设计动机）

前八章把 mitt 的运行时机制和类型派生都讲透了——上一章刚讲完「条件类型区分可选载荷事件」，源码层面已经无可再加。但合上源码、要发布出去时，留下的最后一个口子是：**怎么让这一份逻辑，被四个年代的运行时各自无摩擦地用上**。本章正是这道发布层的适配。

把源码发到 npm，下面四种消费者会各报各的错：

- 用 `require` 的老 Node 脚本——它要的是 CommonJS，拿到 ES 模块就 `SyntaxError`；
- 用 `import` 的现代打包器——它要的是 ESM，吃到 CommonJS 就 tree-shaking 失效；
- 浏览器里 `<script>` 直接引入——它没有模块系统，要的是 UMD，能挂到 `window.mitt`；
- 类型检查器——它要的是 `.d.ts` 类型声明，找不到就报「找不到类型定义」。

JS 生态从来没有统一的「库如何被消费」标准。ES 模块、CommonJS、UMD、类型声明各自为政；不同年代的工具读不同的字段。要成为「生态公民」被所有运行时无摩擦消费，就必须在发布层加一道**纯运行时之外的适配层**——它不改 mitt 的运行时形态（前八章定下来的东西一行不动），只决定「这份逻辑被装进哪种模块外壳、交到哪种消费者手里」。

## 2. 核心思想

一次编译出三套模块外壳（ESM / CJS / UMD），再靠包清单里的**条件映射**，让每个运行时敲门时自动领走它认的那一份。

## 3. 心智模型

整个适配层就两个东西：一份产物池、一张路由表。

**产物池**——同一条构建命令从 `src/index.ts` 一次产出三份物理文件，每份被套上不同模块语义的外壳：

| 文件 | 模块语义 | 一句话外壳 |
|------|----------|------------|
| `dist/mitt.mjs` | ES Module | `export default mitt` |
| `dist/mitt.js` | CommonJS | `module.exports = mitt` |
| `dist/mitt.umd.js` | UMD | 探测到模块系统就交给它，否则挂到全局 `window.mitt` |

外加一份 `index.d.ts`——类型声明产物，给类型检查器读的。

注意被包装的是**同一个** default export 函数。第 2 章「函数工厂与无 this 的方法」里那个 `mitt()` 一旦被调用，三份产物里的行为完全一致；不一样的只是「这函数是怎么被装进调用者手里的」。

**路由表**——`package.json` 里的 `exports` 字段就是这张表。消费者敲门时带着「我是什么环境」的条件（`import` / `require` / `types` / 什么都没带），路由表按字段书写的先后顺序逐个匹配，第一个命中的条件指向哪份产物，就把哪份产物交出去。

不认 `exports` 的旧工具怎么办？还有一组更老的扁平字段兜底——`main`、`module`、`typings`——它们直接说「CommonJS 走这里」「ESM 走这里」「类型走这里」，没有条件判断，照着读即可。

## 4. 关键权衡

### 双轨入口换来新旧工具通吃，代价是手工对齐的隐性耦合

`package.json` 里同时保留了两套入口字段：

```json
{
  "main":    "dist/mitt.js",
  "module":  "dist/mitt.mjs",
  "typings": "index.d.ts",
  "exports": {
    "types":   "./index.d.ts",
    "import":  "./dist/mitt.mjs",
    "require": "./dist/mitt.js",
    "default": "./dist/mitt.mjs"
  }
}
```

上面那一组扁平字段（`main`/`module`/`typings`）是更早年代的入口约定，没有条件判断能力；下面那一组 `exports` 才是现代条件映射。两套同时存在，换来的是「新版打包器、新版 Node 走 `exports` 精确匹配；老 Node、老工具退回去读扁平字段兜底」——两代生态都能无摩擦消费。

代价是一份隐性耦合：两套字段必须**手工指向一致**。指向 ES 产物的字段散落在 `module`、`exports.import`、`exports.default` 多处；指向 CommonJS 的有 `main`、`exports.require`。任意一处错位，工具会静默解析到错误产物，不报错——`module` 指到 CJS 文件就 tree-shaking 失效，`require` 指到 ESM 文件就运行时 `SyntaxError`，且都是「发布出去之后用户那边才暴露」。

**化解的本质矛盾**：新生态需要条件映射的精确性，旧生态只认扁平字段——同一份包要同时被两代工具认出来，就只能背两套字段、自己保证一致。这不是 mitt 的特殊选择，而是任何想跨年代存活的 JS 库都要吃的税。

### 类型声明作为构建产物自动生成，代价是类型对齐质量交给打包器

仓库里看不到手工维护的 `index.d.ts`——它被 `.gitignore` 显式忽略：

```json
// .gitignore
/index.d.ts
/dist
```

类型声明是构建时由 `microbundle` 从 `src/index.ts` 自动生成出来的，发布时跟着 `dist/` 一起进 npm 包。`tsconfig.json` 设了 `noEmit:true`，项目自己的 tsc 根本不产出任何文件——声明完全由打包器接管。发布白名单因此只需写两行：

```json
"files": ["dist", "index.d.ts"]
```

换来的是源码仓库纯净（类型声明不和源码抢版本控制空间）、类型自动随构建刷新（不会出现「源码改了类型没跟上」）、发布清单极简。

代价是类型与实现的对齐质量**完全交给打包工具**。源码里加了一个新导出，打包器若没正确识别、`.d.ts` 就会少一项，类型检查器看到的是「类型与实现不一致」——且这种漂移在源码仓库里看不见（声明根本没入库），只在用户那边导入时才暴露。

**化解的本质矛盾**：源码仓库要纯净、类型声明又要随源码变化保持新鲜——把声明当成「源码的编译产物」而非「源码的兄弟文件」就同时满足了两者，代价是把生成正确性的责任压到工具链上。这和「把锁文件提交进版本控制」恰好相反：声明主动选择不入库，是因为它「能被自动重建」。

### `types` 钉在 `exports` 首位换来类型检查稳定命中，代价是一条隐性硬约束

```json
"exports": {
  "types":   "./index.d.ts",   // 必须排在第一位
  "import":  "./dist/mitt.mjs",
  "require": "./dist/mitt.js"
}
```

TypeScript 解析 `exports` 时**按顺序逐个匹配**——`types` 必须出现在 `import`、`require` 之前，否则类型声明被静默忽略、且没有任何报错。这是 TypeScript 解析 `exports` 时的强制要求，但 `package.json` 里没有任何注释提示这个顺序约束。

换来的是「类型检查器最先敲到 `types`、拿到声明产物就退场」，不让运行时条件意外遮蔽类型条件。

代价是一条**隐性硬约束**——后人若把 `import` 提到 `types` 前面（看起来更「自然」），类型解析会静默失败：IDE 提示消失、`tsc` 报「找不到类型定义」，但 `package.json` 本身读起来毫无问题。读者回头审视上面三段权衡，会发现「静默失败且无报错」是这套适配层的共通代价——路由逻辑全靠约定，约定一旦违反没有任何兜底。

**化解的本质矛盾**：同一个 `exports` 既要被运行时（Node、打包器）读，又要被类型检查器读——而类型检查器是「按顺序匹配第一个命中」的简单逻辑，要让它可靠命中类型，就只能把类型条件钉在第一位，让运行时条件退居其后。

## 5. 最小原理演示

下面这段代码不真的去跑打包器——打包器只是「生产产物」的手段，不是本章的原理。本章的原理是「**条件映射如何路由**」，一个纯逻辑函数。

```ts
// 三份 mock 产物，每份一行，演「同一逻辑入口的三套模块外壳」
const artifacts = {
  esm:   `export default mitt`,
  cjs:   `module.exports = mitt`,
  umd:   `typeof window!=='undefined' && (window.mitt = mitt)`,
  types: `declare const mitt: () => void`
}

// 包清单里的「条件映射路由表」——有序对象，键书写顺序即匹配顺序
const pkgExports = {
  types:   artifacts.types,   // 类型条件必须排在首位
  import:  artifacts.esm,     // 现代打包器 / Node ESM
  require: artifacts.cjs,     // Node CJS
  default: artifacts.esm      // 啥都不带的兜底
}

// 扁平入口字段——给不认 exports 的旧工具做兜底
const flatEntries = {
  main:    artifacts.cjs,
  module:  artifacts.esm,
  typings: artifacts.types
}

// 路由函数：输入「消费者带来的条件」，输出命中的产物
function resolveArtifact(consumerConditions: string[]): string {
  // 按 exports 键书写顺序逐个匹配，命中第一个就返回
  for (const [condition, artifact] of Object.entries(pkgExports)) {
    if (consumerConditions.includes(condition)) return artifact
  }
  // 旧工具没带任何条件、或不认 exports，退回扁平字段
  return flatEntries.main
}

// 四种消费者敲门——演「同一逻辑入口、按条件分流到不同物理产物」
resolveArtifact(['require'])   // → module.exports = mitt
resolveArtifact(['import'])    // → export default mitt
resolveArtifact(['types'])     // → declare const mitt...
resolveArtifact([])            // → module.exports = mitt（旧工具兜底）
```

把四份输出放在一起看，最直观地体现了核心思想：**敲门时带的条件不同，领到的产物就不同**；产物本身的内容早在构建时就定型了，路由层只决定「选哪份」。

## 6. 执行轨迹

四种消费者依次敲门：

- **Node `require('mitt')`** → Node 带 `['require']` 条件 → `exports` 按顺序匹配：`types` 不命中、`import` 不命中、`require` 命中 → 拿到 `dist/mitt.js`（`module.exports = mitt`）→ `require()` 返回这个对象，调用方拿到 `mitt` 函数。老版 Node 不认 `exports`，退回去读 `main`，同样指向 `dist/mitt.js`，结果一致。
- **打包器 `import mitt from 'mitt'`** → 打包器带 `['import']`（或更宽泛的模块解析条件）→ 命中 `import` → 拿到 `dist/mitt.mjs`（`export default mitt`）→ 打包器把这份 ESM 喂进依赖图，可以静态分析、做 tree-shaking。
- **浏览器 `<script src=".../mitt.umd.js">`** → 没有模块系统、没条件可带 → 直接加载 UMD 产物 → UMD 在加载时自适配探测：发现 `module`、`exports` 就走 CommonJS 协议；都没有就把 `mitt` 挂到 `window`。用户在 console 里敲 `window.mitt` 就拿到函数。
- **类型检查器 `tsc`** → 带 `['types']` 条件 → 命中位于首位的 `types` → 拿到 `index.d.ts` → 后续 `import` 语句的类型检查都基于这份声明。

整个流程的关键是：**四条出口都在同一次「找包」动作里被分流**，没有运行时分支判断；分流发生在构建时（产物被预先包装好）和解析时（路由表把敲门条件映射到产物文件名）。

## 7. 教学简化说明

本章演示故意省略了：

- 真正的打包工具链（microbundle 如何调度转译、压缩、模块封装，与原理无关）；
- ESM 与 CJS 在 Node 里互操作时的 dual-package hazard（mitt 是纯函数无副作用、影响极小）；
- UMD 探测全局的完整逻辑（演示里只写了一行挂 `window`，真实 UMD 还要兼容 AMD/CommonJS）；
- IE9+ 兼容所需的 polyfill 细节、CDN 版本与缓存语义、`.npmignore` 与 `files` 的发布白名单机制。

## 8. 小结

mitt 的运行时机制和类型派生前面都讲透了，最后这一章只多了一件事：把同一份逻辑装进三套模块外壳，再用一张有序的条件映射让每种运行时敲门时领走自己认的那一份。多格式的代价不在运行时，全在发布层的「字段对齐」和「顺序约束」这些隐性耦合里——错了不报错，只在用户那边暴露。

至此，从 `Map<EventType, Handler[]>` 这张查找表起步，走过闭包存储、惰性追加、无分支移除、快照派发、通配符第二条路径、Events 映射派生类型、条件类型可选载荷，最后落到「一份源码、三套外壳、一张路由表」——mitt 这个小库，从原理到工程交付，章节走完了。

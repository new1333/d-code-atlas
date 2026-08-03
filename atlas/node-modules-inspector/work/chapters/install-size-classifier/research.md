# 安装体积测算与文件类别分类 · 源码精读

## 给 Writer 的教学钩子（必填，8 子项缺一不可）

- **用户痛点 / 场景**：装完 `node_modules` 后想知道「到底哪个包占了我最多空间」「这些空间是测试代码、类型声明、源码还是文档」。没有这个机制时，使用者只能拿 `du -sh` 看到一坨总数，既无法横向比较，也看不出一个包内部的字节构成——「该砍谁、砍哪部分」全靠拍脑袋。

- **一句话核心思想**：**先用一份带过滤的递归把磁盘拍平成文件清单，再用一份顺序敏感的正则级联把每个文件归到唯一桶里，最后并行 stat 累加。**

- **设计动机（为什么需要它）**：体积分析必须在「**够准确**」和「**够快**」之间找平衡。装一个大型 monorepo 可能有上千个包、每个包几千个文件；如果走「读文件内容判断类型」会慢到不可用，走「只看顶层 package.json」又丢失了真实字节分布。本机制的存在是为了在「**纯静态启发式**」这条约束下，给出一份可比较、可下钻、毫秒级完成的字节账单。

- **关键权衡（4 条，本章机制丰富）**：
  1. **遍历期硬过滤 dotfile 与嵌套 node_modules → 换算得快 → 代价是必须信任外层已把每个嵌套包单独列出来**。选择在递归里直接 `continue` 而不是先收集再过滤；换来「不进 `.git`、不进嵌套依赖目录」省下绝大多数 I/O；代价是隐式依赖了上游清单的完整性——上游 agent（pnpm/npm/bun）必须把每个嵌套包作为独立节点喂进来，否则它的字节会从总数里蒸发。
  2. **静态后缀/路径正则级联 → 换毫秒级纯 CPU 分类 → 代价是分类只能靠文件名启发式**。选择不读文件内容、不解析 AST，只看相对路径和后缀；换来万级文件秒级出结果；代价是 `dist/foo.js`（编译产物）和 `src/foo.js`（源码）会被划进同一个桶，无法区分 source vs artifact——分类粒度上限是「文件名能告诉你的」。
  3. **顺序敏感的 if-return 级联（而非配置表） → 换可读性和确定性 → 代价是规则顺序即语义**。选择把所有分类规则写成一长串手写 if-return，而非数据驱动的规则表；换来分支明确、易调试；代价是顺序错了分类就错——「.d.ts 必须在 .ts 之前查」「test 目录必须在 dotfile 之前查」这类不变量没有编译期保护，全靠注释和测试守护。
  4. **稀疏聚合（Partial Record）+ stat 容错回退 0 → 换序列化体积小、整体鲁棒 → 代价是消费方要做 nullish 防御、错误被静默吞掉**。选择 `categories: Partial<Record<FileCategory, {bytes, count}>>`（空桶不出现）+ 单文件 stat 失败回退 0；换来 dto 没有 16 个空字段、一个坏符号链接不会让整个包测算失败；代价是 UI 读 `categories.wasm` 时要自己兜底默认值，且真实磁盘问题被掩盖——体积可能偏低且无人知晓。

- **最小心智模型（6 步）**：
  1. **守卫**：拿到一个包，先做 5 条早退检查（workspace、缺 name/version、名字以 `#` 开头、版本是 `file:/link:/workspace:` 协议、缺磁盘路径）——任一命中即返回 `undefined`，不算体积。
  2. **遍历收集**：从包根目录开始递归 readdir，遇到普通文件 push 进扁平数组，遇到子目录就 recurse 进去——但子目录名以 `.` 开头或等于 `node_modules` 时直接跳过。
  3. **路径相对化**：对每个收集到的绝对路径，转成「相对包根」的路径，作为分类输入（这样分类规则只关心包内结构，不关心包在磁盘哪里）。
  4. **顺序级联分类**：把相对路径拆成「目录段 + 文件名」，按一套预定义的优先级顺序依次匹配（目录级规则优先 → 后缀级规则 → 兜底 'other'）——第一个命中的规则决定类别，剩下规则全部跳过。
  5. **并行 stat**：用 `Promise.all` 一次性发起所有文件的 `fs.stat`，失败回退 0。
  6. **双轴聚合**：一边累加所有字节得到 `bytes`（包总体积），一边按类别累加得到 `categories: { [cat]: { bytes, count } }`（分桶明细）。

- **最小原理演示（替代旧"复刻范围"）**：
  - **应演示**：一个 ~40 行的从零实现，浓缩三件事——(a) 带过滤的递归遍历、(b) 顺序敏感的分类级联（**至少要演 `.d.ts` 必须在 `.ts` 之前这一条权衡**，让读者亲眼看到顺序错了 `.d.ts` 全被算成 `.ts`）、(c) `Promise.all` 并行 stat + 按桶累加。每一段都要标注「演的是上面哪条权衡」。
  - **应故意省略**：5 条早退守卫里的 3 条（保留 workspace 一条演示思想即可）、除 dts/js/ts/json/md 之外的类别（保留 5 类足以演示级联）、count 字段（保留 bytes 即可演思想）、错误回退（演示一条主线、不演防御）、所有类型导出（用 string 字面量即可）。
  - **演示载体建议（Writer 据此执行）**：本仓库是 TS/JS，建议写成一段能 `bun run measure.ts <某个包路径>` 或 `node measure.ts <path>` 直接跑的脚本——**最好真能跑**，让读者能拿自己 `node_modules` 里的任一包验证。输出打印一行 JSON `{ bytes, categories }` 即可。无需 Vue/UI。

- **正文不宜展开的细节**：
  - 16 个 `FileCategory` 字面量的完整清单（贴出来就够了，不必逐个讲）。
  - 类型层与运行时分离（types/size.ts 里的 interface 和 size.ts 里的实现之间的关系）——属于工程组织，不是原理。
  - 上层消费链：`resolvePackage` 何时调用、`computeInstallSizes` 怎么排序、`InstallSize.vue` 怎么渲染——这些是 composite 层章节的事。
  - unocss 颜色映射（每个 FileCategory 对应什么 badge 色）——纯 UI 装饰。

- **推荐的一个执行轨迹例子**：
  - **输入**：一个迷你包，磁盘上是 `pkg/{package.json, README.md, dist/foo.js, dist/foo.d.ts, src/foo.ts, .cache/x.json}`（注意 `.cache` 是 dotfile 目录）。
  - **关键中间态**：(1) 守卫全过 → 进入遍历；(2) 遍历跳过 `.cache`，得到 5 个文件路径；(3) 分类：`package.json → json`、`README.md → doc`、`dist/foo.js → js`、`dist/foo.d.ts → dts`（**关键点：级联里 .d.ts 在 .ts 之前**）、`src/foo.ts → ts`；(4) 并行 stat 拿到 5 个字节数；(5) 按桶累加。
  - **输出**：`{ bytes: <总和>, categories: { json: {bytes, count:1}, doc: {...}, js: {...}, dts: {...}, ts: {...} } }`——`.cache/x.json` 不出现（被遍历跳过），`other` 桶不出现（没人归类进去）。

> 以上钩子供 Writer 写「动机→核心思想→心智模型→关键权衡→原理演示」；下面事实部分供核对，不要被 Writer 当目录照抄。

## 概念要点

- **本文件就两个导出**：`getPackageInstallSize(pkg)` 是异步主入口（返回 `PackageInstallSizeInfo | undefined`），`guessFileCategory(file)` 是同步纯函数（返回 16 种 `FileCategory` 之一）。后者是前者的依赖，也被外部测试独立调用。
  源码位置: packages/node-modules-tools/src/size.ts:5-53, 65-108

- **5 条早退守卫（按代码顺序）**：(1) workspace 包 / 缺 name / 缺 version；(2) name 以 `#` 开头（推断：占位/注释类伪节点）；(3) version 是 `file:`/`link:`/`workspace:` 协议（本地链接，不算独立安装体积）；(4) 缺 `filepath`（包未真正落盘）。任一命中直接 `return undefined`，跳过所有 I/O。
  源码位置: packages/node-modules-tools/src/size.ts:8-15

- **遍历过滤规则的精确语义**：`/^\.|^node_modules$/.test(n.name)` —— 目录名以 `.` 开头（覆盖 `.git`/`.cache`/`.vscode` 等）或严格等于 `node_modules` 时跳过。注意 `node_module`（单数）不会跳过，`mynode_modules` 也不会跳过。
  源码位置: packages/node-modules-tools/src/size.ts:26

- **分类级联的两类规则**：(a) **目录级规则**——`dirs.some(...)` 形式，只要路径里任一目录段命中就归类（test/tests/__tests__ → 'test'，dotfile 目录 → 'other'，bin/binary → 'bin'）；(b) **文件名级规则**——只看 basename 的后缀正则。目录级整体优先于文件名级。
  源码位置: packages/node-modules-tools/src/size.ts:70-76

- **顺序敏感性的两个具体例子（必讲）**：(1) `\.d(?:\.\w+)?\.[cm]?tsx?$`（→ 'dts'）必须出现在 `\.[cm]?tsx?$`（→ 'ts'）之前，否则所有 `.d.ts` 会被吃成 'ts'；(2) `\.map$`（→ 'map'）虽然不与 `.js` 直接冲突（`foo.js.map` 不以 `.js` 结尾），但 `\.test\.\w+$`（→ 'test'）必须出现在 `.js`/`.ts` 之前，否则 `foo.test.ts` 会被算成普通 'ts'。
  源码位置: packages/node-modules-tools/src/size.ts:77-94

- **双轴聚合的数据结构**：`PackageInstallSizeInfo = { bytes: number, categories: Partial<Record<FileCategory, {bytes, count}>> }`。`bytes` 是包总体积（含被算入的所有文件），`categories` 是稀疏映射——只有实际出现过的类别才有 entry，每个 entry 同时记字节和文件数。
  源码位置: packages/node-modules-tools/src/types/size.ts:1-4

- **stat 容错策略**：`getSingleFileSize` 用 try/catch 包住 `fs.stat`，任何异常（broken symlink、权限、文件被并发删除等）回退为 0 字节。异常被吞掉，不上报、不记日志。
  源码位置: packages/node-modules-tools/src/size.ts:55-63

- **并发模型**：`Promise.all(files.map(getSingleFileSize))`——一次性发起所有 stat。无背压、无并发上限。对万级文件的包可能短时占用大量 fd，但 Node 的 fs 池会内部排队。
  源码位置: packages/node-modules-tools/src/size.ts:37

- **类型与运行时分离**：`size.ts` 顶部的 `import type { FileCategory, PackageInstallSizeInfo, PackageNodeRaw } from './types'`——三个核心类型实际定义在 `types/size.ts` 和 `types/node.ts`，通过 `types/index.ts` 聚合后转出口。这是工程组织，不是核心原理。
  源码位置: packages/node-modules-tools/src/size.ts:1, packages/node-modules-tools/src/types/size.ts:1-23, packages/node-modules-tools/src/types/index.ts:1-5

- **被谁调用（连接下游）**：`resolvePackage`（resolve-package-pipeline 章节的主角）在装配 `_pkg.resolved` 时调用本函数，结果挂到 `installSize` 字段。`resolvePackage` 在并发限流（pLimit(10)）下被跑，所以本函数天然是并发场景下的子任务。
  源码位置: packages/node-modules-tools/src/resolve.ts:66

- **被谁消费（连接上游 UI）**：`computeInstallSizes` 读 `pkg.resolved.installSize` 把包按 bytes 倒序排成 top-N 列表；`InstallSize.vue` 把这个列表渲染成「最大体积包」面板；`PercentageFileCategories.vue` 把 `categories` 渲染成按字节占比的彩条；`file-category.ts` 给 16 类各配一个 unocss 颜色。这些都不在本章职责内。
  源码位置: packages/node-modules-inspector/src/shared/reports/sizes.ts:20-33, packages/node-modules-inspector/src/app/components/report/InstallSize.vue:6-11, packages/node-modules-inspector/src/app/utils/file-category.ts:5-22

## 关键调用链
# resolvePackage：把磁盘包变可读节点 · 源码精读

## 给 Writer 的教学钩子（必填，8 子项缺一不可）

- **用户痛点 / 场景**：依赖图刚被物化出来时，每个节点只有「名字 + 版本 + 在磁盘哪儿 + 依赖谁」这套骨架字段——既不知道它是 cjs 还是 esm，不知道作者、协议、安装体积，更不知道有没有官方仓库链接。前端拿到这种节点什么都展示不出来。需要有一个工序，把这些「给人看的信息」从磁盘上的 package.json 里抽出来、规整成统一形态，挂回到同一个节点对象上。

- **一句话核心思想**：**类型按工序分层，对象不重建——同一实例在不同阶段被渐进地「喂」字段**。

- **设计动机（为什么需要它）**：这个机制要解决的矛盾是「**前端要的是富信息节点，但富信息的获取成本极高（多次 fs I/O + 多种归一化）**」。它换来的能力是：(1) 调用方拿到的永远是一个稳定对象引用，可以放心地塞进 Map、塞进 reactive state；(2) 富信息可以**按需渐进挂载**——本阶段填不了的（npm registry 元信息、publint 报告）就把字段留空，等下一阶段补；(3) 整个流水线对**大 monorepo 友好**——几万个节点不重建 Map、不复制对象，只往原对象上贴字段。

- **关键权衡（4 条，每条三段式）**：

  1. **mutate 而非重建（核心权衡）** → 换来**零拷贝**：对几万节点的依赖图来说，不重建 Map 意味着内存峰值 O(1) 增长而非翻倍；前端 reactive 引用也保持稳定，不会因 resolve 触发整树重渲 → 代价是**调用方必须接受副作用契约**：同一个对象在流水线不同阶段字段会变（"昨天还是骨架，今天就长出 resolved 了"），并且类型系统为了描述这种"承诺稍后填齐"的暂时性不一致，必须使用双重断言来绕过结构检查。

  2. **类型按工序分三层 extends**（骨架 → 闭包层 → 富信息层）→ 换来**每道工序有清晰类型边界**：骨架层只关心身份，闭包层只多出依赖图闭包字段，富信息层才出现 `resolved`；下游函数按需 narrow，工具提示精确，类型即文档 → 代价是**流水线节点函数必须用"双重断言"先把自己升格成最终类型**，本质上是在向编译器"打欠条"——这个欠条的正确性由运行时的字段填充逻辑保证，TS 不再帮你查。

  3. **并发在外、顺序在内** → 换来**对文件系统 I/O 的合理扇出**：外层用并发限流器同时跑 10 个包的解析（每个包的体积测算都要递归遍历目录，是真正的 fs I/O）；而单个包内的若干归一化步骤是纯 CPU 同步操作，串行跑反而避免事件循环 starvation → 代价是**单个包的总耗时 = 串行 N 步之和**（实际可接受，因为多数归一化是纯同步且极快），且整个流水线的吞吐瓶颈永远是 fs I/O，不是 CPU。

  4. **静默降级而非抛错** → 换来**对 optional/缺失包的容错**：optional dependencies 没装上时 package.json 文件根本不存在，此时不抛、不退场，而是把磁盘路径清空、模块类型标 `'unknown'`、packageJson 设空对象，让节点继续在图里存在 → 代价是**下游必须显式处理 `'unknown'` 这个状态分支**（否则筛选/分类会出错），并且 `filepath` 被设成空字符串这个哨兵值需要全栈感知。

- **最小心智模型（7 步）**：
  1. 拿到一个**已完成依赖图物化**的节点（已有：身份字段、依赖闭包字段、磁盘路径）
  2. 检查 `resolved` 字段是否已存在——存在就直接返回（**幂等性**：可重复调用）
  3. 用双重断言把节点的类型从「骨架+闭包层」升格为「富信息层」（**打欠条**：承诺返回前会填齐 `resolved`）
  4. 用节点的磁盘路径拼出 package.json 的绝对路径
  5. **路径不存在 → 走静默降级**：清空磁盘路径、模块类型设 `'unknown'`、packageJson 设空对象
  6. **路径存在 →** 剥掉 BOM 头 → JSON.parse → 跑一组归一化/分析函数（模块类型、白名单字段裁剪、目录递归测体积、作者/仓库/协议/赞助解析）
  7. 把所有产物挂到 `resolved` 子对象上（**mutate 输入**），返回同一个对象引用

- **最小原理演示（替代旧"复刻范围"）**：
  - **应演示**：一个 30~50 行的 TypeScript 脚本，演三件事的**最小骨架**——(a) 三层 `interface extends` 类型分层；(b) 一个接受骨架层、返回富信息层的 `resolvePackage` 函数，内部用双重断言 + 幂等检查 + mutate 挂 `resolved`；(c) 一个外层 orchestrator 用并发限流器批量调它。**每行都要对应上面某个原理点**：双重断言演「类型演化 + 欠条」、幂等检查演「可重复调用」、不 return 新对象演「零拷贝」、缺失文件分支演「静默降级」。
  - **应故意省略**：真实的 7 个归一化函数（用 `console.log` 占位即可）、真实 fs 目录递归（用 stub）、BOM 处理（注释提一句即可）、`@keep-sorted` lint 宏、类型导出（都写到同一文件）、并发限流器的真实实现（用简化版或直接用 `Promise.all`）。
  - **演示载体建议**：本仓库主语言是 TypeScript，且本章机制**不需要任何宿主环境**（无 Vue、无 Node fs 之外依赖），**强烈建议写成可直接 `bun run` 或 `tsx` 跑的独立脚本**——能让读者真的看到"同一个对象 resolve 前后的字段差异"，对理解 mutate 契约极有好处。脚本里可以打印 `Object.is(before, after)` 验证"引用未变"，是核心思想的最佳证据。

- **正文不宜展开的细节**：
  - 7 个归一化函数的内部实现（模块类型推断、体积测算、作者解析等都是独立章节）
  - npm registry 元信息和 publint 报告——它们也是 `resolved` 上的字段，但由后续阶段（registry 拉取、publint 检查）填充，不在本章流水线内
  - `@keep-sorted` / `@keep-unique` 这些 antfu lint 宏的工作机制
  - pLimit 这个第三方并发限流库的内部实现
  - 类型导出图谱（types/index.ts → types/base.ts/list.ts/node.ts/size.ts 的拆分）

- **推荐的一个执行轨迹例子**：
  - **输入**：节点 `{ name: 'lodash', version: '4.17.21', spec: 'lodash@4.17.21', filepath: '/abs/node_modules/lodash', dependencies: Set(), ...closure fields... }`，`resolved` 字段尚不存在。
  - **关键中间态**：(1) 幂等检查 `resolved` 为 undefined，继续；(2) 双重断言升格类型；(3) 读 `/abs/node_modules/lodash/package.json` 成功，剥 BOM 后 JSON.parse；(4) 7 个字段被算出（module='esm'、packageJson 被白名单裁剪、installSize 经目录递归得到、authors/repository/license/fundings 各自归一化）；(5) 整块挂到 `_pkg.resolved`。
  - **输出**：`{ ...原有骨架与闭包字段..., resolved: { module: 'esm', packageJson: {...}, installSize: {bytes, categories}, authors: [...], repository: {...}, license: 'MIT', fundings: [...] } }`，**且 `Object.is(输入, 输出) === true`**。

> 以上钩子供 Writer 写「动机→核心思想→心智模型→关键权衡→原理演示」；下面事实部分供核对，不要被 Writer 当目录照抄。

## 概念要点

- **三层类型演化链**：`PackageNodeRaw`（身份）→ `PackageNodeBase extends Raw`（+ 依赖图闭包字段）→ `PackageNode extends Base`（+ `resolved` 富信息）。三层分别对应三道工序：原始清单拉取 → 依赖图物化 → 富信息解析。
  源码位置: packages/node-modules-tools/src/types/node.ts:11-73

- **`resolvePackage` 的契约**：JSDoc 明确写了"This function mutates the input package node."——即不返回新对象，直接往入参上挂字段。返回值与入参是同一引用。
  源码位置: packages/node-modules-tools/src/resolve.ts:42-52

- **幂等性守门**：函数体第一行检查 `_pkg.resolved`，已存在直接 return。这意味着 storage 层失效后重跑是安全的。
  源码位置: packages/node-modules-tools/src/resolve.ts:54-55

- **双重断言"打欠条"**：入参声明为 `PackageNodeBase`，但函数内立刻 `const _pkg = pkg as unknown as PackageNode`。这是因为函数承诺在返回前会填齐 `resolved` 字段（PackageNode 接口上 `resolved` 是非可选的），但填齐**之前**的中间代码里访问 `_pkg.resolved.xxx` 时 TS 必须放行——`as unknown as` 就是这个放行通道。
  源码位置: packages/node-modules-tools/src/resolve.ts:50-53

- **7 个字段挂载**（不是 outline 摘要里说的 5 个——摘要把 `module`/`packageJson` 算成"非归一化"，实际代码里它们和 4 个 normalize 函数、1 个体积测算函数一起构成 7 个赋值步骤）：`module`、`packageJson`、`installSize`、`authors`、`repository`、`license`、`fundings`。其中只有 `installSize` 是 `await` 的（需递归遍历目录），其余 6 个都是纯同步调用。
  源码位置: packages/node-modules-tools/src/resolve.ts:63-71

- **`resolved` 字段的 10 个槽位中，本章只填 7 个**：`npmMeta`、`npmMetaLatest`、`publint` 三个字段由后续阶段（registry 拉取、publint 检查）填充，本章不碰。这就是"渐进挂载"——`resolved` 是个**部分填充**对象，类型用 `?:` 表达可选性。
  源码位置: packages/node-modules-tools/src/types/node.ts:53-72

- **package.json 白名单裁剪**：用 `objectPick(json, PACKAGE_JSON_KEYS)` 只保留 25 个白名单字段（author/bin/bugs/dependencies/exports/funding/license/module/name/repository/types/version 等）。两个字段 `@keep-sorted` 和 `@keep-unique` 是 antfu 工具的 lint 宏，自动维护数组有序且无重复。
  源码位置: packages/node-modules-tools/src/resolve.ts:12-40

- **静默降级分支**：当 `existsSync(path)` 为 false（典型场景：optional dependencies 没装），把 `_pkg.filepath = ''` 清空、`_pkg.resolved = { module: 'unknown', packageJson: {} }` 走最简兜底。不抛错。
  源码位置: packages/node-modules-tools/src/resolve.ts:57-79

- **BOM 处理**：`stripBomTag` 检查首字符是不是 `0xFEFF`，是就 `slice(1)` 剥掉。注释标明抄自 Vite 同名工具。
  源码位置: packages/node-modules-tools/src/resolve.ts:83-92

- **外层并发，内层串行**：`list.ts` 的 orchestrator 用 `pLimit(10)` 限制最多 10 个 `resolvePackage` 同时跑；单个包内的 7 个字段赋值是顺序的（没 `Promise.all`）。这是合理的，因为多数 normalize 是纯同步，唯一 async 的体积测算是 fs I/O——并发 10 个目录递归刚好压满磁盘而不爆事件循环。
  源码位置: packages/node-modules-tools/src/list.ts:12-13

- **类型演化的 unsound 转场**：`list.ts` 拿到 `ListPackageDependenciesBaseResult`（Map 值是 `PackageNodeBase`）后**立刻** `as ListPackageDependenciesResult`（Map 值是 `PackageNode`）——这是个"未来式"断言，断言的正确性由下一行的 `await Promise.all(...resolvePackage...)` 兑现。
  源码位置: packages/node-modules-tools/src/list.ts:11-14

- **NpmMeta vs NpmMetaLatest 的语义分裂**：`NpmMeta` 是不可变的"已发布事实"（发布时间、deprecated 标记、漏洞等级）；`NpmMetaLatest extends NpmMeta` 多出 `version` + `fetechedAt`（注意源码拼写错误）+ `vaildUntil`（注意源码拼写错误）——后两者表达"这个 meta 是某个时刻拉的，过了 TTL 就作废"。这套语义和本章 resolve 无直接关系，但字段位置长在 `resolved` 里，需要知道它们是后续填的。
  源码位置: packages/node-modules-tools/src/types/node.ts:76-103

- **`_packageManager` 与 `_options` 形参被下划线前缀**：表明当前实现未使用这两个参数，但保留接口位置——这是给未来扩展（例如 per-package-manager 的 resolve 策略）留的钩子。
  源码位置: packages/node-modules-tools/src/resolve.ts:49-51

## 关键调用链

```
listPackageDependencies(options)                                  [list.ts]
  ├─ getPackageManager(options)                                   [agent-entry/detect.ts]
  ├─ listPackageDependenciesRaw(pm, options)                      [agent-entry/list.ts]
  │     └─ populateRawResult(...)                                 → 填闭包字段，得到 PackageNodeBase
  └─ pLimit(10) → Promise.all(packages.values().map(
        pkg => resolvePackage(pm, pkg, options)                   [resolve.ts]
          ├─ if (_pkg.resolved) return                            ← 幂等守门
          ├─ _pkg = pkg as unknown as PackageNode                 ← 双重断言打欠条
          ├─ join(pkg.filepath, 'package.json')                   ← 定位文件
          ├─ [文件不存在] → _pkg.filepath=''; _pkg.resolved={module:'unknown',packageJson:{}}
          └─ [文件存在] → stripBomTag → JSON.parse
                → _pkg.resolved = {
                    module:        analyzePackageModuleType(json),         [analyze-esm.ts]
                    packageJson:   objectPick(json, PACKAGE_JSON_KEYS),
                    installSize:   await getPackageInstallSize(_pkg),      [size.ts]
                    authors:       normalizePkgAuthors(json),              [utils/package-json.ts]
                    repository:    normalizePkgRepository(json),
                    license:       normalizePkgLicense(json),
                    fundings:      normalizePkgFundings(json),
                  }
          └─ return _pkg                                          ← 同一引用，类型已是 PackageNode
```

下游消费者：`packages/node-modules-inspector/src/node/rpc/handlers.ts:138` 通过 `listPackageDependencies({...})` 一次性拿到全图 `PackageNode` Map，之后所有 RPC handler 都基于这份 Map 派生。

## 源码摘录（带行号，全文累计 ≤ 30 行）

```ts
// packages/node-modules-tools/src/resolve.ts:42-81
export async function resolvePackage(
  _packageManager: AgentName,
  pkg: PackageNodeBase,
  _options: BaseOptions,
): Promise<PackageNode> {
  const _pkg = pkg as unknown as PackageNode          // ← 双重断言：把 Base 升格为 Node，"打欠条"
  if (_pkg.resolved)                                   // ← 幂等守门
    return _pkg

  const path = join(pkg.filepath, 'package.json')
  if (existsSync(path)) {
    const content = await readFile(path, 'utf-8')
    const json = JSON.parse(stripBomTag(content)) as PackageJson

    _pkg.resolved = {                                  // ← mutate 入参；7 字段同时挂载
      module: analyzePackageModuleType(json),
      packageJson: objectPick(json, PACKAGE_JSON_KEYS),
      installSize: await getPackageInstallSize(_pkg),  // ← 唯一 async 步骤
      authors: normalizePkgAuthors(json),
      repository: normalizePkgRepository(json),
      license: normalizePkgLicense(json),
      fundings: normalizePkgFundings(json),
    }
  }
  else {                                               // ← 静默降级分支
    _pkg.filepath = ''
    _pkg.resolved = {
      module: 'unknown',
      packageJson: {},
    }
  }
  return _pkg                                          // ← 返回的是入参同一引用
}
```

```ts
// packages/node-modules-tools/src/list.ts:7-15
export async function listPackageDependencies(
  options: ListPackageDependenciesOptions,
): Promise<ListPackageDependenciesResult> {
  const packageManager = await getPackageManager(options)
  const result = await listPackageDependenciesRaw(packageManager, options) as ListPackageDependenciesResult
  const limit = pLimit(10)                             // ← 外层并发限流：最多 10 个包同时解析
  await Promise.all(Array.from(result.packages.values()).map(pkg => limit(() => resolvePackage(packageManager, pkg, options))))
  return result
}
```

```ts
// packages/node-modules-tools/src/types/node.ts:53-73
export interface PackageNode extends PackageNodeBase {
  resolved: {                                          // ← 非可选：存在即已 resolve（运行时靠 mutate 保证）
    module: PackageModuleType                          // ← 必填
    packageJson: PackageJson                           // ← 必填
    installSize?: PackageInstallSizeInfo               // ← 以下皆可选，渐进挂载
    npmMeta?: NpmMeta                                  //   本章不填，由 registry 拉取阶段填
    npmMetaLatest?: NpmMetaLatest                      //   本章不填
    publint?: PublintMessage[] | null                  //   本章不填，由 publint 阶段填
    authors?: ParsedAuthor[]
    repository?: ParsedRepository
    license?: ParsedLicense
    fundings?: ParsedFunding[]
  }
}
```

## 易混淆 / 边界 / 推断

- **事实**：outline.json 摘要写「并发跑 5 个 normalize」，但代码实际挂载 7 个字段（`module`/`packageJson` 不算传统意义的 normalize，但代码里和 4 个 normalize 函数同等对待）。Writer 写正文时建议说「7 个字段挂载，其中 4 个走专用 normalize 函数」，避免与代码不符。
  源码位置: packages/node-modules-tools/src/resolve.ts:63-71

- **事实**：单个包内的 7 步是**顺序**执行（无 `Promise.all`），只有 `installSize` 是 async。并发发生在**包与包之间**（`pLimit(10)`）。这是反直觉的点——直觉上"既然 7 步互不依赖就该 Promise.all"，但实际不并行，原因是其余 6 步都是微秒级同步操作，并行反而引入开销。
  源码位置: packages/node-modules-tools/src/resolve.ts:63-71

- **推断**：`_packageManager` 与 `_options` 参数下划线前缀但保留接口位置，**推断**是为未来"按包管理器定制 resolve 策略"留的扩展点。证据：(a) 命名前缀是 TS 惯用的"故意未用"标记；(b) 函数名 `resolvePackage` 不带 manager 后缀，暗示接口设计意图多态。但当前代码对三种包管理器走完全相同的 resolve 路径——这一点源码没明说，标注为推断。

- **事实**：`as ListPackageDependenciesResult` 的强转在 `await Promise.all` 之前发生，但 cast 后立刻被 `await` 兑现——这种"先转后填"的模式是本章"mutate + 类型演化"哲学的直接体现，不是 bug。
  源码位置: packages/node-modules-tools/src/list.ts:11-14

- **事实**：`NpmMetaLatest` 中的 `fetechedAt` 和 `vaildUntil` 是**源码里的拼写错误**（应为 `fetchedAt` / `validUntil`）。这不是 Reader 误读——Writer 写正文时如果举例用到这俩字段，需照抄源码拼写，否则会与实际类型不符。
  源码位置: packages/node-modules-tools/src/types/node.ts:96-102

- **推断**：`stripBomTag` 抄自 Vite（注释里有 Vite 的 commit hash 引用），**推断**动机是某些老包（特别是 Windows 上 publish 的）package.json 带 UTF-8 BOM，会让 `JSON.parse` 失败。Vite 已经踩过这个坑，所以这里直接复用。
  源码位置: packages/node-modules-tools/src/resolve.ts:83-92

- **未理解**：`PACKAGE_JSON_KEYS` 里同时列了 `author` 和 `authors`、`funding` 和 `fundings`、`license` 和 `licenses`——这是 npm 历史遗留的多形态字段。但 `objectPick` 会把存在的都捞上来，下游 normalize 函数如何处理"两者并存"的情况需要看 `utils/package-json.ts` 内部实现（属于 `pkg-json-normalizer` 章节范围，本章不展开）。
  源码位置: packages/node-modules-tools/src/resolve.ts:14-40

- **边界**：当 `pkg.filepath` 本身为空字符串时（例如已经被静默降级过一次），`join('', 'package.json')` 会得到 `'package.json'`（相对路径），`existsSync('package.json')` 会读 cwd 下的文件——理论上不会触发，因为幂等守门会先返回。但如果有人绕过幂等性再次调用，行为未定义。建议 Writer 正文里强调「幂等性是契约的一部分」。
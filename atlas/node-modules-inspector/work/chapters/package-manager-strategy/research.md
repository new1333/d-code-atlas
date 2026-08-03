# 包管理器策略：pnpm/npm/bun 三态归一 · 源码精读

## 给 Writer 的教学钩子（必填，8 子项缺一不可）

- **用户痛点 / 场景**：一个想给前端展示「依赖全景」的工具，必须面对 pnpm/npm/bun 三家完全不同的清单来源——一家走 CLI 树、一家走 query 选择器、一家走 lockfile 文件。如果上层每加一个能力（过滤、搜索、统计）都得为每家写一份分支，三份代码会迅速漂移；更糟的是，每接入一种新包管理器，整个上层都要重写。

- **一句话核心思想**：**先探测包管理器种类，再按需加载对应的适配器，最后把异构清单压成同一份节点表**——把"怎么拿清单"封装到底层，让上层只看到一份统一的依赖节点流。

- **设计动机（为什么需要它）**：三种包管理器的**输入侧**不可调和（CLI 输出 vs 选择器查询 vs lockfile 文件），但**输出语义**（节点 + 依赖边 + 集群标签）高度同构。这个机制存在的全部理由，就是在不可调和的输入侧和可统一的输出侧之间塞一层适配器，把"三家差异"关进笼子。

- **关键权衡**：
  1. **用动态 `import()` 按需加载适配器** → 换来「没装的包管理器代码不进 bundle」（前端/webcontainer 场景关键）→ 代价是新增包管理器必须同时新增一个适配器模块、并在派发器里登记一行，忘一个就找不到。
  2. **靠 lockfile 文件名探测包管理器种类（不做命令行试探）** → 换来零配置「自动识别」和零子进程开销 → 代价是用户的项目根必须先有某家 lockfile，否则直接抛错。
  3. **npm 适配器并发跑 5 个选择器查询** → 换来规避 npm CLI 单次冷启动开销（每次 spawn 都很贵）→ 代价是 5 个查询里只有 2 个支持「仅读 lockfile」模式，另外 3 个（dev/prod/optional）要求 node_modules 已经装好——所以 npm 项目必须先 install 才能拿到完整依赖。
  4. **bun 适配器不调 bun CLI、直接读 lockfile 文本文件** → 换来无子进程、可在静态环境运行、速度最快 → 代价是必须用正则把 bun 接受但标准 JSON 不接受的尾逗号剥掉；并且明确不支持老的二进制 `bun.lockb`。
  5. **pnpm 适配器用流式解析器吃 `pnpm ls --json` 的 stdout** → 换来对超大 monorepo（输出超 V8 字符串上限）的容错 → 代价是输出超长时只能降级重试用更小的 depth。
  6. **三种适配器都产出同一份 schema（spec/name/version/filepath/dependencies 集合/clusters 集合）** → 换来上层一份代码处理三家 → 代价是某家特有能力（如 pnpm 的 catalog）必须挂在可选字段上，上层用之前得判空。

- **最小心智模型（3～7 步）**：
  1. 调用方告诉派发器当前是哪种包管理器（探测已在上游完成）；
  2. 派发器按种类动态加载对应适配器模块；
  3. 适配器调用自家途径（CLI 子进程 / 选择器查询 / lockfile 读取）拿到原始清单；
  4. 适配器内部递归遍历，把异构结构（树 / 平面查询结果 / 元组字典）压平成「spec → 节点」的映射表；
  5. 遍历过程中同步打集群标签（prod/dev/optional + catalog 名），集群会沿依赖边向下继承；
  6. 适配器返回 `{ 根目录, 包管理器名, 版本号, 节点表, 可选的 catalogs }`；
  7. 上层统一消费者拿到这份原始表，再算反向引用、闭包、深度等图查询属性。

- **最小原理演示（替代旧"复刻范围"）**：
  - **应演示**：一个派发器配三个最小适配器，每个适配器返回一份写死的「spec → {spec, dependencies: Set<spec>}」映射——一个伪造树状结构（模拟 pnpm）、一个伪造平面选择器结果（模拟 npm）、一个伪造 lockfile 元组（模拟 bun）。派发器按种类动态加载；主流程用同一份 `for (const [spec, node] of packages)` 遍历打印依赖数，证明三家走同一份消费代码。这段演示演的是**权衡 #1 和 #6**：动态派发 + 统一 schema 让上层无关包管理器种类。
  - **应故意省略**：真正的子进程调用、流式 JSON 解析（属于上游章）、cluster 标签的具体生成、catalog 解析、闭包/深度计算（属于下游章）。
  - **演示载体建议**：写成能 `bun run` 或 `ts-node` 直接跑的 TS 脚本（仓库主语言是 TS）。三个适配器各放在独立文件里、用 `await import()` 加载以忠实复刻"动态加载"这条权衡；不需要真跑包管理器——能演透"归一化"这个原理即可。

- **正文不宜展开的细节**：
  - 闭包字段（flatDependencies/dependents/depth/shallowestDependent）的双 DFS 算法（属于"依赖图物化"章，本章只点出"raw 结果会喂给它"即可）；
  - cluster 字符串常量的具体值（如 `'dep:prod'`）；
  - pnpm 的 `--recursive` / `--ignore-workspace` 等 CLI 参数细节；
  - npm query selector 的完整语法（`:root`/`.workspace`/`.dev`/`.prod`/`.optional`）；
  - bun.lock 文本格式尾逗号清洗正则的边界 case；
  - 包管理器探测库（`package-manager-detector`）的内部规则。

- **推荐的一个执行轨迹例子**：
  - **输入**：在一个装了 pnpm 的 monorepo 项目里调用清单获取（指定项目根、最大深度 5、开启 monorepo 模式）；
  - **关键中间态**：探测出种类为 pnpm → 动态加载 pnpm 适配器 → 跑 `pnpm ls --json --depth 5 --recursive` → 流式装配出层级树 → 适配器内部 DFS 把树压平成「spec → 节点」映射表，沿途给直接依赖打 `prod`/`dev` 集群标签、给在 catalog 里登记过的包打 `catalog:default` 标签；
  - **输出**：`{ 根目录, packageManager: 'pnpm', 版本号, 节点表, catalogs: { default: {...} } }`，每个节点的 `dependencies` 是 spec 字符串的 Set、`clusters` 是从父节点继承并叠加自己标签后的并集。

> 以上钩子供 Writer 写「动机 → 核心思想 → 心智模型 → 关键权衡 → 原理演示」；下面事实部分供核对，不要被 Writer 当目录照抄。

## 概念要点

- **探测层只有 13 行**：单个导出函数 `getPackageManager(options)`，调用 `package-manager-detector` 库的 `detect({ cwd })`，返回 `manager.name`（`'pnpm'`/`'npm'`/`'bun'`/...），探测失败抛 `"Cannot detect package manager in the current path"`。
  源码位置: packages/node-modules-tools/src/agent-entry/detect.ts:5-13

- **派发层用动态 `import()`**：`listPackageDependenciesRaw(manager, options)` 用 `if/else if` 链按 manager 名字动态加载对应适配器，并 `await import(...).then(r => r.listPackageDependencies(options))`；不支持的 manager 直接 `throw`。
  源码位置: packages/node-modules-tools/src/agent-entry/list.ts:9-24

- **统一输出 schema**：三家适配器都返回 `ListPackageDependenciesRawResult`，关键字段是 `packages: Map<string, PackageNodeRaw>`。`PackageNodeRaw` 含 `spec`（`name@version`）、`name`、`version`、`filepath`、`dependencies: Set<string>`、`clusters: Set<string>`、`workspace?`、`private?`。`clusters` 字段的注释明确写「会沿依赖边向下继承到所有嵌套依赖」。
  源码位置: packages/node-modules-tools/src/types/list.ts:27-38
  源码位置: packages/node-modules-tools/src/types/node.ts:11-36

- **集群常量**：`CLUSTER_DEP_PROD = 'dep:prod'`、`CLUSTER_DEP_DEV = 'dep:dev'`、`CLUSTER_DEP_OPTIONAL = 'dep:optional'`，三个适配器都从 `../../constants` 导入。
  源码位置: packages/node-modules-tools/src/constants.ts:5-7

- **pnpm 适配器**：
  - `resolveRoot` 跑 `pnpm root` 或 `pnpm root -w`（workspace 模式优先 `-w`，失败回退不带 `-w`），从 stdout 拿根目录。
    源码位置: packages/node-modules-tools/src/agents/pnpm/list.ts:30-62
  - `getDependenciesTree` 跑 `pnpm ls --json --depth N`，按 options 加 `--recursive`（monorepo）或 `--ignore-workspace`（workspace === false），stdout 喂给 `parseJsonStreamWithConcatArrays`（流式解析器，json-stream-parser 章）。
    源码位置: packages/node-modules-tools/src/agents/pnpm/list.ts:76-108
  - **错误降级**：流式解析抛 `JsonParseStreamError` 且 message 是 `"Invalid string length"`（V8 字符串上限）时，提示用户用 `--depth=ceil(depth/3*2)` 重试。
    源码位置: packages/node-modules-tools/src/agents/pnpm/list.ts:92-102
  - `getCatalogs` 读 `pnpm-workspace.yaml`，把 `catalogs` 字段和 `catalog` 顶层字段合并成 `{ ...catalogs, default: catalog }`。
    源码位置: packages/node-modules-tools/src/agents/pnpm/list.ts:110-119
  - `traverse(raw, level, clusters)` 是递归 DFS：用 `WeakMap` memo 化 PnpmPackageNode → PackageNodeRaw；level===1 时给节点打 prod/dev 集群，并查 catalogs 给在 catalog 里登记的包加 `catalog:X` 集群；用 `packages.has(spec)` 短路已访问节点（DAG 处理）。
    源码位置: packages/node-modules-tools/src/agents/pnpm/list.ts:157-224
  - workspace 节点名字 fallback：从根到包路径的相对路径，转小写、非字母数字替换成 `_`、截前 20 字符，加 `#workspace-` 前缀；空路径用 `#workspace-root`。
    源码位置: packages/node-modules-tools/src/agents/pnpm/list.ts:129-148

- **npm 适配器**：
  - **5 路并发**：用 `Promise.all` 同时跑 `:root`、`.workspace`、`.dev`、`.prod`、`.optional` 五个 query selector + 拿版本号 + 拿根目录。注释明确写「Run concurrently since npm cli has a lot of overhead」，并引用 marvinh.dev 的性能博客。
    源码位置: packages/node-modules-tools/src/agents/npm/list.ts:84-102
  - **lockfile-only 不一致**：`:root` 和 `.workspace` 传 `--package-lock-only`（不需要 node_modules），但 `.dev`/`.prod`/`.optional` 不传（需要 node_modules 已装）。这是 npm query selector 本身的限制。
    源码位置: packages/node-modules-tools/src/agents/npm/list.ts:50-79
  - **两阶段组装**：第一阶段 normalize 把每个查询结果转成 PackageNodeRaw 入表（带 cluster 标签）；第二阶段遍历所有 raw 节点的 `to: string[]` 数组，靠 `packageSpecByLocation` 映射把 location 字符串解析回 spec，再补依赖边。npm query 返回**平面结果**，边靠 `from`/`to` 数组重建。
    源码位置: packages/node-modules-tools/src/agents/npm/list.ts:147-195
  - `NpmPackageNode` 类型含 npm 特有字段：`_id`、`pkgid`、`location`、`realpath`、`resolved`、`from[]`、`to[]`、`dev`、`inBundle`、`deduped`、`overridden`、`queryContext`。
    源码位置: packages/node-modules-tools/src/agents/npm/list.ts:7-24

- **bun 适配器**：
  - **不调 bun CLI**：直接 `fs.promises.readFile('bun.lock', 'utf-8')`，用正则 `/,(\s*[}\]])/g` 剥掉尾逗号后 `JSON.parse`。注释解释：「bun.lock is JSON-like with trailing commas that Bun accepts but JSON.parse does not」。
    源码位置: packages/node-modules-tools/src/agents/bun/list.ts:67-91
  - **明确不支持二进制 lockfile**：如果只存在 `bun.lockb`（老二进制格式），抛错并指向 bun 官方迁移文档。
    源码位置: packages/node-modules-tools/src/agents/bun/list.ts:84-88
  - **lockfile 元组**：`BunPackageTuple = [spec, tarball, metadata?, integrity?]`；`packages` 字段是 `Record<key, tuple>`，key 形如 `@scope/name@version/nested@version`。
    源码位置: packages/node-modules-tools/src/agents/bun/list.ts:22-48
  - **依赖 key 解析**：`resolveDependencyKey(parentKey, dependency)` 优先尝试父作用域下的 scoped key（`${parentKey}/${dependency}`），失败则按名字找候选，按「嵌套优先 → 同名优先 → 第一个」的顺序兜底。
    源码位置: packages/node-modules-tools/src/agents/bun/list.ts:201-225
  - **traverse 用 `processedSpecs` Set 做 DAG 短路**（与 pnpm 的 `packages.has(spec)` 不同实现，同效果）。
    源码位置: packages/node-modules-tools/src/agents/bun/list.ts:246-292
  - **workspace 间互联**：bun lockfile 不在 `packages` 里复制 workspace 条目，所以 workspace → workspace 的边在 workspace 循环里直接连（`workspaceNodeByName` 查找），不走 traverse。
    源码位置: packages/node-modules-tools/src/agents/bun/list.ts:362-377

- **populateRawResult 是上游接口的延续**：派发层在拿到 raw 结果后调 `populateRawResult`，给每个节点补 `dependents`、`flatDependencies`、`flatDependents`、`flatClusters`、`depth`、`shallowestDependent` 字段（扩展成 `PackageNodeBase`）。注意：这部分属于「依赖图物化」章，本章只需点出 raw 结果会喂给它。
  源码位置: packages/node-modules-tools/src/agent-entry/list.ts:27-119

## 关键调用链
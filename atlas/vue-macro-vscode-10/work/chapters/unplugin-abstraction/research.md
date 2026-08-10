# unplugin：跨构建工具的统一插件抽象 · 主题精读

## 给 Writer 的教学钩子（必填，8 子项缺一不可）

- **用户痛点 / 场景**：Vue 生态的构建工具是分裂的——新项目默认 Vite，海量存量项目仍跑在 webpack/vue-cli 上，写库的人用 Rollup，追求极致冷启动速度的人用 esbuild，还有 Rspack/Rsbuild/Rolldown 等新玩家。每个打包器的插件 API 互不兼容。如果 Vue Macros 要让所有这些用户都能用上宏，最朴素的办法是每个工具手写一套插件：意味着每加一个宏特性要改 N 份代码、维护 N 套互不相同的 hook 签名、修 N 倍的 bug。作者被迫在「只支持 Vite（放弃大半用户）」和「支持所有工具但维护成本爆炸」之间二选一。unplugin 就是来消解这个二选一的。

- **一句话核心思想**：用工厂函数把同一份「源码→源码」transform 逻辑适配到各打包器各自互不兼容的 hook 约定上，让一份变换逻辑长出 N 个工具的原生插件。

- **设计动机（为什么需要它）**：各打包器的插件机制在三个维度上根本不同构——① 插件接口形态（Rollup 是扁平 hook 对象 vs webpack 是 `apply(compiler)` + Tapable 事件总线）；② 文件变换的位置（Rollup/Vite 用插件级 `transform` hook，webpack 把文件变换丢给独立的 loader 层，esbuild 只有 `onLoad` 一个回调）；③ hook 的时序控制（Vite 有 `enforce` 控制插件先后，esbuild/webpack 无对应物）。unplugin 的解法是：选其中最简单的一个（Rollup 风格）做「公约数接口」，再为每个工具写一层适配器把公约数 hook 翻译回各自原生机制。**承前关系**：本章程主角色的「transform 逻辑内容」就是前置章建立的那条流水线——「注册宏→遍历 AST→命中调用节点→用 magic-string 注入变换」（已在第 6 章『Vue Macros 的宏变换流水线』讲透，本章**不重演流水线内部**，只看它「如何被打包成一个可跨工具分发的单元」）。同时这条 transform 必须挂在 SFC 编译之前（已在第 3 章『SFC 编译管线』讲透阶段顺序），本章只看「为什么同一份『挂在编译前的变换』能在非 Vite 工具上也复现」这个新侧面。

- **关键权衡（机制丰富章，取 4 条；每条「选择→换来→代价」三段式）**：
  1. **选 Rollup 扁平 hook 风格作为统一公约数接口** → 换来了「插件作者只学一套 API、一份核心逻辑分发到所有工具」→ 代价是「公约数取的是各工具能力的**交集**而非并集，任何工具独有的能力（webpack 的 Tapable 细粒度钩子、Vite 的 `configureServer`）要么被抹掉，要么得走 bundler-specific 逃生舱字段单独再写一份，抽象层并非免费」。
  2. **在底层用适配器把公约数 hook 翻译回各打包器原生机制（webpack 要合成一个虚拟 loader 注入 `module.rules`、esbuild 要映射到 `onLoad`）** → 换来了「一份插件能跑在架构根本不同的工具上」→ 代价是「适配器是黑盒，同一份插件在 webpack 与 Rollup 下可能出现**微妙的行为差异**（如 hook 触发时序、模块 id 格式不同），调试时必须意识到你在跟适配层打交道，而非原生插件」。
  3. **esbuild 的插件 API 故意做最小化（只有 `onResolve`/`onLoad`、无 `enforce`、无 `addWatchFile`）** → 换来了「esbuild 适配器实现极简、构建速度极快」→ 代价是「esbuild 下 Vue Macros **只能支持有限特性**」——因为缺 `enforce`，无法保证宏变换一定在 SFC 编译之前跑；缺多阶段 transform pipeline，意味着「先宏变换、再 SFC 编译」这种强依赖顺序的管线在 esbuild 下难以可靠串联。这是「抽象抹平能力差异」**最痛的一处代价**，也是 Vue Macros 官方把 esbuild/webpack 标为「有限支持」的根因。
  4. **引入 `transformInclude`/`filter` 这类过滤钩子作为 transform 的前置闸门** → 换来了「webpack/Rolldown 下不会对所有模块无差别跑 transform（性能；因为它们的 id 过滤逻辑在 loader 之外）」→ 代价是「插件作者必须额外维护一份 include 规则，且它与 transform 主体逻辑割裂，漏配或配错会表现为『变换静默不生效』这种难排查的症状」。

- **最小心智模型（7 步）**：
  1. 作者用 `createUnplugin` 注册一个**工厂函数**，工厂返回一个带统一 hook（`transform` 等）的插件对象——这是「公约数接口」。
  2. 用户在配置里按宿主工具导入对应子路径（`/vite`、`/webpack`、`/esbuild`…），unplugin 据此选择对应适配器。
  3. unplugin 调用工厂时注入 `meta.framework`，告诉插件「你现在跑在哪个工具里」，插件可据此做条件分支。
  4. 宿主打包器在构建过程中触发它**原生**的某个点（Vite 的 `transform`、webpack 的 loader 执行、esbuild 的 `onLoad`）。
  5. 适配器把这个原生事件**翻译**成对统一 `transform(code, id)` hook 的一次调用。
  6. 统一 `transform` 内部跑的就是前置章那条宏变换流水线（遍历 AST、magic-string 就地改写），返回新 `code` + `sourcemap`。
  7. 适配器把结果**翻译回**宿主期望的返回形态（webpack loader 回调的 `callback(null, code)`、esbuild `onLoad` 的 `contents`），宿主拿改写后的代码继续后续阶段（如交给 SFC 编译器）。

- **最小原理演示（替代旧「复刻范围」）**：
  - **应演示**：一个极简的「跨工具代码翻转」demo——用 `createUnplugin` 写一个 transform（例如把源码里的 `__DEV__` 标记替换成字面量 `false`），然后展示这个 unplugin 对象如何**同时**长出 `.vite`/`.webpack`/`.esbuild` 三个导出，并用 `meta.framework` 在工厂里做条件分支。再加一个**伪适配器骨架**（几十行）展示「翻译」思想：把统一的 `transform` 调用分别包成 esbuild 的 `onLoad` setup 和 webpack 的 loader 函数。整个 demo 几十行 TS 即可，每一行都要对应上面某个原理点（工厂→公约数→meta→翻译→分发）。
  - **应故意省略**：真实的宏变换逻辑（那是前置章第 6 章的演示内容，本章借来当黑盒即可）；webpack 虚拟 loader 的真实 `module.rules` 注入实现；真实 sourcemap 生成；`enforce` 在各工具的具体生效差异；HMR 细节；Rolldown/Rspack/Farm/Bun 等长尾适配。
  - **演示载体建议（Writer 据此执行）**：TS（topic 模式首选，且 unplugin 本身就是 TS 生态，对读者最友好）。无原仓库语言约束。

- **正文不宜展开的细节**：各打包器全部 hook 的完整对照表（太琐碎，放事实库供抽查即可）；webpack Tapable 的全部 Hook 类型（`SyncHook`/`AsyncSeriesHook`/`AsyncParallelHook`/`Bail`/`Waterfall`…）；Rolldown/Rspack/Rsbuild/Farm/Bun 这些长尾工具各自的适配差异；`transformInclude` 与 `load.filter`/`transform.filter` 新旧 API 的迁移细节；unplugin 内部适配器的完整源码实现；各打包器版本兼容矩阵。

- **推荐的一个执行轨迹例子**：输入——一个 `.ts` 源文件里写了 `if (__DEV__) { console.log('debug') }`，开发者用 `createUnplugin` 写了一个把 `__DEV__` 替换成 `false` 的 transform，分别用 vite / webpack / esbuild 三种方式构建同一个项目。关键中间态——unplugin 工厂被三个不同 framework 各调用一次，`meta.framework` 分别为 `'vite'`/`'webpack'`/`'esbuild'`；webpack 下适配器合成虚拟 loader 挂进 `module.rules`，esbuild 下适配器把 transform 包进 `onLoad` 的 setup。输出——三种工具产出的最终 bundle 里 `__DEV__` 都变成了 `false`，且因为打包器的 dead code elimination，`console.log('debug')` 整段被消除；**一份 transform 逻辑，三种互不兼容的打包器，一致的结果**。这条轨迹演透「一份逻辑分发到多工具」的核心思想，而非演宏变换本身。

> 以上钩子供 Writer 写「动机→核心思想→心智模型→关键权衡→原理演示」；下面事实部分供核对，不要被 Writer 当目录照抄。

## 概念要点

- **unplugin 的定位**：unjs 维护的库，提供「跨构建工具的统一插件系统」，一次编写同时接入 Vite、Rollup、webpack、esbuild、Rspack、Rsbuild、Rolldown、Farm、Bun 等工具。`依据: unplugin 官方文档首页与 Getting Started（unplugin.unjs.io/guide）。`

- **核心 API：`createUnplugin` 工厂**：`createUnplugin(factory)` 接收一个工厂函数 `factory(options, meta) => PluginObject | PluginObject[]`，返回一个带 `.vite`/`.rollup`/`.webpack`/`.esbuild`/`.rspack`/`.rsbuild`/`.rolldown`/`.farm`/`.bun` 各打包器导出属性的对象。这就是「一份工厂、N 个工具入口」的实现形式。`依据: unplugin 官方 Getting Started 文档「Core Factory Function」节。`

- **`meta.framework` 运行时检测**：工厂函数第二个参数 `meta: { framework: string; versions: Record<string,string> }`，让插件在运行时知道当前宿主是哪个工具及其版本号，从而可做条件分支（如「只在 Vite 下启用某特性」）。`依据: unplugin 官方文档「Version Access」节。`

- **统一 hook 集以 Rollup 风格为公约数**：unplugin 暴露的统一 hook 包括 `enforce`、`buildStart`、`resolveId`、`load`、`transform`、`transformInclude`、`buildEnd`、`writeBundle`、`watchChange`。选 Rollup 扁平 hook 模型作为公约数，是因为它是这几种打包器里最简单的（扁平对象 + 函数式 hook，无事件总线、无 loader 分层）。`依据: unplugin 官方文档 hook 列表 + Rollup/Vite/webpack/esbuild 插件 API 横向对比。`

- **`transformInclude`/`filter` 是性能闸门**：webpack 与 Rolldown 的模块 id 过滤发生在 loader 逻辑之外，需要一个独立的 filter hook 才能避免对所有模块无差别跑 transform，否则性能损耗严重。新 API 用 `transform.filter`/`load.filter`（带 `id.include`/`id.exclude`/`code` 子规则）替代旧 `transformInclude`。`依据: unplugin 官方文档「Webpack's id filter is outside of loader logic; an additional hook is needed for better performance on Webpack and Rolldown」+「Filter-Based Hook Syntax」节。`

- **Context API（`this`）**：hook 内通过 `this` 暴露 `parse`（解析 AST，非 Rollup/Vite/Rolldown 需 `setParseImpl`）、`addWatchFile`、`emitFile`、`getWatchFiles`、`warn`、`error` 等。这些能力同样按工具取舍：`addWatchFile`/`getWatchFiles` 在 esbuild 下不可用。`依据: unplugin 官方文档「Context API」节。`

- **bundler-specific 逃生舱**：插件对象可携带 `vite: {...}`、`rollup: {...}`、`webpack(compiler){}`、`esbuild: {...}` 等子字段，声明某个工具独有的额外配置（如 Vite 的 `configureServer`）。这是「公约数 + 逃生舱」设计：公约数取交集，独有能力靠子字段单独补。`依据: unplugin 官方文档「Bundler-Specific Extensions」节。`

- **关键权衡的根源——esbuild 插件 API 故意最小化**：esbuild 官方明确其插件 API「不打算覆盖所有用例」，只提供 `onResolve` 与 `onLoad` 两个回调。这导致 unplugin 在 esbuild 下：不支持 `enforce`（插件顺序需手动维护）、`transform`/`load` 只能返回 JS、无 `addWatchFile`/`getWatchFiles`、无 `watchChange`。这是 Vue Macros 在 esbuild 下「只支持有限特性」的直接技术根因。`依据: esbuild 官方 plugins 文档「This API does not intend to cover all use cases」+ unplugin 官方文档 esbuild 限制节。`

- **关键权衡的对照——webpack 双层架构**：webpack 把「构建生命周期」和「文件变换」分成两层：插件用 `apply(compiler)` + Tapable 命名钩子（`.tap()`/`.tapAsync()`/`.tapPromise()`）挂生命周期，文件变换却交给独立的 loader。webpack **没有插件级 `transform` hook**。因此 unplugin 的 webpack 适配器必须合成一个虚拟 loader 注入 `module.rules`，才能桥接统一的 `transform`。这也是 webpack 适配器最复杂、且行为最易与 Rollup 出现细微差异的原因。`依据: webpack 官方文档「Compiler hooks / Tapable」节 + unplugin 适配机制分析。`

- **Vue Macros 的实际使用形态**：Vue Macros 以 `unplugin-vue-macros` 发布，内部调用 `createUnplugin`，对外暴露 `/vite`、`/rollup`、`/webpack`、`/rspack`、`/esbuild` 等子路径导出；Vue Macros 的 transform 通常在标准 SFC 编译器之前作为预处理运行。`依据: Vue Macros 官方文档「Bundler Integration」节（vue-macros.dev/guide/bundler-integration.html）。`

- **Vue Macros 的支持层级**：官方文档明确「Vite 和 Rollup 完全支持，其他打包器（esbuild/webpack/Rspack/Rsbuild）有限支持」。完全与有限的分界，正是上面 esbuild/webpack 能力被公约数抹平后的产物。`依据: Vue Macros 官方文档「Bundler Integration」支持矩阵。`

## 关键流程

工厂分发与跨工具翻译流程（文字箭头）：
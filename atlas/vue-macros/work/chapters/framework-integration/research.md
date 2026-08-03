# Nuxt / Astro / DevTools 框架集成 · 源码精读

## 给 Writer 的教学钩子（必填，8 子项缺一不可）

- **用户痛点 / 场景**：vue-macros 的转换管道已经能在裸 vite 里跑了，但真实用户往往用的是 Nuxt、Astro 这类上层框架——它们自己早就装配好了 Vue 的官方编译插件。如果集成层「再让 vue-macros 自己造一份 Vue 插件」，两份插件会重复编译、互相打架；如果干脆不接，用户在 Nuxt 里写宏就完全不生效。使用者要的是「在我的框架里开箱即用，且不和框架已有的 Vue 工具链冲突」。

- **一句话核心思想**：**先从宿主框架里把官方 Vue 插件拆出来，再原样喂回 vue-macros 的转换管道**——集成层只做装配与上下文注入，转换内核一行不改。

- **设计动机（为什么需要它）**：vue-macros 的转换内核（那条把所有宏按顺序串起来的管道）自身**不创建**官方 Vue 编译插件，它只是在管道数组的末尾留了一个「槽位」，等外部把 Vue 插件实例塞进来，好让它排在所有宏改写之后、负责最终的 SFC 编译。在裸 vite 场景这个实例由用户自己传；但在 Nuxt/Astro 里，框架已经替用户装配好了一份带框架专属配置的 Vue 插件。于是集成层的全部存在意义就是：**回收框架已装配的那份实例，喂给同一个管道**，既避免重复、又保住框架对 Vue 插件的既有配置。其中「把 Vue 插件放进管道末尾」这一面（已在第 14 章『主聚合插件与转换管道顺序编排』讲透，本章只看它的对偶面——宿主框架里已存在的那份 Vue 插件实例如何被拆出来再喂回去）。同理，`resolveOptions` 的版本探测默认值是第 13 章『统一配置体系与版本感知默认值』的核心，本章只把它当「解析用户配置」的一步调用，不重讲。

- **关键权衡（本 Atlas 的核心）**：
  1. **回收而非重建官方 Vue 插件（拆-注模式）**：做了「先按插件名从框架的 plugins 数组里 splice 移除官方 Vue/JSX 插件、再作为参数喂给 vue-macros、最后把整条管道插回原索引位」的选择 → 换来了管道里全局只有一份 Vue 插件实例、且它的位置由管道精确控制（排在所有宏之后），同时复用了框架对该插件已做好的专属配置 → 代价是集成层硬编码了 `'vite:vue'`/`'vite:vue-jsx'` 这两个具名插件字符串、且要小心插回位置（一个框架保序、另一个不保序，行为有细微差异）。
  2. **用单个布尔做 SSR 分流**：做了「把宿主框架的环境信号（是否客户端构建）压成一个布尔、塞进一个上下文对象、一路透传到可视化面板插件」的选择 → 换来了面板插件无需自己探测运行环境、一个布尔就完成「只在浏览器端挂载」；非该框架场景不传则布尔为空、走默认挂载分支也正确 → 代价是这个布尔本质是「跨三个包的隐式通信通道」，命名泛化、语义脆弱，且只有 SSR 框架会真实区分两端，Islands 架构没有同等信号。
  3. **可视化面板：开发用子服务器、生产用静态托管的双模式**：做了「开发期起一个中间件模式的 vite 子服务器实时编译面板源码、生产期用静态文件服务托管预构建产物」的选择 → 换来了改面板 UI 即时热更新、生产零运行时编译开销 → 代价是两套服务逻辑并存、面板必须有独立构建产物，且分流依赖一个构建期常量替换。
  4. **结构扩展的命名副作用由集成层逐子系统抹平**：做了「当某结构扩展（整文件即 setup）合法化后，宿主框架的自动组件/页面/布局命名会把 setup 当成名字片段，集成层就在框架的三个命名 hook 里分别剥掉这个后缀」的选择 → 换来了用户在该框架下用该扩展写的组件，命名与普通组件完全一致、框架体验无割裂 → 代价是集成层深度耦合了宿主框架的多个内部命名子系统，每接一个框架都得为它的命名约定单独写后处理。

- **最小心智模型（集成一个新宿主框架的步骤）**：
  1. 在框架自己的配置 hook 里，拿到框架已装配好的 vite plugins 数组。
  2. 按插件名从中找出并移除官方的 Vue 插件与 JSX 插件（记下 Vue 插件的原索引位）。
  3. 调用配置解析器，把用户配置 + Vue 版本探测解析成完整选项。
  4. 调转换管道工厂，传入「完整选项 + 刚拆出的两个插件 + 可选的环境上下文」，拿到一条排好序的宏管道插件数组。
  5. 把该数组插回（或追加到）框架的 vite plugins，让 Vue 插件停在它原来的位置。
  6. 可选：注册框架专属的副作用——类型声明注入、可视化面板的入口 tab、命名后缀剥离。
  7. 其中可视化面板由管道在识别到是 vite 宿主时自动装配，集成层只需在框架的开发者工具里挂一个指向固定路径的 iframe 即可。

- **最小原理演示（替代旧"复刻范围"）**：
  - **应演示**：一个几十行的脚本，演透权衡 1（拆-注模式）。模拟一个 `hostFramework(config)`，它预先把一个 `mockVuePlugin` 装进 `config.plugins`；再写 `vueMacros({ plugins: { vue: 拆出的实例 } })` 返回 `[宏A, 宏B, vue]`；演示三步——按名 splice 移除 → 作为参数注入 → splice 插回原索引——最后打印 plugins 数组，能看到 Vue 插件**只出现一次**且**排在所有宏之后**。这段演示演的就是「回收而非重建」这条核心权衡。
  - **应故意省略**：配置解析的版本探测细节、各宏的真实转换逻辑、面板 UI 实现、HMR、构建工具配置、SSR 布尔的透传链路（口述即可）。
  - **演示载体建议（Writer 据此执行）**：本仓库是 TS/JS，建议写成一段能 `node`/`bun run` 直接跑的独立脚本——用普通对象 `{ name: 'vite:vue' }` 模拟插件即可，**不需要真的起 vite**。因为这里演的是「plugins 数组的拆-注-插回时序」这一纯数据流操作，无宿主依赖，能跑最好（非硬要求）。可视化面板的双模式属于另一条权衡，演「时序」不划算，用一张文字执行轨迹带过即可。

- **正文不宜展开的细节**：面板插件 `import.meta.DEV` 常量的构建期替换机制（属 devtools 包的构建配置）；`excludeDepOptimize` 的作用（属管道章）；面板 client 的 UI 实现（独立 vite 应用，不在本章源码范围）；astro 与 nuxt 拆-注逻辑的高度重复（Writer 点到「同一模式复制两份、靠约定收敛」即可，不必逐行对比）；模块声明扩展（`declare module '@nuxt/schema'`）的类型补全作用。

- **推荐的一个执行轨迹例子**：输入——用户在 Nuxt 项目配置里加一个模块名、并在组件里用某个双向绑定宏。关键中间态——配置解析 hook 触发 → 移除 Nuxt 预装的 Vue 插件（记下原索引 k）→ 转换管道工厂收到「已解析选项 + 拆出的 Vue 插件 + 客户端标记」→ 返回 `[结构扩展, props 宏, ..., 双向绑定宏, ..., Vue 插件, 面板插件]` → 整组 splice 插回索引 k。输出——组件先被各宏改写（注入 props/emits 类型），再流到回收的那份 Vue 插件完成最终编译；同时面板挂在固定路径上，仅在客户端可访问。

> 以上钩子供 Writer 写「动机→核心思想→心智模型→关键权衡→原理演示」；下面事实部分供核对，不要被 Writer 当目录照抄。

## 概念要点
- Nuxt 集成是一个 `defineNuxtModule`，`meta.configKey` 设为 `'macros'`，让用户直接在框架配置里写 `macros: {...}` 而非另起插件配置。源码位置: packages/nuxt/src/index.ts:10-15
- Nuxt 在 `vite:configResolved` hook 里完成「拆-注」：内部定义 `findPluginAndRemove(name)` 按插件 `name` 字段定位并 splice 移除，返回 `[插件, 原索引]`，对 `'vite:vue'` 和 `'vite:vue-jsx'` 各执行一次。源码位置: packages/nuxt/src/index.ts:26-43
- Nuxt 把拆出的两个插件连同 `nuxtContext: { isClient }` 一起喂给管道工厂，再用 `splice(idx, 0, ...)` 把整条管道**插回 Vue 插件的原索引位**（保序）；若原本没找到（idx=-1）则降级为 `push`。源码位置: packages/nuxt/src/index.ts:44-53
- Nuxt 把 volar 类型插件路径 push 进 `tsConfig.vueCompilerOptions.plugins`，让 IDE 在 Nuxt 下也认得宏（与第 15 章 volar 镜像配套）。源码位置: packages/nuxt/src/index.ts:20-24
- Nuxt 注册 `devtools:customTabs`，push 一个 `view.type==='iframe'`、`src==='/__vue-macros'` 的面板 tab——这个路径正是 devtools 插件挂载中间件的路径，两个包借此协作出一个面板。源码位置: packages/nuxt/src/index.ts:61-71
- Nuxt 当 `setupSFC` 启用时：把 setup-sfc 的文件正则加进 `vite.vue.include`；并在 `components:extend`/`pages:extend`/`app:resolve` 三个 hook 里分别剥掉组件名、页面路由名、布局名里的 setup 后缀。源码位置: packages/nuxt/src/index.ts:73-109
- Astro 集成是一个 `AstroIntegration`，仅挂 `astro:config:setup` 一个 hook，做与 Nuxt 几乎相同的拆-注，但：不传 `nuxtContext`、不注册面板 tab、不做命名剥离，且插回方式是简单 `push`（不保序）。源码位置: packages/astro/src/index.ts:19-40
- devtools 是一个返回 vite `Plugin` 的工厂，`name='vue-macros-devtools'`，核心在 `configureServer`：先按 `nuxtContext?.isClient === false` 决定是否跳过（SSR 端不挂面板），再按 `import.meta.DEV` 在「vite 子服务器（中间件模式）」与「静态文件服务（sirv 托管预构建产物）」之间二选一，统一挂到固定路径 `'/__vue-macros'`。源码位置: packages/devtools/src/index.ts:15-44
- **管道内核自身不创建 Vue 插件实例**：管道数组里直接放 `options.plugins.vue` / `options.plugins.vueJsx`，末尾 `.filter(Boolean)` 过滤——外部不传则管道里根本没有 Vue 插件（推断：组件将不会被官方编译器处理）。这正是集成层必须「回收」而非「省略」的根本原因。源码位置: packages/macros/src/index.ts:137-138,146
- 面板插件仅在 `framework === 'vite'` 时被管道装配；Nuxt 与 Astro 底层都 import `vue-macros/vite`（即 framework='vite'），故二者都自动获得面板。源码位置: packages/macros/src/index.ts:142-144；packages/nuxt/src/index.ts:4；packages/astro/src/index.ts:2
- `nuxtContext` 在配置解析器里被透传（默认空对象 `{}`），再由管道工厂原样转交给面板插件——它是一条「只对面板有意义」的旁路参数，不被深度处理。源码位置: packages/config/src/options.ts:234-246；packages/macros/src/index.ts:143

## 关键调用链
- **Nuxt 拆-注主链**：`defineNuxtModule.setup` → `resolveOptions(options)` → `nuxt.hook('vite:configResolved')` → `findPluginAndRemove('vite:vue')` / `findPluginAndRemove('vite:vue-jsx')` → `VueMacros({...resolvedOptions, plugins:{vue,vueJsx}, nuxtContext:{isClient}})` → `config.plugins.splice(idx, 0, ...vueMacrosPlugins)`。
  源码位置: packages/nuxt/src/index.ts:16-55
- **Astro 拆-注主链**：`astro:config:setup` → `resolveOptions(options)` → `findPluginAndRemove('vite:vue', ...)` / `findPluginAndRemove('vite:vue-jsx', ...)` → `VueMacros({...resolvedOptions, plugins:{vue,vueJsx}})` → `config.vite.plugins.push(...vueMacrosPlugins)`。
  源码位置: packages/astro/src/index.ts:23-37
- **面板装配与挂载链**：`VueMacros(framework='vite')` → `Devtools({nuxtContext})` → vite `Plugin.configureServer` →（dev：`createServer({middlewareMode:true})` 子服务器 / prod：`sirv(.../client)`）→ 挂到 `'/__vue-macros'` ← Nuxt 的 `devtools:customTabs` iframe 指向同一路径。
  源码位置: packages/macros/src/index.ts:142-144；packages/devtools/src/index.ts:18-42；packages/nuxt/src/index.ts:61-71

## 源码摘录（带行号，全文累计 ≤ 30 行）

Nuxt 的「拆-注」核心（全章灵魂）：
```ts
// packages/nuxt/src/index.ts:41-53
const [vue, idx] = findPluginAndRemove('vite:vue')
const [vueJsx] = findPluginAndRemove('vite:vue-jsx')

const vueMacrosPlugins = await VueMacros({
  ...resolvedOptions,
  plugins: { vue, vueJsx },
  nuxtContext: { isClient },
})
if (idx === -1) {
  config.plugins.push(...vueMacrosPlugins)
} else {
  config.plugins.splice(idx, 0, ...vueMacrosPlugins)
}
```

管道内核里 Vue 插件的「槽位」与面板装配条件（呼应第 14 章管道顺序）：
```ts
// packages/macros/src/index.ts:137-144
options.plugins.vue,
options.plugins.vueJsx,
resolvePlugin(VueDefineRender, framework, options.defineRender),
setupComponentPlugins?.[1],
namedTemplatePlugins?.[1],
framework === 'vite'
  ? Devtools({ nuxtContext: options.nuxtContext })
  : undefined,
```

面板插件的双模式分流（SSR 跳过 + dev/prod 二选一）：
```ts
// packages/devtools/src/index.ts:19-41
if (nuxtContext?.isClient === false) return
if (import.meta.DEV) {
  const { createServer } = await import('vite')
  const subServer = await createServer({
    root: resolve(import.meta.dirname, '../src/client'),
    server: { hmr: { port: await getPort() }, middlewareMode: true },
  })
  server.middlewares.use(DEV_SERVER_PATH, subServer.middlewares)
} else {
  server.middlewares.use(DEV_SERVER_PATH, sirv(resolve(import.meta.dirname, 'client'), { single: true, dev: true }))
}
```

## 易混淆 / 边界 / 推断
- **事实**：Nuxt 与 Astro 的拆-注逻辑近乎相同（同一 `findPluginAndRemove` 模式各写一份），但 Nuxt 保序（`splice(idx,0,...)`）、Astro 不保序（`push`）；Nuxt 多做三件 Astro 没做的事——传 `nuxtContext`、注册面板 tab、setup-sfc 命名剥离。源码位置: packages/nuxt/src/index.ts:41-53,61-109；packages/astro/src/index.ts:25-37
- **事实**：devtools 面板 client 是一个独立 vite 应用（`src/client/` 下有 App.vue/main.ts/vite.config.ts），其 `build` 脚本为 `vite build ./src/client`，产物即 prod 模式 sirv 托管的 `client` 目录。源码位置: packages/devtools/package.json:scripts；packages/devtools/src/client/
- **推断**：`import.meta.DEV` 是构建期常量——devtools 包 `exports['.']` 有 `.dev` 条件指向 `src/index.ts`（开发时 DEV 为真），发布构建时被替换为 false 走 sirv 分支。依据是 package.json 的条件导出与惯用模式，未逐行读 tsdown 配置，标注为推断。源码位置: packages/devtools/package.json:exports
- **推断**：若集成层不把官方 Vue 插件拆出来喂给管道，则管道 `options.plugins.vue` 为 undefined、被 `.filter(Boolean)` 过滤，组件将不经官方编译器处理而报错——故「回收」是功能正确性的必需，非可选优化。依据 macros/src/index.ts:137-138,146 的字面行为合理推断。
- **事实**：`nuxtContext` 当前只承载 `isClient` 一个字段，却以泛化的「上下文对象」形态跨越 nuxt→config→macros→devtools 四个包，是典型的「为未来扩展预留但当下语义单薄」的通道。源码位置: packages/devtools/src/index.ts:8-13；packages/config/src/options.ts:58,246
- **未理解**：`excludeDepOptimize()`（packages/macros/src/index.ts:145）的具体作用不在本章 sourceFiles 范围，属第 14 章管道细节，不展开；devtools client 面板 UI 如何读取各宏转换结果（macros.ts）亦不在本章源码范围。
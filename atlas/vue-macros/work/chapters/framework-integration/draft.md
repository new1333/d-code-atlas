# Nuxt / Astro / DevTools 框架集成

> 本章属于 system 层。前置：主聚合插件与转换管道顺序编排、volar：编译期能力的 IDE 镜像。
> 学完你能：用一句话讲清「为什么 vue-macros 在不同框架里都能开箱即用——靠的是先拆后注、再用一个上下文对象把宿主的环境信号交给面板」。

## 1. 为什么需要它（设计动机）

上一章讲了 volar——它给每个宏在 IDE 里重新实现一份类型层镜像，让编辑器认得那些被编译期擦除的符号。但 volar 解决的是「编辑器视角」；当读者真的把项目跑起来，往往用的是 Nuxt、Astro 这类**更高层的框架**，而不是裸 vite。这些框架早就替你装好了 Vue 官方编译插件、早就调好了一份带框架专属配置的工具链。现在 vue-macros 想插一脚，问题就来了：

- 如果让 vue-macros 自己再造一份 Vue 插件塞进管道，那就会有**两份**官方 Vue 插件。一份是框架装配的、一份是 vue-macros 自己造的，它们会**重复编译同一个 SFC**，互相打架。
- 如果干脆不接，那用户在 Nuxt 里写宏就完全不生效，等于把宏锁死在裸 vite 场景。

读者作为使用者要的很简单：**在我的框架里开箱即用，且不和框架已有的 Vue 工具链冲突**。这一章就是讲 vue-macros 怎么满足这个诉求。

## 2. 核心思想

**先从宿主框架里把官方 Vue 插件拆出来，再原样喂回 vue-macros 的转换管道**。集成层只做装配与上下文注入，转换内核一行不改。

管道内核里给 Vue 插件留的是一个**槽位**：它不创建实例，只在外部传进来时把它排在所有宏之后、负责最终的 SFC 编译（这件事已在第 14 章讲透）。集成层做的全部事情就是**把那个槽位填上**，而且填的不是新造的实例，是从框架 plugins 数组里回收来的、带着框架全部既有配置的那一份。

## 3. 心智模型

集成一个新的宿主框架，固定走七步：

1. 在框架自己的配置 hook 里，拿到框架已装配好的 vite plugins 数组。
2. 按插件名从中找出并移除官方 Vue 插件和 JSX 插件，**记下 Vue 插件的原索引位**。
3. 调配置解析器，把用户配置加上 Vue 版本探测，解析成完整选项（版本探测是第 13 章的现成结论，本章只调一下）。
4. 调转换管道工厂，传入「完整选项 + 刚拆出的两个插件 + 可选的环境上下文」，拿到一条排好序的宏管道插件数组。
5. 把这条数组**插回（或追加到）**框架的 vite plugins，让 Vue 插件停在它原来的位置。
6. 可选：注册框架专属的副作用——volar 类型声明注入、可视化面板的入口 tab、命名后缀剥离。
7. 面板由管道在识别到是 vite 宿主时自动装配，集成层只需在框架的开发者工具里挂一个 iframe 指向固定路径。

整套流程不靠 if-else 去判断「框架装配过 Vue 插件吗」——它默认装配过，找不到原位时就降级追加到末尾，让没装 Vue 插件的极少数场景也能跑通。

## 4. 关键权衡

### 拆-注模式：回收而非重建官方 Vue 插件

集成层做的核心选择是：先按插件名 splice 移除框架预装的 `vite:vue`/`vite:vue-jsx`，再作为参数喂给管道工厂，最后把整条管道插回原索引位。

把这个选择和两个极端方案放一起看更清楚：

| 方案 | Vue 插件实例数 | 位置由谁控制 | 框架专属配置 | 功能正确性 |
|------|---------------|------------|-------------|----------|
| 重建一份 | 2 份（重复编译） | 管道控制 | 丢失 | OK |
| 不接、省略 | 0 份 | N/A | N/A | 组件无人编译 |
| **回收（拆-注）** | **1 份** | **管道控制** | **保留** | **OK** |

换来的是：管道里**全局只有一份 Vue 插件实例**，它的位置由管道精确控制（排在所有宏之后），同时**复用了框架对这份插件已做好的全部专属配置**。Nuxt 给 Vue 插件加的 SSR 选项、Astro 给它加的 Islands 配置，一个字节都不丢。

代价是：集成层硬编码了 `'vite:vue'`/`'vite:vue-jsx'` 这两个具名字符串去匹配插件。一旦 Vue 官方改了插件名，所有集成层都得跟着改；而且 Nuxt 用 `splice(idx, 0, ...)` 保序插回、Astro 用 `push(...)` 不保序，两者的插回行为有细微差异，对后续插件执行顺序敏感。

本质矛盾：转换管道需要精确控制 Vue 插件的位置（要让所有宏改写先于官方编译），与宿主框架已经替 Vue 插件做了一整套专属配置（不能丢）。重建会丢配置；省略会让管道里根本没有 Vue 插件、组件无法被官方编译器处理。拆-注把「同一份实例」同时交给两边——位置由管道控制、配置由框架注入。

### 单布尔 SSR 分流：跨包的隐式通信通道

集成层把宿主框架的环境信号压成一个布尔——`nuxtContext.isClient`——塞进一个上下文对象，一路透传到面板插件。

换来的是：面板插件无需自己探测运行环境，一个布尔就完成「只在浏览器端挂载」；非该框架场景不传则布尔为空，走默认挂载分支也正确。

代价是：这个布尔本质是一条「跨四个包（nuxt → config → macros → devtools）的隐式通信通道」。它的命名 `nuxtContext` 把 Nuxt 的烙印带进了完全不依赖 Nuxt 的配置包和管道包；语义也脆弱，只有 SSR 框架会真实区分两端，Astro 的 Islands 架构没有同等信号，只能空着。

本质矛盾：面板必须只在浏览器端挂载（SSR 端挂了会出错），与面板插件在装配时无法直接探测运行环境（vite 插件实例化发生在构建初始化阶段、拿不到运行期信号）。把判定上提到能拿到环境信号的宿主层、再用一个最小信号透传下去——是典型的「用一个小信号换一片大清晰度」。

### 面板双模式：开发用子服务器、生产用静态托管

可视化面板插件做了**开发期起一个中间件模式的 vite 子服务器实时编译面板源码、生产期用静态文件服务托管预构建产物**的选择。

换来的是：改面板 UI 即时热更新、生产环境零运行时编译开销（产物在发版前 `vite build` 一次就定型）。

代价是：两套服务逻辑并存——dev 分支走 `createServer({ middlewareMode: true })`、prod 分支走 `sirv(.../client)`，分流依赖一个构建期常量 `import.meta.DEV` 被替换为 true 或 false；面板必须有独立的构建产物（`devtools/src/client/` 是一个完整的 vite 应用，有自己的 App.vue、main.ts、vite.config.ts）。

本质矛盾：开发期要快迭代（面板源码改动即时生效），与生产期要零运行时编译开销（不能在用户机器上跑 vite）。同一个挂载路径 `/__vue-macros` 背后接的是两套完全不同的实现，靠构建期常量切换。

### 命名副作用：由集成层逐子系统抹平

当 `setup-sfc`（整文件即 setup）这种结构扩展合法化后，宿主框架的**自动组件/页面/布局命名**会把 setup 后缀当成名字片段——比如 `Foo.setup.vue` 在 Nuxt 自动注册组件时会被叫做 `FooSetup`。集成层就在框架的三个命名 hook 里分别剥掉这个后缀。

换来的是：用户在该框架下用结构扩展写的组件，命名与普通组件**完全一致**，框架体验无割裂。

代价是：集成层深度耦合了宿主框架的多个内部命名子系统——Nuxt 在 `components:extend`、`pages:extend`、`app:resolve` 三个 hook 里都要单独写后处理；每接一个新框架，都要为它的命名约定单独写一份剥离逻辑。

本质矛盾：结构扩展要让某些非标准文件名（如 `.setup.vue`）合法化，与宿主框架的自动命名约定会把文件名当组件标识符。集成层选择在框架的命名子系统里逐个补丁，而不是改宏本身——因为命名是框架的职责、不是宏的职责。

## 5. 最小原理演示

下面的脚本只演第一条权衡——**拆-注模式**。它模拟一个宿主框架预先装好了一个 `vite:vue` 插件，再演示 vue-macros 如何把它拆出来、作为参数注入管道、最后把整条管道插回原索引位。不需要真起 vite，因为这里演的是「plugins 数组上的拆-注-插回时序」这一纯数据流操作。

```ts
// 用普通对象模拟插件——只要有 name 字段就够 findPluginAndRemove 工作
type Plugin = { name: string; kind?: string }

// 宿主框架预装配：vite 已装好一份带框架专属配置的 Vue 插件
const hostVuePlugin: Plugin = {
  name: 'vite:vue',
  kind: '官方 Vue 插件（带框架配置）',
}

// 用户在自己的项目里写的「宿主框架 + macros」配置
function hostFramework() {
  // 框架自己往 plugins 里塞了 Vue 插件（模拟 Nuxt/Astro 的预装配）
  const config = { plugins: [hostVuePlugin, { name: 'framework-internal' }] }
  return config
}

// vue-macros 的转换管道工厂：核心是「把外部传进来的 Vue 插件排在所有宏之后」
function vueMacros({
  vue,
  vueJsx,
}: {
  vue?: Plugin
  vueJsx?: Plugin
}): Plugin[] {
  const macros: Plugin[] = [
    { name: 'macros:setup-sfc', kind: '结构扩展' },
    { name: 'macros:define-props', kind: 'props 重写' },
    { name: 'macros:define-models', kind: '双向绑定' },
    { name: 'macros:better-define', kind: '类型降级' },
  ]
  // 槽位语义：Vue 插件排在所有宏之后；外部不传则 undefined，被 filter(Boolean) 过滤
  return [...macros, vue, vueJsx].filter(Boolean) as Plugin[]
}

// 集成层核心：拆-注三步
function integrateWithHost() {
  const config = hostFramework()

  // 第一步：按插件名从框架 plugins 数组里 splice 移除，记下原索引
  function findPluginAndRemove(name: string): [Plugin | undefined, number] {
    const idx = config.plugins.findIndex((p) => p.name === name)
    if (idx === -1) return [undefined, -1]
    const [removed] = config.plugins.splice(idx, 1)
    return [removed as Plugin, idx]
  }
  const [vue, idx] = findPluginAndRemove('vite:vue')
  const [vueJsx] = findPluginAndRemove('vite:vue-jsx')

  // 第二步：把拆出的插件作为参数喂给管道工厂
  const pipeline = vueMacros({ vue, vueJsx })

  // 第三步：把整条管道插回原索引位（保序）；找不到原位则追加到末尾
  if (idx === -1) {
    config.plugins.push(...pipeline)
  } else {
    config.plugins.splice(idx, 0, ...pipeline)
  }
  return config
}

const result = integrateWithHost()
console.log(result.plugins.map((p) => `${p.name} [${p.kind ?? ''}]`))
```

跑一遍，输出是：

```
macros:setup-sfc [结构扩展]
macros:define-props [props 重写]
macros:define-models [双向绑定]
macros:better-define [类型降级]
vite:vue [官方 Vue 插件（带框架配置）]
framework-internal []
```

注意两件事——**`vite:vue` 只出现一次**（没被重建），且**排在所有宏之后**（位置由管道控制）。这就是「回收而非重建」的全部含义。

## 6. 执行轨迹

拿一个真实场景走一遍：用户在 Nuxt 项目里加了一个模块名 `vue-macros`、在组件里写了 `defineModels` 做双向绑定。

1. Nuxt 启动，触发 `vite:configResolved` hook。此时 Nuxt 已经在 `config.plugins` 里装好了带 SSR 配置的官方 Vue 插件，假设索引是 5。
2. 集成层调 `findPluginAndRemove('vite:vue')`：遍历 plugins，找到索引 5 的那个、splice 移除、返回 `[vuePlugin, 5]`。再做一次 `'vite:vue-jsx'` 的拆-注。
3. 配置解析器收到用户的 macros 配置（比如 `macros: { setupSFC: true }`）和 Vue 版本探测结果，合并成完整 options。
4. 管道工厂 `VueMacros({...options, plugins: { vue: vuePlugin, vueJsx }, nuxtContext: { isClient }})` 返回一条排好序的数组：`[结构扩展, props 宏, ..., defineModels 宏, ..., vuePlugin, 面板插件]`。vuePlugin 在数组里依然是同一份实例。
5. `config.plugins.splice(5, 0, ...pipeline)` 把整条管道**插回索引 5**——保序，所以框架原本在索引 6+ 的其它插件位置不变。
6. 一个组件 `Foo.vue` 流过管道：先被 `setup-sfc` 改文件形态、再被 `defineProps`/`defineModels` 改写注入 props 和 emits 类型、最后流到那份**回收来的** Vue 插件完成最终的 SFC 编译。
7. 同时，面板插件在 `configureServer` 里看到 `nuxtContext.isClient === true`、且当前是 dev 模式，于是 `createServer({ middlewareMode: true })` 起一个子服务器，挂到 `/__vue-macros` 路径；Nuxt 的 `devtools:customTabs` 注册了一个 iframe 指向同一路径，两边协作出一个面板。SSR 端 `isClient === false`，面板直接跳过挂载。

## 7. 教学简化说明

本章演示故意省略了：配置解析里的版本探测细节（第 13 章已讲透）、各宏的真实转换逻辑（前面各章已分别演过）、面板 client 的 UI 实现（一个独立的 vite 应用，不在本章源码范围）、HMR、构建工具配置、`import.meta.DEV` 的构建期常量替换机制、`excludeDepOptimize` 的作用（属第 14 章管道细节）、SSR 布尔的完整透传链路（口述即可）、Astro 与 Nuxt 拆-注逻辑的高度重复（同一模式各写一份、靠约定收敛）。

## 8. 小结

vue-macros 在不同框架里都能开箱即用，不是因为「写了很多份集成代码」，而是因为它把宿主框架已装配好的 Vue 插件当作一种**可回收资源**——拆出来、喂回同一条管道、再插回原位。集成层是装配工，转换内核一行不改；一个布尔跨四个包、面板 dev/prod 双模式、命名副作用逐 hook 抹平，都是把「框架特定的装配上下文」往「转换内核保持不变」这个不变量上靠时不可避免的补丁。

全书从 SFC 解析与增量 AST 编辑那一块最底层的部分开始，一路搭到转换管道、IDE 镜像、再到这一章的框架集成。读者此刻应该能看见一张完整的图：每一章加进来的一块，都没改写过它下面那块的内核。把每一层都设计成「只做装配、不改内核」的形状，是这套宏体系能在六套构建器、多个上层框架、两套 IDE 服务里到处复用的根本原因。
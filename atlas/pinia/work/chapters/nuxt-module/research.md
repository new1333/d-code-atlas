# @pinia/nuxt：SSR payload 状态运输与自动导入 · 源码精读

## 给 Writer 的教学钩子（必填，8 子项缺一不可）

- **用户痛点 / 场景**：在 Nuxt 上用 Pinia，用户希望「写 store 不写 import、SSR 服务端状态自动出现在客户端、改 store 文件不丢状态、有运行时挂载的非状态对象（如路由实例）不被序列化进网络」。没有这个模块，这四件事每件都得手写：每个文件手写 import、自己拼一段序列化脚本、自己写 HMR 接受代码、自己过滤敏感字段。
- **一句话核心思想**：把 Pinia 在 Nuxt 里的三件事——实例化、状态运输、热更新——全部搭便车到 Nuxt 已有的设施（payload 通道、自动导入系统、Vite 插件机制），不另起炉灶。
- **设计动机（为什么需要它）**：Nuxt 已经拥有完整的 SSR payload 序列化系统、自动导入系统、Vite 插件机制。如果 Pinia 自己再造一套，会出现重复序列化、import 样板冲突、HMR 双重监听等集成摩擦。复用 Nuxt 设施能获得「与 Nuxt 语义一致 + 维护成本归零」的双重收益，让 Pinia 在 Nuxt 里像「一等公民」而非外挂。
- **关键权衡**：
  - **复用 Nuxt payload 通道运输 store state** → 换来零自研序列化、payload 自动随请求往返 → 代价是必须遵守 Nuxt 的类型化序列化协议、受 payload 大小限制；同时「不要序列化」标记只能借这套协议「半绕过」式剔除（序列化时替换为占位、反序列化时还原为 undefined）。
  - **runtime plugin 在所有模块注册完成后才挂载、并拆成「主 plugin + payload plugin」两个文件** → 换来让路由等核心模块先就绪、让序列化协议钩子注册时机正确 → 代价是文件分散、插件挂载顺序需维护。
  - **服务端渲染完成后把全局 active pinia 引用清空** → 换来避免全局单例跨请求污染（同一 Node 进程处理多请求时不会被前一请求残留）→ 代价是渲染完成后再调用任何依赖「当前活动 pinia」的代码会失效——这是「Pinia 实例」章全局单例代价在此处的显性化。
  - **AST 扫描 + 文本拼接自动注入 HMR 接受代码** → 换来用户写 store 时零样板 → 代价是仅识别顶层声明形式的 store 定义、且扫描范围限定在项目根目录下，绕过的写法（默认导出、嵌套声明等）不会被自动注入。
- **最小心智模型（3～7 步）**：
  1. 模块安装期：配置 runtime 编译、把 pinia 排除出 vite 预优化避免重复实例、注册类型引用、注册四个核心 API 的自动导入、把用户 stores 目录加入自动导入、dev 模式再追加一个 HMR 注入用的 Vite 插件。
  2. 所有模块注册完成钩子触发：挂载主 runtime plugin 与 payload plugin，让路由等先就绪。
  3. SSR 请求进入：主 plugin 创建 pinia 实例、装到 vueApp、设为全局 active、若已有 payload 则整体回填 state、把 $pinia provide 出去。
  4. SSR 渲染完成：渲染后钩子把 store 集中状态对象拷进 nuxt payload；紧接着把全局 active pinia 清空。
  5. payload 序列化：每个对象经过 Nuxt payload reducer，被标记「不要序列化」的对象返回占位；客户端 reviver 把它还原成 undefined。
  6. 客户端 hydration：主 plugin 再次 setup，读 nuxt payload 里的 pinia 字段，整体赋给新 pinia 的集中状态对象；pinia 核心的 hydration 逻辑（见「State 集中化与 SSR hydration」章）接管后续。
  7. dev 改 store 文件：Vite 触发 HMR 注入插件 transform——首次 transform 已在文件尾部追加 HMR 接受调用，热信号触发后沿用「HMR」章的就地替换逻辑。
- **最小原理演示（替代旧「复刻范围」）**：
  - 应演示：一段纯 Node/TS 脚本，模拟 payload 往返——服务端创建 pinia + 改 state + 给某字段套「不要序列化」标记 → 把 state 拷进「payload」对象 → 经过一个最简 reducer/reviver（用 Symbol 标记 → JSON 序列化时该字段被替换为占位）→ 客户端创建 pinia + 把 payload 灌回 state → 断言两侧 state 相等、被标记字段在客户端缺失。可选第二段：用 acorn 或手写 parser 给一段「顶层变量声明里调用 store 工厂」的源码文本，识别后文本拼接 HMR 接受调用。
  - 每一行对应原理：state 拷贝对应权衡 1（复用 payload）；清空全局 active pinia 对应权衡 3；reducer/reviver 对应权衡 1 的代价；AST 注入对应权衡 4。
  - 应故意省略：Nuxt 完整模块系统、@nuxt/kit 内部 API、Vue 真实 SSR 渲染、optimizeDeps、layers 多 srcDir、composables re-export、prepare:types 注入。
  - **演示载体建议**：纯 TS/Node 脚本（可 tsx 直接跑），不需要真启 Nuxt；AST 部分用最简 parser 即可演透「识别顶层变量声明里调用 store 工厂」这一形态。本章机制与具体宿主（Nuxt）耦合较高，但原理（payload 往返 + AST 注入）完全可脱离宿主演。
- **正文不宜展开的细节**：
  - addPlugin / addImports / addImportsDir / getLayerDirectories 都是 @nuxt/kit 内部 API，正文一句话带过即可。
  - definePayloadReducer/Reviver 的具体协议（Nuxt 的 typed payload），只需点明「这是一套类型化序列化协议」即可。
  - optimizeDeps.exclude.push('pinia') 的 vite dev 优化语义。
  - prepare:types 里 push 类型引用是为了让自动导入类型识别到 usePinia、payload plugin 类型。
  - __DEV__ 与 production Symbol 差异（已在 State 集中化章涵盖，本章不重复）。
- **推荐的一个执行轨迹例子**：
  - 输入：服务端创建 pinia、拿到 counter store、count=1、给 router 字段套「不要序列化」标记。
  - 关键中间态：渲染后钩子触发 → payload.pinia = `{ counter: { count: 1, router: undefined } }`（router 字段被 reducer 替换）；全局 active pinia 清空。
  - 输出：客户端创建 pinia、读 payload、整体赋给 state、组件再次取 store 时 count=1；router 字段缺失，store 内部对该字段会重新跑 setup 注入新的实例。

> 以上钩子供 Writer 写「动机→核心思想→心智模型→关键权衡→原理演示」；下面事实部分供核对，不要被 Writer 当目录照抄。

## 概念要点

- 模块入口 `defineNuxtModule({ meta, defaults, setup })`：meta 兼容 Nuxt 3.15+/4/5。源码位置: packages/nuxt/src/module.ts:29-36
- `setup(options, nuxt)` 内按序：transpile runtime / optimizeDeps.exclude / prepare:types 类型引用 / `modules:done` 内 addPlugin / addImports / storesDirs 处理 / dev Vite 插件。源码位置: packages/nuxt/src/module.ts:38-92
- 关键顺序：runtime plugin 在 `modules:done` 钩子内才 addPlugin（注释 `// Add runtime plugin before the router plugin`，引用 nuxt issue #9130）。源码位置: packages/nuxt/src/module.ts:57-62
- `optimizeDeps.exclude.push('pinia')`：注释 `// avoids having multiple copies of pinia`，dev 模式避免 vite 单独预构建出第二份 pinia。源码位置: packages/nuxt/src/module.ts:47-51
- Auto imports：`defineStore`、`acceptHMRUpdate`、`usePinia`、`storeToRefs` 从 `runtime/composables` 注册；`composables.ts` 实际是 `export * from 'pinia'` + 自定义 `usePinia = () => useNuxtApp().$pinia`。源码位置: packages/nuxt/src/module.ts:65-71, packages/nuxt/src/runtime/composables.ts:1-5
- `storesDirs` 默认 `[resolve(srcDir, 'stores')]`；非默认时遍历 `getLayerDirectories(nuxt)` 把每层 `layer.app` 与 `storeDir` 拼起来 addImportsDir——支持 Nuxt layers 多 srcDir 场景。源码位置: packages/nuxt/src/module.ts:73-86
- 仅 dev 模式注册 HMR Vite 插件，rootDir 限定扫描范围。源码位置: packages/nuxt/src/module.ts:88-91
- runtime 主 `plugin`（defineNuxtPlugin）：createPinia → vueApp.use(pinia) → setActivePinia(pinia) → 若 `nuxtApp.payload.pinia` 存在则整体赋给 `pinia.state.value` → provide $pinia。源码位置: packages/nuxt/src/runtime/plugin.ts:6-23
- SSR `app:rendered` 钩子：把 `toRaw($pinia).state.value` 写入 `nuxtApp.payload.pinia`，紧接着 `setActivePinia(undefined)` 防跨请求污染。源码位置: packages/nuxt/src/runtime/plugin.ts:24-31
- `payload-plugin`：用 `definePayloadPlugin` 注册 reducer/reviver；reducer 检测 `!shouldHydrate(data)` 返回 truthy 占位 `1`（Nuxt 协议要求返回非 falsy 才视为匹配），reviver 直接还原 `undefined`。源码位置: packages/nuxt/src/runtime/payload-plugin.ts:13-20
- `shouldHydrate` 与 `skipHydrate` 共用同一 Symbol：`skipHydrate` 用 `Object.defineProperty(obj, skipHydrateSymbol, {})` 在对象上打标，`shouldHydrate` 检查 `!Object.hasOwn(obj, skipHydrateSymbol)` 决定是否进入 hydration。源码位置: packages/pinia/src/store.ts:115-140
- `autoRegisterHMRPlugin(rootDir)` 返回 Vite plugin，transform 阶段：跳过以 `\x00` 开头的 virtual module id 与不以 rootDir 开头的 id；若代码不含 `defineStore` 或已含 `acceptHMRUpdate` 直接返回；否则用 `this.parse(code)` 拿 AST，遍历顶层 VariableDeclaration / ExportNamedDeclaration，找到 `init.callee.name === 'defineStore'` 的 declarator → 取 `id.name` → 文本拼接 `import.meta.hot.accept(acceptHMRUpdate(...))` 在尾部追加。源码位置: packages/nuxt/src/auto-hmr-plugin.ts:17-63

## 关键调用链

- Nuxt 启动 → `defineNuxtModule.setup` → `modules:done` 钩子 → `addPlugin(plugin)` + `addPlugin(payload-plugin)`。源码位置: packages/nuxt/src/module.ts:59-62
- 请求进入 SSR → `runtime/plugin` setup → `createPinia()` → `vueApp.use(pinia)` → `setActivePinia(pinia)` → 若 payload 有 pinia 则 `pinia.state.value = payload.pinia` → `provide({ pinia })`。源码位置: packages/nuxt/src/runtime/plugin.ts:8-23
- SSR 渲染完成 → `app:rendered` 钩子 → `payload.pinia = toRaw($pinia).state.value` → `setActivePinia(undefined)`。源码位置: packages/nuxt/src/runtime/plugin.ts:25-30
- payload 序列化阶段 → `payload-plugin` reducer（`!shouldHydrate(data) && 1`）→ 标记 skipHydrate 的字段被替换。源码位置: packages/nuxt/src/runtime/payload-plugin.ts:14-18
- 客户端 hydration → `runtime/plugin` setup → 读 `payload.pinia` → 整体赋给 `pinia.state.value`。源码位置: packages/nuxt/src/runtime/plugin.ts:13-15
- dev 改 store 文件 → Vite transform → `autoRegisterHMRPlugin.transform` 注入 acceptHMRUpdate → 浏览器收到 HMR 事件 → 调 `acceptHMRUpdate`（见 HMR 章）。源码位置: packages/nuxt/src/auto-hmr-plugin.ts:21-61

## 源码摘录（带行号，全文累计 ≤ 30 行）

主 plugin 的 hydration 入口与服务端写出（packages/nuxt/src/runtime/plugin.ts:13-30）：
```ts
if (nuxtApp.payload && nuxtApp.payload.pinia) {
  pinia.state.value = nuxtApp.payload.pinia as any
}

'app:rendered'() {
  const nuxtApp = useNuxtApp()
  nuxtApp.payload.pinia = toRaw(nuxtApp.$pinia as Pinia).state.value
  setActivePinia(undefined)
},
```

payload-plugin 的 reducer/reviver（packages/nuxt/src/runtime/payload-plugin.ts:13-20）：
```ts
const payloadPlugin = definePayloadPlugin(() => {
  definePayloadReducer(
    'skipHydrate',
    (data: unknown) => !shouldHydrate(data) && 1
  )
  definePayloadReviver('skipHydrate', (_data: 1) => undefined)
})
```

modules:done 内 addPlugin 顺序（packages/nuxt/src/module.ts:59-62）：
```ts
nuxt.hook('modules:done', () => {
  addPlugin(resolve(runtimeDir, 'plugin'))
  addPlugin(resolve(runtimeDir, 'payload-plugin'))
})
```

auto-hmr-plugin 的 AST 注入尾部拼接（packages/nuxt/src/auto-hmr-plugin.ts:49-57）：
```ts
return {
  code: [
    `import { acceptHMRUpdate } from 'pinia'`,
    code,
    'if (import.meta.hot) {',
    `  import.meta.hot.accept(acceptHMRUpdate(${storeName}, import.meta.hot))`,
    '}',
  ].join('\n'),
}
```

## 易混淆 / 边界 / 推断

- 事实：`payload-plugin` 是独立 Nuxt 插件而非合并进主 plugin。**推断**：原因可能在于 payload 的 reducer/reviver 必须按 Nuxt payload 系统的特定时序初始化，与 createPinia 的 vueApp.use 路径分开更清晰；同时 payload-plugin.ts:7 的 `import {} from 'nuxt/app'`（注释「ensure payload plugin declaration is generated」）暗示它需要触发 Nuxt 的类型生成 pipeline，与主 plugin 的运行时路径解耦更合理。源码位置: packages/nuxt/src/runtime/payload-plugin.ts:7
- 事实：HMR 注入只识别 `VariableDeclaration` 与 `ExportNamedDeclaration`（其 declaration 又是 VariableDeclaration）两种顶层形式，且要求 declarator 的 `id` 是 Identifier、init 是 CallExpression 且 callee.name === 'defineStore'。**事实**：因此 `export default defineStore(...)`（id 不是 Identifier）不会被自动注入；`const useFoo = defineStore(...); export default useFoo` 同样不会（识别形式内不包含 default export）；`defineStore` 被重命名 import（如 `import { defineStore as ds }`）也不会触发（callee.name 写死为 'defineStore'）。源码位置: packages/nuxt/src/auto-hmr-plugin.ts:4-15
- 事实：transform 用 `code.includes('defineStore')` 做粗筛、`code.includes('acceptHMRUpdate')` 直接 skip——意味着用户手写过 HMR 的文件不会再被自动注入，避免重复。源码位置: packages/nuxt/src/auto-hmr-plugin.ts:24
- 事实：`if (!id.startsWith(rootDir)) return` 把扫描限制在项目根目录下；`if (id.startsWith('\x00')) return` 跳过 Vite 的 virtual module（id 前缀 `\x00` 是约定）。node_modules、nuxt 内部文件、virtual module 都不会触发。源码位置: packages/nuxt/src/auto-hmr-plugin.ts:22-23
- 事实：HMR 注入是把代码追加到原文件尾部（前置一个 `import { acceptHMRUpdate } from 'pinia'`），而不是包裹/重写原代码——这是「最小侵入」策略。源码位置: packages/nuxt/src/auto-hmr-plugin.ts:49-57
- 推断：`setActivePinia(undefined)` 在 `app:rendered` 末尾、而非 vueApp.use 后立即调用——是因为渲染期间组件外（如 server-only 派生逻辑、plugin 间相互调用）可能仍需 activePinia；要等整次渲染完成才能安全清理。源码位置: packages/nuxt/src/runtime/plugin.ts:24-31
- 事实：`shouldHydrate` 与 `skipHydrate` 在 pinia 核心共用 Symbol 协议，所以 Nuxt 端的 reducer 不需要知道 pinia 内部细节，只需调 `shouldHydrate(data)` 即可——这是「复用 payload 通道」权衡能落地的关键胶水，让两个独立包在「打标-识别」上零耦合。源码位置: packages/pinia/src/store.ts:115-140
- 事实：composables.ts 仅 5 行，主体是 `export * from 'pinia'` + 自定义 `usePinia`，让 Nuxt 自动导入注册时只指向一个本地入口、再由这个入口转发到 pinia 的真实导出——避免「自动导入路径与运行时模块路径不一致」问题。源码位置: packages/nuxt/src/runtime/composables.ts:1-5
- 未理解：`prepare:types` 里 `references.push({ types: '@pinia/nuxt' })` 与 `payload-plugin` 中 `import {} from 'nuxt/app'`（注释「ensure payload plugin declaration is generated」）的具体协同关系——猜测前者让 `#imports` 识别 `usePinia` 类型，后者触发 Nuxt 把 payload plugin 类型生成到 `.nuxt/types` 里，但未能从代码本身证实。
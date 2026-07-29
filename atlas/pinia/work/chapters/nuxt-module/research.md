# @pinia/nuxt 模块与 SSR payload · 源码精读

> 本章 sourceFiles（相对 repo root `work/source`）：
> - `packages/nuxt/src/module.ts`（Nuxt 模块入口）
> - `packages/nuxt/src/runtime/plugin.ts`（运行时核心插件：createPinia + SSR state 序列化/回灌）
> - `packages/nuxt/src/runtime/composables.ts`（自动导入的 composable 来源）
> - `packages/nuxt/src/runtime/payload-plugin.ts`（Nuxt payload 的 skipHydrate reducer/reviver）
> - `packages/nuxt/src/auto-hmr-plugin.ts`（dev 期 Vite 插件：自动注入 acceptHMRUpdate）

## 0. 全景：模块装配到 SSR 数据流的两条线

本章 5 个文件可归为两条主线，Writer 写正文时建议沿这两条线展开：

1. **构建/装配线**（`module.ts` + `auto-hmr-plugin.ts` + `composables.ts`）：Nuxt 模块在 `setup()` 里配置 transpile、exclude pinia、注册运行时插件、注册自动导入、按 `storesDirs`/layer 展开 store 目录自动导入，并在 dev 下挂一个 Vite 插件自动给 store 文件追加 HMR 代码。
2. **运行时 SSR 数据线**（`plugin.ts` + `payload-plugin.ts`）：核心插件在服务端 `createPinia`、`app:rendered` 时把 `state` 写入 Nuxt `payload`；客户端从 `payload.pinia` 回灌；`payload-plugin` 在序列化阶段剔除被 `skipHydrate()` 标记的值。

## 1. 概念要点

### 1.1 module.ts：Nuxt 模块定义与装配

- 模块通过 `defineNuxtModule<ModuleOptions>` 定义，`meta.name='pinia'`、`configKey='pinia'`，兼容性声明 `nuxt: '^3.15.0 || ^4.0.0 || ^5.0.0'`。
  源码位置: `packages/nuxt/src/module.ts:29-36`
- `ModuleOptions` 只暴露一个可选项 `storesDirs?: string[]`，文档注释 `@default ['stores']`。
  源码位置: `packages/nuxt/src/module.ts:17-27`
- `setup(options, nuxt)` 内用 `createResolver(import.meta.url)` 与 `fileURLToPath(new URL('./runtime', import.meta.url))` 解析出 `runtimeDir`。
  源码位置: `packages/nuxt/src/module.ts:40-41`

**构建配置（4 处副作用）**：

- (a) 转译运行时目录：`nuxt.options.build.transpile.push(resolve(runtimeDir))`。
  源码位置: `packages/nuxt/src/module.ts:44`
- (b) 把 `pinia` 加入 `vite.optimizeDeps.exclude`（若尚未包含），注释明确意图："avoids having multiple copies of pinia"——避免 SSR 与客户端各自预打包出一份 pinia 导致实例不一致。此处用 `??=` 兜底初始化 `optimizeDeps` 与其 `exclude` 数组。
  源码位置: `packages/nuxt/src/module.ts:47-51`
- (c) `prepare:types` hook 里 `references.push({ types: '@pinia/nuxt' })`，让本包类型声明被纳入生成的类型引用。
  源码位置: `packages/nuxt/src/module.ts:53-55`
- (d) 在 `modules:done` hook 内注册两个运行时插件（顺序：先 `plugin`，后 `payload-plugin`）。注释 "Add runtime plugin before the router plugin" 并链接 nuxt/framework#9130，说明注册时机刻意靠前。
  源码位置: `packages/nuxt/src/module.ts:57-62`

**自动导入**：

- `addImports([...])` 显式注册 4 个来自 `runtime/composables` 的符号：`defineStore`、`acceptHMRUpdate`、`usePinia`、`storeToRefs`。
  源码位置: `packages/nuxt/src/module.ts:65-71`
- `storesDirs` 默认值处理：当用户未传时，设为 `[resolve(nuxt.options.srcDir, 'stores')]`（注意 `defaults:{}` 为空，真正默认在 setup 内延迟赋值，且基于 `srcDir` 解析）。
  源码位置: `packages/nuxt/src/module.ts:73-76`
- 自动导入目录展开：用 `getLayerDirectories(nuxt)` 拿到全部 layer，对「每个 storeDir × 每个 layer」做 `addImportsDir(resolve(layer.app, storeDir))`，因此多层（layer）项目里每层的 store 目录都会被纳入自动导入。
  源码位置: `packages/nuxt/src/module.ts:78-86`

**dev-only HMR Vite 插件**：仅 `nuxt.options.dev` 为真时调用 `addVitePlugin(autoRegisterHMRPlugin(resolve(nuxt.options.rootDir)))`，传入项目 `rootDir`。
源码位置: `packages/nuxt/src/module.ts:89-91`

### 1.2 auto-hmr-plugin.ts：自动给 store 文件注入 HMR 代码

- 工厂函数 `autoRegisterHMRPlugin(rootDir)` 返回一个 `satisfies Plugin` 的 Vite 插件，`name: 'pinia:auto-hmr-registration'`，核心在 `transform(code, id)`。
  源码位置: `packages/nuxt/src/auto-hmr-plugin.ts:17-21`
- `transform` 前置四道守卫（满足任一即 `return` 不改写）：
  1. `id.startsWith('\x00')`：跳过虚拟模块（Vite 虚拟模块 id 以 `\x00` 开头）。
  2. `!id.startsWith(rootDir)`：只处理 `rootDir` 之内的文件。
  3. `!code.includes('defineStore')`：无 store 定义则跳过。
  4. `code.includes('acceptHMRUpdate')`：已含 HMR 代码则跳过（避免重复注入）。
  源码位置: `packages/nuxt/src/auto-hmr-plugin.ts:22-26`
- 通过 `this.parse(code)` 解析 AST，遍历**顶层**节点（`ast.body`），只看 `VariableDeclaration` 与 `ExportNamedDeclaration` 两类。
  源码位置: `packages/nuxt/src/auto-hmr-plugin.ts:28-35`
- 辅助函数 `getStoreDeclaration(nodes)`：在变量声明列表里找到 `init` 为 `CallExpression` 且 `callee.name === 'defineStore'` 的那个声明。
  源码位置: `packages/nuxt/src/auto-hmr-plugin.ts:4-11`
- 辅助函数 `nameFromDeclaration(node)`：从声明取 `id.name`（要求 `Identifier`）。
  源码位置: `packages/nuxt/src/auto-hmr-plugin.ts:13-15`
- 命中后，把原代码包在「头部 `import { acceptHMRUpdate } from 'pinia'`、尾部 `if (import.meta.hot) { import.meta.hot.accept(acceptHMRUpdate(${storeName}, import.meta.hot)) }`」之间（用 `\n` join），返回 `{ code }`。
  源码位置: `packages/nuxt/src/auto-hmr-plugin.ts:47-58`
- **设计意图（从代码与命名推断）**：免去用户在每个 store 文件手写 `acceptHMRUpdate` 样板；只追加、不改写原代码，安全性较高。

### 1.3 composables.ts：自动导入的 composable 来源

- 文件极简：`export * from 'pinia'`（转手 pinia 全部导出）+ 自定义 `usePinia`。
  源码位置: `packages/nuxt/src/runtime/composables.ts:3-5`
- `usePinia = () => useNuxtApp().$pinia as Pinia`：从 Nuxt 注入取回 pinia 实例（即 plugin.ts `provide` 的 `$pinia`）。`useNuxtApp` 与 `Pinia` 类型分别来自 `#app` 与 `pinia`。
  源码位置: `packages/nuxt/src/runtime/composables.ts:1-2,5`
- 因此 module.ts 注册的 `defineStore/acceptHMRUpdate/storeToRefs` 实际都经此文件从 pinia 转出，保证整个 Nuxt 应用引用同一份 pinia（呼应 §1.1 的 exclude 优化）。

### 1.4 plugin.ts：运行时核心插件（createPinia + SSR 序列化/回灌）

- `defineNuxtPlugin` 带泛型 `Plugin<{ pinia: Pinia }>`，`name: 'pinia'`。
  源码位置: `packages/nuxt/src/runtime/plugin.ts:6-8`
- `setup(nuxtApp)` 内三步建实例：`createPinia()` → `nuxtApp.vueApp.use(pinia)` → `setActivePinia(pinia)`。
  源码位置: `packages/nuxt/src/runtime/plugin.ts:9-11`
- **客户端回灌**：`if (nuxtApp.payload && nuxtApp.payload.pinia) pinia.state.value = nuxtApp.payload.pinia as any`——客户端首次运行时从 payload 把整棵 state 树直接赋给 pinia，完成水合。（推断：该分支仅在客户端有意义，因为服务端首次渲染时 `payload.pinia` 尚未写入。）
  源码位置: `packages/nuxt/src/runtime/plugin.ts:13-15`
- 通过 `return { provide: { pinia } }` 注入 `$pinia`。
  源码位置: `packages/nuxt/src/runtime/plugin.ts:17-22`
- **服务端序列化**：在 `hooks['app:rendered']` 中，`nuxtApp.payload.pinia = toRaw(nuxtApp.$pinia as Pinia).state.value`——用 `toRaw` 取原始（非代理）state 后写入 payload；随后 `setActivePinia(undefined)` "clear up the reference to pinia on server to avoid holding onto the variable"（注释原文，防止服务端跨请求持有 pinia 实例，是 SSR 隔离的关键，呼应 dependsOn 的 pinia-instance）。
  源码位置: `packages/nuxt/src/runtime/plugin.ts:24-31`

### 1.5 payload-plugin.ts：skipHydrate 的序列化剔除

- 引入 pinia 的 `shouldHydrate`，并用 `definePayloadPlugin` / `definePayloadReducer` / `definePayloadReviver`（来自 `#imports`）注册一个名为 `'skipHydrate'` 的 Nuxt payload 类型。
  源码位置: `packages/nuxt/src/runtime/payload-plugin.ts:1-8,13-19`
- **reducer**：`(data: unknown) => !shouldHydrate(data) && 1`——若该值「不应水合」（被 `skipHydrate` 标记），返回 truthy `1` 表示匹配此 payload 类型；否则返回 `false`（不匹配）。注释 "We need to return something truthy to be treated as a match"。
  源码位置: `packages/nuxt/src/runtime/payload-plugin.ts:14-18`
- **reviver**：`(_data: 1) => undefined`——反序列化时直接还原为 `undefined`。
  源码位置: `packages/nuxt/src/runtime/payload-plugin.ts:19`
- 净效果（事实+推断）：被 `skipHydrate()` 标记的 state 属性在 `payload.pinia` 序列化传输时被替换为 `skipHydrate` 包装、客户端恢复成 `undefined`，从而不把该数据发给客户端。注释总述目的："Removes properties marked with `skipHydrate()` to avoid sending unused data to the client."
  源码位置: `packages/nuxt/src/runtime/payload-plugin.ts:10-12`
- `import {} from 'nuxt/app'` 一行带注释 "ensure payload plugin declaration is generated"——空导入只为触发 Nuxt 的 payload 类型声明生成。
  源码位置: `packages/nuxt/src/runtime/payload-plugin.ts:6-7`

### 1.6 关联 pinia：skipHydrate/shouldHydrate 的实现（dependsOn 锚点）

- `skipHydrateSymbol`：`__DEV__ ? Symbol('pinia:skipHydration') : Symbol()`，用 Symbol 作为「跳过水合」的标记键。
  源码位置: `packages/pinia/src/store.ts:115-117`
- `skipHydrate<T>(obj)`：`Object.defineProperty(obj, skipHydrateSymbol, {})`，在对象上挂标记后原样返回（用于 setup store 中「有状态外壳但非真正 state」的对象，如 router 实例）。
  源码位置: `packages/pinia/src/store.ts:119-128`
- `shouldHydrate(obj)`：`!obj || typeof obj !== 'object' || !Object.hasOwn(obj, skipHydrateSymbol)`——非对象或未被标记时返回 `true`（应水合）。payload-plugin 的 reducer 正是据此判断。
  源码位置: `packages/pinia/src/store.ts:130-140`
- pinia 自身在水合 setup store state 时也用 `shouldHydrate(prop)`：`if (initialState && shouldHydrate(prop)) {...}`，否则跳过该属性的回灌。
  源码位置: `packages/pinia/src/store.ts:514-516`
- 三个符号均从 pinia 入口导出：`export { defineStore, skipHydrate, shouldHydrate } from './store'`。
  源码位置: `packages/pinia/src/index.ts:8`

## 2. 关键调用链

**装配线（构建期，module.ts）**：
```
defineNuxtModule.setup()
  ├─ build.transpile.push(runtimeDir)               # module.ts:44
  ├─ vite.optimizeDeps.exclude.push('pinia')        # module.ts:49-51
  ├─ prepare:types → references.push('@pinia/nuxt') # module.ts:53-55
  ├─ modules:done → addPlugin(plugin) + addPlugin(payload-plugin)  # module.ts:59-62
  ├─ addImports([defineStore, acceptHMRUpdate, usePinia, storeToRefs])  # module.ts:66-71
  ├─ storesDirs 默认 [srcDir/stores]                # module.ts:73-76
  ├─ getLayerDirectories → addImportsDir(layer.app/storeDir)  # module.ts:78-86
  └─ dev ? addVitePlugin(autoRegisterHMRPlugin(rootDir))      # module.ts:89-91
```

**dev HMR 自动注入（auto-hmr-plugin.ts）**：
```
Vite transform(code, id)
  ├─ 守卫: 虚拟模块/rootDir 外/无 defineStore/已有 acceptHMRUpdate → 跳过
  ├─ this.parse(code) → 遍历顶层 VariableDeclaration | ExportNamedDeclaration
  ├─ getStoreDeclaration() 找 callee.name==='defineStore' 的声明
  ├─ nameFromDeclaration() 取变量名 storeName
  └─ 返回 [head import acceptHMRUpdate, 原 code, tail if(import.meta.hot){accept(...)}].join('\n')
```

**运行时 SSR 数据线（plugin.ts + payload-plugin.ts）**：
```
# 服务端
defineNuxtPlugin.setup(nuxtApp)
  createPinia() → vueApp.use(pinia) → setActivePinia(pinia)   # plugin.ts:9-11
  provide: { pinia }  ($pinia)                                # plugin.ts:17-22
app:rendered hook:
  payload.pinia = toRaw($pinia).state.value                   # plugin.ts:27
  setActivePinia(undefined)                                   # plugin.ts:29
# payload 序列化阶段（Nuxt）
  skipHydrate reducer: !shouldHydrate(data) && 1              # payload-plugin.ts:17
# 客户端
defineNuxtPlugin.setup(nuxtApp)
  if (payload.pinia) pinia.state.value = payload.pinia        # plugin.ts:13-15
  skipHydrate reviver: () => undefined                        # payload-plugin.ts:19
```

## 3. 源码摘录（带行号）

### 3.1 module.ts · storesDirs 默认与 layer 展开
```ts
// packages/nuxt/src/module.ts:73-86
    if (!options.storesDirs) {
      // resolve it against the src dir which is the root by default
      options.storesDirs = [resolve(nuxt.options.srcDir, 'stores')]
    }

    if (options.storesDirs) {
      const layers = getLayerDirectories(nuxt)

      for (const storeDir of options.storesDirs) {
        for (const layer of layers) {
          addImportsDir(resolve(layer.app, storeDir))
        }
      }
    }
```

### 3.2 plugin.ts · 服务端序列化（app:rendered）
```ts
// packages/nuxt/src/runtime/plugin.ts:24-31
  hooks: {
    'app:rendered'() {
      const nuxtApp = useNuxtApp()
      nuxtApp.payload.pinia = toRaw(nuxtApp.$pinia as Pinia).state.value
      // clear up the reference to pinia on server to avoid holding onto the variable
      setActivePinia(undefined)
    },
  },
```

### 3.3 payload-plugin.ts · skipHydrate reducer/reviver
```ts
// packages/nuxt/src/runtime/payload-plugin.ts:13-20
const payloadPlugin = definePayloadPlugin(() => {
  definePayloadReducer(
    'skipHydrate',
    // We need to return something truthy to be treated as a match
    (data: unknown) => !shouldHydrate(data) && 1
  )
  definePayloadReviver('skipHydrate', (_data: 1) => undefined)
})
```

### 3.4 auto-hmr-plugin.ts · HMR 代码拼接
```ts
// packages/nuxt/src/auto-hmr-plugin.ts:47-57
          if (storeName) {
            // append HMR code
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

### 3.5 pinia · skipHydrate/shouldHydrate（关联锚点）
```ts
// packages/pinia/src/store.ts:115-140
const skipHydrateSymbol = __DEV__
  ? Symbol('pinia:skipHydration')
  : /* istanbul ignore next */ Symbol()

export function skipHydrate<T = any>(obj: T): T {
  return Object.defineProperty(obj, skipHydrateSymbol, {})
}

export function shouldHydrate(obj: any) {
  return (
    !obj || typeof obj !== 'object' || !Object.hasOwn(obj, skipHydrateSymbol)
  )
}
```

## 4. 易混淆 / 需 Writer 注意

1. **三个 "plugin" 概念别混**：① `module.ts` 本身是 `defineNuxtModule`（Nuxt 模块，构建期装配）；② 它注册的 `runtime/plugin.ts` 是 `defineNuxtPlugin`（运行时核心插件，建 pinia 实例）；③ `payload-plugin.ts` 是 `definePayloadPlugin`（Nuxt payload 的类型化 reducer/reviver 注册，**不建实例**，只管序列化）。三者职责完全不同，正文务必区分。
2. **两阶段 SSR state 传输的协作**：`plugin.ts` 负责把 `state.value` 整棵塞进 `payload.pinia`（`app:rendered`），`payload-plugin.ts` 负责在 Nuxt 序列化 payload 时剔除被 `skipHydrate` 标记的值。Writer 讲 SSR 时应说明这是「先整体序列化、再按标记剔除」的配合，而不是两套独立机制。
3. **`setActivePinia(undefined)` 的意义**：服务端渲染后清理活跃 pinia 引用以隔离请求。这呼应 pinia-instance 章节的 `getActivePinia/setActivePinia`（dependsOn）。Writer 可借此串起全局活跃实例与 SSR 安全的话题。
4. **`storesDirs` 默认值的真实位置**：JSDoc 写 `@default ['stores']`，但 `defaults:{}` 为空，真正默认在 `setup()` 内 `if (!options.storesDirs)` 处基于 `srcDir` 解析赋值（module.ts:73-76）。正文若提默认值，应指明是延迟赋值且相对 `srcDir`。
5. **`vite.optimizeDeps.exclude.push('pinia')` 的目的**：注释原文 "avoids having multiple copies of pinia"。Writer 不要泛化为「性能优化」，应聚焦于「避免 SSR/客户端各持一份 pinia 导致 store 注册表分裂」这一具体动机。
6. **auto-hmr-plugin 的安全边界**：只在 `rootDir` 内、含 `defineStore` 且不含 `acceptHMRUpdate` 的文件上追加代码，且只追加不改写原内容；只处理顶层声明（`getStoreDeclaration` 不递归进嵌套作用域）。Writer 若举例，应说明它**不会**处理写在函数内部的 `defineStore`。
7. **`composables.ts` 的 `export * from 'pinia'`**：意味着自动导入的 `defineStore` 等最终来自此文件转手 pinia；它与 module.ts 的 `optimizeDeps.exclude('pinia')` 共同保证「单一 pinia 实例」。这两点是关联的，建议正文一并讲。
8. **未深究项**：`getLayerDirectories`、`addImportsDir`、`definePayloadReducer/Reviver` 的内部实现属 Nuxt/kit 与 Nuxt payload 机制，不在本章 sourceFiles 内；本摘录仅据调用上下文与注释描述其**行为**（已标注为推断），未读其源码。Writer 如需展开其内部，应另行查证，勿据本摘录臆断。
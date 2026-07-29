---
title: '@pinia/nuxt 模块与 SSR payload'
---

# @pinia/nuxt 模块与 SSR payload

把 Pinia 用进一个纯 SPA，只要两行：`const pinia = createPinia()` 再 `app.use(pinia)`。但把 Pinia 搬进 Nuxt 的同构应用，这「两行」远远不够——服务端每个请求需要独立的 Pinia 实例、用户希望 `defineStore` 等符号自动可用、渲染出来的 store 状态要安全地送到客户端水合（hydrate），而敏感或无用数据又不该跟着外泄。

本章拆解 `@pinia/nuxt` 这五个文件如何一次性解决这些问题。前置概念来自 [[pinia-instance]]（`createPinia` / `setActivePinia` / `$pinia`）与 [[store-definition]]（`defineStore` / setup store 水合 / `skipHydrate`）。

> 贯穿全章的一个核心概念是 **「状态的往返」**：store 的 state 如何在服务端被收集、序列化进 Nuxt payload、随 HTML 下发，再在客户端原样回灌——同时保证整条链路只引用**同一份 Pinia**。

## 全景：构建线与运行时线

这五个文件可归为两条线，正文沿此展开：

```
构建 / 装配线（模块 setup 期，仅一次）
  module.ts ──┬─► composables.ts（单一 pinia 来源）
              ├─► 注册运行时插件 plugin / payload-plugin
              ├─► 自动导入 defineStore / acceptHMRUpdate / usePinia / storeToRefs
              ├─► storesDirs × layers 自动导入 store
              └─► dev 下挂 auto-hmr-plugin（自动注入 HMR）

运行时 SSR 数据线（每次请求 / 首屏）
  plugin.ts        ── createPinia → 序列化 state → payload.pinia → 客户端回灌
  payload-plugin.ts── 序列化时剔除被 skipHydrate() 标记的值
```

下面自底向上：先看「单一 pinia 来源」这个最底层的原语，再叠出装配线，最后落到运行时往返。

## 一、单一 Pinia 来源：composables.ts

整个文件只有两行业务逻辑：

```ts
// packages/nuxt/src/runtime/composables.ts:3-5
export * from 'pinia'
export const usePinia = () => useNuxtApp().$pinia as Pinia
```

`export * from 'pinia'` 把 pinia 的全部导出（`defineStore`、`storeToRefs`、`acceptHMRUpdate`…）原样转手；`usePinia` 则从 Nuxt 注入的 `$pinia` 取回运行时实例。

为什么这点是全章根基？因为后面 `module.ts` 注册的自动导入符号都 `from: composables`（即此文件），意味着应用里用到的 `defineStore` 最终都经它从 pinia 转出。结合下文 `optimizeDeps.exclude('pinia')`，两者共同保证「全应用只引用一份 pinia」——这是 [[pinia-instance]] 中「单一 store 注册表」前提在 Nuxt 下的兑现。

## 二、构建期装配：module.ts

### 2.1 模块定义

```ts
// packages/nuxt/src/module.ts:29-37
const module = defineNuxtModule<ModuleOptions>({
  meta: {
    name: 'pinia',
    configKey: 'pinia',
    compatibility: { nuxt: '^3.15.0 || ^4.0.0 || ^5.0.0' },
  },
  defaults: {},
  setup(options, nuxt) { /* … */ },
})
```

`ModuleOptions` 只暴露一个可选项 `storesDirs?: string[]`。注意 JSDoc 写 `@default ['stores']`，但 `defaults: {}` 其实是空的——真正的默认值在 `setup` 内延迟赋值（见 §2.3）。

### 2.2 四处构建副作用

`setup` 一开始解析出运行时目录，随后产生四项影响构建结果的副作用：

```ts
// packages/nuxt/src/module.ts:40-55
const { resolve } = createResolver(import.meta.url)
const runtimeDir = fileURLToPath(new URL('./runtime', import.meta.url))

// (a) 转译运行时目录
nuxt.options.build.transpile.push(resolve(runtimeDir))

// (b) 避免「多份 pinia」
nuxt.options.vite.optimizeDeps ??= {}
nuxt.options.vite.optimizeDeps.exclude ??= []
if (!nuxt.options.vite.optimizeDeps.exclude.includes('pinia')) {
  nuxt.options.vite.optimizeDeps.exclude.push('pinia')
}

// (c) 把本包类型纳入生成的类型引用
nuxt.hook('prepare:types', ({ references }) => {
  references.push({ types: '@pinia/nuxt' })
})
```

(b) 是与 §一呼应的关键：注释原文 "avoids having multiple copies of pinia"。若不排除，SSR 与客户端会各自预打包出一份 pinia，导致 store 注册表 `_s` 分裂、状态对不上。这不是泛泛的「性能优化」，而是「单一实例」的具体动机。

第四处在 `modules:done` 钩子内注册两个运行时插件：

```ts
// packages/nuxt/src/module.ts:57-62
// Add runtime plugin before the router plugin
nuxt.hook('modules:done', () => {
  addPlugin(resolve(runtimeDir, 'plugin'))
  addPlugin(resolve(runtimeDir, 'payload-plugin'))
})
```

刻意在 router 插件之前注册（注释链接 nuxt/framework#9130），保证 pinia 实例先于路由就绪。

### 2.3 自动导入：符号 + store 目录

```ts
// packages/nuxt/src/module.ts:66-71
addImports([
  { from: composables, name: 'defineStore' },
  { from: composables, name: 'acceptHMRUpdate' },
  { from: composables, name: 'usePinia' },
  { from: composables, name: 'storeToRefs' },
])
```

四个符号都来自 §一的 `composables`。接着是 `storesDirs` 的真实默认值与 layer 展开：

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

可见默认值是基于 `srcDir` 解析的 `[srcDir/stores]`；而 `getLayerDirectories` 让「每个 storeDir × 每个 layer」都被纳入自动导入——多层（layer）项目里每一层的 `stores/` 都会生效。

### 2.4 dev 期挂 HMR 插件

```ts
// packages/nuxt/src/module.ts:88-91
if (nuxt.options.dev) {
  addVitePlugin(autoRegisterHMRPlugin(resolve(nuxt.options.rootDir)))
}
```

仅开发模式，把项目 `rootDir` 传给 §三的 Vite 插件。

## 三、开发期增强：auto-hmr-plugin.ts

[[hmr]] 章讲过 `acceptHMRUpdate` 需要 store 文件手写一段 `import.meta.hot.accept(...)` 样板。本插件做的就是把这段样板**自动追加**，免去手写。

`transform(code, id)` 前置四道守卫，任一命中即原样返回：

```ts
// packages/nuxt/src/auto-hmr-plugin.ts:21-26
transform(code, id) {
  if (id.startsWith('\x00')) return              // 跳过虚拟模块
  if (!id.startsWith(rootDir)) return            // 只处理 rootDir 内的文件
  if (!code.includes('defineStore') || code.includes('acceptHMRUpdate')) {
    return                                       // 无 store 定义 / 已有 HMR → 跳过
  }
```

通过守卫后，`this.parse(code)` 解析 AST，遍历**顶层**节点（仅 `VariableDeclaration` 与 `ExportNamedDeclaration`），用 `getStoreDeclaration` 找到 `callee.name === 'defineStore'` 的声明，取变量名后拼接代码：

```ts
// packages/nuxt/src/auto-hmr-plugin.ts:49-57
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

设计上有两个安全边界值得记住：**只追加、不改写**原代码；**只看顶层声明**，不递归进函数体——所以写在函数内部的 `defineStore` 不会被处理。

## 四、运行时数据线（1）：plugin.ts 建实例与整体序列化

现在进入「状态往返」的主线。`plugin.ts` 是运行时核心插件（`defineNuxtPlugin`），它**真的创建 pinia 实例**：

```ts
// packages/nuxt/src/runtime/plugin.ts:8-15
setup(nuxtApp) {
  const pinia = createPinia()
  nuxtApp.vueApp.use(pinia)
  setActivePinia(pinia)

  if (nuxtApp.payload && nuxtApp.payload.pinia) {
    pinia.state.value = nuxtApp.payload.pinia as any
  }
  // … return { provide: { pinia } }
}
```

三步建实例后（`createPinia → use → setActivePinia`），紧接着判断 `payload.pinia`：

- **服务端首次渲染**：payload 尚未写入，此分支跳过。
- **客户端首屏**：payload 里已有服务端序列化好的 state，直接整棵赋给 `pinia.state.value` 完成水合——这就是「回灌」。

随后通过 `provide: { pinia }` 注入 `$pinia`，供 §一的 `usePinia()` 取用。

服务端这一侧的序列化发生在 `app:rendered` 钩子：

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

两件事：用 `toRaw` 取原始（非代理）state 写入 payload；再 `setActivePinia(undefined)` 清理活跃实例引用。这第二行正是 [[pinia-instance]] 里 `getActivePinia/setActivePinia` 在 SSR 的关键用途——**防止服务端跨请求持有同一个 pinia 实例造成状态串味**。

## 五、运行时数据线（2）：payload-plugin.ts 按 skipHydrate 剔除

[[store-definition]] 里，setup store 常有「有状态外壳但非真正 state」的对象（如 `router` 实例），可用 `skipHydrate(obj)` 给它挂一个 Symbol 标记，让 pinia 水合时跳过它（`shouldHydrate(prop)` 为假则不回灌）。但那只是「客户端不回灌」，数据仍会出现在 payload 里被下发。

`payload-plugin.ts` 把这道防线前移到**序列化阶段**——让被标记的值压根不发给客户端：

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

- **reducer**（序列化时）：`!shouldHydrate(data) && 1`。当值被 `skipHydrate` 标记（`shouldHydrate` 返回 `false`），表达式为 `1`（truthy，声明「这个值归我这种 payload 类型管」）；否则返回 `false` 不匹配。
- **reviver**（反序列化时）：直接还原成 `undefined`。

净效果：被 `skipHydrate()` 标记的 state 属性，在 payload 序列化传输时被替换成轻量标记、客户端恢复成 `undefined`，从而「不把无用数据发给客户端」（文件头注释原话）。

> 注意它与 `plugin.ts` 的协作：`plugin.ts` 负责**整棵** state 塞进 `payload.pinia`，`payload-plugin.ts` 负责**按标记剔除**部分值。这是「先整体序列化、再按标记剔除」的配合，而非两套独立机制——见 §六。

## 六、完整往返：两条线如何协同

把 §四、§五拼起来，就是一次完整的 SSR 状态往返：

```
【服务端】plugin.setup
   createPinia() → use(pinia) → setActivePinia(pinia)
   运行业务 → store.state 被填充
   app:rendered:
     payload.pinia = toRaw($pinia).state.value     # 整棵塞入 payload
     setActivePinia(undefined)                      # 请求隔离
【序列化】Nuxt 序列化 payload
   skipHydrate reducer: 被标记值 → 标记(1)          # 剔除
【下发】payload 随 HTML 注入到客户端
【客户端】plugin.setup
   skipHydrate reviver: 标记 → undefined            # 还原成空
   payload.pinia 存在 → pinia.state.value = payload.pinia   # 回灌水合
```

一个端到端示例。假设 store 定义如下（`token` 不想下发到浏览器）：

```ts
export const useUserStore = defineStore('user', () => {
  const token = ref('secret-xxx')
  const profile = ref({ name: 'Ada' })
  return { token: skipHydrate(token), profile }
})
```

| 阶段 | `payload.pinia.user` |
|---|---|
| 服务端 `app:rendered` 写入 | `{ token: <被标记的 ref>, profile: { name: 'Ada' } }` |
| 序列化经 reducer 处理 | `token` 命中 `!shouldHydrate` → 替换为标记 |
| 客户端经 reviver 还原 | `token` 变为 `undefined`，`profile` 正常水合 |

于是浏览器拿到的 `token` 是空的，既省了传输、也避免泄露；而服务端渲染该 store 时仍可用完整 `token`。

## 小结与易混淆点

1. **三个 "plugin" 职责不同，勿混**：① `module.ts` 是 `defineNuxtModule`（构建期装配）；② `runtime/plugin.ts` 是 `defineNuxtPlugin`（建 pinia 实例 + 序列化/回灌）；③ `payload-plugin.ts` 是 `definePayloadPlugin`（只注册 reducer/reviver，**不建实例**，只管序列化剔除）。
2. **`storesDirs` 默认值位置**：JSDoc 写 `@default ['stores']`，但 `defaults:{}` 为空，真正默认在 `setup` 内 `if (!options.storesDirs)` 处基于 `srcDir` 延迟赋值（`module.ts:73-76`）。
3. **`optimizeDeps.exclude('pinia')` 的动机**：避免 SSR/客户端各持一份 pinia 导致注册表分裂，与 `composables.ts` 的 `export * from 'pinia'` 一起锁死「单一实例」。
4. **`setActivePinia(undefined)` 的意义**：服务端渲染后清理活跃引用以隔离请求，把 [[pinia-instance]] 的全局活跃实例话题与 SSR 安全串起来。
5. **未深究的边界**：`getLayerDirectories` / `addImportsDir` / `definePayloadReducer` 的内部实现属于 Nuxt/kit 与 Nuxt payload 机制，不在本章源码范围，此处仅据调用与注释描述其行为。

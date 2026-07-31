# Nuxt SSR：payload 序列化与自动导入 · 源码精读

## 给 Writer 的教学钩子（必填，8 子项缺一不可）
- **用户痛点 / 场景**：服务端渲染时，组件树里读写过的 store 状态在渲染结束后就随进程消失；浏览器拿到 HTML 重新挂载时，又是一片空白，于是首屏闪烁、首交互数据丢失。手动逐个 store 序列化、再逐个反序列化既啰嗦又容易漏。此外开发时每次改 store 文件都得自己手写一段热更新接收代码，样板重复且易错。
- **一句话核心思想**：把整个状态树当成一坨可直接序列化的载荷，服务端渲染完整体塞进去、客户端整体倒回来，再让构建器在编译期自动补上热更新样板。
- **设计动机（为什么需要它）**：Pinia 把所有 store 的状态存在「一个扁平的、按 store 名分桶的字典」里——这个结构本来是为统一寻址和打补丁服务的，但它顺带天然就是一坨可序列化的普通对象。于是「状态如何跨网络传递」几乎不需要专门的序列化层：直接把这坨字典原样搬进 Nuxt 的请求载荷即可。这套机制正是要榨干这个副产物，让 SSR 的状态传递从「每个框架自己造轮子」变成「直接复用既有数据结构」。
- **关键权衡（本 Atlas 的核心）**：
  - 「整体替换字典而非逐 store 合并」→ 换来「无需为每个 store 写序列化/反序列化、传输与恢复都是一行赋值」→ 代价是「客户端已有的 ref 必须在装配时按『是否参与注水』逐项判断是否覆盖，否则会把客户端刚建好的对象冲掉」。
  - 「渲染完成后立即清空全局活跃实例指针」→ 换来「服务端长生命周期进程下，多个请求不会因残留指针而互相串污染状态」→ 代价是「渲染钩子之后、组件注入上下文之外再取 store，必须重新指明活跃实例，否则拿到的是空」。
  - 「在载荷序列化层用 reducer 折叠掉标记为『不注水』的值」→ 换来「那些本就不该跨网络传递的值（如路由实例、客户端专属对象）既不占带宽、也不污染浏览器端状态」→ 代价是「判定靠一个隐藏 symbol 标记，遇到非普通对象时曾因属性判定方式出过边界 bug，需要额外注册一个载荷插件」。
  - 「编译期扫源码自动注入热更新接收代码」→ 换来「开发者写 store 文件零样板、改完即热替换」→ 代价是「只认『变量名 = 定义工厂()』这种直接声明的固定形态，换名导入或属性访问形态识别不到；且仅开发模式启用」。
- **最小心智模型（3～7 步）**：
  1. 构建期：模块把状态库的 API 注册为自动导入，把状态目录纳入自动导入扫描，开发模式再挂一个源码改写插件。
  2. 服务端启动：创建状态根、装进应用、设为全局活跃实例。
  3. 服务端渲染：组件树读写各 store，所有变更落到那一个扁平状态字典里。
  4. 渲染完成钩子：把字典原样塞进请求载荷；标记为「不注水」的项在序列化时被折叠成占位类型；随即清空全局活跃指针。
  5. 浏览器启动：同样创建状态根、装进应用。
  6. 浏览器恢复：把载荷里的字典整体赋回状态根；被折叠的项还原成空。
  7. 浏览器装配 store：对每个 state 项判断是否参与注水，参与的才用载荷值覆盖，不参与的保留客户端自建值。
- **最小原理演示（替代旧"复刻范围"）**：
  - 应演示：一个极简的「扁平字典整体往返 + 不注水项在序列化时折叠」的最小闭环（几十行）。服务端持有一个 `{ counter: { count }, extra: 被标记对象 }` 的扁平字典；渲染后做两件事——`载荷 = 序列化(去代理(字典))`（序列化时遇标记项返回 truthy 折叠它）、`活跃指针 = 空`；客户端做两件事——`字典 = 载荷`（标记项被还原成 undefined）、装配时对标记项跳过覆盖。这段演示演的是上面权衡 1+3+2：整体替换的便利、序列化层折叠的精妙、清指针的防污染。
  - 应故意省略：Nuxt 模块体系接线、自动导入扫描、类型生成、热更新 AST 改写的完整实现、多层目录（layer）支持、transpile/optimizeDeps 等工程化脚手架。不追求可独立 install，只演「状态如何被原样搬过网络又原样倒回」。
- **正文不宜展开的细节**：optimizeDeps.exclude 排除状态库以防预打包出多份实例的细节；多层 layer 目录叠加扫描；类型引用注入；自动导入清单里为何连热更新函数也一起导出；源码改写插件跳过虚拟模块前缀与非根目录文件的防御性判断；载荷插件里那行「返回 1 表示匹配」的短路写法。这些供 Writer 裁剪，不在正文主线。
- **推荐的一个执行轨迹例子**：输入——服务端一次请求，渲染某页时 counter 的 count 被改成 5，另有一个被标记不注水的路由实例。中间态——渲染完成，扁平字典整体塞入请求载荷，其中路由项被折叠成「不注水」占位类型，全局活跃指针被置空。输出——浏览器创建状态根、把载荷整体倒回字典（counter.count 恢复 5、路由项还原成空），装配 counter 时用 5 覆盖、装配路由项时因标记而跳过、保留客户端自建的路由。

> 以上钩子供 Writer 写「动机→核心思想→心智模型→关键权衡→原理演示」；下面事实部分供核对，不要被 Writer 当目录照抄。

## 概念要点
- 运行时插件在 setup 中创建状态根、装入应用并设为活跃实例；随后若请求载荷里已带状态，就把载荷整体赋给状态根的 value，完成客户端恢复。源码位置: packages/nuxt/src/runtime/plugin.ts:8-15
- 渲染完成钩子 `app:rendered` 把「去代理后的状态根的 value」原样塞进 `nuxtApp.payload.pinia`，随即 `setActivePinia(undefined)` 清掉全局活跃指针以防服务端跨请求串污染。源码位置: packages/nuxt/src/runtime/plugin.ts:24-31
- 「整体赋值」之所以成立，依赖状态根用扁平字典 `state.value[storeId]` 存储所有 store 状态——天然是可序列化的普通对象（呼应 pinia-instance 章的扁平字典权衡）。源码位置: packages/nuxt/src/runtime/plugin.ts:14,27
- `toRaw` 取原始对象再塞载荷，避免序列化响应式代理。源码位置: packages/nuxt/src/runtime/plugin.ts:27
- 载荷插件注册名为 `skipHydrate` 的 reducer/reviver 对：reducer 对「不应注水」的值返回 truthy（`!shouldHydrate(data) && 1`）使其在序列化时被折叠；reviver 在客户端将其还原为 `undefined`，从而既减小传输又不污染客户端。源码位置: packages/nuxt/src/runtime/payload-plugin.ts:13-20
- `skipHydrate` 的实现是在对象上定义一个不可枚举的 symbol 属性；`shouldHydrate` 用 `Object.hasOwn` 判定是否带该标记（带标记=不注水）。这是载荷 reducer 判定的根。源码位置: packages/pinia/src/store.ts:115-140
- store 装配时，对 setup store 的每个 state 项，仅当 `initialState && shouldHydrate(prop)` 为真才用载荷值覆盖（ref 写 value、Map/Set 先 clear），否则保留客户端自建对象——这就是「整体替换字典」不冲掉客户端对象的保障。源码位置: packages/pinia/src/store.ts:514-524
- 模块层负责构建期接线：transpile runtime、把状态库加入 `vite.optimizeDeps.exclude` 以防预打包出多份实例、注入类型引用、在 `modules:done` 注册运行时插件与载荷插件。源码位置: packages/nuxt/src/module.ts:43-62
- 自动导入：模块把 `defineStore/acceptHMRUpdate/usePinia/storeToRefs` 从 composables 注册为自动导入，并把 stores 目录纳入自动导入扫描（支持多层 layer 叠加）。源码位置: packages/nuxt/src/module.ts:64-86
- 仅开发模式下挂载源码改写插件以实现零样板热更新。源码位置: packages/nuxt/src/module.ts:88-91
- composables 本质是 re-export 状态库全部导出，外加 `usePinia = () => useNuxtApp().$pinia`，作为自动导入的统一来源。源码位置: packages/nuxt/src/runtime/composables.ts:1-5
- 热更新改写插件 transform：跳过虚拟模块（`\x00` 前缀）、非根目录文件、不含 `defineStore` 或已含 `acceptHMRUpdate` 的文件；解析 AST 找顶层 `变量 = defineStore(...)`（含 export 包裹），取变量名后在文件末尾注入热更新接收代码。源码位置: packages/nuxt/src/auto-hmr-plugin.ts:21-60
- 注入的热更新代码形如：顶部加 `import { acceptHMRUpdate } from 'pinia'`、末尾加 `if (import.meta.hot) { import.meta.hot.accept(acceptHMRUpdate(变量名, import.meta.hot)) }`。源码位置: packages/nuxt/src/auto-hmr-plugin.ts:49-57
- 改写插件只识别 `callee` 为名为 `defineStore` 的标识符的直接调用形态（别名导入、属性访问形态不识别）——这是「零样板」的代价边界。源码位置: packages/nuxt/src/auto-hmr-plugin.ts:5-11

## 关键调用链
服务端：plugin.setup() → createPinia() + app.use(pinia) + setActivePinia(pinia) → [组件树渲染，状态写入扁平字典] → app:rendered 钩子 → payload.pinia = toRaw(pinia).state.value → setActivePinia(undefined)
源码位置: packages/nuxt/src/runtime/plugin.ts:8-31

序列化折叠：app:rendered 写 payload → Nuxt 序列化 payload → 遇到标记对象时 skipHydrate reducer 命中（!shouldHydrate(data) && 1）→ 折叠为占位类型
源码位置: packages/nuxt/src/runtime/payload-plugin.ts:14-18；判定根 packages/pinia/src/store.ts:136-139

客户端：plugin.setup() → createPinia() + app.use(pinia) + setActivePinia(pinia) → pinia.state.value = payload.pinia（含 skipHydrate reviver 还原 undefined）→ 后续 store 装配时 shouldHydrate(prop) 逐项决定是否覆盖
源码位置: packages/nuxt/src/runtime/plugin.ts:8-15；packages/pinia/src/store.ts:516

热更新（开发期）：module.setup(dev) → addVitePlugin(autoRegisterHMRPlugin) → transform 每个含 defineStore 的文件 → AST 找声明变量名 → 注入 acceptHMRUpdate + import.meta.hot.accept
源码位置: packages/nuxt/src/module.ts:89-90；packages/nuxt/src/auto-hmr-plugin.ts:21-60

## 源码摘录（带行号，全文累计 ≤ 30 行）
客户端整体恢复（演权衡 1：整体替换字典）：
```ts
// packages/nuxt/src/runtime/plugin.ts:13-15
    if (nuxtApp.payload && nuxtApp.payload.pinia) {
      pinia.state.value = nuxtApp.payload.pinia as any
    }
```
服务端塞载荷 + 清指针（演权衡 2：渲染后清活跃指针防串污染）：
```ts
// packages/nuxt/src/runtime/plugin.ts:25-30
    'app:rendered'() {
      const nuxtApp = useNuxtApp()
      nuxtApp.payload.pinia = toRaw(nuxtApp.$pinia as Pinia).state.value
      // clear up the reference to pinia on server to avoid holding onto the variable
      setActivePinia(undefined)
    },
```
载荷层折叠不注水值（演权衡 3：序列化时剔除不应注水的值）：
```ts
// packages/nuxt/src/runtime/payload-plugin.ts:14-19
  definePayloadReducer(
    'skipHydrate',
    (data: unknown) => !shouldHydrate(data) && 1
  )
  definePayloadReviver('skipHydrate', (_data: 1) => undefined)
```
折叠判定的根——symbol 标记（演权衡 3 的实现依据）：
```ts
// packages/pinia/src/store.ts:126-128,136-139
export function skipHydrate<T = any>(obj: T): T {
  return Object.defineProperty(obj, skipHydrateSymbol, {})
}
export function shouldHydrate(obj: any) {
  return (
    !obj || typeof obj !== 'object' || !Object.hasOwn(obj, skipHydrateSymbol)
  )
}
```
装配时按是否注水逐项决定覆盖（演权衡 1 的代价保障）：
```ts
// packages/pinia/src/store.ts:516
        if (initialState && shouldHydrate(prop)) {
```
编译期自动注入热更新（演权衡 4：零样板 HMR）：
```ts
// packages/nuxt/src/auto-hmr-plugin.ts:49-56
              code: [
                `import { acceptHMRUpdate } from 'pinia'`,
                code,
                'if (import.meta.hot) {',
                `  import.meta.hot.accept(acceptHMRUpdate(${storeName}, import.meta.hot))`,
                '}',
              ].join('\n'),
```

## 易混淆 / 边界 / 推断
- 事实：客户端恢复是「整体替换 `state.value`」（plugin.ts:14），而非逐 store 合并；这依赖扁平字典结构，呼应 dependsOn 中的 pinia-instance 章。
- 事实：服务端 `app:rendered` 后清空 `setActivePinia(undefined)`（plugin.ts:29），是 active-pinia 章所讲「服务端多请求须显式防串污染」权衡在此处的落地。
- 推断：载荷 reducer 的 `&& 1` 是「返回 truthy 即视为该 reducer 命中」的短路写法，1 本身无语义，仅作占位 truthy 值；reviver 用 `_data: 1`（下划线前缀=未使用）对应。依据 Nuxt payload reducer/reviver 的通用约定，非源码字面注释。
- 推断：改写插件用 `[import, 原 code, hot code].join('\n')` 把 import 放最前、热更新接收放最后（声明之后），是为了保证接收代码能引用到已声明的 store 变量；源码未显式注释此意图。
- 边界：改写插件只认顶层 `Identifier` 名为 `defineStore` 的直接调用（auto-hmr-plugin.ts:5-11），别名导入（如 `import { defineStore as ds }`）或命名空间访问（如 `pinia.defineStore`）不会被自动注入热更新。
- 边界：transform 会跳过虚拟模块（id 以 `\x00` 开头）与非根目录文件（auto-hmr-plugin.ts:22-23），避免误改依赖与构建产物。
- 事实：`shouldHydrate` 对非普通对象（Map/Set/数组等）的标记判定历史上曾因 `hasOwnProperty` 用法出过 bug，后改为 `Object.hasOwn`（见 CHANGELOG；store.ts:138）。这说明「用 symbol 标记 + 自有属性判定」在跨对象类型时存在边界脆弱性。
- 未理解：模块注释「Add runtime plugin before the router plugin」（module.ts:57-58，引用 issue #9130）具体顺序保障如何由 `modules:done` + addPlugin 落实，未在本章文件中看到显式排序逻辑，留待 Writer 谨慎处理（可只作背景提及）。
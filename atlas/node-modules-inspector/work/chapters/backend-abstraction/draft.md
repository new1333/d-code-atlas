# Backend 抽象：dev/static/webcontainer 三态前端

## 一、想象你给同一个产品做了三个网站

你给「依赖 Inspector」做了三个不同的部署：

- 本地启动 `npx node-modules-inspector`，浏览器里看到的页面会真的去问本地 dev server，能打开编辑器、能跑 publint；
- 把静态 dump 挂到 GitHub Pages 上，给一份只读 JSON 谁都能浏览，但显然没有「打开编辑器」这回事——浏览器拿不到你的文件系统；
- 还有最野的一种：在 webcontainer.dev 里直接 `pnpm install` 任意一个包，浏览器内部跑真的 pnpm，再分析结果。

同一个产品、同一个 UI、三套部署。如果你为每一套各写一份前端，三份代码 90% 重复但又有 10% 不一样，维护很快就会出乱子。
如果你图省事用 `import.meta.env.DEV` 这种运行时分支去区分能力，每个按钮上都会长出 `if (mode === 'static') hideButton()` 之类的代码，能力差异会像霉菌一样蔓延到每一个组件里。

这一章要讲的就是这个项目怎么解这个矛盾。说人话就是：**把「这个后端有没有这个能力」这件事，编码成一个对象的「某个字段是不是 undefined」**。
UI 不去问「我现在在哪个模式」，UI 只问「你这个能力存在吗」——存在我就显示按钮、不存在就当没这回事。

类比一下：Backend 接口像一块谁都能看到的公共留言板，谁需要后端能力就过去看一眼。留言板上贴着一些便利贴，有的便利贴是必贴的（比如「读 payload」），有的是可选的（比如「打开编辑器」）。前端组件路过看一眼，有就调用、没有就跳过。这就是这一章的全部精髓。

## 二、最底层：一个有「可选能力」的对象

我们从最底层那一块开始看：Backend 接口本身长什么样。把它的核心字段落出来大概是这样：

```ts
interface BackendCallableFunctions {
  getPayload: (force?: boolean) => Promise<Payload>           // 必填
  getPackagesNpmMeta?: (specs: string[]) => Promise<Map<...>>  // 可选
  getPublint?: (pkg: PkgRef) => Promise<Msg[] | null>          // 可选
  openInEditor?: (filename: string) => void                    // 可选
  openInFinder?: (filename: string) => void                    // 可选
}

interface Backend {
  name: string
  status: Ref<'idle' | 'connecting' | 'connected' | 'error'>
  connectionError: Ref<unknown | undefined>
  connect: () => Promise<void> | void
  isDynamic?: boolean
  functions: BackendCallableFunctions
}
```

注意 `functions` 里那一堆 `?`。这是这一章最关键的设计。

为什么用「字段是否存在」来表达「能力是否存在」？为什么不直接让所有方法都存在、不可用时抛错？

因为抛错是**事后**才发现的，而「字段是否存在」是**事前**就能检查的。

```ts
// 写法 A：抛错式
try {
  await backend.functions.getPublint(pkg)
} catch {
  // 哦，静态模式不支持
}

// 写法 B：特征检测式
if (backend.functions.getPublint) {
  await backend.functions.getPublint(pkg)
}
```

写法 A 你必须先调用、再处理失败、还得想清楚失败以后状态机该怎么走。
写法 B 在调用前就知道答案，按钮甚至可以在渲染时直接 `v-if` 掉，用户根本看不到一个会失败的按钮。

这种思路在前端工程里其实非常常见——它就是 Feature Detection。当年 jQuery 时代大家判断「浏览器支不支持某个 API」就是这么干的：`if (window.requestAnimationFrame)`。这里把它用在了「自己的后端支不支持某个能力」上。

## 三、工厂：把「能力有没有」前置到构造时

光有接口不够，还得有人去填这个对象。这一节看工厂怎么填。

注意一个反直觉的细节：dev 模式和 static 模式（静态托管）共用同一个工厂，叫 `createDevBackend`。为什么不拆成两个？因为这两个部署的差异**只在一件事上**：传输层是 websocket 还是静态 JSON。其它都一样。

工厂内部会先调一个 `connectDevframe` 去协商传输层（具体怎么协商本章不展开，它来自 devframe 框架）。协商完得到 `rpc` 对象，里面有个 `connectionMeta.backend` 字段告诉你是 `'websocket'` 还是别的。

然后工厂就根据这个值填 Backend 的 `functions`：

```ts
async function createDevBackend(): Promise<Backend> {
  const rpc = await connectDevframe({ baseURL, connectionMeta })
  const isWebsocket = rpc.connectionMeta.backend === 'websocket'
  const call = rpc.call
  const callEvent = rpc.callEvent

  return {
    name: isWebsocket ? 'dev' : 'static',
    status,
    connectionError,
    isDynamic: isWebsocket,
    connect() {},   // 注意：空的
    functions: {
      getPayload: async (force) => call('nmi:get-payload', force),
      getPackagesNpmMeta: isWebsocket
        ? (specs) => call('nmi:get-packages-npm-meta', specs)
        : undefined,
      getPublint: isWebsocket
        ? (pkg) => call('nmi:get-publint', pkg)
        : undefined,
      openInEditor: isWebsocket
        ? (fn) => { void callEvent('nmi:open-in-editor', fn) }
        : undefined,
      // ...其它可选能力同理
    },
  }
}
```

读这段代码的关键是看每个可选函数前面那个 `isWebsocket ? ... : undefined`。

它的意思非常直白：**如果是 websocket 传输（也就是 dev 模式），就把这个函数绑上去；否则就把这个字段直接设为 `undefined`**。

调用方拿到 Backend 的时候，能力有没有已经被决定好了——你不需要在调用点再去判断「现在是什么模式」，你只需要判断「这个函数字段存在吗」。整个 app 里**唯一**关心「是哪种传输」的地方就是这个工厂；它把这件事翻译成「哪些能力存在」之后，其他人就不用再管了。

> 顺便提一句那个空的 `connect()`：在 dev/static 路径里，连接逻辑已经发生在工厂内部（`connectDevframe` 已经把传输层握好手了），所以 Backend 接口里那个 `connect()` 字段虽然被保留，但函数体什么都没做。它在那儿是因为接口契约要求它在，不是因为还有事要做。

## 四、存放：一个模块级的全局单例

Backend 对象造出来之后，要放在一个所有组件都能拿到的地方。

这个项目没走 Vue 的 provide/inject 那一套——它的选择简单粗暴：模块级 `shallowRef` 单例。

```ts
// 模块级全局单例：任意 .ts 模块 import 即可拿
import { shallowRef } from 'vue'
import type { Backend } from '../types/backend'

export const backend = shallowRef<Backend>()

export function getBackend() {
  return backend.value!
}
```

就这么多。entry 组件挂载的时候往 `backend.value` 上贴一个 Backend 实例，之后任何模块只要 `import { backend }` 就能读到。`getBackend()` 那个非空断言 `!` 是个**约定**：调用方只能在 entry 已经把 Backend 安装好之后再调它。entry 组件用 `v-if="!backend || !rawPayload"` 守卫未就绪状态，保证页面在 backend 没准备好之前根本不渲染。

## 五、入口：编译期挑 entry，运行期挑能力

到目前为止讲的都是运行时的事。但还有一个编译期的决策需要单独拎出来说：webcontainer 怎么和 dev/static 分开。

注意 webcontainer 是个完全独立的部署形态——它在浏览器里 boot 一个完整的 node 文件系统，跑真的 pnpm install。这种部署从入口组件开始就长得不一样（要先渲染一个 `Landing.vue` 让用户输入要装哪些包）。

所以 entry 的选择是**编译期**做的：

```ts
import { defineAsyncComponent } from 'vue'

export default defineAsyncComponent(() => {
  if (import.meta.env.BACKEND === 'webcontainer')
    return import('./webcontainer.vue')
  else
    return import('./dev.vue')
})
```

`import.meta.env.BACKEND` 是 Nuxt 在打包时根据构建配置注入的常量。它的取值在编译期就被冻结，运行时拿到的就是个字符串字面量。

这里有个非常容易混的点，必须说清楚：

- **编译期常量 `import.meta.env.BACKEND`**：决定「打包出哪一份 SPA」。它只挑 entry 组件，不挑能力。
- **运行时字段 `backend.isDynamic` / `backend.functions.X`**：决定「这份 SPA 跑起来时有哪些能力」。

两件事管的层级不一样，不要混为一谈。webcontainer 包永远不会在用户浏览器里临时切回 dev 模式——它打包出来就是个 webcontainer 包。但 webcontainer 自己造的 Backend 仍然满足 Backend 接口契约，所以下游 UI 代码完全不用关心这种区别。

## 六、消费：UI 怎么用

最后看一眼 UI 怎么用这件事。两种用法并存，对应不同粒度。

**粗粒度**：整块面板的显隐。`v-if="backend.isDynamic"`——比如「维护者行动建议」整个区块在静态模式就不显示，因为背后要拉的 npm registry 数据静态 dump 里根本没有。

**细粒度**：单个按钮的显隐。`v-if="backend?.functions.openInEditor && pkg.filepath"`——比如某个包的详情面板上「在编辑器打开」按钮，在静态模式就消失了。

数据获取层 `fetchData()` 也是同样模式：拉 payload 是无条件的（getPayload 必填），但拉补充元数据时写守卫：

```ts
if (backend.functions.getPackagesNpmMeta && npmMetaSpecs.length) {
  promises.push(backend.functions.getPackagesNpmMeta(npmMetaSpecs).then(...))
}
```

静态模式下守卫不通过、直接跳过，整段拉取逻辑根本不进入。错误也不会进 `connectionError`，因为根本没发起请求。

## 七、原理演示：50 行跑完整个故事

写一段独立 TS 脚本演示「同一份 render、两种 backend、能力自然降级」。它跟传输层、跟 Vue 响应式、跟 Nuxt 完全没关系，只演示「接口契约 + 工厂 + 特征检测」这件事本身。

```ts
// 必填：getPayload；可选：openInEditor
interface Backend {
  name: string
  isDynamic?: boolean
  functions: {
    getPayload: () => Promise<Payload>
    openInEditor?: (filename: string) => void
  }
}

interface Payload {
  packages: { name: string, filepath: string }[]
}

// 工厂 A：静态后端，只有 payload（一个写死的字面量）
function createStaticBackend(dump: Payload): Backend {
  return {
    name: 'static',
    functions: {
      getPayload: async () => dump,
      // 注意：openInEditor 直接不写
    },
  }
}

// 工厂 B：动态后端，模拟有 RPC 通道
function createDynamicBackend(): Backend {
  return {
    name: 'dev',
    isDynamic: true,
    functions: {
      getPayload: async () => ({
        packages: [{ name: 'vue', filepath: '/node_modules/vue/index.js' }],
      }),
      openInEditor: (filename) => {
        console.log(`   → 已发送打开编辑器请求：${filename}`)
      },
    },
  }
}

// 同一份 render：永远画 payload，但只有 backend.functions.openInEditor 存在时才画按钮
async function render(backend: Backend) {
  console.log(`\n[${backend.name}] 渲染中...`)
  const payload = await backend.functions.getPayload()
  for (const pkg of payload.packages) {
    console.log(`  · ${pkg.name}  (${pkg.filepath})`)
    if (backend.functions.openInEditor) {
      console.log(`    [打开编辑器]`)
    }
    else {
      console.log(`    （当前部署不支持打开编辑器）`)
    }
  }
  // 试着真点一次按钮
  const first = payload.packages[0]
  if (first && backend.functions.openInEditor) {
    backend.functions.openInEditor(first.filepath)
  }
}

// 跑一遍
await render(createStaticBackend({
  packages: [{ name: 'react', filepath: '/node_modules/react/index.js' }],
}))
await render(createDynamicBackend())
```

预期输出：

```
[static] 渲染中...
  · react  (/node_modules/react/index.js)
    （当前部署不支持打开编辑器）

[dev] 渲染中...
  · vue  (/node_modules/vue/index.js)
    [打开编辑器]
   → 已发送打开编辑器请求：/node_modules/vue/index.js
```

这段脚本演的就是整章的核心：**render 函数一份代码、两种行为，靠的就是「特征检测」**。把它跑通，你就理解了这个项目为什么这么设计。

## 八、关键权衡

这一章拆出 4 条权衡来讲。它们其实是同一个「用接口契约抹平部署差异」大思路下，分别押注的 4 个赌注。

### 权衡 1：能力下沉为可选函数字段（核心权衡）

**做了什么**：把「这个部署有没有这个能力」编码成 Backend 接口上的「函数字段是否存在」。

**换来了什么**：
- **同一份 UI 代码可以跑 dev/static/webcontainer 三种部署**，零代码分支；
- **调用点用特征检测决定按钮可见性**——`v-if="backend.functions.openInEditor"` 一行搞定，UI 永远不会渲染一个会失败的按钮；
- **能力差异被封装在工厂内部**——整个 app 里只有工厂一处关心「现在是什么部署」，其它地方只看接口。

**代价**：
- **每个调用方都得写 `if (backend.functions.X)` 守卫**，漏一处就是运行时 NPE（你调了一个 undefined 函数）；
- **类型层面没法表达「dev 模式下这些字段都应该存在」**——TS 的可选 `?` 是一刀切的，dev 模式拿到 `getPublint` 仍然要做守卫，哪怕你知道它一定有；
- **能力发现被前置到构造时**——好处是调用点干净，坏处是如果你部署后想「补」一个能力，只能改工厂、改 entry、重新打包。

这条是本章的灵魂。理解了它，其它三条都是它的延伸。

### 权衡 2：dev 与 static 共用一个工厂

**做了什么**：没有拆 `createDevBackend` 和 `createStaticBackend` 两个工厂，而是让 `createDevBackend` 内部根据协商到的传输层决定一切。

**换来了什么**：
- **dev server 和静态 build 共一份入口代码**，没有重复；
- **分支由传输层显式声明**（`isWebsocket = rpc.connectionMeta.backend === 'websocket'`），而不是用编译期常量硬切——意味着同一份代码在不同部署里能产出能力截然不同的实例，但代码本身是同一份。

**代价**：
- **读者第一次看到这个工厂会有点懵**：「为什么一个工厂产出两种 Backend？」你必须理解 `isDynamic` 是运行时协商结果，不是编译期常量；
- **类型上对 dev 模式不友好**——前面说过，dev 模式下 `getPublint` 一定存在，但类型无法表达这种「按部署形态收紧」，dev 调用方还是得写守卫。

如果项目当初拆成两个工厂，类型可以更精确（`DevBackend` 里 `getPublint` 必填），但代码会重复一份。这个项目选了不重复。

### 权衡 3：编译期常量只挑 entry，不挑能力

**做了什么**：`import.meta.env.BACKEND` 只用来选入口组件（webcontainer vs dev/static），**不**用来在 UI 里做能力分支。

**换来了什么**：
- **webcontainer 和 dev/static 是两个独立的 SPA 包**——bundle 更瘦，dev 包里不会带上 webcontainer 的 `WebContainer.boot` 等一大坨代码；
- **能力差异仍由运行时 Backend 接口管**——常量只负责「选 entry」这一件事，职责单一。

**代价**：
- **同一份 SPA 不能跨形态切换**——webcontainer 包不能临时退回 dev 模式，因为它编译期就没把 dev 入口打进去；
- **常量偶尔会被借用**——比如默认过滤器配置在 webcontainer 模式下会把 `excludeWorkspace` 默认设为 true。这种「行为默认值差异化」实际上偷偷用了编译期常量参与运行时行为，是个小例外。

总体上这个项目克制地让编译期常量只做「挑 entry」这一件事。能力差异都交给运行时接口，这是它能在三态间共享 UI 的关键。

### 权衡 4：Backend 用模块级 shallowRef 全局单例

**做了什么**：不走 Vue 的 provide/inject，直接 `export const backend = shallowRef<Backend>()` 放在模块顶层。

```ts
// 模块级全局单例：任意 .ts 模块 import 即可拿
import { shallowRef } from 'vue'
import type { Backend } from '../types/backend'

export const backend = shallowRef<Backend>()

export function getBackend() {
  return backend.value!
}
```

**换来了什么**：
- **任意模块 `import { backend }` 就能拿**，不需要在 Vue 组件树里逐层 provide/inject 透传；
- **非组件代码也能用**——比如数据获取层这种纯逻辑模块里调 `getBackend()`，它本来就拿不到 Vue 的 inject context；
- **shallowRef 而非 ref**——Backend 内部含 RPC 闭包和 `Ref` 字段，深响应式化既无意义又有开销，shallowRef 只在 `.value` 整体替换时才触发响应。

**代价**：
- **模块全局紧耦合**——整个 app 同时只能有一个 Backend，不能并存两个；
- **测试要重置模块**——单测里换 Backend 得重新加载模块，比换 provide 的代价大；
- **必须用 shallowRef 而不是 ref**——这是个隐性约束，写新代码的人如果不注意用了 `ref`，Backend 内部那些 `Ref` 字段会被深响应式化，可能引发意外重渲染甚至循环。

这条权衡的本质是：**用一个不那么「Vue 正统」的全局变量，换来了在大型应用里更顺手的能力访问**。这个项目里 Backend 的访问点极多（几十个组件都摸它），如果走 provide/inject 透传，组件树会被层层 prop drilling 污染。

## 九、走一遍执行轨迹

最后用一个真实场景把整章串起来。场景：用户打开一个静态托管页（比如 `everything.antfu.dev`）。

```
浏览器加载页面
  ↓
Nuxt 启动，编译期常量 import.meta.env.BACKEND !== 'webcontainer'
  ↓
entries/index.ts 的 defineAsyncComponent 解析到 './dev.vue'，加载 dev 入口组件
  ↓
dev.vue 调 createDevBackend()
  ↓
createDevBackend 内部 connectDevframe({ baseURL, connectionMeta }) 发现 ./__connection.json
  ↓
__connection.json 声明 backend: 'static'（不是 'websocket'）
  ↓
isWebsocket = false
  ↓
工厂按这个值填 Backend：
  · name = 'static'
  · isDynamic = false
  · getPayload = 绑定到静态 dump 的读取
  · getPackagesNpmMeta / getPublint / openInEditor / openInFinder = 全部 undefined
  ↓
backend.value = b  ← 单例安装
  ↓
fetchData() 被调用
  ↓
fetchData 内：
  · getPayload() 必跑  ← 静态 dump 读出来
  · if (backend.functions.getPackagesNpmMeta && ...) ← 守卫不通过，跳过
  · Promise.all([])  ← 空 promise，立即完成
  ↓
UI 渲染：
  · 主表格照常显示数据
  · 「打开编辑器」按钮因 v-if="backend.functions.openInEditor" 不通过，自然消失
  · 维护者行动面板因 v-if="backend.isDynamic" 不通过，整块不渲染
  ↓
最终页面：有完整数据、没有动态交互按钮
```

注意这条链路上**没有一个 `if (mode === 'static')`**。所有「静态模式下应该没有 XX」的逻辑，都通过 Backend 接口的字段缺失自然实现。

这就是这一章想让你带走的东西：**接口上的可选字段，是表达「部署能力差异」最干净的方式**。把能力差异封装在工厂一处，让 UI 永远只做特征检测——一个产品就能从容地跑在三套截然不同的部署上。
# @pinia/nuxt：搭便车搭出四个零样板

你刚把 `@pinia/nuxt` 装上，在 `stores/counter.ts` 里随手写了个 `defineStore`，回车刷新页面，发现四件事居然都自动到位了：

- 组件里 `useCounter()` 没写 `import` 也认得；
- 服务端算出来的 `count = 1`，客户端首次渲染就是 1，不用再发请求；
- dev 模式下改 store 文件，组件里那份状态没被清空；
- 给某个字段套 `skipHydrate(...)`，网络响应里那个字段真的就消失了。

四件事，零配置。这章要拆的就是 `@pinia/nuxt` 怎么把这四件事全部搭到 Nuxt 已经造好的车上——payload 序列化通道、自动导入系统、Vite 插件机制——而不是自己再造一份。说人话就是：**Nuxt 已经在跑一趟从服务端到客户端的货车，Pinia 把自己的 state 装箱贴标签塞上去就行了**。

下面按从下到上拆：先看模块挂载期埋了哪些钩子，再看一次 SSR 请求里 state 怎么上车上车下车，然后看 `skipHydrate` 怎么从 payload 里把字段抹掉，最后看 HMR 是怎么在编译期往你的源码里贴东西的。

## 一、模块挂载期：趁 Nuxt 还在拼装，往各处贴钩子

Nuxt 模块的本质是：在 Nuxt 自己还没拼完的时候，提前埋好一批「等会儿要触发的钩子」。`@pinia/nuxt` 的 `setup` 函数按这个顺序贴：

1. 把 runtime 目录加进 `build.transpile`，让运行时文件被正确编译；
2. 把 `pinia` 加进 `vite.optimizeDeps.exclude`，dev 模式下不让 Vite 单独预构建出第二份 pinia——避免页面上同时存在两个 pinia 实例；
3. 注册四个核心 API 的自动导入：`defineStore`、`acceptHMRUpdate`、`usePinia`、`storeToRefs`，全部从一个本地 `composables` 入口转发到真正的 pinia；
4. 把用户 stores 目录（默认 `<srcDir>/stores`）加进自动导入，多层 layers 项目会按每层的 `app` 目录分别 add；
5. 在 `modules:done` 钩子里 `addPlugin(main)` + `addPlugin(payload-plugin)`；
6. dev 模式再追加一个 Vite 插件用来注入 HMR 接受代码。

第 5 步的时机是有讲究的——**主 plugin 必须在路由等核心模块都注册完之后才挂**，否则可能拿到一个还没装好 router 的 vueApp。`modules:done` 这个钩子就是 Nuxt 给的「所有模块都就位」信号。

第 3 步那个 `composables` 文件本身只有 5 行：`export * from 'pinia'` 加一个自定义的 `usePinia = () => useNuxtApp().$pinia`。让自动导入路径只指向这一个本地入口、再由它转发到真正的 pinia——避免「自动导入路径与运行时模块路径不一致」的尴尬。

## 二、SSR：渲染完成后，把 state 拷进 payload

服务端渲染走完一整圈后，Nuxt 会广播一个 `app:rendered` 钩子。`@pinia/nuxt` 的主 runtime plugin 就在这个钩子里把当前 pinia 的全部 state 拷贝到 `nuxt.payload.pinia`。

主 plugin 的 setup 流程是：

```
createPinia()
   ↓
vueApp.use(pinia)        ← 把 pinia 装进 Vue app（同时触发 pinia 自身的 toBeInstalled 队列）
   ↓
setActivePinia(pinia)    ← 设全局活动指针，让「组件外的 useStore」也能拿到当前实例
   ↓
若 payload 已有 pinia 字段 → pinia.state.value = payload.pinia   ← 客户端首屏走这里
   ↓
provide({ pinia })       ← 暴露成 nuxtApp.$pinia
```

到了 `app:rendered` 钩子，做两件事：

```
nuxtApp.payload.pinia = toRaw($pinia).state.value   ← 拷一份集中 state 进 payload
setActivePinia(undefined)                            ← 立刻清空全局活动指针
```

第二行是关键。为什么要在渲染完才清？因为渲染期间组件外（server-only 派生逻辑、插件间相互调用）可能仍需要 active pinia；只有等整次渲染完成才能安全清理。**不清的后果很严重**：同一个 Node 进程会连续处理多个请求，全局 active pinia 是个单例，第二个请求进来时若残留第一个请求的实例，store 数据就串了。这是「Pinia 实例」章里「全局 activePinia 单例」的代价在 SSR 场景的显性化。

## 三、客户端：拿到 payload 直接灌进 state

客户端的 setup 流程跟服务端几乎一样，区别只在于：服务端那次 `payload.pinia` 还没填，所以走的是「创建空 state」分支；客户端那次 `payload.pinia` 已经被 Nuxt 反序列化好了，于是 `if (nuxtApp.payload.pinia) pinia.state.value = payload.pinia` 这行命中，把整份 state 一次性灌进新 pinia。

接着 `vueApp.use(pinia)` 触发 pinia 内部的 hydration 钩子，让每个 store 把对应字段搬运到自己的 ref 上。这部分的细节（按值类型分支、`skipHydrate` 标记、Map/Set 重建）已经在「State 集中化与 SSR hydration」章讲过，这里只点一句：**Nuxt 这一层只负责把整份 state 安全运到客户端，剩下交给 pinia 核心**。

## 四、skipHydrate：用「打标 + 替换」从 payload 里剔字段

你的 store 里可能有这种字段：服务端从某处抓了个 router 实例、或者一个 Vue 组件实例、或者一个 WebSocket 连接塞进 store。这种对象**不该被序列化进 HTML**——它太大、它只在客户端才有意义、或者它根本不能序列化。

Pinia 给的 API 是 `skipHydrate(obj)`，它会用 `Object.defineProperty` 在对象上贴一个 Symbol 标记。`shouldHydrate(obj)` 检查这个标记决定要不要参与 hydration。

`@pinia/nuxt` 在 `payload-plugin.ts` 里把这套标记接到 Nuxt 的 payload 序列化协议上：

```ts
definePayloadReducer('skipHydrate', (data) => !shouldHydrate(data) && 1)
definePayloadReviver('skipHydrate', (_data: 1) => undefined)
```

两行就够了。reducer 在序列化时检查「这个对象是不是被标记了不要 hydrate」，是的话返回占位值 `1`（Nuxt 协议要求返回 truthy 才算匹配）；reviver 在反序列化时把占位值还原成 `undefined`。

注意这里有个微妙的细节：**reducer 必须返回 truthy**。如果写成 `!shouldHydrate(data)` 单独返回，遇到 `false` 时 Nuxt 会认为没匹配，字段会按原样序列化。所以源码里写成 `&& 1`——`!shouldHydrate(data)` 为 `true` 时返回数字 `1`，为 `false` 时整个表达式就是 `false`。

这套机制本质是「半绕过」——字段名还在 payload 里，但值被替换成了一个 1 字节的占位。它没真正从 payload 字段集中移除，而是把值抹掉了。为什么不做「真删除」？因为 Nuxt 的 payload 协议是「类型化序列化」的——每个被替换的值都带一个类型标签，整个 payload 在客户端是按规则逐字段还原的。要让「字段消失」就得在更上层动 schema，那就不在 reducer 这一层能办的事了。

## 五、HMR：扫源码、首尾各贴一段

改一行 store 代码，浏览器里组件的本地状态居然没被清空。这件事看起来像魔法，其实是**编译期**做的——Vite transform 阶段往你的源码里贴东西。

`@pinia/nuxt` 在 dev 模式注册了一个 Vite 插件，每个被请求的模块都会过一遍它的 `transform`。流程是这样的：

```
transform(code, id)
   ↓
id 以 \x00 开头？           → 跳过（Vite virtual module）
   ↓
id 不以 rootDir 开头？      → 跳过（node_modules / nuxt 内部文件都不扫）
   ↓
code 不含 'defineStore'？    → 跳过（粗筛）
   ↓ 已含 'acceptHMRUpdate'？ → 跳过（用户手写过 HMR，避免重复）
   ↓
this.parse(code) 拿 AST
   ↓
遍历顶层节点：VariableDeclaration 或 ExportNamedDeclaration
   ↓
在 declarations 里找：init.callee.name === 'defineStore'
   ↓
取 declarator.id.name（比如 'useCounter'）
   ↓
产出新代码
```

最后产出的代码长这样——**注意是首尾各贴一段，原文件居中不动**：

```ts
import { acceptHMRUpdate } from 'pinia'   ← 顶部新增一行 import
// ↓↓↓ 原文件完整内容 ↓↓↓
import { ref } from 'vue'
export const useCounter = defineStore('counter', () => {
  const count = ref(0)
  return { count }
})
// ↑↑↑ 原文件完整内容 ↑↑↑
if (import.meta.hot) {                    ← 末尾追加一个 if 块
  import.meta.hot.accept(acceptHMRUpdate(useCounter, import.meta.hot))
}
```

也就是说，插件**没有重写 AST、没有包裹原代码**，只是在文件最前面贴一行 import、最后面贴一段 if 块，原文件一字不动夹在中间。这是「最小侵入」策略的体现——能文本拼接就绝不走 AST 重写，重写一次就有一次出错风险。

到了浏览器收到 HMR 信号时，Vite 触发新模块的 `import.meta.hot.accept` 回调，回调里调 `acceptHMRUpdate(useCounter, import.meta.hot)`，剩下的就地替换逻辑由 pinia 核心的 HMR 系统接管（详见「HMR」章）。

**这个机制有边界**，得知道什么情况下不会被自动注入：

- `export default defineStore(...)`——`id` 不是 Identifier，不会被识别；
- `defineStore('foo', {...})` 作为表达式语句单独调用——它不是 VariableDeclaration，扫不到；
- `import { defineStore as ds }` 然后用 `ds(...)`——`callee.name` 写死比较的是字符串 `'defineStore'`，所以**别名调用一定不会被识别**；
- 文件在 `node_modules`、Nuxt 内部目录、以 `\x00` 开头的 virtual module——`rootDir` 限定把它们全部排除在外。

这四条边界里，前三条都因为同一个原因：扫描器只认**顶层 VariableDeclaration / ExportNamedDeclaration 形式**里 `callee.name === 'defineStore'` 的字面调用。其他形式（默认导出、表达式语句、别名）都不在识别范围内。这是「最小实现」的代价——一份二十来行的扫描器覆盖了 90% 的写法，剩下 10% 用户自己手写一行 `import.meta.hot.accept` 也并不困难。

## 六、最小演示：手写 payload 往返 + AST 注入

下面两段演示脱离 Nuxt 完全能跑，演透上面两套机制。

### 演示一：payload 往返

```ts
// 模拟 Nuxt payload 的 reducer/reviver + pinia state 往返
const SKIP = Symbol('skipHydrate')

function skipHydrate<T>(obj: T): T {
  if (obj && typeof obj === 'object') {
    Object.defineProperty(obj, SKIP, {})
  }
  return obj
}

function shouldHydrate(obj: unknown): boolean {
  return !(obj && typeof obj === 'object' && Object.hasOwn(obj as object, SKIP))
}

// 服务端：建一份集中 state，给 router 字段打上「不要序列化」标记
const serverState = {
  counter: { count: 1, router: skipHydrate({ path: '/secret' }) },
}

// 渲染完成后，整份 state 拷进 payload（对应 plugin.ts 的 app:rendered 钩子）
const payload = { pinia: serverState }

// reducer：把被标记的对象替换成占位值 1（注意必须返回 truthy）
function reduce(data: unknown): unknown {
  if (data && typeof data === 'object' && !shouldHydrate(data)) return 1
  if (Array.isArray(data)) return data.map(reduce)
  if (data && typeof data === 'object') {
    return Object.fromEntries(
      Object.entries(data as Record<string, unknown>).map(([k, v]) => [k, reduce(v)])
    )
  }
  return data
}

const serialized = JSON.stringify(reduce(payload))
console.log(serialized)
// {"pinia":{"counter":{"count":1,"router":1}}}
//                                              ↑ 占位

// reviver：把占位 1 还原成 undefined
function revive(data: unknown): unknown {
  if (data === 1) return undefined
  if (Array.isArray(data)) return data.map(revive)
  if (data && typeof data === 'object') {
    return Object.fromEntries(
      Object.entries(data as Record<string, unknown>).map(([k, v]) => [k, revive(v)])
    )
  }
  return data
}

// 客户端：建空 state，把 payload 灌回（对应客户端 plugin 的 setup）
const revived = revive(JSON.parse(serialized)) as any
const clientState: any = {}
clientState.pinia = revived.pinia

console.log(clientState.pinia.counter.count)   // 1   ← state 安全抵达客户端
console.log(clientState.pinia.counter.router)  // undefined  ← 标记字段被剔除
```

跑一下输出：`count` 安全过网，`router` 在客户端被还原成 `undefined`，store 内部代码会用一个客户端新建的 router 实例顶上。

### 演示二：AST 扫描 + 首尾各贴一段

```ts
// 用 acorn 解析源码，识别顶层 `const useX = defineStore(...)`，
// 然后前贴 import、后贴 if 块、原文件居中——跟 auto-hmr-plugin 行为一致
import { parse } from 'acorn'

const source = `
import { ref } from 'vue'
export const useCounter = defineStore('counter', () => {
  const count = ref(0)
  return { count }
})
`

const ast: any = parse(source, { ecmaVersion: 'latest', sourceType: 'module' })

let storeName: string | undefined
for (const node of ast.body) {
  if (node.type !== 'VariableDeclaration' && node.type !== 'ExportNamedDeclaration') continue
  const decls = node.type === 'VariableDeclaration'
    ? node.declarations
    : node.declaration?.type === 'VariableDeclaration'
      ? node.declaration.declarations
      : []
  const hit = decls.find((d: any) =>
    d.init?.type === 'CallExpression' &&
    d.init.callee.type === 'Identifier' &&
    d.init.callee.name === 'defineStore'   // ← 写死比较字符串
  )
  if (hit?.id.type === 'Identifier') {
    storeName = hit.id.name
    break
  }
}

if (storeName) {
  const injected = [
    `import { acceptHMRUpdate } from 'pinia'`,
    source,
    'if (import.meta.hot) {',
    `  import.meta.hot.accept(acceptHMRUpdate(${storeName}, import.meta.hot))`,
    '}',
  ].join('\n')
  console.log(injected)
}
```

把 `source` 换成 `export default defineStore(...)` 试试——`storeName` 会是 `undefined`，什么都不会注入。换成 `import { defineStore as ds }` 然后调 `ds(...)`，同样不识别。这两个边界都是演示里 `d.init.callee.name === 'defineStore'` 这行直接决定的。

## 七、关键权衡

这一章的机制比较丰富，下面四条都值得讲透。

### 权衡一：复用 Nuxt payload 通道运输 state

**选择**：不自己造一套「序列化 store state 到 HTML」的机制，直接把 `pinia.state.value` 整体拷进 `nuxtApp.payload.pinia`，让 Nuxt 的 payload 系统负责序列化、注入 HTML、客户端反序列化。

**换来**：零自研序列化代码；payload 自动随请求往返，无需关心「怎么把数据塞进 HTML 又怎么取出来」；和 Nuxt 其他生态（数据预取、`useFetch` 缓存等）走同一条运输管道，序列化行为统一。

**代价**：必须遵守 Nuxt 的类型化序列化协议——`payload-plugin` 里那一对 reducer/reviver 就是给这个协议打工；受 payload 大小限制（一个 SSR 响应能塞多少数据有上限）；想剔除字段只能「半绕过」——`skipHydrate` 把对象替换成占位 `1`、客户端还原成 `undefined`，字段名还在 payload 里、只是值没了。如果想真删除字段，得在更高层动 schema，不在 reducer 这一层能办。

### 权衡二：拆成「主 plugin + payload plugin」两个文件，且都在 `modules:done` 才挂载

**选择**：runtime 不写成一个插件，而是拆成 `plugin.ts`（建 pinia、装到 vueApp、provide、`app:rendered` 钩子）和 `payload-plugin.ts`（注册 reducer/reviver）两个文件，且都在 `modules:done` 钩子里才 `addPlugin`。

**换来**：让路由等核心模块先于 pinia 插件就绪（早期 Nuxt 版本里 pinia 装太早会拿到没装 router 的 vueApp）；让序列化钩子在 Nuxt payload 系统的合适时序注册；两个文件关注点清晰分离，runtime 路径与类型生成路径解耦。

**代价**：文件分散，初次读源码的人需要找两处；插件挂载顺序成了「需要维护的约定」——以后改这一段必须记得两个都要在 `modules:done` 内、且顺序不能反。

### 权衡三：渲染完成后立刻清空全局 active pinia

**选择**：`app:rendered` 钩子末尾调 `setActivePinia(undefined)`。

**换来**：避免全局单例跨请求污染——同一个 Node 进程连续处理多个请求时，第二个请求不会被前一个请求残留的 active pinia 影响。这是 SSR 场景下的「内存安全保险」。

**代价**：渲染完成后再调用任何依赖「当前活动 pinia」的代码会失效。比如某个 server-only 的派生任务在 `app:rendered` 之后才跑、又通过组件外 `useStore()` 取 store，会取不到——这是「Pinia 实例」章全局单例代价的显性化。换句话说，**单例换便利的代价在请求边界处必须用显式清理来兑现**。

### 权衡四：AST 扫描 + 文本拼接自动注入 HMR 接受代码

**选择**：dev 模式注册一个 Vite 插件，对每个项目内的模块用 `this.parse` 拿 AST，扫顶层 `VariableDeclaration` / `ExportNamedDeclaration` 里 `callee.name === 'defineStore'` 的调用，拿到 store 名字后**前贴一行 import、原文件居中、后贴一段 if 块**——文本拼接产出新代码，不重写 AST、不包裹原代码。

**换来**：用户写 store 时零样板，一行 `import.meta.hot.accept(...)` 都不用手写；最小侵入降低出错概率；只对真正含 `defineStore` 的文件做事，其他文件零成本跳过。

**代价**：仅识别**顶层声明形式**的 store 定义——`const useX = defineStore(...)` 与 `export const useX = defineStore(...)`，其他形式（默认导出、表达式语句、嵌套声明）不会自动注入；扫描范围限定在 `rootDir` 以下，`node_modules`、Nuxt 内部文件、以 `\x00` 开头的 virtual module 全部排除；`callee.name` 写死比较的是字符串 `'defineStore'`，所以**别名 import（如 `import { defineStore as ds }` 后用 `ds(...)`）也不会被识别**——这是用户重命名 import 时最容易踩的坑。

## 小结

`@pinia/nuxt` 之所以能让前面那四件事零配置发生，不是因为做了很多，而是因为**做对了几次「搭便车」的选择**：state 搭 payload 的车、自动导入搭 Nuxt kit 的车、HMR 搭 Vite 插件的车、skipHydrate 搭 Nuxt 类型化序列化协议的车。每一次搭便车都换来一份「不用自己维护」的轻松，代价则是要尊重每辆车的发车时刻表与装载规则。这章的四条权衡本质上都在说同一件事：**集成层的智慧不在「写了多少代码」，而在「忍住不写多少代码」**。
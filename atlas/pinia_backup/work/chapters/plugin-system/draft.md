# 插件系统：扩展每一个 store

## 当你的 store 需要的远不止状态

想象你在写一个中型后台。某天产品说要给所有 store 加操作日志，第二天说要加权限校验，第三天说要接 Vue DevTools。你要是每次都打开每个 `useXxxStore` 文件、手动塞一段相同逻辑进去，那这三个需求做完整个人都不好了。

更糟的是，Pinia 的 store 是 reactive 对象，不是 class——你想「继承一下父 store 加点东西」这条路根本走不通；如果把所有功能都塞进 Pinia 本体，包体会爆炸，还做不到 tree-shake。

插件系统就是为这种场景生的：你写一次函数，告诉 Pinia「以后你每创建一个 store，都按这个函数给它加点东西」。一次注册，终身生效。

## 插件长什么样：一个会被回调的函数

先看一个最小插件，它给所有 store 加一个 `$log` 方法：

```ts
const loggingPlugin = ({ store }) => {
  store.$log = (...args) => console.log(`[${store.$id}]`, ...args)
}
```

它就是一个普通函数。Pinia 在创建每个 store 时，会把这个函数叫起来，传给它一个 context——里面有 `store` 本身、当前 `app`、`pinia` 实例、还有这个 store 的 `options`。你可以在函数里直接改 store（像上面这样），但更常见的写法是「返回一个对象，让 Pinia 帮你焊上去」：

```ts
const counterPlugin = () => ({
  $count: ref(0),
  $bump() { /* ... */ },
})
```

返回的对象会被 Pinia 用 `Object.assign` 的语义塞到 store 上。说人话就是：插件 = 一张「装修清单」，Pinia 是装修工人，你只管写清单，工人负责把每件家具摆到 store 里。这一刻，**核心思想**点透了一次：把扩展点设计成「构造每个 store 时回调一次、把返回的属性焊到 store 上」，整个机制后面所有花样都长在这一点上。

## 注册的两阶段：一条队列为「时机不对」兜底

你写完一个插件，怎么交给 Pinia？用 `pinia.use(plugin)`。但这里有个微妙问题：用户既可能在 `app.use(pinia)` 之前调 `use`，也可能在之后调。两种时机怎么处理？

Pinia 的做法是分两阶段：

```
注册阶段：
  pinia.use(plugin)
    └─ pinia 还没被 install（_a 没设） → 推进 toBeInstalled 队列
    └─ 已经 install                       → 直接 push 进 _p 数组

install 阶段（app.use(pinia) 触发）：
  └─ 把 toBeInstalled 队列里所有插件一次性灌进 _p，清空队列
```

为什么要绕这一道？想象你写一个插件包，用法是 `pinia.use(myPlugin); app.use(pinia);`——插件先注册，但 pinia 还没接进 app。如果没有这条待装队列，你的 `use` 调用就找不到归宿（因为 `_p` 的填充时机依赖 install 完成），用户只能改顺序、甚至被迫先 `app.use` 再 `use`。

有了这条队列，**用户在哪儿调 `use` 都不会漏**：之前的进队列等 install、之后的直接进表。没有「太晚注册就漏」的坑。这层逻辑顺便也让 Pinia 自己能用同样的方式挂 devtools 插件——`createPinia()` 末尾就调 `pinia.use(devtoolsPlugin)`，那时 `_a` 还没设，自然走 `toBeInstalled`，等用户 `app.use(pinia)` 时一起 flush。

## 调用时机：在 store 自己的 effect scope 里

注册完了，插件什么时候被叫起来？答案是「每个 store 构建到尾声时」。

具体来说，当某个 `useStore()` 第一次触发 store 创建，Pinia 会跑完一长串构建步骤（这些步骤在前两章已经讲过）：把 setup() 返回值分类成 state/getter/action、做 reactive 包装、定义 `$state` 的 getter/setter……等这些干完，才轮到插件上场：

```
createSetupStore 末尾：
  for (插件 in pinia._p) {
    const extensions = scope.run(() => 插件({ store, app, pinia, options }))
    assign(store, extensions)
  }
```

注意那个 `scope.run`。这里的 `scope` 不是别的，正是这个 store 自己的 `effectScope`——store 一出生就有的那个范围（前面讲 effect scope 的章节已经铺垫过）。

为什么要在 store 自己的 scope 里跑插件？因为插件返回的东西常常是 `ref` 或 `computed`。Vue 的 effect scope 有个特性：scope 一旦 `stop()`，里面所有的 ref/computed/effect 都会一起被回收。store 调 `$dispose()` 时本质就是 `scope.stop()`——这意味着**插件返回的 ref 会跟着 store 一起死**，插件作者完全不用自己管生命周期。这一步是整章最关键的设计，后面专门展开。

## 返回值怎么落到 store 上：assign 与体检

每个插件返回的对象会被 `Object.assign` 进 store。这意味着两件事：

1. **同名属性，后注册的覆盖前注册的。** 注册顺序 = 数组下标顺序 = 覆盖优先级。`@pinia/testing` 桩化 action 就是直接 `_p.push(...)` 把 stub 插件推到末尾，确保它能覆盖前面所有插件返回的 action。
2. **返回值的「形状」会被体检。** 如果你返回了一个普通对象（既不是 ref、也不是 reactive、又没标 `markRaw`），Pinia 在开发模式会甩一个警告——告诉你「这玩意儿 `storeToRefs` 会忽略它，你要么包成 ref/reactive，要么显式 `markRaw` 说『我知道它不是状态』」。

这个体检不是为了找茬，是为了防错。Pinia 的约定是「状态用 ref、计算用 computed、普通工具对象就 markRaw」。三者混用最容易踩的坑就是「明明想让它响应式，结果忘包 ref」——体检专门逮这种。换句话说，Pinia 在用开发期警告施压，让你把插件返回值分类清楚。

## 关键权衡：本章的核心

本章机制集中，我们围绕「插件到底该长什么样」展开 4 条权衡，第一条最重要。

### 权衡一：在 store 自身 scope 内运行插件 ⭐

**做了**：把 `plugin({ store, ... })` 这个调用包在 `scope.run(() => ...)` 里，scope 是 store 自己的 effectScope。

**换来了**：插件返回的 ref/computed 自动落到 store 的 scope 里，`store.$dispose()` 一调它们就跟着失效。插件作者完全不用写 `onScopeDispose`、不用记着清理 ref——Pinia 帮你管了。这是「写一次插件、不用操心生命周期」体验的根本来源。

**代价是**：插件如果想返回「不是状态、不是响应式」的普通对象（比如一个工具类实例、一个 axios 拦截器、一个 Map 缓存），会触发警告，必须手动 `markRaw`。这其实是 Pinia 在按约定施压：「你返回的东西要么是状态、要么明确告诉我『不是状态』」。如果你忘了 markRaw，开发期会一直被警告骚扰，直到你标清楚。初学者第一次写插件常常被这警告搞懵——这是免费生命周期的代价。

### 权衡二：插件用 `(context) => extensions` 形态，而不是「就地改 store」

**做了**：插件签名是 `(context) => extensions`，你返回什么、Pinia 就 assign 什么。

**换来了**：插件无副作用地声明「我要加什么属性」，可读性、可测试性都好——你单测一个插件只要给它喂个 fake context、看返回值即可，不用真造一个 store。

**代价是**：执行顺序敏感。两个插件返回同名 key，后注册的胜出，没有合并逻辑。测试桩正是利用这一点把 action 覆盖掉，但这也意味着**用户必须自己排顺序**——要是生产插件也撞 key，没人会帮你合并。

### 权衡三：两阶段注册队列

**做了**：`use` 时如果还没 install，先进 `toBeInstalled`；install 时统一 flush 进真正的 `_p`。

**换来了**：「无论用户在 `app.use` 之前还是之后调 `use(plugin)`，所有 store 创建时都能均匀命中」。语义统一，文档好写，用户不用记顺序。

**代价是**：多一条队列、多一次 flush。但这件事的成本极低（一个数组 + 一次 forEach），换来的是体验提升，非常划算。

### 权衡四：插件接收「增强过的 options」

**做了**：调用插件时传的 `options` 不是用户原始选项，而是补过 `actions: {}` 兜底的版本——保证插件能拿到完整 action 列表。

**换来了**：插件能按需遍历 action 名。`@pinia/testing` 就是靠这个逐个把 action 桩化，devtools 也是靠这个列出 action。

**代价是**：用户原始 options 的形状不能直接喂给插件，必须在中间加一道「augment」——多了一层不透明。但插件拿到的是「整齐、可用」的版本，这层抽象值得。

## 把它跑起来：一个 ~50 行的 mini pinia 插件骨架

下面这段代码不依赖 Vue 的渲染，可以直接 `node`/`bun` 跑。它演示两件事：(a) 双阶段注册——`use` 在 install 之前/之后都不漏；(b) 在 store 自己的 scope 内调用插件，使返回的 ref 跟着 store 一起销毁。

```ts
// mini-pinia-plugin.ts
// 一个 fake effectScope：track 登记 stop 钩子、stop 时统一触发
class FakeScope {
  private cleanups: Array<() => void> = []
  run<T>(fn: () => T): T { return fn() }
  track(cleanup: () => void) { this.cleanups.push(cleanup) }
  stop() {
    this.cleanups.forEach(fn => fn())
    this.cleanups = []
  }
}

// 模拟 ref：有 value 字段、被 scope 销毁时 _alive 变 false
function miniRef<T>(initial: T) {
  return { value: initial, _alive: true }
}

// mini pinia：_p 是真正的插件表、_toBeInstalled 是待装队列
function createMiniPinia() {
  let installed = false
  const _p: Array<(ctx: any) => any> = []
  const _toBeInstalled: Array<(ctx: any) => any> = []

  return {
    use(plugin: any) {
      if (!installed) _toBeInstalled.push(plugin)
      else _p.push(plugin)
      return this
    },
    install() {
      installed = true
      _toBeInstalled.forEach(p => _p.push(p))
      _toBeInstalled.length = 0
    },
    _p,
  }
}

// mini createStore：在 store 自己的 scope 里跑插件、把返回值 assign 进 store
function createMiniStore(pinia: any, id: string, setup: () => Record<string, any>) {
  const scope = new FakeScope()
  const store: any = { $id: id, $dispose: () => scope.stop() }

  // 1. 跑 setup，把返回值塞进 store（这里简化了分类逻辑）
  Object.assign(store, setup())

  // 2. 遍历插件表，在 store 自己的 scope 内调用、把返回值 assign 进 store
  pinia._p.forEach((plugin: any) => {
    const extensions = scope.run(() =>
      plugin({ store, pinia, options: { actions: {} } })
    )
    for (const key in extensions ?? {}) {
      const v = extensions[key]
      // 关键：插件返回的 ref 自动登记到 scope，stop 时一起失效
      if (v && typeof v === 'object' && '_alive' in v) {
        scope.track(() => { v._alive = false })
      }
    }
    Object.assign(store, extensions ?? {})
  })

  return store
}

// ===== 演示 =====
const pinia = createMiniPinia()

// 两个插件：一个返回普通方法（不需要 scope 管理），一个返回 ref（要被管理）
const loggingPlugin = ({ store }: any) => ({
  $log: (...args: any[]) => console.log(`[${store.$id}]`, ...args),
})
const counterPlugin = () => ({ $count: miniRef(0) })

// 关键演示点 1：install 之前注册——走 toBeInstalled 队列
pinia.use(loggingPlugin)
pinia.use(counterPlugin)

// 现在 install，触发 flush
pinia.install()
console.log('插件数:', pinia._p.length)   // → 2，两阶段合并后插件都进了正表

const store = createMiniStore(pinia, 'user', () => ({ name: 'Ada' }))
store.$log('hello')                          // → [user] hello
console.log('count alive?', store.$count._alive)  // → true

// 关键演示点 2：销毁 store——插件返回的 ref 应该跟着失效
store.$dispose()
console.log('count alive after dispose?', store.$count._alive)  // → false
```

跑完你会看到两个关键现象都按预期发生：插件不管在 install 前/后注册，最终都进了 `_p`；插件返回的 `$log` 方法和 `$count` ref 都被焊到了 store 上；调 `$dispose()` 之后，插件返回的 ref 跟着失效了——这就是「在 store 自身 scope 里跑插件」的直接结果。

执行轨迹回放：

```
注册：use(loggingPlugin)    → toBeInstalled = [loggingPlugin]
注册：use(counterPlugin)    → toBeInstalled = [loggingPlugin, counterPlugin]
install()：                  → _p = [loggingPlugin, counterPlugin]
                              → toBeInstalled = []
createMiniStore('user')：    → 跑 setup，store 有了 name
                              → scope.run(loggingPlugin) → 返回 {$log} → 焊到 store
                              → scope.run(counterPlugin) → 返回 {$count}
                                → 检测到 ref，scope.track 登记它的 cleanup → 焊到 store
store.$dispose()：           → scope.stop() → 所有登记的 cleanup 触发 → $count._alive = false
```

## 小结

Pinia 的插件系统讲到底就三件事：

1. **插件是一个函数**，签名为 `(context) => extensions`，返回值会被 assign 到 store。
2. **注册两阶段**——`toBeInstalled` 队列 + `_p` 正表，让用户在哪儿调 `use` 都不漏。
3. **调用在 store 自己的 scope 内**——插件返回的 ref/computed 自动随 store 销毁，作者不用管生命周期。

围绕这三件事，Pinia 做了四个关键选择：scope 内运行换来免费生命周期（代价是普通对象要 markRaw）、声明式返回换来可测试性（代价是顺序敏感）、两阶段注册换来时机自由（代价是多一条队列）、增强 options 换来插件能拿到 actions（代价是中间多一道 augment）。这四条合起来，就是「写一次、所有 store 都生效」背后的全部原理。

下一章讲 Vue DevTools 集成时，你会看到 DevTools 自己就是这套插件机制的最大消费者——它正是一个被 `pinia.use(devtoolsPlugin)` 注册进来的插件，享受了这里全部的便利。
# HMR：保留状态下的 store 热更新

## 一个你一定踩过的坑

想象这个场景：你正在调一个登录流程，`useUserStore` 里写了一个 `login` action，刚刚点登录、token 写进 state、跳到首页——一切正常。然后你发现 `login` 里少打了一行日志，顺手加回去保存。

Vite 默认走整页刷新。`pinia.state.value.user` 整个被重置，token 没了，路由因为没了登录态又把你踢回登录页。你重新登录、再调一次、再回到首页——就为了加那一行 `console.log`。

更阴险的是另一种情况：Vite 没刷页，但你的组件已经 `import` 了旧的 `useUserStore`，组件拿到的还是旧版 `login`，那一行日志永远打不出来。你得手动刷一次浏览器——又丢了状态。

Pinia 的 HMR 就是为消灭这两种痛点而生的。说人话就是：**你改你的代码，登录态、表单、订阅回调我帮你留住**。

## 为什么不能简单「重建 store」

要做热更新，最朴素的思路是：拿到新代码，重新 `defineStore` 一遍，把 `pinia._s` 里那个老 store 替换掉。但这套思路在 Pinia 里行不通，根本原因在于 **store 是一个被无数组件持有的 reactive 代理对象**。

- 组件 A 在 `setup` 里写过 `const userStore = useUserStore()`——这个引用指向老对象。
- 模板里有 `<div>{{ userStore.token }}</div>`——依赖追踪挂在老对象上。
- 某处写了 `userStore.$subscribe(cb)`——cb 注册在老对象的订阅列表里。
- devtools 监听着老对象上的 mutation 事件——可视化靠的就是这个。

如果你"重建 store"，老对象还活着、还被人指着，但注册表里已经不认它了。新对象是新的内存地址，所有指向老对象的引用都成了孤儿——它们读的是旧字段、订阅的是旧事件、新代码改动根本影响不到它们。这是最难调的 bug：「看起来还能用，但行为反常」。

## 思路：影子 store + 器官捐献

既然不能换"壳"，那就只换"零件"。Pinia 的方案可以类比为器官捐献：

1. 用新代码造一个**完全独立的影子 store**——给它一个临时 id `'__hot:user'`，跑一遍正常的 setup 流水线，把新代码的状态、getter、action 全部解析出来，挂在一个叫 `_hmrPayload` 的"零件清单"上。
2. 调用老 store 的 `_hotUpdate(shadow)`——把零件逐个移植到老对象上：actions 赋新函数、getters 重新 computed、state 按规则搬运、删掉被移除的字段。
3. 影子 store 完成使命，从注册表里删掉。

老对象的内存地址从头到尾没变。组件持有的引用、模板的依赖追踪、订阅回调——全部不动。它们看到的是"这个对象长出了新方法、改了 getter 算法、但状态还在"。

## 完整流程：从 Vite 推送到旧 store 复活

Pinia 本身不监听文件变化——HMR 的触发权在用户代码里。开发者必须显式写：

```ts
import { acceptHMRUpdate } from 'pinia'
import.meta.hot.accept(acceptHMRUpdate(useUserStore, import.meta.hot))
```

`acceptHMRUpdate(useStore, hot)` 返回一个回调，Vite 在每次热更新这个模块时调用它。这个回调做的事，可以拆成 7 步：

```
Vite 检测到 store 文件改动
        │
        ▼
[1] 触发 import.meta.hot.accept 回调
        │
        ▼
[2] 遍历新模块的所有命名导出
    用「是函数 + 有 $id 字符串字段」识别哪些是 store 定义
        │
        ▼
[3] 从 hot.data 拿上次缓存的 pinia 实例（首次从 useStore._pinia 兜底）
        │  拿不到？说明这个 store 从来没被用过 → 直接 return
        ▼
[4] 调 useStore(pinia, existingStore)
    把老 store 作为第二个参数 hot 传进去——这是进入 HMR 模式的暗号
        │
        ▼
[5] useStore 见到 hot 入参 → 进入 HMR 模式
    用 '__hot:' + id 作为临时 id 跑一遍 createSetupStore
    得到一个影子 store，零件挂在 _hmrPayload 上
        │
        ▼
[6] 调 existingStore._hotUpdate(影子 store)
    逐字段做手术：actions 赋新、getters 重包、state 搬运、删字段
    老 store 这个 reactive 对象的身份始终不变
        │
        ▼
[7] 清理：从 pinia._s 和 pinia.state.value 里删掉 '__hot:' 临时条目
    影子 store 离场，零件已植入老对象
```

有几个细节值得注意：

- **第 2 步的鸭子类型识别**：模块导出可能包含工具函数、类型、常量。识别 store 的唯一标准是 `typeof fn === 'function' && typeof fn.$id === 'string'`——`defineStore` 返回的 `useStore` 函数上挂了字符串 `$id` 字段。这是个非常宽松的判据，但在 Pinia 的生态里够用。
- **第 3 步的 `hot.data`**：Vite 在多次热更新之间持久的对象，专门用来跨次保存上下文。pinia 实例放这里，保证第二次、第三次热更新还能拿到同一个 pinia。
- **第 4 步的 `hot` 参数**：API 复用得非常彻底——`useStore` 的第二个参数本来是给测试和 SSR 用的"指定 store 实例"参数，HMR 直接借过来当暗号。同一个函数，调用方式不同就走不同分支。

## 最小演示：换零件不换壳

下面这段代码不接 Vite、不依赖任何打包器，单文件 `npx tsx demo.ts` 就能跑。它把"换零件不换壳"这个核心思想抽到最简：一个 `makeStore` 工厂、一个 `_hotUpdate` 方法。

```ts
// @ts-nocheck
import { reactive, computed, effect } from 'vue'

// 极简 store：一个 reactive 对象 + _hotUpdate 手术
function makeStore(id, factory) {
  const store = reactive({ $id: id })
  const initial = factory(store)
  for (const k in initial.state) store[k] = initial.state[k]
  for (const k in initial.getters) store[k] = computed(initial.getters[k])
  for (const k in initial.actions) store[k] = initial.actions[k].bind(store)

  store._hotUpdate = function (newFactory) {
    const fresh = newFactory(this)
    // (a) actions / getters：新值覆盖老字段
    //     reactive 代理保证组件侧的引用无需任何改动
    for (const k in fresh.actions) this[k] = fresh.actions[k].bind(this)
    for (const k in fresh.getters) this[k] = computed(fresh.getters[k])
    // (b) state：旧值优先，新增 key 才用新值
    //     这就是「保留登录态」的关键
    for (const k in fresh.state) if (!(k in this)) this[k] = fresh.state[k]
    // (c) 被删除的字段：从老对象上抹掉
    const live = { ...fresh.state, ...fresh.getters, ...fresh.actions }
    for (const k of Object.keys(this)) {
      if (k !== '$id' && k !== '_hotUpdate' && !(k in live)) delete this[k]
    }
  }
  return store
}

// ---- v1：登录 + 计数器，doubled = count * 2 ----
const v1 = (s) => ({
  state: { token: '', count: 0 },
  getters: { doubled: () => s.count * 2 },
  actions: {
    login(t) { this.token = t },
    inc() { this.count++ },
  },
})
const store = makeStore('user', v1)

// 模拟组件订阅：注册一次，之后再也不重新订阅
effect(() => console.log('[组件]', 'count =', store.count, 'doubled =', store.doubled))
store.login('abc')
store.inc()

// ---- v2：HMR 推送——doubled 改成 *3、删 login、加 logout ----
const v2 = (s) => ({
  state: { token: '', count: 0 },
  getters: { doubled: () => s.count * 3 },
  actions: {
    logout() { this.token = '' },
    inc() { this.count++ },
  },
})
store._hotUpdate(v2)

console.log('[验证] token 仍在 / login 已删 / logout 新增:',
  store.token === 'abc', typeof store.login === 'undefined', typeof store.logout === 'function')
store.inc()  // 同一个 effect 还在工作 = 对象身份没变
```

预期输出：

```
[组件] count = 0 doubled = 0
[组件] count = 1 doubled = 2
[组件] count = 1 doubled = 3
[验证] token 仍在 / login 已删 / logout 新增: true true true
[组件] count = 2 doubled = 6
```

第三行 `count = 1 doubled = 3` 是整套机制的灵魂时刻：`count` 还是 `1`（旧值保留），但 `doubled` 已经是新算法（`*3`）了。最后一行 `count = 2 doubled = 6` 是身份保留的活证据——那个 `effect` 是 HMR 之前注册的，它捕获的 `store` 引用还能继续响应字段变化，说明对象身份没换、依赖追踪没断。

演示里故意省略了什么：Vite 的 `import.meta.hot` 接线、option store 与 setup store 的合并分支、`isListening` 关闭、devtools 集成、`'__hot:'` 临时 id——这些都是为了让"换零件不换壳"这个核心思想裸露出来。下面讲权衡时会逐一补回真实机制。

## 五条权衡

下面五条权衡是这套设计真正"咬合"的地方。每一条都是「做了 X 选择 → 换来了 Y → 代价是 Z」的具体交换。

### 权衡 1（核心）：就地属性替换 vs 重建 store 对象

**做了什么**：HMR 时不 `pinia._s.set(id, newStore)` 整体替换，而是在老 store 的 reactive 代理对象上逐字段改：actions 赋新函数、getters 重新 computed、state 按"旧值优先"搬运、删掉被移除的字段。老 store 这个对象本身——它的内存地址、它在 Vue 响应式系统里的代理身份——从头到尾没变。

**换来什么**：组件侧零成本。组件 1 在 `setup` 里 `const store = useUserStore()` 拿到的引用，HMR 之后还是同一个；模板里的 `{{ store.user }}`、`@click="store.logout"`、`watch(() => store.count, ...)`、`store.$subscribe(...)` 全部继续工作。不需要重新挂载、不需要重新 inject、也不需要触发任何"重新建立依赖"的逻辑——只有真正读了被改字段的组件才会因响应式通知而重渲。

**代价**：`_hotUpdate` 必须自己逐字段处理，且必须区分 option store 和 setup store 两种合并语义（详见权衡 3）。整个函数对 Vue 响应式内部细节（`toRef`、`isPlainObject`、`patchObject`）依赖很重，它必须懂"什么是 state、什么是 getter、什么是被删掉的字段"。

**反过来如果不这么做——选重建 store——会发生什么**：

- 组件 A 持有的 `useUserStore()` 引用瞬间变成对老对象的引用，老对象还在内存里活着，但已经不在注册表里——成了孤儿。
- 模板里的 `{{ store.user }}` 读的还是老对象的 user 字段，新代码里改了 user 也不会反映过去——「看起来 store 还在，但行为反常」是最难调的 bug。
- `store.$subscribe(cb)` 注册的 cb 不会再被新 store 触发，但旧 cb 闭包还挂着——内存泄漏 + 静默失效。
- devtools 的时间线会断——它订阅的是老 store，新 store 上的 mutation 它根本看不到。
- `pinia.state.value[id]` 里那个老 ref 被换掉后，所有 `toRef(pinia.state.value[id], 'xxx')` 派生出来的引用全部失效。
- 如果有插件在 store 上注入了属性（router、i18n、persisted state 等），全部要重跑一遍插件初始化——而插件副作用往往不是幂等的。

这就是为什么 Pinia 选了"逐字段改老对象"这条更复杂的路——它把复杂性集中在 `_hotUpdate` 一个函数里，换来了所有下游消费者零感知。其他四条权衡讨论的机制（影子 store、临时 id、isListening 关闭、id 漂移保护……）都是为了支持这一条而存在的配套设施。

### 权衡 2：新建影子 store 复用 setup 管线 vs 直接读新模块导出

**做了什么**：拿到新代码后，不是手写一套"解析新代码、提取 state/getter/action"的 HMR 专用逻辑，而是直接用 `'__hot:' + id` 作为临时 id 调一遍正常的 `createSetupStore`，得到一份完整的影子 store。

**换来什么**：复用全部 setup 管线——state 分类、getter 标记、action 包装的逻辑一行都不用重写。HMR 路径和生产路径共享同一段核心代码，bug 修一处就好。

**代价**：临时往 `pinia._s` 和 `pinia.state.value` 里塞了个 `'__hot:user'` 条目，必须记得在 `_hotUpdate` 之后手动清理。如果清理失败（理论上不会，但万一），注册表里会留下垃圾条目，下一次正常创建 store 时可能命中错误缓存。

### 权衡 3：option store 走 deep merge、setup store 走整值转移

**做了什么**：state 合并分两条路走——option store 对 plain object 子节点用 `patchObject` 做 deep merge；setup store 直接整值转移。注意这里 setup store 的转移方向是 **旧值 → 新结构**：先把老 store 上那份 state 的值整体赋给新结构里对应的槽位（`newStore.$state[stateKey] = oldStateSource`，源码注释里就一句"transfer the ref"），再让老 store 的这个属性重新指向新结构里的同一个槽位（`store[stateKey] = toRef(newStore.$state, stateKey)`）。最终 `store.count` 读到的还是旧值——因为新结构里那个槽位装的就是旧值。

两条路殊途同归：**旧值 wins，新结构保留**。差异只在"如何把新旧两份 state 揉到一起"——option store 因为声明了完整形状，可以按 key 细粒度 deep merge；setup store 因为运行时可能动态新增字段，必须整值转移避免丢字段。

**换来什么**：两种 store 类型各取最合适的合并策略——option store 享受细粒度保留（即使子对象某个嵌套字段被改了也能保留），setup store 享受运行时新增属性的安全性（issue #2611 报的就是这个 bug）。

**代价**：同一份 `_hotUpdate` 内嵌两条分支，理解成本翻倍。读到这段代码的人必须知道"为什么这两种 store 不一样"才能理解逻辑——而这个知识只能通过看注释或踩过坑获得。

### 权衡 4：HMR 期间临时关掉 isListening

**做了什么**：`_hotUpdate` 在搬运 state 之前，把 `isListening` 和 `isSyncListening` 两个全局监听标志关掉，搬运完再恢复（同步立即恢复、异步在 `nextTick` 恢复）。

**换来什么**：state 搬运不会被 `$subscribe` 误报为一次 mutation。如果不关，组件里那些 `store.$subscribe(cb)` 注册的 cb 会以为"用户改了一堆 state"，触发一堆错误的副作用——而实际上这只是 HMR 在搬运。

**代价**：这套 `isListening` 机制和 `$patch` 共用——同一个 flag 承担了两种语义：「批量 patch 时不要逐次通知」和「HMR 搬运时不要误报」。读源码的人看到 `isListening = false` 必须结合上下文判断到底属于哪种情形。同时，HMR 期间新增了一个 `_hotUpdating` 标志位来防止 watcher 事件被错误归集到 patch 的批量事件里——标志位又多了一个。

### 权衡 5：id 漂移强制 hot.invalidate() 整页重载

**做了什么**：`acceptHMRUpdate` 在遍历新模块导出时，会检查每个 store 的 `$id` 是否和初始 `useStore.$id` 一致。不一致，立即调 `hot.invalidate()`——Vite 收到这个信号会放弃 HMR、改走整页刷新。

**换来什么**：store 的身份稳定可追踪。devtools 永远知道 user store 就是 user store；缓存逻辑、订阅、状态序列化都建立在 id 稳定这个前提上。如果允许热更新里偷偷改 id，整个生态的可观测性都会被绕晕。

**代价**：这次编辑彻底失去 HMR 收益——开发者会注意到这是少数会触发整刷的情形。但这其实是合理的：改 `$id` 通常意味着你在做结构性重构（拆分 store、合并 store），这种情况下"保留状态"反而是错的——你正在重新定义状态结构。

## 综合回到那个登录场景

回到开头那个加 `console.log` 的场景。配上 HMR 之后：

1. 你保存文件，Vite 推送新模块。
2. `acceptHMRUpdate` 识别出 `useUserStore`，找到老 store。
3. 用 `'__hot:user'` 跑一遍新 setup，得到影子 store（含新版 `login`、带 `console.log`）。
4. 调 `userStore._hotUpdate(shadow)`：`login` 字段被替换成新版函数，token 和其他 state 原封不动。
5. 影子清理，老 store 复活。

你再点登录按钮——组件里 `userStore.login(...)` 调的是新版 action，`console.log` 打出来了，token 也写进 state 了——但上次的登录态、首页的滚动位置、表单里那半截输入，全都在。这就是 Pinia HMR 想给你的开发体验：**改代码这件事，跟用户态无关**。
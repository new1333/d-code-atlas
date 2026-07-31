# createPinia：effectScope 状态根与插件装载

上一章我们讲了「pinia 实例靠全局活跃指针 + 注入回退两条路径被取用」——`install` 时既 `setActivePinia` 又 `provide`，于是组件内外都能拿到它。但那个被取用的 pinia 实例**内部到底装了什么**？为什么它能在 `dispose` 时一键清掉所有 store 的副作用，又能把全部状态序列化成一份可传输的快照？这一章把它拆开。

## 这章要解决的问题

一个应用里有几十个 store，每个都带着自己的响应式 state、一堆 computed、若干 watcher 和订阅。这些副作用如果散落在各自组件的作用域里会出三件麻烦事：

- 组件一卸载，挂在它作用域里的副作用就没了，但 store 应该比组件活得更久；
- 跑完测试或多实例场景后，无法把「所有 store 的副作用」一次性收干净；
- 服务端渲染时，无法把「所有 store 的状态」打包成一份传给客户端。

**一句话核心思想**：把「所有 store 的副作用」和「所有 store 的状态」收口到同一个可手动启停的容器里——副作用统一挂在一个可停止的作用域根之下，状态统一收进一张按 store 编号寻址的扁平字典。

## 底层原语

拆开这个容器前，先认两个底层原语。它们都来自 Vue 本身，pinia 只是把它们拼成了「状态根」。

**原语一：effectScope 是副作用收集器。** Vue 把「在一次同步执行中产生的所有响应式副作用（computed、watch、watchEffect）」收集进一个作用域对象。这个对象有一个 `stop()`，调用它就一次性把这些副作用全部销毁——它们不再随依赖变化重新求值。所以「一个作用域」=「一组可被整批回收的副作用」。

**detached 语义。** `effectScope(true)` 里的 `true` 表示「脱离」：新建的这颗作用域不会被自动登记进调用时正活跃的那个作用域，因而**不会随父作用域一起被销毁，生命周期完全由拿到它的代码自己掌控**。这正是「根」需要的属性——它不能依附于任何一个组件，否则组件卸载就把整个状态树连根拔起。

**原语二：扁平字典是状态总账。** 一张响应式的 `Record<string, StateTree>`，key 是 storeId，value 是该 store 的状态树。每个 store 的状态最终都「搬」进这张表对应的 key 下，它就是全局唯一的真源（single source of truth）。

## 心智模型

把这两个原语拼成一个根对象，运行时走 6 步：

1. 建一个可手动停止的、脱离组件生命周期的**独立作用域**，当副作用根。
2. 在这个根里放一张**空的响应式字典**，用 store 编号当 key。
3. 让这个根对象同时扮演 **Vue 插件**：被应用装载时把自己挂上去，并（接上一章）暴露给「组件内注入 / 组件外指针」两条取用路径。
4. 注册插件时**先暂存**；等应用装载后，再把暂存的一并并入正式队列。
5. 每个 store 首次创建时：把自己的副作用挂到根作用域的一个**子作用域**下、把自己的状态写进字典对应槽位。
6. 销毁时**停止根作用域**，连带回收所有 store 的副作用，并清空字典与注册表。

文字版流程图：

```
app.use(pinia)
  → install：建指针 + 挂注入 +（暂存插件并入正式队列）
useStore() 首次
  → 在根作用域 _e 下开子作用域跑 setup     （副作用借此登记进根）
  → 把状态写进 state.value[storeId]        （扁平字典，单一真源）
  → 按 _p 顺序跑插件，返回对象混入 store
  → _s.set(id, store)                       （登记进注册表）
disposePinia(pinia)
  → _e.stop()                               （级联回收全部 store 副作用）
  → state.value = {} / _s.clear()           （字典与注册表清空）
```

## 关键权衡（本章核心）

这 6 步背后有 4 个值得专门拎出来的「做了 X 选择 → 换来 Y → 代价是 Z」权衡。它们才是这章真正要讲的东西。

### 权衡 1：扁平字典，而非按 store 嵌套

**做了**：选择一张扁平字典、用 store 编号当 key，统一存放全部状态。
**换来**：服务端只需序列化**这一个字典对象**就能得到完整快照；状态变更接口（`$patch`）也能用统一的 `state.value[当前 storeId]` 一处寻址，不必为每个 store 写一套合并逻辑。
**代价是**：在 setup 形态的 store 里，用户自己 `new` 出来的状态引用（那些 `ref`/`reactive`）必须被「**搬**」进字典对应槽位，才能维持「字典是唯一真源」这个承诺；否则用户手里的引用和字典里的值会各活各的。option 形态没这个麻烦——状态工厂的返回值直接写进字典即可，引用天生只有一份。这条代价直接决定了「装配机器」一章里为什么要做 ref 迁移：迁，是为了让「扁平字典 = 单一真源」这条承诺在两种 store 形态下都成立。

### 权衡 2：独立 detached 作用域当副作用根

**做了**：选一个脱离任何组件生命周期的「独立作用域」当根，每个 store 的副作用都挂在它的**子作用域**下（子作用域本身不 detached，于是被父作用域记录）。
**换来**：「停止根作用域 = 一键回收全部 store 副作用」——只要 `_e.stop()` 一声令下，挂在根下的所有子作用域里的 computed/watch 全部失活；而且 store 的副作用不会因为某个组件卸载而消失，store 比组件长寿。
**代价是**：这个根作用域**不会自动被垃圾回收**，必须由代码显式销毁（`disposePinia`，或随 app 卸载）。用在不该用的场景——比如频繁创建却不销毁——就会泄漏。这正是 `disposePinia` 存在的全部理由：它不是装饰品，是这条代价的对冲。

### 权衡 3：插件延迟入队

**做了**：选择「应用装载前注册的插件先暂存（`toBeInstalled`），等应用装上这个根之后，再统一并入正式队列（`_p`）」。
**换来**：「插件执行顺序与注册时机无关」的**确定性**。每个 store 装配时，插件队列已经完整且有序，装配代码只需 `forEach(_p)` 一遍，不必关心某个插件是装载前还是装载后注册的。
**代价是**：多了一个暂存中间态。装载前注册的插件（包括 pinia 自己在建根末尾登记的 devtools 插件，因为此刻 app 还没挂上）实际生效要**等到应用挂载之后**。换句话说，`pinia.use(...)` 之后到 `app.use(pinia)` 之前，插件并不会对任何已存在的 store 起作用——这段时间本就没有 store，所以代价被巧妙地消化了，但中间态客观存在。

### 权衡 4：容器自身不参与响应式代理

**做了**：选择让根容器对象本身被标记为「不进入响应式系统」（源码里那一处 `markRaw`）。
**换来**：它持有的字典（一个 ref）、注册表（一个 Map）仍按各自原语义工作，互不干扰；且当这个容器被存进任何响应式上下文时，也不会触发额外的一层代理开销。
**代价极小**：容器只是一个普通对象引用，`markRaw` 几乎是零成本。这条权衡是典型的「以极小代价换确定性」——它不解决问题，但避免了「容器被某处响应式化后内部引用语义被破坏」这种隐蔽 bug。

> 这 4 条权衡不是事后总结，而是这颗根对象之所以长成这样的**原因**：扁平字典是为了 SSR 序列化与统一寻址（权衡 1），独立作用域是为了一键回收（权衡 2），两段式队列是为了插件顺序的确定性（权衡 3），`markRaw` 是为了避免代理污染（权衡 4）。读懂这 4 条，就读懂了 `createPinia`。

## 从零的最小原理演示

下面用一个**不依赖 pinia 源码、从零实现**的几十行演示，演透「副作用收口 + 扁平字典 + 插件暂存/并入 + 一键销毁」这四件事。它故意省略了 `markRaw`、devtools、SSR 真实序列化、option/setup 双形态归一、状态变更的深度合并——那些是别的章的事，这里只追求把核心机制演透。

```ts
// ===== ① 极简原语：可停止的副作用收集器（模拟 Vue effectScope 的关键行为）=====
let activeScope: any = null

function effectScope(detached = false) {
  const self = {
    _stopFns: [] as Function[],
    _parent: detached ? null : activeScope,        // detached ⇒ 不挂任何父作用域，生命周期自管
    run(fn: () => any) {
      const prev = activeScope; activeScope = self
      const r = fn(); activeScope = prev
      return r
    },
    stop() { self._stopFns.forEach(f => f()); self._stopFns.length = 0 },
  }
  return self
}
// 把一段副作用的“失活回调”登记进当前作用域及其全部祖先 ⇒ 任意祖先 stop 都能让它失活
function onScope(stopFn: () => void) {
  let s = activeScope
  while (s) { s._stopFns.push(stopFn); s = s._parent } // ← “停根 = 级联回收所有子作用域副作用”的机制依据
}
function ref<T>(v: T) { return { value: v } }           // 极简响应式占位
function watch(src: any, cb: () => void) {              // 极简“依赖状态、变了就触发”的副作用
  let alive = true
  const fire = () => { if (alive) cb() }
  src._fire = fire                                      // state 变更时由 set() 回调它
  onScope(() => { alive = false })                      // 作用域停止 ⇒ 失活
  fire()                                                // 首次同步执行（与 watchEffect 一致）
}
function set(src: any, v: any) { src.value = v; src._fire?.() }
```

```ts
// ===== ② 从零造一个 Pinia 根：副作用根 + 扁平字典 + 插件两段式队列 =====
function createMiniPinia() {
  const root = effectScope(true)                               // ① 独立（detached）副作用根
  const state = root.run(() => ref<Record<string, any>>({}))!  // ② 空响应式扁平字典
  const _p: Function[] = []                                    // 正式插件队列
  const toBeInstalled: Function[] = []                         // 装载前暂存

  return {
    _e: root, state, _s: new Map<string, any>(), _p, _a: null as any,
    install(app: any) {
      this._a = app                                            // 之后 use() 改走正式入队
      toBeInstalled.forEach(p => _p.push(p)); toBeInstalled.length = 0 // ③ 暂存并入正式队列
    },
    use(p: Function) { (this._a ? _p : toBeInstalled).push(p); return this }, // 按是否已装载分流
  }
}

// ===== ③ 迷你 store：副作用挂到根的子作用域、状态写进字典对应槽位 =====
function defineStore(id: string, setup: (pinia: any) => any) {
  return function useStore(pinia: any) {
    if (pinia._s.has(id)) return pinia._s.get(id)              // 单例缓存
    let scope: any
    const built = pinia._e.run(() =>                           // 在根作用域下…
      (scope = effectScope()).run(() => setup(pinia))          // …开一个子作用域跑 setup（副作用借此登记进根）
    )
    pinia.state.value[id] = built._state                       // 状态搬进扁平字典对应槽位（单一真源）
    pinia._p.forEach(p => Object.assign(built, p({ store: built, pinia }))) // 按序跑插件并入
    pinia._s.set(id, built)                                    // 登记进注册表
    return built
  }
}
```

```ts
// ===== ④ 跑一遍：注册 → 装载 → 取用 → 销毁 =====
const pinia: any = createMiniPinia()
// 注册一个插件：此时 _a 为空 ⇒ 进暂存 toBeInstalled
pinia.use(({ store }: any) => ({ whoami: () => 'plugin-mixin' }))

const useCounter = defineStore('counter', (pinia) => {
  const count = ref(0)
  watch(count, () => console.log('[副作用] count 变了 →', count.value)) // 一段依赖状态的副作用
  return { _state: count, inc: () => set(count, count.value + 1) }
})

pinia.install({})                   // 装载：_a 置位，暂存插件并入 _p
const store: any = useCounter(pinia) // 首次取用：开子作用域、副作用登记进根、状态写进字典

console.log('[字典] state =', pinia.state.value)    // { counter: { value: 0 } } ← 全部状态收口到这一张字典
console.log('[插件] store.whoami =', store.whoami()) // 'plugin-mixin' ← 暂存插件已在装配时生效
store.inc()                         // → [副作用] count 变了 → 1

// —— 销毁：停根作用域 ⇒ 级联回收所有 store 副作用；再清字典与注册表 ——
pinia._e.stop()
pinia.state.value = {}
pinia._s.clear()
store.inc()                         // 副作用已失活：不再打印任何东西
console.log('[销毁后] state =', pinia.state.value)  // {} ← 字典已清空
```

预期控制台输出（请对照理解每一步）：

```
[副作用] count 变了 → 0        ← watch 首次同步执行（store 装配时）
[字典] state = { counter: { value: 0 } }
[插件] store.whoami = plugin-mixin
[副作用] count 变了 → 1        ← store.inc() 触发，副作用还活着
[销毁后] state = {}            ← 注意：销毁后的那次 store.inc() 一行都没打
```

最后一点是最关键的演示：销毁前 `inc()` 会触发副作用、销毁后同样的 `inc()` 一行都不打——这就是「停根作用域 = 级联回收所有子作用域副作用」的肉眼可见效果（权衡 2）。而 `state` 始终是按 storeId 寻址的一张扁平表（权衡 1），插件在装配时才按 `_p` 顺序生效（权衡 3）。

## 执行轨迹（输入 → 中间态 → 输出）

把上面演示抽象成一条标准执行轨迹，方便你带着具体状态读源码：

**输入**（按时间顺序）：
1. `createMiniPinia()` 建根，但 `_a` 还是 `null`；
2. `pinia.use(logger)` —— 此时 `_a` 为空，`logger` 进 `toBeInstalled`；
3. `pinia.install(app)` —— 应用装载；
4. 首次 `useCounter(pinia)` —— 触发 store 装配；
5. `pinia._e.stop()` + 清字典清注册表 —— 销毁。

**关键中间态**：

| 时刻 | `_p` | `toBeInstalled` | `state.value` | `_s` | 根作用域 `_e._stopFns` |
|---|---|---|---|---|---|
| `use(logger)` 后 | `[]` | `[logger]` | `{}` | 空 | `[]` |
| `install` 后 | `[logger]` | `[]` | `{}` | 空 | `[]` |
| 装配后 | `[logger]` | `[]` | `{ counter: {value:0} }` | `{counter→store}` | 含 watch 的失活回调 |
| `store.inc()` 后 | 不变 | 不变 | `{ counter: {value:1} }` | 不变 | 不变（watch 仍活着） |

**输出**（销毁后）：
- `_e.stop()` 跑遍 `_e._stopFns` → watch 的 `alive` 置 `false`；
- `state.value = {}` / `_s.clear()` → 字典与注册表清空；
- 再调 `store.inc()` → `set` 改了 `count.value`，但 `fire()` 因 `alive===false` 直接返回，**副作用不再触发**。

## 源码对照（与真实 pinia 的差异）

上面的演示是「机制骨架」，真实 `createPinia` 在它之上补了工程细节。以下 5 处对应关系把演示映射回源码：

1. **`createPinia.ts:11`** —— 真实的副作用根就是 `effectScope(true)`，赋值给内部字段 `_e`；`true` 即演示里的 detached。detached 的语义是这颗根能独立存活的根因。
2. **`createPinia.ts:14-16`** —— 真实的扁平字典是 `scope.run(() => ref<Record<string, StateTree>>({}))`，在根作用域内创建，按 storeId 当 key（演示的 `state`）。
3. **`createPinia.ts:34-45`** —— 真实的两段式队列：`use(plugin)` 按 `!this._a` 分流进 `toBeInstalled` 或 `_p`，`install` 末尾 `toBeInstalled.forEach(p => _p.push(p))` 并入。和演示的 ② 一一对应。
4. **`store.ts:500-502`** —— 真实 store 的副作用挂在根的子作用域下：`pinia._e.run(() => (scope = effectScope()).run(() => setup(...)))`。外层 `_e` 是根、内层新建的作用域不 detached、于是被根记录——这正是演示里 `onScope` 沿祖先链登记、使「停根即停子」成立的真实机制（源码未对此嵌套显式注释，此因果链依据 Vue effectScope 公开行为推断）。
5. **`createPinia.ts:72-79`** —— 真实的一键销毁 `disposePinia`：`pinia._e.stop()` 级联停止所有子作用域副作用，再 `_s.clear()` / `_p.splice(0)` / `state.value = {}` / `_a = null`。注释明示销毁后实例不可复活。

演示**故意没演**、但真实源码有的部分：根容器自身的 `markRaw`（权衡 4，工程上是 `createPinia.ts:22` 的一行）；devtools 插件也在建根末尾经 `use` 登记、同样走暂存；install 里 `setActivePinia` + `provide` + `globalProperties.$pinia` 三件套（上一章已讲）；SSR 时 `state` 不在 install 预填充、hydration 推迟到 store 装配时按 `state.value[id]` 是否已存在判断。这些都不影响核心机制，留待各自章节。

## 小结

回到那句话：pinia 把所有 store 的副作用收口到一个可停止的作用域根、把所有 store 的状态收口到一张扁平字典，再把这两者装进一个同时是 Vue 插件的对象里。这套结构以 4 条权衡为代价，换来了「一键回收全部副作用（权衡 2）」「一份可序列化的状态快照（权衡 1）」「插件顺序与注册时机无关（权衡 3）」。`createPinia` 本身只搭好了这个舞台——store 真正被「造」出来、把副作用和状态挂进这个舞台，是下一章 `defineStore` 与「装配机器」要做的事。
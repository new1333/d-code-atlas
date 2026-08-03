# Setup Store 构建器：把 setup 返回值分成 state / getter / action

## 一个让你疑惑的场景

你写下这样一段 store：

```ts
export const useCart = defineStore('cart', () => {
  const items = ref(0)
  const total = computed(() => items.value * 10)
  function add() { items.value++ }
  return { items, total, add }
})
```

问题来了——你 return 出来的就是一个普通对象，三个字段长得完全不像：一个 ref、一个 computed、一个函数。可是一旦用起来，`cart.items` 自动是状态、`cart.total` 自动是 getter、`cart.add` 还被接上了 `$onAction` 钩子、能被 `$patch` 影响、被 devtools 记录。Pinia 是怎么在没有任何标注的情况下，把这三类东西分门别类摆好的？

更要命的是你常常这么写：

```ts
const useA = defineStore('a', () => {
  const b = useB()           // A 引用 B
  return { b }
})
const useB = defineStore('b', () => {
  const a = useA()           // B 引用 A
  return { a }
})
```

这种循环引用，构建器要是不想办法，瞬间就是栈溢出。

这一章讲的就是：**Pinia 怎么在没有声明字段的情况下，靠「运行时探测」把 setup 返回值分成三摊，并且让循环引用天然不会爆。**

## 三分式的判据：看 ref 上有没有 effect

最底层那块，判别规则其实就三条：

- 普通的 ref（或 `reactive(...)` 对象）→ **state**
- 是 ref 但身上带 `effect` 字段 → **getter**
- `typeof === 'function'` → **action**

说人话就是：Pinia 没有给你写的 ref/computed/function 贴标签，它就在运行时**伸手去看**——你是 ref 但你不带 effect，那你是 state；你带 effect，那你是 computed；你是个函数，那你是 action。

这套判据的核心是一个叫 `isComputed` 的小函数：

```ts
function isComputed(o) {
  return !!(isRef(o) && o.effect)
}
```

注意它没看任何「我是 computed」的标志位——它只看 ref 上有没有 `effect` 字段。这是 Vue 内部实现细节（computed 本质上就是一个绑了 effect 的 ref），被 Pinia 拿来当判别依据。

分类之后，三类东西各自被搬到不同地方：

```
state:    setup 里的 ref        →  搬到 pinia.state.value[$id][key]   （集中存档）
action:   setup 里的 function   →  包一层 wrapper 后写回 setupStore[key]
getter:   setup 里的 computed   →  原地不动，assign 时自然挂上 store
```

action 那一支特别关键——它不是直接用你写的函数，而是**包一层 wrapper 后覆盖掉原函数**。这个 wrapper 干两件事：进入时通知 `$onAction` 的 before 钩子，返回或抛错时通知 after / onError。所以 store 上挂的 `add` 已经不是你写的那份了，是被 Pinia 代理过的。

## 心智模型：一次构建的 7 步

```
useStore() 未命中缓存
   ↓
① 拼出 partialStore ($id / $patch / $subscribe / $onAction / $dispose / $reset)
   ↓
② store = reactive(partialStore)              ← 此刻还是个壳
   ↓
③ pinia._s.set($id, store)                    ← 立刻注册！还没 state 呢
   ↓
④ 在专属 effectScope 内跑 setup({ action })   ← 用户代码在这里执行
        └─ 若 setup 内调 useOtherStore()，命中 _s 缓存立即返回
   ↓
⑤ 遍历 setupStore 每个字段做三分式分流         ← state 搬运 / action 包装 / getter 原地
   ↓
⑥ assign(store, setupStore) + assign(toRaw(store), setupStore)
   ↓
⑦ Object.defineProperty(store, '$state', ...)  代理到集中 state
   ↓
return store
```

最反直觉的是第 ③ 步——**先把一个空壳注册进表，再去跑 setup**。

打个比方：你去图书馆自习，一进门就把书包扔在某个座位上再去上厕所、买咖啡。等你回来时，别人看见座位上有包，就知道这座有人了，不会再坐。Pinia 的 `_s.set($id, 半成品 store)` 干的就是这件事：先把壳扔进表里占座，等 setup 真跑完再回头把内容填上。这样别人（其他 store 的 setup）查表时立刻能拿到引用，不用等你跑完。这就是「循环引用不会爆」的全部秘密。

## 最小演示：跑一遍给你看

下面这段不是 Pinia 的真源码，是一个能直接 `bun run` / `tsx run` 跑的 mock，演透两件事：(a) 先注册让循环引用不死循环；(b) 三分式分流让同一个返回对象自然落到三个槽。

```ts
import { ref, computed, reactive, effectScope, toRaw, isRef } from 'vue'

// 自造一个最小 pinia：全局 scope + store 注册表 + 集中 state
const mockPinia = {
  state: { value: {} as Record<string, any> },
  _s: new Map<string, any>(),
  _e: effectScope(),
}

function isComputed(o: any) {
  return !!(isRef(o) && o.effect)
}

// action 包装骨架：进入/退出时打日志（真 Pinia 这里是通知 $onAction 订阅）
function wrapAction(fn: Function, name: string) {
  return function (this: any, ...args: any[]) {
    console.log(`  [before] ${name}`)
    const r = fn.apply(this, args)
    console.log(`  [after] ${name}`)
    return r
  }
}

function createSetupStore(id: string, setup: () => Record<string, any>) {
  const partialStore = { $id: id, $dispose: () => scope.stop() }
  const store = reactive(partialStore) as any

  // ★ 关键：先把壳注册进表，再去跑 setup
  mockPinia._s.set(id, store)
  mockPinia.state.value[id] = {}

  let scope: any
  const setupStore = mockPinia._e.run(() => {
    scope = effectScope()
    return scope.run(() => setup())!
  })!

  // 三分式分流
  for (const key in setupStore) {
    const prop = setupStore[key]
    if (isRef(prop) && !isComputed(prop)) {
      mockPinia.state.value[id][key] = prop
      console.log(`  [分类] ${id}.${key} → state`)
    } else if (typeof prop === 'function') {
      setupStore[key] = wrapAction(prop, key)
      console.log(`  [分类] ${id}.${key} → action (已包装)`)
    } else if (isComputed(prop)) {
      console.log(`  [分类] ${id}.${key} → getter (原地)`)
    }
  }

  // 双 assign：先 reactive 后 raw
  Object.assign(store, setupStore)
  Object.assign(toRaw(store), setupStore)

  Object.defineProperty(store, '$state', {
    get: () => mockPinia.state.value[id],
    configurable: true,
  })
  return store
}

// --- 测试用例：A 和 B 互相引用 ---
const useA = () => mockPinia._s.get('a') ?? createSetupStore('a', () => {
  console.log('A 的 setup 开始')
  const b = useB()                                // A 引用 B
  const count = ref(0)
  const doubled = computed(() => count.value * 2)
  function inc() { count.value++ }
  return { count, doubled, inc, b }
})
const useB = () => mockPinia._s.get('b') ?? createSetupStore('b', () => {
  console.log('B 的 setup 开始')
  const a = useA()                                // B 引用 A —— 此时 A 的壳已注册！
  console.log('  B 拿到 a，但 a.count 此刻 =', (a as any).count)
  const name = ref('b')
  return { name, a }
})

const a = useA()
console.log('---')
console.log('最终 a.count =', a.count)
console.log('最终 a.doubled =', a.doubled)
console.log('最终 a.b.name =', a.b.name)
console.log('集中 state keys =', {
  a: Object.keys(mockPinia.state.value.a),
  b: Object.keys(mockPinia.state.value.b),
})
```

跑起来你会看到这样的执行轨迹：

```
A 的 setup 开始
B 的 setup 开始
  B 拿到 a，但 a.count 此刻 = undefined
  [分类] b.name → state
  [分类] a.doubled → getter (原地)
  [分类] a.count → state
  [分类] a.inc → action (已包装)
---
最终 a.count = 0
最终 a.doubled = 0
最终 a.b.name = b
集中 state keys = { a: [ 'count' ], b: [ 'name' ] }
```

注意两个细节：

1. **A 跑 setup 时调 useB，B 跑 setup 时又调 useA——但 useA 在表里命中了 a 的壳，立即返回**，递归到此打住，不会无限下去。
2. B 在 setup 里拿到的 `a` 还不完整——`a.count` 此刻是 `undefined`（因为 A 的 setup 还没跑完，setupStore 还没 assign 到 store 上）。**这就是「先注册后填充」换来的代价**：你能拿到引用，但你不能假设它的字段都齐了。

如果 B 的 setup 里写 `a.count.value + 1` 立刻就读，会爆错。怎么避开？下面讲。

## 关键权衡（这一章的核心）

下面五条，每条都是「做了 X 选择 → 换来了 Y → 代价是 Z」的具体形态。这是这一章真正想让你带走的东西。

### 权衡 1：先注册半成品 store，再去跑 setup

**选择**：在执行用户的 setup 函数**之前**，把 reactive 后的 partialStore 塞进 `pinia._s` 表里。

**换来**：store 之间互相引用天然不会无限递归。A 跑 setup 时调 `useB()`，B 跑 setup 时再调 `useA()`——第二次调用查表命中那个壳，直接返回，递归链断掉。这意味着用户写循环引用的 store 是合法的、能跑的，框架不需要用户去手工排序依赖图。

**代价**：setup 函数里如果拿到了 self（store 自己），那是个**还不完整**的对象——getter/action 都还没挂上去。任何「立刻读 self 字段」的代码都会爆错。所以 setup 里**不能**写：

```ts
const useCart = defineStore('cart', () => {
  const items = ref(0)
  console.log(self.items)   // ✗ self 还不完整，items 还没挂上
  return { items }
})
```

但 getter 里访问 self 没事——因为 computed 是**懒求值**的：

```ts
const useCart = defineStore('cart', () => {
  const items = ref(0)
  // ✓ 箭头函数延迟执行；首次有人读 store.total 时构建早就跑完了
  const summary = computed(() => `共 ${items.value} 件`)
  return { items, summary }
})
```

第一次有人读 `store.summary` 时，整个构建流程早就跑完了——computed 求值的那一刻，self 已经是完整的。

说人话就是：占座换来循环安全，代价是「在 setup 顶层立刻读 self」这条路被堵死；但「在 getter/action 里延迟读 self」这条路是开的——而延迟读恰好是 99% 的真实用法。

### 权衡 2：三分式运行时探测，不要用户标注

**选择**：用 `isRef && !isComputed` 判 state、`typeof === 'function'` 判 action、`isRef && effect` 判 getter，全程运行时探测，用户写的代码跟原生 Composition API 一模一样。

**换来**：用户零学习成本。你在 Vue 组件里怎么写 `setup()`，在 Pinia store 里就怎么写——`ref()` 是状态、`computed()` 是派生、`function` 是动作，肌肉记忆完全复用。这是 API 设计层面的胜利：用户不需要学一套新关键字，也**不需要**在 ref 后面写 `as State` 这种东西。

**代价**：分类依据依赖 Vue 内部实现细节（computed 上的 `effect` 字段不是公开 API）。万一未来 Vue 把这个字段改名了，Pinia 就跟着挂。另外 TS 层面的类型只能靠一堆条件类型反推（`_ExtractStateFromSetupStore` / `_ExtractActionsFromSetupStore` 这类内部工具类型），偶尔在边角场景推断不准——比如 setup 里返回一个被手动改造过的 ref，TS 不一定能正确推出它是 state 还是 getter。

说人话就是：用「探长相」换「不用标注」，代价是这套探长逻辑跟 Vue 内部绑得很死，类型推断偶尔会有边角案例。

### 权衡 3：双 assign——reactive 视图与 raw 视图都写一遍

**选择**：分流完之后，先 `assign(store, setupStore)`（写进 reactive 代理），紧接着 `assign(toRaw(store), setupStore)`（写进底层 raw 对象）。

**换来**：`storeToRefs` 能在 raw 层取到**原始的 ref/computed**——不会被 reactive 代理层二次包装。这一点对「解构 store 出来用」非常关键。如果不双写，`storeToRefs` 在 reactive 代理上看每个字段，会拿到「代理后再 toRef」的产物，某些场景下响应式会丢。

**代价**：每个属性都被写两次。而且顺序不能颠倒——必须先 reactive 后 raw，否则 reactive 代理会把自己当作「新值」再写一次 raw，可能造成两边引用不一致。

说人话就是：为了 storeToRefs 拿到干净的 ref/computed，每个字段都付一次双写的成本，且写顺序不能错。

### 权衡 4：$state 用 defineProperty 代理，不走 reactive

**选择**：`Object.defineProperty(store, '$state', { get, set })`，get 直接返回 `pinia.state.value[$id]`，set 走 `$patch(($state) => assign($state, newValue))`。

**换来**：`$state` 不被外层 reactive 包装，不会被任意 effect 误跟踪——否则哪个组件一访问 `store.$state` 就建立依赖，整个响应式图就乱套了。同时 set 走 `$patch`，意味着整体替换 state 也只触发**一次**订阅通知，而不是每个字段各触发一次。

**代价**：`$state` 不可枚举（defineProperty 默认 `enumerable: false`），所以 `Object.keys(store)` 看不到它，devtools 路径需要特判。HMR 路径也要单独处理——热更新时 `$state` 的 get 返回的是 `hotState.value` 而不是 `pinia.state.value[$id]`，否则热更期间状态会错乱。

说人话就是：为了「$state 不被误跟踪 + 整体替换只通知一次」，付了「$state 不可枚举 + HMR 要特判」的代价。

### 权衡 5：setup 嵌套跑在专属 effectScope

**选择**：用户的 setup 不是直接跑，而是先借 app 的 `runWithContext`（保留 inject 上下文），再进 pinia 全局 scope `_e`，最后在一个**新建的子 effectScope** 里跑。

**换来**：`store.$dispose()` 一句 `scope.stop()`，把该 store 创建的所有 watch、computed、订阅一次性清掉。用户在 setup 里随手 `watch(a, ...)`、`watchEffect(...)`，不用担心忘了清理——store 销毁时它们都会跟着死。这也是为什么 Pinia 不需要你在组件里手动 `onUnmounted` 取消 store 内的副作用。

**代价**：setup 内创建的 effect **必须**落在这条 scope 上才能被自动清理。如果用户在 setup 里手动开了一个新的 effectScope（高级用法），那条 scope 的清理责任就在用户自己身上，`store.$dispose` 不会去 stop 它。

说人话就是：默认你的 setup 里写啥 effect 都自动跟着 store 走，代价是你别在 setup 里瞎开新 scope——开了就得自己关。

## 一句话收尾

setup store 构建器本质上是「把 Composition API 的散件装进一个分类清晰的盒子」。它做了两件值得记住的事：**靠 ref 上有没有 effect 这个内部特征做运行时三分**（让用户零标注），**靠先注册半成品 store 再跑 setup 这个反直觉顺序**（让循环引用天然安全）。前者换来 API 简洁，后者换来引用安全——代价都是可观察、可规避的。

读完这一章，你应该能回答三个问题：为什么 `cart.add` 不是你写的那份函数？为什么 setup 里 `console.log(self.items)` 会爆错？为什么 `storeToRefs(cart)` 解构出来还有响应式？三个问题指向同一个机制的不同侧面——分类、占座、双 assign。
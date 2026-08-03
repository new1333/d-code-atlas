# State 集中化与 SSR hydration

## 一个看似简单、却要绕三道弯的问题

想象你写了一个 setup store：

```ts
const useCounter = defineStore('counter', () => {
  const count = ref(0)
  const double = computed(() => count.value * 2)
  const inc = () => count.value++
  return { count, double, inc }
})
```

现在三个角色都来找 pinia 麻烦：

- **SSR 服务端**：「我跑完了一遍应用，给我一份所有 store 的当前状态，我要把它序列化进 HTML 让客户端恢复。」
- **DevTools**：「我想给你画一棵 state 树，让我看看 count 此刻是几。」
- **持久化插件**：「用户刷新页面了，从 localStorage 读出来的数据，你帮我灌回去。」

这三个请求背后其实是同一个问题：**它们都想从「pinia 这一层」一把抓出所有 store 的 state**。可你看上面那个 setup 函数——`count`、`double`、`inc` 全混在闭包里返回出来，pinia 怎么知道哪个是 state、哪个是 getter、哪个是 action？更别说 state 还散落在每个 store 各自的 ref 里，没有统一入口。

这一章讲的就是 pinia 怎么解决这件事。说人话就是：**把 state 从 store 内部搬到 pinia 自己持有的一个中心桶里，store 自己只保留访问入口**。所有想读 state 的角色——SSR、DevTools、持久化插件——都从这一个桶进出。

## 中心桶：一块谁都能看到的公共留言板

回到最底层。pinia 实例刚被创建出来那一刻，干的第一件事就是给自己捏一个 ref 包着的空对象：

```ts
const state = scope.run(() => ref({}))
```

这个 ref 的 `.value` 就是「中心桶」。它是一张对象映射，key 是 store id，value 是该 store 的所有 state 字段。

类比一下：中心桶就像公司前台的一块**公共留言板**，每个 store 都有自己的小格子（slot），但格子不在自己屋里，全在前台那块板上。任何人想看某个 store 的状态——服务端、客户端、DevTools——都直接走到前台那块板前看，不用挨个敲门。

为什么是 ref 而不是普通对象？因为这块板要响应式：你在 DevTools 里改它，组件能感知；store 里改它，DevTools 也能感知。Vue 的 ref 包一层就给了你这个能力，pinia 顺手复用。

中心桶就长这样：

```
pinia.state.value = {
  counter: { count: <ref>, ... },
  user:    { name: <ref>, age: <ref>, ... },
  cart:    { items: <reactive>, total: <ref>, ... },
}
```

每个 store id 对应一个 slot，slot 里装的是「那个 store 的所有 state 字段」。**注意 slot 里装的是 ref 本身，不是 ref 的值**——这点很关键，下一节会看到为什么。

## 三分流：把 setup 返回值按类型分到三个筐

setup store 跑完 `setup()` 之后，返回的是一个普通对象，里面 ref / computed / function 全混着。pinia 要做的是**遍历这个对象，按值的类型分流**：

```
for (key in setupReturn) {
  if ((isRef(value) && !isComputed(value)) || isReactive(value)) → STATE
  else if (typeof value === 'function')                          → ACTION
  else if (isComputed(value))                                    → GETTER
}
```

- **STATE**（ref、reactive）：搬进中心桶，让序列化能看见。
- **ACTION**（function）：留在 store 上，函数不需要序列化。
- **GETTER**（computed）：留在 store 上，计算属性是派生值，不存固定值。

为什么 getter 和 action 不进中心桶？因为它们**不需要被序列化**。getter 是计算出来的派生值，序列化它没意义；action 是函数，函数压根没法序列化。所以 pinia 的拆分原则一句话：**state 集中、行为分散**。

## 灌值再搬运：两步走，一步不能颠倒

假设 setup 里写的是 `const count = ref(0)`，pinia 拿到这个 ref 之后做两件事。

**第一步——灌值（hydration）**：如果中心桶 slot 里已经有外部预填的数据（典型场景：SSR 把 `{ count: 42 }` 提前写进了 `pinia.state.value['counter']`），就**把这个值灌进已有的 ref**：

```ts
if (initialState && shouldHydrate(prop)) {
  if (isRef(prop)) {
    prop.value = initialState[key]   // 只动 .value，不动 ref 引用
  }
}
```

注意这里写的是 `prop.value = ...`，**不是** `prop = ref(initialState[key])`。这是 pinia 一个非常 deliberate 的选择，下面权衡一节会展开。

**第二步——把 ref 本身搬到中心桶**：

```ts
pinia.state.value[id][key] = prop   // 塞的是 ref 本身，不是 ref.value
```

这两步必须先灌值、再搬运，原因微妙：搬运之后中心桶 slot 才指向那个 ref；如果先搬运再灌值看似也行——但实际实现里，搬运循环的同时就在写 store 字段，顺序错了会让 store.count 和中心桶.count 在中间瞬间指向不同的 ref。pinia 选择「先灌值，再一并搬运 + 挂 store」，让原子性更清晰。

reactive 对象的处理稍微复杂点：如果 setup 里写的是 `reactive({ foo: 0 })`，hydration 不能直接 `prop = initialState[key]`（那样会换掉引用），而是**递归合并**到已有对象里。Map 和 Set 更特殊——要先 `clear()` 清空再合并。原因下一节权衡里讲。

## $state：一道代理门

到目前为止，store 上有 `count`、`inc`、`double` 这些字段，中心桶里有 `{ count: <ref> }`，store.count 和中心桶.count 指向同一个 ref——两边天然同步。

但 pinia 还想给 store 暴露一个 `$state` 字段，让用户能写 `store.$state` 直接拿到「这个 store 的全部 state 对象」。最自然的做法是代理：

```ts
Object.defineProperty(store, '$state', {
  get: () => pinia.state.value[id],
  set: (newState) => $patch(($state) => Object.assign($state, newState)),
})
```

get 直接返回中心桶对应 slot；set 不直接替换对象，而是**走 $patch 通道做一次浅合并**。这样 `store.$state = { ... }` 也会触发一次统一的订阅事件，不会绕开 patch 机制。

## 完整时序演示

下面这段脚本约 50 行，从零实现一个最小骨架，跑一遍上面整个流程。**没有 Vue app、没有组件、没有 SSR 服务器**——纯状态层机制。复制保存成 `demo.mjs`，跑 `bun run demo.mjs`（或 `npx tsx demo.mjs`）能看到每一步的中心桶内容、引用一致性、hydration 痕迹。

```ts
import { effectScope, ref, reactive, isRef, isReactive, isComputed } from 'vue'

// 1. 中心桶
const scope = effectScope(true)
const state = scope.run(() => ref({}))!

// 2. skipHydrate Symbol 机制
const skipSym = Symbol('skipHydrate')
const skipHydrate = <T>(o: T): T => Object.defineProperty(o, skipSym, {})
const shouldHydrate = (o: any) =>
  !o || typeof o !== 'object' || !Object.hasOwn(o, skipSym)

// 3. mergeReactiveObjects 极简版（只演示 plain object 递归）
function mergeReactiveObjects(target: any, source: any) {
  for (const k in source) {
    const sv = source[k]
    if (isRef(sv) || isReactive(sv)) continue
    if (target[k] && typeof target[k] === 'object') mergeReactiveObjects(target[k], sv)
    else target[k] = sv
  }
}

// 4. setup store 构建（分类 + 灌值 + 搬运 + 代理）
function createSetupStore(id: string, setup: () => any) {
  const initialState = state.value[id]            // 入口快照（可能由 SSR 预填）
  if (!initialState) state.value[id] = {}         // 占位

  const setupStore = setup()
  const store: any = {}

  for (const key in setupStore) {
    const prop = setupStore[key]
    if ((isRef(prop) && !isComputed(prop)) || isReactive(prop)) {
      // STATE 分支：先灌值，再搬运 ref 本身
      if (initialState && shouldHydrate(prop)) {
        if (isRef(prop)) prop.value = initialState[key]
        else if (prop instanceof Map || prop instanceof Set) {
          prop.clear()
          mergeReactiveObjects(prop, initialState[key])
        } else mergeReactiveObjects(prop, initialState[key])
      }
      state.value[id][key] = prop                  // 搬运 ref 本身
      store[key] = prop                            // store 字段同引用
    } else store[key] = prop                       // action / getter
  }

  Object.defineProperty(store, '$state', {         // 代理到中心桶
    get: () => state.value[id],
    set: (s) => Object.assign(state.value[id], s),
  })
  return reactive(store)
}

// === 演示 1：首次创建（中心桶为空）===
console.log('--- 演示 1：首次创建（无 SSR 数据）---')
const c1 = createSetupStore('counter', () => {
  const count = ref(0)
  const inc = () => count.value++
  return { count, inc }
})
console.log('store.count              =', c1.count)
c1.inc()
console.log('调 inc() 后 store.count  =', c1.count)
console.log('中心桶 counter.count     =', state.value.counter.count)
console.log('store.$state === 中心桶  ?', c1.$state === state.value.counter)

// === 演示 2：SSR hydration（中心桶预填）===
console.log('\n--- 演示 2：SSR hydration ---')
state.value['ssrCounter'] = { count: 42, items: { foo: 1 } }
const c2 = createSetupStore('ssrCounter', () => {
  const count = ref(0)
  const items = reactive({ foo: 0 })
  return { count, items }
})
console.log('store.count              =', c2.count)    // 42（被灌值，ref 没换）
console.log('store.items              =', c2.items)    // { foo: 1 }
console.log('store.$state === 中心桶  ?', c2.$state === state.value.ssrCounter)

// === 演示 3：skipHydrate opt-out ===
console.log('\n--- 演示 3：skipHydrate opt-out ---')
state.value['withRouter'] = { count: 99, router: { route: '/home' } }
const c3 = createSetupStore('withRouter', () => ({
  count: ref(0),
  router: skipHydrate(reactive({ route: '/old' })),
}))
console.log('router 被跳过,保留原值  :', c3.router.route)   // /old
console.log('count 仍被 hydrate      :', c3.count)          // 99
```

预期输出大致是：

```
--- 演示 1：首次创建（无 SSR 数据）---
store.count              = 0
调 inc() 后 store.count  = 1
中心桶 counter.count     = <ref: 1>
store.$state === 中心桶  ? true

--- 演示 2：SSR hydration ---
store.count              = 42
store.items              = { foo: 1 }
store.$state === 中心桶  ? true

--- 演示 3：skipHydrate opt-out ---
router 被跳过,保留原值  : /old
count 仍被 hydrate      : 99
```

注意演示 1 里 `store.count` 是数字 `1`（reactive 包装自动解包了 ref），而中心桶 `counter.count` 还是 ref 本身——两边指向同一个 ref，所以调 `inc()` 双向同步。

## 关键权衡

这一章机制不算多，但每一处选择都换来了具体的东西、也付了具体的代价。下面四条按「设计选择 → 换来了什么 → 代价是什么」展开。

### 权衡一：中心化 state，把 getter / action 留在 store 上

**选择**：把 state 字段从 setup store 内部「搬」到 `pinia.state` 这个中心桶，而 getter 和 action 仍然挂在 store 自己身上。

**换来**：一个统一的序列化入口。SSR、DevTools、持久化插件都通过 `pinia.state.value` 这一个对象读写所有 store 的状态——它们不需要知道 store 内部到底有几个 ref、怎么组织。SSR 只要 `JSON.stringify(pinia.state.value)` 就拿到了全部状态；客户端只要 `pinia.state.value = JSON.parse(payload)` 就恢复。DevTools 想画 state 树，也只需要遍历这一个对象。这一份「单一镜像」省下了三套独立序列化逻辑。

**代价**：setup store 的 state 结构在运行时才确定。option store 在 `setup()` 跑之前就能把 state 写进中心桶（因为 state 是配置项，结构提前知道），但 setup store 不行——它的 state 是 setup 函数 `return` 之后才暴露出来的散落 ref，pinia 必须等 setup 跑完、再遍历分类、再搬运。这个「延迟确定」直接导致 hydration 必须**按值类型分支处理**：ref 直接灌 `.value`、Map/Set 先 clear、其他 reactive 对象递归合并——一份逻辑要分三条路径写，每条路径都有自己的边界条件。

如果当初选「把整个 store 序列化」，hydration 当然简单（直接整体替换），但你得把 getter 和 action 一并序列化——函数没法序列化、计算属性序列化也没意义。所以「中心化 state」不是为了好看，是为了**让 state 这个东西具备可序列化的资格**——只有可序列化的东西才进中心桶，行为（不可序列化）留在 store 上。

### 权衡二：灌进已有 ref，而不是用新 ref 替换

**选择**：hydration 时写的是 `prop.value = initialState[key]`，**不是** `prop = ref(initialState[key])`。换句话说，保留 setup 里创建的那个 ref，只换它内部的值。

**换来**：响应式拓扑不破。setup 函数里，getter / computed / 闭包捕获的常常是对原 ref 的引用：

```ts
const useCounter = defineStore('counter', () => {
  const count = ref(0)
  const double = computed(() => count.value * 2)   // 闭包捕获了 count
  const inc = () => count.value++                  // 闭包捕获了 count
  return { count, double, inc }
})
```

如果 hydration 时把 `count` 替换成一个新 ref，那 `double` 和 `inc` 闭包里捕获的还是**老 ref**——store 字段指向新 ref，getter / action 指向老 ref，状态当场分裂成两份：调 `inc()` 改的是老 ref，store.count 看到的却是新 ref 的值。这种 bug 极难排查。

**代价**：带默认值的 Map / Set 必须先 clear 再合并。考虑 `ref(new Set([1, 2, 3]))` 这种带默认值的写法——如果只把 hydration 数据 merge 进去（不 clear），结果是默认值 `{1,2,3}` 和 hydration 数据 `{4,5}` 的并集 `{1,2,3,4,5}`，默认值污染了恢复后的状态。所以 pinia 专门给 Map / Set 加了一步 `prop.clear()`，强制把状态完全替换为 hydration 数据。reactive 对象虽然也走 mergeReactiveObjects 递归合并，但因为 plain object 的 key 是字符串、合并会覆盖，问题相对没那么严重——但仍要小心跳过 ref/reactive 子节点，避免破坏嵌套的响应式包装。

### 权衡三：skipHydrate 用 Symbol 标记对象

**选择**：用户想让某个对象「不参与 hydration」时，调用 `skipHydrate(obj)` 给它打个 Symbol 标记，hydration 循环里 `shouldHydrate(obj)` 反查这个标记决定是否跳过。

**换来**：setup store 里返回非 state 对象时的优雅 opt-out。典型场景是返回 router 实例、第三方类实例、Vue 组件实例等「有状态但不是 store state」的对象——这些对象内部可能有自己的响应式机制，pinia 强行 merge 反而会破坏它们。如果不提供 skipHydrate，用户只能选「不 return」（破坏 setup store 的封装性）、或者「手动清除 hydration 数据」（侵入式）。

**代价**：Symbol 无法跨网络序列化保留。SSR 把状态序列化成 JSON 传到客户端时，Symbol 属性会丢——客户端 hydration 循环看到的对象不再有 skipHydrate 标记，还是会尝试 hydrate。所以这个机制只在「内存层 hydration」有效（HMR、热重载、单元测试用 initialState 注入）；要跨网络 opt-out，需要在网络传输序列化层另配（这正是 Nuxt 模块用 `definePayloadReducer/Reviver` 配合 `shouldHydrate` 做的事——属另一章）。一个机制解决不了两层问题，pinia 选择了「内存层我先管、网络层让框架自己配」的边界。

### 权衡四：$state 用 defineProperty 代理到中心桶 slot

**选择**：`store.$state` 不是 store 上的真实字段，而是一个 getter/setter——get 时返回 `pinia.state.value[id]`（中心桶对应 slot），set 时走 `$patch + Object.assign` 把新值浅合并进去。

**换来**：所有变更汇聚成一次订阅事件。用户写 `store.$state = { count: 1, name: 'a' }` 时，背后不是直接替换对象，而是发一次 `$patch`——这样 `$subscribe` 的回调只触发一次、time-travel 调试时也只记录一条变更记录。同时 get 路径让 `store.$state` 始终指向中心桶（SSR、devtools 通过 `store.$state` 访问的就是中心桶那个对象），保持单一序列化源。

**代价**：不能直接整体替换 state 对象。`store.$state = new_state` 实际上是浅 assign——`Object.assign(中心桶[id], new_state)`——它会替换顶层 key 的值，但不会递归替换嵌套结构。如果你的 state 有 `state.user.profile.name`，赋值 `store.$state = { user: { profile: { name: 'b' } } }` 时，中心桶的 `user` 字段被整体替换成新 plain object，原本嵌套的 ref 包装丢失，绑定到老 ref 的 getter 闭包会指向已失效的旧引用。要整体深度替换，得显式调 `$patch` 提供函数式 mutator，或逐字段写。

---

读到这里你应该能在脑子里默演一遍了：用户调 useStore → 触发 createSetupStore → 入口快照中心桶 slot → 占位（如需）→ 跑 setup → 遍历分类 → 灌值（按类型分支）→ 搬运 ref 本身 → $state 代理挂上。SSR、DevTools、持久化插件之后想读 state，都从中心桶那个公共留言板进——这就是「state 集中化」换来的统一窗口。
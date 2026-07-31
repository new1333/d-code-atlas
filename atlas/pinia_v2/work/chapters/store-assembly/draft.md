# store 装配机器：双形态归一与属性自动分类

> 前置章节：[[define-store]] 给出了「懒实例化 + 单例缓存」的入口——`useStore()` 首次调用、且 `pinia._s` 里查无此 id 时才触发装配；[[subscription-primitive]] 提供了 `addSubscription/triggerSubscriptions` 这套「Set 持有回调 + 返回 remove」的订阅原语。本章回答的是：**触发装配之后，到底怎么把用户写的一坨东西变成一个可用的 store？**

## 一、痛点：两种写法与互引死循环

用户可以用两种风格声明同一个 store：

```ts
// 风格 A：选项式（state / getters / actions 分开）
const optStore = defineStore('opt', {
  state: () => ({ count: 0 }),
  getters: { double: (s) => s.count * 2 },
  actions: { inc() { this.count++ } },
})

// 风格 B：组合式（一个 setup 函数，返回 ref / 函数 / computed）
const setupStore = defineStore('setup', () => {
  const count = ref(0)
  const double = computed(() => count.value * 2)
  function inc() { count.value++ }
  return { count, double, inc }
})
```

如果没有一台专门的「装配机器」，会撞上三个硬骨头：

1. **两套写法 = 两套运行时？** 选项式把 state/getters/actions 摆成结构化对象，组合式把它们揉进一个返回值。若各维护一套逻辑，订阅、批量变更、devtools、插件等高级特性都得写两遍。
2. **分类靠谁？** 组合式里 `count`、`double`、`inc` 长得完全不同，但用户不会显式标注「这是状态」「这是派生值」「这是动作」。运行时得自己判断。
3. **互引死循环。** 当 A 的逻辑里 `useB()`、B 的逻辑里又 `useA()` 时，装配 A 要等 B 装完，装配 B 又要等 A 装完——互相等，永远装不完。

**一句话核心思想**：先把两种写法都翻译成「一坨返回值」，再用反射把返回值按类型自动分成 **状态 / 动作 / 派生** 三类；并且在装配真正开始之前，**先把半成品 store 登记进缓存**，让互相引用的 store 永远拿得到对方。

## 二、底层原语：如何认出一个计算属性？

整台机器的判定基石只有一个函数——`isComputed`。Vue 的 `computed` 返回的也是一个 ref，所以「是 ref」不足以和普通状态 ref 区分。Pinia 的判定是：**是 ref，且身上带一个 `effect` 属性**（computed 内部持有效应对象，普通 ref 没有）。

```ts
function isComputed(o: any): o is ComputedRef {
  return !!(isRef(o) && (o as any).effect)
}
```

有了这个原语，三分支分类的判定就齐了：

| 返回值的形态 | 判定 | 归类 |
|---|---|---|
| 是 ref 且**非** computed；或 `isReactive()` | `isRef && !isComputed` ∥ `isReactive` | 状态 |
| 是函数 | `typeof prop === 'function'` | 动作 |
| 是 ref 且**带 effect** | `isComputed(prop)` | 派生（getter） |

> 注意第三行在生产构建里其实不进任何分类分支（详见 §五的边界）。分类是**运行时反射**做的，用户零样板——「返回什么就是什么」。

## 三、归一：选项式只是组合式的语法糖

`createOptionsStore` 并不真正装配。它只构造一个 `setup()` 适配器，把三种声明翻译成「组合式返回值」，再委托给唯一的装配器 `createSetupStore(..., isOptionsStore=true)`：

```ts
function setup() {
  if (!initialState && (!__DEV__ || !hot)) {
    pinia.state.value[id] = state ? state() : {}        // 选项式：state() 整体写入字典
  }

  const localState = toRefs(pinia.state.value[id])      // state 拆成逐个 ref
  return assign(
    localState,                                         // 状态（ref 形态）
    actions,                                            // 动作（原样函数）
    Object.keys(getters || {}).reduce((cg, name) => {
      cg[name] = markRaw(computed(() => {               // getter 包成 computed
        setActivePinia(pinia)
        const store = pinia._s.get(id)!                  // 关键：懒取缓存实例（见 §五）
        return getters![name].call(store, store)
      }))
      return cg
    }, {} as Record<string, ComputedRef>)
  )
}
store = createSetupStore(id, setup, options, pinia, hot, true)  // 归一到同一装配器
```

归一发生在**装配入口**：state 拆成 `toRefs`、getters 包成 `computed`、actions 原样，三者 `assign` 成一坨返回值。从此两种写法走同一条流水线，所有高级特性只需实现一次。

## 四、装配主线：从骨架到成品 store

装配器 `createSetupStore` 的执行轨迹（文字版流程图）：

```
构建骨架对象 partialStore（仅含内置方法）
        │
        ▼
store = reactive(partialStore)          ← 响应式包裹
        │
        ▼
pinia._s.set($id, store)                ← 半成品占位登记（关键！）
        │
        ▼
runWithContext → pinia._e.run → effectScope().run → setup({action})
        │  （三层嵌套作用域里跑用户函数）
        ▼
for (key in setupStore)  三分支分类      ← 状态迁入 / 动作包装 / getter 收集
        │
        ▼
assign(store, setupStore) + assign(toRaw(store), setupStore)   ← 双写合并
        │
        ▼
Object.defineProperty(store, '$state')  ← 挂统一状态访问器
        │
        ▼
pinia._p.forEach(插件混入) → isListening = true → return store
```

下面拆三个关键步骤。

### 步骤 1：先搭骨架，再响应式包裹

骨架 `partialStore` 只装内置方法（来自 [[pinia-instance]] 的地基 + [[subscription-primitive]] 的订阅能力），不含任何用户属性：

```ts
const partialStore = {
  _p: pinia,                  // 回指 Pinia 实例
  $id,                        // store id
  $onAction: addSubscription.bind(null, actionSubscriptions),  // 订阅原语直接复用
  $patch,
  $reset,
  $subscribe(callback, options = {}) { /* watch(state[id]) + 去重 */ },
  $dispose,
}

const store = reactive(partialStore) as unknown as Store<...>
```

骨架先建好，再用 `reactive()` 包成响应式对象——**store 天生就是响应式的**。

### 步骤 2：半成品占位（解决互引死循环）

这是整台机器最巧妙的一步。在**执行用户 setup 之前**，就把半成品 store 塞进单例缓存：

```ts
// store the partial store now so the setup of stores can instantiate each other
// before they are finished without creating infinite loops.
pinia._s.set($id, store as Store)

const setupStore = runWithContext(() =>
  pinia._e.run(() => (scope = effectScope()).run(() => setup({ action }))!)
)!
```

注释一语道破动机：**让 store 能在彼此没装配完之前就实例化对方，而不产生无限循环。** 因为缓存里**始终有**那个半成品（哪怕属性还没合并），`useStore()` 的单例查询（见 [[define-store]]）绝不会落空、绝不会触发二次装配。

setup 在**三层嵌套作用域**下执行：`runWithContext`（应用上下文）→ `pinia._e.run`（根作用域，来自 [[pinia-instance]]）→ `effectScope().run`（本 store 子作用域）。最里层的子作用域被 `$dispose()` 的 `scope.stop()` 一键回收。

### 步骤 3：三分支反射分类 + 状态迁入单一真源

拿到 setup 返回值后，遍历每个属性分拣：

```ts
for (const key in setupStore) {
  const prop = setupStore[key]

  if ((isRef(prop) && !isComputed(prop)) || isReactive(prop)) {
    // 状态分支
    if (!isOptionsStore) {
      pinia.state.value[$id][key] = prop     // 迁入：单一真源
    }
  } else if (typeof prop === 'function') {
    setupStore[key] = action(prop, key)       // 动作：套上 $onAction 包装
  } else if (__DEV__ && isComputed(prop)) {
    /* getter：仅收集进 devtools/HMR 元数据 */
  }
}

assign(store, setupStore)                      // 合并到响应式代理
assign(toRaw(store), setupStore)               // 双写：合并到原始对象（修复 storeToRefs #799）
```

**单一真源**的字面实现就在这一行 `pinia.state.value[$id][key] = prop`：组合式 store 里用户写的每个状态 ref 被**原样搬进**全局扁平字典（来自 [[pinia-instance]] 的 `state = ref({})`）。严格地说，store 代理背后与字典里存的是**同一个 ref 对象**：reactive 代理在 get 时把 ref 解包成普通值、在 set 时把新值回写进同一个 ref。因此读 `store.count` 拿到的是解包后的值、写 `store.count = x` 会更新字典里那个 ref——**改一个，另一个动**。订阅、`$patch`、SSR 序列化都只盯这一个字典。

> **双写为什么必要？** `store` 是 `reactive()` 代理；对响应式类型的 prop 直接 `set` 会被代理**解包**成普通对象、丢掉响应式标记。第二行 `assign(toRaw(store), setupStore)` 把同一批属性写进代理背后的原始对象，让按型重建工具（`storeToRefs`，见后续章节）仍能凭 `effect` / `isRef||isReactive` 正确识别其中的引用与响应式子值。

## 五、关键权衡

1. **半成品占位 vs getter 懒取。** 先 `pinia._s.set($id, store)` 换来互引不死循环；代价是选项式 getter 求值时必须**懒取**缓存实例（§三的 `pinia._s.get(id)!`），而不能在装配时直接捕获——因为装配那一刻 store 还是半成品。计算属性的惰性求值天然避开这个时序，比源码里一处被弃用 TODO 注释暗示的「赋值期用全局变量传 store」更干净。

2. **状态原样搬进字典 vs 两种存储形态。** 把组合式的每个 ref 搬进全局扁平字典，换来「单一真源」；代价是选项式与组合式在字典里**形态不同**——选项式是 `state()` 返回的普通对象、组合式是逐个迁入的 ref 集合。差异全靠响应式系统的 **ref 自动解包**在访问时抹平（读出来的都是解包后的值）。

3. **反射分类 vs 规则隐式。** 运行时反射换零样板、写法自由；代价是分类规则隐式（getter 靠「是 ref 且带 effect」识别）。边界情况——比如组合式 store 返回一个被 `markRaw`/`skipHydrate` 标记的对象——会落入「既非状态也非动作」：生产下被原样 `assign` 到 store，不进字典、不参与序列化/订阅。这正是用户表达「非状态实例」（如 router 实例）的途径。

4. **reactive 骨架 + 双写合并 vs 代理解包。** 用 `reactive(partialStore)` 包骨架再合并，换 store 天然响应式；代价是必须双写（见 §四步骤 3）。

## 六、原理演示：一个最小装配器

省略批量变更、订阅、动作拦截、热更新、devtools、插件链、SSR、完整泛型，只演透主线——**半成品占位 + 反射分类 + 单一真源**：

```ts
import { reactive, ref, computed, toRaw, isRef, isReactive } from 'vue'
const { assign } = Object

const _s = new Map()        // 单例缓存（半成品占位用）
const state = ref({})       // 全局扁平状态字典（单一真源）

function isComputed(o) { return !!(isRef(o) && o.effect) }

function assemble(id, setup) {
  // ① 搭骨架（只含内置方法，不含用户属性）
  const partial = { $id: id, $patch: () => {}, $dispose: () => {} }
  const store = reactive(partial)

  // ② 关键：先把半成品登记进缓存，互引时才拿得到对方
  _s.set(id, store)

  // ③ 跑 setup，拿到用户返回的那一坨值
  const ret = setup()

  // ④ 三分支反射分类：状态原样搬进字典（单一真源）
  if (!state.value[id]) state.value[id] = {}
  for (const key in ret) {
    const prop = ret[key]
    if ((isRef(prop) && !isComputed(prop)) || isReactive(prop)) {
      state.value[id][key] = prop   // 状态 → 迁入字典
    }
    // computed 不进任何分支，随下方 assign 挂到 store
  }

  // ⑤ 双写合并：代理 + 原始对象各一份（让 storeToRefs 能识别其中的 ref）
  assign(store, ret)
  assign(toRaw(store), ret)
  return store
}
```

验证「单一真源」。注意 store 与字典都是响应式代理：访问状态属性时 **get 自动解包**（拿到的是值，不是 ref），写入时 **set 回写**到代理背后那个共享 ref：

```ts
const useCounter = () => assemble('counter', () => {
  const count = ref(0)
  const double = computed(() => count.value * 2)
  function inc() { count.value++ }
  return { count, double, inc }
})

const counter = useCounter()

// 读：store 代理与 state 字典背后是同一个 ref；get 自动解包 → 两边都拿到值 0
console.log(counter.count === state.value.counter.count)   // true

// 写：经 store 代理的 setter，reactive 把新值回写进共享 ref（而非替换它）
counter.count = 5
console.log(state.value.counter.count)                    // 5：改一个，另一个动
console.log(counter.double)                               // 10：computed 跟着重算（依赖同一 ref）
```

> 这里**不能**写 `counter.count.value`：`counter.count` 经代理解包后已是普通数字，没有 `.value`。要改值就经代理 `counter.count = 5`（reactive 对 ref 属性的 set 会回写到那个 ref），这正是「单一真源」在写入侧的体现。

## 七、执行轨迹：互引 store 怎么不死循环

输入两个**互相引用**的组合式 store：A 的 setup 调 `useB()`、B 的 setup 调 `useA()`。

```
useA() 首次调用（_s 无 A）
  └─ 装配 A：建骨架 → reactive → _s.set('A', 半成品A)   ← 占位
       └─ 跑 A 的 setup()
            └─ setup 内 useB()（_s 无 B）
                 └─ 装配 B：建骨架 → reactive → _s.set('B', 半成品B)
                      └─ 跑 B 的 setup()
                           └─ setup 内 useA() → _s.get('A') 命中缓存！返回半成品A（不死循环）
                      └─ B 分类 → 合并 → _s.set('B', 成品B)
            └─ A 的 setup 返回 → 分类 → 合并 → _s.set('A', 成品A）
```

关键中转态：**B 装配到一半、A 还是半成品时，`useA()` 已经能从缓存拿到 A**。半成品占位让互引在**装配期**就成立，两个 store 最终都拿到成品。这条轨迹演的是权衡 1。

## 八、边界与易混淆

- **getter 在生产环境不进任何分类分支。** 状态分支被 `!isComputed` 排除、非 function、`__DEV__` 分支不执行——它原样随 `assign(store, setupStore)` 挂到 store。getter 本身已是 computed，无需像状态那样「迁入字典」。
- **`$reset` 因形态而异。** 仅选项式 store 有真实实现（重新 `state()` 后经 `$patch` 合并）；组合式在 `__DEV__` 抛错、生产为 `noop`。这是两种形态「state 声明方式不同」的直接后果。

## 九、源码对照

本章所述机制在 `packages/pinia/src/store.ts` 的关键定位（便于按行核对）：

- `isComputed`——分类的判定基石，`isRef(o) && o.effect`（`store.ts:144-147`）
- 选项式 `setup()` 适配器——state 经 `toRefs`、getters 包 `markRaw(computed)`、归一到 `createSetupStore`（`store.ts:166-207`）
- 半成品占位登记——`pinia._s.set($id, store)` 发生在跑 setup **之前**（`store.ts:492-502`）
- 三分支反射分类 + 状态迁入单一真源——`pinia.state.value[$id][key] = prop`（`store.ts:505-571`）
- 双写合并修复 `storeToRefs`——`assign(store)` + `assign(toRaw(store))`（`store.ts:575-578`）

---

**小结**：装配机器做三件事——**归一**（选项式经适配器降级为组合式）、**分类**（`isComputed`/`isRef`/`isReactive` 三分支反射分拣状态/动作/派生）、**占位**（装配前先把半成品塞进 `_s`，让互引 store 永不陷入死循环）。状态迁入全局字典实现单一真源，`reactive` 骨架让 store 天生响应式。订阅的完整语义（`$subscribe`/`$onAction` 如何挂在骨架那两个内置方法上）留给 [[subscriptions-actions]]；插件在装配末尾如何混入留给 [[plugin-system]]。
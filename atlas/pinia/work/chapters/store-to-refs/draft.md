# 响应式引用提取：`storeToRefs`

> **核心问题**：直接解构一个 store 会丢失响应式——`const { count, double } = useStore()` 之后，`count` 和 `double` 变成了**脱离 store 的普通值**，store 再变化它们也不会更新。`storeToRefs(store)` 就是为了解决这一件事：把 state 转成 ref、把 getter 转成计算属性，**忽略** action 与一切非响应式属性，让解构后的每个字段仍然「连着」store。

本章只聚焦一个目标文件 `storeToRefs.ts`（共 ~116 行），它依赖前置章节「store 的定义与实例化」给出的一个事实：**store 本身是一个 Vue `reactive` 代理**。理解了这一点，本章的一切都顺理成章。

---

## 1. 要解决的问题：解构为什么会丢响应式

store 的构建链是这样的（来自 store-definition）：

```
defineStore(...) → createSetupStore / createOptionsStore
  store = reactive(partialStore)          // store.ts:478
```

也就是说 `useStore()` 拿到的 `store` 是一个 **reactive proxy**。Vue 的响应式建立在「属性访问触发依赖收集」之上：你读 `store.count` 时，这个 get 被 proxy 拦截、登记依赖；但一旦你写 `const { count } = store`，就等于**复制了那一瞬间的值**，复制出的 `count` 不再经过 proxy，依赖链就断了。

```ts
const store = useStore()
const { count } = store       // ❌ count 现在是快照值，store.count 变了它不感知
const refs = storeToRefs(store)
const { count: countRef } = refs  // ✅ countRef 是个 ref，store.count 变它就变
```

所以 `storeToRefs` 的本质是：**逐键地把「经代理访问」的行为，重新打包成一个个独立的 ref / computed**。

---

## 2. 前置原语：来自 Vue 的五块积木

`storeToRefs` 只从 `vue` 引入了 5 个运行时工具，整段逻辑就是它们的组合：

| 积木 | 作用 | 在本章的角色 |
|------|------|--------------|
| `toRaw(proxy)` | 取 reactive 代理背后的原始 target | 遍历键用（拿到「干净的」对象去 `for...in`） |
| `isRef(x)` | 判断是否为 ref | state 分支判据 |
| `isReactive(x)` | 判断是否为 reactive 对象 | state 分支判据 |
| `toRef(proxy, key)` | 把「某代理的某属性」包成一个属性 ref | **构造** state 引用 |
| `computed({get,set})` | 计算属性 | **构造** getter 引用 |

注意缺了一块：**Vue 没有公开的 `isComputed`**。下一节会看到 storeToRefs 是怎么「绕」出 computed 的。

---

## 3. 自底向上：读 `storeToRefs` 的主循环

完整主体只有 10 行有效逻辑（`storeToRefs.ts:87-116`）：

```ts
export function storeToRefs<SS extends StoreGeneric>(store: SS): StoreToRefs<SS> {
  const rawStore = toRaw(store)                    // storeToRefs.ts:90

  const refs = {} as StoreToRefs<SS>
  for (const key in rawStore) {                    // storeToRefs.ts:93
    const value = rawStore[key]                    // storeToRefs.ts:94  原始值，仅用于分类
    if (value?.effect) {                           // storeToRefs.ts:97  → getter
      refs[key] = computed({                       // storeToRefs.ts:99-106
        get: () => store[key],
        set(value) { store[key] = value },
      })
    } else if (isRef(value) || isReactive(value)) { // storeToRefs.ts:107 → state
      refs[key] = toRef(store, key)                // storeToRefs.ts:109-111
    }
    // 隐式 else：action / 原始值 / null / markRaw 值 → 直接跳过，不写入 refs
  }
  return refs
}
```

可以把它看成一台**三分支分类器**：

```
for (key in rawStore):
  value = rawStore[key]
   │
   ├─ value?.effect 为真？  ──是──▶ getter 分支：包一层 computed
   │       (ComputedRefImpl 才有 .effect)
   │
   ├─ isRef(value)||isReactive(value)？ ──是──▶ state 分支：toRef(store,key)
   │
   └─ 否 ──▶ 跳过（函数 action、null、原始值、markRaw 包装的值）
```

### 3.1 为什么先 `toRaw` 再遍历？

`store` 是 reactive 代理。对代理做 `for...in` 会被 get trap 拦截、可能触发依赖收集与一些副作用；`toRaw(store)` 返回代理背后的原始 target，对它遍历既干净又确定能枚举到 store 的全部**自有可枚举属性**（含插件注入的属性，见第 5 节）。这是循环基座。

### 3.2 getter 识别：用 `value?.effect` 代替不存在的 `isComputed`

Vue 的 `ComputedRefImpl` 内部持有一个 `effect: ReactiveEffect` 字段，而普通 `RefImpl`、reactive 对象、函数都**没有** `.effect`。源码注释直说「没有原生方法判断 computed」，并指向 vuejs/core#4165：

```ts
// storeToRefs.ts:95-97
// There is no native method to check for a computed
// https://github.com/vuejs/core/pull/4165
if (value?.effect) { ... }
```

同一手法在前置章节的 `store.ts` 里也有，只是多加了一道 `isRef` 前置：

```ts
// store.ts:144-147
function isComputed(o: any): o is ComputedRef {
  return !!(isRef(o) && (o as any).effect)
}
```

**这里有个分支顺序的关键点**：computed 本身也是一种 ref。storeToRefs 必须把 `.effect` 判断**放在** `isRef||isReactive` **之前**，否则一个 getter 会先命中 state 分支被 `toRef` 处理，类型就错了。store.ts 里因为有 `isRef(o) &&` 兜底可以不在意顺序，但 storeToRefs 删掉了 `isRef` 前置，于是「先 getter、后 state」的次序就成了正确性的一部分。

可选链 `value?.effect` 同时提供了 **null 安全**：当 `value` 是 `null` 或原始值时不会抛错，直接走 else 被跳过——这正是测试 `does not crash on a non-reactive null value`（`storeToRefs.spec.ts:206-222`）所验证的。

---

## 4. getter 分支：为什么不直接返回原 computed，而要「重新包一层」？

这是全章最反直觉、也最关键的设计。分类已经识别出 `value` 是个 computed，却**不**把它原样放进 `refs`，而是重新包一层：

```ts
// storeToRefs.ts:99-106
refs[key] = computed({
  get: () => store[key],            // 通过代理读，而非捕获原 computed
  set(value) { store[key] = value },// 通过代理写
})
```

注意 getter 闭包里读的是**代理** `store[key]`，而不是被分类出来的那个 `value`。三者缺一不可：

**① HMR 热替换后仍指向最新值。** 开发期热更新会把 `store.double` 替换成一个全新的 computed（`storeToRefs.spec.ts:175-191` 的 `keep reactivity` 用例）。如果当初捕获的是旧 computed 对象，`double.value` 会永远读到旧值；而读代理 `store[key]` 永远拿到「当前」这个键上的值——替换了也跟着走。

```
HMR：store.double = computed(() => 1)
  refs.double.get() → store.double  → 新 computed.value = 1   ✅
  （若当初存的是旧 value：refs.double.get → 旧值 ✗）
```

**② 构造期零副作用（惰性）。** `computed` 的 `get` 闭包 `() => store[key]` 在**构造 `storeToRefs` 时根本没被调用**，要等谁读 `refs[k].value` 才求值。`does not trigger getters`（`storeToRefs.spec.ts:193-204`）断言：构造期间 spy 调用次数为 0。这也意味着对一个有大量 getter 的 store 调 `storeToRefs` 是廉价的。

**③ 保留可写 getter 的 setter。** setup store 允许用 `computed({get,set})` 定义可写 getter。包装体固定的 `set(value){ store[key] = value }` 把写操作经代理转发给底层可写 computed，再触发其 setter（`storeToRefs.spec.ts:156-173` 的 `preserve setters in getters`：`refs.double.value = 4` → `n` 变 2）。**即便 options store 的 getter 实质只读，包装体也恒带 `set`**——类型层（第 6 节）会单独把「只读 vs 可写」传达给消费方。

---

## 5. state 分支：用 `rawStore` 分类，用 `store` 构造

```ts
// storeToRefs.ts:94 与 107-111
const value = rawStore[key]          // ← 用 rawStore 判断类型
...
else if (isRef(value) || isReactive(value)) {
  refs[key] = toRef(store, key)      // ← 用 store（代理）构造引用
}
```

这是全章最容易被误读的一处。两个对象名相近、但承担相反的职责：

- **`rawStore[key]` 只用来判断「这条该不该进 state 分支」**——`isRef`/`isReactive` 检测的是原始值本身。
- **构造 ref 用的是代理 `store`**。`toRef(reactiveProxy, key)` 返回一个「属性 ref」：读它就等于读 `store[key]`、写它就等于 `store[key] = v`，**读写全程穿透代理**。只有这样，依赖追踪才能正确建立、解构后才能双向同步。

setup store 的 reactive 子对象最直观地体现这种双向性（`storeToRefs.spec.ts:51-88`）：

```
读 refs.r.value  → store.r（代理，返回同一个 reactive 对象）
写 refs.r.value.n++  ⇄  store.r.n++   互相可见
```

判据 `isRef(value) || isReactive(value)` 还顺带把**插件注入的响应式 state** 纳入：`for...in rawStore` 会枚举到插件经 `pinia.use()` 写进来的属性；是 ref/reactive 的（如 `pluginN: ref(20)`）就进，是普通值（如 `shared: 10`）就被同一道过滤跳过（`storeToRefs.spec.ts:129-154`）。

---

## 6. 一条隐藏前置链路：issue #799

第 3 节说 `for (const key in rawStore)` 要能枚举到 state/getter，是有前提的——这些键必须真的存在于 raw target 上。这个前提由前置章节 `store.ts` 末尾**专门为 `storeToRefs` 加的一行**保证：

```ts
// store.ts:573-578
// add the state, getters, and action properties
assign(store, setupStore)
// allows retrieving reactive objects with `storeToRefs()`. Must be called after
// assigning to the reactive object.  Make `storeToRefs()` work with `reactive()` #799
assign(toRaw(store), setupStore)
```

setup 函数返回的对象 `setupStore` 先 `assign` 到代理 `store`（让组件里 `store.xxx` 能用），再 `assign` 到 `toRaw(store)`（让 raw target 也持有这些自有可枚举属性）。没有第二行，`toRaw(store)` 上就只有 `partialStore` 的东西，`storeToRefs` 的循环会枚举不到任何 setup store 的字段——这就是 issue #799 的修复点，也是本章能成立的地基。

---

## 7. 类型层：`StoreToRefs` 的三段交集

返回值的类型 `StoreToRefs<SS>` 是三个部分的交集（`storeToRefs.ts:70-77`）：

```ts
export type StoreToRefs<SS extends StoreGeneric> =
  SS extends unknown
    ? _ToStateRefs<SS> &                                  // ① state
        ToRefs<PiniaCustomStateProperties<StoreState<SS>>> & // ② 插件 state
        _ToComputedRefs<StoreGetters<SS>>                 // ③ getter
    : never
```

分别对应运行时的三条来源。其中两处细节值得点明：

- **外层 `SS extends unknown` 恒真**，注释明说「总是 true，但这个条件类型让类型对联合做**分布式展开**」。写法上看似多余，实则是为了在 store 是联合类型时逐成员拆开。
- **getter 的只读 / 可写被区分**（`storeToRefs.ts:32-46`）：`_IsReadonly` 通过对比「去掉 `readonly` 前后类型是否相同」来判定——**两者相同 → 非只读 → `WritableComputedRef`；两者不同 → 只读 → `ComputedRef`**（方向别记反，注释里 `false`/`true` 标得很清楚）。

这恰好和运行时「包装体恒带 `set`」呼应：运行时统一可写，**类型层**负责把可写性如实传达给消费方。

---

## 8. 端到端数据流

把构造期与使用期串起来，完整的图景如下：

```
【构造期】storeToRefs(store)
  toRaw(store) → rawStore
  for key in rawStore:
       getter  → computed({get:()=>store[key], set})   闭包此刻不执行（惰性）
       state   → toRef(store, key)                     绑定代理
       其余    → 跳过
  返回 refs

【使用期·getter】refs.double.value
  读 → 包装 computed.get → store.double（代理解包）→ 底层 getter computed.value
  写 → 包装 computed.set → store.double = v → 底层可写 computed 的 setter

【使用期·state】refs.count.value
  读 → store.count（代理，自动解包 ref）
  写 → store.count = v（代理，回写到底层 ref/reactive）
```

---

## 小结

`storeToRefs` 是一台极简的分类器，但它每一个看似随意的选择都有理由：

- **`toRaw` + `for...in`** → 干净枚举，连插件 state 都收（地基是 store.ts:578 的双写）；
- **`value?.effect` 先行** → 用 ComputedRefImpl 的内部字段代替不存在的 `isComputed`，顺带 null 安全；
- **getter 重新包 computed 且读代理 `store[key]`** → HMR 不失效、构造期零副作用、可写 setter 保留；
- **state 用 `toRef(store,key)`** → 「rawStore 分类、store 构造」，读写穿透代理，解构后双向同步；
- **action / null / 原始值 / markRaw** → 静默跳过，不报警告。

记住一句话：**它没有复制任何值，而是为每个响应式字段重新建立了一条「经代理访问」的引用通道**——这就是解构后响应式不丢的全部秘密。
# 响应式引用提取 · 源码精读

> 精读对象：`packages/pinia/src/storeToRefs.ts`（本章唯一 sourceFile）。
> 关键运行时语义依赖 `packages/pinia/src/store.ts` 中 store 的构建方式（dependsOn = store-definition），故本文按需摘录 `store.ts` 的相关事实作为背景，不越界做架构拆解。

## 概念要点

- **职责一句话**：`storeToRefs(store)` 遍历 store 的全部自有可枚举键，把 **getter（computed）** 转成新的计算属性引用、把 **state（ref / reactive）** 转成属性 ref，**忽略** action（函数）与一切非响应式属性（含 `null`、原始值、`markRaw` 值）。目的是让用户在 setup 中**解构 store 后仍保持响应式**。源码位置: packages/pinia/src/storeToRefs.ts:79-89（JSDoc）、:87-116（实现）。

- **store 本身是 reactive 代理**：`store = reactive(partialStore)`，因此 `storeToRefs` 入参拿到的是一个 Vue reactive proxy。源码位置: packages/pinia/src/store.ts:478-490。这也是函数内第一行 `toRaw(store)` 存在的原因——拿到代理背后的原始 target 以做键枚举与值分类。源码位置: packages/pinia/src/storeToRefs.ts:90。

- **getter 的识别靠 `value?.effect`**：Vue 的 `ComputedRefImpl` 暴露 `effect: ReactiveEffect`，而普通 `RefImpl` / reactive 对象 / 函数都没有 `.effect`。代码注释明说「没有原生方法判断 computed」（无公共 `isComputed`），并以 vuejs/core#4165 作为依据。源码位置: packages/pinia/src/storeToRefs.ts:95-97。同一手法在 `store.ts` 内部的 `isComputed` 中也有（那里多加一道 `isRef(o)`），佐证这是跨文件的统一约定。源码位置: packages/pinia/src/store.ts:144-147。

- **getter 不会被「原样返回」，而是包一层新的可写 computed**：包装体 `computed({ get: () => store[key], set(value){ store[key] = value } })` 通过 reactive 代理读写，而不是捕获原始 computed 对象。源码位置: packages/pinia/src/storeToRefs.ts:99-106。三个理由（均由测试佐证，见下「易混淆」）：
  1. **HMR/热替换后仍指向最新值**——读代理 `store[key]` 永远拿到当前 getter，而非被替换掉的旧 computed。
  2. **惰性、构造期零副作用**——`store[key]` 仅在 `.value` 被读取时才求值，构造 `storeToRefs` 不会触发任何 getter。
  3. **保留可写 getter 的 setter**——对 setup store 中 `computed({get,set})` 类型的 getter，包装体的 `set` 把写操作经代理转发给底层可写 computed。

- **state 分支用 `toRef(store, key)` 而非返回原始 ref**：注意它绑定的是代理 `store`（不是 `rawStore`）。`toRef(reactiveProxy, key)` 返回一个「属性 ref」，读写都穿透代理，从而既建立依赖追踪、又保证解构后双向同步。源码位置: packages/pinia/src/storeToRefs.ts:107-111。判据是 `isRef(value) || isReactive(value)`——这里的 `value` 是 `rawStore[key]`（原始值），用于分类；而构造 ref 用的是 `store`（代理）。**「用 rawStore 分类、用 store 构造」是该函数最关键的细节之一。**

- **插件添加的 state 会被自动纳入**：`for...in rawStore` 枚举 store 全部自有可枚举属性，包含插件通过 `pinia.use()` 注入的 ref/reactive 属性；非响应式插件属性则被同一过滤跳过。源码位置: packages/pinia/src/storeToRefs.ts:93。类型侧由 `ToRefs<PiniaCustomStateProperties<StoreState<SS>>>` 体现。源码位置: packages/pinia/src/storeToRefs.ts:75、packages/pinia/src/types.ts:533（空接口，供用户声明合并扩充）。

- **类型层 `StoreToRefs<SS>` 是三段交集**：`_ToStateRefs<SS> & ToRefs<PiniaCustomStateProperties<...>> & _ToComputedRefs<StoreGetters<SS>>`，分别对应 state / 插件 state / getter。外层 `SS extends unknown ? ... : never` 注释说明恒为真，目的只是让条件类型对联合**分布式展开**。源码位置: packages/pinia/src/storeToRefs.ts:70-77。

- **getter 的只读 vs 可写在类型上被区分**：`_ToComputedRefs` 用 `_IsReadonly` 判定每个键——若属性类型与「去掉 readonly」后相同则视为非只读 → `WritableComputedRef`，否则 → `ComputedRef`。源码位置: packages/pinia/src/storeToRefs.ts:26-46。这与运行时包装体总是带 `set` 相呼应（类型层把可写性传达给消费方）。

- **state 的类型分支 `_ToStateRefs`**：当 store 的 state 由 ref 组成（setup store）时产出 `{ [K in Key]: ToRef<State[K]> }`，否则回退到 `ToRefs<UnwrappedState>`（options store 的纯 reactive state）。源码位置: packages/pinia/src/storeToRefs.ts:52-64。

## 关键调用链

构造期（消费侧）：
```
storeToRefs(store)
  └─ toRaw(store) → rawStore                                   // storeToRefs.ts:90
  └─ for (key in rawStore):                                     // storeToRefs.ts:93
       ├─ value = rawStore[key]                                 // :94  原始值，用于分类
       ├─ value?.effect  ──是──▶ computed({get:()=>store[key], set})   // :97-106  getter
       ├─ isRef(value)||isReactive(value) ──是──▶ toRef(store, key)    // :107-111  state
       └─ 否 ──▶ 跳过（action / 原始值 / null / markRaw）             // 隐式 else
```

被构造出的 ref 在使用期的数据流：
```
// getter 分支产出的 computed：
读 refs[k].value → computed.get → store[k] →（代理解包）→ 底层 getter computed.value
写 refs[k].value → computed.set → store[k]=v →（代理）→ 底层可写 computed 的 setter

// state 分支产出的 toRef：
读 refs[k].value → store[k]（代理，自动解包 ref）
写 refs[k].value → store[k]=v（代理，回写到底层 ref/reactive）
```

与 store 构建链的衔接（背景，来自 store.ts）：
```
defineStore(...) → createSetupStore / createOptionsStore
  store = reactive(partialStore)                       // store.ts:478
  options store getter: markRaw(computed(() => ...))   // store.ts:188-201
  setup store: 分类 state((isRef&&!isComputed)||isReactive)/action(fn)/getter(isComputed)  // store.ts:505-571
  assign(store, setupStore)                            // store.ts:575
  assign(toRaw(store), setupStore)  ← 专为 storeToRefs 加  // store.ts:576-578（issue #799）
```

## 源码摘录（带行号）

**运行时主体**（packages/pinia/src/storeToRefs.ts:87-116）：
```ts
export function storeToRefs<SS extends StoreGeneric>(
  store: SS
): StoreToRefs<SS> {
  const rawStore = toRaw(store)

  const refs = {} as StoreToRefs<SS>
  for (const key in rawStore) {
    const value = rawStore[key]
    // There is no native method to check for a computed
    // https://github.com/vuejs/core/pull/4165
    if (value?.effect) {
      // @ts-expect-error: too hard to type correctly
      refs[key] =
        // ...
        computed({
          get: () => store[key],
          set(value) {
            store[key] = value
          },
        })
    } else if (isRef(value) || isReactive(value)) {
      // @ts-expect-error: the key is state or getter
      refs[key] =
        // ---
        toRef(store, key)
    }
  }

  return refs
}
```

**getter 识别手法对照**——store.ts 内部的 `isComputed`（packages/pinia/src/store.ts:144-147）：
```ts
function isComputed<T>(value: ComputedRef<T> | unknown): value is ComputedRef<T>
function isComputed(o: any): o is ComputedRef {
  return !!(isRef(o) && (o as any).effect)
}
```

**store 为 reactive 代理**（packages/pinia/src/store.ts:478-490）：
```ts
const store: Store<Id, S, G, A> = reactive(
  __DEV__ || (__USE_DEVTOOLS__ && IS_CLIENT)
    ? assign({ _hmrPayload, _customProperties: markRaw(new Set<string>()) }, partialStore)
    : partialStore
) as unknown as Store<Id, S, G, A>
```

**专为 storeToRefs 而加的「双写」**（packages/pinia/src/store.ts:573-578）：
```ts
// add the state, getters, and action properties
assign(store, setupStore)
// allows retrieving reactive objects with `storeToRefs()`. Must be called after assigning to the reactive object.
// Make `storeToRefs()` work with `reactive()` #799
assign(toRaw(store), setupStore)
```
> 注：`assign(toRaw(store), setupStore)` 把 setupStore 的自有可枚举属性也写到 raw target 上，正是 `for (const key in rawStore)` 能枚举到 state/getter 的前提（issue #799）。

**选项 store 的 getter 被包成 computed**（packages/pinia/src/store.ts:182-201，节选）：
```ts
Object.keys(getters || {}).reduce((computedGetters, name) => {
  // ...
  computedGetters[name] = markRaw(
    computed(() => {
      setActivePinia(pinia)
      const store = pinia._s.get(id)!
      return getters![name].call(store, store)
    })
  )
  return computedGetters
}, {} as Record<string, ComputedRef>)
```

**类型层产出**（packages/pinia/src/storeToRefs.ts:42-77，节选）：
```ts
type _ToComputedRefs<SS> = {
  [K in keyof SS]: true extends _IsReadonly<SS, K>
    ? ComputedRef<SS[K]>
    : WritableComputedRef<SS[K]>
}

export type StoreToRefs<SS extends StoreGeneric> =
  // NOTE: always trues but the conditional makes the type distributive
  SS extends unknown
    ? _ToStateRefs<SS> &
        ToRefs<PiniaCustomStateProperties<StoreState<SS>>> &
        _ToComputedRefs<StoreGetters<SS>>
    : never
```

## 易混淆 / 需 Writer 注意

以下每条都有测试直接佐证（packages/pinia/__tests__/storeToRefs.spec.ts），Writer 讲解时建议点明：

1. **为什么 getter 要「重新包一层 computed」而不是直接返回原 computed？** —— 关键在 `keep reactivity` 用例：HMR 把 `store.double` 替换成新 computed 后，经由 `storeToRefs` 取出的 `double` 仍读到新值（因为读的是代理 `store[key]`，不是被替换前的旧对象）。源码位置: packages/pinia/__tests__/storeToRefs.spec.ts:175-191。务必讲清「读代理」vs「捕获原值」的差别。

2. **`storeToRefs()` 构造期绝不触发 getter**（惰性）。`does not trigger getters` 用例断言 spy 调用 0 次。源码位置: packages/pinia/__tests__/storeToRefs.spec.ts:193-204。原因：包装 computed 的 `get` 闭包 `() => store[key]` 在构造时未被调用。

3. **可写 getter 的 setter 会被保留**。`preserve setters in getters` 用例：setup store 用 `computed({get,set})`，`refs.double.value = 4` 经包装体 `set` → `store[key]=value` → 底层 setter → `n` 变为 2。源码位置: packages/pinia/__tests__/storeToRefs.spec.ts:156-173。这解释了包装体为何固定带 `set`（即便 options store 的 getter 实质只读）。

4. **`null` / 原始值 / 函数会被静默跳过，且不报警告**。`does not crash on a non-reactive null value` 用例：`nullableItem: null` 不出现在结果里，且 `mockWarn()` 断言函数全程静默。源码位置: packages/pinia/__tests__/storeToRefs.spec.ts:206-222。`value?.effect` 的可选链同时提供了 null 安全。

5. **插件注入的 ref 会进、非响应式插件值不进**。`contain plugin states` 用例：`pluginN: ref(20)` 出现、`shared: 10` 不出现。源码位置: packages/pinia/__tests__/storeToRefs.spec.ts:129-154。

6. **reactive 子对象双向同步**。setup store 的 `r: reactive({n:1})` 经 `toRef` 后，`r.value.n++` 与 `store.r.n++` 互相可见。源码位置: packages/pinia/__tests__/storeToRefs.spec.ts:51-88。

7. **「rawStore 分类、store 构造」的命名易误导**。代码里 `value = rawStore[key]` 用于判断类型，而 `computed(()=>store[key])` / `toRef(store,key)` 都用代理 `store`。Writer 若贴源码需提醒读者不要误以为两处同源——这是响应性能正确建立依赖的关键。

8. **`value?.effect` 与 store.ts 的 `isComputed(o)=isRef(o)&&o.effect` 略有差异**：storeToRefs 省去了 `isRef` 前置。在 store 语境下安全（只有 computed 才带 `.effect`），但语义上 storeToRefs 的分支顺序（先 `.effect`，再 `isRef||isReactive`）才是它成立的依据——computed 本身也是 ref，必须先被 getter 分支截走。源码位置: packages/pinia/src/storeToRefs.ts:97-111 vs packages/pinia/src/store.ts:144-147。

9. **类型只读性判定 `_IsReadonly` 的方向容易记反**：注释明确「两者相同 → 非只读（返回 false）；两者不同 → 只读（返回 true）」。源码位置: packages/pinia/src/storeToRefs.ts:32-37。

## 未理解

- 无。本章目标文件逻辑闭环，运行时与类型层、测试用例三方可互相印证。
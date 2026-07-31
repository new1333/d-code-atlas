# storeToRefs：响应式引用的按型重建

## 一个被反复踩的坑：解构 store，响应性没了

在 Composition API 里，我们习惯把需要的值「解构」出来单独用。但当你对一个 Pinia store 这么做时：

```ts
const counter = useCounterStore()
const { count, double, increment } = counter
```

`count` 和 `double` 拿到的是**调用那一刻的快照值**——此后 store 无论怎么变，这俩变量纹丝不动。原因来自上一章「store 装配机器」的结论：store 本质是一个被 `reactive(partialStore)` 包住的响应式代理对象，`const { count } = counter` 只是读了代理上的值，并没有建立任何依赖追踪。

退一步，用 Vue 通用的 `toRefs(store)` 行不行？也不理想。`toRefs` 会把对象上**每一个**属性都包成引用——连同 store 的方法（actions）、插件塞进来的普通属性一起。方法被包成引用后，你得先 `.value` 取值才能调用，既别扭又浪费。

`storeToRefs` 就是专为解决这件事而生：**只把「状态」和「计算属性（getters）」重建为引用，方法与非响应式属性一律忽略。**

## 核心思想

一句话：**先脱去响应式代理「看清每条属性的真实类型」，再只为状态与计算属性各造一个「始终回访活着的 store」的新引用，绝不把内部对象直接交出去。**

这里的关键词是「按型重建」——不是把 store 上已有的对象直接搬运出去，而是根据每个属性的类型，重新打造一个绑定在活 store 上的引用。

## 自底向上：三个前置原语

`storeToRefs` 自身只有二十几行，但它把重量压在了三个来自 Vue 的底层原语，以及一条来自装配端的隐含契约上。

**原语 1：`toRaw(reactiveObj)` —— 脱代理取裸对象。**
`toRaw` 返回被 `reactive()` 包裹之前的原始对象。为什么要先脱代理？因为 reactive 代理在读取时会**自动解包 ref / computed**——你通过代理读 `store.count`，拿到的是 ref 解包后的数字，而非 ref 对象本身。被解包之后，状态、计算属性、普通值看起来都是一样的「值」，根本无从分辨类型。只有到裸对象上去读，ref 和 computed 才保持原样，分类才有可能。

**原语 2：`toRef(store, key)` —— 属性引用。**
给一个对象和一个键名，造一个引用，它的 `.value` 取值即读 `store[key]`、赋值即写 `store[key]`。注意它指向的是**活 store**（代理），每次访问都即时解析，所以 store 那个键后续被替换，引用照样能读到新值。状态分支就用它。

**原语 3：`computed({ get, set })` —— 委托计算属性。**
新建一个可写的计算属性，它的 get/set 都不碰自己内部的状态，而是转发到 `store[key]` 上。计算属性分支就用它。

**来自装配端的隐含契约（store-assembly 章节的伏笔）。**
`toRaw` 能在裸对象上读到原始 ref/computed，并不是天然成立的——它依赖 store 装配时多写了一行：

```ts
// store.ts:575-578
assign(store, setupStore)
// allows retrieving reactive objects with `storeToRefs()`. Must be called after assigning to the reactive object.
// Make `storeToRefs()` work with `reactive()` #799
assign(toRaw(store), setupStore)
```

第一行把装配结果写进响应式代理（让 `store.x` 这种直接访问拥有响应式解包的便利）；第二行**绕开代理**，把原始的 ref/computed 对象直接写回裸对象。正是这第二行，保证 `toRaw(store)[key]` 能读到未解包的原始对象——这是 `storeToRefs` 能够分类的输入前提。注释里的 `#799` 就是这个契约的来源。

## 心智模型：五步流程

```
输入: store（一个 reactive 代理对象）
   │
   ▼
① toRaw(store) ───────────────► 取裸对象（ref/computed 在此保持原样）
   │
   ▼
② for (key in rawStore) ──────► 逐键遍历
   │
   ▼
③ 读裸值 value = rawStore[key]► 读对象本身，而非解包后的值
   │
   ├── value?.effect 为真? ────► ④a 计算属性分支
   │                              refs[key] = computed({
   │                                get: () => store[key],
   │                                set: v => { store[key] = v },
   │                              })
   │
   ├── isRef(value)||isReactive(value)? ─► ④b 状态分支
   │                              refs[key] = toRef(store, key)
   │
   └── 都不是（函数/null/普通值）► ④c 静默丢弃
   │
   ▼
输出: 只含「状态引用 + 计算属性引用」的对象
```

所有新引用都绑定在**活 store** 上，读取时才即时解析同名属性——这是后续两条权衡的共同落脚点。

## 源码精读

完整实现只有一处循环、两条分支：

```ts
// storeToRefs.ts:87-116
export function storeToRefs<SS extends StoreGeneric>(
  store: SS
): StoreToRefs<SS> {
  // ① 脱代理，拿裸对象作为遍历源
  const rawStore = toRaw(store)

  const refs = {} as StoreToRefs<SS>
  // ② 逐键遍历裸对象
  for (const key in rawStore) {
    // ③ 读「裸值」——是 ref/computed 对象本身，不是解包后的值
    const value = rawStore[key]
    // There is no native method to check for a computed
    // https://github.com/vuejs/core/pull/4165
    if (value?.effect) {
      // ④a 计算属性分支：新建委托 store 的可写计算属性
      refs[key] =
        computed({
          get: () => store[key],
          set(value) {
            store[key] = value
          },
        })
    } else if (isRef(value) || isReactive(value)) {
      // ④b 状态分支：用属性引用指向活 store 同名属性
      refs[key] =
        toRef(store, key)
    }
    // ④c 其余（方法/普通值/null）落空两个分支，自然被忽略
  }

  return refs
}
```

### 细节一：用什么判定「计算属性」

注意 `value?.effect` 这个判定。计算属性在 Vue 内部的实现上带有一个 `effect` 字段；普通状态 ref 没有这个字段。源码注释直白地写道「当时没有原生的方法来检测一个计算属性」，并附上了 vuejs/core#4165 这个补全公共 `isComputed` 的 PR（`storeToRefs.ts:95-97`）。可选链 `value?.effect` 还顺带让 `null`/`undefined` 不至于抛错。

### 细节二：判定顺序不可换

两条分支的**先后次序是关键**，不能调换：

> 计算分支（`value?.effect`）必须**先于**状态分支（`isRef || isReactive`）。

因为计算属性**本身也是一种 ref**。如果先判 `isRef`，所有 getter 都会被误归到状态分支，丢掉 getter 的语义。先 `value?.effect` 精确剔除计算属性，剩下的 ref/reactive 才是真正的状态。

### 细节三：计算属性为什么是「新建一个」而非「直接交出」

这是整段代码最反直觉、也最关键的一处。注意计算分支**没有**返还原计算属性对象，而是新建了一个 get/set 全部委托给 `store[key]` 的包装计算属性。直接交出原对象不是更省事吗？

答案藏在装配端的另一条注释里：

```ts
// store.ts:580-582
// use this instead of a computed with setter to be able to create it anywhere
// without linking the computed lifespan to wherever the store is first
// created.
```

直接交出的原计算属性，其生命周期钉死在 store 首次创建的那一刻；而新建的这个委托计算属性，**每次取值都回访活 store 的同名属性**。于是即便 store 内部的那个计算属性被整体替换（典型场景是热更新 HMR），早先 `storeToRefs` 产出的旧引用再读取，依然能拿到新值——引用的生命周期与「store 何时何地首次创建」彻底解耦。这就是「重建」而非「搬运」的真正用意。

## 关键权衡

把上面三条细节收束成这张权衡表，它们就是本章的核心：

| # | 选择 | 换来的能力 | 付的代价 |
|---|------|-----------|---------|
| 1 | 读**裸对象**（`toRaw`）来分类，而非读代理 | 能区分状态/计算属性/普通值（代理会把它们都解包成普通值，无从分辨） | 引入隐含契约：装配端必须把原始 ref/computed 写回裸对象（`#799`） |
| 2 | 计算属性**新建一个委托计算属性**，而非直接交出原对象 | 新引用的生命周期与 store 首次创建时机解耦，扛得住内部成员被整体替换（热更新） | 多一层转发，更新路径变长 |
| 3 | 状态用属性引用、计算属性用委托计算属性；方法与非响应式属性**一律丢弃** | 产物干净：只含可响应字段，方法照常可调（`const { increment } = store` 仍然有效） | 「非响应式但用户可能想要」的字段会被静默丢掉（dev 下有诊断告警兜底） |

第 3 条的兜底：插件返回的非响应式属性会被本函数忽略，在 dev 模式下触发 `PINIA_R1006` 诊断，提示用户用 `ref`/`reactive`/`markRaw` 明确表达意图（`diagnostics.ts:40-41`）。

## 原理演示：从零复刻核心逻辑

剥掉类型和边角，`storeToRefs` 的核心只是一次「脱代理分类 + 绑活 store 回访」：

```ts
import { computed, isReactive, isRef, toRaw, toRef } from 'vue'

function storeToRefs(store) {
  // 1. 脱去 reactive 代理，拿到裸对象——只有裸对象上 ref 与 computed 才保持原样
  const rawStore = toRaw(store)
  const refs = {}

  for (const key in rawStore) {
    const value = rawStore[key] // 2. 读「裸值」（对象本身，而非解包后的值）

    if (value?.effect) {
      // 3a. 计算属性带 effect 特征字段 → 新建委托计算属性，回访活 store
      refs[key] = computed({
        get: () => store[key],
        set: (v) => { store[key] = v },
      })
    } else if (isRef(value) || isReactive(value)) {
      // 3b. 状态 → 属性引用，指向活 store 同名属性
      refs[key] = toRef(store, key)
    }
    // 3c. 其余（方法 / 普通值 / null）→ 静默丢弃
  }

  return refs
}
```

这段演示演的正是「读裸分类 + 绑活 store 回访」这条核心权衡。演示刻意省略了：产物类型如何把只读 getter 标成只读 `ComputedRef`（靠 `_IsReadonly`/`_IfEquals` 这类 TS 类型技巧）、dev 诊断告警、完整泛型，以及可写 getter 的精细只读判定——它们不影响对核心机制的理解。

## 一次完整的执行轨迹

**输入**——一个 setup store，含「一个状态、一个由该状态算出的计算属性、一个方法」：

```ts
const useCounter = defineStore('counter', () => {
  const count = ref(0)               // 状态：一个 ref
  const double = computed(() => count.value * 2) // 计算属性
  function increment() { count.value++ }         // 方法
  return { count, double, increment }
})
const store = useCounter()
```

**中间态**——`storeToRefs(store)` 内部：

```
toRaw(store) → 裸对象（其上 count 是 ref、double 是 computed、increment 是函数）
  · count   → rawStore.count 是 ref     → isRef 命中 → 状态分支 → toRef(store, 'count')
  · double  → rawStore.double.effect 存在 → 计算分支 → 新建委托 computed
  · increment → 既无 effect 也非 ref    → 落空两分支 → 丢弃
```

**输出**——只含两个引用的对象：

```ts
const { count, double } = storeToRefs(store)
//   count  → ToRef，指向 store.count（活）
//   double → WritableComputedRef，get/set 都委托 store.double
// increment 被丢弃；要调用方法仍应直接从 store 取：
const { increment } = store  // 方法不受影响，照常可用
```

**热更新验证**（对应官方 `keep reactivity` 测试，`storeToRefs.spec.ts:175-191`）：若后续热更新把 store 内部的 `double` 整体替换成一个新的计算属性，上面那个早先产出的 `double` 引用再读取，**仍然得到新值**——因为它每次取值都回访 `store.double`，而 `store.double` 此时已指向新的计算属性。这正是「权衡 2」所要换来的保证。

## 小结

`storeToRefs` 把「让 store 像普通引用一样被解构」这件看似简单的事，拆成了三步可验证的机制：**脱代理取裸对象**（靠装配端 `assign(toRaw(store))` 契约保证可读到原始类型）、**按型分类**（`value?.effect` 先于 `isRef||isReactive`）、**绑活 store 重建**（状态用属性引用、计算属性用委托计算属性）。它不搬运内部对象，而是重建——以此换来产物干净、且引用生命周期独立于 store 创建时机。理解了它，也就理解了为什么「解构 store 必须用 `storeToRefs`，而方法却可以直接从 store 解构」这条 Pinia 的日常铁律。
# storeToRefs：响应式引用的按型重建 · 源码精读

## 给 Writer 的教学钩子（必填，8 子项缺一不可）

- **用户痛点 / 场景**：想把 store 的字段「解构」出来在 setup 里单独用（形如 `const { count } = store`），但 store 本质是一个被响应式代理包住的对象——直接解构拿到的是那一刻的快照值，响应性当场丢失，store 后续怎么变、解构出的变量都纹丝不动。退一步用通用 `toRefs(store)` 又会把方法、插件塞进来的普通属性也一并包成引用，方法被包进去后还得先取值才能调用，既浪费又难用。

- **一句话核心思想**：先脱去响应式代理「看清每条属性的真实类型」，再只为「状态」与「计算属性」各造一个「始终回访活着的 store」的新引用，绝不把内部对象直接交出去。

- **设计动机（为什么需要它）**：让 store 能像普通引用一样被解构使用，同时满足三条隐含要求——不暴露内部实现细节、不误带方法/非响应式字段、且解构出的引用要能扛住「store 内部成员被整体替换」（典型场景是热更新）。

- **关键权衡（3 条，本 Atlas 的核心）**：
  1. 读「裸对象」来分类，而不是读代理 → 换来「能区分状态/计算属性/普通值」的能力（代理读取会把它们都解包成普通值，无从分辨）→ 代价是引入一个隐含契约：store 装配阶段必须把真实的引用/计算属性写回裸对象，否则分类无源可读。
  2. 给每个计算属性新建一个「取值和赋值都回访活 store 同名属性」的包装计算属性，而不是直接把内部那个计算属性交出去 → 换来新引用的生命周期与「store 何时何地首次创建」彻底解耦（store 内部成员被换掉后，旧引用仍取到最新值）→ 代价是多一层转发、更新路径变长。
  3. 状态用「指向活 store 同名属性的属性引用」、计算属性用「委托计算属性」，而方法与非响应式属性一律丢弃 → 换来产物干净（只含可响应字段、方法照常可调）→ 代价是「非响应式但用户可能想要」的字段会被静默丢掉（dev 下有诊断告警兜底）。

- **最小心智模型（5 步）**：
  1. 拿到 store，先取它的「裸对象」——只有裸对象里，状态引用和计算属性才保持原样。
  2. 逐键遍历裸对象，取出每个键在裸对象上的「真实值」。
  3. 按类型分流：该值带「计算属性特征标记」→ 走计算属性分支；否则若是引用或响应式对象 → 走状态分支；都不是（函数、null、普通值）→ 丢弃。
  4. 计算属性分支：新建一个包装计算属性，其取值回访「活 store 同名属性」、赋值写回「活 store 同名属性」。
  5. 状态分支：用「属性引用」把「活 store 同名属性」包成一个引用。
  所有新引用都绑定在「活 store」上，读取时才即时解析同名属性。

- **最小原理演示（替代旧"复刻范围"）**：
  - 应演示：一个几十行的从零实现，只演三件事——①对 store 脱去响应式代理拿到裸对象；②遍历裸对象每个键取裸值；③按类型分流：带计算属性特征标记的→新建「取/赋都回访活 store 同名属性」的包装计算属性；是引用或响应式对象的→包成「指向活 store 同名属性」的属性引用；其余丢弃。这段演示演的正是「读裸分类 + 绑活 store 回访」这条核心权衡。
  - 应故意省略：TS 类型推导（产物类型如何把只读 getter 标成只读计算属性）、dev 诊断告告警、方法/插件属性处理的边角、可写 getter 的精细只读判定、完整泛型。

- **正文不宜展开的细节**：通用 `toRef(对象,键)` 的属性引用语义、计算属性对象上那个用于识别的内部特征字段、store 装配端「为何要同时向代理和裸对象各写一次」（关联 issue #799）、TS 的 `_IsReadonly`/`_IfEquals` 类型技巧、以及「其实已有公共方法可识别计算属性，但本文件仍沿用内部字段判定」这一历史遗留。

- **推荐的一个执行轨迹例子**：输入——一个 setup store，含「一个状态、一个由该状态算出的计算属性、一个方法」。中间态——脱代理取裸对象后：状态命中状态分支→包成属性引用；计算属性命中计算分支→新建委托计算属性；方法既无特征标记也非引用→丢弃。输出——只含「状态引用 + 计算属性引用」的对象。之后若热更新把该计算属性整体换掉，旧的引用再读取仍得到新值——因为它每次都回访活 store 的同名属性。

> 以上钩子供 Writer 写「动机→核心思想→心智模型→关键权衡→原理演示」；下面事实部分供核对，不要被 Writer 当目录照抄。

## 概念要点

- 入口先取「裸对象」作为遍历源，这是全部分类的前提（代理读取会解包引用/计算属性，无法分辨类型）。源码位置: packages/pinia/src/storeToRefs.ts:90
- 遍历裸对象的每个键，读取的是「裸值」（即引用/计算属性对象本身，而非解包后的值）。源码位置: packages/pinia/src/storeToRefs.ts:93-94
- 计算属性判定靠「该值是否带 `effect` 字段」——计算属性实现内部带此字段；可选链 `value?.effect` 同时让 null/undefined 不崩溃。注释指出 Vue 当时无公共 `isComputed`（附 vuejs/core PR 链接）。源码位置: packages/pinia/src/storeToRefs.ts:95-97
- 计算分支：不返还原计算属性，而是新建一个 get/set 都委托给 `store[key]` 的包装计算属性（可写）。源码位置: packages/pinia/src/storeToRefs.ts:99-106
- 状态判定：`isRef(value) || isReactive(value)`，用 `toRef(store, key)` 生成指向活 store 同名属性的属性引用。源码位置: packages/pinia/src/storeToRefs.ts:107-112
- **判定顺序不可换**：计算分支必须先于状态分支——因为计算属性也是一种引用，先判 isRef 会把 getter 误归为状态。源码位置: packages/pinia/src/storeToRefs.ts:97 与 :107 的先后次序
- 方法/普通值/null 落空两个分支被静默忽略（optional chaining 兜底防 null 崩）。源码位置: packages/pinia/src/storeToRefs.ts:97,107
- **上游装配契约**：store 装配时不仅 `assign(store, ...)`，还额外 `assign(toRaw(store), setupStore)`，把真实的引用/计算属性写回裸对象——这正是本函数能从裸对象读到原始类型的根因；注释明示「为让 storeToRefs 配合 reactive() 工作」并标注 issue #799。源码位置: packages/pinia/src/store.ts:576-578
- **设计意图（注释直接佐证）**：用「回访 store 的计算属性」而非「带 setter 的直接计算属性」，目的是「能随处创建、不把计算属性生命周期绑定到 store 首次创建之处」（该注释挂在 store 的 `$state` 访问器上方，阐述的是同一条原则）。源码位置: packages/pinia/src/store.ts:580-582
- 产物类型 `StoreToRefs`：getter 按 readonly 判定分别映射为只读 `ComputedRef` 或可写 `WritableComputedRef`，state 映射为 `ToRefs`。源码位置: packages/pinia/src/storeToRefs.ts:42-77
- 测试「keep reactivity」直接验证核心权衡：模拟热更新把 `store.double` 替换成新计算属性后，storeToRefs 早先产出的 `double` 引用仍读到新值（因每次回访 `store.double`）。源码位置: packages/pinia/__tests__/storeToRefs.spec.ts:175-191
- 测试「does not trigger getters」：构建引用期间不会触发 getter 求值（读的是裸对象上的计算属性对象本身，未读取其值）。源码位置: packages/pinia/__tests__/storeToRefs.spec.ts:193-204
- 测试「preserve setters in getters」：委托计算属性的 set 写回 `store[key]`，能驱动可写 getter 更新底层状态。源码位置: packages/pinia/__tests__/storeToRefs.spec.ts:156-173
- 测试「does not crash on a non-reactive null value」：非响应式 null 被跳过、响应式字段保留。源码位置: packages/pinia/__tests__/storeToRefs.spec.ts:206-222
- 诊断兜底：插件返回的非响应式属性会被本函数忽略，dev 下触发 PINIA_R1006，提示用 ref/reactive/markRaw 表达意图。源码位置: packages/pinia/src/diagnostics.ts:40-41

## 关键调用链

storeToRefs(store) → toRaw(store) 取裸对象 → for each key 读取 rawStore[key] → 按型分流：
  · 计算（value?.effect）→ computed({ get: () => store[key], set(v){ store[key]=v } })
  · 状态（isRef||isReactive）→ toRef(store, key)
  · 其余 → 丢弃
→ 返回只含状态引用 + 计算属性引用的对象

上游契约：createSetupStore 装配时执行 `assign(toRaw(store), setupStore)`，保证裸对象持有真实引用/计算属性，是本函数分类得以成立的输入前提。
源码位置: packages/pinia/src/storeToRefs.ts:90-116；装配端 packages/pinia/src/store.ts:576-578

## 源码摘录（带行号，全文累计 ≤ 30 行）

核心实现（分类 + 按型重建）：

```ts
// storeToRefs.ts:90-113
const rawStore = toRaw(store)
const refs = {} as StoreToRefs<SS>
for (const key in rawStore) {
  const value = rawStore[key]
  // There is no native method to check for a computed
  if (value?.effect) {
    refs[key] = computed({
      get: () => store[key],
      set(value) { store[key] = value },
    })
  } else if (isRef(value) || isReactive(value)) {
    refs[key] = toRef(store, key)
  }
}
return refs
```

装配端契约与设计意图注释（为何裸对象能读到原始类型 / 为何要回访 store）：

```ts
// store.ts:575-582
assign(store, setupStore)
// allows retrieving reactive objects with `storeToRefs()`. Must be called after assigning to the reactive object.
// Make `storeToRefs()` work with `reactive()` #799
assign(toRaw(store), setupStore)
// use this instead of a computed with setter to be able to create it anywhere
// without linking the computed lifespan to wherever the store is first created.
```

## 易混淆 / 边界 / 推断

- 事实：判定计算属性用 `value?.effect` 这一内部字段，而非公共 API；而 store 装配文件中其实已使用 Vue 的 `isComputed`（store.ts:557）。两处不一致。
- 推断（标注为推断）：本文件沿用 `effect` 判定而非迁移到 `isComputed`，是历史遗留——storeToRefs 写于 `isComputed` 尚不存在之时（其注释与所附 PR 均指向「当时无公共判定方法」）。
- 推断：`toRaw` 之所以是分类的必要前提，是依据 Vue 响应式代理「会自动解包引用/计算属性」的语义推断——源码未在此处显式说明此动机，但「读裸值」与「装配端写回裸对象」两处事实共同支撑该结论。
- 推断：计算属性「重包成委托 store 的可写计算属性」而非直接返还原对象，主因是解耦生命周期/扛热更新——由 store.ts:580-582 注释与 keep reactivity 测试共同佐证（本函数源码内未写明此动机）。
- 边界：`value?.effect` 依赖 Vue 计算属性的内部实现细节；若未来 Vue 变更该字段，此处判定将失效（已有 `isComputed` 可作更稳健替代）。
- 未理解：无重大未解项。
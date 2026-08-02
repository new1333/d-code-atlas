# storeToRefs：从 reactive store 解构出 refs · 源码精读

## 给 Writer 的教学钩子（必填，8 子项缺一不可）

- **用户痛点 / 场景**：用户用 Pinia 拿到一个 store 后想「拍平」成多个 ref 直接在 setup/computed 里解构使用。直接用 Vue 的 `toRefs(store)` 看起来能工作，但解构出来的「getter」会变成普通对象引用——读到的不再是「按需重算」的值，而是 `toRefs` 调用那一刻的快照；同时 actions（函数）也会被无意义地包成 `Ref<function>`，类型和心智都对不上。换言之：**store 不只是一个 reactive 对象**，它内部混着「真 state（ref/reactive）」「getter（computed）」「action（普通函数）」三种性质完全不同的字段，朴素 `toRefs` 不区分它们。

- **一句话核心思想**：先剥掉 reactive 外壳拿到底层原始字段，再按「这是不是一个 computed」「这是不是一个 ref/reactive」**三路分发**，分别重新打包成正确的 ref 形态——同时**故意丢弃函数与非响应式原始值**。

- **设计动机（为什么需要它）**：Pinia 的 store 是 `reactive(partialStore)`，里面同时塞了 state（ref/reactive）、getter（computed）和 action（function）。Vue 的响应式代理在做 `get` 时会**自动解包 ref**，导致你从代理上读到的「state」是裸值，读到的「getter」是 computed 的求值结果而不是 computed 对象本身——这正是不能用 `isRef(store[key])` 检测的根因。Pinia 需要一个**懂这套语义**的解构器：它要绕开代理、还原字段真实身份、并对 computed 做特殊处理（保留 laziness、可写性、HMR 之后的存活能力）。

- **关键权衡（本 Atlas 的核心）**：
  - **绕过 reactive 代理读 raw store → 换来对字段真实身份的判断能力（识别 computed/ref/reactive）→ 代价**：每条字段必须以 `toRaw(store)` 为读起点，不能复用代理给的现成 track；以及 `value?.effect` 这种**鸭子类型**依赖 Vue `ComputedRefImpl` 的内部结构（注释里挂的 vuejs/core#4165 是 Vue 一直没合并 `isComputed` 的历史遗留）。
  - **computed 检测放在 `isRef` 之前 → 换来对「computed 也是 ref」这一Vue 设计的正确分流 → 代价**：调用方必须理解三路分发的优先级，不能简单按 Vue 文档照搬。
  - **computed 用 `computed({get, set})` 重新包一层而不是直接返回原对象 → 换来 HMR（热替换 `store[key]`）后解构出来的旧 ref 仍指向新 computed、以及「写回经过代理」让 setter 透传 → 代价**：每个 getter 多一层 computed 嵌套（多一次 effect 串联），且依赖 Vue computed 的依赖追踪正确把外层标记为 dirty。
  - **跳过函数 / null / 原始值 → 换来「解构结果只含响应式数据」的干净 API（actions 该用 `store.method()` 调用）→ 代价**：用户在解构后拿不到 action，必须保留 store 引用——但这是**特性**而非缺陷，符合 Pinia 文档的推荐用法。
  - **类型层面把 getters/state/customStateProperties 拆成三段不同的 ref 形态（ComputedRef vs ToRef vs WritableComputedRef）→ 换来「写 getter 时 `refs.double.value = 4` 类型合法、读 state 时类型正确」的强保证 → 代价**：靠 `_IsReadonly` + `_IfEquals` 的双变/协变技巧（条件类型 bivariance hack）探测 readonly，类型体操不直观。

- **最小心智模型（3～7 步）**：
  1. 接到一个 `reactive(store)` 代理对象，先 `toRaw` 剥成原始字段表。
  2. 对原始字段表做 `for...in` 遍历，对每个 key 取出**未经代理解包**的 value。
  3. 第 1 路：`value?.effect` 命中 → 这是 computed getter（鸭子类型）。
  4. 对 computed getter **不直接复用**，而是再包一个 `computed({ get: () => store[key], set: v => store[key] = v })`，把读写重新经 reactive 代理转发。
  5. 第 2 路：否则若 `isRef(value) || isReactive(value)` → 这是 state 字段，用 `toRef(store, key)` 生成一个指向代理属性的可写 ref。
  6. 第 3 路（隐式）：函数、null、原始值 → 跳过，不出现在结果对象里。
  7. 把每个分支产物挂到 `refs[key]`，遍历完返回。

- **最小原理演示（替代旧"复刻范围"）**：
  - **应演示**：一个几十行的脚本，构造一个同时含 `ref`、`computed`、`function`、`null` 的「假 store」（reactive 包裹 plain object），再实现一个迷你 `storeToRefs`：①对 `toRaw(store)` 遍历；②`value?.effect` 走 computed 重打包分支；③`isRef||isReactive` 走 `toRef`；④其它跳过。然后**对比**朴素 `toRefs(store)` 的输出：朴素版会把 computed 当成普通 ref（实际拿到的是被代理解包后的快照值）、把 function 也包成 `Ref<function>`。重点演**两条权衡**：computed 重打包对 HMR 的存活（运行时替换 `store.x = computed(...)` 后，解构 ref 仍能看到新值）；以及「跳过函数」带来的干净解构面。
  - **应故意省略**：完整 TS 类型推导（`_ToComputedRefs`/`_IsReadonly` 那一套，理解原理用不上）、对 plugin 注入字段的特殊路径（自然走通第 2 路）、readonly getter 的类型分支、对 `for...in` 含继承链的边角讨论、SSR/devtools 集成。
  - **演示载体建议（Writer 据此执行）**：本仓库主语言是 TS，建议写成一个**可直接 `bun run`/`tsx`/`node` 跑**的独立 `.ts` 脚本（非硬要求能跑，但跑通能验证）；不必引 vue，可手撸一个 30 行的迷你响应式（含 ref/computed/reactive/toRaw/toRef 鸭子实现）来演**机制**——但这会让重心偏离 storeToRefs 本身。**推荐**：直接 `import { ref, computed, reactive, toRaw, toRef, isRef, isReactive } from 'vue'`，把演示聚焦在「`value?.effect` 鸭子类型识别 + 三路分发 + computed 重打包」上，配上 `console.log` 显示每路产物，最后用一个 HMR 替换场景演示权衡 3 的可观察效果。

- **正文不宜展开的细节**：
  - 类型层的 `_IfEquals`/`_IsReadonly`/`_ToComputedRefs`/`_ToStateRefs`/`StoreToRefs` 全套推导（懂原理用不上，留给 API 参考侧栏）。
  - `for...in` 对继承属性的处理（实际 store 没有继承链可枚举，行为等价 `Object.keys`）。
  - plugin 注入的 ref 怎么进入 store（属于 plugin-system 章节，这里只需要说「自然走通第 2 路」即可）。
  - devtools/HMR 与 storeToRefs 的间接关系（storeToRefs 只是被 HMR 受益，不在本章展开 HMR 本身）。
  - 类型导出 `StoreToRefs<SS>` 为什么写一个看似无用的 `SS extends unknown ? ... : never`（注释里有「distributive conditional」原因，是 TS 高级技巧，不展开）。

- **推荐的一个执行轨迹例子**：
  输入：一个 setup store，setup 返回 `{ count: ref(0), double: computed(() => count.value * 2), inc() { this.count++ }, nullable: null }`，外层被 `reactive()` 包裹成 `store` 代理。
  关键中间态：`toRaw(store)` 拿到原始字段表，其中 `count` 仍是 `RefImpl`、`double` 仍是 `ComputedRefImpl`（带 `effect`）、`inc` 是 `Function`、`nullable` 是 `null`。三路分流后：`double` 被 re-wrap 成新 computed（get 转发到 `store.double`）、`count` 经 `toRef(store,'count')` 变成可写代理 ref、`inc` 与 `nullable` 被丢。
  输出：`{ count: ToRef<number>, double: WritableComputedRef<number> }`——函数与 null 不在结果里；外部读 `double.value` 触发原 computed 的 lazy 求值；写 `double.value = 4` 经代理转发到原 computed 的 set。

> 以上钩子供 Writer 写「动机→核心思想→心智模型→关键权衡→原理演示」；下面事实部分供核对，不要被 Writer 当目录照抄。

## 概念要点

- **入口签名**：`storeToRefs<SS extends StoreGeneric>(store: SS): StoreToRefs<SS>`——单参数、单返回对象，泛型只在编译期起作用，运行时逻辑零依赖类型。源码位置: packages/pinia/src/storeToRefs.ts:87-89

- **第一句话就 `toRaw`**：`const rawStore = toRaw(store)`。这是后面所有判断能成立的前提：reactive 代理在 `get` 时会解包 ref（参见 Vue 设计），从代理上读 `store.count` 拿到的是裸 `0` 而非 `RefImpl`，`store.double` 拿到的是 computed 的求值结果而非 `ComputedRefImpl`。只有走 raw 才能保留字段身份。源码位置: packages/pinia/src/storeToRefs.ts:90

- **遍历用 `for...in` 而非 `Object.keys`**：会枚举到原型链上的可枚举属性（实际 store 没有这种，行为基本等价 `Object.keys`）。对 setup store，setup 返回的字段会被同时 assign 到 `reactive(partialStore)` 与 `toRaw(store)` 上（属 setup-store-builder 章节细节），这里只是消费方。源码位置: packages/pinia/src/storeToRefs.ts:93

- **computed 鸭子类型**：`if (value?.effect)`。Vue 的 `ComputedRefImpl` 实例上有一个 `effect` 字段（即驱动它重算的 `ReactiveEffect`），普通 `RefImpl` 没有该字段。注释挂的 PR `vuejs/core#4165` 是「为 Vue 增加 `isComputed`」的提案，长期未合并，因此 Pinia 用鸭子类型兜底。可选链 `value?.` 同时承担了「value 为 null/undefined 时短路」的作用——测试 "does not crash on a non-reactive null value" 验证了这一点。源码位置: packages/pinia/src/storeToRefs.ts:96-97

- **computed 重打包而非透传**：`computed({ get: () => store[key], set(value) { store[key] = value } })`。注意 get/set 引用的是**外层代理 `store`**而不是 `rawStore`——这样读写都会经过响应式代理的 track/trigger，并且**当 HMR 把 `store[key]` 替换成新 computed 时**，外层包装的 get 会重新读到新对象（参见测试 "keep reactivity"）。源码位置: packages/pinia/src/storeToRefs.ts:99-106

- **state 分支用 `toRef(store, key)` 而非 `toRef(value)`**：`toRef` 第二种重载（`toRef(object, key)`）生成一个 `ObjectRefImpl`/`PropertyRefImpl`，它的 `.value` get/set 委托到 `object[key]`——这意味着即便 setup store 的 state 是个 `ref`，包装后的 ref 也始终经代理访问，HMR/`$patch` 等改动会被反映。若用 `toRef(value)`（即直接对 ref 调用），会拿到原 ref 自身，丢失经代理的统一路径。源码位置: packages/pinia/src/storeToRefs.ts:107-112

- **判断顺序不能换**：必须先 `value?.effect` 再 `isRef/isReactive`。Vue 的 `ComputedRefImpl` 同样实现了 ref 协议（`__v_isRef = true`），先做 `isRef` 会把所有 getter 错误地归入 state 分支，丢失 laziness 与 setter 透传。源码位置: packages/pinia/src/storeToRefs.ts:97,107

- **隐式跳过分支**：函数（actions）、null/undefined、原始值（数字/字符串/布尔）、`markRaw` 标记的对象——既无 `effect`、也不是 ref/reactive——统统不进 `refs`。这就是文档承诺「methods and non reactive properties are completely ignored」的实现。测试 "does not crash on a non-reactive null value" 与 "contain plugin states"（其中 `shared: 10` 这种 plugin 加的非响应字段不会出现在结果里）共同验证。源码位置: packages/pinia/src/storeToRefs.ts:93-113

- **plugin 注入的 ref 自然走通**：plugin 通过 `_p.push(() => ({ pluginN: ref(20) }))` 注入的字段会被 assign 到 store（参见 plugin-system 章节），在 `for...in rawStore` 时被枚举到，落入 `isRef` 分支，等价 state。无需专门分支。源码位置: packages/pinia/src/storeToRefs.ts:107-112

- **类型层三段拼接**：`StoreToRefs<SS> = _ToStateRefs<SS> & ToRefs<PiniaCustomStateProperties<StoreState<SS>>> & _ToComputedRefs<StoreGetters<SS>>`——把 state、自定义 state 属性、getters 三段分别映射到不同的 ref 形态。运行时返回的对象**不区分这三段**，是同一个 plain object；类型层的拆分只是为了让 setter/readonliness 表达到 TS 类型上。源码位置: packages/pinia/src/storeToRefs.ts:70-77

- **`_IsReadonly` 决定 getter 类型是 `ComputedRef` 还是 `WritableComputedRef`**：通过 `_IfEquals<{[P in K]: T[P]}, {-readonly [P in K]: T[P]}>` 的协变/双变条件类型技巧，如果去掉 readonly 后类型不变，说明原本不是 readonly → 是 `WritableComputedRef`；反之 → `ComputedRef`。这套技巧对应测试 "preserve setters in getters" 的运行时行为。源码位置: packages/pinia/src/storeToRefs.ts:26-46

- **文档注释里的关键句**：「Similar to `toRefs()` but specifically designed for Pinia stores so methods and non reactive properties are completely ignored.」——这一句同时是用户契约和实现指南。源码位置: packages/pinia/src/storeToRefs.ts:79-86

## 关键调用链

`storeToRefs(store)`
  → `toRaw(store)` 拿原始字段表
  → `for (key in rawStore)` 遍历每个字段
    → 取 `value = rawStore[key]`（**未经代理解包**）
    → 分支 A：`value?.effect` truthy
        → `computed({ get: () => store[key], set(v) { store[key] = v } })` 重打包
    → 分支 B：`isRef(value) || isReactive(value)`
        → `toRef(store, key)` 生成代理式 ref
    → 分支 C（隐式）：跳过
  → 返回 `refs`

源码位置: packages/pinia/src/storeToRefs.ts:87-116

## 源码摘录（带行号，全文累计 ≤ 30 行）

核心实现（功能主体，刻意保留所有注释以体现设计意图）：

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

源码位置: packages/pinia/src/storeToRefs.ts:87-116

## 易混淆 / 边界 / 推断

- **事实**：分支判断的顺序（`value?.effect` 优先于 `isRef/isReactive`）是不可调换的——computed 同时满足 `isRef`，会被错分。
- **事实**：computed 分支的 get/set 引用的是外层 `store` 代理而非 `rawStore`，因此对 HMR `$patch` `devtools` 路径透明。
- **事实**：`for...in rawStore` 不显式过滤 `$patch/$reset/$id/$state` 等 store 内置成员；它们要么不可枚举（`$state` 由 `Object.defineProperty` 默认 non-enumerable），要么是函数（`$patch` 落入隐式跳过分支），要么是原始值（`$id` 字符串落入跳过分支）。源码没有显式 allowlist/denylist，是隐式收敛。
- **推断（标注为推断）**：把 computed 重打包而不是直接返回，主要是为 HMR 友好（参见测试 "keep reactivity"）和「写经代理」一致性——而不是性能或类型原因；源码注释未直说，但测试名与行为强烈指向这个动机。
- **推断（标注为推断）**：`value?.effect` 这种「碰内部字段」的写法是 Vue 缺 `isComputed` 公开 API 的临时解法；若 vuejs/core#4165 合并，这里可改成 `isComputed(value)`。当前实现绑定了 Vue ComputedRefImpl 的字段名 `effect`，Vue 大版本升级若改名会破坏此处——这是隐藏耦合点。
- **事实**：plugin 注入的 ref（如 `pluginN: ref(20)`）会自然进入 `isRef` 分支被收为 state；plugin 注入的非响应字段（如 `shared: 10`）被隐式丢弃——这两个行为测试 "contain plugin states" 都有覆盖。
- **未理解**：`_ToStateRefs<SS>` 中那段 `UnwrappedState extends _UnwrapAll<Pick<infer State, infer Key>>` 的条件类型分支——它似乎在区分「setup store（state 推断自 ref）」与「options store（state 来自声明）」，但具体到 TS 推断细节我没有逐字验证；属类型层面，不影响运行时原理。
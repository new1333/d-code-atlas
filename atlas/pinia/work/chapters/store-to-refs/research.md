# storeToRefs：从 reactive store 定向提取 ref · 源码精读

## 给 Writer 的教学钩子（必填，8 子项缺一不可）

- **用户痛点 / 场景**：使用者拿到一个 store 后，想在组合式函数里像普通变量一样**解构**着用（`const { count, double } = store`）。可 store 是个响应式代理对象，直接解构会丢掉响应性；而如果套用框架原生的「把对象拆成一堆 ref」的工具，它又会把里面那些**本来是函数的方法**也错误地包成 ref——调用时还得先 `.value`，并且无法区分「状态」和「派生值」。使用者因此陷入两难：不解构不方便，解构了要么丢响应性、要么方法被破坏。

- **一句话核心思想**：**绕过代理拿原始存储，再按每个值「长得像什么」分类重组——只挑状态与派生值，丢掉方法。**

- **设计动机（为什么需要它）**：这个机制是为了解决「store 被故意做成了一个大杂烩响应式对象」与「使用者只想把其中的**数据**拆出来解构」之间的矛盾。它换来的能力是：使用者可以放心地解构 store 的状态和派生值且保持响应式，同时方法不会被误提取。其中「承前」部分是——**（已在第 4 章『Store 装配：effectScope 托管的返回值分类与状态镜像』讲透 store 为何被做成「响应式代理包裹的三类返回值混合对象」、以及状态如何镜像进根状态树，本章只看它的新侧面：既然 store 被装配成了这种形态，从它上面定向拆出可解构 ref 时该如何分类）**，供 Writer 做跨章去重，不要在本章重演装配细节。

- **关键权衡（本 Atlas 的核心）**：
  1. **放弃原生 toRefs，改写定向遍历** → 做了「自己遍历原始存储并按值类型分流」的选择 → 换来了能精确跳过方法函数、只提取状态与派生值且不破坏响应性的能力 → 代价是必须自己维护一套与「装配时分类」完全对称的运行时判别逻辑，且装配端必须额外配合做一次「把原始响应式源也写回原始对象」的赋值，提取器才拿得到干净的源。
  2. **用一个内部标记字段去识别派生值（computed）** → 做了「不依赖框架公开 API、直接探测 computed 对象身上的一个内部字段」的选择 → 换来了在「框架没有公开方法判定一个值是不是 computed」的前提下仍能把它和普通状态 ref 区分开 → 代价是耦合了框架的内部实现细节，一旦该字段改名或改结构就会失效，是一个已知的脆弱点（源码注释里挂了框架侧的改进 issue 链接）。
  3. **派生值不直接复用 store 内部那个 computed，而是重新包一层代理** → 做了「对每个 computed 用『读写都代理回 store 同名属性』的方式重新构造」的选择 → 换来了所有提取出的 ref 统一遵循「代理回 store」的生命周期模型、与状态分支的处理对称，且不与 store 内部 effect 的惰性求值状态绑定 → 代价是多一层间接；运行时一律给出可写入口，与类型层对只读派生值标注的「只读」存在不对称（类型说只读、运行时仍接受 set 调用，由底层决定是否真正生效）。
  4. **装配端为提取器额外做一次「写回原始对象」的赋值** → 做了「在把返回值挂到响应式代理之后，再原样挂一份到原始对象上」的选择 → 换来了提取器遍历原始对象时能拿到**未经代理转换**的原始状态 ref 与 computed → 代价是装配路径上多一次全量赋值，且其必要性依赖「响应式代理在写入时会改写底层存储形态」这一隐式行为（是一次针对历史 bug 的专门补丁，源码注释挂了对应 issue 编号）。

- **最小心智模型（3～7 步）**：
  1. store 在装配阶段被做成一个响应式代理对象，里面混着三类属性：状态（ref 或 reactive）、派生值（computed）、方法（普通函数）。
  2. 使用者想把它的数据解构出来用，且解构后仍响应式。
  3. 直接用框架原生 toRefs 行不通：它无法区分这三类，会把方法也包成 ref。
  4. 提取器改为先取 store 的原始对象（绕过代理），逐个 key 遍历。
  5. 对每个值按「运行时特征」分流：身上带内部标记的 → 是派生值，重包成「代理回 store」的可写 computed；是 ref 或 reactive 的 → 是状态，用 toRef 绑回 store；其余（方法、纯对象等）→ 直接跳过。
  6. 返回由「状态 ref + 派生值 computed ref」组成的对象，解构后各项保持响应式，方法不在其中。

- **最小原理演示（替代旧"复刻范围"）**：
  - 应演示：一个**小到只表达「为何原生 toRefs 会出错 + 定向提取如何分流」**的从零实现（约二三十行）。先用响应式 API 拼出一个迷你 store（一个状态 ref、一个 computed 派生值、一个方法函数，全塞进一个 reactive）；接着演示反例——对它直接 toRefs，打印出「方法被包成了 ref（成了 object，调用要 .value）」；再演示正解——手写提取器：取原始对象、遍历、按特征三分（computed 重包、state 用 toRef、函数跳过），最后解构验证状态改了派生值仍响应、且方法没有被提取。**这段演示演的是权衡 1（放弃 toRefs 改定向遍历）与权衡 3（computed 重包代理）这两条原理。**
  - 应故意省略：完整的 TypeScript 类型推导（StoreToRefs 条件类型那一大块）、插件注入属性的兼容、HMR/devtools 相关分支、只读与可写在类型层的区分——这些是工程完整度，与「演透定向提取原理」无关。
  - **演示载体建议**：本章仓库主语言是 TypeScript/JavaScript、机制是**纯运行时对象分类**、依赖只有 Vue 的几个响应式原语——建议写成一段能 `bun run`/`node`（装 vue 依赖）直接跑的脚本，能跑最好但非硬要求；用真实 Vue API（reactive/computed/ref/toRef/toRaw/isRef/isReactive）拼迷你 store，让「方法被包成 ref」的反例和「定向提取」的正解都能用 console.log 实际看到，演透「分类」这个核心思想。一句话原则：**载体服务于「演透分类原理」，不是服务于「复刻完整 storeToRefs」。**

- **正文不宜展开的细节**：返回类型的条件类型推导（StoreToRefs 拆成「state refs ∩ 插件自定义 state ∩ getter computed refs」、_ToComputedRefs 用 _IsReadonly 区分只读/可写、_ToStateRefs 区分 option store 与 setup store）——属类型体操，正文点到「类型上把返回三等分」即可，不要展开推导过程；运行时只读 getter 的 set 实际不生效这一边界；`@ts-expect-error` 的存在原因（类型与运行时的不可调和）。

- **推荐的一个执行轨迹例子**：
  - 输入：一个装配好的 store，原始对象形如 `{ count: Ref(1), double: ComputedRef(2), increment: Function }`。
  - 关键中间态：提取器取原始对象 → 遍历 count（无内部标记、是 ref）→ toRef 绑回 store；遍历 double（带 computed 内部标记）→ 重包成代理 store 的可写 computed；遍历 increment（无标记、非 ref/reactive）→ 落入空区跳过。
  - 输出：`{ count: 可读写 Ref, double: 可写 ComputedRef }`，解构后改 count 会触发 double 重算，increment 不在结果里。

> 以上钩子供 Writer 写「动机→核心思想→心智模型→关键权衡→原理演示」；下面事实部分供核对，不要被 Writer 当目录照抄。

## 概念要点
- storeToRefs 用 `toRaw(store)` 取原始对象再做 `for...in` 遍历，避免直接在响应式代理上遍历触发依赖收集、也为了拿到未经代理转换的原始值。源码位置: packages/pinia/src/storeToRefs.ts:90,93
- 「判定一个值是不是 computed」没有框架公开 API，源码注释挂了 vue-core PR #4165；实际用 `value?.effect` 这个内部字段探测（ComputedRefImpl 身上有 effect）。源码位置: packages/pinia/src/storeToRefs.ts:95-97
- computed 分支不直接复用 store 内部那个 computed，而是重包成「读写都代理回 `store[key]`」的可写 computed。源码位置: packages/pinia/src/storeToRefs.ts:99-106
- state 分支用 `toRef(store, key)`（命中条件 `isRef(value) || isReactive(value)`）。源码位置: packages/pinia/src/storeToRefs.ts:107-112
- 方法函数与非响应式属性既无 `.effect`、也不是 ref/reactive，不落入任何分支，被静默跳过——这正是「跳过 action」的实现方式（没有显式 else）。源码位置: packages/pinia/src/storeToRefs.ts:93-113
- store 本身被 `reactive(...)` 包裹创建，是个响应式代理对象。源码位置: packages/pinia/src/store.ts:478-490
- 装配阶段有一套与提取器**对称**的分类判据：store.ts 内部 `isComputed(o) = !!(isRef(o) && o.effect)`；装配循环里 `isRef(prop) && !isComputed(prop) || isReactive(prop)` 归为 state、`typeof prop === 'function'` 归为 action、`isComputed(prop)` 归为 getter。源码位置: packages/pinia/src/store.ts:144-147, 508-570
- **关键铺路**：装配端在 `assign(store, setupStore)`（挂到代理）之后，必须再 `assign(toRaw(store), setupStore)`（挂到原始对象），注释明确写明这是「为了让 storeToRefs 能工作」、并挂了 issue #799。源码位置: packages/pinia/src/store.ts:575-578
- storeToRefs **不读取任何登记表**（如 `_customProperties`），纯靠运行时值类型判别分类；因此插件注入的 ref 会被当作状态一并提取，无法与用户状态区分。源码位置: packages/pinia/src/storeToRefs.ts:93-113（全文无登记表引用）；插件扩展挂入 store 见 packages/pinia/src/store.ts:753

## 关键调用链
装配（承前章）: setup() 返回 {state refs, computed getters, action fns} → createSetupStore 遍历分类（isComputed/isRef/isReactive/typeof function）→ assign(store, setupStore) → assign(toRaw(store), setupStore)【为提取器铺路】→ reactive store 完成
本章: storeToRefs(store) → toRaw(store) → for key in rawStore → { 有 .effect → 重包 computed ; isRef||isReactive → toRef(store,key) ; 其余跳过 } → 返回 refs
源码位置: packages/pinia/src/store.ts:500-578；packages/pinia/src/storeToRefs.ts:90-115

## 源码摘录（带行号，全文累计 ≤ 30 行）
提取器核心分类循环（演「定向分流 + computed 重包」）：
```ts
// packages/pinia/src/storeToRefs.ts:90-113
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
} // action / 非响应式：无 else，被跳过
```

装配端为提取器铺路的第二次 assign（演权衡 4）：
```ts
// packages/pinia/src/store.ts:575-578
assign(store, setupStore)
// allows retrieving reactive objects with `storeToRefs()`. Must be called after assigning to the reactive object.
// Make `storeToRefs()` work with `reactive()` #799
assign(toRaw(store), setupStore)
```

装配端对称的 isComputed 判据（演权衡 2 的另一处复用）：
```ts
// packages/pinia/src/store.ts:144-147
function isComputed(o: any): o is ComputedRef {
  return !!(isRef(o) && (o as any).effect)
}
```

## 易混淆 / 边界 / 推断
- 事实：运行时所有 getter 都被重包成**可写** computed（get/set 都代理到 store[key]）；但类型层 `_ToComputedRefs` 用 `_IsReadonly` 区分输出 `ComputedRef`（只读）与 `WritableComputedRef`（可写）。运行时与类型存在不对称：对真正只读的源 getter，set 调用最终走 `store[key] = value`，由底层 computed 决定是否接受（只读 computed 在 dev 下 warn 且不生效）。源码位置: packages/pinia/src/storeToRefs.ts:99-106 与 :42-46
- 推断（依据源码注释挂的 issue #799）：第二次 `assign(toRaw(store), setupStore)` 是为了绕过响应式代理在写入时对 ref/computed 存储形态的改写，让原始对象直接持有未被转换的响应式源；该 issue 对应的具体框架版本行为差异未在源码内展开，故标注为推断。源码位置: packages/pinia/src/store.ts:576-578
- 推断（源码无显式动机注释）：computed 分支不直接复用 store 内部那个 computed 对象、而是重包成代理 store[key] 的新 computed，动机推测为「统一所有提取项都代理回 store 的生命周期模型、与 state 分支的 toRef(store,key) 对称，并避免与 store 内部 effect 的惰性求值状态耦合」——属推断。
- 事实：storeToRefs 全文不引用 `_customProperties` 或任何插件登记表，纯靠值类型判别；插件注入的 ref 与用户状态 ref 走同一分支、无法区分。源码位置: packages/pinia/src/storeToRefs.ts:1-116
- 边界：`value?.effect` 对非对象值（如 number）安全返回 undefined 而落入跳过；理论上若 store 上存在某个「带 effect 字段但非 computed」的对象会被误判为 getter——实际 Pinia store 上不存在此类对象，属理论边界。
- 未理解：无。
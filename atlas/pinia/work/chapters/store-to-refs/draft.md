# storeToRefs：从 reactive store 定向提取 ref

> 本章属于 composite 层。前置：Store 装配。
> 学完你能讲清：为什么从 store 拆出可解构 ref 必须自己写一套定向提取，而不能套用框架原生 toRefs；这套提取器做了哪些跟装配对称的判别取舍。

## 1. 为什么需要它（设计动机）

上一章把 Options Store 和 Setup Store 两种作者语法统一进了同一条装配路径，那条路径的终点是一个 `reactive()` 包裹的混合对象——里面同时住着状态、派生值和方法。本章就接着这个混合对象讲：使用者拿到它之后，怎么把里面的数据拆出来当普通变量用。

最常见的写法是解构。可 store 是个响应式代理，直接 `const { count, double } = store` 会丢掉响应性——解出来的只是当时的值，count 改了，模板里那个 `count` 不会跟着动。这是 Vue 响应式的常识：解构代理对象等于把里面的值复制一份拿走，跟原来的代理断开了。

那不解构、整个 store 拿来用呢？多数场景没问题，但写组合式函数时会嫌啰嗦——本来想 `count`、`double` 几个短名字轮流用，现在每次都得 `store.count`、`store.double`，模板里也是。

Vue 给普通 reactive 对象准备了一个工具叫 `toRefs`：把对象上每个属性都包成一个 ref，解构后这些 ref 还连着原对象。可惜它对 store 不顶用。store 不是「只有状态的普通 reactive」，它是三类返回值混在一起：状态是 ref、派生值是 computed、方法是普通函数。`toRefs` 不分青红皂白全包成 ref，方法也被包了。这下你写 `increment()` 不行了，得 `increment.value()`，原本一个函数变成了「一个里面装着函数的盒子」。更要命的是，`toRefs` 也不告诉你哪个 ref 是状态、哪个是派生值——它们看起来都一样。

使用者就这么被卡在两难：不解构嫌啰嗦，直接解构丢响应性，套原生工具又把方法搞坏了。`storeToRefs` 就是为这个矛盾而生。

## 2. 核心思想

**绕过代理拿原始存储，再按每个值「长得像什么」分类重组——只挑状态与派生值，丢掉方法。**

`toRefs` 出问题不是因为它包错了，而是它根本不知道 store 上有哪些类别——它假设输入是个「只有普通属性」的 reactive。`storeToRefs` 把分类这件事接管过来：你给我一个 store，我先把它的代理壳脱掉、拿到底下那个原始对象，再一个 key 一个 key 看过去——这块带不带 computed 的内部标记？是 ref 还是 reactive？都不是？那就跳过。

它不是「在 toRefs 上打补丁」，而是干脆绕过 toRefs、自己写一遍遍历，把分类的责任从「框架的通用工具」挪到「Pinia 自己掌握的、跟装配对称的判别逻辑」上。

## 3. 心智模型

回忆一下 store 的内部结构：装配阶段把 setup 返回的三类值挂上去——状态（ref 或 reactive）、派生值（computed）、方法（普通函数），最后整个对象被 `reactive()` 包成代理。同一份返回值还多挂了一次：在原始对象上也 assign 一份（为什么这样做，后面讲）。

提取器干的事很简单：

```
storeToRefs(store)
  → toRaw(store)             # 脱代理壳，拿原始对象
  → for key in rawStore:
      看 rawStore[key] 长得像什么：
        带 .effect 字段    → 派生值（computed），重包成代理回 store 的可写 computed
        isRef / isReactive → 状态，用 toRef(store, key) 绑回代理
        其它（函数、纯值） → 跳过
  → 返回 { 状态 ref, 派生值 computed ref }
```

三个细节值得记住：

- **「带 .effect 字段」是 computed 在运行时的指纹**。Vue 没给公开 API 判定一个值是不是 computed，但每个 computed 内部都带一个 effect 字段——靠它认。
- **派生值不是把 store 内部那个 computed 直接拿出来**，而是新包一层代理 computed，读写都走 `store[key]`。这让所有提取项的生命周期都一致地连回 store。
- **方法不是「显式跳过」的**。它在判别逻辑里压根没有 else 分支：既不带 .effect、也不是 ref/reactive，自然不落进任何桶。

## 4. 关键权衡

### 不复用 toRefs，自己按值类型分流

第一眼看，最自然的实现是 `toRefs(store)` 完事——为什么不呢？

选了不。toRefs 是 Vue 给「只有状态的普通 reactive」准备的通用工具，它对每个属性一视同仁——管你是不是函数，全包成 ref。这在普通场景下没毛病（谁会在 reactive 里放函数），但 store 恰恰是个反例：方法函数就摆在状态和派生值旁边。

换成自己遍历的好处是**分类权握在自己手里**：Pinia 知道 store 上有 state、getter、action 三类，正好可以按运行时特征分流。代价是它必须维护一套判别逻辑、且要和装配阶段的分类**对称**——装配阶段怎么把一个返回值归到 state/getter/action，提取阶段就得按同样的特征把它认出来。两端任何一端改了判据，另一端就得跟着改。这是「拒绝复用、改写自己一套」的典型代价：自由换来了精确，但要永久照看一份私有逻辑。

> 背后的本质矛盾：**通用工具的「不区分」**和**领域对象的「必须区分」**之间的冲突。toRefs 的价值在于对一切 reactive 一视同仁，而 store 的价值恰恰在于它是个被精心分类过的混合物。这套矛盾在任何「领域对象碰到通用工具」的场景里都会冒出来：你能用 `JSON.stringify` 序列化一个 Date 吗？能用 `Object.keys` 列出 Proxy 拦截的全部属性吗？解决方案都是绕开通用工具、写一份懂领域的版本。

### 靠一个内部字段去认 computed

要在分类时把 computed 和普通 ref 区分出来，需要一个判定函数。Vue 公开 API 里有 `isRef`、`isReactive`，可唯独没有 `isComputed`。

选了什么：直接探 computed 内部对象身上的 `effect` 字段（`value?.effect`）。每个 computed 都是一个 `ComputedRefImpl` 实例，身上挂着一个 effect 对象，而普通 ref 没有。这相当于**把手伸进了 Vue 的内部表示**。

换来的是：在没有公开 API 的前提下，仍然能把派生值从普通状态里挑出来——而且这条判据和装配阶段内部用的 `isComputed` 完全一致，两端对称。

代价有两个面。第一是**耦合 Vue 内部细节**：哪天 Vue 把 `effect` 字段改名、改结构，或者把 computed 的实现整个换掉，这里就失效。Vue 那边有一个跟进中的 PR（#4165），目的是给一个公开判定方法——这条脆弱点什么时候合上、Pinia 这边就什么时候能拿掉。第二是**理论上会被骗**：任何「带 effect 字段的对象」都会被认成 computed。实际 Pinia store 上不存在这种对象，所以判据成立，但这是个靠「环境不变」维持的不变量。

> 背后的本质矛盾：**领域代码需要更细的信息**与**框架只公开更粗的 API** 之间的矛盾。这是所有「在框架之上做工具」的人迟早会撞上的：你需要框架知道但没告诉你的东西。两条出路：要么软耦合框架内部表示（这里走的路，依赖一个不变量），要么给框架提 PR 把 API 公开（注释里那条 issue 就是这条路）。这是「抽象层在何处泄漏」的支点问题。

### 派生值重包一层代理，而不是把内部那个 computed 拿出来用

派生值分支的写法很特别——它不直接复用 store 内部那个 computed 对象，而是新创建一个 computed，get/set 都代理回 `store[key]`：

```ts
computed({
  get: () => store[key],
  set(value) { store[key] = value },
})
```

选这样做的好处是**所有提取项的生命周期统一**。状态用 `toRef(store, key)` 绑回代理，派生值用代理 computed 绑回代理，两边对称——都连回 store，store 在它们就在，store 没了它们都跟着失效。如果改成状态走 toRef、派生值直接拿内部 computed，两边的「连接方式」就不一样了，使用者解构后会偶尔遇到「这个 ref 还在、那个 ref 失活了」的诡异场面。

代价是多一层间接（派生值现在多走一次 get 才到底），以及类型层和运行时层**不对称**。类型说有些派生值是只读的（`ComputedRef`）、有些是可写的（`WritableComputedRef`），可运行时一律给出可写入口：只读 getter 的 set 调用最终落到 `store[key] = value`，由底层 computed 决定是不是真的写进去（只读的会在 dev 下 warn、写不进去）。这是个有意保留的不对称——类型上严谨、运行时上「能写就先让写」，把责任推给底层。

> 背后的本质矛盾：**类型层的精度**（只读 vs 可写）与**运行时的简化**（一律代理回去）之间的矛盾。Pinia 选择了运行时简单、类型上较真，把 mismatch 用 `@ts-expect-error` 标出来挂着。这种「类型与运行时各管各的、在边界用 escape hatch 缝合」的处理在大型 TS 项目里非常普遍。

### 装配端为提取器额外做一次写回原始对象

这条权衡不在 storeToRefs 文件里，而是装配末尾给提取器铺的路。装配挂返回值时做了两次 assign：

```ts
assign(store, setupStore)            // 第一次：挂到响应式代理
assign(toRaw(store), setupStore)     // 第二次：挂到原始对象
```

为什么有第二次？因为响应式代理在写入时会把某些值的存储形态改写——一个 ref 挂进代理后，再从原始对象上读，可能读到的不是当初那个 ref 对象本身。提取器走 `toRaw(store)` 拿原始对象、再遍历上面的 key 取值，如果原始对象上挂的是被代理改写过的形态，`isRef`、`value?.effect` 这些判据就会失灵。

选了「再挂一次」的好处是装配端只多一次赋值，提取端就能拿到**未经代理转换的原始响应式源**——ref 还是 ref、computed 还是 computed，判据都成立。代价是这条赋值是个**针对历史 bug 的专门补丁**（对应 issue #799），它依赖一个隐式前提：「响应式代理在写入时会改写底层存储形态」——这是 Vue 实现的细节，如果哪天 Vue 改了写入行为、保留原始对象，这次额外 assign 就成了多余动作（但不会出错）。装配端为此背上了一份「为下游提取器负责」的责任。

> 背后的本质矛盾：**抽象层之间的隐式契约**。下游提取器依赖上游装配产出的对象满足某种形态（原始对象上的值是「未转换的响应式源」），但这个契约没有任何类型签名或文档强制，只靠一行注释和一次额外赋值维持。任何一层（Vue 的响应式实现、Pinia 的装配顺序）单方面改动，另一层就破。这是分层架构里**契约维护成本**的典型形态：层越少、契约越显式；层越多、跨层契约越靠测试和注释兜。

## 5. 最小原理演示

下面用 Vue 的真实响应式 API 拼一个迷你场景，演透「为什么 toRefs 会出错」和「定向提取如何分流」。

```ts
import {
  reactive, ref, computed, toRefs, toRef, toRaw, isRef, isReactive,
} from 'vue'

// 制造一个迷你 store：状态 + 派生值 + 方法，三类混在一起
const count = ref(1)
const double = computed(() => count.value * 2)
function increment() {
  count.value++
}
const store = reactive({ count, double, increment })

// 反例：原生 toRefs 把方法也包成了 ref
const wrong = toRefs(store)
console.log(typeof wrong.increment.value) // 'function'：方法被装进盒子，调用要先 .value
console.log(isRef(wrong.increment))        // true：这不是我们想要的

// 正解：自己写定向提取
function storeToRefs(store: any) {
  const rawStore = toRaw(store) // 脱代理，拿原始存储
  const refs: Record<string, any> = {}
  for (const key in rawStore) {
    const value = rawStore[key]
    if (value?.effect) {
      // 派生值：重包成代理回 store 的可写 computed
      refs[key] = computed({
        get: () => store[key],
        set(v) {
          store[key] = v
        },
      })
    } else if (isRef(value) || isReactive(value)) {
      // 状态：用 toRef 绑回代理
      refs[key] = toRef(store, key)
    }
    // 方法与非响应式属性：没 else，被跳过
  }
  return refs
}

const { count: c, double: d } = storeToRefs(store)
console.log(typeof store.increment) // 'function'：方法在 store 上还在
console.log(c.value, d.value)       // 1, 2

c.value = 10
console.log(d.value)                // 20：状态改了，派生值跟着算
```

把这段存成 `.ts`、装上 vue 直接能跑。输出会清楚告诉你：`toRefs` 把 `increment` 包成了一个 ref，而定向提取把它干净地留在了 store 上、解构出来的只有数据和派生值。

## 6. 执行轨迹

拿一个具体输入走一遍。装配好的 store 内部结构（剥掉代理后的原始对象）形如：

```
rawStore = {
  count:      Ref(1),
  double:     ComputedRef { value: 2, effect: ReactiveEffect },
  increment:  function,
}
```

`storeToRefs(store)` 被调用后的时序：

1. `toRaw(store)` 返回上面那个 `rawStore`，绕过代理。
2. 进入 for 循环，第一个 key 是 `count`：
   - 取 `value = rawStore.count`，是一个 `RefImpl`，身上没有 `effect` 字段。
   - `value?.effect` 为 undefined，跳过派生值分支。
   - `isRef(value)` 为 true，落入状态分支：`refs.count = toRef(store, 'count')`——一个读写都连回 `store.count` 的 ref。
3. 第二个 key 是 `double`：
   - 取 `value = rawStore.double`，是一个 `ComputedRefImpl`，身上有 `effect`。
   - `value?.effect` 为真，落入派生值分支：新建一个 computed，get 读 `store.double`、set 写 `store.double`。
4. 第三个 key 是 `increment`：
   - 取 `value = rawStore.increment`，是一个普通函数。
   - `value?.effect` 为 undefined（函数没有 effect 字段）。
   - `isRef(value)` 和 `isReactive(value)` 都为 false。
   - 两个分支都不命中，**没有 else**——它就这样被静默跳过。
5. 返回 `{ count: ToRef, double: WritableComputedRef }`。

外面解构 `const { count, double } = storeToRefs(store)`：拿到两个 ref，改 `count.value` 会触发 `store.count` 变更、`double` 重算；想用 `increment`？得回 store 上拿，提取器没给它出门的票。

## 7. 教学简化说明

本章演示故意省略了几样东西：完整的 TypeScript 类型推导（`StoreToRefs` 拆成 state refs、插件自定义 state、getter computed refs 三块交集，`_ToComputedRefs` 用 `_IsReadonly` 区分只读/可写那一大块条件类型）；插件注入属性的兼容分支；HMR、devtools 相关代码路径。这些是工程完整度，与「演透定向分类」这个核心思想无关——你想看到的只是「为什么原生 toRefs 行不通、自己写一套分流怎么写」。

## 8. 小结

`storeToRefs` 的全副戏法其实就一句：**脱掉代理、按值类型分流、丢掉不要的**。它存在的根本原因是上游把 store 装配成了一个三类混合的响应式代理——通用 toRefs 处理不了这种混合物，于是 Pinia 写了一份跟装配对称的私有判别逻辑，并让装配端为这次提取额外多 assign 一次。下一章会换一个角度看这个混合对象：插件系统怎么在装配时往里塞新的 state/getter/action，又自动归到 store 的 effectScope 名下。
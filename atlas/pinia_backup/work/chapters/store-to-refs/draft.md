# storeToRefs：从 reactive store 解构出 refs

## 一个让你踩坑的瞬间

你刚写完一个 setup store：

```ts
const useCounter = defineStore('counter', () => {
  const count = ref(0)
  const double = computed(() => count.value * 2)
  function inc() { count.value++ }
  return { count, double, inc }
})
```

在组件里你想拍平成多个 ref 直接用：

```ts
const store = useCounter()
const { count, double, inc } = storeToRefs(store)
```

为什么非得写 `storeToRefs`，而不能直接 `toRefs(store)`？毕竟 store 看起来就是个 reactive 对象。

试一下你就会发现两件怪事：解构出来的 `double` 不会随 `count` 变（它被钉死在 `toRefs` 调用那一刻的求值结果），而 `inc` 被包成了 `Ref<function>`——你要写 `inc.value()` 才能调用，类型和心智全乱。

为什么？因为 store **不只是一个 reactive 对象**。它内部混着三种性质完全不同的字段：

- **state**：原始的 `ref` 或 `reactive`
- **getter**：`computed` 出来的对象
- **action**：普通函数

Vue 的 reactive 代理在 `get` 时会**自动解包 ref**——你从代理上读 `store.count` 拿到的是裸值 `0`，读 `store.double` 拿到的是 computed 当次求值的结果，而不是 computed 对象本身。朴素 `toRefs` 在代理上工作，看到的都是「已经解包过的快照」，根本没法区分三种字段。Pinia 需要一个**懂这套语义**的解构器，这就是 `storeToRefs`。

## 怎么解决：先脱代理，再三路分发

说人话就是：**绕过代理看真相，按字段真实身份分别打包，故意丢掉不要的**。

一个类比：reactive 代理就像一个会自动拆快递的前台，你递给它什么它都先拆开给你看内容物。但你现在想做的是「按包裹类型分拣」，必须绕过前台直接看货架上的原始包裹——这就是 `toRaw` 干的事。

```
storeToRefs(store)
  → toRaw(store)               # 脱掉代理，拿到原始字段表
  → for key in rawStore:       # 遍历真实字段
      value = rawStore[key]    # 取「未经解包」的真值
      ├─ value?.effect         # 分支 A：computed（鸭子类型）
      ├─ isRef||isReactive     # 分支 B：state
      └─ 其它（函数/null/原始值）# 分支 C：跳过
  → 返回 refs
```

判断顺序硬性规定为「先 computed、再 ref/reactive」。为什么？因为 Vue 的 `ComputedRefImpl` 同样实现了 ref 协议（`__v_isRef = true`），先做 `isRef` 会把所有 getter 错误地塞进 state 分支，丢失 computed 该有的 laziness 与可写性。这个顺序是后面权衡 2 的核心。

## 最小演示：手撸一个 storeToRefs

下面这段脚本可以直接 `bun storeToRefs.ts`（或 `npx tsx storeToRefs.ts`）跑。它构造一个含 state/getter/action/null 的「假 store」，实现迷你 `storeToRefs`，并和朴素 `toRefs` 对比。

```ts
import {
  ref, computed, reactive,
  toRaw, toRef, toRefs, isRef, isReactive,
} from 'vue'

// 迷你 storeToRefs：三路分发
function storeToRefs(store: any) {
  const rawStore = toRaw(store)        // ① 脱代理
  const refs: any = {}
  for (const key in rawStore) {
    const value = rawStore[key]        // ② 取未经解包的真值
    if (value?.effect) {               // ③ 分支 A：computed
      refs[key] = computed({
        get: () => store[key],         //    读经代理
        set: (v) => { store[key] = v },//    写经代理
      })
    } else if (isRef(value) || isReactive(value)) { // ④ 分支 B：state
      refs[key] = toRef(store, key)
    }
    // ⑤ 分支 C：函数 / null / 原始值 → 隐式跳过
  }
  return refs
}

// 假 store：state、getter、action、null 各一种
const store = reactive({
  count: ref(0),
  double: computed({
    get: () => store.count * 2,
    set: (v: number) => { store.count = v / 2 },
  }),
  inc() { store.count++ },
  nullable: null,
})

const refs = storeToRefs(store)
const naive = toRefs(store)

console.log('storeToRefs keys:', Object.keys(refs))
// → ['count', 'double']   inc 和 nullable 不见了
console.log('naive toRefs keys:', Object.keys(naive))
// → ['count', 'double', 'inc', 'nullable']

// getters 仍然「按需重算」
store.count = 10
console.log(refs.double.value)   // → 20，跟随 count
console.log(naive.double.value)  // 行为不稳：可能拿到 toRefs 那一刻的快照

// setter 经代理转发，原 computed 的 set 被触发
refs.double.value = 30
console.log(store.count)         // → 15
```

跑完你会看到三个关键现象：

1. `storeToRefs` 的结果只有 `count` 和 `double`，action 和 null 被丢；
2. `double` 仍然是 lazily 重算的 computed，跟随 `count` 变化；
3. 给 `refs.double.value` 赋值会经代理转发到原 computed 的 set，把 `count` 改成 15。

## 关键权衡

> 本章机制集中在前述三个分支的判断与重打包上。下面四条权衡解释「为什么这样设计」，是这一章真正的交付。

### 权衡 1：绕过 reactive 代理读 raw store

**做了**：所有字段判断都以 `toRaw(store)` 为起点，不复用代理给的现成读取。

**换来**：对字段真实身份的判断能力——能区分 computed、ref/reactive、函数、原始值。没有这一步，分支逻辑根本无从谈起。

**代价**：每条字段都得在 raw store 上单独取值；computed 检测靠的是 `value?.effect` 这种**鸭子类型**——直接探 Vue `ComputedRefImpl` 的内部字段名 `effect`。Vue 长期没有公开的 `isComputed` API（社区提过相关 PR 一直没合并），Pinia 只能临时碰内部字段。这是个**隐藏耦合点**：Vue 大版本一旦把 `effect` 字段改名，这里就会断。可选链 `value?.` 同时承担了「value 为 null/undefined 时短路」的作用——这就是为什么 store 里塞个 null 也不会崩。

### 权衡 2：computed 检测必须放在 isRef 之前

**做了**：分支顺序硬性规定为「先 `value?.effect`、再 `isRef||isReactive`」。

**换来**：对「computed 也是 ref」这一 Vue 设计的正确分流。先做 `isRef` 会把所有 getter 错误地塞进 state 分支，丢失 laziness 与可写性——`double` 会变成一个普通的 `toRef(store, 'double')`，每次读都强制重算且没法 set 回去。

**代价**：读源码时必须理解三路分发的优先级，不能简单按 Vue 文档照搬——你看不到一个标准的「`isRef(x) ? ... : ...`」二分。这也是为什么文档承诺「methods and non reactive properties are completely ignored」能成立：computed 被先挑走后，剩下的函数/null/原始值自然落入「跳过」桶。

### 权衡 3：computed 重打包一层，而不是直接复用

**做了**：对每个 getter 不直接返回原 `ComputedRefImpl`，而是再包一个 `computed({ get: () => store[key], set: v => store[key] = v })`。

**换来**：两件事。一是 **HMR 友好**——热更新时 `store[key]` 会被替换成新 computed；如果直接复用旧对象，解构出来的 ref 就永远指向被替换前的旧 computed，新代码改不动了。外层包装的 `get` 每次都重新读 `store[key]`，热更新后自然能拿到新对象，解构出来的 ref 仍然有效。二是**写经代理的一致性**——`set` 把值写回代理 `store[key]`，所有 trigger 都走同一条响应式路径，devtools、`$subscribe`、`$patch` 都能感知到这次写。

**代价**：每个 getter 多一层 computed 嵌套（多一次 effect 串联），需要依赖 Vue computed 的依赖追踪正确把外层标记为 dirty。这是个**为可维护性付的性能税**，但 store 里 getter 通常不多，开销可以忽略。

### 权衡 4：故意丢弃函数与非响应式原始值

**做了**：函数（actions）、null/undefined、原始值（数字、字符串、布尔）、`markRaw` 标记的对象——既无 `effect`、也不是 ref/reactive——统统不进结果对象。

**换来**：解构结果**只含响应式数据**的干净 API。你拿到的对象上每一个字段都是 ref/computed，不会有 `Ref<function>` 这种尴尬类型，也不会有 `nullable: null` 这种无意义条目。

**代价**：用户在解构后拿不到 action，必须保留 store 引用——`const { inc } = storeToRefs(store)` 行不通，得写 `const { inc } = store` 或单独保留 store。但这是**特性而非缺陷**：actions 本来就不是响应式数据，应该用 `store.method()` 调用；把它们包成 ref 既不符合语义，也会让 TS 类型变成不可用的 `Ref<(...args) => any>`。Pinia 文档明确推荐这种用法。

## 类型层的三段拼接（侧栏）

类型签名 `StoreToRefs<SS>` 把 getters / state / 插件注入字段 拆成三段不同的 ref 形态——state 给出 `ToRef`、插件注入字段给出对应 ref 形态、getters 给出 `ComputedRef` 或 `WritableComputedRef`。运行时返回的对象**不区分这三段**，是同一个 plain object；类型层的拆分只是为了让 setter / readonliness 表达到 TS 类型上——比如有 setter 的 getter 类型会是 `WritableComputedRef`，没 setter 的是 `ComputedRef`。这套靠条件类型的协变/双变技巧探测 readonly 实现，理解运行时原理用不上，留给 API 参考。

## 小结

`storeToRefs` 看起来只是一行 `toRefs` 的等价替换，背后是 Pinia 对「store 不是普通 reactive 对象」这一事实的承认：state、getter、action 三种字段性质不同，得分别对待。它做的事可以浓缩成一句——**绕过代理看真相，按身份分别打包，故意丢掉不要的**。
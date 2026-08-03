# mapHelpers：Options API 兼容垫片

## 一句话场景：你接手了一个老项目

想象一下，你刚接手一个从 Vue 2 升级来的项目。整个项目还是 Options API 风格——`computed: {}`、`methods: {}`、`data() { return {} }`。你引入了 Pinia，文档告诉你这么用：

```ts
import { useCounterStore } from '@/stores/counter'

export default {
  setup() {
    const store = useCounterStore()
    return { count: store.count }
  },
}
```

但项目里几乎所有组件都没用 `setup()`，全靠 `computed`、`methods` 这些选项字段在撑。要在这种组件里读 store，你只能手写一堆样板：

```ts
export default {
  computed: {
    count() { return useCounterStore().count },
    double() { return useCounterStore().double },
  },
  methods: {
    inc() { useCounterStore().inc() },
  },
}
```

每多一个字段就多一次 `useCounterStore()`，写多了人就要疯。`mapHelpers` 就是来帮你把这堆样板批量生成的工厂函数。最常见的几行写成：

```ts
import { mapState, mapActions } from 'pinia'

export default {
  computed: { ...mapState(useCounterStore, ['count', 'double']) },
  methods: { ...mapActions(useCounterStore, ['inc']) },
}
```

这一章要讲透的，就是 `mapState` 这种函数到底返回了什么、为什么这么设计、以及它为了适配 Options API 付出了哪些代价。

## 先看一个看似直接、实则翻车的实现

最朴素的念头是：「`mapState` 不就是把 `useStore()` 取出来，把字段直接铺到对象上吗？」

```ts
// 想当然的伪实现
function mapState(useStore, keys) {
  const store = useStore() // 此刻拿不到 pinia
  return keys.reduce((acc, key) => {
    acc[key] = store[key]
    return acc
  }, {})
}
```

这段代码会爆。原因藏在「调用时机」里：

- `mapState(useCounterStore, ['count'])` 是在**写组件定义时**被调用的，相当于模块顶层求值。
- 那个时刻，`app.use(pinia)` 可能还没跑，pinia 实例根本不存在；`useStore()` 内部走 `inject(piniaSymbol)` 也会失败，因为不在 `setup()` 上下文里。

换句话说，**取 store 这个动作，必须在组件实例化之后**才有意义。直接在 map 时取，是早了一步。

## 关键观察：Options API 自带「延迟到实例化」的能力

Vue 的 Options API 有个性质你可能没意识到——`computed` 字段里写的函数，**不是立刻执行的**，而是 Vue 渲染组件、需要这个值的时候，才把函数体跑一遍；并且跑的时候，函数里的 `this` **一定绑定到当前组件实例**。

这两条性质刚好是 mapHelpers 的命脉。把上面那段翻车的实现，改一改：

```ts
function mapState(useStore, keys) {
  return keys.reduce((acc, key) => {
    acc[key] = function () {
      return useStore(this.$pinia)[key]
    }
    return acc
  }, {})
}
```

注意函数体里多了什么：原本「立刻取 store」改成了「定义一个函数，函数被调用时才取 store」。

- map 调用那一刻，函数体不跑，不会爆。
- 等 Vue 渲染组件、调度到这个 computed 时，函数被 `.call(componentInstance)` 调用，`this` 是组件实例。
- 实例上的 `this.$pinia` 是 `app.use(pinia)` 时挂的全局属性，永远指向正确的 pinia 实例。
- `useStore(this.$pinia)` 拿到 store，再取字段。

整套机制说白了：**别自己想办法把 store 抓回来，让 Vue 把它送过来。** Vue 已经替你把 `this` 准备好了，你只要借力就行。

可以把 `this.$pinia` 想成 Vue 给组件实例准备的一块公共留言板——`app.use(pinia)` 时就把地址贴上去了，mapHelpers 写的函数只要等到自己被调用的那一刻去读留言板即可，根本不用关心是谁、什么时候贴的。

## 心智模型：从写组件到拿到值，中间发生了什么

输入一行你常写的代码：

```ts
export default {
  computed: { ...mapState(useCounterStore, ['count']) },
}
```

跟着它走一遍时序：

1. **模块加载时**，`mapState(useCounterStore, ['count'])` 立刻被调用，reduce 出 `{ count: function () { ... } }`，函数体此刻没跑。
2. **组件定义注册时**，spread 把这个对象合进 `computed`，组件多了一个叫 `count` 的 computed 字段。
3. **组件实例化、首次渲染时**，Vue 把 computed 字段逐个求值，调用 `count.call(componentInstance)`。
4. 函数体内的 `this.$pinia` 拿到注入的 pinia 实例（来自 `app.use(pinia)` 的全局挂载）。
5. `useStore(this.$pinia)` 走 store 注册表查找——首次未命中就构建 store 并塞进去，命中就直接返回；最后从 store 上取 `count`，state 字段经过 reactive proxy 自动解包，最终返回数值。

输出：组件里 `this.count === 42`（假设 state 里就是 42）。

这条链路最关键的一点：**mapHelpers 自己一行缓存都没写。** store 实例的唯一真源是 `pinia._s` 注册表（上一章讲过），mapHelpers 每次访问都重新走一遍 `useStore`。这听上去像是浪费，实际上是个聪明选择——下面权衡里细说。

## 最小演示：从零实现 mapState 和 mapWritableState

mapHelpers 没有真正的 Vue 运行时依赖，核心机制是「函数延迟求值 + 借用注册表缓存」。下面这段脚本用 mock 的方式把原理跑通，存成 `demo.mjs` 用 `node demo.mjs` 就能跑：

```js
// === mock 一套 pinia 的注册表（即 pinia._s）===
const registry = new Map()

// === 假装这是 defineStore：返回带 $id 标记的 useStore 函数 ===
function defineStore(id, setup) {
  function useStore(pinia) {
    if (registry.has(id)) return registry.get(id)
    console.log(`  [registry miss] 构建 store "${id}"`)
    const store = setup()
    registry.set(id, store)
    return store
  }
  useStore.$id = id
  return useStore
}

// === 数组版 mapState：每个 key 包成延迟 getter ===
function mapState(useStore, keys) {
  return keys.reduce((acc, key) => {
    acc[key] = function () {
      return useStore(this.$pinia)[key]
    }
    return acc
  }, {})
}

// === mapWritableState：用 setter 直接写 store 字段 ===
function mapWritableState(useStore, keys) {
  return keys.reduce((acc, key) => {
    acc[key] = {
      get() { return useStore(this.$pinia)[key] },
      set(v) { useStore(this.$pinia)[key] = v },
    }
    return acc
  }, {})
}

// === 定义一个 store ===
const useCounter = defineStore('counter', () => ({ count: 42 }))

// === 假装这是个用 Options API 写的组件 ===
const Component = {
  computed: { ...mapState(useCounter, ['count']) },
}

// === Vue 实例化时会注入 $pinia 并 .call(componentInstance) ===
const instance = { $pinia: 'fake-pinia' }

console.log('第一次读取（触发构建）：')
console.log('  count =', Component.computed.count.call(instance)) // 42

console.log('第二次读取（命中缓存）：')
console.log('  count =', Component.computed.count.call(instance)) // 42

// === 改用 mapWritableState：setter 能直接写 store 字段 ===
const Editable = {
  computed: { ...mapWritableState(useCounter, ['count']) },
}
const inst2 = { $pinia: 'fake-pinia' }
Editable.computed.count.get.call(inst2) // 触发 useStore
Editable.computed.count.set.call(inst2, 100) // 写回 store

console.log('改完之后读取：')
console.log('  count =', Component.computed.count.call(instance)) // 100
```

跑一遍输出你会看到：第一次读 `count` 触发 `[registry miss]`，第二次开始命中缓存直接返回——这就是「mapHelpers 不缓存、注册表是唯一真源」的运行时证据。`mapWritableState` 的 setter 写回 store 后，下次 `mapState` 的 getter 读到的就是新值，因为它们走的是同一个注册表。

> 演示故意省略了 array/object 双签名、`mapStores` 的后缀拼接、`mapActions`（机制同 `mapState`）、TS 类型推导。这些都属于同机制的变体，不参与核心权衡。

## 关键权衡（这一章的核心）

这一章机制集中，核心就一条权衡——**延迟求值换来了对 Options API 的天然契合，代价是 TS 类型只能近似、且失去了 setup 里的 ref 自动解包**。围绕这条主线，下面把它拆成 4 个面看清楚。

### 权衡 1：把每个 key 包成延迟函数 vs 类型精确性与 ref 解包

**做了的选择**：mapState 返回的对象里，每个 key 都是一个普通函数，函数体内才调 `useStore(this.$pinia)`。

**换来了什么**：和 Options API 完美契合。Vue 的 computed/methods 字段定义里，函数被调用时 `this` 一定是组件实例，而组件实例上一定有注入的 `$pinia`。这两个事实一拼，mapHelpers 不需要自己持有任何 pinia 引用，也不需要 `getCurrentInstance()`——它完全站在 Vue 已有机制的肩膀上。

**代价**：

- TS 类型跟不上。返回类型是 reduce 跑出来的对象，TS 没法静态推出 `'count'` 这个 key 对应的返回类型是 `number`——只能靠 mapped type 配合模板字面量做近似推导，源码里大量 `@ts-expect-error` 注释，正是开发团队对「运行时正确、类型近似」这一折中的承认。
- setup() 里的 ref 会自动解包，但 mapHelpers 不会。setup 里写 `return { count: someRef }`，模板里 `count` 直接是值；mapState 返回的 getter 取的是 store 字段——state 字段在 store 上已经被 reactive proxy 解包过了（store 内部处理），但如果你 map 的是一个返回 ref 的自定义函数，组件拿到的可能就是 ref 本身，需要 `.value`。这是从 setup 转 Options API 时最容易踩的坑。

### 权衡 2：每次访问都重走 useStore vs 自己缓存 store

**做了的选择**：mapHelpers 不持有任何缓存，每次 computed 求值都重新走一遍 `useStore(this.$pinia)`。

**换来了什么**：零额外缓存状态，`pinia._s` 注册表是 store 实例的唯一真源。这个好处在三个场景下特别值钱：

- **HMR 热更新**：开发者改了 store 代码，Vite 触发热更新替换注册表里的 store 实例。如果 mapHelpers 自己缓存了旧 store，组件下次读到的就是过期值——但因为每次都走注册表，自然就拿到了新实例。
- **disposePinia 之后**：测试里调 `disposePinia()` 会清空注册表。下次组件读取时，注册表是空的，会重新构建一份干净的 store。如果 mapHelpers 缓存了，就会一直拿着被销毁的旧实例。
- **测试 reset**：`setActivePinia(createPinia())` 切换 pinia 实例后，组件下次读取会自动落到新实例上。

**代价**：每次 computed 求值多一次注册表查询（`Map.get`，命中缓存是 O(1)），加上一次 `this.$pinia` 的属性解析和一次函数调用。这开销基本可以忽略——Vue 的 computed 本身就有响应式依赖追踪的开销，多这点查询是毛毛雨。但严格说它不是「零成本」，相比 setup() 里直接拿一次 store 然后解构，确实多了几次注册表命中。

### 权衡 3：array 与 object 双签名共享同一份实现 vs 错误信息直观

**做了的选择**：`mapState(useStore, ['count'])` 和 `mapState(useStore, { myCount: 'count' })` 共用同一份 reduce 实现，靠 `Array.isArray(keysOrMapper)` 在函数体内二分。对象形式的 value 还允许是 `(store) => any` 函数，调用时 `.call(this, store)`，让用户函数也能拿到组件实例。

**换来了什么**：API 极其简洁。用户既能用数组保留原名（`['count']`），又能用对象重命名（`{ myCount: 'count' }`），还能传自定义 getter（`{ total: (store) => store.list.length }`，甚至 `{ withSelf: function(s) { return s.items[this.selectedId] } }` 借 this 读组件状态）。一个 API 入口覆盖三种用法。

**代价**：

- 函数体内必须 `Array.isArray` 二分，运行时分支虽然廉价，但读代码的人需要先在脑子里分叉一次。
- TS 需要 3 个 overload 签名（数组版、对象版、统一实现），类型错误信息不够直观。用户传错了 key，报错可能落在 overload 匹配失败的模糊位置，而不是「你这个 key 在 store 上不存在」这种精确提示。
- 因为对象形式的 mapper 函数允许用 `this`，必须用 `function` 而不是箭头函数——JSDoc 里专门有一条警告「arrow function won't have this」。这是个隐藏的语法陷阱，没看文档的人很容易踩。

### 权衡 4：mapWritableState 返回 `{get, set}` vs 与 mapState 形态分裂

**做了的选择**：`mapWritableState` 不返回函数，而是返回 `{ get, set }` 对象。set 直接 `useStore(this.$pinia)[key] = value`，把值写到 store 字段上。

**换来了什么**：支持 `v-model` 等双向绑定场景。Vue 的 computed 字段接受 `{get, set}` 形态——这是为 writable computed 留的口子，mapWritableState 正好对上。如果你想在模板里 `<input v-model="count">`，且 `count` 直接驱动 store 状态，必须用这个形态。

**代价**：

- 与 `mapState` 的函数形态分裂。用户必须记：只读用 `mapState`、可写用 `mapWritableState`——而不是一个 API 配个参数。这是 Pinia 的设计选择：让 90% 的只读场景保持「函数即值」的最简心智，剩下 10% 的可写场景单独开一个 API。这一不对称换来了主流用法的简洁。
- setter 直接赋值 store 字段，**绕过 `$patch`**。这意味着：你不能在 `$subscribe` 监听器里靠 patch 路径的元数据区分「这次变更是从 mapWritableState 的 setter 来的」——它的行为和直接 `store.count = 100` 完全一致。`$subscribe` 仍会收到 mutation 事件，但 patch 专用的临时静默逻辑不会介入。
- mapWritableState 只允许 state 字段，不允许 getter。因为 getter 通常是 computed，写它会破坏计算语义——computed 是只读的派生值，没有合理的「写」目标。这个限制是类型层面强制写的，运行时类型检查会拒绝。

## 几个变体一句话带过

- **mapActions**：和 mapState 同构，差别只在 methods 字段要求函数、且要把调用参数透传：`function(...args) { return useStore(this.$pinia)[key](...args) }`。机制完全一致，不展开。
- **mapStores**：把 store 本身作为值映射进来。key 是 `${useStore.$id}Store`（默认后缀 `Store`，可被 `setMapStoreSuffix` 改）。getter 体一样的 `useStore(this.$pinia)`，只是不带 `[key]`。
- **mapGetters**：`mapState` 的别名，Vuue 时代留下的命名，已 deprecated。
- **`setMapStoreSuffix`**：模块级 mutable 变量，改全局后缀。多 pinia 实例并存时（如微前端）会互相污染，约定「应用启动时一次性设置」即可，别在运行时改。

## 总结：为什么这套设计值得学

mapHelpers 这一章的价值不在它本身——它只是个适配层。价值在于它给了一个**「借力而非另起一套」**的范例：

- 借 Vue Options API 自带的 this 绑定，省掉了自己缓存 pinia 的复杂度。
- 借 store 注册表的唯一真源，省掉了自己同步 store 生命周期的代码（HMR、dispose、reset 自动跟着走）。
- 借用 reduce 的对象构造，用一份实现覆盖三种入参签名。

这套思路换来的代价都集中在「类型近似」和「形态分裂」上——是典型的「让运行时简单、让类型/认知复杂」的工程取舍。你下次遇到「我要把 A 风格的 API 适配成 B 风格」的场景，可以想想：B 风格里有没有什么现成的机制（比如 this 绑定、生命周期、注入），是你不用自己造的？
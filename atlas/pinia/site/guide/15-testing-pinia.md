# 测试：以插件重塑 store 行为

> 本章属于 system 层。前置：插件系统：context 注入的 store 增强、Store 装配：effectScope 托管的返回值分类与状态镜像。
> 学完你能：用一句话讲清「为什么测试库不写测试专用 store，而是预装插件在装配期重塑 store；以及它为什么必须直捣 Vue 计算属性的内部字段才能覆盖只读 getter」。

## 1. 为什么需要它（设计动机）

上一章讲 Nuxt 模块把 `defineStore` / 状态水合 / HMR 接入做到了零样板——它的思路是「在已有机制外面加一层自动化」。本章处理的是另一个看似与框架集成无关、但思路同源的场景：单测 store。

具体痛点是：单测 store 时你几乎总要改写它的行为。不想真跑某个 action 的网络副作用、想给状态塞一份初始值、想临时把某个只读派生值（getter）冻结成固定值来测某个分支。但这些「测试期」能力 store 本身一个都没有，它没有「测试模式」开关。

最朴素的两个冲动都不可行：

- fork 一套测试专用 store：维护成本翻倍，业务改了要同步改测试桩
- 往核心塞 `if (测试)` 分支：测试逻辑混进生产路径，核心代码被污染

测试库要回答的问题是：能不能让所有「测试期行为改写」都不进核心，但又能彻底重塑 store？

## 2. 核心思想

把测试需要的所有行为改写，全部表达成「在 store 装配完成的那一刻插入一段重塑逻辑」。

这里的关键转换是：插件不一定非要返回扩展对象让装配器合并——它完全可以不返回任何东西，只拿到刚装配好的 store 引用、就地变异它。换句话说，第 9 章把插件当作「注入新成员的增强器」用，本章把它当作「装配完成钩子」用。同一套机制，换了用法，整套测试库就有了支点。

## 3. 心智模型

`createTestingPinia` 是一个工厂，做三件事：

1. 建一个普通 pinia 实例（不写第二套）
2. 往它的插件队列 `_p` 里按固定顺序塞四段重塑逻辑：
   - 初始态合并（把预设状态深合并进 `store.$state`）
   - 用户自传插件（原样插队，不经过核心的「安装前延迟队列」）
   - 可写 getter 包装（每个只读 computed 换成可写 computed）
   - action / 补丁 / 重置桩化（按配置用 spy 覆盖方法）
3. 给实例打上测试标志 `_testing = true`，并把它设为当前活跃实例

此后测试里调 `useStore()` 时，第 4 章讲过的装配管线照常跑，四段插件只是在管线最末追加四个步骤，在「装配完成」那一刻依次拿到刚建好的 store 就地变异。关键不变量是：测试代码拿到的 store 与生产装配出来的 store 走过**完全相同的装配管线**，没有第二条路径。

## 4. 关键权衡

### 用装配期插件重塑，而不是另写测试专用 store 或核心测试分支

**选择**：在装配期插入插件，在「store 刚建好那一刻」就地改写它的状态与方法。
**换来**：核心生产路径零污染（没有任何「如果是测试就分支」），测试与生产走完全相同的装配路径——你测到的就是生产行为，不会出现「测试桩里漏写了某个赋值」这类与真实装配不一致的偏差。
**代价**：所有重塑都只能发生在「装配完成那一刻」这个固定时机。这意味着改写手段必须迁就这个窗口：初始态靠此刻合并进 `store.$state`、action 桩化靠此刻直接覆盖 store 上已赋值好的方法、getter 覆盖靠此刻把只读 computed 换成可写的（见下条权衡）。

本质矛盾是「测试需要彻底改写行为」与「核心代码不能因测试而分支」两个对立需求在打架。通解骨架是：找一个**已有的扩展点**作为改写窗口——任何具有「装配完成钩子」的库都可以照搬这个思路，而不必往核心里塞测试专用代码。

### 把桩化与监视统一表达成 spy 包裹

**选择**：所有需要被改写或被监视的可调用对象（action、`$patch`、`$reset`），统一用「spy 包裹」来表达。桩化模式换成空 spy `createSpy()`，原逻辑完全不跑；监视模式换成包住原函数的 spy `createSpy(original)`，照跑但调用可断言。
**换来**：一套配置（全桩 / 指定名字桩 / 仅监视不桩）同时覆盖三类可调用对象，认知负担低；测试代码用 `expect(store.action).toHaveBeenCalledWith(...)` 这样的统一断言，不区分对象是 action 还是 `$patch`。
**代价**：强制使用者必须提供一个 spy 工厂。默认会探测 `jest.fn` / `vi.fn`，找不到就直接抛错，没有静默降级。这是个不便宜的契约——但它换来的是测试库完全不必关心调用记录的实现细节。

换句话说，这里折叠的是「桩化与监视是两件不同的事」与「希望用一个统一 API 同时表达两种需求」的对立。一个**带模式的包装器**把「是否执行原逻辑」这个差异折进同一个工厂调用——`createSpy()` 与 `createSpy(original)` 的参数差异就是开关。

### 让 action 桩化刻意排在插件队列最末

**选择**：四段插件的入队顺序是硬契约——初始态 → 用户插件 → 可写 getter 包装 → action 桩化，桩化一定最后。
**换来**：能覆盖更早插件对 action 的改写。可观测层（DevTools 那章讲过的）会把 action 用 Proxy 包一层做归因追踪；如果桩化先于它执行，测试桩就会被可观测层覆盖；放最后则反过来——「测试桩说了算」。
**代价**：插件入队顺序成为一个**隐式契约**。使用者自传的 `plugins` 选项会被插在桩化插件之前，被包过的 action 会被桩化干净覆盖，没法后置覆盖测试行为。如果你恰好想自己桩化某个 action，必须另想办法。

这条原理在多插件系统里很常见：多个候选改写者都要碰同一个对象时，给「最末入队者胜出」一个明确语义，是钩子链的标准做法（洋葱模型的「最外层」反过来）。

### 直捣 Vue 计算属性的内部字段，换「覆盖只读 getter」这一个逃生口

**选择**：覆盖只读 getter 这件事，正常情况下根本不该可能——computed 是只读的。测试库选择不放弃这个能力，而是直接操作 Vue `ComputedRefImpl` 的三个非公开内部字段：缓存值 `_value`、脏标记 `_dirty`、getter 函数句柄 `fn`。
**换来**：测试里能临时把一个只读派生值冻结成任意值、且事后能恢复成真计算。`store.myGetter = 99` 冻结、`store.myGetter = undefined` 恢复。
**代价**：依赖 Vue 计算属性**非公开**的内部实现。一旦 Vue 改了这三个字段的名字或语义，这条逃生口就失效。它是整个测试库**唯一**触碰 Vue 内部实现之处，其它一切都建立在公开 API 上。

化解的本质矛盾是「公开 API 不允许覆盖只读派生值」与「测试场景需要这种能力」在打架。逃生口的可维护性就在于它的「窄」——把对内部实现的依赖收缩到这三个字段、这一个点，而不是散落到多处。任何库在做这类「破例」时都该遵循这个原则：识别最窄、最稳定的内部实现作为唯一逃生口，把它孤立起来。

## 5. 最小原理演示

下面两段脚本只演两条原理：插件作为「装配完成回调」就地变异 store；可写包装器劫持只读计算属性的内部字段。**故意省略**：多框架 spy 工厂探测、深合并的纯对象判定细节、`$patch`/`$reset` 桩化分支、类型体操、`fakeApp` 副作用。

```ts
// 演示一：插件作为「装配完成回调」就地变异 store

// 一个最小 pinia：插件队列 + 注册表
function createMiniPinia() {
  const _p: Array<(ctx: { store: any }) => void> = []
  const _s = new Map<string, any>()
  return {
    _p,
    _s,
    // 装配 = 跑 setup + 在「装配完成那一刻」依次跑所有插件
    use(setup: () => any, id: string) {
      const store = setup()
      _p.forEach((ext) => ext({ store }))
      _s.set(id, store)
      return store
    },
  }
}

// 测试库：预装一段「重塑插件」后建实例
function createTestingMiniPinia(initialState: Record<string, any>) {
  const pinia = createMiniPinia()
  // 关键：插件不返回扩展，只就地改 store —— 这是把插件当装配完成回调用
  pinia._p.push(({ store }) => {
    if (initialState[store.$id]) {
      Object.assign(store.$state, initialState[store.$id])
    }
  })
  return pinia
}

// 使用
const pinia = createTestingMiniPinia({ cart: { items: 99 } })
const cart = pinia.use(() => ({ $id: 'cart', $state: { items: 0 } }), 'cart')
console.log(cart.$state.items) // 99 —— 初始态在装配完成那一刻被合并进来
```

```ts
// 演示二：可写包装器劫持只读计算属性的三个内部字段

// 手写一个最小 computed：三字段（缓存值 / 脏标记 / getter 句柄）
function miniComputed<T>(getter: () => T) {
  return {
    fn: getter,                  // getter 句柄（可被替换）
    _value: undefined as unknown as T, // 缓存值
    _dirty: true,                // 脏标记：true 表示下次读要重算
    get value(): T {
      if (this._dirty) {
        this._value = this.fn()
        this._dirty = false
      }
      return this._value
    },
  }
}

// 「可写包装器」：把只读 computed 包装成可写的
function makeWritable(c: ReturnType<typeof miniComputed>) {
  const originalFn = c.fn               // 留底原 getter 句柄
  const overriddenFn = () => c._value   // 冻结态：恒返回缓存
  return {
    get value() {
      return c.value                    // 读透传
    },
    set value(newValue: unknown) {
      if (newValue === undefined) {
        // 恢复态：换回原 getter、清脏标记强制重算
        c.fn = originalFn
        c._dirty = true
      } else {
        // 冻结态：getter 改成恒返回缓存、缓存写成新值
        c.fn = overriddenFn
        c._value = newValue as T
      }
    },
  }
}

// 使用
let base = 1
const c = miniComputed(() => base * 10)
const w = makeWritable(c)
console.log(c.value) // 10 —— 真计算

w.value = 99         // 冻结
console.log(c.value) // 99 —— 不再随 base 变化
base = 100
console.log(c.value) // 99 —— 仍是冻结值

w.value = undefined  // 恢复
console.log(c.value) // 1000 —— 重新跑原 getter
```

两段演示合起来就是测试库的本质：装配期插件 + 计算属性内部字段劫持，没有任何「测试专用 store」。

## 6. 执行轨迹

输入：`createTestingPinia({ initialState: { cart: { items: 2 } }, stubActions: ['checkout'] })`，测试里 `useCartStore()`。

工厂阶段发生的事：

1. `createPinia()` 建一个普通实例，`_p` 队列为空
2. 初始态插件入队 → `_p[0]`
3. 用户没有自传插件，跳过
4. 可写 getter 包装插件入队 → `_p[1]`
5. action 桩化插件入队 → `_p[2]`，刻意最末
6. 打上 `_testing = true`，设为活跃实例

测试里调 `useCartStore()`，装配阶段发生的事：

1. setup 跑完，原始 cart store 长这样：`$state = { items: 0 }`、`checkout` 是真函数、`total` 是只读 computed
2. `_p[0]` 跑：`initialState.cart.items = 2` 合并进 `store.$state`，`$state` 变成 `{ items: 2 }`
3. `_p[1]` 跑：遍历 store，发现 `total` 是 computed（凭 `isRef(v) && 'effect' in v` 识别），替换成一个新的可写 computed（默认读时透传原值）
4. `_p[2]` 跑：遍历 actions，`checkout` 命中桩化名单，换成空 spy `createSpy()`；其余 action 包成 `createSpy(original)` 照跑可断言

测试断言阶段：

- 调 `cart.checkout()` 不执行原逻辑，但 `expect(cart.checkout).toHaveBeenCalled()` 成立
- 读 `cart.$state.items` 是 2，来自初始态合并
- 测试里写 `cart.total = 50`：这个赋值经 Vue 的 reactive set 陷阱路由进包装 computed 的 setter，切到「冻结成 50」态，此后读 `cart.total` 恒为 50
- 测试末尾调 `restoreGetter(cart, 'total')`，等价于 `cart.total = undefined`：setter 切回「恢复真计算」态，下次读 `cart.total` 重新跑原 getter

整条轨迹里没有任何「测试专用装配路径」，所有改写都发生在装配管线最末的 `_p.forEach(extender => extender({ store }))` 那一轮循环里。

## 7. 教学简化说明

本章演示故意省略了多框架 spy 工厂探测（jest/vitest 全局判定与「工厂本身 vs 工厂调用结果」校验）、深合并里对 Map/Set、ref/reactive 的判定（与状态变更模型章同源）、`$patch` 与 `$reset` 的桩化分支（与 action 同构）、桩化判定的「布尔 / 名字数组 / 谓词」三分支、类型体操与生产构建标志、`fakeApp` 选项触发的 `app.use(pinia)` 副作用。这些都是工程完整性的部分，与「插件重塑」和「计算属性逃生口」这两条原理主线无关。

## 8. 小结

测试库把所有「测试期改写」表达成装配期插件，让核心生产路径零污染——这是把插件机制当作「装配完成回调」用的产物；唯一的逃生口是直捣 Vue 计算属性内部字段，换「覆盖只读 getter」这一个本不该可能的能力。

合上全书：从最底层的根状态、订阅原语，一路到装配管线、变更模型、插件、HMR、DevTools、SSR、Nuxt 集成和本章的测试——所有机制都建在那一个根状态和那条装配管线之上。

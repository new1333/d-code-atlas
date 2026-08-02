# @pinia/testing：用插件桩化 action 与 $patch

## 你是不是遇到过这种场景

写单测时，你只想验证「按下提交按钮时，组件调用了 `submitOrder` 这个 action，参数是订单号」。但 `submitOrder` 内部真正执行时会：发请求、读 localStorage、还顺手改了另一个 store 的 state。你只想断言「它被调用了」，并不想让这些副作用真的跑起来。

直接用真 Pinia 的话，action 会真执行、真改 state、真发请求——单元测试退化成又慢又脆的集成测试。

`@pinia/testing` 就是为这个场景生的：它给你一个看起来「正常」的 Pinia 实例，但每次 store 创建时，自动把每个 action 换成一个 spy（监视函数）。spy 记录调用次数和参数，但默认不执行原代码。

## 一句话讲透它的设计

**不为测试另起一条 store 工厂，而是复用生产线的同一套插件钩子，在测试里给 store 的可变部件「换装」。**

打个比方：生产线是一条流水线，store 从这条线走出来时，每个工位（插件）都会对它做点加工。`@pinia/testing` 不另起一条小流水线，而是在原流水线最后几个工位上多装几个「替换零件」的工序——所有「按原样出厂」的工序都没动，所以你拿到的 store 还是那条线上出来的真 store，只是 action/getter 已经被偷偷换过。

## 心智模型：它到底做了什么

按调用顺序看一遍：

1. 创建一个**普通 Pinia 实例**（和生产线一模一样）。
2. 按固定顺序往这个实例的**活动插件列表**里 push 四个改造器：(a) 注入预设 state、(b) 你传进来的业务插件、(c) 把每个 getter 改成可写、(d) 把每个 action 换成 spy。
3. 把这个测试 Pinia 设为**当前活跃实例**（让组件外的 `useStore()` 也能拿到它）。
4. 测试里 `useStore()` 触发 store 创建，创建末尾按插件顺序逐个跑改造器，最后一步才把 action 换成 spy。
5. 测试里调 `store.someAction()` 实际跑的是 spy（默认全桩不执行原代码），用 spy 的断言 API 检查调用次数/参数。

第 2 步里有个细节值得专门拎出来——它**直接 push 到活动插件列表**，绕过了「等待 `app.use(pinia)`」的待安装队列。下一节的权衡里会讲为什么这么做。

## 一个最小可跑的演示

下面这段代码配上真 pinia 包能直接 `bun run` / `node` 跑。它只演示「插件换装」这个最核心的思想，剩下的复杂度（可写 getter、谓词形态的 `stubActions`）后面分小节展开。

```ts
import { createPinia, defineStore } from 'pinia'

// 一个最小 spy 工厂：替代真实测试框架里的 vi.fn / jest.fn
function makeSpy() {
  const fn = (...args: any[]) => { (fn as any).calls.push(args) }
  ;(fn as any).calls = []
  return fn as any
}

function createTestingPinia() {
  const pinia = createPinia()
  // 直接 push 到活动插件列表，绕过 app.use 的待安装队列
  // 这是 pinia 暴露的真实内部 API，@pinia/testing 自己也是这么用的
  ;(pinia as any)._p.push(({ store, options }: any) => {
    for (const name in options.actions) {
      store[name] = makeSpy()           // 全桩：丢弃原实现
    }
  })
  return pinia
}

// 用法：action 被替换为空 spy，调用不会真改 state，但调用记录可断言
const pinia = createTestingPinia()
const useStore = defineStore('counter', {
  state: () => ({ n: 0 }),
  actions: { inc() { this.n++ } },
})
const s = useStore(pinia as any)
s.inc()
console.log(s.n)            // 0  （原 action 没跑）
console.log((s.inc as any).calls)    // [[]]（但调用被记录了）
```

跑一下你会看到两行输出：`0` 和 `[[]]`。前者证明原 action 没执行（`n` 还是初始的 0），后者证明调用被记录下来了（数组里有一个空参数列表）。这就是「全桩」最朴素的形态。

## 关键权衡：每一处选择都换来什么、又付了什么代价

这一节是本章的重头戏。`@pinia/testing` 的设计能拆成四条很具体的权衡。

### 权衡 1：直接 push 进活动插件列表，绕过 `app.use` 待安装队列

**做了什么**：所有内部改造器都用 `pinia._p.push(...)` 直接追加到**活动插件列表**，而不是走 `app.use(pinia)` 触发的待安装队列（`toBeInstalled`）。

**换来什么**：纯 store 测试**不需要 `createApp` 也能让插件生效**。你想测一个 store，没必要为了挂 pinia 而真的去 `mount(Component)`——直接 `setActivePinia(createTestingPinia())`、然后 `useStore()`，桩化照样发生。

**代价是什么**：那些依赖 `_a`（app 实例）的业务插件拿不到 app——因为 `app.use` 没被触发，`_a` 永远是 undefined。源码为此提供了 `fakeApp: true` 选项：函数末尾会 `createApp({}).use(pinia)`，伪造一个空 app 把待安装队列冲一遍。换句话说，**「方便的纯 store 测试」和「依赖 app 的业务插件」是互斥的两种模式**，要用后者就得显式开 `fakeApp`。

### 权衡 2：四个内部改造器按固定顺序追加

**做了什么**：内部改造器按「预设 state → 用户插件 → 可写 getter → action 桩化」的固定书写顺序追加进 `_p`。

**换来什么**：用户插件**看到的是真实 getter/action**——因为可写化、桩化都发生在它们之后。所以业务插件可以做「给每个 action 加 before/after 钩子」这种事，拿到的是原汁原味的 action，最后才被桩化掉。

**代价是什么**：用户**无法调整这个顺序**。极少数依赖「桩化后 action」的用户插件会拿到 spy 而非原函数——但实际场景里这种需求几乎不存在，所以这个代价基本是隐形的。

### 权衡 3：可写 getter 借助 Vue 计算引用的内部缓存字段做覆写

这条最巧。先说背景：Pinia 的 getter 在底层是 Vue 的 `computed`，正常情况下 `computed` 是只读的——你不能 `store.double = 3`。但测试里你常常需要硬塞一个值给 getter（比如「让 `isLoggedIn` 直接返回 true，跳过认证流程」）。

**做了什么**：遍历 store 的每个属性，发现 `computed`（用 `'effect' in v` 判定）就用一个新的 `computed({ get, set })` 替换。get 还是委托原 computed；set 走「改原 computed 的内部私有字段」的覆写/恢复分支。

具体说，set 一个非 undefined 值时：把原 computed 的 `fn` 换成「返回固定 `_value`」的覆盖函数，并把 `_value` 设成新值——后续读取恒返回新值。set undefined 时：恢复原 `fn`、`delete _value`、`_dirty = true`，下次读取会重算。

**换来什么**：`store.double = 3` 这种最自然的写法可行，且**原生 computed 的懒求值 + 缓存语义完整保留**——没覆写时，getter 行为和生产线完全一致。

**代价是什么**：绑死了 Vue reactivity 的内部实现。`fn`、`_value`、`_dirty` 这些都是 `ComputedRefImpl` 的私有字段，Vue 升级一旦改这些字段名，能力立刻破裂。源码里这些位置都标了 `@ts-expect-error: private api`——明摆着是「我知道我在用私有 API，认了」。

而且这个机制还需要一个配套的「显式回滚」工具：包内单独导出的 `restoreGetter(store, 'double')` 实际就是把 `store.double` 设回 undefined，触发 setter 的恢复分支。换句话说，**「设个值就覆写、设回 undefined 就还原」是同一套机制的两种用法**——设计很对称，但用户得知道这个约定才能回滚干净。

### 权衡 4：默认全桩 + 三种粒度

**做了什么**：`stubActions` 选项的类型是 `boolean | string[] | ((actionName, store) => boolean)`——三种形态：

- **`boolean`（默认 `true`）**：`true` 全桩，所有 action 不执行原代码；`false` 仅 spy 不桩——保留调用记录，但**仍执行原代码**。
- **`string[]`**：白名单，只有数组里列出的 action 被桩化，其他正常执行。
- **`(actionName, store) => boolean`**：谓词，对每个 action 调用一次，返回 true 就桩化。

**换来什么**：**零配置上手 + 精细控制并存**。新人传一个 `createTestingPinia()` 啥都不配，所有 action 默认都桩化了；高级用户可以用谓词做「只桩化会发请求的 action、保留纯计算的 action」这种精细控制。

**代价是什么**：默认全桩是**最常见的 issue 来源**——新用户写完测试纳闷「我调了 action 怎么 state 没变」，得读文档才知道默认是全桩。这个陷阱设计上没法消除（默认值改 false 又会破坏「零配置就能用」的承诺），只能在文档里反复强调。

## 执行轨迹：`stubActions: false` 走一遍

为了把上面所有权衡串起来，看一个具体例子。输入：`createTestingPinia({ stubActions: false })` + 一个 counter store，其 action `inc(amount)` 使 `n += amount`。

```
createTestingPinia({ stubActions: false })
  ├─ createPinia()                                    // 创建普通实例
  ├─ pinia._p.push(initialStatePlugin)                // 顺序 #1（默认 initialState={}）
  ├─ (无 plugins 传入，跳过)                          // 顺序 #2
  ├─ pinia._p.push(WritableComputed)                  // 顺序 #3
  └─ pinia._p.push(stubActionsPlugin)                 // 顺序 #4

useStore(pinia)
  └─ createSetupStore(...)
       └─ for (plugin of pinia._p) plugin({ store, options })
            ├─ #1: initialState 命中？→ 否，跳过
            ├─ #3: inc 不是 computed，跳过
            └─ #4: 遍历 actions，inc 不是 $reset，进入桩化分支
                  stubActions=false → 不桩
                  → store.inc = createSpy(原 inc)    // 包原 fn 的 spy
```

测试里调 `store.inc(5)`：

- spy 记录 `args=[5]`（断言 `expect(store.inc).toHaveBeenCalledWith(5)` 通过）
- spy 转调原 inc → `state.n` 从 0 变 5（断言 `expect(store.n).toBe(5)` 通过）

`stubActions: false` 这个用例典型就典型在——它**让 action 既被监视、又真执行**。这是 integration-style 单测的常见姿势：你想确认 action 被调用且产生了正确的 state 变化，但又不想丢掉 spy 的断言能力。

## 一个容易踩的坑：`$reset` 被独立对待

源码里有个细节值得提：在 action 桩化的循环里，`$reset` 被显式 `return` 跳过，由独立的 `stubReset` 选项控制。原因是 setup store 的 `$reset` 是用户自定义函数，会被算进 `options.actions`——如果不跳过，它会被当成普通 action 一起桩化掉，那 `stubReset: false` 这个选项就完全失效了。

代价是一个**极端边界**：如果你真的有个业务 action 名字就叫 `$reset`（极端罕见），它会被无条件跳过桩化——文档里没明确警告这个。

顺带提一句，`$patch` 和 `$reset` 即使在被「不桩化」的默认情况下，也会被包成 `createSpy(原函数)`——也就是说它们**默认就被监视、但保留原行为**。这是为了让你能断言「`$patch` 被调了几次、参数是什么」这种常见需求，不用额外配置。

## 把所有权衡收回来

`@pinia/testing` 的核心赌注是「**复用生产线插件机制做测试桩**」。所有好处——行为一致性、零配置上手、和真 store 创建路径同步——都来自这个赌注。所有代价——依赖 `_a` 的业务插件得 `fakeApp`、可写 getter 绑死 Vue 私有 API、默认全桩的反直觉——也都是这个赌注的副作用。

它不是最强大的测试工具，但可能是「设计取舍最自洽」的那种——选了一条主线（插件钩子），所有功能都从这条主线延伸出去，没有为某个边缘场景另起一条机制。
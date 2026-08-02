# 订阅原语：Set + onScopeDispose 的自动回收

## 写在前面：那个让所有人都踩过坑的事

想象你在写一个 Vue 组件，要监听某个 store 的状态变化。你顺手写了类似这样的代码：

```ts
const unsubscribe = store.$subscribe((state) => {
  console.log('state changed', state)
})
```

然后在组件销毁时——也许你忘了 `onUnmounted(unsubscribe)`，也许你压根没意识到要写。结果就是组件早没了，但回调还活着，每次 state 变化都触发一次，闭包里还死死引用着旧组件的 props。这就是 Vue 社区流传多年的「内存泄漏鬼故事」之一。

Pinia 的订阅原语想做的事，就是把这种「忘了取消」变成几乎不可能发生的事。它的全部代码加起来不到 30 行，但每一个决定都值得拆开看。这一章我们就自底向上把它讲透。

## 一个最朴素的问题：用什么装回调？

订阅最底层的需求其实特别简单：能加、能删、能批量调用。我们最直觉的反应是写个数组：

```ts
const callbacks = []
function add(cb) { callbacks.push(cb) }
function trigger(...args) { callbacks.forEach(cb => cb(...args)) }
```

但 Pinia 选了 `Set`。这一选不是随手挑的——它换来了两个具体好处，也付了一份具体的代价。我们先记下这个选择，后面专门展开。

整个订阅模块对外只导出三个东西：一个空函数 `noop`、一个注册函数 `addSubscription`、一个触发函数 `triggerSubscriptions`。模块自己**没有任何状态**——容器是调用方传进来的，工具函数只负责操作它。说人话就是：Pinia 没有一个全局的「订阅大列表」，每个 store 自己握着两个 Set（state 订阅一个、action 订阅一个），这套小函数只是给它们提供「怎么加、怎么删、怎么触发」的统一行为。

## 40 行看清整个机制

我们用一段能跑的 TS 把核心演透。把下面这段存成 `sub.ts`，用 `bun run sub.ts` 或 `npx tsx sub.ts` 就能跑（依赖 `vue`）：

```ts
import { effectScope, getCurrentScope, onScopeDispose } from 'vue'

// —— 极简版订阅工具 ——
const noop = () => {}

function addSubscription<T extends (...args: any[]) => any>(
  subscriptions: Set<T>,
  callback: T,
  detached = false,
  onCleanup: () => void = noop,
) {
  subscriptions.add(callback)

  const remove = () => {
    const deleted = subscriptions.delete(callback)
    if (deleted) onCleanup()
  }

  // 双 gate：必须「未声明 detached」且「当前有 scope」才自动挂清理
  if (!detached && getCurrentScope()) {
    onScopeDispose(remove)
  }

  return remove
}

function triggerSubscriptions<T extends (...args: any[]) => any>(
  subscriptions: Set<T>,
  ...args: Parameters<T>
) {
  subscriptions.forEach((cb) => cb(...args))
}

// —— 演示：自动回收 vs 手动回收 ——
const subs = new Set<() => void>()

// 场景 1：在 scope 内注册（默认行为）
const scope = effectScope()
scope.run(() => {
  addSubscription(subs, () => console.log('A 触发了'))
})
console.log('stop 前，集合大小：', subs.size)   // 1
scope.stop()
console.log('stop 后，集合大小：', subs.size)   // 0 —— 自动回收了

// 场景 2：detached 注册
const scope2 = effectScope()
scope2.run(() => {
  addSubscription(subs, () => console.log('B 触发了'), /* detached */ true)
})
console.log('stop 前，集合大小：', subs.size)   // 1
scope2.stop()
console.log('stop 后，集合大小：', subs.size)   // 1 —— 没被回收，得手动 remove
```

跑一下，你会看到 scope 一停，默认注册的 A 自动消失；而 detached 注册的 B 还活着——这就是「自动 vs 手动」的全部取舍。

## 心智模型：5 步走完整个生命周期

把上面这段代码拆开，整套订阅的运行轨迹是这样的：

1. **注册**：把回调塞进 Set，同时构造一个对应的「取消闭包」。
2. **决定生命周期**：如果当前在某个 effect 作用域里（即 `getCurrentScope()` 有值）并且没声明 detached，就把这个取消闭包挂到作用域的 dispose 队列上——这是「自动回收」的物理实现。
3. **触发**：事件发生时，按 Set 的插入序逐个调用回调，参数透传。
4. **单条取消**：调用取消闭包 → 从 Set 中删该回调 → 如果删成功（确实在），调用清理钩子 `onCleanup`。
5. **整体销毁**：作用域 `stop()` 时跑 dispose 队列，对每条订阅都执行步骤 4；或者 store 自己被销毁时直接 `clear()` 两个 Set——这种情况不需要走单条路径，因为没有附属资源要清理。

把这 5 步对应到实际使用，就是组件 setup 里调 `$subscribe` 时的完整轨迹：回调进 Set → 取消闭包挂到组件 effect scope 的 dispose 队列 → 同时一个 watcher 被创建，它的 stop 函数作为 `onCleanup` 闭包捕获 → 组件 unmount → scope dispose → 取消闭包跑 → 回调被删 → watcher 被停。组件销毁后，store 的 Set 里再没这个回调，watcher 也停了，零残留。

## 五条关键权衡

这一节是整章最值得花时间的部分。这套小工具看着简单，但每一个决定都换来了具体的东西、也付了具体的代价。下面这五条尽量讲透。

### 1. 容器：选 Set，不选数组

**做了什么选择**：用 `Set` 持有回调，而不是 `[]`。

**换来了**：
- **同函数按引用幂等去重**。同一个回调被注册两次，集合里只有一个——这正好符合「store 的订阅不应该重复」的直觉预期。
- **O(1) 的增删**。`Set.add` 和 `Set.delete` 都是常数时间，不需要像数组 splice 那样把后面所有元素往前挪。

**代价是**：
- **回调按引用相等判定**。如果你想用同一个函数注册多个「实例」（比如多个组件复用同一个工具函数做回调），不行——必须自己包一层箭头函数让它们的引用不同。
- **没法按索引寻址**。哪天你想做「只触发最后一个」「替换第三个回调」，Set 直接做不到。

说人话就是：选 Set 是因为它正好命中「按引用去重 + 高频增删」这两个订阅的真实日常，代价是 API 表达力窄了一点，但订阅这个领域本来就不需要索引寻址。

### 2. 默认绑作用域，而不是只丢回一个取消函数

**做了什么选择**：`addSubscription` 内部检测当前是否有 effect scope，有就主动调 `onScopeDispose(remove)`，把回收挂到作用域的 dispose 队列上——这是**默认行为**，detached 才是显式 opt-out。

**换来了**：
- **组件里挂的订阅几乎不会泄漏**。组件的 effect scope 在 unmount 时会被自动 stop，挂着的那条 dispose 钩子会被自动跑，回调被自动删。开发者完全不需要写 `onUnmounted(remove)`。
- **API 表面极简**。调用方根本不需要意识到「作用域」这个概念，只要在 setup 里调，就免费拿到自动回收。

**代价是**：
- **作用域外调用等于裸注册**。在 setup 外、纯工具函数里走默认模式，`getCurrentScope()` 返回 `undefined`，自动回收那条 if 直接短路——这种情况回调永远不会被自动清，必须手动管。Pinia 不报警，调用方得自己知道。
- **默认行为依赖一个隐式约束**：「注册点恰好有 active scope」。这是 Vue 生态常见的隐式上下文模式，但对新手不直观——在异步回调里、setTimeout 里注册，可能拿到一个意外的 scope 或者拿不到 scope。

这个权衡的灵魂是：把「忘了取消」从「常见 bug」变成「几乎不可能」，但代价是「自动」只在正确的调用语境里成立。Pinia 的判断是订阅的 99% 都发生在组件 setup 里，所以默认绑死作用域是高 ROI 的选择。

### 3. 清理钩子作为参数传入，而不是内部决定清理什么

**做了什么选择**：`addSubscription` 的第四个参数 `onCleanup` 默认是 `noop`。这套工具**自己不知道**要清理什么，调用方把清理函数传进来。

**换来了**：
- **彻底解耦**。Pinia 的 state 订阅（`$subscribe`）内部会创建一个 vue watcher，watcher 的 stop 函数作为 `onCleanup` 传进来——而工具本身根本不需要知道 watcher 是什么、长什么样。Pinia 的 action 订阅（`$onAction`）没有附属资源，`onCleanup` 默认就是 `noop`，也乐得清闲。
- **同一套机制复用于「有附属资源」和「无附属资源」两种场景**。容器里只是回调，回调背后挂了什么额外东西，由调用方决定，工具不掺和。

**代价是**：
- **调用方必须主动把资源释放函数传进来**。少传一个参数就泄漏——比如新建了一个 watcher、打开了一个 WebSocket、启动了一个定时器，但没把对应的 stop/close/clear 放进 `onCleanup`，那 scope stop 时回调被删了，但 watcher/Socket/Timer 还留着。

换句话说，工具承诺「订阅会自动消失」，但不承诺「订阅带的所有东西都会自动消失」——后者是调用方的责任。这条边界划得很清楚：工具管 Set 里的回调，调用方管回调附带的资源。

### 4. 取消函数幂等：仅当真的删成功时才调清理钩子

**做了什么选择**：`removeSubscription` 内部用 `Set.delete` 的返回值作为「是否真的删了」的判定——只有删成功（之前确实在集合里）才调 `onCleanup`：

```ts
const remove = () => {
  const deleted = subscriptions.delete(callback)
  if (deleted) onCleanup()
}
```

**换来了**：
- **同一个取消函数可以被反复调用，永远不会触发两次附属资源清理**。这一点为什么重要？因为它可能被同时挂到多个清理队列上——比如既挂了 vue 的 `onScopeDispose`，又挂了组件的 `onUnmounted`。两个都触发时，第二次 `delete` 会返回 false，`onCleanup` 不跑，watcher 不会被 stop 两次。
- **简化调用方的心智**。你不需要保证「只调一次」，调多少次都安全。

**代价是**：
- **清理钩子 `onCleanup` 自己不能假设被调多少次**——实际是 0 或 1。如果调用方传入的 `onCleanup` 做了不幂等的事（比如累加计数、设置状态），就会出问题。Pinia 内部的用法（`stopWatcher`）幂等性是 vue 自己保证的，所以没事；但你扩展时得自己注意。

这条权衡把「幂等性」放在工具这一层，让上层调用方不需要每次都自己包一层「already cleaned」标志位。

### 5. 触发不包 try/catch

**做了什么选择**：`triggerSubscriptions` 的全部实现就是 `subscriptions.forEach(cb => cb(...args))`，没有 try/catch。

**换来了**：
- **错误直白可见**。一个回调抛错，调用栈直接打到抛错点，不会被吞掉、不会被静默记日志。调试时这是巨大的便利——你不需要怀疑「是不是订阅系统吞了我的错」。
- **调用链极简**。没有 catch 块、没有错误转发逻辑、没有「该让一个回调的错影响其他回调吗」这种哲学问题。

**代价是**：
- **一个回调抛错会中断后续回调的执行**。回调 A 抛了，B、C、D 都跑不到。
- 但这里有个隐含判断：订阅集按插入序顺序触发，所以「先注册的先跑」是确定的。如果某个回调会抛错，那本来就该尽早暴露——所以这个「代价」在订阅这个场景下反而是预期行为。

这条换的是**调试体验**。生产环境里你当然可能希望「错一个不影响其他」，但订阅这种「开发者主动挂的回调、用来响应数据变化」的场景，让故障尽早暴露比掩盖更负责。

## 把五条摆在一起看

回头看，你会发现它们都指向同一个判断：**订阅是个低频 API，但每条订阅的生命周期管理风险高**，所以 Pinia 把「自动回收」「幂等」「解耦」放在最优先位置，把「触发阶段的容错」「调用的灵活性」往后放。这正是它选 Set 而不是数组、默认绑作用域而不是只丢回取消函数、清理钩子做成参数、取消做成幂等、触发不包 try/catch 的根本原因。

相比之下，detached 这个 opt-out 选项的存在是另一种声音——它承认「自动回收」不能覆盖全部场景（devtools、跨组件的长期观察者、Pinia 自身的插件机制都需要活得比组件久），所以留了一个口子。代价就是这个口子需要调用方自己负责，工具不会来救你。

## 小结

Pinia 的订阅机制就这一丁点东西：一个 `addSubscription`、一个 `triggerSubscriptions`、一个默认空函数 `noop`。但每一个决定——选 Set、默认绑作用域、清理钩子作为参数、取消幂等、触发不包 try/catch——都换来了具体的能力，也付了具体的代价。

理解了这五条权衡，你以后用 `$subscribe` 和 `$onAction` 时会非常清楚：

- 在组件 setup 里调，自动回收——免费。
- 在 setup 外、工具函数里调，要么传 detached 然后自己管，要么确保有 active scope。
- 注册的回调抛错，会被透传——这通常是你想要的。
- 同一个回调注册两次，集合里只有一个——这通常也是你想要的。

也正因为这套工具足够小、足够通用，它才能在 Pinia 的 store、$patch 的批量通知、action 的 before/after/onError 拦截、devtools 的事件转发里被反复复用——它是这些上层机制共同的「最底层的那块」。
# 测试：以插件重塑 store 行为

写单测的时候你会发现一个尴尬的事实：store 的行为几乎总要被你「改一改」才好测。

比如一个购物车 store，它的 `checkout` action 会真去调支付接口——单测里你绝对不想真发请求，只想断言「它被调了、参数对」；又比如你想直接给状态塞个 `items: 2` 当初始值，省得跑一堆 setup；再或者某个 getter 是只读的，你却想临时把它「冻结」成一个固定值，好去测一个依赖它的分支。

可这些「测试期」才需要的能力，store 本身一个都没有。它没有「测试模式」这个开关。最朴素的冲动是去 fork 一套测试专用 store，或者往核心里塞 `if (测试)` 分支——但这两条路都会把测试的脏东西漏进生产代码。

本章讲 Pinia 的测试库 `@pinia/testing` 是怎么绕开这两条路的。答案很轻巧：**它一个测试专用 store 都不写，全程靠往插件队列里塞几段「重塑逻辑」，在 store 装配完成的那一刻把它的行为就地改掉。**

## 关键转折：插件可以什么都不返回，只动手改 store

要理解这个答案，得先回头看一个前面没怎么强调的插件侧面。

前面两章（插件系统、Store 装配）已经讲透了两件事：插件是一个收 `{ store, app, pinia, options }` 上下文、**返回扩展**、由装配器帮你合并进 store 的函数；装配器在每个 store 装配时，会在该 store 自己的作用域里逐个跑插件队列。这两套机制本章不重演。

这里只看一个被测试库逼出来的新用法。注意插件函数的返回值其实是**可选的**——它完全可以什么都不返回，只拿到刚装配好的 store 引用，就地把它改了。换句话说，插件不一定要「申请加入」，它也可以当成一个**「装配完成回调」**来用：store 一造好，它就被叫一次，趁机把状态合并进去、把某个方法覆盖掉、把某个计算属性换掉。

打个比方。store 像一辆刚下生产线的车，插件系统是生产线末端的一道工位。前面讲的插件用法是「往车上装新配件」——你递一份清单，装配器帮你装好；而测试库的用法是「工人直接上手改车」——轮胎换成测试胎（桩化 action）、油表预设到某个读数（灌初始态）。车的图纸（store 定义）一个字都没动，全是出厂那一刻的现场改造。

这一点点转变是整章的地基。下面看测试库具体塞了哪几段改造。

## 四段重塑，按固定顺序入队

`createTestingPinia` 这个工厂做的事，剥到最简就是：建一个普通 pinia 实例，往它的插件队列里**按固定顺序**塞四段逻辑，再打上一个测试标志、把它设为当前活跃实例。

四段的顺序是钉死的契约：

```
初始态插件 → 用户自传的插件 → 可写 getter 包装 → action/$patch/$reset 桩化
```

两头一看就明白为什么这个顺序不能乱：初始态必须最先，因为后面所有插件读到的状态都该已经是「预设好的」；action 桩化必须**最后**——这点很关键，是后面要讲的一条权衡。

顺序定好后，测试里你照常 `useCartStore()`，装配照常进行，四段插件在「装配完成」那一刻依次拿到刚建好的 store，各改各的。你读到的，就是已经被重塑过的 store。说人话就是：测试和生产走的是**完全相同**的装配路径，只是测试在末端多了几道现场改造工位。

## action 桩化：一个三目覆盖三类可调用对象

桩化逻辑核心就一个三目：

```ts
store[action] = shouldStubAction(stubActions, action, store)
  ? createSpy()                  // 空 spy：原逻辑根本不跑
  : createSpy(store[action])     // 包住原函数的 spy：照跑，但记录调用
```

要么换成「空 spy」——调它什么也不发生，原逻辑被彻底跳过；要么换成「包住原函数的 spy」——原函数照跑，但这次调用被记下来了，事后能断言「调了几次、参数是什么」。

`$patch` 和 `$reset` 也是可调用的，套同一个壳子，只是各自由独立开关控制（默认不桩、只被监视）。`createSpy` 这个名字也值得注意——它不是测试库自己实现的，而是个**工厂**，由调用方提供（探测 jest/vitest 全局拿到 `vi.fn` 或 `jest.fn`）。这点带出一条权衡，下面讲。

## 逃生口：把只读 getter 改成「测试期可写」

这是整章最取巧、也是唯一的「逃生口」。

只读派生值（getter）在生产里是只读的，正常途径你改不了它。但测试里你偏偏想临时冻结它。测试库的办法是：**第四段插件里遍历 store 的原始对象，认出每个 getter（判定手法是「是 ref 且带 `effect`」，这和 storeToRefs 章同源，不重复讲），把每个替换成一个新的可写计算属性。**

这个新计算属性默认完全透明——读它就是读原值，行为一点没变。它的魔法全在 setter 里：

- 给它赋一个**非空值**，它就直捣原计算属性内部，把它**冻结**成这个值；
- 给它赋 `undefined`，它就把原计算属性**恢复**成真计算。

「直捣内部」捣的是哪？Vue 计算属性对象的三个**非公开**字段：缓存值、脏标记、getter 函数句柄。这是整个测试库唯一触碰 Vue 内部实现的地方。下面用一个从零写的迷你版演透它。

### 迷你演示：插件变异 store + 劫持只读 getter

不引真 Vue，手写一个只有三个内部字段的「计算属性」，把本章两条原理演出来：(i) 插件什么都不返回、就地改 store；(ii) 可写包装器靠那三个内部字段在「冻结」和「恢复」之间切换。

```js
// ====== 1. 迷你计算属性：只暴露逃生口要碰的三个内部字段 ======
// 真 Vue 的 ComputedRefImpl 字段更多，但这三个（缓存值 / 脏标记 / getter 句柄）是全部
function computed(getter) {
  const c = {
    _value: undefined,   // 缓存值
    _dirty: true,        // 脏标记：true 表示下次读要重算
    fn: getter,          // getter 句柄：真正干活的函数
    effect: Symbol(),    // 标记「带 effect 的 ref」= 计算属性（识别用）
    __v_isRef: true,     // 假装是个 ref
  }
  Object.defineProperty(c, 'value', {
    get() {
      if (c._dirty) { c._value = c.fn(); c._dirty = false }
      return c._value
    },
  })
  return c
}
const isComputed = (v) => v && v.__v_isRef && 'effect' in v  // 与 storeToRefs 章同源

// ====== 2. 逃生口：把只读计算属性换成可写包装器 ======
function writableOverride(original) {
  const originalFn = original.fn           // 先存住真 getter
  const freezeFn = () => original._value   // 冻结态 getter：永远吐缓存值
  return {
    __v_isRef: true,
    effect: Symbol(),
    get value() { return original.value },          // 读：默认完全透传
    set value(newValue) {
      if (newValue === undefined) {
        // 恢复真计算：换回原 getter、清缓存、置脏强制重算
        original.fn = originalFn
        delete original._value
        original._dirty = true
      } else {
        // 冻结成 newValue：getter 换成「返回缓存值」、缓存值直接置为 newValue
        original.fn = freezeFn
        original._value = newValue
      }
    },
  }
}

// ====== 3. 迷你 store 定义（纯生产代码，零测试分支）======
function createCartStore() {
  const state = { count: 0 }
  return {
    $id: 'cart',
    $state: state,
    totalPrice: computed(() => state.count * 10),  // 只读 getter
    checkout() { state.count = 0; return 'paid' }, // action（含网络副作用）
  }
}

// ====== 4. 迷你装配器：跑完 setup 后逐个跑插件 ======
function assemble(setup, plugins) {
  const store = setup()
  for (const plugin of plugins) plugin({ store })  // 插件什么都不返回，就地改
  return store
}

// ====== 5. 迷你 testing pinia：预装三段重塑插件（顺序与真库一致）======
function createTestingPinia({ initialState = {}, stubActions = true } = {}) {
  const plugins = []
  // 插件 1：灌初始态（就地合并 state）
  plugins.push(({ store }) => {
    if (initialState[store.$id]) Object.assign(store.$state, initialState[store.$id])
  })
  // 插件 2：可写 getter 包装（认出 getter，换成可写包装器）
  plugins.push(({ store }) => {
    for (const key of Object.keys(store))
      if (isComputed(store[key])) store[key] = writableOverride(store[key])
  })
  // 插件 3：action 桩化（刻意排最后）
  plugins.push(({ store }) => {
    if (stubActions) store.checkout = () => 'stubbed' // 空 spy：不跑原逻辑
  })
  return plugins
}

// ====== 6. 跑一遍 ======
const plugins = createTestingPinia({ initialState: { cart: { count: 5 } }, stubActions: true })
const store = assemble(createCartStore, plugins)

console.log(store.$state.count)       // 5          —— 初始态已灌入
console.log(store.totalPrice.value)   // 50         —— 真计算（5 × 10）
console.log(store.checkout())         // 'stubbed'  —— 原逻辑没跑

store.totalPrice.value = 999          // 冻结只读 getter（逃生口）
console.log(store.totalPrice.value)   // 999        —— 冻结成 999
store.totalPrice.value = undefined    // 恢复
console.log(store.totalPrice.value)   // 50         —— 又变回真计算
```

这段脚本演透了两件事：第一，`createTestingPinia` 塞进去的三段插件**返回值都是 `undefined`**，它们只就地合并状态、换掉方法、换掉计算属性——这正是「插件当装配完成回调」，store 定义里没有任何测试分支；第二，给只读 getter 赋一个值就冻结、赋 `undefined` 就恢复，靠的全是手写计算属性那三个内部字段。真 Vue 的计算属性内部字段更多，但逃生口碰的就这三个，原理一模一样。

## 关键权衡

这一章机制密集，我们看四条。

**1. 选择「预装一组插件在装配期重塑 store」，而非「写测试专用 store 或核心测试分支」。** 换来的最大好处是核心零污染：测试和生产走的是**完全相同的装配路径**——你在测试里测到的，就是生产行为本身，不会出现「测试代码路径和生产不一样」导致的假绿。代价是重塑只能发生在「装配完成那一刻」这个固定时机，所有改写都得挤进这个窗口：初始态靠此刻合并进状态对象、action 桩化靠此刻直接覆盖方法上的函数。装配**之后**你再想随手改某个 action，已经来不及了——窗口一过即关闭。

**2. 选择「把桩化与监视统一表达成 spy 包裹」。** 一套配置（全桩 / 指定名字桩 / 仅监视不桩）同时覆盖 action、`$patch`、`$reset` 三类可调用对象，统一得很干净。代价是它要求使用者**必须**提供一个 spy 工厂——少了直接抛错，传错了（传了一个已经调用过的 spy 实例，而不是工厂函数本身）也直接抛错，不给任何静默降级。换句话说，这套统一的前提是「使用者懂且只懂提供工厂」，错一点都不将就。

**3. 选择「让 action 桩化插件刻意排在队列最末」。** 这是为了让它能覆盖更早插件（比如可观测层对 action 的代理包裹）对 action 的改写，保证「测试桩说了算」——不管前面谁动过 action，最后落地的一定是测试桩。代价是插件入队顺序成了一个**隐式契约**：用户自传的插件一律插在测试重塑插件**之前**，你想后置覆盖测试行为？做不到，顺序被钉死了。

**4. 选择「为『覆盖只读 getter』这个本不该可能的能力，直捣响应式计算属性的内部实现」。** 换来测试里能临时把一个只读派生值冻结成任意值、且事后能恢复成真计算——这是写测试时特别顺手的能力，正常途径根本做不到。代价是它依赖 Vue 计算属性**非公开**的三个内部字段（缓存值、脏标记、getter 句柄）。这是整个测试库唯一的逃生口：押的是「Vue 这几个内部字段别动」，一旦未来 Vue 改了它们的实现，这条能力就失效。它换的是「现在能用」，赌的是「内部别变」。

## 收束

回头看，`@pinia/testing` 没有新写任何测试专用 store，也没在核心里留测试分支。它的全部本事，就是把测试需要的那些「改写行为」，翻译成「在 store 装配完成那一刻插入的几段重塑逻辑」——而这个插入点，恰好就是现成的插件机制。

这背后是一个挺干净的判断：测试人体工学不必动核心，搭在已有的装配机制上就够了。核心为了配合测试，只让了两步极小的步——一个在装配期设上的测试标志，核心只在两处读它（让 `useStore` 在测试模式下忽略传入的 pinia 参数、让可观测层在测试模式下不重包 action），没有第三处。除那个碰 Vue 内部字段的逃生口外，整条测试链路都走在公开、稳定的机制之上。

也正因为如此，这一章适合放在最后：它不是又一个新机制，而是把前面攒下来的「插件」「装配」「计算属性识别」原样拼起来——拼得动，就说明这些机制搭得够稳、留的扩展点够好，好到「为测试而重塑行为」这么折腾的事，都不用动核心一根毛。
---
title: Options Store：声明式三分与统一组装
---

# Options Store：声明式三分与统一组装

> 本章属于 composite 层。前置：Setup Store 的运行时自动分流。
> 学完你能：用一句话讲清「两种写法为什么共用一套组装引擎、这层翻译付出了什么时序代价」。

## 1. 为什么需要它

上一章讲了组合式写法怎么被装成 store：引擎遍历 setup 返回的每个属性，按响应式特征自动分成状态、计算属性、动作三类。那套引擎很自在，你随手 return 一堆 ref 和函数，它照单全收。

但 Pinia 还有一大批用户完全不这么写。他们习惯传统状态库的写法，把 state、getters、actions 分三个字段摆好：

```ts
defineStore('counter', {
  state: () => ({ count: 0 }),
  getters: { double: (s) => s.count * 2 },
  actions: { inc() { this.count++ } },
})
```

这种声明式写法的好处很实在：状态形状一眼可见，从旧状态库迁移过来几乎不用改思路，还天然支持「一键重置回初始值」。组合式写法这些都没有，它换来的是另一份自由——像写组合式函数一样随手 return，想怎么组织就怎么组织。

矛盾也正在这里。如果内核为这两种写法各维护一套组装逻辑，行为迟早会漂移：修了一种写法的 bug、忘了另一种，两边慢慢长成两个样子。用户真正要的从来不是「两套引擎」，而是「不管我怎么写，背后都是同一个 store」。

本章要解决的，就是让声明式写法也走上一章那套引擎，而不为它另起炉灶。

## 2. 核心思想

把「怎么写」和「怎么装」解耦。

组装引擎只认一种中间形态：一个由 ref、computed、普通函数拼成的对象。那么办法就很清楚了——在引擎前面加一层极薄的翻译，把声明式的三分各自映射成引擎本就能消化的形态（状态拆成一个个独立 ref、计算属性包成 computed、动作原样保留），拼成一个对象当作「组合式返回值」交差。引擎依旧只有一套，两种写法在它眼里毫无分别。

打个比方，厨房只有一条流水线，只看得懂一种点单格式：一份份标好的菜品。顾客却习惯两种点法，套餐（前菜、主菜、甜点分开点）和自助（随手拿）。与其再开一条流水线，不如让服务员把套餐翻译成同样的菜品清单，照样交给这一条流水线。

这层翻译做完，剩下的全是上一章那套引擎的活。

## 3. 心智模型

声明式 store 从定义到成型，数据是这样流动的：

1. **分流**：首次真正用到 store 时，看 defineStore 的第二个参数是不是函数。是函数走组合式路线；不是（是个 options 对象）走声明式路线。这一判只发生在首次实例化，对应第 4 章讲的懒装配。
2. **状态落树**：声明式路线先进翻译层。把用户写的 `state()` 执行一次，结果直接写进集中状态树对应那个坑位（第 2 章的集中树）。注意，状态在翻译层就已经进树了，不劳引擎操心。
3. **状态拆分**：把刚写进树的那棵对象用 `toRefs` 拆开，每个属性变成一个 ref，但这些 ref 全都指向树里同一棵对象。拆出来的产物，和组合式写法里手写的 `ref()` 在引擎眼里分不出区别。
4. **动作原样**：actions 是什么就还是什么，一袋普通函数，直接并入返回值。
5. **getter 包 computed**：每个 getter 被包进一个 computed。关键是 computed 内部不闭包引用 store（此时 store 还没成型），而是在被人读取的那一刻，临时把活跃指针拨回本 pinia（第 3 章的指针，这里看它的一个新侧面：求值时机已经离开了首次装配的同步上下文，必须显式重设），再去注册表里捞「那个刚登记进来的实例」（第 4 章的注册表，这里看它的一个新侧面：getter 靠它，在 store 尚未装配完成时就能自洽地引用自己），拿这个实例同时当 this 和第一个参数来跑 getter。这样一来，getter 之间、getter 和状态之间就能互相引用。
6. **拼装交差**：把「状态 refs + 动作 + getter computeds」assign 成一个对象，这就是翻译层交出去的「组合式返回值」。
7. **引擎分流 + 短路**：带着一个「我是声明式」的标志，把这个返回值丢给上一章的引擎。引擎照常按响应式特征分流；但因为状态已经在树里，引擎里那段「把每个 ref 同步回状态树」的回流对声明式是多余的，靠标志位短路掉；又因为状态形状预先已知，引擎顺手给声明式挂上 `$reset`。

贯穿全程的不变量：两种写法在进入引擎那一刻，返回值结构是同构的，都是「一堆 ref + 一堆 computed + 一堆函数」。引擎从头到尾不需要知道自己正在装的是哪一种。

## 4. 关键权衡

翻译层只做了一件事：在进入引擎之前，把声明式的输入预先整形成已知形态。这个「预先整形」同时带来一个代价和一个红利，是同一枚硬币的两面。

### 翻译成组合式返回值，而不是另起一套组装流水线

**选择**：不为声明式写法再写一套组装逻辑，而是在引擎前面加翻译层，把三分翻译成组合式返回值。

**换来**：组装引擎只有一套，两种写法的行为完全一致。引擎修一个 bug，两种写法同时受益；组合式那边新加的能力（插件、订阅、开发者工具），声明式这边白捡。

**代价**：getter 被包进 computed 的时机太早。翻译层在 store 还没成型时就把每个 getter 包成了 computed，此刻外面那个 store 变量还是空的，computed 内部根本闭包不到它。于是 getter 不能「直接拿 store」，只能在被人读取的那一刻，临时去注册表里捞「那个刚登记的实例」。这是一个时序倒挂：定义在前，引用在后。源码里作者甚至留了一句 TODO，承认这个「求值时再去注册表取实例」的设计还有改进空间，但当前就是这么兑现的。

**它化解的本质矛盾**：你想复用同一套装配逻辑，但翻译产物（getter 的 computed）又必须先于装配生成。凡是「在构造一个对象的过程中、预先生成一批回调，而这些回调还要引用这个对象本身」的场景，都会撞上同一道坎——前向引用。破法只有一个：别让回调直接抓对象，给它一个能在事后定位到对象的中转，这里就是注册表。这个骨架你在第 4 章的循环引用破解里见过，在模块初始化顺序、任何「构造期自引用」的地方都会再见到。

### 状态形状预先已知，换来自动重置

**选择**：声明式要求用户用一个 `state()` 函数交出完整的初始状态。

**换来**：引擎天然知道这个 store 的初始形状。重置几乎免费：把 `state()` 再执行一次，拿到一份全新的初始状态，用它整体覆盖当前状态。而且这次覆盖被刻意走批量写入的管道，把所有字段变更合并成一次订阅事件，订阅者不会被逐字段赋值反复唤醒。

**代价**：组合式写法享受不到这份红利。它的状态是 setup 里一堆散落的 `ref()`，引擎无从得知完整形状，更不可能凭空再造一份初始值。于是组合式的 `$reset` 在开发期直接抛错（错误文案就明说「setup 语法没有实现 `$reset`」），生产期是空操作。想重置，得用户自己在 action 里手写。

**它化解的本质矛盾**：自动化服务依赖完整的元信息，而自由写法天生不提供元信息。声明式用「强制交出 state 函数」换来了「引擎替你重置」的便利；组合式用「随手 return」换来了写法自由，代价是把重置的活儿还给了用户。这条矛盾很普适：ORM 想自动回滚就得有 schema，迁移工具想 undo 就得有 baseline。你无法自动还原一个自己从未知晓的初始形态。声明式用约束换自动化，组合式用自由换手工，两边都公平。

## 5. 最小原理演示

这段演示演三件事：状态函数如何进树再拆成 ref、getter 如何靠运行时去注册表取实例来兑现「定义在前、引用在后」、以及重置为什么只青睐声明式。响应式原语用最简 mock，重点全在翻译层和那套共用的组装引擎。

```ts
// 极简响应式 mock（道具，非本章重点）
function ref(value) {
  return { __isRef: true, get value() { return value }, set value(v) { value = v } }
}
function computed(getter) {
  // 演示用：每次读取都重算，足以表达「求值被推迟」即可
  return { __isRef: true, get value() { return getter() } }
}
const isRef = (o) => o && o.__isRef === true

// 容器：集中状态树 + 注册表 + 活跃指针（第 2/3/4 章的原语）
const pinia = { state: { value: {} }, _s: new Map() }
let activePinia = pinia
const setActivePinia = (p) => { activePinia = p }

// 把对象的每个属性变成「指向同一对象」的 ref——拆分产物与手写 ref 无差别
function toRefs(obj) {
  const out = {}
  for (const key of Object.keys(obj)) {
    out[key] = {
      __isRef: true,
      get value() { return obj[key] },
      set value(v) { obj[key] = v },
    }
  }
  return out
}

// 共用的组装引擎（分流逻辑第 5 章已讲透；这里只演「声明式跳过回流」）
function createSetupStore(id, setup, isOptionsStore) {
  pinia._s.set(id, {})                             // 先登记一个空壳：getter 稍后从这里取实例
  if (!isOptionsStore) pinia.state.value[id] = {}  // 组合式：树里还没坑位，补一个；声明式已由翻译层填好
  const returned = setup()                         // 执行翻译层交来的 setup，拿返回值
  const store = pinia._s.get(id)                   // 取回那个空壳，往上面挂成员
  for (const key in returned) {
    const prop = returned[key]
    if (typeof prop === 'function') {
      store[key] = prop                            // 动作：原样挂上
    } else if (isRef(prop)) {
      // 状态：声明式已天然在集中树里，引擎里那条「把 ref 同步回树」的回流对它多余，靠标志位跳过
      if (!isOptionsStore) pinia.state.value[id][key] = prop
      Object.defineProperty(store, key, {
        get: () => prop.value,
        set: (v) => { prop.value = v },
      })
    }
  }
  return store
}

// 翻译层：声明式三分 → 组合式返回值（本章主角）
function createOptionsStore(id, { state, getters, actions }) {
  const setup = () => {
    pinia.state.value[id] = state ? state() : {}                   // 状态：执行一次，写进集中树
    const localState = toRefs(pinia.state.value[id])               // 拆成独立 ref
    const computedGetters = {}
    for (const name of Object.keys(getters || {})) {
      // 每个 getter 包成 computed：求值那一刻才去注册表捞实例（定义在前、引用在后）
      computedGetters[name] = computed(() => {
        setActivePinia(pinia)                                      // 求值时重设活跃指针（第 3 章新侧面）
        const store = pinia._s.get(id)                             // 运行时取刚登记的实例
        return getters[name].call(store, store)                    // store 既当 this 又当首参，getter 间可互引
      })
    }
    return Object.assign({}, localState, actions || {}, computedGetters) // 拼成「组合式返回值」
  }
  const store = createSetupStore(id, setup, /*isOptionsStore*/ true)
  // 状态形状预先已知 → 自动挂重置：再跑一次 state()，整体覆盖回去
  store.$reset = function () {
    Object.assign(pinia.state.value[id], state ? state() : {})     // 走批量写入的缩影，完整管道在下一章
  }
  return store
}

// 对比：组合式写法走同一条 createSetupStore，却拿不到重置
function createSetupStyleStore(id, setup) {
  const store = createSetupStore(id, setup, /*isOptionsStore*/ false)
  store.$reset = () => { throw `🍍: "${id}" 用 setup 语法，引擎无从知晓初始形状` }
  return store
}
```

跑一遍两种写法：

```ts
// 声明式定义
const useCounter = () => createOptionsStore('counter', {
  state: () => ({ count: 0 }),
  getters: { double() { return this.count * 2 } },   // getter 借 this 引状态
  actions: { inc() { this.count++ } },
})
const c = useCounter()
console.log(c.count, c.double)   // 0, 0
c.inc()
console.log(c.count, c.double)   // 1, 2   —— double 自动跟着变
c.$reset()
console.log(c.count, c.double)   // 0, 0   —— 重置：再跑一次 state()

// 组合式定义：同一个组装引擎
const useSetup = () => createSetupStyleStore('setup', () => ({
  count: ref(0),
  inc() { this.count++ },
}))
const s = useSetup()
s.inc()
s.$reset()   // 抛错：setup 语法无法自动重置
```

## 6. 执行轨迹

拿上面那个计数 store 放慢动作走一遍，重点看每一步状态长什么样。

输入是声明式定义的 `useCounter`：state `{ count: 0 }`、getter `double = count*2`、action `inc()`。

首次调 `useCounter()`：引擎先在注册表里给 `'counter'` 挂一个空壳。翻译层随即执行 `state()`，集中状态树 `pinia.state.value['counter']` 写成 `{ count: 0 }`。接着 `toRefs` 把它拆成 `{ count: <指向树里同一对象的 ref> }`，此刻这个 ref 的 `.value` 读到的就是树里的 0。`double` 被包成 computed，但 computed 里的代码一行都没跑，只是「记下了将来怎么算」。三者拼成 `{ count, inc, double }` 交给引擎。引擎看到 count 是 ref，归为状态（标志位声明式，跳过回流，因为它本来就在树里）；inc 是函数，归为动作；double 是 computed，归为计算属性。

这时去读 `c.count`、`c.double`：count 直接读到 0；double 才第一次求值，重设活跃指针、去注册表捞到刚成型的 store、跑 `this.count * 2` 等于 0。

调 `c.inc()`：`this.count++` 把树里的 count 从 0 改成 1。再读 `c.double`，computed 重新算一遍得到 2，依赖自动跟上。

调 `c.$reset()`：再跑一次 `state()` 拿到全新的 `{ count: 0 }`，整体覆盖进树，count 回到 0，double 再算得 0。这一步在真实 Pinia 里走的是 `$patch` 管道，所有字段变更合并成一次订阅事件。`$patch` 本身是下一章的主角，这里只当它一个会整体覆盖的黑盒。

换成组合式写法（同样那条 `createSetupStore`）：定义 `() => ({ count: ref(0), inc() {...} })`，引擎照样分流成状态、动作，store 也能正常读写。但调 `$reset()` 时，引擎手里没有 `state` 函数、不知道初始形状，开发期直接抛错。同一条流水线、产出同构的 store，重置能力却有和无，差别只在于翻译层有没有把「初始形状」这份元信息一起递进去。

## 7. 教学简化说明

本章演示故意砍掉了这些：热更新（声明式 getter 要重新包 computed、组合式直接搬运的差异）、开发者工具载荷里「存原始 getter 函数」与「存 computed 本身」的差别、`markRaw` 包裹 computed 以避免被外层 reactive 二次代理的微优化、动作拦截与订阅、`$patch` 的深合并细节、服务端水合、插件扩展，以及完整泛型。它们要么属于别的章，要么是工程化脚手架，不影响「翻译后共用一套引擎」这条主线。

## 8. 小结

声明式和组合式看着是两种写法，内核里却只有一条流水线，靠一层翻译把声明式的三分变形成引擎认识的中间形态。这层翻译的代价是 getter 不得不延后到运行时去注册表取实例，红利则是状态形状已知，顺手换来了自动重置。而重置里用到的 `$patch`，把一堆字段变更合并成一次订阅事件，本身就是另一套值得一讲的管道，那就是下一章。

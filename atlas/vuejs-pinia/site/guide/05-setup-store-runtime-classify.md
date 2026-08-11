---
title: Setup Store 的运行时自动分流
---

# Setup Store 的运行时自动分流

> 本章属于 composite 层。前置：「defineStore 的懒装配与循环引用破解」「随作用域清理的发布订阅」。
> 学完你能：用一句话讲清 Pinia 为什么不在 setup 的返回值上贴标签、而是靠响应式指纹在运行时分流，以及这份自由换来了什么代价。

## 1. 为什么需要它

上一章讲了 defineStore 怎么把 store 的真正创建推迟到首次调用：工厂只返回一个 useStore，真正调用时才先把半成品登记进注册表、再跑 setup，以此破解多个 store 互相引用时的死循环。这套时序留下了一个口子——setup 跑完，返回的是一袋**没有任何标签**的属性，框架怎么知道哪个该当状态管、哪个该当动作管？本章就来填它。

先看这袋属性长什么样。用 Setup Store 的写法定义一个计数器，你会这样写：

```ts
const useCounter = defineStore('counter', () => {
  const count = ref(0)
  const double = computed(() => count.value * 2)
  function inc() { count.value++ }
  return { count, double, inc }
})
```

`return` 出来的 `{ count, double, inc }` 里有状态、有计算属性、有动作，但没有任何一个字段写明了「我是状态」「我是动作」。这恰恰是 Setup Store 的卖点：写 store 就跟写一个普通的组合式函数一模一样，返回什么、返回几样，完全随意。

可框架内部偏偏必须把这三类分开处理：

- **状态**要挂到那棵集中状态树上（容器层那一章已交代过这棵树），这样订阅、批量合并、SSR 序列化才有统一的事实源。
- **动作**得套上一层监听包装，好让 `$onAction` 能在每次调用前后插钩子。
- **计算属性**要能被开发者工具认出来，单独归类展示。

矛盾就摆在这儿：用户想要组合式写法的自由，不爱贴标签；框架却必须按类别分别处理。**运行时自动分流**正是夹在中间的化解层：既不让用户多写一个字的标签，又能在 setup 返回之后悄悄把这袋属性分拣好。

## 2. 核心思想

化解的办法不是逼用户贴标签，而是让每个值自带的可观测特征替它说话。一个 `ref`、一个 `computed`、一个函数，落到内存里长得就不一样，这些差别就是值自带的「指纹」。引擎只要在 setup 返回之后，逐个属性看一眼它的指纹，就能把状态、计算属性、动作归到各自的堆里。

换句话说，分类的依据从「声明时由用户写标签」挪到了「运行时由值自带的可探测特征」。用户写的时候照旧自由，分类的活儿全挪到返回值成型之后那一遍遍历里完成。

## 3. 心智模型

整个分流发生在一个 `for...in` 循环里。setup 返回的对象（下文叫**属性袋**）的每个自有键，都会被取出来探一次指纹，走进三条互斥分支之一：

- **状态分支**：值是 `ref`（但不是计算属性），或者是个 `reactive` 对象。
- **计算属性分支**：值是 `ref`，且身上挂着一个响应式副作用对象（`effect`）。
- **动作分支**：值是函数。

这里有个关键的判别基石，单独拎出来说：**计算属性本质就是一个「带 effect 的 ref」**。`computed()` 造出来的东西，对外看是个 ref，对内却挂了一个用于追踪依赖的 effect 对象。所以判定计算属性，就是看一个 ref 上有没有这个 effect——有就是计算属性，没有就是普通状态。这一步是整条分流链的入口：计算属性本身也是 ref，必须先用「带不带 effect」把它从 ref 堆里剔出去，否则它会被误当成状态塞进集中状态树，跟着参与序列化和深度订阅，语义就错了。

分完类之后，三堆各有去处：

- 状态按**同一个引用**写入集中状态树对应槽位，不拷贝；
- 动作原地替换成一个包装函数；
- 计算属性在生产构建里不做任何特殊处理，直接随最后的全量合并进 store（显式的计算属性登记只存在于开发构建，给 devtools 和热更新用）。

最后，整个属性袋合并到那个已经登记过的 reactive 半成品外壳上，store 就成型了。整套流程一句话：先跑 setup 拿到无标签属性袋，再逐个探测指纹分进三类，各归各位。

## 4. 关键权衡

### 不加标签，靠响应式指纹分流

这是本章的灵魂取舍。

**选择**：不给 setup 的返回值加任何声明式标签，纯靠值的响应式指纹在运行时分类。

**换来**：Setup Store 的写法完全自由——你 return 几样、return 什么、用什么响应式原语，框架都不过问。一个 store 的定义在语法上就是一个普通的组合式函数，跟你在别处写的 `useMousePosition`、`useFetch` 没有任何区别。这份「无差别」正是 Setup Store 能跟整个组合式生态无缝拼装的前提。

**代价**落在两个地方。第一，三类的边界要到运行时才知道，类型层面没法预先约束——TypeScript 只能靠条件类型反推 setup 的返回，没法在定义处就规定「这个键必须是状态」。第二，更实在的一个代价：`$reset` 在 Setup Store 下没法自动实现。重建初态需要一份「初始状态的声明式描述」，可引擎从头到尾都没拿到过这么一份东西，它只在运行时见到了一袋已经 new 出来的 ref。所以 Setup Store 的 `$reset` 只能抛错或留空。下一章会看到，Options Store 因为状态形状是预先声明好的，`$reset` 能自动生成；这份能力正是用灵活性换走的。

这里还藏着一个更隐蔽的代价：那条判别基石「ref 上挂没挂 effect」本身，依赖的是响应式库的**内部实现细节**。哪天底层响应式系统换了计算属性的实现方式，这条判定就得跟着改。这是为换得「零标注」而默默承担的隐式耦合。

**本质矛盾**：组合式写法的自由（return 什么都行）与框架按类别分别处理（状态挂集中树、动作套钩子）之间的对立。运行时指纹探测给出的通解是——只要每个值自带可探测的类型特征，分类就不必依赖用户声明，而可以延迟到运行时按特征反推。这条骨架在任何「想要自由输入、又必须按类型分派处理」的场景里都认得出来。

### 所有函数无差别套上动作包装

第二条取舍发生在动作分支里。

**选择**：凡是函数，一律套上一层包装，挂上订阅通知、并在调用时复位活跃指针；唯一的例外是已经被用户主动用 `action()` 助手包过的函数（靠一个内部 Symbol 标记识别，保证重复包装是幂等的）。

**换来**：`$onAction` 对 setup 里**任何一个**函数都统一生效——哪怕是你写在 store 内部、只供别的动作调用的私有辅助函数，它的每次调用也能被订阅者捕获。监听能力的完备性是拿来即用的，不用用户额外声明「这几个才算动作」。

**代价**：即便你写的是一个跟状态毫无关系的纯工具函数，它也会被当成动作上报，带来轻微的调用开销和一点概念污染（在 devtools 里它会和真正的业务动作混在一起）。另外，包装层为了不漏掉异步动作，必须同时处理同步返回和 Promise 两条路径：同步走完直接触发「后置」钩子，Promise 则 `.then` 触发后置、`.catch` 触发出错钩子。

**本质矛盾**：监听的统一完备（任何函数调用都可被捕获）与函数职责的区分（工具函数本不该算动作）之间的对立。这条权衡选了前者、接受了后者，因为它换来的「`$onAction` 全覆盖」在调试和可观测性上的价值，远超偶尔误报一个工具函数的成本。

顺带交代一句：包装层里用的订阅触发和那一套「前置/后置/出错」的回调收集，复用的是「随作用域清理的发布订阅」那一章讲透的订阅原语，本章不重讲。

## 5. 最小原理演示

下面这段代码只演一件事：怎么只凭响应式指纹，把一袋无标签返回值分进三类；再附一个极简的动作包装，演示「函数无差别套壳 + 前后通知」。它是把上面的原理点看清楚的道具，不是一份能用的工程实现。

```ts
import { ref, reactive, computed, isRef, isReactive } from 'vue'

// 计算属性的指纹：是个 ref，且身上挂着响应式副作用对象 effect
function isComputed(o: any): boolean {
  return !!(isRef(o) && o.effect)
}

// 动作包装：调用前后触发订阅，同步与 Promise 两路分别处理
function wrapAction(fn: Function, name: string, subscribers: Function[]) {
  const wrapped = function (this: any, ...args: any[]) {
    // 前置通知：把这次调用的事故现场推给所有订阅者
    const ctx = { name, args, after: [] as Function[], onError: [] as Function[] }
    subscribers.forEach((cb) => cb(ctx))
    const ret = fn.apply(this, args)
    if (ret instanceof Promise) {
      // 异步动作：等 resolve 再触发后置，reject 则触发出错
      return ret
        .then((v) => { ctx.after.forEach((cb) => cb(v)); return v })
        .catch((e) => { ctx.onError.forEach((cb) => cb(e)); throw e })
    }
    ctx.after.forEach((cb) => cb(ret))   // 同步动作：直接触发后置钩子
    return ret
  }
  ;(wrapped as any).__action = name      // 幂等标记：已包过的不再重包
  return wrapped
}

// 把一袋无标签返回值分成三堆，核心就在这个循环里
function classify(bag: Record<string, any>, actionSubscribers: Function[]) {
  const state: Record<string, any> = {}
  const getters: Record<string, any> = {}
  const actions: Record<string, any> = {}
  for (const key in bag) {
    const prop = bag[key]
    if ((isRef(prop) && !isComputed(prop)) || isReactive(prop)) {
      state[key] = prop                              // 状态：原样按引用回填集中状态树
    } else if (isComputed(prop)) {
      getters[key] = prop                            // 计算属性：靠「ref 上挂着 effect」挑出来
    } else if (typeof prop === 'function') {
      actions[key] = wrapAction(prop, key, actionSubscribers)  // 动作：无差别套上包装
    }
  }
  return { state, getters, actions }
}
```

把计数器的返回值丢进去，就能直观看到指纹分流的效果：

```ts
const subscribers: Function[] = []           // 模拟 $onAction 注册的订阅者
const count = ref(0)
const bag = {
  count,
  double: computed(() => count.value * 2),   // computed 造出来时就自带 effect
  inc() { count.value++ },
}
const { state, getters, actions } = classify(bag, subscribers)
// 结果：state = { count }, getters = { double }, actions = { inc(已包装) }
// count 是 ref 且无 effect → 状态；double 是 ref 且带 effect → 计算属性；inc 是函数 → 动作
```

读者可以把 `double` 从 `computed(...)` 换成 `ref(0)`，它会立刻从 `getters` 堆跳到 `state` 堆。这一跳，就是「运行时指纹探测」全部的魔法。

## 6. 执行轨迹

拿首次调用 `useCounter()` 走一遍，看那袋属性怎么各归各位。

setup 返回 `{ count: ref(0), double: computed(...), inc }`，引擎进入分流循环：

1. 遍历到 `count`。`isRef(count)` 为真、`count.effect` 不存在，命中状态分支。引擎执行 `pinia.state.value['counter'].count = count`，把用户在 setup 里 new 出来的那个 ref **按同一个引用**写进集中状态树。从这一刻起，setup 闭包里的 `count` 和集中状态树里的 `count` 指向同一个对象，改一处即改两处。这就是「集中树是唯一事实源」的实现方式。
2. 遍历到 `double`。`isRef(double)` 为真、`double.effect` 存在，不进状态分支，落到计算属性分支。生产构建里这分支什么都不做，`double` 只是稍后随全量合并进 store；开发构建里它会登记进给 devtools 用的名册。
3. 遍历到 `inc`。`typeof inc === 'function'`，命中动作分支。引擎用 `action(inc, 'inc')` 包一层，把 `setupStore.inc` 原地替换成包装函数，同时记进一份供插件读取的动作名册。
4. 循环结束，`assign(store, setupStore)` 把整袋属性合并到 reactive 半成品外壳上，store 成型。

下游再看一次分类的后果。外部调用 `store.inc()` 时：包装函数先 `setActivePinia(pinia)` 复位活跃指针（让动作内部跨 store 的调用能找回所属实例），接着触发动作订阅，把 `{ name: 'inc', args, after, onError }` 推给所有 `$onAction` 订阅者，这是前置通知；然后执行原始的 `inc`，`count.value++`；因为是同步返回，直接触发 `after` 回调。若动作返回的是 Promise，则改走 `.then` / `.catch` 两路分别触发后置与出错钩子。

## 7. 教学简化说明

本章演示故意省略了这些与「分流」原理无关的东西：副作用作用域对整个 store 的托管（属容器与状态树章）、SSR 水合时的边缘判定（标记某些「有状态外表但并非状态」的对象跳过水合，属 SSR 章）、`assign(toRaw(store), ...)` 那一步为配合解构工具做的额外合并、`$patch` / `$subscribe` 的内部管道（属变更双管道章），以及插件扩展与热更新用的登记簿。它们都是分流之后的工程化脚手架，不影响「靠指纹分类」这条主线。

## 8. 小结

分流这一步做的事，说到底就是把「一袋没贴标签的返回值」变成「框架能按类别分别处理的有序结构」，而它付出的代价，是放弃了一份预先声明的状态形状。下一章会看到 Options Store 走了相反的路：状态、计算属性、动作在定义时就声明得清清楚楚，于是它能反过来复用同一套组装引擎，还顺手把 Setup Store 放弃的 `$reset` 自动补了回来。

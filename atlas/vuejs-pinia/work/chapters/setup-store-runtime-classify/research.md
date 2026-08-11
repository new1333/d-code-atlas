# Setup Store 的运行时自动分流 · 源码精读

## 给 Writer 的教学钩子（必填，8 子项缺一不可）

- **用户痛点 / 场景**：用组合式写法定义一个 store 时，用户只是 `return` 了一堆 `ref()`、`computed()`、普通函数、`reactive()`——没有任何标签说明"这个是状态、那个是计算属性、那个是动作"。但框架内部必须把这三类区分开：状态要被集中管理、可被订阅与序列化；动作要能被监听（前置/后置/出错钩子）；计算属性要能被开发者工具识别。如果逼用户手写标签，就丧失了组合式写法的自由；如何既保自由又自动归类，是这一机制要解决的痛点。

- **一句话核心思想**：靠值自身的响应式指纹做运行时探测，把一袋无标签返回值自动归入"状态 / 计算属性 / 动作"三类。

- **设计动机（为什么需要它）**：Setup Store 的卖点是把 store 写得和一个普通组合式函数一模一样，返回什么、返回几样完全自由。但这份自由与"框架需要按类别分别处理"产生矛盾——状态必须挂到集中状态树（供订阅、批量合并、SSR 序列化统一使用），动作必须套上监听钩子。运行时分流正是化解这一矛盾的中间层。承前：它建立在「懒装配」章已建立的时序之上——工厂首次调用时先把只含基础 API 的半成品登记进注册表、再跑 setup（前置章已讲透"为何要先登记"是为了破解 store 间循环引用，本章不重讲）；本章只看 setup 返回之后，引擎如何对这袋属性分类。分类完成后，动作的「前置/后置/出错」通知复用「发布订阅」章的订阅原语，本章只看"何时包、为什么所有函数都包"，不重讲订阅原语本身。

- **关键权衡**：
  1. **运行时探测 vs 声明式标签**：选择「不给返回值加标签，纯靠值的响应式指纹分流」→ 换来 setup 写法完全自由、与原生组合式 API 无缝一致、store 定义就是一个普通 composable → 代价是三类的边界要到运行时才知道，类型层面无法预先约束（TS 只能靠条件类型反向推断 setup 的返回类型），且 `$reset` 无法自动实现（状态形状未预先声明，引擎不知道如何重建初始态）。
  2. **用「带响应式副作用的 ref」识别计算属性**：选择「一个 ref 如果身上挂着响应式副作用对象，就认定它是计算属性而非普通状态」→ 换来无需用户标注就能把计算属性从状态里筛出去（否则计算属性会被当成状态塞进集中状态树，造成序列化与重复计算的麻烦）→ 代价是这条判定依赖响应式库的内部实现细节，是与底层响应式系统的隐式耦合。
  3. **状态项原样回填集中状态树**：选择「把每个被识别为状态的 ref/reactive 直接按引用写入集中状态树对应位置，不拷贝」→ 换来集中状态树成为唯一事实源，订阅的深度监听、批量合并、SSR 序列化都挂在同一棵树上 → 代价是同一份状态同时被"setup 闭包里的引用"和"集中状态树"两个入口持有，正确性完全依赖二者指向同一个对象（靠直接赋引用维持）。
  4. **所有函数无差别套上动作包装**：选择「凡是函数一律套一层包装、挂上订阅通知并复位活跃指针」→ 换来 `$onAction` 对 setup 里任何函数（含 store 内部互调的私有函数）都统一生效 → 代价是即便用户写了纯工具函数也会被当动作上报（轻微开销与概念污染），且包装层要同时处理同步返回与 Promise 两条路径。

- **最小心智模型（3～7 步）**：
  1. 工厂首次被调用，先把只含 `$patch`/`$subscribe` 等基础 API 的半成品登记进注册表（承前章）。
  2. 在半成品所属的副作用作用域内运行用户的 setup，拿到一个"无标签属性袋"。
  3. 引擎逐个遍历属性袋的每个键，取值。
  4. 探测指纹：是 ref 但没有响应式副作用、或是 reactive 对象 → 归为**状态**。
  5. 是 ref 且身上挂着响应式副作用 → 归为**计算属性**。
  6. 是函数 → 归为**动作**，原地替换成"套了监听钩子 + 复位活跃指针"的包装函数。
  7. 状态项原样回填集中状态树；最后把整袋属性合并到那个 reactive 半成品上，store 即告成型。

- **最小原理演示（替代旧"复刻范围"）**：
  - **应演示**：一个 `classify(bag)` 函数，遍历属性袋，仅凭 `isRef`/`isReactive` + "ref 身上有没有响应式副作用"把值分进状态/计算属性/动作三堆；再附一个极简 `wrapAction`，模仿"调用前后触发订阅"的动作包装。这段演示演的是权衡①（运行时探测换自由）+ 权衡④（函数无差别包装）。几十行即可。
  - **应故意省略**：副作用作用域托管、插件扩展、热更新、SSR 水合的边缘处理、集中状态树的 ref 自动解包语义、`$patch`/`$subscribe` 的内部管道——这些都是相邻章的主题或工程化脚手架，与"分流"原理无关。
  - **演示载体建议**：**首选 TS/JS**。本章核心是"对一堆响应式值做鸭子类型分流"，属于纯判别逻辑/数据结构，TS/JS 能最忠实地演透，且配最小 `package.json` 即可用 `node`/`bun` 直接跑；读者可在演示里亲手把一个 ref 换成 computed，观察它从"状态堆"跳到"计算属性堆"，直观感受指纹探测。无需退回原仓库语言。

- **正文不宜展开的细节**：水合判定（标记某些"有状态但非状态"的对象、如路由实例，跳过水合）——属 SSR 与边缘处理，一笔带过即可；devtools/HMR 用的状态/计算属性/动作登记簿——属可观测性与热更新章；批量合并里 Map/Set/递归合并的细节——属变更双管道章；`$patch` 暂停监听 + 下一微任务恢复的时序——属变更双管道章；副作用作用域如何托管整个 store——属容器与状态树章。

- **推荐的一个执行轨迹例子**：
  - 输入：首次调用 `useCounter()`，其 setup 返回 `{ count: ref(0), double: computed(() => count.value*2), inc() {...} }`。
  - 关键中间态：遍历到 `count` → 是 ref 且无副作用 → 状态，按引用写入集中状态树的 count 槽位；遍历到 `double` → 是 ref 且带副作用 → 计算属性（仅登记）；遍历到 `inc` → 是函数 → 用包装函数原地替换。
  - 输出：store 成为 `reactive({...基础API, count, double, inc(已包装)})`；外部调用 `store.inc()` 时，包装层先触发"前置"订阅、执行原函数、再按同步/Promise 触发"后置"订阅。

> 以上钩子供 Writer 写「动机→核心思想→心智模型→关键权衡→原理演示」；下面事实部分供核对，不要被 Writer 当目录照抄。

## 概念要点

> 覆盖说明：本章 sourceFiles 仅 `packages/pinia/src/store.ts` 一个文件，但其内部按职责分属多章。下面先点明各段落归属，便于 Writer 跨章去重；本章精读聚焦"分类"相关段落，其余仅作归属标注。

- **计算属性的指纹判定**：计算属性本质是"带响应式副作用（effect）的 ref"。判定函数用 `isRef(o) && (o as any).effect` 把计算属性从普通 ref 里挑出来——这是整条分流链的判别基石。源码位置: packages/pinia/src/store.ts:144-147

- **分流循环的三大分支**：遍历 setup 返回对象的每个自有键，按值的响应式特征走三条互斥分支——状态、动作、计算属性。源码位置: packages/pinia/src/store.ts:505-571

- **状态分支（ref 非 computed，或 reactive）**：被识别为状态的值，在 setup store 场景下会原样按引用写入集中状态树对应键，让集中树成为唯一事实源；若有初始状态（SSR 水合）则先把外部状态灌进这个 ref/reactive 再回填。源码位置: packages/pinia/src/store.ts:508-538（关键行 516-532）

- **动作分支（typeof === 'function'）**：函数一律经 `action()` 包装后原地替换回返回对象，同时登记进 `optionsForPlugin.actions` 供插件读取。源码位置: packages/pinia/src/store.ts:540-554

- **计算属性分支仅存于开发构建**：计算属性的显式登记只在 `__DEV__` 分支里做（写入 HMR/devtools 用的登记簿）；生产构建里此分支整块裁除，计算属性不做任何特殊处理，直接随全量合并进入 store。源码位置: packages/pinia/src/store.ts:555-569

- **动作包装层的职责**：包装函数在每次调用时复位活跃指针、收集 after/onError 回调、触发"动作订阅"的前置通知，再执行原函数；返回值按同步/Promise 两路分别触发后置/出错通知。用两个内部 Symbol 标记"已包装"与"动作名"，保证重复包装是幂等的。源码位置: packages/pinia/src/store.ts:59-77, 361-422

- **store 外壳是 reactive 半成品**：先把只含基础 API（`$patch`/`$subscribe`/`$onAction`/`$reset`/`$dispose` 等）的对象用 `reactive()` 包成 store 外壳，并在跑 setup 之前就把这个半成品登记进注册表（承前章的"先登记后装配"）；分类完成后用 `assign(store, setupStore)` 与 `assign(toRaw(store), setupStore)` 把属性袋合并到外壳及其原始对象上（后者是为让解构工具能取回 reactive 对象，对应 issue #799）。源码位置: packages/pinia/src/store.ts:431-494, 573-578

- **`$state` 访问器**：用 `Object.defineProperty` 在 store 上定义 `$state` 的 getter/setter，get 直读集中状态树、set 走 `$patch` 把变更合并成一次订阅事件。源码位置: packages/pinia/src/store.ts:583-595

- **水合边缘（shouldHydrate/skipHydrate）**：允许给一个对象打"跳过水合"标记；状态分支在水合时遇到带此标记的对象就不把外部状态灌进去——用于 setup store 返回了"有状态外表但并非状态"的对象（如路由实例）。源码位置: packages/pinia/src/store.ts:115-140, 516

- **文件其余段落的归属（供跨章去重）**：`mergeReactiveObjects`(79-113) 属「变更双管道」；`createOptionsStore`(149-212) 属「Options Store 三分」；`$patch`(285-328)、`$reset`(330-347) 属「变更双管道 / Options Store」；`$subscribe`(438-474) 属「发布订阅 / 变更双管道」；`_hotUpdate`(600-693) 属「热更新」；插件应用循环(717-754) 属「插件扩展总线」；`defineStore` 工厂与懒创建(828-954) 属「懒装配」。源码位置: packages/pinia/src/store.ts:79-113, 149-212, 285-347, 438-474, 600-693, 717-754, 828-954

## 关键调用链

工厂首次调用 → 创建 setup store：
`useStore()`（defineStore 闭包） → `createSetupStore($id, setup, options, pinia)` → 构造 reactive 半成品并 `pinia._s.set($id, store)`（先登记） → 在 `pinia._e`/`effectScope` 内运行 `setup({ action })` 拿到属性袋 → `for...in` 分流循环（状态/动作/计算属性三分） → `assign(store, setupStore)` + `assign(toRaw(store), setupStore)` → 插件循环 `pinia._p.forEach(...)` → 返回 store
源码位置: packages/pinia/src/store.ts:883-948（useStore）, 214-781（createSetupStore）, 500-578（setup 运行与分流合并）

动作被调用时（分类的下游后果）：
`store.someAction(args)` → 包装层 `setActivePinia(pinia)` → `triggerSubscriptions(actionSubscriptions, {name, args, after, onError, ...})`（前置） → `fn.apply(store, args)` → 同步则直接 `triggerSubscriptions(afterCallbackSet, ret)`；Promise 则 `.then(after).catch(onError)`
源码位置: packages/pinia/src/store.ts:368-413

## 源码摘录（带行号，全文累计 ≤ 30 行）

计算属性的指纹判定（整条链的判别基石）：
```ts
// store.ts:144-147
function isComputed(o: any): o is ComputedRef {
  return !!(isRef(o) && (o as any).effect)
}
```

分流循环三大分支骨架（省略 hydrate/devtools 细节）：
```ts
// store.ts:505-569（节选）
for (const key in setupStore) {
  const prop = setupStore[key]
  if ((isRef(prop) && !isComputed(prop)) || isReactive(prop)) {
    // ...hydrate 灌入外部状态（若有）后...
    pinia.state.value[$id][key] = prop        // 状态：按引用回填集中状态树
  } else if (typeof prop === 'function') {
    const actionValue = __DEV__ && hot ? prop : action(prop as _Method, key)
    setupStore[key] = actionValue             // 动作：原地替换为包装函数
    optionsForPlugin.actions[key] = prop
  } else if (__DEV__) {
    if (isComputed(prop)) { /* 仅登记给 devtools/HMR；生产环境整块裁除 */ }
  }
}
```

动作包装层：复位活跃指针 + 前置订阅触发 + 幂等标记：
```ts
// store.ts:368-388, 416-417（节选）
const wrappedAction = function (this: any) {
  setActivePinia(pinia)
  triggerSubscriptions(actionSubscriptions, {
    args, name: wrappedAction[ACTION_NAME], store, after, onError,
  })
  // fn.apply(...) 后按同步/Promise 两路分别触发 after / onError
} as MarkedAction<Fn>
wrappedAction[ACTION_MARKER] = true
wrappedAction[ACTION_NAME] = name
```

## 易混淆 / 边界 / 推断

- **事实**：生产构建里计算属性根本不进任何显式分类分支（`__DEV__` 为假时整个 getter 分支被裁除），它只是随 `assign(store, setupStore)` 普通合并进 store；计算属性 vs 状态的区分在消费侧（如解构工具）是**消费时重新探测**的，而非依赖这里登记的元数据。源码位置: packages/pinia/src/store.ts:555-569
- **事实**：状态项回填集中状态树用的是**同一个引用**（`pinia.state.value[$id][key] = prop`，prop 即用户在 setup 里创建的那个 ref/reactive），因此 setup 闭包里的引用与集中状态树指向同一对象，改一处即改两处——这正是"单一事实源"的实现方式。源码位置: packages/pinia/src/store.ts:532
- **推断（标注为推断）**：之所以状态判定写成 `isRef && !isComputed || isReactive` 而不是简单的 `isRef || isReactive`，是因为计算属性本身也是 ref，必须先用"带 effect"把它剔除，否则计算属性会被误当作状态塞进集中状态树、参与序列化与深度订阅，产生语义错误。这与权衡②直接对应。
- **推断**：`$reset` 在 setup store 下只能抛错（或 noop），根因正是分类是运行时才发生——引擎从未拿到一份"初始状态的声明式描述"，无从重建初态；Options Store 因状态形状预先声明而能自动实现 `$reset`（见下一章）。源码位置: packages/pinia/src/store.ts:330-347
- **事实**：动作包装用两个 Symbol 做标记，且函数入口先检查"是否已标记"——若用户在 setup 内部已主动调用 `action` 助手包过某函数，引擎不会重复包装，保证幂等。源码位置: packages/pinia/src/store.ts:362-366, 416-417
- **未理解**：`assign(toRaw(store), setupStore)`（578 行）与 `assign(store, setupStore)`（575 行）并存，注释指向 issue #799"让 storeToRefs 配合 reactive 工作"，但其与 reactive 代理对 ref 解包的精确交互细节，需结合消费侧（storeToRefs）才能完全坐实，留待「在组件中消费 Store」章核对。
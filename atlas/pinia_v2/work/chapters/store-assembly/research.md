# store 装配机器：双形态归一与属性自动分类 · 源码精读

## 给 Writer 的教学钩子（必填，8 子项缺一不可）

- **用户痛点 / 场景**：用户可以用两种风格写 store——「选项式」（分开声明 state/getters/actions）或「组合式」（一个 setup 函数返回响应式引用/函数/计算属性）。没有装配机器时，要么为两套写法维护两套运行时，要么用户得自己分「这个返回值到底是状态还是派生值」。更棘手的是：两个 store 互相引用（A 的逻辑里用 B，B 里又用 A）时，装配过程会无限递归、把自己卡死。
- **一句话核心思想**：先把两种写法都翻译成「一坨返回值」，再用反射把返回值按类型自动分成状态/动作/计算三类——并且在装配真正开始之前，就先把半成品登记进缓存，让互相引用的 store 永远拿得到对方。
- **设计动机（为什么需要它）**：两种 store 写法本质是对同一组运行时能力（响应式状态、可订阅变更、可拦截动作）的不同语法糖。把它们归一到同一台装配器，意味着所有高级特性（批量变更、订阅、热更新、devtools、插件）只需实现一次，两种写法等价享受；而运行时反射分类让用户「返回什么就是什么」，无需任何注册样板。
- **关键权衡（4 条）**：
  1. 选择「在跑装配函数之前，先把半成品 store 登记进单例缓存」→ 换来 store 之间互相引用不会无限递归（B 引 A 时 A 已在缓存，直接返回半成品）→ 代价是选项式 store 的计算属性在求值时必须「懒取」缓存里那个最终实例，而不能在装配时直接捕获（装配时它还是半成品）。
  2. 选择「把组合式 store 里用户写的每个状态引用原样搬进全局扁平状态字典」→ 换来「单一真源」——订阅、批量变更、SSR 序列化都只盯这一个字典，且 store 上的属性和字典里的是同一个引用 → 代价是选项式与组合式 store 在字典里的内部存储形态其实不同（一个普通对象、一个引用集合），全靠响应式系统的引用自动解包把差异抹平。
  3. 选择「用反射（是否引用、是否带 effect、是否函数）在运行时分类返回值」→ 换来用户零样板、写法自由 → 代价是分类规则隐式（计算属性靠「是引用且带 effect」识别），边界情况（返回一个普通响应式对象、或被冻结标记的实例）需要用户理解规则才能正确表达意图。
  4. 选择「最终用响应式代理包裹一个只含内置方法（变更/订阅/重置/销毁）的骨架对象，再把装配后的属性合并上去」→ 换来 store 天然响应式、且按型重建工具能正确识别其中的引用/响应式子值 → 代价是需要「双写」（同时往代理对象和它的原始对象上各合并一次），以规避代理对响应式子值的解包。
- **最小心智模型（7 步）**：
  1. 选项式 store 先被一个适配函数翻译成「组合式形态」：state 拆成引用、getters 包成计算属性、actions 原样，合并成一坨返回值——从此两种写法走同一条流水线。
  2. 装配器先搭出只含内置方法（变更/订阅/重置/销毁）的「骨架对象」，用响应式代理包成 store。
  3. 关键：在执行用户的装配函数之前，把这个骨架 store 登记进单例缓存（占位）。
  4. 在专属的作用域里执行装配函数，拿到用户返回的那一坨值。
  5. 遍历返回值，按「引用(非计算)或响应式 → 状态」「函数 → 动作」「计算 → 派生」三类分拣：状态搬进全局扁平字典（单一真源），动作套上拦截包装，派生值原样保留。
  6. 把分拣后的全部属性合并到 store（及其原始对象）上，挂上统一的状态访问器，跑插件扩展。
  7. 打开订阅监听，返回成品 store。
- **最小原理演示（替代旧"复刻范围"）**：
  - 应演示：一个几十行的从零装配器，演透「半成品占位 + 反射分类 + 单一真源」这条主线。输入一个 setup 函数返回 `{ count: ref(0), double: computed(...), inc() {...} }`，且该 setup 内部会去取另一个也正在装配的 store。
  - 演示应当：① 先建骨架并登记缓存（演权衡 1）；② 跑 setup；③ 遍历返回值用三分支分类，把状态引用搬进一个共享 state 字典（演权衡 2/3）；④ 暴露 `store.count` 与 `state[id].count` 是同一个引用，改一个另一个动。
  - 应故意省略：批量变更/订阅/动作拦截的完整实现、热更新、devtools、插件链、SSR hydration、作用域嵌套细节、完整泛型——它们是装配机器的「外围」，不是「归一 + 分类 + 占位」这条原理主线。
- **正文不宜展开的细节**：作用域嵌套（根作用域 → 每 store 子作用域 → 销毁时一键停）属「作用域回收」话题；动作包装器的 before/after/onError 回调与 Promise 处理属订阅章；统一状态访问器的 getter/setter、重置对组合式 store 不可用属状态变更章；插件在装配末尾混入、非响应式插件的诊断警告属插件系统章；双写修复按型重建的背景可作边角提及。
- **推荐的一个执行轨迹例子**：输入两个组合式 store，A 的 setup 内调用 useB()、B 的 setup 内调用 useA()（互相引用）。关键中间态：先装配 A → 建骨架 → 缓存登记半成品 A → 跑 A 的 setup → setup 内 useB() 触发装配 B → B 的 setup 内 useA() 命中缓存拿到半成品 A（不死循环）→ B 装配完登记成品 B → 回到 A，A 的 setup 跑完、分类、合并、登记为成品。输出：A、B 都拿到成品 store，且互引在装配期就成立。这条轨迹演的是权衡 1。

> 以上钩子供 Writer 写「动机→核心思想→心智模型→关键权衡→原理演示」；下面事实部分供核对，不要被 Writer 当目录照抄。

## 概念要点

- 要点 1：`createOptionsStore` 并不真正装配，它只构造一个 `setup()` 适配器，再委托 `createSetupStore(..., isOptionsStore=true)`——选项式 store 是组合式 store 的语法糖。源码位置: packages/pinia/src/store.ts:149-212
- 要点 2：选项式适配器把 state 转成 `toRefs`、getters 包成 `computed`、actions 原样，`assign` 成一坨返回值，从而两种写法在装配入口处归一。源码位置: packages/pinia/src/store.ts:166-207
- 要点 3：`isComputed` 靠「是 ref 且带 `effect` 属性」识别计算属性，以此与普通状态 ref 区分开。源码位置: packages/pinia/src/store.ts:144-147
- 要点 4：装配时序：构建骨架 → 响应式包裹 → 缓存占位 → 跑 setup → 分类 → 合并 → 挂状态访问器 → 跑插件 → 开监听 → 返回。源码位置: packages/pinia/src/store.ts:431-781
- 要点 5：半成品登记（`pinia._s.set($id, store)`）发生在执行 setup **之前**；注释明言是为了让 store 互引时「能在彼此没装配完前就实例化对方，而不产生无限循环」。源码位置: packages/pinia/src/store.ts:492-502
- 要点 6：三分支分类：`isRef(prop) && !isComputed(prop)` 或 `isReactive(prop)` → 状态；`typeof prop === 'function'` → 动作（套 `action()` 包装）；`__DEV__` 下 `isComputed(prop)` → 收集进热更新/devtools 元数据。源码位置: packages/pinia/src/store.ts:505-571
- 要点 7：组合式 store 的状态 ref 被迁入 `pinia.state.value[$id][key]`，与 store 上的属性共享同一个 ref 引用——这就是「单一真源」的字面实现。源码位置: packages/pinia/src/store.ts:514-533
- 要点 8：选项式 store 的 state 在适配器里就整体写入字典（`pinia.state.value[id] = state ? state() : {}`，普通对象），`createSetupStore` 对选项式跳过 state 初始化与迁入——两种 store 在字典里存储形态不同。源码位置: packages/pinia/src/store.ts:166-178, 275-278
- 要点 9：最终 `store = reactive(partialStore)`；属性合并采用双写 `assign(store, setupStore)` + `assign(toRaw(store), setupStore)`，后者为修复按型重建工具识别响应式子值（#799）。源码位置: packages/pinia/src/store.ts:478-578
- 要点 10：装配地基（定义在依赖章 `createPinia`）：`_e = effectScope(true)` 根作用域、`_s = new Map()` 单例缓存、`state = ref({})` 扁平字典、`_p = []` 插件数组。装配机器全部操作都建立在这四个结构上。源码位置: packages/pinia/src/createPinia.ts:11-54
- 要点 11：setup 在三层嵌套下执行：`runWithContext`（应用上下文）→ `pinia._e.run`（根作用域）→ `effectScope().run`（本 store 子作用域）；子作用域由 `$dispose` 的 `scope.stop()` 一键回收。源码位置: packages/pinia/src/store.ts:496-502, 349-354

## 关键调用链

`defineStore` → `useStore`（首次调用）→ `createSetupStore`（组合式）或 `createOptionsStore`（选项式）
`createOptionsStore` → 构造 setup 适配器 → `createSetupStore(id, setup, options, pinia, hot, isOptionsStore=true)`
`createSetupStore` 主线：
构建骨架对象 → `reactive(骨架) = store` → `pinia._s.set($id, store)`[占位] → `runWithContext → pinia._e.run → effectScope().run → setup({ action }) = setupStore` → `for(key) 分类(state 迁入 / action 包装 / getter 收集)` → `assign(store, setupStore) + assign(toRaw(store), setupStore)` → `defineProperty($state)` → `pinia._p.forEach` 插件混入 → `isListening=true` → `return store`
源码位置: packages/pinia/src/store.ts:431-781

## 源码摘录（带行号，全文累计 ≤ 30 行）

识别计算属性（分类的判定基石）：
```ts
function isComputed(o: any): o is ComputedRef {
  return !!(isRef(o) && (o as any).effect)
}
```
源码位置: packages/pinia/src/store.ts:145-147

选项式 getter「懒取」缓存实例（权衡 1 的代价侧）：
```ts
        computedGetters[name] = markRaw(
          computed(() => {
            setActivePinia(pinia)
            // it was created just before
            const store = pinia._s.get(id)!
            // ... allow cross using stores ...
            return getters![name].call(store, store)
          })
        )
```
源码位置: packages/pinia/src/store.ts:188-201（精简）

先占位、再在三层作用域下跑 setup（权衡 1）：
```ts
  // store partial now so setups can instantiate each other
  // before finished, without infinite loops.
  pinia._s.set($id, store as Store)

  const setupStore = runWithContext(() =>
    pinia._e.run(() => (scope = effectScope()).run(() => setup({ action }))!)
  )!
```
源码位置: packages/pinia/src/store.ts:492-502（精简）

三分支反射分类 + 状态迁入单一真源（权衡 2/3）：
```ts
  for (const key in setupStore) {
    const prop = setupStore[key]
    if ((isRef(prop) && !isComputed(prop)) || isReactive(prop)) {
      // ...state 分支（hydration 略）...
      } else if (!isOptionsStore) {
        pinia.state.value[$id][key] = prop // 迁入：单一真源
      }
    } else if (typeof prop === 'function') {
      setupStore[key] = action(prop as _Method, key) // action 包装
    } else if (__DEV__ && isComputed(prop)) { /* getter 收集 */ }
  }
```
源码位置: packages/pinia/src/store.ts:505-571（精简）

## 易混淆 / 边界 / 推断

- 事实：生产环境下，计算属性 getter 不进入任何分类分支（状态分支被 `!isComputed` 排除、非 function、`__DEV__` 分支不执行），它原样随 `assign(store, setupStore)` 挂到 store 上——getter 本身已是计算属性，无需像状态那样「迁入字典」。源码位置: packages/pinia/src/store.ts:505-571
- 事实：选项式与组合式 store 在 `pinia.state.value[id]` 里存储形态不同（选项式 = `state()` 返回的普通对象；组合式 = 逐个迁入的 ref 集合），靠响应式系统的 ref 自动解包在访问时抹平差异。源码位置: packages/pinia/src/store.ts:169, 532
- 事实：`$reset` 仅选项式 store 有真实实现（重新 `state()` 后经 `$patch` 合并）；组合式 store 在 `__DEV__` 抛错、生产为 `noop`——这是两种形态「state 声明方式不同」的直接后果。源码位置: packages/pinia/src/store.ts:330-347
- 边界：若用户在组合式 store 返回一个被 `markRaw`（带 `__v_skip`）的对象，它既非 ref/reactive、也非 function、也非 computed，会落入「既非状态也非动作」——生产下被原样 assign 到 store，不进 state 字典、不参与序列化/订阅。这正是用户表达「非状态实例」（如 router）的途径，与 `skipHydrate` 场景对应。源码位置: packages/pinia/src/store.ts:505-571, 119-140
- 推断（标注为推断）：getter「懒取 store」除为绕开半成品时序外，源码 198 行的 TODO（「avoid reading the getter while assigning with a global variable」）暗示作者曾考虑用全局变量在赋值期传 store、但放弃了——推断理由是计算属性的惰性求值天然避开装配时序，比全局变量更干净。
- 推断：`assign(toRaw(store), setupStore)` 之所以必要，是因为 store 是 reactive 代理，对 reactive 类型的 prop 直接 set 会被解包成普通对象、丢失响应式标记，导致按型重建工具的 effect 判定失效（#799）——从注释「Make storeToRefs() work with reactive() #799」与该工具按 `effect`/`isRef||isReactive` 判型的机制推断。源码位置: packages/pinia/src/store.ts:576-578
- 未理解：选项式 getter 在热更新路径里被重新包成 `computed`（未 `markRaw`），与首装的 `markRaw(computed)` 略有差异，是否有意——本章不深究，留 HMR 章。源码位置: packages/pinia/src/store.ts:657-671
# Store 装配：effectScope 托管的返回值分类与状态镜像 · 源码精读

## 给 Writer 的教学钩子（必填，8 子项缺一不可）

- **用户痛点 / 场景**：用 setup 语法定义 store 时，你在 setup 函数里返回的是一个"无标签"的扁平对象——里面混着状态（ref）、派生值（computed）、动作（普通函数）。Pinia 必须在运行时推断每个属性该扮演什么角色：状态要能被序列化、要进 devtools；动作要能被 `$onAction` 拦截；派生值要保持响应式但不该被当状态序列化。更棘手的是 store 之间还会互相引用（A 的动作里去实例化 B，B 又引用 A），若等一个 store 完全装配好才允许别人找到它，就可能陷入"A 等我→我等 A"的死循环。装配机制要同时解决"分类"和"互引不死循环"两件事。

- **一句话核心思想**：先占位注册一个半成品 store 进注册表，再在专属子作用域里懒装配它的返回值——按「是不是 ref/reactive、是不是 computed、是不是函数」三分类，把状态镜像进单一根状态树。

- **设计动机（为什么需要它）**：这个机制是为解决「setup 语法返回值无类型标签 + store 间循环互引」这对矛盾而生的；它换来的是「同一套装配逻辑同时吃下 setup store 和 option store」「状态可被一次性序列化/回收」的能力。
  - 承前（已在第 1 章『Pinia 实例：根状态、注册表与全局活跃上下文』讲透，本章只看它的新侧面）：第 1 章建立的三个支点——**根作用域**（承载全部 effect 的总作用域）、**注册表**（id→store 的缓存 Map）、**根状态树**（挂在 Pinia 上的单一状态 ref）——是本章装配流程的落脚点。第 1 章讲的是"它们为什么是单例、怎么挂上去"，本章只看装配流程如何**消费**它们：在根作用域下开子作用域、往注册表里先占位、把 setup 返回的 ref 镜像进根状态树。
  - 承前（已在第 3 章『defineStore：惰性 useStore 闭包与注册表缓存』讲透，本章只看它的新侧面）：第 3 章只交代了 defineStore 把"创建 store"推迟到首次调用 useStore、并缓存进注册表；本章看的就是那次"首次调用"背后、装配函数内部**究竟怎么把一个 setup 函数的返回值变成一个真正可用的 store 对象**。
  - 承前（已在第 2 章『订阅原语』讲透，本章只看它的新侧面）：装配时往 store 上挂的 `$onAction`/`$subscribe`/`$patch` 内部都用到了第 2 章的订阅原语，但原语本身（Set+add/remove、onScopeDispose 自动清理）第 2 章已讲透，本章不重演，只在事实区点明"装配时挂上去"。

- **关键权衡（本 Atlas 的核心）**：
  1. **先占位注册、再懒装配** → 换来 store 之间互相引用时不会产生死循环（A 的 setup 里实例化 B 时，A 已经在注册表里，B 再回头找 A 能拿到半成品而不必重新创建 A）→ 代价是装配期间的 store 处于"半成品"状态：getter 在求值时从注册表取到的实例可能尚未填满属性，所以装配顺序与赋值时机被严格钉死（**必须先注册、后跑 setup**），且跨 store 引用只能拿到"当前已装配部分"。
  2. **把 setup 创建的每个 state ref 镜像进根状态树** → 换来"整个应用只有一棵可序列化的根状态树"（SSR 序列化、devtools 展开、`$state` 整体读写都只盯这一棵树，不必去各处收集）→ 代价是每个状态 ref 都要在分类时额外登记一次，且 SSR 水合时要双向同步（先把入站状态灌进用户创建的 ref，ref 又被登记进根树），逻辑更绕。
  3. **用子 effectScope 托管整个 store 的全部响应式** → 换来 store 的所有 ref/computed/侦听器可被一次性 `scope.stop()` 回收（`$dispose` 一行就能干净销毁，第 1 章的根作用域设计在此兑现）→ 代价是 setup 必须在该作用域内**同步**执行才能被托管，所以装配流程要把 setup 包在"根作用域 → 新子作用域 → setup()"的嵌套里同步跑完。
  4. **整个 store 对象包成 `reactive()`** → 换来"对象式"的人体工学：`store.count` 自动解包 ref、`store.count = x` 直接可写、action 直接可调 → 代价是 state/getter/action 三类东西混进同一个 reactive 对象、彼此难以区分，逼出后续的定向提取工具（storeToRefs），且 reactive 会干扰属性枚举，导致装配末尾还要往 `toRaw(store)` 上再合并一次。
  5. **靠 computed 自带的内部标记（它是一种带 `.effect` 的 ref）来区分"状态 ref"与"派生 ref"** → 换来运行时单凭一个判别式就能完成三分类、无需用户给属性打标签 → 代价是这个判别依赖 Vue 的内部实现细节（`.effect` 并非稳定公开 API），是把"分类正确性"建立在一个实现约定上。

- **最小心智模型（3～7 步）**：
  1. **占位根状态**：若本 store 在根状态树里还没有条目，先放一个空对象占位（option store 因 state 形状已知而走另一路，直接写形状）。
  2. **造壳**：把内置方法（`$patch`/`$reset`/`$subscribe`/`$onAction`/`$dispose` 等）拼成一个"部分 store"对象。
  3. **包裹**：把部分 store 包成 `reactive()`，得到 store 对象本体（dev 下额外塞热更新负载等内部字段）。
  4. **先占位注册**：把此刻**还没跑 setup** 的半成品 store 塞进注册表——这是防互引死循环的关键一步。
  5. **跑装配**：在根作用域下开一个子 effectScope，**同步**执行 setup()，拿到它返回的扁平对象。
  6. **三分类**：遍历返回值——ref/reactive 当 **state**（镜像进根状态树）、普通函数当 **action**（包一层拦截器）、computed 留作 **getter**（原样保留、不进根状态）。
  7. **收尾**：把分类结果合并进 store、给 store 装 `$state` 访问器、在该 store 的作用域内逐个跑插件、最后才打开状态监听开关。

- **最小原理演示（替代旧"复刻范围"）**：
  - **应演示**：一个几十行的极简装配函数，只演两条核心权衡——**「先占位注册防死循环」**（步骤 4：注册发生在跑 setup 之前）和**「返回值三分类 + 状态镜像」**（步骤 6：遍历、判别、把 state ref 写进根状态树）。具体地：构造一个极简 Pinia 骨架（含根状态树对象、注册表 Map、根 effectScope），写一个装配函数依次做"占位根状态 → 造壳 reactive → 注册表.set → 子 scope 跑 setup → 遍历三分类 → 合并"，最后用一个**会互相引用**的 store A 与 store B 演示"靠占位注册，A 的 setup 里实例化 B、B 回头实例化 A 不会死循环"。每一行都对应上面某个原理点。
  - **应故意省略**：`$patch`/`$subscribe` 的真实实现（属下一章/订阅章）、热更新 `_hotUpdate` 全套（属 HMR 章）、devtools 隐藏属性与诊断告警、插件 `_p` 遍历、SSR 水合 `shouldHydrate`、option store 的 state→toRefs / getters→computed 拼装（属 options-store-unification 章）、完整泛型。**不追求工程完整，只追求演透"占位注册 + 三分类 + 镜像"这三件事**。
  - **演示载体建议**：本仓库主语言是 TypeScript、机制本身基于 Vue 的响应式原语，建议写成一段能用 `node`（或 `bun`）**直接跑**的脚本——直接 `require('vue')` 拿 `ref`/`reactive`/`computed`/`effectScope` 即可，无需启动 Vue 应用。能跑最好（可直观看到"A↔B 互引不死循环"的输出），非硬要求。一句话原则：载体服务于"演透原理"，不是服务于"能跑完整 Pinia"。

- **正文不宜展开的细节**：`$patch` 双形态（mergeReactiveObjects 深合并 vs 函数式直改，属下一章）；`isListening`/`isSyncListening` 与 `$subscribe` 的协调（属订阅系统章）；`_hotUpdate` 与 HMR 负载（属 HMR 章）；插件遍历 `_p` 与返回值诊断告警（属插件系统章）；`shouldHydrate`/`skipHydrate` 与 SSR 水合（属 SSR 章）；`createOptionsStore` 的 state→`toRefs`、getters→`computed` 拼装（属 options-store-unification 章）；`_customProperties`/devtools 隐藏属性枚举（属 devtools/插件章）；dev 下的 `PINIA_R1002`/`PINIA_R1003` 诊断。

- **推荐的一个执行轨迹例子**：
  - 输入：`defineStore('cart', () => { const items = ref([]); const count = computed(() => items.value.length); function add(x){ items.value.push(x) } return { items, count, add } })`，首次调用 `useStore()`。
  - 关键中间态：
    1. 注册表无 'cart' → 进入装配函数。
    2. 根状态树里给 'cart' 占一个 `{}`。
    3. `reactive({$id:'cart', ...内置方法})` 得到 store 壳。
    4. **注册表.set('cart', 壳)** ← 占位注册（此刻壳上还没有 items/count/add）。
    5. 子作用域同步跑 setup → 返回 `{ items(ref), count(computed), add(fn) }`。
    6. 遍历三分类：`items` 是 ref 且非 computed → **state**，镜像写进根状态树；`count` 是 computed → **getter**，原样留、不进根状态；`add` 是函数 → **action**，包一层拦截器。
    7. 合并进 store → `store.items` 自动解包、`store.count` 触发 computed、`store.add` 走拦截器。
    8. 打开监听开关，返回 store。
  - 输出：一个 `reactive` 化的 store 对象，状态既可经 `store.items` 直接访问、也唯一存在于根状态树里；同时注册表里此 id 已被占用，后续 `useStore()` 直接命中缓存（这部分属第 3 章）。
  - 演的是核心思想（占位注册 + 三分类 + 镜像），不是全量调用链。

> 以上钩子供 Writer 写「动机→核心思想→心智模型→关键权衡→原理演示」；下面事实部分供核对，不要被 Writer 当目录照抄。

## 概念要点

- 装配函数（`createSetupStore`）是**所有 store 的唯一装配工厂**：option store 经 `createOptionsStore` 把选项拼成一个 setup 函数后，仍转交它（最后一个参数 `isOptionsStore=true`）。源码位置: packages/pinia/src/store.ts:209, 902-908
- useStore 首次调用时分流：setup store 直入装配函数，option store 先经 `createOptionsStore` 再入装配函数；两者产物都缓存进注册表。源码位置: packages/pinia/src/store.ts:902-915
- **setup store 的根状态占位**：非 option store 且根状态中尚无本 id 时，先 `pinia.state.value[$id] = {}` 占位（option store 的 state 形状已知、由 `createOptionsStore` 直接写入，不走这条占位）。源码位置: packages/pinia/src/store.ts:271, 275-278
- **"部分 store"（partialStore）**：装配期先把 `$id/$onAction/$patch/$reset/$subscribe/$dispose` 等内置方法拼成一个对象，作为后续 `reactive()` 的原料。源码位置: packages/pinia/src/store.ts:431-476
- `$reset` 是按 `isOptionsStore` 三元定义的：option store 有真实实现（重建 state 后路由回 `$patch`），setup store 在 dev 下抛错、prod 下为 noop——这正是"统一装配路径"的必然代价（详见 options-store-unification 章，本章只点明它发生在装配期）。源码位置: packages/pinia/src/store.ts:330-347
- **整个 store 是 `reactive(partialStore)`**：dev/devtools 下还会往里塞 `_hmrPayload`、`_customProperties`。源码位置: packages/pinia/src/store.ts:478-490
- **先占位注册**：跑 setup **之前**就把半成品 store 塞进注册表 `pinia._s.set($id, store)`；源码注释明说这是为了让 store 之间"在未装配完成时就能互相实例化、不产生无限循环"。源码位置: packages/pinia/src/store.ts:492-494
- **effectScope 嵌套托管**：`app.runWithContext → pinia._e.run（根作用域） → 新建子 effectScope().run(setup)`——三层嵌套，保证 setup 内创建的所有 ref/computed 都归本 store 的子作用域管，可被一次性 stop。源码位置: packages/pinia/src/store.ts:496-502
- setup 函数签名接收一个 `{ action }` 助手（供 store 内部主动标记某个函数为 action，Pinia Colada 等高级场景用）。源码位置: packages/pinia/src/store.ts:500, 810-820
- **三分类判别**（遍历 setup 返回值的每个 key）：
  - state：`(isRef(prop) && !isComputed(prop)) || isReactive(prop)`
  - action：`typeof prop === 'function'`（hot 分支不包，其余用 `action(prop, key)` 包一层）
  - getter：dev 下 `isComputed(prop)` 才登记（prod 下 computed 原样保留、不单独处理）
  源码位置: packages/pinia/src/store.ts:505-571
- **`isComputed` 判别式**：computed 也是一种 ref，但额外带 `.effect` 字段——`!!(isRef(o) && (o as any).effect)`。这是运行时区分"状态 ref"与"派生 ref"的唯一依据，依赖 Vue 内部实现约定。源码位置: packages/pinia/src/store.ts:144-147
- **状态镜像**：setup store 的每个 state 属性被同步写进根状态树 `pinia.state.value[$id][key] = prop`——把用户命令式创建的 ref"登记"进单一可序列化状态树。源码位置: packages/pinia/src/store.ts:531-532
- **水合同步**（setup store + 有入站 initialState 时）：`shouldHydrate(prop)` 为真则把入站值灌进 ref（reactive 对象则先 clear 掉 Set/Map 再 `mergeReactiveObjects` 递归赋值）；这是状态镜像的反向操作。源码位置: packages/pinia/src/store.ts:516-530
- **action 包裹器**（`action()`）：包装原函数，每次调用时先触发 action 订阅集合、对外暴露 `after`/`onError` 钩子，并感知 Promise 返回值——这是 `$onAction` 的支撑（订阅系统章展开，本章只点明"函数分类时被包"）。源码位置: packages/pinia/src/store.ts:361-422, 540-545
- **合并进 store + toRaw 再合并**：`assign(store, setupStore)` 之后还要 `assign(toRaw(store), setupStore)`，注释指明是为了让 `storeToRefs()` 在 reactive store 上正常工作（#799）。源码位置: packages/pinia/src/store.ts:573-578
- **`$state` 访问器**：用 `Object.defineProperty` 定义，getter 走根状态树（hot 下走 hotState），setter 路由回 `$patch`——复用批处理（批处理细节属下一章）。源码位置: packages/pinia/src/store.ts:583-595
- **插件应用**：在该 store 的子作用域内（`scope.run`）逐个跑 `pinia._p` 里的插件，拿到返回的 extensions 后 `assign(store, extensions)` 合并——这就是"插件返回的响应式自动归 store 作用域托管"的来源（插件系统章展开）。源码位置: packages/pinia/src/store.ts:717-754
- **装配末尾才开监听**：`isListening = true; isSyncListening = true` 放在函数最后——装配期间状态写入不触发 `$subscribe`（与 `$patch` 暂停/恢复机制配合，详见订阅系统章）。源码位置: packages/pinia/src/store.ts:778-779
- 类型侧：`Store` 类型 = `_StoreWithState & UnwrapRef<S> & _StoreWithGetters & A & PiniaCustom*`——这正是"state 解包直访、getter 直访、action 直调、内置方法并存"这副运行时形态的类型镜像。源码位置: packages/pinia/src/types.ts:464-477
- 类型侧的"三分类提取"：`_ExtractStateFromSetupStore`（排除 `_Method | ComputedRef`）、`_ExtractActionsFromSetupStore`（取 `_Method`）、`_ExtractGettersFromSetupStore`（取 `ComputedRef`）——与运行时三分类判别一一对应。源码位置: packages/pinia/src/types.ts:555-600

## 关键调用链

入口调度（首次实例化）：
```
useStore(pinia) →（注册表无 id）→ createSetupStore(id, setup, options, pinia)   [setup store]
                                       或 createOptionsStore(...) → 内部拼 setup → createSetupStore(..., isOptionsStore=true)
```
源码位置: packages/pinia/src/store.ts:883-915（useStore）、149-212（createOptionsStore）

装配函数内部主链：
```
createSetupStore
 ├─ pinia.state.value[$id] = {}                      （setup store 占位根状态）
 ├─ partialStore = { $id, $onAction, $patch, $reset, $subscribe, $dispose, _p }
 ├─ store = reactive(partialStore)                   （整体 reactive 化）
 ├─ pinia._s.set($id, store)                         （★先占位注册——setup 未跑）
 ├─ runWithContext → pinia._e.run → effectScope().run(setup) → setupStore   （★子作用域托管跑 setup）
 ├─ for key in setupStore:                           （★三分类）
 │     ├─ ref/reactive(非computed) → 水合 + pinia.state.value[$id][key]=prop  （state 镜像）
 │     ├─ function              → setupStore[key] = action(fn, key)          （action 包裹）
 │     └─ computed(dev)         → 登记 getter
 ├─ assign(store, setupStore); assign(toRaw(store), setupStore)
 ├─ Object.defineProperty(store, '$state', { get→根状态, set→$patch })
 ├─ pinia._p.forEach(extender => scope.run(extender({store,app,pinia,options})) → assign(store, extensions))
 └─ isListening = isSyncListening = true; return store
```
源码位置: packages/pinia/src/store.ts:214-781（createSetupStore 主体）

## 源码摘录（带行号，全文累计 ≤ 30 行）

**① `isComputed` 判别式——computed 是"带 .effect 的 ref"，是三分类的唯一运行时依据**（演权衡 5）：
```ts
// packages/pinia/src/store.ts:144-147
function isComputed<T>(value: ComputedRef<T> | unknown): value is ComputedRef<T>
function isComputed(o: any): o is ComputedRef {
  return !!(isRef(o) && (o as any).effect)
}
```

**② 先占位注册 + 子作用域托管跑 setup——装配的灵魂两步**（演权衡 1、3）：
```ts
// packages/pinia/src/store.ts:492-502
  // store the partial store now so the setup of stores can instantiate each other before they are finished without
  // creating infinite loops.
  pinia._s.set($id, store as Store)

  const runWithContext =
    (pinia._a && pinia._a.runWithContext) || fallbackRunWithContext

  const setupStore = runWithContext(() =>
    pinia._e.run(() => (scope = effectScope()).run(() => setup({ action }))!)!
  )!
```

**③ 三分类判别头——ref/reactive(非computed) 归 state**（演权衡 5）：
```ts
// packages/pinia/src/store.ts:505-509
  for (const key in setupStore) {
    const prop = setupStore[key]

    if ((isRef(prop) && !isComputed(prop)) || isReactive(prop)) {
```

**④ 状态镜像——把 setup 创建的 ref 登记进单一根状态树**（演权衡 2）：
```ts
// packages/pinia/src/store.ts:531-532
        // transfer the ref to the pinia state to keep everything in sync
        pinia.state.value[$id][key] = prop
```

**⑤ 函数归 action——包一层拦截器**（演三分类之 action 分支）：
```ts
// packages/pinia/src/store.ts:540-545
    } else if (typeof prop === 'function') {
      const actionValue = __DEV__ && hot ? prop : action(prop as _Method, key)
      // ...
      // @ts-expect-error
      setupStore[key] = actionValue
```

（以上 5 段累计 23 行，每段对应教学钩子里某个原理点。）

## 易混淆 / 边界 / 推断

- **事实**：`pinia._s.set` 发生在 `setup()` 执行**之前**（store.ts:494 在 store.ts:500 之前），这是"先占位"的字面证据，不是注释口号。
- **事实**：option store 不走"占位根状态 + 镜像"路径——它的 state 形状已知，由 `createOptionsStore` 的 setup 直接写进根状态再 `toRefs` 取出（store.ts:169-177），`isOptionsStore` 标志位让装配函数跳过 setup store 专属的占位/镜像/水合分支（store.ts:275、514）。
- **事实**：computed 在 prod 下不被单独处理（store.ts:555 的 getter 登记在 `__DEV__` 分支内）——它只是作为 setupStore 的属性被 `assign` 进 reactive store，靠 reactive 自动保持响应式；只有 dev/devtools 才需要显式登记进 `_hmrPayload.getters`/`_getters`。
- **推断（标注为推断）**：`assign(toRaw(store), setupStore)` 之所以必要（store.ts:578），推断是因为 `reactive()` 代理会在枚举/遍历时影响 `storeToRefs` 的属性识别——把原始属性也挂到 raw 对象上，给后续的定向提取留一个"未被代理包裹"的视图。注释引用的 #799 支持此推断。
- **推断（标注为推断）**：装配函数把"内置方法定义（含 `$patch`/`$subscribe` 的闭包）"与"跑 setup"分开，且内置方法引用的 `isListening`/`isSyncListening` 在函数末尾才置 true——推断是为了让**装配期间 setup 内对 state 的初始化写入不触发订阅**（避免初始化被当成 mutation），与 `$patch` 的暂停/恢复机制（下一章）共用同一对开关。
- **边界**：本章只讲装配；`$patch` 内部的双形态、`mergeReactiveObjects` 的深合并规则、`isListening` 与 watcher 的协调、`_hotUpdate`、插件诊断、SSR 水合 `shouldHydrate`/`skipHydrate`、`createOptionsStore` 的 getters→computed 拼装——均由后续章节展开，本章事实区只点明它们"在装配流程中的位置"，不展开实现。
- **未理解**：暂无阻塞性疑问；`app.runWithContext` 的存在（store.ts:496-497）推断是为在 setup 内正确恢复组件注入上下文（Vue 3 的 app 级 runWithContext），但其对 Pinia 装配的具体影响未在本章 sourceFiles 中体现，留作边界。
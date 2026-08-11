# Options Store：声明式三分与统一组装 · 源码精读

## 给 Writer 的教学钩子（必填，8 子项缺一不可）

- **用户痛点 / 场景**：写 store 的人有两类口味——一类喜欢「把状态/计算/动作分开声明」的传统写法（接近旧状态库习惯、一眼能看出状态全貌、天然能重置），另一类喜欢「像组合式函数一样随手 return」的自由写法。如果内核为这两类写法各维护一套组装逻辑，行为容易漂移、维护成本翻倍。用户真正要的不是「两套引擎」，而是「两种写法背后是同一个 store」。

- **一句话核心思想**：把声明式的三分预先翻译成等价的「组合式返回值」，再丢进同一套组装引擎——一套机制服务两种写法。

- **设计动机（为什么需要它）**：声明式写法对用户友好（状态形状 upfront、易迁移、能自动重置），但内核不愿为它再写一套组装流水线。于是用一个极薄的「翻译层」：在进入组装引擎之前，把声明式的三分各自映射成引擎本就能消化的形态——状态拆成一个个独立 ref、计算属性包成带运行时取实例的 computed、动作原样保留——拼成一个对象当作「组合式返回值」交差。其中：
  - 组装引擎本身（遍历返回值、按响应式特征把成员分流成状态/计算属性/动作）**（已在第 5 章『Setup Store 的运行时自动分流』讲透，本章只看它的新侧面：声明式三分如何被预先「投喂」成一份引擎能直接消化的返回值）**。
  - 活跃指针的自动管理**（已在第 3 章『活跃实例指针』讲透，本章只看新侧面：计算属性在求值前必须显式重设活跃指针，因为求值时机已脱离首次装配的同步上下文）**。
  - 懒装配与注册表占位**（已在第 4 章『defineStore 的懒装配与循环引用破解』讲透，本章只看新侧面：计算属性内部靠「注册表里那个占位实例」，在 store 尚未装配完成时就能自洽地引用自身）**。

- **关键权衡**：
  1. **「翻译成组合式返回值」而非「两套组装流水线」→ 换来单一组装引擎、两种写法行为完全一致 → 代价是计算属性必须延迟到运行时去注册表取实例**：翻译层在 store 创建之前就把每个 getter 包成了 computed，此时外层那个 store 变量还是空的，所以 computed 内部不能闭包引用它，只能在求值那一刻去注册表里捞「那个刚被占位登记的实例」。这是一个时序倒挂——定义在前、引用在后。
  2. **状态形状预先已知（声明式提供一个返回初始对象的函数）→ 换来重置能力可自动实现 → 代价是组合式写法无法自动重置**：重置只需把那个初始函数再执行一次、用一次批量写入覆盖当前状态（且顺带把所有变更合并成一次订阅事件）。而组合式写法的状态是一堆散落的 ref，引擎无从知晓完整形状，重置只能退化为开发期抛错、生产期空操作。
  3. **把集中状态树里的对象拆成独立 ref → 换来与组合式写法的 ref 产物在引擎眼里完全等价 → 代价是引擎里多出一条「跳过状态回流」的分支**：拆分产生的是指向同一棵状态树的 ref 引用，于是状态天然就在集中树里、不需要再回流；但引擎原本为组合式写法写的「把每个 ref 同步回状态树」逻辑对声明式是多余甚至有害的，必须用一个标志位把它短路掉。

- **最小心智模型（3～7 步）**：
  1. 定义 store 时按「第二个参数是不是函数」判定走声明式还是组合式路线，首次实际调用时才分流。
  2. 声明式路线进入翻译层：执行一次状态函数，把结果写进集中状态树。
  3. 用「拆分」把这棵状态对象的每个属性变成独立 ref——与组合式写法里手写的 ref 在引擎眼里无法区分。
  4. 动作原样保留；每个计算属性包成一个 computed，内部在求值时临时重设活跃指针、并去注册表取已登记实例作为自己的 this。
  5. 把「状态 refs + 动作 + 计算 computeds」拼成一个对象，作为翻译层交出的「组合式返回值」。
  6. 把这个返回值连同「我是声明式」标志一起丢给同一套组装引擎。
  7. 引擎按响应式特征分流成员；因为状态已在树里，跳过回流；因为状态形状已知，自动挂上重置方法。

- **最小原理演示（替代旧"复刻范围"）**：
  - **应演示**：一个几十行的「声明式三分 → 组合式返回值」翻译器 + 一个被两种写法共用的极简组装函数。具体演三件事——(a) 状态函数执行后写入集中树、再拆成独立 ref；(b) 每个 getter 包成 computed，内部运行时去注册表取实例（演透「定义在前、引用在后」的时序权衡）；(c) 重置方法靠「再执行一次状态函数 + 一次批量写入」实现，并演组合式写法走同一条组装流水线却拿不到重置方法。每一段都要对应上面某条权衡。
  - **应故意省略**：热更新、开发者工具、动作拦截/订阅、批量合并的深合并细节、服务端水合、插件扩展、完整泛型、markRaw 微优化、deep watch——它们都在别的章或属于工程化脚手架。
  - **演示载体建议**：**首选 TS/JS**。本章核心是「对象拼装 / 数据结构翻译 / 时序倒挂」，纯粹是数据结构与闭包的事，TS/JS 完全讲得透；且本 Atlas 产物本身就是 JS 生态站点，读者最易跑通。只需一个最小的 reactive/computed/effectScope mock（或直接引 Vue），即可同时跑通声明式与组合式两条路径并共享同一个组装函数。无需退回原仓库语言。

- **正文不宜展开的细节**：热更新时声明式 getter 需「重新包 computed」而组合式直接搬运的差异；markRaw 包裹 computed 以避免被外层 reactive 二次代理的微优化；开发者工具载荷里声明式存「原始 getter 函数」、组合式存「computed 本身」的差别；开发期热路径下用 ref 重新拆分的特殊分支；getter 与 state 同名时的诊断告警。

- **推荐的一个执行轨迹例子**：
  - 输入：声明式定义一个计数 store——状态 `{ count: 0 }`、计算属性 `double = count*2`、动作 `inc()` 使 count 自增。
  - 关键中间态：首次调用 → 翻译层执行状态函数 → 集中树得到 `{ count: 0 }` → 拆成 `{ count: Ref<0> }` → `double` 被包成「求值时重设活跃指针 + 去注册表取实例」的 computed → 三者拼成返回值 → 交给组装引擎（带「声明式」标志）→ 引擎把 count 归为状态（跳过回流）、inc 归为动作、double 归为计算属性。
  - 输出：读取 `count===0`、`double===0`；调 `inc()` 后 `count===1`、`double===2`（依赖自动更新）；调 `$reset()` 后 `count===0`、`double===0`（重置也合并成一次订阅事件）。若改成组合式写法，同一条流水线产出的 store 调 `$reset()` 会开发期抛错。

> 以上钩子供 Writer 写「动机→核心思想→心智模型→关键权衡→原理演示」；下面事实部分供核对，不要被 Writer 当目录照抄。

## 概念要点

- **分流判据是「第二个参数的类型」**：定义 store 时，若第二个参数是函数则走组合式路线，否则走声明式路线；这条判断在每次「首次实例化」时生效（懒装配）。源码位置: packages/pinia/src/store.ts:879-881, 902-908

- **翻译层是一个内部 setup 函数**：声明式路线不自行组装 store，而是构造一个 setup 函数，把 state/getters/actions 翻译成它的返回值，再交给组合式路线的组装引擎；第六个参数 `isOptionsStore=true` 是「我是声明式」标志。源码位置: packages/pinia/src/store.ts:149-212（核心 166-209）

- **状态：执行一次状态函数写入集中树，再拆成独立 ref**：`pinia.state.value[id] = state ? state() : {}`，随后 `toRefs(pinia.state.value[id])` 把这棵对象的每个属性变成指向同一对象的 ref。拆分产物与组合式写法手写的 `ref()` 在引擎眼里等价。源码位置: packages/pinia/src/store.ts:169-177

- **计算属性：包成 computed，求值时运行时取实例 + 重设活跃指针**：每个 getter 被 `markRaw(computed(() => { setActivePinia(pinia); const store = pinia._s.get(id)!; return getters[name].call(store, store) }))` 包裹。用 store 同时作为 this 与第一个参数，使 getter 内部可经 `this.别的getter` 或 `store.状态` 互相引用。源码位置: packages/pinia/src/store.ts:188-201

- **「定义在前、引用在后」的时序倒挂**：computed 在组装引擎被调用之前就已创建（setup 在 166-207 定义、`createSetupStore` 在 209 才被调），故内部不能闭包引用外层 `let store`（彼时为空），必须运行时去注册表 `pinia._s.get(id)` 取那个刚被占位登记的实例。源码位置: packages/pinia/src/store.ts:192, 494（占位登记）, 209（之后才组装）

- **动作：原样保留**：actions 作为普通函数直接并入返回值（`assign(localState, actions, …)`），由组装引擎在分流阶段统一识别「typeof === function」并包上拦截层。源码位置: packages/pinia/src/store.ts:179-182, 540-554

- **「声明式」标志的三处关键短路**：(a) 跳过组装引擎里的状态初始化（状态已在翻译层写入树）；(b) 跳过「把每个 ref 同步回状态树」的回流分支（状态天然在树里）；(c) 决定能否自动实现重置。源码位置: packages/pinia/src/store.ts:275-278, 508-533, 330-347

- **重置：复用批量写入、合并成一次订阅事件**：声明式重置 = 再次执行状态函数 + 用 `$patch` 把新状态 `assign` 进去；注释明确写「用 patch 把所有变更合并成单次订阅」。组合式写法生产期为 noop、开发期抛错。源码位置: packages/pinia/src/store.ts:330-347

- **热更新时声明式 getter 需重新包 computed**：开发者工具载荷里，声明式存「原始 getter 函数」、组合式存「computed 本身」；热更新时声明式分支会把新 getter 函数重新包成 `computed(() => { setActivePinia; getter.call(store, store) })`，用保持不变的旧 store 作为 this。源码位置: packages/pinia/src/store.ts:558-561, 657-671

## 关键调用链

声明式实例化主链：
`useStore 首次调用` →（第二个参数非函数）→ `createOptionsStore` → 内部 `setup()`［state() 写入集中树 → toRefs 拆分 → getters 包 computed → assign 拼返回值］→ `createSetupStore(id, setup, options, pinia, hot, isOptionsStore=true)` → 组装引擎遍历分流 → 返回 reactive store
源码位置: packages/pinia/src/store.ts:907 → 149-209 → 214-781

计算属性求值链（getter 自洽引用）：
读取 `store.某getter` → computed 求值 → `setActivePinia(pinia)` → `pinia._s.get(id)` 取实例 → `getters[name].call(store, store)` → 内部经 this/store 访问其它 getter 或状态 → 触发依赖收集
源码位置: packages/pinia/src/store.ts:189-200

重置链：
`store.$reset()` → 再执行 `options.state()` 得新状态 → `this.$patch(($state) => assign($state, newState))` → 走批量写入管道 → 合并为一次订阅事件
源码位置: packages/pinia/src/store.ts:331-339（$patch 管道本身属下一章）

## 源码摘录（带行号，全文累计 ≤ 30 行）

摘录 A — 翻译层核心：状态拆分 + 动作原样 + getter 包 computed（store.ts:177-200 节选）：
```ts
const localState = toRefs(pinia.state.value[id])
return assign(
  localState,
  actions,
  Object.keys(getters || {}).reduce((computedGetters, name) => {
    computedGetters[name] = markRaw(computed(() => {
      setActivePinia(pinia)
      const store = pinia._s.get(id)! // 运行时取已登记实例（定义在前、引用在后）
      return getters![name].call(store, store)
    }))
    return computedGetters
  }, {})
)
```

摘录 B — 重置的双分支：声明式可重置、组合式抛错（store.ts:330-347 节选）：
```ts
const $reset = isOptionsStore
  ? function $reset(this: _StoreWithState<Id, S, G, A>) {
      const { state } = options as DefineStoreOptions<Id, S, G, A>
      const newState: _DeepPartial<UnwrapRef<S>> = state ? state() : {}
      // we use a patch to group all changes into one single subscription
      this.$patch(($state) => { assign($state, newState) })
    }
  : /* setup store：DEV 抛错 / 生产 noop */ ...
```

摘录 C — 分流入口（store.ts:879-907 节选）：
```ts
const isSetupStore = typeof setup === 'function'
options = isSetupStore ? setupOptions : setup
// 首次实例化时：
if (isSetupStore) createSetupStore(id, setup, options, pinia)
else createOptionsStore(id, options as any, pinia)
```

## 易混淆 / 边界 / 推断

- **事实**：声明式的 getter computed 在组装引擎被调用之前就已创建（setup 定义 166-207 早于 createSetupStore 调用 209），所以内部无法引用外层 `let store`，必须运行时去注册表取——这是「翻译成组合式返回值」这一选择直接导致的时序代价。源码位置: packages/pinia/src/store.ts:192, 209, 494

- **事实**：`toRefs` 产出的是指向 `pinia.state.value[id]` 同一对象的 ref 引用，故声明式的状态天然就在集中状态树里，引擎里「同步 ref 回状态树」那段（`!isOptionsStore` 分支）对它多余，必须用标志位短路。源码位置: packages/pinia/src/store.ts:177, 514-533

- **推断（标注为推断）**：getter computed 内显式 `setActivePinia(pinia)` 应属防御性设置——getter 可能在任意作用域被求值（如被别的 store 的 getter 引用、或在组件外的计算属性中读取），彼时活跃指针未必指向本 pinia；显式重设保证 getter 内若调用了别的 `useStore` 仍能正确定位。源码没有直接注释说明这点，属从机制推断。

- **事实**：热更新时声明式与组合式对 getter 的处理不同——声明式在工具载荷存「原始 getter 函数」并在热更新时「重新包 computed」（用不变的旧 store 作 this），组合式则直接存/搬 computed 本身。差异源于：声明式的 getter 是「待包装函数」，组合式的 getter 已经是 computed。源码位置: packages/pinia/src/store.ts:558-561, 657-671

- **事实**：`$reset` 对组合式写法在生产构建里是 `noop`、开发构建里抛错（错误文案明示「built using the setup syntax and does not implement $reset()」）；引擎无法从散落 ref 推断初始形状，故组合式不具备自动重置。源码位置: packages/pinia/src/store.ts:330-347

- **事实**：声明式与组合式在热更新状态合并策略上也不同——声明式因「状态形状 upfront」，缺失键被视为有意删除、按形状调和；组合式因「状态命令式产生、运行时可增属性」，旧值须整体转移以免丢字段。源码位置: packages/pinia/src/store.ts:607-622

- **未理解**：源码 199 行附近留有注释 `// TODO: avoid reading the getter while assigning with a global variable`，表明作者意识到「getter 求值时从注册表取实例」这一时序倒挂设计有改进空间，但具体替代方案未实现，当前实现可用但非终态。源码位置: packages/pinia/src/store.ts:198
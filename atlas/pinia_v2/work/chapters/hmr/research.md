# HMR：保持引用的热迁移 · 源码精读

## 给 Writer 的教学钩子（必填，8 子项缺一不可）

- **用户痛点 / 场景**：开发时改了 store 代码（state 字段改名、改 action 实现、增删 getter），若不做特殊处理：要么整页刷新丢掉当前运行时状态，要么换一个新 store 对象导致组件里早已解构/缓存下来的引用失效、计算属性与侦听器断连。HMR 要解决的是"代码变了，但 store 对象身份和已有状态都不丢"。

- **一句话核心思想**：先建一个临时副本让新代码完整装配一遍以"采集"新形状，再把采集结果就地搬进旧对象——保持引用不变、内容更新。

- **设计动机（为什么需要它）**：组件、计算属性、侦听器、其他 store 都早已持有旧 store 对象的引用，且旧对象身上还挂着当前运行时状态。热更新的硬约束是"对象身份必须不变"，否则所有依赖都得重建、状态全丢。于是采用"副本采集 + 就地迁移"：让新代码以一个自包含的临时形态跑一遍装配（采集它定义的 state/action/getter 的形状与实现），再把采集到的结果灌进旧对象。旧对象身份不变、内容已是新版本。

- **关键权衡（本 Atlas 的核心）**：
  1. **"副本采集 + 就地迁移"而非"替换对象"** → 换来所有持有引用的组件/计算属性/侦听器无感、不丢运行时状态 → 代价是多装配一次临时副本，且临时装配必须走一套与正常创建不同的旁路（state 指向独立热态、action 不预包装），否则会污染真实状态字典或造成双重包装。
  2. **option store 用"深度合并旧值进新形状"、setup store 用"整体转移旧值到新 ref"** → 换来两种形态各自的正确语义：option 形状静态完整、缺字段即"故意删除"，故合并以保留旧运行时值；setup 命令式创建、运行时可新增属性，故整体转移以防这些属性丢失 → 代价是两条迁移分支，深度合并仅在双方都是纯对象时才生效。
  3. **迁移期间用"热更新中"标志关闭状态监听** → 换来热迁移不被当成普通用户变更重复广播给订阅与 devtools → 代价是迁移窗口内订阅短暂静默（同步恢复一项监听、微任务后恢复另一项，与普通补丁的暂停/恢复同构）。
  4. **临时副本的 action 在采集阶段不预包装** → 换来迁移时用统一包装函数重新挂载、避免双重拦截 → 代价是临时副本本身不能被动作订阅观察到（但它本就是一次性中间态，采集完即删）。

- **最小心智模型（3～7 步）**：
  1. 打包工具检测到 store 定义所在模块变化，调起热更新接受回调，传入新模块。
  2. 回调在新模块导出里找出所有"store 工厂"，对每个工厂确认其对应的旧实例已在全局实例表中存在。
  3. 以旧实例为入参调用新工厂，进入"热路径"。
  4. 热路径不重建实例，而是建一个名字带热标记的临时副本，让新代码完整装配一遍，采集新的 state 形状、action、getter。
  5. 调旧实例的热迁移方法，把临时副本采集到的 state/action/getter 就地搬进来；同时删除新形状里不再存在的旧字段。
  6. 迁移期间关闭状态监听以防重复广播，迁移完即删除临时副本及其状态。
  7. 组件持有的旧实例引用未变，但内容已是新版本。

- **最小原理演示（替代旧"复刻范围"）**：
  - 应演示：一个极简的"就地迁移"——持有身份固定的旧对象，写一个 migrate(oldStore, newFactory) 函数：先跑 newFactory 得到一个采集对象，再把采集对象的 state（**分两条分支**演示"深度合并"与"整体转移"）、action、getter 搬进 oldStore，并删掉采集对象里没有的旧字段；最后断言 oldStore === 原引用且字段已是新版。几十行即可。
  - 这段演示演的是**权衡 1（副本采集 + 就地迁移）** 与 **权衡 2（两形态 state 迁移分支）**。
  - 应故意省略：热数据跨加载持久化、生产环境 strip、devtools 深度集成、删除字段后的微任务恢复时序、临时副本的插件执行、option/setup 完整装配机器（那是别的章节）。

- **正文不宜展开的细节**：临时副本用独立热态对象避免污染真实状态树、且 $state 在热态下指向它；旧 store 切换真源 state 到新热态时的暂停/恢复时序（同步恢复、微任务恢复监听）；store id 与初始不一致时降级为整页重载；store 从未被使用时直接跳过；生产构建整段热更新代码被 tree-shake；诊断警告码（id 变更等）。

- **推荐的一个执行轨迹例子**：输入——把 user store 的 state 字段 count 改名为 counter，并改写 increment 实现。关键中间态——建一个带热标记的临时副本装配新代码，得到 state={counter:0}（新形状）、新 increment；热迁移把旧实例里 count 的运行时值视情况（option 合并 / setup 转移）处理，删 count、写 counter、替换 increment。输出——组件持有的旧 store 引用不变，store.count 已删、store.counter 取而代之、increment 是新实现；组件无感、运行时值尽量保留。

> 以上钩子供 Writer 写「动机→核心思想→心智模型→关键权衡→原理演示」；下面事实部分供核对，不要被 Writer 当目录照抄。

## 概念要点

- `acceptHMRUpdate` 在生产环境（`!__DEV__`）直接返回空函数以被 tree-shake；开发环境返回真正的"接受回调"。源码位置: packages/pinia/src/hmr.ts:85-88
- 接受回调取 pinia 实例时优先 `hot.data.pinia`（跨次加载持久化），回退 `initialUseStore._pinia`，并把 pinia 写回 `hot.data.pinia` 以便下次热更新复用同一实例。源码位置: packages/pinia/src/hmr.ts:89-97
- 回调遍历新模块所有导出，用 `isUseStore`（是函数且 `.\$id` 为字符串）识别 store 工厂，且要求 `pinia._s` 已存在该 id（即 store 被使用过）。源码位置: packages/pinia/src/hmr.ts:100-103, packages/pinia/src/hmr.ts:20-22
- 若新模块中 store 的 id 与初始 store 不一致，报诊断 PINIA_R1005 并调用 `hot.invalidate()` 触发整页重载（放弃迁移）。源码位置: packages/pinia/src/hmr.ts:107-111
- **触发点**：以旧 store 作为第二参数调用新版工厂 `useStore(pinia, existingStore)`，进入热路径。源码位置: packages/pinia/src/hmr.ts:118
- `patchObject(newState, oldState)`：遍历 oldState 的 key，key 不在 newState 则整子树跳过；双方皆为纯对象且非 ref/reactive 则递归合并，否则整体覆盖。专供 option store 热迁移。源码位置: packages/pinia/src/hmr.ts:33-62
- 热路径核心（useStore 内）：store 已存在于 `_s` 故不重建，而是建 `__hot:` + id 的临时副本（hot=true），调用 `hot._hotUpdate(newStore)`，再清理临时副本的 state 与缓存项。源码位置: packages/pinia/src/store.ts:919-930
- 临时副本装配旁路（hot=true）：option store 的 setup 用 `toRefs(ref(state ? state() : {}).value)` 造全新本地 state、且不写 `pinia.state.value[id]`；createSetupStore 也跳过初始化 state 字典——避免污染真实状态树。源码位置: packages/pinia/src/store.ts:167-177, packages/pinia/src/store.ts:275-278
- 临时副本的 state 被指向独立的 `hotState`（ref({})）；action 在热态下不经包装（保留原函数供迁移时再包）；$state getter 在热态下返回 `hotState.value`。源码位置: packages/pinia/src/store.ts:280, packages/pinia/src/store.ts:510-511, packages/pinia/src/store.ts:541, packages/pinia/src/store.ts:583-584
- `_hmrPayload`（markRaw）是采集容器，记录 state 键名数组 / actions / getters 及 hotState，供迁移读取与"删除不存在的旧字段"判断。源码位置: packages/pinia/src/store.ts:424-429, packages/pinia/src/store.ts:536-550, packages/pinia/src/store.ts:555-569
- `_hotUpdate(newStore)` 的 state 迁移：遍历新 `_hmrPayload.state`；option store 且双方为纯对象时 `patchObject(newStateTarget, oldStateSource)`（旧值深度合并进新形状）；否则 `newStore.\$state[stateKey] = oldStateSource`（整体转移，注释点名防 #2611 setup store 运行时新增属性丢失）；最后 `store[stateKey] = toRef(newStore.\$state, stateKey)` 让直接访问属性指向新 state。源码位置: packages/pinia/src/store.ts:600-628
- 删除不再存在的旧 state / getter / action 字段（基于新旧 _hmrPayload 差集）。源码位置: packages/pinia/src/store.ts:631-636, packages/pinia/src/store.ts:674-679, packages/pinia/src/store.ts:682-687
- 迁移期间关闭监听：`isListening = false; isSyncListening = false`，把真源 state 切到 `toRef(newStore._hmrPayload, 'hotState')`，同步恢复 `isSyncListening=true`、微任务（nextTick）后恢复 `isListening=true`，注释明示"avoid devtools logging this as a mutation"。源码位置: packages/pinia/src/store.ts:639-645
- action 迁移：用 `action(actionFn, actionName)` 重新包装新 action 赋给 store；getter 迁移：option store 重包 `computed`（内含 setActivePinia + getter.call(store, store)），setup store 直接用副本里的 computed。源码位置: packages/pinia/src/store.ts:647-671
- `_hotUpdating` 标志：迁移开始置 true、结束置 false；\$subscribe 的 watch onTrigger 据此在迁移期不累积 debugger 事件。源码位置: packages/pinia/src/store.ts:601, packages/pinia/src/store.ts:692, packages/pinia/src/store.ts:251
- `_hotUpdate` 在插件应用之前挂载，以允许插件覆盖。源码位置: packages/pinia/src/store.ts:599
- 迁移末尾把 store 的 _hmrPayload 与 _getters 同步为新值，供下一轮热更新的删除判断。源码位置: packages/pinia/src/store.ts:690-691

## 关键调用链

Vite 模块变更 → `import.meta.hot.accept(acceptHMRUpdate(useStore, hot))` → 接受回调(newModule) → 遍历导出用 isUseStore 识别工厂 + 校验已在 _s → `useStore(pinia, existingStore)`（热路径）→ `createSetupStore/createOptionsStore('__hot:'+id, ..., hot=true)` 建临时副本采集 → `existingStore._hotUpdate(newStore)`（patchObject/转移 state、重包 action、重包 getter、删字段、切真源 state 到 hotState、暂停/恢复监听）→ `delete pinia.state.value[hotId]`、`pinia._s.delete(hotId)`
源码位置: packages/pinia/src/hmr.ts:88-122, packages/pinia/src/store.ts:919-930, packages/pinia/src/store.ts:600-693

## 源码摘录（带行号，全文累计 ≤ 30 行）

摘录 A — 热路径：建临时副本并让旧实例就地吃下（store.ts:919-930，对应权衡 1）：
```ts
if (__DEV__ && hot) {
  const hotId = '__hot:' + id
  const newStore = isSetupStore
    ? createSetupStore(hotId, setup, options, pinia, true)
    : createOptionsStore(hotId, assign({}, options) as any, pinia, true)
  hot._hotUpdate(newStore) // 旧实例就地吃下新副本
  delete pinia.state.value[hotId]
  pinia._s.delete(hotId)
}
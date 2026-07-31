# HMR：保持引用的热迁移

> 前置章节：[store 装配机器]（双形态归一、`$state` 单一真源）、[$patch：状态变更与深度合并]（暂停 watcher → 手动广播 → 恢复）。

## 1. 痛点：代码变了，但 store 对象不能换

开发时改了 store 代码——state 字段改名、改 action 实现、增删 getter——有两种「偷懒」做法，都会翻车：

- **整页刷新**：当前运行时状态（用户已填的表单、已加载的数据）全部丢失。
- **换一个新 store 对象**：组件里早已 `const { count, increment } = useStore()` 解构下来的引用、挂在 `computed`/`watch` 上的依赖、其他 store 对它的引用——**全部指向旧对象，瞬间断连**。

于是热更新的硬约束浮出水面：

> **store 对象的「身份」（引用）必须不变，但「内容」必须是新版本。**

身份一变，所有持有引用的地方都得重建；而旧对象身上还挂着当前运行时状态，丢了就是丢了。

## 2. 核心思想：副本采集 + 就地迁移

满足上述硬约束的策略只有一条——**不替换对象，而是把新内容灌进旧对象**。但「新内容」从哪来？新代码得先完整装配一遍才能知道自己的 state/action/getter 长什么样。

> 一句话：**先建一个临时副本让新代码完整装配一遍以"采集"新形状，再把采集结果就地搬进旧对象——保持引用不变、内容更新。**

这拆成两个阶段：

```
新模块 ──装配──▶ [临时副本：采集新形状] ──就地迁移──▶ 旧对象（身份不变，内容已更新）
                                                    ▲
                                          组件/computed/watch 持有的引用
```

为什么不能直接把新代码装配到旧对象上？因为正常装配会写真实状态字典 `pinia.state.value[id]`、会给 action 套上包装器——这会**污染真实状态树**或造成**双重包装**。所以临时副本必须走一套与正常创建不同的「旁路」：state 指向独立热态、action 不预包装。

## 3. 入口 acceptHMRUpdate：识别工厂、触发热路径

`acceptHMRUpdate(useStore, import.meta.hot)` 返回一个「接受回调」，注册给打包工具（Vite）。模块一变，回调被调用，参数是新模块导出。它做三件事：

**① 生产环境整段消失。** `!__DEV__` 时直接返回 `() => {}`，被 tree-shake 掉，零运行时成本。

**② 在新模块导出里找出所有「store 工厂」。** 用 `isUseStore` 判定——「是函数、且 `.$id` 是字符串」即为一个 `defineStore` 出来的工厂：

```ts
// hmr.ts
export const isUseStore = (fn: any): fn is StoreDefinition =>
  typeof fn === 'function' && typeof fn.$id === 'string'
```

而且要求 `pinia._s.has(useStore.$id)`——**这个 store 之前被使用过、旧实例已在全局表里**。从未用过的 store 没有旧实例可迁移，直接跳过。

**③ 触发热路径。** 关键一行：以旧实例为第二参数调用新工厂 `useStore(pinia, existingStore)`。注意——它**没有用返回值**。返回的是旧实例本身；调用只是为了借工厂内部的装配机器去「采集」新形状。

```
模块变更 → acceptHMRUpdate 回调(newModule)
        → 遍历导出，isUseStore 识别工厂 + 校验已在 _s
        → useStore(pinia, existingStore)   ← 进入热路径
```

> **降级兜底**：若新模块里 store 的 `$id` 与初始不一致（改名了 store 本身，不是字段改名），报诊断 `PINIA_R1005` 并调 `hot.invalidate()` 触发**整页重载**——这种结构性变更放弃迁移。

## 4. 采集：临时副本 + `_hmrPayload` 容器

`useStore(pinia, existingStore)` 进入热路径后，因为 `pinia._s` 里已有该 id，**不重建实例**，而是建一个名字带热标记的临时副本：

```ts
// store.ts 热路径
if (__DEV__ && hot) {
  const hotId = '__hot:' + id
  const newStore = isSetupStore
    ? createSetupStore(hotId, setup, options, pinia, true)   // 末参 hot=true
    : createOptionsStore(hotId, assign({}, options), pinia, true)

  hot._hotUpdate(newStore)        // 旧实例就地吃下新副本 ← 第 5 节

  delete pinia.state.value[hotId] // 清掉临时副本的状态
  pinia._s.delete(hotId)          // 清掉临时副本本身
}
```

`hot=true` 让装配走「旁路」，两处关键偏离正常创建：

- **state 不写真源**：option store 的 setup 用 `toRefs(ref(state ? state() : {}).value)` 造一个全新本地 state，**不写** `pinia.state.value[id]`；`createSetupStore` 也跳过初始化 state 字典。这样临时副本的装配完全不污染真实状态树。
- **临时副本的 state 指向独立的 `hotState`**（一个 `ref({})`），`$state` getter 在热态下返回 `hotState.value`。

而采集结果统一收进一个 `markRaw` 容器 **`_hmrPayload`**——它就是「新形状清单」，供迁移时读取：

```ts
// store.ts 装配期间逐项登记
const _hmrPayload = markRaw({
  actions: {},      // key → 原始 action 函数（热态下不预包装）
  getters: {},      // key → computed（setup 用副本里的、option 用原始 getter）
  state: [],        // state 的 key 名数组
  hotState,         // 独立热态
})
```

遍历 setup 返回值分类时：是 ref 且非 computed → `_hmrPayload.state.push(key)`；是函数 → `_hmrPayload.actions[key]`（热态下**不包装**，保留原函数供迁移时再包）；是 computed → `_hmrPayload.getters[key]`。

临时副本是一次性中间态，采集完即删，所以它 action 不被预包装、不被插件订阅观察都无所谓。

## 5. 就地迁移 `_hotUpdate`：核心机制

`existingStore._hotUpdate(newStore)` 把临时副本采集到的 state/action/getter 灌进旧实例。它做四件事。

### 5.1 state 迁移：两条分支（本章的核心权衡）

`_hotUpdate` **遍历「新形状」的 state key**（`_hmrPayload.state` 数组），对每个新 key：

```
对每个 newStateKey（来自新形状）:
  ├─ 该 key 也在旧 $state 里？
  │    ├─ 是，且 option store 且新旧值都是纯对象 ──▶ patchObject：旧值【深度合并】进新形状
  │    └─ 否 ─────────────────────────────────────▶ 整值【转移】：newStore.$state[key] = oldStore.$state[key]
  └─ 让 store[key] = toRef(newStore.$state, key)   ← 直接访问属性指向新 state
```

**分支 A（option store，深度合并）** 用 `patchObject(newState, oldState)`：遍历旧 state 的 key，**key 不在新形状则整子树跳过**；双方都是纯对象（且非 ref/reactive）就递归合并，否则整值覆盖。option store 形状静态完整、缺字段即「故意删除」，故用合并保留旧运行时值。

**分支 B（setup store，整体转移）** 直接 `newStore.$state[key] = oldStore.$state[key]`。setup store 命令式创建、运行时可新增属性，整值转移是为了**防止这些运行时新增的属性丢失**（源码注释点名 issue #2611）。

> ⚠️ **改名陷阱（重要）**：注意遍历的是**新 key**，只迁移**新旧同名**的 key。若把字段 `count` 改名为 `counter`：新形状只有 `counter`、旧形状只有 `count`——`'counter' in 旧$state` 为 false，合并/转移分支都不命中，`counter` 保持新初值；随后 `count` 因不在新形状被删除。**旧运行时值随之丢失**。Pinia **没有改名探测**，真实 `_hotUpdate` 同样只处理新旧同名 key。所以热更新里给 state 字段改名 ≈ 该字段状态清零——这是设计取舍，不是 bug。

### 5.2 删除旧字段（新旧差集）

分别对 state / getter / action：遍历旧实例已有的 key，凡不在新 `_hmrPayload` 里的就 `delete store[key]`。这就是「删字段」的来源——新代码删掉一个 getter，旧实例上对应属性也会被清掉。

### 5.3 action / getter 重包

- **action**：用统一的 `action(actionFn, actionName)` 包装器重新挂载到 store。因为临时副本采集时 action 没预包装，这里统一包一次，避免双重拦截，也让 `$onAction`/devtools 能继续观察到新实现。
- **getter**：option store 把原始 getter 重新包成 `computed(() => { setActivePinia(pinia); return getter.call(store, store) })`；setup store 直接复用副本里已有的 computed。

### 5.4 静默切源：复用 `$patch` 的暂停/恢复原语，但目的相反

迁移末尾要把旧实例的真源 state 切到新采集态：

```ts
// store.ts _hotUpdate 内
isListening = false          // 关掉两路监听
isSyncListening = false
pinia.state.value[$id] = toRef(newStore._hmrPayload, 'hotState')  // 切源
isSyncListening = true       // 同步先恢复一路
nextTick().then(() => { isListening = true })                     // 微任务后恢复另一路
// 注释原话：avoid devtools logging this as a mutation
```

这里复用了 `$patch` 那套 `isListening`/`isSyncListening` **暂停-恢复原语**（见 [state-patch] 章节），但**目的相反**：

| | `$patch` | `_hotUpdate` |
|---|---|---|
| 暂停后做什么 | 调 `triggerSubscriptions` 把这次改动**集中广播成一个**订阅事件 | **不广播**，让这次切源被静默吞掉 |
| 目的 | 一次 patch = 一个订阅事件（去抖） | 不让热迁移被当成普通用户变更重复上报 devtools |

此外，`_hotUpdating` 标志在迁移开始置 true、结束置 false，`$subscribe` 的 watch `onTrigger` 据此在迁移窗口内**不累积** debugger 事件。

> **📝 源码对照**（全文仅此一处行号）：热路径建临时副本 `store.ts:919-930`；`_hotUpdate` 的 state 两分支迁移 `store.ts:600-628`；深度合并 `patchObject` 在 `hmr.ts:33-62`；静默切源暂停/恢复 `store.ts:639-645`；入口 `acceptHMRUpdate` 在 `hmr.ts:88-122`。

## 6. 心智模型：七步流程

```
①打包工具检测到 store 模块变化，调起接受回调，传入新模块
        ↓
②回调在新模块导出里用 isUseStore 找出所有 store 工厂，
   对每个确认其旧实例已在 pinia._s 中
        ↓
③以旧实例为入参调用新工厂 useStore(pinia, existingStore)，进入热路径
        ↓
④热路径不重建实例，建 '__hot:'+id 临时副本（hot=true），
   让新代码完整装配一遍，采集新 state/action/getter 形状
        ↓
⑤调旧实例的 _hotUpdate：state 走两分支迁移、重包 action/getter、删差集字段
        ↓
⑥迁移期间关闭状态监听（静默），迁移完删除临时副本及其热态
        ↓
⑦组件持有的旧实例引用未变，但内容已是新版本 —— 无感、运行时值尽量保留
```

## 7. 最小原理演示：手写一个 `migrate`

下面剥离真实装配机器，只保留「采集 + 就地迁移」的核心逻辑，演**核心权衡 1（副本采集 + 就地迁移）** 与 **权衡 2（state 两分支）**。为让"值保留"分支真正命中，**字段名保持不变**（`count` 保留、改写 `increment`、新增 `doubled`）：

```ts
import { toRef } from 'vue'

// 极简纯对象判定（真实代码里 Pinia 自带 isPlainObject，并额外排除 ref/reactive）
const isPlainObject = (v: unknown) =>
  Object.prototype.toString.call(v) === '[object Object]'

// 采集：新代码装配一遍，得到「新形状」
function captureV2() {
  return {
    // state 用普通值，聚焦迁移逻辑本身（真实代码里是 ref / reactive）
    state: {
      count: 0,                          // 标量
      profile: { name: '', vip: false }, // 嵌套纯对象
    },
    actions: { increment: () => 'v2' },  // 新实现
    getters: { doubled: () => 'v2' },    // 新增 getter
  }
}

// 就地迁移：把采集结果灌进旧对象，身份不变、内容更新
function migrate(oldStore: any, captured: any) {
  const old = oldStore.$state

  for (const key of Object.keys(captured.state)) {
    const hit = key in old
    if (hit && isPlainObject(captured.state[key]) && isPlainObject(old[key])) {
      // 分支 A（option 语义）：旧值深度合并进新形状 → 保留旧运行时值
      for (const k in old[key]) if (k in captured.state[key]) captured.state[key][k] = old[key][k]
    } else if (hit) {
      // 分支 B（setup 语义）：整值转移（标量 / ref 等走这里）
      captured.state[key] = old[key]
    }
    // 让 store.count / store.profile 直接指向新 state
    oldStore[key] = toRef(captured.state, key)
  }

  // 删除新形状里不再存在的旧字段（新旧差集）
  for (const key of Object.keys(old)) if (!(key in captured.state)) delete oldStore[key]

  // 迁移 action / getter（真实代码里会重新包装，此处直接挂载以演示替换）
  for (const k in captured.actions) oldStore[k] = captured.actions[k]
  for (const k in captured.getters) oldStore[k] = captured.getters[k]

  oldStore.$state = captured.state
}

// 驱动：一个已跑了一阵、持有运行时值的旧 store
const store = {
  $state: { count: 5, profile: { name: 'Ada', vip: true } },
  increment: () => 'v1',
  doubled: () => 'v1',
}
const before = store                  // 记下身份

migrate(store, captureV2())

console.log(store === before)           // true   ← 身份不变
console.log(store.count.value)          // 5      ← 同名标量走分支 B，旧运行时值保留
console.log(store.profile.value.name)   // 'Ada'  ← 嵌套对象走分支 A 深度合并，旧值保留
console.log(store.increment())          // 'v2'   ← action 已是新实现
console.log(store.doubled())            // 'v2'   ← getter 已是新版本
```

对照第 5.1 节的改名陷阱：若把上面 `captureV2` 的 `count` 改名为 `counter`，则 `'counter' in old` 为 false、合并/转移都不命中，最终 `store.counter.value === 0`（新初值），而旧 `count` 被删除、值 5 丢失——这正是真实 `_hotUpdate` 只迁移新旧同名 key 的行为。

> 本章故意省略：热数据跨次加载持久化（`hot.data.pinia`）、生产 tree-shake、devtools 深度集成、临时副本的插件执行、option/setup 完整装配机器（见 [store-assembly] 章节）。

## 8. 关键权衡

1. **「副本采集 + 就地迁移」而非「替换对象」** → 换来所有持有引用的组件/computed/watch 无感、不丢运行时状态 → 代价是多装配一次临时副本，且临时装配必须走与正常创建不同的旁路（state 指向独立热态、action 不预包装），否则污染真实状态树或双重包装。

2. **option store「深度合并旧值」、setup store「整体转移旧值」** → 换来两种形态各自的正确语义：option 形状静态、缺字段即故意删除故合并保留旧值；setup 命令式、运行时可增属性故整体转移防丢失（#2611）→ 代价是两条迁移分支，深度合并仅在双方都是纯对象时生效；且只处理新旧同名 key，**改名必丢值**。

3. **迁移期间用「热更新中」标志 + 暂停监听** → 换来热迁移不被当成普通用户变更重复广播给订阅与 devtools → 代价是迁移窗口内订阅短暂静默（同步恢复一路、微任务后恢复另一路），与 `$patch` 共用同一套暂停/恢复原语但目的相反。

4. **临时副本的 action 在采集阶段不预包装** → 换来迁移时用统一包装函数重新挂载、避免双重拦截 → 代价是临时副本本身不能被 `$onAction` 观察到（但它本就是一次性中间态，采集完即删）。
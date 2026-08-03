# HMR：保留状态的就地热更新 · 源码精读

## 给 Writer 的教学钩子（必填，8 子项缺一不可）

- **用户痛点 / 场景**：开发时改一行 store 代码就要整页刷新，登录态、表单输入、调试到一半的状态全没了；即便想做热更新，如果直接换掉 store 实例，组件里早已持有的旧引用、跨 store 互相引用、已注册的订阅全都会指向被抛弃的旧实例——热更后"看似更新、实则用旧"。需要一个"原地焕新"的机制。

- **一句话核心思想**：热更新不换掉正在用的那个对象，而是另起一个替身跑出新代码，再把替身的内容原样搬进旧对象——对象身份不变、运行时状态不丢。

- **设计动机（为什么需要它）**：热更新的本质矛盾是"想换逻辑、又不能换对象"。换逻辑是因为源码变了；不能换对象是因为对象的身份（被组件、被其它 store、被订阅系统持有）一旦改变，所有旧引用全部失效。于是 Pinia 选择"造替身 + 原地搬运"：替身负责忠实地把新代码装配一遍，本体负责保持身份不变、只把内部成员逐个替换成新版。
  - 承前 1（已在第 4 章『Store 装配：effectScope 托管的返回值分类与状态镜像』讲透"先占位注册再懒装配"的装配流程）：本章不重讲装配，只看它的新侧面——**复用同一套装配流程去制造第二个、用完即弃的临时产物**，替身因此自动得到正确的 state/action/getter 分类。
  - 承前 2（已在第 5 章『状态变更模型：$patch 双形态与暂停监听批处理』讲透"暂停监听再统一恢复"的批处理套路）：本章不重讲暂停监听，只看它的新侧面——**热更新期间一次性的"状态树大切换"也要躲开监听器**，否则会被订阅系统误记为一次用户变更。

- **关键权衡（本 Atlas 的核心）**：
  1. **就地变异既有对象，而非替换它** → 换来运行时状态保留 + 对象身份 / 跨 store 引用 / 订阅全部不断 → 代价是搬运逻辑必须精确同步新旧"状态 / 动作 / 计算属性"三个集合的增、删、改，任何一处漏同步都会留下幽灵成员或残留旧逻辑。
  2. **用替身 store 完整跑一遍既有装配流程，而非为热更新写一套并行重建逻辑** → 换来零分叉复用同一套装配与返回值分类机制，新版本的"清单"自动生成 → 代价是每次热更新都要完整重跑一次 setup（含重新包装动作与计算属性），且替身的状态必须隔离进一个独立容器、绝不触碰真实状态树。
  3. **状态迁移分两路：选项式按新形状深调和、组合式整值迁移** → 换来选项式 store（状态形状预先声明）能优雅同步字段增删、组合式 store（状态命令式创建、运行时还能加属性）能避免整块丢字段 → 代价是两条路径须分别维护、迁移语义略有差异。
  4. **整套机制仅开发期可用，生产构建下入口退化为空函数** → 换来生产包里热更新逻辑被彻底摇除（它本就只服务于打包器的模块热替换接口，生产无此接口）→ 代价是它纯属开发期产物，生产环境无任何对应物。

- **最小心智模型（3～7 步）**：
  1. 开发者在 store 文件里，把一个热更新回调注册到打包器的模块热替换接口上。
  2. 源码改动，打包器触发回调，把新模块传进来。
  3. 回调从新模块里找到那个 useStore，并确认它对应的 store 已经被实例化过（否则无需更新）。
  4. 以"既有 store"为参数调用新 useStore，进入其热更新分支。
  5. 用新代码装配一个带特殊前缀的**替身 store**：它的状态被收进一个独立容器，绝不写回真实状态树。
  6. 对既有 store 执行**就地搬运**：保留旧运行时状态值（按语法选调和或整值迁移）、换上新动作、换上新计算属性、删掉已移除的成员、把状态树重新指向替身的容器，并在切换前后短暂暂停监听。
  7. 清理替身——既有 store 身份不变，却已持有全新逻辑与保留下来的旧状态。

- **最小原理演示（替代旧"复刻范围"）**：
  - **应演示**：一个几十行的脚本，演透权衡 1（就地变异 vs 替换）。要同时呈现三件事——状态保留、逻辑焕新、身份不变，外加成员增删。
  - **应故意省略**：打包器集成、计算属性重包、暂停监听、选项式/组合式双路径、动作追踪包裹。
  - **演示载体建议**：本章是 TS/JS 仓库、机制是纯运行时数据搬运，建议写成 `node`/`bun` 能直接跑的 JS 脚本（能跑最好，非硬要求）。核心是 `hotUpdate(本体, 替身)` 这个搬运函数。
  ```js
  // 演透"就地变异"：身份不变、状态保留、逻辑焕新、成员增删
  function makeStore() {
    const s = { _state: { count: 0 },
      inc() { s._state.count++ },
      get double() { return s._state.count * 2 } }
    return s
  }
  const store = makeStore()
  for (let i = 0; i < 5; i++) store.inc()       // 用户已把状态用到 count=5
  const externalRef = store                      // 外部早已持有的引用

  // 新版代码：inc 改 +2、新增 triple、删除 double
  function makeStoreV2() {
    const s = { _state: { count: 0 },
      inc() { s._state.count += 2 },
      get triple() { return s._state.count * 3 } }
    return s
  }

  // 就地搬运（演权衡 1 的核心）
  function hotUpdate(oldStore, neo) {
    for (const k in neo._state)                  // 保留旧运行时状态
      if (k in oldStore._state) neo._state[k] = oldStore._state[k]
    oldStore.inc = neo.inc                        // 动作焕新
    Object.defineProperty(oldStore, 'triple',    // 新增计算属性
      { get: () => neo.triple, configurable: true, enumerable: true })
    delete oldStore.double                        // 删除已移除成员
    oldStore._state = neo._state                  // 状态树指向新容器
  }

  hotUpdate(store, makeStoreV2())
  console.log(externalRef._state.count)           // 5   —— 身份不变 + 状态保留
  externalRef.inc()
  console.log(externalRef._state.count)           // 7   —— 新逻辑（+2）
  console.log(externalRef.triple)                 // 21  —— 新增成员生效
  console.log('double' in externalRef)            // false —— 旧成员已删
  ```

- **正文不宜展开的细节**：替身的"清单"对象为何要 markRaw；替身动作为何在装配时不包追踪、偏要留到搬运时才重新包装；选项式计算属性在搬运时为何要重包一层并绑定到既有对象的 this；id 变化时为何只能整页刷新并触发告警；微任务（下一个 tick）恢复监听的精确时机；这些是工程边角，供 Writer 裁剪。

- **推荐的一个执行轨迹例子**：
  - 输入：用户改了 store 文件 → 回调被调用，最终落到 `useStore(pinia, existingStore)`。
  - 关键中间态：替身装配完成，其清单记录了新版的 state 键列表、动作集合、计算属性集合；本体开始搬运——旧 count 值 5 被搬进新状态容器、动作被重新包装、计算属性被重绑、状态树整体改指向新容器、监听在切换瞬间被短暂关闭。
  - 输出：本体对象（身份不变）现持有新版逻辑 + 保留下来的旧状态；所有外部旧引用自动看到新行为，无需重新取实例。

> 以上钩子供 Writer 写「动机→核心思想→心智模型→关键权衡→原理演示」；下面事实部分供核对，不要被 Writer 当目录照抄。

## 概念要点

- 入口是一个"accept 回调工厂"，注册到打包器的模块热替换接口；生产构建下 `!__DEV__` 直接返回空函数 `() => {}`，整套机制被 tree-shake 摇除。源码位置: packages/pinia/src/hmr.ts:85-87
- 回调靠 `hot.data.pinia || initialUseStore._pinia` 找到 pinia 实例；其中 `_pinia` 在 store 首次创建时被记录到 useStore 上，`hot.data.pinia` 用于跨模块加载保留同一个 pinia。源码位置: packages/pinia/src/hmr.ts:89, packages/pinia/src/store.ts:911-913
- 若 store 从未被使用（pinia 为空）直接 return，无需更新；若新模块里的 useStore 的 `$id` 与原 id 不符，调 `hot.invalidate()` 整页刷新（id 变了无法就地更新）。源码位置: packages/pinia/src/hmr.ts:91-94, 107-111
- 回调核心动作：`useStore(pinia, existingStore)`——把既有 store 作为 useStore 的第二个参数（即 hot 形参）传入，从而进入其热更新分支。源码位置: packages/pinia/src/hmr.ts:118
- useStore 的 hot 分支：用新代码装配一个 `'__hot:' + id` 的替身 store，调既有 store 的 `_hotUpdate(newStore)`，再从状态树和注册表里清理掉替身。源码位置: packages/pinia/src/store.ts:919-930
- 替身装配时 `hot=true`：不写真实 `pinia.state.value[hotId]`，state 全部收进独立的 `hotState` ref；`$state` 的 getter 返回 `hotState.value`、setter 在热模式下直接抛错。源码位置: packages/pinia/src/store.ts:166-177, 275-278, 280, 508-511, 583-589
- `_hmrPayload` 是替身的"新版本清单"：`state`（键名列表）、`actions`（原始函数）、`getters`、以及 `hotState`；装配时按返回值类型分类填充。源码位置: packages/pinia/src/store.ts:424-429, 536-569
- `_hotUpdate` 就地搬运四步：(a) 遍历新清单的 state 键并保留旧运行时值——选项式且双方均为普通对象时用 `patchObject` 按新形状深调和，否则整值迁移（setup store 命令式创建、运行时可加属性，整值迁移避免丢字段，#2611）；(b) 删除新清单里已不存在的旧 state；(c) 动作重新用 `action()` 包一层（恢复 `$onAction` 追踪、绑定既有 store）；(d) 计算属性在选项式下重包 `computed` 并绑定既有 store 为 this、组合式下直接搬用；最后删被移除的 getter/action 并替换清单。源码位置: packages/pinia/src/store.ts:600-693
- state 树大切换（`pinia.state.value[$id]` 重指向 `hotState`）前后用 `isListening/isSyncListening` 暂停 `$subscribe` 的 watcher，并在下一个 tick 恢复，避免这次切换被记为一次用户变更——这是对第 5 章暂停监听套路的复用。源码位置: packages/pinia/src/store.ts:639-645
- `patchObject(newState, oldState)`：遍历 `oldState` 的键，只处理与 `newState` 共有的键（普通对象递归合并、否则整值用旧值覆盖），**不删除** `newState` 独有的键；删除动作由调用方 `_hotUpdate` 另行完成。源码位置: packages/pinia/src/hmr.ts:33-62, packages/pinia/src/store.ts:630-636
- 替身的 action 在装配时**不**包 `action()`（直接存原始 prop 进清单），到 `_hotUpdate` 时才重新包，目的是让新动作的包裹器绑定既有 store 而非替身，保证热更后动作触发的是本体的订阅。源码位置: packages/pinia/src/store.ts:540-549, 647-654
- watcher 的 `onTrigger` 在 `_hotUpdating` 期间不做任何事，避免 HMR 的 state 切换被 devtools 当作 mutation 记录。源码位置: packages/pinia/src/store.ts:246-263, 251

## 关键调用链

```
import.meta.hot.accept( acceptHMRUpdate(useStore, hot) )      [hmr.ts:78]
  └─ [源码改动] 回调(newModule)                                [hmr.ts:88]
       └─ useStore(pinia, existingStore)                       [hmr.ts:118]
            └─ useStore 的 hot 分支                             [store.ts:919]
                 ├─ createSetupStore('__hot:'+id, …, hot=true) [store.ts:921-923]
                 ├─ existingStore._hotUpdate(newStore)         [store.ts:925]
                 │    ├─ state 迁移(patchObject / 整值)         [store.ts:602-628]
                 │    ├─ 删被移除 state                         [store.ts:631-636]
                 │    ├─ 暂停监听 + 状态树重指向 hotState        [store.ts:639-645]
                 │    ├─ action 重包 action()                  [store.ts:647-654]
                 │    ├─ getter 重包(option)/直用(setup)        [store.ts:657-671]
                 │    ├─ 删被移除 getter/action                 [store.ts:674-687]
                 │    └─ 替换 _hmrPayload / _getters            [store.ts:690-692]
                 └─ 清理替身(state.value 与 _s)                [store.ts:928-929]
```

## 源码摘录（带行号，全文累计 ≤ 30 行）

accept 回调主体——找 pinia、校验 id、把既有 store 作为 hot 参数传入：

```ts
// packages/pinia/src/hmr.ts:88-119
return (newModule: any) => {
  const pinia = hot.data.pinia || initialUseStore._pinia
  if (!pinia) return
  hot.data.pinia = pinia
  for (const exportName in newModule) {
    const useStore = newModule[exportName]
    if (isUseStore(useStore) && pinia._s.has(useStore.$id)) {
      if (useStore.$id !== initialUseStore.$id) return hot.invalidate()
      useStore(pinia, pinia._s.get(useStore.$id)!)
    }
  }
}
```

`_hotUpdate` 的 state 迁移核心——保留旧运行时值，选项式调和、组合式整值：

```ts
// packages/pinia/src/store.ts:602-628
newStore._hmrPayload.state.forEach((stateKey) => {
  if (stateKey in store.$state) {
    const old = store.$state[stateKey]
    if (isOptionsStore && isPlainObject(newStore.$state[stateKey]) && isPlainObject(old)) {
      patchObject(newStore.$state[stateKey], old) // option：按新形状调和
    } else {
      newStore.$state[stateKey] = old             // setup：整值迁移（#2611）
    }
  }
  store[stateKey] = toRef(newStore.$state, stateKey)
})
```

useStore 的 hot 分支——造替身、就地搬运、清理：

```ts
// packages/pinia/src/store.ts:919-930
if (__DEV__ && hot) {
  const hotId = '__hot:' + id
  const newStore = isSetupStore ? createSetupStore(hotId, setup, options, pinia, true)
    : createOptionsStore(hotId, assign({}, options), pinia, true)
  hot._hotUpdate(newStore)
  delete pinia.state.value[hotId]; pinia._s.delete(hotId)
}
```

## 易混淆 / 边界 / 推断

- 事实：`patchObject` 的 JSDoc 写 "remove any key not existing in newState"，但实现只遍历 `oldState`、对 `newState` 没有的键 `continue` 跳过，并不删除任何键；真正的"删除被移除 state"发生在 `_hotUpdate` 的 store.ts:631-636。推断：JSDoc 描述的是 HMR 整体组合效果，而非该函数的单级行为，读者易被注释误导。源码位置: packages/pinia/src/hmr.ts:25-31 vs 33-62
- 事实：一次热更新涉及两个 store——替身（`__hot:id`，新代码的完整产物，用完即弃）与本体（原 id，就地焕新目标，身份永不变）。替身的状态隔离在 `hotState`、绝不写真实状态树，这是"造替身但不污染本体"的关键。
- 事实：选项式 store 的 getter 在清单里存的是**原始函数**（`options.getters[key]`），`_hotUpdate` 时重包 `computed` 并把 this 绑到既有 store；组合式 store 存的是 computed 本体，直接搬用。源码位置: packages/pinia/src/store.ts:557-561, 657-671
- 推断：替身 action 故意在装配时不包 `action()`、留到 `_hotUpdate` 才重包，是为了让 `$onAction` 包裹器绑定到**既有 store**（而非替身），从而热更后动作触发的是本体的订阅集合、而不是随替身一起被清理掉的订阅。
- 边界：store 的 id 变化（如重构改了 store 名）无法就地更新——身份已变，只能 `hot.invalidate()` 整页刷新，并经 `diagnostics.PINIA_R1005` 告警。源码位置: packages/pinia/src/hmr.ts:107-111
- 边界：若该 store 从未被 `useStore()` 调用过（`pinia` 为空、注册表里没有），accept 回调直接 return——没有可被热更新的本体，等首次使用时自然拿到新代码。源码位置: packages/pinia/src/hmr.ts:91-94
- 未理解：无。
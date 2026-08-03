# $patch 与深度合并：批量变更的统一入口 · 源码精读

## 给 Writer 的教学钩子（必填，8 子项缺一不可）

- **用户痛点 / 场景**：用户在 store 里要改三个字段，如果没有统一入口，只能逐条直改——每次都会触发一次 watcher，订阅者收到三次回调、UI 也可能重渲染三次；而且批量更新既想要「函数式 mutator」（自由度高、能写 push/splice）又想要「对象式 partial」（声明式、可序列化），还要正确处理嵌套对象、Map、Set、嵌套 ref/reactive——每个用法各搞一套会乱。

- **一句话核心思想**：把 patch 窗口内的所有变更「先静默、再一次性通知」，并按数据类型分流（函数直改、对象递归合并、Map/Set 专门处理）。

- **设计动机（为什么需要它）**：Pinia 把每个 store 的 state 收口到全局集中状态树里，外部所有写入都需要被观测到——但 Vue 的 watch 是逐次触发的，批量更新场景下重复触发代价大。需要一个统一入口，让用户既能命令式 mutator、又能声明式 partial，同时把内部多次赋值合并成一次外部通知，并且正确处理集合类型与响应式包装。

- **关键权衡**：
  1. **临时关闭 watcher + 手动触发订阅** → 换来「patch 窗口内多次赋值合并为一次通知」 → 代价：同步监听立即恢复，但异步监听必须等下一个 microtask 才恢复；这中间若有人直改 state，异步订阅会丢一次事件（订阅窗口设计必须意识到这一点）。
  2. **partial 路径用递归合并而非浅 assign** → 换来「嵌套普通对象深合并、用户可局部 patch 某子树」 → 代价：递归遍历的常数开销；非普通对象（数组、Date、子 ref/reactive）一律整体替换，用户得记住「数组用 mutator 路径、普通对象用 partial 路径」。
  3. **Map 走 set、Set 走 add** → 换来「keyed collection 的『增量更新』语义能工作」 → 代价：Map 是「按 key 覆盖值」而非真正的递归 merge；Set 只能 add 不能 delete——要删得走 mutator 路径。

- **最小心智模型（3～7 步）**：
  1. 用户调用 $patch，参数是函数或对象，进入分流。
  2. 立即把「异步监听」「同步监听」两个开关都关掉，watcher 暂停响应。
  3. 函数路径：把当前 store 的 state 喂给 mutator，用户在回调里自由改。
  4. 对象路径：调递归合并函数，按 key 遍历——普通对象递归合并、Map 按 key 覆盖值、Set 批量 add、其他类型整体赋值。
  5. 构造 mutation 描述符（带类型标记 + dev 调试事件）。
  6. 手动触发一次订阅，把描述符 + 新 state 发给所有订阅者。
  7. 立即恢复同步监听；异步监听在下一个 microtask 由 token 校验后恢复。

- **最小原理演示（替代旧"复刻范围"）**：
  - 应演示：核心思想 = 「暂停 watcher + 手动触发一次」让多次变更合并成一次通知。一行一原理：`listening=false` 演权衡 1（关闭观测）；`mutator(state)` 演函数路径；`subs.forEach(cb)` 演手动触发；`myId=Symbol()` 演嵌套 token；`nextTick.then(=> listening=true)` 演异步恢复的延迟语义。
  - 应故意省略：Map/Set 分支、对象递归合并函数、dev 调试事件收集、$reset/$state setter 对 $patch 的复用、与 HMR/hydration 的暂停-恢复模式对比。
  - 演示载体建议：本仓库主语言 TS + Vue，建议写成能 `bun run`/`node` 直接跑的脚本（依赖 vue 包，能跑最好、非硬要求）；演示只需要 `reactive + watch + nextTick` 三个原语，几十行就能演透「暂停 + 手动触发 + 异步延迟恢复」这一条权衡链。

  ```ts
  import { reactive, watch, nextTick } from 'vue'

  const state = reactive({ a: 0, b: 0, c: 0 })
  let listening = true            // 异步监听开关
  let syncListening = true        // 同步监听开关
  const subs = new Set<(m: string) => void>()
  subs.add(m => console.log('订阅收到：', m))

  watch(state, () => {
    if (listening) subs.forEach(cb => cb('async watch 触发'))
  }, { deep: true })

  function patch(mutator: (s: typeof state) => void) {
    listening = syncListening = false      // 关掉两个监听
    mutator(state)                         // 函数路径：用户自由改
    syncListening = true                   // 同步立即恢复
    subs.forEach(cb => cb('patch 一次'))   // 手动触发一次
    const myId = Symbol()                  // token
    nextTick().then(() => { listening = true })
  }

  patch(s => { s.a = 1; s.b = 2; s.c = 3 })
  // 输出只有一行："订阅收到：patch 一次"
  // watch 因 listening=false 静默，三次赋值被合并成一次通知
  ```

- **正文不宜展开的细节**：
  - 数组、Date、Map/Set 实例不属于「普通对象」（判定走 `Object.prototype.toString`），在对象路径里走整体替换。
  - 对象路径合并时对 key 做原型链检查，避免给原型属性赋值。
  - dev 模式下收集每次 mutation 的调试事件，整组随 patch 一次性发给 devtools 时间线（与 prod 不构成可观测差异）。
  - 嵌套 patch（用户 mutator 里又调 $patch）用 token 区分谁能恢复异步监听。
  - HMR 热更新、SSR hydration 也借了「暂停/恢复监听」的模式，但二者不收集事件、也不带 token——边界可作配套阅读而非主线。

- **推荐的一个执行轨迹例子**：
  - 输入：`store.$patch({ profile: { name: 'A' }, tags: new Set(['x']) })`；原 state 是 `{ profile: { name: 'B', age: 20 }, tags: new Set() }`。
  - 关键中间态：两个监听开关都关掉；合并函数按 key 走——`profile` 子树是普通对象→递归（只改 name，age 保留）；`tags` 是 Set→调 `add('x')`。
  - 输出：state 变为 `{ profile: { name: 'A', age: 20 }, tags: Set(['x']) }`；订阅只触发一次，type 标为对象式 patch；同步监听立即恢复，异步监听在下一个 microtask 恢复。

> 以上钩子供 Writer 写「动机→核心思想→心智模型→关键权衡→原理演示」；下面事实部分供核对，不要被 Writer 当目录照抄。

## 概念要点

- **$patch 入口两条分支**：函数式 mutator 直接调用并把当前 store state 喂给它；对象式 partial 走 mergeReactiveObjects 递归合并；两条分支生成带 MutationType 区分的 subscriptionMutation 描述符。源码位置: packages/pinia/src/store.ts:285-328
- **暂停 watcher 的具体手法**：进入 patch 立刻把两个监听开关都置 false，调完手动 triggerSubscriptions，再立刻恢复同步监听；异步监听用 `nextTick().then(() => { if (activeListener === myListenerId) isListening = true })` 延迟恢复。源码位置: packages/pinia/src/store.ts:293-321
- **同步监听在 triggerSubscriptions 之前恢复**：`isSyncListening = true`（line 321）排在 `triggerSubscriptions`（line 323）之前，所以订阅回调里若用户再改 state，sync watcher 会立刻响应；async watcher 因 isListening 仍是 false 不响应——这是「丢一次事件」的直接根源。源码位置: packages/pinia/src/store.ts:321-327
- **嵌套 patch 用 Symbol token 区分恢复权**：每次进入 patch 生成新 Symbol，写到模块级 activeListener；只有「最后一次」patch 的 nextTick 回调 token 匹配才能把 isListening 打开，外层 patch 的恢复回调被静默丢弃。源码位置: packages/pinia/src/store.ts:315-320
- **mergeReactiveObjects 是 partial 路径的核心**：Map 走 set 整体写、Set 走 add 批量加、其它按 key 遍历——plain object 递归、非 plain（含 ref/reactive 子节点）直接赋值覆盖。源码位置: packages/pinia/src/store.ts:79-113
- **isPlainObject 的判定**：`Object.prototype.toString.call(o) === '[object Object]'` 且无 toJSON——所以数组、Map/Set 实例、Date、带 toJSON 的对象 都不算 plain，一律走「直接赋值」分支。源码位置: packages/pinia/src/types.ts:16-29
- **mergeReactiveObjects 跳过 ref/reactive 子节点**：合并条件里有 `!isRef(subPatch) && !isReactive(subPatch)` 的额外判断，使 partial 里塞 ref/reactive 时走「整值替换」而非「解包合并」，避免破坏用户在 setup store 里手动包好的响应式容器。源码位置: packages/pinia/src/store.ts:95-101
- **Map 是「按 key 覆盖值」而非递归 merge**：`patchToApply.forEach((value, key) => target.set(key, value))`——只覆盖、不递归；Set 同理只能 add 不能 delete。源码位置: packages/pinia/src/store.ts:83-88
- **for-in 遍历 patchToApply 天然忽略 Symbol key**：注释明示「symbols cannot be serialized anyway」，所以 patch 里的 Symbol 字段不会被合并。源码位置: packages/pinia/src/store.ts:90-91
- **$reset 复用 $patch**：option store 的 $reset 重新求值 state()，再用 `$patch(($state) => assign($state, newState))` 把多次赋值归并进一次订阅通知；setup store 没有声明式 state，dev 下直接抛错。源码位置: packages/pinia/src/store.ts:330-347
- **$state setter 也复用 $patch**：直接赋值 `store.$state = newState` 不会绕开 patch 路径，仍走 `$patch(($state) => assign($state, state))`，保证订阅只触发一次。源码位置: packages/pinia/src/store.ts:583-595
- **dev 模式 events 收集协作**：$patch 入口先 `debuggerEvents = []` 重置；watcher 的 onTrigger 在 isListening=true 时把最新 event 整体赋给 debuggerEvents、在 isListening=false 时 push 到数组——这样 patch 窗口内多次 mutation 会被收集成数组，连同 mutation 描述符一起发给 devtools 时间线。源码位置: packages/pinia/src/store.ts:243-263, 296-298
- **hydration 也用 mergeReactiveObjects，但额外处理 Set/Map**：hydration 路径在合并前先 `prop.clear()` 清掉 ref 默认值（避免默认元素与 hydration 数据混入）；这是与 $patch 路径的关键语义差异。源码位置: packages/pinia/src/store.ts:516-529
- **hmr.ts 的 patchObject 是相关但独立的函数**：用于 HMR 重建 store 时把旧 state 的 plain object 子节点递归 merge 到新 state，结构与 mergeReactiveObjects 几乎一致但不处理 Map/Set——因为 HMR 走另一条路径处理 keyed collection。源码位置: packages/pinia/src/hmr.ts:33-62

## 关键调用链

```
$patch(stateMutator | partialState)
  → isListening = isSyncListening = false            // 暂停观测
  → 分支 1: stateMutator(pinia.state.value[$id])      // 函数式：用户自由改
  → 分支 2: mergeReactiveObjects(pinia.state.value[$id], partialState)
            ├ Map/Set: forEach + set/add
            └ for key in patchToApply: plain/plain → 递归；否则赋值
  → 构造 subscriptionMutation (patchFunction | patchObject)
  → isSyncListening = true                            // 同步立即恢复
  → triggerSubscriptions(subscriptions, mutation, state)  // 手动发一次
  → nextTick().then(=> if token 匹配) isListening = true  // 异步延迟恢复

依赖上一章（subscriptions）的 triggerSubscriptions：直接 forEach 调用每个回调
```

主入口源码位置: packages/pinia/src/store.ts:285-328；订阅触发原语源码位置: packages/pinia/src/subscriptions.ts:26-33。

## 源码摘录（带行号，全文累计 ≤ 30 行）

$patch 主体（去掉注释/类型断言，演核心思想 = 暂停 + 手动触发）：

```ts
// packages/pinia/src/store.ts:293-327 (摘关键行)
isListening = isSyncListening = false
if (typeof partialStateOrMutator === 'function') {
  partialStateOrMutator(pinia.state.value[$id])               // 函数路径：直接改
  subscriptionMutation = { type: MutationType.patchFunction, storeId: $id, events: debuggerEvents }
} else {
  mergeReactiveObjects(pinia.state.value[$id], partialStateOrMutator)  // 对象路径：递归合并
  subscriptionMutation = { type: MutationType.patchObject, payload: partialStateOrMutator, storeId: $id, events: debuggerEvents }
}
const myListenerId = (activeListener = Symbol())
nextTick().then(() => { if (activeListener === myListenerId) isListening = true })
isSyncListening = true
triggerSubscriptions(subscriptions, subscriptionMutation, pinia.state.value[$id])
```

mergeReactiveObjects 的 for-loop 本体（去掉 NOTE 注释，演「按类型分流」）：

```ts
// packages/pinia/src/store.ts:91-109 (摘关键行)
for (const key in patchToApply) {
  if (!Object.hasOwn(patchToApply, key)) continue
  const subPatch = patchToApply[key]
  const targetValue = target[key]
  if (isPlainObject(targetValue) && isPlainObject(subPatch)
      && Object.hasOwn(target, key) && !isRef(subPatch) && !isReactive(subPatch)) {
    target[key] = mergeReactiveObjects(targetValue, subPatch)  // 都是普通对象 → 递归
  } else {
    target[key] = subPatch                                      // 其他 → 整值替换
  }
}
```

## 易混淆 / 边界 / 推断

- **事实**：Map 分支是「按 key 覆盖值」而不是递归合并；Set 分支只能 add 不能 delete。源码位置: packages/pinia/src/store.ts:83-88
- **事实**：isPlainObject 排除带 toJSON 的对象，所以 Date（有 toJSON）会被当作「非 plain」整体替换。源码位置: packages/pinia/src/types.ts:16-29
- **事实**：mergeReactiveObjects 用 for-in 遍历 patchToApply，Symbol key 被天然忽略；代码注释明示「symbols cannot be serialized anyway」。源码位置: packages/pinia/src/store.ts:90
- **事实**：isSyncListening 在 triggerSubscriptions 之前恢复，所以订阅回调里改 state 时 sync watcher 会立刻响应；但 async watcher 因 isListening 仍 false 不会响应，直到 nextTick。源码位置: packages/pinia/src/store.ts:321-327
- **推断**：activeListener token 机制主要防「patch 内嵌套调 patch」（mutator 里又调 $patch，或 $reset 内调 $patch 但 $reset 自身只调一次所以风险有限）；外层 patch 的 nextTick 回调会被内层 token 覆盖丢弃。
- **推断**：dev 模式 `if (isListening) debuggerEvents = event`（line 248-249）在 isListening=true 时直接整体赋值——这是为了「正常 direct mutation」场景记录最新一次 event；patch 路径靠入口处重置数组 + onTrigger 在 isListening=false 时 push 来协作收集整组事件。两套语义的边界值得结合 devtools 时间线测试用例确认。
- **事实**：mergeReactiveObjects 也被 setup store hydration 复用，但 hydration 在调用前先 `prop.clear()` 清理 ref 默认值——这是 $patch 路径没有的语义差异，部分原因是为了让 $patch 的合并行为更可预测（不被默认值污染）。源码位置: packages/pinia/src/store.ts:516-529
- **事实**：hmr.ts 的 patchObject（lines 33-62）与 mergeReactiveObjects 结构高度相似但不处理 Map/Set——因为 HMR 走另一条 keyed collection 处理路径；两个函数的存在反映了「合并语义在不同上下文有不同需求」。源码位置: packages/pinia/src/hmr.ts:33-62
- **未理解**：mergeReactiveObjects 注释（lines 102-104）提到「想警告类型不一致但 setup store 里 Map 可能被 SSR 改成 undefined」——这个 hydration 兼容场景的具体触发条件与影响范围未在源码内进一步验证，建议 Writer 不在正文展开，仅在 hydration 章节配套说明。
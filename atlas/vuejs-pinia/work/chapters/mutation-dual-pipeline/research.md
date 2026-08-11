# 状态变更的双管道：动作拦截与批量合并 · 源码精读

## 给 Writer 的教学钩子（必填，8 子项缺一不可）

- **用户痛点 / 场景**：同一个状态库会被两种截然不同的方式修改——一是「直接改」（在动作里逐行写状态、或外部直接赋值），二是「成批改」（一次性塞一片对象进来）。如果这两种写法都裸交给响应式系统，一次「成批改」里动了十个字段就会触发十次订阅，监听者既被反复打扰、又会看到中间抖动态；与此同时，动作还常常需要被观测「开始/成功/失败」的生命周期，而光盯状态变化是盯不出来的。使用者真正想要的是：直接改照常通知，成批改合并成一次通知，动作还能被前后插桩。

- **一句话核心思想**：改状态有两条互不干扰的路——一条在「改」的前后插桩观测（但不碰合并），一条干脆关掉自动监听、自己把一堆改动揉成一次通知。

- **设计动机（为什么需要它）**：状态库同时承担「细粒度直接写」与「粗粒度成批写」，二者通知粒度的诉求相反。于是把「直接写」留给既有的深度监听器（标成「直接」类型），而给「成批写」单独修一条路：先暂停自动监听、自己合并、再手动只喊一声；又因为动作的生命周期（前/后/出错）无法从状态变化反推，再给动作单配一个订阅池，由包裹层在执行前后插桩。
  - 承前 ①：动作之所以「能被包裹插桩」，是因为第 5 章『Setup Store 的运行时自动分流』已经把函数属性识别为动作并交给包裹器（识别与分类过程已在第 5 章讲透，本章只看包裹器在前后做了什么）。
  - 承前 ②：两条管道的订阅注册与触发，都站在第 1 章『随作用域清理的发布订阅』搭的「集合 + 遍历触发 + 作用域自动回收」原语上（已在第 1 章讲透，本章只把它当通知底座用，不重讲自动清理与 detached）。

- **关键权衡（本 Atlas 的核心，4 条）**：
  1. 「补丁管道关掉自动监听、改为合并完成后手动发一次通知」→ 换来「成批修改只产生一次订阅、监听者看不到中间态、性能更好」→ 代价「必须自己管控监听开关的关/开时机，还得用一个微任务延迟 + 唯一令牌比较，保证同一回合内连续多次补丁只恢复一次监听，时序协议隐晦易错」。
  2. 「合并时只对『双方都是普通对象』才递归深合并，遇到响应式引用或响应式代理一律整体替换」→ 换来「响应式代理身份不被拆散重组、合并行为可预测」→ 代价「想用补丁部分更新某个响应式子对象时，会变成整体替换，调用者必须把那份子对象整份传入」。
  3. 「动作包裹层把『后置/出错』做成注册器，塞进前置事件对象里交由监听器自己去挂回调，而不是包裹层直接回调监听器」→ 换来「监听器用同一套写法即可观测同步动作与异步动作（含 Promise），还能拿到返回值或错误」→ 代价「API 形态是『在回调里再注册回调』，初见反直觉，存在学习成本」。
  4. 「用两个监听开关分别管辖同步档与异步档（预/后置）的监听器」→ 换来「补丁期间能精确只屏蔽会被本次合并触发的那批回调，且同步档与异步档各自挑最合适的恢复点（同步档立即恢复、异步档等一个微任务）」→ 代价「双开关的赋值时序成为隐性约定，读代码者必须理解档位与两个开关的对应关系」。

- **最小心智模型（6 步）**：
  1. 所有状态写都汇向同一棵集中状态树；树上挂着一个深度监听器，负责把「直接写」翻译成一次状态订阅（类型标为「直接」）。
  2. 走「动作管道」时：包裹层先把「前置事件」塞给动作订阅池 → 执行真正的动作函数（其中的直接写交由步骤 1 的监听器以「直接」类型发出）→ 函数返回或异步落定后，包裹层再发「后置」或「出错」事件。
  3. 走「补丁管道」时：先关掉步骤 1 的监听开关，让接下来的一连串写全部「静默」。
  4. 静默期间完成合并：函数式补丁直接对状态树跑函数；对象式补丁做深合并（普通对象递归、集合类用各自语义、响应式引用/代理整体替换）。
  5. 合并完毕，手动往状态订阅池塞一个事件（标为「对象补丁」或「函数补丁」）——这就是这一整批修改的唯一一次通知。
  6. 用一个唯一令牌预约「下一个微任务回合才恢复异步监听」，保证同一回合内连续多次补丁只恢复一次；同步监听则合并完立即恢复。

- **最小原理演示（替代旧「复刻范围」）**：
  - 应演示：一个几十行的迷你状态库，对照演两条管道。包含：(a) 动作包裹器——前置事件 + 后置/出错注册器，且对 Promise 返回值挂 then/catch；(b) 补丁管道——关监听开关 → 调一次最小深合并（普通对象递归 + 响应式引用整体替换）→ 手动发一次状态订阅 → 微任务里恢复监听；(c) 一个「唯一令牌」变量，演同回合连续两次补丁时只有最后一次触发恢复；(d) 一个计数器直观对照：「连续三次直接改」触发若干次状态订阅 vs 「一次对象补丁含三个字段」只触发一次。
  - 应故意省略：HMR、devtools 调试事件收集、SSR hydrate、插件扩展、Map/Set 完整语义（演普通对象 + 响应式引用两路即足以说透合并权衡）、监听档位 pre/post/sync 的完整矩阵（只点出「同步立即恢复、异步等微任务」即可）、整库重置、作用域、Pinia 容器本身。
  - 演示载体建议：**首选 TS/JS**。本章核心是「响应式深度监听的暂停/恢复 + 对象深合并 + 回调注册器 + 令牌去重」，全是纯 JS 运行时语义，借一个最小响应式运行时（深度监听 + 微任务调度）即可忠实演透，配最小 `package.json` 用 `tsx`/`bun` 直跑。无需退回原仓库主语言（TS/JS 讲得透）。
  - 每一行都要对应原理点：包裹器的前置/后置/出错 = 权衡 3；关监听 + 手动触发 + 微任务恢复 = 权衡 1；令牌比较 = 权衡 1 的「同回合去重」；深合并的「递归 vs 整体替换」= 权衡 2。

- **正文不宜展开的细节**：三档 flush 与两个监听开关的完整组合矩阵（点出同步 vs 异步的恢复差异即可，不要全列）；devtools 的调试事件收集（仅 DEV，留给第 11 章承接）；HMR 热更新里也复用「关监听 → 微任务恢复」同款手法（留给第 10 章承接）；状态订阅对同一回调去重防重复订阅；合并时有意忽略 Symbol 键（注释明说不可序列化）；整库重置内部走补丁这条事实可作「批量合并」的一个用例一笔带过。

- **推荐的一个执行轨迹例子**：
  - 初始状态 `{ user: { name: 'a', age: 1 }, tags: Set(['x']) }`。
  - 走动作管道：调用动作 `setBoth()`（内部把 name 改 'b'、age 改 2）→ 包裹层先发前置事件 → 动作执行 → 发后置事件（携带返回值）；同时这次写入被深度监听器捕获，以「直接」类型发一次状态订阅。
  - 走补丁管道：调用对象补丁 `{ user: { age: 3 } }` → 关掉自动监听 → 深合并：age 1→3、name 'b' 保留（普通对象递归）、tags 不在本次范围 → 手动发一次状态订阅（类型=对象补丁）→ 下一个微任务回合才恢复自动监听。
  - 结果：两次操作各自只产生一次状态通知，监听者看不到逐字段抖动；若在补丁后又紧接一次补丁，恢复只发生在最后一次之后的那个微任务回合。

> 以上钩子供 Writer 写「动机 → 核心思想 → 心智模型 → 关键权衡 → 原理演示」；下面事实部分供核对，不要被 Writer 当目录照抄。

## 概念要点

- 两条管道共享同一个「状态订阅池」（一个 Set）；另有独立的「动作订阅池」（另一个 Set）。前者接收「状态变化」通知，后者只接收「动作生命周期」通知。源码位置: packages/pinia/src/store.ts:268-269
- 状态监听有两个开关：`isListening`（管控 pre/post 异步档）、`isSyncListening`（管控 sync 同步档）。深度监听器回调里按订阅的 flush 档位选用对应开关来决定是否真正调用回调。源码位置: packages/pinia/src/store.ts:266-267、458
- 动作包裹器生命周期：先发前置事件（含 args/name/store/after/onError）；再 `fn.apply` 执行原函数；同步 try/catch 命中 catch 则发出错；返回值为 Promise 则 `then` 发后置、`catch` 发出错；否则同步发后置。源码位置: packages/pinia/src/store.ts:381-413
- `after`/`onError` 是「注册器」：每次动作调用各自新建两个 Set，把 after/onError 闭包加进对应 Set；监听器在前置事件里调用它们来登记回调，等动作完成后包裹层再统一触发这两个 Set。源码位置: packages/pinia/src/store.ts:372-388
- 补丁管道步骤：两开关置 false → 函数式跑函数 / 对象式深合并 → 构造变更描述 → `nextTick` + 令牌比较恢复 `isListening` → 立即 `isSyncListening=true` → 手动触发一次状态订阅。源码位置: packages/pinia/src/store.ts:292-327
- 深合并规则：Map 用 `set`、Set 用 `add`（`forEach(target.add, target)`）；`for...in` 遍历补丁键，当目标值与补丁值都是普通对象且补丁值既非 ref 又非 reactive 时递归合并，否则（含 ref/reactive/类型不一）整体赋值。源码位置: packages/pinia/src/store.ts:83-108
- 整库重置内部走补丁：`$reset` 用 `$patch(($state) => assign($state, newState))`，注释明说「用 patch 把所有改动归并成一次订阅」。这是「批量合并换性能」的一个直接用例。源码位置: packages/pinia/src/store.ts:330-339
- 动作订阅直接复用第 1 章原语：`$onAction: addSubscription.bind(null, actionSubscriptions)`；状态订阅也复用同一原语并透传 `detached`，并对同一回调去重（命中则返回空函数，引用 issue #3143）。源码位置: packages/pinia/src/store.ts:435、441-453
- 变更类型三值：`direct`（直接/动作内写）、`patchObject`（对象补丁）、`patchFunction`（函数补丁）。状态订阅事件据此携带不同 payload（对象补丁带 payload，其余不带）。源码位置: packages/pinia/src/types.ts:43-133
- `activeListener`（Symbol）+ `nextTick` 去重：每次补丁把 `activeListener` 设为新 Symbol，微任务里只有「当前 activeListener 仍等于自己」的那次才恢复 `isListening`，故同回合多次补丁只恢复一次。注释引用 issue #1129「avoid triggering too many listeners」。源码位置: packages/pinia/src/store.ts:283-320

## 关键调用链

- 动作管道：`wrappedAction()` → `triggerSubscriptions(actionSubscriptions, 前置事件)` → `fn.apply(store, args)`（其内的直接写被深度监听捕获 → 监听回调因 `isListening` 为 true → 以 `direct` 类型发状态订阅）→ `triggerSubscriptions(afterCallbackSet | onErrorCallbackSet)`。源码位置: packages/pinia/src/store.ts:368-413、454-471
- 补丁管道：`$patch()` → `isListening=isSyncListening=false` →（函数式: `mutator(state)` | 对象式: `mergeReactiveObjects(state, patch)`）→ `nextTick` 恢复 `isListening`（令牌比较）→ `isSyncListening=true` → `triggerSubscriptions(subscriptions, mutation, state)`。源码位置: packages/pinia/src/store.ts:292-327
- 深合并：`mergeReactiveObjects(target, patch)` → 命中 Map/Set 各自 set/add → `for key in patch` → 双方普通对象? 递归 : 整体赋值。源码位置: packages/pinia/src/store.ts:79-113
- 发布订阅底座（承自第 1 章）：`addSubscription`（加回调 + 按 detached 决定是否随作用域回收 + 返回移除函数）、`triggerSubscriptions`（遍历 Set 逐个调用）。源码位置: packages/pinia/src/subscriptions.ts:6-33

## 源码摘录（带行号，全文累计 ≤ 30 行）

深合并 —— 演权衡 2「普通对象递归 vs ref/reactive 整体替换」与 Map/Set 特殊语义（精简自 store.ts:83-109）：

```ts
if (target instanceof Map && patchToApply instanceof Map) patchToApply.forEach((v, k) => target.set(k, v))
else if (target instanceof Set && patchToApply instanceof Set) patchToApply.forEach(target.add, target)
for (const key in patchToApply) {
  if (!Object.hasOwn(patchToApply, key)) continue
  const subPatch = patchToApply[key], targetValue = target[key]
  if (isPlainObject(targetValue) && isPlainObject(subPatch) && !isRef(subPatch) && !isReactive(subPatch))
    target[key] = mergeReactiveObjects(targetValue, subPatch) // 普通对象：递归
  else target[key] = subPatch                                  // ref/reactive：整体替换
}
```

补丁管道 —— 演权衡 1「关监听 + 合并 + 手动发一次 + 微任务令牌恢复」（精简自 store.ts:292-327）：

```ts
isListening = isSyncListening = false                                          // 关掉watcher
if (typeof partialStateOrMutator === 'function') {
  partialStateOrMutator(pinia.state.value[$id])
  subscriptionMutation = { type: MutationType.patchFunction, storeId: $id, events: debuggerEvents }
} else {
  mergeReactiveObjects(pinia.state.value[$id], partialStateOrMutator)
  subscriptionMutation = { type: MutationType.patchObject, payload: partialStateOrMutator, storeId: $id, events: debuggerEvents }
}
const myListenerId = (activeListener = Symbol())
nextTick().then(() => { if (activeListener === myListenerId) isListening = true }) // 仅本回合最后一次补丁恢复
isSyncListening = true
triggerSubscriptions(subscriptions, subscriptionMutation, pinia.state.value[$id])  // 手动发一次
```

动作包裹器 —— 演权衡 3「前置事件 + after/onError 注册器 + 同步/异步双路径」（精简自 store.ts:381-413）：

```ts
triggerSubscriptions(actionSubscriptions, { args, name, store, after, onError })  // 前置
try { ret = fn.apply(this && this.$id === $id ? this : store, args) }
catch (error) { triggerSubscriptions(onErrorCallbackSet, error); throw error }     // 同步出错
if (ret instanceof Promise) return ret
  .then(v => { triggerSubscriptions(afterCallbackSet, v); return v })              // 异步成功
  .catch(e => { triggerSubscriptions(onErrorCallbackSet, e); return Promise.reject(e) })
triggerSubscriptions(afterCallbackSet, ret)                                        // 同步成功
```

## 易混淆 / 边界 / 推断

- 事实：动作内的直接状态写**不会**被动作包裹器「合并」，它们仍由深度监听器逐次捕获（同 tick 多次写的批处理是 Vue 响应式自身的能力，不是 Pinia 做的）。所以「动作」与「补丁」的合并粒度来源不同：补丁是 Pinia 主动保证一次通知；动作依赖 Vue 监听器的批处理。源码位置: packages/pinia/src/store.ts:454-471
- 事实：补丁的函数式与对象式都「关监听」，但函数式只直接对 state 跑函数（不做合并），对象式才走 `mergeReactiveObjects`；两者都手动发一次状态订阅，只是变更类型与是否带 payload 不同。源码位置: packages/pinia/src/store.ts:299-314
- 推断（标注为推断）：`isSyncListening` 在补丁末尾**立即**恢复为 true，而 `isListening` 要等 `nextTick`。原因推断：默认 flush=pre 的监听器是异步排队的，关 `isListening` 是为挡住「本次合并触发的那次排队回调」；sync 档监听器是同步触发，关 `isSyncListening` 是为挡住合并期间的逐次同步回调，合并一结束立即恢复 sync 无副作用（之后不会再有更多同步回调冒出来）。
- 推断：`activeListener` 用 Symbol 而非自增数字，推断主要是「无需计数器、用唯一引用比较即可表达『最后一次获胜』」，且每个 store 各持一个 `activeListener`、Symbol 天然避免跨 store 串号。
- 边界：`mergeReactiveObjects` 对 ref/reactive 子值整体替换而非深合并，故当 `obj` 是 reactive 时，`$patch({ obj: { nested: 1 } })` 会把整个 reactive 换成普通对象——这是有意为之以保持响应式身份可预测（源码注释 102-104 提到 setup store 里同一属性的类型可能在 SSR 期间变化，需要能整体覆写）。
- 未理解：状态订阅的监听回调里，「post」flush 也归到 `isListening`、只有「sync」单列 `isSyncListening`——为何 pre 与 post 合并而 sync 单列，源码注释未给出明确解释（推断：pre/post 都是异步队列、由 `isListening` 一并管控即可，只有 sync 是同步、需独立即时管控）。源码位置: packages/pinia/src/store.ts:458
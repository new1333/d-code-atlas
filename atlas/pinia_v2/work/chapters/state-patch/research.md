# $patch：状态变更与深度合并 · 源码精读

## 给 Writer 的教学钩子（必填，8 子项缺一不可）
- **用户痛点 / 场景**：一个 store 的状态会以很多种方式变动——直接给某字段赋值、往数组里 push、整体替换、或一次性塞进一批字段。订阅了「状态变化」的代码（比如持久化、日志、调试面板）需要可靠地知道「变了」，而且最好知道「这是一次有意的批量改动，还是零散的单点赋值」。若任由底层响应式系统逐属性地广播，订阅者会被一堆碎片化的中间状态反复唤醒，既分不清变更来源，也拿不到一致的「变更后快照」。
- **一句话核心思想**：**「停表 → 改动 → 手动播报 → 下一拍恢复」**——与其让底层监听器对每个被碰过的属性各喊一声，不如在改动期间短暂屏蔽它、自己改完、由自己统一喊一声。
- **设计动机（为什么需要它）**：状态变更既是数据问题（怎么改）也是通知问题（改完怎么告诉订阅者、告诉它什么）。把这两个问题解耦后，可以让「一次批量变更恰好等于一次订阅通知」，并顺带把「这次变更是对象补丁还是变更函数」这个语义塞进通知里，供调试面板与测试断言归因使用。
- **关键权衡（本 Atlas 的核心）**：
  1. 选择「在变更前后用一个开关位把底层深度监听短暂关闭」→ 换来「一次批量变更只产生一个订阅事件，而非每个属性一个」→ 代价是必须由变更入口自己手动触发一次订阅回调，并精确管理开关的关/开时机。
  2. 选择「同步监听开关与异步监听开关分别恢复（同步立即恢复、异步延后到下一拍恢复）」→ 换来「同步式监听与默认异步式监听各自在正确时机放行，既不漏播后续变更、也不误播本次的中间态」→ 代价是出现两个语义不同的开关位，时序更绕、更难一眼读懂。
  3. 选择「给每次变更登记一个唯一序号，只允许最新一次负责恢复异步监听」→ 换来「同一拍内连续多次批量变更不会被中间状态触发监听」→ 代价是多出一个跨调用的竞态序号状态。
  4. 选择「对象形态做递归深度合并（普通对象往下钻、集合类型按成员合并），但遇到响应式引用就整体替换」→ 换来「未触及的旧子树被保留、且响应式值的引用语义不被破坏」→ 代价是无法把补丁钻进一个响应式引用/响应式对象的内部，且需为映射表与集合各写一条特例分支。
- **最小心智模型（3～7 步）**：
  1. 进变更前，把「自动监听总闸」拉下（同时关掉异步和同步两条支线）。
  2. 选合并路径：给的是变更函数就直接改状态树；给的是补丁对象就递归合并进状态树。
  3. 立刻把同步支线的闸推回去（同步监听即时恢复）。
  4. 给本次变更盖一个序号章，约定「下一拍」才推回异步支线的闸，且只有序号最新的那次真正推回。
  5. 不等底层监听器，直接手动广播一次订阅事件，把「这是一次对象补丁还是变更函数」连同新状态一起告诉订阅者。
  6. 底层响应式在本拍结束时跑那些被调度的监听回调，但异步闸还拉着 → 回调空转。
  7. 下一拍：异步闸推回，外部后续的直接赋值/数组推送等变更恢复正常监听。
- **最小原理演示（替代旧「复刻范围」）**：
  - 应演示：一个极简 store（状态是一个普通对象），挂一个订阅回调。先演「停表-改动-手动播报-下一拍恢复」骨架，让一次补丁只触发回调一次（演透权衡 1/2/3）。再演合并的两条分支：补丁里的普通对象子树被递归合并、保留兄弟字段（演透权衡 4 的「保旧子树」）；而补丁里若放一个响应式引用值，则被整体替换、不钻进其内部（演透权衡 4 的「保引用语义」）。
  - 应故意省略：映射表/集合的成员合并分支、序号去重的完整多次补丁竞态、调试事件累积、同步/异步双刷新的所有边界、与调试面板/测试替身的集成脚手架。不追求工程完整，只追求演透「屏蔽-合并-播报-恢复」与「深合并 vs 整体替换」这两组原理。
- **正文不宜展开的细节**：调试事件（debugger events）在监听被屏蔽期间如何累积、再随补丁事件一并交给调试面板（归因细节，留调试面板章）；映射表按键合并、集合取并集的具体语义（正文一句话带过即可）；setup store 首次装配时复用同一合并函数把服务端初始状态灌进响应式值（属装配/SSR 章）；重置与直接给整体状态赋值都内部走变更函数形态、复用同一套「一次变更一个事件」机制（可一句话提及）。
- **推荐的一个执行轨迹例子**：输入——某 store 状态 `{ profile: { name: 'a', age: 1 }, list: ['x'] }`，已订阅回调；用户调用补丁 `{ profile: { age: 2 } }`。关键中间态——自动监听关闭 → 递归合并：`profile` 是普通对象故下钻，`age` 覆盖为 2，`name` 未出现在补丁中故保留；`list` 未被补丁触及、原样不动 → 手动广播一次「对象补丁」事件（载荷 `{ profile: { age: 2 } }`，附合并后的完整状态）→ 本拍监听回调空转。输出——订阅回调恰好被调用 1 次，拿到 `{ profile: { name: 'a', age: 2 }, list: ['x'] }` 与载荷；下一拍监听恢复正常。

> 以上钩子供 Writer 写「动机→核心思想→心智模型→关键权衡→原理演示」；下面事实部分供核对，不要被 Writer 当目录照抄。

## 概念要点
- **合并器三分支**：合并器先按「目标与补丁是否同为映射表/集合」各走一条成员级分支（映射表逐键 set、集合取并集 add），再对补丁里的每个字符串键逐一判定「递归还是整体替换」。源码位置: packages/pinia/src/store.ts:79-113
- **递归的门槛**：仅当目标值与补丁值**都是纯对象**（`[object Object]` 且无 `toJSON`）、目标自身拥有该键、且补丁值既非响应式引用也非响应式对象时才递归；否则整体赋值。这意味着数组、Date、带 `toJSON` 的对象一律整体替换，不钻元素。源码位置: packages/pinia/src/store.ts:95-109、packages/pinia/src/types.ts:19-29
- **映射表/集合的合并语义**：映射表用 `set(key, value)` 逐键覆盖（补丁未提及的键保留）；集合用 `add` 取并集（只增不删）。源码位置: packages/pinia/src/store.ts:83-88
- **双形态入口**：变更函数形态直接 mutate 状态树、事件类型记为「变更函数」；对象形态走递归合并、事件类型记为「对象补丁」并额外携带原始载荷。源码位置: packages/pinia/src/store.ts:285-314
- **屏蔽-播报-恢复**：进入时同时拉低两个监听开关，应用变更后立刻恢复同步开关、把异步开关的恢复推迟到下一拍，并手动触发一次订阅广播（注释明言「因为我们暂停了 watcher，必须手动调用订阅」）。源码位置: packages/pinia/src/store.ts:292-327
- **序号防中间态触发**：用模块外可见的「当前监听者」指针持有一个唯一符号，仅当本次序号仍是指针最新值时才在下一拍恢复异步监听，连续多次补丁时只认最后一次（对应 issue #1129「避免触发过多监听」）。源码位置: packages/pinia/src/store.ts:282-284、315-320
- **开关作为订阅回调的闸门**：`$subscribe` 注册的深度监听在回调里用 `flush==='sync' ? 同步开关 : 异步开关` 决定是否真正调用用户回调——这正是「屏蔽」生效的落点。源码位置: packages/pinia/src/store.ts:454-471
- **变更类型三态**：直接赋值/数组推送记为 `direct`，对象补丁记为 `patch object`，变更函数记为 `patch function`；其中两种补丁形态的回调上下文带原始载荷与事件数组，供归因。源码位置: packages/pinia/src/types.ts:43-68、107-134
- **同一机制的复用**：重置（`$reset`）与给 `$state` 整体赋值的 setter，都内部走变更函数形态，从而复用「一次变更=一个订阅事件」的语义。源码位置: packages/pinia/src/store.ts:330-339、583-595
- **装配期也复用合并器**：setup store 首次装配、需把服务端初始状态灌进用户创建的响应式值时，对响应式对象同样调用该合并器（并先清空映射表/集合以免并入默认值）。源码位置: packages/pinia/src/store.ts:516-529

## 关键调用链
- 对象形态：`$patch(偏对象)` → `mergeReactiveObjects(state, 偏对象)` → 按键判定（纯对象→递归 / 映射表→逐键 set / 集合→并集 add / 其它→整体替换）。源码位置: packages/pinia/src/store.ts:307、79-113
- 函数形态：`$patch(mutator)` → `mutator(state)` 直接 mutate 状态树。源码位置: packages/pinia/src/store.ts:300
- 通知：`$patch` → `triggerSubscriptions(subscriptions, mutation, state)` → 遍历 `subscriptions` 集合逐个调用 `$subscribe` 回调。源码位置: packages/pinia/src/store.ts:323-327、packages/pinia/src/subscriptions.ts:26-33
- 监听侧：`$subscribe` → `watch(() => state, cb, {deep})`，`cb` 内以双开关为闸门决定是否真正触发。源码位置: packages/pinia/src/store.ts:454-471

## 源码摘录（带行号，全文累计 ≤ 30 行）
```ts
// store.ts:292-327 节选（294-298 重置调试事件、301-313 构造 mutation 字面量已省，仅示骨架）
292	  let subscriptionMutation: SubscriptionCallbackMutation<S>
293	  isListening = isSyncListening = false // ① 暂停自动监听
299	  if (typeof partialStateOrMutator === 'function') {
300	    partialStateOrMutator(pinia.state.value[$id] as UnwrapRef<S>) // 函数形态：直接改状态树
306	  } else {
307	    mergeReactiveObjects(pinia.state.value[$id], partialStateOrMutator) // 对象形态：递归深合并
314	  }
315	  const myListenerId = (activeListener = Symbol()) // ② 登记本次序号
316	  nextTick().then(() => {
317	    if (activeListener === myListenerId) { // ③ 仅最后一次 patch 在下一拍恢复异步监听
318	      isListening = true
319	    }
320	  })
321	  isSyncListening = true // ④ 同步监听立即恢复
323	  triggerSubscriptions( // ⑤ watcher 被暂停，故手动播报一次
324	    subscriptions,
325	    subscriptionMutation,
326	    pinia.state.value[$id] as UnwrapRef<S>
327	  )
```
```ts
// store.ts:95-109 判定分支（映射表 set / 集合 add 在 83-88，见要点）
95	    if (
96	      isPlainObject(targetValue) &&
97	      isPlainObject(subPatch) &&
98	      Object.hasOwn(target, key) &&
99	      !isRef(subPatch) &&
100	      !isReactive(subPatch)
101	    ) {
105	      target[key] = mergeReactiveObjects(targetValue, subPatch) // 纯对象：递归深合并
106	    } else {
108	      target[key] = subPatch // 其它（含响应式引用 / 响应式对象 / 数组 / Date）：整体替换
109	    }
```
```ts
// store.ts:458 $subscribe 的 watch 回调以此双开关为闸门
458	            if (options.flush === 'sync' ? isSyncListening : isListening) {
```

## 易混淆 / 边界 / 推断
- **事实**：映射表是「按键合并」（覆盖同键值、保留补丁未提及的键），集合是「取并集」（只 add 不删）——两者都不是整体替换，但都只发生在「目标与补丁同为该集合类型」时；否则即便值是映射表/集合，也会落到整体替换。源码位置: packages/pinia/src/store.ts:83-88、91-109
- **事实**：对象补丁的回调上下文携带原始 `payload`，变更函数形态不带 `payload`——这是两者对调试/测试可观测性的关键差别。源码位置: packages/pinia/src/types.ts:107-134、packages/pinia/src/store.ts:301-313
- **事实**：`isPlainObject` 用 `Object.prototype.toString.call(o) === '[object Object]' && typeof o.toJSON !== 'function'` 判定，故数组（`[object Array]`）、Date（有 `toJSON`）等都不进递归分支，补丁里给数组就是整体替换。源码位置: packages/pinia/src/types.ts:19-29
- **事实**：HMR 的 `patchObject` 与本章合并器**同构但方向相反**——它把旧状态合并进新 shape，故遍历旧状态、对新树不存在的键跳过；而本章合并器遍历补丁、对目标不存在的键直接新增。源码位置: packages/pinia/src/hmr.ts:33-62、packages/pinia/src/store.ts:91-110
- **推断（标注为推断）**：变更函数被要求「必须同步」（见类型注释）。推断原因：变更期间监听被屏蔽、靠同一次手动广播收尾；若函数内异步 mutate，那次改动会逃出本次广播窗口、也发生在监听恢复之后，订阅者将拿不到一致的「变更后快照」。源码位置: packages/pinia/src/types.ts:326-329
- **推断（标注为推断）**：同步开关立即恢复、异步开关延后恢复的差异，根因是两种 watcher 的回调执行时机不同——默认（post）watcher 在本拍微任务 flush 时才跑（此时必须保持屏蔽以免误播本次补丁），而 sync watcher 在属性被 set 当场跑（补丁一结束就应放行以免漏掉后续同步变更）。源码位置: packages/pinia/src/store.ts:316-321、454-471
- **未理解**：调试事件（`debuggerEvents`）在 sync watcher 的 `onTrigger` 里于「监听屏蔽期」被累积、随后随补丁事件交给调试面板的完整时序（含 `store._hotUpdating` 分支）——这部分主要服务调试面板归因，留待 devtools 章节厘清。源码位置: packages/pinia/src/store.ts:246-262
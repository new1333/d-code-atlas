# 状态变更模型：$patch 双形态与暂停监听批处理 · 源码精读

## 给 Writer 的教学钩子（必填，8 子项缺一不可）

- **用户痛点 / 场景**：一个动作里连续改了好几个状态字段，或一次性合并一大块状态对象。若没有专门的"补丁"入口，每个字段变动都会触发一次深度监听通知，订阅者（持久化、devtools、日志）会被轰炸 N 次；而且深度监听是异步 flush 的，与订阅者期望的"一次性快照"对不齐。

- **一句话核心思想**：把一批状态改动收拢成一个补丁——补丁期间暂时关掉监听、改完手动统一触发一次订阅通知。

- **设计动机（为什么需要它）**：状态变更本身很廉价，但"每次变更都广播一次"很贵且语义混乱；这个机制要解决的就是"一批改动如何等价为一条订阅事件"。其中承前部分：单一根状态树（状态镜像）已在第 4 章『Store 装配』讲透，本章只看它的新侧面——"怎么改这棵树、改完怎么通知"；订阅派发原语已在第 2 章『订阅原语』讲透，本章只把它当作"手动通知"的执行件复用，不重演回调集合本身。紧邻下一章『订阅系统』会专门讲两个监听开关如何与深度监听协调，本章只用它"被暂停"这一面，不重演协调机制。

- **关键权衡（本 Atlas 的核心）**：
  1. **补丁期间关掉深度监听 → 换来"一批改动只产生一条订阅事件"（原子批处理）→ 代价是**正常监听通知被吞掉，必须手动派发一次订阅来补偿，否则订阅者会漏掉这次补丁。
  2. **提供函数式与对象式两条入口 → 换来既能命令式批量改（把状态直接交给用户回调）、又能声明式递归合并补丁 → 代价是**对象式必须专门处理 Map/Set 与"跳过响应式包装值"，合并逻辑因此复杂、边界多。
  3. **同步监听开关立即恢复、异步监听开关延迟到下一个微任务恢复 → 换来既能吞掉本 tick 排队的异步监听任务（避免与手动派发重复通知），又不影响后续同步监听 → 代价是**两个开关恢复时机不对称、理解成本高；并用一个唯一标记保证"连续多次补丁只有最后一次的恢复生效"，中途不提前重开监听。
  4. **重置与整体赋值都内部转调补丁入口 → 换来所有写路径共享同一套"暂停→批处理→单次通知"语义，无需为重置/替换另写通知逻辑 → 代价是**整体赋值 `$state = newObj` 实际是"把新对象浅合并进现有状态"，不会删除新对象里不存在的旧键，语义上不是真正的替换。

- **最小心智模型（3～7 步）**：
  1. 进入补丁：先把两个监听开关（同步、异步）都置为关——深度监听即使被状态改动触发，回调也被门控跳过。
  2. 施加改动：函数式则把根状态对象直接交给用户回调去命令式改写；对象式则对根状态做递归深合并（Map/Set 特判、遇响应式包装值则整值覆盖）。
  3. 打包事件：按入口形态生成一条订阅事件（函数式 / 对象式），开发期收集的调试事件一并附上。
  4. 恢复监听：同步开关立即恢复；异步开关排进下一个微任务恢复，并用唯一标记保证连续补丁里只有最后一次恢复生效。
  5. 手动派发：直接遍历订阅者集合，把这一条事件 + 最新状态一次性派发——被吞掉的那批监听通知由这一次手动派发替代。
  6. 收尾：异步开关在微任务里恢复，下一次直接改状态又能被深度监听正常捕获。

- **最小原理演示（替代旧"复刻范围"）**：
  - 应演示：一个极简响应式状态 + 一个订阅者集合 + 一个"暂停监听→改→手动触发一次→恢复"的补丁函数；含函数式与对象式（深合并）两种入口。每一行都要对应上面某条权衡：暂停对应权衡 1、双形态对应权衡 2、恢复时机对应权衡 3。
  - 应故意省略：Map/Set 合并、调试事件收集、连续补丁的去重标记、真实 Vue 调度器集成、重置/整体赋值的路由——只演"暂停→批→单次派发→恢复"骨架。
  - 演示载体建议：本章机制纯 TS/JS、无宿主依赖，最适合写成能 `bun run`/`node` 直接跑的脚本（用 Vue 的 reactive/watch，或手写极简响应式均可）。能跑最好但非硬要求，载体服务于"演透一批改动如何被收拢成一次通知"。

- **正文不宜展开的细节**：调试事件（onTrigger）收集机制；订阅监听的完整 watcher 设置与 detached 选项（属下一章）；Map/Set 之外的特殊集合；HMR 期间热状态旁路；isPlainObject 的 toJSON 判定细节；深层 Partial 类型推导。

- **推荐的一个执行轨迹例子**：输入 `store.$patch(s => { s.count++; s.list.push(1) })`（一次补丁内两处改动）→ 中间态：监听开关置关 → count 0→1、list 追加 1（监听被门控、无中途通知）→ 生成一条函数式补丁事件 → 手动派发一次 → 输出：订阅者恰好收到 1 条通知，状态为 `{count:1, list:[1]}`；微任务后监听恢复。

> 以上钩子供 Writer 写「动机→核心思想→心智模型→关键权衡→原理演示」；下面事实部分供核对，不要被 Writer 当目录照抄。

## 概念要点

- 补丁入口有两个重载（函数式 mutator / 对象式 partial），实现合并为一个函数按参数类型分叉。源码位置: packages/pinia/src/store.ts:285-291
- 进入补丁第一件事是把两个监听开关同时置 false（暂停深度 watcher）。源码位置: packages/pinia/src/store.ts:293
- 函数式形态：直接把根状态对象 `pinia.state.value[$id]` 交给用户回调命令式改写，框架不解读改了什么。源码位置: packages/pinia/src/store.ts:299-300
- 对象式形态：调用 `mergeReactiveObjects` 对根状态做递归深合并。源码位置: packages/pinia/src/store.ts:307
- 事件类型按入口形态区分：函数式 = `MutationType.patchFunction`，对象式 = `MutationType.patchObject`（且带 `payload` 字段保存原补丁对象）；`events` 字段附上开发期收集的调试事件。源码位置: packages/pinia/src/store.ts:301-313；枚举定义源码位置: packages/pinia/src/types.ts:43-65
- 异步监听开关不在补丁结束时立即恢复，而是排进 `nextTick` 微任务，并用模块变量 `activeListener`（Symbol）做"最近一次补丁才生效"的去重。源码位置: packages/pinia/src/store.ts:315-320
- 同步监听开关在补丁内同步恢复（紧跟微任务调度之后）。源码位置: packages/pinia/src/store.ts:321
- 补丁结尾手动 `triggerSubscriptions(subscriptions, mutation, state)` 一次性派发。源码位置: packages/pinia/src/store.ts:323-327
- `mergeReactiveObjects` 合并规则：Map 用 `set`、Set 用 `add`（整键覆盖，不递归进元素）；普通对象（isPlainObject）两边都是才递归合并；遇 ref/reactive 包装值或类型不匹配则整值覆盖；显式跳过 Symbol 键（不可序列化）。源码位置: packages/pinia/src/store.ts:79-113
- `$reset` 仅 option store 存在；setup store 在 dev 下抛错、prod 下为 noop——根源是 option store 状态形状已知可重建、setup store 状态命令式创建无法自动重建。源码位置: packages/pinia/src/store.ts:330-347
- `$reset` 内部转调 `$patch`（函数式 + assign），代码注释明言"用 patch 把所有改动收成一条订阅"。源码位置: packages/pinia/src/store.ts:334-338
- `$state` 的 setter 内部同样转调 `$patch`（函数式 + assign），且是"浅 assign 合并进现有状态"，不会删除多余旧键。源码位置: packages/pinia/src/store.ts:583-595
- 两个监听开关在 `createSetupStore` 装配末尾才置 true——装配期间对状态的初始化写入不算变更、不通知订阅。源码位置: packages/pinia/src/store.ts:778-779
- 订阅 watcher 的固定选项 `deep: true`（深度监听根状态）；dev 下额外挂 `onTrigger` 收集调试事件。源码位置: packages/pinia/src/store.ts:243-263

## 关键调用链

- `$patch`（函数式）→ 用户 mutator 直接改 `pinia.state.value[$id]` → 生成 patchFunction 事件 → `triggerSubscriptions`
- `$patch`（对象式）→ `mergeReactiveObjects(pinia.state.value[$id], patch)` → 生成 patchObject 事件（带 payload）→ `triggerSubscriptions`
- `$reset` → `$patch`（函数式，内部 `assign($state, newState)`）
- `$state` setter → `$patch`（函数式，内部 `assign($state, state)`）
- 对比链（属下一章，此处仅标界）：直接改 `store.x = ...` 不经 `$patch`，由 `$subscribe` 的深度 watcher 捕获、事件类型为 `MutationType.direct`；补丁期间开关被关，故补丁路径完全靠手动派发、不走 watcher。

## 源码摘录（带行号，全文累计 ≤ 30 行）

补丁核心（暂停 → 双形态分叉 → 异步恢复 → 手动派发）：

```ts
// packages/pinia/src/store.ts:293, 299-327（精简，去类型断言）
isListening = isSyncListening = false                          // 暂停两个监听开关
if (typeof partialStateOrMutator === 'function') {
  partialStateOrMutator(pinia.state.value[$id])                // 函数式：根状态交给用户直接改
  subscriptionMutation = { type: MutationType.patchFunction, storeId: $id, events: debuggerEvents }
} else {
  mergeReactiveObjects(pinia.state.value[$id], partialStateOrMutator) // 对象式：深合并
  subscriptionMutation = { type: MutationType.patchObject, payload: partialStateOrMutator, storeId: $id, events: debuggerEvents }
}
const myListenerId = (activeListener = Symbol())
nextTick().then(() => { if (activeListener === myListenerId) isListening = true }) // 异步开关微任务恢复，且仅最近一次生效
isSyncListening = true                                          // 同步开关立即恢复
triggerSubscriptions(subscriptions, subscriptionMutation, pinia.state.value[$id]) // 手动统一触发一次
```

深合并规则（Map/Set 整键覆盖 + 普通对象递归 + 响应式包装整值覆盖）：

```ts
// packages/pinia/src/store.ts:83-109（精简）
if (target instanceof Map && patchToApply instanceof Map) patchToApply.forEach((v, k) => target.set(k, v))
else if (target instanceof Set && patchToApply instanceof Set) patchToApply.forEach(target.add, target)
for (const key in patchToApply) {
  const subPatch = patchToApply[key], targetValue = target[key]
  if (isPlainObject(targetValue) && isPlainObject(subPatch) && Object.hasOwn(target, key) && !isRef(subPatch) && !isReactive(subPatch)) {
    target[key] = mergeReactiveObjects(targetValue, subPatch)  // 两边都是普通对象 → 递归
  } else {
    target[key] = subPatch                                      // 含 ref/reactive 或类型不匹配 → 整值覆盖
  }
}
```

重置路由回补丁（注释点明动机）：

```ts
// packages/pinia/src/store.ts:330-339（精简）
const $reset = isOptionsStore
  ? function $reset() {
      const newState = state ? state() : {}
      // we use a patch to group all changes into one single subscription
      this.$patch(($state) => { assign($state, newState) })
    }
  : __DEV__ ? () => { throw new Error(`🍍: Store "${$id}" is built using the setup syntax and does not implement $reset().`) } : noop
```

（$state setter 同构路由：`set: (state) => $patch(($state) => { assign($state, state) })`，源码位置 packages/pinia/src/store.ts:585-594）

## 易混淆 / 边界 / 推断

- 事实：`$state` setter 用 `assign`（Object.assign，浅复制可枚举自有属性），不会删除新状态里不存在的旧键——故 `$state = { a: 1 }` 作用于 `{ a: 0, b: 2 }` 结果是 `{ a: 1, b: 2 }`，是"合并"而非"替换"。源码位置: packages/pinia/src/store.ts:590-593
- 事实：对象式与函数式补丁都不经过 watcher（进入即关开关），故订阅事件完全由末尾的 `triggerSubscriptions` 产生；只有"直接改 state"才走 watcher（事件类型 direct）。源码位置: packages/pinia/src/store.ts:293, 323-327
- 事实：`mergeReactiveObjects` 仅当 target 与 patch 两边值都是普通对象才递归；patch 值若是 ref/reactive，即使 target 是普通对象也走整值覆盖（避免拆开响应式包装破坏响应性）。源码位置: packages/pinia/src/store.ts:95-108
- 推断（标注为推断）：异步开关用 `nextTick` 恢复而非立即恢复，是为了让"本 tick 内因状态改动而排队的 pre/post watcher job"在 flush 时撞上开关=false 被吞；若立即恢复，该 job 会真通知，与手动派发重复。此推断结合 Vue 调度器行为得出，源码本身无注释。源码位置: packages/pinia/src/store.ts:316-320
- 推断（标注为推断）：`mergeReactiveObjects` 对数组的合并行为——`for...in` 枚举数组索引，逐索引处理：两端元素都是普通对象则递归合并该元素，否则整值覆盖该索引；target 多出的尾部元素会被保留（不裁剪）。源码无注释、非主线，建议 Writer 不展开或实测确认。源码位置: packages/pinia/src/store.ts:91-109
- 事实：连续多次补丁时，`activeListener` Symbol 保证只有最后一次补丁的 `nextTick` 回调会把异步开关恢复为 true，中间各次的恢复回调因 `activeListener` 已被覆盖而失效。源码位置: packages/pinia/src/store.ts:315-320
- 未理解：补丁内 `isSyncListening = true` 紧跟在 `nextTick` 调度之后、手动派发之前——为何同步开关要在"手动派发之前"就恢复（手动派发并不经过 watcher、不读该开关），此精确时序的用意源码无注释，留待结合下一章的 sync watcher 行为再确认。
# $patch：状态变更与深度合并

## 一、状态变更是两个耦合的难题

一个 store 的状态会以很多种方式变动：直接给某字段赋值、往数组里 `push`、整体替换一个子树，或一次性塞进一批字段。订阅了「状态变化」的代码（持久化、日志、调试面板）需要可靠地知道「变了」，更想知道「这是一次有意的批量改动，还是零散的单点赋值」。

这件事之所以难，是因为它把**两个本可独立的难题耦合在了一起**：

- **数据问题**——怎么把变更写进状态树：是覆盖、是合并、还是整体替换？
- **通知问题**——改完怎么告诉订阅者，告诉它什么：是每个被碰过的属性各喊一声，还是汇总成一次？

如果对通知问题撒手不管，把底层响应式系统的深度监听（deep watch）直接暴露给订阅者，那么一次改 5 个字段的补丁会被拆成 5 次碎片化的回调，每次回调拿到的都是一个不完整的中间态——订阅者既分不清变更来源，也拿不到一致的「变更后快照」。

`$patch` 的存在，就是为了**把这两个问题解耦**：让「一次批量变更」恰好等于「一次订阅通知」，并顺手把「这次变更是对象补丁还是变更函数」这个语义塞进通知里，供调试面板与测试断言归因。

## 二、核心思想：停表 → 改动 → 手动播报 → 下一拍恢复

一句话：**与其让底层监听器对每个被碰过的属性各喊一声，不如在改动期间短暂屏蔽它、自己改完、由自己统一喊一声。**

这可以类比「停表检修」：检修期间把电闸拉下（屏蔽自动监听）→ 动手改线路（应用变更）→ 自己按一次总广播按钮（手动触发一次订阅）→ 检修结束推回电闸（恢复监听）。它的完整执行轨迹是 7 步：

```
1. 拉下「自动监听总闸」（同时关掉异步、同步两条支线）
   → 2. 选合并路径：变更函数直接改 / 补丁对象递归合并
      → 3. 立即推回「同步支线」闸（同步监听即时恢复）
         → 4. 给本次变更盖一个序号章，约定「下一拍」才推回「异步支线」闸，且只有最新序号那次真正推回
            → 5. 不等底层监听器，直接手动广播一次订阅事件
               → 6. 本拍结束时底层监听回调被调度运行，但异步闸还拉着 → 空转
                  → 7. 下一拍：异步闸推回，后续外部赋值恢复正常监听
```

注意第 5 步的因果：**正因为第 1 步关掉了自动监听，本次变更「没人会通知」，才必须由 `$patch` 自己在第 5 步手动喊一声**——这是整个机制的枢纽。

## 三、从零实现：把核心机制压成 40 行 mini

下面不引入 pinia 或任何响应式库，只用纯 JavaScript 从零搭一个 mini store，演透「停表-合并-播报-恢复」与「深合并 vs 整体替换」两组原理。先看零件，再看组合。

### 零件 A：纯对象判定与合并器

合并器只做一件事——对补丁里的每个键，决定**下钻递归**还是**整体替换**：

```ts
// 模拟源码 isPlainObject：只有"裸对象"才下钻；数组、Date、ref 一律不算
function isPlainObject(o) {
  return (
    o && typeof o === 'object' &&
    Object.prototype.toString.call(o) === '[object Object]' &&
    typeof o.toJSON !== 'function' &&
    !isRef(o)                       // 响应式引用不算纯对象 → 走整体替换
  )
}
// 用一个带标记的普通对象模拟 ref：代表"一块带引用语义的响应式值"
const ref = (v) => ({ __ref: true, value: v })
const isRef = (o) => o && o.__ref === true

// mini 合并器：纯对象子树递归（保留兄弟），其余整体替换
function mergeReactiveObjects(target, patch) {
  for (const key in patch) {
    if (!Object.hasOwn(patch, key)) continue
    const sub = patch[key]
    if (
      isPlainObject(target[key]) && isPlainObject(sub) &&
      Object.hasOwn(target, key)      // 目标得先有这个键才"下钻"，否则直接新增
    ) {
      target[key] = mergeReactiveObjects(target[key], sub) // 纯对象：递归，保兄弟
    } else {
      target[key] = sub                                    // 数组/Date/ref/异类：整体替换
    }
  }
  return target
}
```

这里刻意省略了真实合并器里的两条集合分支（映射表逐键 `set`、集合取并集 `add`），它们只在「目标与补丁同为该集合类型」时才触发；正文按下不表，原理与下面的判定同构。

### 组合层：把零件装成 mini store

```ts
function createMiniStore(initial) {
  const state = structuredClone(initial)
  const subscriptions = new Set()
  let isListening = true            // 自动监听闸门（真实实现有同步/异步两个，本演示合并为一个）

  function $patch(partialOrMutator) {
    isListening = false                                              // ① 停表
    let mutation
    if (typeof partialOrMutator === 'function') {
      partialOrMutator(state)                                         //   函数形态：直接改状态树
      mutation = { type: 'patch function' }
    } else {
      mergeReactiveObjects(state, partialOrMutator)                   //   对象形态：递归深合并
      mutation = { type: 'patch object', payload: partialOrMutator }
    }
    for (const cb of subscriptions) cb(mutation, state)               // ② 手动播报一次
    isListening = true                                               // ③ 恢复（真实：同步立即、异步下一拍）
  }
  function $subscribe(cb) { subscriptions.add(cb) }
  return { state, $patch, $subscribe }
}
```

### 跑通：一次补丁只触发一次回调

```ts
const store = createMiniStore({ profile: { name: 'a', age: 1 }, list: ['x'] })
let callCount = 0
store.$subscribe((mutation, s) => { callCount++; console.log(mutation.type, '→', JSON.stringify(s)) })

store.$patch({ profile: { age: 2 } })
// 打印: patch object → {"profile":{"name":"a","age":2},"list":["x"]}
console.log(callCount)                  // 1   ← 一次补丁只触发一次回调
console.log(store.state.profile.name)   // 'a' ← 深合并保留了补丁未提及的兄弟字段
console.log(store.state.list)           // ['x'] ← 未被补丁触及，原样不动
```

`callCount === 1` 是整套机制的全部目的：在真实 Vue reactive 里，`mergeReactiveObjects` 内部那次 `target[key] = ...` 的赋值本会触发深度监听回调；闸门 `isListening = false` 让它空转，最后由第 ② 步手动补上唯一一次播报。

### 两条分支的对比：深合并 vs 整体替换

```ts
// 分支 A：补丁里的数组 → 整体替换（isPlainObject([]) 为 false，不下钻、不 push）
store.$patch({ list: ['y', 'z'] })
console.log(store.state.list)           // ['y','z']  整个换掉，而非 ['x','y','z']

// 分支 B：补丁里的响应式引用 → 整体替换，绝不钻进它内部
const store2 = createMiniStore({ config: ref({ level: 1 }) })
const oldRef = store2.state.config
store2.$patch({ config: ref({ level: 2 }) })
console.log(store2.state.config === oldRef)        // false ← 原 ref 被整体丢弃，换成你给的那个
```

分支 B 的 `=== false` 才是关键：若是「深合并」，会保留原 `ref`、钻进它的 `.value` 把 `level` 改成 2，引用身份不变（`=== true`）；而机制选择整体替换，于是你 patch 进什么 `ref`，state 就持有那个 `ref`，绝不偷偷钻进去改——这正是「保引用语义」。

## 四、四个关键权衡

### 权衡一：暂停自动监听总闸，换来「一次变更一个事件」

**选择**：在 `$patch` 入口同时拉低两个监听开关，把底层深度监听短暂关掉。
**换来**：一次批量变更只产生一个订阅事件。深合并可能改 N 个字段、变更函数可能多次 `push`/赋值；若任由深度监听逐属性广播，订阅者会被 N 次碎片回调淹没，且每次拿到的都是不完整的中间态，根本无法用来持久化或断言。
**代价**：监听一关，本次变更就「没人通知」了，所以必须由 `$patch` 自己在末尾手动触发一次订阅回调；并且要精确管住开关的关/开时机——关早了会漏掉之前排队的变更，开早了又把本次补丁的中间态泄漏出去。这条代价直接催生了下面三条权衡。

### 权衡二：同步立即恢复、异步延后恢复（最绕的一条）

**选择**：同步支线开关在 `$patch` 末尾**立即**推回；异步支线开关推迟到 `nextTick`（下一拍）才推回。
**换来**：两类深度监听各自在正确时机放行，既不漏播后续变更、也不误播本次中间态。理解这条必须看清 Vue 的两类 watcher 时机——

- 默认的 **post watcher**：回调在当前同步任务结束后的微任务 flush 时才跑。本次补丁的所有赋值都发生在 flush **之前**；若异步开关也立即恢复，flush 时回调就会把本次补丁当作「外部直接变更」**误播一次**（事件类型 `direct`），与手动播报的 `patch` 事件重复。所以异步开关必须延后到 `nextTick` 之后，让本次 flush 的回调**空转**。
- **sync watcher**：回调在字段被 `set` 的**当场**就跑。若到 `$patch` 结束还不放开，紧接着 `$patch` 之后用户的同步直接赋值（如 `store.x = 1`）会被**漏播**。所以同步开关必须立即恢复。

**代价**：出现两个语义不同的开关位，时序绕——读代码时要同时盯「同步这条立即开、异步那条下一拍开」，一眼难懂；维护时也容易改错其中一个，导致难以察觉的漏播或重复播报。

### 权衡三：用序号去重，换来「同拍多次补丁不被中间态触发」

**选择**：每次 `$patch` 生成一个唯一序号（`Symbol`），更新一个跨调用可见的指针；`nextTick` 的恢复回调里只有「序号仍是指针最新值」的那次才真正推回异步开关。
**换来**：同一拍内连续多次 `$patch`（比如一个 action 里连打两次补丁），只有最后一次的恢复回调生效，前几次的 `nextTick` 回调发现序号已过期便空转，从而避免中间状态触发监听（对应 issue #1129「避免触发过多监听」）。
**代价**：多出一个跨调用的竞态序号状态。它是个「幽灵开关」——不看代码根本不知道它的存在，却决定了异步监听到底在哪个时刻恢复，理解成本不低。

### 权衡四：深合并保旧子树，但 ref/reactive 整体替换保引用语义

**选择**：合并器对**纯对象**子树递归下钻（保留补丁未提及的兄弟字段），但对 `ref`/`reactive`、数组、`Date`、异类集合一律**整体替换**。
**换来**：未触及的旧子树被保留（补丁 `{ profile: { age: 2 } }` 不会擦掉 `profile.name`）；同时响应式值的**引用语义不被破坏**——你 patch 进一个 `ref`，state 就持有那个 `ref`，不会偷偷钻进它的 `.value` 局部改写（见上面分支 B 的 `=== false`）。
**代价**：无法把补丁**钻进**一个响应式引用/响应式对象的内部（要改 `ref` 内部只能整体换一个新 `ref`）；并且需为映射表（逐键 `set`）、集合（取并集 `add`）各写一条特例分支，合并器的判定条件因此变长。

值得提一句：这同一套「停表-播报-恢复」机制被反复复用——`$reset` 与给 `$state` 整体赋值的 setter，都**内部走变更函数形态**调用 `$patch`，从而让「重置」「整体替换」也享有「一次变更一个事件」的语义，无需各写一套通知逻辑。

## 五、源码对照

上面的 mini 是原理压缩版，下面三个取舍点给出真实源码的对应位置，便于按图索骥：

- **停表-播报-恢复骨架**：真实 `$patch` 入口 `isListening = isSyncListening = false`（停表）→ 应用变更 → `nextTick().then(...)` 仅当序号最新才恢复异步开关 → `isSyncListening = true`（同步立即恢复）→ `triggerSubscriptions(...)`（手动播报）。对应 `store.ts:293-327`。
- **递归判定门槛**：真实合并器的下钻条件是 `isPlainObject(targetValue) && isPlainObject(subPatch) && Object.hasOwn(target, key) && !isRef(subPatch) && !isReactive(subPatch)`——注意 `ref`/`reactive` 判定放在合并器的 `if` 条件里（mini 为简洁并进了 `isPlainObject`，语义等价）。对应 `store.ts:95-109`。
- **双开关闸门落点**：`$subscribe` 注册的深度监听回调里，正是用 `options.flush === 'sync' ? isSyncListening : isListening` 决定是否真正调用用户回调——这正是「屏蔽」与「恢复」真正生效的地方。对应 `store.ts:458`。

## 小结

`$patch` 把「怎么改状态」与「怎么通知订阅者」解耦：用一对（同步/异步）监听开关在变更期间屏蔽底层深度监听，自己应用变更后手动播报一次，再按各自正确时机恢复——从而保证「一次批量变更 = 一个订阅事件」。合并器则以「纯对象下钻、其余整体替换」一刀切，同时守住「保旧子树」与「保引用语义」两个目标。理解了停表-合并-播报-恢复这条主线，也就理解了 `$reset`、`$state` setter 为何都复用同一套机制。
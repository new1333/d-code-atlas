# 发布-订阅原语

Pinia 里有一类「通知」需求反复出现：状态变了要通知 `$subscribe` 的订阅者，action 被调用要通知 `$onAction` 的监听者，`$patch` 改了状态也要补发一次通知。这些场景的签名各不相同，但底层的动作却惊人地一致——**往一个回调集合里注册，在事件发生时把它们挨个调用一遍**。

把这件事抽出来，就是本章的主角：`packages/pinia/src/subscriptions.ts`。它只有 34 行，导出三个符号，本身**不含任何 Pinia 语义**（不知道 store、state、action 为何物），却成了上面所有通知能力的通用基石。本章自底向上拆解它，并回答 summary 里的那句关键论断：**它如何「自动随 effectScope 释放」**。

> 前置概念来自 [核心类型契约](../core-types/)：可调用类型 `_Method = (...args: any[]) => any`、变更类型 `MutationType`、订阅回调类型 `SubscriptionCallback` / `StoreOnActionListener`，本章直接复用。

## 一、三块基石：`noop`、`addSubscription`、`triggerSubscriptions`

整个文件只导出三个符号。先看全貌（无删节）：

```ts
// packages/pinia/src/subscriptions.ts:1-34
import { getCurrentScope, onScopeDispose } from 'vue'
import { _Method } from './types'

export const noop = () => {}

export function addSubscription<T extends _Method>(
  subscriptions: Set<T>,
  callback: T,
  detached?: boolean,
  onCleanup: () => void = noop
) {
  subscriptions.add(callback)

  const removeSubscription = () => {
    const isDel = subscriptions.delete(callback)
    isDel && onCleanup()
  }

  if (!detached && getCurrentScope()) {
    onScopeDispose(removeSubscription)
  }

  return removeSubscription
}

export function triggerSubscriptions<T extends _Method>(
  subscriptions: Set<T>,
  ...args: Parameters<T>
) {
  subscriptions.forEach((callback) => {
    callback(...args)
  })
}
```

### `noop`：被反复复用的空函数

```ts
export const noop = () => {}   // subscriptions.ts:4
```

它身兼两职：一是 `addSubscription` 的 `onCleanup` **默认值**（注册时不传清理逻辑就用它占位）；二是在 store 里充当「无操作时的占位返回值」——后面会看到 `$subscribe` 去重命中时返回的就是这个 `noop`（store.ts:445），而不是真正的退订函数。

### `addSubscription`：注册一个回调，换回一个「退订函数」

它的四参签名是理解整个原语的关键：

```ts
// subscriptions.ts:6-11
export function addSubscription<T extends _Method>(
  subscriptions: Set<T>,        // 目标回调集合（由调用方持有）
  callback: T,                  // 要注册的回调
  detached?: boolean,           // 是否「游离」——不随 scope 自动清理
  onCleanup: () => void = noop  // 退订时的清理动作（默认啥也不做）
)
```

注意泛型约束 `T extends _Method`，而 `_Method = (...args: any[]) => any`，即「任意可调用、任意参数、任意返回」。`T` 由调用方传入的 `Set<T>` 推断：传 `Set<SubscriptionCallback<S>>`，`T` 就是状态订阅回调；传 `Set<StoreOnActionListener<...>>`，`T` 就是 action 监听回调。**这一个原语因此能服务于签名完全不同的回调集合**，且 `trigger` 时展开的参数与 `add` 时注册的类型保持一致。

它的核心流程是四步：

```
addSubscription(subscriptions, callback, detached, onCleanup)
        │
        ▼
  ① subscriptions.add(callback)            ── 回调入集合
        │
        ▼
  ② 构造 removeSubscription 闭包           ── delete 成功才跑 onCleanup（幂等）
        │
        ▼
  ③ !detached && getCurrentScope()         ── 把退订挂到当前活跃 scope 的清理队列
        │            └─ 否则跳过（手动退订 / 无 scope 环境）
        ▼
  ④ return removeSubscription              ── 把「手动退订函数」交还调用方
```

对应的实现：

```ts
// subscriptions.ts:12-23
subscriptions.add(callback)

const removeSubscription = () => {
  const isDel = subscriptions.delete(callback)   // Set.delete 成功才返回 true
  isDel && onCleanup()                           // 仅当真删掉时才清理
}

if (!detached && getCurrentScope()) {
  onScopeDispose(removeSubscription)
}

return removeSubscription
```

这里有一个精心设计的细节：**remover 是幂等的，但 `onCleanup` 只在「真删掉」时跑一次**。`Set.prototype.delete` 只在集合里确实存在该元素时返回 `true`，所以对同一个 `removeSubscription` 连调两遍是安全的——第二遍 `delete` 返回 `false`，`onCleanup` 不再触发。

### `triggerSubscriptions`：遍历活集合，逐一同步调用

```ts
// subscriptions.ts:26-33
export function triggerSubscriptions<T extends _Method>(
  subscriptions: Set<T>,
  ...args: Parameters<T>     // 从回调类型 T 反推出可变参数元组
) {
  subscriptions.forEach((callback) => {
    callback(...args)
  })
}
```

`...args: Parameters<T>` 是点睛之笔：它从回调类型 `T` **反向**推出「触发时该传什么参数」。于是调用方在 `add` 时注册的回调类型，自动决定了 `trigger` 时展开的实参形状——类型系统在两端对齐，不会错配。

实现上它**直接遍历活 Set，不做快照拷贝**。这意味着如果某个回调在执行期间自己 `removeSubscription` 或新 `addSubscription`，将按 ES Set 的迭代语义处理（已删除且未访问的元素不会被访问，新增元素可能被访问也可能不）。Pinia 在此**没有防御性拷贝**——一般业务回调不会在回调里改订阅，但这是真实的边界行为，使用时需知晓。

## 二、核心亮点：自动随 effectScope 释放

summary 那句「自动随 effectScope 释放」是这套原语区别于「手写一个事件总线」的关键。它由**原语侧的一个挂钩**和 **Pinia 侧的 scope 嵌套**共同实现。

### 原语侧的挂钩：`onScopeDispose`

```ts
// subscriptions.ts:19-21
if (!detached && getCurrentScope()) {
  onScopeDispose(removeSubscription)
}
```

两道开关：

- **`detached`（游离）**：为真则跳过自动清理。对应 `$subscribe(cb, { detached: true })` 和 `$onAction(cb, true)`——订阅者明确要求「不随组件卸载自动退订」。
- **`getCurrentScope()`**：Vue 提供的函数，返回**注册订阅那一刻**调用方的活跃 effectScope。若调用时没有活跃 scope（比如在顶层模块、`setTimeout`、异步回调里注册），它返回空，**不会**自动清理——此时必须手动持有并调用返回的 remover。

> ⚠️ 自动清理依赖的是**注册时的活跃 scope**，而非回调执行时的 scope。在组件 `setup()` 内注册，拿到的是组件 scope，组件卸载即自动退订；脱离任何 scope 注册则无人替你清理。

### Pinia 侧的 scope 嵌套

挂钩能生效，前提是「订阅注册时存在一个会被销毁的 scope」。Pinia 用两层 effectScope 构筑了这条链：

```
createPinia()
  └─ scope = effectScope(true)        ── Pinia 实例的「根 scope」，挂在 pinia._e（createPinia.ts:11）

每个 store：
  pinia._e.run(() =>                  ── 在根 scope 内运行（store.ts:501）
    (scope = effectScope()).run(...)  ── 为本 store 新建子 scope
  )
```

因此 `$subscribe` 建立的 watcher、各处 `onScopeDispose(...)` 都挂在 store 的子 scope 上；`$dispose()` 调一句 `scope.stop()`（store.ts:350），就会触发该 scope 上登记的全部 dispose 回调——其中就包括每个订阅注册时挂上去的 `removeSubscription`。

把两端拼起来，自动退订的完整链路是：

```
组件 setup() 内调用 store.$subscribe(cb)
   │
   ├─ addSubscription(...) 此刻 getCurrentScope() = 组件 scope
   │      └─ onScopeDispose(removeSubscription)  → 登记到组件 scope
   │
   ▼
组件卸载 → 组件 scope.dispose()
   │
   ▼
removeSubscription() 自动执行
   └─ subscriptions.delete(cb) && stopWatcher()   ── 订阅与 watcher 一并清掉
```

> 顺带一提：`$dispose` 还会额外显式 `subscriptions.clear()` / `actionSubscriptions.clear()`（store.ts:351-352），那是「整店关张」式的彻底清理；而 `onScopeDispose` 链路负责「单个订阅者随自身 scope 退场」。两者并行、互不冲突。（根 scope 的 `effectScope(true)` 细节留待 Pinia 根实例章展开。）

## 三、原语如何被复用为 `$subscribe` / `$onAction` / `$patch`

这一节用精炼的代码证明上面那个通用原语的「通用」二字——三套不同签名的通知，全靠 `addSubscription` + `triggerSubscriptions` 装配。

store 内部先声明两个长期存在的回调集合（store.ts:268-269）：

```ts
let subscriptions: Set<SubscriptionCallback<S>> = new Set()              // 状态订阅
let actionSubscriptions: Set<StoreOnActionListener<Id, S, G, A>> = new Set() // action 订阅
```

**`$onAction`：偏函数绑定，一步成型签名。** 把 `addSubscription` 的第一个参数（目标 Set）用 `bind` 固定为 `actionSubscriptions`，于是实例上的 `$onAction(callback, detached?, onCleanup?)` 签名自然成型（store.ts:435）：

```ts
$onAction: addSubscription.bind(null, actionSubscriptions),
```

**`$subscribe`：去重 + `onCleanup` 停 watcher。** 先做一道去重守卫——对同一个回调函数引用只建一个 watcher（规避 issue #3143）；命中去重时返回占位 `noop`（**不是真 remover**，调它没有任何效果）；否则用「停掉 watcher」作为 `onCleanup`（store.ts:441-453）：

```ts
// store.ts:441-453
if (subscriptions.has(callback)) {
  if (__DEV__) { diagnostics.PINIA_R1007({ id: $id }) }
  return noop                       // 注意：占位，退订无效
}
const removeSubscription = addSubscription(
  subscriptions,
  callback,
  options.detached,
  () => stopWatcher()               // onCleanup = 退订时停掉 watch
)
```

**`$patch`：暂停 watcher 后手动 `trigger` 补发。** `$patch` 执行期间会把 `isListening = isSyncListening = false` 暂停 watcher，避免与 patch 合并逻辑冲突；patch 完成后**手动**触发一次订阅，以携带 `MutationType` 的 mutation 对象通知订阅者（store.ts:293,321-327）。源码注释原话：`because we paused the watcher, we need to manually call the subscriptions`。

```ts
// store.ts:322-327
triggerSubscriptions(
  subscriptions,
  subscriptionMutation,           // { type: MutationType.patchObject/patchFunction, ... }
  pinia.state.value[$id]
)
```

**action 包装器：两级触发。** 每次调用 action 时，先触发 store 级 `actionSubscriptions`（事件含 `{ args, name, store, after, onError }`）；listener 可调 `after(cb)`/`onError(cb)` 把回调塞进**本次调用专属**的临时集合，action 成功/失败时再触发它们（store.ts:382-412）。整条链路全是 `triggerSubscriptions` 在驱动。

## 四、订阅回调会收到的变更类型

`$subscribe` 的回调会收到一个 mutation 对象，其 `type` 字段取自 `MutationType` 枚举。它与 `subscriptions.ts` 无直接耦合，但讲清 `$subscribe` 收到的事件绕不开它。

```ts
// packages/pinia/src/types.ts:43-68
export enum MutationType {
  /** 直接改 state：store.name = 'x'、store.$state.name = 'x'、store.list.push('y') */
  direct = 'direct',
  /** $patch({ ... }) 改 state */
  patchObject = 'patch object',
  /** $patch(state => ...) 改 state */
  patchFunction = 'patch function',
}
```

三条触发路径与这三个值的对应关系：

```
直接改 state（store.x = ...、store.list.push(...)）
   └─ 走 watch 路径 ─→ callback 收到 type: MutationType.direct         （store.ts:462）

$patch({ ... })
   └─ 手动 trigger  ─→ callback 收到 type: MutationType.patchObject    （store.ts:309）

$patch(state => ...)
   └─ 手动 trigger  ─→ callback 收到 type: MutationType.patchFunction  （store.ts:302）
```

注意：`$patch` 的「手动触发」是**补缺**而非额外通知——正因为 patch 期间关掉了 watcher，正常 watch 路径不会触发 `$subscribe`，才需要 `triggerSubscriptions` 去替代那条被暂停的路径。

## 五、四个容易踩的坑

1. **remover 幂等，但 `onCleanup` 只跑一次。** 重复调用 `removeSubscription()` 安全；第二次 `delete` 返回 `false`，`onCleanup`（如停 watcher）不再执行（subscriptions.ts:14-17）。

2. **`$subscribe` 去重命中返回的是 `noop`，不是真 remover。** 用同一个回调引用第二次 `$subscribe` 会拿到空函数，调它退不了订（store.ts:441-446）。这是最容易误以为「拿到了退订函数」的地方。

3. **`triggerSubscriptions` 遍历活 Set，不做快照。** 回调内部增删订阅将按 ES Set 迭代语义生效，Pinia 未做隔离（subscriptions.ts:30-32）。

4. **自动清理取决于注册时的活跃 scope。** 脱离 scope 注册（顶层模块、异步回调、`setTimeout`）则不会自动清理；`detached: true` 同样关闭自动清理（subscriptions.ts:19-21）。无 scope 或 detached 场景务必手动持有并调用返回的 remover。

## 小结

整套发布-订阅能力可以浓缩成一张图：

```
                 addSubscription(Set, cb, detached?, onCleanup?)
注册侧 ──────────────────────────────────────────────┐
   │ cb 入 Set                                        │ 返回 removeSubscription
   │ !detached && scope → onScopeDispose(remover)     │ （手动退订）
   ▼                                                  ▼
触发侧：triggerSubscriptions(Set, ...args) ──→ Set.forEach(cb => cb(...args))
   │  · $subscribe 直接改 state：走 watch（type=direct）
   │  · $subscribe $patch：暂停 watcher 后手动 trigger（type=patchObject/patchFunction）
   │  · $onAction：action 包装器两级 trigger
   ▼
退订侧：
   · 自动：组件/scope 卸载 → onScopeDispose → removeSubscription → 停 watcher
   · 手动：调用返回的 removeSubscription
   · 整店：$dispose() → scope.stop() + subscriptions.clear()
```

记住一句话即可抓住本质：**`addSubscription` 把回调塞进 Set 并（可选地）挂上 scope 的清理队列，`triggerSubscriptions` 把 Set 里的回调挨个同步调用——泛型 `T` 让同一套机制适配任意签名的回调，`onScopeDispose` 让订阅随 effectScope 自动生灭。** Pinia 的 `$subscribe`、`$onAction`、`$patch` 通知，全是这一原语的不同装配。
# 随作用域清理的发布订阅 · 源码精读

## 给 Writer 的教学钩子（必填，8 子项缺一不可）

- **用户痛点 / 场景**：在组件里订阅 store 的状态变更或动作执行后，最让人头疼的不是「怎么订阅」，而是「什么时候该取消订阅」——忘了取消就会内存泄漏、组件卸载后回调还在跑、回调里访问的响应式数据早已销毁。手写一遍「注册 + onUnmounted 注销」的样板代码既啰嗦又容易漏。更麻烦的是：有时候你恰恰希望订阅活得更久，比组件还久（比如全局监听所有动作做埋点），「随组件死」和「跨组件活」两种诉求打架。

- **一句话核心思想**：把回调塞进一个集合，触发时按插入顺序逐个调用；订阅时顺手问一句「你现在身处哪个作用域」，把注销动作挂到那个作用域的清理队列里，让订阅随作用域一起死——而一个 detached 开关让它可以选择「我不属于任何作用域，自己活」。

- **设计动机（为什么需要它）**：这个机制要解决的矛盾是「自动清理的便利」与「生命周期的灵活性」不可兼得。它换来的核心能力是：调用方在组件里写一句订阅就等于同时写好了注销，零样板、零泄漏；同时又留了一个口子让少数场景脱离作用域独立存活。它是后续 `$subscribe`（状态变更监听）与 `$onAction`（动作监听）共同复用的同一副骨架，所以必须做到极致薄、零状态、可复用。本章是全书地基章（无前置依赖），不涉及任何承前原理。需提醒 Writer：**触发时机**（何时调用遍历、nextTick、监听开关、批量合并）属于后续「状态变更双管道」章，本章只聚焦「订阅原语本身怎么造」——不要越界讲触发时机。

- **关键权衡（本 Atlas 的核心）**：
  1. **选择「集合容器 + 同步遍历」** → 换来实现极简（一存一遍历两件事）、回调按注册顺序触发、天然引用去重（同一回调重复注册只存一份） → 代价是遍历过程中增删回调须遵循集合的迭代语义（已访问项删除不重访、新增项会被本轮访问到），这是一个很轻微的心智负担。
  2. **选择「探测当前作用域、把注销挂到作用域清理队列」** → 换来调用方完全不用写卸载样板，在组件里订阅零泄漏 → 代价是订阅的生命周期被**隐式**绑定到「注册那一刻所处的那个作用域」上，调试时必须意识到「现在我在哪个作用域里」，否则会对「为什么组件卸载了订阅还在 / 没了」感到困惑。
  3. **选择「detached 显式开关 + 永远返回手动注销函数」** → 换来同一套 API 既能随作用域自动回收、又能脱离作用域长存（跨组件生命周期的全局监听） → 代价是 detached 路径完全靠调用方自觉——如果忘了保存并调用返回的注销函数，就一定会泄漏，框架不再兜底。
  4. **选择「统一的清理回调钩子」**（注销时连带触发一个钩子） → 换来「手动注销」和「作用域自动注销」走同一条清理路径，外部副作用（如停止一个 watcher）只需注册一次就两条路都生效 → 代价是订阅函数的签名多了一个仅内部使用的参数，对最终用户不可见但增加了内部理解成本。

- **最小心智模型（3～7 步）**：
  1. 准备一个空集合，作为这一类事件的「订阅簿」。
  2. 有人来订阅：把回调放进集合，同时闭包产出一个「注销函数」（它知道自己要删哪个回调）。
  3. 注册瞬间探测：当前有没有活跃的作用域？有、且没声明 detached，就把「注销函数」推进该作用域的清理队列。
  4. 事件发生：遍历集合，按插入顺序逐个同步调用回调，把事件参数透传过去。
  5. 作用域销毁（或调用方手动调注销函数）：执行注销函数，从集合删掉该回调；若删成功了，顺带触发清理钩子（用来收尾 watcher 等外部资源）。
  6. detached 订阅：第 3 步被跳过，只有靠手动调注销函数才会走到第 5 步。

- **最小原理演示（替代旧「复刻范围」）**：
  - **应演示**：一个从零实现、小到只表达核心思想的最小发布订阅总线（几十行）。要素三件套：(a) 一个集合存回调、触发时遍历；(b) 一个**自造的极简作用域**（全局变量记当前作用域、进入时压栈、`stop()` 时跑清理队列、提供「注册清理」和「取当前作用域」两个原语）；(c) 订阅函数里探测当前作用域、按 detached 开关决定是否挂清理。然后跑两条对比轨迹：**轨迹一**——在作用域内订阅（不传 detached）→ 作用域 stop → 回调自动消失；**轨迹二**——detached 订阅 → 作用域 stop 后回调仍在、触发仍能命中 → 手动调返回的注销函数才真正清除。这段演示演的是权衡 ②「自动清理换便利」与权衡 ③「detached 换长生命周期」这对全章灵魂。
  - **应故意省略**：类型泛型、`Parameters<>` 类型工具、偏函数 bind 用法、重复订阅去重诊断、生产/开发分支、watch 与 nextTick 的配合（那属于后续状态变更章）、多事件通道——只保留单一事件通道足以演透原理。
  - **演示载体建议**：**首选 TS/JS**。理由：本章机制本质是「集合 + 作用域清理钩子」两个通用编程概念，没有任何语言特有语义（不涉及所有权/goroutine/描述符等），Vue 自身的作用域清理原语本身也正是这套 JS 机制，因此用 TS/JS 配一个最小 `package.json` 让读者 `node`/`bun run` 即可跑通，最易复刻。建议**自造迷你作用域**而非直接调用 Vue，因为亲手写一遍「当前作用域指针 + 清理队列」才能把「随作用域清理」的原理演透，直接用 Vue 等于把原理当黑盒。**无需退回原仓库语言**（TS 已是原仓库语言）。

- **正文不宜展开的细节**：空函数 `noop` 的两处复用（重复订阅时返回、Setup Store 无 `$reset` 时返回）；`Parameters<T>` 如何从回调类型反推参数类型；偏函数应用 `bind(null, 集合)` 把固定集合预置、对外只暴露后几个参数；重复订阅时的开发期诊断码；迭代中增删的集合语义边角；生产构建下诊断分支的裁除。

- **推荐的一个执行轨迹例子**：输入——组件 setup 中调用「订阅动作」、不传 detached，此刻当前作用域 = 该组件的作用域。中间态——回调进入订阅簿；注销函数被推进组件作用域的清理队列。组件随后卸载：作用域 stop → 清理队列执行注销函数 → 回调从订阅簿移除。对照场景：若调用时第二参传了 detached=true，则作用域 stop 时**不会**移除该回调，组件已卸载但下次动作触发仍会命中回调，直到调用方手动调返回的注销函数。

> 以上钩子供 Writer 写「动机→核心思想→心智模型→关键权衡→原理演示」；下面事实部分供核对，不要被 Writer 当目录照抄。

## 概念要点

- 要点 1：回调容器是一个 **Set**，回调即元素。Set 的「引用唯一」天然让同一回调不会被重复计入，「按插入顺序迭代」保证了触发顺序可预期。源码位置: packages/pinia/src/subscriptions.ts:6-7
- 要点 2：触发 = 对集合做 `forEach` 同步调用，把参数透传。无防抖、无微任务、无批处理——是**最朴素的同步广播**。源码位置: packages/pinia/src/subscriptions.ts:30-32
- 要点 3：自动清理靠**两个条件的与**：`!detached && getCurrentScope()`。即「未声明脱离」且「当前存在活跃作用域」才把注销挂到作用域清理队列。只要任一不满足（显式 detached、或调用时根本不在任何作用域内），就不会自动清理。源码位置: packages/pinia/src/subscriptions.ts:19-21
- 要点 4：挂到作用域清理队列的正是「注销函数」闭包本身——也就是说「手动注销」和「作用域自动注销」执行的是**同一段代码**，保证两条路径行为一致。源码位置: packages/pinia/src/subscriptions.ts:14-21
- 要点 5：清理钩子在「实际删除成功」时才触发（`delete` 返回 true 才调用 `onCleanup`），这让注销函数**幂等**——重复调用（例如先手动注销、作用域销毁时又调一次）不会重复触发清理钩子。源码位置: packages/pinia/src/subscriptions.ts:15-17
- 要点 6：订阅函数**始终返回注销函数**，即便已挂自动清理，调用方仍可提前手动注销。源码位置: packages/pinia/src/subscriptions.ts:23
- 要点 7：`_Method` 类型 = `(...args: any[]) => any`，是对「任意函数」的最宽类型抽象，让本原语能为状态订阅、动作订阅、after 回调、onError 回调等**形形色色的回调**复用同一份实现。源码位置: packages/pinia/src/types.ts:414
- 要点 8：两大真实消费者——动作订阅用偏函数预置了动作回调集合（对外只剩回调/detached 两参）；状态订阅显式传入「状态回调集合 + options.detached + 一个停掉 watcher 的清理钩子」。源码位置: packages/pinia/src/store.ts:435、packages/pinia/src/store.ts:448-453
- 要点 9：状态订阅里那个清理钩子的作用是「订阅被移除时，连带停止 watch」——把「订阅生命周期」与「watcher 生命周期」绑定为一荣俱荣、一损俱损。源码位置: packages/pinia/src/store.ts:452、packages/pinia/src/store.ts:454-471
- 要点 10：主动销毁 store（`$dispose`）时**不走注销函数、也不触发清理钩子**，而是直接 `clear()` 两个集合——但它同时 `scope.stop()`，而 watcher 注册在 store 的作用域内，故 watcher 会被作用域连带停掉，无需靠清理钩子。源码位置: packages/pinia/src/store.ts:349-354

## 关键调用链

注册侧（两条）：
- `$onAction(callback, detached)` → 偏函数预置好的 `addSubscription(actionSubscriptions, callback, detached)` → 把回调加入动作回调集合 → 返回注销函数
- `$subscribe(callback, options)` → `addSubscription(subscriptions, callback, options.detached, () => stopWatcher())` → 把回调加入状态回调集合 + 注册停 watcher 的清理钩子 → 返回注销函数
源码位置: packages/pinia/src/store.ts:435、448-453

触发侧（本原语被复用的地方，**触发时机归后续章，此处只标链路**）：
- `$patch` 暂停 watch 后**手动**调用 `triggerSubscriptions(subscriptions, mutation, state)` 补发一次状态变更事件
- 动作包裹器前置广播：`triggerSubscriptions(actionSubscriptions, { args, name, store, after, onError })`
- 动作的 after/onError 回调集合也复用同一个 `triggerSubscriptions`
源码位置: packages/pinia/src/store.ts:323、382、395、402、406、412

## 源码摘录（带行号，全文累计 ≤ 30 行）

下列摘录演透全章灵魂（权衡 ②③④ 的全部落点都在这段里）：自动清理的双条件守卫、统一注销闭包、幂等的清理钩子、永远返回的注销函数，以及最朴素的同步遍历触发。

```ts
// packages/pinia/src/subscriptions.ts:6-33
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
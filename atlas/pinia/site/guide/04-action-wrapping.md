# Action 包装：before/after/onError 三段拦截

## 写在前面：一个会反复出现的场景

你的 store 里有 15 个 action——`login`、`fetchUser`、`addToCart`、`submitOrder`……某天产品说要给所有 action 加运行时长上报；再过两周安全说要加权限校验；再过一周前端监控说要接错误上报。每来一个需求你就得改 15 个函数，或者逼调用方手动套一层 wrapper。两周以后代码就烂了。

Pinia 的解法是把"一个 action 被调用"这件事变成一条**统一事件流**：所有横切关注点（日志、devtools 时间线、错误监控）都接到同一个 `store.$onAction(callback)` 上，互不打架，也无需碰 action 自身实现。

打个比方：`$onAction` 像公司前台，你想见 action 本尊，得先过前台；前台登记一下、广播一下"X 来了"，再把请求转给 action，action 干完活回来前台再喊一嗓子"X 走了"。整个过程中，X 本人（action 实现）完全不知道前台存在。

## 包装是怎么发生的：构建期偷偷套一层

前两章铺垫过：setup store 的 `setup()` 返回值里，ref 算 state、computed 算 getter。这一章看第三类——**function**。

构建器遍历 setup 返回值时，凡见到 function，就喂给一个叫 `action(fn, name)` 的 helper：

```
for key in setupReturn:
  if isRef(value):       → state
  if isComputed(value):  → getter
  if typeof value === 'function':
      → setupStore[key] = action(value, key)   ← 这一步把所有 action 套了一层
```

说人话就是：你写 `fetchUser: async (id) => {...}`，框架在你写完之后悄悄替换成 `fetchUser: wrappedAction("fetchUser", async (id) => {...})`。**用户什么都不用做，所有 action 自动拥有 `$onAction` 能力**——这是为什么后面写日志、监控的人不用改业务代码就能接入。

## 包装函数做了什么：三段拦截的现场

下面是核心。一个 action 被调用时，真正跑的不是你写的原函数，而是 `wrappedAction`。它干四件事：

1. **设置当前 pinia**：把全局 `activePinia` 指到自己（前一章讲过，组件外取 store 要靠这个）。
2. **新建两个空 Set**：`afterCallbackSet` 和 `onErrorCallbackSet`——这是给订阅者挂回调的"注册窗口"。
3. **广播"我要开始了"**：把 `{ name, store, args, after, onError }` 推给所有 `$onAction` 订阅者。订阅者收到后，趁这个同步时刻调 `after(cb)`/`onError(cb)` 把回调塞进 Set。
4. **真正去跑原函数**，按结局分三种：

```
try { ret = fn(...) }
  ├─ 抛错   → 触发 onError Set → rethrow
  ├─ Promise → .then 触发 after Set / .catch 触发 onError Set → 返回链式 promise
  └─ 同步值 → 立即触发 after Set → 返回原值
```

注意一个时序细节，**这是全章灵魂**：

```
广播 ──→ 跑 fn ──→ 触发 after/onError
       ↑注册窗口↑
```

`after`/`onError` 的注册窗口**只存在于 fn 跑动之前那个同步时刻**。如果某个 listener 写 `setTimeout(() => after(cb), 0)`，等回调进去时 Set 已经被消费完，回调永远拿不到。订阅者必须在 `$onAction` 回调的同步执行段里就把 `after(cb)`/`onError(cb)` 调完。

## 注册窗口的设计：一份 API 同时覆盖同步和异步

到这里可以看清设计意图。一个 action 有三个时刻——开始前、正常结束、抛错。`$onAction` 没有把这三件事分成三个订阅方法（`onBefore`/`onAfter`/`onError`），而是合并成一个回调，再把 after/onError 做成"注册函数"塞进 payload：

```ts
store.$onAction(({ name, store, args, after, onError }) => {
  console.log('🛫', name, args)                  // ← "before"：广播时立刻执行
  after(result => console.log('✅', result))     // ← 注册 after
  onError(err => console.error('❌', err))       // ← 注册 onError
})
```

`after` 和 `onError` 不是回调列表，而是**注册器**（往 Set 里 add）。换来的是：订阅者用同一份 API 既能处理同步 action（after 立刻触发），也能处理异步 action（after 等 Promise resolve 后触发），**甚至不用知道这个 action 是不是 async**——因为 `wrappedAction` 自己用 `instanceof Promise` 判断后分流，订阅者只管"成功就 after、失败就 onError"。

## Symbol 幂等标记：防止重复包装

有一种边界场景：用户在 setup 里手动调 `helpers.action(fn)` 显式包一次（Pinia Colada 这类进阶场景需要拿到 wrappedAction 引用做事情），框架构建期又会自动包一次——如果不加保护，action 就被包成两层，`$onAction` 通知会触发两次。

解法是用一个 Symbol 标记：

```ts
const ACTION_MARKER = Symbol()  // 标识"已包装过"
const ACTION_NAME = Symbol()    // 携带 action 名（HMR 时可改写）

function action(fn, name) {
  if (ACTION_MARKER in fn) {            // 已包过
    fn[ACTION_NAME] = name              // 只补个名字
    return fn                           // 原样返回
  }
  const wrappedAction = function (...) { /* 上面那段四件事 */ }
  wrappedAction[ACTION_MARKER] = true
  wrappedAction[ACTION_NAME] = name
  return wrappedAction
}
```

为什么用 Symbol 而不是字符串属性？因为 Symbol 不会出现在 `for...in` 枚举里、不会被 `JSON.stringify` 序列化、也不可能与用户属性命名冲突。store 一旦被序列化到 SSR payload 或 devtools 视图里，这些标记是隐形的。

## 演示：50 行 TS 演透三段时序

下面这段可以直接 `tsx`/`bun`/`node` 跑起来。注意看 listener 怎么借广播窗口把 `after`/`onError` 注册进去，再看三种结局怎么分发。

```ts
const ACTION_MARKER = Symbol()
const ACTION_NAME = Symbol()

let activePinia: any = null  // 简化：用全局变量代替真正的 setActivePinia

function action<F extends (...args: any[]) => any>(fn: F, name: string): F {
  if (ACTION_MARKER in fn) {
    ;(fn as any)[ACTION_NAME] = name
    return fn
  }
  const wrapped = function (this: any, ...args: any[]) {
    const store = this
    activePinia = store?._pinia ?? activePinia
    const afterSet = new Set<(v: any) => any>()
    const onErrorSet = new Set<(e: unknown) => unknown>()
    const after = (cb: (v: any) => any) => afterSet.add(cb)
    const onError = (cb: (e: unknown) => unknown) => onErrorSet.add(cb)

    // 广播：这一刻 "before" 才发生
    for (const listener of store._actionSubs) {
      listener({ name, store, args, after, onError })
    }

    let ret: unknown
    try {
      ret = fn.apply(store, args)
    } catch (e) {
      for (const cb of onErrorSet) cb(e)
      throw e
    }
    if (ret instanceof Promise) {
      return ret
        .then(v => { for (const cb of afterSet) cb(v); return v })
        .catch(e => { for (const cb of onErrorSet) cb(e); throw e })
    }
    for (const cb of afterSet) cb(ret)
    return ret
  } as any
  wrapped[ACTION_MARKER] = true
  wrapped[ACTION_NAME] = name
  return wrapped as F
}

// 假装这是一个 store
const store: any = { _pinia: { id: 'root' }, _actionSubs: new Set() }
store.$onAction = (cb: any) => store._actionSubs.add(cb)

// 一个 listener：广播时刻打 🛫，注册 after/onError
store.$onAction(({ name, args, after, onError }) => {
  console.log(`🛫 ${name}(${args.join(', ')})`)
  after((v: any) => console.log(`✅ ${name} →`, v))
  onError((e: unknown) => console.error(`❌ ${name} →`, e))
})

// 三个 action：同步、异步、抛错
store.sync = action((x: number) => x * 2, 'sync')
store.asyncFn = action(async (id: number) => `user-${id}`, 'asyncFn')
store.boom = action(() => { throw new Error('kaboom') }, 'boom')

// 跑一下
store.sync(21)                          // 🛫 sync(21) → ✅ sync → 42
await store.asyncFn(42)                  // 🛫 asyncFn(42) → ✅ asyncFn → user-42
try { store.boom() } catch {}            // 🛫 boom() → ❌ boom → Error: kaboom
```

执行轨迹（以 `store.asyncFn(42)` 为例）：

```
1. 进 wrappedAction：建空 afterSet/onErrorSet
2. 广播给 listener → 立刻打 🛫 asyncFn(42)
   listener 同步段调 after(cb1) / onError(cb2)，回调塞进 Set
3. 跑原 fn → 返回 Promise<'user-42'>
4. Promise resolve → for cb of afterSet: cb('user-42') → 打 ✅ asyncFn → user-42
5. wrappedAction 把链式 promise 返回给调用方
6. 调用方 await 拿到 'user-42'
```

可以看见一个关键事实：**广播发生在 fn 真正执行之前，after/onError 的触发发生在 fn 结束之后**。这条时序差撑起了整个三段拦截。

## 关键权衡

讲完机制，回头看几个不显然的设计决策。

### 权衡一：每次调用都重建 Set + 广播 → 换来对称的 per-call 注册 API → 代价是固定开销

每次 `store.fetchUser(42)` 都要分配两个新 Set、做一次广播、走至少一层函数包装；如果是异步，还要再链一个 Promise。

换来的是**任意订阅者都能在每次调用上挂 after/onError**——意味着订阅者可以基于这次调用的 `args` 决定要不要监听结果（比如只在 `args[0] === 'admin'` 时记录耗时），而不是被动接收所有事件。这是 per-call 注册器相比"订阅时一次性传 after 回调"的关键优势。

代价是这部分开销**无法消除**：哪怕一个 listener 都没注册，每次调用也还是要建 Set、空跑一次 forEach。在每秒上万次调用的轻量同步 action 场景里（理论上不该这么用 Pinia），这部分固定开销会成为热点。

### 权衡二：用 Symbol 做隐式标记 → 换来"显式包一次 + 自动再包一次"也不重复 → 代价是依赖隐式契约

包装识别靠 `ACTION_MARKER in fn`——这是一条**隐式契约**：函数对象上挂了个特殊属性，框架就知道"已经包过了"。

换来的是用户可以在 setup 里手动 `helpers.action(fn)`（Pinia Colada 这类场景需要拿到 wrappedAction 引用做进阶操作），框架构建期自动包装碰到这个函数会识别并跳过，不会包成两层。

代价有两个：
- **HMR 重建时**，新模块带来的 action 是新函数对象，没带 Symbol，必须重新走一遍包装流程——所以热更新路径里有专门的重包逻辑，按新模块的 actions 字典对每个 action 重调一次 `action(actionFn, name)`。
- **第三方库返回的函数**虽然理论上不会带 Pinia 的内部 Symbol，但也意味着框架无法识别"这函数本身就是某种 wrapper"，理论上可能在外层套两层 wrapper（每层各自做拦截）——不过这种情况极罕见。

### 权衡三：把 after/onError 暴露成 per-call 注册器 → 换来一份 API 同时覆盖同步+异步 → 代价是链断了就丢通知

`$onAction` 没把 after/onError 设计成"订阅时一次性传给 $onAction"，而是每次调用都重新提供注册器。订阅者拿到 `{ after, onError }` 后，在广播的同步窗口里决定要不要注册、注册什么。

换来的是**订阅者用同一份 API 既能处理同步 action 也能处理异步 action，甚至不用关心是不是 Promise**——因为 wrappedAction 自己 `instanceof Promise` 判断后分流，订阅者只管"成功就 after、失败就 onError"。

代价是**异步 action 的 after 必须等 Promise resolve 后才触发**——调用方拿到的是被 `.then`/`.catch` 链式包过的 promise。如果你在 wrappedAction 外面又手动套了一层不透传 then 的 wrapper（不太常见，但理论上可能），after 通知就会丢。换句话说，**异步链路完整性依赖整条 promise 链不被外力切断**。

### 权衡四：不引入 TC39 Async Context → 换来实现简单、对运行时无强依赖 → 代价是异步 action 在 await 后丢失上下文

setup store 里写：

```ts
async function fetchUser(id) {
  const user = await api.getUser(id)
  this.profile = user      // ← 这条 mutation 发生在 await 之后
  this.lastSeen = Date.now()
}
```

wrappedAction 同步返回链式 Promise 后立即让出执行权，没有"当前正在执行的 action"这种全局栈。`this.profile = user` 触发的 mutation 在 devtools 时间线上**无法被关联回 `fetchUser` 这个 action**——它只是裸的 mutation。

换来的是 Pinia 实现极简、对宿主运行时（浏览器/Node）没有特殊要求，也不依赖尚未普及的 TC39 Async Context 提案。

代价是 devtools 想把"action 内的所有 mutation 归到同一组"必须用全局变量 + Proxy 兜底：用 Proxy 包 store，拦截 set 时检查全局 `runningActionId`，是当前 action 在改 → 标记成同一 groupId。这套兜底有自己的边界（嵌套 action、并发 action 都会出错），等 Async Context 普及才能彻底解决。

> 本章机制集中，只展开这 4 条核心权衡。

## 一个不显然的细节：`this` 兜底

最后点一个容易被忽略的细节。wrappedAction 跑原函数时，有一行判断：

```ts
fn.apply(this && this.$id === $id ? this : store, args)
```

这条 `this` 兜底判断：**只有当传入的 `this` 确实是本 store 时才尊重它，否则一律 fallback 到闭包里的 `store`**。是为了容忍 `const f = store.fetchUser; f(42)` 这种解构裸调——裸调时 `this` 是 `undefined` 或 `window`，action 内部一旦写 `this.profile = user` 就会炸。兜底之后，`this` 不是本 store 就当闭包变量用。

而 setup store 的 action 本来就推荐用闭包（`state.value++`）而不是 `this`，这条兜底是给那些图省事写 `this.xxx` 的 action 留的后路。同时也容忍 `store.action.call(store, ...)` 这种显式 bind——`this.$id === $id` 校验通过就尊重传入的 `this`。

## 小结

`$onAction` 的全部魔法就是一层包装函数：

- **构建期**自动给每个 function 套一层，用 Symbol 防止重复包装
- **运行期**每次调用先广播、再跑原函数、按结局分三种触发回调
- 关键设计是**注册窗口在调用之前、回调触发在调用之后**的时序差

掌握了这套机制，后面写日志中间件、错误监控、运行时埋点、devtools 时间线，都只是往 `$onAction` 里塞一个 listener 的事，不动业务代码。
---
title: History 抽象：URL 模型的可导航可监听接口
---

# History 抽象：URL 模型的可导航可监听接口

> 本章属于 primitive 层。前置：路由位置与 URL 解析。
> 学完你能：用一句话讲清「上层 router 完全不碰 `window.history`，三套底层策略透明可换」是怎么做到的——为什么要在不透明 state 上叠一层方向账本、为什么 hash 能零成本复用 html5、为什么内存栈也能跑同一套路由。

## 1. 为什么需要它（设计动机）

上一章把「一次导航失败」拆成可恢复的位标志，中止、取消、重定向各有各的"形状"。但失败的"主体"（一次导航）从哪里发起、又是怎么被上层 router 感知的，还没人答。这条最底层的口子，正是本章的入口。

想象一下你直接对 `window.history` 编程。`history.state` 是个不透明的单值；`history.length` 只给你栈的总条数，相邻条目读不到；更糟糕的是没有「方向」概念——用户点了后退按钮、代码主动 `push`、还是前进？这三类来源在原生 API 里是同一副面孔。上层路由要驱动守卫、视图、滚动恢复，每一件都得知道这次「是前进还是后退、从哪来、到哪去、上一次滚到哪」。直接用这套底层 API，上层就得反复猜。

矛盾就摆在这：**浏览器的历史 API 状态隐式、无方向、不可信任；上层路由却需要确定的方向/位置/滚动语义**。于是需要一个中间层，把这套低级又不可靠的 API 包成一块「自己重新记账」的深模块——这就是 History 抽象。

## 2. 核心思想

**在不可靠的浏览器历史 API 之上，自己重新记一本带方向与位置序号的账本，对外只露出一个可换实现的窄接口。**

把这句话拆成两层：账本负责「把不透明状态变成可读的方向/位置信息」，窄接口负责「让上层根本不知道底下是 html5、hash 还是 memory」。深模块的灵魂也在这里——接口窄到只剩 `push/replace/go/listen`，实现厚到要塞进整套状态机和兜底。

## 3. 心智模型

接口长这样：五个方法加两个只读 getter。

```text
RouterHistory {
  base, location, state        // 只读 getter
  push(to), replace(to), go(delta)
  listen(cb), createHref(to), destroy()
}
```

上层 router 只拿这套，从不直接碰 `window.history`。

要先划清一条边界：history 吐出的只是「完整路径字符串」（如 `/users?page=2`）。把它 resolve 成结构化路由位置、并判定「是不是同一位置而短路」是上一层的活，已在『路由位置与 URL 解析』讲透——本章只关心这段字符串怎么被产出并附带方向语义。

账本的核心动作是把 `history.state` 那个不透明黑盒「重新规定」成结构化的 `StateEntry`：

```text
StateEntry {
  back, current, forward   // 上一站 / 当前 / 下一站（路径字符串）
  position                 // 栈内绝对序号
  replaced                 // 是不是 replace 来的
  scroll                   // 当前格的滚动位置
}
```

一次 `push('/b')`（从 `/a` 出发）的内部流程：

1. **先补旧格**：把当前 `/a` 那格原地改写——`forward: '/b'`、`scroll: 当前滚动`。
2. **再追加新格**：新条目 `{back: '/a', current: '/b', forward: null, position: 旧+1}`。
3. **当前位置指针指向 `/b`**。

用户点浏览器后退 → 触发 `popstate` 事件 → handler 读出事件里携带的那格 state → 方向 = 新 position − 旧 position → 逐个通知监听者 `(to, from, {type: 'pop', direction, delta})`。

三套实现（html5/hash/memory）共用这套心智模型，差别只在「栈到底由谁记」。

## 4. 关键权衡

### 把方向/位置/滚动塞进不透明 state，换语义可见

浏览器历史 API 的 `state` 字段本意只是给你存任意数据，是个不透明的共享内存。这里做了一个看似霸道的选择：**自己规定它的结构，把 back/current/forward/position/scroll 全塞进去**。

换来的是上层路由能精确知道方向、栈内绝对位置、上次滚动——这三件事原生 API 一件都不直接给。后续的滚动恢复章会拿 position 当 key 保存滚动值，前进/后退不同位置可有不同滚动；重复导航短路也会用同一位置语义。

代价落在两处。其一，那条 state 变成「双方共写的共享内存」：任何外部代码（另一个库、一段遗落的 `history.pushState`）改写它，账本就错乱。其二，**当前位置无法直接读到，只能用「相邻两次 state.position 的差」间接推出来**——popstate 事件里你必须先记住上一格的 position，再做减法。

这条权衡化解的本质矛盾是：**「需要确定的方向/位置语义」与「浏览器只提供单一不透明状态」之间的鸿沟**。通解骨架是「在不可靠底层之上叠一层自管的记账层」——凡是被不可靠底层逼到墙角的场景（比如自管连接池、自管光标位置）都套这条骨架。

### hash 把基准前缀标准化成井号，零成本复用 html5

hash 模式（URL 形如 `example.com/#/users`）乍看是另一套独立实现——毕竟它把整个 path 塞进 hash 段。但这里做了一个偷懒的选择：**`createWebHashHistory` 仅把 base 标准化成「以 `#` 结尾」的形态，然后直接 `return createWebHistory(base)`**。

换来的是零成本复用整套状态机、整套 popstate 监听、整套方向推导。三套策略实际收敛为两份代码。

代价落在 html5 实现内部：它被迫长出两条分支——`createCurrentLocation` 要先判断 URL 里有没有 `#`，有就从 hash 段取 path、没有就从 pathname 取；`changeLocation` 拼 URL 时也要看 base 是不是 `#` 形态来决定要不要前缀 `#`。分支膨胀是这条偷懒的直接账单。

这条权衡化解的本质矛盾是：**「多套底层策略各自独立」与「核心状态机不宜复制粘贴」之间的张力**。通解骨架是「找一层语义透明的归一化点，让差异化下沉到入参预处理」。

### 无 DOM 环境，用数组 + 指针自造一截历史栈

SSR 和测试环境没有 `window.history`，但路由代码最好能原样跑。这里的选择是：**用一个 `queue: [url, state][]` 数组加一个 `position` 指针，自己造一截历史栈**。

换来的是 SSR 与测试环境无浏览器也能跑同一套路由，三实现同构。组件可以在 Node 里被正确地「装作在 /users 页」渲染。

代价是这一截栈是内存里的幻象：刷新即丢（状态不进 URL）、起点必须由用户显式设置（不像浏览器至少有当前 URL）、移动指针不产生真正的 URL 副作用（地址栏不变）。所以 SSR 渲染完会把 `queue[0]` 当首屏位置、客户端 hydrate 时再换回真历史。

这条权衡化解的本质矛盾是：**「上层路由希望同构运行」与「目标环境没有浏览器历史 API」之间的落差**。通解骨架是「把环境 API 抽象成接口、用内存数据结构兜住缺失环境」。

### 监听回调统一吐「类型 + 方向 + 步数差」三元组

原生 API 让你区分不出事件来源——浏览器前进后退按钮、代码主动 `pushState`、代码 `go(-1)` 跳转，三者在 popstate 里都长一个样。这里做了一个统一的选择：**所有监听者只注册一个回调，回调签名固定为 `(to, from, {type, direction, delta})` 三元组**。

换来的是上层只挂一个回调即可同时响应三类来源；`info.delta` 还能直接当滚动 key 用（同一 URL 在栈不同位置可有不同滚动）。

代价是 HTML5 实现内部变微妙：popstate 触发时，handler 必须用 `state.position − fromState.position` 反推方向，还得用一个 `pauseState` 标记吞掉「自己主动 `go` 触发的回声事件」——不然你 `go(-1)` 会先收到一次自己造成的 popstate，造成回路。状态机的隐式约定变多，新人读源码容易卡在「这里为什么 return」。

这条权衡化解的本质矛盾是：**「事件来源多样」与「上层希望一个回调搞定一切」之间的张力**。通解骨架是「在底层把异质来源归一化成统一事件信封，代价是底层状态机要承担归一化的复杂度」。

## 5. 最小原理演示

下面这段 TS 演透两件事：窄接口能跑通上层逻辑；两套实现（内存栈 / 浏览器账本）共享同一接口，可透明替换。工程上故意省略的东西见 §7。

```ts
// --- 窄接口：所有实现只暴露这套 ---
interface NavigationInfo {
  type: 'pop' | 'push'
  direction: 'back' | 'forward' | 'unknown'
  delta: number
}
type NavigationCallback = (to: string, from: string, info: NavigationInfo) => void

interface RouterHistory {
  readonly location: string
  push(to: string): void
  replace(to: string): void
  go(delta: number): void
  listen(cb: NavigationCallback): () => void
}

// --- 内存实现：数组 + 指针自造一截栈 ---
function createMemoryHistory(): RouterHistory {
  let queue: [string, any][] = [['', {}]]  // 空串 = START 哨兵（与前置章 START_LOCATION 同构）
  let position = 0
  const listeners = new Set<NavigationCallback>()

  return {
    get location() { return queue[position][0] },
    push(to) {
      position++
      // 中途导航要截断「前进」条目，忠实模拟浏览器行为
      if (position < queue.length) queue.splice(position)
      queue[position] = [to, { position }]
    },
    replace(to) { queue[position] = [to, { position }] },
    go(delta) {
      const next = Math.max(0, Math.min(queue.length - 1, position + delta))
      if (next === position) return
      const from = queue[position][0]
      position = next
      // 方向由步数差正负推出；监听者拿到的是统一信封
      const direction = delta < 0 ? 'back' : 'forward'
      listeners.forEach(cb =>
        cb(queue[position][0], from, { type: 'pop', direction, delta }))
    },
    listen(cb) { listeners.add(cb); return () => listeners.delete(cb) },
  }
}

// --- 浏览器实现：在不透明 state 上叠一层方向账本 ---
interface StateEntry {
  back: string | null
  current: string
  forward: string | null
  position: number
  scroll: [number, number] | null
}

function createWebHistory(): RouterHistory {
  const listeners = new Set<NavigationCallback>()
  // 首次访问时 history.state 是 null，主动补建一条
  let current: StateEntry = history.state ?? {
    back: null, current: location.pathname, forward: null,
    position: history.length - 1, scroll: null,
  }
  if (!history.state) history.replaceState(current, '')

  window.addEventListener('popstate', (e) => {
    const incoming = e.state as StateEntry
    const from = current.current
    // 当前位置无法直接读 —— 只能用两次 position 的差间接推
    const delta = incoming.position - current.position
    const direction = delta < 0 ? 'back' : delta > 0 ? 'forward' : 'unknown'
    current = incoming
    listeners.forEach(cb =>
      cb(incoming.current, from, { type: 'pop', direction, delta }))
  })

  return {
    get location() { return current.current },
    push(to) {
      // 两段式：先给旧格补 forward + scroll，再追加新格
      current.forward = to
      current.scroll = [scrollX, scrollY]
      history.replaceState(current, '')
      const next: StateEntry = {
        back: current.current, current: to, forward: null,
        position: current.position + 1, scroll: null,
      }
      history.pushState(next, '', to)
      current = next
    },
    replace(to) {
      current = { ...current, current: to }
      history.replaceState(current, '', to)
    },
    go(delta) { history.go(delta) },
    listen(cb) { listeners.add(cb); return () => listeners.delete(cb) },
  }
}

// --- 上层完全不感知底下是哪一套 ---
function useRouter(h: RouterHistory) {
  h.listen((to, from, info) =>
    console.log(`${from} → ${to} [${info.direction}/${info.delta}]`))
}
useRouter(createMemoryHistory())
useRouter(createWebHistory())
```

两份实现、共用同一接口；上层 `useRouter` 拿到时不知道、也不需要知道底下是谁。

## 6. 执行轨迹

输入：用户在 `/a` 调 `push('/b')`，然后按浏览器后退。初始 `current = {back:null, current:'/a', forward:null, position:5, scroll:null}`。

`push('/b')` 阶段：

1. 把当前格改写成 `{back:null, current:'/a', forward:'/b', position:5, scroll:{0,200}}`，调 `replaceState` 落进 `history.state`。
2. 造新格 `{back:'/a', current:'/b', forward:null, position:6, scroll:null}`，调 `pushState('/b', newState)` 压进栈。
3. `current` 指向新格，地址栏变 `/b`。

按后退阶段：

1. 浏览器触发 `popstate`，`event.state` = 旧 `/a` 格 `{position:5}`。
2. handler 算 `delta = 5 − 6 = -1`，方向 `back`。
3. 广播 `listeners.forEach(cb => cb('/a', '/b', {type:'pop', direction:'back', delta:-1}))`。
4. 上层 router 收到回调：用 `'/b' + (-1)` 当 key 取回 `{0,200}`（这是上次离开 /a 时的滚动），恢复滚动后再导航到 /a。

整条链路里，上层只看到「一次导航事件附带方向与步数差」，它从不知道 `history.state` 长什么样。

## 7. 教学简化说明

本章演示故意省略了：

- **`pauseState` 吞回声**：演示里 `go(delta)` 直接调 `history.go`，真源码要先记 `pauseState = from`，popstate 里若 `pauseState === from` 就 return，吞掉自己主动 `go` 触发的那次回声。
- **滚动持久化的生命周期**：真源码挂 `pagehide`/`visibilitychange`（iOS Safari 不触发 `beforeunload`），在 `visibilityState === 'hidden'` 时把滚动 `replaceState` 进 state。本章只演「push 时把滚动塞进旧格」，没演「页面隐藏时再补一次」。
- **`pushState` 的 Safari 兜底**：30 秒内调用 100 次会抛 `SecurityError`，真源码 try/catch 后退化成 `location.assign(url)` 强制导航重置计数。
- **`<base>` 标签与 file:// 的基准归一化**、**`createHref` 的井号正则**、**结构化克隆的类型限制**（state 不能含 Symbol/函数）——这些是工程兜底，不影响原理主线。

## 8. 小结

把不透明的浏览器历史 API 关在窄接口背后、自己在它上面记一本带方向与位置的账，这是上层 router 能拥有「确定的方向/位置/滚动语义」的根。html5/hash/memory 三实现只是同一本账的三种存法：真栈、含井号的真栈、内存幻象。下一章会把视野从「单条 URL 怎么来」抬到「一整张路由表怎么搭」——当历史抽象把 URL 吐给上层后，下一步要回答的就是「这张表是怎么从配置编译成可匹配结构的」。

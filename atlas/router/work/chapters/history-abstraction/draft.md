# History 抽象：URL 模型的可导航可监听接口

路由器要驱动「守卫 → 视图 → 滚动恢复」这一整套流程，得先回答四个问题：这次是前进还是后退？从哪来？到哪去？上一次滚到哪了？可偏偏这四个问题的答案，浏览器一个都不直接告诉你。

## 浏览器自带的那套历史接口，为什么不能直接用

想象你站在路由器的位置，伸手去摸 `window.history`。你会摸到这么几样东西：

- `history.state` —— 一个不透明的黑盒，你往里塞什么它就存什么，但它**自己没有任何结构**。它不会告诉你「上一站是哪」「下一站是哪」。
- `history.length` —— 一个整数，但它是**栈里条目的总数**，不是「我现在站在第几格」。你退后了三步，这个数可能一个字都不变。
- `history.back()` / `forward()` / `go()` —— 能移动指针，但移动完**不告诉你往哪个方向移了、移了几格**。
- 相邻的两条历史记录，**根本读不出来**。

说人话就是：浏览器把整段浏览历史藏在一条你看不见、摸不着的栈里，只给你一个能往前挪往后挪的摇杆，连「我现在在第几层」都不报数。路由器要是直接用这套接口，上层代码就得不停地猜：刚才那个 popstate 是前进还是后退？滚动能恢复吗？我是不是已经在这个位置了？

于是需要一块中间层：**在浏览器这套靠不住的接口之上，自己重新记一本带「方向」和「位置序号」的账本**，对外只露一个窄窄的、可以换底层实现的接口。这就是本章要讲的东西。

## 一块谁都能看见的窄接口

先看最底下那块基本件——上层路由器一辈子只会打交道的东西，就这一份契约：

```ts
type HistoryLocation = string          // 一段完整路径，如 "/users/42?q=1#top"
enum NavType { pop = 'pop' }           // 导航类型：外部触发的位置变化
enum NavDir { back = 'back', forward = 'forward', unknown = '' }
interface NavInfo { type: NavType; direction: NavDir; delta: number }
type Listener = (to: HistoryLocation, from: HistoryLocation, info: NavInfo) => void

interface RouterHistory {
  readonly location: HistoryLocation   // 当前在哪（只读）
  readonly state: any                  // 当前这格附带的账本数据（只读）
  push(to: HistoryLocation): void      // 往前推一格
  replace(to: HistoryLocation): void   // 改写当前格
  go(delta: number, triggerListeners?: boolean): void  // 前进/后退 N 格
  listen(cb: Listener): () => void     // 注册一个监听器，返回注销函数
}
```

注意一个关键设计：`location` 和 `state` 是**只读的 getter**，外部只能读、不能赋值。上层想改位置？只能通过 `push` / `replace` / `go`。这样一来，**位置怎么存、存哪儿、序号怎么算，全是这块中间层的私事**，上层一概不碰。这就是把变化关进门里的「深模块」——门面很窄（六个方法加两个 getter），但门后藏着整本账本和三套可以互换的底层策略。

至于 `location` 那段路径字符串，router 拿到之后怎么把它拆成 path / query / hash、又怎么用 matched 链判断「是不是同一个地方」从而短路重复导航——那是上一章「路由位置与 URL 解析」已经讲透的事，本章只管**这段字符串是怎么被生产出来、还顺手附带了「方向」**。

## 监听契约：一个回调吃下所有「外部来的变化」

上面那份接口里最值得单独拎出来说的，是 `listen` 的回调签名 `(to, from, info)`。第三个参数 `info` 是个三元组：**类型 + 方向 + 步数差**。

为什么是这个形状？因为位置变化可能从好几个口子进来：用户点浏览器的后退按钮、用户点前进按钮、代码里调了 `go(-2)`。这些来源在上层看来根本不该分门别类去处理——它们都是「位置变了，我得跟着更新视图」。所以中间层把它们**统一翻译成同一个三元组**：往后退了几格、往前进了几格，一清二楚。

需要点透一个细节：`push` 和 `replace` 是路由器**自己发起**的，它本来就知道发生了什么（push 就是前进），所以这俩**不会**触发监听器。监听器只为「不是路由器自己发起的变化」准备——主要是用户戳浏览器后退/前进按钮。这么一讲你就明白了，监听器吐的 `type` 永远是 `pop`，它存在的全部意义，就是把「外部来的、方向不明的位置跳变」翻译成路由器能直接用的「方向 + 步数」。

## 内存实现：自己造一截历史栈

现在动手写第一个实现。最干净、最能跑通的是「内存版」——用一个数组当历史栈，一个指针当当前位置：

```ts
const START = ''                        // 空串 = 「还没有位置」的栈底哨兵
function createMemoryHistory(): RouterHistory {
  const listeners: Listener[] = []
  const queue: [HistoryLocation, any][] = [[START, {}]]   // 栈：每格 [路径, 账本]
  let position = 0                       // 指针：现在站在第几格

  const setLocation = (to: HistoryLocation) => {
    position++
    if (position !== queue.length) queue.splice(position) // 中途导航：丢掉所有「前进」格
    queue.push([to, {}])
  }

  return {
    get location() { return queue[position][0] },
    get state()    { return queue[position][1] },
    push: setLocation,
    replace(to) { queue.splice(position, 1); position--; setLocation(to) },
    go(delta, shouldTrigger = true) {
      const from = queue[position][0]
      const direction = delta < 0 ? NavDir.back : NavDir.forward   // 步数差正负 → 方向
      position = Math.max(0, Math.min(position + delta, queue.length - 1)) // 钳在栈内
      if (shouldTrigger)
        listeners.forEach(cb => cb(queue[position][0], from, { type: NavType.pop, direction, delta }))
    },
    listen(cb) { listeners.push(cb); return () => listeners.splice(listeners.indexOf(cb), 1) },
  }
}
```

这段代码演透了三件事：

第一，**栈底那一格是 `START = ''`**。这个空串哨兵跟上一章的 `START_LOCATION` 是一回事，都表示「还没有位置」；那章讲过它对首次导航的意义，这里只看它在历史栈里充当「栈底」的角色——队列一初始化就 `[ [START, {}] ]`，指针指在 0，谁都还没去过任何地方。

第二，**中途导航会截断前进条目**。`setLocation` 里那句 `if (position !== queue.length) queue.splice(position)` 是在忠实模仿浏览器：你退到 `/b`，又 `push('/d')`，那么原来 `/c` 那条「前进历史」就该作废——你不可能既从 `/b` 往前推到 `/d`，又保留一条通往 `/c` 的路。浏览器这么做，内存版也得这么做，否则两边的语义就对不齐。

第三，**方向直接由步数差的正负推出来**。`go(-1)` 就是后退，`go(2)` 就是前进，内存版指针自己挪，方向明明白白。这也是内存版比浏览器版省心的地方——它不需要去猜方向。

## 浏览器实现：在不透明状态上重记一本账

内存版好是好，但它没真 URL，刷新就丢。真正要驱动 SPA 的是浏览器版，而它面对的是开头那套「靠不住的接口」。怎么办？**在 `history.state` 这个不透明黑盒之上，盖一层自己说了算的账本**：

```ts
interface StateEntry {                  // 这就是那本「方向账本」
  back: HistoryLocation | null          // 上一站
  current: HistoryLocation              // 当前
  forward: HistoryLocation | null       // 下一站
  position: number                      // 栈内绝对序号
  scroll: [number, number] | null       // 离开这格时的滚动位置
}

function createWebHistory(win: FakeBrowser): RouterHistory {
  const listeners: Listener[] = []
  let current = '/a'
  let ledger: StateEntry | null = win.state   // 自己的账本容器，记住「上一格的账」

  const write = (to: HistoryLocation, s: StateEntry, replace: boolean) =>
    replace ? win.replaceState(s, '', to) : win.pushState(s, '', to)

  function push(to: HistoryLocation) {
    const cur = ledger!
    // ① 先给「当前这一格」补上「下一站 = to」和「当前滚动」，原地改写它
    write(cur.current, { ...cur, forward: to, scroll: [0, 200] }, true)
    // ② 再追加一格新条目，序号 +1
    const next: StateEntry = { back: current, current: to, forward: null, position: cur.position + 1, scroll: null }
    write(to, next, false)
    ledger = next; current = to
  }
  // 页面全新打开时 state 是空的，主动补一条当前格
  if (!ledger) { ledger = { back: null, current, forward: null, position: win.length - 1, scroll: null }; write(current, ledger, true) }

  win.addEventListener('popstate', ({ state }: { state: StateEntry }) => {
    const from = current, oldLedger = ledger
    current = state.current; ledger = state
    const delta = oldLedger ? state.position - oldLedger.position : 0  // 方向 = 新序号 − 旧序号
    const direction = delta > 0 ? NavDir.forward : delta < 0 ? NavDir.back : NavDir.unknown
    listeners.forEach(cb => cb(state.current, from, { type: NavType.pop, direction, delta }))
  })

  return {
    get location() { return current }, get state() { return ledger },
    push,
    replace: (to) => { ledger = { ...ledger!, current: to }; write(to, ledger, true); current = to },
    go: (d) => win.go(d),
    listen(cb) { listeners.push(cb); return () => listeners.splice(listeners.indexOf(cb), 1) },
  }
}
```

（上面的 `FakeBrowser` 是一个极简的浏览器历史 mock，模拟 `pushState`/`replaceState`/`popstate`，好让这段账本逻辑能真跑起来；真实环境直接把 `window` 传进去即可。）

这段代码的灵魂，是 `push` 那个**两段式改写**。跟着一个具体轨迹走一遍最清楚：

假设你站在 `/a`（账本记着序号 5），调 `push('/b')`：

1. **第一步，改写当前格**：把 `/a` 这格的账本改成 `{ current: '/a', forward: '/b', scroll: [0, 200], position: 5 }`，用 `replaceState` 写回去。这一步干了俩事——记下「从 `/a` 出发会去 `/b`」，顺手把**离开 `/a` 时的滚动位置**（比如滚到了 200px）存进这格。滚动为什么要存在这儿？因为滚动是「属于某个位置的」属性，离开时存，回来时取。
2. **第二步，追加新格**：写入一格 `{ back: '/a', current: '/b', forward: null, position: 6, scroll: null }`，用 `pushState`。序号是上一格的 `position + 1`，自己维护，**不信任 `history.length`**。

现在栈里是这样：`… → /a(序号5, 下一站/b, 滚动{0,200}) → /b(序号6) ← 指针`。

接着用户**按浏览器后退按钮**。浏览器触发 `popstate`，事件把目标格的 state 带回来——也就是 `/a` 那格 `{ position: 5 }`。监听器里：

- `delta = 新序号 − 旧序号 = 5 − 6 = −1`，方向是 **后退**。
- 广播 `('/a', '/b', { pop, back, −1 })` 给上层。

上层路由器拿到这个三元组，立刻知道两件事：用户后退了一步、从 `/b` 退回了 `/a`。它还能拿「`/b` 的路径 + 步数差」当钥匙，去翻出刚存进去的 `{0, 200}`，把滚动恢复出来——这就是为什么滚动值非得塞进账本里：**没有这本账，滚动恢复根本无从下手**。

这就是全章最核心的那个选择带来的连锁好处：**自己往那条不透明状态里塞方向、塞序号、塞滚动，才能在浏览器后退时算出方向、找回滚动、识别重复**。代价也很实在——那条 `history.state` 从此变成了「双方都在写」的共享内存，只要外面有人手贱自己调一次 `history.replaceState`，这本账就乱了；而且「我现在在第几格」永远只能靠相邻两格的序号差间接推出来，浏览器不直接给。

`replace` 跟 `push` 形成对照：它只改 `current`，**把 `position` 钉回原值**（不 +1），所以替换不会让栈长长，也不会破坏前后格的序号连续性。

## hash：只改一个基准，就白嫖整套逻辑

最后看一个「省事省到极致」的设计。hash 模式（URL 里带个 `#`）和 HTML5 模式，表面上是两套路由，但实现上 hash 版**几乎什么都没写**——它只把基准路径规整成「以 `#` 结尾」的形态，然后直接调 `createWebHistory`：

```ts
function createWebHashHistory(base?: string): RouterHistory {
  base = location.host ? base || location.pathname + location.search : ''  // file:// 没 host，基准置空
  if (!base.includes('#')) base += '#'                                     // 强制成「以 # 收尾」
  return createWebHistory(base)                                            // 其余完全复用
}
```

就这么几行。账本、两段式 push、popstate 监听、方向推导——一整套状态机原封不动复用。换来的是「三套策略收敛成两份代码」，hash 模式零成本拿到 HTML5 模式的全部能力。

代价呢？代价被转嫁到了 HTML5 实现内部：因为它现在要同时服务「普通基准」和「含 `#` 的基准」两种用法，所以 `createCurrentLocation`（从地址栏还原当前路径）和 `changeLocation`（拼出要写进地址栏的 URL）里都不得不长出**两条分支**——遇到 `#` 基准走一套切片逻辑，遇到普通基准走另一套。换句话说，省事是省在 hash 这一头，分支膨胀却长在了 html5 那一头。这是一个很典型的「把复杂度从一个地方挪到另一个地方」的取舍：对外接口更干净了（hash 是独立工厂），对内实现却多了一层 if。

## 关键权衡

把本章的设计选择摊开来看，下面这几条是真正值得记住的「为什么」。

**权衡一（全章灵魂）：自己往那条不透明状态里塞方向/序号/滚动，重新记一本账。** 浏览器的 `history.state` 是个无结构的黑盒，`history.length` 是总数不是位置，popstate 事件也不带方向。路由器若直接面对这套接口，连「刚才用户是前进还是后退」都答不上来。选择自己往 state 里塞 `{ back, current, forward, position, scroll }`，换来的是：能精确算出方向（序号差）、能识别绝对位置、能存取滚动位置——这三样是滚动恢复和重复导航短路的命根子。代价是：那条 state 变成了路由器和浏览器双方共写的共享内存，外部一旦自行 `replaceState` 就会让账本错乱；而且「当前位置」只能用相邻两格的序号差间接推，不能直接读。这是一笔用「可靠性」换「语义完整性」的账。

**权衡二：hash 模式不另写一套，只把基准规整成 `#` 形态就复用 HTML5 实现。** 这个选择换来的是「零成本复用整套状态机与监听器，三套策略收敛为两份代码」——hash 工厂只有寥寥几行，维护负担极低。代价是 HTML5 实现被迫在「含 `#` 的基准」与「普通基准」之间长出两条分支，`createCurrentLocation` 和 `changeLocation` 都多了 if，实现内部变臃肿。本质上是把对外接口的简洁，换成了对内实现的分支膨胀。

**权衡三：无 DOM 环境用一个数组 + 指针自造一截历史栈。** SSR 和测试环境根本没有浏览器，但路由逻辑得照样跑。选择用 `queue + position` 在内存里模拟一截历史栈，换来的是「SSR、测试、浏览器三套实现同构」，上层代码一行不改就能在 Node 里跑。代价是：内存栈刷新即丢（没有真 URL）、起点必须由用户显式 `push`/`replace` 设置、移动指针也不产生真正的 URL 副作用。它是个忠实但不完整的影子——忠实到连「中途导航截断前进条目」都模仿了，但不完整到没法持久化。

**权衡四：监听回调统一吐「类型 + 方向 + 步数差」三元组。** 位置变化可能来自浏览器后退按钮、前进按钮、代码 `go` 调用，来源杂、细节多。选择把所有「外部触发的位置变化」统一翻译成 `{ type: pop, direction, delta }`，换来的是「上层只注册一个回调，就能用同一套逻辑响应所有来源」，不用为每个来源写专用处理。代价是：浏览器版实现必须在 popstate 里用序号差反推方向（而不是直接拿到），还得额外维护一个「暂停位」去吞掉那些自己触发、却不想广播的回声事件——状态机因此变得更微妙。

## 小结

这一层做的事，说到底就是：**在浏览器那套靠不住的历史接口之上，重新记一本带方向和位置序号的账**，再把它包成一个窄到只有六个方法的接口。账本让方向、位置、滚动都变得可推算；窄接口让上层完全不碰 DOM；三套实现（HTML5 / hash / memory）共用同一份契约，可以透明互换。hash 模式更是把「复用」做到了极致——只改一个基准形态，就白嫖了 HTML5 的整套状态机。

这套抽象吐出的，始终只是一段路径字符串外加一个方向。至于这段字符串怎么在一张路由表里被编译、匹配成一条 matched 链——那是下一章「路由匹配表：从配置到 matched 链」的主题。
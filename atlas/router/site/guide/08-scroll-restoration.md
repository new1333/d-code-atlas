# 滚动位置恢复

## 一个让人牙痒的场景

你在商品列表页往下翻了三屏，滚到第 800 像素，点进一个商品看详情。看完按浏览器后退，本以为页面会停回你刚才看的那一行——结果它"啪"地跳回顶部，你得重新翻。

传统多页网站基本不会有这个毛病：浏览器自己记得每个历史条目的滚动位置，后退时自动还原。但到了单页应用，DOM 是同一套、页面根本没刷新，浏览器的原生记忆要么对不上号、要么干脆失效。所以这件事得由路由框架自己接管。

Vue Router 的接管方式是提供一个新选项 `scrollBehavior`：你写一个函数，告诉它"导航到新页面后该滚到哪"。听着只是"滚一下"这么简单，可真要把它做对——尤其处理后退/前进时的位置还原——里面藏着三个不那么显然的设计。这一章就拆这三个设计。

## 先认识它的两个基本件

一个滚动位置，说穿了就是两个数：`{ left, top }`，外加一个可选的 `behavior`（要不要平滑滚动）。框架对外还允许你返回"滚到某个元素" `{ el: '#xx' }`，但内部都会换算成坐标。换句话说，无论你说"滚到 800 像素"还是"滚到 #title 这个元素"，最后都变成两个数。

这些位置存在哪？一张进程内的 `Map`，`Map<key, 坐标>`。它只在内存里活着，刷新页面就没了。所以它服务的场景很明确：同一次会话、不刷新的前提下，记住你滚到过哪。这两个基本件都很平凡，真正有意思的是那个 `key`。

## 为什么不能拿地址当存档槽

最直觉的做法：拿 URL 当 key。`/list` 滚到 800，就存 `/list → 800`；回到 `/list` 时取出来还原。但这里有个坑，历史栈常常长这样：

```
位置1: /home
位置2: /list    ← 滚到 800
位置3: /detail
位置4: /list    ← 又滚到 300
```

同一个 `/list` 在栈里出现了两次，一次滚到 800、一次滚到 300。如果你只用地址当 key，第二次的 300 会把第一次的 800 盖掉；等你后退回位置 2 的 `/list`，取出来的是 300——错了。

所以光有地址不够，还得带上"这是栈里的哪一槽"。key 真正的形态是 `栈位置 + 地址`：`2:/list` 和 `4:/list` 是两份互不干扰的存档。

> 类比一下：这就像寄存柜。你不止认包的名字（地址），还得认它寄存在第几号柜（栈位置）。同一个包名可以进多个柜子，互不覆盖。

"栈位置"这个概念不是本章发明的。前一章（History 抽象）已经在浏览器那个不太靠谱的 history 之上，给每次压栈记了一个递增的 `position`，并在 popstate 时算出"这步跨了几个槽"（步长 `delta`）。那章讲的是**为什么需要 position、它怎么补上方向语义**——这里我们直接拿这个 `position` 来当 key 的第一个维度，不重复展开。地址那段字符串（`/list` 这种 `fullPath`）则来自更前面的"路由位置与 URL 解析"那一章建立的字符串化语义，本章也只取它当 key 的第二段。

## 这把 key 怎么算出来：枢纽在这里

key 的公式看着就一行：

```ts
function getScrollKey(path: string, delta: number): string {
  const position = history.state ? history.state.position - delta : -1
  return position + path
}
```

`position + path` 好懂，拼字符串。难懂的是 `position - delta` 这一步——为什么不直接用 `position`，要减一个 `delta`？

答案藏在一个时序细节里：**popstate 触发的时候，浏览器的 history 状态已经翻到目标页了**。也就是说，这行代码此刻读到的 `history.state.position` 是"目标栈位置"，不是"来源栈位置"。

- 保存的时候，你要存的是"来源页"的滚动。来源页在目标页的 `delta` 步之外，所以 `目标position - delta` 才反推回来源槽。调用方传的是 `(from.fullPath, delta)`。
- 恢复的时候，你要取的是"目标页"的存档。目标就在当前位置，`delta` 传 0，`position - 0` 直接就是目标槽。调用方传的是 `(to.fullPath, 0)`。

两条路径，一个减 delta、一个不减，恰好对齐到同一把 key 上——存的时候写 `2:/list`，取的时候读 `2:/list`，天衣无缝。这就是整个机制最巧妙的地方。

## 存与取，绑死在导航的特定时刻

key 解决了"存哪、取哪"。接下来是"什么时候存、什么时候取"。整个时序是一条单向流水线：

```
popstate 响应
  → 抢存来源页滚动（减 delta 反推来源槽）
  → 跑守卫管线（可能异步、可能被取消/重定向）
  → 切「当前路由快照」到目标页
  → 取目标槽存档（读后即删，取不到降级用兜底）
  → 等下一帧渲染
  → 校验「这次导航仍是当前导航」
  → 真正滚动
```

**第一步，关掉浏览器的原生恢复。** 只要你提供了 `scrollBehavior`，框架就把 `history.scrollRestoration` 设成 `'manual'`，宣告"这件事我来管，你别插手"，免得两套机制打架。

**第二步，后退/前进时，抢在导航真正开始之前存。** 用户按后退，popstate 一响，框架在跑任何守卫、任何异步逻辑之前，先把来源页当前能看到的滚动位置抓下来存好：

```ts
// 在 pop 监听里、navigate 之前
saveScrollPosition(
  getScrollKey(from.fullPath, info.delta),  // 反推来源槽
  computeScrollPosition()                    // 当前可见的滚动
)
```

为什么要这么急？因为一旦进入守卫管线，导航可能被异步守卫卡住、可能被取消、可能被重定向。等那些都走完，页面可能早就不是来源页了，那时候再想抓"来源页滚到哪了"已经抓不准了。所以一进门就先抢存。

**第三步，导航确认后取出来用，而且读完就删。** 等守卫都通过、当前路由快照切到目标页之后，进入 `handleScroll`：取目标槽的存档，取不到就降级用一份历史栈状态里的兜底位置，都没有就给策略函数传 `null`。取的时候是"读后即删"：

```ts
function getSavedScrollPosition(key) {
  const scroll = scrollPositions.get(key)
  scrollPositions.delete(key)  // 取出即消费，不留到下次
  return scroll
}
```

为什么删？因为这份存档只对"这一次"回到目标页有意义。你已经在目标页了，存档用完就该作废。要是不删，下次再撞上同名 key，会取出一份"上上次的旧位置"，而那时页面早就不是当初那个样子了，滚过去只会错位。

**第四步，等下一帧渲染，并且再次确认导航没过期。** 拿到候选位置后不是立刻滚，而是：

```ts
return nextTick()                                   // 等视图渲染出新路由
  .then(() => scrollBehavior(to, from, position))   // 让用户策略算最终位置
  .then(pos =>
    to === currentRoute.value && pos && scrollToPosition(pos)  // 再确认一次
  )
```

两个保险叠在一起：`nextTick()` 是等新路由的 DOM 真正渲染出来（不然你滚到的元素还没出现，或被随后的渲染顶回原位）；`to === currentRoute.value` 是确认"算这个位置时所依据的那次导航，到现在还是当前导航"——如果中间用户又点了一次导航，`currentRoute` 已经变了，这行条件不成立，旧位置就不会被错误地滚到新页上。

## 关键权衡

这一节是本章真正的交付：把上面那些"为什么这么做"提炼成可复述的取舍。本章机制集中在这几处，逐一展开。

**权衡一：用"当前栈位置 − 步长"反推被影响的那一个槽，而不是直接拿当前栈位置当 key。**
- **换来**：保存和恢复用的是同一把 key。保存时（pop 已发生、历史栈状态已是目标）用 `目标position - delta` 反推出来源槽；恢复时用 `目标position - 0` 直取目标槽，两侧天然对齐。
- **代价**：这把 key 的含义很不直观。你必须先理解"popstate 发生时历史栈状态已经是目标态"这个时序细节，否则完全看不懂为什么保存要减 delta、恢复却传 0。它是用"理解成本"换"存取对称"。

**权衡二：滚动恢复放在下一个渲染周期之后，并且应用前再次校验"这次导航的目标是否仍是当前路由"。**
- **换来**：连点导航时，为旧路由算出的滚动绝不会误投到新路由；顺带等视图把新路由的 DOM 渲染出来再滚，避免滚到还没出现的元素。
- **代价**：滚动有大约一帧的延迟，而且用户的 `scrollBehavior` 必须返回一个能解析的位置（返回假值就等于"这次不滚"）。是用"一帧延迟 + 策略函数的返回约束"换"不串页"的健壮性。

**权衡三：滚动位置在导航真正开始之前就抢存，取出时"读后即删"。**
- **换来**：即便后续守卫异步中止或重定向，真实滚动位置也已被先一步抓到；同一份存档不会被重复消费（页面早已变样）。两个保证一次到手。
- **代价**：存档只活在内存里，刷新就没了。要在刷新后还能粗略恢复，得另设一道"页面即将隐藏时把滚动塞进历史栈状态"的兜底（那属于 history 实现层，这里不展开）。是用"刷新不持久"换"异步安全 + 不重复消费"。

## 最小演示：把三件套跑给你看

下面这段只演示三件事：**栈位置 key 的对称反推、读后即删、导航未过期校验**。它故意省略了元素选择器解析、真实 `scrollTo`、刷新兜底这些枝节，只留原理骨架。

```ts
// 最小滚动恢复：只演「栈位置 key + 读后即删 + 导航未过期校验」三件套

type ScrollBehavior = (
  to: string,
  from: string,
  saved: number | null
) => number | null

// 进程内内存表：key = "position:path" → scrollY
const scrollPositions = new Map<string, number>()

// 模拟「当前历史栈状态」——popstate 后它已是目标态（对应 history.state.position）
let currentPosition = 0
// 模拟「当前路由快照」——只有它才是视图真实显示的路由（对应 currentRoute.value）
let currentRoute = ''

// —— 三件套之一：栈位置 key（枢纽）——
// currentPosition 此刻是「目标栈位置」：保存时减 delta 反推来源槽，恢复时 delta=0 直取目标槽
function getScrollKey(path: string, delta: number): string {
  return `${currentPosition - delta}:${path}`
}

// —— 三件套之二：读后即删 ——
function save(key: string, y: number) {
  scrollPositions.set(key, y)
}
function take(key: string): number | null {
  const v = scrollPositions.get(key)
  scrollPositions.delete(key) // 取出即消费，不留给下一次
  return v ?? null
}

function scrollTo(y: number) {
  console.log(`    scrollTo(${y})`)
}

// 用户策略：有存档就原样还，没存档滚到顶
const behavior: ScrollBehavior = (_to, _from, saved) =>
  saved != null ? saved : 0

// 模拟一次 pop 导航：popstate 已发生，currentPosition 已翻到目标
function pop(to: string, from: string, delta: number, fromScroll: number) {
  // 1) 导航真正开始之前，抢存「来源页」当前的滚动
  const fromKey = getScrollKey(from, delta) // 目标槽 - delta = 来源槽
  save(fromKey, fromScroll)
  console.log(`  存: key="${fromKey}" → ${fromScroll}`)

  // 2) 导航确认，切当前路由快照
  currentRoute = to

  // 3) 取目标槽（delta = 0），读后即删
  const toKey = getScrollKey(to, 0)
  const saved = take(toKey)
  console.log(`  取: key="${toKey}" → ${saved}`)

  // 4) 等渲染 + 校验「导航未过期」再真正滚
  return Promise.resolve()
    .then(() => behavior(to, from, saved))
    .then(pos => {
      if (to === currentRoute && pos != null) {
        console.log(`  校验通过：${to} 仍是当前路由`)
        scrollTo(pos)
      } else {
        console.log(`  校验拦截：${to} 已不是当前路由，丢弃滚动`)
      }
    })
}

// ========== 执行轨迹：后退再前进，看存取对称 ==========
;(async () => {
  // 起点：/list（栈位置 2）滚到 800
  currentPosition = 2
  currentRoute = '/list'

  console.log('① 按后退 /list(2) → /home(1)，步长 -1')
  currentPosition = 1 // popstate 已把状态翻到目标
  await pop('/home', '/list', -1, 800)
  // 存 "1-(-1)=2:/list" → 800；取 "1:/home" → null（首次，无存档）

  console.log('② 按前进 /home(1) → /list(2)，步长 +1')
  currentPosition = 2
  await pop('/list', '/home', +1, 0)
  // 存 "2-1=1:/home" → 0；取 "2:/list" → 800  ← 与 ① 写入的是同一把 key！

  // —— 三件套之三：连点导航，看「未过期校验」拦截 ——
  console.log('③ 连点导航：为 /list 算位置的同时，又被导航到 /detail')
  currentPosition = 3
  // 开始一次到 /list 的导航，但不 await，让它悬着
  const stale = pop('/list', '/home', 0, 0)
  // 在它的滚动落地之前，更新的导航把当前路由改成了 /detail
  currentRoute = '/detail'
  await stale // 旧导航算出的滚动会被校验拦截，不会误投到 /detail
})()
```

跑起来你会看到：第 ② 步取出的正是第 ① 步存进去的 800——因为两次的 key 都是 `2:/list`，存取对称了；第 ③ 步里，为旧导航 `/list` 算出的滚动，因为 `currentRoute` 已经变成 `/detail`，被 `to === currentRoute` 拦下，没有错误地滚过去（若没有这道校验，那次滚动就会"串"到 `/detail` 页面上）。

配一个最小 `package.json`，装上 `tsx` 就能直接 `node`/`bun` 跑：

```json
{
  "name": "scroll-restoration-demo",
  "private": true,
  "scripts": { "demo": "tsx demo.ts" },
  "devDependencies": { "tsx": "^4.0.0" }
}
```

## 小结

滚动恢复这件事，难点不在"怎么滚"，而在"记准该滚回哪、且别滚错页"。Vue Router 的解法可以浓缩成一句：**用"栈位置 + 地址"当 key 存滚动，把存与取绑死在导航生命周期的特定时刻。**

它做了三处不太显然的设计：靠 `position - delta` 让存取 key 对称（用一点理解成本换对称）；把恢复推迟到下一帧并校验 `to === currentRoute`（用一帧延迟换"不串页"）；存的时候抢在导航开始前、取的时候读后即删（用"刷新不持久"换异步安全和不重复消费）。

值得注意的是，这套机制是"挂在"导航生命周期上的：它依赖一个会随导航推进而切换的"当前路由快照"、依赖一个在 popstate 时算出步长的 history 监听、依赖守卫跑完之后的那个"导航确认"时刻。这些"当前路由快照怎么来、导航什么时候才算确认、连点导航怎么被取消"——正是下一章"Router 核心与导航主循环"要拆的：那是一个把 matcher、history、guards、scroll 拼到一起的可取消异步导航状态机，本章的滚动恢复只是挂在它生命周期上的一个小部件。
# 滚动位置恢复

> 本章属于 composite 层。前置：History 抽象（栈位置语义）、路由位置与 URL 解析（地址字符串化）。
> 学完你能：用一句话讲清「为什么滚动恢复要用『栈位置 + 地址』当复合 key、为什么要在导航生命周期的特定时刻存取」。

上一章把导航守卫串成了一条 promise 链，让「异步、可取消、可重定向」的导航钩子统一成可组合的异步单元——它把**「能不能通过」**这件事讲透了。但守卫管线专注于逻辑门控，不管导航通过之后用户的「视觉状态」怎么接回原处。最显眼的视觉状态就是滚动位置：用户在长列表滚到很深的地方，点进详情，按浏览器后退——本以为会回到原处，结果弹回了顶部。本章就接这个口子。

## 1. 为什么需要它（设计动机）

单页应用切换路由时页面并不刷新，DOM 是被持续复用的。这导致浏览器原生的滚动恢复机制要么失效、要么对不上号——原生机制依赖「页面重载」，而 SPA 根本不重载。

更隐蔽的坑是：**同一个地址在前进/后退栈里可能出现多次**。比如用户走 A→B→A→B→A，栈里 `/a` 就有三个独立槽位。如果只拿地址当存档的 key，后一次入栈会覆盖前一次，永远恢复不对。

再叠加一个矛盾：**导航是异步、可中止、可被新导航插队的**。这意味着「存滚动」太晚会丢（守卫跑一半被取消），「取滚动」太早会被随后的渲染冲掉或落到错的新页上。所以问题不只是「存到哪个槽」，还有「在哪一刻存、在哪一刻取」。

## 2. 核心思想

把**栈位置**请进 key，与地址组合成复合 key；把**保存与恢复**绑死在导航生命周期的特定时刻——`popstate` 触发那一刻就抢存，导航确认 + 下一渲染周期后再取。让滚动可见性跟随导航事件，而不是跟随数据什么时候到。

## 3. 心智模型

```
事件              historyStatePos     动作
──────────────────────────────────────────────────────────────────
初始              pos=2 在 /list      用户滚到 y=800
push /detail      pos=3 在 /detail    新压栈，不在此存档
pop（后退）       pos=2 在 /list      popstate 触发 → 立即抢存 /detail 滚动
                                        key = (pos − delta):/detail
                                      守卫管线跑（可能被中止）
                                      导航确认 → currentRoute 切到 /list
                                      取 /list 存档：key = (pos − 0):/list
                                      等下一渲染周期
                                      校验 /list === currentRoute.value
                                      滚动到存档位置
```

三个关键不变量：

- **存档表是模块级单例 Map**，key 是 `"栈位置:地址"`，value 是 `{top, left}`。刷新即失，不做持久化。
- **保存路径与恢复路径用同一公式 `position − delta` 算 key**——保存传 `(from, delta)`，恢复传 `(to, 0)`。两侧对齐靠的是「popstate 后 history.state 已是目标态」这一时序。
- **存档读后即删**：同一份存档不会被第二次消费，因为页面早已变样。

## 4. 关键权衡

### 栈位置进 key，反推一步对齐存取

选择把栈位置请进 key 的第二维度，于是同一个 `/list` 在栈位置 2 与栈位置 5 是两条独立存档；并在 `popstate` 触发后用 `history.state.position − delta` 反推「被影响的那一个栈槽」——保存传 `(from, delta)`、恢复传 `(to, 0)`。

换来的是「同地址多次入栈可分别留档」加「保存与恢复共用同一把 key」的双重对称：用户在 A→B→A→B→A 来回走，每次的滚动值都能各自恢复，不会互相覆盖。

代价是这把 key 的含义极不直观——「为什么要减 delta？」读者必须先掌握「popstate 发生时历史栈状态已翻到目标」这个时序细节，否则完全看不懂。

**本质矛盾**：用户视角的 URL 同一性 对立于 浏览器后退语义下的物理槽位同一性。同一个 `/list` 在 URL 维度是同一个，在栈维度是多个独立的「访问记录」。把它们叠在 key 里，存档就既不丢同一性、也不混淆不同的访问记录。反推那一步本质是「从事后通知倒推事前的槽位」——popstate 是事后通知，事件触发时历史栈已翻完，但你关心的槽位在过去，只能倒推回去。

### 在下一渲染周期应用滚动，并校验导航未过期

选择把真正的 `scrollTo` 推迟到 `nextTick`（Vue 的 DOM patch 之后）之后，并在执行前再次校验 `to === currentRoute.value`——也就是这次导航的目标仍是当前路由快照。

换来两件事：连点导航时，为旧路由算出的滚动绝不会误投到新路由（校验失败就不滚）；顺带等视图把新路由的 DOM 渲染出来再滚，否则会滚到尚未出现的元素，或被随后的渲染冲掉。

代价是滚动有约一帧的延迟，并且滚动策略函数必须返回可解析的位置（坐标或元素选择器）；返回假值即「本次不滚」——这是用户表达「这次导航我不希望框架替我滚」的逃生口。

**本质矛盾**：滚动是渲染完成后的视觉副作用，而导航是异步状态机。如果在导航一确认就立刻滚，会被随后的 Vue 渲染冲掉；如果在策略 resolve 之前用户又触发了一次新导航，旧导航算出的滚动会落到错的新页上。等一帧解决「视图还没好」，校验解决「导航已被插队」——把滚动的可见性跟导航状态机的稳定时刻绑定，而不是跟数据到达时刻绑定。

### 抢在守卫之前抓存，读出立即消费

选择在 `popstate` 一发生、`navigate` 之前就抢存来源页的当前滚动；取出时立即 `delete`，一次性消费。

换来两件事：即便后续守卫异步中止或重定向，真实滚动位置也已被先一步抓到（守卫跑完再抓就晚了——视图可能已经动过）；同一份存档不会被重复消费，因为下一次访问同样地址时页面早已是另一回事。

代价是存档只活在内存里（刷新即失），需要 history 实现层另设一道「页面将隐藏时把滚动塞进 history.state」的兜底，才能在刷新后粗粒度恢复——那条线属 history 实现层，本章不展开。

**本质矛盾**：事件的瞬时状态（当前滚动值） 对立于 后续异步流程的可中止性。popstate 是个稍纵即逝的瞬时事件，但导航后续可能是几秒级的异步流程；想保住瞬时值就必须在事件触发的那一刻抓走，而不是等流程跑完。

## 5. 最小原理演示

下面这段只演示三件事：栈位置 key 的反推、读后即删、连点导航的过期校验。元素选择器解析、CSS 转义、`scrollTo` 的旧浏览器降级、刷新兜底全部省略。

```ts
type ScrollXY = { top: number; left: number }

// 模块级单例存档表：key = "栈位置:地址"
const scrollPositions = new Map<string, ScrollXY>()

// 三个由外部（history 抽象层 + 导航主循环）维护的状态
let historyStatePos = 0                          // popstate 后已是目标栈位置
let currentRoutePath = ''                        // 当前路由快照
let currentScroll: ScrollXY = { top: 0, left: 0 }
const scrollLog: ScrollXY[] = []
const scrollTo = (p: ScrollXY) => scrollLog.push(p)

// 反推被影响栈槽：保存传 delta 反推来源槽；恢复传 0 直得目标槽
const getScrollKey = (path: string, delta: number) =>
  `${historyStatePos - delta}:${path}`

// pop 一发生就抢存（在守卫之前）
function saveOnPop(fromPath: string, delta: number) {
  scrollPositions.set(getScrollKey(fromPath, delta), { ...currentScroll })
}

// 取出即删：同一存档只消费一次
function consumeSaved(targetPath: string): ScrollXY | null {
  const key = getScrollKey(targetPath, 0)
  const pos = scrollPositions.get(key) ?? null
  scrollPositions.delete(key)
  return pos
}

// 用户滚动策略：有存档回存档，无存档回顶
const userScrollBehavior = (_to: string, _from: string, saved: ScrollXY | null) =>
  saved ?? { top: 0, left: 0 }

// 核心：等渲染 → 调策略 → 校验导航未过期 → 滚
async function handleScroll(to: string, from: string, saved: ScrollXY | null) {
  await Promise.resolve()                        // 模拟 nextTick，等 DOM patch 完
  const resolved = userScrollBehavior(to, from, saved)
  if (to === currentRoutePath && resolved) {     // 期间没被新导航插队？
    scrollTo(resolved)
  }
}

// —— 场景 A：存与取的对称（反推栈槽对齐）——
// 起点：栈位置=3，在 /detail，滚到 y=500
historyStatePos = 3
currentScroll = { top: 500, left: 0 }
// 后退一步（步长 -1），popstate 把 historyStatePos 翻到目标态 2
historyStatePos = 2
saveOnPop('/detail', -1)                          // 反推槽位 = 2 − (−1) = 3，存 '3:/detail'
console.log(scrollPositions.get('3:/detail'))     // { top: 500, left: 0 }

// 一段时间后又前进回 /detail（栈位置=3，步长 +1）
historyStatePos = 3
// 取目标存档：delta=0 → key = '3:/detail'，与当年保存的 key 完全一致
const recovered = consumeSaved('/detail')
console.log(recovered)                            // { top: 500, left: 0 }
console.log(scrollPositions.has('3:/detail'))     // false（读后即删）

// —— 场景 B：连点导航，校验阻止旧滚动误投到新页 ——
scrollLog.length = 0
currentRoutePath = '/list'
const pending = handleScroll('/list', '/home', { top: 800, left: 0 })
// pending 还在等 nextTick 时，用户又点了一次 → currentRoutePath 已切到 /other
currentRoutePath = '/other'
await pending
console.log(scrollLog)                            // [] —— '/list' !== '/other'，没滚
```

## 6. 执行轨迹

把场景 A 走一遍：

- 用户在 `/list` 滚到 y=800（栈位置=2）。
- 点进 `/detail`（push，栈位置=3）。push 不在 pop 监听里存档——新页面没有「旧滚动」要记。
- 用户按浏览器后退。`popstate` 触发，`historyStatePos` 翻到 2，`delta = -1`，`to=/list`、`from=/detail`。
- 路由器**在调用任何守卫之前**先 `saveOnPop('/detail', -1)`：算 key = `2 − (−1) = 3` → `'3:/detail'`，把当前滚动值（/detail 离开时的滚动）存进表。
- 守卫管线跑（可能被中止/重定向）。这里假设通过。
- 导航确认，`currentRoutePath` 切到 `/list`。
- 滚动处理：`consumeSaved('/list')` 算 key = `2 − 0 = 2` → `'2:/list'`。这一条是用户更早一次访问 /list 时存下的，取出 y=800，`delete`。
- `await nextTick`（让 Vue 把 /list 的视图 patch 完）。
- 调用户的滚动策略，得到 `{top: 800}`。
- 校验 `'/list' === currentRoutePath`（成立）→ `scrollTo({top: 800})`。✓

如果在第 6 步与第 9 步之间用户又点了一次新导航（比如连点到 `/other`），`currentRoutePath` 会先被切到 `/other`；待 `nextTick` resolve 时校验失败，旧滚动就不会误投到 `/other`。

## 7. 教学简化说明

本章演示故意省略了：元素选择器（`{el: '#xxx'}`）的解析与 CSS 转义、`getBoundingClientRect` 到文档绝对坐标的换算、不支持 `scroll-behavior` 的旧浏览器降级、开发期的诊断码、滚动策略函数多种返回值分支的细节、以及 history 实现层那条「页面将隐藏时塞 `history.state.scroll`」的刷新兜底。这些都不影响讲清「为什么用栈位置当 key 的第二维度、为什么要在导航生命周期的特定时刻存取」。

## 8. 小结

让滚动位置跟「栈槽位」对齐，而不是跟「URL 字符串」对齐——同一个地址多次入栈也各有各的存档。让滚动的存取跟导航事件对齐，而不是跟数据到达对齐——`popstate` 一发生就抓、`nextTick` 之后再消费，中间夹一道「导航是否仍是最新」的校验。下一章「Router 核心与导航主循环」把 matcher、history、guards 加上本章这套 scroll 机制组装成完整的导航状态机，看它怎么用 `pendingLocation` 让任何阶段都能被新导航作废。
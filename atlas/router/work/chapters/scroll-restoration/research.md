# 滚动位置恢复 · 源码精读

## 给 Writer 的教学钩子（必填，8 子项缺一不可）

- **用户痛点 / 场景**：单页应用切换路由时页面并不真正刷新，浏览器原生的滚动恢复要么失效、要么与新内容对不上号。典型挫败感是：在长列表页滚到很深的位置，点进详情，再按浏览器后退——本以为会停回原处，却弹回顶部。更隐蔽的坑是：同一个地址在前进/后退栈里可能出现多次（比如 A→B→A），如果只拿地址当「存档槽位」来记滚动位置，后一次就会覆盖前一次，永远恢复不对。

- **一句话核心思想**：**用「栈位置 + 地址」组合当 key 存滚动位置，并把滚动的保存与恢复绑死在导航生命周期的特定时刻**——让滚动可见性跟随导航事件，而不是跟随「数据什么时候到」。

- **设计动机（为什么需要它）**：
  - 浏览器原生的滚动恢复机制在 SPA 下不可靠（DOM 被持续复用、页面不刷新），必须由框架显式接管并关闭原生机制。
  - 承前：第 5 章『History 抽象』已经在不可靠的 history 原语之上叠加了「栈位置」这一方向语义。本章**复用这个栈位置作为滚动 key 的「栈维度」**——不另造一套栈，而是借现成的栈位置给「同一地址多次入栈」赋予可区分性。（已在第 5 章『History 抽象』讲透 position 的栈语义，本章只看它作为滚动 key 维度的新侧面。）
  - 承前：第 2 章『路由位置与 URL 解析』建立了「地址的字符串化」语义。本章取其字符串化地址作为滚动 key 的「URL 维度」。（已在第 2 章『路由位置与 URL 解析』讲透同一位置判定，本章只取其地址字符串作 key 的一段。）

- **关键权衡（核心原料）**：
  1. **用「当前栈位置 − 这一步的步长」反推出被影响的那一个栈槽，而不是直接拿当前栈位置当 key** → 换来了「保存与恢复用同一把 key」的对称性：保存时（后退/前进触发、此时历史栈状态已翻到目标）用 `来源地址 + 步长` 反推出来源槽；恢复时用 `目标地址 + 0` 算出目标槽，两者天然对齐 → 代价是这把 key 的含义极不直观，读者必须先理解「popstate 发生时历史栈状态已是目标态」这个时序细节，否则完全看不懂为什么要减步长。
  2. **滚动恢复放在「下一个渲染周期之后」，并且应用前再次校验「这次导航的目标是否仍是当前路由」** → 换来了「连点导航时，为旧路由算出的滚动绝不会误投到新路由」的健壮性，顺带等视图把新路由的 DOM 渲染出来再滚（否则滚到的元素还没出现，或被随后的渲染冲掉）→ 代价是滚动有约一帧的延迟，且滚动策略函数必须返回可解析的位置（返回假值即表示「这次不滚」）。
  3. **滚动位置在导航真正开始之前就抢存，且取出时「读后即删」一次性消费** → 换来了两件事：即便后续守卫异步中止或重定向，真实滚动位置也已被先一步抓到；同一份存档不会被重复消费（页面早已变样）→ 代价是存档只活在内存里（刷新即失），需要另设一道「页面将隐藏时」的兜底把位置塞进历史栈状态，才能在刷新后粗粒度恢复。

- **最小心智模型（3～7 步）**：
  1. 创建路由器时，若用户提供了滚动策略函数，就关闭浏览器原生滚动恢复，宣告由框架接管。
  2. 用户点浏览器后退/前进 → 触发历史变化 → 路由器在执行任何守卫/异步逻辑**之前**，先用「来源槽位置 + 来源地址」当 key 把当前滚动抢存。
  3. 导航经过守卫管线（可能异步、可能被取消/重定向），最终确认后把「当前路由快照」切换到新路由。
  4. 进入滚动处理：若是后退/前进（非新压栈），用「目标槽位置 + 目标地址」当 key 取出之前存的滚动；取不到就降级用历史栈状态里那份兜底位置；都没有就交给滚动策略一个「无存档」。
  5. 把（目标、来源、存档位置）三者交给用户的滚动策略函数，由它决定最终滚到哪——可返回坐标、可返回元素选择器、可返回假值表示不滚。
  6. 等到下一个渲染周期（视图已反映新路由）。
  7. 再次确认「这次导航的目标仍是当前路由」（说明期间没有更新的导航插队），才真正执行滚动。

- **最小原理演示（替代旧「复刻范围」）**：
  - 应演示：一个**只表达「栈位置 key 映射 + 一次性消费 + 导航未过期校验」三件套**的最小实现（几十行）。它演的是上面**权衡 1（反推栈槽使存取对称）+ 权衡 2（应用前校验导航当前态）+ 权衡 3（读后即删）**这三条原理。具体：维护一个 `Map<key, scrollY>` 和一个模拟的「当前路由快照」变量；模拟一次后退（步长 −1），在「历史栈状态已翻到目标」的时点用「目标栈位置 − 步长」反推出来源槽并存档；恢复时用「目标栈位置 + 0」取出存档并立即删除；再演示一次「连点导航」——在滚动策略 resolve 前把当前路由快照改掉，证明校验 `目标 === 当前路由快照` 能阻止旧滚动误投。
  - 应故意省略：元素选择器解析与 CSS 转义、`scrollTo` 的旧浏览器降级、开发期诊断码、滚动策略函数的多种返回值分支、页面隐藏时的刷新兜底、真实 history API 调用。
  - **演示载体建议：首选 TS/JS**。理由：本章核心是「基于栈位置的 key 映射 + 导航时序校验 + 一次性消费」，纯属数据结构与控制流，TS/JS 能忠实演透，配最小 `package.json` 即可 `node`/`bun run` 跑通；本 Atlas 产物本身是 JS 生态站点，TS/JS 演示对读者最友好。无需浏览器或原生运行时——真实 `window.scrollTo` 等可被桩函数替换。

- **正文不宜展开的细节**：
  - 元素选择器里 id 选择器（`#xxx`）与 `querySelector` 的字符转义差异（CSS escape）。
  - 开发期诊断码（选择器找不到、id 误当通用选择器等告警）。
  - 把元素 `getBoundingClientRect` 换算成「相对文档绝对坐标」的减法细节。
  - 不支持 `scroll-behavior` CSS 的旧浏览器降级分支。
  - 「页面将隐藏时」往历史栈状态塞滚动位置的刷新兜底（属于 history 实现层，略提即可）。

- **推荐的一个执行轨迹例子**：
  用户在 `/list` 滚到 y=800（此时栈位置=2），点进 `/detail`（新压栈，栈位置=3），再按浏览器后退 →
  ① 触发历史变化，目标=`/list`、来源=`/detail`、步长=−1，此时历史栈状态已是目标（栈位置=2）；
  ② 用 `2 − (−1) = 3` 反推出来源 `/detail` 的槽位，key=`3:/detail`，存下 `/detail` 当前滚动；
  ③ 导航确认，当前路由快照切到 `/list`；
  ④ 滚动处理用 `2 − 0 = 2` 算出目标槽，key=`2:/list`，取出之前存的 y=800；
  ⑤ 交给滚动策略 → 返回 `{top:800}`；
  ⑥ 下一个渲染周期后，校验 `/list === 当前路由快照`（成立）→ 真正滚动到 800。✓

> 以上钩子供 Writer 写「动机→核心思想→心智模型→关键权衡→原理演示」；下面事实部分供核对，不要被 Writer 当目录照抄。

## 概念要点

- **滚动位置的类型双形态**：对外暴露的滚动目标可以是「坐标 `{left, top, behavior?}`」或「元素 `{el, ...}`」两种；内部归一化为始终带 `left/top` 的坐标。源码位置: packages/router/src/scrollBehavior.ts:14-30, 64
- **滚动策略函数的签名**：用户传入的函数收到 `(to, from, savedPosition)`，`savedPosition` 为 `null` 表示无存档；返回值可 await、可返回坐标/元素/`false`/`void`，返回假值即「不滚」。源码位置: packages/router/src/scrollBehavior.ts:35-46, 68-74
- **滚动 key = 栈位置 + 地址**：`getScrollKey(path, delta)` 内部用 `history.state.position - delta` 反推出「被影响栈槽的 position」，再拼接 path。这是全章机制枢纽。源码位置: packages/router/src/scrollBehavior.ts:166-169
- **存档是模块级单例内存 Map**：`scrollPositions` 是进程内 `Map<key, 坐标>`，刷新即失，不做持久化。源码位置: packages/router/src/scrollBehavior.ts:171
- **取出即消费**：`getSavedScrollPosition` 读出后会 `delete`，保证同一存档不被重复使用。源码位置: packages/router/src/scrollBehavior.ts:180-185
- **接管原生恢复**：只要用户提供了 scrollBehavior，就把 `history.scrollRestoration` 置为 `'manual'`，关闭浏览器原生机制避免打架。源码位置: packages/router/src/router.ts:168-171
- **保存时机**：仅在后退/前进（pop）触发的监听里、`navigate` 之前，用 `getScrollKey(from.fullPath, info.delta)` 抢存来源页滚动。push（新压栈）不在此保存——新页面没有「旧滚动」要记。源码位置: packages/router/src/router.ts:786-791
- **恢复与防误投**：`handleScroll` 在非压栈时尝试取存档（取不到降级用 `history.state.scroll`），再 `nextTick().then(用户策略).then(位置 => 目标===当前路由快照 && 位置 && scrollTo)`——「等渲染 + 校验导航未过期」双保险。源码位置: packages/router/src/router.ts:954-982
- **`position` 的来源（承前）**：history 实现把每次 `pushState` 时的 `window.history.length` 记进 state.position；popstate 时用 `state.position - fromState.position` 算出步长 `delta` 传给路由器。本章的 `getScrollKey` 正是消费这个 position/delta。源码位置: packages/router/src/history/html5.ts:89, 166-181

## 关键调用链

后退/前进场景的滚动保存与恢复链：

```
浏览器 popstate
  → html5 popStateHandler 算 delta = 目标.position − 来源.position
    → router setupListeners 的回调(to, from, {delta})
      → saveScrollPosition(getScrollKey(from.fullPath, delta), computeScrollPosition())  // 抢存来源
      → navigate(...) → 守卫管线
        → finalizeNavigation(to, from, isPush=false)
          → currentRoute.value = to                       // 切当前路由快照
          → handleScroll(to, from, isPush=false, ...)
              scrollPosition = getSavedScrollPosition(getScrollKey(to.fullPath, 0))  // 取目标存档（读后即删）
                            || history.state.scroll || null
              → nextTick()
                → 用户 scrollBehavior(to, from, scrollPosition)  // 算最终位置（可异步）
                → 校验 to === currentRoute.value && position
                → scrollToPosition(position)             // 真正滚动
```

源码位置: packages/router/src/router.ts:752, 762-791, 954-982；packages/router/src/history/html5.ts:70-110

## 源码摘录（带行号，全文累计 ≤ 30 行）

滚动 key 的反推（枢纽）：
```ts
// scrollBehavior.ts:166-169
export function getScrollKey(path: string, delta: number): string {
  const position: number = history.state ? history.state.position - delta : -1
  return position + path
}
```

存档表与「读后即删」：
```ts
// scrollBehavior.ts:171-185
export const scrollPositions = new Map<string, _ScrollPositionNormalized>()
export function saveScrollPosition(key, scrollPosition) {
  scrollPositions.set(key, scrollPosition)
}
export function getSavedScrollPosition(key: string) {
  const scroll = scrollPositions.get(key)
  scrollPositions.delete(key) // consume it so it's not used again
  return scroll
}
```

pop 时抢存来源页滚动（在 navigate 之前）：
```ts
// router.ts:786-791
if (isBrowser) {
  saveScrollPosition(
    getScrollKey(from.fullPath, info.delta),
    computeScrollPosition()
  )
}
```

恢复 + 等渲染 + 校验导航未过期：
```ts
// router.ts:962-981（精简）
const scrollPosition =
  (!isPush && getSavedScrollPosition(getScrollKey(to.fullPath, 0))) ||
  ((isFirstNavigation || !isPush) && history.state && history.state.scroll) ||
  null
return nextTick()
  .then(() => scrollBehavior(to, from, scrollPosition))
  .then(position =>
    to === currentRoute.value && position && scrollToPosition(position)
  )
  .catch(err => to === currentRoute.value && triggerError(err, to, from))
```

## 易混淆 / 边界 / 推断

- **事实**：`getScrollKey` 在「保存」与「恢复」两条路径上被调用时，`history.state.position` 的含义不同——保存时（pop 已发生）它已是目标栈位置，故要 `− delta` 反推来源槽；恢复时（finalize 阶段，同样是 pop 之后）它仍是目标栈位置，`delta` 传 0 即直接得目标槽。两侧之所以能对齐成同一把 key，靠的正是「popstate 后历史栈状态统一是目标态」。源码位置: packages/router/src/router.ts:788, 966；packages/router/src/scrollBehavior.ts:167
- **事实**：push（新压栈）导航不经过 pop 监听、不会在 `setupListeners` 里保存滚动；push 的滚动语义完全交给用户 `scrollBehavior`（通常滚到顶或滚到某元素）。源码位置: packages/router/src/router.ts:734-748, 963-970
- **事实**：`scrollBehavior` 返回 `false`/`void` 时，`position` 为假值，`scrollToPosition` 不会被调用——这是「本次不滚」的逃生口。源码位置: packages/router/src/router.ts:978
- **推断（标注为推断）**：源码未注释「为何要在 nextTick 后应用滚动」，但从 `nextTick`（Vue 的 DOM patch 之后）的语义可推断：等待新路由的视图渲染完毕，避免滚到尚未出现的元素或被随后渲染重置。源码位置: packages/router/src/router.ts:973
- **推断（标注为推断）**：源码未注释「为何 getScrollKey 用 `position − delta` 而非直接 `position`」；从「保存路径传 `(from, delta)`、恢复路径传 `(to, 0)`」的实际用法可反推出：目的是在 popstate 已翻到目标态的前提下，对称地反推出「被影响的那一个栈槽」。源码位置: packages/router/src/scrollBehavior.ts:167
- **边界**：`scrollPositions` 为内存单例，刷新页面即清空；刷新后的恢复依赖另一条「页面 visibility 变 hidden 时把滚动写进 history.state.scroll」的兜底（在 html5 实现层），本章不必展开。源码位置: packages/router/src/scrollBehavior.ts:171；packages/router/src/history/html5.ts:129-135
- **边界**：元素型目标（`{el}`）里，id 选择器走 `getElementById`（接受任意合法 id 字符），其余走 `querySelector`（需 CSS 转义）；dev 模式下有一组诊断码检查选择器误用。源码位置: packages/router/src/scrollBehavior.ts:98-151
- **未理解**：无明显读不通处。`buildState` 用 `window.history.length` 作 position，在 replace/跨页面跳转等极端边界下的精确性未深究，但不影响本章「栈位置作 key 维度」的主线论述。源码位置: packages/router/src/history/html5.ts:178
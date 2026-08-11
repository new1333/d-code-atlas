# 侧边栏内容列表

> 本章属于 composite 层。前置：全局共享状态容器、Cookie 凭证的清洗与校验、防反爬浏览器引擎。
> 学完你能：把「侧边栏长什么样」理解成「当前运行状态的投影」——为什么会用同一个回调表达六七种状态、为什么明明列表只用一次 HTTP 却要先校验那台笨重的真实浏览器。

## 1. 为什么需要它

上一章把「写」摆平了：投票、收藏、关注、不感兴趣，都靠伪造请求头模拟前端 XHR 直发知乎官方 JSON API。但写的前提是先看得见、点得开。本章就处理这个「先看得见」：左上角那棵侧边栏树，怎么把知乎的热榜、推荐、搜索、关注四份列表长出来，并且在任何异常状态下都不让用户看到一片空白。

听起来简单，写起来立刻撞墙。平台只给你一个回调 `getChildren`，问的就是一句话：「现在这个节点下面该显示哪些子节点？」你得用这同一个回调同时回答：五十条知乎内容、请先登录、浏览器没配好、加载中请稍候、加载失败点我重试。如果只回答前一种，那任何异常状态下侧边栏就是一片空白，用户连下一步该干嘛都不知道。

更扎心的是另一件事：哪怕列表本身用一次轻量 HTTP 就能拉回来，点开任何一条都需要那台笨重的真实浏览器渲染详情。如果列表先到了、浏览器还没准备好，用户点开就是死路一条。一个点不开的列表，对用户毫无意义。

本章要解决的，就是怎么在同一个 `getChildren` 回调里把这六七种状态都讲清楚，并且把「列表能展示」和「详情能打开」两件事永远绑定在一起。

## 2. 核心思想

侧边栏不是数据的容器，而是状态的投影：树什么时候长什么样，全看当前那份共享状态里有什么。改一份状态、敲一下「内容变了」的事件，平台自然会重新来问 `getChildren`，那时再按当前状态现算出节点。

## 3. 心智模型

整棵树靠两个东西撑起来：

- **共享状态对象**（来自前置章的全局 Store）：里面几个字段决定渲染——`list` 是当前数据数组，`isLoading` 是是否在拉取，`canCreateBrowser` 是浏览器能否启动，外加 Cookie 是否设置过。
- **一个状态变更事件发射器** `_onDidChangeTreeData`：任何人改完共享状态调一下 `.fire()`，平台收到信号、重新调用 `getChildren`。

`getChildren` 本身写成一条优先级分支链，从最该让用户看见的状态排到最不该：

```
路径配置无效       → 一个「点我去配置」占位节点
浏览器不可创建     → 一个「点我配置爬虫浏览器」占位节点
Cookie 没设过      → 「扫码登录」+「手动设置 Cookie」两个占位节点
正在加载           → 「正在加载知乎热榜...」占位节点
list 有数据        → 打赏入口 + 数据项（+ 尾部刷新/加载更多）
以上都不是         → 「获取失败，点我重试」占位节点
```

加载流程则在另一个私有方法里跑：

```
时机触发（构造 / 点刷新 / 提交搜索词）
  → 浏览器闸门（canCreateBrowser?）  不通就清空 + 发事件 + 停
  → isLoading 防重入                 已在加载就走人
  → 置 isLoading=true + 状态栏显示 + fire()   【此时 getChildren 返回「加载中」】
  → 真正拉取（热榜走轻量 HTTP + 解析；其余走真实浏览器开页 + 滚动 + evaluate）
  → 结果写回 Store.{x}.list + 置 isLoading=false + fire()   【此时 getChildren 返回数据】
```

一条数据从拉到到显示的链路因此是：拉取 → 改共享状态 → 发事件 → 平台重问 → `getChildren` 按当前状态分支返回节点 → 树刷新。

## 4. 关键权衡

### 列表能拉下来不算数，详情能打开才算数

读到这你大概会想：热榜这种服务端渲染的页面，`fetch("https://www.zhihu.com/hot")` 加一段 cheerio 解析就够了，根本用不着那台笨重的 Chrome。源码里就是这么做的，热榜故意走轻量 HTTP，不去占用昂贵的浏览器实例，也避免和推荐页抢同一台机器。

但奇怪的事情来了：热榜加载的第一步，仍然是 `PuppeteerManager.canCreateBrowser()` 这道闸门。过不去就清空列表、发事件、直接返回。明明这一步列表本身根本不需要浏览器。

为什么？因为用户点开热榜任一条，详情页必须由那台真实浏览器渲染。**一个能拉下来却点不开的列表，对用户毫无意义**——它只会制造「我明明看到它了为什么打不开」的困惑。所以热榜把「列表能否出现」和「详情能否打开」用同一道闸门绑死：浏览器还没就绪时，干脆连列表都不出，让用户看到「点我配置爬虫浏览器」这个可执行的下一步。

源码注释里那句话很直白：「只加载了热榜列表却点不开，加载列表就没意义了」。

这条权衡化解的本质矛盾，是**展示层的轻**和**呈现链路的重**之间的张力：单看列表，最轻的手段最合理；放进整条使用链路，最轻的那环反而最危险，因为它会把后面的重链路甩锅给用户。

### 回调做成按状态优先级分支，而不是数据数组

最自然的写法是把 `getChildren` 当成「返回 list 数组」的函数。平台要子节点嘛，给它 list 就完了。但这样写，任何异常状态下侧边栏就一片空白，因为 list 是空的。

源码里把它写成一条**按状态优先级分支的状态机**：先查路径配置、再查浏览器、再查 Cookie、再查 isLoading、再查有没有数据、最后兜底「加载失败」。每一层 `return` 的都是适合当前状态的节点数组——配置错了就给「去配置」的动作入口、没登录就给「去登录」、加载中就给「加载中」占位、有数据就给数据项、失败了就给「点我重试」。

换来的是：**侧边栏在任何运行状态下都有意义，使用者总有可点的下一步**。无论扩展处于哪种异常，用户看到的都不是空白而是可执行的动作。这是用户体验的兜底，也是这个扩展「让人摸鱼摸得下去」的关键。

代价是 `getChildren` 变成一长串条件分支，而且这套分支在热榜、推荐、搜索、关注四个 provider 里几乎逐字重复，没有抽公共基类。维护时改一处要同步四处，是个明显的代码异味。源码作者选择重复而非抽象，背后大概是判断「四份 provider 各自有列表差异、抽象出来的基类会很笨重」；但代价就是这种四处同步的负担。

这条权衡化解的本质矛盾，是**平台契约的单一**（一个回调问「现在显示啥」）和**应用状态的多样**（六七种截然不同的运行态）之间的张力。把契约里那一个回调掰成一条优先级链，等于把状态空间压扁成可点的 UI。

### 动作入口和数据项共用同一种节点

平台只认一种 `TreeItem` 类型。你想要「加载中」「点我登录」「点我重试」这些可点击的动作入口，最自然的写法是单独定义一种「占位节点」类型。但那就要在平台契约之外再造一套节点多态，复杂度立刻上来。

源码里的做法非常巧妙：写一个 `StatusTreeItem` 继承 `TreeItem`，构造时**先造一份伪 LinkItem**（随机 id、空 url、「爬虫读取中…」当 excerpt）调父类构造，再覆写 `iconPath / tooltip / command`，挂上 `contextValue = "StatusTreeItem"`。结果「加载中」和「五十条知乎热榜」在树里看起来是同一种东西，都是 `TreeItem`，都能带 `command`，都能在右键菜单里被 `contextValue` 控制。

换来的是：**整棵树只有一种节点类型，平台契约保持单一**。「加载中」这种动作入口天然就能带点击命令，构造时传一个 `{command: "zhihu-fisher.configureBrowser"}`，点一下就触发对应命令，不用再造一套事件分发。

代价有两层。一层是 `TreeItem` 构造函数很重，数据节点要算图标、拼大段 Markdown 悬浮提示、绑命令、设 contextValue，所以即便是「加载中」这种临时占位项，也得付一份构造开销。另一层是占位项的 id 每次都用 `Date.now() + Math.random()` 现生成，平台很难按 id 复用 DOM，每次 `fire()` 之后，「加载中」占位节点对平台来说都是个全新节点。

这条权衡化解的本质矛盾，是**契约的统一性**和**UI 的异质性**（数据 vs. 动作）之间的张力。用继承加伪数据把「动作」伪装成「数据」，让契约只看见一种东西。

## 5. 最小原理演示

下面这段几十行的脚本只演透三件事：状态优先级分支渲染、事件驱动的重算、轻量拉取穿过重闸门。它故意不演真实的 HTTP 请求、真实的 cheerio 解析、真实的浏览器，这些都是手段，不是原理。

```ts
// 一个极简事件发射器：维护监听者数组，fire() 时逐个回调
type Listener = () => void
class Emitter {
  private listeners: Listener[] = []
  on(l: Listener) { this.listeners.push(l) }
  fire() { this.listeners.forEach(l => l()) }
}

// 共享状态：侧边栏长什么样全看这里
interface SidebarState {
  canOpenDetail: boolean     // 重闸门：详情能不能打开
  isLogged: boolean          // Cookie 设过没
  isLoading: boolean         // 在拉取吗
  list: { id: string; title: string }[]  // 当前数据
}
const state: SidebarState = {
  canOpenDetail: false,
  isLogged: false,
  isLoading: false,
  list: [],
}

// 节点只有一个统一形状：标签 + 可选的点击命令
interface Node { label: string; command?: string }

// 状态机：取子节点 = 按状态优先级现算
function getChildren(): Node[] {
  if (!state.canOpenDetail)
    return [{ label: "点我配置爬虫浏览器", command: "configureBrowser" }]
  if (!state.isLogged)
    return [{ label: "点我扫码登录", command: "qrLogin" }]
  if (state.isLoading)
    return [{ label: "正在加载知乎热榜..." }]
  if (state.list.length > 0)
    return [
      { label: "☕ 打赏作者" },
      ...state.list.map(i => ({ label: i.title, command: "openArticle" })),
    ]
  return [{ label: "获取失败，点我重试", command: "refreshHotList" }]
}

// 改状态后必须发事件，平台才会重新来问 getChildren
const treeChanged = new Emitter()
function setState(patch: Partial<SidebarState>) {
  Object.assign(state, patch)
  treeChanged.fire()  // 这一句是状态机重新转动的发条
}

// 平台侧：注册一次监听，之后每次 fire() 都重新打印节点
treeChanged.on(() => {
  console.log("--- 树刷新 ---")
  getChildren().forEach(n =>
    console.log(`  ${n.label}${n.command ? `  [→${n.command}]` : ""}`),
  )
})

// 演示轨迹：从空状态一步步推进
console.log("[场景 1] 刚激活，浏览器还没配")
treeChanged.fire()

console.log("\n[场景 2] 用户配好了浏览器")
setState({ canOpenDetail: true })

console.log("\n[场景 3] 用户扫码完成，开始加载热榜")
setState({ isLogged: true, isLoading: true })

console.log("\n[场景 4] 模拟一次轻量拉取：数据是 HTTP 拉到的，但闸门已先放过")
setTimeout(() => {
  setState({
    isLoading: false,
    list: [
      { id: "1", title: "为什么 JS 里 0.1+0.2≠0.3？" },
      { id: "2", title: "用编辑器摸鱼是一种怎样的体验？" },
    ],
  })
}, 50)
```

跑一下你会看到：场景 1 只显示「点我配置爬虫浏览器」，尽管此刻连 Cookie 都还没设；场景 2 配好浏览器后立刻跳到「点我扫码登录」；场景 3 进加载中；场景 4 拿到两条数据后显示打赏入口加数据项。每一次跳转都是 `setState` 改共享状态、`fire()` 触发重算，`getChildren` 自己根据当前状态现算。这就是「侧边栏是状态的投影」的全部含义。

注意场景 4 那条注释：数据是用「轻量拉取」模拟的（生产里是一次 `fetch` 加 cheerio），但它能在树里显示，前提是场景 2 已经把 `canOpenDetail` 闸门打开。如果跳过场景 2 直接拉数据，树还是会停在「点我配置爬虫浏览器」，连数据都不展示。这就是「列表能拉下来不算数」在演示里的样子。

## 6. 执行轨迹

拿热榜从激活到点开一条的真实链路走一遍：

1. **构造即触发加载**：扩展激活时 `new HotListSidebarProvider()`，构造里调用 `getSideBarHotList()`。
2. **过浏览器闸门**：`PuppeteerManager.canCreateBrowser()` 返回 true（前置章那台 Chrome 已就绪）。若返回 false，立即清空 `Store.Zhihu.hot.list`、置 `isLoading=false`、`fire()`、return，侧边栏显示「点我配置爬虫浏览器」。
3. **isLoading 防重入**：检查 `Store.Zhihu.hot.isLoading`，已在加载就直接 return。
4. **置加载中并通知**：`isLoading = true` + 状态栏显示加载图标 + `_onDidChangeTreeData.fire()`。平台此刻重新调用 `getChildren`，命中 isLoading 分支，返回一个 StatusTreeItem 标签「正在加载知乎热榜...」。
5. **轻量拉取**：用前置章的 CookieManager 清洗 Cookie，发一次带完整伪造请求头的 `fetch("https://www.zhihu.com/hot")`，用 cheerio 解析回 50 条 HotItem。如果命中 `.SignFlow-submitButton`，说明被登录墙挡了（Cookie 失效），跳到失败支线。
6. **写回状态再通知**：`Store.Zhihu.hot.list = list` + `isLoading = false` + 状态栏隐藏 + `fire()`。平台再次调用 `getChildren`，命中 `list.length > 0` 分支，返回 `[sponsorItem, ...50 个 TreeItem]`。
7. **点击触发打开详情**：用户点任一数据项，TreeItem 的 `command: zhihu-fisher.openArticle` 被触发，命令处理函数把这条 LinkItem 交给下一章的详情爬取。

失败支线：第 5 步 HTTP 返回 403 或命中登录墙，判定 Cookie 失效，弹「Cookie 过期」通知，`fire()`，侧边栏显示「获取热榜失败，点击刷新按钮重试」。这是一个 StatusTreeItem，挂 `command: zhihu-fisher.refreshHotList`，点一下重跑整条链。

## 7. 教学简化说明

上面的演示故意省略了一堆工程化细节：状态栏计数文案、富文本悬浮提示里图片宽度按显示模式缩放、问题/文章/想法三种内容类型的字段差异、滚动加载更多时轮询骨架屏的等待策略、热榜 hotValue 解析里那段 `{` 前缀剥离。这些都不是原理，它们是知乎前端结构变了就要跟着改的实现细节。

## 8. 小结

回头看，整套机制只在干一件事：把「侧边栏长什么样」拆成一份状态、一个事件、一条优先级分支函数。改 UI 不用动 UI 代码，改状态就行。三条关键权衡都把同一件事翻来覆去地讲：用户能看见、能点开、能继续操作，永远排在工程简洁之上。轻量拉取甘愿先过重闸门、状态机分支宁可四处重复也不抽基类、占位项伪装成数据项，都是为此让步。

打赏入口和数据项混在一起、用户点哪一条都行；点开之后接下来怎么把详情页一段段抽出来，正是下一章。
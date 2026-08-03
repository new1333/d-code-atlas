# 侧边栏内容列表 · 源码精读

## 给 Writer 的教学钩子（必填，8 子项缺一不可）

- **用户痛点 / 场景**：把知乎的「热榜/推荐/搜索/关注」四份列表搬进编辑器侧边栏，使用者最大的困惑不是"列表拉不下来"，而是"列表明明拉下来了，点进去却打不开"——或者"没登录/Cookie 失效/浏览器没配好时，侧边栏一片空白，连下一步该干嘛都不知道"。本章机制要同时解决"把网页列表变成可点击的树"和"在任何异常状态下都给使用者一个可执行的下一步"。

- **一句话核心思想**：侧边栏的内容不是"存进去的"，而是"按当前状态现算出来的"——加载中、未登录、出错、有数据各自长成不同的样子，想换内容只需改一份共享状态、再敲一下"内容变了"的事件，侧边栏自己会重新映照。

- **设计动机（为什么需要它）**：编辑器侧边栏本质是一个"取子节点"回调驱动的懒树，平台只在需要时来问一次"现在该显示哪些节点"。因此这里的核心矛盾是：如何用同一个回调，既表达"50 条知乎内容"，又表达"请先登录""浏览器没配好""加载中""加载失败点我重试"？答案是把这个回调写成一个按状态优先级分支的**渲染状态机**，而非一个"返回数据数组"的简单函数。
  - 承前去重：本章大量复用前置章的成果，不重讲其内部原理——①**共享内存**（已在第 1 章讲透"模块级可变单例"）本章只看它被当成"视图数据源"来读写；②**Cookie 清洗/失效探测**（已在第 2 章讲透）本章只看列表在请求前复用清洗、请求后用登录墙 DOM 反判失效；③**真实浏览器引擎**（已在第 3 章讲透）本章只看它被当成两重角色复用——既是"能否点开详情"的前置闸门，又是动态页面的拉取手段。本章真正的新东西是"把列表渲染建模成状态机"这个编辑器侧特有的模式。

- **关键权衡（本 Atlas 的核心）**：
  1. **列表用最轻的 HTTP 拉取，却要先过最重的浏览器闸门** —— 做了"热榜用一次轻量 HTTP 请求 + 服务端 HTML 解析就够"的选择 → 换来了不占用那台昂贵的真实浏览器实例（也避免和推荐页抢同一个浏览器）→ 代价是：即便列表本身根本不需要浏览器，加载前仍必须先校验"浏览器可创建"，并且这一次 HTTP 请求要手动伪造一整套浏览器请求头；因为**列表项点开后打开的详情页必须用浏览器渲染，一个点不开详情的列表对使用者毫无意义**，所以"轻"不能脱离"重"独立存在。这是本章最具反差感的一条权衡。
  2. **把"取子节点"回调做成状态机，而不是数据容器** —— 做了"回调里按 配置错误 > 浏览器不可用 > 未登录 > 加载中 > 有数据 > 失败 的优先级，逐层 return 不同的节点"的选择 → 换来了侧边栏在任何状态下都有意义、使用者总有可点的下一步（去配置/去登录/去重试）→ 代价是回调变成一长串条件分支，且这套分支在四个列表里几乎逐字重复（没有抽公共基类），维护时要四处同步。
  3. **用同一种节点类型同时扮演"数据项"和"状态/动作占位项"** —— 做了"让'加载中''点我登录''点我重试'这些动作入口也长成树节点的样子，复用同一种节点类型"的选择 → 换来了整棵树只有一种节点类型、平台契约保持单一，动作入口（登录/刷新/打赏）天然就能带"点击命令" → 代价是节点构造函数很重，占位项要用一份"伪数据"先构造再覆写图标/命令，且占位项的标识每次都随机，平台难以复用其 DOM（每次刷新都重建）。

- **最小心智模型（3～7 步）**：
  1. 某个时机（构造时 / 用户点刷新 / 用户提交搜索词）触发"加载编排"。
  2. 编排先问"浏览器能不能创建"——不能就清空数据、发事件、停下。
  3. 再用"是否正在加载"做防重入闸门，避免并发重复拉取。
  4. 置"加载中"状态、发事件 → 回调此刻返回"加载中"占位节点。
  5. 真正拉取：热榜走轻量 HTTP + HTML 解析；推荐/搜索/关注走真实浏览器开页面、模拟滚动、在页面上下文里提取。
  6. 拉到的结果写回那份共享内存的对应列表，置"非加载中"，再发事件。
  7. 回调被重新询问，按当前状态返回"打赏入口 + 数据项 + 尾部动作按钮"；点任一数据项即触发"打开详情"命令（交由下一章）。

- **最小原理演示（替代旧"复刻范围"）**：
  - **应演示**：一个几十行的独立脚本，演透两条原理——①**状态机渲染**：一个"取子节点"函数，按 `配置无效 → 未登录 → 加载中 → 有数据 → 失败` 的优先级返回不同的节点数组；②**事件驱动重渲染**：外部改一份共享状态后调用一次"发事件"，注册在事件上的监听者就重新调用该函数、打印新的节点列表。再演第 1 条权衡的支线：即便数据本身用"轻量拉取"模拟，也要先判 `canOpenDetail` 闸门——为 false 时即便能拿到数据也不展示，而是展示"请先配置详情引擎"。演示应明确"这段演的是'状态→节点'映射 + 事件驱动重算 + 轻重闸门"，而非演爬虫细节。
  - **应故意省略**：真实 HTTP 请求 / 真实浏览器 / HTML 选择器解析 / 富文本悬浮提示构造 / 点赞收藏等写操作集成 / 多种内容类型（问题/文章/想法）的字段差异 / 工程化的打赏入口与图标主题。不追求能真爬，只追求演透"侧边栏是状态的投影"。
  - **演示载体建议**：本仓库是 VSCode 扩展（TS），机制依赖宿主的树视图契约与事件发射器，**强求真跑扩展没必要**。建议写成一段**独立 TS/JS 脚本**，自己 mock 一个极简"事件发射器"（维护监听者数组、`fire()` 时逐个回调）和一份"共享状态对象"，把"取子节点"回调写成纯函数 of 状态——`node` 直接跑 `node demo.ts`（或 `bun run`）即可观察"改状态 → 发事件 → 节点列表变了"的轨迹。一句话原则：**载体服务于"演透原理"，不是服务于"能跑扩展"。**

- **正文不宜展开的细节**：富文本悬浮提示的大段 Markdown 拼接（图片宽度随显示模式缩放、关注信息/热度值的排版）；问题/文章/想法三种内容类型各自的 DOM 选择器与字段抽取（极其依赖知乎前端结构、易过时）；"滚动加载更多"里轮询骨架屏/加载元素的等待策略；点赞/收藏/不感兴趣的 API 调用细节（属于写操作客户端章）；图片 URL 的 `//` → `https:` 补全等边角；四个列表各自的状态栏标题计数文案。

- **推荐的一个执行轨迹例子**：以热榜为例——①构造即触发加载 → ②浏览器闸门通过、置"加载中"、发事件 → **侧边栏显示「正在加载知乎热榜…」一个占位节点** → ③Cookie 清洗后发一次轻量 HTTP 请求、解析回 50 条、写回共享内存、置"非加载中"、再发事件 → **侧边栏变为「打赏入口 + 50 个内容节点」** → ④使用者点某节点 → 触发"打开详情"命令，把该节点交给下一章的详情爬取。失败支线：HTTP 返回 403 → 判定 Cookie 失效、弹更新提示、发事件 → **侧边栏显示「获取热榜失败，点击刷新按钮重试」占位节点**，使用者一点即可重试。

> 以上钩子供 Writer 写「动机→核心思想→心智模型→关键权衡→原理演示」；下面事实部分供核对，不要被 Writer 当目录照抄。

## 概念要点

- **四个列表共用同一套骨架**：每个列表都是一个实现编辑器树数据提供者契约的类，内部结构几乎一致——一个状态变更事件发射器 + 一个只读事件、一个状态栏加载项、一个"能否创建浏览器"布尔、一个树视图引用、构造时触发加载、`refresh/reset/refreshView` 三件套、一个"加载编排"私有方法、一个真正拉取的方法、`getTreeItem` 直返、`getChildren` 状态机。差异只在"用什么拉取""解析什么 DOM""何时自动加载"。源码位置: src/core/zhihu/sidebar/hot.ts:13-36、recommend.ts:15-38、search.ts:15-35、follow.ts:15-39

- **【核心反差】热榜用轻量 HTTP + HTML 解析，却先过浏览器闸门**：热榜注释明确写道"虽然热榜是用 fetch + cheerio 来加载列表的，但最好还是等待 puppeteer 能正常启动再去加载……只加载了热榜列表却点不开，加载列表就没意义了"。因此即便列表本身不需要浏览器，加载第一步仍是 `canCreateBrowser()` 校验，失败则清空列表、发事件、直接返回。源码位置: src/core/zhihu/sidebar/hot.ts:82-99（注释与闸门）、hot.ts:139（"使用 fetch 请求代替 Puppeteer，避免与推荐页面冲突"）、hot.ts:88

- **热榜的轻量请求仍要伪造一整套浏览器请求头**：`fetch("https://www.zhihu.com/hot")` 带完整 `Sec-Ch-Ua / Sec-Fetch-* / User-Agent / Referer / Cookie`，响应文本用 `cheerio.load` 解析服务端渲染的 `.HotList-list section.HotItem`，并用 `.SignFlow-submitButton` 是否存在做登录墙 DOM 探测。源码位置: src/core/zhihu/sidebar/hot.ts:165-217（请求头 166-185、解析 219-287、登录墙 204）

- **推荐/搜索/关注改走真实浏览器**：三者都 `PuppeteerManager.createPage()` 开页 → `page.goto` → `simulateHumanScroll` → `CookieManager.checkIfPageHasLoginElement(page)` 反判失效 → `scrollToLoadMore` → `page.evaluate` 在页面上下文里提取。理由是这些页面是动态渲染的 Feed 流，轻量 HTTP 拿不到完整内容。源码位置: src/core/zhihu/sidebar/recommend.ts:167-227、search.ts:146-213、follow.ts:183-245

- **getChildren 是状态机，不是数据容器**：四个列表的 `getChildren(element?)` 都遵循同一优先级——①有 element 返回空（无子项）→ ②自定义浏览器路径无效 → ③不能创建浏览器 → ④未设置 Cookie → ⑤正在加载 → ⑥有数据 → ⑦失败重试。每层返回的都是"占位/动作节点"或数据节点。源码位置: src/core/zhihu/sidebar/hot.ts:321-426、recommend.ts:646-763、search.ts:548-673、follow.ts:1143-1301

- **事件驱动重渲染**：所有刷新都遵循"改共享内存里的 list/isLoading → `_onDidChangeTreeData.fire()` → 平台重新调用 getChildren"的循环；`fire()` 不带参数即刷新整棵树。`refreshView()` 只发事件不重拉数据，`refresh()` 重拉，`reset()` 清空数据再发事件。源码位置: src/core/zhihu/sidebar/hot.ts:60-78（refresh/reset/refreshView）、hot.ts:107-136（编排里的多次 fire）

- **统一数据形状 LinkItem**：四个列表解析出的都是同一种 LinkItem——通用字段 `id/url/title/excerpt`，热榜独有 `hotValue`，`type` 区分 `question/article/thought`，`contentToken` 供写操作（不感兴趣/收藏），`answerUrl` 供"在浏览器打开特定回答"，关注列表额外塞 `followInfo`，想法额外塞 `thoughtInfo`。源码位置: src/core/types/index.ts:90-164

- **TreeItem：数据节点的全部呈现逻辑集中于此**：构造时据配置项 `mediaDisplayMode` 与图片有无决定图标（远程图片 URI 或主题图标），拼一个大 MarkdownString 悬浮提示（含关注信息/热度/摘要/预览图），设 `command = zhihu-fisher.openArticle(listItem)` 使点击即打开详情，并设 `contextValue`（如 `TreeItem/TreeItemWithImage/ThoughtItem/FollowedQuestion`）控制右键菜单显隐。源码位置: src/core/types/index.ts:454-682（命令绑定 665-669、contextValue 672-680）

- **StatusTreeItem：占位节点的双重职责技巧**：继承自 TreeItem，构造时先造一份伪 LinkItem（`id = status-${Date.now()}-${Math.random()}`、`url=""`）调父类构造，再覆写 `iconPath/tooltip/command`，`contextValue="StatusTreeItem"`。这样"加载中/点我登录/点我重试/打赏/刷新"等动作入口与数据项共享同一种节点类型，且天然可带点击命令。源码位置: src/core/types/index.ts:687-730（伪项 694-700）

- **加载时机与页面生命周期的列表间差异**：热榜构造即自动加载、用 HTTP 无页面可关；推荐构造即自动加载、用完即 `page.close()`；**搜索构造时不自动加载**（等用户输入关键词）、finally 里关页；**关注构造时不自动加载**（需手动点"点击加载关注动态"）、且**故意不关页面**以便后续增量加载更多，clearList 时才关页。差异根源是"是否需要保留页面做增量加载"。源码位置: search.ts:29-35（不自动加载）、follow.ts:36-39（不自动加载）、follow.ts:239-244（不关页面注释）、follow.ts:1122-1135（clearList 关页）

- **canCreateBrowser 一致性策略不统一（代码异味）**：热榜/推荐在"加载编排"里设实例字段 `canCreateBrowser`，getChildren 读该字段；搜索在 getChildren 里每次现 `await isBrowserAvaliable()`；关注初始乐观置 `true`、构造后异步 `checkBrowserCapability()` 修正。三者对"何时/多新鲜地校验浏览器能力"策略不一致（事实）。源码位置: hot.ts:88 与 hot.ts:343、search.ts:61-63 与 search.ts:570-571、follow.ts:26 与 follow.ts:42-45

## 关键调用链

**加载主链（以热榜为例）**：
构造() → getSideBarHotList() → PuppeteerManager.canCreateBrowser()【闸门】→ isLoading 防重入 → 设 isLoading=true + 状态栏 show + fire()【展示加载中】→ getHotList() → CookieManager.filterZhihuOnlyCookies(removeBECFromCookie(cookie))【清洗，承前第2章】→ fetch(zhihu/hot, 伪造头) → cheerio.load → 解析 HotItem[] → Store.Zhihu.hot.list = list → isLoading=false + 状态栏 hide + fire()【展示数据】→ （用户点节点）TreeItem.command → zhihu-fisher.openArticle(listItem)【交下一章】

**渲染链（getChildren 状态机，四列表同构）**：
getChildren(element?) → [element? 空 : 继续] → 路径无效? → !canCreateBrowser? → !isCookieSet? → isLoading? → list.length>0? [打赏 + 数据项 (+ 尾部刷新/加载更多)] : [失败重试占位]

**动态页拉取链（推荐/搜索/关注共用）**：
createPage() → page.goto(url, waitUntil) → setPageInstance(name, page) → simulateHumanScroll() → checkIfPageHasLoginElement(page)【失效探测，承前第2章】→ scrollToLoadMore() → page.evaluate(在页面上下文解析 DOM → LinkItem[]) → Store.Zhihu.{x}.list = 结果

源码位置: 加载主链 hot.ts:81-137 / 140-305；渲染链 hot.ts:321-426；动态页拉取链 recommend.ts:155-242、search.ts:133-213、follow.ts:171-245

## 源码摘录（带行号，全文累计 ≤ 30 行）

**摘录 A —— 灵魂注释 + 浏览器闸门（轻量拉取却过重闸门的核心反差）**，源码位置: src/core/zhihu/sidebar/hot.ts:82-99
```ts
// 虽然热榜是用 fetch + cheerio 来加载列表的，但最好还是等待 puppeteer 能正常启动再去加载。
// 不然就容易出现困惑，明明热榜加载出来了，但是点不开文章啥的。
// 因为加载文章也需要 puppeteer，只加载了热榜列表却点不开，加载列表就没意义了。
this.canCreateBrowser = await PuppeteerManager.canCreateBrowser();
if (!this.canCreateBrowser) {
  Store.Zhihu.hot.isLoading = false; Store.Zhihu.hot.list = [];
  vscode.window.showErrorMessage("无法创建浏览器实例，热榜加载失败…");
  this._onDidChangeTreeData.fire(); return;
}
```

**摘录 B —— 轻量 HTTP 却要伪造一整套浏览器请求头**，源码位置: src/core/zhihu/sidebar/hot.ts:165-204
```ts
const response = await fetch("https://www.zhihu.com/hot", { method: "GET", headers: {
  Cookie: cleanCookie, Referer: "https://www.zhihu.com/",
  "Sec-Ch-Ua": '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"',
  "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Site": "same-origin",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) ... Chrome/122.0.6261.95 Safari/537.36",
}});
const $ = cheerio.load(await response.text());             // 服务端 HTML 解析
const isNeedLogin = !!$(".SignFlow-submitButton").length;  // DOM 登录墙探测
```

**摘录 C —— getChildren 状态机（同一回调按状态优先级返回不同节点）**，源码位置: src/core/zhihu/sidebar/hot.ts:326-413
```ts
if (isUserSetCustomPath && !isUserChromePathValid)
  return [new StatusTreeItem("自定义浏览器路径无效…", errorIcon, {command:"…setCustomChromePath"})];
if (!this.canCreateBrowser)
  return [new StatusTreeItem("点我配置爬虫浏览器", errorIcon, {command:"…configureBrowser"})];
if (!isCookieSet)      return [/* 扫码登录 + 手动设置Cookie 两个占位节点 */];
if (Store.Zhihu.hot.isLoading)
  return [new StatusTreeItem("正在加载知乎热榜...", loadingIcon, null)];
if (list.length > 0)   return [sponsorItem, ...list.map(i => new TreeItem(i, None))];
return [new StatusTreeItem("获取热榜失败，点击刷新按钮重试", errorIcon, {command:"…refreshHotList"})];
```

**摘录 D —— StatusTreeItem：用伪 LinkItem 复用 TreeItem，实现"占位节点=数据节点"双重职责**，源码位置: src/core/types/index.ts:694-729
```ts
const statusItem: any = { id:`status-${Date.now()}-${Math.random()}`, title:label, excerpt:"爬虫读取中…", url:"" };
super(statusItem, vscode.TreeItemCollapsibleState.None);   // 复用 TreeItem 全部呈现逻辑
if (icon) this.iconPath = icon;
if (command) this.command = command; else this.command = undefined; // 占位项可带点击命令
this.contextValue = "StatusTreeItem";
```

（以上 4 段累计约 28 行）

## 易混淆 / 边界 / 推断

- **事实**：热榜解析依赖服务端渲染的 `.HotList-list / section.HotItem` 选择器，推荐依赖 `.TopstoryItem-isRecommend .Feed`，搜索依赖 `.List-item`，关注依赖 `.Card.TopstoryItem.TopstoryItem-isFollow .Feed`——任一处知乎改版即失效；这是 HTML 抓取的固有脆弱性。源码位置: hot.ts:223-227、recommend.ts:248-250、search.ts:229、follow.ts:302-306

- **事实**：四个 provider 高度重复（事件发射器、状态栏、canCreateBrowser、updateTitle、refresh/reset/refreshView、getChildren 状态机几乎逐字相同），却**没有抽取公共基类**——维护时改一处要同步四处。源码位置: hot.ts:13-36 vs recommend.ts:15-38 vs search.ts:15-35 vs follow.ts:15-39

- **事实**：`scrollToLoadMore` 的实现因列表而异——推荐轮询 `section.skeleton` 骨架屏且高度不变时自动延长滚动次数（上限 7），关注轮询 `.ContentItem-loading/.Skeleton` 且固定滚 3 次 + 尾部再等 1.5s，搜索只比高度变化不查骨架屏。源码位置: recommend.ts:424-480、follow.ts:787-846、search.ts:503-530

- **事实**：关注列表最复杂——解析 4 种内容（question/answer/article/pin想法），加载前先循环点击所有"展开更多"按钮（上限 10 轮）展开折叠动态，再用 `filterFollowItems` 按"hideFollowUpVotes"配置过滤掉"赞同了/喜欢了"等纯互动动态（只留回答/文章/想法/发布了想法），并支持 `loadMoreFollowContent` 复用保留的页面做增量合并。源码位置: follow.ts:248-295（点展开）、follow.ts:749-784（过滤）、follow.ts:1019-1120（增量加载）

- **事实**：搜索的 `parseSearchResults` 在页面上下文里定义两个内嵌函数 `parseArticleItem / parseQuestionItem`，对每个 `.List-item` 先试专栏文章、不中再试问题回答，用 `items.some(id===)` 去重；推荐也用同样手法去重。这是在浏览器上下文里做"类型判别 + 去重"的惯用法。源码位置: search.ts:234-286、recommend.ts:323-327

- **推断**：StatusTreeItem 用 `Date.now()-Math.random()` 生成 id，每次 `fire()` 后 getChildren 重建占位节点都会产生新 id，平台难以按 id 复用该节点 DOM，表现为占位节点每次刷新都是全新节点（推断，未在源码中明说）。

- **推断**：热榜的 `getChildren` 读实例字段 `canCreateBrowser`（只在"加载编排"时刷新），意味着若用户在加载之后才配好浏览器，热榜视图不会自动反映——需手动 refresh；而搜索的 getChildren 每次现 await 校验，能即时反映。这是两者体验差异的根因（推断自源码结构）。

- **未理解**：热榜 `hotValue` 解析里有 `hotValue.includes("}") ? hotValue.split("}")[1] : hotValue` 这段（hot.ts:264-268），推测是为剥离某段热榜度量值的前缀标记，但源码未注释说明该 `}` 标记的来源，存疑。
# 详情页爬取与反爬内容提取 · 源码精读

## 给 Writer 的教学钩子（必填，8 子项缺一不可）

- **用户痛点 / 场景**：在 VSCode 里点开一条知乎内容，想要的是「正文、作者、点赞、我投没投过票、下面还有哪些回答、甚至 AI 给我讲讲这词啥意思」。但知乎对纯 HTTP 请求反爬极严——直接抓接口多半 403、拿不到 JS 渲染后的懒加载回答、投票态也只在登录后的页面 DOM 里才有。用户要的是「像登录态浏览器里看到的那样」，而不是一段干瘪的原始 HTML。

- **一句话核心思想**：借一台已经伪装登录好的真实浏览器，钻进它渲染好的页面里把数据抠出来，再给「动态、会残留、会缓存旧结果」的页面配上一致性护栏。

- **设计动机（为什么需要它）**：纯 HTTP 拿不到 JS 渲染后的内容、也绕不过反爬；必须复用真实浏览器已渲染的 DOM 上下文作为数据源。本章把这套思路落地成**两个对等的实例**——「详情页结构化提取」与「知乎直答 AI 提取」——它们共用同一个核心思想，却各自长出一套不同的一致性护栏，恰好对照出「在页面上下文提数据」要付出的代价。
  - 承前关系（供 Writer 跨章去重）：那台「真实浏览器」本身——单例 Chrome、5 次重试启动、隐藏自动化标记、伪造 UA、注入 Cookie、模拟人类滚动、孤立页面清理——**（已在第 3 章『防反爬浏览器引擎』讲透，本章只看它的新侧面：拿到伪装好的页面之后，如何在页面上下文里把数据抠出来、并加一致性护栏保证结果归属正确）**。Cookie 失效探测（DOM 登录墙）**（已在第 2 章『Cookie 凭证的清洗与校验』讲透，本章只复用它做"爬到一半发现登录态没了"的早退判断）**。webview 与浏览器页面实例的映射、随面板关闭的生命周期清理**（已在第 1 章『全局共享状态容器』讲透，本章只看它如何支撑页面实例随详情页生命周期被创建与归还）**。本章**不重讲**浏览器如何启动伪装、Cookie 如何清洗、单例容器如何设计。

- **关键权衡（本章核心，4 条）**：
  1. **选择「在真实浏览器页面上下文里执行脚本提数据」，而非 HTTP 抓包或官方接口** → 换来了「能拿到 JS 渲染后的完整 DOM：懒加载出来的后续回答、当前账号的投票态、动态弹出的 AI 面板；并天然绕过知乎对纯 HTTP 的反爬」 → 代价是「每个详情页要占一个完整的浏览器页面实例（重资源），而且页面是动态的——会残留旧弹窗、会缓存上一轮结果、会异步加载——必须再叠加一致性护栏，生命周期清理负担重」。
  2. **详情页用「每批 N 条（默认 10）上限 + 递归模拟滚动」分批加载，而非一次性滚到底** → 换来了「单次会话请求量可控，降低被知乎判为异常流量、把签名 Cookie 烧到失效的风险；用户也能尽快看到首批回答」 → 代价是「必须同时维护去重（按回答 id 去重）、到底探测（滚动前后页面高度不变即止）、页面被关断时中断递归这三道护栏，且要在快读到末尾时再预触发下一批，衔接逻辑变复杂」。
  3. **AI 直答用「先关旧面板 + 查询关键词校验」两道护栏判定结果归属，而非简单等"完成回答"字样出现** → 换来了「能可靠区分『本次查询的新结果』与『上一轮残留 / 浏览器缓存的旧 AI 答案』，避免把旧答案误弹给用户」 → 代价是「轮询要同时驱动一个状态机（面板出现 → 思考中 → 完成）并引入一个"关键词未匹配"中间态继续等，且每次必须先同步关闭旧面板并等它从 DOM 消失，交互链路更长」。
  4. **AI 直答失败时「新开一个临时源页重试」，而非在当前页硬等或直接报错** → 换来了「当前页 DOM 漂移或 AI 入口未渲染时，能用源回答页重建上下文再点一次，抬高成功率」 → 代价是「多消耗一个页面实例且必须保证最终被关闭；重试仅对"未找到/未出现"这类错误生效，其它错误直接放弃，护栏判定面有限」。

- **最小心智模型（6 步）**：
  1. 详情页与 AI 直答，都从那台单例真实浏览器「借」一个已经伪装登录好的页面。
  2. 导航到目标地址，等 DOM 就绪——给一个较短的网络空闲宽限，超时也不致命（知乎长连接很多，死等会永远等不到）。
  3. 在页面上下文里执行脚本，把已渲染的 DOM 抠成结构化数据（回答列表 / AI 答案块）。
  4. 多回答场景：模拟滚动触发懒加载，比较滚动前后页面高度判断是否到底。
  5. 套一致性护栏：详情页用「按 id 去重 + 每批上限」；AI 直答用「先关旧面板 + 关键词校验」，必要时换临时源页重试。
  6. 结果回传给前端渲染；面板关闭时中断正在进行的递归并把页面实例归还 / 清理。

- **最小原理演示（替代旧"复刻范围"）**：
  - 应演示：一个**只表达核心思想**的骨架——「借一个伪装页面 → 页面上下文提数据 → 滚动懒加载 + 批次上限护栏」与「模拟点击 AI 入口 → 两阶段轮询 + 关键词校验护栏」两条线，每一条都对应上面某个权衡点（护栏一/二 vs 护栏三/四）。
  - 应故意省略：VSCode webview 面板创建与 postMessage 双向通信（属下一章）、伪装系统、评论分页、文章/想法解析的诸多 DOM 细节、marked 渲染、错误页 HTML、导出 Markdown、盐选版权警告等工程化分支。
  - 演示载体建议：本仓库主语言是 TS、机制跑在「VSCode 扩展宿主 + Puppeteer」里。建议演**机制骨架**而非真跑扩展——写一个独立 Node 脚本（puppeteer 打开一个真实可渲染页面，或用一段静态 HTML + 定时器模拟懒加载与 AI 面板的"思考中→完成"），把「页面上下文提数据、滚动前后比高度、批次到上限即停、关键词校验拒绝旧缓存」这四步演出来即可。能跑最好（需装 puppeteer），非硬要求；宿主交互（把结果回传弹窗）可用脚本里打印代替，不强求真跑扩展。一句话原则：**载体服务于"演透原理"，不是服务于"能跑"。**

- **正文不宜展开的细节**：盐选付费内容的字体反爬与版权警告 HTML；想法（pin）页独有的链接卡片提取；专栏文章与问题的标题回填；点赞数「1 万」中文单位解析；投票态按钮的多套选择器兼容；媒体（图/动图/视频）占位符与跨域 referrer 处理；导出 Markdown 与统计；下载媒体文件；这些是工程化边角，供 Writer 裁剪不写。

- **推荐的一个执行轨迹例子**：
  - 详情页批次加载：输入「一个声称有 50 个回答的问题页，每批上限 10」。中间态：导航 → 首次在页面上下文抠出首批若干回答（按 id 去重入列）→ 模拟滚动 → 页面高度变大 → 再次抠取（只追加新 id）→ 本批新增累计到 10 触发上限即停。输出：回答列表含首批 + 10 条新增，导航计数显示「已加载 X / 50」，批次标志复位；用户继续翻到接近末尾时再触发下一批。
  - AI 直答：输入「点击被改写过的某个直答关键词链接」。中间态：关闭可能存在的旧面板并等其消失 → 在当前回答页里找到该链接并点击 → 等面板出现 → 等思考中 → 轮询直到"完成回答"出现**且**面板查询块文本包含本次关键词（否则视为旧缓存继续等）→ 取走答案 HTML。输出：把成功 / 错误状态回传前端弹窗；若中途报"未找到"则换源回答页重试一次。

> 以上钩子供 Writer 写「动机 → 核心思想 → 心智模型 → 关键权衡 → 原理演示」；下面事实部分供核对，不要被 Writer 当目录照抄。

## 概念要点
- **两个实例共用一个核心思想**：都从单例真实浏览器借页面、都在页面上下文里 `page.evaluate` 抠数据。详情页走 `WebviewManager`，AI 直答走 `ZhidaManager`。源码位置: src/core/zhihu/webview/index.ts:19, src/core/zhihu/zhida/index.ts:21
- **入口按内容类型分派**：打开详情页时按 `item.type` 分到三条爬取路径——文章 / 想法 / 问题（URLData）。源码位置: src/core/zhihu/webview/index.ts:233-239
- **借页面 = 复用第 3 章那台已伪装的 Chrome**：`createPage` 先确认单例浏览器可创建，再 `browser.newPage()`，设 UA、注入（已去 BEC 的）Cookie、在新文档里把 `navigator.webdriver` 抹掉——这三步伪装是第 3 章核心，本章直接复用。源码位置: src/core/zhihu/puppeteer/index.ts:416-456
- **页面与 webview 绑定**：借到页面后立刻按 webviewId 存进全局页面映射，之后 AI 直答、加载更多、激活前置都靠这个映射取回同一个页面，避免重复借。源码位置: src/core/zhihu/webview/index.ts:448-449；映射定义 src/core/zhihu/puppeteer/index.ts:397-411
- **网络空闲只等 5 秒、超时不致命**：注释明说知乎长连接多、可能永远等不到空闲，于是把 `waitForNetworkIdle` 当成"最多等 5 秒"的强制等待，超时也继续读页面。源码位置: src/core/zhihu/webview/index.ts:472-481（问题页）、785-794（文章页）
- **Cookie 失效早退**：DOM 登录墙探测（第 2 章机制）复用为"爬到一半发现登录态失效就换登录提示页"。源码位置: src/core/zhihu/webview/index.ts:521-528
- **问题页结构化提取**：一次 `page.evaluate` 遍历所有 `.List-item`，把每个回答抠成结构化对象——回答 id（`name` 属性）、作者（多枚举 itemprop meta）、点赞 / 评论数、发布与更新时间、投票态（赞同 / 不赞同按钮的 active class）、正文 innerHTML、盐选付费标记。源码位置: src/core/zhihu/webview/index.ts:2196-2429
- **正文经 marked 转一次**：抠到的内容字符串会过一次 markdown 解析器再入列。源码位置: src/core/zhihu/webview/index.ts:2442
- **去重护栏**：用已加载回答的 id 集合（Set）跳过重复；若是"特定回答模式"预加载过的目标 id，则更新而非重复追加。源码位置: src/core/zhihu/webview/index.ts:2432-2488
- **懒加载递归三段式**：模拟人类滚动 → 比较滚动前后 `document.body.scrollHeight`（不变即到底）→ 重新解析回答 → 查批次上限；递归前后与滚动后各查一次"页面是否已被关"以中断。源码位置: src/core/zhihu/webview/index.ts:2525-2673
- **到底探测会修正总数**：滚动到底时以实际已加载数覆盖页面声称的总回答数（页面显示数与实际偶尔不符）。源码位置: src/core/zhihu/webview/index.ts:2574-2584
- **每批上限来自配置**：`answersPerBatch`（默认 10）读自 VSCode 配置，是"加载体验 vs 烧 Cookie 致失效"那个权衡的唯一可调旋钮。源码位置: src/core/zhihu/webview/index.ts:160-161
- **快到末尾才预触发下一批**：翻下一条 / 跳转时，仅当当前索引接近 `loadedAnswerCount - 5` 才预加载下一批，避免无脑全量加载。源码位置: src/core/zhihu/webview/index.ts:1651-1654, 2047-2051
- **加载失败自愈**：检测到"加载失败了"文案就点"再试试"按钮并等一会；鼠标事件超时一类错误则静默返回。源码位置: src/core/zhihu/webview/index.ts:2084-2146, 2648-2658
- **错误页拦截**：检测到"你似乎来到了没有知识存在的荒原"标题时，清掉页面所有定时器 / 间隔器以阻止 5 秒自动重定向，再展示错误页。源码位置: src/core/zhihu/webview/index.ts:653-722
- **特定回答模式**：带 `answerUrl` 时，先单独预加载该回答放第一位，再导航到"全部回答"页补全。预加载同样走"借页面→页面上下文抠数据"。源码位置: src/core/zhihu/webview/index.ts:42-59, 319-438；预加载实现 src/core/utils/webview-utils.ts:132+
- **生命周期清理**：面板关闭回调里中断加载、清伪装缓存、从全局映射删项、关闭对应页面、清理孤立页面。源码位置: src/core/zhihu/webview/index.ts:3098-3156
- **AI 直答入口在服务端被改写**：渲染前扫描所有 `<a>`，命中直答域的链接被剥掉原 href、关键词被预解析存属性、onclick 被改成本地弹窗函数——把外链劫持成 VSCode 内入口。源码位置: src/core/zhihu/webview/components/content-processor.ts:545-570
- **AI 直答复用当前回答页**：点关键词或"解释这篇内容"时，直接取该 webview 已绑定的那个页面（不开新页），在该页面上下文里完成"点击→等待→抠结果"。源码位置: src/core/zhihu/webview/index.ts:4628-4677, 4682-4735
- **点击用三级兜底匹配**：精确 href → 去掉来源参数模糊匹配 → 用 `q=` 关键词参数匹配，逐步放宽以找到要点的元素。源码位置: src/core/zhihu/zhida/index.ts:153-195
- **两阶段轮询 + 关键词校验**：等面板出现（5s）→ 等思考中状态（3s，确认是新查询）→ 轮询（最长 30s）直到"完成回答"出现**且**面板查询块文本包含本次关键词；关键词不符返回一个"继续等"中间态。源码位置: src/core/zhihu/zhida/index.ts:289-375, 383-402
- **先关旧面板防残留**：每次先点旧面板关闭按钮并等它从 DOM 消失（最多 2s），杜绝抓到上一轮残留。源码位置: src/core/zhihu/zhida/index.ts:407-442
- **失败换临时源页重试**：仅当错误属"未找到 / 未出现"且有源回答页 URL 时，新开一个临时页导航到源页再试一次，最终在 finally 里关掉它。源码位置: src/core/zhihu/zhida/index.ts:36-52, 251-283

## 关键调用链
- 详情页（问题）：`openWebview` →（按 type 分派）`crawlingURLData` → `PuppeteerManager.createPage`/`setPageInstance` → `page.goto` → `waitForNetworkIdle(5s)` → `checkAndHandleZhihuErrorPage` → `CookieManager.checkIfPageHasLoginElement` → `parseQuestionDetail` → `parseAllAnswers`（page.evaluate 一次性抠全部回答 + Set 去重）→ `loadMoreAnswers`（simulateHumanScroll → 比高度 → handleAnswerLoadFailure → parseAllAnswers → 批次上限判定 → 递归）。源码位置: src/core/zhihu/webview/index.ts:277-644, 2149-2673
- 详情页（文章 / 想法）：单次 `page.evaluate` 抠整篇内容并打包成"一个回答"，不再分批。源码位置: src/core/zhihu/webview/index.ts:832-1066, 1221-1567
- AI 直答（关键词）：前端点击被改写链接 → `openZhidaPanel` 消息 → `handleOpenZhidaPanel` → `ZhidaManager.fetchZhidaAnswer(page, href, sourceUrl)` → `closeExistingPanel` → `clickZhidaLink` → `waitAndExtract`（两阶段 + 关键词校验）→（失败且符合条件）`withTemporarySourcePage` 重试 → 回传 `zhidaResult`。源码位置: src/core/zhihu/webview/index.ts:3050-3053, 4628-4677；src/core/zhihu/zhida/index.ts:28-61, 113-131, 289-375
- AI 直答（"解释这篇内容"）：`zhidaSummarize` 消息 → `handleZhidaSummarize` → `ZhidaManager.fetchZhidaSummary` → `clickZhidaSummaryButton` → `waitAndExtract`。源码位置: src/core/zhihu/webview/index.ts:3055-3058, 4682-4735；src/core/zhihu/zhida/index.ts:66-102, 197-249

## 源码摘录（带行号，全文累计 ≤ 30 行）

详情页两道护栏——到底探测 + 每批上限（演权衡 2）：
```ts
// src/core/zhihu/webview/index.ts:2574-2640（精简）
if (scrollHeightBefore === scrollHeightAfter) {           // 护栏①：高度不变=>已到底
  webviewItem.article.loadComplete = true;
  webviewItem.article.totalAnswerCount = webviewItem.article.loadedAnswerCount;
  return;
}
if (afterLoadCount - beforeLoadCount >= limitPerBatch) {  // 护栏②：本批新增达上限=>即停
  webviewItemUpdated.batchConfig.isLoadingBatch = false;
  return;
}
```

AI 直答关键词校验护栏——拒绝上一轮缓存的旧结果（演权衡 3）：
```ts
// src/core/zhihu/zhida/index.ts:316-336（精简）
const result = await page.evaluate((kw: string) => {
  const q = document.querySelector('[data-testid="Block:zhida_answer_query_block"]');
  if (q && kw && !q.textContent?.includes(kw)) return "PENDING_KEYWORD_MATCH"; // 关键词不符=旧缓存
  const btn = document.querySelector('[data-testid="Button:thinking_node"]');
  if (!btn?.textContent?.includes("完成回答")) return null;                     // 还在思考
  return document.querySelector('[data-testid="Block:zhida_answer_result_block"]')
    ?.querySelector(".Render-markdown")?.innerHTML ?? null;
}, keyword);
```

AI 直答入口在服务端被改写（演"页面上下文提数据"的前置：把外链劫持成弹窗）：
```ts
// src/core/zhihu/webview/components/content-processor.ts:546-569（精简）
if (href.includes("zhida.zhihu.com")) {
  let kw = "";
  try { kw = decodeURIComponent(new URL(href).searchParams.get("q") || ""); } catch (_) {}
  if (!kw) kw = link.clone().children().remove().end().text().trim();   // 兜底用链接纯文字
  link.attr("data-zhida-href", href);
  link.attr("data-zhida-keyword", kw);
  link.attr("href", "javascript:void(0)");                              // 原外链失效
  link.attr("onclick", `openZhidaPanel(this.getAttribute('data-zhida-href'), this.getAttribute('data-zhida-keyword'))`);
  return;
}
```

## 易混淆 / 边界 / 推断
- **事实**：文章 / 想法都被打包成"单个回答"塞进回答列表（`answerList = [单个]`），复用同一套渲染逻辑，因此它们不分批、`loadComplete` 直接置真。源码位置: src/core/zhihu/webview/index.ts:1051-1055, 1552-1556
- **事实**：`limitPerBatch` 控制的是"单批新增数"（afterLoadCount − beforeLoadCount），不是"累计数"；递归每轮重新解析全量回答，靠 Set 去重，因此单批新增才等于真正新出现的回答数。源码位置: src/core/zhihu/webview/index.ts:2618-2640
- **事实**：AI 直答默认复用当前回答页（不开新页）；只有"未找到 / 未出现"类错误且提供了源回答页时才开临时页重试，其它失败（如超时、面板未出现）直接返回错误。源码位置: src/core/zhihu/zhida/index.ts:42-52, 251-256
- **事实**：`waitForNetworkIdle` 在不同入口超时策略略有差异——问题 / 文章 / 想法 / 直答临时页都用 5s 上限，但特定回答预加载用的是更严格的 `networkidle2` 且有 15s 的 `waitForSelector` 等待回答元素。源码位置: src/core/zhihu/webview/index.ts:474, 787, 1176；src/core/utils/webview-utils.ts:145-153
- **推断（标注为推断）**：把"每批上限"作为可配置项（而非硬编码），且默认值取较小的 10，应当是为了让用户在"首屏快、烧 Cookie 风险低"与"少点几次加载更多"之间自行权衡——这与摘要所述「在加载体验与烧 Cookie 致失效间取平衡」一致，但代码未见显式注释，属推断。
- **推断（标注为推断）**：AI 直答之所以要先 `closeExistingPanel` 再 `waitForLoadingState`，推断是因为该 AI 面板是单例 DOM——同一容器会被复用，不关旧的就直接点新链接，很可能读到旧内容；这与关键词校验护栏目的一致（防旧结果），但代码未直说，属推断。
- **未理解**：`clickZhidaSummaryButton` 里对回答容器选择器列了 `[name="${id}"]`、`#answer-${id}`、`[data-answer-id=...]`、`[data-record-id=...]` 四套兜底，注释称"DOM 分析确认 name="{answerId}""，但这些备选是否真的都被不同页面形态触发过、孰为主孰为辅，源码无进一步说明，无法确认。
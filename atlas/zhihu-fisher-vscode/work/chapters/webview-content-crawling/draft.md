# 详情页爬取与反爬内容提取

> 本章属于 composite 层。前置：防反爬浏览器引擎、Cookie 凭证的清洗与校验、全局共享状态容器。
> 学完你能：讲清「为什么从一台真实浏览器已渲染好的页面里抠数据，还要再叠上一致性护栏」——以及每条护栏化解的是哪一类矛盾。

## 1. 为什么需要它

上一章把知乎的列表搬进了侧边栏——热榜、推荐、关注、搜索各自一棵树，点开一条算到位了。但「点开一条」之后呢？用户想要的是这一条的详情：正文、作者、点赞、自己投没投过票、下面还有哪些回答、甚至「这词我不懂，AI 给我讲讲」。列表的活儿交差了，详情页的活儿还没开工。

麻烦在于：知乎对纯 HTTP 请求的反爬非常严苛。直接 `fetch` 接口多半 403；正文以下的后续回答靠 JS 滚动懒加载，原始 HTML 里根本没有；登录后的「已点赞 / 已反对」按钮态，只在带着登录态的浏览器渲染出的 DOM 里才存在；「知乎直答」AI 面板更是页面运行时按需弹出来的，连个固定 URL 都没有。换句话说，用户想看到的不是一段干瘪的源 HTML，而是「像他在登录态浏览器里实际看到的那样」。

这就引出本章要解决的矛盾：**怎么从一台已经登录态、已经渲染好的浏览器页面里把数据稳地抠出来——并且在「页面会残留、会缓存、会异步加载」的现实下，让每次抠到的结果都属于这一轮请求，而不是上一轮的影子。**

## 2. 核心思想

借一台已经伪装登录好的真实浏览器，**钻进它渲染好的页面里**把数据抠出来；再针对「页面是动态的」这一现实，配一套**一致性护栏**确保结果归属正确。

「钻进页面里」和「抓接口」不是一回事。前者复用浏览器自己的 JS 运行时，把扩展的脚本送到页面上下文里执行，看到的就是用户看到的那张 DOM；后者只能拿到接口愿意吐回的 JSON，渲染后的 DOM、登录态按钮、运行时弹出的面板全都错过。这条区别决定了本章的两个实例——详情页结构化提取与 AI 直答——本质上是同一个原语，只是各自的失败模式逼出了不同形状的护栏。

## 3. 心智模型

两个对等的实例共用同一条管线：

- **详情页结构化提取**（`WebviewManager`）：把一个问题的所有回答、一篇文章、一条想法抠成结构化对象。
- **知乎直答 AI 提取**（`ZhidaManager`）：在被服务端改写过的链接被点开之后，从同一个回答页里抠出 AI 给的答案块。

两者的管线都是这六步：

1. 从第 3 章那台单例 Chrome 「借」一个已经伪装好的页面（设 UA、注入清洗过的 Cookie、抹掉 `navigator.webdriver`——这些伪装本章不重讲）。
2. 导航到目标地址，等 DOM 就绪。给一段较短的网络空闲宽限（5 秒），超时也不致命——知乎长连接多，死等会永远等不到。
3. 用 `page.evaluate` 把已渲染的 DOM 抠成结构化数据。
4. 多回答场景：模拟滚动 → 比较滚动前后 `document.body.scrollHeight` 判断是否到底 → 重新抠一遍。
5. 套一致性护栏：详情页用「按回答 id 去重 + 每批上限」；AI 直答用「先关旧面板 + 关键词校验 + 失败换源页重试」。
6. 结果回传前端；webview 面板关闭时中断递归，把页面实例归还（这条生命周期管理靠的是第 1 章那个全局页面映射——本章只在它的基础上加「关面板时清理」）。

## 4. 关键权衡

### 在页面上下文里提数据，而非走 HTTP 抓包或官方接口

这是整章的地基。换来的东西很直接：能拿到 JS 渲染后的完整 DOM（懒加载出来的后续回答、当前账号的投票态按钮、动态弹出的 AI 面板），并天然绕过知乎对纯 HTTP 的反爬——对知乎服务器来说，这就是一个真用户在浏览。

代价不是一句话能说完的那种。每个详情页都要占用一个完整的浏览器页面实例，内存与启动开销都不轻；更麻烦的是页面是动态的——会残留上一轮的弹窗、会缓存上一轮的 AI 答案、会异步追加内容——这意味着「提数据」这件事本身没有失败成功可言，**只有「这一次提的是不是这一轮请求的结果」可言**。这条根本代价逼出了下面三条护栏。

### 详情页用「批次上限 + 滚动前后比高度」分批加载，而非一次性滚到底

50 个回答的问题，一次全滚到底会发生什么？短时间内打几十次懒加载请求，知乎风控很容易把这次会话判为异常流量，把签名 Cookie 烧到失效——失效之后整章机制都跑不动了。同时用户也得干等所有回答加载完才能看到第一个。

于是有了两道并行的护栏：**每批最多新增 N 条**（默认 10，可配置），新增累计到上限立即停递归；同时每次模拟滚动后比较 `scrollHeight`，没变就认定到底、并把页面声称的「总回答数」修正为实际加载数（页面显示数与实际偶尔不符）。

化解的本质矛盾是「**单次会话请求量** 与 **签名 Cookie 寿命**」之间的拉锯——这两者本是同向的（多加载必然多请求），靠「批次上限」这个旋钮把「一次会话请求量」拆小，给 Cookie 续命。代价是衔接逻辑变复杂：去重 Set 要跨批次维护、到底探测要修正总数、用户翻到接近末尾时还要再预触发下一批——任何一环漏掉，用户都会看到「卡住了」或「重复了」。

### AI 直答用「先关旧面板 + 查询关键词校验」判定结果归属，而非等"完成回答"字样

AI 直答面板在 DOM 里是**单例**——同一个容器会被反复复用。如果你刚问过 A 问题、现在点开 B 词的直答，面板很可能不会重新初始化，而是先显示着 A 的旧答案、再异步替换为 B 的新答案。光等"完成回答"字样出现是不够的：那个字样可能是上一轮残留，"完成"的是 A。

于是护栏做成两段：先点旧面板的关闭按钮、等它从 DOM 里消失（最多 2 秒）；轮询时除了等"完成回答"，还要校验面板里那个查询块 (`data-testid="Block:zhida_answer_query_block"`) 的文本**包含本次查询关键词**——不符就返回一个「继续等」中间态，让外层循环继续轮询。

化解的本质矛盾是「**DOM 容器复用** 与 **结果归属正确**」之间的冲突——容器复用换来渲染性能与状态连续，代价是「这次显示的内容是不是这次的查询」必须由调用方自己验证。代价是交互链路更长：每轮多一次关旧面板、多一个未匹配中间态。

### 失败时新开临时源页重试，而非当前页硬等或直接报错

AI 入口在某些页面形态下根本不渲染——当前页 DOM 已经漂移了，再怎么轮询都等不到面板。这时硬等就是死循环、直接报错又太可惜。

权衡的做法是：仅当错误属于「未找到 / 未出现」、且调用方提供了源回答页 URL 时，**新开一个临时页**导航到源页再点一次。换的是「在 DOM 还原的上下文里再试一次」的机会，抬高成功率。代价有二：多消耗一个页面实例（必须在 `finally` 里关掉，否则会变成第 3 章警告过的孤立页面）；护栏的判定面也有限——只对「未找到」这类错误生效，超时、面板未出现等失败直接放弃。

## 5. 最小原理演示

下面这个骨架不接 VSCode、不装 Puppeteer，只用一段模拟的 `Page` 对象把核心机制演出来。它故意把「页面的动态行为」（模拟懒加载、模拟 AI 面板从思考到完成、模拟缓存旧答案）和「扩展宿主的护栏逻辑」（批次上限、滚动比高度、先关旧面板、关键词校验）分到两个角色，让两者之间的契约看得见。

```ts
// 一个会被反复复用的浏览器页面：它有懒加载、有单例 AI 面板、还会缓存上一轮答案
class FakePage {
  private answers: { id: number; text: string }[] = [];
  private scrolledHeight = 1000;
  private zhidaQuery = "";
  private zhidaState: "idle" | "thinking" | "done" = "idle";
  private zhidaResult = "";

  constructor(private totalAnswers: number) {
    for (let i = 1; i <= 8; i++) this.answers.push({ id: i, text: `回答 ${i}` });
  }

  async scroll(): Promise<void> {
    if (this.answers.length >= this.totalAnswers) return;     // 触底后高度不再增长
    const n = this.answers.length;
    for (let i = n + 1; i <= Math.min(n + 10, this.totalAnswers); i++)
      this.answers.push({ id: i, text: `回答 ${i}` });
    this.scrolledHeight += 600;
  }
  getScrollHeight(): number { return this.scrolledHeight; }
  getAnswers() { return this.answers; }

  async closeExistingZhida(): Promise<void> { this.zhidaState = "idle"; this.zhidaResult = ""; }
  async clickZhidaLink(keyword: string): Promise<void> {
    // 模拟「先残留着旧答案、再异步替换」的坑：思考完成后再换上新查询的结果
    this.zhidaState = "thinking";
    setTimeout(() => {
      this.zhidaQuery = keyword;
      this.zhidaResult = `<p>这是关于「${keyword}」的新答案</p>`;
      this.zhidaState = "done";
    }, 200);
  }
  getZhidaState() { return this.zhidaState; }
  getZhidaQuery() { return this.zhidaQuery; }
  getZhidaResult() { return this.zhidaResult; }
}

// 详情页线：滚动前后比高度 + 每批上限 + 按 id 去重
async function crawlAnswers(page: FakePage, limitPerBatch: number) {
  const seen = new Set<number>();
  const collected: { id: number; text: string }[] = [];

  for (const a of page.getAnswers()) if (!seen.has(a.id)) { seen.add(a.id); collected.push(a); }

  while (true) {
    const before = page.getScrollHeight();
    await page.scroll();
    if (page.getScrollHeight() === before) break;             // 高度没变 = 到底了

    let added = 0;
    for (const a of page.getAnswers()) if (!seen.has(a.id)) { seen.add(a.id); collected.push(a); added++; }
    if (added >= limitPerBatch) break;                        // 本批新增到上限就停，把控制权交还调用方
  }
  return collected;
}

// AI 直答线：先关旧面板 + 关键词校验拒绝旧缓存
async function fetchZhida(page: FakePage, keyword: string, deadline: number) {
  await page.closeExistingZhida();                            // 先把可能残留的旧面板从 DOM 里清掉
  await page.clickZhidaLink(keyword);

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 50));
    // 完成且查询块文本含本次关键词，才认账——拒绝上一轮缓存的旧答案
    if (page.getZhidaState() === "done" && page.getZhidaQuery().includes(keyword))
      return page.getZhidaResult();
  }
  throw new Error("zhida: timeout");
}

(async () => {
  console.log("—— 详情页线 ——");
  const page = new FakePage(50);
  const got = await crawlAnswers(page, 10);
  console.log(`首批去重后 ${got.length} 条（每批上限 10，到上限即停）`);

  console.log("—— AI 直答线 ——");
  const zpage = new FakePage(0);
  // 假装上一轮已经问过「React」，DOM 里残留着旧答案
  await zpage.clickZhidaLink("React");
  await new Promise(r => setTimeout(r, 250));
  // 这一轮问「Vue」——若没有「先关旧面板 + 关键词校验」，很可能就把 React 的旧答案当成 Vue 的回传
  const html = await fetchZhida(zpage, "Vue", Date.now() + 1000);
  console.log("回传的答案 HTML:", html);
})();
```

跑一下能看到：详情页首批初始 8 条，模拟滚动后新增 10 条、累计 18 条，本批新增触及上限 10 即停——递归不会再往下滚；AI 直答回传的 HTML 里关键词是「Vue」而不是上一轮残留的「React」。两段加起来不到 80 行，演透了「批次上限 + 滚动比高度」与「先关旧面板 + 关键词校验」两组护栏。

## 6. 执行轨迹

以「一个声称 50 个回答的问题页、每批上限 10」为例，详情页这条线的内部状态是这样流转的：

1. 用户在侧边栏点开这条问题。命令分派按 `item.type` 走问题页路径，从全局映射 `pageMap[webviewId]` 取页面（没有就借一个并登记）。
2. `page.goto` 到问题页，`waitForNetworkIdle` 最多等 5 秒——知乎长连接多，超时几乎是常态，超了直接进下一步。
3. 进入 DOM 登录墙探测（第 2 章机制复用）：发现登录态没了，整页换成登录提示页，爬取早退。
4. 首次 `page.evaluate` 遍历所有 `.List-item`，每个回答抠成结构化对象（id、作者、点赞数、投票态、正文 innerHTML 经 marked 转一次）。此时抠到 8 条，全部入列，去重 Set 大小 8。
5. 进入递归懒加载：`scrollHeightBefore = 1000`，模拟滚动 → `scrollHeightAfter = 1600`，高度变化说明有新内容。重新 `page.evaluate` 抠全量，Set 去重后实际新增 10 条，累计 18。**本批新增 ≥ 10 触发上限即停**，递归退出，`batchConfig.isLoadingBatch = false`，批次标志复位。导航计数显示「已加载 18 / 50」。
6. 用户翻到第 13 条左右（接近 `loadedAnswerCount - 5`），预触发下一批，递归重新启动——直到某次 `scrollHeightAfter === scrollHeightBefore` 触底，`loadComplete = true`，`totalAnswerCount` 被修正为实际加载数。

AI 直答这条线，以「在被改写过的关键词链接上点击」为例：

1. 渲染前 `content-processor` 已经把直答域的 `<a>` 改写：原 `href` 失效、`onclick` 改成本地 `openZhidaPanel(href, keyword)`、关键词预解析存属性。用户点击的不是外链，是 VSCode 内的入口。
2. 扩展收到 `openZhidaPanel` 消息，从 `pageMap[webviewId]` 取**当前回答页**（不开新页），调 `ZhidaManager.fetchZhidaAnswer`。
3. `closeExistingPanel`：点旧面板关闭按钮、等它从 DOM 消失（最多 2 秒）。
4. `clickZhidaLink`：三级兜底匹配——精确 href → 去掉来源参数模糊匹配 → 用 `q=` 关键词参数匹配，逐步放宽。
5. 两阶段轮询：等面板出现（5s）→ 等思考中状态（3s，证明新查询在跑）→ 轮询最长 30s。每轮 `page.evaluate` 同时检查：查询块文本是否包含本次关键词（否则返回 `PENDING_KEYWORD_MATCH` 让外层继续等）、「完成回答」按钮是否出现、结果 markdown 是否就绪。
6. 三者俱备，取走结果 markdown 回传 `zhidaResult`。若 30s 超时或面板未出现、且错误属「未找到 / 未出现」、且有源回答页 URL——新开一个临时页 `goto` 到源页再走一次（`finally` 里关掉它）；其它错误直接回传失败。

## 7. 教学简化说明

上面的骨架把很多工程化分支故意省略了：webview 面板的创建与 `postMessage` 双向通信（属下一章）、盐选付费内容的字体反爬与版权警告 HTML、想法页独有的链接卡片提取、专栏文章与问题的标题回填、点赞数「1 万」中文单位解析、投票态按钮的多套选择器兼容、媒体占位符与跨域 referrer、错误页（"你似乎来到了没有知识存在的荒原"）的自动重定向拦截、加载失败时点「再试试」的自愈、特定回答模式的预加载顺序、导出 Markdown 与统计。这些都不影响原理——它们都是边角，不是承重墙。

## 8. 小结

一致性护栏不是锦上添花，而是「在动态页面上下文里提数据」这条路的入场券——没有它们，你抠到的就只是「DOM 此刻恰好长成的样子」，而不是「这一轮请求的结果」。详情页与 AI 直答共用一个核心思想，却因各自的失败模式不同长出了不同形状的护栏——这本身就是这条原理的代价画像。下一章「详情页 HTML 渲染与双向消息」会接住这些抠到的结构化数据：怎么把它渲染成可视的详情页、以及扩展与 webview 怎么用增量 `postMessage` 同步状态而不丢用户的滚动位置与输入态。
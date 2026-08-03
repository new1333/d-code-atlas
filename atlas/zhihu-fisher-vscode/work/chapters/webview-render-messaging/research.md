# 详情页 HTML 渲染与双向消息 · 源码精读

## 给 Writer 的教学钩子（必填，8 子项缺一不可）

- **用户痛点 / 场景**：用户在 VSCode 里读一篇知乎长文，往下滚了很远、展开了几条评论、正在 AI 总结面板里等结果。这时后台又加载出一批新回答——如果每次更新都把整个页面重画一遍，滚动位置会弹回顶部、评论重新收起、AI 面板状态丢失，阅读体验瞬间崩塌。问题本质是：在一个不能装前端框架的 WebView 沙箱里，如何「数据变了」却「页面状态不丢」。

- **一句话核心思想**：**结构性大改动用整页重画，运行时小更新走点对点增量消息**——两条更新路径并存，按「会不会破坏阅读连续性」来选边。

- **设计动机（为什么需要它）**：WebView 只暴露两个口子改前端：一是整体重写 HTML 文档（重建整个 DOM），二是发一条消息让前端自己局部改 DOM。前者简单粗暴但连滚动位置一起清零，后者精细但每个更新点都得手写。本机制把两者拧成一套分工：首屏构建、切换回答这类「DOM 骨架本身要换」的走重画；导航计数、加载态、关注按钮、AI 结果这类「骨架不变、只是某块数据变了」的走增量消息。其中「承前」部分明确：**数据的来源——真实 Chrome 在页面上下文里爬回答、模拟滚动、批次上限、AI 直答两阶段轮询——已在第 6 章『详情页爬取与反爬内容提取』讲透，本章只看这些数据「爬到之后怎么渲染、变了之后怎么不闪地推给前端」这一新侧面**；而渲染与消息共同读写的那块共享内存（webview 映射），**已在第 1 章『全局共享状态容器』讲透，本章只看它作为「渲染输入 + 消息负载源」被两条路径共用的新侧面**。

- **关键权衡（本章核心，4 条）**：
  1. **两条更新路径并存（灵魂权衡）**：选择「整页重画」用于结构性变化（首次加载、切回答、投票、批次结束），「增量消息」用于运行时高频小更新（导航计数、加载态、关注态、AI 结果、评论、问题详情）→ 换来增量路径下滚动位置、输入态、评论展开态、AI 面板状态全数保留，长文阅读连续 → 代价是两套更新逻辑并存，每个更新点都要人工判断该走哪条路；增量消息还得在前端为每条命令各写一段「找元素→改 DOM」的逻辑（一条长长的 if-else 链）；且重画路径（如投票后）仍会丢状态——这是被主动接受的代价。
  2. **服务端字符串拼装 HTML，而非前端框架**：选择在扩展端用「模板字符串 + 占位符替换」把 CSS、各组件 HTML、脚本一次性拼成完整文档注入 WebView，前端不装框架、不打包 → 换来渲染逻辑全在扩展端可控、配置项可就地注入、十来个组件可复用、无前端工程链负担 → 代价是占位符替换很脆（替换顺序敏感、同名字符串要区分「替换一次」还是「替换全部」，容易踩坑），没有虚拟 DOM diff，任何动态变化都只能退回到权衡 1 的增量消息手写。
  3. **相关问题「增量解析 + 去重 + 有变化才推」**：选择在每次滚动加载新回答后重复解析「相关问题」卡片，用集合按问题 id 去重、只把没见过的新问题合并进列表，且仅当确有新增时才发消息 → 换来相关问题列表随阅读深入自动丰富、不重复刷屏、无变化时零消息开销 → 代价是消息负载仍是「全量列表」而非严格 diff（前端需整体重渲染该区块），并非字面意义的「只推新增项」。
  4. **AI 直答用「加载→成功/失败」三态消息协议**：选择对耗时异步操作（AI 总结需在真实浏览器里两阶段轮询）先立即回一条「加载中」消息，让前端马上显示 spinner，拿到结果后再回「成功/失败」→ 换来异步操作可感知、前端可按状态分支渲染（转圈/结果/报错）、整页不刷 → 代价是消息协议必须约定状态字段语义，前端要维护一个迷你的状态机。

- **最小心智模型（3～7 步）**：
  1. 爬取层（前置章）把结构化数据写进共享内存里这条 webview 的「文章对象」。
  2. 首屏：渲染器读取文章对象 + 用户配置，字符串拼出完整 HTML 文档，整体注入 WebView——DOM 骨架建好。
  3. 用户点「下一条回答」这类结构性操作：前端发消息给扩展 → 扩展改共享内存 → 走「整页重画」重建 DOM（滚动归零，接受的代价）。
  4. 后台批次加载、关注作者、AI 总结这类运行时更新：扩展改共享内存 → 走「增量消息」只把变化的数据推给前端。
  5. 前端收到消息，按命令名找到对应 DOM 节点就地修改（不动滚动条、不动输入框）。
  6. 相关问题：每次滚动后再解析 → 集合去重只合入新项 → 有新增才发消息。
  7. AI 总结：前端请求 → 扩展先回「加载中」→ 耗时获取 → 回「成功/失败」。

- **最小原理演示（替代旧「复刻范围」）**：
  - **应演示**：一个极简对比脚本，演透「权衡 1」——同一份页面数据，分别用「整页重画」和「增量消息」两种方式更新一个计数器；重画路径下输入框内容和滚动位置被清零，增量路径下两者都保留。几十行即可，每行对应一个原理点（DOM 重建 vs 局部改 textContent；setHtml 重置一切 vs postMessage 点到点）。
  - **应故意省略**：知乎爬取、反爬、Cookie、Puppeteer、十几个组件的完整渲染、CSS、配置同步、评论分页、伪装——这些都不演，只保留「两条更新路径」的骨架对比。
  - **演示载体建议**：本章是 VSCode 扩展机制，**建议演「机制骨架 + 文字执行轨迹」，不强求真跑扩展**。可写一段独立脚本，用两个对象模拟「宿主侧（扩展）」与「页面前端侧」，宿主侧暴露 `setHtml`（重置一切）和 `postMessage`（点对点）两个方法，前端侧维护「当前 DOM 字符串 + 滚动位置 + 输入态」，分别演示两种更新路径下输入态/滚动的存留差异。一句话原则：载体服务于「演透两条路径的差异」，不是服务于「能跑起一个真扩展」。

- **正文不宜展开的细节**：三十多条消息命令的逐条清单（只举几类代表即可）；媒体显示模式切换后的配置同步回路（靠前端 storage-sync 脚本，超出本章）；HTML 转义的具体字符表；十几套 CSS 的注入清单；错误页/Cookie 过期页的模板内容；导出 Markdown 时 HTML→Markdown 的正则转换；组件占位符替换的完整顺序。

- **推荐的一个执行轨迹例子**：
  - 输入 A（结构性）：用户点「下一条回答」→ 前端发 `loadNextAnswer` → 扩展把当前回答索引 +1 → 调用整页重画 → DOM 重建，滚动归零（接受代价，因为回答主体整个换了）。
  - 输入 B（运行时，对比）：同一时刻后台批次加载又解析出 10 条回答 → 扩展只发一条「导航计数 + 加载完成」的增量消息 → 前端仅更新导航条文字，用户当前的滚动位置和正在展开的评论纹丝不动。两条轨迹并列，正好演透「按是否破坏连续性来选边」。

> 以上钩子供 Writer 写「动机→核心思想→心智模型→关键权衡→原理演示」；下面事实部分供核对，不要被 Writer 当目录照抄。

## 概念要点

- **HtmlRenderer 是纯静态的「服务端渲染器」**：不持状态，4 个静态方法分别产出「加载中 / Cookie 过期 / 错误页 / 文章正文」四类完整 HTML 文档。文章正文那条从共享内存读出文章对象与当前回答，再读 7 项用户配置，组装约 11 个组件后把 CSS、组件 HTML、脚本一次性替换进正文模板。源码位置: src/core/zhihu/webview/html.ts:47,73-103,153-383

- **正文渲染的数据源与配置注入**：当前回答取自 `article.answerList[article.currentAnswerIndex]`；若还没有回答则退化回「加载中」页。媒体显示模式被映射成 CSS 类名（none→hide-media, mini→mini-media）。脚本块也通过占位符注入当前回答索引、已加载数、相关问题数据等运行时参数。源码位置: src/core/zhihu/webview/html.ts:172-183,283-288,315-330

- **WebView 创建配置刻意保留上下文**：开 `enableScripts`、`retainContextWhenHidden:true`（隐藏不重载，保住状态），并用固定 viewType 以避免 localStorage 失效。先注入「加载中」HTML，再注册消息处理，最后才异步爬取。源码位置: src/core/zhihu/webview/index.ts:83-94,208-216

- **两条更新路径的分工（核心）**：`updateWebview` 直接重写 `webview.html`（整页重画，DOM 重建）；`updateNavInfoViaMessage` 走 postMessage 局部更新。代码注释明确点出动机：「通过 postMessage 部分更新 DOM，不用全刷，体验更好」。源码位置: src/core/zhihu/webview/index.ts:243-274

- **isLoaded 门控决定走哪条路**：首次完成解析时 `isLoaded` 为假 → 走整页重画（DOM 还没建）；此后批次加载 `isLoaded` 已真 → 只走增量导航消息。这是「首次全画、之后增量」的开关。源码位置: src/core/zhihu/webview/index.ts:624-629,2507-2512

- **双向消息通道**：扩展→前端用 `webviewPanel.webview.postMessage`；前端→扩展用 `acquireVsCodeApi().postMessage`（前端脚本里以 `vscode.postMessage` 形式大量调用），扩展端用 `onDidReceiveMessage` 的 switch 收敛约 30 余条命令。源码位置: src/core/zhihu/webview/index.ts:2742-3095；前端发送端 src/core/zhihu/webview/templates/scripts/navigation.ts:12-82,media.ts:287

- **扩展主动推送的命令清单（增量更新负载）**：导航计数、相关问题、问题详情、作者关注态（成功/回滚两发）、评论点赞成功/失败、导出弹窗统计、localStorage 恢复、AI 直答结果（多条）。源码位置: src/core/zhihu/webview/index.ts:268,3084-3087,3700-3719,4164-4169,4204-4222,4259-4265,4601-4622,4638-4734

- **前端按命令分支做局部 DOM 更新**：前端一个 `window.addEventListener('message')` 里按命令名找节点就地改：导航计数调函数更新；问题详情直接 `getElementById(...).innerHTML = ...`；评论点赞只改按钮的 disabled/style/data 属性，不重渲染。这正是「增量消息保住状态」的前端侧落地。源码位置: src/core/zhihu/webview/templates/scripts/core.ts:107-259（尤 222-251,136-197）

- **相关问题：page.evaluate 解析 + Set 去重 + 有变化才推**：在真实页面上下文里解析「相关问题」卡片的 itemprop meta（标题/URL/回答数/关注数），从 URL 末端取问题 id；用已存在 id 的 Set 过滤，只 push 新问题；仅 `hasChanges` 为真时才发消息。源码位置: src/core/zhihu/webview/components/related-questions.ts:15-102,109-150

- **AI 直答三态协议**：收到 AI 总结/关键词解释请求后，立即回推 `state:"loading"`，再调用前置章的 ZhidaManager 耗时获取，最后回 `state:"success"/"error"`（带关键词、回答 HTML 或错误信息）。多个失败分支（页面已关、异常）都补发 error 态。源码位置: src/core/zhihu/webview/index.ts:4628-4677,4682-4735

## 关键调用链

首次渲染（结构性，全画）：
`openWebview` → setHtml=getLoadingHtml → (爬取) → `updateWebview` → `HtmlRenderer.getArticleHtml`（读 Store + 配置，拼装组件）→ setHtml=完整文档
源码位置: src/core/zhihu/webview/index.ts:208-213,243-252; src/core/zhihu/webview/html.ts:153-383

批次加载中的运行时更新（增量）：
`loadMoreAnswers` → `parseAllAnswers` → `updateNavInfoViaMessage(false)` → postMessage(updateNavInfo) → 前端 addEventListener → 局部改导航文本
源码位置: src/core/zhihu/webview/index.ts:2541,2512,258-274; src/core/zhihu/webview/templates/scripts/core.ts:222-224

相关问题增量：
滚动 → `parseAllAnswers`/首次 → `RelatedQuestionsManager.parseRelatedQuestions` → page.evaluate → `addRelatedQuestionsWithDeduplication`(Set 去重) → `notifyWebViewUpdateRelatedQuestions` → postMessage(updateRelatedQuestions)
源码位置: src/core/zhihu/webview/index.ts:619,2507-2509; src/core/zhihu/webview/components/related-questions.ts:15-177

AI 直答三态：
前端请求(zhidaSummarize/openZhidaPanel) → `handleZhidaSummarize`/`handleOpenZhidaPanel` → 先 postMessage(loading) → ZhidaManager.fetchZhida* → postMessage(success/error)
源码位置: src/core/zhihu/webview/index.ts:3050-3058,4628-4735

## 源码摘录（带行号，全文累计 ≤ 30 行）

增量导航消息（点出动机的注释）：
```ts
// src/core/zhihu/webview/index.ts:255-274
/**
 * 更新导航信息
 * 通过 postMessage 部分更新DOM，不用 updateWebview 全刷，体验更好
 */
private static updateNavInfoViaMessage(webviewId: string, isLoading: boolean = false): void {
  const webviewItem = Store.webviewMap.get(webviewId);
  if (!webviewItem) { return; }
  webviewItem.webviewPanel.webview.postMessage({
    command: "updateNavInfo",
    loadedCount: webviewItem.article.loadedAnswerCount,
    totalCount: webviewItem.article.totalAnswerCount,
    isLoading: isLoading,
  });
}
```

isLoaded 门控（首次全画 vs 之后增量）：
```ts
// src/core/zhihu/webview/index.ts:624-629
if (!webviewItem.isLoaded) {
  this.updateWebview(webviewId); // 更新WebView内容
  webviewItem.isLoaded = true;
} else {
  this.updateNavInfoViaMessage(webviewId, true); // 通过消息更新导航信息
}
```

相关问题 Set 去重核心：
```ts
// src/core/zhihu/webview/components/related-questions.ts:124-139
const existingIds = new Set(
  webviewItem.article.relatedQuestions.map((q) => q.id)
);
const uniqueNewQuestions = newQuestions.filter(
  (question) => !existingIds.has(question.id)
);
if (uniqueNewQuestions.length > 0) {
  webviewItem.article.relatedQuestions.push(...uniqueNewQuestions);
  hasChanges = true;
}
```

AI 直答三态之首条 loading：
```ts
// src/core/zhihu/webview/index.ts:4691-4696
webviewItem.webviewPanel.webview.postMessage({
  command: "zhidaResult",
  state: "loading",
  keyword: "AI 总结",
});
```

## 易混淆 / 边界 / 推断

- **事实（summary 与代码的出入，须提醒 Writer）**：本章 outline summary 称相关问题 postMessage「只推新增项」，但代码里 `notifyWebViewUpdateRelatedQuestions` 推送的 data 是**全量** `article.relatedQuestions` 列表，并非只含新增。「增量」实际体现在三处：① 解析时机是滚动后增量触发；② 合并时用 Set 只吸收新增；③ 发送有 `hasChanges` 门控（无新增则不发）。Writer 若写「只推 diff」会与代码不符，应表述为「有新增才推送，负载是去重后的全量列表」。源码位置: src/core/zhihu/webview/components/related-questions.ts:156-177

- **事实**：增量消息的「保状态」只对**运行时更新**有效；结构性操作（切回答 `loadNextAnswer`/`loadPreviousAnswer`/`jumpToAnswer`、投票成功后 `handleVoteContent` 末尾的 `updateWebview`）仍走整页重画，会丢失滚动位置与展开态——这是被主动接受的代价，非缺陷。源码位置: src/core/zhihu/webview/index.ts:1648,1711,3669

- **推断**：媒体显示模式切换（`toggleMedia`/`setMediaMode`）只更新 VSCode 配置、不直接 postMessage 已开的 WebView；推测已开页面的媒体模式刷新依赖前端 storage-sync 脚本监听配置变化，或等下次整页重画时由渲染器重新注入。此回路超出本章 sourceFiles，标注为推断，Writer 不宜展开。源码位置: src/core/zhihu/webview/index.ts:2681-2725

- **事实**：前端 `core.ts` 的 message handler 未直接出现 `updateRelatedQuestions` 与 `zhidaResult` 分支，二者应在各自专项脚本（related-questions 脚本、zhida 脚本）里处理；core.ts 只集中处理了导航/问题详情/关注态/评论/导出等。说明前端消息处理是「按域拆分到多个脚本」而非单一大 switch。源码位置: src/core/zhihu/webview/templates/scripts/core.ts:107-259

- **未理解**：`retainContextWhenHidden:true` 与固定 viewType 共同作用时，localStorage 的生命周期精确边界（多面板、面板复用场景下何时真正失效）未在源码内说明，仅一句注释提示「避免 localstorage 失效」。Writer 涉及此处宜保守表述。
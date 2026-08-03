# 评论父子树的游标分页 · 源码精读

## 给 Writer 的教学钩子（必填，8 子项缺一不可）

- **用户痛点 / 场景**：一个热门回答底下可能挂上千条评论、每条评论下面又能再开出几十层回复。如果一次性全拉回来，既慢又容易触发反爬；可如果每翻一页就整片重刷，滚动位置和「展开/收起」状态会全部丢失——读者好不容易翻到第 5 页，手一抖收起评论区，再展开又得从第 1 页重来。

- **一句话核心思想**：把每页拉回来的评论增量攒进一棵持久化的父子树，翻页只换「当前页那一片」，靠「游标续传 + id 去重」让深翻页既不重复、也不丢位置。

- **设计动机（为什么需要它）**：这个机制是为「评论量大、父子两层、又要在阅读器里反复展开收起」这一组矛盾而生。游标续传让人能往深处翻很多页而不偏移；持久化的累积列表加上「展开/收起」状态标记，让人收起再展开不必重新请求；id 去重防止翻页交界处把同一条评论显示两次。
  - 承前关系（跨章去重信号）：评论区的更新本身走的就是「postMessage 增量推一片 HTML」这条通道（**已在第 7 章『详情页 HTML 渲染与双向消息』讲透「以增量消息保住阅读连续性」**，本章不重复讲增量消息本身）。本章只看它的新侧面：评论这种「需要深翻页、还要跨翻页/跨收起持久状态」的场景，如何把游标与累积列表收进共享 Store，从而把同一条增量消息通道复用到最吃状态的地方。
  - 进一步去重：本章用的「Set 按 id 去重后增量合并」手法，与第 7 章『相关问题』的去重合并**同源**。本章的新侧面是——累积列表要跨多页长期存活，去重不再只为合并两批一次性数据，而是为了让「用游标一页页往深处翻」时交界处永不重复。

- **关键权衡（核心原料）**：
  1. **用接口回传的「下一页 URL」当游标续传**（专栏评论这么做）→ 换来「翻多深都不偏移、完全不靠客户端自己算偏移量」→ 代价是这条游标必须随页持久化，且必须配套「直接替换列表、不做缓存」——因为 URL 游标和「累积」一旦配对，反而会错位。
  2. **问题评论 / 子评论把每页结果增量合并进累积列表、用 Set(id) 去重** → 换来「收起再展开、回到上一页都不重发请求、不丢已加载内容」→ 代价是「存储」与「显示」必须强行分离：存的是累积全集，显示的只是当前页那一片；而子评论因为接口返回顺序和页码不一定对得上，干脆「累积只为去重和算总数，显示只给当页新拉的那批」。
  3. **父评论与子评论各维护一套独立游标**（父用上一页/下一页 URL；子用从「下一页 URL」里正则抠出来的续传偏移）→ 换来「两层能各自独立地往深处翻、子评论还能按需在弹窗里懒加载」→ 代价是分页状态结构臃肿（末页/首页标记、上下游标 URL、续传偏移、当前页/每页大小/已加载数/总数等十来个字段），而且三种内容源（问题/专栏/想法）各写一套、连「是不是最后一页」都得用三套不同判法。
  4. **子评论「查看全部」走独立弹窗 + 独立游标，首屏只在父评论下附带几条** → 换来「首屏轻、只有真要深翻时才付请求代价」→ 代价是子评论的存储、展示、游标都与父评论完全分离，弹窗里翻页用的是字符串型续传偏移（可能是非数字 token）而非页码算术。

- **最小心智模型（3～7 步）**：
  1. 刚进入回答：评论区是收起的，只看到一个「加载评论 (N)」按钮；此时累积列表为空、状态标记是「收起」。
  2. 点「加载评论」：按内容源（问题 / 专栏 / 想法）走对应接口拉第 1 页，把结果写进累积列表、把状态翻成「展开」，并把这一页的游标（上下游标 URL 或续传偏移）和「是不是末页」一并存成分页信息。
  3. 翻下一页：用上一页留下的游标续传——专栏直接拿「下一页 URL」；子评论拿「续传偏移」；问题评论用页码反算偏移（因为旧接口没给可靠游标）。
  4. 合并去重：新拉回的评论按 id 与已累积的全集比对，重复的丢掉、新的追加（累积列表只为「去重 / 算总数 / 回看上一页」服务）。
  5. 渲染当前页：只取「当前页那一片」渲染成 HTML，经增量消息推进阅读器——父评论按页切片显示；子评论直接显示当页新拉的那批。
  6. 收起 / 再展开：只翻转状态标记，从已累积的全集里重新切出当前页那一片渲染，全程不发任何网络请求。
  7. 点「查看全部 N 条回复」：打开弹窗，子评论用自己的续传偏移当游标，重复步骤 3～5 独立翻页。

- **最小原理演示（替代旧「复刻范围」）**：
  - 应演示：一个几十行的「父子两层 + 游标续传 + 累积去重 + 当前页切片 + 状态持久」状态机骨架。它演的是权衡 (1)/(2)：游标如何随页推进、累积列表如何靠 id 去重、显示为何只取当前页那一片、收起再展开为何不发请求。每一行都对应上面的某个原理点。
  - 应故意省略：三种内容源的 URL 差异、反爬请求头、HTML 渲染细节、表情包/图片处理、点赞的乐观 UI、弹窗样式、错误处理——这些都不服务于「演透游标分页」。
  - 演示载体建议：本仓库是 TS / VSCode 扩展，但「游标分页状态机」与宿主无关。建议写成一个能 `node` / `bun run` 直接跑的独立脚本，mock 一个会回传「下一页游标」的分页接口，演透「游标推进 + 累积去重 + 切片显示 + 状态持久」即可，不需要真跑扩展或起 WebView。这是典型的「机制骨架 + 文字执行轨迹」就能演透的原理，不必依赖图形界面。

- **正文不宜展开的细节**：三套内容源（问题 root_comments / 专栏 comment_v5 articles / 想法 comment_v5 pins / 子评论 comment_v5 child）的 URL 模板差异；address_text → 评论标签的字段适配；表情包的 cheerio 处理与文本表情递归替换；点赞的乐观 UI 更新；「403 + 错误码 106」判定为「评论区已关闭」的分支；前端那一组全是 postMessage 派发的薄函数（加载评论 / 翻页 / 加载子评论 / 切换状态 / 点赞）。

- **推荐的一个执行轨迹例子**：输入「一个有 95 条父评论、其中某条父评论下有 60 条回复的回答」。
  1. 点「加载评论」→ 拉回父评论第 1 页 20 条，分页信息记下「当前第 1 页、未到末页、留好下一页游标、已加载 20 条」，显示这 20 条。
  2. 点「下一页」→ 用游标拉第 2 页 20 条，去重合并后累积列表变为 40 条，显示切片 [20, 40)。
  3. 收起评论区（只翻状态标记，无请求）→ 再展开，仍显示第 2 页那 20 条（无请求，因为累积列表还在）。
  4. 在某父评论点「查看全部 60 条回复」→ 弹窗拉子评论第 1 页、记下续传偏移；点「下一页」用该偏移续传拉第 2 页，去重合并进子评论累积列表，显示当页新拉的那批。

> 以上钩子供 Writer 写「动机 → 核心思想 → 心智模型 → 关键权衡 → 原理演示」；下面事实部分供核对，不要被 Writer 当目录照抄。

## 概念要点

- 评论区是**两层树**：父（根）评论存在「当前回答」的累积列表里；每条父评论内部又有一个「已加载子评论累积列表」，以及接口首屏附带的少量 `child_comments` 和回复总数 `child_comment_count`。源码位置: src/core/types/index.ts:301-302,438-442；渲染父子两层处 src/core/zhihu/webview/components/comments.ts:591-758。
- 存在**两套形状不同的分页信息**：回答级 `{is_end,is_start,next,previous,totals,loadedTotals,current,limit}`；评论项级在其基础上**多出 `next_offset / previous_offset`**——这就是子评论的「游标」。源码位置: src/core/types/index.ts:306-323,415-436。
- 三种内容源对应**三种翻页策略**（这是全章最值得讲的事实）：① 问题评论＝客户端按页码自算 offset＋累积合并＋按页切片显示＋自己估算 is_end；② 专栏评论＝直接用接口回传的 next/previous URL 续传＋**直接替换列表不做缓存**；③ 想法评论＝按页码自算 offset＋直接替换；④ 子评论＝用从 next URL 抠出的 `next_offset` 续传＋累积去重＋**显示只取当页**。源码位置: 问题 src/core/zhihu/webview/components/comments.ts:2487-2566；专栏 :2090-2280；想法 :2289-2405；子评论 :2631-2766。
- **游标抠取**：子评论接口给的 next/previous 是完整 URL，代码用 `/offset=([^&]*)/` 正则把里面的 offset 参数抠出来，作为下一次请求的 `offset` 原样回传。源码位置: src/core/zhihu/webview/components/comments.ts:1952-1963。
- **状态持久带来「无请求收起/展开」**：`commentStatus` 在 collapsed/expanded 间翻转时，只是从已累积列表里重新切出当前页那一片重渲，不发网络请求；首次加载与翻页才会请求。源码位置: src/core/zhihu/webview/components/comments.ts:2773-2838（切换），渲染切片处 :307-356。
- **前端是「薄 sender」**：templates/scripts/comments.ts 里 `loadComments / loadMoreComments / loadArticleComments / loadAllChildComments / loadMoreChildComments / toggleCommentStatus / likeComment` 全是 postMessage 派发器，`likeComment` 还附带乐观 UI（先改 DOM 再发消息）。真正的分页状态机全在后端。源码位置: src/core/zhihu/webview/templates/scripts/comments.ts:53-192。
- **「评论区已关闭」识别**：接口返回 403 且 `error.code===106 && name==='ForbiddenError'` 时，抛一个带 `isCommentClosed` 标记的错误，上层据此渲染「评论区已关闭」占位，而非当作普通失败。三套接口都各自重复了这段判定。源码位置: src/core/zhihu/webview/components/comments.ts:1576-1589（问题），:1708-1721（专栏），:1879-1892（想法），:2018-2031（子评论）。

## 关键调用链

- 父评论加载：webview 点「加载评论」→ `postMessage(loadComments)` → `CommentsManager.loadComments` → 按 URL 判内容源分流 → `getCommentsFromApi` / `loadArticleComments` / `loadThoughtComments` → 累积合并 + 存游标 → `createCommentsComponent(...).render()` → `postMessage(updateComments)`。源码位置: src/core/zhihu/webview/components/comments.ts:2413-2623。
- 子评论加载：webview 点「查看全部回复」→ `postMessage(loadChildComments)` → `CommentsManager.loadChildComments` → `getChildCommentsFromApi`（从 next URL 抠 next_offset）→ 累积合并进 `total_child_comments` → `createChildCommentsModal` → `postMessage(updateChildCommentsModal)`。源码位置: src/core/zhihu/webview/components/comments.ts:2631-2766。
- 收起/展开：`postMessage(toggleCommentStatus)` → `toggleCommentStatus`（只翻状态、从累积列表切片重渲，无请求）→ `postMessage(updateComments)`。源码位置: src/core/zhihu/webview/components/comments.ts:2773-2838。

## 源码摘录（带行号，全文累计 ≤ 30 行）

子评论：用上一页留下的 `next_offset` 续传，累积去重，但显示只取当页（演权衡 2/4）—— src/core/zhihu/webview/components/comments.ts:2658-2716

```ts
// 翻第 >1 页时，offset 取上一页留下的 next_offset（游标续传）
let offset = page === 1 ? 0 : (parentComment.commentPaging.next_offset || 0);
const { comments, paging } = await CommentsManager.getChildCommentsFromApi(commentId, offset);
if (page === 1) parentComment.total_child_comments = [...comments];
else {                                            // 累积合并
  const ids = new Set(parentComment.total_child_comments.map(c => c.id));
  parentComment.total_child_comments = [...parentComment.total_child_comments,
    ...comments.filter(c => !ids.has(c.id))];      // id 去重
}
const displayChildComments = [...comments];        // 显示只取当页新拉的
```

从 next/previous URL 抠 offset 当游标 + 子评论 is_end 判定 —— src/core/zhihu/webview/components/comments.ts:1952-1970

```ts
const extractOffset = (url) => {                   // 把 API 给的 next URL 里的 offset 抠出来当游标
  if (!url) return null;
  const m = url.match(/offset=([^&]*)/); return m ? m[1] : null;
};
const is_end = responseData.data.length === 0 || responseData.data.length < limit || !responseData.paging.next;
```

专栏：URL 游标续传 + 「直接替换不缓存」配对（演权衡 1）—— src/core/zhihu/webview/components/comments.ts:2116-2207

```ts
if (direction === "previous") requestUrl = currentPaging.previous;   // 游标 = API 上次回传的 URL
else if (direction === "next") requestUrl = currentPaging.next;
currentAnswer.commentList = comments;              // 配套：直接替换，不做缓存
```

问题：累积 + 按页切片显示 + 自估 is_end（旧接口无可靠分页）—— src/core/zhihu/webview/components/comments.ts:2511-2554

```ts
if (page === 1) currentAnswer.commentList = [...comments];
else {
  const ids = new Set(currentAnswer.commentList.map(c => c.id));      // id 去重后累积
  currentAnswer.commentList = [...currentAnswer.commentList, ...comments.filter(c => !ids.has(c.id))];
}
const displayComments = currentAnswer.commentList.slice((page-1)*limit, page*limit); // 显示当前页切片
// 旧接口无可靠分页信息 → is_end 只能自估：loadedTotals>=totals || page>=totalPages || 本页<limit
```

## 易混淆 / 边界 / 推断

- 事实：专栏评论「直接替换、不做缓存」，与问题/子评论「累积合并」正好相反。代码注释给出原因——问题接口是旧版 `root_comments`，**「没有正确的能够使用的分页信息」「用这个接口是因为他没有反爬机制」**，所以只能客户端自己累积 + 自估 is_end；专栏接口给了可靠 next/previous URL，用 URL 游标续传时累积反而会错位，故直接替换。源码位置: src/core/zhihu/webview/components/comments.ts:2207,2544-2548。
- 事实：子评论「累积列表只为去重/算总数，显示却只给当页新拉的」。代码注释明说**「知乎API返回的评论顺序可能和页码不完全对应」**，故不敢从累积列表里按页码切片，只显示当页。源码位置: src/core/zhihu/webview/components/comments.ts:2714-2716。
- 推断：`next_offset / previous_offset` 被声明为 `string | null` 而非 `number`，且抠取后原样回传、不做数值运算——说明知乎子评论的续传游标**可能是非数字 token**，所以全程当不透明字符串处理。源码位置: src/core/types/index.ts:433-435；src/core/zhihu/webview/components/comments.ts:1417,1952-1963。
- 边界（重要）：`updateComments` / `updateChildCommentsModal` 的**消息接收方**（把 HTML 注进对应容器）不在本章 sourceFiles 内——已 grep 确认它位于 `src/core/zhihu/webview/templates/scripts/core.ts`。本章只覆盖「发送方（薄 sender）+ 后端状态机」。
- 未理解：问题评论的 is_end 用「`loadedTotals`（父评论数＋各父评论 `child_comment_count` 之和）>= totals」作判据之一。但 `child_comment_count` 是「回复总数」而非「已加载子评论数」，在子评论未全部展开时，这个和可能虚高，**推断**会让 is_end 偏早置 true（表现为「下一页」按钮提前变灰）。未实测，存疑供 Critic 决断。源码位置: src/core/zhihu/webview/components/comments.ts:2529-2555。
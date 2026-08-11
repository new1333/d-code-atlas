# 评论父子树的游标分页

> 本章属于 composite 层。前置：详情页 HTML 渲染与双向消息。
> 学完你能：用一句话说清「评论分页为什么要把累积列表、当前页切片、独立游标这三件事拆开来做」。

## 1. 为什么需要它（设计动机）

上一章里，长文的滚动位置、媒体模式、相关问题等更新都靠增量 postMessage 推一片 HTML 进 webview，让阅读连续性不被整页重刷打断。但评论区是个新难题——它不光要增量推送，还得**深翻页**和**跨收起再展开保持状态**。

一个热门回答底下可能挂上千条评论，每条评论下面又能再开出几十层回复。如果一次性全拉回来，既慢又容易触发反爬；可如果每翻一页就整片重刷，你翻到第 5 页好不容易收起一条评论想看别的，再展开又得从第 1 页重来——滚动位置丢了、展开/收起状态丢了、刚才正在看的子评论也丢了。

读者真正需要的是：能往深处翻很多页、每次只多花一页的网络代价、翻页交界处不重复、收起再展开不发请求、父评论与子评论还能各自独立地往深处走。「评论量大 + 父子两层 + 要在阅读器里反复展开收起」这一组矛盾就这样摆到了桌面上。

## 2. 核心思想

把每页拉回来的评论增量攒进一棵**持久化的父子树**，翻页只换「当前页那一片」，靠「游标续传 + id 去重」让深翻页既不重复、也不丢位置。

整章都在反复回响这一句——**累积列表是全集，显示只是当前页那一片**。

## 3. 心智模型

数据上有两条独立轨道：

- **父评论轨道**：每个回答挂一份 `commentList`，累积所有已加载的父评论。回答级 `paging` 字段存 `{is_end, is_start, next, previous, totals, loadedTotals, current, limit}` 八个量。
- **子评论轨道**：每条父评论里挂一份 `total_child_comments`，累积这条父评论下已加载的所有回复。子评论的 `paging` 多出 `next_offset / previous_offset`——这是从「下一页 URL」里正则抠出来的字符串游标。

状态机七步走：

1. 刚进回答：评论区收起，只看到「加载评论 (N)」按钮；累积列表空。
2. 点「加载评论」：拉第 1 页、写进累积列表、翻状态为展开、把这一页游标与「是否末页」存进 `paging`。
3. 翻下一页：用上一页留下的游标续传。
4. 合并去重：新拉的评论按 id 与累积列表比对，重复的丢、新的追加。
5. 渲染当前页：只取「当前页那一片」推进 webview。
6. 收起/再展开：只翻状态标记，从累积列表里重新切出当前页那一片渲染，全程零请求。
7. 点「查看全部 N 条回复」：打开弹窗，子评论用 `next_offset` 当游标，在弹窗里独立走步骤 3～5。

## 4. 关键权衡

### 用接口给的「下一页 URL」当游标续传，换得翻多深都不偏移

客户端自己算偏移量（page × limit）很自然，可一旦接口侧的列表有任何插入或删除——比如评论被人新发了一条顶到最前——后端就给不到稳定的「从第 N 条开始」承诺，算出来的偏移就会错位：要么漏掉一条，要么把同一条显示两次。

- **做了什么选择**：专栏评论接口直接用每次回传的 `next` / `previous` 这两个完整 URL 当游标。
- **换来了什么**：翻多深都不偏移，客户端完全不需要自己算偏移，接口直接告诉你「下一页去这里拉」。
- **代价**：这条 URL 游标必须随页持久化保存在 `paging` 里；而且一旦选了它，**就必须配套「直接替换列表、不做累积」**。因为 URL 游标指向的是接口视角的「下一页」、不是客户端累积的下一批，把两者配对反而会错位——所以专栏评论每次翻页都把 `commentList` 整个替换，存的是「当前页」、不是「至今累积」。

这条化解的本质矛盾是：**「客户端的累积视角」与「服务端的不偏移视角」二选一**。要累积的复用与去重，就要客户端算偏移；要不偏移的可靠续传，就要接受服务端的「当前页」语义、放弃累积。同一个项目里，问题评论接口（旧版、没反爬但分页不可靠）选了前者，专栏评论接口（新版、有反爬但分页可靠）选了后者——选择不是审美而是接口逼出来的。

### 累积列表与 Set(id) 去重，换得收起再展开、回到上一页都不重发请求

评论区的「展开/收起」与「翻页」是两条独立的交互线，但都共用同一份显示数据。如果每次操作都重新拉，网络代价大且反爬风险高；如果只缓存「当前页」，收起再展开尚可（同一页内容），但回到上一页就再也回不来了——早就拉过又被丢弃了。

- **做了什么选择**：问题评论与子评论都把每页结果**累积合并**进一份长期存活的 `commentList` / `total_child_comments`，合并前用 `Set(id)` 把重复的丢掉。
- **换来了什么**：收起再展开、翻回上一页，都只是从累积列表里重新切一片出来渲染，全程不发请求；「是不是最后一页」也能基于已加载数量自估。
- **代价**：**存储与显示必须强行分离**——存的是累积全集，显示的只是当前页那一片。尤其是子评论，因为接口返回顺序可能和页码对不上，累积列表只能为「去重」与「算总数」服务，显示却**只敢用当页新拉的那批**，不敢从累积里切片。

这里化解的本质矛盾是：**「为复用而累积」与「为忠实显示而当页即用」之间的拉扯**。问题评论靠页码自算偏移、敢于从累积里按页切片；子评论连页码都不敢信、累积只为去重和计数。同样是「累积」，两个场景对它的依赖程度完全不同。

### 父评论与子评论各维护一套独立游标，换得两层能各自往深处翻

父评论和子评论是嵌套的——一个回答下挂 N 条父评论、每条父评论下又挂 M 条子评论。两层共用一套游标会怎样？「展开第 3 条父评论的子评论」就会污染「父评论翻到第 2 页」的进度；可如果两层完全不收进统一结构，状态又会散落各处、难以持久化。

- **做了什么选择**：回答级 `paging` 存 `{is_end, next, previous, totals, loadedTotals, current, limit}`；子评论级 `paging` 在它基础上多出 `next_offset / previous_offset`——这两个量是从「下一页 URL」里用 `/offset=([^&]*)/` 正则抠出来的字符串。
- **换来了什么**：父评论能按页码自算偏移往深处翻、子评论能在弹窗里用自己的字符串游标独立往深处翻，互不污染；并且 `next_offset` 类型被声明为 `string | null`、全程当不透明 token 处理，即便知乎后台把它换成非数字 token（比如 base64 串）也不会崩。
- **代价**：分页状态结构臃肿——末页/首页标记、上下游标 URL、续传偏移、当前页/每页大小/已加载数/总数等十来个字段全挤在一起；而且三种内容源（问题 / 专栏 / 想法）各写一套，连「是不是最后一页」都得用三套不同判法（看 next URL、看 loadedTotals 是否到 totals、看本页是否短于 limit）。

这里化解的本质矛盾是：**「状态结构想统一」与「两层各自的分页进度要互不干扰」之间的张力**。统一是诱惑（少写代码），但代价是父评论翻页时会冲掉子评论的进度；分离是麻烦（重复字段），但换来了嵌套场景下的可独立深翻页。

### 子评论「查看全部」走独立弹窗 + 独立游标，换得首屏轻

父评论首屏要快（用户只是扫一眼评论分布），但子评论深翻页要全（点「查看全部」之后用户准备认真看）——这两条对「拉多少」的诉求完全相反。首屏就把每条父评论的所有子评论都拉回来，首屏会很慢；可永远只给首屏那几条，用户连「全部回复」都看不了。

- **做了什么选择**：父评论首屏只在每条下面附带接口顺手返回的几条 `child_comments`；点「查看全部 N 条回复」才打开**独立弹窗**、走**独立的子评论接口**、用**独立的续传偏移游标**翻页。
- **换来了什么**：首屏轻，只有真要深翻时才付请求代价；弹窗关掉再重开，已经在累积列表里的子评论还在，零请求恢复上次进度。
- **代价**：子评论的存储、展示、游标都与父评论完全分离，一份 `paging` 字段表有两套形状，弹窗里翻页用的是字符串型续传偏移而非页码算术，连「下一页」按钮的 is_end 判定都要单独写一遍。

这条化解的本质矛盾是：**「首屏要快」与「深翻页要全」在同一棵树里的对抗**。把对抗拆到两层、两个组件、两套游标里，每一层只对自己的诉求负责。

## 5. 最小原理演示

下面这段几十行的状态机骨架演透游标怎么随页推进、累积列表怎么靠 id 去重、显示为什么只取当前页那一片、收起再展开为什么零请求、子评论的字符串游标为什么不污染父评论。它故意不演示三种内容源的 URL 差异、反爬请求头、HTML 渲染、点赞乐观 UI、错误处理——这些都不服务于「演透游标分页」。

```ts
// 评论项最小形状
type Comment = { id: string; content: string };
type Paging = {
  is_end: boolean;
  nextUrl: string | null;          // 父评论游标：接口回传的下一页 URL
  nextOffset: string | null;       // 子评论游标：从 nextUrl 正则抠出的字符串 token
  totals: number;
  loadedTotals: number;
  current: number;                 // 当前页码（仅父评论用；子评论靠 offset 续传不算页码）
  limit: number;
};

// 父评论的状态：累积列表 + 分页信息 + 展开收起标记
type AnswerCommentState = {
  collapsed: boolean;
  list: Comment[];                 // 累积全集（显示时只切当前页那一片）
  paging: Paging;
  // 每条父评论再挂自己的子评论累积列表与游标（独立轨道）
  children: Record<string, { list: Comment[]; paging: Paging }>;
};

// mock 一个会回传「下一页游标」的分页接口
async function fetchPage(url: string): Promise<{ data: Comment[]; next: string | null }> {
  return { data: [], next: null };
}

// 从下一页 URL 抠 offset 参数当子评论的字符串游标
const extractOffset = (url: string | null): string | null => {
  if (!url) return null;
  const m = url.match(/offset=([^&]*)/);
  return m ? m[1] : null;
};

// 父评论翻页：累积合并 + id 去重；显示只取当前页切片
async function loadParentPage(state: AnswerCommentState, page: number) {
  const url = page === 1 ? '/root_comments?limit=20' : state.paging.nextUrl || '';
  const { data, next } = await fetchPage(url);

  if (page === 1) state.list = [...data];
  else {
    const ids = new Set(state.list.map(c => c.id));   // 用 id 集合做去重
    state.list = [...state.list, ...data.filter(c => !ids.has(c.id))];
  }
  // 游标随页持久化：这一页留下的 next，就是下一页要去拉的真实 URL
  state.paging.nextUrl = next;
  state.paging.current = page;
  state.paging.loadedTotals = state.list.length;
  // 旧接口没有可靠分页信息 → is_end 只能自估
  state.paging.is_end = !next || data.length < state.paging.limit;

  // 显示只取当前页那一片：累积全集与当前页是两件事
  return state.list.slice((page - 1) * state.paging.limit, page * state.paging.limit);
}

// 收起 / 展开：只翻状态标记，从累积列表重切当前页那一片，零请求
function toggleStatus(state: AnswerCommentState, page: number) {
  state.collapsed = !state.collapsed;
  return state.list.slice((page - 1) * state.paging.limit, page * state.paging.limit);
}

// 子评论翻页：用 nextOffset 字符串游标续传，独立轨道、不污染父评论
async function loadChildPage(state: AnswerCommentState, parentId: string, page: number) {
  const childState = state.children[parentId] ??= { list: [], paging: {} as Paging };
  const offset = page === 1 ? '0' : (childState.paging.nextOffset || '0');
  const url = `/child_comments?parent=${parentId}&offset=${offset}`;
  const { data, next } = await fetchPage(url);

  if (page === 1) childState.list = [...data];
  else {
    const ids = new Set(childState.list.map(c => c.id));
    childState.list = [...childState.list, ...data.filter(c => !ids.has(c.id))];
  }
  childState.paging.nextOffset = extractOffset(next);    // 字符串 token，不解读其内容
  childState.paging.is_end = !next;

  // 子评论的「显示只给当页」：接口返回顺序未必对应页码，不敢从累积里切
  return [...data];
}
```

每一行都对应上面某个原理点：`nextUrl` / `nextOffset` 演游标续传、`Set` 演去重、`slice` 演显示切片、`toggleStatus` 演零请求、`extractOffset` 演字符串型不透明游标。

## 6. 执行轨迹

拿一个具体输入走一遍：**一个有 95 条父评论、其中某条父评论下有 60 条回复的回答**。

| 步骤 | 用户操作 | 内部状态变化 | 显示结果 | 是否发请求 |
|---|---|---|---|---|
| 1 | 进回答 | `state.collapsed=true`，`list=[]`，`paging.current=0` | 「加载评论 (95)」按钮 | 否 |
| 2 | 点「加载评论」 | 拉 page=1，得 20 条；`list` 长度 20；`paging.current=1`，`paging.nextUrl="/root?offset=20"`，`is_end=false` | 父评论 1~20 条 | 是 |
| 3 | 点「下一页」 | 用 `nextUrl` 拉 page=2，得 20 条；去重合并后 `list` 长度 40；`paging.current=2`，`paging.nextUrl="/root?offset=40"` | 切片 [20, 40)，即父评论 21~40 条 | 是 |
| 4 | 点「收起」 | `state.collapsed=true` | 「加载评论 (95)」按钮 | **否** |
| 5 | 点「展开」 | `state.collapsed=false`；从 `list` 重切 [20, 40) | 父评论 21~40 条 | **否** |
| 6 | 在父评论 #5 点「查看全部 60 条回复」 | 打开弹窗；`children["#5"].list=[]`；拉子评论 page=1，得 20 条；`children["#5"].paging.nextOffset="abc123"`（mock token） | 子评论弹窗显示当页新拉的 20 条 | 是 |
| 7 | 在弹窗点「下一页」 | 用 `nextOffset="abc123"` 拉 page=2，得 20 条；去重合并后 `children["#5"].list` 长度 40；`nextOffset="def456"` | 子评论弹窗显示**当页新拉的 20 条**（不从累积列表切片，因顺序未必对应页码） | 是 |

整张表把核心思想演透：累积列表装得越来越满、显示永远只是当前页那一片、收起再展开是零请求、子评论完全独立于父评论。

## 7. 教学简化说明

上面这段演示故意省略了：

- 三种内容源（问题 `root_comments` / 专栏 `comment_v5 articles` / 想法 `comment_v5 pins`）的 URL 模板差异——它们各自走一套翻页策略，但策略的形状就是上面那 4 条权衡的组合，不影响理解游标分页本身；
- 反爬请求头、表情包与图片的 cheerio 处理、点赞的乐观 UI 更新——它们都不服务于「演透游标分页」；
- 「403 + 错误码 106」判定为「评论区已关闭」的分支——属于错误处理，与游标分页的核心机制无关；
- 前端那一组全是 `postMessage` 派发的薄函数（`loadComments / loadMoreComments / loadChildComments / toggleCommentStatus / likeComment`）——它们只是「薄 sender」，真正的分页状态机全在后端。

## 8. 小结

评论区分页的关键不在「分页」二字，而在**「累积」与「显示」被强行拆成两件事**——累积列表装的是至今拉过的全集、显示只取当前页那一片，中间靠游标续传与 id 去重把两者黏起来。父评论与子评论各跑一套独立的游标状态机、各用自己的续传方式，让两层都能往深处翻、互不污染；不同接口给的「分页信息」可靠程度不同，逼出了「直接替换不缓存」与「累积合并」两条相反的路径并存。

下一章会把「累积列表」的思路扩展到「收藏夹 → 收藏项」的三级树，但收藏夹多了一层 30 分钟 TTL 与 lastPage 续传的本地缓存，要在缓存新鲜度与重复请求代价之间再做一次取舍。
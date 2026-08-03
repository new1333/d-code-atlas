# 收藏夹树形结构与本地缓存 · 源码精读

## 给 Writer 的教学钩子（必填，8 子项缺一不可）

- **用户痛点 / 场景**：收藏夹不是「一屏能看完的扁平列表」——一个人可能创建+关注几十个收藏夹，每个夹里又可能有上百条收藏项。若像热榜那样首屏全量拉取，要么请求超时、要么把浏览器和 Cookie 烧到失效；若不缓存，用户每次「把文章收进收藏夹」都要重新拉一遍夹子列表，体验极差。核心矛盾是「数据会爆量」与「反爬限频、单次请求昂贵」之间的拉扯。

- **一句话核心思想**：把一个一次拉不完的集合，切成「展开才加载的多级树」+「两种分页协议并存」+「带续传点的本地缓存」，并用多重「还有没有更多」的判定互相兜底。

- **设计动机（为什么需要它）**：收藏夹天然是三级结构（我创建的/我关注的 → 收藏夹 → 收藏项），而前置章讲的是扁平列表，扁平模式无法表达「夹-项」的包含关系，也无法做到「只加载用户展开的那一个夹」。因此本章的动机是：在不增加首屏请求成本的前提下，把会爆量的收藏数据组织成一棵可逐级探索的树，并让高频复用的「收藏选单」用缓存避开重复请求。其中「树形事件驱动刷新、状态化渲染、HTML 解析成节点」这套机制（已在第 5 章『侧边栏内容列表』讲透，本章只看它的新侧面：**多级递归取孩子 + 展开时按需懒加载**）；「写操作走官方 JSON API、统一请求构造与 Cookie 校验」也（已在第 4 章『知乎 JSON API 写操作客户端』讲透，本章只看它的新侧面：**收藏选单跨次操作时复用带续传点的缓存**）。Writer 注意：这两块原理不要在本章重演。

- **关键权衡（4 条，本 Atlas 核心）**：
  1. **按需懒加载（展开才触发请求）**：取孩子时若发现该夹没加载过，就**先返回一个占位项、同时异步发起真实请求** → 换来了「用户没展开的收藏夹永远零成本」 → 代价是首次展开必然有一次「占位 → 真实数据」的视觉跳变，且必须用「已加载 / 正在加载」两个标志位同时防重入。
  2. **同一棵树里混用两种分页协议**：收藏夹这层走「HTML 页面分页」（要拿页面才有的私密标识、作者头像、更新时间），收藏项这层走「JSON 接口的偏移分页」（要结构化数据） → 换来两种数据源各取所长 → 代价是两套「分页终止判定」逻辑都要自己维护，且两套都**本质不可靠**。
  3. **「还有没有更多」的多层兜底**：因为「本页满 20 条 ≠ 真有下一页」「接口返回的总数会漂移」，单靠任何一种判定都会在已耗尽的列表后无限转圈 → 于是用三道闸互相兜底：「有总数就比总数」「没总数就退化为『条数是 20 的倍数』启发式」「加载前后数量没变就强制判停」 → 换来绝不无限空转 → 代价是判定逻辑分散在多处，且总数会被就地修正成实际值（以实际为准，不再信接口）。
  4. **选单场景的本地缓存 + 续传点（与树刷新分离）**：收藏到收藏夹的选单高频复用同一份夹子列表，于是缓存它，且缓存里除了数据还存「上次加载到第几页」，下次从断点续传；并设 30 分钟过期 → 换来跨次操作不重复拉取（省浏览器实例、省接口） → 代价是窗口内可能看到过期的夹子，所以每次新建/删除夹后必须主动清缓存。**注意：这个缓存只服务选单，树本身每次刷新都走真实加载**——这是两条独立的数据消费路径，混为一谈就会写出 bug。

- **最小心智模型（7 步）**：
  1. 用户首次打开收藏视图 → 根级显示「点击加载收藏夹」按钮（零数据、零请求）。
  2. 点击 → 拉取 HTML 第 1 页 → 解析出「我创建的」与「我关注的」两组夹，渲染成两个二级根节点。
  3. 展开某个夹 → 取孩子时发现「没加载过」→ 立即返回占位项，同时异步请求接口首页（偏移=0）。
  4. 首页收藏项回来 → 去重后追加进夹内列表，偏移游标前进；若已加载条数小于总数，保留「加载更多」按钮。
  5. 点「加载更多」→ 以新偏移续传下一页，重复「去重+追加」，直到三道闸中任意一道触发判停。
  6. 点「加载更多收藏夹」→ 以「下一页页码」拉 HTML 下一页，按夹 id 去重后追加。
  7. 用户对某内容点收藏 → 弹出选单：若 30 分钟内有缓存，直接复用（连同上次的续传点），否则从接口拉首页。

- **最小原理演示（替代旧「复刻范围」）**：
  - **应演示**：一个夹抽象（含「收藏项列表 / 当前偏移 / 是否已加载 / 是否还有更多」四元状态）；取孩子函数在该夹「未加载」时返回占位并触发异步拉取；拉取用偏移续传 + 去重 + 三道闸判停；另写一个选单缓存，带 30 分钟过期 + 「上次到第几页」续传点。这段演示演的是**权衡 1+3+4**：懒加载时序、不可靠终止的多层兜底、缓存续传。
  - **应故意省略**：HTML 解析、浏览器渲染、QuickPick 的 UI 与图标、节点 tooltip、缩略图宽度计算、命令注册与树节点类。
  - **演示载体建议**：本章仓库主语言是 TS、机制是「数据结构 + 时序」，建议写成一段**能 `node`/`bun` 直接跑的独立脚本**——用一个返回分页数组的假数据源（总数=45、每页 20，且故意让最后一页只回 5 条）模拟接口，用一个会打印每步状态的极简「树」驱动 getChildren/loadMore，用一个带过期时间的缓存对象演示「命中→续传 / 过期→重拉」。**能跑**最好，重点是让读者看到三道闸在哪一道触发判停、缓存续传点如何被写入与读回。不需要 VSCode 宿主，纯逻辑即可演透。

- **正文不宜展开的细节**：
  - cheerio 选择器的多路回退（HTML 结构会变，代码用 4 个备选选择器兜底，属解析脆弱性，一句话带过）。
  - 节点 tooltip 的 Markdown 拼装、图标按内容类型切换、缩略图按显示模式算宽度——纯展示。
  - 选单里同一接口重复定义了两次（无害冗余）。
  - 收藏夹内容的「打开」分支里回答类型要套一层问题页的特殊处理——属交互细节。

- **推荐的一个执行轨迹例子**：
  输入：一个夹，接口宣称总数=45，每页 20。轨迹：展开 → 占位闪现 → 拉到首页 20 条（按钮仍在）→ 加载更多拉到 20 条 → 再加载只回 5 条（不足一页，第二道闸触发判停，按钮消失）。**对照变体**：若这页实际只回 0 条（加载前后数量没变），第三道闸同样判停，且总数被就地修正为已加载数。

> 以上钩子供 Writer 写「动机→核心思想→心智模型→关键权衡→原理演示」；下面事实部分供核对，不要被 Writer 当目录照抄。

## 概念要点

- **三级树 = 递归取孩子按 contextValue 分派**：取孩子函数根据当前节点的「上下文标签」决定返回哪一层——无节点时返根级（两个二级根 / 加载按钮）；命中「我创建的根 / 我关注的根」时返夹列表；命中「夹」时返夹内项。这是用 VSCode 树协议表达「夹-项」包含关系的核心。源码位置: src/core/zhihu/sidebar/collections.ts:322-378。

- **懒加载触发点藏在取孩子里**：当节点是「夹」、且「未加载过且非加载中」时，取孩子函数**在返回当前孩子（占位/已加载项）的同时**调用异步加载方法——即「返回即触发」，后续加载完成再发事件刷新。源码位置: src/core/zhihu/sidebar/collections.ts:366-371。

- **根级「点击加载」按钮 = 零首屏成本**：根级在「无任何夹数据且非加载中」时返回一个带命令的占位按钮，而非自动请求——首屏不发任何网络请求。源码位置: src/core/zhihu/sidebar/collections.ts:324-345。

- **收藏夹层走 HTML 页面分页**：拉取夹列表用浏览器渲染 `/people/{token}/collections?page=N` 的 HTML 再解析，因为私密标识、作者、更新时间只在页面 DOM 里。判停用「本页解析数 ≥ 20」。源码位置: src/core/zhihu/sidebar/collections.ts:1346-1388。

- **收藏项层走 JSON 偏移分页**：拉取夹内项用 `/api/v4/collections/{id}/items?offset=N&limit=20`，每个夹自带「当前偏移」游标，加载后前移。源码位置: src/core/zhihu/sidebar/collections.ts:1119-1145（请求）、1069（游标前移）。

- **三道判停闸**：① 有总数时比 `已加载数 ≥ 总数`（含就地修正总数）源码位置: src/core/zhihu/sidebar/collections.ts:1080、1088-1100；② 无总数时退化为「条数是 20 的倍数」启发式 源码位置: src/core/zhihu/sidebar/collections.ts:601-619；③「加载前后数量未变」强制判停 源码位置: src/core/zhihu/sidebar/collections.ts:1248-1261（夹内项）、1513-1517（夹列表）。

- **去重键的选择**：夹列表按 `id` 去重（Set）源码位置: src/core/zhihu/sidebar/collections.ts:1376-1382；夹内项按 `created`（收藏时间）去重而非 `id` 源码位置: src/core/zhihu/sidebar/collections.ts:1059-1065。

- **节点 ID 策略二分**：夹节点用稳定 ID `collection-{id}` 以支持展开态记忆；收藏项与「加载更多」按钮用 `Date.now()+Math.random()` 强制每次重建、避免被宿主复用旧状态。源码位置: src/core/zhihu/sidebar/collections.ts:42、134-136、335-337。

- **缓存 = 选单专用、带 TTL + 续传页号**：缓存对象存「夹列表 + 总数 + 时间戳 + 上次到第几页」，30 分钟过期；命中时选单跳过接口请求并从续传页继续。源码位置: src/core/utils/collection-cache.ts:5-13、29-41、50-60；选单调用处 src/core/utils/collection-picker.ts:34-43、102-106。

- **缓存与树刷新是两条独立路径**：树刷新（`refresh` → `loadCollections`）始终走真实浏览器加载，不经缓存源码位置: src/core/zhihu/sidebar/collections.ts:628-630、661-730；缓存只在「收藏选单」被读取。这是区分「展示路径」与「高频复用路径」的关键。

- **写后乐观更新本地 + 清缓存**：新建夹成功后直接 `unshift` 进本地列表、延迟刷新视图、并清选单缓存；删除夹同理 `splice`。不重新拉整树。源码位置: src/core/commands/collection.ts:519-527、489、609-622、605-606。

- **状态记忆靠 expandedStates Map + 稳定 ID**：展开/折叠事件写入 Map，下次渲染按 Map 决定 `CollapsibleState`，根节点默认展开。源码位置: src/core/zhihu/sidebar/collections.ts:283-298、404-406、455-461。

- **类型契约**：`CollectionFolder` 自带「items / isLoaded / currentOffset / hasMore / isLoading / totalCount」——把分页与加载状态**内聚到每个夹对象本身**，而非全局分页表。源码位置: src/core/types/index.ts:753-786。

## 关键调用链

刷新夹列表（首屏/手动刷新）：
refreshCollections 命令 → loadCollections → getUserInfo(fetch `/api/v4/me`) → loadMyCollections(Puppeteer 页 + cheerio 解析) ∥ loadFollowingCollections → fire(onDidChangeTreeData) → 取孩子重渲染
源码位置: src/core/zhihu/sidebar/collections.ts:628-630、661-730、1337-1405

展开夹加载项（懒加载）：
取孩子(夹节点, !isLoaded) → loadCollectionItems → fetchCollectionItems(fetch JSON, offset) → 按 created 去重 + 追加 + 偏移前移 + 三道闸判停 → fire
源码位置: src/core/zhihu/sidebar/collections.ts:366-371、1032-1114、1119-1209

收藏选单（缓存续传）：
showCollectionPicker → getCachedCollections(命中则跳过接口、恢复 lastPage) / 否则 getUserCollections(JSON, offset) → showQuickPick UI → 「加载更多」续传 / 「刷新」清缓存
源码位置: src/core/utils/collection-picker.ts:15-227；接口 src/core/zhihu/api/index.ts:193-215

## 源码摘录（带行号，全文累计 ≤ 30 行）

懒加载触发（返回孩子的同时异步发起加载）：
```ts
// src/core/zhihu/sidebar/collections.ts:359-375
if (element.contextValue === "collectionFolder" || element.contextValue === "myCollectionFolder") {
  const collectionItem = element as CollectionTreeItem;
  if (!collectionItem.collectionFolder.isLoaded && !collectionItem.collectionFolder.isLoading) {
    this.loadCollectionItems(collectionItem.collectionFolder.id); // fire-and-forget
  }
  return Promise.resolve(this.getCollectionFolderItems(collectionItem.collectionFolder));
}
```

偏移续传 + 去重 + 第二道闸（夹内项）：
```ts
// src/core/zhihu/sidebar/collections.ts:1057-1085
const existingCreatedTimes = new Set(collection.items.map((item) => item.created));
const newItems = items.filter((item) => !existingCreatedTimes.has(item.created));
if (newItems.length > 0) {
  collection.items.push(...newItems);
  collection.currentOffset += newItems.length;
}
if (items.length < 20) { collection.hasMore = false; }   // 第二道闸：不足一页即停
```

缓存 TTL + 续传页号（选单专用）：
```ts
// src/core/utils/collection-cache.ts:5-13, 29-34, 50-60
private static cache: { collections: any[]; totalCount: number; timestamp: number; lastPage: number; } | null = null;
private static readonly CACHE_EXPIRY = 30 * 60 * 1000;                 // 30 分钟
// 读时：
if (now - this.cache.timestamp > this.CACHE_EXPIRY) { this.cache = null; return null; }
return { collections, totalCount, lastPage: this.cache.lastPage };     // 续传点随数据一起返回
// 写时：
this.cache = { collections: [...collections], totalCount, timestamp: Date.now(), lastPage };
```

## 易混淆 / 边界 / 推断

- **事实**：本地缓存**只服务「收藏选单」**，不服务树展示；树每次刷新都真实拉取（浏览器 + 接口）。把两者当同一条路径是常见误读。源码位置: src/core/zhihu/sidebar/collections.ts:628-630（树走真实加载）vs src/core/utils/collection-picker.ts:34-43（选单走缓存）。

- **事实**：选单里同一接口 `CollectionQuickPickItem` 被定义了两次（picker 文件 26-31 与 45-50），是无害冗余。

- **推断**：收藏项用 `created`（收藏时间）去重而非 `id`，代码注释仅称「确保唯一性」。推测真实原因是：同一夹内 answer/article/question 三种类型来自不同实体、id 命名空间可能重叠，且偏移分页 + 滚动加载在边界处易返回重复项，`created` 跨类型稳定。但源码未明说，**标注为推断**。源码位置: src/core/zhihu/sidebar/collections.ts:1059-1065。

- **推断（疑似死代码）**：`loadMyCollectionsPage` 与 `loadFollowingCollectionsPage` 两个私有方法在源码内**未见任何调用方**（分页加载实际走 `loadMyCollections(userToken, nextPage)`）。推测是重构后的遗留，但无法在不读全仓调用图的情况下完全确认，**标注为推断/未理解**。源码位置: src/core/zhihu/sidebar/collections.ts:1592-1647、1649-1711。

- **事实**：内容类型判定在未知类型时默认回落为 `article`（源码位置: src/core/zhihu/sidebar/collections.ts:1214-1223），意味着接口若返回新类型，会被当文章渲染与打开——其行为偏差未深究，列为边界。

- **事实**：判停的第二道闸对「夹列表」用「解析数 ≥ 20」（页满启发式）、对「夹内项」用「条数 % 20 === 0」，两者都是「没有可靠总数时的退化启发」，本质不可靠，所以才需要第三道闸兜底。
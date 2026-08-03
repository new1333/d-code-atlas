---
title: 收藏夹树形结构与本地缓存
---

# 收藏夹树形结构与本地缓存

## 场景：一个会爆量、又不能一次拉完的列表

想象一下你打开知乎的收藏页。你创建的夹子、你关注的夹子加起来可能有几十个；随便点开一个夹，里面可能塞着一百多条收藏。如果按热榜那种「首屏一口气全量拉」的玩法去加载收藏夹，会发生两件事：

- 请求超时——数据太多；
- 把浏览器实例和 Cookie 一通烧，烧到反爬限频，整个扩展都用不了。

而如果你干脆不缓存，那每次「把这篇文章收进收藏夹」时弹出的选单，都得重新拉一遍夹子列表——用户操作一次就拉一次，体验也极差。

所以核心矛盾就一句话：**数据会爆量，但单次请求又贵又脆**。这一章讲的就是怎么在这两端之间搭一座桥——把数据切成「展开才加载的多级树」，再配上「带续传点的本地缓存」。

> 在开始之前先点一句去重：树形事件驱动刷新、状态化渲染、把 HTML 解析成节点这套机制，已在第 5 章『侧边栏内容列表』里讲透了，本章只看它的新侧面——「多级递归取孩子 + 展开时按需懒加载」。同样，写操作走 JSON API、伪造请求头、Cookie 校验那一套，已在第 4 章『知乎 JSON API 写操作客户端』讲透，本章只看「选单跨次操作时复用带续传点的缓存」这个新侧面。这两块原理下面不再重演。

## 第一层基本件：把「夹」抽象成一个自带分页状态的小对象

先看最底层那块。热榜那章里，一个列表项就是一条数据，扁平、互不相关。但收藏夹不能这么建模——一个「夹」自己就带着「里面装了多少条」「上次加载到第几条」「还有没有更多」这些状态，而这些状态只属于这个夹，不属于整棵树。

所以最自然的设计是：**把分页状态挂到每个夹对象本身**。一个夹长这样（简化）：

```ts
interface CollectionFolder {
  id: string;
  title: string;
  items: CollectionItem[];     // 已加载的收藏项
  currentOffset: number;       // 当前游标（下次从这开始拉）
  totalCount: number | null;   // 接口宣称的总数（可能漂移）
  isLoaded: boolean;           // 有没有加载过
  isLoading: boolean;          // 正在加载吗（防重入）
  hasMore: boolean;            // 还有没有更多
}
```

说人话就是：每个夹自己揣着「我加载到哪了」「我还有没有更多」的小账本，而不是把这些塞进一张全局分页表。为什么这样设计？因为同一时刻用户可能展开好几个夹，每个夹的进度都不一样。如果硬要用全局表，表的键就得是夹 id，最后还是退化成「每夹一份状态」——不如一开始就挂在夹上，干净。

## 第二层机制：取孩子按 contextValue 分派，懒加载藏在返回里

有了「夹」这个对象，再往上一层：怎么把它组织成树？

收藏夹天然是三级结构：
- 根：两个二级根节点——「我创建的」「我关注的」
- 第二级：夹列表
- 第三级：某个夹里的收藏项

VSCode 的树协议只问一件事：`getChildren(element?)`——给我这个节点的孩子。所以三级树全靠这一个函数表达，函数体里用 `element.contextValue`（节点的上下文标签）来分派：

```ts
function getChildren(element) {
  if (!element)                                       return getRoot();
  if (element.contextValue === "myCollectionsRoot"
      || element.contextValue === "followingRoot")   return getFolders(element);
  if (element.contextValue === "folder")              return getFolderItems(element);
}
```

**懒加载就藏在第三档里**。当用户展开一个夹，`getChildren` 被调用时，如果这个夹的 `isLoaded` 是 false（没加载过）且 `isLoading` 也是 false（不在加载中），就**在返回当前孩子的同时，异步发起真实请求**——也就是「返回即触发」：

```ts
function getFolderItems(folder) {
  if (!folder.isLoaded && !folder.isLoading) {
    folder.isLoading = true;
    loadCollectionItems(folder.id);   // 真实代码里是 fire-and-forget，不 await
  }
  return folder.items;                // 第一次返回的可能是占位/空，加载完会再发事件刷新
}
```

这一招是本章的核心时序：**取孩子函数不阻塞等待加载，而是立刻返回（可能只是占位项），把真实加载甩到后台**。后台拉到数据后，往夹的 `items` 里追加，再发一个「树数据变了」的事件，VSCode 就会重新调用 `getChildren`，把真实数据渲染出来。

这个时序换来的是「用户没展开的夹永远零成本」——你有一百个夹，但只点开三个，那就只发三次请求，其余九十七个夹一个请求都不发。代价是首次展开必然有一次「占位 → 真实数据」的视觉跳变，而且必须用 `isLoaded` 和 `isLoading` **两个标志位同时**防重入——只设一个会被快速的并发点击反复触发。

> 顺便提一句根级的设计：第一次打开收藏视图时，根级显示一个「点击加载收藏夹」按钮，**不主动发任何请求**。点击之后才发起拉取。这是同一个懒加载思想在「整棵树还没初始化」时的体现——首屏零请求。

## 第三层机制：两种分页协议并存，且都不可靠

到这里，夹列表怎么加载、夹内项怎么加载，得分别说。这里有个很现实的问题：**同一棵树里，这两层用的根本不是同一种分页**。

- **夹列表这层走 HTML 页面分页**：拉 `/people/{token}/collections?page=N`，浏览器渲染 HTML 再解析。为什么不用 JSON？因为私密标识、作者头像、夹的更新时间这些字段，**只在页面 DOM 里**，JSON 接口拿不到。
- **夹内项这层走 JSON 偏移分页**：拉 `/api/v4/collections/{id}/items?offset=N&limit=20`，要的是结构化数据，方便去重和分页。

两种协议各自的「分页终止判定」都得自己写，而且——这是关键——**两套判定都本质不可靠**。不可靠的原因有几条：接口宣称的总数会漂移、最后一页可能不满 20 条、甚至可能返回 0 条。

于是有了「还有没有更多」的**三道闸**，互相兜底：

1. **第一道闸：有总数就比总数**。已加载数 ≥ 接口给的总数 → 停。
2. **第二道闸：没总数就退化为启发式**。本页条数不是 20 的倍数（即不满一页）→ 停。
3. **第三道闸：加载前后数量没变就强制判停**。这一页一条都没新增 → 一定停。

第一道闸还会**就地修正总数**——如果接口说有 45 条但实际加载到第 50 条还没停（因为漂移），就以实际为准，把 totalCount 改成 50，**不再信接口**。

这道闸的取舍很清楚：单靠任何一种判定都会出问题。比如「接口宣称有 100 条但只返回 80 条就停了」会让用户永远点不到底；「只看本页是否满 20」在接口提前返回 0 条时会无限空转。三道闸换来「绝不无限空转」，代价是判定逻辑分散在多处，第一次读会觉得「为什么要写三遍停」——因为有任何一遍漏了，都会变成无限加载。

## 第四层机制：选单专用缓存，带续传点，与树刷新分离

最后一块。前面讲的「树」是侧边栏里的展示路径。但收藏夹还有另一条消费路径：用户读一篇文章，点了「收藏」按钮，弹出一个**选单**让他挑要收进哪个夹。这个选单跨次操作会反复弹——今天读十篇文章、收十次，选单就弹十次。

如果每次弹都重新拉一遍夹列表，那就太浪费了。所以这条路径上挂了一个本地缓存：

```ts
const cache = {
  collections: Collection[],     // 夹列表
  totalCount: number,
  timestamp: number,             // 写入时刻
  lastPage: number,              // 上次加载到第几页（续传点）
};
const CACHE_EXPIRY = 30 * 60 * 1000;   // 30 分钟过期
```

命中（30 分钟内）时，选单直接用缓存数据，跳过接口请求；并且**从 `lastPage` 续传**——如果用户上次在选单里点过「加载更多」，这次再弹选单时从上次的下一页继续，不必从头来。

**这里有个极易踩的坑**：这个缓存**只服务选单**，不服务树。侧边栏的树每次刷新都走真实加载（浏览器 + 接口），不读缓存。这是两条独立的数据消费路径：

- 树刷新：要展示给用户看「现在」的夹子，必须新鲜 → 不缓存
- 选单：高频复用、用户能容忍 30 分钟内的新鲜度损失 → 缓存

把两者当一条路径会写出 bug——比如「我刚新建了个夹，为什么选单里看不到？」答案就是：新建夹后必须**主动清缓存**，否则选单在窗口内一直用旧数据。

## 演示：跑一遍三道闸和缓存续传

下面这段脚本能直接用 `node`/`bun` 跑。它演示三件事：懒加载时序、三道闸在哪一道判停、缓存续传点怎么被写入与读回。

```ts
// demo.ts —— 可用 `bun run demo.ts` 或 `npx tsx demo.ts` 跑
//
// 假数据源：接口宣称总数=45，每页 20；第 3 页只回 5 条（不满 → 第二道闸）

const CLAIMED_TOTAL = 45;
const PAGE_SIZE = 20;

function fakeFetchItems(offset: number): Promise<{ items: any[]; total: number }> {
  return new Promise((resolve) => {
    setTimeout(() => {
      const remaining = Math.max(0, 45 - offset);
      const count = Math.min(PAGE_SIZE, remaining);
      const items = Array.from({ length: count }, (_, i) => ({
        created: offset + i,    // 用 created 当去重键（跨 answer/article/question 三类稳定）
      }));
      resolve({ items, total: CLAIMED_TOTAL });
    }, 10);
  });
}

// 夹对象：分页状态挂在自身
function makeFolder(id: string) {
  return {
    id,
    items: [] as any[],
    currentOffset: 0,
    totalCount: null as number | null,
    isLoaded: false,
    isLoading: false,
    hasMore: true,
  };
}

// 三道闸的核心：去重 + 追加 + 偏移前移 + 判停
async function loadMore(folder: any) {
  if (!folder.hasMore) return;
  const before = folder.items.length;

  // 第一道闸：有总数时比总数
  if (folder.totalCount !== null && folder.items.length >= folder.totalCount) {
    folder.hasMore = false;
    console.log(`[闸1] 已加载数 ${folder.items.length} ≥ 总数 ${folder.totalCount} → 停`);
    return;
  }

  const { items: fetched, total } = await fakeFetchItems(folder.currentOffset);
  folder.totalCount = total;

  // 去重（按 created）+ 追加 + 偏移前移
  const existed = new Set(folder.items.map((i) => i.created));
  const fresh = fetched.filter((i) => !existed.has(i.created));
  if (fresh.length > 0) {
    folder.items.push(...fresh);
    folder.currentOffset += fresh.length;
  }

  // 第二道闸：本页不满一页 → 启发式判停
  if (fetched.length < PAGE_SIZE) {
    folder.hasMore = false;
    console.log(`[闸2] 本页 ${fetched.length} < ${PAGE_SIZE} → 停`);
    return;
  }

  // 第三道闸：加载前后数量没变 → 强制判停，且就地修正总数
  if (folder.items.length === before) {
    folder.hasMore = false;
    folder.totalCount = folder.items.length;
    console.log(`[闸3] 加载前后都是 ${before} → 强制停，总数修正为 ${folder.totalCount}`);
    return;
  }

  console.log(`本轮 +${fresh.length}，累计 ${folder.items.length}`);
}

// 懒加载触发点：取孩子时「未加载且非加载中」就触发
// 真实代码里 loadMore 是 fire-and-forget；这里为了日志顺序用了 await
async function expandFolder(folder: any) {
  if (!folder.isLoaded && !folder.isLoading) {
    folder.isLoading = true;
    console.log("展开夹 → 立刻返回占位，后台开始拉首页");
    await loadMore(folder);
    folder.isLoaded = true;
    folder.isLoading = false;
  }
}

async function main() {
  const folder = makeFolder("c1");

  await expandFolder(folder);          // 第一次展开：触发懒加载
  while (folder.hasMore) {
    await loadMore(folder);            // 用户反复点「加载更多」
  }
  console.log("最终加载条数:", folder.items.length);

  // —— 缓存写入：连同「上次到第几页」一起 ——
  const cache = {
    collections: folder.items,
    totalCount: folder.totalCount,
    timestamp: Date.now(),
    lastPage: Math.ceil(folder.currentOffset / PAGE_SIZE),
  };
  console.log(`缓存写入：lastPage = ${cache.lastPage}，下次选单命中后从此处续传`);
}

main();
```

跑出来的轨迹大致是：

```
展开夹 → 立刻返回占位，后台开始拉首页
本轮 +20，累计 20
本轮 +20，累计 40
[闸2] 本页 5 < 20 → 停
最终加载条数: 45
缓存写入：lastPage = 3，下次选单命中后从此处续传
```

注意三件事：

1. **第一道闸没触发**——因为接口宣称总数=45，加到第 45 条之前已经被第二道闸拦下。这就是「三道闸互相兜底」的意思：哪一道先撞上就停，不靠任何一道独自扛。
2. **总数没被就地修正**——因为本次假数据是诚实的。如果接口宣称 45 但实际只回得到 40 条，第三道闸会把 totalCount 改成实际值。
3. **缓存的 `lastPage`**——这是续传点。下次选单命中缓存，从第 4 页开始拉（如果用户在选单里再点「加载更多」）。

## 关键权衡（四条）

下面四条权衡是这一章的核心交付。每一条都是「做了 X 选择 → 换来了 Y → 代价是 Z」的具体取舍。

### 权衡 1：懒加载的占位 + 异步请求

**做了什么选择**：取孩子函数不阻塞，遇到「未加载的夹」就**立刻返回占位、同时异步发起真实请求**。

**换来**：用户没展开的夹，请求成本永远是零。一百个夹只点开三个，就只发三次请求；首屏也零请求（根级是「点击加载」按钮）。

**代价**：
- 首次展开必然有一次「占位 → 真实数据」的视觉跳变；
- 必须用 `isLoaded` 和 `isLoading` **两个标志位同时**防重入——只设一个会被快速的双击或 VSCode 的并发取孩子反复触发加载。

### 权衡 2：同一棵树里混用两种分页协议

**做了什么选择**：夹列表层走 HTML 页面分页，夹内项层走 JSON 偏移分页。

**换来**：两种数据源各取所长——HTML 拿到只在 DOM 里出现的私密标识、作者头像、夹更新时间；JSON 拿到结构化、好去重、好运筹的收藏项。

**代价**：两套「分页终止判定」逻辑都得自己维护；而且——见下一条——两套都本质不可靠，所以还得再叠一层兜底。

### 权衡 3：三道闸互相兜底

**做了什么选择**：「还有没有更多」用三道闸判定——有总数比总数、没总数退化启发式、加载前后数量没变强制停。

**换来**：绝不无限空转。哪怕接口宣称的总数漂移、哪怕最后一页只回 0 条，都能停下来。

**代价**：
- 判定逻辑分散在多处，第一次读会觉得啰嗦；
- 第一道闸还会**就地修正总数**（以实际为准，不再信接口）——读代码的人一开始会困惑「为什么把接口给的总数改了」。

### 权衡 4：选单专用缓存 + 续传点，与树刷新分离

**做了什么选择**：收藏选单这条高频复用路径，挂一个 30 分钟 TTL 的本地缓存；缓存里除了数据还存「上次到第几页」，下次从断点续传。

**换来**：跨次操作不重复拉取（省浏览器实例、省接口、省 Cookie）。今天读十篇文章收十次，夹列表只拉一次。

**代价**：
- 30 分钟窗口内可能看到过期的夹子，所以**每次新建/删除夹后必须主动清缓存**；
- 缓存与树刷新是**两条独立路径**，混为一谈就会写出 bug——树每次刷新都走真实加载，缓存只在选单被读取。这是这一章最容易被读者误读的一点。

## 小结

把这一章的原理提炼成一句话：**把一个一次拉不完的集合，切成「展开才加载的多级树」+「两种分页协议并存」+「带续传点的本地缓存」，并用多重「还有没有更多」的判定互相兜底**。

这里有几个互相独立的判断在共同起作用：
- 「夹」的对象把分页状态挂进自身——因为同一时刻多个夹各自有进度；
- 取孩子函数把懒加载藏在返回里——为了零首屏成本；
- 同一棵树混用两种分页——因为两种数据源字段不一样；
- 三道闸判停——因为没有任何单点判定是可靠的；
- 选单缓存与树刷新分离——因为两条路径对「新鲜度」的容忍度不同。

这些判断**单独看都像是「为特殊情况写的补丁」**，但组合起来，它们共同回答了一个问题：在一个数据会爆量、又不能一次拉完、又会被反复打开的场景里，怎么把请求成本压到最低，同时不让用户在「无限加载」和「过期数据」之间二选一。

下一章会换个完全不同的方向——『智能伪装引擎』。它解决的是另一个问题：当摸鱼时 webview 一失焦，怎么把标签页的标题和图标瞬间换成看起来像真实工作文件的样子，让路过的人看不出你在摸鱼。那是个和数据加载无关、但同样需要在「稳定不闪」与「每次随机更真实」之间反复权衡的设计。

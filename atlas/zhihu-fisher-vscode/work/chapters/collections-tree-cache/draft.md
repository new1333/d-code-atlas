# 收藏夹树形结构与本地缓存

> 本章属于 composite 层。前置：侧边栏内容列表、知乎 JSON API 写操作客户端。
> 学完你能：用一句话讲清「为什么收藏夹要切成多级树、为什么同一棵树要混用两种分页协议、为什么判停要多道闸、为什么缓存只服务选单」。

## 1. 为什么需要它（设计动机）

上一章把评论区做成父子两层、用游标分页续传，解决了「分页深、不重复、可展开收起」。但评论区只是「一篇回答下的两层小数据」——一旦把视角放大到「我所有的收藏」，问题立刻换了一个量级：一个人可能创建了几十个夹、关注了几十个夹、每个夹里又可能有上百条收藏项，全量加起来轻松上千条。

把这么大的集合按热榜那种扁平列表「首屏一次拉完」会撞上两堵墙：

- **反爬限频**：单次请求拉一千条，要么超时，要么把浏览器实例和 Cookie 烧到失效。
- **首屏白白浪费**：用户大多只想看其中一两个夹，把全部夹和项都拉回来毫无意义。

扁平列表还表达不出「夹包含项」这层关系。收藏夹天然是三级结构——「我创建的/我关注的 → 收藏夹 → 收藏项」——一级展开才进入下一级。

更要命的是另一个高频场景：「在某条内容上点收藏 → 弹一个选单 → 选个夹」。这个选单每次都要重新拉一遍夹列表，体验极差；但不缓存又怕过期，新建夹后选单里看不到新夹用户会炸。

所以本章面对的矛盾是：**数据天然会爆量、且分布在三种层级 + 两种数据源里**，但**反爬与请求成本让单次拉取必须克制**，同时**选单这种高频路径又必须复用**。

前置章已经讲透的两件事，本章只看它们的新侧面：「侧边栏内容列表」教过的「树协议 + 事件驱动刷新 + 状态化渲染」在本章升级为**多级递归取孩子 + 展开时按需懒加载**；「写操作 API 客户端」教过的「统一请求构造 + Cookie 校验」在本章被**带续传点的缓存**复用——这两块原理不重演。

## 2. 核心思想

把一个一次拉不完的集合，切成「**展开才加载的多级树**」+「**两种分页协议并存**」+「**带续传点的本地缓存**」，再用**多重「还有没有更多」的判定互相兜底**——任何单一手段都不够，必须四件一起上。

说人话就是：**承认数据拉不完，转而让用户每次只点亮一小片**；**承认接口不可靠，转而让多道判定互证**。

## 3. 心智模型

### 3.1 三级树 = 取孩子函数按 contextValue 分派

VSCode 的 TreeDataProvider 协议只问一件事：`getChildren(element?)`。收藏夹把它当成一个分派器：

- 没传 element（根级）→ 返回「点击加载收藏夹」按钮，或两个二级根节点「我创建的」「我关注的」
- element 是「我创建的根 / 我关注的根」→ 返回该分组的夹列表
- element 是「夹」→ 返回该夹内的收藏项列表，外加可能的「加载更多」按钮

**夹对象本身带着四元状态**：`items[]`（已加载项）、`currentOffset`（偏移游标）、`isLoaded / isLoading`（防重入双标志）、`hasMore`（是否还有下一页）。分页状态**内聚到每个夹对象本身**——没有一张全局分页表。展开哪个夹，就读哪个夹自己的游标。

### 3.2 选单缓存 = 数据 + 续传点 + 时间戳

`CollectionCache` 这个静态对象只存四件东西：夹列表、总数、上次到第几页（`lastPage`）、时间戳。命中时连同 `lastPage` 一起返回，下次接着往后翻；30 分钟过期。

注意：**这个缓存只服务「点收藏时弹出的选单」，不服务侧边栏树**。树每次刷新都走真实拉取；选单才走缓存。两条路径完全不交叉。

### 3.3 总流程（A → B → C → D）

```
A. 用户点开收藏视图
   → 根级返回「点击加载」按钮（零请求）
B. 点击 → 拉 HTML 第 1 页 → 解析出「我创建的」「我关注的」两组夹
   → 渲染成两个二级根节点
C. 展开某夹 → 该夹 isLoaded=false
   → 立即返回占位项、同时异步拉接口首页（offset=0）
   → 首页回来 → 去重 + 追加 + 偏移前移 + 三道闸判停 → fire 刷新
D. 用户对某内容点收藏 → 弹选单
   → 30 分钟内有缓存 → 复用（连同 lastPage）
   → 否则从首页拉
```

## 4. 关键权衡

### 展开才加载，换来用户没看到的夹零成本

**选择**：把取孩子函数设计成「在返回孩子的同时，如果发现这个夹还没加载过，就 fire-and-forget 触发一次真实拉取」。第一次 `getChildren` 立刻返回——要么是空列表（占位），要么是已加载的项；真正拉数据是异步进行的，拉完再 `fire(onDidChangeTreeData)` 让树重画。

**换来**：用户没展开的夹永远零请求、零浏览器开销。首屏连一次接口都不发。

**代价**：第一次展开必然有一次「占位项 → 真实数据」的视觉跳变。而且必须用「`isLoaded` + `isLoading`」**两个标志位同时**防重入——只设一个 `isLoading` 不够，因为渲染线程会在它置位前再问一次取孩子函数。

> **化解的本质矛盾**：用户想随时看到全部数据 vs 反爬限频让一次拉全部必然失败。出路是把「看到」降级为「展开才看」——把首屏成本从「数据总量」改成「用户的好奇心」。

### 同一棵树里混用两种分页协议

**选择**：收藏夹这层走「HTML 页面分页」（拉 `/people/{token}/collections?page=N`、用浏览器渲染再解析 DOM）；收藏项这层走「JSON 接口的偏移分页」（拉 `/api/v4/collections/{id}/items?offset=N&limit=20`）。两层各自管各自的「下一页」概念，互不干扰。

**换来**：两种数据源各取所长——夹列表需要私密标识、作者头像、更新时间这些**只在页面 DOM 里**的信息；夹内项只需要**结构化数据**，走接口更干净。

**代价**：得维护两套「分页续传 + 终止判定」逻辑。更糟的是，两套判定**本质上都不可靠**（页满启发式与接口总数都会漂移），所以必须再叠一层兜底（见下条）。

> **化解的本质矛盾**：同一个树协议里的同一种「分页」需求 vs 两种数据源各有所长。出路是让取孩子函数把两种分页协议透明掉——上层只看到「夹节点 / 收藏项节点」，不感知下面拉的是 HTML 还是 JSON。

### 多道「还有没有更多」的闸门互证

**选择**：因为「本页满 20 条 ≠ 真有下一页」「接口返回的总数会漂移」，单靠任何一种判定都会让分页在已耗尽的列表后无限转圈。于是叠三道闸门互相兜底：

- **闸 1**：有总数时，比 `已加载数 ≥ 总数`；若已加载数已经超过接口宣称的总数，就把总数**就地修正**为已加载数（以实际为准，不再信接口）。
- **闸 2**：没总数时退化为启发式——本页条数「是 20 的倍数」就认为可能还有下一页，不足一页立即判停。
- **闸 3**：不论上面两道怎么判，只要「这一页加载前后，列表数量没变」，强制判停——这是对「接口返回空数组」「解析全失败」这类边界最后的兜底。

**换来**：三种失效模式各自单独都会让分页死循环，叠加起来就绝不会无限空转。

**代价**：判停逻辑分散在三个位置；总数被就地修正后，UI 上显示的总数与接口宣称的可能不一致。

> **化解的本质矛盾**：接口给的「总数」不可靠 vs 不能让用户看到无限转圈。出路是放弃「单一可信源」的执念，转而**让多个不可靠判定互证**——任何一个判停了就停。

### 选单走缓存续传，树每次走真实拉取

**选择**：把「展示路径」与「高频复用路径」拆开。侧边栏树每次刷新都走真实拉取（浏览器 + 接口），不碰缓存；只有「点收藏弹选单」这条高频路径才读缓存。缓存里除了夹列表，还存「上次到第几页（`lastPage`）」，下次接着往后翻；30 分钟过期。

**换来**：跨次收藏操作不重复拉夹列表，省浏览器实例、省接口配额。

**代价**：30 分钟窗口内，用户在别处新建/删除的夹不会自动出现。所以代码强制在「新建夹」「删除夹」成功后**主动清缓存**——把代价约束在「写操作瞬间」。

> **化解的本质矛盾**：高频复用同一份夹列表 vs 每次都拉太贵。出路不是「全缓存」或「全不缓存」，而是**承认两条路径对新鲜度的要求不同**——展示路径必须新鲜（每次真拉），高频路径可以容忍 30 分钟延迟（缓存 + 写后清）。

## 5. 最小原理演示

下面这段脚本不依赖 VSCode，能直接用 `node`/`bun` 跑。它演示三件事：**懒加载时序**（取孩子时未加载就返回占位 + 异步触发）、**不可靠终止的多层兜底**（三道闸）、**缓存续传点**（命中后从 `lastPage` 接着翻）。一个假接口（总数 45、每页 20、最后一页只回 5 条）演完整套机制。

```ts
// 一个夹对象：把分页状态内聚到自己身上，没有全局分页表
type Folder = {
  id: string;
  items: { id: string; created: number }[];
  currentOffset: number;
  isLoaded: boolean;
  isLoading: boolean;
  hasMore: boolean;
  totalCount?: number; // 接口可能给、可能不给、还可能给错
};

// 假接口：总数 45、每页 20、最后一页只回 5 条
function fakeFetchItems(folderId: string, offset: number) {
  const total = 45;
  const count = Math.max(0, Math.min(20, total - offset));
  const items = Array.from({ length: count }, (_, i) => ({
    id: `${folderId}-item-${offset + i}`,
    created: Date.now() + offset + i,
  }));
  return Promise.resolve({ items, total });
}

// 拉取一页：去重 + 偏移前移 + 三道闸判停
async function loadOnePage(folder: Folder) {
  const before = folder.items.length;
  const { items, total } = await fakeFetchItems(folder.id, folder.currentOffset);

  // 用 created 去重（跨 answer/article/question 三种类型稳定，避免 id 命名空间冲突）
  const seen = new Set(folder.items.map((i) => i.created));
  const fresh = items.filter((i) => !seen.has(i.created));
  folder.items.push(...fresh);
  folder.currentOffset += fresh.length;

  if (typeof folder.totalCount === "undefined") folder.totalCount = total;

  // 闸 1：有总数就比总数；已加载数反而超过接口宣称的总数，就地修正
  if (folder.items.length >= (folder.totalCount ?? Infinity)) {
    folder.totalCount = folder.items.length;
    folder.hasMore = false;
  }
  // 闸 2：本页不足一页（启发式：20 的倍数才可能还有下一页）
  else if (items.length % 20 !== 0) {
    folder.hasMore = false;
  }
  // 闸 3：加载前后列表数量没变（接口返回空或全重复），强制判停
  else if (folder.items.length === before) {
    folder.hasMore = false;
  }
}

// 取孩子：未加载就立即返回占位 + 异步触发真实拉取
function getChildren(folder: Folder): string[] {
  if (!folder.isLoaded && !folder.isLoading) {
    folder.isLoading = true; // 防重入双标志之一，跟 isLoaded 一起把窗口压死
    loadOnePage(folder).then(() => {
      folder.isLoaded = true;
      folder.isLoading = false;
      console.log(
        `  [刷新] 已加载 ${folder.items.length}/${folder.totalCount}，hasMore=${folder.hasMore}`
      );
    });
    return ["（加载中…）"]; // 占位项立即返回，让取孩子函数同步可返回
  }
  return folder.items.map((i) => i.id);
}

// 选单专用缓存：数据 + 续传页号 + 时间戳，30 分钟过期
type Cache = { folders: string[]; lastPage: number; ts: number } | null;
let cache: Cache = null;
const TTL = 30 * 60 * 1000;

function fakeFetchFolderPage(page: number) {
  return Promise.resolve({
    folders: [`夹A-p${page}`, `夹B-p${page}`],
    reachedEnd: page >= 2,
  });
}

async function loadFoldersForPicker() {
  const now = Date.now();
  if (cache && now - cache.ts <= TTL) {
    console.log(`[选单] 命中缓存，跳过接口，复用 ${cache.folders.length} 个夹`);
    return cache.folders;
  }
  console.log("[选单] 缓存过期或不存在，从首页拉");
  let page = 1;
  const folders: string[] = [];
  while (true) {
    const { folders: cur, reachedEnd } = await fakeFetchFolderPage(page);
    folders.push(...cur);
    if (reachedEnd) break;
    page++;
  }
  // 续传点随数据一起写入；下次命中缓存就不用再翻一遍
  cache = { folders, lastPage: page, ts: now };
  return folders;
}

async function main() {
  const folder: Folder = {
    id: "fav-1",
    items: [],
    currentOffset: 0,
    isLoaded: false,
    isLoading: false,
    hasMore: true,
  };

  console.log("第 1 次取孩子：", getChildren(folder)); // 占位 + 异步触发
  await new Promise((r) => setTimeout(r, 50));

  while (folder.hasMore) {
    console.log("点「加载更多」…");
    await loadOnePage(folder);
    console.log(
      `  已加载 ${folder.items.length}/${folder.totalCount}，hasMore=${folder.hasMore}`
    );
  }

  console.log("\n--- 第一次拉选单 ---");
  await loadFoldersForPicker();
  console.log("\n--- 第二次拉选单（30 分钟内）命中缓存 ---");
  await loadFoldersForPicker();
}

main();
```

跑一遍能看到：第一次 `getChildren` 立刻返回「加载中…」，然后异步日志显示加载到 20 条；点「加载更多」翻到 40 条；再点只回 5 条（不足一页），**闸 2 触发**判停，`hasMore` 翻成 false。选单第二次拉时直接命中缓存，完全不进接口。

## 6. 执行轨迹

输入：一个夹，接口宣称 `totalCount=45`、每页 20 条。

| 步骤 | 动作 | 内部状态 | 触发哪道闸 |
|---|---|---|---|
| 1 | 展开夹 | `isLoaded=false` → 立即返回「加载中…」并异步拉首页 | — |
| 2 | 首页回来 | `items.length=20`、`currentOffset=20`、`hasMore=true` | 闸 1：20 < 45；闸 2：20%20=0；闸 3：变了。继续 |
| 3 | 点「加载更多」 | `items.length=40`、`currentOffset=40`、`hasMore=true` | 闸 1：40 < 45；闸 2：20%20=0；闸 3：变了。继续 |
| 4 | 再点「加载更多」 | 接口只回 5 条 → `items.length=45`、`currentOffset=45` | 闸 1：45 ≥ 45，**判停**（闸 2 也成立：5%20≠0） |

**对照变体**：若某一页接口实际只回 0 条（加载前后数量没变），即使闸 1、闸 2 都没触发，**闸 3 也会判停**，且 `totalCount` 被就地修正为 `items.length`——这就是「以实际为准，不再信接口」。

## 7. 教学简化说明

本章演示故意省略了：

- **HTML 解析细节**：cheerio 选择器的多路回退（属解析脆弱性，与原理无关）。
- **VSCode TreeItem 的展示属性**：tooltip、图标、缩略图宽度、CollapsibleState——纯 UI。
- **节点 ID 的展开态记忆**：夹节点用稳定 ID 让宿主记住展开态、按钮用随机 ID 强制重建——属宿主契约细节。
- **写后乐观更新**：新建夹成功后 `unshift` 进本地列表、删除夹 `splice`、再延迟刷新——属交互层。

## 8. 小结

收藏夹这一章把评论章的「两层 + 一种分页」扩到了「三级 + 两种分页 + 多层判停 + 选单缓存」。真正值得带走的是这套思路：**数据会爆量就把它切成树**、**接口不可靠就让多个判定互证**、**路径高频就单独缓存它**。下一章换口味，讲摸鱼的灵魂——失焦时怎么把整个界面换皮成假代码编辑器。
# 收藏夹树形结构与本地缓存

## 当数据多到「一屏拉不完」

想象你打开自己的知乎收藏——你可能建了十几个收藏夹，又关注了十几个，而每个夹里可能塞着上百篇文章。如果像热榜那样，打开就一次性把所有夹、所有夹里的内容全拉下来，会怎样？要么请求超时，要么把那台用来反爬的浏览器和登录 Cookie 直接烧到失效。

可要是不缓存呢？你每次想把一篇文章收进收藏夹，都得先重新拉一遍「我有哪些夹」的列表，才能弹出选单让你勾选。点一次收藏，等一次请求。

这一章要解决的就是这个矛盾：**数据会爆量**，可**反爬限频、单次请求又特别贵**。两股力量往相反方向拉，我们得在中间找一条缝。

## 扁平列表装不下「夹里有项」

收藏夹和热榜最大的不同，在于它**天生是三级的**：

```
我创建的 / 我关注的      ← 第一级：两组根
  └─ 收藏夹 A            ← 第二级：一个个夹
       ├─ 收藏项 1        ← 第三级：夹里的内容
       └─ 收藏项 2
```

热榜是一个扁平原列表，给个数组渲染完事。但收藏夹得表达「这个项属于那个夹」的包含关系——扁平数组做不到。更关键的是，**我们只想加载用户真正展开的那一个夹**，而不是把几十个夹里几百条内容一股脑全请求回来。

前置的第 5 章已经把「用 VSCode 树把知乎列表搬进侧边栏」这套机制讲透了——拉数据、解析成节点、用事件驱动刷新、按加载中/出错做状态化渲染。这些本章不重复。本章只看它的新侧面：**怎么让这棵树变成多级的，并且展开哪一层才加载哪一层**。

## 先认识最底层那块：把分页状态长在夹身上

在动手讲加载之前，先看一个看起来不起眼、其实贯穿全章的设计决定：**每个收藏夹自己揣着它自己的分页状态**。

不是搞一张全局表去记「夹 A 加载到哪了、夹 B 加载到哪了」，而是让每个夹对象自带这几个字段：

```ts
class CollectionFolder {
  items: Item[]              // 已经加载进来的项
  currentOffset = 0          // 偏移游标：下次从第几条开始拉
  isLoaded = false           // 是否加载过（懒加载用）
  isLoading = false          // 是否正在加载（防并发重入）
  hasMore = true             // 还有没有更多
  totalCount: number | null  // 接口给的总数
}
```

说人话就是：**分页这摊事，谁的数据谁自己管**。这听起来像小事，但它让后面所有的「展开加载」「续传」「判停」都能在单个夹对象上自洽完成，不用在外面维护一张容易对不上的状态表。这是整章的地基。

## 展开，才加载

现在来看这棵树怎么「按需」长出来。

这有点像逛图书馆——你不会一进门就把所有书架上的书全搬下来，而是走到哪个书架，才翻开那一格。收藏夹也是这个思路：**走到哪一层，才加载哪一层**。

VSCode 的树有一个规矩：你展开一个节点，它就来问你这个节点的孩子是谁。我们的取孩子函数，靠节点身上一个叫 `contextValue` 的标签来分派——它是「我创建的根」就返回夹列表，是「夹」就返回夹里的项：

```
取孩子(节点)
  ├─ 节点是「我创建的根」→ 返回这一组的夹列表
  ├─ 节点是「我关注的根」→ 返回这一组的夹列表
  └─ 节点是某个「夹」    → 返回这个夹里的项
```

这里有个反直觉的时机：**加载请求就藏在「返回孩子」这一步里**。当你展开一个从没加载过的夹，取孩子函数会做两件事——

1. 立刻返回一个「加载中」的占位项给树渲染；
2. 同时在背后悄悄发起一次真实请求，拉这个夹的内容。

这就是「返回即触发」：先给你看到点东西（占位项），数据回来后再用事件刷新一次，把占位项换成真东西。

> **关键权衡 1：展开才加载**
> **选择**：取孩子时发现这个夹没加载过，就先返回一个占位项、同时异步发起请求。
> **换来**：用户没展开的收藏夹，永远零请求、零成本——几十个夹里，你只为你点开的那一个买单。
> **代价**：第一次展开必然有一次「占位项 → 真实数据」的视觉跳变；而且光靠「加载过没」这一个标志位还不够，必须再加一个「正在加载中」标志位，否则用户快速收起再展开，会同时触发好几个重复请求。

那两个标志位缺一不可：`isLoaded` 记「这辈子加载过没有」，`isLoading` 记「现在这一刻是不是正在拉」。没有 `isLoading`，连续展开两次就会发出两个一模一样的请求。

## 一棵树里，混着两套分页规则

再往细看，你会发现这棵树分页的方式不统一——它是**故意**的。

**收藏夹这一层**（第二级）走的是 HTML 页面分页：用浏览器渲染 `/people/我/collections?page=2` 这种页面，再把 HTML 解析成夹。为什么绕这一圈用 HTML 而不直接调接口？因为私密收藏夹的标识、夹的作者头像、最后更新时间这些东西，**只在网页的 DOM 里**，JSON 接口不给。

**收藏项这一层**（第三级）走的却是 JSON 偏移分页：直接调 `/api/v4/.../items?offset=40&limit=20`，要的是干净的结构化数据。

> **关键权衡 2：一棵树混用两套分页**
> **选择**：夹这一层用 HTML 分页去拿页面独有的数据，项这一层用 JSON 偏移分页去拿结构化数据。
> **换来**：两种数据源各取所长，哪边给得全就用哪边。
> **代价**：两套「到底还有没有下一页」的判停逻辑都得自己维护；而且——见下一节——**两套判停都本质不可靠**，这才逼出了三道闸。

## 「还有没有更多」这件事，谁都不能信

这是整章最拧巴、也最有意思的地方。

你拉完一页 20 条，能据此判断「还有下一页」吗？**不能**。满 20 条只说明「这一页满了」，不说明「下一页还有东西」——下一页完全可能是空的。那查接口给的总数呢？也不靠谱，那个总数会**漂移**，时不时就对不上。

任何单一判据都靠不住，于是代码叠了三道闸，**任一道触发就判停**：

- **第一道闸**：接口给了总数，就拿「已加载条数 ≥ 总数」来判断。够数了就停。
- **第二道闸**：要是没总数，就退化为一个启发式——这一页拉回来的不足 20 条，那肯定是最后一页了，停。
- **第三道闸**：最兜底的一道——这次加载前后，条数居然一点没变（拉了个空页回来），强制停。

> **关键权衡 3：三道闸互相兜底**
> **选择**：用「比总数」「不足一页」「加载前后没变」三道闸，任一触发就停。
> **换来**：不管总数准不准、不管接口怎么漂移，列表都**绝不会在已耗尽的地方无限转圈**。
> **代价**：判停逻辑散落在好几处（夹列表一处、夹内项一处），读起来要拼；而且总数一旦被发现对不上，会被**就地修正成实际值**——意思是「我以后只信我自己数出来的，不再信接口给的那个数」。

顺带一提去重：夹内项去重用的不是 `id`，而是 `created`（收藏时间戳）。推测是因为一个夹里回答、文章、问题三种类型混在一起，`id` 可能撞命名空间，而收藏时间跨类型是稳定的。这点源码没明说，属于推断。

## 跑一遍：看三道闸到底在哪一道停

光讲不够，跑一遍最清楚。下面这段脚本把本章核心机制浓缩成纯逻辑——一个夹、一个假接口（宣称总数 45、每页 20）、外加一个带续传点的选单缓存。用 `bun run collections-demo.ts` 或新版 `node` 能直接跑。

```ts
// collections-demo.ts —— 演透：懒加载时序 + 三道闸判停 + 缓存续传
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// 假接口：模拟收藏夹内项的偏移分页（total 可被「谎报」，真实数据到 realEnd 就没了）
function makeApi(total: number, realEnd = total) {
  return async (offset: number) => {
    await sleep(20)
    const count = Math.min(20, Math.max(0, realEnd - offset))
    return {
      items: Array.from({ length: count }, (_, i) => ({ created: offset + i })),
      total,                                  // 接口仍报 total（可能谎报）
    }
  }
}

// 夹抽象：四元状态长在身上
class Folder {
  items: { created: number }[] = []
  currentOffset = 0
  isLoaded = false
  isLoading = false
  hasMore = true
  totalCount: number | null = null
  pending?: Promise<void>

  constructor(public id: string, public api: ReturnType<typeof makeApi>) {}

  // 取孩子：没加载过 → 返回占位项 + 后台发起请求
  async getChildren(): Promise<string[]> {
    if (!this.isLoaded && !this.isLoading) {
      this.pending = this.loadMore()          // 返回即触发，不 await
      return ["<加载中…占位>"]
    }
    return this.items.map((i) => `项#${i.created}`)
  }

  // 偏移续传 + 去重 + 三道闸判停
  async loadMore() {
    if (this.isLoading || !this.hasMore) return
    this.isLoading = true
    const before = this.items.length
    const { items, total } = await this.api(this.currentOffset)
    if (this.totalCount === null) this.totalCount = total

    const seen = new Set(this.items.map((i) => i.created))      // 按 created 去重
    const fresh = items.filter((i) => !seen.has(i.created))
    this.items.push(...fresh)
    this.currentOffset += fresh.length
    this.isLoaded = true

    // 三道闸，任一触发即判停
    const gate1 = this.totalCount !== null && this.items.length >= this.totalCount
    const gate2 = items.length < 20                            // 本页不足一页
    const gate3 = this.items.length === before                 // 加载前后没变
    if (gate1 || gate2 || gate3) {
      this.hasMore = false
      if (this.items.length < (this.totalCount ?? 0)) {        // 总数漂移：以实际为准
        console.log(`  [总数修正] 接口称 ${this.totalCount}，实际 ${this.items.length} → 改为实际值`)
        this.totalCount = this.items.length
      }
    }
    this.isLoading = false
  }
}

// 选单专用缓存：30 分钟 TTL + lastPage 续传点
class PickerCache {
  private cache: { folders: Folder[]; totalCount: number; ts: number; lastPage: number } | null = null
  private readonly TTL = 30 * 60 * 1000

  read() {
    if (!this.cache) return null
    if (Date.now() - this.cache.ts > this.TTL) { this.cache = null; return null }  // 过期作废
    return { ...this.cache }
  }
  write(folders: Folder[], totalCount: number, lastPage: number) {
    this.cache = { folders: [...folders], totalCount, ts: Date.now(), lastPage }
  }
  invalidate() { this.cache = null }                            // 新建/删除夹后调用
}

// ---- 场景 A：总数 45，真实数据也 45（20 + 20 + 5）----
async function scenarioA() {
  console.log("=== 场景 A：总数 45，真实 45 ===")
  const f = new Folder("夹#1", makeApi(45))
  const first = await f.getChildren()                          // 展开（首次）
  console.log("展开 → 占位返回:", first)
  if (f.pending) await f.pending
  console.log(`  已加载 ${f.items.length} 条, hasMore=${f.hasMore}`)
  while (f.hasMore) {                                          // 反复点「加载更多」
    console.log("点「加载更多」→")
    await f.loadMore()
    console.log(`  已加载 ${f.items.length} 条, hasMore=${f.hasMore}`)
  }
  console.log(`✅ 判停，共 ${f.items.length} 条（第三页只回 5 条，第二、第一道闸同时命中）\n`)
}

// ---- 场景 B：接口谎报总数 45，真实数据只有 40 ----
async function scenarioB() {
  console.log("=== 场景 B：接口谎报 45，真实只有 40 ===")
  const f = new Folder("夹#2", makeApi(45, 40))                // total=45, realEnd=40
  while (f.hasMore) {
    await f.loadMore()
    console.log(`  已加载 ${f.items.length} 条, hasMore=${f.hasMore}`)
  }
  console.log(`✅ 判停：第三页拉回 0 条，第三道闸命中，总数就地修正为 40\n`)
}

// ---- 场景 C：选单缓存命中 / 续传 / 失效 ----
async function scenarioC() {
  console.log("=== 场景 C：选单缓存 ===")
  const cache = new PickerCache()
  console.log("第一次打开选单 →", cache.read() ?? "[未命中] 拉首页，写入缓存(page=1)")
  cache.write([], 8, 1)
  console.log("30 分钟内第二次打开 → 命中，续传点 =", cache.read()?.lastPage)
  cache.invalidate()
  console.log("用户新建夹后 →", cache.read() === null ? "[已失效] 下次重拉首页" : "命中")
}

;(async () => { await scenarioA(); await scenarioB(); await scenarioC() })()
```

预期输出（节选）：

```
=== 场景 A：总数 45，真实 45 ===
展开 → 占位返回: [ '<加载中…占位>' ]
  已加载 20 条, hasMore=true
点「加载更多」→
  已加载 40 条, hasMore=true
点「加载更多」→
  已加载 45 条, hasMore=false
✅ 判停，共 45 条（第三页只回 5 条，第二、第一道闸同时命中）

=== 场景 B：接口谎报 45，真实只有 40 ===
  已加载 20 条, hasMore=true
  已加载 40 条, hasMore=true
  [总数修正] 接口称 45，实际 40 → 改为实际值
  已加载 40 条, hasMore=false
✅ 判停：第三页拉回 0 条，第三道闸命中，总数就地修正为 40
```

重点看两件事。场景 A 里，前两页都满 20 条、`hasMore` 一直是 `true`（满页不能当判停依据），直到第三页只回 5 条，才同时触发第一道闸和第二道闸。场景 B 里，接口撒了谎说还有 5 条，但第三道闸发现「拉了等于没拉」，硬生生把总数从 45 改成了 40。三道闸缺了任何一道，场景 B 都会在总数 45 的谎言下无限转圈。

## 选单的那份缓存：和树不是一条路

最后一个机制，也是最容易被误读的一个。

前面讲的树——你展开夹、加载项、点「加载更多」——**每一次刷新都走真实的网络加载**，不经任何缓存。但还有另一个场景：你读文章时点了「收藏」，弹出选单让你挑放进哪个夹。这个选单**会高频复用同一份夹列表**：你今天收藏十篇文章，这十次弹出的选单，里面的夹都一样。

于是给选单单独做了一份缓存。这份缓存像冰箱里的熟食——贴了个 30 分钟的保鲜期，过了就整份扔掉重买；它还记着你上次翻到第几页，下次接着翻。换句话说，缓存里除了夹数据，还揣着一个续传点 `lastPage`，下次打开选单在 30 分钟内就直接复用、并从断点继续。

> **关键权衡 4：选单缓存 + 续传点，和树刷新分开**
> **选择**：收藏选单单独缓存一份夹列表，带 30 分钟过期和「上次到第几页」的续传点。
> **换来**：跨次收藏操作不再重复拉取，省请求、省那台金贵的浏览器实例。
> **代价**：30 分钟窗口内，你可能看到一个略微过期的夹列表；所以每次新建夹、删除夹之后，**必须主动清掉这份缓存**，否则刚建的夹不会出现在选单里。

这里最容易踩的坑，就是把「树的刷新」和「选单的缓存」当成同一条路。它们不是。树是展示路径，永远求新；选单是高频复用路径，容忍一点旧。混为一谈，就会写出「树里看得到新夹、选单里看不到」的 bug。

新建/删除夹之后的处理也很轻：不重新拉整棵树，而是**乐观更新**——直接把新夹插到本地列表最前面、删掉的夹从数组里剔掉，再顺手清掉选单缓存，最后异步刷一下视图。写操作本身走知乎官方 JSON API（请求构造、Cookie 校验那套，第 4 章讲透了，这里不重复），成功就改本地，不等重新拉取。

## 四条权衡，一张表

| 选择 | 换来 | 代价 |
|------|------|------|
| 展开才触发请求 | 没展开的夹零成本 | 占位项→真实数据的跳变；要两个标志位防重入 |
| 一棵树混用 HTML / JSON 两套分页 | 两种数据源各取所长 | 两套判停都要维护，且都不可靠 |
| 三道闸互相兜底 | 绝不无限空转 | 判停逻辑分散；总数被就地修正 |
| 选单单独缓存 + 续传点 | 跨次操作不重拉 | 窗口内可能过期；变更后必须清缓存 |

把这张表连起来读，你会看到一个一以贯之的取舍姿态：**面对一个会爆量、又被反爬卡着脖子的数据源，宁可把逻辑切得更碎、把判据叠得更多，也不肯轻易多发一次请求。** 懒加载省的是「没展开的夹」，缓存省的是「重复的选单」，三道闸省的是「白跑的空请求」。整章每一个机制，本质上都在回答同一个问题：怎么用最少的请求，把一个拉不完的集合，伺候得像拉得完一样。

## 小结

收藏夹的难点从来不在「展示一棵树」，而在「这棵树的每一层都可能爆量，而你又请求不起」。解法是一套组合拳：把分页状态长在夹身上（谁的数据谁管）、展开才加载（不为没看的东西买单）、两套分页混用（各取所长）、三道闸判停（不轻信任何单一判据）、选单单独缓存（高频路径和展示路径分开）。这五件事凑在一起，才把「爆量 + 限频」这个死结解开。

下一章我们离开数据加载的话题，去看这个扩展里最「不正经」、却也最核心的一块——**智能伪装引擎**：WebView 一失焦，怎么把标签页的标题、图标整个换成 32 种语言的真实文件名，再叠一层带语法高亮的假代码。
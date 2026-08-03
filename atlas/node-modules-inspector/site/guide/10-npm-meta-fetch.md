---
title: npm 元信息拉取：批量化、TTL、漏洞
---

# npm 元信息拉取：批量化、TTL、漏洞

## 想象一下：UI 想给你看 100 个包的"年龄"

你刚 `pnpm install` 完一个 monorepo，装了上百个依赖。UI 想在每一行旁边显示三件事——这个版本是什么时候发布的、最新版是几、有没有已知漏洞。这三件事 npm registry 全都知道，但答案不在你的 `node_modules` 里，得去 registry 问。

最朴素的办法：每个包发一次 HTTP 请求，逐个 fetch。问题立刻来了——npm registry 会被这种"机关枪式"请求节流，网络一抖动整批就崩；如果还想做缓存，又得回答"这份漏洞信息能信多久"。这一章讲的，就是怎么在**请求量可控**和**数据新鲜度可控**这两个约束之间找到一条路。

## 先把事实分成两类

仔细想，你要查的其实有两种性质完全不同的事实：

- **「react@18.2.0 是什么时候发布的」**——这是一个历史事实。18.2.0 一旦发布，它的发布时间就永远定格在那里，再也不会变。
- **「react 现在最新版是几」**——这是一个当下事实。今天可能是 18.3.1，下个月可能是 19.0.0，会随时间漂移。

把这两类塞进同一个缓存会出问题：永久事实说"我永远有效"，时变事实说"我有时效"，失效策略会打架。所以这章的设计从一刀切开——**两套独立的缓存，各管各的失效策略**：

- 版本固定信息 → 按 `包名@版本` 键化，永久有效
- 最新版信息 → 按 `包名` 键化，带 TTL 随时间失效

调用方自己选对缓存读哪一套。

## 不可变缓存：命中即零开销

第一套简单到几乎不用讲。键是 `name@version`（比如 `react@18.2.0`），值里塞的是发布时间戳之类的版本固定信息。一旦写入，永远命中、永不失效。

来一个查询请求时，先把所有已知键列出来，对入参做差集——已知的不发请求，未知的才进下一阶段的批量拉取。说人话就是：**装过一次的版本，第二次开 UI 就是零请求**。

## 时变缓存：TTL 跟着包龄走

第二套才是这一章的灵魂。键只有 `name`（不带版本），值里除了发布时间、版本号这些业务字段，还有两个时间戳字段：什么时候 fetch 的、什么时候过期。

过期时间怎么算？公式只有一行：

```
TTL = clamp(包龄 × 3%, 5 小时, 15 天)
```

包龄 = 当前时间 − 这个包最近一次发布的时刻。这条公式把"缓存能放多久"和"这个包更新得多频繁"绑在了一起——稳定的老包不常发版，缓存可以久一点；热点包天天发版，缓存必须短一点保新鲜。

### 三个拐点

把公式拆开看：

- **刚发布 1 周内的包**：`包龄 × 3%` 算出来比 5 小时还小，被下限顶住，TTL 恒为 **5 小时**。无论你是 1 分钟前发的还是 6 天前发的，都给你 5 小时。
- **包龄在 1 周 ~ 1.4 年之间**：TTL 随包龄**线性增长**。1 天的包 ≈ 5h（仍被下限顶住）、1 个月的包 ≈ 22 小时、半年的包 ≈ 5.5 天、1 年的包 ≈ **11 天**（"1 年的包大致 10 天 TTL"那条注释就是这条算出来的）。
- **包龄超过 1.4 年的包**：`包龄 × 3%` 突破 15 天上限，TTL 恒为 **15 天**。从此这包再老也都是 15 天一刷。

### 破坏性失效：过期就先删

判断一条时变缓存还有没有效，是三步谓词：meta 存在 → `validUntil` 不小于当前时间 → `publishedAt` 字段为真。任一不满足即视为无效。

但这里有个细节值得注意——**失效是破坏性的**：发现过期后不是"懒到读取时算"，也不是"标记脏等后台刷"，而是直接 `removeItem` 删掉，再当作未知重新走批量拉取。如果重取失败（比如断网），旧数据已经没了。设计者在这里选了"宁可没数据也不要误导用户"——一份过期的漏洞告警比没有告警危险得多。

## 双阶段拉取：批量 → 单查兜底

未知子集送到 registry 面前时，不是逐个发请求，而是**先按固定大小切片批量并发**。版本元信息端点是一批 10 个、并发跑 10 个；漏洞端点因为底层是 npm registry 的单次大 POST bulk，能容忍更多，一批 100 个。

但这套批量有个坑——**任意一条坏数据会让整批 throw**。比如批量请求里某个 spec 的格式 registry 不认，整批 500，本来能拿到的剩下 9 条也被一起拖下水。

解法是双阶段：

1. **批量阶段**：按 BATCH_SIZE 切片并发跑批量；任何在批量阶段没拿到 `publishedAt` 的 spec，进 `missingSpecs` 集合。批量调用整体 throw 时，把队列里所有 spec 全部塞进 `missingSpecs`。
2. **单查兜底阶段**：批量全部 settle 后，对 `missingSpecs` 逐条单独调单查 API；成功的从集合里移除，并触发同一段写缓存的回调。

这条模板长得几乎一样地出现在版本信息拉取和漏洞信息拉取两条路径上——只是 BATCH_SIZE、并发上限、调用的具体 batch API 不同。它没被抽到公共 util，是项目里被复制了两遍的代码。

## 漏洞信息：合并进既有 meta

漏洞端点拉回结果后，不是单独存一份，而是 mutate 进前面已经写好的版本元信息条目里——读旧 meta → spread → 加 `vulnerability` 字段 → 写回。

这样设计是为了前端读一份缓存就能同时拿到"发布时间 + 漏洞等级"，不用维护两套缓存再前端 join。但代价也直接：**漏洞信息没办法独立失效**——只要那条版本 meta 还在，过时的漏洞告警就跟着挂在上面；要刷新漏洞必须连带重算整条 meta。

## 把它跑起来：最小演示

下面这段脚本不连真 npm registry，全用本地 mock 把三件事演清楚：TTL 公式拐点、双阶段拉取、两套 storage 的分工。可以 `bun run demo.ts` 或 `npx tsx demo.ts` 直接跑。

```ts
// demo.ts —— 演透三件事：TTL 公式 / 双阶段拉取 / 两套 storage
const HOUR = 1000 * 60 * 60
const DAY = HOUR * 24

// ---------- 1) TTL 公式：包龄 × 3%，夹在 [5h, 15d] ----------
function ttlOf(publishedAt: number, now: number) {
  const timePassed = now - publishedAt
  return Math.min(Math.max(5 * HOUR, timePassed * 0.03), 15 * DAY)
}

const now = Date.now()
console.log('--- TTL 拐点 ---')
const anchors: [string, number][] = [
  ['刚发布 1 分钟', 1 * 60 * 1000],
  ['发布 1 天', DAY],
  ['发布 1 周', 7 * DAY],
  ['发布 1 个月', 30 * DAY],
  ['发布 1 年', 365 * DAY],
  ['发布 10 年', 3650 * DAY],
]
for (const [label, ageMs] of anchors) {
  const ttl = ttlOf(now - ageMs, now)
  console.log(`${label.padEnd(12)} → TTL ${(ttl / DAY).toFixed(2)} 天`)
}

// ---------- 2) 两套 storage ----------
const metaStore = new Map<string, any>()    // 不可变：按 name@version 键化
const latestStore = new Map<string, any>()  // 时变：按 name 键化，带 validUntil

// ---------- 3) mock registry：故意让含 bad-pkg 的批量整体 throw ----------
function mockBatch(specs: string[]): any[] {
  if (specs.includes('bad-pkg@1.0.0')) throw new Error('batch 500')
  return specs.map((spec) => {
    const [name, version] = spec.split('@')
    return { name, version, publishedAt: now - 30 * DAY }
  })
}
function mockSingle(spec: string): any {
  if (spec === 'bad-pkg@1.0.0') throw new Error('single 404')
  const [name, version] = spec.split('@')
  return { name, version, publishedAt: now - 30 * DAY }
}

// ---------- 双阶段拉取模板（与源码一致 BATCH_SIZE = 10）----------
const BATCH = 10
async function fetchBatch(specs: string[], onResult: (r: any) => void) {
  const missing = new Set<string>()
  const promises: Promise<void>[] = []
  for (let i = 0; i < specs.length; i += BATCH) {
    const queue = specs.slice(i, i + BATCH)
    promises.push((async () => {
      try {
        const result = await mockBatch(queue)
        result.forEach((r, idx) => {
          if (r.publishedAt) { onResult(r) }
          else { missing.add(queue[idx]) }
        })
      }
      catch {
        // 整批 throw —— 队列里所有 spec 进 missing，下一阶段单查兜底
        for (const spec of queue) missing.add(spec)
      }
    })())
  }
  await Promise.all(promises)
  console.log(`  阶段 1 后 missing: ${[...missing].join(', ') || '(空)'}`)

  // 第二阶段：逐条单查兜底
  if (missing.size) {
    await Promise.all([...missing].map(async (spec) => {
      try {
        const r = await mockSingle(spec)
        if (r.publishedAt) {
          missing.delete(spec)
          onResult(r)
        }
      }
      catch {}
    }))
  }
  return missing
}

// ---------- 跑一次：12 个 spec，其中第 4 个是坏包 ----------
const specs = Array.from({ length: 12 }, (_, i) =>
  i === 3 ? 'bad-pkg@1.0.0' : `pkg-${i}@1.0.0`,
)
console.log('\n--- 双阶段拉取（12 specs，含 1 个坏包）---')
console.log(`输入: ${specs.join(', ')}`)
const missing = await fetchBatch(specs, (r) => {
  const spec = `${r.name}@${r.version}`
  metaStore.set(spec, { publishedAt: r.publishedAt })
  console.log(`  ✓ 写入 metaStore[${spec}]`)
})
console.log(`最终 missing: ${[...missing].join(', ') || '(空)'}`)
console.log(`metaStore 大小: ${metaStore.size} / 输入 12`)

// ---------- 写一条时变缓存（按 name）----------
console.log('\n--- 时变缓存：写 TTL + validUntil ---')
const name = 'some-old-pkg'
const publishedAt = now - 365 * DAY
const ttl = ttlOf(publishedAt, now)
latestStore.set(name, { publishedAt, fetchedAt: now, validUntil: now + ttl })
console.log(`${name}: 包龄 1 年 → TTL ${(ttl / DAY).toFixed(2)} 天，validUntil = ${new Date(now + ttl).toISOString().slice(0, 10)}`)
```

预期输出大致长这样：

```
--- TTL 拐点 ---
刚发布 1 分钟   → TTL 0.21 天
发布 1 天      → TTL 0.21 天
发布 1 周      → TTL 0.21 天
发布 1 个月    → TTL 0.90 天
发布 1 年      → TTL 10.95 天
发布 10 年     → TTL 15.00 天

--- 双阶段拉取（12 specs，含 1 个坏包）---
输入: pkg-0@1.0.0, pkg-1@1.0.0, pkg-2@1.0.0, bad-pkg@1.0.0, pkg-4@1.0.0, ...
  阶段 1 后 missing: pkg-0@1.0.0, pkg-1@1.0.0, pkg-2@1.0.0, bad-pkg@1.0.0, pkg-4@1.0.0, pkg-5@1.0.0, pkg-6@1.0.0, pkg-7@1.0.0, pkg-8@1.0.0, pkg-9@1.0.0
  ✓ 写入 metaStore[pkg-10@1.0.0]
  ✓ 写入 metaStore[pkg-11@1.0.0]
  ✓ 写入 metaStore[pkg-0@1.0.0]
  ... (省略)
  ✓ 写入 metaStore[pkg-9@1.0.0]
最终 missing: bad-pkg@1.0.0
metaStore 大小: 11 / 输入 12

--- 时变缓存：写 TTL + validUntil ---
some-old-pkg: 包龄 1 年 → TTL 10.95 天，validUntil = 2026-08-14
```

注意 `阶段 1 后 missing` 那一行——12 个 spec 里第一批的 10 个因为混进了 `bad-pkg@1.0.0` 整批 throw，10 个全进 missing；第二批的 2 个正常拿到。然后单查兜底把这 10 个里的 9 个救回来，只剩 `bad-pkg@1.0.0` 真的拿不到。**对第一批来说，本来 1 次批量请求搞定的事，最终发成了 1 次批量 + 10 次单查 = 11 次请求**——这就是后面权衡 1 要讲的代价。

## 4 条关键权衡

### 权衡 1：批量并发 → 失败回退单查

**选择**：按固定大小（10 个一组）切片并发批量拉取；任何在批量阶段没拿到结果的 spec，进 missing 集合，第二阶段逐条单独重试。

**换来**：单个坏数据不会污染整批。即使一批 10 个里有 1 个让整批 throw，剩下 9 个也能在单查阶段被救回来，整体可用率高。模板对网络抖动、单条 500、间歇性 timeout 都很稳——坏包被自动隔离到单查阶段，不会扩散到整批。

**代价**：最坏情况请求量翻倍。一批 10 个里只要有一个让整批 throw，单查阶段就要再发 10 次请求——**这批的请求量从 1 变 11**。演示里 `阶段 1 后 missing` 那行 10 条就是真实写照：第一批 10 个 spec 因为混进 `bad-pkg` 整批挂掉，单查阶段又把这 10 个全发了一遍。更隐蔽的代价是**这套模板在版本信息拉取和漏洞信息拉取两条路径上各有一份近似实现**——BATCH_SIZE、并发上限、具体 batch API 各自独立配置，没抽到公共 util。后续如果发现某个边界 case（比如 batch 端点返回部分结果时丢字段），得记得两处都改，否则两条路径行为会悄悄分叉。

### 权衡 2：TTL 与包龄成正比

**选择**：最新版缓存的存活时长 = `clamp(包龄 × 3%, 5 小时, 15 天)`。包龄 = 当前时间 − 该包最近一次发布时间。

**换来**：稳定的老包缓存久、省请求；新热点包缓存短、保新鲜。一个发布了 1 年的包，TTL 大约 11 天——意味着用户两次打开 UI 之间只要隔不到 11 天，第二次就是零请求；而一个刚发版 1 周内的热点包，TTL 是 5 小时下限，能较快追上发版节奏。整套缓存的"新鲜度"自动跟随包的更新频率，**无需任何人工配参**，也不会因为某类包流量突增就把缓存打爆——上下限就是天然的安全网。

**代价**：新鲜度有硬下限和硬上限，两端都不平滑。一个流行包刚发了紧急安全补丁（比如修 0day），因为下限是 5 小时，前端最长可能这 5 小时之内还显示旧版的"已是最新"——这 5 小时之内用户看不到新版本，这是公式决定的硬下限，无法通过调参绕开。另一头，发布超过 1.4 年的冷门老包被 15 天上限顶住，它若突然时隔两年发了个新版本，前端最长有半个月还在显示旧的"最新版"。换句话说，**这套公式对"常年稳定的大多数包"友好，对"两端的小概率突变"迟钝**。

### 权衡 3：两套独立 storage

**选择**：版本固定信息按 `包名@版本` 键化、永久有效；最新版信息按 `包名` 键化、带 TTL；两套是独立的 storage 实例，互不干扰。storage 实例本身由调用方注入——CLI/dev 跑在 Node 里就注入文件系统 driver，WebContainer 跑在浏览器里就注入内存 driver，而本章关注的拉取逻辑跟"数据落在哪"完全解耦。

**换来**：不可变数据零开销命中——只要装过的版本，第二次开 UI 永远零请求；时变数据按需失效，过期就删再重取。两套失效策略各自调参、互不污染——永久缓存不会被 TTL 误清，TTL 缓存也不会被永久缓存占满。storage 注入的设计让同一份拉取代码能跨 CLI / WebContainer / 静态 build 复用，后端介质切换零改业务逻辑。

**代价**：调用方必须自己选对缓存读哪一套，没有统一的 `getMeta(name, version)` 帮你自动路由——传错 storage 拿到的就是 undefined 或者过期数据，且不会有任何报错提醒。另外，**序列化进磁盘的缓存字段一旦发布就被冻结——重命名会破坏旧版缓存的反序列化，所以字段名实际上是不可变契约的一部分**，哪怕你想清理也只能新增、不能改名，技术债一旦欠下就只能背着走。两套 storage 也意味着两份 `keys()`、两份过期判断、两套写回路径，样板代码重复不可避免。

### 权衡 4：漏洞信息合并写入既有 meta

**选择**：漏洞端点拉回结果后，对每条命中——读旧 meta → spread → 加 `vulnerability` 字段 → 写回原来的版本元信息条目。

**换来**：前端只读一份缓存就能同时拿到"发布时间 + 漏洞等级 + 漏洞链接"，不用前端 join 两套数据。UI 渲染列表时每行只需要一次 cache lookup，渲染路径极简；漏斗筛选、列表排序、详情面板都从同一个对象里取字段，没有跨 store 一致性问题。

**代价**：漏洞信息无法独立失效。版本元信息按 `name@version` 永久缓存，意味着只要这个 spec 还在缓存里，那条漏洞告警就跟着**永久挂着**——即使 npm registry 那边已经发布了修复版本、advisory 状态从 "high" 降级成 "fixed"，前端也察觉不到，会一直给用户亮红灯。要刷新漏洞必须连带重算整条 meta（实际上得先 invalidate 版本缓存才能触发漏洞重拉，而版本缓存是永久的——意味着正常路径下根本不会主动刷新）。这是用"信息独立性"换"读取路径简单"的典型取舍：读取越简单，失效越纠缠。

## 收尾

一句话总结：这一章不是讲怎么 fetch，是讲怎么**少 fetch、fetch 回来怎么放**。两套缓存分而治之解决"放多久"的问题，TTL 跟着包龄走解决"放多久才合理"的问题，批量+单查兜底解决"怎么少发请求又能扛住坏数据"的问题，漏洞合并写入解决"前端读取路径怎么短"的问题。四条权衡各自都有代价，但合在一起就是一份能扛 100 个依赖、能扛网络抖动、能扛过期告警的拉取策略。

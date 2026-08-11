# npm 元信息拉取：批量化、TTL、漏洞

> 本章属于 composite 层。前置：resolvePackage：把磁盘包变可读节点。
> 学完你能用一句话讲清：为什么这套拉取要把「具体版本的发布时间」和「最新版是几」放进两套缓存、各自的失效策略怎么定、批量失败时怎么不污染整批。

## 1. 为什么需要它

上一章「维护者行动算法」按 depName 聚合 + semver 判定，把「该升哪些依赖」算成了 actionable 列表——但这个判断只用了磁盘上的 package.json。一旦 UI 想显示「这版什么时候发的」「最新版是几」「有没有漏洞」，磁盘就回答不了，得去问 npm registry。

对着一两百个依赖，每个都去 fetch 一次，几个问题会同时找上来：

- npm registry 的端点会节流，密集请求会被拒；
- 网络抖动会把整批打断，单条失败容易连累整批；
- 缓存得太狠又会出「老漏洞永远挂着」的事故——用户看到「安全」两个字，其实早就有了新的 advisory。

矛盾的根子在 npm registry 的元信息其实混着两类东西——「这个具体版本是什么时候发布的」是历史事实，发完版就永远不变；「这个包的最新版是几」是当下事实，会随作者发新版本而漂移。把这两类东西塞进同一个缓存、用同一个失效策略，只会两头不讨好：按永久缓存，最新版会过期骗人；按带 TTL 缓存，连永久事实也要反复重拉浪费请求。

打个比方一次性点透：版本固定信息像「出厂说明」，一次写好就不再变；最新版信息像「今天的天气」，每天都在变。把出厂说明和今天的天气放进同一个抽屉，要么天气过期了还在用，要么你为了查今天的天气把出厂说明也天天重新抄一遍。所以拆两个抽屉，各管各的失效方式。

## 2. 核心思想

不要把这件事看成「我有一堆 spec 要查」——这只是表象。本质上是**识别出两类信息生命周期**：永久事实，和当下事实。一旦把它们区分开，剩下的策略——键空间怎么设计、失效用永久还是带 TTL、批量大小定多少、失败怎么兜底——都自动有了答案。

整个机制就是这两套生命周期的具体化：两套独立的键空间和 storage、各自挑好的失效策略、加上一个被两个端点（版本元信息、漏洞信息）近似复制的「批量 + 回退」模板。

## 3. 心智模型：一次拉取的四步生命周期

入口：调用方扔进来一批 `name@version`（要发布时间/漏洞）或一批 `name`（要最新版）。

1. **求差集**：列出缓存里已有的键，把这批 spec 中已知的剔除——已知的不发请求。
2. **批量切分**：剩下的「未知」按固定 BATCH_SIZE 切片，每片用并发上限保护的批量端点去拉。
3. **失败回退**：批量阶段里没拿到结果的 spec 进 `missingSpecs`；批量调用整体 throw 时整队都进 `missingSpecs`；批量都 settle 后，再对 `missingSpecs` 逐条单独调用单查 API 兜底。
4. **写回**：每条命中的结果按对应缓存的失效策略写回——版本固定信息直接写永久缓存；最新版信息算出 TTL 后连同 `validUntil` 时间戳一起写回时变缓存。

注意校验是**破坏性失效**：时变缓存里 `validUntil` 已过的条目，不是惰性标脏，而是先 `removeItem` 再当未知处理——重取失败的话旧数据就丢了。这套机制的偏好是「宁可没数据也不要误导用户」。

## 4. 关键权衡

### TTL 跟包龄走：稳定包缓存久，热点包缓存短

时变缓存（最新版信息）的存活时长不写死，而是按包龄伸缩——`ttl = clamp(包龄 × 3%, 5 小时, 15 天)`。包龄 = 当前时间 − 该包的发布时间。一个一年没更新过的包，TTL 大约是 10 天；一个刚发布 5 小时的新版，TTL 取 5 小时下限。

- **换来**：稳定包缓存得久省请求，热点包缓存得短保新鲜——同一个公式自动适配两类包。
- **代价**：流行包刚发版的窗口里，前端最长可能 5 小时看不到新版本；冷门老包的最新版可能 15 天后才被察觉。
- **化解的本质矛盾**：缓存的新鲜度（请求量代价）vs 包的更新频率（信息时效性）。把 TTL 与包龄耦合，本质上是把「这个包有多大概率发新版本」近似为「这个包过去多久没发新版」——经验上对绝大多数 npm 包都成立。

### 永久 / 时变 拆成两套独立缓存

版本固定信息按 `name@version` 键化，永久有效；最新版信息按 `name` 键化，带 `validUntil`。两套在底层是独立的 storage 实例，连目录都不同。

- **换来**：永久数据零开销命中（一次写入永不重拉），时变数据按需失效；两套失效策略互不干扰。
- **代价**：调用方必须自行选对缓存——传错了要么拿到永久但永远不变的数据，要么拿到时变但很快过期的数据。缓存序列化字段名（含几个早已冻结的拼写 typo）一旦写入磁盘就无法再改名——旧缓存反序列化会失败。
- **化解的本质矛盾**：永久数据的高效复用 vs 时变数据的及时失效——它们要的失效策略是反的，强行合一只会两头不讨好。这个矛盾在所有「事实型数据 + 状态型数据」混存的系统里都会出现（比如用户资料里的「注册时间」vs「在线状态」），通用解都是按生命周期分桶。

### 批量切分 + 失败回退单查

每个端点都用同一个模板：先把 spec 列表按 BATCH_SIZE 切片（版本元信息端点用 10、漏洞端点用 100——参数对应不同端点的容忍度），每片并发跑批量调用；任何在批量阶段没拿到结果的 spec 进 `missingSpecs`，批量整体 throw 时整队进 `missingSpecs`；批量都 settle 后，对 `missingSpecs` 逐条单独调用单查 API 兜底。

- **换来**：单个坏数据不会污染整批——一条失败有第二次机会，整体可用率高。
- **代价**：最坏情况请求量翻倍；同一段「批量 + 回退」模板在版本信息和漏洞信息两个文件里被近似复制了一遍，差异仅在 BATCH_SIZE、并发数、调用的具体 batch API——抽公共 util 的工程收益没人去拿。
- **化解的本质矛盾**：批量的吞吐效率 vs 单条失败时的精细重试。批量请求的部分失败是个普适问题——要么整批丢、要么留出兜底通道——这套「批量 + missingSpecs 单查兜底」是工程上最常见的折中模板，在 MapReduce、流式 ETL 里都能看到同样的骨架。

### 漏洞信息合并写入既有 meta

漏洞拉回来后不是另开一份缓存，而是 mutate 进既有的版本元信息条目——读旧 meta → spread → 加 `vulnerability` 字段 → 写回。

- **换来**：前端读一份缓存就能同时拿到「发布时间 + 漏洞等级」，省掉一次缓存查询和一次 join。
- **代价**：漏洞信息无法独立失效——只要版本元信息条目还在（永久缓存），过时的漏洞告警就会一直挂着；要刷新必须连带重算整条 meta。即便 npm registry 撤回了某条 advisory，前端看到的还是旧值。
- **化解的本质矛盾**：组合展示的读取便利 vs 各自独立失效的精细化。这个权衡和上一章 resolvePackage 的 mutate 不是一回事——resolvePackage 的 mutate 角度是「零拷贝 vs 副作用」，这里 mutate 的角度是「组合展示 vs 失效粒度被绑死」。同样是 mutate，原理维度不同。

## 5. 最小原理演示

下面这段 TS 演透三件事：(a) TTL 按包龄伸缩的边界（5 小时 / 10 天 / 15 天三个拐点）；(b) 批量切分 + 失败回退单查的双阶段控制流；(c) 永久 / 时变两套缓存的读写分工。registry 用 mock 函数代替，故意让它 30% 概率批量失败，触发回退分支——重点不是 HTTP 跑通，而是 TTL 公式与双阶段重试在代码里能被肉眼追踪。

```ts
const HOUR = 1000 * 60 * 60
const DAY = HOUR * 24

// 永久缓存：版本固定信息，按 `name@version` 键化，永不失效
const immutableCache = new Map<string, { publishedAt: number }>()

// 时变缓存：最新版信息，按 `name` 键化，带 validUntil
const mutableCache = new Map<string, { latest: string; publishedAt: number; validUntil: number }>()

// TTL 公式：5 小时 ~ 15 天，包龄 × 3%
// 一年的包 ≈ 10 天 TTL；刚发 5 小时的包取下限；十几年老包取上限
function computeTtl(publishedAt: number, now = Date.now()): number {
  const age = now - publishedAt
  return Math.min(Math.max(5 * HOUR, age * 0.03), 15 * DAY)
}

// 故意不稳定的 mock registry：批量端点 30% 概率整批失败
function mockBatch(specs: string[]): { spec: string; publishedAt: number }[] {
  if (Math.random() < 0.3) throw new Error('batch 503')
  return specs.map(s => ({ spec: s, publishedAt: Date.now() - 365 * DAY }))
}
function mockSingle(spec: string): { spec: string; publishedAt: number } {
  return { spec, publishedAt: Date.now() - 365 * DAY }
}

// 双阶段拉取：批量切分 + 失败回退单查
async function fetchWithFallback(
  specs: string[],
  sink: (spec: string, publishedAt: number) => void,
) {
  const missing = new Set<string>()
  const BATCH = 10
  const batches: Promise<void>[] = []
  // 阶段一：切片 + 并发批量
  for (let i = 0; i < specs.length; i += BATCH) {
    const queue = specs.slice(i, i + BATCH)
    batches.push((async () => {
      try {
        for (const r of mockBatch(queue)) sink(r.spec, r.publishedAt)
      } catch {
        queue.forEach(s => missing.add(s))   // 整批失败 → 全队进 missing 走单查
      }
    })())
  }
  await Promise.all(batches)
  // 阶段二：对失败 spec 逐条单查兜底
  await Promise.all([...missing].map(async s => {
    try {
      const r = mockSingle(s)
      sink(r.spec, r.publishedAt)
    } catch { /* 单查也失败就放弃 */ }
  }))
}

// 入口：拉最新版信息——校验过期 → 拉未知 → 算 TTL 写回
async function getLatest(names: string[]) {
  const out = new Map<string, any>()
  const unknown: string[] = []
  // 破坏性失效：validUntil 已过 → 先删除，再当未知处理
  for (const n of names) {
    const c = mutableCache.get(n)
    if (!c || c.validUntil < Date.now()) {
      mutableCache.delete(n)
      unknown.push(n)
    } else {
      out.set(n, c)
    }
  }
  // 批量 + 回退拉取
  await fetchWithFallback(unknown.map(n => `${n}@latest`), (spec, publishedAt) => {
    const name = spec.replace(/@latest$/, '')
    const meta = {
      latest: 'X.Y.Z',
      publishedAt,
      validUntil: Date.now() + computeTtl(publishedAt),  // TTL 跟包龄走
    }
    mutableCache.set(name, meta)
    out.set(name, meta)
  })
  return out
}
```

## 6. 执行轨迹：一条 spec 的缓存重生

拿一个具体输入走一遍——查 `getLatest(["react"])`，假设 `mutableCache` 里 react 旧条目的 `validUntil` 已经过去 5 分钟。

1. **校验**：读旧 meta → `validUntil < now` → `mutableCache.delete("react")` → react 进 unknown 队列。此时 `mutableCache` 里已经没有 react 了（破坏性失效，不是标脏）。
2. **批量阶段**：unknown 拼成 `["react@latest"]`，BATCH_SIZE=10 切成 1 批，调 `mockBatch`。命中（70% 概率）拿到 `{ publishedAt: 一年前的时间戳 }`。
3. **回调写回**：算 `age = now - publishedAt ≈ 365 × DAY` → 算 `ttl = clamp(365d × 3%, 5h, 15d) ≈ 11d` → 写回 `mutableCache.set("react", { latest, publishedAt, validUntil: now + 11d })`。
4. **结果**：`Map { "react" → { latest, publishedAt, validUntil } }`，下一次 11 天内查 react 直接命中，零请求。

如果第 2 步批量端点 30% 概率挂了：catch 里 `missing.add("react@latest")` → 阶段二单查 → 成功后走同一个回调 → 同一个写回路径——这就是双阶段模板的价值。

## 7. 教学简化说明

本章演示故意省略：真实 HTTP（fetch、批量端点请求体构造）、pLimit 并发原语的内部、unstorage 抽象层与 fs-lite / memory driver 切换、漏洞信息合并（机制同上演示但走独立端点，且包含 scoped 包名的 `/` → `__` mangle 与漏洞等级择最高的细节）、缓存字段名已冻结 typo 的历史包袱。这些都是工程细节，不是原理主线。

## 8. 小结

把「不变的事实」和「会漂移的事实」识别成两个生命周期，让它们各自挑失效策略——TTL 与包龄耦合、批量 + 回退单查、漏洞合并写入，都是这两套生命周期落地时的具体形状。

缓存的「发布时间 + 漏洞等级」已经备好，下一章「响应式 payload 级联：main→excluded→available→filtered」会让它和过滤状态一起，组成前端能直接消费的 payload。

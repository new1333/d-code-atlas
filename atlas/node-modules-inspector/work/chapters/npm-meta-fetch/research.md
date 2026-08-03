# npm 元信息拉取：批量化、TTL、漏洞 · 源码精读

## 给 Writer 的教学钩子（必填，8 子项缺一不可）

- **用户痛点 / 场景**：装了上百个依赖后，UI 想显示「这个包什么时候发布的、有没有漏洞、最新版是几」——意味着对每个包都要去 npm registry 查一次。直接逐个 fetch 会被节流、被网络抖动反复打断；纯前端缓存又会用过期的漏洞信息骗用户「安全」。需要一种**可控请求量 + 可控新鲜度**的拉取策略。

- **一句话核心思想**：**两套缓存分而治之——版本固定的永久缓存、版本会变的按"包龄"算 TTL；批量拉、失败回退单查**。

- **设计动机（为什么需要它）**：npm registry 的元信息天然分两类——「这个具体版本的发布时间」是历史事实，永不变；「这个包的最新版是几」是当下事实，会随发版漂移。把它们塞进同一个缓存会让失效策略互相打架（永久 vs 时变）。把两者拆开后，每套缓存可以用最适合自己的失效策略，批量化与重试模板也能各自调参数。

- **关键权衡（4 条）**：
  - **批量并发 → 失败回退单查**：选择「按固定大小切批并发拉取 + 失败的规格单独重试」 → 换来「单个坏数据不会污染整批、整体可用率高」 → 代价「最坏情况请求量翻倍、同一段重试模板在『版本信息』『漏洞信息』两个文件里被复制了一遍」。
  - **TTL 与包龄成正比**：选择「最新版缓存的存活时长 = 包龄 × 3%（夹在 5 小时下限与 15 天上限之间）」 → 换来「老稳定包缓存久省请求、新热点包缓存短保新鲜」 → 代价「流行包刚发版时前端最长 5 小时看不到新版本；冷门老包的最新版可能 15 天后才被察觉」。
  - **不可变 / 时变 两套独立缓存**：选择「版本固定信息按『包名@版本』永久缓存 + 最新版信息按『包名』带 TTL 缓存，两套独立 storage」 → 换来「不可变数据零开销命中、时变数据按需失效，两套失效策略互不干扰」 → 代价「调用方必须自行选对缓存；缓存序列化的字段名（含已冻结的拼写 typo）一旦写入磁盘就无法再改名」。
  - **漏洞信息合并写入既有 meta**：选择「漏洞拉回后 mutate 进既有的版本元信息条目（spread + 加 vulnerability 字段）」 → 换来「前端只读一份缓存即可同时拿到发布时间与漏洞等级」 → 代价「漏洞信息无法独立失效——只要版本元信息还在，过时的漏洞告警会一直挂着；要刷新必须连带重算整条 meta」。

- **最小心智模型（7 步）**：
  1. 接到一批规格列表 → 与缓存键集合做差集，得到「未知」子集（已知的不发请求）。
  2. 「未知」按固定批量大小切片 → 用并发上限保护的批量拉取。
  3. 批量中失败 / 没拿到发布日期的 → 进「待重试」集合。
  4. 重试阶段：逐条单独拉取，成功的从「待重试」移除。
  5. 命中数据 → 仅「最新版」路径要算存活时长并连同「有效截止时间戳」一起写回缓存。
  6. 校验阶段：缓存中「有效截止时间戳」已过的条目 → 先删除再当未知处理（破坏性失效，不是惰性）。
  7. 漏洞补充：对最终结果再走一遍批量漏洞端点，结果 spread 合并进既有缓存条目。

- **最小原理演示（替代旧"复刻范围"）**：
  - **应演示**：一个 ~50 行的 TS 脚本，演透三件事——(a) 给定 `publishedAt` 算出 TTL 的边界（5h / 10d / 15d 三个拐点）、(b) 批量切分 + 失败回退单查的双阶段控制流、(c) 「不可变 / 时变」两套 storage 的读写分工。registry 用一个本地 mock 函数代替（让它故意随机让某条批量失败，触发回退分支）。
  - **应故意省略**：真实 HTTP / fetch 细节、并发原语 pLimit 的内部、漏洞信息合并（属于第二个机制，可单开演示）、unstorage 抽象层与 driver 切换、CLI / RPC 集成。
  - **演示载体建议**：本仓库是 TS/Node，建议写成一段能 `tsx demo.ts` / `bun run demo.ts` 直接跑的独立脚本（不要求真连 npm registry——用 mock 即可，能跑最好但不强求）。重点不是「跑通 HTTP」而是「让 TTL 公式与双阶段重试在终端里能被肉眼追踪」——每个关键节点 `console.log` 一行轨迹。

- **正文不宜展开的细节**：pLimit 并发原语的实现；unstorage 的 fs-lite / memory driver 切换（WebContainer 场景用内存驱动）；漏洞端点里 scoped 包名 `/` → `__` 的 mangle 规则；缓存字段名拼写 typo 的历史包袱；`mode: 'no-cors'` 标志的可疑出现（疑似遗留）。

- **推荐的一个执行轨迹例子**：输入 `["react@18.2.0", "lodash@4.17.21"]`，其中 react 最新版缓存的「有效截止时间」已过。中间态：(a) lodash 版本缓存命中，零请求；(b) react 版本缓存命中、但最新版缓存过期 → 删除 → 进未知队列 → 批量拉取成功 → 算出 1 年老包 TTL ≈ 10 天 → 写回；(c) 漏洞批量端点返回 react 18.2.0 有 high 级告警 → 读旧 meta → spread + vulnerability → 写回。输出：`Map { "react@18.2.0" → { publishedAt, vulnerability: {...} }, "lodash@4.17.21" → {...} }`。

> 以上钩子供 Writer 写「动机→核心思想→心智模型→关键权衡→原理演示」；下面事实部分供核对，不要被 Writer 当目录照抄。

## 概念要点

- **两套缓存的键与语义分家**：版本固定信息按 `name@version` 键化（不可变、永久有效）；最新版信息按 `name` 键化（带 TTL、随时间失效）。两者的 TS 类型在 `node-modules-tools` 中分别定义为 `NpmMeta` 与 `NpmMetaLatest`，后者显式 extends 前者并新增 `version` / `fetchedAt` / `validUntil` 字段。
  源码位置: packages/node-modules-tools/src/types/node.ts:76-103

- **批量大小与并发上限因端点而异**：版本元信息走 `BATCH_SIZE = 10` + `pLimit(10)`（保守、对应 fast-npm-meta 的 per-spec 请求）；漏洞信息走 `BATCH_SIZE = 100` + `pLimit(100)`（激进、对应 npm registry 的单次大 POST bulk 端点）。这种不对称直接反映了两个端点对客户端的容忍度差异。
  源码位置: packages/node-modules-inspector/src/shared/version-info.ts:18-19
  源码位置: packages/node-modules-inspector/src/shared/vulnerable-info.ts:95-96

- **双阶段拉取模板（批量 → 单查回退）**：两处 `fetchBatch` 函数体几乎逐行重复——先按 BATCH_SIZE 切片并发跑批量；任何在批量阶段没拿到 `publishedAt` 的 spec 进 `missingSpecs` 集合；批量全部 settle 后，再对 `missingSpecs` 逐条单独调用单查 API。批量调用整体 throw 时，把队列里所有 spec 全部塞进 `missingSpecs` 走单查兜底。
  源码位置: packages/node-modules-inspector/src/shared/version-info.ts:12-63
  源码位置: packages/node-modules-inspector/src/shared/vulnerable-info.ts:89-144

- **TTL 公式（本章的灵魂）**：最新版元信息的存活时长 = `clamp(包龄 × 3%, 5h, 15d)`。包龄 = 当前时间 − 该包的发布时间。源码注释明确给出参考点：「1 年的包大致 10 天 TTL」。这把"缓存新鲜度"和"包更新频率"耦合起来——稳定包老不更新，缓存可以久；热点包常更新，缓存必须短。
  源码位置: packages/node-modules-inspector/src/shared/version-info.ts:135-147

- **缓存有效性的三步谓词**：判断一条最新版缓存是否还有效——(1) meta 存在；(2) `validUntil` 不小于当前时间；(3) `publishedAt` 字段为真。任一不满足即视为无效。
  源码位置: packages/node-modules-inspector/src/shared/utils.ts:3-9

- **破坏性失效（删后再取）**：最新版缓存条目过期时，先 `removeItem` 再当未知处理。若重取失败，旧数据已丢失——以"宁可没数据也不要误导用户"换实现简单。
  源码位置: packages/node-modules-inspector/src/shared/version-info.ts:116-127

- **漏洞信息的合并式写入**：漏洞拉到后，对每条命中：读旧 meta → spread → 加 `vulnerability` 字段 → 写回。前端读一份 meta 就能拿到「发布时间 + 漏洞等级」。
  源码位置: packages/node-modules-inspector/src/shared/vulnerable-info.ts:146-176

- **漏洞批量的请求体构造**：把 specs 按"包名 → 版本集合"聚合后转成数组——`{ "lodash": ["4.17.0", "4.17.10"], ... }`——POST 给 npm registry 的 bulk 端点。Scoped 包名（`@scope/pkg`）的 `/` 被替换成 `__`（mangle 规则的来源未经注释说明）。
  源码位置: packages/node-modules-inspector/src/shared/vulnerable-info.ts:33-62

- **漏洞等级数值化以择最高**：用 `AuditLevel` map 把 low/moderate/high/critical 映射成 1/2/3/4，对每条 spec 在所有命中 advisory 中挑数值最大的那条作为展示。配合 `verkit` 的 `satisfies` 用 `vulnerable_versions` 范围做版本匹配。
  源码位置: packages/node-modules-inspector/src/shared/vulnerable-info.ts:24-29, 67-86

- **storage 由调用方注入**：两个对外函数都不直接 import storage 实例，而是从 options 参数接收。这让 WebContainer 运行时可以注入内存 driver，CLI/dev 注入 fs-lite driver，而本 chapter 关注的拉取逻辑保持传输无关。
  源码位置: packages/node-modules-inspector/src/shared/types.ts:96-102
  源码位置: packages/node-modules-inspector/src/node/storage.ts:1-23
  源码位置: packages/node-modules-inspector/src/node/webcontainer/server.ts:19-20

## 关键调用链

CLI / RPC handler 拿到 packages 列表
→ `getPackagesNpmMeta(specs, { storageNpmMeta })`
   → `storage.keys()` 求 `unknown = packages − known`
   → `fetchBatch(unknown, onResult)`（BATCH=10, pLimit=10；批量失败 → 单查兜底）
   → onResult 写回 storage + 内存 map
   → `addPackagesNpmVulnerabilityMeta(packages, options)`（独立批量端点，spread 合并）
   → 最后用 storage 回填 map 中缺失的 specs
   → 返回 Map<spec, NpmMeta>

→ `getPackagesNpmMetaLatest(pkgNames, { storageNpmMetaLatest })`（独立路径）
   → 校验包名（`@` 段数 < 3）
   → 读 cache → `isNpmMetaLatestValid` 判断 → 无效则 removeItem
   → `unknown = packages − map`
   → `fetchBatch(unknown.map(p => `${p}@latest`), onResult)`（BATCH=10, pLimit=10）
   → onResult 算 TTL（clamp 5h~15d）+ 写回 storage
   → 返回 Map<name, NpmMetaLatest | null>

源码位置: packages/node-modules-inspector/src/shared/version-info.ts:66-157
源码位置: packages/node-modules-inspector/src/shared/vulnerable-info.ts:146-176

## 源码摘录（带行号，全文累计 ≤ 30 行）

**TTL 公式（核心权衡 #2 的直接来源）**：
```ts
// TTL is based on how long the package has been published
// Min 5 hours, max 15 days
// Otherwise it's 3% of the time passed (1 year package will have roughly 10 days TTL)
const ttl = Math.min(Math.max(5 * HOUR, timePassed * 0.03), 15 * DAY)
```
源码位置: packages/node-modules-inspector/src/shared/version-info.ts:135-138

**双阶段重试模板（核心权衡 #1 的直接来源）**：
```ts
if (missingSpecs.size) {
  await Promise.all(Array.from(missingSpecs).map(spec => limit(async () => {
    try {
      const result = await getLatestVersion(spec, { metadata: true })
      if ('publishedAt' in result && result.publishedAt) {
        missingSpecs.delete(spec)
        onResult(result)
      }
    } catch {}
  })))
}
```
源码位置: packages/node-modules-inspector/src/shared/version-info.ts:46-58

**有效性谓词（核心权衡 #3 的失效侧）**：
```ts
export function isNpmMetaLatestValid(meta?: NpmMetaLatest): boolean {
  if (!meta) return false
  if (meta.vaildUntil < Date.now()) return false
  return !!meta.publishedAt
}
```
源码位置: packages/node-modules-inspector/src/shared/utils.ts:3-9

**两套独立 storage（核心权衡 #3 的存储侧）**：
```ts
export const storageNpmMeta = createStorage<NpmMeta>({
  driver: driverFs({ base: join(process.cwd(), 'node_modules/.cache/node-modules-inspector/npm-meta') }),
})
export const storageNpmMetaLatest = createStorage<NpmMetaLatest>({
  driver: driverFs({ base: join(process.cwd(), 'node_modules/.cache/node-modules-inspector/npm-meta-latest') }),
})
```
源码位置: packages/node-modules-inspector/src/node/storage.ts:7-17

**漏洞合并写入（核心权衡 #4 的直接来源）**：
```ts
const oldMeta = await storage.getItem(spec)
if (oldMeta) {
  const meta: NpmMeta = { ...oldMeta, vulnerability: { title: r.title, url: r.url, level: r.level } }
  map.set(spec, meta)
  await storage.setItem(spec, meta)
}
```
源码位置: packages/node-modules-inspector/src/shared/vulnerable-info.ts:158-169

## 易混淆 / 边界 / 推断

- **事实**：`NpmMetaLatest` 的字段名 `fetechedAt`、`vaildUntil` 是拼写错误（应为 fetched / valid），但因已写入磁盘缓存且属于跨进程序列化字段，重命名会导致旧缓存反序列化失败。这两个 typo 在 `node-modules-tools` 的类型定义中被原样保留。
  源码位置: packages/node-modules-tools/src/types/node.ts:97-102

- **事实**：`getPackagesNpmMetaLatest` 在入口处会校验包名——若 `p.split(/@/g).length >= 3` 直接 throw `Invalid package name`。这是为了拒绝 `@scope/pkg@1.2.3` 这种带版本的 spec 进入"按 name 键化"的最新版缓存。
  源码位置: packages/node-modules-inspector/src/shared/version-info.ts:111-114

- **事实**：`getPackagesNpmMeta` 用 `storage.keys()` 拿全部已知键再 filter——这是 unstorage 抽象下的"列出所有键"操作；对 fs-lite driver 等价于列目录。该函数同时调用 `addPackagesNpmVulnerabilityMeta`，意味着"取版本元信息"会副作用式触发"补漏洞信息"。
  源码位置: packages/node-modules-inspector/src/shared/version-info.ts:73-87

- **推断**：漏洞端点的 fetch 配置里写了 `mode: 'no-cors'`，按 Fetch 规范这会让响应变成 opaque、`.json()` 应当读不到内容——但代码随后立即 `await result.json()` 并解析。这要么是 (a) 残留的实验代码 / 复制粘贴错误，要么是 (b) 在某些 Node fetch 实现下 `no-cors` 被静默忽略。**未理解：该标志在生产中是否真的生效**，建议 Critic 在评审时让 Writer 把这一点列入"正文不宜展开的细节"而非作为机制讲解。
  源码位置: packages/node-modules-inspector/src/shared/vulnerable-info.ts:55-62

- **推断**：scoped 包名 mangle（`/` → `__`）的来源没有任何注释解释，但请求体与响应体两侧使用同一份 mangle 后的键，因此即使 npm registry 实际期望的格式不同，至少自洽。**未理解**：npm registry 的 bulk audit 端点是否原生支持这种 `__` mangle，还是这条代码路径只在某些路径下偶然工作。
  源码位置: packages/node-modules-inspector/src/shared/vulnerable-info.ts:38

- **事实**：双阶段批量模板（`fetchBatch`）在 `version-info.ts` 与 `vulnerable-info.ts` 中各有一份近似实现，差异仅在 BATCH_SIZE、并发数、调用的具体 batch API。模板本身未被抽到公共 util。
  源码位置: packages/node-modules-inspector/src/shared/version-info.ts:12-64
  源码位置: packages/node-modules-inspector/src/shared/vulnerable-info.ts:89-144

- **事实**：`getPackagesNpmMeta` 末尾有一段"用 storage 回填 map 中缺失的 specs"的兜底循环——这处理了"批量阶段没回调 onResult 但 storage 里有旧值"的情况（典型场景：包刚被另一进程拉过、或批量端点 silent skip）。
  源码位置: packages/node-modules-inspector/src/shared/version-info.ts:92-98

- **事实**：WebContainer 运行时把 fs-backed storage 替换成 `driverMemory()`——因为浏览器内无法直接写文件系统。这套 options 注入设计让"拉取逻辑"与"持久化介质"完全解耦，是后续 backend 抽象层能跨 dev/webcontainer/static 复用的前提。
  源码位置: packages/node-modules-inspector/src/node/webcontainer/server.ts:19-20
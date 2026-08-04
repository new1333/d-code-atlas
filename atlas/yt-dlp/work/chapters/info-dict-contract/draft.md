# info_dict 数据总线与提取器骨架

假设你今天要新接一个视频站点。真正折磨你的往往不是「这站点逻辑有多绕」，而是你发现每接一个站点，都在重复同一套脏活：下载网页、猜编码、用正则抠标题、读开放图谱标签、解析 HLS 清单、处理地区封锁、给一堆格式去重……如果各写各的，一千个站点就有一千份各自漂移的样板代码，更糟的是每个站点吐出来的数据形状都不一样，下游根本没法统一处理。

这一章要讲的就是 yt-dlp 怎么把这件事一次性治好：**让整个系统只说一种语言——一个字段特别丰富的「胖字典」在各个阶段之间流动；再用一个厚实的基类，把所有跨站点重复的抓取脏活吸收掉，子类只写「这一个站点到底怎么抠」这几十行。**

## 先认识这趟旅程的「通用货车」：info_dict

整个下载流水线被切成好几段：提取 → 选格式 → 下载 → 后处理。这些段由完全不同的模块负责。要让它们能协作，最直接的办法是——找一种大家都认的数据格式，让它像一辆货车一样从开头开到结尾，每个站点都「读几个字段、写几个字段」。

yt-dlp 选的这辆货车叫 `info_dict`，说白了就是一个普通对象（在源码里是 Python 字典，我们演示时用 TS 对象），字段特别多。提取器把抓到的数据填进去，编排器读里面的 `formats` 去选格式，下载器读里面的 `protocol` 去选下载策略，后处理器又读写里面的元数据。每一段都是对着同一个对象做纯变换。

用一个类比点透：这辆货车就像工地上的公共留言板——谁都能往上读、往上写，没人规定你非得先去建一个专门的表格。好处是接一段新流程只要约定几个新字段名就行，不用动任何类型定义；代价我们放到后面关键权衡里细说。

## 一个视频结果的硬契约

虽然这块「留言板」整体很松散，但对于「单个视频」这种最常见的结果，它有一条硬规矩必须遵守：

- 必须有 `id`（视频唯一标识）和 `title`（标题）；
- 必须给出 `formats`（一组可选格式，每个格式本身又是一个小对象）或者 `url`（一条直链），二选一。

说人话就是：你至少得告诉下游「这是哪个视频、叫什么、从哪能下到」。满足了这三点，一个最朴素的视频结果长这样：

```ts
{
  id: 'abc123',
  title: '我的第一个视频',
  formats: [
    { url: 'https://cdn.example/abc_720.mp4', height: 720 },
    { url: 'https://cdn.example/abc_360.mp4', height: 360 },
  ],
}
```

## 一个判别字段，让一个对象表达多种结果

货车要拉的货不止「单个视频」一种。有时候一个 URL 打开是一个播放列表（里面套着几十个视频）；有时候提取器发现自己处理不了，得把 URL 转交给另一个更合适的提取器再提一次。

如果按教科书做法，这里该建一套面向对象的继承体系：`VideoResult`、`PlaylistResult`、`RedirectResult` 各自定义类。yt-dlp 偏不——它选了一个更省事的办法：**给货车再加一个字符串字段 `_type` 当判别符。**

- 没写 `_type`（或缺省）→ 当作 `'video'`，就是上面的单个视频；
- `'playlist'` / `'multi_video'` → 这是一组视频，真正的条目放在 `entries` 数组里；
- `'url'` → 「我只是个中转站，请把我的 `url` 交给别的提取器再提一次」；
- `'url_transparent'` → 同样是转发，但它声明「我身上带的额外信息（比如标题、缩略图）比目标 URL 那边还准」，编排器据此决定覆写顺序。

换句话说，提取器对外永远只返回一种东西——一个字典。至于「这是啥种类」，全靠 `_type` 这一个字段告诉编排器。编排器拿到字典后，用一串 `switch (_type)` 分派即可：

```ts
function dispatch(result: InfoDict) {
  switch (result._type ?? 'video') {
    case 'video':        return 选格式并下载(result)
    case 'playlist':
    case 'multi_video':  return 展开entries并逐个递归(result)
    case 'url':
    case 'url_transparent': return 转发给别的提取器再提(result.url)
  }
}
```

为了少写几行容易写错的样板，基类还提供了两个工厂方法，把「带判别字段的对象」做成现成的惯用构造：

```ts
// 产出 { _type: 'url_transparent'?, url }
function urlResult(url, transparent = false) {
  return { _type: transparent ? 'url_transparent' : 'url', url }
}
// 产出 { _type: 'multi_video'?, entries }
function playlistResult(entries, multi = false) {
  return { _type: multi ? 'multi_video' : 'playlist', entries }
}
```

这下你明白「一个判别字段做多态分派」是什么意思了：用最便宜的字符串，换掉了整套类型继承。

## 把脏活收进基类：`_real_extract` 是子类唯一要写的入口

光有货车还不够。前面说过，解析一个网页有大量跨站点的重复机械动作。yt-dlp 把这些动作统统塞进一个叫 `InfoExtractor` 的基类，做成一个工具箱，子类拿来就能用。

而这个工具箱对外只暴露一个真正的「业务入口」——`_real_extract(url)`。基类对它的定义非常干脆：默认直接抛 `NotImplementedError`，意思就是「我不懂怎么解析这个站点，子类你必须自己实现」。于是「解析一个站点」这件复杂的事，就被压缩成了：**写一个 `_real_extract`，把 URL 拿进来，用基类给你的工具从页面里抠数据，最后还回去一个填好的字典。**

基类工具箱里都有什么？挑几类代表：

- `_download_webpage(url)`：下载一个网页，返回 HTML 字符串（编码猜测、阻塞检测等脏活都被它吸收了）；
- `_search_regex(patterns, html, name)`：拿一组正则去 HTML 里抠第一个非空匹配组，抠不到还能按你的意愿决定是报错还是放过；
- `_og_search_title` / `_og_search_thumbnail` 等：专门去 HTML 的开放图谱标签里找标题、缩略图；
- `_json_ld`：解析页面里的 JSON-LD 结构化数据；
- `_extract_m3u8_formats`：解析 HLS 清单，把一串分片 URL 整理成格式列表。

你看，从「下载」到「正则」到「结构化数据」到「清单解析」，网页抓取里你能想到的脏活，基类基本都备好了。子类的 `_real_extract` 往往就是把这些工具串几行调用而已。

### 唯一的网络出口：基类替子类调好传输门面

这些工具里，凡是需要联网的，最终都汇聚到同一个出口：`_request_webpage`，而它的核心就一行——

```python
return self._downloader.urlopen(self._create_request(...))
```

这行是什么意思？它说的是：提取器自己根本不操心「用什么引擎发请求（urllib / requests / curl_cffi……）」，它只是把请求对象交给编排器（`self._downloader`）的 `urlopen` 门面去发。**「请求是与传输无关的中立对象、多个 handler 竞争、编排器择优」这套机制属于第 1 章『可插拔传输层』，那里已经讲透了，这里不重复。** 本章只看一件事：提取器是这个门面的一个消费者，它只管「我要发什么」，引擎怎么选它一概不管。

顺带说一句：上面「提取器怎么被 URL 匹配选中、靠类名后缀被注册发现」这套，是第 2 章『约定胜配置的插件注册机制』的主题，也已经讲透了。本章只管「被选中之后，提取器骨架如何履约、产出那个字典」。

## 元编程：一个工厂函数批量造出整排样板方法

工具箱里有意思的是那些 `_download_xml` / `_download_json` / `_download_socket_json` / `_download_webpage` 方法。它们两两成对：一个「带句柄版」（`_download_json_handle`，返回解析结果 + 响应句柄）和一个「纯内容版」（`_download_json`，只返回解析结果）。你看这四个下载方法，签名几乎一模一样，唯一区别只是「下完之后用什么解析器去 parse」。

yt-dlp 没有把这几对方法各写一遍。它写了一个工厂函数，靠「换一个 parser 名字」就批量生成了一整排方法：

```python
_download_xml_handle, _download_xml        = __create_download_methods('xml', '_parse_xml', ...)
_download_json_handle, _download_json      = __create_download_methods('json', '_parse_json', ...)
_download_socket_json_handle, _download_socket_json = __create_download_methods('socket_json', ...)
__download_webpage                          = __create_download_methods('webpage', None, ...)[1]
```

`__create_download_methods` 内部就是用闭包捕获 parser / 提示语 / 错误提示，吐出签名一致的「带句柄版」和「纯内容版」两个方法。想加一种 `_download_yaml`？再调一次工厂即可，对称、省心。这就是「基类吸收脏活」走到极致的样子——连「生成工具方法」这件事本身都被工具化了。

## 公共入口 `extract()`：初始化、打标记、换 IP 重试

前面讲的 `*_download_*` 和 `_real_extract`，都不是子类作者直接被调用的地方。编排器真正调的是基类的公共入口 `extract(url)`。它像一道门，把「初始化 → 真提取 → 收尾」串起来：

```
编排器选中提取器 → extract(url)
   ├─ initialize()        # 预热伪造来源 IP / 按需登录 / 子类初始化钩子
   ├─ _real_extract(url)  # 子类契约：真正抠数据，返回字典
   ├─ 给字典打内部标记（如 __x_forwarded_for_ip）
   └─ 交还编排器
```

这里有两处值得说。

**一是「打内部标记」。** 提取阶段伪造的那个来源 IP，会被以 `__x_forwarded_for_ip`（双下划线前缀，表示「内部用」）的名义直接塞进结果字典。为什么？因为后面下载分片时还得用同一个来源 IP，否则提取和下载来源不一致可能触发风控。这就是「胖字典」顺手把跨阶段状态也捎带过去的一个活样本——好处是省了另一套传参机制，代价后面权衡里讲。

**二是「换 IP 重试」。** 很多站点按 IP 做地区封锁。yt-dlp 的绕法分两步：初始化时先按国家随机「预热」一个伪造 IP；运行时如果 `_real_extract` 抛出 `GeoRestrictedError`（这种错误会带回「这个视频在哪些国家可看」），入口就按错误里的国家列表随机换一个假 IP，再来一次。整个重试就嵌在入口里一个最多两轮的循环：

```python
def extract(self, url):
    for _ in range(2):                       # 最多换 IP 重试 2 次
        try:
            self.initialize()
            ie_result = self._real_extract(url)
            ...
            return ie_result
        except GeoRestrictedError as e:
            if self.__maybe_fake_ip_and_retry(e.countries):
                continue                     # 换个伪造 IP，重新提取
            raise
```

伪造 IP 是怎么生效的？就在前面那个唯一网络出口里：只要 `self._x_forwarded_for_ip` 有值，出口就会把它写进请求的 `X-Forwarded-For` 头。许多 CDN 信任这个头来判断客户端来源，于是伪造的 IP 就骗过了它们。这招简单，但有效——前提是站点信这个头。

## 最小原理演示（TS）

把上面三件事——**胖字典当数据总线、`_type` 判别做多态分派、换 IP 重试**——用一个能跑的最小骨架演透。下面这份 `demo.ts` 不依赖任何外部包，用 `npx tsx demo.ts` 或 `bun demo.ts` 即可运行（能跑最好，跑不通也不影响读原理）。

```ts
// ============ 1. 胖字典：全系统唯一的数据格式 ============
type Format = { url: string; height?: number }
type InfoDict = Record<string, any> & {
  id: string
  title: string
  formats?: Format[]
  url?: string
  _type?: 'video' | 'playlist' | 'url' | 'url_transparent'
}

// 工厂方法：把「带判别字段的对象」做成惯用构造
const urlResult = (url: string, transparent = false): InfoDict =>
  ({ _type: transparent ? 'url_transparent' : 'url', url })
const playlistResult = (entries: InfoDict[]): InfoDict =>
  ({ _type: 'playlist', entries })

// ============ 2. 提取器基类：把脏活吸收掉 ============
class GeoRestrictedError extends Error {
  constructor(public countries: string[]) { super('geo restricted') }
}

abstract class InfoExtractor {
  protected fakeIp: string | null = null

  // 唯一的网络出口：所有联网最终汇聚到这里，复用编排器的传输门面（第 1 章已讲透）
  protected requestWebpage(url: string): string {
    const headers: Record<string, string> = {}
    if (this.fakeIp) headers['X-Forwarded-For'] = this.fakeIp   // 把伪造 IP 写进请求头
    return transportFacade(url, headers)                         // 假托编排器的 urlopen
  }

  // 样板工具一：下载网页（编码/重试等脏活被吸收，此处简化）
  protected downloadWebpage(url: string) { return this.requestWebpage(url) }

  // 样板工具二：正则抠第一个非空捕获组
  protected searchRegex(patterns: RegExp[], html: string, name: string): string {
    for (const re of patterns) {
      const m = html.match(re)
      if (m) return (m[1] ?? m[0]).trim()
    }
    throw new Error(`Unable to extract ${name}`)
  }

  // 子类契约：基类默认抛 NotImplementedError，必须覆写
  protected abstract realExtract(url: string): InfoDict

  // 公共入口：初始化 → 真提取 → 打内部标记 → 换 IP 重试
  extract(url: string): InfoDict | null {
    for (let attempt = 0; attempt < 2; attempt++) {            // 最多换 IP 重试 2 次
      try {
        this.initialize()
        const result = this.realExtract(url)
        if (result === null) return null
        if (this.fakeIp) result['__x_forwarded_for_ip'] = this.fakeIp  // 内部键混进同一字典
        return result
      } catch (e) {
        if (e instanceof GeoRestrictedError && this.maybeFakeIpAndRetry(e.countries)) {
          console.log(`  → 抛了地区限制，换假 IP ${this.fakeIp} 重试`)
          continue                                               // 换个伪造 IP，再来一次
        }
        throw e
      }
    }
    throw new Error('extraction failed')
  }

  protected initialize() { /* 预热假 IP / 登录钩子… */ }

  private maybeFakeIpAndRetry(countries: string[]): boolean {
    if (!countries.length || this.fakeIp) return false
    const cc = countries[Math.floor(Math.random() * countries.length)]
    this.fakeIp = randomIpv4(cc)                                 // 按国家随机生成假 IP
    return !!this.fakeIp
  }
}

// ============ 3. 一个具体站点提取器：只写「怎么抠」这几十行 ============
class ExampleIE extends InfoExtractor {
  protected realExtract(url: string): InfoDict {
    const html = this.downloadWebpage(url)                       // 样板：下网页
    const title = this.searchRegex(
      [/<meta property="og:title" content="([^"]+)">/], html, 'title')   // 样板：开放图谱
    const videoId = this.searchRegex([/\/watch\/(\w+)/], url, 'id')
    return {
      id: videoId, title,
      // 没有 _type 字段 → 默认当作 'video'
      formats: [{ url: `https://cdn.example/${videoId}.mp4`, height: 720 }],
    }
  }
}

// ============ 4. 编排器：按 _type 判别字段分派 ============
function processIeResult(result: InfoDict): string {
  switch (result._type ?? 'video') {
    case 'video':          return `选格式并下载（共 ${result.formats?.length} 个格式）`
    case 'playlist':       return `展开播放列表，对 ${result.entries?.length} 条逐个递归`
    case 'url':
    case 'url_transparent': return `转发给别的提取器再提：${result.url}`
  }
}

// ============ 假托的网络层 + 跑一遍执行轨迹 ============
function transportFacade(url: string, headers: Record<string, string>): string {
  // 模拟：不带伪造 IP 时，被地区封锁的 URL 会抛 GeoRestrictedError，并带回「哪些国家可看」
  if (url.includes('/restricted') && !headers['X-Forwarded-For']) {
    throw new GeoRestrictedError(['US', 'JP'])
  }
  return `<meta property="og:title" content="一个被地区封锁的视频">`
}
function randomIpv4(cc: string) { return `203.0.113.${Math.floor(Math.random() * 255)}` }

// 轨迹：第 1 次被封锁 → 换假 IP → 第 2 次成功
const dict = new ExampleIE().extract('https://example.com/watch/abc/restricted')
console.log('结果字典:', dict)
console.log('编排器分派:', processIeResult(dict))
```

跑出来大致是这样——注意那个内部键 `__x_forwarded_for_ip` 是第二次重试成功后才混进字典的：

```
  → 抛了地区限制，换假 IP 203.0.113.87 重试
结果字典: { id: 'abc', title: '一个被地区封锁的视频',
           formats: [ { url: 'https://cdn.example/abc.mp4', height: 720 } ],
           '__x_forwarded_for_ip': '203.0.113.87' }
编排器分派: 选格式并下载（共 1 个格式）
```

把 `urlResult(...)` 或 `playlistResult([...])` 丢给 `processIeResult`，你就能看到 switch 走到「转发」或「展开播放列表」那条分支——一个对象、一个判别字段，就这么表达了多种结果。

## 关键权衡

这一章的几个设计选择都很有「以退为进」的味道，逐条拆开。

### 权衡一：让全系统共用一个无固定 schema 的胖字典

- **选了什么**：所有阶段共用一个字段极丰富、没有独立 schema 文件的普通字典当数据总线。
- **换来什么**：各阶段再也不必各自定义数据结构，全对着同一个字典做纯变换——提取器填字段、编排器读 `formats` 选格式、下载器读 `protocol` 选策略、后处理器读写元数据；想加一段新流程，只要约定几个新键，连一行类型定义都不用动。
- **代价是什么**：schema 只靠基类的类文档字符串（注释）约定，没有任何编译期保证。字段语义还会随阶段漂移——文件路径、网页 URL 这些是下游阶段才「后注入」的；连提取阶段伪造的那个 IP，都作为带双下划线前缀的内部键 `__x_forwarded_for_ip` 混进了同一字典。结果就是：拼错一个字段名，编译器不会提醒你，运行时才会以「读到 undefined」的方式暴露；类型正确性全靠作者自律。

### 权衡二：用一个判别字段 `_type` 做结果多态分派

- **选了什么**：用一个字符串字段标记结果种类（video / playlist / url / url_transparent），而不是为每种结果建一套面向对象继承体系。
- **换来什么**：提取器对外永远只返回一种东西——一个字典；编排器用一串 `switch` 分派就够；`url_result` / `playlist_result` 两个工厂把「带标记的对象」做成现成构造。
- **代价是什么**：分派逻辑因此散落在编排器里，将来新增一种结果类型，得去改多处 switch 才行。更微妙的是，`url` 和 `url_transparent` 这两个值——「普通转发」和「透明转发（我带的元数据更准）」——字典结构完全相同，它们的语义差别全靠注释和约定维系，没有任何结构上的强制。

### 权衡三：用元编程批量生成下载类样板方法

- **选了什么**：在一个工厂函数 `__create_download_methods` 里，靠换 parser 名字批量生成「下载 XML/JSON/网页/socket 各一对（带句柄 / 不带句柄）」方法。
- **换来什么**：「换解析器即换下载方法」的对称扩展，子类拿到的工具方法签名高度一致；想加一种新的下载方法，再调一次工厂即可，几乎零成本。
- **代价是什么**：基类因此膨胀成一个四千余行的「上帝基类」，样板代码和业务逻辑的边界变得模糊；新来的维护者要在基类里大海捞针，才能找到自己真正需要的那几个工具方法；而且这些方法是动态生成的，IDE 的跳转和自动补全对它们并不友好。

### 权衡四：伪造 X-Forwarded-For 假 IP + 错误驱动换 IP 重试

- **选了什么**：在唯一网络出口把伪造 IP 写进 `X-Forwarded-For` 头，并在入口方法里捕获 `GeoRestrictedError` 后，按错误带回的国家列表换 IP 重试（最多两轮）。
- **换来什么**：无需代理或 VPN，就能绕过大量基于 IP 的地区封锁（许多 CDN 信任这个头）；同时把「跨阶段复用同一来源 IP」的需求，顺手用字典里的内部键捎带给了下载阶段，省了一套专门的状态传递机制。
- **代价是什么**：从根本上不可靠——站点完全可以不信任这个头，甚至反过来识别出它是伪造的；而且这套重试只是嵌在入口方法里的一个简单循环，并不是什么通用的重试框架；那个混进结果字典的伪造 IP，也正是「胖字典语义随阶段漂移」最鲜活的样本。

## 小结与下一站

这一章讲清了一件事：**让整个系统说同一种语言（一个胖字典在各阶段流动），再用一个厚基类把抓取脏活吸收掉、把「解析一个站点」压缩成子类的 `_real_extract` 几十行。** 它的两块基石——胖字典数据总线、`_type` 判别字段做多态分派——是为了让上游（提取器）和下游（编排器 / 下载器 / 后处理器）能在没有强类型契约的前提下顺畅协作；而基类工具箱、元编程工厂、假 IP 重试，则是把「解析网页」这件脏活工程化的具体手段。

不过，光有这套骨架还应付不了一种更狡猾的站点：它在返回真实视频地址之前，会先下发一段经过混淆的签名 / `n` 参数 JavaScript，要求你**当场执行这段 JS** 才算出最终地址。在进程里凭空执行一段来历不明、还故意和你对着干的脚本，是一件很不一样的事——这正是紧邻的下一章《进程内手写 JS 解释器：本地执行对抗性脚本》要解决的问题：不从外部拉 V8，而是在进程内手写一个 JavaScript 解释器，把对抗性脚本当数据本地跑起来。
# info_dict 数据总线与提取器骨架

> 本章属于 composite 层。前置：可插拔传输层、约定胜配置的插件注册机制。
> 学完你能：用一句话讲清「为什么用一个胖字典当数据总线 + 一个胖基类吸收所有脏活，就能把『解析一千个视频站点』压成每个站点几十行业务代码」，以及这套设计付了什么代价。

## 1. 为什么需要它

上一章把「请求发得像浏览器」这件事办成了——浏览器指纹伪装挂在传输处理器上，能让目标站点放行。但「下载一个站点的视频」要做的事远不止发对一个请求。

想象一下接入一个全新视频站点你会做什么：下载页面 HTML、猜页面编码、用正则抠标题、抠上传者、解析 OpenGraph、解析 JSON-LD、抠出媒体接口 URL、拉接口拿格式清单、处理地区封锁、去重格式……再换一个站点，同样的脏活再来一遍。yt-dlp 适配了上千个站点——如果没有统一基座，那就是一千份各自漂移的样板代码，每个站点吐出来的数据形状都不一样，下游选格式、下载、写元数据的代码完全没法复用。

要解决两件事：

一是**整个流水线被切成「提取 → 选格式 → 下载 → 后处理」若干阶段**，由完全不同的模块负责。要让它们协作，得有一个统一的数据载体让所有阶段都认。

二是**「解析一个网页」有大量跨站点重复的机械动作**。下载网页、抠正则、解析开放图谱、解析清单——每个站点都要做，只是细节略有不同。如果把这些动作收进一个基类当样板工具箱，子类就只需要写「这一个站点到底怎么抠」，整个站点的适配就被压成几十行业务代码。

> 上一章留下了「请求怎么发得像浏览器」的口子；本章接着的是「请求拿到响应之后，怎么把响应变成下游能消化的统一数据」。本章也不重讲「提取器是怎么按 URL 被发现并选中的」——那是第 2 章插件注册机制的话题，本章只看被选中之后、提取器骨架如何履约产出字典。

## 2. 核心思想

**让全系统只说一种语言——一个字段极丰富的「胖字典」在各阶段间流动；再用一个胖基类把所有重复的抓取脏活吸收掉，子类只写「这一个站点到底怎么抠」**。

两件事拧成一根总线：字典是**数据形状**的统一，基类是**抓取动作**的统一。少了任一个，上游一千个站点要么吐一千种形状，要么用一千套互不一致的工具。

## 3. 心智模型

### 3.1 字典：贯穿全程的数据总线

提取器返回的不是某个 `Video` 类的实例，就是一个普通字典。基类的类文档（一段几百行的注释字符串）规定了它该长什么样：

- **必填三件套**：`id`（视频在该站点的唯一标识）、`title`（标题）、`formats`（一个格式子字典的列表）或 `url`（直链）之一；
- **`_type` 判别字段**：缺省即视为 `"video"`，其它取值另有语义（见 §4.2）；
- **可选元数据**：上传者、时长、上传时间、缩略图、章节、字幕……几十个字段都可选；
- **格式子字典**：每个 format 自身又是一个字典（`url` / `ext` / `height` / `vcodec` / `tbr`…）；
- **随阶段后注入**：文件路径、最终下载到的位置、网页来源 URL 等，这些字段在提取阶段根本不存在，是下游下载器、后处理器**写回**字典里的。

提取器填一些字段、编排器读 `formats` 选格式、下载器读 `protocol` 选策略、后处理器读写元数据——每个阶段都对同一字典做「读一些字段、写一些字段」的纯变换。

### 3.2 基类：吸收样板工具箱

`InfoExtractor` 是所有提取器的父类。子类只需实现一个方法 `_real_extract(self, url)`，基类把剩下的脏活全包了：

| 样板工具 | 干什么 |
|---|---|
| `_download_webpage(url)` | 下载网页、自动猜编码、检测被封锁页 |
| `_download_json` / `_download_xml` / `_download_socket_json` | 下载并解析 |
| `_search_regex(pattern, html, name)` | 抽出第一个匹配组 |
| `_og_search_title` / `_og_search_description` | 开放图谱查找族 |
| `_json_ld(html)` | 结构化数据解析 |
| `_extract_m3u8_formats` / `_parse_smil_formats` | 清单位解析 |

子类拿这些工具，几十行就能抠完一个站点。

### 3.3 入口流程：基类的 `extract`

子类**不直接**被外部调 `_real_extract`——基类对外暴露一个 `extract`，把 `_real_extract` 包了一层：

```
extract(url)
  → 初始化（预热假 IP、按需登录、子类初始化钩子）
  → 调子类的 _real_extract(url)
  → 给返回的字典打上内部标记（如 __x_forwarded_for_ip）
  → 若中途抛地区限制错误 → 换假 IP 重试（最多两次）
  → 交还编排器
```

`_real_extract` 是契约——基类默认 `raise NotImplementedError`，子类不实现就跑不起来。

## 4. 关键权衡

### 4.1 胖字典当万能数据总线，换各阶段纯变换

**选择**：把视频、格式、播放列表、转发结果**全部**塞进一个普通字典，而不是为每个阶段定义专门的 `Video` / `Format` / `Playlist` 数据类。

**换来**：各阶段无需定义各自的数据结构——提取器填字段、编排器读 `formats`、下载器读 `protocol`、后处理器读写元数据，每个阶段都是对同一字典的纯变换。新阶段加入只需声明「读哪几个字段、写哪几个字段」，无需在数据模型上加分支。

**代价**：schema 仅靠类文档约定、**没有任何编译期保证**。字段语义还会随阶段漂移——`filepath` 在提取阶段不存在，是下载器后注入的；连内部用的「伪造 IP」也作为带双下划线前缀的键 `__x_forwarded_for_ip` 混进同一字典。拼错字段名、漏填必填字段，运行期才会暴露，类型正确性全靠作者自律。

**讲透本质矛盾**：这是「**强类型带来的可维护性**」与「**跨阶段协作的廉价性**」的对立。强类型数据类能让 IDE 帮你查错，但每加一个阶段、每加一个字段都要改类型定义，跨团队协作成本高；胖字典反过来——只要约定好字段名，任何阶段都能随便读写，但错误前移不了。yt-dlp 选后者，因为它有上千个站点提取器、十几个下游阶段，**让一千个贡献者低成本协作**比让一个人享受类型安全更重要。

### 4.2 用 `_type` 字符串字段做结果多态分派

**选择**：返回类型始终是字典，但用一个字符串字段 `_type` 标记这是哪一种结果（`video` 默认 / `playlist` / `url` 转发 / `url_transparent` 透明转发……），编排器用一串条件分支按 `_type` 分派，**不**为每种结果建一套面向对象继承体系。

**换来**：一个返回类型就能表达「这是单个视频 / 这是播放列表要展开 / 这是转发给另一个提取器」，编排器读 `_type` 走 switch 即可。子类产结果时调基类的工厂方法 `url_result(...)` / `playlist_result(...)` 就能产对应形状的字典，约定俗成。

**代价**：分派逻辑散落在编排器里、新增一种结果类型要在编排器和工厂函数里都改。更微妙的是 `url` 与 `url_transparent` 字典结构完全相同，**语义差别只在文档约定**——后者声明「我带的额外元数据比目标 URL 处更精确，请保留我填的」。这种语义差别没有类型系统兜底，全靠注释维系。

**讲透本质矛盾**：这是「**多态分派机制的表达力**」与「**类型 vs. 约定的成本**」的对立。用面向对象继承表达多态最严谨，但要把「转发」这种横切行为塞进继承树里要扭曲很多类；用 `_type` 字段加 switch 反过来——分派机制廉价可扩展，但语义靠约定维系。这套设计的通解骨架是：**当协作方很多、类型分支很碎、且每条分支语义都很轻时，用一个判别字段 + 一段 switch 比建继承树便宜得多**——代价是分支正确性靠测试和文档而非类型系统兜底。

### 4.3 元编程批量生成下载样板方法

**选择**：基类体内用一个工厂函数 `__create_download_methods(name, parser, ...)`，在类创建期同时生成「带响应句柄版」和「纯内容版」两个方法——仅靠换 `parser` 名字就得到 `_download_xml` / `_download_json` / `_download_socket_json` / `_download_webpage` 等成对方法。

**换来**：「换解析器即换下载方法」的对称扩展——子类拿到的工具方法签名高度一致（`_download_json(url)` 与 `_download_xml(url)` 用法完全相同），学一套就会全部。

**代价**：基类膨胀成四千余行的「上帝基类」，样板与业务边界模糊。新人要在基类里大海捞针才能找到自己需要的工具方法——类内还有 `_download_webpage` 公共版（带重试循环）与内部 `__download_webpage` 工厂版（单次）两个**名字几乎一样、行为略有差别**的方法，进一步加重阅读负担。

**讲透本质矛盾**：这是「**API 一致性带来的学习低成本**」与「**实现膨胀带来的导航高成本**」的对立。每个 `_download_X` 用法一致是好事；但用元编程把样板塞进基类，使得「我该调哪个方法」、「这个方法从哪来」都要去基类源码里考古。一致的 API 表面之下，藏着一团难追踪的实现。这类设计的通解骨架是：**用对称的命名 + 工厂批量生成换 API 学习成本归一**——代价是新人面对的是「会用的工具多到找不到」而不是「工具不够用」。

### 4.4 假 IP + 错误驱动重试，换无需代理绕过地区封锁

**选择**：初始化时预热一个伪造的「来源 IP」（按国家 / IP 段随机生成），通过 `X-Forwarded-For` HTTP 头随请求发出；运行期捕获 `GeoRestrictedError` 后，从错误带回的国家列表里随机换一个假 IP 再重试，最多两次。

**换来**：无需代理或 VPN 即可绕过大量基于 IP 的地区封锁——因为许多 CDN 信任 `X-Forwarded-For` 头，把它当成真实来源 IP。

**代价**：**不可靠**——站点完全可以不信任该头，那就一点用都没有。而且这套机制只是嵌在入口方法里的简单 `for` 循环，不是通用重试框架，遇到非地区限制的错误不会重试。

**讲透本质矛盾**：这是「**约束的可绕过性**」与「**约束的执行严格性**」的对立。地区封锁本质是 CDN 信任请求头里的来源 IP 信息，而这个信任本身是可绕过的——只要发出可信的请求头就能伪装来源。yt-dlp 押注「大部分 CDN 会信任该头」，用一个低成本的「撒一个谎、不行再撒一个谎」循环换绕过能力，**明知不可靠也要做**，因为对用户来说「有时能绕过」远好于「完全不能绕过」。这条权衡的通解骨架是：**当对方约束靠某种可伪造信号、且伪造成本极低时，先伪造信号再失败重试，比要求用户准备真实资源（代理 / VPN）便宜得多**——代价是该机制永远只能「尽力而为」。

## 5. 最小原理演示

下面这几十行演透三件事：基类**契约 + 吸收样板**（`_download_webpage` / `_search_regex` / `_og_search_title`）、**`_type` 字段多态分派**（编排器 switch）、**假 IP 重试循环**（捕获错误换 IP 再来）。每一行都对应上面某条原理。

```typescript
// === 数据总线：一个普通对象，所有阶段都对它做读 / 写 ===
type InfoDict = {
  id: string
  title: string
  formats?: Array<{ url: string; height?: number }>
  url?: string                 // 直链（与 formats 二选一）
  _type?: 'video' | 'playlist' | 'url' | 'url_transparent'  // 多态判别字段
  entries?: InfoDict[]         // playlist 用
  __fake_ip__?: string         // 内部键混进同一字典，下游可复用同来源 IP
  [k: string]: unknown         // 字段语义随阶段漂移、无编译期保证
}

// === 地区限制错误，带回「可换到哪些国家」 ===
class GeoRestrictedError extends Error {
  constructor(public countries: string[]) { super('geo restricted') }
}

function randomIp(): string {
  return Array.from({ length: 4 }, () => Math.floor(Math.random() * 256)).join('.')
}

// === 胖基类：吸收样板工具箱 ===
abstract class InfoExtractor {
  protected _fakeIp?: string   // 预热的假 IP，子类也能读

  // 网络出口——背后是前置章讲过的中立传输门面，这里只 mock
  protected async _download_webpage(url: string): Promise<string> {
    console.log(`  → GET ${url}  (X-Forwarded-For: ${this._fakeIp ?? '-'})`)
    return `<html><meta property="og:title" content="hello world" data-video="api.example.com/stream"></html>`
  }

  // 抽第一个匹配组——所有子类都用同一套正则工具
  protected _search_regex(pattern: RegExp, text: string, name: string): string {
    const m = text.match(pattern)
    if (!m) throw new Error(`regex miss: ${name}`)
    return m[1]
  }

  // 开放图谱查找——基类提供，子类一行调用
  protected _og_search_title(html: string): string {
    return this._search_regex(/property="og:title" content="([^"]+)"/, html, 'og:title')
  }

  // 工厂方法：惯用的「转发到别的提取器」形状
  protected url_result(url: string, transparent = false): InfoDict {
    return { url, _type: transparent ? 'url_transparent' : 'url' }
  }

  // 工厂方法：惯用的「播放列表」形状
  protected playlist_result(entries: InfoDict[]): InfoDict {
    return { id: 'playlist', title: 'a playlist', _type: 'playlist', entries }
  }

  // 子类契约：必须实现「这一个站点到底怎么抠」
  protected abstract _real_extract(url: string): Promise<InfoDict>

  // 公共入口：包了初始化、内部标记、地区重试
  async extract(url: string): Promise<InfoDict | null> {
    for (let attempt = 0; attempt < 2; attempt++) {   // 最多换 IP 重试 2 次
      try {
        this._fakeIp = randomIp()                      // 预热假 IP
        const result = await this._real_extract(url)
        if (!result) return null
        result.__fake_ip__ = this._fakeIp              // 内部键混进同一字典
        return result
      } catch (e) {
        if (e instanceof GeoRestrictedError && attempt === 0) {
          console.log(`  ⚠ geo restricted, countries=${e.countries}; 换 IP 重试`)
          continue                                      // 错误驱动换 IP
        }
        throw e
      }
    }
    return null
  }
}

// === 子类：只写「这个站点怎么抠」——几十行 ===
class ExampleIE extends InfoExtractor {
  async _real_extract(url: string): Promise<InfoDict> {
    const html = await this._download_webpage(url)
    const title = this._og_search_title(html)
    const mediaUrl = this._search_regex(/data-video="([^"]+)"/, html, 'media url')

    // 极小概率模拟：第一次访问触发地区限制
    if (this._fakeIp?.startsWith('9.')) throw new GeoRestrictedError(['US', 'JP'])

    return {
      id: 'demo-001',
      title,
      formats: [{ url: mediaUrl, height: 720 }],
      // 不设 _type → 默认 video
    }
  }
}

// === 编排器：用 _type 字段 switch 分派 ===
async function orchestrate(url: string) {
  const ie = new ExampleIE()
  const info = await ie.extract(url)
  if (!info) return
  switch (info._type ?? 'video') {                    // 字段做判别符
    case 'video':
    case undefined:
      console.log(`选格式 → 下载：${info.formats?.length ?? 0} 个格式`); break
    case 'playlist':
      console.log(`展开播放列表：${info.entries?.length ?? 0} 条`); break
    case 'url':
    case 'url_transparent':
      console.log(`转发到另一个提取器：${info.url}`); break
  }
}

orchestrate('https://example.com/watch?v=001')
// 一种可能的输出：
//   → GET https://example.com/watch?v=001  (X-Forwarded-For: 9.42.17.230)
//   ⚠ geo restricted, countries=US,JP; 换 IP 重试
//   → GET https://example.com/watch?v=001  (X-Forwarded-For: 142.93.7.18)
//   选格式 → 下载：1 个格式
```

每一段都对应上面某条原理：基类吸收样板（`_download_webpage` / `_search_regex` / `_og_search_title`）、胖字典当总线（`InfoDict` 的 `[k: string]: unknown` 与 `__fake_ip__` 内部键）、`_type` 字段多态分派（编排器 switch）、错误驱动换 IP 重试（`extract` 的 `for` 循环）。

## 6. 执行轨迹

输入：视频页 URL `https://example.com/watch?v=001`，编排器选中了 `ExampleIE`。

1. 编排器调 `ie.extract(url)`；
2. 第 1 次循环（`attempt=0`）：预热假 IP `9.42.17.230`，调 `_real_extract(url)`；
3. `_real_extract` 调 `_download_webpage(url)` → 拉到页面 HTML（请求里带 `X-Forwarded-For: 9.42.17.230`）；
4. `_og_search_title` 抽到标题 `"hello world"`；`_search_regex` 抽到 `data-video="api.example.com/stream"`；
5. 这次假 IP 以 `9.` 开头，模拟触发地区限制 → 抛 `GeoRestrictedError(['US', 'JP'])`；
6. `extract` 的 catch 命中且 `attempt === 0` → `continue` 进入第 2 次循环；
7. 第 2 次循环（`attempt=1`）：换假 IP `142.93.7.18`，重跑 `_real_extract` → 这次没触发 → 返回字典；
8. `extract` 给字典打上 `__fake_ip__: '142.93.7.18'`，交还编排器；
9. 编排器读 `_type`——缺省即 `"video"`，走 video 分支：读 `formats` 进入选格式阶段。

**字典在阶段间流动的样子**：提取器产 `{id, title, formats, __fake_ip__}` → 编排器读 `formats` 选出一个 → 下载器读选中格式的 `protocol` 字段决定用哪个 FileDownloader（后续章节展开）→ 下载器把 `filepath` 后注入回字典 → 后处理器读 `filepath` 与 `title` 跑加工管线。字典的形状从提取到结束一直在长新字段——这就是「胖字典当万能数据总线」的样子。

## 7. 教学简化说明

上面的演示**故意省略**了：完整的编码猜测与被封锁页面检测；OpenGraph / JSON-LD / Next.js flight data / Nuxt devalue 等站点专属解析；HLS / F4M / SMIL / MPD 等清单位解析；登录与 netrc、cookie 注入；插件覆盖提取器的 `__init_subclass__` 钩子全貌；格式排序与字幕合并等所有工程完整性与站点适配细节。这些在真实基类里占了三千多行，但都不是「为什么这么设计」的支点。

## 8. 小结

字典是数据形状的统一、基类是抓取动作的统一——两者拧成一根总线，让一千个站点提取器只用写各几十行的业务代码就能协作。代价是字段语义靠文档维系、随阶段漂移、类型错误只能运行期暴露。

字段里那个 `formats` 子字典被下载器读出来后，怎么选、怎么下？另外，不少站点的真实视频 URL 是被一段 JavaScript 加密签名混淆过的——下一章就讲为什么 yt-dlp 不调用 V8、而是在进程内手写一个 JS 解释器来本地执行这些对抗性脚本。

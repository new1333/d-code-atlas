# info_dict 数据总线与提取器骨架 · 源码精读

## 给 Writer 的教学钩子（必填，8 子项缺一不可）

- **用户痛点 / 场景**：每接入一个新视频站点，开发者最怕的不是"站点有多复杂"，而是每次都要重写一遍同样的脏活——下载网页、猜编码、正则抠标题、解析开放图谱、处理地区封锁、解析 HLS 清单、去重格式……如果没有统一基座，一千个站点就有一千份各自漂移的样板代码，且每个站点吐出来的数据形状都不一样，下游根本没法统一处理。

- **一句话核心思想**：**让全系统只说一种语言——一个字段极丰富的"胖字典"在各阶段间流动，再用一个胖基类把所有重复的抓取脏活吸收掉，子类只写"这一个站点到底怎么抠"**。

- **设计动机（为什么需要它）**：整个下载流水线被切成"提取→选格式→下载→后处理"等若干阶段，这些阶段由完全不同的模块负责。要让它们能协作，必须有一个统一的数据载体——于是用一个字典当万能数据总线，每个阶段都对它做"读一些字段、写一些字段"的纯变换。又因为"解析一个网页"有大量跨站点重复的机械动作，于是把这些动作收进提取器基类当样板工具箱，把"解析一个站点"压缩成几十行业务代码。
  - **承前（跨章去重信号）**：本章不是从零造网络层——提取器基类里那个唯一的"发请求"出口，直接复用了第 1 章『可插拔传输层』建立的中立请求对象 + 编排器门面（**已在第 1 章讲透，本章只看提取器如何作为一个"消费者"调用那个门面，不重讲请求中立与多后端竞争**）；本章也不讲"提取器怎么被发现/选中"——按 URL 正则匹配 + 类名后缀约定的发现机制属于第 2 章『约定胜配置的插件注册机制』（**已在第 2 章讲透，本章只看被选中之后、提取器骨架如何履约产出字典**）。

- **关键权衡（本 Atlas 的核心）**：
  1. **选"一个胖字典当万能数据总线"** → 换来各阶段无需定义各自的数据结构、全部对同一字典做纯变换（提取器填字段、编排器读 `formats` 选格式、下载器读 `protocol` 选策略、后处理器读写元数据）→ **代价是 schema 仅靠类文档约定、无编译期保证**：字段语义随阶段漂移（文件路径、网页 URL 等是下游后注入的），连内部用的"伪造 IP"也作为带双下划线前缀的键混进同一字典，类型正确性全靠作者自律。
  2. **选"用一个字符串类型标记字段做结果多态分派"**（默认视频，另有播放列表、转发到别的提取器等值）→ 换来"一个返回类型（字典）就能表达视频/播放列表/转发等多种结果"，编排器用一串条件分支分派即可，无需为每种结果建一套面向对象继承体系 → **代价是分派逻辑散落在编排器里、新增一种结果类型要改多处**，且"是普通转发还是透明转发"这种语义差别全靠注释和约定维系。
  3. **选"用元编程在一个工厂函数里批量生成下载类样板方法"**（下载 XML/JSON/网页/socket 各一对"带句柄/不带句柄"方法）→ 换来"换解析器即换下载方法"的对称扩展、子类拿到的工具方法高度一致 → **代价是基类膨胀成四千余行的"上帝基类"**，样板与业务边界模糊，新人要在基类里大海捞针才能找到自己需要的工具方法。
  4. **选"伪造 X-Forwarded-For 假 IP + 捕获地区限制错误后换 IP 重试"** → 换来无需代理/VPN 即可绕过大量基于 IP 的地区封锁（许多 CDN 信任该请求头）→ **代价是不可靠**（站点完全可以不信该头）、且重试只是嵌在入口方法里最多两次的简单循环，并非通用重试框架。

- **最小心智模型（3～7 步）**：
  1. 编排器按 URL 选中一个提取器实例，调用它的公共入口方法。
  2. 入口方法先做初始化：预热一个伪造的"来源 IP"、按需登录、调子类的初始化钩子。
  3. 入口方法调用子类必须实现的"真正提取"方法，把 URL 交给他。
  4. 子类内部用基类提供的样板（下载网页、正则抽取、开放图谱查找、JSON-LD 解析、HLS 清单解析等）从页面/接口抠数据，组装成一个字典。
  5. 字典里至少填上标识与标题，并给出"格式列表"或"直链"之一；若结果不是单个视频，用类型标记字段标明（播放列表/转发等）。
  6. 入口方法给返回的字典打上若干内部标记后交还编排器；若中途抛出地区限制错误，就换一个伪造 IP 再提取一次（最多两次）。
  7. 编排器拿到字典后，按类型标记分派，并对同一字典继续做选格式、下载、后处理等纯变换。

- **最小原理演示（替代旧"复刻范围"）**：
  - **应演示**：一个从零的小骨架（几十行），演三件事——(a) 提取器基类定义"真正提取"契约 + 吸收一两个样板方法（如"下载网页"用 mock、"正则抽取第一个匹配组"）；(b) 返回的字典靠一个类型标记字段表达"视频 vs 播放列表 vs 转发到别的提取器"，配一个最小"编排器"用 switch 按该字段分派；(c) 入口方法里那段"捕获地区限制错误→换伪造 IP→重试"的循环。每一行都要对应上面某条原理：胖字典=数据总线、类型标记=多态分派、基类样板=吸收脏活、假 IP 重试=地区绕过。
  - **应故意省略**：完整的编码猜测/被封锁页面检测、OpenGraph/JSON-LD/Next.js/Nuxt 等站点专属解析器、HLS/F4M/SMIL/MPD 等清单位解析、登录与 netrc、cookie 注入、插件覆盖钩子、格式排序、字幕合并等所有工程完整性与站点适配细节。
  - **演示载体建议**：**首选 TS/JS**。本章核心是"一个字典 + 一个判别字段 + 一个 switch 分派 + 一个重试循环 + 几个样板工具方法"，全是语言无关的数据/控制结构，TS/JS 能忠实演透，配最小 `package.json` 即可 `node`/`bun run` 跑；对读者最友好，也契合本 Atlas 的 JS 生态站点属性。无需退回原仓库语言（Python）——这里没有"必须依赖 Python 特有语义才成立"的机制（元编程那点用 JS 闭包/工厂函数同样能演）。

- **正文不宜展开的细节**：类文档里上百个字段的逐字段清单（那是查表用的，正文只挑几类代表：必填、格式子字典、可选元数据、随阶段后注入）；`__create_download_methods` 内部 `impersonate`/`load_pages`/`transform_source` 等参数的全部组合；HLS 清单里 master/media playlist 区分、音频 rendition group 的 source_preference 推导等协议适配细节；Next.js flight data / Nuxt devalue 反序列化等框架专属解析；netrc 与两步验证登录流程；插件覆盖提取器的 `__init_subclass__` 钩子全貌（点到"对接第 2 章插件机制"即可）。

- **推荐的一个执行轨迹例子**：输入一个视频页 URL → 提取器下载页面 HTML → 用开放图谱查找抠到标题、用正则抠到媒体接口 → 组装出 `{标识, 标题, 格式列表:[{url, 清晰度}]}`（无类型标记字段=默认视频）→ 交还编排器；编排器见无类型标记即按视频处理，读格式列表进入选格式阶段。若该次提取抛地区限制错误 → 入口方法换一个伪造 IP → 重新提取一次成功 → 同样得到那个字典。

> 以上钩子供 Writer 写「动机→核心思想→心智模型→关键权衡→原理演示」；下面事实部分供核对，不要被 Writer 当目录照抄。

## 概念要点

- **整个系统的统一数据格式由基类的类文档字符串定义**：必填字段、可选字段、格式子字典结构、`_type` 各取值语义、各类逻辑分组（剧集/音乐/章节）字段，全部以注释文档约定，无独立 schema 文件/无类型注解。源码位置: yt_dlp/extractor/common.py:106-580
- **单个视频结果的硬契约**：必须有 `id` 与 `title`，且必须含 `formats`（每个格式自身又是一个字典）或 `url` 之一；`_type` 缺省即视为 `"video"`。源码位置: yt_dlp/extractor/common.py:116-128
- **`_type` 字段是多态分派的判别符**：取值 `video`(默认)/`playlist`/`multi_video`/`url`/`url_transparent`；`url` 表示"转发给另一个提取器再提取"，`url_transparent` 表示"附带的元数据比目标 URL 处更精确"。源码位置: yt_dlp/extractor/common.py:495-529
- **工厂方法把"带类型标记的字典"做成惯用构造**：`url_result` 产出 `{'_type':'url'/'url_transparent','url':...}`；`playlist_result` 产出 `{'_type':'playlist'/'multi_video','entries':...}`。源码位置: yt_dlp/extractor/common.py:1276-1310
- **`extract(url)` 是公共入口，包装子类的 `_real_extract`**：负责初始化、给结果打内部标记（如 `__x_forwarded_for_ip`）、并把 `GeoRestrictedError` 转成"换 IP 重试"。源码位置: yt_dlp/extractor/common.py:757-789
- **`_real_extract` 是子类契约**：基类默认 `raise NotImplementedError`，子类必须覆写；这是"解析一个站点"被压成的唯一入口。源码位置: yt_dlp/extractor/common.py:830-832
- **`_request_webpage` 是提取器侧唯一的网络出口**：所有抓取最终汇聚到 `self._downloader.urlopen(self._create_request(...))`——即复用第 1 章的中立请求对象 + 编排器传输门面；并在出口处把伪造 IP 写进 `X-Forwarded-For` 头、把伪装目标挂进请求扩展。源码位置: yt_dlp/extractor/common.py:865-923（urlopen 调用在 907）
- **样板方法族由元编程批量生成**：`__create_download_methods(name, parser, ...)` 一个工厂函数同时产出"带句柄版"和"纯内容版"两个方法，仅靠换 `parser` 名字即得到 `_download_xml`/`_download_json`/`_download_socket_json`/`_download_webpage` 等成对方法。源码位置: yt_dlp/extractor/common.py:1093-1170
- **地区绕过 = 预热假 IP + 错误驱动换 IP 重试**：`_initialize_geo_bypass` 在初始化时按国家/IP 段随机生成假 IP（源码位置: yt_dlp/extractor/common.py:674-755）；运行期捕获 `GeoRestrictedError` 后，`__maybe_fake_ip_and_retry` 从错误带回的国家列表里随机换一个假 IP 再重试（源码位置: yt_dlp/extractor/common.py:791-804），重试上限是 `extract()` 里的 `for _ in range(2)`。
- **正则/元数据抓取样板工具箱**：`_search_regex`（首个非空捕获组/可多模式/可控致命性，源码位置: yt_dlp/extractor/common.py:1312-1345）、`_og_search_*` 开放图谱族（源码位置: yt_dlp/extractor/common.py:1458-1503）、`_html_search_regex`/`_html_search_meta`（源码位置: yt_dlp/extractor/common.py:1374-1514）、`_json_ld` 结构化数据解析（源码位置: yt_dlp/extractor/common.py:1608-1776）。
- **清单位（manifest）解析样板**：HLS `_extract_m3u8_formats_and_subtitles`（含 master/media playlist 判别、rendition group、DRM 检测，源码位置: yt_dlp/extractor/common.py:2174-2473）、F4M `_parse_f4m_formats`（源码位置: yt_dlp/extractor/common.py:2048-2148）、SMIL `_parse_smil`（源码位置: yt_dlp/extractor/common.py:2552-2589）。
- **提取器被发现选中的判据**：`suitable(url)` → `_match_valid_url(url)`，把类属性 `_VALID_URL`（正则或正则序列）编译并缓存到 `_VALID_URL_RE` 后做匹配；`_VALID_URL = False` 表示"仅嵌入型"提取器。源码位置: yt_dlp/extractor/common.py:616-632
- **类名→键的命名约定对接第 2 章插件机制**：`ie_key()`/`IE_NAME` = 类名去掉末尾 `"IE"`；`__init_subclass__(plugin_name=...)` 钩子让带插件名的子类覆盖同名内置提取器（改写 `ie_key`/`IE_NAME`、把自身注册进 `plugin_ies_overrides`），这是第 2 章插件注册在提取器侧的落点。源码位置: yt_dlp/extractor/common.py:834-841, 4106-4122
- **结果类型可由测试用例推断**：`_RETURN_TYPE` 从类的 `_TEST(S)` 是否含 `playlist` 键推断返回 video/playlist/any，供 `is_single_video` 等使用——即"文档/测试即类型"的又一体现。源码位置: yt_dlp/extractor/common.py:3822-3838

## 关键调用链

编排器（YoutubeDL）选中 IE → `ie.extract(url)` → `initialize()`（`_initialize_geo_bypass` 预热假 IP → `_initialize_pre_login` → 按需 `_perform_login` → `_real_initialize`）→ 子类 `_real_extract(url)` →〔内部调样板：`_download_webpage_handle` → `_request_webpage` → `self._downloader.urlopen(Request)` → 返回响应句柄 → `_webpage_read_content` 解码/检阻塞 → 得网页字符串；再用 `_search_regex`/`_og_search_*`/`_json_ld`/`_extract_m3u8_formats` 等抠字段〕→ 组装 info_dict 返回 → `extract()` 给结果打 `__x_forwarded_for_ip` 等内部标记 → 交还编排器。

异常支路：`_real_extract` 抛 `GeoRestrictedError` → `extract()` 的 `for _ in range(2)` 捕获 → `__maybe_fake_ip_and_retry(e.countries)` 换假 IP → `continue` 重新 `initialize()`+`_real_extract`。

源码位置: yt_dlp/extractor/common.py:757-804（入口与重试）, 865-923（网络出口）, 1093-1170（样板工厂）

## 源码摘录（带行号，全文累计 ≤ 30 行）

公共入口 + 地区重试（演"胖字典流动 + 错误驱动换 IP 重试"）：
```python
# yt_dlp/extractor/common.py:757-778
def extract(self, url):
    try:
        for _ in range(2):                       # 最多换 IP 重试 2 次
            try:
                self.initialize()
                ie_result = self._real_extract(url)
                if ie_result is None:
                    return None
                if self._x_forwarded_for_ip:
                    ie_result['__x_forwarded_for_ip'] = self._x_forwarded_for_ip  # 内部键混进同一字典
                return ie_result
            except GeoRestrictedError as e:
                if self.__maybe_fake_ip_and_retry(e.countries):
                    continue
                raise
```

类型标记字段 = 多态分派判别符（演"一个字典表达多种结果"）：
```python
# yt_dlp/extractor/common.py:1284-1310（节选两个 return）
return {**kwargs, '_type': 'url_transparent' if url_transparent else 'url', 'url': url}
...
return {**kwargs, '_type': 'multi_video' if multi_video else 'playlist', 'entries': entries}
```

元编程批量生成样板方法（演"基类吸收脏活"）：
```python
# yt_dlp/extractor/common.py:1164-1170
_download_xml_handle, _download_xml = __create_download_methods('xml', '_parse_xml', ...)
_download_json_handle, _download_json = __create_download_methods('json', '_parse_json', ...)
_download_socket_json_handle, _download_socket_json = __create_download_methods('socket_json', ...)
__download_webpage = __create_download_methods('webpage', None, None, None, ...)[1]
```

唯一的网络出口（演"复用第 1 章中立传输门面"）：
```python
# yt_dlp/extractor/common.py:907
return self._downloader.urlopen(self._create_request(url_or_request, data, headers, query, extensions))
```

## 易混淆 / 边界 / 推断

- **事实**：`url` 与 `url_transparent` 的差别只在文档约定——后者声明"我带的额外信息比目标 URL 处更精确"，编排器据此决定覆写顺序；二者字典结构相同。源码位置: yt_dlp/extractor/common.py:514-529
- **事实**：`_download_webpage`（公共、带重试）与内部 `__download_webpage`（工厂生成、单次）不是同一个方法——公共版套了一层 `IncompleteRead` 重试循环。源码位置: yt_dlp/extractor/common.py:1170-1202
- **事实**：`__create_download_methods` 是定义在类体内、但在类创建期就执行的"命名函数"（非 `@staticmethod` 装饰但实质静态），靠闭包捕获 `parser/note/errnote` 生成多个签名一致的方法。源码位置: yt_dlp/extractor/common.py:1093-1162
- **推断**：把"伪造 IP"也塞进结果字典（`__x_forwarded_for_ip`）是为了让下游（如分片下载）能复用同一来源 IP，避免提取与下载来源不一致触发风控——属于跨阶段状态在总线上的"捎带"，但这也正是"胖字典语义随阶段漂移"的活样本。
- **推断**：`_RETURN_TYPE` 从测试用例反推返回类型，说明项目刻意把"类型信息"散落在测试与文档而非类型系统里，是"约定胜配置"哲学的延伸。
- **未理解**：`__init_subclass__` 里 `setattr(sys.modules[super_class.__module__], super_class.__name__, cls)` 把模块属性直接指向子类，其完整的加载时序与第 2 章 lazy_extractors 的交互未在本文件内展开，需结合第 2 章方能讲透，本章不展开。
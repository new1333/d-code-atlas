# 可插拔传输层：请求中立与处理器竞争 · 源码精读

## 给 Writer 的教学钩子（必填，8 子项缺一不可）

- **用户痛点 / 场景**：一个视频下载工具既要发普通 HTTP、又要走 WebSocket 拉直播、还可能需要带浏览器 TLS 指纹的 curl 引擎才能过 Cloudflare。如果"发请求"和"具体引擎"写死在一起，每加一个引擎就要改一堆 if-else，而且引擎没装时直接崩溃。使用者真正想要的是：我只描述"要请求什么"，工具自己挑一个能处理它的引擎，挑不上就清楚地告诉我为什么。
- **一句话核心思想**：**先让请求对象只懂"要什么"、再让多个引擎各自亮出能力清单竞争、由一个调度器按偏好打分择优接管**——把"发什么"和"用什么发"彻底解耦。
- **设计动机（为什么需要它）**：为了让"换引擎/加引擎"成为纯增量动作（装了新引擎就自动参与竞争、没装就优雅降级到能用的），而不是改动调用方。其底层发现机制（处理器靠类名后缀自报、由统一的注册装饰器收进一张表、再用容错导入逐个尝试挂载）**是全书第 2 章『约定胜配置的插件注册机制』的核心权衡主题，本章只看它"把四个传输引擎装进调度器"这一使用侧面，不展开通用插件发现**。同时，本章确立的"扩展槽 + 偏好函数路由"两个机制，**是第 3 章『浏览器指纹伪装』直接复用的地基**（伪装目标塞进扩展槽、伪装引擎靠偏好加分胜出），本章把它们当通用机制讲透，第 3 章只看其新侧面。
- **关键权衡（本 Atlas 的核心）**：
  1. **引入"能力自检 + 不支持即跳过"的探测协议 → 换来多后端可插拔且优雅降级（curl 引擎没装就自动落到 urllib）→ 代价是每个引擎必须诚实、完整地自报它支持的 url 协议/代理协议/特性/扩展，否则要么误接（其实不支持却硬接导致运行时炸）、要么漏报（其实支持却因没声明而被永远跳过）**。
  2. **用"一组偏好函数打分求和"来决定引擎优先级 → 换来路由规则可被外部独立叠加注册、不同能力（伪装、兼容旧引擎）各自打分互不打架 → 代价是最终排序是多条偏好叠加的"和"、没有单一真相来源，调试只能靠 verbose 打印每个引擎的得分**。
  3. **把超时/cookie 容器/旧 SSL/伪装目标等"可选能力"塞进请求的扩展槽、而非请求对象的独立字段 → 换来请求核心字段稳定、新能力零侵入追加（后续章节加"伪装"不用改请求对象的签名）→ 代价是多一层"扩展认领"协商：引擎必须在自检里把自己支持的扩展逐个领走（pop 掉），凡剩下的扩展一律视为"该引擎不支持"，导致请求被跳过**。
  4. **调度器逐个自检+真发、并把"不支持的原因"和"意外崩溃"分别收集 → 换来"所有引擎都不行"时能给用户一份聚合诊断（每个引擎各自因为什么拒绝）→ 代价是每次请求至少触发一次自检开销，且引擎运行期的非预期异常会被吞掉重试下一个、可能掩盖真实 bug**。
- **最小心智模型（3～7 步）**：
  1. 调用方构造一个**中立请求对象**（只含 url、headers、代理、方法、扩展槽），它对下层用哪个引擎一无所知。
  2. 调度器取出所有已装引擎，对每个引擎套用全部已注册偏好函数、求和得到该引擎的"偏好分"，按分从高到低排序。
  3. 从最高分引擎开始逐个做**能力自检**：url 协议、代理协议、特性开关、扩展槽是否都在该引擎声明的能力范围内。
  4. 任一项不符 → 引擎抛"不支持此请求"并附原因；调度器把原因归档、跳到下一个引擎（这是降级，不是报错）。
  5. 第一个通过自检的引擎**立刻接管**、真正发出请求并返回响应；排在它后面的引擎不再尝试。
  6. 所有引擎都自检失败 → 调度器抛"无可用引擎"，聚合每个引擎的拒绝原因作为诊断信息。
  7. 引擎运行期抛出的传输类/HTTP 类异常归同一族基类、原样透传给调用方；不属于该族的异常视为引擎自身 bug，收集后继续尝试下一个引擎。
- **最小原理演示（替代旧"复刻范围"）**：
  - **应演示**：一个几十行的从零实现，演透"中立请求 + 引擎竞争 + 偏好排序 + 能力自检 + 聚合降级诊断"这条主线；**每一行都对应上面某条权衡**——中立请求对象对应权衡 3 的"扩展槽"、`supportedSchemes` 自报对应权衡 1、`_claimExtensions` 认领扩展对应权衡 3、偏好打分排序对应权衡 2、自检失败收集原因对应权衡 4。
  - **应故意省略**：完整的代理协议校验、真实 SSL/网络 IO、headers 大小写保留、深拷贝、请求/响应的 urllib 向后兼容垫片、注册表与类名后缀发现机制（那是第 2 章主题）、具体引擎实现。**不追求工程完整，只演透原理**。
  - **演示载体建议**：**首选 TS/JS**。本章核心是"数据对象 + 多策略竞争 + 排序择优"，属于纯设计模式/数据结构范畴，**没有任何 Python 特有语义依赖**（不涉及描述符/元类/GIL 等），用读者最易跑通的 TS/JS（配最小 `package.json`，`node`/`bun` 直跑）就能忠实演透；无需退回 Python。示意骨架：
    ```js
    class Unsupported extends Error {}
    // ① 中立请求：只描述"要什么"，扩展槽承载可选能力
    class Request { constructor(url, {extensions={}}={}) { this.url=url; this.scheme=url.split(':')[0]; this.extensions=extensions; } }
    // ② 引擎基类：自报能力 + 自检；未认领的扩展 = 不支持
    class Handler { schemes=new Set(); validate(req){ if(!this.schemes.has(req.scheme)) throw new Unsupported(`${this.name}: scheme ${req.scheme}`); const left=Object.keys(this._claim(req.extensions)); if(left.length) throw new Unsupported(`${this.name}: ext ${left}`);} _claim(e){return {...e};} }
    class HttpH extends Handler { constructor(){super(); this.name='Urllib'; this.schemes=new Set(['http','https','ftp']);} send(r){return `[urllib] ${r.url}`;} }
    class WsH   extends Handler { constructor(){super(); this.name='Websockets'; this.schemes=new Set(['ws','wss']);} send(r){return `[ws] ${r.url}`;} }
    // ③ 调度器：偏好打分排序 → 逐个自检 → 第一个通过的接管
    class Director { constructor(hs, prefs=[]){this.hs=hs; this.prefs=prefs;} score(h,r){return this.prefs.reduce((s,p)=>s+p(h,r),0);} send(r){ const ranked=[...this.hs].sort((a,b)=>this.score(b,r)-this.score(a,r)); const why=[]; for(const h of ranked){ try{h.validate(r);}catch(e){ if(e instanceof Unsupported){why.push(e.message);continue;} throw e; } return h.send(r);} throw new Error(`无引擎可用: ${why.join(' | ')}`); } }
    // ④ 偏好函数：外部注入路由（伪装引擎加 1000 分）——对应权衡 2
    const preferFake = (h,r)=> r.extensions.impersonate && h.name==='CurlCffi' ? 1000 : 0;
    const d=new Director([new HttpH(), new WsH()],[preferFake]);
    d.send(new Request('https://x'));   // [urllib] https://x
    d.send(new Request('wss://x'));     // [ws] wss://x
    d.send(new Request('gopher://x'));  // 抛: 无引擎可用: Urllib: scheme gopher | Websockets: scheme gopher
    ```
- **正文不宜展开的细节**：`Response` 对 `addinfourl`/`http.client.HTTPResponse` 的向后兼容垫片（`.code`/`.getcode()`/`.info()` 等已 deprecated 别名）；`Request.data` 设置时自动增删 `Content-Length`/`Content-Type` 的副作用逻辑；代理字典里 `all`/`no` 特殊键与 `Features` 枚举的细节；SSL context / client_cert 的构造；具体四个引擎（urllib/requests/websockets/curl_cffi）各自如何继承基类——这些是工程层，Writer 一句带过即可。
- **推荐的一个执行轨迹例子**：**输入** 已装 `[Urllib(支持 http/https/ftp)、Websockets(支持 ws/wss)]`，偏好函数"给支持伪装的 curl 引擎加 1000 分"（本次不命中）。**请求 A** `wss://live/x`：排序后两个引擎偏好分都为 0，先试到的 Urllib 自检发现 `wss` 不在 `(http,https,ftp)` → 抛不支持、跳过；Websockets 自检通过 → **输出** `[ws] connect wss://live/x`。**请求 B** `gopher://x`：两个引擎自检全失败 → **输出** 抛"无可用引擎：Urllib(不支持协议 gopher) | Websockets(不支持协议 gopher)"——把每个引擎的拒绝原因聚合给用户。

> 以上钩子供 Writer 写「动机→核心思想→心智模型→关键权衡→原理演示」；下面事实部分供核对，不要被 Writer 当目录照抄。

## 概念要点
- **请求对象是与传输无关的中立数据载体**：`Request` 只持有 `url/data/headers/proxies/method/extensions`，对下层引擎不可见；`url` setter 会做规范化（`//` 开头补 `http:`、过 `normalize_url`），`method` 未指定时按是否有 `data` 自动取 POST/GET。源码位置: yt_dlp/networking/common.py:385-504（Request 类）、url setter 428-434、method 436-447。
- **响应对象是 file-like 适配器**：`Response` 包装一个文件流 `fp`，暴露 `read()/status/headers/url/extensions`，`read` 出错统一包成 `TransportError`；它对旧 urllib 接口（`code/getcode/info/getheader`）提供 deprecated 别名。源码位置: yt_dlp/networking/common.py:512-601。
- **引擎基类用类变量"自报能力"**：`_SUPPORTED_URL_SCHEMES / _SUPPORTED_PROXY_SCHEMES / _SUPPORTED_FEATURES` 三个类变量声明该引擎的能力边界，置 `None` 表示关闭该项检查。源码位置: yt_dlp/networking/common.py:219-221。
- **能力探测由 `_validate` 统一把关**：依次查 url 协议、代理协议/特性、扩展；**未被引擎认领（pop）的扩展被视为不支持**。源码位置: yt_dlp/networking/common.py:340-347。
- **"不支持"是降级信号而非错误**：`UnsupportedRequest` 仅表示"这个引擎不接这个请求"，会被调度器收集后跳过；只有"所有引擎都不接"才升级为 `NoSupportingHandlers`，且其消息聚合了每个引擎的拒绝原因。源码位置: yt_dlp/networking/exceptions.py:25-50。
- **异常分层**：`RequestError` 是所有请求相关异常的族基类（带 `cause/handler`）；下分 `UnsupportedRequest`（能力不匹配）、`TransportError`（网络层，再分 `SSLError/CertificateVerifyError/ProxyError/IncompleteRead`）、`HTTPError`（HTTP 状态码错误，带 `response/redirect_loop`）。源码位置: yt_dlp/networking/exceptions.py:11-103。
- **偏好函数是可外部注入的路由规则**：`register_preference(*handlers)` 装饰器把一个 `func(handler, request) -> int` 加入全局偏好集合，且可用 `handlers` 参数限定它只对某类引擎生效（不匹配返回 0）。源码位置: yt_dlp/networking/common.py:37-48。
- **调度器按"偏好分之和"排序择优**：对每个引擎，把所有偏好函数的得分求和，作为排序键降序。源码位置: yt_dlp/networking/common.py:80-88。
- **引擎发现靠"类名 RH 后缀 + 注册装饰器 + 容错导入"**：四个具体引擎（`_urllib/_requests/_websockets/_curlcffi`）均用 `@register_rh` 自报进全局表 `_REQUEST_HANDLERS`；`__init__.py` 用 try/except 逐个导入，缺依赖（requests/websockets/curl_cffi 未装）时静默跳过、导入异常时仅 warn。源码位置: yt_dlp/networking/__init__.py:16-38、yt_dlp/networking/common.py:133-141（register_rh）、_urllib.py:353 等（`@register_rh` 用例）。
- **RH_KEY/RH_NAME 由类名派生**：类名必须以 `RH` 结尾，去掉后缀即得到 key 与显示名；这是"约定胜配置"的体现（详见第 2 章）。源码位置: yt_dlp/networking/common.py:369-376。

## 关键调用链
注册侧（启动期）：
`@register_rh(UrllibRH)` → 写入 `_REQUEST_HANDLERS['Urllib']` → `YoutubeDL._request_director`（cached_property）→ `build_request_director(_REQUEST_HANDLERS.values(), _RH_PREFERENCES)` → 实例化每个引擎 → `director.add_handler(handler)`（按 `RH_KEY` 存入 dict，同 key 覆盖）→ `director.preferences.update(_RH_PREFERENCES)`。
源码位置: yt_dlp/networking/common.py:133-141、75-78；yt_dlp/YoutubeDL.py:4348-4385。

请求侧（每次请求）：
`director.send(request)` → `_get_handlers(request)`（对所有偏好函数求和、降序排序）→ 遍历 → `handler.validate(request)`（经 `wrap_request_errors` 装饰，给异常补 `handler` 字段）→ 抛 `UnsupportedRequest` 则收集 `unsupported_errors` 并 continue / 通过则 `handler.send(request)` → 抛 `RequestError` 则透传 / 抛其它 `Exception` 则记 `unexpected_errors` 并 continue → 返回 `Response`；全失败抛 `NoSupportingHandlers(unsupported_errors, unexpected_errors)`。
源码位置: yt_dlp/networking/common.py:94-130（send）、80-88（_get_handlers）、349-359（validate/send 装饰）、_helper.py:190-199（wrap_request_errors）。

扩展协商侧：
`request.extensions` → `_validate` 拷贝一份 → `_check_extensions(extensions)`（基类只做类型断言；子类在此 pop 自己认领的扩展）→ **残留非空 → 抛 `UnsupportedRequest(f'Unsupported extensions: ...')`**。
源码位置: yt_dlp/networking/common.py:333-347。

## 源码摘录（带行号，全文累计 ≤ 30 行）
偏好打分排序（对应权衡 2）：
```python
    def _get_handlers(self, request: Request) -> list[RequestHandler]:
        """Sorts handlers by preference, given a request"""
        preferences = {
            rh: sum(pref(rh, request) for pref in self.preferences)
            for rh in self.handlers.values()
        }
        self._print_verbose('Handler preferences for this request: {}'.format(', '.join(
            f'{rh.RH_NAME}={pref}' for rh, pref in preferences.items())))
        return sorted(self.handlers.values(), key=preferences.get, reverse=True)
```
源码位置: yt_dlp/networking/common.py:80-88

能力自检 + 未认领扩展即不支持（对应权衡 1、3）：
```python
    def _validate(self, request):
        self._check_url_scheme(request)
        self._check_proxies(request.proxies or self.proxies)
        extensions = request.extensions.copy()
        self._check_extensions(extensions)
        if extensions:
            # TODO: add support for optional extensions
            raise UnsupportedRequest(f'Unsupported extensions: {", ".join(extensions.keys())}')
```
源码位置: yt_dlp/networking/common.py:340-347

## 易混淆 / 边界 / 推断
- **事实**：`UnsupportedRequest` 不等于"出错"——它是引擎与请求之间的"能力不匹配"声明，调度器靠它做降级跳过；只有 `NoSupportingHandlers` 才是真正向调用方报错。源码位置: common.py:109-113、exceptions.py:30-50。
- **事实**：调度器对引擎运行期异常分两类——`RequestError` 子族直接透传（视为"正常的请求失败"），其它 `Exception` 视为引擎 bug，记入 `unexpected_errors` 后**继续尝试下一个引擎**，不立即崩溃。源码位置: common.py:116-125。
- **事实**：`add_handler` 按 `RH_KEY` 去重，同 key 后者覆盖前者；`build_request_director` 末尾还会针对 `prefer-legacy-http-handler` 兼容选项临时注入一条"给 Urllib 加 500 分"的偏好，这是兼容性靠偏好函数叠加的实例。源码位置: common.py:75-78、YoutubeDL.py:4379-4380。
- **事实**：代理字典除协议键外还认 `all`（全协议兜底）和 `no`（不走代理的主机列表）两个特殊键，引擎是否支持由 `_SUPPORTED_FEATURES` 里的 `Features.ALL_PROXY / Features.NO_PROXY` 决定。源码位置: common.py:144-147、296-315。
- **推断**：把可选能力放进 `extensions` 而非请求字段，是为了让"伪装"等后续能力（见第 3 章）能零侵入追加——新扩展只要在引擎的 `_check_extensions` 里 pop 认领即可，不必改 `Request.__init__` 签名；代码注释 `_check_extensions` "subclasses should extend this ... pop and validate" 印证此意图。源码位置: common.py:198-211、333-338。
- **推断**：偏好用"集合求和"而非单一优先级数字，是为了让多个独立特性（伪装、兼容旧引擎）各自注册打分、互不感知地叠加；代价是最终顺序不易直觉预测，故 verbose 模式专门打印每个引擎得分。源码位置: common.py:80-88、86-87。
- **未理解**：`Request.data` setter 中 `if data == self._data and self._data is None:` 这一支的具体触发场景（data 为 None 且前后相等时弹 `Content-Length`）未找到明确调用方动机，疑似防御性清理；Writer 正文不必展开。
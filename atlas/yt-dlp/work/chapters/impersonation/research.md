# 浏览器指纹伪装：作为扩展叠加的传输能力 · 源码精读

## 给 Writer 的教学钩子（必填，8 子项缺一不可）

- **用户痛点 / 场景**：很多站点会通过 TLS 握手指纹（ClientHello / JA3）、HTTP/2 帧序、甚至默认 header 的细微差异，识别出"这不是真浏览器，是脚本"，从而返回验证码或封 IP。光改 User-Agent 没用——指纹对不上。用户只想说一句"假装成 Chrome"，却不想关心底层到底用哪个网络库、能不能真改 TLS。本章讲的就是怎么把"我要伪装"这句**意图**，变成系统里任何传输引擎都能读懂、并由"能力最强者"自动接管的能力。

- **一句话核心思想**：把伪装意图塞进请求的"可选扩展槽"，再用一条偏好规则给"会伪装"的引擎疯狂加分，让路由器自然挑中它——意图与引擎彻底解耦。

- **设计动机（为什么需要它）**：这套机制是为了化解一个矛盾——"伪装"本质上依赖底层库（只有少数库能真改 TLS 指纹，多数只能改 header），但"要不要伪装"是上层每个请求都可能表达的意图。如果让上层直接挑选引擎，就把意图和实现绑死了；于是设计者借用了前置章已建好的两块积木：**请求对象的中立扩展槽**（让意图有地方放，且对所有引擎中立）和**路由器的偏好排序**（让"谁能伪装"这件事在路由层自动胜出，而不是硬编码）。
  - 承前去重提示：**请求对象携带中立扩展、handler 自报能力、路由器按偏好函数排序择优——这套"能力探测 + 偏好路由"骨架已在第 1 章『可插拔传输层』讲透**，本章只看它的**新侧面**：怎样往这套骨架里**挂载一种全新能力（浏览器伪装）**——具体说，就是"注册一条新的偏好函数"+"定义一种新的扩展语义"，而不动骨架本身。Writer 切勿重讲 validate/UnsupportedRequest/偏好求和这些前置原理，只聚焦"伪装这一种能力是怎么叠加进去的"。

- **关键权衡（4 条）**：
  1. **能力走扩展、路由走偏好**：把"伪装"编码成请求的一个可选扩展字段，而不是某个引擎的专属参数；再用一条偏好函数给"支持伪装的引擎"加 1000 分。→ 换来：伪装意图与具体传输引擎解耦——能真改 TLS 指纹的引擎走真指纹，不能的引擎至少能改 header，二者读的是同一份意图。→ 代价：请求对象多了一层扩展协商，还需要一步"把用户给的宽泛目标翻译成引擎实际支持的确切目标"的解析。
  2. **模糊目标 + 自报支持表，换来宽容的用户输入**：伪装目标对象用"缺省即通配任意"的语义，并定义一种双向模糊匹配——用户只需说"我要 Chrome"，引擎自动在自己声明支持的目标里找出一个匹配的确切版本（如 Chrome 146 / macOS）。→ 换来：上层（CLI、提取器）只需给一个模糊意图，各引擎的版本/平台差异被吸收。→ 代价：匹配语义是隐式约定（理解成本高）；当多个引擎都支持 Chrome 时，靠"支持表是有序的、列表顺序即偏好"来决定谁胜。
  3. **中间抽象类只校验、叶子类才消费**：能力分两层抽象——上层抽象基类负责"校验这个目标我支持不支持"，但它不声明"我已经消费了这个扩展"；真正声明消费（把扩展从请求里取走）的是最底层的具体引擎。→ 换来：可有多层抽象叠加（通用基类 → 伪装能力基类 → 具体引擎），每层各司其职，新引擎只继承最后两层即可获得伪装能力。→ 代价：这是一条隐式契约，中间层若忘记遵守，会出现"基类声明支持某扩展、实际却没人消费"的悬空。
  4. **主动让位默认 header，换取指纹一致性**：一旦确定要走伪装，会先把"值等于程序默认 header"的那些条目移除，把 header 的控制权让给底层库按目标浏览器生成全套匹配 header。→ 换来：真正的浏览器指纹（TLS 层 + 应用层 header 必须一致才像）不会被程序自造的默认 header 破坏。→ 代价：header 清理逻辑依赖一个全局默认 header 作为隐式基准（源码里已标注为待改进的技术债）。

- **最小心智模型（7 步）**：
  1. 调用方在请求的扩展槽里塞一个"伪装目标"（可只指定浏览器名，其余留空=任意）。
  2. 路由器对每个已注册引擎跑全部偏好函数求和排序；"伪装偏好函数"给"既会伪装、本请求又要伪装"的引擎加 1000 分，使其排到第一。
  3. 路由器按排序逐个校验引擎：伪装能力基类检查"这个目标是否落在我支持的目标集合内"（靠模糊匹配），不支持就抛"不支持"异常，跳到下一个引擎。
  4. 被选中的引擎（能真改 TLS 的那个）把用户的模糊目标"具象化"为它实际支持的确切目标，并从扩展槽里取走该字段（声明已消费）。
  5. 该引擎整理 header：移除与程序默认值冲突的条目，给底层指纹让位。
  6. 引擎把确切目标透传给底层网络库，底层重放真实浏览器的 TLS/HTTP 指纹。
  7. 把"实际用了哪个目标"写回响应对象的扩展槽，供上层和重试逻辑知晓。

- **最小原理演示（替代旧"复刻范围"）**：
  - 应演示：一个**小到只表达"能力走扩展 + 偏好路由 + 模糊目标具象化"**的从零实现（约 60～80 行 TS）。核心要演三件事——(a) 目标对象的"缺省即通配 + 双向模糊匹配"；(b) 引擎自报"我支持哪些目标"，请求里只放一个模糊目标；(c) 路由器持有一组偏好函数，给会伪装的引擎加超大分使其胜出，胜出后把模糊目标 resolve 成确切目标再"发送"。每一行都要对应上面某条权衡：模糊匹配对应权衡 2，偏好加分对应权衡 1，resolve+发送对应权衡 1 的后半段。
  - 应故意省略：真实的 TLS 指纹改写（那是 curl_cffi/BoringSSL 的事，演示只需 `console.log("TLS 指纹 ← chrome-146")` 占位）、cookie/代理/超时等无关扩展、curl_cffi 的版本兼容映射表、HTTP 错误处理、多引擎注册的工程脚手架。**不追求工程完整，只演透"意图如何经偏好路由落到能力最强者"。**
  - 演示载体建议：**首选 TS/JS**。本章核心是「数据结构（四维目标 + 模糊匹配）+ 调度（偏好求和排序择优）+ 协议（扩展槽契约）」，这些用 TS 忠实演透毫无障碍，且本 Atlas 产物本身就是 JS 生态站点，TS 演示对读者最友好、可直接 `bun run`/`node` 跑。**无需退回 Python**——本章不涉及 Python 特有语义（dataclass/classproperty 等只是语法糖，TS 用普通 class + readonly 即可等价表达）。

- **正文不宜展开的细节**：目标对象的字符串解析正则（`client-version:os-os_version` 的双向编解码）；`order=True` 排序键在 curl_cffi 里那条极复杂的多键优先级（不可靠目标降权、移动端降权、tor<edge<firefox<safari<chrome、取最新版）；`keep_header_casing` 扩展的 header 大小写保留分支；编排器层把 CLI 的布尔/字符串/列表统一解析成目标列表的胶水代码。这些供 Writer 裁剪，不进主线。

- **推荐的一个执行轨迹例子**：输入 = 一个请求（URL + 扩展槽里放着"伪装成 Chrome"的模糊目标），系统里挂着两个引擎——普通引擎（只会改 header）和指纹引擎（能真改 TLS）。路由器排序后普通引擎=0 分、指纹引擎=1000 分 → 指纹引擎胜出；校验发现它支持 Chrome → 把模糊的"Chrome"具象化为它优先级最高的确切目标"Chrome 146 / macOS"；整理 header 时移除程序默认 UA 等；底层库据此重放 Chrome 146 的 TLS 指纹发送请求；输出 = 响应，其扩展槽里回写"实际用了 Chrome 146 / macOS"。

> 以上钩子供 Writer 写「动机→核心思想→心智模型→关键权衡→原理演示」；下面事实部分供核对，不要被 Writer 当目录照抄。

## 概念要点

- **伪装目标是四维 + None 通配的不可变值对象**：`ImpersonateTarget` 是 `@dataclass(order=True, frozen=True)`，四个字段 `client/version/os/os_version` 全可空，注释明确"None 表示匹配任意"。`order=True` 使其可排序（供"优先选最新版本"等排序用）；`frozen=True` 使其可哈希、可作 dict 的 key。源码位置: yt_dlp/networking/impersonate.py:15-32
- **目标有层级约束**：`__post_init__` 规定"设了 version 就必须有 client""设了 os_version 就必须有 os"——防止出现"只有版本号没有浏览器名"这种无意义规格。源码位置: yt_dlp/networking/impersonate.py:34-38
- **模糊匹配是双向通配（核心机制）**：`__contains__(self, target)` 对每一维判断"任一方为 None 即通过，否则必须相等"。所以"宽泛目标 in 精确目标"和"精确目标 in 宽泛目标"都成立。这是上层只给 `chrome` 就能匹配到 handler 的 `chrome-116:windows-10` 的根因。源码位置: yt_dlp/networking/impersonate.py:40-48
- **handler 沿用前置章的"自报能力表"模式**：`ImpersonateRequestHandler` 声明类属性 `_SUPPORTED_IMPERSONATE_TARGET_MAP: dict[ImpersonateTarget, Any]`——key 是它支持的伪装目标，value 是"该目标对应的底层原生对象"（如 curl_cffi 的 BrowserType）。这正是前置章"`_SUPPORTED_URL_SCHEMES` 等自报能力"的同类手段。源码位置: yt_dlp/networking/impersonate.py:72-81
- **把宽泛目标具象化**：`_resolve_target(target)` 遍历 `self.supported_targets`（即支持表的 keys），返回第一个"包含"用户目标的支持目标。注意返回的是 **handler 自己的支持目标**（带原生映射值），不是用户的输入目标——这一步把"意图"翻译成"我能执行的确切能力"。源码位置: yt_dlp/networking/impersonate.py:103-120
- **伪装能力基类只校验、不消费扩展**：`_check_extensions` 检测到 `extensions['impersonate']` 时调用 `_check_impersonate_target` 校验是否被支持（不支持则抛 `UnsupportedRequest`），但**并不 pop 掉该 key**。真正 pop（声明消费）的是叶子类 `CurlCFFIRH._check_extensions`（`extensions.pop('impersonate', None)`）。这符合前置章契约"subclasses should extend _check_extensions to pop and validate"。源码位置: yt_dlp/networking/impersonate.py:87-97（校验）；yt_dlp/networking/_curlcffi.py:231-238（消费）
- **构造时即拦截非法默认目标**：`_validate` 不只校验请求扩展，还校验 handler 自身构造时传入的默认 `self.impersonate` 是否被支持——把"配了一个本引擎伪装不了的目标"的错误前移到初始化阶段。源码位置: yt_dlp/networking/impersonate.py:99-101
- **启用伪装时主动让位默认 header**：`_get_impersonate_headers` 在确认本请求要走伪装后，遍历移除所有"值等于 `std_headers` 默认值"的 header（注释标注 TODO：不应依赖 std_headers）。意图是把 header 控制权让给底层库按目标浏览器生成全套匹配 header，避免程序自造 header 破坏指纹一致性。子类可覆写 `_prepare_impersonate_headers` 做更多调整。源码位置: yt_dlp/networking/impersonate.py:126-148
- **+1000 分偏好函数（本章对前置章路由骨架的唯一注入）**：模块末尾用 `@register_preference(ImpersonateRequestHandler)` 注册 `impersonate_preference`——装饰器限定它只对 `ImpersonateRequestHandler` 子类生效（其它 handler 返回 0）；当"本请求要伪装（请求扩展或 handler 默认任一非空）"时返回 1000，否则 0。这 1000 分让会伪装的 handler 在 `RequestDirector._get_handlers` 的 `sorted(..., reverse=True)` 中压过普通 handler（urllib/requests）胜出。源码位置: yt_dlp/networking/impersonate.py:151-155；偏好求和与排序逻辑见 yt_dlp/networking/common.py:80-88（前置章）
- **真正改 TLS 指纹的落点在叶子引擎**：`CurlCFFIRH._send` 把 `_resolve_target` 具象化后的目标经 `_SUPPORTED_IMPERSONATE_TARGET_MAP.get(...)` 映射成原生对象，透传给 `curl_cffi.requests.Session.request(impersonate=...)`——curl_cffi 底层用 BoringSSL 重放真实浏览器的 TLS ClientHello/JA3 与 HTTP/2 帧指纹。这就是"能力走扩展、具体传输各自实现"中"真改 TLS"的那一侧。源码位置: yt_dlp/networking/_curlcffi.py:304-316
- **把实际目标写回响应**：发送后（含 HTTPError 分支）把 `_get_request_target` 的结果写进 `response.extensions['impersonate']`，让上层知道"实际用哪个指纹发的"，供重试与诊断使用。源码位置: yt_dlp/networking/_curlcffi.py:240-248
- **编排器层的接入（前置 orchestrator 章范围，本章略提）**：`YoutubeDL._impersonate_target_available` 遍历所有 `ImpersonateRequestHandler` 问"你支持这个目标吗"；`_parse_impersonate_targets` 把 CLI 传入（可能是布尔/字符串/列表）统一解析成目标列表并过滤出"至少一个 handler 支持"的目标。`__init__.py` 里声明 `curl_cffi` 是提供 chrome/safari/firefox/edge/tor 指纹的可选依赖。源码位置: yt_dlp/YoutubeDL.py:4243-4268；yt_dlp/__init__.py:1002-1006

## 关键调用链

请求侧（意图 → 路由 → 校验 → 具象化 → 真发）：
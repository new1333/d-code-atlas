# 协议字段驱动的下载策略分派 · 源码精读

## 给 Writer 的教学钩子（必填，8 子项缺一不可）

- **用户痛点 / 场景**：同样是"下载一个视频"，背后可能是普通的 HTTP 文件、一条 HLS 播放列表、一个 RTMP 直播流、一段被切片的 DASH 流，甚至需要把独立的音视频两条流边下边合并。如果编排器要自己 `if 是 HLS … else if 是 RTMP …` 地判断，它就会被无穷无尽的协议细节淹没，而且每新增一种协议都要回去改核心流程。使用者真正想要的只是"给我这个视频文件"，至于用哪种姿势拿到——那是下载阶段自己的事，不该泄漏到上层。

- **一句话核心思想**：**让数据自带"我该被怎么下载"的标签（协议字段），再用一张分派表把标签翻译成具体的下载策略**——上层只负责把数据递过来，完全不感知下载细节。

- **设计动机（为什么需要它）**：这套机制要解决的矛盾是"下载实现的高度多样性"与"编排器想保持简单/稳定"之间的张力。它换来的能力是：编排器对下载阶段只需要一行"给我合适的下载器"的调用，新增一种下载协议时编排器一行都不用改。
  - **承前（跨章去重信号）**：本章依赖的 `info_dict` 胖字典数据总线**（已在第 4 章『info_dict 数据总线与提取器骨架』讲透，本章只看它的一个新侧面：字典里的 `protocol` 字段如何被下载阶段消费、驱动策略选择）**。同理，"基类吸收所有横切样板、子类只填一个钩子"的分工思想也**（与第 4 章提取器基类同构，本章只看它在下载器基类上的具体落地，勿重复讲'基类吸收样板'这个抽象原理）**。
  - **同构提及（非依赖，点到即可）**：本章用"类名后缀约定 → 自动注册发现"来装配下载器集合，这与第 2 章『插件注册』的"约定胜配置"是**同一个思想的不同载体**——若要讲，只讲本章 `XxxFD` 后缀 + 自动发现表这个具体机制，不要重讲"约定胜配置为何优于显式注册表"。

- **关键权衡（本章核心，4 条）**：
  1. **用数据里的协议字段驱动策略选择 → 换来编排器对下载细节完全无感、新增协议零侵入 → 代价是协议→下载器的所有"特例"（直播、格式合并、时间区间裁剪、原生 vs 外部优先）全部堆积进同一个分派函数，长成一片条件分支海洋，可读性随协议增多持续劣化**。（这是全章最核心的权衡，务必讲透。）
  2. **外部可执行程序下载器（aria2c/ffmpeg/curl/wget）与原生内置下载器共用同一套抽象 → 换来编排器无差别对待"调子进程拉文件"和"进程内下载"，可以一行切换 → 代价是外部下载器必须把数据字典翻译成对方能理解的命令行参数（每个工具一套适配），并自负其责地探测"我能不能下这个（available + supports）"**。
  3. **把"我能下吗"做成下载器自报能力（声明支持的协议集合 / 功能特性），由分派方逐个询问 → 换来多后端可插拔、能优雅降级到下一个候选 → 代价是每个下载器都必须老实声明自己的能力边界，否则要么被错误启用、要么永远没机会上场**。（此权衡与第 1 章『传输层』的能力探测/偏好排序同构，可一句话呼应，不展开。）
  4. **把限速、断点续传、临时 .part 文件、进度条、文件访问重试等所有横切关注点收进下载器基类 → 换来每个具体下载器子类只需实现"真正把字节写下来"这一个方法 → 代价是基类日益臃肿，且子类与基类之间通过一个巨大的 params 选项字典做隐式耦合（无编译期契约）**。

- **最小心智模型（6 步）**：
  1. 编排器拿到一个描述目标视频的数据字典，调"给我合适的下载器"。
  2. 先从字典里**算出协议字段**——优先读字典已填好的 `protocol`，否则按 URL 前缀/扩展名兜底推断（rtmp/m3u8/f4m/最后退回 URL 的 scheme）。
  3. 协议字段可能含 `+`（表示这个目标由多种协议拼接，如分离的音视频），按 `+` 拆开**逐个**查分派表。
  4. 对每个协议：若用户配了外部下载器，先问它"你 available（装了吗）且 supports（协议/特性在你的能力清单里吗）"——能就让它接管；否则落到分派表的默认原生下载器。
  5. 合并各协议选出的下载器：若恰好都是那个"既能下又能合并"的多面手（ffmpeg）且条件满足，就交给它一次性边下边合；若只选出一个就直接用；否则返回"无单一下载器能搞定"（交还上层另作处理）。
  6. 选定下载器后，编排器把进度钩子挂上去，调它的公共 `download()`——基类先做完"已存在就跳过/续传/sleep 限速"等横切流程，最后才委托给子类的"真正下载"钩子。

- **最小原理演示（替代旧"复刻范围"）**：
  - **应演示**：一个从零实现的迷你分派器（几十行），忠实演透"字段驱动 + 能力自荐"。骨架：① 一个 `PROTOCOL_MAP`（协议字符串→下载器类）；② `determineProtocol(info)`（先读 `info.protocol`，否则按 url 推断）；③ `getSuitableDownloader(info)`（按 `+` 拆分→逐个查表→合并决策）；④ 一个 `FileDownloader` 基类，其 `download()` 公共流程最后调抽象的 `realDownload()`；⑤ 两个 mock 子类：一个原生下载器、一个"外部下载器"子类声明自己的 `supportedProtocols` 并实现 `canDownload()` 自检。**这段演示演的是权衡 1（字段驱动）+ 权衡 2/3（外部自荐、能力探测）**。
  - **应故意省略**：真实的网络/子进程 I/O、限速/续传/.part 的完整工程实现、AES 分片解密、多行进度条的渲染细节、FFmpeg 命令行参数的完整组装、所有协议特例分支——演示只保留"查表 + 能力探测 + 公共流程委托钩子"这条主干。
  - **演示载体建议（Writer 据此执行）**：**首选 TS/JS**。本章核心是"字段查表 + 多候选能力探测 + 公共流程委托子类钩子"，这是典型的策略分派/能力探测模式，TS/JS 的类与静态字段能忠实演透，配最小 `package.json` 即可 `node`/`bun run` 跑通，对本 Atlas 的 JS 生态读者最友好。无需退回 Python 原仓库语言——演示演的是分派原理，不是 Python 特有语义。

- **正文不宜展开的细节（供 Writer 裁剪）**：每个外部下载器（curl/wget/aria2c/httpie/axel）各自 `_make_cmd` 的参数翻译差异；FFmpeg 命令行的 `-map`/`-bsf:a`/`-protocol_whitelist` 等音视频工程细节；多行进度条 `MultilinePrinter` 的渲染与着色；`wrap_file_access` 装饰器用 `functools.partialmethod` 的元编程技巧；`shorten_protocol_name` 的协议名缩写表；`_configuration_args` 的多层参数回退。这些是工程化脚手架，点到"存在即可"，不展开。

- **推荐的一个执行轨迹例子**：输入 `info = {url: ".../master.m3u8", is_live: false}`（字典里没有显式 `protocol`）→ 算出 `protocol = "m3u8_native"`（因扩展名 m3u8 且非直播）→ 用户没配外部下载器 → 查分派表命中原生 HLS 下载器 → 基类 `download()` 走完横切流程 → 委托子类 `real_download` 真正切片下载 → 进度钩子逐片上报 → 完成重命名收尾。另一条对照轨迹：同一输入但用户传了 `--downloader aria2c` 且目标换成普通 https 直链 → 外部下载器 `available(aria2c)` 通过、`supports(https)` 通过 → 自荐接管，把字典翻成 aria2c 命令行跑子进程。

> 以上钩子供 Writer 写「动机→核心思想→心智模型→关键权衡→原理演示」；下面事实部分供核对，不要被 Writer 当目录照抄。

## 概念要点

- **`FileDownloader` 是所有下载器的基类**，其 docstring 明确声明"接收一个 options 字典而非一堆构造参数"，并规定"子类必须重写 `real_download`"。这正是"基类吸收横切 + 子类填一个钩子"的契约入口。源码位置: yt_dlp/downloader/common.py:37-79, 484-486

- **`FD_NAME` 由类名自动推导**：把驼峰类名（去掉末尾 `FD` 两字符）按大小写边界切分再小写，如 `HlsFD` → `hls`、`HttpFD` → `http`。编排器据此打印"Invoking hls downloader"。源码位置: yt_dlp/downloader/common.py:117-119

- **基类把编排器的若干方法"借"到自己身上**（`_set_ydl` 把 `report_error`/`to_screen`/`trouble` 等 setattr 到 self），让子类写 `self.to_screen(...)` 时不必每次穿过 `self.ydl`。源码位置: yt_dlp/downloader/common.py:95-110

- **限速（slow_down）**：若当前实测速度 > `ratelimit`，按 `byte_counter/rate_limit - elapsed` 计算需要补睡的时间并 `time.sleep`，把均速压到限速线。源码位置: yt_dlp/downloader/common.py:201-215

- **临时 .part 文件（temp_name）**：除非 `nopart` 或输出到 stdout 或目标已是目录，否则给文件名加 `.part` 后缀，下完再原子 `try_rename` 回真名——保证半成品不会覆盖已有的好文件。源码位置: yt_dlp/downloader/common.py:217-222, 259-268

- **文件访问重试（wrap_file_access）**：用装饰器把 `sanitize_open`/`try_remove`/`try_rename` 包一层，遇 `EACCES/EINVAL` 按 `file_access_retries`(默认 3)重试，把"文件被占用/竞态"这种瞬时错误吸收在下载器内部。源码位置: yt_dlp/downloader/common.py:232-268

- **公共下载流程（download）**：先判断"已存在且不覆盖/可续传且已存在"→ 直接报"已下载"并成功返回；否则按 `sleep_interval`/`available_at`(站点规定的可下载时刻)睡一会；最后才调 `real_download`。这套横切流程对所有协议通用。源码位置: yt_dlp/downloader/common.py:430-482

- **进度钩子机制**：基类持有 `_progress_hooks` 列表，`_hook_progress` 把同一个 status dict（注入了 `info_dict` 引用）依次传给所有钩子；`report_progress` 是内置钩子，负责把 downloaded_bytes/eta/speed 渲染成多行进度串。编排器把自己的钩子 `add_progress_hook` 进来即接收到进度事件。源码位置: yt_dlp/downloader/common.py:342-404, 488-500

- **协议字段的来源（determine_protocol）**：先读 `info_dict['protocol']`（提取器已填就直接用）；否则按 URL 兜底——`rtmp` 前缀→`rtmp`，扩展名 `m3u8`→（直播则 `m3u8` 否则 `m3u8_native`），`f4m`→`f4m`，最后退回 URL 的 scheme（http/https/ftp…）。源码位置: yt_dlp/utils/_utils.py:3190-3205

- **分派入口（get_suitable_downloader）按 `+` 拆分多协议**：把协议串按 `+` 切开，逐个调内层 `_get_suitable_downloader` 选出每段协议的下载器，再合并决策——若全部选成 FFmpeg 且可合并则统一交 FFmpeg；若只有一种就直接用；否则返回 None（无单一下载器能整体搞定）。源码位置: yt_dlp/downloader/__init__.py:4-20

- **PROTOCOL_MAP 是协议→原生下载器的分派表**：`rtmp`→RtmpFD、`m3u8_native`→HlsFD、`m3u8`→FFmpegFD、`f4m`→F4mFD、`http_dash_segments`→DashSegmentsFD、各种直播协议→各自专用 FD；查不到则退回 `default=HttpFD`。源码位置: yt_dlp/downloader/__init__.py:40-58, 123

- **外部下载器自荐接管**：若用户配了 `external_downloader`（可按协议指定不同工具），分派函数解析出对应当前协议的外部工具名 → `get_external_downloader` 拿到其 ExternalFD 子类 → 调 `ed.can_download(info_dict, external_downloader)` 自检（可执行文件存在 且 协议/特性支持）→ 通过则由外部下载器接管。`impersonate`（浏览器指纹伪装）启用时禁用外部下载器（外部工具不会改 TLS 指纹）。源码位置: yt_dlp/downloader/__init__.py:93-104

- **特例分支海洋（条件分支堆积）**：`section_start/end`（时间区间裁剪）且 ffmpeg 可下 → 强制 FFmpeg；`m3u8` 直播 → FFmpeg；`hls_prefer_native` 真/假 → HlsFD/FFmpeg；`http_dash_segments` 直播且非强制 native → FFmpeg。这些特例没有任何对象模型，全是裸的 `if` 叠在一个函数里。源码位置: yt_dlp/downloader/__init__.py:89-122

- **ExternalFD 是外部可执行程序的适配器基类**：它继承自 FragmentFD（即外部下载器既能下整文件也能走分片路径），把 `real_download` 实现为"组装命令行 → 跑子进程 → 收集退出码 → 重命名/上报"；子类（CurlFD/WgetFD/Aria2cFD/HttpieFD/AxelFD/FFmpegFD）只需实现 `_make_cmd` 把字典翻成各自工具的参数。源码位置: yt_dlp/downloader/external.py:37-81, 142-189

- **能力探测（supports/can_download）**：`supports` 检查四件事——是否支持 to_stdout、是否支持多协议(含 `+`)、是否触及 HLS AES 加密分片（外部工具搞不定就排除）、目标协议是否全在 `SUPPORTED_PROTOCOLS` 内；`can_download = available(可执行文件存在) and supports`。源码位置: yt_dlp/downloader/external.py:37-39, 105-116

- **约定胜配置的自动发现（_BY_NAME）**：模块级用字典推导扫一遍全局命名空间，把所有以 `FD` 结尾（排除基类 ExternalFD/FragmentFD）的类按 `get_basename()`（类名去 `FD` 小写）登记成一张表；`get_external_downloader` 据此按可执行文件名反查类。新增一个外部下载器只要写一个 `XxxFD` 类即被自动收编，无需改注册表。源码位置: yt_dlp/downloader/external.py:579-595, 83-85

- **FFmpegFD 是特殊的"多面手"**：唯一同时声明 `TO_STDOUT` + `MULTIPLE_FORMATS` 特性、且 `SUPPORTED_PROTOCOLS` 覆盖 http/m3u8/rtmp/dash 的下载器；`can_merge_formats` 使它能在下载阶段就把分离的音视频流合并，故分派时"全是 FFmpeg 且可合并"会收敛到它。源码位置: yt_dlp/downloader/external.py:377-379, 391-398

## 关键调用链

编排器侧接入：
`YoutubeDL.dl` → `get_suitable_downloader(info, params, to_stdout)` → 选出 FD 类 → `(self, params)` 实例化 → `fd.add_progress_hook(编排器的钩子)` → `fd.download(name, info, subtitle)` →（基类横切流程）→ `fd.real_download(name, info)`
源码位置: yt_dlp/YoutubeDL.py:3310-3324

分派内部（单协议）：
`_get_suitable_downloader` →（section 裁剪? → FFmpeg）→ 解析 external_downloader → `get_external_downloader(name)` → `ed.can_download` 自检 →（通过则用 ed）→ 否则 `PROTOCOL_MAP.get(protocol, HttpFD)`
源码位置: yt_dlp/downloader/__init__.py:84-123

外部下载器执行：
`ExternalFD.real_download` → `temp_name` → `_call_downloader` → `_make_cmd`（子类翻字典为命令行）→ `_call_process`(Popen) → 退出码 0 则 `try_rename` + `_hook_progress(finished)`
源码位置: yt_dlp/downloader/external.py:42-81

协议字段来源：
`info_dict['protocol']` 未填 → `determine_protocol` 按 URL 前缀/扩展名兜底
源码位置: yt_dlp/utils/_utils.py:3190-3205

## 源码摘录（带行号，全文累计 ≤ 30 行）

协议字段驱动 + 多协议拆分合并（演权衡 1）：
```python
# yt_dlp/downloader/__init__.py:5-13
info_dict['protocol'] = determine_protocol(info_dict)
...
protocols = (protocol or info_copy['protocol']).split('+')
downloaders = [_get_suitable_downloader(info_copy, proto, params, default) for proto in protocols]

if set(downloaders) == {FFmpegFD} and FFmpegFD.can_merge_formats(info_copy, params):
    return FFmpegFD
```

外部下载器自荐接管（演权衡 2/3）：
```python
# yt_dlp/downloader/__init__.py:101-104
elif external_downloader.lower() != 'native' and info_dict.get('impersonate') is None:
    ed = get_external_downloader(external_downloader)
    if ed.can_download(info_dict, external_downloader):
        return ed
```

子类契约（演权衡 4——基类收横切，子类只填一个钩子）：
```python
# yt_dlp/downloader/common.py:484-486
def real_download(self, filename, info_dict):
    """Real download process. Redefine in subclasses."""
    raise NotImplementedError('This method must be implemented by subclasses')
```

能力探测 supports/can_download（演权衡 3）：
```python
# yt_dlp/downloader/external.py:105-116
@classmethod
def supports(cls, info_dict):
    return all((
        not info_dict.get('to_stdout') or Features.TO_STDOUT in cls.SUPPORTED_FEATURES,
        '+' not in info_dict['protocol'] or Features.MULTIPLE_FORMATS in cls.SUPPORTED_FEATURES,
        not traverse_obj(info_dict, ('hls_aes', ...), 'extra_param_to_segment_url', 'extra_param_to_key_url'),
        all(proto in cls.SUPPORTED_PROTOCOLS for proto in info_dict['protocol'].split('+')),
    ))

@classmethod
def can_download(cls, info_dict, path=None):
    return cls.available(path) and cls.supports(info_dict)
```

约定胜配置自动发现（与第 2 章同构，演载体）：
```python
# yt_dlp/downloader/external.py:579-583
_BY_NAME = {
    klass.get_basename(): klass
    for name, klass in globals().items()
    if name.endswith('FD') and name not in ('ExternalFD', 'FragmentFD')
}
```

## 易混淆 / 边界 / 推断

- **事实**：`m3u8` 与 `m3u8_native` 是两个不同协议字段——前者默认交给 FFmpeg（外部），后者默认交给原生 HlsFD；`determine_protocol` 按扩展名兜底时，直播走 `m3u8`、非直播走 `m3u8_native`。源码位置: yt_dlp/utils/_utils.py:3200-3201, yt_dlp/downloader/__init__.py:45,48

- **事实**：ExternalFD 直接继承自 **FragmentFD**（而非 FileDownloader），因此外部下载器的 `_call_downloader` 里有完整的"分片路径"分支（当 `info_dict` 含 `fragments` 时）。这是本章与下一章『分片化下载』的关键连接点——分片机制由 FragmentFD 定义（下一章讲透），本章只需知道"外部下载器复用了同一条分片路径"。源码位置: yt_dlp/downloader/external.py:11,37,142-189

- **推断（标注为推断）**：分派函数里把直播/区间裁剪/合并等特例写成裸 `if` 而非策略对象，**推测**是历史增量演化的结果——每出现一种"协议字段不足以表达"的情况就补一个分支，导致 `_get_suitable_downloader` 事实上承担了"协议字段之外的二次策略裁决"。这印证了权衡 1 的代价：字段驱动很优雅，但现实中的特例最终需要一个出口，而这个出口退化成了条件分支。

- **推断（标注为推断）**：基类通过 `_set_ydl` 把编排器的方法 setattr 到自己身上（而非继承/组合），**推测**是为了让"千行子类"里的 `self.to_screen(...)` 写法更短、且保持与 youtube-dl 历史子类的源码兼容——代价是下载器实例和编排器之间形成隐式的双向耦合（下载器能直接调编排器的任意委托方法）。

- **边界**：`get_suitable_downloader` 在"多协议且选不出单一下载器"时返回 `None`，**不是**报错——上层（编排器）会据此改走"分别下载再由后处理合并"的另一条路径（见 YoutubeDL 中 `requested_formats` 的处理）。即"边下边合并"走不通时，系统退化为"分别下、后处理合"。源码位置: yt_dlp/downloader/__init__.py:20, yt_dlp/YoutubeDL.py:3482-3487

- **未理解**：`shorten_protocol_name` 的缩写映射（`m3u8_native`→`m3u8`、`m3u8`→`m3u8F` 等）主要用于 `external_downloader` 按协议配置时的键名匹配与调试输出，其完整语义细节未深究，Writer 不必展开。源码位置: yt_dlp/downloader/__init__.py:61-81
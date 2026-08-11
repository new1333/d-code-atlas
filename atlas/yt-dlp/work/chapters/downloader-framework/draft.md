# 协议字段驱动的下载策略分派

> 本章属于 composite 层。前置：info_dict 数据总线与提取器骨架。
> 学完你能：用一句话讲清"为什么编排器不需要 `if/else` 判断协议、却又不可避免地长出了另一片条件分支"。

## 1. 为什么需要它（设计动机）

上一章把站点下发的签名/混淆脚本在进程内解出来——那是 info_dict 在被送进下载阶段之前的一次前置加工。现在 URL 备好了，字典终于要被交到那个真正把字节写到磁盘的环节。但这里马上冒出一个矛盾。

同样是"下载一个视频"，背后可能是普通的 HTTP 文件、一条 HLS 播放列表、一个 RTMP 直播流、一段被切片的 DASH 流，甚至需要把分离的音视频两条流边下边合并。每种姿势完全不同：HLS 要按 m3u8 文件里的分片列表逐个 GET，RTMP 要走 Adobe 的握手协议，DASH 要解析 MPD manifest。如果编排器自己写 `if 是 HLS … else if 是 RTMP …`，它就会被无穷无尽的协议细节淹没，而且每新增一种协议都要回去改核心流程。

使用者真正想要的只是"给我这个视频文件"，至于用哪种姿势拿到——那是下载阶段自己的事，不该泄漏到上层。这套机制要解决的矛盾就是"下载实现的高度多样性"与"编排器想保持简单稳定"之间的张力。

## 2. 核心思想

让数据自带"我该被怎么下载"的标签，再用一张分派表把标签翻译成具体的下载策略——分派方退化成查表，编排器对下载细节完全无感。新增一种协议，编排器一行代码都不用改。

## 3. 心智模型

把整个分派流程拆成六步看：

1. 编排器拿到 info_dict，调一句 `get_suitable_downloader(info)`。
2. 先算协议字段：优先读字典里已填好的 `protocol`，否则按 URL 兜底——`rtmp` 前缀→`rtmp`；扩展名 `.m3u8` 时直播走 `m3u8`、非直播走 `m3u8_native`；`.f4m`→`f4m`；最后退回 URL 的 scheme（http/https/ftp）。
3. 协议字段可能含 `+`（说明目标由多种协议拼接，例如分离的音视频两条流），按 `+` 拆开**逐个**查表。
4. 对每段协议：若用户配了外部下载器（aria2c/ffmpeg/curl…），先问它 "你 `available` 且 `supports` 吗"——能就让它接管；否则落到分派表里的默认原生下载器。
5. 合并各段选出的下载器：若都是那个"既能下又能合并"的多面手 FFmpeg 且条件满足，就交给它一次性边下边合；若只选出一个就直接用；否则返回 `None`（没有单一下载器能整体搞定，交还上层另走"分别下、后处理合"的路径）。
6. 选定下载器后，编排器把进度钩子挂上去，调它的公共 `download()`——基类先做完"已存在就跳过 / 续传 / sleep 限速"等横切流程，最后才委托给子类的 `real_download` 钩子。

## 4. 关键权衡

### 字段驱动换编排器零侵入，代价是分派函数沦为特例分支海洋

选择：让 info_dict 自带 `protocol` 字段驱动策略选择。
换来：编排器对下载细节完全无感，新增一种协议只要在 `PROTOCOL_MAP` 里加一行映射。
代价：协议→下载器之间所有"字段不足以表达"的特例——`section_start/end` 时间区间裁剪、`m3u8` 直播、`hls_prefer_native` 偏好、`http_dash_segments` 直播——全部以裸 `if` 堆叠在同一个分派函数里，没有任何对象模型。每出现一种新情况就补一个分支，分派函数事实上承担了"协议字段之外的二次策略裁决"，可读性随协议增多持续劣化。

**本质矛盾**：声明式的字段驱动想用一张平表表达"什么协议用哪个下载器"，但现实的下载策略包含大量上下文相关、用户偏好相关、合并可行性相关的动态决策——平表表达不了动态，于是动态部分只能漏到分派函数里退化成条件分支。这是「用静态字段表达动态策略」这一类问题的通病：字段驱动越纯粹，能表达的越少；为了让它能扛住复杂现实，就要不停地往分派函数里塞例外。

### 内置与外置下载器共用同一套抽象，换无差别路由

选择：把外部可执行程序（aria2c / ffmpeg / curl / wget）也实现成 `ExternalFD` 子类，和原生内置下载器（HttpFD / HlsFD）继承自同一个基类。
换来：编排器无差别对待"调子进程拉文件"和"进程内下载"——一行 `--downloader aria2c` 就能切换，路由代码完全不知道差别。
代价：外部下载器必须做两件原生下载器不用做的事——把数据字典翻译成对方能理解的命令行参数（每个工具一套适配，写在 `_make_cmd` 里），并自己探测"我能不能下这个"。代价薄到不展开，主要是多一层命令行翻译。

**本质矛盾**：能力异构的下载后端在路由层看起来必须同形——一个是进程内的字节流写盘、另一个是 fork 一个外部进程并喂命令行参数。否则编排器就要为每种后端写专属分支，统一抽象的代价就是把"翻译成对方能理解的形式"强行加到外部一侧。

### 能力自报换可插拔与优雅降级

选择：把"我能下吗"做成下载器自报能力——每个外部下载器声明 `SUPPORTED_PROTOCOLS` / `SUPPORTED_FEATURES`，分派方用 `can_download = available and supports` 逐个询问。
换来：多后端可插拔、能优雅降级到下一个候选——aria2c 没装？试试 ffmpeg；都不行？退回原生 HttpFD。
代价：每个下载器都必须老实声明自己的能力边界，否则要么被错误启用（声明过度，下载到一半才发现搞不定），要么永远没机会上场（声明过窄）。

> 这条与第 1 章『传输层』的 `validate / UnsupportedRequest` 能力探测同构——一个是请求处理器层、一个是下载器层，本质都是"用自报能力换可插拔"。这里只点一句，不展开。

### 横切关注点收进基类，换子类只填一个钩子

选择：把限速（`slow_down`）、断点续传、临时 `.part` 文件（`temp_name`）、文件访问重试（`wrap_file_access`）、进度钩子、多行进度条这些和具体协议无关的横切关注点全部收进 `FileDownloader` 基类的 `download()` 公共流程。
换来：每个具体下载器子类只需实现"真正把字节写下来"这一个钩子——`real_download(filename, info_dict)`，几十行就够。
代价：基类日益臃肿到几百行，且子类与基类之间通过一个巨大的 params 选项字典做隐式耦合（`nopart` / `ratelimit` / `sleep_interval` / `file_access_retries` 等几百个键全靠文档约定，无编译期契约）。基类还通过 `_set_ydl` 把编排器的 `report_error` / `to_screen` / `trouble` 等方法 setattr 到自己身上——子类写 `self.to_screen(...)` 时不必每次穿过 `self.ydl`，但下载器实例和编排器之间就此形成隐式的双向耦合。

> "基类吸收横切样板"这个分工思想在第 4 章『info_dict 数据总线与提取器骨架』的 InfoExtractor 基类上已讲透。本章不再重讲抽象原理，只看它具体吸收了哪些横切。

## 5. 最小原理演示

下面这段 TS 演示演透"字段驱动 + 能力自报 + 公共流程委托钩子"这条主干。每行都对应上面某个原理点：`PROTOCOL_MAP` 演字段驱动，`ExternalFD.supports/canDownload` 演能力自报，`pickForOneProtocol` 演外部下载器自荐接管，`getSuitableDownloader` 的 `+` 拆分演多协议合并，`FileDownloader.download` 演横切流程委托 `real_download` 钩子。

```ts
// 下载器基类：横切流程 + 委托子类钩子
abstract class FileDownloader {
  constructor(public params: any) {}
  download(filename: string, info: any): boolean {
    if (exists(filename) && !this.params.overwrite) return true   // 已存在跳过
    this.maybeSleep()                                              // sleep 限速等横切
    const tmp = filename + '.part'                                 // 临时 .part 文件
    try { return this.real_download(tmp, info) }                   // 委托子类真正写盘
    finally { tryRename(tmp, filename) }                           // 原子重命名收尾
  }
  abstract real_download(filename: string, info: any): boolean
  maybeSleep() {}
}

// 内置下载器
class HttpFD extends FileDownloader { real_download() { return true } }
class HlsFD  extends FileDownloader { real_download() { return true } }
class RtmpFD extends FileDownloader { real_download() { return true } }

// 外部下载器基类：能力自报 + can_download 自检
abstract class ExternalFD extends FileDownloader {
  static SUPPORTED_PROTOCOLS: string[] = []
  static available(): boolean { return true }       // 探测可执行文件是否安装
  static supports(info: any): boolean {
    return info.protocol.split('+').every((p: string) =>
      this.SUPPORTED_PROTOCOLS.includes(p))
  }
  static canDownload(info: any): boolean {
    return this.available() && this.supports(info)
  }
  abstract _make_cmd(filename: string, info: any): string[]  // 把字典翻成命令行
}

class Aria2cFD extends ExternalFD {
  static SUPPORTED_PROTOCOLS = ['http', 'https', 'ftp']
  _make_cmd(filename: string, info: any) { return ['aria2c', '-o', filename, info.url] }
}

class FFmpegFD extends ExternalFD {
  static SUPPORTED_PROTOCOLS = ['http', 'https', 'm3u8', 'rtmp']
  static canMergeFormats(_info: any): boolean { return true }   // 多面手：能边下边合并
  _make_cmd(filename: string, info: any) { return ['ffmpeg', '-i', info.url, filename] }
}

// 分派表（协议→下载器类）与外部下载器名表
const PROTOCOL_MAP: Record<string, any> = {
  http: HttpFD, https: HttpFD,
  m3u8_native: HlsFD, m3u8: FFmpegFD,
  rtmp: RtmpFD, f4m: FFmpegFD, http_dash_segments: FFmpegFD,
}
const EXTERNAL_BY_NAME: Record<string, typeof ExternalFD> = {
  aria2c: Aria2cFD, ffmpeg: FFmpegFD,
}

// 协议字段来源：优先读字典已填好的，否则按 URL 兜底推断
function determineProtocol(info: any): string {
  if (info.protocol) return info.protocol
  if (info.url.startsWith('rtmp')) return 'rtmp'
  if (info.url.endsWith('.m3u8')) return info.is_live ? 'm3u8' : 'm3u8_native'
  if (info.url.endsWith('.f4m')) return 'f4m'
  return new URL(info.url).protocol.replace(':', '')
}

// 单段协议选一个下载器
function pickForOneProtocol(info: any, proto: string, params: any): any {
  const extName = params.external_downloader?.[proto]
  if (extName && extName !== 'native' && !info.impersonate) {
    const ed = EXTERNAL_BY_NAME[extName]
    if (ed && ed.canDownload({ ...info, protocol: proto })) return ed   // 自荐接管
  }
  return PROTOCOL_MAP[proto] ?? HttpFD                                   // 默认原生兜底
}

// 分派入口：按 + 拆分多协议，逐个查表后合并决策
function getSuitableDownloader(info: any, params: any): any {
  info.protocol = determineProtocol(info)
  const chosen = info.protocol.split('+').map(p => pickForOneProtocol(info, p, params))
  if (chosen.every(c => c === FFmpegFD) && FFmpegFD.canMergeFormats(info))
    return FFmpegFD                                                      // 边下边合
  return new Set(chosen).size === 1 ? chosen[0] : null                   // 否则交还上层
}
```

## 6. 执行轨迹

**输入一**：`info = { url: 'https://cdn.example.com/master.m3u8', is_live: false }`，没显式 `protocol`，没配外部下载器。

1. `determineProtocol(info)` 检查到扩展名 `.m3u8` 且非直播 → 推断为 `m3u8_native`。
2. `'m3u8_native'.split('+')` 得 `['m3u8_native']`，单段。
3. `pickForOneProtocol` 读不到 `external_downloader`，落到 `PROTOCOL_MAP['m3u8_native']` → `HlsFD`。
4. `chosen = [HlsFD]`，单一 → 直接返回 `HlsFD`。
5. 编排器实例化 `new HlsFD(params)`，挂进度钩子，调 `fd.download(name, info)`。
6. `FileDownloader.download` 走横切：无 `.part` 续传 → 不 sleep → 委托 `HlsFD.real_download` 真正切片下载 → 进度钩子逐片上报 → `tryRename` 收尾。

**输入二（对照）**：同一字典但 url 换成普通 https 直链，且用户传了 `--downloader aria2c`。

1. `determineProtocol` 退到 URL scheme → `https`。
2. `pickForOneProtocol` 读到 `external_downloader.https = 'aria2c'`。
3. `Aria2cFD.canDownload({ protocol: 'https', ... })`：`available()` 通过；`supports()` 检查 `'https'.split('+') = ['https']` 全在 `['http','https','ftp']` 内 → 通过。
4. 自荐接管，返回 `Aria2cFD`。
5. `Aria2cFD.real_download` 调 `_make_cmd` 把字典翻成 `['aria2c', '-o', name, url]`，跑子进程拉文件，收退出码、重命名、上报 finished。

两条轨迹的差别只在第 3 步——分派方对内置和外置完全一视同仁，路由代码没有任何分支感知到"子进程 vs 进程内"。

## 7. 教学简化说明

本章演示故意省略了：真实的网络 I/O 与子进程 `Popen`、限速算法的精确数学、`.part` 重命名在跨文件系统下的原子性细节、AES-128 分片解密、多行进度条的渲染、FFmpeg 命令行 `-map`/`-bsf:a`/`-protocol_whitelist` 等音视频工程细节、所有协议特例分支（section 裁剪、`hls_prefer_native`、直播强制 FFmpeg 等）。这些是工程化脚手架，原理主干只需要"查表 + 能力探测 + 公共流程委托钩子"。

## 8. 小结

`protocol` 字段是一张路由标签，让编排器在千百种下载姿势面前只说一句"给我合适的下载器"。换来的零侵入是真的，付出的代价也是真的——字段表达不出的特例全挤进分派函数的条件分支海洋。

下一章会揭开一个隐藏连接点：当协议落到 `m3u8_native` / `http_dash_segments` 时，下载实际走的是 `FragmentFD` 子类——把"长流"建模为"可迭代的分片序列"、用簿记文件支持断点续传的舞台，外部下载器复用的也是同一条分片路径。
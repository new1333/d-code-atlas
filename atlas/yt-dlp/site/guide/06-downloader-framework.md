# 协议字段驱动的下载策略分派

## 编排器不想知道"这个视频怎么下"

想象你是那个负责"把视频从网上拿下来"的编排器。同样一句话"下载这个视频"，背后可能是：一个普普通通的 HTTP 文件、一份 HLS 播放列表（一长串小切片）、一条 RTMP 直播流、一段被切片的 DASH 流，甚至要分别拉一条纯视频流和一条纯音频流、边下边合并。

如果你的做法是：

```ts
if (url 后缀是 m3u8) 用 HLS 下载器
else if (url 是 rtmp) 用 RTMP 下载器
else if (要合并音视频) 用 ffmpeg
else ...
```

那你就惨了。每一种协议的细节都会涌进你的核心流程，而且每多支持一种协议，你都得回来改这段 `if/else`。更糟的是，用户今天想用内置下载器、明天想换成 aria2c 加速，这个选择也不该是你操心的。

使用者真正想说的只有一句："**给我这个视频文件**"。至于用哪种姿势把它拿下来——那是下载阶段自己的事，不该漏到上层。

这一章要讲的就是 yt-dlp 怎么做到这件事的：**让数据自己带一个"我该被怎么下载"的标签，再用一张表把标签翻译成具体的下载器**。上层只负责把数据递过来，完全不碰下载细节。

## 一个标签决定一切：协议字段驱动

先打个比方。快递分拣中心里，每个包裹上都贴着一张运单标签——写明这件走空运、那件走陆运、还有一件得专人押送。分拣员根本不需要打开箱子判断内容，只看标签就把包裹丢到对应的传送带上。

这里那张"运单标签"就是信息字典里的 **`protocol` 字段**。分派函数拿到一个描述目标视频的字典后，第一件事就是把这个标签读出来（字典里没填就按 URL 兜底推断），然后查一张"协议 → 下载器"的对照表，命中谁就用谁。

> 跨章一句：这个信息字典是整个系统贯穿各阶段的"公共语言"，第 4 章已经讲透它是怎么在提取器→编排器→下载器→后处理器之间流动的。本章只盯着它的一个新侧面——字典里那个 `protocol` 字段，是怎么被下载阶段消费、驱动策略选择的。

整个分派的心智模型，六步走完：

1. 编排器拿到目标视频的字典，喊一句"给我合适的下载器"。
2. 先**算出协议字段**：优先读字典里已填好的 `protocol`，没填就按 URL 前缀/扩展名兜底（rtmp 前缀、m3u8 扩展名、f4m 扩展名，最后退回 URL 的 scheme）。
3. 字段里可能带 `+`（表示这个目标由好几种协议拼成，比如分离的音视频），按 `+` 拆开，**逐个**查表。
4. 每一段协议：如果用户配了外部下载器，先问它"你装了吗、这个活你能接吗"——能就让它接管；否则落到表里的默认原生下载器。
5. 合并各段选出的下载器：要是全都落到了那个"既能下又能合并"的多面手 ffmpeg 且条件满足，就交给它一次性边下边合；只选出一种就直接用；否则返回"没有单一下载器能整体搞定"，交还上层另想办法。
6. 选定下载器后，编排器把进度钩子挂上去，调它的公共 `download()`——基类先跑完"已存在就跳过/续传/限速"这些通用流程，最后才委托给子类那个"真正把字节写下来"的钩子。

接下来自底向上拆：先看"下载器"这个最小零件长什么样，再看标签怎么来、怎么翻译、怎么拼接。

## 最小零件：一个下载器对象长什么样

不管协议多花哨，所有下载器对外都得是同一个样子——都有一个 `download(filename, info_dict)` 方法。这样编排器调用时根本不用管底下是哪个类。

这个统一的样子由基类 `FileDownloader` 定。它干两件事：

**第一件，把所有协议都要做、但跟协议无关的杂活全揽下来。** 限速（下太快就主动睡一会儿把均速压下来）、断点续传、临时 `.part` 文件（先下到 `xxx.part`，下完再原子改名回真名，保证半成品不覆盖好文件）、文件访问出错重试（文件被占用之类的瞬时错误，重试几次而不是直接失败）、进度钩子（把同一个进度字典依次喂给所有挂上来的钩子，编排器据此更新进度条）——这些横切关注点全在基类里。

**第二件，给子类只留一个钩子。** 基类的 `download()` 把上面那些杂活跑完之后，最后才调用 `real_download(filename, info_dict)`——这个方法在基类里直接抛 `NotImplementedError`，子类必须自己实现。换句话说，子类只管一件事："真正把字节写下来"，其余的基类都帮你做完了。

```ts
abstract class FileDownloader {
  params: Record<string, unknown>
  download(filename: string, info: Info): boolean {
    // 横切：已存在且允许续传 → 跳过
    if (this.params.continuedl && exists(filename)) return true
    // 横切：站点规定此刻才能下 → 先睡
    if (info.available_at) this.sleepUntil(info.available_at)
    // 横切都跑完 → 委托给子类的"真正下载"
    return this.real_download(filename, info)
  }
  abstract real_download(filename: string, info: Info): boolean
}
```

> 跨章一句："基类吸收所有横切样板、子类只填一个钩子"这个分工，第 4 章在提取器基类上已经讲透（一个 `_real_extract` 钩子 + 一整套抓取样板）。这里是同一个思想，换到下载器上的具体落地——它多出来的代价，放到本章末尾的关键权衡里细说。

## 标签从哪来：`determine_protocol`

协议字段优先信提取器填好的——提取器解析站点时已经知道这是 HLS 还是 RTMP，直接写进 `info_dict['protocol']`，下载阶段照单全收。

问题是有些老字典没填这个字段。那就按 URL 兜底推断：URL 以 `rtmp` 开头就当 RTMP；扩展名是 `m3u8` 就当 HLS（但直播和非直播要区分，下面单独说）；扩展名是 `f4m` 就当 F4M；都匹配不上，就退回 URL 的 scheme（http/https/ftp……）。

这里有个很能说明问题的细节：**同一个 `.m3u8` 文件，直播和点播会落到两个不同的下载器上。** `determine_protocol` 看到 `m3u8` 扩展名时，会看 `is_live`：直播返回 `m3u8`，点播返回 `m3u8_native`。而这两个字段在分派表里指向的下载器完全不同——点播走原生 HLS 下载器，直播交给 ffmpeg。说人话就是：决定用哪个下载器的不是 URL 长什么样，而是数据里那个标签说什么。

## 一张表翻译标签：分派表与原生下载器

有了标签，就靠一张 `PROTOCOL_MAP` 把它翻译成下载器类：

```
rtmp          → RtmpFD
m3u8_native   → HlsFD        （点播 HLS，原生逐片下载）
m3u8          → FFmpegFD     （直播 HLS，交给 ffmpeg）
f4m           → F4mFD
http_dash_segments → DashSegmentsFD
... 各种直播协议 → 各自专用 FD
查不到        → 退回 HttpFD   （兜底的通用 HTTP 下载器）
```

查表这一步极其直白：拿到协议字符串，去表里取对应的类，没有就给默认的 `HttpFD`。新增一种协议？在表里加一行、写一个新的 `XxxFD` 类，编排器一行都不用改。

不过现实没这么干净——直播要换下载器、用户偏好原生还是外部、时间区间裁剪必须用 ffmpeg……这些"协议字段表达不了"的特例，最后全堆进了查表函数里，长成一片裸的 `if`。这正是本章最核心的权衡，先记住，后面专门展开。

## 外部下载器：子进程也来抢活

到目前为止说的都是"进程内下载"——下载逻辑就在 yt-dlp 自己的进程里跑。但用户常常想用 aria2c 多线程加速，或者直接让 ffmpeg 拉流。这些是**外部可执行程序**，运行方式完全不同：组命令行、起子进程、等退出码。

有趣的是，yt-dlp 没有为它们另起一套体系。外部下载器（aria2c/ffmpeg/curl/wget/…）和原生下载器**共用同一套抽象**——同样继承自基类那一脉，同样对外暴露 `download()`。所以对编排器来说，"调子进程拉文件"和"进程内下载"没有任何区别，`--downloader aria2c` 一个开关就能整体换引擎。

那外部下载器怎么"被选中"？靠它自己毛遂自荐。每个外部下载器类都声明两样东西：一个 `SUPPORTED_PROTOCOLS`（我能下哪些协议），一个 `SUPPORTED_FEATURES`（我支持哪些特性，比如能不能输出到 stdout、能不能一次处理多个格式）。分派时，先看用户配没配外部下载器，配了就调它的 `can_download` 自检——**`available`（我可执行文件装了吗）且 `supports`（这个活在我的能力清单里吗）**，两项都过就由它接管。

`supports` 这个自检问了四件事：要不要输出到 stdout（不是所有工具都支持）、协议里有没有 `+`（多协议只有 ffmpeg 能整）、有没有碰上 HLS 的 AES 加密分片（外部工具搞不定加密）、目标协议是不是全在我的清单里。

> 跨章一句：这套"下载器自报能力、分派方逐个问、首选不行就降级"的机制，和第 1 章传输层那套"handler 自报能力 + Director 按偏好择优"是同构的，那里已经展开过，这里不重复。本章只看它落在下载器上的这四项自检。

至于"怎么知道世界上有哪些外部下载器"——靠一个约定：**类名以 `FD` 结尾，就自动被收进一张发现表**。模块加载完，扫一遍全局命名空间，把所有 `XxxFD` 按类名登记好。新增一个外部下载器？写个 `XxxFD` 类，自动就被收编了，不用改任何注册表。

> 跨章一句：这个"后缀即类型、约定胜配置"的发现机制，和第 2 章插件注册（IE/PP/RH 后缀）是同一个思想，那里讲透了为什么约定胜过显式注册表，这里不重讲。

## 多协议拼接：拆开逐个查，能合则合

有些目标不是单一协议能搞定的。最典型的是分离的音视频：视频流是一条 m3u8、音频流是另一条 http。这种情况下，`protocol` 字段长这样：`https+m3u8_native`，中间一个 `+` 把两段协议拼起来。

分派函数看到 `+`，就把它拆开，**逐段**查表/问外部，各自选出下载器，然后再做合并决策：

- 要是**各段全都落到了 ffmpeg**，而且条件满足（能合并、不是不允许直接合并），就交给 ffmpeg **一次性边下边合**——两条流一起喂进去，出来一个合并好的文件。
- 要是**只选出一个**下载器，直接用它。
- 要是选出好几个、又不全是 ffmpeg——**返回 `None`**。注意，这不是报错。它的意思是"没有单一下载器能整体拿下这件事"，交还给编排器上层去走另一条路：分别下载两条流，再交给后处理阶段合并。

这条 `None` 的退路很重要：它说明"边下边合并"并不是唯一选择，走不通时系统会平滑退化成"分别下、后处理合"。

## 动手演一遍：一个迷你分派器

下面这段 TS 把上面所有机制压在一起：字段驱动、`+` 拆分合并、外部下载器自荐、能力探测、基类公共流程委托钩子。真实的网络/子进程/限速/.part 工程细节都剥掉了，只留"查表 + 能力探测 + 公共流程委托子类"这条主干。

```ts
// demo.ts —— 迷你下载分派器：字段驱动 + 能力自荐
// 跑法：bun run demo.ts   或   npx tsx demo.ts
// 配 package.json: { "scripts": { "start": "tsx demo.ts" }, "devDependencies": { "tsx": "^4" } }

type Info = {
  url: string
  protocol?: string
  is_live?: boolean
  to_stdout?: boolean
  impersonate?: unknown
}

// 模拟"可执行文件装没装"——现实里靠 PATH 探测，这里直接给答案
const INSTALLED = new Set(['aria2c', 'ffmpeg'])
const installed = (exe: string) => INSTALLED.has(exe)
const exists = (_f: string) => false   // 演示里假装目标文件都不在

// ① 下载器基类：吸收横切流程，只给子类留 real_download 一个钩子
abstract class FileDownloader {
  constructor(public params: Record<string, unknown> = {}) {}
  protected hooks: Array<(s: Record<string, unknown>) => void> = []
  addProgressHook(fn: (s: Record<string, unknown>) => void) { this.hooks.push(fn) }

  download(filename: string, info: Info): boolean {
    if (this.params.continuedl && exists(filename)) {       // 横切：已存在就跳过
      console.log(`  [skip] ${filename} 已存在`); return true
    }
    const ok = this.real_download(filename, info)            // 真正干活，交给子类
    this.hooks.forEach(h => h({ status: 'finished', filename }))
    return ok
  }
  abstract real_download(filename: string, info: Info): boolean
}

// ② 协议字段怎么算：信提取器填好的，否则按 URL 兜底
function determineProtocol(info: Info): string {
  if (info.protocol) return info.protocol
  if (info.url.startsWith('rtmp')) return 'rtmp'
  const ext = info.url.split('.').pop()!
  if (ext === 'm3u8') return info.is_live ? 'm3u8' : 'm3u8_native'  // 直播/点播分家
  if (ext === 'f4m') return 'f4m'
  return info.url.split(':')[0]                                      // 退回 scheme
}

// ③ 几个原生下载器（进程内）
class HttpFD extends FileDownloader {
  real_download(_f: string, i: Info) { console.log(`  [http] 进程内拉取 ${i.url}`); return true }
}
class HlsFD extends FileDownloader {
  real_download(_f: string, i: Info) { console.log(`  [hls] 进程内逐片解析 ${i.url}`); return true }
}
class RtmpFD extends FileDownloader {
  real_download(_f: string, i: Info) { console.log(`  [rtmp] 进程内握手 ${i.url}`); return true }
}

// ④ 外部下载器基类：自己声明能力、自己探测在不在、自己翻命令行
class ExternalFD extends FileDownloader {
  static SUPPORTED_PROTOCOLS = ['http', 'https']
  static MULTIPLE_FORMATS = false
  static EXE = ''
  static available() { return installed(this.EXE) }
  static supports(info: Info) {
    const proto = info.protocol!
    return (!info.to_stdout)                                          // 不输出到 stdout？
      && (!proto.includes('+') || this.MULTIPLE_FORMATS)              // 多协议只有 ffmpeg 能整？
      && proto.split('+').every(p => this.SUPPORTED_PROTOCOLS.includes(p))  // 协议都在我清单里？
  }
  static canDownload(info: Info) { return this.available() && this.supports(info) }
  real_download(f: string, i: Info): boolean {
    const cmd = this.makeCmd(f, i)
    console.log(`  [${(this.constructor as typeof ExternalFD).EXE}] 子进程: ${cmd.join(' ')}`)
    return true
  }
  makeCmd(_f: string, _i: Info): string[] { return [] }
}
class Aria2cFD extends ExternalFD {
  static EXE = 'aria2c'
  static SUPPORTED_PROTOCOLS = ['http', 'https', 'ftp']
  makeCmd(f: string, i: Info) { return ['aria2c', '-x16', '-o', f, i.url] }
}
class FFmpegFD extends ExternalFD {
  static EXE = 'ffmpeg'
  static SUPPORTED_PROTOCOLS = ['http', 'https', 'm3u8', 'm3u8_native', 'rtmp']
  static MULTIPLE_FORMATS = true
  static canMergeFormats = true
  makeCmd(f: string, i: Info) { return ['ffmpeg', '-i', i.url, '-c', 'copy', f] }
}

// ⑤ 外部下载器发现表（真实代码里靠"类名以 FD 结尾"自动扫出来）
const EXTERNAL_BY_NAME: Record<string, typeof ExternalFD> = { aria2c: Aria2cFD, ffmpeg: FFmpegFD }

// ⑥ 协议 → 原生下载器的分派表
const PROTOCOL_MAP: Record<string, typeof FileDownloader> = {
  rtmp: RtmpFD, m3u8_native: HlsFD, m3u8: FFmpegFD, f4m: FFmpegFD,
  http: HttpFD, https: HttpFD,
}

// ⑦ 选合适的下载器：算字段 → 按 + 拆 → 逐个查表/问外部 → 合并决策
function getSuitableDownloader(info: Info, params: Record<string, unknown> = {}) {
  info.protocol = determineProtocol(info)
  const protocols = info.protocol.split('+')
  const picks = protocols.map(p => pickOne(info, p, params))
  if (picks.every(c => c === FFmpegFD) && FFmpegFD.canMergeFormats) return FFmpegFD  // 全是 ffmpeg → 边下边合
  if (picks.length === 1) return picks[0]
  return null   // 多协议又没法合并 → 没有单一下载器能整体拿下
}
function pickOne(info: Info, proto: string, params: Record<string, unknown>) {
  const ext = params.external_downloader as string | undefined
  if (ext && ext !== 'native' && !info.impersonate) {           // impersonate 时禁用外部(它不改 TLS 指纹)
    const ed = EXTERNAL_BY_NAME[ext]
    if (ed?.canDownload({ ...info, protocol: proto })) return ed  // 自荐成功就接管
  }
  return PROTOCOL_MAP[proto] ?? HttpFD                            // 查不到退回通用 http
}

// ⑧ 跑几条轨迹
function run(label: string, info: Info, params: Record<string, unknown> = {}) {
  console.log(`\n=== ${label} ===`)
  const proto = info.protocol ?? determineProtocol(info)
  console.log(`字段 protocol = ${proto}`)
  const Cls = getSuitableDownloader(info, params)
  if (!Cls) { console.log('  → 没有单一下载器能搞定，交还上层分别下'); return }
  console.log(`→ 选中 ${Cls.name}`)
  new Cls(params).download('out.mp4', info)
}

run('普通 https 直链', { url: 'https://cdn.site/v.mp4' })
run('点播 HLS（m3u8 非直播）', { url: 'https://cdn.site/master.m3u8', is_live: false })
run('直播 HLS（同一个 m3u8，但 is_live）', { url: 'https://cdn.site/live.m3u8', is_live: true })
run('双流让 ffmpeg 边下边合', { url: 'https://cdn/site/v', protocol: 'https+https' }, { external_downloader: 'ffmpeg' })
run('用户指定 aria2c 拉 https', { url: 'https://cdn.site/v.mp4' }, { external_downloader: 'aria2c' })
```

跑出来的轨迹，恰好把几种决策路径都点亮了：

```
=== 普通 https 直链 ===
字段 protocol = https
→ 选中 HttpFD
  [http] 进程内拉取 https://cdn.site/v.mp4

=== 点播 HLS（m3u8 非直播）===
字段 protocol = m3u8_native
→ 选中 HlsFD
  [hls] 进程内逐片解析 https://cdn.site/master.m3u8

=== 直播 HLS（同一个 m3u8，但 is_live）===
字段 protocol = m3u8
→ 选中 FFmpegFD
  [ffmpeg] 子进程: ffmpeg -i https://cdn.site/live.m3u8 -c copy out.mp4

=== 双流让 ffmpeg 边下边合 ===
字段 protocol = https+https
→ 选中 FFmpegFD
  [ffmpeg] 子进程: ffmpeg -i https://cdn/site/v -c copy out.mp4

=== 用户指定 aria2c 拉 https ===
字段 protocol = https
→ 选中 Aria2cFD
  [aria2c] 子进程: aria2c -x16 -o out.mp4 https://cdn.site/v.mp4
```

第二、第三条轨迹对照看最有意思：**同一个 `.m3u8`，就因为 `is_live` 不同，算出的协议字段不同，最终落到完全不同的下载器上**。这正是"字段驱动"的精髓——决定用什么下载器的，是数据里的标签，不是 URL 的长相。最后一条轨迹则演了外部下载器的自荐：用户配了 aria2c，它 `available`（装了）且 `supports`（https 在清单里）都通过，于是接管，把字典翻成了 `-x16 -o ...` 这套它自己的命令行。

## 关键权衡

这一章机制密集，四条权衡逐个说清"为什么这么设计"。

**权衡 1（全章核心）：用数据里的协议字段驱动策略选择。**
选择是把"用什么下载器"从编排器下沉到数据自身（一个协议字段），再用一张分派表把字段翻译成下载器类。换来的是编排器对下载细节彻底无感——它只调一句"给我合适的下载器"，新增一种协议时编排器一行都不用改，加一行表、写个新类即可。**代价是**：协议字段表达不了的现实特例，全部堆积进同一个分派函数，长成一片裸的 `if`：要按时间区间裁剪（`section_start/section_end`）且 ffmpeg 可下 → 强制 FFmpeg；`m3u8` 直播 → FFmpeg；`hls_prefer_native` 真/假 → 在原生 HlsFD 和 FFmpeg 之间切换；`http_dash_segments` 直播 → FFmpeg。这些分支没有任何对象模型，每多一种特例就长一截，可读性随协议增多持续劣化。说白了：字段驱动很优雅，但现实永远比一个标签复杂，多出来的复杂度总要有个出口，而这个出口退化成了条件分支海洋。**这是字段驱动换来的最痛的代价。**

**权衡 2：外部可执行下载器和原生下载器共用一套抽象。**
选择是让 aria2c/ffmpeg/curl/wget 这些"调子进程拉文件"的工具，和"进程内下载"的原生下载器对外暴露同一个 `download()` 接口。换来的是编排器无差别对待这两类——`--downloader aria2c` 一个开关整体换引擎，调用代码一个字都不用改。**代价是**：每个外部工具都得有人把那个胖信息字典翻译成它认识的命令行参数——curl 用 `--header`、aria2c 用 `--header`、wget 用 `--header`，连限速旋钮都各是各的写法（curl 是 `--limit-rate`，wget 是 `--limit-rate`，aria2c 是 `--max-overall-download-limit`），每个工具一套适配（`_make_cmd`）。而且它们得自己负责探测"我装了吗"和"这个活我能接吗"，不然就会被错误启用或永远没机会上场。

**权衡 3：把"我能下吗"做成下载器自报能力。**
选择是不让分派方去替下载器判断合不合适，而是让每个下载器自己声明能耐（支持哪些协议、哪些特性），分派方逐个问，谁说能就用谁。换来的是多个后端可插拔、能优雅降级到下一个候选。（这套"能力探测 + 候选择优"和第 1 章传输层同构，那里已展开，不重复。）**代价是**：每个下载器都必须老实、完整地声明自己的能力边界——`supports` 那四项自检里漏掉一项，要么被错误启用（声明能下其实下不了，运行时才崩），要么永远没机会上场（明明能下却没声明）。能力清单和真实能力之间一旦出现缝隙，bug 就藏在那道缝里。

**权衡 4：把所有横切关注点收进下载器基类。**
选择是把限速、断点续传、临时 `.part` 文件、文件访问重试、进度钩子、多行进度条这些和协议无关、但对每个下载器都要做的事，全塞进 `FileDownloader` 基类（"基类吸收样板、子类填一个钩子"这个分工思想第 4 章已讲透，这里只看落地）。换来的是每个具体下载器子类只需实现"真正把字节写下来"这一个方法，几十行就够。**代价是**基类越长越胖、成一个什么都管的大家伙；更隐蔽的是——基类和子类之间靠一个巨大的 `params` 选项字典做隐式耦合，子类直接 `self.params.get('ratelimit')` 这样取参数，没有任何编译期契约，哪个参数谁用、什么时候用、取不到默认成什么，全靠人脑和注释。这个隐式字典是抽象基类换来的、独属于下载器这一侧的额外成本。

## 小结

这一章的核心就一句话：**让数据自带"我该被怎么下载"的协议标签，再用一张分派表把标签翻译成下载器**——编排器因此对下载细节彻底无感，新增协议零侵入。围绕这条主线，我们看到了一张 `PROTOCOL_MAP` 怎么把协议字段映射到下载器类、外部下载器怎么靠能力自荐和子进程适配混进同一套抽象、多协议的 `+` 怎么拆开逐个查再决定合并、以及基类怎么把所有横切杂活揽下来只给子类留一个 `real_download` 钩子。而这一切优雅的代价，是分派函数里那片消化不掉的特例条件分支。

最后留一个扣子：前面提到外部下载器其实继承自一个叫 `FragmentFD` 的类，而不是直接继承 `FileDownloader`——也就是说它们天生带着一条"分片路径"。当目标是 HLS/DASH 这种一长串小切片时，下载不是一口气拉完，而是拆成一片一片、每片独立重试、还能断点续传。这条分片机制，正是下一章《分片化下载：把长流拆成可恢复的工作单元》要讲透的东西。
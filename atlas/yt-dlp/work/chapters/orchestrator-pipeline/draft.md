# YoutubeDL 编排器：贯穿各阶段的 info_dict 主管线

> 本章属于 system 层。前置：info_dict 数据总线与提取器骨架、协议字段驱动的下载策略分派、声明式后处理流水线与链式 info 变换、格式选择 DSL、输出模板引擎、可插拔传输层、统一 cookiejar。
> 学完你能：用一句话说清"为什么 yt-dlp 把整条下载流水线收束成一个胖协调器，换来了什么、付出了什么"。

## 1. 为什么需要它

上一章把登录态从浏览器密钥环里解密出来，收束到一个统一的 cookiejar——登录态这件事办成了。再往前几章，格式选择被压成 DSL、后处理拼成声明式链、下载器按协议字段自己分派、请求引擎按能力竞争上岗。每一块都已经能独立工作，但它们之间还差一个"指挥"——本章讲的就是把这条完整流水线收束成一个对象的那层设计。

想象你给了 yt-dlp 一个 URL。这个 URL 可能直接指向一个视频；可能是一个播放列表，里面每条又是另一个 URL；列表里某个条目可能是一个嵌入页，得再跟进一次才能拿到真视频。用户还要同时下视频和音频两种格式、裁两段时间段、下完合并再嵌字幕、转码、写元数据。

如果没有一个统一的中枢，结果就是：提取器为了拿播放列表里每条的真视频，得自己写"再跟进一次"的代码；下载器为了知道是不是多格式，得自己读用户配置；后处理器为了知道有没有合并需求，得提前和下载器商量。每个插件都在跟其它插件互相打听，状态在函数间乱飞。

需要一个对象来做三件事：第一，决定"这个半解析结果下一步走哪条路"；第二，把同一个描述字典（`info_dict`）在阶段间传递，让每个阶段对它做纯变换；第三，全局唯一地持有所有插件都要用的基础设施——登录态、请求引擎、去重归档、进度回调、重试策略。

这个对象就是 `YoutubeDL`。

## 2. 核心思想

整套流水线被建模成一件简单的事：**对一个字典的递归分派 + 阶段化纯变换**，由一个**独占所有横切基础设施的胖协调器**把各阶段串起来。

类比送快递：每个分拣员不关心包裹最终送到哪，只看包裹上的标签（`_type`）决定下一步交给谁——是不是要再分拣一次、是不是要拆成几个子包裹、是不是可以直接装车。所有分拣员共用同一个调度中心查地图、看车牌、记已送达地址，但调度中心不替分拣员决定怎么处理包裹，只把"该到哪一站"这件事统管起来。

## 3. 心智模型

协调器手里有几张表：

- **提取器注册表**：按 key 索引的字典，按数组顺序匹配 URL
- **后处理器分桶表**：按 8 个执行阶段（`pre_process` / `after_filter` / `video` / `before_dl` / `post_process` / `after_move` / `after_video` / `playlist`）分桶挂载
- **四类钩子列表**：进度钩子、后置钩子、后处理器钩子、关闭钩子
- **去重归档**：启动时全量预加载到内存 set
- **几个计数器**：下载返回码、播放列表嵌套层数、已见过的播放列表 URL 集合
- **预编译好的格式选择器**：启动时就编译完，不是首次下载时才编（这样 `-f` 的语法错误能尽早暴露）

下载一条 URL 的主流水线长这样：

```
extract_info(url)            遍历提取器表，找第一个声明"我能处理这个 URL"的
  ↓
__extract_info(url, ie)      [装饰器套住] ie.extract(url) → 拿到带 _type 的字典
  ↓
process_ie_result            按 _type 分派
  ├ url             → 递归回 extract_info
  ├ url_transparent → 先解析内层，再把外层元数据覆盖上去
  ├ playlist        → 给每个子条目叠加上下文，逐条递归
  └ video           → process_video_result
                       ├ 字段清洗 → 过滤
                       ├ 格式选择 → 笛卡尔积（格式 × 时间区间）
                       └ 每个 (格式, 区间) 组合：process_info
                           ├ 写附属文件（字幕、缩略图、描述）
                           ├ 按协议字段选下载器，开下
                           ├ 动态追加合并器/修复器到后处理列表
                           ├ 跑后处理链（动态 + 静态）
                           └ 写归档
```

字典贯穿全程——从提取器到归档，对象身份保持不变。

## 4. 关键权衡

### 4.1 类型标记字段做结果分派，换取提取器只产半成品

提取器不用把活全干完。它只需要返回一个带 `_type` 标记的字典，剩下的事交给协调器：拿到 `playlist` 就展开子条目逐条递归，`url` 就跟进一次，`url_transparent` 就先解析内层再把外层嵌入页的标题等元数据覆盖上去，`video` 才进入下载分支。

**换来**：提取器职责极轻——不必自己把整个播放列表全展开、不必自己跟进嵌套 URL；任意深度的嵌套都统一处理。

**代价**：分派函数 `process_ie_result` 变成一个多分支开关；递归天然带无限循环风险——比如某个播放列表的子条目又指回了它自己。源码靠两个计数兜底：维护 `_playlist_level` 记录当前嵌套层数、维护 `_playlist_urls` 记录当前这一轮已见过的播放列表 URL，发现重复就跳过，`finally` 里层数归零时清空已见集合。

这里化解的**本质矛盾**是"嵌套结构的开放性"和"控制流的有限性"。任何站点的播放列表都可能再嵌套任意深的列表，但运行时的栈与去重必须有限。把"何时停止递归"从提取器（无法知道全局）拿到协调器（手握全局计数）来做，是这个分派的本质骨架——碰到树形/图形嵌套结构时，"在统一入口做防循环记账"是通解。

### 4.2 一个字典贯穿全程，分叉时浅拷贝并主动剥离运行时私有状态

字典对象从提取一路流到后处理，阶段间不重新装箱。只在需要分叉——多格式 × 多时间区间的笛卡尔积——时浅拷贝一份，且拷贝时主动删掉两个运行时私有键：`__postprocessors`（动态追加的 PP 列表）和 `__pending_error`（待决错误）。

**换来**：各阶段函数签名统一（都吃一个字典）、阶段间无需显式传参；外部引用的对象身份在"原地清空再灌入新内容"（`clear()` + `update()`）后仍保持不变——`process_info` 末尾甚至有一条 `assert info_dict is original_infodict` 硬断言，强制保证外部持有的引用仍指向被原地修改的那个对象。

**代价**：字典无编译期 schema，业务字段（`title` / `formats` / `duration`）和 `__` 前缀的运行时私有字段混居，只靠命名约定区分；浅拷贝导致 `formats` 这种嵌套子字典在副本间共享引用，源码注释明说"理想应深拷贝但字典可能含不可深拷对象"而放弃。所以下载循环里改顶层键是安全的，但直接改 `formats[0][...]` 会波及原 info——这是源码明确承认的已知陷阱。

这里化解的**本质矛盾**是"分叉需要独立状态"和"外部引用需要稳定身份"。分叉要拷贝、稳定要不拷贝。解法是分叉时拷贝顶层并丢弃运行时状态、主干用原地替换保证身份不变——这是"流式管线 + 分叉加工"类问题的通用骨架。

### 4.3 静态后处理注册 + 运行时动态追加双轨制

用户配置的后处理器（转码、嵌字幕、写元数据）在协调器初始化时就按 8 个阶段挂到静态表里；而"多格式合并器、容器修复器"这类取决于实际下载情况的后处理器，在下载过程中动态追加到当前字典的 `__postprocessors` 私有列表里。执行时把动态列表拼在静态表前面一起跑：

```python
for pp in (additional_pps or []) + self._pps[key]:
    info = self.run_pp(pp, info)
```

**换来**：声明式的稳定后处理链（用户写的）和运行时按需扩充的修复（检测到多格式才追加合并器、检测到 `m4a_dash` 容器才追加修复器）共存。

**代价**：后处理的最终执行顺序分散在两处——静态注册序 + 运行时追加序，且**动态追加的永远先于用户配置的跑**。这和直觉相反：你以为是用户明说的后处理先跑、然后才是补救的修复；实际恰恰相反，合并和容器修复必须先把"残缺的产物"修成"完整的产物"，用户的转码才能在完整产物上做。调试时必须同时盯两处。

这里化解的**本质矛盾**是"用户声明的稳定管线"和"运行时才能确定的补救需求"。前者需要提前可见、可配置；后者必须等真下载完了才知道。双轨制让两者并存，代价是顺序的隐式性——任何"声明式 + 必须按运行时事实补救"的管线都会撞上这个权衡。

### 4.4 协调器独占所有横切关注点（门面模式）

登录态（cookiejar）、代理、请求引擎（request_director）、去重归档、四类钩子、格式选择器编译，全部由这一个协调器对象持有。提取器、下载器、后处理器通过注册时被反向塞回协调器引用（`ie.set_downloader(self)`），从这里取用基础设施——比如提取器要发请求时调 `self._downloader.urlopen`，而不是自己持有一个 session。

**换来**：插件只需写自己的核心逻辑；所有底座（发请求、读 cookie、记归档、报进度）从协调器取用；插件之间零耦合。横切资源还设计成 `cached_property` 懒加载，避免构造协调器时就强制触发可能失败的浏览器 cookie 解密，把错误延迟到真正发请求那一刻。

**代价**：协调器沦为数千行、状态与职责高度集中的上帝对象。`YoutubeDL.py` 单文件超过 4000 行，构造函数 `__init__` 一口气建好七八张表、十几个计数器、四套钩子，谁都依赖它、它什么都管。任何重构都得先扛住它的体重。

这里化解的**本质矛盾**是"插件之间的解耦"和"共享基础设施的统一"。插件想彼此无感，但又都得用同一套 cookie、同一套代理、同一套进度回调。把基础设施收束到唯一一个对象手里，是绕不开的解——也是这套设计最显著的代价来源。

### 4.5 装饰器圈出统一的容错/重试边界

策略很集中：直播等待和重新提取走循环重试，可预期的提取错误走告警，按用户容错策略决定吞掉还是上抛。这套策略集中写在一个装饰器 `_handle_extraction_exceptions` 里，只套在真正发起提取的少数内层方法上：

```python
while True:
    try:
        return func(self, *args, **kwargs)
    except ReExtractInfo as e:
        continue                          # 重新提取循环（直播等待/重试的灵魂）
    except GeoRestrictedError as e: ...
    except ExtractorError as e: self.report_error(...)
    break
```

**换来**：提取阶段的容错策略只写一次；被装饰的方法本身只写正常路径，不用每个分支都考虑"要不要重试"。

**代价**：控制流被装饰器隐式化——从调用点 `extract_info(url)` 看不出来这次提取其实可能被自动重试若干次，那个隐藏的 `while True` 把"等直播开播"和"重新解析"都吞进去了。读到 `extract_info` 的代码想当然认为它一次成功，遇到直播场景调试时才会发现循环藏在装饰器里。

这里化解的**本质矛盾**是"业务代码的线性可读"和"网络场景的反复重试需求"。业务想看到的是直线流程，但真实下载场景必须支持直播等待、瞬时失败重试。把"反复重试"包进装饰器、让业务只看直线，是循环重试问题的通解骨架——也解释了为什么这层装饰器只套在内层方法而不是整条流水线上（外层套了反而会让所有阶段都隐式重试，更难追）。

## 5. 最小原理演示

下面这段几十行的 TS 演示，刻意只演透五件事：类型标记字段分派、递归展开、字典贯穿、分叉时拷贝剥离运行时状态、动静态后处理合并。其余样板（格式 DSL 解析、下载限速、ffmpeg 调用、cookie 解密）一律不演示。

```ts
type Type = 'video' | 'url' | 'url_transparent' | 'playlist';

// 描述字典：业务字段 + 两个下划线开头的运行时私有键
type Info = {
  _type: Type;
  url?: string;
  entries?: Info[];
  formats?: { protocol: string; format_id: string }[];
  title?: string;
  __pps?: PP[];           // 动态追加的后处理器
  __pendingErr?: string;   // 待决错误
};

type PP = (info: Info) => Info;
const mergerPP: PP = (info) => info;   // 桩：合并多格式

// 协调器独占所有横切基础设施，插件从这里取用
interface Orchestrator {
  ies: { suitable: (url: string) => boolean; extract: (url: string) => Info }[];
  formatSelector: (formats: Info['formats']) => Info['formats'][];
  pickDownloader: (fmt: Info['formats'][0]) => { download: (i: Info) => void };
  staticPPs: PP[];            // 用户声明、初始化时挂的静态 PP
  archive: Set<string>;        // 去重归档
}

// 容错装饰器：把可重试错误转成循环，业务方法只写正常路径
function withRetry<T>(fn: () => T): T | undefined {
  while (true) {
    try { return fn(); }
    catch (e: any) {
      if (e?.retry) continue;       // 重新提取循环
      console.warn('extract failed:', e?.message);
      return undefined;
    }
  }
}

// 入口：遍历提取器表找匹配的
function extract(ydl: Orchestrator, url: string): Info | undefined {
  return withRetry(() => {
    const ie = ydl.ies.find(h => h.suitable(url));
    if (!ie) throw new Error('no suitable extractor');
    return ie.extract(url);
  });
}

// 分派器：按 _type 决定下一步，半成品一律递归回入口
function processResult(ydl: Orchestrator, r: Info): Info | Info[] | undefined {
  switch (r._type) {
    case 'url':
      // 半成品：递归回入口
      return r.url ? processResult(ydl, extract(ydl, r.url)!) : undefined;

    case 'url_transparent': {
      // 先解析内层真视频，再把外层嵌入页的元数据覆盖上去
      const inner = r.url ? extract(ydl, r.url)! : r;
      const innerProcessed = processResult(ydl, inner) as Info;
      return processResult(ydl, {
        ...innerProcessed, ...r,
        _type: innerProcessed._type, url: innerProcessed.url,
      });
    }

    case 'playlist':
      // 上下文叠加到每个子条目、逐条递归
      return r.entries!.map(e => processResult(ydl, { ...e, title: e.title ?? r.title }));

    case 'video':
      return downloadVideo(ydl, r);
  }
}

// 分叉时剥离运行时私有状态，业务字段带过去
function fork(info: Info): Info {
  const { __pps, __pendingErr, ...rest } = info;
  return { ...rest };
}

function downloadVideo(ydl: Orchestrator, info: Info): Info {
  const picked = ydl.formatSelector(info.formats!);
  for (const fmt of picked) {
    const copy = fork(info);                  // 分叉
    copy.formats = [fmt];
    const fd = ydl.pickDownloader(fmt);       // 协议字段选下载器
    fd.download(copy);
    if (picked.length > 1) {
      (info.__pps ??= []).push(mergerPP);     // 多格式 → 动态追加合并器
    }
  }
  // 动态追加的先跑，用户挂的静态后跑
  for (const pp of [...(info.__pps ?? []), ...ydl.staticPPs]) info = pp(info);
  ydl.archive.add(info.title!);               // 归档
  return info;
}
```

实际源码里，这段逻辑分散在 `extract_info` / `process_ie_result` / `process_video_result` / `process_info` / `run_all_pps` 五个方法、合计数百行——上面的几十行是它的骨架投影。

## 6. 执行轨迹

给协调器一个播放列表 URL，里面有两个条目：条目 A 是普通视频、条目 B 是一个 `url_transparent`（嵌入页，真视频在另一个站点）。看看上面那套机制怎么走。

**第 1 步 · 入口分派**：`extract_info(playlist_url)` 遍历提取器表，命中播放列表提取器 `PlaylistIE`，调它的 `extract()` 拿到 `{ _type: 'playlist', entries: [A, B], title: '歌单' }`。进入 `process_ie_result`，分派键是 `'playlist'`。

**第 2 步 · 防循环记账**：进入 playlist 分支前，`_playlist_level` 从 0 加到 1，`playlist_url` 加入 `_playlist_urls`。

**第 3 步 · 子条目上下文叠加**：用 `ChainMap` 把 `{ playlist: '歌单', playlist_index: 1 }` 叠到 A 上、把 `{ playlist: '歌单', playlist_index: 2 }` 叠到 B 上，逐条递归。

**第 4 步 · 条目 A（普通视频）**：A 的 `_type` 是 `'video'`。进入 `process_video_result`：清洗字段、跑 `'pre_process'` 和 `'after_filter'`、用预编译好的格式选择器对 `A.formats` 求值，选出 1 个格式。笛卡尔积只有 `(fmt1, 全长)` 一项，`fork(A)` 剥离运行时私有键、跑 `process_info`：写缩略图、按协议字段选 `HttpFD` 下载、跑后处理（这里没动态 PP，只跑用户挂的静态 PP）、写归档。

**第 5 步 · 条目 B（透明转发）**：B 的 `_type` 是 `'url_transparent'`。先 `extract_info(B.url, process=False)` 拿到内层真视频 info，把 B 外层的非豁免字段（标题、缩略图等）覆盖到内层上，再递归分派。内层是个 `'video'`，所以走第 4 步同样的流程，但标题用的是 B 覆盖后的标题。

**第 6 步 · 多格式动态追加**：假设 A 用户配的格式选择器选出了 2 个格式（视频 + 音频）。下载循环跑两轮：先下视频到 `f{format_id}` 临时文件、再下音频到另一个 `f{format_id}` 临时文件；下载过程中检测到 `requested_formats.length > 1`，把 `FFmpegMergerPP` 实例 `append` 到 `A.__postprocessors`。下载完后 `fixup()` 看下载器名是 `hlsnative` 又把 `FFmpegFixupM4aPP` 追加进同一列表。

**第 7 步 · 动静态后处理合并**：跑 `run_all_pps('post_process', additional=A.__postprocessors)`。先跑动态追加的（合并 → 修复 m4a）、再跑静态挂的（用户配的转码、嵌字幕），顺序符合"先修完整再加工"。

**第 8 步 · 收尾**：`MoveFilesAfterDownloadPP` 把临时文件移到最终位置、跑 `'after_move'`、`_playlist_level` 从 1 减到 0、`finally` 清空 `_playlist_urls`。归档里多了两条记录：`ExtractorKey A.id` 和 `ExtractorKey B.innerVideoId`。

整条轨迹演透的四件事：递归展开（playlist → A、B）、透明转发（B 覆盖到内层）、分叉拷贝剥离（多格式分叉时 `__pps` 清零）、动静态后处理（合并先跑、用户挂的转码后跑）。

## 7. 教学简化说明

本章演示故意省略了：真实提取器的样板代码（`_download_webpage` / `_search_regex` / geo 假 IP 重试）、格式选择 DSL 的词法分析与 AST 求值、下载器的限速/断点续传/分片并发、后处理器里具体的 ffmpeg 调用、cookie 解密路径、请求引擎竞争、错误翻译表、交互式格式选择（`-` 选择器）、`--load-info-json` 回退重下、各种 `compat_opts` 兼容垫片——这些都是前置章或下游章的内容。

演示代码用 TS 写只是为了把"分派 + 递归 + 字典流转"这套控制流和数据流写干净。这套机制没有任何 Python 特有的语义依赖（递归与字典流转在 TS 里同样成立），原仓库用 Python 实现纯粹因为它是 yt-dlp 的主语言。

## 8. 小结

`YoutubeDL` 把"下载一个 URL"压成了一个胖协调器：一个 `_type` 字段决定下一步走哪条路，同一个字典贯穿全程，所有横切基础设施都被它独占——插件要用底座都得回头找它。

代价也直接：4000 多行的单文件、控制流藏在装饰器里、后处理顺序要同时盯两处。下一章讲 CLI 层怎么把巨大的命令行表面压成一个 `ydl_opts` 字典、再喂给这个胖协调器。
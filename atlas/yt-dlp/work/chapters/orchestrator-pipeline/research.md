# YouTubeDL 编排器：贯穿各阶段的 info_dict 主管线 · 源码精读

## 给 Writer 的教学钩子（必填，8 子项缺一不可）

- **用户痛点 / 场景**：给一个 URL，它可能指向单个视频，也可能指向一个播放列表，而播放列表里的每个条目又可能是一个"还要再解析一次才能拿到真视频"的中间 URL；用户还要能同时下多个格式、裁剪多个时间段、下完自动转码嵌字幕。如果没有一个统一的协调者，这几层嵌套的"解析→选格式→下载→后处理"会散落成一团互相调用、状态乱飞的代码。本章讲的就是把这条完整流水线收束成一个对象的那层设计。

- **一句话核心思想**：把"下载一个 URL"建模成**对一个字典的递归分派 + 阶段化纯变换**，再让一个**独占所有横切基础设施的胖协调器**把各阶段串起来。

- **设计动机（为什么需要它）**：提取器只能给出"半解析"结果（一个待跟进的 URL、一个尚未展开的播放列表、或一个完整视频），下载策略要按结果里的协议字段选，后处理要按用户配置和实际下载情况拼装——这些阶段各自由独立插件承担（提取器/下载器/后处理器都是可插拔的）。需要一个中枢来：决定"这个半解析结果下一步走哪条路"、把同一个描述字典在阶段间传递、并在全局唯一地持有那些所有插件都要用的基础设施（登录态、请求引擎、去重归档、进度回调、重试策略）。
  - **承前去重信号**：描述字典本身作为"万能数据总线"已在「info_dict 数据总线与提取器骨架」章讲透，本章**不重讲总线 schema**，只看总线在阶段间**如何流动、分叉时如何拷贝并剥离运行时私有状态**；选格式 DSL（「格式选择 DSL」章）、输出模板（「输出模板引擎」章）、协议驱动选下载器（「协议字段驱动的下载策略分派」章）、声明式后处理链（「声明式后处理流水线」章）、请求引擎竞争（「可插拔传输层」章）、登录态解密（「统一 cookiejar」章）**均已在前置章作为核心权衡讲透**，本章只看协调器**在什么时机调用它们、用什么数据把它们缝合成一条管线**，不再重述各机制内部原理。

- **关键权衡（本章核心；5 条）**：
  1. **用一个类型标记字段做结果分派 + 递归展开**：做了"提取器只返回一个带类型标记的半成品字典（视频／待跟进 URL／透明转发 URL／播放列表／旧式列表），由协调器按标记决定下一步，URL 与播放列表类一律递归回入口继续解析"的选择 → 换来提取器职责极轻（不必自己把播放列表全展开、不必自己跟进嵌套 URL）、任意嵌套深度统一处理 → 代价是分派函数变成一个多分支开关，且递归天然带无限循环风险，必须额外维护"当前播放列表嵌套层数 + 已见播放列表 URL 集合"做兜底。
  2. **同一个描述字典贯穿全程 + 分叉时浅拷贝并剥离运行时状态**：做了"一个字典对象从提取一路流到后处理，阶段间不重新装箱；只在需要分叉（多格式 × 多时间区间）时浅拷贝一份，且拷贝时主动删掉两个运行时私有键（动态后处理列表、待决错误）"的选择 → 换来各阶段函数签名统一（都吃一个字典）、阶段间无需显式传参、外部引用的对象身份在"原地清空再灌入新内容"后仍保持不变 → 代价是字典无编译期 schema、业务字段与 `__` 前缀的运行时私有字段混居仅靠命名约定区分，且浅拷贝导致嵌套子字典仍共享引用（这是源码注释明确承认的已知陷阱）。
  3. **静态后处理注册 + 运行时动态追加双轨制**：做了"用户配置的后处理器在初始化时按 8 个阶段挂到静态表里；而'多格式合并器、容器修复器'这类取决于实际下载情况的后处理器，在下载过程中动态追加到当前字典的一个私有列表里；执行时把动态列表拼在静态表前面一起跑"的选择 → 换来"声明式可配置的稳定后处理链"与"运行时按需扩充（检测到多格式才合并、检测到特定容器才修复）"共存 → 代价是后处理的最终执行顺序分散在两处（静态注册序 + 运行时追加序），且动态追加的永远先于用户配置的跑，调试时须同时盯两处。
  4. **协调器独占所有横切关注点（门面模式）**：做了"登录态、代理、请求引擎、去重归档、四类钩子、格式选择器编译，全部由这一个协调器对象持有；提取器/下载器/后处理器通过被反向塞回协调器引用，从这里取用基础设施"的选择 → 换来插件只需写自己的核心逻辑、所有底座（发请求、读 cookie、记归档、报进度）从协调器取用、插件间零耦合 → 代价是协调器沦为数千行、状态与职责高度集中的上帝对象（这是本章最显著的代价）。
  5. **用装饰器圈出统一的容错/重试边界**：做了"把'直播等待／重新提取'变成循环重试、把可预期提取错误变成告警、按用户容错策略决定吞掉还是上抛——这套策略集中写在一个装饰器里，只套在真正发起提取的少数内层方法上"的选择 → 换来提取阶段的容错策略只写一次、被装饰的方法本身只写正常路径 → 代价是控制流被装饰器隐式化（一个隐藏的 `while True` 重试循环），从调用点看不出来某次提取其实可能被自动重试若干次。

- **最小心智模型（3～7 步）**：
  1. 入口拿到 URL，遍历已注册的提取器集合，找到第一个声明"我能处理这个 URL"的（找不到则报错）。
  2. 调该提取器，得到一个带类型标记的描述字典（可能是完整视频、待跟进 URL、透明转发 URL、播放列表、旧式列表之一）。
  3. 结果分派器按类型标记分流：URL/透明转发 → 递归回入口继续解析（透明转发会把外层元数据覆盖到内层结果上再分派）；播放列表 → 把"播放列表上下文"用映射叠加到每个子条目、逐条递归，结束后跑一遍播放列表级后处理。
  4. 对视频结果：清洗规整字段、跑前置过滤、用预编译的格式选择器对 formats 求值，再把"选中的格式 × 用户要的时间区间"做笛卡尔积，每个组合拷贝一份字典。
  5. 对每个副本：算最终文件名、写附属文件（描述/字幕/缩略图/元数据/快捷方式）、按协议字段选出下载器开下；若是多格式则分别下到带格式 id 的临时文件，并把"合并器"追加进后处理列表。
  6. 下载后按下载器类型决定追加哪些"容器修复器"，再跑后处理链（静态注册的 + 运行时追加的合并），移动临时文件到最终位置，跑收尾后处理。
  7. 标记"可归档"、触发用户后置钩子；全过程错误统一进容错边界，直播/重试场景转成"重新提取"循环。

- **最小原理演示（替代旧"复刻范围"）**：
  - **应演示**：一个几十行的极简编排器，演透"类型标记字段分派 + 递归展开 + 描述字典贯穿全程 + 分叉时拷贝剥离运行时状态"这四件事。骨架（TS）：
    ```ts
    type Info = { _type: 'video'|'url'|'url_transparent'|'playlist'; url?: string; entries?: Info[]; title?: string; formats?: any[]; __pps?: any[]; __pendingErr?: string };
    // 1) 入口：找 handler → 拿到带 _type 的半成品
    function extract(ydl: Orchestrator, url: string): Info {
      const ie = ydl.ies.find(h => h.suitable(url))!;
      return ie.extract(url);                         // 提取器只给半成品
    }
    // 2) 分派器：按 _type 递归展开（权衡1的灵魂）
    function processResult(ydl: Orchestrator, r: Info): Info {
      switch (r._type) {
        case 'url':            return processResult(ydl, extract(ydl, r.url!));        // 递归回入口
        case 'url_transparent':{ const inner = processResult(ydl, extract(ydl, r.url!));
                                 return { ...inner, ...stripExempt(r) }; }             // 外层元数据覆盖
        case 'playlist':       return r.entries!.map(e => processResult(ydl, e));      // 逐条递归
        case 'video':          return downloadVideo(ydl, r);
      }
    }
    // 3) 分叉时拷贝并剥离运行时私有状态（权衡2的灵魂）
    function copy(info: Info): Info { const { __pps, __pendingErr, ...rest } = info; return { ...rest }; }
    function downloadVideo(ydl: Orchestrator, info: Info) {
      const picked = ydl.formatSelector(info.formats!);
      for (const fmt of picked) {                      // 格式 × 区间 笛卡尔积
        const fork = copy(info); fork.formats = [fmt];
        const fd = ydl.pickDownloader(fmt);            // 协议字段选下载器（权衡4：从协调器取底座）
        fd.download(fork);
        if (picked.length > 1) (info.__pps ??= []).push(mergerPP);  // 动态追加（权衡3）
      }
      runPPs([...(info.__pps ?? []), ...ydl.staticPPs.post], info); // 动态+静态合并（权衡3）
      ydl.archive.add(idOf(info));                     // 归档（权衡4）
    }
    ```
  - **应故意省略**：真实提取器样板、格式选择 DSL 的词法分析、下载器的限速/断点/分片、后处理器的具体 ffmpeg 调用、cookie 解密、请求引擎竞争、错误翻译表、交互式确认、文件名模板引擎——这些都是前置章或下游章的内容，演示只保留"分派 + 递归 + 字典流转 + 拷贝剥离 + 动静态后处理合并 + 归档"这六个原理点。
  - **演示载体建议**：**首选 TS/JS**。本章核心是控制流（递归分派）与数据流（字典贯穿/拷贝），TS 的字典字面量 + 联合类型标记 + 解构剥离正好能干净表达，配最小 `package.json` 即可 `bun run`/`node` 跑。**为何不用原仓库语言 Python**：此处机制无任何 Python 特有语义依赖（无描述符/元类/生成器协议的强依赖——递归与字典流转在 TS 里同样成立），退回 Python 反而增加读者跑通成本。每个提取器/下载器/后处理器用 `() => Info` 或桩对象注入即可演示完整轨迹。

- **正文不宜展开的细节**：交互式格式选择（`-` 选择器 + input 循环）、`--load-info-json` 的回退重下路径、`compat_list`/`compat_opts` 等向后兼容分支、basic_auth 从 URL 抽取、fixup 策略的 6 种下载器×容器组合细则、`wait_for_video` 的轮询时序计算、bidi/VT 终端模式、颜色策略——这些供 Writer 裁剪或放脚注，不进主线。

- **推荐的一个执行轨迹例子**：输入一个播放列表 URL（含 2 个条目，条目 A 是普通视频、条目 B 是 `url_transparent` 指向另一个站点的真视频）→ 入口匹配到播放列表提取器 → 分派器走 `playlist` 分支 → 把 `{playlist, playlist_index}` 叠到 A、B 上逐条递归 → A 走 `video` 选出 1 个格式直接下；B 走 `url_transparent`，先递归解析其内层 URL 拿到真视频 info、再把 B 外层的标题等覆盖上去、再走 `video` → 两处下载各自把合并器/修复器按需追加进 `__pps`、跑后处理链、归档 → 播放列表级后处理收尾。这条轨迹一次演透"递归展开 + 透明转发 + 分叉拷贝 + 动静态后处理"四个原理。

> 以上钩子供 Writer 写「动机→核心思想→心智模型→关键权衡→原理演示」；下面事实部分供核对，不要被 Writer 当目录照抄。

## 概念要点

- 协调器的状态由初始化方法集中建立：提取器注册表（按 key 索引的字典 + 实例表）、按"何时执行"分桶的后处理器表（桶名即 8 个阶段）、四类钩子列表（进度/后置/后处理器/关闭）、去重归档（一个内存 set，启动时全量预加载）、计数器（下载返回码、下载数、视频数、播放列表嵌套层、已见播放列表 URL 集合），以及预编译好的格式选择器。 源码位置: yt_dlp/YoutubeDL.py:642-657,815-821,862

- 8 个后处理阶段（按执行先后）：`pre_process, after_filter, video, before_dl, post_process, after_move, after_video, playlist`。 源码位置: yt_dlp/utils/_utils.py:2870

- 入口 `extract_info` 用 `for...else` 遍历 `self._ies`，以 `ie.suitable(url)` 选提取器，并用临时 id 提前查归档（命中可按 `break_on_existing` 中断）；找不到合适提取器时 `else` 分支报错。 源码位置: yt_dlp/YoutubeDL.py:1706-1725

- 容错装饰器 `_handle_extraction_exceptions` 把 `ReExtractInfo` 转成 `continue`（形成重新提取循环，支撑直播等待/重试），把 `GeoRestrictedError`/`ExtractorError` 转成 `report_error` 后 `break`（返回 None），通用异常按 `ignoreerrors` 决定吞或抛。 源码位置: yt_dlp/YoutubeDL.py:1727-1757

- 结果分派器 `process_ie_result` 以 `ie_result.get('_type', 'video')` 为分派键：`url`→递归 `extract_info`；`url_transparent`→先 `extract_info(process=False)` 取内层 info 再用 `filter_dict` 覆盖外层非豁免字段（豁免 `_type/url/ie_key`，非片段时还豁免 `id/extractor/extractor_key`），再递归分派；`video`→`process_video_result`；`playlist`/`multi_video`→`__process_playlist`；`compat_list`→逐条递归。 源码位置: yt_dlp/YoutubeDL.py:1910-2042

- 播放列表防循环：进入 `playlist` 分支时 `_playlist_level += 1`、把 `webpage_url` 加入 `_playlist_urls`，若已见过该 URL 则跳过；`finally` 里层数归零时清空已见集合。 源码位置: yt_dlp/YoutubeDL.py:2002-2021

- 播放列表用 `collections.ChainMap(entry, {**common_info, 'playlist_index':..., 'playlist_autonumber':...})` 把播放列表上下文**虚拟叠加**到每个子条目上（不污染原始 entry dict），再逐条 `__process_iterable_entry`→`process_ie_result` 递归；`lazy_playlist` 控制是否边下边解析。 源码位置: yt_dlp/YoutubeDL.py:2154-2173

- `url_transparent` 的"透明转发"语义：外层（嵌入页）的元数据透传给内层真实视频，仅 `_type/url/ie_key` 等少数字段豁免覆盖；若内层解析后仍是 `url`，则强制改写为 `url_transparent` 以继续传播外层元数据。 源码位置: yt_dlp/YoutubeDL.py:1971-2001

- 视频结果处理 `process_video_result` 串联：字段清洗（id 必填、字符串/数值字段规整、章节补全、缩略图 sanitize）→ `_fill_common_fields` → DRM/直播过滤 → 排序格式 → `pre_process('pre_process')` → 过滤 → `post_extract` → `pre_process('after_filter')` → 格式选择求值 → 下载循环 → `run_all_pps('after_video')`。 源码位置: yt_dlp/YoutubeDL.py:2838-2905,3040-3158

- 下载循环用 `itertools.product(formats_to_download, requested_ranges)` 做笛卡尔积，每个 `(格式, 时间区间)` 组合 `_copy_infodict` 一份并 `update(fmt)`，注入 section 起止，再调 `process_info`。 源码位置: yt_dlp/YoutubeDL.py:3118-3135

- `_copy_infodict` 是浅拷贝 + **主动剥离两个运行时私有键** `__postprocessors`、`__pending_error`，保证每次下载分叉从干净的运行时状态开始（业务字段仍带过去）。 源码位置: yt_dlp/YoutubeDL.py:1262-1267

- 单视频下载核心 `process_info` 用闭包 `replace_info_dict` 做"原地替换"（`clear()`+`update()`，保持对象身份不变），结尾 `assert info_dict is original_infodict` 强制保证外部引用仍指向被原地修改的对象。 源码位置: yt_dlp/YoutubeDL.py:3353-3361,3679

- `dl` 是实际下载动作：`get_suitable_downloader(info, params)(self, params)` 取下载器类（协议字段驱动），把协调器的全部 `_progress_hooks` 挂到该下载器（横切进度回调集中管理），再 `_copy_infodict` 一份交 `fd.download`。 源码位置: yt_dlp/YoutubeDL.py:3310-3324

- 多格式合并：`process_info` 中对 `requested_formats` 逐格式下载到 `f{format_id}` 临时文件，把 `FFmpegMergerPP` 实例 `append` 到 `info_dict['__postprocessors']`；`fixup()` 再按下载器名（如 `hlsnative`/`dashsegments`/`web_socket_fragment`）与容器（如 `m4a_dash`）决定是否追加对应 `FFmpegFixup*PP` 到同一列表。 源码位置: yt_dlp/YoutubeDL.py:3524-3577,3609-3665

- 后处理执行 `run_all_pps(key, info, additional_pps=None)` 把 `(additional_pps or []) + self._pps[key]` 合并后逐个 `run_pp`——**动态追加的（合并/修复）永远先于静态注册的执行**。 源码位置: yt_dlp/YoutubeDL.py:3831-3836

- `post_process` 串三步：`run_all_pps('post_process', additional=info['__postprocessors'])` → `run_pp(MoveFilesAfterDownloadPP)` → `run_all_pps('after_move')`。 源码位置: yt_dlp/YoutubeDL.py:3849-3856

- `pre_process` 把 PreProcessing 异常**延迟**：捕获后塞进 `info['__pending_error']` 并 `report_error(is_error=False)`，不立即抛出，由后续 `_raise_pending_errors` 统一兑现。 源码位置: yt_dlp/YoutubeDL.py:3838-3847

- 归档去重：`_make_archive_id` = `extractor_key + ' ' + id`（全局唯一，跨提取器），`in_download_archive` 查 set 且兼容 `_old_archive_ids` 旧 ID，`record_download_archive` 用 `locked_file(fn, 'a')` 追加写（多进程安全）。 源码位置: yt_dlp/YoutubeDL.py:3858-3895

- 请求门面 `urlopen`：接受 str/Request/旧 urllib.Request（兼容垫片），统一 basic_auth 抽取与 sanitize，委托 `self._request_director.send(req)`；其真正价值是**错误翻译层**——把 handler 竞争全失败（`NoSupportingHandlers`）翻译成"file:// 默认禁用 / HTTPS 代理需装 requests 或 curl_cffi / WebSocket 需装 websockets / 伪装目标缺依赖"，把 SSLError 翻译成"试 --legacy-server-connect"。 源码位置: yt_dlp/YoutubeDL.py:4284-4346

- `_request_director`（cached_property）由 `build_request_director(_REQUEST_HANDLERS.values(), _RH_PREFERENCES)` 组装：每个 handler 实例化时统一注入 cookiejar/proxies/headers/verify/client_cert 等横切配置；`prefer-legacy-http-handler` 兼容垫片给 Urllib 加 500 分偏好。 源码位置: yt_dlp/YoutubeDL.py:4348-4385

- 横切资源懒加载持有：`cookiejar`、`_request_director` 均为 `@functools.cached_property`，首次访问才构造；`proxies` 为普通 property。 源码位置: yt_dlp/YoutubeDL.py:4208-4224,4383-4385

- 顶层 `download(url_list)` 逐 URL 调 `__download_wrapper(self.extract_info)(url)`，返回累积的 `_download_retcode`；`trouble` 是错误中枢——`ignoreerrors` 时置 `_download_retcode=1`（软失败继续），否则 `raise DownloadError`（硬失败）。 源码位置: yt_dlp/YoutubeDL.py:1073-1105,3704-3718

- 过滤中枢 `_match_entry`：返回 None 表示应下载、返回 reason 字符串表示跳过；依次查归档命中、标题匹配/拒绝、日期范围、最小/最大观看数、年龄限制、用户 `match_filter` 回调（回调返回 `NO_DEFAULT` 触发交互式 Y/n 确认），并可按 `break_on_existing`/`break_on_reject` 抛特殊异常中断整批。 源码位置: yt_dlp/YoutubeDL.py:1578-1669

- 插件反向引用协调器：`add_info_extractor`/`add_post_processor` 注册时调 `ie.set_downloader(self)`/`pp.set_downloader(self)`，使插件能回访协调器持有的基础设施（如提取器调 `self._downloader.urlopen`）。 源码位置: yt_dlp/YoutubeDL.py:909-915,947-951

## 关键调用链

下载一条 URL 的主编排链：
```
download(url_list)
 └─ __download_wrapper(extract_info)(url)                     # 容错/JSON 输出包装
     └─ extract_info(url)                                      # 遍历 _ies 找 suitable 的 IE
         └─ __extract_info(url, ie)  [@_handle_extraction_exceptions]
             └─ ie.extract(url) → ie_result                    # 提取器返回带 _type 的字典
                 └─ process_ie_result(ie_result)               # ★ 按 _type 分派
                     ├─ 'url'             → extract_info(url) [递归]
                     ├─ 'url_transparent' → extract_info(process=False) + 外层覆盖 + 再分派 [递归]
                     ├─ 'video'           → process_video_result
                     │     ├─ pre_process('pre_process'/'after_filter')
                     │     ├─ _select_formats(formats, format_selector)
                     │     ├─ for fmt×range in product: process_info(copy+fmt)
                     │     └─ run_all_pps('after_video')
                     ├─ 'playlist'        → __process_playlist
                     │     ├─ ChainMap 叠 playlist 上下文
                     │     ├─ for entry: __process_iterable_entry → process_ie_result [递归]
                     │     └─ run_all_pps('playlist')
                     └─ process_info(info)  [@_catch_unsafe_extension_error]
                           ├─ pre_process('video'/'before_dl')
                           ├─ prepare_filename / 写附属文件
                           ├─ dl(temp, info) → get_suitable_downloader(info)(...).download
                           │     (+ 多格式→__postprocessors.append(FFmpegMergerPP))
                           ├─ fixup() → __postprocessors.append(FFmpegFixup*PP)
                           ├─ post_process → run_all_pps('post_process', additional=__postprocessors)
                           │                → MoveFilesAfterDownloadPP → run_all_pps('after_move')
                           ├─ _post_hooks
                           └─ __write_download_archive = True
```
源码位置: yt_dlp/YoutubeDL.py:3704-3718,1862-1890,1910-1947,2082-2198,2838-3158,3337-3682,3289-3324,3849-3856

## 源码摘录（带行号，全文累计 ≤ 30 行）

容错/重试边界（ReExtractInfo → continue 形成重新提取循环）：
```python
# yt_dlp/YoutubeDL.py:1727-1757（节选核心分支）
def wrapper(self, *args, **kwargs):
    while True:
        try:
            return func(self, *args, **kwargs)
        except ReExtractInfo as e:
            ...  # 提示后
            continue                          # ← 重新提取循环（直播等待/重试的灵魂）
        except GeoRestrictedError as e: ...   # → report_error
        except ExtractorError as e: self.report_error(str(e), e.format_traceback())
        except Exception as e:
            if self.params.get('ignoreerrors'): self.report_error(...)
            else: raise
        break                                 # 其余分支结束本次
```

结果分派器的分派键与递归（节选）：
```python
# yt_dlp/YoutubeDL.py:1920-1922,1945-1947,1964-1970,2002-2017（合并节选）
result_type = ie_result.get('_type', 'video')
...
if result_type == 'video':
    ... return self.process_video_result(ie_result, download=download)
elif result_type == 'url':
    return self.extract_info(ie_result['url'], download, ie_key=ie_result.get('ie_key'), extra_info=extra_info)  # 递归
elif result_type in ('playlist', 'multi_video'):
    ... self._playlist_level += 1; self._playlist_urls.add(webpage_url)  # 防循环
    try: return self.__process_playlist(ie_result, download)             # 逐条递归
    finally: self._playlist_level -= 1
```

分叉拷贝剥离运行时状态 + 原地替换保持对象身份：
```python
# yt_dlp/YoutubeDL.py:1262-1267
@staticmethod
def _copy_infodict(info_dict):
    info_dict = dict(info_dict)
    info_dict.pop('__postprocessors', None)   # 剥离动态 PP 列表
    info_dict.pop('__pending_error', None)    # 剥离延迟错误
    return info_dict
```
```python
# yt_dlp/YoutubeDL.py:3353-3358
def replace_info_dict(new_info):
    nonlocal info_dict
    if new_info == info_dict: return
    info_dict.clear(); info_dict.update(new_info)   # 原地替换，对象身份不变
```

动静态后处理合并（动态追加的先跑）：
```python
# yt_dlp/YoutubeDL.py:3831-3836
def run_all_pps(self, key, info, *, additional_pps=None):
    if key != 'video': self._forceprint(key, info)
    for pp in (additional_pps or []) + self._pps[key]:   # 动态(__postprocessors) + 静态
        info = self.run_pp(pp, info)
    return info
```

## 易混淆 / 边界 / 推断

- **事实**：`additional_pps`（即 `__postprocessors`，含 merger 与 fixup）在 `run_all_pps` 中排在 `self._pps[key]` **之前**执行——即"合并多格式、修复容器"永远先于用户在 CLI 配置的后处理器（如转码、嵌字幕）。这与直觉相反：动态决定的修复反而比用户声明的后处理更靠前。 源码位置: yt_dlp/YoutubeDL.py:3834

- **事实**：`_copy_infodict` 是**浅拷贝**，故 `formats` 等嵌套子字典在副本间共享引用；源码注释明确承认"理想应深拷贝但字典可能含不可深拷对象"而放弃。这意味着在下载循环里 `new_info.update(fmt)` 修改的是独立的顶层键，但若直接改 `new_info['formats'][0][...]` 会波及原 info。 源码位置: yt_dlp/YoutubeDL.py:3319-3321

- **事实**：`process_info` 末尾 `assert info_dict is original_infodict` 是硬断言——`replace_info_dict` 的 clear+update 设计就是为了让"经过多个返回新 dict 的阶段后，外部持有的 info_dict 引用仍指向被原地更新的同一对象"。 源码位置: yt_dlp/YoutubeDL.py:3341,3679

- **推断（标注为推断）**：把 cookiejar/request_director/proxies 设计成 `@functools.cached_property`（而非 `__init__` 里直接构造），推断动机有二：一是避免构造协调器时就强制触发可能失败的浏览器 cookie 解密（延迟到真正发请求才报错）；二是 `__init__` 里只读 `params['http_headers']`、把 Cookie 头迁出，但真正组装 handler 在首次 `urlopen` 时，使配置在首请求前仍可被插件改写。 源码位置: yt_dlp/YoutubeDL.py:4223-4232,4383-4385

- **推断（标注为推断）**：`pre_process` 不直接抛 PreProcessing 错而走 `__pending_error` 延迟兑现，推断是为了让"前置处理失败"不立即中断整条流水线，而是把错误挂到 info 上、由 `_raise_pending_errors` 在阶段交界处统一抛出，避免在 PP 内部抛出打乱外层 `try/except` 的语义。 源码位置: yt_dlp/YoutubeDL.py:3838-3847

- **事实**：格式选择器在 `__init__` 阶段（而非首次下载时）就调用 `build_format_selector` 编译，注释明言"allows us to catch syntax errors before the extraction"——即把 `-f` 语法错误尽量前置到程序启动期。 源码位置: yt_dlp/YoutubeDL.py:817-821

- **未理解**：`_match_entry` 中 `match_filter` 回调返回 `NO_DEFAULT` 触发交互式确认（Y/n）的完整状态机（`cancelled` 与 `DownloadCancelled` 的交互）较绕，本次未深究其与 `--break-per-url` 的协同，Writer 如需展开建议单独追读。 源码位置: yt_dlp/YoutubeDL.py:1620-1649
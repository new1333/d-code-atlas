# 分片化下载：把长流拆成可恢复的工作单元 · 源码精读

## 给 Writer 的教学钩子（必填，8 子项缺一不可）

- **用户痛点 / 场景**：一部两小时的 HLS/DASH 视频，在传输层并不是"一个文件"，而是几百段独立的 HTTP 小分片。若把它当一个整体下，连接在第 89% 断掉就要从 0 重来；任意一段 503/超时就让整条流失败；中途夹杂的广告段、被加密的段、字幕段又各有各的处理需求。使用者要的其实是"下完能播的一个文件"，但网络只肯给"一堆易碎的小段"——这两者之间的鸿沟，就是这一章要填的。

- **一句话核心思想**：**把一条不可靠的长下载，建模成一个可迭代的「分片工作单元」序列——每片独立下载、独立重试、可跳过、可解密、下完即追加并记账，崩了能从记账处接着干。**

- **设计动机（为什么需要它）**：单片巨下载的容错颗粒度太粗（整文件重试）、断点只能靠字节偏移（而分片流的"逻辑进度"是片数，不是字节数）、且无法表达"这一段是广告跳过""这一段加密要就地解""这一段是字幕要合并去重"。把这些需求统一收敛到一个抽象——"分片序列"——后，限速/进度/续传等横切能力仍由基类承担，而本层只专注"逐片地、可恢复地、可变换地把片拼回成整流"。
  - **承前关系（跨章去重信号）**：本章直接复用前置章建立的"协议字段驱动下载策略分派"——本层的两个具体下载器本身就是被那个分派机制按 `m3u8`/`dash` 协议选出来的；而且它们在内部会**再次**调用同一个分派机制，把"拉分片"这件事按 `m3u8_frag_urls`/`dash_frag_urls` 协议**二次委派**给外部下载器。（已在第 6 章『协议字段驱动的下载策略分派』讲透 `get_suitable_downloader` + `can_download` 自荐接管，本章只看它的新侧面：分派不是本章主角，本章主角是**叠在分派之上的"分片序列"抽象**——以及 native 下载器能力不足时主动降级转交外部工具的内部二级委派。）

- **关键权衡（本 Atlas 的核心，4 条）**：
  1. **片级续传用独立"簿记文件"而非字节偏移**：选择在每追加完一片后，把"当前片号"写进一个 JSON 簿记文件 → 换来按"逻辑片边界"精确续传（哪怕分片是各自独立抓取再拼接的），且能承载额外状态（extra_state）→ 代价是磁盘上多了一份必须与数据文件保持一致的簿记状态，因此要专门检测"簿记损坏"（解析失败）和"状态不一致"（片号>0 但数据文件为空）两种病态并各自从 0 重来。
  2. **每片用一个"静音子下载器"复用而非直连 HTTP**：选择为整个分片流派生一个关掉了屏幕输出与进度、重置了 sleep/test 的子下载器实例，由它逐片下到独立临时文件 → 换来完整继承既有单文件下载器的断点/Range/重定向/限速能力，且父下载器独占唯一一条聚合进度条 → 代价是引入了一层"嵌套下载器"和一层进度翻译（把子下载器的字节级进度，映射、平滑、外推成"分片级 + 总量估算"的进度）。
  3. **内容变换走可插拔钩子而非硬编码追加**：选择让核心循环对每片字节先过一个变换钩子再追加、全部结束时再过一个收尾钩子 → 换来同一条循环既能做"原始字节拼接"（音视频分片），又能做"字幕合并去重 + 时间戳溢出修正"（碎片化字幕）而不改核心 → 代价是字幕合并逻辑复杂且需要跨片状态（去重窗口、时间戳修正量）在线程间正确传递。
  4. **中断用"共享可变标志"协作式取消而非强杀线程**：选择用一个被所有工作线程共享的标志位，在每个分片边界检查；用户中断时只把标志置假 → 换来线程池的干净收尾（无需不可靠/不安全的强杀），且对直播流能返回"已下的中间结果"而非抛异常 → 代价是取消是协作式的、有延迟（工作线程可能再多下一片才察觉）。

- **最小心智模型（3～7 步）**：
  1. 下载器拿到一个"分片源"（清单文本，或提取器预解析好的分片列表），把它看成一条可迭代的分片序列。
  2. 准备：按目标临时文件已有大小决定以写/追加模式打开；读簿记文件恢复"已下到第几片"；派生一个静音子下载器；挂一个把子级进度翻译成总级进度的钩子。
  3. 逐片循环：用子下载器把当前片下到独立临时文件（该片自身也能断点续传）。
  4. 每片独立重试（次数可配）；该片失败时按"是否致命/是否允许跳过"决定跳过还是中止整流。
  5. 下完一片：读出字节 →（若加密）就地解密 → 过变换钩子（如字幕合并）→ 追加到目标流并落盘刷新。
  6. 追加后：把"当前片号"写回簿记文件，删除该片临时文件（除非要求保留分片）。
  7. 全部完成：关闭流、把临时文件改名成最终名、删簿记文件、发出"完成"进度。

- **最小原理演示（替代旧"复刻范围"）**：
  - **应演示**：一个几十行的从零实现，演透"分片序列 + 逐片重试/跳过 + 簿记续传 + 协作式中断"。具体演这三条权衡：①每追加一片就持久化"片号"簿记，中断重启后靠它跳过已下片（权衡 1）；②每片独立重试、不可得则按策略跳过（核心思想）；③共享中断标志在片边界 cooperative 取消（权衡 4）。输入是一个分片 URL 数组 + 一个模拟"第 N 片首次失败、重试后成功"的 fetch；输出是拼接结果 + 一份持久簿记。故意构造"下到第 2 片中断→重启"的场景，演示它从簿记处的第 3 片继续而非从 0 开始。
  - **应故意省略**：真实 HTTP/Range 续传细节、AES 解密的真实实现（用恒等函数占位即可，只保留"解密钩子"这个位置）、多流并发（多 ThreadPoolExecutor）、字幕合并的全部正确性、进度平滑/ETA 估算、直播特例、外部下载器委派——这些都不服务于"演透原理"，全部砍掉。
  - **演示载体建议**：**首选 TS/JS**。理由：本章核心是纯控制流/编排模式——"可迭代分片序列 × 逐片重试/跳过/解密/追加 × 簿记续传 × 协作式中断"，没有任何语言特有语义（不依赖描述符/元类/所有权等），用 `async`/`await` + `fetch` + 一个分片数组就能忠实演透，配最小 `package.json` 即可 `node`/`bun` 跑；解密只是途中的一个可占位变换钩子，不需要真实密码学库。只有强依赖原生运行时的机制才需退回原仓库语言，本章不属于此类。**为何 TS/JS 讲得透**：原理本身与语言无关，TS/JS 的 async 迭代 + 闭包共享可变标志恰好是这个模式的最自然表达。

- **正文不宜展开的细节**：字幕合并的去重窗口与 MPEG-TS 时间戳溢出/修正（碎片化 WebVTT 才用得上，机制独立且琐碎，建议一笔带过或单列附录）；进度总量的"按已下片均摊外推"估算公式及其平滑器细节；直播流（`live`/`is_from_start`）对簿记与中断语义的特例改写；DASH 多格式（独立音视频轨）时多线程池的配额分配算法；各类广告段启发式识别（ANVATO/UPLYNK 标记）。

- **推荐的一个执行轨迹例子**：输入 = 4 片的流，第 3 片首次失败、重试后成功，且在下完第 2 片后被中断、随后重启。关键中间态：①准备时数据文件空→写模式打开、簿记{片号:0}；②第 1、2 片各下/追加/更新簿记到{片号:2}→中断；③重启：读簿记{片号:2}、数据文件已有 2 片字节→改追加模式打开、循环里跳过片号≤2；④第 3 片首次 HTTP 失败→触发重试→成功→追加→簿记{片号:3}；⑤第 4 片下完→簿记{片号:4}；⑥收尾：关流、改名、删簿记、发完成。输出 = 完整拼接文件，且全程只下了 1 次第 1、2、4 片、2 次第 3 片。

> 以上钩子供 Writer 写「动机→核心思想→心智模型→关键权衡→原理演示」；下面事实部分供核对，不要被 Writer 当目录照抄。

## 概念要点

- **分片下载器是协议分派的下一个层级**：本章两个 native 下载器继承自分片基类，自身又被前置章的分派机制按 `m3u8`/`m3u8_native`/`dash` 协议选中；而所有外部下载器（aria2c/ffmpeg/curl/wget/axel/httpie）**同样**继承自分片基类——分片抽象是 native 与 external 共同的脊椎。源码位置: yt_dlp/downloader/external.py:37 (`class ExternalFD(FragmentFD)`)、yt_dlp/downloader/hls.py:22 (`class HlsFD(FragmentFD)`)、yt_dlp/downloader/dash.py:9 (`class DashSegmentsFD(FragmentFD)`)。
- **簿记文件的设计契约**：基类把"分片级续传状态"明确建模为一个 JSON 簿记文件，结构为 `{downloader:{current_fragment:{index}, extra_state?, fragment_count?}}`；只在非直播、非 stdout、未禁用时启用。源码位置: yt_dlp/downloader/fragment.py:26-60（契约文档）、79-80（启用条件）。
- **簿记的写入时机绑定在"追加成功"之后**：先写数据流并 flush，再（finally 里）写簿记、删除该片临时文件——这个顺序保证"簿记片号 = 已落盘片数"。源码位置: yt_dlp/downloader/fragment.py:146-155。
- **续传的双病态检测**：恢复时若簿记解析失败（损坏）或"片号>0 但数据文件为空"（不一致），一律视为脏状态、从 0 重来并重写簿记；这是维护"簿记↔数据一致性"的代价直接体现。源码位置: yt_dlp/downloader/fragment.py:194-205。
- **字节级续传与片级续传叠加**：准备阶段按临时文件已有大小决定 `wb`/`ab` 打开（字节续传），再叠加簿记的片号跳过（片级续传）；单片内部还有 `frag_resume_len` 做该片自身的字节续传。源码位置: yt_dlp/downloader/fragment.py:176-186、111-122。
- **静音子下载器**：派生一个关掉 `to_screen`/`to_console_title`、并强制 `noprogress`/`test=False`/各 sleep=0 的子下载器实例，专门负责逐片抓取，把"屏幕与进度"的发言权完全让给父下载器。源码位置: yt_dlp/downloader/fragment.py:19-23、167-174。
- **进度总量靠"均摊外推"估算**：非直播时，用 `(已下字节 + 当前片字节) / (当前片号+1) × 总片数` 估算总量，再交给平滑器算速度/ETA；直播时只能更新已下字节、无总量。源码位置: yt_dlp/downloader/fragment.py:256-268。
- **逐片重试与跳过策略**：用 `RetryManager` 按可配重试次数包住每片下载，捕获 HTTP 错误/不完整读；首片强制致命，其余片按 `is_fatal`（受 `skip_unavailable_fragments` 控制）决定"不可得则跳过"还是"中止整流"。源码位置: yt_dlp/downloader/fragment.py:436-437、450-451、459-470、472-481。
- **就地解密（AES-128）**：解密器是返回闭包的工厂，按片携带的解密信息就地解；密钥按 URL 缓存避免反复抓取；IV 取显式值或由 `media_sequence` 派生；测试模式故意不解密（测试数据非整块）。源码位置: yt_dlp/downloader/fragment.py:341-365。
- **协作式中断**：多流并发时用一个单元素可变列表做"中断标志"，被所有工作线程的迭代器与片循环检查；中断时置假、线程自然收尾，直播流返回中间结果而非抛异常。源码位置: yt_dlp/downloader/fragment.py:372、405-409、418-429、440-441、510-519。
- **内容变换可插拔**：核心循环接受 `pack_func`（每片追加前变换）与 `finish_func`（收尾时再写一段）；默认恒等，字幕流则用来做碎片化字幕的合并/去重/时间戳修正。源码位置: yt_dlp/downloader/fragment.py:431-434、483、500、523-525。
- **HLS 的能力探测与内部降级**：HLS 下载器先用静态 `can_download` 扫清单文本，发现 DRM（FairPlay/PlayReady/Flash Access）或非 AES-128 加密即"能力不足"，主动把整条下载**转交外部工具**；这是前置章"外部下载器自荐接管"在同一章内的反向应用（native 自报不足→让位）。源码位置: yt_dlp/downloader/hls.py:31-72、94-128。
- **HLS 清单在下载器内两遍解析**：第一遍只数"媒体片/广告片"数量（供进度总量），第二遍带状态（解密信息、字节范围、media_sequence、discontinuity）构建分片列表；广告段靠 ANVATO/UPLYNK 标记启发式跳过。源码位置: yt_dlp/downloader/hls.py:151-167（计数）、204-299（构建）、141-147（广告标记）。
- **DASH 清单由提取器预解析**：DASH 下载器不解析 MPD，直接迭代提取器已建好的 `fmt['fragments']`；分片 URL 由 `fragment_base_url + path` 拼接或直取 `fragment['url']`；并支持分片是惰性生成器（可调用对象）与 `--load-info-json` 场景下的再提取。源码位置: yt_dlp/downloader/dash.py:70-95、31-34。
- **DASH 的多轨并发**：DASH 常为独立音视频轨，每轨各成一个 `(ctx, fragments, fmt)` 流，交给多流并发入口并行下载，且把"第 0 轨"标为致命（音视频缺一不可的常见策略）。源码位置: yt_dlp/downloader/dash.py:28-30、66-68。
- **二次委派给外部分片下载器**：native 下载器可把"拉分片"按 `m3u8_frag_urls`/`dash_frag_urls` 协议再委派给外部下载器，并由 `supports_manifest` 做二次能力校验；委派时走"外部准备"分支（只准备片号、不打开自己的目标流）。源码位置: yt_dlp/downloader/hls.py:130-139、175-178、305-311；yt_dlp/downloader/dash.py:46-64、321-339（外部准备在基类）。

## 关键调用链

- **HLS 主路径**：`HlsFD.real_download` →（取/解码 m3u8 清单）→ `can_download` →（不足则 `FFmpegFD.real_download` 降级）→ 两遍解析建 `fragments` → `download_and_append_fragments(ctx, fragments, info_dict[, pack_func, finish_func])` → 每片：`download_fragment`(`RetryManager` 重试) → `ctx['dl']`(静音子下载器)`download` → `_read_fragment` → `decrypt_fragment` → `_append_fragment`(写流+flush+簿记+删片) → 收尾 `_finish_frag_download`(关流+改名+删簿记+完成钩子)。
  源码位置: yt_dlp/downloader/hls.py:74-409；循环核心 yt_dlp/downloader/fragment.py:431-526。
- **DASH 主路径**：`DashSegmentsFD.real_download` → 取 `requested_formats`（多轨）→ 每轨 `_get_fragments`(生成器) → `download_and_append_fragments_multiple(*args, is_fatal=...)` →（每轨一个线程池）→ `download_and_append_fragments` → 同上逐片循环。
  源码位置: yt_dlp/downloader/dash.py:17-68；多流入口 yt_dlp/downloader/fragment.py:367-429。
- **二次委派路径**：`HlsFD/DashSegmentsFD.real_download` → `get_suitable_downloader(..., protocol='m3u8_frag_urls'/'dash_frag_urls')` → `real_downloader.supports_manifest` → 命中则 `_prepare_external_frag_download` → 把 `fragments` 塞回 info_dict 交给该外部下载器的 `real_download`。
  源码位置: yt_dlp/downloader/hls.py:133-139、305-311；yt_dlp/downloader/dash.py:23-24、59-64。

## 源码摘录（带行号，全文累计 ≤ 30 行）

用途：演示权衡 1 的"收益面"——追加成功后立即落盘并写簿记、删片，使"簿记片号=已落盘片数"。
```python
    def _append_fragment(self, ctx, frag_content):
        try:
            ctx['dest_stream'].write(frag_content)
            ctx['dest_stream'].flush()
        finally:
            if self.__do_ytdl_file(ctx):
                self._write_ytdl_file(ctx)
            if not self.params.get('keep_fragments', False):
                self.try_remove(ctx['fragment_filename_sanitized'])
            del ctx['fragment_filename_sanitized']
```
源码位置: yt_dlp/downloader/fragment.py:146-155

用途：演示权衡 1 的"代价面"——恢复时检测簿记损坏与状态不一致两种病态（命中则于第 202 行 `ctx['fragment_index'] = resume_len = 0` 从 0 重来）。
```python
                is_corrupt = ctx.get('ytdl_corrupt') is True
                is_inconsistent = ctx['fragment_index'] > 0 and resume_len == 0
                if is_corrupt or is_inconsistent:
```
源码位置: yt_dlp/downloader/fragment.py:194-196（重置见 :202）

用途：演示核心循环串行分支——片边界查中断标志、逐片 下载→读→解密→追加、直播被中断则保留中间结果。（并发分支同构，仅把下载与追加拆到线程池，见 :487-507）
```python
            for fragment in fragments:
                if not interrupt_trigger[0]:
                    break
                try:
                    download_fragment(fragment, ctx)
                    result = append_fragment(
                        decrypt_fragment(fragment, self._read_fragment(ctx)), fragment['frag_index'], ctx)
                except KeyboardInterrupt:
                    if info_dict.get('is_live'):
                        break
                    raise
                if not result:
                    return False
```
源码位置: yt_dlp/downloader/fragment.py:509-521

用途：演示"就地解密"只是一个途中的纯变换——AES-CBC 解 + 去 PKCS7 填充，证明解密位置正是变换钩子的同构位点。
```python
            return unpad_pkcs7(aes_cbc_decrypt_bytes(frag_content, decrypt_info['KEY'], iv))
```
源码位置: yt_dlp/downloader/fragment.py:363

## 易混淆 / 边界 / 推断

- **事实**：直播流禁用簿记文件（`__do_ytdl_file` 在 `ctx['live'] is not True` 时才为真），且直播被中断时返回已下中间结果而非抛 `KeyboardInterrupt`；非直播被中断则抛出。源码位置: yt_dlp/downloader/fragment.py:79-80、425-429、516-519。
- **事实**：HLS 与 DASH 的清单解析职责不对称——HLS 在下载器内解析 m3u8 文本，DASH 依赖提取器预解析 `fmt['fragments']`。源码位置: yt_dlp/downloader/hls.py:154-299；yt_dlp/downloader/dash.py:74-95。
- **事实**：解密密钥按 URL 在闭包字典内缓存，避免每片重复抓 key。源码位置: yt_dlp/downloader/fragment.py:342-347。
- **推断**：HLS 之所以"两遍"解析清单，是因为进度总量需要"先知道总片数"，而第二遍构建分片又依赖严格顺序的逐行状态（当前解密信息/字节范围/media_sequence/discontinuity）——计数与带状态构建无法在保证正确性的前提下合并为一遍，故拆成两遍。推断依据：计数遍不带任何状态、只看行类型（:151-167），构建遍则顺序维护 `decrypt_info`/`byte_range` 等可变状态（:204-299）。
- **推断**：中断标志用单元素列表（而非布尔变量）是为了让闭包/多线程能"按引用共享并就地翻转"；迭代器 `interrupt_trigger_iter` 在每次 `yield` 前查它，把协作式取消下沉到迭代层。推断依据：`:372` 定义为 `[True]`，`:405-409` 在迭代前检查，`:422` 在捕到中断时置 `False`。
- **推断**：把"第 0 轨致命、其余可跳"作为 DASH 默认 `is_fatal`，反映"音视频任一轨道整体缺失不可恢复，但中间零星分片可丢"的实用策略。推断依据：yt_dlp/downloader/dash.py:68 `is_fatal=lambda idx: idx == 0`。
- **未理解/建议略讲**：碎片化 WebVTT 的去重窗口（`webvtt_dedup_window`）与 MPEG-TS 33 位时间戳溢出修正（`webvtt_mpegts_adjust`、`<< 33`）的完整正确性语义较晦涩，建议正文不展开，仅作为"变换钩子能承载多复杂的状态化变换"的例证。源码位置: yt_dlp/downloader/hls.py:313-401。
- **边界**：`fragment_retries` 默认值 API 场景为 0、CLI 场景为 10（见类文档字符串），影响逐片重试次数，需注意默认值随入口不同而不同。源码位置: yt_dlp/downloader/fragment.py:32-34。
# 声明式后处理流水线与链式 info 变换 · 源码精读

## 给 Writer 的教学钩子（必填，8 子项缺一不可）

- **用户痛点 / 场景**：下载完一个文件远不是终点——你可能要提取音频、转换容器、嵌字幕、砍掉赞助片段、再写入标题/章节元数据，每一步都可能产出新文件、留下该删的旧文件。如果让用户自己排「先转码还是先写元数据」，几乎一定排错（比如在 3gp 这种不支持元数据的容器上写元数据会丢）。使用者要的不是「一堆加工工具」，而是「给一串开关，框架替我排成一条不会打架的加工流水线」。

- **一句话核心思想**：**把后处理做成一条声明式拼装的链，链上的每个加工站都对同一份元数据做纯变换，并顺带声明「我产生了哪些该删的旧文件」**。

- **设计动机（为什么需要它）**：下载阶段产物（一个文件路径 + 一份元数据）需要被一连串加工步骤反复改写——每转一次码，文件路径就换一个新值，旧路径就该进「待删清单」。要支撑这种「边加工边改文件边清理」的流程，最自然的是把每个加工步骤抽象成「吃一份元数据、吐一份新元数据 + 一串待删文件」的纯函数，再首尾相连 fold 起来。这就引出了三条腿：统一的加工站契约（链式 fold 的传递格式）、把一堆命令行开关自动翻译成正确顺序加工链的「声明式拼装函数」、以及让加工站作者只写业务逻辑的横切自动化（进度通知）。
  - **承前 / 跨章去重**：「胖元数据字典当万能数据总线」这一原理（已在第 4 章『info_dict 数据总线与提取器骨架』讲透，本章只看它的新侧面：字典流入后处理阶段后，其 `filepath` 字段被每个加工站反复改写、旧值落入待删清单，字典在此扮演「链上可变状态载体」）。同理，「后缀即类型、约定胜配置」的插件注册机制（已在第 2 章『约定胜配置的插件注册机制』讲透，本章只看后处理器这一个注册实例：所有内置后处理器与用户插件走同一条发现路径，**不重演注册原理**）。

- **关键权衡（核心原料，4 条）**：
  1. **用元类在类创建时自动给每个加工站的执行方法包一层「开始/结束」进度通知** → 换来加工站作者只写纯业务逻辑、横切的进度上报全自动 → 代价是执行方法被元类悄悄替换（字面定义与实际运行行为不一致，新手调试困惑；且每站运行都要先复制一份元数据副本驱动进度通知，带来轻微开销与「返回值解包」隐式约定）。
  2. **用「(待删文件列表, 新元数据)」二元组作为链上唯一的传递契约** → 换来任意加工站可自由组合，每个站既是元数据变换器又是「清理声明者」→ 代价是删文件时机被框架接管（保留原始文件选项开启时，删除会被延后、转成「待挪动」映射而非真删），加工站不能自己直接删文件，否则会破坏链的清理语义。
  3. **用一个生成器函数把一堆命令行开关逐个翻译成「有序的后处理器声明列表」**，正确先后顺序靠作者在该函数里用注释 + 产出顺序硬编码（如「改章节必须早于写元数据」「写元数据必须在容器定型之后」）→ 换来用户只需给开关、框架自动拼出顺序正确的加工管线 → 代价是站与站之间的正确依赖关系散落在注释里、无编译期保证，新增一个站必须小心翼翼插对产出位置，错了就静默产出损坏文件。
  4. **给每个声明附带一个「何时运行」的阶段字段**，把后处理器挂到主管线的不同阶段（下载前、过滤后、下载后、移动后、播放列表级…）→ 换来同一套加工机制横跨整个流程的多个时机、可复用 → 代价是调用方必须理解 8 个阶段语义；且少数「系统级」加工站（最终文件落位）被硬编码固定在收尾位置，不参与声明式流水线，形成「声明式」与「命令式」两套并存。

- **最小心智模型（6 步）**：
  1. 命令行开关喂给「声明式拼装函数」，被翻译成一串后处理器声明（每条含名字、参数、运行时机）。
  2. 编排器把每条声明实例化成对象，按「运行时机」分桶存放。
  3. 主管线走到某个阶段时，取出该桶里的加工站，依次执行。
  4. 每次执行前，元类自动织入的包装层先发「开始」通知，再调真正的业务逻辑，拿到「(待删文件, 新元数据)」，发「结束」通知。
  5. 框架把上一步的新元数据喂给下一个加工站（链式折叠）；待删文件按策略延后或删除。
  6. 一桶跑完，元数据里的文件路径已被一路改写成最终文件；最后由一个硬编码的「落位」加工站把临时文件挪到最终位置。

- **最小原理演示（替代旧"复刻范围"）**：
  - **应演示**：一个**小到只表达「声明式拼装 + 链式纯变换 + 元类自动进度钩子」三合一**的从零实现（约 60 行）。演的是权衡 1+2+3：一个 `runAllPps(stage, info)` 把某阶段的加工站依次跑成 fold；一个装饰器/高阶函数模拟「元类自动织入开始/结束钩子」（包装前 vs 包装后对比，让读者看到作者写的纯业务逻辑 vs 实际运行时多出来的通知）；一个 `getPostprocessors(opts)` 把 `{extractAudio, addMetadata}` 两个开关翻译成「先提取音频→再写元数据」两条有序声明，并用注释标明「元数据必须在容器定型后写」的顺序约束；运行后让读者看到 `info.filepath` 从 `x.webm` 被改写成 `x.m4a`、旧 `x.webm` 进入待删清单、最终被清理。
  - **应故意省略**：真实的 ffmpeg 调用（用 mock 的「转码」「写元数据」函数代替）、真实字幕/缩略图嵌入门类、`__files_to_move` 的 keepvideo 延后删除分支、注册表与插件发现的完整工程、媒体类型限制装饰器、8 个阶段的完整管线、进度模板渲染。
  - **演示载体建议（本章选 TS/JS）**：**首选 TS/JS**。本章核心是「纯数据流 fold + 注册表查表 + 高阶函数织入横切关注点」，这些是语言无关的通用机制，TS/JS 完全能忠实演透，且对读者最易 `bun run`/`node` 跑通。Python 的「元类」在本演示里用「高阶函数包装类方法」等价模拟即可（这正是为了证明该机制不依赖 Python 元类语义）——故**无需退回原仓库语言**。配一个最小 `package.json`。

- **正文不宜展开的细节**：各 ffmpeg 后处理器（ExtractAudio/Remuxer/Convertor/EmbedSubtitle/Metadata/SplitChapters…）的内部实现；媒体类型限制装饰器 `_restrict_to` 的 video/audio/images 分流与 simulate 跳过；keepvideo 下 `__files_to_move` 的文件保留/挪动完整语义；`pp_key` 对 ffmpeg 前缀的剥离与插件后缀约定的耦合；进度模板 `progress_template` 的 outtmpl 渲染；赞助段（SponsorBlock）、exec 命令、xattr 等具体站的业务。这些是 Writer 该裁掉的边角，正文只点「它们都只是链上一个站」即可。

- **推荐的一个执行轨迹例子**：输入开关 `{extractAudio: true, addMetadata: true}`，元数据 `{filepath: 'x.webm', ...}` → 拼装函数产出顺序为 `[提取音频, 写元数据]`（注释约束：写元数据必须在容器定型之后）→ 提取音频站产出 `(['x.webm'], {filepath:'x.m4a', ...})`（旧 webm 进待删、路径换成 m4a）→ 写元数据站拿到上一步的 m4a、产出 `([], {filepath:'x.m4a', ext:'m4a', ...})`（写元数据不改文件名）→ 框架删掉 x.webm → 最终 `filepath='x.m4a'`。

> 以上钩子供 Writer 写「动机→核心思想→心智模型→关键权衡→原理演示」；下面事实部分供核对，不要被 Writer 当目录照抄。

## 概念要点

- **执行契约是「(待删文件列表, info)」二元组**：基类的执行方法默认返回 `[], information`（即「不改文件、什么都不做」），文档明确 info 在此阶段多了 `filepath` 字段指向已下载文件。这是整条链的传递货币。源码位置: yt_dlp/postprocessor/common.py:135-150
- **元类在类创建时自动包装执行方法**：只要子类在自己的类体里定义了执行方法，元类就会用一层「复制 info 副本 → 发开始通知 → 调真方法 → 发结束通知 → 返回」的包装层替换它。PP 作者完全看不到这层。源码位置: yt_dlp/postprocessor/common.py:16-33
- **包装层用 info 副本驱动进度通知、用真 info 传递链**：`info_copy` 只喂给进度钩子，避免污染正在链上流动的真 info；包装层还隐式处理「子类返回 None」的兼容（视为不变）。源码位置: yt_dlp/postprocessor/common.py:18-28
- **链式 fold 的执行端在编排器**：编排器按「运行时机」把 PP 分桶（`_pps = {k: [] for k in POSTPROCESS_WHEN}`），某阶段触发时取出该桶逐个执行，每个的输出 info 喂给下一个。源码位置: yt_dlp/YoutubeDL.py:645, 3831-3836（注：YoutubeDL.py 属 orchestrator 章，此处仅作执行端佐证）
- **「运行时机」是 8 个固定阶段**：`('pre_process', 'after_filter', 'video', 'before_dl', 'post_process', 'after_move', 'after_video', 'playlist')`，覆盖下载前/过滤后/单视频/下载前/下载后/移动后/视频后/播放列表级。源码位置: yt_dlp/utils/_utils.py:2870
- **「系统级」收尾站被硬编码**：下载后阶段跑完用户声明的 PP 链后，编排器固定再跑一个「移动文件到最终位置」的 PP，然后才跑 `after_move` 桶——这个落位站不参与声明式流水线。源码位置: yt_dlp/YoutubeDL.py:3849-3856
- **声明式拼装函数是一个生成器**：把一堆 `opts` 开关逐个翻译成 PP 声明 dict（含 `key`/参数/可选 `when`），顺序即产出顺序，靠注释标注站间先后约束。源码位置: yt_dlp/__init__.py:627-736
- **顺序约束以注释形式硬编码**（summary 中「注释化约束」的出处）：如「ModifyChapters must run before FFmpegMetadataPP」「FFmpegMetadataPP should be run after FFmpegVideoConvertorPP and FFmpegExtractAudioPP … From this point the container won't change」「XAttrMetadataPP should be run after post-processors that may change file contents」「Exec must be the last PP of each category」。源码位置: yt_dlp/__init__.py:673, 684, 694-700, 721, 730
- **keepvideo 下删除被延后**：执行端拿到待删清单后，若开启保留原始文件，则把待删文件转入「待挪动」映射而非真删；否则立即删。源码位置: yt_dlp/YoutubeDL.py:3821-3828
- **注册表 = 模块全局里所有以 PP 结尾的类**：包初始化时把所有内置 PP 类收集进全局注册表（ContextVar），并登记一个插件规范（约定后缀 `PP` 即类型），使「丢一个文件就注册一个新 PP」。源码位置: yt_dlp/postprocessor/__init__.py:55-67
- **按名查表 + 插件懒加载**：`get_postprocessor(key)` = `注册表[key + 'PP']`；模块级 `__getattr__` 让插件 PP 可从本包懒导入（并触发弃用告警，引导改从插件命名空间导入）。源码位置: yt_dlp/postprocessor/__init__.py:40-52
- **媒体类型限制装饰器（声明式能力边界的另一侧面）**：基类提供装饰器工厂，让 PP 声明「只对 video/audio/images 生效」+「simulate 模式下是否跳过」，运行时自动对不匹配类型返回空变换。源码位置: yt_dlp/postprocessor/common.py:114-133
- **PP 名 → 注册 key 的归一化**：`pp_key` 剥离类名末尾的 `PP`，并对 `FFmpeg` 前缀做特殊剥离，使键名与注册表/插件约定对齐。源码位置: yt_dlp/postprocessor/common.py:61-64

## 关键调用链

声明式拼装 → 分桶 → 链式 fold 执行：

```
get_postprocessors(opts)                      # 把开关翻译成有序 PP 声明列表
  → [ {key, params, when}, ... ]              # yt_dlp/__init__.py:627
parse_options() → list(get_postprocessors(opts))  # yt_dlp/__init__.py:753
  → ydl_opts['postprocessors']                # yt_dlp/__init__.py:929
YoutubeDL 构造 → add_post_processor(pp, when)  # 按 when 入桶  YoutubeDL.py:947-950
  → self._pps[when].append(pp); pp.set_downloader(self)
主管线触发 → run_all_pps(key, info)            # 取桶逐个跑  YoutubeDL.py:3831-3836
  → for pp in bucket: info = run_pp(pp, info)  # 链式 fold
      run_pp → pp.run(info)                    # YoutubeDL.py:3813
        → [元类包装] started → 真 run → finished  # common.py:18-28
        → (files_to_delete, info)              # 二元组契约
      → 处理待删(keepvideo 延后 / 否则删)        # YoutubeDL.py:3821-3828
post_process 收尾 → run_all_pps('post_process')  # YoutubeDL.py:3853
  → run_pp(MoveFilesAfterDownloadPP)           # 硬编码落位站  YoutubeDL.py:3854
  → run_all_pps('after_move')                  # YoutubeDL.py:3856
```

## 源码摘录（带行号，全文累计 ≤ 30 行）

元类自动织入进度钩子（全章灵魂——横切自动化）：
```py
# yt_dlp/postprocessor/common.py:18-28
@functools.wraps(func)
def run(self, info, *args, **kwargs):
    info_copy = self._copy_infodict(info)
    self._hook_progress({'status': 'started'}, info_copy)
    ret = func(self, info, *args, **kwargs)
    if ret is not None:
        _, info = ret
    self._hook_progress({'status': 'finished'}, info_copy)
    return ret
```
```py
# yt_dlp/postprocessor/common.py:30-33
def __new__(cls, name, bases, attrs):
    if 'run' in attrs:
        attrs['run'] = cls.run_wrapper(attrs['run'])
    return type.__new__(cls, name, bases, attrs)
```

链式 fold 执行端（上一步的 info 喂下一步）：
```py
# yt_dlp/YoutubeDL.py:3831-3836
def run_all_pps(self, key, info, *, additional_pps=None):
    if key != 'video':
        self._forceprint(key, info)
    for pp in (additional_pps or []) + self._pps[key]:
        info = self.run_pp(pp, info)
    return info
```

执行契约的解包（二元组传递的落点）：
```py
# yt_dlp/YoutubeDL.py:3813
            files_to_delete, infodict = pp.run(infodict)
```

声明式拼装里的「注释化顺序约束」（顺序正确性靠注释 + 产出顺序硬编码）：
```py
# yt_dlp/__init__.py:684-687
    # ModifyChapters must run before FFmpegMetadataPP
    if opts.remove_chapters or sponsorblock_query:
        yield {
            'key': 'ModifyChapters',
```

## 易混淆 / 边界 / 推断

- **事实**：基类执行方法的默认返回是 `[], information`（什么都不做），所以一个空实现的 PP 是合法的「透传站」。源码位置: yt_dlp/postprocessor/common.py:150
- **事实**：`post_process` 里跑的 PP 链 = 用户声明里 `when` 缺省（默认 `post_process`）的那些 + `info['__postprocessors']`（单个视频自带的附加 PP）拼接而成。源码位置: yt_dlp/YoutubeDL.py:3853
- **事实**：`get_postprocessors` 会**就地修改 opts**（如 `opts.writesubtitles = True`、`opts.writethumbnail = True`），因为某些 PP 需要前置产物（字幕/缩略图文件）才能工作——这是「声明式拼装」对下游选项的反向副作用，是个隐藏耦合。源码位置: yt_dlp/__init__.py:681-682, 713-715
- **推断**：把「正确顺序」交给一个生成器函数 + 注释，而非一个显式的依赖图/拓扑排序，是为了保持「加一个开关 ≈ 加一个 if-yield」的极低心智负担——代价是顺序正确性无机器保证，完全靠作者纪律。这是 summary「代价是正确顺序依赖作者硬编码的注释化约束」的根因。
- **推断**：元类自动包装之所以用 `if 'run' in attrs`（只包装类体里**直接定义**的 run，不包装继承来的），是为了让基类自身的默认 run 不被二次包装、且子类不重写 run 时仍能继承基类行为——这是一个有意的设计细节，避免重复包装。
- **未理解**：`run_wrapper` 里 `if ret is not None: _, info = ret` 之后，局部变量 `info` 被重新绑定但**并未**用于后续（后续用的是 `info_copy` 去发 finished、直接 `return ret`）。这里对 `info` 的重新赋值看似无效，推测是为兼容某些旧分支或仅为文档性表达，未完全确认其必要性。源码位置: yt_dlp/postprocessor/common.py:24-27
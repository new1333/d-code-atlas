# 输出模板引擎：命名即元数据投影 · 源码精读

## 给 Writer 的教学钩子（必填，8 子项缺一不可）

- **用户痛点 / 场景**：批量下载几百个视频时，用户想按「标题-序号.扩展名」自动命名、在终端标题栏实时显示下载百分比、下载完再跑一条 shell 命令。这些需求本质都是「从同一份视频元数据派生出一段字符串」。如果没有一个统一的「元数据投影」机制，文件名、进度标题、命令就得各写一套取值与转义逻辑；某个字段缺失就直接崩溃；而命令那一路的 shell 注入风险也无法集中防护。

- **一句话核心思想**：把自定义的「元数据投影模板」**预编译**成宿主语言自带的字符串格式化形式，让宿主做最终代入——引擎自己只管「取值与类型转换」。

- **设计动机（为什么需要它）**：这个机制要解决的矛盾是「模板语法必须足够丰富（点遍历、取负、数学、日期、备选字段、类型转换），但又不想从零写一个文本代入器」。它换来的是「同一条胖字典 + 同一套模板语法」可以投影成文件名、进度条、控制台标题、命令等一切输出，下载逻辑与命名/输出彻底解耦。
  - 承前关系：**（已在第 4 章『info_dict 数据总线与提取器骨架』讲透「胖字典当万能数据总线」，本章只看它的新侧面：把这条字典投影成输出字符串）**。模板引擎的输入就是那条 info_dict，且求值前还要再往里注入一批运行时字段（时间戳、自增序号、时长串），这正是「字段语义随阶段演进 / 后注入」的自然延续。

- **关键权衡**：
  1. **编译而非解释：自定义 DSL → 宿主原生格式化**。选择「把富模板预编译成一个扁平取值表 + 一段纯宿主格式串」→ 换来零成本继承宿主格式化的全部能力（宽度、精度、零填充、左右对齐都直接透传给宿主）、且只需写「取值器」不必写「文本代入器」→ 代价是模板里每个字段必须**急切求值**塞进扁平表（无法惰性/流式），且用 NUL 字符做 key 隔离的技巧很 hacky。
  2. **类型转换伪装成「格式类型字符」**。选择「把自定义转换（列表 / JSON / HTML 转义 / shell 引号 / 字节 / unicode 归一 / 十进制后缀 / 文件名净化）塞进宿主格式串里「类型字符」那个位置」→ 换来与原生类型字符共用同一条解析路径，用户写一个字母就能转换 → 代价是类型字符命名空间被挤占、自定义字母与标准字母混在一起、读者需查表。
  3. **`--exec` 安全门：转换类型白名单 + 默认值危险字符黑名单**。选择「命令模板在注册期就校验：只允许少数几种安全的转换类型、默认值不得含 shell 元字符」→ 换来模板可安全地交给 shell 执行 → 代价是命令模板的能力被刻意削掉一截，想解禁必须显式开启不安全兼容项。
  4. **缺省值与备选链**。选择「字段缺失时按可配置占位符兜底，并提供「优先 A 否则试 B」的备选字段链、「否则用 X」的自定义默认值」→ 换来模板对字段缺失鲁棒（一个视频没有章节字段不会崩）→ 代价是一条正则里塞进了取负 / 数学 / 日期 / 备选 / 替换 / 默认六种语义，正则极复杂、可读性差。
  5. **一处引擎、多处投影**。选择「同一个求值入口被文件名、进度条、控制台标题、打印、命令、元数据解析、章节标题七处复用」→ 换来「命名 / 进度 / 命令都是同一种元数据投影」的一致性 → 代价是引擎同时背负文件名净化、shell 安全、进度嵌套子字典等多种模式，单函数体膨胀到数百行。

- **最小心智模型（3～7 步）**：
  1. 用户写一条模板与一份元数据字典，一起喂给引擎。
  2. 引擎先往字典里注入运行时字段（时间戳、自增序号、时长串），并拷贝一份剔除内部键。
  3. 用「外层格式正则」扫模板，每命中一个占位符就交给编译回调。
  4. 编译回调用「内层格式正则」把占位符里的表达式拆成：字段路径（含点遍历 / 切片 / 备选集）、取负、数学运算、日期格式、备选链、替换、默认值。
  5. 取值器沿字段路径取值、取负、算数学、做日期格式化；再按类型字符做转换；按需净化成合法文件名。
  6. 把算好的标量塞进扁平取值表，并把模板里那个复杂占位符**改写**成纯宿主格式占位符（直接引用扁平表里那一条）。
  7. 收尾：对改写后的模板做转义中和游离格式符，再用宿主内置格式化完成最终对齐与代入。

- **最小原理演示**：
  - **应演示**：一个 ~40 行的小实现，演透权衡①「编译 → 扁平取值表 → 借宿主代入」。每一行对应一个原理点：正则拆字段、沿点路径取值、塞扁平表、改写成宿主占位符、最后一步宿主代入只是简单替换。演示应让读者亲眼看到「难的取值/转换都在编译期做完，代入期平凡」。
  - **应故意省略**：文件名净化的三模式、所有类型转换字母、日期格式化、数学运算、备选集 `{...}`、路径展开的边界 hack、exec 安全门、校验逻辑——这些是「语法糖」而非原理核心。
  - **演示载体建议**：**首选 TS/JS**。核心机制（正则拆字段 + 沿路径取值 + 改写成宿主占位符 + 宿主代入）完全语言无关，TS/JS 可忠实演透，无需 Python 特有语义。JS 没有内置 `%(...)s`，故用一个 ~3 行的 `String.replace` 扮演「宿主代入器」的角色——这恰恰让「代入期平凡」这一点更显眼。配最小 `package.json`，`bun run`/`node` 即可跑。无需退化到 Python。

- **正文不宜展开的细节**：文件名净化的三模式（关闭 / 仅替换斜杠为反斜杠占位 / 严格）；每个类型转换字母逐一展开；数学运算为何只支持加减乘、除法为何回退空；备选集 `{a,b}` 语法；路径展开先于模板代入以防元数据里的环境变量被展开；提前编译校验；扩展名强制覆盖（不同输出类型有各自固定扩展名）；向后兼容把序号字段 `%s` 改写成 `%0Nd` 的历史包袱。

- **推荐的一个执行轨迹例子**：
  - 输入：模板 `%(upload_date>%Y-%m-%d)s - %(title).30s.%(ext)s`，字典 `{upload_date: '20230101', title: 'A Very Long Title Indeed', ext: 'mp4'}`。
  - 关键中间态：编译回调对 `upload_date` 取值 `'20230101'` 并按日期格式化成 `'2023-01-01'`、塞进扁平表；对 `title` 取值后**保留** `.30s`（精度截断交给宿主，引擎不处理）。
  - 改写后模板：三个占位符都被改写成引用扁平表的纯宿主格式占位符（`.30s` 原样透传）。
  - 输出：`2023-01-01 - A Very Long Title Indee.mp4`（标题的 30 字截断由宿主在代入期完成）。

> 以上钩子供 Writer 写「动机→核心思想→心智模型→关键权衡→原理演示」；下面事实部分供核对，不要被 Writer 当目录照抄。

## 概念要点

- **两阶段求值的衔接是全章灵魂**：编译期把模板 + 字典压成「宿主格式串 + 扁平取值表」，代入期就是一句宿主格式化。`prepare_outtmpl` 负责编译、`escape_outtmpl(模板) % 取值表` 负责代入。源码位置: yt_dlp/YoutubeDL.py:1522-1524
- **默认模板与各输出类型的固定扩展名**：默认文件名模板、章节模板，以及描述/字幕/缩略图/infojson 等类型对应的固定扩展名（用于强制覆盖）。源码位置: yt_dlp/utils/_utils.py:2873-2889
- **外层格式正则由一个「模板的模板」填充而来**：`STR_FORMAT_RE_TMPL` 带两个占位（key 模式、类型字符集），三处复用——编译期（key=`[^)]*`、类型=标准+自定义）、转义期（key=空、负向断言）、校验期（key=`[^)]*`、类型=仅自定义）。源码位置: yt_dlp/YoutubeDL.py:1295；yt_dlp/utils/_utils.py:2894-2905
- **类型字符集 = 标准 + 自定义**：标准 `diouxXeEfFgGcrsa`（源码位置: yt_dlp/utils/_utils.py:2908）追加自定义 `ljhqBUDS`（源码位置: yt_dlp/YoutubeDL.py:1295）。
- **自定义类型转换语义**：`l` 列表（`#` 换行分隔）、`j` JSON（`#` 缩进、`+` 保留非 ASCII）、`h` HTML 转义、`q` shell 引号、`B` 字节、`U` unicode 归一（`+`/`#` 切换 NFC/KC/NFD）、`D` 十进制后缀（`#` 切 1024/1000）、`S` 文件名净化、`c` 取首字符。源码位置: yt_dlp/YoutubeDL.py:1470-1505
- **NA 占位与可配置**：缺省占位符默认 `'NA'`，可由 `outtmpl_na_placeholder` 覆盖；取值为空时回退到该占位（或用户在模板里用 `|默认值` 覆盖）。源码位置: yt_dlp/YoutubeDL.py:1388, 1426, 1468-1469
- **运行时字段注入（承前 info_dict 的「后注入」）**：求值前注入 `epoch`（时间戳，一旦设置保持一致）、`autonumber`/`video_autonumber`（自增序号）、`duration_string`（按时长派生，文件名用 `-` 分隔、其它用 `:`）、`resolution`（缺省时派生）。源码位置: yt_dlp/YoutubeDL.py:1274-1284
- **拷贝字典剔除内部键**：复制 info_dict 时弹出 `__postprocessors`、`__pending_error` 等内部字段，避免它们泄漏进输出。源码位置: yt_dlp/YoutubeDL.py:1262-1267
- **字段点遍历 / 切片 / 备选集**：`_traverse_infodict` 把 `a.b[0]` / `a{b,c}` 拆成字段序列，交 `traverse_obj(info_dict, fields, traverse_string=True)` 取值（`traverse_string` 允许对字符串按下标切片）。源码位置: yt_dlp/YoutubeDL.py:1333-1347
- **数学运算仅支持加减乘**：`MATH_FUNCTIONS` 只登记 `+/-/*`（用 float 的双下划线方法），遇到除零或类型错误回退空值。源码位置: yt_dlp/YoutubeDL.py:1296-1300, 1358-1378
- **日期格式化**：`>格式` 触发 `strftime_or_none`（反斜杠转义的逗号先还原）。源码位置: yt_dlp/YoutubeDL.py:1379-1381
- **文件名净化三模式**：`sanitize=False` 不净化；非 Windows 且未限制文件名时仅把 `/` 换成全角斜杠占位、清 NUL；否则走严格 `sanitize_filename`（受 `restrictfilenames` / `windowsfilenames` 控制）。源码位置: yt_dlp/YoutubeDL.py:1396-1406
- **exec 安全门（核心安全权衡）**：`_exec=True` 时，转换类型必须属于白名单 `SAFE_EXEC_CONVERSIONS='difq'`，默认值不得含 `UNSAFE_DEFAULT_CHARS`（引号、空白、`;&|^$%*<>{}()[]#\`` 等 shell 元字符），违例抛 `UnsafeExecExpansionError` 并附安全公告链接。源码位置: yt_dlp/YoutubeDL.py:1320-1322, 1447-1464
- **escape_outtmpl 中和游离格式符**：把模板里残留的、未匹配到占位符的 `%s`/`%05d` 之类转义掉，以免代入期被宿主当成占位符触发 KeyError。源码位置: yt_dlp/YoutubeDL.py:1241-1247
- **validate_outtmpl 提前编译校验**：把自定义类型字符替换回 `s`，再尝试对空字典做一次代入，返回 None 或异常，供 CLI 早报错。源码位置: yt_dlp/YoutubeDL.py:1249-1260
- **_outtmpl_expandpath 顺序陷阱**：必须先 `expand_path`（展开 `~/`、环境变量）再做模板代入，且用 32 位随机字母作边界 hack 保护 `%%`/`$$`，否则元数据里的 `$PATH` 会被误展开。源码位置: yt_dlp/YoutubeDL.py:1226-1239
- **_parse_outtmpl 规范化**：把 `params['outtmpl']` 统一成 dict，用 `DEFAULT_OUTTMPL` 补缺，`restrictfilenames` 时把默认模板里的空格换成 `-`。源码位置: yt_dlp/YoutubeDL.py:1207-1215

## 关键调用链

编译期（一条占位符的生命周期）：
`prepare_outtmpl(outtmpl, info_dict)`
 → 注入运行时字段 + 拷贝剔除内部键
 → `EXTERNAL_FORMAT_RE.sub(create_key, outtmpl)`
   → `create_key`：`INTERNAL_FORMAT_RE` 解析占位符表达式
     → `get_value` → `_traverse_infodict` → `traverse_obj(info_dict, …)`
     → 取负 / 数学 / 日期格式化 / 类型转换 / 净化
     → 扁平取值表[NUL-mangle 后的 key] = 标量值
     → 返回改写后的纯宿主占位符 `%(\0key)type`
 → 返回 `(改写后模板, 扁平取值表)`

代入期：`evaluate_outtmpl` → `prepare_outtmpl` → `escape_outtmpl(模板) % 扁平取值表`

复用入口（七处投影）：文件名（`_prepare_filename`，sanitize=True）、控制台打印与写文件（`_forceprint`）、下载进度行与终端标题（下载器）、后处理进度行与标题（后处理器基类）、元数据解析 PP、章节标题 PP、exec 命令。
源码位置: yt_dlp/YoutubeDL.py:1269-1524, 1533, 3248-3256；yt_dlp/downloader/common.py:331-336；yt_dlp/postprocessor/common.py:189-193；yt_dlp/postprocessor/metadataparser.py:69；yt_dlp/postprocessor/modify_chapters.py:304；yt_dlp/postprocessor/exec.py:20-37

## 源码摘录（带行号，全文累计 ≤ 30 行）

两阶段衔接——编译期产出改写模板 + 扁平表，代入期就是一句宿主格式化：

```python
1522	    def evaluate_outtmpl(self, outtmpl, info_dict, *args, **kwargs):
1523	        outtmpl, info_dict = self.prepare_outtmpl(outtmpl, info_dict, *args, **kwargs)
1524	        return self.escape_outtmpl(outtmpl) % info_dict
```

内层格式正则——一条正则吃下「取负 / 字段 / 数学 / 日期 / 备选 / 替换 / 默认」六种语义，定义了整门 DSL 的语法（对应权衡④）：

```python
1310	        INTERNAL_FORMAT_RE = re.compile(rf'''(?xs)
1311	            (?P<negate>-)?
1312	            (?P<fields>{FIELD_RE})
1313	            (?P<maths>(?:{MATH_OPERATORS_RE}{MATH_FIELD_RE})*)
1314	            (?:>(?P<strf_format>.+?))?
1315	            (?P<remaining>
1316	                (?P<alternate>(?<!\\),[^|&)]+)?
1317	                (?:&(?P<replacement>.*?))?
1318	                (?:\|(?P<default>.*?))?
1319	            )$''')
```

备选链 + 默认值循环——字段取不到值就按 `,` 试下一个备选字段，全程累积 `|默认值`（对应权衡④）：

```python
1426	            value, replacement, default, last_field = None, None, na, ''
1427	            while mobj:
1428	                mobj = mobj.groupdict()
1429	                default = mobj['default'] if mobj['default'] is not None else default
1430	                value = get_value(mobj)
1431	                if value is None and mobj['alternate']:
1432	                    mobj = re.match(INTERNAL_FORMAT_RE, mobj['remaining'][1:])
1433	                else:
1434	                    break
```

编译回调的收尾——把算好的标量塞进扁平表，并把复杂占位符改写成纯宿主占位符（NUL 字符隔离 key、key 内的 `%` 换成 `%\0` 防冲突；`fmt` 原样透传给宿主，对应权衡①②）：

```python
1516	            key = '{}\0{}'.format(key.replace('%', '%\0'), outer_mobj.group('format'))
1517	            TMPL_DICT[key] = value
1518	            return '{prefix}%({key}){fmt}'.format(key=key, fmt=fmt, prefix=outer_mobj.group('prefix'))
```

exec 安全门——命令模板只许 `difq` 这几种转换类型，否则在注册期就抛错（对应权衡③）：

```python
1448	            if _exec:
1449	                if fmt[-1] not in SAFE_EXEC_CONVERSIONS:
1450	                    raise UnsafeExecExpansionError(
1451	                        f'Unsafe conversion(s) in exec command: {outtmpl!r}\n ... use %()q instead. ...')
```

## 易混淆 / 边界 / 推断

- **事实**：急切求值——模板里每个字段在编译期就全部算好塞进扁平取值表，代入期只是宿主格式化；不存在惰性求值。源码位置: yt_dlp/YoutubeDL.py:1516-1520
- **事实**：改写后的 key 含 NUL 字符（`\0`）做隔离，且 key 内的 `%` 被替换成 `%\0`，防止与外层宿主 `%` 语法冲突。源码位置: yt_dlp/YoutubeDL.py:1516
- **事实**：exec PP 的命令解析**手动镜像**了求值入口（先编译再转义再 `%`），因为当「模板里没有任何占位符」时它要走一条旧的 `{}` 文件路径兼容分支。源码位置: yt_dlp/postprocessor/exec.py:20-31
- **事实**：exec 安全校验在 `set_downloader`（后处理器注册期）就跑一次 `_exec=True` 的编译，运行期解析命令不再校验；注册期抛错会被编排器捕获上报。源码位置: yt_dlp/postprocessor/exec.py:12-18；yt_dlp/YoutubeDL.py:836-842
- **推断**：之所以「编译成宿主格式化」而非自写代入器，是为了零成本继承宿主格式串的宽度/精度/对齐——`fmt` 直接透传并在代入期生效。依据：编译回调保留 `outer_mobj.group('format')` 并写回 `%(...)fmt`。源码位置: yt_dlp/YoutubeDL.py:1466-1467, 1518
- **推断**：进度模板复用同一引擎，靠 `{'info':…,'progress':…}` 嵌套子字典 + 字段点遍历（如 `progress._default_template`）实现「同一语法投影进度」。源码位置: yt_dlp/downloader/common.py:326-336
- **未理解**：`field_size_compat_map` 把 `playlist_index`/`autonumber` 的 `%s` 偷偷改写成 `%0Nd` 仅为向后兼容，其历史动机（为何不直接要求用户写 `03d`）未在代码注释中说明。源码位置: yt_dlp/YoutubeDL.py:1286-1292, 1444-1445
# 格式选择 DSL：从 -f 串到选择器 AST · 源码精读

## 给 Writer 的教学钩子（必填，8 子项缺一不可）

- **用户痛点 / 场景**：一个视频站点往往同时给出几十种格式——纯视频轨、纯音频轨、预合并的整体文件、不同分辨率/编码/容器、带 DRM 的、storyboard 预览图……用户只想说一句"我要 720p 以下最好的、音视频分开下然后合并，实在不行就给我一个整体文件"。如果没有这门小语言，用户就得写一段命令式的遍历+比较+回退代码，而且每个站点的"最好"定义还不一样。痛点是：**如何用一行声明式表达把"挑格式"这件高度条件化的事讲清楚**。

- **一句话核心思想**：**选择器自己从不比较任何两个格式——它先让一个独立的排序器把候选排成唯一的基准序，然后只做"取第 N 个"的位置运算；那门外人以为在做比较的格式选择小语言，其实编译成的是在一棵小 AST 上对已排序列表做"过滤 / 取下标 / 合成 / 兜底"。**

- **设计动机（为什么需要它）**：把"什么算更好"（分辨率、编码偏好、有没有视频……十几个互相冲突的键）和"我要哪种组合"（单个 / 音视频合并 / 多个兜底）这两件本质独立的事拆开：前者是一次性、全局成立的多键排序问题；后者是用户每次都不同的声明式意图。把它们耦合进同一段代码会得到一个既不懂偏好又不懂语法的怪物；拆开后，排序器只管产基准序、选择器只管在序上做位置运算，各自简单。
  - **承前关系（跨章去重信号）**：（已在第 4 章『info_dict 数据总线与提取器骨架』讲透"胖字典当万能数据总线、各阶段对字典做纯变换"——本章的格式选择正是这样一个纯变换：读字典里的 formats 列表，返回一个子列表或一个合成字典，本章只看它的新侧面：**如何把一门迷你查询语言编译成对这个列表的位置运算，以及选择为何被刻意做成"不比较、只取下标"**）。下游的真正混流动作则交给后处理流水线，本章不展开。

- **关键权衡（核心原料）**：
  1. **排序与选择分离（sort-then-pick-by-index，全章灵魂）**：选择"用一个独立排序器产出基准序、选择器只做位置取值" → 换来选择器逻辑极简（它根本不懂"什么算更好"，十几个排序键、正反、限值、closest 全归排序器管） → 代价是正确性强依赖排序必须先跑、且依赖运行前给每个格式回填缺失字段（协议、扩展名、码率），否则取的下标全是错的。
  2. **复用宿主语言自带的词法器**：选择"不自己写词法器，直接拿 Python 标准库的 tokenize 来切词法" → 换来立刻拿到词类型与列位置、错误信息能带光标定位、不必维护一套独立文法 → 代价是借来的工具是为另一种语言（Python 代码）做的，得用 hack 修补语义偏差（给数字串加随机字母前缀以绕过新版解析器、把"非特殊运算符"重新粘回字符串），代码里甚至留了 TODO 想有一天换掉它。
  3. **先建 AST 再把每个节点编译成惰性生成器闭包**：选择"解析阶段产出四种固定节点的树，求值阶段把每个节点编译成一个 Python 生成器闭包，选择时就是原生生成器迭代、没有运行时树遍历解释器" → 换来求值零分发开销，且生成器的惰性天然让昂贵的格式探测只跑到"取到的那个下标"为止 → 代价是调试困难（运行时是一摞嵌套闭包，错误栈不直观）。
  4. **合并格式是"虚构字典"而非真实文件**：选择"音视频合并在选择阶段不下载任何东西，而是凭空造一个合成格式字典（带兼容输出扩展名、累加码率、标注两路原始格式），交给下游阶段当真格式处理" → 换来选择逻辑保持纯函数、与真正的混流阶段彻底解耦 → 代价是这个虚构格式要"骗得过"下游（扩展名/协议字段得让后续下载与混流都觉得合理），真正的合并动作被推迟到后处理。

- **最小心智模型（3～7 步）**：
  1. 排序器先按约 19 个键（有没有视频、提取器偏好、语言、分辨率、帧率、HDR、编码偏好、码率、协议、扩展名……）把候选格式排成唯一的"从差到好"基准序（升序：索引 0 = 最差，末尾 = 最好）。
  2. 选择器拿到用户的选择串，先用宿主语言自带的词法器切成 token，再用递归下降解析成一棵小 AST：原子 / 合并 / 兜底 / 分组 四种节点，外加可挂载在任意原子上的过滤器。
  3. 解析的优先级用"递归调用 + 回退一个 token"的标志位编码（合并比兜底结合更紧）。
  4. 求值时把 AST 每个节点编译成一个惰性生成器闭包；过滤器作为最外层包裹，在取下标之前先收紧候选集。
  5. 原子节点先按类型修饰符（最好/最差、只要视频/只要音频、`*` 容错）过滤候选，再在（按需反转过的）基准序里"取第 N 个"。
  6. 合并节点把两路选择做笛卡尔积，对每对凭空造一个合成格式字典。
  7. 兜底节点依次试每个分支，第一个非空即返回——这就是用户用 `/` 表达"优雅降级"的地方。

- **最小原理演示（替代旧"复刻范围"）**：
  - **应演示**：一个几十行的从零实现，演透三条原理——①排序产出基准序、选择器只做位置取值；②四种 AST 节点编译成生成器闭包；③过滤器在取下标前先收紧候选。每一行都要对应上面某条权衡。
  - **应故意省略**：借用宿主词法器（演示里改用极简手写词法以保持小巧，并注明"真实实现借了 tokenize"）、19 键完整排序器、`*` 修饰符与 incomplete_formats 的微妙回落、格式探测下载、文件大小后缀解析、字符串匹配算子族、容器兼容矩阵、字段回填。
  - **演示载体建议：首选 TS/JS**。本章核心是"数据结构 + 递归下降解析 + 闭包求值 + 多键排序"，纯粹是算法与 DSL 编译，TS/JS 完全忠实演透，无任何语言特有语义依赖；用 TS 配最小 `package.json` 即可 `bun run`/`node` 跑，对本 Atlas 的 JS 生态读者最友好。无需退回原仓库语言（Python）。
  - 演示骨架（Writer 据此实现，每段标注演的是哪条权衡）：
    ```ts
    type Fmt = { id: string; vcodec: string; acodec: string; height: number; tbr: number };
    // 【权衡①】排序器：独立产出「从差→好」升序基准序；选择器后续只信它，自己从不比较
    function sortFormats(fs: Fmt[]): Fmt[] {
      // 简化：真实实现是 ~19 键的多键比较；这里用「有视频优先 + 分辨率 + 码率」演示多键
      return [...fs].sort((a, b) =>
        Number(a.vcodec !== 'none') - Number(b.vcodec !== 'none') || a.height - b.height || a.tbr - b.tbr);
    }                       // 升序 ⇒ 索引0=最差，末尾=最好（与真实方向一致）
    // 【权衡③】AST 四节点（演示用三种：原子/合并/兜底）
    type Node = { t: 'single'; spec: string } | { t: 'merge'; a: Node; b: Node } | { t: 'fallback'; a: Node; b: Node };
    // 递归下降解析（手写极简词法——真实实现借 tokenize，此处刻意简化以演解析结构）
    function parse(tk: string[]): Node { let i = 0;
      const atom = (): Node => ({ t: 'single', spec: tk[i++] });
      const merge = (): Node => { let n = atom(); while (tk[i] === '+') { i++; n = { t: 'merge', a: n, b: atom() }; } return n; };
      const expr = (): Node => { let n = merge(); while (tk[i] === '/') { i++; n = { t: 'fallback', a: n, b: merge() }; } return n; };
      return expr(); }                       // + 比 / 结合更紧，由嵌套层次天然表达
    // 【权衡③】把每节点编译成惰性闭包；【权衡①】取值是位置运算；【权衡④】合并=笛卡尔积+合成字典
    function compile(n: Node, filter?: (f: Fmt) => boolean) {
      const run = (n: Node) => (ctx: { formats: Fmt[] }): Fmt[] => {
        const fs = filter ? ctx.formats.filter(filter) : ctx.formats;      // 过滤器先收紧候选
        if (n.t === 'single') { const rev = n.spec.startsWith('best'); const ord = rev ? [...fs].reverse() : fs; return [ord[0]]; }
        if (n.t === 'merge')  { const a = run(n.a)(ctx), b = run(n.b)(ctx); return a.flatMap(v => b.map(au => ({ ...v, ...au, id: v.id + '+' + au.id }))); }
        if (n.t === 'fallback') { const a = run(n.a)(ctx); return a.length ? a.slice(0, 1) : run(n.b)(ctx).slice(0, 1); } // 首个非空
        return []; };
      return run(n); }
    // 演权衡①：选择器对『更好』一无所知，全靠 sortFormats
    const sel = compile(parse('bestvideo + bestaudio / best'.split(' ')));
    ```

- **正文不宜展开的细节**：过滤器的字符串算子族（`^=`/`$=`/`*=`/`~=` 正则、`!` 取反、`?` none-inclusive）；运行前字段回填的细节（协议/扩展名推断、HEVC-over-FLV 特例罚分、码率互相推算）；默认选择串如何依 ffmpeg 可合并性/is_live/输出到 stdout 探测；惰性列表的实现与"格式探测下载"的耦合；合成字典里容器兼容矩阵与 prefer_free_formats；排序键的别名/弃用名表与 ordered 类型的正则位次排名。

- **推荐的一个执行轨迹例子**：输入 `bv*+ba/b`（尽量要分离的最好视频+最好音频，退化到单个最好），候选已排成"从差→好"。解析得 `兜底( 合并(容错最好视频, 最好音频), 原子(最好) )`。求值先试左支：容错最好视频在基准序里取最好的视频轨（若无纯视频轨则因 `*` 容错回落到预合并的最好），最好音频取最好的音频轨，两者做笛卡尔积得 1 个合成格式（`requested_formats=[视频,音频]`、扩展名取兼容容器、码率累加）→ 非空，返回它。真正的混流推迟到后处理。若站点只有预合并整体文件且无任何纯轨：左支无匹配 → 兜底走右支原子(最好) → 返回单个最好格式。

> 以上钩子供 Writer 写"动机→核心思想→心智模型→关键权衡→原理演示"；下面事实部分供核对，不要被 Writer 当目录照抄。

## 概念要点

- **两段式架构**：排序（FormatSorter）产基准序 + 选择（build_format_selector）做位置运算，二者解耦。选择入口 `_select_formats` 组装上下文 ctx（formats / has_merged_format / incomplete_formats）后调用编译好的选择器闭包。
  源码位置: yt_dlp/YoutubeDL.py:2311-2317

- **基准序由 FormatSorter.calculate_preference 产出**：返回一个多键元组作为 sort key，`formats.sort` 后为"从差→好"升序（索引 0 = 最差，末尾 = 最好）——这点决定了下面"取下标"的方向。排序发生在 process_video_result 的早期。
  源码位置: yt_dlp/utils/_utils.py:5664-5666, yt_dlp/YoutubeDL.py:2833-2836, 2996

- **默认排序键约 19 个字段**，带 priority（优先于用户键）与 forced（强制保留、不可被用户覆盖）两类标志。
  源码位置: yt_dlp/utils/_utils.py:5370-5372, 5539-5543

- **多键比较用元组编码方向/限值/缺失**：每个字段的偏好被编成 `(档位, 值, 0)` 形式的子元组——`(-10,0)` 表示缺失值排末尾、`(1,值,0)` 让字符串排得比数字高、`(0,-abs(值-limit),…)` 实现"最接近限值（closest）"、正/反方向也编码进元组符号。一个 `sort()` 即统一处理所有键的各异语义。
  源码位置: yt_dlp/utils/_utils.py:5609-5614

- **ordered 类型按"正则位次"排名而非数值**：编码（av01 > vp9.2 > vp9 > h265 > h264 > vp8 > …）、协议（https > http > m3u8 > dash > …）、容器、HDR 都用"在 order 列表里的位置"打分，`list_length - index`。这让"哪种编码更好"成为可配置的有序表，而非硬编码数值。
  源码位置: yt_dlp/utils/_utils.py:5381-5394, 5499-5510

- **词法分析借用 Python 标准库 tokenize**：把选择串当 Python 表达式 tokenize，拿到 NAME/NUMBER/OP 词类型与列位置。为绕过 Python 3.12 解析器对 `7_a` 这类串的拒收，给所有数字串加 32 位随机字母前缀，tokenize 后再剥掉（代码注释标了 HACK 与 TODO"将来换成不依赖 tokenize 的解析器"）。
  源码位置: yt_dlp/YoutubeDL.py:2653-2662

- **`_remove_unused_ops` 把"非特殊运算符"重新粘回字符串**：只保留 `/ + , ( )` 作为结构运算符，其余（如 `-`）被合并回相邻字符串，使 `mp4-baseline-16x9` 成为一个 NAME 原子而非三个 token。
  源码位置: yt_dlp/YoutubeDL.py:2367-2396

- **AST 是一个 namedtuple + 四种节点类型**：`FormatSelector(type, selector, filters)`，type ∈ {SINGLE, MERGE, PICKFIRST, GROUP}；filters 是挂在该节点上的过滤条件字符串列表。
  源码位置: yt_dlp/YoutubeDL.py:2350-2354

- **优先级用递归调用 + restore_last_token 编码**：`_parse_format_selection` 带 inside_merge/inside_choice/inside_group 三个标志递归；遇不属于本层的运算符就 `tokens.restore_last_token()`（回退计数器）并 break，把该运算符留给外层处理——于是 `+`（合并）比 `/`（兜底）结合更紧。
  源码位置: yt_dlp/YoutubeDL.py:2398-2454（尤 2413-2447）

- **求值 = 把 AST 编译成生成器闭包**：`_build_selector_function` 对每种节点返回一个 `selector_function(ctx)` 生成器；AST 只编译一次（构造期或首次选择），选择时即原生生成器迭代。
  源码位置: yt_dlp/YoutubeDL.py:2545-2651

- **原子节点 = 过滤 + 位置取值**（全章灵魂落点）：用 filter_f 过滤候选，再 `matches[format_idx - 1]` 取第 N 个（best.2 → 下标 1）；`format_reverse`（best 为真）控制是否 `[::-1]` 反转——因为基准序是"从差→好"，best 需反转后取下标 0。
  源码位置: yt_dlp/YoutubeDL.py:2626-2642

- **best/worst 的 filter_f 由 type+modifier 组合决定**：`b`/`w` 须同时有视频和音频（预合并）；`bv`/`ba` 须"该轨有 + 另一轨为 none"（纯轨）；`bv*`/`ba*` 该轨有即可（容错，可回落到预合并）；`b*`/`w*` 任意。正则 `(?P<bw>best|worst|b|w)(?P<type>video|audio|v|a)?(?P<mod>\*)?(\.(?P<n>[1-9]\d*))?`。
  源码位置: yt_dlp/YoutubeDL.py:2592-2614

- **两类"回落"用 ctx 标志驱动**：format_fallback（仅 `b`/`w`）在 `incomplete_formats`（全纯音或全纯视频）时回落到纯轨；seperate_fallback（扩展名原子）在 `has_merged_format` 为假时回落到该扩展名的纯视频轨。这是用户感知到的"容错"的真正实现处。
  源码位置: yt_dlp/YoutubeDL.py:2630-2637, 2314-2316

- **MERGE 求值 = 笛卡尔积 + `_merge` 合成字典**：`itertools.product(selector_1(ctx), selector_2(ctx))`，对每对调 `_merge` 产合成格式（requested_formats、兼容输出扩展名 via get_compatible_ext、累加 tbr、视频字段取自唯一视频轨/音频字段取自唯一音频轨）。合并在此是"造字典"，不下载。
  源码位置: yt_dlp/YoutubeDL.py:2567-2572, 2456-2528

- **PICKFIRST 求值 = 依次试、首个非空即返回**；GROUP = 透传子选择器；逗号列表 = 逐个 yield（下载多个）。
  源码位置: yt_dlp/YoutubeDL.py:2546-2566

- **过滤器作为最外层 final_selector 包裹**：在调实际 selector_function 之前，先用各 filter 谓词逐道收紧 `ctx_copy['formats']`。
  源码位置: yt_dlp/YoutubeDL.py:2644-2651

- **过滤器编译 `_build_format_filter`**：数值版 `[height<=?720]`（`?` = none-inclusive，字段缺失时算匹配；值支持 1M 等文件大小后缀）；字符串版 `[proto^=http]`/`[$=mp4]`/`[*=x]`/`[~=正则]`，支持 `!` 取反。返回谓词 `_filter(f)`。
  源码位置: yt_dlp/YoutubeDL.py:2205-2270

- **选择器在 YoutubeDL 构造期预编译**（以便提早暴露语法错误），但也可在交互式 `-F` 时按用户即时输入重编译；无显式 `-f` 时由 `_default_format_spec` 依 ffmpeg 可合并性/is_live/输出到 stdout 决定默认串。
  源码位置: yt_dlp/YoutubeDL.py:817-821, 2319-2341, 3067-3089

## 关键调用链

```
process_video_result
  → sort_formats(info_dict)                                  # 先排基准序（从差→好）
      → FormatSorter(ydl, _format_sort_fields).calculate_preference  # 多键元组 sort key
      → formats.sort(key=...)                                # 升序：idx0=最差，末尾=最好
  → _select_formats(formats, format_selector)                # 进入选择
      → format_selector(ctx)   # = _build_selector_function(parsed_selector) 返回的 final_selector
          → final_selector: 先用 [filters] 逐道收紧 ctx['formats']
          → selector_function(ctx_copy):
              SINGLE  : filter_f 过滤 → matches[::-1 若 best] → yield matches[format_idx-1]   # 位置取值
              MERGE   : itertools.product(左, 右) → yield _merge(每对)                         # 造合成字典
              PICKFIRST: 依次试各分支 → 首个非空即 return                                       # / 兜底
              GROUP/列表: 透传 / 逐个 yield
```

## 源码摘录（带行号，全文累计 ≤ 30 行）

AST 节点定义（四种 type + filters）：
```python
FormatSelector = collections.namedtuple('FormatSelector', ['type', 'selector', 'filters'])
```
源码位置: yt_dlp/YoutubeDL.py:2354

解析：`/` 与 `+` 构造兜底/合并节点（`+` 在更内层的递归里被处理，故结合更紧）：
```python
elif string_ == '/':
    ...
    current_selector = FormatSelector(PICKFIRST, (first_choice, second_choice), [])
elif string_ == '+':
    ...
    current_selector = FormatSelector(MERGE, (selector_1, selector_2), [])
```
源码位置: yt_dlp/YoutubeDL.py:2427-2447（节选）

PICKFIRST 求值——首个非空即返回（演 `/` 兜底）：
```python
def selector_function(ctx):
    for f in fs:
        picked_formats = list(f(ctx))
        if picked_formats:
            return picked_formats
    return []
```
源码位置: yt_dlp/YoutubeDL.py:2560-2565

MERGE 求值——笛卡尔积 + 合成字典（演"合并不下载，只造字典"）：
```python
def selector_function(ctx):
    for pair in itertools.product(selector_1(ctx), selector_2(ctx)):
        yield _merge(pair)
```
源码位置: yt_dlp/YoutubeDL.py:2570-2572

SINGLE 求值——过滤后位置取值（全章灵魂：选择器不比较，只取下标）：
```python
matches = LazyList(_check_formats(matches[::-1 if format_reverse else 1]))
try:
    yield matches[format_idx - 1]
except LazyList.IndexError:
    return
```
源码位置: yt_dlp/YoutubeDL.py:2638-2642

过滤器作为最外层包裹（取下标前先收紧候选）：
```python
def final_selector(ctx):
    ctx_copy = dict(ctx)
    for _filter in filters:
        ctx_copy['formats'] = list(filter(_filter, ctx_copy['formats']))
    return selector_function(ctx_copy)
```
源码位置: yt_dlp/YoutubeDL.py:2646-2651

借用 tokenize 词法的 3.12 兼容 HACK（演"借来的工具要打补丁"）：
```python
prefix = ''.join(random.choices(string.ascii_letters, k=32))
stream = io.BytesIO(re.sub(r'\d[_\d]*', rf'{prefix}\g<0>', format_spec).encode())
```
源码位置: yt_dlp/YoutubeDL.py:2657-2658

## 易混淆 / 边界 / 推断

- **事实**：基准序方向是"从差→好"（升序），故 best 用 `[::-1]` 反转后取下标 0，worst 不反转直接取下标 0——容易看反。
  源码位置: yt_dlp/YoutubeDL.py:2599, 2638
- **事实**：`bv` 与 `bv*` 的差别在 filter_f：`bv` 要求"另一轨为 none"（纯视频轨），`bv*` 只要求"视频轨有"（可匹配预合并）。`b`/`w`（无修饰）默认要求同时有音视频。
  源码位置: yt_dlp/YoutubeDL.py:2604-2614
- **事实**：选择器对 formats 列表的"好坏"毫无判断，全靠 sort_formats 已跑过；若跳过排序或字段未回填（`_fill_sorting_fields` 补协议/扩展名/码率），取的下标无意义。
  源码位置: yt_dlp/utils/_utils.py:5628-5662, yt_dlp/YoutubeDL.py:2971
- **推断**：`matches[format_idx - 1]` 用的是惰性列表（LazyList），配合 `_check_formats` 的"探测下载"，意味着带 DRM/未测格式只在被取到时才真正发起探测，未取到的候选不会被探测——这是把"昂贵探测"藏进惰性求值的刻意设计（标注为推断：基于 LazyList 已知语义与 `_check_formats` 网络副作用推断，未逐行验证 LazyList 实现）。
  源码位置: yt_dlp/YoutubeDL.py:2530-2543, 2638-2642
- **事实**：合并产生的合成字典是"虚构格式"，其 `protocol` 字段是两路协议用 `+` 拼接、`ext` 由 get_compatible_ext 选兼容容器——下游必须容忍这种合成字段。
  源码位置: yt_dlp/YoutubeDL.py:2495-2505
- **未理解**：`_merge` 内部对 `allow_multiple_streams` 的去重逻辑（pop 时索引处理）在多路合并的边界情形下是否完全正确，未深入验证；不影响本章主原理。
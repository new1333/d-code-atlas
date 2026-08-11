# CLI 层：从命令行表面到 ydl_opts 与声明式流水线

> 本章属于 system 层。前置：『YoutubeDL 编排器：贯穿各阶段的 info_dict 主管线』、『声明式后处理流水线与链式 info 变换』。
> 学完你能：用一句话讲清"为什么核心下载器从不直接碰命令行——所有脏活都被前置到一道独立的清洗工序里"。

## 1. 为什么需要它（设计动机）

上一章把 YoutubeDL 讲成一个胖协调器——它把同一个 info_dict 贯穿提取、下载、后处理五六个阶段，独占所有横切关注点。但它有一个隐藏前提没交代：它接受的入参 `ydl_opts` 是一张**已经干净、已校验、已归一化**的大字典，里面没有命令行字符串、没有冲突开关、没有兼容垫片。这张干净的字典从哪来？这就是本章要接住的口子。

想象一下用户面对的东西：数百个开关、四五份配置文件（便携版/家目录/用户级/系统级）、一堆为兼容 youtube-dl 留下的老选项、还有用户自己写的 `--alias` 命令行宏。这些来源彼此覆盖、互斥、还会随版本演进。如果核心下载器直接吃这种原始命令行，里面会立刻被无穷的 `if 兼容老行为 else if 转码 else if 嵌字幕` 淹没，永远无法被当作库干净调用。

于是整套机制被前置到一道独立工序里：把多源输入分层合并、把字符串解析成结构化数据、把兼容/弃用项翻译成新选项默认值、把互斥开关的冲突解决掉、把一堆布尔开关展开成一条有序的加工流水线——最后产出的那张纯参数表，才是核心的唯一入口。

## 2. 核心思想

**命令行层是一道独立的"脏活清洗器 + 翻译器"，不是核心的一部分。** 它把混乱多源的命令行表面压成一张纯参数表，让核心与终端彻底解耦。

关键的抽象动作是：清洗层把核心的输入接口从"原始命令行"上移到了"纯参数表"。换句话说，"用户怎么表达意图"和"核心怎么执行意图"被拆到了两个不相干的层——命令行层负责把所有表达方式（命令行/配置文件/兼容老工具/别名）翻译成同一种参数表，核心只负责执行那张表。两边可以各自演进：清洗层重构不影响核心，核心重写内部不触动清洗层。

## 3. 心智模型

命令行清洗是一条单向五步流水线，顺序固定不可调换：

```
收集 → 预处理重写 → 解析 → 兼容垫片 → 校验 → 翻译流水线 → 组装
 (分层累积)  (别名展开)  (回调转结构)  (老→新默认)  (冲突/归一化)  (开关→PP)  (搬进 ydl_opts)
```

**配置层** 是"收集"这一步的单位。命令行本身只是其中一层，且优先级最高；下面还有便携/家/用户/系统四层，每层都是一份选项文件。"忽略配置"开关甚至能反向阻断更低层的载入——系统级配置可以决定"用户级配置不要加载"，而非仅仅覆盖值。

**回调三件套** 是"解析"这一步的核心：选项解析器不直接产出最终值，而是借助三个回调（变列表、变集合、变字典）把字符串就地转成核心能直接消费的结构化数据。

**互斥冲突解决器** 是"校验"这一步的统一出口：当某个"解锁开关"（如 `--allow-unplayable-formats`）启用时，成批与之冲突的开关（嵌元数据/字幕/缩略图、抽取音频、转码等）一律被静默置回默认值，并产"被忽略"警告。

**翻译表** 是"翻译流水线"这一步的产物：一张有序的"开关→加工步骤"表，按固定顺序 yield 出步骤字典；步骤间的先后依赖靠 yield 的物理顺序 + 作者注释保证（没有显式依赖图）。

最后**组装** 把清洗过的字段逐个手工搬进一张约 160 键的大字典，连同那条流水线整体塞进去，交给核心。

## 4. 关键权衡

### 4.1 脏活前置换核心与终端彻底解耦

清洗层把所有兼容、归一化、冲突解决、翻译都揽在自己身上，核心只认一份"已干净的参数表"。

- **换来**：同一个核心能跑命令行、能当库被 import、能被 GUI 前端调用，三种入口对核心完全等价。
- **代价**：必须维护一张上百字段、手工逐字段搬运的"选项→参数"映射表；新增一个开关要改声明、校验、映射、流水线多处。
- **本质矛盾**：这是"外部表现自由度"与"内核纯净度"的对立——清洗层把外部表现的所有复杂度吸收掉，内核才能保持单一可推理形态。任何想让内核能被多种前端平等复用的系统都会撞上这道取舍，路径几乎只有这一条：在中间加一道清洗层。

### 4.2 配置分层累积而非整体覆盖

配置文件按便携→家→用户→系统的顺序逐层 append 进累加器，命令行最后作为最高优先级层叠加，合并时按层序逐字段覆盖。

- **换来**：多级配置可叠加共存（系统级配置 + 用户偏好 + 一次命令行临时覆盖可以三层都生效）；并且能在系统级配置里用"忽略配置"开关反向阻断用户级配置的载入。
- **代价**：合并语义复杂，肉眼难以判断"某个值到底从哪一层来"，只能靠详细模式打印分层追溯排查。
- **本质矛盾**：这是"多主体各自主张"与"最终单一决策"的对立——管理员、用户、当前命令各想各的，最后必须坍缩成一份。累积式合并是允许各层都"留个脚印"的最弱约束合并；与之对立的是整体覆盖（后者简单但失去分层表达力）。任何多源配置系统都绕不开这个取舍。

### 4.3 字符串就地解析成结构化数据

解析阶段不直接产出最终值，而是借助"回调三件套"把字符串开关当场转成列表/集合/字典。

- **换来**：参数表里直接就是核心能用的结构（加工器参数是字典、字幕语言是列表、颜色策略是集合），校验层和核心都不需要再做语法解析。
- **代价**：回调函数签名古怪（要适配老选项解析库"无返回值、靠改 parser.values 生效"的约定），解析逻辑分散在选项声明里而非集中在校验处，阅读选项声明时必须同时读懂其回调。
- **本质矛盾**：这是"语法处理位置"的对立——集中校验 vs 边解析边结构化。集中校验的好处是一处看全、坏处是字符串必须先以原始形态流过整个校验链；就地解析让 token 一读到就立刻定型，省去后续反复解析，但逻辑被打散到声明里。任何要把一堆命令行 token 变成程序参数的系统都站在这条分叉口。

### 4.4 别名靠"塞回待解析队列"实现零侵入宏

`--alias` 在声明期动态造出新选项；触发时把别名代表的原始开关串（经 shell 分词）塞回待解析队列头部，相当于在解析前重写了命令行。预设别名（mp3/aac/mp4/mkv/sleep）走同一通道。

- **换来**：别名机制零侵入核心解析逻辑——别名可以引用任何已有开关、连参数占位都支持，本质就是"命令行宏"。
- **代价**：别名展开发生在解析之前、且可自我递归（别名 A 展开成包含别名 B 的串），必须设触发次数上限防爆；同时别名的实际效果对用户不透明，错误排查需手动展开。
- **本质矛盾**：这是"宏展开位置"的经典对立——前置重写（宏在词法层就展开）vs 后置翻译（宏在语义层才翻译）。前置重写让宏与现有指令完全等价，代价是失去语义校验时机、必须单独防递归。这套取舍和 C 预处理器、shell alias 走的是同一条路。

### 4.5 弃用选项静默吸收而非报错

弃用开关被注册为只调一个记录回调、且帮助文本标记为隐藏；触发时不报错，只把自身名字累计进一个列表，校验层再统一转成"弃用警告"。

- **换来**：向后兼容与平滑迁移——老脚本不会因为某个被废弃的开关而崩，用户有时间逐步迁移。
- **代价**：弃用开关列表只增不减，是长期维护债；兼容老工具（youtube-dl）的整套"兼容选项"还要在校验前另垫一层翻译（把兼容项翻译成新选项默认值覆盖，用户若已显式设置则把该兼容项标记为"已失效"）。
- **本质矛盾**：这是"接口稳定性"与"代码精简度"的对立——保留旧入口永远不碎、但旧代码越积越多；激进删除让代码精简、但破坏既有脚本。任何长生命周期 CLI 工具都会被这条取舍拽住，常见折中就是"静默吸收 + 隐藏帮助 + 弃用警告"。

## 5. 最小原理演示

下面这段 TS 演示清洗层的核心四步：分层合并 → 冲突校验 → 翻译流水线 → 组装纯参数表交给核心。它对应权衡 4.1（脏活前置）、4.2（分层累积）、4.3（结构化产出）。

```ts
type Layer = 'portable' | 'home' | 'user' | 'system' | 'cli'

// 一层配置 = 一组开关，命令行只是其中最高优先级的一层
type RawOpts = {
  extractAudio?: boolean
  embedSubs?: boolean
  embedMetadata?: boolean
  format?: string
  ignoreConfig?: boolean
  allowUnplayable?: boolean
}

// 加工步骤声明式：只声明 key 与参数，不携带行为
type PPStep = { key: string; when?: 'pre' | 'post'; [k: string]: unknown }

// 核心只读这张纯参数表，从不接触原始开关
type YdlOpts = {
  format: string
  extractAudio: boolean
  postprocessors: PPStep[]
  simulate: boolean
}

// 假核心：只读纯参数表
function core(opts: YdlOpts) {
  return { received: opts }
}

// 分层合并：按层序逐字段覆盖，命令行最后写胜
function mergeLayers(layers: { layer: Layer; opts: RawOpts }[]): RawOpts {
  const ordered = ['portable', 'home', 'user', 'system', 'cli'] as const
  const sorted = [...layers].sort(
    (a, b) => ordered.indexOf(a.layer) - ordered.indexOf(b.layer),
  )
  const merged: RawOpts = {}
  for (const { layer, opts } of sorted) {
    // "忽略配置"层能反向阻断更低层载入，分层累积特有的表达力
    if (opts.ignoreConfig && layer !== 'cli') continue
    Object.assign(merged, opts)
  }
  return merged
}

// 互斥冲突解决：解锁开关启用时，成批冲突开关静默置默认
function validate(opts: RawOpts): { opts: RawOpts; warnings: string[] } {
  const warnings: string[] = []
  if (opts.allowUnplayable) {
    for (const k of ['embedSubs', 'embedMetadata', 'extractAudio'] as const) {
      if (opts[k]) {
        warnings.push(`--${k} is ignored since --allow-unplayable was given`)
        opts[k] = false
      }
    }
  }
  return { opts, warnings }
}

// 翻译流水线：开关→有序加工步骤，先后约束靠 yield 顺序 + 注释固化
function buildPostprocessors(opts: RawOpts): PPStep[] {
  const steps: PPStep[] = []
  if (opts.extractAudio) {
    steps.push({ key: 'FFmpegExtractAudio' })
  }
  // 写元数据必须晚于音频提取：转换前的容器可能不支持元数据
  if (opts.embedMetadata) {
    steps.push({ key: 'FFmpegMetadata' })
  }
  return steps
}

// 组装：把清洗过的字段逐个搬进纯参数表
function assemble(opts: RawOpts, postprocessors: PPStep[]): YdlOpts {
  return {
    format: opts.format ?? 'bestvideo*+bestaudio/best',
    extractAudio: opts.extractAudio ?? false,
    postprocessors,
    simulate: false,
  }
}

// 入口：串起五步单向流水线，顺序不可调换
function parseOptions(layers: { layer: Layer; opts: RawOpts }[]): YdlOpts {
  const merged = mergeLayers(layers)
  const { opts, warnings } = validate(merged)
  if (warnings.length) console.warn(warnings)
  const postprocessors = buildPostprocessors(opts)
  return assemble(opts, postprocessors)
}

const ydlOpts = parseOptions([
  { layer: 'user', opts: { embedMetadata: true, format: 'best' } },
  { layer: 'cli', opts: { extractAudio: true, embedSubs: false } },
])
console.log(JSON.stringify(ydlOpts, null, 2))
```

跑出来长这样：

```json
{
  "format": "best",
  "extractAudio": true,
  "postprocessors": [
    { "key": "FFmpegExtractAudio" },
    { "key": "FFmpegMetadata" }
  ],
  "simulate": false
}
```

核心拿到的是一张完全干净、没有冲突、没有字符串待解析的参数表；它根本不知道命令行层发生过什么。

## 6. 执行轨迹

拿 research 给的具体例子走一遍。

**输入**：命令行 `--extract-audio --no-embed-subs -f best`，叠加用户级配置 `--embed-metadata`。

1. **收集**：两层叠加——`{layer: 'user', embedMetadata: true}` + `{layer: 'cli', extractAudio: true, embedSubs: false, format: 'best'}`。
2. **合并**：按层序逐字段覆盖，得到 `{extractAudio: true, embedSubs: false, format: 'best', embedMetadata: true}`。
3. **预处理重写**：未命中任何别名（用户没传 `--alias` 也没用 mp3/aac 等预设别名），跳过。
4. **解析**：所有开关都已是布尔或单值字符串，无需触发回调三件套。
5. **兼容垫片**：扫一遍兼容项表，无相关项命中（用户没传任何 youtube-dl 兼容开关），跳过。
6. **校验**：`-f best` 触发"建议性警告"（提示用户改用 `bestvideo*+bestaudio/best`），但不强行改写用户意图；`embedMetadata` 隐含开启 `addchapters`；没有 `allow-unplayable` 故无互斥冲突。
7. **翻译流水线**：按固定顺序 yield——`extractAudio` 命中，先吐 `FFmpegExtractAudio`；`embedMetadata` 命中，再吐 `FFmpegMetadata`（写元数据必须晚于音频提取，因为转换前的容器可能不支持元数据）。结果是一条两步的有序流水线。
8. **组装**：把清洗过的字段逐个搬进 `ydl_opts`，`simulate` 由"仅打印/取字段类开关"二次派生为 `false`，流水线整体塞进 `postprocessors` 键。
9. **交给核心**：`YoutubeDL(ydl_opts).download(urls)`——核心只读这张表，对它经过的清洗工序一无所知。

整条轨迹的要点是：每一步只做一件确定的事、只读上一步的产物，五步顺序不可调换（兼容垫片必须在校验前，否则兼容翻译出的默认值会被当成"用户显式设置"；流水线展开必须在校验后，因为展开依赖校验修正过的开关）。

## 7. 教学简化说明

本章演示故意省略了：选项解析库本身（标准库 optparse 的绑定与对其私有方法的重写）、数百个开关的完整声明、回调三件套的完整签名（带允许值表/别名表/`all` 通配的集合回调、带 `KEY:VAL` 文法与默认键的字典回调）、`--config-location` 引起的二次配置解析、密码交互输入、自动更新逻辑、Windows 双击可执行的特殊处理、插件目录加载、外部下载器参数的 `PP+EXE` 复合键语法。这些是工程脚手架或映射表细节，不表达"清洗层把脏活全揽"这条核心原理。

## 8. 小结

把"用户面对的混乱表面"和"核心实际消费的干净参数"之间挖一道独立的清洗工序，是这套 CLI 设计的全部。命令行层不是核心的入口，而是核心的过滤器——它把一切兼容、归一化、冲突、翻译都吃进自己，让核心只面对一张已经定型的纯参数表。于是同一个核心能跑命令行、能当库、能被前端调，三种入口等价。

至于 YoutubeDL 那个胖协调器为什么从来不直接碰 `sys.argv`——清洗层早就把一切办好了，它根本不需要知道命令行长什么样。
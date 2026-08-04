# 声明式后处理流水线与链式 info 变换

## 下载完，活才刚开始

下载到一个文件，其实只是开了个头。

你可能想要 mp4 里的音轨单独抽出来做成 m4a；可能想给视频嵌上字幕；可能想把赞助商片段砍掉；可能还想把标题、章节这些元数据写进文件里。每一项都是一道独立的加工工序，而且工序之间有先后——你不会想在 3gp 这种根本不支持元数据的容器上写元数据（写了也白写，会丢），所以「转码定型」必须排在「写元数据」之前。

让用户自己去排「先转码还是先嵌字幕」，几乎一定会排错。用户想要的不是一箱子工具，而是一排开关：「我要音频」「我要嵌字幕」「我要砍赞助段」——剩下的，框架替我排成一条不会打架的流水线。

这一章就讲 yt-dlp 怎么把这一堆加工步骤，做成一条**声明式拼装的链**：链上每个站都对同一份元数据做一次纯变换，并顺带声明「我产生了哪些该删的旧文件」。

## 一个加工站只做一件事，顺带声明该删什么

先看这条流水线上最小的零件——一个加工站（PostProcessor）。

每个站的执行约定是同一个签名：吃进一份 info 字典，吐出一个二元组：

```
run(info) -> (待删文件列表, 新 info)
```

第一项是「这次加工产生了哪些旧文件、可以删了」；第二项是「加工后的新 info」。比如「提取音频」这个站，吃进 `filepath = 'x.webm'`，转码出 `x.m4a`，它就返回 `(['x.webm'], {filepath: 'x.m4a', ...})`——旧的 webm 进待删清单，新文件路径写进 info。

你可以把加工站想成流水线上的一个工位：工件（info + 文件）递过来，工位做一件事，再把工件递给下一个工位，顺手把产生的边角料（旧文件）扫进废料筐。这个「（废料筐，新工件）」的二元组，就是站与站之间唯一交接的东西。

如果一个站什么都不想做，它返回 `[], info` 就行——一个空实现也是合法的「透传站」。

> 这份 info 字典不是新东西。第 4 章讲过，它就是贯穿全系统的「万能数据总线」，提取器、下载器都在读写它。本章只看它的新身份：流到后处理阶段后，字典里多了一个 `filepath` 字段指向刚下载的文件，而每个加工站会反复改写这个 `filepath`、把旧值丢进待删清单。换句话说，字典在这里又多了一个角色——它就是那条链上唯一会动、被每个站改写的状态。

## 把站首尾相连：链式折叠

一个站只能做一件事。把它们首尾相连，才能完成「webm 进、m4a 出」这样的完整加工。

编排器把同属一个时机的站放进同一个桶里，到点了就从这个桶里**依次取出、逐个执行**，并把上一个站的输出 info 喂给下一个站——这就是一次折叠（fold）：

```
info₀ ──→ 站A.run ──→ info₁ ──→ 站B.run ──→ info₂ ──→ 站C.run ──→ info₃
```

核心只有几行：

```ts
for (const pp of bucket) {
  const [files, newInfo] = pp.run(info)   // 二元组解包
  info = newInfo                           // 本站的新 info 是下一站的输入
  toDelete.push(...files)                  // 待删文件由框架统一收集
}
```

跑完一整桶，info 里的 `filepath` 已经被一路改写成最终文件了。

注意一个细节：**待删文件不是由加工站自己删的，而是交回框架统一处理**。框架拿到待删清单后看情况——如果用户开了「保留原始文件」（keepvideo），这些文件就不真删，而是记进一个「待挪动」的映射里，留到最后挪动时再处理；否则就立刻删掉。这设计让加工站保持纯粹：它只管「声明」该删什么，不管「怎么删、什么时候删」。

## 作者只写业务，进度通知全自动

写一个加工站时，作者只想关心「我要怎么转码」，根本不想操心「开始时报告一下进度、结束再报告一下」这种杂事。可进度上报又不能没有——下载器得靠它才能在屏幕上打出 `[ExtractAudio] started` / `[ExtractAudio] finished`。

yt-dlp 的解法很巧妙：**在类被创建的那一刻，自动给执行方法包一层「开始/结束」通知**。作者照常写 `run`，但等类真正用起来时，那个 `run` 已经被悄悄替换成了「发开始通知 → 调真正的 run → 发结束通知」的包装版：

```py
# 作者写的是这个（纯业务）：
def run(self, info):
    ...转码...
    return [old], new_info

# 实际运行时被换成了这个（多了进度通知）：
def run(self, info):
    info_copy = self._copy_infodict(info)        # 复制一份，只喂给进度钩子
    self._hook_progress({'status': 'started'}, info_copy)
    ret = 真正的_run(info)
    self._hook_progress({'status': 'finished'}, info_copy)
    return ret
```

Python 里这件事是靠**元类**做到的：类对象被创建时，元类检查「类体里有没有直接定义 run」，有就把它拿去包一层再放回去。注意是「类体里**直接定义**的」——基类自己的默认 run 只在它自己的类体里被包一次，不会被二次包装；子类不重写 run 时，干净地继承那个已经包好的版本，不会重复套壳。

这里还有个干净利落的细节：进度通知用的是 info 的**副本**，不是链上正在流动的真 info。副本只喂给进度钩子看看，绝不污染正在被加工的真数据。这样一来，横切关注点（进度上报）和业务逻辑就彻底分开了——作者写的每一行都是业务，进度全自动。

## 给一串开关，框架替你排成不会打架的流水线

用户不会、也不该知道「先转码还是先写元数据」。他们只给一串开关。

把开关翻译成「有序的加工站列表」的，是一个**生成器函数**：它挨个检查每个开关，开关开了就 `yield` 一条加工站声明（带名字、参数、运行时机）。yield 的先后顺序，就是这条加工链的先后顺序。

```
{ extractAudio: true, addMetadata: true }
        │
        ▼  get_postprocessors(opts)
[ 提取音频 ,  写元数据 ]        ← 产出顺序即执行顺序
        │
   ⚠️ 注释约束：写元数据必须在容器定型之后
      （转换/提取音频会换容器，而 3gp/webm 等容器可能不支持元数据）
```

关键的先后约束，**靠函数里的注释标着**，并由 yield 顺序保证：

- 「改章节（ModifyChapters）必须早于写元数据（FFmpegMetadata）」
- 「写元数据必须在视频转换、音频提取**之后**——转换前的容器（3gp、webm…）可能不支持元数据；从写元数据这一站往后，容器就不会再变了」
- 「Exec 必须是各自分类里最后一个站」

这换来一个极低的扩展心智负担：**加一个开关 ≈ 加一个 `if ... yield ...`**。但你也能看出代价在哪——正确顺序没有任何机器保证，全靠作者读注释、守纪律。一个新站插错了位置，不会报错，只会静默产出损坏的文件。

还有个藏得挺深的反向副作用：拼装函数在翻译开关时会**顺手改写 opts**。比如用户要嵌字幕（embedsubtitles），函数就把 `writesubtitles` 强行设为 `true`——因为嵌字幕这个站需要字幕文件已经下载好才能干活。这是「声明式拼装」对下游选项的一次偷偷反向修改，是个不太显眼的耦合点。

## 一个 when 字段，让同一套机制挂在 8 个时机

到目前为止聊的加工站都在「下载完之后」跑。但有些活儿得在更早或更晚的时机做：比如 SponsorBlock 查赞助段得在过滤后、下载前就拿到结果；有些信息又得等文件挪到最终位置之后才能动。

每条加工站声明因此都带一个 `when` 字段，标明自己该挂在主管线的哪个时机。编排器构造时按 `when` 把站**分桶**存放：

```
_pps = {
  'pre_process':  [...],
  'after_filter': [...],
  'post_process': [...],   ← 绝大多数用户声明默认落这里
  'after_move':   [...],
  ...                       ← 共 8 个阶段
}
```

主管线走到某个阶段，就取出对应桶，按上一节那套折叠跑一遍。这样一来，同一套「声明式拼装 + 链式纯变换」的机制，就横跨了整个流程的好几个时机，可以复用。

不过这套声明式并不包打天下。有一个「系统级」的收尾站——把临时文件挪到最终位置的 `MoveFilesAfterDownloadPP`——是**硬编码**在收尾位置的：用户声明的 `post_process` 桶跑完之后，编排器固定再跑这个落位站，挪完文件才接着跑 `after_move` 桶。这个落位站不参与声明式拼装，于是系统里其实**声明式和命令式两套并存**。

> 顺带一提：所有内置加工站和用户自己写的插件，走的是同一条「丢个文件就注册一个新站」的发现路径——那套注册机制第 2 章已经讲透，本章不重复，只把它当成「工厂里现成的零件清单」来用。

## 最小原理演示

把上面三个机制——**声明式拼装 + 链式纯变换 + 自动进度钩子**——揉到一起，用一个能跑的小程序演一遍。真实 ffmpeg 调用全部用 mock 代替，目的是让你看清数据怎么流动。

```ts
// demo.ts —— 用 `bun demo.ts` 直接跑（或配下面 package.json）

type Info = { filepath: string; [k: string]: unknown }
type PPResult = [string[], Info]          // 链上唯一交接物：待删 + 新 info

interface PostProcessor {
  ppName: string
  run: (info: Info) => PPResult
}

// ---- 业务逻辑：作者只写这两个纯函数，不碰任何进度通知 ----
function extractAudioLogic(info: Info): PPResult {
  const oldFile = info.filepath
  const newFile = oldFile.replace(/\.\w+$/, '.m4a')
  console.log(`  [ffmpeg] ${oldFile} -> ${newFile}`)
  return [[oldFile], { ...info, filepath: newFile, ext: 'm4a' }]   // 旧 webm 进待删，路径换 m4a
}
function writeMetadataLogic(info: Info): PPResult {
  console.log(`  [ffmpeg] 写元数据到 ${info.filepath}`)
  return [[], { ...info, ext: info.ext }]                            // 写元数据不改文件名
}

// ---- 「元类」：用高阶函数在创建站时自动给 run 包一层 开始/结束 通知 ----
// 这证明该机制不依赖 Python 元类，换门语言照样能做
function autoWrap(name: string, realRun: (info: Info) => PPResult): PostProcessor {
  return {
    ppName: name,
    run(info) {
      const infoCopy = { ...info }                  // 副本只喂进度钩子，不污染链上真 info
      console.log(`  [进度] ${name} started`)
      const ret = realRun(info)                     // ← 作者写的纯业务逻辑藏在这里
      console.log(`  [进度] ${name} finished`)
      return ret
    },
  }
}

// ---- 声明式拼装：开关 → 有序加工站；顺序靠注释约束 ----
function getPostprocessors(opts: { extractAudio?: boolean; addMetadata?: boolean }): PostProcessor[] {
  const chain: PostProcessor[] = []
  if (opts.extractAudio) chain.push(autoWrap('ExtractAudio', extractAudioLogic))
  // ⚠️ 写元数据必须在容器定型之后：转换/提取前容器可能不支持元数据
  if (opts.addMetadata) chain.push(autoWrap('Metadata', writeMetadataLogic))
  return chain
}

// ---- 链式 fold 执行端：上一步的新 info 喂下一步 ----
function runAllPps(bucket: PostProcessor[], info: Info) {
  const toDelete: string[] = []
  for (const pp of bucket) {
    const [files, newInfo] = pp.run(info)
    info = newInfo                                   // 折叠
    toDelete.push(...files)                          // 待删由框架统一收集，站自己不删
  }
  return { info, toDelete }
}

// ---- 跑一遍 ----
const opts = { extractAudio: true, addMetadata: true }
const chain = getPostprocessors(opts)
console.log('开关', opts, '→ 拼出顺序:', chain.map(p => p.ppName).join(' → '))

const { info, toDelete } = runAllPps(chain, { filepath: 'x.webm', title: '我的视频' })
console.log('最终 filepath:', info.filepath)
console.log('待删清单:', toDelete, '（框架负责删）')
```

配套最小 `package.json`：

```json
{
  "name": "pp-pipeline-demo",
  "private": true,
  "scripts": { "start": "bun demo.ts" }
}
```

运行结果——你会看到 `filepath` 从 `x.webm` 一路被改写成 `x.m4a`，旧 webm 进入待删清单：

```
开关 { extractAudio: true, addMetadata: true } → 拼出顺序: ExtractAudio → Metadata
  [进度] ExtractAudio started
  [ffmpeg] x.webm -> x.m4a
  [进度] ExtractAudio finished
  [进度] Metadata started
  [ffmpeg] 写元数据到 x.m4a
  [进度] Metadata finished
最终 filepath: x.m4a
待删清单: [ 'x.webm' ] （框架负责删）
```

这段输出同时演透了三件事：进度通知在每个站的业务逻辑前后自动冒出来（作者没写一行通知代码）、info 在站之间被折叠传递、旧文件被收进待删清单交由框架处理。

## 关键权衡

这一章机制密集，但真正值得记住的是下面这几条「做了什么选择 → 换来了什么 → 代价是什么」。

**1. 用元类在类创建时自动给每个站的 run 包一层进度通知。**
选择让执行方法在类被定义的那一刻就被悄悄包装。换来的是加工站作者只写纯业务逻辑，横切的进度上报全自动——这是整个后处理子系统最讨巧的设计。代价是字面定义和实际运行行为对不上：你在源码里看到的 `run` 不是真正跑的那个 `run`，新手调试时会困惑「我明明没写通知，通知从哪冒出来的」；而且每站运行都要先复制一份 info 副本去驱动进度通知，带来轻微开销和一个隐式的「返回值是二元组」约定。

**2. 用「(待删文件列表, 新 info)」二元组作为链上唯一交接物。**
选择把「清理声明」和「元数据变换」捏进同一个返回值。换来的是任意加工站可以自由组合——每个站既是元数据变换器，又是「我产生了哪些废料」的声明者，链的拼装因此极其灵活。代价是删文件的时机被框架接管了：加工站不能自己直接删文件（否则会破坏链的清理语义），保留原始文件（keepvideo）时删除还会被延后成「待挪动」映射而非真删。

**3. 用一个生成器把一堆开关翻译成有序声明，正确顺序靠注释 + 产出顺序硬编码。**
选择把「顺序正确性」交给一个生成器函数和几行注释，而不是一张显式的依赖图。换来的是用户体验上的极大简化——只给开关，框架自动拼出顺序正确的管线；对开发者来说，「加一个开关 ≈ 加一个 if-yield」，心智负担极低。代价是站与站之间的正确依赖关系散落在注释里、没有任何编译期保证；新增一个站必须小心翼翼插对 yield 位置，错了不会报错，只会静默产出损坏的文件。

**4. 给每条声明附一个「何时运行」的 when 字段，挂到 8 个阶段。**
选择用 when 字段把同一套加工机制铺到主管线的多个时机。换来的是机制高度复用——「声明式拼装 + 链式纯变换」这一套，横跨下载前、过滤后、下载后、挪动后等多个阶段都能用。代价是调用方必须理解 8 个阶段语义的差别；而且少数「系统级」的站（最终文件落位）被硬编码固定在收尾、不参与声明式流水线，于是系统里其实声明式和命令式两套并存，不是一个完全自洽的声明式系统。

## 小结

后处理的本质，是把一连串「吃一份元数据、吐一份新元数据 + 一串待删文件」的加工站，首尾相连折叠成一条链。用户给一排开关，框架用一个生成器把它们拼成顺序正确的链，再靠元类把进度上报这种横切杂事全自动地织进每个站。整条链上流动的还是那份贯穿全系统的 info 字典——只不过在后处理阶段，它多了一个会被反复改写的 `filepath`，成了链上唯一会动的状态。

下一章会看到 yt-dlp 怎么把 `-f bestvideo+bestaudio/best` 这样一串字符，编译成一个选择器去挑出要下载的格式——那是另一种「声明式」：用一门迷你语言声明意图，让框架去求解。
# 声明式后处理流水线与链式 info 变换

> 本章属于 composite 层。前置：info_dict 数据总线与提取器骨架。
> 学完你能：用一句话讲清「为什么后处理做成声明式拼装的链、为什么用二元组当链上货币、为什么进度钩子由元类偷偷织入」。

## 1. 为什么需要它

上一章把长流拆成可恢复的分片，分片落盘后下载阶段就结束了——`info_dict` 多了个 `filepath` 字段，磁盘上多了个 `.webm`。但故事到这远没完：你可能还想把这个 webm 提取音频成 m4a、把赞助段砍掉、把标题和章节信息写进容器元数据。

这些后续动作有个隐性强依赖：**写元数据必须在容器定型之后**。如果你先把标题写进 webm，再提取音频改成 m4a，写进去的元数据就被丢掉了——因为旧容器连同它的元数据一起被替换。要是在不支持元数据的容器（比如 3gp）上写元数据，干脆写不进去。砍赞助段也类似：必须先裁剪、再写章节元数据，否则章节时间戳对不上。

使用者面对一堆 `--extract-audio`、`--embed-subs`、`--add-metadata`、`--remove-chapters` 开关，他不该自己去想「先转码还是先写元数据」。他要的是把开关丢给框架，框架替他排出一条不会打架的加工顺序。本章要解决的就是这件事——把「下载完之后」做成一条拼起来就不会错的加工管线。

## 2. 核心思想

换个抽象层看：每个加工步骤都被建模成同一个签名的纯函数——吃一份元数据字典、吐一份新字典外加一串「我这次产生的该删的旧文件」——首尾相连折叠下去。链不是用户自己拼的，而是由一个生成器函数把一堆 CLI 开关翻译出来的。换句话说，**这条链是声明式拼装出来的，执行方式只有一种：链式 fold**。

## 3. 心智模型

站在运行时角度看，链上跑的就两样东西：一份从下载阶段继承下来的胖元数据字典（第 4 章讲过它是贯穿全系统的数据总线，本章只看它的新角色——链上的可变状态载体，`filepath` 字段被反复改写、旧值落入待删清单），以及一份累积的「该删的旧文件」清单。

链的执行契约被压成一个二元组：

```
PP.run(info) → (files_to_delete: string[], new_info: Info)
```

执行就是个 fold：上一步的 `new_info` 喂给下一个站，`files_to_delete` 累积起来交给框架。基类的 `run` 默认返回 `[], info`，意味着一个什么都不写的空 PP 是合法的「透传站」。

链本身分三层拼起来：

- **拼装层**：一个生成器函数 `get_postprocessors(opts)` 把一堆 CLI 开关逐条 `yield` 成有序声明（含名字、参数、运行时机）。顺序就是源码里的物理产出顺序，靠注释标注站间约束（例如 `# ModifyChapters must run before FFmpegMetadataPP`）。
- **分桶层**：编排器按「运行时机」字段把声明分进 8 个桶（`pre_process` / `after_filter` / `video` / `post_process` / `after_move` …）。
- **执行层**：主管线走到某个阶段时，取出对应桶，依次 fold 跑完每个站。

进度上报不在业务里。元类在类创建那一刻，就把每个站的 `run` 方法偷偷包了一层「发 started 通知 → 调真业务 → 发 finished 通知」，作者写的代码里看不到任何 `hook_progress` 调用，运行时却自动有。

跑完用户声明的链之后，编排器固定再跑一个硬编码的「把临时文件挪到最终位置」的站，它不参与声明式拼装，是少数几个「系统级」收尾站之一。

## 4. 关键权衡

### 元类偷换执行方法，换横切进度通知全自动

每个加工站作者只写「我吃什么、我吐什么」的业务逻辑。但实际运行时，调用 `pp.run(info)` 拿到的远不止业务逻辑：包装层先复制一份 info 副本，发 started 通知，调真业务拿到 `(files_to_delete, new_info)`，发 finished 通知，副本只喂给进度钩子、真 info 用于链式传递。

换来的是：横切的进度上报完全自动化，几十个内置加工站零样板，第三方插件作者也白嫖到同一套通知。

代价是：执行方法被元类悄悄换掉，**字面定义和实际运行行为不一致**。新手调试时单步打进去，会看到自己没写过的 `started` 调用先于业务逻辑执行，断点位置和源码位置对不上要发懵。还要付一个隐式约定——业务返回 `None` 时包装层视为「未改」，这个隐式兼容在阅读签名时不明显。

这条权衡化解的本质矛盾是：**业务作者只想写业务，框架想统一收口进度上报**——这两件事天然打架。元类把第二件事从作者视野里抹掉，是「横切织入」思路的典型用例。

### 二元组当链上唯一货币，换任意加工站可自由组合

每个站的签名都被强制成 `(info) → (files_to_delete, info)`。提取音频站产出 `(['x.webm'], {filepath:'x.m4a', ext:'m4a'})`，下一个写元数据站接到 m4a，产出 `([], {filepath:'x.m4a', ext:'m4a', title:'…'})`，再下一个嵌字幕站接着跑——任何站的输入都是上一个站的输出。

换来的是：加工站是真正可组合的，按需增减一行不影响其它站；第三方插件 PP 走同一条 fold 路径，与内置 PP 平权。

代价是：删文件这件事被框架接管了。加工站不能自己 `unlink` 旧文件，否则下一个站拿到的 `info.filepath` 指向一个不存在的路径，链就崩了。这顺带引出了 `keepvideo` 选项开启时的隐式语义——删除被延后成「待挪动」映射、等最终落位时再决定删不删，复杂度悄悄从加工站搬到了框架里。

这条权衡化解的本质矛盾是：**加工站想自由改文件 + 自行清理，链式 fold 想要统一可组合契约**——把「清理意图」和「数据变换」打包成同一个返回值，是化解方式。

### 生成器翻译开关，换「加一个开关 ≈ 加一个 if」的极低心智负担

拼装函数体就是一堆 `if opts.xxx: yield {'key': …, 'when': …}`。先 yield 谁、后 yield 谁，就是源码里的物理顺序。站间依赖以注释形式硬编码（`# FFmpegMetadataPP should be run after FFmpegVideoConvertorPP and FFmpegExtractAudioPP … From this point the container won't change`）。

换来的是：新增一个开关、新增一个站，作者只需要在生成器里找一个合适位置插一个 `if-yield`，心智负担极低；用户给一串开关，框架吐出顺序正确的链。

代价是：**站与站之间的依赖关系散落在注释里，没有任何编译期或运行期保证**。加新站时插错位置，文件会被静默产出损坏——比如把 FFmpegMetadata 插到 ExtractAudio 之前，元数据写进 webm 后被丢弃，但程序不报错。

这条权衡化解的本质矛盾是：**声明式追求「用户只给意图」，意图之间却有内在时序依赖**。生成器把依赖显式化进产出顺序 + 注释文档化，是这两件事的折中，没有银弹。

### 阶段字段挂载多时机，换同一套机制横跨整个流程

每条声明带个 `when` 字段，可挂到 `pre_process`、`after_filter`、`post_process`、`after_move` 等 8 个阶段。同一套加工机制、同一套二元组契约，复用于整个流程的多个时机——`pre_process` 桶里的 PP 可以在下载前改 info，`after_move` 桶里的 PP 可以在文件落位后做后扫尾。

换来的是：机制可复用，加工站作者不用为「我的站在哪个时机跑」重新学一套 API，加个 `when` 字段就行。

代价是：调用方要理解 8 个阶段语义才能正确写 `when`；而且少数「系统级」站（最终文件落位）被硬编码在收尾位置，不参与声明式拼装，形成「声明式拼装」与「命令式收尾」两套并存的尴尬——这部分代码读起来与声明式部分的风格完全不同。

这条权衡化解的本质矛盾是：**流水线想统一「声明式」，但有些加工时机是「系统必需、不能让用户漏配」的**——这部分只能硬编码，妥协就出现了。

## 5. 最小原理演示

下面的 TS 片段用 60 行演透「声明式拼装 + 链式纯变换 + 元类自动进度钩子」三件事。Python 的元类用高阶函数 `withProgressHooks` 等价模拟——这恰好证明该机制不依赖 Python 元类语义，它本质是「对类方法做包装」。

```ts
// 链上传递货币：待删旧文件清单 + 改写后的元数据
type Info = { filepath: string; ext?: string; title?: string; [k: string]: unknown };
type PPResult = [filesToDelete: string[], info: Info];

interface PP {
  name: string;
  run(info: Info): PPResult;
}

// 高阶函数等价模拟「元类在类创建时给 run 包一层 started/finished 钩子」
function withProgressHooks(pp: PP): PP {
  const realRun = pp.run.bind(pp);
  (pp as any).run = (info: Info): PPResult => {
    console.log(`  [hook] ${pp.name} started`);
    const ret = realRun(info);
    console.log(`  [hook] ${pp.name} finished`);
    return ret;
  };
  return pp;
}

// 加工站：webm 提取音频成 m4a（用 mock 的「换后缀」代替真 ffmpeg）
const extractAudio = withProgressHooks({
  name: 'ExtractAudio',
  run(info): PPResult {
    const oldPath = info.filepath;
    const newPath = oldPath.replace(/\.\w+$/, '.m4a');
    return [[oldPath], { ...info, filepath: newPath, ext: 'm4a' }];
  },
});

// 加工站：把 title 写进容器元数据（不改文件名）
const addMetadata = withProgressHooks({
  name: 'FFmpegMetadata',
  run(info): PPResult {
    return [[], { ...info, title: info.title ?? 'untitled' }];
  },
});

// 声明式拼装：把 CLI 开关翻译成有序声明，顺序由产出顺序 + 注释硬编码
type PPDecl = { key: string; when?: string };

function* getPostprocessors(opts: {
  extractAudio?: boolean;
  addMetadata?: boolean;
}): Generator<PPDecl> {
  if (opts.extractAudio) {
    yield { key: 'ExtractAudio', when: 'post_process' };
  }
  // 顺序约束：FFmpegMetadata must run after ExtractAudio
  // —— 写元数据必须在容器定型之后，否则元数据被丢弃
  if (opts.addMetadata) {
    yield { key: 'FFmpegMetadata', when: 'post_process' };
  }
}

const REGISTRY: Record<string, PP> = {
  ExtractAudio: extractAudio,
  FFmpegMetadata: addMetadata,
};

// 链式 fold 执行端：上一步 info 喂下一步，files_to_delete 累积
function runPostProcess(info: Info, decls: PPDecl[]) {
  let cur = info;
  const filesToDelete: string[] = [];
  for (const d of decls) {
    const [del, newInfo] = REGISTRY[d.key].run(cur);
    cur = newInfo;
    filesToDelete.push(...del);
  }
  return { info: cur, filesToDelete };
}

// 跑一遍：两个开关 → 一条顺序正确的链
const decls = [...getPostprocessors({ extractAudio: true, addMetadata: true })];
console.log('拼装出的有序声明 =', decls.map(d => d.key));

const result = runPostProcess({ filepath: 'x.webm' }, decls);
console.log('最终 info =', result.info);
console.log('待删清单 =', result.filesToDelete);
```

运行后读者会看到：

- `getPostprocessors` 产出顺序为 `['ExtractAudio', 'FFmpegMetadata']`——注释约束生效，写元数据排在转码之后。
- 每个 `pp.run` 调用前后自动多了 `[hook] started / finished`——作者根本没写过这两行，是 `withProgressHooks` 偷偷织进去的。
- `info.filepath` 从 `x.webm` 改写成 `x.m4a`，旧 webm 进入待删清单；写元数据站不改文件名，但链式接得上。
- 最终待删清单累积成 `['x.webm']`，框架后续会决定立即删还是延后删。

## 6. 执行轨迹

输入开关 `{extractAudio: true, addMetadata: true}`，info `{filepath: 'x.webm'}`：

1. **拼装**：`getPostprocessors(opts)` 产出两条声明。注释 `# FFmpegMetadata must run after ExtractAudio` 决定了 FFmpegMetadata 在源码物理顺序上排在 ExtractAudio 之后，所以 yield 出来的就是 `['ExtractAudio', 'FFmpegMetadata']`。

2. **分桶**：编排器把两条声明都归进 `post_process` 桶（默认 when）。

3. **fold 第 1 步**：调 `ExtractAudio.run({filepath:'x.webm'})`。
   - 元类包装层先发 `started` 通知（复制了一份 info 副本驱动进度钩子，真 info 不被污染）
   - 真业务把 webm 转码成 m4a，返回 `(['x.webm'], {filepath:'x.m4a', ext:'m4a'})`
   - 包装层发 `finished` 通知
   - 框架拿到 `(['x.webm'], …)`，把 `x.webm` 加入累积待删清单

4. **fold 第 2 步**：调 `FFmpegMetadata.run({filepath:'x.m4a', ext:'m4a'})`。
   - 包装层发 `started`
   - 真业务把 title 写进 m4a 容器，返回 `([], {filepath:'x.m4a', ext:'m4a', title:'…'})`
   - 包装层发 `finished`
   - 待删清单这次为空，累积清单不变

5. **收尾**：编排器跑硬编码的 `MoveFilesAfterDownloadPP`，把 `x.m4a` 从临时位置挪到最终位置；之后才跑 `after_move` 桶（本例为空）。

6. **清理**：未开启 `keepvideo`，框架 `unlink` 掉待删清单里的 `x.webm`；开启则转成「待挪动」映射，最终落位时再处理。

最终 `info.filepath = 'x.m4a'`，标题已写入容器，旧 webm 已删除。

## 7. 教学简化说明

本章演示故意省略了：真实的 ffmpeg 调用（用「换后缀 + 改字段」mock）、字幕与缩略图嵌入门类、`keepvideo` 下「待挪动」映射的完整语义、插件注册表与按名查表懒加载（约定类名后缀 `PP` 即类型，已在第 2 章讲过）、媒体类型限制装饰器（让 PP 声明「只对 video/audio/images 生效」）、8 个阶段的完整管线（只演示 `post_process` 一个桶）、进度模板渲染。这些都是链上某个具体站的业务，不影响理解「声明式拼装 + 链式纯变换 + 元类自动钩子」这三件事。

## 8. 小结

后处理这一段把「文件落盘之后」建模成一条 fold 链：用户给意图、生成器出顺序正确的声明、每个声明对 `(files_to_delete, info)` 二元组做一次纯变换，链式折叠是执行的唯一形式。横切的进度通知被元类偷偷塞进每个站的 `run`，业务作者只写业务；少数「系统级」站硬编码在收尾，不参与声明式拼装。

链跑完，`filepath` 终于指向最终落盘的文件——但下载开始之前还有个问题：原始 formats 列表里有十几种分辨率 × 几种编码，到底选哪个下、哪个兜底、音视频要不要分流？把 `-f bestvideo+bestaudio/best` 这种字符串变成一个选择器 AST，是下一章的主题。

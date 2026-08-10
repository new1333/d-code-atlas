# magic-string：sourcemap 友好的源码就地变换 · 主题精读

## 给 Writer 的教学钩子（必填，8 子项缺一不可）

- **用户痛点 / 场景**：宏变换把用户写的 `defineProps()` 改写成了编译产物的 `__props`。但用户在浏览器里打断点、看报错堆栈时，看到的是改写后的产物——位置全乱了：断点落不到自己写的那行，报错栈指向一段自己从没写过的代码。没有某种「翻译表」把产物位置换算回源码位置，编译期变换的代价就是**调试体验彻底崩塌**。而朴素的字符串拼接改写一旦完成，原始字符位置就永远丢失了，无法事后重建这张翻译表。

- **一句话核心思想**：所有改写都以「**原始源码的字符偏移量**」为坐标就地登记，原始位置永不丢弃，最后一次性把这张「编辑账本」逆向翻译成 sourcemap。

- **设计动机（为什么需要它）**：上一章确立了「必须靠 AST 才能精确识别宏节点、拿到节点的字符 offset」；但 AST 变换天然会破坏源码与产物的位置对应（**已在第 4 章『靠 AST 而非正则识别宏调用节点』讲透「为什么必须用结构化 AST 而非正则」及其代价「源码格式不敏感反而让报错定位更难还原到用户写法」，本章只看它的新侧面：拿到节点 offset 之后，如何让「改写代码」和「保留原始位置」这两件看似矛盾的事同时成立**）。magic-string 的存在就是为了填这个坑——它不重新生成代码，而是在原始字符串上做外科手术式的就地编辑，把每次编辑都钉死在原始 offset 上，从而让 sourcemap 成为编辑的免费副产物。它换来的核心能力是：**编译产物可被精确回溯到用户源码**。

- **关键权衡（本 Atlas 的核心，3 条）**：
  1. **只能用 offset 定位的就地操作，放弃自由字符串替换** → 换来了「原始位置信息贯穿整个编辑过程不丢失，sourcemap 可逆向重建」 → 代价是「你必须先有 AST 给出每个节点的 start/end offset，不能像写脚本那样随手 `.replace()`；且所有后续操作仍要以原始 offset 为坐标系，不能用『改完之后的第几个字符』来定位」。
  2. **用「区块链表 + 劈开」记录编辑，而非每次重拼字符串** → 换来了「多次编辑互不干扰、O(1) 定位到任意位置、甚至支持 move 把一段代码搬到别处」 → 代价是「内部数据结构（双向链表 + 起止索引表）比朴素字符串复杂，最终输出与 sourcemap 生成都需要一次 O(n) 遍历」。
  3. **sourcemap 默认走低分辨率（按词边界/行边界打点）** → 换来了「sourcemap 体积小（配合 VLQ 差值编码，比逐字符映射小一个数量级）」 → 代价是「映射粒度粗，列级精度丢失——断点可能只精确到『这一行的某个词』而非精确列；要逐字符精度需显式开 hires，代价是体积膨胀」。

- **最小心智模型（7 步）**：
  1. **构造**：用整段原始源码初始化，内部把它包成一个覆盖 `[0, 长度)` 的单一区块，原始 offset 成为全部操作的绝对坐标系。
  2. **取节点**：遍历 AST 命中宏调用节点，读出该节点在源码里的 `start/end` offset。
  3. **就地改写**：对要替换的节点调用 `overwrite(start, end, 新代码)`——先在 start、end 两处把区块「劈开」成相邻小区块，再把目标区块标记为「已编辑」、换上新内容，但**它记着的原始 start/end 不变**。
  4. **就地插入**：对要补的样板代码调用 `appendLeft(offset, 代码)` / `prependRight(offset, 代码)`，插入物挂在某个原始 offset 的左侧或右侧。
  5. **一次性输出**：所有编辑登记完毕后，调 `toString()` 按区块顺序拼出最终产物。
  6. **一次性映射**：调 `generateMap()` 遍历区块——未编辑区块自然映射到自身原始位置，已编辑/插入区块映射到它们所锚定的那个原始 offset——产出把「产物行列 ↔ 源码行列」对应起来的映射串。
  7. **下游回溯**：产物 + sourcemap 一起交给运行时/调试器，断点与报错栈经 sourcemap 换算后落回用户写的源码。

- **最小原理演示（替代旧"复刻范围"）**：
  - **应演示**：一个**小到只表达核心思想**的从零实现（约 30～40 行）：维护「原始串 + 一张编辑账本（每条 `{start, end, content}`）」；`overwrite` 只是往账本里追加一条；`toString` 按原始 offset 排序、把账本外的原始片段与账本内的新内容缝合输出；`generateDecodedMap` 为账本外的片段生成「映射到自身」、为账本内的片段生成「映射到它替换掉的原文本的 start」。**每一行都要对应上面某个原理点**（offset 坐标系、就地登记、逆向翻译）。
  - **应故意省略**：双向链表与 byStart/byEnd 索引表（那是性能优化，非原理）、`move`/`reset`/`indent` 等高级操作、`appendLeft` vs `prependRight` 在 move 场景下的归属语义、VLQ 的 Base64 编码实现（演示里映射可以直接用行列数组，编码是下游 codec 的事）、多文件/链式 sourcemap 合并。
  - **不追求工程完整，只追求"演透原理"**。
  - **演示载体建议（Writer 据此执行）**：topic 模式**首选 TS/JS**。最小实现用纯 JS/TS 几十行即可，无需任何依赖；可在演示末尾打印出「产物」与「decoded mappings 数组」，让读者亲眼看到「新插入的代码被映射回了它替换掉的原始 offset」这一刻——这是全章的"啊哈"瞬间。

- **正文不宜展开的细节**：VLQ 的 Base64 编码细节（6-bit 分组 + 续位 + 符号位）、segment 1/4/5 字段的完整 grammar、`hires: "boundary"` 与 `true`/`false` 的精确差异、链式变换下多张 sourcemap 如何复合（需 `@jridgewell/trace-mapping` 这类合并工具）、magic-string 对 `sourcesContent`/`ignoreList` 的处理、与 webpack-sources 的差异。这些供 Critic 抽查，不宜当正文主线。

- **推荐的一个执行轨迹例子**：
  - **输入**：源码 `const props = defineProps<{ msg: string }>()`，AST 给出宏调用节点 `defineProps<{ msg: string }>()` 的 offset 为 `[14, 46]`。
  - **编辑**：`overwrite(14, 46, "__props")`。
  - **关键中间态**：内部区块链表里，`[14,46)` 这个区块被标记为已编辑、内容换成 `__props`，但它记忆的原始位置仍是 14；其余字符区块原样保留。
  - **输出**：`toString()` → `const props = __props`；`generateMap()` → 产物中 `__props` 那段被映射回源码 offset 14（即 `defineProps` 原本所在位置），`const props = ` 各字符各自映射回自身原始 offset。
  - **效果**：用户在产物 `__props` 处的断点/报错，经 sourcemap 还原到源码里 `defineProps` 的位置——变换"可回溯"。

> 以上钩子供 Writer 写「动机→核心思想→心智模型→关键权衡→原理演示」；下面事实部分供核对，不要被 Writer 当目录照抄。

## 概念要点

- **定位哲学：所有坐标都是原始串的 offset**。magic-string 的 `overwrite`、`remove`、`slice`、`move`、`appendLeft/prependRight` 等操作的 `start/end/index` 参数，文档反复强调「**always refer to the original string**」——即引用的是**未变换前**源码的字符偏移，而非变换后产物的位置。这是它能生成正确 sourcemap 的根基。
  依据: magic-string 官方 README（GitHub Rich-Harris/magic-string）API 描述原文 "characters... of the original string, not the generated string"

- **构造即建立坐标系**：`new MagicString(source)` 用整段源码初始化，内部生成一个覆盖 `[0, source.length)` 的初始区块，原始 offset 从此刻起成为不可变坐标系。
  依据: magic-string 源码 `MagicString` 构造逻辑——`new Chunk(start=0, end=string.length, string)`

- **就地编辑 = split + edit**：调用 `overwrite(start, end, content)` 时，内部先在 start、end 处 `_split()` 把跨越该位置的区块劈成两半，再取出 `[start,end)` 范围内的区块链，把首个区块 `edit(content)`、中间区块清空。区块的原始 `start/end` 字段始终保留，只是多了 `edited=true` 和新 `content`。
  依据: magic-string 源码 `MagicString.prototype.overwrite` / `_split` 实现逻辑

- **区块（Chunk）是 sourcemap 的最小单元**：每个区块持有 `start / end / original / content / intro / outro / edited / previous / next`。生成 sourcemap 时遍历区块链，用区块的**原始 start** 经 `locate()` 换算成源码行列，再决定该区块映射到哪。
  依据: magic-string 源码 `Chunk` 类字段与 `generateDecodedMap` 中 `chunk.start` 的使用

- **未编辑区块映射到自身、已编辑区块映射到锚点**：这是 sourcemap 生成的核心规则——未动过的代码天然映射回它自己的原始位置；被 overwrite/insert 的内容则映射到它所替换/所依附的那个原始 offset（即"假装这段新代码来自原文本的那个位置"）。
  依据: magic-string 源码 `generateDecodedMap` 中对 `chunk.edited` 的分支（addEdit 与未编辑片段的不同处理）

- **sourcemap v3 = VLQ 差值编码的 segment 串**：`mappings` 字段是一串 Base64-VLQ 编码的 segment，`;` 分隔行、`,` 分隔段；每个 segment 1/4/5 个字段（生成列、源索引、原始行、原始列、可选名字索引）；**所有值都是相对上一段的差值**，VLQ 编码使体积比 v2 缩小约 50%。
  依据: TC39 Source Map Format Specification（tc39.es/source-map-spec）"mappings" grammar 与 VLQ 章节；Rich-Harris/vlq README

- **hires 是体积 vs 精度的开关**：`generateMap({ hires })` 控制映射分辨率——`false`（默认）仅在有限位置打点（体积小）、`"boundary"` 按词边界、`true` 逐字符（精确但最大）。magic-string 另有 `addSourcemapLocation(index)` 在 hires=false 时手动补打点。
  依据: magic-string 官方 README `generateMap` options 中 hires / includeContent 描述

- **Vue compiler-sfc 的真实用法**：`ScriptCompileContext` 构造时即 `new MagicString(this.source)`，并用 `descriptor.scriptSetup.loc.start/end.offset` 建立区块坐标系；后续宏变换在各 `script/*.ts` 里对该实例调用 `overwrite/remove/slice`，最后由上层统一 `generateDecodedMap()` 产出 sourcemap。
  依据: vuejs/core 源码 `packages/compiler-sfc/src/script/context.ts`（`s: MagicString = new MagicString(this.source)`、`startOffset/endOffset` 字段）

- **Vue Macros 的同一套范式**：每个特性宏（如 defineModel）都是一个「AST visitor + 命中节点后对 magic-string 实例做 overwrite/appendLeft」的变换器——AST 给 offset，magic-string 负责安全改写并保 sourcemap。这构成下一章「宏变换流水线」的标准化动作单元。
  依据: vue-macros 官方仓库（github.com/vue-macros/vue-macros）各 `packages/*` 特性包的 transform 实现；掘金《rollup 和 vue 都在用的 magic-string 是个什么东西》对 Vue3 宏解析中 magic-string 用途的描述

## 关键流程

```
原始源码
   │
   ▼
new MagicString(source)          ──► 内部：单个 Chunk 覆盖 [0, len)，建立原始 offset 坐标系
   │
   ▼ （并行：AST 遍历产出节点 offset）
对每个命中的宏节点 / 插入点
   ├─ overwrite(node.start, node.end, 新代码)  ──► _split(start) + _split(end) → 目标 Chunk.edit(新代码)，原始 start/end 保留
   └─ appendLeft(offset, 样板代码)             ──► 插入物挂在该 offset 的 Chunk.intro/outro
   │
   ▼ （编辑全部登记完毕，原始 offset 信息始终在账本里）
s.toString()                     ──► 遍历 Chunk 链，按序缝合 original/content/intro/outro → 产物字符串
   │
   ▼
s.generateDecodedMap({source, hires})
   ├─ 未编辑 Chunk                                ──► 映射到自身原始 offset 对应的源码行列
   └─ 已编辑/插入内容                             ──► 映射到所锚定的原始 offset（locate(chunk.start)）的源码行列
   │
   ▼
{ code: 产物, map: 解码后的 mappings 数组 }        ──► map 再经 VLQ 编码 → 标准 sourcemap v3 字符串
   │
   ▼
交给下游（打包器/运行时/调试器）：断点与报错栈经 map 换算回用户源码位置
```
依据: magic-string 源码（`overwrite`/`_split`/`generateDecodedMap` 的调用关系）；TC39 Source Map v3 spec（mappings → VLQ 编码）；vuejs/core compiler-sfc context.ts（MagicString 实例化与 offset 配置）

## 易混淆 / 边界 / 推断

- **事实**：magic-string 自身**不合并上游 sourcemap**。若输入源码已经带一张 sourcemap（例如 TS → JS 之后再做宏变换），magic-string 只能产出「产物 → 本次输入」的映射，要得到「产物 → 最原始源码」需要额外的链式合并工具（如 `@jridgewell/trace-mapping`、`merge-source-map`）。Rich Harris 本人在 issue 中确认这是长期存在的缺口。
  依据: magic-string GitHub issue #13「Import existing sourcemap」；博客《Source Map-Aware Code Generation》提到 magic-string 不支持 preserve input source maps

- **事实**：`replace(regexpOrString, substitution)` 虽然像字符串替换，但文档明确它「**will always match against the original string**」且就地改变状态——它仍走 split+edit 通道，因此也是 offset-safe 的，不会破坏 sourcemap。但它的定位语义（按内容匹配而非按 offset）不如 `overwrite` 精确，宏变换实践中仍以 offset 操作为主。
  依据: magic-string 官方 README `replace` 方法描述

- **事实**：`appendLeft` 与 `prependRight` 在「该 offset 处发生过 move」时归属不同——appendLeft 的插入物会随「以该 index 结尾的被移动区间」一起搬走，prependRight 则随「以该 index 开头的区间」。这是 move 语义的副产物，纯 overwrite 场景下二者效果接近。
  依据: magic-string 官方 README `appendLeft`/`prependRight` 描述（"If a range ending/starting with index is subsequently moved..."）

- **推断（标注为推断）**：在「需要大幅重排版面的变换」（如把整段代码结构推倒重排）场景下，magic-string 的就地外科手术范式会显得笨拙——这类场景更适合重建 AST 再 codegen；但 codegen 路线的 sourcemap 重建远比就地编辑难，这正是编译器普遍偏好 magic-string 做「局部改写」的原因。该推断基于 magic-string API 形态与 Vue/Rollup 实际用法归纳，未见官方文档明确对比。

- **易混淆点**：sourcemap 的 mappings 用的是**差值（delta）编码**——每个字段的值是「相对上一个同字段值的增量」，而非绝对值。这是初读 sourcemap 最反直觉处：解码时必须累加。magic-string 内部生成 decoded map 时给出的是绝对数组形式，VLQ 差值压缩发生在编码为字符串的环节。
  依据: TC39 Source Map v3 spec mappings 字段定义；Rich-Harris/vlq README（delta encoding 说明）

- **边界**：magic-string 适合「对一段代码做若干局部修改」，作者本人将其定位为 "light modifications... replacing a few characters here and there, wrapping it with a header and footer"。它不是通用 AST codegen 工具——这一点决定了它在宏变换里的角色是「AST 给 offset、magic-string 做精确小手术」，而非「从 AST 重新生成整份代码」。
  依据: magic-string 官方 README 项目定位描述

- **未理解 / 待查证**：magic-string 在并发多趟变换（多个 visitor 对同一实例交错写入）时，区块链表的 split 时序与 byStart/byEnd 索引一致性如何在源码层保证、是否有重入风险——本调研未深入其线程/重入安全性细节，建议 Writer 不展开，如需深究应回查源码 `_split` 与索引维护逻辑。
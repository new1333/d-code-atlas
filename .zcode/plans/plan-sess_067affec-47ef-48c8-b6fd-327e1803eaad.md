# 提示词改造计划：跨章去重 + 结尾钩子对齐 + 位置依概念

## 目标与范围

针对 pinia 产出 review 暴露的 3 个高频问题（同一原理被相邻多章重复讲解、章末"后续章节"预告与真实 topoOrder 顺序错位、单文件章被机械塞进 primitive 层导致位置偏早），系统性改造引擎提示词。**只动 prompt + 上下文透传，不改产物类型、不引入新 layer、不动 critic 验收标准。**

复跑 `bun run src/bin/atlas.ts resume pinia`（强制重跑 write stage）即可验证。

---

## 改动一：上下文透传管道（B3 的前提，TS 层）

让 write/research stage 把"当前 slug 在 topoOrder 里的前驱/后继/位置 + 前置章标题"算好，喂给 Writer/Reader agent。

### 1.1 新增共享类型与工具函数

**新建 `src/lib/chapter-context.ts`**（或在 `src/lib/io.ts` 末尾追加，二选一；推荐独立文件便于测试）：

```ts
// 章节上下文：由 stage 算好，透传给 Writer/Reader 的 user prompt。
export interface ChapterContext {
  /** 当前 slug 在 topoOrder 中的位置（从 0 起）。 */
  position: number;
  /** 全书章数（= topoOrder.length）。 */
  total: number;
  /** 前驱章标题（topoOrder 前一项），首章为 null。 */
  prevTitle: string | null;
  /** 后继章标题（topoOrder 后一项），末章为 null。 */
  nextTitle: string | null;
  /** 本章 dependsOn 指向的章标题列表（供 Writer 做跨章去重比对）。 */
  depTitles: string[];
  /** 本章 dependsOn 各章的 summary（供 Writer 判断某机制是否已被前置章讲透）。 */
  depSummaries: string[];
}
```

并提供一个纯函数 `buildChapterContext(outline: Outline, slug: string): ChapterContext | null`：
- 从 `outline.topoOrder` 找 index；从 `outline.chapters` 按 slug 查 title/summary。
- 全部纯内存操作，零 IO（数据 stage 已读进内存）。
- **配套测试** `test/chapter-context.test.ts`：覆盖首章/末章/中间章/unknown slug 四种 case（用中文测试名，符合 AGENTS.md 测试规范）。

### 1.2 扩展 `src/agents/writer.ts`

- `WriterOpts` 加一个**可选**字段 `chapterContext?: ChapterContext`（沿用 M08 `feedback?: string[]` 的非破坏性扩展先例，向后兼容）。
- 在 `prompt` 数组的"## 输入"小节后，新增一节"## 章节上下文（stage 已算好，请据此决定结尾钩子与去重）"，仅当 `chapterContext` 存在时插入：
  ```
  - 你是全书第 {position+1}/{total} 章。前置章：{prevTitle ?? "（首章，无前置）"}。
    紧邻下一章：{nextTitle ?? "（末章，无后继）"}。
    本章 dependsOn 的前置章及核心主题：
    {逐条列 depTitle + depSummary}
  ```
- 注意：Writer **不注入 system prompt**（刻意，见 writer.ts:143 注释），所以上下文必须进 user prompt。

### 1.3 扩展 `src/agents/reader.ts`

- `ReaderOpts` 加可选 `chapterContext?: ChapterContext`。
- 同样在 user prompt 插入"## 章节上下文"小节。Reader 拿到上下文后，能在 research.md 的「给 Writer 的教学钩子」里主动标注"本章哪些机制是前置章核心权衡的复用"（见改动三）。

### 1.4 stage 层算好透传

- `src/stages/05-write.ts`：`write()` 读到 outline 后（已有，行 198），在 `mapPool` 回调里调 `buildChapterContext(outline, slug)`，透传进 `writeChapter()` → `writer({ ..., chapterContext })`。改 `writeChapter` 签名多收一个参数。
- `src/stages/04-research.ts`：同样，在 `mapPool` 回调里算 context，透传进 `reader({ ..., chapterContext })`。

---

## 改动二：Writer 跨章去重硬规则 + 结尾钩子对齐（B1 + B3，prompt 层）

改 `src/agents/writer.ts` 的 user prompt（即真正生效的那份，writer.md 不注入但要同步注释——见改动四）。

### 2.1 在"### 结构：自底向上、原理驱动"小节，新增两条硬规则

**插入位置**：在现有的"- **自底向上**"那条之后、"**必须有关键权衡**"之前，加两条：

```
- **跨章去重（硬要求）**：写「关键权衡/核心思想」前，先比对上面「章节上下文」里
  dependsOn 各章的主题。如果某个机制在前置章已被作为该章的**核心思想或关键权衡**
  讲透（典型信号：它出现在前置章的 summary 里、或它的「选择→换来→代价」已被前置章展开），
  本章提到它时**只用一句话回指**（「这个时序第 N 章已展开，这里不重复」），**禁止重新演示
  同一原理**。你可以讲该机制「在本章语境下」的新侧面，但不能复述同一原理的同一面。
  这条是为了避免读者连读相邻章时，同一原理（如「先注册半成品再跑 setup」）被完整讲三遍。

- **章末小结如要预告后续，只点名紧邻下一章**：用上面「章节上下文」里的 nextTitle，
  且**只点这一章**。禁止罗列多个后续章名（容易与真实 topoOrder 顺序错位、误导读者按图索骥）。
  末章（nextTitle 为空）则不预告，只收束本章原理。
```

### 2.2 reader.md 的钩子分区加"复用关系"提示（配合改动三）

`src/prompts/reader.md` 的「给 Writer 的教学钩子」8 子项里，把「设计动机（为什么需要它）」这一项扩写，加一句承前要求：

```
- **设计动机（为什么需要它）**：这个机制是为了解决什么矛盾而生的？它换来了什么能力？
  其中若有「承前」部分（前置章建立的某个东西，本章是它的下一个动作），用一句话点明承前
  关系——参考 user prompt 里的「章节上下文」dependsOn 列表，判断本章哪些机制是前置章
  核心权衡的复用，标注「（已在第 X 章『Y』讲透，本章只看它的新侧面 Z）」，供 Writer 做跨章去重。
```

> 这是 B4 的轻量版——不新增分区，只扩写已有子项，符合"只做高 ROI 3 项"的范围。

---

## 改动三：Architect 位置依概念原则（B5，prompt 层）

改 `src/prompts/architect.md` §5.1「拆章原则」与 `src/agents/architect.ts` 的 user prompt。

### 3.1 architect.md §5.1 新增一条原则

**插入位置**：在现有"- **primitive 优先可演示的小原语**"那条之后，加一条：

```
- **位置依概念依赖，不依文件大小/独立性（硬约束）**：即使一章的 sourceFiles 只有一个文件，
  它的 layer 与 topoOrder 位置仍按「读者理解它需要的前置知识」决定，而不是按「单文件=原子」
  硬塞。判据反问：读者要听懂这一章，是否需要先懂某个分类/组装机制？若是，即使它是单文件，
  也应排在该机制章之后、并视情况升层。例：一个「从 store 解构字段」的工具，消费了 store
  的 state/getter/action 三分结构——它该排在讲清三分的章**之后**，而不是因「单文件」被塞到
  讲清三分的章**之前**。
```

### 3.2 architect.ts user prompt 同步

`src/agents/architect.ts` 的"## 任务"第 1 条「高屋建瓴拆概念」后，加一句呼应：

```
  （注意：章的 layer/顺序依「读者理解它需要的前置知识」决定，单文件章也可能因概念依赖而排在中后段，不必然是 primitive 层。）
```

---

## 改动四：文档同步（writer.md 维护约定）

`writer.md` 顶部已有"⚠️ 生效状态"声明它是 single source of truth 但**当前未注入**，改动必须同步到 writer.ts。本次改动遵守此约定：

- 在 `src/prompts/writer.md` §4.1 推荐结构的注释、§5.3 必须的写法、§6.1 自检清单里，**同步写入**改动二的"跨章去重硬规则"和"结尾钩子只点名紧邻下一章"两条措辞，保持 .md 与 writer.ts 一致。
- 在 `src/prompts/architect.md` 已是注入态，改动三直接生效。

---

## 不做的事（明确排除）

- ❌ 不引入 `"overview"` layer（types.ts 枚举改动面虽小，但 architect/assembler/critic-outline 多处三层语义硬编码需同步，超出"高 ROI 3 项"范围）。
- ❌ 不改 critic 的验收标准（critic-outline.md 5 条 vs critic.ts inline 4 条的不一致是已知 bug，但本次范围不含修复；避免改动面扩散）。
- ❌ 不改产物 schema（Chapter/Outline 接口不动）。
- ❌ 不改 run-claude.ts（注入机制已满足，context 走 user prompt）。

---

## 验证计划

1. `bunx tsc --noEmit` 通过（strict）。
2. `bun test` 通过，含新增的 `test/chapter-context.test.ts`。
3. 复跑验证（建议而非必须）：
   - `bun run src/bin/atlas.ts clean pinia --keep source` 或直接对 write stage 续跑；
   - 重点抽查 pinia 第 6/7/8 章（store.ts 被 8 章引用的"先注册半成品"机制）：改后应只见第 6 章权威讲透，第 7/8 章只一句话回指；
   - 抽查第 1 章结尾：应只点名第 2 章（subscriptions），不再罗列"插件系统、SSR hydration"等错位预告。
   - 抽查第 5 章 storeToRefs：layer/位置是否按概念依赖调整（这一项依赖 Architect 重跑 outline，若只续跑 write 则看不到效果——属可选验证）。

---

## 改动文件清单（共 7 个文件，1 个新建）

| 文件 | 改动类型 | 说明 |
|---|---|---|
| `src/lib/chapter-context.ts` | **新建** | `ChapterContext` 接口 + `buildChapterContext` 纯函数 |
| `test/chapter-context.test.ts` | **新建** | 首章/末章/中间章/unknown 四 case |
| `src/stages/05-write.ts` | 改 | `write()`/`writeChapter()` 算 context 并透传 |
| `src/stages/04-research.ts` | 改 | `research()` 算 context 并透传给 reader |
| `src/agents/writer.ts` | 改 | `WriterOpts` 加 `chapterContext?` + user prompt 加两条硬规则 |
| `src/agents/reader.ts` | 改 | `ReaderOpts` 加 `chapterContext?` + user prompt 加章节上下文小节 |
| `src/prompts/reader.md` | 改 | 「设计动机」子项加承前/复用关系提示 |
| `src/prompts/architect.md` | 改 | §5.1 加「位置依概念依赖」原则 |
| `src/agents/architect.ts` | 改 | user prompt 任务第 1 条加位置原则呼应 |
| `src/prompts/writer.md` | 改 | 同步 .md 与 writer.ts（维护约定，未注入但需一致） |

> 注：architect.md 改动后，**只有在重跑 outline stage 时才生效**（pinia 现有 outline 不会自动调整）。writer/reader 改动在续跑 write/research stage 时立即生效。
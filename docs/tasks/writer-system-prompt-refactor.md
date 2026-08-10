# 任务:消除 Writer 双轨制,`writer.md` 重新注入为 system prompt(路线 A)

> 聚焦的提示词架构重构任务。与 `prompt-optimization.md`(文风分层 / 跨章一致性)是**不同关注点**:
> 那个计划管「Writer 该怎么写」,本任务管「Writer 的指令该从哪里来」——即消除 `writer.md` 与
> `writer.ts` 的双轨制。两者独立,可分别推进。
>
> 本文档可独立执行:照着 §3 的逐文件清单改、按 §4 验证、必要时按 §5 回退。

---

## 0. 背景与根因

### 0.1 现状:`writer.md` 未注入,真正生效的是 `writer.ts` 的 user prompt

| 文件 | 角色 | 是否真正注入到 Claude |
|---|---|---|
| `src/prompts/writer.md` | **权威文档(SSOT)**,记录所有写作规范 | ❌ **当前未注入**(顶部红字声明) |
| `src/agents/writer.ts` 的 `prompt` 数组 | **实际注入的 user prompt** | ✅ **真正生效** |

证据:
- `writer.ts:11-14` 注释明确写「不注入 system prompt」。
- `writer.ts` 的 `runClaude({...})` 调用里**没有** `systemPromptPath` 字段。
- 对比 `reader.ts:57,123-125` 与 `architect.ts:54,71-72` 都有 `const systemPromptPath = promptPath("reader"/"architect")` 并传入 `runClaude`。
- `writer.md:3-17` 顶部红字「生效状态(必读)」声明本文件未注入,并要求两处手动同步。

### 0.2 根因:`writer.md` 内部自相矛盾,导致 Claude 顽固调 Write

当年停止注入的直接原因(`writer.md:8-10`、`writer.ts:218-219` 记录):

- `writer.md` 的 **§2 工具约束** 硬要求「允许工具集:`Read/Glob/Grep/Write/Edit`」+「可写范围:`draft.md` 与 `replica/`」。
- `writer.md` 的 **§4.2 replica/** 硬要求「把演示代码逐字同步存成独立文件」「配 `package.json` 能 `bun run` 跑」「draft 内嵌与 replica 逐字一致(AC-5)」。
- 后来加了 **§0 产出方式** 说「本次运行改为 stdout 输出,不要 Write/Edit、不要创建 replica/」,试图用「§0 覆盖 §2/§4.2」的条件门控来打补丁。
- **但实测失败**:Claude 读到 system prompt 内部互相打架的指令(§0 说不要 Write、§2/§4.2 又硬要求 Write + replica 落盘),会顽固倾向更具体的工具指令(Write),即便 user prompt 说「不要 Write」。表现是 Claude 停下来「等授权」或直接分析输出到 stdout,不调 Write 也不产出 fence。
- 当时的妥协:**停止注入 `writer.md`**,把所有写作要求搬进 `writer.ts` 的 user prompt,保留 `writer.md` 作 SSOT,约定两处手动同步。

### 0.3 为什么现在能做(解法)

把 §2/§4.2 及所有残留的 Write/replica 指令**彻底清掉**(不是条件门控,是物理删除),让 `writer.md` 全文统一成 stdout fence 输出,system prompt 内部不再矛盾,就能安全重新注入。

这比当年「条件门控(§0 盖住 §2)」更可靠——条件门控本身在实测中失败了,只有消除矛盾才行。

### 0.4 双轨制的具体危害(为什么要根治)

- 靠人工纪律维护「两处必须同步」,没有任何机制保证。任何人改了一处忘了另一处,就会出现「文档说一套、实际做一套」。
- 当前两处**已经在大量细节上不完全一致**:
  - `writer.md` §5.7 有完整的「禁用生硬抽象词清单」表格,`writer.ts:154-157` 只列精简版。
  - `writer.md` §5.8「反 LLM 写作惯性」完整 6 条,`writer.ts:164-171` 浓缩但措辞有差异。
  - `writer.md` §4 的「本质矛盾」要求写法更详细。
- `writer.ts` 的 user prompt 是挤在 TypeScript 字符串数组里的精简版,不适合人类阅读和维护写作规范;规范腐化风险随时间累积。

---

## 1. 目标与非目标

### 目标

1. `writer.md` 重新作为 system prompt 注入(经 `--append-system-prompt-file`),与 reader/architect 的架构对齐。
2. `writer.md` 全文不再含任何 Write/Edit/replica 落盘指令,内部无矛盾。
3. `writer.ts` 的 user prompt 精简到只剩运行时变量(slug、cwd、章节上下文、Critic 反馈),不再承载文风/结构/权衡规范。
4. 消除双轨制,`writer.md` 成为唯一权威且真正生效。
5. Writer 行为稳定:Claude 不再顽固调 Write,稳定产出 4 反引号 markdown fence,文风符合规范。

### 非目标

- **不改** Writer 的输出契约(stdout fence + readonly 工具,这套机制本身稳定,不动)。
- **不改** Writer 的写作规范内容(文风宪法、关键权衡硬要求、反 AI 腔、mermaid 指引等只是「搬家」,从 writer.ts 迁回 writer.md,内容基本不变)。
- **不改** verdict 逻辑(Critic·Chapter 仍是 6 条标准,只是标准③去掉 AC-5/replica 校验)。
- **不引入** replica/ 落盘机制(stdout 模式下产物就是 fence,不落盘 replica)。

---

## 2. 关键事实与约束

### 2.1 `--append-system-prompt-file` 是「追加」不是「替换」

`run-claude.ts:190-192`:
```ts
if (opts.systemPromptPath && opts.systemPromptPath.trim() !== "") {
  args.push("--append-system-prompt-file", opts.systemPromptPath);
}
```
追加到 Claude 默认 system prompt 之后。所以 `writer.md` 里只放角色规范,运行时变量(key/slug/cwd/feedback)继续留在 user prompt——这与 reader/architect 完全一致。

### 2.2 `promptPath("writer")` 接线已就绪

`src/agents/types.ts` 的 `PromptRole` union 已含 `"writer"`。只需在 `writer.ts` 加:
```ts
const systemPromptPath = promptPath("writer");
```
并传入 `runClaude({...})`。import 处补 `promptPath`(types.ts 已 import)。

### 2.3 章节上下文与 Critic 反馈是纯运行时变量,必须留在 user prompt

- `buildChapterContextBlock`(`writer.ts:61-79`):position/total/prevTitle/nextTitle/depTitles/depSummaries,每次调用都不同。
- `feedbackBlock`(`writer.ts:111-119`):上一轮 Critic 的 fixes,首轮省略。
这两块是 per-run 数据,不能进静态 .md 文件。

### 2.4 replica/ 删除后的连带影响:AC-5

AC-5 是「draft↔replica 逐字一致」的验收点。replica/ 删除后 AC-5 自动失效。需同步清理这些位置的 AC-5 引用:
- `writer.md` §4.2(line 170)、§6.2 #3(line 364)、§7(line 380)
- `critic-chapter.md` 标准③(line 93)
清理方式:去掉 AC-5 引用,保留「演示代码自洽、从零实现、不与源码逐字重合 > 50%」这些有效校验。

### 2.5 当年「顽固调 Write」的判定信号

重跑验证时,若 Claude 出现以下任一表现,说明根因未消除、路线 A 失败,需回退走路线 C:
- stdout 里出现「我无法写入」「被拦截」「等授权」等措辞,而非 4 反引号 fence。
- Claude 尝试调用 Write/Edit 工具(readonly 模式下会失败,但 Claude 会卡住)。
- 超时无产出。
- 产出的 fence 内容残缺(如只有几行、缺关键权衡/演示代码)。

---

## 3. 逐文件改动清单

### 3.1 `src/prompts/writer.md`(主改:清理 + 重写)

按段落列出具体动作。行号基于当前 dev 分支(`a39f8b1` + `4da5b1a` 后的状态)。

#### A. 顶部生效状态声明(line 3-17)——删除整块,换成普通注释

删除整块红字「⚠️ 生效状态(必读,2026-07 更新)」+「角色 prompt(系统级指令,**当前未注入**...)」。

替换为一行(对齐 reader.md:3-4 / architect.md:3-4 的措辞):
```markdown
> 角色 prompt(系统级指令)。本文件**全文**经 `--append-system-prompt-file` 注入 claude,作为 Writer 的角色指令。
> 对应 design §2、§4 Stage 5(Write)、§5(输出要点)、§8.3/§8.4(章节产物)、§7/ADR-0003(自底向上)。
```

#### B. §0 产出方式(line 19-43)——保留,重写措辞

这条 stdout fence 契约是核心,**必须留在 md 里**。改动:
- 标题去掉「⚠️ 最高优先级:覆盖下方一切关于"写文件/Write 工具/replica"的指令」——因为下方不再有需要覆盖的 Write 指令了。改成:`## 0. 产出方式`。
- 正文基本保留:最终回复必须且只能是 4 反引号 markdown fence;不用 Write/Edit;不创建 replica/;fence 外绝不写正文;4 反引号外层原因;正确示例;最小演示代码块仍必须写。
- 去掉「本次运行改为...」的「改为」措辞(不再是临时模式切换,是固定契约),改成「你的最终回复**必须且只能**是...」。

#### C. §2 工具约束(line 63-73)——重写

当前标题「写权限,严格限定范围」+ 硬要求 Write/Edit + replica/。重写为:

```markdown
## 2. 工具约束(只读核对)

- **允许的工具集**:`Read`、`Glob`、`Grep`。**禁止** `Write`、`Edit`(你没有写权限)。
- 工具权限由 `run-claude.ts` 在命令层强制(`--allowedTools Read,Glob,Grep`),无逃生口(ADR-0005、AC-7)。
- **你的职责是用 Read/Glob/Grep 核对技术准确性**——读 `research.md`、读源码、核对行为语义。
  你**不落盘任何文件**:draft.md 的全文以 stdout fence 返回(见 §0),由 Stage 原子落盘。
- **严禁**(虽在 readonly 下天然成立,但写明强化边界):写/改源仓库、写 `work/outline.json`、
  写其它章节目录、写 `site/`。
```

删除 line 73「若 §0 生效...作废」条件门控(不再需要)。

#### D. §4.1 draft.md(line 92-156)——保留,微调措辞

内容是格式/结构要求(章节骨架),无 Write 触发。改动:
- 小节标题从 `### 4.1 work/chapters/{slug}/draft.md` 微调成 `### 4.1 你的输出(draft.md 内容)`,与 §0 的 stdout 模式衔接。
- 正文里「draft.md」的文件框架措辞,在不改变结构骨架的前提下,微调成「你的 fence 输出(即 draft.md 内容)」。
- **结构骨架全部保留**:动机 → 核心思想 → 心智模型 → 关键权衡(含讲透本质矛盾) → 最小原理演示 → 执行轨迹 → 教学简化说明 → 小结。
- 章首承上、跨章去重、章末预告的硬要求保留(这些规范现在由 md 承载,不再依赖 user prompt)。

#### E. §4.2 replica/(line 158-170)——整节删除

root cause 之一。stdout 模式下没有 replica/ 可落盘。**整节删除**,不留条件门控(条件门控就是当年失败的方案)。删除的标题行 `### 4.2 work/chapters/{slug}/replica/(仅当 §0 未废除落盘时)` 也一并去掉。

#### F. §5.4 原理演示规则(line 219-227)——保留,微调 line 227

内容是演示代码规则(从零实现、小而聚焦、不抄源码、载体 TS/JS 优先)。改动只 line 227 那句:

当前:
```
...就用 TS/JS 写演示(配最小 `package.json`,使其能 `cd replica && bun install && bun run <entry>` 跑
(能跑最好,**非硬要求**))...
```
改成:
```
...就用 TS/JS 写演示(内嵌代码块即可,不要求可独立运行;能 `node`/`bun` 跑通最好,非硬要求)...
```
去掉 `replica` / `bun install` / `package.json` 措辞,消除「造可运行工程」的误导,但保留「能跑最好」的软鼓励(内嵌代码块本身能跑是加分项)。

#### G. §6.2 自检清单 #3(line 364)——改写

当前:
```
3. **原理演示自洽**:有完整的最小演示代码块(从零实现,不 import 原仓库,不与源码逐字重合 > 50%);
   自洽、能演透核心思想。若本模式要求 replica,则内嵌与 `replica/` 逐字一致。—— 对应 Critic 标准③、AC-5。
```
改成(去掉 replica/AC-5):
```
3. **原理演示自洽**:有完整的最小演示代码块(从零实现,不 import 原仓库,不与源码逐字重合 > 50%);
   自洽、能演透核心思想。—— 对应 Critic 标准③。
```

#### H. §7 硬约束(line 377-386)——改写两条

- line 380「在需要落盘 replica 的模式下:演示代码一致性是硬约束(AC-5);内嵌与 replica/ 逐字一致」→ **删除整条**(replica 没了)。
- line 384「可写范围:仅限 `work/chapters/{slug}/`(§0 模式下不写盘)」→ 改成「**产物以 stdout fence 返回,不落盘任何文件**(见 §0)」。
- 其余(关键权衡硬要求、正文零源码对照、中文正文、职责边界)保留。

#### I. 上一轮加的 mermaid 指引——保留不动

在 §5.3 后面的「可视化(可选,克制使用)」那条(来自 commit `a39f8b1`),内容正确,保留。

---

### 3.2 `src/agents/writer.ts`(精简 user prompt + wire-up)

#### A. wire-up 改动

1. import 处补 `promptPath`(当前从 `./types.ts` import 了其它,补上)。
2. 在 `writer()` 函数内(约 line 100 附近,`cwd`/`wdir` 定义之后)加:
   ```ts
   const systemPromptPath = promptPath("writer");
   ```
3. `runClaude({...})` 调用(约 line 211)加字段 `systemPromptPath,`。
4. 删除 `runClaude` 调用处(约 line 213-216)的注释:
   ```ts
   // 不用 system prompt(writer.md 的 Write/replica 指令会让 claude 顽固尝试 Write 工具,
   // 即便 user prompt 说"不要 Write"。实测无 system prompt 时 claude 更可能遵守 stdout 输出)。
   ```
   改成:
   ```ts
   // system prompt = writer.md(写作规范:文风、结构、权衡、mermaid 等)。
   // user prompt 只含运行时变量(slug、cwd、章节上下文、Critic 反馈)。
   ```
5. 删除文件顶部注释(line 11-14)关于「不注入 system prompt」的说明,改成:
   ```ts
   //   - system prompt = writer.md(写作规范的唯一权威);user prompt 只含运行时变量。
   //     与 reader.ts/architect.ts 的架构对齐。
   ```

#### B. user prompt 精简(Bucket A 保留 / Bucket B 删除)

**保留(Bucket A:运行时变量,~40 行):**
- 一个精简的 `## 输入` 块,注入真实运行时变量 `${slug}`(对齐 reader.ts:123-125 / architect.ts:71-72)。当前 writer.ts 的输入块是静态路径(`research.md`/`../../../outline.json`/`../../../source/`),改成注入 slug 更规范:
  ```
  ## 输入
  - 本章 slug: ${slug}
  - cwd: ${cwd}(含 research.md;相对 cwd 读 ../../../outline.json、../../../source/)
  ```
- 一行简短的 fence 提醒(防 Claude 忘记 fence 格式):
  ```
  ## 输出方式(提醒,完整规范见 system prompt)
  - 只输出 4 反引号 markdown fence,fence 外不写任何文字。
  ```
- `buildChapterContextBlock` 输出(unchanged)。
- `feedbackBlock`(unchanged)。

**删除(Bucket B:迁回 writer.md,~90 行):**
- B1 角色开场句(`"你是技术文档撰写员。请基于源码事实摘录..."`)
- B2/B17 输出方式详述(`"## ⚠️ 输出方式(最重要,违反则作废)"` 整块 + `"### 再次强调输出方式"`——md §0 已有完整版)
- B4 markdown 格式要求(md 已有)
- B5 文体/通俗化(md §5.7 已有更完整版)
- B6 反 AI 腔(md §5.8 已有)
- B7 结构/自底向上(md §1/§6 已有)
- B8 章首承上(md §4.1 已有)
- B9 跨章去重(md §6.1 已有)
- B10 章末预告(md §4.1 已有)
- B11 关键权衡硬要求(md §4/§6.2 已有)
- B12 流程图(md §5.3 已有)
- B13 mermaid 指引(md §5.3 已有)
- B14 演示载体(md §5.4 已有)
- B15 正文零源码对照(md §5.2/§5.5 已有)
- B16 篇幅(md §4.1 已有)

精简后 user prompt 大致长这样(示意):
```ts
const prompt = [
  `你是 Writer(章节撰写员)。本章 slug: ${slug}。`,
  "",
  "## 输入",
  `- cwd: ${cwd}(含 research.md;相对 cwd 读 ../../../outline.json、../../../source/)`,
  "- 写作规范的完整要求见 system prompt(文风、结构、关键权衡、演示、mermaid 等),这里只给运行时信息。",
  "",
  "## 输出方式(提醒,完整规范见 system prompt)",
  "- 只输出 4 反引号 markdown fence,fence 外不写任何文字。",
  "- fence 内是 draft.md 的完整内容(章节正文 + 内嵌演示代码)。",
].join("\n") + contextBlock + feedbackBlock;
```

---

### 3.3 `src/prompts/critic-chapter.md`(配套:标准③去掉 AC-5/replica)

标准③「原理演示自洽」(line 90-94)当前含:
```
- 若存在 `replica/`:与内嵌代码**逐字一致**(AC-5);明显不一致 → 不过。
- 若流水线当前不要求 replica 落盘:只评 draft 内演示是否完整、自洽、不依赖原仓库。
```
replica/ 删除后,改成只保留「draft 内演示完整、自洽、从零实现、不与源码逐字重合 > 50%、不 import 原仓库」这一条。去掉 replica/AC-5 引用。**不动 verdict 逻辑**(仍是 6 条标准)。

---

### 3.4 `test/agents.test.ts`(writer 单测断言反转)

writer 单测(line 458+)有一条断言:
```ts
// 不用 system prompt。
expect(calls[0].args.includes("--append-system-prompt-file")).toBe(false);
```
改成(对齐 reader 单测 line 439-440):
```ts
// systemPromptPath → writer.md
const sysIdx = calls[0].args.indexOf("--append-system-prompt-file");
expect(calls[0].args[sysIdx + 1].endsWith("writer.md")).toBe(true);
```

---

## 4. 验证步骤

按顺序执行,任一步失败即停下排查:

### 4.1 类型检查
```bash
bunx tsc --noEmit
```
应无输出(无错误)。

### 4.2 单元测试(确认无回归)
```bash
bun test
```
期望:**442 pass / 141 fail / 2 skip**(与改动前 baseline 一致)。141 个失败全是既有 Path parser 失败,`grep "(fail)" | grep -v "Path parser"` 应为空。

重点看 writer 单测:`bun test test/agents.test.ts` 应全绿(改了断言后)。

### 4.3 关键验证:重跑 pinia 的 1-2 章,确认 Writer 行为稳定

这一步是路线 A 成败的关键。需 Claude CLI 可用 + 网络。

**最小验证**(单章):
```bash
bun run src/bin/atlas.ts run pinia --only write --force
```
或针对单章:
```bash
# 用 resume 续跑指定章(参考 atlas.ts 的 resume 命令)
bun run src/bin/atlas.ts resume <key> --only write
```

**观察点**(对应 §2.5 的判定信号,全部反过来):
- ✅ Claude 不再尝试 Write/Edit 工具,直接产出 4 反引号 markdown fence。
- ✅ fence 内容完整:含动机、核心思想、关键权衡(选择/换来/代价)、最小演示代码、执行轨迹。
- ✅ 文风符合规范:人话开头、无生硬抽象词、有克制类比、权衡篇幅 ≥ 演示篇幅。
- ✅ 不含 `文件名:行号` / 源码对照小节。
- ✅ stage 正常 done,产物落盘 `work/chapters/{slug}/draft.md`。

**若失败**(Claude 又顽固调 Write / fence 残缺 / 超时):
- 不要反复重试——根因可能是更深的问题(如 Claude headless 对 `--append-system-prompt-file` 与 readonly 工具集的组合有其它 quirk)。
- 按 §5 回退,改走路线 C(writer.ts 顶部加同步检查注释,双轨制保留但加防护)。

### 4.4 完整验证(可选,若 4.3 通过)
重跑 pinia 整轮(或剩余章),确认所有章 Writer 稳定:
```bash
bun run src/bin/atlas.ts run https://github.com/vuejs/pinia --force
```
跑完后用 `scripts/selfcheck.sh <key>` 按 AC-1..AC-7 核验产物。

---

## 5. 回退方案

这次改动是一个独立的 commit(建议 message:`refactor(engine): 消除 Writer 双轨制,writer.md 重新注入为 system prompt`),回退干净。

### 5.1 若 4.3 验证失败(Claude 又顽固调 Write)

```bash
git revert HEAD   # 回退这次 commit
```
然后改走路线 C(止血):
- 在 `writer.ts` 顶部加一段醒目的同步检查注释,列出必须与 `writer.md` 同步的关键段落。
- 不解决根本问题,但降低「两处不一致」的风险。

### 5.2 若 4.3 验证通过但后续 Run 发现质量问题

可能是 user prompt 精简过度导致 Claude 漏了某条规范。排查:
- 对比产出与 `writer.md` 规范,找出哪条没被遵守。
- 确认该条在 `writer.md` 里确实存在(可能是我删除/改写时漏了)。
- 补回 `writer.md` 对应段落(不动 user prompt,因为规范现在归 md 管)。

---

## 6. 提交约定

按 AGENTS.md 的 Conventional Commits,scope 用里程碑编号或引擎模块。这次属于引擎架构重构,建议:

```
refactor(engine): 消除 Writer 双轨制,writer.md 重新注入为 system prompt

- writer.md:清理 §2/§4.2/AC-5/replica 指令,删除生效状态红字,重写 §0/§2/§7,
  全文统一成 stdout fence 输出,system prompt 内部不再矛盾(当年停止注入的根因)。
- writer.ts:加 systemPromptPath=promptPath("writer"),精简 user prompt 到只剩运行时
  变量(slug/cwd/章节上下文/Critic 反馈),文风与结构规范迁回 md。与 reader/architect 对齐。
- critic-chapter.md:标准③去掉 AC-5/replica 校验(replica 删除后连带)。
- test/agents.test.ts:writer 单测断言反转(systemPromptPath 现在为 true)。

验证:tsc 通过;bun test 442 pass / 141 fail(与 baseline 一致,零回归);
重跑 pinia 单章确认 Writer 稳定产出 fence、不顽固调 Write。
```

---

## 7. 附:探索阶段的完整清单(备查)

### 7.1 writer.md 里需清理的 Write/replica 指令完整位置

基于探索 agent 的审计(行号基于当前 dev):

| # | 位置 | 行 | 性质 | 动作 |
|---|---|---|---|---|
| 1 | §2 工具约束 | 65 | 硬要求 Write/Edit | 删 |
| 2 | §2 工具约束 | 66 | 命名 replica/ 为可写范围 | 删 |
| 3 | §2 工具约束 | 71 | 命名 --allowedTools ...,Write,Edit | 删 |
| 4 | §4.2 replica/ | 160 | 要求把演示同步存进 replica/ | 整节删 |
| 5 | §4.2 replica/ | 162 | 要求可运行 replica 包 | 整节删 |
| 6 | §4.2 replica/ | 168 | 要求 replica 文件命名 | 整节删 |
| 7 | §4.2 replica/ | 169 | 要求 manifest 文件 | 整节删 |
| 8 | §4.2 replica/ | 170 | AC-5 draft↔replica 一致 | 整节删 |
| 9 | §7 硬约束 | 380 | 重申 AC-5/replica | 删该条 |
| 10 | §6.2 #3 | 364 | 自检里重申 replica/AC-5 | 改写去 AC-5 |
| 11 | §2 标题 | 63 | 标题广告「写权限」 | 重写标题 |
| 12 | §4.2 | 166 | 软性强化 replica 落盘 | 整节删 |
| 13 | §5.4 | 227 | 提 package.json/bun run(软) | 微调措辞 |
| 14 | §0 | 24-25 | 已说「不要 Write/replica」 | 保留,重措 |
| 15 | §0 | 40-41 | 已声明 §1-§7 Write 指令作废 | 保留(去掉「作废」措辞) |
| 16 | §2 | 73 | 条件门控「若 §0 生效」 | 删(不再需要) |
| 17 | §4.2 标题 | 158 | 条件门控标题 | 整节删 |
| 18 | §7 | 384 | 写范围 + §0 模式 | 改写 |
| 19 | 顶部声明 | 5-10,16 | meta:记录未注入状态 | 删整块 |

### 7.2 writer.ts user prompt 的 Bucket A/B 完整分类

见 §3.2 的「保留/删除」清单(基于探索 agent 对 line 121-214 的逐块分类)。

### 7.3 对比:reader.ts / architect.ts 如何使用 systemPromptPath

```ts
// reader.ts:57, 123-125
const systemPromptPath = promptPath("reader");
const result = await runClaude({ prompt, systemPromptPath, cwd, tools: "readonly", ... });

// architect.ts:54, 101-104
const systemPromptPath = promptPath("architect");
const result = await runClaude({ prompt, systemPromptPath, cwd, ... });
```
`writer.ts` 改完后与两者完全对齐。`--append-system-prompt-file` 追加到 Claude 默认 system prompt 之后(run-claude.ts:190-192)。

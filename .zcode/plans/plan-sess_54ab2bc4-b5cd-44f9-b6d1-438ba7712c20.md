# 优化提示词产出更优质教程 —— 实施计划

## 背景与目标

以读者视角阅读 `atlas/pinia/` 产物后，目标是让读者能**流畅读完 + 懂原理 + 触类旁通**。诊断结论：逐章质量已饱和（第 1/5/15 章达标），缺口几乎全在「全书层」。本计划针对 prompts 做针对性优化。

## 已确认的决策（grill 拍板）

| # | 决策 | 落地方式 |
|---|---|---|
| 1 | 主攻全书层 | 逐章只在 writer.md 加两条自检 |
| 2 | 全书入口 = 00-导读 | 新增导读 Agent prompt + 在 Assemble stage 内部调用 |
| 3 | 导读 Agent 不新增 pipeline stage | 在 `06-assemble` 内部、Assembler 搬运前跑，零类型改动 |
| 4 | 导读必含一句话主线/spine | 写进 synthesizer.md |
| 5 | 触类旁通重心 = Writer 讲透本质矛盾 | writer.md §4 加要求 |
| 6 | 跨章呼应降为可选锦上添花 | writer.md 明示非必须 |
| 7 | 章首承上 = Writer 硬要求 | writer.md §8 加 + 自检清单加 |
| 8 | 不动 Critic | 新要求只进 writer.md 自检 |
| 9 | 侧边栏标题漂移统一为「原子层/复合层/系统层」 | 改 assembler.md + assembler.ts |

---

## 改动清单（共 5 个文件改 + 1 个新增 + 1 个 io helper）

### A. 新增 `src/prompts/synthesizer.md`（导读作者 Agent 角色指令）

**仿 reader.md 文风宪法**：人话开场、禁源码行号、禁生硬抽象词、stdout fence 输出。

**角色**：Synthesizer（导读作者）。读全部 `work/chapters/{slug}/draft.md` + `outline.json`，产出一篇 `work/prologue/draft.md`。

**工具约束**：只读（`Read/Glob/Grep`），产物以 ```` ````markdown ```` fence 输出，由 stage 落盘（沿用 Reader 只读契约）。

**产物结构**（必含四块）：
1. **一句话主线 / spine** —— 全书抽象纲领（如 pinia 可概括为「一个 detached effectScope + 一个全局 activePinia 指针撑起整个生态」）。所有章节按这条主线定位。若仓库提炼不出干净主线，明示「本书无单一主线，按 layer 自洽」并按 layer 组织。
2. **阅读路线** —— 线性路线（按 topoOrder）+ 按主题路线（如「只关心响应式原理」「只关心 SSR」）。
3. **核心原理清单** —— 全书反复出现的原理（如 effectScope、activePinia 指针、effectScope 托管），点明它们在哪几章现身。
4. **脉络图** —— 用 ASCII / 文字 / 简表呈现各章依赖关系与 layer 归属。

**输入说明**：cwd = `atlas/{key}/`；读 `work/outline.json`（chapters + topoOrder + summary）、`work/chapters/*/draft.md`、`work/repo-map.json`（站名/简介）。

**自检清单**：主线是否点透、阅读路线是否覆盖线性+主题两路、原理清单是否点到跨章复现的原理、脉络图是否与 topoOrder 一致、零源码行号。

---

### B. 改 `src/lib/io.ts`（+1 helper）

在 `draftPath`（96-99 行）之后新增：

```ts
/** 导读产物：`atlas/{key}/work/prologue/draft.md`。 */
export function prologuePath(key: string): string {
  return joinPath(workDir(key), "prologue/draft.md");
}
```

遵循现有 `researchPath`/`draftPath` 的注释 + 单行实现模式。

---

### C. 新增 `src/agents/synthesizer.ts`（导读 Agent）

**仿 `src/agents/reader.ts` 结构**（reader.ts 是最干净的 system-prompt + readonly + fence 模板）：

- **Opts**：`extends AgentCommonOpts` + `key`。
- **Outcome**：`extends AgentOutcome` + `prologueMd: string | null`。
- **cwd**：`runDir(key)`。
- **systemPromptPath**：`promptPath("synthesizer")` → 需在 `src/agents/types.ts:24-31` 的 `PromptRole` 联合类型加 `"synthesizer"`。
- **addDirs**：`[workDir(key), promptsDir()]`（workDir 读所有 draft + outline；promptsDir 是惯例）。
- **工具模式**：`tools: "readonly"`。
- **validate**：`(stdout) => extractFence(stdout, "markdown") !== null`。
- **返回**：`extractFence(result.stdout, "markdown")` → `prologueMd`；`ok: result.ok && prologueMd !== null`。
- **timeoutMs / retries**：与 reader 一致（25*60*1000 / 3）。

**user prompt** 要点：告知 cwd、读取范围（全部 draft + outline + repo-map）、产物路径 `work/prologue/draft.md`、四块产物结构、输出契约（fence 包裹整篇、fence 外不写任何字）。

---

### D. 改 `src/agents/types.ts`（PromptRole +1 成员）

`PromptRole`（24-31 行）加 `"synthesizer"`：

```ts
export type PromptRole =
  | "surveyor" | "architect" | "critic-outline" | "critic-chapter"
  | "reader" | "writer" | "assembler" | "synthesizer";
```

这是 `promptPath("synthesizer")` 能通过类型检查的前提。

---

### E. 改 `src/stages/06-assemble.ts`（Assemble 内部先调导读 Agent）

在「调 Assembler 搬运」之前插入「调 Synthesizer 产导读」子流程。**不新增 stage**，prologue 的成败挂在 assemble stage 上。

伪代码（在现有 `assembler(...)` 调用，即 72 行之前）：

```ts
// 0) 先调 Synthesizer 产导读（可选产物：失败不阻断搬运，但记 warning）。
const syn = await synthesizer({ key, model, spawn });
if (syn.ok && syn.prologueMd) {
  await writeText(prologuePath(key), syn.prologueMd); // 原子写
} else {
  // 导读失败 → 不 fail 整个 stage，记 stderr 继续（site 仍可构建，只是无 00-导读）
  m = setStageStatus(m, "assemble", "running", { cmd: syn.cmd });
  // 记录 warning 到 manifest（用 stderr 字段），但不改 status
}
```

**关键设计抉择：导读失败是否阻断 assemble？** —— 推荐不阻断。理由：prologue 是锦上添花，章节正文才是主体；导读失败时让 site 照常构建（只是缺 00-导读），比让整个 assemble 失败更合理。Stage 校验里对 prologue 也用「存在才校验、不存在不报错」的弱校验。

随后在结构校验循环（101-110 行）之后加：

```ts
// 3.5) 若 prologue 存在，校验 00-prologue.md 已搬运。
const prologueDraft = prologuePath(key);
if (await pathExists(prologueDraft)) {
  const expectedPrologue = joinPath(guideDir, "00-prologue.md");
  if (!(await pathExists(expectedPrologue))) {
    errors.push(`缺 guide 文件（导读）: ${expectedPrologue}`);
  }
}
```

---

### F. 改 `src/agents/assembler.ts`（user prompt 适配 prologue + 修标题漂移）

1. **标题漂移修正**（125 行）：把「核心原语/组合机制/应用集成」改为「原子层/复合层/系统层」（与实际产物 config.ts 一致）。同样修正 135 行自检项③。
2. **prologue 搬运指令**（在「任务」节，118 行后）加一条：
   - 若 `work/prologue/draft.md` 存在，把它逐字复制为 `site/guide/00-prologue.md`（编号 00，先于所有章节）。
   - 侧边栏在「原子层」组之前加一个「导读」组，只挂 `{ text: "导读", link: "/guide/00-prologue" }`。
3. **自检项**（132 行后）补：若 work/prologue/draft.md 存在，则 site/guide/00-prologue.md 存在且逐字一致；侧边栏首组为「导读」。

---

### G. 改 `src/prompts/assembler.md`（搬运扩容 + 修标题漂移 + prologue 特例）

1. **§4.1 搬运**（41-44 行）：在 topoOrder 循环规则之外，加 prologue 特例 —— `work/prologue/draft.md`（若存在）→ `site/guide/00-prologue.md`，编号 00 不受 `(i+1).padStart` 规则约束。
2. **§4.2 sidebar**（47-92 行）：
   - 51 行标题改为「原子层/复合层/系统层」（修漂移）。
   - 在 primitive 组之前加「导读」组（只挂 00-prologue）。
   - 修改「分组顺序固定为 primitive → composite → system」为「导读 → primitive → composite → system」（导读为可选首组）。
3. **§4.2 代码示例**（57-87 行）：示例 config.ts 加「导读」组、标题改为原子层/复合层/系统层。
4. **§5.2 自检清单**（126-133 行）：补 prologue 校验项；标题对齐。
5. **§6 硬约束**（136-141 行）：侧边栏顺序描述同步改为「导读（若有）→ primitive → composite → system」。

---

### H. 改 `src/prompts/writer.md`（重心：讲透本质矛盾 + 章首承上）

这是「懂原理 + 触类旁通」的核心改动。

1. **§4 关键权衡**（114-117 行附近）加一条要求：
   > 每条权衡除「选择 X → 换来 Y → 代价 Z」外，**还要点透化解的本质矛盾**（是哪两个对立需求在打架）。让读者带走的是「这类问题的通解骨架」，而非「本仓库的某个具体决定」。例：effectScope 那条权衡，不止讲 Pinia 选 detached，要点出背后的本质矛盾是「响应式资源要随某个生命周期集体回收」这个普适问题。

2. **§8 小结**（135-138 行）旁新增「**章首承上**」硬要求：
   > 每章正文开头（第 1 节「动机」之前或其中）用 1-2 句承接紧邻上一章 ——「上一章讲了 X，解决了 Y；但留下了 Z，本章接着 Z 讲」。**首章**（无前置）改用「全书为什么从本章开始」开场。措辞朴素承接即可，不堆模板套话。

3. **跨章呼应降级**（§6.1 跨章去重那条附近）：明示「同原理族正向呼应」为**可选锦上添花**，非必须；若写，只用一句话回指，不展开。

4. **§6.2 自检清单**（324-334 行）加两条（对应你的决定：用 Writer 自检，不进 Critic）：
   - 第 8 条：章首是否承接上一章（首章是否说清「为什么从这里开始」）。
   - 第 9 条：每条关键权衡是否点透了化解的本质矛盾，而非仅讲「本仓库的选择/代价」。

**不动**：`reader.md`、`architect.md`、`critic-chapter.md`、`critic-outline.md`、`surveyor.md`。

---

## 执行顺序（建议）

1. **B + D**（io helper + PromptRole）—— 基础设施，无依赖。
2. **A + C**（synthesizer.md + synthesizer.ts）—— 导读 Agent，依赖 D。
3. **H**（writer.md）—— 独立，可并行。
4. **G + F**（assembler.md + assembler.ts）—— 互相关联，一起改。
5. **E**（06-assemble.ts）—— 串接导读 Agent，依赖 B/C。

## 验证

- `bunx tsc --noEmit` 通过（关键检查点：PromptRole 新成员、prologuePath 类型、StageResult 兼容）。
- `bun test` 通过（注意：本计划**不新增** stage，所以 `test/manifest.test.ts` 的 STAGE_ORDER 断言**不需要改**——这是选「Assemble 内部调」而非「新增 stage」的收益）。
- 对 pinia 重新跑一次（或 resume 到 assemble），确认产出 `00-prologue.md`、侧边栏首组为「导读」、各章章首有承上句。

## 不在本次范围（明确排除）

- 不新增 pipeline stage（避免改 StageName/STAGE_ORDER/STAGE_FN/orchestrator）。
- 不改 Critic（新要求靠 Writer 自检）。
- 不做书外迁移类比（触类旁通靠讲透本质矛盾，不靠标签）。
- 不做独立脉络图（并入 00-导读用 ASCII 呈现）。
- 不补 effectScope 等具体跨章呼应（降为可选）。
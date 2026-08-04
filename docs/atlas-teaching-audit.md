# Atlas 教学性审查报告

> 审查对象：`atlas/{mitt,router,yt-dlp,pinia}` 四个 Run 的「章节目录 + 章节内容」是否适合作为「由浅入深、易理解、学完能懂核心原理」的教学内容。
> 审查日期：2026-08-04。方法：15-agent 工作流（baseline 提示词建模 → 逐 atlas 审查+归因 → 横切综合 → 对抗验证），辅以人工精读 4 章（mitt emitter-state-as-map、mitt events-type-inference、router router-core-navigation、yt-dlp format-selection、pinia subscription-primitive）。

## 0. 一句话结论

**四个 atlas 的章节目录与章节正文，全部达到教学标准，没有阻断性内容缺陷。** 短板集中在两处且都不在「章节正文写作」上：(1) 导读入口页（mitt 脉络图空壳、pinia 导读缺失），(2) 引擎层的「静默退化」隐患（writer.md 未注入、manifest 吞诊断）。章节正文本身已可作范本——**不需要大改内容，需要改的是产生内容的引擎，让「好」从靠运气变成可复现。**

| atlas | 综合分 | 目录(A) | 正文(B) | 阻断性内容问题 |
|---|---|---|---|---|
| router | 9.1 | 近范本 | 近范本 | 无 |
| yt-dlp | 9.0 | 高质量 | 高质量 | 无 |
| mitt | 8.5 | 高质量 | 高质量 | 无（导读脉络图空壳，非正文） |
| pinia | 8.5 | 高质量 | 高质量 | 无（导读缺失=旧代码生成，重跑即恢复） |

---

## 1. 章节目录层面（A1–A6）：扎实

| 维度 | 结论 | 证据 |
|---|---|---|
| A1 自底向上 DAG | ✅ 强保障 | 四个 atlas 的 `dependsOn` 全部指向更底层章、零逆向依赖；三重保障（`architect.md` 注入 + `critic-outline`①用 Kahn 复算交叉校验 + `stage topo.ts` 复算注入 topoOrder） |
| A2 概念原子 | ✅ | 每章聚焦一个可教原理，无按文件/目录拆章。如 router `history-abstraction` 把 common/html5/hash/memory 四文件收为一个「窄接口深模块」概念 |
| A3 由浅入深阅读序 | ⚠️ 基本好，2 处 minor 阶梯 | router ch11(router-link-active 运行期) → ch12(typed-routes 骤入条件类型分发/declare module)；yt-dlp `impersonation`(TLS 指纹伪装，第3) 早于中枢 `info-dict-contract`(第4) |
| A4 覆盖完整 | ✅ | 核心入口/模块均覆盖；yt-dlp scope out `update.py`/`compat`/`dependencies` 外围是合理取舍 |
| A5 无杂物箱/类型导读章 | ✅ | `critic-outline`④⑤ 闸门有效；无「其它/杂项/工具集」兜底章，`types.ts` 被折进使用它的章而非独立成章 |
| A6 summary 点原理+权衡 | ✅（mitt 第9章 1 处陈旧措辞需改） | 普遍「核心思想是 X，换取 Y，代价 Z」结构 |

### A3 的处理建议（经对抗验证修正，勿过度反应）

对抗验证明确判「给 critic-outline 加难度台阶闸门」= **partial（不推荐）**：① 方案 A「summary 必答唯一新概念」会误伤复合机制章（条件类型+模块增强+三态本就是一体的）；② 方案 B「dependsOn 不含紧邻前章即告警」会让 router 四个合法 system 章全部误报、制造告警疲劳；③ 方案 C「prologue 标跳轨点」其实已被现有 Synthesizer 自发做到（router 线性路线第12项已写「跳到编译期」）。

**推荐做法**：阅读曲线本质是全书层问题，应由 Synthesizer 处理而非 Critic。在 `synthesizer.md` 线性路线加一条软要求——「相邻章发生主题轴切换（运行期↔编译期、核心↔边缘）时，一句话标注跳轨点并指向可绕行的主题路线入口」。若想在 outline 层留痕，给章 schema 加一个**可选** `axis` 字段（`runtime`/`compile`/`type-system`），让 Synthesizer 据相邻章 axis 跳变自动检测，数据驱动而非主观扯皮。

---

## 2. 章节内容/写作风格层面（B1–B7）：高质量

手读 4 章 + 工作流精读约 15 章，**没有任何 blocker/major 落在章节正文写作上**。

| 维度 | 结论 | 备注 |
|---|---|---|
| B1 由浅入深结构 | ✅ 骨架完整 | 动机→核心思想→心智模型→权衡→演示→轨迹→小结。**但靠模型自觉**：`writer.ts` user prompt 无骨架锚点 |
| B2 通俗易读 | ✅（pinia 1 处禁用词「数据载体」） | 开场用具体痛点，类比密集贴切 |
| B3 讲清原理 | ✅ 权衡 3-4 条、点透本质矛盾 | **但「本质矛盾」靠模型自觉**：`writer.ts` 只要求三段式，未要求点透对立需求 |
| B4 正文零源码对照 | ✅ 强保障 | `writer.ts` 内联 + `critic-chapter`⑤ 直接 reject 双保险 |
| B5 跨章衔接 | ⚠️ 章首承上数据链断 | `chapter-context.ts` 算了 `prevTitle`，但 `writer.ts:61-78 buildChapterContextBlock` 把它丢了，且 user prompt 无承上指令 |
| B6 演示载体与原创性 | ✅ 全部 TS/JS 从零实现 | 边界（>50% 量化线/命名教学化）模糊，但 `critic-chapter`③ 兜底 |
| B7 导读四块 | ⚠️ mitt 脉络图空壳 / pinia 缺失 | 见 §4 |

### 2.1 已经做得好、保持别动的（当前最强资产）

- **开场用具体痛点/bug，不定义式**：「幽灵导航」「忘了取消订阅炸了」「几十种格式只想说一句话」
- **类比贴切且服务原理**：公共留言板、超市货架理货员按从差到好摆货、租期盒子、在途令牌白板
- **权衡 3-4 条、选择→换来→代价、点透本质矛盾**：router「手动散布检查点换极薄兼容旧 API」、yt-dlp「选择器从不比较、全靠排序器先摆好货架」、pinia「订阅生命周期整个托付给 Vue 作用域」
- **演示从零、朴素、配对照实验**：pinia 场景 A/B/C（默认绑作用域 vs detached vs 幂等取消）、yt-dlp「换个站点只剩预合并文件」兜底演示
- **正文零源码对照**：源码行号只存在于 `research.md`，draft 全部洗净

### 2.2 真正值得改的写作点（5 条）

**① 章首承上的数据链是断的（唯一的「真问题」，修起来一行）**
`chapter-context.ts:78-84` 算出 `prevTitle`，但 `writer.ts:61-78 buildChapterContextBlock` 只输出 `position/nextTitle/depTitles`，把 `prevTitle` 丢弃了；user prompt 也没有「章首承接上一章」指令。现在 4 个 atlas 章首承接做得好，是模型从 research/outline 自己摸出来的——无数据支撑的运气。
**改法**：`buildChapterContextBlock` 补一行 `- 紧邻上一章：${ctx.prevTitle ?? '（首章，无前驱）'}`；user prompt 补「§1 开头用 1-2 句承接紧邻上一章(prevTitle)，首章说清全书为什么从这里开始」。配套，缺一不可。

**② 「讲透本质矛盾」执行不稳定（最值钱但最靠运气）**
这是写作质量里最值钱的一环。好章都点透了「哪两个对立需求在打架」，但这是 `writer.md` 的硬要求、`writer.ts` 没注入、`critic-chapter` 也不校验（`writer.md:350-354` 自检第 7-9 条自承「无对应 Critic 标准」）。弱模型/机制稀薄章会退化成罗列。
**改法**：把指令写进生效路径。**但对抗验证警告：「本质矛盾」太主观，绝对不要加进 critic 硬标准**（会推高 reject 率、甚至 writer-critic 死循环，违反 `critic-chapter.md:149`「只在违反 6 条硬标准时 reject」的节制原则）。加 writer 指令即可。

**③ 类比密度偶尔偏高**——每个抽象概念都配一个类比，读者记不住哪个对应哪个。可引导「一个核心概念用一个类比贯穿，不每节换新类比」。

**④ 小结有时重复权衡清单**而非收束到「一句话灵魂」——mitt 第1章小结很干脆（「这张表已经能跑了，但它凭什么能被公开成实例字段…是下一章要解开的扣」），可作范式。

**⑤ 结构高度同质化**——机制极简单的章允许更轻结构，避免模板疲劳。

---

## 3. 引擎层系统性问题（写作质量可持续性的根）

> 当前 4 个 atlas 写得好，**不是 prompt 设计得不够好**（prompt 本身设计极好），而是「强模型自觉 + research.md 钩子质量高」碰巧补上了 writer.ts 的缺口。要让「好」可复现而不靠运气，需修以下引擎问题。每条都经对抗验证核实。

### 3.1 [P0] `manifest.ts` applyStatus 吞掉非致命诊断（verdict: sound，确定要修）

`src/lib/manifest.ts` 的 `applyStatus`（306-336 行）：先按 opts 写入 `stderr`（319-321 行），随后在 `status==='running'` 分支**无条件 delete** `exitCode/stderr/error`（328-330 行）。delete 在赋值之后执行，调用方本次显式写入的非致命 stderr 被立即抹除。`06-assemble.ts:87-91` 正是用 running+stderr 记录 synthesizer 失败，故被静默吞。

**影响**：所有 synthesizer 及任何子步骤的非致命失败原因永不落盘、`atlas show` 查不到。这是「为什么 pinia 缺导读却查不到原因」的直接根因（之一）。

**改法**（`manifest.ts:325-330`）：
```ts
// 改前：无条件 delete
if (status === "running") {
  next.startedAt = now();
  delete next.exitCode; delete next.stderr; delete next.error;
}
// 改后：仅当本次 opts 未显式提供该字段时才清
if (status === "running") {
  next.startedAt = now();
  if (opts?.exitCode === undefined) delete next.exitCode;
  if (opts?.stderr === undefined) delete next.stderr;
  if (opts?.error === undefined) delete next.error;
}
```
保留「重跑清旧诊断」语义，不再误删本次显式写入的非致命 stderr。补单测：`setStageStatus(m,"x","running",{stderr:"..."})` 后 `manifest.stderr` 应等于传入值。对全仓 7 个 stage 的 running 调用点（均不传诊断字段）行为完全不变，仅修复 `06-assemble.ts:87/96`。

### 3.2 [P1] `writer.md` 未注入 → writer.ts 缺 3 项关键写作指令（verdict: partial，治本方案已修正）

事实与根因全部属实：`writer.md` 是写作权威文档但实测未注入 Writer（`writer.ts:11-14` 注释明示是刻意决策——因 writer.md 的 §2/§4.2 历史 Write/replica 落盘指令会让 claude 顽固尝试 Write）。生效的 `writer.ts` user prompt 缺：
- **8 节结构骨架**（`writer.md` §4.1）→ B1 由浅入深无节序锚点
- **章首承上**（§4.1 §1）+ prevTitle 被丢弃（见 §2.2①）→ B5 章首衔接断链
- **讲透本质矛盾**（§4.1 §4）→ B3 触类旁通支点失效

**对抗验证修正**：synth 推荐的「路线 A（把 3 项同步进 user prompt）」治标不治本——根因是「writer.md 与 writer.ts 双 source of truth 靠人自觉同步」，`writer.md:12-14` 的维护约定早已存在却仍漂移（本次缺口即证据），靠人不可靠。且把 8 节骨架+正负样例全塞进 user prompt 会使其接近翻倍，稀释最关键的「fence 输出方式」指令权重，加剧 fence 解析失败。

**治本方案（路线 B + 兜底）**：
1. **立即小修**：`buildChapterContextBlock` 输出 prevTitle（一行）+ user prompt 补「章首承上」与「本质矛盾」两句影响行为的硬指令。这是独立低风险修复。
2. **治本**：物理隔离/删除 `writer.md` §2/§4.2 的 Write/replica 指令（移文末「历史/废弃」附录或删），保留 §0 覆盖块，**恢复 system prompt 注入**，并删 `writer.ts` user prompt 中与 writer.md 重复的文风/结构部分（只保留调用相关：fence 示例、章节上下文块、feedback 拼接）。让 writer.md 重回单一 source of truth。**前提**：先做一次对照实测——§0 覆盖块存在下注入清理后的 writer.md，观察 claude 是否仍顽固尝试 Write；若仍顽固则退回路线 A 并接受双 prompt。
3. **根因兜底（必做）**：加 CI lint 漂移检测——校验注入路径包含 writer.md 关键标记串（章首承上/本质矛盾/教学简化/8 节等锚点），任一缺失即 CI 失败。
4. **critic 分层**：「章首承上」客观可判，可加为第 7 条硬标准；「本质矛盾」主观，不加硬标准，改为 critic approve 时的软提示。

### 3.3 [P1] synthesizer validate 只查 fence、不查四块（verdict: partial，最优解=脉络图程序化生成）

`synthesizer.ts:90` validate 仅 `(stdout) => extractFence(stdout,'markdown') !== null`。mitt 脉络图空壳（前三块优秀、第四块只有标题+引言、图从未生成）照样过闸上线。

**对抗验证修正**：synth 建议「validate 校验四块 H2 齐全 + 脉络图后 ≥3 行」有四缺陷：① 精确标题匹配会误杀 mitt 自身（mitt 标题带冒号后缀 `## 这本书在讲什么：一句话主线`，须用 startsWith/正则容错）；② retry 对「末尾截断」无效（run-claude 原样重跑、不反馈缺陷，LLM 极可能再次截断同一处，3×25min 预算白白消耗）；③ ≥3 行阈值可被 3 行占位文字绕过、又可能误杀简练的 2-3 行图；④ 单点采样（仅 mitt）不足以证明系统性。

**最优解（治本，零 LLM 成本）**：脉络图本就是 `outline.dependsOn + topoOrder` 的**确定性结构化投影**，不需要 LLM 推理。把第四块从 synthesizer 产物中剥离，改由 `06-assemble.ts` 读 outline.json 后**程序化生成 mermaid**（或复用 router 已验证的 ASCII 风格）。synthesizer 只负责前三块文字，永无末块截断可能。
**次优**：增设 `critic-prologue`（与 critic-outline/chapter 同构），审查后给具体 fixes 让 synthesizer 修订（比盲重试有效，因反馈了具体缺陷）。
**折中（若只改 validate）**：标题用 startsWith 容错冒号；validate 只校验前三块 H2 存在、脉络图不强制（可程序化补出）；脉络图缺失时由 assemble 程序化补 mermaid 占位，而非整体跳过导读。

### 3.4 [P1] 导读无独立重跑路径 + pinia 导读缺失的真实根因（verdict: partial，重要修正）

**重要修正**：pinia 缺导读**不是「synthesizer 失败被静默吞掉」**，而是 pinia 的 assemble 完成于 `05:38Z`，**而 Synthesizer 功能 2 小时后（commit `d2591ca`, `07:35Z`）才上线**。功能上线后的 5 个 run（mitt/router/yt-dlp/vue-macros/zhihu）全部成功产出导读。pinia 只是用了旧代码。

**零代码解法（针对 pinia）**：`atlas resume pinia --only assemble --force` 即可用新代码（已含 synthesizer）重生 assemble。assembler 重跑幂等（从既有 draft 重建 site）。

**引擎层可选改进**（针对未来 synthesizer 真失败）：(1) synthesizer 失败时高可见落盘——在 `stages.assemble` 下增设 `prologue:{ok,reason?,cmd?}` 子字段（但须同步改 `atlas show` 渲染，加字段本身不会自动显示）；(2) 提供 `atlas regen-prologue <key>` 轻量子命令直接调 synthesizer，绕过 done 状态机，而非把 prologue 提进 STAGE_ORDER（拓扑上它依赖全部章节、不是与 acquire/survey 同级的对等体，提进 STAGE_ORDER 会污染续跑状态机）。**注意**：诊断写到「最终 done 迁移」而非经 running 中转，或直接修 §3.1 的 applyStatus，比新增子字段更小。

---

## 4. 优先级路线图

| 优先级 | 动作 | 文件 | 收益 |
|---|---|---|---|
| **P0** | 修 applyStatus stderr/error masking（§3.1） | `src/lib/manifest.ts:325-330` + 单测 | 解除所有 atlas 失败诊断静默吞没，是查清一切问题的前提 |
| **P1** | `buildChapterContextBlock` 输出 prevTitle + user prompt 补「章首承上」「本质矛盾」指令（§2.2①② / §3.2 步骤1） | `src/agents/writer.ts:61-78,120-193` | B5 章首衔接从「靠模型自摸」升为「有数据+指令保障」。成本最低、收益最直接 |
| **P1** | writer.md 恢复注入（清理 §2/§4.2）+ CI lint 漂移检测（§3.2 步骤2-3） | `src/prompts/writer.md`、`src/agents/writer.ts`、CI | 治本「双 source of truth 靠人同步」根因，防复发 |
| **P1** | 脉络图程序化生成（§3.3 最优解） | `src/stages/06-assemble.ts`、可选新增 `critic-prologue` | 彻底杜绝 mitt 空壳类问题，零 LLM 成本 |
| **P2** | 重跑 pinia assemble 补导读（§3.4） | `atlas/pinia`（`resume --only assemble --force`） | pinia 导读四块补齐，适合度推到 9+ |
| **P2** | 重跑/手补 mitt 脉络图（P1 程序化落地后自愈） | `atlas/mitt/work/prologue/draft.md` | mitt 导读达标 |
| **P2** | 3 处 minor 内容修正 | mitt outline 第9章 summary；pinia `define-store-hook/draft.md:37` 禁用词；router `path-pattern-ranking` 章末预告措辞 | 消除读者困惑 |
| **P2** | A3 跳轨标注（§1，可选） | `src/prompts/synthesizer.md` 线性路线 + 可选章 `axis` 字段 | 缓解 router/yt-dlp 阅读曲线台阶，给零基础读者绕行提示 |

---

## 5. 各 atlas 具体修法

### router（9.1，近范本，几乎不用动）
- 唯一 minor：`path-pattern-ranking` 章末小结「紧接着的匹配表那一章」措辞误导（topoOrder 里紧邻下一章其实是 `navigation-failure-types`，匹配表是第6章隔3章）——改措辞或删该句。
- 可选：A3 的 ch11→12 运行期→编译期跳轨，在 prologue 线性路线标注。

### yt-dlp（9.0，高质量，不用动）
- 唯一 minor：A3 `impersonation` 排第3早于中枢 `info-dict-contract`——属可辩护的产品取舍，可选在 prologue 主题路线提示。
- A4 scope out `update.py`/`compat`/`dependencies` 是合理的。

### mitt（8.5）
- major：导读「全书脉络图」空壳（标题+引言俱在、图从未生成）。P1 程序化生成脉络图后重跑自愈，或手补 ASCII/mermaid 块。
- minor：outline 第9章 summary「一份需手工对齐的 index.d.ts」与该章 research/draft 已核实结论（构建自动生成、被 .gitignore 忽略）冲突——改 summary。

### pinia（8.5）
- **历史致命缺陷已彻底修复**：全 15 章 research.md 第1行标题全部匹配 slug，`nuxt-module` 正确精读 `packages/nuxt/src/*` 而非历史上的 `subscriptions.ts`。memory `pinia-atlas-research-misplaced` 已失效。
- major：导读四块缺失——`atlas resume pinia --only assemble --force` 重跑即恢复（根因是旧代码，非内容问题）。
- minor：`define-store-hook/draft.md:37` 代码注释用了禁用词「数据载体」——换日常说法。

---

## 6. 附：提示词本身评价

7 个角色 prompt 设计质量极高，围绕「学原理而非读源码」做了严密设计（自底向上 DAG、关键权衡硬要求、文体宪法、正文零源码对照、跨章去重、对抗评审）。**提示词不需要重写，问题不在「说得不够好」，而在「writer.md 说得对但没注入生效」**——这是本审查最核心的发现。

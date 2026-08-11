# VitePress 产出内容审查 · 章节目录与教学质量

> 审查日期：2026-08-11。审查范围：9 个 Run（mitt / node-modules-inspector / pinia / pinia_backup / router / vue-macro-vscode-10 / vue-macros / yt-dlp / zhihu-fisher-vscode）的全部 outline + 抽样章节正文 + 导读，以及产出它们的引擎源码提示词。
>
> 本文档是审查结论 + 改进方案，**不自动实施**——改 prompt 影响所有未来 Run，需用户确认后逐条落地。

---

## 0. 总体结论

**教学质量：8.5/10（优秀）。** 抽样的章节（pinia 01/00、mitt 02/00、vue-macro-vscode-10 14、node-modules-inspector 12、yt-dlp 05、zhihu-fisher 10）都达到了「原理教学」的高标准：

- 统一的「痛点 → 核心思想 → 心智模型 → 关键权衡 → 最小演示 → 执行轨迹 → 小结」骨架
- 关键权衡是真「选择 X → 换来 Y → 代价 Z」+ 点透本质矛盾，不是空话
- 演示小而聚焦，不抄源码，每行对应一个原理点
- 文风人话、类比克制、破折号节制、收尾朴素——§5.7/§5.8 的反 AI 腔规则确实生效了
- 跨章承接（章首承上、章末预告紧邻下一章）和导读的「跳轨点」提示都到位

**目录结构：7.5/10（合理但有系统性瑕疵）。** 自底向上分层（primitive→composite→system）、DAG 依赖、章数 8-20 都合规，summary 普遍是原理驱动的。但有一个**系统性、可机器检出**的瑕疵：**章节标题（读者在侧边栏直接看到的）大量包含违禁抽象词和裸源码符号**。

**根因：Architect 提示词缺一道「标题质量闸门」。** `writer.md` 有详细的禁用词表（§5.7.2），但那是管正文的；标题是 Architect 产出的，`architect.md` 对标题质量只有「聚焦一个可教学的机制」这一句软约束，没有禁用词表、没有「标题不得含裸源码符号」的硬规则。于是违禁词/符号名在 outline 层就漏进来了，Critic·Outline 的 5 条标准里也没有标题质量检查。

---

## 1. 系统性问题 ①：章节标题含违禁词 / 裸源码符号（最高优先级）

### 1.1 数据

对 9 个 Run 共 128 个章节标题做机器扫描（禁用词 = writer.md §5.7.2 那张表；裸符号 = camelCase 链 / `a/b/c` 列表 / `→` 箭头 / 路径段）：**33/128（26%）标题被标记**。

**真问题（标题把内部实现细节当成了概念名，读者在侧边栏根本看不懂）：**
```
node-modules-inspector:
  依赖图物化：flatDeps/dependents/depth 一次算清        ← 三个内部字段名
  package.json 字段规范化（author/repo/license/funding）  ← 四个字段名
  响应式 payload 级联：main→excluded→available→filtered   ← 四态内部名 + 箭头
  CLI 多形态：dev/build/check/report/mcp                  ← 五个命令名
  可视化层：treemap/sunburst/flamegraph/graph/grid         ← 五种图表名
  Backend 抽象：dev/static/webcontainer 三态前端           ← 三态内部名
  静态推断模块类型 cjs/esm/dual/faux/dts                   ← 五种类型缩写连写
pinia:
  订阅系统：$onAction 的动作包裹与 $subscribe 的监听协调    ← 两个 API + 美元符
pinia_backup:
  Setup Store 构建器：分类 setup 返回值为 state/getter/action  ← 三个分类名
  @pinia/nuxt：SSR payload 状态运输与自动导入              ← 带作用域的包名
```

**边界情况（可保留，因为这些是读者可能已经知道或会去搜的公开 API/概念名）：**
```
pinia: defineStore：惰性 useStore 闭包与注册表缓存     ← defineStore 是公开 API
pinia: storeToRefs：从 reactive store 定向提取 ref    ← storeToRefs 是公开 API
router: RouterView 嵌套渲染 / RouterLink 与激活态判定  ← 公开组件名
```

**违禁抽象词（writer.md 正文禁止，标题却漏进来了）：**
```
mitt:        条件类型区分可选载荷事件          ← 载荷（应换"参数"/"数据"）
node-modules-inspector: 包管理器策略：...三态归一  ← 归一（应换"统一到"）
pinia:       订阅原语：回调集合与作用域自动清理    ← 原语（应换"最底层零件"）
pinia_backup: 订阅原语：Set + onScopeDispose...   ← 原语
```

### 1.2 为什么这是真问题

标题是**侧边栏唯一可见的信息**。读者扫一眼侧边栏，看到的应该是「这章讲什么概念」，而不是「这章翻哪个文件的哪些符号」。`main→excluded→available→filtered` 这种标题等于把源码内部状态机的字段名直接糊到目录上——它违背了整本书「学原理不读源码」的宪法，而且发生在最不该发生的地方（目录）。

正文已经被 §5.2/§5.7 卡得很干净（抽样的章节正文零源码符号），但**标题这层完全没人管**。

### 1.3 根因定位

| 环节 | 现状 | 缺口 |
|------|------|------|
| `architect.md` §5.1 | 「每章聚焦一个可教学的机制」 | **没有标题质量规则**：没禁用词表、没「标题不得含裸源码符号/内部字段名/箭头」的硬约束 |
| `critic-outline.md` §5 标准③④ | 准确性、粒度 | **没有标题可读性检查**：只查 title/summary 与源码职责吻合、查杂物箱章，不查标题是否「读者友好」 |
| `writer.md` §5.7.2 | 有禁用词表 | 只管正文；标题由 Architect 定，Writer 只照搬 |

### 1.4 修复方案（高 ROI，低风险）

**A. 在 `architect.md` §4（schema）和 §5.1（拆章原则）加标题质量硬约束**（建议加在 §4 的 title 字段约束表里，并在 §5.2 自检清单新增一条）：

```markdown
| `title` | 中文标题 | **面向读者的概念名，不是源码符号名**。
  硬约束：① 不得含 writer.md §5.7.2 的禁用抽象词（原语/载体/载荷/归一/收口/…）；
  ② 不得含裸源码符号——内部字段名、私有变量、`a/b/c` 列举式、`→` 箭头流转链、
  路径段（如 `flatDeps/dependents/depth`、`main→excluded→available→filtered`、
  `dev/build/check/report/mcp`）一律禁止；
  ③ 公开 API/组件名（如 `defineStore`、`RouterView`）可保留，因为它是读者已知或会去搜的概念锚点；
  ④ 标题要能独立讲清「这章讲什么概念」，读者扫侧边栏就该有概念预期 |
```

并在 §5.2 自检清单加第 6 条「标题可读性」（与 Critic·Outline 对应）。

**B. 在 `critic-outline.md` §5 标准③（准确性）后追加标题抽查**：

```markdown
- **标题可读性抽查**：打开 outline，扫一眼所有 title——若任何标题出现
  ① 禁用抽象词（原语/载体/载荷/归一/收口/…），
  ② 裸源码符号（内部字段名/私有变量/`a/b/c`列举/`→`箭头/路径段），
  → reject，要求 Architect 改写成面向读者的概念名（公开 API 名可保留）。
  判据：读者扫一眼侧边栏，应该知道「这章讲什么概念」，而不是「这章翻哪些符号」。
```

**为什么这是最高 ROI**：① 可机器检出的硬问题（26% 命中率）；② 改动量小（两个 prompt 各加一段）；③ 影响面是「目录第一印象」，读者最先看到的就是侧边栏；④ 与现有宪法（§5.7.2 禁用词、§5.2 正文零源码对照）完全一致，只是把闸门从正文层前移到大纲层。

---

## 2. 系统性问题 ②：章节 H1 / frontmatter 不一致（中优先级）

### 2.1 现象

不同 Run（甚至同一 Run）的章节文件头部格式不一致：

```
pinia/01:   # Pinia 实例：根状态、注册表与全局活跃上下文     （纯 H1，无 frontmatter）
nmi/01:     ---\ntitle: 流式 JSON 解析：...\n---\n# 流式 JSON 解析：...   （frontmatter + H1 重复）
vue-macros/01: ---\ntitle: "SFC 解析与增量 AST 编辑"\n---\n# 第一章 SFC 解析...  （frontmatter + "第一章"前缀 H1）
```

三种风格并存。`node-modules-inspector` 的 frontmatter title 与 H1 完全重复（冗余）；`vue-macros` 在 H1 加了「第 N 章」前缀（其他 Run 都没有）。

### 2.2 影响

- **VitePress 侧边栏与页面 H1 可能不一致**：VitePress 侧边栏用 config.ts 里的 `c.title`（来自 outline），页面标题用 H1。两者若不同（如 vue-macros 的 H1 多了「第一章」），侧边栏和正文标题就对不上。
- **frontmatter title 是 VitePress 的 `<title>` 和 SEO 来源**，缺它则用 H1。三种并存说明 Writer 没有统一规范。

### 2.3 根因

`writer.md` §4.1 的推荐结构里，第一章就是 `# {概念名}：一句话核心思想`——**只规定了 H1，没规定 frontmatter**。而 `assembler.md` §4.1 说「可在文件最顶部加 frontmatter」——「可」是软约束。于是 Writer 有时加有时不加，Assembler 有时补有时不补。

### 2.4 修复方案

**在 `writer.md` §4.1 明确 frontmatter 规范**（让 Writer 产出统一的文件头），并让 H1 与 outline title 保持一致：

```markdown
draft.md 的开头（H1 之前）固定写 VitePress frontmatter：

---
title: {与 outline 一致的中文标题，不含书名号}
---

# {同上标题}

> 本章属于 {layer} 层。前置：{dependsOn 的 titles}。
...

规则：
- frontmatter 的 title 与 H1 必须完全一致，且 = outline 里本章的 title。
- 不在 H1 加「第 N 章」「Chapter N」等前缀（章节编号由文件名 nn- 和侧边栏顺序体现）。
```

这样 Assembler「逐字搬运」即可，不必再「可加 frontmatter」。风险低、收益清晰（统一 9 个 Run 的格式）。

---

## 3. 系统性问题 ③：标题符号敏感度需校准（低优先级，配合 ①）

### 3.1 现象

问题 ① 的修复要让 Architect 避免裸符号标题，但要**校准「哪些符号该避免、哪些可保留」**，避免一刀切误伤：

- **该避免**：内部实现细节（`flatDeps/dependents/depth`、`main→excluded→available→filtered`）——读者不认识。
- **可保留**：公开 API（`defineStore`、`storeToRefs`、`RouterView`、`$patch`）——读者可能用过、可能去搜，是合法的概念锚点。
- **可保留**：广泛认知的缩写（`cjs/esm`、`SSR`、`HMR`、`AST`）——是领域通用词。

### 3.2 修复方案

在问题 ① 的 architect.md 标题硬约束里，**显式给出「可保留 vs 禁止」的判据**（见 1.4 的 ③④ 条），让 Critic·Outline 抽查时有清晰标准，不一刀切。

---

## 4. 非系统性观察（不强求改，供参考）

### 4.1 导读质量很高，但 pinia 导读比 mitt 导读更长更密

pinia 的 00-prologue 有 6 条「贯穿全书的核心原理」+ 两条阅读路线 + 跳轨点，密度极高（信息量大是好事，但初级读者可能觉得导语本身就有门槛）。mitt 的导读同样四块齐全，但更克制。这不是问题——是仓库复杂度差异的自然体现。Synthesizer 提示词已经说「若提炼不出单一主线就明示」，无需调整。

### 4.2 非 JS 仓库（yt-dlp/Python）的演示载体选择正确

yt-dlp 的 JS 解释器章用 TS 演示「JS 语义在宿主语言里的复刻」，符合 reader.md/writer.md「优先 TS/JS」原则，且 Critic·Chapter §5 ③已明确「不得因 TS/JS 演示非 JS 仓库而 reject」。这条管线是通的。

### 4.3 既有 prompt-optimization.md 已部分过时

`docs/tasks/prompt-optimization.md` 把「双轨 prompt 不同步」列为根因 #1——但 commit `2c865c9` 已消除双轨（writer.md 现在就是注入的系统提示）。该文档的「按概念分层处理比喻」洞察仍有价值，但根因表需更新。**不在本次范围**，仅记录。

---

## 5. 实施清单（按优先级）

| # | 改动 | 文件 | 优先级 | 风险 | 状态 |
|---|------|------|--------|------|------|
| 1 | 加标题质量硬约束（禁用词 + 禁裸符号 + 可保留判据） | `src/prompts/architect.md` §4 title 字段、§5.1 原则、§5.2 自检（5→6 条） | 高 | 低 | ✅ 已落地 |
| 2 | Critic·Outline 加标题可读性抽查 | `src/prompts/critic-outline.md` §1/§4/§5（五→六条）、新增标准⑥ | 高 | 低 | ✅ 已落地 |
| 3 | 章节文件头统一（frontmatter + H1 一致、不加「第 N 章」） | `src/prompts/writer.md` §0 示例、§4.1 文件头规范 | 中 | 低 | ✅ 已落地 |
| 4 | （可选）更新 prompt-optimization.md 根因表，剔除已解决的「双轨」项 | `docs/tasks/prompt-optimization.md` | 低 | 无 | 未做（文档维护，非阻断） |

**落地验证**：`bunx tsc --noEmit` 通过；`bun test test/agents.test.ts test/stages.test.ts test/orchestrator.test.ts test/cli.test.ts` 121 pass / 0 fail。改的是 prompt markdown，测试 mock 不读 prompt 内容，无回归。剩余 2 个 bun test 失败来自 `atlas/pinia/work/source/`（fetched 源码缺 `@nuxt/test-utils`），与本次改动无关。

---

## 6. 验证方法（改完 prompt 后，对新 Run 跑）

对一个**新的**仓库跑一次完整 Run（不要只 resume 旧的，旧 outline 已生成）。然后：

1. **机器扫标题**：对本审查 §1.1 的扫描脚本重跑，确认新 Run 的标题违禁词/裸符号命中率为 0（公开 API 名不计）。
2. **抽查章节文件头**：确认 frontmatter + H1 一致、无「第 N 章」前缀。
3. **`bun test` + `bunx tsc --noEmit`**：确认没碰断类型/测试。

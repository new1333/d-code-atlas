# 提示词迭代日志

> 目标：审视并持续优化 Code Atlas 的章节生成提示词，让产物「章节组织合理、每章通俗易懂」。
> 迭代载体：pinia 仓库的 `pinia-instance-active-context` 章（第一章，全书地基，最能体现组织与通俗化）。
> 每轮：用当前提示词重生成该章 → 审视产出 → 发现问题 → 改提示词 → 下一轮。≥10 轮或已收敛。

## 迭代脚本

`scripts/iter-chapter.ts` —— 直接调 `writer`(+`critic`) agent，单章重生成，产物写到 `scripts/iter-out/<key>-<slug>-<ts>/`，不污染原 Run。

```bash
bun run scripts/iter-chapter.ts pinia pinia-instance-active-context --out scripts/iter-out/rN [--rounds 2]
```

---

## Round 0（基线，当前提示词）

- 提示词：`docs/prompt-iteration/baseline/` 快照（= 当前 `src/prompts/`）
- 产物：`atlas/pinia/site/guide/01-pinia-instance-active-context.md`（既有）

### 审视结论（基线已经相当好）

**优点**：
- 章节组织：6 块自底向上（根状态盒 → 注册表 → 挂载 → 解析 → 互引 → 销毁）+ 完整轨迹 + 最小演示 + 3 条权衡 + 收束。结构清晰、叙事连贯。
- 通俗化：开场用"想象你在写 Vue 应用"具体场景；"公共留言板"类比点透全局指针；"说人话就是"过渡句拉回地面；权衡后用"说白了"收束。

**问题（待优化方向）**：
1. **"一句话点透"过早出现且偏抽象**：第 13 行"状态库不靠参数传来传去，而是靠一根全局指针隐式'被找到'…"——这是定义式句子，紧跟在场景开场后，节奏上像"先给结论再讲"。虽然开场是场景，但场景一结束就立刻塞"一句话点透"，读起来像摘要。
2. **"第一块/第二块…"编号小节偏机械**：六个"第 N 块"小标题整齐到刻意（§5.8 反对机械排比），且"块"这个量词偏生硬。
3. **权衡③代价偏弱**：markRaw 的权衡，"代价几乎无实质损失"——critic §5.8 第 5 条要求代价真实，这条权衡更像"只讲选择换来"，硬凑了一个无损失的代价。机制稀薄权衡本可只讲选择→换来。
4. **破折号偏多**：多处"——"插入解释（§5.8 第 1 条节制）。例："一个 Vue `ref({})`，里面按 store 名字分格子"OK，但"一个特殊的 Symbol 键下"这类无破折号；而"一块谁都能看到的公共留言板——不管你在哪"用了破折号连接。
5. **演示代码注释里仍带"权衡①/权衡②"标签**：注释 `// ---- 第一块：detached 作用域托管根状态（兑现权衡①的销毁面）----` 把原理演示和权衡章节用编号硬绑，读者读到演示时还不知道"权衡①"指什么（演示出现在权衡节之前）。
6. **"一句话：喊一声停，全部清掉"** 用了固定收束句式（§5.8 第 6 条禁止全章 >1 次，这里和后面"说白了"合计可能超）。

### 决策：进入 Round 1，针对上述 6 点改提示词。

---

## Round 1

### 提示词改动（writer.md + topic-writer.md 同步）
1. **§5.4 后新增「演示代码注释禁用权衡编号」硬要求**：演示出现在权衡节之后，注释里写「// 权衡①」让读者对不上表；要求用语义化措辞（「脱离作用域托管的根状态」）。
2. **§5.8 #5 代价真实性加强**：明确禁止「几乎无损失/代价可以忽略/实质上不损失」把代价消解掉；允许「老实只讲选择→换来」并注明代价薄。
3. **§5.8 #4 类比预算加强**：禁止同一段叠多个比喻（如「档案柜…抽屉…小黑板…大托盘」四连）。
4. **§4 关键权衡小标题加硬要求**：用语义化短语，禁止「权衡①②③」纯编号。

### 产物：`scripts/iter-out/r1/draft.md`
### 改进（对比 r0）
- ✅ 权衡小标题变语义化（「把根状态住进脱离组件树的作用域」「引入一根全局可变的「当前活跃」指针」），不再 ①②③。
- ✅ markRaw 那条权衡正确退化成「只讲换来 + 注明代价薄不展开」（见 r1 第 81 行那段灰色提示），消解了 r0 的假代价。
- ✅ 演示代码注释全部语义化（「根状态盒子，归属本作用域」「这根单例指针就是 SSR 串态的根」），无前向编号。
- ✅ 心智模型从「档案柜+小黑板+大托盘」四比喻收成「工具箱六个格子」一个比喻。

### 残留问题（待 Round 2）
1. **开场两节重复核心思想**：§2「为什么需要它」末句「调用处零参数、组件外也能拿到、响应式资源能被一键收回」与 §3「核心思想」开头「状态库不靠参数传递…一根全局活跃指针…脱离组件树的作用域」几乎是同一论点的两次陈述。虽然 §3 是规范要求的「核心思想」小节，但读起来仍有「同一句话念两遍」感（§5.7.5）。
2. **执行轨迹（§7）与心智模型六步生命周期（§4）部分重叠**：两者都讲 install 做四件事、useStore 解析注入优先。可让执行轨迹更聚焦「单次输入走读」而非复述机制全貌。
3. **§9 小结仍是「读完这一章你应该能用一句话讲清楚…」句式**（§5.8 #6 禁固定收束句式），且整句偏长。

### 决策：进入 Round 2，治「核心思想被念两遍」「执行轨迹与心智模型重叠」「小结固定句式」。

---

## Round 2

### 提示词改动（writer.md + topic-writer.md 同步）
1. **§2 核心思想加硬要求**：禁复述 §1「为什么需要它」结论，必须换角度上升一层。给了一句话判据：§2 删掉 §1 自洽、§1 删掉 §2 仍点透。
2. **§6 执行轨迹加硬要求**：≠ 心智模型复述；必须是「输入 X → 状态变 Y → 输出 Z」时序走读，带具体值。
3. **§8 小结加硬要求**：2～4 句；禁「读完这一章你应该能…」「一句话总结：…」固定句式；收束句必须换角度（抽到「这套设计在全书/同类问题里的位置」）。

### 产物：`scripts/iter-out/r2/draft.md`
### 改进（对比 r1）
- ✅ §1（四痛点 + 核心矛盾「零参数人体工学 vs 单一可序列化状态源 + 可控生命周期」）与 §2（「把『找谁要状态库』从显式参数变成隐式上下文」）角度不同、不互相复述。
- ✅ 执行轨迹（§6）变成带具体输入、具体状态值（`pinia.state.value` 长成 `{user, cart}`）、具体跨 store 场景的时序走读，不复述心智模型六步。
- ✅ 小结（§8）「这一章只造了容器本身…后面所有花活都是往这个容器里装东西」——换角度、2 句、无固定句式。

### 残留问题（待 Round 3）
1. **markRaw 那条权衡的代价措辞回退**：r2 第 83 行写「这是个很薄的代价面，甚至可以认为是『假代价』」——虽然诚实标注了代价薄，但用「假代价」一词、且仍写了一整段代价。r1 那条用 blockquote 一句话「主要是换来面，代价薄到不展开」更干净。提示词要让 writer 在「代价薄」时倾向「一句话带过、不写一整段」，而非硬写一段再自我否定。
2. **演示代码有 `// === 演示一/二/三 ===` 分隔注释**——略冗余，但可接受，非问题。
3. **整章已相当成熟**——开始进入「小修小补」区，需引入新视角（多章对比、topic 模式）验证普适性，避免过拟合到 pinia 第一章。

### 决策：进入 Round 3，加一条「代价薄时如何处理」的细则；并额外抽检一个中间章（state-patch-model）看普适性。

---

## Round 3

### 提示词改动
- **§5.8 #5 代价薄处理细化**：禁止「先写一整段代价再自我否定（假代价）」；要求代价薄时用**一句话**点明「主要是换来，代价薄到不展开」。

### 产物
- `scripts/iter-out/r3/draft.md`（pinia ch.1）
- `scripts/iter-out/r3-mid/draft.md`（pinia ch.5 state-patch-model，**普适性抽检**）

### 改进
- ✅ r3 ch.1 的 markRaw 权衡第 86 行：「`markRaw` 换来：实例被随处引用都不会触发响应式开销。代价薄到不展开：实例自身字段变化不会有响应式，但它本来就不是数据源…」——一句话处理，无自我否定的整段。
- ✅ **普适性抽检通过**：中间章（state-patch-model）同样遵守新规则——
  - 语义化权衡标题（「改状态时主动关掉监听，换一批改动只产生一条订阅事件」「函数式与对象式两条入口…」）
  - 承上开场（「上一章把 store 装配出来了…本章接着那个口子讲」）
  - 跨章去重（「订阅原语那章已展开，本章当执行件用」）
  - 执行轨迹带具体状态值 + 8 步精确微任务走读
  - 演示注释语义化、无前向编号
  - 本质矛盾点透（「通知频度 vs 逻辑粒度」「外部批处理逻辑 vs 运行时调度器节拍」）

### 残留问题（待 Round 4）
1. **Critic 是否真的能拦住问题**：前几轮都用 `--no-critic`，单看 Writer 自检。应启用 Critic 看对抗评审能否 catch 残留问题（如演示代码 `// === 演示一/二/三 ===` 这类冗余分隔、或权衡标题仍偶有编号）。
2. **演示代码块里 `// === 演示一/二/三 ===`/`// ---- 第N块 ----` 这类装饰性分隔注释**偏冗余，不是大问题但影响简洁。

### 决策：进入 Round 4，启用 Critic（--rounds 2），检验对抗评审效能。

---

## Round 4

### 提示词 + 引擎改动
- **发现一个真正的一致性 bug**：r4（带 critic）的 draft H1 = 「Pinia 实例：状态库住在哪里，又怎么被找到」，但 outline title = 「Pinia 实例：根状态、注册表与全局活跃上下文」。Assembler 把 draft 原样搬进 site、侧边栏用 outline title——两者不一致会让目录与正文标题对不上。历史上 Writer 碰巧没改标题，但这是运气，不是约束。
- **修复（writer.md + topic-writer.md + 代码层）**：
  1. §3 输入加硬要求：「本章 title 是正文 H1 的唯一权威，逐字照抄，不得改写」。
  2. §4 推荐结构模板 `# {概念名}：一句话核心思想` → `# {outline 的 title，逐字照抄}`。
  3. §7 硬约束补一条：「draft 的 H1 = outline 的 title（逐字）」。
  4. **代码层（chapter-context.ts + writer.ts）**：`ChapterContext` 加 `thisTitle` 字段；`buildChapterContextBlock` 在 user prompt 里明示「本章正文 H1 必须逐字等于：{title}」。双层防御（system prompt + user prompt）。
  5. 同步更新 `test/chapter-context.test.ts`（严格结构校验）。

### Critic 验证
- r4 跑了 `--rounds 2`（Writer+Critic 对抗）：Writer 单轮产出，**Critic 第 1 轮就 approve**（verdict=approve, fixes=0）。
- 说明：Critic 只守 6 条硬标准（准确/衔接/演示/清晰/教学/原理），不校验 §5.7/§5.8 文风、也不校验 H1=title。文风与 H1 一致性靠 Writer-prompt 自律 + 现在的 user prompt 明示。这是设计使然（writer.md 注释里标了「Critic 不强校验」）。

### 产物
- `scripts/iter-out/r4/draft.md`（critic loop 测试，H1 偏离）
- `scripts/iter-out/r4b/draft.md`（H1 修复验证：H1 = outline title，逐字匹配 ✓）

### 残留 / 下一步
- H1 一致性已修复并验证。
- 演示代码里 `// === 演示一/二/三 ===`/`// ---- 第N块 ----` 装饰性分隔注释仍偶现，非问题但不优雅。
- 下一步：抽检 topic 模式（vue-macro-vscode-10 是 topic Run），验证 topic-writer 改动普适。

### 决策：进入 Round 5，抽检 topic 模式。

---

## Round 5

### 改动
- 扩展 `scripts/iter-chapter.ts` 支持 `--topic`（topic 模式无 source/、用 WebSearch 白名单）。
- 无新提示词改动——本轮验证 topic-writer.md 的既有改动（H1=title、语义标题、代价薄、演示无前向编号等）在 topic 模式普适。

### 产物：`scripts/iter-out/r5-topic/draft.md`（vue-macro-vscode-10 / compiler-macro-essence，topic 模式首章）
### 验证（topic 模式全部新规则生效）
- ✅ H1 逐字 = outline title「编译期宏的本质：运行时不存在的「变换提示」」。
- ✅ 三条权衡标题全部语义化（「伪装成函数换取语法自然，代价是失去函数语义」「编译期完全确定地擦除换来产物干净，代价是工具链全盲」「运行时彻底消失换零包体积，代价是可调试性受损」）。
- ✅ §1（使用者痛点「这些静态结构信息为何要推到运行时反复表达」）与 §2（「宏是写给编译器看的变换提示」）角度不同、不互相复述。
- ✅ 执行轨迹带具体 parse 结果（`Node[]` 实际值、产物文本「全文搜不到 defineConstant」）。
- ✅ 演示注释语义化、无权衡编号；本质矛盾点透三条。
- ✅ 小结换角度（「把宏从『函数』心智挪到『编译指令』心智」）。

### 结论
- prompt 改动在 repo + topic 两种模式、首章/中间章/topic 章 四种组合上都生效，普适性确认。
- 已进入收敛区：连续 3 轮（r3/r4b/r5）无重大问题，仅小修小补。

### 下一步（Round 6+）
- 收敛后，再针对性扫几类潜在风险：
  1. **演示代码块里的 `// === 演示一/二/三 ===` / `// ---- 第 N 块 ----` 装饰性分隔**——r1/r3 里出现过，虽非问题，但可加一条「演示注释只写语义、不写装饰分隔」的软规则让产物更干净。
  2. **mermaid 图准确性**——抽一个适合画图的章（如 SSR 水合、HMR）验证 mermaid 规则。
  3. **机制稀薄章**——抽一个机制稀薄的章（如 config-and-feature-flags）验证「1 条权衡讲透」规则。

### 决策：进入 Round 6，加「演示注释去装饰分隔」软规则 + 抽检一个机制稀薄章。

---

## Round 6

### 改动
- **演示注释去装饰分隔（软规则）**（writer.md + topic-writer.md）：禁 `// === 演示一/二/三 ===`、`// ---- 第 N 块 ----` 纯装饰横幅；要求语义化注释同时起分隔 + 解释作用。

### 产物（并行）
- `scripts/iter-out/r6/draft.md`（pinia ch.1）
- `scripts/iter-out/r6-thin/draft.md`（vue-macro-vscode-10 / config-and-feature-flags，**机制稀薄章抽检**）

### 验证
- ✅ r6 演示注释全部语义化（`// 制造一个状态库：脱离作用域托管的根状态 + store 注册表`、`// 串态演示：SSR 下两个请求共享同一根全局指针`），无 `// === 演示一 ===` 装饰横幅；H1 = outline title。
- ✅ 「机制稀薄章」抽检（config-and-feature-flags）：实际并不稀薄——配置章压着 4 条真实架构权衡（一份 schema 两个物理副本 / 一个开关门控两侧 / 默认 opt-out / 版本感知默认值），每条都点透本质矛盾。Writer 没有因「配置」二字就退化成配置清单导读，而是挖出设计取舍。这验证了「按原理拆、不按文件拆」的 prompt 约束生效。

### 结论
- 连续 4 轮（r3/r4b/r5/r6）无重大问题，提示词已高度收敛。
- 仍剩一个未验证维度：**mermaid 图准确性**（适合画时序/状态机的章）。

### 决策：进入 Round 7，抽检一个适合画图的章（HMR 或 SSR），验证 mermaid 规则 + 确认收敛。

---

## Round 7

### 产物：`scripts/iter-out/r7/draft.md`（pinia / ssr-hydration，system 层，适合画图的章）
### 验证
- ✅ Writer **选择不画 mermaid**——SSR 水合流程虽多步，但文字 + 表格 + 两条灌值路径讲得很透，符合「文字能讲透就别画图」判据。这是 prompt 克制规则生效的正面例证（不强行塞图）。
- ✅ 跨章去重到位：第 6 行「第 5 章讲过的那个深合并工具，本章也会原样再用一次，但不重讲它的批处理细节」——正确回指、不重演。
- ✅ 三条语义权衡（根对象当序列化契约 / 先清空默认值再灌入站值 / 标记 API 摘除非状态对象），每条点透本质矛盾（状态表达自由度 vs 序列化可预测性；默认值的归属；序列化边界）。
- ✅ 承上开场（「上一章把 DevTools 当作插件拆完了…本章回到核心内部，兑现第 4 章装配埋下的承诺」）。
- ✅ H1 = outline title。

### 结论
- **提示词已收敛**：连续 5 轮（r3→r7）跨 repo/topic、首/中/末/稀薄/系统层 五种章型，均无重大问题。
- 剩余几轮用来做「跨语言 repo 泛化」（yt-dlp 是 Python）+ 巩固，确保改动不偏向 Vue 生态。

### 决策：进入 Round 8，抽检 yt-dlp（Python repo），验证非 JS/TS 仓库下演示载体、语言选择规则。

---

## Round 8

### 产物：`scripts/iter-out/r8-py/draft.md`（yt-dlp / networking-abstraction，**Python repo 跨语言抽检**）
### 验证
- ✅ **演示语言选了 TS/JS**（`js` fence），不是 Python——正确遵循「优先 TS/JS」规则。可插拔传输层是语言无关的设计模式，TS/JS 演得透。
- ✅ Writer 仍读 Python 源码（Request/RequestHandler/RequestDirector 类、能力清单、偏好求和、扩展槽），提取出**设计原理**而非 Python 语法细节。
- ✅ 四条语义权衡（能力清单 + 自检 / 偏好函数求和 / 扩展槽 / 拒绝原因聚合诊断），每条点透本质矛盾（引擎集开放 vs 调用方零感知；多方独立意志 vs 全局唯一排序；核心契约稳定 vs 能力集演进）。
- ✅ H1 = outline title；承上开场；心智模型带七步生命周期 + 不变量。

### 结论
- **跨语言泛化确认**：改动不偏向 Vue/JS 生态，Python repo 同样产出高质量原理章。演示载体规则（优先 TS/JS）在跨语言场景下被正确执行。
- 提示词在 repo×(首/中/末/稀薄/系统层)×topic×Python 共 7 种章节组合上全部收敛。

### 决策：进入 Round 9-10，做最后的「回归 + 收尾」——重跑 pinia ch.1 确认 r1-r8 累积改动后整体仍优（无回归），并审视是否有遗漏的小问题；然后冻结提示词、启动全量重跑。

---

## Round 9

### 产物（并行）
- `scripts/iter-out/r9/draft.md`（pinia ch.1，**回归 + Critic 对抗**，`--rounds 2`）
- `scripts/iter-out/r10/draft.md`（vue-macro topic / dual-track-compile-and-ide，system 层硬骨头）

### 回归验证
- r9：Writer 单轮产出 → **Critic 第 1 轮 approve**（fixes=0）。确认 r1-r8 累积改动后整体不回归、Critic 仍通过。
  - H1 = outline title；3 条语义权衡标题；演示注释无装饰横幅。
- r10（dual-track「双轨制」）：H1 = outline title；4 条语义权衡（分成两条独立管线 / 智能轨假装改写 / 共享底座只覆盖识别与定义 / 语义对齐当契约）；双轨用对比表讲透「构建轨 vs 智能轨」。

### 结论
- 累积改动无回归，所有规则协同生效。

---

## Round 10（Critic 加固 + 收尾）

### 改动
- **Critic 加固 H1 一致性硬门禁**（critic-chapter.md §⑤ + topic-critic-chapter.md §⑤）：把「正文 H1 ≠ outline 的 title → 直接 reject」加入 Critic 的 6 条标准之一。之前 H1 一致性只靠 Writer-prompt 自律；现在 Critic 也强制校验，形成双层防御。
- **验证**（`scripts/critic-h1-test.ts`）：故意把 r9 draft 的 H1 改成「# 故意改写的错误标题」，写进真实 chapter 路径，调 Critic。
  - 结果：**Critic 正确 reject**，fixes 给出精确诊断（「H1 是 X，outline title 是 Y，须逐字相等，包括全角冒号与空格」），并附「其余 5 条标准均通过，仅需修正 H1 即可 approve」。
  - 确认 Critic 能 catch H1 偏离。

### 收敛结论
- **10 轮迭代完成**，跨 7 种章节组合（pinia 首/中/末、topic 首/稀薄/系统、Python 跨语言）全部无重大问题。
- 提示词改动清单见下方「最终改动清单」。

---

## 最终改动清单（r1-r10 累积）

### writer.md
1. §3 输入 + §7 硬约束：**H1 = outline title（逐字）**（r4，一致性 bug 修复）。
2. §4 模板：`# {概念名}` → `# {outline 的 title，逐字照抄}`（r4）。
3. §4 关键权衡小标题：**语义化短语，禁「权衡①②③」纯编号**（r1）。
4. §5 演示注释：**禁用「权衡①」式前向编号**（r1）；**禁装饰性横幅分隔，用语义注释**（r6）。
5. §6 执行轨迹：**≠ 心智模型复述，必须是时序走读带具体值**（r2）。
6. §8 小结：**2～4 句，禁固定收束句式，换角度说法**（r2）。
7. §2 核心思想：**禁复述 §1 结论，必须换角度上升一层**（r2）。
8. §5.8 #4 类比预算：**禁同一段叠多个比喻**（r1）。
9. §5.8 #5 代价真实性：**禁「几乎无损失」消解代价；代价薄时一句话处理，不写整段再自我否定**（r1+r3）。

### topic-writer.md（与 writer.md 同步上述全部改动）

### critic-chapter.md + topic-critic-chapter.md
10. §⑤ 加硬门禁：**正文 H1 ≠ outline title → 直接 reject**（r10，双层防御）。

### 代码层
11. `chapter-context.ts`：`ChapterContext` 加 `thisTitle` 字段。
12. `writer.ts` `buildChapterContextBlock`：user prompt 明示「本章正文 H1 必须逐字等于 {title}」（与 system prompt 双层防御）。
13. `test/chapter-context.test.ts`：同步严格结构校验。

### 工具脚本
14. `scripts/iter-chapter.ts`：单章快速重生成（支持 `--topic`、`--rounds`、`--no-critic`）。
15. `scripts/critic-h1-test.ts`：验证 Critic 能 catch H1 偏离。

---

## 下一步

提示词已冻结。**全量重跑**：对所有既有 Run（mitt / node-modules-inspector / pinia / router / vue-macro-vscode-10 / vue-macros / yt-dlp / zhihu-fisher-vscode）用优化后的提示词重跑 write stage，用子代理并发。

---

## 全量重跑结果

### 重跑范围
- 8 个 Run：mitt(9) / node-modules-inspector(17) / pinia(15) / router(16) / vue-macro-vscode-10(14, topic) / vue-macros(16) / yt-dlp(13, Python) / zhihu-fisher-vscode(13)
- **总计 113 章**，全部用优化后的提示词重生成 + 重 assemble。

### 执行方式（子代理并发）
- `scripts/rerun-fast.ts`：直接调 writer agent（高并发 pool，默认 concurrency=8），扁平化所有 Run 的所有章节，全局并发。不走 atlas CLI/orchestrator，避免逐 stage 编排开销。1 个 Run 内的章节与多个 Run 之间都并发。
- `scripts/assemble-all.ts`：write 完成后，对每个 Run 跑 `atlas resume <key> --only assemble --force`，把新 draft 搬进 site/guide、重建 config/index。多 Run 之间并发（concurrency=2）。
- 1 章瞬态失败（zhihu-fisher-vscode/qr-login-flow：claude exitCode=0 但 validate 失败）单独重试成功。

### 最终验证（`scripts/verify-rerun.ts`，frontmatter-aware）
```
总章数: 113
H1 = outline title: 113 OK / 0 MISMATCH
「权衡①」式编号小标题: 0 (应为 0)
结果: PASS ✓
```

### 抽检（跨 repo 质量确认）
- yt-dlp（Python repo）networking-abstraction：权衡标题语义化（「能力自检换可插拔与优雅降级」「偏好函数求和换路由规则可独立叠加」…），演示用 TS/JS（跨语言正确遵循「优先 TS/JS」）。
- router path-pattern-ranking：权衡标题语义化（「用二维分数镜像 URL 层级,而不是压扁成一个数」「通配用负分,刻意抵消正则的加分」…）。
- vue-macro-vscode-10（topic）dual-track：权衡标题语义化（「两条独立管线,而非一段变换调两次」「智能轨假装改写」…）。

### 引擎/提示词改动文件清单
- `src/prompts/writer.md`、`src/prompts/topic-writer.md`（9 条文风/结构改动）
- `src/prompts/critic-chapter.md`、`src/prompts/topic-critic-chapter.md`（H1 硬门禁）
- `src/lib/chapter-context.ts`（ChapterContext 加 thisTitle）
- `src/agents/writer.ts`（user prompt 明示 H1=title）
- `test/chapter-context.test.ts`（同步结构校验）
- 新增脚本：`scripts/iter-chapter.ts`（单章迭代）、`scripts/rerun-fast.ts`（全量重跑）、`scripts/assemble-all.ts`（重 assemble）、`scripts/verify-rerun.ts`（验证）、`scripts/critic-h1-test.ts`（critic H1 验证）

**全量重跑完成，所有 113 章用优化后提示词重新生成并通过验证。**











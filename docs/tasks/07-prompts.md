# M07 · prompts

> 6 类角色 prompt 模板（系统级指令）。每个 Agent 调用时作为 system prompt 注入。
> 对应 design §2、§5（Agent 角色清单 + 各输出要点 + Critic 验收标准）、requirements FR-3。

## 依赖
- M00 project-scaffolding

## 子任务（每个文件 `src/prompts/{role}.md`）

- [ ] `surveyor.md` — Surveyor：只读；只如实记录结构不臆测；输出严格符合 `repo-map.json` schema（design §8.1、§5.1）。
- [ ] `architect.md` — Architect：只读；高屋建瓴拆 8~20 章；每章 `dependsOn` 必须是更底层章；DAG 无环；slug kebab-case 英文；`layer ∈ primitive|composite|system`（design §5.2）。
- [ ] `critic-outline.md` — Critic（Outline 模式）：只评审不生产；输出结构化 verdict（approve/reject + fixes）；按 design §5.3 四条验收标准：自底向上可验证 / 完整性 / 准确性 / 粒度。
- [ ] `critic-chapter.md` — Critic（Chapter 模式）：同上不生产；按 design §5.4 六条：准确 / 衔接 / 演示自洽 / 清晰 / 教学·非源码导读 / 原理·关键权衡；可读 `replica/` 判断结构合理性。
- [ ] `reader.md` — Reader：只读；精读指定 `sourceFiles[]`，摘关键调用链与要点，**标注源码位置**（`源码位置: path:line`）（design §8.3 章节产物）。
- [ ] `writer.md` — Writer：自底向上衔接 `dependsOn` 前文；内嵌最小原理演示（载体按仓库语言，"能跑"非硬要求）；与 `replica/` 一致（落盘非硬要求）（design §5、AC-5）。
- [ ] `assembler.md` — Assembler：可写 `site/`；**仅搬运与脚手架，不改章节内容**；侧边栏严格来自 outline（topo+layer），文件名 `{nn}-{slug}.md`（design §11、ADR-0006）。

## 每个 prompt 文件应包含
1. 角色 + 职责一句话。
2. 工具约束（只读 / 可写范围）。
3. 输入产物路径占位（运行时由 agent 拼到 user prompt）。
4. 输出产物路径与 schema。
5. 验收要点（Critic 类写明判定标准；Producer 类写明自检清单）。
6. 硬约束：JSON 产物必须是合法 JSON、不包 markdown fence（或约定 fence 以便解析）。

## Done 标准
- 7 个文件齐全（surveyor/architect/critic-outline/critic-chapter/reader/writer/assembler）。
- 每个文件可被 `runClaude({systemPromptPath})` 加载。
- Producer 与 Critic 的验收标准**成对、可对照**（design §5.3↔architect、§5.4↔writer）。

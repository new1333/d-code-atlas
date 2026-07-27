# 自底向上 = 依赖 DAG + 拓扑排序，可被 Critic 机械验证

"章节按自底向上、一步步理解完整原理"不靠 Architect 的感觉，而是靠结构：每章在 `outline.json` 里带 `dependsOn[]`（理解本章前必须先理解的其它章节 slug）。Architect 构建一张概念依赖图，最终章节顺序 = 对该图做拓扑排序；`level` 仅作侧边栏分组的辅助字段。Critic 在 Outline 阶段的硬性验收标准之一就是：依赖图无环、且每章的 `dependsOn` 闭包都排在它之前。代价是 Architect 的 prompt 更难，但"高屋建瓴地拆解"本就是它的职责；收益是"自底向上"从口号变成可机器验证的不变量，烂大纲过不了 Critic 这关。

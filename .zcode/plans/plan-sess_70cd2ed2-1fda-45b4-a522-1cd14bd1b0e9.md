将已审定的 Topic 模式实施计划输出为文档 `docs/tasks/13-topic-mode.md`，方便用户稍后自行执行。

计划内容就是我们在对话中确认的那份方案（零新 stage、零新流水线，复用 03→07，SourceKind 加 topic 变体，独立 prompt 文件，CLI 三分分流，WebSearch grounding）。我只是把它落盘成一个可执行的 markdown 文档，不做任何代码改动。

文档结构：
1. 目标 + 用户决策表
2. 设计核心（findNextPending 状态驱动洞察）
3. 6 层改动清单（类型常量 / prompt 文件 / agent 层 / stage 透传 / CLI 入口 / 测试），每层带文件:行号锚点
4. 不改动部分（明确边界）
5. 实施顺序
6. 风险与缓解
7. 验收标准

执行这个计划只需要一个 Write 操作（写一个新 markdown 文件），不碰任何源码。
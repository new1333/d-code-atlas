# 用 claude CLI 子进程执行 Agent

Orchestrator（Bun）以 headless 子进程方式调起 `claude -p` 来执行每一个 Agent，而不是用 Claude Agent SDK 在进程内 query。这样 Agent = 一次 `claude` 调用，直接复用 Claude Code 自带的文件工具、子 agent、权限与上下文管理，Orchestrator 只管文件、目录、流程顺序与 VitePress 脚手架，职责清晰、每一步可单独重跑、最贴合"用 claude code cli 的方式生成"的诉求。代价是与 CLI 的输入输出约定耦合、进程间靠文件传中间产物——但这恰好强化了"每步产物落盘"的纪律。

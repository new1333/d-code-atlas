# 每个 Stage 落盘 + manifest 状态机，使 Run 跨 session 可断点续跑

Orchestrator 不持有任何运行时状态：每个 Stage 是"读入产物文件 → 写出产物文件"的纯步骤，`work/manifest.json` 是各 Stage 状态（`done` / `failed` / `running` + 时间戳 + 实际执行的 claude 命令）的唯一真相源。续跑时只读 manifest，重跑所有非 `done` 的 Stage；用 `--from` / `--only` / `--force` 控制范围。代价是多维护一个 manifest，并要求每个 Stage 严格遵守"先完整写出产物、再翻状态为 done"。换回的是：中断 / 换 session / 换机器都能接着跑，且写到一半崩溃不会被误判为完成（manifest 只在产物完整落盘后才置 done）。

不用"纯文件存在判定"是因为它无法区分"写完了"和"写到一半崩了"，残缺产物会被错误跳过；而 manifest 状态机让"完成"成为一个显式、可信的信号。

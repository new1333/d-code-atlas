# mini-signal · Code Atlas 最小样本仓库

一个刻意保持极简的「响应式原语」演示仓库，用于 Code Atlas 的端到端冒烟（M12 / AC-1..AC-7）。

特点：
- 体积小（3~4 个源文件，< 100 行），claude 分析快、省 token。
- 概念分层清晰，适合验证「自底向上」拆章：signal（原语）→ effect（组合）→ computed（更高组合）→ app（系统）。
- 纯 TS，无外部依赖，`bun run` 即可跑。

## 文件

- `src/signal.ts`：`signal()` —— 最小响应式原子（get/set + 订阅者收集）。
- `src/effect.ts`：`effect()` —— 副作用包装，依赖自动追踪。
- `src/computed.ts`：`computed()` —— 派生信号（依赖 effect + signal）。
- `src/index.ts`：对外入口，导出上述 API + 一个 demo。
- `package.json`：`main: src/index.ts`，无依赖。

## 给 Architect 的提示

理想拆章（供对照）：
1. `signal`（primitive）：值的容器 + 依赖收集。
2. `effect`（composite）：把「读 signal」自动 track 进当前 effect，signal 变 → 重跑 effect。
3. `computed`（composite/system）：基于 effect 实现的派生值，带缓存。
4. `app`（system）：组合上述，对外 API + demo。

依赖 DAG：`effect` dependsOn `signal`；`computed` dependsOn `signal`+`effect`；`app` dependsOn 全部。

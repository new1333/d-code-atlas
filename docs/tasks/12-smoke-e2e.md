# M12 · smoke-e2e

> 端到端冒烟 + AC 自检。MVP 收尾。
> 对应 `docs/verification.md` AC-1..AC-7、requirements §7。

## 依赖
- M11 cli（全部上游模块完成）

## 子任务

- [ ] 准备最小样本：一个小型本地 ts/js 仓库（或一个公开小 repo，如 `vuejs/core` 子集 / 自造 demo），用于快速跑通。
- [ ] **AC-1（端到端·URL）**：`atlas run <url>` → `cd atlas/{repo}/site && bun install && bun run docs:build` 成功产出 `dist/index.html`。
- [ ] **AC-2（端到端·本地 + 只读）**：跑前后对源目录 `find | sort` 与 `git status` diff，期望无差异。
- [ ] **AC-3（续跑）**：Research 中途 Ctrl-C → `atlas resume <key>` → survey/outline 不重跑、从中断章节继续。
- [ ] **AC-4（自底向上）**：`bun test test/topo.test.ts` 绿；对生成的 outline 复算 topo 与 `outline.topoOrder` 一致；`site/guide/` 文件名编号 == topo 序号。
- [ ] **AC-5（复刻代码）**：每章 `draft.md` 含 ≥1 个 ts/js 代码块；`replica/` 有对应可运行文件（verification.md 脚本核验）。
- [ ] **AC-6（对抗评审）**：`atlas show` + 直接读 manifest，outline 与每章 write 都有 review trace（rounds/final/trace）。
- [ ] **AC-7（只读）**：核验 manifest 中所有分析类 agent 的 cmd 含 `--allowedTools Read,Glob,Grep`。
- [ ] 把 verification.md 的逐条脚本打包成 `scripts/selfcheck.sh`（或 `.ts`），输出 PASS/FAIL 汇总（design §16 末尾「全量一键自检」）。
- [ ] 记录已知降级 / 后续项（manifest accepted-with-warning 的章、build 警告等）到 `docs/known-issues.md`（可选）。

## Done 标准
- AC-1..AC-7 在样本仓库上**全部 PASS**。
- `selfcheck` 脚本可重复运行、输出清晰汇总。
- MVP 达到 requirements §6「MVP（本期）」范围。

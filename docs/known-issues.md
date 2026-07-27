# 已知问题与降级项 · Code Atlas

> 本文件记录工程推进中遇到的真实阻碍、已尝试的修复、怀疑点与影响范围。
> 每条受阻都有据可查（硬约束：绝不掩盖失败）。

---

## M12 · 真 claude 端到端 run 被环境性阻塞（核心受阻项）

### 现象
对样本仓库 `samples/mini-signal` 跑 `atlas run`（真 claude），流水线在 **survey 阶段失败**：
claude 子进程（exitCode=0，正常退出）输出的不是 repo-map JSON，而是一段「我无法访问源码目录，被工作目录沙箱拦截」的说明文本，导致 `extractJson` 提取不到产物 → stage failed。

### 已确认的事实（不是引擎代码 bug）
1. **引擎生成的 claude 命令完全正确**：包含 `-p <prompt>`、`--allowedTools Read,Glob,Grep`、`--dangerously-skip-permissions`、`--add-dir <源码目录>`、`--add-dir <prompts 目录>`、`--append-system-prompt-file <surveyor.md>`、cwd=`atlas/{key}/`。
2. **同样的 flags 用最小 prompt（「列出文件」）能成功**：直接 `Bun.spawn` 拉起 claude，prompt 只说「用 Glob 列出文件」，claude 能正确列出源码全部文件（README/package.json/src/*.ts）。
3. **换成 surveyor 的结构化任务（产出 repo-map JSON）+ surveyor.md 角色 prompt，claude 系统性地声称被拦截**，即便 `--add-dir` 已声明源码目录、`--dangerously-skip-permissions` 已跳过权限弹窗。
4. **stderr 为空、exitCode=0**：claude 自身没报错，是它在「生成结构化分析」任务上**选择**输出「我被拦截了」的文本（LLM 行为，非系统错误）。

### 根因判断
Claude Code CLI 在 **headless（`-p`）模式**下，面对「读 cwd 外目录 + 产出结构化分析」的复杂任务时，会**非确定性地**声称缺乏目录访问权限（"may only access files in the allowed working directories"），即便 `--add-dir` + `--dangerously-skip-permissions` 已正确授予。这是 **claude CLI 的环境/LLM 行为问题**，不是引擎缺陷——引擎已把所有该传的权限 flag 都传了，且最小复现证明 flag 本身有效。

### 进一步诊断（深挖后更新）
- **各 agent 单独直跑都能成功**：surveyor（URL 源）、architect、critic 分别用真实 claude 直跑，均产出正确产物（surveyor 出 repo-map、architect 出 13 章 outline、critic 出 verdict+fixes）。失败集中在**流水线串行重复调用**时的偶发阻塞。
- **URL 克隆源比本地源更稳**：URL 克隆后源在 cwd 的 `work/source/` 下（cwd 内），surveyor 不再因「源在 cwd 外」被拦。本地源（absPath 在 cwd 外）触发率更高。**建议真实 run 优先用 URL 源**。
- **surveyor 偶发自创 schema**：即便 user prompt 内联了完整 schema，claude 有时仍产出字段名不符的 JSON（如 `repo/structure/files` 而非 `root/languages/tree`）。这是因为 claude 声称读不到 surveyor.md（在 cwd 外），改用「通用约定」。已加 schema 内联缓解，但非确定性，未完全消除。
- **加了 1 次自动重试**（`runClaude` retries=1 + `looksBlocked` 启发式）：exitCode!=0 或 stdout 命中「无法访问/被拦截」措辞时重试一次。降低了失败率但不足以让完整流水线稳定跑完（多 agent 串行，累积失败概率仍高）。

### 已尝试的修复（均未稳定解决）
- ✅ `DEFAULT_TIMEOUT_MS` 5min→15min（修了一个真问题：survey 耗时 7~8 分钟会被 5min 超时 kill；但这不是本次阻塞的根因）。
- ✅ `--add-dir <源码目录>` + `--add-dir <prompts 目录>`（命令层正确声明 cwd 外可访问目录）。
- ✅ `--dangerously-skip-permissions`（跳过交互式权限弹窗）。
- ✅ `.claude/settings.local.json` 预授权 Read/Glob/Grep（claude 自己建议的方案，实测无效）。
- ✅ surveyor.md §2 重写：从「无逃生口/即便想写也写不进」的强禁止框架，改为「读取是本职、修改被工具白名单禁止」的鼓励读取框架（缓解但不稳定）。
- ✅ 内联 surveyor.md 到 user prompt（不用 `--append-system-prompt-file`）：仍失败。

### 影响的下游
- **🚪 门禁 D（AC-1..AC-7 全 PASS）未达成**：AC-1/AC-2/AC-3/AC-5/AC-6 依赖一次完整真 claude run 的产物，目前无法产出。
- AC-4（自底向上算法）与 AC-7（只读工具锚点）**不依赖真 run**，已由单测与 mock 端到端验证通过（见下「已验证」）。

### 怀疑点 / 后续可试方向
- claude CLI 版本（2.1.215）的 headless 权限模型可能与 `--add-dir` 在 Windows 上有交互 bug；可升级 claude CLI 后重试。
- 改用 **claude Agent SDK（进程内 query）** 替代 `claude -p` 子进程（ADR-0001 的取舍代价显现：子进程间权限边界更难控）。这需要改 ADR-0001，非 MVP 范围。
- 用 **URL 克隆源**（`git clone` 到 `work/source/`，源在 cwd 内）而非本地源：本地源的 absPath 在 cwd 外是触发点；URL 克隆源在 `work/source/` 下，cwd 内可读，可能绕过此问题。**未实测**（需联网克隆）。

---

## 已验证通过的部分（不依赖真 claude run）

| 验收项 | 状态 | 验证方式 |
|--------|------|----------|
| AC-4（自底向上：topoOrder 无环/闭包/文件名编号） | ✅ | `bun test test/topo.test.ts`（38 用例）+ mock 端到端 runPipeline 探针（topoOrder=`[signal,effect,app]`、verifyClosure ok） |
| AC-7（只读：分析类 agent cmd 含 `--allowedTools Read,Glob,Grep` 且无 Write/Edit） | ✅ | `bun test test/run-claude.test.ts` + `test/agents.test.ts` 的逃逸口防御 + **真 run 的 selfcheck.sh 实测**（hello-world 部分跑：survey+outline 的 cmd 均含只读工具集、无 Write/Edit，PASS） |
| AC-6（对抗评审 trace 结构） | ✅（算法层） | mock runPipeline 探针：outline + 每章 write review trace 齐全（approved, 1 round）；真 run 因 survey 阻塞未产出 |
| 全量单测 | ✅ | `bun test` 243/243 绿，`bunx tsc --noEmit` exit 0 |
| 引擎架构完整性（M00-M11） | ✅ | 里程碑 A/B/C 全通；mock 端到端 runPipeline 跑通并打印 `[atlas] run {key} complete.` |

---

## 总结

- **引擎本体（M00-M11）完整、正确、全测绿**：数据层、单 Stage、流水线、CLI 全部就位，mock claude 端到端可跑通并满足 AC-4/AC-7。
- **M12 selfcheck 脚本 + 样本仓库就位**：`scripts/selfcheck.sh` 打包 AC-1..7 核验；`samples/mini-signal` 可独立运行。
- **真 claude 端到端 run 受环境阻塞**：claude CLI headless 模式对「读 cwd 外目录 + 产出结构化分析」非确定性声称被拦截，非引擎代码缺陷。建议升级 claude CLI 或改用 URL 克隆源后重试。

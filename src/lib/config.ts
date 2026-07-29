// 全局配置常量：对应 design §14（配置项）。
// 这些常量是流水线默认行为的真相来源（并发度、评审轮数、章数上限、跳过目录、工具白名单）。
// flag 覆盖在 CLI（M11）与 Orchestrator（M10）层处理，这里只给默认值。
// 允许通过 ATLAS_CLAUDE_BIN 环境变量覆盖 claude 可执行路径，便于测试与冒烟（design §10）。

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

/** 逐章并发上限（design §14）。 */
export const DEFAULT_CONCURRENCY = 4;

/** 对抗评审轮数上限：Producer ⇄ Critic 循环最多跑这么多轮（ADR-0004）。 */
export const REVIEW_ROUNDS = 2;

/** 章节总数上限：超出则 Architect 必须合并，Critic 拦截（design §14、§15）。 */
export const MAX_CHAPTERS = 24;

/** Surveyor 扫描目录树时跳过的重型/生成物目录（design §14、§5.1）。 */
export const SKIP_HEAVY_DIRS = ["node_modules", ".git", "dist", "build"];

/** 只读角色（Surveyor/Architect/Critic/Reader）允许的工具白名单——无逃生口（ADR-0005、AC-7）。 */
export const READONLY_TOOLS = ["Read", "Glob", "Grep"];

/** 写入角色（Writer/Assembler）允许的工具白名单：在只读基础上加 Write/Edit（ADR-0005）。 */
export const WRITE_TOOLS = ["Read", "Glob", "Grep", "Write", "Edit"];

/**
 * 把 `claude`（npm 全局装的 shell 包装脚本）解析到真正的可执行文件路径。
 *
 * **核心问题（Windows 上的根因）**：`npm i -g @anthropic-ai/claude-code` 在 Windows 装出
 * 三个 wrapper——`claude`（`#!/bin/sh` POSIX 脚本，无扩展名）、`claude.cmd`、`claude.ps1`——
 * 它们都 `exec` 同一个真正的 PE 可执行文件 `node_modules/@anthropic-ai/claude-code/bin/claude.exe`。
 * `Bun.spawn` 在 Windows 直接走 CreateProcess（**不经 shell**），对无扩展名的 `#!/bin/sh`
 * 脚本无法执行 → 偶发启动失败（exitCode 126，spawn 抛 ENOENT/EINVAL）→ 流水线 5ms 瞬失败。
 *
 * **核心修复**：绕过所有 shell 包装脚本，直接 spawn 真正的 PE 可执行文件。这样跨启动路径
 * （Git Bash / 双击 / CI / 服务账户）行为完全一致，根除偶发启动失败。
 *
 * 解析优先级：
 *   1. `ATLAS_CLAUDE_BIN` 环境变量（用户显式指定绝对路径，最高优先级，原 design §10 语义保留）。
 *   2. PATH 里 `claude` 所在目录下的 `node_modules/@anthropic-ai/claude-code/bin/claude.exe`
 *      （npm 全局装的标准布局；通过 `claude` wrapper 反推）。
 *   3. `claude.cmd`（Windows 原生批处理，Bun.spawn 可直接跑；非 Windows 跳过）。
 *   4. 兜底 `"claude"`（依赖 spawn 自身解析；Linux/macOS 上 `claude` 通常是有执行位的真二进制或软链）。
 *
 * 该函数纯同步、幂等、无副作用（仅 fs.existsSync 探测）。模块加载时调一次缓存到 CLAUDE_BIN。
 */
export function resolveClaudeBin(): string {
  // 1) 显式环境变量最高优先级。
  const envBin = process.env.ATLAS_CLAUDE_BIN;
  if (envBin && envBin.trim() !== "") return envBin;

  // 2) PATH 里找 `claude`，若找到则反推同目录的 npm 全局 exe。
  const wrapperPath = lookupInPath("claude");
  if (wrapperPath) {
    const dir = dirname(wrapperPath);
    // npm 全局装的标准布局：wrapper 同目录 node_modules/@anthropic-ai/claude-code/bin/claude.exe
    const exe = join(dir, "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
    if (existsSync(exe)) return exe;
    // 同目录有 claude.exe（少数布局）也接受。
    const siblingExe = join(dir, "claude.exe");
    if (existsSync(siblingExe)) return siblingExe;
  }

  // 3) Windows 上回退到 claude.cmd（原生批处理，Bun.spawn 能直接跑）。
  if (process.platform === "win32") {
    const cmdPath = lookupInPath("claude.cmd");
    if (cmdPath) return cmdPath;
  }

  // 4) 兜底：交给 spawn 自身解析（Linux/macOS 上 `claude` 通常是真二进制/软链，可直接执行）。
  return "claude";
}

/**
 * 在 PATH 里查某个可执行文件名，返回首个存在的绝对路径；找不到返回 null。
 * 用 `node:child_process` 太重（且 spawn 本身就是我们要修的东西），这里手写 PATH 扫描：
 * 拆 PATH（平台分隔符），逐目录拼目标名，existsSync 命中即返回。
 * 仅用于 resolveClaudeBin 的启动期探测，不在热路径。
 */
function lookupInPath(name: string): string | null {
  const pathVar = process.env.PATH;
  if (!pathVar) return null;
  const sep = process.platform === "win32" ? ";" : ":";
  const dirs = pathVar.split(sep);
  for (const d of dirs) {
    if (!d) continue;
    const candidate = join(d, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * claude CLI 可执行路径（已解析到真正的可执行文件，见 resolveClaudeBin）。
 * 模块加载时解析一次并缓存；测试可通过 ATLAS_CLAUDE_BIN 注入假可执行文件。
 */
export const CLAUDE_BIN = resolveClaudeBin();

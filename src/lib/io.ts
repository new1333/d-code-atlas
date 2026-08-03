// lib/io.ts：路径约定 + JSON/文本读写 + 取源原语。
// 对应 design §3（在分层中作为最底层 IO 基元）、§4 Stage 1（Acquire）、
// §8（产物路径 schema）、§10 与 ADR-0005（取源策略 + 源只读）。
//
// 全部导出均为纯函数 / IO 原语。路径函数只拼字符串（不做 fs 操作），
// 返回**相对仓库根的 POSIX 风格**路径串；目录带尾斜杠，文件路径不带。
// 原子写纪律：写 `{path}.tmp` 再 rename，杜绝半写文件（design §9 CAS 式写入）。
// 零运行时依赖：仅用 bun/node 内置。

import { mkdir, rename, stat, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import type { PathLike } from "node:fs";

// ---------------------------------------------------------------------------
// 内部工具：POSIX 路径拼接
// ---------------------------------------------------------------------------

/**
 * 把多段路径拼成 POSIX 风格（一律用 `/`，Windows 上 bun/node 也认正斜杠）。
 * 空段会被忽略；不为结果做规约（如 `..` 折叠），仅做纯拼接 + 重复斜杠折叠。
 * 供本模块路径函数复用，也导出给其它模块统一使用。
 */
export function joinPath(...parts: string[]): string {
  const clean = parts.filter((p) => p !== "" && p !== undefined && p !== null);
  if (clean.length === 0) return "";
  return clean
    .join("/")
    .replace(/\/+/g, "/"); // 折叠重复斜杠（例如段之间已有尾/首斜杠）
}

// ---------------------------------------------------------------------------
// 路径约定（design §8、§12）
// ---------------------------------------------------------------------------
// 所有路径相对仓库根；目录带尾斜杠、文件路径不带斜杠。

/** Run 工作区根：`atlas/`。 */
export function atlasRoot(): string {
  return "atlas/";
}

/** 单个 Run 目录：`atlas/{key}/`。 */
export function runDir(key: string): string {
  return joinPath(atlasRoot(), `${key}/`);
}

/** Run 的 work 子目录：`atlas/{key}/work/`。 */
export function workDir(key: string): string {
  return joinPath(runDir(key), "work/");
}

/**
 * 克隆源目录：`atlas/{key}/work/source/`。
 * 仅 git clone 场景会创建该目录；本地源不复制（ADR-0005、见 resolveLocalSource）。
 */
export function sourceDir(key: string): string {
  return joinPath(workDir(key), "source/");
}

/** 站点输出目录：`atlas/{key}/site/`。 */
export function siteDir(key: string): string {
  return joinPath(runDir(key), "site/");
}

/** manifest 状态机文件：`atlas/{key}/manifest.json`。 */
export function manifestPath(key: string): string {
  return joinPath(runDir(key), "manifest.json");
}

/** 全部章节根目录：`atlas/{key}/work/chapters/`。 */
export function chaptersDir(key: string): string {
  return joinPath(workDir(key), "chapters/");
}

/** 单个章节目录：`atlas/{key}/work/chapters/{slug}/`。 */
export function chapterDir(key: string, slug: string): string {
  return joinPath(chaptersDir(key), `${slug}/`);
}

/** Surveyor 产物：`atlas/{key}/work/repo-map.json`。 */
export function repoMapPath(key: string): string {
  return joinPath(workDir(key), "repo-map.json");
}

/** Architect 产物：`atlas/{key}/work/outline.json`。 */
export function outlinePath(key: string): string {
  return joinPath(workDir(key), "outline.json");
}

/** Reader 产物：`atlas/{key}/work/chapters/{slug}/research.md`。 */
export function researchPath(key: string, slug: string): string {
  return joinPath(chapterDir(key, slug), "research.md");
}

/** Writer 产物：`atlas/{key}/work/chapters/{slug}/draft.md`。 */
export function draftPath(key: string, slug: string): string {
  return joinPath(chapterDir(key, slug), "draft.md");
}

/** 导读产物：`atlas/{key}/work/prologue/draft.md`（全书级，由 Synthesizer 产）。 */
export function prologuePath(key: string): string {
  return joinPath(workDir(key), "prologue/draft.md");
}

/** 复刻子工程目录：`atlas/{key}/work/chapters/{slug}/replica/`。 */
export function replicaDir(key: string, slug: string): string {
  return joinPath(chapterDir(key, slug), "replica/");
}

// ---------------------------------------------------------------------------
// Run key 生成
// ---------------------------------------------------------------------------

/**
 * 把 Repository Source（URL 或本地路径）转成 Run key。
 * 对应 CONTEXT.md「Run」术语：同名仓库共用同一 Run 目录。
 *
 * 规则：
 * - URL（http(s):// 或 git@）：取最后一段，去 `.git` 后缀。
 * - 本地路径：取 basename（支持正反斜杠）。
 * - 安全转义：转小写、kebab-case，仅保留 `[a-z0-9-]`，其余折叠为单个 `-`，
 *   去掉首尾 `-`，空串兜底 `"repo"`。
 *
 * 例：
 *   `https://github.com/o/My_Repo.git` → `my-repo`
 *   `D:\code\foo.bar`                  → `foo-bar`
 *   `./a/b/`                           → `b`
 *   `""` / `???`                       → `repo`
 */
export function keyFromRepo(repo: string): string {
  const input = (repo ?? "").trim();
  if (input === "") return "repo";

  // 1) 取末端名称段。
  let name = "";
  const isUrl = /^(https?:\/\/|git@|ssh:\/\/)/i.test(input);
  if (isUrl) {
    // URL：去 query/hash，按 `/` 取最后一段。
    const noQuery = input.split(/[?#]/)[0];
    const trimmed = noQuery.replace(/\/+$/, ""); // 去尾斜杠
    const seg = trimmed.split("/").pop() ?? "";
    name = seg;
  } else {
    // 本地路径：支持反斜杠；先按 `\` 拆，再按 `/` 拆，取末段。
    const normalized = input.replace(/\\/g, "/").replace(/\/+$/, "");
    const seg = normalized.split("/").pop() ?? "";
    name = seg;
  }

  // 2) 去 `.git` 后缀（大小写不敏感）。
  name = name.replace(/\.git$/i, "");

  // 3) 安全转义：转小写 → 非 [a-z0-9] 折叠为单个 `-` → 去首尾 `-`。
  let key = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  // 4) 兜底：空串或纯非法输入 → `repo`。
  return key === "" ? "repo" : key;
}

// ---------------------------------------------------------------------------
// 文件系统原语
// ---------------------------------------------------------------------------

/**
 * 递归建目录，幂等（已存在不报错）。
 * 内部统一把传入路径按平台解析（路径函数返回的是 POSIX 串，node fs 在
 * Windows 上也认正斜杠）。
 */
export async function ensureDir(path: PathLike): Promise<void> {
  await mkdir(path, { recursive: true });
}

/**
 * 幂等存在判断。文件/目录不存在时返回 false（不抛错）。
 */
export async function pathExists(path: PathLike): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") return false;
    throw err; // 其它错误（权限等）照常抛出
  }
}

/**
 * 读取并 JSON.parse 文件。
 * 文件不存在时抛**带路径的明确错误**，便于上层诊断；JSON 解析失败同样带路径。
 */
export async function readJson<T>(path: PathLike): Promise<T> {
  const target = String(path);
  let text: string;
  try {
    text = await Bun.file(target).text();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") {
      throw new Error(`io.readJson: 文件不存在: ${target}`);
    }
    throw err;
  }
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    throw new Error(`io.readJson: JSON 解析失败: ${target}: ${(err as Error).message}`);
  }
}

/**
 * 原子写 JSON：2 空格缩进 + 末尾换行。
 * 实现：先写 `{path}.tmp`，写完再 rename 到目标；写前自动 ensureDir(dirname)。
 * 这样写入过程被中断也不会留下半写的目标文件。
 */
export async function writeJson(path: PathLike, data: unknown): Promise<void> {
  const text = JSON.stringify(data, null, 2) + "\n";
  await writeText(path, text);
}

/**
 * 原子写文本：先写 `{path}.tmp` 再 rename，写前自动 ensureDir(dirname)。
 */
export async function writeText(path: PathLike, text: string): Promise<void> {
  const target = String(path);
  const dir = dirname(target);
  await ensureDir(dir);
  const tmp = `${target}.tmp`;
  // 直接写 .tmp（Bun.write 在文件存在时会覆盖）。
  await Bun.write(tmp, text);
  await rename(tmp, target);
}

// ---------------------------------------------------------------------------
// 取源原语（design §4 Stage 1 / §10 / ADR-0005）
// ---------------------------------------------------------------------------

/**
 * 解析本地源路径：转绝对路径 + 校验存在。
 *
 * **绝不复制**（ADR-0005 + design §4/§10 + FR-1.2）：本地源原地只读直读，
 * manifest 仅记 absPath，agent 用只读工具访问。
 *
 * @returns `{ absPath }` 绝对路径字符串
 * @throws 路径不存在时抛带路径的明确错误
 */
export function resolveLocalSource(path: string): { absPath: string } {
  const absPath = resolve(path);
  // 同步校验存在：本原语约定为同步接口（design §4「记录绝对路径」），
  // 避免给一个本身不涉及异步的纯解析函数套 async 签名。
  if (!existsSync(absPath)) {
    throw new Error(`io.resolveLocalSource: 本地源路径不存在: ${absPath}`);
  }
  return { absPath };
}

/**
 * 浅克隆远程仓库到 dest（design §4 Stage 1）。
 *
 * - dest 写前 ensureDir。
 * - 非零退出码抛带 stderr 摘要的 `Error`。
 * - URL 只做**最基本的协议校验**（http(s):// 或 git@），不做完整 git URL 语法解析。
 * - 返回 `{ cmd }`：规范化命令串（供 manifest `stages.acquire.cmd` 记录，AC-7 核验）。
 *
 * 注：本函数需真实 git + 网络，单元测试不覆盖；由 M12 冒烟验证。
 */
export async function cloneSource(
  url: string,
  dest: string
): Promise<{ cmd: string }> {
  // URL 基础协议校验。
  if (!/^(https?:\/\/|git@)/i.test(url)) {
    throw new Error(
      `io.cloneSource: 非法的仓库 URL（仅支持 http(s):// 或 git@）: ${url}`
    );
  }

  await ensureDir(dest);

  const args = ["clone", "--depth", "1", url, dest];
  const cmd = `git clone --depth 1 ${url} ${dest}`;

  return new Promise<{ cmd: string }>((resolveP, rejectP) => {
    const child = spawn("git", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("error", (err) => {
      rejectP(
        new Error(`io.cloneSource: 启动 git 失败: ${err.message}`)
      );
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolveP({ cmd });
      } else {
        const summary = stderr.trim().slice(-500); // 末 500 字符，避免超长
        rejectP(
          new Error(
            `io.cloneSource: git clone 失败 (exit=${code}): ${summary}`
          )
        );
      }
    });
  });
}

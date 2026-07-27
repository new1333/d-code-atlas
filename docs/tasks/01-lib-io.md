# M01 · lib-io

> 路径约定、JSON 读写、取源原语。所有 Stage 共用的 IO 基元。
> 对应 design §3（lib/io.ts）、§4 Stage 1（Acquire）、§8（产物路径）、§10（取源与只读隔离）。

## 依赖
- M00 project-scaffolding

## 子任务

- [ ] `src/lib/io.ts` 定义路径约定（纯函数，返回绝对/相对约定路径）：
  - `atlasRoot()` → `atlas/`
  - `runDir(key)` → `atlas/{key}/`
  - `sourceDir(key)` → `atlas/{key}/work/source/`
  - `workDir(key)` → `atlas/{key}/work/`
  - `siteDir(key)` → `atlas/{key}/site/`
  - `manifestPath(key)` → `atlas/{key}/manifest.json`
  - `chaptersDir(key)` → `atlas/{key}/work/chapters/`
  - `chapterDir(key, slug)` → `.../chapters/{slug}/`
  - `repoMapPath(key)` / `outlinePath(key)` / `researchPath(key, slug)` / `draftPath(key, slug)` / `replicaDir(key, slug)`
- [ ] `keyFromRepo(repo: string): string`：URL 取 repo 段、本地路径取 basename，做安全转义（kebab，去 `.git`）。对应 CONTEXT.md「Run」术语。
- [ ] `ensureDir(path)`：递归建目录，幂等。
- [ ] `readJson<T>(path): Promise<T>`：读 + JSON.parse，文件不存在抛明确错误。
- [ ] `writeJson(path, data)`：**原子写**（写 `.tmp` 再 rename），2 空格缩进，末尾换行。
- [ ] `writeText(path, text)`：原子写文本。
- [ ] `cloneSource(url, dest): Promise<{cmd: string}>`：执行 `git clone --depth 1 <url> <dest>`，返回命令串（供 manifest 记录）；失败抛带 stderr。
- [ ] `resolveLocalSource(path): {absPath: string}`：转绝对路径 + 校验存在；**不复制**（ADR-0005）。
- [ ] 自测（可放 `test/io.test.ts` 或 `bun -e`）：writeJson→readJson round-trip；ensureDir 幂等；keyFromRepo 对 URL/路径各一例。

## Done 标准
- `io.ts` 全部导出可被上层 import。
- 原子写在意外中断后不留半写文件（手动 kill 验证）。
- 路径函数与 design §8、§12 一致。

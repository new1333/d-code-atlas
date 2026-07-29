// agents/surveyor.ts：Surveyor（仓库结构测绘员）的 agent 封装。
// 对应 design §4 Stage 2（Survey）、§5.1（输出要点）、§8.1（repo-map schema）、
// ADR-0005（源只读）、AC-7（cmd 核验）。
//
// 契约（design §5 / AC-7）：
//   - tools = "readonly"（绝不 write）：buildCmd 必然产出 `--allowedTools Read,Glob,Grep`。
//   - cwd = runDir(key)（`atlas/{key}/`）：相对 cwd 读 `work/source/`（git）或本地源绝对路径。
//   - **不落盘** repo-map.json——Surveyor 把 JSON 内容以 ```json fence 包裹作 stdout
//     返回；本 agent 从 result.stdout 用 extractJson<RepoMap> 提取后 return；
//     由 Stage 原子落盘到 work/repo-map.json。
//
// user prompt 与 prompts/surveyor.md 的输入占位对齐：告知 sourceKind/sourcePath、
// 强调只读、要求产出 repo-map.json 内容（schema 字段细节由 system prompt 承载）。

import { runClaude } from "../lib/run-claude.ts";
import { runDir } from "../lib/io.ts";
import { extractJson } from "../lib/extract.ts";
import type { RepoMap } from "../lib/types.ts";
import { promptPath, agentAddDirs, type AgentOutcome, type AgentCommonOpts } from "./types.ts";

/**
 * Surveyor 入参的取源方式（语义层，区别于 manifest 的 `SourceKind`）：
 *   - `"git"` / `"git-clone"`：源已 git clone 到 work/source/（相对 cwd），Surveyor
 *     产物 repo-map.json 的 sourceKind 字段记 `"git-clone"`。
 *   - `"local"`：本地源原地只读，agent 用绝对路径 sourcePath 直读（不复制），
 *     repo-map.json 的 sourceKind 字段记 `"local"`。
 *
 * 注：manifest 的 `SourceKind` 是 `"url" | "local"`（acquire 阶段语义）；
 *   Surveyor 是 acquire 之后的角色，看到的是「已 clone 的 work/source/」或「本地路径」，
 *   故这里用更贴合 Surveyor 视角的枚举。
 */
export type SurveyorSourceKind = "git" | "git-clone" | "local";

/** Surveyor 入参。 */
export interface SurveyorOpts extends AgentCommonOpts {
  /** Run key（决定 runDir）。 */
  key: string;
  /** 取源方式（见 SurveyorSourceKind）。 */
  sourceKind: SurveyorSourceKind;
  /** 本地源时的绝对路径（git 场景不用，传 undefined 即可）。 */
  sourcePath?: string;
}

/** Surveyor 返回：AgentOutcome + 解析出的 repoMap（解析失败为 null）。 */
export interface SurveyorOutcome extends AgentOutcome {
  /** 从 stdout ```json fence 提取的 RepoMap；解析失败为 null（同时 ok=false）。 */
  repoMap: RepoMap | null;
}

/**
 * 调起 Surveyor agent：测绘仓库结构，产出 repo-map.json 内容。
 *
 * 流程：拼 user prompt → runClaude（readonly, cwd=runDir）→ 从 stdout 提取 RepoMap。
 * 不落盘（Stage 负责）。返回 cmd 供 manifest 记录 + AC-7 核验。
 */
export async function surveyor(opts: SurveyorOpts): Promise<SurveyorOutcome> {
  const { key, sourceKind, sourcePath, model, spawn } = opts;

  const cwd = runDir(key);
  const systemPromptPath = promptPath("surveyor");

  // 拼写源码位置说明（与 surveyor.md §3 输入占位对齐）。
  //   git：源在 work/source/（相对 cwd，即 atlas/{key}/work/source/）。
  //   local：源在 sourcePath 绝对路径（只读，原地直读，不复制——ADR-0005）。
  const isGit = sourceKind === "git" || sourceKind === "git-clone";
  const sourceLoc = isGit
    ? "work/source/（相对你当前 cwd，即 atlas/" + key + "/work/source/；git clone 已就位）"
    : `${sourcePath ?? "(未提供)"}（绝对路径，只读——用 Read/Glob/Grep 读取，禁止任何写操作）`;

  const sourceKindValue: RepoMap["sourceKind"] = isGit ? "git-clone" : "local";
  const rootHint = isGit ? "work/source" : (sourcePath ?? "(未提供)");

  const prompt = [
    "你是 Surveyor（仓库结构测绘员）。请对源仓库做结构测绘，产出 repo-map.json 的内容。",
    "",
    "## 本次输入",
    `- Run key: ${key}`,
    `- 取源方式 (sourceKind): ${sourceKindValue}`,
    `- 源码位置: ${sourceLoc}`,
    `- cwd: ${cwd}（相对 cwd 读 work/... 即 atlas/${key}/work/...）`,
    "",
    "## ⚠️ 访问授权（重要，请直接使用工具，不要声称被拦截）",
    "启动你的命令已通过 `--add-dir` 把源码目录加入你的可访问工作目录，并启用 `--dangerously-skip-permissions`。",
    "因此你可以、也**必须**直接用 `Glob`/`Read`/`Grep` 访问上述源码位置（即便它在 cwd 之外）。",
    "- 第一步请先执行 `Glob` 扫描源码目录（如 `**/*.{ts,js,json,md}` 或 `**/*`），拿到真实文件清单。",
    "- 若某次工具调用返回错误，**重试一次**或换路径写法（如绝对路径），不要就此放弃并声称「无法访问」。",
    "- 只有真实读到源码才能产出 repo-map；凭空编造结构违反契约（会被 agent 层校验）。",
    "- **不要用 Read 去读你的角色 prompt 文件（surveyor.md）或引擎源码**——角色指令已在你的 system prompt 里，schema 字段也在下面给了，无需读外部文件。",
    "",
    "## 任务",
    "1. 用 Read/Glob/Grep 扫描源码结构（目录树、入口、清单、语言/框架线索、monorepo 子包、docs）。",
    "2. 过滤重型目录：tree 中**不得**出现 node_modules/.git/dist/build。",
    "3. 产出严格符合下面 schema 的 JSON。",
    "4. 全程**只读**：禁止 Write/Edit；源仓库文件逐字节不变（ADR-0005、AC-7）。",
    "",
    "## repo-map.json schema（严格按此字段名与类型，不可改名）",
    "```json",
    "{",
    `  "root": "${rootHint}",`,
    `  "sourceKind": "${sourceKindValue}",`,
    '  "languages": ["ts", "js"],',
    '  "frameworks": ["react"],',
    '  "entrypoints": ["src/index.ts"],',
    '  "manifests": ["package.json"],',
    '  "packages": [{ "name": "core", "path": "packages/core" }],',
    '  "tree": [',
    '    { "path": "src", "type": "dir" },',
    '    { "path": "src/index.ts", "type": "file", "role": "entry" }',
    '  ],',
    '  "docs": ["README.md"]',
    "}",
    "```",
    "字段说明：",
    "- `root`：源根目录（已给你，照填）。",
    "- `sourceKind`：\"git-clone\" 或 \"local\"（已给你，照填）。",
    "- `languages`：检测到的语言（按扩展名分布，如 ts/js/go）。",
    "- `frameworks`：框架线索（有明确证据才列，不确定就空数组）。",
    "- `entrypoints`：入口文件相对路径（来自 package.json main/module/exports/bin，或 index.*）。",
    "- `manifests`：清单/配置文件相对路径（package.json/tsconfig.json 等）。",
    "- `packages`：monorepo 子包 `{name,path}[]`（单包仓库为空数组 []）。",
    "- `tree`：简化目录树 `{path,type:\"dir\"|\"file\",role?:\"entry\"}[]`，过滤重型目录。",
    "- `docs`：文档文件相对路径（README.md、docs/**/*.md）。",
    "",
    "## 输出契约（严格）",
    "你的最终回复**只**包含一个被 ```json fence 包裹的 JSON 对象（repo-map.json 的完整内容），",
    "fence 外**不写**任何正文/解释/字段推断说明。agent 层会从 stdout 提取 fence 内 JSON。",
  ].join("\n");

  const result = await runClaude({
    prompt,
    systemPromptPath,
    cwd,
    tools: "readonly",
    model,
    spawn,
    // 本地源在 cwd 之外，必须 --add-dir 声明，否则 claude Read/Glob/Grep 被拦截。
    // 同时声明 prompts 目录（角色 prompt 文件在 cwd 外，claude 可能 Read 它）。
    addDirs: agentAddDirs(!isGit ? sourcePath : undefined),
    // validate：surveyor 必须产出可解析的 repo-map JSON。
    validate: (stdout) => extractJson<RepoMap>(stdout) !== null,
  });

  // 从 stdout 提取 RepoMap（fence 优先，fallback 兜底；失败 null）。
  const repoMap = extractJson<RepoMap>(result.stdout);

  return {
    ok: result.ok && repoMap !== null,
    cmd: result.cmd,
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    repoMap,
  };
}

// lib/types.ts：领域共享类型（产物 schema 对应的 TS 形状）。
// 对应 design §8（产物路径与 schema）、§5（角色清单）。
//
// 这些类型供 agents（M08）与 stages（M09）共用——单一真相源，避免散落多处
// 各自定义导致漂移。仅声明形状（interface），不含运行时逻辑。
//
// 与 manifest.ts 的关系：
//   - `SourceInfo`/`SourceKind` 在 manifest.ts 已定义（manifest 的 source 字段）。
//     这里 re-export，让 agents/stages 不必直接 import manifest.ts（降低耦合）。
//   - `RepoMap`/`Chapter`/`Outline` 是 work 产物形状，仅在此处声明。

// re-export manifest 的 source 类型，作 agents/stages 的统一入口（避免重复定义）。
export type { SourceInfo, SourceKind } from "./manifest.ts";

// ---------------------------------------------------------------------------
// repo-map.json（Surveyor 产物，design §8.1）
// ---------------------------------------------------------------------------

/** Surveyor 产物 `work/repo-map.json` 的形状（design §8.1）。 */
export interface RepoMap {
  /** 源根目录：git 克隆写 `work/source`；本地源写绝对路径。 */
  root: string;
  /** 取源方式：`"git-clone"`（URL 克隆）或 `"local"`（本地源原地只读）。 */
  sourceKind: "git-clone" | "local";
  /** 检测到的编程语言（按扩展名分布推断，如 `ts`/`js`/`go`/`rust`）。 */
  languages: string[];
  /** 框架线索（从依赖/import/配置推断；不确定不列）。 */
  frameworks: string[];
  /** 入口文件相对路径（来自 package.json 的 main/module/exports/bin + index.*）。 */
  entrypoints: string[];
  /** 清单/配置文件相对路径（package.json/tsconfig.json/vite.config.* 等）。 */
  manifests: string[];
  /** monorepo 子包（扫 `packages/<name>/package.json`、`apps/<name>/package.json`；单包为空）。 */
  packages: RepoMapPackage[];
  /** 简化目录树（过滤 SKIP_HEAVY_DIRS）；type=dir|file，入口文件带 role:"entry"。 */
  tree: RepoMapNode[];
  /** 文档文件相对路径（`README.md`、`docs/` 下的 markdown 等）。 */
  docs: string[];
}

/** monorepo 子包（design §8.1 packages[]）。 */
export interface RepoMapPackage {
  /** 子包名（package.json 的 name；无 name 时用目录名）。 */
  name: string;
  /** 子包根目录相对路径（如 `packages/core`）。 */
  path: string;
}

/** 简化目录树单个节点（design §8.1 tree[]）。 */
export interface RepoMapNode {
  /** 相对 root 的 POSIX 路径（正斜杠）。 */
  path: string;
  /** 节点类型：目录或文件。 */
  type: "dir" | "file";
  /** 可选角色标记：入口文件打 `"entry"`；普通文件不写。 */
  role?: "entry";
}

// ---------------------------------------------------------------------------
// outline.json（Architect 产物 + Orchestrator 注入 topoOrder，design §8.2）
// ---------------------------------------------------------------------------

/**
 * outline.json 的 chapters[] 单项（design §8.2）。
 * Architect 只产 chapters[]，不含 topoOrder（由 stage 调 topo.ts 注入）。
 */
export interface Chapter {
  /** kebab-case 英文 slug（仅 `[a-z0-9-]`），全 outline 内唯一。 */
  slug: string;
  /** 中文章节标题，聚焦一个概念。 */
  title: string;
  /** 概念层级：原子（primitive）/ 复合（composite）/ 系统（system），仅作侧边栏分组。 */
  layer: "primitive" | "composite" | "system";
  /** 理解本章前必须先理解的其它 slug 列表（必须形成 DAG，禁止自环/成环）。 */
  dependsOn: string[];
  /** 该章对应源码相对路径（Reader 的读取范围），相对 root，POSIX 风格。 */
  sourceFiles: string[];
  /** 中文一句话概括本章讲什么。 */
  summary: string;
}

/**
 * 完整 outline.json（design §8.2）。
 * - Architect 产出时只填 chapters[]（topoOrder/repo/generatedAt 不填）。
 * - Stage 用 topo.ts 注入 topoOrder，并补 repo/generatedAt 元数据后落盘。
 */
export interface Outline {
  /** 仓库名/标识（由 Orchestrator 注入）。 */
  repo?: string;
  /** 生成时间 ISO 串（由 Orchestrator 注入；确定性路径可固定值）。 */
  generatedAt?: string;
  /** 章节列表（Architect 产出）。 */
  chapters: Chapter[];
  /** 拓扑序 slug 列表（由 stage 调 topoSort 注入；Architect 不写或写空数组）。 */
  topoOrder: string[];
}

/**
 * Architect 实际产出的子集（仅 chapters[]）。
 * Architect 的 stdout fence 内 JSON 形如 `{ chapters: [...] }`，无 topoOrder/repo。
 */
export interface ArchitectOutput {
  chapters: Chapter[];
}

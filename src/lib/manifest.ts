// lib/manifest.ts：manifest.json 状态机读写。
// 对应 design §8.3（manifest schema）、§9（续跑与状态机 ADR-0002）、§15（错误处理与降级），
// 以及 verification.md AC-3（续跑）与 AC-6（review trace 可查）。
//
// 这是整个 Run 跨 session 续跑的真相之源（single source of truth）：
// Orchestrator 自身无运行时状态（design §9 / ADR-0002），每一步"做完了什么"都
// 落到 `atlas/{key}/manifest.json`。续跑时只读 manifest → 找第一个非 `done` 的项
// → 从那继续（AC-3）。所以本模块的三个核心契约：
//   1) 所有更新器 **immutable**：返回新对象，绝不就地 mutate 入参。
//      这是 design §9 + AC-3 的基础——调用方持有的旧 manifest 不应被偷偷改写，
//      否则"读 manifest → 改 → 写" 的并发与回滚语义会失控。
//   2) `setStageStatus`/`setChapterStatus` 的语义支持 CAS 式写入纪律
//      （design §9：先完整落盘产物、再置 `done`）。本模块只负责状态计算与读写，
//      "先产物后状态"的顺序纪律由 stage 层（M09）落实。
//   3) 字段与 design §8.3 schema **逐字段对齐**（见各类型上方注释的「design §8.3」标记）。
//
// 零运行时依赖：仅复用上游 lib/io.ts 的 JSON/路径原语。

import { manifestPath, readJson, writeJson } from "./io.ts";

// ===========================================================================
// 时间戳：可注入的 nowIso
// ===========================================================================
// design §8.2 提到「确定性路径可选」（脚本内不取系统时钟）；MVP 用 ISO now 即可，
// 但为了测试可控（断言精确时间戳），提供一个模块级注入点。
// 默认行为不变（仍取 `new Date().toISOString()`），仅在测试里通过 setNow/resetNow 覆盖。

/** 默认 now 实现：返回 ISO 8601 字符串。 */
const _defaultNow = (): string => new Date().toISOString();

/** 当前注入的 now 实现（默认即 _defaultNow）。 */
let _now: () => string = _defaultNow;

/**
 * 取当前 ISO 时间戳（用于 startedAt/finishedAt）。
 * 默认 `new Date().toISOString()`；测试可经 `setNow` 注入固定时钟。
 */
export function nowIso(): string {
  return _now();
}

/**
 * 注入自定义 now 函数（测试用）。传入返回固定 ISO 串的函数即可让时间戳确定性化。
 * 调用方负责在测后 `resetNow()` 还原，避免污染其它测试。
 */
export function setNow(fn: () => string): void {
  _now = fn;
}

/** 还原为默认 now 实现（测试 afterEach 调用）。 */
export function resetNow(): void {
  _now = _defaultNow;
}

// ===========================================================================
// 类型（design §8.3 manifest schema 字段对齐）
// ===========================================================================

/**
 * design §8.3 / §9：每个 Stage / chapter 子项的状态机。
 *   pending → running → done（正常）
 *                ↘ → failed（失败，design §15）
 *                ↘ → awaiting_review（评审流转中间态，见 §6 / ADR-0004）
 * Orchestrator 选下一 Stage 时只认 `done`（design §9 CAS 式纪律）。
 */
export type StageStatus =
  | "pending"
  | "running"
  | "done"
  | "failed"
  | "awaiting_review";

/**
 * design §4 流水线的 7 个 Stage。顺序见 STAGE_ORDER。
 * research / write 是逐章并发的，会下钻到 chapter 级（见 ChapterState）。
 */
export type StageName =
  | "acquire"
  | "survey"
  | "outline"
  | "research"
  | "write"
  | "assemble"
  | "build";

/**
 * Stage 的拓扑顺序（design §1 流水线图、§4 详述）。
 * Orchestrator 用它确定"下一个该跑哪个 stage"（findNextPending 按此顺序扫描）。
 * 设为 readonly 元组常量，避免被误改。
 */
export const STAGE_ORDER: readonly StageName[] = [
  "acquire",
  "survey",
  "outline",
  "research",
  "write",
  "assemble",
  "build",
];

/**
 * design §8.3 source 字段：Run 的输入来源。
 * - url：`{ kind:"url", ref:<url>, localPath:null }`（git clone 场景）
 * - local：`{ kind:"local", ref:<原始输入>, localPath:<absPath> }`（原地只读直读，ADR-0005）
 */
export type SourceKind = "url" | "local";

/** design §8.3 source：来源信息。 */
export interface SourceInfo {
  kind: SourceKind;
  /** url 场景为 URL 串；local 场景为用户原始输入路径。 */
  ref: string;
  /** local 场景为解析后的绝对路径；url 场景为 null。 */
  localPath: string | null;
}

/**
 * design §8.3 review.trace[] 单条记录：对抗评审一轮的痕迹。
 * 用于 AC-6（review trace 可查）。
 */
export interface ReviewTrace {
  /** 轮次序号（1-based）。 */
  round: number;
  /** Critic 判定：approve 短路接受；reject 触发 Producer 修订。 */
  verdict: "approve" | "reject";
  /** reject 时 Critic 给出的修改点摘要（可选）。 */
  fixes?: string[];
  /** 该轮对应的 claude 命令串（可选，便于审计）。 */
  cmd?: string;
}

/**
 * design §8.3 review：一次对抗评审的汇总（挂在 outline / 各章 write 上）。
 * final 为 `accepted-with-warning` 表示到轮数上限未过、接受最后版本 + manifest 告警（design §15）。
 */
export interface ReviewSummary {
  /** 实际跑的总轮数（≤ REVIEW_ROUNDS）。 */
  rounds: number;
  /** 最终结论。 */
  final: "approved" | "accepted-with-warning";
  /** 每轮的评审痕迹（AC-6 可查）。 */
  trace: ReviewTrace[];
}

/**
 * design §8.3 stages.* / chapters.*.research / chapters.*.write 的统一形状。
 * 一个 Stage 或一个 chapter 子步骤的状态 + 时间戳 + 命令 + 评审汇总。
 */
export interface StageState {
  status: StageStatus;
  /** 进入 running 时记（CAS 式：置 done 不改这里）。 */
  startedAt?: string;
  /** 进入终态（done/failed）时记。 */
  finishedAt?: string;
  /** 实际执行的命令串（AC-7 核验扫描，design §8.3 示例）。 */
  cmd?: string;
  /** 对抗评审汇总（仅 outline 与每章 write 有意义；其它为 null/缺省）。 */
  review?: ReviewSummary | null;
  /**
   * 失败诊断（仅 status=failed 时有意义）：agent / 子进程的退出码。
   * 落盘到 manifest，使 `atlas show` 能直接看到失败原因，而非只看到 "failed"。
   */
  exitCode?: number;
  /**
   * 失败诊断：agent / 子进程的 stderr（可能截断），失败时记录便于排查。
   * 成功路径不写此字段（undefined，序列化时缺省）。
   */
  stderr?: string;
  /**
   * 失败诊断：人类可读的错误摘要（如 acquire 的 clone 失败信息、build 的报错）。
   * 与 stderr 互补——stderr 是原始输出，error 是提炼后的一句话。
   */
  error?: string;
}

/**
 * design §8.3 chapters.<slug> 的形状：research + write 两个子步骤。
 *
 * 与 design §8.3 的等价性说明：
 *   design §8.3 示例里 `chapters.<slug>.write` 写作 `StageState & { review? }`，
 *   但 `StageState` 本身已含 `review?` 字段——即 `write.review` 就是 StageState.review，
 *   没必要重复声明。本实现采用更简洁的 `{ research: StageState; write: StageState }`，
 *   与 design §8.3 在序列化层完全等价（同一 JSON 形状）。
 *   research 与 write 共用同一 StageState 形状，review 自然挂在 write.review 上。
 */
export interface ChapterState {
  research: StageState;
  write: StageState;
}

/**
 * design §8.3 manifest.json 顶层结构 + 一个必要扩展字段 `chapterOrder`。
 */
export interface Manifest {
  /** design §8.3 key：Run key（仓库目录名，见 io.keyFromRepo）。 */
  key: string;
  /** design §8.3 source：来源信息。 */
  source: SourceInfo;
  /** design §8.3 version：schema 版本（MVP=1）。 */
  version: number;
  /** design §8.3 stages：7 个 Stage 的状态。 */
  stages: Record<StageName, StageState>;
  /** design §8.3 chapters：逐章状态（key=slug）。 */
  chapters: Record<string, ChapterState>;
  /**
   * **必要扩展字段**（design §8.3 未列出，但续跑正确性的刚需）。
   *
   * 为什么加：`chapters` 是 `Record<string, ChapterState>`，JS 对象 key 顺序虽然
   * 在实践中稳定（插入序），但 `Record` 在类型语义上是"无序映射"。research/write
   * 的下钻遍历需要严格按 outline 的拓扑顺序推进（自底向上，ADR-0003），否则续跑时
   * "下一个待办章节"的选取会变成不确定的，破坏 AC-3 的可复现性。
   * 因此把 outline 确定的章节顺序**显式**记成一个数组字段，作为续跑时的权威顺序。
   *
   * 这是对 §8.3 schema 的纯增量扩展：不修改/重命名任何既有字段，旧读者忽略它即可。
   * 由 `registerChapters` 在 Outline 完成后按拓扑序填充（追加新 slug，不重复）。
   */
  chapterOrder?: string[];
}

// ===========================================================================
// initManifest
// ===========================================================================

/** 造一个 pending 态的 StageState（不带时间戳/命令/review）。 */
function pendingStage(): StageState {
  return { status: "pending" };
}

/**
 * 造一个 chapter.write 的 pending 态 StageState。
 * 与 design §8.3 示例对齐：`"write": { "status": "pending", "review": null }`——
 * write 显式带 `review: null`，使 AC-6 脚本读到稳定 null（而非 undefined），
 * 且序列化形状与 design 示例一致。
 */
function pendingWriteStage(): StageState {
  return { status: "pending", review: null };
}

/**
 * 初始化一个全新的 manifest：所有 stage 置 `pending`，chapters 为空，version=1。
 * design §8.3 / §9：Run 开始时由 Orchestrator 调用一次。
 */
export function initManifest(key: string, source: SourceInfo): Manifest {
  const stages = {} as Record<StageName, StageState>;
  for (const s of STAGE_ORDER) {
    stages[s] = pendingStage();
  }
  return {
    key,
    source,
    version: 1,
    stages,
    chapters: {},
    // chapterOrder 初始留空数组（Outline 完成后由 registerChapters 填充）。
    chapterOrder: [],
  };
}

// ===========================================================================
// loadManifest / saveManifest（走 io 原子读写）
// ===========================================================================

/**
 * 从磁盘读 manifest（design §8.3 / §9 续跑入口）。
 * 走 io.readJson；文件不存在时 io 层抛"带路径的明确错误"。
 */
export function loadManifest(key: string): Promise<Manifest> {
  return readJson<Manifest>(manifestPath(key));
}

/**
 * 把 manifest 原子写回磁盘（design §9 CAS 式纪律的落盘动作）。
 * 走 io.writeJson（先写 .tmp 再 rename，杜绝半写文件）。
 */
export async function saveManifest(key: string, m: Manifest): Promise<void> {
  await writeJson(manifestPath(key), m);
}

// ===========================================================================
// immutable 更新器
// ===========================================================================
// 纪律：所有更新器返回**新对象**，绝不就地 mutate 入参。
// 实现手法：层级展开 `{...m}` / `{...m.stages}` / `{...stage}` 等。
// 这保证调用方持有的旧 manifest 引用不会被偷偷改写（design §9 + AC-3 基础）。

/** 状态终态集合：进入这些状态时记 finishedAt。 */
const TERMINAL_STATES: ReadonlySet<StageStatus> = new Set([
  "done",
  "failed",
]);

/**
 * 在单个 StageState 上应用状态变更（不可变）。
 * 抽出来供 setStageStatus / setChapterStatus 复用。
 *
 * 规则（design §9 CAS 式语义）：
 * - status 总是覆盖；
 * - opts.cmd 提供则覆盖 cmd（不提供则保留原 cmd）；
 * - opts.exitCode/stderr/error 提供则写入对应诊断字段（仅 failed 路径有意义；
 *   成功路径不传，保留 undefined → 序列化缺省）；
 * - 进入 `running` 时记 startedAt（用 opts.now 或默认 nowIso），并清掉上一次失败
 *   残留的诊断字段（exitCode/stderr/error）——新一轮尝试不应带着旧诊断；
 * - 进入终态（done/failed）时记 finishedAt；
 * - 其它状态切换不动 startedAt/finishedAt（保留历史）。
 */
function applyStatus(
  prev: StageState,
  status: StageStatus,
  opts: { cmd?: string; exitCode?: number; stderr?: string; error?: string; now?: () => string } | undefined,
): StageState {
  const now = opts?.now ?? nowIso;
  const next: StageState = { ...prev, status };
  if (opts?.cmd !== undefined) {
    next.cmd = opts.cmd;
  }
  if (opts?.exitCode !== undefined) {
    next.exitCode = opts.exitCode;
  }
  if (opts?.stderr !== undefined) {
    next.stderr = opts.stderr;
  }
  if (opts?.error !== undefined) {
    next.error = opts.error;
  }
  if (status === "running") {
    next.startedAt = now();
    // 进入新一轮 running：清掉上一次失败的诊断（重跑会产生新的；旧的不再适用）。
    delete next.exitCode;
    delete next.stderr;
    delete next.error;
  }
  if (TERMINAL_STATES.has(status)) {
    next.finishedAt = now();
  }
  return next;
}

/**
 * 设置某个顶层 Stage 的状态（不可变）。
 *
 * @param m 原 manifest（不会被修改）
 * @param stage 目标 stage
 * @param status 新状态
 * @param opts.cmd 提供则覆盖 cmd（记录实际执行的命令，AC-7 核验）
 * @param opts.now 时间戳注入点（测试用），默认走 nowIso
 * @returns 新 manifest
 */
export function setStageStatus(
  m: Manifest,
  stage: StageName,
  status: StageStatus,
  opts?: { cmd?: string; exitCode?: number; stderr?: string; error?: string; now?: () => string },
): Manifest {
  const prevStage = m.stages[stage];
  const nextStage = applyStatus(prevStage, status, opts);
  return {
    ...m,
    stages: {
      ...m.stages,
      [stage]: nextStage,
    },
  };
}

/**
 * 设置某个章节的 research/write 子步骤状态（不可变）。
 *
 * @param m 原 manifest（不会被修改）
 * @param slug 章节 slug
 * @param kind "research" | "write"
 * @param status 新状态
 * @param opts 同 setStageStatus
 * @returns 新 manifest
 */
export function setChapterStatus(
  m: Manifest,
  slug: string,
  kind: "research" | "write",
  status: StageStatus,
  opts?: { cmd?: string; exitCode?: number; stderr?: string; error?: string; now?: () => string },
): Manifest {
  const prevChapter = m.chapters[slug] ?? {
    research: pendingStage(),
    write: pendingWriteStage(),
  };
  const nextSub = applyStatus(prevChapter[kind], status, opts);
  const nextChapter: ChapterState = {
    ...prevChapter,
    [kind]: nextSub,
  };
  return {
    ...m,
    chapters: {
      ...m.chapters,
      [slug]: nextChapter,
    },
  };
}

/**
 * 设置某个顶层 Stage 的对抗评审汇总（不可变）。design §8.3 / §6 / ADR-0004。
 * 主要用于 outline（Outline ⇄ Critic）。
 */
export function setStageReview(
  m: Manifest,
  stage: StageName,
  review: ReviewSummary | null,
): Manifest {
  const prevStage = m.stages[stage];
  return {
    ...m,
    stages: {
      ...m.stages,
      [stage]: { ...prevStage, review },
    },
  };
}

/**
 * 设置某个章节 write 的对抗评审汇总（不可变）。design §8.3 / §6 / ADR-0004。
 * review 挂在 `chapters[slug].write.review`（与 design §8.3 序列化等价）。
 */
export function setChapterReview(
  m: Manifest,
  slug: string,
  review: ReviewSummary | null,
): Manifest {
  const prevChapter = m.chapters[slug];
  if (!prevChapter) {
    // 章节不存在时按 pending 建一个最小壳，再挂 review（防御式；正常流程不会走到）。
    const shell: ChapterState = {
      research: pendingStage(),
      write: { ...pendingWriteStage(), review },
    };
    return {
      ...m,
      chapters: { ...m.chapters, [slug]: shell },
    };
  }
  const nextChapter: ChapterState = {
    ...prevChapter,
    write: { ...prevChapter.write, review },
  };
  return {
    ...m,
    chapters: { ...m.chapters, [slug]: nextChapter },
  };
}

/**
 * Outline 完成后批量注册章节（不可变、幂等）。design §8.3 chapters 字段。
 *
 * 行为：
 * - 对每个 slug：若已存在于 m.chapters，**保留原状态**（不重置，避免 resume 时
 *   把已 done 的章节打回 pending）；不存在则建 `{ research:pending, write:pending }`。
 * - `chapterOrder`：按传入 slugs 顺序**追加**新 slug（不重复），作为续跑时的权威章节顺序。
 *
 * 幂等性是 AC-3 的硬需求：同一个 outline resume 多次不能丢已完成的章节进度。
 */
export function registerChapters(m: Manifest, slugs: string[]): Manifest {
  const nextChapters: Record<string, ChapterState> = { ...m.chapters };
  for (const slug of slugs) {
    if (!nextChapters[slug]) {
      nextChapters[slug] = {
        research: pendingStage(),
        write: pendingWriteStage(),
      };
    }
    // 已存在的 slug 保留原状态，不动。
  }

  // chapterOrder：追加新 slug，保留已有顺序，不重复。
  const existing = new Set(m.chapterOrder ?? []);
  const appended: string[] = [];
  for (const slug of slugs) {
    if (!existing.has(slug)) {
      existing.add(slug);
      appended.push(slug);
    }
  }
  const nextOrder = [...(m.chapterOrder ?? []), ...appended];

  return {
    ...m,
    chapters: nextChapters,
    chapterOrder: nextOrder,
  };
}

// ===========================================================================
// findNextPending：续跑选下一步（AC-3 核心）
// ===========================================================================

/** findNextPending 的返回类型：要么是顶层 stage，要么是章节子步骤，要么 null。 */
export type NextPending =
  | { type: "stage"; stage: StageName }
  | { type: "chapter"; stage: "research" | "write"; slug: string }
  | null;

/**
 * 找下一个待办项（design §9 续跑逻辑 / AC-3）。
 *
 * 默认行为：按 STAGE_ORDER 从头找第一个**非 `done`** 的 stage：
 *   - 命中 acquire/survey/outline/assemble/build → 返回 `{type:"stage", stage}`。
 *   - 命中 research/write → 下钻到章节级：按 `chapterOrder`（权威顺序）遍历章节，
 *     返回第一个 `chapters[slug][stage].status !== "done"` 的章节。
 *     若所有章节该 stage 都 done，则视为该 stage 整体完成，继续看下一个 stage。
 *   - 全部 done → 返回 null。
 *
 * @param opts.from 从指定 stage（含）起开始扫描（之前的 stage 不参与判定）。
 *                  用于 `--from <stage>`：聚焦后续 stage。
 * @param opts.only 只看指定 stage。若该 stage 是 research/write 则下钻章节；
 *                  否则只看该 stage 本身。用于 `--only <stage>`。
 *
 * 章节顺序严格按 `chapterOrder`（不依赖 Record key 顺序）——这是续跑可复现性的保证。
 */
export function findNextPending(
  m: Manifest,
  opts?: { from?: StageName; only?: StageName },
): NextPending {
  // 确定要扫描的 stage 列表。
  let stagesToScan: readonly StageName[];
  if (opts?.only) {
    stagesToScan = [opts.only];
  } else if (opts?.from) {
    const idx = STAGE_ORDER.indexOf(opts.from);
    if (idx < 0) {
      // from 不合法时退化为全扫（防御式，正常不会发生）。
      stagesToScan = STAGE_ORDER;
    } else {
      stagesToScan = STAGE_ORDER.slice(idx);
    }
  } else {
    stagesToScan = STAGE_ORDER;
  }

  for (const stage of stagesToScan) {
    if (stage === "research" || stage === "write") {
      // 下钻到章节级。
      const next = findNextPendingChapter(m, stage);
      if (next !== null) {
        return next;
      }
      // 该 stage 所有章节都 done → 视为该 stage 整体完成，继续下一个 stage。
      continue;
    }
    // 非 research/write：直接看顶层 stage 状态。
    if (m.stages[stage].status !== "done") {
      return { type: "stage", stage };
    }
  }
  return null;
}

/**
 * 在某个 chapter-stage（research/write）下找第一个未 done 的章节。
 * 严格按 m.chapterOrder 顺序遍历；chapterOrder 缺省时回退到 Object.keys
 * （仅作兜底，正常流程 registerChapters 后必有 chapterOrder）。
 * 全部 done 返回 null。
 */
function findNextPendingChapter(
  m: Manifest,
  stage: "research" | "write",
): { type: "chapter"; stage: "research" | "write"; slug: string } | null {
  const order = m.chapterOrder?.length ? m.chapterOrder : Object.keys(m.chapters);
  for (const slug of order) {
    const chapter = m.chapters[slug];
    if (!chapter) continue; // chapterOrder 里登记了但 chapters 缺失（异常态），跳过
    if (chapter[stage].status !== "done") {
      return { type: "chapter", stage, slug };
    }
  }
  return null;
}

// ===========================================================================
// forceReset：--force 重跑目标项
// ===========================================================================

/**
 * forceReset 的目标定位符：要么是顶层 stage，要么是章节子步骤。
 */
export type ResetTarget =
  | { type: "stage"; stage: StageName }
  | { type: "chapter"; stage: "research" | "write"; slug: string };

/**
 * 把目标项重置为 `pending`（design §9 `--force` 强制重跑）。
 *
 * 重置语义（task 约定）：
 * - status → pending；
 * - 清掉 startedAt / finishedAt（重跑时会重新记）；
 * - **保留 cmd**（历史命令记录有价值，便于审计"上次是怎么跑的"）；
 * - 清掉 review（重跑即重审，旧评审记录不再适用）。
 *
 * 不可变：返回新 manifest。
 */
export function forceReset(m: Manifest, target: ResetTarget): Manifest {
  if (target.type === "stage") {
    const prev = m.stages[target.stage];
    const reset: StageState = {
      status: "pending",
      // 保留 cmd（历史记录有用）。
      ...(prev.cmd !== undefined ? { cmd: prev.cmd } : {}),
      // 清掉上一次失败的诊断（exitCode/stderr/error）：重跑会产生新的，旧的不再适用。
      // （与 startedAt/finishedAt/review 同样不保留——见下方注释。）
    };
    return {
      ...m,
      stages: {
        ...m.stages,
        [target.stage]: reset,
      },
    };
  }

  // chapter 子步骤重置。
  const { slug, stage } = target;
  const prevChapter = m.chapters[slug];
  if (!prevChapter) {
    // 章节不存在：建一个 pending 壳（防御式）。
    const shell: ChapterState = {
      research: pendingStage(),
      write: pendingWriteStage(),
    };
    return {
      ...m,
      chapters: { ...m.chapters, [slug]: shell },
    };
  }
  const prevSub = prevChapter[stage];
  // write 子步骤重置后回到初始形态 `review:null`（与 design §8.3 示例、
  // pendingWriteStage 一致）；research 无 review 字段，保持 undefined。
  const resetSub: StageState = {
    status: "pending",
    ...(prevSub.cmd !== undefined ? { cmd: prevSub.cmd } : {}),
    ...(stage === "write" ? { review: null } : {}),
  };
  const nextChapter: ChapterState = {
    ...prevChapter,
    [stage]: resetSub,
  };
  return {
    ...m,
    chapters: { ...m.chapters, [slug]: nextChapter },
  };
}

// orchestrator.ts：顶层无状态循环（M10）。
// 对应 design §1（概览：Orchestrator 无运行时状态）、§3（orchestrator.ts）、
// §9（续跑 ADR-0002）、§15（错误处理：失败终止、单点隔离）、
// verification.md AC-1（期望最后打印 `[atlas] run {key} complete.`）、AC-3（续跑）。
//
// 核心不变量（design §1 / ADR-0002）：
//   **Orchestrator 自身无运行时状态**——所有真相在磁盘 `atlas/{key}/manifest.json`。
//   每轮循环都重新 loadManifest（stage 已 saveManifest，但本地变量也要刷新），
//   据 findNextPending 选下一个待办项 → 调对应 stage 函数 → 回到顶部重读。
//
// 失败终止（design §15）：任一 stage 终态 = `failed` → 立即停循环、打印摘要、
// 返回 `{ok:false}`。不无限重试（交用户 `--force` 显式重跑）。
//
// 单点隔离下的循环防重入（design §15 + ADR-0002 的接缝）：
//   research/write 这两个 stage 即使有个别 chapter 失败，stage 级状态仍标 `done`
//   （design §15 单点隔离：流水线不因一章失败而阻塞下游）。但 findNextPending 会
//   下钻到章节级，发现 failed 章（!= done）后会再次返回 `{type:"chapter", stage:"research",...}`，
//   若无条件重入会无限循环。本模块用 `triedStages`（仅本 runPipeline 调用内有效，
//   不落盘——仍保持「orchestrator 无跨调用运行时状态」）记录已尝试过的 stage 名，
//   命中即视为该 stage 已尽力尝试、推进到下一 stage（单点隔离语义落地）。
//   `--only <stage>` 模式下则直接结束（用户只关心这一个 stage，不推进下游）。
//
// 零运行时依赖：仅复用上游 lib/io + lib/manifest + lib/config + 7 个 stage。

import {
  loadManifest,
  saveManifest,
  initManifest,
  findNextPending,
  forceReset,
  STAGE_ORDER,
  type Manifest,
  type StageName,
  type SourceInfo,
} from "./lib/manifest.ts";
import { manifestPath, runDir, ensureDir, pathExists } from "./lib/io.ts";
import { DEFAULT_CONCURRENCY, REVIEW_ROUNDS } from "./lib/config.ts";
import type { SpawnFn } from "./lib/run-claude.ts";
import type { StageContext } from "./stages/types.ts";

// 7 个 stage 函数（每个：async (ctx) => Promise<更新后的 manifest>，已 saveManifest）。
import { acquire } from "./stages/01-acquire.ts";
import { survey } from "./stages/02-survey.ts";
import { outline } from "./stages/03-outline.ts";
import { research } from "./stages/04-research.ts";
import { write } from "./stages/05-write.ts";
import { assemble } from "./stages/06-assemble.ts";
import { build } from "./stages/07-build.ts";

// ---------------------------------------------------------------------------
// 公开类型（task M10 规定的接口）
// ---------------------------------------------------------------------------

/**
 * runPipeline 的 flag 包（对应 CLI 全局 flag，design §13）。
 * 全部可选——缺省时走默认值或不施加约束。
 */
export interface RunPipelineFlags {
  /** `--from <stage>`：从指定 stage（含）起开始扫描，之前的 stage 不参与判定。 */
  from?: StageName;
  /** `--only <stage>`：只跑指定 stage（research/write 仍下钻到章节级）。 */
  only?: StageName;
  /** `--force`：先把目标项 reset 为 pending 再跑（需配合 from/only 之一）。 */
  force?: boolean;
  /** 逐章并发上限（research/write），缺省 DEFAULT_CONCURRENCY（=4）。 */
  concurrency?: number;
  /** 对抗评审轮数上限（outline/每章 write），缺省 REVIEW_ROUNDS（=2）。 */
  reviewRounds?: number;
  /** `--skip-build`：build stage 直接置 done 不真跑 bun（design §4 Stage 7）。 */
  skipBuild?: boolean;
  /** `--model <name>`：透传给 claude 的 model 别名/全名。 */
  model?: string;
}

/**
 * runPipeline 入参。
 * - `key`：Run key（决定 atlas/{key}/ 下一切路径）。
 * - `source`：新建 run 时用；resume 时从 manifest 读（本字段被忽略）。
 * - `flags`：可选的 flag 包。
 * - `spawn`：claude 子进程执行器注入点；单测注入 mock spawn 返回预设 stdout，
 *    真实运行不传（走 run-claude.ts 的 defaultSpawn）。
 * - `onLog`：日志回调注入点；缺省走 console.log。单测可注入收集器断言 complete 串。
 */
export interface RunPipelineOptions {
  key: string;
  source: SourceInfo;
  flags?: RunPipelineFlags;
  spawn?: SpawnFn;
  onLog?: (msg: string) => void;
}

/** runPipeline 返回：ok=true 表示全部 stage done；ok=false 表示中途 failed 终止。 */
export interface RunPipelineResult {
  ok: boolean;
  key: string;
}

// ---------------------------------------------------------------------------
// stage 派发表
// ---------------------------------------------------------------------------

/**
 * 7 个 stage 名 → stage 函数的派发表。
 * research/write 命中时也走这里（chapter 类型按 `next.stage` 查表）——
 * 调一次即并发处理所有未 done 章（design §4 Stage 4/5），不是逐章循环。
 */
const STAGE_FN: Record<StageName, (ctx: StageContext) => Promise<Manifest>> = {
  acquire,
  survey,
  outline,
  research,
  write,
  assemble,
  build,
};

// ---------------------------------------------------------------------------
// 防御性兜底：循环最大轮数
// ---------------------------------------------------------------------------

/**
 * 循环最大轮数（防御式兜底，正常流程远不会触达）。
 * 7 个 stage + research/write 下钻，单次 runPipeline 最多约 9 轮（每 stage 一轮）。
 * 取 STAGE_ORDER.length * 2 + 5 = 19 留足空间，超过即视为异常（如逻辑 bug 导致重入）。
 */
const MAX_LOOP_TURNS = STAGE_ORDER.length * 2 + 5;

// ---------------------------------------------------------------------------
// applyForceReset：把 from/only 范围内的项重置为 pending
// ---------------------------------------------------------------------------

/**
 * 根据 from/only 把目标范围内的 stage（及其 research/write 章节子步骤）重置为 pending。
 *
 * 语义：
 * - `only` 给定：只重置该 stage。若该 stage 是 research/write，额外把所有章节的
 *   对应子步骤也重置（不然 stage 级 pending 但章节全 done，findNextPending 会跳过它）。
 * - `from` 给定（无 only）：重置 `from..build` 范围内的所有 stage；research/write
 *   同样附带章节级重置。
 * - 同时给 from 和 only：only 优先（与 findNextPending 一致）。
 *
 * 幂等：多次调用效果一致（forceReset 返回新 manifest，不改入参）。
 */
function applyForceReset(
  m: Manifest,
  from: StageName | undefined,
  only: StageName | undefined,
): Manifest {
  let result = m;

  // 确定要重置的 stage 列表。
  let stagesToReset: StageName[];
  if (only) {
    stagesToReset = [only];
  } else if (from) {
    const idx = STAGE_ORDER.indexOf(from);
    if (idx < 0) {
      // from 不合法（防御式，正常不会发生）——退化为不重置任何项。
      stagesToReset = [];
    } else {
      stagesToReset = STAGE_ORDER.slice(idx);
    }
  } else {
    // 调用方应在进入本函数前保证 from/only 至少有一个；这里兜底返回原 manifest。
    stagesToReset = [];
  }

  for (const stage of stagesToReset) {
    // 1) 重置 stage 级状态。
    result = forceReset(result, { type: "stage", stage });
    // 2) 若是 research/write：连带重置所有章节的对应子步骤。
    //    否则 stage 级 pending 但章节仍 done，findNextPending 会误判该 stage 已完成。
    if (stage === "research" || stage === "write") {
      const order = result.chapterOrder ?? Object.keys(result.chapters);
      for (const slug of order) {
        result = forceReset(result, { type: "chapter", stage, slug });
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// runPipeline：顶层无状态循环（AC-1 / AC-3 / design §1 / §9 / §15）
// ---------------------------------------------------------------------------

/**
 * 顶层流水线循环：加载/初始化 manifest → 主循环（重读 → findNextPending → 调 stage）→
 * 全部完成打印 complete（AC-1）；任一 stage failed → 停止、返回 ok=false（design §15）。
 *
 * 无状态保证（design §1）：本函数不维护任何跨调用状态——`triedStages` 仅是单次调用
 * 内的循环控制变量（防 research/write 章节失败导致的重入死循环），不落盘、不泄漏。
 *
 * @returns `{ok:true}` 全部 stage done；`{ok:false}` 中途某 stage failed。
 * @throws `--force` 未配合 from/only 时抛带提示的明确错误（避免误重跑全部）。
 */
export async function runPipeline(
  opts: RunPipelineOptions,
): Promise<RunPipelineResult> {
  const { key, source, spawn } = opts;
  const flags = opts.flags ?? {};
  const from = flags.from;
  const only = flags.only;
  // 日志回调：默认 console.log；测试可注入收集器断言 complete 串。
  const log = opts.onLog ?? ((msg: string) => console.log(msg));

  // ---- 1) 加载或初始化 manifest ----
  // 已存在 manifest → resume（从 manifest 读 source，忽略 opts.source）。
  // 否则 → 新建：ensureDir(runDir) + initManifest + saveManifest。
  const mpath = manifestPath(key);
  let m: Manifest;
  if (await pathExists(mpath)) {
    // resume 场景（AC-3）：source 来自磁盘 manifest，不信任 opts.source。
    m = await loadManifest(key);
  } else {
    // 新建场景：opts.source 是必填（manifest 没 source 可读）。
    if (!source) {
      throw new Error(
        `orchestrator: 新建 run 需要提供 source（key=${key}，manifest 不存在）`,
      );
    }
    await ensureDir(runDir(key));
    m = initManifest(key, source);
    await saveManifest(key, m);
  }

  // ---- 2) --force 处理 ----
  // 推荐 force 配合 from/only 之一（task 约定：避免误重跑全部 stage）；
  // 不配合时直接抛错，提示用户加目标。
  if (flags.force) {
    if (!from && !only) {
      throw new Error(
        `orchestrator: --force 需配合 --from <stage> 或 --only <stage> 之一指定目标，` +
          `避免误重跑全部 stage（key=${key}）`,
      );
    }
    m = applyForceReset(m, from, only);
    await saveManifest(key, m);
  }

  // ---- 3) 主循环（无状态：每轮从磁盘 manifest 读真相） ----
  // triedStages：仅本次 runPipeline 调用内有效——防 research/write 单章失败的重入死循环。
  //   单点隔离（design §15）下，stage 级会标 done 但 failed 章节仍会被 findNextPending
  //   下钻命中；若不拦截会无限重入 research()。这里命中即视为「该 stage 已尽力尝试」，
  //   推进到下一 stage（design §15：流水线不因一章失败而阻塞下游）。
  //   `--only` 模式下则直接结束（用户只要这一个 stage）。
  const triedStages = new Set<StageName>();
  // skipFrom：已跳过的 stage 之后的扫描起点；用于「跳过已尝试 stage，推进到下游」。
  let skipFrom: StageName | undefined;

  let safety = MAX_LOOP_TURNS;
  for (;;) {
    if (--safety < 0) {
      // 防御式兜底：正常流程远不会触达；触达说明逻辑 bug，抛错便于诊断。
      throw new Error(
        `orchestrator: 循环超出 ${MAX_LOOP_TURNS} 轮，疑似无限重试（key=${key}）`,
      );
    }

    // 每轮重读磁盘 manifest（stage 已 save，但本地变量也要刷新——无状态保证）。
    m = await loadManifest(key);
    const fromOpt = skipFrom ?? from;
    const next = findNextPending(m, { from: fromOpt, only });

    // 全部 done → 跳出，准备打印 complete。
    if (next === null) break;

    const stageName: StageName = next.stage;

    // 防重入：research/write 章节失败下，findNextPending 仍会返回 chapter 项。
    // 已尝试过的 stage 不再重入（单点隔离语义）。
    if (triedStages.has(stageName)) {
      if (only) {
        // --only 模式：只跑这一个 stage，已尝试过即结束（不推进下游）。
        break;
      }
      // 推进到下一 stage：把扫描起点后移。
      const idx = STAGE_ORDER.indexOf(stageName);
      if (idx + 1 >= STAGE_ORDER.length) break; // 已是最后一个 stage。
      skipFrom = STAGE_ORDER[idx + 1];
      continue;
    }
    triedStages.add(stageName);

    // 构造 StageContext：透传 spawn / model / 并发 / 评审轮数 / skipBuild。
    const ctx: StageContext = {
      key,
      manifest: m,
      spawn,
      model: flags.model,
      concurrency: flags.concurrency ?? DEFAULT_CONCURRENCY,
      reviewRounds: flags.reviewRounds ?? REVIEW_ROUNDS,
      skipBuild: flags.skipBuild,
    };

    // 开始日志。
    log(`[atlas] ${key} ${stageName} 开始`);

    // 调对应 stage 函数（research/write 也走 stage 级，一次处理所有未 done 章）。
    // stage 内部已 saveManifest，并返回更新后的 manifest。
    const newM = await STAGE_FN[stageName](ctx);

    // 失败终止检查（design §15）：stage 终态 failed → 停循环、返回 ok=false。
    // research/write 在单点隔离下 stage 级从不 failed（个别章 failed 由 triedStages
    // 防重入处理）；这里主要拦截 acquire/survey/outline/assemble/build 的 failed。
    if (newM.stages[stageName].status === "failed") {
      log(`[atlas] ${key} ${stageName} failed`);
      log(`[atlas] ${key} halted: ${stageName} failed`);
      return { ok: false, key };
    }

    // 成功（done）日志。
    log(`[atlas] ${key} ${stageName} done`);
  }

  // ---- 全部完成 ----
  // AC-1 / verification.md 第 17 行期望的精确串：`[atlas] run {key} complete.`
  log(`[atlas] run ${key} complete.`);
  return { ok: true, key };
}

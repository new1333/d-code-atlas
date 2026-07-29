// stages/03-outline.ts：Stage 3 · Outline（大纲 + 对抗评审）。
// 对应 design §4 Stage 3（Outline）、§5.2/§5.3（Architect 输出要点 / Critic 验收）、
// §6（对抗评审机制 ADR-0004）、§7（自底向上 ADR-0003：topoOrder 由 stage 调 topoSort 注入）、
// §8.2（outline schema）、§15（错误处理：到上限接受 + accepted-with-warning）。
//
// 流程（Producer⇄Critic 循环，≤ reviewRounds 轮）：
//   for round in 1..reviewRounds:
//     architect(chapters 草稿，可能带上轮 critic 的 fixes 作 feedback)
//       → 失败 → stage failed + return
//     stage 调 topoSort 注入 topoOrder；hasCycle 或 danglingRefs → 硬错误 failed（不走 critic）
//     writeJson(outlinePath, 草稿 outline)（让 critic 能读到）
//     critic(mode=outline)
//       → approve → break，final=approved
//       → reject → 记 trace，下一轮把 fixes 透传给 architect
//   循环结束未 approve → final=accepted-with-warning（接受最后版本，design §6/§15）
//
// CAS 写入纪律（design §9 / 硬约束 #2）：
//   最终 outline.json（含 topoOrder）先 writeJson 落盘 → 再 setStageReview + setStageStatus done + save。
//   每轮中间草稿也落盘（供 critic 读），但状态不置 done——只是临时文件。
//
// topoOrder 注入（硬约束 #3 / design §7）：
//   architect 只产 chapters，不产 topoOrder；stage 调 topoSort(chapters) 计算 order 注入。
//   hasCycle（含自环）/ danglingRefs 都视为 outline 缺陷的硬错误，直接 failed 不走 critic。
//   理由：环 / 悬空引用是「数据结构非法」，critic 的 4 条验收标准①虽含 DAG 无环，
//   但 stage 在落盘前就能确定性判定，没必要浪费一次 critic 调用；且环图无法注入合法 topoOrder。
//
// registerChapters（design §8.3 / M03）：
//   outline done 后，按 topoOrder（权威章节顺序）调 registerChapters，
//   让 manifest.chapters / chapterOrder 就绪供 research/write 下钻。

import { architect } from "../agents/architect.ts";
import { critic } from "../agents/critic.ts";
import { outlinePath, writeJson } from "../lib/io.ts";
import { topoSort } from "../lib/topo.ts";
import {
  setStageStatus,
  setStageReview,
  registerChapters,
  saveManifest,
  nowIso,
  type ReviewSummary,
  type ReviewTrace,
} from "../lib/manifest.ts";
import { REVIEW_ROUNDS } from "../lib/config.ts";
import type { Outline, Chapter } from "../lib/types.ts";
import type { StageContext, StageResult } from "./types.ts";

/**
 * Outline stage：Architect 出大纲 + Critic 对抗评审，落盘 outline.json（含 topoOrder）。
 *
 * @returns 更新后的 manifest（已 saveManifest）。
 *          成功 → stages.outline.status=done（含 review 汇总）；失败 → failed。
 */
export async function outline(ctx: StageContext): Promise<StageResult> {
  const { key, manifest, spawn, model } = ctx;
  const maxRounds = ctx.reviewRounds ?? REVIEW_ROUNDS;
  // 本地源绝对路径：透传给只读 agent 作 --add-dir（cwd 之外的源目录需声明才可读）。
  const sourcePath = manifest.source.kind === "local" ? (manifest.source.localPath ?? manifest.source.ref) : undefined;

  // 标记 running + save（开始标记）。
  let m = setStageStatus(manifest, "outline", "running");
  await saveManifest(key, m);

  const trace: ReviewTrace[] = [];
  let lastChapters: Chapter[] | null = null;
  let lastCmd = "";
  let final: ReviewSummary["final"] = "accepted-with-warning";

  // Producer⇄Critic 循环（≤ maxRounds）。
  // break 出循环表示某轮 critic approve。
  for (let round = 1; round <= maxRounds; round++) {
    // ---- 1) Architect 出草稿 ----
    // 把上一轮 critic 的 fixes 透传给 architect 作 feedback（首轮无 feedback）。
    // 这是 M08 architect 的可选新增参数（非破坏性扩展），让 Producer 据反馈修订。
    const prevFixes = round === 1 ? undefined : trace[trace.length - 1]?.fixes;
    const archOutcome = await architect({ key, model, spawn, feedback: prevFixes, sourcePath });

    if (!archOutcome.ok || archOutcome.chapters === null) {
      // Architect 失败（claude 非零退出 / chapters 解析失败）→ 直接 failed，不走 critic。
      const failed = setStageStatus(m, "outline", "failed", {
        cmd: archOutcome.cmd,
        exitCode: archOutcome.exitCode,
        stderr: archOutcome.stderr,
        ...(archOutcome.chapters === null && archOutcome.ok
          ? { error: "architect 退出码 0 但 chapters JSON 解析为 null（产物不符合契约）" }
          : {}),
      });
      await saveManifest(key, failed);
      return failed;
    }

    lastChapters = archOutcome.chapters;
    lastCmd = archOutcome.cmd;

    // ---- 2) stage 调 topoSort 注入 topoOrder ----
    // 硬约束 #3：topoOrder 由 stage 计算，不由 architect 自填。
    // 多轮修订时每轮都重算（dependsOn 可能变）。
    const topo = topoSort(
      lastChapters.map((c) => ({ slug: c.slug, dependsOn: c.dependsOn })),
    );

    // hasCycle / danglingRefs = 硬错误，直接 failed（不走 critic）。
    // 理由见文件头注释。
    if (topo.hasCycle || topo.danglingRefs.length > 0) {
      const reason = topo.hasCycle
        ? `outline 依赖图有环（无法拓扑排序），remaining=${(topo.remaining ?? []).join(",")}`
        : `outline 存在悬空引用（dependsOn 指向不存在 slug）：${topo.danglingRefs.join(",")}`;
      const failed = setStageStatus(m, "outline", "failed", {
        cmd: `(outline 拓扑校验失败) ${reason}`,
        error: reason,
      });
      await saveManifest(key, failed);
      return failed;
    }

    // ---- 3) 写草稿 outline.json（含 topoOrder），供 critic 读 ----
    // 注意：这是中间草稿，不是最终落盘——但写一份到磁盘让 critic 能读。
    // 即便这是最后一轮（到上限接受），这份 outline 就是最终版（已含正确 topoOrder）。
    const draftOutline: Outline = {
      repo: key,
      generatedAt: nowIso(),
      chapters: lastChapters,
      topoOrder: topo.order,
    };
    await writeJson(outlinePath(key), draftOutline);

    // ---- 4) Critic 评审 ----
    const critOutcome = await critic({ key, mode: "outline", spawn, sourcePath });

    if (!critOutcome.ok || critOutcome.verdict === null) {
      // Critic 自身失败（claude 非 0 退出 / verdict 解析为 null）。
      // 实测 claude headless 对「评审」任务高概率产出 markdown 报告而非契约 JSON，
      // 即便加强 prompt + runClaude validate 多次重试仍可能全部失败（模型倾向问题，非偶发）。
      // 降级策略（design §15 错误处理与降级）：任何轮次 critic 工具异常 → 直接接受当前草稿，
      // final=accepted-with-warning，记录 critic 异常摘要，让流水线继续到 research/write。
      // 理由：architect 产出的章节结构本身健全（拓扑校验已过：无环/无悬空/覆盖完整），
      // critic 只是没给出可解析的 JSON verdict——不该让整个流水线因此卡死，
      // 也不该为概率性失败的重试浪费数十分钟（每轮 architect+critic 各 6 次重试代价过高）。
      trace.push({
        round,
        verdict: "reject",
        fixes: [`(critic 工具异常，降级接受草稿；stdout 摘要: ${critOutcome.stdout.slice(0, 300)})`],
        cmd: critOutcome.cmd,
      });
      final = "accepted-with-warning";
      break;
    }

    // 记 trace（无论 approve/reject）。
    trace.push({
      round,
      verdict: critOutcome.verdict,
      ...(critOutcome.fixes.length > 0 ? { fixes: critOutcome.fixes } : {}),
      cmd: critOutcome.cmd,
    });

    if (critOutcome.verdict === "approve") {
      // 首轮 approve 短路（design §6）。
      final = "approved";
      break;
    }

    // reject：把 fixes 透传给下一轮 architect（循环顶部取 trace 末尾 fixes）。
    // 若已是末轮，循环自然结束 → final 保持 accepted-with-warning。
  }

  // ---- 循环结束：落盘最终 outline + 置 done ----
  // outline.json 已在最后一轮 writeJson 落盘（含正确 topoOrder），CAS 产物已就绪。
  // 这里再写一次确保最终内容与 lastChapters 一致（防末轮 critic reject 后未重写）。
  // 实际上最后一轮的 writeJson 就是最终版，无需重写；但若需绝对保险可再写。
  // 这里信任循环内最后一次 writeJson（草稿==最终，因 chapters 未变）。

  // CAS：产物已落盘 → 现在置 review + done。
  // 1) review 汇总入 manifest（AC-6：trace 可查）。
  m = setStageReview(m, "outline", {
    rounds: trace.length,
    final,
    trace,
  });
  // 2) 置 done。
  m = setStageStatus(m, "outline", "done", { cmd: lastCmd });
  // 3) registerChapters：按 topoOrder 注册章节（权威顺序）。
  //    registerChapters 幂等：resume 时不会重置已 done 章节。
  //    用 outline 的 topoOrder（即最后一轮 architect 产出的拓扑序）。
  const finalOutline: Outline = {
    repo: key,
    generatedAt: nowIso(),
    chapters: lastChapters ?? [],
    topoOrder: lastChapters
      ? topoSort(lastChapters.map((c) => ({ slug: c.slug, dependsOn: c.dependsOn }))).order
      : [],
  };
  m = registerChapters(m, finalOutline.topoOrder);

  await saveManifest(key, m);
  return m;
}

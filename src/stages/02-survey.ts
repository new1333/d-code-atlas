// stages/02-survey.ts：Stage 2 · Survey（仓库结构测绘）。
// 对应 design §4 Stage 2（Survey）、§5.1（Surveyor 输出要点）、§8.1（repo-map schema）、
// ADR-0005（源只读）、§15（失败处理）。
//
// 流程：标记 running → 调 surveyor（readonly，产物从 stdout 提取，不落盘）→
// stage 落盘 repo-map.json（CAS：原子写）→ 置 manifest survey=done + save。
//
// CAS 写入纪律（design §9 / 硬约束 #2）：
//   先 writeJson(repoMapPath, repoMap)（io 已实现 .tmp+rename 原子写），
//   再 setStageStatus done + saveManifest。
//   绝不允许「先置 done 再写产物」——中断会留下 done 但文件不在的脏状态。
//
// 失败处理（design §15）：surveyor ok=false 或 repoMap 解析为 null → manifest failed + save + return。

import { surveyor, type SurveyorSourceKind } from "../agents/surveyor.ts";
import { repoMapPath, writeJson } from "../lib/io.ts";
import { setStageStatus, saveManifest } from "../lib/manifest.ts";
import type { StageContext, StageResult } from "./types.ts";

/**
 * Survey stage：调 Surveyor 测绘仓库结构，落盘 repo-map.json。
 *
 * @returns 更新后的 manifest（已 saveManifest）。
 *          成功 → stages.survey.status=done；失败 → failed。
 */
export async function survey(ctx: StageContext): Promise<StageResult> {
  const { key, manifest, spawn, model } = ctx;
  const source = manifest.source;

  // 标记 running（开始标记，便于续跑诊断「跑到一半挂了」）。
  // running 也 save 一次，使中断后 manifest 反映「这个 stage 启动过但没结束」。
  let m = setStageStatus(manifest, "survey", "running");
  await saveManifest(key, m);

  // 从 manifest.source 推断 surveyor 的 sourceKind / sourcePath。
  // surveyor 的 sourceKind 枚举是 "git" | "local"（语义贴合 Surveyor 视角，
  // 见 agents/surveyor.ts 注释）。url → git（已 clone 到 work/source/）；local → local。
  const sourceKind: SurveyorSourceKind =
    source.kind === "url" ? "git" : "local";
  // git 场景 surveyor 用相对 cwd 的 work/source/（sourcePath 不用）；
  // local 场景用绝对路径 localPath（manifest 已记）。
  const sourcePath = source.kind === "local" ? (source.localPath ?? source.ref) : undefined;

  const outcome = await surveyor({ key, sourceKind, sourcePath, model, spawn });

  // 失败：ok=false 或 repoMap 解析为 null。
  if (!outcome.ok || outcome.repoMap === null) {
    const failed = setStageStatus(m, "survey", "failed", {
      cmd: outcome.cmd,
      // 失败诊断落盘（exitCode/stderr），让 atlas show 能直接看到失败原因，
      // 而非只看到 "survey failed"。repoMap 解析失败时 error 给一句话提示。
      exitCode: outcome.exitCode,
      stderr: outcome.stderr,
      ...(outcome.repoMap === null && outcome.ok
        ? { error: "survey 退出码 0 但 repo-map JSON 解析为 null（产物不符合契约）" }
        : {}),
    });
    await saveManifest(key, failed);
    return failed;
  }

  // CAS：先原子落盘 repo-map.json，再置 done。
  // io.writeJson 内部走 .tmp + rename，杜绝半写文件。
  await writeJson(repoMapPath(key), outcome.repoMap);

  m = setStageStatus(m, "survey", "done", { cmd: outcome.cmd });
  await saveManifest(key, m);
  return m;
}

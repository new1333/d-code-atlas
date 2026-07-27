// stages/01-acquire.ts：Stage 1 · Acquire（取源）。
// 对应 design §4 Stage 1（Acquire）、§10（取源与只读隔离 ADR-0005）、§15（失败处理）。
//
// 本 stage 不调任何 agent（design §4：Acquire 是 Bun 自己干，无 agent）。
// 任务：把 Repository Source 准备好供后续 Surveyor 读取。
//   - url：git clone --depth 1 到 work/source/（cloneSource 负责）。
//   - local：原地只读直读，**不复制**（ADR-0005 / NFR-2 / AC-2：源逐字节不变），
//     只校验路径存在并记录绝对路径。
//
// CAS 写入纪律（design §9 / 硬约束 #2）：
//   源就绪（克隆完成 / 本地路径校验通过）后才置 manifest acquire=done。
//   本 stage 不写额外产物文件——「源就绪」本身就是产物（url 场景的 work/source/，
//   local 场景的 manifest.source.localPath）。因此顺序纪律落地为：
//   先完成 clone / resolve（可能抛错），成功后才 setStageStatus done + saveManifest。
//
// 失败处理（design §15）：clone 失败 / 本地路径不存在 → manifest failed + save + return，
// 不无限重试（交用户 --force 重跑）。

import { cloneSource, resolveLocalSource, sourceDir } from "../lib/io.ts";
import { setStageStatus, saveManifest } from "../lib/manifest.ts";
import type { StageContext, StageResult } from "./types.ts";

/**
 * Acquire stage：准备源（git clone 或本地路径校验）。
 *
 * @returns 更新后的 manifest（已 saveManifest）。
 *          成功 → stages.acquire.status=done；失败 → failed。
 */
export async function acquire(ctx: StageContext): Promise<StageResult> {
  const { key, manifest } = ctx;
  const source = manifest.source;

  let cmd: string;
  try {
    if (source.kind === "url") {
      // URL 场景：浅克隆到 work/source/。
      // cloneSource 负责 ensureDir + 非零退出码抛错；返回 {cmd} 供 manifest 记录。
      const r = await cloneSource(source.ref, sourceDir(key));
      cmd = r.cmd;
    } else {
      // 本地场景：原地只读直读，**不复制**（ADR-0005 / NFR-2 / AC-2）。
      // resolveLocalSource 同步校验存在（路径不存在抛带路径的明确错误）。
      // localPath 在 initManifest 时已可能填了；这里仍校验存在，确保续跑时源没被挪走。
      const target = source.localPath ?? source.ref;
      const r = resolveLocalSource(target);
      cmd = `resolveLocalSource(${r.absPath})`;
    }
  } catch (err) {
    // 失败：置 failed（带 cmd 占位 + stderr 摘要），saveManifest，return。
    // CAS：不置 done。stderr 摘要进 cmd（manifest 无独立 stderr 字段，借 cmd 串诊断）。
    const msg = (err as Error).message ?? String(err);
    const failed = setStageStatus(manifest, "acquire", "failed", {
      cmd: `(acquire 失败) ${msg.slice(-500)}`,
    });
    await saveManifest(key, failed);
    return failed;
  }

  // CAS：源就绪后才置 done。
  const next = setStageStatus(manifest, "acquire", "done", { cmd });
  await saveManifest(key, next);
  return next;
}

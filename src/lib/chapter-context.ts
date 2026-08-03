// lib/chapter-context.ts：章节上下文（供 Writer/Reader 的 user prompt 消费）。
//
// 背景：写/research stage 调 agent 时，agent 不知道「当前章在全书的第几位、前后邻居是谁、
// 前置章讲了什么」。这导致两个高频问题——
//   1) 同一原理（如「先注册半成品 store 再跑 setup」）被相邻多章各完整讲一遍（跨章重复）；
//   2) 章末「后续章节」预告与真实 topoOrder 顺序错位（Writer 凭印象罗列后续章名）。
// 解法：stage 在调 agent 前，用本文件的纯函数算出当前章的「位置 + 前驱/后继/前置章主题」，
// 透传进 agent 的 user prompt，让 Writer/Reader 据此做跨章去重与对齐预告。
//
// 三条硬约束（与 topo.ts 同款）：
//   1) 纯函数、零 IO、零日志、零副作用：stage 已把完整 outline 读进内存，本文件只做内存计算；
//   2) 对未知 slug / 空 chapters 返回 null，不抛——由调用方决定降级策略；
//      但 slug 在 chapters 里、topoOrder 不一致（未收录该 slug）时**不**返回 null——
//      dependsOn 映射仍能产出，只是 position=-1、前后驱置 null（保守降级）。
//   3) 字段语义稳定：position 从 0 起；首章 prevTitle=null；末章 nextTitle=null。

import type { Outline, Chapter } from "./types.ts";

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/**
 * 章节上下文：由 stage 算好，透传给 Writer/Reader 的 user prompt。
 *
 * 设计意图（每个字段对应一条 Writer 行为约束）：
 * - `position` / `total`：让 Writer 知道自己在全书的相对位置（首章/中间/末章）。
 * - `prevTitle` / `nextTitle`：让 Writer 写「章末预告」时只点名紧邻下一章（而非乱列）。
 * - `depTitles` / `depSummaries`：让 Writer 在写「关键权衡」前比对——若某机制已在某前置章
 *   的 summary 里出现，本章只回指、不重演（跨章去重）。
 */
export interface ChapterContext {
  /** 当前 slug 在 topoOrder 中的位置（从 0 起）；未知时为 -1。 */
  position: number;
  /** 全书章数（= topoOrder.length）。 */
  total: number;
  /** 前驱章标题（topoOrder 前一项），首章或位置未知时为 null。 */
  prevTitle: string | null;
  /** 后继章标题（topoOrder 后一项），末章或位置未知时为 null。 */
  nextTitle: string | null;
  /** 本章 dependsOn 指向的章标题列表（按 dependsOn 声明序）。 */
  depTitles: string[];
  /** 本章 dependsOn 各章的 summary（与 depTitles 同序，供 Writer 判断机制是否已被前置章讲透）。 */
  depSummaries: string[];
}

// ---------------------------------------------------------------------------
// 纯函数
// ---------------------------------------------------------------------------

/**
 * 算出指定 slug 在 outline 里的章节上下文。
 *
 * @param outline 已落盘的 outline（含 topoOrder + 全部 chapters）
 * @param slug 当前章 slug
 * @returns 上下文对象；slug 在 outline 内不存在、或 outline 为空时返回 null（调用方降级）
 *
 * 纯内存操作、零 IO。对悬空 dependsOn（指向不存在 slug 的依赖）静默跳过——
 * 这类 outline 缺陷由 outline stage 的拓扑校验兜底，本函数不重复报错。
 */
export function buildChapterContext(outline: Outline, slug: string): ChapterContext | null {
  const order = outline.topoOrder;
  if (outline.chapters.length === 0) return null; // 空 outline：无任何章可参考

  // slug → chapter 的索引（O(n) 建表，outline 规模 8~24 章，无需更复杂结构）。
  const bySlug = new Map<string, Chapter>();
  for (const c of outline.chapters) bySlug.set(c.slug, c);

  const chapter = bySlug.get(slug);
  if (!chapter) return null; // unknown slug：调用方降级（不传 context）

  // 注意：slug 在 chapters 里但不在 topoOrder 里（outline 不一致）时，position=-1、
  // prevTitle/nextTitle=null —— 这是保守降级，因为前后驱只有 topoOrder 才是权威顺序。
  // dependsOn 映射仍照常产出（它来自 chapters，不依赖 topoOrder）。
  const position = order.length > 0 ? order.indexOf(slug) : -1;

  // 前驱/后继标题：只在 topoOrder 命中时计算（命中失败 = outline 不一致，保守置 null）。
  let prevTitle: string | null = null;
  let nextTitle: string | null = null;
  if (position >= 0) {
    if (position > 0) {
      const prev = bySlug.get(order[position - 1]);
      prevTitle = prev ? prev.title : null;
    }
    if (position < order.length - 1) {
      const next = bySlug.get(order[position + 1]);
      nextTitle = next ? next.title : null;
    }
  }

  // dependsOn → titles/summaries：悬空依赖（指向不存在 slug）静默跳过。
  const depTitles: string[] = [];
  const depSummaries: string[] = [];
  for (const dep of chapter.dependsOn) {
    const depCh = bySlug.get(dep);
    if (!depCh) continue;
    depTitles.push(depCh.title);
    depSummaries.push(depCh.summary);
  }

  return {
    position,
    total: order.length,
    prevTitle,
    nextTitle,
    depTitles,
    depSummaries,
  };
}

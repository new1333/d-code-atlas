// test/chapter-context.test.ts：lib/chapter-context.ts 单元测试。
// 覆盖 buildChapterContext 的首章/末章/中间章/unknown slug/空 outline/悬空依赖六种 case。
//
// 零运行时依赖：仅 bun:test。

import { describe, test, expect } from "bun:test";
import { buildChapterContext, type ChapterContext } from "../src/lib/chapter-context.ts";
import type { Outline, Chapter } from "../src/lib/types.ts";

// ---------------------------------------------------------------------------
// 小工具：把「slug 列表 + 依赖表」快捷拍成 Outline。
// ---------------------------------------------------------------------------

/**
 * 构造测试用 outline。
 * @param order topoOrder（同时决定 chapters 的输入序）
 * @param deps 每个 slug 的 dependsOn（默认空数组）；title 用 slug 拼中文、summary 带 slug 标记
 */
const mkOutline = (
  order: string[],
  deps: Record<string, string[]> = {},
): Outline => {
  const chapters: Chapter[] = order.map((slug) => ({
    slug,
    title: `${slug} 章标题`,
    layer: "primitive",
    dependsOn: deps[slug] ?? [],
    sourceFiles: [`src/${slug}.ts`],
    summary: `${slug} 的核心主题：讲透某机制`,
  }));
  return { chapters, topoOrder: order };
};

// ===========================================================================
// buildChapterContext · 位置与前后驱
// ===========================================================================

describe("buildChapterContext · 位置与前后驱", () => {
  test("首章：position=0，prevTitle=null，nextTitle=后一章标题", () => {
    const o = mkOutline(["a", "b", "c"]);
    const ctx = buildChapterContext(o, "a");
    expect(ctx).not.toBeNull();
    expect(ctx!.position).toBe(0);
    expect(ctx!.total).toBe(3);
    expect(ctx!.prevTitle).toBeNull();
    expect(ctx!.nextTitle).toBe("b 章标题");
  });

  test("末章：position=末位，nextTitle=null，prevTitle=前一章标题", () => {
    const o = mkOutline(["a", "b", "c"]);
    const ctx = buildChapterContext(o, "c");
    expect(ctx).not.toBeNull();
    expect(ctx!.position).toBe(2);
    expect(ctx!.total).toBe(3);
    expect(ctx!.prevTitle).toBe("b 章标题");
    expect(ctx!.nextTitle).toBeNull();
  });

  test("中间章：同时有 prevTitle 和 nextTitle", () => {
    const o = mkOutline(["a", "b", "c"]);
    const ctx = buildChapterContext(o, "b");
    expect(ctx!.position).toBe(1);
    expect(ctx!.prevTitle).toBe("a 章标题");
    expect(ctx!.nextTitle).toBe("c 章标题");
  });

  test("单章 outline：既首又末，prevTitle/nextTitle 都为 null", () => {
    const o = mkOutline(["solo"]);
    const ctx = buildChapterContext(o, "solo");
    expect(ctx!.position).toBe(0);
    expect(ctx!.total).toBe(1);
    expect(ctx!.prevTitle).toBeNull();
    expect(ctx!.nextTitle).toBeNull();
  });
});

// ===========================================================================
// buildChapterContext · dependsOn 映射
// ===========================================================================

describe("buildChapterContext · dependsOn 映射", () => {
  test("有依赖：depTitles/depSummaries 按 dependsOn 声明序，内容对齐", () => {
    const o = mkOutline(["a", "b", "c"], { c: ["a", "b"] });
    const ctx = buildChapterContext(o, "c");
    expect(ctx!.depTitles).toEqual(["a 章标题", "b 章标题"]);
    expect(ctx!.depSummaries).toEqual([
      "a 的核心主题：讲透某机制",
      "b 的核心主题：讲透某机制",
    ]);
  });

  test("无依赖：depTitles/depSummaries 都是空数组", () => {
    const o = mkOutline(["a", "b"]);
    const ctx = buildChapterContext(o, "a");
    expect(ctx!.depTitles).toEqual([]);
    expect(ctx!.depSummaries).toEqual([]);
  });

  test("悬空依赖（dependsOn 指向不存在 slug）：静默跳过，不报错不抛", () => {
    const o = mkOutline(["a", "b"], { b: ["a", "ghost"] });
    const ctx = buildChapterContext(o, "b");
    // ghost 不在 chapters 里，被跳过；只保留 a。
    expect(ctx!.depTitles).toEqual(["a 章标题"]);
    expect(ctx!.depSummaries).toEqual(["a 的核心主题：讲透某机制"]);
  });

  test("全部依赖都悬空：depTitles/depSummaries 为空，函数仍返回非 null", () => {
    const o = mkOutline(["a"], { a: ["x", "y"] });
    const ctx = buildChapterContext(o, "a");
    expect(ctx).not.toBeNull();
    expect(ctx!.depTitles).toEqual([]);
    expect(ctx!.depSummaries).toEqual([]);
  });
});

// ===========================================================================
// buildChapterContext · 边界与健壮性
// ===========================================================================

describe("buildChapterContext · 边界与健壮性", () => {
  test("unknown slug（不在 chapters 里）：返回 null，不抛", () => {
    const o = mkOutline(["a", "b"]);
    expect(buildChapterContext(o, "zzz")).toBeNull();
  });

  test("空 outline（topoOrder 空 + chapters 空）：返回 null，不抛", () => {
    const o: Outline = { chapters: [], topoOrder: [] };
    expect(buildChapterContext(o, "a")).toBeNull();
  });

  test("slug 在 chapters 里但不在 topoOrder 里：position=-1，prevTitle/nextTitle 都为 null", () => {
    // 边缘情况：outline 不一致（chapters 与 topoOrder 脱节）。保守降级，不猜前后驱。
    const o: Outline = {
      chapters: [
        {
          slug: "a",
          title: "a 章标题",
          layer: "primitive",
          dependsOn: [],
          sourceFiles: [],
          summary: "a",
        },
      ],
      topoOrder: [], // topoOrder 没收录 a
    };
    const ctx = buildChapterContext(o, "a");
    expect(ctx).not.toBeNull();
    expect(ctx!.position).toBe(-1);
    expect(ctx!.prevTitle).toBeNull();
    expect(ctx!.nextTitle).toBeNull();
    expect(ctx!.total).toBe(0);
  });

  test("返回对象结构完整：所有 ChapterContext 字段齐全", () => {
    const o = mkOutline(["a", "b"], { b: ["a"] });
    const ctx = buildChapterContext(o, "b");
    // 用 toEqual 严格校验结构（而非 toMatchObject），保证未来加字段时测试会提醒更新。
    const expected: ChapterContext = {
      position: 1,
      total: 2,
      prevTitle: "a 章标题",
      nextTitle: null,
      depTitles: ["a 章标题"],
      depSummaries: ["a 的核心主题：讲透某机制"],
    };
    expect(ctx).toEqual(expected);
  });
});

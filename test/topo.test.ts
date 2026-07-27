import { test, expect, describe } from "bun:test";
import { topoSort, verifyClosure, type ChapterDeps } from "../src/lib/topo.ts";

describe("topoSort", () => {
  test("empty input → empty order, no cycle", () => {
    expect(topoSort([])).toEqual({
      order: [],
      hasCycle: false,
      cycleNodes: [],
      danglingRefs: [],
    });
  });

  test("independent chapters preserve input order", () => {
    const ch: ChapterDeps[] = [
      { slug: "a", dependsOn: [] },
      { slug: "b", dependsOn: [] },
      { slug: "c", dependsOn: [] },
    ];
    const r = topoSort(ch);
    expect(r.hasCycle).toBe(false);
    expect(r.order).toEqual(["a", "b", "c"]);
  });

  test("linear chain a→b→c orders prerequisites first", () => {
    const ch: ChapterDeps[] = [
      { slug: "c", dependsOn: ["b"] },
      { slug: "b", dependsOn: ["a"] },
      { slug: "a", dependsOn: [] },
    ];
    const r = topoSort(ch);
    expect(r.order).toEqual(["a", "b", "c"]);
    expect(r.hasCycle).toBe(false);
  });

  test("diamond: a → {b,c} → d", () => {
    const ch: ChapterDeps[] = [
      { slug: "d", dependsOn: ["b", "c"] },
      { slug: "b", dependsOn: ["a"] },
      { slug: "c", dependsOn: ["a"] },
      { slug: "a", dependsOn: [] },
    ];
    const r = topoSort(ch);
    expect(r.hasCycle).toBe(false);
    expect(r.order[0]).toBe("a");
    expect(r.order[3]).toBe("d");
    expect(new Set(r.order.slice(1, 3))).toEqual(new Set(["b", "c"]));
  });

  test("self-loop detected as cycle", () => {
    const ch: ChapterDeps[] = [{ slug: "a", dependsOn: ["a"] }];
    const r = topoSort(ch);
    expect(r.hasCycle).toBe(true);
    expect(r.cycleNodes).toContain("a");
    expect(r.order).not.toContain("a");
  });

  test("two-node cycle a↔b", () => {
    const ch: ChapterDeps[] = [
      { slug: "a", dependsOn: ["b"] },
      { slug: "b", dependsOn: ["a"] },
    ];
    const r = topoSort(ch);
    expect(r.hasCycle).toBe(true);
    expect(r.cycleNodes.sort()).toEqual(["a", "b"]);
  });

  test("cycle + acyclic nodes: only cyclic ones flagged", () => {
    const ch: ChapterDeps[] = [
      { slug: "free", dependsOn: [] },
      { slug: "a", dependsOn: ["b"] },
      { slug: "b", dependsOn: ["a"] },
    ];
    const r = topoSort(ch);
    expect(r.hasCycle).toBe(true);
    expect(r.order).toContain("free");
    expect(r.cycleNodes.sort()).toEqual(["a", "b"]);
  });

  test("dangling ref (dependsOn unknown slug) is reported but not fatal", () => {
    const ch: ChapterDeps[] = [
      { slug: "a", dependsOn: ["ghost"] },
      { slug: "b", dependsOn: ["a"] },
    ];
    const r = topoSort(ch);
    expect(r.hasCycle).toBe(false);
    expect(r.danglingRefs).toEqual(["ghost"]);
    expect(r.order).toEqual(["a", "b"]);
  });

  test("deterministic: identical input → identical output", () => {
    const ch: ChapterDeps[] = [
      { slug: "z", dependsOn: ["y"] },
      { slug: "y", dependsOn: ["x"] },
      { slug: "x", dependsOn: [] },
    ];
    const r1 = topoSort(ch);
    const r2 = topoSort(ch);
    expect(r1.order).toEqual(r2.order);
  });
});

describe("verifyClosure", () => {
  test("valid order passes", () => {
    const ch: ChapterDeps[] = [
      { slug: "a", dependsOn: [] },
      { slug: "b", dependsOn: ["a"] },
    ];
    expect(verifyClosure(["a", "b"], ch).ok).toBe(true);
  });

  test("dependency appearing AFTER dependent is a violation", () => {
    const ch: ChapterDeps[] = [
      { slug: "a", dependsOn: [] },
      { slug: "b", dependsOn: ["a"] },
    ];
    const v = verifyClosure(["b", "a"], ch);
    expect(v.ok).toBe(false);
    expect(v.violations).toEqual([{ slug: "b", unmet: ["a"] }]);
  });

  test("missing slug from order is flagged", () => {
    const ch: ChapterDeps[] = [
      { slug: "a", dependsOn: [] },
      { slug: "b", dependsOn: ["a"] },
    ];
    const v = verifyClosure(["a"], ch);
    expect(v.ok).toBe(false);
    expect(v.violations.find((x) => x.slug === "b")).toBeTruthy();
  });
});

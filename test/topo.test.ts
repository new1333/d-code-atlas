// test/topo.test.ts：lib/topo.ts 单元测试（task-06）。
// 用 bun:test。AC-4 的算法核验基础：覆盖 topoSort 的 ok / cycle / dangling 三态、
// verifyClosure 的 ok / violation 二态，以及稳定性、传递闭包、边界与健壮性。
//
// 零运行时依赖：仅 bun:test。

import { describe, test, expect } from "bun:test";
import {
  topoSort,
  verifyClosure,
  closureOf,
  type TopoNode,
} from "../src/lib/topo.ts";

// ---------------------------------------------------------------------------
// 小工具：把「slug 列表 + 依赖表」快捷拍成 TopoNode[]，用声明序作输入序（测稳定性时关键）。
// ---------------------------------------------------------------------------

/** 按给定 slug 顺序构建 nodes，deps 表里没有的 slug 视为无依赖。 */
const mk = (slugs: string[], deps: Record<string, string[]> = {}): TopoNode[] =>
  slugs.map((s) => ({ slug: s, dependsOn: deps[s] ?? [] }));

// ===========================================================================
// topoSort · 无环正常序
// ===========================================================================

describe("topoSort · 无环正常序", () => {
  test("A→B→C：order=[A,B,C]，hasCycle=false，dangling=[]", () => {
    const nodes = mk(["A", "B", "C"], { B: ["A"], C: ["A", "B"] });
    const r = topoSort(nodes);
    expect(r.order).toEqual(["A", "B", "C"]);
    expect(r.hasCycle).toBe(false);
    expect(r.danglingRefs).toEqual([]);
    // 无环时不返回 remaining（或为空）。
    expect(r.remaining ?? []).toEqual([]);
  });

  test("顺序断言精确：A 必须在 B 前、B 在 C 前（用 indexOf 比位置）", () => {
    const nodes = mk(["A", "B", "C"], { B: ["A"], C: ["A", "B"] });
    const r = topoSort(nodes);
    const pos = (s: string) => r.order.indexOf(s);
    expect(pos("A")).toBeLessThan(pos("B"));
    expect(pos("B")).toBeLessThan(pos("C"));
  });

  test("无依赖的孤立节点也能排进 order", () => {
    const nodes = mk(["X", "Y"]); // 互不依赖
    const r = topoSort(nodes);
    expect(r.order.sort()).toEqual(["X", "Y"]);
    expect(r.hasCycle).toBe(false);
  });
});

// ===========================================================================
// topoSort · 闭包满足（topoSort 的输出天然满足自底向上）
// ===========================================================================

describe("topoSort · 输出天然满足闭包", () => {
  test("A→B→C：topoSort 的 order 喂回 verifyClosure → ok=true", () => {
    const nodes = mk(["A", "B", "C"], { B: ["A"], C: ["A", "B"] });
    const r = topoSort(nodes);
    expect(verifyClosure(r.order, nodes).ok).toBe(true);
  });
});

// ===========================================================================
// topoSort · 有环
// ===========================================================================

describe("topoSort · 有环", () => {
  test("A↔B 互相依赖 → hasCycle=true", () => {
    const nodes = mk(["A", "B"], { A: ["B"], B: ["A"] });
    const r = topoSort(nodes);
    expect(r.hasCycle).toBe(true);
    // 有环时 order 含已排部分（可能为空，因为两节点入度都不为 0）。
    expect(r.remaining ?? []).toContain("A");
    expect(r.remaining ?? []).toContain("B");
  });

  test("三元环 A→B→C→A → hasCycle=true，remaining 含三者", () => {
    const nodes = mk(["A", "B", "C"], { A: ["C"], B: ["A"], C: ["B"] });
    const r = topoSort(nodes);
    expect(r.hasCycle).toBe(true);
    expect(r.remaining!.sort()).toEqual(["A", "B", "C"]);
    expect(r.order).toEqual([]); // 无入度为 0 的起点，全卡住
  });

  test("环外节点仍能正常排序（部分图有环）", () => {
    // D 无依赖、A↔B 互依赖；D 应能出队，A、B 卡住。
    const nodes = mk(["D", "A", "B"], { A: ["B"], B: ["A"] });
    const r = topoSort(nodes);
    expect(r.hasCycle).toBe(true);
    expect(r.order).toEqual(["D"]); // 环外节点先出队
    expect(r.remaining!.sort()).toEqual(["A", "B"]);
  });
});

// ===========================================================================
// topoSort · 自环
// ===========================================================================

describe("topoSort · 自环", () => {
  test("A dependsOn [A] → hasCycle=true（自环视为环）", () => {
    const nodes = mk(["A"], { A: ["A"] });
    const r = topoSort(nodes);
    expect(r.hasCycle).toBe(true);
    expect(r.order).toEqual([]); // A 入度为 1，无法出队
    expect(r.remaining).toEqual(["A"]);
  });

  test("自环节点 + 正常节点：正常节点出队，自环节点进 remaining", () => {
    const nodes = mk(["A", "B"], { A: ["A"] }); // B 无依赖
    const r = topoSort(nodes);
    expect(r.hasCycle).toBe(true);
    expect(r.order).toEqual(["B"]);
    expect(r.remaining).toEqual(["A"]);
  });
});

// ===========================================================================
// topoSort · 悬空引用（≠ 环）
// ===========================================================================

describe("topoSort · 悬空引用", () => {
  test("B dependsOn [X]（X 不存在）→ danglingRefs 含 X，hasCycle=false", () => {
    const nodes = mk(["B"], { B: ["X"] });
    const r = topoSort(nodes);
    expect(r.danglingRefs).toContain("X");
    expect(r.hasCycle).toBe(false); // 悬空不等于环
    expect(r.order).toEqual(["B"]); // 悬空引用不阻塞排序，B 仍出队
  });

  test("悬空引用去重：多节点引用同一不存在的 X → danglingRefs 只出现一次", () => {
    const nodes = mk(["A", "B"], { A: ["X"], B: ["X"] });
    const r = topoSort(nodes);
    expect(r.danglingRefs.filter((s) => s === "X")).toHaveLength(1);
    expect(r.danglingRefs).toEqual(["X"]);
  });

  test("多个不同悬空引用 → 排序后返回（稳定）", () => {
    const nodes = mk(["A"], { A: ["Zeta", "Alpha", "Mu"] });
    const r = topoSort(nodes);
    expect(r.danglingRefs).toEqual(["Alpha", "Mu", "Zeta"]); // 排序后
  });

  test("悬空引用 + 真实依赖混合：真实依赖正常工作，悬空进 dangling", () => {
    // C dependsOn [A, X]：A 真实，X 悬空 → C 应在 A 后出队，X 进 dangling。
    const nodes = mk(["A", "C"], { C: ["A", "X"] });
    const r = topoSort(nodes);
    expect(r.order).toEqual(["A", "C"]);
    expect(r.hasCycle).toBe(false);
    expect(r.danglingRefs).toEqual(["X"]);
  });

  test("悬空引用不影响稳定性（同入度仍按声明序）", () => {
    // A、B 都依赖悬空 X（X 不存在）→ 两者入度皆为 0，按声明序出队。
    const nodes = mk(["A", "B"], { A: ["X"], B: ["X"] });
    const r = topoSort(nodes);
    expect(r.order).toEqual(["A", "B"]);
  });
});

// ===========================================================================
// topoSort · 稳定性（同入度按输入声明序，非字典序）
// ===========================================================================

describe("topoSort · 同入度稳定性", () => {
  test("A,B,C 都无依赖、入度皆 0 → order 前缀按声明序 [A,B,C]", () => {
    // 故意让字典序与声明序不同（用小写打头）：声明序 [c, a, b]。
    const nodes = mk(["c", "a", "b"]);
    const r = topoSort(nodes);
    expect(r.order).toEqual(["c", "a", "b"]); // 声明序，不是字典序 [a,b,c]
  });

  test("同层无关项保持声明序（A,B 无依赖；C dependsOn []，三者入度皆 0）", () => {
    const nodes = mk(["A", "B", "C"]);
    const r = topoSort(nodes);
    expect(r.order).toEqual(["A", "B", "C"]);
  });

  test("新解锁的节点也按原始声明序优先（多个节点同轮解锁）", () => {
    // P1,P2 无依赖；K1 dependsOn [P1,P2]，K2 dependsOn [P1,P2]。
    // P1,P2 出队后 K1,K2 同时入度归零；K1 声明在前 → 先出队。
    const nodes = mk(["P1", "P2", "K2", "K1"], { K1: ["P1", "P2"], K2: ["P1", "P2"] });
    // 故意把 K2 写在 K1 前，但要看声明序：K2 在 K1 前 → K2 先出。
    const r = topoSort(nodes);
    expect(r.order).toEqual(["P1", "P2", "K2", "K1"]);
  });
});

// ===========================================================================
// topoSort · 多层 DAG（primitive/composite/system 跨层）
// ===========================================================================

describe("topoSort · 多层 DAG", () => {
  test("P1,P2 无依赖；K1 dependsOn [P1,P2]；S1 dependsOn [K1,P2]：依赖全在前", () => {
    const nodes = mk(["P1", "P2", "K1", "S1"], {
      K1: ["P1", "P2"],
      S1: ["K1", "P2"],
    });
    const r = topoSort(nodes);
    expect(r.hasCycle).toBe(false);
    expect(r.danglingRefs).toEqual([]);
    // 位置断言：P1/P2 在 K1 前；K1 在 S1 前；P2 在 S1 前。
    const pos = (s: string) => r.order.indexOf(s);
    expect(pos("P1")).toBeLessThan(pos("K1"));
    expect(pos("P2")).toBeLessThan(pos("K1"));
    expect(pos("K1")).toBeLessThan(pos("S1"));
    expect(pos("P2")).toBeLessThan(pos("S1"));
    // 闭包满足
    expect(verifyClosure(r.order, nodes).ok).toBe(true);
  });

  test("更深的菱形依赖：A←B, A←C, B←D, C←D → D 必在最前", () => {
    const nodes = mk(["A", "B", "C", "D"], {
      B: ["A"],
      C: ["A"],
      D: ["B", "C"],
    });
    const r = topoSort(nodes);
    const pos = (s: string) => r.order.indexOf(s);
    expect(pos("A")).toBeLessThan(pos("B"));
    expect(pos("A")).toBeLessThan(pos("C"));
    expect(pos("B")).toBeLessThan(pos("D"));
    expect(pos("C")).toBeLessThan(pos("D"));
    expect(verifyClosure(r.order, nodes).ok).toBe(true);
  });
});

// ===========================================================================
// topoSort · 边界
// ===========================================================================

describe("topoSort · 边界", () => {
  test("空输入 → {order:[],hasCycle:false,danglingRefs:[]}", () => {
    const r = topoSort([]);
    expect(r).toEqual({ order: [], hasCycle: false, danglingRefs: [] });
  });

  test("单节点无依赖 → order=[该slug]，hasCycle=false", () => {
    const r = topoSort(mk(["solo"]));
    expect(r).toEqual({ order: ["solo"], hasCycle: false, danglingRefs: [] });
  });
});

// ===========================================================================
// verifyClosure · 满足
// ===========================================================================

describe("verifyClosure · 满足", () => {
  test("A→B→C 给 order=[A,B,C] → ok=true", () => {
    const nodes = mk(["A", "B", "C"], { B: ["A"], C: ["A", "B"] });
    expect(verifyClosure(["A", "B", "C"], nodes)).toEqual({ ok: true, violations: [] });
  });

  test("空 order + 空 nodes → ok=true", () => {
    expect(verifyClosure([], [])).toEqual({ ok: true, violations: [] });
  });
});

// ===========================================================================
// verifyClosure · 违反（故意错排）
// ===========================================================================

describe("verifyClosure · 违反", () => {
  test("故意错排：B dependsOn A，给 order=[B,A] → B 违反，missing=[A]", () => {
    const nodes = mk(["A", "B"], { B: ["A"] });
    const r = verifyClosure(["B", "A"], nodes);
    expect(r.ok).toBe(false);
    expect(r.violations).toContainEqual({ slug: "B", missing: ["A"] });
  });

  test("闭包传递：A←B←C，给 order=[C,A,B] → C 违反，missing 含 A,B", () => {
    // C dependsOn B，B dependsOn A → C 的闭包 = {A, B}；order=[C,A,B] 把 C 排最前 → A、B 都在它后面。
    const nodes = mk(["A", "B", "C"], { B: ["A"], C: ["B"] });
    const r = verifyClosure(["C", "A", "B"], nodes);
    expect(r.ok).toBe(false);
    const cViolation = r.violations.find((v) => v.slug === "C");
    expect(cViolation).toBeDefined();
    expect(cViolation!.missing.sort()).toEqual(["A", "B"]);
  });

  test("依赖项根本不在 order 中 → 计入 missing", () => {
    // B dependsOn A，但 order 只给 [B]（漏了 A）。
    const nodes = mk(["A", "B"], { B: ["A"] });
    const r = verifyClosure(["B"], nodes);
    expect(r.ok).toBe(false);
    expect(r.violations.find((v) => v.slug === "B")!.missing).toEqual(["A"]);
  });

  test("被校验节点本身不在 order → 跳过它（不报 violation）", () => {
    const nodes = mk(["A", "B"], { B: ["A"] });
    // order 缺 B：B 无法定位，跳过；A 无依赖不违反。
    const r = verifyClosure(["A"], nodes);
    expect(r.ok).toBe(true);
  });

  test("同一错误 order 多个节点违反 → 各自一条 violation", () => {
    // 反序 order=[C,B,A]，A←B←C：B、C 都违反（A 不违反）。
    const nodes = mk(["A", "B", "C"], { B: ["A"], C: ["B"] });
    const r = verifyClosure(["C", "B", "A"], nodes);
    expect(r.ok).toBe(false);
    const slugs = r.violations.map((v) => v.slug).sort();
    expect(slugs).toEqual(["B", "C"]);
  });

  test("violations 的 missing 排序稳定（不依赖闭包遍历序）", () => {
    // C 依赖 [Z, A]（Z 排在 A 前声明，但 missing 应排序成 [A, Z]）。
    const nodes = mk(["A", "Z", "C"], { C: ["A", "Z"] });
    const r = verifyClosure(["C", "A", "Z"], nodes);
    expect(r.violations.find((v) => v.slug === "C")!.missing).toEqual(["A", "Z"]);
  });
});

// ===========================================================================
// closureOf · 传递闭包（可选导出的单测）
// ===========================================================================

describe("closureOf · 传递闭包", () => {
  test("A←B←C：C 的闭包 = {A, B}（含传递依赖）", () => {
    const nodes = mk(["A", "B", "C"], { B: ["A"], C: ["B"] });
    expect(closureOf("C", nodes)).toEqual(new Set(["A", "B"]));
  });

  test("闭包不含自己（无自环）", () => {
    const nodes = mk(["A", "B"], { B: ["A"] });
    expect(closureOf("A", nodes).has("A")).toBe(false);
  });

  test("自环不把自己加进闭包", () => {
    const nodes = mk(["A"], { A: ["A"] });
    expect(closureOf("A", nodes)).toEqual(new Set());
  });

  test("依赖图有环不死循环（防环）", () => {
    // A↔B 互依赖；从 A 出发闭包 = {B}（A 自己被排除，B 已 visited 不再展开）。
    const nodes = mk(["A", "B"], { A: ["B"], B: ["A"] });
    expect(closureOf("A", nodes)).toEqual(new Set(["B"]));
  });

  test("菱形依赖闭包正确", () => {
    // A←B, A←C, B←D, C←D → D 的闭包 = {A, B, C}
    const nodes = mk(["A", "B", "C", "D"], { B: ["A"], C: ["A"], D: ["B", "C"] });
    expect(closureOf("D", nodes)).toEqual(new Set(["A", "B", "C"]));
  });

  test("悬空依赖进入闭包（用于 verifyClosure 报告 missing）", () => {
    // B dependsOn [A, X]（X 悬空）→ B 的闭包 = {A, X}
    const nodes = mk(["A", "B"], { B: ["A", "X"] });
    expect(closureOf("B", nodes)).toEqual(new Set(["A", "X"]));
  });

  test("不存在的 slug 起点 → 空集", () => {
    expect(closureOf("ghost", mk(["A", "B"]))).toEqual(new Set());
  });
});

// ===========================================================================
// 端到端：topoSort 输出喂 verifyClosure 始终 ok（除非有悬空导致 order 仍合法）
// ===========================================================================

describe("端到端 · topoSort → verifyClosure 一致性", () => {
  test("无环图：topoSort 输出恒满足 verifyClosure", () => {
    const nodes = mk(["P1", "P2", "K1", "S1", "S2"], {
      K1: ["P1", "P2"],
      S1: ["K1", "P2"],
      S2: ["K1", "S1"],
    });
    const r = topoSort(nodes);
    expect(r.hasCycle).toBe(false);
    expect(verifyClosure(r.order, nodes).ok).toBe(true);
  });

  test("有环图：topoSort 标 hasCycle，不喂 verifyClosure（order 不完整）", () => {
    const nodes = mk(["A", "B", "C"], { A: ["B"], B: ["C"], C: ["A"] });
    const r = topoSort(nodes);
    expect(r.hasCycle).toBe(true);
    expect(r.order).toEqual([]); // 全卡住
  });
});

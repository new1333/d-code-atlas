// test/pool.test.ts：lib/pool.ts 单元测试。
// 用 bun:test，全异步；用 setTimeout 制造不同延迟，打乱"完成顺序"以验证"按原序回填"。
//
// 核心断言锚点（design §3 / §15 + AC）：
//   1) 结果顺序与 items 一致（哪怕靠后 item 先 resolve）；
//   2) 并发峰值 ≤ concurrency（用原子计数器 peak 观测，items 数必须 > concurrency 才能触发峰值）；
//   3) 单个 fn reject 只污染自己那一格，其余 ok 且值正确（单点失败隔离）；
//   4) 空数组、concurrency < 1 兜底、流式 eachPool 等边界。
// 零运行时依赖：仅 bun:test + Promise + setTimeout（浏览器/Node/Bun 都有）。

import { describe, test, expect } from "bun:test";
import { mapPool, eachPool, type PoolResult } from "../src/lib/pool.ts";

// ---------------------------------------------------------------------------
// 小工具：基于 setTimeout 的延迟（用于打乱完成顺序，无运行时依赖）
// ---------------------------------------------------------------------------

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// mapPool
// ---------------------------------------------------------------------------

describe("mapPool · 顺序正确", () => {
  test("靠后 item 先 resolve，结果仍按 items 原序回填", async () => {
    // 让靠后的 index 延迟更短 → 先完成；前面的 index 延迟更长 → 后完成。
    // 若实现"按完成顺序回填"，结果会是反序；正确实现应保持 [a,b,c,d]。
    const items = ["a", "b", "c", "d"];
    const results = await mapPool(
      items,
      async (s, i) => {
        await delay(40 - i * 10); // i=0 等 40ms，i=3 等 10ms
        return s.toUpperCase();
      },
      4, // 并发足够大，让所有 item 同时进入，确保完成顺序真被延迟打乱
    );
    expect(results.map((r) => (r.ok ? r.value : null))).toEqual(["A", "B", "C", "D"]);
  });
});

describe("mapPool · 并发上限不超", () => {
  test("concurrency=1：串行执行，峰值恒为 1", async () => {
    let active = 0;
    let peak = 0;
    // items 数必须 > concurrency（这里 4 > 1）才能观测到峰值。
    await mapPool(
      [1, 2, 3, 4],
      async (x) => {
        active++;
        peak = Math.max(peak, active);
        await delay(5 + Math.random() * 10);
        active--;
        return x;
      },
      1,
    );
    expect(peak).toBe(1);
  });

  test("concurrency=2：峰值 ≤ 2", async () => {
    let active = 0;
    let peak = 0;
    await mapPool(
      [1, 2, 3, 4, 5, 6],
      async (x) => {
        active++;
        peak = Math.max(peak, active);
        await delay(5 + Math.random() * 15);
        active--;
        return x;
      },
      2,
    );
    expect(peak).toBeLessThanOrEqual(2);
    expect(peak).toBeGreaterThanOrEqual(1);
  });

  test("concurrency=4：峰值 ≤ 4（items 数 > 4 才能逼近上限）", async () => {
    let active = 0;
    let peak = 0;
    await mapPool(
      [1, 2, 3, 4, 5, 6, 7, 8],
      async (x) => {
        active++;
        peak = Math.max(peak, active);
        await delay(5 + Math.random() * 15);
        active--;
        return x;
      },
      4,
    );
    expect(peak).toBeLessThanOrEqual(4);
  });
});

describe("mapPool · 单点 reject 不影响其它", () => {
  test("第 i 个 reject → 该格 ok:false，其余 ok 且值正确", async () => {
    const results = await mapPool(
      [10, 20, 30, 40],
      async (x, i) => {
        await delay(5);
        if (i === 2) throw new Error("boom@2");
        return x * 2;
      },
      4,
    );
    expect(results.length).toBe(4);
    expect(results[0]).toEqual({ ok: true, value: 20 });
    expect(results[1]).toEqual({ ok: true, value: 40 });
    expect(results[2].ok).toBe(false);
    if (!results[2].ok) {
      expect((results[2].error as Error).message).toBe("boom@2");
    }
    expect(results[3]).toEqual({ ok: true, value: 80 });
  });

  test("多个 item 同时 reject 仍各自隔离、不炸全池", async () => {
    const results = await mapPool(
      [1, 2, 3, 4],
      async (x, i) => {
        await delay(2);
        if (i % 2 === 0) throw new Error(`even@${i}`);
        return x;
      },
      2,
    );
    expect(results.map((r) => r.ok)).toEqual([false, true, false, true]);
  });
});

describe("mapPool · 边界", () => {
  test("空数组 → 立即返回 []，不调用 fn", async () => {
    let called = 0;
    const r = await mapPool([], async () => {
      called++;
      return 0;
    }, 4);
    expect(r).toEqual([]);
    expect(called).toBe(0);
  });

  test("concurrency=0 → 按 1 兜底，不卡死、峰值 ≤ 1", async () => {
    let active = 0;
    let peak = 0;
    const r = await mapPool(
      [1, 2, 3],
      async (x) => {
        active++;
        peak = Math.max(peak, active);
        await delay(3);
        active--;
        return x;
      },
      0,
    );
    expect(peak).toBe(1);
    expect(r.map((x) => (x.ok ? x.value : null))).toEqual([1, 2, 3]);
  });

  test("负数 concurrency → 同样按 1 兜底", async () => {
    let active = 0;
    let peak = 0;
    const r = await mapPool(
      [1, 2],
      async (x) => {
        active++;
        peak = Math.max(peak, active);
        await delay(3);
        active--;
        return x;
      },
      -5,
    );
    expect(peak).toBe(1);
    expect(r.map((x) => (x.ok ? x.value : null))).toEqual([1, 2]);
  });

  test("concurrency > items.length：worker 数被夹到 items.length，仍正常返回", async () => {
    const r = await mapPool([1, 2], async (x) => x + 1, 100);
    expect(r.map((x) => (x.ok ? x.value : null))).toEqual([2, 3]);
  });

  test("默认 concurrency（不传第三参）= DEFAULT_CONCURRENCY（4）", async () => {
    let active = 0;
    let peak = 0;
    // 给 8 个 item，确保能逼近默认上限 4
    await mapPool(Array.from({ length: 8 }, (_, i) => i), async () => {
      active++;
      peak = Math.max(peak, active);
      await delay(5);
      active--;
    });
    expect(peak).toBeLessThanOrEqual(4);
  });
});

describe("mapPool · 值传递正确", () => {
  test("对象 / 含中文串深相等", async () => {
    const items = [{ n: 1 }, { n: 2 }, { s: "中文串测试" }, { nested: { a: [1, 2, 3] } }];
    const r = await mapPool(items, async (x) => ({ ...x, _tag: "ok" }), 2);
    expect(r.map((x) => (x.ok ? x.value : null))).toEqual([
      { n: 1, _tag: "ok" },
      { n: 2, _tag: "ok" },
      { s: "中文串测试", _tag: "ok" },
      { nested: { a: [1, 2, 3] }, _tag: "ok" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// eachPool
// ---------------------------------------------------------------------------

describe("eachPool · 流式回调", () => {
  test("onSettle 调用次数 == items.length，且每个 index 恰好覆盖一次", async () => {
    const items = [1, 2, 3, 4, 5];
    const seen = new Map<number, PoolResult<number>>();
    const r = await eachPool(
      items,
      async (x) => {
        await delay(5);
        return x * 10;
      },
      2,
      (index, result) => {
        // 同一个 index 不应被回调两次
        expect(seen.has(index)).toBe(false);
        seen.set(index, result);
      },
    );
    expect(seen.size).toBe(5);
    expect([...seen.keys()].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4]);
    // 最终数组与 mapPool 等价（按原序）
    expect(r.map((x) => (x.ok ? x.value : null))).toEqual([10, 20, 30, 40, 50]);
  });

  test("onSettle 异步（返回 Promise）被正确 await", async () => {
    const items = ["a", "b", "c"];
    const log: string[] = [];
    await eachPool(
      items,
      async (s) => {
        await delay(3);
        return s.toUpperCase();
      },
      3,
      async (i, result) => {
        // 模拟落盘副作用
        await delay(1);
        log.push(`${i}:${result.ok ? result.value : "err"}`);
      },
    );
    // 长度对齐（顺序不保证，因为是流式）
    expect(log.length).toBe(3);
    expect(log.sort()).toEqual(["0:A", "1:B", "2:C"]);
  });

  test("onSettle 自己抛错被吞掉，不污染其它 item", async () => {
    const items = [1, 2, 3];
    const settledOk: number[] = [];
    const r = await eachPool(
      items,
      async (x) => x,
      3,
      (i) => {
        if (i === 1) throw new Error("onSettle-broken");
        settledOk.push(i);
      },
    );
    // i=1 的 onSettle 抛错，但 item 本身仍正常结算，且 i=0/2 的回调仍被执行
    expect(settledOk.sort((a, b) => a - b)).toEqual([0, 2]);
    expect(r.map((x) => (x.ok ? x.value : null))).toEqual([1, 2, 3]);
  });

  test("eachPool 中 fn 的 reject 仍被隔离（同 mapPool 语义）", async () => {
    const items = [1, 2, 3, 4];
    const r = await eachPool(
      items,
      async (x, i) => {
        if (i === 0) throw new Error("first-fail");
        return x;
      },
      2,
      () => {
        // noop
      },
    );
    expect(r[0].ok).toBe(false);
    expect(r.slice(1).map((x) => (x.ok ? x.value : null))).toEqual([2, 3, 4]);
  });

  test("eachPool 空数组：不回调、返回 []", async () => {
    let called = 0;
    const r = await eachPool([], async () => 1, 4, () => { called++; });
    expect(r).toEqual([]);
    expect(called).toBe(0);
  });
});

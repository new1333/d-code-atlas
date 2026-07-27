// index.ts · 对外入口（system，dependsOn: signal, effect, computed）
// 组合上述原语，导出公开 API，并附带一个可运行 demo。

import { signal } from "./signal.ts";
import { effect } from "./effect.ts";
import { computed } from "./computed.ts";

export { signal, effect, computed };

/**
 * 最小可运行 demo：signal + effect + computed 联动。
 * `bun run src/index.ts` 即可看到响应式行为。
 */
if (import.meta.main) {
  const count = signal(1);
  const doubled = computed(() => count.get() * 2);

  console.log("初始 doubled:", doubled.get()); // 期望 2

  effect(() => {
    console.log("effect 观察到 doubled =", doubled.get());
  });
  // 首次执行 effect 输出：doubled = 2

  count.set(5);
  // count 变 → doubled 重算成 10 → effect 重跑输出：doubled = 10
  console.log("改 count=5 后 doubled:", doubled.get()); // 期望 10
}

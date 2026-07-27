# M05 · lib-topo

> 自底向上的算法核心：Kahn 拓扑排序 + 环检测 + 闭包校验。
> 对应 design §3（lib/topo.ts）、§7（自底向上保证 ADR-0003）、requirements FR-5、AC-4。

## 依赖
- M00 project-scaffolding（无外部依赖，纯函数）

## 子任务

- [ ] 定义输入类型 `TopoNode = { slug: string; dependsOn: string[] }`。
- [ ] `topoSort(nodes): { order: string[]; hasCycle: boolean; danglingRefs: string[] }`：
  - Kahn 算法：按入度出队。
  - 出队数 < 节点数 → `hasCycle=true`，`order` 含已排部分 + 剩余（标记）。
  - `dependsOn` 引用了不存在的 slug → 收集到 `danglingRefs`。
- [ ] `verifyClosure(order, nodes): { ok: boolean; violations: { slug: string; missing: string[] }[] }`：
  - 对每章，其 `dependsOn` 闭包中所有 slug 都必须排在它**之前**。
  - 返回违反项明细。
- [ ] `stableTopoSort`（可选）：同入度时保持 outline 原声明顺序，确保可复现。
- [ ] 纯函数、零 IO、零日志。

## Done 标准
- 算法对：无环→线性序；有环→`hasCycle`；悬空→`danglingRefs`；闭包违反→`violations`。
- 无副作用，可被 Critic（agent）与 Assembler（stage）复用同一份（design §7 校验层）。

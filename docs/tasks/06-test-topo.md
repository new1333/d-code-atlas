# M06 · test-topo

> topo 的单元测试。AC-4 的算法核验基础。
> 对应 design §7、verification.md AC-4。

## 依赖
- M05 lib-topo

## 子任务

- [ ] `test/topo.test.ts` 用例：
  - [ ] **无环·正常序**：A→B→C（B dependsOn A，C dependsOn [A,B]），期望 order=[A,B,C]，hasCycle=false。
  - [ ] **自底向上闭包满足**：上例 `verifyClosure` ok=true。
  - [ ] **有环**：A↔B 互相依赖，期望 hasCycle=true。
  - [ ] **悬空引用**：B dependsOn [X]（X 不存在），期望 danglingRefs=["X"]。
  - [ ] **闭包违反**：order 故意错排（依赖在后），期望 ok=false 且 violations 含正确 slug。
  - [ ] **多层 DAG**：primitive/composite/system 混合，依赖跨层正确排序。
- [ ] `bun test test/topo.test.ts` 全绿。

## Done 标准
- 所有用例 PASS；测试覆盖 topoSort 的 ok / cycle / dangling 三态与 verifyClosure 的 ok/violation 二态。
- 后续重构 topo.ts 时这套测试是回归网。

// lib/topo.ts：自底向上的算法核心（ADR-0003）。
// 对应 design §3（lib/topo.ts）、§7（自底向上保证：数据层 outline.dependsOn 是真相 →
//   计算层本文件做 Kahn 拓扑排序 → 校验层 Critic 用同一份复算交叉比对 → 呈现层 Assembler 按 topoOrder 编号）。
// 对应 requirements FR-5、verification AC-4（核验脚本会 `import("./src/lib/topo.ts")`
//   调 `topoSort` 与 `verifyClosure`——导出名必须精确）。
//
// 三条硬约束（与 task-05 Done 标准对齐）：
//   1) 纯函数、零 IO、零日志、零副作用：design §7 要求 Critic（agent）与 Assembler（stage）
//      复用同一份逻辑，所以本文件不读盘、不写盘、不打印、不取系统时钟——确定性 + 可重入。
//   2) 悬空引用 ≠ 环：dependsOn 指向不存在的 slug 是「数据质量问题」，单独报告进 danglingRefs；
//      它既不参与入度计算（视为不存在），也不阻塞排序，更不会置 hasCycle。
//   3) 稳定性：同入度（同一轮可出队）时按 nodes 在输入数组里的**原始声明顺序**出队，
//      而非字典序——保证可复现，且尊重 Architect 的声明意图（见文末稳定性实现说明）。
//
// 边语义约定（贯穿全文件）：
//   `node.dependsOn[i]` 表示「理解 node 前必须先理解 dependsOn[i]」→
//   依赖图里有一条有向边 `dependsOn[i] → node`（被依赖者在前，先出队）。
//   因此 node 的入度 = 它的 dependsOn 中「存在于图中」的依赖条数（悬空引用不算）。

// ---------------------------------------------------------------------------
// 类型（导出名必须与 AC-4 核验脚本一致）
// ---------------------------------------------------------------------------

/**
 * 拓扑排序的输入节点。
 * - slug：章节唯一标识（kebab-case）。
 * - dependsOn：理解本章前必须先理解的其它 slug 列表；
 *   每个元素在依赖图中对应一条「该元素 → slug」的有向边（被依赖者在前）。
 */
export interface TopoNode {
  slug: string;
  dependsOn: string[];
}

/**
 * topoSort 的返回值。
 * - order：拓扑顺序的 slug 数组（无环时覆盖全部节点；有环时只含 Kahn 成功出队的部分，保持出队顺序）。
 * - hasCycle：是否存在环（含自环——自环在 Kahn 下天然无法出队，故被识别为环）。
 * - danglingRefs：dependsOn 引用了不存在 slug 的**去重 + 排序**列表。
 *   选「排序后返回」而非「发现序」是为了断言稳定（不同实现/遍历顺序下结果一致）；详见 topoSort 注释。
 * - remaining：若有环，无法排序（未能出队）的节点 slug 列表，便于上层诊断。
 */
export interface TopoSortResult {
  order: string[];
  hasCycle: boolean;
  danglingRefs: string[];
  remaining?: string[];
}

/**
 * 单个章节的闭包违反明细。
 * - slug：被校验的章节。
 * - missing：出现在该章节 dependsOn 闭包里、却排在它后面（含根本不在 order 中）的 slug 列表（已排序）。
 */
export interface ClosureViolation {
  slug: string;
  missing: string[];
}

/**
 * verifyClosure 的返回值。ok = violations.length === 0。
 */
export interface VerifyClosureResult {
  ok: boolean;
  violations: ClosureViolation[];
}

// ---------------------------------------------------------------------------
// topoSort：Kahn 算法 + 环检测 + 悬空引用收集
// ---------------------------------------------------------------------------

/**
 * 对 `nodes` 做 Kahn 拓扑排序，返回顺序、环标志、悬空引用、剩余节点。
 *
 * 算法步骤：
 *   1) 建图：遍历每个节点的 dependsOn。
 *      - 若依赖项不在节点集合中 → 悬空引用，收集进 danglingRefs（去重），**不计入入度、不建边**。
 *      - 若依赖项存在（含自环：依赖自己）→ 建边 `dep → slug`，slug 入度 +1。
 *        自环 A→A 会让 A 的入度恒 ≥1、永远无法出队，Kahn 自然将其判为环，无需特殊分支。
 *   2) Kahn：入度为 0 的节点进入 ready 候选集；循环「取一个出队 → 它指向的邻居入度 -1 → 新入度为 0 者入 ready」。
 *   3) 出队数 < 节点数 → 图中存在环（hasCycle=true）；order 只含已成功出队的部分，remaining = 未出队的。
 *
 * 稳定性（同入度按输入声明序，而非字典序）：
 *   ready 集合里的候选可能来自不同位置，出队时总是挑「nodes 数组里原始 index 最小」的那个。
 *   实现上 ready 是一个 index 数组，每轮线性扫描找最小 index 并 splice 移除——
 *   节点数 ≤ maxChapters(24)，O(V²) 完全可接受，换来实现直白可读。
 *   这条规则让 Architect 在 outline.json 里的章节声明顺序被尊重：同层无关项保持声明序，可复现。
 *
 * 悬空引用 ≠ 环：
 *   悬空依赖既不入度也不建边，因此它本身不会造成「无法出队」（那是环的判定依据）。
 *   所以「B dependsOn [X]，X 不存在」时，B 的入度仍是 0、能正常出队，hasCycle=false，
 *   只是 X 被收进 danglingRefs。
 *
 * danglingRefs 排序后返回：发现顺序受遍历方式影响（不同实现/重排可能不同），
 *   排序后结果唯一，断言稳定；代价是丢失「谁引用了它」的信息（本字段只回答「有哪些悬空 slug」）。
 */
export function topoSort(nodes: TopoNode[]): TopoSortResult {
  const n = nodes.length;

  // 空输入短路：避免下面 new Array(0) 与空 Map 的边界讨论，直接返回平凡结果。
  if (n === 0) {
    return { order: [], hasCycle: false, danglingRefs: [] };
  }

  // slug → 节点 index。用于：① 判断某依赖是否悬空；② 自环判定时取节点本身。
  // 若输入含重复 slug（异常输入），后者覆盖前者——本函数不纠错，交由上游 outline schema 保证唯一。
  const indexOfSlug = new Map<string, number>();
  for (let i = 0; i < n; i++) indexOfSlug.set(nodes[i].slug, i);

  // 入度：indeg[i] = 节点 i 的「存在于图中」的依赖条数。
  // 反向邻接表：dependents[u] = 所有「u → v」里的 v（即 v 的 dependsOn 含 nodes[u].slug）的 index 列表。
  // 出队 u 时用它把后继 v 的入度减 1。
  const indeg = new Array<number>(n).fill(0);
  const dependents: number[][] = Array.from({ length: n }, () => []);

  // 收集悬空引用（用 Set 去重，最后排序输出）。
  const danglingSet = new Set<string>();

  for (let i = 0; i < n; i++) {
    const { slug, dependsOn } = nodes[i];
    for (const dep of dependsOn) {
      const depIdx = indexOfSlug.get(dep);
      if (depIdx === undefined) {
        // 依赖项不在节点集合 → 悬空引用。不入度、不建边、不算环。
        danglingSet.add(dep);
        continue;
      }
      // 依赖项存在（含 depIdx === i 的自环）：建边 dep → slug，slug 入度 +1。
      // 自环在这里也被当成正常边，让 Kahn 把它判为环（见上文算法说明）。
      indeg[i] += 1;
      dependents[depIdx].push(i);
    }
  }

  // Kahn 主循环。ready 存「当前入度为 0、可出队」的节点 index。
  const ready: number[] = [];
  for (let i = 0; i < n; i++) {
    if (indeg[i] === 0) ready.push(i);
  }

  const order: string[] = [];
  const dequeued = new Array<boolean>(n).fill(false);

  while (ready.length > 0) {
    // 稳定性：从 ready 里挑原始 index 最小的出队（不按字典序、不按 ready 内顺序）。
    // 线性扫描找最小；n 很小，O(V²) 无所谓，换来无额外数据结构与清晰逻辑。
    let bestPos = 0;
    for (let k = 1; k < ready.length; k++) {
      if (ready[k] < ready[bestPos]) bestPos = k;
    }
    const u = ready.splice(bestPos, 1)[0];
    dequeued[u] = true;
    order.push(nodes[u].slug);

    // 松弛后继：u → v 的 v 入度 -1；若归零则加入 ready（候选集，下一轮再按 index 挑）。
    for (const v of dependents[u]) {
      indeg[v] -= 1;
      if (indeg[v] === 0) ready.push(v);
    }
  }

  // 出队数 < 节点数 → 剩下的都参与了环（或被环挡住），判 hasCycle。
  // remaining 仅在**有环时**挂上（接口里是可选字段，规格：「若有环，无法排序的节点列表」）；
  // 无环时不挂该字段，保持结果对象干净、与空输入短路返回一致。
  // remaining 按 nodes 原始声明序收集（稳定）。
  const hasCycle = order.length < n;
  const remaining: string[] = [];
  if (hasCycle) {
    for (let i = 0; i < n; i++) {
      if (!dequeued[i]) remaining.push(nodes[i].slug);
    }
  }

  // 悬空引用排序后返回（断言稳定；代价是丢失发现序信息）。
  const danglingRefs = Array.from(danglingSet).sort();

  return hasCycle
    ? { order, hasCycle, danglingRefs, remaining }
    : { order, hasCycle, danglingRefs };
}

// ---------------------------------------------------------------------------
// closureOf：传递依赖闭包（可选导出，供 verifyClosure 复用与单测）
// ---------------------------------------------------------------------------

/**
 * 返回 `slug` 的**传递依赖闭包**（直接依赖 + 传递依赖，不含 slug 自己）。
 *
 * 沿 dependsOn 边做 DFS：从 slug 出发，每碰到一个新依赖就加入结果集并继续展开。
 * 用 visited 集合防环（依赖图有环时不会死循环，环内节点返回「能从 slug 到达的集合」）。
 *
 * 边界：
 *   - slug 自己永不在结果里（即使存在自环 A dependsOn A）。
 *   - 悬空依赖（dependsOn 指向不存在节点）会被加入闭包集合并停止展开（无法继续 DFS）。
 *     这一点对 verifyClosure 很关键：悬空依赖天然不在 order 里，会被正确报告为 missing。
 *   - slug 本身不在 nodes（悬空起点）→ 返回空集。
 */
export function closureOf(slug: string, nodes: TopoNode[]): Set<string> {
  const nodeBySlug = new Map<string, TopoNode>();
  for (const node of nodes) nodeBySlug.set(node.slug, node);

  const result = new Set<string>();
  // visited 含 slug 自己：① 防自环（A dependsOn A 不会把 A 加进结果）；② 防成环死循环。
  const visited = new Set<string>([slug]);

  // 用显式栈做 DFS（避免深递归栈；章节规模小，递归也行，但显式栈更稳）。
  const stack: string[] = [slug];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    const node = nodeBySlug.get(cur);
    if (!node) continue; // cur 是悬空依赖（不在 nodes），无法继续展开。
    for (const dep of node.dependsOn) {
      if (!visited.has(dep)) {
        visited.add(dep);
        result.add(dep); // 直接或传递依赖，统一进闭包（含悬空 dep——见上文边界说明）。
        stack.push(dep);
      }
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// verifyClosure：校验 order 是否满足所有 dependsOn 闭包在前
// ---------------------------------------------------------------------------

/**
 * 校验 `order` 是否满足：对每个节点，它的 dependsOn 传递闭包里所有 slug 都排在它**之前**。
 *
 * `order` 被视为权威顺序（可能来自外部，如 Architect 在 outline.json 里声称的 topoOrder，
 * 或 topoSort 的输出）。本函数只回答「order 是否满足自底向上不变量」，不重算顺序。
 *
 * 判定规则（对每个节点 node）：
 *   - 计算闭包 closureOf(node.slug)。
 *   - 对闭包里每个 dep：
 *       · 若 dep 不在 order 中，或 dep 在 order 中但位置 ≥ node 的位置 → 计入 missing。
 *       · （「≥」而非「>」：依赖项必须严格在前，等于也算违反——同位不存在于合法 order，但保守判违反。）
 *   - missing 非空 → 记一条 violation，missing 排序后返回（断言稳定）。
 *
 * 闭包是**传递**的：A dependsOn B、B dependsOn C → A 的闭包含 C；若 C 排在 A 后则 A 违反。
 * 这一点由 closureOf 保证。
 *
 * 边界：
 *   - node.slug 不在 order：无法定位它，跳过该节点（不报 violation）；这是 order 缺失问题，
 *     非本函数「闭包在前」的职责。正常流程 order 应覆盖全部 nodes。
 *   - 空 order + 空 nodes → ok=true。
 */
export function verifyClosure(order: string[], nodes: TopoNode[]): VerifyClosureResult {
  // 把 order 映射成位置表，O(1) 查询。order 里若含重复 slug，后者位置覆盖前者（异常输入，不纠错）。
  const position = new Map<string, number>();
  for (let i = 0; i < order.length; i++) position.set(order[i], i);

  const violations: ClosureViolation[] = [];
  for (const node of nodes) {
    const myPos = position.get(node.slug);
    if (myPos === undefined) continue; // 节点本身不在 order：无法判定，跳过（见上文边界说明）。

    const missing: string[] = [];
    for (const dep of closureOf(node.slug, nodes)) {
      const depPos = position.get(dep);
      // dep 不在 order，或 dep 在 order 但位置 ≥ myPos（没严格排在前面）→ 违反。
      if (depPos === undefined || depPos >= myPos) {
        missing.push(dep);
      }
    }
    if (missing.length > 0) {
      // 排序保证断言稳定（闭包是 Set，遍历序不保证）。
      violations.push({ slug: node.slug, missing: missing.sort() });
    }
  }

  return { ok: violations.length === 0, violations };
}

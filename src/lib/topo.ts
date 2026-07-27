/**
 * Topological sort + cycle detection over a chapter dependency DAG.
 * Pure functions. The mechanical heart of "bottom-up" (ADR-0003, design §7).
 *
 * `dependsOn[]` is the reader's reading order: a chapter's prerequisites must
 * appear earlier in the linearized sequence. `layer` is NOT used for ordering,
 * only for sidebar grouping (design §11).
 */

export interface ChapterDeps {
  slug: string;
  dependsOn: string[];
}

export interface TopoResult {
  /** Slugs in dependency order (prerequisites first). */
  order: string[];
  /** True iff the graph contains a cycle reachable from the chapters. */
  hasCycle: boolean;
  /** Slugs that participate in a cycle (empty if acyclic). */
  cycleNodes: string[];
  /** References to unknown slugs (dependsOn pointing at non-existent chapter). */
  danglingRefs: string[];
}

/**
 * Kahn's algorithm. Stable: nodes with no incoming edges are emitted in input
 * order, so two runs on identical input produce identical output
 * (deterministic — design §8.2 notes "do not take system clock on determinism
 * path").
 */
export function topoSort(chapters: ChapterDeps[]): TopoResult {
  const bySlug = new Map<string, ChapterDeps>();
  for (const c of chapters) bySlug.set(c.slug, c);

  // dangling refs: dependsOn pointing at slugs not in the chapter set
  const danglingRefs: string[] = [];
  const known = new Set(chapters.map((c) => c.slug));
  for (const c of chapters) {
    for (const dep of c.dependsOn) {
      if (!known.has(dep) && !danglingRefs.includes(dep)) danglingRefs.push(dep);
    }
  }

  // in-degree counting (ignore dangling refs — they don't form edges we can
  // satisfy; caller decides whether danglingRefs is fatal)
  const indeg = new Map<string, number>();
  const adj = new Map<string, string[]>(); // dep -> dependents
  for (const c of chapters) {
    indeg.set(c.slug, 0);
    adj.set(c.slug, []);
  }
  for (const c of chapters) {
    for (const dep of c.dependsOn) {
      if (!bySlug.has(dep)) continue; // dangling, skip
      adj.get(dep)!.push(c.slug);
      indeg.set(c.slug, (indeg.get(c.slug) || 0) + 1);
    }
  }

  const order: string[] = [];
  // input-order stable queue
  const queue = chapters
    .filter((c) => (indeg.get(c.slug) || 0) === 0)
    .map((c) => c.slug);

  while (queue.length > 0) {
    const slug = queue.shift()!;
    order.push(slug);
    for (const dependent of adj.get(slug) || []) {
      const next = (indeg.get(dependent) || 0) - 1;
      indeg.set(dependent, next);
      if (next === 0) queue.push(dependent);
    }
  }

  const hasCycle = order.length < chapters.length;
  const cycleNodes = hasCycle
    ? chapters.filter((c) => !order.includes(c.slug)).map((c) => c.slug)
    : [];

  return { order, hasCycle, cycleNodes, danglingRefs };
}

/**
 * Verify that a claimed ordering satisfies every chapter's dependsOn closure:
 * for each chapter, all of its dependsOn must appear earlier in `order`.
 * Used by the Critic to cross-check the Architect's claimed sequence
 * (design §7 校验层).
 */
export function verifyClosure(
  order: string[],
  chapters: ChapterDeps[],
): { ok: boolean; violations: { slug: string; unmet: string[] }[] } {
  const pos = new Map<string, number>();
  order.forEach((s, i) => pos.set(s, i));
  const violations: { slug: string; unmet: string[] }[] = [];
  for (const c of chapters) {
    const myPos = pos.get(c.slug);
    if (myPos === undefined) {
      violations.push({ slug: c.slug, unmet: ["<missing-from-order>"] });
      continue;
    }
    const unmet = c.dependsOn.filter((dep) => {
      const depPos = pos.get(dep);
      return depPos === undefined || depPos >= myPos;
    });
    if (unmet.length > 0) violations.push({ slug: c.slug, unmet });
  }
  return { ok: violations.length === 0, violations };
}

/**
 * Bounded concurrency pool. Default 4 (design §14, NFR-4).
 * Errors bubble up on the first failing item — callers handle per-stage policy.
 *
 * Order of results follows completion, NOT input order. Callers that need
 * input-order results should zip by the item they passed in.
 */
export async function mapPool<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
  onProgress?: (done: number, total: number, current: T) => void,
): Promise<R[]> {
  const n = items.length;
  if (n === 0) return [];
  const limit = Math.max(1, Math.min(concurrency, n));
  const results: R[] = new Array(n);
  let cursor = 0;
  let done = 0;

  async function worker(): Promise<void> {
    while (true) {
      const myIndex = cursor++;
      if (myIndex >= n) return;
      const item = items[myIndex]!;
      onProgress?.(done, n, item);
      results[myIndex] = await fn(item, myIndex); // throws → rejects pool
      done++;
    }
  }

  const workers = Array.from({ length: limit }, () => worker());
  await Promise.all(workers);
  return results;
}

/**
 * Runs `fn` over `items` with at most `limit` calls in flight at once,
 * returning results in the same order as `items`. Used to overlap
 * independent per-article network I/O (header image extraction, full-page
 * fetch, comment fetches) that was previously awaited one article at a time
 * with no ordering dependency between articles.
 *
 * If `fn` rejects for one item, the returned promise rejects with that
 * error, but other in-flight workers are NOT cancelled -- they keep running,
 * and their results, if any, are discarded since the caller has already
 * moved on.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  }

  const workerCount = Math.min(Math.max(1, limit), items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  return results;
}

/** Per-feed cap on in-flight per-article enrichment calls (header image
 * extraction, full-page fetch, comment fetches). Chosen to overlap I/O
 * substantially while staying polite to source sites -- see the aggregation
 * performance investigation this constant came out of. */
export const ARTICLE_ENRICHMENT_CONCURRENCY = 4;

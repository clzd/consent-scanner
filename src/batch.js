// Runs several scans with a cap on how many run at once, and rolls their results up.
export const BATCH_CONCURRENCY = 3;

/** Like Promise.all(items.map(fn)), but with at most `limit` calls of fn in flight. */
export async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** The worst outcome across entries: a failed scan, then a bot check, then findings. */
export function batchOutcome(entries) {
  if (entries.some((e) => e.error)) return 'error';
  if (entries.some((e) => e.result.blocked.detected)) return 'blocked';
  if (entries.some((e) => e.result.summary.hasFindings)) return 'findings';
  return 'clean';
}

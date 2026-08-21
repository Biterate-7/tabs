/**
 * Runs `worker` over every item with at most `limit` in flight at once.
 * Never rejects: a failing worker call resolves as `undefined` in its slot
 * rather than aborting the rest of the batch, so one bad URL can't block
 * the others sharing this run.
 */
export async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<(R | undefined)[]> {
  const results: (R | undefined)[] = new Array(items.length);
  let cursor = 0;

  async function runNext(): Promise<void> {
    const index = cursor;
    cursor += 1;
    if (index >= items.length) return;

    try {
      results[index] = await worker(items[index], index);
    } catch {
      results[index] = undefined;
    }

    await runNext();
  }

  const workerCount = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workerCount }, runNext));

  return results;
}

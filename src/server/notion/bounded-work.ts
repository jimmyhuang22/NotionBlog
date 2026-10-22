/** Preserve input order, cap outstanding work, and drain started reads on failure. */
export async function mapBounded<T, R>(
  items: readonly T[],
  concurrency: number,
  read: (item: T) => Promise<R>,
): Promise<R[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error("Invalid read concurrency.");
  const results = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  let failure: unknown;
  async function worker() {
    while (!failed) {
      const index = next++;
      if (index >= items.length) return;
      try { results[index] = await read(items[index]!); }
      catch (error) {
        if (!failed) { failed = true; failure = error; }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  if (failed) throw failure;
  return results;
}

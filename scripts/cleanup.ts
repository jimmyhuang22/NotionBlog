/** Attempt every cleanup even if an earlier close throws synchronously. */
export async function cleanupAll(steps: readonly (() => unknown | Promise<unknown>)[]): Promise<boolean> {
  let complete = true;
  for (const step of steps) {
    try { await step(); } catch { complete = false; }
  }
  return complete;
}

/** Failed owner operations may have a broken connection or an open transaction. */
export async function closeOwnerPool(
  pool: { end(): Promise<void> },
  client: { release(destroy?: boolean): void } | undefined,
  failed: boolean,
): Promise<void> {
  const complete = await cleanupAll([() => client?.release(failed), () => pool.end()]);
  if (!complete && !failed) throw Error("DATABASE_CLOSE_FAILED");
}

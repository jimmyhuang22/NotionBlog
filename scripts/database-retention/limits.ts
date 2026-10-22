/** New candidates require an explicit limit; legacy frozen runners remain separate. */
export const MAXIMUM_RUNS = 2;
export const MAXIMUM_RETURNED_BYTES = 32 * 1024 * 1024;

export function retentionRunLimit(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > MAXIMUM_RUNS) {
    throw Error("RETENTION_RUN_LIMIT_INVALID");
  }
  return value;
}

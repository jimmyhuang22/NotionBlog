import type { SqlExecutor } from "../../src/server/database/sql.ts";

export class MediaAcceptanceError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.name = "MediaAcceptanceError"; this.code = code; }
}
export function acceptanceFail(code: string): never { throw new MediaAcceptanceError(code); }
export function createMediaAcceptanceBudget(limits: { durationMs: number; sqlQueries: number; sqlResponseBytes: number; mediaResponseBytes: number }) {
  if (!Number.isSafeInteger(limits.durationMs) || limits.durationMs < 10 || limits.durationMs > 2700000 ||
    !Number.isSafeInteger(limits.sqlQueries) || limits.sqlQueries < 1 || limits.sqlQueries > 80011 ||
    !Number.isSafeInteger(limits.sqlResponseBytes) || limits.sqlResponseBytes < 1 || limits.sqlResponseBytes > 64 * 1024 ** 2 ||
    !Number.isSafeInteger(limits.mediaResponseBytes) || limits.mediaResponseBytes < 0 || limits.mediaResponseBytes > 3 * 1024 ** 3) acceptanceFail("MEDIA_ACCEPTANCE_INPUT_INVALID");
  const started = performance.now(), controller = new AbortController();
  let sqlQueries = 0, sqlResponseBytes = 0, mediaResponseBytes = 0, failure: string | null = null, closed = false;
  const cancel = (code = "MEDIA_ACCEPTANCE_CANCELLED") => { failure ??= code; controller.abort(); };
  const fail = (code: string): never => { cancel(code); return acceptanceFail(failure!); };
  const timer = setTimeout(() => cancel("MEDIA_ACCEPTANCE_DEADLINE"), limits.durationMs); timer.unref();
  function guard() {
    if (closed) fail("MEDIA_ACCEPTANCE_CLOSED");
    if (performance.now() - started >= limits.durationMs) cancel("MEDIA_ACCEPTANCE_DEADLINE");
    if (failure) acceptanceFail(failure);
  }
  function observe(kind: "sqlResponseBytes" | "mediaResponseBytes", bytes: number) {
    if (!Number.isSafeInteger(bytes) || bytes < 0) fail("MEDIA_ACCEPTANCE_INPUT_INVALID");
    if (kind === "sqlResponseBytes") sqlResponseBytes += bytes; else mediaResponseBytes += bytes;
    if (!Number.isSafeInteger(sqlResponseBytes + mediaResponseBytes) ||
      (kind === "sqlResponseBytes" ? sqlResponseBytes : mediaResponseBytes) > limits[kind]) fail("MEDIA_ACCEPTANCE_BYTE_LIMIT");
    guard();
  }
  async function wait<T>(call: () => Promise<T>): Promise<T> {
    guard();
    return new Promise<T>((resolve, reject) => {
      const aborted = () => reject(new MediaAcceptanceError(failure ?? "MEDIA_ACCEPTANCE_CANCELLED"));
      controller.signal.addEventListener("abort", aborted, { once: true });
      Promise.resolve().then(() => { guard(); return call(); }).then(result => {
        controller.signal.removeEventListener("abort", aborted); try { guard(); resolve(result); } catch (e) { reject(e); }
      }, error => { controller.signal.removeEventListener("abort", aborted); reject(error); });
    });
  }
  function sql(db: SqlExecutor): SqlExecutor {
    return { async query<T>(text: string, values?: unknown[]) {
      guard(); if (sqlQueries >= limits.sqlQueries) fail("MEDIA_ACCEPTANCE_SQL_LIMIT"); sqlQueries++;
      return wait(async () => {
        const result = await db.query<T>(text, values);
        // Application rows only, not a claim about pg framing/TLS or error packets.
        observe("sqlResponseBytes", Buffer.byteLength(JSON.stringify(result.rows))); return result;
      });
    } };
  }
  return { guard, wait, observe, sql, cancel, signal: controller.signal,
    statistics: () => ({ sqlQueries, sqlResponseBytes, mediaResponseBytes, failure }),
    close() { closed = true; clearTimeout(timer); controller.abort(); } };
}
export type MediaAcceptanceBudget = ReturnType<typeof createMediaAcceptanceBudget>;

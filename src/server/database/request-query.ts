import type { Pool, PoolClient, QueryConfig } from "pg";
import { ContentServiceError } from "../../../contracts/repository.ts";
import { checkContentReadBudget, type ReadBudget } from "../content-read-budget.ts";
import { measureContentReadAsync } from "../content-read-timing.ts";

const unavailable = () => new ContentServiceError("CONTENT_UNAVAILABLE", "The content read was cancelled or exceeded its deadline.");
const remaining = (budget: ReadBudget) => Math.max(0, Math.floor(budget.deadline - budget.now()));

/** pg-pool has no per-checkout AbortSignal API. Stop the caller at its deadline,
 * and return any later checkout without ever running SQL. The pool's existing
 * connectionTimeoutMillis still removes its pending callback; no pool option is mutated. */
function acquire(pool: Pool, budget: ReadBudget): Promise<PoolClient> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (error?: Error | null, client?: PoolClient) => {
      if (settled) { client?.release(); return; }
      settled = true;
      clearTimeout(timer);
      budget.signal.removeEventListener("abort", abort);
      if (error) reject(error);
      else if (!client) reject(unavailable());
      else if (budget.signal.aborted || remaining(budget) === 0) { client.release(); reject(unavailable()); }
      else resolve(client);
    };
    const abort = () => done(unavailable());
    const timer = setTimeout(abort, Math.max(1, remaining(budget)));
    budget.signal.addEventListener("abort", abort, { once: true });
    if (budget.signal.aborted || remaining(budget) === 0) { abort(); return; }
    try { pool.connect(done); } catch (error) { done(error instanceof Error ? error : unavailable()); }
  });
}

/** Deadline applies across checkout and SQL, with healthy release on success and
 * destruction of only this query's client on cancellation/timeout. */
export async function requestPoolQuery<T>(pool: Pool, budget: ReadBudget, text: string, values?: unknown[]): Promise<{ rows: T[] }> {
  let stage: "acquire" | "query" = "acquire";
  try {
    checkContentReadBudget();
    const client = await measureContentReadAsync("database-acquire", () => acquire(pool, budget));
    let released = false, failed = false;
    const onError = () => {}; // Keep active-client transport errors handled until release.
    const release = (destroy = false) => { if (!released) { released = true; client.release(destroy); } };
    const abort = () => release(true);
    client.on("error", onError);
    budget.signal.addEventListener("abort", abort, { once: true });
    try {
      checkContentReadBudget();
      stage = "query";
      const driverLimit = pool.options.query_timeout;
      const timeout = Math.max(1, Math.min(remaining(budget), typeof driverLimit === "number" && driverLimit > 0 ? driverLimit : Infinity));
      // pg 8.23 supports this per-query limit; @types/pg omits the driver field.
      const config: QueryConfig & { query_timeout: number } = { text, values, query_timeout: timeout };
      const result = await measureContentReadAsync("database-roundtrip", () => client.query(config));
      checkContentReadBudget();
      return { rows: result.rows as T[] };
    } catch (error) { failed = true; throw error; }
    finally {
      budget.signal.removeEventListener("abort", abort);
      release(failed);
      client.removeListener("error", onError);
    }
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    const safeCode = typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) ? code : "UNKNOWN";
    const reason = budget.signal.aborted ? "aborted" : remaining(budget) === 0 ? "deadline"
      : error instanceof Error && error.message === "Query read timeout" ? "query-timeout"
      : error instanceof Error && error.message === "timeout exceeded when trying to connect" ? "checkout-timeout" : "driver";
    try { console.warn("CONTENT_SQL_FAILURE", JSON.stringify({ stage, reason, code: safeCode,
      pool: { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount } })); } catch { /* preserve error */ }
    throw error;
  }
}

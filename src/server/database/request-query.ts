import type { Pool, PoolClient, QueryConfig } from "pg";
import { ContentServiceError } from "../../../contracts/repository.ts";
import { checkContentReadBudget, type ReadBudget } from "../content-read-budget.ts";
import { measureContentReadAsync } from "../content-read-timing.ts";
import type { ResultQueryPlan } from "./result-response-budget.ts";

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
export async function requestPoolQuery<T>(pool: Pool, budget: ReadBudget, text: string, values?: unknown[], readOnly = false): Promise<{ rows: T[] }> {
  let stage: "acquire" | "query" = "acquire";
  let resultPlan: ResultQueryPlan | undefined;
  try {
    checkContentReadBudget();
    resultPlan = budget.resultBudget?.prepare(text, values);
    const client = await measureContentReadAsync("database-acquire", () => acquire(pool, budget));
    let released = false, failed = false, transaction = false, transactionClosed = false;
    const onError = () => {}; // Keep active-client transport errors handled until release.
    const release = (destroy = false) => { if (!released) { released = true; client.release(destroy); } };
    const abort = () => release(true);
    client.on("error", onError);
    budget.signal.addEventListener("abort", abort, { once: true });
    const check = () => {
      checkContentReadBudget();
      if (released || budget.signal.aborted || remaining(budget) === 0) throw unavailable();
    };
    const send = async (queryText: string, queryValues?: unknown[]) => {
      check();
      const driverLimit = pool.options.query_timeout;
      const timeout = Math.max(1, Math.min(remaining(budget), typeof driverLimit === "number" && driverLimit > 0 ? driverLimit : Infinity));
      // pg 8.23 supports this per-query limit; @types/pg omits the driver field.
      const config: QueryConfig & { query_timeout: number } = { text: queryText, values: queryValues, query_timeout: timeout };
      const result = await client.query(config);
      check();
      return result;
    };
    const query = (text: string, values?: unknown[]) => measureContentReadAsync("database-roundtrip", () => send(text, values));
    const reserveControls = (count: number) => {
      check();
      const sql = budget.sql;
      if (sql) {
        if (sql.queries + count > sql.maxQueries || sql.responseBytes > sql.maxResponseBytes) throw unavailable();
        sql.queries += count;
      }
    };
    const acceptControl = (result: Awaited<ReturnType<typeof send>>, expected: string[]) => {
      if (Array.isArray(result) || !expected.includes(result.command)) throw unavailable();
      const sql = budget.sql;
      if (sql && sql.maxResponseBytes !== Infinity) {
        sql.responseBytes += Buffer.byteLength(JSON.stringify(result.rows));
        if (sql.responseBytes > sql.maxResponseBytes) throw unavailable();
      }
    };
    const control = async (command: string, expected: string) => {
      reserveControls(1);
      acceptControl(await query(command), [expected]);
    };
    // pg 8.23's opt-in pipeline preserves command order and separate results.
    // Drain BOTH results on error before rollback/release: Promise.all alone
    // could return a client while its queued COMMIT is still using it.
    const pair = (first: string, second: string, values?: unknown[]) =>
      measureContentReadAsync("database-roundtrip", () => Promise.allSettled([send(first, values), send(second)]));
    const pipelined = readOnly && client.pipeline === true;
    try {
      check();
      if (readOnly) {
        // Session startup GUCs may be ignored by a transaction pooler. BEGIN,
        // SET LOCAL and the read must use this one checkout, without pool.query.
        if (!pipelined) {
          transaction = true;
          await control("BEGIN READ ONLY", "BEGIN");
        }
        const configured = pool.options.statement_timeout;
        const limit = typeof configured === "number" && Number.isSafeInteger(configured) && configured > 0 ? configured : 15_000;
        const timeout = Math.max(1, Math.min(15_000, limit, remaining(budget)));
        if (pipelined) {
          reserveControls(2);
          transaction = true;
          const setup = await pair("BEGIN READ ONLY", `SET LOCAL statement_timeout = ${timeout}`);
          for (const [index, result] of setup.entries()) {
            if (result.status === "rejected") throw result.reason;
            acceptControl(result.value, [index === 0 ? "BEGIN" : "SET"]);
          }
        } else await control(`SET LOCAL statement_timeout = ${timeout}`, "SET");
      }
      stage = "query";
      let result: Awaited<ReturnType<typeof send>>;
      if (pipelined) {
        reserveControls(1);
        const [read, commit] = await pair(resultPlan?.text ?? text, "COMMIT", resultPlan?.values ?? values);
        let commitError: unknown;
        try {
          if (commit.status === "rejected") throw commit.reason;
          // PostgreSQL answers COMMIT with ROLLBACK after a failed statement.
          acceptControl(commit.value, read.status === "rejected" ? ["COMMIT", "ROLLBACK"] : ["COMMIT"]);
          transaction = false;
          transactionClosed = true;
        } catch (error) { commitError = error; }
        if (read.status === "rejected") throw read.reason;
        if (!transactionClosed) throw commitError;
        result = read.value;
      } else result = await query(resultPlan?.text ?? text, resultPlan?.values ?? values);
      const rows = resultPlan ? resultPlan.accept<T>(result.rows) : result.rows as T[];
      if (readOnly && !pipelined) {
        await control("COMMIT", "COMMIT");
        transaction = false;
      }
      return { rows };
    } catch (error) {
      failed = !transactionClosed;
      if (readOnly && transaction && !released) {
        try { await control("ROLLBACK", "ROLLBACK"); failed = false; }
        catch { /* No deadline/budget or uncertain cleanup: discard this client. */ }
      }
      throw error;
    }
    finally {
      budget.signal.removeEventListener("abort", abort);
      release(failed);
      client.removeListener("error", onError);
    }
  } catch (error) {
    resultPlan?.fail();
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

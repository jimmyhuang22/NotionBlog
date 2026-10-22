import type { SqlExecutor } from "../../src/server/database/sql.ts";
import { validateCacheEvent, type CacheRefreshEvent } from "../../src/server/public-cache/events.ts";
import { flushCacheEvent, type CacheClientConfig } from "./control.ts";

export interface CacheConsumerReport {
  status: "running" | "idle" | "complete" | "pending" | "operator-required" | "failed";
  stage: "connect" | "read" | "purge" | "acknowledge" | "verify" | "close";
  startedAt: string;
  finishedAt?: string;
  completed: number;
  purges: number;
  pendingAtStart: number | null;
  remainingAtEnd: number | null;
  withdrawals: number | null;
  windowMayBeFull: boolean;
  errorCode?: string;
  sourceRequests: 0;
  uploads: 0;
}
export function initialConsumerReport(): CacheConsumerReport {
  return { status: "running", stage: "connect", startedAt: new Date().toISOString(), completed: 0, purges: 0,
    pendingAtStart: null, remainingAtEnd: null, withdrawals: null, windowMayBeFull: false, sourceRequests: 0, uploads: 0 };
}
async function pending(db: SqlExecutor): Promise<CacheRefreshEvent[]> {
  const r = await db.query<{ result: unknown }>("SELECT nb_cache_api.pending_events() AS result");
  const values = r.rows[0]?.result;
  if (r.rows.length !== 1 || !Array.isArray(values) || values.length > 100) throw Error("CACHE_PENDING");
  const events = values.map(validateCacheEvent);
  if (events.some(e => e.status !== "pending") || new Set(events.map(e => e.id)).size !== events.length) throw Error("CACHE_PENDING");
  return events;
}

/** One finite snapshot. A retry reads SQL again; no journal can authorize a publication or withdrawal. */
export async function consumeCacheRefresh(db: SqlExecutor, config: CacheClientConfig, options: {
  request?: typeof fetch; signal?: AbortSignal; report?: CacheConsumerReport;
  progress?: (report: CacheConsumerReport) => Promise<void>;
} = {}): Promise<CacheConsumerReport> {
  const report = { ...(options.report ?? initialConsumerReport()) };
  const bounded: SqlExecutor = { query: async <T>(text: string, values?: unknown[]) => {
    options.signal?.throwIfAborted(); return db.query<T>(text, values);
  } };
  const progress = async (stage: CacheConsumerReport["stage"]) => {
    report.stage = stage;
    try { await options.progress?.({ ...report }); } catch { throw Error("CACHE_RECEIPT_WRITE_FAILED"); }
  };
  try {
    await progress("read");
    const events = await pending(bounded);
    report.pendingAtStart = events.length;
    const latest = new Map<string, CacheRefreshEvent>();
    for (const event of events) if (event.scope !== "withdraw" &&
      (!latest.has(event.scope) || BigInt(event.generation) > BigInt(latest.get(event.scope)!.generation))) latest.set(event.scope, event);
    for (const event of latest.values()) {
      await progress("purge");
      await flushCacheEvent(bounded, event, config, options.request, { signal: options.signal,
        beforeAcknowledge: async () => { report.purges++; await progress("acknowledge"); } });
      report.completed++;
      // Only older events in this exact snapshot are covered. A concurrent newer event remains pending.
      for (const older of events) if (older.scope === event.scope && BigInt(older.generation) < BigInt(event.generation)) {
        await progress("acknowledge");
        const ack = await bounded.query<{ result: boolean }>("SELECT nb_cache_api.complete_refresh_event($1,$2) AS result", [older.id, older.generation]);
        if (ack.rows.length !== 1 || ack.rows[0]?.result !== true) throw Error("CACHE_ACK_UNKNOWN");
        report.completed++;
      }
    }
    await progress("verify");
    const remaining = await pending(bounded);
    report.remainingAtEnd = remaining.length;
    report.withdrawals = remaining.filter(e => e.scope === "withdraw").length;
    report.windowMayBeFull = remaining.length === 100;
    report.status = remaining.some(e => e.scope !== "withdraw") ? "pending" : report.withdrawals ? "operator-required" : report.completed ? "complete" : "idle";
  } catch (error) {
    report.status = "failed";
    report.errorCode = error instanceof Error && error.message === "CACHE_RECEIPT_WRITE_FAILED" ? error.message
      : options.signal?.aborted ? "CACHE_CONSUMER_DEADLINE"
      : report.stage === "acknowledge" ? "CACHE_ACK_UNKNOWN"
      : report.stage === "purge" ? "CACHE_PURGE_FAILED" : "CACHE_QUEUE_READ_FAILED";
  }
  report.finishedAt = new Date().toISOString();
  return report;
}

import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";
import { ContentServiceError } from "../../contracts/repository.ts";
import type { SqlExecutor } from "./database/sql.ts";

export interface ReadBudget { signal: AbortSignal; deadline: number; now(): number }
const scope = new AsyncLocalStorage<ReadBudget>();
export const contentReadBudgetIdentity = () => scope.getStore();
export function checkContentReadBudget(): void {
  const budget = scope.getStore();
  if (budget && (budget.signal.aborted || budget.now() >= budget.deadline))
    throw new ContentServiceError("CONTENT_UNAVAILABLE", "The content operation was cancelled or exceeded its deadline.");
}
/** Check before/after work and propagate cancellation to request-aware drivers.
 * Generic executors still drain their current call; the website pg executor also
 * bounds checkout/query and destroys cancelled clients before running more SQL. */
export function withContentReadBudget<T>(signal: AbortSignal, read: () => Promise<T>, options: { timeoutMs?: number; now?: () => number } = {}): Promise<T> {
  const timeout = options.timeoutMs ?? 30_000, now = options.now ?? (() => performance.now());
  if (!Number.isFinite(timeout) || timeout <= 0) throw new Error("Invalid content deadline.");
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  return scope.run({ signal: controller.signal, deadline: now() + timeout, now }, async () => {
    try { checkContentReadBudget(); const result = await read(); checkContentReadBudget(); return result; }
    finally { controller.abort(); signal.removeEventListener("abort", abort); }
  });
}
export function budgetedContentSql(db: SqlExecutor): SqlExecutor {
  return { async query<T>(text: string, values?: unknown[]) {
    checkContentReadBudget(); const result = await db.query<T>(text, values); checkContentReadBudget(); return result;
  } };
}

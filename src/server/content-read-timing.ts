import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";
import type { ContentKind } from "../../contracts/content.ts";

type Phase = "service" | "database-runtime" | "database-pool" | "database-acquire" | "database-roundtrip" | "dto-projection"
  | "search-read" | "search-text" | "search-match" | "search-version"
  | "home-content" | "home-social" | "home-compose" | "home-hydrate"
  | "social-reader-check" | "social-collection-check" | "social-snapshot" | "social-covers" | "social-pagination";
export interface ContentReadTiming {
  operation: "detail" | "metadata" | "catalogue" | "search" | "home-feed" | "social-snapshot" | "works" | "status-page" | "content-version";
  kind: ContentKind | "unknown";
  outcome: "ok" | "error";
  totalMs: number;
  region?: string;
  pool?: { checkouts: number; first: { total: number; idle: number; waiting: number }; maxWaiting: number };
  /** Nested and parallel measurements can overlap; they are not additive request budgets. */
  phases: { phase: Phase; calls: number; totalMs: number }[];
}
interface Context { phases: Map<Phase, { calls: number; totalMs: number }>; pool?: ContentReadTiming["pool"] }
const context = new AsyncLocalStorage<Context>();
const kinds = new Set(["status", "movie", "book", "game", "course", "study-note", "post", "album", "project", "page"]);
const rounded = (ms: number) => Math.round(ms * 100) / 100;

export function contentReadTimingActive(): boolean { return context.getStore() !== undefined; }
/** Counts immediately before checkout, not a claim that acquisition time is SQL or pool queue time. */
export function recordContentPoolState(state: { total: number; idle: number; waiting: number }): void {
  const scope = context.getStore();
  if (!scope || ![state.total, state.idle, state.waiting].every(value => Number.isSafeInteger(value) && value >= 0)) return;
  const pool = scope.pool ??= { checkouts: 0, first: { total: state.total, idle: state.idle, waiting: state.waiting }, maxWaiting: 0 };
  pool.checkouts++;
  pool.maxWaiting = Math.max(pool.maxWaiting, state.waiting);
}
function record(phase: Phase, started: number) {
  const scope = context.getStore();
  if (!scope) return;
  const previous = scope.phases.get(phase) ?? { calls: 0, totalMs: 0 };
  previous.calls++; previous.totalMs += performance.now() - started;
  scope.phases.set(phase, previous);
}
export function measureContentRead<T>(phase: Phase, work: () => T): T {
  if (!contentReadTimingActive()) return work();
  const started = performance.now();
  try { return work(); } finally { record(phase, started); }
}
export async function measureContentReadAsync<T>(phase: Phase, work: () => Promise<T>): Promise<T> {
  if (!contentReadTimingActive()) return work();
  const started = performance.now();
  try { return await work(); } finally { record(phase, started); }
}

/** Opt-in server diagnostics only: no keys, source IDs, SQL, params, DTOs or exception details. */
export function traceContentRead<T>(operation: ContentReadTiming["operation"], kind: ContentReadTiming["kind"],
  work: () => Promise<T>, observe?: (timing: ContentReadTiming) => void): Promise<T> {
  if (!observe && process.env.CONTENT_READ_TIMING !== "enabled") return work();
  const scope: Context = { phases: new Map() }, started = performance.now();
  return context.run(scope, async () => {
    let outcome: ContentReadTiming["outcome"] = "error";
    try { const result = await work(); outcome = "ok"; return result; }
    finally {
      const timing: ContentReadTiming = { operation, kind: kinds.has(kind) ? kind : "unknown", outcome,
        totalMs: rounded(performance.now() - started),
        ...(/^[a-z]{3}[1-9][0-9]?$/.test(process.env.VERCEL_REGION ?? "") ? { region: process.env.VERCEL_REGION } : {}),
        ...(scope.pool ? { pool: scope.pool } : {}),
        phases: [...scope.phases].map(([phase, value]) => ({ phase, calls: value.calls, totalMs: rounded(value.totalMs) })) };
      // Observability must never replace a provider result or its original error.
      try { if (observe) observe(timing); else console.info("CONTENT_READ_TIMING", JSON.stringify(timing)); } catch { /* preserve original outcome */ }
    }
  });
}

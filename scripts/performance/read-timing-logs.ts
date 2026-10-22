import type { ContentReadTiming } from "../../src/server/content-read-timing.ts";

const operations = new Set(["detail", "metadata", "catalogue", "search", "home-feed", "social-snapshot", "works"]);
const kinds = new Set(["status", "movie", "book", "game", "course", "study-note", "post", "album", "project", "page", "unknown"]);
const phases = new Set(["service", "database-runtime", "database-pool", "database-acquire", "database-roundtrip", "dto-projection",
  "search-read", "search-text", "search-match", "search-version", "home-content", "home-social", "home-compose", "home-hydrate",
  "social-reader-check", "social-collection-check", "social-snapshot", "social-covers", "social-pagination"]);
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const duration = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value < 1e9;
const count = (value: unknown): value is number => duration(value) && Number.isSafeInteger(value);

/** Match Vercel CLI's extractVercelId: routing prefixes are not the request ID. */
export function vercelRequestId(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 256 || !/^[A-Za-z0-9_-]+(?:::[A-Za-z0-9_-]+)*$/.test(value)) return;
  return value.split("::").at(-1);
}

/** Sanitize one application log message; this alone does not establish request attribution. */
export function readTimingMessage(message: unknown): ContentReadTiming | undefined {
  if (typeof message !== "string" || !message.startsWith("CONTENT_READ_TIMING ")) return;
  let value: unknown;
  try { value = JSON.parse(message.slice("CONTENT_READ_TIMING ".length)); } catch { return; }
  if (!object(value) || typeof value.operation !== "string" || !operations.has(value.operation) || typeof value.kind !== "string" || !kinds.has(value.kind) ||
    typeof value.outcome !== "string" || !["ok", "error"].includes(value.outcome) || !duration(value.totalMs) || !Array.isArray(value.phases) || value.phases.length > phases.size) return;
  const safe: ContentReadTiming = { operation: value.operation as ContentReadTiming["operation"], kind: value.kind as ContentReadTiming["kind"],
    outcome: value.outcome as ContentReadTiming["outcome"], totalMs: value.totalMs, phases: [] };
  for (const phase of value.phases) {
    if (!object(phase) || typeof phase.phase !== "string" || !phases.has(phase.phase) || !count(phase.calls) || !duration(phase.totalMs)) return;
    safe.phases.push({ phase: phase.phase as ContentReadTiming["phases"][number]["phase"], calls: phase.calls, totalMs: phase.totalMs });
  }
  if (typeof value.region === "string" && /^[a-z0-9]{1,8}$/.test(value.region)) safe.region = value.region;
  const pool = value.pool;
  if (object(pool) && object(pool.first) && [pool.checkouts, pool.maxWaiting, pool.first.total, pool.first.idle, pool.first.waiting].every(count)) {
    safe.pool = { checkouts: pool.checkouts as number, maxWaiting: pool.maxWaiting as number,
      first: { total: pool.first.total as number, idle: pool.first.idle as number, waiting: pool.first.waiting as number } };
  }
  return safe;
}

/** Pure offline parser. No network, credential reader, raw-message output or inferred matches. */
export function readTimingLogs(jsonLines: string, deploymentId: string, requestIds: readonly unknown[]): { requestIndex: number; timing: ContentReadTiming }[] {
  if (Buffer.byteLength(jsonLines) > 2 * 1024 * 1024 || requestIds.length > 20) throw new Error("Timing input exceeds its bounded scope.");
  const expected = new Map<string, number | undefined>();
  requestIds.forEach((value, index) => {
    const id = vercelRequestId(value);
    if (id) expected.set(id, expected.has(id) ? undefined : index);
  });
  const result: { requestIndex: number; timing: ContentReadTiming }[] = [];
  for (const line of jsonLines.split(/\r?\n/)) {
    let event: unknown;
    try { event = JSON.parse(line); } catch { continue; }
    if (!object(event) || event.deploymentId !== deploymentId) continue;
    const ids = [...new Set([event.id, event.requestId, event.request_id].map(vercelRequestId).filter(id => id !== undefined))];
    if (ids.length !== 1) continue;
    const requestIndex = expected.get(ids[0]);
    if (requestIndex === undefined) continue;
    // CLI request rows carry all messages in logs[]. The top-level message is
    // only a selected display message (often a warning), not the complete log.
    const messages = Array.isArray(event.logs) ? event.logs : [event];
    for (const log of messages) {
      if (!object(log) || log.messageTruncated === true) continue;
      const timing = readTimingMessage(log.message);
      if (timing) result.push({ requestIndex, timing });
    }
  }
  return result;
}

import { createHash } from "node:crypto";
import type { SqlExecutor } from "../../src/server/database/sql.ts";
import { signCacheEvent, validateCacheEvent, type CacheControlConfig, type CacheRefreshEvent } from "../../src/server/public-cache/events.ts";

export interface CacheClientConfig extends CacheControlConfig { origin: string }
export function cacheControlOrigin(value: string): string {
  const url = new URL(value);
  const local = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(local && url.protocol === "http:")) || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw Error("CACHE_ORIGIN");
  return url.origin;
}
export function refreshEventId(site: string, scope: string, version: string) {
  const h = createHash("sha256").update(JSON.stringify(["nb-cache-event-v1", site, scope, version])).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/** This is called only after the source's successful commit/ACK, never after a failed sync. */
export async function enqueuePublicationRefresh(db: SqlExecutor, config: CacheClientConfig,
  receipt: { scope: "content" | "social" | "media"; version: string; committed: true }): Promise<CacheRefreshEvent> {
  if (receipt.committed !== true || !["content", "social", "media"].includes(receipt.scope) || !/^[a-f0-9]{64}$/.test(receipt.version)) throw Error("CACHE_PUBLICATION_RECEIPT");
  const id = refreshEventId(config.siteKey, receipt.scope, receipt.version);
  const rows = await db.query<{ result: unknown }>("SELECT nb_cache_api.enqueue_refresh($1,$2,$3) AS result", [id, receipt.scope, receipt.version]);
  const result = rows.rows[0]?.result as Record<string, unknown>;
  return validateCacheEvent({ ...result, scope: receipt.scope });
}

/** A lost HTTP response leaves the durable event pending. Retrying never recollects content. */
export async function flushCacheEvent(db: SqlExecutor, event: CacheRefreshEvent, config: CacheClientConfig, request: typeof fetch = fetch,
  options: { signal?: AbortSignal; beforeAcknowledge?: () => Promise<void> } = {}): Promise<void> {
  options.signal?.throwIfAborted();
  const signed = signCacheEvent(event, config);
  const response = await request(`${cacheControlOrigin(config.origin)}/api/internal/cache/purge`, {
    method: "POST", redirect: "error", cache: "no-store", signal: AbortSignal.any([AbortSignal.timeout(20_000), ...(options.signal ? [options.signal] : [])]),
    headers: { "Content-Type": "application/json", "x-nb-cache-signature": signed.signature }, body: signed.body,
  });
  if (response.status !== 200) { await response.body?.cancel(); throw Error("CACHE_PURGE_PENDING"); }
  const text = await boundedText(response, 2048), value = JSON.parse(text);
  if (value.version !== 1 || value.siteKey !== config.siteKey || value.id !== event.id || value.generation !== event.generation || value.purged !== true) throw Error("CACHE_PURGE_RECEIPT");
  await options.beforeAcknowledge?.();
  options.signal?.throwIfAborted();
  const fn = event.scope === "withdraw" ? "complete_event" : "complete_refresh_event";
  const result = await db.query<{ result: boolean }>(`SELECT nb_cache_api.${fn}($1,$2) AS result`, [event.id, event.generation]);
  if (result.rows.length !== 1 || result.rows[0]!.result !== true) throw Error("CACHE_ACK_UNKNOWN");
}
export async function boundedText(response: Response, maximum: number): Promise<string> {
  const reader = response.body?.getReader(); if (!reader) return "";
  let total = 0; const chunks: Uint8Array[] = [];
  try { for (;;) { const next = await reader.read(); if (next.done) break; total += next.value.length; if (total > maximum) throw Error("CACHE_RESPONSE_LIMIT"); chunks.push(next.value); } }
  finally { await reader.cancel().catch(() => {}); }
  return Buffer.concat(chunks).toString("utf8");
}

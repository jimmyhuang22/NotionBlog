import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { publicCacheTags, type PublicCacheScope } from "./policy.ts";

export interface CacheRefreshEvent { id: string; scope: PublicCacheScope | "withdraw"; generation: string; status: "pending" | "complete" }
export const uuid = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
export function validateCacheEvent(value: unknown): CacheRefreshEvent {
  const v = value as CacheRefreshEvent;
  if (!v || !uuid(v.id) || !["content", "social", "media", "withdraw"].includes(v.scope) ||
      !/^[1-9]\d{0,18}$/.test(v.generation) || !["pending", "complete"].includes(v.status)) throw Error("CACHE_EVENT_INVALID");
  return v;
}
export function cacheEventTags(event: CacheRefreshEvent): string[] {
  // Broad, low-traffic first version: include all dependent lists, old media versions and 404s.
  const scopes: PublicCacheScope[] = event.scope === "withdraw" ? ["content", "home", "media"]
    : event.scope === "social" ? ["social", "home", "media"]
    : event.scope === "media" ? ["content", "social", "home", "media"] : ["content", "home", "media"];
  return [...new Set(scopes.flatMap(publicCacheTags))];
}
export interface CacheControlConfig { siteKey: string; secret: string }
function signature(body: string, config: CacheControlConfig): string {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(config.siteKey) || !/^[a-f0-9]{64}$/.test(config.secret)) throw Error("CACHE_CONTROL_CONFIG");
  return createHmac("sha256", Buffer.from(config.secret, "hex")).update("nb-cache-purge-v1\n").update(body).digest("hex");
}
export function signCacheEvent(event: CacheRefreshEvent, config: CacheControlConfig, now = Date.now()) {
  const body = JSON.stringify({ version: 1, siteKey: config.siteKey, id: event.id, generation: event.generation, issuedAt: now, nonce: randomUUID() });
  return { body, signature: signature(body, config) };
}
export function authenticateCacheEvent(body: string, supplied: string | null, config: CacheControlConfig, now = Date.now()) {
  if (Buffer.byteLength(body) > 2048 || !supplied || !/^[a-f0-9]{64}$/.test(supplied)) throw Error("CACHE_AUTH");
  if (!timingSafeEqual(Buffer.from(supplied, "hex"), Buffer.from(signature(body, config), "hex"))) throw Error("CACHE_AUTH");
  const v = JSON.parse(body);
  if (!v || Object.keys(v).sort().join() !== "generation,id,issuedAt,nonce,siteKey,version" || v.version !== 1 ||
      v.siteKey !== config.siteKey || !uuid(v.id) || !uuid(v.nonce) || !/^[1-9]\d{0,18}$/.test(v.generation) ||
      !Number.isSafeInteger(v.issuedAt) || Math.abs(now - v.issuedAt) > 120_000) throw Error("CACHE_AUTH");
  return { id: v.id as string, generation: v.generation as string };
}

export async function cachePurgeResponse(request: Request, ports: {
  enabled(): boolean; config: CacheControlConfig; read(id: string): Promise<unknown>;
  purge(tags: string[]): Promise<void>; now?: () => number;
}): Promise<Response> {
  const headers = { "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex, nofollow" };
  if (!ports.enabled()) return new Response(null, { status: 404, headers });
  if (request.method !== "POST" || !request.headers.get("content-type")?.startsWith("application/json")) return new Response(null, { status: 400, headers });
  let identity: { id: string; generation: string };
  try {
    // Enforce the byte bound even for chunked requests with no Content-Length.
    const reader = request.body?.getReader(); if (!reader) throw Error();
    const chunks: Uint8Array[] = []; let size = 0;
    try { for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.length; if (size > 2048) throw Error(); chunks.push(next.value); } }
    finally { await reader.cancel().catch(() => {}); }
    identity = authenticateCacheEvent(Buffer.concat(chunks).toString("utf8"), request.headers.get("x-nb-cache-signature"), ports.config, ports.now?.());
  } catch { return new Response(null, { status: 401, headers }); }
  try {
    const event = validateCacheEvent(await ports.read(identity.id));
    if (event.generation !== identity.generation) return new Response(null, { status: 409, headers });
    // Repeated authenticated delivery only deletes caches again; it can never publish or allow a page.
    const tags = cacheEventTags(event);
    await ports.purge(tags);
    return Response.json({ version: 1, siteKey: ports.config.siteKey, id: event.id, generation: event.generation, purged: true }, { headers });
  } catch { return Response.json({ error: { code: "CACHE_PURGE_PENDING" } }, { status: 503, headers }); }
}

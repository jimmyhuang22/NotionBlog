import { ContentServiceError } from "../../../contracts/repository.ts";
import { publicCacheKey, publicCacheTags, publicCacheWindow, type PublicCacheScope } from "./policy.ts";

export interface PublicCacheStamp { version: 1; enabled: true; stamp: string }
export function validatePublicCacheStamp(value: unknown): PublicCacheStamp {
  const v = value as PublicCacheStamp;
  if (!v || v.version !== 1 || v.enabled !== true || typeof v.stamp !== "string" || !/^[a-zA-Z0-9:._-]{1,512}$/.test(v.stamp))
    throw new ContentServiceError("CONTENT_UNAVAILABLE", "Public cache capability is not active.");
  return v;
}
export interface PublicCachePorts {
  stamp(): Promise<PublicCacheStamp>;
  read<T>(key: string, tags: string[], load: () => Promise<T>): Promise<T>;
  now?: () => number;
}
class OversizeProjection extends Error {
  readonly value: unknown;
  constructor(value: unknown) { super("Public projection is too large for the data cache."); this.value = value; }
}

/** Errors never become a cached success. Generation checks reject in-flight withdrawals. */
export async function readPublicProjection<T>(scope: PublicCacheScope, operation: string, args: unknown,
  namespace: string, ports: PublicCachePorts, load: () => Promise<T>): Promise<T> {
  const now = ports.now ?? Date.now, first = validatePublicCacheStamp(await ports.stamp()), window = publicCacheWindow(now());
  const key = publicCacheKey([namespace, scope, operation, args, first.stamp, window.bucket]);
  let entry: { value: T; stamp: string; expiresAt: number };
  try { entry = await ports.read(key, publicCacheTags(scope), async () => {
    const value = await load();
    const current = validatePublicCacheStamp(await ports.stamp());
    if (current.stamp !== first.stamp || now() >= window.expiresAt)
      throw new ContentServiceError("CONTENT_UNAVAILABLE", "Publication changed while preparing cached content.");
    if (Buffer.byteLength(JSON.stringify(value)) > 2 * 1024 * 1024 - 4096) throw new OversizeProjection(value);
    return { value, stamp: first.stamp, expiresAt: window.expiresAt };
  }); } catch (error) {
    // Preserve large valid documents without storing them or weakening generation checks.
    if (error instanceof OversizeProjection) return structuredClone(error.value) as T;
    throw error;
  }
  if (entry.stamp !== first.stamp || entry.expiresAt !== window.expiresAt || now() >= entry.expiresAt)
    throw new ContentServiceError("CONTENT_UNAVAILABLE", "Public projection cache is out of date.");
  return structuredClone(entry.value);
}

import { createHash } from "node:crypto";
import { ContentServiceError } from "../../../contracts/repository.ts";
import { cacheRouteDeployment } from "./deployment.ts";

export const PUBLIC_CACHE_VERSION = "nb-public-cache-v1";
export const PUBLIC_CACHE_DAY_MS = 86_400_000;
// Request-local response provenance, never a client-supplied header. Live source
// qualification must not be bypassed by upgrading this response to shared caching.
const excludedResponses = new WeakSet<Response>();
export function excludeFromSharedCache(response: Response): Response {
  excludedResponses.add(response);
  return response;
}
export const isSharedCacheExcluded = (response: Response): boolean => excludedResponses.has(response);
export type PublicCacheScope = "content" | "social" | "home" | "media";
export const publicCacheTag = (scope: PublicCacheScope) => `nb:public:v1:${scope}`;
export const publicCacheTags = (scope: PublicCacheScope): string[] => scope === "home"
  ? [publicCacheTag("content"), publicCacheTag("social"), publicCacheTag("home")]
  : [publicCacheTag(scope)];
export const publicCacheHash = (value: string) => createHash("sha256").update(value).digest("hex");
const fail = (): never => { throw new ContentServiceError("MISCONFIGURED", "Public cache configuration is invalid."); };

/** Use the hosting platform's supported private name; retain local operator compatibility. */
export function publicCacheSecret(env: Record<string, string | undefined> = process.env): string | undefined {
  const secret = env.CACHE_PURGE_SECRET, legacy = env.PUBLIC_CACHE_PURGE_SECRET;
  if (secret !== undefined && legacy !== undefined && secret !== legacy) return fail();
  return secret ?? legacy;
}

/** An explicit installation/activation is required; historical environments remain unchanged. */
export function publicCacheEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const mode = env.PUBLIC_CONTENT_CACHE;
  if (mode === undefined || mode === "disabled") return false;
  if (mode !== "tagged-v1" || env.CONTENT_PROVIDER !== "database" || env.DATABASE_CONTENT_VERSION !== "2" ||
      (env.DATABASE_PUBLICATION_MODE !== undefined && env.DATABASE_PUBLICATION_MODE !== "qualified") ||
      !/^[a-z0-9][a-z0-9-]{0,63}$/.test(env.PUBLIC_CACHE_SITE_KEY ?? "") || !/^[a-f0-9]{64}$/.test(publicCacheSecret(env) ?? "")) return fail();
  try {
    cacheRouteDeployment(env);
    const origin = new URL(env.PUBLIC_CACHE_ORIGIN ?? "");
    if ((origin.protocol !== "https:" && !(origin.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname))) ||
        origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) return fail();
  } catch { return fail(); }
  return true;
}

function stable(value: unknown, depth = 0): unknown {
  if (depth > 12) return fail();
  if (value === undefined) return null;
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(v => stable(v, depth + 1));
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => [k, stable(v, depth + 1)]));
  }
  return fail();
}
export function publicCacheKey(value: unknown): string {
  const encoded = JSON.stringify(stable(value));
  if (Buffer.byteLength(encoded) > 16_384) return fail();
  return publicCacheHash(encoded);
}

/** Bound the total lifetime at a fixed boundary; a second layer cannot restart a day. */
export function publicCacheWindow(now = Date.now()) {
  const bucket = Math.floor(now / PUBLIC_CACHE_DAY_MS);
  return { bucket, expiresAt: (bucket + 1) * PUBLIC_CACHE_DAY_MS };
}

export function publicResponseHeaders(scope: PublicCacheScope, now = Date.now()): Record<string, string> {
  const remaining = Math.max(0, Math.floor((publicCacheWindow(now).expiresAt - now) / 1000));
  return {
    "Cache-Control": "private, no-cache, must-revalidate",
    // Only the managed, explicitly purgeable CDN may share this public projection.
    "CDN-Cache-Control": "no-store",
    "Vercel-CDN-Cache-Control": remaining > 0 ? `public, max-age=${remaining}, must-revalidate` : "no-store",
    "Vercel-Cache-Tag": publicCacheTags(scope).join(","),
    "X-Content-Cache-Policy": PUBLIC_CACHE_VERSION,
  };
}

/** The context includes provider/config identity, never raw credentials in a cache key. */
export function publicCacheNamespace(env: Record<string, string | undefined>, site: unknown, features: unknown): string {
  return publicCacheKey({ version: PUBLIC_CACHE_VERSION, site, features, siteKey: env.PUBLIC_CACHE_SITE_KEY,
    environment: env.VERCEL_ENV ?? "local", project: env.VERCEL_PROJECT_ID ?? "local",
    deployment: env.VERCEL_DEPLOYMENT_ID ?? env.VERCEL_GIT_COMMIT_SHA ?? "local",
    // Different databases/roles and deployment configuration cannot share cache entries.
    settings: Object.fromEntries(Object.entries(env).filter(([key]) => /^(?:DATABASE_|SOCIAL_|MEDIA_|CONTENT_|SITE_)/.test(key))
      .map(([key, value]) => [key, publicCacheHash(value ?? "")])) });
}

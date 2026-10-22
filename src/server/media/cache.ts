/** User-approved browser lifetime; never permit shared caches or stale reuse past one day. */
export const MEDIA_BROWSER_CACHE_CONTROL = "private, max-age=86400, must-revalidate";
/** Mutable owner references can be stored, but every reuse must qualify at the origin. */
export const MEDIA_REVALIDATE_CACHE_CONTROL = "private, no-cache, must-revalidate";
export function revalidatedMediaHeaders(headers: Record<string, string>, etag: string): Record<string, string> {
  return { ...headers, "Cache-Control": MEDIA_REVALIDATE_CACHE_CONTROL, ETag: etag,
    "CDN-Cache-Control": "no-store", "Vercel-CDN-Cache-Control": "no-store" };
}
export function cacheableMediaHeaders(headers: Record<string, string>): Record<string, string> {
  return { ...headers,
    "Cache-Control": MEDIA_BROWSER_CACHE_CONTROL,
    "CDN-Cache-Control": "no-store",
    "Vercel-CDN-Cache-Control": "no-store",
  };
}

/** Acceptance keeps APIs/errors no-store and admits only the reviewed image exception. */
export function hasSafeMediaCachePolicy(response: Response, requestPath: string): boolean {
  const directives = (response.headers.get("Cache-Control") ?? "").toLowerCase().split(",").map(x => x.trim());
  const pathname = new URL(requestPath, "https://example.invalid").pathname;
  if (response.headers.get("X-Content-Cache-Policy") === "nb-public-cache-v1") {
    const managed = response.headers.get("Vercel-CDN-Cache-Control");
    const lifetime = /^public, max-age=(\d+), must-revalidate$/.exec(managed ?? "");
    return [200, 304].includes(response.status) &&
      /^\/media\/(?:v2\/a1\.[a-f0-9]{64}|social\/(?:s[12]\.(?:[a-f0-9]{64}|(?:publication|collection)\.[a-f0-9]{64})|s3\.(?:publication|collection)\.[a-f0-9]{64}\.[a-f0-9]{64}))$/.test(pathname) &&
      directives.sort().join(",") === "must-revalidate,no-cache,private" &&
      response.headers.get("CDN-Cache-Control") === "no-store" &&
      // The managed CDN consumes its dedicated response header in production.
      (managed === null || managed === "no-store" || (lifetime !== null && Number(lifetime[1]) > 0 && Number(lifetime[1]) <= 86400)) &&
      /^"(?:pc1|sc1)-[a-f0-9]{64}"$/.test(response.headers.get("ETag") ?? "");
  }
  const sharedCachesDisabled = ["CDN-Cache-Control", "Vercel-CDN-Cache-Control"].every(name => {
    const value = response.headers.get(name);
    return value === null || value.trim().toLowerCase() === "no-store";
  });
  if (!sharedCachesDisabled) return false;
  if (directives.includes("no-store")) return true;
  if (/^\/media\/social\/s3\.(?:publication|collection)\.[a-f0-9]{64}\.[a-f0-9]{64}$/.test(pathname)) {
    return [200, 304].includes(response.status) &&
      directives.sort().join(",") === "max-age=86400,must-revalidate,private" &&
      /^"sc1-[a-f0-9]{64}"$/.test(response.headers.get("ETag") ?? "");
  }
  if (/^\/media\/social\/s2\.(?:publication|collection)\.[a-f0-9]{64}$/.test(pathname)) {
    return [200, 304].includes(response.status) &&
      directives.sort().join(",") === "must-revalidate,no-cache,private" &&
      /^"sc1-[a-f0-9]{64}"$/.test(response.headers.get("ETag") ?? "");
  }
  if (response.status !== 200 || !/^\/media\/(?:v2\/a1|social\/s1)\.[a-f0-9]{64}$/.test(pathname) ||
      directives.sort().join(",") !== "max-age=86400,must-revalidate,private") return false;
  return true;
}

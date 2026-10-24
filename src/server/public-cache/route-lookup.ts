import { readStatusFocus } from "../../lib/status-focus.ts";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { RouteVerdict } from "../../lib/route-verdict.ts";
import type { CacheControlConfig } from "./events.ts";

export interface RouteCacheIdentity extends CacheControlConfig { deploymentId?: string }
export interface RouteCacheConfig extends RouteCacheIdentity { origin: string; oidcToken?: string }
function targetPath(value: string): string {
  if (value.length > 2048 || /[\u0000-\u0020\u007f\\#]/.test(value) ||
      !/^\/(?:about|blog|photos|projects|library|study|status)(?:\/|\?|$)/.test(value)) throw Error("ROUTE_CACHE_TARGET");
  const url = new URL(value, "https://fixed.invalid");
  if (url.origin !== "https://fixed.invalid") throw Error("ROUTE_CACHE_TARGET");
  return value;
}
/** Keep the route verdict's semantic inputs only. Invalid focus stays invalid. */
export function canonicalRouteTarget(target: string): string {
  targetPath(target);
  const url = new URL(target, "https://fixed.invalid");
  let status = false;
  try { const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent); status = parts.length === 1 && parts[0] === "status"; } catch {}
  if (!status || !url.searchParams.has("focus")) return url.pathname;
  const values = url.searchParams.getAll("focus");
  // Empty focus is already an invalid request, and is one bounded sentinel for
  // duplicate/malformed focus values. Never turn duplicate focus into a valid one.
  const focus = values.length === 1 ? readStatusFocus(values[0]) ?? "" : "";
  return `${url.pathname}?${new URLSearchParams({ focus })}`;
}
function routeSignature(target: string, at: string, config: RouteCacheIdentity) {
  if (!/^[a-f0-9]{64}$/.test(config.secret) || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(config.siteKey)) throw Error("ROUTE_CACHE_CONFIG");
  if (config.deploymentId !== undefined && !/^dpl_[a-zA-Z0-9]{8,96}$/.test(config.deploymentId)) throw Error("ROUTE_CACHE_CONFIG");
  return createHmac("sha256", Buffer.from(config.secret, "hex")).update(`nb-route-cache-v2\n${config.siteKey}\n${config.deploymentId ?? "local-fixed"}\n${at}\n${target}`).digest("hex");
}
export async function routeCacheLookupResponse(request: Request, config: RouteCacheIdentity,
  read: (path: string, query: URLSearchParams) => Promise<Exclude<RouteVerdict, "unknown">>, now = Date.now()): Promise<Response> {
  const headers = { "Cache-Control": "private, no-store" };
  let target: string;
  try {
    const params = new URL(request.url).searchParams;
    if (params.size !== 1 || params.getAll("target").length !== 1) throw Error();
    target = targetPath(params.get("target")!);
    if (request.headers.get("x-nb-route-deployment") !== (config.deploymentId ?? null)) throw Error();
    const at = request.headers.get("x-nb-route-time") ?? "", sig = request.headers.get("x-nb-route-signature") ?? "";
    if (!/^\d{1,16}$/.test(at) || Math.abs(now - Number(at)) > 30_000 || !/^[a-f0-9]{64}$/.test(sig) ||
        !timingSafeEqual(Buffer.from(sig, "hex"), Buffer.from(routeSignature(target, at, config), "hex"))) throw Error();
  } catch { return new Response(null, { status: 401, headers }); }
  try {
    const url = new URL(canonicalRouteTarget(target), "https://fixed.invalid"), verdict = await read(url.pathname, url.searchParams);
    return Response.json({ version: 1, verdict, deploymentId: config.deploymentId ?? null }, { headers });
  } catch { return new Response(null, { status: 503, headers }); }
}

/** The middleware calls one configured origin/path; request Host can never select a destination. */
export async function fetchCachedRouteVerdict(target: string, config: RouteCacheConfig, request: typeof fetch = fetch): Promise<Exclude<RouteVerdict, "unknown">> {
  target = canonicalRouteTarget(target);
  const origin = new URL(config.origin);
  if ((origin.protocol !== "https:" && !(origin.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname))) ||
      origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) throw Error("ROUTE_CACHE_CONFIG");
  const url = new URL("/api/internal/cache/route", origin);
  url.searchParams.set("target", target);
  const at = String(Date.now());
  const headers: Record<string, string> = { "x-nb-route-time": at, "x-nb-route-signature": routeSignature(target, at, config) };
  if (config.deploymentId) {
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.vercel\.app$/.test(origin.hostname) || !config.oidcToken || config.oidcToken.length > 16_384 || /\s/.test(config.oidcToken)) throw Error("ROUTE_CACHE_IDENTITY");
    headers["x-nb-route-deployment"] = config.deploymentId;
    headers["x-vercel-trusted-oidc-idp-token"] = config.oidcToken;
  } else if (config.oidcToken) throw Error("ROUTE_CACHE_IDENTITY");
  const response = await request(url, { cache: "no-store", redirect: "error", signal: AbortSignal.timeout(6000),
    headers });
  if (response.status !== 200) { await response.body?.cancel(); throw Error("ROUTE_CACHE_UNAVAILABLE"); }
  const reader = response.body?.getReader(); if (!reader) throw Error("ROUTE_CACHE_UNAVAILABLE");
  const chunks: Uint8Array[] = []; let bytes = 0;
  try { for (;;) { const next = await reader.read(); if (next.done) break; bytes += next.value.length; if (bytes > 2048) throw Error("ROUTE_CACHE_RESPONSE"); chunks.push(next.value); } }
  finally { await reader.cancel().catch(() => {}); }
  const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!value || value.version !== 1 || !["found", "missing"].includes(value.verdict)) throw Error("ROUTE_CACHE_RESPONSE");
  if ((value.deploymentId ?? null) !== (config.deploymentId ?? null)) throw Error("ROUTE_CACHE_DEPLOYMENT");
  return value.verdict;
}

import { readStatusFocus } from "../../lib/status-focus.ts";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { RouteVerdict } from "../../lib/route-verdict.ts";
import type { CacheControlConfig } from "./events.ts";

export interface RouteCacheIdentity extends CacheControlConfig { deploymentId?: string }
export interface RouteCacheConfig extends RouteCacheIdentity { origin: string; oidcToken?: string }
function targetPath(value: string): string {
  if (typeof value !== "string" || value.length > 2048 || /[\u0000-\u0020\u007f\\#]/.test(value) ||
      !value.startsWith("/") || value.startsWith("//")) throw Error("ROUTE_CACHE_TARGET");
  const url = new URL(value, "https://fixed.invalid");
  if (url.origin !== "https://fixed.invalid") throw Error("ROUTE_CACHE_TARGET");
  return value;
}
export type ClassifiedRouteTarget = { kind: "managed" | "missing"; target: string };
const invalidTarget: ClassifiedRouteTarget = { kind: "missing", target: "/status?focus=" };

/** Match qualification's one decode and empty-segment semantics, without reads. */
export function classifyRouteTarget(target: string): ClassifiedRouteTarget {
  targetPath(target);
  const url = new URL(target, "https://fixed.invalid");
  let parts: string[];
  try { parts = url.pathname.split("/").filter(Boolean).map(part => decodeURIComponent(part)); }
  catch { return { ...invalidTarget }; }
  if (parts.some(part => /[\/\\\u0000-\u001f\u007f-\u009f]/u.test(part))) return { ...invalidTarget };
  const path = `/${parts.map(part => encodeURIComponent(part)).join("/")}`;
  if (path.length > 2048) return { ...invalidTarget };
  const [section, slug, child] = parts;
  const managed = section === "about" ? parts.length === 1
    : ["blog", "photos", "projects"].includes(section) ? parts.length <= 2
    : section === "library" ? ["games", "movies", "books"].includes(slug) && (parts.length === 2 || parts.length === 3)
    : section === "study" ? parts.length === 1 || parts.length === 2 ||
      (parts.length === 4 && child === "notes") ||
      (parts.length === 3 && slug === "projects" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(child))
    : section === "status" && parts.length === 1;
  if (!managed) return { kind: "missing", target: path };
  if (section !== "status" || !url.searchParams.has("focus")) return { kind: "managed", target: path };
  const values = url.searchParams.getAll("focus");
  const focus = values.length === 1 ? readStatusFocus(values[0]) : null;
  if (!focus) return { ...invalidTarget };
  return { kind: "managed", target: `${path}?${new URLSearchParams({ focus })}` };
}
/** Compatibility helper; eligibility callers must also honor the classification. */
export function canonicalRouteTarget(target: string): string {
  return classifyRouteTarget(target).target;
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
    const classified = classifyRouteTarget(target);
    if (classified.kind === "missing") return Response.json({ version: 1, verdict: "missing", deploymentId: config.deploymentId ?? null }, { headers });
    const url = new URL(classified.target, "https://fixed.invalid"), verdict = await read(url.pathname, url.searchParams);
    return Response.json({ version: 1, verdict, deploymentId: config.deploymentId ?? null }, { headers });
  } catch { return new Response(null, { status: 503, headers }); }
}

/** The middleware calls one configured origin/path; request Host can never select a destination. */
export async function fetchCachedRouteVerdict(target: string, config: RouteCacheConfig, request: typeof fetch = fetch): Promise<Exclude<RouteVerdict, "unknown">> {
  const classified = classifyRouteTarget(target);
  target = classified.target;
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
  if (classified.kind === "missing") return "missing";
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

import { createHmac } from "node:crypto";
import { isIP } from "node:net";
import { analyticsPath, analyticsReferrer } from "../../lib/visitor-analytics.ts";
import { createSearchLimiter } from "../search-rate-limit.ts";
import { visitorAnalyticsConfig } from "./config.ts";

const limiter = createSearchLimiter({ perClient: { capacity: 30, refillPerSecond: 0.5 },
  instance: { capacity: 120, refillPerSecond: 10 }, maxConcurrent: 8, maxClients: 2000 });
const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
const reply = (status: number) => new Response(null, { status, headers });

export async function boundedJson(body: ReadableStream<Uint8Array> | null, limit: number, signal: AbortSignal): Promise<unknown> {
  if (!body) throw Error("EMPTY_BODY");
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const item = await reader.read();
      signal.throwIfAborted();
      if (item.done) break;
      size += item.value.byteLength;
      if (size > limit) throw Error("BODY_LIMIT");
      chunks.push(item.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally { signal.removeEventListener("abort", cancel); cancel(); }
}

export async function collectVisitor(request: Request, env: Record<string, string | undefined> = process.env, send: typeof fetch = fetch): Promise<Response> {
  const config = visitorAnalyticsConfig(env);
  if (!config) return reply(404);
  const origin = request.headers.get("origin") ?? "";
  if (!config.origins.includes(origin) ||
      ![null, "same-origin"].includes(request.headers.get("sec-fetch-site")) ||
      request.headers.get("content-type")?.split(";", 1)[0].trim() !== "application/json") return reply(403);
  if (request.headers.get("dnt") === "1" || request.headers.get("sec-gpc") === "1") return reply(204);
  // The configured header must be overwritten by the trusted ingress. Never fall back to forwarded chains.
  const ip = request.headers.get(config.clientIpHeader) ?? "";
  if (!isIP(ip)) return reply(400);
  if (Number(request.headers.get("content-length")) > 8192) return reply(413);
  const admission = limiter.admit(createHmac("sha256", config.secret).update(ip).digest("hex"));
  if ("retryAfterSeconds" in admission) return reply(429);
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(3000)]);
  try {
    let input: unknown;
    try { input = await boundedJson(request.body, 8192, signal); } catch { return reply(400); }
    if (!input || typeof input !== "object" || Array.isArray(input)) return reply(400);
    const v = input as Record<string, unknown>;
    if (Object.keys(v).some(key => !["path", "referrer", "language", "cache"].includes(key))) return reply(400);
    const path = analyticsPath(v.path);
    if (!path || typeof v.language !== "string" || !/^[a-zA-Z0-9-]{0,35}$/.test(v.language) ||
        v.cache !== undefined && (typeof v.cache !== "string" || v.cache.length > 4096 || !/^[a-zA-Z0-9_.-]+$/.test(v.cache))) return reply(400);
    const upstream = await send(config.endpoint, {
      method: "POST", redirect: "error", cache: "no-store", signal,
      headers: { "Content-Type": "application/json", "X-Analytics-Key": config.secret,
        "X-Analytics-Client-IP": ip, "User-Agent": (request.headers.get("user-agent") ?? "").slice(0, 512),
        ...(v.cache ? { "X-Umami-Cache": String(v.cache) } : {}) },
      body: JSON.stringify({ type: "event", payload: { website: config.websiteId,
        hostname: config.hostname, url: path, referrer: analyticsReferrer(v.referrer, origin),
        language: v.language, tag: config.node } }),
    });
    if (!upstream.ok) { await upstream.body?.cancel(); return reply(503); }
    const result = await boundedJson(upstream.body, 8192, signal) as Record<string, unknown>;
    return Response.json({ ...(result && typeof result.cache === "string" && result.cache.length <= 4096 ? { cache: result.cache } : {}) }, { headers });
  } catch { return reply(503); } // Do not log URLs, tokens, IPs or event bodies.
  finally { admission.release(); }
}

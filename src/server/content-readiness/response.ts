import { timingSafeEqual } from "node:crypto";
import type { ContentRepository } from "../../../contracts/repository.ts";
import { checkContentReadBudget, withContentReadBudget } from "../content-read-budget.ts";
import { READINESS_FORMAT, readinessNonce, readinessUuid, validReadinessSample } from "./protocol.ts";
import { probeContentReadiness } from "./probe.ts";

const headers = { "Cache-Control": "private, no-store", "CDN-Cache-Control": "no-store", "Vercel-CDN-Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" };
let inFlight = false;
async function requestBody(request: Request, signal: AbortSignal) {
  if (request.headers.get("content-type")?.split(";")[0].trim() !== "application/json" ||
    request.headers.has("content-encoding") || Number(request.headers.get("content-length") ?? 0) > 1024 || !request.body) throw Error();
  const reader = request.body.getReader(), chunks: Uint8Array[] = [];
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    if (signal.aborted) throw Error();
    let size = 0;
    for (;;) {
      const part = await reader.read();
      if (signal.aborted) throw Error();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 1024) throw Error();
      chunks.push(part.value);
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  } finally { signal.removeEventListener("abort", abort); await reader.cancel(); }
}

export async function privateContentReadinessResponse(request: Request, env: Record<string, string | undefined>, load: () => Promise<ContentRepository>) {
  const secret = env.CONTENT_READINESS_SECRET, supplied = request.headers.get("authorization") ?? "";
  if (!readinessNonce(secret) || !/^Bearer [a-f0-9]{64}$/.test(supplied) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(`Bearer ${secret}`)))
    return new Response(null, { status: 404, headers });
  if (request.method !== "POST") return new Response(null, { status: 405, headers });
  const url = new URL(request.url);
  if (url.search || inFlight) return new Response(null, { status: 503, headers });
  // One probe per warm instance; this is not a global rate limiter or a project quota.
  inFlight = true;
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(8000)]);
  const work = (async () => {
  try {
    const body = await requestBody(request, signal);
    if (!body || Object.keys(body).length !== 4 || body.format !== READINESS_FORMAT || !readinessUuid(body.runId) || !readinessNonce(body.nonce) || !validReadinessSample(body.sample))
      return new Response(null, { status: 400, headers });
    if (env.CONTENT_PROVIDER !== "database" || env.DATABASE_CONTENT_VERSION !== "2" || env.DATABASE_PUBLICATION_MODE !== "published" || env.DATABASE_TLS === "disable") throw Error();
    await withContentReadBudget(signal, async () => {
      const repository = await load(); checkContentReadBudget();
      await probeContentReadiness(repository, body.runId, body.sample);
    },
      { timeoutMs: 8000, maxQueries: 8, maxResponseBytes: 256 * 1024 });
    return Response.json({ data: { format: READINESS_FORMAT, status: "ready", runId: body.runId, nonce: body.nonce } }, { headers });
  } catch { return new Response(null, { status: 503, headers }); }
  })();
  // A timed-out caller returns promptly; a still-draining probe retains admission.
  void work.then(() => { inFlight = false; }, () => { inFlight = false; });
  let abort!: () => void;
  const stopped = new Promise<Response>(resolve => {
    abort = () => resolve(new Response(null, { status: 503, headers }));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
  try { return await Promise.race([work, stopped]); }
  finally { signal.removeEventListener("abort", abort); }
}

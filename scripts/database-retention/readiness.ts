import { randomBytes } from "node:crypto";
import { READINESS_FORMAT, READINESS_PATH, readinessNonce, readinessUuid, validReadinessSample, type ReadinessSample } from "../../src/server/content-readiness/protocol.ts";
export function retentionReadinessURL(target: string): URL {
  let url: URL;
  try { url = new URL(target); } catch { throw Error("RETENTION_READINESS_INPUT_INVALID"); }
  if (url.protocol !== "https:" || url.pathname !== READINESS_PATH || url.search || url.hash || url.username || url.password)
    throw Error("RETENTION_READINESS_INPUT_INVALID");
  return url;
}
/** No legacy/public fallback, redirects or retries. A different nonce is sent for each proof. */
export async function verifyRetentionReadiness(target: string, secret: string | undefined, runId: string, sample: ReadinessSample,
  fetcher: typeof fetch = fetch, signal?: AbortSignal) {
  const url = retentionReadinessURL(target);
  if (!readinessNonce(secret) || !readinessUuid(runId) || !validReadinessSample(sample)) throw Error("RETENTION_READINESS_INPUT_INVALID");
  const nonce = randomBytes(32).toString("hex");
  const combined = AbortSignal.any([AbortSignal.timeout(10_000), ...(signal ? [signal] : [])]);
  combined.throwIfAborted();
  const response = await fetcher(url, { method: "POST", signal: combined, redirect: "error",
    headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json", "Cache-Control": "no-store" },
    body: JSON.stringify({ format: READINESS_FORMAT, runId, nonce, sample }) });
  const reader = response.body?.getReader();
  const abort = () => { void reader?.cancel().catch(() => {}); };
  combined.addEventListener("abort", abort, { once: true });
  try {
    combined.throwIfAborted();
    if (response.status !== 200 || !reader || !/(?:^|,)\s*no-store\s*(?:,|$)/i.test(response.headers.get("cache-control") ?? "") ||
      response.headers.get("content-type")?.split(";")[0].trim() !== "application/json") throw Error("RETENTION_READINESS_FAILED");
    let bytes = 0;
    const chunks: Uint8Array[] = [];
    for (;;) {
      const part = await reader.read();
      combined.throwIfAborted();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 4096) throw Error("RETENTION_READINESS_TOO_LARGE");
      chunks.push(part.value);
    }
    let body;
    try { body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); } catch { throw Error("RETENTION_READINESS_FAILED"); }
    if (!body || Object.keys(body).length !== 1 || !body.data || Object.keys(body.data).length !== 4 ||
      body.data.format !== READINESS_FORMAT || body.data.status !== "ready" || body.data.runId !== runId || body.data.nonce !== nonce) throw Error("RETENTION_READINESS_FAILED");
  } finally { combined.removeEventListener("abort", abort); await reader?.cancel(); }
}

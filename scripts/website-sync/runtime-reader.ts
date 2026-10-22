import { setTimeout as delay } from "node:timers/promises";
import { createNotionClient, type NotionClientOptions } from "../../src/server/notion/client.ts";
import { NotionRequestScheduler } from "../../src/server/notion/request-scheduler.ts";
import { WorkerError, checkSignal } from "../notion-sync/errors.ts";

const networkCodes = new Set(["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "ENETUNREACH", "EHOSTUNREACH", "EAI_AGAIN", "ABORT_ERR", "ERR_STREAM_PREMATURE_CLOSE", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"]);
function networkFailure(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as { name?: string; code?: string; cause?: unknown };
  return e.name === "TimeoutError" || networkCodes.has(e.code ?? "") || (e.cause !== error && networkFailure(e.cause));
}
/** Runtime-only cancellation, bounded bodies and observed retries; website SDK behavior is unchanged. */
export function createRuntimeNotionReader(options: Pick<NotionClientOptions, "token" | "notionVersion">, signal: AbortSignal,
  ports: { fetch?: typeof fetch; scheduler?: NotionRequestScheduler; intervalMs?: number; wait?: (ms: number, signal: AbortSignal) => Promise<void> } = {}) {
  const intervalMs = ports.intervalMs ?? 700;
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 350 || intervalMs > 5000) throw new WorkerError("MISCONFIGURED");
  const scheduler = ports.scheduler ?? new NotionRequestScheduler({ intervalMs });
  // The worker's AbortSignal enforces its configured run budget. Queue cooldowns
  // must not inherit the interactive client's nine/ten-second deadlines.
  const cooldownBudgetMs = 5_400_000;
  const metrics = { requests: 0, receivedBodyBytes: 0, retries: 0, rateLimitResponses: 0, lastRetryAfterSeconds: null as number | null };
  const attemptsByMethod: Record<string, number> = {};
  let failure: { method: string; id: string; attempt: number; httpStatus?: number; networkFailure: boolean } | undefined;
  const methods = Object.keys(createNotionClient(options));
  const client = Object.fromEntries(methods.map(method => [method, async (id: string) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      checkSignal(signal); let observed: { network: boolean; status?: number } = { network: false };
      const transport: NonNullable<NotionClientOptions["fetch"]> = (url, init) => scheduler.run(async scheduled => {
        checkSignal(signal); const endpoint = new URL(String(url));
        if (endpoint.origin !== "https://api.notion.com") throw new WorkerError("MISCONFIGURED");
        const observation: typeof observed = { network: false }; observed = observation;
        const requestSignal = (init as { signal?: AbortSignal } | undefined)?.signal;
        const combined = AbortSignal.any([signal, scheduled, AbortSignal.timeout(8000), ...(requestSignal ? [requestSignal] : [])]);
        try {
          metrics.requests++;
          attemptsByMethod[method] = (attemptsByMethod[method] ?? 0) + 1;
          const response = await (ports.fetch ?? fetch)(url, { ...init, signal: combined, redirect: "error" });
          observation.status = response.status;
          if (response.status === 429 || response.status === 529) {
            const retryAfter = response.headers.get("retry-after") ?? "1";
            scheduler.defer(retryAfter);
            metrics.rateLimitResponses++;
            metrics.lastRetryAfterSeconds = /^\d+$/u.test(retryAfter.trim()) && Number.isSafeInteger(Number(retryAfter)) ? Number(retryAfter) : null;
          }
          const reader = response.body?.getReader(), parts: Uint8Array[] = []; let size = 0;
          if (reader) try {
            while (true) { const { value, done } = await reader.read(); if (done) break; checkSignal(combined);
              size += value.length; metrics.receivedBodyBytes += value.length;
              if (size > 2 * 1024 * 1024) throw new WorkerError("CONTENT_UNAVAILABLE"); parts.push(value); }
          } catch (error) { await reader.cancel().catch(() => {}); throw error; }
          return new Response(parts.length ? Buffer.concat(parts) : null, { status: response.status, statusText: response.statusText, headers: response.headers });
        } catch (error) { observation.network = networkFailure(error); throw error; }
      }, { signal, timeoutMs: cooldownBudgetMs });
      const operation = createNotionClient({ ...options, fetch: transport, requestTimeoutMs: cooldownBudgetMs }) as unknown as Record<string, (id: string) => Promise<unknown>>;
      try { const result = await operation[method](id); checkSignal(signal); return result; }
      catch (error) {
        checkSignal(signal);
        const denied = observed.status !== undefined && observed.status >= 400 && observed.status < 500;
        const transient = !denied && (observed.network || [500, 502, 503, 504].includes(observed.status ?? 0));
        if (attempt === 2 || !transient || (error as { code?: string }).code !== "CONTENT_UNAVAILABLE") {
          failure = { method, id, attempt: attempt + 1, httpStatus: observed.status, networkFailure: observed.network };
          throw error;
        }
        metrics.retries++; await (ports.wait ?? (async (ms, signal) => { await delay(ms, undefined, { signal }); }))(attempt === 0 ? 2000 : 5000, signal);
      }
    }
    throw new WorkerError("CONTENT_UNAVAILABLE");
  }])) as unknown as ReturnType<typeof createNotionClient>;
  // Method identities stay separate from numeric progress and console output.
  return { client, statistics: () => ({ ...metrics, intervalMs, attemptsByMethod: { ...attemptsByMethod } }), failure: () => failure && ({ ...failure }) };
}

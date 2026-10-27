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
export function createRuntimeNotionReader(options: Pick<NotionClientOptions, "token" | "notionVersion" | "retry"> & { readRetry?: "transient-request-v1" }, signal: AbortSignal,
  ports: { fetch?: typeof fetch; scheduler?: NotionRequestScheduler; intervalMs?: number; wait?: (ms: number, signal: AbortSignal) => Promise<void> } = {}) {
  if (options.readRetry !== undefined && (options.readRetry !== "transient-request-v1" || options.retry !== false)) throw new WorkerError("MISCONFIGURED");
  const requestRetries = options.readRetry === "transient-request-v1";
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
    for (let attempt = 0; attempt < (options.retry === false ? 1 : 3); attempt++) {
      checkSignal(signal); let observed: { network: boolean; status?: number } = { network: false };
      let wireAttempt = 1;
      const transport: NonNullable<NotionClientOptions["fetch"]> = async (url, init) => {
        const endpoint = new URL(String(url));
        if (endpoint.origin !== "https://api.notion.com" || endpoint.username || endpoint.password) throw new WorkerError("MISCONFIGURED");
        // POST is admitted only for the SDK's read-only data-source query.
        const routes: Record<string, string> = { getPage: "pages/", getBlock: "blocks/", getDataSource: "data_sources/",
          getDatabase: "databases/", listBlocks: "blocks/", listPages: "data_sources/" };
        const suffix = method === "listBlocks" ? "/children" : method === "listPages" ? "/query" : "";
        const expectedPath = `/v1/${routes[method]}${id.replaceAll("-", "").toLowerCase()}${suffix}`;
        const verb = (init?.method ?? "GET").toUpperCase();
        if (requestRetries && (!routes[method] || endpoint.pathname.replaceAll("-", "").toLowerCase() !== expectedPath ||
          verb !== (method === "listPages" ? "POST" : "GET") ||
          (method === "listPages" ? typeof init?.body !== "string" : init?.body != null))) throw new WorkerError("MISCONFIGURED");
        const headers = requestRetries ? new Headers(init?.headers as HeadersInit) : undefined;
        const body = init?.body;
        for (let requestAttempt = 0; ; requestAttempt++) {
          wireAttempt = requestAttempt + 1;
          const observation = { network: false, status: undefined as number | undefined, bodyRejected: false }; observed = observation;
          try {
            const response = await scheduler.run(async scheduled => {
              checkSignal(signal);
              const requestSignal = (init as { signal?: AbortSignal } | undefined)?.signal;
              const combined = AbortSignal.any([signal, scheduled, AbortSignal.timeout(8000), ...(requestSignal ? [requestSignal] : [])]);
              try {
                if (requestRetries && requestAttempt > 0) metrics.retries++;
                metrics.requests++; attemptsByMethod[method] = (attemptsByMethod[method] ?? 0) + 1;
                const received = await (ports.fetch ?? fetch)(url, { ...init, body,
                  ...(headers ? { headers: new Headers(headers) } : {}), signal: combined, redirect: "error" });
                observation.status = received.status;
                if (received.status === 429 || received.status === 529) {
                  const retryAfter = received.headers.get("retry-after") ?? "1";
                  scheduler.defer(retryAfter); metrics.rateLimitResponses++;
                  metrics.lastRetryAfterSeconds = /^\d+$/u.test(retryAfter.trim()) && Number.isSafeInteger(Number(retryAfter)) ? Number(retryAfter) : null;
                }
                const reader = received.body?.getReader(), parts: Uint8Array[] = []; let size = 0;
                if (reader) try {
                  while (true) {
                    const { value, done } = await reader.read(); if (done) break; checkSignal(combined);
                    size += value.length; metrics.receivedBodyBytes += value.length;
                    if (size > 2 * 1024 * 1024) { observation.bodyRejected = true; throw new WorkerError("CONTENT_UNAVAILABLE"); }
                    parts.push(value);
                  }
                } catch (error) { await reader.cancel().catch(() => {}); throw error; }
                return new Response(parts.length ? Buffer.concat(parts) : null, { status: received.status, statusText: received.statusText, headers: received.headers });
              } catch (error) { observation.network = networkFailure(error); throw error; }
            }, { signal, timeoutMs: cooldownBudgetMs });
            if (!requestRetries || requestAttempt === 2 || ![500, 502, 503, 504].includes(response.status)) return response;
            await response.body?.cancel();
          } catch (error) {
            checkSignal(signal);
            if (!requestRetries || requestAttempt === 2 || observation.bodyRejected || !observation.network) throw error;
          }
          checkSignal(signal);
          await (ports.wait ?? (async (ms, signal) => { await delay(ms, undefined, { signal }); }))(requestAttempt === 0 ? 2000 : 5000, signal);
        }
      };
      const operation = createNotionClient({ ...options, fetch: transport, requestTimeoutMs: cooldownBudgetMs }) as unknown as Record<string, (id: string) => Promise<unknown>>;
      try { const result = await operation[method](id); checkSignal(signal); return result; }
      catch (error) {
        checkSignal(signal);
        const denied = observed.status !== undefined && observed.status >= 400 && observed.status < 500;
        const transient = !denied && (observed.network || [500, 502, 503, 504].includes(observed.status ?? 0));
        if (options.retry === false || attempt === 2 || !transient || (error as { code?: string }).code !== "CONTENT_UNAVAILABLE") {
          failure = { method, id, attempt: requestRetries ? wireAttempt : attempt + 1, httpStatus: observed.status, networkFailure: observed.network };
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

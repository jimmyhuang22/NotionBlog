import { diagnosticError, diagnosticRequest, diagnosticResponse, logCollectionDiagnostic } from "./failure-diagnostics.ts";
import { Client, LogLevel } from "@notionhq/client";
import { createNotionClient } from "../../src/server/notion/client.ts";
import { sharedNotionScheduler, type NotionRequestScheduler } from "../../src/server/notion/request-scheduler.ts";
import type { DirectoryNotionClient } from "./discovery.ts";
import { hostAwait, type HostBudget } from "./host-budget.ts";

/** Both the existing body reader and paged directory SDK share one charged,
 * cancellable transport and the existing token-scoped request scheduler. */
export function createIncrementalNotionTransport(options: { token: string; notionVersion?: string; budget: HostBudget;
  signal?: AbortSignal; fetch?: typeof fetch; scheduler?: NotionRequestScheduler }) {
  const { budget } = options, scheduler = options.scheduler ?? sharedNotionScheduler(options.token);
  const rawFetch = options.fetch ?? fetch;
  let attempt = 0;
  function clients(operation: AbortSignal) {
  const combined = AbortSignal.any([budget.signal, operation]);
  const transport: typeof fetch = async (url, init) => {
    const started = performance.now(), sequence = ++attempt, request = diagnosticRequest(url);
    let responseInfo: ReturnType<typeof diagnosticResponse> | undefined;
    let stage = "scheduler";
    try { return await scheduler.run(async scheduled => {
    combined.throwIfAborted();
    budget.charge("sourceRequests", 1);
    stage = "fetch";
    const response = await rawFetch(url, { ...init, signal: AbortSignal.any([combined, scheduled, ...(init?.signal ? [init.signal] : [])]) });
    responseInfo = diagnosticResponse(response); stage = "body";
    budget.guard(); combined.throwIfAborted();
    if (response.status === 429 || response.status === 529) scheduler.defer(response.headers.get("retry-after"));
    if (!response.body) {
      if (response.status >= 400) logCollectionDiagnostic("notion-request", { ...request, attempt: sequence, stage, elapsedMs: Math.round(performance.now() - started), ...responseInfo });
      return response;
    }
    const stream = response.body.getReader(), chunks: Uint8Array[] = [];
    try {
      while (true) { budget.guard(); combined.throwIfAborted(); const next = await stream.read(); if (next.done) break;
        budget.observe("sourceBytes", next.value.length); combined.throwIfAborted(); chunks.push(next.value); }
    } catch (e) { await stream.cancel().catch(() => {}); throw e; }
    budget.guard();
    const bytes = Buffer.concat(chunks);
    if (response.status >= 400) logCollectionDiagnostic("notion-request", { ...request, attempt: sequence, stage,
      elapsedMs: Math.round(performance.now() - started), ...diagnosticResponse(response, bytes) });
    return new Response(bytes, { status: response.status, statusText: response.statusText, headers: response.headers });
  }, { signal: combined, timeoutMs: 9000 });
    } catch (error) {
      logCollectionDiagnostic("notion-request", { ...request, attempt: sequence, stage, elapsedMs: Math.round(performance.now() - started),
        ...responseInfo, ...diagnosticError(error), operationCancelled: operation.aborted, budget: budget.statistics() });
      throw error;
    }
  };
  const client = createNotionClient({ token: options.token, notionVersion: options.notionVersion, fetch: transport });
  const sdk = new Client({ auth: options.token, notionVersion: options.notionVersion ?? "2026-03-11", fetch: transport,
    timeoutMs: 10000, retry: { maxRetries: 2, initialRetryDelayMs: 250, maxRetryDelayMs: 60000 }, logLevel: LogLevel.ERROR, logger: () => {} });
  return { client, sdk };
  }
  const client = clients(options.signal ?? budget.signal).client;
  const directory: DirectoryNotionClient = {
    getDataSource: (id, signal) => hostAwait(budget, () => clients(signal).client.getDataSource(id), signal),
    queryDataSource: (input, signal) => hostAwait(budget, () => clients(signal).sdk.dataSources.query(input), signal),
  };
  return { client, directory };
}

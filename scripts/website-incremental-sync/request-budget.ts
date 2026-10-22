import https from "node:https";
import { syncBuiltinESMExports } from "node:module";

export interface RequestLimits { notion: number; storage: number; imageOrigin: number; total: number }
export class RequestBudgetError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.code = code; this.name = "RequestBudgetError"; }
}
export interface RequestBudgetOptions {
  limits: RequestLimits; storageOrigin: string; deadline: number;
  transport?: typeof fetch;
}

/** Additional request-attempt ceiling, independent of the host's byte and SQL
 * budgets. Reserve synchronously, including failed attempts; never refund. */
export function createRequestBudget(options: RequestBudgetOptions) {
  const limits = { ...options.limits }, names = ["notion", "storage", "imageOrigin", "total"] as const;
  if (names.some(key => !Number.isSafeInteger(limits[key]) || limits[key] < 0) ||
    !Number.isSafeInteger(options.deadline)) throw new RequestBudgetError("HTTP_BUDGET_INPUT_INVALID");
  const origin = new URL(options.storageOrigin);
  if (origin.protocol !== "https:" || origin.origin !== options.storageOrigin || origin.username || origin.password ||
    origin.origin === "https://api.notion.com") throw new RequestBudgetError("HTTP_BUDGET_INPUT_INVALID");
  const transport = options.transport ?? globalThis.fetch, controller = new AbortController();
  const counters: RequestLimits = { notion: 0, storage: 0, imageOrigin: 0, total: 0 };
  const started = performance.now(), remaining = Math.max(0, options.deadline - Date.now());
  let failure: string | null = null, closed = false;
  const abort = (code: string) => { failure ??= code; controller.abort(); };
  const fail = (code: string): never => { abort(code); throw new RequestBudgetError(failure!); };
  const timer = setTimeout(() => abort("HTTP_BUDGET_DEADLINE"), Math.max(1, remaining)); timer.unref();
  function guard() {
    if (closed) fail("HTTP_BUDGET_CLOSED");
    if (Date.now() >= options.deadline || performance.now() - started >= remaining) fail("HTTP_BUDGET_DEADLINE");
    if (failure) fail(failure);
  }
  function reserve(input: string | URL | Request, method = "GET") {
    guard(); let url: URL;
    try { url = new URL(typeof input === "string" || input instanceof URL ? input : input.url); }
    catch { return fail("HTTP_BUDGET_URL_INVALID"); }
    if (url.protocol !== "https:" || url.username || url.password || url.hash) fail("HTTP_BUDGET_URL_INVALID");
    const kind = url.origin === "https://api.notion.com" ? "notion" : url.origin === origin.origin ? "storage" : "imageOrigin";
    if (kind === "imageOrigin" && method.toUpperCase() !== "GET") fail("HTTP_BUDGET_URL_INVALID");
    if (counters.total >= limits.total || counters[kind] >= limits[kind]) fail("HTTP_BUDGET_REQUEST_LIMIT");
    counters.total++; counters[kind]++;
  }
  const boundedFetch: typeof fetch = async (input, init) => {
    reserve(input, init?.method ?? (input instanceof Request ? input.method : "GET"));
    const signals = [controller.signal, init?.signal, input instanceof Request ? input.signal : undefined].filter((s): s is AbortSignal => !!s);
    // Automatic fetch redirects are hidden transports. Refuse them; the actual
    // image downloader already follows redirects through counted HTTPS calls.
    const response = await transport(input, { ...init, redirect: "error", signal: AbortSignal.any(signals) });
    guard(); return response;
  };
  return { fetch: boundedFetch, reserve, guard, signal: controller.signal,
    statistics: () => ({ ...counters, failure, closed }),
    cancel() { abort("HTTP_BUDGET_CANCELLED"); },
    close() { closed = true; clearTimeout(timer); controller.abort(); } };
}
export type RequestBudget = ReturnType<typeof createRequestBudget>;

/** Preserve the existing downloader's pinned IP, logical Host/SNI, TLS, body,
 * callback and return value. Never substitute a hostname-based fetch. */
export function createBudgetRequest(budget: RequestBudget, transport: typeof https.request): typeof https.request {
  return ((first: string | URL | https.RequestOptions, second?: https.RequestOptions | ((response: import("node:http").IncomingMessage) => void),
    third?: (response: import("node:http").IncomingMessage) => void) => {
    const urlInput = typeof first === "string" || first instanceof URL;
    const options: https.RequestOptions = { ...(urlInput ? typeof second === "object" ? second : {} : first) };
    const callback = urlInput ? typeof second === "function" ? second : third : second;
    const headers = options.headers as Record<string, unknown> | undefined;
    const authority = options.servername || headers?.Host || headers?.host || options.hostname || options.host;
    if (options.protocol && options.protocol !== "https:") throw new RequestBudgetError("HTTP_BUDGET_URL_INVALID");
    budget.reserve(urlInput ? new URL(first) : new URL(`https://${String(authority)}${options.path ?? "/"}`), options.method ?? "GET");
    options.signal = AbortSignal.any([budget.signal, ...(options.signal ? [options.signal] : [])]);
    return urlInput ? Reflect.apply(transport, https, [first, options, callback]) : Reflect.apply(transport, https, [options, callback]);
  }) as typeof https.request;
}

/** Must be installed before dynamically importing the actual CLI and SDK.
 * Scope: existing fetch/native HTTPS ports, not a general network sandbox. */
export function installRequestBudget(options: RequestBudgetOptions & { nativeTransport?: typeof https.request }) {
  const originalFetch = globalThis.fetch, originalRequest = https.request, originalGet = https.get;
  const budget = createRequestBudget({ ...options, transport: options.transport ?? originalFetch });
  const request = createBudgetRequest(budget, options.nativeTransport ?? originalRequest);
  const get: typeof https.get = ((...args: unknown[]) => { const req = Reflect.apply(request, https, args); req.end(); return req; }) as typeof https.get;
  globalThis.fetch = budget.fetch; https.request = request; https.get = get; syncBuiltinESMExports();
  return { ...budget, restore() {
    budget.close();
    if (globalThis.fetch === budget.fetch) globalThis.fetch = originalFetch;
    if (https.request === request) https.request = originalRequest;
    if (https.get === get) https.get = originalGet;
    syncBuiltinESMExports();
  } };
}

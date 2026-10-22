import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import pg from "pg";
import { budgetFail, SharedBudgetError, type SharedBudget, type SharedLimits } from "./shared-budget.ts";

const FAIL_RUN = "SELECT nb_v2_api.fail_run($1,$2) AS result";
type QueryPort = { query: (...args: unknown[]) => unknown };
interface Ports { fetch?: typeof fetch; request?: typeof https.request; sql?: QueryPort[] }

/** Opt-in instrumentation of the qualified worker's existing fetch, HTTPS and
 * pg ports, not a network sandbox. Install before SDK/worker/session imports. */
export function installSharedTransports(budget: SharedBudget, ports: Ports = {}) {
  const originalFetch = globalThis.fetch, originalRequest = https.request, originalGet = https.get;
  const fetcher = ports.fetch ?? originalFetch, native = ports.request ?? originalRequest;
  const controller = new AbortController(), pending = new Set<Promise<unknown>>();
  const started = performance.now(), remaining = Math.max(0, budget.plan.deadline - Date.now());
  let stopped = false, closed = false;
  function stop(error: unknown) {
    if (stopped) return; stopped = true;
    const code = error instanceof SharedBudgetError ? error.code : "SHARED_BUDGET_UNAVAILABLE";
    try { budget.stop(code); } catch { /* Durable failure or inaccessible ledger; stop locally too. */ }
    controller.abort(); process.emit("SIGTERM");
  }
  function perform<T>(fn: () => T): T { try { return fn(); } catch (e) { stop(e); throw e; } }
  function guard() {
    if (closed) budgetFail("SHARED_BUDGET_CLOSED");
    if (performance.now() - started >= remaining) perform(() => budget.stop("SHARED_BUDGET_DEADLINE"));
    perform(() => budget.guard());
  }
  function track<T>(promise: Promise<T>) {
    pending.add(promise); void promise.then(() => pending.delete(promise), () => pending.delete(promise)); return promise;
  }
  const timer = setInterval(() => { if (stopped) return; try { guard(); } catch { /* stop already delivered */ } }, 100); timer.unref();
  const cancel = () => stop(new SharedBudgetError("SHARED_BUDGET_CANCELLED"));
  process.on("SIGINT", cancel); process.on("SIGTERM", cancel);
  function reserve(input: string | URL | Request, method: string, bytes: number) {
    guard(); let url: URL;
    try { url = new URL(input instanceof Request ? input.url : input); } catch { return perform(() => budgetFail("SHARED_BUDGET_URL_INVALID")); }
    if (url.protocol !== "https:" || url.username || url.password || url.hash) return perform(() => budgetFail("SHARED_BUDGET_URL_INVALID"));
    const kind = url.origin === "https://api.notion.com" ? "notion" : url.origin === budget.plan.storageOrigin ?
      url.pathname.startsWith("/auth/v1/") ? "auth" : "storage" : "image";
    if (kind === "image" && (method.toUpperCase() !== "GET" || bytes)) return perform(() => budgetFail("SHARED_BUDGET_URL_INVALID"));
    perform(() => budget.charge({ httpRequests: 1, [kind + "Requests"]: 1, uploadBodyBytes: bytes }));
    return (kind + "ResponseBytes") as keyof SharedLimits;
  }
  function bodySize(body: BodyInit | null | undefined) {
    if (body == null) return 0;
    if (typeof body === "string" || body instanceof URLSearchParams) return Buffer.byteLength(String(body));
    if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return body.byteLength;
    return perform(() => budgetFail("SHARED_BUDGET_BODY_INVALID"));
  }
  const boundedFetch: typeof fetch = (input, init) => track((async () => {
    if (input instanceof Request && input.body && init?.body === undefined) perform(() => budgetFail("SHARED_BUDGET_BODY_INVALID"));
    const counter = reserve(input, init?.method ?? (input instanceof Request ? input.method : "GET"), bodySize(init?.body));
    const signals = [controller.signal, init?.signal, input instanceof Request ? input.signal : undefined].filter((s): s is AbortSignal => !!s);
    const response = await fetcher(input, { ...init, redirect: "error", signal: AbortSignal.any(signals) });
    const reader = response.body?.getReader(), chunks: Uint8Array[] = []; let size = 0;
    try {
      if (reader) while (true) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.length; perform(() => budget.observe({ [counter]: value.length }));
        if (size > (counter === "notionResponseBytes" ? 2 : counter === "authResponseBytes" ? 1 : 20) * 1024 ** 2) perform(() => budgetFail("SHARED_BUDGET_RESPONSE_LIMIT"));
        chunks.push(value);
      }
      guard();
      // Eagerly charge even ignored error/PUT/auth bodies. Only bounded bytes
      // are buffered, and the caller retains its original status and headers.
      return new Response(response.body ? Buffer.concat(chunks) : null, { status: response.status, statusText: response.statusText, headers: response.headers });
    } catch (e) { await reader?.cancel().catch(() => {}); throw e; } finally { reader?.releaseLock(); }
  })());
  const request: typeof https.request = ((first: string | URL | https.RequestOptions,
    second?: https.RequestOptions | ((response: import("node:http").IncomingMessage) => void), third?: (response: import("node:http").IncomingMessage) => void) => {
    const hasURL = typeof first === "string" || first instanceof URL;
    const options: https.RequestOptions = { ...(hasURL ? typeof second === "object" ? second : {} : first) };
    const callback = (hasURL ? typeof second === "function" ? second : third : second) as ((r: import("node:http").IncomingMessage) => void) | undefined;
    const headers = options.headers as Record<string, unknown> | undefined;
    const authority = options.servername || headers?.Host || headers?.host || options.hostname || options.host;
    // Legacy native transport only downloads images. Uploads go through fetch.
    if ((options.method ?? "GET").toUpperCase() !== "GET" || options.protocol && options.protocol !== "https:") return perform(() => budgetFail("SHARED_BUDGET_URL_INVALID"));
    const counter = reserve(hasURL ? new URL(first) : new URL(`https://${String(authority)}${options.path ?? "/"}`), "GET", 0);
    options.signal = AbortSignal.any([controller.signal, ...(options.signal ? [options.signal] : [])]);
    let finish!: () => void;
    const completion = new Promise<void>(done => { finish = done; });
    const onResponse = (response: import("node:http").IncomingMessage) => {
      // Count at the stream producer, before consumers and even if they ignore
      // a rejected response. Do not throw through EventEmitter callbacks.
      const push = response.push; response.on("error", () => {});
      response.push = function (chunk: unknown, encoding?: BufferEncoding) {
        if (chunk !== null) try {
          const bytes = typeof chunk === "string" ? Buffer.byteLength(chunk, encoding) : (chunk as Uint8Array).byteLength;
          perform(() => budget.observe({ [counter]: bytes }));
        } catch (e) { this.destroy(e as Error); return false; }
        return push.call(this, chunk, encoding);
      };
      response.once("close", finish); callback?.(response);
    };
    let req: import("node:http").ClientRequest;
    try { req = hasURL ? Reflect.apply(native, https, [first, options, onResponse]) : Reflect.apply(native, https, [options, onResponse]); }
    catch (e) { finish(); throw e; }
    req.once("error", finish); req.once("close", finish); track(completion); return req;
  }) as typeof https.request;
  const get = ((...args: unknown[]) => { const req = Reflect.apply(request, https, args); req.end(); return req; }) as typeof https.get;

  const originals = (ports.sql ?? [pg.Pool.prototype, pg.Client.prototype] as unknown as QueryPort[]).map(port => ({ port, query: port.query }));
  for (const { port, query } of originals) port.query = function (...args: unknown[]) {
    const config = args[0], text = typeof config === "string" ? config : (config as { text?: string })?.text;
    const values = typeof config === "string" ? Array.isArray(args[1]) ? args[1] : [] : (config as { values?: unknown[] })?.values ?? [];
    if (typeof text !== "string" || !Array.isArray(values) || typeof config !== "string" && Object.keys(config as object).some(k => !["text", "values"].includes(k)) || args.length > 3) return perform(() => budgetFail("SHARED_BUDGET_SQL_INVALID"));
    const cleanup = text === FAIL_RUN && values.length === 2 && typeof values[0] === "string" && /^[a-f0-9-]{36}$/.test(values[0]) &&
      /^(0|[1-9][0-9]*)$/.test(String(values[1]));
    if (!cleanup) guard();
    const bytes = Buffer.byteLength(JSON.stringify({ text, values }));
    perform(() => budget.charge(cleanup ? { cleanupSqlRequests: 1, cleanupSqlRequestBytes: bytes } : { sqlRequests: 1, sqlRequestBytes: bytes }, cleanup));
    const receive = (result: unknown) => {
      const bytes = Buffer.byteLength(JSON.stringify((result as { rows?: unknown })?.rows ?? null));
      perform(() => budget.observe(cleanup ? { cleanupSqlResponseBytes: bytes } : { sqlResponseBytes: bytes }, cleanup));
      if (!cleanup) guard(); return result;
    };
    const callbackIndex = args.findIndex((arg, i) => i > 0 && typeof arg === "function");
    if (callbackIndex >= 0) {
      const callback = args[callbackIndex] as (error: unknown, result?: unknown) => void;
      let finish!: () => void; track(new Promise<void>(done => { finish = done; }));
      args[callbackIndex] = (error: unknown, result: unknown) => {
        try { if (!error) receive(result); } catch (e) { error = e; }
        finally { finish(); } callback(error, result);
      };
      try { return Reflect.apply(query, this, args); } catch (e) { finish(); throw e; }
    }
    return track(Promise.resolve(Reflect.apply(query, this, args)).then(receive));
  };
  globalThis.fetch = boundedFetch; https.request = request; https.get = get; syncBuiltinESMExports();
  return { signal: controller.signal, guard, async drain() { while (pending.size) await Promise.allSettled([...pending]); },
    restore() {
      closed = true; clearInterval(timer); controller.abort();
      process.off("SIGINT", cancel); process.off("SIGTERM", cancel);
      if (globalThis.fetch === boundedFetch) globalThis.fetch = originalFetch;
      if (https.request === request) https.request = originalRequest;
      if (https.get === get) https.get = originalGet;
      for (const { port, query } of originals) port.query = query;
      syncBuiltinESMExports();
    } };
}

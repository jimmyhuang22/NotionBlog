import pg from "pg";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { lstatSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson } from "../../src/server/database/website-validation.ts";
import { WEBSITE_READER_ISOLATION_SQL } from "../../src/server/database/website-reader-isolation.ts";
import { INCREMENTAL_LOGIN_SQL } from "../../src/server/database/incremental-connection.ts";
import { WEBSITE_SNAPSHOT_SQL, WEBSITE_CONTENT_SQL, WEBSITE_STATUS_INDEX_SQL, WEBSITE_STATUS_PAGE_SQL } from "../../src/server/database/website-projection.ts";
import { STUDY_DIRECTORY_SQL, STUDY_NOTE_ELIGIBILITY_SQL, STUDY_NOTE_DETAIL_SQL } from "../../src/server/database/study-reads.ts";
import { SharedBudgetError, type SharedBudget } from "../website-sync/shared-budget.ts";
import { VisitorError, visitorFail as fail, type VisitorPlan } from "./plan.ts";

/** One physical pg.Client query is counted once (Pool delegates to Client).
 * Application row JSON and decoded HTTP bodies, not TLS/PG framing or billing.
 * All late successful rows/chunks are charged before testing cancellation. */
export function installVisitorTransports(input: { budget: SharedBudget; plan: VisitorPlan; readerUrl: string; role: "supervisor" | "server";
  localOrigin: string; onStop?(): void; fetch?: typeof fetch; sqlPorts?: { query: (...args: any[]) => any }[]; checkConnections?: boolean }) {
  const { plan } = input, controller = new AbortController(), pending = new Set<Promise<unknown>>();
  // The HTTP receiver and server can write concurrently while HTML streams.
  // Wait only for the existing short metadata lock, <=250ms and the same hard
  // deadline. Never steal it, change its owner, refund or retry network work.
  const pause = new Int32Array(new SharedArrayBuffer(4));
  function serialized<T>(call: () => T): T {
    const until = performance.now() + Math.min(250, Math.max(0, input.budget.plan.deadline - Date.now()));
    while (true) {
      try { return call(); } catch (e) {
        if (!(e instanceof SharedBudgetError) || e.code !== "SHARED_BUDGET_LOCK_BUSY" || performance.now() >= until) throw e;
        Atomics.wait(pause, 0, 0, Math.min(2, Math.max(0, until - performance.now())));
      }
    }
  }
  let missingObservation = false;
  const budget = { ...input.budget, charge: (...args: Parameters<SharedBudget["charge"]>) => serialized(() => input.budget.charge(...args)),
    observe: (...args: Parameters<SharedBudget["observe"]>) => {
      try { serialized(() => input.budget.observe(...args)); }
      catch (e) { if (!(e instanceof SharedBudgetError) || !["SHARED_BUDGET_LIMIT", "SHARED_BUDGET_CANCELLED", "SHARED_BUDGET_DEADLINE"].includes(e.code)) missingObservation = true; throw e; }
    }, stop: (code?: string) => serialized(() => input.budget.stop(code)),
    guard() {
      const until = performance.now() + Math.min(250, Math.max(0, input.budget.plan.deadline - Date.now())), state = join(input.budget.bridge.directory, "state.json");
      while (true) {
        const before = lstatSync(state);
        try { serialized(() => input.budget.guard()); return; }
        catch (e) {
          const after = lstatSync(state);
          // Atomic replacement can unlink the FD between open and fstat.
          // Retry ONLY a proven inode replacement, never a bad stable file.
          if (!(e instanceof SharedBudgetError) || !["SHARED_BUDGET_INPUT_INVALID", "SHARED_BUDGET_STATE_INVALID"].includes(e.code) ||
            before.ino === after.ino && before.dev === after.dev || performance.now() >= until) throw e;
        }
      }
    } };
  const originalFetch = globalThis.fetch, fetcher = input.fetch ?? originalFetch;
  const originalHttp = http.request, originalHttpGet = http.get, originalHttps = https.request, originalHttpsGet = https.get;
  const connection = pg.Client.prototype.connect;
  const Pool = pg.Pool; let sharedPool: pg.Pool | undefined;
  const poolQuery = Pool.prototype.query, poolConnect = Pool.prototype.connect;
  const originals = (input.sqlPorts ?? [pg.Client.prototype]).map(port => ({ port, query: port.query }));
  const clients = new Set<pg.Client>();
  const projections = new Set([WEBSITE_SNAPSHOT_SQL, WEBSITE_CONTENT_SQL, WEBSITE_STATUS_INDEX_SQL, WEBSITE_STATUS_PAGE_SQL, STUDY_DIRECTORY_SQL, STUDY_NOTE_ELIGIBILITY_SQL, STUDY_NOTE_DETAIL_SQL]
    .map(s => s.replace(/\bnb_v2_api\.(read_content|read_snapshot|read_media)\b/g, "nb_publication_api.$1")));
  const studyProjections=new Set([STUDY_DIRECTORY_SQL,STUDY_NOTE_ELIGIBILITY_SQL,STUDY_NOTE_DETAIL_SQL]
    .map(s=>s.replace(/\bnb_v2_api\.(read_content|read_snapshot|read_media)\b/g,"nb_publication_api.$1")));
  let closed = false, failure: string | null = null;
  const started = performance.now(), remaining = Math.max(0, budget.plan.deadline - Date.now());
  function stop(code = "VISITOR_CANCELLED") {
    if (failure) return; failure = code;
    try { budget.stop("SHARED_BUDGET_CANCELLED"); } catch { /* Other actor has already stopped. */ }
    controller.abort(); input.onStop?.();
  }
  function guard() {
    if (closed) fail("VISITOR_CLOSED");
    if (failure) fail(failure);
    if (performance.now() - started >= remaining) { stop("VISITOR_DEADLINE"); fail("VISITOR_DEADLINE"); }
    try { budget.guard(); } catch { stop("VISITOR_BUDGET_STOPPED"); fail("VISITOR_BUDGET_STOPPED"); }
  }
  function perform<T>(fn: () => T): T { try { return fn(); } catch (e) { stop(e instanceof VisitorError ? e.code : "VISITOR_BUDGET_STOPPED"); throw e; } }
  function track<T>(p: Promise<T>) { pending.add(p); void p.then(() => pending.delete(p), () => pending.delete(p)); return p; }
  const timer = setInterval(() => { try { guard(); } catch { /* stop sent once */ } }, 50); timer.unref();
  const boundedFetch: typeof fetch = (value, init) => track((async () => {
    guard(); const url = new URL(value instanceof Request ? value.url : value), method = init?.method ?? (value instanceof Request ? value.method : "GET");
    const local = input.role === "supervisor" && url.origin === input.localOrigin && plan.requests.some(r => r.path === url.pathname + url.search);
    const stored = input.role === "server" && url.origin === plan.origin && !url.search && plan.objects.some(m => url.pathname === `/${plan.prefix}/${m.objectKey}`);
    if ((!local && !stored) || method !== "GET" || init?.body != null || value instanceof Request && value.body || url.username || url.password || url.hash) return perform(() => fail("VISITOR_HTTP_FORBIDDEN"));
    perform(() => budget.charge({ httpRequests: 1, ...(local ? { imageRequests: 1 } : { storageRequests: 1 }) }));
    const response = await fetcher(value, { ...init, method: "GET", redirect: "error", cache: "no-store", credentials: "omit",
      signal: AbortSignal.any([controller.signal, ...(init?.signal ? [init.signal] : [])]) });
    const reader = response.body?.getReader(), chunks: Uint8Array[] = []; let size = 0;
    try {
      if (reader) while (true) {
        const next = await reader.read(); if (next.done) break;
        size += next.value.byteLength; perform(() => budget.observe({ storageResponseBytes: next.value.byteLength }));
        // Each media leg <=20MiB; control/HTML <=8MiB. Error bodies also count.
        if (size > (stored || url.pathname.startsWith("/media/") ? 20 : 8) * 1024 ** 2) perform(() => fail("VISITOR_RESPONSE_LIMIT"));
        chunks.push(next.value);
      }
      guard();
      if (response.redirected || response.status >= 300 && response.status < 400 || response.url && new URL(response.url).origin !== url.origin) perform(() => fail("VISITOR_REDIRECT"));
      return new Response(response.body ? Buffer.concat(chunks) : null, { status: response.status, statusText: response.statusText, headers: response.headers });
    } catch (e) { await reader?.cancel().catch(() => {}); throw e; } finally { reader?.releaseLock(); }
  })());
  const expected = new URL(input.readerUrl);
  if (input.checkConnections !== false) pg.Client.prototype.connect = function (...args: any[]) {
    guard(); const c = (this as any).connectionParameters;
    if (c.host !== expected.hostname || String(c.port) !== (expected.port || "5432") || c.user !== decodeURIComponent(expected.username) ||
      c.database !== decodeURIComponent(expected.pathname.slice(1)) || c.ssl === false || !(c.ssl as { rejectUnauthorized?: boolean })?.rejectUnauthorized) return perform(() => fail("VISITOR_SQL_TARGET_INVALID"));
    perform(() => budget.charge({ authRequests: 1 })); // PG connection attempts, not Auth HTTP.
    c.options = "-c default_transaction_read_only=on"; clients.add(this);
    return Reflect.apply(connection, this, args);
  };
  for (const { port, query } of originals) port.query = function (...args: any[]) {
    guard(); const text = typeof args[0] === "string" ? args[0] : args[0]?.text, values = typeof args[0] === "string" ? Array.isArray(args[1]) ? args[1] : [] : args[0]?.values ?? [];
    if (typeof text !== "string" || !Array.isArray(values) || args.length > 3 || typeof args[0] !== "string" && Object.keys(args[0]).some(k => !["text", "values"].includes(k)) ||
      text !== INCREMENTAL_LOGIN_SQL && text !== WEBSITE_READER_ISOLATION_SQL && !projections.has(text) && !/^SELECT nb_(?:publication|delta)_api\.(?:check_capability|check_reader|read_state|check_thumbnail_capability|read_thumbnail|read_content|read_snapshot|read_media)\((?:(?:\$[0-9]+(?:::(?:text\[\]|jsonb|uuid|bigint|integer))?|NULL|'\{\}'::jsonb)(?:,(?:\$[0-9]+(?:::(?:text\[\]|jsonb|uuid|bigint|integer))?|NULL|'\{\}'::jsonb))*)?\) AS result$/.test(text)) return perform(() => fail("VISITOR_SQL_FORBIDDEN"));
    perform(() => budget.charge({ sqlRequests: 1, sqlRequestBytes: Buffer.byteLength(JSON.stringify({ text, values })) }));
    function receive(result: any) {
      perform(() => budget.observe({ sqlResponseBytes: Buffer.byteLength(JSON.stringify(result?.rows ?? null)) }));
      for (const row of result?.rows ?? []) {
        const projection=row.result;
        for(const v of studyProjections.has(text) ? [projection?.course,projection?.notes] : [projection]) {
        if (!v || typeof v !== "object") continue;
        if (v.runId !== undefined && `${v.runId}:${v.revision}` !== plan.state.publicationRevision ||
          v.publicationRevision !== undefined && v.publicationRevision !== plan.state.publicationRevision ||
          v.configDigest !== undefined && v.configDigest !== plan.state.configDigest ||
          v.policyEpoch !== undefined && v.policyEpoch !== plan.state.policyEpoch ||
          v.schemaDigest !== undefined && v.schemaDigest !== plan.state.schemaDigest) perform(() => fail("VISITOR_PUBLICATION_CHANGED"));
        }
      }
      guard(); return result;
    }
    const cb = args.findIndex((a, i) => i > 0 && typeof a === "function");
    if (cb >= 0) {
      const callback = args[cb]; let done!: () => void; track(new Promise<void>(resolve => { done = resolve; }));
      args[cb] = (error: unknown, result: unknown) => { try { if (!error) receive(result); } catch (e) { error = e; } finally { done(); } callback(error, result); };
      try { return Reflect.apply(query, this, args); } catch (e) { done(); throw e; }
    }
    return track(Promise.resolve(Reflect.apply(query, this, args)).then(receive));
  };
  const forbidden = (() => perform(() => fail("VISITOR_NATIVE_HTTP_FORBIDDEN"))) as typeof https.request;
  if (input.role === "server") {
    // Route bundles can hold separate application runtime instances. Within
    // THIS isolated server only, use one fixed reader pool/connection rather
    // than multiplying pools per sampled route. Preserve its TLS/timeouts.
    const shared = (pool: pg.Pool) => {
      guard(); const options = pool.options;
      if (!options || options.connectionString !== input.readerUrl || (options.ssl as { rejectUnauthorized?: boolean })?.rejectUnauthorized !== true) return perform(() => fail("VISITOR_SQL_TARGET_INVALID"));
      if (!sharedPool) { sharedPool = new Pool({ ...options, max: 1 }); sharedPool.on("error", () => stop("VISITOR_SQL_UNAVAILABLE")); }
      return sharedPool;
    };
    // Intercept the prototype as well as cached ESM named exports: changing
    // pg.Pool alone does not replace constructors already cached by Next.
    Pool.prototype.query = function (this: pg.Pool, ...args: any[]) { return Reflect.apply(poolQuery, this === sharedPool ? this : shared(this), args); } as typeof poolQuery;
    Pool.prototype.connect = function (this: pg.Pool, ...args: any[]) { return Reflect.apply(poolConnect, this === sharedPool ? this : shared(this), args); } as typeof poolConnect;
    globalThis.fetch = boundedFetch;
    http.request = forbidden as typeof http.request; http.get = forbidden as typeof http.get;
    https.request = forbidden; https.get = forbidden as typeof https.get; syncBuiltinESMExports();
  }
  return { fetch: boundedFetch, guard, stop, signal: controller.signal, pending: () => pending.size, failure: () => failure, accountingComplete: () => !missingObservation,
    async drain() { while (pending.size) await Promise.allSettled([...pending]); },
    async closeClients() { await Promise.allSettled([...clients].map(c => c.end())); if (sharedPool) await sharedPool.end(); },
    restore() {
      closed = true; clearInterval(timer); controller.abort();
      for (const { port, query } of originals) port.query = query;
      if (input.checkConnections !== false) pg.Client.prototype.connect = connection;
      if (input.role === "server") {
        Pool.prototype.query = poolQuery; Pool.prototype.connect = poolConnect;
        if (globalThis.fetch === boundedFetch) globalThis.fetch = originalFetch;
        http.request = originalHttp; http.get = originalHttpGet; https.request = originalHttps; https.get = originalHttpsGet; syncBuiltinESMExports();
      }
    } };
}

export function unchanged(a: unknown, b: unknown) { if (canonicalJson(a) !== canonicalJson(b)) fail("VISITOR_PUBLICATION_CHANGED"); }

import { randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { ContentServiceError } from "../../contracts/repository.ts";
import type { SqlExecutor } from "../../src/server/database/sql.ts";
import { FULL_COLLECTION_LEASE_SQL } from "./full-collection.ts";

export const FULL_COLLECTION_OWNER_LIMITS = Object.freeze({ queries: 1, timeoutMs: 10000, responseBytes: 4096 });
const requestType = "website-full-collection-owner-request-v1", responseType = "website-full-collection-owner-response-v1";
const unavailable = () => new ContentServiceError("CONTENT_UNAVAILABLE", "Full collection metadata is unavailable.");
/** Parent-only port. The operator supplies an already identity/TLS-verified,
 * dedicated owner connection with server statement timeout <=10 seconds and a
 * destructive close operation. This module never loads credentials or retries.
 * The factory must honor abort, including while opening; late ports are closed.
 */
export type OpenFullCollectionOwner = (signal: AbortSignal) => Promise<{ executor: SqlExecutor; close: () => Promise<void> }>;

export function createFullCollectionOwnerBroker(runId: string, openOwner: OpenFullCollectionOwner, signal: AbortSignal,
  persist: (budget: object) => Promise<void> = async () => {}) {
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(runId) || typeof openOwner !== "function") throw unavailable();
  const nonce = randomUUID(), controller = new AbortController();
  let used = false, closed = false, queryCount = 0, bytes = 0, failure = false;
  let port: Awaited<ReturnType<OpenFullCollectionOwner>> | undefined, closing: Promise<void> | undefined;
  let outcome = "not-started";
  const statistics = () => ({ format: "website-full-collection-owner-budget-v1", queryCount, responseBytes: bytes, failed: failure, used, outcome });
  const closePort = () => closing ??= (async () => { if (port) await port.close(); })();
  const stop = () => { closed = true; controller.abort(); if (port) void closePort().catch(() => { failure = true; }); };
  signal.addEventListener("abort", stop, { once: true }); if (signal.aborted) stop();
  const request = async (message: unknown) => {
    const m = message as { type?: unknown; runId?: unknown; nonce?: unknown };
    if (closed || used || !m || Object.keys(m).sort().join(",") !== "nonce,runId,type" ||
        m.type !== requestType || m.runId !== runId || m.nonce !== nonce) throw unavailable();
    used = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
      const work = (async () => {
        await persist(statistics());
        if (closed || controller.signal.aborted) throw unavailable();
        const opened = await openOwner(controller.signal);
        if (closed || controller.signal.aborted) { await opened.close(); throw unavailable(); }
        port = opened;
        if (!port?.executor || typeof port.executor.query !== "function" || typeof port.close !== "function") throw unavailable();
        queryCount++; outcome = "pending"; await persist(statistics());
        if (closed || controller.signal.aborted) throw unavailable();
        const result = await port.executor.query(FULL_COLLECTION_LEASE_SQL, [runId]);
        if (closed || controller.signal.aborted || !Array.isArray(result?.rows) || result.rows.length !== 1) throw unavailable();
        const response = { type: responseType, runId, nonce, rows: result.rows };
        const text = JSON.stringify(response); bytes = Buffer.byteLength(text);
        if (bytes > FULL_COLLECTION_OWNER_LIMITS.responseBytes) throw unavailable();
        // Close the privileged connection BEFORE releasing metadata to the child.
        await closePort(); outcome = "received"; await persist(statistics());
        if (closed || controller.signal.aborted) throw unavailable();
        return JSON.parse(text) as typeof response;
      })();
      const cutoff = new Promise<never>((_, reject) => {
        onAbort = () => reject(unavailable()); controller.signal.addEventListener("abort", onAbort, { once: true });
        timer = setTimeout(() => { stop(); reject(unavailable()); }, FULL_COLLECTION_OWNER_LIMITS.timeoutMs);
      });
      return await Promise.race([work, cutoff]);
    } catch { failure = true; if (outcome === "pending") outcome = "unknown"; stop(); throw unavailable(); }
    finally { clearTimeout(timer); if (onAbort) controller.signal.removeEventListener("abort", onAbort); }
  };
  return {
    nonce, request,
    attach(child: ChildProcess) {
      const send = (reply: object) => {
        try { if (child.connected) child.send(reply, () => {}); }
        catch { failure = true; stop(); }
      };
      const onMessage = (message: unknown) => {
        void request(message).then(send, () => send({ type: responseType, runId, nonce, failed: true }));
      };
      child.on("message", onMessage);
      return () => child.off("message", onMessage);
    },
    statistics,
    async close() {
      // Close may beat the asynchronous request rejection after child exit.
      // Its terminal snapshot must already record the unfinished attempt.
      if (used && outcome !== "received") {
        failure = true;
        if (outcome === "pending") outcome = "unknown";
      }
      stop(); signal.removeEventListener("abort", stop);
      if (port) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try { await Promise.race([closePort(), new Promise<never>((_, reject) => {
          timer = setTimeout(() => { failure = true; reject(unavailable()); }, FULL_COLLECTION_OWNER_LIMITS.timeoutMs);
        })]); } finally { clearTimeout(timer); }
      }
    },
  };
}

/** Child sees only fixed IPC metadata, never owner credentials or a SQL port. */
export function fullCollectionOwnerClient(runId: string, nonce: string, signal: AbortSignal): SqlExecutor {
  let used = false;
  return { async query<T>(sql: string, values?: unknown[]) {
    if (used || sql !== FULL_COLLECTION_LEASE_SQL || values?.length !== 1 || values[0] !== runId ||
        signal.aborted || !process.send || !process.connected || !/^[a-f0-9-]{36}$/.test(nonce)) throw unavailable();
    used = true;
    const rows = await new Promise<unknown[]>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>;
      const cleanup = () => { clearTimeout(timer); process.off("message", reply); process.off("disconnect", abort); signal.removeEventListener("abort", abort); };
      const abort = () => { cleanup(); reject(unavailable()); };
      const reply = (message: unknown) => {
        const m = message as { type?: unknown; runId?: unknown; nonce?: unknown; rows?: unknown[] };
        try {
          if (!m || m.type !== responseType || m.runId !== runId || m.nonce !== nonce ||
              Object.keys(m).sort().join(",") !== "nonce,rows,runId,type" ||
              Buffer.byteLength(JSON.stringify(m)) > FULL_COLLECTION_OWNER_LIMITS.responseBytes || !Array.isArray(m.rows) || m.rows.length !== 1) return abort();
          cleanup(); resolve(m.rows);
        } catch { abort(); }
      };
      process.on("message", reply); process.once("disconnect", abort); signal.addEventListener("abort", abort, { once: true });
      timer = setTimeout(abort, FULL_COLLECTION_OWNER_LIMITS.timeoutMs);
      process.send!({ type: requestType, runId, nonce }, error => { if (error) abort(); });
    });
    return { rows: rows as T[] };
  } };
}

import { setTimeout as delay } from "node:timers/promises";
import type { SqlExecutor } from "../../src/server/database/sql.ts";
import { checkSignal } from "../notion-sync/errors.ts";

const RENEW = "SELECT nb_v2_api.renew_run($1,$2,$3) AS result";
const transientCodes = new Set(["ECONNRESET", "EPIPE", "ETIMEDOUT", "ECONNREFUSED", "EAI_AGAIN", "08000", "08001", "08003", "08006", "57P01", "57P02", "57P03", "53300", "40001", "40P01", "57014"]);
// Exact messages from the locked pg driver. No substring/cause matching: an
// explicit SQLSTATE, auth or TLS code remains authoritative and terminal.
const transientMessages = new Map<string, string>([
  ["Connection terminated unexpectedly", "connection-closed"],
  ["Connection terminated", "connection-closed"],
  ["Query read timeout", "query-timeout"],
  ["Connection closed due to connection timeout", "connection-timeout"],
  ["Connection terminated due to connection timeout", "connection-timeout"],
  ["timeout exceeded when trying to connect", "connection-timeout"],
]);
function transient(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as { code?: string; message?: string };
  return e.code ? transientCodes.has(e.code) : transientMessages.has(e.message ?? "");
}

/** Retry only the fenced renewal RPC; staging and promotion are never replayed. */
export function createRuntimeWriterSql(db: SqlExecutor, signal: AbortSignal,
  wait: (ms: number, signal: AbortSignal) => Promise<void> = async (ms, signal) => { await delay(ms, undefined, { signal }); }) {
  const metrics = { renewalAttempts: 0, renewalRetries: 0, recoveredRenewals: 0 };
  let failure: { code: string; leaseRejected: boolean; transient: boolean; reason: string } | undefined;
  const executor: SqlExecutor = { query: async <T>(text: string, values?: unknown[]) => {
    if (text !== RENEW) return db.query<T>(text, values);
    for (let attempt = 0; attempt < 3; attempt++) {
      checkSignal(signal); metrics.renewalAttempts++;
      try { const result = await db.query<T>(text, values); checkSignal(signal);
        if (attempt) metrics.recoveredRenewals++; return result;
      } catch (error) {
        checkSignal(signal);
        const e = error as { code?: string; message?: string }, recoverable = transient(error);
        // SQL lease, fencing, auth and policy errors are terminal. The server
        // continues checking the same run/fence and its actual deadline.
        if (attempt === 2 || !recoverable) {
          failure = { code: /^[A-Z0-9_]{1,32}$/.test(e.code ?? "") ? e.code! : "OTHER",
            leaseRejected: e.message === "NB_LEASE_INVALID", transient: recoverable,
            // Private receipts retain only a fixed category, never raw messages,
            // causes, connection details or SQL. Unknown failures stay unknown.
            reason: e.code ? e.message === "NB_LEASE_INVALID" ? "lease-rejected" : "coded-error"
              : transientMessages.get(e.message ?? "") ?? "unclassified" };
          throw error;
        }
        metrics.renewalRetries++; await wait(attempt === 0 ? 2000 : 5000, signal);
      }
    }
    throw new Error("Renewal stopped");
  } };
  return { executor, statistics: () => ({ ...metrics }), failure: () => failure && ({ ...failure }) };
}

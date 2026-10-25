import { attachDatabasePool } from "@vercel/functions/db-connections";
import type { Pool } from "pg";
import { registerSelfHostedPool } from "../../../scripts/self-hosted/context.cjs";
import type { SqlExecutor } from "../database/sql.ts";

const networkErrorCodes = new Set([
  "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN",
  "ERR_TLS_CERT_ALTNAME_INVALID", "CERT_HAS_EXPIRED", "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
]);

function reportDatabaseError(error: unknown, stage: "query" | "idle_pool"): void {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  // Driver messages, SQL, parameters and error objects may contain private data.
  const safeCode = typeof code === "string" && (/^[0-9A-Z]{5}$/.test(code) || networkErrorCodes.has(code)) ? code : "UNKNOWN";
  console.error("social_reader_database_error", { stage, code: safeCode });
}

/** Register once, immediately after creating the module-global social pool. */
export function attachSocialReaderPool(pool: Pool): void {
  if (!registerSelfHostedPool(pool)) attachDatabasePool(pool);
  pool.on("error", error => reportDatabaseError(error, "idle_pool"));
}

/** Observe driver failures before the repository turns them into public 503s. */
export function monitoredSocialReaderSql(sql: SqlExecutor): SqlExecutor {
  return {
    async query<T>(text: string, values?: unknown[]) {
      try { return await sql.query<T>(text, values); }
      catch (error) {
        reportDatabaseError(error, "query");
        throw error;
      }
    },
  };
}

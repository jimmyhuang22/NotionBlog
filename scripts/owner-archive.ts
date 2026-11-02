import { Pool, type PoolClient, type QueryConfig } from "pg";
import { databasePoolConfig } from "../src/server/database/connection.ts";
import type { SqlExecutor } from "../src/server/database/sql.ts";

export type ArchiveOperation = "export" | "restore";
export const OWNER_ARCHIVE_LIMITS = Object.freeze({
  export: Object.freeze({ statementMs: 60_000, queryMs: 65_000, totalMs: 300_000 }),
  restore: Object.freeze({ statementMs: 120_000, queryMs: 125_000, totalMs: 1_800_000 }),
});

/** Operator sessions have advisory locks/transactions and must not borrow a
 * transaction-mode Supabase connection. Website pool limits remain unchanged. */
export function ownerArchivePoolConfig(operation: ArchiveOperation, url: string | undefined, tls?: string, ca?: string) {
  const base = databasePoolConfig(url, tls, ca), parsed = new URL(url!);
  if (/\.pooler\.supabase\.com$/.test(parsed.hostname) && (parsed.port || "5432") !== "5432") throw Error("OWNER_ARCHIVE_SESSION_REQUIRED");
  const limits = OWNER_ARCHIVE_LIMITS[operation];
  if (!limits) throw Error("OWNER_ARCHIVE_OPERATION_INVALID");
  return { ...base, max: 1, connectionTimeoutMillis: 20_000, idleTimeoutMillis: 5_000,
    statement_timeout: limits.statementMs, query_timeout: limits.queryMs, application_name: "notionblog-owner-archive" };
}

export function createOwnerArchivePool(operation: ArchiveOperation, url: string | undefined, tls?: string, ca?: string): Pool {
  const pool = new Pool(ownerArchivePoolConfig(operation, url, tls, ca));
  pool.on("error", () => {});
  return pool;
}

/** Explicit session settings on the dedicated direct/session-mode checkout.
 * Never call through pool.query; do not alter a role or database default. */
export async function configureOwnerArchive(client: PoolClient, operation: ArchiveOperation): Promise<void> {
  const limits = OWNER_ARCHIVE_LIMITS[operation];
  const configure: QueryConfig & { query_timeout: number } = { text: `SELECT
    pg_catalog.set_config('statement_timeout',$1,false) AS statement_timeout,
    pg_catalog.set_config('lock_timeout','5000ms',false) AS lock_timeout`,
    values: [String(limits.statementMs)], query_timeout: 20_000 };
  const row = (await client.query(configure)).rows;
  // set_config returns PostgreSQL's canonical unit string; inspect effective ms.
  const inspect: QueryConfig & { query_timeout: number } = { text: `SELECT
    setting::integer AS milliseconds FROM pg_catalog.pg_settings WHERE name='statement_timeout'`, query_timeout: 20_000 };
  const setting = (await client.query(inspect)).rows;
  if (row.length !== 1 || setting.length !== 1 || setting[0].milliseconds !== limits.statementMs) throw Error("OWNER_ARCHIVE_TIMEOUT_NOT_APPLIED");
}

/** A lost COMMIT acknowledgement cannot authorize another restore attempt. */
export function ownerArchiveSql(client: PoolClient): SqlExecutor {
  return { async query<T>(text: string, values?: unknown[]) {
    try { return { rows: (await client.query(text, values)).rows as T[] }; }
    catch (error) {
      if (text.trim().toUpperCase() === "COMMIT") throw Object.assign(Error("OWNER_ARCHIVE_OUTCOME_UNKNOWN"), { code: "OWNER_ARCHIVE_OUTCOME_UNKNOWN" });
      throw error;
    }
  } };
}

/** Covers file/media work and cleanup as well as SQL. A restore interrupted at
 * this deadline has an unknown outcome: print only a fixed code and never retry.
 * A smaller deadline is useful for local drills; callers cannot extend the cap. */
export function startOwnerArchiveDeadline(operation: ArchiveOperation, totalMs: number = OWNER_ARCHIVE_LIMITS[operation].totalMs): () => void {
  if (!Number.isSafeInteger(totalMs) || totalMs < 1 || totalMs > OWNER_ARCHIVE_LIMITS[operation].totalMs) throw Error("OWNER_ARCHIVE_DEADLINE_INVALID");
  const timer = setTimeout(() => {
    console.error(operation === "restore" ? "OWNER_ARCHIVE_DEADLINE_OUTCOME_UNKNOWN" : "OWNER_ARCHIVE_DEADLINE");
    process.exit(2);
  }, totalMs);
  return () => clearTimeout(timer);
}

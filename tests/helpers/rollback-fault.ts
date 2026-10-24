import type { SqlExecutor } from "../../src/server/database/sql.ts";

/** Simulate a lost rollback acknowledgement after the database handled it. */
export function rollbackFault(db: SqlExecutor): SqlExecutor {
  return { async query<T>(sql: string, parameters?: unknown[]) {
    const result = await db.query<T>(sql, parameters);
    if (sql === "ROLLBACK") throw Error("SYNTHETIC_ROLLBACK_FAILURE");
    return result;
  } };
}

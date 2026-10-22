import { ContentServiceError } from "../../../contracts/repository.ts";

/** Compatible with pg, a dedicated transaction client, and PGlite test execution. */
export interface SqlExecutor {
  query<T>(text: string, values?: unknown[]): Promise<{ rows: T[] }>;
}
export async function callSql<T>(db: SqlExecutor, sql: string, values: unknown[]): Promise<T> {
  try {
    const { rows } = await db.query<{ result: T }>(sql, values);
    if (!rows.length) throw new Error("Missing SQL result");
    return rows[0].result;
  } catch (cause) {
    // Never forward driver exceptions: detail/query may contain private source IDs.
    const message = cause instanceof Error ? cause.message : "";
    if (message === "NB_CURSOR_INVALID" || message === "NB_QUERY_INVALID") {
      throw new ContentServiceError("INVALID_QUERY", "The content cursor is no longer valid. Restart from the first page.");
    }
    if (message === "NB_BUSY") throw new ContentServiceError("RATE_LIMITED", "A synchronization run is already active.");
    throw new ContentServiceError("CONTENT_UNAVAILABLE", "Database content is temporarily unavailable.");
  }
}

import { attachDatabasePool } from "@vercel/functions/db-connections";
import type { Pool } from "pg";

/** Match the social reader's host lifecycle without changing pool size or SQL. */
export function attachContentReaderPool(pool: Pool): void {
  attachDatabasePool(pool);
  pool.on("error", error => {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    const safe = typeof code === "string" && (/^[0-9A-Z]{5}$/.test(code) ||
      ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN"].includes(code)) ? code : "UNKNOWN";
    console.error("content_reader_database_error", { stage: "idle_pool", code: safe });
  });
}

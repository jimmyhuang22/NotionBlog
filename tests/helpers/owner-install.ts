import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { WEBSITE_SCHEMA_DIGEST } from "../../contracts/website-sync.ts";
import type { SqlExecutor } from "../../src/server/database/sql.ts";
import { installPublication } from "../../scripts/website-sync/publication-migration.ts";
import { installIncrementalPublication } from "../../scripts/website-sync/incremental-migration.ts";
import { installIncrementalReader } from "../../scripts/website-sync/incremental-reader-migration.ts";

export async function ownerInstallFixture() {
  const db = await PGlite.create();
  const owner: SqlExecutor = { query: async <T>(sql: string, values?: unknown[]) => {
    if (sql.startsWith("--")) { await db.exec(sql); return { rows: [] as T[] }; }
    return db.query<T>(sql, values);
  } };
  try {
    await db.exec(await readFile(new URL("../../database/website-migrations/001_website.sql", import.meta.url), "utf8"));
    await db.query("UPDATE nb_v2.state SET schema_digest=$1", [WEBSITE_SCHEMA_DIGEST]);
    await installPublication(owner); await installIncrementalPublication(owner); await installIncrementalReader(owner);
    return { db, owner, close: () => db.close() };
  } catch (error) { await db.close(); throw error; }
}

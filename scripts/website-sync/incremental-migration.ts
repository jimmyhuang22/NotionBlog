import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import protocol from "../../database/incremental-publication-protocol.json" with { type: "json" };
import { verifyPublication } from "../../src/server/database/publication.ts";
import { verifyIncrementalPublication } from "../../src/server/database/incremental-publication.ts";
import type { SqlExecutor } from "../../src/server/database/sql.ts";

/** Owner-only installation. Does not publish, activate, inspect sources or start workers. */
export async function installIncrementalPublication(db: SqlExecutor): Promise<void> {
  const sql = await readFile(new URL(`../../supabase/migrations/${protocol.migration.file}`, import.meta.url), "utf8");
  if (createHash("sha256").update(sql).digest("hex") !== protocol.migration.sha256) throw new Error("Incremental migration differs.");
  await verifyPublication(db);
  const installed = (await db.query<{installed: string | null}>("SELECT to_regclass('nb_delta.state') AS installed")).rows[0]?.installed;
  if (!installed) await db.query(sql);
  const prior = (await db.query<{version: number; migration_digest: string | null}>("SELECT version,migration_digest FROM nb_delta.state WHERE singleton")).rows;
  if (prior.length !== 1 || prior[0].version !== 1 || (prior[0].migration_digest !== null && prior[0].migration_digest !== protocol.migration.sha256)) throw new Error("Installed incremental migration differs.");
  await db.query("UPDATE nb_delta.state SET migration_digest=$1 WHERE singleton", [protocol.migration.sha256]);
  await verifyIncrementalPublication(db);
}

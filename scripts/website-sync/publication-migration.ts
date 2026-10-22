import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { WEBSITE_SCHEMA_DIGEST } from "../../contracts/website-sync.ts";
import protocol from "../../database/publication-protocol.json" with { type: "json" };
import { verifyPublication } from "../../src/server/database/publication.ts";
import type { SqlExecutor } from "../../src/server/database/sql.ts";

/** Operator-only local migration verification. Installation does not activate any run. */
export async function installPublication(db: SqlExecutor): Promise<void> {
  const sql = await readFile(new URL(`../../supabase/migrations/${protocol.migration.file}`, import.meta.url), "utf8");
  if (createHash("sha256").update(sql).digest("hex") !== protocol.migration.sha256) throw new Error("Publication migration differs.");
  const state = (await db.query<{schema_digest: string}>("SELECT schema_digest FROM nb_v2.state WHERE singleton")).rows;
  if (state.length !== 1 || state[0].schema_digest !== WEBSITE_SCHEMA_DIGEST) throw new Error("Install the matching website migration first.");
  const installed = (await db.query<{installed: string | null}>("SELECT to_regclass('nb_publication.state') AS installed")).rows[0]?.installed;
  if (!installed) await db.query(sql);
  const prior = (await db.query<{version: number; migration_digest: string | null}>("SELECT version,migration_digest FROM nb_publication.state WHERE singleton")).rows;
  if (prior.length !== 1 || prior[0].version !== 1 || (prior[0].migration_digest !== null && prior[0].migration_digest !== protocol.migration.sha256)) {
    throw new Error("Installed publication migration differs.");
  }
  await db.query("UPDATE nb_publication.state SET migration_digest=$1 WHERE singleton", [protocol.migration.sha256]);
  await verifyPublication(db);
}

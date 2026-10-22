import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import protocol from "../../database/incremental-reader-protocol.json" with { type: "json" };
import { verifyIncrementalPublication } from "../../src/server/database/incremental-publication.ts";
import { verifyIncrementalReader } from "../../src/server/database/incremental-reader.ts";
import type { SqlExecutor } from "../../src/server/database/sql.ts";

export async function installIncrementalReader(db: SqlExecutor): Promise<void> {
  const sql = await readFile(new URL(`../../supabase/migrations/${protocol.migration.file}`, import.meta.url), "utf8");
  if (createHash("sha256").update(sql).digest("hex") !== protocol.migration.sha256) throw new Error("Incremental reader migration differs.");
  await verifyIncrementalPublication(db);
  const installed = (await db.query<{installed: string | null}>("SELECT to_regprocedure('nb_delta_api.check_reader(text)')::text AS installed")).rows[0]?.installed;
  if (!installed) await db.query(sql);
  const rows = (await db.query<{reader_digest: string | null}>("SELECT reader_digest FROM nb_delta.state WHERE singleton")).rows;
  if (rows.length !== 1 || (rows[0].reader_digest !== null && rows[0].reader_digest !== protocol.migration.sha256)) throw new Error("Installed reader migration differs.");
  await db.query("UPDATE nb_delta.state SET reader_digest=$1 WHERE singleton", [protocol.migration.sha256]);
  await verifyIncrementalReader(db);
}

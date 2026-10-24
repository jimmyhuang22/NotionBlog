import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import isolation from "../../database/incremental-reader-isolation.json" with { type: "json" };
import { verifyIncrementalReader } from "../../src/server/database/incremental-reader.ts";
import type { SqlExecutor } from "../../src/server/database/sql.ts";

/** Explicit owner-only upgrade; changes no LOGIN membership or credentials. */
export async function installIncrementalReaderIsolation(db: SqlExecutor): Promise<void> {
  const sql = await readFile(new URL(`../../supabase/migrations/${isolation.migration.file}`, import.meta.url), "utf8");
  if (createHash("sha256").update(sql).digest("hex") !== isolation.migration.sha256) throw new Error("Reader isolation migration differs.");
  await verifyIncrementalReader(db);
  const installed = (await db.query<{ installed: boolean }>(`SELECT EXISTS(SELECT 1 FROM pg_attribute
    WHERE attrelid='nb_delta.state'::regclass AND attname='reader_isolation_digest' AND NOT attisdropped) AS installed`)).rows[0]?.installed;
  if (installed !== true) {
    try { await db.query(sql); }
    catch (error) { await db.query("ROLLBACK").catch(() => {}); throw error; }
  }
  const rows = (await db.query<{ reader_isolation_digest: string | null }>("SELECT reader_isolation_digest FROM nb_delta.state WHERE singleton")).rows;
  if (rows.length !== 1 || rows[0].reader_isolation_digest !== null && rows[0].reader_isolation_digest !== isolation.migration.sha256) {
    throw new Error("Installed reader isolation differs.");
  }
  const permissions = (await db.query<{ isolated: boolean }>(`SELECT NOT rolcanlogin AND NOT rolsuper AND NOT rolbypassrls
    AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication
    AND NOT EXISTS(SELECT 1 FROM pg_auth_members WHERE member=r.oid)
    AND has_function_privilege(r.oid,'nb_delta_api.read_page(text,text,text)','EXECUTE')
    AND has_function_privilege(r.oid,'nb_delta_api.verify_operation(uuid,text,text)','EXECUTE')
    AND NOT has_function_privilege('nb_reader','nb_delta_api.read_page(text,text,text)','EXECUTE')
    AND NOT has_function_privilege('nb_reader','nb_delta_api.verify_operation(uuid,text,text)','EXECUTE') AS isolated
    FROM pg_roles r WHERE rolname='nb_delta_reader'`)).rows;
  if (permissions.length !== 1 || permissions[0].isolated !== true) throw new Error("Reader isolation unavailable.");
  await db.query("UPDATE nb_delta.state SET reader_isolation_digest=$1 WHERE singleton", [isolation.migration.sha256]);
}

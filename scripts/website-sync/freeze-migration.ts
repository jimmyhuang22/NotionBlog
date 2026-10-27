import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import protocol from "../../database/freeze-protocol.json" with { type: "json" };
import { verifyIncrementalPublication } from "../../src/server/database/incremental-publication.ts";
import { verifyFreeze } from "../../src/server/database/freeze.ts";
import type { SqlExecutor } from "../../src/server/database/sql.ts";

/** Dedicated owner Client only; the backend PID and transaction ID fence accidental pool usage.
 * Installation is inactive, and never creates a login, activates content, or starts a worker. */
export async function installFreeze(db: SqlExecutor): Promise<void> {
  const sql = await readFile(new URL(`../../supabase/migrations/${protocol.migration.file}`, import.meta.url), "utf8");
  if (createHash("sha256").update(sql).digest("hex") !== protocol.migration.sha256) throw Error("FREEZE_MIGRATION_DIFFERENT");
  await verifyIncrementalPublication(db);
  let committing = false;
  await db.query("BEGIN");
  try {
    await db.query("SET LOCAL lock_timeout='5s'");
    const identity = (await db.query<{ pid: number; xid: string }>("SELECT pg_backend_pid() AS pid,txid_current()::text AS xid")).rows[0];
    await db.query("SELECT pg_advisory_xact_lock(172904,2)");
    const installed = (await db.query<{ installed: boolean }>("SELECT to_regnamespace('nb_freeze') IS NOT NULL AS installed")).rows[0]?.installed;
    if (installed === false) {
      await db.query(sql.replace(/^BEGIN;$/m, "").replace(/^COMMIT;$/m, ""));
      await db.query("UPDATE nb_freeze.state SET migration_digest=$1 WHERE singleton", [protocol.migration.sha256]);
    } else if (installed !== true) throw Error("FREEZE_MIGRATION_DIFFERENT");
    await db.query("SELECT nb_freeze.install_media_guard()");
    await verifyFreeze(db);
    const after = (await db.query<{ pid: number; xid: string }>("SELECT pg_backend_pid() AS pid,txid_current()::text AS xid")).rows[0];
    if (!identity || identity.pid !== after?.pid || identity.xid !== after.xid) throw Error("FREEZE_INSTALL_SESSION_CHANGED");
    committing = true;
    await db.query("COMMIT");
  } catch (error) {
    try { await db.query("ROLLBACK"); } catch { /* Retain the original failure; discard this connection. */ }
    if (committing) throw Object.assign(Error("FREEZE_INSTALL_OUTCOME_UNKNOWN"), { cause: error });
    throw error;
  }
}

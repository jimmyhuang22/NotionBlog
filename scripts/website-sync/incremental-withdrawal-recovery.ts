import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import recovery from "../../database/incremental-withdrawal-recovery.json" with { type: "json" };
import { verifyIncrementalPublication } from "../../src/server/database/incremental-publication.ts";
import type { SqlExecutor } from "../../src/server/database/sql.ts";

/** Explicit owner-only upgrade. Never called during worker startup or a build.
 * Run only under separately approved database-operation authorization. */
export async function installIncrementalWithdrawalRecovery(db: SqlExecutor): Promise<void> {
  const sql = await readFile(new URL(`../../supabase/migrations/${recovery.migration.file}`, import.meta.url), "utf8");
  if (createHash("sha256").update(sql).digest("hex") !== recovery.migration.sha256) throw new Error("Withdrawal recovery migration differs.");
  await verifyIncrementalPublication(db);
  const installed = (await db.query<{ installed: string | null }>(
    "SELECT to_regprocedure('nb_delta_api.check_withdrawal_recovery(text)')::text AS installed")).rows[0]?.installed;
  if (!installed) {
    try { await db.query(sql); }
    catch (error) { await db.query("ROLLBACK").catch(() => {}); throw error; }
  }
  const rows = (await db.query<{ withdrawal_recovery_digest: string | null }>(
    "SELECT withdrawal_recovery_digest FROM nb_delta.state WHERE singleton")).rows;
  if (rows.length !== 1 || rows[0].withdrawal_recovery_digest !== null && rows[0].withdrawal_recovery_digest !== recovery.migration.sha256) {
    throw new Error("Installed withdrawal recovery differs.");
  }
  await db.query("UPDATE nb_delta.state SET withdrawal_recovery_digest=$1 WHERE singleton", [recovery.migration.sha256]);
  const result = (await db.query<{ valid: boolean }>("SELECT nb_delta_api.check_withdrawal_recovery($1) AS valid", [recovery.migration.sha256])).rows;
  if (result.length !== 1 || result[0].valid !== true) throw new Error("Withdrawal recovery unavailable.");
}

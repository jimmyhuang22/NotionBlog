import { verifyIncrementalPublication } from "../../src/server/database/incremental-publication.ts";
import { inOwnerInstallSession, type OwnerInstallSession } from "./owner-install-session.ts";
import { loadOwnerInstallRecipe, type OwnerInstallReceipt } from "./owner-install-recipes.ts";
import { admitOwnerReaderRole } from "./owner-reader-role.ts";

/** Explicit owner-only atomic upgrade. No worker startup/build installation or retry. */
export async function installIncrementalWithdrawalRecovery(session: OwnerInstallSession): Promise<OwnerInstallReceipt> {
  return inOwnerInstallSession(session, async (db, script) => {
    const recipe = await loadOwnerInstallRecipe("withdrawal-recovery");
    const state = (await db.query("SELECT singleton FROM nb_delta.state WHERE singleton FOR UPDATE")).rows;
    if (state.length !== 1) throw Error("OWNER_INSTALL_STATE");
    await verifyIncrementalPublication(db);
    await admitOwnerReaderRole(db, false);
    const markers = (await db.query<{ column: boolean; capability: boolean }>(`SELECT
      EXISTS(SELECT FROM pg_catalog.pg_attribute WHERE attrelid='nb_delta.state'::regclass AND attname='withdrawal_recovery_digest' AND NOT attisdropped) AS column,
      pg_catalog.to_regprocedure('nb_delta_api.check_withdrawal_recovery(text)') IS NOT NULL AS capability`)).rows;
    if (markers.length !== 1 || typeof markers[0].column !== "boolean" || typeof markers[0].capability !== "boolean" || markers[0].column !== markers[0].capability) throw Error("OWNER_INSTALL_RECOVERY_DIFFERENT");
    const installed = markers[0].column;
    if (installed) {
      const rows = (await db.query<{ digest: string | null }>("SELECT withdrawal_recovery_digest AS digest FROM nb_delta.state WHERE singleton")).rows;
      if (rows.length !== 1 || rows[0].digest !== recipe.schemaDigest) throw Error("OWNER_INSTALL_RECOVERY_DIFFERENT");
    } else {
      await script(recipe.body);
      const rows = (await db.query("UPDATE nb_delta.state SET withdrawal_recovery_digest=$1 WHERE singleton RETURNING singleton", [recipe.schemaDigest])).rows;
      if (rows.length !== 1) throw Error("OWNER_INSTALL_STATE");
    }
    const result = (await db.query<{ valid: boolean }>("SELECT nb_delta_api.check_withdrawal_recovery($1) AS valid", [recipe.schemaDigest])).rows;
    if (result.length !== 1 || result[0].valid !== true) throw Error("OWNER_INSTALL_RECOVERY_CAPABILITY");
    await admitOwnerReaderRole(db, false);
    const permissions = (await db.query<{ valid: boolean }>(`SELECT
      NOT EXISTS(SELECT FROM pg_catalog.pg_roles r WHERE r.rolname IN ('nb_reader','nb_writer','nb_delta_reader') AND
        NOT pg_catalog.has_function_privilege(r.oid,'nb_delta_api.check_withdrawal_recovery(text)','EXECUTE'))
      AND NOT EXISTS(SELECT FROM pg_catalog.pg_roles r WHERE r.rolname IN ('anon','authenticated','service_role') AND
        pg_catalog.has_function_privilege(r.oid,'nb_delta_api.check_withdrawal_recovery(text)','EXECUTE'))
      AND NOT EXISTS(SELECT FROM pg_catalog.pg_proc p CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a
        WHERE p.oid='nb_delta_api.check_withdrawal_recovery(text)'::regprocedure AND a.grantee=0 AND a.privilege_type='EXECUTE') AS valid`)).rows;
    if (permissions.length !== 1 || permissions[0].valid !== true) throw Error("OWNER_INSTALL_RECOVERY_CAPABILITY");
    return { schemaDigest: recipe.schemaDigest, recipeDigest: recipe.recipeDigest, outcome: installed ? "verified-existing" : "installed" };
  });
}

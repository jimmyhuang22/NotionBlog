import { verifyIncrementalReader } from "../../src/server/database/incremental-reader.ts";
import { inOwnerInstallSession, type OwnerInstallSession } from "./owner-install-session.ts";
import { loadOwnerInstallRecipe, type OwnerInstallReceipt } from "./owner-install-recipes.ts";
import { admitOwnerReaderRole, verifyOwnerReaderIsolation } from "./owner-reader-role.ts";

/** Explicit owner-only atomic upgrade; changes no LOGIN membership or credentials. */
export async function installIncrementalReaderIsolation(session: OwnerInstallSession): Promise<OwnerInstallReceipt> {
  return inOwnerInstallSession(session, async (db, script) => {
    const recipe = await loadOwnerInstallRecipe("reader-isolation");
    const state = (await db.query("SELECT singleton FROM nb_delta.state WHERE singleton FOR UPDATE")).rows;
    if (state.length !== 1) throw Error("OWNER_INSTALL_STATE");
    await verifyIncrementalReader(db);
    const columns = (await db.query<{ installed: boolean }>(`SELECT EXISTS(SELECT FROM pg_catalog.pg_attribute
      WHERE attrelid='nb_delta.state'::regclass AND attname='reader_isolation_digest' AND NOT attisdropped) AS installed`)).rows;
    if (columns.length !== 1 || typeof columns[0].installed !== "boolean") throw Error("OWNER_INSTALL_STATE");
    const installed = columns[0].installed;
    if (installed) {
      const rows = (await db.query<{ digest: string | null }>("SELECT reader_isolation_digest AS digest FROM nb_delta.state WHERE singleton")).rows;
      if (rows.length !== 1 || rows[0].digest !== recipe.schemaDigest) throw Error("OWNER_INSTALL_READER_DIFFERENT");
    }
    if (!installed) {
      const partial = (await db.query<{ partial: boolean }>(`SELECT EXISTS(SELECT FROM pg_catalog.pg_roles r
        JOIN pg_catalog.pg_proc p ON p.oid IN ('nb_delta_api.check_reader(text)'::regprocedure,'nb_delta_api.read_page(text,text,text)'::regprocedure,'nb_delta_api.verify_operation(uuid,text,text)'::regprocedure)
        CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a
        WHERE r.rolname='nb_delta_reader' AND a.grantee=r.oid AND a.privilege_type='EXECUTE') AS partial`)).rows;
      if (partial.length !== 1 || partial[0].partial !== false) throw Error("OWNER_INSTALL_READER_PARTIAL");
    }
    // Missing role on an existing installation is a conflict, never an implicit repair.
    await admitOwnerReaderRole(db, !installed);
    if (!installed) {
      await script(recipe.body);
      const rows = (await db.query("UPDATE nb_delta.state SET reader_isolation_digest=$1 WHERE singleton RETURNING singleton", [recipe.schemaDigest])).rows;
      if (rows.length !== 1) throw Error("OWNER_INSTALL_STATE");
    }
    await verifyOwnerReaderIsolation(db);
    return { schemaDigest: recipe.schemaDigest, recipeDigest: recipe.recipeDigest, outcome: installed ? "verified-existing" : "installed" };
  });
}

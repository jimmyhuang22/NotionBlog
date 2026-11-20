import type { GameTrophySetSummary } from "../../../contracts/content.ts";
import type { PublicationMode } from "./publication.ts";
import { callSql, type SqlExecutor } from "./sql.ts";

const capabilitySql = `SELECT EXISTS (
  SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'nb_game_trophies_api' AND p.proname = 'read_game_sets' AND p.pronargs = 3
    AND pg_catalog.has_schema_privilege(n.oid, 'USAGE') AND pg_catalog.has_function_privilege(p.oid, 'EXECUTE')
) AS result`;

/** Keep older database installs compatible. Read the actual sets and publication eligibility live. */
export function createGameTrophyReader(db: SqlExecutor, mode: PublicationMode) {
  let installed: Promise<boolean> | undefined;
  return async (id: string, slug: string): Promise<GameTrophySetSummary[]> => {
    if (!await (installed ??= callSql<boolean>(db, capabilitySql, []).catch(error => {
      installed = undefined;
      throw error;
    }))) return [];
    return callSql<GameTrophySetSummary[]>(db, "SELECT nb_game_trophies_api.read_game_sets($1,$2,$3) AS result",
      [id, slug, mode]);
  };
}

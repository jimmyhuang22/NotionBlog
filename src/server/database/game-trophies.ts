import type { GameTrophySetSummary } from "../../../contracts/content.ts";
import type { PublicationMode } from "./publication.ts";
import { callSql, type SqlExecutor } from "./sql.ts";

const capabilitySql = `SELECT EXISTS (
  SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'nb_game_trophies_api' AND p.proname = 'read_game_sets' AND p.pronargs = 3
    AND pg_catalog.has_schema_privilege(n.oid, 'USAGE') AND pg_catalog.has_function_privilege(p.oid, 'EXECUTE')
) AS result`;
const missingCapabilityTtlMs = 30_000;

/** Keep older database installs compatible. Read the actual sets and publication eligibility live. */
export function createGameTrophyReader(db: SqlExecutor, mode: PublicationMode) {
  let installed: Promise<boolean> | undefined;
  let recheckAt = Infinity;
  return async (id: string, slug: string): Promise<GameTrophySetSummary[]> => {
    if (Date.now() >= recheckAt) installed = undefined;
    if (!installed) {
      recheckAt = Infinity;
      installed = callSql<boolean>(db, capabilitySql, []).then(result => {
        if (!result) recheckAt = Date.now() + missingCapabilityTtlMs;
        return result;
      }, error => {
        installed = undefined;
        throw error;
      });
    }
    if (!await installed) return [];
    return callSql<GameTrophySetSummary[]>(db, "SELECT nb_game_trophies_api.read_game_sets($1,$2,$3) AS result",
      [id, slug, mode]);
  };
}

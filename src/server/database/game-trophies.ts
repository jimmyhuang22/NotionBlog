import type { GameTrophySetSummary } from "../../../contracts/content.ts";
import type { PublicationMode } from "./publication.ts";
import { callSql, type SqlExecutor } from "./sql.ts";

const capabilitySql = `SELECT EXISTS (
  SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'nb_game_trophies_api' AND p.proname = $1 AND p.pronargs = 3
    AND pg_catalog.has_schema_privilege(n.oid, 'USAGE') AND pg_catalog.has_function_privilege(p.oid, 'EXECUTE')
) AS result`;
const missingCapabilityTtlMs = 30_000;

/** Keep older database installs compatible. Read the actual sets and publication eligibility live. */
export function createGameTrophyReader(db: SqlExecutor, mode: PublicationMode) {
  return createSetReader(db, mode, "read_game_sets");
}

export function createCombinedGameTrophyReader(db: SqlExecutor, mode: PublicationMode) {
  const readPsn = createGameTrophyReader(db, mode);
  const readSteam = createSetReader(db, mode, "read_steam_game_sets");
  return async (id: string, slug: string) => {
    const [psn, steam] = await Promise.all([readPsn(id, slug), readSteam(id, slug)]);
    return [...psn, ...steam];
  };
}

function createSetReader(db: SqlExecutor, mode: PublicationMode, name: "read_game_sets" | "read_steam_game_sets") {
  let installed: Promise<boolean> | undefined;
  let recheckAt = Infinity;
  return async (id: string, slug: string): Promise<GameTrophySetSummary[]> => {
    if (Date.now() >= recheckAt) installed = undefined;
    if (!installed) {
      recheckAt = Infinity;
      installed = callSql<boolean>(db, capabilitySql, [name]).then(result => {
        if (!result) recheckAt = Date.now() + missingCapabilityTtlMs;
        return result;
      }, error => {
        installed = undefined;
        throw error;
      });
    }
    if (!await installed) return [];
    return callSql<GameTrophySetSummary[]>(db, `SELECT nb_game_trophies_api.${name}($1,$2,$3) AS result`,
      [id, slug, mode]);
  };
}

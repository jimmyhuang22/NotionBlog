import { ContentServiceError } from "../../../contracts/repository.ts";
import { databasePoolConfig } from "./connection.ts";
import { INCREMENTAL_LOGIN_SQL } from "./incremental-connection.ts";
import { WEBSITE_READER_ISOLATION_SQL } from "./website-reader-isolation.ts";
import type { SqlExecutor } from "./sql.ts";

function invalid(): never {
  throw new ContentServiceError("MISCONFIGURED", "The sync reader binding is invalid.");
}

/** Public post-publication verification has its own LOGIN. This deliberately
 * does not accept the website or evidence-reader LOGIN families. */
export function syncPublicReaderRole(connectionString: string | undefined): string {
  try {
    const config = databasePoolConfig(connectionString, "verify");
    const url = new URL(config.connectionString!);
    const match = /^(nb_sync_public_reader(?:_r20\d{6})?)(?:\.[a-z]{20})?$/.exec(decodeURIComponent(url.username));
    if (!url.password || !match) invalid();
    return match[1];
  } catch { return invalid(); }
}

const flags = ["safe_login", "isolated_role", "create_denied", "private_data_denied", "required_functions", "group_functions_only"] as const;
type Profile = Record<typeof flags[number], boolean> & { login: string; database: string };

/** No credential loading, connection, retry, write or Source call. Call on the
 * actual reader connection before starting work; close it on any rejection.
 * Membership checks include NOINHERIT/SET ROLE paths and admin options. */
export async function verifySyncPublicReader(db: SqlExecutor, connectionString: string): Promise<void> {
  const expected = syncPublicReaderRole(connectionString);
  try {
    const database = decodeURIComponent(new URL(connectionString).pathname.slice(1));
    const rows = (await db.query<Profile>(INCREMENTAL_LOGIN_SQL,
      ["nb_reader", ["nb_v2_api.read_snapshot(text[],boolean)"]])).rows;
    const p = rows[0];
    if (rows.length !== 1 || !p || Object.keys(p).length !== flags.length + 2 || p.login !== expected ||
      p.database !== database || flags.some(k => p[k] !== true)) invalid();
    const isolation = (await db.query<{ isolated: boolean }>(WEBSITE_READER_ISOLATION_SQL)).rows;
    if (isolation.length !== 1 || isolation[0].isolated !== true) invalid();
  } catch { invalid(); }
}

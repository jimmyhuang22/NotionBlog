import { ContentServiceError } from "../../../contracts/repository.ts";
import { databasePoolConfig } from "../database/connection.ts";
import type { SqlExecutor } from "../database/sql.ts";

export function socialReaderPoolConfig(env: Record<string, string | undefined>) {
  try {
    const url = new URL(env.SOCIAL_READER_DATABASE_URL ?? "");
    if (decodeURIComponent(url.username).split(".")[0] !== "nb_social_reader") throw new Error();
    const mode = env.SOCIAL_READER_CONNECTION_MODE ?? "configured";
    if (!["configured", "transaction"].includes(mode)) throw new Error();
    if (mode === "transaction") {
      // Preserve the reviewed host, role, password and TLS; only the shared-pooler port changes.
      if (!/^aws-[a-z0-9-]+\.pooler\.supabase\.com$/.test(url.hostname) || !["5432", "6543"].includes(url.port) || !/^nb_social_reader\.[a-z0-9]+$/.test(decodeURIComponent(url.username))) throw new Error();
      url.port = "6543";
    }
    return { ...databasePoolConfig(mode === "transaction" ? url.toString() : env.SOCIAL_READER_DATABASE_URL, env.SOCIAL_READER_DATABASE_TLS, env.SOCIAL_READER_DATABASE_CA_CERT),
      max: mode === "transaction" ? 1 : 2, idleTimeoutMillis: 5000, application_name: "notionblog-social-reader", statement_timeout: 10000, query_timeout: 12000 };
  } catch { throw new ContentServiceError("MISCONFIGURED", "The social reader connection is not configured."); }
}
export async function verifySocialReader(sql: SqlExecutor): Promise<void> {
  try {
    const { rows } = await sql.query<{ role: string; login: string; version: number; elevated: boolean }>(`SELECT current_user AS role,session_user AS login,
      (SELECT version FROM social_sync.reader_meta WHERE singleton) AS version,
      (rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole OR rolreplication OR rolinherit OR
       EXISTS(SELECT 1 FROM pg_auth_members WHERE member=pg_roles.oid)) AS elevated
      FROM pg_roles WHERE rolname=current_user`);
    if (rows.length !== 1 || rows[0].role !== "nb_social_reader" || rows[0].login !== "nb_social_reader" || rows[0].version !== 1 || rows[0].elevated !== false) throw new Error();
  } catch { throw new ContentServiceError("CONTENT_UNAVAILABLE", "Social content is temporarily unavailable."); }
}

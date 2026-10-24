import { ContentServiceError } from "../../../contracts/repository.ts";
import type { SqlExecutor } from "./sql.ts";

/** Include every reachable role, even NOINHERIT memberships usable via SET ROLE. */
export const WEBSITE_READER_ISOLATION_SQL = `WITH RECURSIVE roles(oid) AS (
 SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user
 UNION SELECT m.roleid FROM pg_catalog.pg_auth_members m JOIN roles r ON m.member=r.oid
)
SELECT NOT EXISTS(SELECT 1 FROM roles JOIN pg_catalog.pg_roles r USING(oid)
 WHERE r.rolsuper OR r.rolcreaterole OR r.rolbypassrls OR r.rolname IN ('nb_delta_reader','nb_writer'))
 AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
 CROSS JOIN roles r WHERE n.nspname='nb_delta_api' AND p.proname IN ('check_reader','read_page','verify_operation')
 AND pg_catalog.has_function_privilege(r.oid,p.oid,'EXECUTE')) AS isolated`;

/** Check once before the runtime's first content query. Failed checks are not
 * cached; errors contain no credential, source or raw database diagnostics. */
export function isolatedWebsiteReader(db: SqlExecutor): SqlExecutor {
  let ready: Promise<void> | undefined;
  async function inspect() {
    try {
      const rows = (await db.query<{ isolated: boolean }>(WEBSITE_READER_ISOLATION_SQL)).rows;
      if (rows.length !== 1 || rows[0].isolated !== true) throw new Error();
    } catch {
      throw new ContentServiceError("CONTENT_UNAVAILABLE", "The website reader permissions are not isolated.");
    }
  }
  return { async query<T>(text: string, values?: unknown[]) {
    await (ready ??= inspect().catch(error => { ready = undefined; throw error; }));
    return db.query<T>(text, values);
  } };
}

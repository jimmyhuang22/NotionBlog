import { ContentServiceError } from "../../../contracts/repository.ts";
import type { SqlExecutor } from "./sql.ts";

export type WebsiteReaderIsolationMode = "off" | "enforce";
/** A missing server setting deliberately defers enforcement during the staged rollout. */
export function websiteReaderIsolationMode(value: unknown): WebsiteReaderIsolationMode {
  if (value === undefined || value === "off") return "off";
  if (value === "enforce") return "enforce";
  throw new ContentServiceError("MISCONFIGURED", "The website reader isolation mode is invalid.");
}

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

/** Strict library calls check once before the first content query. The website
 * runtime can explicitly defer; failed strict checks are never cached. */
export function isolatedWebsiteReader(db: SqlExecutor, mode: WebsiteReaderIsolationMode = "enforce",
  reportDeferred: () => void = () => console.warn("WEBSITE_READER_ISOLATION_DEFERRED")): SqlExecutor {
  const selected = websiteReaderIsolationMode(mode);
  if (selected === "off") {
    let reported = false;
    return { async query<T>(text: string, values?: unknown[]) {
      if (!reported) { reported = true; try { reportDeferred(); } catch { /* Diagnostics cannot block deferred reads. */ } }
      return db.query<T>(text, values);
    } };
  }
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

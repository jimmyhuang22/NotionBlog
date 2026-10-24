import { createHash } from "node:crypto";
import { ContentServiceError } from "../../../contracts/repository.ts";
import type { SqlExecutor } from "./sql.ts";
import type { DirectDenyRead } from "../notion/direct-policy.ts";
import { checkContentReadBudget } from "../content-read-budget.ts";
import protocol from "../../../database/notion-direct-deny-protocol.json" with { type: "json" };

export const DIRECT_POLICY_SQL = "SELECT nb_policy_api.check_denied($1::integer,$2::text[]) AS result";
// Explicit identities: an accidental writer grant, even to nb_reader itself, is not a read capability.
const readable = [
  "nb_api.read_content(text,text,text,jsonb,integer,integer,uuid,bigint,boolean)", "nb_api.read_media(text)",
  "nb_api.read_status(text,jsonb,integer,integer,uuid,bigint)", "nb_api.status_years(text)",
  "nb_v2_api.read_content(text,text,text,jsonb,integer,integer,uuid,bigint,boolean)", "nb_v2_api.read_media(text)", "nb_v2_api.read_snapshot(text[],boolean)",
  "nb_media_api.read_source(text)", "nb_v2_media_api.read_source(text)", "nb_thumbnail_api.read_media(text,text,integer)",
  "nb_publication_api.check_capability(text)", "nb_publication_api.read_snapshot(text[],boolean)", "nb_publication_api.read_media(text)",
  "nb_publication_api.check_thumbnail_capability(text)", "nb_publication_api.read_thumbnail(text,integer,text)",
  "nb_read_api.check_capability(text)", "nb_read_api.read_version(text)",
  "nb_read_api.read_content(text,text,text,text,jsonb,integer,integer,uuid,bigint,boolean,boolean)",
  "nb_read_api.read_selected(text,text,text[],uuid,bigint)", "nb_read_api.read_snapshot(text,text[],boolean,boolean)", "nb_read_api.read_search(text,text[])",
  "nb_read_api.check_search_parts(text)", "nb_read_api.read_search_parts(text,text[])", "nb_read_api.check_search_walk(text)",
  "nb_read_api.check_search_precomputed(text,text)", "nb_read_api.read_search_precomputed(text,text[])",
  "nb_read_api.check_search_filtered(text)", "nb_read_api.read_search_filtered(text,text[],text[])",
  "nb_search_context_api.read_context(text,text[],uuid,bigint,text)", "nb_cache_api.read_stamp()", "nb_cache_api.read_event(uuid)",
  "nb_policy_api.check_denied(integer,text[])",
];
const family = "(n.nspname='nb' OR n.nspname LIKE 'nb\\_%' ESCAPE '\\')";
export const DIRECT_POLICY_CATALOG_SQL = `WITH RECURSIVE roles(oid) AS (
 SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user
 UNION SELECT m.roleid FROM pg_catalog.pg_auth_members m JOIN roles r ON m.member=r.oid
), candidate AS (SELECT p.*,n.nspowner FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname='nb_policy_api' AND p.proname='check_denied')
SELECT p.prosrc AS source,p.prosecdef AS definer,p.provolatile AS volatility,p.proconfig AS config,
 (SELECT lanname FROM pg_catalog.pg_language WHERE oid=p.prolang) AS language,
 p.proargtypes::text AS arguments,p.prorettype::regtype::text AS result_type,
 p.proowner=p.nspowner AND p.proowner=(SELECT nspowner FROM pg_catalog.pg_namespace WHERE nspname='nb')
 AND p.proowner=(SELECT nspowner FROM pg_catalog.pg_namespace WHERE nspname='nb_v2') AS owner_matches,
 (SELECT count(*) FROM pg_catalog.pg_proc f JOIN pg_catalog.pg_namespace n ON n.oid=f.pronamespace WHERE n.nspname='nb_policy_api')=1 AS only_function,
 EXISTS(SELECT FROM roles r JOIN pg_catalog.pg_roles u USING(oid) WHERE u.rolname='nb_reader')
 AND current_user=session_user AND (SELECT rolcanlogin FROM pg_catalog.pg_roles WHERE rolname=current_user)
 AND NOT EXISTS(SELECT FROM roles r JOIN pg_catalog.pg_roles u USING(oid) WHERE
  u.rolsuper OR u.rolcreatedb OR u.rolcreaterole OR u.rolreplication OR u.rolbypassrls
  OR u.rolname NOT IN (current_user,'nb_reader') OR (u.rolname='nb_reader' AND u.rolcanlogin))
 AND NOT EXISTS(SELECT FROM pg_catalog.pg_auth_members m JOIN roles r ON m.member=r.oid WHERE m.admin_option)
 AND NOT pg_catalog.has_database_privilege(current_user,current_database(),'CREATE')
 AND NOT EXISTS(SELECT FROM pg_catalog.pg_namespace n CROSS JOIN roles r WHERE ${family}
  AND (pg_catalog.has_schema_privilege(r.oid,n.oid,'CREATE') OR n.nspowner=r.oid))
 AND NOT EXISTS(SELECT FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace CROSS JOIN roles r
  WHERE ${family} AND ((c.relkind IN ('r','p','v','m','f') AND
   (pg_catalog.has_table_privilege(r.oid,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    OR pg_catalog.has_any_column_privilege(r.oid,c.oid,'SELECT,INSERT,UPDATE,REFERENCES')))
   OR (c.relkind='S' AND pg_catalog.has_sequence_privilege(r.oid,c.oid,'USAGE,SELECT,UPDATE'))))
 AND NOT EXISTS(SELECT FROM pg_catalog.pg_proc f JOIN pg_catalog.pg_namespace n ON n.oid=f.pronamespace CROSS JOIN roles r
  WHERE ${family} AND (f.proowner=r.oid OR
   (pg_catalog.has_schema_privilege(r.oid,n.oid,'USAGE') AND pg_catalog.has_function_privilege(r.oid,f.oid,'EXECUTE')
    AND f.oid NOT IN (SELECT pg_catalog.to_regprocedure(identity) FROM unnest(ARRAY[${readable.map(s => `'${s}'`).join(",")}]) identity
     WHERE pg_catalog.to_regprocedure(identity) IS NOT NULL)))) AS reader_safe,
 pg_catalog.has_function_privilege(current_user,p.oid,'EXECUTE') AS callable,
 NOT EXISTS(SELECT FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a
  WHERE a.grantee NOT IN (p.proowner,(SELECT oid FROM pg_catalog.pg_roles WHERE rolname='nb_reader'))
   OR (a.grantee<>p.proowner AND a.is_grantable)) AS exact_acl
FROM candidate p`;

/** New for each public operation. The pool can be shared; capability and authorization are fresh. */
export function createDirectDenyReader(db: SqlExecutor, version: 1 | 2): DirectDenyRead {
  let inspected: Promise<void> | undefined;
  let queries = 0, bytes = 0;
  async function query<T>(sql: string, values?: unknown[]): Promise<T[]> {
    checkContentReadBudget();
    if (++queries > 64) throw new ContentServiceError("CONTENT_UNAVAILABLE", "The central policy read limit was reached.");
    const rows = (await db.query<T>(sql, values)).rows;
    bytes += Buffer.byteLength(JSON.stringify(rows));
    if (bytes > 256 * 1024) throw new ContentServiceError("CONTENT_UNAVAILABLE", "The central policy response limit was reached.");
    checkContentReadBudget();return rows;
  }
  async function inspect() {
    try {
      const rows = await query<Record<string, unknown>>(DIRECT_POLICY_CATALOG_SQL), r = rows[0];
      if (rows.length !== 1 || !r || typeof r.source !== "string" || createHash("sha256").update(r.source).digest("hex") !== protocol.function.sourceSHA256 ||
        r.definer !== true || r.language !== "plpgsql" || r.volatility !== "s" || JSON.stringify(r.config) !== '["search_path=pg_catalog"]' || r.arguments !== "23 1009" || r.result_type !== "jsonb" ||
        ["owner_matches","only_function","reader_safe","callable","exact_acl"].some(key => r[key] !== true)) throw new Error();
    } catch { throw new ContentServiceError("MISCONFIGURED", "The direct content policy capability or reader is not configured."); }
  }
  return async ids => {
    try {
      if (![1, 2].includes(version) || !Array.isArray(ids) || ids.length > 256 || ids.some(id => !/^[a-f0-9]{32}$/.test(id))) throw new Error();
      await (inspected ??= inspect());
      const rows = await query<{ result: unknown }>(DIRECT_POLICY_SQL, [version, [...ids]]);
      if (rows.length !== 1) throw new Error();
      return rows[0].result as Awaited<ReturnType<DirectDenyRead>>;
    } catch (error) {
      if (error instanceof ContentServiceError) throw error;
      throw new ContentServiceError("CONTENT_UNAVAILABLE", "The central content policy could not be read.");
    }
  };
}

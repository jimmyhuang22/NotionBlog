import { createHash } from "node:crypto";
import type { SqlExecutor } from "../../src/server/database/sql.ts";
import protocol from "../../database/public-cache-commit-protocol.json" with { type: "json" };

/** One read-only system-catalog SELECT. No event payloads, content, source IDs or credentials. */
export const COMMIT_CATALOG_SQL = `WITH functions AS (
 SELECT signature,p.*,l.lanname FROM unnest($1::text[]) AS signatures(signature)
 LEFT JOIN pg_catalog.pg_proc p ON p.oid=to_regprocedure(signature)
 LEFT JOIN pg_catalog.pg_language l ON l.oid=p.prolang
), tables AS (
 SELECT name,c.* FROM (VALUES('nb_cache.commit_config'),('nb_cache.commit_intents')) names(name)
 LEFT JOIN pg_catalog.pg_class c ON c.oid=to_regclass(name)
), actors AS (
 SELECT oid,rolname FROM pg_catalog.pg_roles WHERE rolname IN
 ('nb_reader','nb_writer','nb_cache_operator','nb_cache_publisher','nb_social_worker','nb_social_reader','anon','authenticated','service_role')
) SELECT jsonb_build_object(
 'functions',(SELECT jsonb_agg(jsonb_build_object('signature',signature,'present',oid IS NOT NULL,
  'sourceSha256',encode(sha256(convert_to(prosrc,'UTF8')),'hex'),'language',lanname,'volatility',provolatile::text,
  'securityDefiner',prosecdef,'searchPath',proconfig,'ownerMatches',proowner=(SELECT relowner FROM pg_catalog.pg_class WHERE oid=to_regclass('nb_cache.state')),
  'acl',(SELECT jsonb_agg(jsonb_build_object(
   'grantee',CASE WHEN a.grantee=functions.proowner THEN '$owner' WHEN a.grantee=0 THEN 'PUBLIC' ELSE (SELECT rolname FROM pg_catalog.pg_roles WHERE oid=a.grantee) END,
   'grantor',CASE WHEN a.grantor=functions.proowner THEN '$owner' ELSE (SELECT rolname FROM pg_catalog.pg_roles WHERE oid=a.grantor) END,
   'privilege',a.privilege_type,'grantable',a.is_grantable) ORDER BY (CASE WHEN a.grantee=functions.proowner THEN '$owner' WHEN a.grantee=0 THEN 'PUBLIC' ELSE (SELECT rolname FROM pg_catalog.pg_roles WHERE oid=a.grantee) END) COLLATE "C",a.privilege_type,a.is_grantable)
   FROM aclexplode(coalesce(proacl,acldefault('f',proowner))) a),
  'publicExecute',EXISTS(SELECT FROM aclexplode(coalesce(proacl,acldefault('f',proowner))) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE'),
  'roleExecute',(SELECT jsonb_object_agg(rolname,has_function_privilege(actors.oid,functions.oid,'EXECUTE')) FROM actors)) ORDER BY signature) FROM functions),
 'tables',(SELECT jsonb_agg(jsonb_build_object('name',name,'present',oid IS NOT NULL,'kind',relkind::text,'rls',relrowsecurity,
  'ownerMatches',relowner=(SELECT relowner FROM pg_catalog.pg_class WHERE oid=to_regclass('nb_cache.state')),
  'columns',(SELECT jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'notNull',a.attnotnull,'default',pg_get_expr(d.adbin,d.adrelid)) ORDER BY a.attnum)
   FROM pg_catalog.pg_attribute a LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid=tables.oid AND a.attnum>0 AND NOT a.attisdropped),
  'constraints',(SELECT jsonb_agg(jsonb_build_object('name',conname,'definition',pg_get_constraintdef(c.oid),'validated',convalidated) ORDER BY conname) FROM pg_catalog.pg_constraint c WHERE c.conrelid=tables.oid AND c.contype<>'n'),
  'acl',(SELECT jsonb_agg(jsonb_build_object(
   'grantee',CASE WHEN a.grantee=tables.relowner THEN '$owner' WHEN a.grantee=0 THEN 'PUBLIC' ELSE (SELECT rolname FROM pg_catalog.pg_roles WHERE oid=a.grantee) END,
   'grantor',CASE WHEN a.grantor=tables.relowner THEN '$owner' ELSE (SELECT rolname FROM pg_catalog.pg_roles WHERE oid=a.grantor) END,
   'privilege',a.privilege_type,'grantable',a.is_grantable) ORDER BY (CASE WHEN a.grantee=tables.relowner THEN '$owner' WHEN a.grantee=0 THEN 'PUBLIC' ELSE (SELECT rolname FROM pg_catalog.pg_roles WHERE oid=a.grantee) END) COLLATE "C",a.privilege_type,a.is_grantable)
   FROM aclexplode(coalesce(relacl,acldefault('r',relowner))) a),
  'publicAccess',EXISTS(SELECT FROM aclexplode(coalesce(relacl,acldefault('r',relowner))) a WHERE a.grantee=0),
  'roleAccess',(SELECT jsonb_object_agg(rolname,has_table_privilege(actors.oid,tables.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')) FROM actors)) ORDER BY name) FROM tables),
 'triggers',(SELECT jsonb_agg(jsonb_build_object('name',t.tgname,'enabled',t.tgenabled::text,'type',t.tgtype,'deferrable',t.tgdeferrable,'initiallyDeferred',t.tginitdeferred,
  'function',p.proname,'schema',n.nspname) ORDER BY t.tgname) FROM pg_catalog.pg_trigger t
  JOIN pg_catalog.pg_proc p ON p.oid=t.tgfoid JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE t.tgrelid=to_regclass('nb_cache.commit_intents') AND NOT t.tgisinternal)
) AS result`;
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  return "{" + Object.entries(value).sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => JSON.stringify(k) + ":" + canonical(v)).join(",") + "}";
}
export async function readCommitCatalog(db: SqlExecutor): Promise<unknown> {
  const result = await db.query<{ result: unknown }>(COMMIT_CATALOG_SQL, [protocol.functions.map(f => f.signature)]);
  if (result.rows.length !== 1 || !result.rows[0]?.result || Buffer.byteLength(JSON.stringify(result.rows[0].result)) > 32768) throw Error("CACHE_COMMIT_CATALOG_INVALID");
  return result.rows[0].result;
}
/** Compare against independently reviewed pins; never learn expectations from a live result. */
export function verifyCommitCatalog(actual: unknown, expected: unknown): void {
  if (!actual || !expected || Buffer.byteLength(JSON.stringify(actual)) > 32768 || canonical(actual) !== canonical(expected)) throw Error("CACHE_COMMIT_CATALOG_MISMATCH");
}

export const commitCatalogDigest = (value: unknown): string => createHash("sha256").update(canonical(value)).digest("hex");
/** A known legacy before-image or the exact new image; partial/unreviewed states stay blocked. */
export function classifyCommitCatalog(actual: unknown): "legacy" | "installed" | "mismatch" {
  if (!actual || Buffer.byteLength(JSON.stringify(actual)) > 32768) return "mismatch";
  if (commitCatalogDigest(actual) === protocol.beforeCatalogSha256) return "legacy";
  try { verifyCommitCatalog(actual,protocol.expectedCatalog); return "installed"; } catch { return "mismatch"; }
}

import type { SqlExecutor } from "../../src/server/database/sql.ts";

const required = ["nb_publication_api.check_capability(text)", "nb_publication_api.read_snapshot(text[],boolean)",
  "nb_delta_api.check_capability(text)", "nb_delta_api.read_state()", "nb_delta_api.check_reader(text)",
  "nb_delta_api.read_page(text,text,text)", "nb_delta_api.verify_operation(uuid,text,text)"];
const optional = ["nb_publication_api.check_thumbnail_capability(text)", "nb_publication_api.read_thumbnail(text,integer,text)",
  "nb_delta_api.check_withdrawal_recovery(text)"];
const app = "n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'";
/** Inspect effective data access and ownership, plus explicit grants even without schema USAGE.
 * PUBLIC catalog/basic access is not confused with new application capabilities. */
export const OWNER_READER_ROLE_SQL = `
WITH target AS (SELECT * FROM pg_catalog.pg_roles WHERE rolname='nb_delta_reader'),
allowed(oid) AS (SELECT pg_catalog.to_regprocedure(signature)::oid FROM unnest($1::text[]) signature)
SELECT NOT (r.rolcanlogin OR r.rolsuper OR r.rolbypassrls OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication)
 AND NOT EXISTS(SELECT FROM pg_catalog.pg_auth_members WHERE member=r.oid)
 AND NOT pg_catalog.has_database_privilege(r.oid,current_database(),'CREATE')
 AND NOT EXISTS(SELECT FROM pg_catalog.pg_shdepend d WHERE d.refclassid='pg_catalog.pg_authid'::regclass AND d.refobjid=r.oid AND d.deptype='o'
   AND (d.dbid=(SELECT oid FROM pg_catalog.pg_database WHERE datname=current_database()) OR d.dbid=0))
 AND NOT EXISTS(SELECT FROM pg_catalog.pg_default_acl d, LATERAL pg_catalog.aclexplode(d.defaclacl) a WHERE a.grantee=r.oid)
 AND NOT EXISTS(SELECT FROM pg_catalog.pg_namespace n WHERE ${app} AND
   (pg_catalog.has_schema_privilege(r.oid,n.oid,'CREATE') OR EXISTS(SELECT FROM pg_catalog.aclexplode(COALESCE(n.nspacl,pg_catalog.acldefault('n',n.nspowner))) a
    WHERE a.grantee=r.oid AND (a.is_grantable OR a.privilege_type<>'USAGE' OR n.nspname NOT IN ('nb_publication_api','nb_delta_api')))))
 AND NOT EXISTS(SELECT FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE ${app} AND
   ((pg_catalog.has_schema_privilege(r.oid,n.oid,'USAGE') AND
    ((c.relkind IN ('r','p','v','m','f') AND (pg_catalog.has_table_privilege(r.oid,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR
    pg_catalog.has_any_column_privilege(r.oid,c.oid,'SELECT,INSERT,UPDATE,REFERENCES'))) OR
    (c.relkind='S' AND pg_catalog.has_sequence_privilege(r.oid,c.oid,'USAGE,SELECT,UPDATE')))) OR
    EXISTS(SELECT FROM pg_catalog.aclexplode(c.relacl) a WHERE a.grantee=r.oid) OR
    EXISTS(SELECT FROM pg_catalog.pg_attribute col CROSS JOIN LATERAL pg_catalog.aclexplode(col.attacl) a
      WHERE col.attrelid=c.oid AND col.attnum>0 AND NOT col.attisdropped AND a.grantee=r.oid)))
 AND NOT EXISTS(SELECT FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE ${app} AND
   ((NOT EXISTS(SELECT FROM allowed WHERE allowed.oid=p.oid) AND
      ((pg_catalog.has_schema_privilege(r.oid,n.oid,'USAGE') AND pg_catalog.has_function_privilege(r.oid,p.oid,'EXECUTE')) OR
       EXISTS(SELECT FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a WHERE a.grantee=r.oid))) OR
    EXISTS(SELECT FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a WHERE a.grantee=r.oid AND a.is_grantable))) AS compatible
FROM target r`;

export async function admitOwnerReaderRole(db: SqlExecutor, create: boolean): Promise<void> {
  const rows = (await db.query<{ compatible: boolean }>(OWNER_READER_ROLE_SQL, [[...required, ...optional]])).rows;
  if (rows.length === 0 && create) {
    // A concurrent creation fails normally; never ALTER, DROP or retry a cluster identity.
    await db.query("CREATE ROLE nb_delta_reader NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS");
    return admitOwnerReaderRole(db, false);
  }
  if (rows.length > 1 || rows.length === 1 && rows[0].compatible !== true || create && rows.length !== 1) throw Error("OWNER_INSTALL_READER_ROLE_CONFLICT");
}
export async function verifyOwnerReaderIsolation(db: SqlExecutor): Promise<void> {
  await admitOwnerReaderRole(db, false);
  const rows = (await db.query<{ valid: boolean }>(`SELECT EXISTS(SELECT FROM pg_catalog.pg_roles WHERE rolname='nb_delta_reader')
    AND pg_catalog.has_schema_privilege('nb_delta_reader','nb_publication_api','USAGE')
    AND pg_catalog.has_schema_privilege('nb_delta_reader','nb_delta_api','USAGE')
    AND NOT EXISTS(SELECT FROM unnest($1::text[]) signature WHERE NOT COALESCE(pg_catalog.has_function_privilege('nb_delta_reader',pg_catalog.to_regprocedure(signature),'EXECUTE'),false))
    AND NOT EXISTS(SELECT FROM unnest($2::text[]) signature WHERE pg_catalog.to_regprocedure(signature) IS NOT NULL AND
      NOT COALESCE(pg_catalog.has_function_privilege('nb_delta_reader',pg_catalog.to_regprocedure(signature),'EXECUTE'),false))
    AND NOT EXISTS(SELECT FROM pg_catalog.pg_roles r CROSS JOIN unnest($3::text[]) signature
      WHERE r.rolname IN ('nb_reader','nb_writer','anon','authenticated','service_role') AND
      pg_catalog.has_function_privilege(r.oid,pg_catalog.to_regprocedure(signature),'EXECUTE')) AS valid`,
    [required, optional, ["nb_delta_api.check_reader(text)", "nb_delta_api.read_page(text,text,text)", "nb_delta_api.verify_operation(uuid,text,text)"]])).rows;
  if (rows.length !== 1 || rows[0].valid !== true) throw Error("OWNER_INSTALL_READER_CAPABILITY");
}

import { createDatabasePool } from '../../src/server/database/connection.ts';
import { verifySocialReader } from '../../src/server/social/reader.ts';
import { sqlExecutor } from '../../src/server/database/connection.ts';

/** One bounded startup check; the website never receives an owner/writer login. */
export async function verifySelfHostedReaders(env: NodeJS.ProcessEnv): Promise<void> {
  const pool = createDatabasePool(env.DATABASE_READER_URL, env.DATABASE_TLS, env.DATABASE_CA_CERT);
  try {
    const row = (await pool.query<{ role: string; login: string; safe: boolean; execute: boolean; private_read: boolean }>(`WITH RECURSIVE reader_roles(oid) AS (
      SELECT oid FROM pg_roles WHERE rolname=current_user
      UNION SELECT m.roleid FROM pg_auth_members m JOIN reader_roles r ON m.member=r.oid
    ) SELECT current_user AS role,session_user AS login,
      NOT (rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole OR rolreplication OR
        EXISTS (SELECT 1 FROM reader_roles i JOIN pg_roles r ON r.oid=i.oid
          WHERE r.rolname NOT IN ('nb_website_reader','nb_reader') OR r.rolsuper OR r.rolbypassrls OR
            r.rolcreatedb OR r.rolcreaterole OR r.rolreplication) OR
        EXISTS (SELECT 1 FROM pg_auth_members m JOIN reader_roles r ON m.member=r.oid WHERE m.admin_option) OR
        EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace,
          unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) privilege
          WHERE left(n.nspname,3)='nb_' AND c.relkind IN ('r','p','v','m','f') AND
            has_table_privilege(current_user,c.oid,privilege) AND NOT has_table_privilege('nb_reader',c.oid,privilege)) OR
        EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
          WHERE left(n.nspname,3)='nb_' AND has_function_privilege(current_user,p.oid,'EXECUTE') AND
            NOT has_function_privilege('nb_reader',p.oid,'EXECUTE'))) AS safe,
      has_function_privilege(current_user,'nb_v2_api.read_snapshot(text[],boolean)','EXECUTE') AS execute,
      has_table_privilege(current_user,(SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='nb_v2' AND c.relname='records'),'SELECT') AS private_read
      FROM pg_roles WHERE rolname=current_user`)).rows;
    if (row.length !== 1 || row[0].role !== 'nb_website_reader' || row[0].login !== 'nb_website_reader' ||
        row[0].safe !== true || row[0].execute !== true || row[0].private_read !== false) throw Error();
  } catch { throw Error('SELF_HOSTED_READER_VERIFICATION'); }
  finally { await pool.end(); }
  if (env.SOCIAL_PROVIDER === 'database') {
    const social = createDatabasePool(env.SOCIAL_READER_DATABASE_URL, env.SOCIAL_READER_DATABASE_TLS, env.SOCIAL_READER_DATABASE_CA_CERT);
    try { await verifySocialReader(sqlExecutor(social)); }
    catch { throw Error('SELF_HOSTED_SOCIAL_READER_VERIFICATION'); }
    finally { await social.end(); }
  }
}

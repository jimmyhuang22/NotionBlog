import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { PoolConfig } from "pg";
import { ContentServiceError } from "../contracts/repository.ts";
import { createDatabasePool, databasePoolConfig, sqlExecutor } from "../src/server/database/connection.ts";
import { createDatabaseRepository } from "../src/server/database/repository.ts";
import { createStorageReaderToken, type ReaderAuthOptions } from "../src/server/database/reader-auth.ts";
import { createSupabaseStorage } from "../src/server/database/storage.ts";
import type { SqlExecutor } from "../src/server/database/sql.ts";

type Mode = "config-only" | "verify-access";
interface Check { name: string; status: "pass" | "fail" | "pending" }
export interface ReaderCheckReport {
  mode: Mode; ok: boolean; checks: Check[];
  content: "not-checked" | "ready" | "unavailable";
  media: "pending";
}
export interface ReaderCheckDependencies {
  openDatabase?: (config: PoolConfig) => { db: SqlExecutor; close: () => Promise<void> };
  fetch?: typeof fetch;
  now?: () => number;
}

/** Catalog inspection only: never invoke a writer function or query private content tables. */
export const READER_PERMISSIONS_SQL = `
WITH RECURSIVE me AS (SELECT * FROM pg_catalog.pg_roles WHERE rolname=current_user),
roles(oid) AS (
  SELECT oid FROM me
  UNION SELECT m.roleid FROM pg_catalog.pg_auth_members m JOIN roles r ON m.member=r.oid
), core_allowed(signature) AS (VALUES
  ('nb_api.read_content(text,text,text,jsonb,integer,integer,uuid,bigint,boolean)'),
  ('nb_api.read_media(text)'),
  ('nb_api.read_status(text,jsonb,integer,integer,uuid,bigint)'),
  ('nb_api.status_years(text)')
), allowed(signature) AS (
  SELECT signature FROM core_allowed
  UNION SELECT 'nb_media_api.read_source(text)' WHERE pg_catalog.to_regprocedure('nb_media_api.read_source(text)') IS NOT NULL
  UNION SELECT 'nb_v2_media_api.read_source(text)' WHERE pg_catalog.to_regprocedure('nb_v2_media_api.read_source(text)') IS NOT NULL
  UNION SELECT 'nb_thumbnail_api.read_media(text,text,integer)' WHERE pg_catalog.to_regprocedure('nb_thumbnail_api.read_media(text,text,integer)') IS NOT NULL
  UNION SELECT 'nb_v2_api.read_media(text)' WHERE pg_catalog.to_regprocedure('nb_v2_api.read_media(text)') IS NOT NULL
  UNION SELECT 'nb_v2_api.read_snapshot(text[],boolean)' WHERE pg_catalog.to_regprocedure('nb_v2_api.read_snapshot(text[],boolean)') IS NOT NULL
  UNION SELECT 'nb_v2_api.read_content(text,text,text,jsonb,integer,integer,uuid,bigint,boolean)' WHERE pg_catalog.to_regprocedure('nb_v2_api.read_content(text,text,text,jsonb,integer,integer,uuid,bigint,boolean)') IS NOT NULL
), writers(signature) AS (VALUES
  ('nb_api.begin_run(uuid,text,text,text,integer)'),
  ('nb_api.renew_run(uuid,bigint,integer)'),
  ('nb_api.stage_batch(uuid,bigint,jsonb,jsonb,jsonb)'),
  ('nb_api.promote_run(uuid,bigint,integer,integer,boolean,integer)'),
  ('nb_api.fail_run(uuid,bigint)')
)
SELECT
  COALESCE((SELECT rolcanlogin AND current_user=session_user AND NOT
    (rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole OR rolreplication) FROM me),false) AS safe_login,
  EXISTS(SELECT FROM pg_catalog.pg_auth_members m JOIN me ON m.member=me.oid
    JOIN pg_catalog.pg_roles r ON r.oid=m.roleid WHERE r.rolname='nb_reader')
  AND NOT EXISTS(SELECT FROM roles JOIN pg_catalog.pg_roles r USING(oid)
    WHERE r.rolname<>current_user AND (r.rolname<>'nb_reader' OR r.rolcanlogin OR
      r.rolsuper OR r.rolbypassrls OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication))
  AND NOT EXISTS(SELECT FROM pg_catalog.pg_auth_members m JOIN roles ON m.member=roles.oid
    WHERE m.admin_option) AS reader_only,
  NOT pg_catalog.has_database_privilege(current_user,current_database(),'CREATE')
  AND NOT EXISTS(SELECT FROM pg_catalog.pg_database d JOIN roles r ON r.oid=d.datdba
    WHERE d.datname=current_database())
  AND NOT EXISTS(SELECT FROM pg_catalog.pg_namespace n WHERE n.nspname IN ('nb','nb_api','nb_media','nb_media_api','nb_v2','nb_v2_api','nb_v2_media','nb_v2_media_api','nb_thumbnails','nb_thumbnail_api') AND (
    pg_catalog.has_schema_privilege(current_user,n.oid,'CREATE') OR
    EXISTS(SELECT FROM roles r WHERE r.oid=n.nspowner))) AS create_denied,
  EXISTS(SELECT FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='nb' AND c.relkind IN ('r','p'))
  AND NOT EXISTS(SELECT FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname IN ('nb','nb_media','nb_v2','nb_v2_media','nb_thumbnails') AND c.relkind IN ('r','p','v','m','f') AND (
      pg_catalog.has_table_privilege(current_user,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR
      pg_catalog.has_any_column_privilege(current_user,c.oid,'SELECT,INSERT,UPDATE,REFERENCES')))
  AND NOT EXISTS(SELECT FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname IN ('nb','nb_media','nb_v2','nb_v2_media','nb_thumbnails') AND c.relkind='S' AND
      pg_catalog.has_sequence_privilege(current_user,c.oid,'USAGE,SELECT,UPDATE')) AS private_tables_denied,
  pg_catalog.has_schema_privilege(current_user,'nb_api','USAGE')
  AND (pg_catalog.to_regprocedure('nb_media_api.read_source(text)') IS NULL OR
    pg_catalog.has_schema_privilege(current_user,'nb_media_api','USAGE'))
  AND (pg_catalog.to_regprocedure('nb_v2_media_api.read_source(text)') IS NULL OR
    pg_catalog.has_schema_privilege(current_user,'nb_v2_media_api','USAGE'))
  AND (pg_catalog.to_regprocedure('nb_thumbnail_api.read_media(text,text,integer)') IS NULL OR
    pg_catalog.has_schema_privilege(current_user,'nb_thumbnail_api','USAGE'))
  AND (pg_catalog.to_regprocedure('nb_v2_api.read_media(text)') IS NULL OR
    pg_catalog.has_schema_privilege(current_user,'nb_v2_api','USAGE'))
  AND NOT EXISTS(SELECT FROM allowed WHERE NOT COALESCE(
    pg_catalog.has_function_privilege(current_user,pg_catalog.to_regprocedure(signature),'EXECUTE'),false)) AS read_allowed,
  NOT EXISTS(SELECT FROM writers WHERE pg_catalog.to_regprocedure(signature) IS NULL)
  AND NOT EXISTS(SELECT FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname IN ('nb','nb_api','nb_media','nb_media_api','nb_v2','nb_v2_api','nb_v2_media','nb_v2_media_api','nb_thumbnails','nb_thumbnail_api') AND
      NOT EXISTS(SELECT FROM allowed WHERE pg_catalog.to_regprocedure(signature)=p.oid) AND
      pg_catalog.has_function_privilege(current_user,p.oid,'EXECUTE')) AS write_denied
`;
const permissionKeys = ["safe_login", "reader_only", "create_denied", "private_tables_denied", "read_allowed", "write_denied"] as const;
type PermissionResult = Record<typeof permissionKeys[number], boolean>;
function misconfigured(): never { throw new ContentServiceError("MISCONFIGURED", "Reader configuration is invalid."); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
  return value as Record<string, unknown>;
}
function staticClaims(token: string, storageUrl: string, now: number): Record<string, unknown> {
  if (token.length > 32 * 1024 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) throw new Error();
  const [header, body] = token.split(".").slice(0, 2).map(part => object(JSON.parse(Buffer.from(part, "base64url").toString())));
  if (!["HS256", "RS256", "ES256", "EdDSA"].includes(header.alg as string) ||
      body.iss !== `${new URL(storageUrl).origin}/auth/v1` || body.role !== "authenticated" ||
      !(body.aud === "authenticated" || (Array.isArray(body.aud) && body.aud.includes("authenticated"))) ||
      typeof body.sub !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(body.sub) ||
      object(body.app_metadata).notionblog_storage_role !== "reader" ||
      typeof body.exp !== "number" || !Number.isFinite(body.exp) || body.exp <= now / 1000 + 60) throw new Error();
  return body;
}
async function verifyStaticUser(token: string, options: ReaderAuthOptions, fetcher: typeof fetch, now: () => number): Promise<void> {
  const claims = staticClaims(token, options.storageUrl, now());
  const controller = new AbortController();
  let rejectAbort: () => void;
  const aborted = new Promise<never>((_, reject) => { rejectAbort = () => reject(new Error()); });
  controller.signal.addEventListener("abort", rejectAbort!, { once: true });
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await Promise.race([fetcher(`${new URL(options.storageUrl).origin}/auth/v1/user`, {
      headers: { apikey: options.apiKey, Authorization: `Bearer ${token}` },
      cache: "no-store", redirect: "error", signal: controller.signal,
    }), aborted]);
    if (!response.ok || response.redirected || !response.body) {
      void response.body?.cancel().catch(() => {}); throw new Error();
    }
    const reader = response.body.getReader();
    try {
      const length = response.headers.get("Content-Length");
      if (length !== null && (!/^\d+$/.test(length) || Number(length) > 64 * 1024)) throw new Error();
      const chunks: Uint8Array[] = []; let size = 0;
      while (true) {
        const { value, done } = await Promise.race([reader.read(), aborted]);
        if (done) break;
        size += value.length; if (size > 64 * 1024) throw new Error(); chunks.push(value);
      }
      const user = object(JSON.parse(Buffer.concat(chunks).toString()));
      if (user.id !== claims.sub || user.role !== "authenticated" || user.is_anonymous === true ||
          object(user.app_metadata).notionblog_storage_role !== "reader") throw new Error();
      staticClaims(token, options.storageUrl, now());
    } catch { void reader.cancel().catch(() => {}); throw new Error(); }
    finally { reader.releaseLock(); }
  } finally { clearTimeout(timer); controller.signal.removeEventListener("abort", rejectAbort!); }
}

/** Uses supplied environment only; Node --env-file may be supplied by the operator. */
export async function checkReader(env: NodeJS.ProcessEnv, mode: Mode = "config-only", dependencies: ReaderCheckDependencies = {}): Promise<ReaderCheckReport> {
  const report: ReaderCheckReport = { mode, ok: false, checks: [], content: "not-checked", media: "pending" };
  let config: PoolConfig | undefined, auth: ReaderAuthOptions | undefined;
  let token: ReturnType<typeof createStorageReaderToken> | undefined;
  const now = dependencies.now ?? Date.now;
  try {
    config = databasePoolConfig(env.DATABASE_READER_URL, env.DATABASE_TLS, env.DATABASE_CA_CERT);
    if (!config.ssl || typeof config.ssl !== "object" || config.ssl.rejectUnauthorized !== true) misconfigured();
    report.checks.push({ name: "database_tls_configuration", status: "pass" });
  } catch { report.checks.push({ name: "database_tls_configuration", status: "fail" }); }
  try {
    auth = { storageUrl: env.STORAGE_URL ?? "", apiKey: env.STORAGE_API_KEY ?? "", email: env.STORAGE_READER_EMAIL,
      password: env.STORAGE_READER_PASSWORD, userId: env.STORAGE_READER_USER_ID, staticToken: env.STORAGE_READ_TOKEN,
      fetch: dependencies.fetch, now };
    token = createStorageReaderToken(auth);
    createSupabaseStorage({ url: auth.storageUrl, bucket: env.STORAGE_BUCKET ?? "", apiKey: auth.apiKey, token, role: "reader" });
    if (typeof token === "string") staticClaims(token, auth.storageUrl, now());
    report.checks.push({ name: "restricted_media_configuration", status: "pass" });
  } catch { report.checks.push({ name: "restricted_media_configuration", status: "fail" }); }
  if (report.checks.some(check => check.status === "fail")) return report;
  if (mode === "config-only") {
    report.checks.push({ name: "database_permissions", status: "pending" }, { name: "reader_auth_server_validation", status: "pending" });
    report.ok = true; return report;
  }
  let connection: ReturnType<NonNullable<ReaderCheckDependencies["openDatabase"]>> | undefined;
  try {
    const open = dependencies.openDatabase ?? (() => {
      const pool = createDatabasePool(env.DATABASE_READER_URL, env.DATABASE_TLS, env.DATABASE_CA_CERT);
      return { db: sqlExecutor(pool), close: () => pool.end() };
    });
    connection = open(config!);
    const { rows } = await connection.db.query<PermissionResult>(READER_PERMISSIONS_SQL);
    if (rows.length !== 1 || permissionKeys.some(key => rows[0][key] !== true)) throw new Error();
    report.checks.push({ name: "database_permissions", status: "pass" });
    try {
      await createDatabaseRepository(connection.db).getStatusYears!(); report.content = "ready";
    } catch (error) {
      if (!(error instanceof ContentServiceError) || error.code !== "CONTENT_UNAVAILABLE") throw error;
      report.content = "unavailable";
    }
  } catch { report.checks.push({ name: "database_permissions", status: "fail" }); }
  finally {
    if (connection) try { await connection.close(); } catch { report.checks.push({ name: "database_connection_closed", status: "fail" }); }
  }
  try {
    if (typeof token === "function") await token();
    else await verifyStaticUser(token!, auth!, dependencies.fetch ?? fetch, now);
    report.checks.push({ name: "reader_auth_server_validation", status: "pass" });
  } catch { report.checks.push({ name: "reader_auth_server_validation", status: "fail" }); }
  report.ok = report.checks.every(check => check.status !== "fail"); return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && !["--config-only", "--verify-access"].includes(args[0]))) {
    console.error("Usage: node [--env-file=PRIVATE_FILE] scripts/check-reader.ts [--config-only|--verify-access]");
    process.exitCode = 1;
  } else {
    try {
      const report = await checkReader(process.env, args[0] === "--verify-access" ? "verify-access" : "config-only");
      console.log(JSON.stringify(report, null, 2)); process.exitCode = report.ok ? 0 : 1;
    } catch { console.error("Reader check could not complete."); process.exitCode = 1; }
  }
}

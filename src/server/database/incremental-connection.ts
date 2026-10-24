import type { PoolConfig } from "pg";
import { Pool } from "pg";
import { databasePoolConfig } from "./connection.ts";
import type { SqlExecutor } from "./sql.ts";
import { createIncrementalPublisher, readPublicationState, type PublicationState } from "./incremental-publication.ts";
import { readPublishedRecord, verifyIncrementalReader, verifyPublishedDelta } from "./incremental-reader.ts";
import { publicationWriter } from "./publication.ts";

export interface IncrementalDatabaseOptions {
  readerUrl: string; writerUrl: string; configDigest: string; tls?: string; ca?: string;
}
export interface IncrementalDatabasePool extends SqlExecutor { close(): Promise<void> }
export interface IncrementalDatabaseDependencies {
  /** Explicit transport seam for tests; production always uses the verified pg pool config. */
  open?(config: PoolConfig): IncrementalDatabasePool;
}
export class IncrementalDatabaseError extends Error {
  readonly code: string;
  constructor(code: string) {super(code); this.name = "IncrementalDatabaseError"; this.code = code;}
}
function fail(code = "DATABASE_BINDING_UNAVAILABLE"): never {throw new IncrementalDatabaseError(code);}
const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const family = "(n.nspname='nb' OR n.nspname LIKE 'nb\\_%' ESCAPE '\\')";
const readerFunctions = ["nb_publication_api.check_capability(text)", "nb_delta_api.check_capability(text)", "nb_delta_api.read_state()",
  "nb_delta_api.check_reader(text)", "nb_delta_api.read_page(text,text,text)", "nb_delta_api.verify_operation(uuid,text,text)"];
const writerFunctions = ["nb_publication_api.check_capability(text)", "nb_delta_api.check_capability(text)", "nb_delta_api.read_state()",
  "nb_delta_api.apply_delta(uuid,text,text,text,jsonb,jsonb,jsonb)", "nb_delta_api.read_operation(uuid,text)"];

/** Inspect the actual LOGIN and its entire membership graph; group roles remain NOLOGIN. */
export const INCREMENTAL_LOGIN_SQL = `
WITH RECURSIVE me AS(SELECT * FROM pg_catalog.pg_roles WHERE rolname=current_user),
roles(oid) AS(SELECT oid FROM me UNION SELECT m.roleid FROM pg_catalog.pg_auth_members m JOIN roles r ON r.oid=m.member),
required(signature) AS(SELECT unnest($2::text[]))
SELECT current_user::text AS login,current_database()::text AS database,
 COALESCE((SELECT rolcanlogin AND current_user=session_user AND NOT
   (rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole OR rolreplication) FROM me),false) AS safe_login,
 EXISTS(SELECT FROM pg_catalog.pg_auth_members m JOIN me ON me.oid=m.member JOIN pg_catalog.pg_roles r ON r.oid=m.roleid WHERE r.rolname=$1)
 AND NOT EXISTS(SELECT FROM roles JOIN pg_catalog.pg_roles r USING(oid) WHERE r.rolname<>current_user AND
   (r.rolname<>$1 OR r.rolcanlogin OR r.rolsuper OR r.rolbypassrls OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication))
 AND NOT EXISTS(SELECT FROM pg_catalog.pg_auth_members m JOIN roles r ON r.oid=m.member WHERE m.admin_option) AS isolated_role,
 NOT pg_catalog.has_database_privilege(current_user,current_database(),'CREATE')
 AND NOT EXISTS(SELECT FROM pg_catalog.pg_database d JOIN roles r ON r.oid=d.datdba WHERE d.datname=current_database())
 AND NOT EXISTS(SELECT FROM pg_catalog.pg_namespace n WHERE ${family} AND
   (pg_catalog.has_schema_privilege(current_user,n.oid,'CREATE') OR EXISTS(SELECT FROM roles r WHERE r.oid=n.nspowner)))
 AND NOT EXISTS(SELECT FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace JOIN roles r ON r.oid=p.proowner WHERE ${family}) AS create_denied,
 NOT EXISTS(SELECT FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE ${family} AND c.relkind IN ('r','p','v','m','f') AND
   (pg_catalog.has_table_privilege(current_user,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR
    pg_catalog.has_any_column_privilege(current_user,c.oid,'SELECT,INSERT,UPDATE,REFERENCES')))
 AND NOT EXISTS(SELECT FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE ${family} AND c.relkind='S' AND
   pg_catalog.has_sequence_privilege(current_user,c.oid,'USAGE,SELECT,UPDATE')) AS private_data_denied,
 NOT EXISTS(SELECT FROM required WHERE pg_catalog.to_regprocedure(signature) IS NULL OR
   NOT COALESCE(pg_catalog.has_function_privilege(current_user,pg_catalog.to_regprocedure(signature),'EXECUTE'),false)) AS required_functions,
 NOT EXISTS(SELECT FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE ${family} AND
   pg_catalog.has_schema_privilege(current_user,n.oid,'USAGE') AND pg_catalog.has_function_privilege(current_user,p.oid,'EXECUTE') AND
   (p.proname IN ('configure_policy','set_denied') OR NOT EXISTS(SELECT FROM
     pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a JOIN pg_catalog.pg_roles g ON g.oid=a.grantee
       WHERE g.rolname=$1 AND a.privilege_type='EXECUTE'))) AS group_functions_only`;
const profileKeys = ["safe_login", "isolated_role", "create_denied", "private_data_denied", "required_functions", "group_functions_only"] as const;
interface Profile extends Record<typeof profileKeys[number], boolean> {login: string; database: string}

function endpoint(input: string) {
  const url = new URL(input), database = decodeURIComponent(url.pathname.slice(1)), username = decodeURIComponent(url.username);
  if (!database || database.includes("/") || !username || url.username === "" || /[\u0000-\u001f\u007f]/.test(database + username)) fail("DATABASE_BINDING_CONFIG_INVALID");
  return {key: JSON.stringify([url.hostname, url.port || "5432", database]), database, username};
}
function openPool(config: PoolConfig): IncrementalDatabasePool {
  const pool = new Pool(config); pool.on("error", () => {});
  return {query: async <T>(sql: string, values?: unknown[]) => ({rows: (await pool.query(sql, values)).rows as T[]}), close: () => pool.end()};
}
async function inspect(db: SqlExecutor, role: "nb_delta_reader" | "nb_writer", expected: ReturnType<typeof endpoint>, full = false): Promise<string> {
  const required = role === "nb_delta_reader" ? readerFunctions : writerFunctions;
  const extra = !full ? [] : role === "nb_delta_reader" ? ["nb_publication_api.read_snapshot(text[],boolean)"] : [
    "nb_study_api.check_capability(text)", "nb_v2_api.begin_run(uuid,text,text,text,integer)",
    "nb_v2_api.renew_run(uuid,bigint,integer)", "nb_v2_api.stage_batch(uuid,bigint,jsonb,jsonb,jsonb)",
    "nb_v2_api.fail_run(uuid,bigint)", "nb_publication_api.promote_run(uuid,bigint,integer,integer,boolean,integer)",
  ];
  const rows = (await db.query<Profile>(INCREMENTAL_LOGIN_SQL, [role, [...required, ...extra]])).rows;
  const p = rows[0];
  if (rows.length !== 1 || !p || Object.keys(p).length !== profileKeys.length + 2 || profileKeys.some(k => p[k] !== true) ||
      typeof p.login !== "string" || p.database !== expected.database) fail("DATABASE_BINDING_ROLE_INVALID");
  const suffix = expected.username.startsWith(p.login) ? expected.username.slice(p.login.length) : null;
  if (suffix === null || suffix !== "" && !/^\.[a-z0-9_-]{1,128}$/.test(suffix)) fail("DATABASE_BINDING_CONFIG_INVALID");
  return suffix;
}
function sameState(a: PublicationState, b: PublicationState) {
  return a.publicationRevision === b.publicationRevision && a.configDigest === b.configDigest && a.schemaDigest === b.schemaDigest && a.policyEpoch === b.policyEpoch;
}

/** PRIVATE worker binding. No env defaults, policy changes, activation, retries or scheduling. */
async function openRestrictedDatabase(options: IncrementalDatabaseOptions, dependencies: IncrementalDatabaseDependencies, signal: AbortSignal | undefined, full: boolean) {
  let reader: IncrementalDatabasePool | undefined, writer: IncrementalDatabasePool | undefined, closed = false, closing: Promise<void> | undefined;
  const guard = (s?: AbortSignal) => {if (closed) fail("DATABASE_BINDING_CLOSED"); if (s?.aborted) fail("DATABASE_BINDING_CANCELLED");};
  async function close() {
    if (closing) return closing;
    closed = true;
    closing = (async () => {
      const results = await Promise.allSettled([Promise.resolve().then(() => reader?.close()), Promise.resolve().then(() => writer?.close())]);
      if (results.some(r => r.status === "rejected")) fail();
    })();
    return closing;
  }
  try {
    guard(signal);
    let readerConfig: PoolConfig, writerConfig: PoolConfig, readerEndpoint: ReturnType<typeof endpoint>, writerEndpoint: ReturnType<typeof endpoint>;
    try {
      if (!options || !hash(options.configDigest)) fail("DATABASE_BINDING_CONFIG_INVALID");
      readerConfig = databasePoolConfig(options.readerUrl, options.tls, options.ca); writerConfig = databasePoolConfig(options.writerUrl, options.tls, options.ca);
      readerEndpoint = endpoint(options.readerUrl); writerEndpoint = endpoint(options.writerUrl);
      if (readerEndpoint.key !== writerEndpoint.key || readerEndpoint.username === writerEndpoint.username) fail("DATABASE_BINDING_CONFIG_INVALID");
    } catch {fail("DATABASE_BINDING_CONFIG_INVALID");}
    const open = dependencies.open ?? openPool;
    reader = open(readerConfig); writer = open(writerConfig);
    const readerTenant = await inspect(reader, "nb_delta_reader", readerEndpoint, full); guard(signal);
    const writerTenant = await inspect(writer, "nb_writer", writerEndpoint, full); guard(signal);
    if (readerTenant !== writerTenant) fail("DATABASE_BINDING_CONFIG_INVALID");
    await verifyIncrementalReader(reader, signal);
    if (!full) {
      const readerState = await readPublicationState(reader), publisher = createIncrementalPublisher(writer);
      const writerState = await publisher.state(); guard(signal);
      if (readerState.configDigest !== options.configDigest || writerState.configDigest !== options.configDigest) fail("DATABASE_BINDING_SCOPE_MISMATCH");
      if (!sameState(readerState, writerState)) fail("DATABASE_BINDING_VERSION_CHANGED");
    }
    const guarded = (db: IncrementalDatabasePool): SqlExecutor => ({query: <T>(sql: string, values?: unknown[]) => {guard(); return db.query<T>(sql, values);}});
    const guardedReader = guarded(reader), guardedWriter = guarded(writer);
    const guardedPublisher = createIncrementalPublisher(guardedWriter);
    return {
      reader: guardedReader, writer: guardedWriter, publisher: guardedPublisher,
      fullPublisher: (() => {
        const base = publicationWriter(guardedWriter, "published");
        return { ...base, begin: async (id: string, digest: string, seconds?: number) => {
          guard(signal); if (digest !== options.configDigest) fail("DATABASE_BINDING_SCOPE_MISMATCH");
          return base.begin(id, digest, seconds);
        } };
      })(),
      readPage: (input: Parameters<typeof readPublishedRecord>[1], s?: AbortSignal) => {guard(s); return readPublishedRecord(guardedReader, input, s);},
      verify: (receipt: Parameters<typeof verifyPublishedDelta>[1], s?: AbortSignal) => {guard(s); return verifyPublishedDelta(guardedReader, receipt, s);},
      close,
    };
  } catch (error) {
    await close().catch(() => {});
    if (error instanceof IncrementalDatabaseError) throw error;
    fail();
  }
}

/** Normal delta startup still requires matching accepted publication state. */
export function openIncrementalDatabase(options: IncrementalDatabaseOptions, dependencies: IncrementalDatabaseDependencies = {}, signal?: AbortSignal) {
  return openRestrictedDatabase(options, dependencies, signal, false);
}

/** Explicit first-full-publication binding: identical LOGIN/TLS/tenant checks,
 * installed capabilities and full-only grants, but no active pointer required.
 * The fixed full begin API validates the pinned configured scope before any
 * Source call. This never installs roles, changes policy or activates a mode. */
export function openFullBaselineDatabase(options: IncrementalDatabaseOptions, dependencies: IncrementalDatabaseDependencies = {}, signal?: AbortSignal) {
  return openRestrictedDatabase(options, dependencies, signal, true);
}

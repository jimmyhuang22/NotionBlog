import { lstat, realpath, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import type { SqlExecutor } from "../../src/server/database/sql.ts";
import { withOwnerTransport, withOwnedUnixOwnerTransport, type OwnerDatabaseConfig } from "../website-sync/owner-install-transport.ts";
import { COMPACT_WITHDRAWAL_CATALOG_SQL, readCompactWithdrawalCatalog, compactWithdrawalCatalogState } from "./compact-withdrawal-capability.ts";
import { COMPACT_WITHDRAWAL_PROTOCOL_SHA256, loadCompactWithdrawalProtocol, loadCompactWithdrawalRecipe } from "./compact-withdrawal-protocol.ts";

type Kind = "verified-pg-client" | "pglite-test" | "owned-unix-pg-test";
export interface CompactWithdrawalInstallSession { readonly purpose: "compact-withdrawal-v1"; readonly kind: Kind }
export interface CompactWithdrawalInstallReceipt {
  version: 1; purpose: "compact-withdrawal-v1"; outcome: "installed" | "verified-existing";
  manifestSha256: string; migrationSha256: string; recipeSha256: string;
}
interface Live { active: boolean; failed: boolean; busy: boolean; db: SqlExecutor; script(sql: string): Promise<void>; assertTransaction(): Promise<void> }
const sessions = new WeakMap<object, Live>();
const fail = (code: string): never => { throw Error(code); };
const offline = () => {
  if (process.env.NOTIONBLOG_DEVELOPMENT_MODE !== "offline" || !Reflect.get(globalThis, Symbol.for("notionblog.offline-network-guard"))) fail("OWNER_INSTALL_OFFLINE_REQUIRED");
};
const BASE_SQL = `SELECT current_user=session_user AND
 (SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user)=(SELECT relowner FROM pg_catalog.pg_class WHERE oid='nb_cache.state'::pg_catalog.regclass) AS owner,
 (SELECT pg_catalog.count(*)=1 FROM nb_cache.state WHERE singleton AND version=1) AS valid,
 (SELECT nspowner FROM pg_catalog.pg_namespace WHERE nspname='nb_cache_api')=
 (SELECT relowner FROM pg_catalog.pg_class WHERE oid='nb_cache.state'::pg_catalog.regclass) AS "schemaOwned",
 EXISTS(SELECT FROM pg_catalog.pg_roles r WHERE r.rolname='nb_cache_operator' AND
   NOT (r.rolsuper OR r.rolbypassrls OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolinherit) AND
   NOT EXISTS(SELECT FROM pg_catalog.pg_auth_members WHERE member=r.oid) AND
   pg_catalog.has_schema_privilege(r.oid,'nb_cache_api','USAGE')) AS operator`;
const LOCK_SQL = "SELECT singleton FROM nb_cache.state WHERE singleton FOR UPDATE NOWAIT";
function checked(session: CompactWithdrawalInstallSession) {
  const live = session && typeof session === "object" ? sessions.get(session) : undefined;
  if (!live?.active || live.failed) fail("COMPACT_WITHDRAWAL_SESSION_REQUIRED");
  return live!;
}
async function registered<T>(kind: Kind, db: SqlExecutor, script: (sql: string) => Promise<void>, body: string, work: (session: CompactWithdrawalInstallSession) => Promise<T>) {
  const identity = (await db.query<{ pid: number; xid: string }>("SELECT pg_backend_pid() AS pid, pg_current_xact_id()::text AS xid")).rows[0];
  if (!identity || typeof identity.pid !== "number" || typeof identity.xid !== "string") fail("OWNER_INSTALL_TRANSACTION_IDENTITY");
  const assertTransaction = async () => {
    const rows = (await db.query<{ pid: number; xid: string | null }>("SELECT pg_backend_pid() AS pid, pg_current_xact_id_if_assigned()::text AS xid")).rows;
    if (rows.length !== 1 || rows[0].pid !== identity.pid || rows[0].xid !== identity.xid) fail("OWNER_INSTALL_TRANSACTION_ENDED");
  };
  const session = Object.freeze({ purpose: "compact-withdrawal-v1" as const, kind });
  const live: Live = { active: true, failed: false, busy: false, assertTransaction,
    db: { query: async <R>(sql: string, values?: unknown[]) => {
      try {
        checked(session);
        if (![BASE_SQL, LOCK_SQL, COMPACT_WITHDRAWAL_CATALOG_SQL].includes(sql)) fail("COMPACT_WITHDRAWAL_QUERY_DENIED");
        await assertTransaction(); checked(session); return await db.query<R>(sql, values);
      } catch (error) { live.failed = true; throw error; }
    } },
    script: async sql => {
      try {
        checked(session);
        if (sql !== body) fail("COMPACT_WITHDRAWAL_SCRIPT_DENIED");
        await assertTransaction(); checked(session); await script(sql);
      } catch (error) { live.failed = true; throw error; }
    } };
  sessions.set(session, live);
  try {
    const result = await work(session);
    if (live.failed || live.busy) fail("OWNER_INSTALL_TRANSACTION_FAILED");
    await assertTransaction(); return result;
  } finally { live.active = false; }
}

/** The sole installation operation. No public bridge can issue arbitrary DDL or transaction control. */
export async function installCompactWithdrawal(session: CompactWithdrawalInstallSession): Promise<CompactWithdrawalInstallReceipt> {
  const live = checked(session);
  if (live.busy) { live.failed = true; fail("COMPACT_WITHDRAWAL_SESSION_BUSY"); }
  live.busy = true;
  try {
    const recipe = await loadCompactWithdrawalRecipe(), protocol = await loadCompactWithdrawalProtocol();
    const base = (await live.db.query<{ owner: boolean; valid: boolean; schemaOwned: boolean; operator: boolean }>(BASE_SQL)).rows;
    if (base.length !== 1 || [base[0].owner, base[0].valid, base[0].schemaOwned, base[0].operator].some(value => value !== true)) fail("COMPACT_WITHDRAWAL_BASE_REQUIRED");
    if ((await live.db.query(LOCK_SQL)).rows.length !== 1) fail("COMPACT_WITHDRAWAL_BASE_REQUIRED");
    const state = compactWithdrawalCatalogState(await readCompactWithdrawalCatalog(live.db, protocol), protocol);
    if (state === "mismatch") fail("COMPACT_WITHDRAWAL_INSTALL_CONFLICT");
    if (state === "absent") await live.script(recipe.body);
    if (compactWithdrawalCatalogState(await readCompactWithdrawalCatalog(live.db, protocol), protocol) !== "installed") fail("COMPACT_WITHDRAWAL_INSTALL_VERIFY");
    return { version: 1, purpose: "compact-withdrawal-v1", outcome: state === "absent" ? "installed" : "verified-existing",
      manifestSha256: COMPACT_WITHDRAWAL_PROTOCOL_SHA256, migrationSha256: recipe.migrationSha256, recipeSha256: recipe.recipeSha256 };
  } catch (error) { live.failed = true; throw error; }
  finally { live.busy = false; }
}

/** Production always owns a new strict-TLS Client. N08 sessions are never admitted here. */
export async function withCompactWithdrawalInstallTransaction<T>(input: OwnerDatabaseConfig, work: (session: CompactWithdrawalInstallSession) => Promise<T>): Promise<T> {
  let body = "";
  return withOwnerTransport(input, (db, script) => registered("verified-pg-client", db, script, body, work), async () => { body = (await loadCompactWithdrawalRecipe()).body; });
}
/** Explicit offline adapter over an actual PGlite transaction, never a production connection proof. */
export async function withPGliteCompactWithdrawalInstallTransaction<T>(db: PGlite, work: (session: CompactWithdrawalInstallSession) => Promise<T>): Promise<T> {
  offline();
  const { PGlite: ActualPGlite } = await import("@electric-sql/pglite");
  if (!(db instanceof ActualPGlite)) fail("OWNER_INSTALL_TEST_DATABASE");
  const recipe = await loadCompactWithdrawalRecipe();
  let first: unknown, hasFirst = false;
  try { return await db.transaction(async tx => {
    await tx.exec("SET LOCAL statement_timeout='15s'; SET LOCAL lock_timeout='3s'; SET LOCAL search_path=pg_catalog");
    try { return await registered("pglite-test", tx, async sql => { await tx.exec(sql); }, recipe.body, work); }
    catch (error) { first = error; hasFirst = true; throw error; }
  }); } catch (error) { throw hasFirst ? first : error; }
}
export interface CompactWithdrawalOwnedUnixTestConfig {
  kind: "compact-withdrawal-owned-unix-v1"; ownerRoot: string; host: string; port: 55432;
  user: "b08_fixture_owner"; password: "placeholder"; database: "b08_fixture";
}
/** Separate native-fixture gate. It accepts no project URL or ambient PG configuration. */
export async function withOwnedUnixCompactWithdrawalTestTransaction<T>(input: CompactWithdrawalOwnedUnixTestConfig, work: (session: CompactWithdrawalInstallSession) => Promise<T>): Promise<T> {
  offline();
  try {
    if (Object.keys(input).sort().join(",") !== "database,host,kind,ownerRoot,password,port,user" || input.kind !== "compact-withdrawal-owned-unix-v1" ||
        input.port !== 55432 || input.user !== "b08_fixture_owner" || input.password !== "placeholder" || input.database !== "b08_fixture") fail("OWNER_INSTALL_NATIVE_CONFIG");
    const root = await realpath(input.ownerRoot), host = await realpath(input.host);
    if (dirname(root) !== "/private/tmp" || !root.startsWith("/private/tmp/nb-b08-") || root !== input.ownerRoot ||
        input.host !== join(root, "socket") || host !== input.host) fail("OWNER_INSTALL_NATIVE_CONFIG");
    for (const path of [root, host]) { const info = await stat(path); if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o077)) fail("OWNER_INSTALL_NATIVE_CONFIG"); }
    const socketPath = join(host, ".s.PGSQL.55432"), socket = await lstat(socketPath);
    if (socket.isSymbolicLink() || !socket.isSocket() || socket.uid !== process.getuid?.() || await realpath(socketPath) !== socketPath) fail("OWNER_INSTALL_NATIVE_CONFIG");
  } catch { return fail("OWNER_INSTALL_NATIVE_CONFIG"); }
  const recipe = await loadCompactWithdrawalRecipe();
  return withOwnedUnixOwnerTransport(input, (db, script) => registered("owned-unix-pg-test", db, script, recipe.body, work));
}

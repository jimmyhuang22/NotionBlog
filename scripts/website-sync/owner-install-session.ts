import { withOwnerTransport, withOwnedUnixOwnerTransport, type OwnerDatabaseConfig } from "./owner-install-transport.ts";
export { OwnerInstallFailure, type OwnerInstallOutcome, type OwnerDatabaseConfig } from "./owner-install-transport.ts";
import { realpath, stat } from "node:fs/promises";
import { join, dirname } from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { loadOwnerInstallRecipe } from "./owner-install-recipes.ts";
import type { SqlExecutor } from "../../src/server/database/sql.ts";

export type OwnerSessionKind = "verified-pg-client" | "pglite-test" | "owned-unix-pg-test";
/** Runtime admission is a private registry, never this descriptive field. */
export interface OwnerInstallSession { readonly kind: OwnerSessionKind }
interface LiveSession { active: boolean; failed: boolean; busy: boolean; db: SqlExecutor; script(sql: string): Promise<void> }
const sessions = new WeakMap<object, LiveSession>();
const fail = (code: string): never => { throw Error(code); };
const offline = () => { if (process.env.NOTIONBLOG_DEVELOPMENT_MODE !== "offline" || !Reflect.get(globalThis, Symbol.for("notionblog.offline-network-guard"))) fail("OWNER_INSTALL_OFFLINE_REQUIRED"); };
const digestUpdates = new Set([
  "UPDATE nb_delta.state SET reader_isolation_digest=$1 WHERE singleton RETURNING singleton",
  "UPDATE nb_delta.state SET withdrawal_recovery_digest=$1 WHERE singleton RETURNING singleton",
]);
const createRole = "CREATE ROLE nb_delta_reader NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS";
async function register(kind: OwnerSessionKind, db: SqlExecutor, script: LiveSession["script"]) {
  const recipes = await Promise.all([loadOwnerInstallRecipe("reader-isolation"), loadOwnerInstallRecipe("withdrawal-recovery")]);
  const identity = (await db.query<{ pid: number; xid: string }>("SELECT pg_backend_pid() AS pid, pg_current_xact_id()::text AS xid")).rows[0];
  if (!identity || typeof identity.pid !== "number" || typeof identity.xid !== "string") fail("OWNER_INSTALL_TRANSACTION_IDENTITY");
  const assertTransaction = async () => {
    const rows = (await db.query<{ pid: number; xid: string | null }>("SELECT pg_backend_pid() AS pid, pg_current_xact_id_if_assigned()::text AS xid")).rows;
    if (rows.length !== 1 || rows[0].pid !== identity.pid || rows[0].xid !== identity.xid) fail("OWNER_INSTALL_TRANSACTION_ENDED");
  };
  const session = Object.freeze({ kind });
  const live: LiveSession = { active: true, failed: false, busy: false,
    db: { query: async <R>(sql: string, values?: unknown[]) => {
      try {
        checked(session);
        if (sql.includes(";") || !/^\s*(SELECT|WITH)\s/i.test(sql) && !digestUpdates.has(sql) && sql !== createRole) fail("OWNER_INSTALL_QUERY_DENIED");
        await assertTransaction(); checked(session); return await db.query<R>(sql, values);
      } catch (error) { live.failed = true; throw error; }
    } },
    script: async sql => {
      try {
        checked(session);
        if (!recipes.some(recipe => recipe.body === sql)) fail("OWNER_INSTALL_SCRIPT_DENIED");
        await assertTransaction(); checked(session); await script(sql);
      } catch (error) { live.failed = true; throw error; }
    } };
  sessions.set(session, live); return { session, live, assertTransaction };
}
function checked(session: OwnerInstallSession): LiveSession {
  const live = session && typeof session === "object" ? sessions.get(session) : undefined;
  if (!live?.active || live.failed) fail("OWNER_INSTALL_SESSION_REQUIRED");
  return live!;
}
/** Only installers use this bridge; caught failures still poison the transaction. */
export async function inOwnerInstallSession<T>(session: OwnerInstallSession, work: (db: SqlExecutor, script: LiveSession["script"]) => Promise<T>): Promise<T> {
  const live = checked(session);
  if (live.busy) { live.failed = true; fail("OWNER_INSTALL_SESSION_BUSY"); }
  live.busy = true;
  try { return await work(live.db, live.script); }
  catch (error) { live.failed = true; throw error; }
  finally { live.busy = false; }
}
async function registeredClientWork<T>(kind: "verified-pg-client" | "owned-unix-pg-test", work: (session: OwnerInstallSession) => Promise<T>, db: SqlExecutor, script: LiveSession["script"]): Promise<T> {
  const registration = await register(kind, db, script);
  try {
    const result = await work(registration.session);
    if (registration.live.failed || registration.live.busy) fail("OWNER_INSTALL_TRANSACTION_FAILED");
    await registration.assertTransaction();
    return result;
  } finally { registration.live.active = false; }
}
/** Sole production entry: one internally owned actual Client, strict CA/TLS, no retry. */
export async function withOwnerInstallTransaction<T>(input: OwnerDatabaseConfig, work: (session: OwnerInstallSession) => Promise<T>): Promise<T> {
  return withOwnerTransport(input, (db, script) => registeredClientWork("verified-pg-client", work, db, script),
    () => Promise.all([loadOwnerInstallRecipe("reader-isolation"), loadOwnerInstallRecipe("withdrawal-recovery")]));
}
/** Actual isolated PGlite transaction, explicitly never a production Client. */
export async function withPGliteOwnerTransaction<T>(db: PGlite, work: (session: OwnerInstallSession) => Promise<T>): Promise<T> {
  offline();
  const { PGlite: ActualPGlite } = await import("@electric-sql/pglite");
  if (!(db instanceof ActualPGlite)) fail("OWNER_INSTALL_TEST_DATABASE");
  await Promise.all([loadOwnerInstallRecipe("reader-isolation"), loadOwnerInstallRecipe("withdrawal-recovery")]);
  let first: unknown, hasFirst = false;
  try { return await db.transaction(async tx => {
    await tx.exec("SET LOCAL statement_timeout='15s'; SET LOCAL lock_timeout='3s'");
    const registration = await register("pglite-test", tx, async sql => { await tx.exec(sql); });
    try {
      const result = await work(registration.session);
      if (registration.live.failed || registration.live.busy) fail("OWNER_INSTALL_TRANSACTION_FAILED");
      await registration.assertTransaction();
      return result;
    } catch (error) { first = error; hasFirst = true; throw error; }
    finally { registration.live.active = false; }
  }); } catch (error) { throw hasFirst ? first : error; }
}
export interface OwnedUnixTestConfig { kind: "n08-owned-unix-v1"; host: string; port: number; user: "n08_fixture_owner"; password: "placeholder"; databases: ["n08_fixture_a", "n08_fixture_b"]; ownerRoot: string }
/** Native proof only. The existing engine lacks TLS; this cannot select a project DB. */
export async function withOwnedUnixOwnerTestTransaction<T>(input: OwnedUnixTestConfig, database: "n08_fixture_a" | "n08_fixture_b", work: (session: OwnerInstallSession) => Promise<T>): Promise<T> {
  offline();
  try {
    if (input.kind !== "n08-owned-unix-v1" || input.user !== "n08_fixture_owner" || input.password !== "placeholder" || input.port !== 55432 || JSON.stringify(input.databases) !== '["n08_fixture_a","n08_fixture_b"]' || !input.databases.includes(database)) fail("OWNER_INSTALL_NATIVE_CONFIG");
    const root = await realpath(input.ownerRoot), host = await realpath(input.host);
    if (dirname(root) !== "/private/tmp" || !root.startsWith("/private/tmp/nb-n08-") || input.ownerRoot !== root || host !== join(root, "socket")) fail("OWNER_INSTALL_NATIVE_CONFIG");
    for (const path of [root, host]) { const info = await stat(path); if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o077)) fail("OWNER_INSTALL_NATIVE_CONFIG"); }
    const socket = await stat(join(host, `.s.PGSQL.${input.port}`));
    if (!socket.isSocket() || socket.uid !== process.getuid?.()) fail("OWNER_INSTALL_NATIVE_CONFIG");
  } catch { return fail("OWNER_INSTALL_NATIVE_CONFIG"); }
  await Promise.all([loadOwnerInstallRecipe("reader-isolation"), loadOwnerInstallRecipe("withdrawal-recovery")]);
  return withOwnedUnixOwnerTransport({ host: input.host, port: input.port, user: input.user, password: input.password, database },
    (db, script) => registeredClientWork("owned-unix-pg-test", work, db, script));
}

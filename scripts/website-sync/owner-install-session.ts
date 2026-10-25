import { Client, type ClientConfig } from "pg";
import { createSecureContext, checkServerIdentity, type TLSSocket } from "node:tls";
import { isIP } from "node:net";
import { X509Certificate } from "node:crypto";
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
export type OwnerInstallOutcome = "not-committed" | "commit-unknown" | "committed-cleanup-failed";
export class OwnerInstallFailure extends Error {
  readonly code: string;
  readonly outcome: OwnerInstallOutcome;
  constructor(outcome: OwnerInstallOutcome, cause: unknown) {
    const code = outcome === "commit-unknown" ? "OWNER_INSTALL_COMMIT_UNKNOWN" : outcome === "committed-cleanup-failed" ? "OWNER_INSTALL_COMMITTED_CLOSE_FAILED" : "OWNER_INSTALL_FAILED";
    super(code, { cause }); this.name = "OwnerInstallFailure"; this.code = code; this.outcome = outcome;
  }
}
export interface OwnerDatabaseConfig { url: string; ca: string }
function productionConfig(input: OwnerDatabaseConfig): { config: ClientConfig; hostname: string } {
  try {
    if (!input || Object.keys(input).sort().join(",") !== "ca,url" || typeof input.url !== "string" || typeof input.ca !== "string") fail("OWNER_INSTALL_CONFIG");
    const url = new URL(input.url), user = decodeURIComponent(url.username), password = decodeURIComponent(url.password), database = decodeURIComponent(url.pathname.slice(1));
    if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname || !user || !password || !database || database.includes("/") || url.search || url.hash || /[\u0000-\u001f\u007f]/.test(user + database + url.hostname) || !input.ca.includes("BEGIN CERTIFICATE")) fail("OWNER_INSTALL_CONFIG");
    const certificates = input.ca.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
    if (!certificates?.length || certificates.join("").replace(/\s/g, "") !== input.ca.replace(/\s/g, "") || certificates.some(pem => !new X509Certificate(pem).ca)) fail("OWNER_INSTALL_CONFIG");
    createSecureContext({ ca: input.ca });
    return { hostname: url.hostname, config: { host: url.hostname, port: Number(url.port || 5432), user, password, database, options: "",
      ssl: { ca: input.ca, rejectUnauthorized: true, ...(!isIP(url.hostname) ? { servername: url.hostname } : {}) } } };
  } catch { return fail("OWNER_INSTALL_CONFIG"); }
}
async function closeOwnedClient(client: Client): Promise<void> {
  let first: unknown, hasFirst = false;
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { client.connection.stream.destroy(); reject(Error("OWNER_INSTALL_CLOSE")); }, 5000);
      Promise.resolve().then(() => client.end()).then(resolve, reject).finally(() => clearTimeout(timer));
    });
  } catch (error) { first = error; hasFirst = true; }
  // An immediate end() rejection must not strand this factory's socket.
  try {
    const stream = client.connection.stream;
    if (!stream.closed) await new Promise<void>((resolve, reject) => {
      const done = () => { clearTimeout(timer); resolve(); };
      const timer = setTimeout(() => { stream.removeListener("close", done); reject(Error("OWNER_INSTALL_CLOSE")); }, 5000);
      stream.once("close", done); stream.destroy();
      if (stream.closed) { stream.removeListener("close", done); done(); }
    });
  } catch (error) { if (!hasFirst) { first = error; hasFirst = true; } }
  if (hasFirst) throw first;
}
async function clientTransaction<T>(config: ClientConfig, kind: "verified-pg-client" | "owned-unix-pg-test", hostname: string | undefined, work: (session: OwnerInstallSession) => Promise<T>): Promise<T> {
  const client = new Client({ ...config, connectionTimeoutMillis: 5000, statement_timeout: 15000, query_timeout: 20000, application_name: "notionblog-owner-install" });
  let first: unknown, hasFirst = false, result!: T, started = false, commitAttempted = false, committed = false, registration: Awaited<ReturnType<typeof register>> | undefined;
  const remember = (error: unknown) => { if (!hasFirst) { first = error; hasFirst = true; } };
  client.on("error", remember);
  try {
    await client.connect();
    if (hostname) {
      const stream = client.connection.stream as TLSSocket;
      if (!stream.encrypted || !stream.authorized || checkServerIdentity(hostname, stream.getPeerCertificate())) fail("OWNER_INSTALL_TLS");
    }
    const begin = await client.query("BEGIN");
    if (Array.isArray(begin) || begin.command !== "BEGIN") fail("OWNER_INSTALL_BEGIN_ACK");
    started = true;
    await client.query("SET LOCAL statement_timeout='15s'; SET LOCAL lock_timeout='3s'");
    const db: SqlExecutor = { query: async <R>(text: string, values?: unknown[]) => {
      const response = await client.query(text, values);
      if (Array.isArray(response)) fail("OWNER_INSTALL_QUERY_SHAPE");
      return { rows: response.rows as R[] };
    } };
    registration = await register(kind, db, async sql => { await client.query(sql); });
    result = await work(registration.session);
    if (registration.live.failed || registration.live.busy) fail("OWNER_INSTALL_TRANSACTION_FAILED");
    await registration.assertTransaction();
    if (hasFirst) throw first;
    registration.live.active = false;
    commitAttempted = true;
    const ack = await client.query("COMMIT");
    if (Array.isArray(ack) || ack.command !== "COMMIT") fail("OWNER_INSTALL_COMMIT_UNKNOWN");
    committed = true;
  } catch (error) { remember(error); }
  finally {
    if (registration) registration.live.active = false;
    if (started && !committed) { try { await client.query("ROLLBACK"); } catch (error) { if (!hasFirst) { first = error; hasFirst = true; } } }
    try { await closeOwnedClient(client); } catch (error) { remember(error); }
  }
  if (hasFirst) throw new OwnerInstallFailure(committed ? "committed-cleanup-failed" : commitAttempted ? "commit-unknown" : "not-committed", first);
  return result;
}
/** Sole production entry: one internally owned actual Client, strict CA/TLS, no retry. */
export async function withOwnerInstallTransaction<T>(input: OwnerDatabaseConfig, work: (session: OwnerInstallSession) => Promise<T>): Promise<T> {
  const { config, hostname } = productionConfig(input);
  await Promise.all([loadOwnerInstallRecipe("reader-isolation"), loadOwnerInstallRecipe("withdrawal-recovery")]);
  return clientTransaction(config, "verified-pg-client", hostname, work);
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
  return clientTransaction({ host: input.host, port: input.port, user: input.user, password: input.password, database, ssl: false, options: "" }, "owned-unix-pg-test", undefined, work);
}

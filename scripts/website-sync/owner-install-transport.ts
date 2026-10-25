/** Internal transport shared only by purpose-bound owner-install factories. */
import { Client, type ClientConfig } from "pg";
import { createSecureContext, checkServerIdentity, type TLSSocket } from "node:tls";
import { isIP } from "node:net";
import { X509Certificate } from "node:crypto";
import type { SqlExecutor } from "../../src/server/database/sql.ts";

const fail = (code: string): never => { throw Error(code); };
type OwnerTransportWork<T> = (db: SqlExecutor, script: (sql: string) => Promise<void>) => Promise<T>;
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
async function clientTransaction<T>(config: ClientConfig, hostname: string | undefined, work: OwnerTransportWork<T>): Promise<T> {
  const client = new Client({ ...config, connectionTimeoutMillis: 5000, statement_timeout: 15000, query_timeout: 20000, application_name: "notionblog-owner-install" });
  let first: unknown, hasFirst = false, result!: T, started = false, commitAttempted = false, committed = false;
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
    await client.query("SET LOCAL statement_timeout='15s'; SET LOCAL lock_timeout='3s'; SET LOCAL search_path=pg_catalog");
    const db: SqlExecutor = { query: async <R>(text: string, values?: unknown[]) => {
      const response = await client.query(text, values);
      if (Array.isArray(response)) fail("OWNER_INSTALL_QUERY_SHAPE");
      return { rows: response.rows as R[] };
    } };
    result = await work(db, async sql => { await client.query(sql); });
    if (hasFirst) throw first;
    commitAttempted = true;
    const ack = await client.query("COMMIT");
    if (Array.isArray(ack) || ack.command !== "COMMIT") fail("OWNER_INSTALL_COMMIT_UNKNOWN");
    committed = true;
  } catch (error) { remember(error); }
  finally {
    if (started && !committed) { try { await client.query("ROLLBACK"); } catch (error) { if (!hasFirst) { first = error; hasFirst = true; } } }
    try { await closeOwnedClient(client); } catch (error) { remember(error); }
  }
  if (hasFirst) throw new OwnerInstallFailure(committed ? "committed-cleanup-failed" : commitAttempted ? "commit-unknown" : "not-committed", first);
  return result;
}
/** No executor, Pool or injected Client is accepted; production always owns one strict-TLS Client. */
export async function withOwnerTransport<T>(input: OwnerDatabaseConfig, work: OwnerTransportWork<T>, prepare?: () => Promise<unknown>): Promise<T> {
  const { config, hostname } = productionConfig(input);
  await prepare?.();
  return clientTransaction(config, hostname, work);
}
export interface OwnedUnixTransportConfig { host: string; port: number; user: string; password: string; database: string }
/** Internal native-fixture transport. Each purpose factory additionally checks its own owned directory and fixed identity. */
export async function withOwnedUnixOwnerTransport<T>(input: OwnedUnixTransportConfig, work: OwnerTransportWork<T>): Promise<T> {
  if (process.env.NOTIONBLOG_DEVELOPMENT_MODE !== "offline" || !Reflect.get(globalThis, Symbol.for("notionblog.offline-network-guard"))) fail("OWNER_INSTALL_OFFLINE_REQUIRED");
  if (!input.host.startsWith("/private/tmp/nb-") || !Number.isInteger(input.port) || input.port < 1 || input.port > 65535 || !input.user || !input.password || !input.database) fail("OWNER_INSTALL_NATIVE_CONFIG");
  return clientTransaction({ host: input.host, port: input.port, user: input.user, password: input.password, database: input.database, ssl: false, options: "" }, undefined, work);
}

import { Client, type QueryResult } from "pg";
import { checkServerIdentity, type TLSSocket } from "node:tls";
import { isIP } from "node:net";
import { createHash } from "node:crypto";
import type { SharedBudget } from "../website-sync/shared-budget.ts";
import type { CommitRolloutConnection } from "./commit-rollout.ts";
import { hostNeed } from "./commit-host-files.ts";
import { commitCatalogDigest } from "./commit-catalog.ts";

export interface HostCredentials { url: string; ca: string }
export interface HostTransportMetrics { connections: number; tlsVerified: number; closed: number; driverCalls: number; logicalBytes: number; streamReceivedBytes: number }
export function commitHostTarget(credentials: HostCredentials) {
  const url = new URL(credentials.url);
  hostNeed(["postgres:","postgresql:"].includes(url.protocol) && url.username && url.password && url.pathname.length > 1 && !url.search && !url.hash && credentials.ca.includes("BEGIN CERTIFICATE"), "CACHE_HOST_DATABASE_CONFIG");
  return { url, digest: commitCatalogDigest({ host: url.hostname, port: url.port || "5432", database: url.pathname, login: url.username, ca: createHash("sha256").update(credentials.ca).digest("hex") }) };
}
/** One actual pg Client per connection; no Pool, reconnect or global transport patch. */
export function createHostConnector(expectedTarget: string, load: () => Promise<HostCredentials>, budget: SharedBudget, maximumConnections: number, window: { businessEnd: number; cleanupEnd: number }) {
  const metrics: HostTransportMetrics = { connections: 0, tlsVerified: 0, closed: 0, driverCalls: 0, logicalBytes: 0, streamReceivedBytes: 0 };
  let credentials: HostCredentials | undefined;
  const clients = new Set<Client>();
  const guard = () => { budget.guard(); hostNeed(Date.now() < window.businessEnd, "CACHE_HOST_DEADLINE"); };
  const close = async (client: Client) => {
    const stream = client.connection.stream as TLSSocket;
    let forced = false;
    if (!stream.closed) await new Promise<void>((ok) => {
      const timer = setTimeout(() => { forced = true; stream.destroy(); }, 5000);
      stream.once("close", () => { clearTimeout(timer); ok(); });
      void client.end().catch(() => stream.destroy());
    });
    if (clients.delete(client)) { metrics.closed++; metrics.streamReceivedBytes += Number(stream.bytesRead) || 0; }
    hostNeed(!forced && stream.closed && stream.destroyed, "CACHE_HOST_CLOSE");
  };
  const connect = async (): Promise<CommitRolloutConnection> => {
    guard(); hostNeed(metrics.connections < maximumConnections, "CACHE_HOST_CONNECTION_LIMIT"); metrics.connections++;
    credentials ??= structuredClone(await load());
    guard();
    const target = commitHostTarget(credentials); hostNeed(target.digest === expectedTarget, "CACHE_HOST_TARGET");
    const client = new Client({ connectionString: credentials.url, ssl: { ca: credentials.ca, rejectUnauthorized: true, ...(!isIP(target.url.hostname) ? { servername: target.url.hostname } : {}) },
      connectionTimeoutMillis: Math.min(5000,Math.max(1,window.businessEnd-Date.now())), query_timeout: 20000, statement_timeout: 15000, application_name: "notionblog-cache-rollout" });
    client.on("error", () => {}); clients.add(client);
    try {
      await client.connect();
      const stream = client.connection.stream as TLSSocket;
      hostNeed(stream.encrypted === true && stream.authorized === true && !checkServerIdentity(target.url.hostname, stream.getPeerCertificate()), "CACHE_HOST_TLS");
      metrics.tlsVerified++; guard();
    } catch { await close(client); throw Error("CACHE_HOST_CONNECT"); }
    const query = async (text: string, values: unknown[] = []) => {
      const state = budget.read(), cleanup = text === "ROLLBACK" && (state.failure !== null || Date.now() >= budget.plan.deadline || Date.now() >= window.businessEnd);
      if (!cleanup) guard(); else hostNeed(Date.now()<window.cleanupEnd,"CACHE_HOST_DEADLINE");
      const requestBytes = Buffer.byteLength(JSON.stringify({ text, values }));
      budget.charge(cleanup ? { cleanupSqlRequests: 1, cleanupSqlRequestBytes: requestBytes } : { sqlRequests: 1, sqlRequestBytes: requestBytes }, cleanup);
      if (!cleanup) guard(); else hostNeed(Date.now()<window.cleanupEnd,"CACHE_HOST_DEADLINE");
      metrics.driverCalls++;
      const response = await client.query(text, values);
      const results: QueryResult[] = Array.isArray(response) ? response : [response];
      const bytes = Buffer.byteLength(JSON.stringify(results.map(r => r.rows)));
      metrics.logicalBytes += bytes;
      budget.observe(cleanup ? { cleanupSqlResponseBytes: bytes } : { sqlResponseBytes: bytes }, cleanup);
      if (!cleanup) guard(); return results;
    };
    let closeAttempted = false;
    return { targetSHA256: target.digest, transport: "verified-tls",
      query: async <T>(text: string, values?: unknown[]) => { const results = await query(text, values); hostNeed(results.length === 1, "CACHE_HOST_QUERY"); return { rows: results[0].rows as T[] }; },
      command: async (text, values) => { const rows = await query(text, values); hostNeed(rows.length === 1, "CACHE_HOST_QUERY"); return rows[0].command === "UPDATE" ? `UPDATE ${rows[0].rowCount}` : rows[0].command; },
      script: async text => { await query(text); },
      close: async () => { hostNeed(!closeAttempted, "CACHE_HOST_CLOSE"); closeAttempted = true; await close(client); },
    };
  };
  return { connect, metrics, allClosed: () => clients.size === 0, clearCredentials: () => { credentials = undefined; } };
}

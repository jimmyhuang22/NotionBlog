/** Explicit private Unix-socket acceptance. No URL, env file or real project adapter. */
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { mkdtemp, mkdir, open, rm, stat, realpath, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import type { SqlExecutor } from "../../src/server/database/sql.ts";
import { commitSQL } from "../helpers/cache-commit-fixture.ts";
import { setupCacheRolloutFixture } from "../helpers/cache-rollout-fixture.ts";
import { commitCatalogDigest } from "../../scripts/public-cache/commit-catalog.ts";
import { readCommitRolloutFacts, prepareCommitMigration, runCommitRollout, type CommitRolloutPlan, type CommitRolloutPorts, type CommitRolloutConnection } from "../../scripts/public-cache/commit-rollout.ts";
import { createCommitRolloutJournal } from "../../scripts/public-cache/commit-rollout-journal.ts";

const [flag, bin, ...extra] = process.argv.slice(2);
if (flag !== "--bin" || !bin?.startsWith("/") || extra.length) throw Error("LOCAL_POSTGRES_BIN_REQUIRED");
const binaries = await realpath(bin);
for (const name of ["postgres", "initdb"]) { const s = await stat(join(binaries, name)); if (!s.isFile() || s.mode & 0o022 || !(s.mode & 0o111)) throw Error("LOCAL_POSTGRES_BIN_UNSAFE"); }
const root = await realpath(await mkdtemp(join(tmpdir(), "nb-rollout-pg-"))), data = join(root, "data"), socket = join(root, "socket");
await mkdir(socket, { mode: 0o700 });
const log = await open(join(root, "postgres.log"), "wx", 0o600), clients: Client[] = [], checks: string[] = [];
let server: ReturnType<typeof spawn> | undefined;
async function connect() {
  const c = new Client({ host: socket, port: 55432, user: "fixture_owner", database: "postgres", ssl: false, connectionTimeoutMillis: 1000, statement_timeout: 3000, query_timeout: 4000 });
  clients.push(c); await c.connect(); return c;
}
const port = (c: Client): SqlExecutor => ({ query: async <T>(q: string, v?: unknown[]) => ({ rows: (await c.query(q, v)).rows as T[] }) });
try {
  const engine = (await promisify(execFile)(join(binaries, "postgres"), ["--version"])).stdout.trim();
  await promisify(execFile)(join(binaries, "initdb"), ["-D", data, "--no-locale", "--encoding=UTF8", "--auth=trust", "--username=fixture_owner"], { env: { PATH: "/usr/bin:/bin", LANG: "C", NODE_ENV: "test" } });
  server = spawn(join(binaries, "postgres"), ["-D", data, "-k", socket, "-p", "55432", "-c", "listen_addresses=", "-c", "unix_socket_permissions=0700", "-c", "fsync=off"], { stdio: ["ignore", log.fd, log.fd], env: { PATH: "/usr/bin:/bin", LANG: "C", NODE_ENV: "test" } });
  let owner: Client | undefined;
  for (let n = 0; n < 60 && !owner; n++) { try { owner = await connect(); } catch { if (server.exitCode !== null) throw Error("LOCAL_POSTGRES_START_FAILED"); await new Promise(ok => setTimeout(ok, 100)); } }
  assert.ok(owner); assert.equal((await owner.query("SHOW listen_addresses")).rows[0].listen_addresses, "");
  const db = port(owner); await setupCacheRolloutFixture(db, q => owner!.query(q));
  const originalRetention = (await owner.query("SELECT * FROM nb_retention.config")).rows;
  const sql = await commitSQL(), prepared = prepareCommitMigration(sql), before = await readCommitRolloutFacts(db);
  await owner.query("BEGIN"); await owner.query(prepared.body); const after = await readCommitRolloutFacts(db); await owner.query("ROLLBACK");
  const plan = (action: CommitRolloutPlan["action"]): CommitRolloutPlan => ({ version: 1, operation: randomUUID(), action, environment: "isolated", targetSHA256: "a".repeat(64), packageSHA256: "b".repeat(64), runtimeSHA256: "c".repeat(64), migrationBodySHA256: prepared.bodySHA256,
    beforeFactsSHA256: commitCatalogDigest(action === "install" ? before : after), afterFactsSHA256: commitCatalogDigest(after), beforeTables: (action === "install" ? before : after).tables, afterTables: after.tables });
  const observer = await connect();
  const run = async (action: CommitRolloutPlan["action"], fault?: "script" | "commit-before" | "commit-after" | "commit-rollback" | "probe-lock") => {
    const p = plan(action), journal = await createCommitRolloutJournal(join(root, ".local"), p.operation);
    let releases = 0, connections = 0, commits = 0, probes = 0;
    const ports: CommitRolloutPorts = { now: () => Date.now(), ...journal,
      hold: async (runtime, pkg) => { assert.equal(runtime, p.runtimeSHA256); assert.equal(pkg, p.packageSHA256); return { verify: async () => {}, release: async () => { releases++; } }; },
      connect: async () => {
        connections++; const c = await connect();
        const result: CommitRolloutConnection = { ...port(c), targetSHA256: p.targetSHA256, transport: "private-unix-fixture",
          command: async (q, v) => {
            if (q === "COMMIT") {
              commits++;
              if (fault === "commit-before") throw Error("synthetic transport loss before send");
              if (fault === "commit-rollback") { try { await c.query("SELECT 1/0"); } catch {} }
            }
            const r = await c.query(q, v);
            if (q === "COMMIT" && fault === "commit-after") throw Error("synthetic acknowledgement loss after actual commit");
            return r.command === "UPDATE" ? `UPDATE ${r.rowCount}` : r.command;
          },
          script: async body => {
            await c.query(body);
            if (fault === "script") throw Error("synthetic post-DDL failure");
            if (fault === "probe-lock") { await observer.query("SET lock_timeout='100ms'"); await assert.rejects(observer.query("INSERT INTO nb_thumbnails.media VALUES('blocked')"), (e: any) => e.code === "55P03"); probes++; }
          },
          close: async () => { await c.end(); assert.equal(c.connection.stream.destroyed, true); },
        }; return result;
      },
    };
    const now = Date.now(), report = await runCommitRollout(p, { approved: true, nonce: randomUUID(), planSHA256: commitCatalogDigest(p), issuedAt: now, startBefore: now + 30_000, businessEnd: now + 120_000, cleanupEnd: now + 180_000, maxConnections: 2, maxDriverCalls: 80, maxLogicalBytes: 262144 }, sql, ports);
    assert.ok((await readdir(join(root, ".local", `operation-${p.operation}`))).length > 1);
    return { report, releases, connections, commits, probes };
  };
  let r = await run("install", "script"); assert.equal(r.report.outcome, "rolled-back"); assert.equal((await owner.query("SELECT to_regclass('nb_cache.commit_config') AS name")).rows[0].name, null); checks.push("partial real DDL rolls back every new object");
  r = await run("install", "probe-lock"); assert.equal(r.report.verified, true); assert.equal(r.probes, 1); assert.equal(r.commits, 1); assert.equal(r.connections, 2); checks.push("installer retains the real producer-table lock after all DDL until its only COMMIT and independently verifies disabled installation");
  assert.deepEqual((await owner.query("SELECT * FROM nb_retention.config")).rows, originalRetention); await assert.rejects(owner.query("SELECT nb_retention.assert_enabled()"), (e: any) => e.message.includes("RETENTION_DISABLED_OR_CATALOG_CHANGED")); checks.push("real retention installation stays unchanged and its guard rejects the changed cache function catalog");
  await observer.query("BEGIN;INSERT INTO nb_thumbnails.media VALUES('in-flight')");
  r = await run("enable"); assert.equal(r.report.outcome, "rolled-back"); assert.equal(r.commits, 0); await observer.query("ROLLBACK"); checks.push("an in-flight producer is rejected by NOWAIT table fencing without mutation");
  r = await run("enable", "commit-before"); assert.equal(r.report.outcome, "unknown"); assert.equal(r.releases, 0); assert.equal(r.connections, 1); checks.push("loss before COMMIT send is conservatively unknown and retains the local hold");
  r = await run("enable", "commit-after"); assert.equal(r.report.outcome, "unknown"); assert.equal(r.releases, 0); assert.equal(r.commits, 1); assert.equal((await owner.query("SELECT enabled FROM nb_cache.commit_config")).rows[0].enabled, true); checks.push("loss after an actual COMMIT never replays or relabels the committed flag as rolled back");
  await owner.query("UPDATE nb_cache.commit_config SET enabled=false");
  r = await run("enable", "commit-rollback"); assert.equal(r.report.outcome, "unknown"); assert.equal((await owner.query("SELECT enabled FROM nb_cache.commit_config")).rows[0].enabled, false); checks.push("the real PostgreSQL ROLLBACK command tag for an aborted COMMIT is rejected");
  const generation = (await owner.query("SELECT generation FROM nb_cache.state")).rows[0].generation;
  r = await run("enable"); assert.equal(r.report.verified, true); assert.equal(r.releases, 1); checks.push("activation commits exactly once and verifies through a separately closed and reopened connection");
  r = await run("disable"); assert.equal(r.report.verified, true); assert.equal((await owner.query("SELECT enabled FROM nb_cache.commit_config")).rows[0].enabled, false); assert.equal((await owner.query("SELECT generation FROM nb_cache.state")).rows[0].generation, generation); checks.push("mode rollback retains installed objects, generation and the acknowledged event protocol");
  console.log(JSON.stringify({ passed: checks.length, checks, engine, transport: "private-unix-socket", tcpListening: false, projectRequests: 0, liveHoldAdapter: false, commitLoss: "synthetic injection around real PostgreSQL commits" }));
} finally {
  for (const c of clients.reverse()) { try { await c.end(); } catch {} }
  if (server && server.exitCode === null && server.signalCode === null) { const exited = once(server, "exit"), child = server; child.kill("SIGTERM"); const hardStop = setTimeout(() => child.kill("SIGKILL"), 5000); try { await exited; } finally { clearTimeout(hardStop); } }
  await log.close(); await rm(root, { recursive: true, force: true });
}

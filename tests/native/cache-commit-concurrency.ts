/** Explicit local-only acceptance. Never reads application env files or accepts a database URL. */
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, open, rm, stat, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { Client } from "pg";
import type { SqlExecutor } from "../../src/server/database/sql.ts";
import { setupCacheCommitFixture, commitSQL, ingestSample } from "../helpers/cache-commit-fixture.ts";
import { hash } from "../../scripts/social-sync/model.ts";
import { consumeCacheRefresh } from "../../scripts/public-cache/consume.ts";
import { cachePurgeResponse } from "../../src/server/public-cache/events.ts";
import protocol from "../../database/public-cache-commit-protocol.json" with { type: "json" };
import { readCommitCatalog, verifyCommitCatalog, classifyCommitCatalog } from "../../scripts/public-cache/commit-catalog.ts";
import { readPublicProjection } from "../../src/server/public-cache/read.ts";

const [flag, bin, ...extra] = process.argv.slice(2);
if (flag !== "--bin" || !bin || !bin.startsWith("/") || extra.length) throw Error("LOCAL_POSTGRES_BIN_REQUIRED");
const binaries = await realpath(bin);
for (const name of ["postgres", "initdb"]) { const s = await stat(join(binaries, name)); if (!s.isFile() || s.mode & 0o022 || !(s.mode & 0o111)) throw Error("LOCAL_POSTGRES_BIN_UNSAFE"); }
const root = await mkdtemp(join(tmpdir(), "nb-commit-pg-")), data = join(root, "data"), socket = join(root, "socket");
await mkdir(socket, { mode: 0o700 });
const log = await open(join(root, "postgres.log"), "wx", 0o600), clients: Client[] = [], checks: string[] = [];
let server: ReturnType<typeof spawn> | undefined;
const port = (client: Client): SqlExecutor => ({ query: async <T>(text: string, values?: unknown[]) => ({ rows: (await client.query(text, values)).rows as T[] }) });
async function connect(user = "fixture_owner") {
  const client = new Client({ host: socket, port: 55432, user, database: "postgres", ssl: false, connectionTimeoutMillis: 1000, statement_timeout: 3000, query_timeout: 4000 });
  await client.connect(); clients.push(client); return client;
}
try {
  const engine = (await promisify(execFile)(join(binaries, "postgres"), ["--version"])).stdout.trim();
  await promisify(execFile)(join(binaries, "initdb"), ["-D", data, "--no-locale", "--encoding=UTF8", "--auth=trust", "--username=fixture_owner"], { env: { PATH: "/usr/bin:/bin", LANG: "C", NODE_ENV:"test" } });
  server = spawn(join(binaries, "postgres"), ["-D", data, "-k", socket, "-p", "55432", "-c", "listen_addresses=", "-c", "unix_socket_permissions=0700", "-c", "fsync=off"],
    { stdio: ["ignore", log.fd, log.fd], env: { PATH: "/usr/bin:/bin", LANG: "C", NODE_ENV:"test" } });
  let owner: Client | undefined;
  for (let n = 0; n < 60 && !owner; n++) { try { owner = await connect(); } catch { if (server?.exitCode !== null) throw Error("LOCAL_POSTGRES_START_FAILED"); await new Promise(ok => setTimeout(ok, 100)); } }
  assert.ok(owner);
  assert.equal((await owner.query("SHOW listen_addresses")).rows[0].listen_addresses, "");
  const db = port(owner), fixture = await setupCacheCommitFixture(db, s => owner!.query(s));
  assert.equal(classifyCommitCatalog(await readCommitCatalog(db)),"legacy");
  await owner.query("CREATE ROLE fixture_other_owner SUPERUSER;SET ROLE fixture_other_owner");
  await assert.rejects(owner.query(await commitSQL()),(e:any)=>e.message.includes("NB_CACHE_COMMIT_OWNER"));
  await owner.query("ROLLBACK;RESET ROLE");
  assert.equal((await owner.query("SELECT to_regclass('nb_cache.commit_config') AS name")).rows[0].name,null);
  checks.push("a different migration owner is rejected before any barrier objects are installed");
  await owner.query("CREATE ROLE fixture_unrelated;GRANT USAGE ON SCHEMA nb_cache TO fixture_unrelated;ALTER DEFAULT PRIVILEGES IN SCHEMA nb_cache GRANT ALL ON TABLES TO fixture_unrelated;ALTER DEFAULT PRIVILEGES IN SCHEMA nb_cache GRANT EXECUTE ON FUNCTIONS TO fixture_unrelated");
  await owner.query(await commitSQL());
  assert.equal((await owner.query("SELECT has_table_privilege('fixture_unrelated','nb_cache.commit_config','UPDATE') AS allowed")).rows[0].allowed,false);
  assert.equal((await owner.query("SELECT has_function_privilege('fixture_unrelated','nb_cache.stage_commit_refresh(uuid,text,text)','EXECUTE') AS allowed")).rows[0].allowed,false);
  checks.push("every unrelated inherited default grantee is cleared from the new private tables/functions");
  const nativeCatalog=await readCommitCatalog(db);assert.deepEqual(nativeCatalog,protocol.expectedCatalog);
  verifyCommitCatalog(nativeCatalog,protocol.expectedCatalog);
  checks.push("native before/after catalogs match the independently reviewed source, constraints, ACLs and deferred trigger");
  await owner.query("CREATE ROLE fixture_social LOGIN;GRANT nb_social_worker TO fixture_social;CREATE ROLE fixture_writer LOGIN;GRANT nb_writer TO fixture_writer;CREATE ROLE fixture_publisher LOGIN;GRANT nb_cache_publisher TO fixture_publisher;CREATE ROLE fixture_operator LOGIN;GRANT nb_cache_operator TO fixture_operator");
  const a = await connect("fixture_social"), a2 = await connect("fixture_social"), b = await connect("fixture_writer"), publisher = await connect("fixture_publisher"), operator = await connect("fixture_operator");
  const stamp = async () => (await owner!.query("SELECT nb_cache_api.read_stamp() AS result")).rows[0].result;
  const generation = async () => BigInt((await owner!.query("SELECT generation FROM nb_cache.state")).rows[0].generation);
  const tryLock = async () => {
    await owner!.query("BEGIN");
    try { await owner!.query("SELECT * FROM nb_cache.state FOR UPDATE NOWAIT"); return true; }
    catch (e: any) { assert.equal(e.code, "55P03"); return false; }
    finally { await owner!.query("ROLLBACK"); }
  };
  const publishRaw = (prepared: Awaited<ReturnType<typeof fixture.prepare>>) => b.query("SELECT nb_v2_api.promote_run($1,$2,$3,0,true,0)", [prepared.lease.runId,prepared.lease.fence,
    // Real core records staged by prepare; use its stored count, not a fabricated receipt.
    fixtureRecordCount]);
  const fixtureRecordCount = Number((await owner.query("SELECT count(*) FROM nb_v2.records WHERE run_id=$1", [fixture.initialRun])).rows[0].count);
  const update = (sample: typeof fixture.samples[number]) => { const row = { ...sample.row, observedAt: new Date().toISOString() }; return { ...sample, row, payload: JSON.stringify(row), sha: hash(JSON.stringify(row)) }; };
  await owner.query("UPDATE nb_cache.state SET enabled=true");
  assert.deepEqual((await operator.query("SELECT nb_cache_api.read_commit_barrier() AS result")).rows[0].result, { version: 1, enabled: false });
  let pending = await fixture.prepare(port(b));
  await a.query("BEGIN"); await ingestSample(port(a), fixture.samples[0]); assert.equal(await tryLock(), false);
  await b.query("SET lock_timeout='200ms'"); await assert.rejects(publishRaw(pending), (e: any) => e.code === "55P03");
  await a.query("ROLLBACK"); await publishRaw(pending); checks.push("default-off path reproduces old cache-row blocking of actual promote_run");
  await owner.query("UPDATE nb_cache.commit_config SET enabled=true");
  pending = await fixture.prepare(port(b));
  const before = await stamp(); await a.query("BEGIN"); await ingestSample(port(a), fixture.samples[0]);
  assert.equal(await tryLock(), true); assert.equal((await stamp()).stamp, before.stamp);
  await publishRaw(pending); const afterContent = await stamp(); assert.notEqual(afterContent.stamp, before.stamp);
  await a.query("COMMIT"); assert.notEqual((await stamp()).stamp, afterContent.stamp);
  checks.push("new path lets actual promote_run commit while real restricted social ingest remains open, then advances for the later social commit");
  const beforeReverse = await generation(); await a.query("BEGIN"); await ingestSample(port(a), update(fixture.samples[0])); await a.query("COMMIT");
  pending = await fixture.prepare(port(b)); await publishRaw(pending); assert.equal(await generation(), beforeReverse + 2n);
  checks.push("social-first and content-second commits retain distinct generation changes");
  let prior = await generation(); await a.query("BEGIN"); await ingestSample(port(a), update(fixture.samples[0])); await a.query("ROLLBACK"); assert.equal(await generation(), prior);
  checks.push("rolled-back business data never advances the visible stamp");
  const original = (await owner.query("SELECT observed_at FROM social_sync.publications WHERE publication_key=$1", [fixture.samples[0].key])).rows[0].observed_at;
  await a.query("SET lock_timeout='200ms';BEGIN"); await ingestSample(port(a), update(fixture.samples[0]));
  await owner.query("BEGIN;SELECT * FROM nb_cache.state FOR UPDATE");
  await assert.rejects(a.query("COMMIT"), (e: any) => e.code === "55P03"); await owner.query("ROLLBACK");
  assert.equal(await generation(), prior); assert.equal((await owner.query("SELECT observed_at FROM social_sync.publications WHERE publication_key=$1", [fixture.samples[0].key])).rows[0].observed_at, original);
  checks.push("cache barrier failure at COMMIT rolls back the real social transaction");
  prior = await generation(); await a.query("BEGIN"); await ingestSample(port(a), update(fixture.samples[0])); await a2.query("BEGIN"); await ingestSample(port(a2), fixture.samples[1]);
  assert.equal(await tryLock(), true); await a2.query("COMMIT"); const mid = await generation(); await a.query("COMMIT"); assert.equal(mid, prior + 1n); assert.equal(await generation(), prior + 2n);
  checks.push("same-scope different bindings can remain open concurrently and reverse commit order is not lost");
  prior = await generation(); await a.query("BEGIN"); await ingestSample(port(a), update(fixture.samples[0])); await a.query("SET CONSTRAINTS ALL IMMEDIATE");
  assert.equal(await tryLock(), false); await a.query("ROLLBACK"); assert.equal(await generation(), prior);
  checks.push("explicit immediate constraints can restore early locking but retain atomic rollback");
  const cfg = { siteKey: "fixture-site", origin: "https://fixture.example", secret: "a".repeat(64) }; let purges = 0;
  const report = await consumeCacheRefresh(port(publisher), cfg, { request: (input, init) => cachePurgeResponse(new Request(input, init), {
    enabled: () => true, config: cfg, read: async id => (await publisher.query("SELECT nb_cache_api.read_event($1) AS result", [id])).rows[0].result,
    purge: async () => { purges++; },
  }) }); assert.equal(report.status, "complete"); assert.ok(purges > 0); checks.push("unchanged signed purge, scope coalescing and precise ACK consume the native events");
  let loads = 0;
  await readPublicProjection("social", "fixture", [], "fixture", { stamp, read: async (_key, _tags, load) => load() }, async () => {
    loads++; if (loads === 1) await ingestSample(port(a), update(fixture.samples[0])); return { value: loads };
  }); assert.equal(loads, 2); checks.push("real native generation changes still trigger the original read fence retry");
  prior = await generation(); await publisher.query("BEGIN"); await publisher.query("SELECT nb_cache_api.enqueue_refresh($1,'media',$2)", ["10000000-0000-0000-0000-000000000001","b".repeat(64)]);
  assert.equal(await tryLock(), false); await publisher.query("ROLLBACK"); assert.equal(await generation(), prior); checks.push("explicit enqueue remains synchronous and rolls back atomically");
  const target = (await owner.query("SELECT id FROM nb_v2.records WHERE run_id=(SELECT current_run FROM nb_v2.state) LIMIT 1")).rows[0].id;
  const plan = (await operator.query("SELECT nb_cache_api.plan_withdraw($1) AS result", [target])).rows[0].result;
  await operator.query("BEGIN"); await operator.query("SELECT nb_cache_api.withdraw($1,$2) AS result", ["20000000-0000-0000-0000-000000000001",plan]);
  assert.equal(await tryLock(), false); await operator.query("COMMIT"); assert.equal((await owner.query("SELECT count(*)::integer AS n FROM nb_v2.denied WHERE id=$1",[target])).rows[0].n,1);
  checks.push("withdrawal keeps its original synchronous deny/event barrier");
  assert.equal((await owner.query("SELECT count(*)::integer AS n FROM nb_cache.commit_intents")).rows[0].n, 0);
  console.log(JSON.stringify({ passed: checks.length, checks, engine, transport: "private-unix-socket", tcpListening: false, projectRequests: 0 }));
} finally {
  for (const client of clients.reverse()) { try { await client.query("ROLLBACK"); } catch {} try { await client.end(); } catch {} }
  if (server && server.exitCode === null && server.signalCode === null) {
    const exited = once(server,"exit"), child = server;
    child.kill("SIGTERM"); const hardStop = setTimeout(() => child.kill("SIGKILL"), 5000);
    try { await exited; } finally { clearTimeout(hardStop); }
  }
  await log.close(); await rm(root, { recursive: true, force: true });
}

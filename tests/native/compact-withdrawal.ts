/** Explicit, owned Unix-only PostgreSQL fixture. Never accepts a project URL. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readFile, realpath, rm, symlink } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { Client } from "pg";
import type { SqlExecutor } from "../../src/server/database/sql.ts";
import cacheProtocol from "../../database/public-cache-protocol.json" with { type: "json" };
import { createHash } from "node:crypto";
import { installCompactWithdrawal, withOwnedUnixCompactWithdrawalTestTransaction, type CompactWithdrawalOwnedUnixTestConfig } from "../../scripts/public-cache/compact-withdrawal-install.ts";
import { verifyCompactWithdrawalCapability } from "../../scripts/public-cache/compact-withdrawal-capability.ts";
import { planCompactWithdrawal, executeCompactWithdrawal } from "../../scripts/public-cache/withdraw.ts";
import { retentionMigrationSQL } from "../../scripts/database-retention/migration.ts";
import { compactAsset, compactAssetSummary } from "../helpers/compact-withdrawal.ts";

assert.equal(process.env.NOTIONBLOG_DEVELOPMENT_MODE, "offline");
assert.ok(Reflect.get(globalThis, Symbol.for("notionblog.offline-network-guard")));
assert.equal(process.argv.length, 2);
const path = process.env.B08_NATIVE_CONFIG;
assert.ok(path && basename(path) === "native-config.json" && /^\/private\/tmp\/nb-b08-[a-zA-Z0-9]+$/.test(dirname(path)));
assert.equal(await realpath(path), path);
for (const name of [dirname(path), path]) {
  const info = await lstat(name);
  assert.equal(info.uid, process.getuid?.()); assert.equal(info.mode & 0o077, 0); assert.equal(info.isSymbolicLink(), false);
  assert.equal(name === path ? info.isFile() : info.isDirectory(), true);
}
const configHandle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
let configBytes: Buffer;
try {
  const before = await configHandle.stat(), bytes = Buffer.alloc(4097); let size = 0;
  assert.ok(before.isFile() && before.uid === process.getuid?.() && !(before.mode & 0o077) && before.size <= 4096);
  while (size < bytes.length) { const next = await configHandle.read(bytes, size, bytes.length - size, size); if (!next.bytesRead) break; size += next.bytesRead; }
  const after = await configHandle.stat(), entry = await lstat(path);
  assert.ok(size <= 4096 && size === before.size && after.size === before.size && before.dev === entry.dev && before.ino === entry.ino && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs);
  configBytes = bytes.subarray(0, size);
} finally { await configHandle.close(); }
const input = JSON.parse(configBytes.toString("utf8")) as CompactWithdrawalOwnedUnixTestConfig;
assert.equal(input.ownerRoot, dirname(path));
assert.deepEqual(Object.keys(input).sort(), ["database", "host", "kind", "ownerRoot", "password", "port", "user"]);
assert.equal(input.kind, "compact-withdrawal-owned-unix-v1"); assert.equal(input.host, input.ownerRoot + "/socket");
assert.equal(input.user, "b08_fixture_owner"); assert.equal(input.password, "placeholder");
assert.equal(input.database, "b08_fixture"); assert.equal(input.port, 55432);
// This gate validates the actual owned directory/socket before any raw Client or
// schema write. Its empty callback requires no preinstalled application tables.
await withOwnedUnixCompactWithdrawalTestTransaction(input, async () => {});

const clients: Client[] = [], checks: string[] = [];
async function connect(name: string, role?: "nb_cache_operator" | "nb_writer" | "nb_retention_executor") {
  const client = new Client({ host: input.host, port: input.port, user: input.user, password: input.password,
    database: input.database, ssl: false, options: "", application_name: "b08_" + name,
    statement_timeout: 15000, query_timeout: 20000, connectionTimeoutMillis: 5000 });
  client.on("error", () => {}); clients.push(client); await client.connect();
  if (role) await client.query(`SET ROLE ${role}`);
  return client;
}
const executor = (client: Client): SqlExecutor => ({ query: async <T>(sql: string, values?: unknown[]) =>
  ({ rows: (await client.query(sql, values)).rows as T[] }) });
const code = (error: unknown) => error && typeof error === "object" && "code" in error ? error.code : undefined;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
let first: unknown, failed = false;
try {
  const gateRoot = await realpath(await mkdtemp("/private/tmp/nb-b08-gate-")), alias = input.ownerRoot + "/socket-alias";
  const originalConnect = Client.prototype.connect; let gateConnections = 0;
  assert.equal(Reflect.set(Client.prototype, "connect", function(this: Client, ...args: unknown[]) {
    gateConnections++; return Reflect.apply(originalConnect, this, args);
  }), true);
  try {
    await symlink(input.host, alias);
    await assert.rejects(withOwnedUnixCompactWithdrawalTestTransaction({ ...input, host: alias }, async () => {}), /OWNER_INSTALL_NATIVE_CONFIG/);
    await mkdir(gateRoot + "/socket", { mode: 0o700 });
    await symlink(input.host + "/.s.PGSQL.55432", gateRoot + "/socket/.s.PGSQL.55432");
    await assert.rejects(withOwnedUnixCompactWithdrawalTestTransaction({ ...input, ownerRoot: gateRoot, host: gateRoot + "/socket" }, async () => {}), /OWNER_INSTALL_NATIVE_CONFIG/);
    assert.equal(gateConnections, 0);
  } finally {
    Reflect.set(Client.prototype, "connect", originalConnect);
    await rm(alias, { force: true }); await rm(gateRoot, { recursive: true, force: true });
  }
  checks.push("native-gate-rejects-alias-and-socket-symlink-before-connect");
  const owner = await connect("owner");
  await owner.query("CREATE ROLE nb_reader NOLOGIN; CREATE ROLE nb_writer NOLOGIN; CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN");
  await owner.query(await readFile(new URL("../../database/website-migrations/001_website.sql", import.meta.url), "utf8"));
  const legacy = await readFile(new URL("../../" + cacheProtocol.migration.file, import.meta.url), "utf8");
  assert.equal(createHash("sha256").update(legacy).digest("hex"), cacheProtocol.migration.sha256); await owner.query(legacy);
  assert.equal((await withOwnedUnixCompactWithdrawalTestTransaction(input, installCompactWithdrawal)).outcome, "installed");
  assert.equal((await withOwnedUnixCompactWithdrawalTestTransaction(input, installCompactWithdrawal)).outcome, "verified-existing");
  checks.push("real-owned-client-atomic-install-and-repeat");
  const old = randomUUID(), current = randomUUID();
  await owner.query("INSERT INTO nb_v2.sources(key,kind,mode,data_source_id) VALUES('status','status','all','fixture-status')");
  for (const run of [old, current]) {
    await owner.query("INSERT INTO nb_v2.runs(id,fence,revision,epoch,config_digest,valid_until,status) VALUES($1,1,1,1,$2,clock_timestamp()+interval '1 hour','published')", [run, "a".repeat(64)]);
    for (const id of ["target", "other"]) await owner.query("INSERT INTO nb_v2.records(run_id,id,kind,source_key,ordinal,item,document) VALUES($1,$2,'status','status',1,$3::jsonb,'{}')", [run, id, JSON.stringify({ id, href: "/status#" + id, kind: "status", slug: id })]);
  }
  await owner.query("UPDATE nb_v2.state SET current_run=$1,revision=1,epoch=1,config_digest=$2,schema_digest=$2", [current, "a".repeat(64)]);
  const seed = async () => {
    await owner.query("DELETE FROM nb_v2.media; UPDATE nb_v2.records SET document='{}'; DELETE FROM nb_v2.denied; DELETE FROM nb_cache.events; UPDATE nb_cache.state SET generation=0; UPDATE nb_v2.state SET revision=1,lease_run=NULL,lease_until=NULL");
    for (const [run, asset] of [[old, compactAsset(1)], [current, compactAsset(2)]]) await owner.query("INSERT INTO nb_v2.media VALUES($1,$2,'target','{}')", [run, asset]);
  };
  await seed();
  const operator = await connect("operator", "nb_cache_operator"), held = await connect("held");
  await verifyCompactWithdrawalCapability(executor(operator));
  const plan = async (client = operator) => (await client.query("SELECT nb_cache_api.plan_withdraw_compact('target') AS result")).rows[0].result;
  const zero = async () => assert.deepEqual((await owner.query("SELECT (SELECT count(*)::int FROM nb_v2.denied) AS denied,(SELECT count(*)::int FROM nb_cache.events) AS events,(SELECT generation::text FROM nb_cache.state) AS generation")).rows[0], { denied: 0, events: 0, generation: "0" });
  const waitForLock = async (name: string, finished: () => boolean) => {
    for (let n = 0; n < 200; n++) {
      const row = (await owner.query("SELECT wait_event_type FROM pg_catalog.pg_stat_activity WHERE datname=current_database() AND application_name=$1", ["b08_" + name])).rows[0];
      if (row?.wait_event_type === "Lock") return;
      assert.equal(finished(), false, "fixture query must be waiting at its intended lock"); await sleep(10);
    }
    throw Error("B08_NATIVE_LOCK_NOT_OBSERVED");
  };
  const start = <T>(query: Promise<T>) => {
    let finished = false;
    const result = query.then(value => ({ value }), error => ({ error })).finally(() => { finished = true; });
    return { result, finished: () => finished };
  };
  const before = await plan(); assert.deepEqual(before.assetSummary, compactAssetSummary([compactAsset(1), compactAsset(2)]));
  await held.query("BEGIN; LOCK TABLE nb_v2.media IN ACCESS EXCLUSIVE MODE");
  const snapshotClient = await connect("snapshot", "nb_cache_operator"), snapshot = start(snapshotClient.query("SELECT nb_cache_api.plan_withdraw_compact('target') AS result"));
  await waitForLock("snapshot", snapshot.finished);
  await held.query("DELETE FROM nb_v2.media WHERE asset_id=$1", [compactAsset(1)]);
  await held.query("INSERT INTO nb_v2.media VALUES($1,$2,'target','{}')", [old, compactAsset(3)]);
  await held.query("UPDATE nb_v2.records SET document=$1::jsonb WHERE run_id=$2 AND id='other'", [JSON.stringify({ src: "/media/v2/" + compactAsset(3) + "?thumbnail=800" }), current]);
  await held.query("COMMIT");
  const snapshotResult = await snapshot.result; assert.ok("value" in snapshotResult);
  assert.deepEqual(snapshotResult.value.rows[0].result, before);
  const after = await plan(); assert.notEqual(after.assetSummary.digest, before.assetSummary.digest); assert.equal(after.sharedOwnerUrl, true);
  checks.push("stable-summary-and-full-peer-check-share-one-snapshot");

  await seed(); const stale = await plan();
  await held.query("BEGIN; SELECT singleton FROM nb_cache.state FOR UPDATE; SELECT singleton FROM nb_v2.state FOR UPDATE");
  await held.query("DELETE FROM nb_v2.media WHERE asset_id=$1", [compactAsset(1)]);
  await held.query("INSERT INTO nb_v2.media VALUES($1,$2,'target','{}')", [old, compactAsset(3)]);
  const freshClient = await connect("fresh", "nb_cache_operator"), fresh = start(freshClient.query("SELECT nb_cache_api.withdraw_compact($1,$2::jsonb)", [randomUUID(), JSON.stringify(stale)]));
  await waitForLock("fresh", fresh.finished); await held.query("COMMIT");
  const changed = await fresh.result; assert.ok("error" in changed); assert.match(String(changed.error), /NB_CACHE_PLAN_CHANGED/); await zero();
  checks.push("volatile-write-recomputes-after-cache-lock-wait");

  await held.query("BEGIN; SELECT singleton FROM nb_v2.state FOR UPDATE");
  await assert.rejects(operator.query("SELECT nb_cache_api.withdraw_compact($1,$2::jsonb)", [randomUUID(), JSON.stringify(await plan())]), error => code(error) === "55P03");
  await held.query("ROLLBACK"); await zero(); checks.push("source-state-nowait-refuses-before-business-write");

  await owner.query(`CREATE SCHEMA nb_publication; CREATE SCHEMA nb_v2_media; CREATE SCHEMA nb_thumbnails; CREATE SCHEMA nb_revalidation; CREATE SCHEMA nb_delta;
    CREATE TABLE nb_publication.state(singleton boolean,run_id uuid);
    CREATE TABLE nb_v2_media.sources(run_id uuid,asset_id text,binding jsonb);
    CREATE TABLE nb_thumbnails.media(version text,run_id uuid,parent_asset_id text,parent_sha text,width_cap integer,descriptor jsonb);
    CREATE TABLE nb_revalidation.bindings(run_id uuid,previous_run uuid);
    CREATE TABLE nb_delta.operations(operation_id uuid,expected_revision text)`);
  await owner.query("INSERT INTO nb_publication.state VALUES(true,$1)", [current]);
  await owner.query(retentionMigrationSQL);
  await owner.query("UPDATE nb_retention.config SET enabled=true,catalog_sha=nb_retention.catalog_sha()");
  await held.query("BEGIN; SELECT singleton FROM nb_v2.state FOR UPDATE");
  const writer = await connect("writer", "nb_writer"), writerWait = start(writer.query("SELECT nb_v2_api.begin_run($1,'fixture','fixture','fixture',60)", [randomUUID()]));
  await waitForLock("writer", writerWait.finished);
  const retention = await connect("retention", "nb_retention_executor");
  const guard = { run: old, stateSHA256: "a".repeat(64), publicationSHA256: "a".repeat(64), summarySHA256: "a".repeat(64), remainingPayloadSHA256: "a".repeat(64) };
  await assert.rejects(retention.query("SELECT nb_retention_api.delete_chunk('nb_v2.media',$1::jsonb,1,$2,$3)", [JSON.stringify(guard), randomUUID(), "b".repeat(64)]), error => code(error) === "55P03");
  await held.query("ROLLBACK"); const writerResult = await writerWait.result;
  assert.ok("error" in writerResult); assert.match(String(writerResult.error), /NB_HANDSHAKE_INVALID/); await zero();
  checks.push("actual-restricted-writer-and-retention-respect-state-lock");

  const budgetPlan = await plan(); await held.query("BEGIN; SELECT singleton FROM nb_cache.state FOR UPDATE");
  await operator.query("SET statement_timeout='25ms'");
  await assert.rejects(operator.query("SELECT nb_cache_api.withdraw_compact($1,$2::jsonb)", [randomUUID(), JSON.stringify(budgetPlan)]), error => code(error) === "57014");
  await held.query("ROLLBACK"); await operator.query("SET statement_timeout='15s'"); await zero();
  checks.push("statement-timeout-rolls-back-all-business-effects");

  await seed();
  await owner.query("INSERT INTO nb_v2.media SELECT $1,'a1.'||lpad(to_hex(n),64,'0'),'target','{}' FROM generate_series(3,40001) n", [old]);
  const config = { origin: "https://example.invalid", siteKey: "fixture", secret: "a".repeat(64) }, databaseHash = "b".repeat(64);
  const journal = await planCompactWithdrawal(executor(operator), "https://example.invalid/status#target", config, databaseHash);
  assert.equal(journal.plan.assetSummary.count, 40001);
  let saved = structuredClone(journal), dropAck = true, requests = 0;
  const uncertain: SqlExecutor = { query: async <T>(sql: string, values?: unknown[]) => {
    const result = await executor(operator).query<T>(sql, values);
    if (dropAck && /^\s*SELECT\s+nb_cache_api\.withdraw_compact\(/.test(sql)) { dropAck = false; throw Error("SYNTHETIC_ACK_LOST"); }
    return result;
  } };
  const save = async (value: typeof journal) => { saved = structuredClone(value); };
  const fetchFixture: typeof fetch = async (_url, init) => {
    requests++;
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      return Response.json({ version: 1, siteKey: "fixture", id: body.id, generation: body.generation, purged: true });
    }
    return new Response(null, { status: 404 });
  };
  await assert.rejects(executeCompactWithdrawal(journal, config, databaseHash, { db: uncertain, save, fetch: fetchFixture }), /SYNTHETIC_ACK_LOST/);
  assert.equal(saved.phase, "DENY_OUTCOME_UNKNOWN"); assert.equal(requests, 0);
  const resumedSql: string[] = [], resumedDb: SqlExecutor = { query: async <T>(sql: string, values?: unknown[]) => {
    resumedSql.push(sql); return executor(operator).query<T>(sql, values);
  } };
  const complete = await executeCompactWithdrawal(saved, config, databaseHash, { db: resumedDb, save, fetch: fetchFixture });
  assert.equal(complete.phase, "COMPLETE"); assert.equal((await owner.query("SELECT count(*)::int AS n FROM nb_cache.events")).rows[0].n, 1);
  assert.equal(resumedSql.filter(sql => /^\s*SELECT\s+nb_cache_api\.read_withdraw\(/.test(sql)).length, 1);
  assert.equal(resumedSql.some(sql => /^\s*SELECT\s+nb_cache_api\.(?:plan_withdraw_compact|withdraw_compact)\(/.test(sql)), false);
  const observed = requests; resumedSql.length = 0;
  await executeCompactWithdrawal(complete, config, databaseHash, { db: resumedDb, save, fetch: fetchFixture });
  assert.equal(requests, observed); assert.equal(resumedSql.filter(sql => /^\s*SELECT\s+nb_cache_api\.read_withdraw\(/.test(sql)).length, 1);
  assert.equal(resumedSql.some(sql => /^\s*SELECT\s+nb_cache_api\.(?:plan_withdraw_compact|withdraw_compact)\(/.test(sql)), false);
  checks.push("40001-assets-real-commit-lost-ack-read-proof-purge-and-repeat");
} catch (error) { first = error; failed = true; }
finally {
  for (const client of clients.reverse()) {
    try { await client.end(); }
    catch (error) { client.connection.stream.destroy(); if (!failed) { first = error; failed = true; } }
  }
}
if (failed) throw first;
console.log(JSON.stringify({ kind: "b08-native-compact-v1", checks, allDirectClientsClosed: true,
  transport: "owned-unix-pg-test", productionTlsVerified: false, projectRequests: 0 }));

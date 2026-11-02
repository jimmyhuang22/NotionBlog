/** Run only on the disposable, internally networked fixture named below.
 * Uses synthetic credentials and a fixture CA; accepts no project URL/env file. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { Client, Pool, type ClientConfig, type PoolConfig } from "pg";
import { databasePoolConfig, readerSqlExecutor } from "../../src/server/database/connection.ts";
import { withContentReadBudget } from "../../src/server/content-read-budget.ts";
import { configureOwnerArchive, ownerArchivePoolConfig } from "../../scripts/owner-archive.ts";

assert.deepEqual(process.argv.slice(2), ["--fixture-ca", "/proof/server.crt"]);
const host = "notionblog-m08-pg-20261102";
const url = `postgresql://fixture_owner:example@${host}:5432/postgres`;
const ca = await readFile("/proof/server.crt", "utf8"), pools: Pool[] = [], checks: string[] = [];
const owner = new Client({ connectionString: url, ssl: { ca, rejectUnauthorized: true }, connectionTimeoutMillis: 2000, query_timeout: 3000 });
// A transaction-pool startup-parameter fixture, not a real Supavisor. Keep pool
// options intact but discard its startup GUC before the real pg driver connects.
class IgnoredStartupClient extends Client {
  constructor(config: ClientConfig = {}) { super({ ...config, statement_timeout: undefined }); }
}
function pool(statement: number, max = 1) {
  const config: PoolConfig & { Client: typeof Client } = { ...databasePoolConfig(url, "verify", ca),
    statement_timeout: statement, max, application_name: "m08-reader-fixture", Client: IgnoredStartupClient };
  const p = new Pool(config); p.on("error", () => {}); pools.push(p); return p;
}
const setting = `SELECT setting::integer AS ms FROM pg_catalog.pg_settings WHERE name='statement_timeout'`;
try {
  await owner.connect();
  assert.equal((await owner.query("SHOW ssl")).rows[0].ssl, "on");
  await owner.query("DROP TABLE IF EXISTS fixture_m08; CREATE TABLE fixture_m08(value integer); INSERT INTO fixture_m08 VALUES(1)");
  for (const limit of [15000, 10000]) {
    const p = pool(limit), reader = readerSqlExecutor(p);
    const initial = await p.connect();
    assert.equal((await initial.query(setting)).rows[0].ms, 120000);
    const pid = (await initial.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    initial.release();
    const got = await reader.query<{ ms: number; read_only: string; pid: number }>(`SELECT
      (SELECT setting::integer FROM pg_catalog.pg_settings WHERE name='statement_timeout') AS ms,
      current_setting('transaction_read_only') AS read_only, pg_backend_pid() AS pid`);
    assert.deepEqual(got.rows[0], { ms: limit, read_only: "on", pid });
    const returned = await p.connect();
    assert.equal((await returned.query(setting)).rows[0].ms, 120000);
    assert.equal((await returned.query("SHOW transaction_read_only")).rows[0].transaction_read_only, "off");
    assert.equal((await returned.query("SELECT pg_backend_pid() AS pid")).rows[0].pid, pid);
    returned.release();
  }
  checks.push("ignored startup 2min becomes 15s/10s inside the read and resets on the same backend");

  const cancelledPool = pool(50), reader = readerSqlExecutor(cancelledPool);
  const began = performance.now();
  await assert.rejects(reader.query("SELECT pg_sleep(5)"), { code: "57014" });
  const cancelledMs = performance.now() - began;
  assert.ok(cancelledMs < 2000);
  assert.equal((await reader.query<{ value: number }>("SELECT value FROM fixture_m08")).rows[0].value, 1);
  await assert.rejects(reader.query("UPDATE fixture_m08 SET value=2"), { code: "25006" });
  assert.equal((await reader.query<{ value: number }>("SELECT value FROM fixture_m08")).rows[0].value, 1);
  checks.push("server cancels pg_sleep with 57014, rolls back, reuses healthy connection and rejects writes");

  const concurrent = pool(200, 2), concurrentReader = readerSqlExecutor(concurrent), abort = new AbortController();
  const warmed = await Promise.all([concurrent.connect(), concurrent.connect()]); warmed.forEach(c => c.release());
  const first = withContentReadBudget(abort.signal, () => concurrentReader.query("SELECT pg_sleep(0.3)"));
  const refused = assert.rejects(first);
  let active = false;
  for (let i = 0; i < 20; i++) {
    active = (await owner.query(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity
      WHERE application_name='m08-reader-fixture' AND state='active' AND query='SELECT pg_sleep(0.3)') AS active`)).rows[0].active;
    if (active) break;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(active, true);
  const second = withContentReadBudget(new AbortController().signal, () => concurrentReader.query<{ value: number }>("SELECT value FROM fixture_m08"));
  abort.abort(); await refused; assert.equal((await second).rows[0].value, 1);
  let drained = false;
  for (let i = 0; i < 40; i++) {
    const rows = (await owner.query(`SELECT count(*)::integer AS busy FROM pg_stat_activity
      WHERE application_name='m08-reader-fixture' AND (state LIKE 'idle in transaction%' OR (state='active' AND query LIKE '%pg_sleep%'))`)).rows;
    if (rows[0].busy === 0) { drained = true; break; }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(drained, true);
  checks.push("one aborted reader does not cancel another; no sleeping SQL or idle transactions remain");

  for (const operation of ["export", "restore"] as const) {
    const p = new Pool(ownerArchivePoolConfig(operation, url, "verify", ca)); pools.push(p);
    const client = await p.connect();
    try {
      await configureOwnerArchive(client, operation);
      assert.equal((await client.query(setting)).rows[0].ms, operation === "export" ? 60000 : 120000);
      assert.equal((await client.query("SHOW lock_timeout")).rows[0].lock_timeout, "5s");
    } finally { client.release(); }
  }
  checks.push("dedicated owner export/restore sessions apply 60s/120s and retain the 5s lock limit");
  console.log(JSON.stringify({ status: "PASS", engine: (await owner.query("SHOW server_version")).rows[0].server_version,
    tls: "verified fixture CA and hostname", cancelledMs: Math.round(cancelledMs), checks,
    limitation: "local PostgreSQL with a startup-GUC filtering client fixture; no real Supavisor or production connections" }));
} finally { await Promise.all(pools.map(p => p.end())); await owner.end(); }

import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { Pool, PoolClient } from "pg";
import { readerSqlExecutor } from "../src/server/database/connection.ts";
import { contentReadBudgetIdentity, withContentReadBudget } from "../src/server/content-read-budget.ts";
import { SearchResultBudget } from "../src/server/database/result-response-budget.ts";

type Config = { text: string; values?: unknown[]; query_timeout: number };
class Client extends EventEmitter {
  configs: Config[] = [];
  releases: boolean[] = [];
  run: (config: Config) => Promise<{ rows: unknown[]; command: string }> = async c => ({
    rows: c.text === "SELECT fixture" ? [{ fixture: 1 }] : [],
    command: c.text.startsWith("BEGIN") ? "BEGIN" : c.text.startsWith("SET") ? "SET" : c.text.startsWith("SELECT") ? "SELECT" : c.text,
  });
  query(config: Config) { this.configs.push(config); return this.run(config); }
  release(destroy = false) { this.releases.push(destroy); }
}
function fixture(options: { statement_timeout?: number; query_timeout?: number } = {}) {
  const clients: Client[] = [];
  let prepare = (_client: Client) => {};
  const pool = { options: { query_timeout: 20_000, ...options }, totalCount: 1, idleCount: 0, waitingCount: 0,
    connect(callback: (error: null, client: PoolClient) => void) {
      const client = new Client(); prepare(client); clients.push(client); callback(null, client as unknown as PoolClient);
    } } as unknown as Pool;
  return { clients, pool, sql: readerSqlExecutor(pool), prepare: (fn: typeof prepare) => { prepare = fn; } };
}
const signal = () => new AbortController().signal;

test("reader controls and read share one checkout, count all SQL, and preserve rows/parameters", async () => {
  const f = fixture({ statement_timeout: 10_000, query_timeout: 12_000 });
  await withContentReadBudget(signal(), async () => {
    assert.deepEqual(await f.sql.query("SELECT fixture", ["synthetic"]), { rows: [{ fixture: 1 }] });
    assert.equal(contentReadBudgetIdentity()!.sql!.queries, 4);
    assert.equal(contentReadBudgetIdentity()!.sql!.responseBytes, Buffer.byteLength(JSON.stringify([{ fixture: 1 }])) + 6);
  }, { maxQueries: 4, maxResponseBytes: 200 });
  assert.equal(f.clients.length, 1);
  assert.deepEqual(f.clients[0].configs.map(c => c.text), ["BEGIN READ ONLY", "SET LOCAL statement_timeout = 10000", "SELECT fixture", "COMMIT"]);
  assert.deepEqual(f.clients[0].configs[2].values, ["synthetic"]);
  assert.ok(f.clients[0].configs.every(c => c.query_timeout > 0 && c.query_timeout <= 12_000));
  assert.deepEqual(f.clients[0].releases, [false]);
  assert.equal(f.pool.options.statement_timeout, 10_000);
});

test("readers outside HTTP still establish a bounded transaction without changing pool options", async () => {
  const f = fixture({ statement_timeout: 120_000 });
  assert.deepEqual(await f.sql.query("SELECT fixture"), { rows: [{ fixture: 1 }] });
  assert.equal(f.clients[0].configs[1].text, "SET LOCAL statement_timeout = 15000");
  assert.deepEqual(f.clients[0].releases, [false]);
  assert.equal(f.pool.options.statement_timeout, 120_000);
  assert.equal(contentReadBudgetIdentity(), undefined);
});

test("controls and successive reads consume the original remaining request deadline", async () => {
  const f = fixture(); let now = 0;
  f.prepare(client => { const run = client.run; client.run = async c => { const r = await run(c); now += 10; return r; }; });
  await withContentReadBudget(signal(), async () => { await f.sql.query("SELECT fixture"); await f.sql.query("SELECT fixture"); }, { now: () => now, timeoutMs: 100 });
  assert.deepEqual(f.clients.flatMap(c => c.configs.map(x => x.query_timeout)), [100, 90, 80, 70, 60, 50, 40, 30]);
  assert.equal(f.clients[0].configs[1].text, "SET LOCAL statement_timeout = 90");
  assert.equal(f.clients[1].configs[1].text, "SET LOCAL statement_timeout = 50");
});

test("server statement cancellation rolls back before a client may return to the pool", async t => {
  t.mock.method(console, "warn", () => {});
  const f = fixture(), error = Object.assign(new Error("synthetic cancelled query"), { code: "57014" });
  f.prepare(client => { const run = client.run; client.run = c => c.text === "SELECT fixture" ? Promise.reject(error) : run(c); });
  await assert.rejects(withContentReadBudget(signal(), () => f.sql.query("SELECT fixture")), e => e === error);
  assert.deepEqual(f.clients[0].configs.map(c => c.text), ["BEGIN READ ONLY", "SET LOCAL statement_timeout = 15000", "SELECT fixture", "ROLLBACK"]);
  assert.deepEqual(f.clients[0].releases, [false]);
});

test("rollback failure preserves the original error and destroys the checkout once", async t => {
  t.mock.method(console, "warn", () => {});
  const f = fixture(), original = new Error("synthetic private SQL");
  f.prepare(client => { const run = client.run; client.run = c => ["SELECT fixture", "ROLLBACK"].includes(c.text) ? Promise.reject(c.text === "ROLLBACK" ? Error("cleanup") : original) : run(c); });
  await assert.rejects(withContentReadBudget(signal(), () => f.sql.query("SELECT fixture")), e => e === original);
  assert.deepEqual(f.clients[0].releases, [true]);
});

test("cancellation during configuration cannot issue the read or return an open transaction", async t => {
  t.mock.method(console, "warn", () => {});
  const f = fixture(), controller = new AbortController();
  f.prepare(client => { const run = client.run; client.run = async c => {
    const result = await run(c); if (c.text.startsWith("SET")) controller.abort(); return result;
  }; });
  await assert.rejects(withContentReadBudget(controller.signal, () => f.sql.query("SELECT fixture")), { code: "CONTENT_UNAVAILABLE" });
  assert.deepEqual(f.clients[0].configs.map(c => c.text), ["BEGIN READ ONLY", "SET LOCAL statement_timeout = 15000"]);
  assert.deepEqual(f.clients[0].releases, [true]);
});

test("SQL limits include control commands and never send an unbudgeted cleanup", async t => {
  t.mock.method(console, "warn", () => {});
  const f = fixture();
  await assert.rejects(withContentReadBudget(signal(), () => f.sql.query("SELECT fixture"), { maxQueries: 2 }), { code: "CONTENT_UNAVAILABLE" });
  assert.deepEqual(f.clients[0].configs.map(c => c.text), ["BEGIN READ ONLY"]);
  assert.deepEqual(f.clients[0].releases, [true]);
});

test("invalid control acknowledgements fail closed before business SQL", async t => {
  t.mock.method(console, "warn", () => {});
  const f = fixture(); f.prepare(client => { client.run = async () => ({ rows: [], command: "unexpected" }); });
  await assert.rejects(withContentReadBudget(signal(), () => f.sql.query("SELECT fixture")), { code: "CONTENT_UNAVAILABLE" });
  assert.ok(f.clients[0].configs.every(c => c.text !== "SELECT fixture"));
  assert.deepEqual(f.clients[0].releases, [true]);
});

test("a control allowance preserves the original business-query cap", async t => {
  t.mock.method(console, "warn", () => {});
  const f = fixture();
  await withContentReadBudget(signal(), async () => {
    await f.sql.query("SELECT fixture"); await f.sql.query("SELECT fixture");
    assert.equal(contentReadBudgetIdentity()!.sql!.queries, 8);
    await assert.rejects(f.sql.query("SELECT fixture"), { code: "CONTENT_UNAVAILABLE" });
  }, { maxContentQueries: 2, maxQueries: 8 });
  assert.equal(f.clients.length, 2);
});

test("search result-text accounting remains business-only while SQL controls are counted", async () => {
  const f = fixture(), resultBudget = new SearchResultBudget(100, 1);
  f.prepare(client => { const run = client.run; client.run = c => c.text.startsWith("WITH __nb_eval_text") ?
    Promise.resolve({ command: "SELECT", rows: [{ result: "true", __nb_result_text_bytes: 4 }] }) : run(c); });
  await withContentReadBudget(signal(), async () => {
    assert.deepEqual(await f.sql.query("SELECT nb_read_api.read_version('qualified') AS result"), { rows: [{ result: true }] });
    assert.equal(contentReadBudgetIdentity()!.sql!.queries, 4);
  }, { resultBudget, maxQueries: 4 });
  assert.deepEqual(resultBudget.snapshot(), { resultTextBytes: 4, statements: 1, failed: false });
  assert.deepEqual(f.clients[0].releases, [false]);
});

test("aborted late checkout sends no controls and concurrent readers keep separate state", async t => {
  t.mock.method(console, "warn", () => {});
  const client = new Client(); let finish!: () => void;
  const pool = { options: {}, connect(cb: (e: null, c: PoolClient) => void) { finish = () => cb(null, client as unknown as PoolClient); } } as unknown as Pool;
  await assert.rejects(withContentReadBudget(signal(), () => readerSqlExecutor(pool).query("SELECT fixture"), { timeoutMs: 10 }), { code: "CONTENT_UNAVAILABLE" });
  finish(); await Promise.resolve(); assert.equal(client.configs.length, 0); assert.deepEqual(client.releases, [false]);
  const f = fixture();
  await Promise.all([40, 80].map(timeoutMs => withContentReadBudget(signal(), () => f.sql.query("SELECT fixture"), { timeoutMs, now: () => 0 })));
  assert.deepEqual(f.clients.map(c => c.configs[1].text), ["SET LOCAL statement_timeout = 40", "SET LOCAL statement_timeout = 80"]);
});

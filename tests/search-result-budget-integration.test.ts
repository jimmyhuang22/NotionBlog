import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { Pool, PoolClient } from "pg";
import { sqlExecutor } from "../src/server/database/connection.ts";
import { SearchResultBudget, SEARCH_RESULT_TEXT_BYTES } from "../src/server/database/result-response-budget.ts";
import { budgetedContentSql, withContentReadBudget, contentReadBudgetIdentity } from "../src/server/content-read-budget.ts";
import { websiteQueryResponse } from "../src/lib/content/website-http.ts";
import { callSql } from "../src/server/database/sql.ts";
import type { ContentRepository } from "../contracts/repository.ts";
const SQL = "SELECT nb_read_api.read_search_parts('qualified',$1::text[]) AS result";
class Client extends EventEmitter {
  releases: boolean[] = []; configs: { text: string; values?: unknown[]; query_timeout: number }[] = [];
  run: (c: { text: string; values?: unknown[]; query_timeout: number }) => Promise<{ rows: unknown[] }> = async () => ({ rows: [{ result: {}, __nb_result_text_bytes: 2 }] });
  release(destroy = false) { this.releases.push(destroy); }
  query(c: { text: string; values?: unknown[]; query_timeout: number }) { this.configs.push(c); return this.run(c); }
}
function fixture() {
  const clients: Client[] = []; let connects = 0;
  const pool = { connect(cb: (error: null, client: PoolClient) => void) { connects++; const client = new Client(); clients.push(client); cb(null, client as unknown as PoolClient); },
    options: { query_timeout: 20000 }, totalCount: 1, idleCount: 0, waitingCount: 0 } as unknown as Pool;
  return { pool, clients, get connects() { return connects; }, sql: sqlExecutor(pool) };
}
test("disabled requests retain original SQL and opt-in reserves before checkout and strips metadata", async () => {
  const f = fixture(); await withContentReadBudget(new AbortController().signal, () => f.sql.query(SQL, [[]]));
  assert.equal(f.clients[0].configs[0].text, SQL);
  const b = new SearchResultBudget(100, 1);
  await withContentReadBudget(new AbortController().signal, async () => {
    assert.deepEqual(await f.sql.query(SQL, [[]]), { rows: [{ result: {} }] });
    await assert.rejects(f.sql.query(SQL, [[]]), { code: "CONTENT_UNAVAILABLE" });
  }, { resultBudget: b });
  assert.equal(f.connects, 2); assert.match(f.clients[1].configs[0].text, /MATERIALIZED/);
  assert.deepEqual(f.clients[1].configs[0].values, [[], 100]); assert.deepEqual(f.clients[1].releases, [false]);
});
test("budget rejection destroys its client once and preserves existing safe provider errors", async () => {
  for (const errorMessage of ["NB_CURSOR_INVALID", "NB_BUSY", "PRIVATE_SENTINEL"]) {
    const client = new Client(); client.run = async () => { throw Error(errorMessage); };
    const pool = { connect: (cb: (e: null, c: PoolClient) => void) => cb(null, client as unknown as PoolClient), options: {}, totalCount: 1, idleCount: 0, waitingCount: 0 } as unknown as Pool;
    await assert.rejects(withContentReadBudget(new AbortController().signal, () => callSql(sqlExecutor(pool), SQL, [[]]), { resultBudget: new SearchResultBudget() }),
      e => !String(e).includes("PRIVATE_SENTINEL") && (e as { code: string }).code === (errorMessage === "NB_BUSY" ? "RATE_LIMITED" : errorMessage === "NB_CURSOR_INVALID" ? "INVALID_QUERY" : "CONTENT_UNAVAILABLE"));
    assert.deepEqual(client.releases, [true]);
  }
});
test("opt-in keeps independent contexts, remaining deadlines and no shared pool mutation", async () => {
  const f = fixture(); let go!: () => void; const gate = new Promise<void>(r => { go = r; });
  const budgets = [new SearchResultBudget(), new SearchResultBudget()];
  const work = budgets.map(resultBudget => withContentReadBudget(new AbortController().signal, async () => { await gate; await f.sql.query(SQL, [[]]); assert.equal(contentReadBudgetIdentity()!.resultBudget, resultBudget); }, { resultBudget }));
  go(); await Promise.all(work); assert.deepEqual(budgets.map(b => b.snapshot().statements), [1, 1]);
  assert.equal(f.pool.options.query_timeout, 20000);
});
test("search HTTP applies flag without DTO changes, timeline ignores it, invalid mode fails before work", async () => {
  const keys = ["DATABASE_SEARCH_RESULT_BUDGET", "CONTENT_PROVIDER", "DATABASE_CONTENT_VERSION", "DATABASE_READ_PROJECTION", "DATABASE_PUBLICATION_MODE", "DATABASE_SEARCH_CONTEXT", "DATABASE_SEARCH_PROJECTION"];
  const prior = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  Object.assign(process.env, { DATABASE_SEARCH_RESULT_BUDGET: "bounded-v1", CONTENT_PROVIDER: "database", DATABASE_CONTENT_VERSION: "2", DATABASE_READ_PROJECTION: "scoped", DATABASE_PUBLICATION_MODE: "qualified", DATABASE_SEARCH_CONTEXT: "off", DATABASE_SEARCH_PROJECTION: "on-demand" });
  const page = { items: [], hasMore: false, nextCursor: null }, f = fixture(); let searches = 0;
  const repository = { search: async () => { searches++; assert.ok(contentReadBudgetIdentity()!.resultBudget); await f.sql.query(SQL, [[]]); return page; }, getTimeline: async () => { assert.equal(contentReadBudgetIdentity()!.resultBudget, undefined); return page; } } as unknown as ContentRepository;
  try {
    const response = await websiteQueryResponse(new Request("http://fixture.invalid/api/search?q=fixture"), repository, "search");
    assert.equal(response.status, 200); assert.deepEqual(await response.json(), { data: page }); assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.equal(f.clients[0].configs[0].values!.at(-1), SEARCH_RESULT_TEXT_BYTES);
    process.env.DATABASE_SEARCH_RESULT_BUDGET = "invalid";
    const bad = await websiteQueryResponse(new Request("http://fixture.invalid/api/search?q=fixture"), repository, "search");
    assert.equal((await bad.json()).error.code, "MISCONFIGURED"); assert.equal(searches, 1);
    // Timeline caching must stay off for this fixture's repository.
    const cache = process.env.PUBLIC_CONTENT_CACHE; process.env.PUBLIC_CONTENT_CACHE = "disabled";
    try { assert.equal((await websiteQueryResponse(new Request("http://fixture.invalid/api/timeline"), repository, "timeline")).status, 200); }
    finally { if (cache === undefined) delete process.env.PUBLIC_CONTENT_CACHE; else process.env.PUBLIC_CONTENT_CACHE = cache; }
  } finally { for (const key of keys) { if (prior[key] === undefined) delete process.env[key]; else process.env[key] = prior[key]; } }
});

test("oversized driver response closes its client and returns the existing safe HTTP 503", async () => {
  const f = fixture();
  // Simulate the SQL CASE returning only the size for an oversized value.
  const client = new Client();
  client.run = async () => ({ rows: [{ result: null, __nb_result_text_bytes: 101 }] });
  const pool = { ...f.pool, connect: (cb: (e: null, c: PoolClient) => void) => cb(null, client as unknown as PoolClient) } as unknown as Pool;
  const pending = withContentReadBudget(new AbortController().signal, async () => {
    await callSql(sqlExecutor(pool), SQL, [[]]);
    assert.fail("oversized results must stop the continuation");
  }, { resultBudget: new SearchResultBudget(100) });
  const { contentErrorResponse } = await import("../src/lib/content/http.ts");
  const response = await pending.then(() => assert.fail("expected rejection"), contentErrorResponse);
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, "CONTENT_UNAVAILABLE");
  assert.equal(client.configs.length, 1); assert.deepEqual(client.releases, [true]);
});

test("opt-in cancellation drains active SQL once and never submits the next query", async () => {
  const client = new Client(), controller = new AbortController(), resultBudget = new SearchResultBudget();
  let began!: () => void, fail!: (error: Error) => void;
  const started = new Promise<void>(resolve => { began = resolve; });
  client.run = () => { began(); return new Promise((_resolve, reject) => { fail = reject; }); };
  client.release = destroy => { client.releases.push(!!destroy); if (destroy) fail(Error("fixture terminated")); };
  const pool = { connect: (cb: (e: null, c: PoolClient) => void) => cb(null, client as unknown as PoolClient), options: {} } as unknown as Pool;
  const sql = sqlExecutor(pool);
  const pending = withContentReadBudget(controller.signal, async () => { await sql.query(SQL, [[]]); await sql.query(SQL, [[]]); }, { resultBudget });
  const checked = assert.rejects(pending); await started; controller.abort(); await checked;
  assert.equal(client.configs.length, 1); assert.deepEqual(client.releases, [true]);
  assert.equal(resultBudget.snapshot().failed, true);
});

test("opt-in expired checkout releases a late client without SQL and keeps the failure sticky", async () => {
  const client = new Client(), resultBudget = new SearchResultBudget(); let finish!: () => void;
  const pool = { connect: (cb: (e: null, c: PoolClient) => void) => { finish = () => cb(null, client as unknown as PoolClient); }, options: {} } as unknown as Pool;
  await assert.rejects(withContentReadBudget(new AbortController().signal, () => sqlExecutor(pool).query(SQL, [[]]),
    { timeoutMs: 15, resultBudget }), { code: "CONTENT_UNAVAILABLE" });
  finish(); await Promise.resolve();
  assert.equal(client.configs.length, 0); assert.deepEqual(client.releases, [false]);
  assert.throws(() => resultBudget.prepare(SQL, [[]]), { code: "CONTENT_UNAVAILABLE" });
});

test("opt-in successive statements keep the original remaining deadline", async () => {
  let now = 0; const clients: Client[] = [], resultBudget = new SearchResultBudget();
  const pool = { connect: (cb: (e: null, c: PoolClient) => void) => {
    const client = new Client(); clients.push(client);
    client.run = async () => { now += 40; return { rows: [{ result: true, __nb_result_text_bytes: 4 }] }; };
    cb(null, client as unknown as PoolClient);
  }, options: { query_timeout: 20000 } } as unknown as Pool;
  await withContentReadBudget(new AbortController().signal, async () => {
    await sqlExecutor(pool).query(SQL, [[]]); await sqlExecutor(pool).query(SQL, [[]]);
  }, { resultBudget, timeoutMs: 100, now: () => now });
  assert.deepEqual(clients.map(c => c.configs[0].query_timeout), [100, 60]);
  assert.deepEqual(clients.map(c => c.configs[0].values!.at(-1)), [SEARCH_RESULT_TEXT_BYTES, SEARCH_RESULT_TEXT_BYTES - 4]);
  assert.equal(pool.options.query_timeout, 20000);
});

test("the result-text guard preserves the existing generic SQL count and response limits", async () => {
  for (const limit of [{ maxQueries: 1 }, { maxResponseBytes: 1 }]) {
    const f = fixture(), resultBudget = new SearchResultBudget(), db = budgetedContentSql(f.sql);
    await assert.rejects(withContentReadBudget(new AbortController().signal, async () => {
      await db.query(SQL, [[]]);
      await db.query(SQL, [[]]);
    }, { ...limit, resultBudget }), { code: "CONTENT_UNAVAILABLE" });
    assert.equal(f.connects, 1, "the generic guard must stop a second checkout");
    assert.equal(resultBudget.snapshot().statements, 1);
    assert.deepEqual(f.clients[0].releases, [false]);
  }
});

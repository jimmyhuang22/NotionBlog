import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Pool, type PoolClient, type PoolConfig } from "pg";
import { attachSocialReaderPool, monitoredSocialReaderSql } from "../src/server/social/pool.ts";
import { attachContentReaderPool } from "../src/server/database/reader-pool.ts";
import { verifySocialReader } from "../src/server/social/reader.ts";
import { socialWorksResponse } from "../src/lib/content/social-http.ts";
import { createSocialRepository } from "../src/server/social/repository.ts";
import type { SqlExecutor } from "../src/server/database/sql.ts";

/** pg's real pool and idle timers; only the network client is simulated. */
class OfflineClient extends EventEmitter {
  _queryable = true;
  _ending = false;
  ended = false;
  connect(callback: (error?: Error) => void) { queueMicrotask(() => callback()); }
  end(callback?: () => void) {
    this.ended = true;
    this._ending = true;
    queueMicrotask(() => { this.emit("end"); callback?.(); });
  }
  ref() {}
  unref() {}
}

for (const [name, attach] of [["social", attachSocialReaderPool], ["content", attachContentReaderPool]] as const)
test(name + " pool keeps Vercel alive until idle clients close, reuses queued capacity and preserves active clients", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const contextKey = Symbol.for("@vercel/request-context");
  const globals = globalThis as unknown as Record<symbol, unknown>;
  const originalContext = globals[contextKey];
  const originalUrl = process.env.VERCEL_URL;
  const originalRegion = process.env.VERCEL_REGION;
  const waits: Promise<unknown>[] = [];
  globals[contextKey] = { get: () => ({ waitUntil: (promise: Promise<unknown>) => waits.push(promise) }) };
  process.env.VERCEL_URL = "example.vercel.app";
  process.env.VERCEL_REGION = "sin1";
  const pool = new Pool({ Client: OfflineClient, max: 2, idleTimeoutMillis: 5000 } as unknown as PoolConfig);
  const active = new Set<PoolClient>();
  t.after(async () => {
    for (const client of active) client.release(true);
    await pool.end();
    if (originalContext === undefined) delete globals[contextKey]; else globals[contextKey] = originalContext;
    if (originalUrl === undefined) delete process.env.VERCEL_URL; else process.env.VERCEL_URL = originalUrl;
    if (originalRegion === undefined) delete process.env.VERCEL_REGION; else process.env.VERCEL_REGION = originalRegion;
  });
  attach(pool);
  const [first, second] = await Promise.all([pool.connect(), pool.connect()]);
  active.add(first); active.add(second);
  const queued = pool.connect();
  assert.equal(pool.totalCount, 2);
  assert.equal(pool.waitingCount, 1);
  active.delete(first); first.release();
  const reused = await queued; active.add(reused);
  assert.equal(reused, first);
  assert.equal(waits.length, 1);
  t.mock.timers.tick(5000);
  assert.equal(pool.totalCount, 2);
  assert.equal((second as unknown as OfflineClient).ended, false);
  assert.equal((reused as unknown as OfflineClient).ended, false);

  active.delete(second); second.release();
  let platformCanSuspend = false;
  void waits.at(-1)!.then(() => { platformCanSuspend = true; });
  t.mock.timers.tick(5000);
  await Promise.resolve();
  assert.equal(pool.totalCount, 1);
  assert.equal((second as unknown as OfflineClient).ended, true);
  assert.equal((reused as unknown as OfflineClient).ended, false);
  assert.equal(platformCanSuspend, false);
  t.mock.timers.tick(100);
  await Promise.all(waits);
  assert.equal(platformCanSuspend, true);

  active.delete(reused); reused.release();
  t.mock.timers.tick(5100);
  await Promise.all(waits);
  assert.equal(pool.totalCount, 0);
  assert.equal((reused as unknown as OfflineClient).ended, true);
});

test("social driver diagnostics preserve errors and expose only stage and safe error codes", async t => {
  const logs: unknown[][] = [];
  t.mock.method(console, "error", (...args: unknown[]) => { logs.push(args); });
  let calls = 0;
  const privateError = Object.assign(new Error("private connection password and source ID"), {
    code: "53300", detail: "private parameters", query: "private query", connectionString: "private URL",
  });
  const sql = monitoredSocialReaderSql({ query: async () => { calls++; throw privateError; } });
  await assert.rejects(sql.query("private SQL", ["private value"]), error => error === privateError);
  assert.equal(calls, 1);
  assert.deepEqual(logs, [["social_reader_database_error", { stage: "query", code: "53300" }]]);
  await assert.rejects(verifySocialReader(sql), { code: "CONTENT_UNAVAILABLE" });
  const response = await socialWorksResponse(new Request("http://example.local/api/social/works"), createSocialRepository(sql), () => true);
  assert.equal(response.status, 503);
  assert.equal((await response.text()).includes("private"), false);
  assert.equal(calls, 3); // One attempt each, without a retry or cached successful response.

  for (const code of ["ECONNRESET", "private-source-id", undefined]) {
    const error = Object.assign(new Error("private idle client"), { code });
    const pool = new Pool(); t.after(() => pool.end());
    attachSocialReaderPool(pool);
    pool.emit("error", error);
  }
  assert.deepEqual(logs.slice(-3), [
    ["social_reader_database_error", { stage: "idle_pool", code: "ECONNRESET" }],
    ["social_reader_database_error", { stage: "idle_pool", code: "UNKNOWN" }],
    ["social_reader_database_error", { stage: "idle_pool", code: "UNKNOWN" }],
  ]);
  assert.equal(JSON.stringify(logs).includes("private"), false);
});

test("successful social SQL retains its parameters and result without logging", async t => {
  const log = t.mock.method(console, "error", () => {});
  const values = ["example-value"];
  const result = { rows: [{ example: 1 }] };
  const sql = monitoredSocialReaderSql({ query: async (text, parameters) => {
    assert.equal(text, "SELECT example"); assert.equal(parameters, values);
    return result;
  } } as SqlExecutor);
  assert.equal(await sql.query("SELECT example", values), result);
  assert.equal(log.mock.callCount(), 0);
});

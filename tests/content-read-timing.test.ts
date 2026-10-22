import test from "node:test";
import assert from "node:assert/strict";
import type { Pool } from "pg";
import { EventEmitter } from "node:events";
import { sqlExecutor } from "../src/server/database/connection.ts";
import { contentReadTimingActive, measureContentRead, measureContentReadAsync, recordContentPoolState, traceContentRead, type ContentReadTiming } from "../src/server/content-read-timing.ts";

test("detail diagnostics split checkout and SQL without recording private inputs or returned DTOs", async () => {
  const reports: ContentReadTiming[] = []; let released = 0, direct = 0;
  const pool = { query: async () => { direct++; return { rows: [] }; }, connect: async () => Object.assign(new EventEmitter(), {
    query: async () => ({ rows: [{ body: "private-body-fixture" }] }), release: () => { released++; },
  }) } as unknown as Pool;
  const result = await traceContentRead("detail", "movie", () => sqlExecutor(pool).query("SELECT $1", ["private-query-input"]), t => reports.push(t));
  assert.deepEqual(result.rows, [{ body: "private-body-fixture" }]);
  assert.equal(released, 1); assert.equal(direct, 0);
  assert.deepEqual(reports[0]!.phases.map(p => [p.phase, p.calls]), [["database-acquire", 1], ["database-roundtrip", 1]]);
  assert.equal(reports[0]!.outcome, "ok");
  assert.ok(!JSON.stringify(reports).includes("private-"));
  assert.ok(reports[0]!.totalMs >= 0 && reports[0]!.phases.every(p => p.totalMs >= 0));
});

test("failed SQL releases the checked-out client and observability cannot mask the original error", async () => {
  const original = Error("private-provider-fixture"); let released = 0;
  const client = Object.assign(new EventEmitter(), { query: async () => { client.emit("error", original); throw original; }, release: (failure: unknown) => { assert.equal(failure, original); released++; } });
  const pool = { connect: async () => client } as unknown as Pool;
  await assert.rejects(traceContentRead("detail", "book", () => sqlExecutor(pool).query("SELECT $1", ["fixture"]), timing => {
    assert.equal(timing.outcome, "error"); assert.equal(timing.phases.length, 2); throw Error("logging-failed");
  }), error => error === original);
  assert.equal(released, 1); assert.equal(contentReadTimingActive(), false);
});

test("concurrent detail and metadata operations retain isolated phase counts", async () => {
  const reports: ContentReadTiming[] = []; let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const a = traceContentRead("detail", "movie", async () => {
    recordContentPoolState({ total: 0, idle: 0, waiting: 0 });
    await measureContentReadAsync("database-roundtrip", () => gate);
    return measureContentRead("dto-projection", () => 1);
  }, t => reports.push(t));
  const b = traceContentRead("metadata", "game", async () => {
    recordContentPoolState({ total: 2, idle: 1, waiting: 0 });
    return measureContentRead("service", () => 2);
  }, t => reports.push(t));
  assert.equal(await b, 2); release(); assert.equal(await a, 1);
  assert.deepEqual(reports.find(t => t.kind === "game")!.phases.map(p => p.phase), ["service"]);
  assert.deepEqual(reports.find(t => t.kind === "movie")!.phases.map(p => p.phase), ["database-roundtrip", "dto-projection"]);
  assert.equal(reports.find(t => t.kind === "game")!.pool!.first.idle, 1);
  assert.equal(reports.find(t => t.kind === "movie")!.pool!.first.total, 0);
  assert.equal(contentReadTimingActive(), false);
});

test("outside an opted-in read the original pool query path remains unchanged", async () => {
  let queries = 0, checkouts = 0;
  const pool = { query: async () => { queries++; return { rows: [1] }; },
    get totalCount() { throw Error("unexpected-pool-observation"); },
    connect: async () => { checkouts++; throw Error("unexpected-checkout"); } } as unknown as Pool;
  assert.deepEqual((await traceContentRead("catalogue", "course", () => sqlExecutor(pool).query("SELECT 1"))).rows, [1]);
  assert.equal(queries, 1); assert.equal(checkouts, 0);
});

test("catalogue diagnostics retain checkout state and a valid region without logging SQL or returned courses", async () => {
  const region = process.env.VERCEL_REGION;
  try {
    process.env.VERCEL_REGION = "sin1";
    const reports: ContentReadTiming[] = [];
    let checkouts = 0, released = 0;
    const pool = { get totalCount() { return checkouts ? 2 : 0; }, idleCount: 0,
      get waitingCount() { return checkouts ? 1 : 0; },
      connect: async () => { checkouts++; return Object.assign(new EventEmitter(), {
        query: async () => ({ rows: ["private-course-fixture"] }), release: () => { released++; },
      }); },
    } as unknown as Pool;
    const result = await traceContentRead("catalogue", "course", async () => {
      const db = sqlExecutor(pool);
      await db.query("private-sql-fixture", ["private-param-fixture"]);
      return db.query("private-sql-fixture", ["private-param-fixture"]);
    }, timing => reports.push(timing));
    assert.deepEqual(result.rows, ["private-course-fixture"]);
    assert.equal(released, 2);
    assert.equal(reports[0].operation, "catalogue");
    assert.equal(reports[0].region, "sin1");
    assert.deepEqual(reports[0].pool, { checkouts: 2, first: { total: 0, idle: 0, waiting: 0 }, maxWaiting: 1 });
    assert.deepEqual(reports[0].phases.map(p => [p.phase, p.calls]), [["database-acquire", 2], ["database-roundtrip", 2]]);
    assert.ok(!JSON.stringify(reports).includes("private-"));
  } finally { if (region === undefined) delete process.env.VERCEL_REGION; else process.env.VERCEL_REGION = region; }
});

test("diagnostics reject invalid region values and retain only fixed numeric pool fields", async () => {
  const region = process.env.VERCEL_REGION;
  try {
    process.env.VERCEL_REGION = "private-env-fixture";
    const reports: ContentReadTiming[] = [];
    await traceContentRead("catalogue", "course", async () => {
      recordContentPoolState({ total: -1, idle: 0, waiting: 0 });
      const state = { total: 1, idle: 1, waiting: 0, privateField: "private-state-fixture" };
      recordContentPoolState(state);
    }, timing => reports.push(timing));
    assert.equal(reports[0].region, undefined);
    assert.deepEqual(reports[0].pool, { checkouts: 1, first: { total: 1, idle: 1, waiting: 0 }, maxWaiting: 0 });
    assert.ok(!JSON.stringify(reports).includes("private-"));
  } finally { if (region === undefined) delete process.env.VERCEL_REGION; else process.env.VERCEL_REGION = region; }
});

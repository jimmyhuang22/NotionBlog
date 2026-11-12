import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, chmod, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { createOperatorSql, projectionSql, type ProjectionQuery } from "../scripts/operator-sql/projection.ts";
import { createProjectionCache } from "../scripts/operator-sql/cache.ts";
import { createOperatorSqlBudget, type OperatorSqlPlan } from "../scripts/operator-sql/budget.ts";
import type { SqlExecutor } from "../src/server/database/sql.ts";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const namespace = hash("fictional-operator-reader");
const now = () => Date.now();
function plan(session = "fictional-session", extra: Partial<OperatorSqlPlan> = {}): OperatorSqlPlan {
  return { version: 1, session: hash(session), stopAt: now() + 60000, maxQueries: 100,
    maxResponseBytes: 8 * 1024 ** 2, maxQueryResponseBytes: 2 * 1024 ** 2, ...extra };
}
async function environment() {
  const directory = await mkdtemp(join(tmpdir(), "operator-egress-"));
  const db = await PGlite.create();
  await db.exec(`CREATE TABLE sample (ordinal integer PRIMARY KEY,body jsonb,run_id text,revision text,denied boolean DEFAULT false);
    CREATE TABLE calls(n integer); INSERT INTO calls VALUES(0);
    CREATE FUNCTION read_sample() RETURNS TABLE(ordinal integer,result jsonb) LANGUAGE plpgsql AS $$ BEGIN
      UPDATE calls SET n=n+1;
      RETURN QUERY SELECT s.ordinal,CASE WHEN s.denied THEN NULL ELSE s.body||jsonb_build_object('runId',s.run_id,'revision',s.revision) END
        FROM sample s ORDER BY s.ordinal; END $$;`);
  const text = "SELECT result FROM read_sample()";
  let queries = 0;
  const raw: SqlExecutor = { query: async <T>(sql: string, values?: unknown[]) => { queries++; return db.query<T>(sql, values); } };
  const cache = await createProjectionCache(join(directory, "cache"), { maxBytes: 4 * 1024 ** 2, maxEntryBytes: 2 * 1024 ** 2, maxEntries: 20 });
  const budget = await createOperatorSqlBudget(join(directory, "budget"), plan());
  const open = (spec: ProjectionQuery = { shape: "result", cache: true }, sql = text, responseBudget = budget) =>
    createOperatorSql({ db: raw, queries: new Map([[sql, spec]]), cache, budget: responseBudget, namespace });
  return { db, directory, text, raw, cache, budget, open, queries: () => queries,
    close: async () => { await db.close(); await rm(directory, { recursive: true, force: true }); } };
}

test("unchanged qualified bytes reuse SSD data but re-execute SQL and return current generation", async () => {
  const f = await environment();
  try {
    const body = { text: "Fictional 中文 😀 ".repeat(18000), links: ["/study/demo"], mediaIds: ["fictional-image"] };
    await f.db.query("INSERT INTO sample VALUES(0,$1::jsonb,'first','1',false)", [JSON.stringify(body)]);
    const a = f.open(), first = await a.query(f.text);
    assert.equal(a.statistics().misses, 1);
    await f.db.query("UPDATE sample SET run_id='second',revision='2'");
    const second = await a.query<{ result: typeof body & { runId: string; revision: string } }>(f.text);
    assert.deepEqual(second.rows[0].result, { ...body, runId: "second", revision: "2" });
    assert.deepEqual((first.rows[0] as { result: object }).result, { ...body, runId: "first", revision: "1" });
    assert.equal(a.statistics().hits, 1);
    assert.equal((await f.db.query<{ n: number }>("SELECT n FROM calls")).rows[0].n, 2);
    const coldBytes = a.statistics().responseBytes;
    const b = f.open(); await b.query(f.text); // A new operator process/session object can use the same SSD bytes.
    assert.equal(b.statistics().hits, 1);
    assert.ok(b.statistics().responseBytes < coldBytes / 100);
  } finally { await f.close(); }
});

test("withdrawal, content changes and current reference sets cannot reuse old eligible data", async () => {
  const f = await environment();
  try {
    await f.db.query("INSERT INTO sample VALUES(0,$1::jsonb,'r','1',false)", [JSON.stringify({ text: "old", links: ["/old"], mediaIds: ["old-image"] })]);
    const a = f.open(); await a.query(f.text);
    await f.db.query("UPDATE sample SET body=$1::jsonb", [JSON.stringify({ text: "new", links: [], mediaIds: [] })]);
    assert.deepEqual((await a.query(f.text)).rows, [{ result: { text: "new", links: [], mediaIds: [], runId: "r", revision: "1" } }]);
    await f.db.exec("UPDATE sample SET denied=true");
    assert.deepEqual((await a.query(f.text)).rows, [{ result: null }]);
    await a.query(f.text); assert.equal(a.statistics().hits, 1); // A current, confirmed null is reusable; old content is not.
  } finally { await f.close(); }
});

test("ordinal projection preserves nulls, order and independently fresh generations", async () => {
  const f = await environment();
  try {
    await f.db.exec(`INSERT INTO sample VALUES (0,'{"name":"one"}','r1','1',false),(1,'{"name":"two"}','r1','1',true)`);
    const sql = "SELECT ordinal,result FROM read_sample() ORDER BY ordinal", a = f.open({ shape: "ordinal-result", cache: true }, sql);
    await a.query(sql); await f.db.exec("UPDATE sample SET run_id='r2',revision='3'");
    assert.deepEqual((await a.query(sql)).rows, [{ ordinal: 0, result: { name: "one", runId: "r2", revision: "3" } }, { ordinal: 1, result: null }]);
    assert.equal(a.statistics().hits, 1);
    const invalid = "SELECT 7 AS ordinal,result FROM read_sample()", b = f.open({ shape: "ordinal-result", cache: true }, invalid);
    await assert.rejects(b.query(invalid), /OPERATOR_SQL_ROWS_INVALID/);
  } finally { await f.close(); }
});

test("generation lookup exclusions never change SQL arguments or permit stale payloads", async () => {
  const f = await environment();
  try {
    const sql = "SELECT jsonb_build_object('runId',$1::text,'text',$2::text) AS result";
    const a = f.open({ shape: "result", cache: true, generationParameters: [0] }, sql);
    await a.query(sql, ["first", "same"]);
    assert.deepEqual((await a.query(sql, ["second", "same"])).rows, [{ result: { runId: "second", text: "same" } }]);
    await a.query(sql, ["third", "different"]);
    assert.equal(a.statistics().hits, 1); assert.equal(a.statistics().misses, 2);
    await assert.rejects(a.query("SELECT private_data"), /NOT_ALLOWED/);
    await assert.rejects(a.query(sql, []), /GENERATION_PARAMETER_INVALID/);
  } finally { await f.close(); }
});

test("server suppresses an oversized body before transfer and exhausts the same durable session", async () => {
  const f = await environment();
  try {
    await f.db.query("INSERT INTO sample VALUES(0,$1::jsonb,'r','1',false)", [JSON.stringify({ text: "x".repeat(100000) })]);
    const fixed = plan("small", { maxResponseBytes: 4096, maxQueryResponseBytes: 1024 });
    const b = await createOperatorSqlBudget(join(f.directory, "small-budget"), fixed), a = f.open(undefined, f.text, b);
    await assert.rejects(a.query(f.text), /SQL_RESPONSE_LIMIT/);
    const state = await b.statistics(); assert.equal(state.receivedBytes, 512); assert.equal(state.queries, 1); assert.ok(state.stopped);
    const reopened = await createOperatorSqlBudget(join(f.directory, "small-budget"), fixed);
    await assert.rejects(reopened.reserve(), /BUDGET_STOPPED/);
    const envelope = await f.db.query<{ payload: null; generations: null; response_bytes: number }>(projectionSql(f.text, 0, { shape: "result", cache: true }), [null, 1024]);
    assert.equal(envelope.rows[0].payload, null); assert.equal(envelope.rows[0].generations, null); assert.equal(envelope.rows[0].response_bytes, 512);
  } finally { await f.close(); }
});

test("unknown query outcome consumes its reservation, stops later SQL and cannot be reset", async () => {
  const directory = await mkdtemp(join(tmpdir(), "operator-egress-failure-"));
  try {
    const fixed = plan("unknown", { maxResponseBytes: 8192, maxQueryResponseBytes: 4096 });
    const budget = await createOperatorSqlBudget(join(directory, "budget"), fixed);
    const cache = await createProjectionCache(join(directory, "cache"), { maxBytes: 4096, maxEntries: 2, maxEntryBytes: 2048 });
    let calls = 0;
    const sql = "SELECT '{}'::jsonb AS result", db: SqlExecutor = { query: async () => { calls++; throw Error("unknown outcome"); } };
    const a = createOperatorSql({ db, queries: new Map([[sql, { shape: "result", cache: true }]]), budget, cache, namespace });
    await assert.rejects(a.query(sql), /unknown outcome/); await assert.rejects(a.query(sql), /BUDGET_STOPPED/);
    assert.equal(calls, 1); assert.equal((await budget.statistics()).receivedBytes, 4096);
    await assert.rejects(createOperatorSqlBudget(join(directory, "budget"), { ...fixed, maxResponseBytes: 16384 }), /LEDGER_INVALID/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("shared reservations serialize callers, enforce the aggregate cap and retain abandoned allowances", async () => {
  const directory = await mkdtemp(join(tmpdir(), "operator-egress-budget-")); let clock = now();
  try {
    const fixed = plan("shared", { maxResponseBytes: 8192, maxQueryResponseBytes: 4096 });
    const a = await createOperatorSqlBudget(join(directory, "budget"), fixed, () => clock), b = await createOperatorSqlBudget(join(directory, "budget"), fixed, () => clock);
    const [one, two] = await Promise.all([a.reserve(), b.reserve()]);
    assert.equal((await a.statistics()).reservedBytes, 8192);
    await Promise.all([a.settle(one, 512), b.settle(two, 512)]);
    assert.equal((await b.statistics()).receivedBytes, 1024);
    const pending = await a.reserve(); clock += 60001;
    await assert.rejects(b.reserve(), /BUDGET_STOPPED/);
    assert.equal((await a.statistics()).reservedBytes, pending.bytes);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("corrupt cache, links and broad file modes fail before cloud access; cache storage remains bounded", async () => {
  const f = await environment();
  try {
    await f.db.exec("INSERT INTO sample VALUES(0,'{}','r','1',false)"); const a = f.open(); await a.query(f.text);
    const folder = join(f.directory, "cache"), files = await readdir(folder), path = join(folder, files[0]);
    await writeFile(path, JSON.stringify({ digest: hash("wrong"), payload: "[]" }));
    const before = f.queries(); await assert.rejects(a.query(f.text), /CACHE_CORRUPT/); assert.equal(f.queries(), before);
    await rm(path); await symlink(join(f.directory, "budget/state.json"), path);
    await assert.rejects(a.query(f.text)); assert.equal(f.queries(), before);
    await rm(path); await chmod(folder, 0o755);
    await assert.rejects(createProjectionCache(folder, { maxBytes: 1024, maxEntries: 1, maxEntryBytes: 512 }), /DIRECTORY_INVALID/);
    await chmod(folder, 0o700);
    const small = await createProjectionCache(join(f.directory, "small-cache"), { maxBytes: 1024, maxEntries: 1, maxEntryBytes: 512 });
    for (const text of ["[]", '[{"result":null}]']) await small.put(hash(text), { digest: hash(text), payload: text });
    assert.equal((await readdir(join(f.directory, "small-cache"))).length, 1);
    assert.equal(await small.get(hash("[]")), null);
  } finally { await f.close(); }
});

test("uncached registered statements execute once and retain their actual result", async () => {
  const f = await environment();
  try {
    const sql = "SELECT n AS ordinal,jsonb_build_object('count',n) AS result FROM (UPDATE calls SET n=n+1 RETURNING n) x";
    assert.throws(() => projectionSql(sql + "; SELECT 1", 0, { shape: "result", cache: false }), /SPEC_INVALID/);
    await f.db.exec(`CREATE FUNCTION bump_counter() RETURNS jsonb LANGUAGE plpgsql AS $$
      DECLARE value integer; BEGIN UPDATE calls SET n=n+1 RETURNING n INTO value;
      RETURN jsonb_build_object('count',value); END $$;`);
    const write = "SELECT bump_counter() AS result";
    const a = f.open({ shape: "result", cache: false }, write);
    assert.deepEqual((await a.query(write)).rows, [{ result: { count: 1 } }]);
    assert.deepEqual((await a.query(write)).rows, [{ result: { count: 2 } }]);
    assert.equal(a.statistics().hits, 0);
  } finally { await f.close(); }
});

test("caller mutations cannot increase a durable plan or change an in-flight query allowlist", async () => {
  const f = await environment();
  try {
    const fixed = plan("immutable", { maxQueries: 1, maxResponseBytes: 2048, maxQueryResponseBytes: 1024 });
    const budget = await createOperatorSqlBudget(join(f.directory, "immutable"), fixed);
    const sql = "SELECT jsonb_build_object('runId',NULL,'revision',1,'text','sample') AS result";
    const descriptor: ProjectionQuery = { shape: "result", cache: false };
    const allowed = new Map([[sql, descriptor]]);
    const a = createOperatorSql({ db: f.raw, queries: allowed, cache: f.cache, budget, namespace });
    fixed.maxQueries = 100; fixed.maxResponseBytes = 100000; descriptor.cache = true; allowed.clear();
    assert.deepEqual((await a.query(sql)).rows, [{ result: { runId: null, revision: 1, text: "sample" } }]);
    await assert.rejects(a.query(sql), /BUDGET_STOPPED/);
    assert.equal(a.statistics().hits, 0); assert.equal(f.queries(), 1);
  } finally { await f.close(); }
});

test("missing ledger and reopening an unsettled query never recreate a fresh allowance", async () => {
  const directory = await mkdtemp(join(tmpdir(), "operator-egress-reopen-"));
  try {
    const fixed = plan("reopen"), path = join(directory, "budget");
    const a = await createOperatorSqlBudget(path, fixed); await a.reserve();
    const b = await createOperatorSqlBudget(path, fixed);
    await assert.rejects(b.reserve(), /BUDGET_STOPPED/); assert.ok((await b.statistics()).reservedBytes > 0);
    await rm(join(path, "state.json"));
    await assert.rejects(createOperatorSqlBudget(path, fixed), /LEDGER_MISSING/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("reference sets normalize order only; record order, membership and malformed evidence remain significant", async () => {
  const f = await environment();
  try {
    const body = { records: [{ text: "one" }, { text: "two" }], links: ["/z", "/a"], mediaIds: ["image-z", "image-a"] };
    await f.db.query("INSERT INTO sample VALUES(0,$1::jsonb,'r','1',false)", [JSON.stringify(body)]);
    const a = f.open({ shape: "result", cache: true, canonicalReferenceSets: true });
    const first = await a.query(f.text);
    const reordered = { ...body, links: [...body.links].reverse(), mediaIds: [...body.mediaIds].reverse() };
    await f.db.query("UPDATE sample SET body=$1::jsonb", [JSON.stringify(reordered)]);
    assert.deepEqual((await a.query(f.text)).rows, first.rows);
    assert.equal(a.statistics().hits, 1);
    for (const next of [
      { ...body, records: [...body.records].reverse() },
      { ...body, links: ["/a"] },
      { ...body, mediaIds: ["image-a"] },
    ]) {
      const misses = a.statistics().misses;
      await f.db.query("UPDATE sample SET body=$1::jsonb", [JSON.stringify(next)]);
      await a.query(f.text); assert.equal(a.statistics().misses, misses + 1);
    }
    assert.equal((await f.db.query<{ n: number }>("SELECT n FROM calls")).rows[0].n, 5);
    await f.db.query("UPDATE sample SET body=$1::jsonb", [JSON.stringify({ ...body, mediaIds: [null] })]);
    await assert.rejects(a.query(f.text), /ROWS_INVALID/);
    assert.ok((await f.budget.statistics()).stopped);
    // A missing key yields SQL NULL; bool_and must not treat it as valid.
    await f.db.query("UPDATE sample SET body=$1::jsonb", [JSON.stringify({ records: [], links: [] })]);
    const invalid = await f.db.query<{ status: string; payload: null }>(projectionSql(f.text, 0,
      { shape: "result", cache: true, canonicalReferenceSets: true }), [null, 1024]);
    assert.equal(invalid.rows[0].status, "INVALID_ROWS"); assert.equal(invalid.rows[0].payload, null);
  } finally { await f.close(); }
});

test("fresh thumbnail state does not retransmit unchanged source and never hides source changes or withdrawal", async () => {
  const f = await environment();
  try {
    const body = { source: { fingerprint: "source-a", description: "Fictional ".repeat(5000) }, thumbnail: null as null | object };
    await f.db.query("INSERT INTO sample VALUES(0,$1::jsonb,'r','1',false)", [JSON.stringify(body)]);
    const a = f.open({ shape: "result", cache: true, freshThumbnail: true });
    await a.query(f.text); const cold = a.statistics().responseBytes;
    const present = { ...body, thumbnail: { sha256: "a".repeat(64), width: 400 } };
    await f.db.query("UPDATE sample SET body=$1::jsonb,run_id='new',revision='2'", [JSON.stringify(present)]);
    assert.deepEqual((await a.query(f.text)).rows, [{ result: { ...present, runId: "new", revision: "2" } }]);
    assert.equal(a.statistics().hits, 1);
    assert.ok(a.statistics().responseBytes - cold < cold / 20);
    await f.db.query("UPDATE sample SET body=$1::jsonb", [JSON.stringify(body)]);
    assert.deepEqual((await a.query(f.text)).rows, [{ result: { ...body, runId: "new", revision: "2" } }]);
    assert.equal(a.statistics().hits, 2);
    await f.db.query("UPDATE sample SET body=$1::jsonb", [JSON.stringify({ ...body, source: { ...body.source, fingerprint: "source-b" } })]);
    await a.query(f.text); assert.equal(a.statistics().misses, 2);
    await f.db.exec("UPDATE sample SET denied=true");
    assert.deepEqual((await a.query(f.text)).rows, [{ result: null }]);
  } finally { await f.close(); }
});

test("fresh evidence is budgeted before transfer and cannot be enabled on uncached writes", async () => {
  assert.throws(() => projectionSql("SELECT '{}'::jsonb AS result", 0,
    { shape: "result", cache: false, freshThumbnail: true }), /SPEC_INVALID/);
  assert.throws(() => projectionSql("SELECT '{}'::jsonb AS result", 0,
    { shape: "ordinal-result", cache: true, canonicalReferenceSets: true }), /SPEC_INVALID/);
  const f = await environment();
  try {
    await f.db.query("INSERT INTO sample VALUES(0,$1::jsonb,'r','1',false)", [JSON.stringify({ source: "same", thumbnail: null })]);
    const fixed = plan("fresh-cap", { maxResponseBytes: 8192, maxQueryResponseBytes: 2048 });
    const budget = await createOperatorSqlBudget(join(f.directory, "fresh-budget"), fixed);
    const a = f.open({ shape: "result", cache: true, freshThumbnail: true }, f.text, budget);
    await a.query(f.text);
    await f.db.query("UPDATE sample SET body=$1::jsonb", [JSON.stringify({ source: "same", thumbnail: { text: "x".repeat(10000) } })]);
    await assert.rejects(a.query(f.text), /SQL_RESPONSE_LIMIT/);
    assert.ok((await budget.statistics()).stopped);
    assert.equal(a.statistics().hits, 0);
  } finally { await f.close(); }
});

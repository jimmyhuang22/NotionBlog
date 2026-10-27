import test, { after } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { SearchResultBudget, searchResultBudget, SEARCH_RESULT_TEXT_BYTES } from "../src/server/database/result-response-budget.ts";
import { callSql } from "../src/server/database/sql.ts";
import { scopedReader, SCOPED_SEARCH_SQL, SCOPED_FILTERED_SCOPE_SEARCH_SQL, SCOPED_VERSION_SQL } from "../src/server/database/scoped-reads.ts";

const db = new PGlite();
after(() => db.close());
await db.exec(`CREATE SCHEMA nb_read_api;
  CREATE SEQUENCE fixture_seen;
  CREATE FUNCTION nb_read_api.check_capability(text) RETURNS boolean LANGUAGE SQL AS 'SELECT true';
  CREATE FUNCTION nb_read_api.check_search_parts(text) RETURNS boolean LANGUAGE SQL AS 'SELECT true';
  CREATE FUNCTION nb_read_api.check_search_walk(text) RETURNS boolean LANGUAGE SQL AS 'SELECT true';
  CREATE FUNCTION nb_read_api.check_search_filtered_scope(text) RETURNS boolean LANGUAGE SQL AS 'SELECT true';
  CREATE FUNCTION nb_read_api.read_search_parts(mode text, v text[]) RETURNS jsonb LANGUAGE plpgsql VOLATILE AS $$
    BEGIN PERFORM nextval('fixture_seen');
      IF v[1]='SQL_NULL' THEN RETURN NULL; END IF;
      RETURN v[1]::jsonb; END $$;
  CREATE FUNCTION nb_read_api.read_search_filtered_scope(mode text,v text[],p text[]) RETURNS jsonb LANGUAGE SQL AS $$ SELECT nb_read_api.read_search_parts(mode,v) $$;
  CREATE FUNCTION nb_read_api.read_version(text) RETURNS jsonb LANGUAGE SQL AS $$ SELECT '{"revision":1}'::jsonb $$;`);
const parts = "SELECT nb_read_api.read_search_parts('qualified',$1::text[]) AS result";
const query = async (budget: SearchResultBudget, text: string, values: unknown[] = []) => {
  const plan = budget.prepare(text, values);
  try { return plan.accept((await db.query(plan.text, plan.values)).rows); }
  catch (error) { plan.fail(); throw error; }
};
const mode = { CONTENT_PROVIDER: "database", DATABASE_CONTENT_VERSION: "2", DATABASE_READ_PROJECTION: "scoped", DATABASE_PUBLICATION_MODE: "qualified", DATABASE_SEARCH_CONTEXT: "off" };

test("search result budget is off by default and rejects unsupported opt-in combinations", () => {
  for (const value of [undefined, "", "off"]) assert.equal(searchResultBudget({ DATABASE_SEARCH_RESULT_BUDGET: value }), undefined);
  for (const projection of ["on-demand", "filtered-scope"]) assert.ok(searchResultBudget({ ...mode, DATABASE_SEARCH_PROJECTION: projection, DATABASE_SEARCH_RESULT_BUDGET: "bounded-v1" }));
  for (const change of [{ CONTENT_PROVIDER: "mock" }, { DATABASE_CONTENT_VERSION: "1" }, { DATABASE_READ_PROJECTION: "legacy" },
    { DATABASE_PUBLICATION_MODE: "published" }, { DATABASE_SEARCH_CONTEXT: "on" }, { DATABASE_SEARCH_PROJECTION: "filtered" }, { DATABASE_SEARCH_RESULT_BUDGET: "true" }]) {
    assert.throws(() => searchResultBudget({ ...mode, DATABASE_SEARCH_RESULT_BUDGET: "bounded-v1", ...change }), { code: "MISCONFIGURED" });
  }
});

test("actual scoped readiness/search/version SQL stays compatible in both opt-in modes", async () => {
  for (const projection of ["on-demand", "filtered-scope"] as const) {
    const budget = new SearchResultBudget();
    const raw = { query: async <T>(text: string, values?: unknown[]) => ({ rows: await query(budget, text, values) as T[] }) };
    const scoped = scopedReader(raw, "qualified", projection);
    const sql = projection === "on-demand" ? SCOPED_SEARCH_SQL : SCOPED_FILTERED_SCOPE_SEARCH_SQL;
    const value = { text: "虚构'; harmless;", items: [2, 1], cursor: null };
    assert.deepEqual(await callSql(scoped, sql, projection === "on-demand" ? [[JSON.stringify(value)]] : [[JSON.stringify(value)], ["fixture"]]), value);
    assert.deepEqual(await callSql(scoped, SCOPED_VERSION_SQL, []), { revision: 1 });
    assert.equal(budget.snapshot().statements, 3);
    assert.equal(budget.snapshot().failed, false);
  }
});

test("JSONB scalars and SQL NULL retain values and charge the SQL result text size", async () => {
  for (const value of [null, true, false, 0, "null", "漢字😀\"\\\n", ["漢字", 1]]) {
    const budget = new SearchResultBudget();
    const rows = await query(budget, parts, [[JSON.stringify(value)]]);
    assert.deepEqual(rows, [{ result: value }]);
    assert.ok(budget.snapshot().resultTextBytes > 0);
  }
  const budget = new SearchResultBudget();
  assert.deepEqual(await query(budget, parts, [["SQL_NULL"]]), [{ result: null }]);
  assert.equal(budget.snapshot().resultTextBytes, 0);
});

test("guarded transport is serialized text with the same bytes as the original JSONB output", async () => {
  const value = { text: "漢字😀\"\\\n", items: [null, false, { id: "fixture" }] };
  const input = [[JSON.stringify(value)]];
  const original = await db.query<{ text: string }>(`SELECT result::text AS text FROM (${parts}) AS raw`, input);
  const text = original.rows[0].text, bytes = Buffer.byteLength(text, "utf8");
  await db.exec("ALTER SEQUENCE fixture_seen RESTART WITH 1");
  const budget = new SearchResultBudget(bytes), plan = budget.prepare(parts, input);
  const rows = (await db.query(plan.text, plan.values)).rows;
  assert.deepEqual(rows, [{ result: text, __nb_result_text_bytes: bytes }]);
  assert.deepEqual(plan.accept(rows), [{ result: value }]);
  assert.equal(budget.snapshot().resultTextBytes, bytes);
  assert.equal((await db.query<{ last_value: number }>("SELECT last_value FROM fixture_seen")).rows[0].last_value, 1);
});

test("invalid JSON transport, byte mismatches and null mismatches fail safely and stay failed", () => {
  for (const [result, size] of [["PRIVATE_SENTINEL", 16], ["\"漢字\"", 4], ["null", null], [null, 4], [true, 4], ["", 0]]) {
    const budget = new SearchResultBudget(), plan = budget.prepare(parts, [[]]);
    assert.throws(() => plan.accept([{ result, __nb_result_text_bytes: size }]), error => {
      assert.equal((error as { code: string }).code, "CONTENT_UNAVAILABLE");
      assert.ok(!String(error).includes("PRIVATE_SENTINEL"));
      return true;
    });
    assert.equal(budget.snapshot().resultTextBytes, 0);
    assert.equal(budget.snapshot().failed, true);
    assert.throws(() => budget.prepare(parts, [[]]), { code: "CONTENT_UNAVAILABLE" });
  }
});

test("oversized result never appears in the actual SQL response and source evaluates once", async () => {
  await db.exec("ALTER SEQUENCE fixture_seen RESTART WITH 1");
  const budget = new SearchResultBudget(32), plan = budget.prepare(parts, [[JSON.stringify({ text: "x".repeat(1000) })]]);
  const rows = (await db.query<{ result: unknown; __nb_result_text_bytes: number }>(plan.text, plan.values)).rows;
  assert.equal(rows[0].result, null); assert.ok(Number(rows[0].__nb_result_text_bytes) > 1000);
  assert.throws(() => plan.accept(rows), { code: "CONTENT_UNAVAILABLE" });
  assert.equal((await db.query<{ last_value: number }>("SELECT last_value FROM fixture_seen")).rows[0].last_value, 1);
  assert.throws(() => budget.prepare(parts), { code: "CONTENT_UNAVAILABLE" });
});

test("cumulative bytes and query count are request-local, never reset between statements", async () => {
  const budget = new SearchResultBudget(5);
  await query(budget, parts, [["1"]]); await query(budget, parts, [["22"]]);
  await assert.rejects(query(budget, parts, [["333"]]), { code: "CONTENT_UNAVAILABLE" });
  assert.equal(budget.snapshot().resultTextBytes, 3);
  const count = new SearchResultBudget(100, 1);
  await query(count, parts, [["1"]]); assert.throws(() => count.prepare(parts), { code: "CONTENT_UNAVAILABLE" });
  const other = new SearchResultBudget(); assert.equal(other.snapshot().statements, 0);
});

test("allowlist, concurrency and malformed responses fail closed without leaking fields", () => {
  assert.throws(() => new SearchResultBudget().prepare("SELECT 'private'"), { code: "CONTENT_UNAVAILABLE" });
  const budget = new SearchResultBudget(), first = budget.prepare(parts, [[]]);
  assert.throws(() => budget.prepare(parts, [[]]), { code: "CONTENT_UNAVAILABLE" });
  assert.throws(() => first.accept([{ result: 1, __nb_result_text_bytes: 1 }]), { code: "CONTENT_UNAVAILABLE" });
  for (const rows of [[], [{ __nb_result_text_bytes: 1 }], [{ result: {} }],
    [{ result: {}, __nb_result_text_bytes: NaN }], [{ result: {}, __nb_result_text_bytes: -1 }]]) {
    const plan = new SearchResultBudget().prepare(parts, [[]]); assert.throws(() => plan.accept(rows), { code: "CONTENT_UNAVAILABLE" });
  }
  assert.equal(SEARCH_RESULT_TEXT_BYTES, 13 * 1024 * 1024);
});

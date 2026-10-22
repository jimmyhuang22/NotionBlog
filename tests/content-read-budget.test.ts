import assert from "node:assert/strict";
import test from "node:test";
import { budgetedContentSql, withContentReadBudget } from "../src/server/content-read-budget.ts";
import { websiteQueryResponse } from "../src/lib/content/website-http.ts";
import type { ContentRepository } from "../contracts/repository.ts";

test("cancelled HTTP search stops before repository work without exposing private errors", async () => {
  const controller = new AbortController(); controller.abort("private-fixture");
  const response = await websiteQueryResponse(new Request("https://example.test/api/search?q=word", { signal: controller.signal }),
    { search: async () => assert.fail("No search after cancellation") } as unknown as ContentRepository, "search");
  assert.equal(response.status, 503); assert.ok(!(await response.text()).includes("private-fixture"));
});

test("one operation deadline bounds successive SQL calls rather than resetting per page", async () => {
  let now = 0, queries = 0;
  const sql = budgetedContentSql({ query: async () => { queries++; now = 11; return { rows: [] }; } });
  await assert.rejects(withContentReadBudget(new AbortController().signal, async () => {
    await sql.query("first"); await sql.query("second");
  }, { now: () => now, timeoutMs: 10 }), { code: "CONTENT_UNAVAILABLE" });
  assert.equal(queries, 1);
});

test("cancellation drains the current bounded SQL operation and prevents the continuation", async () => {
  const controller = new AbortController(); let finish!: () => void, started!: () => void, completed = false, settled = false, calls = 0;
  const began = new Promise<void>(resolve => { started = resolve; });
  const gate = new Promise<void>(resolve => { finish = resolve; });
  const sql = budgetedContentSql({ query: async () => { calls++; started(); await gate; completed = true; return { rows: [] }; } });
  const pending = withContentReadBudget(controller.signal, async () => { await sql.query("first"); await sql.query("second"); });
  const checked = assert.rejects(pending, { code: "CONTENT_UNAVAILABLE" }).then(() => { settled = true; });
  await began; controller.abort(); await Promise.resolve();
  assert.equal(settled, false); finish(); await checked;
  assert.equal(completed, true); assert.equal(calls, 1);
});

test("concurrent request budgets remain isolated and outside requests preserve SQL results", async () => {
  const a = new AbortController(), b = new AbortController(); let go!: () => void;
  const gate = new Promise<void>(resolve => { go = resolve; });
  const sql = budgetedContentSql({ query: async <T>() => ({ rows: [1] as T[] }) });
  const first = withContentReadBudget(a.signal, async () => { await gate; return sql.query("first"); });
  const checked = assert.rejects(first, { code: "CONTENT_UNAVAILABLE" });
  const second = withContentReadBudget(b.signal, async () => { await gate; return sql.query("second"); });
  a.abort(); go(); await checked; assert.deepEqual((await second).rows, [1]);
  assert.deepEqual((await sql.query("outside")).rows, [1]);
});

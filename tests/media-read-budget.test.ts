import test from "node:test";
import assert from "node:assert/strict";
import { withMediaReadBudget } from "../src/server/media/read-budget.ts";
import { contentReadBudgetIdentity, checkContentReadBudget } from "../src/server/content-read-budget.ts";

test("image cancellation stops its waiter and prevents a late object read from querying again", async () => {
  const controller = new AbortController(); let nextQuery = false, complete!: () => void;
  const held = new Promise<void>(resolve => { complete = resolve; });
  const response = withMediaReadBudget(controller.signal, async () => { await held; checkContentReadBudget(); nextQuery = true; });
  const rejected = assert.rejects(response, { code: "CONTENT_UNAVAILABLE" });
  controller.abort(); await rejected; complete(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(nextQuery, false);
});

test("nested image work preserves one request deadline and a successful read does not poison another request", async () => {
  await withMediaReadBudget(new AbortController().signal, async () => {
    const first = contentReadBudgetIdentity();
    await withMediaReadBudget(new AbortController().signal, async () => assert.equal(contentReadBudgetIdentity(), first));
  });
  assert.equal(await withMediaReadBudget(new AbortController().signal, async () => "next"), "next");
});

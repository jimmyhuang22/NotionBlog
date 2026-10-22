import test from "node:test";
import assert from "node:assert/strict";
import { withListReadBudget, LIST_READ_TIMEOUT_MS } from "../src/server/list-read-budget.ts";
import { contentReadBudgetIdentity, budgetedContentSql } from "../src/server/content-read-budget.ts";
import { socialTimelineWorksResponse } from "../src/lib/content/social-http.ts";
import { homeFeedResponse } from "../src/lib/content/home-feed-http.ts";
import type { SocialTimelineRepository } from "../contracts/social-timeline.ts";
import type { HomeFeedRepository } from "../contracts/home-feed.ts";

test("works and homepage fail within one seven-second service window with retryable private 503", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const kind of ["works", "home-feed"] as const) {
    let started!: () => void;
    const began = new Promise<void>(resolve => { started = resolve; });
    const read = () => { started(); return new Promise<never>(() => {}); };
    const request = new Request("https://example.test/api/fixture?limit=20");
    const pending = kind === "works"
      ? socialTimelineWorksResponse(request, { listWorks: read } as SocialTimelineRepository, () => true)
      : homeFeedResponse(request, { getPage: read } as HomeFeedRepository);
    await began; t.mock.timers.tick(LIST_READ_TIMEOUT_MS);
    const response = await pending;
    assert.equal(response.status, 503); assert.equal(response.headers.get("Retry-After"), "1");
    assert.equal(response.headers.get("Cache-Control"), "private, no-store");
    assert.equal((await response.json()).error.code, "CONTENT_UNAVAILABLE");
  }
});

test("nested API/repository boundary keeps one deadline and cancels continuation after expiry", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let next!: () => void, started!: () => void, calls = 0;
  const gate = new Promise<void>(resolve => { next = resolve; });
  const began = new Promise<void>(resolve => { started = resolve; });
  const sql = budgetedContentSql({ query: async () => { calls++; return { rows: [] }; } });
  const pending = withListReadBudget("home-feed", async () => {
    const first = contentReadBudgetIdentity();
    return withListReadBudget("home-feed", async () => {
      assert.equal(contentReadBudgetIdentity(), first); started(); await gate; return sql.query("too late");
    });
  });
  const checked = assert.rejects(pending, { code: "CONTENT_UNAVAILABLE" });
  await began; t.mock.timers.tick(LIST_READ_TIMEOUT_MS); await checked;
  next(); await Promise.resolve(); await Promise.resolve(); assert.equal(calls, 0);
});

test("aborting one request does not cancel another and success keeps its DTO", async () => {
  const controller = new AbortController();
  const cancelled = withListReadBudget("works", () => new Promise<never>(() => {}), controller.signal);
  const checked = assert.rejects(cancelled, { code: "CONTENT_UNAVAILABLE" });
  const ok = withListReadBudget("works", async () => ({ items: [1], total: 1, nextCursor: null }));
  controller.abort("private reason"); await checked;
  assert.deepEqual(await ok, { items: [1], total: 1, nextCursor: null });
});

test("invalid filters remain400 and disabled works remains404 before provider work", async () => {
  const repository = { listWorks: async () => assert.fail("not called") } as SocialTimelineRepository;
  const invalid = await socialTimelineWorksResponse(new Request("https://example.test/api/works?unsupported=yes"), repository, () => true);
  assert.equal(invalid.status, 400); assert.equal(invalid.headers.get("Retry-After"), null);
  const disabled = await socialTimelineWorksResponse(new Request("https://example.test/api/works"), repository, () => false);
  assert.equal(disabled.status, 404);
});

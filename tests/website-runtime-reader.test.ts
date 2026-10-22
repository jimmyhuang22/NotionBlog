import assert from "node:assert/strict";
import test from "node:test";
import { createRuntimeNotionReader } from "../scripts/website-sync/runtime-reader.ts";
import { NotionRequestScheduler } from "../src/server/notion/request-scheduler.ts";
const id = "11111111-1111-4111-8111-111111111111";
const page = () => new Response(JSON.stringify({ object: "page", id, url: "https://example.test/page", parent: { type: "workspace", workspace: true } }), { status: 200 });
const flush = async () => { for (let i = 0; i < 80; i++) await Promise.resolve(); };
const limited = (status: number, seconds: number) => new Response(JSON.stringify({ object: "error", status, code: status === 429 ? "rate_limited" : "service_overload", message: "fixture-private-message" }), { status, headers: { "Retry-After": String(seconds) } });
for (const configured of [undefined, 400]) test(`runtime explicitly spaces starts at ${configured ?? 700}ms and reports method attempts`, async context => {
  context.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
  const starts: number[] = [], interval = configured ?? 700;
  const reader = createRuntimeNotionReader({ token: "fixture-only" }, new AbortController().signal, {
    intervalMs: configured, fetch: async () => { starts.push(Date.now()); return page(); },
  });
  const pending = Promise.all([reader.client.getPage(id), reader.client.getPage(id), reader.client.getPage(id)]);
  await flush(); context.mock.timers.tick(interval - 1); await flush(); assert.deepEqual(starts, [0]);
  context.mock.timers.tick(1); await flush(); context.mock.timers.tick(interval); await flush(); await pending;
  assert.deepEqual(starts, [0, interval, interval * 2]);
  const observed = reader.statistics(); assert.equal(observed.intervalMs, interval); assert.deepEqual(observed.attemptsByMethod, { getPage: 3 });
  observed.attemptsByMethod.getPage = 100; assert.equal(reader.statistics().attemptsByMethod.getPage, 3);
});
test("runtime rejects unsafe pacing before making requests", () => {
  for (const intervalMs of [0, 349, 5001, 400.5, NaN]) assert.throws(() => createRuntimeNotionReader({ token: "fixture-only" }, new AbortController().signal,
    { intervalMs, fetch: async () => assert.fail("Invalid pacing must not send") }), (e: {code?: string}) => e.code === "MISCONFIGURED");
});
for (const status of [429, 529]) test(`runtime reader retains the current operation through a ninety-second ${status} cooldown`, async context => {
  context.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
  const starts: number[] = [];
  const reader = createRuntimeNotionReader({ token: "fixture-only" }, new AbortController().signal, {
    fetch: async () => { starts.push(Date.now()); return starts.length === 1 ? limited(status, 90) : page(); },
  });
  const pending = reader.client.getPage(id);
  await flush();
  context.mock.timers.tick(60_000); await flush();
  context.mock.timers.tick(29_999); await flush();
  assert.deepEqual(starts, [0]);
  context.mock.timers.tick(1); await flush();
  assert.equal((await pending)?.id, id);
  assert.deepEqual(starts, [0, 90_000]);
  assert.equal(reader.statistics().rateLimitResponses, 1);
  assert.equal(reader.statistics().lastRetryAfterSeconds, 90);
});
test("runtime cancellation during cooldown prevents a later request after the window expires", async context => {
  context.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
  const controller = new AbortController(); let calls = 0;
  const reader = createRuntimeNotionReader({ token: "fixture-only" }, controller.signal, { fetch: async () => { calls++; return limited(429, 90); } });
  const rejected = assert.rejects(reader.client.getPage(id));
  await flush(); context.mock.timers.tick(60_000); await flush();
  controller.abort(); await flush(); await rejected;
  context.mock.timers.tick(90_000); await flush();
  assert.equal(calls, 1);
});
test("persistent rate limits stop at the SDK retry limit without an extra runtime retry loop", async context => {
  context.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
  let calls = 0;
  const reader = createRuntimeNotionReader({ token: "fixture-only" }, new AbortController().signal, { scheduler: new NotionRequestScheduler({ intervalMs: 0 }), fetch: async () => { calls++; return limited(429, 0); } });
  const rejected = assert.rejects(reader.client.getPage(id), (error: { code?: string }) => error.code === "RATE_LIMITED");
  await flush(); context.mock.timers.tick(1); await flush(); context.mock.timers.tick(1); await flush();
  await rejected; assert.equal(calls, 3); assert.equal(reader.statistics().retries, 0);
});
test("runtime reader retries only observed transient transport failures and preserves SDK validation", async () => {
  let calls = 0; const waits: number[] = [];
  const reader = createRuntimeNotionReader({ token: "fixture-only" }, new AbortController().signal, { scheduler: new NotionRequestScheduler({ intervalMs: 0 }),
    fetch: async (url, init) => { assert.equal(new URL(String(url)).origin, "https://api.notion.com"); assert.equal(init?.redirect, "error"); if (++calls === 1) throw Object.assign(new Error("private transport details"), { code: "ECONNRESET" }); return page(); },
    wait: async ms => { waits.push(ms); } });
  assert.equal((await reader.client.getPage(id))?.id, id); assert.ok(calls <= 9); assert.equal(reader.statistics().retries, 1); assert.deepEqual(waits, [2000]);
});
test("runtime reader cancellation aborts a live fetch and does not enter another retry", async () => {
  const controller = new AbortController(); let calls = 0;
  const reader = createRuntimeNotionReader({ token: "fixture-only" }, controller.signal, { scheduler: new NotionRequestScheduler({ intervalMs: 0 }),
    fetch: async (_url, init) => { calls++; controller.abort(); throw new DOMException("cancelled", "AbortError"); }, wait: async () => assert.fail("No retry after cancellation") });
  await assert.rejects(reader.client.getPage(id)); assert.equal(reader.statistics().retries, 0); assert.ok(calls <= 3);
});
test("runtime reader rejects oversized response bodies without a transient retry", async () => {
  const reader = createRuntimeNotionReader({ token: "fixture-only" }, new AbortController().signal, { scheduler: new NotionRequestScheduler({ intervalMs: 0 }),
    fetch: async () => new Response("x".repeat(2 * 1024 * 1024 + 1)), wait: async () => assert.fail("Size rejection is not transient") });
  await assert.rejects(reader.client.getPage(id)); assert.equal(reader.statistics().retries, 0);
});

test("runtime recovers an idempotent data-source query after HTTP 500 and bounds persistent failure", async () => {
  for (const persistent of [false, true]) {
    let calls = 0; const waits: number[] = [];
    const reader = createRuntimeNotionReader({ token: "fixture-only" }, new AbortController().signal, {
      scheduler: new NotionRequestScheduler({ intervalMs: 0 }), wait: async ms => { waits.push(ms); },
      fetch: async (_url, init) => { assert.equal(init?.method, "POST"); calls++;
        return persistent || calls === 1 ? new Response(JSON.stringify({ object: "error", status: 500,
          code: "internal_server_error", message: "fixture-only" }), { status: 500 }) :
          new Response(JSON.stringify({ object: "list", results: [], has_more: false, next_cursor: null })); },
    });
    if (persistent) {
      await assert.rejects(reader.client.listPages(id));
      assert.equal(calls, 3); assert.deepEqual(waits, [2000, 5000]);
      assert.deepEqual(reader.failure(), { method: "listPages", id, attempt: 3, httpStatus: 500, networkFailure: false });
    } else { assert.deepEqual(await reader.client.listPages(id), []); assert.equal(calls, 2); assert.deepEqual(waits, [2000]); }
    assert.equal(JSON.stringify(reader.statistics()).includes(id), false);
  }
});

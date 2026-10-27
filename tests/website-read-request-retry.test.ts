import assert from "node:assert/strict";
import test from "node:test";
import { createRuntimeNotionReader } from "../scripts/website-sync/runtime-reader.ts";
import { NotionRequestScheduler } from "../src/server/notion/request-scheduler.ts";

const id = "11111111-1111-4111-8111-111111111111";
const second = "22222222-2222-4222-8222-222222222222";
const policy = { token: "example", retry: false as const, readRetry: "transient-request-v1" as const };
const scheduler = () => new NotionRequestScheduler({ intervalMs: 0 });
const error = (status: number) => JSON.stringify({ object: "error", status, code: status === 429 ? "rate_limited" :
  status === 529 ? "service_overload" : "internal_server_error", message: "fixture-only" });
const page = () => new Response(JSON.stringify({ object: "page", id, url: "https://example.test/page", parent: { type: "workspace", workspace: true } }));
const block = (id: string) => ({ object: "block", id, type: "paragraph", paragraph: { rich_text: [] } });

test("502 retries only the failed block-list page, retaining earlier pages and byte accounting", async () => {
  const cursors: (string | null)[] = [], waits: number[] = []; let bytes = 0;
  const reader = createRuntimeNotionReader(policy, new AbortController().signal, {
    scheduler: scheduler(), wait: async ms => { waits.push(ms); }, fetch: async (url, init) => {
      assert.equal(init?.method, "GET"); assert.equal(init?.redirect, "error");
      const cursor = new URL(String(url)).searchParams.get("start_cursor"); cursors.push(cursor);
      const text = cursors.length === 2 ? error(502) : JSON.stringify({ object: "list", results: [block(cursor ? second : id)],
        has_more: !cursor, next_cursor: cursor ? null : "next-page" });
      bytes += Buffer.byteLength(text); return new Response(text, { status: cursors.length === 2 ? 502 : 200 });
    },
  });
  assert.deepEqual((await reader.client.listBlocks(id)).map(b => b.id), [id, second]);
  assert.deepEqual(cursors, [null, "next-page", "next-page"]); assert.deepEqual(waits, [2000]);
  assert.equal(reader.statistics().requests, 3); assert.equal(reader.statistics().retries, 1);
  assert.equal(reader.statistics().receivedBodyBytes, bytes);
});

test("read-only POST query retries the identical cursor/body and snapshots headers", async () => {
  const bodies: string[] = [], auth: (string | null)[] = [];
  const reader = createRuntimeNotionReader(policy, new AbortController().signal, {
    scheduler: scheduler(), wait: async () => {}, fetch: async (url, init) => {
      assert.equal(init?.method, "POST"); assert(new URL(String(url)).pathname.endsWith("/query"));
      bodies.push(String(init?.body)); const headers = new Headers(init?.headers); auth.push(headers.get("authorization"));
      if (bodies.length === 2) {
        (init!.headers as Headers).set("authorization", "fixture-only");
        return new Response(error(502), { status: 502 });
      }
      return new Response(JSON.stringify({ object: "list", results: [], has_more: bodies.length === 1,
        next_cursor: bodies.length === 1 ? "next-page" : null }));
    },
  });
  assert.deepEqual(await reader.client.listPages(id), []);
  assert.equal(bodies.length, 3); assert.equal(bodies[1], bodies[2]);
  assert.equal(JSON.parse(bodies[0]).start_cursor, undefined); assert.equal(JSON.parse(bodies[1]).start_cursor, "next-page");
  assert(auth.every(value => value === auth[0])); assert.equal(reader.statistics().retries, 1);
});

for (const status of [500, 502, 503, 504]) test(`persistent ${status} stops at three wire attempts without nested SDK retries`, async () => {
  let calls = 0; const waits: number[] = [];
  const reader = createRuntimeNotionReader(policy, new AbortController().signal, { scheduler: scheduler(),
    wait: async ms => { waits.push(ms); }, fetch: async () => { calls++; return new Response(error(status), { status }); } });
  await assert.rejects(reader.client.getPage(id)); assert.equal(calls, 3); assert.deepEqual(waits, [2000, 5000]);
  assert.equal(reader.statistics().retries, 2); assert.equal(reader.failure()?.attempt, 3); assert.equal(reader.failure()?.httpStatus, status);
});

for (const status of [400, 401, 403, 404, 429, 529, 501]) test(`HTTP ${status} does not enter the transient-read retry path`, async () => {
  let calls = 0;
  const reader = createRuntimeNotionReader(policy, new AbortController().signal, { scheduler: scheduler(),
    wait: async () => assert.fail("No retry for this status"), fetch: async () => { calls++; return new Response(error(status), { status }); } });
  await assert.rejects(reader.client.getDataSource(id)); assert.equal(calls, 1); assert.equal(reader.statistics().retries, 0);
});

test("a failed read transport is retried once and every attempt remains observed", async () => {
  let calls = 0;
  const reader = createRuntimeNotionReader(policy, new AbortController().signal, { scheduler: scheduler(), wait: async () => {},
    fetch: async () => { if (++calls === 1) throw Object.assign(new Error("fixture-only"), { code: "ECONNRESET" }); return page(); } });
  assert.equal((await reader.client.getPage(id))?.id, id); assert.equal(calls, 2);
  assert.equal(reader.statistics().requests, 2); assert.equal(reader.statistics().retries, 1);
});

test("run cancellation during backoff stops before another request and never counts an unsent retry", async () => {
  const controller = new AbortController(); let calls = 0;
  const reader = createRuntimeNotionReader(policy, controller.signal, { scheduler: scheduler(),
    wait: async (_ms, signal) => { assert.equal(signal, controller.signal); controller.abort(); },
    fetch: async () => { calls++; return new Response(error(502), { status: 502 }); } });
  await assert.rejects(reader.client.getPage(id)); assert.equal(calls, 1); assert.equal(reader.statistics().retries, 0);
});

test("cancellation of an in-flight read is terminal even when the error resembles a timeout", async () => {
  const controller = new AbortController(); let calls = 0;
  const reader = createRuntimeNotionReader(policy, controller.signal, { scheduler: scheduler(), wait: async () => assert.fail("No retry after cancellation"),
    fetch: async () => { calls++; controller.abort(); throw new DOMException("fixture-only", "TimeoutError"); } });
  await assert.rejects(reader.client.getPage(id)); assert.equal(calls, 1);
});

test("a response over the byte limit stops even when its status is 502", async () => {
  let calls = 0;
  const reader = createRuntimeNotionReader(policy, new AbortController().signal, { scheduler: scheduler(), wait: async () => assert.fail("No retry after size rejection"),
    fetch: async () => { calls++; return new Response("x".repeat(2 * 1024 * 1024 + 1), { status: 502 }); } });
  await assert.rejects(reader.client.getPage(id)); assert.equal(calls, 1); assert.equal(reader.statistics().retries, 0);
});

test("HTTP 200 with an invalid SDK object is rejected without replay", async () => {
  let calls = 0;
  const reader = createRuntimeNotionReader(policy, new AbortController().signal, { scheduler: scheduler(), wait: async () => assert.fail("Invalid data is not transient"),
    fetch: async () => { calls++; return new Response(JSON.stringify({ object: "page", id })); } });
  await assert.rejects(reader.client.getPage(id)); assert.equal(calls, 1);
});

test("a budget refusal on a retry cannot cause another request", async () => {
  let attempts = 0, sent = 0;
  const reader = createRuntimeNotionReader(policy, new AbortController().signal, { scheduler: scheduler(), wait: async () => {}, fetch: async () => {
    if (++attempts > 1) throw Object.assign(new Error("fixture-only"), { code: "BUDGET_EXCEEDED" });
    sent++; return new Response(error(502), { status: 502 });
  } });
  await assert.rejects(reader.client.getPage(id)); assert.equal(attempts, 2); assert.equal(sent, 1);
});

test("request retries require explicit policy and disabled SDK retries", async () => {
  assert.throws(() => createRuntimeNotionReader({ token: "example", readRetry: "transient-request-v1" }, new AbortController().signal));
  let calls = 0;
  const reader = createRuntimeNotionReader({ token: "example", retry: false }, new AbortController().signal, { scheduler: scheduler(),
    wait: async () => assert.fail("Unapproved retry"), fetch: async () => { calls++; return new Response(error(502), { status: 502 }); } });
  await assert.rejects(reader.client.getPage(id)); assert.equal(calls, 1);
});

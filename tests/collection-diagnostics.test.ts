import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diagnosticError, diagnosticRequest, diagnosticResponse } from "../scripts/website-incremental-sync/failure-diagnostics.ts";
import { createIncrementalNotionTransport } from "../scripts/website-incremental-sync/notion-transport.ts";
import { createHostBudget } from "../scripts/website-incremental-sync/host-budget.ts";
import { NotionRequestScheduler } from "../src/server/notion/request-scheduler.ts";
import { openIncrementalQueue } from "../scripts/website-incremental-sync/queue.ts";
import { runDirectoryDiscovery, type DirectorySource } from "../scripts/website-incremental-sync/discovery.ts";

const id = "1".repeat(32), secret = "placeholder";
function capture(t: test.TestContext) {
  const events: Record<string, unknown>[] = [];
  t.mock.method(console, "warn", (tag: string, line: string) => { if (tag === "COLLECTION_DIAGNOSTIC") events.push(JSON.parse(line)); });
  return events;
}
test("diagnostics reject raw messages, causes, credentials, URLs and arbitrary upstream fields", () => {
  const error = Object.assign(new Error(secret), { code: secret, cause: { code: "ECONNRESET", message: secret }, body: secret });
  assert.deepEqual(diagnosticError(error), { errorName: "Error", errorCode: null, causeCode: "ECONNRESET" });
  const request = diagnosticRequest(`https://api.notion.com/v1/pages/${id}?secret=${secret}`);
  assert.equal(request.operation, "pages"); assert.ok(request.resourceRef);
  assert.ok(!JSON.stringify(request).includes(id)); assert.ok(!JSON.stringify(request).includes(secret));
  assert.deepEqual(diagnosticRequest(`https://example.test/${secret}`), { operation: "other" });
  const response = diagnosticResponse(new Response(null, { status: 429, headers: { "x-request-id": secret, "retry-after": secret } }),
    Buffer.from(JSON.stringify({ code: secret, message: secret })));
  assert.deepEqual(response, { status: 429, upstreamCode: null, requestId: null, retryAfterSeconds: null });
});
test("the real SDK failure logs HTTP details before the reader translates the error", async t => {
  const events = capture(t), budget = createHostBudget({ durationMs: 3000 }); t.after(() => budget.close());
  const requestId = "12345678-1234-1234-1234-123456789abc";
  const transport = createIncrementalNotionTransport({ token: secret, budget, scheduler: new NotionRequestScheduler({ intervalMs: 0 }),
    fetch: async () => new Response(JSON.stringify({ object: "error", status: 401, code: "unauthorized", message: secret }),
      { status: 401, headers: { "x-request-id": requestId, "set-cookie": secret, "retry-after": "7" } }) });
  await assert.rejects(transport.client.getPage(id), (e: unknown) => (e as { code: string }).code === "MISCONFIGURED");
  assert.equal(events.length, 1); assert.equal(events[0].status, 401); assert.equal(events[0].upstreamCode, "unauthorized");
  assert.equal(events[0].requestId, requestId); assert.equal(events[0].retryAfterSeconds, 7);
  assert.ok(!JSON.stringify(events).includes(secret)); assert.ok(!JSON.stringify(events).includes(id));
});
test("network causes survive SDK translation without changing retry accounting", async t => {
  const events = capture(t), budget = createHostBudget({ durationMs: 4000 }); t.after(() => budget.close());
  const transport = createIncrementalNotionTransport({ token: secret, budget, scheduler: new NotionRequestScheduler({ intervalMs: 0 }),
    fetch: async () => { throw new TypeError(secret, { cause: { code: "ECONNRESET", message: secret } }); } });
  await assert.rejects(transport.client.getPage(id));
  assert.ok(events.length > 0); assert.equal(events.length, budget.statistics().sourceRequests);
  assert.ok(events.every(e => e.causeCode === "ECONNRESET" && e.stage === "fetch"));
  assert.ok(!JSON.stringify(events).includes(secret));
});
test("directory deadline and parent cancellation have distinct diagnostics and preserve the resume cursor", async t => {
  const events = capture(t), dir = await realpath(await mkdtemp(join(tmpdir(), "collection-diagnostic-")));
  const q = await openIncrementalQueue(dir, { digest: "a".repeat(64), sourceKeys: ["study"] }, () => 5000);
  t.after(async () => { q.close(); await rm(dir, { recursive: true, force: true }); });
  const begin = q.beginDiscovery("study", 0, { mode: "membership", startedAt: 5000, overlapMs: 0 });
  q.commitDirectoryPage("study", begin.revision, [], JSON.stringify({ digest: secret, offset: 180 }));
  const before = q.discoveryState("study");
  const source: DirectorySource = { scopeDigest: q.scopeDigest, validate: async () => {}, read: () => new Promise(() => {}) };
  assert.equal((await runDirectoryDiscovery({ queue: q, sourceKey: "study", maxDurationMs: 10 }, source)).outcome, "cancelled");
  assert.deepEqual(q.discoveryState("study"), before);
  assert.equal(events[0].deadlineExpired, true); assert.equal(events[0].parentCancelled, false); assert.equal(events[0].offset, 180);
  const parent = new AbortController();
  const pending = runDirectoryDiscovery({ queue: q, sourceKey: "study", signal: parent.signal }, source); parent.abort();
  assert.equal((await pending).outcome, "cancelled");
  assert.equal(events[1].deadlineExpired, false); assert.equal(events[1].parentCancelled, true);
  assert.deepEqual(q.discoveryState("study"), before); assert.ok(!JSON.stringify(events).includes(secret));
});
test("a broken log sink cannot replace the original failure or change discovery recovery", async t => {
  t.mock.method(console, "warn", () => { throw new Error("sink unavailable"); });
  const dir = await realpath(await mkdtemp(join(tmpdir(), "collection-diagnostic-")));
  const q = await openIncrementalQueue(dir, { digest: "b".repeat(64), sourceKeys: ["study"] }, () => 5000);
  t.after(async () => { q.close(); await rm(dir, { recursive: true, force: true }); });
  const source: DirectorySource = { scopeDigest: q.scopeDigest, validate: async () => {}, read: async () => { throw new Error(secret); } };
  const result = await runDirectoryDiscovery({ queue: q, sourceKey: "study" }, source);
  assert.equal(result.outcome, "retry"); assert.equal(result.errorCode, "DISCOVERY_UNAVAILABLE");
  assert.ok(q.discoveryState("study").scan);
});

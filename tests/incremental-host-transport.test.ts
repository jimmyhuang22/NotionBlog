import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { createHostBudget, hostAwait } from "../scripts/website-incremental-sync/host-budget.ts";
import { createIncrementalNotionTransport } from "../scripts/website-incremental-sync/notion-transport.ts";
import { NotionRequestScheduler } from "../src/server/notion/request-scheduler.ts";
import { createIndependentMediaPort } from "../scripts/website-incremental-sync/independent-media.ts";
import { createWebsiteImageDownloader } from "../scripts/website-sync/download.ts";
import { mediaIdentity } from "../src/server/database/website-validation.ts";
import { createHash } from "node:crypto";
import type { StoredMedia } from "../contracts/sync.ts";

const id = "1".repeat(32);
const coded = (code: string) => (e: unknown) => e instanceof Error && "code" in e && e.code === code;
test("the actual SDK body and paged directory use one bounded transport and charge failed attempts", async t => {
  const budget = createHostBudget({ sourceRequests: 4, durationMs: 3000 }); t.after(() => budget.close());
  let calls = 0;
  const fetcher: typeof fetch = async (url, init) => {
    calls++; assert.equal(new Headers(init!.headers).get("Notion-Version"), "2026-03-11");
    if (calls === 1) return new Response(JSON.stringify({ object: "error", status: 503, code: "service_unavailable", message: "Synthetic" }), { status: 503 });
    return new Response(JSON.stringify(String(url).includes("/query") ? { object: "list", results: [], next_cursor: null, has_more: false } :
      { object: "page", id, url: "https://example.test/synthetic", properties: {}, parent: { type: "workspace", workspace: true } }), { status: 200 });
  };
  const transport = createIncrementalNotionTransport({ token: "synthetic-token", budget, fetch: fetcher, scheduler: new NotionRequestScheduler({ intervalMs: 0 }) });
  assert.equal((await transport.client.getPage(id))!.id, id);
  const result = await transport.directory.queryDataSource({ data_source_id: id, page_size: 100 }, budget.signal);
  assert.deepEqual(result.results, []); assert.equal(calls, 3); assert.equal(budget.statistics().sourceRequests, 3);
  assert.ok(budget.statistics().sourceBytes > 0);
});
test("source response bytes terminate the SDK without a new retry request or persisted body", async t => {
  const budget = createHostBudget({ sourceBytes: 10, durationMs: 3000 }); t.after(() => budget.close()); let calls = 0;
  const transport = createIncrementalNotionTransport({ token: "synthetic-token", budget, scheduler: new NotionRequestScheduler({ intervalMs: 0 }),
    fetch: async () => { calls++; return new Response(JSON.stringify({ privateBody: "x".repeat(1000) })); } });
  await assert.rejects(transport.client.getPage(id));
  assert.equal(calls, 1); assert.equal(budget.statistics().errorCode, "HOST_SOURCE_BUDGET"); assert.ok(budget.statistics().sourceBytes > 10);
});
test("an operation cancellation cancels queued SDK starts while the parent budget remains usable", async t => {
  const budget = createHostBudget({ durationMs: 3000 }); t.after(() => budget.close()); const controller = new AbortController(); let calls = 0;
  const transport = createIncrementalNotionTransport({ token: "synthetic-token", budget, scheduler: new NotionRequestScheduler({ intervalMs: 1000 }),
    fetch: async () => { calls++; return new Response(JSON.stringify({ object: "list", results: [], next_cursor: null, has_more: false })); } });
  await transport.directory.queryDataSource({ data_source_id: id }, budget.signal);
  const pending = transport.directory.queryDataSource({ data_source_id: id }, controller.signal); controller.abort();
  await assert.rejects(pending); budget.guard(); assert.equal(calls, 1);
});
test("late callbacks and elapsed time cannot complete a host await or refund received bytes", async t => {
  const budget = createHostBudget({ durationMs: 20 }); t.after(() => budget.close()); let resolve!: (v: boolean) => void;
  const call = hostAwait(budget, () => new Promise<boolean>(r => { resolve = r; }));
  await assert.rejects(call, coded("HOST_DEADLINE")); resolve(true);
  assert.throws(() => budget.observe("sourceBytes", 7), coded("HOST_DEADLINE")); assert.equal(budget.statistics().sourceBytes, 7);
});
test("closing a successful budget cancels its transports without inventing a failed receipt", () => {
  const budget = createHostBudget(); budget.close();
  assert.equal(budget.signal.aborted, true); assert.equal(budget.statistics().errorCode, null);
  assert.throws(() => budget.charge("sourceRequests", 1), coded("HOST_CLOSED"));
  assert.equal(budget.statistics().sourceRequests, 0);
});
test("independent asset preparation reuses verified stored bytes and registers complete descriptors", async t => {
  const bytes = await sharp({ create: { width: 4, height: 3, channels: 3, background: "red" } }).png().toBuffer();
  const sha256 = createHash("sha256").update(bytes).digest("hex"), descriptor: StoredMedia = { assetId: mediaIdentity(id, "cover", sha256),
    ownerPageId: id, sha256, objectKey: `sha256/${sha256}`, byteSize: bytes.length, mime: "image/png", width: 4, height: 3 };
  const budget = createHostBudget(); t.after(() => budget.close()); let puts = 0, reads = 0;
  const port = createIndependentMediaPort({ budget, cached: () => descriptor, download: async () => ({ bytes, mime: "image/png" }),
    storage: { put: async () => { puts++; }, read: async () => { reads++; return bytes; } } });
  const image = await port.prepare({ ownerPageId: id, url: "https://example.test/original.png", alt: "Synthetic" }, budget.signal);
  assert.deepEqual(image.media, descriptor); assert.equal(image.verified, true); assert.equal(puts, 0); assert.equal(reads, 1);
  await port.prepare({ ownerPageId: id, url: "https://example.test/original.png", alt: "Synthetic" }, budget.signal);
  assert.equal(reads, 1); assert.deepEqual(port.statistics(), { uploadedObjects: 0, reusedObjects: 1 });
});
test("new asset verification cannot publish a descriptor when storage bytes are corrupt or the budget is exhausted", async t => {
  const bytes = await sharp({ create: { width: 3, height: 3, channels: 3, background: "red" } }).png().toBuffer();
  for (const corrupt of [true, false]) {
    const budget = createHostBudget({ mediaBytes: corrupt ? 10000 : 1 }); t.after(() => budget.close()); let puts = 0;
    const port = createIndependentMediaPort({ budget, cached: () => null, download: async () => ({ bytes, mime: "image/png" }),
      storage: { put: async () => { puts++; }, read: async () => new Uint8Array(bytes.length) } });
    await assert.rejects(port.prepare({ ownerPageId: id, url: "https://example.test/original.png", alt: "Synthetic" }, budget.signal));
    assert.equal(puts, corrupt ? 1 : 0); assert.ok(budget.statistics().mediaBytes > 0);
  }
});
test("the existing image retry transport charges failed wire chunks and stops on the shared byte budget", async t => {
  const budget = createHostBudget({ mediaBytes: 5 }); t.after(() => budget.close()); let attempts = 0;
  const download = createWebsiteImageDownloader({ resolve: async () => [{ address: "8.8.8.8", family: 4 }],
    request: async () => { attempts++; return { status: 200, headers: { "content-type": "image/png" },
      bytes: (async function* () { yield new Uint8Array(6); })(), cancel() {} }; } }, { onReceivedBytes: n => budget.observe("mediaBytes", n) });
  await assert.rejects(download("https://example.test/original.png", budget.signal));
  assert.equal(attempts, 1); assert.equal(download.statistics().receivedBodyBytes, 6); assert.equal(budget.statistics().mediaBytes, 6);
});

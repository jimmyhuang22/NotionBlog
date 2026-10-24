import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { config, publicationKey } from "../scripts/social-sync/model.ts";
import { observation, fetchVideoPage, fetchCollectionPage } from "../scripts/social-sync/bilibili.ts";
import { openStore, flushOutbox } from "../scripts/social-sync/store.ts";
import { openCollectionStore, flushCollectionOutbox } from "../scripts/social-sync/collection-store.ts";
import { collectionKey } from "../scripts/social-sync/collection.ts";
import { exampleCollectionSnapshot } from "./helpers/social-collection-samples.ts";

const at = "2026-01-02T00:00:00.000Z";
const target = (i: number) => config({ version: 1, publications: [{ platform: "bilibili", accountId: "10001", workId: `example-${i}`, url: `https://www.bilibili.com/video/BV${String(i).padStart(10, "0")}/` }] })[0]!;
function sample(i: number) {
  const t = target(i);
  return observation(`<script>window.__INITIAL_STATE__=${JSON.stringify({ videoData: { bvid: t.publicationId, owner: { mid: 10001 }, title: "Example", pic: null, stat: { view: i } } })}</script>`, t, at);
}
async function directory(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "social-upload-selection-")));
  t.after(() => rm(root, { recursive: true, force: true })); return root;
}

test("more than 100 removed publications cannot hide the configured tail of the outbox", async t => {
  const root = await directory(t), store = (await openStore(root))!;
  t.after(() => store.close());
  const rows = Array.from({ length: 125 }, (_, i) => sample(i + 1)).sort((a, b) => publicationKey(a).localeCompare(publicationKey(b)));
  store.ingestBatch(rows);
  assert.equal(store.pending().length, 100, "unfiltered export retains its existing bound");
  const allowedKeys = new Set(rows.slice(-20).map(publicationKey)), sent: string[] = [];
  const excluded = publicationKey(rows[0]!);
  // An excluded corrupt payload must not be decoded or sent; retain it for manual inspection.
  const db = new DatabaseSync(join(root, "social.sqlite"));
  try { db.prepare("UPDATE outbox SET payload=? WHERE key=?").run("private invalid payload", excluded); }
  finally { db.close(); }
  const report = await flushOutbox(store, async item => { sent.push(item.key); return item; }, { allowedKeys });
  assert.deepEqual(sent, [...allowedKeys]);
  assert.deepEqual(report, { acknowledged: 20, failed: 0, superseded: 0, skipped: 105, cancelled: false });
  assert.equal(store.status().pending, 105);
  for (const row of rows.slice(-20)) assert.equal(store.pendingFor({ ...row, url: row.originalUrl }), null);
  const empty = await flushOutbox(store, async () => { assert.fail("no eligible targets"); }, { allowedKeys: new Set() });
  assert.equal(empty.skipped, 105); assert.equal(empty.acknowledged, 0);
});

test("collection upload filters historical rows before count and byte limits without deleting them", async t => {
  const root = await directory(t), store = (await openCollectionStore(root))!;
  t.after(() => store.close());
  const rows = Array.from({ length: 125 }, (_, i) => {
    const row = exampleCollectionSnapshot(at); row.target.collectionId = String(i + 200); return row;
  }).sort((a, b) => collectionKey(a.target).localeCompare(collectionKey(b.target)));
  for (const row of rows) store.ingest(row);
  assert.throws(() => store.pending(), { code: "COLLECTION_EXPORT_TOO_LARGE" });
  const allowedKeys = new Set(rows.slice(-20).map(row => collectionKey(row.target))), sent: string[] = [];
  const db = new DatabaseSync(join(root, "social-collections.sqlite"));
  try { db.prepare("UPDATE collection_outbox SET payload=? WHERE key=?").run("x".repeat(8 * 1024 * 1024 + 1), collectionKey(rows[0]!.target)); }
  finally { db.close(); }
  const report = await flushCollectionOutbox(store, async item => { sent.push(item.key); return item; }, { allowedKeys });
  assert.deepEqual(sent, [...allowedKeys]);
  assert.deepEqual(report, { acknowledged: 20, failed: 0, superseded: 0, skipped: 105, cancelled: false });
  assert.equal(store.status().pending, 105);
  for (const row of rows.slice(-20)) assert.equal(store.pendingFor(row.target), null);
  const excluded = collectionKey(rows[0]!.target);
  await assert.rejects(flushCollectionOutbox(store, async () => { assert.fail("oversized selected payload cannot be sent"); }, { allowedKeys: new Set([excluded]) }), { code: "COLLECTION_EXPORT_TOO_LARGE" });
  assert.equal(store.status().pending, 105);
  const empty = await flushCollectionOutbox(store, async () => { assert.fail("no eligible targets"); }, { allowedKeys: new Set() });
  assert.equal(empty.skipped, 105);
});

for (const [name, read] of [["video", fetchVideoPage], ["collection", fetchCollectionPage]] as const) {
  test(`${name} direct HTTP classifies 5xx without wrappers, retries or reading the error body`, async () => {
    for (const [status, code] of [[500, "SOURCE_TEMPORARY_ERROR"], [502, "SOURCE_TEMPORARY_ERROR"], [503, "SOURCE_TEMPORARY_ERROR"], [599, "SOURCE_TEMPORARY_ERROR"],
      [302, "SOURCE_REDIRECT"], [403, "SOURCE_BLOCKED"], [412, "SOURCE_BLOCKED"], [429, "RATE_LIMITED"], [404, "SOURCE_HTTP_ERROR"]] as const) {
      let requests = 0, reads = 0, cancelled = 0;
      const body = new ReadableStream<Uint8Array>({ pull() { reads++; throw Error("private response must not be read"); }, cancel() { cancelled++; } }, { highWaterMark: 0 });
      await assert.rejects(read(target(1), undefined, async () => { requests++; return new Response(body, { status }); }), { code });
      assert.equal(requests, 1); assert.equal(reads, 0); assert.equal(cancelled, 1);
    }
  });
}

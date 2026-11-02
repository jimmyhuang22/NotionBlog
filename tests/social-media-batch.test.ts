import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { createSocialMediaSql, socialMediaBatchSql, socialMediaOwnerSql, socialMediaAssetSql } from "../src/server/social/media-query.ts";
import { socialMediaResponse } from "../src/server/social/media.ts";
import { versionedCoverReference } from "../src/server/social/covers.ts";
import { publicationCoverSource } from "../scripts/social-media/sources.ts";
import { collectionKey } from "../scripts/social-sync/collection.ts";
import { prepareCover } from "../scripts/social-media/worker.ts";
import { coverTestEngine, coverTestImage } from "./helpers/social-cover-engine.ts";
import { withMediaReadBudget } from "../src/server/media/read-budget.ts";
import { contentReadBudgetIdentity } from "../src/server/content-read-budget.ts";
import type { SqlExecutor } from "../src/server/database/sql.ts";
import type { StoredMedia } from "../contracts/sync.ts";

const key = (number: number) => number.toString(16).padStart(64, "0");
const values = (number: number) => ["publication", key(number), "retained"];
async function readerSession<T>(db: Awaited<ReturnType<typeof coverTestEngine>>["db"], text: string, input?: unknown[]) {
  return db.transaction(async tx => {
    await tx.exec("SET LOCAL SESSION AUTHORIZATION nb_social_reader");
    try { return await tx.query<T>(text, input); }
    // PGlite's RESET does not restore its bootstrap login; explicitly restore the fixture writer.
    finally { await tx.exec("SET SESSION AUTHORIZATION postgres; RESET ROLE"); }
  });
}
function fakeRows(input: unknown[]) {
  return (JSON.parse(input[0] as string) as { request_id: number; owner_kind: string; owner_key: string }[]).map(item => ({
    role: "nb_social_reader", login: "nb_social_reader", reader_version: 1, collection_version: 1, elevated: false,
    request_id: item.request_id, owner_kind: item.owner_kind ?? "publication", owner_key: item.owner_key ?? key(1), files: { fixture: true },
  }));
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test("forty concurrent covers and validators use bounded live batches under the actual reader/RLS", async t => {
  const e = await coverTestEngine(t);
  const collection = await e.collection();
  const collectionSource = { kind: "collection" as const, key: collectionKey(collection.target), platform: "bilibili" as const,
    url: "https://i0.hdslb.com/season.png", observedAt: collection.observedAt };
  await e.writer.collectionSource(collectionSource, "retained");
  const sources = [];
  for (let i = 0; i < 39; i++) sources.push(publicationCoverSource(await e.add(`BV${String(i + 3).padStart(10, "0")}`, `work-${i}`)));
  sources.push(collectionSource);
  const image = await coverTestImage();
  const prepared = await Promise.all(sources.map(source => prepareCover(source, image)));
  for (const [i, source] of sources.entries()) await e.writer.register(source, "retained", prepared[i]!.files);
  let statements = 0, active = 0, maximum = 0, objectReads = 0;
  const db: SqlExecutor = { query: async <T>(text: string, input?: unknown[]) => {
    statements++; maximum = Math.max(maximum, ++active);
    assert.equal(text, socialMediaBatchSql);
    assert.ok(JSON.parse(input![0] as string).length <= 32);
    try {
      await delay(35); // One pool slot and real RLS, including protocol/login checks.
      return await readerSession<T>(e.db, text, input);
    } finally { active--; }
  } };
  const sql = createSocialMediaSql(db);
  const references = sources.map((source, i) => versionedCoverReference(source.kind, source.key, prepared[i]!.files));
  const bodies = new Map(prepared.flatMap(item => [...item.bodies]));
  const storage = { put: async () => { throw Error("reader cannot write"); }, read: async (media: StoredMedia) => {
    objectReads++; await delay((parseInt(media.ownerPageId.slice(-2), 16) % 7) * 3);
    return bodies.get(media.sha256)!;
  } };
  const responses = await Promise.all(Array.from({ length: 40 }, (_, i) => withMediaReadBudget(new AbortController().signal,
    () => socialMediaResponse(references[i]!, 800, "retained", sql, () => storage))));
  assert.ok(responses.every(response => response.status === 200));
  assert.ok(statements <= 12, `expected a few batches rather than 160 SQL round trips, got ${statements}`);
  assert.equal(maximum, 1); assert.equal(objectReads, 40);
  for (const [i, response] of responses.entries()) assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from(prepared[i]!.bodies.get(prepared[i]!.files.previews["800"].sha256)!));
  const before = statements;
  const validators = await Promise.all(responses.map((response, i) => withMediaReadBudget(new AbortController().signal,
    () => socialMediaResponse(references[i]!, 800, "retained", sql, () => { throw Error("304 must not read an object"); }, response.headers.get("etag")))));
  assert.ok(validators.every(response => response.status === 304));
  assert.ok(statements - before <= 6); assert.equal(objectReads, 40);
  t.diagnostic(`40 image responses: ${before} batch SELECTs; 40 validators: ${statements - before}; maximum SQL concurrency: ${maximum}`);
  assert.deepEqual((await sql.query(socialMediaOwnerSql, ["publication", sources[0]!.key, "trial"])).rows, []);
  const legacy = (await e.reader.query<{ asset_id: string }>("SELECT asset_id FROM social_sync.cover_bindings WHERE owner_key=$1 AND display_mode='retained'", [sources[0]!.key])).rows[0]!.asset_id;
  assert.equal((await sql.query<{ owner_key: string }>(socialMediaAssetSql, [legacy, "retained"])).rows[0]!.owner_key, sources[0]!.key);
  await e.db.query("UPDATE social_sync.retained_collections SET approved=false WHERE collection_key=$1", [collectionSource.key]);
  assert.equal((await socialMediaResponse(references.at(-1)!, 800, "retained", sql, () => { throw Error("withdrawn collection cannot read objects"); }, responses.at(-1)!.headers.get("etag"))).status, 404);
});

test("batched validators still requalify after the first read and reject a real withdrawal", async t => {
  const e = await coverTestEngine(t), row = await e.add("BV0000000003", "work-a"), source = publicationCoverSource(row);
  const prepared = await prepareCover(source, await coverTestImage());
  await e.writer.register(source, "retained", prepared.files);
  const reference = versionedCoverReference(source.kind, source.key, prepared.files);
  const first = await socialMediaResponse(reference, 400, "retained", e.reader, () => ({ put: async () => {}, read: async media => prepared.bodies.get(media.sha256)! }));
  let calls = 0;
  const sql = createSocialMediaSql({ query: async <T>(text: string, input?: unknown[]) => {
    if (++calls === 2) await e.db.query("UPDATE social_sync.works SET approved=false WHERE work_id=$1", [row.workId]);
    return readerSession<T>(e.db, text, input);
  } });
  const response = await socialMediaResponse(reference, 400, "retained", sql, () => { throw Error("withdrawal cannot read objects"); }, first.headers.get("etag"));
  assert.equal(response.status, 404); assert.equal(calls, 2); assert.equal(response.headers.get("etag"), null);
});

test("one cancelled visitor cannot abort another visitor's in-flight qualification", async () => {
  const started = deferred<AbortSignal>(), release = deferred<void>();
  let batchSignal!: AbortSignal;
  const sql = createSocialMediaSql({ query: async <T>(_text: string, input?: unknown[]) => {
    batchSignal = contentReadBudgetIdentity()!.signal; started.resolve(batchSignal);
    await release.promise; return { rows: fakeRows(input!) as T[] };
  } });
  const first = new AbortController(), second = new AbortController();
  const a = withMediaReadBudget(first.signal, () => sql.query(socialMediaOwnerSql, values(1)));
  const rejected = assert.rejects(a, { code: "CONTENT_UNAVAILABLE" });
  const b = withMediaReadBudget(second.signal, () => sql.query<{ owner_key: string }>(socialMediaOwnerSql, values(2)));
  await started.promise; first.abort(); await rejected;
  assert.equal(batchSignal.aborted, false); release.resolve();
  assert.equal((await b).rows[0]!.owner_key, key(2));
});

test("all cancelled callers abort the batch and the next request can drain normally", async () => {
  const started = deferred<void>(), stopped = deferred<void>();
  let calls = 0;
  const sql = createSocialMediaSql({ query: async <T>(_text: string, input?: unknown[]) => {
    if (++calls === 1) {
      const signal = contentReadBudgetIdentity()!.signal; started.resolve();
      await new Promise((_resolve, reject) => signal.addEventListener("abort", () => { stopped.resolve(); reject(Error("cancelled")); }, { once: true }));
    }
    return { rows: fakeRows(input!) as T[] };
  } });
  const controller = new AbortController();
  const result = withMediaReadBudget(controller.signal, () => sql.query(socialMediaOwnerSql, values(1)));
  const rejected = assert.rejects(result, { code: "CONTENT_UNAVAILABLE" });
  await started.promise; controller.abort(); await rejected; await stopped.promise;
  assert.equal((await sql.query(socialMediaOwnerSql, values(2))).rows.length, 1);
});

test("identity/protocol corruption, missing rows and duplicate rows fail closed without cached approval", async () => {
  let mutate: (rows: ReturnType<typeof fakeRows>) => unknown[] = rows => rows;
  const sql = createSocialMediaSql({ query: async <T>(_text: string, input?: unknown[]) => ({ rows: mutate(fakeRows(input!)) as T[] }) });
  assert.equal((await sql.query(socialMediaOwnerSql, values(1))).rows.length, 1);
  for (const change of [
    (rows: ReturnType<typeof fakeRows>) => rows.map(row => ({ ...row, role: "postgres" })),
    (rows: ReturnType<typeof fakeRows>) => rows.map(row => ({ ...row, login: "postgres" })),
    (rows: ReturnType<typeof fakeRows>) => rows.map(row => ({ ...row, reader_version: 2 })),
    (rows: ReturnType<typeof fakeRows>) => rows.map(row => ({ ...row, collection_version: 2 })),
    (rows: ReturnType<typeof fakeRows>) => rows.map(row => ({ ...row, elevated: true })),
    (rows: ReturnType<typeof fakeRows>) => rows.map(row => ({ ...row, owner_key: key(99) })),
    () => [], (rows: ReturnType<typeof fakeRows>) => [...rows, ...rows],
  ]) {
    mutate = change; await assert.rejects(sql.query(socialMediaOwnerSql, values(1)), { code: "CONTENT_UNAVAILABLE" });
  }
  mutate = rows => rows;
  assert.equal((await sql.query(socialMediaOwnerSql, values(1))).rows.length, 1);
});

test("batch input and queue sizes are bounded and rejected callers do not poison the queue", async () => {
  let calls = 0;
  const sql = createSocialMediaSql({ query: async <T>(_text: string, input?: unknown[]) => { calls++; return { rows: fakeRows(input!) as T[] }; } });
  for (const [text, input] of [["SELECT 1", []], [socialMediaOwnerSql, ["unknown", key(1), "retained"]], [socialMediaOwnerSql, ["publication", key(1), "unknown"]], [socialMediaAssetSql, ["s1.bad", "retained"]]] as const) {
    await assert.rejects(sql.query(text, [...input]), { code: "CONTENT_UNAVAILABLE" });
  }
  assert.equal(calls, 0);
  const all = await Promise.allSettled(Array.from({ length: 129 }, (_, i) => sql.query(socialMediaOwnerSql, values(i + 1))));
  assert.equal(all.filter(result => result.status === "fulfilled").length, 128);
  assert.equal(all.filter(result => result.status === "rejected").length, 1);
  assert.equal(calls, 4);
  assert.equal((await sql.query(socialMediaOwnerSql, values(1))).rows.length, 1);
});

import test from "node:test";
import assert from "node:assert/strict";
import { hash } from "../scripts/social-sync/model.ts";
import { publicationCoverSource } from "../scripts/social-media/sources.ts";
import { prepareCover } from "../scripts/social-media/worker.ts";
import { coverAssetId, coverReference, versionedCoverReference, withSocialCovers } from "../src/server/social/covers.ts";
import { socialMediaResponse } from "../src/server/social/media.ts";
import { readRetainedSocialSnapshot } from "../src/server/social/retained-repository.ts";
import { imagePreviewSrc } from "../src/lib/content/image-preview.ts";
import type { StoredMedia } from "../contracts/sync.ts";
import type { SqlExecutor } from "../src/server/database/sql.ts";
import { coverTestEngine, coverTestImage } from "./helpers/social-cover-engine.ts";

async function setup(t: Parameters<typeof coverTestEngine>[0]) {
  const e = await coverTestEngine(t), row = await e.add("BV0000000003", "work-a"), source = publicationCoverSource(row);
  const prepared = await prepareCover(source, await coverTestImage());
  await e.writer.register(source, "retained", prepared.files);
  const reference = coverReference(source.kind, source.key);
  const cover = async () => (await withSocialCovers(await readRetainedSocialSnapshot(e.reader), e.reader, "retained")).items[0]!.cover!;
  let clock = Date.parse(row.observedAt);
  const ingest = async (url: string | null) => {
    row.coverUrl = url; row.observedAt = new Date(++clock).toISOString();
    await e.worker.query("SELECT * FROM social_sync.ingest($1,$2,$3)", [source.key, hash(JSON.stringify(row)), JSON.stringify(row)]);
    return publicationCoverSource(row);
  };
  return { ...e, row, source, prepared, reference, cover, ingest };
}

test("an already-rendered cover URL survives pending renewal and exact registration of identical bytes", async t => {
  const e = await setup(t), before = await e.cover();
  assert.equal(before.src, `/media/social/${versionedCoverReference(e.source.kind, e.source.key, e.prepared.files)}`);
  assert.equal(imagePreviewSrc(before, 400), `${before.src}?thumbnail=400`);
  assert.equal(imagePreviewSrc(before, 800), `${before.src}?thumbnail=800`);
  assert.equal(imagePreviewSrc(before, 1600), before.src);
  const storage = { put: async () => {}, read: async (m: StoredMedia) => e.prepared.bodies.get(m.sha256)! };
  const renewed = await e.ingest("https://i0.hdslb.com/example.png?reference=renewed");
  assert.equal((await socialMediaResponse(e.reference, 400, "retained", e.reader, () => storage)).status, 200);
  await e.writer.register(renewed, "retained", e.prepared.files);
  const after = await e.cover(); assert.notEqual(after.id, before.id); assert.equal(after.src, before.src);
  const response = await socialMediaResponse(e.reference, 400, "retained", e.reader, () => storage);
  assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "private, no-cache, must-revalidate");
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from(e.prepared.bodies.get(e.prepared.files.previews["400"].sha256)!));
  assert.equal((await socialMediaResponse(before.id, 400, "retained", e.reader, () => storage)).status, 404, "legacy generation IDs are not made perpetual aliases");
  assert.equal((await socialMediaResponse(after.id, 400, "retained", e.reader, () => storage)).headers.get("cache-control"), "private, max-age=86400, must-revalidate");
  assert.equal((await socialMediaResponse(e.reference, 400, "trial", e.reader, () => storage)).status, 404);
});

test("a real replacement changes the cacheable URL while the legacy owner reference still follows current bytes", async t => {
  const e = await setup(t), first = await e.cover();
  const updated = await e.ingest("https://i0.hdslb.com/replaced.png");
  const replacement = await prepareCover(updated, await coverTestImage(640, 480));
  await e.writer.register(updated, "retained", replacement.files);
  assert.notEqual((await e.cover()).src, first.src);
  const storage = { put: async () => {}, read: async (m: StoredMedia) => replacement.bodies.get(m.sha256)! };
  const response = await socialMediaResponse(e.reference, null, "retained", e.reader, () => storage);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from(replacement.bodies.get(replacement.files.original.sha256)!));
  await e.db.query("UPDATE social_sync.works SET approved=false WHERE work_id=$1", [e.row.workId]);
  let reads = 0;
  const counted = { ...storage, read: async (m: StoredMedia) => { reads++; return storage.read(m); } };
  assert.equal((await socialMediaResponse(e.reference, 400, "retained", e.reader, () => counted)).status, 404); assert.equal(reads, 0);
  await e.db.query("UPDATE social_sync.works SET approved=true WHERE work_id=$1", [e.row.workId]);
  const withdraw = { ...storage, read: async (m: StoredMedia) => { await e.db.query("UPDATE social_sync.bindings SET enabled=false WHERE publication_key=$1", [e.source.key]); return storage.read(m); } };
  assert.equal((await socialMediaResponse(e.reference, 800, "retained", e.reader, () => withdraw)).status, 404);
  await e.db.query("UPDATE social_sync.bindings SET enabled=true WHERE publication_key=$1", [e.source.key]);
  await e.ingest(null);
  assert.equal((await socialMediaResponse(e.reference, 400, "retained", e.reader, () => counted)).status, 404); assert.equal(reads, 0);
});

test("stable reads reject changed bytes during object IO and retain strict collection source checks", async t => {
  const e = await setup(t);
  const changing = { put: async () => {}, read: async (m: StoredMedia) => {
    const changed = await prepareCover(e.source, await coverTestImage(640, 480));
    await e.writer.register(e.source, "retained", changed.files);
    return e.prepared.bodies.get(m.sha256)!;
  } };
  await assert.rejects(socialMediaResponse(e.reference, 400, "retained", e.reader, () => changing), { code: "CONTENT_UNAVAILABLE" });
  const row = await e.collection();
  const { collectionKey } = await import("../scripts/social-sync/collection.ts");
  const source = { kind: "collection" as const, key: collectionKey(row.target), platform: "bilibili" as const, url: "https://i0.hdslb.com/season.png", observedAt: row.observedAt };
  await e.writer.collectionSource(source, "retained");
  const prepared = await prepareCover(source, await coverTestImage()); await e.writer.register(source, "retained", prepared.files);
  const reference = coverReference(source.kind, source.key), storage = { put: async () => {}, read: async (m: StoredMedia) => prepared.bodies.get(m.sha256)! };
  assert.equal((await socialMediaResponse(reference, 400, "retained", e.reader, () => storage)).status, 200);
  row.observedAt = new Date(Date.parse(row.observedAt) + 1).toISOString();
  await e.worker.query("SELECT * FROM social_sync.ingest_collection($1,$2,$3)", [source.key, hash(JSON.stringify(row)), JSON.stringify(row)]);
  assert.equal((await socialMediaResponse(reference, 400, "retained", e.reader, () => storage)).status, 404);
  assert.equal((await socialMediaResponse(reference, 400, "retained", e.reader, () => { throw Error("no object read for an unqualified collection"); }, "*")).status, 404);
});

test("malformed stable and legacy identifiers cannot query SQL or storage", async () => {
  const sql: SqlExecutor = { query: async () => { throw Error("must not query"); } };
  for (const id of [`s2.publication.${"a".repeat(64)}\n`, `s2.collection.${"A".repeat(64)}`, `s2.unknown.${"a".repeat(64)}`, `s1.${"a".repeat(64)}\n`]) {
    assert.equal((await socialMediaResponse(id, 400, "retained", sql, () => { throw Error("must not open storage"); })).status, 404);
  }
  assert.match(coverAssetId("publication", "a".repeat(64), "b".repeat(64), "c".repeat(64)), /^s1\./);
});

import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, chmod, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StoredMedia } from "../contracts/sync.ts";
import { hash, publicationKey } from "../scripts/social-sync/model.ts";
import { publicationCoverSource, sourceDigest } from "../scripts/social-media/sources.ts";
import { createCoverCache } from "../scripts/social-media/cache.ts";
import { prepareCover, syncCovers } from "../scripts/social-media/worker.ts";
import { coverAssetId, withSocialCovers } from "../src/server/social/covers.ts";
import { readRetainedSocialSnapshot } from "../src/server/social/retained-repository.ts";
import { socialMediaResponse } from "../src/server/social/media.ts";
import { coverTestEngine, coverTestImage } from "./helpers/social-cover-engine.ts";

async function setup(t: Parameters<typeof coverTestEngine>[0], rotation = true) {
  const e = await coverTestEngine(t, rotation), row = await e.add("BV0000000003", "work-a");
  const source = publicationCoverSource(row), prepared = await prepareCover(source, await coverTestImage());
  await e.writer.register(source, "retained", prepared.files);
  await e.writer.register(source, "trial", prepared.files);
  let clock = Date.parse(row.observedAt);
  const ingest = async (url: string | null) => {
    row.coverUrl = url; row.observedAt = new Date(++clock).toISOString();
    await e.worker.query("SELECT * FROM social_sync.ingest($1,$2,$3)", [publicationKey(row), hash(JSON.stringify(row)), JSON.stringify(row)]);
    return publicationCoverSource(row);
  };
  const objects = new Map(prepared.bodies);
  const storage = { put: async (m: StoredMedia, b: Uint8Array) => { objects.set(m.sha256, b); }, read: async (m: StoredMedia) => objects.get(m.sha256)! };
  const cover = async () => (await withSocialCovers(await readRetainedSocialSnapshot(e.reader), e.reader, "retained")).items[0]?.cover ?? null;
  const oldId = coverAssetId(source.kind, source.key, sourceDigest(source)!, prepared.files.original.sha256);
  return { ...e, row, source, prepared, ingest, storage, cover, oldId };
}

test("pending renewal preserves the verified cover through failure; successful replacement switches both reads atomically", async t => {
  const e = await setup(t), root = await realpath(await mkdtemp(join(tmpdir(), "cover-rotation-")));
  await chmod(root, 0o700); t.after(() => rm(root, { recursive: true, force: true }));
  const cache = await createCoverCache(root);
  await cache.save(e.source, "irrelevant-old-recipe", e.prepared.files, e.prepared.bodies);
  const renewed = await e.ingest("https://i0.hdslb.com/example.png?reference=renewed");
  assert.equal((await e.cover())!.id, e.oldId);
  assert.equal((await socialMediaResponse(e.oldId, 400, "retained", e.reader, () => e.storage)).status, 200);
  await assert.rejects(e.writer.register(e.source, "retained", e.prepared.files), /NB_SOCIAL_COVER_SOURCE_CHANGED/);
  const failed = await syncCovers([renewed], "retained", { writer: e.writer, cache, storage: e.storage, download: async () => { throw Error("private transport detail"); } });
  assert.equal(failed.failed, 1); assert.equal((await e.cover())!.id, e.oldId);
  const latest = await e.ingest("https://i0.hdslb.com/replaced.png?reference=latest");
  assert.equal((await e.cover())!.id, e.oldId, "multiple pending generations keep one verified binding");
  const bytes = await coverTestImage(640, 480);
  const report = await syncCovers([latest], "retained", { writer: e.writer, cache, storage: { ...e.storage,
    read: async m => { assert.equal((await e.cover())!.id, e.oldId, "replacement is not visible during object proof"); return e.storage.read(m); } }, download: async () => bytes });
  assert.equal(report.registered, 1); assert.equal(report.failed, 0);
  const next = (await e.cover())!; assert.notEqual(next.id, e.oldId);
  assert.equal((await socialMediaResponse(next.id, 800, "retained", e.reader, () => e.storage)).status, 200);
  assert.equal((await socialMediaResponse(e.oldId, 400, "retained", e.reader, () => e.storage)).status, 404);
  assert.equal((await socialMediaResponse(e.oldId, 400, "trial", e.reader, () => e.storage)).status, 200, "each mode keeps its own verified binding");
});

test("a missing cover deletes both mode bindings and adding the same URL back never resurrects either", async t => {
  const e = await setup(t); await e.ingest(null);
  assert.equal(await e.cover(), null);
  assert.equal((await e.db.query("SELECT * FROM social_sync.cover_bindings")).rows.length, 0);
  await e.ingest(e.source.url);
  assert.equal(await e.cover(), null);
  const noRead = { ...e.storage, read: async () => { throw Error("removed binding must not read objects"); } };
  for (const mode of ["trial", "retained"] as const) assert.equal((await socialMediaResponse(e.oldId, 400, mode, e.reader, () => noRead)).status, 404);
  await e.writer.register(publicationCoverSource(e.row), "retained", e.prepared.files);
  assert.equal((await e.cover())!.id, e.oldId);
  await e.db.query("DELETE FROM social_sync.publications WHERE publication_key=$1", [e.source.key]);
  assert.equal((await e.db.query("SELECT * FROM social_sync.cover_bindings")).rows.length, 0);
});

test("note type changes destroy continuity even when the reviewed type is later restored", async t => {
  const e = await setup(t);
  // Produce a valid note through the existing narrow projection, without real account data.
  const { config } = await import("../scripts/social-sync/model.ts");
  const { snapshotObservation } = await import("../scripts/social-sync/xiaohongshu.ts");
  const target = config({ version: 1, publications: [{ platform: "xiaohongshu", workId: "note-work", accountId: "000000000000000000000001", url: "https://www.xiaohongshu.com/explore/000000000000000000000002" }] })[0]!;
  const at = new Date().toISOString();
  const row = snapshotObservation({ version: 1, source: "browser-note-state", observedAt: at, pageUrl: target.url, note: { noteId: target.publicationId, userId: target.accountId, type: "normal", title: "Fictional note", time: null, lastUpdateTime: null, coverUrl: "https://sns-webpic-qc.xhscdn.com/example.png", interactInfo: { likedCount: "1", commentCount: "0", shareCount: null, collectedCount: null } } }, target, at);
  const key = publicationKey(row), ingest = async () => e.worker.query("SELECT * FROM social_sync.ingest($1,$2,$3)", [key, hash(JSON.stringify(row)), JSON.stringify(row)]);
  await e.db.query("INSERT INTO social_sync.bindings(platform,account_id,publication_id,work_id,enabled) VALUES($1,$2,$3,$4,true)", [row.platform, row.accountId, row.publicationId, row.workId]);
  await ingest();
  await e.db.query("INSERT INTO social_sync.works(work_id,title,approved) VALUES($1,'Reviewed note',true)", [row.workId]);
  await e.db.query("INSERT INTO social_sync.retained_publications(publication_key,work_id,approved,reviewed_at,reviewed_kind,approved_source_sha256,source_sha256) VALUES($1,$2,true,now(),'image-note',$3,$3)", [key, row.workId, hash(JSON.stringify(row))]);
  const source = publicationCoverSource(row), prepared = await prepareCover(source, await coverTestImage()), files = prepared.files;
  await e.writer.register(source, "retained", files);
  row.coverUrl += "?reference=next"; row.observedAt = new Date(Date.parse(at) + 1).toISOString(); await ingest();
  assert.equal((await e.reader.query("SELECT asset_id FROM social_sync.cover_bindings WHERE owner_key=$1", [key])).rows.length, 1);
  const oldId = coverAssetId(source.kind, key, sourceDigest(source)!, files.original.sha256);
  assert.equal((await socialMediaResponse(oldId, 400, "retained", e.reader, () => ({ ...e.storage, read: async m => prepared.bodies.get(m.sha256)! }))).status, 200);
  row.kind = "video"; row.observedAt = new Date(Date.parse(at) + 2).toISOString(); await ingest();
  assert.equal((await e.db.query("SELECT * FROM social_sync.cover_bindings WHERE owner_key=$1", [key])).rows.length, 0);
  row.kind = "image-note"; row.observedAt = new Date(Date.parse(at) + 3).toISOString(); await ingest();
  assert.equal((await e.reader.query("SELECT * FROM social_sync.cover_bindings WHERE owner_key=$1", [key])).rows.length, 0);
});

test("continuity never bypasses withdrawal, binding disable, or the second scope check during object reads", async t => {
  const e = await setup(t); await e.ingest("https://i0.hdslb.com/example.png?reference=pending");
  await e.db.query("UPDATE social_sync.works SET approved=false WHERE work_id=$1", [e.row.workId]);
  assert.equal((await socialMediaResponse(e.oldId, 400, "retained", e.reader, () => e.storage)).status, 404);
  await e.db.query("UPDATE social_sync.works SET approved=true WHERE work_id=$1", [e.row.workId]);
  const withdraw = { ...e.storage, read: async (m: StoredMedia) => { await e.db.query("UPDATE social_sync.bindings SET enabled=false WHERE publication_key=$1", [e.source.key]); return e.storage.read(m); } };
  assert.equal((await socialMediaResponse(e.oldId, 400, "retained", e.reader, () => withdraw)).status, 404);
  assert.equal((await e.reader.query("SELECT * FROM social_sync.cover_bindings")).rows.length, 0);
});

test("a generation change before registration rejects the stale candidate and preserves only the verified previous image", async t => {
  const e = await setup(t), candidate = await e.ingest("https://i0.hdslb.com/replaced.png");
  // A stale registration cannot rely on the worker's earlier source check.
  await e.ingest("https://i0.hdslb.com/newest.png");
  await assert.rejects(e.writer.register(candidate, "retained", e.prepared.files), /NB_SOCIAL_COVER_SOURCE_CHANGED/);
  assert.equal((await e.cover())!.id, e.oldId);
  assert.equal((await e.writer.source(candidate, "retained"))!.sha256, hash(e.row.coverUrl!));
});

test("installation does not restore pre-existing hidden bindings and grants no media approval or trigger RPC", async t => {
  const e = await setup(t, false); await e.ingest("https://i0.hdslb.com/replaced-before-install.png");
  assert.equal(await e.cover(), null);
  await e.db.exec(await readFile(new URL("../supabase/migrations/20261018134559_social_cover_rotation.sql", import.meta.url), "utf8"));
  assert.equal(await e.cover(), null);
  assert.deepEqual((await e.db.query("SELECT continuity_ready FROM social_sync.cover_bindings")).rows, [{ continuity_ready: false }, { continuity_ready: false }]);
  await e.writer.register(publicationCoverSource(e.row), "retained", e.prepared.files);
  assert(await e.cover(), "normal exact registration establishes continuity without purging object reuse metadata");
  for (const role of ["anon", "authenticated", "service_role", "nb_reader", "nb_social_worker", "nb_social_reader", "nb_social_media_worker"]) {
    await assert.rejects(e.role(role).query("SELECT social_sync.guard_cover_binding()"), /permission denied/);
  }
  await assert.rejects(e.media.query("UPDATE social_sync.works SET approved=true"), /permission denied/);
  await assert.rejects(e.media.query("DELETE FROM social_sync.cover_bindings"), /permission denied/);
  await assert.rejects(e.reader.query("UPDATE social_sync.cover_bindings SET source_sha256=$1", ["0".repeat(64)]), /permission denied/);
  await assert.rejects(e.media.query("UPDATE social_sync.cover_bindings SET continuity_ready=true"), /permission denied/);
});

test("collection own-source timestamps retain the strict original qualification", async t => {
  const e = await coverTestEngine(t), row = await e.collection();
  const { collectionKey } = await import("../scripts/social-sync/collection.ts");
  const source = { kind: "collection" as const, key: collectionKey(row.target), platform: "bilibili" as const, url: "https://i0.hdslb.com/season.png", observedAt: row.observedAt };
  await e.writer.collectionSource(source, "retained");
  const files = (await prepareCover(source, await coverTestImage())).files;
  await e.writer.register(source, "retained", files);
  assert.equal((await e.reader.query("SELECT * FROM social_sync.cover_bindings")).rows.length, 1);
  row.observedAt = new Date(Date.parse(row.observedAt) + 1).toISOString();
  await e.worker.query("SELECT * FROM social_sync.ingest_collection($1,$2,$3)", [source.key, hash(JSON.stringify(row)), JSON.stringify(row)]);
  assert.equal((await e.reader.query("SELECT * FROM social_sync.cover_bindings")).rows.length, 0);
  await assert.rejects(e.writer.register(source, "retained", files), /NB_SOCIAL_COVER_SOURCE_CHANGED/);
});

test("rollback restores exact-reference qualification without deleting current bindings or resurrecting removed ones", async t => {
  const e = await setup(t); await e.ingest("https://i0.hdslb.com/example.png?reference=pending");
  assert.equal((await e.cover())!.id, e.oldId);
  const before = (await e.db.query("SELECT asset_id,source_sha256,files FROM social_sync.cover_bindings ORDER BY display_mode")).rows;
  await e.db.exec(await readFile(new URL("../database/social-cover-rotation-rollback.sql", import.meta.url), "utf8"));
  assert.equal(await e.cover(), null);
  assert.deepEqual((await e.db.query("SELECT asset_id,source_sha256,files FROM social_sync.cover_bindings ORDER BY display_mode")).rows, before);
  assert.equal((await e.db.query("SELECT * FROM pg_proc WHERE oid=to_regprocedure('social_sync.guard_cover_binding()')")).rows.length, 0);
  await assert.rejects(e.media.query("SELECT continuity_ready FROM social_sync.cover_bindings"), /does not exist/);
  await e.writer.register(publicationCoverSource(e.row), "retained", e.prepared.files);
  assert(await e.cover());
});

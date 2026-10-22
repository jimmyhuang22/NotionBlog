import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import sharp from "sharp";
import type { StoredMedia } from "../contracts/sync.ts";
import { WEBSITE_SCHEMA_DIGEST, type WebsiteRecord } from "../contracts/website-sync.ts";
import { generateAndRegisterThumbnails } from "../scripts/media-thumbnails/batch.ts";
import { createVerifiedThumbnailCache, type VerifiedThumbnailCache } from "../scripts/media-thumbnails/cache.ts";
import { thumbnailEncodingRecipe } from "../scripts/media-thumbnails/encode.ts";
import { readThumbnail, type ThumbnailWidth } from "../src/server/database/thumbnail-index.ts";
import type { SqlExecutor } from "../src/server/database/sql.ts";
import { verifyMediaBytes, type ObjectStorage } from "../src/server/database/storage.ts";
import { configDigest, mediaIdentity } from "../src/server/database/validation.ts";
import { createWebsiteMediaSourceWriter, readWebsiteMediaSource } from "../src/server/database/website-media-sources.ts";
import { createWebsiteWriter } from "../src/server/database/website-writer.ts";
import { hybridMediaResponse } from "../src/server/media/hybrid.ts";
import { sourceFingerprint, type MediaSourceBinding } from "../src/server/media/notion-source.ts";
import { thumbnailMediaResponse } from "../src/server/media/thumbnail.ts";

const OWNER = "00000000000000000000000000000010";
const SOURCE = "00000000000000000000000000000020";
const SOURCE_URL = "https://fictional-images.example.test/preview-source.png";
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const unavailable = (error: unknown) => error instanceof Error && "code" in error && error.code === "CONTENT_UNAVAILABLE";

async function fixture() {
  const width = 1000, height = 500;
  const raw = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const offset = (y * width + x) * 4;
    raw[offset] = x % 256; raw[offset + 1] = y % 256; raw[offset + 2] = (x + y * 3) % 256; raw[offset + 3] = 255;
  }
  const original = await sharp(raw, { raw: { width, height, channels: 4 } }).png().toBuffer();
  const originalSha = sha(original);
  const assetId = mediaIdentity(OWNER, "cover", originalSha);
  const parent: StoredMedia = { assetId, ownerPageId: OWNER, objectKey: `sha256/${originalSha}`, sha256: originalSha,
    byteSize: original.byteLength, mime: "image/png", width, height };
  const binding: MediaSourceBinding = { assetId, ownerPageId: OWNER, sha256: originalSha, locator: { kind: "cover" },
    delivery: "notion", sourceFingerprint: sourceFingerprint(SOURCE_URL, false) };
  const image = { id: assetId, src: `/media/v2/${assetId}`, alt: "Fictional generated gradient", width, height };
  const record: WebsiteRecord = {
    detail: {
      item: { id: OWNER, kind: "status", slug: OWNER, href: `/status#${OWNER}`, title: "Fictional thumbnail flow",
        summary: null, tags: [], cover: image, updatedAt: null, recordedAt: null, text: [] },
      document: { blocks: [{ id: "fictional-image", type: "image", image, caption: [] }], toc: [], completeness: "complete" },
    },
    evidence: { sourceKey: "fictional-status", dataSourceId: SOURCE, databaseParentId: null, courseId: null, parentId: null, ordinal: 0 },
  };
  const sources = [{ key: "fictional-status", kind: "status", mode: "all", dataSourceId: SOURCE, databaseParentId: null, pageId: null }];
  const digest = configDigest({ sources, permits: [] });
  const db = await PGlite.create();
  await db.exec(await readFile(new URL("../database/website-migrations/001_website.sql", import.meta.url), "utf8"));
  await db.query("UPDATE nb_v2.state SET schema_digest=$1", [WEBSITE_SCHEMA_DIGEST]);
  await db.exec(await readFile(new URL("../database/website-media-migrations/001_website_media_sources.sql", import.meta.url), "utf8"));
  await db.exec(await readFile(new URL("../supabase/migrations/20261011123536_media_thumbnails.sql", import.meta.url), "utf8"));
  const role = (name: "nb_reader" | "nb_writer"): SqlExecutor => ({
    query: <T>(sql: string, values?: unknown[]) => db.transaction(async tx => {
      await tx.exec(`SET LOCAL ROLE ${name}`);
      return tx.query<T>(sql, values);
    }),
  });
  const reader = role("nb_reader"), writerDb = role("nb_writer");
  const writer = createWebsiteWriter(writerDb), sourceWriter = createWebsiteMediaSourceWriter(writerDb);
  await db.query("SELECT nb_v2_api.configure_policy($1,600,$2::jsonb,'[]'::jsonb)", [digest, JSON.stringify(sources)]);
  async function publish() {
    const lease = await writer.begin(randomUUID(), digest);
    await writer.stage(lease, [record], [parent]);
    await sourceWriter.stage(lease, [binding]);
    await writer.promote(lease, { records: 1, media: 1, complete: true });
    return lease;
  }
  const state = { liveAllowed: true, liveFingerprint: binding.sourceFingerprint, downloads: 0, resolves: 0,
    puts: 0, immutableConflicts: 0, reads: 0, originalFallbacks: 0, objects: new Map<string, Uint8Array>() };
  // Transport and Notion qualification are explicit local simulations. Core SQL,
  // index SQL, native image encoding and HTTP Response byte construction are real.
  const storage: ObjectStorage = {
    async read(media) {
      state.reads++;
      const bytes = state.objects.get(media.objectKey);
      assert.ok(bytes, "the simulated transport must contain the requested private object");
      verifyMediaBytes(media, bytes);
      return Uint8Array.from(bytes);
    },
    async put(media, bytes) {
      state.puts++;
      verifyMediaBytes(media, bytes);
      const existing = state.objects.get(media.objectKey);
      if (existing) {
        state.immutableConflicts++;
        verifyMediaBytes(media, existing);
        assert.deepEqual(existing, Uint8Array.from(bytes));
      } else state.objects.set(media.objectKey, Uint8Array.from(bytes));
    },
  };
  const resolve = async (candidate: MediaSourceBinding) => {
    state.resolves++;
    assert.deepEqual(candidate, binding);
    return state.liveAllowed ? { url: SOURCE_URL, sourceFingerprint: state.liveFingerprint } : null;
  };
  const originalResponse = () => hybridMediaResponse(assetId, {
    version: "v2", read: id => readWebsiteMediaSource(reader, id), resolve, storage: () => storage,
  });
  const response = (widthCap: ThumbnailWidth, objectStorage = storage) => thumbnailMediaResponse(assetId, widthCap, {
    read: (id, width) => readThumbnail(reader, "v2", id, width), resolve, storage: () => objectStorage,
    original: () => { state.originalFallbacks++; return originalResponse(); },
  });
  const batch = (runId: string, cache?: VerifiedThumbnailCache) => generateAndRegisterThumbnails({ version: "v2", runId, assetIds: [assetId],
    db: reader, registrationDb: writerDb, storage, resolve, cache,
    download: async url => { assert.equal(url, SOURCE_URL); state.downloads++; return { bytes: Uint8Array.from(original), mime: "image/png" }; },
  });
  async function coreSnapshot() {
    return {
      state: (await db.query("SELECT row_to_json(s) AS state FROM nb_v2.state s")).rows,
      runs: (await db.query("SELECT row_to_json(r) AS run FROM nb_v2.runs r ORDER BY id")).rows,
      records: (await db.query("SELECT row_to_json(r) AS record FROM nb_v2.records r ORDER BY run_id,id")).rows,
      media: (await db.query("SELECT row_to_json(m) AS media FROM nb_v2.media m ORDER BY run_id,asset_id")).rows,
    };
  }
  async function checkedBatch(runId: string, cache?: VerifiedThumbnailCache) {
    const before = await coreSnapshot();
    const report = await batch(runId, cache);
    assert.deepEqual(await coreSnapshot(), before, "derivatives must not change core content, leases, revision, generation or TTL");
    assert.equal(sha(original), originalSha, "the source original remains unchanged");
    assert.deepEqual((await readWebsiteMediaSource(reader, assetId))?.media, parent);
    return report;
  }
  async function checkedResponse(widthCap: ThumbnailWidth, runId: string) {
    const projection = await readThumbnail(reader, "v2", assetId, widthCap);
    assert.equal(projection?.runId, runId); assert.ok(projection.thumbnail);
    const result = await response(widthCap);
    assert.equal(result.status, 200);
    assert.equal(result.headers.get("Content-Type"), "image/webp");
    assert.equal(result.headers.get("Cache-Control"), "private, max-age=86400, must-revalidate");
    assert.equal(result.headers.get("Referrer-Policy"), "no-referrer");
    const bytes = new Uint8Array(await result.arrayBuffer());
    assert.equal(Number(result.headers.get("Content-Length")), bytes.byteLength);
    assert.equal(sha(bytes), projection.thumbnail.sha256);
    verifyMediaBytes(projection.thumbnail, bytes);
    const pixels = await sharp(bytes).raw().toBuffer({ resolveWithObject: true });
    assert.equal(pixels.info.width, widthCap);
    assert.equal(pixels.info.height, widthCap / 2);
    assert.equal(pixels.info.width, projection.thumbnail.width);
    assert.equal(pixels.info.height, projection.thumbnail.height);
    return projection.thumbnail;
  }
  return { db, reader, writerDb, storage, parent, original, binding, assetId, state, publish, response, originalResponse,
    checkedBatch, checkedResponse, coreSnapshot };
}

test("local v2 SQL publication, real thumbnail batch and qualified HTTP bytes work together", async t => {
  const f = await fixture();
  try {
    const first = await f.publish();
    await t.test("the published generation starts without derivatives and uses its qualified original", async () => {
      const before = await f.coreSnapshot();
      const projection = await readThumbnail(f.reader, "v2", f.assetId, 400);
      assert.equal(projection?.runId, first.runId); assert.equal(projection?.thumbnail, null);
      const response = await f.response(400);
      assert.equal(response.status, 302); assert.equal(response.headers.get("Location"), SOURCE_URL);
      assert.equal(f.state.originalFallbacks, 1); assert.equal(f.state.reads, 0);
      assert.deepEqual(await f.coreSnapshot(), before);
      await assert.rejects(readThumbnail(f.writerDb, "v2", f.assetId, 400), unavailable, "writer has no published-reader permission");
    });
    await t.test("a native batch registers two profiles, serves verified pixel dimensions and leaves the original entry intact", async () => {
      const report = await f.checkedBatch(first.runId);
      assert.equal(report.processed, 1); assert.equal(report.registered, 2); assert.equal(report.alreadyPresent, 0);
      assert.equal(report.skipped, 0); assert.equal(f.state.downloads, 1); assert.equal(f.state.puts, 2);
      const four = await f.checkedResponse(400, first.runId), eight = await f.checkedResponse(800, first.runId);
      assert.equal(report.thumbnailBytes, four.byteSize + eight.byteSize);
      assert.equal(report.uploadAttemptBytes, report.thumbnailBytes);
      assert.equal(f.state.objects.size, 2); assert.equal(f.state.objects.has(f.parent.objectKey), false);
      const beforeReads = f.state.reads;
      const original = await f.originalResponse();
      assert.equal(original.status, 302); assert.equal(original.headers.get("Location"), SOURCE_URL);
      assert.equal(f.state.reads, beforeReads, "the original path remains a source redirect, not a thumbnail/object read");
      assert.equal(f.state.originalFallbacks, 1, "available variants do not fall back to originals");
    });
    await t.test("complete retries verify mapped bytes without downloads or upload attempts", async () => {
      const downloads = f.state.downloads, puts = f.state.puts;
      const report = await f.checkedBatch(first.runId);
      assert.equal(report.registered, 0); assert.equal(report.alreadyPresent, 2); assert.equal(report.uploadAttemptBytes, 0);
      assert.equal(f.state.downloads, downloads); assert.equal(f.state.puts, puts);
    });
    await t.test("only an absent width variant falls back, and an object error never does", async () => {
      // Administrator-only local fixture mutation simulates a manifest where one
      // width has not yet been generated. No production writer has delete rights.
      await f.db.query("DELETE FROM nb_thumbnails.media WHERE version='v2' AND run_id=$1 AND parent_asset_id=$2 AND width_cap=400", [first.runId, f.assetId]);
      const beforeFallbacks = f.state.originalFallbacks;
      const missing = await f.response(400);
      assert.equal(missing.status, 302); assert.equal(missing.headers.get("Location"), SOURCE_URL);
      assert.equal(f.state.originalFallbacks, beforeFallbacks + 1);
      const eight = await f.checkedResponse(800, first.runId);
      assert.equal(f.state.originalFallbacks, beforeFallbacks + 1);
      const saved = f.state.objects.get(eight.objectKey)!;
      f.state.objects.set(eight.objectKey, new Uint8Array(saved.byteLength));
      // An already verified copy stays correct even if the simulated remote
      // object breaks later; a cold storage instance must still reject corruption.
      const cached = await f.response(800);
      assert.equal(cached.status, 200);
      verifyMediaBytes(eight, new Uint8Array(await cached.arrayBuffer()));
      await assert.rejects(f.response(800, { ...f.storage }), unavailable);
      assert.equal(f.state.originalFallbacks, beforeFallbacks + 1, "bad object bytes cannot trigger the original fallback");
      f.state.objects.set(eight.objectKey, saved);
      const report = await f.checkedBatch(first.runId);
      assert.equal(report.registered, 1); assert.equal(report.alreadyPresent, 1);
      await f.checkedResponse(400, first.runId);
    });
    await t.test("live source withdrawal and SQL owner denial return 404 without releasing stored previews", async () => {
      let reads = f.state.reads;
      const fallback = f.state.originalFallbacks;
      f.state.liveAllowed = false;
      const sourceWithdrawn = await f.response(400);
      assert.equal(sourceWithdrawn.status, 404); assert.equal(await sourceWithdrawn.text(), "");
      assert.equal(f.state.reads, reads); assert.equal(f.state.originalFallbacks, fallback);
      f.state.liveAllowed = true;
      await f.db.query("SELECT nb_v2_api.set_denied($1,true)", [OWNER]);
      reads = f.state.reads;
      for (const widthCap of [400, 800] as const) {
        const withdrawn = await f.response(widthCap);
        assert.equal(withdrawn.status, 404); assert.equal(withdrawn.headers.get("Location"), null);
      }
      assert.equal(f.state.reads, reads); assert.equal(f.state.originalFallbacks, fallback);
      assert.equal((await f.originalResponse()).status, 404);
      await f.db.query("SELECT nb_v2_api.set_denied($1,false)", [OWNER]);
    });
    await t.test("publishing a new run never reuses the old manifest, then rebuilding is idempotent", async () => {
      const beforePublish = await f.coreSnapshot();
      const next = await f.publish();
      assert.notDeepEqual(await f.coreSnapshot(), beforePublish, "only the actual content publication changes the core generation");
      assert.notEqual(next.runId, first.runId);
      const objectCount = f.state.objects.size, reads = f.state.reads;
      for (const widthCap of [400, 800] as const) {
        const projection = await readThumbnail(f.reader, "v2", f.assetId, widthCap);
        assert.equal(projection?.runId, next.runId); assert.equal(projection?.thumbnail, null);
        assert.equal((await f.response(widthCap)).status, 302);
      }
      assert.equal(f.state.reads, reads, "old bytes in Storage do not make old mappings eligible");
      const historical = await f.db.query<{ count: number }>("SELECT count(*)::integer AS count FROM nb_thumbnails.media WHERE version='v2' AND run_id=$1", [first.runId]);
      assert.equal(historical.rows[0].count, 2, "the old manifest still exists but is not current");
      await assert.rejects(generateAndRegisterThumbnails({ version: "v2", runId: first.runId, assetIds: [f.assetId],
        db: f.reader, registrationDb: f.writerDb,
        storage: { read: async () => assert.fail("stale generation cannot read objects"), put: async () => assert.fail("stale generation cannot upload") },
        resolve: async () => assert.fail("stale generation cannot resolve a source"),
        download: async () => assert.fail("stale generation cannot download") }), unavailable);
      const rebuilt = await f.checkedBatch(next.runId);
      assert.equal(rebuilt.registered, 2); assert.equal(rebuilt.alreadyPresent, 0);
      assert.ok(rebuilt.uploadAttemptBytes > 0, "immutable object retries still have upload request bodies");
      assert.equal(f.state.objects.size, objectCount); assert.ok(f.state.immutableConflicts >= 2);
      await f.checkedResponse(400, next.runId); await f.checkedResponse(800, next.runId);
      const downloads = f.state.downloads, puts = f.state.puts;
      const retried = await f.checkedBatch(next.runId);
      assert.equal(retried.registered, 0); assert.equal(retried.alreadyPresent, 2); assert.equal(retried.uploadAttemptBytes, 0);
      assert.equal(f.state.downloads, downloads); assert.equal(f.state.puts, puts);
    });
  } finally { await f.db.close(); }
});

test("a verified derivative cache re-registers a new qualified SQL generation without original or upload transport", async () => {
  const f = await fixture();
  try {
    const cache = createVerifiedThumbnailCache(thumbnailEncodingRecipe());
    const first = await f.publish();
    const created = await f.checkedBatch(first.runId, cache);
    assert.equal(created.registered, 2); assert.equal(f.state.puts, 2); assert.equal(f.state.downloads, 1);
    const saved = JSON.parse(JSON.stringify(cache.snapshot()));
    const next = await f.publish();
    assert.notEqual(next.runId, first.runId);
    assert.equal((await readThumbnail(f.reader, "v2", f.assetId, 400))?.thumbnail, null,
      "the previous generation's SQL mapping is never implicitly eligible");
    assert.equal((await f.response(400)).status, 302);
    const downloads = f.state.downloads, puts = f.state.puts;
    const restored = createVerifiedThumbnailCache(thumbnailEncodingRecipe(), saved);
    const report = await f.checkedBatch(next.runId, restored);
    assert.equal(report.registered, 2); assert.equal(report.alreadyPresent, 0); assert.equal(report.uploadAttemptBytes, 0);
    assert.equal(f.state.downloads, downloads); assert.equal(f.state.puts, puts); assert.equal(f.state.immutableConflicts, 0);
    for (const width of [400, 800] as const) await f.checkedResponse(width, next.runId);
    const historic = await f.db.query<{count:number}>("SELECT count(*)::integer AS count FROM nb_thumbnails.media WHERE version='v2' AND run_id=$1", [first.runId]);
    assert.equal(historic.rows[0].count, 2, "re-registering does not modify the old generation");
    const retry = await f.checkedBatch(next.runId, restored);
    assert.equal(retry.registered, 0); assert.equal(retry.alreadyPresent, 2); assert.equal(retry.uploadAttemptBytes, 0);
    await f.db.query("SELECT nb_v2_api.set_denied($1,true)", [OWNER]);
    const reads = f.state.reads;
    await assert.rejects(f.checkedBatch(next.runId, restored), unavailable);
    assert.equal(f.state.reads, reads, "cached hints cannot bypass current SQL withdrawal");
    assert.equal(f.state.puts, puts); assert.equal(f.state.downloads, downloads);
  } finally {await f.db.close();}
});

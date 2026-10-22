import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { thumbnailDatabase, thumbnailSample } from "./helpers/published-thumbnails.ts";
import { createPublishedThumbnailReader, createPublishedThumbnailRegistrar, verifyPublishedThumbnails } from "../src/server/database/published-thumbnails.ts";
import { publishedThumbnailResponse } from "../src/server/media/published-thumbnail.ts";
import { installPublishedThumbnails } from "../scripts/website-sync/published-thumbnail-migration.ts";
import { createIncrementalPublisher, preparePublicationDelta } from "../src/server/database/incremental-publication.ts";
import { websiteMediaResponse } from "../src/server/database/website-media.ts";
import { publicationReader } from "../src/server/database/publication.ts";
import { exportPublicationArchive, restorePublicationArchive, validatePublicationArchive } from "../src/server/database/publication-archive.ts";
import protocol from "../database/published-thumbnails-protocol.json" with {type: "json"};
import studyProtocol from "../database/website-study-protocol.json" with {type: "json"};
import { studyFixture, studyId } from "./helpers/study-runtime.ts";
import { configDigest, mediaIdentity } from "../src/server/database/website-validation.ts";
import { publicationWriter } from "../src/server/database/publication.ts";

test("published thumbnail delivery and recovery use current asset qualification without source checks", async t => {
  const s = await thumbnailDatabase(), f = await thumbnailSample(s), read = createPublishedThumbnailReader(s.reader);
  const ports = {read, storage: () => ({read: async m => f.bytes.get(m.objectKey)!, put: async () => assert.fail("No object upload")})} satisfies Parameters<typeof publishedThumbnailResponse>[2];
  try {
    await t.test("immutable migration bytes, repeat install and minimal reader privileges", async () => {
      const sql = await readFile(new URL(`../supabase/migrations/${protocol.migration.file}`, import.meta.url));
      assert.equal(createHash("sha256").update(sql).digest("hex"), protocol.migration.sha256);
      await installPublishedThumbnails(s.owner); await verifyPublishedThumbnails(s.reader);
      for (const role of ["anon", "authenticated", "service_role", "nb_writer"]) {
        await assert.rejects(verifyPublishedThumbnails(s.role(role)));
        await assert.rejects(createPublishedThumbnailReader(s.role(role))(f.media.assetId, 400));
      }
      await assert.rejects(s.reader.query("SELECT * FROM nb_thumbnails.media"));
      await assert.rejects(s.reader.query("COMMENT ON FUNCTION nb_publication_api.read_thumbnail(text,integer,text) IS 'changed'"));
      assert.equal((await s.db.query<{n: number}>("SELECT count(*)::integer AS n FROM nb_thumbnails.migrations")).rows[0].n, 1);
    });
    await t.test("400 and 800 variants each use two SQL reads and one stored object read", async () => {
      for (const width of [400, 800] as const) {
        let queries = 0, objects = 0;
        const reader = createPublishedThumbnailReader({query: async (sql, values) => {queries++; return s.reader.query(sql, values);}});
        const response = await publishedThumbnailResponse(f.media.assetId, width, {...ports, read: reader, storage: () => ({...ports.storage(), read: async m => {objects++; return f.bytes.get(m.objectKey)!;}})});
        assert.equal(response.status, 200); assert.equal(response.headers.get("Content-Type"), "image/webp");
        assert.equal(response.headers.get("Cache-Control"), "private, max-age=86400, must-revalidate"); assert.equal(response.headers.has("Location"), false);
        assert.deepEqual(Buffer.from(await response.arrayBuffer()), f.bytes.get(f.variants.get(width)!.objectKey));
        assert.equal(queries, 2); assert.equal(objects, 1);
      }
    });
    await t.test("expired historical generations remain reusable after a delta publication", async () => {
      await s.db.query("UPDATE nb_v2.runs SET valid_until=clock_timestamp()-interval '1 second'");
      const publisher = createIncrementalPublisher(s.writer), changed = structuredClone(f.record); changed.detail.item.title = "Incremental title";
      const delta = preparePublicationDelta({expectedRevision: (await publisher.state()).publicationRevision, configDigest: f.digest, upserts: [changed], media: [], withdrawals: []});
      const receipt = await publisher.publish(randomUUID(), delta), projection = await read(f.media.assetId, 400);
      assert.ok(projection); assert.equal(projection.publicationRevision, receipt.publicationRevision);
      assert.equal(projection.thumbnail!.sha256, f.variants.get(400)!.sha256);
      assert.equal((await s.db.query<{n: number}>("SELECT count(*)::integer AS n FROM nb_thumbnails.media WHERE run_id=$1", [receipt.operationId])).rows[0].n, 0);
      assert.equal((await publishedThumbnailResponse(f.media.assetId, 400, ports)).status, 200);
    });
    await t.test("missing variants return the independent original with the same two-read guard", async () => {
      try {
        await s.db.query("DELETE FROM nb_thumbnails.media WHERE width_cap=800");
        const response = await publishedThumbnailResponse(f.media.assetId, 800, ports);
        assert.equal(response.headers.get("Content-Type"), "image/png"); assert.deepEqual(Buffer.from(await response.arrayBuffer()), f.bytes.get(f.media.objectKey));
      } finally {await s.db.query("INSERT INTO nb_thumbnails.media VALUES('v2',$1,$2,$3,$4,800,$5::jsonb)", [f.runId, f.media.assetId, f.media.sha256, "b".repeat(64), JSON.stringify(f.variants.get(800))]);}
    });
    await t.test("published writer registration is bounded, immutable and idempotent without changing publication", async () => {
      const state = await createIncrementalPublisher(s.writer).state(), register = createPublishedThumbnailRegistrar(s.writer);
      const input = {expectedRevision: state.publicationRevision, parentAssetId: f.media.assetId, parentSha256: f.media.sha256, widthCap: 800 as const, thumbnail: f.variants.get(800)!};
      await register.register(input); await register.register(input);
      assert.deepEqual(await createIncrementalPublisher(s.writer).state(), state);
      assert.equal((await read(f.media.assetId, 800))!.thumbnail!.sha256, input.thumbnail.sha256);
      for (const role of ["nb_reader", "anon", "authenticated", "service_role"]) await assert.rejects(createPublishedThumbnailRegistrar(s.role(role)).register(input));
      await assert.rejects(register.register({...input, expectedRevision: `${randomUUID()}:0`}));
      await assert.rejects(register.register({...input, parentSha256: "d".repeat(64)}));
      await assert.rejects(register.register({...input, thumbnail: {...input.thumbnail, byteSize: f.media.byteSize}}));
      await assert.rejects(register.register({...input, thumbnail: {...input.thumbnail, width: 129}}));
      await assert.rejects(register.register({...input, thumbnail: f.variants.get(400)!}));
      await assert.rejects(s.writer.query("SELECT nb_publication_api.register_thumbnail($1,$2,$3,$4,$5::jsonb,$6)", [input.expectedRevision, input.parentAssetId, input.parentSha256, input.widthCap, JSON.stringify(input.thumbnail), "0".repeat(64)]));
    });
    await t.test("oversized historical variants explicitly select the stored original", async () => {
      try {
        await s.db.query("UPDATE nb_thumbnails.media SET descriptor=jsonb_set(descriptor,'{byteSize}',$1::jsonb) WHERE width_cap=400", [JSON.stringify(f.media.byteSize)]);
        assert.equal((await read(f.media.assetId, 400))!.thumbnail, null);
        assert.equal((await publishedThumbnailResponse(f.media.assetId, 400, ports)).headers.get("Content-Type"), "image/png");
      } finally {await s.db.query("UPDATE nb_thumbnails.media SET descriptor=$1::jsonb WHERE width_cap=400", [JSON.stringify(f.variants.get(400))]);}
    });
    await t.test("unknown assets are 404 without touching storage", async () => {
      const response = await publishedThumbnailResponse(`a1.${"0".repeat(64)}`, 400, {...ports, storage: () => assert.fail("Missing asset touched storage")});
      assert.equal(response.status, 404);
    });
    await t.test("index descriptor corruption and byte corruption fail without any source fallback", async () => {
      try {
        await s.db.query("UPDATE nb_thumbnails.media SET descriptor=jsonb_set(descriptor,'{ownerPageId}','\"other-owner\"') WHERE width_cap=400");
        await assert.rejects(publishedThumbnailResponse(f.media.assetId, 400, {...ports, storage: () => assert.fail("Bad index read object")}));
      } finally {await s.db.query("UPDATE nb_thumbnails.media SET descriptor=$1::jsonb WHERE width_cap=400", [JSON.stringify(f.variants.get(400))]);}
      await assert.rejects(publishedThumbnailResponse(f.media.assetId, 400, {...ports, storage: () => ({...ports.storage(), read: async () => Buffer.from("Broken image")})}));
    });
    await t.test("central withdrawal during a slow object read prevents the response body", async () => {
      try {
        const response = await publishedThumbnailResponse(f.media.assetId, 400, {...ports, storage: () => ({...ports.storage(), read: async m => {
          await s.db.query("INSERT INTO nb_v2.denied VALUES($1)", [f.media.ownerPageId]); return f.bytes.get(m.objectKey)!;
        }})});
        assert.equal(response.status, 404); assert.equal((await response.arrayBuffer()).byteLength, 0);
      } finally {await s.db.query("DELETE FROM nb_v2.denied WHERE id=$1", [f.media.ownerPageId]);}
    });
    await t.test("publication changes during the object read require a fresh request", async () => {
      const revision = (await s.db.query<{revision: number}>("SELECT revision FROM nb_v2.state WHERE singleton")).rows[0].revision;
      try {
        const response = await publishedThumbnailResponse(f.media.assetId, 400, {...ports, storage: () => ({...ports.storage(), read: async m => {
          await s.db.query("UPDATE nb_v2.state SET revision=revision+1"); return f.bytes.get(m.objectKey)!;
        }})});
        assert.equal(response.status, 404);
      } finally {await s.db.query("UPDATE nb_v2.state SET revision=$1", [revision]);}
    });
    await t.test("broken deployment identity or missing lookup index is unavailable", async () => {
      try {
        await s.db.query("COMMENT ON FUNCTION nb_publication_api.read_thumbnail(text,integer,text) IS 'wrong-version'");
        await assert.rejects(read(f.media.assetId, 400)); await assert.rejects(exportPublicationArchive(s.owner));
      } finally {await s.db.query(`COMMENT ON FUNCTION nb_publication_api.read_thumbnail(text,integer,text) IS '${protocol.migration.sha256}'`);}
      try {await s.db.query("DROP INDEX nb_thumbnails.published_parent_idx"); await assert.rejects(read(f.media.assetId, 400));}
      finally {await s.db.query("CREATE INDEX published_parent_idx ON nb_thumbnails.media(version,parent_asset_id,parent_sha,width_cap,run_id)");}
    });
    await t.test("backup preserves the optional deployment identity and rejects mismatching targets", async () => {
      const archive = await exportPublicationArchive(s.owner); assert.equal(archive.thumbnails!.publishedMigrationDigest, protocol.migration.sha256);
      const wrong = structuredClone(archive); wrong.thumbnails!.publishedMigrationDigest = "c".repeat(64);
      assert.throws(() => validatePublicationArchive(wrong));
      const target = await thumbnailDatabase(), old = await thumbnailDatabase(false);
      try {
        await assert.rejects(restorePublicationArchive(old.owner, archive));
        await restorePublicationArchive(target.owner, archive);
        const restored = await exportPublicationArchive(target.owner);
        assert.equal(restored.thumbnails!.publishedMigrationDigest, protocol.migration.sha256);
        assert.deepEqual(restored.thumbnails!.media, archive.thumbnails!.media);
        assert.equal(restored.publication[0].run_id, null); await assert.rejects(createPublishedThumbnailReader(target.reader)(f.media.assetId, 400));
      } finally {await target.db.close(); await old.db.close();}
    });
    await t.test("ordinary original delivery remains independent and unchanged", async () => {
      const response = await websiteMediaResponse(f.media.assetId, publicationReader(s.reader, "published"), ports.storage);
      assert.equal(response.status, 200); assert.deepEqual(Buffer.from(await response.arrayBuffer()), f.bytes.get(f.media.objectKey));
    });
    await t.test("a changed original fingerprint cannot acquire the historical variant", async () => {
      const changed = {...f.media, sha256: "c".repeat(64), objectKey: `sha256/${"c".repeat(64)}`};
      const run = (await read(f.media.assetId, 400))!.publicationRevision.split(":")[0];
      try {
        await s.db.query("UPDATE nb_v2.media SET descriptor=$1::jsonb WHERE run_id=$2", [JSON.stringify(changed), run]);
        assert.equal((await read(f.media.assetId, 400))!.thumbnail, null);
      } finally {await s.db.query("UPDATE nb_v2.media SET descriptor=$1::jsonb WHERE run_id=$2", [JSON.stringify(f.media), run]);}
    });
    await t.test("removing the published image reference makes historical thumbnails inaccessible", async () => {
      const publisher = createIncrementalPublisher(s.writer), changed = structuredClone(f.record); changed.detail.item.cover = null;
      await publisher.publish(randomUUID(), preparePublicationDelta({expectedRevision: (await publisher.state()).publicationRevision,
        configDigest: f.digest, upserts: [changed], media: [], withdrawals: []}));
      assert.equal(await read(f.media.assetId, 400), null);
      assert.equal((await publishedThumbnailResponse(f.media.assetId, 400, {...ports, storage: () => assert.fail("Removed image fetched bytes")})).status, 404);
    });
  } finally {await s.db.close();}
});

test("a withdrawn course stops its descendant image and thumbnail before object access", async () => {
  const s = await thumbnailDatabase(), f = await thumbnailSample(s), study = studyFixture();
  try {
    await s.db.exec(await readFile(new URL(`../database/website-study-migrations/${studyProtocol.migration.file}`, import.meta.url), "utf8"));
    await s.db.query("UPDATE nb_v2.migrations SET digest=$1 WHERE version=$2", [studyProtocol.migration.sha256, studyProtocol.migration.version]);
    const sources = [{key: "courses", kind: "course", mode: "all", dataSourceId: studyId(10), databaseParentId: null, pageId: null},
      {key: "notes", kind: "study-note", mode: "course-descendants", dataSourceId: studyId(10), databaseParentId: null, pageId: null}], digest = configDigest(sources);
    await s.db.query("SELECT nb_v2_api.configure_policy($1,600,$2::jsonb,'[]')", [digest, JSON.stringify(sources)]);
    const media = {...f.media, ownerPageId: studyId(2), assetId: mediaIdentity(studyId(2), "cover", f.media.sha256)};
    study.checkpoint.entries[1].record.detail.item.cover = {id: media.assetId, src: `/media/v2/${media.assetId}`, alt: "Study fixture", width: media.width, height: media.height};
    const publisher = publicationWriter(s.writer, "published"), lease = await publisher.begin(randomUUID(), digest);
    await publisher.stage(lease, study.checkpoint.entries.map(e => e.record), [media]); await publisher.promote(lease, {records: 2, media: 1, complete: true});
    const variant = {...f.variants.get(400)!, ownerPageId: studyId(2)};
    variant.assetId = mediaIdentity(studyId(2), `thumbnail:400:${media.assetId}`, variant.sha256);
    await s.db.query("INSERT INTO nb_thumbnails.media VALUES('v2',$1,$2,$3,$4,400,$5::jsonb)", [lease.runId, media.assetId, media.sha256, "b".repeat(64), JSON.stringify(variant)]);
    const read = createPublishedThumbnailReader(s.reader); assert.ok((await read(media.assetId, 400))!.thumbnail);
    await s.db.query("SELECT nb_v2_api.set_denied($1,true)", [studyId(1)]);
    assert.equal(await read(media.assetId, 400), null);
    assert.equal((await publishedThumbnailResponse(media.assetId, 400, {read, storage: () => assert.fail("Withdrawn ancestor read object")})).status, 404);
  } finally {await s.db.close();}
});

test("publication archives preserve 1600 extension identities and require matching empty targets", async () => {
  const source = await thumbnailDatabase(), target = await thumbnailDatabase(), old = await thumbnailDatabase();
  const course = (await import("../database/course-cover-thumbnails-protocol.json", { with: { type: "json" } })).default;
  const body = (await import("../database/body-image-thumbnails-protocol.json", { with: { type: "json" } })).default;
  // Archive-format fixture only. Real migration, qualification and encoder behavior have separate tests.
  const extensions = async (s: typeof source) => {
    await s.db.exec("CREATE TABLE nb_thumbnails.extensions(version text PRIMARY KEY,digest text); CREATE TABLE nb_thumbnails.body_extensions(version text PRIMARY KEY,digest text); ALTER TABLE nb_thumbnails.media DROP CONSTRAINT media_width_cap_check; ALTER TABLE nb_thumbnails.media ADD CONSTRAINT media_width_cap_check CHECK(width_cap IN(400,800) OR version='v2' AND width_cap=1600)");
    await s.db.query("INSERT INTO nb_thumbnails.extensions VALUES($1,$2)", [course.migration.version, course.migration.sha256]);
    await s.db.query("INSERT INTO nb_thumbnails.body_extensions VALUES($1,$2)", [body.migration.version, body.migration.sha256]);
  };
  try {
    const f = await thumbnailSample(source); await extensions(source); await extensions(target);
    const variant = { ...f.variants.get(800)!, width: 1600, height: 900, sha256: "c".repeat(64), objectKey: `sha256/${"c".repeat(64)}` };
    variant.assetId = mediaIdentity(variant.ownerPageId, `thumbnail:1600:${f.media.assetId}`, variant.sha256);
    await source.db.query("INSERT INTO nb_thumbnails.media VALUES('v2',$1,$2,$3,$4,1600,$5::jsonb)", [f.runId, f.media.assetId, f.media.sha256, "b".repeat(64), JSON.stringify(variant)]);
    const archive = await exportPublicationArchive(source.owner);
    assert.equal(archive.thumbnails!.body1600MigrationDigest, body.migration.sha256);
    assert.equal(archive.thumbnails!.course1600MigrationDigest, course.migration.sha256);
    const missing = structuredClone(archive); delete missing.thumbnails!.course1600MigrationDigest;
    assert.throws(() => validatePublicationArchive(missing));
    await assert.rejects(restorePublicationArchive(old.owner, archive));
    await restorePublicationArchive(target.owner, archive);
    const restored = await exportPublicationArchive(target.owner);
    assert.deepEqual(restored.thumbnails, archive.thumbnails); assert.equal(restored.publication[0].run_id, null);
  } finally { await source.db.close(); await target.db.close(); await old.db.close(); }
});

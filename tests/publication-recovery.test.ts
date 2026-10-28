import { withPGliteOwnerTransaction } from "../scripts/website-sync/owner-install-session.ts";
import { rollbackFault } from "./helpers/rollback-fault.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import sharp from "sharp";
import { fixtureItems } from "../fixtures/content.ts";
import { WEBSITE_SCHEMA_DIGEST, type WebsiteRecord } from "../contracts/website-sync.ts";
import { publicationWriter, publicationReader } from "../src/server/database/publication.ts";
import { createWebsiteDatabaseRepository } from "../src/server/database/website-repository.ts";
import { configDigest, mediaIdentity } from "../src/server/database/website-validation.ts";
import { createIncrementalPublisher, preparePublicationDelta } from "../src/server/database/incremental-publication.ts";
import { verifyPublishedDelta } from "../src/server/database/incremental-reader.ts";
import { exportWebsiteArchive, restoreWebsiteArchive } from "../src/server/database/website-archive.ts";
import { exportPublicationArchive, restorePublicationArchive, validatePublicationArchive, createPublicationArchiveStore, archivedPublicationObjects, type PublicationArchive } from "../src/server/database/publication-archive.ts";
import { installPublication } from "../scripts/website-sync/publication-migration.ts";
import { installIncrementalPublication } from "../scripts/website-sync/incremental-migration.ts";
import { installIncrementalReaderIsolation } from "../scripts/website-sync/incremental-reader-isolation.ts";
import { installIncrementalWithdrawalRecovery } from "../scripts/website-sync/incremental-withdrawal-recovery.ts";
import { installIncrementalReader } from "../scripts/website-sync/incremental-reader-migration.ts";
import { installFreeze } from "../scripts/website-sync/freeze-migration.ts";
import { createFreezeStore } from "../src/server/database/freeze.ts";
import { verifyMediaBytes } from "../src/server/database/storage.ts";
import { ManagementBackend } from "../scripts/console-management/backend.ts";
import type { SqlExecutor } from "../src/server/database/sql.ts";
import core from "../database/website-protocol.json" with {type: "json"};
import study from "../database/website-study-protocol.json" with {type: "json"};
import mediaProtocol from "../database/website-media-protocol.json" with {type: "json"};
import thumbs from "../database/thumbnail-protocol.json" with {type: "json"};

const image = await sharp({create: {width: 1, height: 1, channels: 4, background: {r: 80, g: 120, b: 160, alpha: 1}}}).png().toBuffer();
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
async function setup(hybrid = true, thumbnails = true) {
  const db = await PGlite.create();
  await db.exec(await readFile(new URL("../database/website-migrations/001_website.sql", import.meta.url), "utf8"));
  await db.query("UPDATE nb_v2.state SET schema_digest=$1", [WEBSITE_SCHEMA_DIGEST]);
  await db.query("UPDATE nb_v2.migrations SET digest=$1 WHERE version='001'", [core.migration.sha256]);
  await db.exec(await readFile(new URL(`../database/website-study-migrations/${study.migration.file}`, import.meta.url), "utf8"));
  await db.query("UPDATE nb_v2.migrations SET digest=$1 WHERE version=$2", [study.migration.sha256, study.migration.version]);
  const owner: SqlExecutor = {query: async <T>(sql: string, values?: unknown[]) => {
    if (sql.startsWith("--")) {await db.exec(sql); return {rows: [] as T[]};}
    return db.query<T>(sql, values);
  }};
  await installPublication(owner); await installIncrementalPublication(owner); await installIncrementalReader(owner);
  if (hybrid) {
    await db.exec(await readFile(new URL(`../database/website-media-migrations/${mediaProtocol.migrations[0].file}`, import.meta.url), "utf8"));
    await db.query("UPDATE nb_v2_media.migrations SET digest=$1", [mediaProtocol.migrations[0].sha256]);
  }
  if (thumbnails) {
    await db.exec(await readFile(new URL(`../supabase/migrations/${thumbs.migrations[0].file}`, import.meta.url), "utf8"));
    await db.query("UPDATE nb_thumbnails.migrations SET digest=$1", [thumbs.migrations[0].sha256]);
  }
  const role = (name: "nb_reader" | "nb_writer"): SqlExecutor => ({query: <T>(sql: string, values?: unknown[]) => db.transaction(async tx => {
    await tx.exec(`SET LOCAL ROLE ${name}`); return tx.query<T>(sql, values);
  })});
  return {db, owner, role};
}
async function sample(s: Awaited<ReturnType<typeof setup>>) {
  const records: WebsiteRecord[] = fixtureItems.post.slice(0, 2).map((raw, ordinal) => {
    const item = structuredClone(raw); item.id = (ordinal + 1).toString(16).padStart(32, "0"); item.cover = null;
    return {detail: {item, document: {blocks: [{id: "p", type: "paragraph", text: [{text: "Private historical content"}]}], toc: [], completeness: "complete"}},
      evidence: {sourceKey: "post", dataSourceId: "fictional-posts", databaseParentId: null, courseId: null, parentId: null, ordinal}};
  });
  const sources = [{key: "post", kind: "post", mode: "all", dataSourceId: "fictional-posts", databaseParentId: null, pageId: null}], digest = configDigest(sources);
  await s.db.query("SELECT nb_v2_api.configure_policy($1,600,$2::jsonb,'[]')", [digest, JSON.stringify(sources)]);
  const owner = records[0].detail.item.id, assetId = mediaIdentity(owner, "cover", sha(image));
  const media = {assetId, ownerPageId: owner, sha256: sha(image), objectKey: `sha256/${sha(image)}`, byteSize: image.length, mime: "image/png" as const, width: 1, height: 1};
  records[0].detail.item.cover = {id: assetId, src: `/media/v2/${assetId}`, alt: "Original", width: 1, height: 1};
  const writer = publicationWriter(s.role("nb_writer"), "published"), lease = await writer.begin(randomUUID(), digest);
  await writer.stage(lease, records, [media]); await writer.promote(lease, {records: 2, media: 1, complete: true});
  const binding = {assetId, ownerPageId: owner, sha256: media.sha256, locator: {kind: "cover"}, delivery: "storage", sourceFingerprint: "b".repeat(64)};
  await s.db.query("INSERT INTO nb_v2_media.sources VALUES($1,$2,$3::jsonb)", [lease.runId, assetId, JSON.stringify(binding)]);
  const derivative = await sharp(image).webp().toBuffer(), derivativeSha = sha(derivative);
  const thumbnail = {assetId: mediaIdentity(owner, `thumbnail:400:${assetId}`, derivativeSha), ownerPageId: owner, sha256: derivativeSha,
    objectKey: `sha256/${derivativeSha}`, byteSize: derivative.length, mime: "image/webp" as const, width: 1, height: 1};
  await s.db.query("INSERT INTO nb_thumbnails.media VALUES('v2',$1,$2,$3,$4,400,$5::jsonb)", [lease.runId, assetId, media.sha256, binding.sourceFingerprint, JSON.stringify(thumbnail)]);
  const publisher = createIncrementalPublisher(s.role("nb_writer")), changed = structuredClone(records[0]); changed.detail.item.title = "Accepted incremental content";
  const prepared = preparePublicationDelta({expectedRevision: (await publisher.state()).publicationRevision, configDigest: digest, upserts: [changed], media: [],
    withdrawals: [{id: records[1].detail.item.id, sourceKey: "post", reason: "deleted"}]});
  const receipt = await publisher.publish(randomUUID(), prepared);
  const staging = await writer.begin(randomUUID(), digest); await writer.stage(staging, [records[0]], [media]);
  return {archive: await exportPublicationArchive(s.owner), receipt, records, media, thumbnail, bytes: new Map([[media.objectKey, image], [thumbnail.objectKey, derivative]])};
}
const sorted = (rows: Record<string, unknown>[]) => rows.map(r => JSON.stringify(r, Object.keys(r).sort())).sort();
test("frozen archive preserves membership and audit history while restore disables publication and freezing", async () => {
  const source = await setup(), target = await setup(), root = await realpath(await mkdtemp(join(tmpdir(), "frozen-media-")));
  try {
    const snapshot = await sample(source);
    await source.db.exec("UPDATE nb_v2.runs SET status='failed' WHERE id=(SELECT lease_run FROM nb_v2.state); UPDATE nb_v2.state SET lease_run=NULL,lease_until=NULL;");
    await installFreeze(source.owner); await installFreeze(target.owner);
    await source.db.query("UPDATE nb_freeze.state SET enabled=true");
    const plan = await createFreezeStore(source.owner).preview(snapshot.records[0].detail.item.id, "freeze");
    assert.equal(plan.images, 2); assert.deepEqual(plan.thumbnailIds, [snapshot.thumbnail.assetId]);
    let corrupt = true, verified = 0;
    const backend = new ManagementBackend({version: 1, enabled: true, stateDir: join(root, ".local", "management"),
      lockDirectory: join(root, "lock"), runtimeDirectory: join(root, "runtime"), sourceConfigPath: join(root, "config.json"), siteOrigin: "https://example.test", durationMs: 120000, mediaBytes: 1048576}, {
      database: async () => source.owner, verifyMedia: async media => {verifyMediaBytes(media, corrupt ? Buffer.from("invalid image") : snapshot.bytes.get(media.objectKey)!); verified++;},
      inspectSource: async () => assert.fail("Freeze must not read Notion"), enqueue: async () => {}, assertIdle: async () => {}, dispatch: async () => {}, latestReport: async () => null,
      runSync: async () => assert.fail("Freeze must not sync"),
    });
    const preview = await backend.preview(plan.rootId, "freeze"), bad = await backend.start("freeze.start", {target: plan.rootId, digest: preview.digest});
    await backend.work(bad.operationId); assert.equal((await backend.operation(bad.operationId)).state, "failed");
    assert.equal((await createFreezeStore(source.owner).state()).members.length, 0);
    corrupt = false;
    const good = await backend.start("freeze.start", {target: plan.rootId, digest: preview.digest}); await backend.work(good.operationId);
    assert.equal((await backend.operation(good.operationId)).state, "succeeded"); assert.equal(verified, 2);
    await assert.rejects(source.db.query("DELETE FROM nb_thumbnails.media WHERE descriptor->>'assetId'=$1", [snapshot.thumbnail.assetId]), /NB_FREEZE_PROTECTED/);
    const archive = await exportPublicationArchive(source.owner);
    assert.equal(archive.format, "notionblog-publication-archive-2");
    assert.equal(archive.freeze?.members.length, 1);
    assert.equal(archive.freeze?.operations.length, 1);
    await assert.rejects(exportWebsiteArchive(source.owner));
    for (const change of [
      (a: PublicationArchive) => { (a.freeze!.members[0].record as { item: { title: string } }).item.title = "Tampered"; },
      (a: PublicationArchive) => { a.freeze!.groups = []; },
      (a: PublicationArchive) => { a.format = "notionblog-publication-archive-1"; },
      (a: PublicationArchive) => { a.freeze!.state[0].migration_digest = "0".repeat(64); },
    ]) {
      const copy = structuredClone(archive); change(copy); assert.throws(() => validatePublicationArchive(copy));
    }
    await restorePublicationArchive(target.owner, archive);
    const restored = await exportPublicationArchive(target.owner);
    assert.deepEqual(restored.freeze!.members, archive.freeze!.members);
    assert.deepEqual(restored.freeze!.groups, archive.freeze!.groups);
    assert.deepEqual(restored.freeze!.operations, archive.freeze!.operations);
    assert.equal(restored.freeze!.state[0].enabled, false);
    assert.equal(restored.publication[0].run_id, null);
    await assert.rejects(createWebsiteDatabaseRepository(publicationReader(target.role("nb_reader"), "published")).list("post"));
  } finally { await source.db.close(); await target.db.close(); await rm(root, {recursive: true, force: true}); }
});
test("complete publication recovery preserves history while disabling all publication and leases", async () => {
  const source = await setup(), target = await setup();
  try {
    const snapshot = await sample(source), original = structuredClone(snapshot.archive);
    await assert.rejects(exportWebsiteArchive(source.owner)); // old codec must not silently omit new state.
    await restorePublicationArchive(target.owner, snapshot.archive);
    const restored = await exportPublicationArchive(target.owner);
    for (const table of ["sources", "permits", "denied", "records", "media", "tombstones"] as const)
      assert.deepEqual(sorted(restored.core.tables[table]), sorted(snapshot.archive.core.tables[table]));
    assert.deepEqual(restored.incremental, snapshot.archive.incremental);
    assert.deepEqual(restored.thumbnails, snapshot.archive.thumbnails);
    assert.deepEqual(restored.migrations, snapshot.archive.migrations);
    assert.deepEqual(restored.core.format === "notionblog-website-archive-2" ? restored.core.mediaSources : null,
      snapshot.archive.core.format === "notionblog-website-archive-2" ? snapshot.archive.core.mediaSources : null);
    assert.equal(restored.publication[0].run_id, null); assert.equal(restored.publication[0].published_at, null);
    const state = restored.core.tables.state[0], before = snapshot.archive.core.tables.state[0];
    for (const key of ["revision", "epoch", "fence"]) assert.equal(state[key], Number(before[key]) + 1);
    for (const key of ["current_run", "lease_run", "lease_until"]) assert.equal(state[key], null);
    for (const run of restored.core.tables.runs) { assert.ok(Date.parse(run.valid_until as string) < Date.now()); assert.notEqual(run.status, "staging"); }
    await assert.rejects(createWebsiteDatabaseRepository(publicationReader(target.role("nb_reader"), "published")).list("post"));
    await assert.rejects(createWebsiteDatabaseRepository(target.role("nb_reader")).list("post"));
    assert.deepEqual(await createIncrementalPublisher(target.role("nb_writer")).lookup(snapshot.receipt.operationId, snapshot.receipt.payloadDigest), snapshot.receipt);
    await assert.rejects(verifyPublishedDelta(target.role("nb_reader"), snapshot.receipt)); // restored receipt is historical, never reader proof.
    assert.deepEqual(await exportPublicationArchive(source.owner), original);
    for (const name of ["nb_reader", "nb_writer"] as const) await assert.rejects(exportPublicationArchive(source.role(name)), /permission denied/);
  } finally {await source.db.close(); await target.db.close();}
});
test("strict extensions, empty targets and late failures cannot produce partial recovery", async t => {
  const source = await setup();
  try {
    const {archive} = await sample(source);
    await t.test("identity and payload mismatches fail before opening any transaction", async () => {
      const noSQL: SqlExecutor = {query: async () => {assert.fail("Must validate before BEGIN");}};
      for (const mutate of [
        (a: PublicationArchive) => {a.incremental.state[0].reader_digest = "wrong";},
        (a: PublicationArchive) => {a.migrations.push({version: "unknown", digest: "a".repeat(64)});},
        (a: PublicationArchive) => {a.incremental.operations[0].receipt = {};},
        (a: PublicationArchive) => {a.incremental.operations[0].records = [];},
        (a: PublicationArchive) => {a.publication[0].run_id = randomUUID();},
        (a: PublicationArchive) => {a.thumbnails!.media[0].width_cap = "400";},
        (a: PublicationArchive) => {a.thumbnails!.media[0].extra = "unknown column";},
      ]) {const bad = structuredClone(archive); mutate(bad); await assert.rejects(restorePublicationArchive(noSQL, bad));}
    });
    await t.test("only corresponding installed extensions and a truly empty website target qualify", async () => {
      const target = await setup();
      try {
        const before = await exportPublicationArchive(target.owner);
        await assert.rejects(restoreWebsiteArchive(target.owner, archive.core));
        await target.db.exec("INSERT INTO nb_v2.denied VALUES('existing-denial')");
        await assert.rejects(restorePublicationArchive(target.owner, archive));
        await target.db.exec("DELETE FROM nb_v2.denied; CREATE SCHEMA nb_delta_unknown");
        await assert.rejects(exportPublicationArchive(target.owner)); await assert.rejects(restorePublicationArchive(target.owner, archive));
        await target.db.exec("DROP SCHEMA nb_delta_unknown");
        assert.deepEqual(await exportPublicationArchive(target.owner), before);
        await target.db.query("UPDATE nb_thumbnails.migrations SET digest='wrong'"); await assert.rejects(exportPublicationArchive(target.owner));
      } finally {await target.db.close();}
      const noMedia = await setup(false, false);
      try {await assert.rejects(restorePublicationArchive(noMedia.owner, archive));} finally {await noMedia.db.close();}
    });
    await t.test("a deferred operation-ledger failure rolls back core rows, indices and state", async () => {
      const target = await setup();
      try {
        const before = await exportPublicationArchive(target.owner);
        await target.db.exec(`CREATE FUNCTION reject_ledger() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'SYNTHETIC_LEDGER_FAILURE'; END $$;
          CREATE CONSTRAINT TRIGGER reject_ledger AFTER INSERT ON nb_delta.operations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reject_ledger();`);
        await assert.rejects(restorePublicationArchive(target.owner, archive), /SYNTHETIC_LEDGER_FAILURE/);
        await assert.rejects(restorePublicationArchive(rollbackFault(target.owner), archive), /SYNTHETIC_LEDGER_FAILURE/);
        assert.deepEqual(await exportPublicationArchive(target.owner), before);
      } finally {await target.db.close();}
    });
  } finally {await source.db.close();}
});
test("private publication bundle verifies all original and derived bytes before restore", async () => {
  const source = await setup(), directory = await mkdtemp(join(await realpath(tmpdir()), "publication-recovery-"));
  try {
    const s = await sample(source), files = createPublicationArchiveStore(directory), path = join(directory, "bundle");
    validatePublicationArchive(s.archive); assert.equal(archivedPublicationObjects(s.archive).length, 2);
    const counts = await files.save(path, s.archive, {read: async media => s.bytes.get(media.objectKey)!});
    assert.equal(counts.mediaFiles, 2); const loaded = await files.load(path); assert.deepEqual(loaded.archive, s.archive);
    await writeFile(join(path, s.thumbnail.objectKey), Buffer.from("corrupt derivative"), {mode: 0o600});
    await assert.rejects(files.load(path));
    await assert.rejects(files.save(join(directory, "failed"), s.archive, {read: async () => Buffer.from("wrong bytes")}));
    const metadata = join(directory, "metadata"); await files.save(metadata, s.archive);
    assert.equal((await files.load(metadata)).mediaIncluded, false);
  } finally {await source.db.close(); await rm(directory, {recursive: true, force: true});}
});


test("archives preserve both audit extensions and refuse restoring across mismatched installed identities", async () => {
  const source = await setup(), target = await setup();
  try {
    const old = await sample(source);
    await withPGliteOwnerTransaction(source.db, installIncrementalWithdrawalRecovery);
    await withPGliteOwnerTransaction(source.db, installIncrementalReaderIsolation);
    const archive = await exportPublicationArchive(source.owner);
    assert.equal(Object.keys(archive.incremental.state[0]).length, 6);
    assert.deepEqual(archive.core, old.archive.core);
    for (const key of ["reader_isolation_digest", "withdrawal_recovery_digest"]) {
      const tampered = structuredClone(archive); tampered.incremental.state[0][key] = "f".repeat(64);
      assert.throws(() => validatePublicationArchive(tampered));
    }
    await assert.rejects(restorePublicationArchive(target.owner, archive));
    assert.equal((await exportPublicationArchive(target.owner)).core.tables.records.length, 0);
    await withPGliteOwnerTransaction(target.db, installIncrementalReaderIsolation); // reverse installation order
    await assert.rejects(restorePublicationArchive(target.owner, archive));
    await withPGliteOwnerTransaction(target.db, installIncrementalWithdrawalRecovery);
    await assert.rejects(restorePublicationArchive(target.owner, old.archive));
    await restorePublicationArchive(target.owner, archive);
    const restored = await exportPublicationArchive(target.owner);
    assert.deepEqual(restored.incremental, archive.incremental);
    assert.equal(restored.publication[0].run_id, null);
    assert.deepEqual(sorted(restored.core.tables.records), sorted(archive.core.tables.records));
  } finally { await source.db.close(); await target.db.close(); }
});

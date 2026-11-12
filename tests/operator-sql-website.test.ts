import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { fixtureItems } from "../fixtures/content.ts";
import { WEBSITE_SCHEMA_DIGEST, type WebsiteRecord } from "../contracts/website-sync.ts";
import { createWebsiteWriter } from "../src/server/database/website-writer.ts";
import { createWebsiteMediaSourceWriter } from "../src/server/database/website-media-sources.ts";
import { createWebsiteDatabaseRepository } from "../src/server/database/website-repository.ts";
import { configDigest, mediaIdentity } from "../src/server/database/website-validation.ts";
import { readThumbnail } from "../src/server/database/thumbnail-index.ts";
import type { SqlExecutor } from "../src/server/database/sql.ts";
import { createWebsiteMaintenanceSession, MAINTENANCE_REGISTER_SQL, MAINTENANCE_THUMBNAILS_SQL, MAINTENANCE_ROLE_SQL } from "../scripts/operator-sql/website.ts";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");

test("maintenance adapter preserves real restricted snapshot and thumbnail qualification across publications", async t => {
  const directory = await mkdtemp(join(tmpdir(), "operator-website-")), db = await PGlite.create();
  try {
    await db.exec("CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS");
    for (const path of ["database/website-migrations/001_website.sql", "database/website-media-migrations/001_website_media_sources.sql", "supabase/migrations/20261011123536_media_thumbnails.sql"])
      await db.exec(await readFile(new URL("../" + path, import.meta.url), "utf8"));
    await db.query("UPDATE nb_v2.state SET schema_digest=$1", [WEBSITE_SCHEMA_DIGEST]);
    const role = (name: "nb_reader" | "nb_writer"): SqlExecutor => ({ query: <T>(sql: string, values?: unknown[]) => db.transaction(async tx => {
      await tx.exec(`SET LOCAL ROLE ${name}`); return tx.query<T>(sql, values);
    }) });
    const reader = role("nb_reader"), writer = role("nb_writer");
    const item = structuredClone(fixtureItems.status[0]); item.id = "1".repeat(32); item.slug = item.id; item.href = `/status#${item.id}`;
    const media = { assetId: mediaIdentity(item.id, "cover", "a".repeat(64)), ownerPageId: item.id, sha256: "a".repeat(64), objectKey: `sha256/${"a".repeat(64)}`,
      byteSize: 1000, mime: "image/png" as const, width: 100, height: 100 };
    item.cover = { id: media.assetId, src: `/media/v2/${media.assetId}`, alt: "Fictional cover", width: 100, height: 100 };
    const source = { assetId: media.assetId, ownerPageId: item.id, sha256: media.sha256, locator: { kind: "cover" as const }, delivery: "notion" as const, sourceFingerprint: "b".repeat(64) };
    const record: WebsiteRecord = { detail: { item, document: { blocks: Array.from({ length: 100 }, (_, index) => ({ id: `paragraph-${index}`, type: "paragraph" as const, text: [{ text: "Fictional public body 中文 ".repeat(50) }] })), toc: [], completeness: "complete" } },
      evidence: { sourceKey: "statuses", dataSourceId: "fictional-status", databaseParentId: null, courseId: null, parentId: null, ordinal: 0 } };
    const sources = [{ key: "statuses", kind: "status", mode: "all", dataSourceId: "fictional-status", databaseParentId: null, pageId: null }], digest = configDigest(sources);
    await db.query("SELECT nb_v2_api.configure_policy($1,600,$2::jsonb,'[]')", [digest, JSON.stringify(sources)]);
    const publisher = createWebsiteWriter(writer), sourceWriter = createWebsiteMediaSourceWriter(writer);
    const publish = async () => {
      const lease = await publisher.begin(randomUUID(), digest); await publisher.stage(lease, [record], [media]);
      await sourceWriter.stage(lease, [source]); await publisher.promote(lease, { records: 1, media: 1, complete: true }); return lease;
    };
    let lease = await publish();
    const variant = { ...media, sha256: "c".repeat(64), objectKey: `sha256/${"c".repeat(64)}`, mime: "image/webp" as const, byteSize: 100,
      assetId: mediaIdentity(item.id, `thumbnail:400:${media.assetId}`, "c".repeat(64)) };
    const plan = { version: 1 as const, session: hash("fictional-cycle"), stopAt: Date.now() + 60000, maxQueries: 100, maxResponseBytes: 8 * 1024 ** 2, maxQueryResponseBytes: 2 * 1024 ** 2 };
    const input = { cacheDirectory: join(directory, "cache"), budgetDirectory: join(directory, "budget"), namespace: hash("fictional-database-config-and-schema"), plan,
      cacheLimits: { maxBytes: 4 * 1024 ** 2, maxEntryBytes: 2 * 1024 ** 2, maxEntries: 20 } };
    const session = await createWebsiteMaintenanceSession(input), r = session.reader(reader), w = session.writer(writer);
    const repository = (sql: SqlExecutor) => createWebsiteDatabaseRepository(sql, { snapshotPageSize: 50 });
    const read = () => repository(r).readSnapshot!(["status"], true);
    const readBatch = () => r.query(MAINTENANCE_THUMBNAILS_SQL, [JSON.stringify([{ ordinal: 0, asset: media.assetId, width: 400 }])]);
    const register = () => w.query(MAINTENANCE_REGISTER_SQL, [lease.runId, JSON.stringify([{ ordinal: 0, asset: media.assetId, sha: media.sha256,
      fingerprint: source.sourceFingerprint, width: 400, descriptor: variant }])]);

    await t.test("full DTO and current generation survive warm reads and new operator instances", async () => {
      assert.deepEqual(await read(), await repository(reader).readSnapshot!(["status"], true));
      const before = r.statistics().responseBytes; await read();
      assert.ok(r.statistics().responseBytes - before < 4096);
      const reopened = (await createWebsiteMaintenanceSession(input)).reader(reader);
      assert.deepEqual(await repository(reopened).readSnapshot!(["status"], true), await read());
      assert.ok(reopened.statistics().hits >= 3);
    });
    await t.test("uncached registration changes the independently read projection and cannot be skipped", async () => {
      assert.equal((await readThumbnail(r, "v2", media.assetId, 400))!.thumbnail, null);
      await readBatch(); await register();
      assert.deepEqual(await readThumbnail(r, "v2", media.assetId, 400), await readThumbnail(reader, "v2", media.assetId, 400));
      const batch = await readBatch(); assert.deepEqual((batch.rows[0] as { result: { thumbnail: unknown } }).result.thumbnail, variant);
      await readBatch(); await register(); assert.equal(w.statistics().hits, 0);
    });
    await t.test("an unchanged new publication still returns new run/revision and fresh thumbnails", async () => {
      const oldRun = lease.runId; lease = await publish(); assert.notEqual(lease.runId, oldRun);
      const before = r.statistics().responseBytes, snapshot = await read();
      assert.equal(snapshot.version.split(":")[0], lease.runId); assert.ok(r.statistics().responseBytes - before < 4096);
      assert.equal((await readThumbnail(r, "v2", media.assetId, 400))!.thumbnail, null);
      await register(); await readBatch();
      assert.equal((await readThumbnail(r, "v2", media.assetId, 400))!.runId, lease.runId);
    });
    await t.test("a changed source fingerprint and central withdrawal never resurrect cached eligibility", async () => {
      await db.query("UPDATE nb_v2_media.sources SET binding=jsonb_set(binding,'{sourceFingerprint}',to_jsonb($1::text)) WHERE run_id=$2", ["d".repeat(64), lease.runId]);
      assert.equal((await readThumbnail(r, "v2", media.assetId, 400))!.thumbnail, null);
      await db.query("SELECT nb_v2_api.set_denied($1,true)", [item.id]);
      assert.equal((await read()).records.length, 0); assert.equal(await readThumbnail(r, "v2", media.assetId, 400), null);
      assert.deepEqual(await read(), await repository(reader).readSnapshot!(["status"], true));
      await db.query("SELECT nb_v2_api.set_denied($1,false)", [item.id]);
      assert.equal((await read()).records.length, 1);
    });
    await t.test("reader cannot register; writer cannot use a reader cache or read a snapshot", async () => {
      await assert.rejects(r.query(MAINTENANCE_REGISTER_SQL, []), /NOT_ALLOWED/);
      await assert.rejects(repository(w).readSnapshot!(["status"], true));
      assert.equal((await r.query(MAINTENANCE_ROLE_SQL)).rows.length, 1);
    });
    await t.test("expired publication fails at the original function despite a populated SSD cache", async () => {
      await db.query("UPDATE nb_v2.runs SET valid_until=clock_timestamp()-interval '1 second' WHERE id=$1", [lease.runId]);
      await assert.rejects(read()); assert.ok((await session.statistics()).stopped);
    });
  } finally { await db.close(); await rm(directory, { recursive: true, force: true }); }
});

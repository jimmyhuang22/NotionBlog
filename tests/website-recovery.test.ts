import { rollbackFault } from "./helpers/rollback-fault.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, rm, chmod, symlink, writeFile, stat, lstat, realpath, truncate } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { CONTENT_KINDS } from "../config/features.ts";
import { fixtureItems } from "../fixtures/content.ts";
import { WEBSITE_SCHEMA_DIGEST } from "../contracts/website-sync.ts";
import type { WebsiteRecord } from "../contracts/website-sync.ts";
import { createWebsiteWriter } from "../src/server/database/website-writer.ts";
import { configDigest, mediaIdentity } from "../src/server/database/website-validation.ts";
import { exportWebsiteArchive, restoreWebsiteArchive, validateWebsiteArchive, archivedWebsiteObjects, type WebsiteDatabaseArchive } from "../src/server/database/website-archive.ts";
import { createWebsiteArchiveStore } from "../src/server/database/website-archive-files.ts";
import protocol from "../database/website-protocol.json" with { type: "json" };
const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZL98AAAAASUVORK5CYII=", "base64");
const sha = createHash("sha256").update(image).digest("hex");
async function database() {
  const db = await PGlite.create();
  await db.exec(await readFile(new URL("../database/website-migrations/001_website.sql", import.meta.url), "utf8"));
  await db.query("UPDATE nb_v2.state SET schema_digest=$1", [WEBSITE_SCHEMA_DIGEST]);
  await db.query("UPDATE nb_v2.migrations SET digest=$1 WHERE version='001'", [protocol.migration.sha256]);
  return db;
}
async function sample(db: PGlite) {
  const records: WebsiteRecord[] = CONTENT_KINDS.map((kind, ordinal) => {
    const item = structuredClone(fixtureItems[kind][0]); item.cover = null;
    if (item.kind === "status") item.href = `/status#${item.id}`;
    if (item.kind === "study-note") { item.parentId = null; item.courseId = fixtureItems.course[0].id; item.href = `/study/${item.courseId}/notes/${item.slug}`; item.breadcrumbs = []; }
    return { detail: { item, document: { blocks: [{ id: "p", type: "paragraph", text: [{ text: "Private historical body" }] }], toc: [], completeness: "complete" } }, evidence: { sourceKey: kind, dataSourceId: kind === "page" ? null : `source-${kind}`, databaseParentId: kind === "study-note" ? fixtureItems.course[0].id : null, courseId: kind === "study-note" ? fixtureItems.course[0].id : null, parentId: kind === "study-note" ? fixtureItems.course[0].id : null, ordinal } };
  });
  const sources = CONTENT_KINDS.map(kind => ({ key: kind, kind, mode: ["course", "study-note", "page"].includes(kind) ? "allowlist" : "all", dataSourceId: kind === "page" ? null : `source-${kind}`, databaseParentId: kind === "study-note" ? fixtureItems.course[0].id : null, pageId: kind === "page" ? fixtureItems.page[0].id : null }));
  const permits = records.filter(r => sources.find(s => s.key === r.evidence.sourceKey)!.mode === "allowlist").map(r => ({ id: r.detail.item.id, kind: r.detail.item.kind, sourceKey: r.evidence.sourceKey, courseId: r.evidence.courseId, parentId: r.evidence.parentId }));
  const digest = configDigest([sources, permits]);
  await db.query("SELECT nb_v2_api.configure_policy($1,600,$2::jsonb,$3::jsonb)", [digest, JSON.stringify(sources), JSON.stringify(permits)]);
  const writer = createWebsiteWriter(db), owner = records[0].detail.item.id, assetId = mediaIdentity(owner, "cover", sha);
  const media = { assetId, ownerPageId: owner, objectKey: `sha256/${sha}`, sha256: sha, byteSize: image.length, mime: "image/png" as const, width: 1, height: 1 };
  records[0].detail.item.cover = { id: assetId, src: `/media/v2/${assetId}`, alt: "Synthetic", width: 1, height: 1 };
  const published = await writer.begin(randomUUID(), digest);
  await writer.stage(published, records, [media]); await writer.promote(published, { records: records.length, media: 1, complete: true });
  const failed = await writer.begin(randomUUID(), digest); await writer.stage(failed, records.slice(0, 1), [media]); await writer.fail(failed);
  await db.query("SELECT nb_v2_api.set_denied('withdrawn-historical-page',true)");
  const staging = await writer.begin(randomUUID(), digest); await writer.stage(staging, records.slice(0, 1), [media]);
  await db.query("INSERT INTO nb_v2.tombstones VALUES($1,'gone','deleted')", [staging.runId]);
  return exportWebsiteArchive(db);
}
const sorted = (rows: Record<string, unknown>[]) => rows.map(r => JSON.stringify(r, Object.keys(r).sort())).sort();
test("website archive restores every table and historical batch without restoring publication or leases", async () => {
  const source = await database(), target = await database();
  try {
    await target.exec("CREATE SCHEMA nb; CREATE TABLE nb.sentinel(value text); INSERT INTO nb.sentinel VALUES('legacy unchanged')");
    const archive = await sample(source), before = structuredClone(archive);
    assert.equal(archive.tables.runs.length, 3); assert.equal(archivedWebsiteObjects(archive).length, 1);
    await restoreWebsiteArchive(target, archive);
    const restored = await exportWebsiteArchive(target);
    for (const table of ["sources", "permits", "denied", "records", "media", "tombstones"] as const) assert.deepEqual(sorted(restored.tables[table]), sorted(archive.tables[table]));
    const state = restored.tables.state[0], old = archive.tables.state[0];
    assert.equal(state.current_run, null); assert.equal(state.lease_run, null); assert.equal(state.lease_until, null);
    for (const k of ["revision", "epoch", "fence"]) assert.equal(state[k], Number(old[k]) + 1);
    for (const row of restored.tables.runs) {
      assert.ok(Date.parse(row.valid_until as string) < Date.now());
      const prior = archive.tables.runs.find(r => r.id === row.id)!;
      assert.equal(row.status, prior.status === "staging" ? "failed" : prior.status);
      const { valid_until: a, status: b, ...rest } = row, { valid_until: c, status: d, ...original } = prior;
      assert.deepEqual(rest, original);
    }
    assert.deepEqual(archive, before);
    await assert.rejects(target.query("SELECT nb_v2_api.read_snapshot(ARRAY['game'],true)"), /NB_UNAVAILABLE/);
    assert.equal((await target.query<{ value: string }>("SELECT value FROM nb.sentinel")).rows[0].value, "legacy unchanged");
    for (const role of ["nb_reader", "nb_writer"]) {
      await source.exec(`SET ROLE ${role}`);
      await assert.rejects(exportWebsiteArchive(source), /permission denied/);
      await source.exec("RESET ROLE");
    }
  } finally { await source.close(); await target.close(); }
});
test("website restore rejects version mismatches, populated targets and rolls back late constraints", async t => {
  const source = await database();
  try {
    const archive = await sample(source);
    await t.test("outer identity, unique inner state, columns and unsafe counters are checked before BEGIN", async () => {
      for (const change of [
        (a: WebsiteDatabaseArchive) => { a.protocol = "notionblog-sync-v1"; },
        (a: WebsiteDatabaseArchive) => { a.migrationDigest = "wrong"; },
        (a: WebsiteDatabaseArchive) => { a.tables.state.push(a.tables.state[0]); },
        (a: WebsiteDatabaseArchive) => { a.tables.state[0].schema_digest = "wrong"; },
        (a: WebsiteDatabaseArchive) => { a.tables.denied[0].unknown = "silently ignored before"; },
        (a: WebsiteDatabaseArchive) => { delete a.tables.records[0].document; },
        (a: WebsiteDatabaseArchive) => { a.tables.state[0].fence = Number.MAX_SAFE_INTEGER; },
        (a: WebsiteDatabaseArchive) => { a.tables.media[0].asset_id = "wrong"; },
      ]) {
        const bad = structuredClone(archive); change(bad);
        await assert.rejects(restoreWebsiteArchive({ query: async () => { assert.fail("Must not start a transaction"); } }, bad));
      }
    });
    await t.test("deny-only, policy-only, history-only and active state targets remain untouched", async () => {
      for (const insert of ["INSERT INTO nb_v2.denied VALUES('existing-deny')", "INSERT INTO nb_v2.sources VALUES('s','game','all','d',NULL,NULL)", "UPDATE nb_v2.state SET fence=1", "UPDATE nb_v2.state SET schema_digest='wrong'", "UPDATE nb_v2.migrations SET digest='wrong'"]) {
        const db = await database();
        try { await db.exec(insert); const before = await db.query("SELECT row_to_json(s) AS state FROM nb_v2.state s"); await assert.rejects(restoreWebsiteArchive(db, archive)); assert.deepEqual(await db.query("SELECT row_to_json(s) AS state FROM nb_v2.state s"), before); }
        finally { await db.close(); }
      }
      const db = await database();
      try { await db.query("INSERT INTO nb_v2.runs SELECT * FROM jsonb_populate_recordset(NULL::nb_v2.runs,$1)", [JSON.stringify(archive.tables.runs)]); await assert.rejects(restoreWebsiteArchive(db, archive)); assert.equal((await db.query<{ n: number }>("SELECT count(*)::int n FROM nb_v2.runs")).rows[0].n, 3); } finally { await db.close(); }
    });
    await t.test("a deferred orphan media constraint rolls back all inserted policy and content", async () => {
      const db = await database();
      try {
        const before = await exportWebsiteArchive(db), bad = structuredClone(archive);
        bad.tables.media[0].owner_page_id = "missing-owner";
        (bad.tables.media[0].descriptor as Record<string, unknown>).ownerPageId = "missing-owner";
        validateWebsiteArchive(bad); await assert.rejects(restoreWebsiteArchive(db, bad), /foreign key/);
        await assert.rejects(restoreWebsiteArchive(rollbackFault(db), bad), /foreign key/);
        assert.deepEqual(await exportWebsiteArchive(db), before);
      } finally { await db.close(); }
    });
    await t.test("independent v2 media extensions cannot be silently omitted from backups", async () => {
      const db = await database();
      try {
        const before = await exportWebsiteArchive(db); await db.exec("CREATE SCHEMA nb_v2_media");
        await assert.rejects(exportWebsiteArchive(db)); await assert.rejects(restoreWebsiteArchive(db, archive));
        await db.exec("DROP SCHEMA nb_v2_media"); assert.deepEqual(await exportWebsiteArchive(db), before);
      } finally { await db.close(); }
    });
  } finally { await source.close(); }
});
test("private website bundle verifies original image bytes, manifests, bounds and file isolation", async t => {
  const db = await database(), temp = await mkdtemp(join(await realpath(tmpdir()), "website-archive-"));
  try {
    const archive = await sample(db), root = join(temp, ".local"), files = createWebsiteArchiveStore(root), full = join(root, "full");
    const result = await files.save(full, archive, { read: async () => image });
    assert.equal(result.mediaFiles, 1); assert.equal(result.mediaBytes, image.length);
    const loaded = await files.load(full); assert.deepEqual(loaded.archive, archive); assert.equal(loaded.mediaIncluded, true);
    assert.equal((await stat(full)).mode & 0o777, 0o700); assert.equal((await stat(join(full, "content.json"))).mode & 0o777, 0o600);
    await t.test("database-only backups are explicit; existing directories and outside paths are refused", async () => {
      const partial = join(root, "database-only"); await files.save(partial, archive); assert.equal((await files.load(partial)).mediaIncluded, false);
      await assert.rejects(files.save(full, archive)); await assert.rejects(files.save(join(temp, "outside"), archive)); await files.load(full);
    });
    await t.test("wrong bytes cannot produce a completed backup", async () => {
      const failed = join(root, "failed"); await assert.rejects(files.save(failed, archive, { read: async () => Buffer.from("bad") })); await assert.rejects(lstat(failed), { code: "ENOENT" });
    });
    await t.test("content mutation and permissive files are rejected", async () => {
      const path = join(full, "content.json"), original = await readFile(path); await writeFile(path, "{}"); await assert.rejects(files.load(full)); await writeFile(path, original);
      await chmod(path, 0o644); await assert.rejects(files.load(full)); await chmod(path, 0o600); await files.load(full);
    });
    await t.test("duplicate manifests, missing media flags and oversized files fail before restore", async () => {
      const path = join(full, "manifest.json"), original = await readFile(path), manifest = JSON.parse(original.toString());
      manifest.media.push(manifest.media[0]); await writeFile(path, JSON.stringify(manifest)); await assert.rejects(files.load(full));
      manifest.media.pop(); manifest.mediaIncluded = false; await writeFile(path, JSON.stringify(manifest)); await assert.rejects(files.load(full)); await writeFile(path, original);
      const contentPath = join(full, "content.json"), content = await readFile(contentPath);
      await truncate(contentPath, 64 * 1024 * 1024 + 1); await assert.rejects(files.load(full)); await writeFile(contentPath, content); await files.load(full);
    });
    await t.test("object mutation and ancestor/file symlinks are rejected", async () => {
      const path = join(full, `sha256/${sha}`); await writeFile(path, Buffer.alloc(image.length)); await assert.rejects(files.load(full)); await writeFile(path, image);
      await symlink(full, join(root, "link")); await assert.rejects(files.load(join(root, "link"))); await assert.rejects(files.save(join(root, "link", "child"), archive));
      const content = await readFile(join(full, "content.json")); await rm(join(full, "content.json")); await writeFile(join(root, "external.json"), content, { mode: 0o600 }); await symlink(join(root, "external.json"), join(full, "content.json")); await assert.rejects(files.load(full));
    });
  } finally { await db.close(); await rm(temp, { recursive: true, force: true }); }
});

import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { readFile, mkdtemp, rm, realpath, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import type { BlockObjectResponse } from "@notionhq/client";
import { fixtureItems } from "../fixtures/content.ts";
import { WEBSITE_SCHEMA_DIGEST, type WebsiteRecord } from "../contracts/website-sync.ts";
import type { StoredMedia } from "../contracts/sync.ts";
import { DEMO_PNG, demoId, demoPage, demoParagraph } from "../scripts/notion-sync/demo.ts";
import { configDigest, mediaIdentity } from "../src/server/database/website-validation.ts";
import { createWebsiteWriter } from "../src/server/database/website-writer.ts";
import { createWebsiteMediaSourceWriter } from "../src/server/database/website-media-sources.ts";
import { archivedWebsiteObjects, exportWebsiteArchive, restoreWebsiteArchive, validateWebsiteArchive } from "../src/server/database/website-archive.ts";
import { createWebsiteArchiveStore } from "../src/server/database/website-archive-files.ts";
import { createWebsiteArchiveMediaReader } from "../src/server/database/website-archive-media.ts";
import { sourceFingerprint, type MediaSourceBinding } from "../src/server/media/notion-source.ts";
import type { NotionReadClient } from "../src/server/notion/types.ts";
import coreProtocol from "../database/website-protocol.json" with { type: "json" };
import mediaProtocol from "../database/website-media-protocol.json" with { type: "json" };

const owner = demoId(7800), source = demoId(7801), ordinaryBlock = demoId(7802), convertedBlock = demoId(7803);
const jpeg = Buffer.from([255, 216, 255, 224, 0, 2, 255, 217]);
const hosted = (name: string, signature = "synthetic-original") => {
  const url = new URL(`https://assets.example.test/${name}`);
  url.searchParams.set("X-Amz-Signature", signature);
  return url.href;
};
const uploaded = (url: string) => ({ type: "file" as const, file: { url, expiry_time: new Date(Date.now() + 600_000).toISOString() } });
async function database(hybrid = true) {
  const db = await PGlite.create();
  await db.exec(await readFile(new URL("../database/website-migrations/001_website.sql", import.meta.url), "utf8"));
  await db.query("UPDATE nb_v2.state SET schema_digest=$1", [WEBSITE_SCHEMA_DIGEST]);
  await db.query("UPDATE nb_v2.migrations SET digest=$1", [coreProtocol.migration.sha256]);
  if (hybrid) {
    await db.exec(await readFile(new URL("../database/website-media-migrations/001_website_media_sources.sql", import.meta.url), "utf8"));
    await db.query("UPDATE nb_v2_media.migrations SET digest=$1", [mediaProtocol.migrations[0].sha256]);
  }
  return db;
}
async function sample(db: PGlite, property = false) {
  const page = demoPage(owner, "Synthetic hybrid archive", { type: "data_source_id", data_source_id: source, database_id: demoId(7809) });
  page.cover = uploaded(hosted("cover.png", "refreshed"));
  if (property) page.properties.Artwork = { id: "art", type: "files", files: [{ name: "cover", ...uploaded(hosted("cover.png", "refreshed")) }] };
  const image = (id: string, name: string) => ({ ...demoParagraph(id, owner, ""), type: "image", image: { ...uploaded(hosted(name, "refreshed")), caption: [] } } as BlockObjectResponse);
  const blocks = [image(ordinaryBlock, "body.png"), image(convertedBlock, "original.heic")];
  const inputs: { locator: MediaSourceBinding["locator"]; bytes: Buffer; delivery: MediaSourceBinding["delivery"]; name: string }[] = [
    { locator: property ? { kind: "property", name: "Artwork" } : { kind: "cover" }, bytes: DEMO_PNG, delivery: "notion", name: "cover.png" },
    { locator: { kind: "block", id: ordinaryBlock }, bytes: DEMO_PNG, delivery: "notion", name: "body.png" },
    { locator: { kind: "block", id: convertedBlock }, bytes: jpeg, delivery: "storage", name: "original.heic" },
  ];
  const media: StoredMedia[] = [], bindings: MediaSourceBinding[] = [];
  for (const input of inputs) {
    const sha256 = createHash("sha256").update(input.bytes).digest("hex");
    const key = input.locator.kind === "block" ? input.locator.id : input.locator.kind === "property" ? input.locator.name : "cover";
    const assetId = mediaIdentity(owner, key, sha256);
    media.push({ assetId, ownerPageId: owner, sha256, objectKey: `sha256/${sha256}`, byteSize: input.bytes.length, mime: input.delivery === "notion" ? "image/png" : "image/jpeg", width: null, height: null });
    bindings.push({ assetId, ownerPageId: owner, sha256, locator: input.locator, delivery: input.delivery, sourceFingerprint: sourceFingerprint(hosted(input.name), true) });
  }
  const item = structuredClone(fixtureItems.game[0]); item.id = owner; item.slug = owner; item.href = `/library/games/${owner}`;
  const publicImage = (m: StoredMedia) => ({ id: m.assetId, src: `/media/v2/${m.assetId}`, alt: "Synthetic", width: null, height: null });
  item.cover = publicImage(media[0]);
  const record: WebsiteRecord = { detail: { item, document: { blocks: media.slice(1).map((m, i) => ({ id: `image-${i}`, type: "image", image: publicImage(m), caption: [] })), toc: [], completeness: "complete" } }, evidence: { sourceKey: "games", dataSourceId: source, databaseParentId: null, courseId: null, parentId: null, ordinal: 0 } };
  const sources = [{ key: "games", kind: "game", mode: "all", dataSourceId: source, databaseParentId: null, pageId: null }], digest = configDigest([sources, []]);
  await db.query("SELECT nb_v2_api.configure_policy($1,600,$2::jsonb,'[]')", [digest, JSON.stringify(sources)]);
  const writer = createWebsiteWriter(db), index = createWebsiteMediaSourceWriter(db);
  for (const published of [true, false]) {
    const lease = await writer.begin(randomUUID(), digest);
    await writer.stage(lease, [record], media); await index.stage(lease, bindings);
    if (published) await writer.promote(lease, { records: 1, media: media.length, complete: true }); else await writer.fail(lease);
  }
  const client: NotionReadClient = {
    getPage: async id => id === owner ? structuredClone(page) : null,
    getBlock: async id => structuredClone(blocks.find(b => b.id === id) ?? null),
    listBlocks: async () => { assert.fail("Backup must not enumerate bodies"); },
    getDataSource: async () => { assert.fail("Backup must not enumerate sources"); },
  };
  return { archive: await exportWebsiteArchive(db), page, blocks, client, media, bindings };
}
const sorted = (rows: unknown[]) => rows.map(row => JSON.stringify(row)).sort();

test("hybrid archive backs up Notion originals and Storage derivatives, restores locators and leaves publication disabled", async () => {
  const sourceDb = await database(), target = await database(), temp = await mkdtemp(join(await realpath(tmpdir()), "website-hybrid-"));
  try {
    const s = await sample(sourceDb), archive = s.archive;
    assert.equal(archive.format, "notionblog-website-archive-2"); if (archive.format !== "notionblog-website-archive-2") assert.fail();
    assert.equal(archive.mediaSources.sources.length, 6); assert.equal(archive.tables.runs.length, 2);
    assert.ok(!JSON.stringify(archive).includes("X-Amz-Signature"));
    let storageReads = 0, downloads = 0;
    const reader = createWebsiteArchiveMediaReader(archive, {
      storage: () => ({ read: async media => { storageReads++; assert.equal(media.mime, "image/jpeg"); return jpeg; } }), client: () => s.client,
      download: async url => { downloads++; const parsed = new URL(url); assert.equal(parsed.searchParams.get("X-Amz-Signature"), "refreshed"); assert.ok(parsed.pathname.endsWith(".png")); return { bytes: DEMO_PNG }; },
    });
    const files = createWebsiteArchiveStore(join(temp, ".local")), path = join(temp, ".local/full");
    const saved = await files.save(path, archive, reader);
    assert.equal(saved.mediaFiles, 2); assert.equal(saved.mediaBytes, DEMO_PNG.length + jpeg.length); assert.equal(downloads, 1); assert.equal(storageReads, 1);
    const loaded = await files.load(path); assert.deepEqual(loaded.archive, archive);
    await restoreWebsiteArchive(target, loaded.archive);
    const restored = await exportWebsiteArchive(target); assert.equal(restored.format, archive.format);
    if (restored.format !== "notionblog-website-archive-2") assert.fail();
    assert.deepEqual(sorted(restored.mediaSources.sources), sorted(archive.mediaSources.sources));
    for (const table of ["sources", "permits", "denied", "records", "media", "tombstones"] as const) assert.deepEqual(sorted(restored.tables[table]), sorted(archive.tables[table]));
    assert.equal(restored.tables.state[0].current_run, null); assert.equal(restored.tables.state[0].lease_run, null);
    assert.ok(restored.tables.runs.every(row => Date.parse(row.valid_until as string) < Date.now()));
    await assert.rejects(target.query("SELECT nb_v2_api.read_snapshot(ARRAY['game'],true)"), /NB_UNAVAILABLE/);
    assert.deepEqual(await exportWebsiteArchive(sourceDb), archive);
  } finally { await sourceDb.close(); await target.close(); await rm(temp, { recursive: true, force: true }); }
});

test("hybrid archive validates bindings and migration identities before restore and rolls back index commit failures", async t => {
  const sourceDb = await database();
  try {
    const { archive } = await sample(sourceDb); if (archive.format !== "notionblog-website-archive-2") assert.fail();
    await t.test("unknown fields, duplicate locators and mismatched generations or owners are rejected before BEGIN", async () => {
      for (const change of [
        (a: typeof archive) => { a.mediaSources.migrationDigest = "wrong"; },
        (a: typeof archive) => { a.mediaSources.capability = "unknown"; },
        (a: typeof archive) => { a.mediaSources.sources.push(a.mediaSources.sources[0]); },
        (a: typeof archive) => { a.mediaSources.sources[0].run_id = randomUUID(); },
        (a: typeof archive) => { a.mediaSources.sources[0].binding.ownerPageId = demoId(9999); },
        (a: typeof archive) => { Object.assign(a.mediaSources.sources[0].binding, { url: hosted("forbidden.png") }); },
      ]) {
        const bad = structuredClone(archive); change(bad);
        assert.throws(() => validateWebsiteArchive(bad));
        await assert.rejects(restoreWebsiteArchive({ query: async () => { assert.fail("Must not start a transaction"); } }, bad));
      }
    });
    await t.test("archive and target require the same installed media capability; unknown namespaces and migration drift fail", async () => {
      const plain = await database(false), hybrid = await database();
      try {
        const old = await exportWebsiteArchive(plain); assert.equal(old.format, "notionblog-website-archive-1");
        await assert.rejects(restoreWebsiteArchive(plain, archive)); await assert.rejects(restoreWebsiteArchive(hybrid, old));
        await hybrid.exec("CREATE SCHEMA nb_v2_unknown"); await assert.rejects(exportWebsiteArchive(hybrid)); await assert.rejects(restoreWebsiteArchive(hybrid, archive)); await hybrid.exec("DROP SCHEMA nb_v2_unknown");
        await hybrid.query("UPDATE nb_v2_media.migrations SET digest='wrong'"); await assert.rejects(exportWebsiteArchive(hybrid)); await assert.rejects(restoreWebsiteArchive(hybrid, archive));
      } finally { await plain.close(); await hybrid.close(); }
    });
    await t.test("a deferred failure in the new index rolls back both core and locator rows", async () => {
      const target = await database();
      try {
        const before = await exportWebsiteArchive(target);
        await target.exec("CREATE FUNCTION public.synthetic_restore_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'SYNTHETIC_INDEX_FAILURE'; END $$; CREATE CONSTRAINT TRIGGER synthetic_restore_failure AFTER INSERT ON nb_v2_media.sources DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.synthetic_restore_failure()");
        await assert.rejects(restoreWebsiteArchive(target, archive), /SYNTHETIC_INDEX_FAILURE/);
        assert.deepEqual(await exportWebsiteArchive(target), before);
      } finally { await target.close(); }
    });
  } finally { await sourceDb.close(); }
});

test("hybrid backup refuses changed, moved, expired and corrupt originals without falling back to Storage", async t => {
  const db = await database(), temp = await mkdtemp(join(await realpath(tmpdir()), "website-hybrid-fail-"));
  try {
    const s = await sample(db), ordinary = archivedWebsiteObjects(s.archive).find(m => m.mime === "image/png")!;
    const files = createWebsiteArchiveStore(join(temp, ".local"));
    const make = (download: (url: string) => Promise<{ bytes: Uint8Array; transformed?: true }>) => createWebsiteArchiveMediaReader(s.archive, { storage: () => { assert.fail("Notion-only objects must not try stale Storage"); }, client: () => s.client, download });
    await t.test("changed source URLs produce no download and no completed backup", async () => {
      const cover = s.page.cover, block = structuredClone(s.blocks[0]); s.page.cover = uploaded(hosted("changed.png"));
      if (s.blocks[0].type !== "image") assert.fail(); s.blocks[0].image = { ...uploaded(hosted("changed.png")), caption: [] };
      const path = join(temp, ".local/incomplete");
      await assert.rejects(files.save(path, s.archive, make(async () => { assert.fail("Changed fingerprints must not download"); })));
      await assert.rejects(lstat(path), { code: "ENOENT" }); s.page.cover = cover; s.blocks[0] = block;
    });
    await t.test("expired files and blocks moved to another owner cannot supply bytes", async () => {
      const cover = s.page.cover, block = structuredClone(s.blocks[0]); s.page.cover = uploaded(hosted("cover.png"));
      if (s.page.cover.type !== "file") assert.fail(); s.page.cover.file.expiry_time = "2020-01-01T00:00:00Z";
      s.blocks[0].parent = { type: "page_id", page_id: demoId(9000) };
      await assert.rejects(make(async () => { assert.fail(); }).read(ordinary)); s.page.cover = cover; s.blocks[0] = block;
    });
    await t.test("identical URLs with modified bytes or unexpected conversion fail hash validation", async () => {
      await assert.rejects(make(async () => ({ bytes: Buffer.alloc(DEMO_PNG.length) })).read(ordinary));
      await assert.rejects(make(async () => ({ bytes: DEMO_PNG, transformed: true })).read(ordinary));
    });
  } finally { await db.close(); await rm(temp, { recursive: true, force: true }); }
});

test("hybrid backup reads the exact files-property locator without requiring runtime source configuration", async () => {
  const db = await database();
  try {
    const s = await sample(db, true), ordinary = archivedWebsiteObjects(s.archive).find(m => m.mime === "image/png")!;
    const reader = createWebsiteArchiveMediaReader(s.archive, { storage: () => { assert.fail(); }, client: () => s.client, download: async url => { assert.ok(url.includes("cover.png")); return { bytes: DEMO_PNG }; } });
    assert.deepEqual(await reader.read(ordinary), DEMO_PNG);
  } finally { await db.close(); }
});

test("a valid Notion binding can preserve identical bytes from an unindexed historical row without requiring Storage", async () => {
  const db = await database();
  try {
    const s = await sample(db); if (s.archive.format !== "notionblog-website-archive-2") assert.fail();
    const failed = s.archive.tables.runs.find(row => row.status === "failed")!;
    s.archive.mediaSources.sources = s.archive.mediaSources.sources.filter(row => row.run_id !== failed.id);
    const ordinary = archivedWebsiteObjects(s.archive).find(m => m.mime === "image/png")!;
    const reader = createWebsiteArchiveMediaReader(s.archive, { storage: () => { assert.fail("An explicitly indexed Notion source can supply the archived hash"); }, client: () => s.client, download: async () => ({ bytes: DEMO_PNG }) });
    assert.deepEqual(await reader.read(ordinary), DEMO_PNG);
  } finally { await db.close(); }
});

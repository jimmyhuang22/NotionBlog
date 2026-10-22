import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import type { BlockObjectResponse } from "@notionhq/client";
import { SYNC_SCHEMA_DIGEST, type StoredMedia, type SyncRecord } from "../contracts/sync.ts";
import { WEBSITE_SCHEMA_DIGEST, type WebsiteWriter } from "../contracts/website-sync.ts";
import { createDemo, DEMO_PNG, demoId, demoPage, demoParagraph } from "../scripts/notion-sync/demo.ts";
import { FakeStorage } from "../scripts/notion-sync/fakes.ts";
import { runWebsiteSync, websitePolicy } from "../scripts/website-sync/worker.ts";
import { createWebsiteImageDownloader, websiteImageFailure } from "../scripts/website-sync/download.ts";
import { configDigest, mediaIdentity as v1MediaIdentity } from "../src/server/database/validation.ts";
import { mediaIdentity as v2MediaIdentity } from "../src/server/database/website-validation.ts";
import { createDatabaseWriter } from "../src/server/database/writer.ts";
import { createWebsiteWriter } from "../src/server/database/website-writer.ts";
import { createMediaSourceWriter, readMediaSource } from "../src/server/database/media-sources.ts";
import { createWebsiteMediaSourceWriter, readWebsiteMediaSource } from "../src/server/database/website-media-sources.ts";
import { createWebsiteDatabaseRepository } from "../src/server/database/website-repository.ts";
import type { SqlExecutor } from "../src/server/database/sql.ts";
import { hybridMediaResponse, type HybridMediaPorts } from "../src/server/media/hybrid.ts";
import { sourceFingerprint, type MediaSourceBinding, type MediaSourceProjection } from "../src/server/media/notion-source.ts";
import { resolveNotionMediaSource } from "../src/server/notion/media-source.ts";
import { parseWebsiteNotionConfig } from "../src/server/notion/website-config.ts";
import { createWebsiteNotionRepository } from "../src/server/notion/website-repository.ts";
import type { NotionReadClient } from "../src/server/notion/types.ts";

const gameId = demoId(1000), aboutId = demoId(600), privateChild = demoId(601);
const gameImage = demoId(55000), aboutOriginal = demoId(55001), aboutConverted = demoId(55002);
const jpeg = Uint8Array.from([255, 216, 255, 224, 0, 2, 255, 217]);
const pngHash = createHash("sha256").update(DEMO_PNG).digest("hex");
function hosted(file: string, signature = "fixture-signature") {
  const url = new URL(`https://assets.example.test/${file}`);
  url.searchParams.set("X-Amz-Signature", signature);
  return url.href;
}
const sourceUrls = { cover: hosted("game-cover.png"), game: hosted("game-body.png"), about: hosted("about-original.png"), converted: hosted("about-original.heic") };

function fixture() {
  const demo = createDemo(1);
  const uploaded = (url: string) => ({ type: "file" as const, file: { url, expiry_time: new Date(Date.now() + 600_000).toISOString() } });
  const image = (id: string, owner: string, url: string) => ({ ...demoParagraph(id, owner, ""), type: "image", image: { ...uploaded(url), caption: [] } } as BlockObjectResponse);
  demo.pages.get(gameId)!.cover = uploaded(sourceUrls.cover);
  demo.pages.set(aboutId, demoPage(aboutId, "Synthetic About", { type: "page_id", page_id: demoId(900) }));
  demo.pages.set(privateChild, demoPage(privateChild, "Unapproved descendant", { type: "page_id", page_id: aboutId }));
  demo.blocks.set(gameId, [image(gameImage, gameId, sourceUrls.game)]);
  demo.blocks.set(aboutId, [image(aboutOriginal, aboutId, sourceUrls.about), image(aboutConverted, aboutId, sourceUrls.converted)]);
  demo.blocks.set(privateChild, [image(demoId(55003), privateChild, sourceUrls.about)]);
  const config = { schemaVersion: 2, sources: [
    { key: "games", kind: "game", enabled: true, dataSourceId: demo.config.sources[0].dataSourceId, fields: { title: "Name" }, cover: { strategy: "native-page-cover" }, publication: { mode: "all", allowlistPageIds: [] } },
    { key: "about", kind: "page", enabled: true, pageId: aboutId, pageKey: "about", fields: { title: "Name" }, publication: { mode: "allowlist", allowlistPageIds: [aboutId] } },
  ] };
  const reads = { pages: 0, rows: 0, blocks: 0, bodies: 0 };
  const client: NotionReadClient = {
    getPage: async id => { reads.pages++; return structuredClone(demo.pages.get(id) ?? null); },
    getDataSource: async id => structuredClone(demo.schemas.get(id)!),
    getBlock: async id => { reads.blocks++; return structuredClone([...demo.blocks.values()].flat().find(block => block.id === id) ?? null); },
    listBlocks: async id => { reads.bodies++; return structuredClone(demo.blocks.get(id) ?? []); },
    listPages: async id => { reads.rows++; return structuredClone([...demo.pages.values()].filter(page => page.parent.type === "data_source_id" && page.parent.data_source_id === id)); },
  };
  let downloads = 0;
  const download = async (url: string) => {
    downloads++; assert.ok(Object.values(sourceUrls).includes(url));
    return url === sourceUrls.converted ? { bytes: jpeg, mime: "image/jpeg" as const, transformed: true as const } : { bytes: Uint8Array.from(DEMO_PNG), mime: "image/png" as const };
  };
  const live = createWebsiteNotionRepository({ client, config: parseWebsiteNotionConfig(config) });
  const storage = new FakeStorage();
  function replace(id: string, url: string) {
    const block = [...demo.blocks.values()].flat().find(block => block.id === id);
    assert.equal(block?.type, "image");
    if (block?.type === "image") block.image = { ...uploaded(url), caption: [] };
  }
  return { demo, config, client, live, reads, storage, download, downloads: () => downloads, replace };
}

test("fresh collection errors retain the exact owner and cover or block locator", async t => {
  for (const location of ["cover", "block"]) await t.test(location, async t => {
    const s = fixture();
    if (location === "block") s.demo.pages.get(gameId)!.cover = null;
    const download = createWebsiteImageDownloader({ resolve: async () => [{ address: "8.8.8.8", family: 4 }],
      request: async () => ({ status: 403, headers: {}, bytes: (async function* () {})(), cancel() {} }) });
    t.after(download.close);
    let escaped: unknown;
    await assert.rejects(runWebsiteSync({ client: s.client, config: s.config, mode: "dry-run", download }), error => {
      escaped = error; return error instanceof Error && "code" in error && error.code === "IMAGE_UNAVAILABLE";
    });
    assert.deepEqual(websiteImageFailure(escaped)?.context, { ownerPageId: gameId,
      locator: location === "cover" ? { kind: "cover" } : { kind: "block", id: gameImage } });
  });
});

test('qualified hybrid collection refreshes an expiring cover only after current owner and fingerprint validation', async t => {
  for (const variant of ['expired', 'nearly-expired', 'changed', 'withdrawn']) await t.test(variant, async () => {
    const s = fixture(), page = s.demo.pages.get(gameId)!;
    assert.equal(page.cover?.type, 'file');
    if (page.cover?.type !== 'file') assert.fail();
    page.cover.file.expiry_time = new Date(Date.now() + (variant === 'nearly-expired' ? 10_000 : -1000)).toISOString();
    const fresh = structuredClone(page);
    if (fresh.cover?.type !== 'file') assert.fail();
    fresh.cover.file = { url: hosted(variant === 'changed' ? 'different-cover.png' : 'game-cover.png', 'refreshed'), expiry_time: new Date(Date.now() + 600_000).toISOString() };
    if (variant === 'withdrawn') fresh.archived = true;
    const client = { ...s.client, getPage: async (id: string) => id === gameId ? structuredClone(fresh) : s.client.getPage(id) };
    const downloaded: string[] = [];
    const run = () => runWebsiteSync({ client, config: s.config, mode: 'dry-run',
      mediaSources: { stage: async () => { assert.fail('dry-run must not stage'); } },
      download: async url => { downloaded.push(url); return { bytes: DEMO_PNG, mime: 'image/png' }; },
    });
    if (variant === 'changed' || variant === 'withdrawn') {
      await assert.rejects(run());
      assert.equal(downloaded.some(url => url.includes('game-cover')), false);
      assert.equal(downloaded.some(url => url.includes('different-cover')), false);
    } else {
      const result = await run();
      assert.equal(result.sourceRefreshes, 1);
      assert.ok(downloaded.includes(hosted('game-cover.png', 'refreshed')));
      assert.equal(downloaded.includes(sourceUrls.cover), false);
    }
  });
});

async function database(s: ReturnType<typeof fixture>, v1 = false) {
  const db = await PGlite.create();
  const migration = async (path: string) => db.exec(await readFile(new URL(`../database/${path}`, import.meta.url), "utf8"));
  if (v1) {
    await migration("migrations/001_content.sql");
    await db.query("UPDATE nb.state SET schema_digest=$1", [SYNC_SCHEMA_DIGEST]);
    await migration("media-migrations/001_media_sources.sql");
  }
  await migration("website-migrations/001_website.sql");
  await db.query("UPDATE nb_v2.state SET schema_digest=$1", [WEBSITE_SCHEMA_DIGEST]);
  await migration("website-media-migrations/001_website_media_sources.sql");
  const policy = await websitePolicy(s.client, s.config, 600);
  await db.query("SELECT nb_v2_api.configure_policy($1,$2,$3::jsonb,$4::jsonb)", [policy.configDigest, policy.freshnessSeconds, JSON.stringify(policy.sources), JSON.stringify(policy.permits)]);
  const role = (name: "nb_reader" | "nb_writer"): SqlExecutor => ({ query: <T>(sql: string, values?: unknown[]) => db.transaction(async tx => {
    await tx.exec(`SET LOCAL ROLE ${name}`); return tx.query<T>(sql, values);
  }) });
  const reader = role("nb_reader"), writerDb = role("nb_writer");
  return { db, reader, writerDb, writer: createWebsiteWriter(writerDb), mediaSources: createWebsiteMediaSourceWriter(writerDb) };
}

function mediaPorts(s: ReturnType<typeof fixture>, reader: SqlExecutor) {
  const counts = { storage: 0 };
  const ports: HybridMediaPorts = { version: "v2", read: id => readWebsiteMediaSource(reader, id),
    resolve: binding => resolveNotionMediaSource(binding, s.live, s.client),
    storage: () => { counts.storage++; return s.storage; } };
  return { ports, counts };
}
const workerOptions = (s: ReturnType<typeof fixture>, d: Awaited<ReturnType<typeof database>>) => ({ client: s.client, config: s.config, download: s.download, storage: s.storage, writer: d.writer, mediaSources: d.mediaSources, mode: "publish" as const });

async function allMedia(d: Awaited<ReturnType<typeof database>>): Promise<MediaSourceProjection[]> {
  const { rows } = await d.db.query<{ asset_id: string }>("SELECT asset_id FROM nb_v2.media WHERE run_id=(SELECT current_run FROM nb_v2.state) ORDER BY asset_id");
  return Promise.all(rows.map(async row => {
    const source = await readWebsiteMediaSource(d.reader, row.asset_id); assert.ok(source); return source;
  }));
}
const controlled = (error: unknown) => error instanceof Error && "code" in error && error.code === "CONTENT_UNAVAILABLE";

test("v2 media budget counts unique bytes and a smaller budget preserves the complete publication", async () => {
  const s = fixture(), d = await database(s), exact = DEMO_PNG.length + jpeg.length;
  try {
    const report = await runWebsiteSync({ ...workerOptions(s, d), maxMediaBytes: exact });
    assert.equal(report.media, 4); assert.equal(report.uniqueObjects, 2);
    assert.equal(report.mediaBytes, exact); assert.equal(report.mediaByteLimit, exact);
    const before = (await d.db.query<{ current_run: string }>("SELECT current_run FROM nb_v2.state")).rows[0].current_run;
    await assert.rejects(runWebsiteSync({ ...workerOptions(s, d), maxMediaBytes: exact - 1 }), controlled);
    const state = (await d.db.query<{ current_run: string; lease_run: string | null }>("SELECT current_run,lease_run FROM nb_v2.state")).rows[0];
    assert.equal(state.current_run, before); assert.equal(state.lease_run, null);
    assert.equal((await d.db.query<{ status: string }>("SELECT status FROM nb_v2.runs ORDER BY started_at DESC LIMIT 1")).rows[0].status, "failed");
    assert.equal((await d.db.query<{ n: number }>("SELECT count(*)::int AS n FROM nb_v2.records WHERE run_id=$1", [before])).rows[0].n, 2);
    assert.equal((await allMedia(d)).length, 4);
  } finally { await d.db.close(); }
});

test("v2 media budget rejects invalid and unbounded values before reads, downloads or a lease", async () => {
  const s = fixture(), maximum = 2 * 1024 * 1024 * 1024;
  const forbidden = async () => assert.fail("Invalid budget must not acquire a lease");
  const writer: WebsiteWriter = { begin: forbidden, renew: forbidden, stage: forbidden, promote: forbidden, fail: forbidden };
  for (const maxMediaBytes of [0, -1, 1.5, NaN, Infinity, maximum + 1, Number.MAX_SAFE_INTEGER]) {
    await assert.rejects(runWebsiteSync({ client: s.client, config: s.config, mode: "publish", writer, storage: s.storage, download: s.download, maxMediaBytes }),
      error => error instanceof Error && "code" in error && error.code === "MISCONFIGURED");
  }
  assert.equal(s.downloads(), 0); assert.deepEqual(s.reads, { pages: 0, rows: 0, blocks: 0, bodies: 0 });
  const options = { client: s.client, config: s.config, mode: "dry-run" as const, download: s.download };
  assert.equal((await runWebsiteSync(options)).mediaByteLimit, 1024 * 1024 * 1024);
  assert.equal((await runWebsiteSync({ ...options, maxMediaBytes: maximum })).mediaByteLimit, maximum);
});

test("v2 worker, SQL publication, real Notion resolver and hybrid HTTP support games and the fixed About page", async () => {
  const s = fixture(), d = await database(s);
  try {
    assert.equal((await d.db.query<{ ns: string | null }>("SELECT to_regnamespace('nb')::text AS ns")).rows[0].ns, null, "The v2 pipeline must work without a v1 core or index");
    let indexCalls = 0;
    const report = await runWebsiteSync({ ...workerOptions(s, d), mediaSources: { stage: async (lease, bindings) => {
      indexCalls++;
      const staged = await d.db.query<{ owners: number; descriptors: number }>("SELECT (SELECT count(*)::integer FROM nb_v2.records WHERE run_id=$1) AS owners,(SELECT count(*)::integer FROM nb_v2.media WHERE run_id=$1) AS descriptors", [lease.runId]);
      assert.deepEqual(staged.rows, [{ owners: 2, descriptors: 4 }]);
      await d.mediaSources.stage(lease, bindings);
    } } });
    assert.equal(report.outcome, "publish"); assert.equal(report.records, 2); assert.equal(report.media, 4);
    assert.equal(report.uniqueObjects, 2); assert.equal(report.mediaBytes, DEMO_PNG.length + jpeg.length);
    assert.equal(indexCalls, 1); assert.equal(s.downloads(), 4); assert.equal(s.storage.puts, 1);
    const repository = createWebsiteDatabaseRepository(d.reader);
    const game = await repository.get("game", gameId), about = await repository.get("page", "about");
    assert.ok(game?.document && about?.document); assert.equal(game.item.kind, "game"); assert.equal(about.item.href, "/about");
    assert.equal(await repository.get("page", privateChild), null); assert.equal(await s.live.resolvePublicPage(privateChild), null);
    const projections = await allMedia(d);
    assert.equal(projections.filter(p => p.binding.delivery === "notion").length, 3);
    assert.equal(projections.filter(p => p.binding.delivery === "storage").length, 1);
    const original = projections.find(p => p.binding.locator.kind === "block" && p.binding.locator.id === gameImage)!;
    const derivative = projections.find(p => p.binding.delivery === "storage")!;
    assert.equal(original.media.assetId, v2MediaIdentity(gameId, gameImage, pngHash));
    assert.notEqual(original.media.assetId, v1MediaIdentity(gameId, `block:${gameImage}`, pngHash));
    assert.equal(s.storage.objects.has(original.media.objectKey), false);
    assert.equal(s.storage.objects.has(derivative.media.objectKey), true);
    const { ports, counts } = mediaPorts(s, d.reader);
    const fresh = hosted("game-body.png", "fresh-after-publish"); s.replace(gameImage, fresh);
    const before = { ...s.reads };
    const response = await hybridMediaResponse(original.media.assetId, ports);
    assert.equal(response.status, 302); assert.equal(response.headers.get("Location"), fresh);
    assert.equal(response.headers.get("Cache-Control"), "private, no-store"); assert.equal(response.headers.get("Referrer-Policy"), "no-referrer");
    assert.equal(counts.storage, 0); assert.equal(s.reads.rows, before.rows, "A single media owner check must not enumerate all game rows");
    const converted = await hybridMediaResponse(derivative.media.assetId, ports);
    assert.equal(converted.status, 200); assert.equal(converted.headers.get("Content-Type"), "image/jpeg");
    assert.equal(converted.headers.get("X-Content-Type-Options"), "nosniff");
    assert.deepEqual(new Uint8Array(await converted.arrayBuffer()), jpeg); assert.equal(counts.storage, 1);
    // The v1 locator validator must never accidentally accept a v2 block identity.
    await assert.rejects(hybridMediaResponse(original.media.assetId, { ...ports, version: "v1" }), controlled);
    await d.db.query("SELECT nb_v2_api.set_denied($1,true)", [aboutId]);
    assert.equal(await repository.getPage!("about"), null);
    assert.equal((await hybridMediaResponse(derivative.media.assetId, ports)).status, 404); assert.equal(counts.storage, 1);
  } finally { await d.db.close(); }
});

test("v2 source-index stage failure preserves the previous SQL publication and releases its lease", async () => {
  const s = fixture(), d = await database(s);
  try {
    await runWebsiteSync(workerOptions(s, d));
    const prior = (await d.db.query<{ current_run: string }>("SELECT current_run FROM nb_v2.state")).rows[0].current_run;
    const failure = new Error("Synthetic private-index failure");
    let attempted = 0;
    await assert.rejects(runWebsiteSync({ ...workerOptions(s, d), mediaSources: { stage: async (_lease, bindings) => { attempted++; assert.equal(bindings.length, 4); throw failure; } } }), failure);
    assert.equal(attempted, 1);
    const state = await d.db.query<{ current_run: string; lease_run: null }>("SELECT current_run,lease_run FROM nb_v2.state");
    assert.deepEqual(state.rows, [{ current_run: prior, lease_run: null }]);
    assert.deepEqual((await d.db.query<{ status: string; count: number }>("SELECT status,count(*)::integer AS count FROM nb_v2.runs GROUP BY status ORDER BY status")).rows, [{ status: "failed", count: 1 }, { status: "published", count: 1 }]);
    assert.equal((await allMedia(d)).length, 4);
  } finally { await d.db.close(); }
});

test("v2 transformed media rejects live source replacement, archival and database withdrawal after object reading", async t => {
  const s = fixture(), d = await database(s);
  try {
    await runWebsiteSync(workerOptions(s, d));
    const derivative = (await allMedia(d)).find(p => p.binding.delivery === "storage")!;
    for (const variant of ["replacement", "archive", "central-deny"] as const) await t.test(variant, async () => {
      const { ports } = mediaPorts(s, d.reader);
      let reads = 0;
      ports.storage = () => ({ put: async () => assert.fail("Media readers cannot write"), read: async media => {
        reads++; const bytes = await s.storage.read(media);
        if (variant === "replacement") s.replace(aboutConverted, hosted("replaced-original.heic"));
        if (variant === "archive") s.demo.pages.get(aboutId)!.archived = true;
        if (variant === "central-deny") await d.db.query("SELECT nb_v2_api.set_denied($1,true)", [aboutId]);
        return bytes;
      } });
      const response = await hybridMediaResponse(derivative.media.assetId, ports);
      assert.equal(response.status, 404); assert.equal(await response.text(), ""); assert.equal(response.headers.get("Location"), null); assert.equal(reads, 1);
      s.replace(aboutConverted, sourceUrls.converted); s.demo.pages.get(aboutId)!.archived = false;
      if (variant === "central-deny") await d.db.query("SELECT nb_v2_api.set_denied($1,false)", [aboutId]);
    });
  } finally { await d.db.close(); }
});

test("v2 hybrid dry-run never touches writer/index/storage and legacy mode still stores every unique original", async () => {
  const s = fixture(), d = await database(s);
  try {
    const trap = async () => assert.fail("Dry-run cannot mutate a destination");
    const forbidden: WebsiteWriter = { begin: trap, renew: trap, stage: trap, promote: trap, fail: trap };
    const dry = await runWebsiteSync({ ...workerOptions(s, d), mode: "dry-run", writer: forbidden, mediaSources: { stage: trap }, storage: { put: trap, read: trap } });
    assert.equal(dry.records, 2); assert.equal(dry.media, 4); assert.equal(s.downloads(), 4);
    assert.equal((await d.db.query<{ count: number }>("SELECT count(*)::integer AS count FROM nb_v2.runs")).rows[0].count, 0);
    const { mediaSources: _sourceIndex, ...legacy } = workerOptions(s, d);
    await runWebsiteSync(legacy);
    assert.equal(s.storage.puts, 2); assert.equal(s.storage.objects.size, 2);
    assert.equal((await d.db.query<{ count: number }>("SELECT count(*)::integer AS count FROM nb_v2_media.sources")).rows[0].count, 0);
    const id = v2MediaIdentity(gameId, gameImage, pngHash);
    assert.equal(await readWebsiteMediaSource(d.reader, id), null, "A legacy batch with no private locator must not invent a live source fallback");
  } finally { await d.db.close(); }
});

test("v2 publishing preserves an active v1 publication, its private index and prefixed block identity", async () => {
  const s = fixture(), d = await database(s, true);
  try {
    const v1Digest = configDigest({ fixture: "v1-publication" });
    await d.db.query("SELECT nb_api.configure_policy($1,600,$2::jsonb,'[]'::jsonb)", [v1Digest, JSON.stringify([{ key: "status", kind: "status", mode: "all", dataSourceId: s.demo.config.sources[0].dataSourceId, databaseParentId: null }])]);
    const oldId = v1MediaIdentity(gameId, `block:${gameImage}`, pngHash);
    const descriptor: StoredMedia = { assetId: oldId, ownerPageId: gameId, objectKey: `sha256/${pngHash}`, sha256: pngHash, byteSize: DEMO_PNG.length, mime: "image/png", width: null, height: null };
    const old: SyncRecord = { detail: { item: { id: gameId, kind: "status", slug: gameId, href: `/status#${gameId}`, title: "Synthetic v1 status", summary: null, tags: [], cover: null, updatedAt: null, recordedAt: null, text: [] }, document: { blocks: [{ id: "old-image", type: "image", image: { id: oldId, src: `/media/${oldId}`, alt: "Fixture", width: null, height: null }, caption: [] }], toc: [], completeness: "complete" } }, evidence: { sourceKey: "status", dataSourceId: s.demo.config.sources[0].dataSourceId, databaseParentId: null, courseId: null, parentId: null, ordinal: 0 } };
    const binding: MediaSourceBinding = { assetId: oldId, ownerPageId: gameId, sha256: pngHash, locator: { kind: "block", id: gameImage }, delivery: "notion", sourceFingerprint: sourceFingerprint(sourceUrls.game, true) };
    const v1Writer = createDatabaseWriter(d.writerDb), lease = await v1Writer.begin(randomUUID(), v1Digest);
    await v1Writer.stage(lease, [old], [descriptor]); await createMediaSourceWriter(d.writerDb).stage(lease, [binding]); await v1Writer.promote(lease, { records: 1, media: 1, complete: true });
    const before = (await d.db.query("SELECT current_run,revision,epoch,fence,schema_digest FROM nb.state")).rows;
    await runWebsiteSync(workerOptions(s, d));
    assert.deepEqual((await d.db.query("SELECT current_run,revision,epoch,fence,schema_digest FROM nb.state")).rows, before);
    assert.deepEqual(await readMediaSource(d.reader, oldId), { media: descriptor, binding });
    const newId = v2MediaIdentity(gameId, gameImage, pngHash);
    assert.notEqual(oldId, newId); assert.equal(await readMediaSource(d.reader, newId), null); assert.equal(await readWebsiteMediaSource(d.reader, oldId), null);
    assert.equal((await readWebsiteMediaSource(d.reader, newId))?.binding.locator.kind, "block");
    assert.equal((await d.db.query<{ count: number }>("SELECT count(*)::integer AS count FROM nb_media.sources")).rows[0].count, 1);
    assert.equal((await d.db.query<{ count: number }>("SELECT count(*)::integer AS count FROM nb_v2_media.sources")).rows[0].count, 4);
  } finally { await d.db.close(); }
});

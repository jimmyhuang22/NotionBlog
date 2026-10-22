import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import type { BlockObjectResponse } from "@notionhq/client";
import { SYNC_SCHEMA_DIGEST, type RunLease } from "../contracts/sync.ts";
import { createDemo, DEMO_PNG, demoId, demoParagraph } from "../scripts/notion-sync/demo.ts";
import { FakeStorage, FakeWriter } from "../scripts/notion-sync/fakes.ts";
import { runSync } from "../scripts/notion-sync/worker.ts";
import { sourceFingerprint, validateMediaSource, type MediaSourceBinding } from "../src/server/media/notion-source.ts";
import { configDigest } from "../src/server/database/validation.ts";
import { createDatabaseWriter } from "../src/server/database/writer.ts";
import { createMediaSourceWriter, readMediaSource } from "../src/server/database/media-sources.ts";
import { createDatabaseRepository } from "../src/server/database/repository.ts";
import type { SqlExecutor } from "../src/server/database/sql.ts";
import { hybridMediaResponse } from "../src/server/media/hybrid.ts";
import { resolveNotionMediaSource } from "../src/server/notion/media-source.ts";
import { createNotionRepository } from "../src/server/notion/repository.ts";
import { parseNotionSourcesConfig } from "../src/server/notion/config.ts";
import type { NotionReadClient } from "../src/server/notion/types.ts";

const owner = demoId(1000), ordinaryId = demoId(45000), convertedId = demoId(45001);
function hosted(file: string, signature: string) {
  const url = new URL(`https://assets.example.test/${file}`);
  url.searchParams.set("X-Amz-Signature", signature);
  return url.href;
}
const ordinaryUrl = hosted("original.png", "fixture-original");
const convertedUrl = hosted("original.heic", "fixture-heic");
const jpeg = Uint8Array.from([255, 216, 255, 224, 0, 2, 255, 217]);

function setup(converted = false) {
  const demo = createDemo(1);
  demo.config.sources = demo.config.sources.slice(0, 1);
  const image = (id: string, url: string) => ({ ...demoParagraph(id, owner, ""), type: "image", image: { type: "file", file: { url, expiry_time: new Date(Date.now() + 600_000).toISOString() }, caption: [] } } as BlockObjectResponse);
  demo.blocks.set(owner, [image(ordinaryId, ordinaryUrl), ...converted ? [image(convertedId, convertedUrl)] : []]);
  // Use a finite in-memory source behind the real collector/repository. This
  // avoids SDK request throttling without replacing synchronization behavior.
  const client: NotionReadClient = {
    getPage: async id => structuredClone(demo.pages.get(id) ?? null),
    getDataSource: async id => structuredClone(demo.schemas.get(id)!),
    getBlock: async id => structuredClone([...demo.blocks.values()].flat().find(block => block.id === id) ?? null),
    listBlocks: async id => structuredClone(demo.blocks.get(id) ?? []),
    listPages: async id => structuredClone([...demo.pages.values()].filter(page => page.parent.type === "data_source_id" && page.parent.data_source_id === id)),
  };
  const writer = new FakeWriter(), storage = new FakeStorage();
  const bindings = new Map<string, MediaSourceBinding>();
  let indexCalls = 0, downloads = 0;
  const mediaSources = { stage: async (lease: RunLease, batch: MediaSourceBinding[]) => {
    indexCalls++;
    assert.deepEqual(lease, writer.lease);
    for (const binding of batch) {
      const descriptor = writer.media.get(binding.assetId);
      assert.ok(descriptor, "Core descriptors must be staged before their private source index");
      assert.ok(writer.records.has(binding.ownerPageId), "The core owner must precede the source index");
      validateMediaSource(binding, descriptor);
      bindings.set(binding.assetId, structuredClone(binding));
    }
  } };
  const download = async (url: string) => {
    downloads++;
    assert.ok([ordinaryUrl, convertedUrl].includes(url));
    return url === convertedUrl ? { bytes: jpeg, mime: "image/jpeg" as const, transformed: true as const } : { bytes: Uint8Array.from(DEMO_PNG), mime: "image/png" as const };
  };
  return { demo, client, writer, storage, bindings, mediaSources, download, counts: () => ({ indexCalls, downloads }) };
}
const options = (s: ReturnType<typeof setup>) => ({ client: s.client, config: s.demo.config, writer: s.writer, storage: s.storage, download: s.download, mediaSources: s.mediaSources, mode: "publish" as const });

test("hybrid synchronization verifies ordinary bytes but stages only metadata and private source bindings", async () => {
  const s = setup();
  const report = await runSync(options(s));
  assert.equal(report.outcome, "published"); assert.equal(report.records, 1); assert.equal(report.media, 1);
  assert.equal(report.uniqueObjects, 1); assert.equal(report.mediaBytes, DEMO_PNG.length);
  assert.equal(s.storage.puts, 0); assert.equal(s.storage.objects.size, 0);
  assert.equal(s.writer.media.size, 1); assert.equal(s.writer.current.size, 1);
  assert.deepEqual(s.counts(), { downloads: 1, indexCalls: 1 });
  const binding = [...s.bindings.values()][0];
  assert.equal(binding.delivery, "notion"); assert.deepEqual(binding.locator, { kind: "block", id: ordinaryId });
  assert.equal(binding.sourceFingerprint, sourceFingerprint(ordinaryUrl, true));
  const serialized = JSON.stringify([...s.writer.records.values()]);
  assert.ok(!serialized.includes("X-Amz-Signature") && !serialized.includes("assets.example.test"));
  assert.ok(s.writer.calls.indexOf("promote") > s.writer.calls.lastIndexOf("stage"));
});

test("hybrid mixed images upload only explicitly transformed derivatives and bind each original source", async () => {
  const s = setup(true);
  const report = await runSync(options(s));
  assert.equal(report.records, 1); assert.equal(report.media, 2); assert.equal(report.uniqueObjects, 2);
  assert.equal(report.mediaBytes, DEMO_PNG.length + jpeg.length);
  assert.equal(s.storage.puts, 1); assert.equal(s.storage.objects.size, 1);
  assert.deepEqual(s.counts(), { downloads: 2, indexCalls: 1 });
  const ordinary = [...s.bindings.values()].find(binding => binding.delivery === "notion")!;
  const derivative = [...s.bindings.values()].find(binding => binding.delivery === "storage")!;
  assert.deepEqual(derivative.locator, { kind: "block", id: convertedId });
  assert.equal(derivative.sourceFingerprint, sourceFingerprint(convertedUrl, true));
  assert.equal(s.storage.objects.has(s.writer.media.get(ordinary.assetId)!.objectKey), false);
  assert.deepEqual(await s.storage.read(s.writer.media.get(derivative.assetId)!), jpeg);
});

test("a failed source-index stage cannot promote or replace the current publication", async () => {
  const s = setup();
  await runSync(options(s));
  const current = s.writer.current;
  const failure = new Error("Fictional source-index stage failure");
  let indexCalls = 0;
  await assert.rejects(runSync({ ...options(s), mediaSources: { stage: async (_lease, batch) => { indexCalls++; assert.equal(batch.length, 1); throw failure; } } }), failure);
  assert.equal(indexCalls, 1); assert.equal(s.writer.current, current);
  assert.equal(s.writer.calls.filter(call => call === "promote").length, 1);
  assert.equal(s.writer.calls.at(-1), "fail"); assert.equal(s.writer.lease, null);
  assert.equal(s.storage.puts, 0);
});

test("legacy synchronization without the opt-in source index continues storing ordinary originals", async () => {
  const s = setup();
  const { mediaSources: _index, ...legacy } = options(s);
  const report = await runSync(legacy);
  assert.equal(report.outcome, "published"); assert.equal(report.media, 1);
  assert.equal(s.storage.puts, 1); assert.equal(s.bindings.size, 0); assert.equal(s.counts().indexCalls, 0);
  assert.deepEqual(await s.storage.read([...s.writer.media.values()][0]), Uint8Array.from(DEMO_PNG));
});

test("hybrid dry-run downloads and verifies both types without owner, index, object or publication writes", async () => {
  const s = setup(true);
  const report = await runSync({ ...options(s), mode: "dry-run" });
  assert.equal(report.outcome, "dry-run"); assert.equal(report.records, 1); assert.equal(report.media, 2);
  assert.deepEqual(s.counts(), { downloads: 2, indexCalls: 0 });
  assert.deepEqual(s.writer.calls, []); assert.equal(s.storage.puts, 0); assert.equal(s.storage.objects.size, 0); assert.equal(s.bindings.size, 0);
});

test("real SQL publication connects worker source bindings to fresh Notion redirects and verified converted bytes", async () => {
  const s = setup(true);
  const db = await PGlite.create();
  try {
    await db.exec(await readFile(new URL("../database/migrations/001_content.sql", import.meta.url), "utf8"));
    await db.query("UPDATE nb.state SET schema_digest=$1", [SYNC_SCHEMA_DIGEST]);
    await db.exec(await readFile(new URL("../database/reader-migrations/001_status.sql", import.meta.url), "utf8"));
    await db.exec(await readFile(new URL("../database/media-migrations/001_media_sources.sql", import.meta.url), "utf8"));
    const source = s.demo.config.sources[0];
    const digest = configDigest(parseNotionSourcesConfig(s.demo.config));
    await db.query("SELECT nb_api.configure_policy($1,$2,$3::jsonb,$4::jsonb)", [digest, 600,
      JSON.stringify([{ key: source.key, kind: source.kind, mode: "all", dataSourceId: source.dataSourceId, databaseParentId: null }]), "[]"]);
    const role = (name: "nb_reader" | "nb_writer"): SqlExecutor => ({ query: <T>(sql: string, values?: unknown[]) => db.transaction(async tx => {
      await tx.exec(`SET LOCAL ROLE ${name}`);
      return tx.query<T>(sql, values);
    }) });
    const writerDb = role("nb_writer"), readerDb = role("nb_reader");
    const report = await runSync({ ...options(s), writer: createDatabaseWriter(writerDb), mediaSources: createMediaSourceWriter(writerDb) });
    assert.equal(report.outcome, "published"); assert.equal(report.media, 2); assert.equal(s.storage.puts, 1);
    const counts = await db.query<{ descriptors: number; bindings: number; published: number }>("SELECT (SELECT count(*)::integer FROM nb.media) AS descriptors,(SELECT count(*)::integer FROM nb_media.sources) AS bindings,(SELECT count(*)::integer FROM nb.runs WHERE status='published') AS published");
    assert.deepEqual(counts.rows, [{ descriptors: 2, bindings: 2, published: 1 }]);
    const detail = await createDatabaseRepository(readerDb).get("status", owner);
    assert.ok(detail?.document);
    const images = detail.document.blocks.filter(block => block.type === "image");
    assert.equal(images.length, 2);
    const ordinary = await readMediaSource(readerDb, images[0].image.id);
    const derivative = await readMediaSource(readerDb, images[1].image.id);
    assert.equal(ordinary?.binding.delivery, "notion"); assert.equal(derivative?.binding.delivery, "storage");
    assert.ok(!s.storage.objects.has(ordinary!.media.objectKey));
    assert.ok(s.storage.objects.has(derivative!.media.objectKey));
    // Rotation changes only the hosted signature, retaining the published file binding.
    const image = s.demo.blocks.get(owner)![0];
    assert.equal(image.type, "image");
    if (image.type === "image") image.image = { type: "file", file: { url: ordinaryUrl.replace("fixture-original", "fresh-after-publication"), expiry_time: new Date(Date.now() + 600_000).toISOString() }, caption: [] };
    const liveRepository = createNotionRepository({ client: s.client, config: s.demo.config });
    let storageInitializations = 0;
    const ports = { read: (id: string) => readMediaSource(readerDb, id),
      resolve: (binding: MediaSourceBinding) => resolveNotionMediaSource(binding, liveRepository, s.client),
      storage: () => { storageInitializations++; return s.storage; } };
    const originalResponse = await hybridMediaResponse(ordinary!.media.assetId, ports);
    assert.equal(originalResponse.status, 302);
    assert.equal(originalResponse.headers.get("Location"), ordinaryUrl.replace("fixture-original", "fresh-after-publication"));
    assert.equal(storageInitializations, 0);
    const convertedResponse = await hybridMediaResponse(derivative!.media.assetId, ports);
    assert.equal(convertedResponse.status, 200); assert.equal(convertedResponse.headers.get("Content-Type"), "image/jpeg");
    assert.equal(convertedResponse.headers.get("Cache-Control"), "private, no-store");
    assert.deepEqual(new Uint8Array(await convertedResponse.arrayBuffer()), jpeg);
    assert.equal(storageInitializations, 1);
    // A real central denial removes both source projections before resolution/storage.
    await db.query("SELECT nb_api.set_denied($1,true)", [owner]);
    assert.equal(await readMediaSource(readerDb, ordinary!.media.assetId), null);
    assert.equal((await hybridMediaResponse(ordinary!.media.assetId, ports)).status, 404);
    assert.equal((await hybridMediaResponse(derivative!.media.assetId, ports)).status, 404);
    assert.equal(storageInitializations, 1);
  } finally { await db.close(); }
});

import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import type { BlockObjectResponse } from "@notionhq/client";
import type { WebsiteRecord } from "../contracts/website-sync.ts";
import { WEBSITE_SCHEMA_DIGEST } from "../contracts/website-sync.ts";
import { createDemo, DEMO, demoId, demoParagraph } from "../scripts/notion-sync/demo.ts";
import { createWebsiteWriter } from "../src/server/database/website-writer.ts";
import { parseWebsiteNotionConfig } from "../src/server/notion/website-config.ts";
import { createCollectionCapture } from "../scripts/website-sync/collection-capture.ts";
import { prepareCollectionResume } from "../scripts/website-sync/collection-revalidation.ts";
import { runWebsiteSync, websitePolicy } from "../scripts/website-sync/worker.ts";
import { checkCaptureReleaseCompatibility } from "../scripts/website-sync/capture-release-compatibility.ts";
import transition from "../database/capture-external-video-compatibility.json" with { type: "json" };
import publicationRepair from "../database/capture-publication-revalidation-compatibility.json" with { type: "json" };
import revalidation from "../database/qualified-revalidation-protocol.json" with { type: "json" };
import fresh from "../database/fresh-qualification-protocol.json" with { type: "json" };

test("external video transition accepts only its exact producer, mapper pair and unchanged runtime", async () => {
  const common = { nodePath: "/node", nodeVersion: "24.21.0", nodeSha256: "a".repeat(64) };
  const producer = { ...common, commit: transition.producerCommit, files: transition.files.map(f => ({ path: f.path, sha256: f.before })) };
  const consumer = { ...common, commit: "b".repeat(40), files: [...transition.files.map(f => ({ path: f.path, sha256: f.after })),
    { path: "database/capture-external-video-compatibility.json", sha256: "c".repeat(64) }] };
  assert.equal(checkCaptureReleaseCompatibility(producer, consumer).format, "capture-external-video-links-v1");
  for (const pair of transition.files) {
    const actual = createHash("sha256").update(await readFile(new URL("../" + pair.path, import.meta.url))).digest("hex");
    if (pair.path === "src/server/notion/website-repository.ts") {
      // The older video-only transition must reject the newer archive, rating and search-display mapper.
      assert.equal(actual, "05a715df156fbc3a54bf6a2afe2b45245cd265c098c6648face5002ed4e24288");
      const newerMapper = structuredClone(consumer);
      newerMapper.files.find(file => file.path === pair.path)!.sha256 = actual;
      assert.throws(() => checkCaptureReleaseCompatibility(producer, newerMapper), { code: "RELEASE_INVALID" });
    } else assert.equal(actual, pair.after);
    for (const side of ["before", "after"]) {
      const old = structuredClone(producer), current = structuredClone(consumer);
      (side === "before" ? old : current).files.find(f => f.path === pair.path)!.sha256 = "0".repeat(64);
      assert.throws(() => checkCaptureReleaseCompatibility(old, current), { code: "RELEASE_INVALID" });
    }
  }
  for (const path of ["scripts/website-sync/worker.ts", "scripts/website-sync/runtime-sql.ts", "scripts/website-sync/collection-revalidation.ts", "scripts/website-sync/collection-source-proof.ts", "contracts/content.ts", "package-lock.json"]) {
    const current = structuredClone(consumer); current.files.push({ path, sha256: "0".repeat(64) });
    assert.throws(() => checkCaptureReleaseCompatibility(producer, current), { code: "RELEASE_INVALID" }, path);
  }
  assert.throws(() => checkCaptureReleaseCompatibility({ ...producer, commit: "d".repeat(40) }, consumer), { code: "RELEASE_INVALID" });
  assert.throws(() => checkCaptureReleaseCompatibility(producer, { ...consumer, nodeVersion: "24.22.0" }), { code: "RELEASE_INVALID" });
  assert.throws(() => checkCaptureReleaseCompatibility(producer, { ...consumer, files: consumer.files.slice(0, -1) }), { code: "RELEASE_INVALID" });
});

test("same-producer transitions stay independently usable and reject unreviewed combinations", async () => {
  assert.equal(transition.producerCommit, publicationRepair.producerCommit);
  const videoSpec = "database/capture-external-video-compatibility.json";
  const publicationSpec = "database/capture-publication-revalidation-compatibility.json";
  const producer = { nodePath: "/fixture/node", nodeVersion: "24.21.0", nodeSha256: "a".repeat(64), commit: transition.producerCommit,
    files: [...transition.files, ...publicationRepair.files].filter(pair => pair.before !== null).map(pair => ({ path: pair.path, sha256: pair.before! })) };
  const consumer = (pairs: { path: string; after: string }[], spec: string) => {
    const files = new Map(producer.files.map(file => [file.path, file.sha256]));
    for (const pair of pairs) files.set(pair.path, pair.after);
    files.set(spec, "b".repeat(64));
    return { ...producer, commit: "c".repeat(40), files: [...files].map(([path, sha256]) => ({ path, sha256 })) };
  };
  const video = consumer(transition.files, videoSpec), publication = consumer(publicationRepair.files, publicationSpec);
  assert.equal(checkCaptureReleaseCompatibility(producer, video).format, "capture-external-video-links-v1");
  assert.equal(checkCaptureReleaseCompatibility(producer, publication).format, "capture-publication-revalidation-compatibility-v1");
  // A real frozen verifier must include both JSON imports, even though only one
  // executable transition is selected. The support module is still byte-pinned.
  const videoHash = createHash("sha256").update(await readFile(new URL("../" + videoSpec, import.meta.url))).digest("hex");
  const publicationHash = createHash("sha256").update(await readFile(new URL("../" + publicationSpec, import.meta.url))).digest("hex");
  const videoWithImports = { ...video, files: [...video.files, { path: publicationSpec, sha256: publicationHash }] };
  const publicationWithImports = { ...publication, files: [...publication.files, { path: videoSpec, sha256: videoHash }] };
  assert.equal(checkCaptureReleaseCompatibility(producer, videoWithImports).format, "capture-external-video-links-v1");
  assert.equal(checkCaptureReleaseCompatibility(producer, publicationWithImports).format, "capture-publication-revalidation-compatibility-v1");
  const mixed = consumer([...transition.files, ...publicationRepair.files], videoSpec);
  mixed.files.push({ path: publicationSpec, sha256: "b".repeat(64) });
  for (const files of [mixed.files, mixed.files.filter(file => file.path !== videoSpec), mixed.files.filter(file => file.path !== publicationSpec)])
    assert.throws(() => checkCaptureReleaseCompatibility(producer, { ...mixed, files }), { code: "RELEASE_INVALID" });
  for (const changed of [
    { ...video, files: video.files.filter(file => file.path !== videoSpec) },
    { ...video, files: video.files.map(file => file.path === videoSpec ? { ...file, path: publicationSpec } : file) },
    { ...video, files: [...video.files, video.files.find(file => file.path === videoSpec)!] },
    { ...videoWithImports, files: videoWithImports.files.map(file => file.path === publicationSpec ? { ...file, sha256: "e".repeat(64) } : file) },
    { ...publicationWithImports, files: publicationWithImports.files.map(file => file.path === videoSpec ? { ...file, sha256: "e".repeat(64) } : file) },
  ]) assert.throws(() => checkCaptureReleaseCompatibility(producer, changed), { code: "RELEASE_INVALID" });
});

/** Model the old converter's explicit unsupported/partial representation. Its
 * source proof stays unchanged; partial documents must never enter reuse. */
function legacyVideo(record: WebsiteRecord): WebsiteRecord {
  const copy = structuredClone(record);
  if (copy.detail.item.id === DEMO.child && copy.detail.document) {
    copy.detail.document.blocks = copy.detail.document.blocks.map(block => block.type === "embed"
      ? { id: block.id, type: "unsupported", label: "Unsupported Notion block" } : block);
    copy.detail.document.completeness = "partial";
  }
  return copy;
}

test("fresh qualified publication reconverts old video placeholders, verifies complete peers and preserves prior capture bytes", async t => {
  const db = await PGlite.create(), root = await realpath(await mkdtemp(join(tmpdir(), "video-transition-")));
  t.after(async () => { await db.close(); await rm(root, { recursive: true, force: true }); });
  await db.exec(await readFile(new URL("../database/website-migrations/001_website.sql", import.meta.url), "utf8"));
  await db.query("UPDATE nb_v2.state SET schema_digest=$1", [WEBSITE_SCHEMA_DIGEST]);
  for (const file of [revalidation.migration.file, fresh.migration.file, "20261016064210_fresh_verification_accept_published_cache.sql"])
    await db.exec(await readFile(new URL("../supabase/migrations/" + file, import.meta.url), "utf8"));
  const demo = createDemo(0), sources = structuredClone(demo.config.sources.slice(1));
  sources[1].publication.allowlistPageIds = [DEMO.week, DEMO.child];
  const config = parseWebsiteNotionConfig({ schemaVersion: 2, sources });
  const paragraph = demoParagraph(demoId(50_000), DEMO.child, "");
  assert.ok(paragraph.type === "paragraph");
  const { paragraph: _paragraph, ...base } = paragraph;
  demo.blocks.get(DEMO.child)!.push({ ...base, type: "video", video: { type: "external", external: { url: "https://videos.example.test/lesson" }, caption: [] } } as BlockObjectResponse);
  const policy = await websitePolicy(demo.client, config, 3600);
  await db.query("SELECT nb_v2_api.configure_policy($1,$2,$3::jsonb,$4::jsonb)", [policy.configDigest, 3600, JSON.stringify(policy.sources), JSON.stringify(policy.permits)]);
  const writer = createWebsiteWriter(db), previous = await writer.begin(randomUUID(), policy.configDigest);
  const identity = { runId: previous.runId, releaseCommit: transition.producerCommit, sourceSha256: "e".repeat(64), configDigest: policy.configDigest };
  const directory = join(root, "old"), capture = await createCollectionCapture(directory, identity);
  const storage = { put: async () => assert.fail("No image upload"), read: async () => assert.fail("No object read") };
  await runWebsiteSync({ client: demo.client, config, mode: "publish", storage, writer: { ...writer, begin: async () => previous,
    stage: (lease, records, media) => writer.stage(lease, records.map(legacyVideo), media) },
    captureCollection: { save: page => capture.save({ ...page, record: legacyVideo(page.record) }), seal: capture.seal } });
  const oldIndex = await readFile(join(directory, "index-private.json")), oldPage = await readFile(join(directory, `page-${DEMO.child}.json`));
  const oldRun = (await db.query("SELECT to_jsonb(r) AS row FROM nb_v2.runs r WHERE id=$1", [previous.runId])).rows;
  const resume = await prepareCollectionResume({ directory, identity, db, qualification: "fresh" });
  assert.equal(resume.pages.find(p => p.record.detail.item.id === DEMO.child)!.record.detail.document!.completeness, "partial");
  const next = await writer.begin(randomUUID(), policy.configDigest), beforeRequests = demo.requests.length;
  const result = await runWebsiteSync({ client: demo.client, config, mode: "publish", storage, resumeCollection: resume,
    writer: { ...writer, begin: async () => next }, captureCollection: await createCollectionCapture(join(root, "new"), { ...identity, runId: next.runId, releaseCommit: "f".repeat(40) }) });
  assert.deepEqual(result.resume, { reusedPages: 2, recollectedPages: 1, newPages: 0, unseenSavedPages: 0 });
  assert.ok(demo.requests.length > beforeRequests, "Complete peers still require current source reads");
  const selected = (await db.query<{ result: { records: { item: { id: string }; document: { completeness: string; blocks: { type: string; display?: string }[] } }[] } }>("SELECT nb_v2_api.read_snapshot(ARRAY['study-note'],true) AS result")).rows[0].result;
  const document = selected.records.find(r => r.item.id === DEMO.child)!.document;
  assert.equal(document.completeness, "complete"); assert.ok(document.blocks.some(b => b.type === "embed" && b.display === "link"));
  assert.ok(document.blocks.every(b => b.type !== "unsupported"));
  assert.deepEqual(await readFile(join(directory, "index-private.json")), oldIndex);
  assert.deepEqual(await readFile(join(directory, `page-${DEMO.child}.json`)), oldPage);
  assert.deepEqual((await db.query("SELECT to_jsonb(r) AS row FROM nb_v2.runs r WHERE id=$1", [previous.runId])).rows, oldRun);
});

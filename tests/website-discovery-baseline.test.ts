import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { createDemo, demoId, demoPage, demoText } from "../scripts/notion-sync/demo.ts";
import { parseWebsiteNotionConfig } from "../src/server/notion/website-config.ts";
import { createWebsiteNotionRepository } from "../src/server/notion/website-repository.ts";
import { configDigest } from "../src/server/database/website-validation.ts";
import { WEBSITE_SCHEMA_DIGEST } from "../contracts/website-sync.ts";
import { captureDirectoryMetadata, initializeDirectoryBaseline } from "../scripts/website-incremental-sync/discovery-baseline.ts";
import { openIncrementalQueue } from "../scripts/website-incremental-sync/queue.ts";
import { createKnownPageDirectorySource, createNotionDirectorySource, runDirectoryDiscovery } from "../scripts/website-incremental-sync/discovery.ts";
import { runIncrementalCycle } from "../scripts/website-incremental-sync/executor.ts";
import { cacheProof } from "./helpers/content-cache.ts";

function fictionalFileUrl(path: string, version: string) {
  const url = new URL(`https://example.test/${path}`);
  url.searchParams.set("X-Amz-Signature", `fictional-${version}`); return url.href;
}
async function fixture(t: TestContext, nativeCover = false, about = false) {
  const demo = createDemo(2), source = demo.config.sources[0];
  if (nativeCover) demo.pages.get(demoId(1000))!.cover = { type: "file", file: { url: fictionalFileUrl("asset.png", "one"), expiry_time: "2026-10-14T00:00:00Z" } };
  if (about) demo.pages.set(demoId(5000), demoPage(demoId(5000), "About", { type: "workspace", workspace: true }));
  const config = parseWebsiteNotionConfig({ schemaVersion: 2, sources: [{ ...source, cover: { strategy: nativeCover ? "native-page-cover" : "none" } },
    ...(about ? [{ key: "about", kind: "page", enabled: true, pageId: demoId(5000), pageKey: "about", fields: { title: "Name" },
      cover: { strategy: "none" }, publication: { mode: "allowlist", allowlistPageIds: [demoId(5000)] } }] : [])] });
  const capture = captureDirectoryMetadata(demo.client, config);
  const repo = createWebsiteNotionRepository({ client: capture.client, config });
  const records = await repo.collectRecords(true);
  const state = { publicationRevision: `${randomUUID()}:0`, configDigest: configDigest(config), schemaDigest: WEBSITE_SCHEMA_DIGEST, policyEpoch: "0" };
  const baseline = { state, records, media: [] }, proof = cacheProof(baseline);
  const dir = await realpath(await mkdtemp(join(tmpdir(), "directory-baseline-")));
  const scope = { digest: state.configDigest, sourceKeys: config.sources.map(s => s.key) };
  let queue = await openIncrementalQueue(dir, scope);
  t.after(async () => { queue.close(); await rm(dir, { force: true, recursive: true }); });
  const directory = createNotionDirectorySource({ getDataSource: id => demo.client.getDataSource(id), queryDataSource: async () => {
    const pages = [...demo.pages.values()].filter(p => p.parent.type === "data_source_id" && p.parent.data_source_id === source.dataSourceId);
    return { object: "list", results: pages, has_more: false, next_cursor: null, type: "page_or_data_source", page_or_data_source: {} };
  } }, config, state.configDigest);
  const scan = () => runDirectoryDiscovery({ queue, sourceKey: "status", now: () => Date.parse("2026-10-01T00:00:05Z") }, directory);
  return { demo, capture, dir, config, state, baseline, proof, scan, get queue() { return queue; },
    reopen: async (alreadyClosed = false) => { if (!alreadyClosed) queue.close(); queue = await openIncrementalQueue(dir, scope); },
    init: (companion: ReturnType<typeof capture.seal>) => initializeDirectoryBaseline({ queue, config, capture: companion, baseline, proof, currentState: state }),
  };
}

test("same full collector seeds metadata without extra calls; first scan prepares no bodies", async t => {
  const f = await fixture(t), requests = f.demo.requests.length, capture = f.capture.seal(f.baseline.records);
  assert.equal(f.demo.requests.length, requests); assert.equal(capture.skipped, 0);
  assert.deepEqual(f.init(capture), { initialized: true, members: 2 });
  assert.equal(f.queue.discoveryState("status").watermark, null); assert.equal(f.queue.claim().length, 0);
  const bodies = f.demo.requests.filter(r => r.category === "blocks").length;
  await f.scan();
  let preparations = 0;
  await runIncrementalCycle({ queue: f.queue, schemaDigest: WEBSITE_SCHEMA_DIGEST }, {
    state: async () => f.state, prepare: async () => { preparations++; return { outcome: "unchanged" }; },
    lookup: async () => null, submit: async () => { throw Error("Unexpected SQL write"); }, verify: async () => false,
  });
  assert.equal(preparations, 0); assert.equal(f.demo.requests.filter(r => r.category === "blocks").length, bodies);
  assert.notEqual(f.queue.discoveryState("status").lastReconciledAt, null);
});

test("an explicit ordinary page shares the seed and the existing known-page probe", async t => {
  const f = await fixture(t, false, true); assert.equal(f.init(f.capture.seal(f.baseline.records)).members, 3);
  const source = createKnownPageDirectorySource({ getPage: id => f.demo.client.getPage(id), getDataSource: id => f.demo.client.getDataSource(id) }, f.config, f.state,
    { sourceKey: "about", pageKeys: [demoId(5000)], configDigest: f.state.configDigest, publicationRevision: f.state.publicationRevision, readerVerified: true });
  const scan = () => runDirectoryDiscovery({ queue: f.queue, sourceKey: "about", now: () => Date.parse("2026-10-01T00:00:05Z") }, source);
  await f.scan(); await scan(); assert.deepEqual(f.queue.claim(), []);
  f.demo.pages.get(demoId(5000))!.properties.Name = { id: "title", type: "title", title: [demoText("New about")] };
  await scan(); assert.deepEqual(f.queue.claim().map(t => [t.sourceKey, t.pageKey]), [["about", demoId(5000)]]);
});

test("new pages and property edits with identical edit timestamps still produce hints", async t => {
  const f = await fixture(t); f.init(f.capture.seal(f.baseline.records));
  f.demo.pages.get(demoId(1000))!.properties.Name = { id: "title", type: "title", title: [demoText("Changed title")] };
  const added = structuredClone(f.demo.pages.get(demoId(1001))!); added.id = demoId(1002); f.demo.pages.set(added.id, added);
  await f.scan();
  const tickets = f.queue.claim(); assert.deepEqual(tickets.map(t => t.pageKey).sort(), [demoId(1000), demoId(1002)]);
  assert.deepEqual(tickets.find(t => t.pageKey === demoId(1000))!.reasons, ["content"]);
  assert.deepEqual(tickets.find(t => t.pageKey === demoId(1002))!.reasons, ["created"]);
});

test("signature refresh is ignored; a changed native cover is discovered", async t => {
  const f = await fixture(t, true), page = f.demo.pages.get(demoId(1000))!;
  assert.equal(page.cover!.type, "file"); if (page.cover?.type !== "file") throw Error("Fixture cover");
  page.cover.file.url = fictionalFileUrl("asset.png", "two");
  await f.capture.client.getPage(page.id);
  const capture = f.capture.seal(f.baseline.records); assert.equal(capture.skipped, 0); f.init(capture);
  await f.scan(); assert.deepEqual(f.queue.claim(), []);
  page.cover.file.url = fictionalFileUrl("different.png", "three");
  await f.scan(); assert.deepEqual(f.queue.claim().map(t => t.pageKey), [page.id]);
});

test("sealed capture cannot accidentally observe a later source collection", async t => {
  const f = await fixture(t); f.capture.seal(f.baseline.records);
  const calls = f.demo.requests.length;
  await assert.rejects(f.capture.client.getPage(demoId(1000)), { code: "DISCOVERY_CAPTURE_SEALED" });
  assert.equal(f.demo.requests.length, calls); assert.throws(() => f.capture.seal(f.baseline.records), { code: "DISCOVERY_CAPTURE_SEALED" });
});

for (const scenario of ["conflicting", "null", "inactive", "timestamp-drift", "missing"] as const) {
  test(`${scenario} collection metadata is excluded and discovered normally`, async t => {
    const f = await fixture(t), observer = captureDirectoryMetadata(f.demo.client, f.config), id = demoId(1000), page = f.demo.pages.get(id)!;
    if (scenario !== "missing") await observer.client.getPage(id);
    if (scenario === "conflicting") { page.properties.Name = { id: "title", type: "title", title: [demoText("Later")] }; await observer.client.getPage(id); }
    if (scenario === "null") { f.demo.pages.delete(id); await observer.client.getPage(id); f.demo.pages.set(id, page); await observer.client.getPage(id); }
    if (scenario === "inactive") { page.archived = true; await observer.client.getPage(id); page.archived = false; }
    if (scenario === "timestamp-drift") { page.last_edited_time = "2026-10-02T00:00:00Z"; await observer.client.getPage(id); }
    await observer.client.getPage(demoId(1001));
    const capture = observer.seal(f.baseline.records); assert.equal(capture.skipped, 1);
    f.init(capture); await f.scan(); assert.deepEqual(f.queue.claim().map(t => t.pageKey), [id]);
  });
}

test("restart replays the seed receipt without overwriting later discoveries", async t => {
  const f = await fixture(t), capture = f.capture.seal(f.baseline.records); f.init(capture);
  await f.reopen(); assert.deepEqual(f.init(capture), { initialized: false, members: 2 });
  f.demo.pages.get(demoId(1000))!.properties.Name = { id: "title", type: "title", title: [demoText("After seed")] };
  await f.scan(); const directory = f.queue.directoryPage("status"), state = f.queue.discoveryState("status");
  await f.reopen(); f.init(capture);
  assert.deepEqual(f.queue.directoryPage("status"), directory); assert.deepEqual(f.queue.discoveryState("status"), state);
  assert.equal(f.queue.claim().length, 1);
});

test("unverified or stale proofs cannot seed; existing unknown attempts survive initialization", async t => {
  const f = await fixture(t), capture = f.capture.seal(f.baseline.records), id = demoId(1000);
  f.queue.enqueue([{ eventId: "prior", sourceKey: "status", pageKey: id, reason: "content", observedAt: 1 }]);
  const [ticket] = f.queue.claim(); f.queue.markSubmitting(ticket, { payloadDigest: "b".repeat(64), expectedRevision: f.state.publicationRevision });
  for (const patch of [{ readerVerified: false }, { complete: false }, { records: 1 }, { contentDigest: "b".repeat(64) }, { policyEpoch: "1" }]) {
    assert.throws(() => initializeDirectoryBaseline({ queue: f.queue, config: f.config, capture, baseline: f.baseline,
      proof: { ...f.proof, ...patch } as typeof f.proof, currentState: f.state }));
    assert.deepEqual(f.queue.directoryPage("status"), []);
  }
  assert.throws(() => initializeDirectoryBaseline({ queue: f.queue, config: f.config, capture, baseline: f.baseline,
    proof: f.proof, currentState: { ...f.state, publicationRevision: `${randomUUID()}:1` } }));
  f.init(capture); await f.reopen();
  assert.equal(f.queue.pendingVerifications()[0].ticket.operationId, ticket.operationId); assert.deepEqual(f.queue.claim(), []);
});

test("a used discovery directory or a conflicting receipt cannot be overwritten", async t => {
  const f = await fixture(t), capture = f.capture.seal(f.baseline.records);
  const invalid = structuredClone(capture); invalid.sources[0].members[0].pageKey = demoId(9999);
  assert.throws(() => f.init(invalid)); assert.equal(f.queue.directoryPage("status").length, 0);
  f.init(capture);
  const different = structuredClone(capture); different.sources[0].members[0].fingerprint = "c".repeat(64);
  assert.throws(() => f.init(different), { code: "DISCOVERY_BASELINE_CONFLICT" });
  const db = new DatabaseSync(":memory:");
  const { IncrementalQueue } = await import("../scripts/website-incremental-sync/queue.ts");
  const queue = new IncrementalQueue(db, { digest: f.state.configDigest, sourceKeys: ["status"] }, Date.now);
  t.after(() => queue.close()); queue.beginDiscovery("status", 0, { mode: "membership", startedAt: 1, overlapMs: 0 });
  assert.throws(() => initializeDirectoryBaseline({ queue, config: f.config, capture, baseline: f.baseline, proof: f.proof, currentState: f.state }), { code: "DISCOVERY_ALREADY_STARTED" });
});

test("v3 upgrade adds seed receipt while preserving unknown submissions", async t => {
  const f = await fixture(t), capture = f.capture.seal(f.baseline.records);
  f.queue.enqueue([{ eventId: "prior", sourceKey: "status", pageKey: demoId(1000), reason: "content", observedAt: 1 }]);
  const [ticket] = f.queue.claim(); f.queue.markSubmitting(ticket, { payloadDigest: "d".repeat(64), expectedRevision: f.state.publicationRevision });
  f.queue.close(); const db = new DatabaseSync(join(f.dir, "incremental.sqlite"));
  db.exec("DROP TABLE directory_baseline; PRAGMA user_version=3;"); db.close();
  await f.reopen(true);
  assert.equal(f.queue.pendingVerifications()[0].ticket.operationId, ticket.operationId);
  f.init(capture);
  assert.equal(f.queue.directoryPage("status").length, 2); assert.deepEqual(f.queue.claim(), []);
});

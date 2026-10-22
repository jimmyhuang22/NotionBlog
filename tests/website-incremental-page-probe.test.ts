import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDemo, demoId } from "../scripts/notion-sync/demo.ts";
import { parseWebsiteNotionConfig } from "../src/server/notion/website-config.ts";
import { configDigest } from "../src/server/database/website-validation.ts";
import { openIncrementalQueue } from "../scripts/website-incremental-sync/queue.ts";
import { createKnownPageDirectorySource, runDirectoryDiscovery, type KnownPageCatalog } from "../scripts/website-incremental-sync/discovery.ts";

async function setup(t: TestContext) {
  const demo = createDemo(3), course = demo.config.sources[1];
  const config = parseWebsiteNotionConfig({ schemaVersion: 2, sources: [
    { ...course, key: "courses", publication: { mode: "all", allowlistPageIds: [] } },
    { key: "notes", kind: "study-note", enabled: true, dataSourceId: course.dataSourceId, fields: { title: "Name" }, cover: { strategy: "none" }, publication: { mode: "course-descendants", allowlistPageIds: [] } },
  ] });
  const state = { configDigest: configDigest(config), publicationRevision: "verified-generation" };
  const catalog: KnownPageCatalog = { ...state, sourceKey: "notes",
    pageKeys: [...demo.config.sources[2].publication.allowlistPageIds].slice(0, 2), readerVerified: true };
  const calls: string[] = [];
  const client = {
    getPage: async (id: string) => { calls.push(id); return structuredClone(demo.pages.get(id) ?? null); },
    getDataSource: async (id: string) => structuredClone(demo.schemas.get(id)!),
  };
  const directory = await realpath(await mkdtemp(join(tmpdir(), "known-page-probe-")));
  let q = await openIncrementalQueue(directory, { digest: state.configDigest, sourceKeys: ["notes"] });
  t.after(async () => { q.close(); await rm(directory, { recursive: true, force: true }); });
  return { demo, config, state, catalog, calls, client, get q() { return q; },
    source: (c = catalog, size = 20) => createKnownPageDirectorySource(client, config, state, c, size),
    reopen: async () => { q.close(); q = await openIncrementalQueue(directory, { digest: state.configDigest, sourceKeys: ["notes"] }); },
  };
}
function drain(q: Awaited<ReturnType<typeof openIncrementalQueue>>) { for (const ticket of q.claim(50)) q.completeUnchanged(ticket); }

test("known deep-page metadata changes are discovered without requiring a course-root edit or body scan", async t => {
  const s = await setup(t), source = s.source();
  assert.equal((await runDirectoryDiscovery({ queue: s.q, sourceKey: "notes", now: () => 5000 }, source)).outcome, "completed");
  drain(s.q); s.calls.length = 0;
  const id = s.catalog.pageKeys[1], page = s.demo.pages.get(id)!;
  page.last_edited_time = new Date(Date.parse(page.last_edited_time) + 1000).toISOString();
  const result = await runDirectoryDiscovery({ queue: s.q, sourceKey: "notes", now: () => 6000 }, source);
  assert.equal(result.hints, 1); assert.deepEqual(s.calls.sort(), [...s.catalog.pageKeys].sort());
  assert.equal(s.q.claim()[0].pageKey, id);
});

test("bounded known-page scans resume the exact ID list after reopening", async t => {
  const s = await setup(t), source = s.source(s.catalog, 1);
  const first = await runDirectoryDiscovery({ queue: s.q, sourceKey: "notes", maxSteps: 1, now: () => 5000 }, source);
  assert.equal(first.outcome, "partial"); assert.equal(s.calls.length, 1); await s.reopen();
  assert.equal((await runDirectoryDiscovery({ queue: s.q, sourceKey: "notes", now: () => 6000 }, source)).outcome, "completed");
  assert.equal(new Set(s.calls).size, 2); assert.equal(s.calls.length, 2);
});

test("changed catalog identity cannot reuse an old pagination offset", async t => {
  const s = await setup(t); await runDirectoryDiscovery({ queue: s.q, sourceKey: "notes", maxSteps: 1, now: () => 5000 }, s.source(s.catalog, 1));
  const old = s.q.discoveryState("notes"), calls = s.calls.length;
  const next = s.source({ ...s.catalog, pageKeys: [...s.catalog.pageKeys, s.demo.config.sources[2].publication.allowlistPageIds[2]] }, 1);
  const result = await runDirectoryDiscovery({ queue: s.q, sourceKey: "notes", now: () => 6000 }, next);
  assert.equal(result.outcome, "needs_review"); assert.equal(result.errorCode, "DISCOVERY_CATALOG_CHANGED");
  assert.deepEqual(s.q.discoveryState("notes"), old); assert.equal(s.calls.length, calls);
});

test("null known pages generate deduplicated reconciliation hints without deletion authority", async t => {
  const s = await setup(t), id = s.catalog.pageKeys[1]; s.demo.pages.delete(id);
  const first = await runDirectoryDiscovery({ queue: s.q, sourceKey: "notes", now: () => 5000 }, s.source());
  assert.equal(first.hints, 2); const tickets = s.q.claim(50);
  assert.deepEqual(tickets.find(t => t.pageKey === id)!.reasons, ["reconcile"]);
  for (const ticket of tickets) s.q.completeUnchanged(ticket);
  assert.equal((await runDirectoryDiscovery({ queue: s.q, sourceKey: "notes", now: () => 6000 }, s.source())).hints, 0);
  assert.equal(s.q.directoryPage("notes").find(m => m.pageKey === id)!.missing, true);
});

test("catalog proof, uniqueness and scan capacity fail before remote calls", async t => {
  const s = await setup(t);
  assert.throws(() => s.source({ ...s.catalog, publicationRevision: "older" }), /DISCOVERY_CATALOG_INVALID/);
  assert.throws(() => s.source({ ...s.catalog, readerVerified: false } as unknown as KnownPageCatalog), /DISCOVERY_CATALOG_INVALID/);
  assert.throws(() => s.source({ ...s.catalog, pageKeys: [s.catalog.pageKeys[0], s.catalog.pageKeys[0]] }), /DISCOVERY_CATALOG_INVALID/);
  assert.throws(() => s.source({ ...s.catalog, pageKeys: Array.from({ length: 201 }, (_, i) => demoId(9000 + i)) }, 1), /DISCOVERY_LIMIT_EXCEEDED/);
  assert.deepEqual(s.calls, []);
});

test("ordinary page probing accepts only the explicitly configured page", async t => {
  const s = await setup(t), id = s.catalog.pageKeys[0];
  const config = parseWebsiteNotionConfig({ schemaVersion: 2, sources: [{ key: "about", kind: "page", enabled: true, pageId: id, pageKey: "about",
    fields: { title: "Name" }, publication: { mode: "allowlist", allowlistPageIds: [id] } }] });
  const state = { ...s.state, configDigest: configDigest(config) };
  const catalog = { ...state, sourceKey: "about", pageKeys: [demoId(99999)], readerVerified: true as const };
  const source = createKnownPageDirectorySource(s.client, config, state, catalog);
  await assert.rejects(source.validate("about", new AbortController().signal), /DISCOVERY_CATALOG_INVALID/);
  assert.deepEqual(s.calls, []);
});

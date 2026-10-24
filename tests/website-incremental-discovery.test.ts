import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, realpath, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as sqlite from "node:sqlite";
import { createDemo, demoId } from "../scripts/notion-sync/demo.ts";
import { parseWebsiteNotionConfig } from "../src/server/notion/website-config.ts";
import { configDigest } from "../src/server/database/website-validation.ts";
import { openIncrementalQueue, IncrementalQueueError, type DirectoryMember } from "../scripts/website-incremental-sync/queue.ts";
import { createNotionDirectorySource, runDirectoryDiscovery, type DirectoryNotionClient, type DirectorySource } from "../scripts/website-incremental-sync/discovery.ts";
import { runIncrementalCycle } from "../scripts/website-incremental-sync/executor.ts";

const fingerprint = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
const error = (code: string) => (e: unknown) => e instanceof IncrementalQueueError && e.code === code;
function member(pageKey: string, lastEditedAt = 1000): DirectoryMember { return { pageKey, lastEditedAt, fingerprint: fingerprint([pageKey, lastEditedAt]) }; }
async function setup(t: TestContext, digest = "a".repeat(64)) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "incremental-discovery-")));
  const scope = { digest, sourceKeys: ["status"] }, time = { now: 5000 };
  let q = await openIncrementalQueue(dir, scope, () => time.now);
  t.after(async () => { q.close(); await rm(dir, { recursive: true, force: true }); });
  return { dir, scope, time, get q() { return q; }, reopen: async (alreadyClosed = false) => { if (!alreadyClosed) q.close(); q = await openIncrementalQueue(dir, scope, () => time.now); } };
}
function drain(q: Awaited<ReturnType<typeof openIncrementalQueue>>) { for (const ticket of q.claim(50)) q.completeUnchanged(ticket); }
function baseline(q: Awaited<ReturnType<typeof openIncrementalQueue>>, members = [member("page-1"), member("page-2")]) {
  const state = q.beginDiscovery("status", 0, { mode: "changes", startedAt: 2000, overlapMs: 100 });
  const page = q.commitDirectoryPage("status", state.revision, members, null);
  q.reconcileDirectoryAbsences("status", page.state.revision); drain(q);
}
function fixture() {
  const demo = createDemo(3), s = demo.config.sources[0];
  const config = parseWebsiteNotionConfig({ schemaVersion: 2, sources: [{ key: "status", kind: "status", dataSourceId: s.dataSourceId,
    enabled: true, fields: s.fields, cover: { strategy: "none" }, publication: { mode: "all", allowlistPageIds: [] } }] });
  const pages = [demoId(1000), demoId(1001)].map(id => { const p = structuredClone(demo.pages.get(id)!); p.last_edited_time = new Date(1000).toISOString(); return p; });
  const queryInputs: Parameters<DirectoryNotionClient["queryDataSource"]>[0][] = [];
  const response = (results = pages, next: string | null = null) => ({ object: "list", type: "page_or_data_source", page_or_data_source: {},
    results, has_more: next !== null, next_cursor: next } as Awaited<ReturnType<DirectoryNotionClient["queryDataSource"]>>);
  const client: DirectoryNotionClient = { getDataSource: async () => structuredClone(demo.schemas.get(s.dataSourceId)!),
    queryDataSource: async input => { queryInputs.push(input); return response(); } };
  return { config, pages, client, queryInputs, response, source: () => createNotionDirectorySource(client, config, configDigest(config)) };
}

test("first scan, metadata-only resume and fixed window survive reopening", async t => {
  const s = await setup(t); let calls = 0;
  const source: DirectorySource = { scopeDigest: s.scope.digest, validate: async () => {}, read: async (_key, scan) => {
    calls++; assert.equal(scan.mode, "membership"); assert.equal(scan.startedAt, 5000);
    return scan.cursor === null ? { members: [member("page-1")], nextCursor: "second" } : { members: [member("page-2")], nextCursor: null };
  } };
  const options = { queue: s.q, sourceKey: "status", now: () => s.time.now, maxSteps: 1 };
  assert.equal((await runDirectoryDiscovery(options, source)).outcome, "partial");
  assert.equal(s.q.discoveryState("status").watermark, null);
  await s.reopen(); s.time.now = 9000;
  assert.equal((await runDirectoryDiscovery({ ...options, queue: s.q }, source)).outcome, "partial");
  assert.equal((await runDirectoryDiscovery({ ...options, queue: s.q }, source)).outcome, "completed");
  assert.equal(calls, 2); assert.equal(s.q.discoveryState("status").watermark, 5000);
  assert.equal(s.q.directoryPage("status").length, 2); assert.equal(s.q.status().pending, 2);
});

test("overlapping scans skip unchanged metadata and retain equal-time changes", async t => {
  const s = await setup(t); baseline(s.q);
  const begin = s.q.beginDiscovery("status", s.q.discoveryState("status").revision, { mode: "changes", startedAt: 5000, overlapMs: 1000 });
  assert.equal(begin.scan!.since, 1000);
  const updated = { ...member("page-2"), fingerprint: fingerprint("equal-time-new-value") };
  const page = s.q.commitDirectoryPage("status", begin.revision, [member("page-1"), updated], null);
  assert.equal(page.inserted, 1); assert.equal(page.state.watermark, 5000);
  const [ticket] = s.q.claim(); assert.equal(ticket.pageKey, "page-2"); assert.deepEqual(ticket.reasons, ["content"]);
  s.q.completeUnchanged(ticket);
  const next = s.q.beginDiscovery("status", page.state.revision, { mode: "changes", startedAt: 6000, overlapMs: 5000 });
  assert.equal(s.q.commitDirectoryPage("status", next.revision, [updated], null).inserted, 0);
});

test("a conflicting hint rolls back metadata and its pagination checkpoint together", async t => {
  const s = await setup(t), scan = s.q.beginDiscovery("status", 0, { mode: "membership", startedAt: 5000, overlapMs: 0 });
  const m = member("page-1"), eventId = fingerprint(["directory", scan.scan!.id, "status", m.pageKey, m.fingerprint]);
  s.q.enqueue([{ eventId, sourceKey: "status", pageKey: "different", reason: "created", observedAt: 5000 }]);
  assert.throws(() => s.q.commitDirectoryPage("status", scan.revision, [m], "next"), error("QUEUE_EVENT_CONFLICT"));
  assert.deepEqual(s.q.directoryPage("status"), []); assert.deepEqual(s.q.discoveryState("status"), scan);
});

test("stale discovery responses cannot change directory membership or hints", async t => {
  const s = await setup(t); const second = await openIncrementalQueue(s.dir, s.scope); t.after(() => second.close());
  const scan = s.q.beginDiscovery("status", 0, { mode: "membership", startedAt: 5000, overlapMs: 0 });
  s.q.commitDirectoryPage("status", scan.revision, [member("page-1")], "next");
  assert.throws(() => second.commitDirectoryPage("status", scan.revision, [member("page-2")], null), error("QUEUE_CHECKPOINT_CONFLICT"));
  assert.equal(s.q.directoryPage("status").length, 1);
});

test("failed pagination never advances watermark or marks unvisited members missing", async t => {
  const s = await setup(t); baseline(s.q);
  const source: DirectorySource = { scopeDigest: s.scope.digest, validate: async () => {}, read: async (_key, scan) => {
    if (scan.cursor) throw new Error("private upstream body and URL");
    return { members: [member("page-1")], nextCursor: "unread" };
  } };
  const result = await runDirectoryDiscovery({ queue: s.q, sourceKey: "status", mode: "membership", now: () => 5000 }, source);
  assert.equal(result.outcome, "retry"); assert.equal(result.errorCode, "DISCOVERY_UNAVAILABLE");
  assert.equal(s.q.discoveryState("status").watermark, 2000);
  assert.ok(s.q.directoryPage("status").every(m => !m.missing)); assert.equal(s.q.status().pending, 0);
  assert.ok(!JSON.stringify(result).includes("private upstream"));
});

test("completed membership reconciliation emits bounded verification hints, never removed", async t => {
  const s = await setup(t);
  baseline(s.q, Array.from({ length: 150 }, (_, i) => member(`page-${String(i).padStart(3, "0")}`)));
  while (s.q.status().pending) drain(s.q);
  const scan = s.q.beginDiscovery("status", s.q.discoveryState("status").revision, { mode: "membership", startedAt: 5000, overlapMs: 0 });
  const page = s.q.commitDirectoryPage("status", scan.revision, [], null);
  assert.equal(s.q.status().pending, 0);
  const partial = s.q.reconcileDirectoryAbsences("status", page.state.revision, 100);
  assert.equal(partial.inserted, 100); assert.equal(partial.state.watermark, 2000);
  await s.reopen(); const done = s.q.reconcileDirectoryAbsences("status", s.q.discoveryState("status").revision, 100);
  assert.equal(done.inserted, 50); assert.equal(done.state.watermark, 5000); assert.equal(done.state.lastReconciledAt, 5000);
  assert.ok(s.q.claim(50).every(ticket => JSON.stringify(ticket.reasons) === '["reconcile"]'));
});

test("an absent member returning unchanged is verified again, while older metadata cannot overwrite newer", async t => {
  const s = await setup(t); baseline(s.q);
  const scan = s.q.beginDiscovery("status", s.q.discoveryState("status").revision, { mode: "membership", startedAt: 5000, overlapMs: 0 });
  const page = s.q.commitDirectoryPage("status", scan.revision, [member("page-1", 4000)], null);
  s.q.reconcileDirectoryAbsences("status", page.state.revision); drain(s.q);
  const newer = s.q.directoryPage("status")[0];
  const next = s.q.beginDiscovery("status", s.q.discoveryState("status").revision, { mode: "changes", startedAt: 6000, overlapMs: 5000 });
  assert.equal(s.q.commitDirectoryPage("status", next.revision, [member("page-1"), member("page-2")], null).inserted, 1);
  assert.deepEqual(s.q.directoryPage("status")[0], newer); assert.deepEqual(s.q.claim()[0].reasons, ["reconcile"]);
});

test("cursor loops across restarts fail without skipping data; explicit restart preserves completed progress", async t => {
  const s = await setup(t); baseline(s.q);
  const scan = s.q.beginDiscovery("status", s.q.discoveryState("status").revision, { mode: "membership", startedAt: 5000, overlapMs: 0 });
  const a = s.q.commitDirectoryPage("status", scan.revision, [], "A");
  const b = s.q.commitDirectoryPage("status", a.state.revision, [], "B"); await s.reopen();
  assert.throws(() => s.q.commitDirectoryPage("status", b.state.revision, [member("new")], "A"), error("DISCOVERY_CURSOR_LOOP"));
  assert.equal(s.q.directoryPage("status").length, 2);
  const restarted = s.q.restartDiscovery("status", b.state.revision);
  assert.equal(restarted.watermark, 2000); assert.equal(restarted.scan, null);
});

test("v1 local schema upgrade preserves pending and unknown publication attempts", async t => {
  const s = await setup(t); s.q.enqueue([{ eventId: "old", sourceKey: "status", pageKey: "page-1", reason: "content", observedAt: 1000 }]);
  const [ticket] = s.q.claim(); s.q.markSubmitting(ticket, { payloadDigest: "b".repeat(64), expectedRevision: "old:1" });
  s.q.close();
  const Constructor = (sqlite as unknown as { Database?: typeof sqlite.DatabaseSync }).Database ?? sqlite.DatabaseSync;
  const db = new Constructor(join(s.dir, "incremental.sqlite"));
  db.exec("DROP INDEX attempt_history; DROP TABLE directory_baseline; DROP TABLE retirements; DROP TABLE directory; DROP TABLE discovery; DROP TABLE discovery_cursors; PRAGMA user_version=1;"); db.close();
  await s.reopen(true); const upgraded = s.q;
  assert.equal(upgraded.pendingVerifications()[0].ticket.operationId, ticket.operationId);
  assert.deepEqual(upgraded.claim(), []); assert.deepEqual(upgraded.directoryPage("status"), []);
});

test("directory boundaries, duplicate rows and a backwards clock do not advance state", async t => {
  const s = await setup(t); baseline(s.q);
  assert.throws(() => s.q.beginDiscovery("status", s.q.discoveryState("status").revision, { mode: "changes", startedAt: 1999, overlapMs: 0 }), error("DISCOVERY_CLOCK_INVALID"));
  const scan = s.q.beginDiscovery("status", s.q.discoveryState("status").revision, { mode: "changes", startedAt: 5000, overlapMs: 0 });
  assert.throws(() => s.q.commitDirectoryPage("status", scan.revision, [member("x"), member("x")], null), error("QUEUE_INPUT_INVALID"));
  assert.throws(() => s.q.commitDirectoryPage("status", scan.revision, Array.from({ length: 201 }, (_, i) => member(`p-${i}`)), null), error("QUEUE_INPUT_INVALID"));
  assert.deepEqual(s.q.discoveryState("status"), scan);
});

test("SDK adapter uses fixed inclusive timestamps and omits the membership cutoff", async () => {
  const s = fixture(), source = s.source(), scan = { id: "scan", mode: "changes" as const, phase: "query" as const,
    startedAt: 5000, since: 1000, cursor: "cursor", afterKey: null, pages: 0 };
  assert.equal((await source.read("status", scan, new AbortController().signal)).members.length, 2);
  assert.deepEqual(s.queryInputs[0].filter, { and: [
    { timestamp: "last_edited_time", last_edited_time: { on_or_after: new Date(1000).toISOString() } },
    { timestamp: "last_edited_time", last_edited_time: { on_or_before: new Date(5000).toISOString() } },
  ] });
  s.pages[0].last_edited_time = new Date(7000).toISOString();
  assert.equal((await source.read("status", { ...scan, mode: "membership", since: null }, new AbortController().signal)).members[0].lastEditedAt, 7000);
  assert.equal(s.queryInputs[1].filter, undefined);
});

test("query truncation, partial rows, foreign parents and wrong time window never persist a page", async t => {
  const f = fixture(), s = await setup(t, configDigest(f.config));
  const invalid = [
    { ...f.response(), request_status: { type: "incomplete", incomplete_reason: "query_result_limit_reached" } },
    { ...f.response(), results: [{ object: "page", id: demoId(1000) }] },
    f.response([{ ...f.pages[0], parent: { type: "data_source_id", data_source_id: demoId(99), database_id: demoId(98) } }]),
  ];
  for (const response of invalid) {
    f.client.queryDataSource = async () => response as Awaited<ReturnType<DirectoryNotionClient["queryDataSource"]>>;
    const source = f.source();
    const state = s.q.discoveryState("status");
    const result = await runDirectoryDiscovery({ queue: s.q, sourceKey: "status", now: () => 5000 }, source);
    assert.equal(result.outcome, "needs_review"); assert.deepEqual(s.q.directoryPage("status"), []);
    assert.equal(s.q.discoveryState("status").watermark, state.watermark);
  }
  f.client.queryDataSource = async () => f.response();
  await assert.rejects(f.source().read("status", { id: "scan", mode: "changes", phase: "query", startedAt: 5000, since: 2000,
    cursor: null, afterKey: null, pages: 0 }, new AbortController().signal), /DISCOVERY_WINDOW_INVALID/);
});

test("allowlists and configuration/schema drift are checked before admitting hints", async () => {
  const f = fixture(); f.config.sources[0].kind = "post"; f.config.sources[0].fields = { title: f.config.sources[0].fields.title };
  f.config.sources[0].publication = { mode: "allowlist", allowlistPageIds: [f.pages[0].id] };
  const source = f.source(), scan = { id: "scan", mode: "membership" as const, phase: "query" as const, startedAt: 5000, since: null, cursor: null, afterKey: null, pages: 0 };
  assert.equal((await source.read("status", scan, new AbortController().signal)).members.length, 1);
  f.config.sources[0].fields = { title: "Different" };
  await assert.rejects(source.validate("status", new AbortController().signal), /DISCOVERY_SCOPE_CHANGED/);
  await assert.rejects(f.source().validate("status", new AbortController().signal), /DISCOVERY_SCHEMA_INVALID/);
});

test("cancelled discovery ignores late transport completion and stores no private body or image URL", async t => {
  const s = await setup(t); let resolve!: (v: Awaited<ReturnType<DirectorySource["read"]>>) => void;
  const pending = new Promise<Awaited<ReturnType<DirectorySource["read"]>>>(r => { resolve = r; });
  const result = await runDirectoryDiscovery({ queue: s.q, sourceKey: "status", now: () => 5000, maxDurationMs: 10 },
    { scopeDigest: s.scope.digest, validate: async () => {}, read: async () => pending });
  assert.equal(result.outcome, "cancelled"); resolve({ members: [member("late")], nextCursor: null });
  await new Promise(r => setTimeout(r, 0)); assert.deepEqual(s.q.directoryPage("status"), []);
  assert.equal(s.q.discoveryState("status").watermark, null);
  const raw = await readFile(join(s.dir, "incremental.sqlite"));
  assert.ok(!raw.includes(Buffer.from("https://"))); assert.equal(result.hints, 0);
});

test("one changed metadata hint reaches the existing executor without preparing unchanged siblings", async t => {
  const s = await setup(t); baseline(s.q); const prepared: string[] = [];
  await runDirectoryDiscovery({ queue: s.q, sourceKey: "status", now: () => 5000, overlapMs: 1000 },
    { scopeDigest: s.scope.digest, validate: async () => {}, read: async () => ({ members: [member("page-1"), member("page-2", 4000)], nextCursor: null }) });
  const result = await runIncrementalCycle({ queue: s.q, schemaDigest: "b".repeat(64) }, {
    state: async () => ({ publicationRevision: "run:1", configDigest: s.scope.digest, schemaDigest: "b".repeat(64), policyEpoch: "epoch" }),
    prepare: async ticket => { prepared.push(ticket.pageKey); return { outcome: "unchanged" }; },
    submit: async () => assert.fail("No fixture content changed"), lookup: async () => null, verify: async () => assert.fail(),
  });
  assert.equal(result.outcome, "unchanged"); assert.deepEqual(prepared, ["page-2"]);
});

test("source scope mismatch is rejected before a remote read or scan begins", async t => {
  const s = await setup(t), f = fixture();
  const result = await runDirectoryDiscovery({ queue: s.q, sourceKey: "status" }, f.source());
  assert.equal(result.outcome, "needs_review"); assert.equal(result.errorCode, "DISCOVERY_SCOPE_CHANGED");
  assert.equal(s.q.discoveryState("status").revision, 0); assert.deepEqual(f.queryInputs, []);
});

test("volatile cover URLs are excluded from the directory fingerprint and state", async () => {
  const f = fixture(); f.config.sources[0].cover.strategy = "native-page-cover";
  const source = f.source(), scan = { id: "scan", mode: "membership" as const, phase: "query" as const,
    startedAt: 5000, since: null, cursor: null, afterKey: null, pages: 0 };
  const fictionalFileUrl = (version: string) => {
    const url = new URL("https://images.example.test/first");
    url.searchParams.set("X-Amz-Signature", `fictional-${version}`); return url.href;
  };
  f.pages[0].cover = { type: "file", file: { url: fictionalFileUrl("one"), expiry_time: "2026-01-01T00:00:00Z" } };
  const before = await source.read("status", scan, new AbortController().signal);
  f.pages[0].cover = { type: "file", file: { url: fictionalFileUrl("two"), expiry_time: "2026-01-02T00:00:00Z" } };
  const after = await source.read("status", scan, new AbortController().signal);
  assert.deepEqual(before.members, after.members); assert.ok(!JSON.stringify(after).includes("https://"));
});

test("property changes sharing a timestamp are detected and object-key order is ignored", async () => {
  const f = fixture(), source = f.source(), scan = { id: "scan", mode: "membership" as const, phase: "query" as const,
    startedAt: 5000, since: null, cursor: null, afterKey: null, pages: 0 };
  const before = await source.read("status", scan, new AbortController().signal);
  const title = f.pages[0].properties.Name;
  assert.equal(title.type, "title"); if (title.type !== "title") assert.fail();
  title.title[0].plain_text = "Updated title";
  if (title.title[0].type === "text") title.title[0].text.content = "Updated title";
  const changed = await source.read("status", scan, new AbortController().signal);
  assert.notEqual(changed.members[0].fingerprint, before.members[0].fingerprint);
  f.pages[0].properties.Name = Object.fromEntries(Object.entries(title).reverse()) as typeof title;
  assert.deepEqual((await source.read("status", scan, new AbortController().signal)).members, changed.members);
  assert.ok(!JSON.stringify(changed).includes("Updated title"));
});

test("automatic learning descendants are delegated rather than scanned as direct source rows", async () => {
  const f = fixture(); f.config.sources[0].kind = "study-note"; f.config.sources[0].publication.mode = "course-descendants";
  await assert.rejects(f.source().validate("status", new AbortController().signal), /DISCOVERY_SOURCE_UNSUPPORTED/);
  assert.deepEqual(f.queryInputs, []);
});


test("fenced directory discovery does not grow the external event ledger", async t => {
  const s = await setup(t);
  for (let n = 1; n <= 5; n++) {
    const scan = s.q.beginDiscovery("status", s.q.discoveryState("status").revision,
      { mode: "membership", startedAt: 5000 + n, overlapMs: 0 });
    const m = member("page-1"); m.fingerprint = fingerprint(n); m.lastEditedAt = 5000 + n;
    const page = s.q.commitDirectoryPage("status", scan.revision, [m], null);
    assert.equal(page.inserted, 1);
    assert.throws(() => s.q.commitDirectoryPage("status", scan.revision, [m], null), error("QUEUE_CHECKPOINT_CONFLICT"));
    s.q.reconcileDirectoryAbsences("status", page.state.revision);
    assert.equal(s.q.status().events, 0);
    const ticket = s.q.claim()[0]; assert.equal(ticket.generation, n); s.q.completeUnchanged(ticket);
  }
});

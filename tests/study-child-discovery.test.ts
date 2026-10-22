import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { parseWebsiteNotionConfig } from "../src/server/notion/website-config.ts";
import { configDigest } from "../src/server/database/website-validation.ts";
import { openIncrementalQueue, type QueueTicket } from "../scripts/website-incremental-sync/queue.ts";
import { openStudyCheckpoint } from "../scripts/website-incremental-sync/study-checkpoint.ts";
import { runStudyChildDiscovery, type StudyChildDiscoveryOptions } from "../scripts/website-incremental-sync/study-child-discovery.ts";
import { studyFixture, studyId } from "./helpers/study-runtime.ts";
import type { StudyChangeSource, StudyEntry } from "../src/server/notion/study-incremental.ts";
import { createStudyDomainPort } from "../scripts/website-incremental-sync/study-domain.ts";
import { createIncrementalCoordinator } from "../scripts/website-incremental-sync/coordinator.ts";
import { createDatabasePublicationPort } from "../scripts/website-incremental-sync/publication-port.ts";
import { runIncrementalCycle } from "../scripts/website-incremental-sync/executor.ts";
import { publicationWriter } from "../src/server/database/publication.ts";
import { installPublication } from "../scripts/website-sync/publication-migration.ts";
import { installIncrementalPublication } from "../scripts/website-sync/incremental-migration.ts";
import { installIncrementalReader } from "../scripts/website-sync/incremental-reader-migration.ts";
import { readPublicationState } from "../src/server/database/incremental-publication.ts";
import { WEBSITE_SCHEMA_DIGEST } from "../contracts/website-sync.ts";
import type { SqlExecutor } from "../src/server/database/sql.ts";

const NAME = "study-children-v1";
async function fixture() {
  const f = studyFixture(), config = parseWebsiteNotionConfig({ schemaVersion: 2, sources: [
    { key: "courses", kind: "course", enabled: true, dataSourceId: studyId(10), fields: { title: "Name" }, publication: { mode: "all" } },
    { key: "notes", kind: "study-note", enabled: true, dataSourceId: studyId(10), fields: { title: "Name", order: "Sort" }, publication: { mode: "course-descendants" } },
  ] });
  f.checkpoint.sourceDigest = configDigest(config);
  for (const entry of f.checkpoint.entries) entry.record.detail.item.updatedAt = "2026-10-13T00:00:00.000Z";
  const note = (n: number, parent = 2, position = 0): StudyEntry => {
    const entry = structuredClone(f.checkpoint.entries[1]), item = entry.record.detail.item;
    if (item.kind !== "study-note") throw Error();
    Object.assign(item, { id: studyId(n), slug: studyId(n), title: `Child ${n}`, parentId: studyId(parent), href: `/study/${studyId(1)}/notes/${studyId(n)}` });
    Object.assign(entry.record.evidence, { parentId: studyId(parent), ordinal: n - 1 }); entry.position = position;
    return entry;
  };
  f.checkpoint.entries.push(note(3), note(4, 2, 1));
  let baseline = structuredClone(f.checkpoint);
  const current = new Map(baseline.entries.map(entry => [entry.record.detail.item.id, structuredClone(entry)]));
  const reads: { id: string; document: boolean; children: boolean }[] = [];
  const source: StudyChangeSource = { sourceDigest: baseline.sourceDigest, read: async (id, flags) => {
    reads.push({ id, ...flags }); const entry = current.get(id);
    if (!entry) throw Error("Unknown page");
    const ancestors: string[] = []; let parent = entry.record.evidence.parentId;
    while (parent) { ancestors.unshift(parent); parent = current.get(parent)!.record.evidence.parentId; }
    return { state: "active", entry: structuredClone(entry), ancestors, ...(flags.children ? { children: [...current.values()].filter(child => child.record.evidence.parentId === id).sort((a, b) => (a.position ?? 0) - (b.position ?? 0)).map((child, position) => ({ id: child.record.detail.item.id, position, updatedAt: child.record.detail.item.updatedAt })) } : {}) };
  } };
  const directory = await realpath(await mkdtemp(join(tmpdir(), "study-children-")));
  const queue = await openIncrementalQueue(directory, { digest: baseline.sourceDigest, sourceKeys: ["courses", "notes"] });
  const options: StudyChildDiscoveryOptions = { queue, store: { load: () => structuredClone(baseline) }, config, sourceKey: "notes", source: () => source };
  return { ...f, config, note, current, source, reads, options, queue, directory, baseline: () => baseline, setBaseline: (value: typeof baseline) => { baseline = value; }, close: async () => { queue.close(); await rm(directory, { recursive: true, force: true }); } };
}

test("a new deep child with unchanged parent timestamps produces only a parent hint and no body reads", async () => {
  const s = await fixture(); try {
    s.current.set(studyId(5), s.note(5, 2, 2));
    assert.equal(s.current.get(studyId(2))!.record.detail.item.updatedAt, s.baseline().entries[1].record.detail.item.updatedAt);
    assert.deepEqual(await runStudyChildDiscovery(s.options), { outcome: "completed", parents: 3, hints: 1, unavailable: 0 });
    assert.ok(s.reads.every(read => !read.document && read.children));
    assert.ok(!s.reads.some(read => read.id === studyId(5)));
    const tickets = s.queue.claim(); assert.equal(tickets.length, 1); assert.equal(tickets[0].pageKey, studyId(2)); assert.deepEqual(tickets[0].reasons, ["relation"]);
    assert.equal(s.baseline().entries.length, 4);
  } finally { await s.close(); }
});
test("directory-only changes detect moves, disappearance and child order; first-level date/numeric order is independent", async () => {
  const s = await fixture(); try {
    s.current.get(studyId(3))!.position = 1; s.current.get(studyId(4))!.position = 0;
    const result = await runStudyChildDiscovery(s.options); assert.equal(result.hints, 1);
    const ticket = s.queue.claim()[0]; assert.equal(ticket.pageKey, studyId(2)); s.queue.completeUnchanged(ticket);
    s.current.delete(studyId(3));
    const archived: StudyChangeSource = { ...s.source, read: (id, flags) => id === studyId(3) ? Promise.resolve({ state: "withdrawn", reason: "archived" }) : s.source.read(id, flags) };
    assert.equal((await runStudyChildDiscovery({ ...s.options, source: () => archived })).hints, 2);
    const root = await runStudyChildDiscovery({ ...s.options, sourceKey: "courses" }); assert.equal(root.hints, 0);
    // A course's first-level order is derived from date/numeric overrides, not source enumeration.
    const other = s.note(6); if (other.record.detail.item.kind !== "study-note") throw Error();
    other.record.detail.item.parentId = null; other.record.evidence.parentId = studyId(1); other.position = 1;
    s.current.set(studyId(6), other); const base = structuredClone(s.baseline()); base.entries.push(structuredClone(other)); s.setBaseline(base);
    s.current.get(studyId(2))!.position = 1; other.position = 0;
    assert.equal((await runStudyChildDiscovery({ ...s.options, sourceKey: "courses" })).hints, 0);
  } finally { await s.close(); }
});
test("a physical move hints both affected parents and the moved page without withdrawing the cached graph", async () => {
  const s = await fixture(); try {
    const moved = s.current.get(studyId(3))!;
    if (moved.record.detail.item.kind !== "study-note") throw Error();
    moved.record.evidence.parentId = studyId(4); moved.record.detail.item.parentId = studyId(4); moved.position = 0;
    assert.equal((await runStudyChildDiscovery(s.options)).hints, 3);
    assert.deepEqual(s.queue.claim().map(t => t.pageKey).sort(), [2, 3, 4].map(studyId));
    assert.equal(s.baseline().entries[2].record.evidence.parentId, studyId(2));
  } finally { await s.close(); }
});
test("round-robin progress survives queue reopen, dedupes repeated pending observations and resumes by ID", async () => {
  const s = await fixture(); let reopened: typeof s.queue | undefined; try {
    s.current.set(studyId(5), s.note(5, 2, 2));
    const initial = await runStudyChildDiscovery({ ...s.options, maxParents: 1 }); assert.equal(initial.outcome, "limited"); assert.equal(initial.hints, 1);
    reopened = await openIncrementalQueue(s.directory, { digest: s.baseline().sourceDigest, sourceKeys: ["courses", "notes"] });
    const resumed = await runStudyChildDiscovery({ ...s.options, queue: reopened, maxParents: 1 }); assert.equal(resumed.parents, 1);
    assert.equal(s.reads[1].id, studyId(3));
    await runStudyChildDiscovery({ ...s.options, queue: reopened }); assert.equal(reopened.checkpoint("notes", NAME).cursor, null);
    assert.equal((await runStudyChildDiscovery({ ...s.options, queue: reopened })).hints, 0);
    assert.equal(reopened.claim()[0].generation, 1);
  } finally { reopened?.close(); await s.close(); }
});
test("an unrelated publication revision neither resets round-robin progress nor repeats a pending hint", async () => {
  const s = await fixture(); try {
    s.current.set(studyId(5), s.note(5, 2, 2));
    await runStudyChildDiscovery({ ...s.options, maxParents: 1 });
    s.setBaseline({ ...s.baseline(), version: `${randomUUID()}:7` });
    await runStudyChildDiscovery(s.options); assert.equal(s.reads[1].id, studyId(3));
    assert.equal((await runStudyChildDiscovery(s.options)).hints, 0);
  } finally { await s.close(); }
});
test("a changed verified baseline can require a new hint even when the source observation was seen before", async () => {
  const s = await fixture(); try {
    const first = await runStudyChildDiscovery(s.options); assert.equal(first.hints, 0);
    const base = structuredClone(s.baseline()); base.entries[1].record.detail.item.title = "A different committed title"; base.version = `${randomUUID()}:2`; s.setBaseline(base);
    assert.equal((await runStudyChildDiscovery(s.options)).hints, 1);
    assert.deepEqual(s.queue.claim()[0].reasons, ["properties"]);
  } finally { await s.close(); }
});
test("one unknown parent produces a recheck instead of deletion and does not starve the rest of the source", async () => {
  const s = await fixture(); try {
    s.current.set(studyId(5), s.note(5, 2, 2));
    const options = { ...s.options, source: () => ({ ...s.source, read: async (id: string, flags: { document: boolean; children: boolean }) => {
      if (id === studyId(3)) throw Error("Transport unavailable"); return s.source.read(id, flags);
    } }) };
    assert.deepEqual(await runStudyChildDiscovery(options), { outcome: "completed", parents: 3, hints: 2, unavailable: 1 });
    assert.deepEqual(s.queue.checkpoint("notes", NAME), { revision: 1, cursor: null });
    assert.deepEqual(s.queue.claim().map(ticket => [ticket.pageKey, ticket.reasons]).sort(), [[studyId(2), ["relation"]], [studyId(3), ["reconcile"]]]);
    assert.equal(s.baseline().entries.length, 4);
  } finally { await s.close(); }
});
test("archive and deny signals are reconciliation hints only, with no local graph withdrawal", async () => {
  const s = await fixture(); try {
    for (const reason of ["archived", "denied"] as const) {
      const source: StudyChangeSource = { ...s.source, read: (id, flags) => id === studyId(3) ? Promise.resolve({ state: "withdrawn", reason }) : s.source.read(id, flags) };
      assert.equal((await runStudyChildDiscovery({ ...s.options, source: () => source })).hints, 1);
    }
    assert.equal(s.baseline().entries.length, 4); const ticket = s.queue.claim()[0]; assert.deepEqual(ticket.reasons, ["reconcile"]);
  } finally { await s.close(); }
});
test("scope, malformed children and child budgets reject before queue progress", async () => {
  const s = await fixture(); try {
    const config = structuredClone(s.config); config.sources[0].fields = { title: "Different" };
    assert.equal((await runStudyChildDiscovery({ ...s.options, config })).errorCode, "STUDY_DISCOVERY_SCOPE_CHANGED"); assert.equal(s.reads.length, 0);
    assert.equal((await runStudyChildDiscovery({ ...s.options, maxChildren: 1 })).errorCode, "STUDY_DISCOVERY_CHILD_LIMIT");
    const source: StudyChangeSource = { ...s.source, read: async (id, flags) => {
      const result = await s.source.read(id, flags); if (result.state === "active") result.children!.forEach(child => { child.position = 4; }); return result;
    } };
    assert.equal((await runStudyChildDiscovery({ ...s.options, source: () => source })).errorCode, "STUDY_DISCOVERY_RESPONSE_INVALID");
    assert.equal(s.queue.claim().length, 0); assert.equal(s.queue.checkpoint("notes", NAME).revision, 0);
  } finally { await s.close(); }
});
test("baseline drift and queue cursor races do not stage stale observation progress", async () => {
  const s = await fixture(); try {
    const source: StudyChangeSource = { ...s.source, read: async (id, flags) => {
      const result = await s.source.read(id, flags); s.setBaseline({ ...s.baseline(), version: `${randomUUID()}:2` }); return result;
    } };
    assert.equal((await runStudyChildDiscovery({ ...s.options, source: () => source })).errorCode, "STUDY_DISCOVERY_BASELINE_CHANGED");
    assert.equal(s.queue.checkpoint("notes", NAME).revision, 0);
    const racing: StudyChangeSource = { ...s.source, read: async (id, flags) => {
      const result = await s.source.read(id, flags), cp = s.queue.checkpoint("notes", NAME);
      s.queue.commitDiscovery({ sourceKey: "notes", name: NAME, expectedRevision: cp.revision, nextCursor: null, events: [] }); return result;
    } };
    assert.equal((await runStudyChildDiscovery({ ...s.options, source: () => racing })).errorCode, "STUDY_DISCOVERY_CURSOR_CHANGED"); assert.equal(s.queue.claim().length, 0);
  } finally { await s.close(); }
});
test("late results after timeout or cancellation cannot enqueue or advance the cursor", async () => {
  const s = await fixture(); try {
    let release!: () => void;
    const source: StudyChangeSource = { ...s.source, read: async (id, flags) => { await new Promise<void>(resolve => { release = resolve; }); return s.source.read(id, flags); } };
    const result = await runStudyChildDiscovery({ ...s.options, source: () => source, maxDurationMs: 10 });
    assert.equal(result.errorCode, "STUDY_DISCOVERY_DEADLINE"); release(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(s.queue.claim().length, 0); assert.equal(s.queue.checkpoint("notes", NAME).revision, 0);
    const controller = new AbortController();
    const pending = runStudyChildDiscovery({ ...s.options, source: () => source, signal: controller.signal });
    await new Promise(resolve => setImmediate(resolve)); controller.abort(); assert.equal((await pending).outcome, "cancelled"); release();
    await new Promise(resolve => setImmediate(resolve)); assert.equal(s.queue.claim().length, 0);
  } finally { await s.close(); }
});
test("a slot conflict is recoverable: earlier atomic hints dedupe while the control cursor stays put", async () => {
  const s = await fixture(); try {
    s.current.set(studyId(5), s.note(5, 2, 2)); s.current.get(studyId(3))!.record.detail.item.title = "Changed child";
    const source: StudyChangeSource = { ...s.source, read: async (id, flags) => {
      const result = await s.source.read(id, flags);
      if (id === studyId(4)) s.queue.commitDiscovery({ sourceKey: "notes", name: `${NAME}:1`, expectedRevision: 0, nextCursor: null, events: [] });
      return result;
    } };
    const first = await runStudyChildDiscovery({ ...s.options, source: () => source }); assert.equal(first.errorCode, "QUEUE_CHECKPOINT_CONFLICT"); assert.equal(first.hints, 1);
    assert.equal(s.queue.checkpoint("notes", NAME).revision, 0);
    assert.equal((await runStudyChildDiscovery(s.options)).hints, 1);
    assert.equal(s.queue.claim().find(t => t.pageKey === studyId(2))!.generation, 1);
  } finally { await s.close(); }
});
test("actual queue discovery and study engine admit a new child through SQL and independent verification", async () => {
  const s = await fixture(), db = await PGlite.create(); let store: Awaited<ReturnType<typeof openStudyCheckpoint>> | undefined;
  try {
    await db.exec("CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;");
    await db.exec(await readFile(new URL("../database/website-migrations/001_website.sql", import.meta.url), "utf8"));
    await db.query("UPDATE nb_v2.state SET schema_digest=$1", [WEBSITE_SCHEMA_DIGEST]);
    await db.exec(await readFile(new URL("../database/website-study-migrations/001_automatic_study.sql", import.meta.url), "utf8"));
    const owner: SqlExecutor = { query: async <T>(sql: string, values?: unknown[]) => {
      if (sql.startsWith("--")) { await db.exec(sql); return { rows: [] as T[] }; } return db.query<T>(sql, values);
    } };
    await installPublication(owner); await installIncrementalPublication(owner); await installIncrementalReader(owner);
    const role = (name: string): SqlExecutor => ({ query: <T>(sql: string, values?: unknown[]) => db.transaction(async tx => { await tx.exec(`SET LOCAL ROLE ${name}`); return tx.query<T>(sql, values); }) });
    const reader = role("nb_reader"), writer = role("nb_writer"), sources = s.config.sources.map(c => ({ key: c.key, kind: c.kind, mode: c.publication.mode, dataSourceId: c.dataSourceId, databaseParentId: null, pageId: null }));
    await db.query("SELECT nb_v2_api.configure_policy($1,600,$2::jsonb,'[]')", [s.baseline().sourceDigest, JSON.stringify(sources)]);
    const full = publicationWriter(writer, "published"), lease = await full.begin(randomUUID(), s.baseline().sourceDigest);
    await full.stage(lease, s.baseline().entries.map(e => e.record), []); await full.promote(lease, { records: 4, media: 0, complete: true });
    const state = await readPublicationState(reader); s.setBaseline({ ...s.baseline(), version: state.publicationRevision });
    store = await openStudyCheckpoint(s.directory, state.configDigest); store.initialize(s.baseline(), { ...state, readerVerified: true });
    s.current.set(studyId(5), s.note(5, 2, 2)); s.reads.length = 0;
    assert.equal((await runStudyChildDiscovery({ ...s.options, store })).hints, 1);
    assert.ok(s.reads.every(r => !r.document));
    const publication = createDatabasePublicationPort(writer, reader);
    const study = createStudyDomainPort<QueueTicket>({ store, sourceKeys: ["courses", "notes"], assertPreparing: ticket => s.queue.assertPreparing(ticket), source: () => s.source,
      incomingLinks: async (_changes, state) => ({ records: [], ...state, verified: true }), assets: async () => ({ media: [], verified: true }), verify: publication.verify });
    const coordinator = createIncrementalCoordinator<QueueTicket>({ queue: s.queue, scopeDigest: state.configDigest, sourceKeys: ["courses", "notes"], studySourceKeys: ["courses", "notes"], study, checkpoint: store, publication,
      regular: { prepare: async () => ({ outcome: "unchanged" }) } });
    const result = await runIncrementalCycle({ queue: s.queue, schemaDigest: WEBSITE_SCHEMA_DIGEST }, coordinator); assert.equal(result.published, 1);
    assert.equal(store.load().entries.length, 5);
    const next = await readPublicationState(reader); assert.equal(store.load().version, next.publicationRevision);
    s.reads.length = 0; assert.equal((await runStudyChildDiscovery({ ...s.options, store })).hints, 0);
    assert.ok(s.reads.every(r => !r.document));
  } finally { store?.close(); await db.close(); await s.close(); }
});

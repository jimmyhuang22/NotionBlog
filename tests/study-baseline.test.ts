import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, chmod, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import type { PageObjectResponse, BlockObjectResponse, DataSourceObjectResponse, DatabaseObjectResponse } from "@notionhq/client";
import type { NotionReadClient } from "../src/server/notion/types.ts";
import { parseWebsiteNotionConfig } from "../src/server/notion/website-config.ts";
import { collectWebsiteStudyBaseline, createWebsiteNotionRepository, type WebsiteStudyCollection } from "../src/server/notion/website-repository.ts";
import { canonicalJson, configDigest } from "../src/server/database/website-validation.ts";
import { openStudyCheckpoint } from "../scripts/website-incremental-sync/study-checkpoint.ts";
import { createDatabaseStudyBaselineReader, initializeStudyBaseline, validateStudyBaselineCollection, type StudyBaselineOptions } from "../scripts/website-incremental-sync/study-baseline.ts";
import { readPublicationState } from "../src/server/database/incremental-publication.ts";
import { publicationWriter } from "../src/server/database/publication.ts";
import { installPublication } from "../scripts/website-sync/publication-migration.ts";
import { installIncrementalPublication } from "../scripts/website-sync/incremental-migration.ts";
import { installIncrementalReader } from "../scripts/website-sync/incremental-reader-migration.ts";
import { WEBSITE_SCHEMA_DIGEST } from "../contracts/website-sync.ts";
import type { SqlExecutor } from "../src/server/database/sql.ts";

const id = (n: number) => n.toString(16).padStart(32, "0");
const coded = (code: string) => (error: unknown) => error instanceof Error && "code" in error && error.code === code;
function sourceFixture() {
  const config = parseWebsiteNotionConfig({ schemaVersion: 2, sources: [
    { key: "courses", kind: "course", enabled: true, dataSourceId: id(1), fields: { title: "Name" }, publication: { mode: "all" } },
    { key: "notes", kind: "study-note", enabled: true, dataSourceId: id(1), fields: { title: "Name", date: "Date", order: "Sort" }, publication: { mode: "course-descendants" } },
  ] });
  const richText = (text: string) => ({ type: "text", plain_text: text, text: { content: text, link: null }, annotations: { bold: false, italic: false, strikethrough: false, underline: false, code: false, color: "default" }, href: null });
  const pages = new Map<number, PageObjectResponse>();
  for (const [n, title, owner] of [[10, "Course A", null], [11, "Course B", null], [20, "Later date", 10], [21, "Earlier date", 10], [30, "Child A", 20], [31, "Child Z", 20], [40, "Other course", 11]] as const) {
    pages.set(n, { object: "page", id: id(n), parent: owner === null ? { type: "data_source_id", data_source_id: id(1), database_id: id(2) } : { type: "page_id", page_id: id(owner) }, archived: false, in_trash: false, cover: null,
      last_edited_time: "2026-10-13T00:00:00.000Z", properties: { Name: { type: "title", id: "title", title: [richText(title)] },
        Date: { type: "date", id: "date", date: { start: n === 20 ? "2026-04-02" : "2026-04-01", end: null, time_zone: null } },
        Sort: { type: "number", id: "sort", number: n === 20 ? 0 : null } } } as unknown as PageObjectResponse);
  }
  const blocks = new Map<string, BlockObjectResponse[]>();
  const children = new Map([[10, [20, 21]], [11, [40]], [20, [31, 30]]]);
  for (const n of pages.keys()) blocks.set(id(n), (children.get(n) ?? []).map(child => ({ object: "block", id: id(child), parent: { type: "page_id", page_id: id(n) }, type: "child_page", child_page: { title: "Owned child" }, archived: false, in_trash: false, has_children: false } as unknown as BlockObjectResponse)));
  for (const n of [20, 21, 40]) pages.get(n)!.parent = { type: "data_source_id", data_source_id: id(n === 40 ? 8 : 3), database_id: id(n === 40 ? 7 : 2) };
  for (const n of [10, 11]) blocks.set(id(n), [{ object: "block", id: id(n === 10 ? 2 : 7), parent: { type: "page_id", page_id: id(n) }, type: "child_database", child_database: { title: "Owned notes" }, archived: false, in_trash: false, has_children: false } as unknown as BlockObjectResponse]);
  const calls: string[] = [];
  const client: NotionReadClient = {
    getPage: async key => { calls.push(`page:${key}`); return structuredClone(pages.get(Number.parseInt(key, 16)) ?? null); },
    getBlock: async key => structuredClone([...blocks.values()].flat().find(b => b.id === key) ?? null),
    getDataSource: async key => ({ id: key, parent: { type: "database_id", database_id: id(key === id(8) ? 7 : 2) }, database_parent: { type: "page_id", page_id: id(key === id(3) ? 10 : key === id(8) ? 11 : 900) }, properties: { Name: { type: "title", id: "title" }, Date: { type: "date", id: "date" }, Sort: { type: "number", id: "sort" } } }) as unknown as DataSourceObjectResponse,
    getDatabase: async key => ({ id: key, parent: { type: "page_id", page_id: id(key === id(2) ? 10 : 11) }, data_sources: [{ id: id(key === id(2) ? 3 : 8), name: "Notes" }], archived: false, in_trash: false }) as DatabaseObjectResponse,
    listPages: async key => { calls.push(`rows:${key}`); return structuredClone([...pages.values()].filter(p => p.parent.type === "data_source_id" && p.parent.data_source_id === key)); },
    listBlocks: async key => { calls.push(`blocks:${key}`); return structuredClone(blocks.get(key) ?? []); },
  };
  return { config, client, pages, blocks, calls, options: { config, client, registerImage: async () => { throw Error("No image I/O expected"); } } };
}
async function local() {
  const f = sourceFixture(), collection = await collectWebsiteStudyBaseline(f.options), dir = await realpath(await mkdtemp(join(tmpdir(), "study-baseline-")));
  await chmod(dir, 0o700);
  const fullRunId = randomUUID(), store = await openStudyCheckpoint(dir, collection.baseline.sourceDigest), reads: string[] = [];
  const state = { publicationRevision: `${fullRunId}:0`, configDigest: collection.baseline.sourceDigest, schemaDigest: WEBSITE_SCHEMA_DIGEST, policyEpoch: "1" };
  const options: StudyBaselineOptions = { collection, config: f.config, deniedPageIds: new Set(), fullRunId, store, reader: {
    inventory: async () => ({ publicationRevision: state.publicationRevision, schemaDigest: WEBSITE_SCHEMA_DIGEST, ids: collection.baseline.entries.map(e => e.record.detail.item.id), readerVerified: true }),
    state: async () => structuredClone(state), read: async input => {
      reads.push(input.pageId); assert.equal(input.expectedRevision, state.publicationRevision);
      const record = collection.records.find(r => r.detail.item.id === input.pageId)!;
      return { record: structuredClone(record), media: [], ...state, readerVerified: true };
    },
  } };
  return { ...f, collection, options, state, reads, store, dir, close: async () => { store.close(); await rm(dir, { recursive: true, force: true }); } };
}

test("one complete collection captures both courses, numeric ordering and owned body order without additional source or media calls", async () => {
  const f = sourceFixture(); await createWebsiteNotionRepository(f.options).collectRecords(true);
  const previous = [...f.calls]; f.calls.length = 0;
  const result = await collectWebsiteStudyBaseline(f.options);
  assert.deepEqual(f.calls, previous);
  assert.equal(result.baseline.entries.length, 7);
  assert.deepEqual(result.baseline.entries.filter(e => e.record.detail.item.kind === "course").map(e => e.record.detail.item.id), [id(10), id(11)]);
  assert.equal(result.baseline.entries.find(e => e.record.detail.item.id === id(20))!.override, 0);
  const notes = result.baseline.entries.filter(e => e.record.detail.item.kind === "study-note").sort((a, b) => a.record.evidence.ordinal - b.record.evidence.ordinal);
  assert.deepEqual(notes.map(e => e.record.detail.item.id), [id(20), id(31), id(30), id(21), id(40)]);
  assert.ok(notes.every(e => e.position === e.record.evidence.ordinal));
  validateStudyBaselineCollection(JSON.parse(JSON.stringify(result)) as WebsiteStudyCollection, f.config, new Set());
});
test("a self-consistent single-course subset cannot hide pages present in the independent inventory", async () => {
  const s = await local(); try {
    const truncated = structuredClone(s.collection);
    truncated.records = truncated.records.filter(r => r.detail.item.id !== id(11) && r.evidence.courseId !== id(11));
    truncated.baseline.entries = truncated.baseline.entries.filter(e => e.record.detail.item.id !== id(11) && e.record.evidence.courseId !== id(11));
    truncated.baseline.recordsDigest = configDigest(truncated.records);
    truncated.baseline.entriesDigest = configDigest(truncated.baseline.entries);
    validateStudyBaselineCollection(truncated, s.config, new Set());
    await assert.rejects(initializeStudyBaseline({ ...s.options, collection: truncated }, new AbortController().signal), coded("STUDY_BASELINE_INVENTORY_MISMATCH"));
    assert.deepEqual(s.reads, []);
    assert.throws(() => s.store.load(), coded("STUDY_CHECKPOINT_MISSING"));
  } finally { await s.close(); }
});
test("old single-course allowlists are rejected before reading any source", async () => {
  const f = sourceFixture(); f.config.sources[0].publication = { mode: "allowlist", allowlistPageIds: [id(10)] };
  await assert.rejects(collectWebsiteStudyBaseline(f.options), /complete automatic study configuration/);
  assert.deepEqual(f.calls, []);
});
test("ancestor deny is preserved in the captured graph and is bound to the baseline", async () => {
  const f = sourceFixture(), result = await collectWebsiteStudyBaseline({ ...f.options, deniedPageIds: new Set([id(20)]) });
  assert.deepEqual(result.baseline.entries.map(e => e.record.detail.item.id), [10, 11, 21, 40].map(id));
  validateStudyBaselineCollection(result, f.config, new Set([id(20)]));
  assert.throws(() => validateStudyBaselineCollection(result, f.config, new Set()), coded("STUDY_BASELINE_SCOPE_MISMATCH"));
});
test("collection failures and incomplete image traversal cannot produce a baseline", async () => {
  const f = sourceFixture(); f.client.listBlocks = async () => { throw Error("Unavailable source"); };
  await assert.rejects(collectWebsiteStudyBaseline(f.options), /Unavailable source/);
  const g = sourceFixture(); g.blocks.set(id(30), [{ object: "block", id: id(300), parent: { type: "page_id", page_id: id(30) }, type: "image", image: { type: "external", external: { url: "https://example.test/image.png" }, caption: [] }, has_children: false, archived: false, in_trash: false } as unknown as BlockObjectResponse]);
  await assert.rejects(collectWebsiteStudyBaseline({ ...g.options, registerImage: async () => null }));
});
test("a persisted companion must match the whole collection, complete graph and pinned source policy", async () => {
  const s = await local(); try {
    for (const change of [
      (c: WebsiteStudyCollection) => { c.records[0].detail.item.title = "Corrupted"; },
      (c: WebsiteStudyCollection) => { c.baseline.entries.pop(); },
      (c: WebsiteStudyCollection) => { c.baseline.entries[0].record.detail.document = null; },
      (c: WebsiteStudyCollection) => { c.baseline.entries[0].record.evidence.sourceKey = "other"; },
      (c: WebsiteStudyCollection) => { c.baseline.entries[2].override = 99; },
    ]) { const copy = structuredClone(s.collection); change(copy); assert.throws(() => validateStudyBaselineCollection(copy, s.config, new Set()), coded("STUDY_BASELINE_INVALID")); }
    const copy = structuredClone(s.config); copy.sources[1].fields = { ...copy.sources[1].fields, order: "Different sort" };
    assert.throws(() => validateStudyBaselineCollection(s.collection, copy, new Set()), coded("STUDY_BASELINE_SCOPE_MISMATCH"));
  } finally { await s.close(); }
});
test("independent same-version records install a restartable baseline and never reread Notion", async () => {
  const s = await local(); try {
    s.calls.length = 0;
    const result = await initializeStudyBaseline(s.options, new AbortController().signal);
    assert.deepEqual(result, { publicationRevision: s.state.publicationRevision, courses: 2, pages: 5, reads: 7 });
    assert.deepEqual(s.calls, []);
    const reopened = await openStudyCheckpoint(s.dir, s.collection.baseline.sourceDigest);
    try { assert.deepEqual(reopened.load().entries, s.collection.baseline.entries); } finally { reopened.close(); }
    assert.deepEqual(await initializeStudyBaseline(s.options, new AbortController().signal), result);
  } finally { await s.close(); }
});
test("budget, missing reader proof and altered database records fail without initialization", async () => {
  const s = await local(); try {
    await assert.rejects(initializeStudyBaseline({ ...s.options, maxReads: 6 }, new AbortController().signal), coded("STUDY_BASELINE_BUDGET_EXCEEDED"));
    assert.deepEqual(s.reads, []);
    await assert.rejects(initializeStudyBaseline({ ...s.options, reader: { ...s.options.reader, read: async () => null } }, new AbortController().signal), coded("STUDY_BASELINE_READER_MISMATCH"));
    await assert.rejects(initializeStudyBaseline({ ...s.options, reader: { ...s.options.reader, read: async (input, signal) => {
      const value = (await s.options.reader.read(input, signal))!; value.record.detail.item.title = "Different database body version"; return value;
    } } }, new AbortController().signal), coded("STUDY_BASELINE_READER_MISMATCH"));
    assert.throws(() => s.store.load(), coded("STUDY_CHECKPOINT_MISSING"));
  } finally { await s.close(); }
});
test("publication deltas and policy changes during verification stop before local install", async () => {
  const s = await local(); try {
    const later = { ...s.state, publicationRevision: `${randomUUID()}:1` };
    await assert.rejects(initializeStudyBaseline({ ...s.options, reader: { ...s.options.reader, state: async () => later } }, new AbortController().signal), coded("STUDY_BASELINE_PUBLICATION_CHANGED"));
    assert.equal(s.reads.length, 0);
    let states = 0;
    await assert.rejects(initializeStudyBaseline({ ...s.options, reader: { ...s.options.reader, state: async () => ({ ...s.state, policyEpoch: states++ ? "2" : "1" }) } }, new AbortController().signal), coded("STUDY_BASELINE_PUBLICATION_CHANGED"));
    assert.throws(() => s.store.load(), coded("STUDY_CHECKPOINT_MISSING"));
  } finally { await s.close(); }
});
test("cancellation and caller mutation across asynchronous reader calls cannot install late or mixed input", async () => {
  const s = await local(); try {
    const controller = new AbortController();
    await assert.rejects(initializeStudyBaseline({ ...s.options, reader: { ...s.options.reader, read: async (input, signal) => {
      const value = await s.options.reader.read(input, signal); controller.abort(); return value;
    } } }, controller.signal), { name: "AbortError" });
    assert.throws(() => s.store.load(), coded("STUDY_CHECKPOINT_MISSING"));
    const original = structuredClone(s.collection);
    const options: StudyBaselineOptions = { ...s.options, reader: { ...s.options.reader, read: async input => {
      s.collection.baseline.entries[0].override = 99;
      return { record: original.records.find(r => r.detail.item.id === input.pageId)!, media: [], ...s.state, readerVerified: true as const };
    } } };
    await initializeStudyBaseline(options, new AbortController().signal);
    assert.deepEqual(s.store.load().entries, original.baseline.entries);
  } finally { await s.close(); }
});
test("actual full SQL publication and independent restricted reader seed the durable ordering companion", async () => {
  const s = await local(), db = await PGlite.create();
  try {
    await db.exec("CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;");
    await db.exec(await readFile(new URL("../database/website-migrations/001_website.sql", import.meta.url), "utf8"));
    await db.query("UPDATE nb_v2.state SET schema_digest=$1", [WEBSITE_SCHEMA_DIGEST]);
    await db.exec(await readFile(new URL("../database/website-study-migrations/001_automatic_study.sql", import.meta.url), "utf8"));
    const owner: SqlExecutor = { query: async <T>(sql: string, values?: unknown[]) => {
      if (sql.startsWith("--")) { await db.exec(sql); return { rows: [] as T[] }; } return db.query<T>(sql, values);
    } };
    await installPublication(owner); await installIncrementalPublication(owner); await installIncrementalReader(owner);
    const role = (name: string): SqlExecutor => ({ query: <T>(sql: string, values?: unknown[]) => db.transaction(async tx => {
      await tx.exec(`SET LOCAL ROLE ${name}`); return tx.query<T>(sql, values);
    }) });
    const reader = role("nb_reader"), writer = role("nb_writer"), sources = s.config.sources.map(source => ({ key: source.key, kind: source.kind, mode: source.publication.mode, dataSourceId: source.dataSourceId, databaseParentId: null, pageId: null }));
    await db.query("SELECT nb_v2_api.configure_policy($1,600,$2::jsonb,'[]')", [s.collection.baseline.sourceDigest, JSON.stringify(sources)]);
    const full = publicationWriter(writer, "published"), lease = await full.begin(s.options.fullRunId, s.collection.baseline.sourceDigest);
    await full.stage(lease, s.collection.records, []); await full.promote(lease, { records: s.collection.records.length, media: 0, complete: true });
    const accepted = await readPublicationState(reader);
    s.calls.length = 0;
    const result = await initializeStudyBaseline({ ...s.options, reader: createDatabaseStudyBaselineReader(reader) }, new AbortController().signal);
    assert.deepEqual(result, { publicationRevision: accepted.publicationRevision, courses: 2, pages: 5, reads: 7 });
    assert.equal(canonicalJson(s.store.load().entries), canonicalJson(s.collection.baseline.entries));
    assert.deepEqual(s.calls, []);
  } finally { await db.close(); await s.close(); }
});

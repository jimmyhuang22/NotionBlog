import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { fixtureItems } from "../fixtures/content.ts";
import { WEBSITE_SCHEMA_DIGEST } from "../contracts/website-sync.ts";
import { publicationWriter } from "../src/server/database/publication.ts";
import { readPublicationState } from "../src/server/database/incremental-publication.ts";
import type { SqlExecutor } from "../src/server/database/sql.ts";
import { installPublication } from "../scripts/website-sync/publication-migration.ts";
import { installIncrementalPublication } from "../scripts/website-sync/incremental-migration.ts";
import { installIncrementalReader } from "../scripts/website-sync/incremental-reader-migration.ts";
import { openContentCache, type ContentCacheBaseline } from "../scripts/website-incremental-sync/content-cache.ts";
import { createDatabaseContentBaselineReader, initializeContentBaseline, type ContentBaselineOptions, type ContentBaselineReader } from "../scripts/website-incremental-sync/content-baseline.ts";
import { cacheFixture } from "./helpers/content-cache.ts";
import { studyId } from "./helpers/study-runtime.ts";

const coded = (code: string) => (e: unknown) => e instanceof Error && "code" in e && e.code === code;
test("complete baseline proof uses the real independent publication reader and all eligible assets", async t => {
  const f = cacheFixture(true), db = await PGlite.create();
  t.after(() => db.close());
  await db.exec("CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;");
  await db.exec(await readFile(new URL("../database/website-migrations/001_website.sql", import.meta.url), "utf8"));
  await db.query("UPDATE nb_v2.state SET schema_digest=$1", [WEBSITE_SCHEMA_DIGEST]);
  await db.exec(await readFile(new URL("../database/website-study-migrations/001_automatic_study.sql", import.meta.url), "utf8"));
  const owner: SqlExecutor = { query: async <T>(sql: string, values?: unknown[]) => {
    if (sql.startsWith("--")) { await db.exec(sql); return { rows: [] as T[] }; } return db.query<T>(sql, values);
  } };
  await installPublication(owner); await installIncrementalPublication(owner); await installIncrementalReader(owner);
  let rawReads = 0, inventoryReads = 0;
  const role = (name: "nb_reader" | "nb_writer"): SqlExecutor => ({ query: <T>(sql: string, values?: unknown[]) => db.transaction(async tx => {
    await tx.exec(`SET LOCAL ROLE ${name}`);
    if (sql.includes("nb_delta_api.read_page")) rawReads++;
    if (sql.includes("nb_publication_api.read_snapshot")) {
      inventoryReads++;
      assert.equal((values![0] as string[]).length, 10);
      assert.equal(values![1], false);
    }
    return tx.query<T>(sql, values);
  }) });
  const readerSql = role("nb_reader"), writerSql = role("nb_writer"), fullRunId = randomUUID();
  const book = structuredClone(f.ordinary), item = structuredClone(fixtureItems.book[0]);
  Object.assign(item, { id: studyId(60), slug: studyId(60), href: `/library/books/${studyId(60)}`, cover: null });
  book.detail.item = item; book.detail.document!.blocks = []; book.evidence.sourceKey = "books"; book.evidence.dataSourceId = studyId(12);
  const records = [...f.baseline.records, book];
  // An unreferenced descriptor must still be part of a complete private cache.
  // The browser's compact projection intentionally hides this ID.
  const media = [...f.baseline.media, { ...f.baseline.media[0], assetId: `a1.${"d".repeat(64)}`,
    sha256: "e".repeat(64), objectKey: `sha256/${"e".repeat(64)}`, ownerPageId: f.other.detail.item.id }];
  const sourceKeys = [...f.sourceKeys, "books"], sources = [
    { key: "courses", kind: "course", mode: "all", dataSourceId: studyId(10), databaseParentId: null, pageId: null },
    { key: "notes", kind: "study-note", mode: "course-descendants", dataSourceId: studyId(10), databaseParentId: null, pageId: null },
    { key: "status", kind: "status", mode: "all", dataSourceId: studyId(11), databaseParentId: null, pageId: null },
    { key: "books", kind: "book", mode: "all", dataSourceId: studyId(12), databaseParentId: null, pageId: null },
  ];
  await db.query("SELECT nb_v2_api.configure_policy($1,600,$2::jsonb,'[]')", [f.state.configDigest, JSON.stringify(sources)]);
  const full = publicationWriter(writerSql, "published"), lease = await full.begin(fullRunId, f.state.configDigest);
  await full.stage(lease, records, media); await full.promote(lease, { records: records.length, media: media.length, complete: true });
  const state = await readPublicationState(readerSql), baseline: ContentCacheBaseline = { state, records, media };
  const reader = createDatabaseContentBaselineReader(readerSql), signal = () => new AbortController().signal;
  async function local() {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "content-baseline-")));
    const store = await openContentCache(directory, state.configDigest, sourceKeys);
    const options: ContentBaselineOptions = { baseline: structuredClone(baseline), fullRunId, store, reader };
    return { directory, store, options, close: async () => { store.close(); await rm(directory, { recursive: true, force: true }); } };
  }
  async function failure(change: (o: ContentBaselineOptions) => void, code: string) {
    const s = await local(); try {
      change(s.options);
      await assert.rejects(initializeContentBaseline(s.options, signal()), coded(code));
      assert.throws(() => s.store.readPublished({ sourceKey: "status", pageKey: f.ordinary.detail.item.id }, state), coded("CONTENT_CACHE_BASELINE_MISSING"));
    } finally { await s.close(); }
  }
  await t.test("exact raw records, ownership and both descriptors initialize a restartable private store", async () => {
    const s = await local(); try {
      rawReads = 0; inventoryReads = 0;
      const result = await initializeContentBaseline(s.options, signal());
      assert.equal(result.records, 5); assert.equal(result.media, 2); assert.equal(result.reads, 5);
      assert.equal(rawReads, 5); assert.equal(inventoryReads, 1);
      const reopened = await openContentCache(s.directory, state.configDigest, sourceKeys);
      try {
        for (const record of records) {
          const current = reopened.readPublished({ sourceKey: record.evidence.sourceKey, pageKey: record.detail.item.id }, state)!;
          assert.deepEqual(current.record, record);
          assert.deepEqual(current.media, media.filter(m => m.ownerPageId === record.detail.item.id));
        }
      } finally { reopened.close(); }
      await assert.rejects(initializeContentBaseline(s.options, signal()), coded("CONTENT_CACHE_ALREADY_INITIALIZED"));
      assert.deepEqual(s.store.readPublished({ sourceKey: "status", pageKey: f.ordinary.detail.item.id }, state)!.record, f.ordinary);
    } finally { await s.close(); }
  });
  await t.test("a valid study-only subset cannot hide ordinary pages or another content kind", async () => {
    rawReads = 0;
    await failure(o => { o.baseline.records = o.baseline.records.filter(r => ["course", "study-note"].includes(r.detail.item.kind)); o.baseline.media = []; }, "CONTENT_BASELINE_INVENTORY_MISMATCH");
    assert.equal(rawReads, 0);
  });
  await t.test("missing unreferenced eligible media fails before any raw page reads", async () => {
    rawReads = 0;
    await failure(o => { o.baseline.media.pop(); }, "CONTENT_BASELINE_INVENTORY_MISMATCH"); assert.equal(rawReads, 0);
  });
  await t.test("same page IDs do not prove matching raw body or ownership", async () => {
    await failure(o => { o.baseline.records[2].detail.document!.blocks = []; }, "CONTENT_BASELINE_READER_MISMATCH");
    await failure(o => { o.baseline.records[2].evidence.ordinal++; }, "CONTENT_BASELINE_READER_MISMATCH");
    await failure(o => { o.baseline.records[2].evidence.sourceKey = "books"; }, "CONTENT_BASELINE_READER_MISMATCH");
  });
  await t.test("media IDs do not prove descriptor SHA, bytes or owner", async () => {
    await failure(o => { o.baseline.media[0].byteSize++; }, "CONTENT_BASELINE_READER_MISMATCH");
    await failure(o => { o.baseline.media[0].ownerPageId = f.other.detail.item.id; }, "CONTENT_BASELINE_READER_MISMATCH");
  });
  await t.test("duplicates, missing bodies, unknown owners and budget failures make no reader calls", async () => {
    rawReads = 0; inventoryReads = 0;
    await failure(o => { o.baseline.records.push(o.baseline.records[0]); }, "CONTENT_BASELINE_INVALID");
    await failure(o => { o.baseline.media.push(o.baseline.media[0]); }, "CONTENT_BASELINE_INVALID");
    await failure(o => { o.baseline.records[0].detail.document = null; }, "CONTENT_BASELINE_INVALID");
    await failure(o => { o.baseline.media[0].ownerPageId = studyId(900); }, "CONTENT_BASELINE_INVALID");
    await failure(o => { o.maxReads = 4; }, "CONTENT_BASELINE_BUDGET_EXCEEDED");
    assert.equal(rawReads, 0); assert.equal(inventoryReads, 0);
  });
  await t.test("full-run, scope, schema and epoch must match the accepted private artifact", async () => {
    await failure(o => { o.fullRunId = randomUUID(); }, "CONTENT_BASELINE_SCOPE_MISMATCH");
    await failure(o => { o.baseline.state.configDigest = "0".repeat(64); }, "CONTENT_BASELINE_SCOPE_MISMATCH");
    await failure(o => { o.baseline.state.schemaDigest = "0".repeat(64); }, "CONTENT_BASELINE_SCOPE_MISMATCH");
    await failure(o => { o.baseline.state.policyEpoch = "999"; }, "CONTENT_BASELINE_PUBLICATION_CHANGED");
    await failure(o => { o.baseline.state.publicationRevision = `${fullRunId}:999`; }, "CONTENT_BASELINE_PUBLICATION_CHANGED");
  });
  await t.test("incomplete or duplicated inventory and missing independent proof cannot initialize", async () => {
    for (const alter of [
      (v: Awaited<ReturnType<ContentBaselineReader["inventory"]>>) => { v.readerVerified = false as true; },
      (v: Awaited<ReturnType<ContentBaselineReader["inventory"]>>) => { v.pageIds.push(v.pageIds[0]); },
      (v: Awaited<ReturnType<ContentBaselineReader["inventory"]>>) => { v.mediaIds = []; },
    ]) await failure(o => { o.reader = { ...reader, inventory: async (...args) => { const v = await reader.inventory(...args); alter(v); return v; } }; }, "CONTENT_BASELINE_INVENTORY_MISMATCH");
    await failure(o => { o.reader = { ...reader, read: async () => null }; }, "CONTENT_BASELINE_READER_MISMATCH");
  });
  await t.test("writer credentials cannot substitute for the independent reader", async () => {
    const s = await local(); try {
      await assert.rejects(initializeContentBaseline({ ...s.options, reader: createDatabaseContentBaselineReader(writerSql) }, signal()));
      assert.throws(() => s.store.assertState(state), coded("CONTENT_CACHE_BASELINE_MISSING"));
    } finally { await s.close(); }
  });
  await t.test("changed global version or policy at the final read leaves the store empty", async () => {
    for (const changed of [{ ...state, publicationRevision: `${randomUUID()}:1` }, { ...state, policyEpoch: "9" }]) {
      let calls = 0;
      await failure(o => { o.reader = { ...reader, state: async s => calls++ ? changed : reader.state(s) }; }, "CONTENT_BASELINE_PUBLICATION_CHANGED");
    }
  });
  await t.test("cancellation after a database response cannot install late", async () => {
    const s = await local(), controller = new AbortController(); try {
      const cancelling = { ...reader, read: async (...args: Parameters<ContentBaselineReader["read"]>) => { const v = await reader.read(...args); controller.abort(); return v; } };
      await assert.rejects(initializeContentBaseline({ ...s.options, reader: cancelling }, controller.signal), { name: "AbortError" });
      assert.throws(() => s.store.assertState(state), coded("CONTENT_CACHE_BASELINE_MISSING"));
    } finally { await s.close(); }
  });
  await t.test("the initializer freezes artifacts across asynchronous reads", async () => {
    const s = await local(); try {
      const mutating = { ...reader, read: async (...args: Parameters<ContentBaselineReader["read"]>) => {
        s.options.baseline.records[2].detail.item.title = "Caller changed title";
        s.options.baseline.media[0].byteSize++;
        return reader.read(...args);
      } };
      await initializeContentBaseline({ ...s.options, reader: mutating }, signal());
      assert.deepEqual(s.store.readPublished({ sourceKey: "status", pageKey: f.ordinary.detail.item.id }, state)!.record, f.ordinary);
    } finally { await s.close(); }
  });
  await t.test("actual central withdrawal during proof cannot save a mixed baseline", async () => {
    const s = await local(); try {
      const denying = { ...reader, read: async (...args: Parameters<ContentBaselineReader["read"]>) => {
        const value = await reader.read(...args);
        await db.query("SELECT nb_v2_api.deny_page($1)", [f.ordinary.detail.item.id]); return value;
      } };
      await assert.rejects(initializeContentBaseline({ ...s.options, reader: denying }, signal()));
      assert.throws(() => s.store.assertState(state), coded("CONTENT_CACHE_BASELINE_MISSING"));
    } finally { await s.close(); }
  });
});

import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { WEBSITE_SCHEMA_DIGEST } from "../contracts/website-sync.ts";
import { publicationWriter } from "../src/server/database/publication.ts";
import { readPublicationState } from "../src/server/database/incremental-publication.ts";
import type { SqlExecutor } from "../src/server/database/sql.ts";
import { configDigest } from "../src/server/database/website-validation.ts";
import { parseWebsiteNotionConfig } from "../src/server/notion/website-config.ts";
import type { WebsiteStudyCollection } from "../src/server/notion/website-repository.ts";
import { installPublication } from "../scripts/website-sync/publication-migration.ts";
import { installIncrementalPublication } from "../scripts/website-sync/incremental-migration.ts";
import { installIncrementalReader } from "../scripts/website-sync/incremental-reader-migration.ts";
import { openContentCache } from "../scripts/website-incremental-sync/content-cache.ts";
import { openStudyCheckpoint } from "../scripts/website-incremental-sync/study-checkpoint.ts";
import { createDatabaseContentBaselineReader } from "../scripts/website-incremental-sync/content-baseline.ts";
import { createDatabaseStudyBaselineReader, initializeStudyBaseline } from "../scripts/website-incremental-sync/study-baseline.ts";
import { initializeStudyAndContentBaseline, type SharedStudyBaselineOptions } from "../scripts/website-incremental-sync/study-shared-baseline.ts";
import { cacheFixture } from "./helpers/content-cache.ts";
import { studyId } from "./helpers/study-runtime.ts";

const coded = (code: string) => (error: unknown) => error instanceof Error && "code" in error && error.code === code;
const signal = () => new AbortController().signal;
test("one complete independent reader pass seeds content and study caches", async t => {
  const f = cacheFixture(true), db = await PGlite.create();
  t.after(() => db.close());
  const config = parseWebsiteNotionConfig({ schemaVersion: 2, sources: [
    { key: "courses", kind: "course", enabled: true, dataSourceId: studyId(10), fields: { title: "Name" }, publication: { mode: "all" } },
    { key: "notes", kind: "study-note", enabled: true, dataSourceId: studyId(10), fields: { title: "Name" }, publication: { mode: "course-descendants" } },
    { key: "status", kind: "status", enabled: true, dataSourceId: studyId(11), fields: { title: "Name" }, publication: { mode: "all" } },
  ] });
  const digest = configDigest(config), fullRunId = randomUUID();
  const media = [...f.baseline.media, { ...f.baseline.media[0], ownerPageId: f.other.detail.item.id,
    assetId: `a1.${"d".repeat(64)}`, sha256: "e".repeat(64), objectKey: `sha256/${"e".repeat(64)}` }];
  const collection: WebsiteStudyCollection = { records: f.baseline.records, baseline: {
    format: "study-baseline-v1", sourceDigest: digest, sourceKeys: ["courses", "notes"], entries: f.checkpoint.entries,
    deniedDigest: configDigest([]), recordsDigest: configDigest(f.baseline.records), entriesDigest: configDigest(f.checkpoint.entries),
  } };
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
    if (sql.includes("nb_publication_api.read_snapshot")) inventoryReads++;
    return tx.query<T>(sql, values);
  }) });
  const readerSql = role("nb_reader"), writerSql = role("nb_writer");
  const policy = config.sources.map(s => ({ key: s.key, kind: s.kind, mode: s.publication.mode,
    dataSourceId: s.dataSourceId, databaseParentId: null, pageId: null }));
  await db.query("SELECT nb_v2_api.configure_policy($1,600,$2::jsonb,'[]')", [digest, JSON.stringify(policy)]);
  const full = publicationWriter(writerSql, "published"), lease = await full.begin(fullRunId, digest);
  await full.stage(lease, collection.records, media);
  await full.promote(lease, { records: collection.records.length, media: media.length, complete: true });
  const state = await readPublicationState(readerSql);
  const reader = createDatabaseContentBaselineReader(readerSql);
  async function local() {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "study-shared-baseline-")));
    const contentStore = await openContentCache(directory, digest, f.sourceKeys);
    const studyStore = await openStudyCheckpoint(directory, digest);
    const options: SharedStudyBaselineOptions = { collection: structuredClone(collection), config: structuredClone(config),
      deniedPageIds: new Set(), studyStore, content: { fullRunId, store: contentStore, reader,
        baseline: { state: structuredClone(state), records: structuredClone(collection.records), media: structuredClone(media) } } };
    return { directory, contentStore, studyStore, options, close: async () => {
      studyStore.close(); contentStore.close(); await rm(directory, { recursive: true, force: true });
    } };
  }
  async function failure(change: (o: SharedStudyBaselineOptions) => void, code: string) {
    const s = await local(); try {
      change(s.options);
      await assert.rejects(initializeStudyAndContentBaseline(s.options, signal()), coded(code));
      assert.throws(() => s.studyStore.load(), coded("STUDY_CHECKPOINT_MISSING"));
      assert.throws(() => s.contentStore.assertState(state), coded("CONTENT_CACHE_BASELINE_MISSING"));
    } finally { await s.close(); }
  }
  await t.test("all four raw pages and both eligible assets initialize two restartable caches with no second page pass", async () => {
    const s = await local(); try {
      rawReads = 0; inventoryReads = 0;
      const result = await initializeStudyAndContentBaseline(s.options, signal());
      assert.equal(result.databasePageReads, 4); assert.equal(rawReads, 4); assert.equal(inventoryReads, 1);
      assert.equal(result.content.media, 2);
      assert.deepEqual(result.study, { publicationRevision: state.publicationRevision, courses: 1, pages: 1, reusedPageReads: 2 });
      const content = await openContentCache(s.directory, digest, f.sourceKeys);
      const study = await openStudyCheckpoint(s.directory, digest);
      try {
        assert.deepEqual(study.load().entries, collection.baseline.entries);
        assert.deepEqual(content.readPublished({ sourceKey: "status", pageKey: f.other.detail.item.id }, state)!.media, [media[1]]);
      } finally { study.close(); content.close(); }
      await assert.rejects(initializeStudyAndContentBaseline(s.options, signal()), coded("CONTENT_CACHE_ALREADY_INITIALIZED"));
      assert.deepEqual(s.studyStore.load().entries, collection.baseline.entries);
    } finally { await s.close(); }
  });
  await t.test("mismatched full artifacts and corrupt ordering companions fail before SQL", async () => {
    rawReads = 0; inventoryReads = 0;
    await failure(o => { o.content.baseline.records[0].detail.item.title = "Another full collection"; }, "STUDY_BASELINE_SCOPE_MISMATCH");
    await failure(o => { o.collection.baseline.entries[0].override = 42; }, "STUDY_BASELINE_INVALID");
    assert.equal(rawReads, 0); assert.equal(inventoryReads, 0);
  });
  await t.test("a self-consistent learning subset still cannot replace the complete independent inventory", async () => {
    await failure(o => {
      o.collection.records = o.collection.records.filter(r => r.detail.item.kind !== "status");
      o.collection.baseline.recordsDigest = configDigest(o.collection.records);
      o.content.baseline.records = structuredClone(o.collection.records); o.content.baseline.media = [];
    }, "CONTENT_BASELINE_INVENTORY_MISMATCH");
  });
  await t.test("the full read budget and nonlearning raw-record proof remain mandatory", async () => {
    await failure(o => { o.content.maxReads = 3; }, "CONTENT_BASELINE_BUDGET_EXCEEDED");
    await failure(o => { o.content.reader = { ...reader, read: async (input, s) => {
      const actual = await reader.read(input, s);
      if (actual && input.sourceKey === "status") actual.record.detail.document!.blocks = [];
      return actual;
    } }; }, "CONTENT_BASELINE_READER_MISMATCH");
  });
  await t.test("owned media mismatch cannot unlock reuse of otherwise correct learning records", async () => {
    await failure(o => { o.content.baseline.media[1].byteSize++; }, "CONTENT_BASELINE_READER_MISMATCH");
  });
  await t.test("a policy change after content install leaves study empty and preserves the proven content cache", async () => {
    const s = await local(); try {
      let calls = 0;
      s.options.content.reader = { ...reader, state: async abort => {
        const current = await reader.state(abort);
        return ++calls >= 3 ? { ...current, policyEpoch: String(Number(current.policyEpoch) + 1) } : current;
      } };
      await assert.rejects(initializeStudyAndContentBaseline(s.options, signal()), coded("STUDY_BASELINE_PUBLICATION_CHANGED"));
      s.contentStore.assertState(state);
      assert.throws(() => s.studyStore.load(), coded("STUDY_CHECKPOINT_MISSING"));
    } finally { await s.close(); }
  });
  await t.test("cancellation after one local install resumes only the missing study cache with its existing initializer", async () => {
    const s = await local(); try {
      const controller = new AbortController(); let calls = 0;
      s.options.content.reader = { ...reader, state: async abort => {
        const current = await reader.state(abort); if (++calls === 3) controller.abort(); return current;
      } };
      await assert.rejects(initializeStudyAndContentBaseline(s.options, controller.signal), { name: "AbortError" });
      s.contentStore.assertState(state);
      assert.throws(() => s.studyStore.load(), coded("STUDY_CHECKPOINT_MISSING"));
      rawReads = 0;
      await initializeStudyBaseline({ collection, config, deniedPageIds: new Set(), fullRunId,
        store: s.studyStore, reader: createDatabaseStudyBaselineReader(readerSql) }, signal());
      assert.equal(rawReads, 2);
      assert.deepEqual(s.studyStore.load().entries, collection.baseline.entries);
      s.contentStore.assertState(state);
    } finally { await s.close(); }
  });
  await t.test("caller mutation across reader awaits cannot change either pinned artifact", async () => {
    const s = await local(); try {
      s.options.content.reader = { ...reader, state: async abort => {
        s.options.collection.baseline.entries[0].override = 99;
        s.options.content.baseline.records[0].detail.item.title = "Caller changed";
        s.options.config.sources[0].fields = { title: "Other" };
        return reader.state(abort);
      } };
      await initializeStudyAndContentBaseline(s.options, signal());
      assert.deepEqual(s.studyStore.load().entries, collection.baseline.entries);
      assert.deepEqual(s.contentStore.readPublished({ sourceKey: "courses", pageKey: studyId(1) }, state)!.record, collection.records[0]);
    } finally { await s.close(); }
  });
  await t.test("an actual writer connection cannot supply the independent-reader pass", async () => {
    const s = await local(); try {
      s.options.content.reader = createDatabaseContentBaselineReader(writerSql);
      await assert.rejects(initializeStudyAndContentBaseline(s.options, signal()));
      assert.throws(() => s.studyStore.load(), coded("STUDY_CHECKPOINT_MISSING"));
      assert.throws(() => s.contentStore.assertState(state), coded("CONTENT_CACHE_BASELINE_MISSING"));
    } finally { await s.close(); }
  });
});

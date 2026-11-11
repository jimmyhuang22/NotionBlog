import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { fixtureItems } from "../fixtures/content.ts";
import { CONTENT_KINDS, defaultContentFeatures, type ContentFeatures } from "../config/features.ts";
import { WEBSITE_SCHEMA_DIGEST, type WebsiteRecord } from "../contracts/website-sync.ts";
import type { StoredMedia } from "../contracts/sync.ts";
import type { ContentRepository } from "../contracts/repository.ts";
import { createContentService, createFeatureGatedRepository } from "../src/lib/content/factory.ts";
import { readLibraryFirstPageFrom } from "../src/lib/content/library-page.ts";
import { createLibraryPageReader, readLibraryPageMode, LIBRARY_SELECTED_SQL } from "../src/server/database/library-page.ts";
import { createLibraryDisplayPreparation } from "../src/server/database/library-display.ts";
import { createWebsiteDatabaseRepository } from "../src/server/database/website-repository.ts";
import { createWebsiteWriter } from "../src/server/database/website-writer.ts";
import { configDigest, mediaIdentity } from "../src/server/database/website-validation.ts";
import { scopedReader } from "../src/server/database/scoped-reads.ts";
import type { SqlExecutor } from "../src/server/database/sql.ts";
import { databaseDisplayProjectionSql } from "../src/server/media/display.ts";
import { displayProjectionSql } from "../src/server/self-hosted-media/projection.ts";
import { withContentReadBudget } from "../src/server/content-read-budget.ts";
import scoped from "../database/scoped-read-protocol.json" with { type: "json" };
import publication from "../database/publication-protocol.json" with { type: "json" };
import protocol from "../database/library-page-protocol.json" with { type: "json" };
const all = Object.fromEntries(CONTENT_KINDS.map(kind => [kind, true])) as ContentFeatures;
const failYears = () => { throw Error("optional year computation failed"); };

async function setup() {
  const db = await PGlite.create();
  await db.exec("CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS; ALTER DEFAULT PRIVILEGES GRANT EXECUTE ON FUNCTIONS TO anon,authenticated,service_role;");
  for (const path of ["database/migrations/001_content.sql", "database/website-migrations/001_website.sql",
    ...[publication.migration, scoped.migration, scoped.searchMigration, scoped.traversalMigration, protocol.migration].map(m => "supabase/migrations/" + m.file)])
    await db.exec(await readFile(new URL("../" + path, import.meta.url), "utf8"));
  assert.equal(createHash("sha256").update(await readFile(new URL("../supabase/migrations/" + protocol.migration.file, import.meta.url))).digest("hex"), protocol.migration.sha256);
  await db.query("UPDATE nb_v2.state SET schema_digest=$1", [WEBSITE_SCHEMA_DIGEST]);
  await db.query("UPDATE nb_publication.state SET migration_digest=$1", [publication.migration.sha256]);
  for (const [i, p] of [scoped.migration, scoped.searchMigration, scoped.traversalMigration].entries())
    await db.query("UPDATE nb_read.migrations SET digest=$1 WHERE version=$2", [p.sha256, i + 1]);
  await db.query("UPDATE nb_library.state SET migration_digest=$1", [protocol.migration.sha256]);
  const role = (name: string): SqlExecutor => ({ query: <T>(sql: string, values?: unknown[]) => db.transaction(async tx => {
    await tx.exec(`SET LOCAL ROLE ${name}`); return tx.query<T>(sql, values);
  }) });
  const reader = role("nb_reader"), writer = createWebsiteWriter(role("nb_writer"));
  const sources = ["movie", "book", "game"].map(kind => ({ key: kind, kind, mode: "all", dataSourceId: "synthetic-" + kind, databaseParentId: null, pageId: null }));
  const digest = configDigest(sources);
  await db.query("SELECT nb_v2_api.configure_policy($1,600,$2::jsonb,'[]')", [digest, JSON.stringify(sources)]);
  const records: WebsiteRecord[] = [];
  for (const kind of ["movie", "book", "game"] as const) for (let i = 0; i < 9; i++) {
    const id = `${kind}-${i}`;
    records.push({ detail: { item: { ...structuredClone(fixtureItems[kind][0]), id, slug: id, title: `Title ${i % 3}`, href: `/library/${kind}s/${id}`, cover: null },
      document: { toc: [], completeness: "complete", blocks: [{ id: "body", type: "paragraph", text: [{ text: "SYNTHETIC_BODY_EXCLUDED" }] }] } },
    evidence: { sourceKey: kind, dataSourceId: "synthetic-" + kind, databaseParentId: null, courseId: null, parentId: null, ordinal: i } });
  }
  const sha256 = "b".repeat(64), assetId = mediaIdentity("movie-0", "cover", sha256);
  const media: StoredMedia = { assetId, ownerPageId: "movie-0", sha256, objectKey: "sha256/" + sha256, mime: "image/png", byteSize: 23, width: 1, height: 1 };
  records[0].detail.item.cover = { id: assetId, src: "/media/v2/" + assetId, alt: "Synthetic cover", width: 1, height: 1 };
  const lease = await writer.begin(randomUUID(), digest);
  await writer.stage(lease, records, [media]); await writer.promote(lease, { records: records.length, media: 1, complete: true });
  await role("nb_writer").query("SELECT nb_publication_api.activate($1)", [lease.runId]);
  const repo = (mode: "qualified" | "published" = "qualified", sql = reader) => createWebsiteDatabaseRepository(scopedReader(sql, mode), { scoped: true });
  return { db, role, reader, records, media, lease, repo };
}

test("live library SSR: permissions, cursor/year equivalence, display barrier and fail-closed protocol", async () => {
  const h = await setup();
  try {
    for (const mode of ["qualified", "published"] as const) for (const kind of ["movie", "book", "game"] as const)
      for (const order of ["title-asc", "date-desc", "date-asc"] as const) for (const year of [undefined, 2026, 9999, "undated"] as const) {
        const q = { limit: 3, order, ...(year === undefined ? {} : { year }) }, base = h.repo(mode);
        for (const failure of [false, true]) {
          if (failure) base.getLibraryYears = async () => failYears();
          const read = createLibraryPageReader(h.reader, { mode, ...(failure ? { computeYears: failYears } : {}) });
          const result = await read(kind, q), old = await readLibraryFirstPageFrom(base, base, kind, q);
          assert.deepEqual(result, old);
          if (result.page.nextCursor) {
            const next = { ...q, cursor: result.page.nextCursor, ...(result.year === null ? { year: undefined } : { year: result.year }) };
            assert.deepEqual((await read(kind, next)).page, await base.list(kind, next));
          }
          assert.ok(!JSON.stringify(result).includes("SYNTHETIC_BODY_EXCLUDED"));
        }
      }
    const read = createLibraryPageReader(h.reader, { mode: "qualified" });
    const service = createContentService({ provider: "database", features: all, databaseRepository: { ...h.repo(), readLibraryPage: read } }).repository;
    assert.deepEqual(await readLibraryFirstPageFrom(service, h.repo(), "movie"), await read("movie"));
    let calls = 0;
    const counted: SqlExecutor = { query: (sql, values) => { calls++; return h.reader.query(sql, values); } };
    const live = { ...h.repo(), readLibraryPage: createLibraryPageReader(counted, { mode: "qualified" }) };
    const disabled = createFeatureGatedRepository(live, defaultContentFeatures);
    assert.equal((await readLibraryFirstPageFrom(disabled, disabled, "movie")).page.total, 0); assert.equal(calls, 0);
    await assert.rejects(readLibraryFirstPageFrom(disabled, disabled, "movie", { year: 0 }), { code: "INVALID_QUERY" });
    await readLibraryFirstPageFrom(live, h.repo(), "movie"); await readLibraryFirstPageFrom(live, h.repo(), "movie"); assert.equal(calls, 4);
    await assert.rejects(readLibraryFirstPageFrom({ ...live, readLibraryPage: async () => { throw Error("final check failed"); } },
      { ...h.repo(), list: async () => assert.fail("must not fall back") }, "movie"), /final check failed/);
    for (const name of ["anon", "authenticated", "service_role", "nb_writer"]) {
      await assert.rejects(h.role(name).query("SELECT nb_library_api.read_selectors($1,$2,$3)", ["qualified", "movie", protocol.migration.sha256]));
    }
    await assert.rejects(h.reader.query("SELECT nb_library.selector('{}')"));
    await assert.rejects(h.reader.query("SELECT * FROM nb_library.state"));
    await h.db.exec("UPDATE nb_library.state SET migration_digest=NULL");
    await assert.rejects(read("movie"), { code: "CONTENT_UNAVAILABLE" });
    await h.db.query("UPDATE nb_library.state SET migration_digest=$1", [protocol.migration.sha256]);
    const store = { manifest: async () => ({ assets: [{ assetId: h.media.assetId, base: { width: 1, height: 1 } }] }) };
    const local = createLibraryDisplayPreparation(db => displayProjectionSql(db, store as unknown as Parameters<typeof displayProjectionSql>[1]));
    const asset = { assetId: h.media.assetId, ownerPageId: h.media.ownerPageId, sourceSha256: h.media.sha256, sourceFingerprint: "c".repeat(64),
      base: { sha256: "d".repeat(64), byteSize: 123, mime: "image/webp", width: 1, height: 1 }, variants: {} };
    let mappings = 0;
    const mapping: SqlExecutor = { async query<T>(sql: string, values?: unknown[]) {
      mappings++; assert.equal(sql, "SELECT nb_display_api.read_assets($1,$2::text[],$3,$4) AS result");
      assert.deepEqual(values?.slice(0, 3), [h.lease.runId, [h.media.assetId], "qualified"]);
      const revision = (await h.db.query<{ revision: string }>("SELECT revision::text FROM nb_v2.state")).rows[0].revision;
      return { rows: [{ result: { runId: h.lease.runId, revision, assets: [asset] } }] as T[] };
    } };
    const cloud = createLibraryDisplayPreparation(db => databaseDisplayProjectionSql(db, mapping, "qualified"));
    calls = 0;
    const cloudResult = await createLibraryPageReader(counted, { mode: "qualified", prepareDelivery: cloud })("movie", { limit: 3, order: "title-asc" });
    assert.equal(calls, 3); assert.equal(mappings, 1); assert.equal(cloudResult.page.items[0].cover?.delivery?.mode, "display-only");
    for (const prepare of [local, cloud]) {
      for (const failure of [false, true]) {
        const run = createLibraryPageReader(h.reader, { mode: "qualified", ...(failure ? { computeYears: failYears } : {}), prepareDelivery: async p => {
          const hints = await prepare(p); await h.db.query("SELECT nb_v2_api.set_denied($1,true)", ["movie-0"]); return hints;
        } });
        await assert.rejects(run("movie", { limit: 3, order: "title-asc" }), { code: "INVALID_QUERY" });
        await h.db.query("SELECT nb_v2_api.set_denied($1,false)", ["movie-0"]);
      }
    }
    const removed = await createLibraryPageReader(h.reader, { mode: "qualified", prepareDelivery: async p => {
      const hints = await local(p); await h.db.query("DELETE FROM nb_v2.media WHERE run_id=$1", [h.lease.runId]); return hints;
    } })("movie", { limit: 3, order: "title-asc" });
    assert.equal(removed.page.items[0].cover, null);
    // Empty failed-year pages still run their final authorization; SQL failures cannot degrade.
    let selected = 0;
    const broken: SqlExecutor = { query: (sql, values) => { if (sql === LIBRARY_SELECTED_SQL) { selected++; throw Error("final SQL failed"); } return h.reader.query(sql, values); } };
    await assert.rejects(createLibraryPageReader(broken, { mode: "qualified", computeYears: failYears })("movie", { year: 9999 }), { code: "CONTENT_UNAVAILABLE" }); assert.equal(selected, 1);
    const abort = new AbortController();
    await assert.rejects(withContentReadBudget(abort.signal, () => createLibraryPageReader(h.reader, { mode: "qualified", computeYears: () => { abort.abort(); return failYears(); } })("movie")), { code: "CONTENT_UNAVAILABLE" });
  } finally { await h.db.close(); }
});

test("library opt-in and SSR entry stay independent of completed DTO caching", async () => {
  assert.equal(readLibraryPageMode(undefined), false); assert.equal(readLibraryPageMode("legacy"), false); assert.equal(readLibraryPageMode("compact"), true);
  assert.throws(() => readLibraryPageMode("on"), { code: "MISCONFIGURED" });
  const index = await readFile(new URL("../src/lib/content/index.ts", import.meta.url), "utf8");
  assert.ok(!index.slice(index.indexOf("const uncachedRepository"), index.indexOf("/** Full eligible timeline")).includes("readLibraryPage"));
  const page = await readFile(new URL("../src/app/library/[type]/page.tsx", import.meta.url), "utf8");
  assert.ok(page.includes("await readLibraryFirstPage(section.kind"));
  const noRead = { list: async () => assert.fail("invalid query must be rejected first") } as unknown as ContentRepository;
  await assert.rejects(readLibraryFirstPageFrom(noRead, noRead, "movie", { limit: 0 }), { code: "INVALID_QUERY" });
});

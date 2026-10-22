import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fixtureItems } from "../fixtures/content.ts";
import type { AnyContent, StudyNote } from "../contracts/content.ts";
import type { WebsiteRecord } from "../contracts/website-sync.ts";
import { defaultContentFeatures } from "../config/features.ts";
import { createMockRepository } from "../adapters/mock-repository.ts";
import { searchRepository, searchContentSnapshot } from "../src/lib/content/website.ts";
import { contextFromItems, makeSearchContext } from "../src/lib/content/search-context.ts";
import { readSearchContextMode, readSearchContexts, SEARCH_CONTEXT_SQL } from "../src/server/database/search-context.ts";
import { scopedReader } from "../src/server/database/scoped-reads.ts";
import { publicationReader } from "../src/server/database/publication.ts";
import { createWebsiteDatabaseRepository } from "../src/server/database/website-repository.ts";
import { configDigest } from "../src/server/database/website-validation.ts";
import type { SqlExecutor } from "../src/server/database/sql.ts";
import { setupSearchProjection, body } from "./helpers/search-precomputed.ts";
import protocol from "../database/search-context-protocol.json" with { type: "json" };
import filtered from "../database/search-filtered-protocol.json" with { type: "json" };

function rows(): WebsiteRecord[] {
  const course = { ...structuredClone(fixtureItems.course[0]), cover: null, code: "SYN101", title: "Synthetic owner" };
  const result: WebsiteRecord[] = [{ detail: { item: course, document: body("owner") }, evidence: {
    sourceKey: "courses", dataSourceId: "context-courses", databaseParentId: null, courseId: null, parentId: null, ordinal: 0,
  } }];
  for (const [id, parentId, title] of [["context-root", course.id, "Week 4"], ["context-parent", "context-root", "Activity"], ["context-child", "context-parent", "Introduction"], ["context-direct", course.id, "Introduction"]]) {
    const item: StudyNote = { ...structuredClone(fixtureItems["study-note"][0]), id, slug: id, href: `/study/${course.id}/notes/${id}`,
      title, cover: null, courseId: course.id, parentId: parentId === course.id ? null : parentId, breadcrumbs: [], summary: null };
    result.push({ detail: { item, document: body("needle") }, evidence: { sourceKey: "notes", dataSourceId: "context-notes", databaseParentId: course.id,
      courseId: course.id, parentId, ordinal: result.length } });
  }
  return result;
}
async function setup(install = true) {
  const f = await setupSearchProjection();
  if (install) {
    const bytes = await readFile(new URL("../supabase/migrations/" + protocol.migration.file, import.meta.url));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), protocol.migration.sha256);
    await f.db.exec(bytes.toString());
  }
  await f.db.exec(await readFile(new URL("../supabase/migrations/" + filtered.migration.file, import.meta.url), "utf8"));
  await f.db.query("UPDATE nb_read.migrations SET digest=$1 WHERE version=4", [filtered.migration.sha256]);
  const publish = async (records = rows()) => {
    const sources = [{ key: "courses", kind: "course", mode: "allowlist", dataSourceId: "context-courses", databaseParentId: null, pageId: null },
      { key: "notes", kind: "study-note", mode: "allowlist", dataSourceId: "context-notes", databaseParentId: records[0].detail.item.id, pageId: null }];
    const permits = records.map(row => ({ id: row.detail.item.id, kind: row.detail.item.kind, sourceKey: row.evidence.sourceKey, courseId: row.evidence.courseId, parentId: row.evidence.parentId }));
    const digest = configDigest([sources, permits]);
    await f.db.query("SELECT nb_v2_api.configure_policy($1,600,$2::jsonb,$3::jsonb)", [digest, JSON.stringify(sources), JSON.stringify(permits)]);
    const lease = await f.writer.begin(randomUUID(), digest);
    await f.writer.stage(lease, records); await f.writer.promote(lease, { records: records.length, media: 0, complete: true });
    await f.db.query("SELECT nb_publication_api.activate($1)", [lease.runId]);
    await f.register(); await f.fill(lease.runId);
    return lease;
  };
  const registerContext = () => f.db.query("UPDATE nb_search_context.state SET migration_digest=$1", [protocol.migration.sha256]);
  const repo = (mode: "qualified" | "published", projection: "legacy" | "on-demand" | "filtered" | "precomputed", on = true, sql = f.reader) =>
    createWebsiteDatabaseRepository(projection === "legacy" ? publicationReader(sql, mode) : scopedReader(sql, mode, projection),
      { scoped: projection !== "legacy", filteredSearch: projection === "filtered", searchContext: on });
  return { ...f, publish, registerContext, repo };
}

test("context follows physical identity, preserves all levels and bounds unknown or oversized metadata", () => {
  const records = rows(), map = new Map(records.map(r => [r.detail.item.id, r.detail.item] as [string, AnyContent]));
  const note = records[3].detail.item as StudyNote;
  assert.deepEqual(contextFromItems(note, map), { courseLabel: "SYN101", parentLabels: ["Week 4", "Activity"] });
  map.delete("context-parent"); assert.equal(contextFromItems(note, map), null);
  map.set("context-parent", { ...note, id: "context-parent", parentId: note.id }); assert.equal(contextFromItems(note, map), null);
  assert.deepEqual(makeSearchContext("course-id", "Actual course", [], "course-id"), { courseLabel: "Actual course", parentLabels: [] });
  for (const parents of [Array(33).fill("x"), ["x".repeat(257)], [""], ["bad\nlabel"], Array(32).fill("x".repeat(256))])
    assert.equal(makeSearchContext("SYN101", null, parents), null);
  assert.equal(makeSearchContext(null, null, []), null);
  assert.equal(readSearchContextMode(undefined), false); assert.equal(readSearchContextMode("off"), false); assert.equal(readSearchContextMode("on"), true);
  assert.throws(() => readSearchContextMode("yes"), { code: "MISCONFIGURED" });
});

test("mock distinguishes same-title courses and parents without changing matching, rank or feature gates", async () => {
  const repository = createMockRepository(), query = { q: "Introduction", kinds: ["study-note" as const], limit: 1 };
  const first = await searchRepository(repository, defaultContentFeatures, query);
  assert.equal(first.total, 3); assert(first.nextCursor); assert(first.items[0].context);
  const all = await searchRepository(repository, defaultContentFeatures, { ...query, limit: 12 });
  assert.equal(new Set(all.items.map(hit => JSON.stringify(hit.context))).size, 3);
  const snapshot = await repository.readSearchSnapshot!(["study-note"]);
  const before = searchContentSnapshot({ ...snapshot, searchContexts: undefined }, { ...query, limit: 12 }, ["study-note"]);
  assert.deepEqual(all.items.map(({ context: _context, ...hit }) => hit), before.items);
  assert.equal((await searchRepository(repository, defaultContentFeatures, { ...query, q: "DEMO101" })).total, 0, "Display context is not a new search field");
  assert((await searchRepository(repository, { ...defaultContentFeatures, course: false }, query)).items.every(hit => hit.context == null));
  assert.equal((await searchRepository(repository, { ...defaultContentFeatures, "study-note": false }, query)).total, 0);
});

test("database context works for both publication modes and all search projections with one metadata batch per page", async () => {
  const f = await setup();
  try {
    await f.publish(); await f.registerContext();
    for (const mode of ["qualified", "published"] as const) for (const projection of ["legacy", "on-demand", "filtered", "precomputed"] as const) {
      const calls: string[] = [], observed: SqlExecutor = { async query<T>(sql: string, values?: unknown[]) { calls.push(sql); return f.reader.query<T>(sql, values); } };
      const before = await f.repo(mode, projection, false, observed).search!({ q: "Introduction", limit: 1 });
      const previousDetailReads = calls.filter(sql => sql.includes("read_content(")).length; calls.length = 0;
      const after = await f.repo(mode, projection, true, observed).search!({ q: "Introduction", limit: 1 });
      assert.equal(after.total, before.total); assert.deepEqual(after.items.map(({ context: _context, ...hit }) => hit), before.items);
      assert.equal(calls.filter(sql => sql.includes("read_context(")).length, 1);
      assert.equal(calls.filter(sql => sql.includes("read_content(")).length, previousDetailReads, "No added per-result detail fetch");
      assert.deepEqual(after.items[0].context, { courseLabel: "SYN101", parentLabels: ["Week 4", "Activity"] });
      const next = await f.repo(mode, projection).search!({ q: "Introduction", limit: 1, cursor: after.nextCursor! });
      assert.deepEqual(next.items[0].context, { courseLabel: "SYN101", parentLabels: [] });
      await assert.rejects(f.repo(mode, projection).search!({ q: "Introduction", limit: 1, cursor: before.nextCursor! }), { code: "INVALID_QUERY" });
      assert.equal((await f.repo(mode, projection).search!({ q: "SYN101", kinds: ["study-note"] })).total, 0);
    }
    for (const role of ["nb_writer", "anon", "authenticated", "service_role"])
      await assert.rejects(f.role(role).query("SELECT nb_search_context_api.read_context('qualified','{}',NULL,NULL,NULL)"), /permission denied/);
    await assert.rejects(f.reader.query("SELECT * FROM nb_search_context.state"), /permission denied/);
    await assert.rejects(f.reader.query("SELECT * FROM nb_v2.records"), /permission denied/);
    const security = (await f.db.query<{ proconfig: string[]; prosecdef: boolean }>("SELECT proconfig,prosecdef FROM pg_proc WHERE proname='read_context' AND pronamespace='nb_search_context_api'::regnamespace")).rows[0];
    assert(security.prosecdef); assert.deepEqual(security.proconfig, ["search_path=pg_catalog"]);
  } finally { await f.db.close(); }
});

test("default-off needs no context installation; explicit activation preserves missing migration and digest failures", async () => {
  const f = await setup(false);
  try {
    await f.publish();
    assert.equal((await f.repo("published", "on-demand", false).search!({ q: "Introduction" })).total, 2);
    await assert.rejects(f.repo("published", "on-demand").search!({ q: "Introduction" }), { code: "CONTENT_UNAVAILABLE" });
    await f.db.exec(await readFile(new URL("../supabase/migrations/" + protocol.migration.file, import.meta.url), "utf8"));
    await assert.rejects(f.repo("published", "on-demand").search!({ q: "Introduction" }), { code: "CONTENT_UNAVAILABLE" });
    await f.registerContext(); assert.equal((await f.repo("published", "on-demand").search!({ q: "Introduction" })).items.length, 2);
    const malformed = rows(); malformed[0].detail.item.title = "Actual course";
    if (malformed[0].detail.item.kind === "course") malformed[0].detail.item.code = malformed[0].detail.item.id;
    await f.publish(malformed);
    assert.equal((await f.repo("published", "legacy").search!({ q: "Introduction" })).items[0].context?.courseLabel, "Actual course");
  } finally { await f.db.close(); }
});

test("current qualification, renames and version races cannot retain stale course or parent labels", async () => {
  const f = await setup();
  try {
    await f.publish(); await f.registerContext();
    const query = { q: "Introduction", limit: 1 }, old = await f.repo("published", "on-demand").search!(query);
    for (const ancestor of ["context-parent", rows()[0].detail.item.id]) {
      await f.db.query("SELECT nb_v2_api.set_denied($1,true)", [ancestor]);
      for (const mode of ["qualified", "published"] as const) {
        const hits = await f.repo(mode, "on-demand").search!({ q: "Introduction" });
        assert.equal(hits.items.some(hit => hit.id === "context-child"), false);
      }
      await f.db.query("SELECT nb_v2_api.set_denied($1,false)", [ancestor]);
    }
    const renamed = rows(); renamed[1].detail.item.title = "Updated week"; await f.publish(renamed);
    await assert.rejects(f.repo("published", "on-demand").search!({ ...query, cursor: old.nextCursor! }), { code: "INVALID_QUERY" });
    assert.equal((await f.repo("published", "on-demand").search!(query)).items[0].context?.parentLabels[0], "Updated week");
    const moved = rows(); moved[3].evidence.parentId = "context-root";
    if (moved[3].detail.item.kind === "study-note") moved[3].detail.item.parentId = "context-root";
    await f.publish(moved);
    assert.deepEqual((await f.repo("published", "on-demand").search!(query)).items[0].context?.parentLabels, ["Week 4"]);
    let changed = false;
    const racing: SqlExecutor = { async query<T>(sql: string, values?: unknown[]) {
      const reply = await f.reader.query<T>(sql, values);
      if (!changed && sql.includes("read_context(")) { changed = true; await f.db.query("SELECT nb_v2_api.set_denied('context-root',true)"); }
      return reply;
    } };
    await assert.rejects(f.repo("published", "on-demand", true, racing).search!(query), { code: "INVALID_QUERY" });
  } finally { await f.db.close(); }
});

test("context transport rejects foreign, duplicate, missing and mixed-version rows without falling back", async () => {
  const pin = { runId: randomUUID(), revision: "1" };
  const { WEBSITE_SCHEMA_DIGEST } = await import("../contracts/website-sync.ts");
  const base = { ...pin, schemaDigest: WEBSITE_SCHEMA_DIGEST, contexts: [{ id: "n", context: { courseLabel: "SYN101", parentLabels: [] } }] };
  const db = (result: unknown): SqlExecutor => ({ async query<T>(sql: string) { assert.equal(sql, SEARCH_CONTEXT_SQL); return { rows: [{ result }] as T[] }; } });
  for (const contexts of [[{ id: "foreign", context: null }], [...base.contexts, ...base.contexts], [{ id: "n", context: { ...base.contexts[0].context, sourceId: "no" } }]])
    await assert.rejects(readSearchContexts(db({ ...base, contexts }), ["n"], pin), { code: "CONTENT_UNAVAILABLE" });
  await assert.rejects(readSearchContexts(db({ ...base, contexts: [] }), ["n"], pin), { code: "INVALID_QUERY" });
  await assert.rejects(readSearchContexts(db({ ...base, revision: "2" }), ["n"], pin), { code: "INVALID_QUERY" });
  assert.equal((await readSearchContexts(db({ ...base, contexts: [{ id: "n", context: null }] }), ["n"], pin)).get("n"), null);
});

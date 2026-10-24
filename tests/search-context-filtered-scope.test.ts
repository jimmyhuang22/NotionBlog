import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { StudyNote } from "../contracts/content.ts";
import type { WebsiteRecord } from "../contracts/website-sync.ts";
import { fixtureItems } from "../fixtures/content.ts";
import { createWebsiteDatabaseRepository } from "../src/server/database/website-repository.ts";
import { scopedReader } from "../src/server/database/scoped-reads.ts";
import { configDigest } from "../src/server/database/website-validation.ts";
import type { SqlExecutor } from "../src/server/database/sql.ts";
import { setupSearchProjection, body } from "./helpers/search-precomputed.ts";
import context from "../database/search-context-protocol.json" with { type: "json" };
import scope from "../database/search-filtered-scope-protocol.json" with { type: "json" };

const modes = ["qualified", "published"] as const;
async function setup() {
  // Neither the old filtered nor precomputed extension is installed.
  const f = await setupSearchProjection(false);
  const course = { ...structuredClone(fixtureItems.course[0]), cover: null, code: "SYN201", title: "Synthetic owner" };
  const records: WebsiteRecord[] = [{ detail: { item: course, document: body("owner") }, evidence: {
    sourceKey: "courses", dataSourceId: "composed-courses", databaseParentId: null, courseId: null, parentId: null, ordinal: 0,
  } }];
  for (const [id, parentId, title] of [["composed-parent", course.id, "Week"], ["composed-child", "composed-parent", "Introduction"], ["composed-direct", course.id, "Introduction"]]) {
    const item: StudyNote = { ...structuredClone(fixtureItems["study-note"][0]), id, slug: id,
      href: `/study/${course.id}/notes/${id}`, title, cover: null, courseId: course.id,
      parentId: parentId === course.id ? null : parentId, breadcrumbs: [], summary: null };
    records.push({ detail: { item, document: body("needle") }, evidence: { sourceKey: "notes", dataSourceId: "composed-notes",
      databaseParentId: course.id, courseId: course.id, parentId, ordinal: records.length } });
  }
  const sources = [{ key: "courses", kind: "course", mode: "allowlist", dataSourceId: "composed-courses", databaseParentId: null, pageId: null },
    { key: "notes", kind: "study-note", mode: "allowlist", dataSourceId: "composed-notes", databaseParentId: course.id, pageId: null }];
  const permits = records.map(row => ({ id: row.detail.item.id, kind: row.detail.item.kind, sourceKey: row.evidence.sourceKey,
    courseId: row.evidence.courseId, parentId: row.evidence.parentId }));
  const digest = configDigest([sources, permits]);
  await f.db.query("SELECT nb_v2_api.configure_policy($1,600,$2::jsonb,$3::jsonb)", [digest, JSON.stringify(sources), JSON.stringify(permits)]);
  const lease = await f.writer.begin(randomUUID(), digest);
  await f.writer.stage(lease, records); await f.writer.promote(lease, { records: records.length, media: 0, complete: true });
  await f.db.query("SELECT nb_publication_api.activate($1)", [lease.runId]);
  const install = async (protocol: typeof context | typeof scope) => {
    const bytes = await readFile(new URL("../supabase/migrations/" + protocol.migration.file, import.meta.url));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), protocol.migration.sha256);
    await f.db.exec(bytes.toString());
  };
  const registerScope = () => f.db.query("UPDATE nb_read.migrations SET digest=$1 WHERE version=5", [scope.migration.sha256]);
  const registerContext = () => f.db.query("UPDATE nb_search_context.state SET migration_digest=$1", [context.migration.sha256]);
  const repo = (mode: typeof modes[number], on = true, sql = f.reader, projection: "on-demand" | "filtered-scope" = "filtered-scope") =>
    createWebsiteDatabaseRepository(scopedReader(sql, mode, projection), {
      scoped: true, filteredScopeSearch: projection === "filtered-scope", searchContext: on,
    });
  return { ...f, install, registerScope, registerContext, repoFor: repo };
}

test("filtered-scope and context require independent reviewed installations and retain default-off behavior", async () => {
  const f = await setup();
  try {
    await f.install(scope);
    await assert.rejects(f.repoFor("published", false).search!({ q: "Introduction" }), { code: "CONTENT_UNAVAILABLE" });
    await f.registerScope();
    for (const mode of modes) {
      assert.equal((await f.repoFor(mode, false).search!({ q: "Introduction" })).total, 2);
      await assert.rejects(f.repoFor(mode).search!({ q: "Introduction" }), { code: "CONTENT_UNAVAILABLE" });
    }
    await f.install(context);
    await assert.rejects(f.repoFor("published").search!({ q: "Introduction" }), { code: "CONTENT_UNAVAILABLE" });
    await f.registerContext();
    for (const mode of modes) assert.equal((await f.repoFor(mode).search!({ q: "Introduction" })).total, 2);
    await f.db.query("UPDATE nb_read.migrations SET digest=NULL WHERE version=5");
    await assert.rejects(f.repoFor("published").search!({ q: "Introduction" }), { code: "CONTENT_UNAVAILABLE" });
    assert.equal((await f.repoFor("published", true, f.reader, "on-demand").search!({ q: "Introduction" })).total, 2);
  } finally { await f.db.close(); }
});

test("filtered-scope context preserves complete pagination and matching with one metadata batch per page", async () => {
  const f = await setup();
  try {
    await f.install(scope); await f.registerScope(); await f.install(context); await f.registerContext();
    for (const mode of modes) {
      const calls: string[] = [], observed: SqlExecutor = { async query<T>(sql: string, values?: unknown[]) {
        calls.push(sql); return f.reader.query<T>(sql, values);
      } };
      const query = { q: "Introduction", limit: 1 };
      const plain = await f.repoFor(mode, false, observed).search!(query);
      const detailReads = calls.filter(sql => sql.includes("read_content(")).length; calls.length = 0;
      const result = await f.repoFor(mode, true, observed).search!(query);
      assert.equal(result.total, plain.total);
      assert.deepEqual(result.items.map(({ context: _context, ...hit }) => hit), plain.items);
      assert.equal(calls.filter(sql => sql.includes("read_context(")).length, 1);
      assert.equal(calls.filter(sql => sql.includes("read_content(")).length, detailReads);
      assert(calls.some(sql => sql.includes(`read_search_filtered_scope('${mode}',`)));
      assert.deepEqual(result.items[0].context, { courseLabel: "SYN201", parentLabels: ["Week"] });
      const next = await f.repoFor(mode).search!({ ...query, cursor: result.nextCursor! });
      assert.deepEqual(next.items[0].context, { courseLabel: "SYN201", parentLabels: [] }); assert.equal(next.nextCursor, null);
      const baseline = await f.repoFor(mode, true, f.reader, "on-demand").search!({ ...query, limit: 50 });
      assert.deepEqual([...result.items, ...next.items], baseline.items);
      await assert.rejects(f.repoFor(mode).search!({ ...query, cursor: plain.nextCursor! }), { code: "INVALID_QUERY" });
      assert.equal((await f.repoFor(mode).search!({ q: "SYN201", kinds: ["study-note"] })).total, 0);
    }
  } finally { await f.db.close(); }
});

test("explicit search opt-outs still allow context without either optional search extension", async () => {
  const f = await setup(), previous = process.env.DATABASE_SEARCH_PROJECTION;
  try {
    await f.install(context); await f.registerContext(); process.env.DATABASE_SEARCH_PROJECTION = "filtered-scope";
    for (const mode of modes) for (const disabled of [{ filteredScopeSearch: false }, { filteredSearch: false }]) {
      const calls: string[] = [], observed: SqlExecutor = { async query<T>(sql: string, values?: unknown[]) {
        calls.push(sql); return f.reader.query<T>(sql, values);
      } };
      const repo = createWebsiteDatabaseRepository(scopedReader(observed, mode), { scoped: true, searchContext: true, ...disabled });
      assert.equal((await repo.search!({ q: "Introduction" })).items[0].context?.courseLabel, "SYN201");
      assert(calls.some(sql => sql.includes("read_search_parts("))); assert(calls.some(sql => sql.includes("read_context(")));
      assert(!calls.some(sql => /(?:read|check)_search_(?:filtered|precomputed)/.test(sql)));
    }
  } finally {
    if (previous === undefined) delete process.env.DATABASE_SEARCH_PROJECTION; else process.env.DATABASE_SEARCH_PROJECTION = previous;
    await f.db.close();
  }
});

test("context after filtered-scope remains inside the final version check and current ancestor eligibility", async () => {
  const f = await setup();
  try {
    await f.install(scope); await f.registerScope(); await f.install(context); await f.registerContext();
    for (const mode of modes) {
      const first = await f.repoFor(mode).search!({ q: "Introduction", limit: 1 }); let changed = false;
      const racing: SqlExecutor = { async query<T>(sql: string, values?: unknown[]) {
        const reply = await f.reader.query<T>(sql, values);
        if (!changed && sql.includes("read_context(")) { changed = true; await f.db.query("SELECT nb_v2_api.set_denied('composed-parent',true)"); }
        return reply;
      } };
      await assert.rejects(f.repoFor(mode, true, racing).search!({ q: "Introduction" }), { code: "INVALID_QUERY" });
      await assert.rejects(f.repoFor(mode).search!({ q: "Introduction", limit: 1, cursor: first.nextCursor! }), { code: "INVALID_QUERY" });
      const current = await f.repoFor(mode).search!({ q: "Introduction" });
      assert.deepEqual(current.items.map(hit => hit.id), ["composed-direct"]);
      assert.deepEqual(current.items[0].context, { courseLabel: "SYN201", parentLabels: [] });
      await f.db.query("SELECT nb_v2_api.set_denied('composed-parent',false)");
    }
  } finally { await f.db.close(); }
});

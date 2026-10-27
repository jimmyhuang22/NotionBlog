import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fixtureItems } from "../fixtures/content.ts";
import type { WebsiteRecord } from "../contracts/website-sync.ts";
import type { SqlExecutor } from "../src/server/database/sql.ts";
import { setupSearchProjection, status, body } from "./helpers/search-precomputed.ts";
import { configDigest } from "../src/server/database/website-validation.ts";
import { scopedReader } from "../src/server/database/scoped-reads.ts";
import { createWebsiteDatabaseRepository } from "../src/server/database/website-repository.ts";
import { SearchResultBudget } from "../src/server/database/result-response-budget.ts";
import { withContentReadBudget, contentReadBudgetIdentity } from "../src/server/content-read-budget.ts";
import protocol from "../database/search-filtered-scope-protocol.json" with { type: "json" };

test("real qualified projections preserve full pages, ancestor withdrawal, version races and expiry with the guard", async () => {
  const f = await setupSearchProjection(false);
  try {
    await f.db.exec(await readFile(new URL("../supabase/migrations/" + protocol.migration.file, import.meta.url), "utf8"));
    await f.db.query("UPDATE nb_read.migrations SET digest=$1 WHERE version=5", [protocol.migration.sha256]);
    const course = structuredClone(fixtureItems.course[0]);
    Object.assign(course, { id: "budget-course", slug: "budget-course", href: "/study/budget-course", title: "Java course", cover: null });
    const records: WebsiteRecord[] = [status(0, body("Java status")), {
      detail: { item: course, document: body("Java course") },
      evidence: { sourceKey: "courses", dataSourceId: "budget-courses", databaseParentId: null, courseId: null, parentId: null, ordinal: 1 },
    }];
    for (let i = 0; i < 4; i++) {
      const item = { ...structuredClone(fixtureItems["study-note"][0]), id: `budget-note-${i}`, slug: `budget-note-${i}`,
        href: `/study/budget-course/notes/budget-note-${i}`, title: `Java note ${i}`, courseId: course.id,
        parentId: i ? `budget-note-${i - 1}` : null, breadcrumbs: [], cover: null };
      records.push({ detail: { item, document: body("Java 学习") }, evidence: { sourceKey: "notes", dataSourceId: "budget-notes",
        databaseParentId: course.id, courseId: course.id, parentId: i ? `budget-note-${i - 1}` : course.id, ordinal: i + 2 } });
    }
    const sources = [
      { key: "statuses", kind: "status", mode: "all", dataSourceId: "source-statuses", databaseParentId: null, pageId: null },
      { key: "courses", kind: "course", mode: "allowlist", dataSourceId: "budget-courses", databaseParentId: null, pageId: null },
      { key: "notes", kind: "study-note", mode: "allowlist", dataSourceId: "budget-notes", databaseParentId: course.id, pageId: null },
    ];
    const permits = records.slice(1).map(r => ({ id: r.detail.item.id, kind: r.detail.item.kind,
      sourceKey: r.evidence.sourceKey, courseId: r.evidence.courseId, parentId: r.evidence.parentId }));
    const digest = configDigest([sources, permits]);
    await f.db.query("SELECT nb_v2_api.configure_policy($1,600,$2::jsonb,$3::jsonb)", [digest, JSON.stringify(sources), JSON.stringify(permits)]);
    const lease = await f.writer.begin(randomUUID(), digest);
    await f.writer.stage(lease, records); await f.writer.promote(lease, { records: records.length, media: 0, complete: true });
    await f.db.query("SELECT nb_publication_api.activate($1)", [lease.runId]);
    let race = false;
    const guarded: SqlExecutor = { async query<T>(text: string, values?: unknown[]) {
      const budget = contentReadBudgetIdentity()?.resultBudget;
      assert.ok(budget);
      const plan = budget.prepare(text, values);
      try {
        const result = await f.reader.query(plan.text, plan.values);
        if (race && text.includes("read_search_")) {
          race = false; await f.db.query("SELECT nb_v2_api.set_denied($1,true)", [course.id]);
        }
        return { rows: plan.accept<T>(result.rows) };
      } catch (error) { plan.fail(); throw error; }
    } };
    for (const projection of ["on-demand", "filtered-scope"] as const) {
      const options = { scoped: true, filteredScopeSearch: projection === "filtered-scope" };
      const before = createWebsiteDatabaseRepository(scopedReader(f.reader, "qualified", projection), options);
      const after = createWebsiteDatabaseRepository(scopedReader(guarded, "qualified", projection), options);
      const read = (query: Parameters<NonNullable<typeof after.search>>[0]) => {
        const resultBudget = new SearchResultBudget();
        return withContentReadBudget(new AbortController().signal, async () => {
          const page = await after.search!(query);
          assert.ok(resultBudget.snapshot().statements <= 3); return page;
        }, { resultBudget });
      };
      let cursor: string | undefined; const seen = new Set<string>();
      do {
        const query = { q: "Java", limit: 1, ...(cursor ? { cursor } : {}) };
        const expected = await before.search!(query), actual = await read(query);
        assert.deepEqual(actual, expected);
        for (const item of actual.items) { assert.ok(!seen.has(item.id)); seen.add(item.id); }
        cursor = actual.nextCursor ?? undefined;
        if (!cursor) assert.equal(seen.size, actual.total);
      } while (cursor);
      assert.equal(seen.size, records.length);
      const oldCursor = (await read({ q: "Java", limit: 1 })).nextCursor!;
      await f.db.query("SELECT nb_v2_api.set_denied($1,true)", [course.id]);
      assert.deepEqual(await read({ q: "Java" }), await before.search!({ q: "Java" }));
      assert.equal((await read({ q: "Java", kinds: ["study-note"] })).total, 0);
      await assert.rejects(read({ q: "Java", cursor: oldCursor, limit: 1 }), { code: "INVALID_QUERY" });
      await f.db.query("SELECT nb_v2_api.set_denied($1,false)", [course.id]);
      race = true;
      await assert.rejects(read({ q: "Java" }), { code: "INVALID_QUERY" });
      await f.db.query("SELECT nb_v2_api.set_denied($1,false)", [course.id]);
    }
    await f.db.query("UPDATE nb_v2.runs SET valid_until=clock_timestamp()-interval '1 second' WHERE id=$1", [lease.runId]);
    const expired = createWebsiteDatabaseRepository(scopedReader(guarded, "qualified", "filtered-scope"), { scoped: true, filteredScopeSearch: true });
    await assert.rejects(withContentReadBudget(new AbortController().signal, () => expired.search!({ q: "Java" }),
      { resultBudget: new SearchResultBudget() }), { code: "CONTENT_UNAVAILABLE" });
  } finally { await f.db.close(); }
});

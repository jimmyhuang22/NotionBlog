import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { ContentDocument } from "../contracts/content.ts";
import type { WebsiteRecord } from "../contracts/website-sync.ts";
import { fixtureItems } from "../fixtures/content.ts";
import type { SqlExecutor } from "../src/server/database/sql.ts";
import { createWebsiteDatabaseRepository } from "../src/server/database/website-repository.ts";
import { readSearchProjectionMode, scopedReader, SCOPED_FILTERED_SEARCH_SQL } from "../src/server/database/scoped-reads.ts";
import { searchFilterPatterns, supportsSearchFilterRuntime } from "../src/server/database/search-filter.ts";
import { configDigest, mediaIdentity } from "../src/server/database/website-validation.ts";
import { setupSearchProjection, status, body } from "./helpers/search-precomputed.ts";
import protocol from "../database/search-filtered-protocol.json" with { type: "json" };

async function setup() {
  const f = await setupSearchProjection(false); // The precomputation extension is not required.
  const bytes = await readFile(new URL("../supabase/migrations/" + protocol.migration.file, import.meta.url));
  assert.equal(createHash("sha256").update(bytes).digest("hex"), protocol.migration.sha256);
  await f.db.exec(bytes.toString());
  const register = () => f.db.query("UPDATE nb_read.migrations SET digest=$1 WHERE version=4", [protocol.migration.sha256]);
  const filtered = (mode: "qualified" | "published", db = f.reader) =>
    createWebsiteDatabaseRepository(scopedReader(db, mode, "filtered"), { scoped: true, filteredSearch: true });
  return { ...f, register, filtered };
}

test("filtered search is opt-in, runtime-guarded and bounded without truncating preimages", async () => {
  assert.equal(readSearchProjectionMode(undefined, "scoped"), "on-demand");
  assert.equal(readSearchProjectionMode("filtered", "scoped"), "filtered");
  assert.throws(() => readSearchProjectionMode("filtered", "legacy"), { code: "MISCONFIGURED" });
  assert.equal(supportsSearchFilterRuntime("unknown"), false);
  assert.equal(supportsSearchFilterRuntime(process.versions.unicode, "tr"), false);
  assert.equal(searchFilterPatterns("Java").length, supportsSearchFilterRuntime() ? 1 : 0);
  assert.deepEqual(searchFilterPatterns("ＪＡＶＡ"), searchFilterPatterns("Java"));
  for (const q of ["Notion page", "Media", "Unavailable page", "jNotion", "eJava", "two words", "x".repeat(128)])
    assert.deepEqual(searchFilterPatterns(q), [], q);
  assert.deepEqual(searchFilterPatterns("office"), []); // Full preimage exceeds the bounded regex; no partial rewrite.
  const f = await setup();
  try {
    await f.publish([status(0, body("Java"))]);
    await assert.rejects(f.filtered("published").search!({ q: "Java" }), { code: "CONTENT_UNAVAILABLE" });
    assert.equal((await f.repo("published", false).search!({ q: "Java" })).total, 1);
    await f.register();
    assert.equal((await f.filtered("published").search!({ q: "Java" })).total, 1);
    const previous = process.env.DATABASE_SEARCH_PROJECTION;
    try {
      process.env.DATABASE_SEARCH_PROJECTION = "filtered";
      const fromRuntimeOptions = createWebsiteDatabaseRepository(scopedReader(f.reader, "published"), { scoped: true });
      assert.equal((await fromRuntimeOptions.search!({ q: "Java" })).total, 1);
    } finally {
      if (previous === undefined) delete process.env.DATABASE_SEARCH_PROJECTION;
      else process.env.DATABASE_SEARCH_PROJECTION = previous;
    }
    let calls = 0;
    const never: SqlExecutor = { async query() { calls++; throw new Error("Must not query"); } };
    await assert.rejects(scopedReader(never, "published", "on-demand").query(SCOPED_FILTERED_SEARCH_SQL, [["status"], []]), { code: "CONTENT_UNAVAILABLE" });
    assert.equal(calls, 0);
  } finally { await f.db.close(); }
});

test("filtered search preserves every public page across Unicode, fragments and generated labels", async () => {
  const f = await setup();
  try {
    // Fictional syntax fixtures; no live source URL, signature or transport.
    const notionPage = new URL("/fictional", "https://" + ["notion", "so"].join("."));
    const signedImage = new URL("https://example.test/image");
    signedImage.searchParams.set(["sig", "nature"].join(""), "fictional");
    const texts = ["Java", "ＪＡＶＡ", "𝒥𝒶𝓋𝒶", "JAVASCRIPT", "oﬃce", "㍻", "神", "㍿", "株式会社", "学习课程", "无关资料", "2024",
      "j" + notionPage.href, signedImage.href, "Notion page", "Media"];
    const records = texts.map((text, index) => status(index, body(text)));
    records.push(status(20, { ...body(""), blocks: [{ id: "p", type: "paragraph", text: [{ text: "Java" }, { text: "学习" }] }] }));
    records[0].detail.item.title = "Java course";
    await f.publish(records); await f.register();
    for (const mode of ["qualified", "published"] as const) {
      const before = f.repo(mode, false), after = f.filtered(mode);
      for (const q of ["Java", "java", "ＪＡＶＡ", "javascript", "office", "ffi", "fic", "ff", "fi", "平成", "神", "神", "株式会社", "会社", "学习", "课程", "2024", "Java 学习", "Java学习", "jNotion", "Notion page", "Media", "Unavailable page", "no-match"])
        for (const limit of [1, 12]) {
          let cursor: string | undefined;
          do {
            const query = { q, limit, ...(cursor ? { cursor } : {}) };
            const expected = await before.search!(query), actual = await after.search!(query);
            assert.deepEqual(actual, expected, `${mode}/${q}/${limit}`);
            cursor = actual.nextCursor ?? undefined;
          } while (cursor);
        }
      assert.equal((await after.search!({ q: "Java学习" })).total, 0);
      assert.equal((await after.search!({ q: "Java 学习" })).total, 1);
      assert.equal((await after.search!({ q: "jNotion" })).total, 1);
    }
    const projected = (await f.reader.query<{ result: { records: unknown[] } }>("SELECT nb_read_api.read_search_filtered('published',ARRAY['status'],$1) AS result", [searchFilterPatterns("Java")])).rows[0].result;
    if (supportsSearchFilterRuntime()) assert(projected.records.length < records.length, "The SQL must reduce the authorized projection, not only filter in JS");
  } finally { await f.db.close(); }
});

test("filtered search rechecks course and intermediate-note ancestors for both publication modes", async () => {
  const f = await setup();
  try {
    const course = structuredClone(fixtureItems.course[0]); course.cover = null;
    const note = structuredClone(fixtureItems["study-note"][0]);
    const rows: WebsiteRecord[] = [{ detail: { item: course, document: body("owner") }, evidence: {
      sourceKey: "courses", dataSourceId: "filter-courses", databaseParentId: null, courseId: null, parentId: null, ordinal: 0,
    } }];
    for (const [id, parentId, text] of [["filter-parent", course.id, "ancestor"], ["filter-child", "filter-parent", "Java child"]]) {
      rows.push({ detail: { item: { ...note, id, slug: id, href: `/study/${course.id}/notes/${id}`, cover: null,
        courseId: course.id, parentId: parentId === course.id ? null : parentId, breadcrumbs: [] }, document: body(text) }, evidence: {
        sourceKey: "notes", dataSourceId: "filter-notes", databaseParentId: course.id, courseId: course.id, parentId, ordinal: rows.length,
      } });
    }
    const sources = [{ key: "courses", kind: "course", mode: "allowlist", dataSourceId: "filter-courses", databaseParentId: null, pageId: null },
      { key: "notes", kind: "study-note", mode: "allowlist", dataSourceId: "filter-notes", databaseParentId: course.id, pageId: null }];
    const permits = rows.map(row => ({ id: row.detail.item.id, kind: row.detail.item.kind, sourceKey: row.evidence.sourceKey, courseId: row.evidence.courseId, parentId: row.evidence.parentId }));
    const digest = configDigest([sources, permits]);
    await f.db.query("SELECT nb_v2_api.configure_policy($1,600,$2::jsonb,$3::jsonb)", [digest, JSON.stringify(sources), JSON.stringify(permits)]);
    const lease = await f.writer.begin(randomUUID(), digest);
    await f.writer.stage(lease, rows); await f.writer.promote(lease, { records: rows.length, media: 0, complete: true });
    await f.db.query("SELECT nb_publication_api.activate($1)", [lease.runId]); await f.register();
    for (const ancestor of ["filter-parent", course.id]) {
      for (const mode of ["qualified", "published"] as const) assert.equal((await f.filtered(mode).search!({ q: "Java" })).total, 1);
      await f.db.query("SELECT nb_v2_api.set_denied($1,true)", [ancestor]);
      for (const mode of ["qualified", "published"] as const) assert.equal((await f.filtered(mode).search!({ q: "Java" })).total, 0);
      await f.db.query("SELECT nb_v2_api.set_denied($1,false)", [ancestor]);
    }
  } finally { await f.db.close(); }
});

test("filtered search retains live link/media withdrawal, version races, expiry and restricted roles", async () => {
  const f = await setup();
  try {
    const first = status(0), target = status(1, body("target"));
    const sha = createHash("sha256").update("fictional-filter-image").digest("hex");
    const assetId = mediaIdentity(first.detail.item.id, "image", sha);
    const document: ContentDocument = { toc: [], completeness: "complete", blocks: [
      { id: "link", type: "paragraph", text: [{ text: "JavaLinked", link: { kind: "internal", href: target.detail.item.href } }, { text: "JavaUnavailable", link: { kind: "unavailable" } }] },
      { id: "image", type: "image", image: { id: assetId, src: `/media/v2/${assetId}`, alt: "JavaAlt", width: 1, height: 1 }, caption: [{ text: "JavaCaption" }] },
    ] };
    first.detail.document = document;
    const lease = await f.publish([first, target], [{ assetId, ownerPageId: first.detail.item.id, objectKey: `sha256/${sha}`, sha256: sha, byteSize: 1, mime: "image/png", width: 1, height: 1 }]);
    await f.register();
    for (const mode of ["qualified", "published"] as const) {
      const reader = f.filtered(mode);
      assert.equal((await reader.search!({ q: "JavaLinked" })).total, 1);
      assert.equal((await reader.search!({ q: "JavaCaption" })).total, 1);
      assert.equal((await reader.search!({ q: "JavaUnavailable" })).total, 0);
      assert.equal((await reader.search!({ q: "JavaAlt" })).total, 0);
    }
    await f.db.query("SELECT nb_v2_api.set_denied($1,true)", [target.detail.item.id]);
    await f.db.query("DELETE FROM nb_v2.media WHERE asset_id=$1", [assetId]);
    for (const mode of ["qualified", "published"] as const)
      for (const q of ["JavaLinked", "JavaCaption"]) assert.equal((await f.filtered(mode).search!({ q })).total, 0);
    for (const role of ["nb_writer", "anon", "authenticated", "service_role"])
      await assert.rejects(f.role(role).query("SELECT nb_read_api.read_search_filtered('published',ARRAY['status'],'{}')"), /permission denied/);
    await assert.rejects(f.reader.query("SELECT * FROM nb_read.migrations"), /permission denied/);
    await assert.rejects(f.reader.query("SELECT * FROM nb_v2.records"), /permission denied/);
    for (const probes of [null, [".*"], ["[a-z]"], ["[J]", "[A]"], ["x".repeat(2049)]])
      await assert.rejects(f.reader.query("SELECT nb_read_api.read_search_filtered('published',ARRAY['status'],$1)", [probes]), /NB_QUERY_INVALID/);
    let changed = false;
    const racing: SqlExecutor = { async query<T>(sql: string, values?: unknown[]) {
      const reply = await f.reader.query<T>(sql, values);
      if (!changed && sql.includes("nb_read_api.read_search_filtered(")) {
        changed = true; await f.db.query("SELECT nb_v2_api.set_denied($1,true)", [first.detail.item.id]);
      }
      return reply;
    } };
    await assert.rejects(f.filtered("published", racing).search!({ q: "Java" }), { code: "INVALID_QUERY" });
    await f.db.query("UPDATE nb_v2.runs SET valid_until=clock_timestamp()-interval '1 second' WHERE id=$1", [lease.runId]);
    await assert.rejects(f.filtered("qualified").search!({ q: "Java" }), { code: "CONTENT_UNAVAILABLE" });
    await f.db.exec("UPDATE nb_v2.state SET epoch=epoch+1");
    await assert.rejects(f.filtered("published").search!({ q: "Java" }), { code: "CONTENT_UNAVAILABLE" });
  } finally { await f.db.close(); }
});

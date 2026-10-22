import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { ContentRepository } from "../contracts/repository.ts";
import type { WebsiteRecord } from "../contracts/website-sync.ts";
import type { SqlExecutor } from "../src/server/database/sql.ts";
import { fixtureItems } from "../fixtures/content.ts";
import { setupSearchProjection, status, body } from "./helpers/search-precomputed.ts";
import { createWebsiteDatabaseRepository } from "../src/server/database/website-repository.ts";
import { scopedReader, readSearchProjectionMode, SCOPED_FILTERED_SCOPE_SEARCH_SQL, SCOPED_FILTERED_SEARCH_SQL, SCOPED_VERSION_SQL } from "../src/server/database/scoped-reads.ts";
import type { SearchProjectionMode } from "../src/server/database/scoped-reads.ts";
import { searchFilterPatterns } from "../src/server/database/search-filter.ts";
import { configDigest, mediaIdentity } from "../src/server/database/website-validation.ts";
import protocol from "../database/search-filtered-scope-protocol.json" with { type: "json" };
import filteredProtocol from "../database/search-filtered-protocol.json" with { type: "json" };

const modes = ["qualified", "published"] as const;
const paths: SearchProjectionMode[] = ["on-demand", "filtered", "precomputed", "filtered-scope"];
const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
async function migration(spec: { file: string; sha256: string }) {
  const bytes = await readFile(new URL("../supabase/migrations/" + spec.file, import.meta.url));
  assert.equal(hash(bytes), spec.sha256); return bytes.toString();
}
async function setup(options = { scope: true, filtered: true, precomputed: true }) {
  const f = await setupSearchProjection(options.precomputed);
  if (options.precomputed) await f.register();
  if (options.filtered) {
    await f.db.exec(await migration(filteredProtocol.migration));
    await f.db.query("UPDATE nb_read.migrations SET digest=$1 WHERE version=4", [filteredProtocol.migration.sha256]);
  }
  const installScope = () => migration(protocol.migration).then(sql => f.db.exec(sql));
  const registerScope = () => f.db.query("UPDATE nb_read.migrations SET digest=$1 WHERE version=5", [protocol.migration.sha256]);
  if (options.scope) { await installScope(); await registerScope(); }
  const repo = (mode: typeof modes[number], projection: SearchProjectionMode = "filtered-scope", sql = f.reader) =>
    createWebsiteDatabaseRepository(scopedReader(sql, mode, projection), { scoped: true,
      filteredSearch: projection === "filtered", filteredScopeSearch: projection === "filtered-scope" });
  return { ...f, installScope, registerScope, repoFor: repo };
}
async function seed(f: Awaited<ReturnType<typeof setup>>, withReferences = true) {
  const course = structuredClone(fixtureItems.course[0]);
  Object.assign(course, { id: "scope-course", slug: "scope-course", href: "/study/scope-course", title: "Java course", cover: null });
  const rows: WebsiteRecord[] = [
    ...Array.from({ length: 15 }, (_, i) => status(i, body(i === 1 ? "reference target" : "Java fictional " + i))),
    { detail: { item: course, document: body("Java course") }, evidence: {
      sourceKey: "courses", dataSourceId: "scope-courses", databaseParentId: null, courseId: null, parentId: null, ordinal: 15,
    } },
  ];
  const template = structuredClone(fixtureItems["study-note"][0]);
  for (let i = 0; i < 6; i++) {
    const id = "scope-note-" + i, parent = i === 0 ? course.id : "scope-note-" + Math.min(i - 1, 2);
    rows.push({ detail: { item: { ...template, id, slug: id, href: `/study/${course.id}/notes/${id}`, title: "Java note " + i,
      courseId: course.id, parentId: parent === course.id ? null : parent, breadcrumbs: [], cover: null }, document: body(i === 3 ? "ＪＡＶＡ 学习" : "Java note " + i) },
      evidence: { sourceKey: "notes", dataSourceId: "scope-notes", databaseParentId: course.id, courseId: course.id, parentId: parent, ordinal: rows.length } });
  }
  const note = rows[16], target = rows[1], sha = hash("fictional-scope-image"), assetId = mediaIdentity(note.detail.item.id, "image", sha);
  if (withReferences) note.detail.document!.blocks.push(
    { id: "link", type: "paragraph", text: [{ text: "JavaLinked", link: { kind: "internal", href: target.detail.item.href } }, { text: "JavaUnavailable", link: { kind: "unavailable" } }] },
    { id: "image", type: "image", image: { id: assetId, src: "/media/v2/" + assetId, alt: "JavaAlt", width: 1, height: 1 }, caption: [{ text: "JavaCaption" }] },
  );
  const sources = [
    { key: "statuses", kind: "status", mode: "all", dataSourceId: "source-statuses", databaseParentId: null, pageId: null },
    { key: "courses", kind: "course", mode: "allowlist", dataSourceId: "scope-courses", databaseParentId: null, pageId: null },
    { key: "notes", kind: "study-note", mode: "allowlist", dataSourceId: "scope-notes", databaseParentId: course.id, pageId: null },
  ];
  const permits = rows.filter(r => r.detail.item.kind !== "status").map(r => ({ id: r.detail.item.id, kind: r.detail.item.kind,
    sourceKey: r.evidence.sourceKey, courseId: r.evidence.courseId, parentId: r.evidence.parentId }));
  const policy = configDigest([sources, permits]);
  await f.db.query("SELECT nb_v2_api.configure_policy($1,600,$2::jsonb,$3::jsonb)", [policy, JSON.stringify(sources), JSON.stringify(permits)]);
  const lease = await f.writer.begin(randomUUID(), policy);
  await f.writer.stage(lease, rows, withReferences ? [{ assetId, ownerPageId: note.detail.item.id, objectKey: `sha256/${sha}`, sha256: sha, byteSize: 1, mime: "image/png", width: 1, height: 1 }] : []);
  await f.writer.promote(lease, { records: rows.length, media: withReferences ? 1 : 0, complete: true });
  await f.db.query("SELECT nb_publication_api.activate($1)", [lease.runId]);
  return { lease, rows, course, note, target, assetId };
}
async function comparePages(before: ContentRepository, after: ContentRepository, q: string, limit: number) {
  let cursor: string | undefined, total = 0; const ids = new Set<string>();
  do {
    const query = { q, limit, ...(cursor ? { cursor } : {}) };
    const expected = await before.search!(query), actual = await after.search!(query);
    assert.deepEqual(actual, expected); total += actual.items.length;
    for (const item of actual.items) { assert(!ids.has(item.id)); ids.add(item.id); }
    cursor = actual.nextCursor ?? undefined;
    assert(total <= 50); if (!cursor) assert.equal(total, actual.total);
  } while (cursor);
}

test("filtered-scope is opt-in, independently pinned, and ordinary reads survive its missing capability", async () => {
  assert.equal(readSearchProjectionMode(undefined, "scoped"), "on-demand");
  assert.equal(readSearchProjectionMode("filtered-scope", "scoped"), "filtered-scope");
  assert.throws(() => readSearchProjectionMode("filtered-scope", "legacy"), { code: "MISCONFIGURED" });
  let calls = 0;
  const never: SqlExecutor = { async query() { calls++; throw Error("Unexpected query"); } };
  assert.throws(() => createWebsiteDatabaseRepository(never, { filteredScopeSearch: true }), { code: "MISCONFIGURED" });
  for (const path of ["on-demand", "filtered", "precomputed"] as const)
    await assert.rejects(scopedReader(never, "published", path).query(SCOPED_FILTERED_SCOPE_SEARCH_SQL), { code: "CONTENT_UNAVAILABLE" });
  await assert.rejects(scopedReader(never, "published", "filtered-scope").query(SCOPED_FILTERED_SEARCH_SQL), { code: "CONTENT_UNAVAILABLE" });
  assert.equal(calls, 0);
  const f = await setup({ scope: false, filtered: false, precomputed: false });
  try {
    await f.publish([status(0, body("Java"))]);
    const db = scopedReader(f.reader, "published", "filtered-scope");
    const repo = createWebsiteDatabaseRepository(db, { scoped: true, filteredScopeSearch: true });
    await assert.rejects(repo.search!({ q: "Java" }), { code: "CONTENT_UNAVAILABLE" });
    assert((await db.query(SCOPED_VERSION_SQL)).rows.length);
    await f.installScope(); // No filtered-v1 migration is needed by the independent extension.
    await assert.rejects(repo.search!({ q: "Java" }), { code: "CONTENT_UNAVAILABLE" });
    await f.db.query("UPDATE nb_read.migrations SET digest=$1 WHERE version=5", ["f".repeat(64)]);
    await assert.rejects(repo.search!({ q: "Java" }), { code: "CONTENT_UNAVAILABLE" });
    await f.registerScope(); assert.equal((await repo.search!({ q: "Java" })).total, 1);
    const old = process.env.DATABASE_SEARCH_PROJECTION;
    try {
      process.env.DATABASE_SEARCH_PROJECTION = "filtered-scope";
      const runtimeRepo = createWebsiteDatabaseRepository(scopedReader(f.reader, "published"), { scoped: true });
      assert.equal((await runtimeRepo.search!({ q: "Java" })).total, 1);
      const disabled = createWebsiteDatabaseRepository(scopedReader(f.reader, "published"), { scoped: true, filteredSearch: false });
      assert.equal((await disabled.search!({ q: "Java" })).total, 1);
    } finally { if (old === undefined) delete process.env.DATABASE_SEARCH_PROJECTION; else process.env.DATABASE_SEARCH_PROJECTION = old; }
  } finally { await f.db.close(); }
});

test("filtered-scope explicit disable uses on-demand without either optional filtered extension", async () => {
  const f = await setup({ scope: false, filtered: false, precomputed: false });
  const old = process.env.DATABASE_SEARCH_PROJECTION;
  try {
    await f.publish([status(0, body("Java"))]);
    process.env.DATABASE_SEARCH_PROJECTION = "filtered-scope";
    for (const disable of [{ filteredScopeSearch: false }, { filteredSearch: false }]) {
      const calls: string[] = [];
      const sql: SqlExecutor = { async query<T>(text: string, values?: unknown[]) {
        calls.push(text); return f.reader.query<T>(text, values);
      } };
      const repo = createWebsiteDatabaseRepository(scopedReader(sql, "published"), { scoped: true, ...disable });
      assert.equal((await repo.search!({ q: "Java" })).total, 1);
      assert(calls.some(text => text.includes("nb_read_api.read_search_parts(")));
      assert(!calls.some(text => /(?:read|check)_search_(?:filtered|precomputed)/.test(text)));
    }
  } finally {
    if (old === undefined) delete process.env.DATABASE_SEARCH_PROJECTION; else process.env.DATABASE_SEARCH_PROJECTION = old;
    await f.db.close();
  }
});

test("filtered-scope preserves complete Unicode, fallback, DTO and cursor results against all three paths", async () => {
  const f = await setup();
  try {
    const { lease } = await seed(f); await f.fill(lease.runId);
    for (const mode of modes) {
      const scoped = f.repoFor(mode);
      for (const path of ["on-demand", "filtered", "precomputed"] as const) {
        const before = f.repoFor(mode, path);
        for (const q of ["Java", "ＪＡＶＡ", "学习", "JavaLinked", "JavaCaption", "JavaAlt", "JavaUnavailable", "Notion page", "two words", "no-match"])
          for (const limit of [1, 12, 50]) await comparePages(before, scoped, q, limit);
      }
    }
  } finally { await f.db.close(); }
});

test("filtered-scope rechecks ancestors, external links, media and cursors on every request", async () => {
  const f = await setup();
  try {
    const { lease, course, note, target, assetId } = await seed(f); await f.fill(lease.runId);
    const readers = modes.flatMap(mode => paths.map(path => f.repoFor(mode, path)));
    const initial = await Promise.all(readers.map(repo => repo.search!({ q: "Java", limit: 1 })));
    const revision = (await f.pin(lease.runId)).revision;
    await f.db.query("DELETE FROM nb_v2.media WHERE asset_id=$1", [assetId]);
    assert.equal((await f.pin(lease.runId)).revision, revision);
    for (let i = 0; i < readers.length; i++) {
      assert(initial[i].nextCursor); await assert.rejects(readers[i].search!({ q: "Java", limit: 1, cursor: initial[i].nextCursor! }), { code: "INVALID_QUERY" });
      assert.equal((await readers[i].search!({ q: "JavaCaption" })).total, 0);
    }
    await f.db.query("SELECT nb_v2_api.set_denied($1,true)", [target.detail.item.id]);
    for (const reader of readers) assert.equal((await reader.search!({ q: "JavaLinked" })).total, 0);
    for (const ancestor of ["scope-note-1", course.id]) {
      await f.db.query("SELECT nb_v2_api.set_denied($1,true)", [ancestor]);
      for (const mode of modes) {
        assert.deepEqual(await f.repoFor(mode).search!({ q: "Java" }), await f.repoFor(mode, "on-demand").search!({ q: "Java" }));
        const hits = (await f.repoFor(mode).search!({ q: "Java", kinds: ["study-note"], limit: 50 })).items;
        assert(hits.every(hit => ancestor !== course.id && [note.detail.item.id, "scope-note-1"].includes(hit.id)));
      }
      await f.db.query("SELECT nb_v2_api.set_denied($1,false)", [ancestor]);
    }
  } finally { await f.db.close(); }
});

test("filtered-scope still rejects publication races, qualification expiry and epoch changes", async () => {
  const f = await setup();
  try {
    const { lease, target } = await seed(f);
    for (const mode of modes) {
      let changed = false;
      const racing: SqlExecutor = { async query<T>(sql: string, values?: unknown[]) {
        const result = await f.reader.query<T>(sql, values);
        if (!changed && sql.includes("nb_read_api.read_search_filtered_scope(")) {
          changed = true; await f.db.query("SELECT nb_v2_api.set_denied($1,true)", [target.detail.item.id]);
        }
        return result;
      } };
      await assert.rejects(f.repoFor(mode, "filtered-scope", racing).search!({ q: "Java" }), { code: "INVALID_QUERY" });
      await f.db.query("SELECT nb_v2_api.set_denied($1,false)", [target.detail.item.id]);
    }
    await f.db.query("UPDATE nb_v2.runs SET valid_until=clock_timestamp()-interval '1 second' WHERE id=$1", [lease.runId]);
    await assert.rejects(f.repoFor("qualified").search!({ q: "Java" }), { code: "CONTENT_UNAVAILABLE" });
    await f.db.exec("UPDATE nb_v2.state SET epoch=epoch+1");
    await assert.rejects(f.repoFor("published").search!({ q: "Java" }), { code: "CONTENT_UNAVAILABLE" });
  } finally { await f.db.close(); }
});

test("filtered-scope roles cannot forge known IDs or bypass the original query limits", async () => {
  const f = await setup();
  try {
    const { lease } = await seed(f);
    for (const role of ["nb_writer", "anon", "authenticated", "service_role"]) {
      await assert.rejects(f.role(role).query("SELECT nb_read_api.read_search_filtered_scope('published',ARRAY['status'],'{}')"), /permission denied/);
      await assert.rejects(f.role(role).query("SELECT nb_read_api.check_search_filtered_scope($1)", [protocol.migration.sha256]), /permission denied/);
    }
    await assert.rejects(f.reader.query("SELECT nb_read.search_scope_reused($1,'[]','{}','{}')", [lease.runId]), /permission denied/);
    await assert.rejects(f.reader.query("SELECT * FROM nb_read.migrations"), /permission denied/);
    for (const probes of [null, [".*"], ["[a-z]"], ["[J]", "[A]"], ["x".repeat(2049)]])
      await assert.rejects(f.reader.query("SELECT nb_read_api.read_search_filtered_scope('published',ARRAY['status'],$1)", [probes]), /NB_QUERY_INVALID/);
    for (const kinds of [null, ["private"], Array(11).fill("status")])
      await assert.rejects(f.reader.query("SELECT nb_read_api.read_search_filtered_scope('published',$1,$2)", [kinds, searchFilterPatterns("Java")]), /NB_QUERY_INVALID/);
    const fn = (await f.db.query<{ name: string; stable: string; definer: boolean; config: string[] }>(
      "SELECT proname AS name,provolatile AS stable,prosecdef AS definer,proconfig AS config FROM pg_proc WHERE proname IN ('search_scope_reused','read_search_filtered_scope','check_search_filtered_scope')" )).rows;
    assert.equal(fn.length, 3); assert(fn.every(f => f.stable === "s" && f.config.includes("search_path=pg_catalog")));
    assert.equal(fn.find(f => f.name === "search_scope_reused")!.definer, false);
  } finally { await f.db.close(); }
});

test("filtered-scope retains the eligible-row cap even when no record matches the probe", async () => {
  const f = await setup({ scope: true, filtered: false, precomputed: false });
  try {
    const lease = await f.publish([status(0, body("unrelated"))]);
    // Equivalent fictional root rows under the all-source policy, bulk-loaded by the local fixture owner.
    await f.db.query(`INSERT INTO nb_v2.records(run_id,id,kind,source_key,course_id,parent_id,ordinal,item,document)
      SELECT run_id,'scope-overflow-'||n,kind,source_key,NULL,NULL,n,
        item||jsonb_build_object('id','scope-overflow-'||n,'slug','scope-overflow-'||n,'href','/status#scope-overflow-'||n),document
      FROM nb_v2.records CROSS JOIN generate_series(1,20000) n WHERE run_id=$1`, [lease.runId]);
    await f.db.query("UPDATE nb_v2.runs SET record_count=20001 WHERE id=$1", [lease.runId]);
    await assert.rejects(f.repoFor("published").search!({ q: "Java" }), { code: "CONTENT_UNAVAILABLE" });
  } finally { await f.db.close(); }
});

test("filtered-scope avoids repeat eligibility only for statement-local study-note candidates", async () => {
  const f = await setup();
  try {
    await seed(f, false);
    const original = (await f.db.query<{ definition: string }>("SELECT pg_get_functiondef('nb_v2.record_eligible(uuid,text)'::regprocedure) AS definition")).rows[0].definition;
    await f.db.exec("CREATE SEQUENCE nb_read.scope_test_calls");
    await f.db.exec(original.replace("FUNCTION nb_v2.record_eligible(", "FUNCTION nb_read.scope_test_eligible("));
    await f.db.exec(`CREATE OR REPLACE FUNCTION nb_v2.record_eligible(p_run uuid,p_id text) RETURNS boolean
      LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
      PERFORM nextval('nb_read.scope_test_calls'); RETURN nb_read.scope_test_eligible(p_run,p_id); END $$;`);
    try {
      for (const mode of modes) for (const kinds of [["status"], ["course", "study-note"]]) {
        const counts: number[] = []; let expected: unknown;
        for (const fn of ["read_search_filtered", "read_search_filtered_scope"]) {
          await f.db.query("SELECT setval('nb_read.scope_test_calls',1,false)");
          const value = (await f.reader.query<{ result: { records: unknown[]; links: string[]; mediaIds: string[] } }>(
            `SELECT nb_read_api.${fn}($1,$2,$3) AS result`, [mode, kinds, searchFilterPatterns("Java")])).rows[0].result;
          const count = (await f.db.query<{ count: string }>("SELECT last_value::text AS count FROM nb_read.scope_test_calls")).rows[0].count;
          counts.push(Number(count)); const normalized = { ...value, links: [...value.links].sort(), mediaIds: [...value.mediaIds].sort() };
          expected ??= normalized; assert.deepEqual(normalized, expected);
        }
        if (kinds.includes("study-note")) assert(counts[1] < counts[0], "Known note eligibility should not be recomputed for its own href");
        else assert.equal(counts[1], counts[0], "Flat search keeps its original projection");
      }
    } finally { await f.db.exec(original); }
  } finally { await f.db.close(); }
});

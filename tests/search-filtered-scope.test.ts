import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { ContentDocument } from "../contracts/content.ts";
import type { WebsiteRecord } from "../contracts/website-sync.ts";
import { fixtureItems } from "../fixtures/content.ts";
import { createWebsiteDatabaseRepository } from "../src/server/database/website-repository.ts";
import { readSearchProjectionMode, scopedReader, SCOPED_FILTERED_SCOPE_SEARCH_SQL } from "../src/server/database/scoped-reads.ts";
import type { SqlExecutor } from "../src/server/database/sql.ts";
import { searchFilterPatterns } from "../src/server/database/search-filter.ts";
import { configDigest, mediaIdentity } from "../src/server/database/website-validation.ts";
import { setupSearchProjection, status, body } from "./helpers/search-precomputed.ts";
import protocol from "../database/search-filtered-scope-protocol.json" with { type: "json" };
import filtered from "../database/search-filtered-protocol.json" with { type: "json" };

async function setup(original = false, registered = true) {
  const f = await setupSearchProjection(false);
  for (const [version, extension] of [...(original ? [[4, filtered] as const] : []), [5, protocol] as const]) {
    const bytes = await readFile(new URL("../supabase/migrations/" + extension.migration.file, import.meta.url));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), extension.migration.sha256);
    await f.db.exec(bytes.toString());
    if (registered || version === 4)
      await f.db.query("UPDATE nb_read.migrations SET digest=$1 WHERE version=$2", [extension.migration.sha256, version]);
  }
  const repo = (mode: "qualified" | "published", optimized = true, db = f.reader) =>
    createWebsiteDatabaseRepository(scopedReader(db, mode, optimized ? "filtered-scope" : "filtered"),
      { scoped: true, filteredSearch: !optimized, filteredScopeSearch: optimized });
  return { ...f, scope: repo };
}

async function mixedFixture() {
  const f = await setup(true);
  const course = structuredClone(fixtureItems.course[0]);
  Object.assign(course, { id: "scope-course", slug: "scope-course", href: "/study/scope-course", cover: null });
  const rows: WebsiteRecord[] = [{ detail: { item: course, document: body("Java course") }, evidence: {
    sourceKey: "courses", dataSourceId: "scope-courses", databaseParentId: null, courseId: null, parentId: null, ordinal: 0,
  } }];
  const template = structuredClone(fixtureItems["study-note"][0]);
  for (const [id, parent] of [["scope-parent", course.id], ["scope-child", "scope-parent"]])
    rows.push({ detail: { item: { ...template, id, slug: id, href: `/study/${course.id}/notes/${id}`, cover: null,
      courseId: course.id, parentId: parent === course.id ? null : parent, breadcrumbs: [] }, document: body("Java ＪＡＶＡ 学习 oﬃce") },
    evidence: { sourceKey: "notes", dataSourceId: "scope-notes", databaseParentId: course.id,
      courseId: course.id, parentId: parent, ordinal: rows.length } });
  const parent = rows[1], child = rows[2], knownStatus = status(80, body("Java StatusOnly")), outside = status(81, body("outside target"));
  rows.push(knownStatus, outside);
  const sha = createHash("sha256").update("fictional-scope-image").digest("hex");
  const outsideCaption = { id: "image-1", type: "image" as const, image: {
    id: mediaIdentity(outside.detail.item.id, "image-1", sha), src: "", alt: "", width: 1, height: 1 }, caption: [{ text: "outside image" }] };
  outsideCaption.image.src = `/media/v2/${outsideCaption.image.id}`;
  outside.detail.document!.blocks.push(outsideCaption);
  const assets = [parent, outside].map((owner, index) => {
    const assetId = mediaIdentity(owner.detail.item.id, `image-${index}`, sha);
    if (index === 0) parent.detail.document!.blocks.push({ id: `image-${index}`, type: "image", image: {
      id: assetId, src: `/media/v2/${assetId}`, alt: "JavaAltExcluded", width: 1, height: 1 }, caption: [{ text: `JavaCaption${index}` }] });
    return { assetId, ownerPageId: owner.detail.item.id, objectKey: `sha256/${sha}`, sha256: sha,
      byteSize: 1, mime: "image/png" as const, width: 1, height: 1 };
  });
  const link = (text: string, href: string) => ({ id: text, type: "paragraph" as const, text: [{ text, link: { kind: "internal" as const, href } }] });
  parent.detail.document!.blocks.push(link("JavaExternal", outside.detail.item.href));
  child.detail.document!.blocks.push(link("JavaKnown", parent.detail.item.href));
  knownStatus.detail.document!.blocks.push(link("JavaStatusLink", parent.detail.item.href));
  const sources = [{ key: "courses", kind: "course", mode: "allowlist", dataSourceId: "scope-courses", databaseParentId: null, pageId: null },
    { key: "notes", kind: "study-note", mode: "allowlist", dataSourceId: "scope-notes", databaseParentId: course.id, pageId: null },
    { key: "statuses", kind: "status", mode: "all", dataSourceId: "source-statuses", databaseParentId: null, pageId: null }];
  const permits = rows.filter(row => row.detail.item.kind !== "status").map(row => ({ id: row.detail.item.id,
    kind: row.detail.item.kind, sourceKey: row.evidence.sourceKey, courseId: row.evidence.courseId, parentId: row.evidence.parentId }));
  const digest = configDigest([sources, permits]);
  await f.db.query("SELECT nb_v2_api.configure_policy($1,600,$2::jsonb,$3::jsonb)", [digest, JSON.stringify(sources), JSON.stringify(permits)]);
  const lease = await f.writer.begin(randomUUID(), digest);
  await f.writer.stage(lease, rows, assets); await f.writer.promote(lease, { records: rows.length, media: assets.length, complete: true });
  await f.db.query("SELECT nb_publication_api.activate($1)", [lease.runId]);
  // Adversarial stored AST: the reader must still qualify a referenced media
  // owner outside its candidates. Normal writer admission rejects cross-owner images.
  parent.detail.document!.blocks.push({ ...outsideCaption, caption: [{ text: "JavaCaption1" }] });
  await f.db.query("UPDATE nb_v2.records SET document=$1::jsonb WHERE run_id=$2 AND id=$3",
    [JSON.stringify(parent.detail.document), lease.runId, parent.detail.item.id]);
  return { ...f, rows, course, parent, child, outside, assets, lease };
}

test("filtered-scope is default-off, independently registered and required only for its search", async () => {
  assert.equal(readSearchProjectionMode(undefined, "scoped"), "on-demand");
  assert.equal(readSearchProjectionMode("filtered-scope", "scoped"), "filtered-scope");
  assert.throws(() => readSearchProjectionMode("filtered-scope", "legacy"), { code: "MISCONFIGURED" });
  let calls = 0;
  const never: SqlExecutor = { async query() { calls++; throw Error("Unexpected SQL"); } };
  assert.throws(() => createWebsiteDatabaseRepository(never, { filteredScopeSearch: true }), { code: "MISCONFIGURED" });
  assert.throws(() => createWebsiteDatabaseRepository(never, { scoped: true, filteredScopeSearch: true, filteredSearch: true }), { code: "MISCONFIGURED" });
  for (const mode of ["on-demand", "filtered", "precomputed"] as const)
    await assert.rejects(scopedReader(never, "published", mode).query(SCOPED_FILTERED_SCOPE_SEARCH_SQL, [["status"], []]), { code: "CONTENT_UNAVAILABLE" });
  assert.equal(calls, 0);
  const f = await setup(false, false); // Neither old optional extension is installed.
  try {
    await f.publish([status(0, body("Java"))]);
    const reader = f.scope("published");
    await assert.rejects(reader.search!({ q: "Java" }), { code: "CONTENT_UNAVAILABLE" });
    assert.equal((await reader.list("status", {})).total, 1);
    await f.db.query("UPDATE nb_read.migrations SET digest=$1 WHERE version=5", ["a".repeat(64)]);
    await assert.rejects(reader.search!({ q: "Java" }), { code: "CONTENT_UNAVAILABLE" });
    await f.db.query("UPDATE nb_read.migrations SET digest=$1 WHERE version=5", [protocol.migration.sha256]);
    assert.equal((await reader.search!({ q: "Java" })).total, 1, "Failed readiness retries with the independent SHA");
    assert.deepEqual(await reader.search!({ q: "two words" }), await f.repo("published", false).search!({ q: "two words" }));
    const previous = process.env.DATABASE_SEARCH_PROJECTION;
    try {
      process.env.DATABASE_SEARCH_PROJECTION = "filtered-scope";
      assert.deepEqual(await createWebsiteDatabaseRepository(scopedReader(f.reader, "published"), { scoped: true }).search!({ q: "Java" }),
        await reader.search!({ q: "Java" }));
    } finally {
      if (previous === undefined) delete process.env.DATABASE_SEARCH_PROJECTION;
      else process.env.DATABASE_SEARCH_PROJECTION = previous;
    }
  } finally { await f.db.close(); }
});

test("filtered-scope revokes unsafe default grants and keeps the proven candidate set private", async () => {
  const f = await setup();
  try {
    const lease = await f.publish([status(0, body("Java"))]);
    const roles = ["nb_reader", "nb_website_reader", "nb_writer", "anon", "authenticated", "service_role"];
    await f.db.exec("GRANT USAGE ON SCHEMA nb_read,nb_read_api TO nb_reader,nb_website_reader,nb_writer,anon,authenticated,service_role");
    for (const role of roles) {
      assert.equal((await f.db.query<{ allowed: boolean }>("SELECT has_function_privilege($1,'nb_read.search_scope_known(uuid,jsonb,text[],text[])','EXECUTE') AS allowed", [role])).rows[0].allowed, false);
      await assert.rejects(f.role(role).query("SELECT nb_read.search_scope_known($1,$2::jsonb,$3::text[],'{}'::text[])",
        [lease.runId, JSON.stringify([{ item: { id: "forged-known" } }]), ["/forged"]]), /permission denied/);
      for (const signature of ["read_search_filtered_scope(text,text[],text[])", "check_search_filtered_scope(text)"]) {
        const privilege = (await f.db.query<{ allowed: boolean }>("SELECT has_function_privilege($1,$2,'EXECUTE') AS allowed", [role, `nb_read_api.${signature}`])).rows[0].allowed;
        assert.equal(privilege, ["nb_reader", "nb_website_reader"].includes(role));
      }
      if (!["nb_reader", "nb_website_reader"].includes(role))
        await assert.rejects(f.role(role).query("SELECT nb_read_api.read_search_filtered_scope('published',ARRAY['status'],ARRAY['Java'])"), /permission denied/);
    }
    await assert.rejects(f.reader.query("SELECT * FROM nb_read.migrations"), /permission denied/);
    await assert.rejects(f.reader.query("SELECT * FROM nb_v2.records"), /permission denied/);
    const attributes = (await f.db.query<{ provolatile: string; prosecdef: boolean; proconfig: string[] }>(
      "SELECT provolatile,prosecdef,proconfig FROM pg_proc WHERE oid=ANY(ARRAY['nb_read.search_scope_known(uuid,jsonb,text[],text[])'::regprocedure,'nb_read_api.read_search_filtered_scope(text,text[],text[])'::regprocedure,'nb_read_api.check_search_filtered_scope(text)'::regprocedure])")).rows;
    assert.equal(attributes.length, 3);
    assert(attributes.every(x => x.provolatile === "s" && x.prosecdef && x.proconfig.includes("search_path=pg_catalog")));
    for (const probes of [null, [null], [".*"], ["[a-z]"], ["[J]", "[A]"], ["x".repeat(2049)]])
      await assert.rejects(f.reader.query("SELECT nb_read_api.read_search_filtered_scope('published',ARRAY['status'],$1)", [probes]), /NB_QUERY_INVALID/);
    for (const array of ["'[0:0]={Java}'::text[]", "ARRAY[ARRAY['Java']]"])
      await assert.rejects(f.reader.query(`SELECT nb_read_api.read_search_filtered_scope('published',ARRAY['status'],${array})`), /NB_QUERY_INVALID/);
    for (const kinds of [null, [null], ["invalid"], Array(11).fill("status")])
      await assert.rejects(f.reader.query("SELECT nb_read_api.read_search_filtered_scope('published',$1,ARRAY['Java'])", [kinds]), /NB_QUERY_INVALID/);
  } finally { await f.db.close(); }
});

test("filtered-scope reuses the mixed candidate set only after a matching note and preserves every result page", async () => {
  const f = await mixedFixture();
  try {
    const original = (await f.db.query<{ value: string }>("SELECT pg_get_functiondef('nb_v2.record_eligible(uuid,text)'::regprocedure) AS value")).rows[0].value;
    await f.db.exec("CREATE SEQUENCE nb_read.test_calls");
    await f.db.exec(original.replace("FUNCTION nb_v2.record_eligible(", "FUNCTION nb_read.test_eligible("));
    await f.db.exec("CREATE OR REPLACE FUNCTION nb_v2.record_eligible(p_run uuid,p_id text) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN PERFORM nextval('nb_read.test_calls'); RETURN nb_read.test_eligible(p_run,p_id); END $$");
    try {
      for (const [kinds, probes, reduces] of [[['course', 'study-note', 'status'], ['Java'], true], [['status'], ['Java'], false],
        [['course', 'study-note', 'status'], ['StatusOnly'], false]] as const) {
        const counts: number[] = []; let expected: unknown;
        for (const fn of ["read_search_filtered", "read_search_filtered_scope"]) {
          await f.db.exec("SELECT setval('nb_read.test_calls',1,false)");
          const p = (await f.reader.query<{ result: { links: string[]; mediaIds: string[] } }>(`SELECT nb_read_api.${fn}('published',$1,$2) AS result`, [kinds, probes])).rows[0].result;
          const count = (await f.db.query<{ last_value: string; is_called: boolean }>("SELECT last_value,is_called FROM nb_read.test_calls")).rows[0];
          counts.push(count.is_called ? Number(count.last_value) : 0);
          const normalized = { ...p, links: [...p.links].sort(), mediaIds: [...p.mediaIds].sort() };
          expected ??= normalized; assert.deepEqual(normalized, expected);
        }
        if (reduces) assert(counts[1] < counts[0], "Mixed matching notes must use the optimized branch");
        else assert.equal(counts[1], counts[0], "No matching notes must keep the original scope path");
      }
    } finally { await f.db.exec(original); await f.db.exec("DROP FUNCTION nb_read.test_eligible(uuid,text); DROP SEQUENCE nb_read.test_calls"); }
    for (const mode of ["qualified", "published"] as const)
      for (const q of ["Java", "ＪＡＶＡ", "office", "学习", "JavaKnown", "JavaExternal", "JavaCaption0", "JavaCaption1", "JavaAltExcluded", "two words"])
        for (const limit of [1, 2, 12]) {
          let cursor: string | undefined, seen = 0;
          do {
            const query = { q, limit, ...(cursor ? { cursor } : {}) };
            const expected = await f.scope(mode, false).search!(query), actual = await f.scope(mode).search!(query);
            assert.deepEqual(actual, expected, `${mode}/${q}/${limit}`);
            cursor = actual.nextCursor ?? undefined; seen += actual.items.length;
            assert(seen <= f.rows.length); if (!cursor) assert.equal(seen, actual.total);
          } while (cursor);
        }
  } finally { await f.db.close(); }
});

test("filtered-scope requalifies known ancestors and outside link/media owners across requests", async () => {
  const f = await mixedFixture();
  try {
    for (const mode of ["qualified", "published"] as const) {
      assert.equal((await f.scope(mode).search!({ q: "JavaExternal" })).total, 1);
      assert.equal((await f.scope(mode).search!({ q: "JavaCaption1" })).total, 1);
    }
    for (const ancestor of [f.parent.detail.item.id, f.course.id]) {
      await f.db.query("SELECT nb_v2_api.set_denied($1,true)", [ancestor]);
      for (const mode of ["qualified", "published"] as const) {
        const result = await f.scope(mode).search!({ q: "Java" });
        assert(!result.items.some(hit => [f.parent.detail.item.id, f.child.detail.item.id].includes(hit.id)));
        assert.equal((await f.scope(mode).search!({ q: "JavaStatusLink" })).total, 0);
        assert.deepEqual(result, await f.scope(mode, false).search!({ q: "Java" }));
      }
      await f.db.query("SELECT nb_v2_api.set_denied($1,false)", [ancestor]);
    }
    await f.db.query("SELECT nb_v2_api.set_denied($1,true)", [f.outside.detail.item.id]);
    for (const mode of ["qualified", "published"] as const) {
      for (const q of ["JavaExternal", "JavaCaption1"]) assert.equal((await f.scope(mode).search!({ q })).total, 0);
      assert.equal((await f.scope(mode).search!({ q: "JavaCaption0" })).total, 1);
      assert.deepEqual(await f.scope(mode).search!({ q: "Java" }), await f.scope(mode, false).search!({ q: "Java" }));
    }
  } finally { await f.db.close(); }
});

test("filtered-scope preserves final-version races, media-only cursor invalidation and publication expiry", async () => {
  const f = await mixedFixture();
  try {
    for (const mode of ["qualified", "published"] as const) {
      let mutations = 0;
      const racing: SqlExecutor = { async query<T>(sql: string, values?: unknown[]) {
        const reply = await f.reader.query<T>(sql, values);
        if (sql.includes("nb_read_api.read_search_filtered_scope(")) {
          assert.equal(mutations++, 0); await f.db.query("SELECT nb_v2_api.set_denied($1,true)", [f.outside.detail.item.id]);
        }
        return reply;
      } };
      await assert.rejects(f.scope(mode, true, racing).search!({ q: "Java" }), { code: "INVALID_QUERY" });
      assert.equal(mutations, 1);
      await f.db.query("SELECT nb_v2_api.set_denied($1,false)", [f.outside.detail.item.id]);
    }
    const first = await f.scope("published").search!({ q: "Java", limit: 1 }); assert(first.nextCursor);
    const revision = (await f.pin(f.lease.runId)).revision;
    await f.db.query("DELETE FROM nb_v2.media WHERE asset_id=$1", [f.assets[0].assetId]);
    assert.equal((await f.pin(f.lease.runId)).revision, revision);
    for (const mode of ["qualified", "published"] as const)
      await assert.rejects(f.scope(mode).search!({ q: "Java", limit: 1, cursor: first.nextCursor }), { code: "INVALID_QUERY" });
    await f.db.query("UPDATE nb_v2.runs SET valid_until=clock_timestamp()-interval '1 second' WHERE id=$1", [f.lease.runId]);
    await assert.rejects(f.scope("qualified").search!({ q: "Java" }), { code: "CONTENT_UNAVAILABLE" });
    assert.deepEqual(await f.scope("published").search!({ q: "Java" }), await f.scope("published", false).search!({ q: "Java" }));
    await f.db.exec("UPDATE nb_v2.state SET epoch=epoch+1");
    for (const mode of ["qualified", "published"] as const)
      await assert.rejects(f.scope(mode).search!({ q: "Java" }), { code: "CONTENT_UNAVAILABLE" });
  } finally { await f.db.close(); }
});

test("filtered-scope fails closed on scan count, projection bytes and traversal depth", async () => {
  const f = await setup();
  try {
    const lease = await f.publish([status(0, body("Java"))]);
    // Raw local fixture expansion deliberately exceeds writer admission limits.
    await f.db.query(`INSERT INTO nb_v2.records SELECT run_id,'limit-'||i,kind,source_key,course_id,parent_id,i,
      item||jsonb_build_object('id','limit-'||i,'slug','limit-'||i,'href','/status#limit-'||i),document
      FROM nb_v2.records CROSS JOIN generate_series(1,20000) i WHERE run_id=$1`, [lease.runId]);
    await assert.rejects(f.reader.query("SELECT nb_read_api.read_search_filtered_scope('published',ARRAY['status'],ARRAY['Absent'])"), /NB_UNAVAILABLE/);
    await f.db.query("DELETE FROM nb_v2.records WHERE run_id=$1 AND id LIKE 'limit-%'", [lease.runId]);
    const oversized = body("Java" + "x".repeat(33554432));
    await f.db.query("UPDATE nb_v2.records SET document=$1::jsonb WHERE run_id=$2", [JSON.stringify(oversized), lease.runId]);
    await assert.rejects(f.reader.query("SELECT nb_read_api.read_search_filtered_scope('published',ARRAY['status'],ARRAY['Java'])"), /NB_UNAVAILABLE/);
    const deep: ContentDocument = body("Java");
    for (let i = 0; i < 34; i++) deep.blocks = [{ id: `depth-${i}`, type: "toggle", title: [{ text: "Java" }], children: deep.blocks }];
    await f.db.query("UPDATE nb_v2.records SET document=$1::jsonb WHERE run_id=$2", [JSON.stringify(deep), lease.runId]);
    await assert.rejects(f.reader.query("SELECT nb_read_api.read_search_filtered_scope('published',ARRAY['status'],ARRAY['Java'])"), /NB_UNAVAILABLE/);
    assert.equal(searchFilterPatterns("Java").length, 1, "The bounds tests must use the filtered SQL path");
  } finally { await f.db.close(); }
});

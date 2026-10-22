import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { fixtureItems } from "../fixtures/content.ts";
import { CONTENT_KINDS, type ContentFeatures } from "../config/features.ts";
import type { ContentDocument, Game, TimeAmount } from "../contracts/content.ts";
import type { HomeFeedV2Page } from "../contracts/social-timeline.ts";
import { WEBSITE_SCHEMA_DIGEST, type WebsiteRecord } from "../contracts/website-sync.ts";
import { createContentService } from "../src/lib/content/factory.ts";
import { createWebsiteDatabaseRepository } from "../src/server/database/website-repository.ts";
import { createWebsiteWriter } from "../src/server/database/website-writer.ts";
import { configDigest, mediaIdentity } from "../src/server/database/website-validation.ts";
import { readProjectionMode, scopedReader } from "../src/server/database/scoped-reads.ts";
import { publicationReader } from "../src/server/database/publication.ts";
import type { SqlExecutor } from "../src/server/database/sql.ts";
import protocol from "../database/scoped-read-protocol.json" with { type: "json" };
import publication from "../database/publication-protocol.json" with { type: "json" };
import { readTimelineIndexSnapshot, hydrateTimelinePage } from "../src/lib/content/website.ts";
import { createHomeFeedV2Repository } from "../src/lib/content/home-feed-v2-core.ts";
import { homeFeedResponse } from "../src/lib/content/home-feed-http.ts";
import { withContentReadBudget } from "../src/server/content-read-budget.ts";

const all = Object.fromEntries(CONTENT_KINDS.map(kind => [kind, true])) as ContentFeatures;
function status(index: number, document: ContentDocument): WebsiteRecord {
  const id = `scoped-status-${String(index).padStart(4, "0")}`;
  return { detail: { item: { ...structuredClone(fixtureItems.status[0]), id, slug: id, href: `/status#${id}`,
    title: id, text: [], cover: null, summary: null }, document },
    evidence: { sourceKey: "statuses", dataSourceId: "source-statuses", databaseParentId: null, courseId: null, parentId: null, ordinal: index } };
}
const body = (text: string): ContentDocument => ({ toc: [], completeness: "complete", blocks: [{ id: "p", type: "paragraph", text: [{ text }] }] });
async function setup() {
  const db = await PGlite.create();
  await db.exec("CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS; ALTER DEFAULT PRIVILEGES GRANT EXECUTE ON FUNCTIONS TO anon,authenticated,service_role;");
  for (const path of ["database/migrations/001_content.sql", "database/website-migrations/001_website.sql",
    "supabase/migrations/" + publication.migration.file, "supabase/migrations/" + protocol.migration.file,
    "supabase/migrations/" + protocol.searchMigration.file, "supabase/migrations/" + protocol.traversalMigration.file])
    await db.exec(await readFile(new URL("../" + path, import.meta.url), "utf8"));
  await db.query("UPDATE nb_v2.state SET schema_digest=$1", [WEBSITE_SCHEMA_DIGEST]);
  const sql = await readFile(new URL("../supabase/migrations/" + protocol.migration.file, import.meta.url));
  assert.equal(createHash("sha256").update(sql).digest("hex"), protocol.migration.sha256);
  await db.query("UPDATE nb_read.migrations SET digest=$1 WHERE version=1", [protocol.migration.sha256]);
  const searchSql = await readFile(new URL("../supabase/migrations/" + protocol.searchMigration.file, import.meta.url));
  assert.equal(createHash("sha256").update(searchSql).digest("hex"), protocol.searchMigration.sha256);
  await db.query("UPDATE nb_read.migrations SET digest=$1 WHERE version=2", [protocol.searchMigration.sha256]);
  const traversalSql = await readFile(new URL("../supabase/migrations/" + protocol.traversalMigration.file, import.meta.url));
  assert.equal(createHash("sha256").update(traversalSql).digest("hex"), protocol.traversalMigration.sha256);
  await db.query("UPDATE nb_read.migrations SET digest=$1 WHERE version=3", [protocol.traversalMigration.sha256]);
  await db.query("UPDATE nb_publication.state SET migration_digest=$1", [publication.migration.sha256]);
  const sources = [{ key: "statuses", kind: "status", mode: "all", dataSourceId: "source-statuses", databaseParentId: null, pageId: null }];
  const digest = configDigest(sources);
  await db.query("SELECT nb_v2_api.configure_policy($1,600,$2::jsonb,'[]')", [digest, JSON.stringify(sources)]);
  const role = (name: string): SqlExecutor => ({ query: <T>(sql: string, values?: unknown[]) => db.transaction(async tx => {
    await tx.exec(`SET LOCAL ROLE ${name}`); return tx.query<T>(sql, values);
  }) });
  const reader = role("nb_reader"), writer = createWebsiteWriter(role("nb_writer"));
  const repo = (mode: "qualified" | "published", scoped = true, sql = reader) => createWebsiteDatabaseRepository(
    scoped ? scopedReader(sql, mode) : publicationReader(sql, mode), { scoped });
  const service = (repository: ReturnType<typeof repo>, features = all) => createContentService({ provider: "database", features, databaseRepository: repository }).repository;
  return { db, role, digest, reader, writer, repo, service };
}

test("scoped reads preserve search order, redaction, publication mode and restricted permissions", async t => {
  const f = await setup();
  try {
    const bytes = Buffer.from("synthetic-image"), sha = createHash("sha256").update(bytes).digest("hex");
    const first = status(0, body("")), target = status(1, body("target"));
    const assetId = mediaIdentity(first.detail.item.id, "image", sha);
    const runs = (text: string) => [{ text }];
    const doc: ContentDocument = { toc: [], completeness: "complete", blocks: [
      { id: "p", type: "paragraph", text: runs("Vue ＡＢＣ 中文 " + new URL("/fiction", ["https://www.", "notion.so"].join("")).href) },
      { id: "q", type: "quote", text: runs("quote") },
      { id: "toggle", type: "toggle", title: runs("toggle"), children: [{ id: "c", type: "paragraph", text: runs("child") }] },
      { id: "callout", type: "callout", tone: "info", icon: null, text: runs("callout"), children: [{ id: "n", type: "paragraph", text: runs("nested") }] },
      { id: "list", type: "list", ordered: false, items: [{ id: "one", checked: null, text: runs("first"), children: [{ id: "li", type: "paragraph", text: runs("inner") }] }, { id: "two", checked: null, text: runs("second"), children: [] }] },
      { id: "columns", type: "columns", columns: [{ ratio: null, blocks: [{ id: "co", type: "paragraph", text: runs("column") }] }] },
      { id: "table", type: "table", hasColumnHeader: false, hasRowHeader: false, rows: [[runs("cellone"), runs("celltwo")]] },
      { id: "code", type: "code", language: "text", code: "codeword", caption: runs("codecaption") },
      { id: "eq", type: "equation", expression: "formula" },
      { id: "bookmark", type: "bookmark", title: "bookmark", description: "description", url: "https://example.test/urlsecret" },
      { id: "image", type: "image", image: { id: assetId, src: `/media/v2/${assetId}`, alt: "altsecret", width: 1, height: 1 }, caption: runs("captionsecret") },
      { id: "links", type: "paragraph", text: [{ text: "linksecret", link: { kind: "internal", href: target.detail.item.href } }, { text: "hiddenrun", link: { kind: "unavailable" } }] },
      { id: "unsupported", type: "unsupported", label: "labelsecret" },
    ] };
    first.detail.document = doc;
    const lease = await f.writer.begin(randomUUID(), f.digest);
    await f.writer.stage(lease, [first, target], [{ assetId, ownerPageId: first.detail.item.id, objectKey: `sha256/${sha}`,
      sha256: sha, byteSize: bytes.length, mime: "image/png", width: 1, height: 1 }]);
    await f.writer.promote(lease, { records: 2, media: 1, complete: true });
    await f.db.query("SELECT nb_publication_api.activate($1)", [lease.runId]);
    assert.equal((await f.reader.query<{ result: { records: unknown[] } }>("SELECT nb_read_api.read_search('qualified',ARRAY['status']) AS result")).rows[0].result.records.length, 2);
    for (const mode of ["qualified", "published"] as const) {
      const fast = f.service(f.repo(mode)), legacy = f.service(f.repo(mode, false));
      await t.test(mode + " preserves DTOs, queries and Unicode matching", async () => {
        assert.deepEqual(await fast.get("status", first.detail.item.slug), await legacy.get("status", first.detail.item.slug));
        assert.deepEqual(await fast.list("status", { limit: 1 }), await legacy.list("status", { limit: 1 }));
        assert.deepEqual(await fast.getStatusYears!(), await legacy.getStatusYears!());
        for (const q of ["Vue", "abc", "中文", "toggle child", "first inner second", "cellone celltwo", "codeword codecaption", "bookmark description", "captionsecret", "linksecret", "Notion page", "urlsecret", "altsecret", "labelsecret", "hiddenrun"])
          assert.deepEqual(await fast.search!({ q, limit: 1 }), await legacy.search!({ q, limit: 1 }), q);
        const firstPage = await fast.search!({ q: "scoped-status", limit: 1 });
        assert.ok(firstPage.nextCursor);
        assert.deepEqual(await fast.search!({ q: "scoped-status", limit: 1, cursor: firstPage.nextCursor! }),
          await legacy.search!({ q: "scoped-status", limit: 1, cursor: firstPage.nextCursor! }));
      });
    }
    await t.test("withdrawn targets and images cannot match their old labels/captions", async () => {
      await f.db.query("SELECT nb_v2_api.set_denied($1,true)", [target.detail.item.id]);
      await f.db.query("DELETE FROM nb_v2.media WHERE asset_id=$1", [assetId]);
      for (const q of ["linksecret", "captionsecret", "Vue"])
        assert.deepEqual(await f.repo("qualified").search!({ q }), await f.repo("qualified", false).search!({ q }));
      assert.equal((await f.repo("qualified").search!({ q: "linksecret" })).total, 0);
      assert.equal((await f.repo("qualified").search!({ q: "captionsecret" })).total, 0);
    });
    await t.test("overlapping metadata reads share work only within the same budget and never after settlement", async () => {
      let reads = 0;
      const observed: SqlExecutor = { async query<T>(sql: string, values?: unknown[]) {
        if (sql.includes("nb_read_api.read_content(")) reads++;
        return f.reader.query<T>(sql, values);
      } };
      const repo = f.repo("qualified", true, observed);
      await withContentReadBudget(new AbortController().signal, () => Promise.all([repo.list("status"), repo.getStatusYears!()])); assert.equal(reads, 1);
      await repo.getStatusYears!(); assert.equal(reads, 2);
      await Promise.all([withContentReadBudget(new AbortController().signal, () => repo.getStatusYears!()),
        withContentReadBudget(new AbortController().signal, () => repo.getStatusYears!())]);
      assert.equal(reads, 4);
    });
    await t.test("a denial between projection and final version check invalidates results", async () => {
      let changed = false;
      const raced: SqlExecutor = { async query<T>(sql: string, values?: unknown[]) {
        const result = await f.reader.query<T>(sql, values);
        if (sql.includes("nb_read_api.read_search_parts(") && !changed) {
          changed = true; await f.db.query("SELECT nb_v2_api.set_denied($1,true)", [first.detail.item.id]);
        }
        return result;
      } };
      await assert.rejects(f.repo("qualified", true, raced).search!({ q: "Vue" }), { code: "INVALID_QUERY" });
    });
    await t.test("reader cannot access internals; other roles cannot call the API", async () => {
      await assert.rejects(f.reader.query("SELECT * FROM nb_read.migrations"), /permission denied/);
      await assert.rejects(f.reader.query("SELECT * FROM nb_v2.records"), /permission denied/);
      await assert.rejects(f.reader.query("SELECT nb_read.current_snapshot('qualified')"), /permission denied/);
      for (const role of ["nb_writer", "anon", "authenticated", "service_role"])
        await assert.rejects(f.role(role).query("SELECT nb_read_api.read_version('qualified')"), /permission denied/);
      await f.db.query("UPDATE nb_read.migrations SET digest=NULL");
      await assert.rejects(f.repo("qualified").get("status", first.detail.item.slug), { code: "CONTENT_UNAVAILABLE" });
      await f.db.query("UPDATE nb_read.migrations SET digest=$1 WHERE version=1", [protocol.migration.sha256]);
      await f.db.query("UPDATE nb_read.migrations SET digest=$1 WHERE version=2", [protocol.searchMigration.sha256]);
      await f.db.query("UPDATE nb_read.migrations SET digest=$1 WHERE version=3", [protocol.traversalMigration.sha256]);
    });
    await t.test("a missing traversal capability fails closed", async () => {
      await f.db.query("UPDATE nb_read.migrations SET digest=NULL WHERE version=3");
      await assert.rejects(f.repo("qualified").get("status", first.detail.item.slug), { code: "CONTENT_UNAVAILABLE" });
      await f.db.query("UPDATE nb_read.migrations SET digest=$1 WHERE version=3", [protocol.traversalMigration.sha256]);
    });
    await t.test("iterative traversal preserves depth-first order and the depth limit", async () => {
      let blocks: unknown[] = [{ type: "paragraph", text: [{ text: "leaf" }] }];
      for (let i = 0; i < 32; i++) blocks = [{ type: "toggle", title: [{ text: `level-${i}` }], children: blocks }];
      const parts = await f.db.query<{ part: string }>("SELECT p AS part FROM nb_read.search_parts($1::jsonb) p", [JSON.stringify(blocks)]);
      assert.deepEqual(parts.rows.map(row => row.part), [...Array.from({ length: 32 }, (_, i) => `level-${31 - i}`), "leaf"]);
      await assert.rejects(f.db.query("SELECT * FROM nb_read.search_parts($1::jsonb)",
        [JSON.stringify([{ type: "toggle", title: [], children: blocks }])]), /NB_UNAVAILABLE/);
    });
    await t.test("qualification expiry and publication epoch invalidation remain mandatory", async () => {
      await f.db.exec("UPDATE nb_v2.runs SET valid_until=clock_timestamp()-interval '1 second'");
      await assert.rejects(f.repo("qualified").readIndex!(["status"]), { code: "CONTENT_UNAVAILABLE" });
      assert.ok(await f.repo("published").readIndex!(["status"]));
      await f.db.exec("UPDATE nb_v2.state SET epoch=epoch+1");
      await assert.rejects(f.repo("published").readIndex!(["status"]), { code: "CONTENT_UNAVAILABLE" });
    });
  } finally { await f.db.close(); }
});

test("a one-item Status page works above the unchanged full-snapshot cap", async () => {
  const f = await setup();
  try {
    const document: ContentDocument = { toc: [], completeness: "complete", blocks: [{ id: "p", type: "paragraph",
      text: Array.from({ length: 750 }, () => ({ text: "x".repeat(1000) })) }] };
    const lease = await f.writer.begin(randomUUID(), f.digest), rows = Array.from({ length: 24 }, (_, i) => status(i, document));
    for (const row of rows) await f.writer.stage(lease, [row]);
    await f.writer.promote(lease, { records: rows.length, media: 0, complete: true });
    const fast = f.repo("qualified"), legacy = f.repo("qualified", false);
    await assert.rejects(legacy.list("status", { limit: 1 }), { code: "CONTENT_UNAVAILABLE" });
    await assert.rejects(fast.readSnapshot!(["status"], true), { code: "CONTENT_UNAVAILABLE" });
    const page = await fast.list("status", { limit: 1 }); assert.equal(page.total, 24); assert.equal(page.items.length, 1);
    assert.deepEqual(page.items[0], (await f.service(fast).list("status", { limit: 1 })).items[0]);
    assert.equal((await fast.readIndex!(["status"])).records.every(r => r.document === null), true);
    const service = f.service(fast);
    assert.equal((await service.getTimeline!({ limit: 1 })).items.length, 1);
    let details = 0;
    const selected = { ...service, get: (async (kind: string, slug: string) => {
      details++; return service.get(kind as "status", slug);
    }) as typeof service.get, getSelected: (async (kind: "status", slugs: string[], version: string) => {
      details += slugs.length; return service.getSelected!(kind, slugs, version);
    }) as typeof service.getSelected };
    const home = createHomeFeedV2Repository({ content: () => readTimelineIndexSnapshot(selected, all, "UTC"),
      hydrateContent: (events, version) => hydrateTimelinePage(selected, all, events, version, "UTC"),
      sources: { content: "database", social: "disabled" }, timeZone: "UTC" });
    const homePage = await home.getPage({ limit: 1 }); assert.equal(homePage.items.length, 1); assert.equal(details, 1);
    const event = homePage.items[0]; assert.equal(event.source, "content");
    if (event.source === "content" && event.event.type === "status") assert.deepEqual(event.event.entry, page.items[0]);
    await f.db.query("SELECT nb_v2_api.set_denied($1,true)", [page.items[0].id]);
    await assert.rejects(fast.list("status", { limit: 1, cursor: page.nextCursor! }), { code: "INVALID_QUERY" });
  } finally { await f.db.close(); }
});

test("scoped mode is explicit and unsupported SQL never reaches the driver", async () => {
  assert.equal(readProjectionMode(undefined), "legacy"); assert.equal(readProjectionMode("scoped"), "scoped");
  assert.throws(() => readProjectionMode("other"), { code: "MISCONFIGURED" });
  await assert.rejects(scopedReader({ query: async () => assert.fail("No driver call") }, "qualified").query("SELECT 1"), { code: "CONTENT_UNAVAILABLE" });
});

test("all content kinds keep their DTOs and search ranking through the scoped reader", async () => {
  const f = await setup();
  try {
    const courseId = fixtureItems.course[0].id;
    const rows: WebsiteRecord[] = CONTENT_KINDS.map(kind => {
      const item = structuredClone(fixtureItems[kind][0]); item.cover = null;
      if (item.kind === "status") { item.href = `/status#${item.id}`; item.text = []; }
      if (item.kind === "study-note") { item.courseId = courseId; item.parentId = null; item.breadcrumbs = []; item.href = `/study/${courseId}/notes/${item.slug}`; }
      return { detail: { item, document: body("Common 中文 token") }, evidence: { sourceKey: kind,
        dataSourceId: kind === "page" ? null : `source-${kind}`, databaseParentId: kind === "study-note" ? courseId : null,
        courseId: kind === "study-note" ? courseId : null, parentId: kind === "study-note" ? courseId : null, ordinal: 0 } };
    });
    const sources = CONTENT_KINDS.map(kind => ({ key: kind, kind, mode: ["course", "study-note", "page"].includes(kind) ? "allowlist" : "all",
      dataSourceId: kind === "page" ? null : `source-${kind}`, databaseParentId: kind === "study-note" ? courseId : null,
      pageId: kind === "page" ? fixtureItems.page[0].id : null }));
    rows.push({detail:{item:{...structuredClone(fixtureItems.course[1]),cover:null},document:body("Second course")},
      evidence:{...rows.find(row=>row.detail.item.kind==="course")!.evidence,ordinal:1}});
    const permits = rows.filter(row => ["course", "study-note", "page"].includes(row.detail.item.kind)).map(row => ({
      id: row.detail.item.id, kind: row.detail.item.kind, sourceKey: row.evidence.sourceKey, courseId: row.evidence.courseId, parentId: row.evidence.parentId }));
    const digest = configDigest([sources, permits]);
    await f.db.query("SELECT nb_v2_api.configure_policy($1,600,$2::jsonb,$3::jsonb)", [digest, JSON.stringify(sources), JSON.stringify(permits)]);
    const lease = await f.writer.begin(randomUUID(), digest); await f.writer.stage(lease, rows); await f.writer.promote(lease, { records: rows.length, media: 0, complete: true });
    const fast = f.service(f.repo("qualified")), legacy = f.service(f.repo("qualified", false));
    for (const kind of CONTENT_KINDS) {
      assert.deepEqual(await fast.list(kind, { limit: 1 }), await legacy.list(kind, { limit: 1 }), kind);
      assert.deepEqual(await fast.get(kind, fixtureItems[kind][0].slug), await legacy.get(kind, fixtureItems[kind][0].slug), kind);
    }
    for (const q of ["Common", "中文", "missing"])
      assert.deepEqual(await fast.search!({ q }), await legacy.search!({ q }));
    assert.deepEqual(await fast.getCourseTree(fixtureItems.course[0].slug), await legacy.getCourseTree(fixtureItems.course[0].slug));
    // No optional extension is installed in this database. A search switch
    // must not turn unrelated course reads into an extension dependency.
    for (const mode of ["filtered", "precomputed", "filtered-scope"] as const) {
      const optional = createWebsiteDatabaseRepository(scopedReader(f.reader, "qualified", mode), { scoped: true, filteredSearch: mode === "filtered", filteredScopeSearch: mode === "filtered-scope" });
      assert.deepEqual(await optional.get("course", fixtureItems.course[0].slug), await legacy.get("course", fixtureItems.course[0].slug));
      assert.deepEqual(await optional.getCourseTree(fixtureItems.course[0].slug), await legacy.getCourseTree(fixtureItems.course[0].slug));
      await assert.rejects(optional.search!({ q: "Common" }), { code: "CONTENT_UNAVAILABLE" });
      await f.db.query("SELECT nb_v2_api.set_denied($1,true)", [courseId]);
      assert.equal(await optional.get("course", fixtureItems.course[0].slug), null);
      assert.equal(await optional.getCourseTree(fixtureItems.course[0].slug), null);
      await f.db.query("SELECT nb_v2_api.set_denied($1,false)", [courseId]);
    }
    const note=rows.find(row=>row.detail.item.kind==="study-note")!.detail.item;
    for(const scoped of [false,true]) {
      let studyCalls=0;
      const counted:SqlExecutor={query:async<T>(sql:string,values?:unknown[])=>{if(sql.includes("/* study-"))studyCalls++;return f.reader.query<T>(sql,values);}};
      const adapter=f.repo("qualified",scoped,counted);
      assert.equal(await adapter.isStudyNoteAvailable!(fixtureItems.course[0].slug,note.slug),true);assert.equal(studyCalls,1);
      assert.equal(await adapter.isStudyNoteAvailable!(fixtureItems.course[1].slug,note.slug),false);
      assert.equal(await adapter.isStudyNoteAvailable!("missing",note.slug),false);
      assert.equal(await adapter.isStudyNoteAvailable!(fixtureItems.course[0].slug,"missing"),false);
      assert.deepEqual((await adapter.readStudyNote!(fixtureItems.course[0].slug,note.slug))?.note,await adapter.get("study-note",note.slug));
      assert.equal((await adapter.readStudyNote!(fixtureItems.course[1].slug,note.slug))?.note,null);
      const before=studyCalls;assert.ok(await adapter.getCourseTree(fixtureItems.course[0].slug));assert.equal(studyCalls,before+1);
      await f.db.query("SELECT nb_v2_api.set_denied($1,true)",[note.id]);
      assert.equal(await adapter.isStudyNoteAvailable!(fixtureItems.course[0].slug,note.slug),false);
      assert.equal((await adapter.readStudyNote!(fixtureItems.course[0].slug,note.slug))?.note,null);
      assert.equal((await adapter.getCourseTree(fixtureItems.course[0].slug))!.nodes.length,0);
      await f.db.query("SELECT nb_v2_api.set_denied($1,false)",[note.id]);
      await f.db.query("SELECT nb_v2_api.set_denied($1,true)",[courseId]);
      assert.equal(await adapter.isStudyNoteAvailable!(fixtureItems.course[0].slug,note.slug),false);
      assert.equal(await adapter.getCourseTree(fixtureItems.course[0].slug),null);
      await f.db.query("SELECT nb_v2_api.set_denied($1,false)",[courseId]);
    }
    const disabled = f.service(f.repo("qualified"), { ...all, status: false });
    assert.equal((await disabled.search!({ q: "Common", kinds: ["status"] })).total, 0);
  } finally { await f.db.close(); }
});

test("database and paged home feeds retain game playtime without detail reads or withdrawn games", async () => {
  const f = await setup();
  try {
    const sources = [{ key: "games", kind: "game", mode: "all", dataSourceId: "source-games", databaseParentId: null, pageId: null }];
    const digest = configDigest(sources);
    await f.db.query("SELECT nb_v2_api.configure_policy($1,600,$2::jsonb,'[]')", [digest, JSON.stringify(sources)]);
    const amounts: (TimeAmount | null)[] = [{ value: 120.25, unit: "hour" }, { value: 95, unit: "minute" }, null, { value: 0, unit: "hour" }];
    const states: Game["status"][] = ["playing", "clear", "platinumed", "playing"];
    const records: WebsiteRecord[] = amounts.map((playedTime, index) => {
      const id = `timeline-game-${index}`;
      return { detail: { item: { ...structuredClone(fixtureItems.game[0]), id, slug: id, href: `/library/games/${id}`,
        cover: null, status: states[index], playedTime }, document: body("") },
        evidence: { sourceKey: "games", dataSourceId: "source-games", databaseParentId: null, courseId: null, parentId: null, ordinal: index } };
    });
    const lease = await f.writer.begin(randomUUID(), digest);
    await f.writer.stage(lease, records);
    await f.writer.promote(lease, { records: records.length, media: 0, complete: true });
    await f.db.query("SELECT nb_publication_api.activate($1)", [lease.runId]);
    for (const mode of ["qualified", "published"] as const) {
      const fast = f.service(f.repo(mode)), legacy = f.service(f.repo(mode, false));
      const timeline = await fast.getTimeline!({ limit: 50 });
      assert.deepEqual(timeline, await legacy.getTimeline!({ limit: 50 }));
      const selected = { ...fast, get: (async () => assert.fail("Game timeline must not fetch details")) as typeof fast.get };
      const home = createHomeFeedV2Repository({ content: () => readTimelineIndexSnapshot(selected, all, "UTC"),
        hydrateContent: (events, version) => hydrateTimelinePage(selected, all, events, version, "UTC"),
        sources: { content: "database", social: "disabled" }, timeZone: "UTC" });
      const seen = new Set<string>(); let cursor: string | undefined, firstCursor: string | undefined;
      do {
        const params = new URLSearchParams({ limit: "2", ...(cursor ? { cursor } : {}) });
        const response = await homeFeedResponse(new Request(`https://example.test/api/home/feed-v2?${params}`), home);
        assert.equal(response.status, 200);
        const { data } = await response.json() as { data: HomeFeedV2Page };
        for (const item of data.items) {
          assert.equal(item.source, "content");
          if (item.source !== "content" || item.event.type === "status") assert.fail("Expected game event");
          assert.equal(seen.has(item.id), false); seen.add(item.id);
          const event = item.event, index = records.findIndex(record => record.detail.item.href === event.href);
          assert.notEqual(index, -1); assert.deepEqual(event.playedTime, amounts[index]);
        }
        cursor = data.nextCursor ?? undefined; firstCursor ??= cursor;
      } while (cursor);
      assert.equal(seen.size, records.length); assert.ok(firstCursor);
      if (mode === "published") {
        await f.db.query("SELECT nb_v2_api.set_denied($1,true)", [records[0].detail.item.id]);
        const fresh = await home.getPage({ limit: 50 });
        assert.equal(fresh.total, records.length - 1);
        assert.equal(fresh.items.some(item => item.source === "content" && item.event.type !== "status" && item.event.href === records[0].detail.item.href), false);
        await assert.rejects(home.getPage({ limit: 2, cursor: firstCursor }), { code: "INVALID_QUERY" });
      }
    }
  } finally { await f.db.close(); }
});

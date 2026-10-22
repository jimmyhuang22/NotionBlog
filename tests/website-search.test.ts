import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { fixtureItems } from "../fixtures/content.ts";
import { CONTENT_KINDS, type ContentFeatures } from "../config/features.ts";
import type { ContentDocument } from "../contracts/content.ts";
import type { WebsiteRecord } from "../contracts/website-sync.ts";
import { WEBSITE_SCHEMA_DIGEST } from "../contracts/website-sync.ts";
import { createContentService } from "../src/lib/content/factory.ts";
import { createWebsiteDatabaseRepository } from "../src/server/database/website-repository.ts";
import { createWebsiteWriter } from "../src/server/database/website-writer.ts";
import { configDigest, mediaIdentity } from "../src/server/database/website-validation.ts";
import type { SqlExecutor } from "../src/server/database/sql.ts";
import { WEBSITE_CONTENT_SQL } from "../src/server/database/website-projection.ts";

const features = Object.fromEntries(CONTENT_KINDS.map(kind => [kind, true])) as ContentFeatures;
function record(index: number, document: ContentDocument): WebsiteRecord {
  const item = structuredClone(fixtureItems.status[0]);
  item.id = `search-status-${index}`; item.slug = item.id; item.href = `/status#${item.id}`;
  item.title = `Sample ${index}`; item.cover = null; item.text = []; item.summary = null;
  return { detail: { item, document }, evidence: { sourceKey: "statuses", dataSourceId: "source-statuses",
    databaseParentId: null, courseId: null, parentId: null, ordinal: index } };
}
async function setup() {
  const db = await PGlite.create();
  for (const path of ["database/migrations/001_content.sql", "database/website-migrations/001_website.sql",
    "database/website-media-migrations/001_website_media_sources.sql", "supabase/migrations/20261011123536_media_thumbnails.sql",
    "supabase/migrations/20261016121202_website_last_success.sql"])
    await db.exec(await readFile(new URL("../" + path, import.meta.url), "utf8"));
  await db.query("UPDATE nb_v2.state SET schema_digest=$1", [WEBSITE_SCHEMA_DIGEST]);
  const sources = [{ key: "statuses", kind: "status", mode: "all", dataSourceId: "source-statuses", databaseParentId: null, pageId: null }];
  const digest = configDigest(sources);
  await db.query("SELECT nb_v2_api.configure_policy($1,600,$2::jsonb,'[]'::jsonb)", [digest, JSON.stringify(sources)]);
  const role = (name: string): SqlExecutor => ({ query: <T>(sql: string, values?: unknown[]) => db.transaction(async tx => {
    await tx.exec(`SET LOCAL ROLE ${name}`); return tx.query<T>(sql, values);
  }) });
  const reader = role("nb_reader"), writer = createWebsiteWriter(role("nb_writer"));
  const service = (executor = reader, enabled = features) => createContentService({ provider: "database", features: enabled,
    databaseRepository: createWebsiteDatabaseRepository(executor) }).repository;
  return { db, digest, reader, writer, service };
}

test("bounded search preserves readable AST order, filtering, retained content and withdrawals", async t => {
  const f = await setup();
  try {
    const imageBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC1lEQVR42mP8/x8AAusB9Y9ZL98AAAAASUVORK5CYII=", "base64");
    const sha = createHash("sha256").update(imageBytes).digest("hex"), owner = "search-status-2";
    const asset = mediaIdentity("search-status-1", "image", sha), image = { id: asset, src: `/media/v2/${asset}`, alt: "altsecret", width: 1, height: 1 };
    const text = (value: string) => [{ text: value }];
    const document: ContentDocument = { toc: [{ id: "heading", title: "tocsecret", level: 1 }], completeness: "complete", blocks: [
      { id: "p", type: "paragraph", text: text("Vue ＡＢＣ 中文") },
      { id: "h", type: "heading", level: 1, text: text("heading") },
      { id: "toggle", type: "toggle", title: text("toggle"), children: [{ id: "child", type: "paragraph", text: text("child") }] },
      { id: "callout", type: "callout", tone: "info", icon: null, text: text("callout"), children: [{ id: "c", type: "paragraph", text: text("nested") }] },
      { id: "list", type: "list", ordered: false, items: [{ id: "one", checked: null, text: text("first"), children: [{ id: "li", type: "paragraph", text: text("inner") }] }, { id: "two", checked: null, text: text("second"), children: [] }] },
      { id: "columns", type: "columns", columns: [{ ratio: null, blocks: [{ id: "co", type: "paragraph", text: text("column") }] }] },
      { id: "table", type: "table", hasColumnHeader: false, hasRowHeader: false, rows: [[text("cellone"), text("celltwo")]] },
      { id: "code", type: "code", language: "text", code: "codeword", caption: text("codecaption") },
      { id: "equation", type: "equation", expression: "formula" },
      { id: "bookmark", type: "bookmark", title: "bookmark", description: "description", url: "https://example.test/urlsecret" },
      { id: "image", type: "image", image, caption: text("captionsecret") },
      { id: "links", type: "paragraph", text: [{ text: "linksecret", link: { kind: "internal", href: "/status#search-status-2" } }, { text: "hiddenrun", link: { kind: "unavailable" } }] },
      { id: "unsupported", type: "unsupported", label: "labelsecret" },
    ] };
    const batch = [record(1, document), record(2, { blocks: [{ id: "p2", type: "paragraph", text: text("Vue other") }], toc: [], completeness: "complete" })];
    const lease = await f.writer.begin(randomUUID(), f.digest);
    await f.writer.stage(lease, batch, [{ assetId: asset, ownerPageId: "search-status-1", objectKey: `sha256/${sha}`, sha256: sha,
      byteSize: imageBytes.length, mime: "image/png", width: 1, height: 1 }]);
    await f.writer.promote(lease, { records: 2, media: 1, complete: true });
    const repository = createWebsiteDatabaseRepository(f.reader);
    const legacy = createContentService({ provider: "database", features,
      databaseRepository: { ...repository, search: undefined } }).repository;
    const search = f.service().search!;
    await t.test("existing excerpts, Unicode, nested order and ranking are unchanged", async () => {
      for (const q of ["Vue", "abc", "中文", "toggle child", "first inner second", "cellone celltwo", "codeword codecaption", "bookmark description", "captionsecret", "Sample", "urlsecret", "altsecret", "tocsecret", "labelsecret", "hiddenrun"])
        assert.deepEqual(await search({ q, limit: 50 }), await legacy.search!({ q, limit: 50 }), q);
      const first = await search({ q: "Vue", limit: 1 }); assert.ok(first.nextCursor);
      assert.equal((await search({ q: "Vue", limit: 1, cursor: first.nextCursor! })).items.length, 1);
      assert.equal((await search({ q: "Vue", kinds: ["movie"] })).total, 0);
      const disabled = f.service(f.reader, { ...features, status: false });
      assert.equal((await disabled.search!({ q: "Vue" })).total, 0);
    });
    await t.test("retention, ancestor-safe reader functions and current denials still govern search", async () => {
      await f.db.query("UPDATE nb_v2.runs SET valid_until=statement_timestamp()-interval '1 second' WHERE id=$1", [lease.runId]);
      await assert.rejects(search({ q: "Vue" }), { code: "CONTENT_UNAVAILABLE" });
      await f.db.exec("UPDATE nb_availability.policy SET retain_last_success=true");
      const page = await search({ q: "Vue", limit: 1 }); assert.equal(page.total, 2);
      await f.db.query("SELECT nb_v2_api.set_denied($1,true)", [owner]);
      assert.equal((await search({ q: "Vue" })).total, 1);
      await f.db.query("DELETE FROM nb_v2.media WHERE asset_id=$1", [asset]);
      for (const q of ["linksecret", "captionsecret"])
        assert.deepEqual(await search({ q }), await legacy.search!({ q }));
      assert.equal((await search({ q: "captionsecret" })).total, 0);
      await assert.rejects(search({ q: "Vue", limit: 1, cursor: page.nextCursor! }), { code: "INVALID_QUERY" });
    });
    await t.test("a denial before the final generation check invalidates the whole response", async () => {
      let changed = false;
      const raced: SqlExecutor = { async query<T>(sql: string, values?: unknown[]) {
        const result = await f.reader.query<T>(sql, values);
        if (sql === WEBSITE_CONTENT_SQL && !changed) { changed = true; await f.db.query("SELECT nb_v2_api.set_denied($1,true)", ["search-status-1"]); }
        return result;
      } };
      await assert.rejects(f.service(raced).search!({ q: "Vue" }), { code: "INVALID_QUERY" });
    });
  } finally { await f.db.close(); }
});

test("all-site search works above the frozen full-AST export cap without increasing it", async () => {
  const f = await setup();
  try {
    const document: ContentDocument = { toc: [], completeness: "complete", blocks: [{ id: "p", type: "paragraph",
      text: Array.from({ length: 1800 }, () => ({ text: "searchword", link: { kind: "external" as const,
        url: "https://example.test/" + "irrelevant-url-".repeat(25) } })) }] };
    const batch = Array.from({ length: 26 }, (_, i) => record(i, document));
    assert.ok(Buffer.byteLength(JSON.stringify(batch.map(x => x.detail))) > 16 * 1024 * 1024);
    const small = Array.from({ length: 975 }, (_, i) => record(i + 26, {
      toc: [], completeness: "complete", blocks: [{ id: "p", type: "paragraph", text: [{ text: "lastpageword" }] }],
    }));
    small.at(-1)!.detail.item.title = "zzzz last page";
    const lease = await f.writer.begin(randomUUID(), f.digest);
    for (const row of batch) await f.writer.stage(lease, [row]);
    for (let offset = 0; offset < small.length; offset += 100) await f.writer.stage(lease, small.slice(offset, offset + 100));
    await f.writer.promote(lease, { records: batch.length + small.length, media: 0, complete: true });
    await assert.rejects(createWebsiteDatabaseRepository(f.reader).readSnapshot!(["status"], true), { code: "CONTENT_UNAVAILABLE" });
    let calls = 0;
    const measured: SqlExecutor = { async query<T>(sql: string, values?: unknown[]) {
      const result = await f.reader.query<T>(sql, values); calls++; return result;
    } };
    const result = await f.service(measured).search!({ q: "searchword", limit: 50 });
    assert.equal(result.total, 26); assert.equal(calls, CONTENT_KINDS.length + 11);
    assert.equal((await f.service().search!({ q: "lastpageword" })).total, 975);
    assert.equal((await f.service().search!({ q: "irrelevant-url" })).total, 0);
    await assert.rejects(f.service({ query: async () => assert.fail("Invalid input must not reach SQL") }).search!({ q: " " }), { code: "INVALID_QUERY" });
  } finally { await f.db.close(); }
});

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import type { DataSourceObjectResponse, PageObjectResponse } from "@notionhq/client";
import type { Movie } from "../contracts/content.ts";
import type { WebsiteRecord } from "../contracts/website-sync.ts";
import { WEBSITE_SCHEMA_DIGEST } from "../contracts/website-sync.ts";
import { CONTENT_KINDS, type ContentFeatures } from "../config/features.ts";
import { fixtureItems } from "../fixtures/content.ts";
import { createMockRepository } from "../adapters/mock-repository.ts";
import { movieRatingFact, workFactText } from "../src/lib/library.ts";
import { normalizeMovieRatingSource } from "../src/lib/content/movie-rating.ts";
import { contentListResponse, contentDetailResponse } from "../src/lib/content/http.ts";
import { parseWebsiteNotionConfig } from "../src/server/notion/website-config.ts";
import { createWebsiteNotionRepository } from "../src/server/notion/website-repository.ts";
import type { NotionReadClient } from "../src/server/notion/types.ts";
import { validateWebsiteRecord } from "../src/server/database/website-validation.ts";
import { createWebsiteWriter } from "../src/server/database/website-writer.ts";
import { createWebsiteDatabaseRepository } from "../src/server/database/website-repository.ts";
import type { SqlExecutor } from "../src/server/database/sql.ts";
import { runWebsiteSync, websitePolicy } from "../scripts/website-sync/worker.ts";

const id = (n: number) => n.toString(16).padStart(32, "0");
const rich = (text: string) => ({ type: "text", plain_text: text, text: { content: text, link: null }, href: null,
  annotations: { bold: false, italic: false, underline: false, strikethrough: false, code: false, color: "default" } });
function fixture(legacy = false) {
  const pages = ["豆瓣", "Bangumi", "1905电影网"].map((source, index) => ({
    object: "page", id: id(index + 2), parent: { type: "data_source_id", data_source_id: id(1) }, cover: null,
    archived: false, in_trash: false, last_edited_time: "2026-10-10T12:00:00Z",
    properties: {
      Name: { id: "title", type: "title", title: [rich(`Fictional movie ${index}`)] },
      Score: { id: "s", type: "number", number: index === 2 ? 0 : 8.2 },
      Legacy: { id: "l", type: "number", number: 9.1 },
      Source: { id: "rs", type: "rich_text", rich_text: [rich(source)] },
      Personal: { id: "p", type: "number", number: 4 },
      Status: { id: "st", type: "select", select: { name: "Watched" } },
      PrivateNotes: { id: "pn", type: "rich_text", rich_text: [rich("Private research notes must not enter the DTO")] },
    },
  })) as unknown as PageObjectResponse[];
  const fields = legacy ? { title: "Name", doubanRating: "Legacy" } : { title: "Name", doubanRating: "Legacy", publicRating: "Score", ratingSource: "Source", rating: "Personal", status: "Status" };
  const config = parseWebsiteNotionConfig({ schemaVersion: 2, sources: [{ key: "synthetic-movies", kind: "movie", enabled: true,
    dataSourceId: id(1), fields, statusMap: { Watched: "watched" }, publication: { mode: "all" } }] });
  const client: NotionReadClient = {
    getPage: async key => structuredClone(pages.find(page => page.id === key) ?? null),
    getDataSource: async () => ({ id: id(1), properties: Object.fromEntries(Object.entries(pages[0]!.properties).map(([name, p]) => [name, { id: p.id, type: p.type }])) }) as DataSourceObjectResponse,
    getBlock: async () => null, listBlocks: async () => [], listPages: async () => structuredClone(pages),
  };
  return { pages, client, config };
}

test("movie score labels preserve provenance, real zero and explicit unknowns without guessing legacy sources", async () => {
  for (const [source, label] of [["douban", "豆瓣评分"], ["bangumi", "Bangumi 评分"], ["1905", "1905电影网评分"]] as const) {
    const fact = movieRatingFact({ publicRating: 8.2, ratingSource: source, doubanRating: 9.1 })!;
    assert.deepEqual(fact, [label, "8.2"]);
    assert.equal(workFactText(...fact, "movie"), `${label} 8.2`);
  }
  assert.deepEqual(movieRatingFact({ publicRating: 0, ratingSource: "1905", doubanRating: 9.1 }), ["1905电影网评分", "0"]);
  assert.equal(movieRatingFact({ publicRating: null, ratingSource: "bangumi", doubanRating: 9.1 }), null);
  assert.deepEqual(movieRatingFact({ doubanRating: 8.2 }), ["公共评分", "8.2"]);
  assert.deepEqual(movieRatingFact({ publicRating: 8.2, ratingSource: null, doubanRating: null }), ["公共评分", "8.2"]);
  assert.equal(movieRatingFact({ doubanRating: null }), null);
  assert.equal(workFactText(...movieRatingFact({ publicRating: 8.2, ratingSource: null, doubanRating: null })!, "movie"), "公共评分 8.2");
  assert.equal(workFactText("豆瓣评分", "8.2", "book"), "豆瓣 8.2");
  assert.equal(normalizeMovieRatingSource(" Douban "), "douban");
  assert.equal(normalizeMovieRatingSource("1905电影网"), "1905");
  assert.equal(normalizeMovieRatingSource("unverified source with private notes"), null);
  const legacy = (await createMockRepository().list("movie", { limit: 50 })).items.find(item => item.doubanRating !== null)!;
  assert.deepEqual(movieRatingFact(legacy), ["公共评分", String(legacy.doubanRating)]);
});

test("Notion mapping carries configured public scores separately from legacy values and personal ratings", async () => {
  const f = fixture(), repo = createWebsiteNotionRepository({ client: f.client, config: f.config });
  const rows = await repo.collectRecords(false);
  for (const [index, source] of (["douban", "bangumi", "1905"] as const).entries()) {
    const item = rows.find(row => row.detail.item.id === id(index + 2))!.detail.item as Movie;
    assert.equal(item.publicRating, index === 2 ? 0 : 8.2);
    assert.equal(item.ratingSource, source);
    assert.equal(item.doubanRating, 9.1);
    assert.equal(item.rating?.value, 4);
    validateWebsiteRecord(rows.find(row => row.detail.item.id === item.id)!);
    assert.equal(JSON.stringify(item).includes("Private research"), false);
  }
  const legacy = fixture(true), old = (await createWebsiteNotionRepository({ client: legacy.client, config: legacy.config }).list("movie")).items[0]!;
  assert.equal(old.publicRating, 9.1); assert.equal(old.ratingSource, null);
  const fields = { ...legacy.config.sources[0]!.fields, ratingSource: "Source" };
  const mapped = createWebsiteNotionRepository({ client: legacy.client, config: { ...legacy.config, sources: [{ ...legacy.config.sources[0]!, fields }] } });
  assert.equal((await mapped.get("movie", id(2)))!.item.ratingSource, "douban");
  (f.pages[0]!.properties.Score as { number: number | null }).number = null;
  const missing = (await repo.get("movie", id(2)))!.item;
  assert.equal(missing.publicRating, null); assert.equal(missing.ratingSource, null);
  assert.equal(movieRatingFact(missing), null);
});

test("invalid source movie scores become explicit unknowns without blocking other records or leaking diagnostics", async t => {
  const f = fixture(), repo = createWebsiteNotionRepository({ client: f.client, config: f.config });
  const warnings = t.mock.method(console, "warn", () => {});
  for (const score of [85, 10.01, -1, Number.NaN, Number.POSITIVE_INFINITY, null, 0, 10]) {
    (f.pages[0]!.properties.Score as { number: number | null }).number = score;
    const expected = score !== null && Number.isFinite(score) && score >= 0 && score <= 10 ? score : null;
    const listed = await repo.list("movie");
    assert.equal(listed.total, 3);
    const item = listed.items.find(row => row.id === id(2))!;
    assert.equal(item.publicRating, expected);
    assert.equal(item.ratingSource, expected === null ? null : "douban");
    assert.equal(item.doubanRating, 9.1, "keep the separately mapped legacy value");
    assert.equal(item.rating?.value, 4);
    if (expected === null) assert.equal(movieRatingFact(item), null, "do not fall back to the legacy score");
    assert.equal(listed.items.find(row => row.id === id(3))!.publicRating, 8.2);
    assert.equal(listed.items.find(row => row.id === id(4))!.publicRating, 0);
  }
  assert.equal(warnings.mock.callCount(), 2, "only the two newly rejected upper-bound values warn");
  (f.pages[0]!.properties.Score as { number: number }).number = 85;
  assert.equal((await repo.getLibraryYears!("movie")).undatedCount, 3);
  assert.equal((await repo.getContentMetadata!("movie", id(2)))!.publicRating, null);
  assert.equal((await repo.get("movie", id(2)))!.item.publicRating, null);
  const collected = await repo.collectRecords();
  assert.equal(collected.length, 3);
  for (const record of collected) validateWebsiteRecord(record);
  const single = await repo.collectRecord(id(2), { kind: "movie", ordinal: 0 });
  assert.equal((single!.detail.item as Movie).publicRating, null);
  validateWebsiteRecord(single!);
  const legacy = fixture(true);
  (legacy.pages[0]!.properties.Legacy as { number: number }).number = 85;
  const old = (await createWebsiteNotionRepository({ client: legacy.client, config: legacy.config }).get("movie", id(2)))!.item;
  assert.equal(old.publicRating, null); assert.equal(old.ratingSource, null);
  assert.equal(old.doubanRating, 85); assert.equal(movieRatingFact(old), null);
  assert.ok(warnings.mock.callCount() > 0);
  for (const call of warnings.mock.calls) assert.deepEqual(call.arguments, ["NOTION_MOVIE_PUBLIC_RATING_INVALID"]);
  f.client.listPages = async () => { throw new Error("synthetic upstream failure"); };
  await assert.rejects(repo.list("movie"), /synthetic upstream failure/);
});

test("optional rating fields reject malformed payloads while old movie records remain valid", () => {
  const item = { ...structuredClone(fixtureItems.movie[0]!), cover: null };
  const record: WebsiteRecord = { detail: { item, document: null }, evidence: { sourceKey: "movies", dataSourceId: "synthetic-source", databaseParentId: null, courseId: null, parentId: null, ordinal: 0 } };
  validateWebsiteRecord(record);
  for (const publicRating of [null, 0, 10, 8.2]) validateWebsiteRecord({ ...record, detail: { ...record.detail, item: { ...item, publicRating, ratingSource: "bangumi" } } });
  for (const publicRating of [-1, 10.1, Number.NaN, Number.POSITIVE_INFINITY, "8.2", {}]) {
    assert.throws(() => validateWebsiteRecord({ ...record, detail: { ...record.detail, item: { ...item, publicRating } as Movie } }));
  }
  for (const ratingSource of ["private note", 3, {}, ["douban"]]) {
    assert.throws(() => validateWebsiteRecord({ ...record, detail: { ...record.detail, item: { ...item, ratingSource } as Movie } }));
  }
});

test("real restricted SQL preserves score sources through publication, list, detail, metadata and HTTP with withdrawal", async t => {
  const f = fixture(), db = await PGlite.create(); t.after(() => db.close());
  await db.exec("CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;");
  await db.exec(await readFile(new URL("../database/website-migrations/001_website.sql", import.meta.url), "utf8"));
  await db.query("UPDATE nb_v2.state SET schema_digest=$1", [WEBSITE_SCHEMA_DIGEST]);
  const policy = await websitePolicy(f.client, f.config, 600);
  await db.query("SELECT nb_v2_api.configure_policy($1,600,$2::jsonb,$3::jsonb)", [policy.configDigest, JSON.stringify(policy.sources), JSON.stringify(policy.permits)]);
  const role = (name: string): SqlExecutor => ({ query: <T>(sql: string, values?: unknown[]) => db.transaction(async tx => { await tx.exec(`SET LOCAL ROLE ${name}`); return tx.query<T>(sql, values); }) });
  const writer = createWebsiteWriter(role("nb_writer")), reader = createWebsiteDatabaseRepository(role("nb_reader"));
  const storage = { put: async () => assert.fail("No media work"), read: async () => { assert.fail("No media work"); return new Uint8Array(); } };
  await runWebsiteSync({ client: f.client, config: f.config, writer, storage, mode: "publish" });
  const features = Object.fromEntries(CONTENT_KINDS.map(kind => [kind, kind === "movie"])) as ContentFeatures;
  const listed = await reader.list("movie", { limit: 50 });
  assert.equal(listed.total, 3);
  for (const item of listed.items) {
    const detail = (await reader.get("movie", item.slug))!.item;
    const metadata = (await reader.getContentMetadata!("movie", item.slug))!;
    const snapshot = (await reader.readSnapshot!(["movie"])).records.find(row => row.item.id === item.id)!.item;
    for (const result of [detail, metadata, snapshot]) assert.deepEqual(result, item);
    const response = await contentDetailResponse(new Request("https://example.test/detail"), "movie", item.slug, reader, features);
    assert.equal(response.status, 200);
    const payload = await response.text(); assert.ok(payload.includes('"ratingSource"')); assert.equal(payload.includes("Private research"), false);
  }
  const response = await contentListResponse(new Request("https://example.test/api/content/movie"), "movie", reader, features);
  assert.equal((await response.json()).data.items.length, 3);
  const warnings = t.mock.method(console, "warn", () => {});
  (f.pages[0]!.properties.Score as { number: number }).number = 85;
  await runWebsiteSync({ client: f.client, config: f.config, writer, storage, mode: "publish" });
  const invalid = (await reader.get("movie", id(2)))!.item;
  assert.equal(invalid.publicRating, null); assert.equal(invalid.ratingSource, null);
  assert.equal(invalid.doubanRating, 9.1); assert.equal(movieRatingFact(invalid), null);
  assert.equal((await reader.list("movie")).total, 3);
  assert.equal((await reader.getLibraryYears!("movie")).undatedCount, 3);
  assert.equal((await reader.get("movie", id(3)))!.item.publicRating, 8.2);
  const invalidResponse = await contentDetailResponse(new Request("https://example.test/detail"), "movie", id(2), reader, features);
  assert.equal(invalidResponse.status, 200);
  assert.equal((await invalidResponse.json()).data.item.publicRating, null);
  assert.ok(warnings.mock.callCount() > 0);
  const rows = await createWebsiteNotionRepository({ client: f.client, config: f.config }).collectRecords();
  for (const row of rows) { delete (row.detail.item as Movie).publicRating; delete (row.detail.item as Movie).ratingSource; }
  const lease = await writer.begin(randomUUID(), policy.configDigest);
  await writer.stage(lease, rows); await writer.promote(lease, { records: rows.length, media: 0, complete: true });
  const legacy = (await reader.get("movie", id(2)))!.item;
  assert.equal(legacy.publicRating, undefined); assert.equal(legacy.ratingSource, undefined);
  assert.deepEqual(movieRatingFact(legacy), ["公共评分", "9.1"]);
  await db.query("SELECT nb_v2_api.set_denied($1,true)", [id(2)]);
  assert.equal(await reader.get("movie", id(2)), null);
  assert.equal((await reader.list("movie")).items.some(item => item.id === id(2)), false);
});

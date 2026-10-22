import test from "node:test";
import assert from "node:assert/strict";
import type { AnyContent, LibraryKind } from "../contracts/content.ts";
import { ContentServiceError } from "../contracts/repository.ts";
import { CONTENT_KINDS, contentFeatures } from "../config/features.ts";
import { fixtureItems } from "../fixtures/content.ts";
import { createMockRepository } from "../adapters/mock-repository.ts";
import { createContentService } from "../src/lib/content/factory.ts";
import { contentYear } from "../src/lib/content/years.ts";
import { parseListQuery, parseLibraryYearsQuery } from "../src/lib/content/query.ts";
import { libraryYearsResponse, contentListResponse } from "../src/lib/content/http.ts";
import { createWebsiteDatabaseRepository } from "../src/server/database/website-repository.ts";
import { WEBSITE_SCHEMA_DIGEST } from "../contracts/website-sync.ts";
import { qualifyRoute } from "../src/lib/qualify-route.ts";
import { itemDate } from "../src/lib/library.ts";
import { compareContent, contentDate } from "../src/lib/content/website.ts";

const kinds: LibraryKind[] = ["movie", "book", "game"];
const all = Object.fromEntries(CONTENT_KINDS.map(kind => [kind, true])) as typeof contentFeatures;
const invalid = (error: unknown) => error instanceof ContentServiceError && error.code === "INVALID_QUERY";

test("library years use experience start dates, local New Year and date-only precision without substitutions", () => {
  for (const kind of kinds) {
    const item = structuredClone(fixtureItems[kind][0]);
    const field = kind === "movie" ? "watchedDate" : kind === "book" ? "readingDate" : "playedDate";
    const set = (value: unknown) => Object.assign(item, { [field]: value });
    set({ start: "2025-12-31T14:30:00Z", end: "2027-01-01T00:00:00Z", precision: "datetime" });
    assert.equal(contentYear(item, "Australia/Melbourne"), kind === "game" ? 2027 : 2026);
    assert.equal(contentYear(item, "UTC"), kind === "game" ? 2027 : 2025);
    set({ start: "2025-12-31", end: "2026-01-02", precision: "date" });
    assert.equal(contentYear(item, "Australia/Melbourne"), kind === "game" ? 2026 : 2025);
    set(null);
    Object.assign(item, { updatedAt: "2026-01-01T00:00:00Z", releaseDate: { start: "2020-01-01", end: null, precision: "date" } });
    assert.equal(contentYear(item, "UTC"), null);
  }
});

test("library queries allow combined year/status/order, restrict summaries and reject invalid values", () => {
  for (const kind of kinds) {
    assert.deepEqual(parseListQuery(kind, new URLSearchParams("year=2026&status=wishlist&order=title-asc")), { year: 2026, status: "wishlist", order: "title-asc" });
    assert.deepEqual(parseLibraryYearsQuery(kind, new URLSearchParams("status=wishlist")), { status: "wishlist" });
    for (const query of ["year=0", "year=2026.1", "year=02026", "year=2026&year=2025", "status=not-a-state"]) {
      assert.throws(() => parseListQuery(kind, new URLSearchParams(query)), invalid);
    }
    for (const query of ["year=2026", "limit=12", "order=date-desc", "status=wishlist&status=wishlist", "cursor=abc", "tag=x"]) {
      assert.throws(() => parseLibraryYearsQuery(kind, new URLSearchParams(query)), invalid);
    }
  }
  for (const kind of ["post", "course", "album", "project"] as const) assert.throws(() => parseListQuery(kind, new URLSearchParams("year=2026")), invalid);
});

test("game browsing remains in the personal experience year despite later platform play", async () => {
  const experience = { start: "2023-06-01", end: "2023-08-01", precision: "date" as const };
  const latest = { start: "2025-12-31T14:30:00.000Z", end: null, precision: "datetime" as const };
  const game = { ...structuredClone(fixtureItems.game[0]), playedDate: experience, lastPlayedDate: latest };
  assert.equal(contentYear(game, "Australia/Melbourne"), 2023);
  assert.equal(contentYear(game, "UTC"), 2023);
  assert.deepEqual(itemDate(game), { start: "2023-08-01", end: null, precision: "date" });
  assert.deepEqual(contentDate(game), itemDate(game));
  const legacy = { ...game, lastPlayedDate: undefined };
  assert.deepEqual(itemDate(legacy), { start: "2023-08-01", end: null, precision: "date" });
  assert.equal(contentYear(legacy, "UTC"), 2023);
  assert.equal(contentYear({ ...game, lastPlayedDate: null }, "UTC"), 2023);
  assert.equal(contentYear({ ...legacy, playedDate: null, updatedAt: "2026-10-14T00:00:00Z" }, "UTC"), null);
  assert.equal(compareContent(game, legacy, "date-desc"), 0);
  assert.equal(compareContent(game, legacy, "date-asc"), 0);
  assert.deepEqual(game.playedDate, experience);

  const mock = createMockRepository();
  const sample = fixtureItems.game.find(item => item.status === "playing" && item.lastPlayedDate && item.playedDate === null)!;
  const listed = await mock.list("game", { status: "playing", year: "undated", limit: 50 });
  assert.ok(listed.items.some(item => item.id === sample.id));
  assert.ok(!(await mock.list("game", { status: "playing", year: 2025, limit: 50 })).items.some(item => item.id === sample.id));
  const years = await mock.getLibraryYears!("game", { status: "playing" });
  assert.equal(years.undatedCount, listed.total);
});

test("mock status-specific summaries agree with every year list, pagination, totals and unknown dates", async () => {
  const repo = createContentService({ features: all, timeZone: "Australia/Melbourne" }).repository;
  for (const kind of kinds) {
    const statuses = [...new Set(fixtureItems[kind].map(item => item.status)), ...(kind === "game" ? ["completed"] : [])];
    for (const status of [undefined, ...statuses]) {
      const query = status ? { status } : {};
      const years = await repo.getLibraryYears!(kind, query);
      const total = (await repo.list(kind, { ...query, limit: 50 })).total;
      assert.equal(years.undatedCount + years.years.reduce((sum, value) => sum + value.count, 0), total);
      for (const { year, count } of [...years.years, { year: "undated" as const, count: years.undatedCount }]) {
        let cursor: string | undefined;
        const ids = new Set<string>();
        do {
          const page = await repo.list(kind, { ...query, year, order: "title-asc", limit: 2, ...(cursor ? { cursor } : {}) });
          assert.equal(page.total, count);
          for (const item of page.items) { assert.ok(!ids.has(item.id)); ids.add(item.id); }
          cursor = page.nextCursor ?? undefined;
        } while (cursor);
        assert.equal(ids.size, count);
      }
    }
    assert.equal(await qualifyRoute(`/library/${kind === "movie" ? "movies" : kind === "book" ? "books" : "games"}`, all, repo, new URLSearchParams("year=2026&status=wishlist")), true);
  }
  let zone = "Australia/Melbourne";
  const raw = createMockRepository({ timeZone: () => zone });
  const first = await raw.list("movie", { limit: 1 });
  assert.ok(first.nextCursor);
  for (const filters of [{ year: 2026 }, { year: "undated" as const }, { status: "wishlist" }, { order: "title-asc" as const }]) {
    await assert.rejects(raw.list("movie", { limit: 1, cursor: first.nextCursor!, ...filters }), invalid);
  }
  zone = "UTC";
  await assert.rejects(raw.list("movie", { limit: 1, cursor: first.nextCursor! }), invalid);
});

test("database summaries use one metadata SQL read, current projection and status grouping including completed", async () => {
  const items: AnyContent[] = ["clear", "platinumed", "wishlist"].map((status, i) => ({ ...structuredClone(fixtureItems.game[0]), id: `test-${i}`, status: status as "clear" | "platinumed" | "wishlist", playedDate: i === 2 ? null : { start: "2025-12-31T14:30:00Z", end: null, precision: "datetime" as const } }));
  let version = "1", current = items;
  const calls: unknown[][] = [];
  const repo = createWebsiteDatabaseRepository({ query: async <T>(_sql: string, values?: unknown[]) => {
    calls.push(values!);
    const result = { runId: "test-run", revision: version, schemaDigest: WEBSITE_SCHEMA_DIGEST, records: current.map(item => ({ item, document: null })), links: [], mediaIds: [] };
    return { rows: [{ result }] as T[] };
  } }, { timeZone: "Australia/Melbourne" });
  assert.deepEqual(await repo.getLibraryYears!("game", { status: "completed" }), { years: [{ year: 2026, count: 2 }], undatedCount: 0, timeZone: "Australia/Melbourne" });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].slice(0, 2), ["game", false]);
  const first = await repo.list("game", { status: "completed", year: 2026, limit: 1 });
  assert.equal(first.total, 2);
  for (const query of [{ status: "clear" }, { year: 2025 }, { order: "title-asc" as const }]) {
    await assert.rejects(repo.list("game", { status: "completed", year: 2026, limit: 1, cursor: first.nextCursor!, ...query }), invalid);
  }
  current = items.slice(1); version = "2";
  assert.equal((await repo.getLibraryYears!("game", { status: "completed" })).years[0].count, 1);
  await assert.rejects(repo.list("game", { status: "completed", year: 2026, limit: 1, cursor: first.nextCursor! }), invalid);
});

test("library summary HTTP validates status, uses no-store, gates kinds and scrubs failed providers", async () => {
  const repo = createContentService({ features: all }).repository;
  const request = new Request("https://example.test/api/library/movie/years?status=watched");
  const response = await libraryYearsResponse(request, "movie", repo, all);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.deepEqual((await response.json()).data, await repo.getLibraryYears!("movie", { status: "watched" }));
  for (const query of ["status=nope", "year=2026", "status=watched&status=watched", "limit=1"]) assert.equal((await libraryYearsResponse(new Request(`https://example.test/api/library/movie/years?${query}`), "movie", repo, all)).status, 400);
  const broken = { ...repo, getLibraryYears: async () => { throw Error("private-provider-details"); } };
  const failure = await libraryYearsResponse(request, "movie", broken, all);
  assert.equal(failure.status, 503); assert.ok(!(await failure.text()).includes("private-provider-details"));
  assert.equal((await libraryYearsResponse(request, "movie", broken)).status, 404);
  assert.equal((await libraryYearsResponse(request, "status", repo, all)).status, 404);
  const gated = createContentService({ features: contentFeatures, notionRepository: broken, provider: "notion" }).repository;
  assert.deepEqual((await gated.getLibraryYears!("movie")).years, []);
  assert.equal((await contentListResponse(new Request("https://example.test/api/content/movie?year=2026&status=watched"), "movie", repo, all)).status, 200);
});

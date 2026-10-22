import test from "node:test";
import assert from "node:assert/strict";
import type { DateRange, Game } from "../contracts/content.ts";
import { fixtureItems } from "../fixtures/content.ts";
import { gameBrowsingDate, platformPlayDay, projectGameDates } from "../src/lib/content/game-date.ts";
import { contentYear } from "../src/lib/content/years.ts";
import { compareContent, matchesContent } from "../src/lib/content/website.ts";
import { createWebsiteDatabaseRepository } from "../src/server/database/website-repository.ts";
import { WEBSITE_SCHEMA_DIGEST } from "../contracts/website-sync.ts";
import { contentDetailResponse, contentListResponse } from "../src/lib/content/http.ts";
import { CONTENT_KINDS, contentFeatures } from "../config/features.ts";
import { validateWebsiteRecord } from "../src/server/database/website-validation.ts";
import { createMockRepository } from "../adapters/mock-repository.ts";

const zone = "Australia/Melbourne";
const day = (start: string, end: string | null = null): DateRange => ({ start, end, precision: "date" });
const moment = (start: string): DateRange => ({ start, end: null, precision: "datetime" });
const game = (values: Partial<Game> = {}): Game => ({ ...structuredClone(fixtureItems.game[0]!), ...values });

test("manual range end wins over an older platform date; all browsing uses that day without changing personal input", () => {
  const input = game({ playedDate: day("2023-01-02", "2026-01-03"), lastPlayedDate: day("2025-12-31") });
  const output = projectGameDates(input, zone);
  assert.deepEqual(output.archiveDate, day("2026-01-03"));
  assert.equal(contentYear(output, zone), 2026);
  assert.equal(matchesContent(output, { year: 2026 }, zone), true);
  assert.equal(matchesContent(output, { year: 2023 }, zone), false);
  const older = projectGameDates(game({ playedDate: day("2025-01-01"), lastPlayedDate: null }), zone);
  assert.ok(compareContent(output, older, "date-desc", zone) < 0);
  assert.ok(compareContent(output, older, "date-asc", zone) > 0);
  assert.deepEqual(input.playedDate, day("2023-01-02", "2026-01-03"));
  assert.deepEqual(input.lastPlayedDate, day("2025-12-31"));
});

test("one-sided and legacy dates remain real; first/release/edit/time never fill the browsing date", () => {
  assert.deepEqual(gameBrowsingDate(game({ playedDate: day("2026-02-03"), lastPlayedDate: undefined }), zone), day("2026-02-03"));
  assert.deepEqual(gameBrowsingDate(game({ playedDate: null, lastPlayedDate: moment("2025-12-31T13:00:00Z") }), zone), day("2026-01-01"));
  const unknown = projectGameDates(game({ playedDate: null, lastPlayedDate: undefined, firstPlayedDate: day("2024-01-01"), releaseDate: day("2026-01-01"), updatedAt: "2026-01-01T00:00:00Z" }), zone);
  assert.equal(unknown.archiveDate, null);
  assert.equal(unknown.lastPlayedDate, null);
  assert.deepEqual(unknown.firstPlayedDate, day("2024-01-01"));
  assert.equal(contentYear(unknown, zone), null);
  assert.equal(projectGameDates(game({ firstPlayedDate: undefined }), zone).firstPlayedDate, null);
});

test("platform day conversion covers New Year, offset input, DST, written days and invalid observations", () => {
  for (const [input, expected] of [
    ["2025-12-31T13:00:00Z", "2026-01-01"],
    ["2026-01-01T00:30:00+11:00", "2026-01-01"],
    ["2026-04-04T15:59:00Z", "2026-04-05"],
    ["2026-04-04T16:01:00Z", "2026-04-05"],
    ["2026-10-03T15:59:00Z", "2026-10-04"],
    ["2026-10-03T16:01:00Z", "2026-10-04"],
  ]) assert.deepEqual(platformPlayDay(moment(input!), zone), day(expected!));
  assert.deepEqual(platformPlayDay(day("2025-12-31"), zone), day("2025-12-31"));
  for (const input of ["2025-02-29T01:00:00Z", "2026-01-01T01:00:00", "invalid"]) assert.equal(platformPlayDay(moment(input), zone), null);
  assert.equal(platformPlayDay(day("2026-02-31"), zone), null);
});

test("SQL read projection removes legacy platform times from list, detail, metadata, snapshot and home HTTP", async () => {
  const raw = game({ status: "playing", playedDate: day("2026-01-02"), lastPlayedDate: moment("2025-12-31T13:30:00Z"), firstPlayedDate: moment("2024-12-31T13:30:00Z"), archiveDate: day("2000-01-01") });
  let sql = 0;
  const repo = createWebsiteDatabaseRepository({ query: async <T>() => {
    sql++;
    return { rows: [{ result: { runId: "test-run", revision: "1", schemaDigest: WEBSITE_SCHEMA_DIGEST, records: [{ item: raw, document: null }], links: [], mediaIds: [] } }] as T[] };
  } }, { timeZone: zone });
  const features = Object.fromEntries(CONTENT_KINDS.map(k => [k, true])) as typeof contentFeatures;
  const request = new Request("https://example.test/api/content/game?year=2026");
  for (const response of [await contentListResponse(request, "game", repo, features), await contentDetailResponse(new Request("https://example.test/api/content/game/example"), "game", raw.slug, repo, features)]) {
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const body = await response.text();
    assert.ok(!body.includes("13:30"));
    assert.ok(body.includes('"archiveDate":{"start":"2026-01-02"'));
    assert.ok(body.includes('"firstPlayedDate":{"start":"2025-01-01"'));
  }
  for (const item of [(await repo.getContentMetadata!("game", raw.slug))!, (await repo.readSnapshot!(["game"])).records[0]!.item, (await repo.getHome()).playingGames[0]!]) {
    assert.equal(item.kind, "game");
    if (item.kind !== "game") throw Error("Missing game");
    assert.deepEqual(item.lastPlayedDate, day("2026-01-01"));
    assert.deepEqual(item.firstPlayedDate, day("2025-01-01"));
    assert.deepEqual(item.archiveDate, day("2026-01-02"));
  }
  assert.ok(sql > 0);
  assert.deepEqual(raw.lastPlayedDate, moment("2025-12-31T13:30:00Z"));
  assert.deepEqual(raw.archiveDate, day("2000-01-01"));
});

test("new first/archive fields are date-only staged payloads; old last-play datetime payloads stay readable", () => {
  const item = game({ cover: null });
  const record = { detail: { item, document: null }, evidence: { sourceKey: "game", dataSourceId: "source-game", databaseParentId: null, courseId: null, parentId: null, ordinal: 0 } };
  assert.doesNotThrow(() => validateWebsiteRecord(record));
  item.lastPlayedDate = moment("2025-01-01T01:00:00Z");
  assert.doesNotThrow(() => validateWebsiteRecord(record));
  for (const key of ["firstPlayedDate", "archiveDate"] as const) {
    item[key] = moment("2025-01-01T01:00:00Z");
    assert.throws(() => validateWebsiteRecord(record));
    item[key] = day("2025-01-01", "2025-01-02");
    assert.throws(() => validateWebsiteRecord(record));
    item[key] = day("2026-02-31");
    assert.throws(() => validateWebsiteRecord(record));
    item[key] = null;
  }
});

test("mock readers supply the same day-only contract as real providers", async () => {
  const repo = createMockRepository({ timeZone: zone });
  const listed = await repo.list("game", { status: "playing" });
  const item = listed.items.find(g => g.slug === "game-playing")!;
  const detail = await repo.get("game", item.slug);
  assert.deepEqual(detail!.item, item);
  assert.deepEqual(item.archiveDate, day("2025-06-15"));
  assert.deepEqual(item.firstPlayedDate, day("2025-01-02"));
  assert.equal((await repo.getLibraryYears!("game", { status: "playing" })).years.find(y => y.year === 2025)!.count, (await repo.list("game", { status: "playing", year: 2025 })).total);
});

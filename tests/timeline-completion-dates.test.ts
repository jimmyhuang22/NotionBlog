import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { AnyContent, Book, DateRange, Game } from "../contracts/content.ts";
import type { PublicContentSnapshot } from "../contracts/website.ts";
import { CONTENT_KINDS, type ContentFeatures } from "../config/features.ts";
import { fixtureItems } from "../fixtures/content.ts";
import { createMockRepository } from "../adapters/mock-repository.ts";
import { compareContent, contentDate, createWebsiteQueries, pageOf, readTimelineIndexSnapshot, readTimelineSnapshot, timelineEvents } from "../src/lib/content/website.ts";
import { projectGameDates } from "../src/lib/content/game-date.ts";
import { libraryYears } from "../src/lib/content/years.ts";
import { createHomeFeedRepository } from "../src/lib/content/home-feed-core.ts";
import { createHomeFeedV2Repository } from "../src/lib/content/home-feed-v2-core.ts";
import { homeFeedResponse } from "../src/lib/content/home-feed-http.ts";

const zone = "Australia/Melbourne";
const features = Object.fromEntries(CONTENT_KINDS.map(kind => [kind, ["book", "game", "movie"].includes(kind)])) as ContentFeatures;
const date = (start: string, end: string | null = null, precision: DateRange["precision"] = "date"): DateRange => ({ start, end, precision });
const point = (range: DateRange): DateRange => ({ ...range, start: range.end ?? range.start, end: null });
const book = (status: Book["status"], readingDate: DateRange | null): Book => ({ ...structuredClone(fixtureItems.book[0]), status, readingDate });
const game = (status: Game["status"], playedDate: DateRange | null): Game => ({
  ...structuredClone(fixtureItems.game[0]), status, playedDate,
  lastPlayedDate: date("2026-10-17"), archiveDate: date("2026-10-17"),
});
function snapshot(items: AnyContent[]): PublicContentSnapshot {
  return { version: "unchanged-stored-batch", records: items.map(item => ({ item, document: null })) };
}
function events(item: AnyContent) { return timelineEvents(snapshot([item]), zone); }
const completions = (item: AnyContent) => events(item).filter(event => event.type !== "game-playing");

test("finished and abandoned books use the range end or single date; reading uses the start", () => {
  for (const range of [date("2022-07-19", "2022-09-14"), date("2022-09-14")]) {
    for (const status of ["read", "given-up"] as const) {
      const event = events(book(status, range))[0];
      assert.equal(event.type, `book-${status}`);
      assert.deepEqual(event.occurredAt, point(range));
      assert.equal(event.id, `book:${fixtureItems.book[0].id}:2022-09-14`);
    }
    assert.deepEqual(events(book("reading", range))[0].occurredAt, { ...range, end: null });
  }
  for (const status of ["read", "given-up", "reading"] as const) {
    const event = events(book(status, null))[0];
    assert.equal(event.occurredAt, null); // Existing unknown-book behaviour is retained.
    assert.ok(event.id.endsWith(":undated"));
  }
});

test("completion games use only manual dates and never date a completion from platform activity", () => {
  for (const status of ["clear", "platinumed"] as const) {
    for (const range of [date("2023-05-12", "2023-06-17"), date("2023-06-17")]) {
      const [event, ...rest] = completions(game(status, range));
      assert.equal(rest.length, 0);
      assert.equal(event.type, status === "clear" ? "game-cleared" : "game-platinumed");
      assert.deepEqual(event.occurredAt, point(range));
      assert.equal(event.id, `game:${fixtureItems.game[0].id}:2023-06-17`);
      assert.deepEqual(event.playedTime, fixtureItems.game[0].playedTime);
    }
    const undated = game(status, null);
    undated.updatedAt = "2026-10-20T12:00:00Z";
    undated.releaseDate = date("2020-01-01");
    assert.deepEqual(completions(undated), []);
    undated.lastPlayedDate = null;
    assert.deepEqual(events(undated), []);
    undated.playedDate = date("2023-06-17");
    assert.equal(events(undated)[0].occurredAt?.start, "2023-06-17");
  }
});

test("completion datetime precision and local event IDs are preserved without manufacturing midnight", () => {
  const range = date("2025-01-01T00:00:00Z", "2025-12-31T14:30:00Z", "datetime");
  const finished = (status: Game["status"]) => ({ ...game(status, range), lastPlayedDate: null });
  for (const item of [book("read", range), book("given-up", range), finished("clear"), finished("platinumed")]) {
    const event = events(item)[0];
    assert.deepEqual(event.occurredAt, point(range));
    assert.ok(event.id.endsWith(":2026-01-01"));
    assert.ok(timelineEvents(snapshot([item]), "UTC")[0].id.endsWith(":2025-12-31"));
  }
  const earlier = { ...finished("clear"), id: "earlier" };
  const later = { ...book("read", date(range.start, "2025-12-31T14:45:00Z", "datetime")), id: "later" };
  assert.deepEqual(timelineEvents(snapshot([earlier, later]), zone).map(event => event.id), ["book:later:2026-01-01", "game:earlier:2026-01-01"]);
});

test("movies and playing activity retain their dates while library archives follow experience dates", () => {
  const movie = { ...structuredClone(fixtureItems.movie[0]), status: "watched" as const, watchedDate: date("2024-12-01", "2025-01-01") };
  assert.deepEqual(events(movie)[0].occurredAt, movie.watchedDate);
  const playing = game("playing", date("2023-05-12", "2023-06-17"));
  assert.deepEqual(events(playing)[0].occurredAt, date("2026-10-17"));
  const manualLater = { ...playing, archiveDate: undefined, playedDate: date("2027-01-01") };
  assert.deepEqual(events(manualLater)[0].occurredAt, date("2027-01-01"));
  const items: AnyContent[] = [book("read", date("2022-07-19", "2023-01-01")), game("clear", date("2023-05-12", "2023-06-17")),
    game("platinumed", null), movie].map(item => item.kind === "game" ? projectGameDates(item, zone) : item);
  const original = structuredClone(items);
  assert.deepEqual(libraryYears(items.filter(item => item.kind === "book"), zone).years, [{ year: 2022, count: 1 }]);
  assert.deepEqual(libraryYears(items.filter(item => item.kind === "game"), zone).years, [{ year: 2023, count: 1 }]);
  const dates = items.map(item => contentDate(item, zone));
  const sorted = [...items].sort((a, b) => compareContent(a, b, "date-desc", zone));
  timelineEvents(snapshot(items), zone);
  assert.deepEqual(items, original);
  assert.deepEqual(items.map(item => contentDate(item, zone)), dates);
  assert.deepEqual([...items].sort((a, b) => compareContent(a, b, "date-desc", zone)), sorted);
});

test("F47: a finished game played after its completion day also shows as playing on the platform day", () => {
  const id = fixtureItems.game[0].id, played = date("2026-10-26");
  // Platinumed with a manual 2022-2023 range and a later platform play: both events, neither moved.
  const replayed = events({ ...game("platinumed", date("2022-10-14", "2023-11-25")), lastPlayedDate: date("2026-10-26T09:30:00Z", null, "datetime") });
  assert.deepEqual(replayed.map(event => [event.id, event.type, event.occurredAt]), [
    [`game:${id}:2026-10-26`, "game-playing", played],
    [`game:${id}:2023-11-25`, "game-platinumed", date("2023-11-25")],
  ]);
  const [playing, platinumed] = replayed;
  assert.ok(playing.type !== "status" && platinumed.type !== "status");
  assert.deepEqual(playing.playedTime, fixtureItems.game[0].playedTime);
  assert.equal(playing.detail, platinumed.detail);
  // Cleared with no manual date: no completion, only the playing day.
  const undated = events({ ...game("clear", null), lastPlayedDate: played });
  assert.deepEqual(undated.map(event => [event.id, event.type, event.occurredAt]), [[`game:${id}:2026-10-26`, "game-playing", played]]);
  // Platform day on or before the completion day: the completion alone.
  for (const lastPlayedDate of [played, date("2026-10-01"), date("2026-10-26T12:00:00Z", null, "datetime")]) {
    const same = events({ ...game("clear", date("2026-09-01", "2026-10-26")), lastPlayedDate });
    assert.deepEqual(same.map(event => [event.id, event.type]), [[`game:${id}:2026-10-26`, "game-cleared"]]);
  }
  // A datetime completion is compared by its local day, not its UTC string.
  const local = events({ ...game("clear", date("2026-10-25T00:00:00Z", "2026-10-25T14:00:00Z", "datetime")), lastPlayedDate: played });
  assert.deepEqual(local.map(event => event.type), ["game-cleared"]);
  // Playing games, books and movies are untouched.
  assert.deepEqual(events({ ...game("playing", date("2023-01-01")), lastPlayedDate: played }).map(event => [event.type, event.occurredAt]), [["game-playing", played]]);
  assert.equal(events(book("read", date("2022-09-14"))).length, 1);
});

test("timeline, both mixed feed HTTP paths and old-snapshot index reads share completion dates and reject old cursors", async () => {
  const movie = { ...structuredClone(fixtureItems.movie[0]), status: "watched" as const, watchedDate: date("2024-01-01") };
  const stored = snapshot([book("read", date("2022-07-19", "2022-09-14")), game("clear", date("2023-05-12", "2023-06-17")),
    { ...game("platinumed", null), id: "undated-completion" }, movie]);
  const raw = { ...createMockRepository(), readSnapshot: async () => structuredClone(stored) };
  const indexed = { ...raw, readIndex: async () => structuredClone(stored) };
  const selected = CONTENT_KINDS.filter(kind => features[kind]);
  const versionOf = (...prefix: string[]) => createHash("sha256").update(JSON.stringify([...prefix, stored.version, selected, zone])).digest("base64url");
  // Pre-F44 and F44 (completion-dates-v2) projections must both be rejected after F47.
  const oldVersions = [versionOf(), versionOf("completion-dates-v2")];
  const current = await readTimelineSnapshot(raw, features, zone);
  for (const oldVersion of oldVersions) assert.notEqual(current.version, oldVersion);
  assert.deepEqual(await readTimelineIndexSnapshot(indexed, features, zone), current);
  const expected = current.items.map(event => [event.type, event.occurredAt]);
  assert.deepEqual(expected, [["game-playing", date("2026-10-17")], ["game-playing", date("2026-10-17")], ["movie-watched", date("2024-01-01")],
    ["game-cleared", date("2023-06-17")], ["book-read", date("2022-09-14")]]);
  const invalid = { code: "INVALID_QUERY" };
  for (const repository of [raw, indexed]) {
    const queries = createWebsiteQueries(repository, features, zone);
    assert.deepEqual((await queries.getTimeline!({ limit: 50 })).items, current.items);
    for (const oldVersion of oldVersions) {
      const oldCursor = pageOf(current.items, { limit: 1 }, repository === raw
        ? ["timeline", oldVersion, selected, zone, 1]
        : ["timeline-index", oldVersion, selected, zone, 1]).nextCursor!;
      await assert.rejects(queries.getTimeline!({ limit: 1, cursor: oldCursor }), invalid);
    }
    if (repository === raw) {
      const preF44 = pageOf(current.items, { limit: 1 }, ["timeline", stored.version, selected, zone, 1]).nextCursor!;
      await assert.rejects(queries.getTimeline!({ limit: 1, cursor: preF44 }), invalid);
    }
  }
  for (const build of [createHomeFeedRepository, createHomeFeedV2Repository]) {
    const options = { sources: { content: "mock" as const, social: "disabled" as const }, timeZone: zone };
    const next = build({ ...options, content: () => readTimelineIndexSnapshot(indexed, features, zone) });
    for (const oldVersion of oldVersions) {
      const old = build({ ...options, content: async () => ({ ...current, version: oldVersion }) });
      const oldPage = await old.getPage({ limit: 1 });
      const rejected = await homeFeedResponse(new Request(`https://example.test/api/home/feed?limit=1&cursor=${oldPage.nextCursor}`), next);
      assert.equal(rejected.status, 400);
    }
    const response = await homeFeedResponse(new Request("https://example.test/api/home/feed?limit=50"), next);
    assert.equal(response.status, 200);
    const page = (await response.json()).data;
    assert.equal(page.total, 5);
    assert.deepEqual(page.items.map((item: { event: { type: string; occurredAt: DateRange | null }; occurredAt: DateRange | null }) => {
      assert.deepEqual(item.occurredAt, item.event.occurredAt);
      return [item.event.type, item.occurredAt];
    }), expected);
  }
});

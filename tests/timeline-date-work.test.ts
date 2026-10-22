import assert from "node:assert/strict";
import test from "node:test";
import type { DateRange } from "../contracts/content.ts";
import { fixtureItems } from "../fixtures/content.ts";
import { timelineEvents } from "../src/lib/content/website.ts";

function movie(id: string, date: DateRange | null) {
  return { item: { ...structuredClone(fixtureItems.movie[0]), id, slug: id, title: id, status: "watched" as const, watchedDate: date }, document: null };
}

test("timeline date conversion is once per datetime object per calculation", () => {
  const records = Array.from({ length: 48 }, (_, index) => movie(`m-${index}`, index % 8 === 0 ? null
    : index % 7 === 0 ? { start: "2026-10-04", end: null, precision: "date" }
    : { start: new Date(Date.UTC(2026, 9, 3, 12) + (index * 137 % 48) * 1_800_000).toISOString(), end: null, precision: "datetime" }));
  const snapshot = { version: "fictional", records }, original = structuredClone(snapshot);
  const expected = records.filter(record => record.item.watchedDate?.precision === "datetime").length;
  const format = Intl.DateTimeFormat.prototype.formatToParts;
  let calls = 0;
  Intl.DateTimeFormat.prototype.formatToParts = function (value) { calls++; return format.call(this, value); };
  try {
    const first = timelineEvents(snapshot, "Australia/Melbourne");
    assert.equal(calls, expected);
    assert.deepEqual(timelineEvents(snapshot, "Australia/Melbourne"), first);
    assert.equal(calls, expected * 2);
    assert.deepEqual(snapshot, original);
  } finally { Intl.DateTimeFormat.prototype.formatToParts = format; }
});

test("per-calculation dates preserve DST, pure-date ordering and fresh input changes", () => {
  const before: DateRange = { start: "2026-10-03T15:59:00.000Z", end: null, precision: "datetime" };
  const after: DateRange = { start: "2026-10-03T16:01:00.000Z", end: null, precision: "datetime" };
  const snapshot = { version: "fictional", records: [movie("undated", null), movie("date", { start: "2026-10-04", end: null, precision: "date" }),
    movie("before", before), movie("after", after), movie("same-time", after)] };
  assert.deepEqual(timelineEvents(snapshot, "Australia/Melbourne").map(event => event.id), [
    "movie:after:2026-10-04", "movie:same-time:2026-10-04", "movie:before:2026-10-04", "movie:date:2026-10-04", "movie:undated:undated",
  ]);
  assert.deepEqual(timelineEvents(snapshot, "UTC").map(event => event.id), [
    "movie:date:2026-10-04", "movie:after:2026-10-03", "movie:same-time:2026-10-03", "movie:before:2026-10-03", "movie:undated:undated",
  ]);
  before.start = "2026-10-05T12:00:00.000Z";
  assert.equal(timelineEvents(snapshot, "Australia/Melbourne")[0].id, "movie:before:2026-10-05");
});

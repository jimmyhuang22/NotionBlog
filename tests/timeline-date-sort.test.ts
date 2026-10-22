import test from "node:test";
import assert from "node:assert/strict";
import type { Album, ContentDetail, DateRange, StatusEntry } from "../contracts/content.ts";
import { timelineEvents } from "../src/lib/content/website.ts";

const date = (start: string, precision: DateRange["precision"] = "datetime"): DateRange => ({ start, precision, end: null });
const base = (id: string) => ({ id, slug: id, href: `/status/${id}`, title: id, summary: null, tags: [], cover: null, updatedAt: null });
function status(id: string, recordedAt: DateRange | null): ContentDetail<StatusEntry> {
  return { item: { ...base(id), kind: "status", recordedAt, text: [{ text: id }] }, document: null };
}

test("timeline order preserves local midnight, date precision and unknowns across independent time zones", () => {
  const snapshot = { version: "synthetic", records: [status("before", date("2026-10-03T15:30:00Z")),
    status("unknown", null), status("day", date("2026-10-04", "date")), status("after", date("2026-10-03T16:30:00Z"))] };
  const original = structuredClone(snapshot);
  for (const [zone, expected] of [
    ["Australia/Melbourne", ["after", "before", "day", "unknown"]],
    ["UTC", ["day", "after", "before", "unknown"]],
    ["America/New_York", ["day", "after", "before", "unknown"]],
    ["Australia/Melbourne", ["after", "before", "day", "unknown"]],
  ] as const) {
    const result = timelineEvents(snapshot, zone);
    assert.deepEqual(result.map(event => event.id), expected.map(id => `status:${id}`));
    for (const event of result) {
      assert.equal(event.type, "status");
      assert.deepEqual(event.occurredAt, snapshot.records.find(record => `status:${record.item.id}` === event.id)!.item.recordedAt);
    }
  }
  assert.deepEqual(snapshot, original);
});

test("timeline ties remain deterministic during a repeated daylight-saving hour and with no dates", () => {
  const repeated = date("2026-11-01T06:30:00Z");
  const records = [status("b", repeated), status("undated-b", null), status("earlier", date("2026-11-01T05:30:00Z")),
    status("a", repeated), status("day", date("2026-11-01", "date")), status("undated-a", null)];
  const snapshot = { version: "synthetic", records };
  const expected = ["a", "b", "earlier", "day", "undated-a", "undated-b"].map(id => `status:${id}`);
  const first = timelineEvents(snapshot, "America/New_York");
  assert.deepEqual(first.map(event => event.id), expected);
  assert.deepEqual(timelineEvents({ ...snapshot, records: [...records].reverse() }, "America/New_York"), first);
  assert.deepEqual(timelineEvents({ version: "empty", records: [] }, "UTC"), []);
});

test("work event IDs and same-day deduplication preserve the selected item across DST", () => {
  const album = (date: DateRange): ContentDetail<Album> => ({ item: { ...base("album"), kind: "album", date, photoCount: 0 }, document: null });
  const newer = album(date("2026-10-03T16:30:00Z"));
  const older = album(date("2026-10-03T15:30:00Z"));
  const snapshot = { version: "synthetic", records: [newer, older] };
  for (const [zone, day] of [["Australia/Melbourne", "2026-10-04"], ["UTC", "2026-10-03"], ["Australia/Melbourne", "2026-10-04"]]) {
    const events = timelineEvents(snapshot, zone);
    assert.equal(events.length, 1);
    assert.deepEqual(events[0], { id: `album:album:${day}`, type: "album-new", occurredAt: newer.item.date,
      title: "album", summary: null, cover: null, href: "/status/album", externalUrl: null, rating: null, progressPercent: null, detail: "0" });
  }
});

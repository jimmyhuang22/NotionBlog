import assert from "node:assert/strict";
import test from "node:test";
import { rangeLabel } from "../src/lib/format.ts";
import { gameDateRows, platformDay } from "../src/lib/game-dates.ts";

const day = (start: string) => ({ start, end: null, precision: "date" as const });
const moment = (start: string, end: string | null = null) => ({ start, end, precision: "datetime" as const });
const zone = "Australia/Melbourne";

test("a game without a platform date keeps its one date under the old name", () => {
  assert.deepEqual(gameDateRows({ playedDate: day("2025-01-02") }, zone), [["游玩日期", day("2025-01-02")]]);
  assert.deepEqual(gameDateRows({ playedDate: day("2025-01-02"), lastPlayedDate: null }, zone), [["游玩日期", day("2025-01-02")]]);
  // No date at all is still one row, which the page shows as not recorded; never a second empty row.
  assert.deepEqual(gameDateRows({ playedDate: null }, zone), [["游玩日期", null]]);
});

test("with a platform date the page shows it first and names the owner's date apart", () => {
  assert.deepEqual(gameDateRows({ playedDate: day("2025-01-02"), lastPlayedDate: day("2026-03-04") }, zone), [["最近游玩", day("2026-03-04")], ["体验日期", day("2025-01-02")]]);
  // Beside a platform date, an owner's date that was never written is left out rather than shown as not recorded.
  assert.deepEqual(gameDateRows({ playedDate: null, lastPlayedDate: day("2026-03-04") }, zone), [["最近游玩", day("2026-03-04")]]);
});

test("a platform date is shown to the day in the site's zone, never with the time of day", () => {
  // 10:00 UTC is 20:00 the same day in Melbourne; 15:00 UTC is already the next day there.
  assert.deepEqual(platformDay(moment("2025-06-15T10:00:00.000Z"), zone), day("2025-06-15"));
  assert.deepEqual(platformDay(moment("2025-06-15T15:00:00.000Z"), zone), day("2025-06-16"));
  assert.deepEqual(platformDay(day("2025-06-15"), zone), day("2025-06-15"));
  // Two moments on one day are that day; on different days they stay a range of days.
  assert.deepEqual(platformDay(moment("2025-06-15T01:00:00.000Z", "2025-06-15T03:00:00.000Z"), zone), day("2025-06-15"));
  assert.deepEqual(platformDay(moment("2025-06-15T01:00:00.000Z", "2025-06-18T03:00:00.000Z"), zone), { start: "2025-06-15", end: "2025-06-18", precision: "date" });
  const [[label, shown]] = gameDateRows({ playedDate: null, lastPlayedDate: moment("2025-06-15T10:00:00.000Z") }, zone);
  assert.equal(label, "最近游玩");
  assert.equal(rangeLabel(shown ?? null, zone), "2025 年 6 月 15 日");
});

test("a platform date that cannot be read is no platform date", () => {
  assert.equal(platformDay(moment("not a time"), zone), null);
  assert.deepEqual(gameDateRows({ playedDate: day("2025-01-02"), lastPlayedDate: moment("not a time") }, zone), [["游玩日期", day("2025-01-02")]]);
});

test("the first play the platforms report has its own row, only when there is one", () => {
  assert.deepEqual(gameDateRows({ playedDate: day("2025-03-04"), lastPlayedDate: day("2026-03-04"), firstPlayedDate: day("2025-01-02") }, zone),
    [["最近游玩", day("2026-03-04")], ["首次游玩", day("2025-01-02")], ["体验日期", day("2025-03-04")]]);
  // A platform that never tells the first play leaves no empty row for it.
  assert.deepEqual(gameDateRows({ playedDate: null, lastPlayedDate: day("2026-03-04"), firstPlayedDate: null }, zone), [["最近游玩", day("2026-03-04")]]);
  // It is a platform date like the other: to the day, and the owner's date, when written, is named apart from it.
  assert.deepEqual(gameDateRows({ playedDate: null, firstPlayedDate: moment("2025-01-02T15:00:00.000Z") }, zone), [["首次游玩", day("2025-01-03")]]);
  assert.deepEqual(gameDateRows({ playedDate: day("2024-05-06"), firstPlayedDate: day("2025-01-02") }, zone), [["首次游玩", day("2025-01-02")], ["体验日期", day("2024-05-06")]]);
});

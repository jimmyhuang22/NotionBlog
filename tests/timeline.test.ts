import test from "node:test";
import assert from "node:assert/strict";
import type { TimelineEvent } from "../contracts/website.ts";
import { calendarDay, dateParts, momentLabel, momentText, relativeDay } from "../src/lib/format.ts";
import { daySpan, entryMoment, eventDetail, eventKinds, eventMoment, feedRuns, spanMoment, type WorkEvent } from "../src/lib/timeline.ts";

const work = (type: WorkEvent["type"], extra: Partial<WorkEvent> = {}): WorkEvent => ({
  id: `x:${type}`, type, occurredAt: null, title: "t", summary: null, cover: null, href: null, externalUrl: null, rating: null, progressPercent: null, detail: null, ...extra,
});

test("every timeline update has a section and a verb", () => {
  assert.deepEqual([eventKinds["movie-watched"].verb, eventKinds["book-read"].verb, eventKinds["game-platinumed"].verb, eventKinds["album-new"].verb], ["看过", "读完", "白金", "新相册"]);
  assert.deepEqual([eventKinds["game-cleared"].kind, eventKinds["post-new"].section, eventKinds["project-new"].section], ["game", "文章", "项目"]);
});

test("the detail line states what is known and leaves out the rest", () => {
  assert.equal(eventDetail(work("album-new", { detail: "12" })), "12 张");
  assert.equal(eventDetail(work("album-new", { detail: "0" })), "");
  assert.equal(eventDetail(work("album-new")), "");
  assert.equal(eventDetail(work("post-new", { summary: "摘要" })), "摘要");
  assert.equal(eventDetail(work("movie-watched", { detail: "动画", rating: { value: 4, scale: 5, label: "" } })), "动画 · 4 / 5");
  assert.equal(eventDetail(work("book-reading", { progressPercent: 40 })), "40%");
  // Progress belongs to a book being read; a finished one shows only its rating.
  assert.equal(eventDetail(work("book-read", { progressPercent: 100, rating: { value: null, scale: null, label: "推荐" } })), "推荐");
  assert.equal(eventDetail(work("game-playing", { detail: "Switch · PC" })), "Switch · PC");
  assert.equal(eventDetail(work("project-new")), "");
});

test("an update is filed under its month in the site time zone, or under no date", () => {
  const at = (start: string, precision: "date" | "datetime"): TimelineEvent => work("movie-watched", { occurredAt: { start, end: null, precision } });
  // 14:30 UTC on New Year's Eve is already January in Melbourne.
  assert.deepEqual(eventMoment(at("2025-12-31T14:30:00Z", "datetime"), "Australia/Melbourne"), { month: { key: "2026-1", label: "2026 年 1 月" }, time: "1 月 1 日 01:30" });
  assert.deepEqual(eventMoment(at("2025-12-31T14:30:00Z", "datetime"), "UTC").month?.key, "2025-12");
  // A date-only value keeps its written day and shows no time.
  assert.deepEqual(eventMoment(at("2025-12-31", "date"), "Australia/Melbourne"), { month: { key: "2025-12", label: "2025 年 12 月" }, time: "12 月 31 日" });
  assert.deepEqual(eventMoment(work("post-new"), "UTC"), { month: null, time: null });
});

test("paging message shows a total only when it is consistent with what is on screen", async () => {
  const { pagingMessage } = await import("../src/components/use-paged-list.ts");
  assert.equal(pagingMessage(null, 12, "条", 241), "已显示 12 / 241 条");
  assert.equal(pagingMessage(null, 12, "条"), "已显示 12 条");
  assert.equal(pagingMessage(null, 12, "条", null), "已显示 12 条");
  assert.equal(pagingMessage(null, 14, "条", 12), "已显示 14 条");
  assert.equal(pagingMessage("busy", 12, "条", 241), "暂时加载不出来，请稍后再试。");
});

const dated = (source: "content" | "social", start: string | null) => ({ source, occurredAt: start ? { start, end: null, precision: "datetime" as const } : null });

test("works that follow one another are one run; anything between them, or a new month, ends it", () => {
  const items = [
    dated("content", "2026-08-05T09:00:00.000Z"), dated("social", "2026-08-02T02:00:00.000Z"), dated("content", "2026-07-30T11:00:00.000Z"),
    dated("social", "2026-07-25T08:00:00.000Z"), dated("social", "2026-07-22T02:00:00.000Z"), dated("social", "2026-07-21T04:00:00.000Z"),
    dated("content", "2026-07-18T10:00:00.000Z"), dated("content", "2026-07-17T10:00:00.000Z"),
    // The same stretch of works runs on into June: the month heading stands between them.
    dated("social", "2026-07-02T04:00:00.000Z"), dated("social", "2026-06-30T04:00:00.000Z"), dated("social", "2026-06-29T04:00:00.000Z"),
    dated("social", null), dated("social", null),
  ];
  const runs = feedRuns(items, "UTC");
  assert.deepEqual(runs.map(run => [run.first, run.items.length]), [[0, 1], [1, 1], [2, 1], [3, 3], [6, 1], [7, 1], [8, 1], [9, 2], [11, 2]]);
  // Nothing is dropped or reordered.
  assert.deepEqual(runs.flatMap(run => run.items), items);
  // A month is judged in the site's zone: 14:30 UTC on 30 June is already 1 July in Melbourne.
  assert.deepEqual(feedRuns([dated("social", "2026-07-02T04:00:00.000Z"), dated("social", "2026-06-30T14:30:00.000Z")], "Australia/Melbourne").map(run => run.items.length), [2]);
  assert.deepEqual(feedRuns([dated("social", "2026-07-02T04:00:00.000Z"), dated("social", "2026-06-30T14:30:00.000Z")], "UTC").map(run => run.items.length), [1, 1]);
  // Entries arriving with a later page extend the run they continue.
  assert.deepEqual(feedRuns([...items.slice(0, 5)], "UTC").at(-1)!.items.length, 2);
  assert.deepEqual(feedRuns([], "UTC"), []);
});

test("a run says which days it covers, earliest first", () => {
  const run = [dated("social", "2026-07-25T08:00:00.000Z"), dated("social", "2026-07-22T02:00:00.000Z"), dated("social", "2026-07-20T04:00:00.000Z")];
  assert.equal(daySpan(run, "UTC"), "7 月 20 日至 7 月 25 日");
  assert.equal(daySpan([run[0]!, dated("social", "2026-07-25T20:00:00.000Z")], "UTC"), "7 月 25 日");
  // In Melbourne the second of those is already the 26th.
  assert.equal(daySpan([run[0]!, dated("social", "2026-07-25T20:00:00.000Z")], "Australia/Melbourne"), "7 月 25 日至 7 月 26 日");
  // An undated work takes no part; a run with no dates has no span.
  assert.equal(daySpan([run[0]!, dated("social", null)], "UTC"), "7 月 25 日");
  assert.equal(daySpan([dated("social", null), dated("social", null)], "UTC"), null);
});

const ZONE = "Australia/Melbourne";
const day = (year: number, month: number, date: number) => ({ year, month, day: date });
/** The time line of a moment as read at `now`, both in the site's time zone. */
const line = (start: string, precision: "date" | "datetime", now: string) => momentText(entryMoment({ start, end: null, precision }, ZONE, calendarDay(now, ZONE))!);

test("a recent day is named by the calendar: today, yesterday, the day before, then days ago up to a week", () => {
  const today = day(2026, 10, 14);
  assert.deepEqual([14, 13, 12, 11, 7, 6].map(date => relativeDay(day(2026, 10, date), today)), ["今天", "昨天", "前天", "3 天前", "7 天前", null]);
  // Across a month and a year.
  assert.equal(relativeDay(day(2026, 9, 30), day(2026, 10, 1)), "昨天");
  assert.equal(relativeDay(day(2025, 12, 31), day(2026, 1, 1)), "昨天");
  assert.equal(relativeDay(day(2025, 12, 26), day(2026, 1, 2)), "7 天前");
  // A day still to come has no such name; nothing is called tomorrow.
  assert.equal(relativeDay(day(2026, 10, 15), today), null);
  assert.equal(relativeDay(day(2027, 1, 1), today), null);
});

test("the time line leads with the name and keeps the date; today needs only its time", () => {
  const now = "2026-10-14T01:00:00.000Z"; // 12:00 on 14 October in Melbourne
  assert.equal(line("2026-10-13T22:12:00.000Z", "datetime", now), "今天 09:12");
  assert.equal(line("2026-10-13T11:52:00.000Z", "datetime", now), "昨天 · 10 月 13 日 22:52");
  assert.equal(line("2026-10-12T10:33:00.000Z", "datetime", now), "前天 · 10 月 12 日 21:33");
  assert.equal(line("2026-10-09T21:05:00.000Z", "datetime", now), "4 天前 · 10 月 10 日 08:05");
  assert.equal(line("2026-10-06T21:05:00.000Z", "datetime", now), "7 天前 · 10 月 7 日 08:05");
  // Eight days and more: the date alone, as before.
  assert.equal(line("2026-10-05T21:05:00.000Z", "datetime", now), "10 月 6 日 08:05");
  assert.equal(line("2025-12-31T12:59:00.000Z", "datetime", now), "12 月 31 日 23:59");
  // Later than today: the date alone.
  assert.equal(line("2026-10-14T21:05:00.000Z", "datetime", now), "10 月 15 日 08:05");
});

test("an entry recorded to the day gets no time of day made up for it", () => {
  const now = "2026-10-14T01:00:00.000Z";
  assert.equal(line("2026-10-13", "date", now), "昨天 · 10 月 13 日");
  assert.equal(line("2026-10-14", "date", now), "今天");
  assert.equal(line("2026-10-05", "date", now), "10 月 5 日");
  // A written date is not moved by the time zone.
  assert.deepEqual(momentLabel(dateParts("2026-10-13", "date", ZONE)!, calendarDay(now, ZONE)), { relative: "昨天", rest: "10 月 13 日" });
  // Without a date there is no line; without a today every entry is a plain date.
  assert.equal(entryMoment(null, ZONE, calendarDay(now, ZONE)), null);
  assert.deepEqual(entryMoment({ start: "2026-10-13T11:52:00.000Z", end: null, precision: "datetime" }, ZONE, null), { relative: null, rest: "10 月 13 日 22:52" });
  assert.equal(calendarDay("not a time", ZONE), null);
});

test("days are counted in the site's time zone, not in UTC and not in hours", () => {
  // 23:30 UTC on the 13th is already 10:30 on the 14th in Melbourne.
  assert.equal(line("2026-10-13T23:30:00.000Z", "datetime", "2026-10-14T01:00:00.000Z"), "今天 10:30");
  // Written at 23:50, read at 00:10: twenty minutes later it is yesterday's.
  assert.equal(line("2026-10-13T12:50:00.000Z", "datetime", "2026-10-13T13:10:00.000Z"), "昨天 · 10 月 13 日 23:50");
  // Almost two days apart in hours, yet one calendar day.
  assert.equal(line("2026-10-12T13:10:00.000Z", "datetime", "2026-10-14T12:50:00.000Z"), "昨天 · 10 月 13 日 00:10");
  // Daylight saving began on 4 October 2026 and that day was 23 hours long.
  // 01:00 on the 4th (before the change) read at 01:00 on the 5th: 23 hours, one calendar day.
  assert.equal(line("2026-10-03T15:00:00.000Z", "datetime", "2026-10-04T14:00:00.000Z"), "昨天 · 10 月 4 日 01:00");
  // 23:30 on the 3rd read at 00:30 on the 5th: exactly 24 hours, two calendar days.
  assert.equal(line("2026-10-03T13:30:00.000Z", "datetime", "2026-10-04T13:30:00.000Z"), "前天 · 10 月 3 日 23:30");
  // And at the end of daylight saving, 5 April 2026, a day of 25 hours.
  assert.equal(line("2026-04-04T13:30:00.000Z", "datetime", "2026-04-05T14:30:00.000Z"), "昨天 · 4 月 5 日 00:30");
});

test("a run of works within one day is named like that day; over several days it stays dates", () => {
  const dated = (start: string) => ({ occurredAt: { start, end: null, precision: "datetime" as const } });
  const today = day(2026, 7, 26);
  assert.deepEqual(spanMoment([dated("2026-07-25T02:00:00.000Z"), dated("2026-07-25T20:00:00.000Z")], "UTC", today), { relative: "昨天", rest: "7 月 25 日" });
  // Today keeps its date here: a run has no time of day to stand beside the word.
  assert.deepEqual(spanMoment([dated("2026-07-26T02:00:00.000Z"), dated("2026-07-26T20:00:00.000Z")], "UTC", today), { relative: "今天", rest: "7 月 26 日" });
  assert.deepEqual(spanMoment([dated("2026-07-20T02:00:00.000Z"), dated("2026-07-25T20:00:00.000Z")], "UTC", today), { relative: null, rest: "7 月 20 日至 7 月 25 日" });
  assert.equal(spanMoment([{ occurredAt: null }], "UTC", today), null);
  // The plain span is unchanged.
  assert.equal(daySpan([dated("2026-07-25T02:00:00.000Z"), dated("2026-07-25T20:00:00.000Z")], "UTC"), "7 月 25 日");
});

import assert from "node:assert/strict";
import test from "node:test";
import type { PublishedSocialCollection, SocialTimelineWork } from "../contracts/social-timeline.ts";
import { coverPreviewWidths, coverShapes, groupWorksByPublishedYear, leadingFigures, workDayMoment, workLines, workMoment, worksDay } from "../src/lib/works.ts";
import { examplePublication } from "./helpers/home-feed-samples.ts";

const unknown = { views: null, likes: null, comments: null, shares: null, collections: null, coins: null, danmaku: null };
/** Fictional. A season on record with its totals and a checked address. */
const season = (extra: Partial<PublishedSocialCollection> = {}): PublishedSocialCollection => ({
  id: "c", platform: "bilibili", kind: "season", title: "示例合集", memberCount: 12, partCount: null, firstPublishedAt: null, latestMemberPublishedAt: "2026-01-05T00:00:00.000Z",
  observedAt: "2026-01-06T00:00:00.000Z", metricsScope: "bilibili-season", metrics: { ...unknown, views: 286400, likes: 9120, coins: 0 },
  activity: { at: "2026-01-05T00:00:00.000Z", basis: "member-published" }, latestAddition: null, originalUrl: "https://space.bilibili.com/10001/lists/200?type=season", linkVerifiedAt: "2026-01-06T00:00:00.000Z", latestMemberUrl: null, latestMemberLinkVerifiedAt: null, ...extra,
});
const work = (id: string, occurredAt: string | null, extra: Partial<SocialTimelineWork> = {}): SocialTimelineWork => ({
  id, type: "social-work", title: "示例作品", occurredAt, cover: null, publications: [examplePublication("bilibili")], collection: null, ...extra,
});

test("a work is listed under its collection's latest activity, else its own date, else no date", () => {
  assert.equal(workMoment(work("a", "2025-03-01T00:00:00.000Z")), "2025-03-01T00:00:00.000Z");
  // The original date stays on the work; the list uses the activity, as the home timeline does.
  assert.equal(workMoment(work("b", "2024-01-01T00:00:00.000Z", { collection: season(), publications: [] })), "2026-01-05T00:00:00.000Z");
  assert.equal(workMoment(work("c", "2024-01-01T00:00:00.000Z", { collection: season({ activity: null }), publications: [] })), "2024-01-01T00:00:00.000Z");
  assert.equal(workMoment(work("d", null)), null);
  // The day follows the site's time zone, not UTC.
  const late = work("e", "2025-12-31T16:30:00.000Z");
  assert.equal(workDayMoment(late, "Asia/Shanghai", null)?.rest, "1 月 1 日");
  assert.equal(workDayMoment(late, "UTC", null)?.rest, "12 月 31 日");
  assert.equal(workDayMoment(work("f", null), "UTC", null), null);
});

test("each place a work lives is its own line, with that platform's figures, time and address", () => {
  const both = work("w", "2026-01-02T00:00:00.000Z", { publications: [examplePublication("bilibili"), examplePublication("xiaohongshu")] });
  const lines = workLines(both);
  assert.deepEqual(lines.map(line => `${line.platform}:${line.kind}`), ["bilibili:视频", "xiaohongshu:图文"]);
  // Views and likes only, never summed; a rounded display stands as the platform wrote it and a real zero is shown.
  // The Bilibili video has no views on record, and Bilibili shows no likes, so it has no figures; Xiaohongshu keeps its likes.
  assert.deepEqual(lines.map(line => line.figures.map(figure => `${figure.label} ${figure.value}`)), [[], ["点赞 1.2万"]]);
  // A line with no figures to show has no reading time either.
  assert.deepEqual(lines.map(line => line.observedAt), [null, "2026-01-02T00:00:00.000Z"]);
  assert.ok(lines.every(line => line.url === null && line.size === null && !line.noticed));
  // A collection comes first, with its size, the platform's own totals and its checked address; tied platforms follow.
  const tied = workLines(work("c", null, { collection: season(), publications: [examplePublication("xiaohongshu")] }));
  assert.deepEqual(tied.map(line => line.kind), ["合集", "图文"]);
  assert.equal(tied[0]!.size, "12 个视频");
  assert.deepEqual(tied[0]!.figures.map(figure => `${figure.label} ${figure.value}`), ["播放 28.6万"]);
  assert.equal(tied[0]!.url, "https://space.bilibili.com/10001/lists/200?type=season");
  assert.equal(tied[0]!.observedAt, "2026-01-06T00:00:00.000Z");
});

test("a line leads with views and likes, and nothing else while it has either", () => {
  const figure = (metric: "views" | "likes" | "coins" | "comments", value: string) => ({ metric, label: metric, value });
  const all = [figure("views", "5.4万"), figure("likes", "847"), figure("coins", "20"), figure("comments", "73")];
  assert.deepEqual(leadingFigures(all).map(entry => entry.metric), ["views", "likes"]);
  // A platform that reports no views shows its likes alone.
  assert.deepEqual(leadingFigures(all.slice(1)).map(entry => entry.metric), ["likes"]);
  // With neither, the first figure it has stands in: figures on record are never told as none.
  assert.deepEqual(leadingFigures(all.slice(2)).map(entry => entry.metric), ["coins"]);
  assert.deepEqual(leadingFigures([]), []);
  // Bilibili shows views alone, and no stand-in when they are unknown (the owner's choice, 2026-10-17).
  assert.deepEqual(leadingFigures(all, "bilibili").map(entry => entry.metric), ["views"]);
  assert.deepEqual(leadingFigures(all.slice(1), "bilibili"), []);
  assert.deepEqual(leadingFigures(all, "xiaohongshu").map(entry => entry.metric), ["views", "likes"]);
  // Each platform's own cover shape.
  assert.deepEqual(coverShapes, { bilibili: "wide", xiaohongshu: "tall" });
  // A video frame asks for the larger preview whatever the card's size; an upright note for the smaller.
  assert.deepEqual(coverPreviewWidths, { wide: 800, tall: 400 });
});

test("a line without figures has no time to tell, and a noticed change is marked on the collection's line only", () => {
  const empty = examplePublication("bilibili");
  const silent = { ...empty, metrics: { ...unknown }, metricDisplay: { ...unknown } };
  const [line] = workLines(work("w", null, { publications: [silent] }));
  assert.deepEqual(line!.figures, []);
  assert.equal(line!.observedAt, null);
  const noticed = workLines(work("c", null, { publications: [examplePublication("xiaohongshu")],
    collection: season({ kind: "multi-part", memberCount: 1, partCount: null, metrics: { ...unknown }, originalUrl: null, activity: { at: "2026-01-06T00:00:00.000Z", basis: "addition-detected" } }) }));
  assert.deepEqual(noticed.map(entry => entry.noticed), [true, false]);
  // An unknown part count is left out rather than shown as a number; no figures, no address.
  assert.equal(noticed[0]!.kind, "多 P 视频");
  assert.equal(noticed[0]!.size, null);
  assert.equal(noticed[0]!.observedAt, null);
  assert.equal(noticed[0]!.url, null);
});

test("works-page years follow the published date in the site's time zone, in the order the works arrive", () => {
  // A collection is dated by its latest member, as the works page orders it.
  const at = (id: string, published: string | null) => work(id, null, { collection: season({ latestMemberPublishedAt: published }), publications: [] });
  const works = [at("a", "2026-03-01T00:00:00.000Z"), at("b", "2026-01-01T00:00:00.000Z"), at("c", "2025-06-01T00:00:00.000Z"), at("d", null), at("e", null)];
  assert.deepEqual(groupWorksByPublishedYear(works, "UTC").map(group => `${group.year.label}:${group.works.map(entry => entry.id).join("")}`), ["2026:ab", "2025:c", "日期未记录:de"]);
  // A later page continues the last group instead of opening the same year twice.
  assert.equal(groupWorksByPublishedYear([...works.slice(0, 3), at("f", "2025-02-01T00:00:00.000Z")], "UTC").length, 2);
  // The new year begins at midnight in the site's time zone.
  assert.equal(groupWorksByPublishedYear([at("g", "2025-12-31T16:30:00.000Z")], "Asia/Shanghai")[0]!.year.key, "2026");
  assert.equal(groupWorksByPublishedYear([at("g", "2025-12-31T16:30:00.000Z")], "UTC")[0]!.year.key, "2025");
  assert.deepEqual(groupWorksByPublishedYear([], "UTC"), []);
});

test("a work's day is named the way a status entry's is, to the day only", () => {
  const today = { year: 2026, month: 10, day: 14 };
  assert.deepEqual(workDayMoment(work("a", "2026-10-13T11:52:00.000Z"), "Australia/Melbourne", today), { relative: "昨天", rest: "10 月 13 日" });
  assert.deepEqual(workDayMoment(work("b", "2026-10-13T22:00:00.000Z"), "Australia/Melbourne", today), { relative: "今天", rest: null });
  assert.deepEqual(workDayMoment(work("c", "2026-10-01T00:00:00.000Z"), "Australia/Melbourne", today), { relative: null, rest: "10 月 1 日" });
  // A collection is placed by its latest activity, as everywhere else.
  assert.deepEqual(workDayMoment(work("d", "2024-01-01T00:00:00.000Z", { collection: season({ activity: { at: "2026-10-11T23:00:00.000Z", basis: "member-published" } }), publications: [] }), "Australia/Melbourne", today), { relative: "前天", rest: "10 月 12 日" });
  assert.equal(workDayMoment(work("e", null), "Australia/Melbourne", today), null);
  assert.deepEqual(workDayMoment(work("f", "2026-10-13T11:52:00.000Z"), "Australia/Melbourne", null), { relative: null, rest: "10 月 13 日" });
});

test("a collection opens on its newest episode when that link is known, else on its own list", () => {
  const latest = "https://www.bilibili.com/video/BV1aaaaaaaaa/";
  const withEpisode = workLines(work("e", null, { collection: season({ latestMemberUrl: latest, latestMemberLinkVerifiedAt: "2026-01-06T00:00:00.000Z" }), publications: [] }))[0]!;
  assert.equal(withEpisode.url, latest);
  assert.equal(withEpisode.opensLatest, true);
  // The episode link stands on its own check, even when the list page's own link was never checked.
  assert.equal(workLines(work("u", null, { collection: season({ originalUrl: null, linkVerifiedAt: null, latestMemberUrl: latest }), publications: [] }))[0]!.url, latest);
  const listOnly = workLines(work("l", null, { collection: season(), publications: [] }))[0]!;
  assert.equal(listOnly.url, "https://space.bilibili.com/10001/lists/200?type=season");
  assert.equal(listOnly.opensLatest, false);
  assert.equal(workLines(work("n", null, { collection: season({ originalUrl: null }), publications: [] }))[0]!.url, null);
  // A single video keeps its own address.
  assert.equal(workLines(work("v", null))[0]!.opensLatest, false);
});

test("ordered by views or likes, a card's day of another year carries its year; this year's and relative days do not (F41)", () => {
  const today = { year: 2026, month: 10, day: 21 };
  const at = (publishedAt: string) => work("w", null, { publications: [{ ...examplePublication("bilibili"), publishedAt }] });
  const text = (moment: ReturnType<typeof worksDay>) => moment ? [moment.relative, moment.rest].filter(Boolean).join(" · ") : null;
  assert.equal(text(worksDay(at("2025-06-19T04:00:00.000Z"), "Australia/Melbourne", today, true)), "2025 年 6 月 19 日");
  assert.equal(text(worksDay(at("2026-06-10T04:00:00.000Z"), "Australia/Melbourne", today, true)), "6 月 10 日");
  assert.equal(text(worksDay(at("2026-10-20T04:00:00.000Z"), "Australia/Melbourne", today, true)), "昨天 · 10 月 20 日");
  assert.equal(text(worksDay(at("2025-06-19T04:00:00.000Z"), "Australia/Melbourne", today)), "6 月 19 日");
  // Drawn before the visitor's day is known (cached markup): the year is written out, never left for this year's.
  assert.equal(text(worksDay(at("2025-06-19T04:00:00.000Z"), "Australia/Melbourne", null, true)), "2025 年 6 月 19 日");
  assert.equal(text(worksDay(at("2026-06-10T04:00:00.000Z"), "Australia/Melbourne", null, true)), "2026 年 6 月 10 日");
  assert.equal(text(worksDay(at("2025-06-19T04:00:00.000Z"), "Australia/Melbourne", null)), "6 月 19 日");
});

import assert from "node:assert/strict";
import test from "node:test";
import type { SocialMetric, SocialPublication } from "../contracts/social.ts";
import type { SocialCollectionCard } from "../contracts/social-collections.ts";
import type { PublishedSocialCollection } from "../contracts/social-timeline.ts";
import { collectionAddition, collectionBadge, collectionFigures, collectionKinds, collectionSize, collectionUpdate, figureText, isNoticedActivity, platformNames, publicationFigures, publicationKinds, sampleTime } from "../src/lib/home-feed.ts";
import { eventMoment } from "../src/lib/timeline.ts";
import { examplePublication, exampleSocialWork } from "./helpers/home-feed-samples.ts";

test("a figure is an exact count, else the platform's own display, else nothing", () => {
  const metricText = (publication: SocialPublication, metric: SocialMetric) => figureText(publication.metrics, publication.metricDisplay, metric);
  const bilibili = examplePublication("bilibili");
  const xiaohongshu = examplePublication("xiaohongshu");
  // A real zero is shown; an unknown is left out and never becomes zero.
  assert.equal(metricText(bilibili, "likes"), "0");
  assert.equal(metricText(bilibili, "views"), null);
  // A rounded display stands as the platform wrote it when there is no exact count behind it.
  assert.equal(metricText(xiaohongshu, "likes"), "1.2万");
  // Exact counts read the way the platforms write them.
  const counted = { ...bilibili, metrics: { ...bilibili.metrics, views: 12840, likes: 9999, coins: 10000, danmaku: 1234567 } };
  assert.equal(metricText(counted, "views"), "1.3万");
  assert.equal(metricText(counted, "likes"), "9999");
  assert.equal(metricText(counted, "coins"), "1万");
  assert.equal(metricText(counted, "danmaku"), "123.5万");
  // From a hundred million on, in 亿; a count that would round to 10000万 is 1亿.
  const large = (views: number) => metricText({ ...bilibili, metrics: { ...bilibili.metrics, views } }, "views");
  assert.equal(large(99_940_000), "9994万");
  assert.equal(large(99_999_999), "1亿");
  assert.equal(large(100_000_000), "1亿");
  assert.equal(large(123_456_789), "1.2亿");
  assert.equal(large(1_050_000_000), "10.5亿");
  // A count that cannot be a count is treated as unknown, and the display is used if there is one.
  assert.equal(metricText({ ...bilibili, metrics: { ...bilibili.metrics, views: -1 }, metricDisplay: { ...bilibili.metricDisplay, views: "3" } }, "views"), "3");
  assert.equal(metricText({ ...bilibili, metrics: { ...bilibili.metrics, views: Number.NaN } }, "views"), null);
});

test("a publication lists only the figures it has, in reading order, per platform", () => {
  assert.deepEqual(publicationFigures(examplePublication("bilibili")), [
    { metric: "likes", label: "点赞", value: "0" }, { metric: "comments", label: "评论", value: "0" },
  ]);
  assert.deepEqual(publicationFigures(examplePublication("xiaohongshu")).map(figure => `${figure.label} ${figure.value}`), ["点赞 1.2万", "评论 0"]);
  const empty = examplePublication("bilibili");
  const unknown = { ...empty, metrics: { ...empty.metrics, likes: null, comments: null }, metricDisplay: { ...empty.metricDisplay, likes: null, comments: null } };
  assert.deepEqual(publicationFigures(unknown), []);
  // Every platform and kind the contract allows has a name.
  for (const publication of exampleSocialWork("w", null).publications) {
    assert.ok(platformNames[publication.platform]);
    assert.ok(publicationKinds[publication.kind]);
  }
});

test("a work published elsewhere is placed on the timeline by its own date, or under no date", () => {
  assert.deepEqual(eventMoment({ occurredAt: { start: "2026-01-02T23:30:00.000Z", end: null, precision: "datetime" } }, "Asia/Shanghai"), {
    month: { key: "2026-1", label: "2026 年 1 月" }, time: "1 月 3 日 07:30",
  });
  assert.deepEqual(eventMoment({ occurredAt: null }, "UTC"), { month: null, time: null });
});

const unknown = { views: null, likes: null, comments: null, shares: null, collections: null, coins: null, danmaku: null };
/** Fictional. A season with nothing on record beyond its members. */
const collection = (extra: Partial<SocialCollectionCard> = {}): SocialCollectionCard => ({
  id: "c", platform: "bilibili", kind: "season", title: "示例合集", memberCount: 12, partCount: null, firstPublishedAt: null, latestMemberPublishedAt: null,
  observedAt: "2026-01-02T00:00:00.000Z", metricsScope: "bilibili-season", metrics: { ...unknown }, activity: null, latestAddition: null, originalUrl: null, ...extra,
});

test("a collection says what it is and how much is in it, and leaves out what is not known", () => {
  assert.equal(collectionKinds.season, "合集");
  assert.equal(collectionSize(collection()), "12 个视频");
  // A multi-part video counts parts; an unverified part count is not shown as a number.
  assert.equal(collectionSize(collection({ kind: "multi-part", memberCount: 1, partCount: 26 })), "26 个分 P");
  assert.equal(collectionSize(collection({ kind: "multi-part", memberCount: 1, partCount: null })), null);
  // Totals come from the platform as they are: unknown is left out, zero is a real zero, nothing is summed.
  assert.deepEqual(collectionFigures(collection()), []);
  assert.deepEqual(collectionFigures(collection({ metrics: { ...unknown, views: 286400, coins: 0 } })).map(figure => `${figure.label} ${figure.value}`), ["播放 28.6万", "投币 0"]);
});

test("the first look at a collection is a baseline, never an update", () => {
  // Nothing on record: the newest member's date in the site's time zone, or nothing at all.
  assert.equal(collectionUpdate(collection(), "UTC"), null);
  assert.deepEqual(collectionUpdate(collection({ latestMemberPublishedAt: "2026-01-02T23:30:00.000Z" }), "Asia/Shanghai"), { text: "最近一集发布于 2026 年 1 月 3 日", note: null });
  // The baseline carries the newest member's publication as its place on the timeline. That is still not an addition.
  const baseline = collection({ latestMemberPublishedAt: "2026-01-02T23:30:00.000Z", activity: { at: "2026-01-02T23:30:00.000Z", basis: "member-published" } });
  assert.deepEqual(collectionUpdate(baseline, "Asia/Shanghai"), { text: "最近一集发布于 2026 年 1 月 3 日", note: null });
  assert.equal(isNoticedActivity(baseline), false);
  // A multi-part video's date is its own publication, already the entry's time: nothing more to say.
  assert.equal(collectionUpdate({ ...baseline, kind: "multi-part", memberCount: 26, partCount: 26, firstPublishedAt: "2026-01-02T23:30:00.000Z" }, "Asia/Shanghai"), null);
});

test("a collection's change is an addition only when its members were published; a noticed one says so", () => {
  const published = collection({ activity: { at: "2026-01-05T00:00:00.000Z", basis: "member-published" }, latestAddition: { detectedAt: "2026-01-06T00:00:00.000Z", publishedAt: "2026-01-05T00:00:00.000Z", addedVideos: 2, addedParts: 0 } });
  assert.deepEqual(collectionUpdate(published, "UTC"), { text: "新增 2 个视频", note: null });
  // Only noticed, with no publication time behind it: never worded as a publication.
  const noticed = collection({ kind: "multi-part", activity: { at: "2026-01-06T00:00:00.000Z", basis: "addition-detected" }, latestAddition: { detectedAt: "2026-01-06T00:00:00.000Z", publishedAt: null, addedVideos: 1, addedParts: 3 } });
  assert.deepEqual(collectionUpdate(noticed, "UTC"), { text: "发现新增 1 个视频、3 个分 P", note: "发布时间未知" });
  // The entry is placed at the moment of noticing, and says so beside its time.
  assert.equal(isNoticedActivity(noticed), true);
  assert.equal(isNoticedActivity(published), false);
  assert.equal(isNoticedActivity(collection()), false);
  // An activity without counts still says something true rather than a number.
  assert.deepEqual(collectionUpdate(collection({ activity: { at: "2026-01-06T00:00:00.000Z", basis: "addition-detected" } }), "UTC"), { text: "发现有新增内容", note: "发布时间未知" });
});

test("a home card's corner number takes the day's total when the backend sends one, else the latest addition", () => {
  const published = collection({ activity: { at: "2026-01-05T00:00:00.000Z", basis: "member-published" }, latestAddition: { detectedAt: "2026-01-06T00:00:00.000Z", publishedAt: "2026-01-05T00:00:00.000Z", addedVideos: 1, addedParts: 0 } });
  // Before the day total exists: the latest addition, with the card's own words.
  assert.deepEqual(collectionBadge(published, "UTC"), { count: 1, words: "新增 1 个视频" });
  // The day's total wins and is used as it is; the latest addition is not added to it.
  const day = (addedVideos: number, addedParts: number, basis: "member-published" | "addition-detected" | "mixed") => ({ ...published, dayAddition: { day: "2026-01-05", addedVideos, addedParts, basis } });
  assert.deepEqual(collectionBadge(day(2, 0, "member-published"), "UTC"), { count: 2, words: "新增 2 个视频" });
  assert.deepEqual(collectionBadge(day(1, 3, "addition-detected"), "UTC"), { count: 4, words: "发现新增 1 个视频、3 个分 P，发布时间未知" });
  assert.deepEqual(collectionBadge(day(3, 0, "mixed"), "UTC"), { count: 3, words: "新增 3 个视频，其中部分发布时间未知" });
  // A day with nothing counted, and the first look, show no badge; a change without counts says 新 (count null).
  assert.equal(collectionBadge(day(0, 0, "member-published"), "UTC"), null);
  assert.equal(collectionBadge({ ...published, latestAddition: null, activity: null }, "UTC"), null);
  assert.deepEqual(collectionBadge(collection({ activity: { at: "2026-01-06T00:00:00.000Z", basis: "addition-detected" } }), "UTC"), { count: null, words: "发现有新增内容，发布时间未知" });
});

test("a published collection fits the same card", () => {
  // The checked address is the only difference from a candidate; everything the card says is read the same way.
  const live: PublishedSocialCollection = { ...collection({ metrics: { ...unknown, views: 53819, comments: 72 }, latestMemberPublishedAt: "2026-01-02T00:00:00.000Z" }),
    originalUrl: "https://space.bilibili.com/10001/lists/200?type=season", linkVerifiedAt: "2026-01-02T00:00:00.000Z", latestMemberUrl: null, latestMemberLinkVerifiedAt: null };
  assert.deepEqual(collectionFigures(live).map(figure => `${figure.label} ${figure.value}`), ["播放 5.4万", "评论 72"]);
  assert.equal(collectionSize(live), "12 个视频");
  assert.deepEqual(collectionUpdate(live, "UTC"), { text: "最近一集发布于 2026 年 1 月 2 日", note: null });
});

test("a cover card tells only a change since the first look", () => {
  // The baseline's newest-member line repeats the time the entry stands at, so the card leaves it out.
  const baseline = collection({ latestMemberPublishedAt: "2026-01-02T23:30:00.000Z", activity: { at: "2026-01-02T23:30:00.000Z", basis: "member-published" } });
  assert.equal(collectionAddition(baseline, "Asia/Shanghai"), null);
  assert.equal(collectionAddition(collection(), "UTC"), null);
  const added = { detectedAt: "2026-01-06T00:00:00.000Z", publishedAt: "2026-01-05T00:00:00.000Z", addedVideos: 1, addedParts: 0 };
  assert.deepEqual(collectionAddition(collection({ activity: { at: "2026-01-05T00:00:00.000Z", basis: "member-published" }, latestAddition: added }), "UTC"), { text: "新增 1 个视频", note: null });
  // A change that was only noticed keeps its wording and its caveat.
  assert.deepEqual(collectionAddition(collection({ activity: { at: "2026-01-06T00:00:00.000Z", basis: "addition-detected" } }), "UTC"), { text: "发现有新增内容", note: "发布时间未知" });
});

test("each row tells when its own figures were read, in the site's time zone", () => {
  const today = { year: 2026, month: 10, day: 13 };
  // 21:10 UTC on the 12th is 08:10 on the 13th in Melbourne; the year is left out while it is the current one.
  assert.deepEqual(sampleTime("2026-10-12T21:10:00.000Z", "Australia/Melbourne", today), { at: "2026-10-12T21:10:00.000Z", label: "10 月 13 日 08:10" });
  assert.equal(sampleTime("2026-10-12T21:10:00.000Z", "Asia/Shanghai", today)?.label, "10 月 13 日 05:10");
  // An older year is written out; the current year is the device's day in the site's zone, where this moment is already 1 January.
  assert.equal(sampleTime("2025-12-31T12:00:00.000Z", "Australia/Melbourne", today)?.label, "2025 年 12 月 31 日 23:00");
  assert.equal(sampleTime("2025-12-31T13:30:00.000Z", "Australia/Melbourne", { year: 2026, month: 1, day: 1 })?.label, "1 月 1 日 00:30");
  // A reading newer than the page (it came with a later page of the list) is told as it is.
  assert.equal(sampleTime("2026-10-13T02:00:00.000Z", "UTC", today)?.label, "10 月 13 日 02:00");
  // A long-overdue reading is told as it is too; nothing says it is late any more.
  assert.deepEqual(sampleTime("2026-10-09T00:10:00.000Z", "UTC", today), { at: "2026-10-09T00:10:00.000Z", label: "10 月 9 日 00:10" });
  // Cached markup knows no day yet: the year is written out until the device's day is known.
  assert.equal(sampleTime("2026-10-12T21:10:00.000Z", "UTC", null)?.label, "2026 年 10 月 12 日 21:10");
});

test("a reading time that cannot be read is left out", () => {
  assert.equal(sampleTime("not a time", "UTC", { year: 2026, month: 10, day: 13 }), null);
  assert.equal(sampleTime("not a time", "UTC", null), null);
});

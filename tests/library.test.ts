import test from "node:test";
import assert from "node:assert/strict";
import { fixtureItems } from "../fixtures/content.ts";
import { itemDate, knownStatusLabel, libraryHref, libraryOrders, librarySections, statusLabel, summaryLine, summaryParts, timeLabel, workSentence, workFactText } from "../src/lib/library.ts";
import { validateListQuery } from "../src/lib/content/query.ts";

test("every library tab is a status filter the list endpoint accepts", () => {
  for (const section of Object.values(librarySections)) {
    for (const [status] of section.tabs) assert.doesNotThrow(() => validateListQuery(section.kind, { status }), `${section.kind}:${status}`);
  }
});

test("library labels state missing values instead of inventing them", () => {
  for (const item of [...fixtureItems.movie, ...fixtureItems.book, ...fixtureItems.game]) {
    assert.ok(statusLabel(item).length > 0);
    const line = summaryLine(item);
    assert.ok(!/null|undefined|NaN/u.test(line), line);
    assert.ok(!line.startsWith(" · ") && !line.endsWith(" · "), line);
  }
  const wishlist = fixtureItems.movie.find(movie => movie.status === "wishlist")!;
  assert.equal(statusLabel(wishlist), "想看");
  assert.equal(itemDate(wishlist), wishlist.watchedDate);
  assert.equal(statusLabel({ ...fixtureItems.book[0]!, status: "wishlist" }), "想读");
  assert.equal(statusLabel({ ...fixtureItems.game[0]!, status: "wishlist" }), "想玩");
  // A card says only a known status; the detail page still says an unknown one.
  assert.equal(knownStatusLabel({ ...fixtureItems.game[0]!, status: "unknown" }), null);
  assert.equal(statusLabel({ ...fixtureItems.game[0]!, status: "unknown" }), "状态未记录");
  assert.equal(knownStatusLabel({ ...fixtureItems.game[0]!, status: "platinumed" }), "白金");
  assert.equal(knownStatusLabel({ ...fixtureItems.game[0]!, status: "wishlist" }), "想玩");
  assert.equal(timeLabel(null), null);
  assert.equal(timeLabel({ value: 45, unit: "hour" }), "45 小时");
  assert.equal(timeLabel({ value: 43.966666666667, unit: "hour" }), "44 小时");
  assert.equal(timeLabel({ value: 74.613055555556, unit: "hour" }), "74.6 小时");
  assert.equal(timeLabel({ value: 166.16, unit: "hour" }), "166.2 小时");
  assert.equal(timeLabel({ value: 210, unit: "minute" }), "210 分钟");
  assert.equal(summaryLine({ ...fixtureItems.game[0]!, platforms: [], playedTime: null, rating: null }), "");
});

test("album meta omits an unknown photo count and states a known empty album", async () => {
  const { albumMeta } = await import("../src/lib/album.ts");
  const album = fixtureItems.album[0]!;
  assert.equal(albumMeta({ ...album, photoCount: null }, "UTC"), "2026 年 10 月 9 日");
  assert.equal(albumMeta({ ...album, photoCount: 2 }, "UTC"), "2026 年 10 月 9 日 · 2 张");
  assert.equal(albumMeta({ ...album, date: null, photoCount: 0 }, "UTC"), "日期未记录 · 暂无照片");
});

test("every library order is accepted by the list endpoint and addresses keep both choices", () => {
  for (const section of Object.values(librarySections)) {
    for (const [order] of libraryOrders) if (order) assert.doesNotThrow(() => validateListQuery(section.kind, { order }), `${section.kind}:${order}`);
  }
  assert.equal(libraryHref("games", null, null), "/library/games");
  assert.equal(libraryHref("games", "playing", null), "/library/games?status=playing");
  assert.equal(libraryHref("books", null, "title-asc"), "/library/books?order=title-asc");
  assert.equal(libraryHref("books", "given-up", "date-asc"), "/library/books?status=given-up&order=date-asc");
  assert.equal(libraryHref("movies", null, null, 2025), "/library/movies?year=2025");
  // A section's default status is its plain address, so each status has one address.
  assert.equal(libraryHref("movies", "watched", "title-asc", "undated"), "/library/movies?year=undated&order=title-asc");
  assert.equal(libraryHref("movies", "wishlist", null), "/library/movies?status=wishlist");
  assert.equal(libraryHref("books", "read", null), "/library/books");
  assert.equal(libraryHref("games", "completed", null), "/library/games");
  for (const section of Object.values(librarySections)) assert.ok(section.tabs.some(([value]) => value === section.defaultStatus), section.kind);
});

test("a film card says only its rating, and its kind sits on the cover unless it is a film", async () => {
  const { cardParts, coverBadge } = await import("../src/lib/library.ts");
  const movie = fixtureItems.movie[0]!;
  assert.deepEqual(cardParts({ ...movie, rating: null }), ["未评分"]);
  assert.equal(cardParts({ ...movie, rating: { value: null, scale: null, label: "⭐️⭐️⭐️⭐️" } })[0], "★★★★");
  assert.equal(coverBadge({ ...movie, mediaType: "电影" }), null);
  assert.equal(coverBadge({ ...movie, mediaType: null }), null);
  assert.equal(coverBadge({ ...movie, mediaType: "剧集" }), "剧集");
  // Books and games keep their summary line, and never a badge.
  assert.equal(coverBadge(fixtureItems.book[0]!), null);
});

test("ratings on a small whole scale draw as dots, anything else stays text", async () => {
  const { ratingDots, progressWidth } = await import("../src/lib/library.ts");
  assert.deepEqual(ratingDots({ value: 4, scale: 5, label: "" }), { filled: 4, total: 5 });
  // The exact value is printed beside the dots, so half marks round to whole dots.
  assert.deepEqual(ratingDots({ value: 3.5, scale: 5, label: "" }), { filled: 4, total: 5 });
  assert.deepEqual(ratingDots({ value: 0, scale: 10, label: "" }), { filled: 0, total: 10 });
  for (const rating of [null, { value: null, scale: 5, label: "" }, { value: 4, scale: null, label: "好" }, { value: 80, scale: 100, label: "" }, { value: 6, scale: 5, label: "" }, { value: -1, scale: 5, label: "" }, { value: 4, scale: 4.5, label: "" }]) {
    assert.equal(ratingDots(rating), null, JSON.stringify(rating));
  }
  assert.equal(progressWidth(75), "75%");
  assert.equal(progressWidth(0), "0%");
  for (const percent of [null, -1, 101, Number.NaN]) assert.equal(progressWidth(percent), null, String(percent));
});

test("the line under a title is made of whole facts, so it can wrap between them", () => {
  const game = { ...fixtureItems.game[0]!, platforms: ["Nintendo Switch", "PlayStation"], playedTime: { value: 186.2, unit: "hour" as const }, rating: null };
  // Platforms stay one piece; an unknown value leaves no empty piece behind.
  assert.deepEqual(summaryParts(game), ["Nintendo Switch / PlayStation", "186.2 小时"]);
  assert.deepEqual(summaryParts({ ...game, platforms: [], playedTime: null }), []);
  // The plain-text line is the same facts joined.
  for (const item of [...fixtureItems.movie, ...fixtureItems.book, ...fixtureItems.game]) assert.equal(summaryLine(item), summaryParts(item).join(" · "));
});

test("a game card names its platforms short in their makers' colours, writes time played plainly and marks platinum", async () => {
  const { cardTimeLabel, coverBadge, gameCard, platformChip } = await import("../src/lib/library.ts");
  assert.deepEqual(platformChip("Nintendo Switch"), { label: "Switch", tone: "nintendo" });
  assert.deepEqual(platformChip("Nintendo 3DS"), { label: "3DS", tone: "nintendo" });
  assert.deepEqual(platformChip("PlayStation"), { label: "PlayStation", tone: "playstation" });
  assert.deepEqual(platformChip("Personal Computer"), { label: "PC", tone: "pc" });
  assert.deepEqual(platformChip("Xbox"), { label: "Xbox", tone: "other" });
  // Whole hours from a hundred on, one decimal below; none at all and unknown are left out.
  assert.equal(cardTimeLabel({ value: 1902.9, unit: "hour" }), "1903 小时");
  assert.equal(cardTimeLabel({ value: 100, unit: "hour" }), "100 小时");
  assert.equal(cardTimeLabel({ value: 51.83, unit: "hour" }), "51.8 小时");
  assert.equal(cardTimeLabel({ value: 44, unit: "hour" }), "44 小时");
  assert.equal(cardTimeLabel({ value: 0, unit: "hour" }), null);
  assert.equal(cardTimeLabel(null), null);
  assert.equal(cardTimeLabel({ value: 210, unit: "minute" }), "210 分钟");
  const game = fixtureItems.game[0]!;
  assert.equal(coverBadge({ ...game, status: "platinumed" }), "白金");
  assert.equal(coverBadge({ ...game, status: "clear" }), null);
  // A game without a rating leaves the place empty rather than writing it as missing.
  assert.equal(gameCard({ ...game, rating: null, platforms: [], playedTime: { value: 0, unit: "hour" } }).rating, null);
  assert.deepEqual(gameCard({ ...game, rating: null, platforms: ["PlayStation", "Personal Computer"], playedTime: null }).platforms.map(chip => chip.label), ["PlayStation", "PC"]);
});

test("a work's page says when and what in one sentence, and the rest as words of a line", () => {
  const movie = fixtureItems.movie[0]!;
  assert.equal(workSentence({ ...movie, status: "watched" }, "2024 年 7 月 13 日"), "2024 年 7 月 13 日看过");
  assert.equal(workSentence({ ...movie, status: "watched" }, null), "看过，日期未记录");
  assert.equal(workSentence({ ...movie, status: "wishlist" }, null), "想看");
  assert.equal(workSentence({ ...movie, status: "unknown" }, "2024 年 7 月 13 日"), "2024 年 7 月 13 日，状态未记录");
  assert.equal(workSentence({ ...fixtureItems.game[0]!, status: "platinumed" }, undefined), "白金");
  assert.deepEqual([["导演", "凌子风"], ["上映", "1982 年 8 月 18 日"], ["豆瓣评分", "8.5"], ["类型", "电影"], ["最近游玩", "2026 年 10 月 1 日"]].map(([label, value]) => workFactText(label!, value!)),
    ["凌子风 导演", "1982 年 8 月 18 日上映", "豆瓣 8.5", "电影", "最近游玩 2026 年 10 月 1 日"]);
});

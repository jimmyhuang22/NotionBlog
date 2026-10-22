import test from "node:test";
import assert from "node:assert/strict";
import { parseSiteConfig } from "../src/lib/site/parse.ts";
import { dateParts, dayLabel, rangeLabel, ratingLabel, semesterLabel } from "../src/lib/format.ts";

test("missing or malformed site configuration falls back to a generic identity", () => {
  for (const input of [undefined, null, "text", [], { profile: "x", socials: "y" }]) {
    assert.deepEqual(parseSiteConfig(input, "Demo"), {
      siteName: "Demo", timeZone: "UTC", profile: { name: null, bio: null, avatar: null }, socials: [],
    });
  }
  assert.equal(parseSiteConfig({ timeZone: "Not/AZone" }).timeZone, "UTC");
});

test("site configuration keeps valid fields and drops unsafe links and avatars", () => {
  const config = parseSiteConfig({
    siteName: " Example ", timeZone: "Australia/Melbourne",
    profile: { name: "Demo Person", bio: "", avatar: "/local/avatar.jpg" },
    socials: [
      { platform: "bilibili", url: "https://example.test/space/1" },
      { platform: "steam", url: "http://example.test/insecure" },
      { platform: "github", url: "javascript:alert(1)" },
      { platform: "email", url: "mailto:demo@example.test", label: "写信" },
      { platform: "link", url: "https://user:pass@example.test/" },
      { platform: "unknown", url: "https://example.test/" },
    ],
  });
  assert.equal(config.siteName, "Example");
  assert.equal(config.timeZone, "Australia/Melbourne");
  assert.deepEqual(config.profile, { name: "Demo Person", bio: null, avatar: "/local/avatar.jpg" });
  assert.deepEqual(config.socials, [
    { platform: "bilibili", url: "https://example.test/space/1", label: "哔哩哔哩" },
    { platform: "email", url: "mailto:demo@example.test", label: "写信" },
  ]);
  for (const avatar of ["//example.test/a.png", "http://example.test/a.png", "data:image/png;base64,AA", "..\\a.png"]) {
    assert.equal(parseSiteConfig({ profile: { avatar } }).profile.avatar, null, avatar);
  }
  assert.equal(parseSiteConfig({ profile: { avatar: "https://example.test/a.png" } }).profile.avatar, "https://example.test/a.png");
});

test("dates keep their precision and render in the configured zone", () => {
  assert.deepEqual(dateParts("2026-08-17", "date", "UTC"), { year: 2026, month: 8, day: 17, time: null });
  const late = dateParts("2026-10-10T22:30:07.718Z", "datetime", "Australia/Melbourne");
  assert.deepEqual(late, { year: 2026, month: 10, day: 11, time: "09:30" });
  assert.equal(dayLabel(late!), "10 月 11 日 09:30");
  assert.equal(dateParts("not a date", "datetime", "UTC"), null);
  assert.equal(rangeLabel(null, "UTC"), null);
  assert.equal(rangeLabel({ start: "2026-08-17", end: "2026-08-23", precision: "date" }, "UTC"), "2026 年 8 月 17 日 至 8 月 23 日");
  assert.equal(rangeLabel({ start: "2025-12-29", end: "2026-01-04", precision: "date" }, "UTC"), "2025 年 12 月 29 日 至 2026 年 1 月 4 日");
  // A range on a single day reads as that day; two times on one day are still a range.
  assert.equal(rangeLabel({ start: "2023-08-26", end: "2023-08-26", precision: "date" }, "UTC"), "2023 年 8 月 26 日");
  assert.equal(rangeLabel({ start: "2026-08-17T01:00:00Z", end: "2026-08-17T03:00:00Z", precision: "datetime" }, "UTC"), "2026 年 8 月 17 日 01:00 至 8 月 17 日 03:00");
});

test("missing semester and ratings are stated, never shown as zero", () => {
  assert.equal(semesterLabel("26S2"), "2026 S2");
  assert.equal(semesterLabel("Summer A"), "Summer A");
  assert.equal(semesterLabel(null), "学期未记录");
  assert.equal(ratingLabel(null), "未评价");
  assert.equal(ratingLabel({ value: 4, scale: 5, label: "★★★★" }), "4 / 5");
  assert.equal(ratingLabel({ value: null, scale: null, label: "Easy" }), "Easy");
  // Star emoji become text stars; a value without a scale is never turned into a fraction.
  assert.equal(ratingLabel({ value: 4, scale: null, label: "\u2B50\uFE0F\u2B50\uFE0F\u2B50\uFE0F\u2B50\uFE0F" }), "★★★★");
  assert.equal(ratingLabel({ value: null, scale: null, label: "\u2B50\u2B50\u2B50" }), "★★★");
  assert.equal(ratingLabel({ value: null, scale: null, label: "\u2B50 好看" }), "\u2B50 好看");
});

test("the last-edited label uses the site time zone and is omitted for a missing or invalid time", async () => {
  const { updatedLabel } = await import("../src/lib/format.ts");
  assert.equal(updatedLabel("2026-09-30T15:30:00Z", "Australia/Melbourne"), "更新于 2026 年 10 月 1 日");
  assert.equal(updatedLabel("2026-09-30T15:30:00Z", "UTC"), "更新于 2026 年 9 月 30 日");
  assert.equal(updatedLabel(null, "UTC"), null);
  assert.equal(updatedLabel("not a date", "UTC"), null);
});

import test from "node:test";
import assert from "node:assert/strict";
import { earnedByMonth, earnedPlatinum, missingTrophies, rarestEarned, rarityTier, recentEarned, setPercent, trophyDay, trophyPlatformTone, trophySetsOf, type Trophy } from "../src/lib/game-trophies.ts";

const counts = (earned: number, total: number) => ({ earned, total });
const grades = { platinum: counts(0, 1), gold: counts(1, 3), silver: counts(4, 8), bronze: counts(10, 18) };
const trophy = (id: string, extra: Partial<Trophy> = {}): Trophy => ({ id, name: id, detail: null, grade: "bronze", icon: null, earned: false, earnedDate: null, rarityPercent: null, hidden: false, ...extra });

test("trophy sets: absent or unreadable responses show nothing", () => {
  assert.deepEqual(trophySetsOf(null), []);
  assert.deepEqual(trophySetsOf({ item: {}, document: null }), []);
  assert.deepEqual(trophySetsOf({ trophySets: "x" }), []);
  // No zero for an unknown count, no set with nothing in it, no earned beyond the total.
  assert.deepEqual(trophySetsOf({ trophySets: [{ id: "a", platform: "PS5", earned: null, total: 10 }, { id: "b", platform: "PS5", earned: 0, total: 0 }, { id: "c", platform: "PS5", earned: 11, total: 10 }] }), []);
});

test("trophy sets: the step-one shape is read as given, every set kept apart", () => {
  const sets = trophySetsOf({ trophySets: [
    { id: "psn:1", platform: "PS4", earned: 15, total: 30, progressPercent: 46, grades },
    { id: "steam:2", platform: "Steam", earned: 6, total: 30, progressPercent: null },
  ] });
  assert.equal(sets.length, 2);
  assert.deepEqual(sets[0], { id: "psn:1", platform: "PS4", earned: 15, total: 30, progressPercent: 46, grades });
  assert.equal(sets[1]!.grades, undefined);
  assert.equal(setPercent(sets[0]!), 46);
  assert.equal(setPercent(sets[1]!), 20);
});

test("trophy sets: incomplete grades are dropped, not filled in", () => {
  const [set] = trophySetsOf({ trophySets: [{ id: "a", platform: "PS5", earned: 1, total: 2, progressPercent: 50, grades: { gold: counts(1, 1), bronze: counts(0, 1) } }] });
  assert.equal(set!.grades, undefined);
});

test("trophies: a hidden one not yet earned loses its name, description and icon", () => {
  const icon = { id: "i", src: "/media/v2/a1.00", alt: "", width: 64, height: 64 };
  const [set] = trophySetsOf({ trophySets: [{ id: "a", platform: "PS5", earned: 1, total: 2, progressPercent: 50, trophies: [
    { id: "t1", name: "结局", detail: "走进结局", grade: "gold", icon, earned: false, earnedDate: "2025-01-01", rarityPercent: 12.5, hidden: true },
    { id: "t2", name: "开场", detail: "走出洞窟", grade: "bronze", icon, earned: true, earnedDate: "2025-01-02", rarityPercent: 80, hidden: true },
  ] }] });
  const [veiled, shown] = set!.trophies!;
  assert.deepEqual([veiled!.name, veiled!.detail, veiled!.icon, veiled!.earnedDate], [null, null, null, null]);
  assert.equal(shown!.name, "开场");
  assert.equal(shown!.icon?.src, "/media/v2/a1.00");
});

test("trophies: only site media is used for icons, and only a day for dates", () => {
  const row = (icon: unknown, earnedDate: unknown) => trophySetsOf({ trophySets: [{ id: "a", platform: "Steam", earned: 1, total: 1, progressPercent: 100,
    trophies: [{ id: "t", name: "n", detail: null, grade: null, icon, earned: true, earnedDate, rarityPercent: 3, hidden: false }] }] })[0]!.trophies![0]!;
  assert.equal(row({ src: "https://cdn.example/x.jpg" }, "2025-01-01").icon, null);
  assert.equal(row({ src: "//cdn.example/x.jpg" }, "2025-01-01").icon, null);
  assert.equal(row({ src: "/media/v2/a1.00" }, "2025-01-01T10:20:00Z").earnedDate, null);
});

test("trophies: a list with an unreadable row is not shown in part", () => {
  const [set] = trophySetsOf({ trophySets: [{ id: "a", platform: "PS5", earned: 1, total: 2, progressPercent: 50, trophies: [{ id: "t1", earned: true }, { name: "no id" }] }] });
  assert.equal(set!.trophies, undefined);
});

test("rarity tiers follow the round-two thresholds", () => {
  assert.deepEqual([2.1, 5, 9.9, 18.3, 23.9, 50, 74.9].map(rarityTier), ["极稀有", "极稀有", "很稀有", "稀有", "少见", "少见", "常见"]);
});

test("ordering: rarest earned, recent first, months, missing by grade", () => {
  const list = [
    trophy("a", { earned: true, earnedDate: "2022-04-28", rarityPercent: 23.9, grade: "gold" }),
    trophy("b", { earned: true, earnedDate: "2025-11-25", rarityPercent: 36.4 }),
    trophy("c", { earned: true, earnedDate: "2022-04-03", rarityPercent: 18.3 }),
    trophy("d", { earned: true, earnedDate: null, rarityPercent: null }),
    trophy("e", { rarityPercent: 60, grade: "silver" }),
    trophy("f", { rarityPercent: 10, grade: "platinum" }),
    trophy("g", { rarityPercent: 70, grade: "silver" }),
  ];
  assert.deepEqual(rarestEarned(list).map(t => t.id), ["c", "a", "b"]);
  assert.deepEqual(recentEarned(list).map(t => t.id), ["b", "a", "c", "d"]);
  assert.deepEqual(earnedByMonth(list).map(group => [group.label, group.trophies.length]), [["2025 年 11 月", 1], ["2022 年 4 月", 2], ["日期未记录", 1]]);
  assert.deepEqual(missingTrophies(list).map(t => t.id), ["f", "g", "e"]);
  assert.equal(earnedPlatinum(list), null);
  assert.equal(earnedPlatinum([trophy("p", { grade: "platinum", earned: true })])?.id, "p");
});

test("labels: day without a time, platform tones", () => {
  assert.equal(trophyDay("2025-11-02"), "2025 年 11 月 2 日");
  assert.equal(trophyDay("2025-11-02", false), "11 月 2 日");
  assert.deepEqual(["PS4", "PS5", "PlayStation", "Steam", "Xbox"].map(trophyPlatformTone), ["playstation", "playstation", "playstation", "pc", "other"]);
});

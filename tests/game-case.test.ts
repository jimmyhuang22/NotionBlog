import assert from "node:assert/strict";
import test from "node:test";
import type { GamePlatformPlayTime } from "../contracts/content.ts";
import { gameBoxArtEffectiveHeight, gameCaseAspectRatio, isGameBoxArtLayout, isGamePlatformPlayTime, isUsableGameBoxArt, matchesGamePlatform, selectGameCasePlatform } from "../src/lib/content/game-case.ts";

test("the existing PlayStation filter includes edition labels without broadening exact edition filters", () => {
  for (const label of ["PlayStation", "PlayStation 4", "PlayStation 5", "PS4", "PS5"]) {
    assert(matchesGamePlatform(["Steam", label], "PlayStation"));
  }
  assert(!matchesGamePlatform(["Steam", "Nintendo Switch"], "PlayStation"));
  assert(!matchesGamePlatform(["PlayStation 4"], "PlayStation 5"));
  assert(!matchesGamePlatform(["PlayStation"], "PlayStation 5"));
  assert(matchesGamePlatform(["PlayStation 5"], "PlayStation 5"));
});

test("game platform categories include console families and keep Steam and PC distinct", () => {
  for (const label of ["Nintendo Switch", "Nintendo Switch 2", "Nintendo 3DS", "3DS"]) {
    assert(matchesGamePlatform([label], "switch"));
  }
  assert(!matchesGamePlatform(["Wii U"], "switch"));
  for (const label of ["PlayStation", "PlayStation 2", "PS3", "PlayStation 4 Pro", "PS5", "PSP", "PS Vita", "PlayStation VR2"]) {
    assert(matchesGamePlatform([label], "playstation"));
  }
  assert(matchesGamePlatform(["Personal Computer"], "pc"));
  assert(matchesGamePlatform(["Steam"], "steam"));
  assert(!matchesGamePlatform(["Steam"], "pc"));
  assert(!matchesGamePlatform(["PC"], "steam"));
  assert(!matchesGamePlatform(["Nintendo Switch 2"], "Nintendo Switch"));
});

test("case platform ranks known positive hours, then recent and explicit labels", () => {
  const platforms = ["Nintendo Switch", "Nintendo Switch 2", "Steam"];
  const recent = ["Switch", "Steam"];
  const time = (platform: string, value: number): GamePlatformPlayTime => ({ platform, time: { value, unit: "hour" } });
  const pick = (platformPlayTime: GamePlatformPlayTime[] | null, lastPlayedPlatforms = recent) =>
    selectGameCasePlatform({ platforms, lastPlayedPlatforms, platformPlayTime });
  assert.equal(pick([time("PlayStation", 300), time("Nintendo Switch 2", 23), time("Steam", 22.95)]), "Nintendo Switch 2");
  assert.equal(pick([time("Nintendo Switch 2", 12), time("Steam", 12)]), "Steam");
  assert.equal(pick([time("Steam", 0)]), "Nintendo Switch");
  assert.equal(pick(null, ["Switch 2"]), "Nintendo Switch 2");
  assert.equal(pick(null, ["not tracked"]), "Nintendo Switch");
});

test("case dimensions require enough original pixels after a centered cover fit", () => {
  assert.deepEqual(["Switch 2", "PlayStation", "Steam"].map(gameCaseAspectRatio), [0.62, 0.79, 0.71]);
  assert.equal(gameBoxArtEffectiveHeight({ width: 600, height: 900 }, "Steam"), 797);
  assert.equal(gameBoxArtEffectiveHeight({ width: 400, height: 800 }, "PS5"), 468);
  assert.equal(gameBoxArtEffectiveHeight({ width: 500, height: 718 }, "Switch 2"), 718);
  assert.equal(gameBoxArtEffectiveHeight({ width: 800, height: 450 }, "Switch"), null);
  assert.equal(gameBoxArtEffectiveHeight({ width: null, height: null }, "Steam"), null);
});

test("3DS uses the Japanese case ratio and measures effective pixels in a square art slot", () => {
  const platform = "Nintendo 3DS";
  assert.equal(gameCaseAspectRatio(platform), 1.091);
  assert.equal(gameBoxArtEffectiveHeight({ width: 560, height: 560 }, platform), 560);
  assert.equal(gameBoxArtEffectiveHeight({ width: 600, height: 570 }, platform), 570);
  assert.equal(gameBoxArtEffectiveHeight({ width: 570, height: 600 }, platform), 570);
  assert(!isUsableGameBoxArt({ width: 559, height: 720 }, platform));
  assert(!isUsableGameBoxArt({ width: 1920, height: 1080 }, platform));
  assert(isUsableGameBoxArt({ width: 1500, height: 1372 }, platform, { mode: "retail", window: [7, 40, 1290, 1290] }));
  assert(!isUsableGameBoxArt({ width: 500, height: 457 }, platform, { mode: "retail", window: [3, 13, 429, 429] }));
});

test("explicit layouts admit square art and an in-bounds retail insert without changing the default", () => {
  const square = { width: 1024, height: 1024 };
  assert(!isUsableGameBoxArt(square, "Steam"));
  assert(isUsableGameBoxArt(square, "Steam", { mode: "contain" }));
  assert(!isUsableGameBoxArt({ width: 341, height: 450 }, "Steam", { mode: "contain" }));
  assert(!isUsableGameBoxArt({ width: 1920, height: 1080 }, "Steam", { mode: "contain" }));
  const print = { mode: "retail", window: [50, 220, 800, 1000], playStationModel: "PS5" };
  assert(isGameBoxArtLayout(print));
  assert(isUsableGameBoxArt({ width: 900, height: 1300 }, "PlayStation", print));
  assert(!isUsableGameBoxArt({ width: 900, height: 1200 }, "PlayStation", print));
  assert(!isUsableGameBoxArt({ width: 900, height: 1300 }, "PS4", print));
  assert(!isUsableGameBoxArt({ width: 900, height: 1300 }, "Nintendo Switch", print));
  assert(!isGameBoxArtLayout({ ...print, window: [0, 0, 1000, -1] }));
  assert(!isGameBoxArtLayout({ ...print, markup: "<img>" }));
  assert(!isUsableGameBoxArt({ width: 800, height: 1300 }, "Nintendo Switch 2", {
    mode: "retail", window: [0, 0, 800, 1300], printedSwitchMark: true,
  }));
});

test("public case time validation rejects foreign labels, duplicate entries and minute payloads", () => {
  const platforms = ["Steam", "PlayStation"];
  const valid = { platform: "Steam", time: { value: 0, unit: "hour" } };
  assert(isGamePlatformPlayTime([valid], platforms));
  assert(isGamePlatformPlayTime(null, platforms));
  assert(!isGamePlatformPlayTime([], platforms));
  assert(!isGamePlatformPlayTime([valid, valid], platforms));
  assert(!isGamePlatformPlayTime([{ ...valid, platform: "PC" }], platforms));
  assert(!isGamePlatformPlayTime([{ ...valid, time: { value: 60, unit: "minute" } }], platforms));
  assert(!isGamePlatformPlayTime([{ ...valid, provider: "Steam" }], platforms));
});

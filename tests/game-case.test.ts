import assert from "node:assert/strict";
import test from "node:test";
import type { GamePlatformPlayTime } from "../contracts/content.ts";
import { gameBoxArtEffectiveHeight, gameCaseAspectRatio, isGamePlatformPlayTime, selectGameCasePlatform } from "../src/lib/content/game-case.ts";

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

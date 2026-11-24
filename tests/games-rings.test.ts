import assert from "node:assert/strict";
import test from "node:test";
import type { Game } from "../contracts/content.ts";
import { coverTint } from "../src/lib/cover-tint.ts";
import { gameYearFacts } from "../src/lib/library.ts";

const game = (platforms: string[], playedTime: Game["playedTime"]) => ({ platforms, playedTime }) as Game;

test("a year's facts add the hours and count each platform family once per game", () => {
  const facts = gameYearFacts([
    game(["Nintendo Switch", "Nintendo Switch 2"], { value: 10.4, unit: "hour" }),
    game(["PlayStation 5", "Steam"], { value: 90, unit: "minute" }),
    game(["Steam"], null),
  ]);
  assert.equal(facts.hours, 12);
  assert.deepEqual(facts.platforms, [{ icon: "switch", count: 1 }, { icon: "playstation", count: 1 }, { icon: "steam", count: 2 }]);
});

test("a year with no time recorded says no hours", () => {
  assert.equal(gameYearFacts([game(["Steam"], null)]).hours, null);
  assert.deepEqual(gameYearFacts([]), { hours: null, platforms: [] });
});

test("the stage tint is a deep version of the cover's mid tones", () => {
  const pixels = [200, 100, 50, 255, 0, 0, 0, 255, 255, 255, 255, 255, 10, 10, 10, 0];
  assert.equal(coverTint(pixels), "63 32 16");
  assert.equal(coverTint([0, 0, 0, 255, 255, 255, 255, 255]), null);
});

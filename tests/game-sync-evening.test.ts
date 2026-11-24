import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runEveningTrophies, selectEveningSteamApps } from "../scripts/game-sync/evening-trophies.ts";
import { GameSyncError, type Observation } from "../scripts/game-sync/model.ts";
import { readJson, writeJson } from "../scripts/game-sync/private.ts";
import { collectSteamAchievementProgress } from "../scripts/game-sync/steam-achievements.ts";

const now = Date.parse("2026-10-01T06:00:00Z");
const steamId = "10000000000000001";
const appIds = Array.from({ length: 20 }, (_, index) => index + 1);
const policy = {
  mode: "fixed-allowlist", steamId,
  approvedAt: "2026-09-01T00:00:00Z", reviewedAt: "2026-09-01T00:00:00Z", confirmedComplete: true,
  verifiedPublicAppIds: appIds, privateAppIds: [2], hiddenAppIds: [3],
  products: Object.fromEntries(appIds.map(id => [id, { type: id === 4 ? "Demo" : "Game" }])),
};
const gameId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const config = {
  bindings: { "Steam:PC:6": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
  excluded: ["Steam:PC:5"],
};
function steamRow(id: number, lastPlayed: string | null): Observation {
  return {
    provider: "Steam", platform: "PC", account: "demo", productId: String(id), name: "Demo",
    minutes: 10, precision: "Minute", firstPlayed: null, lastPlayed, sourceUpdated: null,
    syncedAt: new Date(now).toISOString(), scope: "Library", ownership: "In library", visibility: "allowed",
    productType: "Game",
  };
}

test("evening Steam selection intersects current playtime, explicit scope, binding and privacy; older titles rotate", () => {
  const latest = new Date(now).toISOString();
  const rows = appIds.filter(id => id !== 7).map(id => steamRow(id, id >= 9 ? latest : null));
  const permitted = Object.fromEntries(appIds.filter(id => id !== 8).map(id => [id, gameId]));
  const selected = selectEveningSteamApps(permitted, steamId, policy, config, rows, now).map(target => target.appId);
  assert.equal(selected.length, 12);
  assert(selected.every(id => id === 1 || id >= 9));
  assert(selected.some(id => id >= 9));
  const covered = new Set(Array.from({ length: 6 }, (_, index) =>
    selectEveningSteamApps(permitted, steamId, policy, config, rows, now + index * 86400000)).flat().map(target => target.appId));
  assert(covered.has(1));
  assert.throws(() => selectEveningSteamApps({ "1": "invalid" }, steamId, policy, config, rows, now),
    { code: "STEAM_ACHIEVEMENT_SCOPE_REQUIRED" });
});

test("Steam statistics use only the player endpoint and preserve a verified zero", async () => {
  const signal = new AbortController().signal;
  let calls = 0;
  const request: typeof fetch = async input => {
    const url = new URL(String(input));
    assert.equal(url.pathname, "/ISteamUserStats/GetPlayerAchievements/v1/");
    assert.equal(url.searchParams.get("appid"), "1");
    calls++;
    return Response.json({ playerstats: { success: true, steamID: steamId,
      achievements: [{ apiname: "demo", achieved: 0 }] } });
  };
  const binding = { ...config, bindings: { "Steam:PC:1": gameId }, steamAchievementAppId: 1 };
  const result = await collectSteamAchievementProgress("a".repeat(32), steamId, policy, binding, signal, request);
  assert.equal(calls, 1);
  assert.deepEqual([result.earned, result.total, result.latestUnlockAt], [0, 1, null]);
  await assert.rejects(collectSteamAchievementProgress("a".repeat(32), steamId, policy,
    { ...config, steamAchievementAppId: 2 }, signal, request), { code: "STEAM_ACHIEVEMENT_SCOPE_REQUIRED" });
  assert.equal(calls, 1);
});

test("the evening receipt isolates provider failures and preserves the last successful snapshot", async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "game-evening-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const previous = { runId: "previous", sets: [{ earned: 1 }] };
  const steamPath = join(root, "evening-steam-trophy-stats.json");
  await writeJson(steamPath, previous);
  const result = await runEveningTrophies(root, "current", {
    psn: async () => ({ observedAt: new Date(now).toISOString(), sets: [{ earned: 2 }] }),
    steam: async () => { throw new GameSyncError("STEAM_UNAVAILABLE"); },
  }, new AbortController().signal);
  assert.deepEqual(result, {
    psn: { status: "collected", count: 1 }, steam: { status: "failed", code: "STEAM_UNAVAILABLE" },
  });
  assert.deepEqual(await readJson(steamPath), previous);
  assert.deepEqual(await readJson(join(root, "evening-psn-trophy-stats.json")), {
    version: 1, runId: "current", observedAt: new Date(now).toISOString(), sets: [{ earned: 2 }],
  });
  const expired = await runEveningTrophies(root, "expired", {
    psn: async () => assert.fail("expired PSN collection started"),
    steam: async () => assert.fail("expired Steam collection started"),
  }, AbortSignal.abort());
  assert.deepEqual(expired, {
    psn: { status: "failed", code: "TIME_LIMIT" }, steam: { status: "failed", code: "TIME_LIMIT" },
  });
});

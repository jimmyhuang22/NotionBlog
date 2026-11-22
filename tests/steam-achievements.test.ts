import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import sharp from "sharp";
import { fixtureItems } from "../fixtures/content.ts";
import { collectSteamAchievements, planSteamAchievements, writeSteamAchievements } from "../scripts/game-sync/steam-achievements.ts";
import { writePsnWebsiteTrophies } from "../scripts/game-sync/website-trophies.ts";
import { createCombinedGameTrophyReader } from "../src/server/database/game-trophies.ts";
import { publicationWriter } from "../src/server/database/publication.ts";
import type { SqlExecutor } from "../src/server/database/sql.ts";
import { configDigest } from "../src/server/database/website-validation.ts";
import { trophyIconResponse } from "../src/server/media/trophy-icon.ts";
import { ownerInstallFixture } from "./helpers/owner-install.ts";

const steamId = "10000000000000000", apiKey = "a".repeat(32), appId = 12345;
const item = { ...fixtureItems.game[0], id: "a".repeat(32), cover: null };
const config = { steamAchievementAppId: appId, bindings: { [`Steam:PC:${appId}`]: item.id }, excluded: [] as string[] };
const observed = new Date().toISOString();
const policy = { mode: "fixed-allowlist", approvedAt: observed, steamId, reviewedAt: observed, confirmedComplete: true,
  verifiedPublicAppIds: [appId], privateAppIds: [], hiddenAppIds: [], products: { [appId]: { type: "Game" } } };

test("Steam uses explicit scope, public icons, and local unlock dates while hiding locked spoilers", async () => {
  const original = await sharp({ create: { width: 2, height: 3, channels: 3, background: "white" } }).png().toBuffer();
  const icon = `https://steamcdn-a.akamaihd.net/steamcommunity/public/images/apps/${appId}/${"a".repeat(40)}.png`;
  const resolvedHiddenIcon = icon.replace(/a{40}/, "b".repeat(40));
  const redactedIcon = icon.replace(/a{40}/, "c".repeat(40));
  const requests: string[] = [];
  const read = async (input: URL | string | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    requests.push(url.href);
    const needsKey = /Get(PlayerAchievements|SchemaForGame)/.test(url.pathname);
    const key = new Headers(init?.headers).get("x-webapi-key");
    assert.equal(key, needsKey ? apiKey : null);
    assert.equal(init?.redirect, "error");
    if (url.pathname.includes("GetPlayerAchievements")) return Response.json({ playerstats: { steamID: steamId, success: true,
      achievements: [{ apiname: "open", achieved: 1, unlocktime: Date.parse("2025-01-01T14:00:00Z") / 1000 },
        { apiname: "earned-hidden", achieved: 1, unlocktime: 0 }, { apiname: "hidden", achieved: 0, unlocktime: 0 }] } });
    if (url.pathname.includes("GetSchemaForGame")) return Response.json({ game: { availableGameStats: { achievements: [
      { name: "open", displayName: "示例成就", description: "示例说明", hidden: 0, icon },
      { name: "earned-hidden", displayName: "已解锁的隐藏成就", hidden: 1, icon: resolvedHiddenIcon },
      { name: "hidden", displayName: "隐藏成就名称", description: "隐藏剧透", hidden: 1, icon: redactedIcon },
    ] } } });
    if (url.pathname.includes("GetGlobalAchievementPercentagesForApp")) {
      return Response.json({ achievementpercentages: { achievements: [
        { name: "open", percent: "8.754" }, { name: "hidden", percent: 0.6 },
      ] } });
    }
    return new Response(Uint8Array.from(original));
  };

  const payload = await collectSteamAchievements(apiKey, steamId, policy, config, "Australia/Melbourne", read);
  const plan = planSteamAchievements(payload, steamId, policy, config);
  const [earned, earnedHidden, locked] = plan.set.trophies;
  assert.equal(earned.earnedDate, "2025-01-02");
  assert.equal(earned.rarityPercent, 8.8);
  assert.equal(earnedHidden.earned, true);
  assert.equal(earnedHidden.hidden, true);
  assert.equal(earnedHidden.earnedDate, null);
  assert.equal(earnedHidden.name, "已解锁的隐藏成就");
  assert.ok(earnedHidden.icon);
  assert.deepEqual(locked, { id: locked.id, detail: null, earned: false, earnedDate: null,
    hidden: true, name: null, icon: null, rarityPercent: null });
  assert.ok(!requests.includes(redactedIcon));
  assert.deepEqual(Buffer.from(earned.icon.bytes, "base64"), original);
  assert.doesNotMatch(JSON.stringify(plan), /10000000000000000|steamcdn-a|隐藏剧透/);
  assert.throws(() => planSteamAchievements(payload, steamId, { ...policy, privateAppIds: [appId] }, config), /SCOPE_REQUIRED/);
  assert.throws(() => planSteamAchievements(payload, steamId, policy, { ...config, excluded: Object.keys(config.bindings) }), /SCOPE_REQUIRED/);
  assert.throws(() => planSteamAchievements(payload, steamId, policy, config, Date.parse(payload.observedAt) + 3600001), /INVALID_TROPHY_SNAPSHOT/);
  const noRequests = () => { throw new Error("unexpected request"); };
  await assert.rejects(collectSteamAchievements(apiKey, steamId, { ...policy, hiddenAppIds: [appId] },
    config, "Australia/Melbourne", noRequests), /SCOPE_REQUIRED/);

  const { db, close } = await ownerInstallFixture();
  try {
    const role = (name: "nb_reader" | "nb_writer"): SqlExecutor => ({
      query: <T>(sql: string, values?: unknown[]) => db.transaction(async tx => {
        await tx.exec(`SET LOCAL ROLE ${name}`);
        return tx.query<T>(sql, values);
      }),
    });
    const reader = role("nb_reader"), writer = role("nb_writer");
    for (const file of ["001_psn_trophy_sets.sql", "002_psn_trophy_details.sql", "003_steam_achievements.sql"]) {
      await db.exec(await readFile(new URL(`../database/game-trophy-migrations/${file}`, import.meta.url), "utf8"));
    }
    const sources = [{ key: "game", kind: "game", mode: "all", dataSourceId: "fixture-source", databaseParentId: null, pageId: null }];
    const digest = configDigest([sources, []] as const);
    await db.query("SELECT nb_v2_api.configure_policy($1,600,$2::jsonb,'[]')", [digest, JSON.stringify(sources)]);
    const publication = publicationWriter(writer, "published");
    const lease = await publication.begin(randomUUID(), digest);
    await publication.stage(lease, [{ detail: { item, document: { blocks: [], toc: [], completeness: "complete" } },
      evidence: { sourceKey: "game", dataSourceId: "fixture-source", databaseParentId: null, courseId: null, parentId: null, ordinal: 0 } }]);
    await publication.promote(lease, { records: 1, media: 0, complete: true });
    assert.equal(await writePsnWebsiteTrophies(writer, { observedAt: plan.observedAt, sets: [{
      id: "psn:" + "b".repeat(32), gameId: item.id, platform: "PS5", earned: 1, total: 1, progressPercent: 100,
      grades: { platinum: { earned: 0, total: 0 }, gold: { earned: 0, total: 0 },
        silver: { earned: 0, total: 0 }, bronze: { earned: 1, total: 1 } },
    }] }), true);
    const readSets = createCombinedGameTrophyReader(reader, "published");
    const psn = await readSets(item.id, item.slug);
    assert.equal(await writeSteamAchievements(writer, plan), true);
    assert.equal(await writeSteamAchievements(writer, plan), false);
    const [oldSet, steam] = await readSets(item.id, item.slug);
    assert.deepEqual(oldSet, psn[0]);
    assert.deepEqual([steam.platform, steam.earned, steam.total, steam.progressPercent, steam.grades], ["Steam", 2, 3, 67, undefined]);
    assert.equal(steam.trophies?.[0].grade, null);
    assert.equal(steam.trophies?.[0].earnedDate, "2025-01-02");
    assert.equal(steam.trophies?.[2].icon, null);
    assert.deepEqual(await readSets(item.id, "wrong-slug"), []);
    const response = await trophyIconResponse(reader, "published", earned.icon.id);
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), original);
    const later = new Date(Date.parse(plan.observedAt) + 1000).toISOString();
    await assert.rejects(writer.query("SELECT nb_game_trophies_api.replace_steam_achievements($1,$2::jsonb)",
      [later, JSON.stringify({ ...plan.set, trophies: [earned, earned] })]), /duplicate key/);
    assert.equal((await readSets(item.id, item.slug))[1].total, 3);
    await assert.rejects(reader.query("SELECT * FROM nb_game_trophies.steam_achievements"), /permission denied/);
    await db.query("SELECT nb_v2_api.set_denied($1,true)", [item.id]);
    assert.deepEqual(await readSets(item.id, item.slug), []);
    assert.equal((await trophyIconResponse(reader, "published", earned.icon.id)).status, 404);
  } finally {
    await close();
  }
});

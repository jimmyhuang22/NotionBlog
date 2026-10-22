import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { collectSteam, fixedSteamPolicy, steamPolicy, steamRows } from "../scripts/game-sync/steam.ts";
import { writeJson } from "../scripts/game-sync/private.ts";
import { runDaily } from "../scripts/game-sync/daily.ts";

const policy = () => ({ mode: "fixed-allowlist", approvedAt: "2026-01-01T00:00:00Z", steamId: "76561198000000000",
  reviewedAt: "2026-01-01T00:00:00Z", confirmedComplete: true, verifiedPublicAppIds: [1, 2, 3],
  privateAppIds: [2], hiddenAppIds: [3], products: { "1": { type: "Game" }, "2": { type: "Game" }, "3": { type: "Demo" }, "5": { type: "Software" } } });
async function directory() { const root = await realpath(await mkdtemp(join(tmpdir(), "steam-allowlist-"))); await chmod(root, 0o700); return root; }

test("durable Steam scope remains valid while the same old manual review still expires", () => {
  assert.equal(steamPolicy(policy()).mode, "fixed-allowlist");
  const { mode, approvedAt, steamId, ...manual } = policy();
  assert.throws(() => steamPolicy(manual), { code: "STEAM_PRIVACY_REVIEW_REQUIRED" });
  for (const change of [{ approvedAt: "invalid" }, { approvedAt: "2999-01-01" }, { steamId: "" }, { confirmedComplete: false }, { verifiedPublicAppIds: [1, 1] }]) {
    assert.throws(() => steamPolicy({ ...policy(), ...change }), { code: "STEAM_PRIVACY_REVIEW_REQUIRED" });
  }
});
test("fixed Steam exclusions win, unknown products stay pending and real zero is preserved", () => {
  const games = [1, 2, 3, 4, 5].map(appid => ({ appid, name: `Example ${appid}`, playtime_forever: 0 }));
  const rows = steamRows({ game_count: 5, games }, { total_count: 0 }, policy(), "test", new Date().toISOString());
  assert.deepEqual(rows.map(row => row.visibility), ["allowed", "excluded", "excluded", "unknown", "excluded"]);
  assert.equal(rows[0].minutes, 0);
});
test("an allowlist for another account stops before any account request", async () => {
  await assert.rejects(collectSteam("a".repeat(32), "76561198000000001", policy(), "test"), { code: "STEAM_ACCOUNT_MISMATCH" });
});
test("missing fixed scope is optional but a malformed opt-in cannot fall back to a manual policy", async () => {
  const root = await directory();
  try {
    assert.equal(await fixedSteamPolicy(root), null);
    await writeJson(join(root, "steam-allowlist.json"), policy());
    assert.equal((await fixedSteamPolicy(root))?.mode, "fixed-allowlist");
    await writeJson(join(root, "steam-allowlist.json"), { ...policy(), mode: "manual" });
    await assert.rejects(fixedSteamPolicy(root), { code: "STEAM_ALLOWLIST_REQUIRED" });
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("opted-in daily cycle collects, plans and verifies Steam after both existing providers", async () => {
  const root = await directory(), calls: string[] = [];
  try {
    const result = await runDaily(root, randomUUID(), {
      collect: async provider => { calls.push(`collect:${provider}`); return { collected: 1 }; },
      sync: async (provider, apply) => { calls.push(`${apply ? "apply" : "dry-run"}:${provider}`); return { applied: apply, create: 0, update: 0, archive: 0, verified: 0 }; },
    }, true);
    assert.equal(result.status, "verified"); assert.equal(result.stages.length, 9);
    assert.deepEqual(calls.slice(-3), ["collect:steam", "dry-run:steam", "apply:steam"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

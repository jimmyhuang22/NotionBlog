import { callSql, type SqlExecutor } from "../../src/server/database/sql.ts";
import { GameSyncError, object } from "./model.ts";
import {
  allowedSteamAchievementApps, collectSteamAchievements, maxSteamAchievementSnapshotBytes,
  planSteamAchievements, steamAchievementSetId,
} from "./steam-achievements.ts";

const maxSelectedGames = 12;
const setIdPattern = /^steam:[0-9a-f]{32}$/;
type SteamChange = ReturnType<typeof planSteamAchievements>["set"] | { id: string; gameId: null };
type BatchPlan = { observedAt: string; changes: SteamChange[] };

function selectedApps(config: Record<string, unknown>) {
  const ids = config.steamAchievementAppIds;
  if (!Array.isArray(ids) || !ids.length || ids.length > maxSelectedGames || new Set(ids).size !== ids.length ||
      ids.some(id => !Number.isSafeInteger(id) || id <= 0)) {
    throw new GameSyncError("STEAM_ACHIEVEMENT_SCOPE_REQUIRED");
  }
  return ids as number[];
}

/** Only explicitly selected games are collected. Every selected product must pass the current exclusions. */
export async function collectSteamAchievementBatch(apiKey: string, steamId: string, policy: unknown, input: unknown,
  timeZone: string, request = fetch) {
  const config = object(input), selected = selectedApps(config);
  const allowed = allowedSteamAchievementApps(steamId, policy, config);
  if (selected.some(appId => !allowed.has(appId))) throw new GameSyncError("STEAM_ACHIEVEMENT_SCOPE_REQUIRED");
  const entries = [];
  let bytes = 0;
  for (const appId of selected) {
    const snapshot = await collectSteamAchievements(apiKey, steamId, policy, { ...config, steamAchievementAppId: appId }, timeZone, request);
    entries.push({ appId, snapshot });
    bytes += Buffer.byteLength(JSON.stringify(snapshot));
    if (bytes > maxSteamAchievementSnapshotBytes) throw new GameSyncError("STEAM_ACHIEVEMENT_ICON_BUDGET");
  }
  return { version: 1, entries };
}

function withdrawExcludedSets(allowed: ReadonlySet<number>, active: string[]): SteamChange[] {
  if (!Array.isArray(active) || active.some(id => typeof id !== "string" || !setIdPattern.test(id)) ||
      new Set(active).size !== active.length) throw new GameSyncError("INVALID_TROPHY_SNAPSHOT");
  const allowedSets = new Set([...allowed].map(steamAchievementSetId));
  return active.filter(id => !allowedSets.has(id)).map(id => ({ id, gameId: null }));
}

/** The current policy can withdraw already-published sets even when the selected batch covers other games. */
export function planSteamAchievementWithdrawals(steamId: string, policy: unknown, config: unknown, active: string[],
  now = Date.now()): BatchPlan {
  return { observedAt: new Date(now).toISOString(),
    changes: withdrawExcludedSets(allowedSteamAchievementApps(steamId, policy, config), active) };
}

export function planSteamAchievementBatch(input: unknown, steamId: string, policy: unknown, value: unknown, active: string[],
  now = Date.now()): BatchPlan {
  const snapshot = object(input), config = object(value);
  const selected = new Set(selectedApps(config)), allowed = allowedSteamAchievementApps(steamId, policy, config);
  if (snapshot.version !== 1 || !Array.isArray(snapshot.entries) || snapshot.entries.length !== selected.size) {
    throw new GameSyncError("INVALID_TROPHY_SNAPSHOT");
  }
  const changes = withdrawExcludedSets(allowed, active);
  const targets = new Set<string>();
  let observedAt = new Date(now).toISOString();
  for (const value of snapshot.entries) {
    const entry = object(value), appId = entry.appId;
    if (typeof appId !== "number" || !selected.delete(appId)) throw new GameSyncError("INVALID_TROPHY_SNAPSHOT");
    // A game excluded after collection may only be withdrawn by this import.
    if (!allowed.has(appId)) continue;
    const plan = planSteamAchievements(entry.snapshot, steamId, policy, { ...config, steamAchievementAppId: appId }, now);
    if (targets.has(plan.set.gameId)) throw new GameSyncError("STEAM_ACHIEVEMENT_BINDING_CONFLICT");
    targets.add(plan.set.gameId);
    if (plan.observedAt < observedAt) observedAt = plan.observedAt;
    changes.push(plan.set);
  }
  return { observedAt, changes };
}

export function readActiveSteamAchievementSets(db: SqlExecutor) {
  return callSql<string[]>(db, "SELECT nb_game_trophies_api.list_active_steam_sets() AS result", []);
}

export async function writeSteamAchievementBatch(db: SqlExecutor, plan: BatchPlan) {
  if (!plan.changes.length) return false;
  const changes = JSON.stringify(plan.changes);
  if (Buffer.byteLength(changes) > maxSteamAchievementSnapshotBytes) throw new GameSyncError("STEAM_ACHIEVEMENT_ICON_BUDGET");
  return callSql<boolean>(db, "SELECT nb_game_trophies_api.apply_steam_achievement_batch($1,$2::jsonb) AS result",
    [plan.observedAt, changes]);
}

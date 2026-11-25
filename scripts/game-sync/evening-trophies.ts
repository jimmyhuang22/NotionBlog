import { join } from "node:path";
import { safeCode } from "./daily.ts";
import { GameSyncError, object, type Observation } from "./model.ts";
import { normalizedId } from "./plan.ts";
import { writeJson } from "./private.ts";
import { allowedSteamAchievementApps } from "./steam-achievements.ts";

const steamBatchSize = 12;
const steamRotationSize = 3;
const dayMs = 24 * 60 * 60 * 1000;

export function selectEveningSteamApps(input: unknown, steamId: string, policy: unknown, config: unknown,
  rows: Observation[], now = Date.now()) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new GameSyncError("STEAM_ACHIEVEMENT_SCOPE_REQUIRED");
  }
  const entries = Object.entries(input);
  if (!entries.length || entries.length > 10000 || entries.some(([id, game]) =>
    !/^[1-9][0-9]*$/.test(id) || !Number.isSafeInteger(Number(id)) || typeof game !== "string" ||
    !/^[0-9a-f]{32}$/.test(normalizedId(game)))) {
    throw new GameSyncError("STEAM_ACHIEVEMENT_SCOPE_REQUIRED");
  }
  const scope = new Map(entries.map(([id, game]) => [Number(id), normalizedId(game as string)]));
  const allowed = allowedSteamAchievementApps(steamId, policy, config);
  const bindings = object(object(config).bindings);
  const games = new Map(rows.filter(row => row.provider === "Steam" && row.platform === "PC" &&
    row.visibility === "allowed" && row.productType === "Game").map(row => [Number(row.productId), row]));
  const candidates = [...scope.keys()].filter(appId => {
    const key = `Steam:PC:${appId}`;
    const binding = Object.hasOwn(bindings, key) ? bindings[key] : undefined;
    return allowed.has(appId) && games.has(appId) &&
      (binding === undefined || (typeof binding === "string" && normalizedId(binding) === scope.get(appId)));
  }).sort((a, b) => a - b);
  if (!candidates.length) return [];
  const offset = (Math.floor(now / dayMs) * steamRotationSize) % candidates.length;
  const rotation = [...candidates.slice(offset), ...candidates.slice(0, offset)].slice(0, steamRotationSize);
  function lastPlayed(appId: number) {
    const value = games.get(appId)?.lastPlayed;
    return value ? Date.parse(value) : 0;
  }
  const recent = candidates.filter(appId => lastPlayed(appId) >= now - 2 * dayMs)
    .sort((a, b) => lastPlayed(b) - lastPlayed(a) || a - b);
  return [...new Set([...rotation, ...recent])].slice(0, steamBatchSize)
    .map(appId => ({ appId, gameId: scope.get(appId)! }));
}

type TrophyStage = (signal: AbortSignal) => Promise<{ observedAt: string; sets: unknown[] } | null>;
type TrophyResult = { status: "collected"; count: number } | { status: "skipped" } | { status: "failed"; code: string };
type TrophyProvider = "psn" | "steam";

/** Called only after a verified daily run, with same-run observations and the account lock still held. */
export async function runEveningTrophies(root: string, runId: string, providers: Record<TrophyProvider, TrophyStage>,
  signal: AbortSignal) {
  const path = join(root, "evening-trophy-receipt.json");
  const receipt: { runId: string; startedAt: string; finishedAt?: string; status: "running" | "complete";
    providers: Partial<Record<TrophyProvider, TrophyResult>> } = {
    runId, startedAt: new Date().toISOString(), status: "running", providers: {},
  };
  await writeJson(path, receipt);
  for (const provider of ["psn", "steam"] as const) {
    try {
      if (signal.aborted) throw new GameSyncError("TIME_LIMIT");
      const snapshot = await providers[provider](signal);
      if (signal.aborted) throw new GameSyncError("TIME_LIMIT");
      if (snapshot === null) receipt.providers[provider] = { status: "skipped" };
      else {
        await writeJson(join(root, `evening-${provider}-trophy-stats.json`), { version: 1, runId, ...snapshot });
        receipt.providers[provider] = { status: "collected", count: snapshot.sets.length };
      }
    } catch (error) {
      receipt.providers[provider] = { status: "failed", code: signal.aborted ? "TIME_LIMIT" : safeCode(error) };
    }
    await writeJson(path, receipt);
  }
  receipt.status = "complete";
  receipt.finishedAt = new Date().toISOString();
  await writeJson(path, receipt);
  return receipt.providers;
}

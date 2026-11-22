import { createHash } from "node:crypto";
import { platformPlayDay } from "../../src/lib/content/game-date.ts";
import { callSql, type SqlExecutor } from "../../src/server/database/sql.ts";
import { sanitizePublicText } from "../../src/server/notion/public-text.ts";
import { date, GameSyncError, object } from "./model.ts";
import { normalizedId } from "./plan.ts";
import { steamPolicy } from "./steam.ts";
import { createTrophyIconCollector } from "./trophy-icons.ts";

export const maxSteamAchievementSnapshotBytes = 24 * 1024 * 1024;
const steamHosts = new Set(["steamcdn-a.akamaihd.net", "cdn.akamai.steamstatic.com",
  "cdn.cloudflare.steamstatic.com", "cdn.fastly.steamstatic.com"]);

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

/** The playtime allowlist and the site's explicit selection and binding must all agree. */
function steamAchievementScope(steamId: string, policyInput: unknown, config: unknown) {
  const policy = steamPolicy(policyInput), site = object(config);
  if (policy.mode !== "fixed-allowlist" || policy.steamId !== steamId) throw new GameSyncError("STEAM_ACCOUNT_MISMATCH");
  const appId = site.steamAchievementAppId;
  if (typeof appId !== "number" || !policy.verifiedPublicAppIds.includes(appId) ||
      policy.hiddenAppIds.includes(appId) || policy.privateAppIds.includes(appId) ||
      !Object.hasOwn(policy.products, String(appId)) || policy.products[appId]?.type !== "Game") {
    throw new GameSyncError("STEAM_ACHIEVEMENT_SCOPE_REQUIRED");
  }
  const key = `Steam:PC:${appId}`, bindings = object(site.bindings);
  const binding = Object.hasOwn(bindings, key) ? bindings[key] : undefined;
  const gameId = typeof binding === "string" ? normalizedId(binding) : "";
  if (!Array.isArray(site.excluded) || site.excluded.some(entry => typeof entry !== "string") ||
      site.excluded.includes(key) || !/^[0-9a-f]{32}$/.test(gameId)) {
    throw new GameSyncError("STEAM_ACHIEVEMENT_SCOPE_REQUIRED");
  }
  return { appId, gameId, owner: hash(steamId), setId: "steam:" + hash(key).slice(0, 32) };
}

function achievementRows(value: unknown, idField: string) {
  const result = new Map<string, Record<string, unknown>>();
  if (!Array.isArray(value) || value.length > 10000) throw new GameSyncError("STEAM_ACHIEVEMENTS_INCOMPLETE");
  for (const entry of value) {
    const row = object(entry), id = row[idField];
    if (typeof id !== "string" || !id.trim() || id.length > 500 || result.has(id)) {
      throw new GameSyncError("STEAM_ACHIEVEMENTS_INCOMPLETE");
    }
    result.set(id, row);
  }
  return result;
}

function publicText(value: unknown, limit: number) {
  return typeof value === "string" ? sanitizePublicText(value.trim()).slice(0, limit) || null : null;
}

function rarityPercent(value: unknown) {
  // Valve returns decimal strings for some titles and numbers for others.
  const percent = typeof value === "string" && /^\d{1,3}(\.\d+)?$/.test(value) ? Number(value) : value;
  if (percent == null) return null;
  if (typeof percent !== "number" || !Number.isFinite(percent) || percent < 0 || percent > 100) {
    throw new GameSyncError("STEAM_ACHIEVEMENTS_INCOMPLETE");
  }
  return Math.round(percent * 10) / 10;
}

async function readStats(method: string, params: Record<string, string>, apiKey: string | null, request: typeof fetch) {
  const url = new URL("/ISteamUserStats/" + method, "https://api.steampowered.com");
  url.search = new URLSearchParams(params).toString();
  try {
    const response = await request(url, { ...(apiKey ? { headers: { "x-webapi-key": apiKey } } : {}),
      redirect: "error", signal: AbortSignal.timeout(20_000) });
    if (!response.ok || !response.body) throw new GameSyncError("STEAM_UNAVAILABLE");
    const reader = response.body.getReader(), chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 2 * 1024 * 1024) throw new GameSyncError("STEAM_ACHIEVEMENTS_INCOMPLETE");
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    return object(JSON.parse(Buffer.concat(chunks, size).toString("utf8")));
  } catch (error) {
    if (error instanceof GameSyncError) throw error;
    throw new GameSyncError("STEAM_UNAVAILABLE");
  }
}

export async function collectSteamAchievements(apiKey: string, steamId: string, policy: unknown, config: unknown,
  timeZone: string, request = fetch) {
  if (!/^[a-f0-9]{32}$/i.test(apiKey)) throw new GameSyncError("STEAM_CONFIG_REQUIRED");
  const { appId, gameId, owner, setId } = steamAchievementScope(steamId, policy, config);
  if (!timeZone) throw new GameSyncError("STEAM_ACHIEVEMENT_TIME_ZONE_REQUIRED");
  try { new Intl.DateTimeFormat("en", { timeZone }); }
  catch { throw new GameSyncError("STEAM_ACHIEVEMENT_TIME_ZONE_REQUIRED"); }

  const appid = String(appId);
  const observedAt = new Date().toISOString();
  const [player, schema, population] = await Promise.all([
    readStats("GetPlayerAchievements/v1/", { appid, steamid: steamId }, apiKey, request),
    readStats("GetSchemaForGame/v2/", { appid, l: "schinese" }, apiKey, request),
    readStats("GetGlobalAchievementPercentagesForApp/v2/", { gameid: appid }, null, request),
  ]);
  const stats = object(player.playerstats);
  if (stats.success !== true || (stats.steamID !== undefined && stats.steamID !== steamId)) {
    throw new GameSyncError("STEAM_ACHIEVEMENTS_INCOMPLETE");
  }
  const states = achievementRows(stats.achievements, "apiname");
  const definitions = achievementRows(object(object(schema.game).availableGameStats).achievements, "name");
  const rates = achievementRows(object(population.achievementpercentages).achievements, "name");
  if (!definitions.size || states.size !== definitions.size || [...rates.keys()].some(id => !definitions.has(id))) {
    throw new GameSyncError("STEAM_ACHIEVEMENTS_INCOMPLETE");
  }
  const iconPath = new RegExp(`^/steamcommunity/public/images/apps/${appid}/[a-f0-9]{40}\\.(jpg|png)$`, "i");
  const readIcon = createTrophyIconCollector("steam", 8 * 1024 * 1024, "STEAM_ACHIEVEMENT_ICON_BUDGET",
    url => steamHosts.has(url.hostname) && iconPath.test(url.pathname) && !url.search && !url.hash, request);

  const rows = [...definitions].map(([sourceId, definition]) => {
    const state = states.get(sourceId);
    if (!state || (state.achieved !== 0 && state.achieved !== 1) ||
        (definition.hidden !== 0 && definition.hidden !== 1)) throw new GameSyncError("STEAM_ACHIEVEMENTS_INCOMPLETE");
    const earned = state.achieved === 1, hidden = definition.hidden === 1, redact = hidden && !earned;
    const time = state.unlocktime ?? 0;
    if (typeof time !== "number" || !Number.isSafeInteger(time) || time < 0 ||
        time * 1000 > Date.parse(observedAt) + 60000 || (!earned && time !== 0)) {
      throw new GameSyncError("STEAM_ACHIEVEMENTS_INCOMPLETE");
    }
    const earnedDate = time > 0 ? platformPlayDay({ start: new Date(time * 1000).toISOString(), end: null,
      precision: "datetime" }, timeZone)?.start ?? null : null;
    const name = redact ? null : publicText(definition.displayName, 500);
    if (!redact && !name) throw new GameSyncError("STEAM_ACHIEVEMENTS_INCOMPLETE");
    return { id: hash(`${setId}:${sourceId}`).slice(0, 32), earned, hidden, earnedDate, name,
      detail: redact ? null : publicText(definition.description, 2000),
      rarityPercent: redact ? null : rarityPercent(rates.get(sourceId)?.percent),
      iconUrl: redact ? null : definition.icon };
  });
  const trophies = [];
  for (const { iconUrl, ...row } of rows) {
    const icon = typeof iconUrl === "string" ? await readIcon(iconUrl, setId, row.id) : null;
    trophies.push({ ...row, icon });
  }
  return { version: 1, observedAt, owner, set: { id: setId, gameId, trophies } };
}

export function planSteamAchievements(input: unknown, steamId: string, policy: unknown, config: unknown, now = Date.now()) {
  const { gameId, owner, setId } = steamAchievementScope(steamId, policy, config);
  const snapshot = object(input), set = object(snapshot.set), observedAt = date(snapshot.observedAt);
  if (snapshot.version !== 1 || snapshot.owner !== owner || set.id !== setId || set.gameId !== gameId ||
      !observedAt || Date.parse(observedAt) < now - 3600000 || Date.parse(observedAt) > now + 60000 ||
      !Array.isArray(set.trophies) || !set.trophies.length || set.trophies.length > 10000) {
    throw new GameSyncError("INVALID_TROPHY_SNAPSHOT");
  }
  return { observedAt, set: { id: setId, gameId, trophies: set.trophies } };
}

export function writeSteamAchievements(db: SqlExecutor, plan: ReturnType<typeof planSteamAchievements>) {
  return callSql<boolean>(db, "SELECT nb_game_trophies_api.replace_steam_achievements($1,$2::jsonb) AS result",
    [plan.observedAt, JSON.stringify(plan.set)]);
}

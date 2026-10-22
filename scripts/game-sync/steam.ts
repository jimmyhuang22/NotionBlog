import { GameSyncError, amount, object, required, unique } from "./model.ts";
import type { Observation } from "./model.ts";
import { join } from "node:path";
import { readJson } from "./private.ts";

/** Manual privacy evidence or explicitly approved fixed sync scope; neither is inferred from account responses. */
export interface SteamPolicy {
  mode?: "fixed-allowlist"; approvedAt?: string; steamId?: string;
  reviewedAt: string; confirmedComplete: true;
  verifiedPublicAppIds: number[]; privateAppIds: number[]; hiddenAppIds: number[];
  products: Record<string, { type: "Game" | "Demo" | "Mod" | "Playtest" | "Software" }>;
}
export function steamPolicy(input: unknown, now = Date.now()): SteamPolicy {
  const p = object(input), reviewed = Date.parse(required(p.reviewedAt));
  const fixed = p.mode === "fixed-allowlist", approved = Date.parse(typeof p.approvedAt === "string" ? p.approvedAt : "");
  if (p.mode != null && !fixed) throw new GameSyncError("STEAM_ALLOWLIST_REQUIRED");
  if (p.confirmedComplete !== true || !Number.isFinite(reviewed) || reviewed > now + 60000 ||
      (fixed ? !Number.isFinite(approved) || approved > now + 60000 || typeof p.steamId !== "string" || !/^\d{17}$/.test(p.steamId) : now - reviewed > 60 * 60000)) {
    throw new GameSyncError("STEAM_PRIVACY_REVIEW_REQUIRED");
  }
  for (const field of ["verifiedPublicAppIds", "privateAppIds", "hiddenAppIds"]) {
    const values = p[field];
    if (!Array.isArray(values) || values.some(v => !Number.isSafeInteger(v) || v <= 0) || new Set(values).size !== values.length) {
      throw new GameSyncError("STEAM_PRIVACY_REVIEW_REQUIRED");
    }
  }
  for (const [key, product] of Object.entries(object(p.products))) {
    if (!/^\d+$/.test(key) || !["Game", "Demo", "Mod", "Playtest", "Software"].includes(required(object(product).type))) {
      throw new GameSyncError("STEAM_PRODUCT_REVIEW_REQUIRED");
    }
  }
  return p as unknown as SteamPolicy;
}
/** Explicit durable sync authorization, not a fresh statement about Steam's current privacy settings. */
export async function fixedSteamPolicy(root: string): Promise<SteamPolicy | null> {
  const value = await readJson(join(root, "steam-allowlist.json"));
  if (value === null) return null;
  const policy = steamPolicy(value);
  if (policy.mode !== "fixed-allowlist") throw new GameSyncError("STEAM_ALLOWLIST_REQUIRED");
  return policy;
}
export function steamRows(ownedInput: unknown, recentInput: unknown, policyInput: unknown,
  account: string, syncedAt: string): Observation[] {
  const policy = steamPolicy(policyInput), owned = object(ownedInput), recent = object(recentInput);
  const complete = (data: Record<string, unknown>, count: string) => {
    const values = data.games ?? [];
    if (!Number.isSafeInteger(data[count]) || (data[count] as number) < 0 || (data[count] as number) > 10000 ||
      !Array.isArray(values) || values.length !== data[count]) {
      throw new GameSyncError("STEAM_SCOPE_INCOMPLETE");
    }
    return values;
  };
  const games = complete(owned, "game_count"), recentGames = complete(recent, "total_count");
  const byRecent = new Map<string, Record<string, unknown>>();
  for (const value of recentGames) {
    const r = object(value), key = String(r.appid);
    if (!Number.isSafeInteger(r.appid) || (r.appid as number) <= 0 || byRecent.has(key)) throw new GameSyncError("STEAM_SCOPE_INCOMPLETE");
    byRecent.set(key, r);
  }
  const approved = new Set(policy.verifiedPublicAppIds), excluded = new Set([...policy.privateAppIds, ...policy.hiddenAppIds]);
  return unique(games.map(value => {
    const r = object(value), appId = r.appid;
    if (!Number.isSafeInteger(appId) || (appId as number) <= 0) throw new GameSyncError("STEAM_SCOPE_INCOMPLETE");
    const key = String(appId), product = policy.products[key];
    const last = r.rtime_last_played;
    if (last != null && (!Number.isSafeInteger(last) || (last as number) < 0)) throw new GameSyncError("INVALID_RESPONSE");
    return { provider: "Steam", account, platform: "PC", productId: key, name: required(r.name),
      minutes: amount(r.playtime_forever), recentMinutes: byRecent.has(key) ? amount(byRecent.get(key)!.playtime_2weeks) : 0,
      precision: "Minute", firstPlayed: null, lastPlayed: last ? new Date((last as number) * 1000).toISOString() : null,
      sourceUpdated: null, syncedAt, scope: "Library", ownership: "In library",
      visibility: excluded.has(appId as number) || product?.type === "Software" ? "excluded" : approved.has(appId as number) && product ? "allowed" : "unknown",
      ...(product ? { productType: product.type } : {}), productUrl: `https://store.steampowered.com/app/${key}/` } as Observation;
  }));
}
export async function collectSteam(apiKey: string, steamId: string, policyInput: unknown, account: string) {
  if (!/^[a-f0-9]{32}$/i.test(apiKey) || !/^\d{17}$/.test(steamId)) throw new GameSyncError("STEAM_CONFIG_REQUIRED");
  const policy = steamPolicy(policyInput);
  if (policy.mode === "fixed-allowlist" && policy.steamId !== steamId) throw new GameSyncError("STEAM_ACCOUNT_MISMATCH");
  async function read(path: string, params: Record<string, string>) {
    const url = new URL(path, "https://api.steampowered.com");
    url.search = new URLSearchParams({ steamid: steamId, ...params }).toString();
    try {
      const response = await fetch(url, { headers: { "x-webapi-key": apiKey }, redirect: "error", signal: AbortSignal.timeout(20000) });
      if (!response.ok) throw new GameSyncError("STEAM_UNAVAILABLE");
      return object(object(await response.json()).response);
    } catch { throw new GameSyncError("STEAM_UNAVAILABLE"); }
  }
  const owned = await read("/IPlayerService/GetOwnedGames/v1/", { include_appinfo: "true", include_played_free_games: "true", include_free_sub: "true", skip_unvetted_apps: "false" });
  const recent = await read("/IPlayerService/GetRecentlyPlayedGames/v1/", { count: "0" });
  return steamRows(owned, recent, policyInput, account, new Date().toISOString());
}

import { createHash } from "node:crypto";

export type Provider = "Steam" | "PSN" | "Nintendo";
export type Visibility = "allowed" | "excluded" | "unknown";
export interface Observation {
  provider: Provider; account: string; platform: string; productId: string; name: string;
  minutes: number | null; precision: "Second" | "Minute" | "Approximate";
  firstPlayed: string | null; lastPlayed: string | null; sourceUpdated: string | null;
  syncedAt: string; visibility: Visibility; scope: "Library" | "Played" | "Trophies";
  ownership: string | null; trophySetId?: string; trophyProgress?: number;
  earnedTrophies?: number; totalTrophies?: number; platinumTrophies?: number;
  recentMinutes?: number | null; productType?: string; productUrl?: string;
  platformReleaseDate?: string | null;
}
export class GameSyncError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.code = code; }
}
export const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new GameSyncError("INVALID_RESPONSE");
  return value as Record<string, unknown>;
};
export const required = (value: unknown): string => {
  if (typeof value !== "string" || !value.trim() || value.length > 2000) throw new GameSyncError("INVALID_RESPONSE");
  return value;
};
export const amount = (value: unknown): number | null => {
  if (value == null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new GameSyncError("INVALID_RESPONSE");
  return value;
};
export const date = (value: unknown): string | null => {
  if (value == null || value === "") return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new GameSyncError("INVALID_RESPONSE");
  }
  return new Date(value).toISOString();
};
/** Years/months and missing durations cannot be interpreted as seconds. */
export function durationMinutes(value: unknown): number | null {
  if (value == null || value === "") return null;
  if (typeof value !== "string") throw new GameSyncError("INVALID_RESPONSE");
  const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(value);
  if (!match || !match.slice(1).some(x => x !== undefined)) throw new GameSyncError("INVALID_RESPONSE");
  return amount(Number(match[1] ?? 0) * 1440 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0) + Number(match[4] ?? 0) / 60);
}
export function syncKey(row: Pick<Observation, "provider" | "account" | "platform" | "productId">): string {
  return createHash("sha256").update(JSON.stringify([row.provider, row.account, row.platform, row.productId])).digest("hex");
}
export function unique(rows: Observation[]): Observation[] {
  const seen = new Set<string>();
  for (const row of rows) {
    const key = syncKey(row);
    if (seen.has(key)) throw new GameSyncError("DUPLICATE_PRODUCT");
    seen.add(key);
  }
  if (rows.length > 10000) throw new GameSyncError("LIMIT_EXCEEDED");
  return rows;
}
export function observations(input: unknown, provider?: Provider): Observation[] {
  if (!Array.isArray(input)) throw new GameSyncError("INVALID_SNAPSHOT");
  for (const value of input) {
    const row = object(value);
    if (!["Steam", "PSN", "Nintendo"].includes(required(row.provider)) || (provider && row.provider !== provider) ||
      !["Second", "Minute", "Approximate"].includes(required(row.precision)) ||
      !["allowed", "excluded", "unknown"].includes(required(row.visibility)) ||
      !["Library", "Played", "Trophies"].includes(required(row.scope))) throw new GameSyncError("INVALID_SNAPSHOT");
    for (const field of ["account", "platform", "productId", "name", "syncedAt"]) required(row[field]);
    if (row.minutes !== null && typeof row.minutes !== "number") throw new GameSyncError("INVALID_SNAPSHOT");
    amount(row.minutes); date(row.syncedAt);
    for (const field of ["firstPlayed", "lastPlayed", "sourceUpdated"]) {
      if (row[field] !== null && typeof row[field] !== "string") throw new GameSyncError("INVALID_SNAPSHOT");
      date(row[field]);
    }
    if (row.ownership !== null && typeof row.ownership !== "string") throw new GameSyncError("INVALID_SNAPSHOT");
    for (const field of ["recentMinutes", "trophyProgress", "earnedTrophies", "totalTrophies", "platinumTrophies"]) {
      if (row[field] !== undefined) amount(row[field]);
    }
    if (typeof row.trophyProgress === "number" && row.trophyProgress > 100) throw new GameSyncError("INVALID_SNAPSHOT");
    if (row.productUrl !== undefined && !/^https:\/\/store\.steampowered\.com\/app\/\d+\/?$/.test(required(row.productUrl))) {
      throw new GameSyncError("INVALID_SNAPSHOT");
    }
    if (row.platformReleaseDate && (typeof row.platformReleaseDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(row.platformReleaseDate))) {
      throw new GameSyncError("INVALID_SNAPSHOT");
    }
  }
  return unique(input as Observation[]);
}
export function nintendoRows(input: unknown, account: string, syncedAt: string): Observation[] {
  const data = object(input);
  if (!Array.isArray(data.playHistories) || !Array.isArray(data.hiddenTitleList) || data.nextCursor || data.nextToken) {
    throw new GameSyncError("SCOPE_INCOMPLETE");
  }
  const hidden = new Set(data.hiddenTitleList.map(value => required(typeof value === "string" ? value : object(value).titleId)));
  return unique(data.playHistories.map(value => {
    const row = object(value), productId = required(row.titleId);
    const code = required(row.platform ?? row.deviceType);
    const platforms: Record<string, string> = { HAC: "Nintendo Switch", BEE: "Nintendo Switch 2", CTR: "Nintendo 3DS", WUP: "Wii U" };
    return { provider: "Nintendo", account, platform: platforms[code] ?? code, productId,
      name: required(row.titleName), minutes: amount(row.totalPlayedMinutes), precision: "Minute",
      firstPlayed: date(row.firstPlayedAt), lastPlayed: date(row.lastPlayedAt),
      sourceUpdated: date(row.lastUpdatedAt ?? data.lastUpdatedAt), syncedAt,
      visibility: hidden.has(productId) ? "excluded" : Object.hasOwn(platforms, code) ? "allowed" : "unknown", scope: "Played", ownership: null };
  }));
}
export function psnRows(input: unknown[], account: string, syncedAt: string,
  trophies: Map<string, Record<string, unknown>[]>): Observation[] {
  return unique(input.map(value => {
    const row = object(value), productId = required(row.titleId), category = required(row.category);
    const platform = category === "ps5_native_game" ? "PS5" : category === "ps4_game" ? "PS4" : category;
    const sets = trophies.get(productId) ?? [];
    const hidden = sets.some(t => t.hiddenFlag === true);
    const known = sets.length > 0 && sets.every(t => t.hiddenFlag === false);
    const result: Observation = { provider: "PSN", account, platform, productId, name: required(row.name),
      minutes: durationMinutes(row.playDuration), precision: "Second", firstPlayed: date(row.firstPlayedDateTime),
      lastPlayed: date(row.lastPlayedDateTime), sourceUpdated: null, syncedAt,
      visibility: hidden ? "excluded" : known ? "allowed" : "unknown", scope: "Played",
      ownership: typeof row.service === "string" ? row.service : null };
    // Multiple trophy sets are ambiguous; never add them together or select one by title.
    if (sets.length === 1 && known) {
      const t = sets[0];
      result.trophySetId = required(t.npCommunicationId);
      const progress = amount(t.progress);
      if (progress !== null && progress <= 100) result.trophyProgress = progress;
      for (const [source, target] of [["earnedTrophies", "earnedTrophies"], ["definedTrophies", "totalTrophies"]] as const) {
        if (t[source]) {
          const counts = object(t[source]);
          const values = ["bronze", "silver", "gold", "platinum"].map(k => amount(counts[k]));
          if (values.every(v => v !== null)) result[target] = (values as number[]).reduce((a, b) => a + b, 0);
          if (source === "earnedTrophies" && counts.platinum != null) result.platinumTrophies = amount(counts.platinum)!;
        }
      }
    }
    return result;
  }));
}

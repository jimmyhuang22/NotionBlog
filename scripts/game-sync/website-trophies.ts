import { createHash } from "node:crypto";
import type { GameTrophySetSummary, TrophyCount, TrophyGrade } from "../../contracts/content.ts";
import { callSql, type SqlExecutor } from "../../src/server/database/sql.ts";
import { date, GameSyncError, object, required, type Observation } from "./model.ts";
import { normalizedId } from "./plan.ts";

const grades = ["platinum", "gold", "silver", "bronze"] as const;
const setKey = /^psn:[0-9a-f]{32}$/;
type Counts = Record<TrophyGrade, TrophyCount>;
type Platform = "PS4" | "PS5" | "PS4 / PS5";
interface PsnProduct {
  key: string;
  allowed: boolean;
  sets: { id: string; platform: Platform; progressPercent: number | null; grades: Counts | null }[];
}
type PublishedSet = GameTrophySetSummary & { gameId: string; grades: Counts };

function isPlatform(value: unknown): value is Platform {
  return value === "PS4" || value === "PS5" || value === "PS4 / PS5";
}

function count(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 10000;
}

function gradeCounts(read: (grade: TrophyGrade) => { earned: unknown; total: unknown }): Counts | null {
  const result = {} as Counts;
  let total = 0;
  for (const grade of grades) {
    const c = read(grade);
    if (!count(c.earned) || !count(c.total) || c.earned > c.total) return null;
    result[grade] = { earned: c.earned, total: c.total };
    total += c.total;
  }
  return total > 0 && total <= 10000 ? result : null;
}

export function psnTrophyOwner(onlineId: string) {
  return createHash("sha256").update(required(onlineId).toLowerCase()).digest("hex");
}

/** Use the same complete, verified PSN collection and product visibility as the playtime collector. */
export function psnWebsiteTrophySnapshot(owner: string, observedAt: string, rows: Observation[],
  byProduct: ReadonlyMap<string, Record<string, unknown>[]>) {
  const products: PsnProduct[] = [];
  for (const row of rows) {
    if (row.provider !== "PSN" || (row.platform !== "PS4" && row.platform !== "PS5")) continue;
    const platform = row.platform;
    const allowed = row.visibility === "allowed";
    const sets = (byProduct.get(row.productId) ?? []).map(set => {
      const sourceId = required(set.npCommunicationId);
      const id = "psn:" + createHash("sha256").update(sourceId).digest("hex").slice(0, 32);
      const labels = typeof set.trophyTitlePlatform === "string" ? set.trophyTitlePlatform.split(",").map(v => v.trim()) : [];
      const label: Platform = labels.includes("PS4") && labels.includes("PS5") ? "PS4 / PS5"
        : labels.includes("PS4") ? "PS4" : labels.includes("PS5") ? "PS5" : platform;
      const earned = allowed && set.earnedTrophies != null ? object(set.earnedTrophies) : {};
      const defined = allowed && set.definedTrophies != null ? object(set.definedTrophies) : {};
      return { id, platform: label,
        progressPercent: allowed && count(set.progress) && set.progress <= 100 ? set.progress : null,
        grades: gradeCounts(grade => ({ earned: earned[grade], total: defined[grade] })) };
    });
    products.push({ key: `PSN:${platform}:${row.productId}`, allowed, sets });
  }
  return { version: 1, owner: psnTrophyOwner(owner), observedAt, products };
}

/** Re-apply current explicit bindings and exclusions at write time. Never infer a match from a title. */
export function planPsnWebsiteTrophies(input: unknown, onlineId: string, config: unknown, now = Date.now()) {
  const snapshot = object(input), policy = object(config), bindings = object(policy.bindings);
  const observedAt = date(snapshot.observedAt);
  if (snapshot.version !== 1 || snapshot.owner !== psnTrophyOwner(onlineId) || !observedAt ||
      Date.parse(observedAt) < now - 3600000 || Date.parse(observedAt) > now + 60000 ||
      !Array.isArray(snapshot.products) || snapshot.products.length > 10000)
    throw new GameSyncError("INVALID_TROPHY_SNAPSHOT");
  if (!Array.isArray(policy.excluded) || policy.excluded.some(value => typeof value !== "string"))
    throw new GameSyncError("PRIVATE_CONFIG_INVALID");
  const excluded = new Set(policy.excluded), products = new Set<string>(), blocked = new Set<string>();
  const sets = new Map<string, PublishedSet>();
  for (const raw of snapshot.products) {
    const product = object(raw), key = required(product.key);
    if (!/^PSN:PS[45]:[^:]+$/.test(key) || products.has(key) || typeof product.allowed !== "boolean" ||
        !Array.isArray(product.sets) || product.sets.length > 10000) throw new GameSyncError("INVALID_TROPHY_SNAPSHOT");
    products.add(key);
    const bound = Object.hasOwn(bindings, key) ? normalizedId(required(bindings[key])) : undefined;
    if (bound !== undefined && !/^[0-9a-f]{32}$/.test(bound)) throw new GameSyncError("PRIVATE_CONFIG_INVALID");
    for (const rawSet of product.sets) {
      const set = object(rawSet), id = required(set.id);
      if (!setKey.test(id) || !isPlatform(set.platform) ||
          (set.progressPercent !== null && (!count(set.progressPercent) || set.progressPercent > 100)))
        throw new GameSyncError("INVALID_TROPHY_SNAPSHOT");
      if (!product.allowed || excluded.has(key)) {
        blocked.add(id);
        continue;
      }
      if (!bound || set.grades === null) continue;
      const source = object(set.grades);
      const counts = gradeCounts(grade => {
        const value = object(source[grade]);
        return { earned: value.earned, total: value.total };
      });
      if (!counts) throw new GameSyncError("INVALID_TROPHY_SNAPSHOT");
      const earned = grades.reduce((sum, grade) => sum + counts[grade].earned, 0);
      const total = grades.reduce((sum, grade) => sum + counts[grade].total, 0);
      const previous = sets.get(id);
      if (previous && (previous.gameId !== bound || previous.progressPercent !== set.progressPercent ||
          JSON.stringify(previous.grades) !== JSON.stringify(counts))) {
        blocked.add(id);
        continue;
      }
      const platform = previous && previous.platform !== set.platform ? "PS4 / PS5" : set.platform;
      sets.set(id, { id, gameId: bound, platform, progressPercent: set.progressPercent, earned, total, grades: counts });
    }
  }
  return { observedAt, sets: [...sets.values()].filter(set => !blocked.has(set.id)) };
}

export function writePsnWebsiteTrophies(db: SqlExecutor, plan: ReturnType<typeof planPsnWebsiteTrophies>) {
  return callSql<boolean>(db, "SELECT nb_game_trophies_api.replace_psn_snapshot($1,$2::jsonb) AS result",
    [plan.observedAt, JSON.stringify(plan.sets)]);
}

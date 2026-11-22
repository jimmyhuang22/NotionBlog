import type { GameTrophySetSummary, TrophyGrade } from "../../contracts/content.ts";
import { platformPlayDay } from "../../src/lib/content/game-date.ts";
import { sanitizePublicText } from "../../src/server/notion/public-text.ts";
import { callSql, type SqlExecutor } from "../../src/server/database/sql.ts";
import { GameSyncError, object } from "./model.ts";
import { planPsnWebsiteTrophies } from "./website-trophies.ts";
import { createTrophyIconCollector, type CollectedTrophyIcon } from "./trophy-icons.ts";

const maxSetTrophies = 10000;
export const maxTrophySnapshotBytes = 96 * 1024 * 1024;
const grades = ["platinum", "gold", "silver", "bronze"] as const;
const iconHosts = new Set(["image.api.playstation.com", "psnobj.prod.dl.playstation.net"]);

interface Definition {
  trophyId: number;
  trophyType: string;
  trophyHidden: boolean;
  trophyName?: string;
  trophyDetail?: string;
  trophyIconUrl?: string;
}
interface Earning {
  trophyId: number;
  trophyType: string;
  trophyHidden?: boolean;
  earned?: boolean;
  earnedDateTime?: string;
  trophyEarnedRate?: string;
}
interface TrophyPage<T> {
  trophySetVersion: string;
  totalItemCount: number;
  nextOffset?: number;
  trophies: T[];
}

/** Get every DLC group through the all-groups endpoint. Require one stable edition. */
export async function readPsnTrophyPages<T extends { trophyId: number }>(
  read: (offset: number, limit: number) => Promise<TrophyPage<T>>,
) {
  const trophies = new Map<number, T>();
  let size: number | undefined, version: string | undefined, offset = 0;
  for (let page = 0; page < 100; page++) {
    const response = await read(offset, 100);
    size ??= response.totalItemCount;
    version ??= response.trophySetVersion;
    if (!version || version !== response.trophySetVersion || response.totalItemCount !== size ||
        !Number.isInteger(size) || size < 1 || size > maxSetTrophies || !Array.isArray(response.trophies) ||
        !response.trophies.length) throw new GameSyncError("PSN_TROPHY_DETAILS_INCOMPLETE");
    for (const trophy of response.trophies) {
      if (!Number.isInteger(trophy.trophyId) || trophy.trophyId < 0 || trophy.trophyId > maxSetTrophies ||
          trophies.has(trophy.trophyId)) throw new GameSyncError("PSN_TROPHY_DETAILS_INCOMPLETE");
      trophies.set(trophy.trophyId, trophy);
    }
    if (trophies.size === size && response.nextOffset === undefined) return { version, trophies };
    if (trophies.size >= size || response.nextOffset !== trophies.size)
      throw new GameSyncError("PSN_TROPHY_DETAILS_INCOMPLETE");
    offset = response.nextOffset;
  }
  throw new GameSyncError("PSN_TROPHY_DETAILS_INCOMPLETE");
}

function publicText(value: string | undefined, limit: number): string | null {
  return typeof value === "string" ? sanitizePublicText(value.trim()).slice(0, limit) || null : null;
}

function rarity(value: string | undefined): number | null {
  if (typeof value !== "string" || !/^\d{1,3}(\.\d+)?$/.test(value)) return null;
  const percent = Number(value);
  return percent <= 100 ? Math.round(percent * 10) / 10 : null;
}

export async function projectPsnTrophyList(set: GameTrophySetSummary,
  definitions: { version: string; trophies: ReadonlyMap<number, Definition> },
  earnings: { version: string; trophies: ReadonlyMap<number, Earning> }, timeZone: string,
  readIcon: (url: string, trophyId: number) => Promise<CollectedTrophyIcon | null>,
) {
  if (definitions.version !== earnings.version || definitions.trophies.size !== set.total || earnings.trophies.size !== set.total)
    throw new GameSyncError("PSN_TROPHY_DETAILS_INCOMPLETE");
  const rows = [...definitions.trophies].map(([id, definition]) => {
    const state = earnings.trophies.get(id), grade = definition.trophyType as TrophyGrade;
    if (!state || !grades.includes(grade) || state.trophyType !== grade || typeof definition.trophyHidden !== "boolean" ||
        (state.earned !== undefined && typeof state.earned !== "boolean")) throw new GameSyncError("PSN_TROPHY_DETAILS_INCOMPLETE");
    // The SDK permits omitted flags. The per-grade verification below must still match the earned summary.
    const earned = state.earned === true, hidden = definition.trophyHidden || state.trophyHidden === true;
    const redact = hidden && !earned;
    const earnedDate = earned && typeof state.earnedDateTime === "string"
      ? platformPlayDay({ start: state.earnedDateTime, end: null, precision: "datetime" }, timeZone)?.start ?? null : null;
    return { id, grade, earned, hidden, earnedDate, rarityPercent: rarity(state.trophyEarnedRate),
      name: redact ? null : publicText(definition.trophyName, 500), detail: redact ? null : publicText(definition.trophyDetail, 2000),
      iconUrl: redact ? undefined : definition.trophyIconUrl };
  });
  for (const grade of grades) {
    const matches = rows.filter(row => row.grade === grade);
    if (matches.length !== set.grades?.[grade].total || matches.filter(row => row.earned).length !== set.grades[grade].earned)
      throw new GameSyncError("PSN_TROPHY_DETAILS_INCOMPLETE");
  }
  const result = [];
  for (const { iconUrl, ...row } of rows) {
    result.push({ ...row, icon: typeof iconUrl === "string" ? await readIcon(iconUrl, row.id) : null });
  }
  return result;
}

export function createPsnTrophyIconCollector() {
  return createTrophyIconCollector("psn", 64 * 1024 * 1024, "PSN_TROPHY_ICON_BUDGET", url => iconHosts.has(url.hostname));
}

export function planPsnTrophyDetails(input: unknown, onlineId: string, config: unknown) {
  const data = object(input), details = object(data.details);
  const plan = planPsnWebsiteTrophies(data.summary, onlineId, config);
  return { observedAt: plan.observedAt, sets: plan.sets.map(set => {
    const trophies = Object.hasOwn(details, set.id) ? details[set.id] : undefined;
    if (trophies === undefined) return set;
    if (!Array.isArray(trophies) || trophies.length !== set.total) throw new GameSyncError("PSN_TROPHY_DETAILS_INCOMPLETE");
    return { ...set, trophies };
  }) };
}

export function writePsnTrophyDetails(db: SqlExecutor, plan: ReturnType<typeof planPsnTrophyDetails>) {
  return callSql<boolean>(db, "SELECT nb_game_trophies_api.replace_psn_details($1,$2::jsonb) AS result",
    [plan.observedAt, JSON.stringify(plan.sets)]);
}

import type { ImageAsset } from "../../contracts/content.ts";
import { gamePlatformIcon, platformChip, type GamePlatformIcon, type PlatformTone } from "./library.ts";

/**
 * A game's trophies on its detail page (decision 2026-11-20-game-trophies, layout 乙).
 *
 * The backend is adding per-set statistics to the detail response as `trophySets` (handoff section 16, step one);
 * the per-trophy list is step two and has no shape yet. The names here follow the step-one proposal, and the
 * page reads the field defensively: a response without it, or with a set it cannot read, shows no trophies at
 * all rather than a guess. Nothing is invented for a missing value: no zero for an unknown count, no rate for an
 * unknown rarity, no day for an unknown date.
 */
export type TrophyGrade = "platinum" | "gold" | "silver" | "bronze";
export interface TrophyCount { earned: number; total: number }
export interface Trophy {
  id: string;
  /** Null for a hidden trophy not yet earned: the platform keeps its name, description and icon back. */
  name: string | null;
  detail: string | null;
  /** Steam achievements have no grade. */
  grade: TrophyGrade | null;
  icon: ImageAsset | null;
  earned: boolean;
  /** Day only, in the site's zone (`YYYY-MM-DD`); never a time of day. */
  earnedDate: string | null;
  /** Share of all players who have it, as the platform reports it. */
  rarityPercent: number | null;
  hidden: boolean;
}
export interface TrophySet extends TrophyCount {
  id: string;
  platform: string;
  progressPercent: number | null;
  grades?: Record<TrophyGrade, TrophyCount>;
  /** Step two. Absent until the backend sends the full list; the page then shows only the side summary. */
  trophies?: Trophy[];
}

export const gradeOrder: TrophyGrade[] = ["platinum", "gold", "silver", "bronze"];
export const gradeLabel: Record<TrophyGrade, string> = { platinum: "白金", gold: "金", silver: "银", bronze: "铜" };

const record = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const count = (value: unknown): number | null => typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
const text = (value: unknown): string | null => typeof value === "string" && value.trim() ? value : null;
const percent = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;

function readCount(value: unknown): TrophyCount | null {
  const row = record(value);
  const earned = count(row?.earned), total = count(row?.total);
  return earned !== null && total !== null && earned <= total ? { earned, total } : null;
}

function readIcon(value: unknown): ImageAsset | null {
  const row = record(value);
  const src = text(row?.src);
  // Site media only: the page never loads a platform's own image server (CSP is `img-src 'self'`).
  if (!row || !src || !/^\/(?!\/)/u.test(src)) return null;
  return { id: text(row.id) ?? src, src, alt: typeof row.alt === "string" ? row.alt : "", width: count(row.width), height: count(row.height) };
}

function readTrophy(value: unknown): Trophy | null {
  const row = record(value);
  const id = text(row?.id);
  if (!row || !id || typeof row.earned !== "boolean") return null;
  const grade = gradeOrder.includes(row.grade as TrophyGrade) ? row.grade as TrophyGrade : null;
  const earnedDate = typeof row.earnedDate === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(row.earnedDate) ? row.earnedDate : null;
  const hidden = row.hidden === true;
  // A hidden trophy not yet earned shows nothing of itself, whatever the response carries.
  const veiled = hidden && !row.earned;
  return { id, name: veiled ? null : text(row.name), detail: veiled ? null : text(row.detail), grade, icon: veiled ? null : readIcon(row.icon),
    earned: row.earned, earnedDate: row.earned ? earnedDate : null, rarityPercent: percent(row.rarityPercent), hidden };
}

function readSet(value: unknown): TrophySet | null {
  const row = record(value);
  const id = text(row?.id), platform = text(row?.platform), totals = readCount(row);
  if (!row || !id || !platform || !totals || totals.total === 0) return null;
  const set: TrophySet = { id, platform, ...totals, progressPercent: percent(row.progressPercent) };
  const grades = record(row.grades);
  if (grades) {
    const read = Object.fromEntries(gradeOrder.map(grade => [grade, readCount(grades[grade])]));
    if (gradeOrder.every(grade => read[grade])) set.grades = read as Record<TrophyGrade, TrophyCount>;
  }
  if (Array.isArray(row.trophies)) {
    const trophies = row.trophies.map(readTrophy);
    // A list with an unreadable row is not shown in part: the counts beside it would no longer match.
    if (trophies.length && trophies.every(Boolean)) set.trophies = trophies as Trophy[];
  }
  return set;
}

/** The trophy sets on a detail response, or none. Every set is shown on its own, never summed (2026-11-20). */
export function trophySetsOf(detail: unknown): TrophySet[] {
  const sets = record(detail)?.trophySets;
  if (!Array.isArray(sets)) return [];
  return sets.map(readSet).filter((set): set is TrophySet => set !== null);
}

/** The share shown beside a set: the platform's own figure when it gives one (PSN weights it by grade), else earned of total. */
export function setPercent(set: TrophySet): number {
  return set.progressPercent ?? Math.round(set.earned / set.total * 100);
}

/** Rarity words on the three cards (round two, 2026-11-20). */
export function rarityTier(rate: number): string {
  if (rate <= 5) return "极稀有";
  if (rate <= 10) return "很稀有";
  if (rate <= 20) return "稀有";
  if (rate <= 50) return "少见";
  return "常见";
}

/**
 * A platform as a coloured box beside its set, in the same tones as the game's own platform boxes (`platformChip`).
 * Trophy sets name the console ("PS5") or the store ("Steam"), which a game's own platforms never do.
 */
export function trophyPlatformTone(platform: string): PlatformTone {
  const name = platform.trim();
  return platformChip(/^ps\d/iu.test(name) ? "PlayStation" : /^steam$/iu.test(name) ? "PC" : name).tone;
}

/** The earned platinum, which leads the section as its own banner when there is one. */
export function earnedPlatinum(trophies: Trophy[]): Trophy | null {
  return trophies.find(trophy => trophy.grade === "platinum" && trophy.earned) ?? null;
}

const byDayDesc = (a: Trophy, b: Trophy) => (b.earnedDate ?? "").localeCompare(a.earnedDate ?? "") || (a.rarityPercent ?? 101) - (b.rarityPercent ?? 101);

/**
 * The hardest earned trophies first, at most three, and only those earned by at most a fifth of players (the "稀有"
 * tier and rarer, 甲 of 2026-11-23): a card for a trophy most players have says nothing. A trophy without a known
 * rarity cannot be ranked, so it is left out.
 */
export function rarestEarned(trophies: Trophy[], limit = 3, ceiling = 20): Trophy[] {
  return trophies.filter(trophy => trophy.earned && trophy.rarityPercent !== null && trophy.rarityPercent <= ceiling).sort((a, b) => a.rarityPercent! - b.rarityPercent! || a.id.localeCompare(b.id)).slice(0, limit);
}

/** Earned trophies, newest first; those without a day go last. */
export function recentEarned(trophies: Trophy[]): Trophy[] {
  return trophies.filter(trophy => trophy.earned).sort(byDayDesc);
}

/** The full earned list in months, newest first, with an undated group at the end. */
export function earnedByMonth(trophies: Trophy[]): { key: string; label: string; trophies: Trophy[] }[] {
  const groups = new Map<string, Trophy[]>();
  for (const trophy of recentEarned(trophies)) {
    const key = trophy.earnedDate?.slice(0, 7) ?? "undated";
    const group = groups.get(key);
    if (group) group.push(trophy);
    else groups.set(key, [trophy]);
  }
  return [...groups].map(([key, list]) => ({ key, trophies: list,
    label: key === "undated" ? "日期未记录" : `${Number(key.slice(0, 4))} 年 ${Number(key.slice(5, 7))} 月` }));
}

/**
 * When the trophies came, in one line under the heading (甲, 2026-11-22; it replaces round three's month bars, which
 * real sets, mostly earned within a month or two, left as one or two bars): the first day and the day the platinum
 * came, counted from the first, both ends included ("第 12 天", as the date strip counts "共 12 天"); without a
 * platinum, from the first day to the last and how many in between. Only dated trophies count; null when none is.
 */
export function trophySpan(trophies: Trophy[]): { parts: { text: string; strong?: true }[]; platinum: boolean } | null {
  const dated = trophies.filter(trophy => trophy.earned && trophy.earnedDate).map(trophy => trophy.earnedDate!).sort();
  if (!dated.length) return null;
  const first = dated[0]!, last = dated[dated.length - 1]!;
  const platinum = earnedPlatinum(trophies)?.earnedDate ?? null;
  const dayCount = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
  if (platinum) {
    const days = dayCount(first, platinum);
    return { platinum: true, parts: days <= 1 ? [{ text: `${trophyDay(first)}拿到第一个，` }, { text: "当天", strong: true }, { text: "拿到白金" }] : [{ text: `${trophyDay(first)}拿到第一个，` }, { text: `第 ${days} 天`, strong: true }, { text: "拿到白金" }] };
  }
  if (first === last) return { platinum: false, parts: [{ text: `${trophyDay(first)}拿到 ${dated.length} 个` }] };
  return { platinum: false, parts: [{ text: `${trophyDay(first)}到 ${trophyDay(last, last.slice(0, 4) !== first.slice(0, 4))}拿到 ${dated.length} 个` }] };
}

/**
 * How many dated trophies were earned, when every one of them falls within the days given (both ends included,
 * `YYYY-MM-DD`): the date strip then says it under the owner's own dates (甲, 2026-11-23) instead of the trophy
 * section repeating the same days. Null when none is dated or any falls outside.
 */
export function earnedWithin(trophies: Trophy[], start: string, end: string): number | null {
  const days = trophies.filter(trophy => trophy.earned && trophy.earnedDate).map(trophy => trophy.earnedDate!);
  return days.length && days.every(day => day >= start && day <= end) ? days.length : null;
}

/** A set whose platinum is earned, by its grade counts or, without them, by its list. */
export function setPlatinum(set: TrophySet): boolean {
  return (set.grades?.platinum.earned ?? 0) > 0 || !!(set.trophies && earnedPlatinum(set.trophies));
}

/** A trophy set's platform outline, as the home timeline draws platforms: every PlayStation console is PlayStation's. */
export function trophyPlatformIcon(platform: string): GamePlatformIcon | null {
  const name = platform.trim();
  return /^ps\d/iu.test(name) ? "playstation" : gamePlatformIcon(platformChip(name).label);
}

/** Not yet earned: by grade (platinum first), then the most common first, as the nearest to get. */
export function missingTrophies(trophies: Trophy[]): Trophy[] {
  const rank = (trophy: Trophy) => trophy.grade ? gradeOrder.indexOf(trophy.grade) : gradeOrder.length;
  return trophies.filter(trophy => !trophy.earned).sort((a, b) => rank(a) - rank(b) || (b.rarityPercent ?? -1) - (a.rarityPercent ?? -1) || a.id.localeCompare(b.id));
}

/** `2025-11-25` as "2025 年 11 月 25 日", or without the year inside a month group. */
export function trophyDay(day: string, withYear = true): string {
  const [year, month, date] = day.split("-").map(Number);
  return withYear ? `${year} 年 ${month} 月 ${date} 日` : `${month} 月 ${date} 日`;
}

import type { DateRange } from "../../contracts/content.ts";
import { dateParts } from "./format.ts";

type Dated = { playedDate: DateRange | null; lastPlayedDate?: DateRange | null; firstPlayedDate?: DateRange | null };

/**
 * The date rows of a game's page. What the platforms report comes first, each on its own line and
 * only when there is one: the latest play, then the first (some platforms never tell it). The date
 * the owner wrote follows when there is one; beside platform dates a missing one is left out rather
 * than shown as "not recorded" (the owner's choice, 2026-10-16). A game the platforms have nothing on
 * keeps that one date under the name it always had, recorded or not. Platform dates are shown to the
 * day only.
 */
export function gameDateRows(game: Dated, timeZone: string): [label: string, value: DateRange | null][] {
  const lastPlayed = game.lastPlayedDate ? platformDay(game.lastPlayedDate, timeZone) : null;
  const firstPlayed = game.firstPlayedDate ? platformDay(game.firstPlayedDate, timeZone) : null;
  const platform: [string, DateRange][] = [...(lastPlayed ? [["最近游玩", lastPlayed] as [string, DateRange]] : []), ...(firstPlayed ? [["首次游玩", firstPlayed] as [string, DateRange]] : [])];
  if (!platform.length) return [["游玩日期", game.playedDate]];
  return game.playedDate ? [...platform, ["体验日期", game.playedDate]] : platform;
}

/**
 * A date read from the platforms, to the day in the site's time zone. The time of day is dropped
 * here whatever the data carries: shown beside a date that moves every time a game is opened, it
 * would tell when the owner plays. A value that cannot be read is no date.
 */
export function platformDay(range: DateRange, timeZone: string): DateRange | null {
  const day = (value: string) => {
    const parts = dateParts(value, range.precision, timeZone);
    return parts ? `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}` : null;
  };
  const start = day(range.start);
  if (!start) return null;
  const end = range.end ? day(range.end) : null;
  return { start, end: end === start ? null : end, precision: "date" };
}

/** A calendar day as a count of days, read in the site's time zone; null when the value cannot be read. */
function dayNumber(value: string, precision: DateRange["precision"], timeZone: string): number | null {
  const parts = dateParts(value, precision, timeZone);
  return parts ? Date.UTC(parts.year, parts.month - 1, parts.day) / 86_400_000 : null;
}

/** A stretch of days in words: days under two months, months under two years, then years to one decimal. */
export function spanLabel(days: number): string {
  if (days < 60) return `${days} 天`;
  if (days < 730) return `${Math.round(days / 30.44)} 个月`;
  return `${(days / 365.25).toFixed(1).replace(/\.0$/u, "")} 年`;
}

/**
 * What the strip of a game's dates says beside each date, worked out from the dates alone (the owner's pick 乙 of
 * 2026-11-21): how many days a range covers, counting both ends ("共 46 天"), and how long it was from this date (a
 * range's end) to the next one ("9 天后", "同一天"). A date that cannot be read, or a next one that starts before
 * this one ends, gets no gap: nothing is guessed.
 */
export function dateStripNotes(ranges: (DateRange | null)[], timeZone: string): { length: string | null; gap: string | null }[] {
  const days = ranges.map(range => {
    const start = range ? dayNumber(range.start, range.precision, timeZone) : null;
    const end = range?.end ? dayNumber(range.end, range.precision, timeZone) : null;
    return start === null ? null : { start, end: end !== null && end > start ? end : null };
  });
  return days.map((here, index) => {
    const next = days[index + 1];
    const length = here?.end ? `共 ${here.end - here.start + 1} 天` : null;
    if (!here || !next) return { length, gap: null };
    const gap = next.start - (here.end ?? here.start);
    return { length, gap: gap < 0 ? null : gap === 0 ? "同一天" : `${spanLabel(gap)}后` };
  });
}

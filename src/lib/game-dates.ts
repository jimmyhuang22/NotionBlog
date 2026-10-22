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

import type { DateRange, Game } from "../../../contracts/content.ts";
import { dateParts } from "../format.ts";

function day(value: string, precision: DateRange["precision"], timeZone: string): string | null {
  const calendar = value.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(calendar)) return null;
  const midnight = new Date(`${calendar}T00:00:00.000Z`);
  if (!Number.isFinite(midnight.getTime()) || midnight.toISOString().slice(0, 10) !== calendar) return null;
  if (precision === "date" && value !== calendar) return null;
  if (precision === "datetime" && !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,9})?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value)) return null;
  const parts = dateParts(value, precision, timeZone);
  return parts ? `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}` : null;
}

/** Drop platform times at the public boundary, including already-stored legacy datetimes. */
export function platformPlayDay(range: DateRange | null | undefined, timeZone: string): DateRange | null {
  const start = range ? day(range.start, range.precision, timeZone) : null;
  return start ? { start, end: null, precision: "date" } : null;
}

function resolvedArchiveDate(game: Game, timeZone: string): DateRange | null {
  const manual = game.playedDate ? day(game.playedDate.end ?? game.playedDate.start, game.playedDate.precision, timeZone) : null;
  const platform = platformPlayDay(game.lastPlayedDate, timeZone)?.start ?? null;
  const start = manual && platform ? manual > platform ? manual : platform : manual ?? platform;
  return start ? { start, end: null, precision: "date" } : null;
}

/** Use the server's resolved day in clients; derive it for legacy/unprojected inputs. */
export function gameBrowsingDate(game: Game, timeZone = "UTC"): DateRange | null {
  return game.archiveDate !== undefined ? game.archiveDate : resolvedArchiveDate(game, timeZone);
}

/** Recompute derived data in the reader's zone; never trust a stale stored archiveDate. */
export function projectGameDates(game: Game, timeZone: string): Game {
  return { ...game, lastPlayedDate: platformPlayDay(game.lastPlayedDate, timeZone),
    firstPlayedDate: platformPlayDay(game.firstPlayedDate, timeZone), archiveDate: resolvedArchiveDate(game, timeZone) };
}

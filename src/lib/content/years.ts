import type { AnyContent, ContentKind, LibraryKind, LibraryYears } from "../../../contracts/content.ts";
import { dateParts } from "../format.ts";
import { gameBrowsingDate } from "./game-date.ts";

export function isLibraryKind(kind: string): kind is LibraryKind {
  return kind === "movie" || kind === "book" || kind === "game";
}
export function supportsYear(kind: ContentKind): boolean {
  return kind === "status" || isLibraryKind(kind);
}
/** Never substitute release, edit, account-sync or completion dates. */
export function contentYear(item: AnyContent, timeZone: string): number | null {
  const date = item.kind === "status" ? item.recordedAt
    : item.kind === "movie" ? item.watchedDate
    : item.kind === "book" ? item.readingDate
    : item.kind === "game" ? gameBrowsingDate(item, timeZone) : null;
  return date ? dateParts(date.start, date.precision, timeZone)?.year ?? null : null;
}
export function libraryYears(items: AnyContent[], timeZone: string): LibraryYears {
  const counts = new Map<number, number>();
  let undatedCount = 0;
  for (const item of items) {
    const year = contentYear(item, timeZone);
    if (year === null) undatedCount++;
    else counts.set(year, (counts.get(year) ?? 0) + 1);
  }
  return { years: [...counts].sort(([a], [b]) => b - a).map(([year, count]) => ({ year, count })), undatedCount, timeZone };
}

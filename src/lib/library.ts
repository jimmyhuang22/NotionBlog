import type { Book, DateRange, Game, Movie, Rating, TimeAmount } from "../../contracts/content.ts";
import { ratingLabel } from "./format.ts";
import type { YearChoice } from "./year-filter.ts";
import { gameBrowsingDate } from "./content/game-date.ts";
import { isMoviePublicRating } from "./content/movie-rating.ts";

export type LibraryItem = Book | Movie | Game;
export type LibraryKind = LibraryItem["kind"];

export interface LibrarySection {
  kind: LibraryKind;
  label: string;
  unit: string;
  /** Status filter value → tab label. Values must be ones the list endpoint accepts. */
  tabs: [string, string][];
  /** The status a section opens on; there is no "all" (the owner's choice, 2026-10-17). */
  defaultStatus: string;
}

/** URL segment → section. The segment is part of DTO.href, so it is not derived from the kind. */
export const librarySections: Record<string, LibrarySection> = {
  movies: { kind: "movie", label: "影视", unit: "部", tabs: [["watched", "看过"], ["wishlist", "想看"]], defaultStatus: "watched" },
  books: { kind: "book", label: "书籍", unit: "本", tabs: [["reading", "在读"], ["read", "已读"], ["wishlist", "想读"], ["given-up", "弃读"]], defaultStatus: "read" },
  games: { kind: "game", label: "游戏", unit: "款", tabs: [["playing", "在玩"], ["completed", "通关"], ["wishlist", "想玩"]], defaultStatus: "completed" },
};

export type LibraryOrder = "date-asc";

/** Order value → label; null is the list's own default, newest first. Values must be ones the list endpoint accepts. */
/** Newest or oldest first (F34): ordering by title was dropped, and an old address asking for it opens on the default. */
export const libraryOrders: [LibraryOrder | null, string][] = [[null, "最近"], ["date-asc", "最早"]];

/**
 * A list address that keeps every choice, so changing one does not reset the others. The section's
 * default status is left out, so each status has one address and the plain section address opens on it.
 */
export function libraryHref(type: string, status: string | null, order: LibraryOrder | null, year: YearChoice = null): string {
  const shown = status === librarySections[type]?.defaultStatus ? null : status;
  const params = new URLSearchParams({ ...(shown ? { status: shown } : {}), ...(year === null ? {} : { year: String(year) }), ...(order ? { order } : {}) });
  return params.size ? `/library/${type}?${params}` : `/library/${type}`;
}

const statusLabels: Record<string, string> = {
  watched: "看过", wishlist: "想看", reading: "在读", read: "已读", "given-up": "弃读",
  playing: "在玩", clear: "通关", platinumed: "白金", unknown: "状态未记录",
};

export function statusLabel(item: LibraryItem): string {
  if (item.status === "wishlist") return item.kind === "book" ? "想读" : item.kind === "game" ? "想玩" : "想看";
  return statusLabels[item.status] ?? "状态未记录";
}

/** The status for a card: only a known one. An unknown status is said on the detail page, not on every card. */
export function knownStatusLabel(item: LibraryItem): string | null {
  return item.status in statusLabels && item.status !== "unknown" ? statusLabel(item) : null;
}

/**
 * A film or book is said in one sentence, its date and status together; a wish has no date, and a missing
 * date or status is written out rather than left out. A game's several platform dates stay in the line below.
 */
export function workSentence(item: LibraryItem, when: string | null | undefined): string {
  const status = statusLabel(item);
  if (item.status === "wishlist" || when === undefined) return status;
  if (!knownStatusLabel(item)) return when ? `${when}，状态未记录` : "状态未记录，日期未记录";
  return when ? `${when}${status}` : `${status}，日期未记录`;
}

/** The rest of the record as words of a line: a director "凌子风 导演", a release "1982 年 8 月 18 日上映". */
const factWords: Record<string, (value: string) => string> = {
  类型: value => value, 页数: value => value, 导演: value => `${value} 导演`, 作者: value => `${value} 著`,
  上映: value => `${value}上映`, 发售: value => `${value}发售`, 豆瓣评分: value => `豆瓣 ${value}`,
  已玩时长: value => `玩了 ${value}`, 预计时长: value => `预计 ${value}`,
};

export function workFactText(label: string, value: string, kind?: LibraryKind): string {
  if (kind === "movie" && label === "豆瓣评分") return `${label} ${value}`;
  return (factWords[label] ?? (text => `${label} ${text}`))(value);
}

/** A legacy field name is not evidence of where its public score came from. */
export function movieRatingFact(item: Pick<Movie, "publicRating" | "ratingSource" | "doubanRating">): [string, string] | null {
  const value = item.publicRating === undefined ? item.doubanRating : item.publicRating;
  if (value === null || !isMoviePublicRating(value)) return null;
  const label = item.ratingSource === "douban" ? "豆瓣评分" : item.ratingSource === "bangumi" ? "Bangumi 评分" : item.ratingSource === "1905" ? "1905电影网评分" : "公共评分";
  return [label, String(value)];
}

/** Use the same date as the list's sorting and year filter. */
export function itemDate(item: LibraryItem): DateRange | null {
  return item.kind === "movie" ? item.watchedDate : item.kind === "book" ? item.readingDate : gameBrowsingDate(item);
}

/**
 * What a list card says under its title. A film or show says only its rating, "未评分" when it has none,
 * so every card in a row is two lines high (the owner's choice, 2026-10-17); its kind, when not a film,
 * is a badge on the cover instead (`coverBadge`). Books keep their summary line; games have their own
 * line (`gameCard`).
 */
export function cardParts(item: Book | Movie): string[] {
  if (item.kind === "movie") return [ratingLabel(item.rating, "未评分")];
  return bookParts(item);
}

/** What is laid on a cover: a film or show's kind when it is not simply a film, a game's platinum. */
export function coverBadge(item: LibraryItem): string | null {
  if (item.kind === "game") return item.status === "platinumed" ? "白金" : null;
  return item.kind === "movie" && item.mediaType && item.mediaType !== "电影" ? item.mediaType : null;
}

export type PlatformTone = "nintendo" | "playstation" | "pc" | "other";
export interface PlatformChip { label: string; tone: PlatformTone }

/** A platform as its box on a game card says it: short, and in its maker's colour (the owner's choice, 2026-10-17). */
export function platformChip(platform: string): PlatformChip {
  const name = platform.trim();
  if (/^nintendo switch$/iu.test(name)) return { label: "Switch", tone: "nintendo" };
  if (/3ds$/iu.test(name)) return { label: "3DS", tone: "nintendo" };
  if (/^playstation/iu.test(name)) return { label: "PlayStation", tone: "playstation" };
  if (/^(personal computer|pc)$/iu.test(name)) return { label: "PC", tone: "pc" };
  return { label: name, tone: "other" };
}

/** A game's platforms as chips, each label once: a PlayStation 4 and 5 game is one "PlayStation", not two. */
export function platformChips(platforms: string[]): PlatformChip[] {
  const chips = new Map<string, PlatformChip>();
  for (const platform of platforms) {
    const chip = platformChip(platform);
    if (chip.label && !chips.has(chip.label)) chips.set(chip.label, chip);
  }
  return [...chips.values()];
}

/**
 * Time played as a game card writes it: whole hours from a hundred on, one decimal below, nothing for
 * none at all (a game bought and not played) or an unknown time. Minutes as they are. A time that
 * rounds to nothing (a game opened for a minute or two, 0.02 hours) is left out too: "0 小时" reads as
 * unplayed, and none at all is what the owner chose for that (F24; S13-4, 2026-10-23).
 */
export function cardTimeLabel(amount: TimeAmount | null): string | null {
  if (!amount) return null;
  const shown = amount.unit !== "hour" || amount.value >= 100 ? Math.round(amount.value) : Math.round(amount.value * 10) / 10;
  return shown > 0 ? `${shown} ${amount.unit === "hour" ? "小时" : "分钟"}` : null;
}

/** A game card's second line: its platforms, time played and rating; an unknown one is left out, not written as missing. */
export function gameCard(item: Game): { platforms: PlatformChip[]; time: string | null; rating: string | null } {
  return { platforms: platformChips(item.platforms), time: cardTimeLabel(item.playedTime), rating: item.rating ? ratingLabel(item.rating) : null };
}

/** A book's facts for the quiet line under its title, one piece each. Unknown values are omitted here and stated on the detail page. */
function bookParts(item: Book): string[] {
  const parts = [item.authors.join("、") || null, item.status === "reading" && item.progressPercent !== null ? `${item.progressPercent}%` : null,
    item.personalRating ? ratingLabel(item.personalRating) : null];
  return parts.filter((part): part is string => Boolean(part));
}

/**
 * A numeric rating on a small whole-number scale can be drawn as dots; the exact value is always
 * shown beside them, so rounding to whole dots loses nothing. Anything else is text only.
 */
export function ratingDots(rating: Rating | null): { filled: number; total: number } | null {
  if (!rating || rating.value === null || rating.scale === null) return null;
  const { value, scale } = rating;
  if (!Number.isInteger(scale) || scale < 3 || scale > 10 || !Number.isFinite(value) || value < 0 || value > scale) return null;
  return { filled: Math.round(value), total: scale };
}

/** A progress figure as a bar width; null, non-numbers and out-of-range values draw no bar. */
export function progressWidth(percent: number | null): string | null {
  return percent !== null && Number.isFinite(percent) && percent >= 0 && percent <= 100 ? `${percent}%` : null;
}

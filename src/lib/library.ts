import type { Book, DateRange, Game, Movie, Rating, TimeAmount } from "../../contracts/content.ts";
import { ratingLabel } from "./format.ts";
import type { YearChoice } from "./year-filter.ts";
import { gameBrowsingDate } from "./content/game-date.ts";
import { gameCaseAspectRatio, gameCasePlatformKey, selectGameCasePlatform } from "./content/game-case.ts";
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
  已玩时长: value => `玩了 ${value}`,
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
 * is a badge on the cover instead (`coverBadge`). Books keep their summary line; games are drawn as their
 * cases (`gameCaseFace`).
 */
export function cardParts(item: Book | Movie): string[] {
  if (item.kind === "movie") return [ratingLabel(item.rating, "未评分")];
  return bookParts(item);
}

/** What is laid on a cover: a film or show's kind when it is not simply a film. A game's status is on its case's band. */
export function coverBadge(item: LibraryItem): string | null {
  return item.kind === "movie" && item.mediaType && item.mediaType !== "电影" ? item.mediaType : null;
}

export type PlatformTone = "nintendo" | "playstation" | "pc" | "other";
export interface PlatformChip { label: string; tone: PlatformTone }

/** A platform as its box on a game card says it: short, and in its maker's colour (the owner's choice, 2026-10-17). */
export function platformChip(platform: string): PlatformChip {
  const name = platform.trim();
  if (/^nintendo switch$/iu.test(name)) return { label: "Switch", tone: "nintendo" };
  if (/^(nintendo )?switch ?2$/iu.test(name)) return { label: "Switch 2", tone: "nintendo" };
  if (/3ds$/iu.test(name)) return { label: "3DS", tone: "nintendo" };
  if (/^playstation/iu.test(name)) return { label: "PlayStation", tone: "playstation" };
  if (/^(personal computer|pc)$/iu.test(name)) return { label: "PC", tone: "pc" };
  return { label: name, tone: "other" };
}

export type GamePlatformIcon = "steam" | "playstation" | "switch" | "3ds" | "pc";

/**
 * The outline drawn before a platform's name in the home timeline's game tag (F60, the owner's pick 甲,
 * 2026-11-22), by the label `platformChip` gives it. Switch 2 shares the Switch outline: its name already
 * says 2, and a numeral inside a 13-pixel icon only blurs. A platform not known here has its name alone.
 */
export function gamePlatformIcon(label: string): GamePlatformIcon | null {
  switch (label.toLowerCase()) {
    case "steam": return "steam";
    case "playstation": return "playstation";
    case "switch": case "switch 2": return "switch";
    case "3ds": return "3ds";
    case "pc": return "pc";
    default: return null;
  }
}

/**
 * What a game's case shows (the owner's pick 甲, 2026-11-23): one platform, the one played longest, chosen by the
 * same shared rule the artwork is chosen by, in the shape of that platform's real case; the others are said
 * beside it. The status goes at the right end of the case's platform band, not over the art.
 */
export interface GameCaseFace {
  platform: PlatformChip | null;
  icon: GamePlatformIcon | null;
  /** The maker whose case it is: its shell and band colours. */
  tone: "nintendo" | "playstation" | "pc";
  /** Width over height of the whole case. */
  ratio: number;
  others: string[];
  status: string | null;
  /**
   * Which printed case it copies (the owner's request, 2026-11-24, measured from real cases): PS5's white band, PS4's
   * blue one, plain "ps" when the record does not say which PlayStation (the white band with the PS mark alone, so a
   * model is never guessed), Switch 2's tall red band, Switch's red corner tile. Steam, PC and 3DS keep the plain band.
   */
  look: GameCaseLook | null;
}
export type GameCaseLook = "ps5" | "ps4" | "ps" | "switch2" | "switch";
/** The printed case for the exact platform the case shows: "PlayStation 5" or "PS5" is a PS5 case; "PlayStation" alone is not known. */
export function gameCaseLook(platform: string | null): GameCaseLook | null {
  if (platform === null) return null;
  const name = platform.trim().toLowerCase();
  if (/^(?:playstation ?5|ps5)$/u.test(name)) return "ps5";
  if (/^(?:playstation ?4|ps4)$/u.test(name)) return "ps4";
  const key = gameCasePlatformKey(platform);
  return key === "playstation" ? "ps" : key === "switch2" ? "switch2" : key === "switch" ? "switch" : null;
}
const switchFamily = (label: string) => label === "Switch" || label === "Switch 2";
export function gameCaseFace(item: Game): GameCaseFace {
  const chosen = selectGameCasePlatform(item);
  const platform = chosen === null ? null : platformChip(chosen);
  const key = chosen === null ? "" : gameCasePlatformKey(chosen);
  return {
    platform, icon: platform ? gamePlatformIcon(platform.label) : null,
    tone: key === "switch" || key === "switch2" || key === "3ds" ? "nintendo" : key === "playstation" ? "playstation" : "pc",
    ratio: gameCaseAspectRatio(chosen ?? ""),
    // Switch and Switch 2 are one family (a Switch game with its Switch 2 upgrade): the case names one, and the other
    // is not said again as "也在 Switch" (owner, 2026-11-23).
    others: platformChips(item.platforms).map(chip => chip.label)
      .filter(label => label !== platform?.label && !(switchFamily(label) && platform && switchFamily(platform.label))),
    status: item.status === "platinumed" ? "白金" : item.status === "clear" ? "通关" : null,
    look: gameCaseLook(chosen),
  };
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

/**
 * What a year on the games page says beside its count (乙, 2026-11-24): the hours played and how many games each
 * platform family holds. Worked out from the games shown, so the page asks for it only once every game of the year
 * is in; a year still paging in says its count alone. Switch and Switch 2 are one family, as on the cases.
 */
export interface GameYearFacts { hours: number | null; platforms: { icon: GamePlatformIcon; count: number }[] }
const FAMILY_ORDER: GamePlatformIcon[] = ["switch", "playstation", "steam", "pc", "3ds"];
export function gameYearFacts(games: Game[]): GameYearFacts {
  let minutes = 0, timed = 0;
  const counts = new Map<GamePlatformIcon, number>();
  for (const game of games) {
    const time = game.playedTime;
    if (time && time.value > 0) { minutes += time.unit === "hour" ? time.value * 60 : time.value; timed++; }
    const families = new Set(platformChips(game.platforms).flatMap(chip => { const icon = gamePlatformIcon(chip.label); return icon ? [icon] : []; }));
    for (const family of families) counts.set(family, (counts.get(family) ?? 0) + 1);
  }
  return {
    hours: timed ? Math.round(minutes / 60) : null,
    platforms: FAMILY_ORDER.flatMap(icon => counts.get(icon) ? [{ icon, count: counts.get(icon)! }] : []),
  };
}

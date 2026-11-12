import type { DateRange } from "../../contracts/content.ts";
import type { TimelineEvent } from "../../contracts/website.ts";
import { dateParts, dayLabel, momentLabel, ratingLabel, type CalendarDay, type MomentLabel } from "./format.ts";

/** An update from a section other than status, shown as a small card between status entries. */
export type WorkEvent = Exclude<TimelineEvent, { type: "status" }>;

interface EventKind {
  /** Section the update belongs to; also the suffix of the tag and card classes. */
  kind: "movie" | "book" | "game" | "album" | "post" | "project";
  section: string;
  verb: string;
}

/** Wishlists and unknown states are not activity; the timeline endpoint never sends them. */
export const eventKinds: Record<WorkEvent["type"], EventKind> = {
  "movie-watched": { kind: "movie", section: "影视", verb: "看过" },
  "book-reading": { kind: "book", section: "书籍", verb: "在读" },
  "book-read": { kind: "book", section: "书籍", verb: "读完" },
  "book-given-up": { kind: "book", section: "书籍", verb: "弃读" },
  "game-playing": { kind: "game", section: "游戏", verb: "在玩" },
  "game-cleared": { kind: "game", section: "游戏", verb: "通关" },
  "game-platinumed": { kind: "game", section: "游戏", verb: "白金" },
  "album-new": { kind: "album", section: "相册", verb: "新相册" },
  "post-new": { kind: "post", section: "文章", verb: "新文章" },
  "project-new": { kind: "project", section: "项目", verb: "新项目" },
};

/** One quiet line under the title. Unknown values are left out, never shown as zero. */
export function eventDetail(event: WorkEvent): string {
  if (event.type === "post-new") return event.summary ?? "";
  if (event.type === "album-new") return event.detail && Number(event.detail) > 0 ? `${event.detail} 张` : "";
  return [
    event.detail,
    event.type === "book-reading" && event.progressPercent !== null ? `${event.progressPercent}%` : null,
    event.rating ? ratingLabel(event.rating) : null,
  ].filter(Boolean).join(" · ");
}

export interface EventMoment {
  /** Month grouping in the site's time zone; null when the date is unknown. */
  month: { key: string; label: string } | null;
  time: string | null;
}

/** Anything dated can be placed on the timeline: a content event, or a work published elsewhere. */
export function eventMoment(event: { occurredAt: DateRange | null }, timeZone: string): EventMoment {
  const parts = event.occurredAt ? dateParts(event.occurredAt.start, event.occurredAt.precision, timeZone) : null;
  return parts
    ? { month: { key: `${parts.year}-${parts.month}`, label: `${parts.year} 年 ${parts.month} 月` }, time: dayLabel(parts) }
    : { month: null, time: null };
}

/** The time line of a dated entry as it reads today; null when the date is unknown. */
export function entryMoment(occurredAt: DateRange | null, timeZone: string, today: CalendarDay | null): MomentLabel | null {
  const parts = occurredAt ? dateParts(occurredAt.start, occurredAt.precision, timeZone) : null;
  return parts ? momentLabel(parts, today) : null;
}

/** Entries of the home timeline that are shown as one: a single entry, or works that follow one another. */
export interface FeedRun<T> {
  /** Position of the run's first entry in the list it came from. */
  first: number;
  items: T[];
}

/**
 * Works published elsewhere that follow one another with nothing between them are read as one run,
 * so a stretch of them is one list and not a column of cards. A run never crosses into another
 * month, because the month headings stand between entries. Everything else is a run of one.
 */
export function feedRuns<T extends { source: string; occurredAt: DateRange | null }>(items: T[], timeZone: string): FeedRun<T>[] {
  const runs: FeedRun<T>[] = [];
  let month: string | undefined;
  items.forEach((item, index) => {
    const key = eventMoment(item, timeZone).month?.key ?? "unknown";
    const last = runs.at(-1);
    if (item.source === "social" && last && last.items[0]!.source === "social" && key === month) last.items.push(item);
    else runs.push({ first: index, items: [item] });
    month = key;
  });
  return runs;
}

/**
 * The days a run of entries covers, earliest first, as it reads today: one day, or "… 至 …"; entries without
 * a date are left out and a run with none has no span. A run within one day is named like any entry of that day, without
 * a time of day because it belongs to one work only; a run over several days stays plain dates.
 */
export function spanMoment(items: readonly { occurredAt: DateRange | null }[], timeZone: string, today: CalendarDay | null): MomentLabel | null {
  const days = items.flatMap(item => {
    const parts = item.occurredAt ? dateParts(item.occurredAt.start, item.occurredAt.precision, timeZone) : null;
    return parts ? [{ at: parts.year * 10000 + parts.month * 100 + parts.day, parts: { ...parts, time: null } }] : [];
  }).sort((a, b) => a.at - b.at);
  if (!days.length) return null;
  const earliest = days[0]!, latest = days.at(-1)!;
  if (earliest.at !== latest.at) return { relative: null, rest: `${dayLabel(earliest.parts)} 至 ${dayLabel(latest.parts)}` };
  const moment = momentLabel(earliest.parts, today);
  // Today has no time of day to follow it here, so the date stays for the line not to be one bare word among tags.
  return moment.relative === "今天" ? { relative: moment.relative, rest: dayLabel(earliest.parts) } : moment;
}

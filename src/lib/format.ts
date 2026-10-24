import type { DateRange, Rating } from "../../contracts/content.ts";

export interface DateParts {
  year: number;
  month: number;
  day: number;
  /** null for date-only values. */
  time: string | null;
}

/** Numeric parts only, so server and browser output cannot drift with locale data. */
export function dateParts(value: string, precision: DateRange["precision"], timeZone: string): DateParts | null {
  if (precision === "date") {
    const match = /^(\d{4})-(\d{2})-(\d{2})/u.exec(value);
    return match ? { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]), time: null } : null;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(date);
  const pick = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  return { year: Number(pick("year")), month: Number(pick("month")), day: Number(pick("day")), time: `${pick("hour")}:${pick("minute")}` };
}

export function dayLabel(parts: DateParts): string {
  return `${parts.month} 月 ${parts.day} 日${parts.time ? ` ${parts.time}` : ""}`;
}

/** A day on the calendar, in whatever zone it was read in. */
export type CalendarDay = Pick<DateParts, "year" | "month" | "day">;

/** The calendar day a moment falls on in the site's time zone; null when the moment cannot be read. */
export function calendarDay(moment: string, timeZone: string): CalendarDay | null {
  const parts = dateParts(moment, "datetime", timeZone);
  return parts ? { year: parts.year, month: parts.month, day: parts.day } : null;
}

/**
 * How a recent day is called: 今天, 昨天, 前天, then "N 天前" up to a week back. Older days and days
 * still to come have no such name. Two calendar days are compared, never elapsed hours: the day the
 * clocks change is not 24 hours long, and an entry written late one evening is "昨天" the next
 * morning however few hours have passed.
 */
export function relativeDay(day: CalendarDay, today: CalendarDay): string | null {
  const days = Math.round((Date.UTC(today.year, today.month - 1, today.day) - Date.UTC(day.year, day.month - 1, day.day)) / 86_400_000);
  if (days === 0) return "今天";
  if (days === 1) return "昨天";
  if (days === 2) return "前天";
  return days >= 3 && days <= 7 ? `${days} 天前` : null;
}

/**
 * The time line of an entry. Within a week it leads with the relative name and keeps the date after
 * it; today needs no date, only its time of day when one was recorded. Anything older is the date
 * alone, as before. An entry recorded to the day gets no time of day made up for it.
 */
export interface MomentLabel {
  /** 今天, 昨天, 前天, "N 天前", or null. */
  relative: string | null;
  /** What follows it: the date, or today's time of day; null when there is nothing to add. */
  rest: string | null;
}
export function momentLabel(parts: DateParts, today: CalendarDay | null): MomentLabel {
  const relative = today ? relativeDay(parts, today) : null;
  return { relative, rest: relative === "今天" ? parts.time : dayLabel(parts) };
}

export function rangeLabel(range: DateRange | null, timeZone: string): string | null {
  if (!range) return null;
  const start = dateParts(range.start, range.precision, timeZone);
  if (!start) return null;
  const end = range.end ? dateParts(range.end, range.precision, timeZone) : null;
  const first = `${start.year} 年 ${dayLabel(start)}`;
  // A range that starts and ends at the same moment is that one day, not "from it to itself".
  if (!end || (end.year === start.year && end.month === start.month && end.day === start.day && end.time === start.time)) return first;
  return `${first} 至 ${end.year === start.year ? "" : `${end.year} 年 `}${dayLabel(end)}`;
}

/** The day a page was last edited, in the site's time zone; null when the source gives no usable time. */
export function updatedLabel(updatedAt: string | null, timeZone: string): string | null {
  const parts = updatedAt ? dateParts(updatedAt, "datetime", timeZone) : null;
  return parts ? `更新于 ${parts.year} 年 ${parts.month} 月 ${parts.day} 日` : null;
}

/** "26S2" → "2026 S2"; anything else is shown as written in the source. */
export function semesterLabel(semester: string | null): string {
  if (!semester) return "学期未记录";
  const match = /^(\d{2})S([123])$/u.exec(semester);
  return match ? `20${match[1]} S${match[2]}` : semester;
}

/** A label written only in star emoji is redrawn with text stars, which take the colour of the text around them. */
function plainStars(label: string): string {
  return /^(?:\u2B50\uFE0F?)+$/u.test(label) ? "★".repeat(label.match(/\u2B50/gu)!.length) : label;
}

/**
 * A course's name without its own code in front. Sources title a course "CODE Name", and the code
 * is shown beside the title wherever this is used, so it would be read twice. A bracketed marker
 * before the code (the demo set's "[演示]") stays. A title that does not start with the code, or is
 * nothing but the code, is returned as it is.
 */
export function courseName(course: { code: string; title: string }): string {
  const code = course.code.trim();
  if (!code) return course.title;
  const marker = /^\[[^\]]*\]\s*/u.exec(course.title)?.[0] ?? "";
  const rest = course.title.slice(marker.length);
  if (!rest.toLowerCase().startsWith(code.toLowerCase())) return course.title;
  const after = rest.slice(code.length);
  // The code must end there: "FIT9131" is not the start of a course called "FIT91310 …".
  const name = after.replace(/^[\s:：·\-–—|]+/u, "");
  return name && name !== after ? marker + name : course.title;
}

/** null stays "未评价"; never rendered as zero. */
export function ratingLabel(rating: Rating | null, missing = "未评价"): string {
  if (!rating) return missing;
  if (rating.value !== null && rating.scale !== null) return `${rating.value} / ${rating.scale}`;
  return plainStars(rating.label) || missing;
}

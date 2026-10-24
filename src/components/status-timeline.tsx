import type { StatusEntry } from "../../contracts/content.ts";
import { dateParts, momentLabel, type CalendarDay } from "../lib/format.ts";
import { CoverImage } from "./cover-image";
import { EntryMoment } from "./entry-moment";
import { StatusBody } from "./status-body";
import { MonthLabel } from "./month-label";
import { runsBy } from "../lib/runs.ts";

/** Entries arrive newest first with unknown dates last; grouping keeps that order. */
function groupByMonth(items: StatusEntry[], timeZone: string, today: CalendarDay | null) {
  const dated = items.map(entry => {
    const parts = entry.recordedAt ? dateParts(entry.recordedAt.start, entry.recordedAt.precision, timeZone) : null;
    return { entry, month: parts ? { year: parts.year, month: parts.month } : null, moment: parts ? momentLabel(parts, today) : null };
  });
  return runsBy(dated, ({ month }) => month ? { key: `${month.year}-${month.month}`, label: `${month.year} 年 ${month.month} 月` } : { key: "unknown", label: "日期未记录" });
}

export function StatusTimeline({ items, timeZone, today = null, leadFirst = false, level = 3, appendedFrom = null }: {
  items: StatusEntry[]; timeZone: string; leadFirst?: boolean;
  /** Today in the site's time zone: entries of the last week are named by it ("昨天 · …"). Without it every entry is a plain date. */
  today?: CalendarDay | null;
  /** Index of the first entry added by the latest "load more"; those ease in. */
  appendedFrom?: number | null;
  /** Heading level of the month labels: one below the heading that introduces the timeline. */
  level?: 2 | 3;
}) {
  const leadId = leadFirst ? items[0]?.id : undefined;
  const appended = new Set(appendedFrom === null ? [] : items.slice(appendedFrom).map(item => item.id));
  const Month = `h${level}` as const;
  return (
    <>
      {groupByMonth(items, timeZone, today).map((group, index) => (
        <div key={`${group.key}:${group.items[0]?.entry.id}`}>
          <Month className={index === 0 ? "timeline__month timeline__month--first" : "timeline__month"}><MonthLabel monthKey={group.key} label={group.label} /></Month>
          {group.items.map(({ entry, moment }) => (
            <article key={entry.id} id={entry.id} className={`${entry.id === leadId ? "entry entry--lead" : "entry"}${appended.has(entry.id) ? " is-appended" : ""}`}>
              {/* Undated entries sit under their own "日期未记录" heading; no invented date per entry. */}
              {moment ? <time className="entry__time" dateTime={entry.recordedAt?.start}><EntryMoment moment={moment} /></time> : null}
              <StatusBody entry={entry} titleLevel={level === 2 ? 3 : 4} />
              {/* Media paths are re-checked on every request, so the image is never optimised or cached here. */}
              {entry.cover ? <CoverImage className="entry__cover" image={entry.cover} previewWidth={800} label="动态封面" lazy /> : null}
            </article>
          ))}
        </div>
      ))}
    </>
  );
}

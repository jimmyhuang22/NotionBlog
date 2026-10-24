import type { SocialTimelineWork } from "../../contracts/social-timeline.ts";
import { collectionBadge, platformNames } from "../lib/home-feed.ts";
import type { CalendarDay } from "../lib/format.ts";
import { coverPreviewWidths, workDayMoment, workLines } from "../lib/works.ts";
import { CoverImage } from "./cover-image";
import { EntryMoment } from "./entry-moment";
import { PlatformExitNote, PlatformMark, PlaySign, StackSign } from "./platform-signs";

/** Whether a work is drawn as a Bilibili home card: a Bilibili work that lives nowhere else. */
export function isBiliCard(work: SocialTimelineWork): boolean {
  const lines = workLines(work);
  return lines.length === 1 && lines[0]!.platform === "bilibili";
}

/**
 * A Bilibili work on the home timeline, drawn like a video on the owner's Bilibili page (the owner's
 * choice, 2026-10-17): the cover with its kind at the top left, views and the number of videos along its
 * foot, then the title and the day under it, without a card behind. Bilibili shows no likes. The whole
 * card is the way out to Bilibili, read as its title, where it lives, its figures and its day. A missing
 * cover keeps a quiet place marked with the platform.
 *
 * A collection's addition is a number at the cover's top right, "+N" ("新" when the count is unknown),
 * with the full words for screen readers (the owner's choice, F37). The day is left to the timeline row
 * unless the row holds works of several days (`showDay`).
 */
export function BiliCard({ work, timeZone, today = null, showDay = true }: { work: SocialTimelineWork; timeZone: string; today?: CalendarDay | null; showDay?: boolean }) {
  const lead = workLines(work)[0]!;
  const views = lead.figures.find(figure => figure.metric === "views") ?? null;
  // "151 个视频" or "26 个分 P": the count on the cover, the words read out.
  const count = lead.count;
  // The day's total from the backend when it sends one, else the latest addition.
  const badge = work.collection ? collectionBadge(work.collection, timeZone) : null;
  const day = showDay ? workDayMoment(work, timeZone, today) : null;
  const name = platformNames[lead.platform];
  const mark = <PlatformMark platform={lead.platform} size={15} />;
  const blank = <span className="bili-card__blank">{mark}<span className="visually-hidden">封面未记录</span></span>;
  const body = (
    <>
      <span className="bili-card__title">{work.title}</span>
      {day ? <span className="bili-card__meta"><EntryMoment moment={day} /></span> : null}
      {badge ? <span className="visually-hidden">，{badge.words}</span> : null}
      {/* After the words in the source, so the link reads its title first; drawn on top (`order`). */}
      <span className="bili-card__frame">
        {work.cover ? <CoverImage className="bili-card__cover" image={work.cover} previewWidth={coverPreviewWidths.wide} label="作品封面" lazy sized={false} fallback={blank} /> : blank}
        <span className="bili-card__badge">{mark}<span className="visually-hidden">{name}</span>{lead.kind}</span>
        {badge ? <span className="bili-card__new" aria-hidden="true">{badge.count ? `+${badge.count}` : "新"}</span> : null}
        {views || count !== null ? (
          <span className="bili-card__stats">
            {views ? <span><PlaySign size={11} /><span className="visually-hidden">{views.label}</span>{views.value}</span> : <span />}
            {count !== null ? <span><StackSign /><span className="visually-hidden">共{lead.size}</span><span aria-hidden="true">{count}</span></span> : null}
          </span>
        ) : null}
      </span>
      {lead.url ? <PlatformExitNote name={name} /> : null}
    </>
  );
  // Only a checked address is a link; the address is used exactly as given.
  return lead.url
    ? <a className="bili-card" href={lead.url} target="_blank" rel="noopener noreferrer" {...(lead.opensLatest ? { title: "打开最新一集" } : {})}>{body}</a>
    : <div className="bili-card">{body}</div>;
}

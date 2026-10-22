import type { SocialTimelineWork } from "../../contracts/social-timeline.ts";
import { platformNames } from "../lib/home-feed.ts";
import type { CalendarDay } from "../lib/format.ts";
import { coverPreviewWidths, coverShapes, workLines, worksDay } from "../lib/works.ts";
import { socialWorkPlatform } from "../lib/content/social-works-query.ts";
import { CoverImage } from "./cover-image";
import { EntryMoment } from "./entry-moment";
import { socialIconPaths } from "./social-icon-paths";

/**
 * A work on the works page (the owner's choice, 2026-10-18): a Bilibili work as a 16:9 frame with its
 * views and number of videos on the cover, a Xiaohongshu note as a whole 3:4 cover with its likes on
 * it; then the title, up to two lines, and its day. A collection says when it was last updated; there
 * is no "新增 N 个视频" here, an updated one is simply first. Bilibili shows no likes. The card is the way
 * out to the platform and reads title first.
 */
export function WorksCard({ work, timeZone, today = null, withYear = false }: { work: SocialTimelineWork; timeZone: string; today?: CalendarDay | null; withYear?: boolean }) {
  const platform = socialWorkPlatform(work);
  const shape = coverShapes[platform];
  const lead = workLines(work).find(line => line.platform === platform) ?? workLines(work)[0];
  const figure = lead?.figures.find(entry => entry.metric === (platform === "bilibili" ? "views" : "likes")) ?? null;
  const count = lead?.size ? /\d+/u.exec(lead.size)?.[0] ?? null : null;
  const day = worksDay(work, timeZone, today, withYear);
  const name = platformNames[platform];
  const url = lead?.url ?? null;
  const mark = <svg aria-hidden="true" width="22" height="22" viewBox={platform === "xiaohongshu" ? "0 6 24 12" : "0 0 24 24"} fill="currentColor"><path d={socialIconPaths[platform]} /></svg>;
  const blank = <span className="works-card__blank">{mark}<span className="visually-hidden">封面未记录</span></span>;
  const sign = platform === "bilibili"
    ? <svg aria-hidden="true" width="11" height="11" viewBox="0 0 16 16" fill="currentColor"><path d="M4.5 2.6v10.8L13 8z" /></svg>
    : <svg aria-hidden="true" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"><path d="M8 13.4S2.2 10 2.2 5.9A3 3 0 0 1 8 4.7a3 3 0 0 1 5.8 1.2C13.8 10 8 13.4 8 13.4z" /></svg>;
  const body = (
    <>
      <span className="works-card__title" title={shape === "wide" ? work.title : undefined}>{work.title}</span>
      {day ? <span className="works-card__day">{work.collection ? "最后更新 " : ""}<EntryMoment moment={day} /></span> : null}
      {/* After the words in the source, so the link reads its title first; drawn above them (`order`). */}
      <span className="works-card__frame">
        {work.cover ? <CoverImage className="works-card__cover" image={work.cover} previewWidth={coverPreviewWidths[shape]} label="作品封面" lazy sized={false} fallback={blank} /> : blank}
        {figure || count ? (
          <span className="works-card__stats">
            {figure ? <span>{sign}<span className="visually-hidden">{figure.label}</span>{figure.value}</span> : <span />}
            {count ? <span><svg aria-hidden="true" width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round"><path d="M8 2.2 14 5.2 8 8.2 2 5.2z M2 8l6 3 6-3 M2 10.8l6 3 6-3" /></svg><span className="visually-hidden">共{lead?.size}</span><span aria-hidden="true">{count}</span></span> : null}
          </span>
        ) : null}
      </span>
      {url ? <span className="visually-hidden">，在{name}打开，原平台可能要求登录</span> : null}
    </>
  );
  const className = `works-card works-card--${shape}`;
  // Only a checked address is a link; the address is used exactly as given.
  return url ? <a className={className} href={url} target="_blank" rel="noopener noreferrer" {...(lead?.opensLatest ? { title: "打开最新一集" } : {})}>{body}</a> : <div className={className}>{body}</div>;
}

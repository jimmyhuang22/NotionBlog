import type { SocialTimelineWork } from "../../contracts/social-timeline.ts";
import { platformNames } from "../lib/home-feed.ts";
import type { CalendarDay } from "../lib/format.ts";
import { coverPreviewWidths, coverShapes, workLines, worksDay } from "../lib/works.ts";
import { socialWorkPlatform } from "../lib/content/social-works-query.ts";
import { CoverImage } from "./cover-image";
import { EntryMoment } from "./entry-moment";
import { LikeSign, PlatformExitNote, PlatformMark, PlaySign, StackSign } from "./platform-signs";

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
  const lines = workLines(work);
  const lead = lines.find(line => line.platform === platform) ?? lines[0];
  const figure = lead?.figures.find(entry => entry.metric === (platform === "bilibili" ? "views" : "likes")) ?? null;
  const count = lead?.count ?? null;
  const day = worksDay(work, timeZone, today, withYear);
  const name = platformNames[platform];
  const url = lead?.url ?? null;
  const mark = <PlatformMark platform={platform} size={22} square />;
  const blank = <span className="works-card__blank">{mark}<span className="visually-hidden">封面未记录</span></span>;
  const sign = platform === "bilibili" ? <PlaySign size={11} /> : <LikeSign platform={platform} size={12} stroke={1.5} />;
  const body = (
    <>
      <span className="works-card__title" title={shape === "wide" ? work.title : undefined}>{work.title}</span>
      {day ? <span className="works-card__day">{work.collection ? "最后更新 " : ""}<EntryMoment moment={day} /></span> : null}
      {/* After the words in the source, so the link reads its title first; drawn above them (`order`). */}
      <span className="works-card__frame">
        {work.cover ? <CoverImage className="works-card__cover" image={work.cover} previewWidth={coverPreviewWidths[shape]} label="作品封面" lazy sized={false} fallback={blank} /> : blank}
        {figure || count !== null ? (
          <span className="works-card__stats">
            {figure ? <span>{sign}<span className="visually-hidden">{figure.label}</span>{figure.value}</span> : <span />}
            {count !== null ? <span><StackSign /><span className="visually-hidden">共{lead?.size}</span><span aria-hidden="true">{count}</span></span> : null}
          </span>
        ) : null}
      </span>
      {url ? <PlatformExitNote name={name} /> : null}
    </>
  );
  const className = `works-card works-card--${shape}`;
  // Only a checked address is a link; the address is used exactly as given.
  return url ? <a className={className} href={url} target="_blank" rel="noopener noreferrer" {...(lead?.opensLatest ? { title: "打开最新一集" } : {})}>{body}</a> : <div className={className}>{body}</div>;
}

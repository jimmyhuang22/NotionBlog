import type { SocialTimelineWork } from "../../contracts/social-timeline.ts";
import type { ReactNode } from "react";
import { collectionBadge, platformNames } from "../lib/home-feed.ts";
import { calendarDay, type CalendarDay, type MomentLabel } from "../lib/format.ts";
import { workDayMoment, workLines, workMoment, type WorkLine } from "../lib/works.ts";
import type { Figure } from "../lib/home-feed.ts";
import type { SocialPlatform } from "../../contracts/social.ts";
import { CoverImage } from "./cover-image";
import { EntryMoment } from "./entry-moment";
import { figureSignPath, LikeSign, PlatformExitNote, PlatformMark, PlaySign, StackSign } from "./platform-signs";
import { BiliCard, isBiliCard } from "./bili-card";
import { SocialWorkCard } from "./social-work-card";
import { WorkStrip } from "./work-strip";

/**
 * Works that follow one another on the home timeline. Two or three are light lines, one under another,
 * each as a work standing alone is drawn (the owner's choice, F57, 2026-11-18: a strip with an upright
 * note beside a video frame took a whole screen for one more work). From four on they are a strip of
 * small cards moved sideways: a Bilibili work as on its Bilibili page (`BiliCard`, the owner's choice of
 * 2026-10-17), any other in its platform's shape. While none of them has a cover the strip is one list
 * instead, a line each: the title, where it lives, its day, views and likes and the way out. Either way
 * every work keeps to its own platform's figures and address, an unknown figure is left out and only a
 * checked address is a link. The row above names the day; a work names its own only when the works here
 * fall on different days. Days are named the way status entries name them.
 */
/** Up to this many works in a row are light lines; more make a strip (F57). */
export const LINED_RUN = 3;

export function HomeWorks({ works, timeZone, today = null, priorityCover = false }: { works: SocialTimelineWork[]; timeZone: string; today?: CalendarDay | null; priorityCover?: boolean }) {
  const days = new Set(works.map(work => { const moment = workMoment(work); const day = moment ? calendarDay(moment, timeZone) : null; return day ? `${day.year}-${day.month}-${day.day}` : "?"; }));
  const showDay = days.size > 1;
  if (works.length <= LINED_RUN) {
    return (
      <ul className="work-lines" aria-label={`${works.length} 件作品`}>
        {works.map((work, index) => <li key={work.id}><HomeWorkLine work={work} timeZone={timeZone} today={today} showDay={showDay} priorityCover={priorityCover && index === 0} /></li>)}
      </ul>
    );
  }
  if (works.some(work => work.cover)) {
    return (
      <WorkStrip label={works.length > 1 ? `${works.length} 件作品，可左右滚动` : "1 件作品"}>
        {works.map((work, index) => (
          <li key={work.id}>
            {isBiliCard(work)
              ? <BiliCard work={work} timeZone={timeZone} today={today} showDay={showDay} priorityCover={priorityCover && index === 0} />
              : <SocialWorkCard work={work} timeZone={timeZone} today={today} small showDay={showDay} priorityCover={priorityCover && index === 0} />}
          </li>
        ))}
      </WorkStrip>
    );
  }
  return (
    <ul className="card home-works">
      {works.map(work => <li key={work.id}>{workLines(work).map((line, index) => {
        const name = platformNames[line.platform];
        const day = workDayMoment(work, timeZone, today);
        const body = (
          <>
            {/* Said once; a further platform's line sits under the same title and is read with it. */}
            {index === 0 ? <span className="home-works__title">{work.title}</span> : null}
            <span className="home-works__arrow" aria-hidden="true">{line.url ? "↗" : null}</span>
            <span className="home-works__meta">
              {index === 0 ? null : <span className="visually-hidden">{work.title}，</span>}
              <PlatformMark platform={line.platform} />
              <span>{name}</span><span className="home-works__part">{line.kind}</span>
              {line.size ? <span className="home-works__part">{line.size}</span> : null}
              {index === 0 && day ? <span className="home-works__part"><EntryMoment moment={day} /></span> : null}
              {/* Listed at the moment a change was noticed: said here, so the day is not read as a publication date. */}
              {line.noticed ? <span className="home-works__part">发现更新</span> : null}
            </span>
            <span className="home-works__figures">
              {line.figures.length
                ? line.figures.map(figure => <span key={figure.metric}><FigureMark figure={figure} platform={line.platform} /></span>)
                : <span className="home-works__label">数据未记录</span>}
            </span>
            {line.url ? <PlatformExitNote name={name} /> : null}
          </>
        );
        // Only a checked address is a link; the address is used exactly as given.
        const className = index === 0 ? "home-works__row" : "home-works__row home-works__row--more";
        return line.url
          ? <a key={line.key} className={className} href={line.url} target="_blank" rel="noopener noreferrer" {...(line.opensLatest ? { title: "打开最新一集" } : {})}>{body}</a>
          : <div key={line.key} className={className}>{body}</div>;
      })}</li>)}
    </ul>
  );
}

/**
 * A figure as its sign and number (2026-11-19, the owner's pick: words such as 播放 read as forced); the name is
 * still read out. A figure without a sign of its own keeps its word.
 */
export function FigureMark({ figure, platform }: { figure: Figure; platform: SocialPlatform }) {
  if (!figureSignPath(figure.metric, platform)) return <>{figure.label} {figure.value}</>;
  return <>{figure.metric === "views" ? <PlaySign size={11} /> : <LikeSign platform={platform} size={11} stroke={1.5} />}<span className="visually-hidden">{figure.label}</span>{figure.value}</>;
}

/** The platforms of some works, each once, in their order: the signs in the row's "作品" tag (2026-11-19). */
export function workPlatforms(works: SocialTimelineWork[]): SocialPlatform[] {
  return [...new Set(works.flatMap(work => workLines(work).slice(0, 1).map(line => line.platform)))];
}

/**
 * What a light line's quiet line says after the platform's sign (2026-11-18, the owner's pick): the sign stands
 * for the platform, whose name is only read out; a single post's kind (视频, 图文) is left out; a collection's
 * kind and size are one phrase ("合集 179 个视频") followed by what was added as "+N" ("新" when the count is
 * unknown, the full words read out, as on a strip card); then the figures. The day comes first when asked for.
 * A line that would say nothing after the sign keeps its kind.
 */
function quietParts(line: WorkLine, day: MomentLabel | null, badge: { count: number | null; words: string } | null) {
  const parts: { key: string; node: ReactNode; figure?: boolean }[] = [];
  if (day) parts.push({ key: "day", node: <EntryMoment moment={day} /> });
  const collection = line.key.startsWith("collection:");
  if (collection) {
    parts.push({ key: "size", node: <>{[line.kind, line.size].filter(Boolean).join(" ")}{badge ? <><span className="work-line__added" aria-hidden="true">{badge.count ? `+${badge.count}` : "新"}</span><span className="visually-hidden">，{badge.words}</span></> : null}</> });
  }
  for (const figure of line.figures) parts.push({ key: figure.metric, node: <FigureMark figure={figure} platform={line.platform} />, figure: true });
  if (!parts.length) parts.push({ key: "kind", node: line.kind });
  return parts.map((part, index) => <span key={part.key} className={`work-line__part${part.figure ? " work-line__figure" : ""}${index === 0 ? " work-line__part--first" : ""}`}>{part.node}</span>);
}

/**
 * A work standing alone on the home timeline, as one light line (the owner's choice, 2026-11-11). Since
 * 2026-11-19 (the owner's pick 乙, after the works page) its picture is a small wide frame, 144 by 81, the same for
 * every platform (an upright note cropped from its top), carrying the figures at its foot as the works page does:
 * views and the collection's size, or likes; a collection's addition as "+N" at its top right. The title stands
 * beside it alone; the platform's sign sits in the row's "作品" tag (home-timeline.tsx). The day is written under
 * the title only among works of different days (`showDay`). Everything on the picture is also read out. A further
 * platform of the same work keeps its own short line under it with that platform's figures and address. The
 * picture comes after the words in the source, so the link reads its title first; only a checked address is a link.
 */
export function HomeWorkLine({ work, timeZone, today = null, showDay = false, priorityCover = false }: { work: SocialTimelineWork; timeZone: string; today?: CalendarDay | null; showDay?: boolean; priorityCover?: boolean }) {
  const [lead, ...more] = workLines(work);
  const badge = work.collection ? collectionBadge(work.collection, timeZone) : null;
  const name = lead ? platformNames[lead.platform] : null;
  const day = showDay ? workDayMoment(work, timeZone, today) : null;
  const blank = <span className="work-line__blank">{lead ? <PlatformMark platform={lead.platform} size={18} /> : null}<span className="visually-hidden">封面未记录</span></span>;
  const views = lead?.figures.find(figure => figure.metric === "views") ?? null;
  const likes = lead && !views ? lead.figures.find(figure => figure.metric === "likes") ?? null : null;
  const shown = views ?? likes;
  const count = lead?.count ?? null;
  const main = (
    <>
      <span className="work-line__text">
        <span className="work-line__title">{work.title}</span>
        {/* What the picture shows, for those who do not see it. */}
        {lead ? <span className="visually-hidden">，{[name, lead.kind, lead.size, badge?.words, ...lead.figures.map(figure => `${figure.label} ${figure.value}`)].filter(Boolean).join("，")}</span> : null}
        {day ? <span className="work-line__meta"><EntryMoment moment={day} /></span> : null}
      </span>
      <span className={`work-line__thumb${lead && lead.platform === "xiaohongshu" ? " work-line__thumb--tall" : ""}`} aria-hidden="true">
        {work.cover ? <CoverImage className="work-line__cover" image={work.cover} previewWidth={400} label="作品封面" lazy priority={priorityCover} sized={false} fallback={blank} /> : blank}
        {badge ? <span className="work-line__new">{badge.count ? `+${badge.count}` : "新"}</span> : null}
        {lead && (shown || count !== null) ? (
          <span className="work-line__stats">
            {shown ? <span>{shown.metric === "views" ? <PlaySign size={11} /> : <LikeSign platform={lead.platform} size={11} stroke={1.5} />}{shown.value}</span> : <span />}
            {count !== null ? <span><StackSign />{count}</span> : null}
          </span>
        ) : null}
      </span>
      {lead?.url && name ? <PlatformExitNote name={name} /> : null}
    </>
  );
  return (
    <div className="work-line">
      {lead?.url
        ? <a className="work-line__main" href={lead.url} target="_blank" rel="noopener noreferrer" {...(lead.opensLatest ? { title: "打开最新一集" } : {})}>{main}</a>
        : <div className="work-line__main">{main}</div>}
      {more.map(line => {
        const lineName = platformNames[line.platform];
        const body = (
          <>
            <span className="visually-hidden">{work.title}，</span>
            <PlatformMark platform={line.platform} />
            <span className="visually-hidden">{lineName}，</span>
            {quietParts(line, null, null)}
            {line.url ? <PlatformExitNote name={lineName} /> : null}
          </>
        );
        return line.url
          ? <a key={line.key} className="work-line__meta work-line__more" href={line.url} target="_blank" rel="noopener noreferrer">{body}</a>
          : <span key={line.key} className="work-line__meta work-line__more">{body}</span>;
      })}
    </div>
  );
}

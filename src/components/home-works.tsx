import type { SocialTimelineWork } from "../../contracts/social-timeline.ts";
import { collectionAddition, platformNames } from "../lib/home-feed.ts";
import { calendarDay, type CalendarDay } from "../lib/format.ts";
import { coverShapes, workDayMoment, workLines, workMoment } from "../lib/works.ts";
import { CoverImage } from "./cover-image";
import { EntryMoment } from "./entry-moment";
import { PlatformExitNote, PlatformMark } from "./platform-signs";
import { BiliCard, isBiliCard } from "./bili-card";
import { SocialWorkCard } from "./social-work-card";
import { WorkStrip } from "./work-strip";

/**
 * Works that follow one another on the home timeline. With covers they are a strip of small cards moved
 * sideways (the owner's choice among three ways of showing covers): a Bilibili work as on its Bilibili
 * page (`BiliCard`, the owner's choice of 2026-10-17), any other in its platform's shape.
 * While none of them has a cover they stay one list, a line each: the title, where it lives, its day,
 * views and likes and the way out. Either way every work keeps to its own platform's figures and
 * address, an unknown figure is left out and only a checked address is a link. Days are named the way
 * status entries name them.
 */
export function HomeWorks({ works, timeZone, today = null, priorityCover = false }: { works: SocialTimelineWork[]; timeZone: string; today?: CalendarDay | null; priorityCover?: boolean }) {
  if (works.some(work => work.cover)) {
    // The row above names the day; a card repeats it only when the works here fall on different days.
    const days = new Set(works.map(work => { const moment = workMoment(work); const day = moment ? calendarDay(moment, timeZone) : null; return day ? `${day.year}-${day.month}-${day.day}` : "?"; }));
    return (
      <WorkStrip label={works.length > 1 ? `${works.length} 件作品，可左右滚动` : "1 件作品"}>
        {works.map((work, index) => (
          <li key={work.id}>
            {isBiliCard(work)
              ? <BiliCard work={work} timeZone={timeZone} today={today} showDay={days.size > 1} priorityCover={priorityCover && index === 0} />
              : <SocialWorkCard work={work} timeZone={timeZone} today={today} small priorityCover={priorityCover && index === 0} />}
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
                ? line.figures.map(figure => <span key={figure.metric}><span className="home-works__label">{figure.label}</span> {figure.value}</span>)
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
 * A work standing alone on the home timeline, as one light line (the owner's choice, 2026-11-11): a small
 * picture in its platform's shape, then the title and one quiet line of where it lives, its kind and its
 * figures. The status entries stay the timeline's main reading; this only says what was published. A further
 * platform of the same work gets its own short line under it with that platform's figures and address. The
 * picture comes after the words in the source, so the link reads its title first. The figures keep to the
 * platform's own and an unknown one is left out; only a checked address is a link.
 */
export function HomeWorkLine({ work, timeZone, priorityCover = false }: { work: SocialTimelineWork; timeZone: string; priorityCover?: boolean }) {
  const [lead, ...more] = workLines(work);
  const shape = lead ? coverShapes[lead.platform] : "wide";
  const update = work.collection ? collectionAddition(work.collection, timeZone) : null;
  const name = lead ? platformNames[lead.platform] : null;
  const blank = <span className="work-line__blank">{lead ? <PlatformMark platform={lead.platform} size={16} /> : null}<span className="visually-hidden">封面未记录</span></span>;
  const main = (
    <>
      <span className="work-line__text">
        <span className="work-line__title">{work.title}</span>
        {lead ? (
          <span className="work-line__meta">
            <PlatformMark platform={lead.platform} />
            <span>{name}</span>
            {[lead.kind, lead.size].filter(Boolean).map(part => <span key={part} className="work-line__part">{part}</span>)}
            {lead.figures.map(figure => <span key={figure.metric} className="work-line__part work-line__figure">{figure.label} {figure.value}</span>)}
            {update ? <span className="work-line__part work-line__update">{update.text}</span> : null}
          </span>
        ) : null}
      </span>
      <span className={`work-line__thumb work-line__thumb--${shape}`}>
        {work.cover ? <CoverImage className="work-line__cover" image={work.cover} previewWidth={400} label="作品封面" lazy priority={priorityCover} sized={false} fallback={blank} /> : blank}
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
            <span>{lineName}</span>
            <span className="work-line__part">{line.kind}</span>
            {line.figures.map(figure => <span key={figure.metric} className="work-line__part work-line__figure">{figure.label} {figure.value}</span>)}
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

import type { SocialTimelineWork } from "../../contracts/social-timeline.ts";
import { platformNames } from "../lib/home-feed.ts";
import { calendarDay, type CalendarDay } from "../lib/format.ts";
import { workDayMoment, workLines, workMoment } from "../lib/works.ts";
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
export function HomeWorks({ works, timeZone, today = null }: { works: SocialTimelineWork[]; timeZone: string; today?: CalendarDay | null }) {
  if (works.some(work => work.cover)) {
    // The row above names the day; a card repeats it only when the works here fall on different days.
    const days = new Set(works.map(work => { const moment = workMoment(work); const day = moment ? calendarDay(moment, timeZone) : null; return day ? `${day.year}-${day.month}-${day.day}` : "?"; }));
    return (
      <WorkStrip label={works.length > 1 ? `${works.length} 件作品，可左右滚动` : "1 件作品"}>
        {works.map(work => <li key={work.id}>{isBiliCard(work) ? <BiliCard work={work} timeZone={timeZone} today={today} showDay={days.size > 1} /> : <SocialWorkCard work={work} timeZone={timeZone} today={today} small />}</li>)}
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

import type { SocialTimelineWork } from "../../contracts/social-timeline.ts";
import { platformNames, sampleTime } from "../lib/home-feed.ts";
import type { CalendarDay } from "../lib/format.ts";
import { workDayMoment, workLines, workMoment } from "../lib/works.ts";
import { EntryMoment } from "./entry-moment";
import { socialIconPaths } from "./social-icon-paths";

// A word mark fills only a band of its square box; cropped to that band it reads at the same height as the glyphs.
const WORD_MARKS: ReadonlySet<string> = new Set(["xiaohongshu"]);

/**
 * One work on the works page: when, what, where it lives, its two leading figures and the way out.
 * A work on several platforms gets a line for each, with that platform's own figures and address.
 * When a line's figures were read is a hint on hovering them; the day is named the way status
 * entries name a recent day.
 */
export function WorkRow({ work, timeZone, today = null, appended = false }: { work: SocialTimelineWork; timeZone: string; today?: CalendarDay | null; /** Arrived with a later page; it rises in once. */ appended?: boolean }) {
  const day = workDayMoment(work, timeZone, today);
  const moment = workMoment(work);
  return (
    <li className={appended ? "work-row is-appended" : "work-row"}>
      {workLines(work).map((line, index) => {
        const name = platformNames[line.platform];
        const sample = line.observedAt ? sampleTime(line.observedAt, timeZone, today) : null;
        const body = (
          <>
            <span className="work-row__date">{index === 0 && day && moment ? <time dateTime={moment}><EntryMoment moment={day} /></time> : null}</span>
            {/* Said once; a further platform's line leaves the place empty and is read under the same title. */}
            <span className="work-row__title">{index === 0 ? work.title : <span className="visually-hidden">{work.title}</span>}</span>
            <span className="work-row__meta">
              <svg aria-hidden="true" width={WORD_MARKS.has(line.platform) ? 24 : 16} height="16" viewBox={WORD_MARKS.has(line.platform) ? "0 6 24 12" : "0 0 24 24"} fill="currentColor"><path d={socialIconPaths[line.platform]} /></svg>
              <span>{name}</span><span className="work-row__part">{line.kind}</span>
              {line.size ? <span className="work-row__part">{line.size}</span> : null}
              {/* Listed at the moment a change was noticed: said here, so the date is not read as a publication date. */}
              {line.noticed ? <span className="work-row__part">发现更新</span> : null}
            </span>
            <span className="work-row__figures" title={sample ? `数据截至 ${sample.label}` : undefined}>
              {line.figures.length
                ? line.figures.map(figure => <span key={figure.metric}><span className="work-row__label">{figure.label}</span> {figure.value}</span>)
                : <span className="work-row__label">数据未记录</span>}
            </span>
            <span className="work-row__arrow" aria-hidden="true">{line.url ? "↗" : null}</span>
            {line.url ? <span className="visually-hidden">，在{name}打开，原平台可能要求登录</span> : null}
          </>
        );
        const className = index === 0 ? "work-row__line" : "work-row__line work-row__line--more";
        // Only a checked address is a link; the address is used exactly as given.
        return line.url
          ? <a key={line.key} className={className} href={line.url} target="_blank" rel="noopener noreferrer">{body}</a>
          : <div key={line.key} className={className}>{body}</div>;
      })}
    </li>
  );
}

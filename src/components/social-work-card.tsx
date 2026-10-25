import type { SocialTimelineWork } from "../../contracts/social-timeline.ts";
import { collectionAddition, platformNames, sampleTime } from "../lib/home-feed.ts";
import type { CalendarDay } from "../lib/format.ts";
import { coverPreviewWidths, coverShapes, workDayMoment, workLines, type WorkLine } from "../lib/works.ts";
import { CoverImage } from "./cover-image";
import { EntryMoment } from "./entry-moment";
import { figureSignPath, PlatformExitNote, PlatformMark } from "./platform-signs";

/**
 * A line's views and likes. On a cover they carry the platform's signs and their names are still read
 * out; elsewhere the names are written. Hovering tells when they were read and, for a collection, that
 * they are its own totals.
 */
function Figures({ line, signs, hint }: { line: WorkLine; signs: boolean; hint?: string }) {
  if (!line.figures.length) return <span className="work-card__figures work-card__figures--none">数据未记录</span>;
  return (
    <span className="work-card__figures" title={hint}>
      {line.figures.map(figure => {
        const sign = signs ? figureSignPath(figure.metric, line.platform) : null;
        return (
          <span key={figure.metric}>
            {sign
              ? <><svg aria-hidden="true" width="14" height="14" viewBox="0 0 16 16" fill={figure.metric === "views" ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round"><path d={sign} /></svg><span className="visually-hidden">{figure.label}</span></>
              : <span className="work-card__label">{figure.label}</span>}
            {" "}{figure.value}
          </span>
        );
      })}
    </span>
  );
}

/**
 * One work published elsewhere, drawn the way its own platform draws it: a video frame with the
 * figures along its foot, or an upright note with its likes under the title. It keeps to the
 * essentials: the title, where it lives, views and likes, and a change to a collection since the
 * first look. A work without a cover is the same card without the frame; nothing is drawn in a
 * cover's place except among other cards (a strip, the works page), where the place is kept so the
 * cards stay in line.
 *
 * The rules of the figures stand: each platform's own, never summed, an unknown one left out; only a
 * checked address is a link and it is used exactly as given. When the figures were read is only a
 * hint on hovering them; a visitor is not told about the reading schedule. A work on further platforms adds a line for each under the card.
 */
export function SocialWorkCard({ work, timeZone, today = null, small = false }: { work: SocialTimelineWork; timeZone: string;
  /** Today in the site's time zone, for naming a recent day the way status entries do. */
  today?: CalendarDay | null; /** One of many, in a strip or on the works page: narrower, told by its day, its figures on the cover, and a missing cover keeps its place. */ small?: boolean }) {
  const [lead, ...more] = workLines(work);
  const shape = lead ? coverShapes[lead.platform] : "wide";
  const framed = Boolean(work.cover) || small;
  // Only a real cover is dark enough at its foot to carry the figures. A narrow upright card has no room for them under its title.
  const onCover = Boolean(work.cover) && (shape === "wide" || small);
  const update = work.collection ? collectionAddition(work.collection, timeZone) : null;
  const day = small ? workDayMoment(work, timeZone, today) : null;
  const hint = (line: WorkLine, total: boolean) => {
    const sample = line.observedAt ? sampleTime(line.observedAt, timeZone, today) : null;
    return [total ? `整个${line.kind}的合计` : null, sample ? `数据截至 ${sample.label}` : null].filter(Boolean).join(" · ") || undefined;
  };
  const what = lead ? [lead.kind, lead.size].filter(Boolean) : [];
  const blank = <span className="work-card__blank">{lead ? <PlatformMark platform={lead.platform} size={22} /> : null}<span className="visually-hidden">封面未记录</span></span>;
  const main = (
    <>
      <span className="work-card__body">
        <span className="work-card__title">{work.title}</span>
        {lead ? (
          <span className="work-card__foot">
            <span className="work-card__where">
              <PlatformMark platform={lead.platform} />
              {/* Among other cards nothing above tells this one's time, so it tells its own day. */}
              <span>{day ? <EntryMoment moment={day} /> : platformNames[lead.platform]}</span>
              {framed && shape === "wide" || small ? null : what.map(part => <span key={part} className="work-card__part">{part}</span>)}
            </span>
            {onCover ? null : <Figures line={lead} signs={framed} hint={hint(lead, Boolean(work.collection))} />}
          </span>
        ) : null}
        {update ? <span className="work-card__update"><span>{update.text}</span>{update.note ? <span className="work-card__part">{update.note}</span> : null}</span> : null}
      </span>
      {framed ? (
        <span className="work-card__frame">
          {/* A cover that cannot be read gives way to the same quiet place as no cover; the frame crops it, so its own size is not passed on. */}
          {work.cover ? <CoverImage className="work-card__cover" image={work.cover} previewWidth={coverPreviewWidths[shape]} label="作品封面" lazy sized={false} fallback={blank} /> : blank}
          {shape === "wide" && what.length ? <span className="work-card__badge">{what.join(" · ")}</span> : null}
          {onCover && lead ? <span className="work-card__over"><Figures line={lead} signs hint={hint(lead, Boolean(work.collection))} /></span> : null}
        </span>
      ) : null}
      {lead?.url ? <><span className="work-card__arrow" aria-hidden="true">↗</span><PlatformExitNote name={platformNames[lead.platform]} /></> : null}
    </>
  );
  return (
    <div className={`card work-card work-card--${shape} ${framed ? "work-card--framed" : "work-card--plain"}${small ? " work-card--small" : ""}`}>
      {lead?.url
        ? <a className="work-card__main" href={lead.url} target="_blank" rel="noopener noreferrer" {...(lead.opensLatest ? { title: "打开最新一集" } : {})}>{main}</a>
        : <div className="work-card__main">{main}</div>}
      {more.map(line => {
        const name = platformNames[line.platform];
        const body = (
          <>
            <span className="work-card__where">
              <span className="visually-hidden">{work.title}，</span>
              <PlatformMark platform={line.platform} />
              <span>{name}</span><span className="work-card__part">{line.kind}</span>
            </span>
            <Figures line={line} signs={false} hint={hint(line, false)} />
            {line.url ? <><span className="work-card__arrow" aria-hidden="true">↗</span><PlatformExitNote name={name} /></> : null}
          </>
        );
        return line.url
          ? <a key={line.key} className="work-card__more" href={line.url} target="_blank" rel="noopener noreferrer">{body}</a>
          : <div key={line.key} className="work-card__more">{body}</div>;
      })}
    </div>
  );
}

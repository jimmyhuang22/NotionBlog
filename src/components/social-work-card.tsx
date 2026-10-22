import type { SocialPlatform } from "../../contracts/social.ts";
import type { SocialTimelineWork } from "../../contracts/social-timeline.ts";
import { collectionAddition, platformNames, sampleTime, type Figure } from "../lib/home-feed.ts";
import type { CalendarDay } from "../lib/format.ts";
import { coverPreviewWidths, coverShapes, workDayMoment, workLines, type WorkLine } from "../lib/works.ts";
import { CoverImage } from "./cover-image";
import { EntryMoment } from "./entry-moment";
import { socialIconPaths } from "./social-icon-paths";

// A word mark fills only a band of its square box; cropped to that band it reads at the same height as the glyphs.
const WORD_MARKS: ReadonlySet<string> = new Set(["xiaohongshu"]);

function PlatformMark({ platform, size = 16 }: { platform: SocialPlatform; size?: number }) {
  const word = WORD_MARKS.has(platform);
  return <svg aria-hidden="true" width={word ? size * 1.5 : size} height={size} viewBox={word ? "0 6 24 12" : "0 0 24 24"} fill="currentColor"><path d={socialIconPaths[platform]} /></svg>;
}

/** The signs the platforms put beside these two figures: a play mark, a thumb on one, a heart on the other. */
const FIGURE_SIGNS: Partial<Record<Figure["metric"], Record<SocialPlatform, string>>> = {
  views: { bilibili: "M4.5 2.6v10.8L13 8z", xiaohongshu: "M4.5 2.6v10.8L13 8z" },
  likes: {
    bilibili: "M5.2 7.1 7.7 2.2c1 0 1.8.8 1.8 1.8v2.3h2.9c.9 0 1.5.8 1.3 1.6l-.9 4.2c-.2.8-.8 1.3-1.6 1.3H5.2zm0 0H3.1c-.4 0-.7.3-.7.7v4.9c0 .4.3.7.7.7h2.1",
    xiaohongshu: "M8 13.4S2.2 10 2.2 5.9A3 3 0 0 1 8 4.7a3 3 0 0 1 5.8 1.2C13.8 10 8 13.4 8 13.4z",
  },
};

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
        const sign = signs ? FIGURE_SIGNS[figure.metric]?.[line.platform] : undefined;
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
  const late = (line: WorkLine) => {
    const sample = line.observedAt ? sampleTime(line.observedAt, timeZone, today) : null;
    return { sample };
  };
  const hint = (line: WorkLine, total: boolean) => {
    const { sample } = late(line);
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
      {lead?.url ? <><span className="work-card__arrow" aria-hidden="true">↗</span><span className="visually-hidden">，在{platformNames[lead.platform]}打开，原平台可能要求登录</span></> : null}
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
            {line.url ? <><span className="work-card__arrow" aria-hidden="true">↗</span><span className="visually-hidden">，在{name}打开，原平台可能要求登录</span></> : null}
          </>
        );
        return line.url
          ? <a key={line.key} className="work-card__more" href={line.url} target="_blank" rel="noopener noreferrer">{body}</a>
          : <div key={line.key} className="work-card__more">{body}</div>;
      })}
    </div>
  );
}

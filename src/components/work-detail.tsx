import Link from "next/link";
import type { ReactNode } from "react";
import type { Book, ContentDocument, DateRange, Game, Movie, Rating, TimeAmount } from "../../contracts/content.ts";
import { imagePreviewSrc } from "../lib/content/image-preview.ts";
import { dateParts, rangeLabel, ratingLabel } from "../lib/format.ts";
import { cardTimeLabel, knownStatusLabel, libraryHref, movieRatingFact, platformChips, progressWidth, ratingDots, statusLabel, workFactText, workSentence, type LibraryItem } from "../lib/library.ts";
import { gameDateRows } from "../lib/game-dates.ts";
import { bookRecord, gameRecord, movieRecord } from "../lib/work-record.ts";
import { Cover } from "./library-grid";
import { RichDocumentBody } from "./rich-document";
import { PlatformChips } from "./platform-chips";

/** What the owner calls the write-up for each kind, in the line that says there is none. */
const recordWords: Record<LibraryItem["kind"], string> = { movie: "观后感", book: "读后感", game: "游玩记录" };

/** The owner's rating: ink dots when they can be drawn, the source's value beside them always. */
export function RatingValue({ rating }: { rating: Rating | null }) {
  const dots = ratingDots(rating);
  return (
    <dd className="work__rating">
      {dots ? <span className="work__dots" aria-hidden="true">{Array.from({ length: dots.total }, (_, index) => <i key={index} className={index < dots.filled ? "is-on" : undefined} />)}</span> : null}
      {ratingLabel(rating, "未评分")}
    </dd>
  );
}

/** The record below the facts, or one quiet line when there is none; shared by every kind. */
export function WorkRecord({ item, document }: { item: LibraryItem; document: ContentDocument | null }) {
  // Many works are a record without a write-up: no body means no empty reading card.
  if (document && (document.blocks.length > 0 || document.completeness === "partial")) return <article className="reading__article card" aria-label="我的记录"><RichDocumentBody document={document} imagePreviewWidth={800} /></article>;
  // Where a write-up would be, a quiet slip says there is none yet (W-05, 2026-10-20); a wish has nothing to write.
  // A body that was not loaded (null, unlike an empty one) is not "none yet": the slip says it did not load.
  if (item.status === "wishlist") return null;
  if (document === null) return <p className="work__record-empty">{recordWords[item.kind]}暂时没有加载，稍后刷新再试。</p>;
  return <p className="work__record-empty">还没有写下{recordWords[item.kind]}。</p>;
}

/** When the owner saw it: one day in a sentence, several as a short list of days (oldest first). */
function Seen({ item, viewings, timeZone }: { item: Movie; viewings: Movie["watchedDate"][]; timeZone: string }) {
  const days = viewings.map(range => rangeLabel(range, timeZone)).filter((label): label is string => !!label);
  const verb = knownStatusLabel(item);
  if (item.status === "wishlist" || days.length < 2) return <p className="work-film__seen">{workSentence(item, days[0] ?? null)}</p>;
  return (
    <div className="work-film__seen">
      <p>{verb ? `${verb} ${days.length} 次` : "状态未记录"}</p>
      <ul>{days.map(label => <li key={label}>{label}</li>)}</ul>
    </div>
  );
}

/**
 * A film (the owner's pick 甲 of 2026-11-19, "海报幕布", after Letterboxd and TMDB): the poster blurred into a dark
 * band across the page with the title on it, the poster itself standing over the band's edge, and beside the
 * write-up a column of what the owner made of it. The Notion template is read into its parts (work-record.ts).
 */
export function FilmPage({ type, label, item, document, timeZone, neighbours }: { type: string; label: string; item: Movie; document: ContentDocument | null; timeZone: string; neighbours: ReactNode }) {
  const record = movieRecord(document, item.watchedDate);
  const released = rangeLabel(item.releaseDate, timeZone);
  const meta = [item.mediaType, item.director ? workFactText("导演", item.director, "movie") : null, item.actors.length ? workFactText("主演", item.actors.join("、"), "movie") : null, released ? workFactText("上映", released, "movie") : null]
    .filter((part): part is string => !!part).join(" · ");
  const publicRating = movieRatingFact(item);
  const band = item.cover ? { "--band": `url("${imagePreviewSrc(item.cover, 400)}")` } as React.CSSProperties : undefined;
  return (
    <>
      <div className={`work-band${item.cover ? "" : " work-band--plain"}`} style={band}>
        <div className="wrap work-band__in">
          <nav className="crumbs" aria-label="面包屑">
            <Link href={libraryHref(type, null, null)}>{label}</Link><span aria-hidden="true">›</span><span aria-current="page">{item.title}</span>
          </nav>
          <div className="work-band__text">
            <h1 className="work-band__title">{item.title}</h1>
            {item.originalTitle && item.originalTitle !== item.title ? <p className="work-band__original">{item.originalTitle}</p> : null}
            {meta ? <p className="work-band__meta">{meta}</p> : null}
          </div>
        </div>
      </div>
      <div className="wrap">
        <div className="work-film">
          <aside className="work-film__side">
            <div className="work-film__poster work__cover"><Cover image={item.cover} title={item.title} previewWidth={800} /></div>
            {/* On phones the band is too narrow for this line; it follows the poster instead. */}
            {meta ? <p className="work-film__meta" aria-hidden="true">{meta}</p> : null}
            <dl className="work-film__mine">
              <div><dt className="visually-hidden">我的评分</dt><RatingValue rating={item.rating} /></div>
              <div><dt className="visually-hidden">看过的日期</dt><dd><Seen item={item} viewings={record.viewings} timeZone={timeZone} /></dd></div>
              {publicRating ? <div className="work-film__fact"><dt>{publicRating[0]}</dt><dd>{publicRating[1]}</dd></div> : null}
            </dl>
          </aside>
          <div className="work-film__main">
            {item.tags.length ? <p className="reading__tags">{item.tags.map(tag => <span key={tag} className="tag">{tag}</span>)}</p> : null}
            <WorkRecord item={item} document={record.document} />
            {neighbours}
          </div>
        </div>
      </div>
    </>
  );
}


/** Days from the first to the last, both counted; null when either side cannot be read as a day. */
function daysBetween(start: string, end: string, precision: DateRange["precision"], timeZone: string): number | null {
  const a = dateParts(start, precision, timeZone), b = dateParts(end, precision, timeZone);
  if (!a || !b) return null;
  const days = Math.round((Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / 86400000) + 1;
  return days > 0 ? days : null;
}

/**
 * The reading as one line from where it began to where it ended (after StoryGraph): a finished book has both ends and
 * the days between; a book being read has an open end at the pages reached, and the line is filled that far.
 * Anything less is one plain sentence, written as the rest of the site writes it ("已读，日期未记录").
 */
function Journey({ item, timeZone }: { item: Book; timeZone: string }) {
  const range = item.readingDate;
  const start = range ? rangeLabel({ ...range, end: null }, timeZone) : null;
  const end = range?.end ? rangeLabel({ start: range.end, end: null, precision: range.precision }, timeZone) : null;
  if (item.status === "reading") {
    const pages = item.pagesRead !== null && item.totalPages !== null ? `${item.pagesRead} / ${item.totalPages} 页` : null;
    const width = progressWidth(item.progressPercent);
    return (
      <div className="journey journey--open">
        <div><small>开始读</small><b>{start ?? "日期未记录"}</b></div>
        <div className="journey__track" style={{ "--progress": width ?? "0%" } as React.CSSProperties}>{width ? <em>{item.progressPercent}%</em> : null}</div>
        <div className="journey__end"><small>读到</small><b>{pages ?? (width ? `${item.progressPercent}%` : "进度未记录")}</b></div>
      </div>
    );
  }
  const days = range?.end && start && end && end !== start ? daysBetween(range.start, range.end, range.precision, timeZone) : null;
  if (item.status === "read" && start && end && days) {
    return (
      <div className="journey">
        <div><small>开始读</small><b>{start}</b></div>
        <div className="journey__track"><em>{days} 天</em></div>
        <div className="journey__end"><small>读完</small><b>{end}</b></div>
      </div>
    );
  }
  return <div className="journey journey--one"><b>{workSentence(item, rangeLabel(range, timeZone))}</b></div>;
}

const outside = (url: string) => { try { return new URL(url).hostname.endsWith("douban.com") ? "豆瓣条目" : "外部条目"; } catch { return "外部条目"; } };

/**
 * A book (the owner's pick 乙 of 2026-11-19, "书架与阅读历程", after Goodreads and StoryGraph): no band; the book
 * stands in a left column with what is known about it, and beside it the title, the reading as one line, the
 * excerpts as slips (they are most of a book's record) and whatever else the owner wrote. No book carries the owner's
 * own rating yet, so it is one quiet row that says so rather than a headline.
 */
export function BookPage({ type, label, item, document, timeZone, neighbours }: { type: string; label: string; item: Book; document: ContentDocument | null; timeZone: string; neighbours: ReactNode }) {
  const record = bookRecord(document);
  return (
    <div className="wrap">
      <nav className="crumbs" aria-label="面包屑">
        <Link href={libraryHref(type, null, null)}>{label}</Link><span aria-hidden="true">›</span><span aria-current="page">{item.title}</span>
      </nav>
      <div className="work-book">
        <aside className="work-book__side">
          <div className="work-book__cover work__cover"><Cover image={item.cover} title={item.title} previewWidth={800} /></div>
          <dl className="work-book__facts">
            <div><dt className="visually-hidden">状态</dt><dd><span className={`work-book__state work-book__state--${item.status}`}>{statusLabel(item)}</span></dd></div>
            {item.totalPages !== null && item.status !== "reading" ? <div className="work-book__row"><dt>页数</dt><dd>{item.totalPages} 页</dd></div> : null}
            {item.doubanRating !== null ? <div className="work-book__row"><dt>豆瓣评分</dt><dd>{item.doubanRating.toFixed(1)}</dd></div> : null}
            <div className="work-book__row"><dt>我的评分</dt><RatingValue rating={item.personalRating} /></div>
            {item.externalUrl ? <div className="work-book__row"><dt>{outside(item.externalUrl)}</dt><dd><a className="rt-link" href={item.externalUrl} target="_blank" rel="noopener noreferrer">打开 ↗</a></dd></div> : null}
          </dl>
        </aside>
        <div className="work-book__main">
          <h1 className="work-book__title">{item.title}</h1>
          {item.authors.length ? <p className="work-book__by">{item.authors.join("、")} 著</p> : null}
          {item.tags.length ? <p className="reading__tags">{item.tags.map(tag => <span key={tag} className="tag">{tag}</span>)}</p> : null}
          <Journey item={item} timeZone={timeZone} />
          {record.excerpts ? (
            <section className="work-excerpts" aria-label="摘录">
              <h2 className="work-excerpts__title">摘录{record.excerptCount ? <small>{record.excerptCount} 条</small> : null}</h2>
              <RichDocumentBody document={record.excerpts} imagePreviewWidth={800} topHeading={3} />
            </section>
          ) : null}
          <WorkRecord item={item} document={record.rest} />
          {neighbours}
        </div>
      </div>
    </div>
  );
}

const hours = (amount: TimeAmount | null) => amount && amount.value > 0 ? (amount.unit === "hour" ? amount.value : amount.value / 60) : null;

/**
 * Played against expected, as two bars on one scale, only when both are known (23 of the first 50 games have an
 * estimate). The longer of the two fills its bar; a game played past its estimate shows it at a glance.
 */
function TimeBars({ item }: { item: Game }) {
  const played = hours(item.playedTime), expected = hours(item.estimatedTime);
  const playedLabel = cardTimeLabel(item.playedTime), expectedLabel = cardTimeLabel(item.estimatedTime);
  if (!played || !expected || !playedLabel || !expectedLabel) return null;
  const scale = Math.max(played, expected);
  const bar = (label: string, value: number, text: string, className: string) => (
    <div className={`game-time__bar ${className}`}><span>{label}</span><i style={{ "--share": `${Math.round((value / scale) * 1000) / 10}%` } as React.CSSProperties} aria-hidden="true" /><span>{text}</span></div>
  );
  return <div className="game-time__bars">{bar("已玩", played, playedLabel, "game-time__bar--played")}{bar("预计", expected, expectedLabel, "game-time__bar--expected")}</div>;
}

/**
 * The game's days in the order they happened: its release, then what the platforms report and the date the owner
 * wrote (the rows and their rules are gameDateRows', the owner's of 2026-10-16). The owner's own date has a filled
 * dot. A row without a date keeps its place at the end and says so.
 */
function GameTimeline({ item, timeZone }: { item: Game; timeZone: string }) {
  const rows: { label: string; range: DateRange | null; own: boolean }[] = gameDateRows(item, timeZone).map(([label, range]) => ({ label, range, own: label === "体验日期" || label === "游玩日期" }));
  if (item.releaseDate) rows.push({ label: "发售", range: item.releaseDate, own: false });
  // On the same day the release comes first: a game is played on its release day, not before it.
  const known = rows.filter(row => row.range && rangeLabel(row.range, timeZone)).sort((a, b) => a.range!.start.slice(0, 10).localeCompare(b.range!.start.slice(0, 10)) || Number(b.label === "发售") - Number(a.label === "发售"));
  const unknown = rows.filter(row => !row.range || !rangeLabel(row.range, timeZone));
  return (
    <ol className="game-timeline">
      {[...known, ...unknown].map(row => (
        <li key={row.label} className={row.own ? "game-timeline__own" : undefined}><b>{row.label}</b><span>{(row.range && rangeLabel(row.range, timeZone)) ?? "日期未记录"}</span></li>
      ))}
    </ol>
  );
}

/**
 * A game (the owner's pick 乙 of 2026-11-19, "全幅主视觉", after the PlayStation Store and Apple TV): every game's
 * cover is wide key art, so it runs the width of the page unblurred and fades into the paper; the title and the
 * platforms stand on it. Below, as on a film's page, a side column holds the status, the owner's rating, the time
 * played (against the estimate when there is one) and the days in order, and the write-up runs beside it. Most
 * recent games have no write-up, so the column alone carries the page.
 */
export function GamePage({ type, label, item, document, timeZone, neighbours }: { type: string; label: string; item: Game; document: ContentDocument | null; timeZone: string; neighbours: ReactNode }) {
  const record = gameRecord(document);
  const played = cardTimeLabel(item.playedTime);
  const expected = cardTimeLabel(item.estimatedTime);
  const art = item.cover ? { "--art": `url("${imagePreviewSrc(item.cover, 1600)}")` } as React.CSSProperties : undefined;
  const chips = platformChips(item.platforms);
  return (
    <>
      <div className={`game-band${item.cover ? "" : " game-band--plain"}`} style={art}>
        <div className="wrap game-band__in">
          <nav className="crumbs" aria-label="面包屑">
            <Link href={libraryHref(type, null, null)}>{label}</Link><span aria-hidden="true">›</span><span aria-current="page">{item.title}</span>
          </nav>
          <div className="game-band__text">
            <h1 className="game-band__title">{item.title}</h1>
            {chips.length ? <p className="game-band__platforms"><span className="visually-hidden">平台：</span><PlatformChips chips={chips} /></p> : null}
          </div>
        </div>
      </div>
      <div className="wrap">
        <div className="work-game">
          <aside className="work-game__side">
            <dl className="work-game__facts">
              <div className="work-game__group">
                <dt className="visually-hidden">状态</dt><dd><span className={`work-game__state work-game__state--${item.status}`}>{statusLabel(item)}</span></dd>
                {/* Fewer than half the games carry the owner's rating; without one it is a quiet line, not a large empty score. */}
                <dt className="visually-hidden">我的评分</dt>{item.rating ? <RatingValue rating={item.rating} /> : <dd className="work-game__unrated">未评分</dd>}
              </div>
              {/* A game not yet played has no time to tell. */}
              {item.status === "wishlist" && !played ? null : <div className="work-game__group game-time">
                <dt className="visually-hidden">已玩时长</dt>
                <dd className="game-time__played">{played ?? "时长未记录"}</dd>
                <dd className="game-time__note">{played ? "已玩" : ""}{expected ? `${played ? "，" : ""}预计 ${expected}` : ""}</dd>
                <dd><TimeBars item={item} /></dd>
              </div>}
              <div className="work-game__group work-game__dates"><dt className="visually-hidden">日期</dt><dd><GameTimeline item={item} timeZone={timeZone} /></dd></div>
            </dl>
          </aside>
          <div className="work-game__main">
            {item.tags.length ? <p className="reading__tags">{item.tags.map(tag => <span key={tag} className="tag">{tag}</span>)}</p> : null}
            <WorkRecord item={item} document={record} />
            {neighbours}
          </div>
        </div>
      </div>
    </>
  );
}

import Link from "next/link";
import type { ReactNode } from "react";
import type { Book, ContentDocument, DateRange, Game, GamePlayVideo, Movie, Rating } from "../../contracts/content.ts";
import { gameDetailArtwork, imagePreviewSrc } from "../lib/content/image-preview.ts";
import { dateParts, rangeLabel, ratingLabel } from "../lib/format.ts";
import { cardTimeLabel, knownStatusLabel, libraryHref, movieRatingFact, platformChips, progressWidth, ratingDots, statusLabel, workFactText, workSentence, type LibraryItem } from "../lib/library.ts";
import { dateStripNotes, gameDateRows, platformDay, stripDate } from "../lib/game-dates.ts";
import { bookRecord, excerptsHeld, gameNotes, movieRecord } from "../lib/work-record.ts";
import { Cover } from "./library-grid";
import { RichDocumentBody } from "./rich-document";
import { PlatformChips } from "./platform-chips";
import { ExcerptFold } from "./excerpt-fold";
import { GamePanel } from "./game-panel";
import { GameIntro } from "./game-intro";
import { WorksCard } from "./works-card";
import { PlatformMark } from "./platform-signs";
import { PlatinumCup, TrophyPlatform } from "./trophy-marks";
import { earnedWithin, gradeLabel, gradeOrder, setPercent, setPlatinum, trophyAnchors, type TrophySet } from "../lib/game-trophies.ts";

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
export function WorkRecord({ item, document, quiet = false, bare = false }: { item: LibraryItem; document: ContentDocument | null; quiet?: boolean; bare?: boolean }) {
  // Many works are a record without a write-up: no body means no empty reading card. A game's sits in a card of its own (`bare`).
  if (document && (document.blocks.length > 0 || document.completeness === "partial")) return <article className={bare ? "reading__article" : "reading__article card"} aria-label="我的记录"><RichDocumentBody document={document} imagePreviewWidth={800} /></article>;
  // Where a write-up would be, a quiet slip says there is none yet (W-05, 2026-10-20); a wish has nothing to write.
  // A body that was not loaded (null, unlike an empty one) is not "none yet": the slip says it did not load.
  if (item.status === "wishlist") return null;
  if (document === null) return <p className="work__record-empty">{recordWords[item.kind]}暂时没有加载，稍后刷新再试。</p>;
  // A game whose trophy section shows already has something under its facts: "none yet" shows only when both are
  // missing (2026-11-20). The side summary alone does not count: the column beside it would be left empty.
  if (quiet) return null;
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
            {record.episodes.length ? (
              <section className="work-episodes" aria-label="分集摘录">
                <h2 className="work-episodes__title">分集摘录<small>{record.episodes.length} 集</small></h2>
                <ol className="work-episodes__list">
                  {record.episodes.map(episode => (
                    <li key={episode.number}><b>第 {episode.number} 集{episode.name ? <small>{episode.name}</small> : null}</b><span>{episode.text}</span></li>
                  ))}
                </ol>
              </section>
            ) : null}
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
              <ExcerptFold count={record.excerptCount} held={excerptsHeld(record.excerptCount)}><RichDocumentBody document={record.excerpts} imagePreviewWidth={800} topHeading={3} /></ExcerptFold>
            </section>
          ) : null}
          <WorkRecord item={item} document={record.rest} />
          {neighbours}
        </div>
      </div>
    </div>
  );
}

/**
 * The game's days in the order they happened: its release, then what the platforms report and the date the owner
 * wrote (the rows and their rules are gameDateRows', the owner's of 2026-10-16). The owner's own date has a filled
 * dot. A row without a date keeps its place at the end and says so.
 */
function timelineRows(item: Game, timeZone: string) {
  const rows: { label: string; range: DateRange | null; own: boolean }[] = gameDateRows(item, timeZone).map(([label, range]) => ({ label, range, own: label === "体验日期" || label === "游玩日期" }));
  if (item.releaseDate) rows.push({ label: "发售", range: item.releaseDate, own: false });
  // On the same day the release comes first: a game is played on its release day, not before it.
  const known = rows.filter(row => row.range && rangeLabel(row.range, timeZone)).sort((a, b) => a.range!.start.slice(0, 10).localeCompare(b.range!.start.slice(0, 10)) || Number(b.label === "发售") - Number(a.label === "发售"));
  // A game only wished for has not been played: no "日期未记录" row for its play (2026-11-19, narrowing 10-16's rule).
  const unknown = item.status === "wishlist" ? [] : rows.filter(row => !row.range || !rangeLabel(row.range, timeZone));
  return [...known, ...unknown];
}

/**
 * The days in a card of their own at the top of the main column (2026-11-21; in a card since 2026-11-24). Between two
 * dates, how long it was; under a range, how many days it ran. Each date stands centred under its dot on one line from
 * the first to the last (丙, 2026-11-24: the card has no title of its own, the line is its head), and leads with its
 * year in large type and the day under it (乙 of 2026-11-22), so the strip reads year to year; a year the date before
 * already showed is quieter. When every date falls in one year the year is written once above the line and the days
 * take the large type (甲, 2026-11-23). The owner's own dates can carry how many trophies came within them
 * (`ownNote`), said here rather than again in the trophy tab. A narrow card stands the strip upright.
 */
function GameDates({ item, timeZone, ownNote = null }: { item: Game; timeZone: string; ownNote?: string | null }) {
  const rows = timelineRows(item, timeZone);
  if (!rows.length) return null;
  const notes = dateStripNotes(rows.map(row => row.range), timeZone);
  const dates = rows.map(row => row.range ? stripDate(row.range, timeZone) : null);
  const known = dates.filter(date => date !== null);
  const oneYear = known.length > 1 && known.every(date => date.first === known[0]!.first && date.last === known[0]!.first) ? known[0]!.first : null;
  let shownYear: number | null = null;
  return (
    <section className="card game-card game-card--dates" aria-label="时间线">
      {oneYear ? <p className="game-dates__one-year" aria-hidden="true">{oneYear} 年</p> : null}
      <ol className={`game-dates${oneYear ? " game-dates--one-year" : ""}`} aria-label={oneYear ? `${oneYear} 年的日期` : "日期"} style={{ "--steps": rows.length } as React.CSSProperties}>
        {rows.map((row, index) => {
          const date = dates[index];
          const again = !!date && date.first === shownYear;
          if (date) shownYear = date.last;
          const small = [notes[index]!.length, row.own ? ownNote : null].filter(Boolean).join(" · ");
          return (
            <li key={row.label} className={row.own ? "game-dates__own" : undefined}>
              <b>{row.label}</b>
              {date ? (
                <span className="game-dates__when">
                  {oneYear ? null : <strong className={`game-dates__year${again ? " game-dates__year--again" : ""}${date.first !== date.last ? " game-dates__year--span" : ""}`}>{date.year.replace(" – ", " – ")}<span className="visually-hidden"> 年</span></strong>}
                  <span className="game-dates__days">{date.days.map((piece, at) => <span key={at}>{at ? " " : null}<span className="game-dates__piece">{piece}</span></span>)}</span>
                </span>
              ) : <span className="game-dates__none">日期未记录</span>}
              {small ? <small>{small}</small> : null}
              {notes[index]!.gap ? <em>{notes[index]!.gap}</em> : null}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/**
 * The trophies in the record card (2026-11-20; in the card since 2026-11-24). Several platforms keep a row each, never
 * added together (甲, 2026-11-22): the outline and name, the bars starting on one line and the counts at one edge; a set
 * with its platinum has a platinum bar and says "白金", one with nothing earned is quiet. One set has a ring with its
 * share instead (a ring says one platform; with several it could only speak for one), its platform and the count
 * beside it, and the grades under it when the platform has grades. A set whose list the page has links to it in the
 * trophy tab ("#trophies-ps5"). No sets, nothing: a Nintendo game has none.
 */
function TrophySummary({ sets, anchors }: { sets: TrophySet[]; anchors: string[] }) {
  if (!sets.length) return null;
  const listed = (set: TrophySet) => !!set.trophies?.length;
  if (sets.length > 1) {
    return (
      <div className="game-record__trophies">
        <h3 className="game-record__sub">奖杯</h3>
        <ul className="game-trophy-sum__sets">
          {sets.map((set, index) => {
            const platinum = setPlatinum(set);
            const row = (
              <>
                <TrophyPlatform platform={set.platform} /><i style={{ "--share": `${setPercent(set)}%` } as React.CSSProperties} aria-hidden="true" />
                <span className="game-trophy-sum__n">
                  {platinum ? <PlatinumCup className="game-trophy-sum__cup" /> : null}
                  {platinum && set.earned === set.total ? <>白金<span className="visually-hidden">，{set.earned} / {set.total}</span></> : <><b>{set.earned}</b> / {set.total}</>}
                </span>
              </>
            );
            return (
              <li key={set.id} className={platinum ? "game-trophy-sum__set--platinum" : set.earned === 0 ? "game-trophy-sum__set--none" : undefined}>
                {listed(set) ? <a className="game-trophy-sum__row" href={`#${anchors[index]}`}>{row}</a> : <span className="game-trophy-sum__row">{row}</span>}
              </li>
            );
          })}
        </ul>
      </div>
    );
  }
  const [set] = sets as [TrophySet];
  const platinum = setPlatinum(set);
  const share = setPercent(set);
  const ring = (
    <span className={`game-trophy-ring${platinum ? " game-trophy-ring--platinum" : ""}`} style={{ "--share": `${share}%` } as React.CSSProperties}>
      <span>{platinum ? <><PlatinumCup className="game-trophy-ring__cup" />白金</> : <>{share}%</>}<span className="visually-hidden">，完成 {share}%</span></span>
    </span>
  );
  return (
    <div className="game-record__trophies">
      <h3 className="game-record__sub">奖杯</h3>
      <div className="game-trophy-one">
        {listed(set) ? <a href="#trophies" className="game-trophy-one__ring" aria-label={`看${set.platform}的奖杯`}>{ring}</a> : <span className="game-trophy-one__ring">{ring}</span>}
        <div>
          <p className="game-trophy-one__platform"><TrophyPlatform platform={set.platform} /></p>
          <p className="game-trophy-one__count"><b>{set.earned}</b> / {set.total} 个</p>
        </div>
      </div>
      {set.grades ? <p className="game-trophy-sum__grades">{gradeOrder.map(grade => <span key={grade} className={`game-trophy__grade game-trophy__grade--${grade}`}><span>{gradeLabel[grade]} {set.grades![grade].earned}<small>/{set.grades![grade].total}</small></span></span>)}</p> : null}
    </div>
  );
}

/**
 * The owner's recording of the game, at the foot of the record column (2026-11-24): its cover is usually the game's own
 * art, so it sits low rather than echo the art at the top. A recording that is one of the owner's published works is
 * drawn as on the works page; any other address the owner gave is a plain way out to Bilibili.
 */
function GameVideo({ video, timeZone }: { video: GamePlayVideo | null; timeZone: string }) {
  if (!video) return null;
  const shown = video.url.replace(/^https?:\/\/(www\.)?/u, "").replace(/\/$/u, "");
  return (
    <section className="card game-card game-video" aria-labelledby="game-video-title">
      <h2 id="game-video-title" className="game-card__title">游玩录像</h2>
      {video.work ? <WorksCard work={video.work} timeZone={timeZone} withYear /> : (
        <a className="game-video__link" href={video.url} target="_blank" rel="noopener noreferrer">
          <PlatformMark platform="bilibili" size={22} square />
          <span><b>B 站视频</b><small>{shown}</small></span>
        </a>
      )}
    </section>
  );
}

/**
 * A game (the owner's pick 乙 of 2026-11-19, "全幅主视觉", after the PlayStation Store and Apple TV): every game's
 * cover is wide key art, so it runs the width of the page unblurred and fades into the paper; the title and the
 * platforms stand on it, and the game's story in two lines when the owner wrote one. Below it, cards (甲,
 * 2026-11-24): on the left, the owner's record (the status, the rating, the time played and the trophies), what the
 * game is (who made and published it, its kinds) and the owner's recording, staying in view; on the right, the days,
 * then the write-up and the trophies in one card behind a switch. On a phone one column: the record, the days, the
 * write-up and trophies, what the game is, the recording. There is no estimate of how long a game takes: the owner
 * does not keep one (2026-11-23).
 */
export function GamePage({ type, label, item, document, timeZone, neighbours, trophySets = [] }: { type: string; label: string; item: Game; document: ContentDocument | null; timeZone: string; neighbours: ReactNode; trophySets?: TrophySet[] }) {
  const notes = gameNotes(document, { video: !!item.playVideo });
  const about = item.about ?? null;
  const developers = about?.developers ?? [], publishers = about?.publishers ?? [];
  // With one full set whose dated trophies all came within the owner's own dates, the strip says how many under those
  // dates and the trophy tab does not repeat the days (甲, 2026-11-23).
  const full = trophySets.filter(set => set.trophies?.length);
  const own = item.playedDate ? platformDay(item.playedDate, timeZone) : null;
  const within = full.length === 1 && own ? earnedWithin(full[0]!.trophies!, own.start, own.end ?? own.start) : null;
  const anchors = trophyAnchors(trophySets);
  const played = cardTimeLabel(item.playedTime);
  const artwork = item.cover ? gameDetailArtwork(item.cover) : null;
  const art = artwork ? {
    "--art": `url("${artwork.standard}")`,
    ...(artwork.desktop ? { "--art-desktop": `url("${artwork.desktop}")` } : {}),
  } as React.CSSProperties : undefined;
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
            {about?.summary ? <GameIntro text={about.summary} /> : null}
          </div>
        </div>
      </div>
      <div className="wrap">
        <div className="work-game">
          <div className="work-game__side">
            <section className="card game-card game-record" aria-labelledby="game-record-title">
              <h2 id="game-record-title" className="game-card__title">我的游玩</h2>
              <dl className="game-record__facts">
                <div className="game-record__state">
                  <dt className="visually-hidden">状态</dt><dd><span className={`work-game__state work-game__state--${item.status}`}>{statusLabel(item)}</span></dd>
                  {/* Fewer than half the games carry the owner's rating; without one it is a quiet word, not a large empty score. */}
                  <dt className="visually-hidden">我的评分</dt>{item.rating ? <RatingValue rating={item.rating} /> : <dd className="work-game__unrated">未评分</dd>}
                </div>
                {/* A game not yet played has no time to tell. */}
                {item.status === "wishlist" && !played ? null : (
                  <div className="game-record__time">
                    <dt className="visually-hidden">已玩时长</dt>
                    <dd>{played ? <><b>{played}</b><small>已玩</small></> : <span className="game-record__none">时长未记录</span>}</dd>
                  </div>
                )}
              </dl>
              <TrophySummary sets={trophySets} anchors={anchors} />
            </section>
            {/* What the game is: who made and published it (as the owner verified them) and its kinds; a row only for what is known. */}
            {developers.length || publishers.length || item.tags.length ? (
              <section className="card game-card game-about" aria-labelledby="game-about-title">
                <h2 id="game-about-title" className="game-card__title">关于</h2>
                <dl className="game-about__facts">
                  {developers.length ? <><dt>开发</dt><dd>{developers.join("、")}</dd></> : null}
                  {publishers.length ? <><dt>发行</dt><dd>{publishers.join("、")}</dd></> : null}
                  {item.tags.length ? <><dt>类型</dt><dd className="reading__tags">{item.tags.map(tag => <span key={tag} className="tag">{tag}</span>)}</dd></> : null}
                </dl>
              </section>
            ) : null}
            <GameVideo video={item.playVideo ?? null} timeZone={timeZone} />
          </div>
          <div className="work-game__main">
            <GameDates item={item} timeZone={timeZone} ownNote={within ? `拿到 ${within} 个奖杯` : null} />
            <GamePanel notes={WorkRecord({ item, document: notes, quiet: full.length > 0, bare: true })} sets={trophySets} anchors={anchors} spanInStrip={within !== null} />
            {neighbours}
          </div>
        </div>
      </div>
    </>
  );
}

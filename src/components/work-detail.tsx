import Link from "next/link";
import type { ReactNode } from "react";
import type { ContentDocument, Movie, Rating } from "../../contracts/content.ts";
import { imagePreviewSrc } from "../lib/content/image-preview.ts";
import { rangeLabel, ratingLabel } from "../lib/format.ts";
import { knownStatusLabel, libraryHref, movieRatingFact, ratingDots, workFactText, workSentence, type LibraryItem } from "../lib/library.ts";
import { movieRecord } from "../lib/movie-record.ts";
import { Cover } from "./library-grid";
import { RichDocumentBody } from "./rich-document";

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
 * write-up a column of what the owner made of it. The Notion template is read into its parts (movie-record.ts).
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


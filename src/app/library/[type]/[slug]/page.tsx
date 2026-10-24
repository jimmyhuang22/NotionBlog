import Link from "next/link";
import { preload } from "react-dom";
import { imagePreviewSrc } from "@/lib/content/image-preview";
import { cache, Suspense } from "react";
import type { Metadata } from "next";
import { contentMetadata } from "@/lib/seo/metadata";
import { notFound } from "next/navigation";
import type { LibraryKind, Page, Rating } from "../../../../../contracts/content.ts";
import { RichDocumentBody } from "@/components/rich-document";
import { Cover } from "@/components/library-grid";
import { PlatformChips } from "@/components/platform-chips";
import { contentRepository } from "@/lib/content";
import { dateParts, rangeLabel, ratingLabel } from "@/lib/format";
import { librarySections, progressWidth, ratingDots, workSentence, workFactText, movieRatingFact, itemDate, type LibraryItem, cardTimeLabel, platformChips, type PlatformChip } from "@/lib/library";
import { getSiteConfig } from "@/lib/site";
import { gameDateRows } from "@/lib/game-dates";
import { isEnabledContentKind } from "../../../../../config/features.ts";
import { alwaysFresh } from "@/lib/page-freshness";

// Kept for a day at most and dropped when the published content changes; see src/lib/page-freshness.ts.
export const revalidate = 86399;

type Props = { params: Promise<{ type: string; slug: string }> };

/** The page's title and the page itself read the same work; within one request it is read once. */
const read = cache(async (type: string, slug: string) => {
  const section = librarySections[type];
  if (!section || !isEnabledContentKind(section.kind)) return null;
  const detail = await contentRepository.get(section.kind, slug);
  return detail ? { type, section, item: detail.item as LibraryItem, document: detail.document } : null;
});

async function load({ params }: Props) {
  const { type, slug } = await params;
  return read(type, slug);
}

export async function generateMetadata(props: Props): Promise<Metadata> {
  try {
    const item = (await load(props))?.item ?? null;
    return { ...contentMetadata(item), title: item?.title ?? "作品" };
  } catch {
    return { ...contentMetadata(null), title: "作品" };
  }
}

interface Facts {
  /** The one sentence under the title: when, and what the owner did ("2024 年 7 月 13 日看过"). */
  said: string;
  rating: Rating | null;
  /** Percentage read or played, when the source records one. */
  progress: number | null;
  rest: [string, string][];
  /** A game's platforms, shown as boxes beside its status rather than as a row of the table. */
  platforms: PlatformChip[];
}

/**
 * The sentence and the owner's rating lead; a missing rating says so instead of showing zero. Everything
 * else follows as one quiet line of label and value pairs (H-04, the owner's pick of 2026-10-20).
 */
function facts(item: LibraryItem, timeZone: string): Facts {
  const date = (label: string, value: Parameters<typeof rangeLabel>[0]): [string, string] => [label, rangeLabel(value, timeZone) ?? "日期未记录"];
  const optional = (label: string, value: string | null | undefined): [string, string][] => (value ? [[label, value]] : []);
  if (item.kind === "movie") {
    const publicRating = movieRatingFact(item);
    return { said: workSentence(item, rangeLabel(item.watchedDate, timeZone)), rating: item.rating, progress: null, platforms: [], rest: [
      ...optional("类型", item.mediaType), ...optional("导演", item.director), ...optional("主演", item.actors.join("、")),
      ...optional("上映", rangeLabel(item.releaseDate, timeZone)), ...(publicRating ? [publicRating] : []),
    ] };
  }
  if (item.kind === "book") {
    const pages = item.pagesRead !== null && item.totalPages !== null ? `${item.pagesRead} / ${item.totalPages} 页` : item.totalPages !== null ? `${item.totalPages} 页` : null;
    return { said: workSentence(item, rangeLabel(item.readingDate, timeZone)), rating: item.personalRating, progress: item.progressPercent, platforms: [], rest: [
      ...optional("作者", item.authors.join("、")), ...optional("页数", pages), ...optional("豆瓣评分", item.doubanRating === null ? null : String(item.doubanRating)),
    ] };
  }
  // Platforms as boxes in the leading line, the same as on the card; times written as the card writes them, none at all left out (the owner's choice, 2026-10-17).
  return { said: workSentence(item, undefined), rating: item.rating, progress: item.progressPercent, platforms: platformChips(item.platforms), rest: [
    ...gameDateRows(item, timeZone).map(([label, value]) => date(label, value)),
    ...optional("已玩时长", cardTimeLabel(item.playedTime)), ...optional("预计时长", cardTimeLabel(item.estimatedTime)),
    ...optional("发售", rangeLabel(item.releaseDate, timeZone)),
  ] };
}

/** What stands out about a work after the sentence: platforms, the rating as ink dots, and progress as a line of ink. */
function Lead({ rating, progress, platforms }: Facts) {
  const dots = ratingDots(rating);
  const width = progressWidth(progress);
  return (
    <dl className="work__lead">
      {platforms.length ? <div><dt className="visually-hidden">平台</dt><dd className="work__platforms"><PlatformChips chips={platforms} /></dd></div> : null}
      <div>
        <dt className="visually-hidden">我的评分</dt>
        <dd className="work__rating">
          {dots ? <span className="work__dots" aria-hidden="true">{Array.from({ length: dots.total }, (_, index) => <i key={index} className={index < dots.filled ? "is-on" : undefined} />)}</span> : null}
          {ratingLabel(rating, "未评分")}
        </dd>
      </div>
      {progress !== null ? (
        <div className="work__progress">
          <dt>进度</dt>
          <dd>{width ? <span className="work__bar" aria-hidden="true" style={{ "--progress": width } as React.CSSProperties} /> : null}{progress}%</dd>
        </div>
      ) : null}
    </dl>
  );
}

const neighbourWords: Record<LibraryItem["kind"], string> = { movie: "看过", book: "读过", game: "玩过" };
const recordWords: Record<LibraryItem["kind"], string> = { movie: "观后感", book: "读后感", game: "游玩记录" };

/**
 * The page's floor (W-02): the works on either side of this one in the list's own order, newest first.
 * Read within this work's year (the list's year filter), which a page of fifty almost always covers, and
 * across into the next year at its edges. Streamed after the page so it never holds up the record itself.
 */
async function Neighbours({ item, timeZone }: { item: LibraryItem; timeZone: string }) {
  try {
    const date = itemDate(item);
    const parts = date ? dateParts(date.start, date.precision, timeZone) : null;
    const year = parts ? parts.year : "undated" as const;
    const seen: LibraryItem[] = [];
    let cursor: string | null = null;
    for (let read = 0; read < 3; read++) {
      const page = await contentRepository.list(item.kind, { limit: 50, year, ...(cursor ? { cursor } : {}) }) as Page<LibraryItem>;
      seen.push(...page.items);
      const at = seen.findIndex(entry => entry.id === item.id);
      if (!page.hasMore || !page.nextCursor || (at >= 0 && at < seen.length - 1)) break;
      cursor = page.nextCursor;
    }
    const at = seen.findIndex(entry => entry.id === item.id);
    let newer = at > 0 ? seen[at - 1]! : null;
    let older = at >= 0 ? seen[at + 1] ?? null : null;
    // At a year's edge the neighbour is the nearest work of the next year either side (W-05, 2026-10-20), so a work
    // alone in its year still ends on the works around it. Undated works come after every dated year.
    if (at >= 0 && (!newer || !older)) {
      const years = await contentRepository.getLibraryYears(item.kind as LibraryKind, {});
      const groups: (number | "undated")[] = [...years.years].filter(entry => entry.count > 0).map(entry => entry.year).sort((a, b) => b - a);
      if (years.undatedCount > 0) groups.push("undated");
      const here = groups.indexOf(year);
      const nearest = async (step: -1 | 1) => {
        for (let index = here + step; index >= 0 && index < groups.length; index += step) {
          const page = await contentRepository.list(item.kind, { limit: 1, year: groups[index]!, ...(step < 0 ? { order: "date-asc" as const } : {}) }) as Page<LibraryItem>;
          if (page.items[0]) return page.items[0];
        }
        return null;
      };
      if (here >= 0) [newer, older] = await Promise.all([newer ?? nearest(-1), older ?? nearest(1)]);
    }
    if (!newer && !older) return null;
    const word = neighbourWords[item.kind];
    const card = (entry: LibraryItem, label: string, className: string) => (
      <Link prefetch={false} className={className} href={entry.href}><span>{label}</span><span>{entry.title}</span><small className="study-link-context">{rangeLabel(itemDate(entry), timeZone) ?? "日期未记录"}</small></Link>
    );
    return (
      <nav className="pager work__neighbours" aria-label={`前后${word}的`}>
        {newer ? card(newer, `较新${word}`, "pager__prev") : null}
        {older ? card(older, `较早${word}`, "pager__next") : null}
      </nav>
    );
  } catch {
    return <p className="work__neighbours-failed">前后的条目暂时取不到。</p>;
  }
}

export default async function LibraryDetailPage(props: Props) {
  // Rendered per request (public cache review, 2026-10-21): its data still comes from the shared cache, but a
  // notice about a failed read must never be kept as the page.
  await alwaysFresh();
  const loaded = await load(props);
  if (!loaded) notFound();
  const { type, section, item, document } = loaded;
  const original = item.kind === "movie" ? item.originalTitle : null;
  const external = item.kind === "book" ? item.externalUrl : null;
  const summary = facts(item, getSiteConfig().timeZone);
  // The large cover's address is known here: ask for it with the page, not after it.
  if (item.cover) preload(imagePreviewSrc(item.cover, 800), { as: "image" });
  return (
    <div className="wrap">
      <nav className="crumbs" aria-label="面包屑">
        <Link href={`/library/${type}`}>{section.label}</Link><span aria-hidden="true">›</span><span aria-current="page">{item.title}</span>
      </nav>
      <div className={`work work--${item.kind}`}>
        <div className="work__cover"><Cover image={item.cover} title={item.title} previewWidth={800} /></div>
        <div className="work__info">
          <h1>{item.title}</h1>
          {original && original !== item.title ? <p className="work__original">{original}</p> : null}
          {item.tags.length ? <p className="reading__tags">{item.tags.map(tag => <span key={tag} className="tag">{tag}</span>)}</p> : null}
          <p className="work__said">{summary.said}</p>
          <Lead {...summary} />
          {summary.rest.length ? <p className="work__line">{summary.rest.map(([label, value]) => <span key={label}>{workFactText(label, value, item.kind)}</span>)}</p> : null}
          {external ? <p><a className="rt-link" href={external} target="_blank" rel="noopener noreferrer">查看外部条目</a></p> : null}
        </div>
      </div>
      {/* Many works are a record without a write-up: no body means no empty reading card. */}
      {document && (document.blocks.length > 0 || document.completeness === "partial")
        ? <article className="reading__article card" aria-label="我的记录"><RichDocumentBody document={document} imagePreviewWidth={800} /></article>
        // Where a write-up would be, a quiet slip says there is none yet (W-05, 2026-10-20); a wish has nothing to write.
        : item.status === "wishlist" ? null : <p className="work__record-empty">还没有写下{recordWords[item.kind]}。</p>}
      <Suspense fallback={<div className="work__neighbours-pending" aria-hidden="true" />}>
        <Neighbours item={item} timeZone={getSiteConfig().timeZone} />
      </Suspense>
    </div>
  );
}

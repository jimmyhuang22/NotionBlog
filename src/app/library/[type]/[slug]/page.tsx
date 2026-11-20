import Link from "next/link";
import { preload } from "react-dom";
import { imagePreviewSrc } from "@/lib/content/image-preview";
import { cache, Suspense } from "react";
import type { Metadata } from "next";
import { contentMetadata } from "@/lib/seo/metadata";
import { notFound } from "next/navigation";
import type { LibraryKind, Page } from "../../../../../contracts/content.ts";
import { Cover } from "@/components/library-grid";
import { contentRepository } from "@/lib/content";
import { dateParts, rangeLabel } from "@/lib/format";
import { librarySections, itemDate, type LibraryItem } from "@/lib/library";
import { BookPage, FilmPage, GamePage } from "@/components/work-detail";
import { getSiteConfig } from "@/lib/site";
import { isEnabledContentKind } from "../../../../../config/features.ts";
import { alwaysFresh } from "@/lib/page-freshness";
import { trophySetsOf } from "@/lib/game-trophies";

type Props = { params: Promise<{ type: string; slug: string }> };

/** The page's title and the page itself read the same work; within one request it is read once. */
const read = cache(async (type: string, slug: string) => {
  const section = librarySections[type];
  if (!section || !isEnabledContentKind(section.kind)) return null;
  const detail = await contentRepository.get(section.kind, slug);
  return detail ? { type, section, item: detail.item as LibraryItem, document: detail.document, trophySets: trophySetsOf(detail) } : null;
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
    // "上一部 / 下一部", "上一本 / 下一本", "上一款 / 下一款" in the list's order, newest first, with a small cover
    // (2026-11-19); the date under the title says which way each goes.
    const measure = item.kind === "movie" ? "部" : item.kind === "book" ? "本" : "款";
    const card = (entry: LibraryItem, label: string, className: string) => (
      <Link prefetch={false} className={className} href={entry.href}>
        <span>{label}</span><span>{entry.title}</span><small className="study-link-context">{rangeLabel(itemDate(entry), timeZone) ?? "日期未记录"}</small>
        <span className="work__neighbour-poster" aria-hidden="true"><Cover image={entry.cover} title={entry.title} previewWidth={400} /></span>
      </Link>
    );
    return (
      <nav className={`pager work__neighbours work__neighbours--posters${item.kind === "game" ? " work__neighbours--wide" : ""}`} aria-label={`上一${measure}和下一${measure}`}>
        {newer ? card(newer, `上一${measure}`, "pager__prev") : null}
        {older ? card(older, `下一${measure}`, "pager__next") : null}
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
  const { type, section, item, document, trophySets } = loaded;
  const timeZone = getSiteConfig().timeZone;
  // The large cover's address is known here: ask for it with the page, not after it. A game's art runs the width of the page.
  if (item.cover) preload(imagePreviewSrc(item.cover, item.kind === "game" ? 1600 : 800), { as: "image" });
  const neighbours = (
    <Suspense fallback={<div className="work__neighbours-pending" aria-hidden="true" />}>
      <Neighbours item={item} timeZone={timeZone} />
    </Suspense>
  );
  if (item.kind === "movie") return <FilmPage type={type} label={section.label} item={item} document={document} timeZone={timeZone} neighbours={neighbours} />;
  if (item.kind === "book") return <BookPage type={type} label={section.label} item={item} document={document} timeZone={timeZone} neighbours={neighbours} />;
  return <GamePage type={type} label={section.label} item={item} document={document} timeZone={timeZone} neighbours={neighbours} trophySets={trophySets} />;
}

"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { ImageAsset, Page } from "../../contracts/content.ts";
import { imagePreviewSrc } from "../lib/content/image-preview.ts";
import { dateParts, rangeLabel } from "../lib/format.ts";
import { runsBy } from "../lib/runs.ts";
import { cardParts, coverBadge, gameCard, itemDate, knownStatusLabel, workSentence, type LibraryItem, type LibraryOrder } from "../lib/library.ts";
import { LinkPending } from "./link-pending";
import { ListTail } from "./list-tail";
import { PlatformChips } from "./platform-chips";
import { pagingMessage, usePagedList } from "./use-paged-list";
import { useFadeIn } from "./use-fade-in";
import { ARRIVING_ROWS, arrivalStyle, useFilterArrival } from "./use-filter-arrival";

export function Cover({ image, title, previewWidth }: { image: ImageAsset | null; title: string; previewWidth?: 400 | 800 }) {
  const [failed, setFailed] = useState(false);
  // A preview that cannot be read gives way to the original once.
  const [original, setOriginal] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const fade = useFadeIn();
  // Checked after the page is interactive, so a cover that is already there never shows the spine.
  useEffect(() => { if (fade.current && !fade.current.complete) setWaiting(true); }, [fade]);
  // A cover that is missing or cannot be read right now shows the title as a book spine, never a broken image.
  if (!image || failed) return <div className="cover cover--empty" aria-hidden="true"><span>{title}</span></div>;
  const src = previewWidth === undefined || original ? image.src : imagePreviewSrc(image, previewWidth);
  // A detail page's large cover stands on the list's small one, usually already in the browser, so a picture shows with the title and sharpens when the large one arrives.
  const under = previewWidth === 800 && !original ? imagePreviewSrc(image, 400) : null;
  // Media paths are re-authorised per request, so covers stay plain images without an optimiser cache.
  return (
    <div className="cover-slot">
      {/* While the cover is on its way the same spine stands in its place; the cover fades in over it. */}
      {waiting && !under ? <div className="cover cover--empty cover--waiting" aria-hidden="true"><span>{title}</span></div> : null}
      {under && under !== src ? <img className="cover" src={under} alt="" aria-hidden="true" decoding="async" /> : null}
      <img ref={fade} className="cover" src={src} alt={image.alt || `${title} 的封面`} loading={under ? "eager" : "lazy"} decoding="async" onLoad={() => setWaiting(false)} onError={() => (src === image.src ? setFailed(true) : setOriginal(true))} />
    </div>
  );
}

/**
 * A game card's line under its title (the owner's choice, 2026-10-17): its platforms as boxes in their
 * makers' colours, the time played, and the rating at the far right; on a narrow card the rating takes
 * a line of its own, kept on every card so a row stays level. Nothing unknown is written as missing.
 */
function GameLine({ card }: { card: ReturnType<typeof gameCard> }) {
  return (
    <span className="library__game">
      <span className="library__game-facts">
        <PlatformChips chips={card.platforms} />
        {card.time ? <span>{card.time}</span> : null}
      </span>
      <span className="library__game-rating">{card.rating ?? ""}</span>
    </span>
  );
}

interface Group { key: string; label: string | null; items: LibraryItem[] }

/** Dated items group by year in list order; undated ones follow under one stated heading. A list sorted by name, or already narrowed to one year, is one run. */
function groupByYear(items: LibraryItem[], timeZone: string, oneRun: boolean): Group[] {
  if (oneRun) return [{ key: "run", label: null, items }];
  const groups: Group[] = runsBy(items, item => {
    const date = itemDate(item);
    const parts = date ? dateParts(date.start, date.precision, timeZone) : null;
    return parts ? { key: String(parts.year), label: String(parts.year) } : { key: "unknown", label: "日期未记录" };
  });
  // A list with no dates at all (a wishlist) needs no heading.
  if (groups.length === 1 && groups[0]!.key === "unknown") groups[0]!.label = null;
  return groups;
}

/** The year a card already sits under: its group's heading, or the year the list is narrowed to. */
function headingYear(groupKey: string, year: string | null): string | null {
  return /^\d{4}$/u.test(groupKey) ? groupKey : year && /^\d{4}$/u.test(year) ? year : null;
}

/** "2025 年 1 月 30 日" under the 2025 heading is "1 月 30 日": a narrow cover has room for the sentence, not the year twice (X-09). */
function withinYear(label: string | null, year: string | null): string | null {
  return label && year && label.startsWith(`${year} 年 `) ? label.slice(`${year} 年 `.length) : label;
}

/**
 * A card's link. A page of 24 works does not fetch 24 pages ahead; once the reader shows intent the
 * link fetches what Next fetches ahead for a page built per request: the page's loading shape and its
 * title, which costs the server one read of that work but not its body. A press then lands on that
 * shape at once instead of waiting on the old list. Keyboard focus and a finger down count at once; a
 * pointer has to rest on the card briefly, so sweeping across a row does not read every work in it.
 */
/** Starts reading a detail page's large cover as soon as its card is pressed; the browser keeps it for the page. */
function warmCover(image: ImageAsset | null) {
  if (image) new Image().src = imagePreviewSrc(image, 800);
}

function WorkLink({ href, className, cover, style, children }: { href: string; className: string; cover: ImageAsset | null; style?: CSSProperties; children: ReactNode }) {
  const [intent, setIntent] = useState(false);
  const resting = useRef<ReturnType<typeof setTimeout> | null>(null);
  const show = () => setIntent(true);
  const rest = () => { if (!intent) resting.current = setTimeout(show, 120); };
  const leave = () => { if (resting.current) clearTimeout(resting.current); resting.current = null; };
  useEffect(() => leave, []);
  return <Link href={href} prefetch={intent ? null : false} className={className} style={style} onPointerEnter={rest} onPointerLeave={leave} onFocus={show} onTouchStart={show} onPointerDown={() => warmCover(cover)}>{children}</Link>;
}

export function LibraryGrid({ kind, status, year = null, order = null, unit, initial, pageSize, timeZone }: {
  kind: LibraryItem["kind"]; status: string | null;
  /** Year filter as sent to the list endpoint: "2026", "undated" or null for everything. */
  year?: string | null;
  order?: LibraryOrder | null; unit: string; initial: Page<LibraryItem>; pageSize: number; timeZone: string;
}) {
  const query: Record<string, string> = { limit: String(pageSize), ...(status ? { status } : {}), ...(year ? { year } : {}), ...(order ? { order } : {}) };
  const { items, restarted, total, appendedFrom, paged, ...paging } = usePagedList<LibraryItem>(`/api/content/${kind}`, query, initial);
  const appended = new Set(appendedFrom === null ? [] : items.slice(appendedFrom).map(item => item.id));
  // After a filter, the first rows come in one after another (motion.css); first visits draw at once.
  const arriving = useFilterArrival();
  const firstRows = new Map(items.slice(0, ARRIVING_ROWS).map((item, index) => [item.id, index]));
  if (!items.length) return <div className="state"><p>{year ? "这一年在这个分类下没有内容。" : "这个分类下还没有内容。"}</p></div>;
  return (
    <>
      {restarted ? <p className="notice" role="status" style={{ marginBottom: 20 }}>列表有更新，已从头重新加载。</p> : null}
      {groupByYear(items, timeZone, year !== null).map(group => (
        <section key={`${group.key}:${group.items[0]?.id}`} className="library__group">
          {group.label ? <h2 className="section-title">{group.label}</h2> : null}
          <div className={`library__grid library__grid--${kind}`}>
            {group.items.map(item => (
              <WorkLink key={item.id} href={item.href} cover={item.cover}
                className={appended.has(item.id) ? "library__item is-appended" : arriving && firstRows.has(item.id) ? "library__item is-arriving" : "library__item"}
                style={arriving && firstRows.has(item.id) ? arrivalStyle(firstRows.get(item.id)!) : undefined}>
                <span className="library__cover">
                  <Cover image={item.cover} title={item.title} previewWidth={400} />
                  {coverBadge(item) ? item.kind === "game"
                    /* Platinum is a gold dot in the cover's corner: the platform boxes keep the colour, the word is read out and shown on hover. */
                    ? <span className="library__badge library__badge--gold" title={coverBadge(item)!}><span className="visually-hidden">{coverBadge(item)}</span></span>
                    : <span className="library__badge">{coverBadge(item)}</span> : null}
                </span>
                <span className="library__title" title={kind === "book" ? undefined : item.title}>{item.title}</span>
                {item.kind === "game" ? <GameLine card={gameCard(item)} /> : (
                  /* One piece per fact, so the line wraps between facts and the dots between them never start or end a line. */
                  <span className="library__meta">{[...(status ? [] : [knownStatusLabel(item)]), ...cardParts(item)].filter(Boolean).map((part, index) => <span key={index}>{part}</span>)}</span>
                )}
                {/* On hover the facts give way to the page's own sentence, "1 月 30 日看过" (X-08, X-09); for the eye only. */}
                {item.kind === "game" ? null : <span className="library__said" aria-hidden="true">{workSentence(item, withinYear(rangeLabel(itemDate(item), timeZone), headingYear(group.key, year)))}</span>}
                <LinkPending />
              </WorkLink>
            ))}
          </div>
        </section>
      ))}
      {paged ? <ListTail className="library__more" paging={paging} label="加载更多" status={pagingMessage(paging.problem, items.length, unit, total)} /> : null}
    </>
  );
}

"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { ImageAsset, Page } from "../../contracts/content.ts";
import { imagePreviewSrc } from "../lib/content/image-preview.ts";
import { dateParts, rangeLabel, ratingLabel } from "../lib/format.ts";
import { runsBy } from "../lib/runs.ts";
import { cardParts, cardTimeLabel, coverBadge, gameCaseFace, gameYearFacts, itemDate, knownStatusLabel, platformChips, workSentence, type GamePlatformIcon, type LibraryItem, type LibraryOrder } from "../lib/library.ts";
import type { Game } from "../../contracts/content.ts";
import { LinkPending } from "./link-pending";
import { ListTail } from "./list-tail";
import { GameCase } from "./game-case";
import { GamePlatformIconMark } from "./game-tag";
import { pagingMessage, usePagedList } from "./use-paged-list";
import { useImageFailure } from "./use-image-failure";
import { useFadeIn } from "./use-fade-in";
import { ARRIVING_ROWS, arrivalStyle, useFilterArrival } from "./use-filter-arrival";

type CoverProps = { image: ImageAsset | null; title: string; previewWidth?: 400 | 800 };
export function Cover(props: CoverProps) {
  return <CoverPicture key={props.image?.src ?? "missing"} {...props} />;
}
function CoverPicture({ image, title, previewWidth }: CoverProps) {
  const [waiting, setWaiting] = useState(false);
  const fade = useFadeIn();
  const preview = image ? (previewWidth === undefined ? image.src : imagePreviewSrc(image, previewWidth)) : "";
  const { src, original, failed, retrying, lost } = useImageFailure(preview, image?.src ?? "", fade);
  useEffect(() => { if (fade.current && !fade.current.complete) setWaiting(true); }, [fade]);
  if (!image || failed) return <div className="cover cover--empty" aria-hidden="true"><span>{title}</span></div>;
  // Detail covers keep the smaller preview underneath while the larger one arrives.
  const under = previewWidth === 800 && !original ? imagePreviewSrc(image, 400) : null;
  return (
    <div className="cover-slot">
      {waiting && !under ? <div className="cover cover--empty cover--waiting" aria-hidden="true"><span>{title}</span></div> : null}
      {under && under !== preview ? <img className="cover" src={under} alt="" aria-hidden="true" decoding="async" /> : null}
      <img ref={fade} className="cover" src={src} alt={image.alt || `${title} 的封面`} loading={under ? "eager" : "lazy"} decoding="async" onLoad={() => { if (!retrying) setWaiting(false); }} onError={lost} />
    </div>
  );
}

/**
 * With a game's name: its rating, when it has one. The case itself shows the platform played longest, the status
 * and the time (the owner's pick 甲, 2026-11-23); the other platforms are not listed (owner, 2026-11-24).
 */
function CaseLine({ game }: { game: Game }) {
  return game.rating ? <span className="library__meta"><span>{ratingLabel(game.rating)}</span></span> : null;
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

/**
 * The years as rings on a line (乙, 2026-11-24): the year written large and outlined in a column that stays in view
 * while its games scroll by, filling from the bottom as the year is read; the line beside fills as far as the reader
 * has come. Measured from the page on scroll, nothing moving by itself.
 */
function useYearRings(line: { current: HTMLDivElement | null }) {
  useEffect(() => {
    const element = line.current;
    if (!element) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const anchor = window.innerHeight * 0.42;
      const box = element.getBoundingClientRect();
      element.style.setProperty("--progress", `${Math.max(0, Math.min(box.height, anchor - box.top))}px`);
      let now: Element | null = null;
      for (const year of element.querySelectorAll<HTMLElement>(".game-year")) {
        const part = year.getBoundingClientRect();
        const read = Math.max(0, Math.min(1, (anchor - part.top) / Math.max(1, part.height)));
        year.style.setProperty("--fill", read.toFixed(3));
        year.toggleAttribute("data-read", read >= 1);
        if (read > 0 && read < 1) now = year;
      }
      for (const year of element.querySelectorAll(".game-year")) year.toggleAttribute("data-now", year === now);
    };
    const soon = () => { if (!frame) frame = requestAnimationFrame(measure); };
    measure();
    window.addEventListener("scroll", soon, { passive: true });
    window.addEventListener("resize", soon);
    const grown = new ResizeObserver(soon);
    grown.observe(element);
    return () => { cancelAnimationFrame(frame); window.removeEventListener("scroll", soon); window.removeEventListener("resize", soon); grown.disconnect(); };
  }, [line]);
}

/**
 * Games as years on a line (乙, 2026-11-24): each year one part, its ring in the column on the left with the year's
 * count from the server, so a list still loading says the whole year; once all of a year's games are in, the hours
 * and the platforms are added under it. Its cases stand on the right as a wall (丙), each row growing a little so
 * both its edges line up. A year of one or two games lays them out with their facts instead of leaving its row
 * empty. A list in one run (a wishlist, or an address narrowed to one year) is one part under its own name. A
 * pointer on a case lifts it and brings its name up inside it, the rest of the wall untouched (丙).
 */
function GameWall({ groups, yearCounts, unit, oneFamily, run, itemClass, itemStyle }: {
  groups: Group[]; yearCounts?: Record<string, number>; unit: string;
  /** The list is one platform family already, so a year does not count its platforms. */
  oneFamily: boolean;
  /** The name and count of a list in one run, which has no years to write. */
  run: { label: string; count: number | null };
  itemClass: (item: LibraryItem) => string; itemStyle: (item: LibraryItem) => CSSProperties;
}) {
  const line = useRef<HTMLDivElement>(null);
  useYearRings(line);
  const card = (item: LibraryItem) => {
    if (item.kind !== "game") return null;
    const ratio = gameCaseFace(item).ratio;
    return (
      <WorkLink key={item.id} href={item.href} cover={item.cover} className={itemClass(item)} style={{ ...itemStyle(item), "--case-ratio": ratio } as CSSProperties}>
        <GameCase game={item} overlay={<span className="game-case__name" aria-hidden="true">{item.title}</span>} />
        <span className="library__name">
          <span className="library__title">{item.title}</span>
          <CaseLine game={item} />
        </span>
        <LinkPending />
      </WorkLink>
    );
  };
  const feature = (item: LibraryItem) => {
    if (item.kind !== "game") return null;
    const face = gameCaseFace(item);
    const time = cardTimeLabel(item.playedTime);
    return (
      <WorkLink key={item.id} href={item.href} cover={item.cover} className={`${itemClass(item)} game-feature`} style={{ ...itemStyle(item), "--case-ratio": face.ratio } as CSSProperties}>
        <GameCase game={item} />
        <span className="game-feature__text">
          {face.status ? <span className={item.status === "platinumed" ? "game-feature__badge game-feature__badge--platinum" : "game-feature__badge"}>{face.status}</span> : null}
          <span className="game-feature__title">{item.title}</span>
          <span className="game-feature__facts">
            {time ? <span>已玩 <b>{time}</b></span> : null}
            {item.platforms.length ? <span>{platformChips(item.platforms).map(chip => chip.label).join(" / ")}</span> : null}
            {item.rating ? <span>{ratingLabel(item.rating)}</span> : null}
          </span>
        </span>
        <LinkPending />
      </WorkLink>
    );
  };
  return (
    <div ref={line} className="game-line">
      <div className="game-line__spine" aria-hidden="true"><i /></div>
      {groups.map(group => {
        const label = group.label === null ? run.label : group.key === "unknown" ? "无日期" : group.label;
        const count = group.label === null ? run.count : yearCounts?.[group.key === "unknown" ? "undated" : group.key] ?? null;
        const games = group.items.filter((item): item is Game => item.kind === "game");
        const whole = count !== null && games.length >= count;
        const facts = whole ? gameYearFacts(games) : null;
        return (
          <section key={`${group.key}:${group.items[0]?.id}`} className="game-year">
            <div className="game-year__mark">
              <h2 className={/^\d{4}$/u.test(label) ? "game-year__num" : "game-year__num game-year__num--word"}>{label}</h2>
              <p className="game-year__facts">
                {count ? <b>{count} {unit}</b> : null}{facts?.hours ? <span>{"\u00a0· "}{facts.hours} 小时</span> : null}
              </p>
              {!oneFamily && facts?.platforms.length ? (
                <p className="game-year__platforms">
                  {facts.platforms.map(entry => <span key={entry.icon} title={gamePlatformName(entry.icon)}><GamePlatformIconMark icon={entry.icon} /><span className="visually-hidden">{gamePlatformName(entry.icon)}</span>{entry.count}</span>)}
                </p>
              ) : null}
            </div>
            {whole && games.length <= 2 ? <div className="game-year__few">{group.items.map(feature)}</div> : <div className="library__wall">{group.items.map(card)}</div>}
          </section>
        );
      })}
    </div>
  );
}

const gamePlatformName = (icon: GamePlatformIcon) => ({ switch: "Switch", playstation: "PlayStation", steam: "Steam", pc: "PC", "3ds": "3DS" })[icon];

export function LibraryGrid({ kind, status, platform = null, year = null, order = null, unit, initial, pageSize, timeZone, yearCounts, runLabel }: {
  kind: LibraryItem["kind"]; status: string | null;
  /** Games: one platform family ("switch", "playstation", "steam", "pc") or null for every platform. */
  platform?: string | null;
  /** Year filter as sent to the list endpoint: "2026", "undated" or null for everything. */
  year?: string | null;
  order?: LibraryOrder | null; unit: string; initial: Page<LibraryItem>; pageSize: number; timeZone: string;
  /** How many records each year holds under this status ("2026", "undated"), for the games' year labels. */
  yearCounts?: Record<string, number>;
  /** Games: the name of a list with no years to write (the status, as "想玩"). */
  runLabel?: string;
}) {
  const query: Record<string, string> = { limit: String(pageSize), ...(status ? { status } : {}), ...(platform ? { platform } : {}), ...(year ? { year } : {}), ...(order ? { order } : {}) };
  const { items, restarted, total, appendedFrom, paged, ...paging } = usePagedList<LibraryItem>(`/api/content/${kind}`, query, initial);
  const appended = new Set(appendedFrom === null ? [] : items.slice(appendedFrom).map(item => item.id));
  // After a filter, the first rows come in one after another (motion.css); first visits draw at once.
  const arriving = useFilterArrival();
  const firstRows = new Map(items.slice(0, ARRIVING_ROWS).map((item, index) => [item.id, index]));
  if (!items.length) return <div className="state"><p>{year === "undated" ? "这个分类下没有未记日期的内容。" : year ? "这一年在这个分类下没有内容。" : "这个分类下还没有内容。"}</p></div>;
  return (
    <>
      {restarted ? <p className="notice" role="status" style={{ marginBottom: 20 }}>列表有更新，已从头重新加载。</p> : null}
      {kind === "game" ? (
        <GameWall groups={groupByYear(items, timeZone, year !== null)} yearCounts={yearCounts} unit={unit} oneFamily={platform !== null}
          run={year ? { label: year === "undated" ? "无日期" : year, count: yearCounts?.[year] ?? total } : { label: runLabel ?? "全部", count: total }}
          itemClass={item => appended.has(item.id) ? "library__item is-appended" : arriving && firstRows.has(item.id) ? "library__item is-arriving" : "library__item"}
          itemStyle={item => (arriving && firstRows.has(item.id) ? arrivalStyle(firstRows.get(item.id)!) : {})} />
      ) : groupByYear(items, timeZone, year !== null).map(group => (
        <section key={`${group.key}:${group.items[0]?.id}`} className="library__group">
          {group.label ? <h2 className="section-title">{group.label}</h2> : null}
          <div className={`library__grid library__grid--${kind}`}>
            {group.items.map(item => (
              <WorkLink key={item.id} href={item.href} cover={item.cover}
                className={appended.has(item.id) ? "library__item is-appended" : arriving && firstRows.has(item.id) ? "library__item is-arriving" : "library__item"}
                style={arriving && firstRows.has(item.id) ? arrivalStyle(firstRows.get(item.id)!) : undefined}>
                <span className="library__cover">
                  <Cover image={item.cover} title={item.title} previewWidth={400} />
                  {coverBadge(item) ? <span className="library__badge">{coverBadge(item)}</span> : null}
                </span>
                <span className="library__title" title={kind === "book" ? undefined : item.title}>{item.title}</span>
                {item.kind === "game" ? null : (
                  <>
                    {/* One piece per fact, so the line wraps between facts and the dots between them never start or end a line. */}
                    <span className="library__meta">{[...(status ? [] : [knownStatusLabel(item)]), ...cardParts(item)].filter(Boolean).map((part, index) => <span key={index}>{part}</span>)}</span>
                    {/* On hover the facts give way to the page's own sentence, "1 月 30 日看过" (X-08, X-09); for the eye only. */}
                    <span className="library__said" aria-hidden="true">{workSentence(item, withinYear(rangeLabel(itemDate(item), timeZone), headingYear(group.key, year)))}</span>
                  </>
                )}
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

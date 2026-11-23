"use client";

import Link from "next/link";
import { useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent } from "react";
import type { Game } from "../../contracts/content.ts";
import { rangeLabel } from "../lib/format.ts";
import { cardTimeLabel, gameCaseFace } from "../lib/library.ts";
import { GameCase } from "./game-case";
import { GamePlatformIconMark } from "./game-tag";

/** How far each step from the centre sits back: its scale, and how much of the previous case it overlaps. */
const SCALES = [1, 0.84, 0.72, 0.62];
const SPREAD = [0.96, 0.62, 0.62];

/**
 * Where a case sits, in units of the centre case's height (the track's `--stage-h`), so the same numbers serve
 * the desktop and phone heights. Neighbours are placed by their own widths: a wide PlayStation case and a slim
 * Switch case both clear the centre. The list wraps, so there are cases on both sides of the first one.
 */
function placement(index: number, current: number, ratios: number[]) {
  const n = ratios.length;
  let offset = index - current;
  if (offset > n / 2) offset -= n;
  if (offset < -n / 2) offset += n;
  const away = Math.abs(offset), side = Math.sign(offset);
  if (away > 3) return { away, style: { opacity: 0, pointerEvents: "none", transform: `translateX(calc(-50% + ${side * 2} * var(--stage-h))) scale(0.4)` } as CSSProperties };
  let x = 0;
  for (let step = 1; step <= away; step++) {
    const before = ratios[(current + side * (step - 1) + n) % n]!, here = ratios[(current + side * step + n) % n]!;
    x += (before * SCALES[step - 1]! + here * SCALES[step]!) / 2 * SPREAD[step - 1]!;
  }
  return {
    away,
    style: {
      zIndex: 10 - away, opacity: away === 3 ? 0.4 : away === 2 ? 0.75 : 1,
      filter: away ? `saturate(${1 - away * 0.15}) brightness(${1 - away * 0.08})` : undefined,
      transform: `translateX(calc(-50% + ${(side * x).toFixed(4)} * var(--stage-h))) translateZ(${-away * 100}px) rotateY(${-side * (away ? 40 : 0)}deg) scale(${SCALES[away]})`,
    } as CSSProperties,
  };
}

/**
 * The games played most recently, as a turning row of their cases above the library (the owner's pick 甲,
 * 2026-11-23), on the page's own background. The centre case is the largest, its neighbours turn away with a
 * reflection under them; the line below names the centre game. Arrows, the cases beside it, the arrow keys and a
 * swipe turn the row; with reduced motion the cases move without animating. The centre case opens the game.
 */
export function RecentGames({ games, timeZone }: { games: Game[]; timeZone: string }) {
  const [current, setCurrent] = useState(0);
  const touch = useRef<number | null>(null);
  const n = games.length;
  const go = (index: number) => setCurrent((index + n) % n);
  const ratios = games.map(game => gameCaseFace(game).ratio);
  const game = games[current]!;
  const face = gameCaseFace(game);
  const time = cardTimeLabel(game.playedTime);
  const last = rangeLabel(game.lastPlayedDate ?? null, timeZone);
  const keys = (event: KeyboardEvent) => {
    if (event.key === "ArrowLeft") { event.preventDefault(); go(current - 1); }
    if (event.key === "ArrowRight") { event.preventDefault(); go(current + 1); }
  };
  return (
    <section className="recent-games" aria-roledescription="轮播" aria-label="最近在玩" onKeyDown={keys}>
      <h2 className="recent-games__head">最近在玩<small>{n} 款 · 按最近一次游玩</small></h2>
      <div className="recent-games__track"
        onTouchStart={event => { touch.current = event.touches[0]?.clientX ?? null; }}
        onTouchEnd={event => {
          const start = touch.current, end = event.changedTouches[0]?.clientX;
          touch.current = null;
          if (start !== null && end !== undefined && Math.abs(end - start) > 40) go(current + (end < start ? 1 : -1));
        }}>
        {games.map((item, index) => {
          const { away, style } = placement(index, current, ratios);
          const centre = index === current;
          // A case beside the centre turns the row; only the centre one opens its game.
          const turn = (event: MouseEvent) => { if (!centre) { event.preventDefault(); go(index); } };
          return (
            <Link key={item.id} href={item.href} prefetch={false} onClick={turn} className="recent-games__card"
              style={{ ...style, "--case-ratio": ratios[index] } as CSSProperties}
              tabIndex={centre ? 0 : -1} aria-hidden={away > 3 ? true : undefined} aria-label={centre ? item.title : `转到${item.title}`}>
              <GameCase game={item} large={away <= 1} />
            </Link>
          );
        })}
      </div>
      {n > 1 ? (
        <>
          <button type="button" className="recent-games__nav recent-games__nav--prev" aria-label="上一款" onClick={() => go(current - 1)}>‹</button>
          <button type="button" className="recent-games__nav recent-games__nav--next" aria-label="下一款" onClick={() => go(current + 1)}>›</button>
        </>
      ) : null}
      <div className="recent-games__info" aria-live="polite">
        <Link href={game.href} prefetch={false} className="recent-games__title">{game.title}</Link>
        <div className="recent-games__line">
          {face.platform ? (
            <span className="game-platform">
              {face.icon ? <GamePlatformIconMark icon={face.icon} /> : null}{face.platform.label}
              {face.others.length ? <span className="recent-games__others">（也在 {face.others.join("、")}）</span> : null}
            </span>
          ) : null}
          {time ? <span>已玩 {time}</span> : null}
          {last ? <span>最近 {last}</span> : null}
          {face.status ? <span className={`game-case__status${game.status === "platinumed" ? " game-case__status--platinum" : ""}`}>{face.status}</span> : null}
        </div>
      </div>
      {n > 1 ? (
        <div className="recent-games__dots" aria-hidden="true">
          {games.map((item, index) => <i key={item.id} data-current={index === current ? "true" : undefined} />)}
        </div>
      ) : null}
    </section>
  );
}

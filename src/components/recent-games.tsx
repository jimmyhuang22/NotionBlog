"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { Game } from "../../contracts/content.ts";
import { rangeLabel } from "../lib/format.ts";
import { gameCaseFace } from "../lib/library.ts";
import { GameCase } from "./game-case";

/**
 * The games played most recently, as one flat row of their cases (the owner's pick 丙, 2026-11-24): the latest a
 * little larger, each with its name and the day it was last played under it. It is the first part of the games
 * page's rail (乙, 2026-11-24), its name and count in the label column like each year below it. The row scrolls
 * sideways; where it runs on, its edge fades, and on a pointer device two arrows under its name page it.
 */
export function RecentGames({ games, timeZone, thisYear }: { games: Game[]; timeZone: string; thisYear: number }) {
  const track = useRef<HTMLDivElement>(null);
  const [edge, setEdge] = useState({ start: true, end: false });
  useEffect(() => {
    const element = track.current;
    if (!element) return;
    const measure = () => setEdge({ start: element.scrollLeft < 4, end: element.scrollLeft + element.clientWidth > element.scrollWidth - 4 });
    measure();
    element.addEventListener("scroll", measure, { passive: true });
    window.addEventListener("resize", measure);
    return () => { element.removeEventListener("scroll", measure); window.removeEventListener("resize", measure); };
  }, []);
  const page = (direction: number) => {
    const element = track.current;
    if (!element) return;
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    element.scrollBy({ left: direction * element.clientWidth * 0.8, behavior: still ? "auto" : "smooth" });
  };
  // This year's days without the year: "11 月 22 日".
  const day = (game: Game) => {
    const label = rangeLabel(game.lastPlayedDate ?? null, timeZone);
    return label?.startsWith(`${thisYear} 年 `) ? label.slice(`${thisYear} 年 `.length) : label;
  };
  return (
    <section className="game-year recent-games" aria-label="最近在玩">
      <div className="game-year__side">
        <h2 className="game-year__label"><b>最近在玩</b><small>{games.length} 款</small></h2>
        <div className="recent-games__arrows" hidden={edge.start && edge.end}>
          <button type="button" aria-label="往前" disabled={edge.start} onClick={() => page(-1)}>‹</button>
          <button type="button" aria-label="往后" disabled={edge.end} onClick={() => page(1)}>›</button>
        </div>
      </div>
      <div ref={track} className="recent-games__track" data-start={edge.start ? "" : undefined} data-end={edge.end ? "" : undefined}>
        {games.map((game, index) => {
          const last = day(game);
          return (
            <Link key={game.id} href={game.href} prefetch={false} className={index === 0 ? "recent-games__item recent-games__item--first" : "recent-games__item"}
              style={{ "--case-ratio": gameCaseFace(game).ratio } as CSSProperties}>
              <GameCase game={game} large />
              <span className="recent-games__title">{game.title}</span>
              {last ? <span className="recent-games__day">{index === 0 ? <b>最近 · </b> : null}{last}</span> : null}
            </Link>
          );
        })}
      </div>
    </section>
  );
}

/**
 * The row's place, held while it is read (and in the section's loading shape, section-waiting.tsx): its name and
 * its height, nothing drawn that could flash.
 */
export function RecentGamesWaiting() {
  return (
    <section className="game-year recent-games recent-games--waiting" aria-label="最近在玩" aria-busy="true">
      <div className="game-year__side"><h2 className="game-year__label"><b>最近在玩</b></h2></div>
      <div className="recent-games__track" />
    </section>
  );
}

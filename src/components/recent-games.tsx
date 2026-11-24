"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useLayoutEffect, useRef, useState, useTransition, type CSSProperties, type KeyboardEvent } from "react";
import type { Game } from "../../contracts/content.ts";
import { imagePreviewSrc } from "../lib/content/image-preview.ts";
import { coverTint } from "../lib/cover-tint.ts";
import { dateParts, rangeLabel, relativeDay } from "../lib/format.ts";
import { cardTimeLabel, gameCaseFace, gamePlatformIcon, platformChips } from "../lib/library.ts";
import { GameCase } from "./game-case";
import { GamePlatformIconMark } from "./game-tag";
import { useToday } from "./use-today";

const tints = new Map<string, string | null>();

/** The stage's ground: a deep colour read from the cover in the browser; null when the picture cannot be read. */
function readTint(src: string): Promise<string | null> {
  if (tints.has(src)) return Promise.resolve(tints.get(src)!);
  return new Promise(resolve => {
    const image = new Image();
    image.decoding = "async";
    image.onload = () => {
      let tint: string | null = null;
      try {
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 12;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        context?.drawImage(image, 0, 0, 12, 12);
        tint = context ? coverTint(context.getImageData(0, 0, 12, 12).data) : null;
      } catch { tint = null; }
      tints.set(src, tint);
      resolve(tint);
    };
    image.onerror = () => { tints.set(src, null); resolve(null); };
    image.src = src;
  });
}

const artOf = (game: Game) => {
  const art = game.boxArt ?? game.cover;
  return art ? imagePreviewSrc(art, 400) : null;
};

/**
 * The games played most recently as the page's stage (乙, 2026-11-24): one game large, its case, name and facts on
 * a ground blurred from its own cover and tinted by it, and the others as small cases under it. Choosing one (a
 * press, or ← → once the row has focus) brings its case up from where its small one stood while the words follow
 * and the ground cross-fades. A day within the last week is written by its name alone, "今天", "5 天前", the date on
 * hover and for screen readers (乙); the markup writes the date, and the device's day takes over. Motion stops when
 * the reader asks for less.
 */
export function RecentGames({ games, timeZone, thisYear }: { games: Game[]; timeZone: string; thisYear: number }) {
  const [chosen, setChosen] = useState(0);
  const [ground, setGround] = useState<{ layers: [string | null, string | null]; on: 0 | 1 }>({ layers: [artOf(games[0]!), null], on: 0 });
  const [tint, setTint] = useState<string | null>(null);
  const caseLink = useRef<HTMLAnchorElement>(null);
  const thumbs = useRef<(HTMLButtonElement | null)[]>([]);
  const from = useRef<DOMRect | null>(null);
  const words = useRef<HTMLDivElement>(null);
  const base = useId();
  const today = useToday(timeZone);
  const game = games[Math.min(chosen, games.length - 1)]!;

  const day = (item: Game) => {
    const label = rangeLabel(item.lastPlayedDate ?? null, timeZone);
    return label?.startsWith(`${thisYear} 年 `) ? label.slice(`${thisYear} 年 `.length) : label;
  };
  const named = (item: Game) => {
    const played = item.lastPlayedDate;
    if (!today || !played || (played.precision !== "date" && played.precision !== "datetime")) return null;
    const parts = dateParts(played.start, played.precision, timeZone);
    return parts ? relativeDay(parts, today) : null;
  };

  // The page takes the stage's colour too, for whatever around the stage draws with it.
  const stage = useRef<HTMLElement>(null);
  useEffect(() => {
    const page = stage.current?.closest<HTMLElement>(".game-page");
    if (!page) return;
    if (tint) page.style.setProperty("--stage-tint", tint); else page.style.removeProperty("--stage-tint");
  }, [tint]);

  useEffect(() => {
    const src = artOf(game);
    let live = true;
    if (src) void readTint(src).then(value => { if (live) setTint(value); });
    else setTint(null);
    return () => { live = false; };
  }, [game]);

  // The chosen case rises from its small one; the words come in after it.
  useLayoutEffect(() => {
    const start = from.current;
    from.current = null;
    if (!start || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const box = caseLink.current?.querySelector<HTMLElement>(".game-case");
    if (box && box.offsetParent) {
      const end = box.getBoundingClientRect();
      box.animate([
        { transformOrigin: "0 0", transform: `translate(${start.left - end.left}px, ${start.top - end.top}px) scale(${start.width / end.width})`, opacity: 0.6 },
        { transformOrigin: "0 0", transform: "none", opacity: 1 },
      ], { duration: 520, easing: "cubic-bezier(.2, .8, .2, 1)" });
    }
    words.current?.animate([{ opacity: 0, transform: "translateY(10px)" }, { opacity: 1, transform: "none" }], { duration: 420, easing: "cubic-bezier(.2, .8, .2, 1)", delay: 40, fill: "backwards" });
  }, [chosen]);

  const choose = (index: number) => {
    if (index === chosen) return;
    from.current = thumbs.current[index]?.querySelector(".game-case")?.getBoundingClientRect() ?? null;
    setChosen(index);
    setGround(previous => {
      const on = previous.on === 0 ? 1 : 0;
      const layers: [string | null, string | null] = [...previous.layers];
      layers[on] = artOf(games[index]!);
      return { layers, on };
    });
  };
  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    const to = event.key === "Home" ? 0 : event.key === "End" ? games.length - 1 : step ? (chosen + step + games.length) % games.length : null;
    if (to === null) return;
    event.preventDefault();
    choose(to);
    thumbs.current[to]?.focus();
  };

  const name = named(game);
  const last = day(game);
  const time = cardTimeLabel(game.playedTime);
  const chips = platformChips(game.platforms);
  const icon = chips[0] ? gamePlatformIcon(chips[0].label) : null;
  const status = gameCaseFace(game).status;
  return (
    <section ref={stage} className="stage" aria-label="最近在玩" style={tint ? { "--tint": tint } as CSSProperties : undefined}>
      {ground.layers.map((src, index) => (
        <div key={index} className="stage__ground" data-on={ground.on === index ? "" : undefined} style={src ? { backgroundImage: `url("${src}")` } : undefined} aria-hidden="true" />
      ))}
      <Link ref={caseLink} href={game.href} prefetch={false} className="stage__case" style={{ "--case-ratio": gameCaseFace(game).ratio } as CSSProperties} tabIndex={-1} aria-hidden="true">
        <GameCase game={game} />
      </Link>
      <div className="stage__text">
        <p className="stage__eyebrow"><span className="stage__live" aria-hidden="true" />最近在玩</p>
        <div ref={words} id={`${base}-panel`} role="tabpanel" aria-labelledby={`${base}-tab-${chosen}`} className="stage__words">
          <h2 className="stage__title"><Link href={game.href} prefetch={false}>{game.title}</Link></h2>
          <ul className="stage__facts">
            {name && last ? <li title={last}><b>{name}</b><span className="visually-hidden"> · {last}</span></li> : last ? <li>{last}</li> : null}
            {time ? <li>已玩 <b>{time}</b></li> : null}
            {chips.length ? <li>{icon ? <GamePlatformIconMark icon={icon} /> : null}{chips.map(chip => chip.label).join(" / ")}</li> : null}
            {status ? <li>{status}</li> : null}
          </ul>
        </div>
        <div className="stage__rail" role="tablist" aria-label="最近在玩的游戏" onKeyDown={onKey}>
          {games.map((item, index) => (
            <button key={item.id} ref={node => { thumbs.current[index] = node; }} type="button" role="tab" id={`${base}-tab-${index}`} aria-controls={`${base}-panel`}
              aria-selected={index === chosen} tabIndex={index === chosen ? 0 : -1} aria-label={item.title} className="stage__thumb"
              style={{ "--case-ratio": gameCaseFace(item).ratio } as CSSProperties} onClick={() => choose(index)}>
              <GameCase game={item} />
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}

/**
 * The stage when the games could not be read (失败·新, 2026-11-24): a quiet box in its place says so and offers to
 * try again, which reads the page anew; the library below is untouched.
 */
export function RecentGamesFailed() {
  const router = useRouter();
  const [trying, start] = useTransition();
  return (
    <section className="stage stage--failed" aria-label="最近在玩">
      <div className="recent-games__failed" role="status">
        <p>最近在玩暂时没能显示，下面的游戏不受影响。</p>
        <button type="button" disabled={trying} onClick={() => start(() => router.refresh())}>{trying ? "正在重试" : "重试"}</button>
      </div>
    </section>
  );
}

/**
 * The stage's place, held while it is read (and in the section's loading shape, section-waiting.tsx): its ground
 * and its height, nothing drawn that could flash.
 */
export function RecentGamesWaiting() {
  return <section className="stage stage--waiting" aria-label="最近在玩" aria-busy="true" />;
}

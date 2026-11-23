"use client";

import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import type { Game, ImageAsset } from "../../contracts/content.ts";
import { imagePreviewSrc } from "../lib/content/image-preview.ts";
import { cardTimeLabel, gameCaseFace, type GameCaseFace } from "../lib/library.ts";
import { PlayStationBandMark, Switch2BandMark, SwitchTile } from "./game-case-marks";
import { GamePlatformIconMark } from "./game-tag";
import { useFadeIn } from "./use-fade-in";
import { useImageFailure } from "./use-image-failure";

/** One picture in the case, with the shared retry and fade; a lost picture tells its case to fall back. */
function CaseImage({ image, width, className, onLost }: { image: ImageAsset; width: 400 | 800; className?: string; onLost?: () => void }) {
  const fade = useFadeIn();
  const { src, failed, lost } = useImageFailure(imagePreviewSrc(image, width), image.src, fade);
  useEffect(() => { if (failed) onLost?.(); }, [failed, onLost]);
  if (failed) return null;
  return <img ref={fade} className={className} src={src} alt="" loading="lazy" decoding="async" onError={lost} />;
}

/**
 * No upright art yet: the wide cover fills the window, cropped around its middle (2026-11-23, after the first live
 * look: the whole wide cover in the middle of a blur read as a row of placeholders, the name written twice). The name
 * is under the case already; it is written inside only when there is no cover at all.
 */
function WideArt({ game, width }: { game: Game; width: 400 | 800 }) {
  const [lost, setLost] = useState(false);
  const cover = game.cover;
  return (
    <span className="game-case__art game-case__art--wide">
      {cover && !lost ? <CaseImage key={cover.src} image={cover} width={width} onLost={() => setLost(true)} />
        : <span className="game-case__wide-title">{game.title}</span>}
    </span>
  );
}
/**
 * Upright art fills its window and is cropped around the middle, unless the owner set the cover to keep its top or
 * its bottom (2026-11-24): a PlayStation window is wider than 2:3 art and loses about a tenth at each end, which is
 * where most covers print their title. Only the upright art follows it; the wide fallback stays centred.
 */
function Art({ game, width }: { game: Game; width: 400 | 800 }) {
  const [lost, setLost] = useState(false);
  const box = game.boxArt;
  if (!box || lost) return <WideArt game={game} width={width} />;
  const position = game.boxArtPosition === "top" || game.boxArtPosition === "bottom" ? game.boxArtPosition : undefined;
  return (
    <span className="game-case__art" data-position={position}>
      <CaseImage key={box.src} image={box} width={width} onLost={() => setLost(true)} />
    </span>
  );
}

/** What is printed at the top of the insert: the real case's band or corner tile, or the plain band with the platform's name. */
function CaseTop({ face, status }: { face: GameCaseFace; status: ReactNode }) {
  switch (face.look) {
    case "ps5": case "ps4": case "ps":
      return <span className="game-case__band game-case__band--printed"><PlayStationBandMark model={face.look === "ps" ? null : face.look} />{status}</span>;
    case "switch2":
      return <span className="game-case__band game-case__band--printed"><Switch2BandMark />{status}</span>;
    case "switch":
      // No band on a Switch case: the tile sits on the art, and the status takes the top right corner.
      return <><SwitchTile />{status ? <span className="game-case__corner">{status}</span> : null}</>;
    default:
      return (
        <span className="game-case__band">
          {face.icon ? <GamePlatformIconMark icon={face.icon} /> : null}
          <span className="game-case__platform">{face.platform?.label ?? ""}</span>
          {status}
        </span>
      );
  }
}

/**
 * A game as its case (the owner's pick 甲, 2026-11-23; printed like the real cases since 2026-11-24): the maker's
 * plastic shell in the real case's shape, open on the spine side, and what that case prints at the top: PS5's white
 * band, PS4's blue one, Switch 2's red band, Switch's red corner tile; Steam, PC and 3DS keep a plain band with the
 * platform's name. The status sits at the right end of the band (top right corner on Switch); the upright original
 * art below, the time played in its lower left corner. Decorative inside its link, which carries the title.
 */
export function GameCase({ game, large = false }: { game: Game; large?: boolean }) {
  const face = gameCaseFace(game);
  const time = cardTimeLabel(game.playedTime);
  const status = face.status ? <span className={`game-case__status${game.status === "platinumed" ? " game-case__status--platinum" : ""}`}>{face.status}</span> : null;
  return (
    <span className="game-case" data-tone={face.tone} data-look={face.look ?? undefined} style={{ "--case-ratio": face.ratio } as CSSProperties}>
      <span className="game-case__shell">
        <span className="game-case__insert">
          <CaseTop face={face} status={status} />
          <Art game={game} width={large ? 800 : 400} />
          {time ? <span className="game-case__time"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true" focusable="false"><circle cx="8" cy="8" r="6.2" /><path d="M8 4.6V8l2.3 1.5" /></svg>{time}</span> : null}
        </span>
      </span>
    </span>
  );
}

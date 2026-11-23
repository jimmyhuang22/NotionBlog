"use client";

import { useEffect, useState, type CSSProperties } from "react";
import type { Game, ImageAsset } from "../../contracts/content.ts";
import { imagePreviewSrc } from "../lib/content/image-preview.ts";
import { cardTimeLabel, gameCaseFace } from "../lib/library.ts";
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
function Art({ game, width }: { game: Game; width: 400 | 800 }) {
  const [lost, setLost] = useState(false);
  const box = game.boxArt;
  if (!box || lost) return <WideArt game={game} width={width} />;
  return (
    <span className="game-case__art">
      <CaseImage key={box.src} image={box} width={width} onLost={() => setLost(true)} />
    </span>
  );
}

/**
 * A game as its case (the owner's pick 甲, 2026-11-23): the maker's plastic shell in the real case's shape,
 * a band printed across the top of the insert with the one platform it is shown on and, at its right end, the
 * status; the upright original art below, the time played in its lower left corner. Without upright art the
 * wide cover sits whole in the window. Decorative inside its link, which carries the title.
 */
export function GameCase({ game, large = false }: { game: Game; large?: boolean }) {
  const face = gameCaseFace(game);
  const time = cardTimeLabel(game.playedTime);
  return (
    <span className="game-case" data-tone={face.tone} style={{ "--case-ratio": face.ratio } as CSSProperties}>
      <span className="game-case__shell">
        <span className="game-case__insert">
          <span className="game-case__band">
            {face.icon ? <GamePlatformIconMark icon={face.icon} /> : null}
            <span className="game-case__platform">{face.platform?.label ?? ""}</span>
            {face.status ? <span className={`game-case__status${game.status === "platinumed" ? " game-case__status--platinum" : ""}`}>{face.status}</span> : null}
          </span>
          <Art game={game} width={large ? 800 : 400} />
          {time ? <span className="game-case__time"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true" focusable="false"><circle cx="8" cy="8" r="6.2" /><path d="M8 4.6V8l2.3 1.5" /></svg>{time}</span> : null}
        </span>
      </span>
    </span>
  );
}

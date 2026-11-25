"use client";

import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import type { Game, ImageAsset } from "../../contracts/content.ts";
import { imagePreviewSrc } from "../lib/content/image-preview.ts";
import { cardTimeLabel, gameCaseFace, type GameCaseFace } from "../lib/library.ts";
import { PlayStationBandMark, Switch2BandMark, SwitchTile, ThreeDsBand } from "./game-case-marks";
import { GamePlatformIconMark } from "./game-tag";
import { useFadeIn } from "./use-fade-in";
import { useImageFailure } from "./use-image-failure";

/**
 * One picture in the case, with the shared retry and fade; a lost picture tells its case to fall back. With `backdrop`
 * the same address is drawn a second time behind it, enlarged and blurred (one download: the browser reuses it). With
 * `frame` the picture is shown through a window (a printed front's cover, or a whole square picture), over a blurred
 * copy of that same window enlarged to fill the case.
 */
function CaseImage({ image, width, className, backdrop = false, frame, onLost }: {
  image: ImageAsset; width: 400 | 800; className?: string; backdrop?: boolean; frame?: CSSProperties; onLost?: () => void;
}) {
  const fade = useFadeIn();
  const { src, failed, lost } = useImageFailure(imagePreviewSrc(image, width), image.src, fade);
  useEffect(() => { if (failed) onLost?.(); }, [failed, onLost]);
  if (failed) return null;
  const picture = <img ref={fade} className={className} src={src} alt="" loading="lazy" decoding="async" onError={lost} />;
  if (frame) {
    return (
      <>
        <span className="game-case__window game-case__window--ground" style={frame} aria-hidden="true"><img src={src} alt="" loading="lazy" decoding="async" /></span>
        <span className="game-case__window" style={frame}>{picture}</span>
      </>
    );
  }
  return backdrop ? <><img className="game-case__backdrop" src={src} alt="" aria-hidden="true" loading="lazy" decoding="async" />{picture}</> : picture;
}

/**
 * Where a framed picture's window sits in its image, as the CSS the window reads: a printed front's cover (retail) or
 * the whole picture (contain). Null when the image has no size, so the plain fit is used.
 */
function frameOf(box: ImageAsset, layout: Game["boxArtLayout"]): { style: CSSProperties; share: number } | null {
  if (!layout || !box.width || !box.height) return null;
  const [left, top, artWidth, artHeight] = layout.mode === "retail" ? layout.window : [0, 0, box.width, box.height];
  return {
    style: {
      "--frame-aspect": artWidth / artHeight,
      "--frame-width": `${box.width / artWidth * 100}%`,
      "--frame-left": `${-left / artWidth * 100}%`,
      "--frame-top": `${-top / artHeight * 100}%`,
    } as CSSProperties,
    share: artWidth / box.width,
  };
}

/**
 * No upright art yet: the whole wide cover in the middle of the window, the rest filled by the same picture enlarged
 * and blurred (the owner's pick 丙, 2026-11-24, as a stopgap while upright art is found). Cropping it to fill the window,
 * the 11-23 way, cut 45 to 65 per cent of its width, so most titles lost both ends. The name is under the case
 * already; it is written inside only when there is no cover at all.
 */
function WideArt({ game, width }: { game: Game; width: 400 | 800 }) {
  const [lost, setLost] = useState(false);
  const cover = game.cover;
  return (
    <span className="game-case__art game-case__art--wide">
      {cover && !lost ? <CaseImage key={cover.src} image={cover} width={width} backdrop onLost={() => setLost(true)} />
        : <span className="game-case__wide-title">{game.title}</span>}
    </span>
  );
}
/**
 * Upright art fills its window and is cropped around the middle, unless the owner set the cover to keep its top or
 * its bottom (2026-11-24): a PlayStation window is wider than 2:3 art and loses about a tenth at each end, which is
 * where most covers print their title. Only the upright art follows it; the wide fallback stays centred. A printed
 * front's cover and a near-square picture go through a window instead (2026-11-25): filled when the shapes are close,
 * whole over a blurred copy when they are not, and from the 800 preview when the window is a small part of the photo.
 */
function Art({ game, width }: { game: Game; width: 400 | 800 }) {
  const [lost, setLost] = useState(false);
  const box = game.boxArt;
  if (!box || lost) return <WideArt game={game} width={width} />;
  const layout = game.boxArtLayout;
  const frame = frameOf(box, layout);
  if (frame) {
    // A window that is a small part of a photographed case would be about 250 pixels wide in the 400 preview.
    const size = frame.share < 0.75 ? 800 : width;
    return (
      <span className="game-case__art game-case__art--framed" data-printed-switch-mark={(layout?.mode === "retail" && layout.printedSwitchMark) || undefined}>
        <CaseImage key={box.src} image={box} width={size} frame={frame.style} onLost={() => setLost(true)} />
      </span>
    );
  }
  const position = game.boxArtPosition === "top" || game.boxArtPosition === "bottom" ? game.boxArtPosition : undefined;
  return (
    <span className="game-case__art" data-position={layout ? undefined : position} data-fit={layout?.mode}>
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
    case "3ds":
      // The band runs down the right edge; the status takes the art's top right corner, as on Switch.
      return <><ThreeDsBand />{status ? <span className="game-case__corner">{status}</span> : null}</>;
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
 * band, PS4's blue one, Switch 2's red band, Switch's red corner tile, the Japanese 3DS case's band down its right edge
 * (2026-11-25); Steam and PC keep a plain band with the platform's name. The status sits at the right end of the band
 * (top right corner of the art on Switch and 3DS); the upright original
 * art below, the time played in its lower left corner. Decorative inside its link, which carries the title.
 */
export function GameCase({ game, overlay }: { game: Game; overlay?: ReactNode }) {
  const caseFace = gameCaseFace(game);
  const model = game.boxArtLayout?.playStationModel;
  const face = caseFace.look === "ps" && game.boxArt && model
    ? { ...caseFace, look: model === "PS4" ? "ps4" as const : "ps5" as const }
    : caseFace;
  const time = cardTimeLabel(game.playedTime);
  const status = face.status ? <span className={`game-case__status${game.status === "platinumed" ? " game-case__status--platinum" : ""}`}>{face.status}</span> : null;
  return (
    <span className="game-case" data-tone={face.tone} data-look={face.look ?? undefined} style={{ "--case-ratio": face.ratio } as CSSProperties}>
      <span className="game-case__shell">
        <span className="game-case__insert">
          <CaseTop face={face} status={status} />
          {/* The 400 preview everywhere: the recent row's cases are no taller than the wall's since the rail (2026-11-24). */}
          <Art game={game} width={400} />
          {time ? <span className="game-case__time"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true" focusable="false"><circle cx="8" cy="8" r="6.2" /><path d="M8 4.6V8l2.3 1.5" /></svg>{time}</span> : null}
          {/* Drawn over the window itself, edge to edge whatever the case's rims (the games wall's hover name). */}
          {overlay}
        </span>
      </span>
    </span>
  );
}

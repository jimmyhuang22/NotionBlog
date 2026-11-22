import { trophyPlatformIcon } from "../lib/game-trophies.ts";
import { GamePlatformIconMark } from "./game-tag";

/*
 * Small marks shared by a game's trophy summary (side column, server) and its trophy section (client), kept out of
 * the client file so the server page imports no client module for them.
 */

/** A platinum cup in its colour, beside a platinum set's name or the line of when it came. */
export function PlatinumCup({ className }: { className: string }) {
  return <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d="M7.5 4h9v3.5a4.5 4.5 0 0 1-9 0zM7.5 5.5H5a2.5 2.5 0 0 0 2.6 3.4M16.5 5.5H19a2.5 2.5 0 0 1-2.6 3.4M12 12v3.5M9 19.5h6M10 15.5h4v4h-4z" /></svg>;
}

/** A platform's name with its outline, as on the home timeline; a platform without one has its name alone. */
export function TrophyPlatform({ platform }: { platform: string }) {
  const icon = trophyPlatformIcon(platform);
  return <span className="trophy-platform">{icon ? <GamePlatformIconMark icon={icon} /> : null}<span className="trophy-platform__name">{platform}</span></span>;
}

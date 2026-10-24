import type { SocialMetric, SocialPlatform } from "../../contracts/social.ts";
import { socialIconPaths } from "./social-icon-paths";

/**
 * The marks the cards of works published elsewhere share: the platform's own mark, the signs the platforms
 * put beside their figures, and the words a screen reader hears for a way out to a platform. One place, so
 * a card on the home page, in a strip and on the works page draw them alike.
 */

// A word mark fills only a band of its square box; cropped to that band it reads at the same height as the glyphs.
const WORD_MARKS: ReadonlySet<SocialPlatform> = new Set(["xiaohongshu"]);

/**
 * A platform's mark, `size` high. A word mark is drawn half as wide again so it reads at the glyphs' height;
 * `square` keeps it inside a square box instead (the quiet place of a missing cover on the works page).
 */
export function PlatformMark({ platform, size = 16, square = false }: { platform: SocialPlatform; size?: number; square?: boolean }) {
  const word = WORD_MARKS.has(platform);
  return <svg aria-hidden="true" width={word && !square ? size * 1.5 : size} height={size} viewBox={word ? "0 6 24 12" : "0 0 24 24"} fill="currentColor"><path d={socialIconPaths[platform]} /></svg>;
}

const PLAY = "M4.5 2.6v10.8L13 8z";
/** A thumb on Bilibili, a heart on Xiaohongshu. */
const LIKE: Record<SocialPlatform, string> = {
  bilibili: "M5.2 7.1 7.7 2.2c1 0 1.8.8 1.8 1.8v2.3h2.9c.9 0 1.5.8 1.3 1.6l-.9 4.2c-.2.8-.8 1.3-1.6 1.3H5.2zm0 0H3.1c-.4 0-.7.3-.7.7v4.9c0 .4.3.7.7.7h2.1",
  xiaohongshu: "M8 13.4S2.2 10 2.2 5.9A3 3 0 0 1 8 4.7a3 3 0 0 1 5.8 1.2C13.8 10 8 13.4 8 13.4z",
};
const STACK = "M8 2.2 14 5.2 8 8.2 2 5.2z M2 8l6 3 6-3 M2 10.8l6 3 6-3";

/** The sign a platform puts beside a figure: a play mark for views, its own like mark for likes; none for the rest. */
export function figureSignPath(metric: SocialMetric, platform: SocialPlatform): string | null {
  return metric === "views" ? PLAY : metric === "likes" ? LIKE[platform] : null;
}

/** A solid play mark, for views on a cover. */
export function PlaySign({ size }: { size: number }) {
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 16 16" fill="currentColor"><path d={PLAY} /></svg>;
}

/** A platform's like mark in outline, for likes on a cover. */
export function LikeSign({ platform, size, stroke }: { platform: SocialPlatform; size: number; stroke: number }) {
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={stroke} strokeLinejoin="round"><path d={LIKE[platform]} /></svg>;
}

/** Stacked sheets, for the number of videos or parts in a collection. */
export function StackSign() {
  return <svg aria-hidden="true" width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round"><path d={STACK} /></svg>;
}

/** Said after a way out to a platform, for screen readers only. */
export function PlatformExitNote({ name }: { name: string }) {
  return <span className="visually-hidden">，在{name}打开，原平台可能要求登录</span>;
}

/**
 * A card that changes what it holds (a status entry opening or closing) eases from its old size to its new
 * one instead of jumping (2026-10-28, replacing the class-driven curtain of M-02). Only the size moves: the
 * words never fade and nothing is drawn as a curtain, and nothing moves on page load, only on a press.
 *
 * The height moves on the card's inner body, clipped there, so the card itself keeps everything it draws
 * outside its box (shadows, the island's speech-bubble tail); the card only moves its width, unclipped, when
 * a short entry widens to the column. Driven with the Web Animations API on the elements themselves, so no
 * CSS `animation` rule can override it (the home timeline's first-screen `arrive` once did), and no
 * `height: auto` transition is needed (Safari).
 */

export interface Size { width: number; height: number }
/** The part of an element this needs; a plain object in tests. */
export interface Sizable {
  getBoundingClientRect(): { width: number; height: number };
  animate(keyframes: Keyframe[], options: KeyframeAnimationOptions): Animation | { finish(): void };
}
type Running = { finish(): void };

export const OPEN_MS = 260;
export const CLOSE_MS = 220;
export const EASE = "cubic-bezier(0.2, 0, 0, 1)";

const moved = (a: number, b: number) => Math.abs(a - b) > 0.5;

/** The body's height frames, clipped so content taller than the moment's height never shows below the card. */
export function heightKeyframes(from: number, to: number): Keyframe[] | null {
  return moved(from, to) ? [{ height: `${from}px`, overflow: "clip" }, { height: `${to}px`, overflow: "clip" }] : null;
}
/** The card's width frames, unclipped: a short entry widens from its words to the column. */
export function widthKeyframes(from: number, to: number): Keyframe[] | null {
  return moved(from, to) ? [{ width: `${from}px` }, { width: `${to}px` }] : null;
}

/**
 * One card's motion: `capture` before the change (taking the sizes on screen, mid-motion included, then ending
 * any motion still running so they never queue), `play` after React has drawn the new content. A `play`
 * without a `capture` (a load that failed, a change that needs no motion) does nothing.
 */
export function createSizeMotion(reduced: () => boolean) {
  let from: { width: number; height: number; opening: boolean } | null = null;
  let running: Running[] = [];
  return {
    capture(card: Sizable | null, body: Sizable | null, opening: boolean) {
      if (!card || !body) return;
      const width = card.getBoundingClientRect().width, height = body.getBoundingClientRect().height;
      for (const motion of running) motion.finish();
      running = [];
      from = { width, height, opening };
    },
    play(card: Sizable | null, body: Sizable | null) {
      const start = from;
      from = null;
      if (!start || !card || !body || reduced()) return;
      const options = { duration: start.opening ? OPEN_MS : CLOSE_MS, easing: EASE };
      const height = heightKeyframes(start.height, body.getBoundingClientRect().height);
      const width = widthKeyframes(start.width, card.getBoundingClientRect().width);
      if (height) running.push(body.animate(height, options));
      if (width) running.push(card.animate(width, options));
    },
  };
}

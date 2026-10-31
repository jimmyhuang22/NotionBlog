/**
 * The scroll back to an entry's start, moved on the same timeline as the card's shrinking (F52, 2026-10-30).
 *
 * Closing a long status entry shrinks its body in 220 ms (size-motion.ts) and brings the reader back to where it
 * begins. A browser smooth scroll takes its own time for that (about a second for a few thousand pixels), so the
 * entries below shot up with the shrinking card and then came back down with the scroll. Here the page is set
 * every frame to "start + distance × the motion's progress", read from the motion itself, so both start in the
 * same frame, follow the same easing and end in the same frame: what is on screen moves one way only.
 */

/** The part of a running Web Animation this reads; a plain object in tests. */
export interface Timed {
  effect?: { getComputedTiming(): { progress?: number | null } } | null;
  playState?: string;
  finished?: Promise<unknown>;
}

export interface ScrollAlongDeps {
  scrollTo(top: number): void;
  frame(callback: () => void): number;
  cancelFrame(handle: number): void;
  now(): number;
}

export interface ScrollAlong {
  /** Settles once the page has reached its final place, or the scroll was stopped. */
  finished: Promise<void>;
  /** Leaves the page where it is now, as when the reader presses again mid-motion. */
  stop(): void;
}

const browser: ScrollAlongDeps = {
  // Instant on purpose: the page's own `scroll-behavior: smooth` would start a second, slower motion.
  scrollTo: top => window.scrollTo({ top, behavior: "instant" }),
  frame: callback => requestAnimationFrame(callback),
  cancelFrame: handle => cancelAnimationFrame(handle),
  now: () => performance.now(),
};

/**
 * Moves the page from `from` by `distance` in step with `motion`. Without a motion to follow the page is set at
 * once. `limitMs` ends it in case the motion never reports its end.
 */
export function scrollAlong(motion: Timed | undefined, from: number, distance: number, limitMs = 1000, deps: ScrollAlongDeps = browser): ScrollAlong {
  let done!: () => void;
  const finished = new Promise<void>(resolve => { done = resolve; });
  let handle: number | null = null, over = false;
  const end = (place: number | null) => {
    if (over) return;
    over = true;
    if (handle !== null) deps.cancelFrame(handle);
    handle = null;
    if (place !== null) deps.scrollTo(place);
    done();
  };
  const timing = motion?.effect;
  if (!motion || !timing) { end(from + distance); return { finished, stop: () => end(null) }; }
  const started = deps.now();
  const step = () => {
    handle = null;
    const progress = timing.getComputedTiming().progress;
    // A finished motion (no fill) reports no progress: the page goes to its final place in that frame.
    if (motion.playState === "finished" || motion.playState === "idle" || typeof progress !== "number" || deps.now() - started > limitMs) { end(from + distance); return; }
    deps.scrollTo(from + distance * progress);
    handle = deps.frame(step);
  };
  handle = deps.frame(step);
  void motion.finished?.then(() => end(from + distance), () => end(from + distance));
  return { finished, stop: () => end(null) };
}

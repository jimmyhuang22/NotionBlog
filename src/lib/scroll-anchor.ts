/**
 * Scroll anchoring off for the page, only while a card swaps what it holds (F51, 2026-10-29).
 *
 * When a status entry opens or closes with its top above the screen, the browser picks the 展开／收起 button
 * as its reference (it is the same element before and after, to keep focus) and scrolls the whole page so the
 * button stays put. The words the reader is on then jump by the change in height, up to thousands of pixels
 * for a long entry with pictures. Turning anchoring off on the page's own scroller (not on the card, which
 * would only move the reference to the entry below) leaves the page where it is; it comes back on when the
 * motion ends, so late pictures and "load more" keep the page steady as before.
 *
 * Holds nest: anchoring returns once every hold is released. Each release runs once.
 */

let holds = 0;

function scrollers(): HTMLElement[] {
  // The viewport scroller is the root element; the body is set too, as some engines read it there.
  return [document.documentElement, document.body].filter((element): element is HTMLElement => Boolean(element));
}

export function holdScrollAnchor(): () => void {
  if (typeof document === "undefined") return () => {};
  if (holds++ === 0) for (const element of scrollers()) element.style.setProperty("overflow-anchor", "none");
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--holds === 0) for (const element of scrollers()) element.style.removeProperty("overflow-anchor");
  };
}

/**
 * Releases once the given motions have ended and the frame after them is drawn, or after `fallbackMs` at the
 * latest. Two frames, not one: frame callbacks run before that frame's layout, so with nothing moving (reduced
 * motion) a release in the next frame would turn anchoring back on just before the new content is laid out,
 * and the page would jump after all (F52).
 */
export function releaseAfter(release: () => void, motions: readonly unknown[], fallbackMs = 1000): void {
  const finished = motions.map(motion => (motion as { finished?: Promise<unknown> }).finished).filter(Boolean) as Promise<unknown>[];
  const timer = setTimeout(release, fallbackMs);
  void Promise.allSettled(finished).then(() => requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(timer); release(); })));
}
